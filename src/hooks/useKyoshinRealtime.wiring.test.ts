// @vitest-environment jsdom
//
// useKyoshinRealtime の「結線」のテスト。
//
// 供給元のスケジューリングは kyoshinSource.test.ts、キューの並べ替えと放出は
// kyoshinFrameQueue.test.ts で見ている。こちらが見るのは、その 2 つを繋いだときに
// 「フレームが画面の状態へどう届くか」だけ。
//
// ここを厚くするのは、過去の事故がすべてこの層で起きているため。観測点リストの取得失敗で
// 検知エンジンが恒久停止した件、反映処理内の例外を取得失敗と誤集計してエラー表示が出ないまま
// 更新が止まった件は、いずれも単体テストでは捉えられない結線の問題だった。
//
// React を動かすため、このファイルだけ jsdom 環境で実行する（既定の node は変えない）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useKyoshinRealtime } from './useKyoshinRealtime'
import {
  createYahooLiveSource,
  createYahooArchiveSource,
  type KyoshinFrame,
  type KyoshinSource,
  type KyoshinSourceSink,
} from '../services/kyoshinSource'
import type { SiteCoords, YahooHypoInfoItem } from '../services/kyoshin'
import type { EEWAlert } from '../types/earthquake'
import { setReplayOffset } from '../utils/clock'
import { log } from '../utils/logger'

// 差し替えるのは供給元だけ。キュー・時計・EEW 差分は本物を使う（結線を観察するのが目的なので、
// 途中の部品をモックすると「繋がっているか」を確かめられなくなる）。
vi.mock('../services/kyoshinSource', () => ({
  createYahooLiveSource: vi.fn(),
  createYahooArchiveSource: vi.fn(),
}))

// フックは失敗のたびにログを出す。console を潰すと React の act 警告まで隠れてしまうため、
// 黙らせるのはアプリのロガーだけにする。記録の間引き（createLogThrottle）は検証対象なので
// 本物を残す。
vi.mock('../utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger')>()
  return { ...actual, log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const liveMock = vi.mocked(createYahooLiveSource)
const archiveMock = vi.mocked(createYahooArchiveSource)

const NOW = new Date('2026-08-19T12:00:00+09:00').getTime()
const TOKYO: SiteCoords = [[35.7, 139.7]]
const OSAKA: SiteCoords = [[34.7, 135.5]]

/** テストから任意のフレームを流せる供給元。 */
function createFakeSource(sites: SiteCoords = TOKYO) {
  let sink: KyoshinSourceSink | null = null
  const source: KyoshinSource = {
    start: vi.fn((s: KyoshinSourceSink) => { sink = s }),
    stop: vi.fn(),
    resolveSites: vi.fn().mockResolvedValue(sites),
  }
  return {
    source,
    resolveSites: vi.mocked(source.resolveSites),
    stop: vi.mocked(source.stop),
    /** フレームを 1 件流す。 */
    emit: (frame: KyoshinFrame) => sink?.enqueue(frame),
    /** 更新停止の通知を送る。 */
    setStalled: (stalled: boolean) => sink?.setStalled(stalled),
  }
}

/**
 * フレームを作る。`atMs` はデータ時刻（既定は「1 秒前」＝ Yahoo と同じく常に過去）。
 */
function frameAt(atMs: number, overrides?: Partial<KyoshinFrame>): KyoshinFrame {
  return {
    time: new Date(atMs),
    dataTime: new Date(atMs).toISOString(),
    sitesKey: 'cfg-a',
    indices: [7],
    hypoInfo: [],
    ...overrides,
  }
}

function hypoItem(reportId: string, reportNum: string): YahooHypoInfoItem {
  return {
    reportId,
    reportNum,
    reportTime: '2026/08/19 12:00:00',
    originTime: '2026/08/19 11:59:50',
    regionName: '石川県能登地方',
    latitude: '37.5N',
    longitude: '137.2E',
    depth: '10km',
    magnitude: '5.0',
    calcintensity: '04',
    isFinal: 'false',
    isCancel: 'false',
    isTraining: 'false',
  }
}

describe('useKyoshinRealtime の結線', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
    liveMock.mockReset()
    archiveMock.mockReset()
    vi.mocked(log.warn).mockClear()
    vi.mocked(log.error).mockClear()
    setReplayOffset(null)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    setReplayOffset(null)
  })

  it('フレームが観測点座標・震度・データ時刻として反映される', async () => {
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    const { result } = renderHook(() => useKyoshinRealtime(true))

    const frame = frameAt(NOW - 1000, { indices: [3, 4], sitesKey: 'cfg-a' })
    await act(async () => { fake.emit(frame) })

    expect(result.current.indices).toEqual([3, 4])
    expect(result.current.dataTime).toBe(frame.dataTime)
    expect(result.current.indicesSiteConfigId).toBe('cfg-a')
    expect(result.current.sites).toEqual(TOKYO)
    expect(result.current.sitesSiteConfigId).toBe('cfg-a')
    expect(result.current.error).toBe(false)
  })

  it('データ時刻と観測点集合の識別子が食い違った状態を外に見せない', async () => {
    // 検知エンジンは deps を dataTime だけに絞っており、「dataTime が更新されたなら
    // indicesSiteConfigId も同じフレームの値になっている」ことを前提にガードを組んでいる。
    // ここが崩れると、古い観測点リストと新しい震度が位置対応で結び付き、座標と震度が
    // 誤ペアリングされたまま地図に出る（型エラーにも例外にもならない）。
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    const observed: { dataTime: string; indicesKey: string | null }[] = []
    renderHook(() => {
      const r = useKyoshinRealtime(true)
      observed.push({ dataTime: r.dataTime, indicesKey: r.indicesSiteConfigId })
      return r
    })

    const first = frameAt(NOW - 2000, { sitesKey: 'cfg-a' })
    const second = frameAt(NOW - 1000, { sitesKey: 'cfg-b' })
    await act(async () => { fake.emit(first) })
    await act(async () => { fake.emit(second) })

    // 観測されたすべてのレンダーで、両者が同じフレームに由来していること
    const keyOf = (dataTime: string) =>
      dataTime === first.dataTime ? 'cfg-a' : dataTime === second.dataTime ? 'cfg-b' : null
    for (const o of observed) {
      if (o.dataTime === '') continue // 初回レンダー（未受信）
      expect(o.indicesKey).toBe(keyOf(o.dataTime))
    }
  })

  it('観測点集合が変わらないうちは観測点リストを取り直さない', async () => {
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    renderHook(() => useKyoshinRealtime(true))

    await act(async () => { fake.emit(frameAt(NOW - 3000)) })
    await act(async () => { fake.emit(frameAt(NOW - 2000)) })
    await act(async () => { fake.emit(frameAt(NOW - 1000)) })

    expect(fake.resolveSites).toHaveBeenCalledTimes(1)
    expect(fake.resolveSites).toHaveBeenCalledWith('cfg-a')
  })

  it('観測点集合が変わったら観測点リストを取り直す', async () => {
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    const { result } = renderHook(() => useKyoshinRealtime(true))

    await act(async () => { fake.emit(frameAt(NOW - 2000, { sitesKey: 'cfg-a' })) })
    fake.resolveSites.mockResolvedValue(OSAKA)
    await act(async () => { fake.emit(frameAt(NOW - 1000, { sitesKey: 'cfg-b' })) })

    expect(fake.resolveSites).toHaveBeenCalledTimes(2)
    expect(result.current.sites).toEqual(OSAKA)
    expect(result.current.sitesSiteConfigId).toBe('cfg-b')
  })

  it('観測点リストの取得に失敗したら座標を据え置き、次のフレームで再試行する', async () => {
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    fake.resolveSites.mockRejectedValueOnce(new Error('503'))
    const { result } = renderHook(() => useKyoshinRealtime(true))

    await act(async () => { fake.emit(frameAt(NOW - 2000)) })
    // 失敗したので座標は空のまま。ここで識別子まで進めてしまうと、次のフレームで
    // 再試行されず、旧い座標と新しい震度が組み合わされ続ける。
    expect(result.current.sites).toEqual([])
    expect(result.current.sitesSiteConfigId).toBeNull()

    fake.resolveSites.mockResolvedValue(TOKYO)
    await act(async () => { fake.emit(frameAt(NOW - 1000)) })

    expect(fake.resolveSites).toHaveBeenCalledTimes(2)
    expect(result.current.sites).toEqual(TOKYO)
  })

  it('更新停止の通知がエラー状態に伝わる', async () => {
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    const { result } = renderHook(() => useKyoshinRealtime(true))

    expect(result.current.error).toBe(false)
    await act(async () => { fake.setStalled(true) })
    expect(result.current.error).toBe(true)
    await act(async () => { fake.setStalled(false) })
    expect(result.current.error).toBe(false)
  })

  it('データ時刻が未来のフレームは、時刻が到来してから反映される', async () => {
    // まとめて投入されるアーカイブ（K-NET 等）を時刻に沿って流すための下地。
    // これが効かないと、投入した瞬間に最後のフレームだけが反映されて再生にならない。
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    const { result } = renderHook(() => useKyoshinRealtime(true))

    const soon = frameAt(NOW + 500, { indices: [11] })
    const later = frameAt(NOW + 1500, { indices: [12] })
    await act(async () => { fake.emit(soon); fake.emit(later) })

    // まだどちらの時刻も来ていない
    expect(result.current.dataTime).toBe('')

    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(result.current.indices).toEqual([11])

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(result.current.indices).toEqual([12])
  })

  it('データ時刻が巻き戻ったフレームは反映しない', async () => {
    // 供給元は時計の後退をまたぐと古いデータ時刻のフレームを積みうる。そのまま反映すると
    // 表示が巻き戻り、検知エンジンにも後退したデータ時刻が渡る。
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    const { result } = renderHook(() => useKyoshinRealtime(true))

    const newer = frameAt(NOW - 1000, { indices: [9] })
    await act(async () => { fake.emit(newer) })
    expect(result.current.indices).toEqual([9])

    await act(async () => { fake.emit(frameAt(NOW - 5000, { indices: [1] })) })
    expect(result.current.indices).toEqual([9])
    expect(result.current.dataTime).toBe(newer.dataTime)
  })

  it('hypoInfo に現れた緊急地震速報を通知する', async () => {
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    const onEEWEvent = vi.fn()
    renderHook(() => useKyoshinRealtime(true, { onEEWEvent }))

    await act(async () => { fake.emit(frameAt(NOW - 2000, { hypoInfo: [] })) })
    expect(onEEWEvent).not.toHaveBeenCalled()

    await act(async () => {
      fake.emit(frameAt(NOW - 1000, { hypoInfo: [hypoItem('report-1', '1')] }))
    })
    expect(onEEWEvent).toHaveBeenCalledTimes(1)
    expect(onEEWEvent.mock.calls[0][0]).toMatchObject({
      kind: 'eew',
      issue: { eventId: 'report-1', serial: '1' },
    })
  })

  it('1 件目の通知が例外を投げても、同じフレームの残りの速報を配信する', async () => {
    // 1 つのフレームで「新規発報」と「別の速報の解除」が同時に起きる。ここで打ち切ると、
    // 差分の基準は進んでいるため未配信の速報が恒久的に失われる（警報が鳴らない）。
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    const received: string[] = []
    const onEEWEvent = vi.fn((eew: EEWAlert) => {
      const id = eew.issue?.eventId ?? ''
      received.push(id)
      if (received.length === 1) throw new Error('1 件目の通知でバグ')
    })
    renderHook(() => useKyoshinRealtime(true, { onEEWEvent }))

    await act(async () => {
      fake.emit(frameAt(NOW - 2000, {
        hypoInfo: [hypoItem('report-1', '1'), hypoItem('report-2', '1')],
      }))
    })

    expect(received).toEqual(['report-1', 'report-2'])
  })

  it('同じフレームで複数の通知が失敗したら、まとめて 1 行に記録する', async () => {
    // 1 件ずつ間引くと、同一フレーム内の 2 件目以降は時刻が動かないぶん間引かれて消える。
    // 配信自体は続くが、この失敗はログ以外に現れないため、消えると気付けない。
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    const onEEWEvent = vi.fn(() => { throw new Error('通知側のバグ') })
    renderHook(() => useKyoshinRealtime(true, { onEEWEvent }))

    await act(async () => {
      fake.emit(frameAt(NOW - 2000, {
        hypoInfo: [hypoItem('report-1', '1'), hypoItem('report-2', '1')],
      }))
    })

    expect(onEEWEvent).toHaveBeenCalledTimes(2)
    const errors = vi.mocked(log.error).mock.calls.filter(c => String(c[0]).includes('通知中に例外'))
    expect(errors).toHaveLength(1)
    expect(String(errors[0][0])).toContain('2 件')
    // どの速報で失敗したかを追えること
    expect(JSON.stringify(errors[0][1])).toContain('report-2')
  })

  it('通知の途中で例外が出ても、次のフレームで同じ速報を再送しない', async () => {
    // 差分の基準を進めずに抜けると、同じ発報が毎フレーム再送され、音と通知が二重に出る。
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    const received: EEWAlert[] = []
    const onEEWEvent = vi.fn((eew: EEWAlert) => {
      received.push(eew)
      throw new Error('通知側のバグ')
    })
    renderHook(() => useKyoshinRealtime(true, { onEEWEvent }))

    const hypoInfo = [hypoItem('report-1', '1')]
    await act(async () => { fake.emit(frameAt(NOW - 2000, { hypoInfo })) })
    await act(async () => { fake.emit(frameAt(NOW - 1000, { hypoInfo })) })

    expect(received).toHaveLength(1)
  })

  it('時刻オフセットを渡すとアーカイブの供給元を使い、null ならライブを使う', () => {
    const live = createFakeSource()
    const archive = createFakeSource()
    liveMock.mockReturnValue(live.source)
    archiveMock.mockReturnValue(archive.source)

    const { unmount } = renderHook(() => useKyoshinRealtime(true, { timeOffset: -3600_000 }))
    expect(archiveMock).toHaveBeenCalledWith(-3600_000)
    expect(liveMock).not.toHaveBeenCalled()
    unmount()

    renderHook(() => useKyoshinRealtime(true, { timeOffset: null }))
    expect(liveMock).toHaveBeenCalledTimes(1)
  })

  it('時刻オフセットが変わったら供給元を差し替える', () => {
    const live = createFakeSource()
    const archive = createFakeSource()
    liveMock.mockReturnValue(live.source)
    archiveMock.mockReturnValue(archive.source)

    const { rerender } = renderHook(
      ({ offset }: { offset: number | null }) => useKyoshinRealtime(true, { timeOffset: offset }),
      { initialProps: { offset: null as number | null } },
    )
    expect(live.source.start).toHaveBeenCalledTimes(1)

    rerender({ offset: -3600_000 })
    expect(live.stop).toHaveBeenCalledTimes(1)
    expect(archive.source.start).toHaveBeenCalledTimes(1)
  })

  it('アンマウントで供給元を止める', () => {
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    const { unmount } = renderHook(() => useKyoshinRealtime(true))

    expect(fake.source.start).toHaveBeenCalledTimes(1)
    unmount()
    expect(fake.stop).toHaveBeenCalledTimes(1)
  })

  it('観測点リストの取得が失敗し続けたら、間引きつつ警告を出し続ける', async () => {
    // この失敗は「更新停止」の表示に出ないため、ログが唯一の観測手段になる。一度きりに
    // 絞ると、継続している障害が「一度失敗して直った」ように見えてしまう。
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    fake.resolveSites.mockRejectedValue(new Error('503'))
    renderHook(() => useKyoshinRealtime(true))

    const warnsFor = (key: string) =>
      vi.mocked(log.warn).mock.calls.filter(c => String(c[0]).includes(key)).length

    await act(async () => { fake.emit(frameAt(NOW - 5000)) })
    expect(warnsFor('観測点リスト')).toBe(1)

    // 間隔内の再失敗は間引かれる
    await act(async () => { fake.emit(frameAt(NOW - 4000)) })
    await act(async () => { fake.emit(frameAt(NOW - 3000)) })
    expect(warnsFor('観測点リスト')).toBe(1)

    // 間隔を越えたら、継続していることが分かるよう再度出す
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    await act(async () => { fake.emit(frameAt(NOW + 60_000)) })
    expect(warnsFor('観測点リスト')).toBe(2)
  })

  it('無効のときは供給元を起動しない', () => {
    const fake = createFakeSource()
    liveMock.mockReturnValue(fake.source)
    renderHook(() => useKyoshinRealtime(false))

    expect(liveMock).not.toHaveBeenCalled()
    expect(fake.source.start).not.toHaveBeenCalled()
  })
})
