// 気象庁の津波予報区 GIS データ（海岸線ライン）から、地図表示用の軽量な
// 区域名 -> 海岸線座標 テーブルを生成する。
//
// 出力: public/data/tsunami-zones.json
//   { "区域名": [ [ [lat, lon], ... ], ... ] }   // 区域ごとに複数のラインを持つ
//
// データ出典: 気象庁 予報区等 GIS データ（津波予報区）を GeoJSON 化したもの
//   https://github.com/Ichihai1415/JMA-GIS-GeoJSON （release ブランチ）
//
// 更新方法: node scripts/build-tsunami-zones.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SOURCE_URL =
  'https://raw.githubusercontent.com/Ichihai1415/JMA-GIS-GeoJSON/release/AreaTsunami_GIS_20240520_1.geojson'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'tsunami-zones.json')

/** 座標を約100m精度に丸める。GeoJSON は [lon, lat] 順なので [lat, lon] に変換する。 */
function toLatLng([lon, lat]) {
  return [Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000]
}

/** LineString / MultiLineString を「ラインの配列」に正規化する。 */
function normalizeSegments(geometry) {
  if (!geometry) return []
  if (geometry.type === 'LineString') {
    return [geometry.coordinates.map(toLatLng)]
  }
  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.map(line => line.map(toLatLng))
  }
  return []
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`Failed to fetch source: ${res.status}`)
  const geojson = await res.json()
  console.log(`Loaded ${geojson.features.length} features`)

  const zones = {}
  for (const feature of geojson.features) {
    const name = feature.properties?.name
    if (!name) continue
    const segments = normalizeSegments(feature.geometry)
    if (segments.length === 0) continue
    zones[name] = segments
  }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(zones))
  console.log(`Wrote ${OUT_FILE} (zones: ${Object.keys(zones).length})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
