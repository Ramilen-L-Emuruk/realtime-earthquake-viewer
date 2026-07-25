// 【PoC専用・使い捨て】活断層データを「間引きなし（フル解像度）」で生成する。
// 本体の scripts/build-active-faults.mjs は Douglas-Peucker（EPSILON=0.002 度 ≒ 220m）で
// 頂点を間引くが、層B（フル解像度の線の描画負荷）の律速切り分け PoC では間引き前の
// 頂点数で描いて負荷を測りたいため、EPSILON=0 に落として全頂点を保持したデータを作る。
//
// 出力: public/data/active-faults-full.json（本体の active-faults.json とは別ファイル）
// 実行: node scripts/perf/build-active-faults-full.mjs
//
// データ出典: 産業技術総合研究所（産総研）活断層データベース
//   https://gbank.gsj.jp/activefault/ （政府標準利用規約2.0・CC BY 4.0 国際互換）
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'

const SOURCE_URL =
  'https://unit.aist.go.jp/ievg/actfault-rg/kmz/newest/MG_trace_gbank_j_g.kmz'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'active-faults-full.json')

/** "lon,lat,alt" 形式のトークンを [lat, lon] に変換し、約10m精度に丸める。 */
function toLatLng(token) {
  const [lon, lat] = token.split(',').map(Number)
  return [Math.round(lat * 10000) / 10000, Math.round(lon * 10000) / 10000]
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

/** 1つの Placemark ブロックから、表題（description内 <B>）と全ラインの座標を抽出する（間引きなし）。 */
function parsePlacemark(block) {
  const titleMatch = block.match(/<B>([^<]+)<\/b>/i)
  const nameMatch = block.match(/<name>([^<]*)<\/name>/)
  const name = titleMatch?.[1]?.trim() || nameMatch?.[1]?.trim()
  if (!name) return null

  const coordBlocks = block.match(/<coordinates>[\s\S]*?<\/coordinates>/g) || []
  const lines = coordBlocks
    .map((cb) => {
      const inner = cb.replace(/<\/?coordinates>/g, '').trim()
      return inner.split(/\s+/).filter(Boolean).map(toLatLng)
    })
    // 本体スクリプトと違い simplify(Douglas-Peucker) を通さず、dedupe のみでフル解像度を保つ
    .map((line) => dedupe(line))
    .filter((line) => line.length >= 2)

  if (lines.length === 0) return null
  return { name, lines }
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`Failed to fetch source: ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())

  const files = unzipSync(buf)
  const docName = Object.keys(files).find((n) => n.toLowerCase().endsWith('.kml'))
  if (!docName) throw new Error('KMZ内にKMLファイルが見つかりません')
  const kml = new TextDecoder('utf-8').decode(files[docName])

  const placemarkBlocks = kml.match(/<Placemark>[\s\S]*?<\/Placemark>/g) || []
  console.log(`Found ${placemarkBlocks.length} placemarks`)

  const segments = placemarkBlocks.map(parsePlacemark).filter((s) => s !== null)

  const lineCount = segments.reduce((n, seg) => n + seg.lines.length, 0)
  const vertices = segments.reduce(
    (n, seg) => n + seg.lines.reduce((m, line) => m + line.length, 0),
    0,
  )
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(segments))
  console.log(
    `Wrote ${OUT_FILE} (segments: ${segments.length}, lines: ${lineCount}, vertices: ${vertices})`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
