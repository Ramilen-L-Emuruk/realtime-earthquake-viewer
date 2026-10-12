// @vitest-environment jsdom
//
// **`readAllSensors` の統合フロー（複数センサーカードを跨いだ集約・1件でも
// 不正なら丸ごと中止する分岐）をテストする。** `sensorForm.test.ts` は
// センサー1個ぶんの変換だけを見ており、複数カードにまたがる集約ロジック
// （このファイルの `readAllSensors`）は未検証だった（#313 段 C-5 敵対的
// レビューで指摘）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearStoredToken, setStoredToken } from './api'
import { emptySensorFormValues, renderSensorCardHtml } from './sensorForm'
import { initBoardsView, mergeBoardRows, readAllSensors } from './viewBoards'
import type { DetectedBoard } from './detectedBoards'
import { IDENTITY_MATRIX } from '../receiver/stationConfigTypes'
import type { BoardEntry, StationInfo } from '../receiver/stationConfigTypes'
import { memoryTabContext } from './tabState'
import { confirmDialog } from './confirmDialog'

// **確認の窓は答えを決め打ちにする。** 窓そのものの振る舞いは `confirmDialog.test.ts` で見る。
vi.mock('./confirmDialog', () => ({ confirmDialog: vi.fn() }))
const confirmMock = vi.mocked(confirmDialog)

/**
 * 確認の窓の答えが画面へ届くまで待つ（窓は `Promise` で答える）。
 * 段数に頼らないよう、マクロタスクを 1 つ挟む（その間にマイクロタスクは全部捌ける）。
 */
async function settleConfirm(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  confirmMock.mockReset()
  confirmMock.mockResolvedValue(false)
})

/** `.sensor-cards` 直下にセンサーカードを並べたコンテナを作る（`viewBoards.ts` の DOM 構造を模す）。 */
function containerWithCards(cardsHtml: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = `<div class="sensor-cards">${cardsHtml}</div>`
  return container
}

describe('readAllSensors', () => {
  it('複数のセンサーカードを順に集約する', () => {
    const card1 = renderSensorCardHtml({ ...emptySensorFormValues(), sensorId: 'accel-0' })
    const card2 = renderSensorCardHtml({ ...emptySensorFormValues(), sensorId: 'accel-1' })
    const container = containerWithCards(card1 + card2)

    const result = readAllSensors(container)
    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) return
    expect(result.map((s) => s.sensorId)).toEqual(['accel-0', 'accel-1'])
  })

  it('センサーカードが 0 枚なら空配列を返す（基板にまだセンサーが無い状態を許容する）', () => {
    const container = containerWithCards('')
    const result = readAllSensors(container)
    expect(result).toEqual([])
  })

  it('DOM から削除されたカードは集約に含まれない', () => {
    const card1 = renderSensorCardHtml({ ...emptySensorFormValues(), sensorId: 'accel-0' })
    const card2 = renderSensorCardHtml({ ...emptySensorFormValues(), sensorId: 'accel-1' })
    const container = containerWithCards(card1 + card2)
    container.querySelectorAll('.sensor-card')[0]?.remove()

    const result = readAllSensors(container)
    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) return
    expect(result.map((s) => s.sensorId)).toEqual(['accel-1'])
  })

  it('1 件でも不正な入力があれば、正常なカードも含めて丸ごと保存を中止する', () => {
    const validCard = renderSensorCardHtml({ ...emptySensorFormValues(), sensorId: 'accel-0' })
    // sensorId が空文字列のまま（未入力のセンサーカード）。
    const invalidCard = renderSensorCardHtml(emptySensorFormValues())
    const container = containerWithCards(validCard + invalidCard)

    const result = readAllSensors(container)
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toContain('2 番目のセンサー')
  })
})

describe('mergeBoardRows', () => {
  const detected = (boardKey: string): DetectedBoard => ({
    boardKey,
    sensorIds: ['accel-0'],
    axisCounts: {},
    lastPacketMs: 1000,
  })
  const board = (boardKey: BoardEntry['boardKey']): BoardEntry => ({
    boardKey,
    stationId: 'st1',
    orientation: IDENTITY_MATRIX,
    sensors: [],
  })

  it('声が届いていて登録もされている基板は 1 行にまとまる', () => {
    const rows = mergeBoardRows([detected('mac:a')], [board('mac:a')])
    expect(rows).toHaveLength(1)
    expect(rows[0].detected).not.toBeNull()
    expect(rows[0].registered).not.toBeNull()
  })

  it('届いているが未登録の基板は registered が null', () => {
    const rows = mergeBoardRows([detected('mac:a')], [])
    expect(rows[0]).toMatchObject({ boardKey: 'mac:a', registered: null })
    expect(rows[0].detected).not.toBeNull()
  })

  // **これを落とすと「登録したのに届いていない」が画面のどこからも読めなくなる。**
  it('登録済みだが声の届いていない基板も残す（detected が null）', () => {
    const rows = mergeBoardRows([], [board('mac:b')])
    expect(rows[0]).toMatchObject({ boardKey: 'mac:b', detected: null })
    expect(rows[0].registered).not.toBeNull()
  })

  // **覆した: 以前は「届いている順 → 届いていない登録済み」。** 届いている順は受信のたびに
  // 入れ替わるので、設定の順を先に、未登録で届いている基板をその後ろへ置く（#713）。
  it('正: 並びは「登録済み（設定の順）→ 未登録で届いている基板」', () => {
    const rows = mergeBoardRows(
      [detected('mac:z'), detected('mac:a'), detected('mac:b')],
      [board('mac:m'), board('mac:a')],
    )
    expect(rows.map((r) => r.boardKey)).toEqual(['mac:m', 'mac:a', 'mac:z', 'mac:b'])
    expect(rows[0].detected).toBeNull()
    expect(rows[1].detected).not.toBeNull()
  })

  it('対照: 届いている順が変わっても登録済みの並びは変わらない', () => {
    const boards = [board('mac:m'), board('mac:a')]
    const one = mergeBoardRows([detected('mac:a'), detected('mac:m')], boards)
    const two = mergeBoardRows([detected('mac:m'), detected('mac:a')], boards)
    expect(one.map((r) => r.boardKey)).toEqual(two.map((r) => r.boardKey))
  })

  it('どちらも空なら空', () => {
    expect(mergeBoardRows([], [])).toEqual([])
  })
})

const STATION: StationInfo = { stationId: 'st1', displayName: '観測点1', lat: 0, lon: 0 }
const BOARD_A: BoardEntry = { boardKey: 'mac:aaaaaaaaaaaa', stationId: 'st1', orientation: IDENTITY_MATRIX, sensors: [] }
const BOARD_B: BoardEntry = { boardKey: 'mac:bbbbbbbbbbbb', stationId: 'st1', orientation: IDENTITY_MATRIX, sensors: [] }

/**
 * `/status` が返すセンサー。**基板 A は登録済み・`mac:cccccccccccc` は未登録**
 * ——「認識しているが設定に無い基板」を作るための組み合わせ。
 */
const STATUS_SENSORS = [
  { boardKey: 'mac:cccccccccccc', sensorId: 'accel-0', lastPacketMs: 9_000 },
  { boardKey: 'mac:cccccccccccc', sensorId: 'accel-1', lastPacketMs: 9_000 },
  { boardKey: BOARD_A.boardKey, sensorId: 'accel-0', lastPacketMs: 9_000 },
]

/** 15 度傾いて据えた基板が、静止した窓で測る重力（gal）。 */
const TILTED_15DEG = [0, 980.665 * Math.sin(Math.PI / 12), 980.665 * Math.cos(Math.PI / 12)]

/**
 * `/status` の `gravity.verdicts[]`。
 *
 * **`accel-0` は静止・`accel-1` は揺れていた**——「提案できる／できない」を
 * 同じ画面に並べるための組み合わせ。
 */
const REST_WINDOWS = [
  {
    boardKey: 'mac:cccccccccccc',
    sensorId: 'accel-0',
    atMs: 9_500,
    sampleCount: 2_984,
    meanGal: 980.665,
    sdGal: 1.4,
    axisMeanGal: TILTED_15DEG,
    scale: 'ok',
    restless: false,
  },
  {
    boardKey: 'mac:cccccccccccc',
    sensorId: 'accel-1',
    atMs: 9_500,
    sampleCount: 2_984,
    meanGal: 1_100,
    sdGal: 42,
    axisMeanGal: [10, 20, 1_099],
    scale: 'not-at-rest',
    restless: false,
  },
]

/** `/api/boards`・`/api/stations`・`/status`（と `/api/rest-windows`）の応答を固定値で返す最小限のモック。 */
function stubApiFetch(
  options: {
    readonly statusFails?: boolean
    readonly boardsFails?: boolean
    readonly restWindows?: { readonly ok: boolean; readonly body: unknown }
    readonly statusSensors?: readonly unknown[]
  } = {},
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: unknown) => {
      if (path === '/api/rest-windows' && options.restWindows !== undefined) {
        const r = options.restWindows
        return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => r.body }
      }
      if (path === '/api/boards') {
        if (options.boardsFails === true) return { ok: false, status: 503, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => ({ boards: [BOARD_A, BOARD_B] }) }
      }
      if (path === '/api/stations') {
        return { ok: true, status: 200, json: async () => ({ stations: [STATION] }) }
      }
      if (path === '/status') {
        if (options.statusFails === true) return { ok: false, status: 503, json: async () => ({}) }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            generatedAtMs: 10_000,
            sensors: options.statusSensors ?? STATUS_SENSORS,
            gravity: { verdicts: REST_WINDOWS },
          }),
        }
      }
      throw new Error(`unexpected fetch path: ${String(path)}`)
    }),
  )
}

/**
 * `initBoardsView` の未保存確認（`formDirty`/`confirmDiscardIfDirty`。#313 段 C-5
 * 2巡目レビューで「追加された最も重要な振る舞い変更がテスト0件」と指摘された）を検証する。
 */
describe('initBoardsView の未保存確認', () => {
  beforeEach(() => {
    stubApiFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function mountEditingBoardA(): Promise<HTMLElement> {
    const container = document.createElement('div')
    const controller = new AbortController()
    await initBoardsView(container, memoryTabContext(controller.signal, 'boards'))
    const editButtons = container.querySelectorAll<HTMLButtonElement>('.edit-board')
    editButtons[0].click()
    return container
  }

  it('センサーカードを追加した状態で別の基板の編集を押すと確認を求める', async () => {
    const container = await mountEditingBoardA()
    container.querySelector<HTMLButtonElement>('.add-sensor')?.click()

    const editButtons = container.querySelectorAll<HTMLButtonElement>('.edit-board')
    editButtons[1].click()

    expect(confirmMock).toHaveBeenCalledOnce()
    // 文面は 2026-10-12 ユーザー承認（`dom.ts` の `confirmDiscardUnsaved`）
    expect(confirmMock).toHaveBeenCalledWith(document, {
      title: '編集中の内容を破棄しますか？',
      body: '保存していない変更は失われます。',
      confirmLabel: '破棄する',
    })
  })

  it('確認をキャンセルすると、編集中の内容（追加したセンサーカード）が残る', async () => {
    const container = await mountEditingBoardA()
    container.querySelector<HTMLButtonElement>('.add-sensor')?.click()

    const editButtons = container.querySelectorAll<HTMLButtonElement>('.edit-board')
    editButtons[1].click()
    await settleConfirm()

    expect(container.querySelectorAll('.sensor-card')).toHaveLength(1)
    expect(container.querySelector<HTMLInputElement>('[name=boardKey]')?.value).toBe(BOARD_A.boardKey)
  })

  it('確認を承認すると、別の基板へ切り替わる（未保存の内容は破棄される）', async () => {
    const container = await mountEditingBoardA()
    container.querySelector<HTMLButtonElement>('.add-sensor')?.click()
    confirmMock.mockResolvedValue(true)

    const editButtons = container.querySelectorAll<HTMLButtonElement>('.edit-board')
    editButtons[1].click()
    await settleConfirm()

    expect(container.querySelector<HTMLInputElement>('[name=boardKey]')?.value).toBe(BOARD_B.boardKey)
    expect(container.querySelectorAll('.sensor-card')).toHaveLength(0)
  })

  // **「変更不可」を新規登録でも出すと嘘になる。** `boardKey` が読み取り専用になるのは
  // 既存の編集中だけで（`fillForm` の `keyInput.readOnly = board !== null`）、新規登録では
  // 入力必須。文言を静的テキストで固定していたため実挙動と食い違っていた（レビューで検出）。
  it('新規登録では「変更不可」と表示しない（入力必須なので嘘になる）', async () => {
    const container = document.createElement('div')
    await initBoardsView(container, memoryTabContext(new AbortController().signal, 'boards'))

    expect(container.querySelector('.boardKey-label')?.textContent).toBe('基板 Key')
    expect(container.querySelector<HTMLInputElement>('[name=boardKey]')?.readOnly).toBe(false)
  })

  it('既存の基板を編集するときだけ「変更不可」と表示する', async () => {
    const container = await mountEditingBoardA()

    expect(container.querySelector('.boardKey-label')?.textContent).toBe('基板 Key（変更不可）')
    expect(container.querySelector<HTMLInputElement>('[name=boardKey]')?.readOnly).toBe(true)
  })

  it('「新規登録へ」で戻すと「変更不可」の表示も外れる', async () => {
    const container = await mountEditingBoardA()
    container.querySelector<HTMLButtonElement>('.reset-form')?.click()

    expect(container.querySelector('.boardKey-label')?.textContent).toBe('基板 Key')
    expect(container.querySelector<HTMLInputElement>('[name=boardKey]')?.readOnly).toBe(false)
  })

  it('未編集（dirty でない）状態で別の基板の編集を押しても確認を求めない', async () => {
    const container = await mountEditingBoardA()

    const editButtons = container.querySelectorAll<HTMLButtonElement>('.edit-board')
    editButtons[1].click()

    expect(confirmMock).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('[name=boardKey]')?.value).toBe(BOARD_B.boardKey)
  })
})

/**
 * 認識済みの基板からの登録（#344）。**基板 Key・センサー ID の手打ちを無くすのが
 * 目的**——`sensorId` が 1 文字でも食い違うと、校正値が 1 つも効かないまま既定値で
 * 動き続ける（`detectedBoards.ts` 冒頭）。
 */
describe('認識済みの基板からの登録', () => {
  beforeEach(() => {
    stubApiFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function mount(): Promise<HTMLElement> {
    const container = document.createElement('div')
    await initBoardsView(container, memoryTabContext(new AbortController().signal, 'boards'))
    return container
  }

  // **表は 1 つ。** 声が届いている基板と設定にある基板を分けて並べると、大半が
  // 両方に該当するので同じ基板が二度出る（ユーザーの指摘で統合した）。
  it('声が届いている基板と登録済みの基板を 1 つの表へまとめ、重複させない', async () => {
    const container = await mount()
    const rows = container.querySelectorAll<HTMLElement>('.boards-table tbody tr')
    const keys = [...rows].map((r) => r.dataset.boardKey)

    // 登録済みの A・B（設定の順）→ 未登録で届いている C。受信の新しさでは並べない（#713）。
    expect(keys).toEqual([BOARD_A.boardKey, BOARD_B.boardKey, 'mac:cccccccccccc'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('設定に無い基板にだけ「登録」ボタンを出し、登録済みには編集・削除を出す', async () => {
    const container = await mount()
    const unregistered = container.querySelector<HTMLElement>('tr[data-board-key="mac:cccccccccccc"]')!
    const registered = container.querySelector<HTMLElement>(`tr[data-board-key="${BOARD_A.boardKey}"]`)!

    expect(unregistered.querySelector('.register-board')).not.toBeNull()
    expect(unregistered.querySelector('.edit-board')).toBeNull()
    expect(registered.querySelector('.register-board')).toBeNull()
    expect(registered.querySelector('.edit-board')).not.toBeNull()
    expect(registered.textContent).toContain(STATION.displayName)
  })

  // **「登録したのに届いていない」が読めること。** 分けていた頃は、声の一覧に
  // 現れず設定の一覧は受信の様子を持たなかったので、どこからも分からなかった。
  it('声が届いていない登録済みの基板も、未受信として出す', async () => {
    const container = await mount()
    const row = container.querySelector<HTMLElement>(`tr[data-board-key="${BOARD_B.boardKey}"]`)

    expect(row?.textContent).toContain('未受信')
    expect(row?.textContent).toContain(STATION.displayName)
    expect(row?.querySelector('.edit-board')).not.toBeNull()
  })

  it('「登録」で基板 Key と、その基板が名乗るセンサーのカードが入る', async () => {
    const container = await mount()
    container.querySelector<HTMLButtonElement>('.register-board')?.click()

    expect(container.querySelector<HTMLInputElement>('[name=boardKey]')?.value).toBe('mac:cccccccccccc')
    const ids = Array.from(container.querySelectorAll<HTMLInputElement>('.s-sensorId')).map((i) => i.value)
    expect(ids).toEqual(['accel-0', 'accel-1'])
  })

  // **カードの軸の本数は届いた本数で作る。** 2 軸のセンサーに 3 軸のカードを作って保存すると、
  // 軸の本数が食い違ってパケットを捨て続ける（敵対的レビューで検出）。
  it('正: 「登録」は届いたパケットの軸の本数でカードを作る', async () => {
    vi.unstubAllGlobals()
    stubApiFetch({
      statusSensors: [
        { boardKey: 'mac:cccccccccccc', sensorId: 'i2c0-6a', lastPacketMs: 9_000, axisCount: 2 },
        { boardKey: 'mac:cccccccccccc', sensorId: 'i2c0-68', lastPacketMs: 9_000, axisCount: 3 },
      ],
    })
    const container = await mount()
    container.querySelector<HTMLButtonElement>('.register-board')?.click()

    // カードはセンサー ID の順（`i2c0-68` → `i2c0-6a`）。
    const cards = container.querySelectorAll<HTMLElement>('.sensor-card')
    expect(cards[0].querySelectorAll('.s-axis-offset')).toHaveLength(3)
    expect(cards[1].querySelectorAll('.s-axis-offset')).toHaveLength(2)
    // 2 軸のカードがあっても、欄の描き直しを「壊れた」と数えない。
    expect(container.querySelector('.boards-error')?.textContent).toBe('')
  })

  it('対照: 軸の本数を名乗らない（古いホストの）センサーは 3 軸のカードで作る', async () => {
    const container = await mount()
    container.querySelector<HTMLButtonElement>('.register-board')?.click()
    for (const card of container.querySelectorAll<HTMLElement>('.sensor-card')) {
      expect(card.querySelectorAll('.s-axis-offset')).toHaveLength(3)
    }
  })

  it('手で足す口は軸の本数ごとに分かれている（まだ届いていない基板を先に用意する）', async () => {
    const container = await mount()
    container.querySelectorAll<HTMLButtonElement>('.edit-board')[0].click()
    container.querySelector<HTMLButtonElement>('.add-sensor[data-axes="2"]')?.click()
    container.querySelector<HTMLButtonElement>('.add-sensor[data-axes="3"]')?.click()

    const cards = container.querySelectorAll<HTMLElement>('.sensor-card')
    expect([...cards].map((c) => c.querySelectorAll('.s-axis-offset').length)).toEqual([2, 3])
  })

  // **入れただけでは保存されていない。** dirty を立てておかないと、この直後に
  // 別の基板の編集を押したとき確認なしで消える。
  it('「登録」で入れた内容は未保存として扱う（別の基板へ移るとき確認を求める）', async () => {
    const container = await mount()
    container.querySelector<HTMLButtonElement>('.register-board')?.click()

    container.querySelectorAll<HTMLButtonElement>('.edit-board')[0].click()
    await settleConfirm()

    expect(confirmMock).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLInputElement>('[name=boardKey]')?.value).toBe('mac:cccccccccccc')
  })

  it('新規登録なので基板 Key は入力できるまま（「変更不可」にしない）', async () => {
    const container = await mount()
    container.querySelector<HTMLButtonElement>('.register-board')?.click()

    expect(container.querySelector<HTMLInputElement>('[name=boardKey]')?.readOnly).toBe(false)
    expect(container.querySelector('.boardKey-label')?.textContent).toBe('基板 Key')
  })

  it('基板 Key の候補に、認識済みの基板が並ぶ', async () => {
    const container = await mount()
    const options = Array.from(
      container.querySelectorAll<HTMLOptionElement>('#detected-board-keys option'),
    ).map((o) => o.value)
    expect(options).toEqual([BOARD_A.boardKey, 'mac:cccccccccccc'])
  })

  // **候補は「いまフォームに入っている基板」のものだけ。** 全基板ぶんを混ぜると、
  // 別の基板のセンサー ID を選べてしまい、手で打ったのと同じ取り違えが起きる。
  it('センサー ID の候補は、選んでいる基板のものだけになる', async () => {
    const container = await mount()
    const sensorOptions = (): readonly string[] =>
      Array.from(container.querySelectorAll<HTMLOptionElement>('#detected-sensor-ids option')).map(
        (o) => o.value,
      )

    container.querySelector<HTMLButtonElement>('.register-board')?.click()
    expect(sensorOptions()).toEqual(['accel-0', 'accel-1'])

    const keyInput = container.querySelector<HTMLInputElement>('[name=boardKey]')
    if (keyInput === null) throw new Error('基板 Key の入力欄が無い')
    keyInput.value = BOARD_A.boardKey
    keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(sensorOptions()).toEqual(['accel-0'])
  })

  // **`/status` は候補を出すためだけの材料。** 取れなくても手で入力して保存できる。
  it('/status が取れなくても基板の一覧と編集は使える', async () => {
    vi.unstubAllGlobals()
    stubApiFetch({ statusFails: true })
    const container = await mount()

    expect(container.querySelectorAll('.boards-table tbody tr')).toHaveLength(2)
    expect(container.querySelector('.boards-error')?.textContent).toBe('')
    expect(container.querySelector('.boards-note')?.textContent).toContain('手で入力すること')
    expect(container.querySelectorAll('#detected-board-keys option')).toHaveLength(0)
  })
})

/**
 * 静止窓の診断と「鉛直を合わせる」（#347）。
 *
 * **押せる・押せないと、押した結果の両方を見る。** 押せない理由を出さないと
 * 「押しても何も起きない」になり、書き込む先を間違えると提案が黙って捨てられる。
 */
/**
 * 「鉛直を合わせる」の材料（`GET /api/rest-windows`）。accel-0 は 15 度傾いたまま静止、
 * accel-1 はいま静止していない（`stillSinceMs: null`）。**校正前の値**なので、カードの
 * 校正が既定値（オフセット 0・感度 1・回転なし）なら `/status` の判定と同じ重力になる。
 */
function tiltRestWindows(): { ok: boolean; body: { sensors: unknown[] } } {
  return {
    ok: true,
    body: {
      sensors: [
        {
          boardKey: 'mac:cccccccccccc',
          sensorId: 'accel-0',
          stillSinceMs: 1_000,
          windows: [{ atMs: 31_000, meanGal: TILTED_15DEG, sampleCount: 3000 }],
        },
        {
          boardKey: 'mac:cccccccccccc',
          sensorId: 'accel-1',
          stillSinceMs: null,
          windows: [{ atMs: 31_000, meanGal: [0, 0, 980.665], sampleCount: 3000 }],
        },
      ],
    },
  }
}

describe('基板の傾きを合わせる', () => {
  /** 開いた画面。**後片付けで閉じる**（10 秒ごとの取り直しを次のテストへ持ち越さない）。 */
  let mounted: AbortController | null = null
  /** 静止窓の応答。**テストの途中で差し替えられる**（押した瞬間に取り直すことの確認）。 */
  let restWindows = tiltRestWindows()

  beforeEach(() => {
    restWindows = tiltRestWindows()
    setStoredToken('test-token')
    stubApiFetch({
      get restWindows() {
        return restWindows
      },
    })
  })
  afterEach(() => {
    mounted?.abort()
    mounted = null
    clearStoredToken()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** 未登録の基板（`mac:cccccccccccc`）を登録フォームへ移し、カードを 2 枚出す。 */
  async function mountRegistering(): Promise<HTMLElement> {
    const container = document.createElement('div')
    mounted = new AbortController()
    await initBoardsView(container, memoryTabContext(mounted.signal, 'boards'))
    container.querySelector<HTMLButtonElement>('.register-board')?.click()
    return container
  }

  function tiltButton(container: HTMLElement): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('.board-orientation .suggest-tilt')
    if (button === null) throw new Error('「鉛直を合わせる」のボタンが無い')
    return button
  }

  /** 押して、結果が出るまで待つ（押すとホストへ取り直しに行くので非同期）。 */
  async function pressTilt(container: HTMLElement): Promise<string> {
    const read = (): string => container.querySelector('.board-orientation .b-tilt-result')?.textContent ?? ''
    const result = container.querySelector('.board-orientation .b-tilt-result')
    if (result !== null) result.textContent = ''
    tiltButton(container).click()
    await vi.waitFor(() => expect(read()).not.toBe(''))
    return read()
  }

  function cardAt(container: HTMLElement, index: number): HTMLElement {
    const card = container.querySelectorAll<HTMLElement>('.sensor-card')[index]
    if (card === undefined) throw new Error(`${index} 番目のセンサーカードが無い`)
    return card
  }

  /** 基板の向きの欄（行が東・北・上、列が基板の X・Y・Z 軸）。 */
  function orientationOf(container: HTMLElement): number[][] {
    const at = (row: number, col: number): number =>
      Number(
        container.querySelector<HTMLInputElement>(`.board-orientation .b-orientation[data-row="${row}"][data-col="${col}"]`)
          ?.value,
      )
    return [
      [at(0, 0), at(0, 1), at(0, 2)],
      [at(1, 0), at(1, 1), at(1, 2)],
      [at(2, 0), at(2, 1), at(2, 2)],
    ]
  }

  function headingInput(container: HTMLElement): HTMLInputElement {
    const heading = container.querySelector<HTMLInputElement>('.board-orientation .b-heading')
    if (heading === null) throw new Error('方角の入力欄が無い')
    return heading
  }

  /** 行列を重力ベクトルへ適用する。**提案が本当に鉛直を向かせるかの確認。** */
  function applyTo(m: number[][], v: readonly number[]): number[] {
    return [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2])
  }

  it('カードごとに静止の様子が出て、静止している 3 軸のセンサーがあれば基板のボタンが押せる', async () => {
    const container = await mountRegistering()

    expect(cardAt(container, 0).querySelector('.s-rest-note')?.textContent).toContain('取り付けの傾き 15°')
    // 上の一行はホストの診断（保存済みの設定で見た `/status` の判定）で、ボタンの材料とは別。
    expect(cardAt(container, 1).querySelector('.s-rest-note')?.textContent).toContain('揺れている間は合わせられない')
    expect(tiltButton(container).disabled).toBe(false)
  })

  // **押しても何も起きない形にしない。** 理由が読めること。
  it('いまの置き方で静止しているセンサーが無ければ押せず、理由が出る', async () => {
    restWindows.body.sensors[0] = { ...(restWindows.body.sensors[0] as object), stillSinceMs: null }
    const container = await mountRegistering()

    const button = tiltButton(container)
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('いまの置き方で静止した窓がまだ無い（置いてから 1 分ほど動かさずに待つこと）')
  })

  // **水平の 2 本の軸だけでは重力の 3 成分は決まらない。**（2 軸のセンサーも材料に数えるが、
  // 軸が 3 方向へ散っていなければ押せない。2026-10-10 から。）
  it('安全弁: 静止しているのが水平の 2 軸のセンサーだけなら押せない', async () => {
    restWindows.body.sensors[0] = {
      ...(restWindows.body.sensors[0] as object),
      windows: [{ atMs: 31_000, meanGal: [TILTED_15DEG[0], TILTED_15DEG[1]], sampleCount: 3000 }],
    }
    const container = await mountRegistering()
    cardAt(container, 0).outerHTML = renderSensorCardHtml({ ...emptySensorFormValues(2), sensorId: 'accel-0' })
    cardAt(container, 0).querySelector('.s-sensorId')?.dispatchEvent(new Event('input', { bubbles: true }))

    expect(cardAt(container, 0).querySelectorAll('.s-axis-offset')).toHaveLength(2)
    expect(tiltButton(container).disabled).toBe(true)
  })

  // 正: 2 軸のセンサーだけの基板（IIS2ICLX を立てて付けたもの）でも、軸が 3 方向へ散っていれば
  // 押せて、基板の向きが書き換わる。**画面の配線を通した確かめ**（解く本体は calibrationSuggest.test.ts）。
  it('正: 2 軸のセンサーだけでも、軸が 3 方向へ散っていれば押せて、重力が真上を向く', async () => {
    const [, gy, gz] = TILTED_15DEG
    restWindows.body.sensors = [
      { boardKey: 'mac:cccccccccccc', sensorId: 'accel-0', stillSinceMs: 1_000, windows: [{ atMs: 31_000, meanGal: [0, gy], sampleCount: 3000 }] },
      // 立てて付けた 1 個: 1 本目が基板の Z、2 本目が X を測る。
      { boardKey: 'mac:cccccccccccc', sensorId: 'accel-1', stillSinceMs: 1_000, windows: [{ atMs: 31_000, meanGal: [gz, 0], sampleCount: 3000 }] },
    ]
    const container = await mountRegistering()
    cardAt(container, 0).outerHTML = renderSensorCardHtml({ ...emptySensorFormValues(2), sensorId: 'accel-0' })
    cardAt(container, 1).outerHTML = renderSensorCardHtml({
      ...emptySensorFormValues(2),
      sensorId: 'accel-1',
      axes: [
        { vector: ['0', '0', '1'], offset: '0' },
        { vector: ['1', '0', '0'], offset: '0' },
      ],
    })
    cardAt(container, 1).querySelector('.s-sensorId')?.dispatchEvent(new Event('input', { bubbles: true }))

    await vi.waitFor(() => expect(tiltButton(container).disabled).toBe(false))
    expect(await pressTilt(container)).toContain('保存するまで効かない')

    const fixed = applyTo(orientationOf(container), TILTED_15DEG)
    expect(fixed[0]).toBeCloseTo(0, 2)
    expect(fixed[1]).toBeCloseTo(0, 2)
    expect(fixed[2]).toBeCloseTo(980.665, 2)
  })

  // 2026-10-10 に覆した: 前は読めないカードを飛ばして押せる・押せないを決め、押すと全部のカードを
  // 読み直してそのカードで断っていた（押せるのに押すと断られる）。押す前から押せなくし、理由を出す。
  it('安全弁: 読めないカード（打ちかけ）が 1 枚でもあれば押せず、押したときと同じ理由が出る', async () => {
    const container = await mountRegistering()
    expect(tiltButton(container).disabled).toBe(false)

    const id = cardAt(container, 1).querySelector<HTMLInputElement>('.s-sensorId')
    if (id === null) throw new Error('センサー ID の入力欄が無い')
    id.value = ''
    id.dispatchEvent(new Event('input', { bubbles: true }))

    const button = tiltButton(container)
    expect(button.disabled).toBe(true)
    expect(button.title.startsWith('2 番目のセンサー: ')).toBe(true)
  })

  it('押すと基板の向きが書き換わり、その向きで重力が真上を向く', async () => {
    const container = await mountRegistering()

    expect(await pressTilt(container)).toContain('保存するまで効かない')

    const fixed = applyTo(orientationOf(container), TILTED_15DEG)
    expect(fixed[0]).toBeCloseTo(0, 2)
    expect(fixed[1]).toBeCloseTo(0, 2)
    expect(fixed[2]).toBeCloseTo(980.665, 2)
  })

  // **回帰（2026-10-04 実機）:** 前は `/status` の判定（その窓を閉じた時点の向きで測った重力）を
  // いまの向きへ重ねていたので、保存せずに続けて押すと同じ傾きを 2 回足していた。
  it('正: 続けて押しても同じ向きのまま（2 回目は傾き 0°）', async () => {
    const container = await mountRegistering()

    await pressTilt(container)
    const first = orientationOf(container)
    expect(await pressTilt(container)).toContain('傾き 0°')
    const second = orientationOf(container)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) expect(second[i][j]).toBeCloseTo(first[i][j], 5)
    }
  })

  // **重力はカードの値で出し直す**（保存前のゼロ点も効く）。
  it('対照: カードのゼロ点を先に引いてから向きを出す', async () => {
    restWindows.body.sensors[0] = {
      boardKey: 'mac:cccccccccccc',
      sensorId: 'accel-0',
      stillSinceMs: 1_000,
      windows: [{ atMs: 31_000, meanGal: [TILTED_15DEG[0] + 50, TILTED_15DEG[1], TILTED_15DEG[2]], sampleCount: 3000 }],
    }
    const container = await mountRegistering()
    const offsetX = cardAt(container, 0).querySelector<HTMLInputElement>('.s-axis-offset[data-axis="0"]')
    if (offsetX === null) throw new Error('ゼロ点の入力欄が無い')
    offsetX.value = '50'

    await pressTilt(container)

    const fixed = applyTo(orientationOf(container), TILTED_15DEG)
    expect(fixed[0]).toBeCloseTo(0, 2)
    expect(fixed[2]).toBeCloseTo(980.665, 2)
  })

  // **押した瞬間に取り直す。** 画面を開いた後で置き直した基板を、前の置き方で合わせない。
  it('安全弁: 押した瞬間のホストの答えで判じる（開いた後に動かした基板は合わせない）', async () => {
    const container = await mountRegistering()
    expect(tiltButton(container).disabled).toBe(false)
    const before = orientationOf(container)

    // 開いた後で動かした（ホストの静止の始まりが消えた）。
    restWindows.body.sensors[0] = { ...(restWindows.body.sensors[0] as object), stillSinceMs: null }

    expect(await pressTilt(container)).toBe('いまの置き方で静止した窓がまだ無い（置いてから 1 分ほど動かさずに待つこと）')
    expect(orientationOf(container)).toEqual(before)
    // 断った直後に、古い控えで押せる状態へ戻さない。
    expect(tiltButton(container).disabled).toBe(true)
  })

  // **控えには投げた順で新しいものだけを入れる。** 10 秒ごとの取り直しが先に投げられて
  // 後から着くと、押した瞬間の答え（いま静止していない）を古い答えで上書きしていた。
  it('安全弁: 先に投げた取り直しの返事が後から着いても、押した瞬間の答えを上書きしない', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    try {
      const container = await mountRegistering()
      const button = tiltButton(container)
      expect(button.disabled).toBe(false)

      // 10 秒ごとの取り直しを投げさせ、その返事（まだ静止している）を止めておく。
      const releaseOld = holdNextRestWindows()
      vi.advanceTimersByTime(10_000)

      // その後に基板を動かして押す（押した瞬間の答えは「いま静止していない」）。
      restWindows = tiltRestWindows()
      restWindows.body.sensors[0] = { ...(restWindows.body.sensors[0] as object), stillSinceMs: null }
      expect(await pressTilt(container)).toBe('いまの置き方で静止した窓がまだ無い（置いてから 1 分ほど動かさずに待つこと）')
      expect(button.disabled).toBe(true)

      // 先に投げた返事が後から着く。
      releaseOld()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(button.disabled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // **材料は返事が着いた時点のカードから取る。** 押した後に外したカードの窓で向きを出さない。
  it('安全弁: 問い合わせ中に静止していたセンサーのカードを外したら、そのセンサーでは合わせない', async () => {
    const container = await mountRegistering()
    const before = orientationOf(container)
    const release = holdNextRestWindows()
    tiltButton(container).click()

    cardAt(container, 0).querySelector<HTMLButtonElement>('.remove-sensor')?.click()
    release()

    await vi.waitFor(() =>
      expect(container.querySelector('.board-orientation .b-tilt-result')?.textContent).toBe(
        'いまの置き方で静止した窓がまだ無い（置いてから 1 分ほど動かさずに待つこと）',
      ),
    )
    expect(orientationOf(container)).toEqual(before)
  })

  it('安全弁: 静止の始まりより前に閉じた窓（前の置き方）は使わない', async () => {
    restWindows.body.sensors[0] = {
      boardKey: 'mac:cccccccccccc',
      sensorId: 'accel-0',
      stillSinceMs: 40_000,
      windows: [{ atMs: 31_000, meanGal: TILTED_15DEG, sampleCount: 3000 }],
    }
    const container = await mountRegistering()
    const button = tiltButton(container)
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('いまの置き方で静止した窓がまだ無い（置いてから 1 分ほど動かさずに待つこと）')
  })

  /**
   * 押したときの問い合わせを止めておき、あとで返事を返す。
   *
   * **返事には切り替え先（基板 A）の同じセンサー ID の窓も入れる。** 入れないと、切り替えた後の
   * フォームでは材料が見つからず手前で止まり、「外れた欄へ書く」経路まで届かない。
   */
  function holdNextRestWindows(): () => void {
    let release: () => void = () => {}
    const body = new Promise((resolve) => {
      const b = tiltRestWindows().body
      release = () =>
        resolve({
          sensors: [
            ...b.sensors,
            {
              boardKey: 'mac:aaaaaaaaaaaa',
              sensorId: 'accel-0',
              stillSinceMs: 1_000,
              windows: [{ atMs: 31_000, meanGal: TILTED_15DEG, sampleCount: 3000 }],
            },
          ],
        })
    })
    restWindows = { ok: true, body: body as unknown as { sensors: unknown[] } }
    return release
  }

  it('安全弁: 問い合わせ中は、描き直しが走っても押せないまま（2 回ぶん書かない）', async () => {
    const container = await mountRegistering()
    const button = tiltButton(container)
    const release = holdNextRestWindows()

    button.click()
    expect(button.disabled).toBe(true)
    // 10 秒ごとの取り直しと同じ描き直し（2 枚目の ID 打ち換えで全カードが描き直される）。
    cardAt(container, 1).querySelector('.s-sensorId')?.dispatchEvent(new Event('input', { bubbles: true }))
    expect(button.disabled).toBe(true)

    release()
    await vi.waitFor(() =>
      expect(container.querySelector('.board-orientation .b-tilt-result')?.textContent).toContain('保存するまで効かない'),
    )
    expect(button.disabled).toBe(false)
  })

  it('安全弁: 問い合わせ中にフォームを切り替えたら、返事が来ても何も書かない', async () => {
    const container = await mountRegistering()
    const panel = container.querySelector('.board-orientation')
    const release = holdNextRestWindows()
    tiltButton(container).click()

    // 登録フォーム（未保存）から基板 A の編集へ切り替える。確認には「破棄する」と答える。
    confirmMock.mockResolvedValue(true)
    container.querySelectorAll<HTMLButtonElement>('.edit-board')[0]?.click()
    await settleConfirm()
    expect(container.contains(panel)).toBe(false)
    confirmMock.mockClear()
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 新しい基板の欄には書かない。
    expect(container.querySelector('.board-orientation .b-tilt-result')?.textContent).toBe('')
    expect(orientationOf(container)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
    // 返事の後も、新しいフォームに未保存の印は立っていない（切り替えで確認が出ない）。
    container.querySelector<HTMLButtonElement>('.reset-form')?.click()
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('安全弁: 押したときに取得できなければ書き換えず、取得できないことを出す', async () => {
    const container = await mountRegistering()
    const before = orientationOf(container)
    restWindows = { ok: false, body: { sensors: [] } }

    expect(await pressTilt(container)).toContain('静止した窓を取得できない')
    expect(orientationOf(container)).toEqual(before)
  })

  // **重力は方角について何も語らない**（REQUIREMENTS.md §16）。空欄なら触らない。
  it('方角が空欄のままなら、水平面は回さない', async () => {
    const container = await mountRegistering()

    expect(await pressTilt(container)).toContain('方角は変えていない')

    // 傾きは Y-Z 面の中だけなので、東の行は動かないはず。
    expect(orientationOf(container)[0]).toEqual([1, 0, 0])
  })

  it('方角を入れると、その分だけ水平面も回る', async () => {
    const container = await mountRegistering()
    headingInput(container).value = '0'

    expect(await pressTilt(container)).toContain('方角 0°')

    expect(orientationOf(container)[0]).not.toEqual([1, 0, 0])
    // 方角をどう回しても鉛直は保たれる（上向き軸まわりの回転だから）。
    expect(applyTo(orientationOf(container), TILTED_15DEG)[2]).toBeCloseTo(980.665, 2)
  })

  it('方角が数値として読めないときは書き換えず、理由を出す', async () => {
    const container = await mountRegistering()
    const heading = headingInput(container)
    // `type=number` の欄は不正な文字を空文字として返すので、属性ごと外して模す。
    heading.removeAttribute('type')
    heading.value = 'きた'

    expect(await pressTilt(container)).toContain('方角が数値として読めない')

    expect(orientationOf(container)[0]).toEqual([1, 0, 0])
  })

  // **基板の向きは基板ごとに入れ替える。** 残すと前に見ていた基板の向きで保存する。
  it('別の基板へ切り替えると、基板の向きと方角の欄もその基板のものになる', async () => {
    const container = await mountRegistering()
    // 北（0°）へ向ける。X 軸はもともと東を向いているので、東の行が変わる。
    headingInput(container).value = '0'
    await pressTilt(container)
    expect(orientationOf(container)[0]).not.toEqual([1, 0, 0])

    confirmMock.mockResolvedValue(true)
    container.querySelectorAll<HTMLButtonElement>('.edit-board')[0]?.click()
    await settleConfirm()

    expect(orientationOf(container)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
    // **覆した: 以前は空欄へ戻した。** いまはその基板の方角（単位行列なので X 軸は東＝90）を入れる（#713）。
    expect(headingInput(container).value).toBe('90')
    expect(container.querySelector('.board-orientation .b-tilt-result')?.textContent).toBe('')
  })

  // **引き直さないと、前に入っていた ID の判定が別のセンサーのカードに残る。**
  it('センサー ID を打ち換えると、その診断とボタンも引き直す', async () => {
    const container = await mountRegistering()
    const card = cardAt(container, 0)
    const sensorId = card.querySelector<HTMLInputElement>('.s-sensorId')
    if (sensorId === null) throw new Error('センサー ID の入力欄が無い')

    sensorId.value = 'accel-1'
    sensorId.dispatchEvent(new Event('input', { bubbles: true }))

    expect(card.querySelector('.s-rest-note')?.textContent).toContain('揺れている間は合わせられない')
    expect(tiltButton(container).disabled).toBe(true)
  })

  // **1 枚の失敗が残り全部を巻き込まないこと。** 描き直しは 5 箇所から呼ばれるので、
  // 先頭のカードで投げると以降の診断が古いまま固まる（サイレント障害レビューで検出）。
  it('1 枚のカードの構造が壊れても、残りのカードは更新され、壊れたことが画面に出る', async () => {
    const container = await mountRegistering()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 1 枚目の診断の出し先を外す（テンプレートとセレクタがずれた状態を模す）。
    cardAt(container, 0).querySelector('.s-rest-note')?.remove()

    // 2 枚目を静止しているセンサーへ打ち換え、描き直しを起こす。
    const sensorId = cardAt(container, 1).querySelector<HTMLInputElement>('.s-sensorId')
    if (sensorId === null) throw new Error('センサー ID の入力欄が無い')
    sensorId.value = 'accel-0'
    sensorId.dispatchEvent(new Event('input', { bubbles: true }))

    expect(cardAt(container, 1).querySelector('.s-rest-note')?.textContent).toContain(
      '取り付けの傾き 15°',
    )
    expect(container.querySelector('.boards-error')?.textContent).toContain('1 枚')
    expect(warn).toHaveBeenCalled()
  })

  it('静止窓の無いセンサーでは、待てば出ることが分かる文言になる', async () => {
    const container = document.createElement('div')
    mounted = new AbortController()
    await initBoardsView(container, memoryTabContext(mounted.signal, 'boards'))
    // BOARD_A（登録済み・センサー未登録）を編集し、空のカードを 1 枚足す。
    container.querySelectorAll<HTMLButtonElement>('.edit-board')[0].click()
    container.querySelector<HTMLButtonElement>('.add-sensor')?.click()

    const card = cardAt(container, 0)
    expect(card.querySelector('.s-rest-note')?.textContent).toContain('まだ無い')
    expect(tiltButton(container).disabled).toBe(true)
  })
})

/**
 * 校正前の値で測った、基板の 6 面と斜め 3 回（9 姿勢）の静止窓。**真の軸は基板の X・Y・Z をそのまま
 * 測り、倍率だけが `1 / sens`**（ゼロ点 `offset`）。姿勢ごとに 1 窓、窓の間は 30 秒空ける（置き換え）。
 */
function sixFaceWindows(
  offset: readonly number[],
  sens: readonly number[],
): { meanGal: number[]; sampleCount: number; fromMs: number; atMs: number }[] {
  const g = 980.665
  const dirs = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [Math.SQRT1_2, Math.SQRT1_2, 0],
    [0, Math.SQRT1_2, Math.SQRT1_2],
    [Math.SQRT1_2, 0, -Math.SQRT1_2],
  ]
  return dirs.map((d, k) => ({
    meanGal: d.map((v, i) => (v * g) / sens[i]! + offset[i]!),
    sampleCount: 3000,
    fromMs: k * 60_000,
    atMs: k * 60_000 + 30_000,
  }))
}

/**
 * 基板の「6 面で測る」欄の配線（`GET /api/rest-windows` → 揃い具合・押せる押せない → 押して各カードへ）。
 *
 * **計算と文言は `boardSixFace.test.ts`・`sixFacePanel.test.ts` が見る。** ここは画面の配線だけ ——
 * 欄どうしが画面上部のエラー表示を取り合った不具合はレビューでしか見つからなかった。
 */
describe('6 面で測る（基板の欄）', () => {
  /** 開いた画面。**後片付けで閉じる**（10 秒ごとの取り直しを次のテストへ持ち越さない）。 */
  let mounted: AbortController | null = null

  afterEach(() => {
    mounted?.abort()
    mounted = null
    clearStoredToken()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function mountWith(restWindows: { ok: boolean; body: unknown }): Promise<HTMLElement> {
    setStoredToken('test-token')
    stubApiFetch({ restWindows })
    const container = document.createElement('div')
    mounted = new AbortController()
    await initBoardsView(container, memoryTabContext(mounted.signal, 'boards'))
    container.querySelector<HTMLButtonElement>('.register-board')?.click()
    return container
  }

  function cardAt(container: HTMLElement, index: number): HTMLElement {
    const card = container.querySelectorAll<HTMLElement>('.sensor-card')[index]
    if (card === undefined) throw new Error(`${index} 番目のセンサーカードが無い`)
    return card
  }

  function panelOf(container: HTMLElement): HTMLElement {
    const panel = container.querySelector<HTMLElement>('.board-orientation .b-sixface')
    if (panel === null) throw new Error('基板の 6 面法の欄が無い')
    return panel
  }

  const sensorWindows = (sensorId: string, offset: readonly number[], sens: readonly number[]) => ({
    boardKey: 'mac:cccccccccccc',
    sensorId,
    stillSinceMs: null,
    windows: sixFaceWindows(offset, sens),
  })

  /** 同じ基板の 3 軸のセンサー 2 個（accel-0・accel-1）が、同じ 9 姿勢で静止した窓。 */
  const NINE = {
    ok: true,
    body: {
      sensors: [sensorWindows('accel-0', [-80, 5, -315], [1.02, 0.98, 1.01]), sensorWindows('accel-1', [12, -30, 40], [0.99, 1.01, 1])],
    },
  }

  it('正: 揃えばボタンが押せ、押すと全部のカードの軸の欄へ入る', async () => {
    const container = await mountWith(NINE)
    const panel = panelOf(container)
    expect(panel.querySelector('.b-sixface-faces')?.textContent).toBe('① 同時に静止　✓② 6 面　＋X ✓　−X ✓　＋Y ✓　−Y ✓　＋Z ✓　−Z ✓③ 向き　9／9④ 斜めの散らばり　✓')
    const button = panel.querySelector<HTMLButtonElement>('.apply-sixface')
    expect(button?.disabled).toBe(false)

    button?.click()

    const offset = (card: number, axis: number) =>
      cardAt(container, card).querySelector<HTMLInputElement>(`.s-axis-offset[data-axis="${axis}"]`)?.value
    const vector = (card: number, axis: number) =>
      [0, 1, 2].map(
        (comp) => cardAt(container, card).querySelector<HTMLInputElement>(`.s-axis-vector[data-axis="${axis}"][data-comp="${comp}"]`)?.value,
      )
    expect(offset(0, 2)).toBe('-315.00')
    // 感度 1.02 の軸は、1 gal の揺れで 1/1.02 gal 読む。
    expect(vector(0, 0)).toEqual(['0.980392', '0.000000', '0.000000'])
    expect(offset(1, 1)).toBe('-30.00')
    expect(vector(1, 0)).toEqual(['1.010101', '0.000000', '0.000000'])
    expect(panel.querySelector('.b-sixface-result')?.textContent).toContain('全部のセンサーの軸の向き・倍率・ゼロ点を入れた（姿勢 9・残差')
  })

  // 秒読み（2026-10-10 ユーザー承認）。最後の姿勢（9 番目）の窓は 480〜510 秒。
  describe('いまの置き方の行', () => {
    const withClock = (stillSinceMs: number | null) => ({
      ok: true,
      body: {
        nowMs: 520_000,
        windowMs: 30_000,
        sensors: NINE.body.sensors.map((s) => ({ ...s, stillSinceMs, pending: { fromMs: 513_000, sampleCount: 700, still: true, voided: false } })),
      },
    })
    const placementOf = (container: HTMLElement) => panelOf(container).querySelector('.b-sixface-placement')?.textContent

    it('正: いま静止していて窓がまだ閉じていなければ、閉じるまでの秒を出す', async () => {
      const container = await mountWith(withClock(null))
      expect(placementOf(container)).toBe('いまの置き方: このまま動かさなければ、あと 23 秒で 1 姿勢として数える')
    })

    it('正: いまの置き方がもう数えられていれば、新しい向きとして数えたと出す', async () => {
      const container = await mountWith(withClock(480_000))
      expect(placementOf(container)).toBe('いまの置き方: 数えた。次の向きへ置き換えてよい')
    })

    it('安全弁: 前の版のホスト（時刻の欄が無い）なら行を出さない', async () => {
      const container = await mountWith(NINE)
      expect(placementOf(container)).toBe('')
    })
  })

  it('対照: ほかのセンサーと同時に静止した窓が無いセンサーがあれば押せず、その名前が理由に出る', async () => {
    const container = await mountWith({ ok: true, body: { sensors: [NINE.body.sensors[0]] } })
    const panel = panelOf(container)
    expect(panel.querySelector<HTMLButtonElement>('.apply-sixface')?.disabled).toBe(true)
    expect(panel.querySelector('.b-sixface-why')?.textContent).toBe('センサー accel-1 が、ほかのセンサーと同時に静止した置き方が無い')
  })

  it('安全弁: 取得に失敗したら押せず、取得できないことが理由に出る', async () => {
    const container = await mountWith({ ok: false, body: { error: 'boom' } })
    const panel = panelOf(container)
    expect(panel.querySelector<HTMLButtonElement>('.apply-sixface')?.disabled).toBe(true)
    expect(panel.querySelector('.b-sixface-why')?.textContent).toContain('静止した窓を取得できない')
  })

  // 2026-10-10 に覆した: 6 面法の欄はセンサーカードから基板の欄へ移した（全部の軸を一緒に解く）。
  it('対照: センサーカードには 6 面法の欄を出さない', async () => {
    const container = await mountWith(NINE)
    expect(cardAt(container, 0).querySelector('.s-sixface')).toBeNull()
    expect(container.querySelectorAll('.b-sixface')).toHaveLength(1)
  })

  it('押した後の結果は、描き直し（打ち換え・取り直し）で消えない', async () => {
    const container = await mountWith(NINE)
    const panel = panelOf(container)
    panel.querySelector<HTMLButtonElement>('.apply-sixface')?.click()
    const before = panel.querySelector('.b-sixface-result')?.textContent

    // 2 枚目の ID 打ち換えで、全部の欄が描き直される。
    const other = cardAt(container, 1).querySelector<HTMLInputElement>('.s-sensorId')
    if (other === null) throw new Error('センサー ID の入力欄が無い')
    other.value = 'accel-9'
    other.dispatchEvent(new Event('input', { bubbles: true }))

    expect(panel.querySelector('.b-sixface-result')?.textContent).toBe(before)
  })

  it('2 つの欄が同時に壊れても、知らせは 1 行にまとまる', async () => {
    const container = await mountWith(NINE)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // カードの診断の欄と、基板の 6 面法の欄の出し先を外す（テンプレートとセレクタがずれた状態を模す）。
    cardAt(container, 0).querySelector('.s-rest-note')?.remove()
    panelOf(container).querySelector('.b-sixface-faces')?.remove()

    const other = cardAt(container, 1).querySelector<HTMLInputElement>('.s-sensorId')
    if (other === null) throw new Error('センサー ID の入力欄が無い')
    other.dispatchEvent(new Event('input', { bubbles: true }))

    expect(container.querySelector('.boards-error')?.textContent).toBe(
      '1 枚のセンサーカードと基板の向きの欄で取り付けの診断を出せない。画面を再読込すること',
    )
  })
})

/**
 * 方角の欄（#713）。**以前は保存すると空に戻り、方角だけ入れて保存しても黙って捨てていた。**
 * いまの方角を欄に入れておき、手で変えたときだけ保存で当てる（2026-10-10 ユーザー承認）。
 */
describe('方角の欄（いまの方角を出し、保存でも効かせる）', () => {
  /** 東・北・上の座標で、X 軸を北（方角 0）へ向けた基板の向き。 */
  const NORTH: BoardEntry['orientation'] = [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ]
  let puts: unknown[] = []

  beforeEach(() => {
    puts = []
    setStoredToken('t')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: unknown, init?: RequestInit) => {
        if (typeof path === 'string' && path.startsWith('/api/boards/') && init?.method === 'PUT') {
          puts.push(JSON.parse(String(init.body)))
          return { ok: true, status: 200, json: async () => ({}) }
        }
        if (path === '/api/boards') {
          return { ok: true, status: 200, json: async () => ({ boards: [{ ...BOARD_A, orientation: NORTH }] }) }
        }
        if (path === '/api/stations') return { ok: true, status: 200, json: async () => ({ stations: [STATION] }) }
        if (path === '/status') {
          return { ok: true, status: 200, json: async () => ({ generatedAtMs: 10_000, sensors: [], gravity: { verdicts: [] } }) }
        }
        if (path === '/api/rest-windows') return { ok: true, status: 200, json: async () => ({ sensors: [] }) }
        throw new Error(`unexpected fetch path: ${String(path)}`)
      }),
    )
  })
  afterEach(() => {
    clearStoredToken()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function openBoardA(): Promise<HTMLElement> {
    const container = document.createElement('div')
    await initBoardsView(container, memoryTabContext(new AbortController().signal, 'boards'))
    container.querySelector<HTMLButtonElement>('.edit-board')?.click()
    return container
  }
  const headingInput = (c: HTMLElement): HTMLInputElement => c.querySelector<HTMLInputElement>('.b-heading')!
  const submit = async (c: HTMLElement): Promise<void> => {
    c.querySelector<HTMLFormElement>('.board-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(puts).toHaveLength(1))
  }
  const sentOrientation = (): number[][] => (puts[0] as { orientation: number[][] }).orientation

  it('正: 保存済みの基板を開くと、いまの方角が欄に入っている', async () => {
    const container = await openBoardA()
    expect(headingInput(container).value).toBe('0')
  })

  it('正: 方角だけ変えて保存すると、その方角へ向けた向きを送る', async () => {
    const container = await openBoardA()
    headingInput(container).value = '90'
    await submit(container)
    // X 軸（第 1 列）が東を向く。
    const m = sentOrientation()
    expect(m[0]![0]).toBeCloseTo(1, 5)
    expect(m[1]![0]).toBeCloseTo(0, 5)
  })

  it('正: 表示名を入れて保存すると、名前も送る（空でも送る。PUT は全置換なので消せるように）', async () => {
    const container = await openBoardA()
    expect(container.querySelector<HTMLInputElement>('[name=displayName]')?.value).toBe('')
    container.querySelector<HTMLInputElement>('[name=displayName]')!.value = '北の壁'
    await submit(container)
    expect((puts[0] as { displayName: string }).displayName).toBe('北の壁')
  })

  it('対照: 方角を変えずに保存すると、向きはそのまま送る', async () => {
    const container = await openBoardA()
    await submit(container)
    expect(sentOrientation()).toEqual(NORTH)
  })

  it('安全弁: 3x3 を手で直したら方角の欄が追随し、保存で元の方角へ回し戻さない', async () => {
    const container = await openBoardA()
    // X 軸を東へ向けた単位行列へ手で書き換える。
    const cells = container.querySelectorAll<HTMLInputElement>('.b-orientation')
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    cells.forEach((cell, i) => {
      cell.value = String(identity[i])
      cell.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(headingInput(container).value).toBe('90')
    await submit(container)
    expect(sentOrientation()).toEqual(IDENTITY_MATRIX)
  })
})

/** リロード・タブ移動で、開いていたフォーム（編集・登録）を開き直す（2026-10-10 ユーザー承認）。 */
describe('基板タブの選択を保つ', () => {
  beforeEach(() => {
    stubApiFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const UNREGISTERED = 'mac:cccccccccccc'

  async function mount(selection: Record<string, string> = {}) {
    const ctx = memoryTabContext(new AbortController().signal, 'boards', { selection })
    const container = document.createElement('div')
    await initBoardsView(container, ctx)
    return { ctx, container }
  }

  const keyInput = (c: HTMLElement): HTMLInputElement => {
    const el = c.querySelector<HTMLInputElement>('[name=boardKey]')
    if (el === null) throw new Error('基板 Key の欄が無い')
    return el
  }

  it('編集を押すと編集中の基板が、登録を押すと登録しかけの基板が選択に載る（どちらか一方）', async () => {
    const { ctx, container } = await mount()
    container.querySelectorAll<HTMLButtonElement>('.edit-board')[0].click()
    expect(ctx.selection.get('board')).toBe(BOARD_A.boardKey)
    expect(ctx.selection.get('register')).toBeNull()

    container.querySelector<HTMLButtonElement>('.register-board')?.click()
    expect(ctx.selection.get('register')).toBe(UNREGISTERED)
    expect(ctx.selection.get('board')).toBeNull()

    confirmMock.mockResolvedValue(true)
    container.querySelector<HTMLButtonElement>('.reset-form')?.click()
    await settleConfirm()
    expect(ctx.selection.get('register')).toBeNull()
  })

  it('覚えていた基板の編集を、ホストの値で開き直す（開き直しただけでは未保存にならない）', async () => {
    const { ctx, container } = await mount({ board: BOARD_A.boardKey })
    expect(keyInput(container).value).toBe(BOARD_A.boardKey)
    expect(keyInput(container).readOnly).toBe(true)
    expect(ctx.unsaved()).toBe(false)
  })

  // **新規の形と見分ける。** どちらも基板 Key を書き換えられるので、欄の形からは区別できない。
  it('覚えていた登録を、届いている基板のセンサーで開き直す', async () => {
    const { ctx, container } = await mount({ register: UNREGISTERED })
    expect(keyInput(container).value).toBe(UNREGISTERED)
    expect(keyInput(container).readOnly).toBe(false)
    expect(container.querySelectorAll('.sensor-card').length).toBeGreaterThan(0)
    expect(ctx.selection.get('register')).toBe(UNREGISTERED)
  })

  // **無い基板の Key で開いたまま保存させない。** `PUT` は upsert なので、消えた基板を作り直す。
  it('一覧に無い基板は新規の形に戻し、選択からも外す', async () => {
    const { ctx, container } = await mount({ board: 'mac:gone', register: 'mac:gone2' })
    expect(keyInput(container).value).toBe('')
    expect(keyInput(container).readOnly).toBe(false)
    expect(ctx.selection.get('board')).toBeNull()
    expect(ctx.selection.get('register')).toBeNull()
  })

  // **登録の形のまま保存させない。** `PUT` は全置換なので、登録済みの校正値と向きを既定値で上書きする。
  it('登録しかけていた基板が登録済みになっていたら、編集で開き直す', async () => {
    const { ctx, container } = await mount({ register: BOARD_A.boardKey })
    expect(keyInput(container).value).toBe(BOARD_A.boardKey)
    expect(keyInput(container).readOnly).toBe(true)
    expect(ctx.selection.get('board')).toBe(BOARD_A.boardKey)
    expect(ctx.selection.get('register')).toBeNull()
  })

  // **取れていない空を「一覧に無い」と取り違えない。** トークンの失効や通信の途切れだけで、
  // 何を開いていたかが失われる。
  it('一覧を取れなかったときは、覚えていた選択に触らない', async () => {
    stubApiFetch({ boardsFails: true })
    const { ctx } = await mount({ board: BOARD_A.boardKey })
    expect(ctx.selection.get('board')).toBe(BOARD_A.boardKey)
  })

  it('受信の様子（/status）だけ取れなかったときも、登録しかけの基板を選択に残す', async () => {
    stubApiFetch({ statusFails: true })
    const { ctx } = await mount({ register: UNREGISTERED })
    expect(ctx.selection.get('register')).toBe(UNREGISTERED)
  })

  it('センサーを足した途中は「保存していない」と答える', async () => {
    const { ctx, container } = await mount({ board: BOARD_A.boardKey })
    expect(ctx.unsaved()).toBe(false)
    container.querySelector<HTMLButtonElement>('.add-sensor')?.click()
    expect(ctx.unsaved()).toBe(true)
  })
})
