// 【PoC専用・使い捨て】検証項目4: 活断層クリックの当たり判定（bbox方式）検証。
//
// 本番（ActiveFaultsLayer.tsx・JapanMap.tsx 調査済み）は「可視線(SVG, interactive:false) ＋
// 当たり判定専用の透明 Canvas 線（L.canvas({ tolerance: 8 })）」という構成。プレート境界線・
// 津波海岸線も同一パターン。MapLibre の queryRenderedFeatures には tolerance 相当のオプションが
// 無いため、クリック点を中心にした小さな正方形 bbox（1辺 2r px）を渡してヒット判定する
// 「bbox方式」で代替する（AskUserQuestion で確定・code-architect 調査での2択のうち採用）。
//
// オフセット距離を正確に制御して検証するため、実データ(活断層)は背景の見た目確認用として
// 重ねつつ、地図中心を通る「既知の直線」を1本追加する。この直線の緯度は固定・経度のみ動く
// ため、緯度方向のオフセット量をピクセル単位で厳密に作れる。
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, MultiLineString, LineString } from 'geojson'

const JAPAN_CENTER: [number, number] = [137.7, 38.25] // MapLibre は [lng, lat]
const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'
const FAULT_COLOR = '#c2410c'
const TEST_LINE_COLOR = '#22d3ee'
// 本番の ActiveFaultsLayer.tsx 当たり判定線（L.canvas tolerance:8）相当として採用する基準値
// （§6 検証項目4の実測でも r=8 が tolerance:8 と境界一致することを確認済み）
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

// bbox方式の当たり判定本体。(x, y) はキャンバス相対のスクリーン座標、r は許容半径(px)。
// 本番の tolerance:8 に対応する許容量として、1辺 2r px の正方形 bbox を渡す。
function hitTest(x: number, y: number, r: number, layers = ['faults', 'testline']): HitResult {
  const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
    [x - r, y - r],
    [x + r, y + r],
  ]
  const features = map.queryRenderedFeatures(bbox, { layers })
  const names = [
    ...new Set(features.map((f) => (f.properties as { name?: string } | null)?.name ?? '?')),
  ]
  return { hit: features.length > 0, names }
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
