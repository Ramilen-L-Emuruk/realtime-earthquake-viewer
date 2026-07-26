// 【PoC専用・使い捨て】検証項目7: EEW発報シナリオの複合負荷。
//
// 項目1(律速切り分け)・項目5(非加算合成)・項目6(毎秒更新)・項目5×6交差点(カスタムレイヤーの毎秒更新)は
// いずれも実機でクリア済み（docs/webgl-rendering-migration-plan.md §6）。ただしこれらは各要素を単独で
// 測ったものであり、本番の EEW 発報中に実際に同時発生する負荷の組み合わせ（flyTo によるカメラ移動＋
// 予報円の高頻度アニメ＋強震点の毎秒更新＋EEW領域ポリゴンの追加/削除）は未検証だった。
//
// 本番の EEW 発報時に地図で何が起きるか（JapanMap.tsx / PsWaveLayer.tsx / useDmdssWaves.ts を調査）:
//   - flyTo は単発ではない。新規発報時（flyTo 単独 or flyToBounds・duration 0.8s）・予報円の成長に伴う
//     再フィット（flyToBounds・duration 0.8s）・EEW解除時（flyToBounds JAPAN_BOUNDS・duration 1.0s）と
//     断続的に複数回発火する（JapanMap.tsx 201-351行付近）。
//   - 予報円（PsWaveLayer.tsx）は 100ms 周期（useDmdssWaves.ts UPDATE_INTERVAL_MS）で再計算され、
//     生 Canvas に ctx.arc で毎回描き直す。ただし **zoomstart〜zoomend の間は再描画をスキップする**
//     （PsWaveLayer.tsx 116-120行）＝本番は「flyTo中は予報円を止める」設計で緩和済み。
//   - 強震点の毎秒更新は項目6でfeature-state採用済み。flyToとは独立に走り続ける。
//   - setDataが効く唯一の局面はEEW領域ポリゴンの追加/削除（震源確定・解除）で、項目6のsetDataのように
//     同じ点数のまま属性だけ変わるのではなく、フィーチャの個数自体が変わる（より本番に忠実なsetData）。
//
// 本PoCの構成（ユーザー確認済み・2026-07-27）:
//   - 予報円は最初からカスタムレイヤー前提で実装する（P波=リング・S波=後端フェード付き扇形）。
//   - 強震点は項目5×6で採用したインデックスバッファ方式のカスタムレイヤーをそのまま流用する
//     （項目6のKyoshinPoints標準circleより重い実装なので、複合負荷としては悪い方＝最悪ケース）。
//   - flyTo中の予報円再描画停止（本番の緩和）を維持する場合／しない場合の両方を測る。
//
// 計測モード:
//   - baseline         : 何も動かない床
//   - flyto-only       : flyToシーケンス＋EEW領域setDataのみ（強震点・予報円の更新なし）＝カメラ操作単独
//   - composite-pause  : flyto-only＋強震点毎秒更新＋予報円100ms更新（flyTo中は予報円更新を一時停止＝本番の緩和を再現）
//   - composite-nopause: composite-pauseと同じだが予報円更新を止めない＝最悪ケース
//
// 判定: composite-pause が flyto-only と同程度なら「複合負荷でも問題なし」＝GO。composite-nopause で
//       悪化するなら「flyTo中の再描画停止という本番の緩和策はMapLibre側でも維持すべき」という設計制約が
//       判明する。詳細は docs/webgl-rendering-migration-plan.md §6「検証項目7」参照。
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Polygon, LineString } from 'geojson'

// --- 定数（本体 JapanMap.tsx / kyoshinIntensity.ts・testData.ts と揃える） ---
const JAPAN_CENTER: [number, number] = [137.7, 38.25] // MapLibre は [lng, lat]
const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'
const START_ZOOM = 5
// JapanMap.tsx MAX_ZOOM(171行)と同値。EEW発報時のflyTo着地ズーム。
const MAX_ZOOM = 8
// JapanMap.tsx JAPAN_BOUNDS(160行、Leaflet [lat,lng]順)をMapLibre[lng,lat]順に変換
const JAPAN_BOUNDS: [[number, number], [number, number]] = [
  [129.43, 30.99],
  [145.82, 45.52],
]
// JapanMap.tsxの実測値は秒(Leaflet)。MapLibreのdurationはミリ秒のため換算する。
const FLYTO_DURATION_MS = 800 // JapanMap.tsx duration:0.8 相当（EEW新規発報・予報円成長フィット）
const CLEAR_FLYTO_DURATION_MS = 1000 // JapanMap.tsx duration:1.0 相当（EEW解除→JAPAN_BOUNDS）
// testData.ts createTestEEW（三陸沖 M7.2・特別警報シナリオ）の震源を流用
const EPICENTER: [number, number] = [142.9, 38.1]
// 本番はテストボタンでEEWが約30秒で自動解除される（CLAUDE.md）。シナリオもこれに合わせる。
const SCENARIO_MS = 30000
// 2度目のflyTo（予報円成長に伴う再フィット）を発火するタイミング（既定シナリオ長のときの基準値。
// durationMsOverrideで短縮する場合はrunScenario内でscenarioMsに応じて縮尺する）
const SECOND_FLYTO_MS = 3000

// 強震点カスタムレイヤー（項目5×6 poc/subthreshold-rt.ts のインデックスバッファ方式を流用）
const MAX_SUB_IDX = 6
const TARGET_POINTS = 1725
const SHINDO0_COLOR = '#9ca3af'
const BASE_RADIUS = 2.5

// 予報円（P波/S波）。実際の走時計算(useDmdssWaves.ts)ではなく、負荷測定用の簡易定速モデルで近似する
// （本PoCの目的は視覚的精度ではなく100ms周期の再描画コストの再現）。
const P_WAVE_KM_S = 7.0 // P波の目安速度
const S_WAVE_KM_S = 4.0 // eew.ts の S_WAVE_FALLBACK_KM_PER_SEC と同値
const MAX_WAVE_KM = 400 // 30秒シナリオ内(S波で最大120km)では実質頭打ちにならない上限
const TRAILING_WIDTH_KM = 60 // S波後端フェード帯の幅（PsWaveLayer.tsxの比率フェードを定数に簡略化）
const WAVE_UPDATE_INTERVAL_MS = 100 // useDmdssWaves.ts UPDATE_INTERVAL_MS と同値
const WAVE_SEGMENTS = 48 // 円の分割数（負荷測定用途では視覚精度より頂点数の軽さを優先）

// 本番 kyoshin モードのベースマップ配色（BaseMap.tsx と一致）
const LAND_FILL = '#161b24'
const SUBREGION_BORDER = '#39414f'
const PREF_BORDER = '#56607a'
const EEW_AREA_FILL = '#f59e0b'
const REPORT_URL = '/__perf-report'
const SETTLE_TIMEOUT_MS = 5000
const DRAIN_MS = 1000
// フレーム落ちの判定閾値。vsync天井(16.7ms@60Hz)の概ね2倍を「明確なコマ落ち」とみなす
// （項目6レビューの「10ms台は実機で2倍ばらつく」を踏まえ、通常のばらつきと区別する）
const DROPPED_FRAME_MS = 33.4

type Mode = 'baseline' | 'flyto-only' | 'composite-pause' | 'composite-nopause'

// index 0→0、index 6→0.35 の指数カーブ（subthreshold-rt.ts と同一）
function subThresholdOpacity(idx: number): number {
  if (idx <= 0) return 0
  const t = idx / MAX_SUB_IDX
  return ((Math.exp(t) - 1) / (Math.E - 1)) * 0.35
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// 毎秒の更新レベルを生成: 全点にランダムな index(1..6)（レビュー HIGH1 の教訓・index 0 は含めない）
function genLevels(n: number): Uint8Array {
  const a = new Uint8Array(n)
  for (let i = 0; i < n; i++) a[i] = ((Math.random() * MAX_SUB_IDX) | 0) + 1
  return a
}

// baseline/flyto-onlyの静止床に使う固定レベル（index 1〜6を巡回。poc/subthreshold-rt.tsのinitLevelsと
// 同じ考え方）。全点index0（非表示）だと render() が全レベルをスキップしてカスタムレイヤーの描画・再描画
// コストが基準線に一切乗らず、EEW発報中は強震点が必ず表示されているという本番の実態からも外れる
// （レビュー b4524cd HIGH1）。
function initKyoshinLevels(n: number): Uint8Array {
  const a = new Uint8Array(n)
  for (let i = 0; i < n; i++) a[i] = (i % MAX_SUB_IDX) + 1
  return a
}

// WebGLシェーダーのコンパイル/リンク（makeKyoshinLayer・makeWaveLayerで共用）
function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s))
  return s
}
function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p))
  return p
}

// --- 強震点カスタムレイヤー（poc/subthreshold-rt.ts のインデックスバッファ方式を簡略移植。
//     naive比較・等価性検証は項目5×6で決着済みのためcustomの片道のみ実装する） ---
function makeKyoshinLayer(positions: Float32Array, n: number) {
  const COLOR = hexToRgb(SHINDO0_COLOR)
  const sortedIndices = new Uint16Array(n)
  const rangeStart = new Int32Array(MAX_SUB_IDX + 1)
  const rangeCount = new Int32Array(MAX_SUB_IDX + 1)
  let dirtyIdx = false

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

  // 初期は静止床（index 1〜6を巡回。レビュー b4524cd HIGH1: 全点index0だと描画0点になり基準線から
  // カスタムレイヤーの描画コストが抜ける）
  countingSort(initKyoshinLevels(n))
  dirtyIdx = false

  let pointProg: WebGLProgram
  let quadProg: WebGLProgram
  let fbo: WebGLFramebuffer
  let tex: WebGLTexture
  let posBuf: WebGLBuffer
  let idxBuf: WebGLBuffer
  let quadBuf: WebGLBuffer
  let texW = 0
  let texH = 0
  let uMatrix: WebGLUniformLocation | null
  let uSize: WebGLUniformLocation | null
  let uColor: WebGLUniformLocation | null
  let aPos = 0
  let uTex: WebGLUniformLocation | null
  let uOpacity: WebGLUniformLocation | null
  let aQuad = 0
  let mapRef: maplibregl.Map

  const POINT_VS = `#version 300 es
uniform mat4 u_matrix;
uniform float u_size;
in vec2 a_pos;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  gl_PointSize = u_size;
}`
  const POINT_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = 1.0 - smoothstep(0.44, 0.5, d);
  if (a <= 0.0) discard;
  fragColor = vec4(u_color.rgb * a, a);
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
  vec4 t = texture(u_tex, v_uv);
  fragColor = t * u_opacity;
}`

  const layer = {
    id: 'kyoshin-sub',
    type: 'custom',
    onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext) {
      mapRef = map
      pointProg = linkProgram(gl, POINT_VS, POINT_FS)
      quadProg = linkProgram(gl, QUAD_VS, QUAD_FS)
      uMatrix = gl.getUniformLocation(pointProg, 'u_matrix')
      uSize = gl.getUniformLocation(pointProg, 'u_size')
      uColor = gl.getUniformLocation(pointProg, 'u_color')
      aPos = gl.getAttribLocation(pointProg, 'a_pos')
      uTex = gl.getUniformLocation(quadProg, 'u_tex')
      uOpacity = gl.getUniformLocation(quadProg, 'u_opacity')
      aQuad = gl.getAttribLocation(quadProg, 'a_quad')

      posBuf = gl.createBuffer()!
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
      idxBuf = gl.createBuffer()!
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sortedIndices, gl.DYNAMIC_DRAW)
      quadBuf = gl.createBuffer()!
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
      fbo = gl.createFramebuffer()!
      tex = gl.createTexture()!
    },
    render(gl: WebGL2RenderingContext, args: { defaultProjectionData: { mainMatrix: Float32Array } }) {
      const canvas = mapRef.getCanvas()
      const canvasW = canvas.width
      const canvasH = canvas.height
      const mainFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      if (texW !== canvasW || texH !== canvasH) {
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvasW, canvasH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
        gl.bindTexture(gl.TEXTURE_2D, null)
        texW = canvasW
        texH = canvasH
      }
      if (dirtyIdx) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, sortedIndices)
        dirtyIdx = false
      }

      const matrix = args.defaultProjectionData.mainMatrix
      const dpr = window.devicePixelRatio || 1
      const size = BASE_RADIUS * 2 * dpr

      for (let lv = 1; lv <= MAX_SUB_IDX; lv++) {
        const count = rangeCount[lv]
        if (!count) continue
        gl.bindTexture(gl.TEXTURE_2D, null)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.viewport(0, 0, canvasW, canvasH)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.useProgram(pointProg)
        gl.uniformMatrix4fv(uMatrix, false, matrix)
        gl.uniform1f(uSize, size)
        gl.uniform4f(uColor, COLOR[0], COLOR[1], COLOR[2], 1.0)
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
        gl.enableVertexAttribArray(aPos)
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
        gl.drawElements(gl.POINTS, count, gl.UNSIGNED_SHORT, rangeStart[lv] * 2)

        gl.bindFramebuffer(gl.FRAMEBUFFER, mainFBO)
        gl.viewport(0, 0, canvasW, canvasH)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.useProgram(quadProg)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.uniform1i(uTex, 0)
        gl.uniform1f(uOpacity, subThresholdOpacity(lv))
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
        gl.enableVertexAttribArray(aQuad)
        gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        gl.bindTexture(gl.TEXTURE_2D, null)
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, mainFBO)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      gl.disable(gl.BLEND)
      gl.disableVertexAttribArray(aPos)
      gl.disableVertexAttribArray(aQuad)
    },
    onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext) {
      gl.deleteProgram(pointProg)
      gl.deleteProgram(quadProg)
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(tex)
      gl.deleteBuffer(posBuf)
      gl.deleteBuffer(idxBuf)
      gl.deleteBuffer(quadBuf)
    },
  }

  return {
    layer: layer as maplibregl.CustomLayerInterface,
    apply(levels: Uint8Array): void {
      countingSort(levels)
    },
    reset(): void {
      countingSort(initKyoshinLevels(n))
      mapRef?.triggerRepaint()
    },
  }
}

// --- 予報円カスタムレイヤー（P波=リング・S波=後端フェード付き扇形。項目5×6と異なりFBO合成は不要
//     ——P波とS波は同一レベル内の非加算合成を要求されないため、単純な通常アルファブレンドで足りる） ---
function makeWaveLayer() {
  let ringProg: WebGLProgram
  let fanProg: WebGLProgram
  let ringBuf: WebGLBuffer
  let fanBuf: WebGLBuffer
  let ringVertexCount = 0
  let fanVertexCount = 0
  let hasData = false
  let uRingMatrix: WebGLUniformLocation | null
  let uRingColor: WebGLUniformLocation | null
  let aRingPos = 0
  let uFanMatrix: WebGLUniformLocation | null
  let uFanColor: WebGLUniformLocation | null
  let uFanInnerT: WebGLUniformLocation | null
  let aFanPos = 0
  let aFanT = 0

  const RING_VS = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
void main() { gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0); }`
  const RING_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 fragColor;
void main() { fragColor = u_color; }`
  // a_t: 中心=0・外周=1（扇形の各三角形は合同なため、この2値の線形補間だけで中心からの距離比率が正しく求まる）
  const FAN_VS = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
in float a_t;
out float v_t;
void main() {
  v_t = a_t;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`
  const FAN_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
uniform float u_innerT;
in float v_t;
out vec4 fragColor;
void main() {
  float a = smoothstep(u_innerT, min(u_innerT + 0.2, 1.0), v_t) * u_color.a;
  if (a <= 0.0) discard;
  fragColor = vec4(u_color.rgb, a);
}`

  // fragment shaderのu_innerTはdraw時に読むだけなので、update()からrender()へ値を渡すために保持する
  let sInnerRatioForShader = 0
  let mapRef: maplibregl.Map | null = null

  // update()で計算した幾何をrender()の冒頭でGPUへアップロードするためのdirtyフラグ方式
  // （poc/subthreshold-rt.tsのdirtyIdxと同じ考え方。レビュー b4524cd HIGH2: 以前はupdate()が
  // renderサイクル外でgl.bufferDataを呼んでおり、CustomLayerInterfaceの作法から外れるとともに、
  // waveApplyの計測値に「幾何計算」と「GPUアップロード」が混在し、項目5×6のapply（純粋CPU）と
  // 横並び比較できなくなっていた）。
  let dirtyWave = false
  let pendingRingPos: Float32Array | null = null
  let pendingFanData: Float32Array | null = null
  let pendingFanCount = 0
  let pendingSInnerRatio = 0

  const layer = {
    id: 'eew-wave',
    type: 'custom',
    onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext) {
      mapRef = map
      ringProg = linkProgram(gl, RING_VS, RING_FS)
      fanProg = linkProgram(gl, FAN_VS, FAN_FS)
      uRingMatrix = gl.getUniformLocation(ringProg, 'u_matrix')
      uRingColor = gl.getUniformLocation(ringProg, 'u_color')
      aRingPos = gl.getAttribLocation(ringProg, 'a_pos')
      uFanMatrix = gl.getUniformLocation(fanProg, 'u_matrix')
      uFanColor = gl.getUniformLocation(fanProg, 'u_color')
      uFanInnerT = gl.getUniformLocation(fanProg, 'u_innerT')
      aFanPos = gl.getAttribLocation(fanProg, 'a_pos')
      aFanT = gl.getAttribLocation(fanProg, 'a_t')
      ringBuf = gl.createBuffer()!
      fanBuf = gl.createBuffer()!
    },
    render(gl: WebGL2RenderingContext, args: { defaultProjectionData: { mainMatrix: Float32Array } }) {
      if (dirtyWave) {
        if (pendingRingPos) {
          gl.bindBuffer(gl.ARRAY_BUFFER, ringBuf)
          gl.bufferData(gl.ARRAY_BUFFER, pendingRingPos, gl.DYNAMIC_DRAW)
          ringVertexCount = WAVE_SEGMENTS
        }
        if (pendingFanData) {
          gl.bindBuffer(gl.ARRAY_BUFFER, fanBuf)
          gl.bufferData(gl.ARRAY_BUFFER, pendingFanData, gl.DYNAMIC_DRAW)
          fanVertexCount = pendingFanCount
        }
        sInnerRatioForShader = pendingSInnerRatio
        dirtyWave = false
        pendingRingPos = null
        pendingFanData = null
      }
      if (!hasData) return
      const matrix = args.defaultProjectionData.mainMatrix
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

      if (fanVertexCount > 0) {
        gl.useProgram(fanProg)
        gl.uniformMatrix4fv(uFanMatrix, false, matrix)
        gl.uniform4f(uFanColor, 1.0, 60 / 255, 0, 0.35) // #ff3c00 相当（PsWaveLayer.tsxのS波色）
        gl.uniform1f(uFanInnerT, sInnerRatioForShader)
        gl.bindBuffer(gl.ARRAY_BUFFER, fanBuf)
        gl.enableVertexAttribArray(aFanPos)
        gl.vertexAttribPointer(aFanPos, 2, gl.FLOAT, false, 12, 0)
        gl.enableVertexAttribArray(aFanT)
        gl.vertexAttribPointer(aFanT, 1, gl.FLOAT, false, 12, 8)
        gl.drawArrays(gl.TRIANGLE_FAN, 0, fanVertexCount)
        gl.disableVertexAttribArray(aFanT)
      }
      if (ringVertexCount > 0) {
        gl.useProgram(ringProg)
        gl.uniformMatrix4fv(uRingMatrix, false, matrix)
        gl.uniform4f(uRingColor, 56 / 255, 189 / 255, 248 / 255, 0.9) // #38bdf8 相当（PsWaveLayer.tsxのP波色）
        gl.bindBuffer(gl.ARRAY_BUFFER, ringBuf)
        gl.enableVertexAttribArray(aRingPos)
        gl.vertexAttribPointer(aRingPos, 2, gl.FLOAT, false, 0, 0)
        gl.drawArrays(gl.LINE_LOOP, 0, ringVertexCount)
      }

      gl.disable(gl.BLEND)
      gl.disableVertexAttribArray(aRingPos)
      gl.disableVertexAttribArray(aFanPos)
    },
    onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext) {
      gl.deleteProgram(ringProg)
      gl.deleteProgram(fanProg)
      gl.deleteBuffer(ringBuf)
      gl.deleteBuffer(fanBuf)
    },
  }

  return {
    layer: layer as maplibregl.CustomLayerInterface,
    // pRadiusKm/sRadiusKmを中心(EPICENTER)からのメルカトル座標に変換し頂点データを作り直す。
    // 幾何そのものが毎回変わるため（項目5×6のnaive-rebuildと同種）作り直し自体は避けられないが、
    // GPUへのアップロードはrender()の冒頭でdirtyWaveを見て行う（レビュー b4524cd HIGH2）。
    // ここでは幾何計算のみ行い、GL呼び出しは一切しない——waveApplyの計測値を項目5×6のapply
    // （純粋CPU）と揃えるため。
    update(pRadiusKm: number, sRadiusKm: number, sInnerRadiusKm: number): void {
      const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng: EPICENTER[0], lat: EPICENTER[1] })
      const metersToMerc = mc.meterInMercatorCoordinateUnits()

      const ringPos = new Float32Array(WAVE_SEGMENTS * 2)
      const pRadiusMerc = pRadiusKm * 1000 * metersToMerc
      for (let i = 0; i < WAVE_SEGMENTS; i++) {
        const a = (i / WAVE_SEGMENTS) * Math.PI * 2
        ringPos[i * 2] = mc.x + pRadiusMerc * Math.cos(a)
        ringPos[i * 2 + 1] = mc.y + pRadiusMerc * Math.sin(a)
      }

      // 扇形: 中心(t=0) + 外周点(t=1) × (WAVE_SEGMENTS+1)（最後に最初の外周点を複製して閉じる）
      const fanCount = WAVE_SEGMENTS + 2
      const fanData = new Float32Array(fanCount * 3)
      fanData[0] = mc.x
      fanData[1] = mc.y
      fanData[2] = 0
      const sRadiusMerc = sRadiusKm * 1000 * metersToMerc
      for (let i = 0; i <= WAVE_SEGMENTS; i++) {
        const a = ((i % WAVE_SEGMENTS) / WAVE_SEGMENTS) * Math.PI * 2
        const o = (i + 1) * 3
        fanData[o] = mc.x + sRadiusMerc * Math.cos(a)
        fanData[o + 1] = mc.y + sRadiusMerc * Math.sin(a)
        fanData[o + 2] = 1
      }

      pendingRingPos = ringPos
      pendingFanData = fanData
      pendingFanCount = fanCount
      pendingSInnerRatio = sRadiusKm > 0 ? Math.min(1, sInnerRadiusKm / sRadiusKm) : 0
      dirtyWave = true
      hasData = true
      mapRef?.triggerRepaint()
    },
    clear(): void {
      hasData = false
      ringVertexCount = 0
      fanVertexCount = 0
      pendingRingPos = null
      pendingFanData = null
      dirtyWave = false
      mapRef?.triggerRepaint()
    },
  }
}

// --- ベースマップ（poc/subthreshold-rt.ts の loadBasemap をそのまま流用） ---
type Ringed = { rings: [number, number][][] }
async function loadBasemap(): Promise<{
  fill: FeatureCollection<Polygon>
  prefLines: FeatureCollection<LineString>
  subLines: FeatureCollection<LineString>
  vertexCount: number
}> {
  const [prefs, subs] = await Promise.all([
    fetch('/data/prefectures.json').then((r) => r.json() as Promise<Record<string, Ringed>>),
    fetch('/data/subregions.json').then((r) => r.json() as Promise<Ringed[]>),
  ])
  const fill: FeatureCollection<Polygon>['features'] = []
  const prefLines: FeatureCollection<LineString>['features'] = []
  const subLines: FeatureCollection<LineString>['features'] = []
  let v = 0
  for (const shape of Object.values(prefs)) {
    for (const ring of shape.rings) {
      const coords = ring.map(([lat, lng]) => [lng, lat] as [number, number])
      v += coords.length * 2
      fill.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } })
      prefLines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } })
    }
  }
  for (const sr of subs) {
    for (const ring of sr.rings) {
      const coords = ring.map(([lat, lng]) => [lng, lat] as [number, number])
      v += coords.length
      subLines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } })
    }
  }
  return {
    fill: { type: 'FeatureCollection', features: fill },
    prefLines: { type: 'FeatureCollection', features: prefLines },
    subLines: { type: 'FeatureCollection', features: subLines },
    vertexCount: v,
  }
}

async function loadPositions(): Promise<Float32Array> {
  const d: { stations: Record<string, [number, number]> } = await fetch(
    '/data/station-coords.json',
  ).then((r) => r.json())
  const coords = Object.values(d.stations)
  const step = Math.max(1, Math.floor(coords.length / TARGET_POINTS))
  const sampled = coords.filter((_, i) => i % step === 0).slice(0, TARGET_POINTS)
  const arr = new Float32Array(sampled.length * 2)
  sampled.forEach(([lat, lon], i) => {
    const m = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat })
    arr[i * 2] = m.x
    arr[i * 2 + 1] = m.y
  })
  return arr
}

// --- 地図生成 ---
const map = new maplibregl.Map({
  container: 'map',
  center: JAPAN_CENTER,
  zoom: START_ZOOM,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      gebco: { type: 'raster', tiles: [BATHYMETRY_URL], tileSize: 256, maxzoom: 7 },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } },
      { id: 'gebco', type: 'raster', source: 'gebco' },
    ],
  },
})

let kyoshin: ReturnType<typeof makeKyoshinLayer>
let wave: ReturnType<typeof makeWaveLayer>
let pointCount = 0
let basemapVertices = 0
// EEW領域ポリゴン候補（本番のBaseMap.tsx 'eew-region-fill'相当。地理的な正確さより「フィーチャの
// 個数が変わるsetData」を再現することが目的のため、loadBasemapで既に読み込んだ都道府県ポリゴンの
// 先頭数件を代用する）
let eewAreaCandidates: FeatureCollection<Polygon>['features'] = []
const EEW_AREA_COUNT = 5

function updateStat(mode: string, extra = ''): void {
  const el = document.getElementById('stat')
  if (!el) return
  el.textContent = [
    `mode   : ${mode}`,
    `points : ${pointCount.toLocaleString()}`,
    `base   : ${basemapVertices.toLocaleString()} 頂点`,
    `zoom   : ${map.getZoom().toFixed(2)}`,
    `pixelR : ${map.getPixelRatio?.() ?? window.devicePixelRatio}  (device ${window.devicePixelRatio})`,
    extra,
  ]
    .filter(Boolean)
    .join('\n')
}

map.on('load', async () => {
  const [positions, base] = await Promise.all([loadPositions(), loadBasemap()])
  pointCount = positions.length / 2
  basemapVertices = base.vertexCount
  eewAreaCandidates = base.fill.features.slice(0, EEW_AREA_COUNT)

  map.addSource('land', { type: 'geojson', data: base.fill })
  map.addLayer({ id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': LAND_FILL } })
  map.addSource('sub-lines', { type: 'geojson', data: base.subLines })
  map.addLayer({
    id: 'sub-borders',
    type: 'line',
    source: 'sub-lines',
    paint: { 'line-color': SUBREGION_BORDER, 'line-width': 0.5 },
  })
  map.addSource('pref-lines', { type: 'geojson', data: base.prefLines })
  map.addLayer({
    id: 'pref-borders',
    type: 'line',
    source: 'pref-lines',
    paint: { 'line-color': PREF_BORDER, 'line-width': 1 },
  })
  // EEW領域（震源確定/解除でfeature数が変わる。唯一setDataが効く局面の再現）
  map.addSource('eew-area', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: 'eew-area',
    type: 'fill',
    source: 'eew-area',
    paint: { 'fill-color': EEW_AREA_FILL, 'fill-opacity': 0.35 },
  })

  kyoshin = makeKyoshinLayer(positions, pointCount)
  map.addLayer(kyoshin.layer)
  wave = makeWaveLayer()
  map.addLayer(wave.layer)

  ;(window as unknown as { __eewReady: boolean }).__eewReady = true
  updateStat('baseline')
})

map.on('zoomend', () => updateStat(currentMode))
map.on('error', (e) => {
  const el = document.getElementById('stat')
  if (el) el.textContent = 'ERROR: ' + (e.error?.message ?? String(e))
  console.error('[eew] map error', e.error)
})

function setAreaFeatures(features: FeatureCollection<Polygon>['features']): void {
  ;(map.getSource('eew-area') as maplibregl.GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection',
    features,
  })
}

function resetToBaseline(): void {
  kyoshin?.reset()
  wave?.clear()
  setAreaFeatures([])
  map.jumpTo({ center: JAPAN_CENTER, zoom: START_ZOOM })
}

// --- 計測ユーティリティ（poc/realtime.ts・poc/subthreshold-rt.ts の手法を踏襲） ---
// 常に次の'idle'発火を待つ（タイムアウト付き）。setData直後などの「本当に収束したか」を測る
// 用途はこちらを使うこと。map.isMoving()/areTilesLoaded()の同期チェックは、setData呼び出し直後の
// ごく短い時間はworkerでの再タイル化がまだ実際には走っていなくても真を返しうる（レビューで実測確認:
// setData呼び出し0.1ms後に既にareTilesLoaded()=trueに見えたが、本当の'idle'発火は300ms以上後
// だった）。recordAreaEventのsettle計測がこの罠を踏んで0msに退化する回帰を一度出したため、
// 「本当に収束したか」を測る箇所では必ずこちらを使う。
function waitForIdleEvent(timeoutMs = 8000): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, timeoutMs)
    map.once('idle', () => {
      clearTimeout(t)
      res()
    })
  })
}

// マップが既にidle状態の場合、MapLibreは新規に'idle'を発火しないため、waitForIdleEventだけに頼ると
// 本PoC(手動stop・短時間durationMsOverride)では毎回8000msのタイムアウトを丸ごと消費してしまう
// （デバッグで実測: 既にidleな状態でmap.once('idle',...)を張ると8002ms後にタイムアウトで解決していた）。
// 呼び出し時点で既にidleならその場で解決する——ただしこれは「今すぐ何か変化を検知したい」用途には
// 使えない（上記waitForIdleEventの注記参照）。セットアップ・ウォームアップ・タイムライン中の
// 待機など「既に落ち着いていれば早く進めたい」場面専用。
function waitIdle(timeoutMs = 8000): Promise<void> {
  if (!map.isMoving() && map.areTilesLoaded()) return Promise.resolve()
  return waitForIdleEvent(timeoutMs)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// stopManual()による中断を即座に効かせるための、ポーリング式の中断可能sleep（レビュー HIGH2）。
// setTimeout(ms)を待ちきる素の sleep() だと、シナリオ実行中に「停止」ボタンを押しても
// 残りの待機（既定シナリオで最大25秒程度）を止められず、二重実行・計測汚染の温床になっていた。
const SLEEP_ABORT_POLL_MS = 50
function sleepAbortable(ms: number, isAborted: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now()
    const check = () => {
      if (isAborted() || performance.now() - start >= ms) {
        resolve()
        return
      }
      setTimeout(check, Math.min(SLEEP_ABORT_POLL_MS, ms))
    }
    check()
  })
}

// map.on('load')のkyoshin/wave初期化が終わる前にシナリオが起動されるのを防ぐ（レビュー MEDIUM2）。
async function waitLayersReady(timeoutMs = 15000): Promise<boolean> {
  const start = performance.now()
  while (!kyoshin || !wave) {
    if (performance.now() - start > timeoutMs) return false
    await sleep(100)
  }
  return true
}

async function warmup(): Promise<void> {
  for (const z of [4, 5, 6, 7, START_ZOOM, MAX_ZOOM, START_ZOOM]) {
    map.setZoom(z)
    await waitIdle(5000)
  }
}

const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100)
function stats(xs: number[]) {
  if (xs.length === 0) return { n: 0, p50: null, p95: null, max: null, mean: null }
  const s = [...xs].sort((a, b) => a - b)
  const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))]
  return {
    n: s.length,
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    max: round(s[s.length - 1]),
    mean: round(xs.reduce((a, b) => a + b, 0) / xs.length),
  }
}

// --- シナリオ駆動（手動確認用） ---
let currentMode: Mode = 'baseline'
let manualHandle: { stop: () => void } | undefined
// runScenario実行中フラグ（レビュー HIGH2）。「停止」を押しても中断は次のsleepAbortableの
// ポーリング(最大50ms)を待つため、即0にはならない。ボタンから次のシナリオを起動する際は
// このフラグが下りるまで待ってから起動する（switchScenario参照）。
let scenarioRunning = false

function stopManual(): void {
  manualHandle?.stop()
  currentMode = 'baseline'
  resetToBaseline()
  updateStat('baseline')
}

// stopManual()で中断を要求し、runScenarioのfinallyでscenarioRunningが下りるのを待ってから
// 次のシナリオを起動する（待たずに起動すると二重起動ガードに弾かれて無視されるだけになる）。
async function switchScenario(mode: Mode): Promise<void> {
  stopManual()
  while (scenarioRunning) await sleep(SLEEP_ABORT_POLL_MS)
  void runScenario(mode, 'manual')
}

document.getElementById('flyOnlyBtn')?.addEventListener('click', () => void switchScenario('flyto-only'))
document.getElementById('pauseBtn')?.addEventListener('click', () => void switchScenario('composite-pause'))
document.getElementById('nopauseBtn')?.addEventListener('click', () => void switchScenario('composite-nopause'))
document.getElementById('stopBtn')?.addEventListener('click', () => stopManual())

// シナリオ本体。flyTo・強震点毎秒更新・予報円100ms更新・EEW領域setDataを、本番相当のタイムラインで駆動する。
async function runScenario(mode: Mode, label: string, durationMsOverride?: number) {
  // 二重起動ガード（レビュー HIGH2）: 実行中に別シナリオを起動すると rAF ループ・タイマー・
  // イベントリスナーが二重に走り、共有オブジェクト(kyoshin/wave/map)を取り合って計測が壊れる。
  if (scenarioRunning) {
    console.warn('[eew] シナリオ実行中のため無視した（stopで停止してから再実行すること）')
    return null
  }
  if (!(await waitLayersReady())) {
    console.warn('[eew] レイヤー初期化待ちがタイムアウトした（map.on("load")が終わっていない可能性）')
    return null
  }
  scenarioRunning = true
  try {
    currentMode = mode
    updateStat(mode, '計測準備中…')
    await waitIdle()
    resetToBaseline()
    await waitIdle()

    const scenarioMs = durationMsOverride ?? SCENARIO_MS
    // タイムライン上のオフセットもscenarioMsに合わせて縮尺する（durationMsOverrideでの短時間スモーク
    // テストを可能にするため）。既定値(SCENARIO_MS=30000)のときはSECOND_FLYTO_MS/末尾排水の
    // 元の値と一致する。
    const secondFlyToMs = Math.min(SECOND_FLYTO_MS, Math.floor(scenarioMs / 3))
    const tailMs = CLEAR_FLYTO_DURATION_MS + DRAIN_MS
    const updateStopMs = Math.max(secondFlyToMs, scenarioMs - tailMs)

    // フレーム時間の全体分布と、flyTo区間（movestart〜moveend）だけの分布を分けて集計する。
    // 予報円のpauseOnZoomはzoomstart〜zoomendで判定する（PsWaveLayer.tsxと同じ条件）。
    const frameDeltas: number[] = []
    const flyToFrameMs: number[] = []
    let inFlyTo = false
    let isZoomAnimating = false
    const frameCollectStart = performance.now()
    let last = frameCollectStart
    let rafId = requestAnimationFrame(function loop(t) {
      const dt = t - last
      frameDeltas.push(dt)
      if (inFlyTo) flyToFrameMs.push(dt)
      last = t
      rafId = requestAnimationFrame(loop)
    })
    const onMoveStart = () => { inFlyTo = true }
    const onMoveEnd = () => { inFlyTo = false }
    const onZoomStart = () => { isZoomAnimating = true }
    const onZoomEnd = () => { isZoomAnimating = false }
    map.on('movestart', onMoveStart)
    map.on('moveend', onMoveEnd)
    map.on('zoomstart', onZoomStart)
    map.on('zoomend', onZoomEnd)

    const longTasks: number[] = []
    let po: PerformanceObserver | null = null
    try {
      po = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) longTasks.push(e.duration)
      })
      po.observe({ type: 'longtask' })
    } catch {
      po = null
    }

    const kyoshinApplyMs: number[] = []
    const waveApplyMs: number[] = []
    const areaEvents: { name: string; applyMs: number | null; settleMs: number | null }[] = []

    const recordAreaEvent = async (name: string, fn: () => void) => {
      const t0 = performance.now()
      fn()
      const applyMs = performance.now() - t0
      // 「本当に収束したか」を測るため、必ずwaitForIdleEvent（同期チェックの早期解決なし）を使う。
      await waitForIdleEvent(SETTLE_TIMEOUT_MS)
      const settleMs = performance.now() - t0
      areaEvents.push({ name, applyMs: round(applyMs), settleMs: round(settleMs) })
    }

    let kyoshinTimer: number | undefined
    let waveTimer: number | undefined
    const scenarioStart = performance.now()

    let stopped = false
    const stop = () => { stopped = true }
    manualHandle = { stop }

    if (mode !== 'baseline') {
      await recordAreaEvent('detect-add', () => setAreaFeatures(eewAreaCandidates))
      map.flyTo({ center: EPICENTER, zoom: MAX_ZOOM, duration: FLYTO_DURATION_MS })

      if (mode !== 'flyto-only') {
        kyoshinTimer = window.setInterval(() => {
          const t0 = performance.now()
          kyoshin.apply(genLevels(pointCount))
          kyoshinApplyMs.push(performance.now() - t0)
          map.triggerRepaint()
        }, 1000)
        waveTimer = window.setInterval(() => {
          if (mode === 'composite-pause' && isZoomAnimating) return // 本番同様、flyTo(zoom変化)中は予報円更新を止める
          const elapsedSec = (performance.now() - scenarioStart) / 1000
          const pRadiusKm = Math.min(MAX_WAVE_KM, P_WAVE_KM_S * elapsedSec)
          const sRadiusKm = Math.min(MAX_WAVE_KM, S_WAVE_KM_S * elapsedSec)
          const sInnerRadiusKm = Math.max(0, sRadiusKm - TRAILING_WIDTH_KM)
          const t0 = performance.now()
          wave.update(pRadiusKm, sRadiusKm, sInnerRadiusKm)
          waveApplyMs.push(performance.now() - t0)
        }, WAVE_UPDATE_INTERVAL_MS)
      }

      await sleepAbortable(secondFlyToMs, () => stopped)
      if (!stopped) {
        // 予報円の成長に伴う再フィット（本番同様duration 0.8s。震源±2度程度の範囲を仮定）
        map.fitBounds(
          [
            [EPICENTER[0] - 2, EPICENTER[1] - 2],
            [EPICENTER[0] + 2, EPICENTER[1] + 2],
          ],
          { padding: 60, maxZoom: MAX_ZOOM, duration: FLYTO_DURATION_MS },
        )
      }

      await sleepAbortable(Math.max(0, updateStopMs - secondFlyToMs), () => stopped)
    } else {
      await sleepAbortable(scenarioMs, () => stopped)
    }

    if (kyoshinTimer != null) clearInterval(kyoshinTimer)
    if (waveTimer != null) clearInterval(waveTimer)

    if (mode !== 'baseline' && !stopped) {
      await recordAreaEvent('clear-remove', () => setAreaFeatures([]))
      map.fitBounds(JAPAN_BOUNDS, { padding: 20, duration: CLEAR_FLYTO_DURATION_MS })
      await sleepAbortable(tailMs, () => stopped)
    }

    // fpsはscenarioMs(名目値)ではなく実測経過時間で割る（レビュー HIGH1: durationMsOverrideが
    // tailMs未満だとupdateStopMsがsecondFlyToMs側にクランプされ、名目値より実測時間が長くなり
    // fpsを過大評価してしまうため）。
    const elapsedMs = performance.now() - frameCollectStart

    cancelAnimationFrame(rafId)
    map.off('movestart', onMoveStart)
    map.off('moveend', onMoveEnd)
    map.off('zoomstart', onZoomStart)
    map.off('zoomend', onZoomEnd)
    if (po) po.disconnect()

    resetToBaseline()
    currentMode = 'baseline'
    updateStat('baseline')

    if (stopped) {
      // 手動停止による中断。タイムラインが最後まで走っていないため統計は不完全 — 計測結果として
      // 報告しない（レビュー HIGH2。以前は中断してもタイマー/リスナーが残ったまま次のシナリオと
      // 同時に走り、計測を汚染していた）。
      console.log(`[eew] ${label} ${mode}: 手動停止により中断（計測結果は破棄）`)
      return null
    }

    frameDeltas.shift()
    const frame = stats(frameDeltas)
    const flyToFrame = stats(flyToFrameMs)
    const droppedOverall = frameDeltas.filter((d) => d > DROPPED_FRAME_MS).length
    const droppedFlyTo = flyToFrameMs.filter((d) => d > DROPPED_FRAME_MS).length

    const result = {
      meta: {
        when: new Date().toISOString(),
        label,
        mode,
        scenarioMs,
        url: location.href,
        ua: navigator.userAgent,
        viewport: `${innerWidth}x${innerHeight}`,
        devicePixelRatio: window.devicePixelRatio,
        points: pointCount,
        basemapVertices,
        canvasW: map.getCanvas().width,
        canvasH: map.getCanvas().height,
        jsHeapMB: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ? Math.round(
              (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize /
                1048576,
            )
          : null,
      },
      frame: {
        frames: frame.n,
        fps: round(frame.n / (elapsedMs / 1000)),
        p50: frame.p50,
        p95: frame.p95,
        max: frame.max,
        dropped: droppedOverall,
      },
      // flyTo区間（movestart〜moveend）だけのフレーム時間。カメラ移動中に複合負荷が乗ったときの
      // コマ落ちを、全体平均に埋もれさせず名指しで読む（項目6/5×6のupdateFrameと同じ発想）。
      flyToFrame:
        mode === 'baseline'
          ? null
          : { frames: flyToFrame.n, p50: flyToFrame.p50, p95: flyToFrame.p95, max: flyToFrame.max, dropped: droppedFlyTo },
      kyoshinApply: mode === 'baseline' || mode === 'flyto-only' ? null : stats(kyoshinApplyMs),
      waveApply: mode === 'baseline' || mode === 'flyto-only' ? null : stats(waveApplyMs),
      // EEW領域の追加/削除2件（唯一setDataが効きうる局面）。定期apply系と違いイベント単位で記録する。
      areaEvents: mode === 'baseline' ? null : areaEvents,
      longTask: {
        count: po ? longTasks.length : -1,
        totalMs: round(longTasks.reduce((a, b) => a + b, 0)),
        maxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
      },
    }

    try {
      const res = await fetch(REPORT_URL, { method: 'POST', body: JSON.stringify(result) })
      console.log(
        `[eew] ${label} ${mode}: ${res.ok ? await res.text() : 'HTTP ' + res.status}`,
        result.frame,
        result.flyToFrame,
      )
    } catch (e) {
      console.warn('[eew] report 送信失敗（結果はログから回収可）:', e, result)
    }
    return result
  } finally {
    scenarioRunning = false
    manualHandle = undefined
  }
}

const w = window as unknown as Record<string, unknown>

// 単発計測: await __measureEewComposite({ mode:'composite-nopause', label:'adhoc' })
w.__measureEewComposite = (opts: { mode?: Mode; label?: string; durationMs?: number } = {}) =>
  runScenario(opts.mode ?? 'composite-nopause', opts.label ?? 'adhoc', opts.durationMs)

// 反応表スイート: ウォームアップ → baseline / flyto-only / composite-pause / composite-nopause を順に測る。
// 実機で await window.__runEewSuite('surface-go2-eew') を1回（各シナリオが約30秒＋排水）。
w.__runEewSuite = async (labelBase = 'eew') => {
  console.log('[eew] ウォームアップ')
  await warmup()
  console.log(`[eew] suite 開始（device DPR ${window.devicePixelRatio}）`)
  await runScenario('baseline', `${labelBase}-baseline`)
  await runScenario('flyto-only', `${labelBase}-flyonly`)
  await runScenario('composite-pause', `${labelBase}-pause`)
  await runScenario('composite-nopause', `${labelBase}-nopause`)
  console.log('[eew] suite 完了')
}

Object.assign(w, {
  __eewMap: map,
  __eewGetMode: () => currentMode,
  __eewStop: stopManual,
})
