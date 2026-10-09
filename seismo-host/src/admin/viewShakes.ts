// 揺れの記録タブ（`GET /events` の一覧・`/status` の見張りの行・押した揺れの区間の波形）。
// **宛先は運用者。** 文言は 2026-10-06 ユーザー承認（一部の観測点だけ読めないときの行は 2026-10-07）。
//
// - **一覧は読み返しと押し出しの 2 本で作る。** 期間を変えたら `GET /events` で読み直し、開いている間は
//   押し出し（`/stream` の `shake-event`）で同じ記録の新しい版を差し込む —— 照合待ちが地震へ変わるのを、
//   開き直さずに見られる。2 本が前後して届いても、版（`rev`）の大きいほうが残る（`upsertShake`）。
// - **見張りの行を一覧の上に置く。** 空の一覧だけでは「静かだった」と「検出が止まっている」を
//   見分けられない（#564 で `/status` に足した引き金の状態を読む）。
// - **差し込む値は例外なく `escapeHtml` を通す**（`shakeHistory.ts` の組み立てが通している）。
// - **期間は直近の日数（ボタン）か、日付の指定で選ぶ。範囲の広さに上限は無い**（2026-10-07 ユーザー承認）。
//   ホストは新しいほうから 500 件で区切るので、続きは「さらに古い記録を読む」で読む（文言も同日承認）。
//
// `/events`・`/waves`・`/status`・`/stream` はどれも認証を持たない読み取りの口なので、トークンは付けない。

import { escapeHtml, qs } from './dom'
import {
  clipRange,
  EMPTY_UNREADABLE_BOOK,
  eventsQueryRange,
  eventsUrl,
  formatShakeStart,
  INITIAL_LOAD_STATE,
  jstDateOf,
  jstDayRange,
  truncatedNote,
  newerRecord,
  nextLoadState,
  nextUnreadableBook,
  readShakeRange,
  recentQueryRange,
  readTriggers,
  shakeRowHtml,
  startPeriodLoad,
  tableFailure,
  triggerLine,
  unreadableCount,
  upsertShake,
  visibleShakes,
} from './shakeHistory'
import type { LoadState, ReadKind, ShakeRecordView, TimeRange, UnreadableBook } from './shakeHistory'
import { detailMarkers, detailNote, detailTicks, detailWindow, readEnvelope, wavesUrl } from './shakeWave'
import type { EnvelopeView } from './shakeWave'
import { openWaveStream } from './waveStream'
import { formatGal, niceHalfSpanGal } from './wavePlot'

/**
 * 期間の選択肢（日。2026-10-07 ユーザー承認）。**既定は 7 日。** これより長い期間・過ぎた期間は
 * 日付の指定で選ぶ（範囲の広さに上限は無い）。
 */
const PERIOD_DAYS: readonly number[] = [1, 7, 30, 90]
const DEFAULT_PERIOD_DAYS = 7
const DAY_MS = 24 * 3_600_000

/**
 * 見張りの行と直近の記録を読み直す間隔。比の最大は 1 分刻みなので、それより細かくしても変わらない。
 * 記録は押し出しでも届くが、押し出しが切れている間の分をこちらで拾う。
 */
const RELOAD_MS = 30_000

/** 段 2 の軸の名前。**波形タブと同じ**（共通座標は ENU。README「共通座標は ENU」）。 */
const AXIS_LABELS: readonly string[] = ['X 軸（東が ＋）', 'Y 軸（北が ＋）', 'Z 軸（上が ＋）']
const TIME_AXIS_HEIGHT = 16
const PLOT_PADDING_Y = 6
const TIME_LABEL_MARGIN = 28

export async function initShakesView(container: HTMLElement, signal: AbortSignal): Promise<void> {
  container.innerHTML = `
    <section class="panel">
      <h2>見張りの状態</h2>
      <div class="shake-health muted"></div>
    </section>
    <section class="panel">
      <div class="row" style="align-items: center; flex-wrap: wrap; gap: 0.6rem">
        <div class="period-buttons" role="group">
          ${PERIOD_DAYS.map(
            (d) => `<button type="button" data-days="${d}" aria-pressed="${d === DEFAULT_PERIOD_DAYS}">${d} 日</button>`,
          ).join('')}
        </div>
        <div class="row" style="align-items: center; gap: 0.3rem; flex: 0 0 auto">
          <input type="date" class="shake-from" />
          <span>から</span>
          <input type="date" class="shake-to" />
          <span>まで</span>
          <button type="button" class="shake-range-apply" disabled>この期間を読む</button>
        </div>
        <label class="row" style="align-items: center; gap: 0.3rem; flex: 0 0 auto">
          <input type="checkbox" class="shake-hide-local" />
          <span>生活振動らしいものを隠す</span>
        </label>
      </div>
      <p class="shake-note error"></p>
      <table>
        <thead><tr><th>始まり</th><th>長さ</th><th>判定</th><th>最大加速度</th><th>計測震度相当</th><th>平常時の何倍</th><th>S 波</th><th>照合した地震</th><th>観測点</th></tr></thead>
        <tbody class="shake-rows"></tbody>
      </table>
      <!-- **row（display: flex）を付けない** —— 付けると hidden 属性が効かず、区切っていないときも出たままになる。 -->
      <div class="shake-more" style="margin-top: 0.6rem" hidden>
        <span class="shake-more-note muted"></span>
        <button type="button" class="shake-more-button" style="margin-left: 0.6rem">さらに古い記録を読む</button>
        <div class="shake-more-error error"></div>
      </div>
    </section>
  `

  const healthEl = qs(container, '.shake-health')
  const noteEl = qs(container, '.shake-note')
  const rowsEl = qs(container, '.shake-rows')
  const hideLocalEl = qs<HTMLInputElement>(container, '.shake-hide-local')
  /**
   * 区間の波形の欄。**押した行のすぐ下に開く**（2026-10-07 ユーザー承認）—— 一覧の下に置くと、500 件を出したとき
   * 上のほうの行を押すたびに下まで探しに行くことになる。一覧は押し出しや読み直しのたびに描き直すので、
   * **この要素を作り直さずに選んだ行の下へ付け直す**（作り直すと、描いた波形と取得中の状態が消える）。
   */
  const detailEl = document.createElement('div')
  detailEl.className = 'panel shake-detail'
  detailEl.hidden = true
  const fromDateEl = qs<HTMLInputElement>(container, '.shake-from')
  const toDateEl = qs<HTMLInputElement>(container, '.shake-to')
  const applyEl = qs<HTMLButtonElement>(container, '.shake-range-apply')
  const moreEl = qs(container, '.shake-more')
  const moreNoteEl = qs(container, '.shake-more-note')
  const moreButtonEl = qs<HTMLButtonElement>(container, '.shake-more-button')
  const moreErrorEl = qs(container, '.shake-more-error')

  /**
   * 選んでいる期間。**ボタンなら直近の日数**（右端はホストの時計で動く）、**日付の指定なら固定の範囲**。
   */
  let period: { readonly kind: 'days'; readonly days: number } | { readonly kind: 'dates'; readonly range: TimeRange } = {
    kind: 'days',
    days: DEFAULT_PERIOD_DAYS,
  }
  let list: readonly ShakeRecordView[] = []
  /** 読み返しの起点（ホストの時計）。**直近の日数の期間の左端はこれから測る。** */
  let anchorMs = Date.now()
  /**
   * 読み込んだ分の頭（ここから期間の終わりまでは漏れなく読んだ）と、その先にまだ読んでいない記録があるか。
   * **ホストは新しいほうから 500 件で区切る**ので、続きは「さらに古い記録を読む」でこの頭から読む。
   */
  let loadedFromMs = Number.NEGATIVE_INFINITY
  let olderRemain = false
  /**
   * 読み返しで読めなかった記録の帳面（ホストが読めなかったファイルと、この画面が読めない形の記録）。
   * 期間全体の読み返しの分と直近の読み返しの分を分けて持つ（規則は `nextUnreadableBook`）。
   */
  let unreadable: UnreadableBook = EMPTY_UNREADABLE_BOOK
  /** 押し出しで届いたが読めなかった記録（開いてからの累計）。 */
  let streamUnreadable = 0
  /** 読み返しの成否（種類ごとに分けて持つ。規則は `nextLoadState`）。 */
  let loadState: LoadState = INITIAL_LOAD_STATE
  let selectedId: string | null = null
  /** 読み返しの世代。期間を続けて押したとき、遅れて返った古い応答で一覧を上書きしない。 */
  let loadGeneration = 0
  /**
   * 期間全体を読み返している最中の世代（無ければ `null`）。**同じ世代で期間全体を 2 本同時に読まない** ——
   * 選び直した読み込みが見張りの行を待っている間に 30 秒ごとの読み直しが来ると、両方が期間全体を読みに行き、
   * 遅れて返った失敗が先に通った成功を上書きする。
   */
  let fullInFlight: number | null = null
  /** 波形の読み返しの世代（押し直し・閉じるで古い応答を捨てる）。 */
  let detailController: AbortController | null = null
  let detailEnvelope: { readonly record: ShakeRecordView; readonly envelope: EnvelopeView } | null = null

  /** 一覧に見せる範囲。直近の日数なら右端を開けておく（押し出しで新しい揺れが入る）。 */
  const shownRange = (): TimeRange =>
    period.kind === 'days'
      ? { fromMs: anchorMs - period.days * DAY_MS, toMs: Number.POSITIVE_INFINITY }
      : period.range

  /** 問い合わせる範囲（期間を選び直した回）。 */
  const periodQuery = (): TimeRange => (period.kind === 'days' ? eventsQueryRange(anchorMs, period.days) : period.range)

  const renderRows = (): void => {
    const shown = visibleShakes(list, {
      ...shownRange(),
      hideLocal: hideLocalEl.checked,
    })
    // **取得に失敗したことを表の中に出す。** 表の外に小さく出すだけだと、手元に残った一覧（または空）が
    // 「その期間の全部」に見える。**失敗しているときは「揺れは無い」とは書かない** ——
    // 取れていないのか、無かったのかを取り違える。
    const loadFailed = tableFailure(loadState)
    const failedRow =
      loadFailed === null ? '' : `<tr><td colspan="9" class="error">${escapeHtml(loadFailed)}</td></tr>`
    const body =
      shown.length > 0
        ? shown.map((r) => shakeRowHtml(r, r.id === selectedId)).join('')
        : loadFailed === null
          ? '<tr><td colspan="9" class="muted">この期間に記録した揺れは無い</td></tr>'
          : ''
    rowsEl.innerHTML = failedRow + body
    if (selectedId !== null) {
      // **開いている区間の行のすぐ下へ、詳細の欄を付け直す。** 行が一覧から消えたら（期間・隠す指定を変えた）閉じる ——
      // 見えない所で開いたままにすると、次に押した行と取り違える。id は `dataset` で比べる（セレクタへ差し込まない）。
      const row = [...rowsEl.querySelectorAll<HTMLElement>('tr.shake-row')].find((r) => r.dataset.shakeId === selectedId)
      if (row === undefined) {
        // 描き直しはしない（選んだ行が無いので、いま描いた表がそのまま閉じた後の表になる）。
        resetDetail()
      } else {
        const holder = document.createElement('tr')
        holder.className = 'shake-detail-row'
        const cell = document.createElement('td')
        cell.colSpan = 9
        cell.append(detailEl)
        holder.append(cell)
        row.after(holder)
      }
    }
    const unreadableTotal = unreadableCount(unreadable) + streamUnreadable
    noteEl.textContent = unreadableTotal > 0 ? `読めなかった記録が ${unreadableTotal} 件ある` : ''
    // **区切ったことを表の下に出す**（2026-10-07 ユーザー承認）—— 出さないと、新しいほうの一部が
    // 「その期間の全部」に見える。
    moreEl.hidden = !olderRemain
    moreNoteEl.textContent = olderRemain ? truncatedNote(shown.length) : ''
    // 続きを読めなかったら、ボタンの下に出す（押し直せば読み直す）。表の中には出さない —— 読めていないのは
    // 表の末尾の先で、表に出すと直近の読み直しが何度通っても消えない。
    moreErrorEl.textContent = olderRemain ? (loadState.older ?? '') : ''
  }

  const renderHealth = (status: unknown): void => {
    const triggers = readTriggers(status)
    const generated = (status as { generatedAtMs?: unknown } | null)?.generatedAtMs
    // **黙って空にしない。** この画面はホスト自身が配るので、欄を持たない古いホストという形は起きない
    // —— 欄が無いのは応答の形が壊れているときだけ。取れなかったときと同じく、そう書く。
    if (triggers === null || typeof generated !== 'number') {
      healthEl.innerHTML = '<div class="error">状態を取得できていない（応答の形が違う）</div>'
      return
    }
    const lines = triggers.items.map((t) => {
      const line = triggerLine(t, generated)
      return `<div class="${line.warn ? 'error' : ''}">${line.text}</div>`
    })
    // 読めない観測点があれば、その旨を添える（全部読めないときに空白にしない）。
    // **一部だけのときは書き分ける**（2026-10-07 ユーザー承認）—— 全滅と同じ文言だと、読めた観測点の行まで疑わせる。
    if (triggers.malformedCount > 0) {
      lines.push(
        triggers.items.length === 0
          ? '<div class="error">状態を取得できていない（応答の形が違う）</div>'
          : `<div class="error">一部の観測点の状態を取得できていない（${triggers.malformedCount} 件・応答の形が違う）</div>`,
      )
    }
    healthEl.innerHTML = lines.join('')
  }

  const reloadHealth = async (): Promise<number | null> => {
    try {
      const res = await fetch('/status', { signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const status: unknown = await res.json()
      if (signal.aborted) return null
      renderHealth(status)
      const generated = (status as { generatedAtMs?: unknown } | null)?.generatedAtMs
      return typeof generated === 'number' ? generated : null
    } catch (error) {
      if (signal.aborted) return null
      // **古い見張りの行を残さない。** 取れていない間に「見張り中」を出し続けると、止まっていても気づけない。
      healthEl.textContent = `状態を取得できていない（${error instanceof Error ? error.message : String(error)}）`
      return null
    }
  }

  /** 開いている区間の記録を、一覧にある新しい版へ揃える（押し出しでも読み返しでも、版が進んだら）。 */
  const syncDetailRecord = (): void => {
    if (detailEnvelope === null) return
    const latest = newerRecord(detailEnvelope.record, list)
    if (latest === detailEnvelope.record) return
    // 波形は同じ区間なので取り直さない（版が進んでも始まり・終わりは変わらない。`shakeEvent.ts` の `withMatch`）。
    detailEnvelope = { ...detailEnvelope, record: latest }
    drawDetail()
  }

  /**
   * 範囲を読み返して一覧へ混ぜる。**押し出しで先に届いていた新しい版を、読み返しで戻さない**（`upsertShake`）。
   * - `full`（期間を選び直した回）は、**見直した範囲の外の記録を捨て**、読み込んだ分の頭を置き直す。
   * - `older`（さらに古い記録を読む）は、続きを足して頭を下げる。
   * - `recent`（直近の読み直し）は、頭も「続きがあるか」も変えない。
   *
   * **見直した範囲は、ホストが件数で区切ったなら見終えた範囲の頭から**（`coveredFromMs`）。読めなかった記録の
   * 帳面へもこの範囲を渡す —— 範囲の頭から渡すと、読んでいない記録の目印まで「直った」として外す。
   */
  const fetchInto = async (q: TimeRange, generation: number, kind: ReadKind): Promise<void> => {
    try {
      const res = await fetch(eventsUrl(q, hideLocalEl.checked), { signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const range = readShakeRange(await res.json())
      if (signal.aborted || generation !== loadGeneration) return
      if (range === null) throw new Error('応答の形が違う')
      const covered: TimeRange = { fromMs: range.truncated ? range.coveredFromMs : q.fromMs, toMs: q.toMs }
      // 期間を選び直したら、見直した範囲の外の記録は捨てる（開いたままのタブで一覧が際限なく膨らまない）。
      let next: readonly ShakeRecordView[] =
        kind === 'full' ? list.filter((r) => r.startMs >= covered.fromMs && r.startMs < covered.toMs) : list
      for (const r of range.events) next = upsertShake(next, r)
      list = next
      unreadable = nextUnreadableBook(unreadable, range.marks, covered, kind)
      if (kind !== 'recent') {
        loadedFromMs = covered.fromMs
        olderRemain = range.truncated
      }
      loadState = nextLoadState(loadState, kind, null)
      syncDetailRecord()
    } catch (error) {
      if (signal.aborted || generation !== loadGeneration) return
      const message = `揺れの記録を取得できていない（${error instanceof Error ? error.message : String(error)}）`
      loadState = nextLoadState(loadState, kind, message)
    }
    renderRows()
  }

  /** 期間全体を読む（`fullInFlight` で、同じ世代の 2 本目を出させない）。 */
  const fetchFull = async (generation: number): Promise<void> => {
    fullInFlight = generation
    try {
      await fetchInto(periodQuery(), generation, 'full')
    } finally {
      if (fullInFlight === generation) fullInFlight = null
    }
  }

  const loadEvents = async (): Promise<void> => {
    const generation = ++loadGeneration
    // **見張りの行を待つ間から読んでいる扱いにする** —— その間に来た 30 秒ごとの読み直しが、期間全体を読みに行かない。
    fullInFlight = generation
    // 前の期間の「続きがある」を、読み直している間に押させない。
    olderRemain = false
    loadState = startPeriodLoad(loadState)
    renderRows()
    try {
      // **期間の右端はホストの時計で決める**（端末の時計は信用しない）。取れなければ端末の時計で代わりにする。
      // **世代を確かめてから書き換える** —— 遅れて返った古い回が、新しい回の基準時刻を上書きしない。
      const hostNow = await reloadHealth()
      if (signal.aborted || generation !== loadGeneration) return
      anchorMs = hostNow ?? Date.now()
      await fetchFull(generation)
    } finally {
      if (fullInFlight === generation) fullInFlight = null
    }
  }

  /** 「さらに古い記録を読む」。期間の頭から、読み込んだ分の頭までを読む（ホストはまた新しいほうから区切る）。 */
  const loadOlder = async (): Promise<void> => {
    if (!olderRemain) return
    const generation = loadGeneration
    const q: TimeRange = { fromMs: periodQuery().fromMs, toMs: loadedFromMs }
    if (!(q.fromMs < q.toMs)) {
      olderRemain = false
      renderRows()
      return
    }
    moreButtonEl.disabled = true
    try {
      await fetchInto(q, generation, 'older')
    } finally {
      moreButtonEl.disabled = false
    }
  }

  /**
   * 開いている間の読み直し（見張りの行と直近 3 時間の記録）。**押し出しが切れていても一覧が追いつく** ——
   * 押し出しだけに頼ると、切れている間に記録された揺れが一覧へ入らず、画面からも気づけない。
   * **選んだ期間に掛かる分だけ読む**（日付で過ぎた期間を選んでいれば、見張りの行だけ読み直す）。
   */
  const refreshRecent = async (): Promise<void> => {
    const generation = loadGeneration
    const hostNow = await reloadHealth()
    if (signal.aborted || generation !== loadGeneration) return
    if (hostNow !== null) anchorMs = hostNow
    // **期間をまだ一度も読めていなければ、期間全体を読み直す** —— 直近だけ読んで成功しても、期間の残りは空のまま。
    // 同じ世代で期間全体を読んでいる最中なら、その結果を待つ（2 本目を出さない）。
    if (!loadState.periodLoaded) {
      if (fullInFlight !== generation) await fetchFull(generation)
      return
    }
    const q = clipRange(recentQueryRange(anchorMs), periodQuery())
    if (q === null) return
    await fetchInto(q, generation, 'recent')
  }

  /** 日付の入力が期間として読めるときだけ「この期間を読む」を押せる。 */
  const syncApply = (): void => {
    applyEl.disabled = jstDayRange(fromDateEl.value, toDateEl.value) === null
  }

  /** 直近の日数を選んだとき、日付の入力をその期間の日付で埋める（そこから日付を動かして選び直せる）。 */
  const prefillDates = (days: number): void => {
    fromDateEl.value = jstDateOf(anchorMs - days * DAY_MS)
    toDateEl.value = jstDateOf(anchorMs)
    syncApply()
  }

  // ---- 段 2: 押した揺れの区間の波形 ----

  const drawDetail = (): void => {
    if (detailEnvelope === null) return
    const { record, envelope } = detailEnvelope
    const win = detailWindow(record)
    const span = win.toMs - win.fromMs
    const markers = detailMarkers(record, win)
    const dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
    const canvases = [...detailEl.querySelectorAll<HTMLCanvasElement>('canvas.shake-canvas')]
    const rangeLabels = [...detailEl.querySelectorAll<HTMLElement>('.shake-axis-range')]
    for (let axis = 0; axis < canvases.length; axis++) {
      const canvas = canvases[axis]
      const width = Math.max(1, Math.floor(canvas.clientWidth))
      const height = Math.max(40, Math.floor(canvas.clientHeight))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      const ctx = canvas.getContext('2d')
      if (ctx === null) continue
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      const plotHeight = height - TIME_AXIS_HEIGHT
      const mid = plotHeight / 2
      const usable = mid - PLOT_PADDING_Y
      const ink = globalThis.getComputedStyle(canvas).color
      const xOf = (atMs: number): number => ((atMs - win.fromMs) / span) * width

      // 枠と中心線。
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)'
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, 0.5, width - 1, plotHeight - 1)
      ctx.beginPath()
      ctx.moveTo(0, mid)
      ctx.lineTo(width, mid)
      ctx.stroke()

      // **縦の幅は軸ごと。** 合成波形は直流を引いた変動分なので、中心は 0。
      let deviation = 0
      for (const c of envelope.columns) {
        // **その成分の値が無い列（NaN）は飛ばす。** 混ぜると縦の幅が NaN になり、段ごと描けない。
        if (c === null || !Number.isFinite(c.min[axis]) || !Number.isFinite(c.max[axis])) continue
        deviation = Math.max(deviation, Math.abs(c.min[axis]), Math.abs(c.max[axis]))
      }
      const halfSpan = niceHalfSpanGal(deviation)
      rangeLabels[axis].textContent = `±${formatGal(halfSpan)} gal`
      const yOf = (gal: number): number => mid - Math.max(-usable, Math.min(usable, (gal / halfSpan) * usable))

      // 目盛り（始まりからの秒）。
      ctx.fillStyle = ink
      ctx.font = '10px system-ui, sans-serif'
      ctx.textBaseline = 'top'
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.25)'
      for (const t of detailTicks(win.fromMs, win.toMs, record.startMs, 8)) {
        const x = xOf(t.atMs)
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, plotHeight)
        ctx.stroke()
        ctx.textAlign = x < TIME_LABEL_MARGIN ? 'left' : x > width - TIME_LABEL_MARGIN ? 'right' : 'center'
        ctx.fillText(t.label, x, plotHeight + 2)
      }

      // 波形。**列の位置は応答の列幅から写す**（`columnSpanMs`。列数で割り直さない）。
      ctx.strokeStyle = 'rgba(37, 99, 168, 0.95)'
      ctx.beginPath()
      let started = false
      envelope.columns.forEach((c, i) => {
        if (c === null || !Number.isFinite(c.min[axis]) || !Number.isFinite(c.max[axis])) {
          // 値の無い列は繋がない。**繋ぐと、届いていない時間帯が斜めの線になる。** その成分だけ
          // 解けなかった列（観測点の合成の向きが足りない間）も同じ。
          started = false
          return
        }
        const x = xOf(envelope.fromMs + (i + 0.5) * envelope.columnSpanMs)
        if (!started) {
          ctx.moveTo(x, yOf(c.min[axis]))
          started = true
        } else {
          ctx.lineTo(x, yOf(c.min[axis]))
        }
        ctx.lineTo(x, yOf(c.max[axis]))
      })
      ctx.stroke()

      // 縦の線（始まり・終わり・S・P）。名前は一番上の段にだけ書く。
      // **近い線の名前は段をずらす。** P は始まりの 1 秒足らず後に来ることが多く、同じ高さに
      // 書くと「始まり」の文字に埋もれて読めない（実際にそうなった）。
      ctx.setLineDash([4, 3])
      ctx.strokeStyle = 'rgba(179, 38, 30, 0.85)'
      ctx.fillStyle = 'rgba(179, 38, 30, 0.95)'
      ctx.textAlign = 'left'
      const rowEnds: number[] = []
      for (const m of [...markers].sort((a, b) => a.atMs - b.atMs)) {
        const x = xOf(m.atMs)
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, plotHeight)
        ctx.stroke()
        if (axis !== 0) continue
        const labelX = Math.min(x + 2, width - 30)
        const labelWidth = ctx.measureText(m.label).width + 4
        let row = rowEnds.findIndex((end) => end <= labelX)
        if (row === -1) row = rowEnds.length
        rowEnds[row] = labelX + labelWidth
        ctx.fillText(m.label, labelX, 2 + row * 12)
      }
      ctx.setLineDash([])
    }
  }

  /** 詳細の欄を閉じた状態へ戻す（一覧は描き直さない）。 */
  const resetDetail = (): void => {
    detailController?.abort()
    detailController = null
    detailEnvelope = null
    selectedId = null
    detailEl.hidden = true
    detailEl.innerHTML = ''
  }

  const closeDetail = (): void => {
    resetDetail()
    renderRows()
  }

  const openDetail = async (record: ShakeRecordView): Promise<void> => {
    detailController?.abort()
    const controller = new AbortController()
    detailController = controller
    // **この区間の取得が終われば（押し直し・閉じる）見張りも外す** —— 行を押すたびに溜まらない。
    signal.addEventListener('abort', () => controller.abort(), { once: true, signal: controller.signal })
    selectedId = record.id
    detailEnvelope = null
    renderRows()

    detailEl.hidden = false
    detailEl.innerHTML = `
      <div class="row" style="align-items: baseline; justify-content: space-between">
        <h2 style="margin: 0">${formatShakeStart(record.startMs)} からの揺れ（${escapeHtml(record.stationId)}）</h2>
        <button type="button" class="shake-detail-close" style="flex: 0 0 auto">閉じる</button>
      </div>
      <p class="shake-detail-note muted"></p>
      ${AXIS_LABELS.map(
        (label) => `
        <div class="row" style="align-items: baseline; justify-content: space-between; margin-top: 0.6rem">
          <h3 style="margin: 0">${label}</h3>
          <span class="shake-axis-range muted"></span>
        </div>
        <canvas class="shake-canvas wave-canvas" style="cursor: default"></canvas>`,
      ).join('')}
    `
    qs(detailEl, '.shake-detail-close').addEventListener('click', closeDetail)
    const noteEl2 = qs(detailEl, '.shake-detail-note')

    const win = detailWindow(record)
    const columns = Math.max(100, Math.floor(qs<HTMLCanvasElement>(detailEl, 'canvas').clientWidth))
    try {
      const res = await fetch(wavesUrl(record.stationId, win.fromMs, win.toMs, columns), { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const envelope = readEnvelope(await res.json())
      if (controller.signal.aborted) return
      if (envelope === null) throw new Error('応答の形が違う')
      const note = detailNote(envelope)
      noteEl2.textContent = note ?? ''
      // 残っていない・読めなかったは事実の欠けなので、注意の色で出す。
      noteEl2.className = `shake-detail-note ${note === null ? 'muted' : 'error'}`
      // **取得している間に進んだ版を拾う** —— その間に届いた押し出しは、まだ開いていない扱いで差し替えられない。
      detailEnvelope = { record: newerRecord(record, list), envelope }
      drawDetail()
    } catch (error) {
      if (controller.signal.aborted) return
      noteEl2.textContent = `波形を取得できていない（${error instanceof Error ? error.message : String(error)}）`
      noteEl2.className = 'shake-detail-note error'
    }
  }

  // ---- 操作 ----

  const pressPeriodButton = (pressed: Element | null): void => {
    for (const b of container.querySelectorAll('.period-buttons button')) {
      b.setAttribute('aria-pressed', String(b === pressed))
    }
  }
  for (const button of container.querySelectorAll<HTMLButtonElement>('.period-buttons button')) {
    button.addEventListener('click', () => {
      const days = Number(button.dataset.days)
      period = { kind: 'days', days }
      pressPeriodButton(button)
      // **日付の欄は読み込みが終わってから埋める** —— 基準の時刻は読み込みの中でホストの時計へ合わせ直すので、
      // 先に埋めると問い合わせた範囲とずれる。その間に別の期間を選んでいたら埋めない。
      void loadEvents().then(() => {
        if (period.kind === 'days' && period.days === days) prefillDates(days)
      })
    })
  }
  fromDateEl.addEventListener('input', syncApply)
  toDateEl.addEventListener('input', syncApply)
  applyEl.addEventListener('click', () => {
    const range = jstDayRange(fromDateEl.value, toDateEl.value)
    if (range === null) return
    period = { kind: 'dates', range }
    // 日付で選んだら、どの日数のボタンも押していない見た目にする。
    pressPeriodButton(null)
    void loadEvents()
  })
  moreButtonEl.addEventListener('click', () => void loadOlder())
  // **隠す指定はホストへ渡して読み直す** —— 画面で隠すだけだと、区切られた 500 件の大半が隠れて数行しか残らないことがある。
  hideLocalEl.addEventListener('change', () => void loadEvents())
  rowsEl.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('tr.shake-row')
    if (row === null) return
    const record = list.find((r) => r.id === row.dataset.shakeId)
    if (record === undefined) return
    if (record.id === selectedId) closeDetail()
    else void openDetail(record)
  })
  const onResize = (): void => drawDetail()
  globalThis.addEventListener('resize', onResize)
  signal.addEventListener('abort', () => globalThis.removeEventListener('resize', onResize), { once: true })

  // 押し出し。**波形は頼まない**（揺れの記録だけなら要らない）。
  openWaveStream({
    wave: false,
    diff: null,
    residual: null,
    signal,
    onState: () => {},
    onShakeEvent: (rec) => {
      list = upsertShake(list, rec)
      // **開いている区間の記録も新しい版へ差し替える** —— S・P の線が開いた時点の古い値のまま残らない。
      syncDetailRecord()
      renderRows()
    },
    // **押し出しで読めなかった記録も同じ件数に数える。** 黙って捨てると、ホストと画面の版が
    // 食い違ったとき「揺れが記録されていない」としか見えない。
    // 理由は開発者向けのコンソールにも残す（件数だけでは何が合わなかったのか追えない）。
    onUnreadable: (count, detail) => {
      streamUnreadable = count
      console.warn('[admin] 読めない揺れの記録:', detail)
      renderRows()
    },
  })

  await loadEvents()
  if (signal.aborted) return
  prefillDates(DEFAULT_PERIOD_DAYS)
  const timer = window.setInterval(() => void refreshRecent(), RELOAD_MS)
  signal.addEventListener('abort', () => window.clearInterval(timer), { once: true })
}
