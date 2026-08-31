// @vitest-environment jsdom
//
// useEarthquakes の「再生中の結線」のテスト。
//
// このフックは WebSocket 接続・REST 履歴取得・イベントキュー・接続状態を一手に担うが、
// 全部を覆うのは現実的でないため、**画面を見ても気づけない結線**に絞る:
//
//   - `connectionStatus` がライブ受信の実態とずれないこと。再生中は WebSocket を意図的に
//     切るため、更新し忘れると直前の値（多くは 'connected'）が残り、受信していないのに
//     「接続中」と表示され続ける。型でも例外でも捕まらず、画面上は繋がって見える
//   - 再生中もキューの予約が発火時刻を待つこと。潰すと EEW が最終報の直後に自動解除され、
//     最低 60 秒の猶予が消える
//   - EEW 発報テストの報の推移が実運用と揃っていること。報番号・発表時刻が進まず、逆に
//     震源時刻が続報のたびに進んでしまう形は、画面上は「動いているように見える」ため
//     テストで固定しないと気づけない
//
// 差し替えるのは外部 I/O（WebSocket・REST・観測点座標）だけ。時計や純粋関数は本物を使う。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import type { AppEvent, EEWAlert, JMAQuake, JMATsunami, JMANankaiCommentary } from '../types/earthquake'
import { serverDate, setReplayOffset } from '../utils/clock'
import { DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'

// isDmdss はモジュールスコープの定数。テストごとに切り替えるため getter で公開する。
let mockIsDmdss = true
vi.mock('../utils/env', () => ({
  get isDmdss() { return mockIsDmdss },
}))

// log だけを差し替え、それ以外（createLogThrottle 等）は実物を使う。全置換にすると
// logger に export が増えるたびに、無関係な import グラフの都合でこのテストが落ちる。
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// 観測点座標は遅延読込の外部データ。接続状態の観察には不要なので空で即解決させる。
vi.mock('../utils/stationCoords', () => ({
  loadStationCoords: vi.fn(() => Promise.resolve({})),
  onStationCoordsLoaded: vi.fn(() => () => {}),
  buildAreaPrefIndex: vi.fn(() => new Map()),
}))

// WebSocket の代役。`new` で呼ばれるためクラスで用意する（アロー関数はコンストラクタになれない）。
// vi.mock のファクトリはファイル先頭へ巻き上げられるので、クラス定義も vi.hoisted で一緒に上げる。
const { sockets, FakeWebSocket } = vi.hoisted(() => {
  const sockets: { connected: boolean; onStatusChange: ((s: string) => void) | null; onEvent: ((e: unknown) => void) | null }[] = []
  class FakeWebSocket {
    onEvent: ((e: unknown) => void) | null = null
    onStatusChange: ((s: string) => void) | null = null
    onRawMessage: ((e: unknown) => void) | null = null
    connected = false
    constructor() { sockets.push(this) }
    connect() { this.connected = true }
    disconnect() { this.connected = false }
  }
  return { sockets, FakeWebSocket }
})

// 取得系はモック関数だけを置き、戻り値は下の beforeEach で `vi.mocked(...).mockResolvedValue(...)`
// で与える。**ファクトリ内でリテラルを書くと型検査が効かない**ため、そこを取り違えると初回履歴取得が
// TypeError で落ち、実装側の catch に飲まれて error state に入る（接続状態だけ見ていると緑のまま
// 通ってしまう）。`vi.mocked` 経由なら実関数の戻り値型で縛られるので、取り違えは型エラーになる。
vi.mock('../services/dmdata', () => ({
  DmdataWebSocket: FakeWebSocket,
  fetchDmdataEarthquakes: vi.fn(),
  fetchDmdataTsunamis: vi.fn(),
  fetchDmdataLpgms: vi.fn(),
  fetchDmdataNankai: vi.fn(),
  fetchDmdataNankaiCommentary: vi.fn(),
  fetchDmdataKohatsu: vi.fn(),
}))

vi.mock('../services/p2pquake', () => ({
  P2PQuakeWebSocket: FakeWebSocket,
  fetchHistory: vi.fn(),
  fetchJmaQuake: vi.fn(),
}))

const {
  fetchDmdataEarthquakes, fetchDmdataTsunamis, fetchDmdataLpgms,
  fetchDmdataNankai, fetchDmdataNankaiCommentary, fetchDmdataKohatsu,
} = await import('../services/dmdata')
const { fetchHistory, fetchJmaQuake } = await import('../services/p2pquake')

const { useEarthquakes } = await import('./useEarthquakes')

beforeEach(() => {
  sockets.length = 0
  mockIsDmdss = true
  // 戻り値の形はここで型付きに与える（実シグネチャと違えば型エラーになる）
  vi.mocked(fetchDmdataEarthquakes).mockResolvedValue({ quakes: [] })
  vi.mocked(fetchDmdataTsunamis).mockResolvedValue([])
  vi.mocked(fetchDmdataLpgms).mockResolvedValue([])
  vi.mocked(fetchDmdataNankai).mockResolvedValue(null)
  vi.mocked(fetchDmdataNankaiCommentary).mockResolvedValue(null)
  vi.mocked(fetchDmdataKohatsu).mockResolvedValue(null)
  vi.mocked(fetchHistory).mockResolvedValue([])
  vi.mocked(fetchJmaQuake).mockResolvedValue([])
})

afterEach(cleanup)

/** replayTimeOffset を差し替えられるハーネス。onLiveEvent は生の電文を覗きたいときだけ渡す。 */
function setup(opts: { apiKey?: string; offset?: number | null; onLiveEvent?: (event: AppEvent) => void } = {}) {
  const view = renderHook(
    ({ offset }: { offset: number | null }) =>
      useEarthquakes(opts.onLiveEvent, opts.apiKey ?? 'test-key', false, offset),
    { initialProps: { offset: opts.offset ?? null } },
  )
  return {
    get current() { return view.result.current },
    setOffset(offset: number | null) {
      act(() => { view.rerender({ offset }) })
    },
    /**
     * 実装の初回履歴取得（`Promise.all` → `then(async ...)` → `setState`）を流し切る。
     *
     * `act` の同期版はエフェクト本体までしか進めないため、これを挟まないと取得の失敗
     * （例: モックの戻り値の形違いによる TypeError）が state へ届く前に assert してしまい、
     * 「見ているつもりで何も見ていない」テストになる。
     *
     * 1 回で足りる。`await` はマイクロタスクキューが空になるまでドレインするため、
     * チェーンが何段あってもマイクロタスクだけで構成されている限りまとめて流れる
     * （実測で tick=1 の時点で error state へ反映されることを確認済み）。
     */
    async flush() {
      await act(async () => { await Promise.resolve() })
    },
  }
}

describe('DMDSS 版: 再生中は接続状態を replay にする（ライブ接続は切る）', () => {
  it('replayTimeOffset が入ると replay へ移り、読み込み中も降りる', async () => {
    const h = setup({ offset: null })
    // 再生前の初回履歴取得を流し切ってから見る（取得の失敗が state へ届くのを待つ）
    await h.flush()
    expect(h.current.error).toBeNull()

    h.setOffset(-3600_000)
    expect(h.current.connectionStatus).toBe('replay')
    expect(h.current.isLoading).toBe(false)
  })

  it('再生中は DMDATA の WebSocket を張らない（張ったものは切る）', () => {
    const h = setup({ offset: null })
    // 再生開始前に 1 本張られている
    expect(sockets.length).toBe(1)
    expect(sockets[0].connected).toBe(true)

    h.setOffset(-3600_000)
    // 前の effect の cleanup で切られ、新しい接続は張られない
    expect(sockets[0].connected).toBe(false)
    expect(sockets.length).toBe(1)
  })

  it('再生を終えると接続を張り直し、connecting へ戻る（API キーあり）', () => {
    const h = setup({ offset: -3600_000 })
    expect(h.current.connectionStatus).toBe('replay')

    h.setOffset(null)
    expect(h.current.connectionStatus).toBe('connecting')
    expect(sockets.length).toBe(1)
    expect(sockets[0].connected).toBe(true)
  })

  it('API キーが無ければ、再生を終えたあとは disconnected へ戻る', () => {
    const h = setup({ apiKey: '', offset: -3600_000 })
    expect(h.current.connectionStatus).toBe('replay')

    h.setOffset(null)
    expect(h.current.connectionStatus).toBe('disconnected')
    expect(h.current.isLoading).toBe(false)
  })

  it('接続後に再生へ入っても replay で上書きする（connected のまま残さない）', () => {
    const h = setup({ offset: null })
    act(() => { sockets[0].onStatusChange?.('connected') })
    expect(h.current.connectionStatus).toBe('connected')

    h.setOffset(-3600_000)
    expect(h.current.connectionStatus).toBe('replay')
  })
})

describe('standard 版も再生中はライブ受信を止める（VAR-1）', () => {
  beforeEach(() => { mockIsDmdss = false })

  // かつては standard 版だけ P2PQuake の受信を続けていた（リプレイが強震モニタの時計ずらしに
  // 過ぎず、地震・津波は何も流れなかったため）。standard 版も当時の電文を流すようになった今は
  // DMDSS 版と同じ扱いで、再生中はライブ接続を切る。
  it('replayTimeOffset が入ると replay へ移る', () => {
    const h = setup({ offset: null })
    act(() => { sockets[0].onStatusChange?.('connected') })
    expect(h.current.connectionStatus).toBe('connected')

    h.setOffset(-3600_000)
    expect(h.current.connectionStatus).toBe('replay')
  })

  it('再生中はライブ接続を張らない（張ったものは切る）', () => {
    const h = setup({ offset: null })
    expect(sockets.length).toBe(1)
    expect(sockets[0].connected).toBe(true)

    h.setOffset(-3600_000)
    // 前の effect の cleanup で切られ、新しい接続は張られない
    expect(sockets[0].connected).toBe(false)
    expect(sockets.length).toBe(1)
  })

  it('再生を終えるとライブ接続を張り直し、読み込み中へ戻す', async () => {
    const h = setup({ offset: -3600_000 })
    expect(h.current.connectionStatus).toBe('replay')

    h.setOffset(null)
    expect(sockets.length).toBe(1)
    expect(sockets[0].connected).toBe(true)
    // 取得前に読み込み中へ戻すこと。ここを見ないと、リセット直後の未取得の状態が
    // 「地震情報はありません」（0 件）として表示される回帰を通してしまう。
    expect(h.current.isLoading).toBe(true)

    await h.flush()
    expect(h.current.error).toBeNull()
    expect(h.current.isLoading).toBe(false)
  })

  // 再生開始時に読み込み中・エラー表示を畳むこと。畳まないと、初回履歴の取得中や失敗直後に
  // 再生を始めた場合、その取得は cleanup で破棄される一方で表示を戻す経路が無くなり、
  // 再生した電文が「データを取得中...」や取得失敗の文言の裏に隠れ続ける。
  it('再生開始時に読み込み中・エラー表示を畳む', () => {
    const h = setup({ offset: null })
    expect(h.current.isLoading).toBe(true)

    h.setOffset(-3600_000)
    expect(h.current.isLoading).toBe(false)
    expect(h.current.error).toBeNull()
  })
})

describe('再生中もキューの予約は発火時刻を待つ', () => {
  // かつては再生中だけ予約の発火時刻を `now` へ潰していた（VAR-1 の緩和策）。その結果、
  // EEW 最終報を受けた次のティック（10ms 後）に自動解除が走り、EEW が出た瞬間に消えていた。
  // 猶予の長さ自体は `calcEEWCancelTime` の責務（最終報から最低 60 秒）なので、ここでは
  // 「再生中もその猶予がキューに残ること」だけを見る。
  const OFFSET_MS = -3600_000

  /** 最終報の EEW。規模を小さく取り、猶予が下限（60 秒）で決まるようにする。 */
  function finalEEW(at: Date): EEWAlert {
    const iso = at.toISOString()
    return {
      kind: 'eew',
      id: 'replay-final',
      time: iso,
      test: false,
      earthquake: {
        originTime: iso,
        arrivalTime: iso,
        condition: '',
        hypocenter: { name: 'テスト沖', latitude: 35, longitude: 140, depth: 10, magnitude: 4.0 },
      },
      severity: 'Forecast',
      cancelled: false,
      isFinal: true,
      issue: { eventId: 'replay-final-event', serial: '2', time: iso },
      areas: [],
    }
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  it('EEW 最終報を受けても猶予の内は解除せず、猶予を過ぎたら解除する', () => {
    // 時計も再生側へ寄せる（実装は getTimeRef=serverDate 経由で再生時刻を読む）
    setReplayOffset(OFFSET_MS)
    const h = setup({ offset: OFFSET_MS })

    act(() => { h.current.injectEvent(finalEEW(serverDate())) })
    expect(h.current.activeEEWs.size).toBe(1)

    // キューのディスパッチャは 10ms 間隔。回しても猶予の内は消えない
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { vi.advanceTimersByTime(31_000) })
    expect(h.current.activeEEWs.size).toBe(0)
  })

  /** 有効期限を持つ津波予報（DMDSS 版の「若干の海面変動」相当。解除電文が来ず期限だけで終わる）。 */
  function tsunamiWithValidDateTime(at: Date, validForMs: number): JMATsunami {
    const iso = at.toISOString()
    return {
      kind: 'tsunami',
      id: 'replay-tsunami',
      eventId: 'replay-tsunami-event',
      time: iso,
      cancelled: false,
      validDateTime: new Date(at.getTime() + validForMs).toISOString(),
      issue: { source: '気象庁', time: iso, type: 'Focus' },
      areas: [{ grade: 'Forecast', immediate: false, name: 'テスト沿岸' }],
    }
  }

  // EEW と同じ理由で、津波の有効期限（`validDateTime`）も潰されていた。しかも症状は逆で、
  // 予約時刻が `now` 以下に潰れると `alreadyExpired` が常に真になり、本編再生分（非サイレント）は
  // 失効予約が積まれないまま残り続けていた。EEW 側だけ直してもこちらは守られない。
  it('津波の有効期限も前倒しされず、期限を過ぎてから失効する', () => {
    setReplayOffset(OFFSET_MS)
    const h = setup({ offset: OFFSET_MS })

    act(() => { h.current.injectEvent(tsunamiWithValidDateTime(serverDate(), 60_000)) })
    expect(h.current.tsunamis.length).toBe(1)
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()

    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()

    act(() => { vi.advanceTimersByTime(31_000) })
    expect(h.current.tsunamis[0].cancelledAt).toBeInstanceOf(Date)
    expect(h.current.tsunamis[0].cancelReason).toBe('expired')
  })
})

// EEW 発報テスト（設定タブのテストボタン）が作る「報の推移」。
//
// 実運用（dmdataParser.parseEEW）では 1 報ごとに報番号・id・発表時刻が進み、震源時刻は
// 同一イベントで不変。テスト側がここを取り違えると、
//   - 最終報の報番号が進まない → 「#1 → #1 最終報」という実運用ではあり得ない推移になる
//   - 続報で震源時刻が現在時刻へ張り替わる → 予報円が押すたび中心に戻り、発生時刻表示も動く
// のどちらも画面上は「それらしく」見えてしまうため、値そのものを固定して守る。
describe('EEW 発報テストの報の推移', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** activeEEWs の唯一の要素を取り出す（テストボタンは 1 イベントしか作らない）。 */
  function onlyEEW(h: ReturnType<typeof setup>): EEWAlert {
    const list = [...h.current.activeEEWs.values()]
    expect(list.length).toBe(1)
    return list[0]
  }

  it('続報は報番号と発表時刻だけを進め、震源時刻は初報のまま保つ', () => {
    const h = setup()

    act(() => { h.current.simulateEEWForecast() })
    const first = onlyEEW(h)
    expect(first.issue?.serial).toBe('1')
    expect(first.isFinal).toBeFalsy()

    // 沈黙時間（10 秒）より短い間隔なら続報になる
    act(() => { vi.advanceTimersByTime(3_000) })
    act(() => { h.current.simulateEEWForecast() })
    const second = onlyEEW(h)

    expect(second.issue?.serial).toBe('2')
    expect(second.isFinal).toBeFalsy()
    // 震源時刻・到達予想時刻は動かない
    expect(second.earthquake.originTime).toBe(first.earthquake.originTime)
    expect(second.earthquake.arrivalTime).toBe(first.earthquake.arrivalTime)
    // 発表時刻と id は報ごとに変わる（issue.time は型上 optional なので解釈可能かも見る）
    const firstIssued = Date.parse(first.issue?.time ?? '')
    const secondIssued = Date.parse(second.issue?.time ?? '')
    expect(Number.isNaN(firstIssued)).toBe(false)
    expect(secondIssued).toBeGreaterThan(firstIssued)
    expect(second.id).not.toBe(first.id)
  })

  it('最終報も独立した 1 報として報番号を進める', () => {
    const h = setup()

    act(() => { h.current.simulateEEWForecast() })
    const first = onlyEEW(h)

    // 再クリックが無いまま沈黙時間が過ぎると最終報が確定する
    act(() => { vi.advanceTimersByTime(10_000) })
    const final = onlyEEW(h)

    expect(final.isFinal).toBe(true)
    expect(final.issue?.serial).toBe('2')
    expect(final.earthquake.originTime).toBe(first.earthquake.originTime)
  })

  // activeEEWs は取消を受けても直前の確定状態を保つ（表示を空にしないための実装）ため、
  // 取消電文そのものの形は state からは見えない。onLiveEvent に届く生の電文で確かめる。
  it('誤報取消も独立した 1 報として報番号を進め、対象地域を持たない', () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    act(() => { h.current.simulateEEWRetraction() })
    act(() => { vi.advanceTimersByTime(10_000) })

    const eews = events.filter((e): e is EEWAlert => e.kind === 'eew')
    expect(eews.length).toBe(2)
    const [report, cancel] = eews

    expect(report.issue?.serial).toBe('1')
    expect(report.areas?.length).toBeGreaterThan(0)

    expect(cancel.cancelled).toBe(true)
    expect(cancel.issue?.serial).toBe('2')
    expect(cancel.areas).toEqual([])
    // 実運用の取消電文は震源座標を持たない（0）。震源名は通知文・読み上げが使うので残す
    expect(cancel.earthquake.hypocenter.latitude).toBe(0)
    expect(cancel.earthquake.hypocenter.longitude).toBe(0)
    expect(cancel.earthquake.hypocenter.name).toBe(report.earthquake.hypocenter.name)
    // 予想も持たない（実運用の取消電文は forecastMaxScale / forecastMaxLpgmClass が入らない）
    expect(cancel.forecastMaxScale).toBeUndefined()
    expect(cancel.forecastMaxLpgmClass).toBeUndefined()
    // 取消は最終報ではない（自動解除と区別され、音・通知・読み上げを伴う）
    expect(cancel.isFinal).toBeFalsy()
    expect(h.current.activeEEWs.size).toBe(1)
  })
})

// 津波テストの解除電文。EEW の最終報と同じ「直前の電文を流用して据え置く」形になっていた。
// 実運用（dmdataParser / p2pquake の 552）はどちらの経路も区域を空にして送るため、
// 区域が残ったままの解除は実運用では起こらない。解除理由はバリアントで持つ/持たないが分かれる。
describe('津波テストの解除電文', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** 発表 → 解除の 2 通を取り出す。 */
  function tsunamiPair(events: AppEvent[]): [JMATsunami, JMATsunami] {
    const list = events.filter((e): e is JMATsunami => e.kind === 'tsunami')
    expect(list.length).toBe(2)
    return [list[0], list[1]]
  }

  it('DMDSS 版: 解除は区域を空にし、発表時刻を解除時点へ進める', () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    act(() => { h.current.simulateTsunamiWatch() })
    act(() => { vi.advanceTimersByTime(90_000) })

    const [first, cancel] = tsunamiPair(events)
    expect(first.areas.length).toBeGreaterThan(0)
    // DMDATA の電文は常に eventId を持つ
    expect(first.eventId).toBeTruthy()

    expect(cancel.cancelled).toBe(true)
    expect(cancel.areas).toEqual([])
    expect(cancel.cancelReason).toBe('lifted')
    expect(new Date(cancel.time).getTime()).toBeGreaterThan(new Date(first.time).getTime())
    expect(cancel.id).not.toBe(first.id)

    // 電文の形だけでなく、state が実際に解除されたことまで見る。onLiveEvent は reducer の
    // 成否に関わらず呼ばれるため、ここを見ないと「音は鳴るがカードは残る」状態を通してしまう。
    expect(h.current.tsunamis[0]?.cancelledAt).toBeInstanceOf(Date)
    expect(h.current.tsunamis[0]?.cancelReason).toBe('lifted')
  })

  it('standard 版: 解除理由と eventId を持たない（P2PQuake では判別できない項目）', () => {
    mockIsDmdss = false
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    act(() => { h.current.simulateTsunamiRetraction() })
    act(() => { vi.advanceTimersByTime(90_000) })

    const [first, cancel] = tsunamiPair(events)
    expect(first.eventId).toBeUndefined()
    expect(cancel.cancelled).toBe(true)
    expect(cancel.areas).toEqual([])
    // 誤報取消でも standard 版は「取消」と判別できないため理由を付けない
    expect(cancel.cancelReason).toBeUndefined()

    // eventId が無く id も別物（実運用の P2PQuake と同じ形）でも解除が state へ届くこと。
    // ここを id 照合で捨てていたのが standard 版の「カードが消えない」不具合だった。
    expect(h.current.tsunamis[0]?.cancelledAt).toBeInstanceOf(Date)
    expect(h.current.tsunamis[0]?.cancelReason).toBeUndefined()
  })

  // 上の 2 件はテストボタン経由。こちらは reducer の解除照合そのものを、実運用の
  // P2PQuake 相当の電文（eventId 無し・発表と解除で id が別）で直接確かめる。
  it('eventId を持たない経路では、id が違っても解除を受け入れる（P2PQuake 相当）', () => {
    mockIsDmdss = false
    const h = setup()

    const base = serverDate().toISOString()
    const announce: JMATsunami = {
      kind: 'tsunami',
      id: 'p2p-552-announce',
      time: base,
      cancelled: false,
      issue: { source: '気象庁', time: base, type: 'Focus' },
      areas: [{ grade: 'Watch', immediate: false, name: 'テスト沿岸' }],
    }
    act(() => { h.current.injectEvent(announce) })
    expect(h.current.tsunamis.length).toBe(1)

    // 解除は別電文なので id が異なる（P2PQuake の id は電文ごとの文書 ID）
    act(() => {
      h.current.injectEvent({
        ...announce,
        id: 'p2p-552-cancel',
        time: new Date(Date.parse(base) + 60_000).toISOString(),
        cancelled: true,
        areas: [],
      })
    })
    expect(h.current.tsunamis[0]?.cancelledAt).toBeInstanceOf(Date)
  })

  // ただし照合できないからといって何でも受け入れるわけではない。表示中より古い発表時刻の解除は
  // 「別イベントの遅延到達」として捨てる（1 件スロットのため、受け入れると別の津波が消える）。
  it('eventId が無い経路でも、表示中より古い発表時刻の解除は受け入れない', () => {
    mockIsDmdss = false
    const h = setup()

    const older = new Date(Date.now() - 600_000).toISOString()
    const newer = new Date().toISOString()

    // 先に古いイベント A を出し、続いて新しいイベント B に置き換わった状態を作る
    const eventA: JMATsunami = {
      kind: 'tsunami',
      id: 'p2p-552-A',
      time: older,
      cancelled: false,
      issue: { source: '気象庁', time: older, type: 'Focus' },
      areas: [{ grade: 'Watch', immediate: false, name: 'テスト沿岸' }],
    }
    act(() => { h.current.injectEvent(eventA) })
    act(() => {
      h.current.injectEvent({ ...eventA, id: 'p2p-552-B', time: newer, issue: { source: '気象庁', time: newer, type: 'Focus' } })
    })

    // A の解除が遅れて届く（発表時刻は B より古い）
    act(() => {
      h.current.injectEvent({ ...eventA, id: 'p2p-552-A-cancel', cancelled: true, areas: [] })
    })
    expect(h.current.tsunamis[0]?.cancelledAt).toBeUndefined()
    expect(h.current.tsunamis[0]?.id).toBe('p2p-552-B')
  })

  // 一方、双方が eventId を持つ DMDSS 経路では別イベントの解除に巻き込まれないこと。
  it('双方が eventId を持つ場合は、別イベントの解除では消えない', () => {
    const h = setup()

    const base = serverDate().toISOString()
    const announce: JMATsunami = {
      kind: 'tsunami',
      id: 'dmdata-tsunami-A-1',
      eventId: '20260820100000',
      time: base,
      cancelled: false,
      issue: { source: '気象庁', time: base, type: 'Focus' },
      areas: [{ grade: 'Watch', immediate: false, name: 'テスト沿岸' }],
    }
    act(() => { h.current.injectEvent(announce) })

    act(() => {
      h.current.injectEvent({
        ...announce,
        id: 'dmdata-tsunami-B-1',
        eventId: '20260820110000',
        cancelled: true,
        areas: [],
      })
    })
    expect(h.current.tsunamis[0]?.cancelledAt).toBeUndefined()
  })
})

describe('南海トラフ関連解説情報の帯は期限で畳む', () => {
  // 解説情報には解除電文が無く、定例解説（VYSE52）は平常時にも毎月届く。期限で畳まないと
  // 帯が常駐する。逆に期限切れを載せてしまうと「先月の解説」が起動のたびに出る。
  // どちらも画面を見ただけでは「そういう仕様」と区別がつかないため、ここで固定する。

  /** expireInMs 後に期限が切れる解説情報。 */
  function commentary(id: string, expireInMs: number): JMANankaiCommentary {
    const now = serverDate()
    return {
      id,
      time: now.toISOString(),
      eventId: `${id}-event`,
      serialCode: '200',
      serialName: '定例解説',
      headline: '南海トラフ地震関連解説情報',
      summary: '要約',
      body: '本文',
      cancelled: false,
      reportDateTime: now.toISOString(),
      expireAt: new Date(now.getTime() + expireInMs).toISOString(),
    }
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('初回取得で期限内の解説情報を帯に載せる', async () => {
    vi.mocked(fetchDmdataNankaiCommentary).mockResolvedValue(commentary('c-fresh', 60_000))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary?.id).toBe('c-fresh')
  })

  it('期限切れの解説情報は載せない（先月の定例解説が起動時に出ないこと）', async () => {
    vi.mocked(fetchDmdataNankaiCommentary).mockResolvedValue(commentary('c-stale', -1_000))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary).toBeNull()
  })

  it('期限が来たら帯を畳む', async () => {
    vi.mocked(fetchDmdataNankaiCommentary).mockResolvedValue(commentary('c-expiring', 5_000))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary?.id).toBe('c-expiring')

    act(() => { vi.advanceTimersByTime(5_001) })
    expect(h.current.nankaiCommentary).toBeNull()
  })

  it('期限日時が壊れていれば載せない（期限計算が破綻した状態で帯を出さない）', async () => {
    const broken = { ...commentary('c-broken', 60_000), expireAt: 'not-a-date' }
    vi.mocked(fetchDmdataNankaiCommentary).mockResolvedValue(broken)
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary).toBeNull()
  })

  it('取消電文で帯を消す（期限を待たずに畳む）', async () => {
    vi.mocked(fetchDmdataNankaiCommentary).mockResolvedValue(commentary('c-live', 60_000))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary?.id).toBe('c-live')

    // 取消はライブ受信経路（injectEvent は AppEvent 専用なので、キュー経由の payload を使う）
    act(() => {
      h.current.loadReplayEvents([{
        payload: { kind: 'nankaiCommentary', data: { ...commentary('c-cancel', 60_000), cancelled: true } },
        replayTime: serverDate(),
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })
    expect(h.current.nankaiCommentary).toBeNull()
  })
})

// キーが不正なとき、通信を起こす前に止まること。ここが「呼ぶかどうか」を決める最上流のゲートで、
// 下流（dmdataApiKey.test.ts・dmdata.test.ts）をいくら固めてもここが外れれば全部素通りになる。
// エフェクトの依存配列やゲートの位置が動いたときに気づけるよう、取得関数が呼ばれないことまで見る。
describe('DMDSS 版: APIキーが不正なら通信しない', () => {
  // このファイルの beforeEach は戻り値を再設定するだけで呼び出し履歴は消さない。
  // 履歴を消さずに「呼ばれないこと」を見ると、他のテストの呼び出しを拾って落ちる。
  // 逆に「呼ばれること」の側は履歴が残っているせいで常に通り、検証にならない。
  beforeEach(() => {
    for (const fn of [fetchDmdataEarthquakes, fetchDmdataTsunamis, fetchDmdataNankai]) {
      vi.mocked(fn).mockClear()
    }
  })

  it('disconnected へ落ち、理由を error に載せ、取得を一度も呼ばない', async () => {
    const h = setup({ apiKey: 'abc123あ' })
    await h.flush()

    expect(h.current.connectionStatus).toBe('disconnected')
    expect(h.current.isLoading).toBe(false)
    expect(h.current.error).toBe(DMDATA_API_KEY_INVALID_MESSAGE)
    expect(fetchDmdataEarthquakes).not.toHaveBeenCalled()
    expect(fetchDmdataTsunamis).not.toHaveBeenCalled()
    expect(fetchDmdataNankai).not.toHaveBeenCalled()
    // WebSocket も張らない（張ると 30 秒間隔の再接続が無音で回り続ける）
    expect(sockets.length).toBe(0)
  })

  // 対照: 形が正しいキーなら従来どおり接続と取得へ進む。ゲートを広げすぎていないことの確認。
  it('形が正しいキー（ピリオド入り）は従来どおり接続へ進む', async () => {
    const h = setup({ apiKey: 'dummy.key.with-period_123' })
    await h.flush()

    expect(h.current.error).toBeNull()
    expect(fetchDmdataEarthquakes).toHaveBeenCalled()
    expect(sockets.length).toBe(1)
    expect(sockets[0].connected).toBe(true)
  })

  // 安全弁: キーを直したら error が残らずに接続へ復帰すること。
  it('キーを直すと error が消えて接続へ復帰する', async () => {
    const view = renderHook(
      ({ apiKey }: { apiKey: string }) => useEarthquakes(undefined, apiKey, false, null),
      { initialProps: { apiKey: 'abc123あ' } },
    )
    await act(async () => { await Promise.resolve() })
    expect(view.result.current.error).toBe(DMDATA_API_KEY_INVALID_MESSAGE)

    await act(async () => {
      view.rerender({ apiKey: 'dummy.key.with-period_123' })
      await Promise.resolve()
    })

    expect(view.result.current.error).toBeNull()
    expect(view.result.current.connectionStatus).not.toBe('disconnected')
  })
})

// リプレイ開始時の地震カードの扱い。
//
// 一覧の厚みはライブと再生で基準が違う（ライブ＝件数・初期状態の再現＝時間）ため、
// 履歴は専用の口から流し込む。ここで見るのは、その口が既存カードを壊さないことと、
// 「もっと見る」がライブの最新履歴を引き込む経路を塞いであること。
describe('リプレイ開始時の地震カード', () => {
  /** 履歴の 1 通。統合は mergeQuakeHistory（本物）に任せるので最小形でよい。 */
  function quakeTelegram(eventId: string, time: string): JMAQuake {
    return {
      kind: 'quake' as const,
      id: `dmdata-quake-${eventId}-1`,
      time,
      issue: { source: '気象庁', time, type: '各地の震度情報' as const, correct: 'なし' as const },
      earthquake: {
        time,
        hypocenter: { name: '岩手県沖', latitude: 39.9, longitude: 142.2, depth: 50, magnitude: 5.1 },
        maxScale: 40,
        domesticTsunami: 'なし' as const,
      },
      points: [{ pref: '岩手県', addr: '宮古市', isArea: false, scale: 40 }],
    }
  }

  // 押すと `loadMoreEarthquakes` がライブの最新履歴を取りに行き、再生時刻より未来の地震が
  // カードに並ぶ。カードを空にするだけでボタンを残すと、再生中もこれが押せてしまう。
  it('表示をリセットすると「もっと見る」を畳む', async () => {
    vi.mocked(fetchDmdataEarthquakes).mockResolvedValue({ quakes: [], nextToken: 'next-page' })
    const h = setup({ offset: null })
    await h.flush()
    expect(h.current.hasMore).toBe(true)

    act(() => { h.current.resetState() })

    expect(h.current.hasMore).toBe(false)
  })

  it('履歴を流し込むとカードが並ぶ', async () => {
    const h = setup({ offset: null })
    await h.flush()

    act(() => {
      h.current.restoreQuakeHistory([
        quakeTelegram('20260810010000', '2026-08-10T01:05:00+09:00'),
        quakeTelegram('20260810020000', '2026-08-10T02:05:00+09:00'),
      ])
    })

    expect(h.current.earthquakes).toHaveLength(2)
  })

  // 履歴の取得は初期状態の注入や本編の再生より後に終わることがある。既存のカードを
  // base に統合しないと、先に出来ていたカードを消してしまう。
  it('履歴が後から届いても、既にあるカードを消さずに統合する', async () => {
    const h = setup({ offset: null })
    await h.flush()

    act(() => { h.current.restoreQuakeHistory([quakeTelegram('20260810020000', '2026-08-10T02:05:00+09:00')]) })
    act(() => { h.current.restoreQuakeHistory([quakeTelegram('20260810010000', '2026-08-10T01:05:00+09:00')]) })

    expect(h.current.earthquakes).toHaveLength(2)
  })
})

describe('EEW の続報は古い報で退行しない', () => {
  // 同じ地震の報は同じ秒に複数届く（能登本震の実配信で 46 報中 13 報）。キューは電文の時刻
  // （秒精度）でしか並べ替えられず、WebSocket の受信は body の展開（gunzip）を待たずに次へ
  // 進むため、同じ秒に来た報は展開の完了順で処理されうる。順序が入れ替わったまま丸ごと
  // 上書きすると、地図の区域塗りが古い内容へ戻る。報番号で弾いていることを固定する。
  //
  // 画面上は「区域が減っただけ」に見えて電文どおりか退行かの区別がつかないため、
  // テストで押さえないと気づけない。
  const AT = '2024-01-01T16:10:20+09:00'

  /** 同一秒・同一 eventId の報。報番号と対象区域だけを変える。 */
  function report(serial: string, areaNames: string[], over: { serial?: string } = {}): EEWAlert {
    return {
      kind: 'eew',
      id: `dmdata-eew-stale-${serial}`,
      time: AT,
      test: false,
      earthquake: {
        originTime: AT,
        arrivalTime: AT,
        condition: '',
        hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 7.6 },
      },
      severity: 'Warning',
      cancelled: false,
      isFinal: false,
      issue: { eventId: 'stale-event', serial: over.serial ?? serial, time: AT },
      areas: areaNames.map(name => ({ pref: '', name, scaleFrom: 40, scaleTo: 50, kindCode: '11', arrivalTime: null })),
    }
  }

  const areasOf = (h: ReturnType<typeof setup>) =>
    [...h.current.activeEEWs.values()][0]?.areas?.map(a => a.name) ?? []

  it('新しい報は反映する', () => {
    const h = setup()
    act(() => { h.current.injectEvent(report('1', ['石川県能登'])) })
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部', '新潟県上越'])) })
    expect(areasOf(h)).toEqual(['石川県能登', '富山県西部', '新潟県上越'])
  })

  // 対照: これがこの修正の本体。展開順の入れ替わりを模して、古い報を後から入れる。
  it('古い報が後から届いても上書きしない', () => {
    const h = setup()
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部', '新潟県上越'])) })
    act(() => { h.current.injectEvent(report('1', ['石川県能登'])) })
    expect(areasOf(h)).toEqual(['石川県能登', '富山県西部', '新潟県上越'])
  })

  // 安全弁 1: 同じ報番号の再送は弾かない（内容が同じなので上書きしても害がなく、
  // 弾く実装にすると「同番の訂正報」を取りこぼす）。
  it('同じ報番号の再送は受け入れる', () => {
    const h = setup()
    act(() => { h.current.injectEvent(report('2', ['石川県能登'])) })
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部'])) })
    expect(areasOf(h)).toEqual(['石川県能登', '富山県西部'])
  })

  // 安全弁 2: 報番号を持たない経路（P2PQuake は issue.serial が欠けることがある）では
  // 順序を決める根拠が無いため判定しない。0 で埋めて比較すると正しい報まで捨ててしまう。
  it('報番号を持たない報は従来どおり後着を採る', () => {
    const h = setup()
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部'])) })
    act(() => { h.current.injectEvent(report('x', ['石川県能登'], { serial: '' })) })
    expect(areasOf(h)).toEqual(['石川県能登'])
  })

  // 状態（activeEEWs）だけを守っても足りない。通知は setState の外・入口で走るため、
  // ここを素通ししていると地図・カードは新しい報、読み上げとウィンドウタイトルは古い報という
  // 食い違いが起きる。揃って退行するより始末が悪いので、入口で捨てることを固定する。
  it('古い報は通知（読み上げ・タイトル）へも渡さない', () => {
    const seen: string[] = []
    const h = setup({
      onLiveEvent: (e) => { if (e.kind === 'eew') seen.push((e as EEWAlert).issue?.serial ?? '') },
    })
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部'])) })
    act(() => { h.current.injectEvent(report('1', ['石川県能登'])) })
    expect(seen).toEqual(['2'])
  })

  // 本番のキューディスパッチャは 1 ティックの中で複数のイベントを連続処理する（同じ秒の報が
  // まとめてキューに載るため、順序が入れ替わりうる場面ほどこうなる）。その間はレンダーが
  // 挟まらないので、判定を「レンダーで進む値」に頼ると直前に受理した報を見落とす。
  // レンダーを挟まない連続呼び出しでも守られることを固定する。
  it('同じティックで連続処理されても古い報を通さない（状態・通知とも）', () => {
    const seen: string[] = []
    const h = setup({
      onLiveEvent: (e) => { if (e.kind === 'eew') seen.push((e as EEWAlert).issue?.serial ?? '') },
    })
    // 単一の act の中で 2 件続けて注入する＝間にレンダーが入らない
    act(() => {
      h.current.injectEvent(report('2', ['石川県能登', '富山県西部']))
      h.current.injectEvent(report('1', ['石川県能登']))
    })
    expect(seen).toEqual(['2'])
    expect(areasOf(h)).toEqual(['石川県能登', '富山県西部'])
  })

  // `eewSerial`（utils/eew.ts）に判定を委ねているため、0・負値・小数は報番号として採らない
  // ＝比較しない。ここを独自実装に戻すと、その値をそのまま大小比較に使ってしまう。
  it('報番号として成立しない値（0）は判定に使わない', () => {
    const h = setup()
    act(() => { h.current.injectEvent(report('2', ['石川県能登', '富山県西部'])) })
    act(() => { h.current.injectEvent(report('0', ['石川県能登'], { serial: '0' })) })
    expect(areasOf(h)).toEqual(['石川県能登'])
  })

  // 台帳は表示が終わった EEW の分を落とす。落とさないと伸び続け、逆に落としすぎると保護が
  // 効かなくなる。解除で消えたあと、同じキーの報を初報として受け直せることで確認する。
  it('表示が終わった EEW の報番号は台帳に残さない', () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      act(() => { h.current.injectEvent(report('5', ['石川県能登', '富山県西部'])) })
      expect(h.current.activeEEWs.size).toBe(1)

      // 最終報の自動解除を待つ（猶予はマグニチュード起因。十分に進めて消えるまで回す）
      act(() => { h.current.injectEvent({ ...report('6', ['石川県能登']), isFinal: true }) })
      act(() => { vi.advanceTimersByTime(30 * 60_000) })
      expect(h.current.activeEEWs.size).toBe(0)

      // 台帳が残っていると #1 は「古い報」として弾かれ、二度と表示できなくなる
      act(() => { h.current.injectEvent(report('1', ['新潟県上越'])) })
      expect(areasOf(h)).toEqual(['新潟県上越'])
    } finally {
      vi.useRealTimers()
    }
  })

  // 安全弁 3: 取消はガードの手前で処理される。報番号で弾かれると誤報を消せなくなる。
  it('取消は報番号が古くても効く', () => {
    const h = setup()
    act(() => { h.current.injectEvent(report('5', ['石川県能登'])) })
    act(() => {
      h.current.injectEvent({ ...report('1', []), cancelled: true })
    })
    const eew = [...h.current.activeEEWs.values()][0]
    expect(eew?.cancelledAt).toBeInstanceOf(Date)
  })
})

// P2PQuake の補完経路（`enrichEEW`）。standard 版で Yahoo hypoInfo が先に検出した EEW へ
// 地域別予想震度を注入する経路で、キューを通らず WebSocket から直接呼ばれる。
//
// **この関数は退行防止の穴が 3 度続けて見つかった場所。** 状態しか見ていない／レンダー待ちの値と
// 比べている／台帳を経由しない——いずれもテストが無かったために気づけなかった。主経路と同じ
// 台帳で判定し、受理したら報番号も進めることを固定する。
describe('P2PQuake 補完経路も古い報で退行しない', () => {
  beforeEach(() => { mockIsDmdss = false })

  const AT = '2024-01-01T16:10:20+09:00'
  function p2pReport(serial: string, areaNames: string[]): EEWAlert {
    return {
      kind: 'eew',
      id: `p2p-eew-${serial}`,
      time: AT,
      test: false,
      earthquake: {
        originTime: AT,
        arrivalTime: AT,
        condition: '',
        hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 7.6 },
      },
      severity: 'Warning',
      cancelled: false,
      isFinal: false,
      issue: { eventId: 'enrich-event', serial, time: AT },
      areas: areaNames.map(name => ({ pref: '', name, scaleFrom: 40, scaleTo: 50, kindCode: '11', arrivalTime: null })),
    }
  }
  const areasOfEnrich = (h: ReturnType<typeof setup>) =>
    [...h.current.activeEEWs.values()][0]?.areas?.map(a => a.name) ?? []

  it('台帳より古い報番号の補完は適用しない', () => {
    const h = setup()
    act(() => { h.current.injectEvent(p2pReport('3', ['石川県能登'])) })
    act(() => { sockets[0].onEvent?.(p2pReport('2', ['新潟県上越'])) })
    expect(areasOfEnrich(h)).toEqual(['石川県能登'])
  })

  it('新しい報の補完は適用し、報番号も進める', () => {
    const h = setup()
    act(() => { h.current.injectEvent(p2pReport('3', ['石川県能登'])) })
    act(() => { sockets[0].onEvent?.(p2pReport('4', ['新潟県上越'])) })
    expect(areasOfEnrich(h)).toEqual(['新潟県上越'])
    // 報番号を据え置くと、格納した EEW の報番号が内容の新しさを表さなくなる
    expect([...h.current.activeEEWs.values()][0]?.issue?.serial).toBe('4')
  })

  // 補完で進めた報番号が台帳にも入っていないと、次に来る古い報を主経路が通してしまう。
  it('補完で進めた報番号は主経路の判定にも効く', () => {
    const h = setup()
    act(() => { h.current.injectEvent(p2pReport('3', ['石川県能登'])) })
    act(() => { sockets[0].onEvent?.(p2pReport('5', ['新潟県上越'])) })
    act(() => { h.current.injectEvent(p2pReport('4', ['富山県西部'])) })
    expect(areasOfEnrich(h)).toEqual(['新潟県上越'])
  })
})

// 取消の後に届いた報の結線。純粋関数側（`quakeMerge.test.ts`）は判定そのものを厚く固定して
// いるが、**それを正しい引数・正しいタイミングで呼んでいるか**はここでしか見えない。
// 台帳の受け渡しを 1 箇所忘れても型チェックもユニットテストも通ってしまう（実際に、実装途中で
// 台帳を作ったのに 1 箇所も渡していない状態が敵対的レビューで観測された）。
describe('DMDSS 版: 取消の後に届いた報', () => {
  const 発生時刻 = '2026-01-01T07:06:00+09:00'
  const 震度速報 = (id: string, time: string): JMAQuake => ({
    kind: 'quake',
    id,
    time,
    issue: { source: '気象庁', time, type: '震度速報', correct: 'なし' },
    earthquake: {
      time: 発生時刻,
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN },
      maxScale: 50,
      domesticTsunami: '調査中',
    },
    points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 50 }],
  })
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  const 取消 = (id: string, time: string): JMAQuake => ({
    ...震度速報(id, time),
    cancelled: true,
    earthquake: {
      time: '',
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 },
      maxScale: -1,
      domesticTsunami: '不明',
    },
    points: [],
  })

  it('取消より前に発表された報は、purge を過ぎて届いても採らない', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160610-1', '2026-01-01T07:07:00+09:00')) })
    expect(h.current.earthquakes).toHaveLength(1)

    // 取消を受けるとカードは 10 秒表示され、そのあと消える。
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160610-2', '2026-01-01T07:10:00+09:00')) })
    expect(h.current.earthquakes[0]?.cancelledAt).toBeInstanceOf(Date)
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(h.current.earthquakes).toHaveLength(0)

    // **カードが消えた後**に、取消より前に発表された報が遅れて届く。台帳が無いと復活する。
    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160610-3', '2026-01-01T07:09:00+09:00')) })
    expect(h.current.earthquakes).toHaveLength(0)
  })

  it('取消より後に発表された報は、別カードとして立てる', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160611-1', '2026-01-01T07:07:00+09:00')) })
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160611-2', '2026-01-01T07:10:00+09:00')) })
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(h.current.earthquakes).toHaveLength(0)

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160611-3', '2026-01-01T07:11:00+09:00')) })
    expect(h.current.earthquakes).toHaveLength(1)
  })

  it('取消の 10 秒表示中に続報が来ても、取消の表示と消滅を妨げない', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160612-1', '2026-01-01T07:07:00+09:00')) })
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160612-2', '2026-01-01T07:10:00+09:00')) })

    // 取消より後に発表された報。取消済みカードを置換せず、別カードとして立つ。
    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160612-3', '2026-01-01T07:11:00+09:00')) })
    expect(h.current.earthquakes.filter(q => q.cancelledAt)).toHaveLength(1)

    // purge が空振りせず、取消済みカードだけが消える。
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(h.current.earthquakes.filter(q => q.cancelledAt)).toHaveLength(0)
    expect(h.current.earthquakes).toHaveLength(1)
  })

  // `resetState` はリプレイの開始・停止でリプレイ制御側が呼ぶ（このフックは公開するだけ）。
  it('resetState で台帳を空にする（時間軸が変わるため）', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160613-1', '2026-01-01T07:07:00+09:00')) })
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160613-2', '2026-01-01T07:10:00+09:00')) })
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(h.current.earthquakes).toHaveLength(0)

    act(() => { h.current.resetState() })

    // 台帳が空いたので、同じ報がもう一度届けばカードになる。
    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160613-3', '2026-01-01T07:09:00+09:00')) })
    expect(h.current.earthquakes).toHaveLength(1)
  })

  // 台帳は件数に上限を置き、古いものから落とす。向きを取り違えると「直近の取消を忘れて古い取消を
  // 覚え続ける」形になり、症状は「取り消したはずの地震が復活する」——仕様書 §6.2 が塞いだ穴へ戻る。
  it('台帳が上限を超えたら古い記録から落とす', async () => {
    const h = setup()
    await h.flush()

    // 上限（20 件）を 1 件超える取消を、それぞれ別イベントとして入れる。
    // カードが無くても記録は残る（順序の入れ替わりで取消が先に届く場合に備えるため）。
    const eventIds = Array.from({ length: 21 }, (_, i) => `2026010117${String(i).padStart(4, '0')}`)
    for (const eventId of eventIds) {
      act(() => { h.current.injectEvent(取消(`dmdata-quake-${eventId}-1`, '2026-01-01T07:10:00+09:00')) })
    }

    // 最も古い取消は台帳から落ちているので、その報は弾かれずカードになる。
    act(() => {
      h.current.injectEvent(震度速報(`dmdata-quake-${eventIds[0]}-2`, '2026-01-01T07:09:00+09:00'))
    })
    expect(h.current.earthquakes).toHaveLength(1)

    // 2 件目以降は残っているので、引き続き弾かれる（落とす向きが逆でないことの確認）。
    act(() => {
      h.current.injectEvent(震度速報(`dmdata-quake-${eventIds[1]}-2`, '2026-01-01T07:09:00+09:00'))
    })
    expect(h.current.earthquakes).toHaveLength(1)
  })

  it('対照: resetState を挟まなければ、同じ報は引き続き弾かれる', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160614-1', '2026-01-01T07:07:00+09:00')) })
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160614-2', '2026-01-01T07:10:00+09:00')) })
    act(() => { vi.advanceTimersByTime(11_000) })

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160614-3', '2026-01-01T07:09:00+09:00')) })
    expect(h.current.earthquakes).toHaveLength(0)
  })
})

// 有効期限は報ではなく津波に付く事実として扱う（実データと理由は utils/tsunami の
// `latestValidDateTime`）。気象庁は期限が決まった報で一度だけ ValidDateTime を載せ、以後の
// 続報には載せない。報 1 通だけを見ると、最後の報が期限を持たない津波は失効しなくなる。
describe('津波の有効期限は報を跨いで引き継ぐ', () => {
  // 2024 年能登半島地震の並びに合わせる。10:00 の報が「01/02 17:00 まで」を伝え、10:03 の報は
  // 期限を持たない。以降、解除電文は出ない。
  const EXPIRE_AT = '2024-01-02T17:00:00+09:00'
  const WITH_EXPIRE = { id: 'noto-1', time: '2024-01-02T10:00:00+09:00', validDateTime: EXPIRE_AT }
  const WITHOUT_EXPIRE = { id: 'noto-2', time: '2024-01-02T10:03:00+09:00' }

  function forecast(opts: { id: string; time: string; validDateTime?: string; eventId?: string }): JMATsunami {
    return {
      kind: 'tsunami',
      id: opts.id,
      eventId: opts.eventId ?? 'noto-tsunami',
      time: opts.time,
      cancelled: false,
      validDateTime: opts.validDateTime,
      issue: { source: '気象庁', time: opts.time, type: 'Focus' },
      areas: [{ grade: 'Forecast', immediate: false, name: '石川県能登' }],
    }
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('期限を持たない続報を受けてもカードは期限を保つ', () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()

    act(() => { h.current.injectEvent(forecast(WITH_EXPIRE)) })
    act(() => { h.current.injectEvent(forecast(WITHOUT_EXPIRE)) })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].id).toBe('noto-2')
    expect(h.current.tsunamis[0].validDateTime).toBe(EXPIRE_AT)
  })

  it('日時として読めない期限を持つ続報でも、カードには前報の読める期限が残る', () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()

    act(() => { h.current.injectEvent(forecast(WITH_EXPIRE)) })
    act(() => { h.current.injectEvent(forecast({ ...WITHOUT_EXPIRE, validDateTime: '壊れた期限' })) })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].validDateTime).toBe(EXPIRE_AT)
  })

  it('履歴からの復元でも期限を引き継ぎ、期限を過ぎたら失効する', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    // 履歴は新しい順に並ぶとは限らないため、実装側の並べ替えに任せて逆順で渡す
    vi.mocked(fetchDmdataTsunamis).mockResolvedValue([forecast(WITH_EXPIRE), forecast(WITHOUT_EXPIRE)])
    const h = setup()
    await h.flush()

    expect(h.current.tsunamis).toHaveLength(1)
    expect(h.current.tsunamis[0].id).toBe('noto-2')

    act(() => { vi.advanceTimersByTime(9 * 60_000) })
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()

    act(() => { vi.advanceTimersByTime(2 * 60_000) })
    expect(h.current.tsunamis[0].cancelReason).toBe('expired')
  })

  it('履歴からの復元で、期限を過ぎていれば最初から表示しない', async () => {
    vi.setSystemTime(new Date('2024-01-02T17:30:00+09:00'))
    vi.mocked(fetchDmdataTsunamis).mockResolvedValue([forecast(WITH_EXPIRE), forecast(WITHOUT_EXPIRE)])
    const h = setup()
    await h.flush()

    expect(h.current.tsunamis).toEqual([])
  })

  // standard 版（P2PQuake）は 552 に期限相当のフィールドを持たないため、この引き継ぎは何もしない。
  // 「持たないこと」を固定しておく（API が拡張されて期限相当の値が現れたら、ここが落ちて気づける）。
  it('standard 版では期限を持たないため引き継ぎが働かず、解除電文で消えるまで残る', async () => {
    vi.setSystemTime(new Date('2024-01-02T17:30:00+09:00'))
    mockIsDmdss = false
    vi.mocked(fetchHistory).mockResolvedValue([
      { ...forecast(WITH_EXPIRE), eventId: undefined, validDateTime: undefined },
      { ...forecast(WITHOUT_EXPIRE), eventId: undefined, validDateTime: undefined },
    ] as unknown as AppEvent[])
    const h = setup()
    await h.flush()

    expect(h.current.tsunamis.map(t => t.id)).toEqual(['noto-2'])
    expect(h.current.tsunamis[0].validDateTime).toBeUndefined()
  })

  it('別イベントの報からは期限を引き継がない（無関係な期限で消さない）', async () => {
    vi.setSystemTime(new Date('2024-01-02T17:30:00+09:00'))
    vi.mocked(fetchDmdataTsunamis).mockResolvedValue([
      forecast({ ...WITH_EXPIRE, eventId: 'other-tsunami' }),
      forecast(WITHOUT_EXPIRE),
    ])
    const h = setup()
    await h.flush()

    expect(h.current.tsunamis.map(t => t.id)).toEqual(['noto-2'])
  })
})
