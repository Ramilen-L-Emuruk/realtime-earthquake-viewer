import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 記録の内容そのものを検証したいので log だけ差し替える（createLogThrottle は実物を使う）。
const warnMock = vi.fn()
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: warnMock, error: vi.fn() },
}))

// 逆行検出の基準（直近サンプル）と失敗ログのスロットルはモジュール変数のため、テスト間で状態を
// 持ち越さないよう毎回モジュールを作り直して読み込む。
async function loadModule() {
  vi.resetModules()
  warnMock.mockClear()
  return await import('./akamaiClock')
}

/** 見送りの番兵。モジュールを作り直しても値は同じ文字列なので直接比べられる。 */
const SERVER_TIME_SKIPPED = 'skipped'

/** 戻り値は「サンプル／見送り／失敗」の 3 状態。サンプルであることを確かめて取り出す。 */
function sampleOf(outcome: unknown): { serverEpochMs: number; rttMs: number; perfRefMs: number } {
  expect(outcome).not.toBeNull()
  expect(outcome).not.toBe(SERVER_TIME_SKIPPED)
  return outcome as { serverEpochMs: number; rttMs: number; perfRefMs: number }
}

/** `?iso&ms` の応答（ISO8601 の平文 1 行）を模す。 */
function textResponse(body: string): Response {
  return { ok: true, text: async () => body } as unknown as Response
}

const NOW_ISO = '2026-08-20T07:23:52.659Z'
const NOW_MS = Date.parse(NOW_ISO)

describe('fetchServerTime', () => {
  const originalFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('ISO8601 の応答からサーバー時刻・RTT・基準時点を返す', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse(NOW_ISO))

    const before = performance.now()
    const sample = await fetchServerTime()
    const after = performance.now()

    const got = sampleOf(sample)
    expect(got.serverEpochMs).toBe(NOW_MS)
    expect(got.rttMs).toBeGreaterThanOrEqual(0)
    // 基準時点は取得の実行区間に収まる。
    expect(got.perfRefMs).toBeGreaterThanOrEqual(before)
    expect(got.perfRefMs).toBeLessThanOrEqual(after)
  })

  it('ミリ秒付きの時刻をミリ秒まで保持する（秒に丸めない）', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse(NOW_ISO))

    const sample = await fetchServerTime()

    // .659 が落ちていれば較正の精度が秒単位まで劣化する。
    expect(sampleOf(sample).serverEpochMs % 1000).toBe(659)
  })

  it('前後の空白を含む応答も読める', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse(`  ${NOW_ISO}\n`))

    expect(sampleOf(await fetchServerTime()).serverEpochMs).toBe(NOW_MS)
  })

  it('ミリ秒とキャッシュ無効を指定して取得する', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse(NOW_ISO))

    await fetchServerTime()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // `?ms` が落ちると応答が秒単位になり、静かに精度だけが下がる。
    expect(url).toBe('https://time.akamai.com/?iso&ms')
    expect(init.cache).toBe('no-store')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('基準時点は応答到着時（本文の読み出しより前）を指す', async () => {
    const { fetchServerTime } = await loadModule()
    let perfAtRead = 0
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => {
        // 本文の読み出しに時間がかかる状況を模す。基準時点はこれより前で確定していること。
        const end = performance.now() + 30
        while (performance.now() < end) { /* busy */ }
        perfAtRead = performance.now()
        return NOW_ISO
      },
    } as unknown as Response)

    const sample = await fetchServerTime()

    const got = sampleOf(sample)
    expect(got.perfRefMs).toBeLessThan(perfAtRead)
    expect(got.rttMs).toBeLessThan(30)
  })

  it('時刻として読めない応答は棄却し、理由を記録する', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse('<html>error</html>'))

    expect(await fetchServerTime()).toBeNull()
    expect(String(warnMock.mock.calls[0][0])).toContain('parse-invalid')
  })

  it('妥当範囲の下限を下回る応答は棄却する', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse('1970-01-01T00:00:00.000Z'))

    expect(await fetchServerTime()).toBeNull()
    expect(String(warnMock.mock.calls[0][0])).toContain('out-of-range')
  })

  it('妥当範囲の上限を超える応答も棄却する', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse('2200-01-01T00:00:00.000Z'))

    expect(await fetchServerTime()).toBeNull()
    expect(String(warnMock.mock.calls[0][0])).toContain('out-of-range')
  })

  it('HTTP エラー応答は棄却し、理由を記録する', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response)

    expect(await fetchServerTime()).toBeNull()
    expect(String(warnMock.mock.calls[0][0])).toContain('http-error')
  })

  it('通信例外は null を返す（例外は投げない）', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(fetchServerTime()).resolves.toBeNull()
    expect(String(warnMock.mock.calls[0][0])).toContain('network')
  })

  // このエンドポイントには NICT の `it` のようなエコーが無く、古い応答を掴んでも気づけない。
  // 代わりに「単調時計で見て前回より戻っていないこと」で中間装置のキャッシュを検出する。
  it('前回より大きく戻った時刻は棄却する（古い応答を掴んだ疑い）', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse(NOW_ISO))
    expect(await fetchServerTime()).not.toBeNull()

    // 10 秒前の時刻が返る（許容幅 2 秒を大きく超える）。
    fetchMock.mockResolvedValue(textResponse(new Date(NOW_MS - 10_000).toISOString()))

    expect(await fetchServerTime()).toBeNull()
    expect(String(warnMock.mock.calls[0][0])).toContain('went-backwards')
  })

  it('わずかな揺れは棄却しない（許容幅の内側）', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse(NOW_ISO))
    expect(await fetchServerTime()).not.toBeNull()

    // 0.5 秒戻り。ネットワークのジッタで起こり得る範囲なので通す。
    fetchMock.mockResolvedValue(textResponse(new Date(NOW_MS - 500).toISOString()))

    expect(await fetchServerTime()).not.toBeNull()
    expect(warnMock).not.toHaveBeenCalled()
  })

  // Date.parse はオフセットが無い ISO8601 をローカル時刻として解釈するため、`Z` が落ちると
  // 端末のタイムゾーン次第で数時間ずれた値が「妥当範囲内」として通ってしまう。
  it('タイムゾーンが欠けた応答は棄却する', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse('2026-08-20T07:23:52.659'))

    expect(await fetchServerTime()).toBeNull()
    expect(String(warnMock.mock.calls[0][0])).toContain('imprecise-format')
  })

  // `?ms` が無視されるようになるとリクエストは正しいまま応答だけ秒単位に丸まり、精度だけが静かに落ちる。
  it('小数秒が欠けた応答は棄却する（精度の静かな劣化を検知する）', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse('2026-08-20T07:23:52Z'))

    expect(await fetchServerTime()).toBeNull()
    expect(String(warnMock.mock.calls[0][0])).toContain('imprecise-format')
  })

  it('タイムゾーンオフセット形式の応答は受理する', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse('2026-08-20T16:23:52.659+09:00'))

    expect(sampleOf(await fetchServerTime()).serverEpochMs).toBe(Date.parse('2026-08-20T16:23:52.659+09:00'))
  })

  // lastAccepted はモジュール単位で持つため、取得が重なると応答の到着順が入れ替わり、正当な応答を
  // went-backwards と誤判定しうる。重なりは後から来た方を見送って避ける。
  it('取得が重なったら後から来た方を見送る', async () => {
    const { fetchServerTime } = await loadModule()
    let release: (() => void) | null = null
    fetchMock.mockImplementation(async () => {
      await new Promise<void>((r) => { release = r })
      return textResponse(NOW_ISO)
    })

    const first = fetchServerTime()
    // 1 本目が進行中のまま 2 本目を投げる。
    const second = await fetchServerTime()

    // **null（失敗）ではなく見送りを返すこと。** 混ぜると呼び出し側が「サービスが落ちた」と
    // 誤認してフォールバック経路へ落ちる。
    expect(second).toBe(SERVER_TIME_SKIPPED)
    // 見送りは正常な動作なので記録しない（毎周期出ると本物の失敗が埋もれる）。
    expect(warnMock).not.toHaveBeenCalled()
    // fetch は 1 回しか呼ばれない（重なった側は通信すらしない）。
    expect(fetchMock).toHaveBeenCalledTimes(1)

    release!()
    expect(await first).not.toBeNull()
  })

  it('失敗の記録はスロットルされ、毎周期同じ行を出さない', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await fetchServerTime()
    await fetchServerTime()
    await fetchServerTime()

    expect(warnMock).toHaveBeenCalledTimes(1)
  })

  // 1 個のスロットルを共有すると、最初に鳴った理由が残りを 5 分間隠して原因を取り違える。
  it('理由ごとに独立して記録する（先に鳴った理由が他を隠さない）', async () => {
    const { fetchServerTime } = await loadModule()

    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await fetchServerTime()
    expect(warnMock.mock.calls.filter(([m]) => String(m).includes('network'))).toHaveLength(1)

    // 間隔（5 分）の内側で別の理由に転じる。共有していれば隠れる。
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(textResponse('2026-08-20T07:23:52Z'))
    await fetchServerTime()

    expect(warnMock.mock.calls.filter(([m]) => String(m).includes('imprecise-format'))).toHaveLength(1)
    // 同じ理由は間引かれたまま（スロットル自体は効いている）。
    expect(warnMock.mock.calls.filter(([m]) => String(m).includes('network'))).toHaveLength(1)
  })

  it('成功した回は記録を残さない', async () => {
    const { fetchServerTime } = await loadModule()
    fetchMock.mockResolvedValue(textResponse(NOW_ISO))

    await fetchServerTime()

    expect(warnMock).not.toHaveBeenCalled()
  })
})
