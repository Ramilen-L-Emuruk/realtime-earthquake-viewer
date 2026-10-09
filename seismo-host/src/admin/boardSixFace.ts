// 基板の 6 面法（REQUIREMENTS.md §16）: 基板をいくつもの向きへ置いて静止させた窓から、基板に載った
// **全部のセンサーの全部の軸**の測る向き（基板の座標・長さが倍率）とゼロ点を一緒に出す。
//
// ```
// 軸 j・姿勢 p:   m_jp = h_j · g_p + o_j      |g_p| = 1 g
// ```
//
// `m` は校正前の値（`gravityCheck.ts` の `RestWindow`）、`h_j` は軸の測る向き、`o_j` はゼロ点、`g_p` は
// その姿勢で基板の座標から見た重力の向き。**どの姿勢でも重力の長さは 1 g** という条件だけで、軸の向きも
// 倍率もゼロ点も決まる —— 置き方の傾きは未知数（`g_p`）に入るので、机の上に手で置く精度で足りる。
//
// **軸は 1 本ずつ自由な向きで解く**（2026-10-10 ユーザー承認）。チップの中の軸どうしの直角のずれも、
// センサーどうしの取り付けの角度も、この向きのずれとして出る。2 軸のセンサー（IIS2ICLX）も 3 軸と
// 同じ式に入る —— 1 個では 3 成分を決められなくても、基板に載ったほかの軸と一緒なら解ける。
//
// ## 基板の座標の決め方
//
// 全体を回しても式は同じだけ合うので、回転の 3 つの自由度は決まらない。**1 個目のセンサーの 1 本目を
// X 軸、2 本目を XY 面（Y が正の側）に置く**（2026-10-09 ユーザー承認）。だから 1 本目は X 成分だけ、
// 2 本目は X・Y 成分だけを持つ。未知数は軸の数を A として `4A − 3`、それに姿勢ごとの重力の向きが 2 つ。
// 式は姿勢ごとに A 本なので、数の上では `A·P ≥ 4A − 3 + 2P` で足りる。
//
// **ただし 6 面だけでは決まらない。** 向きを歪める変換 `T` で `g' = T g`・`h' = T⁻ᵀ h` と置き換えても
// `h·g` は変わらないので、置いた向きの全部で `|T g| = 1` になる `T` が回転のほかにあれば、解は 1 つに
// 定まらない。`TᵀT` は 6 つの値を持つ対称行列で、向き 1 つ（裏返しは同じ）が 1 本ずつ拘束を立てる。
// 6 面は X・Y・Z とその裏返しなので 3 本しか立たず、**違う向きの斜めの置き方が少なくとも 3 回要る。**
// だから要る姿勢は軸の本数に依らず 9 以上（`minPosesFor`）で、向きが偏っていないかも確かめる
// （`directionsSpread`）。
//
// **鏡に映した解も同じだけ合う**（基板の面に垂直な向きの符号が決まらない）。3 軸のセンサーがあれば、
// チップの軸は右手系なので行列式が正になる側を採る。2 軸のセンサーだけの基板では決め手がデータに無い
// ので、**カードに入っている大まかな向きと合う側を採る**。カードの向きは解き始める値にも使う。
//
// ## 姿勢の決め方
//
// **同じ置き方かどうかは時間の重なりで決める。** センサーごとに、途切れずに続いた静止窓（前の窓の
// 終わりから次の窓が始まる）を 1 つの「静止の続き」にまとめ、全部のセンサーの続きが時間で重なる区間を
// 1 つの姿勢とする。基板を動かせば全部のセンサーの窓が静止と言えなくなるので、続きはそこで切れる。
// 向きの近さで組ませると、別々に置いた 2 枚の基板や、置き直す前後の窓を混ぜうる。
//
// **Node 専用のコードを持たない**（管理コンソールが使う）。

import { GAL_PER_G } from '../intensity/units'
import { FUSION_MIN_DIRECTION_INFO } from '../receiver/directionInfo'
import { minEigenvalueSym3 } from '../receiver/matrix3'
import type { AxisCalibration, Mat3, Vec3 } from '../receiver/stationConfigTypes'

/** 当てはめに使う静止窓 1 つ（`GET /api/rest-windows` の窓）。 */
export interface BoardFitWindow {
  /** 窓の始まり（ホストの時計）。**この欄を返す前のホストでは `null`。** */
  readonly fromMs: number | null
  readonly atMs: number
  readonly sampleCount: number
  /** 校正前の軸ごとの平均（gal）。本数はセンサーの軸の本数。 */
  readonly meanGal: readonly number[]
}

/** 基板に載ったセンサー 1 個。**並びはカードの並び**（1 個目が基板の座標の基準）。 */
export interface BoardFitSensor {
  readonly sensorId: string
  /** カードにいま入っている軸（解き始める値と、鏡像のどちらを採るかに使う）。 */
  readonly prior: readonly AxisCalibration[]
  readonly windows: readonly BoardFitWindow[]
}

export type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

/** 画面に並べる順。 */
export const FACE_ORDER: readonly Face[] = ['+x', '-x', '+y', '-y', '+z', '-z']

export type FaceCoverage = Readonly<Record<Face, boolean>>

/**
 * 受け入れる値の幅。**画面の文言もここから引く**（書き写すと、片方だけ変えたときに食い違う）。
 *
 * 倍率は向きの長さ（1 gal の揺れで何 gal 読むか）で、個体差（MPU6050 で ±3%）より十分広く、桁の誤りは
 * 弾く。ゼロ点は 1 g に対する比で、実機の最大は 0.32 g。
 */
export const SIX_FACE_LIMITS = {
  gainMin: 0.5,
  gainMax: 2,
  offsetMaxGal: GAL_PER_G * 0.5,
} as const

export interface BoardSixFaceFit {
  readonly ok: true
  /** センサーごとの軸（基板の座標）。並びは入力と同じ。 */
  readonly sensors: readonly { readonly sensorId: string; readonly axes: readonly AxisCalibration[] }[]
  readonly faces: FaceCoverage
  /** まとめた後の姿勢の数。 */
  readonly poseCount: number
  /** 解くのに要る姿勢の数。 */
  readonly minPoses: number
  /**
   * 各姿勢・各軸で、解いた式から読んだ値がどれだけ離れたかの最大（gal）。
   *
   * **式と未知数が同じ数のときは null。** 必ず 0 に解け、検算にならない。
   */
  readonly maxResidualGal: number | null
}

export type BoardSixFaceRefusalReason =
  /** 窓に始まりの時刻が無い（前の版のホスト）。 */
  | 'no-window-start'
  /** カードの軸の向きが 3 方向へ散っていない（解き始められず、鏡像も選べない）。 */
  | 'prior-degenerate'
  /** ほかのセンサーと時間が重なって静止した置き方が無いセンサーがある（`sensorId`）。 */
  | 'no-common-pose'
  /** カードの軸の本数が、届いている窓の本数と合わないセンサーがある（`sensorId`・`cardAxisCount`・`windowAxisCount`）。 */
  | 'axis-count-mismatch'
  /** 6 面のどれかが揃っていない。 */
  | 'missing-faces'
  /** 姿勢が足りない。 */
  | 'too-few-poses'
  /** 解が定まらない（解けない・収束しない・右手系の向きが食い違う）。 */
  | 'degenerate'
  /** 出た値が個体差として説明できない幅にある。 */
  | 'out-of-range'
  /** 検算の残差が大きい（揺れていた窓や、別の値が混ざっている疑い）。 */
  | 'residual-too-large'

export interface BoardSixFaceRefusal {
  readonly ok: false
  readonly reason: BoardSixFaceRefusalReason
  readonly faces: FaceCoverage
  readonly poseCount: number
  readonly minPoses: number
  /** `no-common-pose`・`axis-count-mismatch` のときのセンサー。それ以外は null。 */
  readonly sensorId: string | null
  /** `axis-count-mismatch` のときの、カードの軸の本数。それ以外は null。 */
  readonly cardAxisCount: number | null
  /** `axis-count-mismatch` のときの、届いている窓の値の本数。それ以外は null。 */
  readonly windowAxisCount: number | null
  /** `residual-too-large` のときの残差（gal）。それ以外は null。 */
  readonly maxResidualGal: number | null
}

/**
 * 続けて閉じたとみなす、前の窓の終わりと次の窓の始まりの差（ms）。
 *
 * ホストは窓を閉じた同じ時刻から次の窓を始める（`gravityCheck.ts`）ので、本来は 0。窓を閉じる契機は
 * パケットの到着なので、1 秒の余裕で丸めの揺れを吸う。静止と言えない窓が挟まれば 30 秒離れる。
 */
const JOIN_TOLERANCE_MS = 1_000

/**
 * 同じ姿勢とみなす向きの差（度）。面どうしは 90 度、斜めに置いた姿勢とも 45 度ほど離れている。
 * 置き直したときのぶれ（数度）とカードの向きの粗さより十分大きく、隣の向きより十分小さい値。
 */
const SAME_POSE_DEG = 25

/** その面に置いたとみなす、重力の向きのその軸の成分の下限（1 g に対する比）。 */
const FACE_MIN_RATIO = 0.5

/**
 * カードの向きが 3 方向へ散っているとみなす下限。向きを単位にして `Σ û ûᵀ` を作り、
 * いちばん小さい固有値で見る。3 軸を真っすぐ付けたセンサー 1 個で 1、全部が水平面に寝ていれば 0。
 * **観測点の合成・「鉛直を合わせる」と同じ物差し**（`directionInfo.ts`）。
 */
const PRIOR_SPREAD_MIN = FUSION_MIN_DIRECTION_INFO

/**
 * 1 個目のセンサーの 1 本目と 2 本目が、基板の座標を決められるほど離れているとみなす下限
 * （2 本目から 1 本目の向きを除いた残りの長さの比。sin で 0.1 ≒ 5.7 度）。ほぼ平行な 2 本で XY 面を
 * 決めると、カードの向きのわずかな粗さで Y の向きが大きく振れる。
 */
const REFERENCE_PAIR_MIN_SIN = 0.1

/**
 * 検算の残差の上限（1 g に対する比）。静止窓の平均のぶれは 0.1 gal に満たない。置き換えの間の温度の
 * 変化（実機で数日に 10〜17 gal）もここまでは届かない。超える分は窓のほうが疑わしい。
 */
const RESIDUAL_MAX_RATIO = 0.02

/**
 * 置いた向きが偏っていないとみなす下限（`directionsSpread`）。テストの見本で測ると、6 面を数度の傾きで
 * 置いただけなら 4×10⁻⁴、斜めを足しても 2 回まで・同じ面の中に 3 回なら 5×10⁻⁴ 以下、違う向きの斜めを
 * 3 回足せば 0.15。その間に置いた。
 */
const DIRECTION_SPREAD_MIN = 0.02

/** 解く手間の上限（`fitBoardSixFaceWith`。テストが絞って、収束しない経路を確かめる）。 */
export interface BoardFitLimits {
  /** 交互の最小二乗で解き始めの値を寄せる回数。 */
  readonly warmupRounds: number
  /** 仕上げの Levenberg–Marquardt の上限回数。 */
  readonly lmMaxRounds: number
}

const DEFAULT_LIMITS: BoardFitLimits = { warmupRounds: 30, lmMaxRounds: 200 }

/**
 * 収束したとみなす勾配（`Jᵀr` の成分のいちばん大きい値・g 単位）の上限。解の上では丸めの誤差（10⁻¹³ 前後）
 * まで落ちる。10⁻⁹ g は 10⁻⁶ gal で、値として意味を持つ桁より十分小さい。**回数や減衰の上限で
 * 打ち切っただけの解を、成功として返さないための門**（式と未知数が同じ数のときは検算が走らない）。
 */
const GRADIENT_TOL = 1e-9

/**
 * 解くのに要る姿勢の数。**6 面と、違う向きの斜め 3 回で 9 を下回らない**（冒頭の説明）。軸が少なければ
 * 未知数の数で決まる。軸が 2 本以下なら解けない（無限大）。
 */
export function minPosesFor(axisCount: number): number {
  if (axisCount <= 2) return Number.POSITIVE_INFINITY
  return Math.max(9, Math.ceil((4 * axisCount - 3) / (axisCount - 2)))
}

const NO_FACES: FaceCoverage = { '+x': false, '-x': false, '+y': false, '-y': false, '+z': false, '-z': false }

type V3 = [number, number, number]

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
}

function norm(v: readonly number[]): number {
  return Math.hypot(v[0]!, v[1]!, v[2]!)
}

function scale(v: readonly number[], k: number): V3 {
  return [v[0]! * k, v[1]! * k, v[2]! * k]
}

function cross(a: readonly number[], b: readonly number[]): V3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
}

/**
 * n×n の連立方程式を部分ピボットつきの消去法で解く。**ピボットが対角の最大の `1e-12` 倍に届かなければ
 * 解けないとして null**（向きの散り方が足りない・未知数が式で決まらない）。
 */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]!])
  let maxDiag = 0
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, Math.abs(a[i]![i]!))
  const tiny = maxDiag * 1e-12
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r
    if (!(Math.abs(m[pivot]![col]!) > tiny)) return null
    ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / m[col]![col]!
      if (f === 0) continue
      for (let k = col; k <= n; k++) m[r]![k]! -= f * m[col]![k]!
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = m[i]![n]!
    for (let k = i + 1; k < n; k++) s -= m[i]![k]! * x[k]!
    x[i] = s / m[i]![i]!
  }
  return x.every(Number.isFinite) ? x : null
}

interface Run {
  readonly fromMs: number
  readonly atMs: number
}

/** 途切れずに続いた静止窓を 1 つの続きへまとめる。 */
function runsOf(windows: readonly (BoardFitWindow & { readonly fromMs: number })[]): Run[] {
  const sorted = [...windows].sort((a, b) => a.fromMs - b.fromMs)
  const runs: { fromMs: number; atMs: number }[] = []
  for (const w of sorted) {
    const last = runs[runs.length - 1]
    if (last !== undefined && Math.abs(w.fromMs - last.atMs) <= JOIN_TOLERANCE_MS) {
      last.atMs = Math.max(last.atMs, w.atMs)
    } else {
      runs.push({ fromMs: w.fromMs, atMs: w.atMs })
    }
  }
  return runs
}

/** 解き始めの値として、カードの向きを基板の座標（1 個目のセンサーの 1・2 本目が基準）へ写す。 */
function priorInFrame(sensors: readonly BoardFitSensor[]): { axes: { vector: V3; offset: number }[] } | null {
  const ref = sensors[0]?.prior
  if (ref === undefined || ref.length < 2) return null
  const x0 = ref[0]!.vector
  const nx = norm(x0)
  if (!(nx > 0)) return null
  const ex = scale(x0, 1 / nx)
  const y0 = ref[1]!.vector
  const yPerp: V3 = [y0[0] - dot(y0, ex) * ex[0], y0[1] - dot(y0, ex) * ex[1], y0[2] - dot(y0, ex) * ex[2]]
  const ny = norm(yPerp)
  if (!(ny >= REFERENCE_PAIR_MIN_SIN * norm(y0))) return null
  const ey = scale(yPerp, 1 / ny)
  const ez = cross(ex, ey)
  const axes = sensors.flatMap((s) =>
    s.prior.map((a) => ({ vector: [dot(a.vector, ex), dot(a.vector, ey), dot(a.vector, ez)] as V3, offset: a.offset / GAL_PER_G })),
  )
  // **3 方向へ散っているか。** 散っていなければ姿勢ごとの重力を解き始められず、鏡像も選べない。
  const spread: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (const a of axes) {
    const n = norm(a.vector)
    if (!(n > 0) || !a.vector.every(Number.isFinite)) return null
    const u = scale(a.vector, 1 / n)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) spread[i]![j]! += u[i]! * u[j]!
  }
  if (!(minEigenvalueSym3(spread as unknown as Mat3) >= PRIOR_SPREAD_MIN)) return null
  return { axes }
}

/** 軸の向きとゼロ点が分かっているとき、ある姿勢で読んだ値から重力の向き（単位）を最小二乗で出す。 */
function poseDirection(h: readonly V3[], o: readonly number[], m: readonly number[]): V3 | null {
  const n: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const b = [0, 0, 0]
  h.forEach((v, j) => {
    const d = m[j]! - o[j]!
    for (let i = 0; i < 3; i++) {
      b[i]! += v[i]! * d
      for (let k = 0; k < 3; k++) n[i]![k]! += v[i]! * v[k]!
    }
  })
  const g = solveLinear(n, b)
  if (g === null) return null
  const len = norm(g)
  return len > 0 ? scale(g, 1 / len) : null
}

/**
 * 置いた向きの散り具合。**向き 1 つ（裏返しは同じ）が `TᵀT` の 6 つの値へ立てる拘束が、6 つとも
 * 効いているか**を見る（冒頭の説明）。向きを `[x², y², z², √2xy, √2yz, √2zx]` へ写して積み上げた
 * 6×6 の行列を Cholesky 分解し、いちばん小さい軸の値を対角のいちばん大きい値で割る。0 なら定まらない。
 */
export function directionsSpread(dirs: readonly (readonly number[])[]): number {
  const r2 = Math.SQRT2
  const q = dirs.map((d) => [d[0]! * d[0]!, d[1]! * d[1]!, d[2]! * d[2]!, r2 * d[0]! * d[1]!, r2 * d[1]! * d[2]!, r2 * d[2]! * d[0]!])
  const n = 6
  const a = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => q.reduce((s, v) => s + v[i]! * v[j]!, 0)))
  let maxDiag = 0
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, a[i]![i]!)
  if (!(maxDiag > 0)) return 0
  let minPivot = Number.POSITIVE_INFINITY
  for (let k = 0; k < n; k++) {
    const pivot = a[k]![k]!
    minPivot = Math.min(minPivot, pivot)
    if (!(pivot > 0)) return 0
    for (let i = k + 1; i < n; i++) {
      const f = a[i]![k]! / pivot
      for (let j = k; j < n; j++) a[i]![j]! -= f * a[k]![j]!
    }
  }
  return minPivot / maxDiag
}

/** 軸 j のうち未知数として動かす成分（基板の座標の決め方で、1 本目は X だけ、2 本目は X・Y だけ）。 */
function freeComponents(j: number): readonly number[] {
  return j === 0 ? [0] : j === 1 ? [0, 1] : [0, 1, 2]
}

/** 重力の向き `g` に直交する 2 本（姿勢の未知数を動かす向き）。 */
function tangents(g: V3): [V3, V3] {
  const a: V3 = Math.abs(g[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const p: V3 = [a[0] - dot(a, g) * g[0], a[1] - dot(a, g) * g[1], a[2] - dot(a, g) * g[2]]
  const t1 = scale(p, 1 / norm(p))
  return [t1, cross(g, t1)]
}

interface Solution {
  h: V3[]
  o: number[]
  g: V3[]
}

function residuals(s: Solution, m: readonly (readonly number[])[]): number[] {
  const r: number[] = []
  m.forEach((row, p) => {
    s.h.forEach((v, j) => r.push(dot(v, s.g[p]!) + s.o[j]! - row[j]!))
  })
  return r
}

function costOf(s: Solution, m: readonly (readonly number[])[]): number {
  return residuals(s, m).reduce((acc, v) => acc + v * v, 0)
}

/** 交互の最小二乗（軸を固定して姿勢を解く・姿勢を固定して軸を解く）。解き始めの値を寄せる。 */
function warmUp(s: Solution, m: readonly (readonly number[])[], rounds: number): void {
  for (let round = 0; round < rounds; round++) {
    for (let j = 0; j < s.h.length; j++) {
      const free = freeComponents(j)
      const k = free.length + 1
      const n = Array.from({ length: k }, () => new Array<number>(k).fill(0))
      const b = new Array<number>(k).fill(0)
      m.forEach((row, p) => {
        const x = [...free.map((c) => s.g[p]![c]!), 1]
        for (let a = 0; a < k; a++) {
          b[a]! += x[a]! * row[j]!
          for (let c = 0; c < k; c++) n[a]![c]! += x[a]! * x[c]!
        }
      })
      const sol = solveLinear(n, b)
      if (sol === null) continue
      const next: V3 = [0, 0, 0]
      free.forEach((c, i) => (next[c] = sol[i]!))
      s.h[j] = next
      s.o[j] = sol[free.length]!
    }
    m.forEach((row, p) => {
      const g = poseDirection(s.h, s.o, row)
      if (g !== null) s.g[p] = g
    })
  }
}

/** Levenberg–Marquardt で仕上げる。**解が定まらない・収束しなかったなら null。** */
function refine(start: Solution, m: readonly (readonly number[])[], maxRounds: number): Solution | null {
  const A = start.h.length
  const P = start.g.length
  const axisCols = start.h.map((_, j) => freeComponents(j).length + 1)
  const axisOffset: number[] = []
  let cols = 0
  for (const c of axisCols) {
    axisOffset.push(cols)
    cols += c
  }
  const poseOffset = cols
  cols += 2 * P

  const build = (s: Solution): { jtj: number[][]; jtr: number[]; cost: number } => {
    const jtj = Array.from({ length: cols }, () => new Array<number>(cols).fill(0))
    const jtr = new Array<number>(cols).fill(0)
    let cost = 0
    const tan = s.g.map(tangents)
    for (let p = 0; p < P; p++) {
      for (let j = 0; j < A; j++) {
        const r = dot(s.h[j]!, s.g[p]!) + s.o[j]! - m[p]![j]!
        cost += r * r
        const idx: number[] = []
        const val: number[] = []
        freeComponents(j).forEach((c, i) => {
          idx.push(axisOffset[j]! + i)
          val.push(s.g[p]![c]!)
        })
        idx.push(axisOffset[j]! + axisCols[j]! - 1)
        val.push(1)
        idx.push(poseOffset + 2 * p, poseOffset + 2 * p + 1)
        val.push(dot(s.h[j]!, tan[p]![0]), dot(s.h[j]!, tan[p]![1]))
        for (let a = 0; a < idx.length; a++) {
          jtr[idx[a]!]! += val[a]! * r
          for (let b = 0; b < idx.length; b++) jtj[idx[a]!]![idx[b]!]! += val[a]! * val[b]!
        }
      }
    }
    return { jtj, jtr, cost }
  }

  const apply = (s: Solution, delta: readonly number[]): Solution => {
    const h = s.h.map((v, j) => {
      const next: V3 = [v[0], v[1], v[2]]
      freeComponents(j).forEach((c, i) => (next[c] += delta[axisOffset[j]! + i]!))
      return next
    })
    const o = s.o.map((v, j) => v + delta[axisOffset[j]! + axisCols[j]! - 1]!)
    const g = s.g.map((v, p) => {
      const [t1, t2] = tangents(v)
      const d1 = delta[poseOffset + 2 * p]!
      const d2 = delta[poseOffset + 2 * p + 1]!
      const moved: V3 = [v[0] + d1 * t1[0] + d2 * t2[0], v[1] + d1 * t1[1] + d2 * t2[1], v[2] + d1 * t1[2] + d2 * t2[2]]
      return scale(moved, 1 / norm(moved))
    })
    return { h, o, g }
  }

  let s = start
  let lambda = 1e-3
  let built = build(s)
  for (let round = 0; round < maxRounds; round++) {
    const damped = built.jtj.map((row, i) => row.map((v, k) => (i === k ? v * (1 + lambda) + 1e-15 : v)))
    const delta = solveLinear(
      damped,
      built.jtr.map((v) => -v),
    )
    if (delta === null) return null
    const next = apply(s, delta)
    const nextCost = costOf(next, m)
    if (Number.isFinite(nextCost) && nextCost <= built.cost) {
      const gain = built.cost - nextCost
      s = next
      built = build(s)
      lambda = Math.max(lambda / 3, 1e-12)
      const stepSize = Math.sqrt(delta.reduce((acc, v) => acc + v * v, 0))
      if (gain <= 1e-15 * (1 + built.cost) && stepSize < 1e-9) break
    } else {
      lambda *= 4
      if (lambda > 1e12) break
    }
  }
  // **解が式で決まっているかを、減衰を外した正規方程式で確かめる。** 決まっていなければ、どこへ
  // 収束したかは解き始めの値しだいで、出た値に意味が無い。
  if (solveLinear(built.jtj, built.jtr) === null) return null
  if (!Number.isFinite(built.cost)) return null
  // **収束したかを勾配で確かめる。** 回数を使い切った・減衰が上限に達した、のどちらで抜けても、勾配が
  // 0 に近ければ解の上にいる（解の上では減衰をいくら変えても値が下がらず、減衰の上限で抜ける）。
  if (!built.jtr.every((v) => Math.abs(v) <= GRADIENT_TOL)) return null
  return s
}

/** 基板の面に垂直な向き（Z）の符号を全部反転する（鏡に映した、同じだけ合う解）。 */
function reflect(s: Solution): Solution {
  return {
    h: s.h.map((v) => [v[0], v[1], -v[2]] as V3),
    o: s.o,
    g: s.g.map((v) => [v[0], v[1], -v[2]] as V3),
  }
}

function det(rows: readonly V3[]): number {
  return dot(rows[0]!, cross(rows[1]!, rows[2]!))
}

/**
 * 数えるための、向きの違う置き方（向きを単位にした代表）。`SAME_POSE_DEG` 以内の区間どうしを繋いだ
 * **連結成分**を 1 つの置き方とし、代表はその成分の向きの平均。**区間の並び順に依らない** —— 先に出来た
 * 代表へ寄せていく形にすると、橋渡しになる区間を先に置いたかどうかで数も代表も変わり、同じ置き方を
 * やり直しても受け付けたり断ったりが入れ替わる。
 */
function distinctDirections(dirs: readonly V3[]): V3[] {
  const cosLimit = Math.cos((SAME_POSE_DEG * Math.PI) / 180)
  const parent = dirs.map((_, i) => i)
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!
    return i
  }
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      if (dot(dirs[i]!, dirs[j]!) >= cosLimit) parent[root(j)] = root(i)
    }
  }
  const sums = new Map<number, [number, number, number]>()
  dirs.forEach((d, i) => {
    const r = root(i)
    const s = sums.get(r) ?? [0, 0, 0]
    sums.set(r, [s[0] + d[0], s[1] + d[1], s[2] + d[2]])
  })
  return [...sums.entries()].map(([r, s]) => {
    const n = norm(s)
    // 成分が 180° 近くまで連なると平均が 0 に寄る。そのときは成分の最初の向きを代表にする。
    return n > 1e-9 ? ([s[0] / n, s[1] / n, s[2] / n] as V3) : dirs[r]!
  })
}

function refusal(
  reason: BoardSixFaceRefusalReason,
  extra: Partial<Omit<BoardSixFaceRefusal, 'ok' | 'reason'>> & { readonly minPoses: number },
): BoardSixFaceRefusal {
  return {
    ok: false,
    reason,
    faces: extra.faces ?? NO_FACES,
    poseCount: extra.poseCount ?? 0,
    minPoses: extra.minPoses,
    sensorId: extra.sensorId ?? null,
    cardAxisCount: extra.cardAxisCount ?? null,
    windowAxisCount: extra.windowAxisCount ?? null,
    maxResidualGal: extra.maxResidualGal ?? null,
  }
}

/**
 * 基板の静止窓から、全部の軸の測る向きとゼロ点を出す。**投げない。** 出せなければ理由を返す。
 */
export function fitBoardSixFace(sensors: readonly BoardFitSensor[]): BoardSixFaceFit | BoardSixFaceRefusal {
  return fitBoardSixFaceWith(sensors, DEFAULT_LIMITS)
}

/** {@link fitBoardSixFace} の手間の上限を渡せる形（テスト用）。 */
export function fitBoardSixFaceWith(
  sensors: readonly BoardFitSensor[],
  limits: BoardFitLimits,
): BoardSixFaceFit | BoardSixFaceRefusal {
  const axisCount = sensors.reduce((n, s) => n + s.prior.length, 0)
  const minPoses = minPosesFor(axisCount)

  // **軸の本数がカードと合わない窓は使わない**（窓の本数はパケットの本数で決まるので、合わないのは
  // カードの本数を打ち間違えたとき）。**そのセンサーの窓が全部合わないなら、本数の話として断る** ——
  // 窓を捨てたまま進むと「同時に静止した置き方が無い」と言い、置き直しても直らない方へ誘う。
  const readableWindows = sensors.map((s) => s.windows.filter((w) => w.meanGal.every(Number.isFinite) && w.sampleCount > 0))
  for (let i = 0; i < sensors.length; i++) {
    const ws = readableWindows[i]!
    const cardAxisCount = sensors[i]!.prior.length
    if (ws.length > 0 && ws.every((w) => w.meanGal.length !== cardAxisCount)) {
      return refusal('axis-count-mismatch', {
        minPoses,
        sensorId: sensors[i]!.sensorId,
        cardAxisCount,
        windowAxisCount: ws[0]!.meanGal.length,
      })
    }
  }
  const usable = sensors.map((s, i) => readableWindows[i]!.filter((w) => w.meanGal.length === s.prior.length))
  if (usable.some((ws) => ws.some((w) => w.fromMs === null))) return refusal('no-window-start', { minPoses })
  const timed = usable as (BoardFitWindow & { readonly fromMs: number })[][]

  const prior = priorInFrame(sensors)
  if (prior === null) return refusal('prior-degenerate', { minPoses })
  const priorH = prior.axes.map((a) => a.vector)
  const priorO = prior.axes.map((a) => a.offset)

  // **姿勢: 全部のセンサーの静止の続きが時間で重なる区間。** 1 個目から順に重ねていき、空になった
  // センサーの名前を出す。
  let intervals: Run[] = runsOf(timed[0] ?? [])
  if (intervals.length === 0) return refusal('no-common-pose', { minPoses, sensorId: sensors[0]?.sensorId ?? null })
  for (let i = 1; i < sensors.length; i++) {
    const runs = runsOf(timed[i]!)
    const next: Run[] = []
    for (const a of intervals) {
      for (const r of runs) {
        const fromMs = Math.max(a.fromMs, r.fromMs)
        const atMs = Math.min(a.atMs, r.atMs)
        if (atMs > fromMs) next.push({ fromMs, atMs })
      }
    }
    if (next.length === 0) return refusal('no-common-pose', { minPoses, sensorId: sensors[i]!.sensorId })
    intervals = next
  }

  // 姿勢ごとの校正前の値（g 単位・軸を並べたもの）。区間に掛かる窓をサンプル数で重み付けして平均する。
  // **どれかのセンサーの窓が 1 つも掛からない区間は捨てる** —— 静止の続きは 1 秒までの隙間を繋いで
  // 作るので、区間がちょうどその隙間に収まることがある（そこには値が無い）。
  const raw = intervals.flatMap((iv) => {
    let weight = 0
    const values: number[] = []
    for (const ws of timed) {
      const inside = ws.filter((w) => w.atMs > iv.fromMs && w.fromMs < iv.atMs)
      if (inside.length === 0) return []
      const n = inside.reduce((acc, w) => acc + w.sampleCount, 0)
      weight += n
      const len = inside[0]!.meanGal.length
      for (let k = 0; k < len; k++) values.push(inside.reduce((acc, w) => acc + w.meanGal[k]! * w.sampleCount, 0) / n / GAL_PER_G)
    }
    return [{ values, weight }]
  })
  if (raw.length === 0) return refusal('no-common-pose', { minPoses, sensorId: sensors[sensors.length - 1]?.sensorId ?? null })

  // **解くときは、区間ごとに別の姿勢として残す**（姿勢ごとに重力の向きを未知数に持つ）。向きの近い区間の
  // 値を平均して 1 つにすると、別の置き方（たとえば据えた場所と ＋Z の面）を混ぜた実在しない姿勢ができ、
  // 値が真値から外れる（合成データで ＋Z から 5° の置き方を足すとゼロ点が 0.5 gal ずれ、残差には 0.03 gal
  // しか出なかった）。**向きの近い区間をまとめるのは数えるときだけ**（同じ面へ置き直しても、解の定まり方は
  // 変わらない）。向きはカードの値で見る。
  const m = raw.map((p) => p.values)
  const startG: V3[] = []
  for (const row of m) {
    // カードの向きは散っている（`priorInFrame` で確かめた）ので、ここで解けないのは姿勢の値のほう。
    const dir = poseDirection(priorH, priorO, row)
    if (dir === null) return refusal('degenerate', { minPoses })
    startG.push(dir)
  }
  const distinct = distinctDirections(startG)

  const has = (axis: 0 | 1 | 2, sign: 1 | -1) => startG.some((g) => g[axis] * sign >= FACE_MIN_RATIO)
  const faces: FaceCoverage = {
    '+x': has(0, 1),
    '-x': has(0, -1),
    '+y': has(1, 1),
    '-y': has(1, -1),
    '+z': has(2, 1),
    '-z': has(2, -1),
  }
  const poseCount = distinct.length
  if (!FACE_ORDER.every((f) => faces[f])) return refusal('missing-faces', { minPoses, faces, poseCount })
  if (poseCount < minPoses) return refusal('too-few-poses', { minPoses, faces, poseCount })
  // **数が足りても、斜めの置き方が同じ向きに偏っていれば解は定まらない。** 同じ向きの区間を重ねて数えると
  // 散り具合が水増しされるので、向きの違う置き方だけで見る。
  if (!(directionsSpread(distinct) >= DIRECTION_SPREAD_MIN)) return refusal('degenerate', { minPoses, faces, poseCount })

  const start: Solution = {
    h: priorH.map((v, j) => {
      const free = freeComponents(j)
      return [0, 1, 2].map((c) => (free.includes(c) ? v[c]! : 0)) as V3
    }),
    o: [...priorO],
    g: startG,
  }
  warmUp(start, m, limits.warmupRounds)
  let solved = refine(start, m, limits.lmMaxRounds)
  if (solved === null) return refusal('degenerate', { minPoses, faces, poseCount })

  // **鏡像のどちらを採るか。** 3 軸のセンサーがあれば右手系（行列式が正）の側、無ければカードの向きと合う側。
  const threeAxis: V3[][] = []
  let at = 0
  for (const s of sensors) {
    if (s.prior.length === 3) threeAxis.push(solved.h.slice(at, at + 3))
    at += s.prior.length
  }
  if (threeAxis.length > 0) {
    const signs = threeAxis.map(det)
    if (signs.every((d) => d < 0)) solved = reflect(solved)
    else if (!signs.every((d) => d > 0)) return refusal('degenerate', { minPoses, faces, poseCount })
  } else {
    const agreement = solved.h.reduce((acc, v, j) => acc + v[2] * priorH[j]![2], 0)
    if (agreement < 0) solved = reflect(solved)
  }

  if (
    !solved.h.every((v) => {
      const gain = norm(v)
      return gain >= SIX_FACE_LIMITS.gainMin && gain <= SIX_FACE_LIMITS.gainMax
    }) ||
    !solved.o.every((o) => Math.abs(o * GAL_PER_G) <= SIX_FACE_LIMITS.offsetMaxGal)
  ) {
    return refusal('out-of-range', { minPoses, faces, poseCount })
  }

  // 検算の有無は**解いた姿勢の数**（区間の数）で決める。同じ面へ置き直した区間も式を足す。
  const unknowns = 4 * axisCount - 3 + 2 * m.length
  let maxResidualGal: number | null = null
  if (axisCount * m.length > unknowns) {
    maxResidualGal = residuals(solved, m).reduce((acc, r) => Math.max(acc, Math.abs(r) * GAL_PER_G), 0)
    if (maxResidualGal > GAL_PER_G * RESIDUAL_MAX_RATIO) {
      return refusal('residual-too-large', { minPoses, faces, poseCount, maxResidualGal })
    }
  }

  let next = 0
  const out = sensors.map((s) => {
    const axes = s.prior.map(() => {
      const v = solved!.h[next]!
      const o = solved!.o[next]!
      next++
      // **`-0` を `0` へ揃える**（`calibration.ts` の `legacyAxes` と同じ理由）。
      return { vector: [v[0] + 0, v[1] + 0, v[2] + 0] as Vec3, offset: o * GAL_PER_G + 0 }
    })
    return { sensorId: s.sensorId, axes }
  })
  return { ok: true, sensors: out, faces, poseCount, minPoses, maxResidualGal }
}
