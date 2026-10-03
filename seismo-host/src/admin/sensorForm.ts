// センサー1個分の校正値フォーム（カード）。文字列⇔`SensorEntry` の変換と、
// カードの HTML 生成・DOM 読み取りをここへ集約する。`viewBoards.ts` からは
// 分離し、変換ロジック（DOM 非依存）だけを取り出してユニットテストしやすくする。

import { restWindowProblem, tiltDegFromUp } from './calibrationSuggest'
import type { SensorRestWindow } from './detectedBoards'
import { ago, escapeHtml, qs } from './dom'
import {
  DEFAULT_SENSOR_CALIBRATION,
  type Mat3,
  type SensorEntry,
  type Vec3,
} from '../receiver/stationConfigTypes'

/** フォームの各入力欄の生の文字列値。数値へ変換する前の状態。 */
export interface SensorFormValues {
  readonly sensorId: string
  readonly enabled: boolean
  readonly offset: readonly [string, string, string]
  readonly sensitivity: readonly [string, string, string]
  /** 行優先（row-major）。`[r0c0, r0c1, r0c2, r1c0, ...]`。 */
  readonly rotation: readonly [
    string, string, string,
    string, string, string,
    string, string, string,
  ]
  /** 空文字列なら「未設定（null）」を表す。 */
  readonly noiseDensity: string
}

export type ParseSensorFormResult =
  | { readonly ok: true; readonly sensor: SensorEntry }
  | { readonly ok: false; readonly error: string }

function vec3ToStrings(v: Vec3): readonly [string, string, string] {
  return [String(v[0]), String(v[1]), String(v[2])]
}

function mat3ToStrings(m: Mat3): SensorFormValues['rotation'] {
  return [
    String(m[0][0]), String(m[0][1]), String(m[0][2]),
    String(m[1][0]), String(m[1][1]), String(m[1][2]),
    String(m[2][0]), String(m[2][1]), String(m[2][2]),
  ]
}

/** 新規追加センサーの既定値（`DEFAULT_SENSOR_CALIBRATION` を文字列化しただけ）。 */
export function emptySensorFormValues(): SensorFormValues {
  return {
    sensorId: '',
    enabled: DEFAULT_SENSOR_CALIBRATION.enabled,
    offset: vec3ToStrings(DEFAULT_SENSOR_CALIBRATION.offset),
    sensitivity: vec3ToStrings(DEFAULT_SENSOR_CALIBRATION.sensitivity),
    rotation: mat3ToStrings(DEFAULT_SENSOR_CALIBRATION.rotation),
    noiseDensity: '',
  }
}

export function sensorToFormValues(sensor: SensorEntry): SensorFormValues {
  return {
    sensorId: sensor.sensorId,
    enabled: sensor.enabled,
    offset: vec3ToStrings(sensor.offset),
    sensitivity: vec3ToStrings(sensor.sensitivity),
    rotation: mat3ToStrings(sensor.rotation),
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

function parseVec3(
  values: readonly [string, string, string],
  fieldLabel: string,
): Vec3 | { readonly error: string } {
  const x = parseFiniteNumber(values[0], fieldLabel)
  if (typeof x !== 'number') return x
  const y = parseFiniteNumber(values[1], fieldLabel)
  if (typeof y !== 'number') return y
  const z = parseFiniteNumber(values[2], fieldLabel)
  if (typeof z !== 'number') return z
  return [x, y, z]
}

function parseMat3(values: SensorFormValues['rotation']): Mat3 | { readonly error: string } {
  const n: number[] = []
  for (const v of values) {
    const parsed = parseFiniteNumber(v, '回転行列')
    if (typeof parsed !== 'number') return parsed
    n.push(parsed)
  }
  return [
    [n[0], n[1], n[2]],
    [n[3], n[4], n[5]],
    [n[6], n[7], n[8]],
  ]
}

/**
 * フォームの生文字列を `SensorEntry` へ変換する。**検証は最小限**——`sensitivity`
 * は「必ず正」（`stationConfigTypes.ts` の `SensorCalibration` コメント参照。
 * 0 や負は軸を殺す・反転するので `enabled` と役割が重複する）だけを弾く。
 * `offset`・`rotation` の値そのものの妥当性（実際に取り付けた向きと合っているか）
 * はサーバー側もここも検証できない——運用者が実測して入れる値なので。
 */
export function parseSensorFormValues(values: SensorFormValues): ParseSensorFormResult {
  const sensorId = values.sensorId.trim()
  if (sensorId.length === 0) return { ok: false, error: 'センサー ID を入力すること' }

  const offset = parseVec3(values.offset, 'オフセット')
  if ('error' in offset) return { ok: false, error: offset.error }

  const sensitivity = parseVec3(values.sensitivity, '感度')
  if ('error' in sensitivity) return { ok: false, error: sensitivity.error }
  if (sensitivity.some((v) => v <= 0)) {
    return { ok: false, error: '感度は正の値にすること' }
  }

  const rotation = parseMat3(values.rotation)
  if ('error' in rotation) return { ok: false, error: rotation.error }

  let noiseDensity: number | null = null
  if (values.noiseDensity.trim().length > 0) {
    const parsed = parseFiniteNumber(values.noiseDensity, 'ノイズ密度')
    if (typeof parsed !== 'number') return { ok: false, error: parsed.error }
    if (parsed < 0) return { ok: false, error: 'ノイズ密度は 0 以上にすること' }
    noiseDensity = parsed
  }

  return {
    ok: true,
    sensor: { sensorId, enabled: values.enabled, offset, sensitivity, rotation, noiseDensity },
  }
}

const VEC3_AXIS_LABELS = ['X', 'Y', 'Z'] as const

function vec3RowHtml(namePrefix: string, values: readonly [string, string, string]): string {
  return `
    <div class="vec3-row">
      ${VEC3_AXIS_LABELS.map(
        (axis, i) => `
          <label>${axis}
            <input class="${namePrefix}" data-axis="${i}" type="number" step="any" value="${escapeHtml(values[i])}" />
          </label>`,
      ).join('')}
    </div>`
}

function mat3GridHtml(values: SensorFormValues['rotation']): string {
  const cells: string[] = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const i = row * 3 + col
      cells.push(
        `<input class="s-rotation" data-row="${row}" data-col="${col}" type="number" step="any" value="${escapeHtml(values[i])}" />`,
      )
    }
  }
  return `<div class="mat3-grid">${cells.join('')}</div>`
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
      <div class="muted" style="font-size: 0.8rem; margin-top: 0.3rem;">オフセット（gal）</div>
      ${vec3RowHtml('s-offset', values.offset)}
      <div class="muted" style="font-size: 0.8rem; margin-top: 0.5rem;">感度（倍率・正）</div>
      ${vec3RowHtml('s-sensitivity', values.sensitivity)}
      <!-- **6 面法はオフセット・感度のすぐ下に置く。** 結果を入れる先がこの 2 欄なので、
           離すと何が書き換わったのか追えない。詳細設定へ畳むと、面の揃い具合が見えない。
           中身（揃った面・押せない理由・結果）は viewBoards が埋める。 -->
      <div class="s-sixface" style="font-size: 0.8rem; margin-top: 0.5rem;">
        <div class="muted">6 面で測る：基板を各軸の上向き・下向きの 6 方向へ置き、それぞれ 1 分以上動かさない。直近 30 分の静止した時間から計算する</div>
        <div class="s-sixface-faces" style="margin-top: 0.2rem;"></div>
        <div class="row" style="align-items: center; margin-top: 0.2rem;">
          <button type="button" class="apply-sixface" style="flex: 0 0 auto;" disabled>6 面の結果を入れる</button>
          <span class="muted s-sixface-why"></span>
        </div>
        <div class="muted s-sixface-result"></div>
      </div>
      <!-- **静止窓の診断は畳まない。** 傾いて付いているという事実は、詳細設定を
           開いた人にしか見えないと気づかれない。中身は viewBoards が埋める。 -->
      <div class="muted s-rest-note" style="font-size: 0.8rem; margin-top: 0.5rem;"></div>
      <details>
        <summary>詳細設定</summary>
        <div class="muted" style="font-size: 0.8rem; margin-bottom: 0.3rem;">回転行列（取り付け向きの補正）</div>
        ${mat3GridHtml(values.rotation)}
        <!-- **方角は手で入れる。** 重力は鉛直まわりの回転について何も語らないので、
             自動では決まらない（REQUIREMENTS.md §16）。空のままなら水平面は回さない。
             **「向いている」ではなく「向ける」。** 入れるのは向かせたい方角で、実際に
             回るのはいまの向きとの差だけ —— 同じ値を入れ直しても動かない。
             **「X 軸」と呼ぶ。** センサーの 1 本目の軸のことで、このカードの
             オフセット・感度の X 欄と同じもの —— 画面の中で辿れる名前にする
             （回転行列のグリッドには行や列の見出しが無い）。 -->
        <div class="row" style="margin-top: 0.6rem;">
          <label style="flex: 1">X 軸を向ける方角（度・任意）
            <input class="s-heading" type="number" step="any" placeholder="北=0・東=90・南=180・西=270" />
          </label>
          <button type="button" class="suggest-tilt" style="align-self: end; height: 2.1rem;" disabled>鉛直を合わせる</button>
        </div>
        <div class="muted s-tilt-result" style="font-size: 0.8rem;"></div>
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
  // 押せるかどうかは別の材料（校正前の静止窓）で決まる（`viewBoards.ts` の `refreshTiltPanels`）。
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

/**
 * カードの回転行列の 9 マスへ値を書き込む。
 *
 * **`readSensorCardValues` と対になる。** 読むほうと同じセレクタをここでも使う ——
 * 片方だけ変えると、提案した値が黙ってどこにも入らない。
 */
export function writeSensorCardRotation(card: ParentNode, rotation: Mat3): void {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      qs<HTMLInputElement>(card, `.s-rotation[data-row="${row}"][data-col="${col}"]`).value = String(
        rotation[row][col],
      )
    }
  }
}

/** カードのオフセット・感度の欄を書き換える（6 面法の結果を入れる）。**保存はしない。** */
export function writeSensorCardOffsetSensitivity(
  card: ParentNode,
  offset: readonly [string, string, string],
  sensitivity: readonly [string, string, string],
): void {
  for (let axis = 0; axis < 3; axis++) {
    qs<HTMLInputElement>(card, `.s-offset[data-axis="${axis}"]`).value = offset[axis]!
    qs<HTMLInputElement>(card, `.s-sensitivity[data-axis="${axis}"]`).value = sensitivity[axis]!
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
 * 丸ごと除外し、`noiseDensity` の欠落は複数センサー合成の駆動役選定に影響する
 * ため、どちらも気づけないまま挙動が変わるのは避ける（敵対的レビューで検出）。
 */
export function readSensorCardValues(card: ParentNode): SensorFormValues {
  const text = (selector: string): string => qs<HTMLInputElement>(card, selector).value
  const vec3 = (namePrefix: string): readonly [string, string, string] => {
    const at = (axis: number): string => qs<HTMLInputElement>(card, `.${namePrefix}[data-axis="${axis}"]`).value
    return [at(0), at(1), at(2)]
  }
  const rotationAt = (row: number, col: number): string =>
    qs<HTMLInputElement>(card, `.s-rotation[data-row="${row}"][data-col="${col}"]`).value
  const rotation: SensorFormValues['rotation'] = [
    rotationAt(0, 0), rotationAt(0, 1), rotationAt(0, 2),
    rotationAt(1, 0), rotationAt(1, 1), rotationAt(1, 2),
    rotationAt(2, 0), rotationAt(2, 1), rotationAt(2, 2),
  ]

  return {
    sensorId: text('.s-sensorId'),
    enabled: qs<HTMLInputElement>(card, '.s-enabled').checked,
    offset: vec3('s-offset'),
    sensitivity: vec3('s-sensitivity'),
    rotation,
    noiseDensity: text('.s-noiseDensity'),
  }
}
