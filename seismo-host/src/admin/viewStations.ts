// 観測点タブ（`/api/stations` の一覧・作成・更新・削除）。

import { apiFetch, ApiError, describeAdminAuthFailure } from './api'
import { escapeHtml, formatNumber, qs } from './dom'
import {
  checkGeolocationAvailability,
  describeAccuracy,
  describeGeolocationError,
  roundCoord,
} from './geolocation'
import type { StationInfo } from '../receiver/stationConfigTypes'

const STATION_ID_PREFIX = 'station-'

/**
 * 既存と衝突しない観測点 ID を作る。
 *
 * **運用者に考えさせない。** `stationId` は登録後に変えられない（URL パスの値が正）
 * うえ、`PUT` は upsert なので、既にある ID を打つと**稼働中の観測点が警告なく
 * 上書きされる**。連番にしているのは、`/status` や設定ファイルにそのまま出る値
 * なので、乱数より読めるほうが運用者の役に立つため。
 */
export function nextStationId(existing: readonly string[]): string {
  const taken = new Set(existing)
  // **`existing.length + 1` 回で必ず見つかる**（既存が塞げるのは高々その個数）。
  // 無限ループにしないのは、上限のある探索だと分かる形にしておくため。
  for (let n = 1; n <= existing.length + 1; n++) {
    const id = `${STATION_ID_PREFIX}${n}`
    if (!taken.has(id)) return id
  }
  throw new Error('観測点 ID の候補を作れない')
}

function renderError(container: HTMLElement, message: string): void {
  const el = qs(container, '.stations-error')
  el.textContent = message
  el.classList.toggle('error', message.length > 0)
}

function renderTable(container: HTMLElement, stations: readonly StationInfo[]): void {
  const tbody = qs(container, '.stations-table tbody')
  if (stations.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">未登録</td></tr>'
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
  // **「変更不可」はそれが本当のときだけ出す。** 新規登録では入力必須なので、
  // 固定の文言にすると初めて登録する運用者へ嘘をつくことになる。
  qs(container, '.stationId-label').textContent = station !== null ? '観測点 ID（変更不可）' : '観測点 ID'
  nameInput.value = station?.displayName ?? ''
  latInput.value = station !== null ? String(station.lat) : ''
  lonInput.value = station !== null ? String(station.lon) : ''
}

export async function initStationsView(container: HTMLElement, signal: AbortSignal): Promise<void> {
  container.innerHTML = `
    <div class="stations-error"></div>
    <section class="panel">
      <h2>登録済みの観測点</h2>
      <table class="stations-table">
        <thead><tr><th>ID</th><th>表示名</th><th>緯度</th><th>経度</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </section>
    <section class="panel">
      <h2>観測点を登録・編集する</h2>
      <form class="station-form">
        <!-- **ラベルの初期値はここに置く。** 初回マウントでは fillForm を通らない
             （reload しか呼ばない）ので、空にすると新規登録の画面でラベルごと消える。 -->
        <label><span class="stationId-label">観測点 ID</span><input name="stationId" required /></label>
        <label>表示名<input name="displayName" required /></label>
        <div class="row">
          <label>緯度<input name="lat" type="number" step="any" required /></label>
          <label>経度<input name="lon" type="number" step="any" required /></label>
        </div>
        <div class="row">
          <button type="button" class="use-current-location" style="flex: 0 0 auto">現在地から入れる</button>
          <span class="location-note muted" style="align-self: center"></span>
        </div>
        <div class="row">
          <button type="submit">保存</button>
          <button type="button" class="reset-form">新規登録へ</button>
        </div>
      </form>
    </section>
  `

  let current: readonly StationInfo[] = []
  /**
   * 一覧を一度でも取れたか。
   *
   * **取れていないうちは観測点 ID を提案しない。** 既存の ID を知らないまま連番を
   * 出すと、稼働中の観測点と同じ値を勧めうる——`PUT` は upsert なので、保存した
   * 時点で相手の設定が黙って消える。
   */
  let listLoaded = false

  /**
   * 編集中の未保存内容があるか。
   *
   * **基板タブと同じ手当て**（`viewBoards.ts` の `formDirty`）。入力の途中で別の行の
   * 「編集」を押すと、確認なしで消えていた——「現在地から入れる」は取得に数秒かかる
   * ので、待っている間に別の操作をして取りこぼす機会がそのぶん増える
   * （敵対的レビューで、両タブの非対称として検出）。
   */
  let formDirty = false

  const confirmDiscardIfDirty = (): boolean => {
    if (!formDirty) return true
    return window.confirm('編集中の内容を破棄する？')
  }

  const switchForm = (station: StationInfo | null): void => {
    fillForm(container, station)
    if (station === null && listLoaded) {
      qs<HTMLInputElement>(container, '[name=stationId]').value = nextStationId(
        current.map((s) => s.stationId),
      )
    }
    formDirty = false
  }

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
      listLoaded = true
      renderTable(container, current)
      return { ok: true }
    } catch (error) {
      if (signal.aborted) return { ok: true }
      // **取れなかったら提案をやめる。** `current` は古いままなので、印を立てた
      // ままにすると、**いま保存したばかりの ID をもう一度勧めうる**——保存は
      // 成功したが直後の再取得だけ失敗した場合、新しい観測点は `current` に
      // 入っていない。`PUT` は upsert なので、運用者が続けて別の内容を保存すると
      // さっき作った観測点が確認なく上書きされる（敵対的レビューで検出）。
      listLoaded = false
      return { ok: false, reason: describeFetchFailure(error) }
    }
  }

  const form = qs<HTMLFormElement>(container, '.station-form')
  form.addEventListener('input', () => {
    formDirty = true
  })
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
        const reloaded = await reload()
        // **一覧を取り直した後に空へ戻す。** 先に戻すと、いま保存した ID を知らない
        // まま次の候補を選び、同じ値をもう一度勧めることになる。
        switchForm(null)
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

  // **使えない接続では、押す前に理由を出しておく。** `navigator.geolocation` は
  // 素の HTTP でも生えているので、確かめずにボタンだけ置くと「押しても何も
  // 起きない」画面になる（`geolocation.ts` 冒頭）。
  const locationButton = qs<HTMLButtonElement>(container, '.use-current-location')
  const locationNote = qs(container, '.location-note')
  const availability = checkGeolocationAvailability(window)
  if (!availability.ok) {
    locationButton.disabled = true
    locationNote.textContent = availability.reason
  }
  locationButton.addEventListener('click', () => {
    locationNote.textContent = '現在地を取得中…'
    try {
      requestCurrentPosition()
    } catch (error) {
      // **「取得中…」のまま固まらせない。** 埋め込み文脈などで
      // `getCurrentPosition` がその場で投げる実装があり、そのときは
      // どちらのコールバックも呼ばれない——`checkGeolocationAvailability`
      // の 2 点（secure context・API の有無）では先に弾けない。
      locationNote.textContent = `現在地を取得できない（${error instanceof Error ? error.message : String(error)}）`
    }
  })

  function requestCurrentPosition(): void {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (signal.aborted) return
        try {
          qs<HTMLInputElement>(container, '[name=lat]').value = String(roundCoord(position.coords.latitude))
          qs<HTMLInputElement>(container, '[name=lon]').value = String(roundCoord(position.coords.longitude))
          // **入れた座標は未保存の変更。** `input` イベントを経由しないので、
          // ここで印を立てないと別の行の編集へ移るとき確認なしで消える。
          formDirty = true
          locationNote.textContent = `現在地を入れた（${describeAccuracy(position.coords.accuracy)}）`
        } catch (error) {
          // **非同期の中の例外は誰も受け取らない。** 握りつぶすと「取得中…」の
          // ままになり、運用者には固まったようにしか見えない（`dom.ts` の `qs`
          // は見つからなければ投げる）。
          locationNote.textContent = `座標を入れられない（${error instanceof Error ? error.message : String(error)}）`
        }
      },
      (error) => {
        if (signal.aborted) return
        locationNote.textContent = describeGeolocationError(error)
      },
      // **待ち続けない。** 既定は無制限で、測位できない端末では「取得中…」の
      // ままになり、運用者は手で入力してよいのか判断できない。
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    )
  }

  qs(container, '.stations-table tbody').addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const row = target.closest<HTMLElement>('tr[data-station-id]')
    if (row === null) return
    const stationId = row.dataset.stationId ?? ''
    const station = current.find((s) => s.stationId === stationId) ?? null

    if (target.classList.contains('edit-station') && station !== null) {
      if (!confirmDiscardIfDirty()) return
      switchForm(station)
      return
    }
    if (target.classList.contains('delete-station')) {
      void (async () => {
        if (!window.confirm(`観測点「${stationId}」を削除する？`)) return
        try {
          await apiFetch(`/api/stations/${encodeURIComponent(stationId)}`, { method: 'DELETE' })
          if (signal.aborted) return
          const reloaded = await reload()
          // **削除した ID は次の候補へ戻る。** 編集中に消した場合はフォームにその
          // ID が残るので、新規登録の状態へ戻しておく。
          switchForm(null)
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
  // **初回マウントでも ID を提案する。** ここは `fillForm` を通らない経路なので、
  // 呼ばないと「最初に開いた画面だけ空欄」という一貫しない挙動になる。
  switchForm(null)
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
    return '基板が割り当て済み（先に基板側の割当を外すこと）'
  }
  if (error instanceof ApiError && error.status === 400) {
    return `入力が不正: ${error.message}`
  }
  return describeFetchFailure(error)
}
