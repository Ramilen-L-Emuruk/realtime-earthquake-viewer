// 都道府県の境界ポリゴンから、地図表示用の軽量な
// 都道府県名 -> 境界座標（＋ラベル位置）テーブルを生成する。
//
// 出力: public/data/prefectures.json
//   { "都道府県名": { "label": [lat, lon], "rings": [ [ [lat, lon], ... ], ... ] } }
//     rings = 外周・離島などのリングの配列（各リングは閉じた境界線）
//     label = 県名ラベルを置く代表点（最大リングの重心）
//
// データ出典: 気象庁 予報区等 GIS データ（都道府県等）を GeoJSON 化したもの
//   https://github.com/Ichihai1415/JMA-GIS-GeoJSON （release ブランチ）
//   一次細分区域（build-subregions.mjs）と同一ソースのため海岸線・県境が整合する。
//
// 更新方法: node scripts/build-prefectures.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 末尾 `_1` は簡素化の緩い高精細版。簡素化のきつい `_01` 版から切替えた（陸塗り＝海岸線シルエットは県
// ポリゴンが作るため、区域と揃えて高精細化しないと海岸線がズレて見える）。区域定義・properties は不変。
const SOURCE_URL =
  'https://raw.githubusercontent.com/Ichihai1415/JMA-GIS-GeoJSON/release/AreaInformationPrefectureEarthquake_GIS_20190125_1.geojson'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'prefectures.json')

/** [lon, lat] -> [lat, lon]、約10m精度に丸める（拡大時の品質確保）。 */
function toLatLng([lon, lat]) {
  return [Math.round(lat * 10000) / 10000, Math.round(lon * 10000) / 10000]
}

/** 丸めで連続重複した点を除去してリングを軽量化する。 */
function dedupe(ring) {
  const out = []
  for (const pt of ring) {
    const prev = out[out.length - 1]
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) out.push(pt)
  }
  return out
}

// 点と線分 a-b の垂直距離（度単位の平面近似）。
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

// Douglas-Peucker の許容誤差。0 = 間引き撤廃（ほぼ厳密に collinear な点のみ除去＝全頂点保持）。
// WebGL(MapLibre)移行でフル解像度描画が実質無償になったため撤廃する（座標は toLatLng の小数4桁丸め
// ≈11mが下限精度。ダウンロード量は増えるが描画性能は不変）。
const EPSILON = 0 // 度（0=撤廃・全頂点保持。以前は 0.002≈220m で間引いていた）
function simplify(points) {
  if (points.length < 3) return points
  let maxD = 0
  let idx = 0
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1])
    if (d > maxD) { maxD = d; idx = i }
  }
  if (maxD > EPSILON) {
    const left = simplify(points.slice(0, idx + 1))
    const right = simplify(points.slice(idx))
    return left.slice(0, -1).concat(right)
  }
  return [points[0], points[points.length - 1]]
}

/** Polygon / MultiPolygon を「リング（[lat,lon] の配列）の配列」に正規化・間引きする。 */
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

/** 最大リング（点数最多）を返す。 */
function largestRing(rings) {
  let largest = rings[0]
  for (const r of rings) if (r.length > largest.length) largest = r
  return largest
}

/** リング頂点平均を県名ラベルの代表点とする。 */
function centroid(ring) {
  const sum = ring.reduce((a, [lat, lon]) => [a[0] + lat, a[1] + lon], [0, 0])
  return [
    Math.round((sum[0] / ring.length) * 1000) / 1000,
    Math.round((sum[1] / ring.length) * 1000) / 1000,
  ]
}

/**
 * ラベルのオフセット方向。代表点から見て県内に余白が大きい側（北/南）へ寄せる。
 * （上一律にすると県外へはみ出すため、リングの上下の余白を比較して決める。）
 */
function labelDir(ring, label) {
  let maxLat = -Infinity
  let minLat = Infinity
  for (const [lat] of ring) {
    if (lat > maxLat) maxLat = lat
    if (lat < minLat) minLat = lat
  }
  const northRoom = maxLat - label[0]
  const southRoom = label[0] - minLat
  return northRoom >= southRoom ? 'up' : 'down'
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`Failed to fetch source: ${res.status}`)
  const geojson = await res.json()
  console.log(`Loaded ${geojson.features.length} features`)

  const prefs = {}
  for (const feature of geojson.features) {
    const name = feature.properties?.name
    if (!name) continue
    const rings = normalizeRings(feature.geometry)
    if (rings.length === 0) continue
    const main = largestRing(rings)
    const label = centroid(main)
    prefs[name] = { label, dir: labelDir(main, label), rings }
  }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(prefs))
  const points = Object.values(prefs).reduce(
    (n, p) => n + p.rings.reduce((m, r) => m + r.length, 0),
    0,
  )
  console.log(`Wrote ${OUT_FILE} (prefectures: ${Object.keys(prefs).length}, points: ${points})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
