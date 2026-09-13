// 気象庁 震度観測点の座標データから、地図表示用の軽量な座標テーブルを生成する。
//
// 出力: public/data/station-coords.json
//   - stations:    "都道府県|観測点名"   -> [lat, lon, regionIdx?]（P2P地震情報の isArea:false 地点用）
//                  regionIdx は regionNames の添字＝その観測点が属する一次細分区域。
//   - unlisted:    現行の一覧に無い観測点の同じ表（下記「現行の一覧に無い観測点」）
//   - areas:       "都道府県|細分区域名" -> [lat, lon]（P2P地震情報の isArea:true 地点用・観測点重心）
//   - regionNames: 一次細分区域名の一覧（stations / unlisted の 3 要素目が指す先）
//
// データ出典: 気象庁 震度観測点一覧表（iku55 氏が JSON 化したものを利用）
//   https://gist.github.com/iku55/79005d1896631ad6117bbe327b8162c1
//
// **取得元（固定リビジョン）と「現行の一覧に無い観測点」の収集は `lib/stationSource.mjs`。**
// 読み仮名を作る側（`build-station-readings.ts`）と共有している —— 同じ一覧を別々に持つと、
// 片方だけが古い版を見ている状態に誰も気づけない。
//
// 更新方法: node scripts/build-station-coords.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { collectUnlistedStations, fetchListedStations, LISTED_COUNT_RANGE } from './lib/stationSource.mjs'

/**
 * 現行の一覧に無い観測点として受け入れる件数の幅。2026-09 時点で 134 点。
 *
 * **この値だけを歯止めにしない。** 件数は「履歴を辿れたか」の代理値で、一部のリビジョンが
 * まるごと読めなくても残りで幅に収まってしまう。辿れた版の数そのものは
 * `lib/stationSource.mjs` の `MIN_READABLE_REVISIONS` が見る。
 */
const UNLISTED_RANGE = { min: 80, max: 600 }

/**
 * 履歴から必ず拾えなければならない観測点。**どちらも実電文に出てくる。**
 *
 * - 延岡市北方町卯 … 2022-01-22 日向灘（最大震度5強）で「震度５弱以上未入電」として届いた 60 地点の 1 つ
 * - 豊中市役所 … 2018-06-18 大阪府北部で震度5強を観測
 *
 * **かつては 3 つ目に「固定リビジョンより後に一覧へ加わった観測点」（箕面市今宮）を置いていた。**
 * `unlisted` の中身が「廃止された点」と「後から加わった点」の 2 種であることの裏付けで、
 * 具体的には `collectUnlistedStations` が**遡る向きを片側に絞る**変更（「固定リビジョン以降は
 * 現行なので見なくてよい」と考えるような）が入ったときに落ちる役目だった。
 *
 * 固定リビジョンを最新に保つ方針にしたため、この種の点は当面存在しない（上流が更新されれば
 * また生じる）。**代わりの点は置いていない** —— 削除された観測点は収録済みの地震に 1 件も
 * 出てこず、上の 2 つと同じ根拠を作れないため。根拠の無い点を足すと、次に触る人が
 * 「なぜこの点なのか」を辿れなくなる。
 *
 * 埋め合わせに、固定リビジョンが上流のリビジョン一覧に含まれることを
 * `collectUnlistedStations` が確かめている（固定先が消えた・書き間違えたを捕まえる）。
 */
const REQUIRED_UNLISTED = ['宮崎県|延岡市北方町卯', '大阪府|豊中市役所']

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'station-coords.json')

/** 座標を約100m精度に丸めてファイルサイズを抑える。 */
function round(value) {
  return Math.round(Number(value) * 1000) / 1000
}

async function main() {
  const stations = await fetchListedStations()

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

  /**
   * 観測点 1 件を [lat, lon, regionIdx?] にする。読めない座標は null。
   *
   * **現行と「現行の一覧に無いもの」で共有する。** 元データの座標は 0.01 度（約 1km）粒度しか
   * ないため、細い島や海岸沿いの観測点は区域ポリゴンとの点内包判定が海側に落ちて区域集約から
   * 漏れる。区域の帰属は座標から推測せず、元データが持つ区域名をそのまま引き継ぐ。
   *
   * **`regionNames` へ登録する副作用がある**ので、呼ぶ場所を増やすときは順序に注意すること
   * （名前を持たない観測点にまで呼ぶと、その区域名が余分に登録されて添字がずれる）。
   */
  const entryOf = (s) => {
    const lat = round(s.lat)
    const lon = round(s.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return s.area?.name ? [lat, lon, regionIndexOf(s.area.name)] : [lat, lon]
  }

  for (const s of stations) {
    const prefName = s.pref?.name
    const lat = round(s.lat)
    const lon = round(s.lon)
    if (!prefName || !Number.isFinite(lat) || !Number.isFinite(lon)) continue

    const areaName = s.area?.name

    // 観測点単位。**組み立ては `entryOf` に任せる** —— 現行と「現行の一覧に無いもの」で
    // 別々に書くと、丸め方や区域の付け方を片方だけ変えたときに黙って食い違う。
    if (s.name) {
      stationCoords[`${prefName}|${s.name}`] = entryOf(s)
    }

    // 細分区域単位（重心を後で算出）。
    // **現行の観測点だけで積む。** 区域の代表点は観測点座標の平均なので、現行の一覧に無い
    // 観測点を混ぜると代表点が動く。この値は震度速報の描画・カメラの寄り先・読み上げの
    // 距離選抜に効くため、動かすと無関係なところがずれる。
    if (areaName) {
      const key = `${prefName}|${areaName}`
      const acc = areaAccumulator.get(key) ?? { latSum: 0, lonSum: 0, count: 0 }
      acc.latSum += lat
      acc.lonSum += lon
      acc.count += 1
      areaAccumulator.set(key, acc)
    }
  }

  const listedKeys = new Set(Object.keys(stationCoords))
  const unlistedSource = await collectUnlistedStations(listedKeys)
  const unlistedCoords = {}
  let unlistedNoCoords = 0
  for (const [key, s] of unlistedSource) {
    const entry = entryOf(s)
    // 座標を読めないものは載せられない。**数えて出す** —— 上流の書式が変わって全滅しても、
    // 件数の検査を他のリビジョンぶんで通り抜けてしまうため。
    if (entry) unlistedCoords[key] = entry
    else unlistedNoCoords++
  }
  if (unlistedNoCoords > 0) {
    console.warn(`Skipped ${unlistedNoCoords} unlisted station(s) with unreadable coordinates`)
  }

  const areaCoords = {}
  for (const [key, { latSum, lonSum, count }] of areaAccumulator) {
    areaCoords[key] = [round(latSum / count), round(lonSum / count)]
  }

  // --- 検査。合わなければ書き出さずに止める ---
  const listedCount = listedKeys.size
  const unlistedCount = Object.keys(unlistedCoords).length
  if (listedCount < LISTED_COUNT_RANGE.min || listedCount > LISTED_COUNT_RANGE.max) {
    throw new Error(
      `現行の観測点が ${listedCount} 点で、想定の幅（${LISTED_COUNT_RANGE.min}〜${LISTED_COUNT_RANGE.max}）から外れています`,
    )
  }
  if (unlistedCount < UNLISTED_RANGE.min || unlistedCount > UNLISTED_RANGE.max) {
    throw new Error(
      `現行の一覧に無い観測点が ${unlistedCount} 点で、想定の幅（${UNLISTED_RANGE.min}〜${UNLISTED_RANGE.max}）から外れています。`
      + '0 に近いなら上流のリビジョン履歴を辿れていません',
    )
  }
  const overlap = Object.keys(unlistedCoords).filter((k) => listedKeys.has(k))
  if (overlap.length > 0) {
    throw new Error(`現行と重複する観測点が ${overlap.length} 件あります: ${overlap.slice(0, 3).join(' / ')}`)
  }
  const missing = REQUIRED_UNLISTED.filter((k) => !(k in unlistedCoords))
  if (missing.length > 0) {
    throw new Error(`履歴から拾えるはずの観測点が入っていません: ${missing.join(' / ')}`)
  }
  // **現行の一覧に無い観測点が、新しい区域名を持ち込んでいないこと。**
  // 持ち込むとその区域は `areas`（区域塗りのポリゴンを引く鍵）に無いまま名前だけ引けるようになり、
  // **寄った画には点が出るのに、引いた画の区域塗りから黙って外れる**。
  // ここで止めるのは、`npm test` を待たずに生成そのものが気づけるようにするため。
  const listedRegions = new Set(Object.values(stationCoords).map((e) => e[2]).filter((i) => i != null))
  const introduced = Object.entries(unlistedCoords)
    .filter(([, e]) => e[2] != null && !listedRegions.has(e[2]))
    .map(([key, e]) => `${key}（${regionNames[e[2]]}）`)
  if (introduced.length > 0) {
    throw new Error(
      `現行のどの観測点も属さない区域を持ち込む観測点が ${introduced.length} 件あります: ${introduced.slice(0, 3).join(' / ')}。`
      + 'その区域は区域塗りのポリゴンを引けないため、寄った画にしか出ません',
    )
  }

  const output = { stations: stationCoords, unlisted: unlistedCoords, areas: areaCoords, regionNames }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(output))
  console.log(
    `Wrote ${OUT_FILE} (stations: ${listedCount}, unlisted: ${unlistedCount}, ` +
      `areas: ${Object.keys(areaCoords).length}, regions: ${regionNames.length})`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
