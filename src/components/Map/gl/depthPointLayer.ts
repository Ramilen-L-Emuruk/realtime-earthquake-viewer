import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl'
import { log } from '../../../utils/logger'
import { applyProjectionUniforms, createProjectionProgramCache } from './projectionProgram'

// 深さを持つ点を地下へ描く MapLibre カスタムレイヤー。
//
// 地図の傾きが常態になったので（docs/spec/map-rendering-spec.md §6）、震源を「震央＝地表の真上」
// ではなく実際の深さへ置ける。DOM マーカー（maplibregl.Marker）は地表にしか置けないため、
// 深さを扱う描画物はすべてこのレイヤーに乗せる。
//
// **点の数に依存しない作りにしてある。** 震源 1 点でも長期カタログの 101 万点でも、頂点バッファ 1 本と
// drawArrays 1 回で描く。クリック判定も後述のカラーピッキングで点数に依らない。
//
// 深さ方向の誇張率は uniform で渡す。実スケール（水平 1000km に対し深さ 100km）では薄すぎて形が
// 読めないため、倍率を変えられるようにしてある。
//
// 投影は地球儀（globe）と Mercator を行き来する（寄ると MapLibre が自動で切り替える）。
// 座標変換は MapLibre が配る投影シェーダーに任せ、プログラムは投影ごとに持つ（gl/projectionProgram.ts）。
// **深さの単位だけは投影で違う**ため、シェーダー内で出し分けている（`elevationForProjection`）。

/** 地下に置く 1 点。 */
export interface DepthPoint {
  lng: number
  lat: number
  /** 深さ（km）。0 なら地表。 */
  depthKm: number
  /** 色（0〜1 の RGB）。 */
  color: readonly [number, number, number]
  /** 直径（CSS px）。実際の描画では devicePixelRatio を掛ける。 */
  sizePx: number
  /** 点の形（既定は円）。1 レイヤーに混在できる。 */
  shape?: DepthPointShape
  /**
   * 地表からこの点まで縦線を引くか。深さがあることを示す「柄」で、震源に使う。
   * 深さ 0 の点に指定しても線の長さが 0 になるだけで、描画は無害。
   */
  stem?: boolean
  /**
   * 主役ではなく補助の点か（震央の印など）。**柄が短くなって主役と重なるときは、柄ごと隠す**。
   * 真上から見たとき、深さが浅いとき、誇張率を下げたときのいずれでも同じ条件で消える。
   */
  auxiliary?: boolean
  /** 不透明度（既定 1）。点滅と**掛け合わさる**。 */
  alpha?: number
  /**
   * 点滅させるか。`high` と `low` の 2 値を交互に出す矩形の明滅で、周期は全点で共通
   * （`BLINK_PERIOD_MS`）。**位相も全点で揃う**——ばらばらに明滅すると数が増えたとき騒がしい。
   *
   * **判定（クリック）は明滅を見ない。** 暗い側の位相でも掴めないと、狙って押せない。
   */
  blink?: { high: number; low: number }
}

/** Web Mercator の赤道全周（m）。gl/viewSpan.ts と同じ値。 */
const EARTH_CIRCUMFERENCE_M = 40075016.686

/** 点滅の周期（ms）。明と暗が半分ずつ。 */
export const BLINK_PERIOD_MS = 1200

/**
 * 緯度経度と深さを、頂点バッファに詰める 3 つ組へ。
 *
 * x・y は Mercator 座標（0〜1）、**z は標高（m）で地下が負**。MapLibre の投影関数
 * （`projectTileFor3D`）が globe で受け取る単位に合わせてある。Mercator ではシェーダー側で
 * Mercator 座標系の z へ換算する（`elevationForProjection`）。
 */
export function toMercator(lng: number, lat: number, depthKm: number): [number, number, number] {
  const x = (180 + lng) / 360
  const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360
  return [x, y, -depthKm * 1000]
}

/**
 * Mercator 座標の y（0〜1）から緯度の余弦を求める。
 *
 * 等長緯度 psi = π(1 - 2y) に対して cos(lat) = 1 / cosh(psi) が成り立つ（グーデルマン関数）。
 * **シェーダー側の `elevationForProjection` と同じ式**で、深さを Mercator 座標系の z へ
 * 換算するのに使う。ここに置いてあるのは、その一致を単体テストで確かめるため。
 */
export function cosLatFromMercatorY(y: number): number {
  return 1 / Math.cosh(Math.PI * (1 - 2 * y))
}

/** MapLibre が球を描くときの地球半径（m）。globe のシェーダー断片が `GLOBE_RADIUS` として宣言する値。 */
export const GLOBE_RADIUS_M = 6371008.8

/**
 * 球で地下へ置ける深さの上限（地球半径に対する割合）。
 *
 * 1.0 を越えると点が地球の反対側へ写るため、その手前で止める。
 */
const MAX_UNDERGROUND_FRACTION = 0.95

/**
 * 球で使う標高（m）を、地球の中心を越えない範囲へ収める。
 *
 * **シェーダー側の `elevationForProjection` と同じ計算**（GLSL には定数を差し込んでいる）。
 * ここに置いてあるのは、境界を単体テストで固定するため。
 */
export function clampElevationForGlobe(elevMeters: number): number {
  return Math.max(elevMeters, -GLOBE_RADIUS_M * MAX_UNDERGROUND_FRACTION)
}

/**
 * 3 つの頂点シェーダー（表示・判定・柄）が共有する部分。
 *
 * **表と裏で頂点の式が食い違うと、見えている位置と当たり判定がずれる。** 1 箇所に置いて
 * 必ず同じ式を使う。
 */
const SHARED_VERT = `
precision highp float;
uniform float u_exaggeration;
uniform float u_nearZ;
uniform float u_invRange;
uniform float u_slab;
// 点滅の位相。1 が明、0 が暗。**全点で共通**（位相が揃っていないと数が増えたとき騒がしい）。
uniform float u_blinkPhase;

const float MERC_PI = 3.141592653589793;
const float EARTH_CIRCUMFERENCE_M = 40075016.686;
const float MAX_UNDERGROUND_FRACTION = MAX_UNDERGROUND_FRACTION_VALUE;

// **\`projectTileFor3D\` の elevation は投影で単位が違う。** globe はメートル、Mercator は
// Mercator 座標系の z（緯度で縮む）。バッファはメートルで持ち、ここだけで吸収する。
// Mercator 座標の y から緯度の余弦を戻す式は cosLatFromMercatorY と同じもの。
//
// **球では地球の中心を越えさせない。** MapLibre は球面上の点を
// \`spherePos * (1.0 + elevation / GLOBE_RADIUS)\` で置くので、elevation が -GLOBE_RADIUS を
// 下回ると係数が負になり、**点が地球の反対側へ写る**。深さ 700km 級の深発地震に強調 10 倍を
// 掛けるだけで届く（700 × 10 > 6371）。地表の震央だけ正しい位置に残り、震源だけがあり得ない
// 場所へ飛ぶ形になるので、手前で止める。
float elevationForProjection(float elevMeters, float mercY) {
#ifdef GLOBE
  return max(elevMeters, -GLOBE_RADIUS * MAX_UNDERGROUND_FRACTION);
#else
  float cosLat = 1.0 / cosh(MERC_PI * (1.0 - 2.0 * mercY));
  return elevMeters / (EARTH_CIRCUMFERENCE_M * cosLat);
#endif
}

// **地下の点は 2 つの理由で消える。どちらも z の書き換えで避ける。**
//
// 1. 平面（Mercator）では MapLibre の far が地下を含まない。傾きが浅いほど far は切り詰められ
//    （pitch 0 では地表までの距離の 1.01 倍）、真上から見ると深さ数 km でクリップされる。
// 2. 球（globe）では地表のタイルが深度を書き込む（裏側の半球を隠すため）。素直に描くと、
//    地下の点は**手前に見えている地面に隠されて 1 ピクセルも出ない**。
//
// どちらも「クリップ空間の z を自前で決める」ことで解ける。手前の薄い帯（u_slab）へ写し、
// 帯の中の位置はカメラからの距離で決める——**点どうしの前後関係は保ったまま、地図の描画物より
// 必ず手前**になる。透視投影では w_clip = -z_view なので、距離は w から取れる（この関係は
// globe の射影行列でも成り立つ。どちらも最後は透視変換だから）。
//
// **地図全体の深度精度には触らない**（transform の near/far を上書きすると他のレイヤーが
// z-fighting を起こす）。
// **下限を丸めないこと。** near より手前の点は t が負になり、クリップ空間の z が -1 を
// 下回って GPU に破棄される（従来と同じ挙動）。0 で丸めると、破棄される代わりに近クリップ面へ
// 貼り付いて描かれてしまう。
float slabZ(float w) {
  float t = min((w - u_nearZ) * u_invRange, 1.0);
  return (-1.0 + u_slab * t) * w;
}

// 深さ（z）にだけ誇張率を掛ける。水平方向は実スケールのまま。
vec4 projectDepthPoint(vec3 p) {
  vec4 pos = projectTileFor3D(p.xy, elevationForProjection(p.z * u_exaggeration, p.y));
  pos.z = slabZ(pos.w);
  return pos;
}
`.replace('MAX_UNDERGROUND_FRACTION_VALUE', MAX_UNDERGROUND_FRACTION.toFixed(2))

// 表示用。点は円で描き、縁に細い暗線を置いて背景から浮かせる。
const VERT_BODY = `
in vec3 a_pos;
in vec3 a_color;
in float a_size;
in float a_shape;
in float a_aux;
// 明滅の明側・暗側の不透明度。点ごとの不透明度は CPU 側で掛け込んである。
in float a_alphaHi;
in float a_alphaLo;
uniform float u_hideAux;
uniform float u_dpr;
out vec3 v_color;
out float v_shape;
out float v_alpha;
void main() {
  gl_Position = projectDepthPoint(a_pos);
  gl_PointSize = a_size * u_dpr;
  v_color = a_color;
  v_shape = a_shape;
  v_alpha = mix(a_alphaLo, a_alphaHi, u_blinkPhase);
  // 補助の点は、柄が潰れる状況では描かない（サイズ 0 でラスタライズされなくなる）。
  if (a_aux > 0.5 && u_hideAux > 0.5) gl_PointSize = 0.0;
}`

/** 点の形。震源は × 印、震央は円、といった描き分けに使う。 */
export type DepthPointShape = 'circle' | 'cross'

/** シェーダーへ渡す形の番号。属性で持たせるので、1 レイヤーに混在できる。 */
const SHAPE_ID: Record<DepthPointShape, number> = { circle: 0, cross: 1 }

const FRAG_SRC = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_shape;
in float v_alpha;
out vec4 fragColor;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float a;
  if (v_shape < 0.5) {
    // 円。縁だけアンチエイリアス（gl/subThresholdLayer.ts と同じ作り）。
    a = 1.0 - smoothstep(0.44, 0.5, length(p));
  } else {
    // 45 度に傾けた十字（× 印）。
    float arm = min(abs(p.x + p.y), abs(p.x - p.y));
    float w = fwidth(arm);
    a = 1.0 - smoothstep(0.10 - w, 0.10 + w, arm);
    a *= 1.0 - smoothstep(0.42, 0.48, length(p));
  }
  a *= v_alpha;
  if (a <= 0.0) discard;
  fragColor = vec4(v_color * a, a); // premultiplied
}`

// 判定用。**同じ頂点計算で、色を通し番号にして裏へ描く。** 表と裏がずれないよう、頂点シェーダーは
// 表示用と同じ式でなければならない（誇張率・傾き・回転が自動的に一致する）。
const PICK_VERT_BODY = `
in vec3 a_pos;
in float a_size;
in float a_id;
in float a_aux;
uniform float u_dpr;
uniform float u_hitPad;
uniform float u_hideAux;
out vec3 v_id;
void main() {
  gl_Position = projectDepthPoint(a_pos);
  // 小さい点は狙いにくいので、判定用だけ少し太らせる。
  gl_PointSize = (a_size + u_hitPad) * u_dpr;
  // 隠れている補助の点は判定からも外す。**表示と判定は同じ条件でなければならない**——
  // 見えていないものがクリックできると、点ごとに内容を出し分けたときに誤った結果を返す。
  if (a_aux > 0.5 && u_hideAux > 0.5) { gl_PointSize = 0.0; }
  // 通し番号を 24bit の RGB へ。0 は「何も無い」に使うので +1 してから詰める。
  float id = a_id + 1.0;
  float r = floor(mod(id, 256.0));
  float g = floor(mod(id / 256.0, 256.0));
  float b = floor(mod(id / 65536.0, 256.0));
  v_id = vec3(r, g, b) / 255.0;
}`

const PICK_FRAG_SRC = `#version 300 es
precision highp float;
in vec3 v_id;
out vec4 fragColor;
void main() {
  // **アンチエイリアスしない。** 色は番号そのものなので、混ざると別の点に化ける。
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  fragColor = vec4(v_id, 1.0);
}`

/** 柄の不透明度。点より控えめにして、主役が点であることを保つ。 */
const STEM_ALPHA = 0.55

const LINE_VERT_BODY = `
in vec3 a_pos;
in vec3 a_color;
in float a_alphaHi;
in float a_alphaLo;
out vec3 v_color;
out float v_alpha;
void main() {
  gl_Position = projectDepthPoint(a_pos);
  v_color = a_color;
  // 柄は点と同じ明滅に乗せる。別々に動かすと、繋がって見えない。
  v_alpha = mix(a_alphaLo, a_alphaHi, u_blinkPhase);
}`

const LINE_FRAG_SRC = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
out vec4 fragColor;
void main() {
  float a = STEM_ALPHA * v_alpha;
  fragColor = vec4(v_color * a, a); // premultiplied
}
`.replace(/STEM_ALPHA/g, STEM_ALPHA.toFixed(2))

/** 柄 1 本あたりの float 数（pos 3 + color 3 + 明滅 2）× 2 頂点。 */
const LINE_STRIDE_FLOATS = 8

/** 1 点あたりの float 数（pos 3 + color 3 + size 1 + id 1 + shape 1 + aux 1 + 明滅 2）。 */
const STRIDE_FLOATS = 12
const STRIDE_BYTES = STRIDE_FLOATS * 4

/** 点バッファの並び（属性名・要素数・バイト位置）。表示用と判定用が同じバッファを共有する。 */
const POINT_LAYOUT = [
  ['a_pos', 3, 0],
  ['a_color', 3, 12],
  ['a_size', 1, 24],
  ['a_id', 1, 28],
  ['a_shape', 1, 32],
  ['a_aux', 1, 36],
  ['a_alphaHi', 1, 40],
  ['a_alphaLo', 1, 44],
] as const

/** 柄バッファの並び。 */
const LINE_LAYOUT = [
  ['a_pos', 3, 0],
  ['a_color', 3, 12],
  ['a_alphaHi', 1, 24],
  ['a_alphaLo', 1, 28],
] as const

// 各プログラムが使う属性。**並び順がロケーション番号になる**（gl/projectionProgram.ts）。
// **判定用は明滅を持たない。** 暗い側の位相でも掴めないと、狙って押せない。
const DISPLAY_ATTRIBS = ['a_pos', 'a_color', 'a_size', 'a_shape', 'a_aux', 'a_alphaHi', 'a_alphaLo'] as const
const PICK_ATTRIBS = ['a_pos', 'a_size', 'a_id', 'a_aux'] as const
const LINE_ATTRIBS = ['a_pos', 'a_color', 'a_alphaHi', 'a_alphaLo'] as const

/**
 * 点の「明側・暗側」の不透明度。点ごとの不透明度と明滅を掛け合わせて 1 組にする。
 *
 * **ここで掛けておくことで、シェーダー側は 2 値を選ぶだけで済む。** 不透明度と明滅が
 * 掛け合わさるという関係が 1 箇所に閉じ、片方だけ変えて谷で消える事故を防げる。
 */
export function alphaPair(p: Pick<DepthPoint, 'alpha' | 'blink'>): [number, number] {
  const base = p.alpha ?? 1
  if (!p.blink) return [base, base]
  return [base * p.blink.high, base * p.blink.low]
}

/**
 * いまの点滅の位相（1 が明、0 が暗）。矩形の明滅で、周期の前半が明。
 *
 * **全点で共通の時計から決める。** 点ごとに位相を持たせるとばらばらに明滅して騒がしい。
 */
export function blinkPhaseAt(nowMs: number): number {
  return nowMs % BLINK_PERIOD_MS < BLINK_PERIOD_MS / 2 ? 1 : 0
}

/**
 * 点滅のための再描画予約。
 *
 * MapLibre は変化が無ければ描き直さないので、何もしないと位相が切り替わらず点滅が止まる
 * （CSS アニメーションと違い自走しない）。かといって毎フレーム要求すると、**1 秒に 2 回しか
 * 変わらない値のために 60fps で回し続ける**ことになる。次の切り替わりまでの残り時間だけ待つ。
 *
 * 描画のたびに `schedule()` が呼ばれるので、**予約は 1 本だけに保つ**。張り直すと、カメラ操作で
 * 描画が増えた分だけ予約も増え、同じ瞬間に何本もの再描画が重なる。
 */
export interface BlinkScheduler {
  /** 点滅する点があるかを伝える。無くなれば予約は止まる。 */
  setBlinking(value: boolean): void
  /** 次の切り替わりへ予約する（既に予約済み、または点滅が無ければ何もしない）。 */
  schedule(): void
  /** 予約を落とす。**レイヤーを外すときに必ず呼ぶ**（残すと消えた後も再描画を起こす）。 */
  dispose(): void
}

export function createBlinkScheduler(
  triggerRepaint: () => void,
  now: () => number = () => performance.now(),
): BlinkScheduler {
  let blinking = false
  // `setTimeout` の戻り値の型はブラウザ（number）と node（Timeout）で違う。ここでは中身を見ず
  // `clearTimeout` へ渡すだけなので、環境をまたいで通る形にしておく。
  let timer: ReturnType<typeof setTimeout> | undefined
  const half = BLINK_PERIOD_MS / 2
  return {
    setBlinking(value) {
      blinking = value
    },
    schedule() {
      if (!blinking || timer !== undefined) return
      // `globalThis` を通すのは、この部品だけをブラウザ環境を立てずに単体テストできるようにするため
      // （`window.` だと node の実行環境で落ちる）。
      timer = globalThis.setTimeout(
        () => {
          timer = undefined
          // 予約してから点滅が無くなっていることがある。**発火時にもう一度見る。**
          if (blinking) triggerRepaint()
        },
        half - (now() % half),
      )
    },
    dispose() {
      globalThis.clearTimeout(timer)
      timer = undefined
      blinking = false
    },
  }
}

/** 判定用に点を太らせる量（CSS px）。小さい点でも狙えるようにする。 */
const HIT_PAD_PX = 6

/** far をどれだけ余分に広げるか（最深点までの距離に対する倍率）。境界ちょうどでの取りこぼしを避ける。 */
const FAR_MARGIN = 1.2

/**
 * 柄がこの長さ（CSS px）を下回ったら、補助の点と柄を隠す。
 * 主役の点の半径ぶんに満たなければ、描いても重なって潰れるだけなので出さない。
 */
const MIN_STEM_PX = 10

/** 判定できる点数の上限。通し番号を 24bit の色へ詰めており、0 は「何も無い」に使う。 */
const MAX_PICKABLE_POINTS = 0xff_ff_ff - 1

/** 緯度と zoom での 1px（CSS px）あたりの実距離（m）。gl/viewSpan.ts の metersPerPixel と同じ式。 */
export function metersPerPixelAt(lat: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom))
}

/** 深さの帯に使う uniform 名。3 つのプログラムで同じものを使う。 */
const DEPTH_UNIFORMS = ['u_nearZ', 'u_invRange', 'u_slab'] as const

/**
 * 地下の点を写す「手前の帯」の厚み（クリップ空間 z の幅・-1 を基準）。
 *
 * 薄いほど地図の描画物に隠されにくく、厚いほど点どうしの前後関係を細かく表せる。0.02 なら
 * 24bit の深度バッファで 33 万段階が残り、長期カタログの 101 万点でも実用上ぶつからない。
 */
const DEPTH_SLAB = 0.02

/** 帯へ写すための係数（`slabZ` へ渡す）。 */
export interface DepthSlab {
  nearZ: number
  invRange: number
  slab: number
}

/**
 * カメラからの距離を「手前の帯」の位置へ写す係数。
 *
 * 距離の範囲は near から far までで、**このレイヤーで描く最深点までのぶんだけ far を広げる**
 * （広げないと、深い点がすべて帯の奥端に貼り付いて前後関係が潰れる）。
 */
export function depthSlabRange(nearZ: number, farZ: number, depthPx: number): DepthSlab {
  const far = farZ + depthPx * FAR_MARGIN
  return { nearZ, invRange: 1 / Math.max(far - nearZ, 1e-6), slab: DEPTH_SLAB }
}

/**
 * カメラからの距離 `w` を帯の中の位置（クリップ空間の z を w で割った値）へ写す。
 *
 * **シェーダー側の `slabZ` と同じ計算**（あちらは最後に w を掛けてクリップ空間へ戻す）。
 * ここに置いてあるのは、帯に収まること・near より手前が切られることを単体テストで固定するため。
 */
export function depthSlabNdc(slab: DepthSlab, distance: number): number {
  // **下限を丸めないこと。** near より手前は負になり、-1 を下回って GPU に破棄される。
  return -1 + slab.slab * Math.min((distance - slab.nearZ) * slab.invRange, 1)
}

/** 帯の係数を uniform へ送る。3 つのプログラムで共通。 */
function applyDepthSlab(
  gl: WebGL2RenderingContext,
  u: Record<(typeof DEPTH_UNIFORMS)[number], WebGLUniformLocation | null>,
  slab: DepthSlab,
): void {
  gl.uniform1f(u.u_nearZ, slab.nearZ)
  gl.uniform1f(u.u_invRange, slab.invRange)
  gl.uniform1f(u.u_slab, slab.slab)
}

/**
 * 柄（地表から震源までの縦線）が画面上で持つ長さ（CSS px）。
 *
 * **dpr で割らないこと。** `metersPerPixel` はタイル 512px を基準にした CSS px あたりの値なので、
 * ここで得られる長さも最初から CSS px。割ると Hi-DPI 端末でだけ閾値が dpr 倍きつくなり、
 * 震央の印と柄が消えやすくなる。
 */
export function stemScreenLengthPx(
  depthKm: number,
  exaggeration: number,
  metersPerPixel: number,
  pitchDeg: number,
): number {
  return ((depthKm * 1000) / metersPerPixel) * exaggeration * Math.sin((pitchDeg * Math.PI) / 180)
}

/**
 * 判定の結果。`pending` は「まだ解けていない」——呼び出し側は次のフレームで聞き直す。
 *
 * **`null`（何も無い）と区別できないと、タッチ操作で 1 回目が必ず空振りする。**
 * マウスなら `mousemove` が先に来て解決済みになるが、タッチは指が触れた瞬間が最初の入力で、
 * その時点では予約したばかりだから。
 */
export type DepthPickResult = number | null | 'pending'

export interface DepthPointLayer extends CustomLayerInterface {
  /** 描く点を差し替える。 */
  setPoints(points: readonly DepthPoint[]): void
  /** 深さ方向の誇張率。1 が実スケール。 */
  setExaggeration(value: number): void
  /**
   * 画面座標にある点の添字を返す（`setPoints` に渡した配列の位置）。無ければ null、
   * まだ解けていなければ 'pending'。
   *
   * `forClick` を立てた予約は、ホバー由来の呼び出しに上書きされない。
   *
   * **判定は描画ループの中で 1 フレーム遅れて解決する。** ここでは直近の結果だけを返し、
   * 座標が変わっていれば次のフレームぶんを予約して null を返す。MapLibre と WebGL の状態を
   * 共有しているため、描画ループの外から FBO を触ると内部のキャッシュと食い違うのを避けている。
   */
  pick(x: number, y: number, forClick?: boolean): DepthPickResult
}

export function createDepthPointLayer(id: string, map: MapLibreMap): DepthPointLayer {
  // 表示・判定・柄の 3 プログラム。**投影が切り替わると中身が作り直される**ため、
  // ロケーションはフレームごとにキャッシュから引く（gl/projectionProgram.ts）。
  const displayCache = createProjectionProgramCache({
    label: `depthPointLayer:${id}:display`,
    makeVertexSource: (prelude, define) =>
      `#version 300 es\n${prelude}\n${define}\n${SHARED_VERT}\n${VERT_BODY}`,
    fragmentSource: FRAG_SRC,
    attributes: DISPLAY_ATTRIBS,
    uniforms: ['u_exaggeration', 'u_dpr', ...DEPTH_UNIFORMS, 'u_hideAux', 'u_blinkPhase'] as const,
  })
  const pickCache = createProjectionProgramCache({
    label: `depthPointLayer:${id}:pick`,
    makeVertexSource: (prelude, define) =>
      `#version 300 es\n${prelude}\n${define}\n${SHARED_VERT}\n${PICK_VERT_BODY}`,
    fragmentSource: PICK_FRAG_SRC,
    attributes: PICK_ATTRIBS,
    uniforms: ['u_exaggeration', 'u_dpr', 'u_hitPad', ...DEPTH_UNIFORMS, 'u_hideAux'] as const,
  })
  const lineCache = createProjectionProgramCache({
    label: `depthPointLayer:${id}:stem`,
    makeVertexSource: (prelude, define) =>
      `#version 300 es\n${prelude}\n${define}\n${SHARED_VERT}\n${LINE_VERT_BODY}`,
    fragmentSource: LINE_FRAG_SRC,
    attributes: LINE_ATTRIBS,
    uniforms: ['u_exaggeration', ...DEPTH_UNIFORMS, 'u_blinkPhase'] as const,
  })
  let vao: WebGLVertexArrayObject | null = null
  let pickVao: WebGLVertexArrayObject | null = null
  let buffer: WebGLBuffer | null = null
  let fbo: WebGLFramebuffer | null = null
  let fboTex: WebGLTexture | null = null
  let fboSize: [number, number] = [0, 0]
  let count = 0
  let warnedDisabled = false
  let warnedFbo = false
  let warnedPointLimit = false
  const blink = createBlinkScheduler(() => map.triggerRepaint())
  let maxDepthKm = 0
  let lineVao: WebGLVertexArrayObject | null = null
  let lineBuffer: WebGLBuffer | null = null
  let lineVertexCount = 0
  let lineData: Float32Array = new Float32Array(0)
  let exaggeration = 1
  let data: Float32Array = new Float32Array(0)
  let dirty = false

  // 判定の予約と直近の結果。座標が一致する間はキャッシュを返す。
  let wantX = -1
  let wantY = -1
  /**
   * その予約がクリック由来か。**クリックの予約はホバーに上書きさせない。**
   * 枠は 1 つしかないので、トラックパッドの微動などでホバーが割り込むと、クリックが指した座標が
   * 一度も解かれないままリトライを使い切り、無言で失敗する。ホバーは次の機会があるが、
   * クリックは一度きり。
   */
  let wantForClick = false
  let doneX = -1
  let doneY = -1
  let doneHit: number | null = null
  /**
   * 判定を解いたときのカメラの状態。**画面座標が同じでも、カメラが動けば別の点が来る。**
   * このアプリは EEW 追従・揺れフォーカス・津波追従など、**マウスを伴わずにカメラが動く**経路を
   * 多く持つので（docs/spec/map-rendering-spec.md §6）、座標一致だけでキャッシュを使うと
   * 移動直後の最初のクリックが古い結果を返す。
   */
  let doneCamera = ''

  /**
   * 予約されている判定を「何も無い」で解決する。
   *
   * **描かずに抜ける経路はすべてここを通ること。** 予約を残したまま抜けると `pick()` は永久に
   * `'pending'` を返し、クリックはリトライを使い切って無言で失敗し、ホバーは解決を待って
   * `triggerRepaint()` を呼び続ける。
   */
  const resolvePendingPickAsMiss = () => {
    if (wantX < 0) return
    doneHit = null
    doneX = wantX
    doneY = wantY
    doneCamera = cameraSignature()
    wantX = -1
    wantY = -1
    wantForClick = false
  }

  /** 判定のキャッシュを捨てる。点・誇張率・カメラのいずれが変わっても呼ぶ。 */
  const invalidatePick = () => {
    doneX = -1
    doneY = -1
    doneHit = null
    doneCamera = ''
  }

  /** いまのカメラの状態を表す文字列。ここが変われば同じ画面座標でも別の点を指す。 */
  const cameraSignature = (): string => {
    const c = map.getCenter()
    const el = map.getContainer()
    return [
      c.lng.toFixed(6),
      c.lat.toFixed(6),
      map.getZoom().toFixed(4),
      map.getBearing().toFixed(2),
      map.getPitch().toFixed(2),
      el.clientWidth,
      el.clientHeight,
    ].join('/')
  }

  /**
   * VAO へ頂点バッファの読み方を仕込む。
   *
   * **番号は `*_ATTRIBS` の並び順で固定してある**（リンク前に `bindAttribLocation` で決めている）。
   * 投影が切り替わるとプログラムは別物になるが、番号が揃っているので VAO は作り直さずに済む。
   */
  const bindAttribs = (gl: WebGL2RenderingContext, layout: readonly (readonly [string, number, number])[], attribs: readonly string[], stride: number) => {
    for (const [name, size, offset] of layout) {
      const loc = attribs.indexOf(name)
      if (loc < 0) continue
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset)
    }
  }

  /** 判定用の FBO をキャンバスの実寸へ合わせる（初回とリサイズ時に作り直す）。 */
  const ensureFbo = (gl: WebGL2RenderingContext, w: number, h: number) => {
    if (fbo && fboSize[0] === w && fboSize[1] === h) return
    if (fboTex) gl.deleteTexture(fboTex)
    if (fbo) gl.deleteFramebuffer(fbo)
    fboTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, fboTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0)
    // **不完全な FBO は例外を投げない。** 描画は素通りし、readPixels は常に 0 を返すので、
    // 判定は「何も無い」と確定的に誤答する（リトライにも入らない）。ここで気づけないと
    // 「クリックしても何も起きない」だけが残り、手掛かりが何も出ない。
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      // ホバーのたびに ensureFbo を通るので、抑制しないとコンソールが埋まる
      // （シェーダー失敗と同じく一度きりにする）。
      if (!warnedFbo) {
        warnedFbo = true
        log.error(`[depthPointLayer:${id}] 判定用フレームバッファが不完全です`, { status, width: w, height: h })
      }
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(fboTex)
      fbo = null
      fboTex = null
      fboSize = [0, 0]
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      return
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)
    fboSize = [w, h]
  }

  const layer: DepthPointLayer = {
    id,
    type: 'custom',
    // 深度バッファを正しく共有するため 3d を指定する（地下の点どうしの前後関係が付く）。
    renderingMode: '3d',

    onAdd(_m, gl2) {
      const gl = gl2 as WebGL2RenderingContext
      // **プログラムはここでは作らない。** どの投影のシェーダーが要るかは render の引数で初めて
      // 分かるうえ、途中で切り替わる。VAO だけ先に用意しておく（属性の番号は固定してある）。
      buffer = gl.createBuffer()
      vao = gl.createVertexArray()
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      bindAttribs(gl, POINT_LAYOUT, DISPLAY_ATTRIBS, STRIDE_BYTES)
      pickVao = gl.createVertexArray()
      gl.bindVertexArray(pickVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      bindAttribs(gl, POINT_LAYOUT, PICK_ATTRIBS, STRIDE_BYTES)
      lineBuffer = gl.createBuffer()
      lineVao = gl.createVertexArray()
      gl.bindVertexArray(lineVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer)
      bindAttribs(gl, LINE_LAYOUT, LINE_ATTRIBS, LINE_STRIDE_FLOATS * 4)
      gl.bindVertexArray(null)
      dirty = true
    },

    render(gl2, args) {
      const gl = gl2 as WebGL2RenderingContext
      const display = displayCache.get(gl, args)
      const picker = pickCache.get(gl, args)
      if (!display || !picker || !vao) {
        // シェーダーのリンクに失敗している。原因はキャッシュ側で 1 度記録されるが、以後は
        // 「描かれない・クリックできない」だけが延々続く。**その状態にいることを 1 度だけ残す。**
        if (!warnedDisabled) {
          warnedDisabled = true
          log.error(`[depthPointLayer:${id}] シェーダーを用意できず、描画と判定を止めています`)
        }
        resolvePendingPickAsMiss()
        return
      }
      const u = display.u
      const pu = picker.u
      const dpr = window.devicePixelRatio || 1
      // MapLibre の far は地下を含まない。**このレイヤーで描く最深点までが入るぶんだけ広げる**
      // （闇雲に伸ばすと深度精度が落ち、点どうしの前後関係が乱れる）。
      const mpp = metersPerPixelAt(map.getCenter().lat, map.getZoom())
      const depthPx = ((maxDepthKm * 1000) / mpp) * exaggeration
      const slab = depthSlabRange(args.nearZ, args.farZ, depthPx)
      const phase = blinkPhaseAt(performance.now())
      // 柄が画面上でどれだけの長さになるか。**傾き・深さ・誇張率のどれが小さくても短くなる**ので、
      // ここ 1 箇所で「重なって潰れるか」を判定できる（透視は無視した近似で、判定には足りる）。
      const hideAux = stemScreenLengthPx(maxDepthKm, exaggeration, mpp, map.getPitch()) < MIN_STEM_PX

      if (dirty) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
        if (lineBuffer) {
          gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer)
          gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW)
        }
        dirty = false
      }
      if (count === 0) {
        resolvePendingPickAsMiss()
        return
      }

      // --- 柄（点より先に描く。点が上に来る） ---
      const line = lineVertexCount > 0 && !hideAux ? lineCache.get(gl, args) : null
      if (line && lineVao) {
        gl.useProgram(line.program)
        gl.bindVertexArray(lineVao)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        applyProjectionUniforms(gl, line.u, args)
        gl.uniform1f(line.u.u_exaggeration, exaggeration)
        gl.uniform1f(line.u.u_blinkPhase, phase)
        applyDepthSlab(gl, line.u, slab)
        gl.drawArrays(gl.LINES, 0, lineVertexCount)
        gl.bindVertexArray(null)
      }

      // --- 点 ---
      gl.useProgram(display.program)
      gl.bindVertexArray(vao)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      applyProjectionUniforms(gl, u, args)
      gl.uniform1f(u.u_exaggeration, exaggeration)
      gl.uniform1f(u.u_dpr, dpr)
      applyDepthSlab(gl, u, slab)
      gl.uniform1f(u.u_hideAux, hideAux ? 1 : 0)
      gl.uniform1f(u.u_blinkPhase, phase)
      gl.drawArrays(gl.POINTS, 0, count)
      gl.bindVertexArray(null)
      gl.disable(gl.BLEND)
      // **位相が変わる瞬間にだけ再描画を予約する。** MapLibre は変化が無ければ描き直さないので、
      // 何もしないと位相が切り替わらず点滅が止まる（CSS アニメーションと違い自走しない）。
      // 毎フレーム `triggerRepaint()` を呼べば動くが、**1 秒に 2 回しか変わらない値のために
      // 60fps で回し続けることになる**。次の切り替わりまでの残り時間だけ待つ。
      blink.schedule()

      // --- 判定（予約があるときだけ） ---
      if (wantX < 0) return
      const canvas = gl.canvas as HTMLCanvasElement
      const pw = canvas.width
      const ph = canvas.height
      ensureFbo(gl, pw, ph)
      if (!fbo) {
        resolvePendingPickAsMiss()
        return
      }
      // 読む 1px。WebGL の原点は左下、マウス座標は左上なので y を反転する。
      // 画面のちょうど端（最上端・右端）では丸めた結果が範囲外になり、scissor が空振りして
      // 「何も無い」と誤答する。範囲内へ収める。
      const px = Math.min(pw - 1, Math.max(0, Math.round(wantX * dpr)))
      const py = Math.min(ph - 1, Math.max(0, Math.round(ph - wantY * dpr)))
      const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.viewport(0, 0, pw, ph)
      // **読む 1px だけ描く。** 頂点処理は全点走るが、ラスタライズはここに限られる。
      gl.enable(gl.SCISSOR_TEST)
      gl.scissor(px, py, 1, 1)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.disable(gl.BLEND)
      gl.useProgram(picker.program)
      gl.bindVertexArray(pickVao)
      applyProjectionUniforms(gl, pu, args)
      gl.uniform1f(pu.u_exaggeration, exaggeration)
      gl.uniform1f(pu.u_dpr, dpr)
      gl.uniform1f(pu.u_hitPad, HIT_PAD_PX)
      applyDepthSlab(gl, pu, slab)
      gl.uniform1f(pu.u_hideAux, hideAux ? 1 : 0)
      gl.drawArrays(gl.POINTS, 0, count)
      const buf = new Uint8Array(4)
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      gl.bindVertexArray(null)
      gl.disable(gl.SCISSOR_TEST)
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)
      gl.viewport(0, 0, pw, ph)

      // 0 は「何も無い」。描くときに +1 しているので戻す。
      const raw = buf[0] + buf[1] * 256 + buf[2] * 65536
      doneHit = raw === 0 ? null : raw - 1
      doneX = wantX
      doneY = wantY
      doneCamera = cameraSignature()
      wantX = -1
      wantY = -1
      wantForClick = false
    },

    onRemove(_m, gl2) {
      const gl = gl2 as WebGL2RenderingContext
      // 予約を残すと、レイヤーが消えた後も再描画を起こし続ける。
      blink.dispose()
      displayCache.dispose(gl)
      pickCache.dispose(gl)
      lineCache.dispose(gl)
      if (vao) gl.deleteVertexArray(vao)
      if (pickVao) gl.deleteVertexArray(pickVao)
      if (buffer) gl.deleteBuffer(buffer)
      if (lineVao) gl.deleteVertexArray(lineVao)
      if (lineBuffer) gl.deleteBuffer(lineBuffer)
      if (fboTex) gl.deleteTexture(fboTex)
      if (fbo) gl.deleteFramebuffer(fbo)
      vao = pickVao = null
      buffer = null
      lineVao = null
      lineBuffer = null
      fbo = null
      fboTex = null
      fboSize = [0, 0]
    },

    setPoints(points) {
      count = points.length
      // 通し番号は 24bit の色として運ぶ。0 を「何も無い」に使うぶん 1 つ減る。
      // 超えると番号が衝突し、**別の点をクリックしたことになる**（描画は正常に見える）。
      if (count > MAX_PICKABLE_POINTS && !warnedPointLimit) {
        // 呼ばれるたびに出すとコンソールが埋まる（他の失敗ログと同じく一度きりにする）。
        warnedPointLimit = true
        log.error(
          `[depthPointLayer:${id}] 点が多すぎて判定の番号が衝突します（${count} 件 / 上限 ${MAX_PICKABLE_POINTS} 件）`,
        )
      }
      maxDepthKm = 0
      let anyBlink = false
      data = new Float32Array(count * STRIDE_FLOATS)
      for (let i = 0; i < count; i++) {
        const p = points[i]
        const [x, y, z] = toMercator(p.lng, p.lat, p.depthKm)
        const o = i * STRIDE_FLOATS
        data[o] = x
        data[o + 1] = y
        data[o + 2] = z
        data[o + 3] = p.color[0]
        data[o + 4] = p.color[1]
        data[o + 5] = p.color[2]
        data[o + 6] = p.sizePx
        data[o + 7] = i
        data[o + 8] = SHAPE_ID[p.shape ?? 'circle']
        data[o + 9] = p.auxiliary ? 1 : 0
        // **明滅は不透明度に掛け込んでおく。** シェーダー側は 2 値を選ぶだけで済み、
        // 「不透明度と明滅の積」という関係が 1 箇所に閉じる。
        const [hi, lo] = alphaPair(p)
        data[o + 10] = hi
        data[o + 11] = lo
        if (hi !== lo) anyBlink = true
        if (p.depthKm > maxDepthKm) maxDepthKm = p.depthKm
      }
      // 柄（地表からその点までの縦線）。stem を立てた点のぶんだけ 2 頂点ずつ作る。
      const stems = points.filter((p) => p.stem)
      lineVertexCount = stems.length * 2
      lineData = new Float32Array(lineVertexCount * LINE_STRIDE_FLOATS)
      stems.forEach((p, k) => {
        const top = toMercator(p.lng, p.lat, 0)
        const bottom = toMercator(p.lng, p.lat, p.depthKm)
        const [hi, lo] = alphaPair(p)
        const base = k * 2 * LINE_STRIDE_FLOATS
        for (const [j, v] of [top, bottom].entries()) {
          const q = base + j * LINE_STRIDE_FLOATS
          lineData[q] = v[0]
          lineData[q + 1] = v[1]
          lineData[q + 2] = v[2]
          lineData[q + 3] = p.color[0]
          lineData[q + 4] = p.color[1]
          lineData[q + 5] = p.color[2]
          lineData[q + 6] = hi
          lineData[q + 7] = lo
        }
      })
      blink.setBlinking(anyBlink)
      dirty = true
      // 判定のキャッシュは点が変わった時点で無効。
      invalidatePick()
      map.triggerRepaint()
      blink.schedule()
    },

    setExaggeration(value) {
      if (exaggeration === value) return
      exaggeration = value
      invalidatePick()
      map.triggerRepaint()
    },

    pick(x, y, forClick = false) {
      if (count === 0) return null
      if (Math.round(x) === doneX && Math.round(y) === doneY && cameraSignature() === doneCamera) {
        return doneHit
      }
      // まだ解けていない。次のフレームで解いてもらい、呼び出し側には 'pending' と伝える
      // （null を返すと「何も無い」と区別できず、タッチの 1 回目が空振りする）。
      // クリックの予約が生きている間は、ホバーで奪わない。
      if (!(wantForClick && !forClick && wantX >= 0)) {
        wantX = Math.round(x)
        wantY = Math.round(y)
        wantForClick = forClick
      }
      map.triggerRepaint()
      return 'pending'
    },
  }

  return layer
}
