// @vitest-environment jsdom
//
// **`readAllSensors` の統合フロー（複数センサーカードを跨いだ集約・1件でも
// 不正なら丸ごと中止する分岐）をテストする。** `sensorForm.test.ts` は
// センサー1個ぶんの変換だけを見ており、複数カードにまたがる集約ロジック
// （このファイルの `readAllSensors`）は未検証だった（#313 段 C-5 敵対的
// レビューで指摘）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySensorFormValues, renderSensorCardHtml } from './sensorForm'
import { initBoardsView, mergeBoardRows, readAllSensors } from './viewBoards'
import type { DetectedBoard } from './detectedBoards'
import type { BoardEntry, StationInfo } from '../receiver/stationConfigTypes'

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
    lastPacketMs: 1000,
  })
  const board = (boardKey: BoardEntry['boardKey']): BoardEntry => ({
    boardKey,
    stationId: 'st1',
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

  it('並びは「届いている順 → 届いていない登録済み」', () => {
    const rows = mergeBoardRows(
      [detected('mac:z'), detected('mac:a')],
      [board('mac:a'), board('mac:m')],
    )
    expect(rows.map((r) => r.boardKey)).toEqual(['mac:z', 'mac:a', 'mac:m'])
  })

  it('どちらも空なら空', () => {
    expect(mergeBoardRows([], [])).toEqual([])
  })
})

const STATION: StationInfo = { stationId: 'st1', displayName: '観測点1', lat: 0, lon: 0 }
const BOARD_A: BoardEntry = { boardKey: 'mac:aaaaaaaaaaaa', stationId: 'st1', sensors: [] }
const BOARD_B: BoardEntry = { boardKey: 'mac:bbbbbbbbbbbb', stationId: 'st1', sensors: [] }

/**
 * `/status` が返すセンサー。**基板 A は登録済み・`mac:cccccccccccc` は未登録**
 * ——「認識しているが設定に無い基板」を作るための組み合わせ。
 */
const STATUS_SENSORS = [
  { boardKey: 'mac:cccccccccccc', sensorId: 'accel-0', lastPacketMs: 9_000 },
  { boardKey: 'mac:cccccccccccc', sensorId: 'accel-1', lastPacketMs: 9_000 },
  { boardKey: BOARD_A.boardKey, sensorId: 'accel-0', lastPacketMs: 9_000 },
]

/** `/api/boards`・`/api/stations`・`/status` の応答を固定値で返す最小限のモック。 */
function stubApiFetch(options: { readonly statusFails?: boolean } = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: unknown) => {
      if (path === '/api/boards') {
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
          json: async () => ({ generatedAtMs: 10_000, sensors: STATUS_SENSORS }),
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
    await initBoardsView(container, controller.signal)
    const editButtons = container.querySelectorAll<HTMLButtonElement>('.edit-board')
    editButtons[0].click()
    return container
  }

  it('センサーカードを追加した状態で別の基板の編集を押すと確認を求める', async () => {
    const container = await mountEditingBoardA()
    container.querySelector<HTMLButtonElement>('.add-sensor')?.click()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const editButtons = container.querySelectorAll<HTMLButtonElement>('.edit-board')
    editButtons[1].click()

    expect(confirmSpy).toHaveBeenCalledOnce()
  })

  it('確認をキャンセルすると、編集中の内容（追加したセンサーカード）が残る', async () => {
    const container = await mountEditingBoardA()
    container.querySelector<HTMLButtonElement>('.add-sensor')?.click()
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    const editButtons = container.querySelectorAll<HTMLButtonElement>('.edit-board')
    editButtons[1].click()

    expect(container.querySelectorAll('.sensor-card')).toHaveLength(1)
    expect(container.querySelector<HTMLInputElement>('[name=boardKey]')?.value).toBe(BOARD_A.boardKey)
  })

  it('確認を承認すると、別の基板へ切り替わる（未保存の内容は破棄される）', async () => {
    const container = await mountEditingBoardA()
    container.querySelector<HTMLButtonElement>('.add-sensor')?.click()
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const editButtons = container.querySelectorAll<HTMLButtonElement>('.edit-board')
    editButtons[1].click()

    expect(container.querySelector<HTMLInputElement>('[name=boardKey]')?.value).toBe(BOARD_B.boardKey)
    expect(container.querySelectorAll('.sensor-card')).toHaveLength(0)
  })

  // **「変更不可」を新規登録でも出すと嘘になる。** `boardKey` が読み取り専用になるのは
  // 既存の編集中だけで（`fillForm` の `keyInput.readOnly = board !== null`）、新規登録では
  // 入力必須。文言を静的テキストで固定していたため実挙動と食い違っていた（レビューで検出）。
  it('新規登録では「変更不可」と表示しない（入力必須なので嘘になる）', async () => {
    const container = document.createElement('div')
    await initBoardsView(container, new AbortController().signal)

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
    const confirmSpy = vi.spyOn(window, 'confirm')

    const editButtons = container.querySelectorAll<HTMLButtonElement>('.edit-board')
    editButtons[1].click()

    expect(confirmSpy).not.toHaveBeenCalled()
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
    await initBoardsView(container, new AbortController().signal)
    return container
  }

  // **表は 1 つ。** 声が届いている基板と設定にある基板を分けて並べると、大半が
  // 両方に該当するので同じ基板が二度出る（ユーザーの指摘で統合した）。
  it('声が届いている基板と登録済みの基板を 1 つの表へまとめ、重複させない', async () => {
    const container = await mount()
    const rows = container.querySelectorAll<HTMLElement>('.boards-table tbody tr')
    const keys = [...rows].map((r) => r.dataset.boardKey)

    // 認識 3 枚のうち 2 枚（A・未登録の C）＋ 声の届いていない登録済み B。
    expect(keys).toEqual(['mac:cccccccccccc', BOARD_A.boardKey, BOARD_B.boardKey])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('設定に無い基板にだけ「登録」ボタンを出し、登録済みには編集・削除を出す', async () => {
    const container = await mount()
    const rows = container.querySelectorAll<HTMLElement>('.boards-table tbody tr')

    expect(rows[0].querySelector('.register-board')).not.toBeNull()
    expect(rows[0].querySelector('.edit-board')).toBeNull()
    expect(rows[1].querySelector('.register-board')).toBeNull()
    expect(rows[1].querySelector('.edit-board')).not.toBeNull()
    expect(rows[1].textContent).toContain(STATION.displayName)
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

  // **入れただけでは保存されていない。** dirty を立てておかないと、この直後に
  // 別の基板の編集を押したとき確認なしで消える。
  it('「登録」で入れた内容は未保存として扱う（別の基板へ移るとき確認を求める）', async () => {
    const container = await mount()
    container.querySelector<HTMLButtonElement>('.register-board')?.click()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    container.querySelectorAll<HTMLButtonElement>('.edit-board')[0].click()

    expect(confirmSpy).toHaveBeenCalledOnce()
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
    expect(options).toEqual(['mac:cccccccccccc', BOARD_A.boardKey])
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

