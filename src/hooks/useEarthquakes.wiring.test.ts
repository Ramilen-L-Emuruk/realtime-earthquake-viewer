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
import type { AppEvent, EEWAlert, JMAQuake, JMATsunami, JMANankaiCommentary, JMAQuakeNotice, JMAEarthquakeCount, JMAEstimatedIntensity } from '../types/earthquake'
import { serverDate, setReplayOffset } from '../utils/clock'
import { DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'
import { log } from '../utils/logger'
// **テストボタンのデータをここで先に読む。** 値は使わないが、これが無いと
// `simulate*` を最初に呼ぶテストが「このファイルで初回のモジュール解決・変換」を
// テスト本体の中で行うことになる —— 実データ 3 つで 824 KB あり、全ファイル並列実行では
// 他ワーカーとの順番待ちで数秒に伸びて、既定の 5 秒に届かない。トップレベルへ置けば
// 待ちはファイル読み込み時へ移り `testTimeout` の対象から外れる
// （同じ手当ての先例は `services/akamaiClock.test.ts` 冒頭）。
//
// **アプリの分割には影響しない。** 分割を作っているのは `utils/testDataLoader.ts` の
// `import()` で、テストファイルは本番ビルドの依存グラフに入らない
// （`utils/testData.test.ts` も同じく静的に取り込んでいる）。
import '../utils/testData'

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
  // 点の役割の判定へ渡す索引（→ quakePoints.ts の isAreaPoint）。この配線テストは区域名の
  // 衝突を見ないので、座標テーブル未読み込みと同じ null を返す。
  getAreaPrefIndexCache: vi.fn(() => null),
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

// テストボタンのデータ（`utils/testData.ts`）をここで読んでおく。**テスト本体の中で初めて
// 読ませない**ためで、値としては使わない。
//
// 実装はこれを `loadTestData()` の動的 import で読む（押されるまで読まない作り。理由は
// `utils/testDataLoader.ts`）。そのため最初に `simulate*` を呼ぶテストが、`testData.ts` が
// 抱える JSON 5 本（計 1.1 MB）の解決・変換を丸ごと自分の所要時間として負う。実測では
// このファイル単体の実行で 118ms、全ファイル並列実行だと他ワーカーとの順番待ちが乗って
// 907ms まで伸び、混雑した回は既定の 5 秒を超えて時間切れになった（同じファイルの他の
// テストはどれも 3ms 前後）。**1 件目が時間切れになると、以降 95 件が `h.current` を
// null として掴んで連鎖的に落ちる**ので、症状は「このファイルだけ全滅」に見える。
//
// トップレベルで一度読めば、待ちはファイル読み込み時へ移って `testTimeout` の対象から
// 外れる（→ CLAUDE.md「検証」節）。
//
// 引き換えに、読み込みに失敗したときはこのファイルが丸ごと落ちる（前は `simulate*` を使う
// テストだけが落ちた）。読むのは生成済みの JSON なので失敗の目は薄いと見て、単純さを採る。
await import('../utils/testData')

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

  /**
   * 最終報の EEW。規模を小さく取り、猶予が下限（60 秒）で決まるようにする。
   *
   * `time` / `originTime` は上書きできる。**解除時刻はこの 2 つから決まる**ので、
   * 読めない値を入れたときの振る舞いをここで作れる（→ 下の「解除時刻を決められないとき」）。
   */
  function finalEEW(at: Date, override: { time?: string; originTime?: string } = {}): EEWAlert {
    const iso = at.toISOString()
    return {
      kind: 'eew',
      id: 'replay-final',
      time: override.time ?? iso,
      test: false,
      earthquake: {
        originTime: override.originTime ?? iso,
        arrivalTime: iso,
        condition: '',
        hypocenter: { name: 'テスト沖', latitude: 35, longitude: 140, depth: 10, magnitude: 4.0 },
      },
      severity: 'Forecast',
      cancelled: false,
      isFinal: true,
      issue: { eventId: 'replay-final-event', serial: '2', time: override.time ?? iso },
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

  // ---- 解除時刻を決められないとき ----
  //
  // 自動解除はこの 1 回の予約が全てで、キューは発火時刻が読めないエントリを捨てる。
  // **捨てられるとその EEW は取消が来るまで画面に残り続ける。**

  // 正: 発表時刻が読めなくても震源時刻が読めれば予約できる（`calcEEWCancelTime`）。
  it('発表時刻が読めなくても、震源時刻から自動解除を予約する', () => {
    setReplayOffset(OFFSET_MS)
    const h = setup({ offset: OFFSET_MS })

    act(() => { h.current.injectEvent(finalEEW(serverDate(), { time: '' })) })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { vi.advanceTimersByTime(31_000) })
    expect(h.current.activeEEWs.size).toBe(0)
  })

  // 安全弁: どちらも読めなければ予約できない。**そのことを記録する** ——
  // キューの汎用ログ（発火時刻が読めないエントリを捨てた）だけでは、
  // 「なぜこの EEW が消えないか」に辿り着けない。
  it('発表時刻も震源時刻も読めなければ、予約できないことを記録する', () => {
    // このファイルは `log` 全体をモックしている（冒頭の `vi.mock`）ので、`vi.spyOn` を
    // 重ねず素の呼び出し履歴を見る。他のテストの分が混ざらないよう先に落とす。
    const err = vi.mocked(log.error)
    err.mockClear()
    setReplayOffset(OFFSET_MS)
    const h = setup({ offset: OFFSET_MS })

    act(() => { h.current.injectEvent(finalEEW(serverDate(), { time: '', originTime: '' })) })
    expect(h.current.activeEEWs.size).toBe(1)
    expect(err.mock.calls.filter(c => String(c[0]).includes('自動解除を予約できません'))).toHaveLength(1)

    // 予約が無いので猶予を過ぎても消えない（取消が来るまで残る）
    act(() => { vi.advanceTimersByTime(300_000) })
    expect(h.current.activeEEWs.size).toBe(1)
  })
})

// キュー配列の identity。津波の失効予約の張り替えはキューの中身に触るが、**配列を作り直しては
// いけない**。ディスパッチャは 1 ティックで複数のエントリを続けて処理するため、その途中で
// 差し替えると、それ以降に取り出した電文が差し替え前の配列からしか消えず、新しい配列には
// 残ったままになる。次のティックはその配列を先頭から読むので同じ電文を再処理する。
//
// 実測（2024-01-02 16:59 からの再生）では地震情報 1 通で受信音が 15 回鳴り、キューからの
// 取り出しが 3779 回に達した。画面には「同じカードが更新され続ける」ようにしか映らず、
// 型検査でも例外でも捕まらないため、ここで固定する。
describe('キューは配列を差し替えない（同じ電文を二度処理しない）', () => {
  const OFFSET_MS = -3600_000

  /** 有効期限を持つ津波。処理すると失効予約の張り替えが走る（キューの中身に触る形）。 */
  const 津波 = (at: Date, validForMs: number, 連番 = 1): JMATsunami => {
    const iso = at.toISOString()
    return {
      kind: 'tsunami',
      id: `queue-identity-tsunami-${連番}`,
      eventId: `queue-identity-tsunami-event-${連番}`,
      time: iso,
      cancelled: false,
      validDateTime: new Date(at.getTime() + validForMs).toISOString(),
      issue: { source: '気象庁', time: iso, type: 'Focus' },
      areas: [{ grade: 'Forecast', immediate: false, name: 'テスト沿岸' }],
    }
  }

  /** 津波より後ろへ積む地震情報。通知が 1 回だけであることを見る。 */
  const 地震情報 = (at: Date, 連番 = 1): JMAQuake => {
    const iso = at.toISOString()
    return {
      kind: 'quake',
      id: `queue-identity-quake-${連番}`,
      time: iso,
      issue: { source: '気象庁', time: iso, type: '震源・震度情報', correct: 'なし' },
      earthquake: {
        time: iso,
        hypocenter: { name: 'テスト沖', latitude: 35, longitude: 140, depth: 10, magnitude: 4.0 },
        maxScale: 10,
        domesticTsunami: 'なし',
      },
      points: [{ pref: '', addr: 'テスト県北部', isArea: true, scale: 10 }],
    }
  }

  const 地震の通知数 = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.filter(([e]) => (e as AppEvent).kind === 'quake').length

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  it('津波と同じティックで処理した地震情報を、一度だけ通知する', () => {
    setReplayOffset(OFFSET_MS)
    const onLiveEvent = vi.fn()
    const h = setup({ offset: OFFSET_MS, onLiveEvent })
    const at = serverDate()

    // 津波を先に積む。**この順序が要る**——張り替えは津波の処理で走るので、地震情報が
    // その後ろに無いと差し替えの影響を受けるエントリが存在しない。
    act(() => {
      h.current.loadReplayEvents([
        { payload: { kind: 'event', event: 津波(at, 60_000) }, replayTime: at },
        { payload: { kind: 'event', event: 地震情報(at) }, replayTime: at },
      ])
    })

    act(() => { vi.advanceTimersByTime(100) })
    expect(地震の通知数(onLiveEvent)).toBe(1)

    // ティックを回し続けても増えない（キューに残っていない）。
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(地震の通知数(onLiveEvent)).toBe(1)
  })

  // 実際の再現（2024-01-02 16:59 開始）ではキューに数十件が並び、張り替えは何度も起きていた。
  // 上の 2 件構成は最小の再現形でしかないため、**張り替えが連鎖する形**も固定する。ここが無いと、
  // 「1 回の差し替えだけ避ける」ような部分的な直し方でもテストが通ってしまう。
  it('張り替えが続けて起きても、後ろの電文をそれぞれ一度だけ通知する', () => {
    setReplayOffset(OFFSET_MS)
    const onLiveEvent = vi.fn()
    const h = setup({ offset: OFFSET_MS, onLiveEvent })
    const at = serverDate()

    act(() => {
      h.current.loadReplayEvents([
        { payload: { kind: 'event', event: 津波(at, 60_000, 1) }, replayTime: at },
        { payload: { kind: 'event', event: 地震情報(at, 1) }, replayTime: at },
        { payload: { kind: 'event', event: 津波(at, 90_000, 2) }, replayTime: at },
        { payload: { kind: 'event', event: 地震情報(at, 2) }, replayTime: at },
      ])
    })

    act(() => { vi.advanceTimersByTime(100) })
    expect(地震の通知数(onLiveEvent)).toBe(2)

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(地震の通知数(onLiveEvent)).toBe(2)
  })

  // 発火時刻が日時として読めないエントリは、積む時点で弾く。取り出し側では弾けない——NaN は
  // `<=` と `>` のどちらとも偽になるため、判定の書き方で「即座に発火する」と「以後すべて止まる」の
  // どちらかに転ぶ（どちらの形がどちらへ転ぶかは `EventQueue` の `push` の注記）。**どちらの壊れ方も
  // ログにも例外にも出ない**ため、入口で弾いていることをここで固定する。
  it('発火時刻が読めないエントリは積まず、後続の電文を止めない', () => {
    setReplayOffset(OFFSET_MS)
    const onLiveEvent = vi.fn()
    const h = setup({ offset: OFFSET_MS, onLiveEvent })
    const at = serverDate()

    act(() => {
      h.current.loadReplayEvents([
        { payload: { kind: 'event', event: 地震情報(at, 1) }, replayTime: new Date(NaN) },
        { payload: { kind: 'event', event: 地震情報(at, 2) }, replayTime: at },
      ])
    })

    act(() => { vi.advanceTimersByTime(100) })
    // 読めない時刻の 1 件目は積まれず、2 件目だけが通る（1 件目で止まらない・1 件目が即発火しない）
    const 通知された = onLiveEvent.mock.calls
      .map(([e]) => e as AppEvent)
      .filter(e => e.kind === 'quake')
      .map(e => (e as JMAQuake).id)
    expect(通知された).toEqual(['queue-identity-quake-2'])
  })

  it('張り替えは効いたままで、続報で期限を延ばすと古い予約は消える', () => {
    setReplayOffset(OFFSET_MS)
    const h = setup({ offset: OFFSET_MS })
    const at = serverDate()

    // 初報の期限は 60 秒後、続報で 120 秒後へ延ばす。古い予約が残っていれば 60 秒で失効する。
    act(() => { h.current.injectEvent(津波(at, 60_000)) })
    act(() => { h.current.injectEvent(津波(at, 120_000)) })

    act(() => { vi.advanceTimersByTime(70_000) })
    expect(h.current.tsunamis[0].cancelledAt).toBeUndefined()

    act(() => { vi.advanceTimersByTime(60_000) })
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

  it('続報は報番号と発表時刻だけを進め、震源時刻は初報のまま保つ', async () => {
    const h = setup()

    await act(async () => { await h.current.simulateEEWForecast() })
    const first = onlyEEW(h)
    expect(first.issue?.serial).toBe('1')
    expect(first.isFinal).toBeFalsy()

    // 沈黙時間（10 秒）より短い間隔なら続報になる
    act(() => { vi.advanceTimersByTime(3_000) })
    await act(async () => { await h.current.simulateEEWForecast() })
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

  it('最終報も独立した 1 報として報番号を進める', async () => {
    const h = setup()

    await act(async () => { await h.current.simulateEEWForecast() })
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
  it('誤報取消も独立した 1 報として報番号を進め、対象地域を持たない', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    await act(async () => { await h.current.simulateEEWRetraction() })
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

  // 取消しの概要（電文の `Body/Text`）は XML を読む dmdataParser でしか作れない。
  // 津波の解除テストと同じ形で、バリアントの境目を正・対照の対で固定する。
  it('DMDSS 版: 誤報取消は取消しの概要を持つ', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    await act(async () => { await h.current.simulateEEWRetraction() })
    act(() => { vi.advanceTimersByTime(10_000) })

    const cancel = events.filter((e): e is EEWAlert => e.kind === 'eew')[1]
    expect(cancel.cancelled).toBe(true)
    expect(cancel.cancelText).toBeTruthy()
  })

  // 対照: standard 版の P2PQuake には対応するフィールドが無い。テストボタンが実電文の形から
  // 外れると、実機では一度も起きない表示・読み上げが「起きる」ように見える
  it('standard 版: 取消しの概要を持たない（P2PQuake には無い項目）', async () => {
    mockIsDmdss = false
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    await act(async () => { await h.current.simulateEEWRetraction() })
    act(() => { vi.advanceTimersByTime(10_000) })

    const cancel = events.filter((e): e is EEWAlert => e.kind === 'eew')[1]
    expect(cancel.cancelled).toBe(true)
    expect(cancel.cancelText).toBeUndefined()
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

  /**
   * 初回履歴の取り込みを先に流し切る。
   *
   * テストデータは動的 import で読むので、シミュレーション関数は Promise を返す。それを await
   * すると**同じ待ちのあいだに初回履歴取得（`fetchDmdataTsunamis` 等）の解決も進む**ため、
   * 順番しだいで履歴の `setState` が、いま流したテスト電文を上書きする。症状は
   * **「`onLiveEvent` には 2 通とも届いているのにカードが空」** —— 電文の形を見る assertion は
   * 通り、state を見る assertion だけが落ちるので、電文側だけ確かめていると気づけない。
   *
   * `setup()` の直後に空の act を 1 度回して初回取り込みを終わらせておけば、以後は競合しない。
   */
  async function flushInitialLoad() {
    await act(async () => {})
  }

  it('DMDSS 版: 解除は区域を空にし、発表時刻を解除時点へ進める', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    await flushInitialLoad()

    await act(async () => { await h.current.simulateTsunamiWatch() })
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

  // 取消電文だけが持つ項目は、表示中のカードを土台にする更新で**名指しで移さないと落ちる**。
  // パーサーも読み上げも通っているのに画面にだけ出ない、という形になり、型検査でも捕まらない
  // （オプショナルなので）。実際にブラウザ確認で見つかった。
  it('DMDSS 版: 誤報取消の理由をカードへ引き継ぐ', async () => {
    const h = setup()
    await flushInitialLoad()
    await act(async () => { await h.current.simulateTsunamiRetraction() })
    act(() => { vi.advanceTimersByTime(90_000) })

    expect(h.current.tsunamis[0]?.cancelReason).toBe('retracted')
    expect(h.current.tsunamis[0]?.cancelText).toBeTruthy()
  })

  // 対照: 解除（`lifted`）は取消電文ではないので理由を持たない。**無いものを作らない**
  it('解除では取消の理由を持たない', async () => {
    const h = setup()
    await flushInitialLoad()
    await act(async () => { await h.current.simulateTsunamiWatch() })
    act(() => { vi.advanceTimersByTime(90_000) })

    expect(h.current.tsunamis[0]?.cancelReason).toBe('lifted')
    expect(h.current.tsunamis[0]?.cancelText).toBeUndefined()
  })

  it('standard 版: 解除理由と eventId を持たない（P2PQuake では判別できない項目）', async () => {
    mockIsDmdss = false
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })

    await flushInitialLoad()

    await act(async () => { await h.current.simulateTsunamiRetraction() })
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

    // 取消はライブ受信経路（injectEvent は AppEvent 専用なので、キュー経由の payload を使う）。
    // **取消は対象と同じ `eventId` を持つ**（電文解説資料 Ⅰ.別紙ウ「独立した情報単位」）ので、
    // フィクスチャもその形にする。
    act(() => {
      h.current.loadReplayEvents([{
        payload: { kind: 'nankaiCommentary', data: { ...commentary('c-live', 60_000), cancelled: true } },
        replayTime: serverDate(),
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })
    expect(h.current.nankaiCommentary).toBeNull()
  })

  // 安全弁: 別の情報単位に向けた取消で、いま出ている帯を消さない。気象庁は発表ごとに別の
  // `EventID` を割り振るため（同 Ⅰ.別紙エ）、遅れて届いた古い取消がこの形で来うる
  it('別の eventId に向けた取消では帯を消さない', async () => {
    vi.mocked(fetchDmdataNankaiCommentary).mockResolvedValue(commentary('c-live', 60_000))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary?.id).toBe('c-live')

    act(() => {
      h.current.loadReplayEvents([{
        payload: { kind: 'nankaiCommentary', data: { ...commentary('c-other', 60_000), cancelled: true } },
        replayTime: serverDate(),
      }])
    })
    act(() => { vi.advanceTimersByTime(50) })
    expect(h.current.nankaiCommentary?.id).toBe('c-live')
  })
})

describe('地震・津波に関するお知らせ（VZSE40）と地震回数（VXSE60）の結線', () => {
  // どちらも**実配信では観測できていない種別**（電文一覧 13 か月で 0 通）。実機で偶然踏んで
  // 気づくことが期待できないぶん、畳み方と取消の照合はここで固定しておく。

  /** expireInMs 後に期限が切れるお知らせ。 */
  function notice(id: string, expireInMs: number): JMAQuakeNotice {
    const now = serverDate()
    return {
      id,
      time: now.toISOString(),
      eventId: `${id}-event`,
      headline: '沖縄県の震度データ入電停止のお知らせ',
      body: '本文',
      cancelled: false,
      reportDateTime: now.toISOString(),
      expireAt: new Date(now.getTime() + expireInMs).toISOString(),
    }
  }

  /** 区間を items 件持つ地震回数の報。`expireInMs` 後に期限が切れる。 */
  function count(eventId: string, items: JMAEarthquakeCount['items'], expireInMs = 60_000): JMAEarthquakeCount {
    const now = serverDate()
    return {
      id: `dmdata-quake-count-${eventId}-1`,
      time: now.toISOString(),
      eventId,
      headline: '地震回数に関する情報をお知らせします。',
      items,
      cancelled: false,
      reportDateTime: now.toISOString(),
      expireAt: new Date(now.getTime() + expireInMs).toISOString(),
    }
  }

  const item = (type: string, number: number, feltNumber: number): JMAEarthquakeCount['items'][number] => ({
    type,
    startTime: serverDate().toISOString(),
    endTime: serverDate().toISOString(),
    number,
    feltNumber,
  })

  /** キュー経由で 1 件流す（`injectEvent` は AppEvent 専用なのでこちらを使う）。 */
  function push(h: ReturnType<typeof setup>, payload: import('../types/replay').ReplayPayload) {
    act(() => { h.current.loadReplayEvents([{ payload, replayTime: serverDate() }]) })
    act(() => { vi.advanceTimersByTime(50) })
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // 正: 帯を出し、7 日（ここでは短縮した期限）で畳む。
  it('お知らせは期限で畳む', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-live', 5_000) })
    expect(h.current.quakeNotice?.id).toBe('n-live')

    act(() => { vi.advanceTimersByTime(5_001) })
    expect(h.current.quakeNotice).toBeNull()
  })

  // 対照: 期限切れのお知らせは載せない（リプレイで過去の窓を再生したときに出ないこと）。
  it('期限切れのお知らせは載せない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-stale', -1_000) })
    expect(h.current.quakeNotice).toBeNull()
  })

  // 正: 取消で帯を消す。**照合は `id`** ―― お知らせは 1 通ごとに `EventID` が変わるので、
  // 表示中の報そのものを指せるのは id のほう。
  it('取消電文で帯を消す', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    expect(h.current.quakeNotice?.id).toBe('n-live')

    push(h, { kind: 'quakeNotice', data: { ...notice('n-live', 60_000), cancelled: true } })
    expect(h.current.quakeNotice).toBeNull()
  })

  // 安全弁: 別のお知らせに向けた取消で、いま出ている帯を消さない。
  it('別のお知らせに向けた取消では帯を消さない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    push(h, { kind: 'quakeNotice', data: { ...notice('n-other', 60_000), cancelled: true } })
    expect(h.current.quakeNotice?.id).toBe('n-live')
  })

  // 正: 地震回数も**期限で畳む**。気象庁はこの情報の終わりを宣言しない（群発が収まれば発表が
  // 止まるだけ）ので、次報と取消だけを畳む契機にすると、収まったあとも帯が居座る。
  //
  // 対照として、期限がまだ来ていない報は残ることも見る（「いつでも消える」ではないこと）。
  // （7 日ぶんの時間を進める形にはしない —— キューの巡回が 10ms 間隔で、6000 万回まわる。）
  it('地震回数は期限で畳む', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)], 5_000) })
    expect(h.current.earthquakeCount?.items[0].number).toBe(1704)

    act(() => { vi.advanceTimersByTime(4_000) })
    expect(h.current.earthquakeCount?.items[0].number).toBe(1704)

    act(() => { vi.advanceTimersByTime(1_001) })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 対照: 期限切れの報は載せない（リプレイで過去の窓を再生したときに出ないこと）。
  it('期限切れの地震回数は載せない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)], -1_000) })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 正: 続報で置き換わる。
  it('地震回数は続報で置き換わる', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1810, 2)]) })
    expect(h.current.earthquakeCount?.items[0].number).toBe(1810)
  })

  // 正: 取消でカードを消す。**照合は `eventId`** ―― 回数情報は同じ群発について報を重ねるので、
  // 取消が指すのは「その群発について直前に出した報」になる。
  it('地震回数は取消で帯を消す', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    push(h, { kind: 'earthquakeCount', data: { ...count('20080824150500', []), cancelled: true } })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 安全弁: 別の群発に向けた取消では消さない。
  it('別の群発に向けた取消では帯を消さない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    push(h, { kind: 'earthquakeCount', data: { ...count('20260101000000', []), cancelled: true } })
    expect(h.current.earthquakeCount?.eventId).toBe('20080824150500')
  })

  // 安全弁: 区間が 1 つも読めなかった報は帯にしない。中身が空の帯を出しても伝わる
  // ものが無く、読み取りの失敗はパーサー側が記録している。
  it('区間が空の報は帯にしない', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', []) })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 安全弁: リセット（リプレイの開始・ライブ復帰）で両方とも消える。**時間軸が変わる**ので、
  // 前の軸で出した帯を残すと、再生時刻と食い違ったものが画面に居座る。
  it('リセットで両方の帯が消える', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    expect(h.current.quakeNotice).not.toBeNull()
    expect(h.current.earthquakeCount).not.toBeNull()

    act(() => { h.current.resetState() })
    expect(h.current.quakeNotice).toBeNull()
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 安全弁: **種別をまたいで記憶を巻き込まない。** お知らせの取消処理が地震回数の識別子まで
  // `null` にしていたことがある（別の種別の行が紛れ込んでいた）。こうなると、そのあと届いた
  // 本物の取消が「別の群発への取消」と誤判定されて帯が消えず、しかもログには
  // それらしい説明が出るので気づけない。
  it('お知らせの取消は地震回数の記憶を巻き込まない', () => {
    const h = setup()
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    push(h, { kind: 'quakeNotice', data: { ...notice('n-live', 60_000), cancelled: true } })
    expect(h.current.quakeNotice).toBeNull()

    // ここで地震回数の記憶が消えていると、この取消が効かない
    push(h, { kind: 'earthquakeCount', data: { ...count('20080824150500', []), cancelled: true } })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 安全弁: リセットは**表示中の識別情報の記憶も落とす**。落とし忘れると、リセット後に
  // 届いた取消が「消えた帯」の id と照合され、次に出した帯を消せなくなる。
  // **帯とカードの両方で見る** —— 記憶は種別ごとに別の ref なので、片方だけ落とす形になりやすい。
  it('リセット後に同じお知らせ・同じ地震回数を出し直せる', async () => {
    const h = setup()
    await h.flush()
    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    act(() => { h.current.resetState() })

    push(h, { kind: 'quakeNotice', data: notice('n-live', 60_000) })
    push(h, { kind: 'earthquakeCount', data: count('20080824150500', [item('累積地震回数', 1704, 1)]) })
    expect(h.current.quakeNotice?.id).toBe('n-live')
    expect(h.current.earthquakeCount?.eventId).toBe('20080824150500')

    push(h, { kind: 'quakeNotice', data: { ...notice('n-live', 60_000), cancelled: true } })
    push(h, { kind: 'earthquakeCount', data: { ...count('20080824150500', []), cancelled: true } })
    expect(h.current.quakeNotice).toBeNull()
    expect(h.current.earthquakeCount).toBeNull()
  })
})

// 推計震度分布図（IXAC41）の結線。
//
// 判定そのものは純関数へ切り出してテストしてある（`utils/estimatedIntensity.test.ts`）。
// **ここで見るのは包み側** —— 反映しないと決めた報で `onLiveEvent` まで止まること。
// 止め損ねると、画面の分布は据え置きのまま**音と読み上げだけが鳴り、分布モードが勝手に開く**。
// 判定が正しくても包み側で漏れるので、純関数のテストでは捕まらない。
describe('推計震度分布図（IXAC41）の結線', () => {
  function ei(arrivalTime: string, time: string, count: number): JMAEstimatedIntensity {
    return {
      id: `ix-${time}`, time, arrivalTime,
      hypocenter: { lat: 32.6, lon: 130.7, depthKm: 10 },
      magnitude: 4.2, areaCode: 741, telegramKind: 0,
      grades: [{ scale: 4, modifier: 'none', lower: 35, upper: 44 }],
      count,
      lat: new Float32Array([32.6]), lon: new Float32Array([130.7]), si: new Uint8Array([42]),
      bounds: { south: 32.6, north: 32.61, west: 130.7, east: 130.71 },
    }
  }
  const KUMA = ei('2026-07-28T07:27:00.000Z', '2026-07-28T07:32:00+09:00', 1693)
  const LATER = ei('2026-07-28T07:31:00.000Z', '2026-07-28T07:36:00+09:00', 812)

  // `kind` を文字列として比べるのは、`AppEvent` が地震・津波・EEW の 3 つしか型で持たず、
  // それ以外の種別（長周期・南海トラフ・地震回数・これ）は送出側で型を潰して渡しているため
  // （`useEarthquakes.ts` の `as unknown as AppEvent`。6 種別で同じ形）。
  function push(h: ReturnType<typeof setup>, data: JMAEstimatedIntensity) {
    act(() => { h.current.loadReplayEvents([{ payload: { kind: 'estimatedIntensity', data }, replayTime: serverDate() }]) })
    act(() => { vi.advanceTimersByTime(50) })
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // 正: 届いた分布を反映し、音と読み上げの経路へも流す。
  it('届いた分布を反映して鳴らす経路へ流す', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    expect(h.current.estimatedIntensity?.arrivalTime).toBe(KUMA.arrivalTime)
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(1)
  })

  // 正: 別の地震の新しい分布へは入れ替える（アプリが持つのは最新の 1 通だけ）。
  it('別の地震の新しい分布へ入れ替える', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    push(h, LATER)
    expect(h.current.estimatedIntensity?.arrivalTime).toBe(LATER.arrivalTime)
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(2)
  })

  // 対照: **発表が古い報では退行しない。別の地震のものでも採らない。**
  // 到着順は発表順と一致しない（分割の結合が遅れる・当日経路とライブが前後する）ので、
  // 震度5弱以上が短時間に続く場面で、遅れて届いた古い分布が新しい分布を押しのけうる。
  it('発表が古い報では退行しない', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, LATER)
    push(h, KUMA)
    expect(h.current.estimatedIntensity?.arrivalTime).toBe(LATER.arrivalTime)
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(1)
  })

  // 安全弁: **反映しない報では鳴らす経路へも流さない。** 内容が同じ重複配信は実電文で
  // 観測している。流すと画面は変わらないのに音と読み上げだけが二度鳴る。
  it('内容が同じ重複配信では鳴らす経路へ流さない', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    push(h, { ...KUMA })
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(1)
  })

  // 安全弁: リセットで記憶も落とす。落とし忘れると、再生し直した同じ分布が
  // 「重複配信」と判定されて二度と出なくなる。
  it('リセット後に同じ分布を出し直せる', async () => {
    const h = setup()
    await h.flush()
    push(h, KUMA)
    act(() => { h.current.resetState() })
    expect(h.current.estimatedIntensity).toBeNull()

    push(h, KUMA)
    expect(h.current.estimatedIntensity?.arrivalTime).toBe(KUMA.arrivalTime)
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

  // 取消電文だけが持つ項目は、**表示中の EEW を土台にする更新で名指しで移さないと落ちる**。
  // 地震・津波側と対の回帰テスト（3 種別すべての状態更新に同じ落とし穴がある）。
  // 描画側のテスト（`RealtimeTab/cancelReason.test.tsx`）は `EEWAlert` を直接渡すので
  // ここを通らない。両方無いと「電文は持っているのに画面へ届かない」を捕まえられない。
  it('取消の理由を表示中の EEW へ引き継ぐ', () => {
    const h = setup()
    act(() => { h.current.injectEvent(report('1', ['石川県能登'])) })
    act(() => {
      h.current.injectEvent({
        ...report('2', []),
        cancelled: true,
        cancelText: 'システムの障害により誤った緊急地震速報を配信しました。',
      })
    })
    const eew = [...h.current.activeEEWs.values()][0]
    expect(eew?.cancelledAt).toBeInstanceOf(Date)
    expect(eew?.cancelText).toBe('システムの障害により誤った緊急地震速報を配信しました。')
  })

  // 対照: 理由を持たない取消電文では作らない（無いものを埋めない）
  it('理由を持たない取消では持たせない', () => {
    const h = setup()
    act(() => { h.current.injectEvent(report('1', ['石川県能登'])) })
    act(() => { h.current.injectEvent({ ...report('2', []), cancelled: true }) })
    const eew = [...h.current.activeEEWs.values()][0]
    expect(eew?.cancelledAt).toBeInstanceOf(Date)
    expect(eew?.cancelText).toBeUndefined()
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

  // 取消電文だけが持つ項目は、**表示中のカードを土台にする更新で名指しで移さないと落ちる**。
  // 津波側と対の回帰テスト。パーサーも読み上げも通り、オプショナルなので型検査も素通りするため、
  // ここが無いと「画面にだけ出ない」状態を検出できない。
  it('取消の理由をカードへ引き継ぐ', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160612-1', '2026-01-01T07:07:00+09:00')) })
    act(() => {
      h.current.injectEvent({
        ...取消('dmdata-quake-20260101160612-2', '2026-01-01T07:10:00+09:00'),
        cancelText: '先ほどの地震情報は誤りでしたので取り消します。',
      })
    })

    expect(h.current.earthquakes[0]?.cancelledAt).toBeInstanceOf(Date)
    expect(h.current.earthquakes[0]?.cancelText).toBe('先ほどの地震情報は誤りでしたので取り消します。')
  })

  // 対照: 理由を持たない取消電文では作らない（無いものを埋めない）
  it('理由を持たない取消では持たせない', async () => {
    const h = setup()
    await h.flush()

    act(() => { h.current.injectEvent(震度速報('dmdata-quake-20260101160613-1', '2026-01-01T07:07:00+09:00')) })
    act(() => { h.current.injectEvent(取消('dmdata-quake-20260101160613-2', '2026-01-01T07:10:00+09:00')) })

    expect(h.current.earthquakes[0]?.cancelledAt).toBeInstanceOf(Date)
    expect(h.current.earthquakes[0]?.cancelText).toBeUndefined()
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

  // 電文の本文（`Body/Text`）も報を跨いで引き継ぐ。**気象庁は毎報には載せない** ——
  // 実電文を数えると津波予報の VTSE41 の半数に入るだけで、続報の VTSE51/52 には 1 通も無い。
  // 引き継がないと「いつ来ていつまで続くか」が最初の観測情報で消える（この等級では区域に
  // 波高も到達時刻も付かないので、その文にしか無い）。
  it('本文を持たない続報を受けてもカードは本文を保つ', () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()
    const BODY = '若干の海面変動が予想される時刻は、早い沿岸で０２日１０時３０分頃です。'

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), bodyText: BODY }) })
    act(() => { h.current.injectEvent(forecast(WITHOUT_EXPIRE)) })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].id).toBe('noto-2')
    expect(h.current.tsunamis[0].bodyText).toBe(BODY)
  })

  // 対照: 新しい報が本文を持てばそちらへ従う（前報で固定しない）
  it('本文を持つ続報ではそちらへ差し替わる', () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), bodyText: '前の本文' }) })
    act(() => { h.current.injectEvent({ ...forecast(WITHOUT_EXPIRE), bodyText: '新しい本文' }) })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].bodyText).toBe('新しい本文')
  })

  // 安全弁: 別の津波へ持ち込まない。引き継ぎは `isTsunamiContinuation`（`eventId` 一致）の
  // 内側でしか働かないことを固定する —— 緩めると、無関係な津波の本文を出すことになる。
  it('別イベントの津波には前報の本文を引き継がない', () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), bodyText: '能登の本文' }) })
    act(() => {
      h.current.injectEvent(forecast({ ...WITHOUT_EXPIRE, eventId: 'hyuganada-tsunami' }))
    })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].bodyText).toBeUndefined()
  })

  // 観測状況を確定した時刻（`Head/TargetDateTime`）も `bodyText` と同じ `sameEvent` の内側で
  // 引き継ぐ。**3 つのフィールドが同じ門を共有している**ので、片方だけ門を狭める変更が
  // 入っても気づけるよう、それぞれに対を置く。
  //
  // 正: 観測時点を持たない続報（等級の発表）が挟まっても、前報の値が残る。入るのは観測情報
  // （VTSE51/52）だけなので、落とすとカードの「観測 ◯◯ 時点」が出たり消えたりする。
  it('観測時点を持たない続報が挟まっても前報の観測時点が残る', () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), observationDateTime: '2024-01-02T16:45:00+09:00' }) })
    act(() => { h.current.injectEvent(forecast(WITHOUT_EXPIRE)) })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].observationDateTime).toBe('2024-01-02T16:45:00+09:00')
  })

  // 対照: 新しい観測時点を持つ続報が来たらそちらへ従う（古い値に居座らせない）。
  it('新しい観測時点を持つ続報ではそちらへ従う', () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), observationDateTime: '2024-01-02T16:45:00+09:00' }) })
    act(() => { h.current.injectEvent({ ...forecast(WITHOUT_EXPIRE), observationDateTime: '2024-01-02T16:48:00+09:00' }) })
    act(() => { act(() => { vi.advanceTimersByTime(100) }) })

    expect(h.current.tsunamis[0].observationDateTime).toBe('2024-01-02T16:48:00+09:00')
  })

  // 安全弁: 別の津波へ持ち込まない（`bodyText` と同じ門の内側であることを固定する）。
  it('別イベントの津波には前報の観測時点を引き継がない', () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const h = setup()

    act(() => { h.current.injectEvent({ ...forecast(WITH_EXPIRE), observationDateTime: '2024-01-02T16:45:00+09:00' }) })
    act(() => {
      h.current.injectEvent(forecast({ ...WITHOUT_EXPIRE, eventId: 'hyuganada-tsunami' }))
    })
    act(() => { vi.advanceTimersByTime(100) })

    expect(h.current.tsunamis[0].observationDateTime).toBeUndefined()
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

  // **ライブ受信では出るのにリロードすると消える、を防ぐ。** 履歴からの復元は最新の 1 報だけを
  // 画面へ載せるため、続報の上書きと同じものを引き継がないと片方だけ落ちる。
  it('履歴からの復元でも本文を引き継ぐ', async () => {
    vi.setSystemTime(new Date('2024-01-02T16:50:00+09:00'))
    const BODY = '若干の海面変動が予想される時刻は、早い沿岸で０２日１０時３０分頃です。'
    vi.mocked(fetchDmdataTsunamis).mockResolvedValue([
      { ...forecast(WITH_EXPIRE), bodyText: BODY },
      forecast(WITHOUT_EXPIRE),
    ])
    const h = setup()
    await h.flush()

    expect(h.current.tsunamis[0].id).toBe('noto-2')
    expect(h.current.tsunamis[0].bodyText).toBe(BODY)
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

// 南海トラフ臨時情報の取消は「その電文が指す情報単位」だけを消す。
//
// **ライブ受信（WebSocket）とキュー（リプレイ・テストボタン）の 2 経路がある。** 規則を片方に
// しか書かなかったため、テストとリプレイでは防げるのに本番の受信では素通りする、という状態を
// 一度作った。ここで両経路を通す。
describe('南海トラフ臨時情報の取消の適用先', () => {
  function nankai(eventId: string, o: Record<string, unknown> = {}) {
    const now = serverDate().toISOString()
    return {
      kind: 'nankai' as const,
      data: {
        id: `n-${eventId}`, time: now, eventId,
        kindCode: '0202', kindName: '巨大地震注意',
        headline: '南海トラフ地震臨時情報（巨大地震注意）', body: '',
        cancelled: false, reportDateTime: now,
        ...o,
      },
    }
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('正: ライブ受信でも、別の識別情報への取消では帯を消さない', async () => {
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onEvent?.(nankai('evt-A')) })
    expect(h.current.nankai?.eventId).toBe('evt-A')

    // 遅れて届いた別の情報単位への取消
    act(() => { sockets[0].onEvent?.(nankai('evt-OLD', { cancelled: true, retracted: true, kindCode: '', kindName: '' })) })
    expect(h.current.nankai?.eventId).toBe('evt-A')
  })

  it('正: 同じ識別情報への取消なら帯を消す', async () => {
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onEvent?.(nankai('evt-A')) })
    act(() => { sockets[0].onEvent?.(nankai('evt-A', { cancelled: true, retracted: true, kindCode: '', kindName: '' })) })
    expect(h.current.nankai).toBeNull()
  })

  // 安全弁: **これを照合すると帯が永久に消えない。** 「調査終了」は気象庁が調査の結果として
  // 発表する別の報で、臨時情報は発表ごとに別の識別情報を割り振るため、段階の報と一致しない
  it('安全弁: 識別情報が違っても「調査終了」では帯を消す', async () => {
    const h = setup()
    await h.flush()
    act(() => { sockets[0].onEvent?.(nankai('evt-A')) })
    act(() => {
      sockets[0].onEvent?.(nankai('evt-B', { cancelled: true, kindCode: '0204', kindName: '調査終了' }))
    })
    expect(h.current.nankai).toBeNull()
  })

  it('安全弁: 見送った取消では読み上げ・通知のイベントを起こさない', async () => {
    const events: unknown[] = []
    const h = setup({ onLiveEvent: (e: unknown) => { events.push(e) } })
    await h.flush()
    act(() => { sockets[0].onEvent?.(nankai('evt-A')) })
    const before = events.length
    act(() => { sockets[0].onEvent?.(nankai('evt-OLD', { cancelled: true, retracted: true, kindCode: '', kindName: '' })) })
    // 帯を消していないので、「取り消されました」を伝える経路にも乗せない
    expect(events.length).toBe(before)
  })

  it('正: 何も表示していないときの取消は、読み上げ・通知を起こさない', async () => {
    // 帯を出していない状態で古い取消が届く経路（起動直後・再接続直後）。取り消された情報
    // そのものを利用者は見ていないので、「取り消されました」と告げても伝わらない
    const events: unknown[] = []
    const h = setup({ onLiveEvent: (e: unknown) => { events.push(e) } })
    await h.flush()
    const before = events.length
    act(() => { sockets[0].onEvent?.(nankai('evt-X', { cancelled: true, retracted: true, kindCode: '', kindName: '' })) })
    expect(events.length).toBe(before)
    expect(h.current.nankai).toBeNull()
  })

  it('対照: 何も表示していなくても「調査終了」は伝える', async () => {
    // 調査終了はそれ自体が意味を持つ報（調査の結果が通常の範囲内だった）。取消と違い、
    // 対象の帯を見ていなくても伝わる。**取消の抑制をここまで広げないこと**
    const events: unknown[] = []
    const h = setup({ onLiveEvent: (e: unknown) => { events.push(e) } })
    await h.flush()
    const before = events.length
    act(() => { sockets[0].onEvent?.(nankai('evt-Y', { cancelled: true, kindCode: '', kindName: '調査終了' })) })
    expect(events.length).toBe(before + 1)
  })
})

// テストボタンが張る「待ち」を、リセットとアンマウントで確実に落とすこと。
// 落とす先は `clearTestSimulationTimers` の 1 箇所に集約してある。
//
// **多くがキューを通らない経路。** 津波と EEW のテストは `handleEvent` を直接呼ぶので、
// `eventQueueRef.current.clear()` では止まらない。待ちを ref で追えていないと、
// リセット済みの画面へ電文が 1 通だけ単独で届く —— **例外もログも出ない。**
//
// 症状は待ちの種類で重さが違う。津波の解除は画面に出ないぶん音と読み上げだけが鳴るが、
// **EEW の最終報はカードごと生える。**
//
// 地震回数・南海トラフの取消テストも同じ形の待ちを持つ（そちらはキュー経由だが、
// **待ちそのものは同じように取り残されうる**）。
describe('テストボタンの待ちの後始末', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // 正: 押しっぱなしにすれば続報は届く（待ちが機能していることの確認）。
  it('津波の等級変化テストは続報を届ける', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateTsunamiGradeChange() })
    expect(h.current.tsunamis[0]?.areas.some(a => a.lastGrade)).toBe(false)

    // TEST_AUTO_DISMISS_MS(90s) の半分で続報が入る
    act(() => { vi.advanceTimersByTime(46_000) })
    expect(h.current.tsunamis[0]?.areas.some(a => a.lastGrade)).toBe(true)
  })

  // 対照: リセットを挟めば、その後に待ちが明けても何も起きない。
  // **ここが落ちると、消したはずの津波が 45 秒後に単独で復活する。**
  it('リセット後は津波の続報が届かない', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateTsunamiGradeChange() })
    expect(h.current.tsunamis.length).toBeGreaterThan(0)

    act(() => { h.current.resetState() })
    expect(h.current.tsunamis).toEqual([])

    act(() => { vi.advanceTimersByTime(120_000) })
    expect(h.current.tsunamis).toEqual([])
  })

  // 対照: 地震回数の取消テストも同じ。
  it('リセット後は地震回数の取消が届かない', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateEarthquakeCountRetraction() })
    act(() => { vi.advanceTimersByTime(50) })
    expect(h.current.earthquakeCount).not.toBeNull()

    act(() => { h.current.resetState() })
    expect(h.current.earthquakeCount).toBeNull()

    // 取消が遅れて届いても、リセット後の画面には何も起こさない
    act(() => { vi.advanceTimersByTime(120_000) })
    expect(h.current.earthquakeCount).toBeNull()
  })

  // 安全弁: 押し直したときに前の待ちを引きずらない。**前の待ちが生きていると、
  // 2 回目の発表に対して 1 回目の続報が割り込む**（報番号も内容も噛み合わない）。
  it('押し直すと前の待ちは落ちる', async () => {
    const h = setup()
    await h.flush()
    await act(async () => { await h.current.simulateTsunamiGradeChange() })
    act(() => { vi.advanceTimersByTime(30_000) })
    // 30 秒目で押し直す（1 回目の続報はまだ来ていない）
    await act(async () => { await h.current.simulateTsunamiGradeChange() })

    // 1 回目の待ちが生きていれば、ここで続報が入ってしまう（押し直しから 16 秒しか経っていない）
    act(() => { vi.advanceTimersByTime(16_000) })
    expect(h.current.tsunamis[0]?.areas.some(a => a.lastGrade)).toBe(false)

    // 2 回目の待ちは正しく明ける
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.current.tsunamis[0]?.areas.some(a => a.lastGrade)).toBe(true)
  })

  /** 生の電文から種別で絞る（state に出ない解除・取消はこちらでしか見えない）。 */
  function kindsOf(events: AppEvent[], kind: AppEvent['kind']): AppEvent[] {
    return events.filter(e => e.kind === kind)
  }

  // 正: リセットを挟まなければ、EEW の最終報は沈黙時間（10 秒）の後に届く。
  it('EEW テストは最終報を届ける', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    await act(async () => { await h.current.simulateEEWForecast() })
    act(() => { vi.advanceTimersByTime(10_000) })

    const eews = kindsOf(events, 'eew') as EEWAlert[]
    expect(eews.length).toBe(2)
    expect(eews[1].isFinal).toBe(true)
  })

  // 対照: リセットを挟めば最終報は届かない。
  // **ここが落ちると、消したはずの画面に EEW がカードごと 1 枚生える。**
  it('リセット後は EEW の最終報が届かない', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    await act(async () => { await h.current.simulateEEWForecast() })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { h.current.resetState() })
    expect(h.current.activeEEWs.size).toBe(0)

    events.length = 0
    act(() => { vi.advanceTimersByTime(120_000) })
    expect(kindsOf(events, 'eew')).toEqual([])
    expect(h.current.activeEEWs.size).toBe(0)
  })

  // 対照: EEW 誤報取消の待ちも同じ。**取消は音・通知・読み上げを伴う**ので、
  // 取り残すとリセット後に「誤報でした」とだけ鳴る。
  it('リセット後は EEW の誤報取消が届かない', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    await act(async () => { await h.current.simulateEEWRetraction() })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { h.current.resetState() })
    events.length = 0
    act(() => { vi.advanceTimersByTime(120_000) })

    expect(kindsOf(events, 'eew')).toEqual([])
  })

  // 対照: 津波テストの自動解除も同じ。**解除は画面を変えないので state では見えない** ——
  // 音と読み上げは表示中の津波の有無を判定せずに走る（→ docs/spec/tsunami-spec.md §5）ため、
  // 生の電文で見る。
  it('リセット後は津波の自動解除が届かない', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    await act(async () => { await h.current.simulateTsunamiWatch() })
    expect(h.current.tsunamis.length).toBeGreaterThan(0)

    act(() => { h.current.resetState() })
    expect(h.current.tsunamis).toEqual([])

    events.length = 0
    act(() => { vi.advanceTimersByTime(120_000) })
    expect(kindsOf(events, 'tsunami')).toEqual([])
  })

  // 安全弁: 南海トラフ臨時情報の取消。**この ref は元から配線済み**で今回直した穴ではないが、
  // 6 つのうちこれだけ固定が無いと、次に `clearTestSimulationTimers` を書き換えたとき
  // 1 つだけ検知が効かなくなる。上の 3 つ（対照）とは性質が違う。
  it('リセット後は南海トラフ臨時情報の取消が届かない', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateNankaiRetraction() })
    act(() => { vi.advanceTimersByTime(50) })
    expect(h.current.nankai).not.toBeNull()

    act(() => { h.current.resetState() })
    expect(h.current.nankai).toBeNull()

    act(() => { vi.advanceTimersByTime(120_000) })
    expect(h.current.nankai).toBeNull()
  })

  // 安全弁: 落とすのは待ちだけでなく**種別ごとの記憶（報番号・eventId）も**。
  // 記憶を残したまま待ちだけ落とすと、リセット後の 1 通目が #2 として届き、
  // 前の時間軸の eventId を引きずる。
  it('リセット後に押し直すと EEW は初報から始まる', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateEEWForecast() })
    const first = [...h.current.activeEEWs.values()][0]
    expect(first.issue?.serial).toBe('1')

    act(() => { vi.advanceTimersByTime(3_000) })
    await act(async () => { await h.current.simulateEEWForecast() })
    expect([...h.current.activeEEWs.values()][0].issue?.serial).toBe('2')

    act(() => { h.current.resetState() })
    await act(async () => { await h.current.simulateEEWForecast() })
    const restarted = [...h.current.activeEEWs.values()][0]
    expect(restarted.issue?.serial).toBe('1')
    expect(restarted.issue?.eventId).not.toBe(first.issue?.eventId)
  })

  // 正: 3 つ目の形（`setTimeout` を張らず、キューへ発火時刻つきで積む）も待ちとして働くこと。
  // 推計震度分布図テストは地震情報を先に出し、`TEST_ESTIMATED_INTENSITY_DELAY_MS` 後に分布を流す。
  it('推計震度分布図テストは地震情報の後から分布を届ける', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateEstimatedIntensity() })
    expect(h.current.estimatedIntensity).toBeNull()

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(h.current.estimatedIntensity).not.toBeNull()
  })

  // 正: 訂正報テストも同じ形（キューへ 2 通積む）で、**同じカードが更新される**こと。
  // 枚数まで見るのは、`eventId` を取り違えると 2 枚に割れるため —— そうなると「訂正された」
  // ようには見えず、印だけが別のカードに付く。実機でも 1 枚のまま更新されることを確かめている。
  it('訂正報テストは初報の後から訂正報を届け、同じカードを更新する', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateQuakeAmendment() })
    // キューのディスパッチャは 10ms 周期なので、積んだ直後はまだ届いていない。
    act(() => { vi.advanceTimersByTime(100) })
    expect(h.current.earthquakes.length).toBe(1)
    expect(h.current.earthquakes[0].issue.correct).toBe('なし')
    expect(h.current.earthquakes[0].earthquake.hypocenter.magnitude).toBe(7.4)

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(h.current.earthquakes.length).toBe(1)
    expect(h.current.earthquakes[0].issue.correct).toBe('震源を訂正')
    expect(h.current.earthquakes[0].earthquake.hypocenter.magnitude).toBe(7.6)
  })

  // 対照: 訂正報テストもリセットで 2 通目が落ちること。**推計震度分布図の対照と別に要る** ——
  // 同じ仕組みに乗っているが、種別ごとに分岐する変更が入ったとき、片方だけ通り続けても
  // 気づけない（こちらは「消したはずの画面へ 3 秒後に訂正報が 1 通届く」形で現れる）。
  it('リセット後は訂正報が届かない', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateQuakeAmendment() })
    act(() => { vi.advanceTimersByTime(100) })
    expect(h.current.earthquakes[0].issue.correct).toBe('なし')

    act(() => { h.current.resetState() })
    act(() => { vi.advanceTimersByTime(10_000) })
    // 初報ごと消えている（訂正報だけが後から生えることもない）
    expect(h.current.earthquakes.filter(q => q.issue.correct !== 'なし')).toEqual([])
  })

  // 対照: この形は `clearTestSimulationTimers` の対象では**ない**。落とすのはキューのほうで、
  // `eventQueueRef.current.clear()` が効く。**仕様書の表（settings-pwa-spec.md §7）が
  // 「キューを空にすれば足りる」と主張している 3 つ目の形の裏付け** —— ここを固定しておかないと、
  // `resetState` がキューを空にする位置がずれたときに黙って通る。
  it('リセット後は推計震度分布図が届かない', async () => {
    const h = setup()
    await h.flush()

    await act(async () => { await h.current.simulateEstimatedIntensity() })
    act(() => { h.current.resetState() })

    act(() => { vi.advanceTimersByTime(10_000) })
    expect(h.current.estimatedIntensity).toBeNull()
  })

  // 安全弁: アンマウントでも落ちること。**リセットだけ配線して cleanup を忘れる**のが
  // いちばん起きやすい取りこぼしで、そちらは画面を閉じた後に setState が走る形になる。
  //
  // **6 種すべてを起こしてから閉じる。** 一部だけだと、cleanup の `useEffect` の依存配列や
  // 呼び出しを壊す回帰（古いクロージャを握る・一部の ref だけ呼ばなくなる）を、
  // 起こさなかった待ちについて検出できない。上の対照は `resetState` 側しか通らない。
  it('アンマウント後は待ちが発火しても電文が流れない', async () => {
    const events: AppEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    // 待ちを持つテストを全種類起こす（津波の 2 つは同じ `testTsunamiRef` を共有するため、
    // 後から押したほうが前の自動解除を畳む。それでも待ちは 1 本残る）
    await act(async () => { await h.current.simulateEEWForecast() })
    await act(async () => { await h.current.simulateEEWRetraction() })
    await act(async () => { await h.current.simulateTsunamiWatch() })
    await act(async () => { await h.current.simulateTsunamiGradeChange() })
    await act(async () => { await h.current.simulateNankaiRetraction() })
    await act(async () => { await h.current.simulateEarthquakeCountRetraction() })

    events.length = 0
    cleanup()
    act(() => { vi.advanceTimersByTime(120_000) })

    expect(events).toEqual([])
  })
})

// 津波の続報で、新報が運ばない情報を前報から引き継ぐこと。
//
// **画面を見ても気づけない。** 症状は「数十秒だけ満潮時刻が消える」「避難の呼びかけが別の
// 注記に差し替わる」で、どちらも例外もログも出ず、次の報で元に戻ることさえある。
//
// 並びは実電文（2026-04-20 三陸沖・`eventId=20260420165303`）のとおり:
//   16:55 VTSE41 津波警報等   区域 13・観測点なし・固定付加文は避難行動
//   16:56 VTSE51 満潮時刻     同じ区域 13・観測点あり・固定付加文は満潮の注記
//   17:08 VTSE41 津波警報等   区域が 17 へ増える・観測点なし・固定付加文は避難行動
describe('津波の続報マージ（前報から引き継ぐもの）', () => {
  const EVENT_ID = '20260420165303'
  const AREA_NAMES = ['北海道太平洋沿岸中部', '岩手県']

  /** 津波警報等（VTSE41）。区域一覧を全量で載せるが、区域の中に観測点を持たない。 */
  function warningTelegram(serial: number, areaNames: string[]): JMATsunami {
    const iso = new Date(Date.UTC(2026, 3, 20, 7, 55 + serial)).toISOString()
    return {
      kind: 'tsunami',
      id: `dmdata-tsunami-${EVENT_ID}-w${serial}`,
      eventId: EVENT_ID,
      time: iso,
      cancelled: false,
      carriesForecastStations: false,
      infoName: '津波警報・津波注意報・津波予報',
      warningComments: [{ key: 'VTSE41', text: 'ただちに避難してください。' }],
      freeText: '［予想される津波の高さの解説］',
      issue: { source: '気象庁', time: iso, type: 'Focus' },
      areas: areaNames.map(name => ({ grade: 'Warning' as const, immediate: false, name })),
    }
  }

  /** 満潮時刻・津波到達予想時刻（VTSE51）。同じ区域一覧に観測点を足して載せる。 */
  function highTideTelegram(serial: number, areaNames: string[]): JMATsunami {
    const iso = new Date(Date.UTC(2026, 3, 20, 7, 56 + serial)).toISOString()
    return {
      kind: 'tsunami',
      id: `dmdata-tsunami-${EVENT_ID}-h${serial}`,
      eventId: EVENT_ID,
      time: iso,
      cancelled: false,
      carriesForecastStations: true,
      infoName: '各地の満潮時刻・津波到達予想時刻に関する情報',
      warningComments: [{
        key: 'VTSE51|各地の満潮時刻・津波到達予想時刻に関する情報',
        text: '津波と満潮が重なると、津波はより高くなりますので一層厳重な警戒が必要です。',
      }],
      issue: { source: '気象庁', time: iso, type: 'Focus' },
      areas: areaNames.map(name => ({
        grade: 'Warning' as const,
        immediate: false,
        name,
        stations: [{ name: `${name}の観測点`, code: `${name}1`, highTideDateTime: '2026-04-20T18:30:00+09:00' }],
      })),
    }
  }

  const stationsOf = (h: ReturnType<typeof setup>, areaName: string) =>
    h.current.tsunamis[0].areas.find(a => a.name === areaName)?.stations

  // このファイルの他の describe と揃えて偽タイマーで回す。本物のタイマーで回すと、フックの
  // キュー配信（10ms 間隔）が実時間で動き続け、全ファイル並列のときだけ効いてくる負荷になる。
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  // 正: 観測点を運ばない津波警報等が届いても、満潮時刻が残る。
  it('津波警報等が届いても満潮時刻が消えない', () => {
    const h = setup()
    act(() => { h.current.injectEvent(warningTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    expect(stationsOf(h, '岩手県')?.[0].highTideDateTime).toBe('2026-04-20T18:30:00+09:00')

    // 区域が増える続報（実電文では 13 → 17）。増えた区域には引き当てる前報が無い。
    act(() => { h.current.injectEvent(warningTelegram(1, [...AREA_NAMES, '宮城県'])) })
    expect(h.current.tsunamis[0].areas.map(a => a.name)).toEqual([...AREA_NAMES, '宮城県'])
    expect(stationsOf(h, '岩手県')?.[0].highTideDateTime).toBe('2026-04-20T18:30:00+09:00')
    expect(stationsOf(h, '宮城県')).toBeUndefined()
  })

  // 対照: 観測点を運ぶ種別が観測点を載せなくなったら落とす（気象庁が発表をやめた合図）。
  // 実電文では等級が津波予報まで下がった時点でこの形になる。
  it('津波情報が観測点を載せなくなったら落とす', () => {
    const h = setup()
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    const empty = highTideTelegram(1, AREA_NAMES)
    empty.areas = empty.areas.map(a => ({ ...a, stations: undefined }))
    act(() => { h.current.injectEvent(empty) })
    expect(stationsOf(h, '岩手県')).toBeUndefined()
  })

  // 安全弁: 一部解除で区域が減ったら、減ったまま。前報から復活させない。
  it('電文から消えた区域を前報から復活させない', () => {
    const h = setup()
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(warningTelegram(1, ['岩手県'])) })
    expect(h.current.tsunamis[0].areas.map(a => a.name)).toEqual(['岩手県'])
  })

  // 正: 固定付加文は主題ごとに束ねる。避難の呼びかけが満潮の注記に差し替わらない。
  it('避難の呼びかけが満潮時刻の報で消えない', () => {
    const h = setup()
    act(() => { h.current.injectEvent(warningTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    const texts = h.current.tsunamis[0].warningComments!.map(c => c.text)
    expect(texts[0]).toContain('ただちに避難してください')
    expect(texts[1]).toContain('津波と満潮が重なると')
  })

  // 正: 自由付加文も引き継ぐ。入るのは津波警報等だけなので、引き継がないと最初の続報で消える。
  it('自由付加文が続報で消えない', () => {
    const h = setup()
    act(() => { h.current.injectEvent(warningTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    expect(h.current.tsunamis[0].freeText).toContain('予想される津波の高さの解説')
  })

  // 正: 沿岸への推定も引き継ぐ。**入るのは沖合の津波観測（VTSE52）だけ**で、実電文では最後の
  // VTSE52 のあとに津波情報が 20 通以上続く。引き継がないと次の報で推定が消える。
  it('沿岸への推定が次の報で消えない', () => {
    const h = setup()
    const offshoreReport: JMATsunami = {
      ...highTideTelegram(0, AREA_NAMES),
      id: `dmdata-tsunami-${EVENT_ID}-o1`,
      carriesForecastStations: false,
      infoName: '沖合の津波観測に関する情報',
      areas: [],
      estimations: [{ name: '岩手県', arrivalTime: '2026-04-20T17:30:00+09:00' }],
    }
    act(() => { h.current.injectEvent(warningTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(offshoreReport) })
    expect(h.current.tsunamis[0].estimations?.length).toBe(1)
    // 沖合の推定を持たない報が届いても残る
    act(() => { h.current.injectEvent(highTideTelegram(1, AREA_NAMES)) })
    expect(h.current.tsunamis[0].estimations?.map(e => e.name)).toEqual(['岩手県'])
  })

  // 安全弁: 名乗り（`infoName`）は引き継がない。その報が何を出しているかを表すもので、
  // 引き継ぐと満潮時刻の報を見ているのに「津波警報・津波注意報・津波予報」と名乗る。
  it('名乗りは最新の報のものを出す', () => {
    const h = setup()
    act(() => { h.current.injectEvent(warningTelegram(0, AREA_NAMES)) })
    act(() => { h.current.injectEvent(highTideTelegram(0, AREA_NAMES)) })
    expect(h.current.tsunamis[0].infoName).toBe('各地の満潮時刻・津波到達予想時刻に関する情報')
  })
})
