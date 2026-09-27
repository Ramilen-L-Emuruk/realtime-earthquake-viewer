// 観測点タブ（`/api/stations` の一覧・作成・更新・削除）。

import { apiFetch, ApiError, describeAdminAuthFailure } from './api'
import { escapeHtml, formatNumber, qs } from './dom'
import type { StationInfo } from '../receiver/stationConfigTypes'

function renderError(container: HTMLElement, message: string): void {
  const el = qs(container, '.stations-error')
  el.textContent = message
  el.classList.toggle('error', message.length > 0)
}

function renderTable(container: HTMLElement, stations: readonly StationInfo[]): void {
  const tbody = qs(container, '.stations-table tbody')
  if (stations.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">観測点はまだ無い</td></tr>'
    return
  }
  tbody.innerHTML = stations
    .map(
      (s) => `
        <tr data-station-id="${escapeHtml(s.stationId)}">
          <td>${escapeHtml(s.stationId)}</td>
          <td>${escapeHtml(s.displayName)}</td>
          <td>${formatNumber(s.lat)}</td>
          <td>${formatNumber(s.lon)}</td>
          <td>
            <button type="button" class="edit-station">編集</button>
            <button type="button" class="delete-station danger">削除</button>
          </td>
        </tr>`,
    )
    .join('')
}

function fillForm(container: HTMLElement, station: StationInfo | null): void {
  const idInput = qs<HTMLInputElement>(container, '[name=stationId]')
  const nameInput = qs<HTMLInputElement>(container, '[name=displayName]')
  const latInput = qs<HTMLInputElement>(container, '[name=lat]')
  const lonInput = qs<HTMLInputElement>(container, '[name=lon]')
  idInput.value = station?.stationId ?? ''
  // **既存の観測点を編集するときは stationId を固定する。** URL パスの値が正なので
  // （README.md「`/api/stations`・`/api/boards`」）、ここを書き換えても別の
  // stationId として upsert されるだけで、元の行は残ったまま増える。
  idInput.readOnly = station !== null
  nameInput.value = station?.displayName ?? ''
  latInput.value = station !== null ? String(station.lat) : ''
  lonInput.value = station !== null ? String(station.lon) : ''
}

export async function initStationsView(container: HTMLElement, signal: AbortSignal): Promise<void> {
  container.innerHTML = `
    <div class="stations-error"></div>
    <table class="stations-table">
      <thead><tr><th>ID</th><th>表示名</th><th>緯度</th><th>経度</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
    <h3>観測点を作成・更新する</h3>
    <form class="station-form">
      <label>観測点 ID<input name="stationId" required /></label>
      <label>表示名<input name="displayName" required /></label>
      <div class="row">
        <label>緯度<input name="lat" type="number" step="any" required /></label>
        <label>経度<input name="lon" type="number" step="any" required /></label>
      </div>
      <div class="row">
        <button type="submit">保存</button>
        <button type="button" class="reset-form">フォームをクリア</button>
      </div>
    </form>
  `

  let current: readonly StationInfo[] = []

  // **`signal.aborted` を確認してから DOM を書く。** タブが切り替わった後に
  // 届いた応答が、差し替わった別タブの DOM を探しに行く事故を防ぐ
  // （`app.ts` の `mountTab` 参照）。
  //
  // **戻り値は「再取得に成功したか、失敗ならその理由」。** `renderError` を
  // ここでは呼ばない——呼び出し元（保存・削除ハンドラ／初回マウント）が
  // 理由を組み込んだ文言を1回だけ表示する。以前は成功/失敗の真偽値だけを
  // 返し、失敗時にここで具体的な理由を表示した直後、呼び出し元が「操作自体は
  // 完了した」という別の文言で即座に上書きしていたため、実際の失敗理由
  // （HTTP 500・通信不能等）が運用者の目に一度も触れないまま消えていた
  // （#313 段 C 2巡目レビューで検出）。
  const reload = async (): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
    try {
      // **`GET /api/stations` は `{ stations: [...] }` を返す**（README.md
      // 「`/api/stations`・`/api/boards`」）。生の配列ではない。
      const body = await apiFetch<{ readonly stations: readonly StationInfo[] }>('/api/stations')
      if (signal.aborted) return { ok: true }
      current = body.stations
      renderTable(container, current)
      return { ok: true }
    } catch (error) {
      if (signal.aborted) return { ok: true }
      return { ok: false, reason: describeFetchFailure(error) }
    }
  }

  const form = qs<HTMLFormElement>(container, '.station-form')
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void (async () => {
      const stationId = qs<HTMLInputElement>(container, '[name=stationId]').value.trim()
      const displayName = qs<HTMLInputElement>(container, '[name=displayName]').value.trim()
      const lat = Number(qs<HTMLInputElement>(container, '[name=lat]').value)
      const lon = Number(qs<HTMLInputElement>(container, '[name=lon]').value)
      if (stationId.length === 0) {
        renderError(container, '観測点 ID を入力すること')
        return
      }
      try {
        await apiFetch(`/api/stations/${encodeURIComponent(stationId)}`, {
          method: 'PUT',
          body: JSON.stringify({ displayName, lat, lon }),
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

  qs(container, '.stations-table tbody').addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const row = target.closest<HTMLElement>('tr[data-station-id]')
    if (row === null) return
    const stationId = row.dataset.stationId ?? ''
    const station = current.find((s) => s.stationId === stationId) ?? null

    if (target.classList.contains('edit-station') && station !== null) {
      fillForm(container, station)
      return
    }
    if (target.classList.contains('delete-station')) {
      void (async () => {
        if (!window.confirm(`観測点「${stationId}」を削除する？`)) return
        try {
          await apiFetch(`/api/stations/${encodeURIComponent(stationId)}`, { method: 'DELETE' })
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

/** `GET /api/stations` の失敗理由を日本語化する（`describeSaveFailure` の GET 専用版）。 */
function describeFetchFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const authReason = describeAdminAuthFailure(error.message)
    if (authReason !== null) return authReason
  }
  return error instanceof Error ? error.message : String(error)
}

function describeSaveFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return '基板が割り当て済みのため削除できない（先に基板側の割当を外すこと）'
  }
  if (error instanceof ApiError && error.status === 400) {
    return `入力が不正: ${error.message}`
  }
  return describeFetchFailure(error)
}
