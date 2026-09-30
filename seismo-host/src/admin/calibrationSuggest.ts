// 静止した基板が測った重力から、取り付けの向きを直す回転行列を作る（REQUIREMENTS.md §16）。
//
// **重力から決まるのは傾きの 2 軸だけ。** 鉛直まわりの回転＝方角について、重力は何も
// 語らない（どちらを向けて置いても重力ベクトルは同じ）。だからここは 2 つを分けて扱う:
//
// 1. **鉛直合わせ** —— 測った重力ベクトルを真上へ向ける最小の回転。自動で出る
// 2. **方角合わせ** —— 基板の 1 本目の軸（画面では「X 軸」）をどちらへ向けたいかを人が入れる。
//    入れなければ何もしない
//
// **共通座標は ENU（X＝東・Y＝北・Z＝上）の右手系とする。** 要件 §16 は「地理的な XYZ」
// としか書いておらず軸の割り当てを定めていないので、ここで決める。**Z が上向き正である
// ことだけが本質** —— 水平 2 軸の入れ替えは §7 の差分にも §6 の P/S 判定にも効かないが、
// 上下の向きは効く。
//
// **単体センサーの計測震度には効かない。** 震度が見るのは 3 成分の合成の長さ
// （`sqrt(x²+y²+z²)`）で、回転しても長さは変わらないため。効くのは軸ごとの波形・
// センサー間の差分（§7）・P/S 判定（§6）。
//
// **提案するのは「いまの設定を置き換える値」。** 入力の重力は `calibration.ts` が
// `rotation` を適用した**後**の値なので、追加の回転をいまの `rotation` へ左から掛ける。
// 何度押しても収束する（2 回目は傾きが 0 に近いので、ほぼ何も足さない）。

import type { RestScaleView, SensorRestWindow } from './detectedBoards'
import type { Mat3, Vec3 } from '../receiver/stationConfigTypes'

/**
 * 提案に載せる小数の桁。
 *
 * **画面の入力欄へそのまま入る値なので、読める桁で切る。** 6 桁は角度にして
 * 10⁻⁴ 度ぶんの分解能があり、**基板を水平に置ける精度（良くて 0.1 度）より
 * 4 桁細かい**。丸めで直交性はわずかに崩れるが、§16 はもともと `rotation` に
 * 直交性を求めていない。
 */
const DIGITS = 6

/**
 * 「向きが定まらない」とみなす外積の長さ。
 *
 * 重力ベクトルを真上へ向ける回転の軸は、2 つのベクトルの外積で決める。**真上か真下を
 * 向いているときだけ、その外積が 0 になって軸が決まらない。** 真上なら回す必要が無く、
 * 真下（上下逆さま）なら回す向きが一意に決まらない —— どちらも別に扱う。
 *
 * 1e-9 は角度にして約 6e-8 度。**ここへ掛かるのは本当に真上・真下のときだけ**で、
 * 実機の据え付け精度（良くて 0.1 度）とは 6 桁離れている。
 */
const DEGENERATE = 1e-9

/**
 * 重力ベクトルとして短すぎるとみなす長さ（gal）。
 *
 * 1 g の 100 分の 1。**向きを出すのに割り算をするので、0 に近い入力を弾く**
 * —— ここを通すと、丸め誤差だけでできた向きへ基板を回す提案になる。
 * 倍率が狂っている・揺れているといった事情は呼ぶ側が `scale` で見る。
 */
const MIN_MAGNITUDE_GAL = 9.8

/** 提案できたもの。 */
export interface TiltSuggestion {
  readonly ok: true
  /** 設定へ書き込む新しい回転。**いまの `rotation` を置き換える値。** */
  readonly rotation: Mat3
  /** いまの設定で、測った重力が真上からどれだけ傾いていたか（度）。 */
  readonly tiltDeg: number
  /**
   * 上下逆さまに付いていた。
   *
   * **真下を向いた重力を真上へ回す向きは一意に決まらない**ので、東西軸まわりに
   * 180 度回す形を選んでいる。**方角も一緒にひっくり返る**ので、この場合は
   * 方角の指定も見直すこと。
   */
  readonly upsideDown: boolean
}

/** 提案できなかったもの。**理由はそのまま画面へ出す。** */
export interface TiltRefusal {
  readonly ok: false
  readonly reason: string
}

export interface TiltSuggestInput {
  /** 静止した窓で測った重力ベクトル（gal）。**校正を適用した後の値。** */
  readonly gravity: Vec3
  /** いま設定されている回転。 */
  readonly rotation: Mat3
  /**
   * 基板の 1 本目の軸に**向けたい**方位（度・真北から時計回り。東＝90）。
   *
   * **「いまどちらを向いているか」ではなく「どちらを向かせたいか」。** 同じ値を
   * 何度渡しても結果は変わらない（2 回目以降は差が 0 なので回らない）——
   * 重力と違って方角は測れないので、ここが冪等でないと押すたびに崩れる。
   *
   * **`null` なら方角には触らない。** 分からないまま既定値で回すと、合っていた
   * 方角を黙って崩す —— 重力からは確かめようがないので、間違いに気づけない。
   */
  readonly headingDeg: number | null
}

/** 3 つ組が全部数として読めるか。 */
function readable(v: readonly number[]): boolean {
  return v.length === 3 && v.every((n) => Number.isFinite(n))
}

function magnitude(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** 行列の積 `a × b`。**順序が意味を持つ** —— 先に `b`、次に `a` を掛ける変換になる。 */
export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]
    }
  }
  return [
    [out[0][0], out[0][1], out[0][2]],
    [out[1][0], out[1][1], out[1][2]],
    [out[2][0], out[2][1], out[2][2]],
  ]
}

/**
 * 軸 `axis`（単位ベクトル）まわりに `rad` だけ回す行列。ロドリゲスの公式。
 *
 * **軸が単位ベクトルであることは呼ぶ側の責任。** 長さが 1 でない軸を渡すと、
 * 回転ではなく拡大縮小の混ざった変換になる。
 */
function rotationAroundAxis(axis: Vec3, rad: number): Mat3 {
  const [x, y, z] = axis
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  const t = 1 - c
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ]
}

/** Z 軸（上）まわりに `rad` だけ回す行列。 */
function rotationAroundUp(rad: number): Mat3 {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ]
}

function roundMat3(m: Mat3): Mat3 {
  const f = 10 ** DIGITS
  const r = (n: number): number => {
    // **`-0` を作らない。** `Math.round(-0.0000001 * f) / f` は `-0` を返し、
    // JSON へは `-0` と出る（設定ファイルを読む人が値の意味を疑う）。
    const v = Math.round(n * f) / f
    return v === 0 ? 0 : v
  }
  return [
    [r(m[0][0]), r(m[0][1]), r(m[0][2])],
    [r(m[1][0]), r(m[1][1]), r(m[1][2])],
    [r(m[2][0]), r(m[2][1]), r(m[2][2])],
  ]
}

/** `scale` ごとに、向きを提案できない理由。**提案してよければ `null`。** */
const SCALE_PROBLEM: Record<RestScaleView, string | null> = {
  ok: null,
  'not-at-rest': '揺れている間は合わせられない（静止してから 30 秒待つこと）',
  'too-small': '換算の倍率が合っていない。先にそちらを確かめること',
  'too-large': '換算の倍率が合っていない。先にそちらを確かめること',
  unreadable: '静止窓の値が読めていない（次の窓でも直らなければ基板を入れ直すこと）',
  'too-few-samples': '波形が足りない（30 秒ぶん届くと判定が出る）',
  unknown: '判定の種類を解釈できない（ホストと管理コンソールの版が食い違う疑い）',
}

/**
 * その静止窓から取り付けの向きを提案してよいか。**駄目なら理由、よければ `null`。**
 *
 * **倍率が狂っている窓では提案しない。** 重力の大きさが違うだけで向きは読めるが、
 * そこで「回せば直る」形の提案を出すと、**換算の狂いを回転行列へ塗り込む**ことになる
 * —— 直すべきは `sensitivity` か、その手前のファームの申告。
 *
 * **`restless`（静止しているのに震度が高い）では止めない。** あれは震度を出す側の
 * 配線の話で、重力の向きとは独立。画面には別に出す。
 */
export function restWindowProblem(
  window: Pick<SensorRestWindow, 'scale' | 'axisMeanGal'> | null,
): string | null {
  if (window === null) return '静止窓の判定がまだ無い（波形が 30 秒ぶん届くと出る）'
  const byScale = SCALE_PROBLEM[window.scale]
  if (byScale !== null) return byScale
  // **`scale` が `ok` でも軸ごとの値が無いことはある。** 判定を出すホストのほうが
  // 古ければ、この欄だけ応答に載らない。
  if (window.axisMeanGal === null) return '軸ごとの重力が出ていない（ホストの版が古い疑い）'
  return null
}

/** 度を小数 2 桁で丸める。**画面へ出すためだけの値。** */
export function roundDeg(deg: number): number {
  const v = Math.round(deg * 100) / 100
  return v === 0 ? 0 : v
}

/** 上向き（ENU の Z）。 */
const UP: Vec3 = [0, 0, 1]

/**
 * 重力ベクトルを真上へ向ける回転の、軸と角。**軸は正規化していない**（長さが
 * `sin` そのもので、真上・真下のときに 0 になる ＝ 向きが定まらない合図）。
 */
function axisAndAngle(unit: Vec3): { readonly axis: Vec3; readonly sin: number; readonly rad: number } {
  const axis = cross(unit, UP)
  const sin = magnitude(axis)
  // **`atan2` で出す。** `acos` は真上の近くで精度を落とすうえ、丸めで定義域を
  // わずかに外れた入力に NaN を返す。
  return { axis, sin, rad: Math.atan2(sin, dot(unit, UP)) }
}

/**
 * 重力ベクトルが真上からどれだけ傾いているか（度）。**出せなければ `null`。**
 *
 * **提案できない窓でも傾きだけは出せる。** 揺れていた窓の値は当てにならないが、
 * 「いくつ傾いているか」を画面に出さないと、直す必要があるのかどうかが分からない。
 */
export function tiltDegFromUp(gravity: Vec3 | null): number | null {
  if (gravity === null || !readable(gravity)) return null
  const mag = magnitude(gravity)
  if (mag < MIN_MAGNITUDE_GAL) return null
  const { rad } = axisAndAngle([gravity[0] / mag, gravity[1] / mag, gravity[2] / mag])
  return roundDeg((rad * 180) / Math.PI)
}

/**
 * 東向き（ENU の X）。**上下逆さまのときに 180 度回す軸。**
 *
 * 真下を向いた重力を真上へ向ける回転は無数にある（上下を結ぶ軸まわりの自由度が残る）。
 * どれを選んでも鉛直は合うので、**水平面で 1 本を決め打つ** —— 東を選んだことに
 * 深い理由は無く、方角は結局手で入れ直すことになる。
 */
const EAST: Vec3 = [1, 0, 0]

/**
 * 測った重力から、取り付けの向きを直す回転を提案する。**投げない。**
 *
 * 揺れていた窓・倍率が狂っている窓を弾くのは呼ぶ側（判定は `gravityCheck.ts` の
 * `scale` が持っている）。ここが見るのは、渡された値だけで向きを出せるかどうか。
 */
export function suggestRotation(input: TiltSuggestInput): TiltSuggestion | TiltRefusal {
  const { gravity, rotation, headingDeg } = input
  if (!readable(gravity)) return { ok: false, reason: '重力の値が数として読めない' }
  if (!rotation.every(readable)) return { ok: false, reason: 'いまの回転行列が数として読めない' }
  if (headingDeg !== null && !Number.isFinite(headingDeg)) {
    return { ok: false, reason: '方角が数として読めない' }
  }

  const mag = magnitude(gravity)
  if (mag < MIN_MAGNITUDE_GAL) {
    return { ok: false, reason: '重力が小さすぎて向きを出せない（換算の倍率を先に確かめること）' }
  }

  const u: Vec3 = [gravity[0] / mag, gravity[1] / mag, gravity[2] / mag]
  const { axis, sin, rad } = axisAndAngle(u)

  let tilt: Mat3
  let upsideDown = false
  if (sin < DEGENERATE) {
    if (dot(u, UP) > 0) {
      // 既に真上。**何も足さない。**
      tilt = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]
    } else {
      upsideDown = true
      tilt = rotationAroundAxis(EAST, Math.PI)
    }
  } else {
    tilt = rotationAroundAxis([axis[0] / sin, axis[1] / sin, axis[2] / sin], rad)
  }

  // **鉛直を合わせてから方角を回す。** 順序が逆だと、傾いたままの座標で
  // 上向き軸のつもりの回転を掛けることになり、鉛直も方角もずれる。
  let added = tilt
  if (headingDeg !== null) {
    // **方角は「いまどちらを向いているか」との差だけ回す。**
    //
    // ここを `headingDeg` だけから作った絶対の回転にすると、**同じ値をもう一度
    // 入れて押しただけで方角が壊れる** —— 傾きのほうは測った重力から作るので
    // 2 回目は `tilt` が単位行列になって収束するが、方角は重力から分からない
    // ぶん自分では収まらず、押すたびに同じ角を足し続ける（敵対的レビューが
    // 実測で再現した。真の方角 30 度の板を 2 回続けて合わせると 330 度になる）。
    const afterTilt = multiplyMat3(tilt, rotation)
    // 1 本目の軸が、鉛直を直した後の共通座標でどこを向くか（行列の第 1 列）。
    const x0: Vec3 = [afterTilt[0][0], afterTilt[1][0], afterTilt[2][0]]
    const horizontal = Math.hypot(x0[0], x0[1])
    if (horizontal < DEGENERATE) {
      return {
        ok: false,
        // **画面へ出る文なので「X 軸」と呼ぶ**（カードのオフセット・感度の X と同じ軸）。
        reason: 'X 軸が真上か真下を向いていて、方角を決められない',
      }
    }
    // **方位は北から時計回り**（東＝90 度）。共通座標は X が東・Y が北なので、
    // 東成分と北成分をこの順で `atan2` へ渡すとそのまま方位になる。
    const bearing = Math.atan2(x0[0], x0[1])
    added = multiplyMat3(rotationAroundUp(bearing - (headingDeg * Math.PI) / 180), tilt)
  }

  return {
    ok: true,
    rotation: roundMat3(multiplyMat3(added, rotation)),
    tiltDeg: roundDeg((rad * 180) / Math.PI),
    upsideDown,
  }
}
