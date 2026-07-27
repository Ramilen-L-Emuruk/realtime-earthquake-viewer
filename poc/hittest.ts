// 【PoC専用・使い捨て】検証項目4: 活断層クリックの当たり判定（bbox方式）検証。
//
// 本番（ActiveFaultsLayer.tsx・JapanMap.tsx 調査済み）は「可視線(SVG, interactive:false) ＋
// 当たり判定専用の透明 Canvas 線（L.canvas({ tolerance: 8 })）」という構成。Leaflet の
// tolerance 判定は pointToSegmentDistance（ユークリッド距離）による**円**（半径 tolerance）。
// MapLibre の queryRenderedFeatures には tolerance 相当のオプションが無いため bbox 方式で
// 代替するが、bbox は**正方形**であり、円とは斜め方向で最大 √2 倍（r=8px→11.3px）ずれる
// （レビュー HIGH1: 当初は水平線+垂直オフセットのみで検証しており、円と正方形が恒等的に
// 一致する軸だけを見ていた・境界一致は無情報な結果だった）。
// 対処として、bbox はブロードフェーズ（候補の粗い絞り込み）にとどめ、候補フィーチャーに対し
// 実際の点-線分距離（ユークリッド・円判定）でナローフェーズ絞り込みを行う（レビュー推奨(b)）。
// 円は正方形 bbox（1辺2r、同心）に必ず内接するため、bbox が円判定の候補を取りこぼすことはない。
//
// オフセット距離を正確に制御して検証するため、実データ(活断層)は背景の見た目確認用として
// 重ねつつ、地図中心を通る「既知の直線」を1本追加する。この直線の緯度は固定・経度のみ動く
// ため、緯度方向のオフセット量をピクセル単位で厳密に作れる。
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, MultiLineString, LineString, Position } from 'geojson'

const JAPAN_CENTER: [number, number] = [137.7, 38.25] // MapLibre は [lng, lat]
const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'
const FAULT_COLOR = '#c2410c'
const TEST_LINE_COLOR = '#22d3ee'
// 本番の ActiveFaultsLayer.tsx 当たり判定線（L.canvas tolerance:8）に合わせる基準値。
// ナローフェーズを円判定にしたことで tolerance:8 の円に対応するが、Leaflet の実効許容半径は
// 厳密には `tolerance + weight/2`（stroke省略時のデフォルト true・ソース直読で確認済み）。
// 本番の当たり判定線は weight が活断層1.2・プレート境界2・津波海岸線は可変（grade×iconScale）
// とレイヤーごとに異なるため、単一の r で全レイヤーに厳密一致させることはできない。
// r=8 は素の tolerance 値であり、本番はレイヤーにより +0.6px（活断層）〜+1px（プレート境界）
// 程度広い、という残差がある前提で採用する（レビュー指摘・セルフレビューで精度主張を訂正）。
const DEFAULT_R = 8

const map = new maplibregl.Map({
  container: 'map',
  center: JAPAN_CENTER,
  zoom: 8,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      // maxzoom: ソース自体がz10までしか無いため、当たり判定検証用に z11 以上へズームすると
      // 存在しないタイルへの 404 が出る（本 PoC で実際に踏んだ）。maxzoom を指定すると
      // MapLibre がそれ以上は z10 タイルをオーバーズーム表示し、余計なリクエストを出さない。
      gebco: { type: 'raster', tiles: [BATHYMETRY_URL], tileSize: 256, maxzoom: 10 },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } },
      { id: 'gebco', type: 'raster', source: 'gebco' },
    ],
  },
})

type FaultSeg = { name: string; lines: [number, number][][] }

async function loadFaults(): Promise<FeatureCollection<MultiLineString>> {
  const segs: FaultSeg[] = await fetch('/data/active-faults-full.json').then((r) => r.json())
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

// テスト用の直線: 地図中心の緯度を通る東西線（経度方向に±1度）。
// 緯度が固定なので、この線からのオフセットは常に「南北方向の見かけピクセル距離」として
// 厳密に制御できる（zoom に応じて px/度は変わるが、実行時に map.project() で逆算して使う）。
const TEST_LINE_LAT = JAPAN_CENTER[1]
const testLineFC: FeatureCollection<LineString> = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'テスト線（既知座標）' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [JAPAN_CENTER[0] - 1, TEST_LINE_LAT],
          [JAPAN_CENTER[0] + 1, TEST_LINE_LAT],
        ],
      },
    },
  ],
}

function updateStat(text: string): void {
  const el = document.getElementById('stat')
  if (el) el.textContent = text
}

map.on('load', async () => {
  const faults = await loadFaults()
  map.addSource('faults', { type: 'geojson', data: faults })
  map.addLayer({
    id: 'faults',
    type: 'line',
    source: 'faults',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': FAULT_COLOR, 'line-width': 1.2, 'line-opacity': 0.65 },
  })

  map.addSource('testline', { type: 'geojson', data: testLineFC })
  map.addLayer({
    id: 'testline',
    type: 'line',
    source: 'testline',
    paint: { 'line-color': TEST_LINE_COLOR, 'line-width': 1.2 },
  })

  ;(window as unknown as { __pocReady: boolean }).__pocReady = true
  updateStat(`zoom: ${map.getZoom().toFixed(2)}\nr(px): ${DEFAULT_R}\nクリックして当たり判定を確認`)
})

map.on('error', (e) => {
  updateStat('ERROR: ' + (e.error?.message ?? String(e)))
  console.error('[hittest] map error', e.error)
})

export interface HitResult {
  hit: boolean
  names: string[]
}

// 点(px,py)から線分(ax,ay)-(bx,by)への最短距離（スクリーンピクセル、ユークリッド）。
// Leaflet の pointToSegmentDistance と同じ考え方（本番の当たり判定に合わせる）。
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// フィーチャーの LineString/MultiLineString 全セグメントに対する、点(x,y)からの最短距離(px)。
// 各頂点は都度 map.project() でスクリーン座標に変換する（PoC規模の候補数・頂点数なら十分軽い）。
function nearestDistancePx(x: number, y: number, feature: maplibregl.MapGeoJSONFeature): number {
  const geom = feature.geometry
  const lines: Position[][] =
    geom.type === 'LineString'
      ? [geom.coordinates]
      : geom.type === 'MultiLineString'
        ? geom.coordinates
        : []
  let minDist = Infinity
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = map.project(line[i] as [number, number])
      const b = map.project(line[i + 1] as [number, number])
      const d = distToSegment(x, y, a.x, a.y, b.x, b.y)
      if (d < minDist) minDist = d
    }
  }
  return minDist
}

// bbox方式の当たり判定本体。(x, y) はキャンバス相対のスクリーン座標、r は許容半径(px)。
// ブロードフェーズ: 1辺 2r px の正方形 bbox で候補を粗く絞る（bboxは円に外接するため
// 取りこぼしはない）。ナローフェーズ: 候補に対し実際の点-線分距離（円判定）で絞り込み、
// 本番の tolerance:8（円）と一致する当たり判定にする（レビュー HIGH1 対応）。
function hitTest(x: number, y: number, r: number, layers = ['faults', 'testline']): HitResult {
  const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
    [x - r, y - r],
    [x + r, y + r],
  ]
  const candidates = map.queryRenderedFeatures(bbox, { layers })
  const hitFeatures = candidates.filter((f) => nearestDistancePx(x, y, f) <= r)
  const names = [
    ...new Set(hitFeatures.map((f) => (f.properties as { name?: string } | null)?.name ?? '?')),
  ]
  return { hit: hitFeatures.length > 0, names }
}

map.on('click', (e) => {
  const r = Number((document.getElementById('r') as HTMLInputElement).value)
  const result = hitTest(e.point.x, e.point.y, r)
  updateStat(
    [
      `click  : (${e.point.x.toFixed(0)}, ${e.point.y.toFixed(0)})`,
      `zoom   : ${map.getZoom().toFixed(2)}`,
      `r(px)  : ${r}`,
      `hit    : ${result.hit}`,
      `names  : ${result.names.join(', ') || '-'}`,
    ].join('\n'),
  )
})

// 本番（Leaflet版）は当たり判定用の透明線が interactive なため、Leaflet が自動で
// leaflet-interactive クラス経由の cursor:pointer をホバー時に当てる。MapLibre には
// この自動処理が無いため、mousemove のたびに同じ bbox 判定を呼んでカーソルを手動で切り替える。
// 状態が変わったときだけ style を書き換え、無駄な再代入を避ける。
let hovering = false
map.on('mousemove', (e) => {
  const r = Number((document.getElementById('r') as HTMLInputElement).value)
  const hit = hitTest(e.point.x, e.point.y, r).hit
  if (hit !== hovering) {
    hovering = hit
    map.getCanvas().style.cursor = hovering ? 'pointer' : ''
  }
})

const rInput = document.getElementById('r') as HTMLInputElement
rInput.value = String(DEFAULT_R)
const rValEl = document.getElementById('rVal') as HTMLElement
rValEl.textContent = String(DEFAULT_R)
rInput.addEventListener('input', () => {
  rValEl.textContent = rInput.value
})

// Playwright からの自動テスト用に、地図・当たり判定関数・テスト線の緯度経度を露出する。
// 緯度経度→スクリーン座標の変換は map.project() を使い、Playwright 側では正確な px
// オフセットを自分で計算せず、この投影結果を基準にオフセットを積む。
Object.assign(window as unknown as Record<string, unknown>, {
  __hittestMap: map,
  __hitTest: hitTest,
  __testLineLngLat: { lng: JAPAN_CENTER[0], lat: TEST_LINE_LAT },
})
