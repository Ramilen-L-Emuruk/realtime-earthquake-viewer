import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Prefectures } from './prefectures'
import { DATA_FETCH_TIMEOUT_MS } from './fetchJson'

// 生成データのローダは 8 本あり、いずれも「cache / inflight / 失敗時に inflight を捨てる」
// という同じ骨格を持つ。全部にテストを置くと同じ内容が 8 回並ぶため、区域データ固有の
// 検証を持つ subregions.ts に加えて、素の骨格そのものである本ファイルを代表として検証する
// （骨格が壊れれば、どちらかは必ず落ちる）。

async function freshModule() {
  vi.resetModules()
  return await import('./prefectures')
}

const SAMPLE: Prefectures = {
  石川県: { label: [36.6, 136.6], dir: 'up', rings: [[[36.5, 136.5], [36.7, 136.8], [36.6, 136.6]]] },
}

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

/** signal が abort されるまで解決しない fetch（応答が返らない回線の再現）。 */
function hangingFetch(init?: { signal?: AbortSignal }) {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// 各ケースは `vi.resetModules()` ＋動的 import でモジュール内キャッシュを白紙に戻すため、
// そのたびに Vite の変換とモジュールグラフの再評価が走る。所要時間はマシンの混み具合に左右され、
// 既定のタイムアウト（5 秒）を割ることがあるので、このファイル群だけ上限を上げる。
//
// 2026-08-18 の実測（テスト 8 連続実行＋dev サーバー稼働という混んだ状態）:
//   既定 5 秒: 本ファイルが 3/8、stationCoords が 1/8 で失敗。所要は 3,129〜5,023ms に散らばり、
//              5,000ms を超えた回だけ落ちていた（通った回も 4,473・4,634ms と閾値際）
//   15 秒:     8/8 成功。所要は 3,658〜5,832ms で分布は変わらず
// 「解決しない Promise で固まっている」なら上限を伸ばしても新しい上限で落ちるはずで、5,832ms で
// 完走している以上、上限が実測分布に対して低すぎただけと言える（アサーション失敗も出ていない）。
//
// 同じ操作をする他のテスト（stationCoords / subregions / tsunamiZones / fetchJson の「取得状況の集約」/
// ttsPhraseBreakDict）にも同じ上限を置いている。実測では本ファイルと stationCoords 以外は 2.5 秒未満に
// 収まっていたが、速い理由は構造ではなく実行順（コールドスタートのコストを最初のファイルが負う）で
// 説明できてしまうため、同じ操作をするものは揃えておく。
// プロジェクト全体の testTimeout（vitest.config.ts）は既定のままにして、性能劣化の検出網は緩めない。
describe('loadPrefectures', { timeout: 15_000 }, () => {
  it('取得に成功するとデータを返し、以降はキャッシュを使う（fetchは1回のみ）', async () => {
    const fetchMock = vi.fn(async () => okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadPrefectures, getPrefecturesCache } = await freshModule()

    expect(await loadPrefectures()).toEqual(SAMPLE)
    expect(await loadPrefectures()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getPrefecturesCache()).toEqual(SAMPLE)
  })

  it('HTTPエラーのときは例外になり、キャッシュは空のまま', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response))
    const { loadPrefectures, getPrefecturesCache } = await freshModule()

    await expect(loadPrefectures()).rejects.toThrow(/404/)
    expect(getPrefecturesCache()).toBeNull()
  })

  // 配信の破損で 200 が返る場合。成功として扱うと「県 0 件」で通ってしまい、陸地塗りも県境も
  // 県名ラベルも出ないのに BaseMapGL / LabelsGL の警告が出ない（rejected のときだけ警告するため）。
  it.each([
    ['空オブジェクト', {}],
    ['配列', []],
    ['null', null],
    ['文字列', 'なにか'],
  ])('200で%sが返っても失敗として扱う（配信破損を成功と誤認しない）', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(body)))
    const { loadPrefectures, getPrefecturesCache } = await freshModule()

    await expect(loadPrefectures()).rejects.toThrow(/no data/)
    expect(getPrefecturesCache()).toBeNull()
  })

  it('破損で失敗した後も、呼び直せば再取得できる（inflight を破棄している）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({}))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadPrefectures } = await freshModule()

    await expect(loadPrefectures()).rejects.toThrow(/no data/)
    expect(await loadPrefectures()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('応答が返らないときはタイムアウトで失敗確定し、次の要求で再取得できる', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => hangingFetch(init))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadPrefectures, getPrefecturesCache } = await freshModule()

    const assertion = expect(loadPrefectures()).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(DATA_FETCH_TIMEOUT_MS)
    await assertion
    expect(getPrefecturesCache()).toBeNull()

    expect(await loadPrefectures()).toEqual(SAMPLE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
