import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isRegistered, startClockSync } from './kyoshin'
import { fetchServerTime, type ServerTimeSample } from './akamaiClock'
import { log } from '../utils/logger'
import { serverNow, setReplayOffset } from '../utils/clock'

// 時刻サービスの取得は結線の検証では外部 I/O。解決タイミングをテスト側で握るためモックする。
// **番兵も一緒に出すこと。** 欠けていると参照した時点で例外になり、呼び出し側の catch に
// 飲まれて「サービスが失敗した」と誤認する（テストは緑にならないが原因が見えにくい）。
vi.mock('./akamaiClock', () => ({
  fetchServerTime: vi.fn(),
  SERVER_TIME_SKIPPED: 'skipped',
}))

// 較正の見送りは警告を出す。console を潰すと本物の異常が見えなくなるのでロガー側を差し替える
// （createLogThrottle は実物を使う。全置換にすると logger の export 追加で落ちる）。
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const timeMock = vi.mocked(fetchServerTime)

/** エポック秒を実装と同じ JST の 14 桁（YYYYMMDDHHmmss）にする。 */
function tsOf(epochSec: number): string {
  const d = new Date(epochSec * 1000)
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (t: string) => p.find(x => x.type === t)?.value ?? ''
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`
}

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

// 較正ループの結線。主経路（外部時刻サービス）とフォールバック（Yahoo の 403→200 境界）の
// 切り替わりを見る。較正の精度や取得の詳細は別（akamaiClock.test.ts・実地のブラウザ確認）で見ている。
describe('startClockSync の主経路とフォールバック', () => {
  const originalFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>
  let stop: (() => void) | null = null

  const sample = (): ServerTimeSample => ({
    serverEpochMs: Date.now(),
    rttMs: 40,
    perfRefMs: performance.now(),
  })

  beforeEach(() => {
    vi.useFakeTimers()
    timeMock.mockReset()
    setReplayOffset(null)
    // Yahoo 側は常に登録済み（200）を返す。フォールバックが走ったかどうかは呼ばれた事実で見る。
    fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
    globalThis.fetch = originalFetch
    setReplayOffset(null)
  })

  // ここが今回の主眼。取れている限り Yahoo は撃たない（意図的な 403 を出さない）。
  it('外部時刻サービスで較正できたら Yahoo 経路は走らせない', async () => {
    timeMock.mockResolvedValue(sample())

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)

    expect(timeMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('外部時刻サービスのサンプルをアプリ時計へ供給する', async () => {
    // 壁時計より 5 秒進んだサーバー時刻を返す。較正されれば serverNow がそちらへ寄る。
    const before = serverNow() - Date.now()
    timeMock.mockResolvedValue({
      serverEpochMs: Date.now() + 5000,
      rttMs: 40,
      perfRefMs: performance.now(),
    })

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)

    // EMA（α = 0.2）を通すため 1 回では届かないが、供給されていればサーバー時刻の側へ動く。
    // 絶対値で見ないのは、K がテスト間で持ち越されて初回サンプル扱いにならないことがあるため。
    expect(serverNow() - Date.now()).toBeGreaterThan(before + 500)
  })

  // 見送り（別の取得と重なった）は失敗ではない。落とすと、重なっただけで Yahoo の未登録秒を撃つ。
  it('見送りのときは Yahoo 経路へ落ちない', async () => {
    timeMock.mockResolvedValue('skipped' as never)

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('外部時刻サービスが取れなければ Yahoo 経路へ落ちる', async () => {
    timeMock.mockResolvedValue(null)

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalled()
  })

  it('外部時刻サービスが例外で落ちても Yahoo 経路へ落ちる（ループは止まらない）', async () => {
    timeMock.mockRejectedValue(new Error('boom'))

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalled()

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

  // 較正済みの基準値は最後に成功したサンプルを保持し続けるため、両経路が失敗し続けても
  // serverNow() は古い値を返し、未較正警告も鳴らない。**一度成功していると止まったことに
  // 気づけない**ので、この警告が最後の砦になる。
  it('両経路が失敗し続けたら、較正が止まっていることを記録する', async () => {
    vi.mocked(log.warn).mockClear()
    // まず 1 回成功させて「較正済み」の状態を作る（未較正なら別の警告が受け持つ）。
    timeMock.mockResolvedValue(sample())
    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)

    // 以降は主経路も Yahoo 側も失敗させる。
    timeMock.mockResolvedValue(null)
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    // 猶予（5 分）を越えるまで周期を進める。
    await vi.advanceTimersByTimeAsync(330_000)

    const stale = vi.mocked(log.warn).mock.calls.filter(([m]) => String(m).includes('更新されていない'))
    expect(stale.length).toBeGreaterThan(0)
  })

  it('較正できている間は停滞の警告を出さない', async () => {
    vi.mocked(log.warn).mockClear()
    timeMock.mockResolvedValue(sample())

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(330_000)

    const stale = vi.mocked(log.warn).mock.calls.filter(([m]) => String(m).includes('更新されていない'))
    expect(stale).toHaveLength(0)
  })

  // 取得は中断できない。停止済みインスタンスの応答でアプリ時計を書き換えてはならない。
  it('停止後に届いたサンプルはアプリ時計へ供給しない', async () => {
    let resolveSample: ((v: ServerTimeSample) => void) | null = null
    timeMock.mockReturnValue(new Promise((r) => { resolveSample = r }))

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)
    const before = serverNow() - Date.now()

    stop()
    stop = null
    // 壁時計より 1 時間進んだ値。供給されてしまえば serverNow が大きく動くので一目で分かる。
    resolveSample!({ serverEpochMs: Date.now() + 3600_000, rttMs: 40, perfRefMs: performance.now() })
    await vi.advanceTimersByTimeAsync(0)

    expect(Math.abs((serverNow() - Date.now()) - before)).toBeLessThan(100)
  })
})

// 較正を見送った 3 経路の記録。スロットルを 1 個共有すると、最初に鳴った理由が残りを
// 5 分間隠してしまう（「無音経路に警告を足す」という目的が半分無効になる）。
// **1 回の較正で最大 121 リクエストを投げていた経路。** 登録は時刻順に進むので「その秒が
// 登録済みか」は単調で、二分探索なら同じ窓・同じ答えで 9 件で足りる。較正は 30 秒ごとに
// 走るため、主経路（外部の時刻サービス）が失敗し続ける端末では毎分 240 件を超えていた。
describe('クロック較正のフロンティア探索は線形に走査しない', () => {
  const originalFetch = globalThis.fetch
  let stop: (() => void) | null = null

  /** 判定リクエストの秒（URL の 14 桁）を集める fetch。`boundary` 以下を登録済みとする。 */
  function countingFetch(boundary: string | null) {
    const asked: string[] = []
    const fn = vi.fn(async (url: string) => {
      const m = /RealTimeData\/\d{8}\/(\d{14})\.json/.exec(url)
      if (!m) return { status: 200 } as Response
      asked.push(m[1])
      // 14 桁は 0 埋めなので辞書順の比較で時刻の前後になる
      const registered = boundary !== null && m[1] <= boundary
      return { status: registered ? 200 : 403 } as Response
    })
    return { fn, asked }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    timeMock.mockReset()
    setReplayOffset(null)
    // 主経路は常に失敗させ、フォールバックだけを見る
    timeMock.mockResolvedValue(null)
  })
  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
    globalThis.fetch = originalFetch
    setReplayOffset(null)
  })

  // 正: 窓の中にフロンティアがあれば見つける（答えは線形走査と同じ）。
  it('正: 窓の中のフロンティアを見つける', async () => {
    // 現在秒の 3 秒前を境界にする（既定の窓は above=2 / below=4 なので中に入る）
    const nowSec = Math.floor(serverNow() / 1000)
    const boundaryTs = tsOf(nowSec - 3)
    const { fn, asked } = countingFetch(boundaryTs)
    globalThis.fetch = fn as unknown as typeof fetch

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)

    // 境界の秒を必ず判定している（見つけた証拠）
    expect(asked).toContain(boundaryTs)
  })

  // 正（ここが本題）: 窓が上限まで広がっても判定は 12 件以下。**線形なら 121 件**。
  it('正: 窓が上限まで広がっても判定は 12 件以下（線形なら 121 件）', async () => {
    // 1 件も登録済みが無い応答にして、連続失敗で窓を上限まで広げる
    const { fn, asked } = countingFetch(null)
    globalThis.fetch = fn as unknown as typeof fetch

    stop = startClockSync()
    // 30 秒周期を 10 回まわす（2^n で広がるので 6 回目には上限 ±60 へ届く）
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(30_000)

    const perCycle = asked.length / 11
    expect(perCycle).toBeLessThanOrEqual(12)
    // 線形走査だった頃の 1 周期分（121 件）には遠く及ばないこと
    expect(asked.length).toBeLessThan(121)
  })

  // 安全弁: 判定不能（5xx）が返ったらその回は諦める。単調性の前提が崩れた状態で
  // 探索を続けると境界を取り違え、**誤った時刻を供給する**（画面には出ない）。
  it('安全弁: 判定不能が返ったらその回の較正を諦める', async () => {
    const asked: string[] = []
    const fn = vi.fn(async (url: string) => {
      const m = /RealTimeData\/\d{8}\/(\d{14})\.json/.exec(url)
      if (!m) return { status: 200 } as Response
      asked.push(m[1])
      return { status: 503 } as Response
    })
    globalThis.fetch = fn as unknown as typeof fetch

    stop = startClockSync()
    await vi.advanceTimersByTimeAsync(0)

    // 1 件目で諦める（窓を最後まで舐めない）
    expect(asked).toHaveLength(1)
  })
})

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
    //
    // **1 件目を 200 にすると探索は 1 判定で終わる。** フロンティア探索は窓の上端から
    // 訊き、そこが登録済みなら（窓の中ではそれが最新なので）即座に確定する。
    // **窓の広さに依らないので、`syncConsecutiveFail` の持ち越しに影響されない**
    // （呼び出し順に仕込む形では、走査の辿り方を変えた途端に崩れる）。
    const fetchMock = vi.fn()
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
    // 1 件目の 200 で探索を 1 判定で終わらせ、flip の初回を失敗させる（上と同じ理由）。
    globalThis.fetch = vi.fn()
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
