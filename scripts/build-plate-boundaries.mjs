// PB2002（Bird, 2003）プレート境界モデルの GeoJSON から、
// 日本周辺のプレート境界線のみを抽出し、地図表示用の軽量なテーブルを生成する。
//
// 出力: public/data/plate-boundaries.json
//   [ { "plateA": "太平洋プレート", "plateB": "オホーツクプレート", "type": "subduction",
//       "lines": [ [ [lat,lon], ... ] ] }, ... ]
//
// データ出典: PB2002 (Bird, P., 2003, "An updated digital model of plate boundaries",
//   Geochemistry Geophysics Geosystems 4(3))
//   配布元GeoJSON: https://github.com/fraxen/tectonicplates （Open Data Commons Attribution License）
//
// 更新方法: node scripts/build-plate-boundaries.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SOURCE_URL =
  'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json'

// 日本周辺のプレート境界を漏れなく拾うための範囲（千島・日本海溝〜南海トラフ〜琉球海溝）
const BBOX = { lonMin: 118, lonMax: 162, latMin: 17, latMax: 52 }

// PB2002 のプレート略号 → 日本語表記
const PLATE_NAMES = {
  PA: '太平洋プレート',
  OK: 'オホーツクプレート',
  PS: 'フィリピン海プレート',
  ON: '沖縄プレート',
  AM: 'アムールプレート',
  EU: 'ユーラシアプレート',
  YA: '揚子江プレート',
  SU: 'スンダプレート',
  MA: 'マリアナプレート',
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'plate-boundaries.json')

function plateName(code) {
  return PLATE_NAMES[code] ?? code
}

/** GeoJSON の [lon,lat] を [lat,lon] に変換し、約100m精度に丸める。 */
function toLatLng([lon, lat]) {
  return [Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000]
}

function touchesBbox(coords) {
  return coords.some(
    ([lon, lat]) =>
      lon >= BBOX.lonMin && lon <= BBOX.lonMax && lat >= BBOX.latMin && lat <= BBOX.latMax,
  )
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`Failed to fetch source: ${res.status}`)
  const geojson = await res.json()

  const segments = geojson.features
    .filter((f) => touchesBbox(f.geometry.coordinates))
    .map((f) => ({
      plateA: plateName(f.properties.PlateA),
      plateB: plateName(f.properties.PlateB),
      type: f.properties.Type === 'subduction' ? 'subduction' : 'other',
      lines: [f.geometry.coordinates.map(toLatLng)],
    }))

  console.log(`Extracted ${segments.length} boundary segments (of ${geojson.features.length} total)`)

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(segments))
  console.log(`Wrote ${OUT_FILE}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
