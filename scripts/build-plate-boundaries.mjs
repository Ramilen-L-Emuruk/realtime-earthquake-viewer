// PB2002（Bird, 2003）プレート境界モデルの GeoJSON から、
// 全球のプレート境界線を地図表示用の軽量なテーブルへ変換する。
//
// 出力: public/data/plate-boundaries.json
//   [ { "plateA": "太平洋プレート", "plateB": "オホーツクプレート", "type": "subduction",
//       "lines": [ [ [lat,lon], ... ] ] }, ... ]
//
// 遠地地震（震源が国外）を選ぶと地図は世界規模まで引くため、日本周辺だけを切り出すと
// 線が宙に浮いて見える。全球を保持しても座標は約 6,300 点（生成物で約 130KB）に収まり、
// このデータは地図初回表示時の遅延読込なので初期表示には影響しない。
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

// PB2002 のプレート略号 → 日本語表記（全 52 プレート）。
// 英語の正式名称は配布元 PB2002_plates.json の PlateName に一致させている。
const PLATE_NAMES = {
  AF: 'アフリカプレート',
  AM: 'アムールプレート',
  AN: '南極プレート',
  AP: 'アルティプラノプレート',
  AR: 'アラビアプレート',
  AS: 'エーゲ海プレート',
  AT: 'アナトリアプレート',
  AU: 'オーストラリアプレート',
  BH: 'バーズヘッドプレート',
  BR: 'バルモラルリーフプレート',
  BS: 'バンダ海プレート',
  BU: 'ビルマプレート',
  CA: 'カリブプレート',
  CL: 'カロリンプレート',
  CO: 'ココスプレート',
  CR: 'コンウェイリーフプレート',
  EA: 'イースタープレート',
  EU: 'ユーラシアプレート',
  FT: 'フツナプレート',
  GP: 'ガラパゴスプレート',
  IN: 'インドプレート',
  JF: 'フアン・デ・フカプレート',
  JZ: 'フアン・フェルナンデスプレート',
  KE: 'ケルマデックプレート',
  MA: 'マリアナプレート',
  MN: 'マヌスプレート',
  MO: 'マオケプレート',
  MS: 'モルッカ海プレート',
  NA: '北アメリカプレート',
  NB: '北ビスマルクプレート',
  ND: '北アンデスプレート',
  NH: 'ニューヘブリデスプレート',
  NI: 'ニウアフォオウプレート',
  NZ: 'ナスカプレート',
  OK: 'オホーツクプレート',
  ON: '沖縄プレート',
  PA: '太平洋プレート',
  PM: 'パナマプレート',
  PS: 'フィリピン海プレート',
  RI: 'リベラプレート',
  SA: '南アメリカプレート',
  SB: '南ビスマルクプレート',
  SC: 'スコシアプレート',
  SL: 'シェトランドプレート',
  SO: 'ソマリアプレート',
  SS: 'ソロモン海プレート',
  SU: 'スンダプレート',
  SW: 'サンドイッチプレート',
  TI: 'ティモールプレート',
  TO: 'トンガプレート',
  WL: 'ウッドラークプレート',
  YA: '揚子江プレート',
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

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`Failed to fetch source: ${res.status}`)
  const geojson = await res.json()

  // 配布元データは日付変更線で既に分割済み（経度は -180〜180 に収まり、隣接点の経度差が
  // 180 を超える箇所は無い）。そのため地球を一周する横線は生じず、追加の分割処理は不要。
  const segments = geojson.features.map((f) => ({
    plateA: plateName(f.properties.PlateA),
    plateB: plateName(f.properties.PlateB),
    type: f.properties.Type === 'subduction' ? 'subduction' : 'other',
    lines: [f.geometry.coordinates.map(toLatLng)],
  }))

  const unknown = [...new Set(
    geojson.features.flatMap((f) => [f.properties.PlateA, f.properties.PlateB]),
  )].filter((code) => !PLATE_NAMES[code])
  if (unknown.length > 0) {
    // 配布元にプレートが追加された場合の気付き用（略号のまま表示されるため実害は無い）。
    console.warn(`Unmapped plate codes (shown as-is): ${unknown.join(', ')}`)
  }

  console.log(`Extracted ${segments.length} boundary segments`)

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(segments))
  console.log(`Wrote ${OUT_FILE}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
