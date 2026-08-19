import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createYahooLiveSource,
  createYahooArchiveSource,
  ERROR_THRESHOLD,
  FETCH_OFFSET_MS,
  POLL_MS,
  REALTIME_MAX_RETRY_COUNT,
  REPLAY_MAX_RETRY_COUNT,
  RETRY_MS,
  type KyoshinFrame,
} from './kyoshinSource'
import { fetchRealtimeIntensity, fetchSiteList, startClockSync } from './kyoshin'
import type { RealtimeIntensity } from './kyoshin'
import { setReplayOffset } from '../utils/clock'

// 取得そのものではなくスケジューリング（いつ・どのデータ時刻を取りに行くか、何回で諦めるか）を
// 検証するため、通信層はモジュール単位でモックする。
vi.mock('./kyoshin', () => ({
  fetchRealtimeIntensity: vi.fn(),
  fetchSiteList: vi.fn(),
  startClockSync: vi.fn(),
}))

const NOW = new Date('2026-08-19T12:00:00+09:00').getTime()

const fetchMock = vi.mocked(fetchRealtimeIntensity)
const siteListMock = vi.mocked(fetchSiteList)
const clockSyncMock = vi.mocked(startClockSync)

function response(overrides?: Partial<RealtimeIntensity>): RealtimeIntensity {
  return {
    dataTime: '2026/08/19 11:59:58',
    siteConfigId: 'cfg-2026',
    indices: [3, 4, 5],
    hypoInfo: [],
    ...overrides,
  }
}

function createSink() {
  const frames: KyoshinFrame[] = []
  const stalled: boolean[] = []
  return {
    frames,
    stalled,
    enqueue: (frame: KyoshinFrame) => frames.push(frame),
    setStalled: (s: boolean) => stalled.push(s),
  }
}

/** 直近の取得要求のデータ時刻（epoch ms）。 */
function lastRequestedMs(): number {
  const calls = fetchMock.mock.calls
  return calls[calls.length - 1][0].getTime()
}

describe('Yahoo 強震モニタソース', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
    fetchMock.mockReset()
    siteListMock.mockReset()
    clockSyncMock.mockReset()
    clockSyncMock.mockReturnValue(() => {})
    // clock はモジュール状態を持つため、テスト間でライブ（オフセット無し）に戻す。
    setReplayOffset(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  describe('ライブ', () => {
    it('現在時刻から FETCH_OFFSET_MS だけ過去のデータ時刻を最初に取りに行く', async () => {
      fetchMock.mockResolvedValue(response())
      const sink = createSink()
      const source = createYahooLiveSource()
      source.start(sink)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(lastRequestedMs()).toBe(NOW - FETCH_OFFSET_MS)
      source.stop()
    })

    it('取得したフレームを渡す（データ時刻は要求した時刻・応答の中身をそのまま載せる）', async () => {
      fetchMock.mockResolvedValue(response())
      const sink = createSink()
      const source = createYahooLiveSource()
      source.start(sink)
      await vi.advanceTimersByTimeAsync(0)

      expect(sink.frames).toHaveLength(1)
      expect(sink.frames[0]).toMatchObject({
        time: new Date(NOW - FETCH_OFFSET_MS),
        dataTime: '2026/08/19 11:59:58',
        sitesKey: 'cfg-2026',
        indices: [3, 4, 5],
        hypoInfo: [],
      })
      source.stop()
    })

    it('成功したら POLL_MS 後に次のデータ時刻を取りに行く', async () => {
      fetchMock.mockResolvedValue(response())
      const sink = createSink()
      const source = createYahooLiveSource()
      source.start(sink)
      await vi.advanceTimersByTimeAsync(POLL_MS)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(lastRequestedMs()).toBe(NOW - FETCH_OFFSET_MS + POLL_MS)
      source.stop()
    })

    it('発火が遅れたら最新のデータ時刻へ再アンカーして遅れを溜めない', async () => {
      fetchMock.mockResolvedValue(response())
      const sink = createSink()
      const source = createYahooLiveSource()
      source.start(sink)
      // 1 回目の応答を処理させたうえで、次の発火まで大きく間を空ける（描画負荷等の再現）。
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(10_000)

      // 「前回 + POLL_MS」ではなく現在時刻基準（now - FETCH_OFFSET_MS）へ飛んでいる
      const elapsed = 10_000
      expect(lastRequestedMs()).toBe(NOW + elapsed - FETCH_OFFSET_MS)
      source.stop()
    })

    it('失敗したら同じデータ時刻を RETRY_MS 後に再試行する', async () => {
      fetchMock.mockRejectedValue(new Error('403'))
      const sink = createSink()
      const source = createYahooLiveSource()
      source.start(sink)
      await vi.advanceTimersByTimeAsync(RETRY_MS)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(lastRequestedMs()).toBe(NOW - FETCH_OFFSET_MS)
      expect(sink.frames).toHaveLength(0)
      source.stop()
    })

    it('ERROR_THRESHOLD 回続けて失敗したら更新停止を通知し、回復したら解除する', async () => {
      fetchMock.mockRejectedValue(new Error('offline'))
      const sink = createSink()
      const source = createYahooLiveSource()
      source.start(sink)

      // 失敗の数え方は「同一データ時刻への再試行はまとめて 1 回」。データ時刻が進むのは
      // 再試行の上限に達して現在時刻へリセットしたときだけなので、閾値に届くまでには
      // 「REALTIME_MAX_RETRY_COUNT 回の再試行」を ERROR_THRESHOLD - 1 サイクル繰り返す必要がある。
      // ＝ 失敗が始まってから更新停止が出るまで 20 秒ほどかかる（従来からの挙動）。
      const fetchesToThreshold = REALTIME_MAX_RETRY_COUNT * (ERROR_THRESHOLD - 1) + 1
      expect(fetchMock).toHaveBeenCalledTimes(1)
      while (fetchMock.mock.calls.length < fetchesToThreshold) {
        expect(sink.stalled).not.toContain(true)
        await vi.advanceTimersByTimeAsync(RETRY_MS)
      }
      expect(fetchMock).toHaveBeenCalledTimes(fetchesToThreshold)
      expect(sink.stalled).toContain(true)

      fetchMock.mockResolvedValue(response())
      await vi.advanceTimersByTimeAsync(RETRY_MS)
      expect(sink.stalled[sink.stalled.length - 1]).toBe(false)
      source.stop()
    })

    it('同じデータ時刻の失敗が REALTIME_MAX_RETRY_COUNT 回に達したら現在時刻ベースへ戻す', async () => {
      fetchMock.mockRejectedValue(new Error('permanent'))
      const sink = createSink()
      const source = createYahooLiveSource()
      source.start(sink)

      // 上限に達するまでは同じデータ時刻を叩き続ける
      for (let i = 0; i < REALTIME_MAX_RETRY_COUNT - 1; i++) {
        await vi.advanceTimersByTimeAsync(RETRY_MS)
        expect(lastRequestedMs()).toBe(NOW - FETCH_OFFSET_MS)
      }
      // 上限到達後の 1 回で現在時刻ベースへリセットされる
      await vi.advanceTimersByTimeAsync(RETRY_MS)
      const elapsedMs = REALTIME_MAX_RETRY_COUNT * RETRY_MS
      expect(lastRequestedMs()).toBe(NOW + elapsedMs - FETCH_OFFSET_MS)
      source.stop()
    })

    it('クロック同期を起動し、停止時に解除する', () => {
      fetchMock.mockResolvedValue(response())
      const stop = vi.fn()
      clockSyncMock.mockReturnValue(stop)
      const source = createYahooLiveSource()
      source.start(createSink())
      expect(clockSyncMock).toHaveBeenCalledTimes(1)

      source.stop()
      expect(stop).toHaveBeenCalledTimes(1)
    })
  })

  describe('リプレイ', () => {
    const OFFSET = -3600_000

    it('オフセットを適用したデータ時刻から始める', () => {
      fetchMock.mockResolvedValue(response())
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())

      expect(lastRequestedMs()).toBe(NOW + OFFSET)
      source.stop()
    })

    it('等速で 1 秒ずつ進む', async () => {
      fetchMock.mockResolvedValue(response())
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      await vi.advanceTimersByTimeAsync(POLL_MS)

      expect(lastRequestedMs()).toBe(NOW + OFFSET + POLL_MS)
      source.stop()
    })

    it('取得が遅れても再生時刻が壁時計から遅れない（絶対時刻で次を予定する）', async () => {
      // 1 件目の取得に POLL_MS の 8 割かかる状況を作る
      fetchMock.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(response()), POLL_MS * 0.8)),
      )
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      await vi.advanceTimersByTimeAsync(POLL_MS)

      // 2 件目は「開始から POLL_MS 後」に始まる（取得にかかった 0.8 秒ぶん後ろにずれない）
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(lastRequestedMs()).toBe(NOW + OFFSET + POLL_MS)
      source.stop()
    })

    it('同じデータ時刻の失敗が REPLAY_MAX_RETRY_COUNT 回に達したら次のデータ時刻へ進む', async () => {
      fetchMock.mockRejectedValue(new Error('missing'))
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())

      for (let i = 0; i < REPLAY_MAX_RETRY_COUNT - 1; i++) {
        await vi.advanceTimersByTimeAsync(RETRY_MS)
        expect(lastRequestedMs()).toBe(NOW + OFFSET)
      }
      await vi.advanceTimersByTimeAsync(RETRY_MS)
      expect(lastRequestedMs()).toBe(NOW + OFFSET + POLL_MS)
      source.stop()
    })

    it('失敗が続いても更新停止は通知しない（アーカイブの欠損はエラー表示の対象外）', async () => {
      fetchMock.mockRejectedValue(new Error('missing'))
      const sink = createSink()
      const source = createYahooArchiveSource(OFFSET)
      source.start(sink)

      for (let i = 0; i < REPLAY_MAX_RETRY_COUNT * 3; i++) {
        await vi.advanceTimersByTimeAsync(RETRY_MS)
      }
      expect(sink.stalled).not.toContain(true)
      source.stop()
    })

    it('クロック同期は起動しない（アーカイブの時刻を使うため）', () => {
      fetchMock.mockResolvedValue(response())
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())

      expect(clockSyncMock).not.toHaveBeenCalled()
      source.stop()
    })
  })

  describe('開始と停止', () => {
    it('二重に start しても 2 本目は起動しない', () => {
      fetchMock.mockResolvedValue(response())
      const source = createYahooLiveSource()
      source.start(createSink())
      source.start(createSink())

      expect(fetchMock).toHaveBeenCalledTimes(1)
      source.stop()
    })

    it('stop 後は次の取得を行わない', async () => {
      fetchMock.mockResolvedValue(response())
      const source = createYahooLiveSource()
      source.start(createSink())
      source.stop()
      await vi.advanceTimersByTimeAsync(POLL_MS * 5)

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('stop 後に到着した応答はフレームとして渡さない', async () => {
      // 応答を任意のタイミングで解決できるようにする（プロパティ経由なのは、ローカル変数だと
      // コールバック内の代入を型の絞り込みが追えず never になるため）。
      const pending: { resolve?: (v: RealtimeIntensity) => void } = {}
      fetchMock.mockImplementation(() => new Promise((resolve) => { pending.resolve = resolve }))
      const sink = createSink()
      const source = createYahooLiveSource()
      source.start(sink)

      source.stop()
      pending.resolve?.(response())
      await vi.advanceTimersByTimeAsync(0)

      expect(sink.frames).toHaveLength(0)
    })

    it('stop は何度呼んでもよい', () => {
      fetchMock.mockResolvedValue(response())
      const source = createYahooLiveSource()
      source.start(createSink())
      expect(() => {
        source.stop()
        source.stop()
      }).not.toThrow()
    })

    it('フレームの受け渡しで例外が出てもポーリングは継続する', async () => {
      fetchMock.mockResolvedValue(response())
      const source = createYahooLiveSource()
      source.start({
        enqueue: () => { throw new Error('下流のバグ') },
        setStalled: () => {},
      })
      await vi.advanceTimersByTimeAsync(POLL_MS)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      source.stop()
    })
  })

  describe('観測点リストの解決', () => {
    it('sitesKey を観測点リストの取得へ委譲する', async () => {
      const coords: [number, number][] = [[35.7, 139.7]]
      siteListMock.mockResolvedValue(coords)
      const source = createYahooLiveSource()

      await expect(source.resolveSites('cfg-2026')).resolves.toEqual(coords)
      expect(siteListMock).toHaveBeenCalledWith('cfg-2026')
    })
  })
})
