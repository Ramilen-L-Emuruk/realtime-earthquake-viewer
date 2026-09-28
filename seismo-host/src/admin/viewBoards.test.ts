// @vitest-environment jsdom
//
// **`readAllSensors` の統合フロー（複数センサーカードを跨いだ集約・1件でも
// 不正なら丸ごと中止する分岐）をテストする。** `sensorForm.test.ts` は
// センサー1個ぶんの変換だけを見ており、複数カードにまたがる集約ロジック
// （このファイルの `readAllSensors`）は未検証だった（#313 段 C-5 敵対的
// レビューで指摘）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySensorFormValues, renderSensorCardHtml } from './sensorForm'
import { initBoardsView, readAllSensors } from './viewBoards'
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

const STATION: StationInfo = { stationId: 'st1', displayName: '観測点1', lat: 0, lon: 0 }
const BOARD_A: BoardEntry = { boardKey: 'mac:aaaaaaaaaaaa', stationId: 'st1', sensors: [] }
const BOARD_B: BoardEntry = { boardKey: 'mac:bbbbbbbbbbbb', stationId: 'st1', sensors: [] }

/** `apiFetch` が叩く `/api/boards`・`/api/stations` の応答を固定値で返す最小限のモック。 */
function stubApiFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: unknown) => {
      if (path === '/api/boards') {
        return { ok: true, status: 200, json: async () => ({ boards: [BOARD_A, BOARD_B] }) }
      }
      if (path === '/api/stations') {
        return { ok: true, status: 200, json: async () => ({ stations: [STATION] }) }
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
