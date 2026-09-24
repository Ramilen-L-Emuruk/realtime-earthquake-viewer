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
import type { AppEvent, LiveEvent, LiveEventMeta, EEWAlert, JMAQuake, JMATsunami, JMANankaiCommentary, JMAQuakeNotice, JMAEarthquakeCount, JMAEstimatedIntensity, IntensityScale } from '../types/earthquake'
import type { ReplayEntry, ReplayPayload } from '../types/replay'
import type { JMAKohatsu } from '../types/earthquake'
import { serverDate, setReplayOffset } from '../utils/clock'
import {
  drainReplayEvents, __resetReplayEventLogForTest, type ReplayTelegramEvent,
} from '../utils/replayEventLog'
import { DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'
import { log } from '../utils/logger'
import { CELL_LAT_DEG, CELL_LON_DEG } from '../utils/bufrEstimatedIntensity'
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
/**
 * 履歴取得（`fetchDmdataQuakeHistory`）の戻り値を組み立てる。
 *
 * 地震・津波・帯・長周期が 1 本で返るので、テストは足したいものだけを渡す。
 */
function history(opts: {
  quakes?: JMAQuake[]
  tsunamis?: JMATsunami[]
  extras?: ReplayEntry[]
  hasMore?: boolean
  /** 取り込めなかった電文の通数（一部失敗の再現用）。 */
  skipped?: number
  /** 読めなかった取得元（同上）。 */
  failedArchiveUrls?: string[]
  /** 読み切った最古の JST 日（＝次のカーソル）。省略すると「1 件も読まなかった」。 */
  oldestLoadedDay?: string | null
} = {}) {
  return {
    quakes: opts.quakes ?? [],
    tsunamis: opts.tsunamis ?? [],
    extras: opts.extras ?? [],
    skippedByDay: skips(opts.skipped ?? 0),
    failedArchiveUrls: opts.failedArchiveUrls ?? ([] as string[]),
    rateLimitedSources: [] as string[],
    rateLimitedTelegrams: 0,
    hasMore: opts.hasMore ?? false,
    oldestLoadedDay: opts.oldestLoadedDay ?? null,
  }
}

/** 帯・長周期を `extras` の 1 件として包む。 */
function extra(payload: ReplayPayload): ReplayEntry {
  return { payload, replayTime: new Date('2026-01-01T00:00:00Z'), silent: true }
}

// **丸ごと差し替える（`importOriginal` を混ぜない）。** 実物を残すと、ここでモックし忘れた
// 関数がテスト中に本物の通信を始める。代償として `dmdata.ts` が export を増やすたびにこの
// 一覧へ足す必要があるが、**落ちて気づける**ぶん、黙って通信が走るより良い。
// 旧来の 1 件ずつ取る 8 本は撤去済みなので、残るのは受信の入口と発表中の緊急地震速報の復元だけ。
vi.mock('../services/dmdata', () => ({
  DmdataWebSocket: FakeWebSocket,
  // 戻り値を持たせるのは、呼び出し側が `.then` で受けるため（`vi.fn()` のままだと
  // `undefined.then` で落ちる）。
  fetchDmdataActiveEews: vi.fn(async () => []),
}))

// 履歴の取得はアーカイブ経由の 1 本へ寄せてある（→ `services/dmdataReplay.ts` の
// `fetchDmdataQuakeHistory`）。地震・津波・帯・長周期がまとめて返る。
// **こちらは `importOriginal` を混ぜる** —— `HISTORY_WINDOW_DAYS` 等の定数を実物から採るため。
// 通信するのは `fetchDmdataQuakeHistory` 1 本なので、それを差し替えれば漏れは出ない。
vi.mock('../services/dmdataReplay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/dmdataReplay')>()),
  fetchDmdataQuakeHistory: vi.fn(),
}))

vi.mock('../services/p2pquake', () => ({
  P2PQuakeWebSocket: FakeWebSocket,
  fetchHistory: vi.fn(),
  fetchJmaQuake: vi.fn(),
}))

// 1 回の窓の幅は実装側の定数を正とする（テストへ数値を書き写すと、窓を動かしたときに
// テストだけが古い値のまま通ってしまう）。モックのファクトリで実物を展開しているので本物が来る。
const { fetchDmdataQuakeHistory, HISTORY_WINDOW_DAYS } = await import('../services/dmdataReplay')
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
const { totalSkipped } = await import('../utils/telegramLoss')


/**
 * テスト用: 取りこぼしを日ごとの Map にする。
 *
 * 実装が件数ひとつから日ごとへ変わったのは、同じ日を二度読んでも二重に数えず、別の日の分も
 * 失わないため（→ `utils/telegramLoss.ts` の `skippedByDay`）。日を書き分けたいテストは
 * 第 2 引数を渡す。
 */
function skips(count: number, day = '2026-08-10'): Map<string, number> {
  return count > 0 ? new Map([[day, count]]) : new Map()
}


beforeEach(() => {
  sockets.length = 0
  mockIsDmdss = true
  // 戻り値の形はここで型付きに与える（実シグネチャと違えば型エラーになる）
  vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history())
  vi.mocked(fetchHistory).mockResolvedValue([])
  vi.mocked(fetchJmaQuake).mockResolvedValue([])
})

afterEach(cleanup)

/** replayTimeOffset を差し替えられるハーネス。onLiveEvent は生の電文を覗きたいときだけ渡す。 */
function setup(opts: { apiKey?: string; offset?: number | null; onLiveEvent?: (event: LiveEvent) => void } = {}) {
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

  // 取消電文は報番号の台帳を進めず、状態側も取消前の報番号を保ったまま `cancelledAt` を足す。
  // そのため**同じ報番号の非取消報が届くと「古い報」の判定をすり抜ける**。起動時の復元が
  // 取消の直前に発表された報を拾ったとき（一覧 API が取消を反映するまでの遅れ）と、ライブで
  // 到着順が入れ替わったときに現実に起きる。
  it('取消済みの EEW は、同じ報番号の非取消報が届いても復活しない', () => {
    const h = setup({})
    const at = serverDate()

    act(() => { h.current.injectEvent(finalEEW(at)) })
    expect(h.current.activeEEWs.size).toBe(1)

    act(() => { h.current.injectEvent({ ...finalEEW(at), cancelled: true }) })
    expect(h.current.activeEEWs.get('replay-final-event')?.cancelledAt).toBeTruthy()

    // 復元経路が拾ってきた「取消前の報」を模す（報番号は取消前と同じ）
    act(() => { h.current.injectEvent(finalEEW(at)) })

    // 取消の印が残っていること。消えると表示が復活し、10 秒後の purge も空振りする
    expect(h.current.activeEEWs.get('replay-final-event')?.cancelledAt).toBeTruthy()
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
    fn.mock.calls.filter(([e]) => (e as LiveEvent).kind === 'quake').length

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
      .map(([e]) => e as LiveEvent)
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
// 実運用（dmdataParser.parseEEW）では 1 報ごとに報番号・id・発表時刻が進み、**震源時刻も
// 続報でずれる**（実電文は震源推定が更新されるたび作り直す）。**一方、地震発現時刻は不変** ——
// 観測点が実際に検知した時刻なので震源推定の更新とは無関係（実測は → `docs/spec/eew-spec.md` §3）。
// テスト側がここを取り違えると、
//   - 最終報の報番号が進まない → 「#1 → #1 最終報」という実運用ではあり得ない推移になる
//   - 基準時刻が現在時刻へ張り替わる → 予報円が押すたび中心に戻り、発生時刻表示も動く
//   - 震源時刻まで固定される → 続報で予報円の半径が跳ねる形を実機で一度も見られない
// のいずれも画面上は「それらしく」見えてしまうため、値そのものを固定して守る。
describe('EEW 発報テストの報の推移', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** activeEEWs の唯一の要素を取り出す（テストボタンは 1 イベントしか作らない）。 */
  function onlyEEW(h: ReturnType<typeof setup>): EEWAlert {
    const list = [...h.current.activeEEWs.values()]
    expect(list.length).toBe(1)
    return list[0]
  }

  // **かつて「震源時刻は初報のまま保つ」と固定していたテストを覆したもの。** 実電文の震源時刻は
  // 続報で動く（→ `docs/spec/eew-spec.md` §3「地震の時刻は発生時刻を出す」）。
  it('続報は報番号・発表時刻・震源時刻を進め、地震発現時刻だけを引き継ぐ', async () => {
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
    // 対照: 地震発現時刻は動かない（実測では 15 地震すべてで 1 通も動かなかった）
    expect(second.earthquake.arrivalTime).toBe(first.earthquake.arrivalTime)
    // 正: 震源時刻はずれる。実電文は震源推定が更新されるたび動くため
    // （`utils/testData.ts` の `EEW_ORIGIN_DRIFT_SEC`）
    expect(Date.parse(second.earthquake.originTime) - Date.parse(first.earthquake.originTime)).toBe(-3_000)
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
    // 同じ地震の報なので地震発現時刻は引き継ぐ（震源時刻は続報と同じくずれる）
    expect(final.earthquake.arrivalTime).toBe(first.earthquake.arrivalTime)
    expect(Date.parse(final.earthquake.originTime) - Date.parse(first.earthquake.originTime)).toBe(-3_000)
  })

  // activeEEWs は取消を受けても直前の確定状態を保つ（表示を空にしないための実装）ため、
  // 取消電文そのものの形は state からは見えない。onLiveEvent に届く生の電文で確かめる。
  it('誤報取消も独立した 1 報として報番号を進め、対象地域を持たない', async () => {
    const events: LiveEvent[] = []
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
    const events: LiveEvent[] = []
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
    const events: LiveEvent[] = []
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
  function tsunamiPair(events: LiveEvent[]): [JMATsunami, JMATsunami] {
    const list = events.filter((e): e is JMATsunami => e.kind === 'tsunami')
    expect(list.length).toBe(2)
    return [list[0], list[1]]
  }

  /**
   * 初回履歴の取り込みを先に流し切る。
   *
   * テストデータは動的 import で読むので、シミュレーション関数は Promise を返す。それを await
   * すると**同じ待ちのあいだに初回履歴取得（`fetchDmdataQuakeHistory`）の解決も進む**ため、
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
    const events: LiveEvent[] = []
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
    const events: LiveEvent[] = []
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
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: commentary('c-fresh', 60_000) })] }))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary?.id).toBe('c-fresh')
  })

  it('期限切れの解説情報は載せない（先月の定例解説が起動時に出ないこと）', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: commentary('c-stale', -1_000) })] }))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary).toBeNull()
  })

  it('期限が来たら帯を畳む', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: commentary('c-expiring', 5_000) })] }))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary?.id).toBe('c-expiring')

    act(() => { vi.advanceTimersByTime(5_001) })
    expect(h.current.nankaiCommentary).toBeNull()
  })

  it('期限日時が壊れていれば載せない（期限計算が破綻した状態で帯を出さない）', async () => {
    const broken = { ...commentary('c-broken', 60_000), expireAt: 'not-a-date' }
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: broken })] }))
    const h = setup()
    await h.flush()
    expect(h.current.nankaiCommentary).toBeNull()
  })

  it('取消電文で帯を消す（期限を待たずに畳む）', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: commentary('c-live', 60_000) })] }))
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
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'nankaiCommentary', data: commentary('c-live', 60_000) })] }))
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

describe('震源・津波区分を津波電文から借りる結線', () => {
  // **借りる契機は両方向に要る**（地震が先・津波が先）。どちらが先かは決まっていないのに、
  // 片方の配線が落ちても画面には「その順序のときだけ震源が出ない」としか現れない。
  // 純関数（`utils/borrowFromTsunami.ts`）のテストでは、reducer のどの分岐に繋いだかを見られない。
  const EVENT_ID = '20240101161010'

  /** 震源を持たない震度速報（実電文と同じくセンチネルで埋める）。 */
  function prompt(): JMAQuake {
    const at = serverDate().toISOString()
    return {
      kind: 'quake',
      id: `dmdata-quake-${EVENT_ID}-1`,
      time: at,
      issue: { source: 'dmdata', time: at, type: '震度速報', correct: 'なし' },
      earthquake: {
        time: at,
        hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN },
        maxScale: 70,
        domesticTsunami: '調査中',
      },
      points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 70 }],
    }
  }

  /** 原因地震（震源）と大津波警報を載せた津波。 */
  function tsunami(over: { eventId?: string } = {}): JMATsunami {
    const at = serverDate().toISOString()
    return {
      kind: 'tsunami',
      id: `dmdata-tsunami-${EVENT_ID}-1`,
      eventId: over.eventId ?? EVENT_ID,
      time: at,
      cancelled: false,
      infoName: '津波警報・津波注意報・津波予報',
      issue: { source: 'dmdata', time: at, type: 'Focus' },
      areas: [{ grade: 'MajorWarning', immediate: true, name: '石川県能登' }],
      sourceEarthquakes: [{
        hypocenterName: '石川県能登地方',
        magnitude: 7.4,
        originTime: at,
        latitude: 37.5,
        longitude: 137.2,
        depth: 0,
      }],
    }
  }

  /** 地震・津波は AppEvent の入口（`injectEvent`）から流す。 */
  function push(h: ReturnType<typeof setup>, event: JMAQuake | JMATsunami) {
    act(() => { h.current.injectEvent(event) })
  }

  // 正: 津波が先。受信側（'quake' ケース）が、既に画面にある津波から借りる。
  it('津波が先に届いていれば、あとから来た震度速報が震源と津波区分を借りる', async () => {
    const h = setup()
    await h.flush()
    push(h, tsunami())
    push(h, prompt())
    const card = h.current.earthquakes[0]
    expect(card.earthquake.hypocenter.name).toBe('石川県能登地方')
    expect(card.earthquake.domesticTsunami).toBe('警報等')
    expect(card.hypocenterSource?.shortLabel).toBe('津波情報')
    expect(card.domesticTsunamiSource?.shortLabel).toBe('津波情報')
  })

  // 正: 地震が先。配る側（'tsunami' ケース）が、既にあるカードへ配る。
  it('震度速報が先に届いていれば、あとから来た津波がカードへ配る', async () => {
    const h = setup()
    await h.flush()
    push(h, prompt())
    expect(h.current.earthquakes[0].earthquake.hypocenter.name).toBe('')
    push(h, tsunami())
    const card = h.current.earthquakes[0]
    expect(card.earthquake.hypocenter.name).toBe('石川県能登地方')
    expect(card.earthquake.domesticTsunami).toBe('警報等')
  })

  // 安全弁: 別の地震の津波からは借りない（結ぶ根拠は `eventId` の一致だけ）。
  it('eventId が違う津波からは借りない', async () => {
    const h = setup()
    await h.flush()
    push(h, tsunami({ eventId: '20240101999999' }))
    push(h, prompt())
    const card = h.current.earthquakes[0]
    expect(card.earthquake.hypocenter.name).toBe('')
    expect(card.earthquake.domesticTsunami).toBe('調査中')
    expect(card.hypocenterSource).toBeUndefined()
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

// 推計震度分布図の結線。
//
// 判定そのものは純関数へ切り出してテストしてある（`utils/estimatedIntensity.test.ts`）。
// **ここで見るのは包み側** —— 反映しないと決めた報で `onLiveEvent` まで止まること。
// 止め損ねると、画面の分布は据え置きのまま**音と読み上げだけが鳴り、分布モードが勝手に開く**。
// 判定が正しくても包み側で漏れるので、純関数のテストでは捕まらない。
describe('推計震度分布図の結線', () => {
  function ei(arrivalTime: string, time: string, count: number): JMAEstimatedIntensity {
    return {
      id: `ix-${time}`, time, arrivalTime,
      hypocenter: { lat: 32.6, lon: 130.7, depthKm: 10 },
      magnitude: 4.2, areaCode: 741, telegramKind: 0,
      grades: [{ scale: 4, modifier: 'none', lower: 35, upper: 44 }],
      count,
      lat: new Float32Array([32.6]), lon: new Float32Array([130.7]), si: new Uint8Array([42]),
      cellLatDeg: CELL_LAT_DEG, cellLonDeg: CELL_LON_DEG,
      bounds: { south: 32.6, north: 32.61, west: 130.7, east: 130.71 },
    }
  }
  const KUMA = ei('2026-07-28T07:27:00.000Z', '2026-07-28T07:32:00+09:00', 1693)
  const LATER = ei('2026-07-28T07:31:00.000Z', '2026-07-28T07:36:00+09:00', 812)
  // KUMA と同じ地震の続報（発現時刻が同じ・発表時刻だけ後）。
  const KUMA_FOLLOW = ei('2026-07-28T07:27:00.000Z', '2026-07-28T07:40:00+09:00', 1700)

  function push(h: ReturnType<typeof setup>, data: JMAEstimatedIntensity, silent = false) {
    act(() => { h.current.loadReplayEvents([{ payload: { kind: 'estimatedIntensity', data }, replayTime: serverDate(), silent }]) })
    act(() => { vi.advanceTimersByTime(50) })
  }

  /** 鳴らす経路へ流れた分の「初報か続報か」だけを取り出す。 */
  function isNewFlags(events: LiveEvent[]): boolean[] {
    return events
      .filter(e => (e.kind as string) === 'estimatedIntensity')
      .map(e => (e as { isNew: boolean }).isNew)
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // 正: 届いた分布を反映し、音と読み上げの経路へも流す。
  it('届いた分布を反映して鳴らす経路へ流す', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    expect(h.current.estimatedIntensity?.arrivalTime).toBe(KUMA.arrivalTime)
    expect(events.filter(e => (e.kind as string) === 'estimatedIntensity')).toHaveLength(1)
  })

  // 正: 別の地震の新しい分布へは入れ替える（アプリが持つのは最新の 1 通だけ）。
  it('別の地震の新しい分布へ入れ替える', async () => {
    const events: LiveEvent[] = []
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
    const events: LiveEvent[] = []
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
    const events: LiveEvent[] = []
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

  // 正: **別の地震の分布を挟んでも、同じ地震の続報は続報として流す。**
  // 実電文（2024-01-01 の能登半島地震）がこの並びで、①本震 ②別の地震 ③本震の続報 と届いた。
  // 「いま出している 1 通」との比較だけで決めていた頃は、③が初報として読まれていた。
  it('別の地震の分布を挟んでも、同じ地震の続報は続報として流す', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    push(h, LATER)
    push(h, KUMA_FOLLOW)
    expect(isNewFlags(events)).toEqual([true, true, false])
  })

  // 対照: 挟まずに続けて届いた続報も、当然「続報」。
  it('続けて届いた同じ地震の続報は続報として流す', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    push(h, KUMA_FOLLOW)
    expect(isNewFlags(events)).toEqual([true, false])
  })

  // 安全弁: **音も声も伴わない注入では台帳へ積まない。** リプレイ開始時の初期状態は画面を
  // 組み立てるだけで何も鳴らないので、積むと直後の続報が「更新されました」と読まれ、
  // 聞き手は前の報を聞き逃したと思う。
  it('初期状態の注入は台帳へ積まない', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA, true)
    expect(isNewFlags(events)).toEqual([])
    push(h, KUMA_FOLLOW)
    expect(isNewFlags(events)).toEqual([true])
  })

  // 安全弁: リセットで台帳も空にする。リプレイの開始・リセットで時間軸が変わるため、
  // 残すと新しい軸の初報が「更新されました」と読まれる。
  it('リセット後は同じ地震でも初報として流す', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()
    push(h, KUMA)
    act(() => { h.current.resetState() })
    push(h, KUMA_FOLLOW)
    expect(isNewFlags(events)).toEqual([true, true])
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
    vi.mocked(fetchDmdataQuakeHistory).mockClear()
  })

  it('disconnected へ落ち、理由を error に載せ、取得を一度も呼ばない', async () => {
    const h = setup({ apiKey: 'abc123あ' })
    await h.flush()

    expect(h.current.connectionStatus).toBe('disconnected')
    expect(h.current.isLoading).toBe(false)
    expect(h.current.error).toBe(DMDATA_API_KEY_INVALID_MESSAGE)
    expect(fetchDmdataQuakeHistory).not.toHaveBeenCalled()
    // WebSocket も張らない（張ると 30 秒間隔の再接続が無音で回り続ける）
    expect(sockets.length).toBe(0)
  })

  // 対照: 形が正しいキーなら従来どおり接続と取得へ進む。ゲートを広げすぎていないことの確認。
  it('形が正しいキー（ピリオド入り）は従来どおり接続へ進む', async () => {
    const h = setup({ apiKey: 'dummy.key.with-period_123' })
    await h.flush()

    expect(h.current.error).toBeNull()
    expect(fetchDmdataQuakeHistory).toHaveBeenCalled()
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
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: true }))
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

describe('DMDSS 版: 「もっと見る」で遡れる範囲', () => {
  /** 履歴の 1 通（`リプレイ開始時の地震カード` の同名ヘルパと同じ最小形）。 */
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

  /** 呼ばれたときの `maxDays`（第 4 引数）を順に返す。 */
  function requestedDays(): number[] {
    return vi.mocked(fetchDmdataQuakeHistory).mock.calls.map(c => c[3])
  }

  /** 呼ばれたときの窓の上端（第 2 引数＝カーソル）を ISO で順に返す。 */
  function requestedBefore(): string[] {
    return vi.mocked(fetchDmdataQuakeHistory).mock.calls.map(c => c[1].toISOString())
  }

  beforeEach(() => {
    // 呼び出し履歴（`requestedDays` / `requestedBefore`）を見るので、前のテストのぶんを消して
    // おく（このファイルは `clearMocks` を使っていないため、同じ `vi.fn()` に積まれ続ける）。
    vi.mocked(fetchDmdataQuakeHistory).mockClear()
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: true }))
  })

  // **1 週間まるごと震度1以上の地震が無いことは普通に起きる。** それは「もっと古い在庫が無い」
  // ことを何も意味しない（実測でアーカイブの目録は 135 日以上さかのぼれた）。増えたかどうかで
  // 打ち切る作りにしていた頃は、静かな 1 週間に当たった時点で以後の遡りが永久に塞がっていた。
  it('正: カードが増えなかった回でも、まだ遡れるなら押せるままにする', async () => {
    const h = setup({ offset: null })
    await h.flush()

    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.earthquakes).toHaveLength(0)
    expect(h.current.hasMore).toBe(true)
  })

  // **カーソル方式の要。** 押すたびに「前回読み切った最古の日の直前」を次の窓の上端にする。
  // 窓が重ならないので、遡るほど読み直す量が増えることがない。
  it('正: 押すたびに、前回読み切った日の手前から続きを読む', async () => {
    const h = setup({ offset: null })
    await h.flush()

    // **`setup()` の初回取得より後に仕込む**（理由は下の「取得中の解除」テストと同じ）。
    vi.mocked(fetchDmdataQuakeHistory)
      .mockResolvedValueOnce(history({ hasMore: true, oldestLoadedDay: '2026-08-20' }))
      .mockResolvedValue(history({ hasMore: true, oldestLoadedDay: '2026-08-01' }))

    await act(async () => { await h.current.loadMoreEarthquakes() })
    await act(async () => { await h.current.loadMoreEarthquakes() })

    // 上端は「前回読み切った最古の日の 00:00 JST の 1ms 前」
    const [, , third] = requestedBefore()
    expect(third).toBe(new Date(Date.parse('2026-08-20T00:00:00+09:00') - 1).toISOString())
  })

  // 窓の幅は毎回同じ。**日数を伸ばしていく形へ戻さないこと** —— あれは押すたびに範囲全体を
  // 読み直す作りで、遡るほど 1 回の解析量が増えていた。
  it('正: 窓の幅は毎回一定', async () => {
    const h = setup({ offset: null })
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, oldestLoadedDay: '2026-08-20' }),
    )
    await h.flush()

    await act(async () => { await h.current.loadMoreEarthquakes() })
    await act(async () => { await h.current.loadMoreEarthquakes() })

    // 初回（起動時）だけは起動用の短い窓、以後は「もっと見る」の窓
    expect(requestedDays().slice(1)).toEqual([HISTORY_WINDOW_DAYS, HISTORY_WINDOW_DAYS])
  })

  // **元の不具合の回帰テスト。** 件数の安全弁に達して打ち切った回（窓の途中までしか読んで
  // いない）でも、在庫が残っているなら押せたままでなければならない。
  //
  // かつては呼び出し側が「要求した日数が上限に達したか」を重ねて見ており、件数で打ち切って
  // 読み残した日があってもボタンが死んだ。**症状は「9/19 に見ているのに 8/3 より前へ行けない」**で、
  // 取得は成功しているので画面には何の警告も出ない。
  it('安全弁: 件数で打ち切った回でも、在庫が残っていれば押せるままにする', async () => {
    const h = setup({ offset: null })
    await h.flush()

    // 窓の途中で目標に達した（＝読み切った最古の日が窓の下端より新しい）形
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, oldestLoadedDay: '2026-09-10' }),
    )
    for (let i = 0; i < 12; i++) {
      await act(async () => { await h.current.loadMoreEarthquakes() })
    }

    expect(h.current.hasMore).toBe(true)
  })


  // 取得側が「もう要らない（打ち切った）」と言ったら従う。日数の上限とは別の理由。
  it('対照: 取得側が打ち切ったら押せなくする', async () => {
    const h = setup({ offset: null })
    await h.flush()
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: false }))

    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.hasMore).toBe(false)
  })

  // 押してから接続が張り直される（API キーの差し替え・リプレイの開始・試験報の設定変更）と、
  // 待っていた取得は別の時間軸の一覧へ流し込まれるので結果ごと捨てる。**そのとき「取得中」を
  // 解除しないと、冒頭のガードと噛み合ってボタンがリロードまで死ぬ**（押せない「取得中…」が
  // 残るだけで、例外もログも出ない）。
  it('安全弁: 押した後に接続が張り直されても、取得中の表示は解ける', async () => {
    const h = setup({ offset: null })
    await h.flush()
    expect(h.current.hasMore).toBe(true)

    // **`setup()` の初回取得より後に仕込む。** 先に仕込むと `mockReturnValueOnce` を
    // 初回取得が消費し、押す側は既定の解決済みモックを受け取ってこのテストが空振りする。
    let settle: (v: ReturnType<typeof history>) => void = () => {}
    vi.mocked(fetchDmdataQuakeHistory).mockReturnValueOnce(new Promise((r) => { settle = r }))
    const click = act(async () => { await h.current.loadMoreEarthquakes() })
    // 世代を進める（リプレイ開始と同じ経路）
    h.setOffset(-3600_000)
    settle(history({ hasMore: true }))
    await click

    expect(h.current.isLoadingMore).toBe(false)
  })

  // 接続を張り直す effect は、世代を進めるのと同じ同期ブロックでカーソルを初期値へ戻す。
  // 旧世代の取得結果でカーソルを進めると、**新しい時間軸の「もっと見る」が旧世代で読んだ
  // 位置から続きを読む**（その範囲は新しい軸ではまだ一度も読んでいない）。
  it('安全弁: 世代が変わった後は、旧世代の結果でカーソルを進めない', async () => {
    const h = setup({ offset: null })
    await h.flush()
    // 1 回押してカーソルを進めておく
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValueOnce(
      history({ hasMore: true, oldestLoadedDay: '2026-08-20' }),
    )
    await act(async () => { await h.current.loadMoreEarthquakes() })

    let settle: (v: ReturnType<typeof history>) => void = () => {}
    vi.mocked(fetchDmdataQuakeHistory).mockReturnValueOnce(new Promise((r) => { settle = r }))
    const click = act(async () => { await h.current.loadMoreEarthquakes() })
    // 待っているあいだに世代が進む（= カーソルは null へ戻っている）
    h.setOffset(-3600_000)
    settle(history({ hasMore: true, oldestLoadedDay: '2026-07-01' }))
    await click

    // 再生をやめて押し直すと、初回ロードが置いたカーソル（ここでは null＝現在時刻）から読む。
    // 旧世代が返した 2026-07-01 は使わない
    h.setOffset(null)
    await h.flush()
    vi.mocked(fetchDmdataQuakeHistory).mockClear()
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: true }))
    await act(async () => { await h.current.loadMoreEarthquakes() })

    const stale = new Date(Date.parse('2026-07-01T00:00:00+09:00') - 1).toISOString()
    expect(requestedBefore()).not.toContain(stale)
  })

  // 失敗した回のぶんまでカーソルを進めると、飛ばした範囲の履歴が二度と読まれない。
  it('安全弁: 失敗したらカーソルを進めず、押し直しで同じ範囲を読む', async () => {
    const h = setup({ offset: null })
    await h.flush()
    // 1 回目を成功させてカーソルを進めておく（進んでいない状態では「据え置き」を確かめられない）
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValueOnce(
      history({ hasMore: true, oldestLoadedDay: '2026-08-20' }),
    )
    await act(async () => { await h.current.loadMoreEarthquakes() })

    vi.mocked(fetchDmdataQuakeHistory).mockRejectedValueOnce(new Error('取得に失敗'))
    await act(async () => { await h.current.loadMoreEarthquakes() })
    expect(h.current.isLoadingMore).toBe(false)
    expect(h.current.hasMore).toBe(true)

    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({
        hasMore: true, oldestLoadedDay: '2026-08-01',
        quakes: [quakeTelegram('20260810010000', '2026-08-10T01:05:00+09:00')],
      }),
    )
    await act(async () => { await h.current.loadMoreEarthquakes() })

    // 失敗した回と、その次の回が同じ上端を要求している（先へ飛ばさない）
    const [, , failed, retried] = requestedBefore()
    expect(retried).toBe(failed)
    expect(failed).toBe(new Date(Date.parse('2026-08-20T00:00:00+09:00') - 1).toISOString())
    expect(h.current.earthquakes).toHaveLength(1)
  })

  // **まるごと失敗したことも画面へ出す。** 出さないと「押したのに何も起きない」だけに見え、
  // もう一度押せば直るのか、これ以上遡れないのかが分からない。
  it('正: まるごと失敗したら印を立て、押し直して成功したら消す', async () => {
    const h = setup({ offset: null })
    await h.flush()
    expect(h.current.loadMoreFailed).toBe(false)

    vi.mocked(fetchDmdataQuakeHistory).mockRejectedValueOnce(new Error('取得に失敗'))
    await act(async () => { await h.current.loadMoreEarthquakes() })
    expect(h.current.loadMoreFailed).toBe(true)

    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ hasMore: true }))
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.loadMoreFailed).toBe(false)
  })

  // 全滅では「その時点の全範囲」が得られていないので、前回の像をそのまま保つ
  //（`historyLoss` は置き換える値が無い）。
  it('安全弁: まるごと失敗しても、それまでに確定した損失は消さない', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, failedArchiveUrls: ['https://x/a'] }),
    )
    const h = setup({ offset: null })
    await h.flush()

    vi.mocked(fetchDmdataQuakeHistory).mockRejectedValueOnce(new Error('取得に失敗'))
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.loadMoreFailed).toBe(true)
    expect(h.current.historyLoss.failedSources.size).toBe(1)
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
  const 地震の時刻 = '2026-01-01T07:06:00+09:00'
  const 震度速報 = (id: string, time: string): JMAQuake => ({
    kind: 'quake',
    id,
    time,
    issue: { source: '気象庁', time, type: '震度速報', correct: 'なし' },
    earthquake: {
      time: 地震の時刻,
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
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ tsunamis: [forecast(WITH_EXPIRE), forecast(WITHOUT_EXPIRE)] }))
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
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ tsunamis: [
      { ...forecast(WITH_EXPIRE), bodyText: BODY },
      forecast(WITHOUT_EXPIRE),
    ] }))
    const h = setup()
    await h.flush()

    expect(h.current.tsunamis[0].id).toBe('noto-2')
    expect(h.current.tsunamis[0].bodyText).toBe(BODY)
  })

  it('履歴からの復元で、期限を過ぎていれば最初から表示しない', async () => {
    vi.setSystemTime(new Date('2024-01-02T17:30:00+09:00'))
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ tsunamis: [forecast(WITH_EXPIRE), forecast(WITHOUT_EXPIRE)] }))
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
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ tsunamis: [
      forecast({ ...WITH_EXPIRE, eventId: 'other-tsunami' }),
      forecast(WITHOUT_EXPIRE),
    ] }))
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
  function kindsOf(events: LiveEvent[], kind: LiveEvent['kind']): LiveEvent[] {
    return events.filter(e => e.kind === kind)
  }

  // 正: リセットを挟まなければ、EEW の最終報は沈黙時間（10 秒）の後に届く。
  it('EEW テストは最終報を届ける', async () => {
    const events: LiveEvent[] = []
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
    const events: LiveEvent[] = []
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
    const events: LiveEvent[] = []
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
    const events: LiveEvent[] = []
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

  // 正: 続報まで流し、**初報と続報で「初めて受信したか」の印が入れ替わる**こと。
  // 読み上げが「受信しました」／「更新されました」を言い分ける唯一の材料で、印が
  // 付かないまま渡ると続報が初報と同じ文で読まれる（画面にも記録にも出ない食い違い）。
  it('推計震度分布図テストは続報まで流し、続報には更新の印が付く', async () => {
    const events: LiveEvent[] = []
    const h = setup({ onLiveEvent: (e) => { events.push(e) } })
    await h.flush()

    await act(async () => { await h.current.simulateEstimatedIntensity() })
    // 続報は初報の 16 秒後（`TEST_ESTIMATED_INTENSITY_FOLLOW_UP_DELAY_MS`）。初報の読み上げが
    // 鳴り終わるまで空けてあるので、10 秒では届かない。
    act(() => { vi.advanceTimersByTime(30_000) })

    const distributions = events.filter(
      (e): e is Extract<LiveEvent, { kind: 'estimatedIntensity' }> => e.kind === 'estimatedIntensity',
    )
    expect(distributions.map(e => e.isNew)).toEqual([true, false])
  })

  // 対照: **続報は同じ地震のものであること。** 発現時刻を進めてしまうと「別の地震へ入れ替え」
  // 扱いになり、反映はされるのに読み上げは初報と同じ文へ戻る（上のテストだけでは、印が
  // `[true, true]` になった理由が発現時刻のずれなのか写像のせいなのか分からない）。
  it('推計震度分布図テストの続報は同じ地震の発現時刻を保つ', async () => {
    const { createTestEstimatedIntensity } = await import('../utils/testData')
    const { quake, estimated, followUp } = createTestEstimatedIntensity()
    expect(followUp.arrivalTime).toBe(estimated.arrivalTime)
    expect(followUp.arrivalTime).toBe(quake.earthquake.time)
    // 発表時刻だけが進む（反映の判定はここしか見ない）
    expect(followUp.time > estimated.time).toBe(true)
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
    const events: LiveEvent[] = []
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

// 7 日間表示され続ける帯（地震回数・お知らせ）を、起動時にも復元する。
//
// 以前は南海トラフの 3 種だけを復元していて、この 2 つは抜けていた。**群発の最中に
// リロードすると、いちばん見たい回数の経過が消えていた。**
describe('DMDSS 版: 起動時に 7 日間の帯を復元する', () => {
  // **期限は実時刻からの相対で作る。** 固定の未来日時にすると、`setTimeout` が扱える上限
  // （約 24.8 日）を超えて**即座に発火**し、張った直後に帯が消える。
  const expireAt = () => new Date(Date.now() + 3 * 86_400_000).toISOString()

  const count = (): import('../types/earthquake').JMAEarthquakeCount => ({
    id: 'c1', eventId: '20260819120000', time: '2026-08-19T12:00:00+09:00',
    headline: '地震回数に関する情報をお知らせします。',
    reportDateTime: '2026-08-19T12:00:00+09:00', expireAt: expireAt(),
    items: [{ type: '累積地震回数', startTime: '2026-08-19T00:00:00+09:00', endTime: '2026-08-19T12:00:00+09:00', number: 12, feltNumber: 3 }],
    cancelled: false,
  })

  const notice = (): import('../types/earthquake').JMAQuakeNotice => ({
    id: 'n1', eventId: '20260819120000', time: '2026-08-19T12:00:00+09:00',
    headline: 'お知らせ', reportDateTime: '2026-08-19T12:00:00+09:00', expireAt: expireAt(),
    body: '観測点の入電停止について', cancelled: false,
  })

  it('正: 地震回数とお知らせを取りに行き、帯として出す', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({
      extras: [
        extra({ kind: 'earthquakeCount', data: count() }),
        extra({ kind: 'quakeNotice', data: notice() }),
      ],
    }))
    const h = setup()
    await h.flush()

    expect(fetchDmdataQuakeHistory).toHaveBeenCalled()
    expect(h.current.earthquakeCount?.id).toBe('c1')
    expect(h.current.quakeNotice?.id).toBe('n1')
  })

  it('対照: 発表が無ければ帯は出ない', async () => {
    const h = setup()
    await h.flush()

    expect(h.current.earthquakeCount).toBeNull()
    expect(h.current.quakeNotice).toBeNull()
  })

  // 安全弁: 履歴の取得が落ちたら**黙って空にしない**。
  //
  // 帯・長周期・地震・津波は 1 本の取得（`fetchDmdataQuakeHistory`）で返るので、
  // **「帯だけ落ちて他は出る」形はもう無い**。落ちたら全部出ないので、
  // 「発表が無かった」と区別が付くようにエラーを出す必要がある
  // （アーカイブが 1 日でも読めれば部分成功になるので、ここへ来るのは全滅したときだけ）。
  it('安全弁: 履歴の取得が落ちたらエラーを出す（黙って空にしない）', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockRejectedValue(new Error('落ちた'))
    const h = setup()
    await h.flush()

    expect(h.current.earthquakeCount).toBeNull()
    expect(h.current.error).toBe('落ちた')
  })
})

// 後発地震注意情報は発表から 7 日で失効する。**履歴はその 7 日ぶんを遡る**ので、
// 期限切れの報が「遡り幅の中の最新 1 通」として渡ってくることが現実に起きる。
//
// かつては取得側（`fetchDmdataKohatsu`）が期限切れを除いて返していたので届かなかった。
// 履歴をアーカイブ経由の 1 本へ寄せたときにその濾し器が無くなり、**期限切れの帯が出たまま
// 消えない**形になっていた（タイマーを張らないだけでは足りない）。
describe('後発地震注意情報の帯は期限で弾く', () => {
  function kohatsuInfo(expireInMs: number): JMAKohatsu {
    const now = serverDate()
    return {
      id: 'dmdata-kohatsu-k1-1',
      time: now.toISOString(),
      eventId: 'k1',
      headline: '北海道・三陸沖後発地震注意情報',
      body: '巨大地震が発生する可能性が平常時と比べて相対的に高まっています。',
      cancelled: false,
      reportDateTime: now.toISOString(),
      expireAt: new Date(now.getTime() + expireInMs).toISOString(),
    }
  }

  const withKohatsu = (k: JMAKohatsu) =>
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ extras: [extra({ kind: 'kohatsu', data: k })] }))

  // 正: 期限内なら帯に出す
  it('期限内なら帯に出す', async () => {
    withKohatsu(kohatsuInfo(60_000))
    const h = setup()
    await h.flush()

    expect(h.current.kohatsu?.eventId).toBe('k1')
  })

  // 対照: 期限切れは出さない。**これが濾し器を失って壊れていた形**
  it('期限切れは帯に出さない', async () => {
    withKohatsu(kohatsuInfo(-1_000))
    const h = setup()
    await h.flush()

    expect(h.current.kohatsu).toBeNull()
  })

  // 安全弁: 日時が壊れていても出さない。**「正当に期限切れ」と同じ無言の見送りに潰さず記録する**
  // （他の帯と同じ方針）
  it('期限が日時として読めないときは出さず、記録を残す', async () => {
    withKohatsu({ ...kohatsuInfo(60_000), expireAt: '壊れた日時' })
    const h = setup()
    await h.flush()

    expect(h.current.kohatsu).toBeNull()
    expect(vi.mocked(log.warn).mock.calls.map(c => c.join(' ')).join(' | '))
      .toContain('後発地震注意情報の期限を計算できません')
  })
})

// 履歴取得は例外を投げずに一部の失敗を吸収するため `error` は立たない。欠けたことを
// 状態へ残さないと、画面には「取れた分だけのカード」が出て失敗は何も出ない。
describe('履歴取得の一部失敗は状態へ残す', () => {
  it('正: 読めなかった取得元と取り込めなかった電文を積む', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ skipped: 3, failedArchiveUrls: ['https://x/a', 'live:2026-09-15'] }),
    )
    const h = setup()
    await h.flush()

    expect(totalSkipped(h.current.historyLoss)).toBe(3)
    expect(h.current.historyLoss.failedSources.size).toBe(2)
    // 全滅ではないので、全画面の失敗表示は出さない
    expect(h.current.error).toBeNull()
  })

  it('対照: 何も欠けていなければ空のまま', async () => {
    const h = setup()
    await h.flush()

    expect(totalSkipped(h.current.historyLoss)).toBe(0)
    expect(h.current.historyLoss.failedSources.size).toBe(0)
  })

  // 再生中はリプレイ側が自分の損失を出す。ライブで欠けた分を残すと同じ画面に 2 つの損失が並ぶ。
  it('安全弁: 再生が始まったら落とす', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ skipped: 2 }))
    const h = setup({ offset: null })
    await h.flush()
    expect(totalSkipped(h.current.historyLoss)).toBe(2)

    h.setOffset(-3_600_000)
    await h.flush()

    expect(totalSkipped(h.current.historyLoss)).toBe(0)
  })

  // **取得元の失敗は置き換え、壊れた電文は積む。** 直り方が違うので扱いを分ける。
  //
  // 取得元（日）の失敗は、その日でカーソルが止まるので次に押せば必ず読み直す
  // （→ 取得側の `oldestLoadedDay`）。だから消えてよい。
  it('正: 2 度目の取得で取得元が回復したら、その分は消える', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, failedArchiveUrls: ['https://x/a'] }),
    )
    const h = setup({ offset: null })
    await h.flush()
    expect(h.current.historyLoss.failedSources.size).toBe(1)

    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, oldestLoadedDay: '2026-08-20' }),
    )
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.historyLoss.failedSources.size).toBe(0)
  })

  // **壊れた電文は取り直しても直らない。** その日自体は読み切れているのでカーソルは進み、
  // 窓は重ならないので次の取得では 0 件になる。置き換えると**何も直っていないのに表示だけ
  // 消え、「もう欠けは無い」と読める**。
  it('正: 壊れた電文の分は、次に押しても消さずに積む', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, skipped: 2, oldestLoadedDay: '2026-09-10' }),
    )
    const h = setup({ offset: null })
    await h.flush()
    expect(totalSkipped(h.current.historyLoss)).toBe(2)

    // 次の窓には壊れた電文が無い（窓が重ならないので当然）
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, oldestLoadedDay: '2026-09-03' }),
    )
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(totalSkipped(h.current.historyLoss)).toBe(2)
  })

  it('対照: 2 度目も同じ取得元が読めなければ残る', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, failedArchiveUrls: ['https://x/a'] }),
    )
    const h = setup({ offset: null })
    await h.flush()
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(h.current.historyLoss.failedSources.size).toBe(1)
  })

  // **壊れた電文は積むが、押した回数だけ増えてはいけない。**
  //
  // カーソル方式では窓が重ならないので、同じ日を二度走査しない —— 1 通の破損は 1 回しか
  // 数えられない。**旧実装（毎回いちばん新しい日から読み直す）では同じ日を何度も走査するため、
  // 積む形にすると押した回数だけ増えていた**。窓が重ならないことが、積んでよい前提。
  it('安全弁: 壊れた電文は積むが、窓が進めば押した回数だけ増えない', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(
      history({ hasMore: true, skipped: 1, oldestLoadedDay: '2026-09-10' }),
    )
    const h = setup({ offset: null })
    await h.flush()

    // 以後の窓に破損は無い（同じ日を読み直さないので当然）
    vi.mocked(fetchDmdataQuakeHistory)
      .mockResolvedValueOnce(history({ hasMore: true, oldestLoadedDay: '2026-09-03' }))
      .mockResolvedValue(history({ hasMore: true, oldestLoadedDay: '2026-08-27' }))
    await act(async () => { await h.current.loadMoreEarthquakes() })
    await act(async () => { await h.current.loadMoreEarthquakes() })

    expect(totalSkipped(h.current.historyLoss)).toBe(1)
  })

  it('安全弁: 接続をやり直したら空へ戻す', async () => {
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history({ skipped: 2 }))
    const h = setup({ offset: null })
    await h.flush()
    expect(totalSkipped(h.current.historyLoss)).toBe(2)

    // 再生へ入って戻す（接続 effect が張り直され、遡り幅と一緒に損失も初期化される）
    h.setOffset(-3_600_000)
    await h.flush()
    vi.mocked(fetchDmdataQuakeHistory).mockResolvedValue(history())
    h.setOffset(null)
    await h.flush()

    expect(totalSkipped(h.current.historyLoss)).toBe(0)
  })
})

// 近く発火する電文を覗く口（`peekUpcomingPayloads`）。リプレイ中の投機的先行合成
// （`utils/speechPrefetch.ts`）だけが使う。
//
// **返す顔ぶれが狂っても画面には何も出ない。** 投機が空振りするか、要らないものを焼いて
// 控えを圧迫するだけで、症状は「なんとなく速くならない」にしかならない。
//
// 正・対照・安全弁の分担:
//   正   ＝ 地平線の内側にある未来の電文を返す
//   対照 ＝ 地平線の外と、もう時刻が来たものは返さない
//   安全弁＝ 焼いても使われないもの（サイレント注入・表示の片付け）を混ぜない
describe('近く発火する電文を覗く', () => {
  function commentaryPayload(id: string): ReplayPayload {
    const now = serverDate()
    return {
      kind: 'nankaiCommentary',
      data: {
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
        expireAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      },
    }
  }
  /** `payload` から識別子だけ取り出す（比較を読みやすくするため）。 */
  const idsOf = (payloads: readonly ReplayPayload[]) =>
    payloads.map(p => (p.kind === 'nankaiCommentary' ? p.data.id : p.kind))

  it('地平線の内側にある未来の電文を返す（正）', async () => {
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([
        { payload: commentaryPayload('in-10s'), replayTime: new Date(now.getTime() + 10_000) },
        { payload: commentaryPayload('in-30s'), replayTime: new Date(now.getTime() + 30_000) },
      ])
    })
    expect(idsOf(h.current.peekUpcomingPayloads(60_000))).toEqual(['in-10s', 'in-30s'])
  })

  it('地平線より先の電文は返さない（対照）', async () => {
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([
        { payload: commentaryPayload('in-10s'), replayTime: new Date(now.getTime() + 10_000) },
        { payload: commentaryPayload('in-5m'), replayTime: new Date(now.getTime() + 300_000) },
      ])
    })
    expect(idsOf(h.current.peekUpcomingPayloads(60_000))).toEqual(['in-10s'])
  })

  // 時刻が来たものは次のティックで取り出される。いまから焼いても間に合わない。
  it('もう時刻が来た電文は返さない（対照）', async () => {
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([
        { payload: commentaryPayload('past'), replayTime: new Date(now.getTime() - 1000) },
        { payload: commentaryPayload('future'), replayTime: new Date(now.getTime() + 10_000) },
      ])
    })
    expect(idsOf(h.current.peekUpcomingPayloads(60_000))).toEqual(['future'])
  })

  // **サイレント注入は音も読み上げも鳴らさない**（初期状態の復元）。焼いても一度も使われない。
  // 発火時刻が過去なので上の判定でも落ちるが、**その理由に頼らない** —— 注入の時刻の決め方が
  // 変われば、大量の無駄な合成が静かに始まる。
  it('サイレント注入の電文は返さない（安全弁）', async () => {
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([
        { payload: commentaryPayload('silent'), replayTime: new Date(now.getTime() + 10_000), silent: true },
        { payload: commentaryPayload('normal'), replayTime: new Date(now.getTime() + 20_000) },
      ])
    })
    expect(idsOf(h.current.peekUpcomingPayloads(60_000))).toEqual(['normal'])
  })

  it('日時として読めない地平線では何も返さない（安全弁）', async () => {
    const h = setup()
    await h.flush()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([
        { payload: commentaryPayload('in-10s'), replayTime: new Date(now.getTime() + 10_000) },
      ])
    })
    expect(h.current.peekUpcomingPayloads(Number.NaN)).toEqual([])
  })
})

// 2024-11-26 22:47 の大阪府北部（M2.5・最大震度1）の完全版の 55 秒後、1 分後に起きた石川県
// 西方沖（M6.6）の揺れが紛れ込んだ震度速報（福井県嶺南・滋賀県北部の震度3）が、**同じ
// EventID で**届いた。カードは据え置いていたのに、音・読み上げ・ウィンドウタイトルを起こす側は
// その判定を見ておらず、声だけが「新たに最大震度3を…観測しました」と言い、タイトルも
// 「最大震度3」へ変わっていた。気象庁自身は完全版で最大震度1 と確定させている
// （→ docs/spec/quake-spec.md §6.3）。
//
// **画面を見ても気づけない**（カードのほうは正しく据え置かれている）ので、ここで固定する。
// 止めるのは音・読み上げ・タイトルだけで `onLiveEvent` 自体は呼ぶため、見るのは呼び出しの
// 有無ではなく**印**（`LiveEventMeta.quakeHeldBack`）。
describe('カードが採らない電文には「据え置き」の印を付けて渡す', () => {
  const 地震の時刻 = '2024-11-26T22:45:00+09:00'

  const 完全版 = (連番: number, time: string, scale: IntensityScale = 10): JMAQuake => ({
    kind: 'quake',
    id: `dmdata-quake-20241126224512-${連番}`,
    time,
    issue: { source: '気象庁', time, type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: 地震の時刻,
      hypocenter: { name: '大阪府北部', latitude: 34.8, longitude: 135.6, depth: 10, magnitude: 2.5 },
      maxScale: scale,
      domesticTsunami: 'なし',
    },
    points: [
      { pref: '大阪府', addr: '大阪府', isArea: true, scale },
      { pref: '', addr: '大阪府北部', isArea: true, scale },
      { pref: '大阪府', addr: '枚方市大垣内', isArea: false, scale },
    ],
  })

  // 実電文どおり震源を持たない（震度速報に `Earthquake` 要素は出現しない）。
  const 震度速報 = (連番: number, time: string): JMAQuake => ({
    kind: 'quake',
    id: `dmdata-quake-20241126224512-${連番}`,
    time,
    issue: { source: '気象庁', time, type: '震度速報', correct: 'なし' },
    earthquake: {
      time: 地震の時刻,
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN },
      maxScale: 30,
      domesticTsunami: '調査中',
    },
    points: [
      { pref: '福井県', addr: '福井県', isArea: true, scale: 30 },
      { pref: '', addr: '福井県嶺南', isArea: true, scale: 30 },
      { pref: '滋賀県', addr: '滋賀県', isArea: true, scale: 30 },
      { pref: '', addr: '滋賀県北部', isArea: true, scale: 30 },
    ],
  })

  /** 震度を持たない電文（震源情報）。種別優先度では完全版に負ける。 */
  const 震源情報 = (連番: number, time: string): JMAQuake => ({
    ...完全版(連番, time),
    issue: { source: '気象庁', time, type: '震源情報', correct: 'なし' },
    earthquake: { ...完全版(連番, time).earthquake, maxScale: -1 },
    points: [],
  })

  /** 顕著な地震の震源要素更新（VXSE61）。震度は持たず、震源だけを訂正する。 */
  const 震源要素更新 = (連番: number, time: string, magnitude: number): JMAQuake => ({
    ...完全版(連番, time),
    issue: { source: '気象庁', time, type: '顕著な地震の震源要素更新のお知らせ', correct: 'なし' },
    earthquake: {
      time: 地震の時刻,
      hypocenter: { name: '大阪府北部', latitude: 34.8, longitude: 135.6, depth: 12, magnitude },
      maxScale: -1,
      domesticTsunami: 'なし',
    },
    points: [],
    freeText: '震源要素を訂正します。',
  })

  const 取消 = (連番: number, time: string): JMAQuake => ({
    ...完全版(連番, time),
    cancelled: true,
    issue: { source: '気象庁', time, type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '',
      hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 },
      maxScale: -1,
      domesticTsunami: '不明',
    },
    points: [],
  })

  /** 通知された地震情報の「最大震度と据え置きの印」。 */
  const 通知 = (fn: ReturnType<typeof vi.fn>): [number, boolean][] =>
    fn.mock.calls
      .filter(([e]) => (e as LiveEvent).kind === 'quake')
      .map(([e, meta]) => [
        (e as JMAQuake).earthquake.maxScale,
        (meta as LiveEventMeta | undefined)?.quakeHeldBack === true,
      ])

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    setReplayOffset(null)
  })

  it('完全版の後に届いた震度速報には印が立つ（正）', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => { h.current.injectEvent(震度速報(1, '2024-11-26T22:48:00+09:00')) })

    // 震度速報も `onLiveEvent` へは渡る（カードの選択・分布モードを閉じる・既読の記録は要る）が、
    // 印が立つので音・読み上げ・タイトルは起きない
    expect(通知(onLiveEvent)).toEqual([[10, false], [30, true]])
    // 表示も従来どおり据え置かれている（この 2 つが揃って初めて食い違いが消える）
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(10)
    expect(h.current.earthquakes[0]?.earthquake.hypocenter.name).toBe('大阪府北部')
  })

  it('完全版より前の震度速報には立たない（対照）', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(震度速報(1, '2024-11-26T22:46:00+09:00')) })
    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })

    expect(通知(onLiveEvent)).toEqual([[30, false], [10, false]])
  })

  // 安全弁: 印が立つ範囲が「据え置かれた電文」より広がっていないこと。同じ地震の続報でも、
  // カードが内容を採るものは従来どおり音・読み上げ・タイトル・タブ移動を起こす。
  it('カードが内容を採る続報には立たない（安全弁）', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => {
      h.current.injectEvent({
        ...完全版(2, '2024-11-26T22:51:00+09:00', 20),
        issue: { source: '気象庁', time: '2024-11-26T22:51:00+09:00', type: '各地の震度情報', correct: 'なし' },
      })
    })

    expect(通知(onLiveEvent)).toEqual([[10, false], [20, false]])
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(20)
  })

  // 安全弁: 印を立てる側へ倒しすぎないこと。**判定に使う `stateRef` はレンダー時にしか
  // 進まない**ので、同じティックで取消を処理した直後は取消済みのカードが `cancelledAt` を
  // 持たないまま見える。統合側は取消済みカードを候補から外して**別カードとして立てる**ため、
  // ここで印を立てると「画面には新しいカードが出ているのに声だけ止まる」逆向きの食い違いに
  // なる。取消を見た事実は入口で同期に台帳へ積まれるので、そちらと照合して避ける。
  it('取消を見た地震では立てない（同じティックで取消を処理した直後）', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    // 取消と、そのあとに発表された報を**同じ `act` で**流す（＝あいだにレンダーを挟まない）。
    // 震源情報は震度を持たないので、取消を見ていなければ種別優先度で据え置き扱いになる。
    act(() => {
      h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00'))
      h.current.injectEvent(震源情報(3, '2024-11-26T22:52:00+09:00'))
    })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, false])
  })

  // 正: 上の見送りは**取消対象のカードを掴んでいるあいだだけ**でなければならない。「取消を見た
  // 地震か」だけで見送ると、`sameQuakeEntry` が照合するのは地震そのものの同一性（`eventId`・
  // 地震の時刻）で**その地震が生きているあいだ不変**なので、一度取消を経験した地震では以後
  // すべての報で判定がバイパスされ、**この仕組みが塞いだはずの食い違いがそのまま戻る**。
  // 取消のあとに再発表があれば、そこから先は通常どおり判定する。
  it('取消のあと再発表された地震では、また印が立つ', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => { h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00')) })
    // 再発表（取消より後に発表された報なので、統合側は別カードとして立てる＝§6.2）
    act(() => { h.current.injectEvent(完全版(3, '2024-11-26T22:51:00+09:00')) })
    // その新しいカードに対して、紛れ込んだ震度速報が届く
    act(() => { h.current.injectEvent(震度速報(4, '2024-11-26T22:52:00+09:00')) })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, false, true])
    // 表示も据え置かれている（再発表の完全版のまま）
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(10)
  })

  // 正: **同じティックで捌かれた直前の報も既存として見える。** 判定に使う既存カードを
  // `stateRef`（レンダー時にしか進まない）だけから引くと、キューが 1 ティックでまとめて
  // 捌いたときに直前の報を見られず、据え置きに気づけない。同じティックの写しを持つのは
  // このため（→ `pendingQuakeCardsRef`）。
  it('同じティックで完全版と震度速報が続いても印が立つ', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    // 2 件を**同じ act で**流す（＝あいだにレンダーを挟まないので `stateRef` は空のまま）
    act(() => {
      h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00'))
      h.current.injectEvent(震度速報(2, '2024-11-26T22:48:00+09:00'))
    })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, true])
  })

  // 正: **同じティックで 3 件以上が捌けても判定が続く。** キューのディスパッチャは 1 ティックで
  // 発火済みのエントリをすべて処理するので（バックグラウンドタブでタイマーが間引かれると
  // まとめて落ちる）、「取消 → 再発表 → 紛れ込んだ震度速報」が 1 つのティックに並びうる。
  // 判定に使う既存カードを**同じティックの写し**から引いているので、レンダーを挟まなくても
  // 3 件目で正しく印が立つ。
  it('同じティックで取消・再発表・紛れ込み報が続いても印が立つ', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    // 3 件を**同じ act で**流す（＝あいだにレンダーを挟まない）
    act(() => {
      h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00'))
      h.current.injectEvent(完全版(3, '2024-11-26T22:51:00+09:00'))
      h.current.injectEvent(震度速報(4, '2024-11-26T22:52:00+09:00'))
    })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, false, true])
  })

  // 正: **カードが採らない門は据え置きだけではない。** 取消より前に発表された報は「取り下げ済みの
  // 内容」として丸ごと捨てられる（§6.2）。このとき対象カードは取消済みなので既存カードの
  // 候補から外れ、**据え置き判定からは「既存カードなし」に見える** —— そこで通してしまうと
  // 画面には何も出ないのに声だけが鳴る。統合側と同じ述語（`isRetractedQuakeReport`）を見る。
  it('取消より前に発表された報にも印が立つ', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => { h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00')) })
    // 取消より**前**に発表された報が遅れて届く（到着順の入れ替わり。当日の REST 経路・
    // リプレイで普通に起きる）。種別は取消と同じ＝`isRetractedQuakeReport` の条件を満たす。
    act(() => { h.current.injectEvent(完全版(3, '2024-11-26T22:48:00+09:00')) })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, true])
    // 統合側もその報を捨てている（カードは取消表示のまま増えない）
    expect(h.current.earthquakes.filter(q => !q.cancelledAt)).toHaveLength(0)
  })

  // 正: **震源要素更新（VXSE61）はどんな既存カードでも採る。** 統合側は専用の分岐で必ず受理して
  // 抜けるので、切り出した述語もその前提を持たなければならない。持たないと、1 通目でカードの
  // 種別が VXSE61 へ変わったあと、2 通目以降が「既存が VXSE61」の理由で据え置き扱いになり、
  // **カードは震源も規模も更新されているのに音・声・タイトルだけ止まる**（逆向きの食い違い）。
  it('震源要素更新の 2 通目にも印は立たない（カードは更新される）', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => { h.current.injectEvent(震源要素更新(2, '2024-11-26T22:55:00+09:00', 2.6)) })
    // 精査後のモーメントマグニチュードが添えられる 2 通目（実運用で起きる）
    act(() => { h.current.injectEvent(震源要素更新(3, '2024-11-26T23:10:00+09:00', 2.7)) })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, false])
    // カードは 2 通目の値を採っている（据え置いていない）
    expect(h.current.earthquakes[0]?.earthquake.hypocenter.magnitude).toBe(2.7)
    // 震度は完全版のものが残る（VXSE61 は震度を運ばない）
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(10)
  })

  // 正: **状態が受理しない報は、同じティックの写しへも載せない。** 取消より前に発表された報は
  // 状態更新が丸ごと捨てる（§6.2）のに、写しの更新だけがその門を通っていなかった —— 取消済み
  // カードを未取消カードで上書きし、**そのあとに届いた正規の再発表が汚染された写しを既存として
  // 見て据え置き扱いになる**（画面には新しいカードが出るのに声だけ止まる）。
  it('同じティックで取消・取消以前の報・再発表が続いても、再発表には印が立たない', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    // 4 件を**同じ act で**流す（＝あいだにレンダーを挟まないので写しが生きたまま繋がる）
    act(() => {
      h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00'))
      // 取消より**前**に発表された報（到着順の入れ替わり。状態更新はこれを捨てる）
      h.current.injectEvent(完全版(3, '2024-11-26T22:48:00+09:00'))
      // 正規の再発表（取消より後に発表されたので別カードとして立つ）
      h.current.injectEvent(震度速報(4, '2024-11-26T22:52:00+09:00'))
    })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, true, false])
  })

  // 安全弁: **記録に残さない理由でも印は立つ。** `notable` は「記録するか」だけを決める値で、
  // 「止めるか」とは別の軸。`return held.notable` のように混ぜると、**いちばん頻度の高い
  // 据え置き（発表時刻が古いだけ。実測で 96 件中 94 件）で音と声だけが元の症状へ戻る**。
  it('記録に残さない理由（発表時刻が古いだけ）でも印は立つ', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    // 発表時刻が古い続報（並び替えや遅延で日常的に届く＝`olderReport`・記録は出ない）
    act(() => { h.current.injectEvent(完全版(2, '2024-11-26T22:46:00+09:00', 20)) })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, true])
    // 表示も据え置かれている（古い報の震度を採っていない）
    expect(h.current.earthquakes[0]?.earthquake.maxScale).toBe(10)
  })

  // 正: **取消の判定は受信の入口で 1 回だけ行い、状態更新の中で再計算しない。** 再計算して
  // いた頃は、同じティックで「報 → 取消」の順に届いたとき**取消より前に発表された正当な報まで
  // 捨てていた** —— 状態更新はレンダー時に走るので、そのとき台帳には後から積まれた取消が既に
  // 載っている。§6.2 が捨てると定めているのは「取消の**後に届いた**報」なので、入口で決める
  // ほうが規則どおり。
  it('同じティックで「報 → 取消」の順なら、報は受理されてから取消される', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    // 2 件を**同じ act で**流す（＝報の状態更新がレンダーで走る時点では、台帳に取消が載る）
    act(() => {
      h.current.injectEvent(完全版(1, '2024-11-26T22:48:00+09:00'))
      h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00'))
    })

    // 報は捨てられず、カードが立ってから取消表示になる
    expect(h.current.earthquakes).toHaveLength(1)
    expect(h.current.earthquakes[0]?.cancelledAt).toBeTruthy()
  })

  // 対照: 取消より**後**に発表された報は別カードとして立つ（§6.2）ので、印は立たない
  it('取消より後に発表された報には印が立たない', async () => {
    const onLiveEvent = vi.fn()
    const h = setup({ onLiveEvent })
    await h.flush()

    act(() => { h.current.injectEvent(完全版(1, '2024-11-26T22:47:00+09:00')) })
    act(() => { h.current.injectEvent(取消(2, '2024-11-26T22:50:00+09:00')) })
    act(() => { h.current.injectEvent(完全版(3, '2024-11-26T22:51:00+09:00')) })

    expect(通知(onLiveEvent).map(([, 印]) => 印)).toEqual([false, false, false])
    expect(h.current.earthquakes.filter(q => !q.cancelledAt)).toHaveLength(1)
  })
})

// 録画ツール向けのイベントログ（→ `docs/spec/recording-interface-spec.md`）。
//
// **`onLiveEvent` まで届く電文は `useLiveEventHandler` が記録する。** ここで固定するのは、
// その手前で落としている電文にも記録が残ること —— 残らないと、編集する側からは「配信が
// 無かった」のと区別が付かない。
describe('録画ツール向けの記録: onLiveEvent へ届かない電文', () => {
  const AT = '2024-01-01T16:10:20+09:00'

  function eewReport(serial: string): EEWAlert {
    return {
      kind: 'eew',
      id: `dmdata-eew-replaylog-${serial}`,
      time: AT,
      test: false,
      earthquake: {
        originTime: AT, arrivalTime: AT, condition: '',
        hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 7.6 },
      },
      severity: 'Warning',
      cancelled: false,
      isFinal: false,
      issue: { eventId: 'replaylog-event', serial, time: AT },
      areas: [{ pref: '', name: '石川県能登', scaleFrom: 40, scaleTo: 50, kindCode: '11', arrivalTime: null }],
    }
  }

  const loggedTelegrams = () =>
    drainReplayEvents().events.filter((e): e is ReplayTelegramEvent => e.type === 'telegram')

  beforeEach(() => { __resetReplayEventLogForTest() })
  afterEach(() => { __resetReplayEventLogForTest(); vi.useRealTimers() })

  it('緊急地震速報の古い報にも記録が残る', () => {
    const h = setup()
    act(() => { h.current.injectEvent(eewReport('2')) })
    act(() => { h.current.injectEvent(eewReport('1')) })

    const skipped = loggedTelegrams().filter(t => t.skipped === 'staleSerial')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].kind).toBe('eew')
    expect(skipped[0].serial).toBe('1')
  })

  it('対照: 受理した報には見送りの印が付かない', () => {
    const h = setup()
    act(() => { h.current.injectEvent(eewReport('1')) })
    // 受理した分の記録は `useLiveEventHandler` の担当なので、ここには落とした分だけが出る
    expect(loggedTelegrams().filter(t => t.skipped === 'staleSerial')).toHaveLength(0)
  })

  it('地震・津波に関するお知らせにも記録が残る（音も読み上げも起こさない種別）', () => {
    // キューの捌きを進めるため（この経路は `injectEvent` と違って即時ではない）
    vi.useFakeTimers()
    const h = setup()
    const now = serverDate()
    act(() => {
      h.current.loadReplayEvents([{
        payload: {
          kind: 'quakeNotice',
          data: {
            id: 'notice-replaylog', time: now.toISOString(), eventId: 'notice-replaylog-event',
            headline: '沖縄県の震度データ入電停止のお知らせ', body: '本文', cancelled: false,
            reportDateTime: now.toISOString(),
            expireAt: new Date(now.getTime() + 60_000).toISOString(),
          },
        },
        replayTime: now,
      }])
    })
    // キューは 10ms 間隔で捌く（`injectEvent` と違い即時ではない）
    act(() => { vi.advanceTimersByTime(50) })

    const notDispatched = loggedTelegrams().filter(t => t.skipped === 'notDispatched')
    expect(notDispatched).toHaveLength(1)
    expect(notDispatched[0].kind).toBe('quakeNotice')
    expect(notDispatched[0].eventId).toBe('notice-replaylog-event')
  })
})
