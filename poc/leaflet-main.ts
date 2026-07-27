// 【PoC専用・使い捨て】検証項目2: Leaflet 側の律速切り分け（poc/main.ts の Leaflet 版）。
// 計測ロジック・条件の対応関係は poc/leaflet-measure.ts のヘッダコメント参照。
//
// 本番の描画方式に揃える点（src/components/Map/ 調査）:
//   - 活断層（ActiveFaultsLayer.tsx）: SVGレンダラー・L.polyline（セグメント単位でmulti-polyline）
//     ※本番は当たり判定用の透明Canvasヒット線を可視線と重ねて持つが、MapLibre版PoC(poc/main.ts)に
//       対応物が無いため本PoCでは省略する（条件を揃えることを優先）
//   - 観測点（KyoshinPoints.tsx）: SVGレンダラー・L.circleMarker、stroke無し・fillColor固定
//   - 背景タイル（JapanMap.tsx）: 同じGEBCOタイル・maxNativeZoom=10・keepBuffer=4・
//     updateWhenZooming=false・updateWhenIdle=true をそのまま踏襲
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { installLeafletMeasure } from './leaflet-measure'
import type { Axis } from './leaflet-measure'

const JAPAN_CENTER: [number, number] = [38.25, 137.7] // Leaflet は [lat, lng]
const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'
const FAULT_COLOR = '#c2410c'
const SHINDO0_COLOR = '#9ca3af'
const BASE_RADIUS = 2.5
const TARGET_POINTS = 1725
// mapCanvasPadding.ts と同値（Leaflet Canvas/SVGレンダラー共通のバッファ余白）
const MAP_CANVAS_PADDING = 2

const params = new URLSearchParams(location.search)
const initFaults = params.get('faults') === 'thin' ? 'thin' : 'full'
const initLineWidth = Number(params.get('lw') ?? '1.2')
const initPointsOn = params.get('points') !== 'off'

// zoomSnap:0 はPoC専用設定。leaflet-measure.tsの連続ズーム駆動(0.02刻み)に対応するため
// 本番の整数スナップを外す（本番のJapanMap.tsxはzoomSnap既定のまま）。
const map = L.map('map', {
  center: JAPAN_CENTER,
  zoom: 5,
  zoomSnap: 0,
  zoomDelta: 0.25,
  attributionControl: false,
  preferCanvas: false, // 本番のSVGレンダラー構成に揃える
})

const tileLayer = L.tileLayer(BATHYMETRY_URL, {
  maxNativeZoom: 10,
  keepBuffer: 4,
  updateWhenZooming: false,
  updateWhenIdle: true,
}).addTo(map)

type FaultSeg = { name: string; lines: [number, number][][] }

async function loadFaults(mode: 'full' | 'thin'): Promise<FaultSeg[]> {
  const url = mode === 'full' ? '/data/active-faults-full.json' : '/data/active-faults.json'
  return fetch(url).then((r) => r.json())
}

async function loadPoints(): Promise<[number, number][]> {
  const d: { stations: Record<string, [number, number]> } = await fetch(
    '/data/station-coords.json',
  ).then((r) => r.json())
  const coords = Object.values(d.stations)
  // floor で間引き間隔を決める（round だと目標の85%しか残らない。poc/main.ts と同じ・レビュー LOW2）
  const step = Math.max(1, Math.floor(coords.length / TARGET_POINTS))
  return coords.filter((_, i) => i % step === 0).slice(0, TARGET_POINTS)
}

function countVertices(segs: FaultSeg[]): number {
  let v = 0
  for (const seg of segs) for (const line of seg.lines) v += line.length
  return v
}

let faultVertices = 0
let pointCount = 0
function updateStat(): void {
  const el = document.getElementById('stat')
  if (!el) return
  el.textContent = [
    `faults : ${state.faults}  (${faultVertices.toLocaleString()} 頂点)`,
    `points : ${state.pointsOn ? pointCount.toLocaleString() : 'off'}`,
    `line-w : ${state.lineWidth}`,
    `pixelR : ${window.devicePixelRatio}（Leafletは軸として制御不可・申し送り）`,
    `zoom   : ${map.getZoom().toFixed(2)}`,
  ].join('\n')
}

const state = {
  faults: initFaults as 'full' | 'thin',
  lineWidth: initLineWidth,
  pointsOn: initPointsOn,
}

// 本番同様の専用ペインを作る（JapanMap.tsx 'line-layers' z=263・BaseMap.tsx 'kyoshin-points' z=400）。
// レンダラーだけ揃えてペイン未指定だと既定の overlayPane に入り、本番の z-index 構成と異なる状態で
// 計測することになる（レビュー MEDIUM）。
const lineLayersPane = map.createPane('line-layers')
lineLayersPane.style.zIndex = '263'
const kyoshinPointsPane = map.createPane('kyoshin-points')
kyoshinPointsPane.style.zIndex = '400'
const faultRenderer = L.svg({ pane: 'line-layers', padding: MAP_CANVAS_PADDING })
const pointRenderer = L.svg({ pane: 'kyoshin-points', padding: MAP_CANVAS_PADDING })
let faultLayer: L.LayerGroup | null = null
let pointLayer: L.LayerGroup | null = null

function buildFaultLayer(segs: FaultSeg[]): L.LayerGroup {
  const group = L.layerGroup()
  for (const seg of segs) {
    L.polyline(seg.lines, {
      renderer: faultRenderer,
      color: FAULT_COLOR,
      weight: state.lineWidth,
      opacity: 0.65,
      interactive: false,
    }).addTo(group)
  }
  return group
}

function buildPointLayer(coords: [number, number][]): L.LayerGroup {
  const group = L.layerGroup()
  for (const [lat, lng] of coords) {
    L.circleMarker([lat, lng], {
      renderer: pointRenderer,
      radius: BASE_RADIUS,
      stroke: false,
      fillColor: SHINDO0_COLOR,
      fillOpacity: state.pointsOn ? 0.85 : 0,
      interactive: false,
    }).addTo(group)
  }
  return group
}

let pointCoords: [number, number][] = []

async function init(): Promise<void> {
  const [segs, coords] = await Promise.all([loadFaults(state.faults), loadPoints()])
  faultVertices = countVertices(segs)
  pointCoords = coords
  pointCount = coords.length

  faultLayer = buildFaultLayer(segs)
  faultLayer.addTo(map)
  pointLayer = buildPointLayer(coords)
  pointLayer.addTo(map)

  ;(window as unknown as { __pocReady: boolean }).__pocReady = true
  updateStat()
}
void init()

map.on('zoomend', updateStat)

// --- コントロール UI 配線 ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const faultsSel = $<HTMLSelectElement>('faults')
faultsSel.value = state.faults
faultsSel.addEventListener('change', async () => {
  state.faults = faultsSel.value as 'full' | 'thin'
  const segs = await loadFaults(state.faults)
  faultVertices = countVertices(segs)
  faultLayer?.remove()
  faultLayer = buildFaultLayer(segs)
  faultLayer.addTo(map)
  updateStat()
})

const lw = $<HTMLInputElement>('lw')
lw.value = String(state.lineWidth)
$('lwVal').textContent = String(state.lineWidth)
lw.addEventListener('input', () => {
  state.lineWidth = Number(lw.value)
  $('lwVal').textContent = String(state.lineWidth)
  faultLayer?.eachLayer((l) => (l as L.Polyline).setStyle({ weight: state.lineWidth }))
  updateStat()
})

const pointsChk = $<HTMLInputElement>('points')
pointsChk.checked = state.pointsOn
pointsChk.addEventListener('change', () => {
  state.pointsOn = pointsChk.checked
  pointLayer?.eachLayer((l) => (l as L.CircleMarker).setStyle({ fillOpacity: state.pointsOn ? 0.85 : 0 }))
  updateStat()
})

// 手動確認用のパン/ズーム試験（本計測は leaflet-measure.ts の計測スクリプトが自動駆動する）
$('panBtn').addEventListener('click', () => {
  map.panBy([180, 120], { animate: true, duration: 0.6 })
})
$('zoomBtn').addEventListener('click', () => {
  const z = map.getZoom()
  map.setZoom(z < 6.5 ? z + 1.5 : z - 1.5, { animate: true, duration: 0.7 })
})

// 計測ランナー用: 軸を適用しUI・statも同期する（Leafletの描画は同期的なためMapLibre版のような
// 'idle'待ちは不要。fetchの完了待ち以外は即座に反映される）
async function applyAxis(a: Axis): Promise<void> {
  if (a.faults && a.faults !== state.faults) {
    state.faults = a.faults
    faultsSel.value = a.faults
    const segs = await loadFaults(a.faults)
    faultVertices = countVertices(segs)
    faultLayer?.remove()
    faultLayer = buildFaultLayer(segs)
    faultLayer.addTo(map)
  }
  if (a.lw != null) {
    state.lineWidth = a.lw
    lw.value = String(a.lw)
    $('lwVal').textContent = String(a.lw)
    faultLayer?.eachLayer((l) => (l as L.Polyline).setStyle({ weight: a.lw! }))
  }
  if (a.points != null) {
    state.pointsOn = a.points
    pointsChk.checked = a.points
    pointLayer?.eachLayer((l) => (l as L.CircleMarker).setStyle({ fillOpacity: a.points ? 0.85 : 0 }))
  }
  updateStat()
}

installLeafletMeasure({
  map,
  tileLayer,
  applyAxis,
  snapshot: () => ({
    faults: state.faults,
    faultVertices,
    points: state.pointsOn ? pointCount : 0,
    lineWidth: state.lineWidth,
    canvasW: map.getContainer().clientWidth,
    canvasH: map.getContainer().clientHeight,
    jsHeapMB: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      ? Math.round(
          (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize /
            1048576,
        )
      : null,
  }),
})

Object.assign(window as unknown as Record<string, unknown>, {
  __leafletMap: map,
  __leafletState: state,
  __leafletPointCoords: () => pointCoords,
})
