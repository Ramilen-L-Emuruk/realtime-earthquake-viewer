// Yahoo 強震モニタソースの「助走」のテスト。
//
// 通常の取得（いつ・どのデータ時刻を取りに行くか）は kyoshinSource.test.ts が見ている。
// **あちらは助走を止めてある**（取得の回数を数えるテストが多く、混ざると読めなくなるため）ので、
// 助走そのものはこちらで見る。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createYahooArchiveSource, createYahooLiveSource, type KyoshinFrame } from './kyoshinSource'
import { fetchRealtimeIntensity, fetchSiteList, startClockSync } from './kyoshin'
import type { RealtimeIntensity } from './kyoshin'
import { WARMUP_BLOCK_SEC, WARMUP_MAX_BLOCKS, WARMUP_QUIET_MAX_POINTS } from '../utils/kyoshinWarmup'
import { log } from '../utils/logger'

vi.mock('./kyoshin', () => ({
  fetchRealtimeIntensity: vi.fn(),
  fetchSiteList: vi.fn(),
  startClockSync: vi.fn(),
}))

// 助走の結果をどう記録するかが検証対象なので、ロガーだけ差し替える。
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const fetchMock = vi.mocked(fetchRealtimeIntensity)

/** 再生の基準時刻。リプレイなので `Date.now() + timeOffset` がこの値になるようにする。 */
const NOW = new Date('2026-08-19T12:00:00+09:00').getTime()
/** 再生したい時刻（現在から 1 日前）。 */
const TARGET = NOW - 24 * 3600_000

/** value = -3.0 + index * 0.5。index 7 = value 0.5（静穏の判定に使うしきい値）。 */
const SHAKING_INDICES = [...new Array<number>(WARMUP_QUIET_MAX_POINTS).fill(7), 0, 0]
const QUIET_INDICES = [0, 0, 0]

function createSink() {
  const frames: KyoshinFrame[] = []
  const prefilled: KyoshinFrame[][] = []
  return {
    frames,
    prefilled,
    enqueue: (f: KyoshinFrame) => frames.push(f),
    setStalled: () => {},
    prefill: (fs: KyoshinFrame[]) => prefilled.push(fs),
  }
}

/** 基準時刻から何秒さかのぼった要求か。 */
function agoSec(t: Date): number {
  return Math.round((TARGET - t.getTime()) / 1000)
}

function reply(t: Date, indices: number[]): RealtimeIntensity {
  return { dataTime: new Date(t).toISOString(), siteConfigId: 'cfg', indices, hypoInfo: [] }
}

describe('Yahoo 強震モニタソース: 助走', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    fetchMock.mockReset()
    vi.mocked(fetchSiteList).mockResolvedValue([])
    vi.mocked(startClockSync).mockReturnValue(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 助走の取得（Promise だけで進む）を流し切る。 */
  async function flush(): Promise<void> {
    for (let i = 0; i < WARMUP_MAX_BLOCKS + 2; i++) await vi.advanceTimersByTimeAsync(0)
  }

  it('正: 開始時刻より前の秒を遡って取り、時刻の昇順で 1 度だけ渡す', async () => {
    // 1 ブロック目は揺れていて、2 ブロック目は静穏。2 ブロック遡って打ち切る。
    fetchMock.mockImplementation(async (t: Date) =>
      reply(t, agoSec(t) <= WARMUP_BLOCK_SEC ? SHAKING_INDICES : QUIET_INDICES))
    const source = createYahooArchiveSource(TARGET - NOW)
    const sink = createSink()
    source.start(sink)
    await flush()

    expect(sink.prefilled).toHaveLength(1)
    const warmup = sink.prefilled[0]
    expect(warmup).toHaveLength(WARMUP_BLOCK_SEC * 2)
    // 昇順で、末尾は開始時刻の 1 秒前（開始時刻そのものは通常の取得が拾う）
    expect(agoSec(warmup[0].time)).toBe(WARMUP_BLOCK_SEC * 2)
    expect(agoSec(warmup[warmup.length - 1].time)).toBe(1)
    for (let i = 1; i < warmup.length; i++) {
      expect(warmup[i].time.getTime()).toBeGreaterThan(warmup[i - 1].time.getTime())
    }
    source.stop()
  })

  it('対照: 1 ブロック目が静穏ならそこで打ち切る（平常時に何分も遡らない）', async () => {
    fetchMock.mockImplementation(async (t: Date) => reply(t, QUIET_INDICES))
    const source = createYahooArchiveSource(TARGET - NOW)
    const sink = createSink()
    source.start(sink)
    await flush()

    expect(sink.prefilled[0]).toHaveLength(WARMUP_BLOCK_SEC)
    source.stop()
  })

  // 秒フレームの控え（`utils/kyoshinFrameCache`）を使うかどうかの配線。
  //
  // **この配線が壊れても、他のどのテストも落ちない。** 取り違えても「控えが効かない」
  // （または「ライブで当たらない控えを溜める」）だけで、画面にも記録にも出ない ——
  // しかも控えを入れた目的そのものが、区間ごとに開始し直したときの助走の取り直しを
  // 止めることなので、黙って失効すると意味が消える。
  it('正: 再生の助走は控えを使う（cache: true を渡す）', async () => {
    fetchMock.mockImplementation(async (t: Date) => reply(t, QUIET_INDICES))
    const source = createYahooArchiveSource(TARGET - NOW)
    source.start(createSink())
    await flush()

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    for (const [, opts] of fetchMock.mock.calls) expect(opts).toEqual({ cache: true })
    source.stop()
  })

  // **ライブは控えない。** 毎秒「新しい時刻」を取るので当たらず、控えるとメモリを使うだけ。
  it('対照: ライブの助走は控えを使わない（cache: false を渡す）', async () => {
    fetchMock.mockImplementation(async (t: Date) => reply(t, QUIET_INDICES))
    const source = createYahooLiveSource()
    source.start(createSink())
    await flush()

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    for (const [, opts] of fetchMock.mock.calls) expect(opts).toEqual({ cache: false })
    source.stop()
  })

  it('安全弁: 静穏に行き当たらなくても上限で止まる', async () => {
    fetchMock.mockImplementation(async (t: Date) => reply(t, SHAKING_INDICES))
    const source = createYahooArchiveSource(TARGET - NOW)
    const sink = createSink()
    source.start(sink)
    await flush()

    expect(sink.prefilled[0]).toHaveLength(WARMUP_BLOCK_SEC * WARMUP_MAX_BLOCKS)
    source.stop()
  })

  it('安全弁: 1 件も取れなくても空で必ず渡す（渡さないと検知が待ち続ける）', async () => {
    fetchMock.mockRejectedValue(new Error('取得できない'))
    const source = createYahooArchiveSource(TARGET - NOW)
    const sink = createSink()
    source.start(sink)
    await flush()

    expect(sink.prefilled).toHaveLength(1)
    expect(sink.prefilled[0]).toHaveLength(0)
    source.stop()
  })

  it('安全弁: 助走フレームに緊急地震速報の情報を載せない', async () => {
    // 載せると、開始より前に終わっていた速報が新規発報として鳴り直す。
    fetchMock.mockImplementation(async (t: Date) => ({
      ...reply(t, agoSec(t) <= WARMUP_BLOCK_SEC ? SHAKING_INDICES : QUIET_INDICES),
      hypoInfo: [{ reportId: 'x' }] as RealtimeIntensity['hypoInfo'],
    }))
    const source = createYahooArchiveSource(TARGET - NOW)
    const sink = createSink()
    source.start(sink)
    await flush()

    expect(sink.prefilled[0].every((f) => f.hypoInfo === undefined)).toBe(true)
    source.stop()
  })

  it('安全弁: 停止したあとは渡さない', async () => {
    fetchMock.mockImplementation(async (t: Date) => reply(t, SHAKING_INDICES))
    const source = createYahooArchiveSource(TARGET - NOW)
    const sink = createSink()
    source.start(sink)
    source.stop()
    await flush()

    expect(sink.prefilled).toHaveLength(0)
  })
})

describe('Yahoo 強震モニタソース: 助走の結果を記録する', () => {
  // 取得が全滅したときの戻り値は「1 ブロックで静穏に行き当たった」正常な最短打ち切りと
  // 同じ空配列で、画面からも挙動からも区別が付かない。助走が効いていないこと自体が
  // 症状として現れない（立ち上がりの検知が遅れるだけ）ので、記録が唯一の手がかりになる。
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    fetchMock.mockReset()
    vi.mocked(log.warn).mockClear()
    vi.mocked(log.info).mockClear()
    vi.mocked(fetchSiteList).mockResolvedValue([])
    vi.mocked(startClockSync).mockReturnValue(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function flush(): Promise<void> {
    for (let i = 0; i < WARMUP_MAX_BLOCKS + 2; i++) await vi.advanceTimersByTimeAsync(0)
  }

  it('正: 遡れたときは件数と打ち切りの理由を残す', async () => {
    fetchMock.mockImplementation(async (t: Date) => reply(t, QUIET_INDICES))
    const source = createYahooArchiveSource(TARGET - NOW)
    source.start(createSink())
    await flush()

    const line = vi.mocked(log.info).mock.calls.map((c) => String(c[0])).find((m) => m.includes('助走'))
    expect(line).toContain(`助走 ${WARMUP_BLOCK_SEC} フレーム`)
    expect(line).toContain('静穏まで遡った')
    source.stop()
  })

  it('対照: 1 件も使えなかったときは警告として残す（静穏で打ち切ったのと区別できる）', async () => {
    fetchMock.mockRejectedValue(new Error('取得できない'))
    const source = createYahooArchiveSource(TARGET - NOW)
    source.start(createSink())
    await flush()

    const line = vi.mocked(log.warn).mock.calls.map((c) => String(c[0])).find((m) => m.includes('助走'))
    expect(line).toContain('1 件も使えませんでした')
    expect(line).toContain('取得できない秒に当たった')
    source.stop()
  })

  it('安全弁: 上限まで遡ったときも理由が分かる', async () => {
    fetchMock.mockImplementation(async (t: Date) => reply(t, SHAKING_INDICES))
    const source = createYahooArchiveSource(TARGET - NOW)
    source.start(createSink())
    await flush()

    const line = vi.mocked(log.info).mock.calls.map((c) => String(c[0])).find((m) => m.includes('助走'))
    expect(line).toContain('上限まで遡った')
    source.stop()
  })
})
