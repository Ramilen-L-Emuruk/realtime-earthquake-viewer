// 都道府県の境界ポリゴンから、地図表示用の軽量な
// 都道府県名 -> 境界座標（＋ラベル位置）テーブルを生成する。
//
// 出力: public/data/prefectures.json
//   { "都道府県名": { "label": [lat, lon], "room": [北, 南], "rings": [ [ [lat, lon], ... ], ... ] } }
//     rings = 外周・離島などのリングの配列（各リングは閉じた境界線）
//     label = 県名ラベルを置く代表点（最大リングの重心）
//     room  = 代表点から北・南へラベルを退避させられる余地（緯度差の度数・shiftRoom 参照）
//
// 【重要】県境は一次細分区域（build-subregions.mjs）を県ごとに融合(dissolve)して作る。
//   理由: 県境は必ず一次細分区域の境界でもある（区域は県を細分したもの）。県境ポリゴンと区域ポリゴンを
//   別々の GIS データから独立に生成すると、共有すべき境界が極拡大で数十m ずれて二重線に見える。区域を
//   dissolve して県を作れば、県境が区域境界と同一頂点を共有しズレが原理的に消える。
//   割当（区域→県）は、府県予報区ポリゴンとの最大重複(mapshaper largest-overlap)で機械的に行う
//   （コード対応表不要）。府県予報区ポリゴンに重ならない孤立離島（甑島南方 等）は最近傍県へフォールバック。
//
// データ出典: 気象庁 予報区等 GIS データを GeoJSON 化したもの（Ichihai1415/JMA-GIS-GeoJSON・release）。
//   一次細分区域 AreaForecastLocalE（融合元・幾何の実体）／府県予報区 AreaInformationPrefectureEarthquake
//   （区域→県の割当と、県名の突き合わせに使用）。どちらも簡素化の緩い高精細版 `_1`。
//
// 更新方法: node scripts/build-prefectures.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import mapshaperPkg from 'mapshaper'
import { shiftRoom } from './lib/labelRoom.mjs'

const mapshaper = mapshaperPkg.default ?? mapshaperPkg

// 融合の幾何の実体は一次細分区域（build-subregions.mjs と同一ソース）。県境が区域境界と一致するのは
// 同じ頂点を共有するため。府県予報区は区域→県の割当（最大重複）にのみ使う。
const SUBREGION_URL =
  'https://raw.githubusercontent.com/Ichihai1415/JMA-GIS-GeoJSON/release/AreaForecastLocalE_GIS_20240520_1.geojson'
const PREFECTURE_URL =
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

/** GeoJSON feature の代表点（先頭リング頂点の平均・[lon, lat]）。最近傍県の判定に使う。 */
function repPoint(feature) {
  const gg = feature.geometry
  const ring =
    gg?.type === 'Polygon' ? gg.coordinates[0] : gg?.type === 'MultiPolygon' ? gg.coordinates[0][0] : null
  if (!ring || ring.length === 0) return null
  let sx = 0,
    sy = 0
  for (const [x, y] of ring) {
    sx += x
    sy += y
  }
  return [sx / ring.length, sy / ring.length]
}

/** 府県予報区の全頂点（[lon, lat]）を name ごとに集めた索引。孤立離島の最近傍県フォールバックに使う。 */
function buildPrefVertexIndex(prefGeojson) {
  const index = []
  for (const f of prefGeojson.features) {
    const name = f.properties?.name
    if (!name) continue
    const verts = []
    const gg = f.geometry
    const polys = gg?.type === 'Polygon' ? [gg.coordinates] : gg?.type === 'MultiPolygon' ? gg.coordinates : []
    for (const poly of polys) for (const ring of poly) for (const pt of ring) verts.push(pt)
    if (verts.length) index.push({ name, verts })
  }
  return index
}

/** 代表点 rep（[lon, lat]）に最も近い府県予報区の name を返す（頂点への最小距離で判定）。 */
function nearestPrefName(rep, prefIndex) {
  let best = null
  let bestD = Infinity
  for (const { name, verts } of prefIndex) {
    for (const [x, y] of verts) {
      const d = (x - rep[0]) ** 2 + (y - rep[1]) ** 2
      if (d < bestD) {
        bestD = d
        best = name
      }
    }
  }
  return best
}

async function main() {
  console.log(`Fetching ${SUBREGION_URL} ...`)
  const subRes = await fetch(SUBREGION_URL)
  if (!subRes.ok) throw new Error(`Failed to fetch subregions: ${subRes.status}`)
  const subGeojson = await subRes.text()
  console.log(`Fetching ${PREFECTURE_URL} ...`)
  const prefRes = await fetch(PREFECTURE_URL)
  if (!prefRes.ok) throw new Error(`Failed to fetch prefectures: ${prefRes.status}`)
  const prefText = await prefRes.text()
  const prefGeojson = JSON.parse(prefText)

  // 1) 各一次細分区域に、最も重なる府県予報区の name を prefname として付与する（mapshaper largest-overlap）。
  const joined = await mapshaper.applyCommands(
    [
      '-i pref.geojson name=pref',
      '-rename-fields target=pref prefname=name',
      '-i sub.geojson name=sub',
      '-join pref target=sub largest-overlap fields=prefname',
      '-o out.geojson target=sub',
    ].join(' '),
    { 'pref.geojson': prefText, 'sub.geojson': subGeojson },
  )
  const subFC = JSON.parse(joined['out.geojson'])

  // 2) 府県予報区ポリゴンに重ならず prefname が付かなかった孤立離島は、最近傍県へフォールバック割当する。
  // 府県予報区ポリゴンに重ならず prefname が付かなかった区域を最近傍県へフォールバックする。
  // なお geometry を持たない区域（地震情報用の名前だけの岩礁・例: 鷹島(甑島南方)）は rep=null で対象外
  // （幾何が無く描画もされない。build-subregions.mjs でも同様に除外される）。
  const prefIndex = buildPrefVertexIndex(prefGeojson)
  let fallback = 0
  for (const f of subFC.features) {
    if (!f.properties.prefname) {
      const rep = repPoint(f)
      const name = rep ? nearestPrefName(rep, prefIndex) : null
      if (name) {
        f.properties.prefname = name
        fallback++
        console.log(`  fallback: ${f.properties.name} -> ${name}`)
      }
    }
  }

  // 3) prefname ごとに融合(dissolve)して県ポリゴンを作る。県境は区域境界と同一頂点を共有する。
  const dissolved = await mapshaper.applyCommands(
    '-i tagged.geojson -dissolve2 prefname -o out.geojson',
    { 'tagged.geojson': JSON.stringify(subFC) },
  )
  const prefFC = JSON.parse(dissolved['out.geojson'])

  // 4) 融合ポリゴンを軽量テーブルへ変換（区域と同一の丸め・正規化で頂点を一致させる）。
  const prefs = {}
  for (const feature of prefFC.features) {
    const name = feature.properties?.prefname
    if (!name) continue
    const rings = normalizeRings(feature.geometry)
    if (rings.length === 0) continue
    const mainRing = largestRing(rings)
    const label = centroid(mainRing)
    prefs[name] = { label, room: shiftRoom(rings, label), rings }
  }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(prefs))
  const points = Object.values(prefs).reduce(
    (n, p) => n + p.rings.reduce((m, r) => m + r.length, 0),
    0,
  )
  console.log(
    `Wrote ${OUT_FILE} (prefectures: ${Object.keys(prefs).length}, points: ${points}, fallback: ${fallback})`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
