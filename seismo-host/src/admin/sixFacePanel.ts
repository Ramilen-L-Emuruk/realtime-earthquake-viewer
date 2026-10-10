// 基板の欄の「6 面で測る」に出すものを組み立てる（REQUIREMENTS.md §16）。
//
// **計算は `boardSixFace.ts`、ここは読むことと言葉にすることだけ。** 画面（`viewBoards.ts`）に
// 文言を直書きすると、どの理由でどの文が出るかをテストで押さえられない。文言は 2026-10-10 ユーザー承認。

import { FACE_ORDER, SIX_FACE_LIMITS } from './boardSixFace'
import { axisCountMismatchProblem } from './calibrationSuggest'
import type { BoardFitWindow, BoardSixFaceFit, BoardSixFaceRefusal, Face, FaceCoverage } from './boardSixFace'
import { readFinite, readNonEmptyString } from './readJson'
import type { AxisFormValues } from './sensorForm'

/** 1 センサーぶんの静止窓（`GET /api/rest-windows` の 1 要素）。 */
export interface SensorFitWindows {
  readonly boardKey: string
  readonly sensorId: string
  /** いまの置き方で静止し始めた時刻（ホストの時計）。いま静止していなければ `null`。 */
  readonly stillSinceMs: number | null
  /** 古い順。`meanGal` の本数はそのセンサーの軸の本数（2 か 3）。 */
  readonly windows: readonly BoardFitWindow[]
}

/** 数として読めない値を `null` で表す読み方を、欄が無いときの扱いと分けて読む。 */
function readOptionalFinite(value: unknown): { readonly ok: true; readonly value: number | null } | { readonly ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null }
  const n = readFinite(value)
  return n === null ? { ok: false } : { ok: true, value: n }
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
 * 「ホストの版が古い疑い」と断る）と読む。**数として読めない値は崩れた応答**として扱う。
 */
export function parseRestWindowsBody(body: unknown): readonly SensorFitWindows[] | null {
  if (typeof body !== 'object' || body === null) return null
  const sensors = (body as { sensors?: unknown }).sensors
  if (!Array.isArray(sensors)) return null
  const out: SensorFitWindows[] = []
  for (const s of sensors) {
    if (typeof s !== 'object' || s === null) return null
    const boardKey = readNonEmptyString((s as { boardKey?: unknown }).boardKey)
    const sensorId = readNonEmptyString((s as { sensorId?: unknown }).sensorId)
    const rawWindows = (s as { windows?: unknown }).windows
    const still = readOptionalFinite((s as { stillSinceMs?: unknown }).stillSinceMs)
    if (boardKey === null || sensorId === null || !Array.isArray(rawWindows) || !still.ok) return null
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
    out.push({ boardKey, sensorId, stillSinceMs: still.value, windows })
  }
  return out
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

/** 揃い具合の 1 行（例: `＋X ✓　−X ✓　＋Y —　…　姿勢 7／9`）。 */
export function describeFaces(faces: FaceCoverage, poseCount: number, minPoses: number): string {
  const line = FACE_ORDER.map((f) => `${FACE_LABEL[f]} ${faces[f] ? '✓' : '—'}`).join('　')
  return `${line}　姿勢 ${poseCount}／${formatMinPoses(minPoses)}`
}

function formatGal(v: number): string {
  return v.toFixed(1)
}

/** 桁を切って書く。**丸めて 0 になった負の数は `-0.000000` ではなく `0.000000` と書く**（欄に負号だけ残さない）。 */
function fixed(v: number, digits: number): string {
  const s = v.toFixed(digits)
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s
}

/** ボタンを押せない理由。**押せるなら `null`。** */
export function sixFaceProblem(result: BoardSixFaceFit | BoardSixFaceRefusal): string | null {
  if (result.ok) return null
  switch (result.reason) {
    case 'no-window-start':
      return '静止窓に始まりの時刻が無い（ホストの版が古い疑い）'
    case 'prior-degenerate':
      return 'カードの軸の向きが 3 方向へ散っていない（立てて付けたセンサーは、大まかな向きを先に入れること）'
    case 'no-common-pose':
      return `センサー ${result.sensorId ?? '—'} が、ほかのセンサーと同時に静止した置き方が無い`
    case 'axis-count-mismatch':
      return axisCountMismatchProblem(result.sensorId ?? '—', result.cardAxisCount, result.windowAxisCount)
    case 'missing-faces': {
      const missing = FACE_ORDER.filter((f) => !result.faces[f]).map((f) => FACE_LABEL[f])
      return `まだ揃っていない面がある（${missing.join('・')}）`
    }
    case 'too-few-poses':
      return `姿勢が足りない（${result.poseCount}／${formatMinPoses(result.minPoses)}）。6 面に加えて、斜めにも置くこと`
    case 'degenerate':
      return '計算できなかった（解が定まらない。置き直して測り直すこと）'
    case 'out-of-range':
      return `出た値が個体差の幅を超えている（倍率 ${SIX_FACE_LIMITS.gainMin}〜${SIX_FACE_LIMITS.gainMax} 倍・ゼロ点 ±${Math.round(SIX_FACE_LIMITS.offsetMaxGal)} gal）`
    case 'residual-too-large':
      return `姿勢の間で辻褄が合わない（残差 ${result.maxResidualGal === null ? '—' : formatGal(result.maxResidualGal)} gal）。動かしている最中の窓が混ざった疑い`
  }
}

/**
 * 取り付けの欄（センサーカードの静止窓の様子・基板の向きの欄）を描き直せなかったときの、画面上部へ出す 1 行。
 * どちらも壊れていなければ `null`。**カードと基板の向きの欄は分けて言う**（基板の欄の失敗をカードの枚数へ
 * 足すと、壊れていないカードまで壊れたように読める）。文言は 2026-10-10 ユーザー承認。
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
  return where === null ? null : `${where}で取り付けの診断を出せない。画面を再読込すること`
}

/** 静止した窓を取れなかったときの理由。 */
export function restWindowsFetchProblem(reason: string): string {
  return `静止した窓を取得できない（${reason}）`
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
    note: `全部のセンサーの軸の向き・倍率・ゼロ点を入れた（姿勢 ${fit.poseCount}・${check}）。保存するまで効かない。保存したら元の場所へ据え直し、「鉛直を合わせる」を押し直すこと`,
  }
}
