import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createYahooLiveSource,
  createYahooArchiveSource,
  FETCH_OFFSET_MS,
  POLL_MS,
  REALTIME_MAX_RETRY_COUNT,
  REPLAY_MAX_RETRY_COUNT,
  REPLAY_MAX_CONSECUTIVE_GIVEUPS,
  RETRY_MS,
  STALLED_AFTER_MS,
  STALLED_BACKOFF_AFTER_FAILURES,
  STALLED_RETRY_MAX_MS,
  stalledRetryDelayMs,
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

// このファイルの多くのテストは「通常の取得を何回投げたか」を数える。助走（開始より前の秒を
// まとめて取りに行く）が混ざると数が読めなくなるため、遡るブロック数を 0 にして止める。
// **助走そのものの振る舞いは kyoshinSource.warmup.test.ts で見る**（あちらはモックしない）。
vi.mock('../utils/kyoshinWarmup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/kyoshinWarmup')>()),
  WARMUP_MAX_BLOCKS: 0,
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
  /** 助走として渡された回ぶんのフレーム列（1 度しか呼ばれない契約を確かめるため配列で持つ）。 */
  const prefilled: KyoshinFrame[][] = []
  return {
    frames,
    stalled,
    prefilled,
    enqueue: (frame: KyoshinFrame) => frames.push(frame),
    setStalled: (s: boolean) => stalled.push(s),
    prefill: (fs: KyoshinFrame[]) => prefilled.push(fs),
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

    // **判定は経過時間で行う。** 回数で数えていた頃は「フレームを 5 つ諦めたら」で、
    // 閾値に届くまでに 101 リクエスト・約 20 秒を要していた。再試行の間隔が伸びる作りに
    // なった以上、回数で数えると**間隔が伸びたぶんだけ判定も遅れる**
    // （→ `rules/common/code-review.md`「指標・条件が本体からずれていないか」）。
    it('STALLED_AFTER_MS のあいだ失敗が続いたら更新停止を通知し、回復したら解除する', async () => {
      fetchMock.mockRejectedValue(new Error('offline'))
      const sink = createSink()
      const source = createYahooLiveSource()
      source.start(sink)

      // 手前では出さない（瞬断で「更新停止」を点滅させない）
      await vi.advanceTimersByTimeAsync(STALLED_AFTER_MS - RETRY_MS * 2)
      expect(sink.stalled).not.toContain(true)

      await vi.advanceTimersByTimeAsync(RETRY_MS * 4)
      expect(sink.stalled).toContain(true)

      // 復帰の確認は**間隔が伸びた分を見込んで待つ**（この時点で再試行は最大 10 秒間隔）
      fetchMock.mockResolvedValue(response())
      await vi.advanceTimersByTimeAsync(STALLED_RETRY_MAX_MS)
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
        prefill: () => {},
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

// **配信が止まっているあいだ毎秒 10 件を撃ち続けていた。** 1 フレームの取得はエッジ 2 つを
// 順に試すので最大 2 リクエストで、それを 200ms 間隔で再試行する作りだった
// （`ERROR_THRESHOLD` は画面へ「更新停止」を出すだけで、リクエストは減らなかった）。
// 2026-09-15 にリプレイの時刻を範囲外にしたとき、18 秒ほどで 177 件の 403 が出た。
describe('取得が失敗し続けたときの間隔と打ち切り', () => {
  describe('stalledRetryDelayMs', () => {
    // 対照: しきい値の手前では従来どおり。**一時的な取りこぼしの挙動は変えない** ——
    // ここを鈍らせると数百ミリ秒の瞬断で揺れの立ち上がりを取り落とす。
    it('対照: 1 フレームぶんの再試行を使い切るまでは RETRY_MS のまま', () => {
      expect(stalledRetryDelayMs(0)).toBe(RETRY_MS)
      expect(stalledRetryDelayMs(STALLED_BACKOFF_AFTER_FAILURES - 1)).toBe(RETRY_MS)
    })

    it('正: 使い切ったところから倍々に伸びる', () => {
      expect(stalledRetryDelayMs(STALLED_BACKOFF_AFTER_FAILURES)).toBe(RETRY_MS)
      expect(stalledRetryDelayMs(STALLED_BACKOFF_AFTER_FAILURES + 1)).toBe(RETRY_MS * 2)
      expect(stalledRetryDelayMs(STALLED_BACKOFF_AFTER_FAILURES + 3)).toBe(RETRY_MS * 8)
    })

    it('安全弁: 上限で頭打ちになる（復帰の検知が遅れすぎないように）', () => {
      expect(stalledRetryDelayMs(STALLED_BACKOFF_AFTER_FAILURES + 100)).toBe(STALLED_RETRY_MAX_MS)
    })
  })

  describe('ライブ', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: NOW })
      fetchMock.mockReset()
      siteListMock.mockReset()
      clockSyncMock.mockReset()
      clockSyncMock.mockReturnValue(() => {})
      setReplayOffset(null)
    })
    afterEach(() => {
      vi.useRealTimers()
      setReplayOffset(null)
    })

    // 正: 失敗が続いたら投げる回数が減る。**間隔を空けなければ 5 分で 1500 回**
    // （200ms ごと）になる。10 秒で頭打ちなので、5 分なら 25（最初のフレーム）＋ 30 件ほど。
    it('正: 失敗が続いたら投げる回数が減る', async () => {
      fetchMock.mockRejectedValue(new Error('unreachable'))
      const source = createYahooLiveSource()
      source.start(createSink())

      await vi.advanceTimersByTimeAsync(300_000)
      source.stop()

      expect(fetchMock.mock.calls.length).toBeLessThan(100)
    })

    // 対照: 1 フレームぶんの再試行（5 秒）までは従来どおりの間隔。
    // ここを鈍らせると、数百ミリ秒の瞬断で揺れの立ち上がりを取り落とす。
    it('対照: 最初の 1 フレームぶんは 200ms 間隔のまま', async () => {
      fetchMock.mockRejectedValue(new Error('unreachable'))
      const source = createYahooLiveSource()
      source.start(createSink())

      await vi.advanceTimersByTimeAsync(RETRY_MS * (STALLED_BACKOFF_AFTER_FAILURES - 1))
      source.stop()

      expect(fetchMock.mock.calls.length).toBe(STALLED_BACKOFF_AFTER_FAILURES)
    })

    // 安全弁: 復帰したら間隔が戻る（止まったまま鈍り続けない）。
    it('安全弁: 1 度でも取れたら間隔が戻る', async () => {
      fetchMock.mockRejectedValue(new Error('unreachable'))
      const source = createYahooLiveSource()
      source.start(createSink())
      // 上限（10 秒間隔）まで鈍らせる
      await vi.advanceTimersByTimeAsync(300_000)
      const whileStalled = fetchMock.mock.calls.length

      // 復帰させて、同じ 5 分でどれだけ投げるか見る（POLL_MS = 1 秒なので約 300 回）
      fetchMock.mockResolvedValue(response())
      await vi.advanceTimersByTimeAsync(300_000)
      source.stop()

      expect(fetchMock.mock.calls.length - whileStalled).toBeGreaterThan(whileStalled * 2)
    })
  })

  describe('リプレイ', () => {
    const OFFSET = -3600_000

    beforeEach(() => {
      vi.useFakeTimers({ now: NOW })
      fetchMock.mockReset()
      siteListMock.mockReset()
      clockSyncMock.mockReset()
      clockSyncMock.mockReturnValue(() => {})
      setReplayOffset(OFFSET)
    })
    afterEach(() => {
      vi.useRealTimers()
      setReplayOffset(null)
    })

    // 正: データが 1 件も無い時間帯では、フレームをまたいだ総量も抑える。
    // `REPLAY_MAX_RETRY_COUNT` は 1 フレームあたりしか抑えないので、これが無いと
    // 1 秒ごとに投げ続ける。
    it('正: 続けて諦めたフレームが上限に達したら間隔を空ける', async () => {
      fetchMock.mockRejectedValue(new Error('missing'))
      const sink = createSink()
      const source = createYahooArchiveSource(OFFSET)
      source.start(sink)

      await vi.advanceTimersByTimeAsync(300_000)
      source.stop()

      // 間隔を空けなければ毎秒 REPLAY_MAX_RETRY_COUNT 回＝5 分で 1500 回になる
      expect(fetchMock.mock.calls.length).toBeLessThan(150)
      expect(sink.stalled).toContain(true)
    })

    // **止めてはいけない。** 判定条件は「収録の無い時代を指定した」と「収録期間内での
    // 10 秒超の欠測」を区別できない。止める作りにしていた頃は、後者でも**そのリプレイ
    // セッションが終わるまで二度と取りに行かなかった**（復旧しても、その後に本震が来ても）。
    it('安全弁: 上限に達した後も、復旧したら取り直す', async () => {
      fetchMock.mockRejectedValue(new Error('missing'))
      const sink = createSink()
      const source = createYahooArchiveSource(OFFSET)
      source.start(sink)
      // 上限を十分に超えるまで失敗させる
      await vi.advanceTimersByTimeAsync(300_000)
      expect(sink.frames).toHaveLength(0)

      // 復旧させる。止める作りだとここから先は 1 フレームも取れない
      fetchMock.mockResolvedValue(response())
      await vi.advanceTimersByTimeAsync(60_000)
      source.stop()

      expect(sink.frames.length).toBeGreaterThan(0)
      expect(sink.stalled[sink.stalled.length - 1]).toBe(false)
    })

    // 対照: 1 フレームでも取れたら数え直す（欠損が散らばっている時間帯で止めない）。
    it('対照: 途中で 1 件でも取れたら止めない', async () => {
      let calls = 0
      fetchMock.mockImplementation(async () => {
        calls++
        // 諦めの上限より手前で 1 件だけ成功させる
        if (calls === REPLAY_MAX_RETRY_COUNT * 3) return response()
        throw new Error('missing')
      })
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())

      await vi.advanceTimersByTimeAsync(120_000)
      source.stop()

      // 数え直しが働いた結果、上限のぶんだけ余分に試せている
      expect(fetchMock.mock.calls.length).toBeGreaterThan(REPLAY_MAX_CONSECUTIVE_GIVEUPS * REPLAY_MAX_RETRY_COUNT)
    })
  })
})
