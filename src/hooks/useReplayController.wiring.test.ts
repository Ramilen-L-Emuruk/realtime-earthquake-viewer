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
import { useReplayController, WINDOW_MS, PRE_WINDOW_MS, PREFETCH_MARGIN_MS } from './useReplayController'
import { fetchDmdataReplayEvents, clearReplayCache } from '../services/dmdataReplay'
import type { ReplayEntry, ReplayFetchResult } from '../services/dmdataReplay'

// 差し替えるのは外部 I/O（取得）とキャッシュ破棄だけ。filterPreWindowEvents は本物のまま使う
// （後述の長周期地震動電文は無加工で素通しされるため、結線の観察を邪魔しない）。
vi.mock('../services/dmdataReplay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dmdataReplay')>()
  return { ...actual, fetchDmdataReplayEvents: vi.fn(), clearReplayCache: vi.fn() }
})

// フックは進行状況を逐一ログに出す。これを黙らせるのに console を潰すと、React が
// console.error に出す act 警告まで隠れてしまう（本物の異常が見えなくなる）。
// 黙らせたいのはアプリのログだけなので、ロガー側を差し替える。
vi.mock('../utils/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockFetch = vi.mocked(fetchDmdataReplayEvents)
const mockClearReplayCache = vi.mocked(clearReplayCache)

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
  return { entries, skipped, failedArchiveUrls }
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

function setup() {
  // 呼び出し順序の記録。どの state 操作が世代照合の後ろにあるかをここで見る。
  const order: string[] = []
  const fetches: Deferred<ReplayFetchResult>[] = []
  // 取得に渡された引数。どちらの呼び出しが本編でどちらが初期状態かを日付範囲で確かめる。
  const ranges: { apiKey: string; from: Date; to: Date }[] = []
  // App が持つ state の代役。Hook は setTimeOffset で書き、次のレンダーで読む。
  let timeOffset: number | null = null

  const deps = {
    apiKey: 'test-key',
    setTimeOffset: vi.fn((value: number | null) => { order.push('setTimeOffset'); timeOffset = value }),
    resetState: vi.fn(() => { order.push('resetState') }),
    resetTracking: vi.fn(() => { order.push('resetTracking') }),
    restorePreWindowTracking: vi.fn((_entries: ReplayEntry[]) => { order.push('restorePreWindowTracking') }),
    loadReplayEvents: vi.fn((_entries: ReplayEntry[]) => { order.push('loadReplayEvents') }),
  }

  mockClearReplayCache.mockImplementation(() => { order.push('clearReplayCache') })
  mockFetch.mockImplementation((apiKey, fromTime, toTime) => {
    order.push('fetch')
    ranges.push({ apiKey, from: fromTime, to: toTime })
    const d = createDeferred<ReplayFetchResult>()
    fetches.push(d)
    return d.promise
  })

  // deps を毎レンダー新しいオブジェクトで渡すのは実際の App と同じ（Hook 側は ref 経由で読む）。
  const view = renderHook(() => useReplayController({ ...deps, timeOffset }))

  return {
    deps,
    order,
    fetches,
    ranges,
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
    expect(h.ranges.map(r => r.apiKey)).toEqual(['test-key', 'test-key'])
  })

  it('取得に失敗すると、エラーを出して時計を巻き戻す', async () => {
    const h = setup()
    const started = h.start(quietTarget())

    h.fetches[0].reject(new Error('boom'))
    h.fetches[1].resolve(fetched([]))
    await h.flush(started)

    // どちらの取得で失敗したかが分かること
    expect(h.current.error).toMatch(/本編/)
    expect(h.current.error).toMatch(/boom/)
    // 「再生中」表示が残ると赤字と矛盾するため、オフセットも戻す
    expect(h.deps.setTimeOffset).toHaveBeenLastCalledWith(null)
    expect(h.deps.loadReplayEvents).not.toHaveBeenCalled()
    expect(h.current.isFetching).toBe(false)
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
    expect(h.current.error).toMatch(/1 件のアーカイブ/)
    expect(h.current.error).toMatch(/2 件の電文/)
    expect(h.current.error).toMatch(/継続中/)
  })

  it('取得より前に時計を進め、照合を挟んでから state を触る', async () => {
    const h = setup()
    const started = h.start(quietTarget())

    h.fetches[0].resolve(fetched([entry('normal-1')]))
    h.fetches[1].resolve(fetched([entry('pre-1')]))
    await h.flush(started)

    expect(h.order).toEqual([
      'resetState', 'resetTracking', 'clearReplayCache', 'setTimeOffset',
      'fetch', 'fetch',
      'resetTracking', 'restorePreWindowTracking', 'loadReplayEvents',
    ])
    // 時計を進めるのが取得より前であること。後ろへ動かすと、pre-window の取得中に
    // serverNow() がライブ時刻のままになり、その間の判定が T ではなく現在時刻を見る。
    expect(h.order.indexOf('setTimeOffset')).toBeLessThan(h.order.indexOf('fetch'))
  })
})

describe('useReplayController の停止・再開', () => {
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
    expect(h.current.error).toMatch(/3 件の電文/)

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
    expect(h.current.error).toMatch(/2 件の電文/)

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

  it('先読みが成功すれば、続きの電文を積んで取得中表示を戻す', async () => {
    const h = await startUntilPrefetching()

    h.fetches[2].resolve(fetched([entry('prefetched')]))
    await h.flush()

    expect(h.deps.loadReplayEvents).toHaveBeenCalledTimes(2)
    expect(h.deps.loadReplayEvents.mock.calls[1][0].map(idOf)).toEqual(['prefetched'])
    expect(h.current.isFetching).toBe(false)
  })
})
