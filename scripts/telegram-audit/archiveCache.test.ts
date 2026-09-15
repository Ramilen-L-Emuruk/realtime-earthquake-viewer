import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// @ts-expect-error -- 型定義を持たない .mjs（`scripts/lib/stationSource.mjs` と同じ扱い）
import { gate, resetArchiveCacheForTest, listArchive, withCompletenessMark, archiveCacheStats } from './archive-cache.mjs'

// アーカイブ取得のレート制御。**配信元の制限を守る唯一の仕組み**なので、ここが緩むと
// 「同じ日を取り直さない」控えを入れても、初回の走査で制限を超える。
//
// このファイルを置いたのは、`gate()` が並列で直列化できていない不備を実際に作り込んだため
// （`lastRequestAt` の書き込みが `await` の後にあり、並列で入った呼び出しが同じ値を読んで
// 一斉に発火していた）。スクリプト側のロジックは `npm test` の網から外れやすいので、
// レート制御だけは明示的に固定する。
describe('gate（アーカイブ取得のレート制御）', () => {
  const INTERVAL = 6_000

  beforeEach(() => {
    resetArchiveCacheForTest()
    vi.useFakeTimers()
  })

  /** `gate` を n 本同時に呼び、それぞれが抜けた時刻（偽の時計）を記録する。 */
  async function raceGates(kind: string, n: number, intervalMs = INTERVAL): Promise<number[]> {
    const start = Date.now()
    const exitedAt: number[] = []
    const running = Array.from({ length: n }, async () => {
      await gate(kind, intervalMs)
      exitedAt.push(Date.now() - start)
    })
    // 予約は同期的に積まれるので、時計を進めれば順に抜ける
    await vi.advanceTimersByTimeAsync(intervalMs * n)
    await Promise.all(running)
    return exitedAt.sort((a, b) => a - b)
  }

  // 正: 並列に呼んでも間隔が守られる。**1 本ずつ階段状にずれる**こと。
  // これが崩れると「6 秒ごとに CONCURRENCY 件のバースト」になり、守るつもりの
  // 50req/5min を並列数の分だけ超える
  it('並列に呼んでも 1 本ずつ間隔が空く', async () => {
    const exits = await raceGates('body', 5)

    expect(exits).toHaveLength(5)
    // 1 本目は即時、以降は前の枠から `INTERVAL` 以上あとに抜ける
    expect(exits[0]).toBe(0)
    for (let i = 1; i < exits.length; i++) {
      expect(exits[i] - exits[i - 1]).toBeGreaterThanOrEqual(INTERVAL)
    }
  })

  // 対照: 間隔が空いていれば待たない。控えから読めた分はゲートを通さない設計だが、
  // 通ったとしても時間が経っていれば待たされないこと（初回の走査以外を遅くしない）
  it('前回から間隔が空いていれば待たない', async () => {
    await gate('body', INTERVAL)
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)

    const start = Date.now()
    await gate('body', INTERVAL)

    expect(Date.now() - start).toBe(0)
  })

  // 安全弁: 種別（一覧 / 本体）ごとに独立して数える。混ぜると、6 秒間隔の本体取得に
  // 引っぱられて一覧の取得まで遅くなる（一覧はドメイン全体の制限にしか当たらない）
  it('一覧と本体は互いに待たない', async () => {
    await gate('body', INTERVAL)

    const start = Date.now()
    await gate('list', 500)

    expect(Date.now() - start).toBe(0)
  })

  // 安全弁: 待ちは**積み上がる**こと。同じ時刻へ 2 本以上が並ばない。
  //
  // **2 本では足りない。** 不備があった実装（`await` の後に書き込む形）でも、2 本なら
  // 1 本目が即時・2 本目が 1 間隔後になって通ってしまう。症状が出るのは 3 本目からで、
  // そこから先が 2 本目と同じ時刻へ固まる。実際この安全弁を 2 本で書いていて、
  // 旧実装へ戻したときに**通ってしまった**（弱いテストは無いより悪い）。
  it('同時に入った何本も、同じ時刻へ固まらない', async () => {
    const exits = await raceGates('body', 5)

    expect(new Set(exits).size).toBe(5)
  })
})

// 走査できなかった範囲を、**結果そのもの**へ印として残すこと。
//
// 失敗の内訳は標準エラーへ出るが、これらのスクリプトの出力（標準出力の JSON）だけを
// 保存・受け渡しする運用では見えない。「集めたが 0 件」と「集められなかった」が
// 区別できない形で残ると、それが「この種別は実配信に無い」という主張の根拠になる。
describe('withCompletenessMark（走査の不完全さを結果へ載せる）', () => {
  beforeEach(() => {
    // **統計も空にする。** 前のテストが残した失敗が見えると、「失敗が無いとき」の
    // 振る舞いを確かめるテストが実行順によって落ちる
    resetArchiveCacheForTest()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // 対照: 失敗が無ければ結果に手を加えない（平常時に余計なキーを混ぜない）
  it('失敗が無ければ結果をそのまま返す', () => {
    expect(archiveCacheStats().failures).toHaveLength(0)

    const result = { VXSE53: 8 }
    expect(withCompletenessMark(result)).toEqual({ VXSE53: 8 })
  })

  // 正: 一覧の取得に失敗した範囲があれば、結果へ印が載る。
  // **0 件と区別できること**がこのテストの主眼
  it('走査できなかった範囲があれば結果へ印を載せる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 500,
      ok: false,
      json: async () => ({ status: 'error' }),
    })))

    const pending = listArchive({
      classification: 'telegram.earthquake',
      from: '2026-01-01',
      to: '2026-01-02',
      auth: {},
    }).catch((e: unknown) => e)
    // 待ち直し（指数バックオフ）を飛ばす
    await vi.advanceTimersByTimeAsync(120_000)
    await pending

    expect(archiveCacheStats().failures.length).toBeGreaterThan(0)

    // 「0 件だった」ように見える結果に、不完全であることの印が付く
    const marked = withCompletenessMark({ areas: 0, warning: 0, lgint: 0 }) as Record<string, unknown>
    expect(marked._incomplete).toContain('「無い」の根拠にしないこと')
    // 元の値は保つ（印を足すだけで、集計を書き換えない）
    expect(marked.areas).toBe(0)
  })
})

// **ページを辿るループに上限が無いと、1 回の走査で数百リクエストが飛ぶ。**
// 2026-09-15 にアプリ側の同じ形のループで踏んだ —— 範囲外の日付を渡したところ、配信元は
// 範囲指定を無視したかのように `nextToken` を返し続け、合計 399 リクエストを辿った。
describe('一覧のページ送りは上限で打ち切る', () => {
  beforeEach(() => {
    resetArchiveCacheForTest()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** **無限に `nextToken` を返す**一覧。範囲指定が効かなくなった状態の再現。 */
  function endlessList() {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      return {
        status: 200,
        ok: true,
        json: async () => ({ status: 'ok', items: [], nextToken: `t${calls}` }),
      }
    }))
    return () => calls
  }

  // 正: 上限で止まり、**失敗として記録される**。止まらなければこのテストは終わらない
  // （無限ループになる）ので、「通った」こと自体が上限が効いている証拠になる。
  //
  // 黙って切ってはいけない —— この script は網羅性を主張するために使うので、走査できなかった
  // 期間が「アーカイブが無かった」に化けて集計へ混ざる。
  it('正: 20 ページで打ち切り、失敗として記録する', async () => {
    const listCalls = endlessList()

    const pending = listArchive({
      classification: 'telegram.earthquake',
      from: '2026-01-01',
      to: '2026-01-02',
      auth: {},
    }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(300_000)
    const outcome = await pending

    expect(String((outcome as Error)?.message ?? outcome)).toContain('ページ上限')
    expect(listCalls()).toBe(20)
    expect(archiveCacheStats().failures.length).toBeGreaterThan(0)
    // 集計へ「無いの根拠にしないこと」の印が載る
    const marked = withCompletenessMark({ VXSE53: 0 }) as Record<string, unknown>
    expect(marked._incomplete).toBeDefined()
  })

  // 対照: `nextToken` が尽きれば上限より手前で止まり、失敗としても記録しない。
  it('対照: ページが尽きれば上限に触れず、失敗として記録しない', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      return {
        status: 200,
        ok: true,
        json: async () => ({ status: 'ok', items: [], ...(calls < 3 ? { nextToken: `t${calls}` } : {}) }),
      }
    }))

    const pending = listArchive({
      classification: 'telegram.earthquake',
      from: '2026-01-01',
      to: '2026-01-02',
      auth: {},
    })
    await vi.advanceTimersByTimeAsync(300_000)
    await pending

    expect(calls).toBe(3)
    expect(archiveCacheStats().failures).toHaveLength(0)
  })
})
