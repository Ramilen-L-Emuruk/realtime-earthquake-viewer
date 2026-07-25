// 【PoC専用・使い捨て】検証項目5: KyoshinSubThreshold の非加算合成を MapLibre で再現できるか。
//
// 現行(SVG)は index 1〜6 ごとの <g opacity> に circle を入れ、グループを一枚に合成してから
// opacity を掛けることで「① 同一レベル内は重なっても濃くならない / ② レベル間は濃くなる」を実現する。
// MapLibre の標準 circle レイヤーは同一レイヤー内でも重なりがアルファ加算されるため ① を満たせない。
//
// このページは A(標準 circle・素朴版=①違反の見本) と B(カスタムレイヤーで FBO 二層合成=目標) を
// 左右に並べ、同一のテスト点配置で重なりの濃さを目視比較する（開発機で完結）。
//
// B のカスタムレイヤー(FBO 二層合成)の原理 = 現行 SVG の <g opacity> と等価:
//   レベルごとに ①オフスクリーン FBO へ「不透明」で全点を描く（同レベルの重なりは上書き＝濃くならない）
//   → ②その FBO テクスチャを subThresholdOpacity(level) で本描画へ over 合成（レベル間は別 FBO なので積み重なる）
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

// 現行 KyoshinSubThreshold.tsx / kyoshinIntensity.ts と揃える
const MAX_SUB_IDX = 6
const SHINDO0_COLOR = '#9ca3af'
// 現行の実半径は BASE_RADIUS(2.5)×iconScale だが、重なりを目視しやすくするため PoC では拡大する
const TEST_RADIUS = 9

// index 0→0、index 6→0.35 の指数カーブ（現行と同一）
function subThresholdOpacity(idx: number): number {
  if (idx <= 0) return 0
  const t = idx / MAX_SUB_IDX
  return ((Math.exp(t) - 1) / (Math.E - 1)) * 0.35
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

type TestPoint = { lng: number; lat: number; index: number }

// ① と ② の差が見えるテスト配置:
//   クラスタ A = index3 を密集（同レベル重なり）／B = index5 を密集（同レベル重なり）
//   クラスタ C = 同じ場所に index3 と index5 を重ねる（レベル間重なり）
function makeTestPoints(): TestPoint[] {
  const pts: TestPoint[] = []
  let seed = 1
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const cluster = (cx: number, cy: number, index: number, n: number, spread: number) => {
    for (let i = 0; i < n; i++) {
      pts.push({ lng: cx + (rand() - 0.5) * spread, lat: cy + (rand() - 0.5) * spread, index })
    }
  }
  cluster(135.0, 37.0, 3, 80, 0.7) // A: index3 密集
  cluster(139.0, 37.0, 5, 80, 0.7) // B: index5 密集
  cluster(141.5, 39.0, 3, 80, 0.7) // C: index3 と…
  cluster(141.5, 39.0, 5, 80, 0.7) //    …index5 を重ねる
  return pts
}

function makeMap(container: string): maplibregl.Map {
  return new maplibregl.Map({
    container,
    center: [138.2, 38.0],
    zoom: 4.8,
    attributionControl: false,
    dragRotate: false,
    // 合成の濃淡が見やすいよう背景は暗い単色（タイルは敷かない）
    style: {
      version: 8,
      sources: {},
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#111418' } }],
    },
  })
}

function toFC(points: TestPoint[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    })),
  }
}

// A方式: レベルごとに標準 circle レイヤーを circle-opacity=subThresholdOpacity(level) で置く。
// 同一レベルの点も同一レイヤー内でアルファ加算されるため、重なると濃くなる（①違反）。
function addStandardLayers(map: maplibregl.Map, points: TestPoint[]) {
  for (let level = 1; level <= MAX_SUB_IDX; level++) {
    const feats = toFC(points.filter((p) => p.index === level))
    map.addSource(`std-${level}`, { type: 'geojson', data: feats })
    map.addLayer({
      id: `std-${level}`,
      type: 'circle',
      source: `std-${level}`,
      paint: {
        'circle-radius': TEST_RADIUS,
        'circle-color': SHINDO0_COLOR,
        'circle-opacity': subThresholdOpacity(level),
      },
    })
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

// 現行 SVG 見本（正解）: 現行 KyoshinSubThreshold と同じ <g opacity> 二層合成を、地図の project 座標で描く。
// カスタムレイヤー(B)がこの見本と一致すれば忠実。地図追従は move で再描画する（静止比較には十分）。
function addSvgReference(map: maplibregl.Map, points: TestPoint[]) {
  const container = map.getContainer()
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.style.position = 'absolute'
  svg.style.inset = '0'
  svg.style.width = '100%'
  svg.style.height = '100%'
  svg.style.pointerEvents = 'none'
  container.appendChild(svg)
  const groups: Record<number, SVGGElement> = {}
  for (let lv = 1; lv <= MAX_SUB_IDX; lv++) {
    const g = document.createElementNS(SVG_NS, 'g')
    g.setAttribute('opacity', String(subThresholdOpacity(lv)))
    svg.appendChild(g)
    groups[lv] = g
  }
  const draw = () => {
    for (const lv of Object.keys(groups)) groups[Number(lv)].replaceChildren()
    for (const p of points) {
      const s = map.project([p.lng, p.lat])
      const c = document.createElementNS(SVG_NS, 'circle')
      c.setAttribute('cx', String(s.x))
      c.setAttribute('cy', String(s.y))
      c.setAttribute('r', String(TEST_RADIUS))
      c.setAttribute('fill', SHINDO0_COLOR)
      groups[p.index].appendChild(c)
    }
  }
  draw()
  map.on('move', draw)
}

// --- B方式: カスタムレイヤーで FBO 二層合成 ---

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

function makeSubThresholdCustomLayer(points: TestPoint[]): maplibregl.CustomLayerInterface {
  const byLevel: Record<number, Float32Array> = {}
  for (let lv = 1; lv <= MAX_SUB_IDX; lv++) {
    const ps = points.filter((p) => p.index === lv)
    const arr = new Float32Array(ps.length * 2)
    ps.forEach((p, i) => {
      const m = maplibregl.MercatorCoordinate.fromLngLat({ lng: p.lng, lat: p.lat })
      arr[i * 2] = m.x
      arr[i * 2 + 1] = m.y
    })
    byLevel[lv] = arr
  }
  const COLOR = hexToRgb(SHINDO0_COLOR)

  let pointProg: WebGLProgram
  let quadProg: WebGLProgram
  let fbo: WebGLFramebuffer
  let tex: WebGLTexture
  let quadBuf: WebGLBuffer
  const pointBufs: Record<number, WebGLBuffer> = {}
  const pointCounts: Record<number, number> = {}
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

  return {
    id: 'subthreshold-custom',
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
      for (let lv = 1; lv <= MAX_SUB_IDX; lv++) {
        const b = gl.createBuffer()!
        gl.bindBuffer(gl.ARRAY_BUFFER, b)
        gl.bufferData(gl.ARRAY_BUFFER, byLevel[lv], gl.STATIC_DRAW)
        pointBufs[lv] = b
        pointCounts[lv] = byLevel[lv].length / 2
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
      // render 開始時の本描画 FBO（MapLibre のメイン描画先）を resize より前に控える。
      // resize は内部で fbo を bind するため、この取得を後ろに置くと初回フレームで mainFBO=fbo になり、
      // 合成が tex を読みつつ tex を attach した fbo へ描く feedback loop になる（レビュー MEDIUM1 の真因）。
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
        // resize でこのユニットに残った tex を外す（合成は TEXTURE0 だが resize は別ユニットのことがあり、
        // 残ると FBO 描画時に feedback loop を作る。ANGLE は全ユニットをチェックするため・レビュー MEDIUM1）
        gl.bindTexture(gl.TEXTURE_2D, null)
        texW = w
        texH = h
      }
      const matrix = args.defaultProjectionData.mainMatrix
      const dpr = window.devicePixelRatio || 1
      const size = TEST_RADIUS * 2 * dpr
      const marginPx = TEST_RADIUS * dpr + 1

      for (let lv = 1; lv <= MAX_SUB_IDX; lv++) {
        const count = pointCounts[lv]
        if (!count) continue

        // 最適化: このレベルの点のスクリーン BBox を求め、クリア・合成をそこだけに絞る（塗り面積削減）。
        // matrix は列優先 mat4。z=0 なので該当項のみ。
        const arr = byLevel[lv]
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (let i = 0; i < arr.length; i += 2) {
          const cw = matrix[3] * arr[i] + matrix[7] * arr[i + 1] + matrix[15]
          const sx = ((matrix[0] * arr[i] + matrix[4] * arr[i + 1] + matrix[12]) / cw) * 0.5 + 0.5
          const sy = (matrix[1] * arr[i] + matrix[5] * arr[i + 1] + matrix[13]) / cw
          const px = sx * w
          const py = (1 - (sy * 0.5 + 0.5)) * h
          if (px < minX) minX = px
          if (px > maxX) maxX = px
          if (py < minY) minY = py
          if (py > maxY) maxY = py
        }
        minX = Math.max(0, Math.floor(minX - marginPx))
        minY = Math.max(0, Math.floor(minY - marginPx))
        maxX = Math.min(w, Math.ceil(maxX + marginPx))
        maxY = Math.min(h, Math.ceil(maxY + marginPx))
        if (maxX <= minX || maxY <= minY) continue // 画面外
        // GL の scissor は左下原点。clear も合成 quad もこの矩形にクリップされる。
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(minX, h - maxY, maxX - minX, maxY - minY)

        // ① オフスクリーン FBO へ「不透明」で描く（BBox のみクリア・同レベル重なりは上書き＝濃くならない）
        // feedback loop 回避（レビュー MEDIUM1）: 前レベルの合成で bind した tex を、その tex を
        // attach した fbo の描画先にする前に外す。ANGLE は許容するが規格上グレーで実機保証が無い。
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
        gl.bindBuffer(gl.ARRAY_BUFFER, pointBufs[lv])
        gl.enableVertexAttribArray(aPos)
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
        gl.drawArrays(gl.POINTS, 0, count)

        // ② 本描画 FBO へ opacity を掛けて over 合成（BBox のみ塗る・レベル間は積み重なる）
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
        // 合成で使い終わった tex を、その場（activeTexture=TEXTURE0）で即外す。
        // 次レベルの FBO 描画（描画先が tex を attach）との feedback loop を確実に断つ（レビュー MEDIUM1）。
        gl.bindTexture(gl.TEXTURE_2D, null)

        gl.disable(gl.SCISSOR_TEST)
      }

      // GL 状態を復元（CustomLayerInterface の作法・レビュー LOW3。MapLibre も再設定するが、
      // 次フレーム冒頭の feedback loop 予防も兼ねて明示的に外す）。
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
      gl.deleteBuffer(quadBuf)
      for (const lv of Object.keys(pointBufs)) gl.deleteBuffer(pointBufs[Number(lv)])
    },
  } as maplibregl.CustomLayerInterface
}

const points = makeTestPoints()
const mapStd = makeMap('map-std')
const mapSvg = makeMap('map-svg')
const mapCustom = makeMap('map-custom')

let ready = 0
const onReady = () => {
  ready++
  if (ready < 3) return
  const el = document.getElementById('stat')
  if (el) {
    const byIdx = (i: number) => points.filter((p) => p.index === i).length
    el.textContent = [
      `点: ${points.length}（index3=${byIdx(3)} / index5=${byIdx(5)}）`,
      `A: index3 密集 / B: index5 密集 / C: index3+5 重なり`,
      `opacity: index3=${subThresholdOpacity(3).toFixed(3)} index5=${subThresholdOpacity(5).toFixed(3)}`,
      `左=標準(①違反) / 中=現行SVG(正解) / 右=カスタムレイヤー(目標)。中と右が一致すれば忠実`,
    ].join('\n')
  }
  ;(window as unknown as { __subReady: boolean }).__subReady = true
}

mapStd.on('load', () => {
  addStandardLayers(mapStd, points)
  onReady()
})
mapSvg.on('load', () => {
  addSvgReference(mapSvg, points)
  onReady()
})
mapCustom.on('load', () => {
  mapCustom.addLayer(makeSubThresholdCustomLayer(points))
  onReady()
})

Object.assign(window as unknown as Record<string, unknown>, {
  __subMaps: { std: mapStd, svg: mapSvg, custom: mapCustom },
  __subPoints: points,
})

// --- FPS 計測（実機での動作可否＋性能確認用。3方式=標準/SVG/カスタムを同条件で比較） ---
const REPORT_URL = '/__perf-report'
const allMaps: Record<string, maplibregl.Map> = { std: mapStd, svg: mapSvg, custom: mapCustom }

function startSubDrive(map: maplibregl.Map, phase: 'static' | 'pan' | 'zoom'): () => void {
  if (phase === 'static') return () => {}
  let id = 0
  let dir = 1
  let moved = 0
  const step = () => {
    if (phase === 'pan') {
      map.panBy([6 * dir, 0], { animate: false })
      moved += 6
      if (moved >= 500) {
        moved = 0
        dir *= -1
      }
    } else {
      const z = map.getZoom()
      let nz = z + 0.02 * dir
      if (nz >= 6.5) {
        nz = 6.5
        dir = -1
      } else if (nz <= 3.5) {
        nz = 3.5
        dir = 1
      }
      map.setZoom(nz)
    }
    id = requestAnimationFrame(step)
  }
  id = requestAnimationFrame(step)
  return () => cancelAnimationFrame(id)
}

// 指定マップ(std/svg/custom)だけを phase 駆動しながら rAF フレーム間隔・longtask を測り /__perf-report へ送る。
// 他マップは静止＝再描画されないため、対象方式の負荷を切り出して測れる。
async function measureSub(
  mapKey: string,
  phase: 'static' | 'pan' | 'zoom' = 'pan',
  durationMs = 8000,
  label = 'sub',
) {
  const map = allMaps[mapKey]
  if (!map) throw new Error('unknown map: ' + mapKey)
  await new Promise<void>((r) => {
    const t = setTimeout(r, 2000)
    map.once('idle', () => {
      clearTimeout(t)
      r()
    })
  })
  const frames: number[] = []
  let lastT = performance.now()
  let rafId = requestAnimationFrame(function loop(t) {
    frames.push(t - lastT)
    lastT = t
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
  const stop = startSubDrive(map, phase)
  await new Promise((r) => setTimeout(r, durationMs))
  stop()
  cancelAnimationFrame(rafId)
  if (po) po.disconnect()
  frames.shift()
  const sorted = [...frames].sort((a, b) => a - b)
  const pick = (q: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null
  const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100)
  const result = {
    meta: {
      when: new Date().toISOString(),
      label,
      mapKey,
      phase,
      durationMs,
      url: location.href,
      ua: navigator.userAgent,
      viewport: `${innerWidth}x${innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      points: points.length,
    },
    frame: {
      frames: sorted.length,
      fps: round(sorted.length / (durationMs / 1000)),
      p50: round(pick(0.5)),
      p95: round(pick(0.95)),
      max: round(sorted[sorted.length - 1] ?? null),
    },
    longTask: {
      count: po ? longTasks.length : -1,
      totalMs: round(longTasks.reduce((a, b) => a + b, 0)),
      maxMs: round(longTasks.length ? Math.max(...longTasks) : 0),
    },
  }
  try {
    const res = await fetch(REPORT_URL, { method: 'POST', body: JSON.stringify(result) })
    console.log(`[sub] ${label} ${mapKey}/${phase}:`, res.ok ? await res.text() : 'HTTP ' + res.status, result.frame)
  } catch (e) {
    console.warn('[sub] report 送信失敗（結果はログから回収可）', e, result)
  }
  return result
}

Object.assign(window as unknown as Record<string, unknown>, {
  __measureSub: measureSub,
  // 実機で await window.__runSubSuite('surface-go2-sub') を1回。3方式 × 静止/パン/ズームの証跡が保存される。
  __runSubSuite: async (labelBase = 'sub', durationMs = 8000) => {
    for (const key of ['std', 'svg', 'custom']) {
      for (const phase of ['static', 'pan', 'zoom'] as const) {
        await measureSub(key, phase, durationMs, `${labelBase}-${key}`)
      }
    }
    console.log('[sub] suite 完了')
  },
})
