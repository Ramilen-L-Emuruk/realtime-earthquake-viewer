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

/** 連続する重複点を除去する。 */
function dedupe(line) {
  const out = []
  for (const pt of line) {
    const prev = out[out.length - 1]
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) out.push(pt)
  }
  return out
}

/** 点 [y,x] と線分 [ay,ax]-[by,bx] の垂線距離。 */
function perpDist([y, x], [ay, ax], [by, bx]) {
  const dy = by - ay
  const dx = bx - ax
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(y - ay, x - ax)
  const t = ((x - ax) * dx + (y - ay) * dy) / len2
  const cy = ay + t * dy
  const cx = ax + t * dx
  return Math.hypot(y - cy, x - cx)
}

// Douglas-Peucker で海岸線ラインを間引く。区域塗り(subregions)と同じ許容誤差に揃える
// （拡大時の崩れを抑えつつ、地図縮尺では見た目を保ったまま頂点数を減らす）。
const EPSILON = 0.002 // 度（約220m相当）
function simplify(points) {
  if (points.length < 3) return points
  let maxD = 0
  let idx = 0
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1])
    if (d > maxD) { maxD = d; idx = i }
  }
  if (maxD > EPSILON) {
    return simplify(points.slice(0, idx + 1)).slice(0, -1).concat(simplify(points.slice(idx)))
  }
  return [points[0], points[points.length - 1]]
}

/** LineString / MultiLineString を「ラインの配列」に正規化し、各ラインを間引く。 */
function normalizeSegments(geometry) {
  if (!geometry) return []
  let lines = []
  if (geometry.type === 'LineString') {
    lines = [geometry.coordinates.map(toLatLng)]
  } else if (geometry.type === 'MultiLineString') {
    lines = geometry.coordinates.map(line => line.map(toLatLng))
  } else {
    return []
  }
  return lines
    .map(line => simplify(dedupe(line)))
    .filter(line => line.length >= 2)
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

  const vertices = Object.values(zones).reduce(
    (n, segs) => n + segs.reduce((m, line) => m + line.length, 0),
    0,
  )
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(zones))
  console.log(`Wrote ${OUT_FILE} (zones: ${Object.keys(zones).length}, vertices: ${vertices})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
