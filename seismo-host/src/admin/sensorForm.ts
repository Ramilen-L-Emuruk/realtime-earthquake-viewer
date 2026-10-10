// センサー1個分の校正値フォーム（カード）と、基板の向きの欄。文字列⇔`SensorEntry`・基板の向きの
// 変換と、HTML 生成・DOM 読み取りをここへ集約する。`viewBoards.ts` からは分離し、変換ロジック
// （DOM 非依存）だけを取り出してユニットテストしやすくする。
//
// **校正の形は `stationConfigTypes.ts` の冒頭。** センサーは軸ごとに「基板の座標で測る向き
// （長さが倍率）」と「ゼロ点」を持ち、地面に対する向き（鉛直・方角）は基板に 1 つだけ持つ。

import { restWindowProblem, tiltDegFromUp } from './calibrationSuggest'
import type { SensorRestWindow } from './detectedBoards'
import { ago, escapeHtml, qs } from './dom'
import { axesAreIndependent } from '../receiver/calibration'
import { isProperRotation } from '../receiver/matrix3'
import {
  defaultAxes,
  IDENTITY_MATRIX,
  type AxisCalibration,
  type AxisCount,
  type Mat3,
  type SensorEntry,
  type Vec3,
} from '../receiver/stationConfigTypes'

type Vec3Strings = readonly [string, string, string]

/** 軸 1 本ぶんの入力欄の生の文字列。 */
export interface AxisFormValues {
  readonly vector: Vec3Strings
  readonly offset: string
}

/** フォームの各入力欄の生の文字列値。数値へ変換する前の状態。 */
export interface SensorFormValues {
  readonly sensorId: string
  readonly enabled: boolean
  /** 軸ごとの欄。**本数がそのセンサーの軸の本数**（2 か 3）。 */
  readonly axes: readonly AxisFormValues[]
  /** 空文字列なら「未設定（null）」を表す。 */
  readonly noiseDensity: string
}

export type ParseSensorFormResult =
  | { readonly ok: true; readonly sensor: SensorEntry }
  | { readonly ok: false; readonly error: string }

function vec3ToStrings(v: Vec3): Vec3Strings {
  return [String(v[0]), String(v[1]), String(v[2])]
}

function axesToStrings(axes: readonly AxisCalibration[]): AxisFormValues[] {
  return axes.map((a) => ({ vector: vec3ToStrings(a.vector), offset: String(a.offset) }))
}

/** 新規追加センサーの既定値（補正なしの軸を文字列化しただけ）。 */
export function emptySensorFormValues(axisCount: AxisCount = 3): SensorFormValues {
  return { sensorId: '', enabled: true, axes: axesToStrings(defaultAxes(axisCount)), noiseDensity: '' }
}

export function sensorToFormValues(sensor: SensorEntry): SensorFormValues {
  return {
    sensorId: sensor.sensorId,
    enabled: sensor.enabled,
    axes: axesToStrings(sensor.axes),
    noiseDensity: sensor.noiseDensity === null ? '' : String(sensor.noiseDensity),
  }
}

/** 数値として読めるかだけを見る。空文字列は「未入力」として別扱いする呼び出し側に任せる。 */
function parseFiniteNumber(text: string, fieldLabel: string): number | { readonly error: string } {
  const value = Number(text)
  if (text.trim().length === 0 || !Number.isFinite(value)) {
    return { error: `${fieldLabel}が数値として読めない: "${text}"` }
  }
  return value
}

function parseVec3(values: Vec3Strings, fieldLabel: string): Vec3 | { readonly error: string } {
  const out: number[] = []
  for (const v of values) {
    const parsed = parseFiniteNumber(v, fieldLabel)
    if (typeof parsed !== 'number') return parsed
    out.push(parsed)
  }
  return [out[0]!, out[1]!, out[2]!]
}

/**
 * フォームの生文字列を `SensorEntry` へ変換する。**検証はホストと同じ線まで** —— 軸の本数（2 か 3）と、
 * 測る向きが解ける形か（3 本なら 1 つの面に寄っていない・2 本なら平行でない）。保存して初めて
 * 「不正」と言われるより、ここで言うほうが早い。向きの値そのものの妥当性（実際に取り付けた
 * 向きと合っているか）はどちらも検証できない —— 運用者が実測して入れる値なので。
 */
export function parseSensorFormValues(values: SensorFormValues): ParseSensorFormResult {
  const sensorId = values.sensorId.trim()
  if (sensorId.length === 0) return { ok: false, error: 'センサー ID を入力すること' }
  if (values.axes.length !== 2 && values.axes.length !== 3) {
    return { ok: false, error: `軸の欄が ${values.axes.length} 本ある（2 か 3）` }
  }

  const axes: AxisCalibration[] = []
  for (const [i, a] of values.axes.entries()) {
    const vector = parseVec3(a.vector, `軸 ${i + 1} の向き`)
    if ('error' in vector) return { ok: false, error: vector.error }
    const offset = parseFiniteNumber(a.offset, `軸 ${i + 1} のゼロ点`)
    if (typeof offset !== 'number') return { ok: false, error: offset.error }
    axes.push({ vector, offset })
  }
  if (!axesAreIndependent(axes.map((a) => a.vector))) {
    return {
      ok: false,
      error: axes.length === 3 ? '3 本の軸の向きが 1 つの面に寄っていて解けない' : '2 本の軸の向きが平行で解けない',
    }
  }

  let noiseDensity: number | null = null
  if (values.noiseDensity.trim().length > 0) {
    const parsed = parseFiniteNumber(values.noiseDensity, 'ノイズ密度')
    if (typeof parsed !== 'number') return { ok: false, error: parsed.error }
    if (parsed < 0) return { ok: false, error: 'ノイズ密度は 0 以上にすること' }
    noiseDensity = parsed
  }

  return { ok: true, sensor: { sensorId, enabled: values.enabled, axes, noiseDensity } }
}

/** 軸ごとの欄。**行の数が軸の本数**（読み取りもこの行を数える）。 */
function axesGridHtml(axes: readonly AxisFormValues[]): string {
  // **左上の角は `.muted` にしない。** `.muted:empty` は場所を取らない（`index.html`）ので、空の
  // 見出しが消えて以降のセルが 1 つずつ前へずれ、行の名前が右端の列へ回る。
  const head = `<span></span>${['向き X', '向き Y', '向き Z', 'ゼロ点（gal）'].map((h) => `<span class="muted">${h}</span>`).join('')}`
  const rows = axes
    .map(
      (a, axis) => `
        <span class="axis-label">軸 ${axis + 1}</span>
        ${a.vector
          .map(
            (v, comp) =>
              `<input class="s-axis-vector" data-axis="${axis}" data-comp="${comp}" type="number" step="any" value="${escapeHtml(v)}" />`,
          )
          .join('')}
        <input class="s-axis-offset" data-axis="${axis}" type="number" step="any" value="${escapeHtml(a.offset)}" />`,
    )
    .join('')
  return `<div class="axis-grid">${head}${rows}</div>`
}

/**
 * センサー ID の入力候補（`<datalist>`）の id。
 *
 * **中身を用意するのは `viewBoards.ts`。** いまフォームに入っている基板が
 * `/status` で名乗っているセンサー ID を入れる——カード側は id を指すだけで、
 * どの基板のものかを知らない（カードは基板をまたいで同じ形で使う）。
 *
 * **候補が無くても入力できる形にする（`<select>` にしない）。** 基板は電源が
 * 入って送り始めるまで `/status` に現れないので、現地へ行く前に設定を用意して
 * おく運用が潰れる。
 */
export const SENSOR_ID_DATALIST_ID = 'detected-sensor-ids'


/** センサー 1 個ぶんのカード HTML。**値は必ず `escapeHtml` を通す**——`sensorId` は運用者の自由入力。 */
export function renderSensorCardHtml(values: SensorFormValues): string {
  return `
    <div class="sensor-card">
      <div class="row">
        <label style="flex: 2">センサー ID
          <input class="s-sensorId" list="${SENSOR_ID_DATALIST_ID}" value="${escapeHtml(values.sensorId)}" required />
        </label>
        <label style="flex: 0 0 auto; white-space: nowrap;">有効
          <span style="display: flex; align-items: center; height: 2.1rem;">
            <input class="s-enabled" type="checkbox" ${values.enabled ? 'checked' : ''} />
          </span>
        </label>
        <button type="button" class="link danger remove-sensor" style="align-self: end; height: 2.1rem;">削除</button>
      </div>
      <!-- **単位は gal（cm/s²）。** \`calibration.ts\` が \`gal - offset\` の形で、換算済みの
           gal 値から直接引く。m/s² と書くと運用者が 100 倍ずれた値を入れ、保存時の検証
           （数値として読めるかしか見ない）も素通りする。 -->
      <div class="muted" style="font-size: 0.8rem; margin-top: 0.3rem;">軸ごとの校正（基板の座標）</div>
      <div class="muted" style="font-size: 0.75rem;">向き：その軸が基板のどの向きを測るか。長さが倍率（1 gal の揺れで何 gal 読むか）</div>
      <div class="muted" style="font-size: 0.75rem;">ゼロ点：揺れていないときに読む値</div>
      ${axesGridHtml(values.axes)}
      <!-- **静止窓の診断は畳まない。** 傾いて付いているという事実は、詳細設定を
           開いた人にしか見えないと気づかれない。中身は viewBoards が埋める。 -->
      <div class="muted s-rest-note" style="font-size: 0.8rem; margin-top: 0.5rem;"></div>
      <details>
        <summary>詳細設定</summary>
        <label style="margin-top: 0.6rem;">ノイズ密度（µg/√Hz・任意）
          <input class="s-noiseDensity" type="number" step="any" min="0" value="${escapeHtml(values.noiseDensity)}" />
        </label>
      </details>
    </div>`
}

/**
 * 方角の欄を読む。**空欄は `null`（方角に触らない）で、これは誤りではない。**
 *
 * 重力から方角は決まらないので、分からないまま既定値で回すと、合っていた方角を
 * 黙って崩す（`calibrationSuggest.ts` 冒頭）。**空欄を 0 へ倒さないこと。**
 */
export function parseHeadingText(text: string): number | null | { readonly error: string } {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { error: `方角が数値として読めない: "${text}"` }
  return value
}

/** gal を小数 1 桁で出す。**実機のばらつきが 1.4 gal 前後**なので、これ以上細かくしない。 */
function gal(value: number | null): string {
  return value === null ? '不明' : `${value.toFixed(1)} gal`
}

/**
 * センサーカードへ出す、静止窓の一行。**判定が無くても必ず何か出す。**
 *
 * **「まだ出ていない」と「出たが使えない」を書き分ける。** 混ぜると、待てば出るのか
 * 何か直さないと出ないのかが読めない。
 */
export function restWindowNote(window: SensorRestWindow | null, nowMs: number | null): string {
  // **この一行は、保存済みの設定で見たホストの診断**（`/status` の判定）。「鉛直を合わせる」が
  // 押せるかどうかは別の材料（校正前の静止窓）で決まる（`viewBoards.ts` の `refreshTiltPanel`）。
  if (window === null) return restWindowProblem(null) ?? ''
  // **経過の基準が無ければ黙って受け手の時計へ倒さない**（`detectedBoards.ts` の
  // `generatedAtMs`）。時刻だけを省く。
  const when = nowMs === null ? '' : `・${ago(nowMs, window.atMs)}`
  const restless = window.restless
    ? '／静止しているのに計測震度が高い（震度を出す側の配線を確かめること）'
    : ''

  const problem = restWindowProblem(window)
  if (problem !== null) {
    // **読めなかった窓に「重力 不明・ばらつき 不明」を足さない。** サンプル不足と
    // 読み取り不能では必ず両方 `null` になる（`gravityCheck.ts` の `settle`）ので、
    // 機械的に並べると理由の後ろへ「不明」だけが毎回付く。
    const measured =
      window.meanGal === null && window.sdGal === null
        ? when.replace(/^・/, '')
        : `重力 ${gal(window.meanGal)}・ばらつき ${gal(window.sdGal)}${when}`
    return `${problem}${measured.length > 0 ? `（${measured}）` : ''}${restless}`
  }
  const tilt = tiltDegFromUp(window.axisMeanGal)
  // **`restWindowProblem` を通った窓は傾きが出るはず**だが、判定の元は `scale` で
  // 傾きの計算は別の式なので、出なかった場合に黙らない。
  const tiltText = tilt === null ? '傾きを出せない' : `取り付けの傾き ${tilt}°`
  return `${tiltText}（重力 ${gal(window.meanGal)}・ばらつき ${gal(window.sdGal)}${when}）${restless}`
}

/** カードの軸ごとの欄の本数（行の数）。 */
function axisCountOf(card: ParentNode): number {
  return card.querySelectorAll('.s-axis-offset').length
}

/**
 * カードの軸ごとの欄を書き換える（6 面法の結果を入れる）。**保存はしない。**
 *
 * **`readSensorCardValues` と対になる。** 読むほうと同じセレクタをここでも使う ——
 * 片方だけ変えると、提案した値が黙ってどこにも入らない。本数が欄と違えば投げる。
 */
export function writeSensorCardAxes(card: ParentNode, axes: readonly AxisFormValues[]): void {
  if (axes.length !== axisCountOf(card)) {
    throw new Error(`軸の欄 ${axisCountOf(card)} 本へ ${axes.length} 本ぶんを書こうとした`)
  }
  for (const [axis, a] of axes.entries()) {
    for (let comp = 0; comp < 3; comp++) {
      qs<HTMLInputElement>(card, `.s-axis-vector[data-axis="${axis}"][data-comp="${comp}"]`).value = a.vector[comp]!
    }
    qs<HTMLInputElement>(card, `.s-axis-offset[data-axis="${axis}"]`).value = a.offset
  }
}

/**
 * `renderSensorCardHtml` で作ったカード要素からフォーム値を読み取る。
 *
 * **全フィールドを `qs()`（見つからなければ投げる。`dom.ts` 参照）経由で読む。**
 * `?? ''`・`?? false` によるフォールバックだと、「運用者が本当に未入力・
 * 未チェックにした」場合と「セレクタが `renderSensorCardHtml` の生成する
 * DOM 構造とずれて要素そのものが見つからない」場合が同じ値になり、後者が
 * 無言で保存されてしまう——`enabled: false` はそのセンサーを震度計算から
 * 丸ごと除外し、`noiseDensity` の欠落は複数センサー合成の重み（1 台でも欠ければ単純平均）に影響する
 * ため、どちらも気づけないまま挙動が変わるのは避ける（敵対的レビューで検出）。
 * **軸の本数はゼロ点の欄の数で決める**（向きの欄は軸ごとに `qs()` で 3 つとも読む）。
 */
export function readSensorCardValues(card: ParentNode): SensorFormValues {
  const text = (selector: string): string => qs<HTMLInputElement>(card, selector).value
  const axes: AxisFormValues[] = []
  for (let axis = 0; axis < axisCountOf(card); axis++) {
    const comp = (c: number): string => text(`.s-axis-vector[data-axis="${axis}"][data-comp="${c}"]`)
    axes.push({ vector: [comp(0), comp(1), comp(2)], offset: text(`.s-axis-offset[data-axis="${axis}"]`) })
  }
  return {
    sensorId: text('.s-sensorId'),
    enabled: qs<HTMLInputElement>(card, '.s-enabled').checked,
    axes,
    noiseDensity: text('.s-noiseDensity'),
  }
}

// ---------------------------------------------------------------------------
// 基板の向き

/** 基板の向きの欄（3x3）の生の文字列。**行優先**（`[r0c0, r0c1, r0c2, r1c0, ...]`）。 */
export type OrientationFormValues = readonly [
  string, string, string,
  string, string, string,
  string, string, string,
]

export function orientationToFormValues(m: Mat3 = IDENTITY_MATRIX): OrientationFormValues {
  return [
    String(m[0][0]), String(m[0][1]), String(m[0][2]),
    String(m[1][0]), String(m[1][1]), String(m[1][2]),
    String(m[2][0]), String(m[2][1]), String(m[2][2]),
  ]
}

/** 基板の向きの欄を読む。**純粋な回転でなければ理由を返す**（ホストの検証と同じ線）。 */
export function parseOrientationFormValues(values: OrientationFormValues): Mat3 | { readonly error: string } {
  const n: number[] = []
  for (const v of values) {
    const parsed = parseFiniteNumber(v, '基板の向き')
    if (typeof parsed !== 'number') return parsed
    n.push(parsed)
  }
  const m: Mat3 = [
    [n[0]!, n[1]!, n[2]!],
    [n[3]!, n[4]!, n[5]!],
    [n[6]!, n[7]!, n[8]!],
  ]
  if (!isProperRotation(m)) return { error: '基板の向きが純粋な回転になっていない（列の長さ 1・互いに直交・右手系）' }
  return m
}

/**
 * 基板の向きの欄の HTML。**方角と「鉛直を合わせる」を上に、3x3 は詳細設定へ畳む**
 * （手で入れる値ではなく、ボタンが入れる値なので）。結果と押せない理由は `viewBoards` が埋める。
 */
export function renderOrientationHtml(values: OrientationFormValues): string {
  const cells: string[] = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      cells.push(
        `<input class="b-orientation" data-row="${row}" data-col="${col}" type="number" step="any" value="${escapeHtml(values[row * 3 + col]!)}" />`,
      )
    }
  }
  return `
    <div class="board-orientation">
      <h3>基板の向き</h3>
      <!-- **6 面法は基板に 1 つ**（2026-10-10 ユーザー承認。前はセンサーカードごとにあった）。基板に載った
           全部のセンサーの軸を一緒に解き、結果は各カードの軸の欄へ入る。**鉛直合わせより先に置く** ——
           ゼロ点を入れる前に出した傾きはずれを抱え込む。文言は 2026-10-10 ユーザー承認。中身（揃い具合・
           押せない理由・結果）は viewBoards が埋める。 -->
      <div class="b-sixface" style="font-size: 0.8rem; margin-bottom: 0.6rem;">
        <div>6 面で測る（基板に載った全部のセンサー）</div>
        <div class="muted">基板を X・Y・Z の上向き・下向きの 6 方向へ置き、それぞれ 1 分以上動かさない。姿勢が足りなければ、斜めにも置く。X・Y は 1 個目のセンサーの 1 本目・2 本目の軸。直近 30 分の静止した時間から計算する</div>
        <div class="b-sixface-faces" style="margin-top: 0.2rem;"></div>
        <div class="row" style="align-items: center; margin-top: 0.2rem;">
          <button type="button" class="apply-sixface" style="flex: 0 0 auto;" disabled>6 面の結果を入れる</button>
          <span class="muted b-sixface-why"></span>
        </div>
        <div class="muted b-sixface-result"></div>
      </div>
      <!-- **方角は手で入れる。** 重力は鉛直まわりの回転について何も語らないので、
           自動では決まらない（REQUIREMENTS.md §16）。空のままなら水平面は回さない。
           **「向いている」ではなく「向ける」。** 入れるのは向かせたい方角で、実際に
           回るのはいまの向きとの差だけ —— 同じ値を入れ直しても動かない。
           **「X 軸」は基板の X 軸**（センサーの軸ごとの向きを測る座標と同じ）。 -->
      <div class="row">
        <label style="flex: 1">X 軸を向ける方角（度・任意）
          <input class="b-heading" type="number" step="any" placeholder="北=0・東=90・南=180・西=270" />
        </label>
        <button type="button" class="suggest-tilt" style="align-self: end; height: 2.1rem;" disabled>鉛直を合わせる</button>
      </div>
      <div class="muted b-tilt-result" style="font-size: 0.8rem;"></div>
      <details>
        <summary>詳細設定</summary>
        <div class="muted" style="font-size: 0.8rem; margin-bottom: 0.3rem;">基板の向き（列が基板の X・Y・Z 軸。東・北・上の成分）</div>
        <div class="mat3-grid">${cells.join('')}</div>
      </details>
    </div>`
}

/** 基板の向きの欄を読む。**`renderOrientationHtml` と同じセレクタ。** */
export function readOrientationValues(root: ParentNode): OrientationFormValues {
  const at = (row: number, col: number): string =>
    qs<HTMLInputElement>(root, `.b-orientation[data-row="${row}"][data-col="${col}"]`).value
  return [at(0, 0), at(0, 1), at(0, 2), at(1, 0), at(1, 1), at(1, 2), at(2, 0), at(2, 1), at(2, 2)]
}

/** 基板の向きの欄へ書き込む（「鉛直を合わせる」の結果）。**保存はしない。** */
export function writeOrientationValues(root: ParentNode, m: Mat3): void {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      qs<HTMLInputElement>(root, `.b-orientation[data-row="${row}"][data-col="${col}"]`).value = String(m[row]![col])
    }
  }
}
