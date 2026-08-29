import * as maplibregl from 'maplibre-gl'
import { applyProjectionUniforms, createProjectionProgramCache } from './projectionProgram'
import { SHINDO0_COLOR } from '../../../utils/kyoshinIntensity'

// 強震モニタの震度0以下（index 1〜6）を描く MapLibre カスタムレイヤーの GL 実装。
// Leaflet の KyoshinSubThreshold は「同レベルのドット同士が重なっても濃くならない」非加算合成
// （SVG の <g opacity> 単位合成）を行う。これを WebGL で厳密に再現するため、レベルごとにオフスクリーン
// FBO へ不透明描画してから opacity で本描画先へ over 合成する（① 同レベル非加算 / ② レベル間加算）。
// 実装方式は PoC（poc/subthreshold-rt.ts）で計測・実証済みの「インデックスバッファ方式」:
//   - 座標（Mercator）は静的で不動。1 本の STATIC_DRAW バッファに詰める。
//   - 毎秒変わるのはレベル割り当てだけ。レベル順に並べた index（Uint16・DYNAMIC_DRAW）を
//     カウンティングソート O(n) で作り、bufferSubData で差し替える（約3.4KB・1回）だけ。
//   - レベルごとの drawElements レンジ（rangeStart/rangeCount）で該当点だけ描く。
//
// feature-state は paint 式経由でカスタムレイヤーには効かないため、毎秒更新は setLevels（カウンティング
// ソート）＋呼び出し側の triggerRepaint で反映する。

// 対象は index 1〜6（震度0以下）。index 0 はデータ無し（subThresholdOpacity(0)=0）で非表示。
// 呼び出し側の KyoshinSubThresholdGL.tsx でも levels[] 値域の上限として使うため export する。
export const MAX_SUB_IDX = 6
// 本番の実半径（BASE_RADIUS×iconScale）。Leaflet 版 KyoshinSubThreshold と揃える。
const BASE_RADIUS = 2.5
// index バッファは Uint16Array のため 65,535 点が上限（強震モニタは約1,725点で十分収まる）。
const MAX_UINT16_POINTS = 65535

// index 0→0、index 6→0.35 の指数カーブ（Leaflet 版 subThresholdOpacity と一致）。
export function subThresholdOpacity(idx: number): number {
  if (idx <= 0) return 0
  const t = idx / MAX_SUB_IDX
  return ((Math.exp(t) - 1) / (Math.E - 1)) * 0.35
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// 頂点シェーダーの本体。座標変換は MapLibre が配る投影シェーダーに任せる（gl/projectionProgram.ts）ため、
// `#version` と prelude はプログラム生成側で前置きする。
const POINT_VS_BODY = `
uniform float u_size;
in vec2 a_pos;
void main() {
  gl_Position = projectTile(a_pos);
  gl_PointSize = u_size;
}`

/** 点プログラムの属性。**並び順がロケーション番号になる。** */
const POINT_ATTRIBS = ['a_pos'] as const

const POINT_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = 1.0 - smoothstep(0.44, 0.5, d); // 縁だけアンチエイリアス
  if (a <= 0.0) discard;
  fragColor = vec4(u_color.rgb * a, a);      // premultiplied。中心(a=1)は上書き＝同レベル重なりで濃くならない
}`

const QUAD_VS = `#version 300 es
in vec2 a_quad;
out vec2 v_uv;
void main() {
  v_uv = a_quad * 0.5 + 0.5;
  gl_Position = vec4(a_quad, 0.0, 1.0);
}`

const QUAD_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_opacity;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec4 t = texture(u_tex, v_uv);            // premultiplied
  fragColor = t * u_opacity;                // レベル opacity を掛けて premultiplied over 合成
}`

export interface SubThresholdLayer {
  /** MapLibre へ addLayer する custom レイヤー本体。 */
  layer: maplibregl.CustomLayerInterface
  /** 毎秒の震度更新。levels は各点のレベル(0〜6)。GPU 反映と再描画は呼び出し側の triggerRepaint。 */
  setLevels(levels: Uint8Array): void
  /** UI 倍率の変化で点の半径を更新（次フレームから反映）。呼び出し側で triggerRepaint する。 */
  setIconScale(scale: number): void
  /**
   * 表示/非表示を切り替える。custom レイヤーは style spec の visibility layout プロパティを
   * 持たないため、render() 冒頭でこのフラグを見て早期リターンする自前実装で代替する。
   * 非表示中も render() 自体は呼ばれうる（他レイヤー由来の repaint 等）ため、そのたびに
   * FBO への多重描画が走らないようここで止める。
   */
  setVisible(visible: boolean): void
}

// 観測点座標（Mercator の Float32Array・[x,y] を n 点分）を受け取り、カスタムレイヤーを生成する。
export function makeSubThresholdLayer(
  positions: Float32Array,
  n: number,
  initialIconScale: number,
): SubThresholdLayer {
  if (n > MAX_UINT16_POINTS) {
    console.warn(
      `[subthreshold] 観測点数 ${n} は Uint16 index の上限(${MAX_UINT16_POINTS})を超えるためクランプする`,
    )
    n = MAX_UINT16_POINTS
  }
  const COLOR = hexToRgb(SHINDO0_COLOR)
  let iconScale = initialIconScale

  // レベル順 index と、レベルごとの描画レンジ(start/count)。index 0 も並ぶが描画しない。
  const sortedIndices = new Uint16Array(n)
  const rangeStart = new Int32Array(MAX_SUB_IDX + 1) // lv 0..6
  const rangeCount = new Int32Array(MAX_SUB_IDX + 1)
  let dirtyIdx = false // setLevels 後、次の render で index を bufferSubData する必要がある

  // レベル配列 → レベル順 index（カウンティングソート O(n)）。dirtyIdx を立てる（GPU 反映は render）。
  const countingSort = (levels: Uint8Array): void => {
    rangeCount.fill(0)
    for (let i = 0; i < n; i++) rangeCount[levels[i]]++
    let acc = 0
    for (let lv = 0; lv <= MAX_SUB_IDX; lv++) {
      rangeStart[lv] = acc
      acc += rangeCount[lv]
    }
    const cursor = Int32Array.from(rangeStart)
    for (let i = 0; i < n; i++) {
      const lv = levels[i]
      sortedIndices[cursor[lv]++] = i
    }
    dirtyIdx = true
  }

  let visible = true

  // 初期は全点 index 0（非表示）。最初の setLevels で実データが入る。
  countingSort(new Uint8Array(n))
  dirtyIdx = false

  // 点は投影ごとにプログラムを持つ（globe と Mercator を行き来する）。
  // 合成用のフルスクリーン矩形は投影に依らないので、こちらは従来どおり 1 本だけ作る。
  const pointCache = createProjectionProgramCache({
    label: 'subthreshold',
    makeVertexSource: (prelude, define) => `#version 300 es
${prelude}
${define}
${POINT_VS_BODY}`,
    fragmentSource: POINT_FS,
    attributes: POINT_ATTRIBS,
    uniforms: ['u_size', 'u_color'] as const,
  })
  let quadProg: WebGLProgram
  let fbo: WebGLFramebuffer
  let tex: WebGLTexture
  let posBuf: WebGLBuffer
  let idxBuf: WebGLBuffer
  let quadBuf: WebGLBuffer
  let texW = 0
  let texH = 0
  /** 点の属性は番号を固定してあるので、プログラムが差し替わっても VAO 相当の設定は変わらない。 */
  const aPos = POINT_ATTRIBS.indexOf('a_pos')
  let uTex: WebGLUniformLocation | null
  let uOpacity: WebGLUniformLocation | null
  let aQuad = 0
  let mapRef: maplibregl.Map

  const compile = (gl: WebGL2RenderingContext, type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s))
    return s
  }
  const linkProg = (gl: WebGL2RenderingContext, vs: string, fs: string) => {
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p))
    return p
  }

  const layer: maplibregl.CustomLayerInterface = {
    id: 'kyoshin-subthreshold',
    type: 'custom',
    onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext) {
      mapRef = map
      quadProg = linkProg(gl, QUAD_VS, QUAD_FS)
      uTex = gl.getUniformLocation(quadProg, 'u_tex')
      uOpacity = gl.getUniformLocation(quadProg, 'u_opacity')
      aQuad = gl.getAttribLocation(quadProg, 'a_quad')

      // 座標は静的（1本・不動）。index で参照する。
      posBuf = gl.createBuffer()!
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
      // index バッファ（DYNAMIC_DRAW・毎秒 bufferSubData で並べ替えだけ差し替える）
      idxBuf = gl.createBuffer()!
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sortedIndices, gl.DYNAMIC_DRAW)
      quadBuf = gl.createBuffer()!
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      )
      fbo = gl.createFramebuffer()!
      tex = gl.createTexture()!
    },
    render(gl: WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput) {
      if (!visible) return
      // **GL の状態を触る前に取ること。** 下のリサイズ処理は自前の FBO を bind したまま進み、
      // 本描画先へ戻すのは関数末尾の復元処理。その手前で抜けると、以後 MapLibre が発行する描画が
      // このレイヤーのオフスクリーンテクスチャへ流れ込み、**画面が更新されなくなる**。
      const point = pointCache.get(gl, args)
      // シェーダーを用意できなければ描かない（原因はキャッシュ側が記録する）。
      if (!point) return
      const canvas = mapRef.getCanvas()
      const w = canvas.width
      const h = canvas.height
      // render 開始時の本描画 FBO（MapLibre のメイン描画先）を resize より前に控える。resize は内部で fbo を
      // bind するため、後ろに置くと初回フレームで mainFBO=fbo になり feedback loop になる（PoC MEDIUM1）。
      const mainFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      if (texW !== w || texH !== h) {
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
        gl.bindTexture(gl.TEXTURE_2D, null)
        texW = w
        texH = h
      }

      // setLevels が立てた dirty をこのフレームで GPU に反映する（index の bufferSubData・約3.4KB・1回）。
      if (dirtyIdx) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, sortedIndices)
        dirtyIdx = false
      }

      const dpr = window.devicePixelRatio || 1
      const size = BASE_RADIUS * 2 * dpr * iconScale

      // scissor 最適化は敷かない（平常時 index1 は全国分散で BBox がほぼ全画面になり効かない・PoC LOW2）。
      for (let lv = 1; lv <= MAX_SUB_IDX; lv++) {
        const count = rangeCount[lv]
        if (!count) continue

        // ① オフスクリーン FBO へ「不透明」で描く（同レベル重なりは上書き＝濃くならない）。
        // feedback loop 回避（PoC MEDIUM1）: FBO を描画先にする前に、合成で bind した tex を外す。
        gl.bindTexture(gl.TEXTURE_2D, null)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.viewport(0, 0, w, h)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // premultiplied over（縁 a<1 のみ合成）
        gl.useProgram(point.program)
        applyProjectionUniforms(gl, point.u, args)
        gl.uniform1f(point.u.u_size, size)
        gl.uniform4f(point.u.u_color, COLOR[0], COLOR[1], COLOR[2], 1.0)
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
        gl.enableVertexAttribArray(aPos)
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
        gl.drawElements(gl.POINTS, count, gl.UNSIGNED_SHORT, rangeStart[lv] * 2) // offset はバイト(Uint16=2)

        // ② 本描画 FBO へ opacity を掛けて over 合成（レベル間は積み重なる）
        gl.bindFramebuffer(gl.FRAMEBUFFER, mainFBO)
        gl.viewport(0, 0, w, h)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // premultiplied over
        gl.useProgram(quadProg)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.uniform1i(uTex, 0)
        gl.uniform1f(uOpacity, subThresholdOpacity(lv))
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
        gl.enableVertexAttribArray(aQuad)
        gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        // 合成で使い終わった tex を即外す。次レベルの FBO 描画との feedback loop を断つ（PoC MEDIUM1）。
        gl.bindTexture(gl.TEXTURE_2D, null)
      }

      // GL 状態を復元（CustomLayerInterface の作法）。本描画先へ戻し、追加で bind したバッファ・tex も外す。
      gl.bindFramebuffer(gl.FRAMEBUFFER, mainFBO)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      gl.disable(gl.BLEND)
      gl.disableVertexAttribArray(aPos)
      gl.disableVertexAttribArray(aQuad)
    },
    onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext) {
      pointCache.dispose(gl)
      gl.deleteProgram(quadProg)
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(tex)
      gl.deleteBuffer(posBuf)
      gl.deleteBuffer(idxBuf)
      gl.deleteBuffer(quadBuf)
    },
  }

  return {
    layer,
    setLevels(levels: Uint8Array): void {
      countingSort(levels)
    },
    setIconScale(scale: number): void {
      iconScale = scale
    },
    setVisible(v: boolean): void {
      visible = v
    },
  }
}
