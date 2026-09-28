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
import { fetchDetectedBoards, type DetectedBoard } from './detectedBoards'
import { ago, escapeHtml, qs, receptionBadgeHtml } from './dom'
import {
  emptySensorFormValues,
  parseSensorFormValues,
  readSensorCardValues,
  renderSensorCardHtml,
  sensorToFormValues,
  SENSOR_ID_DATALIST_ID,
} from './sensorForm'
import type { BoardEntry, SensorEntry, StationInfo } from '../receiver/stationConfigTypes'

/** 基板 Key の入力候補（`<datalist>`）の id。中身は `/status` が声を聞いている基板。 */
const BOARD_KEY_DATALIST_ID = 'detected-board-keys'

function optionsHtml(values: readonly string[]): string {
  return values.map((v) => `<option value="${escapeHtml(v)}"></option>`).join('')
}

function renderError(container: HTMLElement, message: string): void {
  const el = qs(container, '.boards-error')
  el.textContent = message
  el.classList.toggle('error', message.length > 0)
}

/**
 * 基板 1 枚ぶんの行。**声が届いているかと、設定にあるかは別の事実**なので、
 * どちらか一方しか無い行もある。
 */
export interface BoardRow {
  readonly boardKey: string
  /** `/status` が声を聞いていれば、その様子。聞いていなければ `null`。 */
  readonly detected: DetectedBoard | null
  /** 設定に登録されていれば、その内容。未登録なら `null`。 */
  readonly registered: BoardEntry | null
}

/**
 * 「声が届いている基板」と「設定にある基板」を 1 つの並びへ畳む。
 *
 * **2 つの表に分けない。** 実運用では大半が両方に該当するので、分けると同じ基板が
 * 二度並ぶ。しかも**いちばん知りたい状態がどちらからも読めない**——「登録したのに
 * 声が届いていない」は、声の一覧には現れず、設定の一覧は受信の様子を持たない。
 *
 * **並びは「届いている順 → 届いていない登録済み」。** 前半は `/status` の順
 * （音沙汰の新しい順・`sensorHealth.ts` の `snapshot`）をそのまま使う。
 */
export function mergeBoardRows(
  detected: readonly DetectedBoard[],
  boards: readonly BoardEntry[],
): readonly BoardRow[] {
  const rows: BoardRow[] = []
  const heard = new Set<string>()
  for (const d of detected) {
    heard.add(d.boardKey)
    rows.push({
      boardKey: d.boardKey,
      detected: d,
      registered: boards.find((b) => b.boardKey === d.boardKey) ?? null,
    })
  }
  for (const b of boards) {
    if (heard.has(b.boardKey)) continue
    rows.push({ boardKey: b.boardKey, detected: null, registered: b })
  }
  return rows
}

function renderBoardsTable(
  container: HTMLElement,
  rows: readonly BoardRow[],
  stations: readonly StationInfo[],
  /** 経過を測る基準。`/status` を取れていなければ `null`（経過は出さない）。 */
  nowMs: number | null,
): void {
  const tbody = qs(container, '.boards-table tbody')
  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="muted">まだ 1 枚も無い（基板から届けば、ここに出る）</td></tr>'
    return
  }
  const stationName = (id: string): string => stations.find((s) => s.stationId === id)?.displayName ?? id
  tbody.innerHTML = rows
    .map((row) => {
      // **センサーは「届いている値」を優先する。** 設定に書いた `sensorId` と
      // 実際に名乗る値が食い違っていても保存は通るので、届いているほうを見せる。
      const sensors =
        row.detected !== null
          ? row.detected.sensorIds.join('、')
          : (row.registered?.sensors.map((s) => s.sensorId).join('、') ?? '')
      // **基準の時刻が無ければ経過を出さない。** 受け手の時計で代用すると、端末の
      // 時計がずれているだけで「10 分前」と出る（`detectedBoards.ts` の `generatedAtMs`）。
      const reception =
        row.detected === null
          ? '<span class="badge stale">未受信</span>'
          : nowMs === null
            ? '不明'
            : `${receptionBadgeHtml(nowMs, row.detected.lastPacketMs)} ${ago(nowMs, row.detected.lastPacketMs)}`
      const station =
        row.registered !== null
          ? escapeHtml(stationName(row.registered.stationId))
          : '<span class="muted">未登録</span>'
      const actions =
        row.registered !== null
          ? `<button type="button" class="edit-board">編集</button>
             <button type="button" class="delete-board danger">削除</button>`
          : '<button type="button" class="register-board">登録</button>'
      return `
        <tr data-board-key="${escapeHtml(row.boardKey)}">
          <td>${escapeHtml(row.boardKey)}</td>
          <td>${escapeHtml(sensors)}</td>
          <td>${reception}</td>
          <td>${station}</td>
          <td>${actions}</td>
        </tr>`
    })
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

/**
 * センサー ID だけを入れたカードを並べる（校正値は既定値）。
 *
 * **`/status` が名乗っているセンサーぶんを先に作っておくためのもの。** `sensorId`
 * を手で打つと、1 文字違っても保存は通り、しかも校正値が 1 つも効かないまま
 * 既定値で動き続ける（`detectedBoards.ts` 冒頭）。
 */
function renderSensorCardsForIds(container: HTMLElement, sensorIds: readonly string[]): void {
  const list = qs(container, '.sensor-cards')
  list.innerHTML = sensorIds
    .map((sensorId) => renderSensorCardHtml({ ...emptySensorFormValues(), sensorId }))
    .join('')
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
    <!-- **表は 1 つ。** 声が届いている基板と設定にある基板を分けて並べると、
         大半が両方に該当するので同じ基板が二度出る。しかも「登録したのに届いて
         いない」がどちらからも読めない（mergeBoardRows のコメント）。 -->
    <section class="panel">
      <h2>基板</h2>
      <p class="muted boards-note"></p>
      <table class="boards-table">
        <thead><tr><th>基板 Key</th><th>センサー</th><th>受信</th><th>観測点</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </section>
    <section class="panel">
      <h2>基板を登録・編集する</h2>
      <form class="board-form">
        <!-- **ラベルの初期値はここに置く。** 初回マウントでは fillForm を通らない
             （reload しか呼ばない）ので、空にすると新規登録の画面でラベルごと消える。 -->
        <label><span class="boardKey-label">基板 Key</span><input name="boardKey" list="${BOARD_KEY_DATALIST_ID}" placeholder="mac:aabbccddeeff" required /></label>
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
    <!-- **候補は datalist で添える（select にしない）。** 基板は電源が入って送り始める
         まで /status に現れないので、選択のみにすると現地へ行く前に設定を用意して
         おく運用が潰れる。 -->
    <datalist id="${BOARD_KEY_DATALIST_ID}"></datalist>
    <datalist id="${SENSOR_ID_DATALIST_ID}"></datalist>
  `

  let currentBoards: readonly BoardEntry[] = []
  let currentStations: readonly StationInfo[] = []
  let currentDetected: readonly DetectedBoard[] = []

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

  /**
   * センサー ID の候補を、いまフォームに入っている基板のものへ差し替える。
   *
   * **基板 Key が変わるたびに呼ぶ。** 候補を全基板ぶん混ぜると、別の基板の
   * センサー ID を選べてしまい、手で打ったのと同じ取り違えが起きる。
   */
  const refreshSensorIdOptions = (): void => {
    const boardKey = qs<HTMLInputElement>(container, '[name=boardKey]').value.trim()
    const found = currentDetected.find((d) => d.boardKey === boardKey)
    qs(container, `#${SENSOR_ID_DATALIST_ID}`).innerHTML = optionsHtml(found?.sensorIds ?? [])
  }

  const switchForm = (board: BoardEntry | null): void => {
    fillForm(container, board)
    refreshSensorIdOptions()
    formDirty = false
  }

  // **`signal.aborted` を確認してから DOM を書く。** 理由は `viewStations.ts` と同じ。
  //
  // **戻り値は「再取得に成功したか、失敗ならその理由」。** `renderError` を
  // ここでは呼ばない——理由は `viewStations.ts` と同じ（呼び出し元が理由を
  // 組み込んだ文言を1回だけ表示する）。
  const reload = async (): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
    // **`/status` の失敗で基板の編集まで止めない。** あちらは入力候補を出すための
    // 材料でしかなく（しかも無認証の別の口）、取れなくても手で入力して保存できる。
    // 先に投げておいて `/api/*` と並べて待つが、**拒否は必ずここで受け止める**
    // ——`Promise.all` に混ぜると、`/api/*` が先に投げたときに未処理の拒否になる。
    const detecting = fetchDetectedBoards().then(
      (snapshot) => ({ snapshot, failure: null as string | null }),
      (error: unknown) => ({
        snapshot: null,
        failure: error instanceof Error ? error.message : String(error),
      }),
    )
    try {
      // **どちらも `{ 単数形s: [...] }` の形で返る**（`GET /api/stations` と同じ理由）。
      const [boardsBody, stationsBody] = await Promise.all([
        apiFetch<{ readonly boards: readonly BoardEntry[] }>('/api/boards'),
        apiFetch<{ readonly stations: readonly StationInfo[] }>('/api/stations'),
      ])
      const detected = await detecting
      if (signal.aborted) return { ok: true }
      currentBoards = boardsBody.boards
      currentStations = stationsBody.stations
      currentDetected = detected.snapshot?.boards ?? []
      fillStationOptions(container, currentStations)
      renderBoardsTable(
        container,
        mergeBoardRows(currentDetected, currentBoards),
        currentStations,
        detected.snapshot?.generatedAtMs ?? null,
      )
      // **`/status` を取れなくても編集は続けられる。** 候補と受信の様子が出ないだけ。
      qs(container, '.boards-note').textContent =
        detected.failure === null
          ? ''
          : `受信の様子を取得できない（${detected.failure}）。基板 Key は手で入力すること`
      qs(container, `#${BOARD_KEY_DATALIST_ID}`).innerHTML = optionsHtml(
        currentDetected.map((d) => d.boardKey),
      )
      refreshSensorIdOptions()
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
  form.addEventListener('input', (e) => {
    formDirty = true
    // **基板 Key を打ち換えたらセンサー ID の候補も入れ替える。** 残したままだと、
    // 前に見ていた基板のセンサー ID が候補に出る。
    if ((e.target as HTMLElement).getAttribute('name') === 'boardKey') refreshSensorIdOptions()
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

    // **声の届いている基板を、そのままフォームへ移す。** 基板 Key と、その基板が
    // 実際に名乗っているセンサー ID のカードを既定値で並べる——ここが手打ちを
    // 無くす本体で、候補（`<datalist>`）は後から打ち換えるときの受け皿。
    if (target.classList.contains('register-board')) {
      const detected = currentDetected.find((d) => d.boardKey === boardKey)
      if (detected === undefined) return
      if (!confirmDiscardIfDirty()) return
      try {
        // **フォームを触る前に dirty を立てる。** ここは状態を何段も書き換える
        // 同期の経路で、途中で投げると「一部だけ埋まったのに未保存の印が立って
        // いない」状態が残る——直後に別の基板の編集を押しても確認が出ず、
        // このハンドラ自身が防ごうとしている「無警告で消える」をやってしまう。
        formDirty = true
        switchForm(null)
        // **`switchForm` は中で印を落とす**ので、続きを書き換える前に立て直す。
        formDirty = true
        qs<HTMLInputElement>(container, '[name=boardKey]').value = detected.boardKey
        renderSensorCardsForIds(container, detected.sensorIds)
        refreshSensorIdOptions()
        // **jsdom には `scrollIntoView` が無い**ので、あれば呼ぶ形にする。
        qs(container, '.board-form').scrollIntoView?.({ behavior: 'smooth', block: 'start' })
        renderError(container, '')
      } catch (error) {
        // **押しても何も起きない形にしない。** `qs()` は見つからなければ投げる
        // （`dom.ts`）ので、DOM の組み立てとセレクタがずれた日に、ここが無言で
        // 止まる（同じ穴を保存ボタンで一度踏んでいる。#313 段 C-5 2巡目）。
        renderError(container, describeSaveFailure(error))
      }
      return
    }
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
