// 波形タブ。**押し出されてくる波形をその場で見る画面。**
//
// **宛先は運用者で、見るのは「機材が正しい波形を出しているか」。** 揺れたかどうかを
// 見に来る人向けのリアルタイム画面は地震ビューアー側の担当（REQUIREMENTS.md §10 が
// 宛先で分けている）。ここは据え付けの確認 —— センサーが生きているか、ノイズはどの程度か、
// 取り付けの傾きを直した効果が出ているか。
//
// **遡れるのは繋いでから受け取った分だけ。** ホストには過ぎた波形を読み返す口が無い
// （`../receiver/statusServer.ts` 冒頭）。溜め場所はブラウザの中だけで、既定は 5 分
// （`waveBuffer.ts`）。**画面にもそう書く** —— 書かないと、遡れないことが不具合に見える。
//
// **縦軸は軸ごとに「各センサーの平均」を中心に据える。** 校正を通しても重力は残るので、
// 上向き軸は 980 gal 付近が定常値（`WaveAxisStats` のコメント）。重ねて形を比べたい相手
// どうしで定常値が違うため、**中心はセンサーごと・縦の幅は軸ごとに共通**にしている。
//
// **`boardKey`・`sensorId`・観測点名を HTML へ差し込むときは `escapeHtml` を通す。**
// 前 2 つは無認証の UDP パケット由来、観測点名は運用者の自由入力（`viewStatus.ts` 冒頭が
// 言う事情と同じ）。通し忘れると、トークンを持たない攻撃者が UDP パケット 1 個で
// 管理コンソールのトークンを盗めるストアド XSS になる。

import { ago, escapeHtml, qs, receptionBadgeHtml } from './dom'
import { readFinite, readNonEmptyString } from './readJson'
import { WaveStore, keyOf } from './waveBuffer'
import type { WaveChunkView, WaveSourceKey, WaveWindow } from './waveBuffer'
import { colorForIndex, formatClock, formatGal, needsTenths, niceHalfSpanGal, timeTicks } from './wavePlot'
import { openWaveStream } from './waveStream'
import type { WaveStreamState } from './waveStream'

/** 見る時間の幅。**上限は溜め場所の長さ（`waveBuffer.ts` の既定 5 分）に合わせる。** */
const SPAN_CHOICES: readonly { readonly ms: number; readonly label: string }[] = [
  { ms: 5_000, label: '5 秒' },
  { ms: 15_000, label: '15 秒' },
  { ms: 30_000, label: '30 秒' },
  { ms: 60_000, label: '1 分' },
  { ms: 180_000, label: '3 分' },
  { ms: 300_000, label: '5 分' },
]

const DEFAULT_SPAN_MS = 30_000

/**
 * 軸の名前。
 *
 * **校正を通した後の値は共通座標（X＝東・Y＝北・Z＝上の右手系）。** ただし
 * 取り付けの向き（`rotation`）を設定していないセンサーでは、軸はセンサーの
 * 取り付けのままで、方角の意味を持たない —— そのことは添え書きで伝える。
 */
const AXIS_LABELS: readonly string[] = ['X 軸（東が ＋）', 'Y 軸（北が ＋）', 'Z 軸（上が ＋）']

/** 描き直しの間隔。**押し出しは毎秒 30 件来るが、そのたびに描く必要は無い。** */
const MIN_REDRAW_MS = 100

/** 機材の名前を引き直す間隔。**波形と違って滅多に変わらない。** */
const LABEL_RELOAD_MS = 15_000

/**
 * 開いたときに重ねて表示する本数。
 *
 * **全部は重ねない。** 実機は基板 3 枚 × センサー 3 個の 9 本で、**全部重ねると
 * 真っ黒な塊になって 1 本も読めない**（実機へ繋いで初めて分かった —— 2 本の
 * 偽データでは起きない）。基板 1 枚ぶんに当たる 3 本を既定にし、残りは
 * 一覧に並べるが印は外しておく。
 */
const DEFAULT_SHOWN_SENSORS = 3

/** 縦に取る余白（上下それぞれ・CSS ピクセル）。**枠と線が重ならないため。** */
const PLOT_PADDING_Y = 6

/** 時刻の目盛りを描く帯の高さ（CSS ピクセル）。 */
const TIME_AXIS_HEIGHT = 16

/** 端からこれより内側なら、時刻の目盛りを中央揃えで置く（外側は内へ寄せる）。 */
const TIME_LABEL_MARGIN = 28

/** センサー 1 本の、機材としての様子（`/status` から引く）。 */
interface SensorLabel {
  readonly boardKey: string
  readonly sensorId: string
  /** 割り当てた観測点の識別子。未割当なら null。**合成の行の名前をここから引く。** */
  readonly stationId: string | null
  readonly stationName: string | null
  readonly lastPacketMs: number | null
  readonly calibrationConfigured: boolean
}

interface StatusView {
  readonly generatedAtMs: number | null
  readonly sensors: readonly SensorLabel[]
  /** 押し出しの枠（`readingHub.ts` の `HubSnapshot`）。**繋げない理由の引き当てに使う。** */
  readonly stream: { readonly open: number; readonly limit: number | null } | null
}

/** `/status` から、この画面で使う欄だけを読む。 */
export function readStatus(value: unknown): StatusView {
  if (typeof value !== 'object' || value === null) return { generatedAtMs: null, sensors: [], stream: null }
  const v = value as Record<string, unknown>
  const sensors: SensorLabel[] = []
  if (Array.isArray(v.sensors)) {
    for (const raw of v.sensors) {
      if (typeof raw !== 'object' || raw === null) continue
      const s = raw as Record<string, unknown>
      const boardKey = readNonEmptyString(s.boardKey)
      const sensorId = readNonEmptyString(s.sensorId)
      if (boardKey === null || sensorId === null) continue
      const station = typeof s.station === 'object' && s.station !== null ? (s.station as Record<string, unknown>) : null
      sensors.push({
        boardKey,
        sensorId,
        stationId: station === null ? null : readNonEmptyString(station.stationId),
        stationName: station === null ? null : readNonEmptyString(station.displayName),
        lastPacketMs: readFinite(s.lastPacketMs),
        calibrationConfigured: s.calibrationConfigured === true,
      })
    }
  }
  const streamRaw = typeof v.stream === 'object' && v.stream !== null ? (v.stream as Record<string, unknown>) : null
  const subscribers = streamRaw !== null && Array.isArray(streamRaw.subscribers) ? streamRaw.subscribers.length : null
  return {
    generatedAtMs: readFinite(v.generatedAtMs),
    sensors,
    stream: subscribers === null ? null : { open: subscribers, limit: readFinite(streamRaw?.limit) },
  }
}

/**
 * 画面に出す名前。**観測点を割り当てていなければ基板とセンサーの名前で出す。**
 *
 * 観測点の合成（#315）は「観測点の名前＋合成」。**センサー単独の行と一目で
 * 見分けられること**が要る —— 同じ縦軸に重ねて描くので、どれが平均した 1 本かが
 * 分からないと据え付けの判断に使えない。
 */
function displayNameOf(source: WaveSourceKey, labels: readonly SensorLabel[]): string {
  if (source.kind === 'station') {
    const named = labels.find((l) => l.stationId === source.stationId)?.stationName
    // **引けなければ識別子をそのまま出す。** `/status` の初回取得が済むまで
     // 名前は分からないが、行そのものは先に届く。
    return named === null || named === undefined
      ? `${source.stationId}（合成）`
      : `${named}（合成）`
  }
  const found = labels.find((l) => l.boardKey === source.boardKey && l.sensorId === source.sensorId)
  const station = found?.stationName
  const raw = `${source.boardKey} / ${source.sensorId}`
  return station === null || station === undefined ? raw : `${station}（${raw}）`
}

/**
 * 混ざった本数（観測点の合成の行だけ）。
 *
 * **幅が出ていても警めの色にしない。** 実機では**正常運転でも幅が出る** ——
 * まとまり（30 サンプル）の末尾は裏付けの同じ時刻のサンプルがまだ届いておらず、
 * 実測では 28 個が 9 本・末尾 2 個が 8・7 本だった（REQUIREMENTS.md §7）。
 * ここを警め色にすると**常に警告が出ている状態**になり、#362 の本物の乱れ
 * （1〜7 本を揺れ動く）と区別が付かないまま、印そのものが信用されなくなる。
 *
 * **どこからが異常かの物差しは未設計**（#374）。だから数だけ出して、判断は
 * 見る人に委ねる —— 閾値を持たないのに色で「異常」と主張するのは、
 * 実装が持っていない判断を装うことになる。
 *
 * **数は `WaveBuffer` が数えたものをそのまま出す。** 文字列へ埋める値は
 * 数値だけなので、ここは `escapeHtml` を通さなくてよい（`stationId` のような
 * パケット由来の文字列は入らない）。
 */
function memberBadgeHtml(range: { readonly min: number; readonly max: number } | null): string {
  if (range === null) return ''
  if (range.min === range.max) return `<span class="muted">${range.min} 本</span>`
  return `<span class="muted">${range.min}〜${range.max} 本</span>`
}

const STATE_TEXT: Record<WaveStreamState, string> = {
  connecting: '接続中',
  open: '受信中',
  reconnecting: '切断（繋ぎ直している）',
  closed: '繋げない',
}

export async function initWavesView(container: HTMLElement, signal: AbortSignal): Promise<void> {
  container.innerHTML = `
    <div class="wave-error error"></div>
    <section class="panel">
      <div class="row" style="align-items: center; flex-wrap: wrap">
        <span class="wave-conn badge"></span>
        <span class="wave-received muted"></span>
      </div>
      <p class="wave-warn muted"></p>
      <div class="wave-controls">
        <label>
          <span>見る幅</span>
          <select class="wave-span">
            ${SPAN_CHOICES.map(
              (c) => `<option value="${c.ms}" ${c.ms === DEFAULT_SPAN_MS ? 'selected' : ''}>${c.label}</option>`,
            ).join('')}
          </select>
        </label>
        <label>
          <span>縦の幅</span>
          <select class="wave-scale">
            <option value="auto" selected>自動（揺れに合わせる）</option>
            <option value="1">±1 gal</option>
            <option value="10">±10 gal</option>
            <option value="100">±100 gal</option>
            <option value="1000">±1000 gal</option>
          </select>
        </label>
        <label class="wave-follow-label">
          <span>最新に追従</span>
          <input type="checkbox" class="wave-follow" checked />
        </label>
      </div>
      <input type="range" class="wave-seek" min="0" max="1000" value="1000" disabled />
      <p class="muted">
        遡れるのは、この画面を開いてから受け取った分（最大 5 分）だけ。
        ホストには過ぎた波形を読み返す口がまだ無い。
      </p>
    </section>
    <section class="panel">
      <h2>センサー</h2>
      <div class="wave-sensors"></div>
      <p class="muted">
        取り付けの向きを設定していないセンサーでは、軸はセンサーの取り付けのままで方角の意味を持たない。
      </p>
    </section>
    <div class="wave-plots">
      ${AXIS_LABELS.map(
        (label, axis) => `
        <section class="panel wave-axis" data-axis="${axis}">
          <div class="row" style="align-items: baseline; justify-content: space-between">
            <h3 style="margin: 0">${label}</h3>
            <span class="wave-axis-range muted"></span>
          </div>
          <canvas class="wave-canvas"></canvas>
        </section>`,
      ).join('')}
    </div>
  `

  const errorEl = qs(container, '.wave-error')
  const connEl = qs(container, '.wave-conn')
  const receivedEl = qs(container, '.wave-received')
  const warnEl = qs(container, '.wave-warn')
  const sensorsEl = qs(container, '.wave-sensors')
  const spanEl = qs<HTMLSelectElement>(container, '.wave-span')
  const scaleEl = qs<HTMLSelectElement>(container, '.wave-scale')
  const followEl = qs<HTMLInputElement>(container, '.wave-follow')
  const seekEl = qs<HTMLInputElement>(container, '.wave-seek')

  const store = new WaveStore()
  /** 表示するセンサー。 */
  const shown = new Set<string>()
  /**
   * これまでに何本のセンサーと出会ったか。
   *
   * **`shown` の大きさでは数えない。** 手で印を外して 2 本以下へ絞った後に新しい
   * センサーが届くと、自動で埋め直してしまう —— **絞り込んでいる最中に、まさに
   * 読めなくなる形へ戻される。**
   */
  let seenSensors = 0
  let labels: readonly SensorLabel[] = []
  let statusGeneratedAtMs: number | null = null
  let stream: StatusView['stream'] = null
  let state: WaveStreamState = 'connecting'
  let unreadable = 0
  let lastUnreadableDetail = ''
  let spanMs = DEFAULT_SPAN_MS
  /** 追従を外しているときの右端。追従中は `null`。 */
  let viewEndMs: number | null = null
  let sensorListSignature = ''
  /**
   * いま見ている窓に、時刻の当てはめが倒れた区間が入っているか。
   *
   * **警告の組み立ては 1 箇所（`renderHeader`）に寄せる。** これは窓を切り出さないと
   * 分からないので、`draw` が書いて `renderHeader` が読む形にしている ——
   * 描いた後から警告へ継ぎ足す作りにすると、継ぎ足す側が要素のクラスを壊した。
   */
  let timebaseNominal = false
  let dirty = true

  const markDirty = (): void => {
    dirty = true
  }

  // ---- 窓の決め方 ----

  /**
   * いま描く時間の範囲。
   *
   * **溜め場所の外へは出さない。** 古い側へ出ると、画面には何も無いのに
   * 「繋がっている」と出たままになり、繋がりの不調と区別が付かない。
   */
  const windowRange = (): { fromMs: number; toMs: number } | null => {
    const range = store.range()
    if (range === null) return null
    // **右端を最新より先へ出さない。** 溜まりが窓より短いとき（開いた直後がそう）に
    // 先へ出すと、波形が左端へ貼り付いて右が空白になり、**止まっているように見える。**
    // 左端は溜まりより古くてよい —— 足りないぶんが左に空くだけで、絵は嘘にならない。
    const earliestEnd = Math.min(range.fromMs + spanMs, range.toMs)
    const end = Math.min(Math.max(viewEndMs ?? range.toMs, earliestEnd), range.toMs)
    return { fromMs: end - spanMs, toMs: end }
  }

  // ---- 機材の名前（`/status`）----

  const reloadLabels = async (): Promise<void> => {
    try {
      // タブを離れたら取得そのものをやめる（応答を待つだけの往復を残さない）。
      const res = await fetch('/status', { signal })
      if (signal.aborted) return
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const status = readStatus(await res.json())
      if (signal.aborted) return
      labels = status.sensors
      statusGeneratedAtMs = status.generatedAtMs
      stream = status.stream
      errorEl.textContent = ''
      markDirty()
      renderHeader()
      renderSensorList()
    } catch (error) {
      if (signal.aborted) return
      // **波形そのものは別の口から来る。** 名前が引けないだけなら、波形の表示は続ける。
      errorEl.textContent = `機材の名前を取得できていない: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  // ---- 見出し（繋がり具合）----

  /**
   * 警告の行を書く。
   *
   * **`className` を丸ごと書き換えない。** `wave-warn` が消えて、後からこの要素を
   * 探せなくなる（実際にそう書いていて、テストが拾った）。
   */
  const setWarnings = (warnings: readonly string[]): void => {
    warnEl.classList.toggle('error', warnings.length > 0)
    warnEl.classList.toggle('muted', warnings.length === 0)
    warnEl.textContent = warnings.join(' / ')
  }

  const renderHeader = (): void => {
    // **目印のクラスを残したまま見た目を変える。** `className` を丸ごと書き換えると
    // `wave-conn` が消え、後からこの要素を探せなくなる。
    connEl.classList.toggle('ok', state === 'open')
    connEl.classList.toggle('stale', state !== 'open')
    connEl.textContent = STATE_TEXT[state]

    const range = store.range()
    const window = windowRange()
    // **いま何を見ているかを文字で出す。** 目盛りからも読めるが、追従を止めて
    // 過去へ寄せたとき「どこを見ているのか」が絵の中にしか無いのは心細い。
    receivedEl.textContent =
      range === null || window === null
        ? 'まだ波形が届いていない'
        : `表示中: ${formatClock(window.fromMs, false)} 〜 ${formatClock(window.toMs, false)}` +
          ` ／ 溜まっている範囲: ${formatClock(range.fromMs, false)} 〜 ${formatClock(range.toMs, false)}`

    const warnings: string[] = []
    if (state === 'closed') {
      // **理由はこの口からは分からない。** `EventSource` は応答の本文を読ませない
      // （`waveStream.ts`）ので、`/status` の押し出しの枠を見て言い当てる。
      const full = stream !== null && stream.limit !== null && stream.open >= stream.limit
      warnings.push(
        full
          ? `押し出しの枠が埋まっている（${stream?.open} / ${stream?.limit}）。他のタブや端末を閉じてから画面を再読込すること`
          : 'ホストの押し出しの口へ繋げない。ホストが動いていることを確かめて画面を再読込すること',
      )
    }
    if (unreadable > 0) {
      // **行動で締める。** 他の警告と体裁を揃える —— 生の理由だけ出しても、
      // 運用者には次に何をすればよいか分からない（`detail` はコンソールへ出す）。
      warnings.push(
        `読めない波形が ${unreadable} 件届いた。ホストと管理コンソールの版が食い違っている疑いがあるので、開発者へ伝えること`,
      )
      console.warn('[admin] 読めない押し出し:', lastUnreadableDetail)
    }
    if (store.rejectedSources > 0) {
      warnings.push(`受け付ける本数の上限に達し、${store.rejectedSources} 本ぶんの波形を捨てた`)
    }
    if (store.rewindCount > 0) {
      // **溜めた分が消えたことは必ず出す。** 黙っていると「開いた直後で溜まりが
      // 少ない」のと区別が付かない。
      warnings.push(
        `時刻が巻き戻ったため、溜めていた波形を ${store.rewindCount} 回捨てた（基板の入れ替えか時計の飛び）`,
      )
    }
    if (store.droppedByCountLimit > 0) {
      warnings.push(
        `届く刻みが細かく、保持できる件数の上限に達した（${store.droppedByCountLimit} 件を落とした）。遡れる長さが 5 分より短くなる`,
      )
    }
    if (timebaseNominal) {
      warnings.push('時刻の当てはめが公称値へ倒れている区間が含まれる（波形の形は正しいが、時刻の根拠は弱い）')
    }
    setWarnings(warnings)
  }

  // ---- センサーの選び方 ----

  const renderSensorList = (): void => {
    const buffers = store.buffersInOrder()
    // **並びと名前が変わったときだけ作り直す。** 毎フレーム作り直すと、
    // チェックボックスを押した指の下で要素が入れ替わる。
    const signature = buffers
      .map((b) => `${keyOf(b.source)}|${displayNameOf(b.source, labels)}`)
      .join('\u0000')
    if (signature === sensorListSignature) return
    sensorListSignature = signature

    if (buffers.length === 0) {
      sensorsEl.innerHTML = '<p class="muted">まだ波形が届いているセンサーが無い</p>'
      return
    }

    sensorsEl.innerHTML = buffers
      .map((buffer, index) => {
        const key = keyOf(buffer.source)
        // **受信バッジと校正の印はセンサー単独だけ。** 合成の行はセンサーではないので、
        // どの基板から届いたか・向きを直したかという問いが当てはまらない
        // （混ざった本数のほうを下で添える）。
        const label =
          buffer.source.kind === 'sensor'
            ? labels.find(
                (l) =>
                  buffer.source.kind === 'sensor' &&
                  l.boardKey === buffer.source.boardKey &&
                  l.sensorId === buffer.source.sensorId,
              )
            : undefined
        // **「引けなかった」を「未設定」と言い切らない。** `/status` の初回取得が
        // 済むまで、あるいは応答から落ちたセンサーでは `label` が無い —— そこで
        // 「向き未設定」と出すと、**校正済みのセンサーを未設定だと誤って伝える**。
        // 隣の受信バッジも同じときは何も言わない形にしてある。
        const calibration =
          label === undefined ? '' : label.calibrationConfigured ? '' : '<span class="muted">向き未設定</span>'
        const reception =
          statusGeneratedAtMs === null || label === undefined
            ? ''
            : `${receptionBadgeHtml(statusGeneratedAtMs, label.lastPacketMs)} ${ago(statusGeneratedAtMs, label.lastPacketMs)}`
        // **混ざった本数は合成の行にだけ添える。** 揃っていなければ幅で出すが、
        // **色は付けない**（実機は正常でも幅が出る。`memberBadgeHtml` を見ること）。
        const members = memberBadgeHtml(buffer.memberRange)
        return `
          <label class="wave-sensor">
            <input type="checkbox" class="wave-sensor-check" data-key="${escapeHtml(key)}" ${
              shown.has(key) ? 'checked' : ''
            } />
            <span class="wave-swatch" style="background: ${colorForIndex(index)}"></span>
            <span>${escapeHtml(displayNameOf(buffer.source, labels))}</span>
            ${members}
            ${reception}
            ${calibration}
          </label>`
      })
      .join('')
  }

  sensorsEl.addEventListener('change', (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    const key = target.dataset.key
    if (key === undefined) return
    if (target.checked) shown.add(key)
    else shown.delete(key)
    markDirty()
  })

  const renderSeek = (): void => {
    const range = store.range()
    const scrollable = range !== null && range.toMs - range.fromMs > spanMs
    seekEl.disabled = !scrollable || viewEndMs === null
    if (range === null || !scrollable) {
      seekEl.value = '1000'
      return
    }
    if (viewEndMs === null) {
      seekEl.value = '1000'
      return
    }
    const oldest = range.fromMs + spanMs
    const ratio = (viewEndMs - oldest) / (range.toMs - oldest)
    seekEl.value = String(Math.round(Math.min(1, Math.max(0, ratio)) * 1000))
  }

  spanEl.addEventListener('change', () => {
    const next = Number(spanEl.value)
    if (Number.isFinite(next) && next > 0) spanMs = next
    markDirty()
  })
  scaleEl.addEventListener('change', markDirty)
  followEl.addEventListener('change', () => {
    // **追従を戻すときは右端を手放す。** 持ったままだと、追従に戻しても
    // その位置に張り付く。
    viewEndMs = followEl.checked ? null : (store.range()?.toMs ?? null)
    markDirty()
  })
  seekEl.addEventListener('input', () => {
    const range = store.range()
    if (range === null) return
    const oldest = range.fromMs + spanMs
    const t = Number(seekEl.value) / 1000
    viewEndMs = oldest + (range.toMs - oldest) * (Number.isFinite(t) ? t : 1)
    markDirty()
  })

  /** 追従を外す。**スクロールやズームで掴んだ位置を保つため。** */
  const stopFollowing = (endMs: number): void => {
    if (!followEl.checked) return
    followEl.checked = false
    viewEndMs = endMs
  }

  // ---- 絵 ----

  const canvases = [...container.querySelectorAll<HTMLCanvasElement>('.wave-canvas')]
  const rangeLabels = [...container.querySelectorAll<HTMLElement>('.wave-axis-range')]

  for (const canvas of canvases) {
    canvas.addEventListener(
      'wheel',
      (event) => {
        // **ページを動かさない。** 絵の上でのホイールは時間の幅を変える操作。
        event.preventDefault()
        const range = windowRange()
        // **選択肢の段で動かす。** 連続に変えると一覧の値と食い違い、
        // **1 段ぶんに届かないホイールでは「効いていない」ようにしか見えない**
        // （実際にそう作って、ブラウザでの確認で気づいた）。段で動かせば、
        // 一覧の表示と内部の幅が離れることも無い。
        const at = SPAN_CHOICES.findIndex((c) => c.ms === spanMs)
        const from = at < 0 ? SPAN_CHOICES.findIndex((c) => c.ms === DEFAULT_SPAN_MS) : at
        const next = Math.min(SPAN_CHOICES.length - 1, Math.max(0, from + (event.deltaY > 0 ? 1 : -1)))
        spanMs = SPAN_CHOICES[next].ms
        spanEl.value = String(spanMs)
        if (range !== null) stopFollowing(range.toMs)
        markDirty()
      },
      { passive: false },
    )

    let dragFromX: number | null = null
    let dragFromEndMs = 0
    canvas.addEventListener('pointerdown', (event) => {
      const range = windowRange()
      if (range === null) return
      dragFromX = event.clientX
      dragFromEndMs = range.toMs
      stopFollowing(range.toMs)
      canvas.setPointerCapture(event.pointerId)
    })
    canvas.addEventListener('pointermove', (event) => {
      if (dragFromX === null) return
      const width = canvas.clientWidth
      if (width <= 0) return
      // 右へ引けば過去へ戻る。
      viewEndMs = dragFromEndMs - ((event.clientX - dragFromX) / width) * spanMs
      markDirty()
    })
    const endDrag = (): void => {
      dragFromX = null
    }
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)
  }

  const draw = (): void => {
    const buffers = store.buffersInOrder()
    const window = windowRange()

    const shownBuffers = buffers
      .map((buffer, index) => ({ buffer, color: colorForIndex(index), key: keyOf(buffer.source) }))
      .filter((s) => shown.has(s.key))

    const dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
    const fixed = scaleEl.value === 'auto' ? null : Number(scaleEl.value)

    // **窓の切り出しはセンサーごとに 1 回だけ。** 3 軸まとめて返るので、
    // 軸ごとに呼ぶと同じ走査を 3 度することになる。
    const columnCount = Math.max(1, Math.floor(canvases[0]?.clientWidth ?? 0))
    const windows = new Map<string, WaveWindow>()
    if (window !== null) {
      for (const s of shownBuffers) {
        windows.set(s.key, s.buffer.readWindow(window.fromMs, window.toMs, columnCount))
      }
    }

    timebaseNominal = false
    for (const w of windows.values()) if (w.timebaseNominal) timebaseNominal = true

    // **見出しは窓を切り出した後で書く。** 時刻の当てはめの警告がここで初めて分かる。
    renderHeader()
    renderSensorList()
    renderSeek()

    for (let axis = 0; axis < canvases.length; axis++) {
      const canvas = canvases[axis]
      const width = Math.max(1, Math.floor(canvas.clientWidth))
      const height = Math.max(40, Math.floor(canvas.clientHeight))
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
      }
      const ctx = canvas.getContext('2d')
      if (ctx === null) continue
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)

      const plotHeight = height - TIME_AXIS_HEIGHT
      const mid = plotHeight / 2
      const usable = mid - PLOT_PADDING_Y
      const ink = globalThis.getComputedStyle(canvas).color

      // 枠と中心線。
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)'
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, 0.5, width - 1, plotHeight - 1)
      ctx.beginPath()
      ctx.moveTo(0, mid)
      ctx.lineTo(width, mid)
      ctx.stroke()

      // 縦の幅は軸ごとに共通。**中心はセンサーごと**（重力の乗り方が違う）。
      let deviation = 0
      for (const s of shownBuffers) {
        const stats = windows.get(s.key)?.stats[axis]
        if (stats !== undefined && stats !== null && stats.maxDeviationGal > deviation) {
          deviation = stats.maxDeviationGal
        }
      }
      const halfSpan = fixed !== null && Number.isFinite(fixed) && fixed > 0 ? fixed : niceHalfSpanGal(deviation)
      // **中心の値は絵の中に描かない。** センサーごとに中心が違うので、重ねた本数ぶん
      // 数字が並ぶ —— 9 本では左上で潰れて 1 つも読めなかった（実機で確認）。
      // 1 本に絞ったときだけ数字を出し、複数なら中心の決め方だけを伝える。
      const centers = shownBuffers
        .map((s) => windows.get(s.key)?.stats[axis]?.meanGal)
        .filter((v): v is number => v !== undefined && v !== null)
      rangeLabels[axis].textContent =
        centers.length === 1
          ? `中心 ${formatGal(centers[0])} gal ／ ±${formatGal(halfSpan)} gal`
          : `±${formatGal(halfSpan)} gal（中心は各センサーの平均）`

      if (window !== null) {
        // 時刻の目盛り。
        const tenths = needsTenths(spanMs)
        ctx.fillStyle = ink
        ctx.font = '10px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.25)'
        for (const at of timeTicks(window.fromMs, window.toMs, 6)) {
          const x = ((at - window.fromMs) / spanMs) * width
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x, plotHeight)
          ctx.stroke()
          // **端の目盛りは内側へ寄せる。** 中央揃えのままだと、いちばん左の時刻が
          // 半分だけ枠の外へ出て読めない（`14:35:35` が `35:35` に見えた）。
          ctx.textAlign =
            x < TIME_LABEL_MARGIN ? 'left' : x > width - TIME_LABEL_MARGIN ? 'right' : 'center'
          ctx.fillText(formatClock(at, tenths), x, plotHeight + 2)
        }

        // 波形。
        ctx.lineWidth = 1
        for (const s of shownBuffers) {
          const w = windows.get(s.key)
          const stats = w?.stats[axis]
          if (w === undefined || stats === undefined || stats === null) continue
          const center = stats.meanGal
          const yOf = (gal: number): number =>
            mid - Math.max(-usable, Math.min(usable, ((gal - center) / halfSpan) * usable))

          ctx.strokeStyle = s.color
          ctx.beginPath()
          let started = false
          const columns = w.axes[axis]
          for (let c = 0; c < columns.length; c++) {
            const column = columns[c]
            if (column === null) {
              // 値の無い列は繋がない。**繋ぐと、届いていない時間帯が斜めの線になる。**
              started = false
              continue
            }
            // **列の位置は列数で割って幅へ写す。** 列数を 1 枚目の canvas の幅から
            // 決めて 3 軸で共有しているので、**幅が揃っている保証は無い** ——
            // `c + 0.5` をそのまま x にすると、揃わなくなった日に波形と時刻の
            // 目盛りが軸ごとに黙ってずれる。
            const x = ((c + 0.5) / columns.length) * width
            if (!started || column.gapBefore) {
              ctx.moveTo(x, yOf(column.minGal))
              started = true
            } else {
              ctx.lineTo(x, yOf(column.minGal))
            }
            ctx.lineTo(x, yOf(column.maxGal))
          }
          ctx.stroke()
        }
      } else {
        ctx.fillStyle = ink
        ctx.font = '12px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('波形を待っている', width / 2, mid)
      }
    }
  }

  // ---- 繋ぐ ----

  /**
   * 届いた 1 まとまりを溜めて、初めての出どころなら表示へ入れる。
   *
   * **センサー単独と観測点の合成で共通。** 同じことを 2 箇所へ書くと、
   * 片方だけ直したときに「合成だけ溜まらない」形で静かに食い違う。
   */
  const takeChunk = (chunk: WaveChunkView): void => {
    const key = keyOf(chunk.source)
    const known = store.get(chunk.source) !== null
    store.push(chunk)
    if (!known && store.get(chunk.source) !== null) {
      // **観測点の合成は先着枠を使わず必ず出す。** この画面で合成を見る目的は
      // 「平均した 1 本が単体より静かか」の確認（#362 の効果）なので、
      // センサー 9 本の枠に埋もれて既定で非表示だと開いた意味が無い。
      if (chunk.source.kind === 'station') {
        shown.add(key)
      } else {
        // **初めて出会ったセンサーを、先着で上限まで表示する。** 開いた直後に何も
        // 描かれない画面では確認にならないが、全部重ねると読めない（上の定数）。
        if (seenSensors < DEFAULT_SHOWN_SENSORS) shown.add(key)
        seenSensors++
      }
    }
    markDirty()
  }

  openWaveStream({
    wave: true,
    signal,
    onState: (next) => {
      state = next
      markDirty()
    },
    onWave: (chunk) => takeChunk(chunk),
    // **観測点の合成も同じ溜め場所へ入れる**（鍵が種別を持つので混ざらない）。
    onStationWave: (chunk) => takeChunk(chunk),
    onUnreadable: (count, detail) => {
      unreadable = count
      lastUnreadableDetail = detail
      markDirty()
    },
  })

  await reloadLabels()
  if (signal.aborted) return
  const labelTimer = globalThis.setInterval(() => void reloadLabels(), LABEL_RELOAD_MS)

  let lastDrawMs = 0
  let frame = 0
  let drawFailures = 0
  const tick = (nowMs: number): void => {
    if (signal.aborted) return
    // 追従中は時間が進み続けるので、常に描き直す対象になる。
    if ((dirty || followEl.checked) && nowMs - lastDrawMs >= MIN_REDRAW_MS) {
      lastDrawMs = nowMs
      dirty = false
      // **描き直しの失敗でループを止めない。** 囲わないと、次の `requestAnimationFrame`
      // へ届く前に関数が巻き戻り、**以後この輪は二度と回らない** —— しかも見出しは
      // 別の間隔（`reloadLabels`）で更新され続けるので、画面は
      // **「文字は生きているのに絵だけ数分前で凍っている」**形になる。
      // 据え付けをその場で目で見る画面で、これがいちばん避けたい壊れ方。
      try {
        draw()
      } catch (error) {
        drawFailures++
        const detail = error instanceof Error ? error.message : String(error)
        console.warn('[admin] 波形を描き直せない', error)
        // **`errorEl` へ直接書く。** 警告行は `draw` の中で組み立てているので、
        // 失敗した回はそこへ載せられない。
        errorEl.textContent = `波形を描けていない（${drawFailures} 回目）: ${detail}`
      }
    }
    frame = globalThis.requestAnimationFrame(tick)
  }
  frame = globalThis.requestAnimationFrame(tick)

  signal.addEventListener(
    'abort',
    () => {
      globalThis.clearInterval(labelTimer)
      globalThis.cancelAnimationFrame(frame)
    },
    { once: true },
  )
}
