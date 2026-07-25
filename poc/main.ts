// 【PoC専用・使い捨て】層B（フル解像度の線/面の描画負荷）の律速切り分け。
//
// 素の maplibre-gl（React 無し）で、背景ラスタータイル＋活断層(line)＋観測点(circle) を描く。
// 目的は「層 B の重さの正体が CPU（頂点処理）か GPU フィルレート（塗り面積）か」を実機で切り分けること。
// そのため負荷の3軸を実行時に独立で振れるようにする（計画書 §6 測定方法）:
//   - 頂点数軸  : 活断層 full(31,646頂点) / thin(9,874頂点) の切替
//   - 塗り面積軸: line-width（被覆ピクセル）
//   - DPR軸    : map.setPixelRatio（描画バッファ解像度＝塗り面積は DPR² に比例）
// パラメータは URL クエリ(?faults=full&lw=1.2&pr=1&points=on)でも UI でも与えられる。
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, MultiLineString, Point } from 'geojson'
import { installMeasure } from './measure'

// 本体 JapanMap.tsx / ActiveFaultsLayer.tsx / kyoshinIntensity.ts と揃える描画パラメータ
const JAPAN_CENTER: [number, number] = [137.7, 38.25] // MapLibre は [lng, lat]
const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'
const FAULT_COLOR = '#c2410c'
const SHINDO0_COLOR = '#9ca3af'
const BASE_RADIUS = 2.5
// 現行の強震モニタ観測点数（約1,725）に合わせて station-coords(4,372) を均等サンプリングする
const TARGET_POINTS = 1725

const params = new URLSearchParams(location.search)
const initFaults = params.get('faults') === 'thin' ? 'thin' : 'full'
const initLineWidth = Number(params.get('lw') ?? '1.2')
const initPixelRatio = Number(params.get('pr') ?? String(window.devicePixelRatio || 1))
const initPointsOn = params.get('points') !== 'off'

const map = new maplibregl.Map({
  container: 'map',
  center: JAPAN_CENTER,
  zoom: 5,
  pixelRatio: initPixelRatio,
  attributionControl: false,
  // 素の描画負荷を測るため、ラベル等の余計なレイヤーは持たせない
  style: {
    version: 8,
    sources: {
      gebco: { type: 'raster', tiles: [BATHYMETRY_URL], tileSize: 256 },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } },
      { id: 'gebco', type: 'raster', source: 'gebco' },
    ],
  },
})

// 座標データは [lat, lon] 順、GeoJSON は [lng, lat] 順のため入れ替える（計画書 §4）
type FaultSeg = { name: string; lines: [number, number][][] }

async function loadFaults(mode: 'full' | 'thin'): Promise<FeatureCollection<MultiLineString>> {
  const url = mode === 'full' ? '/data/active-faults-full.json' : '/data/active-faults.json'
  const segs: FaultSeg[] = await fetch(url).then((r) => r.json())
  return {
    type: 'FeatureCollection',
    features: segs.map((seg) => ({
      type: 'Feature',
      properties: { name: seg.name },
      geometry: {
        type: 'MultiLineString',
        coordinates: seg.lines.map((line) => line.map(([lat, lon]) => [lon, lat])),
      },
    })),
  }
}

async function loadPoints(): Promise<FeatureCollection<Point>> {
  const d: { stations: Record<string, [number, number]> } = await fetch(
    '/data/station-coords.json',
  ).then((r) => r.json())
  const coords = Object.values(d.stations)
  const step = Math.max(1, Math.round(coords.length / TARGET_POINTS))
  const sampled = coords.filter((_, i) => i % step === 0).slice(0, TARGET_POINTS)
  return {
    type: 'FeatureCollection',
    features: sampled.map(([lat, lon]) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [lon, lat] },
    })),
  }
}

// stat パネル: 現在のパラメータと頂点数・観測点数を表示（計測時の状態確認用）
let faultVertices = 0
let pointCount = 0
function updateStat() {
  const el = document.getElementById('stat')
  if (!el) return
  el.textContent = [
    `faults : ${state.faults}  (${faultVertices.toLocaleString()} 頂点)`,
    `points : ${state.pointsOn ? pointCount.toLocaleString() : 'off'}`,
    `line-w : ${state.lineWidth}`,
    `pixelR : ${map.getPixelRatio?.() ?? state.pixelRatio}  (device ${window.devicePixelRatio})`,
    `zoom   : ${map.getZoom().toFixed(2)}`,
  ].join('\n')
}

const state = {
  faults: initFaults as 'full' | 'thin',
  lineWidth: initLineWidth,
  pixelRatio: initPixelRatio,
  pointsOn: initPointsOn,
}

function countVertices(fc: FeatureCollection<MultiLineString>): number {
  let v = 0
  for (const f of fc.features) for (const line of f.geometry.coordinates) v += line.length
  return v
}

map.on('load', async () => {
  const [faults, points] = await Promise.all([loadFaults(state.faults), loadPoints()])
  faultVertices = countVertices(faults)
  pointCount = points.features.length

  map.addSource('faults', { type: 'geojson', data: faults })
  map.addLayer({
    id: 'faults',
    type: 'line',
    source: 'faults',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': FAULT_COLOR, 'line-width': state.lineWidth, 'line-opacity': 0.65 },
  })

  map.addSource('points', { type: 'geojson', data: points })
  map.addLayer({
    id: 'points',
    type: 'circle',
    source: 'points',
    paint: {
      'circle-radius': BASE_RADIUS,
      'circle-color': SHINDO0_COLOR,
      'circle-opacity': state.pointsOn ? 0.85 : 0,
    },
  })

  ;(window as unknown as { __pocReady: boolean }).__pocReady = true
  updateStat()
})

map.on('zoomend', updateStat)
map.on('error', (e) => {
  const el = document.getElementById('stat')
  if (el) el.textContent = 'ERROR: ' + (e.error?.message ?? String(e))
  console.error('[poc] map error', e.error)
})

// --- コントロール UI 配線 ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const faultsSel = $<HTMLSelectElement>('faults')
faultsSel.value = state.faults
faultsSel.addEventListener('change', async () => {
  state.faults = faultsSel.value as 'full' | 'thin'
  const fc = await loadFaults(state.faults)
  faultVertices = countVertices(fc)
  ;(map.getSource('faults') as maplibregl.GeoJSONSource | undefined)?.setData(fc)
  updateStat()
})

const lw = $<HTMLInputElement>('lw')
lw.value = String(state.lineWidth)
$('lwVal').textContent = String(state.lineWidth)
lw.addEventListener('input', () => {
  state.lineWidth = Number(lw.value)
  $('lwVal').textContent = String(state.lineWidth)
  if (map.getLayer('faults')) map.setPaintProperty('faults', 'line-width', state.lineWidth)
  updateStat()
})

const pr = $<HTMLInputElement>('pr')
pr.value = String(state.pixelRatio)
$('prVal').textContent = String(state.pixelRatio)
pr.addEventListener('input', () => {
  state.pixelRatio = Number(pr.value)
  $('prVal').textContent = String(state.pixelRatio)
  map.setPixelRatio(state.pixelRatio)
  updateStat()
})

const pointsChk = $<HTMLInputElement>('points')
pointsChk.checked = state.pointsOn
pointsChk.addEventListener('change', () => {
  state.pointsOn = pointsChk.checked
  if (map.getLayer('points'))
    map.setPaintProperty('points', 'circle-opacity', state.pointsOn ? 0.85 : 0)
  updateStat()
})

// 手動確認用のパン/ズーム試験（本計測は scripts/perf の計測スクリプトが自動駆動する）
$('panBtn').addEventListener('click', () => {
  map.panBy([180, 120], { duration: 600 })
})
$('zoomBtn').addEventListener('click', () => {
  const z = map.getZoom()
  map.easeTo({ zoom: z < 6.5 ? z + 1.5 : z - 1.5, duration: 700 })
})

// 計測ランナー用: 3軸を適用し UI・stat も同期して、描画が落ち着くまで待つ
async function applyAxis(a: { faults?: 'full' | 'thin'; lw?: number; pr?: number; points?: boolean }) {
  if (a.faults && a.faults !== state.faults) {
    state.faults = a.faults
    faultsSel.value = a.faults
    const fc = await loadFaults(a.faults)
    faultVertices = countVertices(fc)
    ;(map.getSource('faults') as maplibregl.GeoJSONSource | undefined)?.setData(fc)
    await new Promise<void>((res) => {
      const t = setTimeout(res, 8000)
      map.once('idle', () => {
        clearTimeout(t)
        res()
      })
    })
  }
  if (a.lw != null) {
    state.lineWidth = a.lw
    lw.value = String(a.lw)
    $('lwVal').textContent = String(a.lw)
    if (map.getLayer('faults')) map.setPaintProperty('faults', 'line-width', a.lw)
  }
  if (a.pr != null) {
    state.pixelRatio = a.pr
    pr.value = String(a.pr)
    $('prVal').textContent = String(a.pr)
    map.setPixelRatio(a.pr)
  }
  if (a.points != null) {
    state.pointsOn = a.points
    pointsChk.checked = a.points
    if (map.getLayer('points')) map.setPaintProperty('points', 'circle-opacity', a.points ? 0.85 : 0)
  }
  updateStat()
}

installMeasure({
  map,
  applyAxis,
  snapshot: () => ({
    faults: state.faults,
    faultVertices,
    points: state.pointsOn ? pointCount : 0,
    lineWidth: state.lineWidth,
    pixelRatio:
      (map as unknown as { getPixelRatio?: () => number }).getPixelRatio?.() ?? state.pixelRatio,
    canvasW: map.getCanvas().width,
    canvasH: map.getCanvas().height,
  }),
})

// 計測スクリプトから触れるよう map と現在状態を露出する
Object.assign(window as unknown as Record<string, unknown>, {
  __pocMap: map,
  __pocState: state,
})
