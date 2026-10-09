// 基板タブ（`/api/boards` の一覧・作成・更新・削除）。
//
// **校正は 2 か所で編集する**（形は `stationConfigTypes.ts` の冒頭）。センサーごとのカードは
// 軸ごとの測る向き（基板の座標）とゼロ点・`enabled`、`noiseDensity` は詳細設定へ畳む。
// 基板の欄は基板の向き（鉛直合わせと方角）で、3x3 は詳細設定へ畳む。フォーム⇔設定の変換は
// `sensorForm.ts` に切り出してある（DOM に依存しない部分だけをユニットテストするため）。
// **`PUT` は全置換**（README.md「`/api/stations`・`/api/boards`」）なので、
// 保存時は表示中の全カードと基板の向きを読み直して丸ごと送る。

import { apiFetch, ApiError, describeAdminAuthFailure, getStoredToken } from './api'
import { boardGravityForTilt, NO_STILL_THREE_AXIS, stillMeanGal, suggestRotation } from './calibrationSuggest'
import { fetchDetectedBoards, type DetectedBoard, type SensorRestWindow } from './detectedBoards'
import { ago, escapeHtml, qs, receptionBadgeHtml } from './dom'
import {
  emptySensorFormValues,
  orientationToFormValues,
  parseHeadingText,
  parseOrientationFormValues,
  parseSensorFormValues,
  readOrientationValues,
  readSensorCardValues,
  renderOrientationHtml,
  renderSensorCardHtml,
  restWindowNote,
  sensorToFormValues,
  writeOrientationValues,
  writeSensorCardAxes,
  SENSOR_ID_DATALIST_ID,
} from './sensorForm'
import { fitSixFace } from './sixFaceFit'
import {
  cardPanelFailureMessage,
  describeFaces,
  parseRestWindowsBody,
  restWindowsFetchProblem,
  sixFaceApplied,
  sixFaceProblem,
  type SensorFitWindows,
} from './sixFacePanel'
import { multiplyMatVec3 } from '../receiver/matrix3'
import type { AxisCount, BoardEntry, SensorEntry, StationInfo } from '../receiver/stationConfigTypes'

/** 基板 Key の入力候補（`<datalist>`）の id。中身は `/status` が声を聞いている基板。 */
const BOARD_KEY_DATALIST_ID = 'detected-board-keys'

/**
 * `GET /api/rest-windows` の時間切れ。10 秒ごとの取り直しより長く取る（短いと、遅いだけの
 * 返事を毎回切って、揃い具合が一度も出なくなる）。
 */
const REST_WINDOWS_TIMEOUT_MS = 15_000

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
 *
 * **軸の本数は届いたパケットの本数で作る**（`DetectedBoard.axisCounts`）。2 軸のセンサーに
 * 3 軸のカードを作って保存すると、軸の本数が食い違ってパケットを捨て続ける。分からない
 * センサー（欄の無い古いホスト）だけ 3 軸で作る。
 */
function renderSensorCardsForDetected(container: HTMLElement, detected: DetectedBoard): void {
  const list = qs(container, '.sensor-cards')
  list.innerHTML = detected.sensorIds
    .map((sensorId) =>
      renderSensorCardHtml({ ...emptySensorFormValues(detected.axisCounts[sensorId] ?? 3), sensorId }),
    )
    .join('')
}

function addEmptySensorCard(container: HTMLElement, axisCount: AxisCount): void {
  const list = qs(container, '.sensor-cards')
  list.insertAdjacentHTML('beforeend', renderSensorCardHtml(emptySensorFormValues(axisCount)))
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
  // **基板の向きも基板ごとに入れ替える。** 残すと前に見ていた基板の向きで保存する。
  // 方角の欄と前の結果も空へ戻す（別の基板へ向けた方角を持ち越さない）。
  qs(container, '.board-orientation-slot').innerHTML = renderOrientationHtml(orientationToFormValues(board?.orientation))
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
        <div class="board-orientation-slot">${renderOrientationHtml(orientationToFormValues())}</div>
        <h3>センサー</h3>
        <div class="sensor-cards"></div>
        <div class="row">
          <!-- **軸の本数ごとに口を分ける。** まだ届いていない基板を先に用意するときは、届いた
               本数を使えない。2 軸のセンサー（IIS2ICLX）は 2 軸の口から足す。 -->
          <button type="button" class="add-sensor" data-axes="3" style="flex: 0 0 auto">3 軸のセンサーを追加</button>
          <button type="button" class="add-sensor" data-axes="2" style="flex: 0 0 auto">2 軸のセンサーを追加</button>
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
  let currentRestWindows: readonly SensorRestWindow[] = []
  /** 経過を測る基準（`/status` の `generatedAtMs`）。取れていなければ `null`。 */
  let currentGeneratedAtMs: number | null = null
  /** 6 面法の材料（`GET /api/rest-windows`）。取れていなければ `null` で、理由は下。 */
  let currentFitWindows: readonly SensorFitWindows[] | null = null
  let fitWindowsProblem: string | null = null
  /** 「鉛直を合わせる」を押して、ホストの返事を待っているか（ボタンは基板に 1 つ）。 */
  let tiltInFlight = false

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

  /** いまフォームに入っている基板の、そのセンサーの静止窓。無ければ `null`。 */
  const findRestWindow = (sensorId: string): SensorRestWindow | null => {
    const boardKey = qs<HTMLInputElement>(container, '[name=boardKey]').value.trim()
    if (boardKey.length === 0 || sensorId.length === 0) return null
    return (
      currentRestWindows.find((w) => w.boardKey === boardKey && w.sensorId === sensorId) ?? null
    )
  }

  /** いまフォームに入っている基板の、そのセンサーの静止窓。無ければ `null`。 */
  const findFitSource = (
    sensors: readonly SensorFitWindows[] | null,
    sensorId: string,
  ): SensorFitWindows | null => {
    const boardKey = qs<HTMLInputElement>(container, '[name=boardKey]').value.trim()
    return sensors?.find((s) => s.boardKey === boardKey && s.sensorId === sensorId) ?? null
  }

  /** いまフォームに入っている基板の、そのセンサーの 6 面法の材料。無ければ空。 */
  const findFitWindows = (sensorId: string): SensorFitWindows['windows'] =>
    findFitSource(currentFitWindows, sensorId)?.windows ?? []

  /**
   * 各カードの「6 面で測る」欄（揃った面・押せる押せない・押せない理由）を描き直す。
   *
   * **カードごとに囲う**（`refreshTiltPanels` と同じ理由 —— 先頭で投げると残りが古いまま固まる）。
   * 押した後の結果（`.s-sixface-result`）には触らない。取り直しのたびに消えると、入れた
   * 直後の案内が 10 秒で読めなくなる。
   *
   * **描き直せなかった枚数を返し、自分では画面へ出さない。** 画面上部の欄は 1 つしか無く、
   * 「鉛直を合わせる」の欄と別々に書くと後の書き手が先の知らせを消す。出すのは
   * `refreshTiltPanels` がまとめて 1 回だけ。
   */
  const refreshSixFacePanels = (): number => {
    let broken = 0
    for (const card of container.querySelectorAll<HTMLElement>('.sensor-cards .sensor-card')) {
      try {
        // **2 軸のカードには欄が無い**（`sensorForm.ts` の `SIX_FACE_HTML`）。欄が無いことを
        // 「壊れた」と数えないよう、軸の本数で飛ばす（欄の有無で飛ばすと、本当に欄が
        // 消えた 3 軸のカードまで黙って飛ばす）。
        if (readSensorCardValues(card).axes.length !== 3) continue
        const sensorId = qs<HTMLInputElement>(card, '.s-sensorId').value.trim()
        const result = fitSixFace(findFitWindows(sensorId))
        qs(card, '.s-sixface-faces').textContent = describeFaces(result.faces)
        const problem = fitWindowsProblem ?? sixFaceProblem(result)
        qs<HTMLButtonElement>(card, '.apply-sixface').disabled = problem !== null
        qs(card, '.s-sixface-why').textContent = problem ?? ''
      } catch (error) {
        broken += 1
        console.warn('[admin] センサーカードの 6 面法の欄を描き直せない', error)
      }
    }
    return broken
  }

  /**
   * 6 面法の材料を取り直す。**投げない。** 取れなければ理由を残して欄へ出す。
   *
   * **トークンが無ければ取りに行かない。** 10 秒ごとに 401 を投げ続けると、ホストの記録が
   * 拒否の行で埋まる（入れ直せば次の回から取れる）。
   */
  let fitWindowsInFlight = false
  /**
   * `GET /api/rest-windows` へ渡す中断の合図。**画面を閉じたときと、時間切れのときに止める。**
   *
   * 時間切れが無いと、返事の来ない問い合わせが「取得中」の印を握ったまま残る ——
   * 10 秒ごとの取り直しは次を投げず、押したボタンは押せないまま、どちらも理由を出さない。
   */
  const restWindowsSignal = (): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(REST_WINDOWS_TIMEOUT_MS)])
  /** 投げた問い合わせの通し番号と、控え（`currentFitWindows`）の値を取ってきた問い合わせの番号。 */
  let fitWindowsRequested = 0
  let fitWindowsApplied = 0

  /**
   * `GET /api/rest-windows` を 1 回投げ、控えを更新して結果を返す。**投げない。** 画面を閉じたら `null`。
   *
   * **控えへ書くのはここだけ。** 10 秒ごとの取り直しと「鉛直を合わせる」の取り直しは同時に
   * 飛びうるので、着いた順に書くと、先に投げた（古い）返事が後から着いて新しい値を上書きする。
   * **投げた順で新しいものだけを控えに入れる**（返事を待っていた側には、自分の結果をそのまま返す）。
   */
  const requestRestWindows = async (): Promise<{
    readonly sensors: readonly SensorFitWindows[] | null
    readonly problem: string | null
  } | null> => {
    const seq = ++fitWindowsRequested
    let sensors: readonly SensorFitWindows[] | null = null
    let problem: string | null = null
    try {
      sensors = parseRestWindowsBody(await apiFetch<unknown>('/api/rest-windows', { signal: restWindowsSignal() }))
      if (sensors === null) problem = restWindowsFetchProblem('応答の形が違う')
    } catch (error) {
      problem = restWindowsFetchProblem(describeFetchFailure(error))
    }
    if (signal.aborted) return null
    if (seq > fitWindowsApplied) {
      fitWindowsApplied = seq
      currentFitWindows = sensors
      fitWindowsProblem = problem
    }
    return { sensors, problem }
  }

  const loadFitWindows = async (): Promise<void> => {
    if (getStoredToken() === null) return
    // **前の取得が終わるまで次を投げない。** 返事の遅いホストへ 10 秒ごとに重ねて投げない。
    if (fitWindowsInFlight) return
    fitWindowsInFlight = true
    try {
      if ((await requestRestWindows()) === null) return
    } finally {
      fitWindowsInFlight = false
    }
    // **取り付けの欄ごと描き直す。** 失敗の知らせを 1 か所でまとめて出すため（`refreshTiltPanels`）。
    refreshTiltPanels()
  }

  /**
   * 各カードの静止窓の様子と、基板の「鉛直を合わせる」の押せる・押せないを描き直す。
   *
   * **カードを作った直後・`/status` を取り直した後・センサー ID を打ち換えたときに呼ぶ。**
   * どれか 1 つでも抜けると、**そのカードだけ古い診断が残る** —— 判定は 30 秒ごとに
   * 変わるうえ、どのセンサーの話かはカードの中の ID でしか決まらない。
   */
  const refreshTiltPanels = (): void => {
    let broken = 0
    /** 3 軸のカードのうち、いまの置き方で静止しているものがあるか。 */
    let anyStillThreeAxis = false
    for (const card of container.querySelectorAll<HTMLElement>('.sensor-cards .sensor-card')) {
      // **1 枚ずつ囲う。** `qs()` は見つからなければ投げる（`dom.ts`）ので、
      // 囲わないと**先頭のカードで投げた時点で残り全部の診断が古いまま固まる**
      // ——カードは何枚でも並ぶうえ、ここは 5 箇所から呼ばれる（カードの生成・
      // センサー ID や基板 Key の打ち換え・`/status` の再取得）。呼ぶ側を
      // 1 つずつ囲う形にすると、次に呼び出しを足した人が忘れる。
      try {
        const sensorId = qs<HTMLInputElement>(card, '.s-sensorId').value.trim()
        const window = findRestWindow(sensorId)
        qs(card, '.s-rest-note').textContent = restWindowNote(window, currentGeneratedAtMs)
        // **押せるかどうかは押したときに使う材料で決める**（校正前の静止窓）。
        // 上の注記（`/status` の判定）は保存済みの設定で見たホストの診断で、別の話。
        if (readSensorCardValues(card).axes.length === 3 && stillMeanGal(findFitSource(currentFitWindows, sensorId)).ok) {
          anyStillThreeAxis = true
        }
      } catch (error) {
        broken += 1
        console.warn('[admin] センサーカードの取り付け診断を描き直せない', error)
      }
    }
    try {
      const button = qs<HTMLButtonElement>(container, '.board-orientation .suggest-tilt')
      const problem = fitWindowsProblem ?? (anyStillThreeAxis ? null : NO_STILL_THREE_AXIS)
      // **押しても何も起きない形にしない。** 押せないなら理由が読めること
      // （#345 で位置情報のボタンに同じ手当てをしている）。
      //
      // **押した後の問い合わせ中は押せないままにする。** ここは 10 秒ごとの取り直しからも
      // 呼ばれるので、印を見ないと待っている間に押せる状態へ戻り、2 回ぶん書き込む。
      button.disabled = problem !== null || tiltInFlight
      button.title = problem ?? '静止時の重力から、基板の傾きを打ち消す向きを入れる（保存するまで効かない）'
    } catch (error) {
      broken += 1
      console.warn('[admin] 基板の向きの欄を描き直せない', error)
    }
    // **6 面法の欄も同じ契機で描き直す。** どちらも「どのセンサーの話か」をカードの ID と
    // 基板 Key で決めるので、打ち換えやカードの追加で片方だけ古いまま残らないように。
    const sixFaceBroken = refreshSixFacePanels()
    // **失敗したときだけ書く。** 成功で空にすると、保存の失敗など別の理由で
    // 出ている文言をここが消してしまう。**2 つの欄の失敗は 1 回でまとめて書く** ——
    // 別々に書くと、後の書き手が先の知らせを消す。
    const failure = cardPanelFailureMessage(broken, sixFaceBroken)
    if (failure !== null) renderError(container, failure)
  }

  const switchForm = (board: BoardEntry | null): void => {
    fillForm(container, board)
    refreshSensorIdOptions()
    refreshTiltPanels()
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
      currentRestWindows = detected.snapshot?.restWindows ?? []
      currentGeneratedAtMs = detected.snapshot?.generatedAtMs ?? null
      fillStationOptions(container, currentStations)
      renderBoardsTable(
        container,
        mergeBoardRows(currentDetected, currentBoards),
        currentStations,
        currentGeneratedAtMs,
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
      // **編集中のカードにも新しい診断を映す。** 静止窓は 30 秒ごとに閉じるので、
      // 開いたままのフォームが古い判定を指し続けるのを避ける。
      refreshTiltPanels()
      return { ok: true }
    } catch (error) {
      if (signal.aborted) return { ok: true }
      return { ok: false, reason: describeFetchFailure(error) }
    }
  }

  for (const button of container.querySelectorAll<HTMLButtonElement>('.add-sensor')) {
    const axisCount: AxisCount = button.dataset.axes === '2' ? 2 : 3
    button.addEventListener('click', () => {
      addEmptySensorCard(container, axisCount)
      formDirty = true
      refreshTiltPanels()
    })
  }

  const form = qs<HTMLFormElement>(container, '.board-form')
  form.addEventListener('input', (e) => {
    formDirty = true
    const target = e.target as HTMLElement
    // **基板 Key を打ち換えたらセンサー ID の候補も入れ替える。** 残したままだと、
    // 前に見ていた基板のセンサー ID が候補に出る。
    if (target.getAttribute('name') === 'boardKey') {
      refreshSensorIdOptions()
      // 基板が変われば、どのカードの診断も別のセンサーのものになる。
      refreshTiltPanels()
    }
    // **センサー ID を打ち換えたら、そのカードの診断も引き直す。** 引き直さないと、
    // 前に入っていた ID の判定が別のセンサーのカードに残る。
    if (target.classList.contains('s-sensorId')) refreshTiltPanels()
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
        // **基板の向きも毎回送る。** `PUT` は全置換なので、送らなければ単位行列へ戻る。
        const orientation = parseOrientationFormValues(readOrientationValues(container))
        if ('error' in orientation) {
          renderError(container, orientation.error)
          return
        }
        await apiFetch(`/api/boards/${encodeURIComponent(boardKey)}`, {
          method: 'PUT',
          body: JSON.stringify({ stationId, orientation, sensors }),
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
    if (target.classList.contains('remove-sensor')) {
      target.closest('.sensor-card')?.remove()
      formDirty = true
      return
    }
    if (target.classList.contains('apply-sixface')) {
      const card = target.closest<HTMLElement>('.sensor-card')
      if (card === null) return
      // **結果はそのカードの中へ出す**（「鉛直を合わせる」と同じ理由）。
      const note = (text: string): void => {
        const el = card.querySelector('.s-sixface-result')
        if (el === null) {
          console.warn('[admin] 6 面法の結果を出す場所が無い:', text)
          return
        }
        el.textContent = text
      }
      try {
        const sensorId = qs<HTMLInputElement>(card, '.s-sensorId').value.trim()
        // **押された時点の材料で計算し直す。** 描き直しから押すまでの間に窓が増減している。
        const result = fitSixFace(findFitWindows(sensorId))
        const problem = fitWindowsProblem ?? sixFaceProblem(result)
        if (problem !== null || !result.ok) {
          note(problem ?? '計算できなかった')
          return
        }
        // **測る向きはカードのいまの値から取る**（長さだけを 6 面法の倍率に合わせる）。
        // 数として読めない欄があれば、ここで理由を出す。
        const parsed = parseSensorFormValues(readSensorCardValues(card))
        if (!parsed.ok) {
          note(parsed.error)
          return
        }
        const applied = sixFaceApplied(
          result,
          parsed.sensor.axes.map((a) => a.vector),
        )
        if (!applied.ok) {
          note(applied.reason)
          return
        }
        // **書き込む前に未保存の印を立てる**（「鉛直を合わせる」と同じ手当て）。
        formDirty = true
        writeSensorCardAxes(card, applied.axes)
        note(applied.note)
      } catch (error) {
        note(describeSaveFailure(error))
      }
      return
    }
  })

  // **「鉛直を合わせる」は基板の欄に 1 つ。** 欄そのものは `fillForm` が基板ごとに作り直すので、
  // 作り直されない外側（`.board-orientation-slot`）で受ける。
  qs(container, '.board-orientation-slot').addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains('suggest-tilt')) return
    const panel = target.closest<HTMLElement>('.board-orientation')
    if (panel === null) return
    // **ここだけ `qs()` を使わない。** あれは見つからなければ投げるが、`note` は
    // 下の `catch` の中からも呼ぶ ——「伝える先が無い」という理由で投げると、
    // 伝えようとしていた内容（多くは別の失敗の理由）ごと外へ飛んで消える。
    const note = (text: string): void => {
      const el = panel.querySelector('.b-tilt-result')
      if (el === null) {
        console.warn('[admin] 提案の結果を出す場所が無い:', text)
        return
      }
      el.textContent = text
    }
    // **押した瞬間にホストへ取り直す。** 10 秒ごとの取り直しの結果を使うと、その間に
    // 置き直した基板では前の置き方で計算してしまう。待っている間は押せなくして、
    // 続けて押されても 1 回ぶんしか書かない。
    //
    // **印は画面に 1 つ持つ**（`refreshTiltPanels` が見る）。ボタンを `disabled` にする
    // だけだと、10 秒ごとの取り直しの描き直しが待っている間に押せる状態へ戻す。
    if (tiltInFlight) return
    tiltInFlight = true
    const button = target as HTMLButtonElement
    button.disabled = true
    void (async () => {
      try {
        const fetched = await requestRestWindows()
        // **待っている間にフォームを切り替えられたら何もしない。** 外れた欄へ書いても
        // 画面には出ず、未保存の印だけが新しいフォームへ立って、触っていないフォームで
        // 破棄の確認が出る。
        if (fetched === null || !container.contains(panel)) return
        const sources = fetched.sensors
        if (sources === null) {
          note(fetched.problem ?? restWindowsFetchProblem('応答の形が違う'))
          return
        }
        // **カードの現在値を通して読む。** 解けない向きといった不備も同じ口で捕まる
        // ——保存のときに初めて言われるより、ここで言うほうが早い。
        const sensors = readAllSensors(container)
        if ('error' in sensors) {
          note(sensors.error)
          return
        }
        const orientation = parseOrientationFormValues(readOrientationValues(panel))
        if ('error' in orientation) {
          note(orientation.error)
          return
        }
        const heading = parseHeadingText(qs<HTMLInputElement>(panel, '.b-heading').value)
        if (heading !== null && typeof heading !== 'number') {
          note(heading.error)
          return
        }
        // **重力はカードの値で出し直す**（`boardGravityForTilt` の説明）。保存済みかどうか・
        // 前に押したかどうかで答えが変わらない。
        const gravity = boardGravityForTilt(
          sensors.map((sensor) => ({ source: findFitSource(sources, sensor.sensorId), sensor })),
        )
        if (!gravity.ok) {
          note(gravity.reason)
          return
        }
        // 基板の座標の重力へ、いまの基板の向きを掛けて地面の座標にする。
        const ground = multiplyMatVec3(orientation, gravity.gravity)
        const got = suggestRotation({ gravity: ground, rotation: orientation, headingDeg: heading })
        if (!got.ok) {
          note(got.reason)
          return
        }
        // **書き込む前に未保存の印を立てる。** 途中で投げても「一部だけ書き換わった
        // のに印が立っていない」を作らない（`register-board` と同じ手当て）。
        formDirty = true
        writeOrientationValues(panel, got.rotation)
        // **「ぶんも回した」と書かない。** 実際に回すのはいまの向きとの差だけで、
        // 入れた値そのものではない（同じ値をもう一度入れれば何も回らない）。
        const heads = heading === null ? '方角は変えていない' : `X 軸を方角 ${heading}° へ向けた`
        const flip = got.upsideDown ? '／上下逆さまに付いている（方角も見直すこと）' : ''
        note(`傾き ${got.tiltDeg}° を打ち消す向きを入れた（${heads}）。保存するまで効かない${flip}`)
      } catch (error) {
        // `qs()` は見つからなければ投げる（`dom.ts`）。無言で止めない。
        note(describeSaveFailure(error))
      } finally {
        tiltInFlight = false
        // **押せる・押せないは描き直しに任せる**（材料の様子で決まるので、ここで
        // `false` へ戻すと押せないはずのボタンが押せるまま残る）。
        if (!signal.aborted) refreshTiltPanels()
      }
    })()
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
        renderSensorCardsForDetected(container, detected)
        refreshSensorIdOptions()
        refreshTiltPanels()
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

  // **6 面法の材料だけは開いている間ずっと取り直す。** 基板を置き換えるたびに ✓ が
  // 増えていくのを見ながら進める作業で、画面を読み込み直させると編集中のフォームが消える。
  // 窓は 30 秒ごとに閉じるので、その 3 分の 1 で取れば置いてから 40 秒以内に ✓ が付く。
  // **フォームの入力欄には触らない**（揃い具合と押せる押せないだけを描き直す）。
  await loadFitWindows()
  // **待っている間にタブを移っていたら張らない。** 張ってから abort を待つ形では、
  // 既に鳴り終わった abort を拾えず、見えない画面で取り直しが続く。
  if (signal.aborted) return
  const poll = setInterval(() => void loadFitWindows(), 10_000)
  signal.addEventListener('abort', () => clearInterval(poll), { once: true })
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
