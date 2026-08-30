// 気象庁 震度観測点の座標データから、地図表示用の軽量な座標テーブルを生成する。
//
// 出力: public/data/station-coords.json
//   - stations:    "都道府県|観測点名"   -> [lat, lon, regionIdx?]（P2P地震情報の isArea:false 地点用）
//                  regionIdx は regionNames の添字＝その観測点が属する一次細分区域。
//   - areas:       "都道府県|細分区域名" -> [lat, lon]（P2P地震情報の isArea:true 地点用・観測点重心）
//   - regionNames: 一次細分区域名の一覧（stations の 3 要素目が指す先）
//
// データ出典: 気象庁 震度観測点一覧表（iku55 氏が JSON 化したものを利用）
//   https://gist.github.com/iku55/79005d1896631ad6117bbe327b8162c1
//
// 更新方法: node scripts/build-station-coords.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SOURCE_URL =
  'https://gist.githubusercontent.com/iku55/79005d1896631ad6117bbe327b8162c1/raw/6458684e522767a9ffc42f9bba9d6b2b06253f44/stations.json'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'station-coords.json')

/** 座標を約100m精度に丸めてファイルサイズを抑える。 */
function round(value) {
  return Math.round(Number(value) * 1000) / 1000
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`Failed to fetch source: ${res.status}`)
  const stations = await res.json()
  console.log(`Loaded ${stations.length} stations`)

  const stationCoords = {}
  const areaAccumulator = new Map() // key -> { latSum, lonSum, count }
  const regionNames = []
  const regionIndex = new Map() // 区域名 -> regionNames の添字

  /** 区域名を regionNames に登録し（初出のみ）、その添字を返す。 */
  const regionIndexOf = (name) => {
    const known = regionIndex.get(name)
    if (known != null) return known
    const idx = regionNames.length
    regionNames.push(name)
    regionIndex.set(name, idx)
    return idx
  }

  for (const s of stations) {
    const prefName = s.pref?.name
    const lat = round(s.lat)
    const lon = round(s.lon)
    if (!prefName || !Number.isFinite(lat) || !Number.isFinite(lon)) continue

    const areaName = s.area?.name

    // 観測点単位。3 要素目に所属一次細分区域の添字を持たせる。
    // 元データの座標は 0.01 度（約 1km）粒度しかないため、細い島や海岸沿いの観測点は
    // 区域ポリゴンとの点内包判定が海側に落ちて区域集約から漏れる。区域の帰属は座標から
    // 推測せず、元データが持つ区域名をそのまま引き継ぐ。
    if (s.name) {
      stationCoords[`${prefName}|${s.name}`] = areaName
        ? [lat, lon, regionIndexOf(areaName)]
        : [lat, lon]
    }

    // 細分区域単位（重心を後で算出）
    if (areaName) {
      const key = `${prefName}|${areaName}`
      const acc = areaAccumulator.get(key) ?? { latSum: 0, lonSum: 0, count: 0 }
      acc.latSum += lat
      acc.lonSum += lon
      acc.count += 1
      areaAccumulator.set(key, acc)
    }
  }

  const areaCoords = {}
  for (const [key, { latSum, lonSum, count }] of areaAccumulator) {
    areaCoords[key] = [round(latSum / count), round(lonSum / count)]
  }

  const output = { stations: stationCoords, areas: areaCoords, regionNames }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(output))
  console.log(
    `Wrote ${OUT_FILE} (stations: ${Object.keys(stationCoords).length}, ` +
      `areas: ${Object.keys(areaCoords).length}, regions: ${regionNames.length})`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
