// 一次細分区域（地震情報・緊急地震速報で使う「地域」区分）の境界ポリゴンから、
// 地図表示用の軽量な境界＋ラベル位置テーブルを生成する。
//
// 出力: public/data/subregions.json
//   [ { "name": "神奈川県東部", "label": [lat, lon], "rings": [ [ [lat,lon], ... ], ... ] }, ... ]
//
// データ出典: 気象庁 予報区等 GIS データ（地震情報／細分区域）を GeoJSON 化したもの
//   https://github.com/Ichihai1415/JMA-GIS-GeoJSON （release ブランチ・AreaForecastLocalE）
//
// 更新方法: node scripts/build-subregions.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SOURCE_URL =
  'https://raw.githubusercontent.com/Ichihai1415/JMA-GIS-GeoJSON/release/AreaForecastLocalE_GIS_20240520_01.geojson'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'subregions.json')

/** [lon, lat] -> [lat, lon]、約10m精度に丸める（拡大時の品質確保）。 */
function toLatLng([lon, lat]) {
  return [Math.round(lat * 10000) / 10000, Math.round(lon * 10000) / 10000]
}

function dedupe(ring) {
  const out = []
  for (const pt of ring) {
    const prev = out[out.length - 1]
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) out.push(pt)
  }
  return out
}

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

// Douglas-Peucker（拡大時の崩れを抑えるため詳細を残す）。
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

function normalizeRings(geometry) {
  if (!geometry) return []
  const raw = []
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates) raw.push(ring.map(toLatLng))
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates)
      for (const ring of poly) raw.push(ring.map(toLatLng))
  }
  return raw
    .map((r) => simplify(dedupe(r)))
    .filter((r) => r.length >= 3)
}

/** 最大リング（点数最多）の頂点平均をラベル代表点とする。 */
function labelPoint(rings) {
  let largest = rings[0]
  for (const r of rings) if (r.length > largest.length) largest = r
  const sum = largest.reduce((a, [lat, lon]) => [a[0] + lat, a[1] + lon], [0, 0])
  return [
    Math.round((sum[0] / largest.length) * 1000) / 1000,
    Math.round((sum[1] / largest.length) * 1000) / 1000,
  ]
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`Failed to fetch source: ${res.status}`)
  const geojson = await res.json()
  console.log(`Loaded ${geojson.features.length} features`)

  const regions = []
  for (const feature of geojson.features) {
    const name = feature.properties?.name
    if (!name) continue
    const rings = normalizeRings(feature.geometry)
    if (rings.length === 0) continue
    regions.push({ name, label: labelPoint(rings), rings })
  }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(regions))
  const points = regions.reduce((n, r) => n + r.rings.reduce((m, x) => m + x.length, 0), 0)
  console.log(`Wrote ${OUT_FILE} (regions: ${regions.length}, points: ${points})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
