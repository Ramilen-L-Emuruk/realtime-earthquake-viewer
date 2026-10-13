// 基板の欄の「6 面で測る」に出すものを組み立てる（REQUIREMENTS.md §16）。
//
// **計算は `boardSixFace.ts`、ここは読むことと言葉にすることだけ。** 画面（`viewBoards.ts`）に
// 文言を直書きすると、どの理由でどの文が出るかをテストで押さえられない。文言は 2026-10-10 ユーザー承認。

import { FACE_ORDER, SIX_FACE_LIMITS } from './boardSixFace'
import { axisCountMismatchProblem } from './calibrationSuggest'
import type { BoardFitWindow, BoardSixFaceFit, BoardSixFaceProgress, BoardSixFaceRefusal, CurrentPlacement, Face } from './boardSixFace'
import { readFinite, readNonEmptyString } from './readJson'
import { REST_GAP_MS } from '../receiver/restGap'
import type { AxisFormValues } from './sensorForm'

/** 1 センサーぶんの静止窓（`GET /api/rest-windows` の 1 要素）。 */
export interface SensorFitWindows {
  readonly boardKey: string
  readonly sensorId: string
  /** いまの置き方で静止し始めた時刻（ホストの時計）。いま静止していなければ `null`。 */
  readonly stillSinceMs: number | null
  /** 溜めかけの窓。波形が途絶えている・前の版のホストなら `null`。 */
  readonly pending: PendingFitWindow | null
  /** 古い順。`meanGal` の本数はそのセンサーの軸の本数（2 か 3）。 */
  readonly windows: readonly BoardFitWindow[]
}

/** 溜めかけの窓（`gravityCheck.ts` の `PendingRestWindow`）。 */
export interface PendingFitWindow {
  readonly fromMs: number
  /** ここまでの分で静止と言えるか。判定に足りなければ `null`。 */
  readonly still: boolean | null
  /** この窓の途中で波形が途切れた（静止のまま閉じても数えない）。欄が無ければ `false`。 */
  readonly voided: boolean
}

/** `GET /api/rest-windows` を読んだもの。 */
export interface RestWindowsSnapshot {
  /** 応答を作った時刻（ホストの時計）。**前の版のホストでは `null`**（秒読みを出さない）。 */
  readonly nowMs: number | null
  /** 窓の長さ（ms）。前の版のホストでは `null`。 */
  readonly windowMs: number | null
  readonly sensors: readonly SensorFitWindows[]
}

/** 数として読めない値を `null` で表す読み方を、欄が無いときの扱いと分けて読む。 */
function readOptionalFinite(value: unknown): { readonly ok: true; readonly value: number | null } | { readonly ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null }
  const n = readFinite(value)
  return n === null ? { ok: false } : { ok: true, value: n }
}

/** 溜めかけの窓を読む。欄が無ければ `null`、形が違えば読めない。 */
function readPending(value: unknown): { readonly ok: true; readonly value: PendingFitWindow | null } | { readonly ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value !== 'object') return { ok: false }
  const fromMs = readFinite((value as { fromMs?: unknown }).fromMs)
  const still = (value as { still?: unknown }).still
  // **欠けても「途切れていない」へ倒さない。** `voided` は「この窓は数えない」という印で、欠けを
  // 健全側へ読むと数えない窓を数える側へ倒れる。`pending` と同時に足した欄なので、`pending` を
  // 返すのに `voided` だけ無いホストは無い（あれば形が崩れている）。
  const voided = (value as { voided?: unknown }).voided
  if (fromMs === null || !(still === null || typeof still === 'boolean') || typeof voided !== 'boolean') return { ok: false }
  return { ok: true, value: { fromMs, still, voided } }
}

/**
 * `GET /api/rest-windows` の応答を読む。**1 か所でも形が違えば `null`**（呼ぶ側が理由を出す）。
 *
 * **崩れた要素だけ落として続けない。** センサーや窓を黙って落とすと、画面は「まだ揃っていない面が
 * ある」と出るだけで、取得そのものが壊れていることと見分けが付かない（ホストとこの画面で形が
 * ずれた日に、静止窓が無いのと同じ見た目になる）。
 *
 * **2 軸のセンサーの窓（`meanGal` が 2 本）も読む**（2026-10-10 から。基板の 6 面法と「鉛直を合わせる」は
 * 基板に載った全部の軸を一緒に解く）。1 つのセンサーに本数の違う窓が混ざっていれば崩れた応答
 * （ホストは本数が変わると覚えた窓を捨てる。`gravityCheck.ts`）。
 *
 * **欄が無いだけなら応答ごと捨てない**（ホストだけ前の版へ戻した日に、ほかの欄まで使えなくなる）。
 * `stillSinceMs` が無ければ「いま静止していない」、`fromMs` が無ければ `null`（基板の 6 面法が
 * 「ホストの版が古い疑い」と断る）と読む。`nowMs`・`windowMs`・`pending` が無ければ `null`（秒読みを
 * 出さない）。**数として読めない値は崩れた応答**として扱う。
 */
export function parseRestWindowsBody(body: unknown): RestWindowsSnapshot | null {
  if (typeof body !== 'object' || body === null) return null
  const sensors = (body as { sensors?: unknown }).sensors
  if (!Array.isArray(sensors)) return null
  const nowMs = readOptionalFinite((body as { nowMs?: unknown }).nowMs)
  const windowMs = readOptionalFinite((body as { windowMs?: unknown }).windowMs)
  if (!nowMs.ok || !windowMs.ok) return null
  if (windowMs.value !== null && !(windowMs.value > 0)) return null
  const out: SensorFitWindows[] = []
  for (const s of sensors) {
    if (typeof s !== 'object' || s === null) return null
    const boardKey = readNonEmptyString((s as { boardKey?: unknown }).boardKey)
    const sensorId = readNonEmptyString((s as { sensorId?: unknown }).sensorId)
    const rawWindows = (s as { windows?: unknown }).windows
    const still = readOptionalFinite((s as { stillSinceMs?: unknown }).stillSinceMs)
    const pending = readPending((s as { pending?: unknown }).pending)
    if (boardKey === null || sensorId === null || !Array.isArray(rawWindows) || !still.ok || !pending.ok) return null
    const windows: BoardFitWindow[] = []
    for (const w of rawWindows) {
      if (typeof w !== 'object' || w === null) return null
      const rawMean = (w as { meanGal?: unknown }).meanGal
      const sampleCount = readFinite((w as { sampleCount?: unknown }).sampleCount)
      const atMs = readFinite((w as { atMs?: unknown }).atMs)
      const fromMs = readOptionalFinite((w as { fromMs?: unknown }).fromMs)
      if (sampleCount === null || sampleCount <= 0 || atMs === null || !fromMs.ok) return null
      if (!Array.isArray(rawMean) || (rawMean.length !== 2 && rawMean.length !== 3)) return null
      const meanGal = rawMean.map(readFinite)
      if (meanGal.some((v) => v === null)) return null
      if (windows.length > 0 && windows[0]!.meanGal.length !== meanGal.length) return null
      windows.push({ fromMs: fromMs.value, atMs, sampleCount, meanGal: meanGal as number[] })
    }
    out.push({ boardKey, sensorId, stillSinceMs: still.value, pending: pending.value, windows })
  }
  return { nowMs: nowMs.value, windowMs: windowMs.value, sensors: out }
}

const FACE_LABEL: Readonly<Record<Face, string>> = {
  '+x': '＋X',
  '-x': '−X',
  '+y': '＋Y',
  '-y': '−Y',
  '+z': '＋Z',
  '-z': '−Z',
}

function formatMinPoses(minPoses: number): string {
  return Number.isFinite(minPoses) ? String(minPoses) : '—'
}

function mark(ok: boolean): string {
  return ok ? '✓' : '—'
}

/**
 * 進み具合の 4 行（2026-10-10 ユーザー承認）。**解く条件と同じ順**（`boardSixFaceProgress`）。
 *
 * ```
 * ① 同時に静止　✓
 * ② 6 面　＋X ✓　−X ✓　＋Y ✓　−Y ✓　＋Z ✓　−Z —
 * ③ 向き　7／9（あと 2 姿勢）
 * ④ 斜めの散らばり　—
 * ```
 */
export function describeProgress(p: BoardSixFaceProgress): readonly string[] {
  const faces = FACE_ORDER.map((f) => `${FACE_LABEL[f]} ${mark(p.faces[f])}`).join('　')
  const rest = p.remainingPoses > 0 ? `（あと ${formatMinPoses(p.remainingPoses)} 姿勢）` : ''
  return [
    `① 同時に静止　${mark(p.commonPose)}`,
    `② 6 面　${faces}`,
    `③ 向き　${p.poseCount}／${formatMinPoses(p.minPoses)}${rest}`,
    `④ 斜めの散らばり　${mark(p.spreadOk)}`,
  ]
}

/** 秒読みに使うホストの時計（`GET /api/rest-windows` の `nowMs`・`windowMs`）。 */
export interface HostClock {
  /** いまのホストの時刻（応答の `nowMs` に、受け取ってからの経過を足したもの）。 */
  readonly nowMs: number
  /**
   * ホストが応答を作った時刻（応答の `nowMs` そのもの）。**波形が止まったかはこちらで見る** ——
   * 応答の溜めかけの窓はこの時点のもので、推し進めた `nowMs` で見ると、ホストではとうに閉じた窓を
   * 取り直しが遅れた分だけ「閉じていない」と読んでしまう。
   */
  readonly sampledAtMs: number
  readonly windowMs: number
}

/**
 * 「いまの置き方:」の行（2026-10-10 ユーザー承認）。**前の版のホスト（時計が無い）と、センサーが
 * 1 つも無い基板なら `null`**（行を出さない）。
 *
 * `sources` は基板に載ったセンサーの、カードの並び。
 *
 * 上から順に見る。
 *
 * - 波形が届いていないセンサーがある（溜めかけの窓が無い・長さ ＋ 5 秒を過ぎても閉じていない）→
 *   「センサー s1 の波形が届いていない」。**数えたかどうかより先**
 * - 数えた → 「数えた。次の向きへ置き換えてよい」／測った向きと同じなら「数えたが、測った向きと同じ…」
 * - まだ数えていない → 1 姿勢として数えられる時刻までの秒。**溜めかけの窓が静止のまま閉じた時刻**
 *   （始まり ＋ 窓の長さ）を全部のセンサーで取り、いちばん遅いものを使う。溜めかけの窓に動きが入って
 *   いれば、その窓は静止として覚えられないので、次の窓が閉じるまで（＋ 窓の長さ）。窓の途中で波形が
 *   途切れたとき（`voided`）も同じだけ待つ。もう静止した窓が閉じているセンサーは待たない。
 */
export function describePlacement(
  current: CurrentPlacement,
  sources: readonly { readonly sensorId: string; readonly source: SensorFitWindows | null }[],
  clock: HostClock | null,
): PlacementLine | null {
  if (clock === null) return null
  const prefix = 'いまの置き方: '
  const say = (text: string, due = false): PlacementLine => ({ text: `${prefix}${text}`, due })
  // センサーが 1 つも無ければ数えるものが無い（カードを全部外した途中など）。秒読みの材料が無いまま
  // 下へ進むと「まもなく数える」に落ち、取り直しを 3 秒ごとに投げ続ける。
  if (sources.length === 0) return null
  // **波形が届いていないセンサーを、数えたかどうかより先に名指す。** 数えた直後に止まっても、止まった
  // ことのほうが先に伝えるべきこと（数えた事実は進み具合の 4 行に残る）。後に回すと、ホストが溜めかけの
  // 窓を手放す 60 秒まで「数えた。次の向きへ置き換えてよい」が出続ける。
  for (const { sensorId, source } of sources) {
    const pending = source?.pending ?? null
    if (pending === null) return say(`センサー ${sensorId} の波形が届いていない`)
    // **閉じているはずの窓がまだ閉じていなければ、波形が止まっている。** 窓は長さに届いた後の最初の
    // パケットで閉じるので、長さ ＋ 途切れの許し（5 秒）を過ぎても開いたままなら、5 秒を超えてパケットが
    // 来ていない（応答を作った時点で見る。`HostClock.sampledAtMs`）。ホストはその窓を途切れとして数えず、
    // 窓の始まりも進まないので、秒読みを出しても当たらない（過去の時刻へ落ちて「まもなく数える」と
    // 取り直しを繰り返す）。ホストが溜めかけの窓を手放すのは窓 2 つぶん経ってからなので、それまでの間も
    // ここで名指す。
    if (clock.sampledAtMs - pending.fromMs > clock.windowMs + REST_GAP_MS) return say(`センサー ${sensorId} の波形が届いていない`)
  }
  if (current === 'counted-new') return say('数えた。次の向きへ置き換えてよい')
  if (current === 'counted-same') return say('数えたが、測った向きと同じ。違う向きへ置いてください')
  let readyAtMs = Number.NEGATIVE_INFINITY
  let latestCloseMs = Number.NEGATIVE_INFINITY
  let moving = false
  for (const { source } of sources) {
    // 上で全員の溜めかけの窓があることを確かめてある。
    const pending = source!.pending!
    if (pending.still === false) moving = true
    latestCloseMs = Math.max(latestCloseMs, pending.fromMs + clock.windowMs)
    // **静止した窓がもう閉じているセンサーは待たない**（`stillSinceMs` は閉じた窓からしか立たない）。
    if (source!.stillSinceMs !== null && pending.still !== false && !pending.voided) continue
    // 動きが入った窓・途切れた窓は、静止のまま閉じても数えないので、次の窓が閉じるまで待つ。
    // **途切れただけなら「動いている」とは言わない**（動いてはいない）。
    const waits = pending.still === false || pending.voided ? 2 : 1
    readyAtMs = Math.max(readyAtMs, pending.fromMs + clock.windowMs * waits)
  }
  // **全員が「もう閉じている」のに数えていない**のは、センサーごとの静止の続きがまだ時間で重なって
  // いないとき。波形が止まったセンサーは上で名指したので、届き続けているなら境目の取り合わせでしか
  // 起きない。全員の溜めかけの窓が静止のまま閉じれば、どの続きも「いま」を跨ぐので必ず重なる。
  // そこまで待つ（材料が無いまま「まもなく数える」へ落とさない）。
  if (readyAtMs === Number.NEGATIVE_INFINITY) readyAtMs = latestCloseMs
  const seconds = Math.ceil((readyAtMs - clock.nowMs) / 1000)
  // 動いている間は、溜めかけの窓が閉じても数えられない。止めればいつ数えられるかを最短で言う。
  if (moving) return say(`動いている。いま止めれば、あと ${Math.max(1, seconds)} 秒で数える`)
  if (seconds > 0) return say(`このまま動かさなければ、あと ${seconds} 秒で 1 姿勢として数える`)
  return say('まもなく数える', true)
}

/** 「いまの置き方:」の行。 */
export interface PlacementLine {
  readonly text: string
  /** 秒読みが 0 を過ぎた（ホストへ取り直せば、数えた結果が見える）。 */
  readonly due: boolean
}

function formatGal(v: number): string {
  return v.toFixed(1)
}

/** 桁を切って書く。**丸めて 0 になった負の数は `-0.000000` ではなく `0.000000` と書く**（欄に負号だけ残さない）。 */
function fixed(v: number, digits: number): string {
  const s = v.toFixed(digits)
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s
}

/** 解が定まらなかったときの理由（押せない理由と、押した後に解けなかったときで同じ文を出す）。 */
export const SIX_FACE_DEGENERATE = '解が定まらず、計算できなかった。置き直して測り直してください'

/** ボタンを押せない理由。**押せるなら `null`。** */
export function sixFaceProblem(result: BoardSixFaceFit | BoardSixFaceRefusal): string | null {
  if (result.ok) return null
  switch (result.reason) {
    case 'no-window-start':
      return '静止窓に始まりの時刻が無い'
    case 'prior-degenerate':
      return 'カードの軸の向きが 3 方向へ散っていない。立てて付けたセンサーは、大まかな向きを先に入れてください'
    case 'no-common-pose':
      return `センサー ${result.sensorId ?? '—'} が、ほかのセンサーと同時に静止した置き方が無い`
    case 'axis-count-mismatch':
      return axisCountMismatchProblem(result.sensorId ?? '—', result.cardAxisCount, result.windowAxisCount)
    case 'missing-faces': {
      const missing = FACE_ORDER.filter((f) => !result.faces[f]).map((f) => FACE_LABEL[f])
      return `まだ揃っていない面がある: ${missing.join('・')}`
    }
    case 'too-few-poses':
      return `姿勢が足りない: ${result.poseCount}／${formatMinPoses(result.minPoses)}。6 面に加えて、斜めにも置いてください`
    case 'directions-biased':
      return '斜めの置き方が同じ向きに偏っている。違う向きに斜めに置いてください'
    case 'degenerate':
      return SIX_FACE_DEGENERATE
    case 'out-of-range':
      return `出た値が個体差の幅を超えている: 倍率 ${SIX_FACE_LIMITS.gainMin}〜${SIX_FACE_LIMITS.gainMax} 倍・ゼロ点 ±${Math.round(SIX_FACE_LIMITS.offsetMaxGal)} gal`
    case 'residual-too-large':
      return `姿勢の間で辻褄が合わない: 残差 ${result.maxResidualGal === null ? '—' : formatGal(result.maxResidualGal)} gal`
  }
}

/**
 * 取り付けの欄（センサーカードの静止窓の様子・基板の向きの欄）を描き直せなかったときの、画面上部へ出す 1 行。
 * どちらも壊れていなければ `null`。**カードと基板の向きの欄は分けて言う**（基板の欄の失敗をカードの枚数へ
 * 足すと、壊れていないカードまで壊れたように読める）。文言は 2026-10-10 ユーザー承認、語尾は 2026-10-12 に丁寧形へ直した（同日承認）。
 */
export function cardPanelFailureMessage(brokenCards: number, boardPanelBroken: boolean): string | null {
  const where =
    brokenCards > 0 && boardPanelBroken
      ? `${brokenCards} 枚のセンサーカードと基板の向きの欄`
      : brokenCards > 0
        ? `${brokenCards} 枚のセンサーカード`
        : boardPanelBroken
          ? '基板の向きの欄'
          : null
  return where === null ? null : `${where}で取り付けの診断を出せない。画面を再読み込みしてください`
}

/** 静止した窓を取れなかったときの理由。 */
export function restWindowsFetchProblem(reason: string): string {
  return `静止した窓を取得できない: ${reason}`
}

/**
 * カードへ入れる値と、入れた後に出す文。**並びは当てはめに渡したカードの並び**（センサー ID ではなく
 * 並びで書く —— 同じ ID のカードが 2 枚あっても、計算したカードへ書く）。
 *
 * **桁は読める範囲で切る。** ゼロ点は 0.01 gal（静止窓の平均のぶれ 0.03 gal と同じ桁）、向きの成分は
 * 10⁻⁶（1 g に対して 0.001 gal）。
 */
export function sixFaceApplied(fit: BoardSixFaceFit): {
  readonly sensors: readonly (readonly AxisFormValues[])[]
  readonly note: string
} {
  const sensors = fit.sensors.map((s) =>
    s.axes.map((a) => ({
      vector: [fixed(a.vector[0], 6), fixed(a.vector[1], 6), fixed(a.vector[2], 6)] as const,
      offset: fixed(a.offset, 2),
    })),
  )
  const check = fit.maxResidualGal === null ? '検算なし' : `残差 ${formatGal(fit.maxResidualGal)} gal`
  return {
    sensors,
    note: `全部のセンサーの軸の向き・倍率・ゼロ点を入れた。姿勢 ${fit.poseCount}・${check}。保存するまで効かない。保存したら元の場所へ据え直し、「鉛直を合わせる」を押してください`,
  }
}
