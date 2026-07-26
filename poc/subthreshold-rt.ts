// 【PoC専用・使い捨て】検証項目5×6 の交差点: カスタムレイヤー（KyoshinSubThreshold の非加算合成）の毎秒更新。
//
// 項目5 で「非加算合成（① 同レベル非加算 / ② レベル間加算）」はカスタムレイヤーの FBO 二層合成で
// 再現できると確定した。だが subthreshold.ts はレベルごとに STATIC_DRAW の固定バッファを持つ静的実装で、
// 更新経路が無い。一方 項目6 で「毎秒更新」は feature-state 採用で決着したが、feature-state は paint 式
// 経由なのでカスタムレイヤーには一切効かない。⇒「カスタムレイヤーを毎秒更新する」経路が両 PoC の狭間に
// 落ちている。本番の KyoshinSubThreshold は毎秒レベル更新を必ず通るため、項目7（EEW 複合）の前に潰す。
//
// このページは本番相当のベースマップ（陸塗り＋細分境界＋県境の約4万頂点）を敷いた上に KyoshinSubThreshold
// 相当のカスタムレイヤー（既定 1,725 観測点・index 1〜6。?points=N で負荷軸を振れる。レビュー HIGH2）を
// 最前面に置き、更新方式ごとに毎秒更新のコストを測る:
//   - baseline      : 更新なし（静止の床）
//   - repaint-only  : 属性更新なしで全画面再描画だけ要求（カスタムレイヤー再描画コスト単独・提案4 相当）
//   - custom-update : インデックスバッファ方式。座標は静的、毎秒はレベル順 index の並べ替え(カウンティング
//                     ソート O(n))＋ index バッファの bufferSubData（約3.4KB）だけ。狙いの実装。
//   - naive-rebuild : 素朴移植の悪ケース。毎秒レベルごとに座標 Float32Array を作り直して bufferData
//                     （静的 subthreshold.ts の onAdd 相当を毎秒やる）。index 方式の優位を数値で示す対照。
//
// 判定: custom-update − repaint-only ≒ 更新 CPU（カウンティングソート＋index アップロード）。これが天井
//       (vsync)内で naive-rebuild より軽ければ「カスタムレイヤーの毎秒更新は index バッファ方式で軽く回せる」
//       ＝一本化 GO 材料。天井を破れば DPR 抑制等の移植制約が判明する。どちらも項目7（EEW 複合）へ積む。
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Polygon, LineString } from 'geojson'

// --- 定数（本体 KyoshinSubThreshold.tsx / kyoshinIntensity.ts・realtime.ts と揃える） ---
const JAPAN_CENTER: [number, number] = [137.7, 38.25] // MapLibre は [lng, lat]
const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'
// KyoshinSubThreshold の対象は index 1〜6（震度0以下）。index 0 はデータ無し（subThresholdOpacity(0)=0）で非表示。
const MAX_SUB_IDX = 6
const SHINDO0_COLOR = '#9ca3af'
// 本番相当の実半径（BASE_RADIUS×iconScale）。subthreshold.ts の目視用 9 ではなく本番負荷を測る。
const BASE_RADIUS = 2.5
// 描画点数の負荷軸（レビュー HIGH2）。開発機は170Hzでvsync天井(5.9ms)に3モードとも張り付き、方式間の
// 差が測定分解能を下回るため、URLクエリ ?points=N で振れるようにする。既定は①現行の強震モニタ観測点数
// （約1,725）。② station-coords 全点（約4,372・間引きなし） ③ 現行の10倍（17,250・分離点を探す）。
// custom 経路の index バッファは Uint16Array（LOW4）のため 65,535 点が上限。超えるクエリは黙って壊れる
// （添字ラップ）とセルフレビューで指摘されたため、上限でクランプし console.warn で気付けるようにする。
const MAX_UINT16_POINTS = 65535
function readTargetPoints(): number {
  const q = new URLSearchParams(location.search).get('points')
  const n = q ? parseInt(q, 10) : NaN
  if (!q) return 1725
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[subrt] ?points=${q} は不正な値のため既定値 1725 を使う`)
    return 1725
  }
  if (n > MAX_UINT16_POINTS) {
    console.warn(`[subrt] ?points=${n} は Uint16 index の上限(${MAX_UINT16_POINTS})を超えるためクランプする`)
    return MAX_UINT16_POINTS
  }
  return n
}
const TARGET_POINTS = readTargetPoints()
// 本番 kyoshin モードのベースマップ配色（BaseMap.tsx と一致・毎秒の全画面再描画で塗り直される対象）
const LAND_FILL = '#161b24' // 陸地塗り（都道府県ポリゴン）
const SUBREGION_BORDER = '#39414f' // 一次細分区域の境界線
const PREF_BORDER = '#56607a' // 県境
// 全計測の開始 zoom（可視ジオメトリ量＝描画量を揃える。measure.ts / realtime.ts と同思想）
const START_ZOOM = 5
const REPORT_URL = '/__perf-report'
// settle（apply→idle 収束時間）のタイムアウト上限（レビュー CRITICAL・realtime.ts と同値）
const SETTLE_TIMEOUT_MS = 5000
// 計測ウィンドウ終了後、末尾 apply の再描画/収束を拾う排水期間（レビュー LOW8・realtime.ts と同値）
const DRAIN_MS = 1000

// 計測モード（realtime.ts の Mode に対応。feature-state/setData の代わりに custom-update/naive-rebuild）
type Mode = 'baseline' | 'repaint-only' | 'custom-update' | 'naive-rebuild'

// index 0→0、index 6→0.35 の指数カーブ（現行 KyoshinSubThreshold と同一・subthreshold.ts と揃える）
function subThresholdOpacity(idx: number): number {
  if (idx <= 0) return 0
  const t = idx / MAX_SUB_IDX
  return ((Math.exp(t) - 1) / (Math.E - 1)) * 0.35
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// 毎秒の更新レベルを生成: 全点にランダムな index(1..6)＝「毎秒全点変化」の最悪ケース（上界）。
// index 0（非表示）は含めない（レビュー HIGH1）。含めると repaint-only の静止床（initLevels、index
// 1〜6のみ）より描画点数が約15%少なくなり、差分に「更新は軽い」という過小評価バイアスが乗ってしまう
// ——上界を測る PoC では、現実の分布（index 0 も混ざる）より両モードの点数を揃えることを優先する
// （現実の部分変化は index 1〜6 に閉じた上界の内側に必ず収まる）。
// WebGL は変化数に依らず全画面再描画になるため、最悪でも天井内なら現実（部分変化）は当然収まる。
function genLevels(n: number): Uint8Array {
  const a = new Uint8Array(n)
  for (let i = 0; i < n; i++) a[i] = ((Math.random() * MAX_SUB_IDX) | 0) + 1
  return a
}

// baseline / repaint-only の静止床に使う固定レベル（index 1〜6 を巡回。index 0＝非表示は入れない）
function initLevels(n: number): Uint8Array {
  const a = new Uint8Array(n)
  for (let i = 0; i < n; i++) a[i] = (i % MAX_SUB_IDX) + 1
  return a
}

// --- カスタムレイヤー（FBO 二層合成＋インデックスバッファ方式の毎秒更新） ---

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

type RenderMode = 'custom' | 'naive'

// カスタムレイヤー本体。座標(positions=Mercator 座標)は静的で不動。毎秒変わるのはレベル割り当てだけ。
// custom 経路: レベル順に並べた index バッファ(ELEMENT_ARRAY_BUFFER)＋レベルごとの drawElements レンジ。
//   毎秒アップロードは index(Uint16・約3.4KB)のみ。座標バッファは触らない。
// naive 経路: レベルごとに座標 Float32Array を毎秒 bufferData で作り直す素朴実装（対照）。
function makeSubThresholdRtLayer(positions: Float32Array, n: number) {
  const COLOR = hexToRgb(SHINDO0_COLOR)

  // custom 経路の状態: レベル順 index と、レベルごとの描画レンジ(start/count)。index 0 も並ぶが描画しない。
  const sortedIndices = new Uint16Array(n)
  const rangeStart = new Int32Array(MAX_SUB_IDX + 1) // lv 0..6
  const rangeCount = new Int32Array(MAX_SUB_IDX + 1)
  let dirtyIdx = false // apply 後、次の render で index バッファを bufferSubData する必要がある

  // naive 経路の状態: レベルごとに座標を集めた Float32Array（毎秒新規確保＝素朴実装のコストを模す）
  const naiveArrays: Float32Array[] = new Array(MAX_SUB_IDX + 1)
  const naiveCounts = new Int32Array(MAX_SUB_IDX + 1)
  let dirtyNaive = false

  let renderMode: RenderMode = 'custom'

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

  // レベル配列 → レベルごとの座標 Float32Array（毎秒新規確保）。dirtyNaive を立てる（GPU 反映は render）。
  const buildNaive = (levels: Uint8Array): void => {
    const counts = new Int32Array(MAX_SUB_IDX + 1)
    for (let i = 0; i < n; i++) counts[levels[i]]++
    for (let lv = 1; lv <= MAX_SUB_IDX; lv++) {
      naiveArrays[lv] = new Float32Array(counts[lv] * 2)
      naiveCounts[lv] = counts[lv]
    }
    const cursor = new Int32Array(MAX_SUB_IDX + 1)
    for (let i = 0; i < n; i++) {
      const lv = levels[i]
      if (lv < 1) continue // index 0 は非表示
      const a = naiveArrays[lv]
      const c = cursor[lv]++
      a[c * 2] = positions[i * 2]
      a[c * 2 + 1] = positions[i * 2 + 1]
    }
    dirtyNaive = true
  }

  // 初期レベルで両経路のデータを用意（GPU アップロードは onAdd）
  countingSort(initLevels(n))
  buildNaive(initLevels(n))
  dirtyIdx = false
  dirtyNaive = false

  let pointProg: WebGLProgram
  let quadProg: WebGLProgram
  let fbo: WebGLFramebuffer
  let tex: WebGLTexture
  let posBuf: WebGLBuffer
  let idxBuf: WebGLBuffer
  let quadBuf: WebGLBuffer
  const naiveBufs: WebGLBuffer[] = new Array(MAX_SUB_IDX + 1)
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

  const compile = (gl: WebGL2RenderingContext, type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s))
    return s
  }
  const link = (gl: WebGL2RenderingContext, vs: string, fs: string) => {
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p))
    return p
  }

  const layer = {
    id: 'subthreshold-rt-custom',
    type: 'custom',
    onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext) {
      mapRef = map
      pointProg = link(gl, POINT_VS, POINT_FS)
      quadProg = link(gl, QUAD_VS, QUAD_FS)
      uMatrix = gl.getUniformLocation(pointProg, 'u_matrix')
      uSize = gl.getUniformLocation(pointProg, 'u_size')
      uColor = gl.getUniformLocation(pointProg, 'u_color')
      aPos = gl.getAttribLocation(pointProg, 'a_pos')
      uTex = gl.getUniformLocation(quadProg, 'u_tex')
      uOpacity = gl.getUniformLocation(quadProg, 'u_opacity')
      aQuad = gl.getAttribLocation(quadProg, 'a_quad')

      // 座標は静的（1本・不動）。custom 経路はこれを index で参照する。
      posBuf = gl.createBuffer()!
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
      // index バッファ（DYNAMIC_DRAW・毎秒 bufferSubData で並べ替えだけ差し替える）
      idxBuf = gl.createBuffer()!
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sortedIndices, gl.DYNAMIC_DRAW)
      // naive 経路のレベル別バッファ（毎秒 bufferData で丸ごと差し替える）
      for (let lv = 1; lv <= MAX_SUB_IDX; lv++) {
        naiveBufs[lv] = gl.createBuffer()!
        gl.bindBuffer(gl.ARRAY_BUFFER, naiveBufs[lv])
        gl.bufferData(gl.ARRAY_BUFFER, naiveArrays[lv], gl.DYNAMIC_DRAW)
      }
      quadBuf = gl.createBuffer()!
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
      fbo = gl.createFramebuffer()!
      tex = gl.createTexture()!
    },
    render(gl: WebGL2RenderingContext, args: { defaultProjectionData: { mainMatrix: Float32Array } }) {
      const canvas = mapRef.getCanvas()
      const w = canvas.width
      const h = canvas.height
      // render 開始時の本描画 FBO（MapLibre のメイン描画先）を resize より前に控える。resize は内部で fbo を
      // bind するため、後ろに置くと初回フレームで mainFBO=fbo になり feedback loop になる（項目5 レビュー MEDIUM1）。
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

      // apply が立てた dirty をこのフレームで GPU に反映する（＝更新の GPU アップロード分。updateFrame に乗る）。
      // custom は index の bufferSubData（約3.4KB・1回）だけ。naive はレベル別の bufferData（計約13.8KB・6回）。
      if (renderMode === 'custom' && dirtyIdx) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, sortedIndices)
        dirtyIdx = false
      }
      if (renderMode === 'naive' && dirtyNaive) {
        for (let lv = 1; lv <= MAX_SUB_IDX; lv++) {
          gl.bindBuffer(gl.ARRAY_BUFFER, naiveBufs[lv])
          gl.bufferData(gl.ARRAY_BUFFER, naiveArrays[lv], gl.DYNAMIC_DRAW)
        }
        dirtyNaive = false
      }

      const matrix = args.defaultProjectionData.mainMatrix
      const dpr = window.devicePixelRatio || 1
      const size = BASE_RADIUS * 2 * dpr

      // scissor 最適化（項目5 subthreshold.ts）は敷かない。本番の毎秒更新では各レベルの点が毎秒
      // 全国へ分散し BBox がほぼ全画面になる（項目5 LOW2: 平常時 index1 は全国分散で scissor はほぼ効かない）。
      // 毎秒の BBox 再計算コストを更新コストに混ぜず、6 レベル分の全画面塗りという最悪ケースの上界を測る。
      for (let lv = 1; lv <= MAX_SUB_IDX; lv++) {
        const count = renderMode === 'custom' ? rangeCount[lv] : naiveCounts[lv]
        if (!count) continue

        // ① オフスクリーン FBO へ「不透明」で描く（同レベル重なりは上書き＝濃くならない）。
        // feedback loop 回避（項目5 レビュー MEDIUM1）: FBO を描画先にする前に、合成で bind した tex を外す。
        gl.bindTexture(gl.TEXTURE_2D, null)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.viewport(0, 0, w, h)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // premultiplied over（縁 a<1 のみ合成）
        gl.useProgram(pointProg)
        gl.uniformMatrix4fv(uMatrix, false, matrix)
        gl.uniform1f(uSize, size)
        gl.uniform4f(uColor, COLOR[0], COLOR[1], COLOR[2], 1.0)
        if (renderMode === 'custom') {
          // 静的な座標バッファを index のレンジ(このレベルの並び)で参照して描く
          gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
          gl.enableVertexAttribArray(aPos)
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
          gl.drawElements(gl.POINTS, count, gl.UNSIGNED_SHORT, rangeStart[lv] * 2) // offset はバイト(Uint16=2)
        } else {
          // レベル別の座標バッファをそのまま描く
          gl.bindBuffer(gl.ARRAY_BUFFER, naiveBufs[lv])
          gl.enableVertexAttribArray(aPos)
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
          gl.drawArrays(gl.POINTS, 0, count)
        }

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
        // 合成で使い終わった tex を即外す。次レベルの FBO 描画との feedback loop を断つ（項目5 レビュー MEDIUM1）。
        gl.bindTexture(gl.TEXTURE_2D, null)
      }

      // GL 状態を復元（CustomLayerInterface の作法・項目5 レビュー LOW3/LOW5）。本描画先へ戻し、追加で
      // bind した ELEMENT_ARRAY_BUFFER も外す。全レベル点ゼロのフレームでも mainFBO へ確実に戻す。
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
      for (let lv = 1; lv <= MAX_SUB_IDX; lv++) gl.deleteBuffer(naiveBufs[lv])
    },
  }

  return {
    layer: layer as maplibregl.CustomLayerInterface,
    setMode(m: RenderMode): void {
      renderMode = m
    },
    // 初期レベルで静止床を作る（計測外なのでここで triggerRepaint してよい）
    reset(): void {
      if (renderMode === 'custom') countingSort(initLevels(n))
      else buildNaive(initLevels(n))
      mapRef?.triggerRepaint()
    },
    // custom 経路の更新: カウンティングソートのみ（更新 CPU）。GPU 反映と再描画は呼び出し側の triggerRepaint。
    applyCustom(levels: Uint8Array): void {
      countingSort(levels)
    },
    // naive 経路の更新: レベル別座標構築のみ（更新 CPU）。GPU 反映と再描画は呼び出し側の triggerRepaint。
    applyNaive(levels: Uint8Array): void {
      buildNaive(levels)
    },
  }
}

// --- ベースマップ（realtime.ts の loadBasemap を流用。陸塗り＋細分境界＋県境） ---

// station-coords（約4,372点）を TARGET_POINTS へ均等サンプリングし、Mercator 座標の Float32Array にする。
// カスタムレイヤーは GeoJSON ソースを介さないため、座標は事前に Mercator へ変換して 1 本のバッファに詰める。
// TARGET_POINTS が実観測点数を超える場合（レビュー HIGH2 の負荷軸③ 17,250 等）は実測点を巡回で複製して
// 埋める。GPU/CPU負荷の測定が目的で観測点の実在性は問わないため、位置の重複は許容する。
// 注意（レビュー MEDIUM6）: 同一座標が複数 index を持つため genLevels で異なるレベルを引くと、
// 同一ピクセルで異レベルの点が重なって見える。断片数・頂点処理・転送量は点数に比例して増える
// （計測コストには効く）——増えないのは可視の塗り面積だけ（実測: ②4,372点→③17,250点で
// 塗りピクセル+0.8%。ユニーク座標が②で頭打ちのため）。③は方式間の相対比較には有効だが、
// 本番の観測点分布（重複なし）とは可視負荷の性質が異なるため本番負荷の予測には使えない。
async function loadPositions(): Promise<Float32Array> {
  const d: { stations: Record<string, [number, number]> } = await fetch(
    '/data/station-coords.json',
  ).then((r) => r.json())
  const coords = Object.values(d.stations) // [lat, lon]
  let sampled: [number, number][]
  if (TARGET_POINTS <= coords.length) {
    // floor で間引き間隔を決める（round だと目標の 85% しか残らない。realtime.ts LOW2 と同じ）
    const step = Math.max(1, Math.floor(coords.length / TARGET_POINTS))
    sampled = coords.filter((_, i) => i % step === 0).slice(0, TARGET_POINTS)
  } else {
    sampled = Array.from({ length: TARGET_POINTS }, (_, i) => coords[i % coords.length])
  }
  const arr = new Float32Array(sampled.length * 2)
  sampled.forEach(([lat, lon], i) => {
    const m = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat })
    arr[i * 2] = m.x
    arr[i * 2 + 1] = m.y
  })
  return arr
}

// 本番 kyoshin モード相当のベースマップ（陸地塗り＋細分区域境界＋県境）を MapLibre feature へ変換する。
// rings は [lat,lng] 順・GeoJSON は [lng,lat] 順のため入れ替える。BaseMap.tsx は各リングを独立に塗る
// （穴処理なし）ため、ここでも各リングを 1 ポリゴン feature とする（realtime.ts と同じ）。
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
      // 県境リングは fill と prefLines の両方で描画されるため、頂点は 2 回計上する（realtime.ts LOW3）。
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

let subRt: ReturnType<typeof makeSubThresholdRtLayer>
let pointCount = 0
let basemapVertices = 0

function updateStat(mode: string, extra = ''): void {
  const el = document.getElementById('stat')
  if (!el) return
  el.textContent = [
    `mode   : ${mode}`,
    `points : ${pointCount.toLocaleString()}（index 1〜6）`,
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

  // 本番 kyoshin モード相当のベースマップ（カスタムレイヤーの背面）。毎秒の全画面再描画で塗り直される対象。
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

  // KyoshinSubThreshold 相当のカスタムレイヤー（最前面）
  subRt = makeSubThresholdRtLayer(positions, pointCount)
  map.addLayer(subRt.layer)

  // 検証・実機デバッグ用に露出（setMode/reset/applyCustom/applyNaive を直接叩ける）
  ;(window as unknown as { __subRt: typeof subRt }).__subRt = subRt
  ;(window as unknown as { __subRtReady: boolean }).__subRtReady = true
  updateStat('baseline')
})

map.on('zoomend', () => updateStat(currentMode))
map.on('error', (e) => {
  const el = document.getElementById('stat')
  if (el) el.textContent = 'ERROR: ' + (e.error?.message ?? String(e))
  console.error('[subrt] map error', e.error)
})

// --- 手動確認用の毎秒更新トグル（本計測は __runSubRtSuite が自動駆動する） ---
let currentMode: Mode = 'baseline'
let manualTimer: number | undefined

function startManual(mode: 'custom-update' | 'repaint-only'): void {
  stopManual()
  currentMode = mode
  subRt.setMode('custom') // 手動確認は custom 経路のみ（naive はスイートで比較）
  manualTimer = window.setInterval(() => {
    if (mode === 'custom-update') {
      const lv = genLevels(pointCount)
      const t0 = performance.now()
      subRt.applyCustom(lv)
      map.triggerRepaint()
      updateStat(mode, `applyMs: ${(performance.now() - t0).toFixed(2)}`)
    } else {
      map.triggerRepaint()
      updateStat(mode)
    }
  }, 1000)
  updateStat(mode)
}

function stopManual(): void {
  if (manualTimer != null) {
    clearInterval(manualTimer)
    manualTimer = undefined
  }
  currentMode = 'baseline'
  subRt.setMode('custom')
  subRt.reset()
  updateStat('baseline')
}

document.getElementById('customBtn')?.addEventListener('click', () => startManual('custom-update'))
document.getElementById('repaintBtn')?.addEventListener('click', () => startManual('repaint-only'))
document.getElementById('stopBtn')?.addEventListener('click', () => stopManual())

// --- 計測ランナー（realtime.ts の p95/updateFrame/settle/apply/report/warmup 手法を踏襲。駆動は毎秒更新） ---

function waitIdle(timeoutMs = 8000): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, timeoutMs)
    map.once('idle', () => {
      clearTimeout(t)
      res()
    })
  })
}

// 計測前のウォームアップ: 全整数ズームを踏んで初回タイル読み込みの交絡を払う（realtime.ts と同じ）。末尾は START_ZOOM。
async function warmup(): Promise<void> {
  for (const z of [4, 5, 6, 7, START_ZOOM]) {
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

async function measureSubRt(mode: Mode, durationMs: number, label: string) {
  currentMode = mode
  subRt.setMode(mode === 'naive-rebuild' ? 'naive' : 'custom')
  map.setZoom(START_ZOOM)
  await waitIdle()
  // 前 phase の状態を初期レベルの静止床に戻してから測る
  subRt.reset()
  await waitIdle()

  // 更新起因フレームを名指しで測る（realtime.ts HIGH6）。毎秒 1 回の更新は全フレームの ~1.7%(60Hz) しか
  // 占めず p95 の外に埋もれるため、render 発火後の最初のフレーム（＝再描画を含むフレーム）を 1 サンプルにする。
  const frameDeltas: number[] = []
  const updateFrameMs: number[] = []
  let updateArmed = false
  let updateRendered = false
  // settle: apply→次の idle までの収束時間（realtime.ts HIGH7）。カスタムレイヤーは triggerRepaint 1 回で
  // 収束するはず（再タイル化なし）＝ settle≈updateFrame になる想定。naive も同様に 1 フレーム収束を確認する。
  const settleMs: number[] = []
  let settleTimeouts = 0
  const pendingApplies: number[] = []
  let measuring = true
  let windowOpen = true
  let last = performance.now()
  let rafId = requestAnimationFrame(function loop(t) {
    const dt = t - last
    if (windowOpen) frameDeltas.push(dt)
    if (updateArmed && updateRendered) {
      updateFrameMs.push(dt)
      updateArmed = false
      updateRendered = false
    }
    last = t
    rafId = requestAnimationFrame(loop)
  })

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

  const applyMs: number[] = []
  let timer: number | undefined
  let onRender: (() => void) | undefined
  let onIdle: (() => void) | undefined
  if (mode !== 'baseline') {
    // render 発火を updateFrame の窓の起点にする（rAF ループが直後の再描画フレームを 1 つ記録する）
    onRender = () => {
      if (updateArmed) updateRendered = true
    }
    onIdle = () => {
      if (!measuring || pendingApplies.length === 0) return
      const now = performance.now()
      for (const t of pendingApplies) settleMs.push(now - t)
      pendingApplies.length = 0
    }
    map.on('render', onRender)
    map.on('idle', onIdle)
    timer = window.setInterval(() => {
      let t0: number
      if (mode === 'custom-update' || mode === 'naive-rebuild') {
        const lv = genLevels(pointCount) // 更新値生成は計測外（apply の同期コストだけを applyMs に入れる）
        t0 = performance.now()
        if (mode === 'custom-update') subRt.applyCustom(lv)
        else subRt.applyNaive(lv)
        applyMs.push(performance.now() - t0)
        // dirty を GPU に反映＋全画面再描画を要求する（GPU アップロードと再描画は updateFrame/frame で読む）
        map.triggerRepaint()
      } else {
        // repaint-only: 属性更新なしで全画面再描画だけ要求する
        t0 = performance.now()
        map.triggerRepaint()
        applyMs.push(performance.now() - t0)
      }
      updateArmed = true
      updateRendered = false
      const tApply = performance.now()
      pendingApplies.push(tApply)
      window.setTimeout(() => {
        if (!measuring) return
        const idx = pendingApplies.indexOf(tApply)
        if (idx === -1) return
        pendingApplies.splice(idx, 1)
        settleMs.push(SETTLE_TIMEOUT_MS)
        settleTimeouts++
      }, SETTLE_TIMEOUT_MS)
    }, 1000)
  }

  await new Promise((r) => setTimeout(r, durationMs))

  // 計測ウィンドウ終了。frame 集計を止め、setInterval だけ止めて排水期間（DRAIN_MS）を待つ（realtime.ts LOW8）。
  windowOpen = false
  if (timer != null) clearInterval(timer)
  await new Promise((r) => setTimeout(r, DRAIN_MS))

  const tEnd = performance.now()
  for (const t of pendingApplies) settleMs.push(tEnd - t)
  pendingApplies.length = 0
  measuring = false
  if (onRender) map.off('render', onRender)
  if (onIdle) map.off('idle', onIdle)
  cancelAnimationFrame(rafId)
  if (po) po.disconnect()

  frameDeltas.shift()
  const frame = stats(frameDeltas)
  console.assert(
    settleMs.length === applyMs.length && updateFrameMs.length === applyMs.length,
    `記録漏れ: settle=${settleMs.length} updateFrame=${updateFrameMs.length} apply=${applyMs.length}`,
  )

  const result = {
    meta: {
      when: new Date().toISOString(),
      label,
      mode,
      durationMs,
      url: location.href,
      ua: navigator.userAgent,
      viewport: `${innerWidth}x${innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      points: pointCount,
      basemapVertices,
      canvasW: map.getCanvas().width,
      canvasH: map.getCanvas().height,
      // baseline実測から逆算できるが、実機(60Hz)と開発機(170Hz等)で天井が別物なので明示しておく
      // （レビュー 情報5）。frame.p50はvsync間隔の実質値なので、この値自体がヒントになる。
      estimatedVsyncMs: mode === 'baseline' ? frame.p50 : null,
      jsHeapMB: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        ? Math.round(
            (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize /
              1048576,
          )
        : null,
    },
    frame: {
      frames: frame.n,
      fps: round(frame.n / (durationMs / 1000)),
      p50: frame.p50,
      p95: frame.p95,
      max: frame.max,
    },
    // 【custom-update / naive-rebuild はこれで読む】更新起因フレームの所要時間（GPU アップロード＋全画面
    // 再描画を含む）。毎秒スパイクは frame.p95 に埋もれるため render 発火後の最初のフレームを名指しで測る。
    updateFrame: mode === 'baseline' ? null : stats(updateFrameMs),
    // apply→次の idle までの収束時間。カスタムレイヤーは triggerRepaint 1 回で収束するため settle≈updateFrame の
    // はず（setData のような worker 再タイル化バーストが無いのが feature-state と同じ性質）。
    settle: mode === 'baseline' ? null : stats(settleMs),
    settleTimeouts: mode === 'baseline' ? null : settleTimeouts,
    // 更新処理そのものの同期コスト。custom-update はカウンティングソート、naive-rebuild はレベル別座標構築、
    // repaint-only は triggerRepaint 要求のみ（ほぼ 0）。差分は取らない — custom-update/naive-rebuild は
    // apply 値そのものが単体で更新 CPU の実体（レビュー MEDIUM3）。custom-update − repaint-only の差分を
    // 見るべきは updateFrame（GPU アップロード＋再描画を含む）の方。
    apply: mode === 'baseline' ? null : stats(applyMs),
    longTask: {
      count: po ? longTasks.length : -1,
      totalMs: round(longTasks.reduce((a, b) => a + b, 0)),
      maxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
    },
  }

  subRt.setMode('custom')
  subRt.reset()
  currentMode = 'baseline'
  updateStat('baseline')

  try {
    const res = await fetch(REPORT_URL, { method: 'POST', body: JSON.stringify(result) })
    console.log(
      `[subrt] ${label} ${mode}: ${res.ok ? await res.text() : 'HTTP ' + res.status}`,
      result.frame,
      result.apply,
    )
  } catch (e) {
    console.warn('[subrt] report 送信失敗（結果はログから回収可）:', e, result)
  }
  return result
}

const w = window as unknown as Record<string, unknown>

// 単発計測: await __measureSubRt({ mode:'custom-update', durationMs:12000, label:'adhoc' })
w.__measureSubRt = (opts: { mode?: Mode; durationMs?: number; label?: string } = {}) =>
  measureSubRt(opts.mode ?? 'custom-update', opts.durationMs ?? 12000, opts.label ?? 'adhoc')

// 反応表スイート: ウォームアップ → baseline / repaint-only / custom-update / naive-rebuild を毎秒更新で測る。
// 実機で await window.__runSubRtSuite('surface-go2-subrt') を1回。証跡が scripts/perf/results へ保存される。
w.__runSubRtSuite = async (labelBase = 'subrt', durationMs = 12000) => {
  console.log('[subrt] ウォームアップ（z4〜7 全整数・非計測）')
  await warmup()
  console.log(`[subrt] suite 開始（device DPR ${window.devicePixelRatio}・各 ${durationMs}ms）`)
  await measureSubRt('baseline', durationMs, `${labelBase}-baseline`)
  await measureSubRt('repaint-only', durationMs, `${labelBase}-repaint`)
  await measureSubRt('custom-update', durationMs, `${labelBase}-custom`)
  await measureSubRt('naive-rebuild', durationMs, `${labelBase}-naive`)
  console.log('[subrt] suite 完了')
}

// 更新処理単体ベンチ: 描画を挟まず apply を連続実行し、メインスレッド同期コストだけを測る。
w.__benchSubRtApply = (mode: 'custom-update' | 'naive-rebuild' = 'custom-update', iters = 50) => {
  const ms: number[] = []
  for (let k = 0; k < iters; k++) {
    const lv = genLevels(pointCount)
    const t0 = performance.now()
    if (mode === 'custom-update') subRt.applyCustom(lv)
    else subRt.applyNaive(lv)
    ms.push(performance.now() - t0)
  }
  const s = stats(ms)
  console.log(`[subrt] benchApply ${mode} ×${iters}（同期・描画なし）:`, s)
  return s
}

// 計測スクリプトから触れるよう map と現在状態を露出する
Object.assign(w, {
  __subRtMap: map,
  __subRtGetMode: () => currentMode,
})
