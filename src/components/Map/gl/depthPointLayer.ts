import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl'
import { log } from '../../../utils/logger'

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
// **このレイヤーは Mercator 投影を前提にしている。** 深さの扱い（far の差し替え）は透視投影の
// `w_clip = -z_view` に依存しており、これは Mercator では傾き・回転・ロールのいずれでも厳密に
// 成り立つが、**globe 投影では成り立たない**（MapLibre 本体も、単一の行列だけで完結する実装は
// Mercator 限定にしかならないと明記している）。globe を有効にするなら、ここは無警告で破綻する。

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
}

/** Web Mercator の赤道全周（m）。gl/viewSpan.ts と同じ値。 */
const EARTH_CIRCUMFERENCE_M = 40075016.686

/**
 * 緯度経度と深さを Mercator 座標（x, y, z）へ。
 *
 * z は MapLibre の `MercatorCoordinate` と同じ定義で、**メートルを緯度依存の係数で割った値**。
 * 地下は負になる。
 */
export function toMercator(lng: number, lat: number, depthKm: number): [number, number, number] {
  const x = (180 + lng) / 360
  const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360
  const mercPerMeter = 1 / (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180))
  return [x, y, -depthKm * 1000 * mercPerMeter]
}

// 表示用。点は円で描き、縁に細い暗線を置いて背景から浮かせる。
const VERT_SRC = `#version 300 es
precision highp float;
in vec3 a_pos;
in vec3 a_color;
in float a_size;
in float a_shape;
in float a_aux;
uniform mat4 u_matrix;
uniform float u_hideAux;
uniform float u_exaggeration;
uniform float u_dpr;
uniform float u_zA;
uniform float u_zB;
// **MapLibre の far では地下が切られる。**傾きが浅いほど far は切り詰められ
// （mercator_transform.ts: pitch 0 では地表までの距離の 1.01 倍）、真上から見ると深さ数 km で
// クリップされる。透視投影では w_clip = -z_view なので、w からビュー空間の深さを復元し、
// far を広げた射影での z へ置き換える。**このレイヤーの中だけで完結し、地図全体の深度精度には
// 触らない**（transform の near/far を上書きすると他のレイヤーが z-fighting を起こす）。
float farZ(float w) { return u_zA * (-w) + u_zB; }
out vec3 v_color;
out float v_shape;
void main() {
  // 深さ（z）にだけ誇張率を掛ける。水平方向は実スケールのまま。
  vec4 pos = u_matrix * vec4(a_pos.xy, a_pos.z * u_exaggeration, 1.0);
  pos.z = farZ(pos.w);
  gl_Position = pos;
  gl_PointSize = a_size * u_dpr;
  v_color = a_color;
  v_shape = a_shape;
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
  if (a <= 0.0) discard;
  fragColor = vec4(v_color * a, a); // premultiplied
}`

// 判定用。**同じ頂点計算で、色を通し番号にして裏へ描く。** 表と裏がずれないよう、頂点シェーダーは
// 表示用と同じ式でなければならない（誇張率・傾き・回転が自動的に一致する）。
const PICK_VERT_SRC = `#version 300 es
precision highp float;
in vec3 a_pos;
in float a_size;
in float a_id;
in float a_aux;
uniform mat4 u_matrix;
uniform float u_exaggeration;
uniform float u_dpr;
uniform float u_zA;
uniform float u_zB;
// **MapLibre の far では地下が切られる。**傾きが浅いほど far は切り詰められ
// （mercator_transform.ts: pitch 0 では地表までの距離の 1.01 倍）、真上から見ると深さ数 km で
// クリップされる。透視投影では w_clip = -z_view なので、w からビュー空間の深さを復元し、
// far を広げた射影での z へ置き換える。**このレイヤーの中だけで完結し、地図全体の深度精度には
// 触らない**（transform の near/far を上書きすると他のレイヤーが z-fighting を起こす）。
float farZ(float w) { return u_zA * (-w) + u_zB; }
uniform float u_hitPad;
uniform float u_hideAux;
out vec3 v_id;
void main() {
  vec4 pos = u_matrix * vec4(a_pos.xy, a_pos.z * u_exaggeration, 1.0);
  pos.z = farZ(pos.w);
  gl_Position = pos;
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

const LINE_VERT_SRC = `#version 300 es
precision highp float;
in vec3 a_pos;
in vec3 a_color;
uniform mat4 u_matrix;
uniform float u_exaggeration;
uniform float u_zA;
uniform float u_zB;
out vec3 v_color;
// 点と同じ差し替え。片方だけ直すと線と点がずれる。
float farZ(float w) { return u_zA * (-w) + u_zB; }
void main() {
  vec4 pos = u_matrix * vec4(a_pos.xy, a_pos.z * u_exaggeration, 1.0);
  pos.z = farZ(pos.w);
  gl_Position = pos;
  v_color = a_color;
}`

const LINE_FRAG_SRC = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 fragColor;
void main() { fragColor = vec4(v_color * STEM_ALPHA, STEM_ALPHA); } // premultiplied
`.replace(/STEM_ALPHA/g, STEM_ALPHA.toFixed(2))

/** 柄 1 本あたりの float 数（pos 3 + color 3）× 2 頂点。 */
const LINE_STRIDE_FLOATS = 6

/** 1 点あたりの float 数（pos 3 + color 3 + size 1 + id 1 + shape 1 + aux 1）。 */
const STRIDE_FLOATS = 10
const STRIDE_BYTES = STRIDE_FLOATS * 4

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

/**
 * 深さのぶんだけ広げた far での、クリップ空間 z の係数。
 *
 * MapLibre の far は地下を含まない（傾き 0 では地表までの距離の 1.01 倍）。透視投影の
 * `w_clip = -z_view` を使い、シェーダーで `z = zA * (-w) + zB` と置き換えるための係数を返す。
 */
export function depthClipCoefficients(
  nearZ: number,
  farZ: number,
  depthPx: number,
): { zA: number; zB: number } {
  const far = farZ + depthPx * FAR_MARGIN
  return { zA: (far + nearZ) / (nearZ - far), zB: (2 * far * nearZ) / (nearZ - far) }
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
  let program: WebGLProgram | null = null
  let pickProgram: WebGLProgram | null = null
  let vao: WebGLVertexArrayObject | null = null
  let pickVao: WebGLVertexArrayObject | null = null
  let buffer: WebGLBuffer | null = null
  let fbo: WebGLFramebuffer | null = null
  let fboTex: WebGLTexture | null = null
  let fboSize: [number, number] = [0, 0]
  let count = 0
  let warnedDisabled = false
  let warnedFbo = false
  let maxDepthKm = 0
  let lineVao: WebGLVertexArrayObject | null = null
  let lineBuffer: WebGLBuffer | null = null
  let lineProgram: WebGLProgram | null = null
  let lineVertexCount = 0
  let lineData: Float32Array = new Float32Array(0)
  const lu: Record<string, WebGLUniformLocation | null> = {}
  let exaggeration = 1
  let data: Float32Array = new Float32Array(0)
  let dirty = false
  const u: Record<string, WebGLUniformLocation | null> = {}
  const pu: Record<string, WebGLUniformLocation | null> = {}

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

  const compile = (gl: WebGL2RenderingContext, type: number, src: string): WebGLShader => {
    const s = gl.createShader(type) as WebGLShader
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      log.error(`[depthPointLayer:${id}] shader compile failed`, gl.getShaderInfoLog(s))
    }
    return s
  }

  /** リンクに失敗したら null を返す（失敗した program で useProgram すると別レイヤーを巻き込む）。 */
  const link = (gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null => {
    const v = compile(gl, gl.VERTEX_SHADER, vs)
    const f = compile(gl, gl.FRAGMENT_SHADER, fs)
    const p = gl.createProgram() as WebGLProgram
    gl.attachShader(p, v)
    gl.attachShader(p, f)
    gl.linkProgram(p)
    gl.deleteShader(v)
    gl.deleteShader(f)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      log.error(`[depthPointLayer:${id}] program link failed`, gl.getProgramInfoLog(p))
      gl.deleteProgram(p)
      return null
    }
    return p
  }

  const bindAttribs = (gl: WebGL2RenderingContext, prog: WebGLProgram, withColor: boolean) => {
    const pos = gl.getAttribLocation(prog, 'a_pos')
    gl.enableVertexAttribArray(pos)
    gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, STRIDE_BYTES, 0)
    if (withColor) {
      const col = gl.getAttribLocation(prog, 'a_color')
      gl.enableVertexAttribArray(col)
      gl.vertexAttribPointer(col, 3, gl.FLOAT, false, STRIDE_BYTES, 12)
    }
    const size = gl.getAttribLocation(prog, 'a_size')
    gl.enableVertexAttribArray(size)
    gl.vertexAttribPointer(size, 1, gl.FLOAT, false, STRIDE_BYTES, 24)
    if (withColor) {
      const shp = gl.getAttribLocation(prog, 'a_shape')
      gl.enableVertexAttribArray(shp)
      gl.vertexAttribPointer(shp, 1, gl.FLOAT, false, STRIDE_BYTES, 32)
      const aux = gl.getAttribLocation(prog, 'a_aux')
      gl.enableVertexAttribArray(aux)
      gl.vertexAttribPointer(aux, 1, gl.FLOAT, false, STRIDE_BYTES, 36)
    } else {
      const aid = gl.getAttribLocation(prog, 'a_id')
      gl.enableVertexAttribArray(aid)
      gl.vertexAttribPointer(aid, 1, gl.FLOAT, false, STRIDE_BYTES, 28)
      const auxPick = gl.getAttribLocation(prog, 'a_aux')
      gl.enableVertexAttribArray(auxPick)
      gl.vertexAttribPointer(auxPick, 1, gl.FLOAT, false, STRIDE_BYTES, 36)
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
      program = link(gl, VERT_SRC, FRAG_SRC)
      pickProgram = link(gl, PICK_VERT_SRC, PICK_FRAG_SRC)
      if (!program || !pickProgram) return
      for (const n of ['u_matrix', 'u_exaggeration', 'u_dpr', 'u_zA', 'u_zB', 'u_hideAux'])
        u[n] = gl.getUniformLocation(program, n)
      for (const n of ['u_matrix', 'u_exaggeration', 'u_dpr', 'u_hitPad', 'u_zA', 'u_zB', 'u_hideAux']) pu[n] = gl.getUniformLocation(pickProgram, n)

      buffer = gl.createBuffer()
      vao = gl.createVertexArray()
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      bindAttribs(gl, program, true)
      pickVao = gl.createVertexArray()
      gl.bindVertexArray(pickVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      bindAttribs(gl, pickProgram, false)
      lineProgram = link(gl, LINE_VERT_SRC, LINE_FRAG_SRC)
      if (!lineProgram) {
        // 点は描けるが柄だけ出ない状態になる。点側の失敗（render で記録）と非対称なので、
        // ここでも残しておかないと「柄が消えている」に対応する手掛かりが無い。
        log.error(`[depthPointLayer:${id}] 柄のシェーダーを用意できず、縦線を描きません`)
      }
      if (lineProgram) {
        for (const n of ['u_matrix', 'u_exaggeration', 'u_zA', 'u_zB']) lu[n] = gl.getUniformLocation(lineProgram, n)
        lineBuffer = gl.createBuffer()
        lineVao = gl.createVertexArray()
        gl.bindVertexArray(lineVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer)
        const lp = gl.getAttribLocation(lineProgram, 'a_pos')
        gl.enableVertexAttribArray(lp)
        gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, LINE_STRIDE_FLOATS * 4, 0)
        const lc = gl.getAttribLocation(lineProgram, 'a_color')
        gl.enableVertexAttribArray(lc)
        gl.vertexAttribPointer(lc, 3, gl.FLOAT, false, LINE_STRIDE_FLOATS * 4, 12)
      }
      gl.bindVertexArray(null)
      dirty = true
    },

    render(gl2, args) {
      const gl = gl2 as WebGL2RenderingContext
      if (!program || !pickProgram || !vao) {
        // シェーダーのリンクに失敗している。原因は onAdd で 1 度記録されるが、以後は
        // 「描かれない・クリックできない」だけが延々続く。**その状態にいることを 1 度だけ残す。**
        if (!warnedDisabled) {
          warnedDisabled = true
          log.error(`[depthPointLayer:${id}] シェーダーを用意できず、描画と判定を止めています`)
        }
        return
      }
      const matrix = args.defaultProjectionData.mainMatrix
      const dpr = window.devicePixelRatio || 1
      // MapLibre の far は地下を含まない。**このレイヤーで描く最深点までが入るぶんだけ広げる**
      // （闇雲に伸ばすと深度精度が落ち、点どうしの前後関係が乱れる）。
      const mpp = metersPerPixelAt(map.getCenter().lat, map.getZoom())
      const depthPx = ((maxDepthKm * 1000) / mpp) * exaggeration
      const { zA, zB } = depthClipCoefficients(args.nearZ, args.farZ, depthPx)
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
        // **予約を残したまま抜けてはいけない。** pick が永久に pending を返し、クリックが
        // リトライを使い切って無言で失敗する。
        if (wantX >= 0) {
          doneHit = null
          doneX = wantX
          doneY = wantY
          doneCamera = cameraSignature()
          wantX = -1
          wantY = -1
          wantForClick = false
        }
        return
      }

      // --- 柄（点より先に描く。点が上に来る） ---
      if (lineProgram && lineVao && lineVertexCount > 0 && !hideAux) {
        gl.useProgram(lineProgram)
        gl.bindVertexArray(lineVao)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.uniformMatrix4fv(lu.u_matrix, false, matrix)
        gl.uniform1f(lu.u_exaggeration, exaggeration)
        gl.uniform1f(lu.u_zA, zA)
        gl.uniform1f(lu.u_zB, zB)
        gl.drawArrays(gl.LINES, 0, lineVertexCount)
        gl.bindVertexArray(null)
      }

      // --- 点 ---
      gl.useProgram(program)
      gl.bindVertexArray(vao)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.uniformMatrix4fv(u.u_matrix, false, matrix)
      gl.uniform1f(u.u_exaggeration, exaggeration)
      gl.uniform1f(u.u_dpr, dpr)
      gl.uniform1f(u.u_zA, zA)
      gl.uniform1f(u.u_zB, zB)
      gl.uniform1f(u.u_hideAux, hideAux ? 1 : 0)
      gl.drawArrays(gl.POINTS, 0, count)
      gl.bindVertexArray(null)
      gl.disable(gl.BLEND)

      // --- 判定（予約があるときだけ） ---
      if (wantX < 0) return
      const canvas = gl.canvas as HTMLCanvasElement
      const pw = canvas.width
      const ph = canvas.height
      ensureFbo(gl, pw, ph)
      if (!fbo) {
        // 予約を消さないと、pick が永久に pending を返し続ける。
        wantX = -1
        wantY = -1
        wantForClick = false
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
      gl.useProgram(pickProgram)
      gl.bindVertexArray(pickVao)
      gl.uniformMatrix4fv(pu.u_matrix, false, matrix)
      gl.uniform1f(pu.u_exaggeration, exaggeration)
      gl.uniform1f(pu.u_dpr, dpr)
      gl.uniform1f(pu.u_hitPad, HIT_PAD_PX)
      gl.uniform1f(pu.u_zA, zA)
      gl.uniform1f(pu.u_zB, zB)
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
      if (program) gl.deleteProgram(program)
      if (pickProgram) gl.deleteProgram(pickProgram)
      if (vao) gl.deleteVertexArray(vao)
      if (pickVao) gl.deleteVertexArray(pickVao)
      if (buffer) gl.deleteBuffer(buffer)
      if (lineProgram) gl.deleteProgram(lineProgram)
      if (lineVao) gl.deleteVertexArray(lineVao)
      if (lineBuffer) gl.deleteBuffer(lineBuffer)
      if (fboTex) gl.deleteTexture(fboTex)
      if (fbo) gl.deleteFramebuffer(fbo)
      program = pickProgram = null
      vao = pickVao = null
      buffer = null
      lineProgram = null
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
      if (count > MAX_PICKABLE_POINTS) {
        log.error(
          `[depthPointLayer:${id}] 点が多すぎて判定の番号が衝突します（${count} 件 / 上限 ${MAX_PICKABLE_POINTS} 件）`,
        )
      }
      maxDepthKm = 0
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
        if (p.depthKm > maxDepthKm) maxDepthKm = p.depthKm
      }
      // 柄（地表からその点までの縦線）。stem を立てた点のぶんだけ 2 頂点ずつ作る。
      const stems = points.filter((p) => p.stem)
      lineVertexCount = stems.length * 2
      lineData = new Float32Array(lineVertexCount * LINE_STRIDE_FLOATS)
      stems.forEach((p, k) => {
        const top = toMercator(p.lng, p.lat, 0)
        const bottom = toMercator(p.lng, p.lat, p.depthKm)
        const base = k * 2 * LINE_STRIDE_FLOATS
        for (const [j, v] of [top, bottom].entries()) {
          const q = base + j * LINE_STRIDE_FLOATS
          lineData[q] = v[0]
          lineData[q + 1] = v[1]
          lineData[q + 2] = v[2]
          lineData[q + 3] = p.color[0]
          lineData[q + 4] = p.color[1]
          lineData[q + 5] = p.color[2]
        }
      })
      dirty = true
      // 判定のキャッシュは点が変わった時点で無効。
      invalidatePick()
      map.triggerRepaint()
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
