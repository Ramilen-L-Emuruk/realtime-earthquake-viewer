import * as maplibregl from 'maplibre-gl'
import type { OrderedCustomLayer } from './layerOrder'
import { applyProjectionUniforms, createProjectionProgramCache } from './projectionProgram'
import { SHINDO0_COLOR } from '../../../utils/kyoshinIntensity'
import { guardRender } from './guardRender'
import { clearRenderFailure, clearRenderFailuresFor, reportRenderFailure } from '../../../utils/renderHealth'
import { log } from '../../../utils/logger'

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
// レイヤー ID と、描画の不調を知らせるときの表示名（`utils/renderHealth.ts`）。
const LYR = 'kyoshin-subthreshold'
const LABEL = '弱い揺れの観測点'

// **id と表示名は 1 箇所に置く。** 載せる側（`KyoshinSubThresholdGL.tsx`）も不調の記録に同じ値が
// 要るので、あちらで文字列を書き直すと片方だけ古くなる（以前は id のリテラルが二重にあった）。
export { LYR as SUB_THRESHOLD_LAYER_ID, LABEL as SUB_THRESHOLD_LABEL }

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
  layer: OrderedCustomLayer
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
  /** 画面へ「描けていない」と出している状態か。直ったら取り下げるために持つ。 */
  let brokenReported = false
  /** シェーダーを用意できない旨をログへ残したか（毎フレーム通るので 1 度だけ）。 */
  let warnedDisabled = false

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
  /**
   * 合成用のプログラム。**用意できなければ null。**
   *
   * `onAdd` は投げない（下記 `linkProg`）。投げると MapLibre はレイヤーを登録したまま
   * （`Style.addLayer` は `_layers[id]` へ入れてから `onAdd` を呼ぶ）`render()` を回し続け、
   * 載せる側の再追加は `if (map.getLayer(id))` で弾かれる —— **作り直す機会が二度と来ない。**
   */
  let quadProg: WebGLProgram | null = null
  // **GL の生成関数は失敗しても例外ではなく null を返す**（文脈を失っているとき等）。
  // 非 null と決めつけると、`fbo` が null のまま `bindFramebuffer` を通って
  // **描画先が既定のフレームバッファ（画面そのもの）へ切り替わる** ——
  // オフスクリーンへ不透明で描くつもりの合成が本画面へ直に乗る。
  let fbo: WebGLFramebuffer | null = null
  let tex: WebGLTexture | null = null
  let posBuf: WebGLBuffer | null = null
  let idxBuf: WebGLBuffer | null = null
  let quadBuf: WebGLBuffer | null = null
  let texW = 0
  let texH = 0
  /** 点の属性は番号を固定してあるので、プログラムが差し替わっても VAO 相当の設定は変わらない。 */
  const aPos = POINT_ATTRIBS.indexOf('a_pos')
  let uTex: WebGLUniformLocation | null = null
  let uOpacity: WebGLUniformLocation | null = null
  let aQuad = 0
  let mapRef: maplibregl.Map

  /**
   * シェーダーを 1 つ作る。**失敗しても投げず null を返す**（理由は `quadProg` の説明）。
   *
   * 記録にはソースも残す。`gl/projectionProgram.ts` の `compile` と同じ流儀。
   */
  const compile = (gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type)
    if (!s) {
      // **生成関数は失敗しても例外ではなく null を返す**（文脈を失っているとき等）。
      log.error(`[${LYR}] シェーダーを作成できません`)
      return null
    }
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      log.error(`[${LYR}] shader compile failed`, gl.getShaderInfoLog(s), src)
      gl.deleteShader(s)
      return null
    }
    return s
  }

  /**
   * 合成用のプログラムを作る。**失敗しても投げず null を返す。**
   *
   * **リンクに失敗したプログラムを返してはならない。** WebGL は未リンクのプログラムへの
   * `useProgram` で例外を投げず、直前の別レイヤーのシェーダーが残ったまま描画が走る。
   */
  const linkProg = (gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null => {
    const vertex = compile(gl, gl.VERTEX_SHADER, vs)
    const fragment = vertex ? compile(gl, gl.FRAGMENT_SHADER, fs) : null
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex)
      return null
    }
    const p = gl.createProgram()
    if (!p) {
      log.error(`[${LYR}] プログラムを作成できません`)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
      return null
    }
    gl.attachShader(p, vertex)
    gl.attachShader(p, fragment)
    gl.linkProgram(p)
    // アタッチ済みなら削除はリンク後でよい（GL が参照を持つ）。付けっぱなしにすると溜まる。
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      log.error(`[${LYR}] program link failed`, gl.getProgramInfoLog(p))
      gl.deleteProgram(p)
      return null
    }
    return p
  }

  const layer: OrderedCustomLayer = {
    id: LYR,
    type: 'custom',
    onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext) {
      mapRef = map
      // **新しい文脈で作り直させるため、抱えているプログラムを捨てる**（理由は
      // `gl/projectionProgram.ts` の `dispose`）。**GL の資源を作る前に置く。**
      pointCache.dispose(gl)
      // **オフスクリーンテクスチャの寸法の覚えも、ここで落とす。** 下で作り直す `tex` は
      // まだ寸法を持たず、`fbo` には何も付いていない。文脈を作り直したときはキャンバスの
      // 実寸が前と同じことがあり、覚えが残ると描画側の張り直し（`texW !== w`）を素通りして
      // **色を付ける先が無いまま**描き続ける。不完全な FBO への描画は例外も投げない。
      //
      // **資源を作る前に置く。** いまは `onAdd` に投げる経路が無い（`linkProg` は null を返す）が、
      // 後ろへ置くと、途中で抜ける経路を足したときにこのリセットだけが飛ぶ。
      texW = 0
      texH = 0
      // 診断の「一度きり」も文脈ごとに戻す（`gl/depthPointLayer.ts` と同じ扱い）。
      warnedDisabled = false
      quadProg = linkProg(gl, QUAD_VS, QUAD_FS)
      if (quadProg) {
        uTex = gl.getUniformLocation(quadProg, 'u_tex')
        uOpacity = gl.getUniformLocation(quadProg, 'u_opacity')
        aQuad = gl.getAttribLocation(quadProg, 'a_quad')
      }

      // 座標は静的（1本・不動）。index で参照する。
      posBuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
      // index バッファ（DYNAMIC_DRAW・毎秒 bufferSubData で並べ替えだけ差し替える）
      idxBuf = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sortedIndices, gl.DYNAMIC_DRAW)
      quadBuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      )
      fbo = gl.createFramebuffer()
      tex = gl.createTexture()
    },
    render: guardRender(LYR, LABEL, (gl: WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput) => {
      if (!visible) return
      // **GL の状態を触る前に取ること。** 下のリサイズ処理は自前の FBO を bind したまま進み、
      // 本描画先へ戻すのは関数末尾の復元処理。その手前で抜けると、以後 MapLibre が発行する描画が
      // このレイヤーのオフスクリーンテクスチャへ流れ込み、**画面が更新されなくなる**。
      const point = pointCache.get(gl, args)
      // **シェーダーと GL の資源が揃っていなければ、GL を触る前に抜ける。**
      // 揃っていない状態で進むと、`bindFramebuffer` が描画先を画面そのものへ切り替えたり、
      // バッファの無い `vertexAttribPointer` が内部のエラーフラグだけを立てたりする ——
      // **どれも例外にならない**（`gl.getError()` はこのリポジトリのどこでも読んでいない）。
      if (!point || !quadProg || !posBuf || !idxBuf || !quadBuf || !fbo || !tex) {
        // **用意できないことを画面へ出す**（docs/spec/map-rendering-spec.md §16）。
        // ここは例外を投げないので `guardRender` の検出には掛からず、黙ると
        // 「なぜか震度0以下の点だけ出ない」が手掛かりなしで続く。
        if (!warnedDisabled) {
          warnedDisabled = true
          log.error(
            `[${LYR}] シェーダーまたは GL の資源を用意できず、弱い揺れの観測点の描画を止めています`,
          )
        }
        brokenReported = true
        reportRenderFailure(LYR, LABEL, 'draw')
        return
      }
      if (brokenReported) {
        // 投影が切り替わってプログラムを作り直せたら通ることがある。**直ったら画面から消す。**
        brokenReported = false
        clearRenderFailure(LYR, 'draw')
      }
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
    }),
    onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext) {
      // **画面から外れたら不調の記録も消す**（docs/spec/map-rendering-spec.md §16）。
      // `guardRender.ts` が受け止めた例外の記録も、この 1 行でまとめて消える。
      clearRenderFailuresFor(LYR)
      // **2 つとも戻す。** 片方だけ残すと、次に載せたとき症状が変わっても包括のログが
      // 二度と出ない（`gl/dayNightLayer.ts` と同じ理由）。
      brokenReported = false
      warnedDisabled = false
      pointCache.dispose(gl)
      // **`delete*` は null を渡しても無害に無視される**ので、ここは揃えてガードを置かない。
      gl.deleteProgram(quadProg)
      quadProg = null
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(tex)
      gl.deleteBuffer(posBuf)
      gl.deleteBuffer(idxBuf)
      gl.deleteBuffer(quadBuf)
      fbo = null
      tex = null
      posBuf = null
      idxBuf = null
      quadBuf = null
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
      if (visible === v) return
      visible = v
      // **隠したら「描けていない」も取り下げる**（docs/spec/map-rendering-spec.md §16）。
      // `render()` は `!visible` で資源の判定より手前に抜けるので、**壊れた状態で隠すと
      // 取り下げる機会が無い** ——意図的に隠しているだけなのにバナーが残り続ける。
      // `gl/depthPointLayer.ts` の `setVisible` と同じ扱い。
      if (!v && brokenReported) {
        brokenReported = false
        clearRenderFailure(LYR, 'draw')
      }
    },
  }
}
