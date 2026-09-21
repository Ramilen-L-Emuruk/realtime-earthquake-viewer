import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createYahooLiveSource,
  createYahooArchiveSource,
  FETCH_OFFSET_MS,
  POLL_MS,
  REALTIME_MAX_RETRY_COUNT,
  REPLAY_LEAD_MS,
  REPLAY_MAX_ATTEMPTS_PER_TARGET,
  REPLAY_MAX_CONSECUTIVE_GIVEUPS,
  REPLAY_PREFETCH_CONCURRENCY,
  REPLAY_PROBE_BASE_MS,
  REPLAY_PUMP_INTERVAL_MS,
  replayProbeDelayMs,
  replayRetryDelayMs,
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

/**
 * これまでに要求されたデータ時刻（epoch ms）の一覧。
 *
 * リプレイは複数の秒を並列で取りに行くので、直近 1 件では何を取ったか読めない。
 */
function requestedMsList(): number[] {
  return fetchMock.mock.calls.map((c) => c[0].getTime())
}

describe('Yahoo 強震モニタソース', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
    fetchMock.mockReset()
    siteListMock.mockReset()
    // **既定で Promise を返させる。** 素の `vi.fn()` は `undefined` を返すので、観測点リストの
    // 先読み（`warmSiteList`）が `.then` で同期的に投げる。実運用の `fetchSiteList` は必ず
    // Promise を返すため、その形に揃える（投げても本筋が止まらないことは専用のテストで見る）。
    siteListMock.mockResolvedValue([])
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

    // 安全弁: **更新停止の通知が投げても、ポーリングは止まらない。** 素で
    // `sink.setStalled(true)` を呼んでいた頃は、例外が `.catch` の外へ抜けて**次の取得を
    // 仕込む前に処理が終わり、ポーリングが無音で永久停止した**（成功側だけ囲ってあって、
    // いちばん被害の大きいこちらが漏れていた）。
    it('安全弁: 更新停止の通知が投げても、ポーリングは続く', async () => {
      fetchMock.mockRejectedValue(new Error('offline'))
      const sink = {
        ...createSink(),
        setStalled: () => { throw new Error('消費側が壊れている') },
      }
      const source = createYahooLiveSource()
      source.start(sink)
      // 更新停止を通知する時点を跨ぐまで進める
      await vi.advanceTimersByTimeAsync(STALLED_AFTER_MS + RETRY_MS * 4)
      const callsAfterStalled = fetchMock.mock.calls.length
      // 間隔が伸びた分を見込んで待つ（通知で止まっていればここから 1 件も増えない）
      await vi.advanceTimersByTimeAsync(STALLED_RETRY_MAX_MS * 2)
      source.stop()

      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterStalled)
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
    /** 再生開始時の再生時刻（＝最初に取りに行く秒）。 */
    const START = NOW + OFFSET
    /** そのデータ時刻を何回要求したか。 */
    const countRequests = (ms: number) => requestedMsList().filter((t) => t === ms).length

    it('オフセットを適用したデータ時刻から始める', () => {
      fetchMock.mockResolvedValue(response())
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())

      expect(requestedMsList()[0]).toBe(START)
      source.stop()
    })

    // 正: リプレイは未来（＝過去の秒ファイル）を先に取れる。取得の往復のばらつきを再生から
    // 切り離すため、再生時刻より先の秒まで取りに行く（その場で取っていた頃は、往復時間が
    // そのまま画面の更新間隔になっていた）。
    it('正: 再生時刻より先の秒を先に取りに行く', async () => {
      fetchMock.mockResolvedValue(response())
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      await vi.advanceTimersByTimeAsync(0)
      source.stop()

      expect(Math.max(...requestedMsList())).toBe(START + REPLAY_LEAD_MS)
    })

    // 対照: 地平線より先は取りに行かない（再生を止めたときに無駄になる量を限る）。
    it('対照: 地平線より先の秒は取りに行かない', async () => {
      fetchMock.mockResolvedValue(response())
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      await vi.advanceTimersByTimeAsync(3 * POLL_MS)
      source.stop()

      // 再生時刻が 3 秒進んだぶんは地平線も伸びる。それより先は無い。
      expect(Math.max(...requestedMsList())).toBe(START + 3 * POLL_MS + REPLAY_LEAD_MS)
    })

    // 安全弁: 取りに行く秒が 1 秒の格子から外れると、放出が 1 秒ごとにならない。
    it('安全弁: 取りに行く秒は 1 秒刻みを崩さない', async () => {
      fetchMock.mockResolvedValue(response())
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      await vi.advanceTimersByTimeAsync(5 * POLL_MS)
      source.stop()

      for (const ms of requestedMsList()) expect((ms - START) % POLL_MS).toBe(0)
    })

    // 安全弁: 応答が返らないあいだに地平線ぶんを一斉に投げると、配信元へ瞬間的な負荷を掛ける。
    it('安全弁: 同時に取りに行く秒は上限を超えない', async () => {
      let pending = 0
      let peak = 0
      fetchMock.mockImplementation(() => new Promise((resolve) => {
        pending++
        peak = Math.max(peak, pending)
        setTimeout(() => {
          pending--
          resolve(response())
        }, 500)
      }))
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      await vi.advanceTimersByTimeAsync(3 * POLL_MS)
      source.stop()

      expect(peak).toBe(REPLAY_PREFETCH_CONCURRENCY)
    })

    // 正・対照: 失敗した秒は間隔を空けて試し直し、その間隔は試行のたびに伸びる
    // （→ `replayRetryDelayMs`）。地平線のぶん猶予があるので、その場で 200ms 間隔に
    // 5 回続けて叩いていた頃より時間的に分散する。
    it('正: 失敗した秒を、伸びていく間隔で試し直す', async () => {
      fetchMock.mockRejectedValue(new Error('missing'))
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      const countAfter = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms)
        return countRequests(START)
      }

      expect(await countAfter(0)).toBe(1)
      // 1 回目の試し直しの間隔（200ms）は巡回の手前で明けるので、最初の巡回で拾う
      expect(replayRetryDelayMs(1)).toBeLessThanOrEqual(REPLAY_PUMP_INTERVAL_MS)
      expect(await countAfter(REPLAY_PUMP_INTERVAL_MS)).toBe(2)
      // 2 回目の間隔（400ms）は巡回 1 回では明けない
      expect(await countAfter(REPLAY_PUMP_INTERVAL_MS)).toBe(2)
      expect(await countAfter(REPLAY_PUMP_INTERVAL_MS)).toBe(3)
      source.stop()
    })

    // 安全弁: 1 つの秒に張り付かない（Yahoo に元から無い秒は諦めて先へ進む）。
    it('安全弁: 試行回数の上限に達したらその秒を諦める', async () => {
      fetchMock.mockRejectedValue(new Error('missing'))
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      await vi.advanceTimersByTimeAsync(30_000)
      source.stop()

      expect(countRequests(START)).toBeLessThanOrEqual(REPLAY_MAX_ATTEMPTS_PER_TARGET)
    })

    // 対照: 短い欠損では更新停止を通知しない（アーカイブに元から無い秒は普通にある）。
    it('対照: 諦めた秒が上限に届かないうちは更新停止を通知しない', async () => {
      fetchMock.mockImplementation(async (target: Date) => {
        // 先頭の数秒だけ落として、以降は取れる状況
        if (target.getTime() < START + 3 * POLL_MS) throw new Error('missing')
        return response()
      })
      const sink = createSink()
      const source = createYahooArchiveSource(OFFSET)
      source.start(sink)
      await vi.advanceTimersByTimeAsync(30_000)
      source.stop()

      expect(sink.stalled).not.toContain(true)
      expect(sink.frames.length).toBeGreaterThan(0)
    })

    // 正: 観測点集合の版が変わったら、放出より前に観測点リストを引いておく。消費側が引くのは
    // フレームを画面へ反映する時点なので、そのままだと往復のあいだ下流の検知が止まる。
    it('正: 観測点リストを先に引いておく', async () => {
      fetchMock.mockResolvedValue(response({ siteConfigId: 'cfg-next' }))
      siteListMock.mockResolvedValue([])
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      await vi.advanceTimersByTimeAsync(0)
      source.stop()

      expect(siteListMock).toHaveBeenCalledWith('cfg-next')
    })

    // 対照: 版が変わらないあいだは引き直さない（フレームごとに投げない）。
    it('対照: 版が変わらなければ観測点リストを引き直さない', async () => {
      fetchMock.mockResolvedValue(response())
      siteListMock.mockResolvedValue([])
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      await vi.advanceTimersByTimeAsync(3 * POLL_MS)
      source.stop()

      expect(siteListMock).toHaveBeenCalledTimes(1)
    })

    // 正: **地平線の中で失敗した秒は、後ろの秒が先に取れても試し直す。**
    //
    // 打ち切りを「より新しい秒を渡したか」だけで判定していた頃は、先読みが常に後ろの秒を
    // 取っているせいでその値がほぼ常に前進し、**失敗した秒が最初の試し直し（200ms）を
    // 待つあいだに打ち切られていた** —— 4 回の猶予を 1 度も使わない。先読みで直したかった
    // 「一過性の失敗で秒が飛ぶ」が、いちばん起きやすい単発の失敗にだけ効かない形で残っていた。
    it('正: 地平線の中で失敗した秒は、後ろの秒が先に取れても試し直す', async () => {
      const target = START + 5 * POLL_MS
      fetchMock.mockImplementation(async (at: Date) => {
        if (at.getTime() === target) throw new Error('missing')
        return response()
      })
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      // 再生時刻がその秒へ到達する手前まで進める（＝打ち切りの条件をまだ満たさない）
      await vi.advanceTimersByTimeAsync(4 * POLL_MS)
      source.stop()

      expect(countRequests(target)).toBe(REPLAY_MAX_ATTEMPTS_PER_TARGET)
    })

    // 対照: 再生時刻が追い越し、かつより新しい秒を渡してあれば、そこで打ち切る
    //（取れても消費側が巻き戻りとして捨てるので、試し直す意味がない）。
    it('対照: 再生時刻が過ぎた秒は試し直しを打ち切る', async () => {
      const target = START + POLL_MS
      fetchMock.mockImplementation(async (at: Date) => {
        if (at.getTime() === target) throw new Error('missing')
        return response()
      })
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      await vi.advanceTimersByTimeAsync(2 * POLL_MS)
      const afterPassed = countRequests(target)
      // 打ち切られているので、ここから先はいくら待っても増えない
      await vi.advanceTimersByTimeAsync(10 * POLL_MS)
      source.stop()

      expect(countRequests(target)).toBe(afterPassed)
    })

    // 安全弁: 観測点リストの先読みは**脇の処理**。ここが投げてフレームの受け渡しや次の計画が
    // 止まると、そのセッションの取得が丸ごと沈黙する（実際にそうなった）。
    //
    // **見るのは 1 件目のフレームそのもの。** 「3 秒で 3 件以上」では弱い —— 先読みは版が
    // 同じなら 2 回目から早期 return するので、**1 件目だけ落ちても後続で数が揃ってしまう**。
    //
    // 実装側の守りは 2 つ重ねてある（先読みを本筋の**後**に呼ぶ・先読みを try で囲む）。
    // **このテストが落ちるのは両方を外したときだけ**で、片方が残っていれば通る。片方ずつでも
    // フレームは守れるので、これは意図した重ね掛け。
    it('安全弁: 観測点リストの先読みが投げても、1 件目からフレームは渡る', async () => {
      fetchMock.mockResolvedValue(response())
      // Promise を返さない状況（`.then` が同期で投げる）を作る
      siteListMock.mockReturnValue(undefined as unknown as Promise<[number, number][]>)
      const sink = createSink()
      const source = createYahooArchiveSource(OFFSET)
      source.start(sink)
      await vi.advanceTimersByTimeAsync(0)
      source.stop()

      expect(sink.frames.length).toBeGreaterThan(0)
      expect(sink.frames[0]?.time).toEqual(new Date(START))
    })

    // 安全弁: 先読みが失敗したまま「もう引いた」印を立てると、版はまれにしか変わらないので
    // **そのセッションでは二度と引き直さない**（先読みが永久に効かなくなる）。
    it('安全弁: 観測点リストの先読みに失敗したら、次のフレームで引き直す', async () => {
      fetchMock.mockResolvedValue(response())
      siteListMock.mockRejectedValue(new Error('offline'))
      const source = createYahooArchiveSource(OFFSET)
      source.start(createSink())
      await vi.advanceTimersByTimeAsync(3 * POLL_MS)
      source.stop()

      expect(siteListMock.mock.calls.length).toBeGreaterThan(1)
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
      siteListMock.mockResolvedValue([])
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
      siteListMock.mockResolvedValue([])
      clockSyncMock.mockReset()
      clockSyncMock.mockReturnValue(() => {})
      setReplayOffset(OFFSET)
    })
    afterEach(() => {
      vi.useRealTimers()
      setReplayOffset(null)
    })

    // 正: データが 1 件も無い時間帯では、秒をまたいだ総量も抑える。
    // `REPLAY_MAX_ATTEMPTS_PER_TARGET` は 1 つの秒あたりしか抑えないので、これが無いと
    // 地平線に居る秒がそれぞれ再試行し続ける。
    it('正: 続けて諦めた秒が上限に達したら間隔を空ける', async () => {
      fetchMock.mockRejectedValue(new Error('missing'))
      const sink = createSink()
      const source = createYahooArchiveSource(OFFSET)
      source.start(sink)

      await vi.advanceTimersByTimeAsync(300_000)
      source.stop()

      // 間隔を空けなければ、毎秒 1 件の新しい秒がそれぞれ
      // REPLAY_MAX_ATTEMPTS_PER_TARGET 回試すので 5 分で 1200 回になる
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

    // 対照: 1 件でも取れたら数え直す（欠損が散らばっている時間帯で止めない）。
    it('対照: 途中で 1 件でも取れたら止めない', async () => {
      // 1 秒おきに落ちる状況。諦めは続かないので探りへ移らない
      fetchMock.mockImplementation(async (target: Date) => {
        if (Math.round((target.getTime() - (NOW + OFFSET)) / POLL_MS) % 2 === 0) throw new Error('missing')
        return response()
      })
      const sink = createSink()
      const source = createYahooArchiveSource(OFFSET)
      source.start(sink)

      await vi.advanceTimersByTimeAsync(60_000)
      source.stop()

      expect(sink.stalled).not.toContain(true)
      // 取れる秒はすべて渡っている（60 秒ぶんの半分）
      expect(sink.frames.length).toBeGreaterThan(20)
    })
  })

  describe('replayRetryDelayMs', () => {
    it('正: 試行のたびに倍々に伸びる', () => {
      expect(replayRetryDelayMs(1)).toBe(RETRY_MS)
      expect(replayRetryDelayMs(2)).toBe(RETRY_MS * 2)
      expect(replayRetryDelayMs(3)).toBe(RETRY_MS * 4)
    })

    it('安全弁: 地平線の中で試行回数を使い切れる幅に収まる', () => {
      // 上限が地平線に近づくと、再生時刻に追い越されて試行回数を使わないまま諦める
      let total = 0
      for (let i = 1; i < REPLAY_MAX_ATTEMPTS_PER_TARGET; i++) total += replayRetryDelayMs(i)
      expect(total).toBeLessThan(REPLAY_LEAD_MS)
    })

    it('対照: 1 回目の間隔は巡回の周期を超えない（最初の巡回で拾える）', () => {
      expect(replayRetryDelayMs(1)).toBeLessThanOrEqual(REPLAY_PUMP_INTERVAL_MS)
    })
  })

  describe('replayProbeDelayMs', () => {
    it('正: 探りの回数で倍々に伸びる', () => {
      expect(replayProbeDelayMs(0)).toBe(REPLAY_PROBE_BASE_MS)
      expect(replayProbeDelayMs(1)).toBe(REPLAY_PROBE_BASE_MS * 2)
      expect(replayProbeDelayMs(2)).toBe(REPLAY_PROBE_BASE_MS * 4)
    })

    it('安全弁: 上限で頭打ちになる', () => {
      expect(replayProbeDelayMs(99)).toBe(STALLED_RETRY_MAX_MS)
    })

    // 対照: **ライブ経路の尺度を流用してはいけない。** 探りへ移る時点で先読みの失敗
    // （並列 3 本ぶんの合算）は 40 前後まで積まれている。その値をライブ用の
    // `stalledRetryDelayMs` へ渡すと初回の探りから上限へ飽和し、倍々に伸ばす意図が
    // 一度も効かない。
    it('対照: 先読みの失敗数をライブの尺度へ渡すと初回から飽和する', () => {
      const failuresWhenProbingStarts = REPLAY_MAX_CONSECUTIVE_GIVEUPS * REPLAY_MAX_ATTEMPTS_PER_TARGET
      expect(stalledRetryDelayMs(failuresWhenProbingStarts)).toBe(STALLED_RETRY_MAX_MS)
      expect(replayProbeDelayMs(0)).toBeLessThan(STALLED_RETRY_MAX_MS)
    })
  })
})
