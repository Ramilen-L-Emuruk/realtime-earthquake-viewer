// 【PoC専用・使い捨て】§8「テキスト描画（ラベル・ツールチップ）」の検証。
//
// 計画書は「MapLibre で GPU 描画するには symbol レイヤー＋日本語グリフ（フォント PBF）の
// 自前生成・ホストが要る」と見積もっていたが、MapLibre 公式リポジトリの test/examples
// （Context7 で裏取り）には、style に `glyphs` を一切設定せず `text-font` に OS 標準の
// 日本語フォント名を並べるだけで日本語ラベルを描く実例がある
// （https://github.com/maplibre/maplibre-gl-js/blob/main/test/examples/style-labels-with-local-fonts.html
//   実際に「安曇野市」「松本市」という日本の地名で検証されている）。
// これが本当に効くか、本番のラベルデータ（地方9件・県47件・区域192件）と
// 震度ラベル（src/utils/intensity.ts の実表示文字列、"5弱"/"5強"等の漢字混じりを含む）で
// 実際に確認する。
//
// 本番（BaseMap.tsx）の排他表示条件を再現する:
//   zoom <  5.5              : ラベル非表示
//   5.5 <= zoom <  7.5        : 地方ラベル（9件）
//   7.5 <= zoom <  9          : 県名ラベル（47件）
//   zoom >= 9                 : 区域名ラベル（192件）
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Point } from 'geojson'

const JAPAN_CENTER: [number, number] = [137.7, 38.25]
const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'

// BaseMap.tsx の LABEL_MIN_ZOOM/REGION_MAX_ZOOM/CITY_LABEL_MIN_ZOOM をそのまま踏襲
const LABEL_MIN_ZOOM = 5.5
const REGION_MAX_ZOOM = 7.5
const CITY_LABEL_MIN_ZOOM = 9

// glyphs は意図的に設定しない（本 PoC の検証対象そのもの）。text-font に日本語フォントを
// 並べ、ローカル表意文字レンダリングだけで描けるかを見る。Windows(実機 Surface Go 2)を
// 主対象に、代表的な和文フォント名を優先度順で並べる。
const JP_TEXT_FONT = ['Yu Gothic UI', 'Meiryo', 'MS Gothic', 'Noto Sans CJK JP']

const REGIONS: { name: string; lat: number; lng: number }[] = [
  { name: '北海道', lat: 43.4, lng: 142.8 },
  { name: '東北', lat: 39.6, lng: 140.6 },
  { name: '関東', lat: 36.1, lng: 139.7 },
  { name: '中部', lat: 36.2, lng: 137.6 },
  { name: '近畿', lat: 34.5, lng: 135.8 },
  { name: '中国', lat: 34.9, lng: 132.6 },
  { name: '四国', lat: 33.6, lng: 133.5 },
  { name: '九州', lat: 32.3, lng: 130.9 },
  { name: '沖縄', lat: 26.5, lng: 128.0 },
]

type PrefShape = { label: [number, number]; dir: string; rings: [number, number][][] }
type SubRegion = { name: string; label: [number, number]; rings: [number, number][][] }

function pointFC(features: { name: string; lat: number; lng: number }[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature',
      properties: { name: f.name },
      geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
    })),
  }
}

async function loadPrefectures(): Promise<FeatureCollection<Point>> {
  const prefs: Record<string, PrefShape> = await fetch('/data/prefectures.json').then((r) => r.json())
  return pointFC(
    Object.entries(prefs).map(([name, shape]) => ({ name, lat: shape.label[0], lng: shape.label[1] })),
  )
}

async function loadSubregions(): Promise<FeatureCollection<Point>> {
  const subs: SubRegion[] = await fetch('/data/subregions.json').then((r) => r.json())
  return pointFC(subs.map((s) => ({ name: s.name, lat: s.label[0], lng: s.label[1] })))
}

// 震度ラベルの描画確認用。区域ラベルの一部座標を間引いて流用し、実際に画面へ表示される
// 震度ラベル文字列（src/utils/intensity.ts の INTENSITY_LABELS）をそのまま巡回して割り当てる。
// "5弱"/"5強"/"6弱"/"6強" のような漢字混じり2文字を含む点が重要（本番 JapanMap.tsx:95 の
// `label.length > 1 ? size*0.42 : size*0.6` という、2文字ラベルだけ縮小する分岐が実在し、
// 「小さいフォントサイズでの漢字グリフ描画」が本 PoC で確認すべき具体的な組み合わせのため。
// レビュー指摘: 当初 ASCII 記号 "5-"/"5+" 等で代替していたが、本番はこの表記を画面に一切
// 出さない（電文パース時の内部コードに過ぎない）ため、実表示文字列に差し替えた。
const INTENSITY_LABELS = ['1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7']
// 区域ラベルと同一座標に重ねると、どちらの文字が描画されたか判別しづらくなるため
// （レビュー指摘）、緯度方向にわずかにオフセットする。
const INTENSITY_LABEL_OFFSET_LAT = 0.08
function intensityFC(subregionPoints: FeatureCollection<Point>): FeatureCollection<Point> {
  const step = Math.max(1, Math.floor(subregionPoints.features.length / 40))
  const sampled = subregionPoints.features.filter((_, i) => i % step === 0)
  return {
    type: 'FeatureCollection',
    features: sampled.map((f, i) => ({
      type: 'Feature',
      properties: { label: INTENSITY_LABELS[i % INTENSITY_LABELS.length] },
      geometry: {
        type: 'Point',
        coordinates: [f.geometry.coordinates[0], f.geometry.coordinates[1] + INTENSITY_LABEL_OFFSET_LAT],
      },
    })),
  }
}

function updateStat(text: string): void {
  const el = document.getElementById('stat')
  if (el) el.textContent = text
}

const map = new maplibregl.Map({
  container: 'map',
  center: JAPAN_CENTER,
  zoom: 6,
  attributionControl: false,
  // glyphs キー自体を持たせない構成（Context7 で確認した公式サンプルと同じ）。
  style: {
    version: 8,
    sources: {
      gebco: { type: 'raster', tiles: [BATHYMETRY_URL], tileSize: 256, maxzoom: 10 },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } },
      { id: 'gebco', type: 'raster', source: 'gebco' },
    ],
  },
})

map.on('load', async () => {
  const [prefFC, subFC] = await Promise.all([loadPrefectures(), loadSubregions()])
  const regionFC = pointFC(REGIONS)
  const intensityFCData = intensityFC(subFC)

  map.addSource('regions', { type: 'geojson', data: regionFC })
  map.addSource('prefectures', { type: 'geojson', data: prefFC })
  map.addSource('subregions', { type: 'geojson', data: subFC })
  map.addSource('intensity', { type: 'geojson', data: intensityFCData })

  // 地方ラベル: LABEL_MIN_ZOOM <= zoom < REGION_MAX_ZOOM
  map.addLayer({
    id: 'regions-label',
    type: 'symbol',
    source: 'regions',
    minzoom: LABEL_MIN_ZOOM,
    maxzoom: REGION_MAX_ZOOM,
    layout: { 'text-field': ['get', 'name'], 'text-font': JP_TEXT_FONT, 'text-size': 18 },
    // 本番(index.css)は text-shadow を3枚重ねたソフトなグローで縁取る。MapLibre の
    // text-halo-width はハードエッジのため、幅を絞り halo-blur でぼかして近づける
    // （幅を太いままにするとハローだけが目立ち文字が読みにくくなる。ユーザー指摘で調整）。
    paint: {
      'text-color': '#e5e7eb',
      'text-halo-color': '#0a0c10',
      'text-halo-width': 0.8,
      'text-halo-blur': 0.5,
    },
  })

  // 県名ラベル: REGION_MAX_ZOOM <= zoom < CITY_LABEL_MIN_ZOOM
  map.addLayer({
    id: 'prefectures-label',
    type: 'symbol',
    source: 'prefectures',
    minzoom: REGION_MAX_ZOOM,
    maxzoom: CITY_LABEL_MIN_ZOOM,
    layout: { 'text-field': ['get', 'name'], 'text-font': JP_TEXT_FONT, 'text-size': 14 },
    paint: {
      'text-color': '#e5e7eb',
      'text-halo-color': '#0a0c10',
      'text-halo-width': 0.7,
      'text-halo-blur': 0.5,
    },
  })

  // 区域名ラベル: zoom >= CITY_LABEL_MIN_ZOOM
  map.addLayer({
    id: 'subregions-label',
    type: 'symbol',
    source: 'subregions',
    minzoom: CITY_LABEL_MIN_ZOOM,
    layout: { 'text-field': ['get', 'name'], 'text-font': JP_TEXT_FONT, 'text-size': 12 },
    paint: {
      'text-color': '#e5e7eb',
      'text-halo-color': '#0a0c10',
      'text-halo-width': 0.6,
      'text-halo-blur': 0.4,
    },
  })

  // 震度ラベル: 常時表示で文字描画そのものの確認用（本番はズーム非依存で地震発生時のみ
  // 表示されるが、PoC では表示条件を分離して確認しやすくする）。
  // 本番(JapanMap.tsx:95) は `label.length > 1 ? size*0.42 : size*0.6` と2文字ラベル
  // （"5弱"等）だけ縮小するため、同じ分岐を text-size の data-driven expression で再現する。
  map.addLayer({
    id: 'intensity-label',
    type: 'symbol',
    source: 'intensity',
    layout: {
      'text-field': ['get', 'label'],
      'text-font': JP_TEXT_FONT,
      'text-size': ['case', ['>', ['length', ['get', 'label']], 1], 9, 13],
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': '#fbbf24',
      'text-halo-color': '#000000',
      'text-halo-width': 0.6,
      'text-halo-blur': 0.3,
    },
  })

  Object.assign(window as unknown as Record<string, unknown>, { __pocReady: true })
  updateStat(`zoom: ${map.getZoom().toFixed(2)}\n地方${regionFC.features.length}/県${prefFC.features.length}/区域${subFC.features.length}件\n震度ラベル${intensityFCData.features.length}件（常時表示）`)
})

map.on('zoomend', () => {
  updateStat(
    document.getElementById('stat')!.textContent!.replace(/zoom: [\d.]+/, `zoom: ${map.getZoom().toFixed(2)}`),
  )
})

map.on('error', (e) => {
  updateStat('ERROR: ' + (e.error?.message ?? String(e)))
  console.error('[label] map error', e.error)
})

const zoomButtons: Record<string, number> = { z5: 5, z6: 6, z8: 8, z11: 11 }
for (const [id, z] of Object.entries(zoomButtons)) {
  document.getElementById(id)?.addEventListener('click', () => map.setZoom(z))
}

// Playwright からの確認用: レイヤーの可視状態・キャンバスのピクセル抽出は
// map.queryRenderedFeatures や map.getCanvas() を直接使えるため、追加の露出は最小限にする。
Object.assign(window as unknown as Record<string, unknown>, { __labelMap: map })
