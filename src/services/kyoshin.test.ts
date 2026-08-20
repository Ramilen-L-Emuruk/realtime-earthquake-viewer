import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isRegistered, startClockSync } from './kyoshin'
import { fetchServerTime, type ServerTimeSample } from './akamaiClock'
import { log } from '../utils/logger'

// 時刻サービスの取得は結線の検証では外部 I/O。解決タイミングをテスト側で握るためモックする。
vi.mock('./akamaiClock', () => ({ fetchServerTime: vi.fn() }))

// 較正の見送りは警告を出す。console を潰すと本物の異常が見えなくなるのでロガー側を差し替える
// （createLogThrottle は実物を使う。全置換にすると logger の export 追加で落ちる）。
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const timeMock = vi.mocked(fetchServerTime)

describe('isRegistered', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('200 は true（登録済み）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 200 } as Response)
    expect(await isRegistered('west', 1704067200)).toBe(true)
  })

  it('403 は false（未登録）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 403 } as Response)
    expect(await isRegistered('west', 1704067200)).toBe(false)
  })

  it('404 は false（未登録）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 404 } as Response)
    expect(await isRegistered('west', 1704067200)).toBe(false)
  })

  it('500 は null（判定不能）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 500 } as Response)
    expect(await isRegistered('west', 1704067200)).toBeNull()
  })

  it('502 は null（判定不能）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 502 } as Response)
    expect(await isRegistered('west', 1704067200)).toBeNull()
  })

  it('429 は null（判定不能）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 429 } as Response)
    expect(await isRegistered('west', 1704067200)).toBeNull()
  })

  it('その他 4xx（例: 418）も null（判定不能）を返す', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 418 } as Response)
    expect(await isRegistered('west', 1704067200)).toBeNull()
  })

  it('west と east 両エッジで判定できる', async () => {
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValue({ status: 200 } as Response)
    expect(await isRegistered('east', 1704067200)).toBe(true)
    // URL の一部にエッジが反映されているか確認
    expect(mockFetch).toHaveBeenCalled()
    const call = mockFetch.mock.calls[0][0] as string
    expect(call).toContain('east')
  })
})

// 較正ループと並走計測の結線。ここで見るのは「計測が既存の較正を妨げないこと」だけ。
// 較正そのものの精度や取得の詳細は別（akamaiClock.test.ts・実地のブラウザ確認）で見ている。
describe('startClockSync と並走計測の結線', () => {
  const originalFetch = globalThis.fetch
  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    timeMock.mockReset()
    // 常に登録済み（200）を返す。フロンティアは即見つかり、flip は挟めないため較正は
    // 1 周あたり 2 リクエストで即座に見送られる（内部の待機を挟まないので結線だけが見える）。
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200 } as Response) as unknown as typeof fetch
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('計測が終わらなくても次の周期の較正が走る（計測を await しない）', async () => {
    // 永遠に解決しない。await していれば 2 周目は永久に来ない。
    timeMock.mockReturnValue(new Promise(() => {}))

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(timeMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(timeMock).toHaveBeenCalledTimes(2)
  })

  it('計測が例外で落ちても較正ループは止まらない', async () => {
    timeMock.mockRejectedValue(new Error('boom'))

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(timeMock).toHaveBeenCalledTimes(2)
  })

  it('停止したら次の周期は走らない', async () => {
    timeMock.mockResolvedValue(null)

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(timeMock).toHaveBeenCalledTimes(1)

    stop()
    stop = null
    await vi.advanceTimersByTimeAsync(60_000)
    expect(timeMock).toHaveBeenCalledTimes(1)
  })

  it('停止後に届いた計測結果は記録しない（旧インスタンスのログが混ざらない）', async () => {
    let resolveSample: ((v: ServerTimeSample) => void) | null = null
    timeMock.mockReturnValue(new Promise((r) => { resolveSample = r }))

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(log.info).mockClear()

    // 較正を止めたあとで取得が完了する（取得自体は中断できない）。
    stop()
    stop = null
    resolveSample!({ serverEpochMs: Date.now(), rttMs: 50, perfRefMs: performance.now() })
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.mocked(log.info).mock.calls.filter(([m]) => String(m).includes('clock-probe'))).toHaveLength(0)
  })
})

// 較正を見送った 3 経路の記録。スロットルを 1 個共有すると、最初に鳴った理由が残りを
// 5 分間隠してしまう（「無音経路に警告を足す」という目的が半分無効になる）。
describe('較正を見送った理由の記録', () => {
  const originalFetch = globalThis.fetch
  const warnOf = (fragment: string) =>
    vi.mocked(log.warn).mock.calls.filter(([m]) => String(m).includes(fragment))

  // スロットルの状態はモジュール変数で、テスト間で持ち越される。`vi.useFakeTimers()` は時計を
  // 実時刻へ戻すため、そのままではどのテストも直前のテストと同時刻に見えて間引かれてしまう。
  // テストごとに時計を先へ進め、必ずスロットルの窓の外から始める。
  let clockOffsetMs = 0

  beforeEach(() => {
    vi.useFakeTimers()
    clockOffsetMs += 600_000
    vi.setSystemTime(Date.now() + clockOffsetMs)
    timeMock.mockResolvedValue(null)
    vi.mocked(log.warn).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('開始時点で既に登録済みなら、その理由を記録する', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200 } as Response) as unknown as typeof fetch

    const stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)
    stop()

    expect(warnOf('開始時点で既に登録済み')).toHaveLength(1)
  })

  it('判定の取得に失敗したら、その理由を記録する', async () => {
    // フロンティア探索は成功させ、flip のポーリングだけを失敗させる。
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 403 } as Response)
      .mockResolvedValueOnce({ status: 200 } as Response)
      .mockRejectedValue(new TypeError('Failed to fetch'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)
    stop()

    expect(warnOf('判定の取得に失敗')).toHaveLength(1)
  })

  it('理由ごとに独立して記録する（先に鳴った理由が他を隠さない）', async () => {
    // 1 周目: 常に 200 → 「開始時点で既に登録済み」。
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200 } as Response) as unknown as typeof fetch
    const first = startClockSync()
    await vi.advanceTimersByTimeAsync(0)
    first()
    expect(warnOf('開始時点で既に登録済み')).toHaveLength(1)

    // 2 周目: 直後（スロットル間隔 5 分の内側）に別の理由を起こす。共有していれば隠れる。
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ status: 403 } as Response)
      .mockResolvedValueOnce({ status: 200 } as Response)
      .mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch
    const second = startClockSync()
    await vi.advanceTimersByTimeAsync(0)
    second()

    expect(warnOf('判定の取得に失敗')).toHaveLength(1)
    // 同じ理由は間引かれたまま（スロットル自体は効いている）。
    expect(warnOf('開始時点で既に登録済み')).toHaveLength(1)
  })
})
