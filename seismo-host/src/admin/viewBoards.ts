// 基板タブ（`/api/boards` の一覧・作成・更新・削除）。
//
// **`sensors[]`（校正値・姿勢）はセンサーごとのカードで編集する。** 常時表示は
// `offset`・`sensitivity`・`enabled`。`rotation`（取り付け向きの補正）と
// `noiseDensity` は初期状態でまっすぐ・未設定であることが多いため詳細設定
// として折りたたむ。フォーム⇔`SensorEntry` の変換は `sensorForm.ts` に
// 切り出してある（DOM に依存しない部分だけをユニットテストするため）。
// **`PUT` は全置換**（README.md「`/api/stations`・`/api/boards`」）なので、
// 保存時は表示中の全カードを読み直して丸ごと送る。

import { apiFetch, ApiError, describeAdminAuthFailure } from './api'
import { escapeHtml, qs } from './dom'
import {
  emptySensorFormValues,
  parseSensorFormValues,
  readSensorCardValues,
  renderSensorCardHtml,
  sensorToFormValues,
} from './sensorForm'
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
    tbody.innerHTML = '<tr><td colspan="4" class="muted">未登録</td></tr>'
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

function renderSensorCards(container: HTMLElement, sensors: readonly SensorEntry[]): void {
  const list = qs(container, '.sensor-cards')
  list.innerHTML = sensors.map((s) => renderSensorCardHtml(sensorToFormValues(s))).join('')
}

function addEmptySensorCard(container: HTMLElement): void {
  const list = qs(container, '.sensor-cards')
  list.insertAdjacentHTML('beforeend', renderSensorCardHtml(emptySensorFormValues()))
}

function fillForm(container: HTMLElement, board: BoardEntry | null): void {
  const keyInput = qs<HTMLInputElement>(container, '[name=boardKey]')
  const select = qs<HTMLSelectElement>(container, '[name=stationId]')
  keyInput.value = board?.boardKey ?? ''
  // **既存の基板を編集するときは boardKey を固定する。** 観測点と同じ理由
  // （URL パスの値が正）。
  keyInput.readOnly = board !== null
  // **「変更不可」はそれが本当のときだけ出す。** 新規登録では入力必須なので、
  // 固定の文言にすると初めて登録する運用者へ嘘をつくことになる。
  qs(container, '.boardKey-label').textContent = board !== null ? '基板 Key（変更不可）' : '基板 Key'
  if (board !== null) select.value = board.stationId
  renderSensorCards(container, board?.sensors ?? [])
}

/**
 * 表示中の全センサーカードを読み取り検証する。**1 件でもエラーなら丸ごと
 * 中止**——一部だけ保存すると、どのセンサーが実際に保存されたか運用者が
 * 見た目から追えなくなる。
 */
export function readAllSensors(container: HTMLElement): readonly SensorEntry[] | { readonly error: string } {
  const cards = Array.from(container.querySelectorAll<HTMLElement>('.sensor-cards .sensor-card'))
  const sensors: SensorEntry[] = []
  for (let i = 0; i < cards.length; i++) {
    const result = parseSensorFormValues(readSensorCardValues(cards[i]))
    if (!result.ok) return { error: `${i + 1} 番目のセンサー: ${result.error}` }
    sensors.push(result.sensor)
  }
  return sensors
}

export async function initBoardsView(container: HTMLElement, signal: AbortSignal): Promise<void> {
  container.innerHTML = `
    <div class="boards-error"></div>
    <section class="panel">
      <h2>登録済みの基板</h2>
      <table class="boards-table">
        <thead><tr><th>基板 Key</th><th>観測点</th><th>センサー数</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </section>
    <section class="panel">
      <h2>基板を登録・編集する</h2>
      <form class="board-form">
        <!-- **ラベルの初期値はここに置く。** 初回マウントでは fillForm を通らない
             （reload しか呼ばない）ので、空にすると新規登録の画面でラベルごと消える。 -->
        <label><span class="boardKey-label">基板 Key</span><input name="boardKey" placeholder="mac:aabbccddeeff" required /></label>
        <label>観測点<select name="stationId" required></select></label>
        <h3>センサー</h3>
        <div class="sensor-cards"></div>
        <div class="row">
          <button type="button" class="add-sensor" style="flex: 0 0 auto">センサーを追加</button>
        </div>
        <div class="row">
          <button type="submit">保存</button>
          <button type="button" class="reset-form">新規登録へ</button>
        </div>
      </form>
    </section>
  `

  let currentBoards: readonly BoardEntry[] = []
  let currentStations: readonly StationInfo[] = []

  // **編集中の未保存内容を、確認なしで破棄しない。** センサーカードの追加・削除・
  // 数値変更中に別の基板の「編集」を押すと、`fillForm` が `.sensor-cards` を
  // 丸ごと差し替えるため、それまでの入力が黙って消える——削除ボタン
  // （`delete-board`）には `window.confirm` があるのに、こちらには無かった
  // （敵対的レビューで検出）。
  let formDirty = false

  const confirmDiscardIfDirty = (): boolean => {
    if (!formDirty) return true
    return window.confirm('編集中の内容を破棄する？')
  }

  const switchForm = (board: BoardEntry | null): void => {
    fillForm(container, board)
    formDirty = false
  }

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

  qs(container, '.add-sensor').addEventListener('click', () => {
    addEmptySensorCard(container)
    formDirty = true
  })

  const form = qs<HTMLFormElement>(container, '.board-form')
  form.addEventListener('input', () => {
    formDirty = true
  })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void (async () => {
      const boardKey = qs<HTMLInputElement>(container, '[name=boardKey]').value.trim()
      const stationId = qs<HTMLSelectElement>(container, '[name=stationId]').value
      if (boardKey.length === 0) {
        renderError(container, '基板 Key を入力すること')
        return
      }
      if (currentStations.length === 0) {
        renderError(container, '先に観測点を登録すること')
        return
      }
      try {
        // **`readAllSensors` もこの try に含める。** 内部で呼ぶ `qs()`
        // （DOM 構造が `renderSensorCardHtml` の生成物とずれていれば投げる）
        // が外側の catch を通らず、awaited されない非同期関数の中の
        // unhandled rejection として消えていた——保存ボタンを押しても
        // 何も起きず、devtools のコンソールにしか痕跡が残らなかった
        // （#313 段 C-5・2巡目レビューで検出）。
        const sensors = readAllSensors(container)
        if ('error' in sensors) {
          renderError(container, sensors.error)
          return
        }
        await apiFetch(`/api/boards/${encodeURIComponent(boardKey)}`, {
          method: 'PUT',
          body: JSON.stringify({ stationId, sensors }),
        })
        if (signal.aborted) return
        switchForm(null)
        const reloaded = await reload()
        if (reloaded.ok) renderError(container, '')
        else renderError(container, `保存済み。一覧の再取得に失敗（${reloaded.reason}）。再読込すること`)
      } catch (error) {
        if (signal.aborted) return
        renderError(container, describeSaveFailure(error))
      }
    })()
  })

  qs(container, '.reset-form').addEventListener('click', () => {
    if (!confirmDiscardIfDirty()) return
    switchForm(null)
  })

  qs(container, '.sensor-cards').addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains('remove-sensor')) return
    target.closest('.sensor-card')?.remove()
    formDirty = true
  })

  qs(container, '.boards-table tbody').addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const row = target.closest<HTMLElement>('tr[data-board-key]')
    if (row === null) return
    const boardKey = row.dataset.boardKey ?? ''
    const board = currentBoards.find((b) => b.boardKey === boardKey) ?? null

    if (target.classList.contains('edit-board') && board !== null) {
      if (!confirmDiscardIfDirty()) return
      switchForm(board)
      return
    }
    if (target.classList.contains('delete-board')) {
      void (async () => {
        // **「観測点は残る」を省かない。** 1 基板 1 観測点の構成では、基板の削除が
        // 観測点ごと消すように読める（実際は割当と校正値だけ消える）。
        if (!window.confirm(`基板「${boardKey}」の割当・校正値を削除する？（観測点は残る）`)) return
        try {
          await apiFetch(`/api/boards/${encodeURIComponent(boardKey)}`, { method: 'DELETE' })
          if (signal.aborted) return
          const reloaded = await reload()
          if (reloaded.ok) renderError(container, '')
          else renderError(container, `削除済み。一覧の再取得に失敗（${reloaded.reason}）。再読込すること`)
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
