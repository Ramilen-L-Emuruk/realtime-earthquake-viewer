// 基板タブ（`/api/boards` の一覧・作成・更新・削除）。
//
// **`sensors[]`（校正値・姿勢）は JSON で直接編集する。** 行列・オフセット・感度・
// ノイズ密度をフィールドごとの入力欄に分けると、センサー数だけ動的にフォームを
// 増減する UI が要る。運用者（開発者自身）が直接扱う値なので、
// `GET /api/boards` が返す形をそのまま textarea に出し、コピペで直せるようにする
// ——`PUT` は全置換なので（README.md「`/api/stations`・`/api/boards`」）、
// 現在の値を含めて送り直す必要があり、この形はその手当てにもなる。

import { apiFetch, ApiError, describeAdminAuthFailure } from './api'
import { escapeHtml, qs } from './dom'
import type { BoardEntry, SensorEntry, StationInfo } from '../receiver/stationConfigTypes'

function renderError(container: HTMLElement, message: string): void {
  const el = qs(container, '.boards-error')
  el.textContent = message
  el.classList.toggle('error', message.length > 0)
}

function renderTable(
  container: HTMLElement,
  boards: readonly BoardEntry[],
  stations: readonly StationInfo[],
): void {
  const tbody = qs(container, '.boards-table tbody')
  if (boards.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">基板はまだ無い</td></tr>'
    return
  }
  const stationName = (id: string): string => stations.find((s) => s.stationId === id)?.displayName ?? id
  tbody.innerHTML = boards
    .map(
      (b) => `
        <tr data-board-key="${escapeHtml(b.boardKey)}">
          <td>${escapeHtml(b.boardKey)}</td>
          <td>${escapeHtml(stationName(b.stationId))}</td>
          <td>${b.sensors.length}</td>
          <td>
            <button type="button" class="edit-board">編集</button>
            <button type="button" class="delete-board danger">削除</button>
          </td>
        </tr>`,
    )
    .join('')
}

function fillStationOptions(container: HTMLElement, stations: readonly StationInfo[]): void {
  const select = qs<HTMLSelectElement>(container, '[name=stationId]')
  select.innerHTML = stations
    .map((s) => `<option value="${escapeHtml(s.stationId)}">${escapeHtml(s.displayName)}</option>`)
    .join('')
}

function fillForm(container: HTMLElement, board: BoardEntry | null): void {
  const keyInput = qs<HTMLInputElement>(container, '[name=boardKey]')
  const select = qs<HTMLSelectElement>(container, '[name=stationId]')
  const sensorsArea = qs<HTMLTextAreaElement>(container, '[name=sensors]')
  keyInput.value = board?.boardKey ?? ''
  // **既存の基板を編集するときは boardKey を固定する。** 観測点と同じ理由
  // （URL パスの値が正）。
  keyInput.readOnly = board !== null
  if (board !== null) select.value = board.stationId
  sensorsArea.value = board !== null ? JSON.stringify(board.sensors, null, 2) : '[]'
}

function parseSensors(text: string): readonly SensorEntry[] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('sensors は配列で書くこと')
  return parsed as SensorEntry[]
}

export async function initBoardsView(container: HTMLElement, signal: AbortSignal): Promise<void> {
  container.innerHTML = `
    <div class="boards-error"></div>
    <table class="boards-table">
      <thead><tr><th>基板 Key</th><th>観測点</th><th>センサー数</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
    <h3>基板を作成・更新する</h3>
    <p class="muted">
      「編集」を押すと現在の <code>sensors</code>（校正値）が読み込まれる。全置換なので、
      校正値を変えないつもりでも編集前の内容を残したまま保存すること。
    </p>
    <form class="board-form">
      <label>基板 Key（例: <code>mac:aabbccddeeff</code>）<input name="boardKey" required /></label>
      <label>観測点<select name="stationId" required></select></label>
      <label>sensors（JSON 配列）<textarea name="sensors" rows="10" spellcheck="false"></textarea></label>
      <div class="row">
        <button type="submit">保存</button>
        <button type="button" class="reset-form">フォームをクリア</button>
      </div>
    </form>
  `

  let currentBoards: readonly BoardEntry[] = []
  let currentStations: readonly StationInfo[] = []

  // **`signal.aborted` を確認してから DOM を書く。** 理由は `viewStations.ts` と同じ。
  //
  // **戻り値は「再取得に成功したか、失敗ならその理由」。** `renderError` を
  // ここでは呼ばない——理由は `viewStations.ts` と同じ（呼び出し元が理由を
  // 組み込んだ文言を1回だけ表示する）。
  const reload = async (): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
    try {
      // **どちらも `{ 単数形s: [...] }` の形で返る**（`GET /api/stations` と同じ理由）。
      const [boardsBody, stationsBody] = await Promise.all([
        apiFetch<{ readonly boards: readonly BoardEntry[] }>('/api/boards'),
        apiFetch<{ readonly stations: readonly StationInfo[] }>('/api/stations'),
      ])
      if (signal.aborted) return { ok: true }
      currentBoards = boardsBody.boards
      currentStations = stationsBody.stations
      fillStationOptions(container, currentStations)
      renderTable(container, currentBoards, currentStations)
      return { ok: true }
    } catch (error) {
      if (signal.aborted) return { ok: true }
      return { ok: false, reason: describeFetchFailure(error) }
    }
  }

  const form = qs<HTMLFormElement>(container, '.board-form')
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void (async () => {
      const boardKey = qs<HTMLInputElement>(container, '[name=boardKey]').value.trim()
      const stationId = qs<HTMLSelectElement>(container, '[name=stationId]').value
      const sensorsText = qs<HTMLTextAreaElement>(container, '[name=sensors]').value
      if (boardKey.length === 0) {
        renderError(container, '基板 Key を入力すること')
        return
      }
      if (currentStations.length === 0) {
        renderError(container, '先に観測点を 1 件以上作成すること')
        return
      }
      let sensors: readonly SensorEntry[]
      try {
        sensors = parseSensors(sensorsText)
      } catch (error) {
        renderError(container, `sensors が JSON として読めない: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      try {
        await apiFetch(`/api/boards/${encodeURIComponent(boardKey)}`, {
          method: 'PUT',
          body: JSON.stringify({ stationId, sensors }),
        })
        if (signal.aborted) return
        fillForm(container, null)
        const reloaded = await reload()
        if (reloaded.ok) renderError(container, '')
        else renderError(container, `保存は完了したが、一覧の再取得に失敗した（${reloaded.reason}）。再読込すること`)
      } catch (error) {
        if (signal.aborted) return
        renderError(container, describeSaveFailure(error))
      }
    })()
  })

  qs(container, '.reset-form').addEventListener('click', () => fillForm(container, null))

  qs(container, '.boards-table tbody').addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const row = target.closest<HTMLElement>('tr[data-board-key]')
    if (row === null) return
    const boardKey = row.dataset.boardKey ?? ''
    const board = currentBoards.find((b) => b.boardKey === boardKey) ?? null

    if (target.classList.contains('edit-board') && board !== null) {
      fillForm(container, board)
      return
    }
    if (target.classList.contains('delete-board')) {
      void (async () => {
        if (!window.confirm(`基板「${boardKey}」の割当・校正値を削除する？（観測点自体は消えない）`)) return
        try {
          await apiFetch(`/api/boards/${encodeURIComponent(boardKey)}`, { method: 'DELETE' })
          if (signal.aborted) return
          const reloaded = await reload()
          if (reloaded.ok) renderError(container, '')
          else renderError(container, `削除は完了したが、一覧の再取得に失敗した（${reloaded.reason}）。再読込すること`)
        } catch (error) {
          if (signal.aborted) return
          renderError(container, describeSaveFailure(error))
        }
      })()
    }
  })

  const initial = await reload()
  if (!initial.ok) renderError(container, initial.reason)
}

/** `GET /api/boards`・`GET /api/stations` の失敗理由を日本語化する（`describeSaveFailure` の GET 専用版）。 */
function describeFetchFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const authReason = describeAdminAuthFailure(error.message)
    if (authReason !== null) return authReason
  }
  return error instanceof Error ? error.message : String(error)
}

function describeSaveFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    return `入力が不正: ${error.message}`
  }
  return describeFetchFailure(error)
}
