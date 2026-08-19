// @vitest-environment jsdom
//
// useEarthquakes の「接続状態の結線」のテスト。
//
// このフックは WebSocket 接続・REST 履歴取得・イベントキュー・接続状態を一手に担うが、
// これまでテストが 1 本も無かった。全部を覆うのは現実的でないため、ここでは
// **`connectionStatus` がライブ受信の実態とずれないこと**だけに絞る。
//
// 絞る理由: 再生中は WebSocket を意図的に切るため、`connectionStatus` を更新し忘れると
// 直前の値（多くは 'connected'）が残り、受信していないのに「接続中」と表示され続ける。
// 型でも例外でも捕まらず、画面を見ても「繋がっているように見える」だけなので気づけない。
//
// 差し替えるのは外部 I/O（WebSocket・REST・観測点座標）だけ。時計や純粋関数は本物を使う。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'

// isDmdss はモジュールスコープの定数。テストごとに切り替えるため getter で公開する。
let mockIsDmdss = true
vi.mock('../utils/env', () => ({
  get isDmdss() { return mockIsDmdss },
}))

vi.mock('../utils/logger', () => ({
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
  const sockets: { connected: boolean; onStatusChange: ((s: string) => void) | null }[] = []
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
  fetchDmdataKohatsu: vi.fn(),
}))

vi.mock('../services/p2pquake', () => ({
  P2PQuakeWebSocket: FakeWebSocket,
  fetchHistory: vi.fn(),
  fetchJmaQuake: vi.fn(),
}))

const {
  fetchDmdataEarthquakes, fetchDmdataTsunamis, fetchDmdataLpgms,
  fetchDmdataNankai, fetchDmdataKohatsu,
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
  vi.mocked(fetchDmdataKohatsu).mockResolvedValue(null)
  vi.mocked(fetchHistory).mockResolvedValue([])
  vi.mocked(fetchJmaQuake).mockResolvedValue([])
})

afterEach(cleanup)

/** replayTimeOffset を差し替えられるハーネス。 */
function setup(opts: { apiKey?: string; offset?: number | null } = {}) {
  const view = renderHook(
    ({ offset }: { offset: number | null }) =>
      useEarthquakes(undefined, opts.apiKey ?? 'test-key', false, offset),
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

describe('DMDSS 版: 再生中は接続状態を replay にする', () => {
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

describe('standard 版: 再生中もライブ受信を続ける（VAR-1）', () => {
  beforeEach(() => { mockIsDmdss = false })

  it('replayTimeOffset が入っても replay へは移らない', () => {
    const h = setup({ offset: null })
    act(() => { sockets[0].onStatusChange?.('connected') })

    h.setOffset(-3600_000)
    // standard 版は P2PQuake のライブ受信を止めないため、実態のまま
    expect(h.current.connectionStatus).toBe('connected')
  })

  // 状態の文字列だけを見ても足りない。standard 分岐に「再生中は早期 return する」という
  // 回帰（VAR-1 を壊すバグ）が入っても、その経路は setState を呼ばないため
  // connectionStatus は 'connected' のまま変わらず、上のテストは緑のままになる。
  // 受信経路そのものが生きていることを socket で確かめる。
  it('再生に入っても受信用の接続を張り直して維持する（早期 return されていない）', async () => {
    const h = setup({ offset: null })
    expect(sockets.length).toBe(1)

    h.setOffset(-3600_000)
    // 依存配列に replayTimeOffset が入っているため張り替えは起きるが、
    // 「新しい接続が張られて connect 済み」であることが継続の証拠になる
    expect(sockets.length).toBe(2)
    expect(sockets[1].connected).toBe(true)
    // 張り替えのとき古い接続は必ず閉じる。ここを見ないと、cleanup が disconnect を
    // 呼び忘れる回帰（接続が二重に生き残り、同じ電文を二度受ける）を通してしまう。
    expect(sockets[0].connected).toBe(false)

    await h.flush()
    expect(h.current.error).toBeNull()
  })
})
