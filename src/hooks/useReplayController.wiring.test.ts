// @vitest-environment jsdom
//
// useReplayController の「結線」のテスト。
//
// 世代照合や損失の集計そのもの（純粋関数）は useReplayController.test.ts で見ている。
// こちらが見るのは、Hook がそれらを「どの順で呼ぶか」だけ。
//
// 順序が要になるのは、アーカイブ取得が中断できないため。停止・再開をまたいで古い取得が
// 後から完了するので、世代照合より前に state を触ると新しいセッションの状態が壊れる。
// 照合を loadReplayEvents の後ろへ動かしても型チェックも純粋関数のテストも通ってしまい、
// 以前はこの種の退行を実機のブラウザ操作でしか検出できなかった。
//
// React を動かすため、このファイルだけ jsdom 環境で実行する（既定の node は変えない）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { drainReplayEvents } from '../utils/replayEventLog'
import {
  useReplayController, WINDOW_MS, PRE_WINDOW_MS, PREFETCH_MARGIN_MS,
  assemblePreWindowMaterial,
  REPLAY_EARLIEST_MS, REPLAY_FUTURE_MARGIN_MS, replayTargetProblem,
} from './useReplayController'
import type { ReplayEntry, ReplayFetchResult, QuakeHistoryResult } from '../types/replay'
import type { JMAQuake } from '../types/earthquake'
import { log } from '../utils/logger'


/**
 * テスト用: 取りこぼしを日ごとの Map にする。
 *
 * 実装が件数ひとつから日ごとへ変わったのは、同じ日を二度読んでも二重に数えず、別の日の分も
 * 失わないため（→ `utils/telegramLoss.ts` の `skippedByDay`）。
 */
function skips(count: number, day = '2026-08-10'): Map<string, number> {
  return count > 0 ? new Map([[day, count]]) : new Map()
}

// 外部 I/O（取得）とキャッシュ破棄は deps 経由で注入されるため、ここでは偽物を渡すだけでよい。
// Hook が内部で使う filterPreWindowEvents は本物のまま動く（後述の長周期地震動電文は
// 無加工で素通しされるため、結線の観察を邪魔しない）。

// フックは進行状況を逐一ログに出す。これを黙らせるのに console を潰すと、React が
// console.error に出す act 警告まで隠れてしまう（本物の異常が見えなくなる）。
// 黙らせたいのはアプリのログだけなので、ロガー側を差し替える。
// log だけを差し替え、それ以外（createLogThrottle 等）は実物を使う。全置換にすると
// logger に export が増えるたびに、無関係な import グラフの都合でこのテストが落ちる。
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))


interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 解決のタイミングをテスト側で握るための Promise。取得の完了順序を作るのに使う。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/**
 * 結線の観察用の電文。長周期地震動（'event' 以外）を使うのは、filterPreWindowEvents が
 * これを無加工で素通しするため。中身の判定に踏み込まず、順序と件数だけを見られる。
 */
function entry(id: string): ReplayEntry {
  return {
    payload: {
      kind: 'lpgm',
      data: {
        id,
        eventId: id,
        time: '2026-08-15T12:00:00+09:00',
        originTime: '2026-08-15T11:59:00+09:00',
        maxClass: 1,
        cancelled: false,
      },
    },
    replayTime: new Date('2026-08-15T12:00:00+09:00'),
  }
}

function idOf(e: ReplayEntry): string {
  return e.payload.kind === 'lpgm' ? e.payload.data.id : '(other)'
}

function fetched(entries: ReplayEntry[], skipped = 0, failedArchiveUrls: string[] = []): ReplayFetchResult {
  return { entries, skippedByDay: skips(skipped), failedArchiveUrls, rateLimitedSources: [], rateLimitedTelegrams: 0 }
}

/**
 * 先読みが割り込まない基準時刻。
 *
 * 先読みは「読み込み済みの終端（T+1 時間）まで残り 10 分」で走る。T を現在時刻の近くに置けば
 * 終端は 1 時間先になり発火しない。テスト中の serverNow() は壁時計のままである点に依存している
 * （時計への反映は App の責務で、この Hook は setTimeOffset を呼ぶだけ）。
 */
function quietTarget(offsetMs = 0): Date {
  return new Date(Date.now() + offsetMs)
}

/** 先読みが即座に走る基準時刻。終端（T + WINDOW_MS）が閾値の内側（残り半分）に来る。 */
function prefetchTarget(): Date {
  return new Date(Date.now() - WINDOW_MS + PREFETCH_MARGIN_MS / 2)
}

/** 空の履歴。履歴の中身を見ないテストは、取得をすぐ返すこれで済ませる。 */
function emptyHistory(): QuakeHistoryResult {
  return {
    quakes: [], tsunamis: [], extras: [], skippedByDay: skips(0),
    failedArchiveUrls: [], rateLimitedSources: [], rateLimitedTelegrams: 0, hasMore: false, oldestLoadedDay: null,
  }
}

/**
 * @param holdHistory 履歴の完了をテスト側で握るか。**既定では即座に空で返す** —— 再生の開始は
 *   履歴を待つので、握ったまま本編・初期状態だけ解決しても `start` は終わらない。
 */
function setup({ holdHistory = false }: { holdHistory?: boolean } = {}) {
  // 呼び出し順序の記録。どの state 操作が世代照合の後ろにあるかをここで見る。
  const order: string[] = []
  const fetches: Deferred<ReplayFetchResult>[] = []
  // 取得に渡された引数。どちらの呼び出しが本編でどちらが初期状態かを日付範囲で確かめる。
  const ranges: { from: Date; to: Date }[] = []
  // 履歴の取得。本編・初期状態とは別に完了させられるよう独立に持つ
  // （履歴が失敗しても再生が続くこと・揃うまで再生を待つことを確かめるため）。
  const histories: Deferred<QuakeHistoryResult>[] = []
  const historyArgs: { before: Date }[] = []
  // App が持つ state の代役。Hook は setTimeOffset で書き、次のレンダーで読む。
  let timeOffset: number | null = null

  const deps = {
    fetchEvents: vi.fn((fromTime: Date, toTime: Date) => {
      order.push('fetch')
      ranges.push({ from: fromTime, to: toTime })
      const d = createDeferred<ReplayFetchResult>()
      fetches.push(d)
      return d.promise
    }),
    fetchQuakeHistory: vi.fn((before: Date) => {
      order.push('fetchQuakeHistory')
      historyArgs.push({ before })
      const d = createDeferred<QuakeHistoryResult>()
      histories.push(d)
      if (!holdHistory) d.resolve(emptyHistory())
      return d.promise
    }),
    restoreQuakeHistory: vi.fn((_quakes: JMAQuake[]) => { order.push('restoreQuakeHistory') }),
    clearCache: vi.fn(() => { order.push('clearReplayCache') }),
    setTimeOffset: vi.fn((value: number | null) => { order.push('setTimeOffset'); timeOffset = value }),
    resetState: vi.fn(() => { order.push('resetState') }),
    resetTracking: vi.fn(() => { order.push('resetTracking') }),
    resetLocalState: vi.fn(() => { order.push('resetLocalState') }),
    restorePreWindowTracking: vi.fn((_entries: ReplayEntry[]) => { order.push('restorePreWindowTracking') }),
    loadReplayEvents: vi.fn((_entries: ReplayEntry[]) => { order.push('loadReplayEvents') }),
  }

  // deps を毎レンダー新しいオブジェクトで渡すのは実際の App と同じ（Hook 側は ref 経由で読む）。
  const view = renderHook(() => useReplayController({ ...deps, timeOffset }))

  return {
    deps,
    order,
    fetches,
    ranges,
    histories,
    historyArgs,
    get current() { return view.result.current },

    /** start を呼び、その Promise を返す。取得の解決は呼び出し側が fetches 経由で握る。 */
    start(target: Date): Promise<void> {
      let started!: Promise<void>
      act(() => { started = view.result.current.start(target) })
      return started
    },

    stop(): void {
      act(() => { view.result.current.stop() })
    },

    /**
     * 保留中の非同期処理を流し、React の更新を反映させる。
     *
     * act 自身が保留中のマイクロタスクと再レンダーを空になるまで回すため、start の戻りを
     * 渡せない経路（先読み）でもチェーンの then → finally まで到達する。それで足りることは
     * 「先読みが成功すれば、続きの電文を積んで取得中表示を戻す」が肯定形で保証している。
     * あれが通る限り、同じ手順を踏む否定形のテスト（積まない・エラーを出さない）が
     * 「まだ完了していないだけ」で緑になることはない。
     */
    async flush(pending?: Promise<unknown>): Promise<void> {
      await act(async () => {
        if (pending) await pending
      })
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// testing-library の自動 cleanup はグローバルの afterEach を見て登録される。この
// プロジェクトは vitest の globals を有効にしていないため自動では働かない。手で呼ばないと
// フックがマウントされたまま積み上がり、生き残った先読み effect が後続テストの記録を汚す。
afterEach(cleanup)

describe('useReplayController の start', () => {
  it('取得に成功すると、初期状態・本編の順に積んで取得中表示を戻す', async () => {
    const h = setup()
    const started = h.start(quietTarget())
    expect(h.current.isFetching).toBe(true)

    h.fetches[0].resolve(fetched([entry('normal-1')]))
    h.fetches[1].resolve(fetched([entry('pre-1')]))
    await h.flush(started)

    // 積まれたことを先に確かめる。取得が終わりきっていない状態で下の中身を見ると、
    // 「順序が違う」ではなく添字エラーで落ちて原因が読み取れなくなる。
    expect(h.deps.loadReplayEvents).toHaveBeenCalledTimes(1)
    const loaded = h.deps.loadReplayEvents.mock.calls[0][0]
    // 初期状態を先に積まないと、地震が起きていない状態から再生が始まる
    expect(loaded.map(idOf)).toEqual(['pre-1', 'normal-1'])
    // 初期状態は T の 1ms 前に無音で注入する（音を鳴らさず T 時点の状態だけ再現する）
    expect(loaded[0].silent).toBe(true)
    // 追跡 ref の復元には、素の取得結果ではなく初期状態として整形した側を渡す
    expect(h.deps.restorePreWindowTracking.mock.calls[0][0]).toEqual(loaded.slice(0, 1))
    expect(h.current.isFetching).toBe(false)
    expect(h.current.error).toBeNull()
  })

  it('本編と初期状態を、それぞれ正しい日付範囲で取りに行く', async () => {
    const target = quietTarget()
    const h = setup()
    const started = h.start(target)
    h.fetches[0].resolve(fetched([]))
    h.fetches[1].resolve(fetched([]))
    await h.flush(started)

    // 1 本目が本編（T から先）、2 本目が初期状態（T より前）。入れ替わると、再生開始前の
    // 状況を再現すべき側が未来を読みに行くことになる。
    expect(h.ranges).toHaveLength(2)
    expect(h.ranges[0].from.getTime()).toBe(target.getTime())
    expect(h.ranges[0].to.getTime()).toBe(target.getTime() + WINDOW_MS)
    expect(h.ranges[1].from.getTime()).toBe(target.getTime() - PRE_WINDOW_MS)
    expect(h.ranges[1].to.getTime()).toBe(target.getTime())
  })

  it('取得に失敗しても時計は戻さない（強震モニタの再生は続ける）', async () => {
    const h = setup()
    const started = h.start(quietTarget())

    h.fetches[0].reject(new Error('boom'))
    h.fetches[1].resolve(fetched([]))
    await h.flush(started)

    // どちらの取得で失敗したかが分かること
    expect(h.current.error).toMatch(/本編/)
    expect(h.current.error).toMatch(/boom/)
    // 電文が取れないことと、強震モニタは続くことの両方を伝える
    expect(h.current.error).toMatch(/強震モニタの再生は継続/)
    // 強震モニタは timeOffset だけで過去フレームへ切り替わる別経路なので、DMDATA の
    // アーカイブが読めなくても再生は成立する。戻すと API キーが無い環境で検証できなくなる。
    expect(h.deps.setTimeOffset).toHaveBeenLastCalledWith(expect.any(Number))
    expect(h.deps.loadReplayEvents).not.toHaveBeenCalled()
    expect(h.current.isFetching).toBe(false)
  })

  it('取得に失敗した後もリセット（stop）で時計を戻せる', async () => {
    const h = setup()
    const started = h.start(quietTarget())
    h.fetches[0].reject(new Error('boom'))
    h.fetches[1].resolve(fetched([]))
    await h.flush(started)

    h.stop()

    expect(h.deps.setTimeOffset).toHaveBeenLastCalledWith(null)
    expect(h.current.error).toBeNull()
  })

  it('取りこぼしがあれば、再生が始まっていても知らせる', async () => {
    const h = setup()
    const started = h.start(quietTarget())

    // 本編と初期状態は日付範囲が重なるため、同じアーカイブの失敗を両方が報告する
    h.fetches[0].resolve(fetched([entry('normal-1')], 2, ['https://example/a']))
    h.fetches[1].resolve(fetched([], 0, ['https://example/a']))
    await h.flush(started)

    expect(h.deps.loadReplayEvents).toHaveBeenCalledTimes(1)
    // URL の集合で重複を除くので、1 件の障害が 2 件に膨らまない
    expect(h.current.error).toMatch(/取得元1件/)
    expect(h.current.error).toMatch(/電文2件/)
    expect(h.current.error).toMatch(/継続中/)
  })

  // 安全弁: 窓の手前からの復元が投げても、電文の再生は始まる。
  //
  // 復元と loadReplayEvents は同じ try の中にいる。囲わずに投げさせると catch まで飛び、
  // **取得は成功しているのに「リプレイデータ取得失敗」と出たまま電文が 1 通も再生されない**。
  // 復元が触るのは既読の記録だけなので、飛んでも再生は成立する（窓の手前の内容を読み直すだけ）。
  it('窓の手前からの復元が投げても、電文を積んで再生を始める', async () => {
    const h = setup()
    h.deps.restorePreWindowTracking.mockImplementationOnce(() => { throw new Error('復元で投げた') })
    const started = h.start(quietTarget())
    h.fetches[0].resolve(fetched([entry('normal-1')]))
    h.fetches[1].resolve(fetched([entry('pre-1')]))
    await h.flush(started)
    expect(h.deps.loadReplayEvents).toHaveBeenCalledTimes(1)
    expect(h.deps.loadReplayEvents.mock.calls[0][0].map(idOf)).toEqual(['pre-1', 'normal-1'])
    // 取得は成功しているので、取得失敗の赤字は出さない
    expect(h.current.error).toBeNull()
    expect(h.current.isFetching).toBe(false)
    // 黙って捨てない
    const messages = vi.mocked(log.error).mock.calls.map(c => c.map(v => String(v)).join(' '))
    expect(messages.some(m => m.includes('窓の手前からの状態復元に失敗'))).toBe(true)
  })

  it('取得より前に時計を進め、照合を挟んでから state を触る', async () => {
    const h = setup()
    const started = h.start(quietTarget())

    h.fetches[0].resolve(fetched([entry('normal-1')]))
    h.fetches[1].resolve(fetched([entry('pre-1')]))
    await h.flush(started)

    expect(h.order).toEqual([
      'resetState', 'resetTracking', 'resetLocalState', 'clearReplayCache', 'setTimeOffset',
      // 履歴は本編・初期状態と並行に取り、3 つとも揃ってから反映する
      // （履歴は初期状態の材料にも混ぜるので、待たないと 1 本にできない）
      'fetchQuakeHistory',
      'fetch', 'fetch',
      'restoreQuakeHistory',
      'resetTracking', 'restorePreWindowTracking', 'loadReplayEvents',
    ])
    // 時計を進めるのが取得より前であること。後ろへ動かすと、pre-window の取得中に
    // serverNow() がライブ時刻のままになり、その間の判定が T ではなく現在時刻を見る。
    expect(h.order.indexOf('setTimeOffset')).toBeLessThan(h.order.indexOf('fetch'))
  })
})

// **取得を 1 件も投げる前に弾く。** 2026-09-15 に `window.__replay.start()` へ数値を渡して
// 再生時刻が 1969 年になったとき、DMDATA の電文一覧へ 399 件・強震モニタへ 177 件の
// リクエストが飛んだ（どちらも対象のデータは 1 件も無い）。範囲外の指定を下流へ流すと、
// 取得元の数だけ空振りのリクエストが出る。
describe('範囲外の時刻では取得を始めない', () => {
  describe('replayTargetProblem', () => {
    const now = Date.UTC(2026, 8, 15)

    it('正: 収録のある時刻は通す', () => {
      expect(replayTargetProblem(new Date(Date.UTC(2026, 8, 13)), now)).toBeNull()
      expect(replayTargetProblem(new Date(REPLAY_EARLIEST_MS), now)).toBeNull()
    })

    it('対照: 下限より前は理由を返す', () => {
      expect(replayTargetProblem(new Date(REPLAY_EARLIEST_MS - 1), now)).toContain('再生できません')
      expect(replayTargetProblem(new Date(Date.UTC(1969, 11, 30)), now)).toContain('再生できません')
    })

    it('対照: 未来は理由を返す（ただし時計のずれぶんは通す）', () => {
      expect(replayTargetProblem(new Date(now + REPLAY_FUTURE_MARGIN_MS - 1), now)).toBeNull()
      expect(replayTargetProblem(new Date(now + REPLAY_FUTURE_MARGIN_MS + 1), now)).toContain('未来')
    })

    it('安全弁: 日時として読めない値も弾く', () => {
      expect(replayTargetProblem(new Date('これは日時ではない'), now)).toContain('読み取れません')
    })
  })

  // 正: 入口で止まり、取得が 1 件も走らない。
  it('正: 下限より前の時刻では取得を呼ばない', async () => {
    const h = setup()
    const started = h.start(new Date(Date.UTC(1969, 11, 30)))
    await h.flush(started)

    expect(h.fetches).toHaveLength(0)
    expect(h.current.error).toContain('再生できません')
    expect(h.current.isFetching).toBe(false)
  })

  // 対照: 正常な時刻では従来どおり取得へ進む（ガードが広すぎないこと）。
  it('対照: 収録のある時刻では従来どおり取得へ進む', async () => {
    const h = setup()
    const started = h.start(quietTarget())
    expect(h.fetches.length).toBeGreaterThan(0)
    h.fetches[0].resolve(fetched([]))
    h.fetches[1].resolve(fetched([]))
    await h.flush(started)

    expect(h.current.error).toBeNull()
  })
})

describe('useReplayController の停止・再開', () => {
  // 停止も開始と同じ 3 つを落とす。**開始側だけを固定すると、片方だけ変更されて
  // 非対称になっても気づけない**（リプレイを止めたのに選択中の地震と追加表示が残る、
  // という形で症状が出る）。
  it('停止でも 3 つのリセットを同じ並びで呼ぶ', () => {
    const h = setup()
    h.start(quietTarget())
    h.order.length = 0
    h.stop()
    expect(h.order.slice(0, 4)).toEqual([
      'setTimeOffset', 'resetState', 'resetTracking', 'resetLocalState',
    ])
  })

  it('停止したあとに古い取得が完了しても、電文を積まない', async () => {
    const h = setup()
    const started = h.start(quietTarget())
    h.stop()

    h.fetches[0].resolve(fetched([entry('stale-normal')]))
    h.fetches[1].resolve(fetched([entry('stale-pre')]))
    await h.flush(started)

    expect(h.deps.loadReplayEvents).not.toHaveBeenCalled()
    expect(h.deps.restorePreWindowTracking).not.toHaveBeenCalled()
    // 照合の後ろにある resetTracking も走らない（start で 1 回・stop で 1 回だけ）
    expect(h.deps.resetTracking).toHaveBeenCalledTimes(2)
  })

  it('停止したあとに古い取得が失敗しても、エラーを出さない', async () => {
    const h = setup()
    const started = h.start(quietTarget())
    h.stop()

    h.fetches[0].reject(new Error('boom'))
    h.fetches[1].resolve(fetched([]))
    await h.flush(started)

    expect(h.current.error).toBeNull()
    // 巻き戻しも走らない（start の 1 回と stop の 1 回だけ）
    expect(h.deps.setTimeOffset).toHaveBeenCalledTimes(2)
  })

  // 録画ツールは `fetching()` と `fetch` イベントの両方を見る。**片方だけ世代を照合すると
  // 2 つが食い違う** —— 停止して別の日時で開き直した直後に古い取得が解決したとき、まだ
  // 取得中なのに「終わった」だけが並び、外からは待ちを閉じてよいと読める。
  it('停止したあとに古い取得が完了しても、取得の終わりを記録しない', async () => {
    const h = setup()
    const started = h.start(quietTarget())
    h.stop()
    drainReplayEvents()   // 開始までの記録は捨てて、以降に出たものだけを見る

    h.fetches[0].resolve(fetched([entry('stale-normal')]))
    h.fetches[1].resolve(fetched([entry('stale-pre')]))
    await h.flush(started)

    const done = drainReplayEvents().events
      .filter(e => e.type === 'fetch' && e.phase === 'done')
    expect(done).toEqual([])
  })

  // 対照: 世代が生きている取得では、従来どおり終わりの印が出る（上の照合を
  // 「常に記録しない」へ倒すと、この 1 件が落ちる）。
  it('停止していなければ、取得の終わりを記録する', async () => {
    const h = setup()
    const started = h.start(quietTarget())
    drainReplayEvents()

    h.fetches[0].resolve(fetched([entry('normal')]))
    h.fetches[1].resolve(fetched([entry('pre')]))
    await h.flush(started)

    const done = drainReplayEvents().events
      .filter(e => e.type === 'fetch' && e.phase === 'done' && e.target === 'main')
    expect(done).toHaveLength(1)
  })

  it('別の時刻で再開したあとに古い取得が完了しても、新しい側を壊さない', async () => {
    const h = setup()
    const first = h.start(quietTarget())
    h.stop()
    const second = h.start(quietTarget(-30 * 60_000))

    // 新しい側が先に完了する
    h.fetches[2].resolve(fetched([entry('new-normal')]))
    h.fetches[3].resolve(fetched([entry('new-pre')]))
    await h.flush(second)

    // そのあとで古い側が完了する
    h.fetches[0].resolve(fetched([entry('old-normal')]))
    h.fetches[1].resolve(fetched([entry('old-pre')]))
    await h.flush(first)

    expect(h.deps.loadReplayEvents).toHaveBeenCalledTimes(1)
    expect(h.deps.loadReplayEvents.mock.calls[0][0].map(idOf)).toEqual(['new-pre', 'new-normal'])
  })

  it('取得中に停止すると、取得中表示が戻る', async () => {
    const h = setup()
    const started = h.start(quietTarget())
    expect(h.current.isFetching).toBe(true)

    h.stop()

    // 世代を進めた結果、取得側の finally は表示に触らない。戻すのは stop の責務。
    expect(h.current.isFetching).toBe(false)

    h.fetches[0].resolve(fetched([]))
    h.fetches[1].resolve(fetched([]))
    await h.flush(started)

    // 古い取得が終わっても取得中へ戻らないこと。ここは照合の有無では差が出ない
    // （finally はどちらにせよ false しか書かない）ので、照合そのものの検証は上の 1 件が担う。
    expect(h.current.isFetching).toBe(false)
  })

  it('停止せずに別の時刻で再開すると、前のセッションの通知を持ち越さない', async () => {
    const h = setup()
    const first = h.start(quietTarget())
    h.fetches[0].resolve(fetched([entry('old-normal')], 3, ['https://example/a']))
    h.fetches[1].resolve(fetched([]))
    await h.flush(first)
    expect(h.current.error).toMatch(/電文3件/)

    // 設定画面の「確定」は再生中も押せる。停止を挟まずに start が再度呼ばれる経路。
    const second = h.start(quietTarget(-30 * 60_000))
    h.fetches[2].resolve(fetched([entry('new-normal')]))
    h.fetches[3].resolve(fetched([]))
    await h.flush(second)

    // 前のセッションの取りこぼしを新しいセッションの表示に残さない
    expect(h.current.error).toBeNull()
    const calls = h.deps.loadReplayEvents.mock.calls
    expect(calls[calls.length - 1][0].map(idOf)).toEqual(['new-normal'])
  })

  it('停止せずに再開すると、前回の取得エラーの赤字も消える', async () => {
    const h = setup()
    const first = h.start(quietTarget())
    h.fetches[0].reject(new Error('boom'))
    h.fetches[1].resolve(fetched([]))
    await h.flush(first)
    expect(h.current.error).toMatch(/boom/)

    h.start(quietTarget(-30 * 60_000))

    // 取得の完了を待たず、開始した時点で消えていること。残っていると、赤字と
    // 「取得中...」が同時に出て、失敗したのか読み込み中なのか読み取れなくなる。
    expect(h.current.error).toBeNull()
  })

  it('停止すると、確定していた取りこぼしの通知も消える', async () => {
    const h = setup()
    const started = h.start(quietTarget())
    h.fetches[0].resolve(fetched([entry('normal-1')], 2, ['https://example/a']))
    h.fetches[1].resolve(fetched([]))
    await h.flush(started)
    expect(h.current.error).toMatch(/電文2件/)

    h.stop()

    // 損失は「このセッションで失われた量」。停止したら数え直すので、前のセッションの
    // 取りこぼしを次のセッションへ持ち越さない。
    expect(h.current.error).toBeNull()
  })
})

describe('useReplayController の先読み', () => {
  /** 先読みが走っている状態まで進める。 */
  async function startUntilPrefetching() {
    const h = setup()
    const started = h.start(prefetchTarget())
    h.fetches[0].resolve(fetched([entry('normal-1')]))
    h.fetches[1].resolve(fetched([]))
    await h.flush(started)

    // 読み込み済みの終端まで残り 5 分なので、続きの 1 時間を先読みする
    expect(h.fetches).toHaveLength(3)
    expect(h.current.isFetching).toBe(true)
    return h
  }

  it('停止したあとに先読みが完了しても、電文を積まない', async () => {
    const h = await startUntilPrefetching()

    h.stop()
    h.fetches[2].resolve(fetched([entry('prefetched')]))
    await h.flush()

    expect(h.deps.loadReplayEvents).toHaveBeenCalledTimes(1)
    expect(h.deps.loadReplayEvents.mock.calls[0][0].map(idOf)).toEqual(['normal-1'])
  })

  it('停止したあとに先読みが失敗しても、エラーを出さない', async () => {
    const h = await startUntilPrefetching()

    h.stop()
    h.fetches[2].reject(new Error('boom'))
    await h.flush()

    expect(h.current.error).toBeNull()
  })

  // 失敗した区間は読み直さない作りなので、記録が残らないと欠落を知る手段が無くなる。
  // 原因（回復しうる情報）だけを出す形にすると、次の先読みが成功した時点で警告ごと消え、
  // 黙って減った電文がそのまま埋もれる。確定した損失として別に数えるのはそのため
  //（成功時に損失を維持することは addLoss / addFailedPrefetch の単体テストが担保する）。
  it('先読みが失敗したら、原因とあわせて欠落を確定した損失として記録する', async () => {
    const h = await startUntilPrefetching()

    h.fetches[2].reject(new Error('boom'))
    await h.flush()

    expect(h.current.error).toMatch(/再生されません/)
    expect(h.current.error).toMatch(/先読み1区間/)
  })

  it('先読みが成功すれば、続きの電文を積んで取得中表示を戻す', async () => {
    const h = await startUntilPrefetching()

    h.fetches[2].resolve(fetched([entry('prefetched')]))
    await h.flush()

    expect(h.deps.loadReplayEvents).toHaveBeenCalledTimes(2)
    expect(h.deps.loadReplayEvents.mock.calls[1][0].map(idOf)).toEqual(['prefetched'])
    expect(h.current.isFetching).toBe(false)
  })
})

// 再生開始時刻より前の履歴。使い道は 2 つ —— 地震カードの一覧と、初期状態の材料に足す
// 24 時間より前の電文（→ `assemblePreWindowMaterial`）。ここで見るのは、履歴が
// **失敗しても再生を止めず、成功したら揃うまで待つ**こと。
describe('useReplayController の履歴', () => {
  /** 履歴の結果。中身の統合は mergeQuakeHistory の担当なので、ここでは件数だけ数える。 */
  function history(count: number, skipped = 0, failedArchiveUrls: string[] = []): QuakeHistoryResult {
    const quakes = Array.from({ length: count }, (_, i) => ({ id: `q${i}` } as unknown as JMAQuake))
    return { ...emptyHistory(), quakes, skippedByDay: skips(skipped), failedArchiveUrls }
  }

  it('再生開始時刻を境に、履歴を 1 回だけ取りに行く', async () => {
    const target = quietTarget()
    const h = setup()
    const started = h.start(target)
    h.fetches[0].resolve(fetched([]))
    h.fetches[1].resolve(fetched([]))
    await h.flush(started)

    // 遡る範囲はバリアントが決める（App の `fetchReplayQuakeHistory`）ので、渡すのは上端だけ
    expect(h.deps.fetchQuakeHistory).toHaveBeenCalledTimes(1)
    expect(h.historyArgs[0].before.getTime()).toBe(target.getTime())
  })

  it('取得できた履歴をカード一覧へ流し込む', async () => {
    const h = setup({ holdHistory: true })
    const started = h.start(quietTarget())
    h.fetches[0].resolve(fetched([]))
    h.fetches[1].resolve(fetched([]))
    h.histories[0].resolve(history(3))
    await h.flush(started)

    expect(h.deps.restoreQuakeHistory).toHaveBeenCalledTimes(1)
    expect(h.deps.restoreQuakeHistory.mock.calls[0][0]).toHaveLength(3)
    expect(h.current.error).toBeNull()
  })

  // 正: 履歴が揃うまで電文を積まない。初期状態の材料に混ぜるので、先に積むと 1 本にできない
  // （2026-10-05 ユーザー承認）。
  it('正: 本編と初期状態が揃っても、履歴が返るまでは電文を積まない', async () => {
    const h = setup({ holdHistory: true })
    const started = h.start(quietTarget())
    h.fetches[0].resolve(fetched([entry('normal-1')]))
    h.fetches[1].resolve(fetched([entry('pre-1')]))
    await h.flush()

    expect(h.deps.loadReplayEvents).not.toHaveBeenCalled()
    expect(h.current.isFetching).toBe(true)

    h.histories[0].resolve(history(0))
    await h.flush(started)

    expect(h.deps.loadReplayEvents).toHaveBeenCalledTimes(1)
    expect(h.current.isFetching).toBe(false)
  })

  // 履歴は再生の前提ではない。失敗を Promise.all の中止に繋ぐと、カードが薄くなるだけの
  // 失敗でリプレイ全体（強震モニタを含む）が始まらなくなる。
  it('対照: 履歴の取得に失敗しても、電文の再生は始まる', async () => {
    const h = setup({ holdHistory: true })
    const started = h.start(quietTarget())
    h.histories[0].reject(new Error('boom'))
    h.fetches[0].resolve(fetched([entry('normal-1')]))
    h.fetches[1].resolve(fetched([entry('pre-1')]))
    await h.flush(started)

    expect(h.deps.loadReplayEvents).toHaveBeenCalledTimes(1)
    // 初期状態は 24 時間ぶんだけで作る
    expect(h.deps.loadReplayEvents.mock.calls[0][0].map(idOf)).toEqual(['pre-1', 'normal-1'])
    expect(h.deps.restoreQuakeHistory).not.toHaveBeenCalled()
    // 失敗の事実は伝える。ただし「再生は継続中」と分かる文言であること
    expect(h.current.error).toMatch(/履歴/)
    expect(h.current.error).toMatch(/boom/)
    expect(h.current.error).toMatch(/再生は継続中/)
  })

  // 安全弁: 履歴を待っている間に停止・再開されたら、古い履歴を新しいセッションへ混ぜない。
  it('安全弁: 履歴を待っている間に停止したら、履歴も電文も反映しない', async () => {
    const h = setup({ holdHistory: true })
    const started = h.start(quietTarget())
    h.fetches[0].resolve(fetched([entry('normal-1')]))
    h.fetches[1].resolve(fetched([]))
    await h.flush()

    h.stop()
    h.histories[0].resolve(history(3))
    await h.flush(started)

    expect(h.deps.restoreQuakeHistory).not.toHaveBeenCalled()
    expect(h.deps.loadReplayEvents).not.toHaveBeenCalled()
  })

  // 安全弁: 材料の組み立てが投げても、24 時間ぶんだけで再生を始める（取得失敗とは出さない）。
  it('安全弁: 履歴を材料へ足す処理が投げても、24 時間ぶんで再生を始める', async () => {
    const h = setup({ holdHistory: true })
    const started = h.start(quietTarget())
    h.fetches[0].resolve(fetched([entry('normal-1')]))
    h.fetches[1].resolve(fetched([entry('pre-1')]))
    const broken = { ...emptyHistory() }
    Object.defineProperty(broken, 'tsunamis', { get: () => { throw new Error('読めない履歴') } })
    h.histories[0].resolve(broken)
    await h.flush(started)

    expect(h.deps.loadReplayEvents).toHaveBeenCalledTimes(1)
    expect(h.deps.loadReplayEvents.mock.calls[0][0].map(idOf)).toEqual(['pre-1', 'normal-1'])
    expect(h.current.error).toBeNull()
    const messages = vi.mocked(log.error).mock.calls.map(c => c.map(v => String(v)).join(' '))
    expect(messages.some(m => m.includes('初期状態の材料に履歴を足せなかった'))).toBe(true)
  })

  it('履歴の取りこぼしも、確定した損失として申告する', async () => {
    const h = setup({ holdHistory: true })
    const started = h.start(quietTarget())
    h.fetches[0].resolve(fetched([]))
    h.fetches[1].resolve(fetched([]))
    h.histories[0].resolve(history(1, 2, ['https://x/a']))
    await h.flush(started)

    expect(h.current.error).toMatch(/取得元1件/)
    expect(h.current.error).toMatch(/電文2件/)
  })
})

/** 帯（地震回数）のエントリ。件数は見ないので中身は最小限。 */
function countEntry(id: string, time = '2026-08-15T12:00:00+09:00'): ReplayEntry {
  return {
    payload: {
      kind: 'earthquakeCount',
      data: {
        id, eventId: id, time,
        expireAt: '2026-08-22T12:00:00+09:00', items: [], cancelled: false,
      } as unknown as import('../types/earthquake').JMAEarthquakeCount,
    },
    replayTime: new Date(time),
  }
}

/** 予報（若干の海面変動）だけの津波の報。`validDateTime` は渡したときだけ載せる。 */
function forecastTsunami(id: string, time: string, validDateTime?: string): import('../types/earthquake').JMATsunami {
  return {
    kind: 'tsunami', id, eventId: 'EV-TSUNAMI', time, cancelled: false,
    ...(validDateTime && { validDateTime }),
    issue: { source: '気象庁', time, type: 'Focus' },
    areas: [{ grade: 'Forecast', immediate: false, name: '岩手県' }],
  } as unknown as import('../types/earthquake').JMATsunami
}

function tsunamiEntry(t: import('../types/earthquake').JMATsunami): ReplayEntry {
  return { payload: { kind: 'event', event: t }, replayTime: new Date(t.time) }
}

function kindOf(e: ReplayEntry): string {
  return e.payload.kind === 'event' ? e.payload.event.kind : e.payload.kind
}

// 初期状態の材料を 1 本にまとめる関数（純関数）。足すもの・足さないものの境界を固定する。
describe('assemblePreWindowMaterial', () => {
  it('正: 24 時間に無い津波の報と帯を足し、発表時刻の昇順に並べる', () => {
    const pre = [countEntry('pre-count', '2026-08-15T10:00:00+09:00')]
    const material = assemblePreWindowMaterial(pre, {
      tsunamis: [forecastTsunami('t1', '2026-08-13T09:00:00+09:00', '2026-08-16T00:00:00+09:00')],
      // 長周期（`entry` の既定は 08-15 なので、24 時間より前へずらす）
      extras: [{ ...entry('l1'), replayTime: new Date('2026-08-12T12:00:00+09:00') }],
    }, [])

    expect(material.map(kindOf)).toEqual(['lpgm', 'tsunami', 'earthquakeCount'])
  })

  it('対照: 24 時間側・本編側に同じ鍵の帯があれば足さない（古い報で上書きしない）', () => {
    const pre = [countEntry('new', '2026-08-15T10:00:00+09:00')]
    const normal = [countEntry('at-target', '2026-08-15T12:00:00+09:00')]
    const material = assemblePreWindowMaterial(pre, { tsunamis: [], extras: [countEntry('old', '2026-08-12T12:00:00+09:00')] }, normal)
    expect(material).toEqual(pre)
  })

  it('対照: 24 時間側・本編側に同じ id の津波の報があれば足さない（二重に積まない）', () => {
    const t = forecastTsunami('t1', '2026-08-15T10:00:00+09:00')
    const u = forecastTsunami('t2', '2026-08-15T12:00:00+09:00')
    const material = assemblePreWindowMaterial([tsunamiEntry(t)], { tsunamis: [t, u], extras: [] }, [tsunamiEntry(u)])
    expect(material).toHaveLength(1)
  })

  // 正: `id` は `EventID` と報番号から作るが、報番号は種別ごとに別々に数える。種別の違う報が
  // 同じ `id` になっても、別の報として足す（id だけで見ていたときは、カムチャツカ半島付近の
  // 地震〈2025-07-30〉の 24 時間より前の報が 1 通も足されなかった）。
  it('正: 同じ id でも、情報名が違う報は別の報として足す', () => {
    const warning = { ...forecastTsunami('same-id', '2026-08-13T09:00:00+09:00'), infoName: '津波警報・注意報・予報' }
    const info = { ...forecastTsunami('same-id', '2026-08-15T10:00:00+09:00'), infoName: '津波情報' }
    const material = assemblePreWindowMaterial([tsunamiEntry(info)], { tsunamis: [warning, info], extras: [] }, [])
    expect(material).toHaveLength(2)
  })

  it('安全弁: 履歴が無ければ 24 時間ぶんをそのまま返す', () => {
    const pre = [countEntry('pre')]
    expect(assemblePreWindowMaterial(pre, null, [])).toBe(pre)
  })
})

// 24 時間より前に出た津波が、期限内のまま初期状態に載るか（#541 の本題）。
// **画面へ流すものと記憶の復元へ渡すものが同じ**であることも併せて見る。
describe('useReplayController: 24 時間より前の津波を初期状態に載せる', () => {
  /** T の何時間前か。 */
  function hoursBefore(target: Date, hours: number): string {
    return new Date(target.getTime() - hours * 3600_000).toISOString()
  }

  async function startWith(target: Date, tsunamis: import('../types/earthquake').JMATsunami[]) {
    const h = setup({ holdHistory: true })
    const started = h.start(target)
    h.fetches[0].resolve(fetched([]))
    h.fetches[1].resolve(fetched([]))
    h.histories[0].resolve({ ...emptyHistory(), tsunamis })
    await h.flush(started)
    const loaded = h.deps.loadReplayEvents.mock.calls[0][0] as ReplayEntry[]
    const restored = h.deps.restorePreWindowTracking.mock.calls[0][0] as ReplayEntry[]
    return { loaded, restored }
  }

  it('正: 30 時間前に出て、期限がまだ先の津波は載る（記憶の復元にも同じものを渡す）', async () => {
    const target = quietTarget()
    const { loaded, restored } = await startWith(target, [
      forecastTsunami('t1', hoursBefore(target, 30), new Date(target.getTime() + 3600_000).toISOString()),
    ])
    expect(loaded.filter(e => kindOf(e) === 'tsunami')).toHaveLength(1)
    // 本編は空なので、積んだものと記憶の復元へ渡したものは一致する
    expect(restored).toEqual(loaded)
  })

  it('対照: 期限が再生開始時刻より前に切れていれば載らない', async () => {
    const target = quietTarget()
    const { loaded } = await startWith(target, [
      forecastTsunami('t1', hoursBefore(target, 30), hoursBefore(target, 1)),
    ])
    expect(loaded.filter(e => kindOf(e) === 'tsunami')).toHaveLength(0)
  })

  // 安全弁: 期限を一度も伝えていない津波は、最後の報から 24 時間までしか生かさない
  // （材料が 24 時間だった頃と同じ範囲。→ `dmdataReplay.ts` の `TSUNAMI_WITHOUT_VALIDITY_MAX_AGE_MS`）。
  it('安全弁: 期限を持たない津波は、最後の報から 24 時間を過ぎていれば載らない', async () => {
    const target = quietTarget()
    const stale = await startWith(target, [forecastTsunami('t1', hoursBefore(target, 30))])
    expect(stale.loaded.filter(e => kindOf(e) === 'tsunami')).toHaveLength(0)
  })

  it('対照: 期限を持たない津波でも、最後の報が 24 時間以内なら従来どおり載る', async () => {
    const target = quietTarget()
    const fresh = await startWith(target, [
      forecastTsunami('t1', hoursBefore(target, 30)),
      forecastTsunami('t2', hoursBefore(target, 20)),
    ])
    expect(fresh.loaded.filter(e => kindOf(e) === 'tsunami')).toHaveLength(2)
  })

  it('正: 帯も同じ 1 回の積み込みに入り、初期状態と同じ時刻・無音で流す', async () => {
    const target = quietTarget()
    const h = setup({ holdHistory: true })
    const started = h.start(target)
    h.fetches[0].resolve(fetched([]))
    h.fetches[1].resolve(fetched([]))
    h.histories[0].resolve({ ...emptyHistory(), extras: [countEntry('c1', hoursBefore(target, 48))] })
    await h.flush(started)

    expect(h.deps.loadReplayEvents).toHaveBeenCalledTimes(1)
    const loaded = h.deps.loadReplayEvents.mock.calls[0][0] as ReplayEntry[]
    expect(loaded).toHaveLength(1)
    expect(loaded[0].silent).toBe(true)
    expect(loaded[0].replayTime.getTime()).toBe(target.getTime() - 1)
    expect(h.deps.restorePreWindowTracking.mock.calls[0][0]).toEqual(loaded)
  })
})
