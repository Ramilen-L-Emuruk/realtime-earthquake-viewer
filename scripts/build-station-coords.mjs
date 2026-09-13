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
// 更新方法: node scripts/build-station-coords.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// **この行がこのファイルで最初の gist URL リテラルであること。** `stationReadings.test.ts` が
// 正規表現で最初の 1 件を拾い、読み仮名側の取得元と一致するかを検査している。
const SOURCE_URL =
  'https://gist.githubusercontent.com/iku55/79005d1896631ad6117bbe327b8162c1/raw/6458684e522767a9ffc42f9bba9d6b2b06253f44/stations.json'

// 上流のリビジョン一覧と、各リビジョンの中身。**取得元は SOURCE_URL から導く** ——
// gist の識別子とファイル名を別のリテラルで持つと、取得元を差し替えたときに片方だけ古くなる。
const { user: GIST_USER, id: GIST_ID, file: GIST_FILE } = parseGistUrl(SOURCE_URL)
const GIST_COMMITS_API = `https://api.github.com/gists/${GIST_ID}/commits`

/**
 * 現行の一覧に無い観測点として受け入れる件数の幅。2026-09 時点で 122 点。
 *
 * **この値だけを歯止めにしない。** 件数は「履歴を辿れたか」の代理値で、一部のリビジョンが
 * まるごと読めなくても残りで幅に収まってしまう。辿れた版の数そのものは
 * {@link MIN_READABLE_REVISIONS} が見る。
 */
const UNLISTED_RANGE = { min: 80, max: 600 }

/**
 * 中身を読めたリビジョンの下限。2026-09 時点で 23 版中 22 版が読める（1 版は上流の保存が
 * 途中で切れている）。
 *
 * **件数ではなくこちらが本体の歯止め。** 取得元が一時的に応答しなくなった・形が変わったと
 * いった形で一部の版が落ちても、拾えた観測点の数だけを見ていると気づけない。
 * 上流はリビジョンを足す一方なので、この下限を割ったら中身ではなく取得の側を疑う。
 */
const MIN_READABLE_REVISIONS = 20

/** 現行の観測点として受け入れる件数の幅。2026-09 時点で 4372 点。 */
const LISTED_RANGE = { min: 4000, max: 5000 }

/**
 * 履歴から必ず拾えなければならない観測点。**どれも実電文に出てくる。**
 *
 * - 延岡市北方町卯 … 2022-01-22 日向灘（最大震度5強）で「震度５弱以上未入電」として届いた 60 地点の 1 つ
 * - 豊中市役所 … 2018-06-18 大阪府北部で震度5強を観測
 * - 箕面市今宮 … 上の 2 つとは逆に、**固定リビジョンより後に一覧へ加わった**観測点
 */
const REQUIRED_UNLISTED = ['宮崎県|延岡市北方町卯', '大阪府|豊中市役所', '大阪府|箕面市今宮']

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'station-coords.json')

/** gist の raw URL から利用者名・識別子・ファイル名を取り出す。 */
function parseGistUrl(url) {
  const [, user, id, raw, , file] = new URL(url).pathname.split('/')
  if (!user || !id || raw !== 'raw' || !file) {
    throw new Error(`取得元 URL の形が想定と違います（.../<user>/<id>/raw/<revision>/<file> を期待）: ${url}`)
  }
  return { user, id, file }
}

/** 座標を約100m精度に丸めてファイルサイズを抑える。 */
function round(value) {
  return Math.round(Number(value) * 1000) / 1000
}

async function fetchText(url, what) {
  const res = await fetch(url, { headers: { 'User-Agent': 'build-station-coords' } })
  if (!res.ok) throw new Error(`${what}を取得できません（HTTP ${res.status}）: ${url}`)
  return await res.text()
}

async function fetchJson(url, what) {
  return JSON.parse(await fetchText(url, what))
}

/**
 * 上流のリビジョン（新しい順）を全ページ辿って返す。
 *
 * **GitHub API を叩くのはここだけ。** 各リビジョンの中身は raw の CDN から取るので、
 * 未認証の 60 回/時という制限にかかるのは 1 リクエストだけで済む。
 */
async function fetchRevisions() {
  const versions = []
  for (let page = 1; page <= 20; page++) {
    const items = await fetchJson(`${GIST_COMMITS_API}?per_page=100&page=${page}`, '上流のリビジョン一覧')
    if (!Array.isArray(items)) throw new Error('上流のリビジョン一覧が配列ではありません')
    for (const it of items) {
      if (typeof it?.version !== 'string') throw new Error('リビジョン一覧に version を持たない項目があります')
      versions.push(it.version)
    }
    if (items.length < 100) return versions
  }
  throw new Error('上流のリビジョンが多すぎます（20 ページを超えました）')
}

/**
 * 現行の一覧に無い観測点を、上流のリビジョン履歴から集める。
 *
 * **廃止された観測点だけではない。** 固定リビジョンより後に一覧へ加わった観測点もここへ入る
 * （どちらも「現行の一覧＝固定リビジョン に無い」という点では同じで、座標を引く側から見れば
 * 区別する理由が無い）。名前を `unlisted` にしているのはそのため。
 *
 * @param listed 固定リビジョンの観測点キー（"都道府県|観測点名"）の集合
 */
async function collectUnlisted(listed) {
  const revisions = await fetchRevisions()
  console.log(`Found ${revisions.length} revisions`)
  const unlisted = new Map()
  const unreadable = []
  const noPref = new Set()
  let noName = 0
  for (const revision of revisions) {
    const url = `https://gist.githubusercontent.com/${GIST_USER}/${GIST_ID}/raw/${revision}/${GIST_FILE}`
    // **取得そのものの失敗は止める。** 一時的な障害を黙って飲み込むと、欠けたことが
    // 生成物から分からないまま「拾えたつもり」の表ができあがる。
    const text = await fetchText(url, `リビジョン ${revision.slice(0, 8)} の観測点一覧`)
    // **中身が読めないリビジョンは飛ばす。** 上流には保存が途中で切れたリビジョンが実在し
    // （2021-12-18 の版が 651,917 バイトで途切れている）、これを失敗にすると生成が
    // 永久に通らない。**飛ばした数は下の {@link MIN_READABLE_REVISIONS} が見る**ので、
    // 一部の版がまとめて読めなくなればそこで止まる。
    let stations
    try {
      stations = JSON.parse(text)
    } catch {
      stations = null
    }
    if (!Array.isArray(stations)) {
      unreadable.push(revision.slice(0, 8))
      continue
    }
    for (const s of stations) {
      // 都道府県を持たない観測点は飛ばす。**引く側の鍵が "都道府県|観測点名" なので、
      // 県が無いと索引にも座標にも載せられない**（現行の一覧側も同じ理由で飛ばしている）。
      // 上流の古いリビジョンに実在する（例: 伊豆大島町岡田）。
      if (!s?.name) { noName++; continue }
      if (!s?.pref?.name) { noPref.add(s.name); continue }
      const key = `${s.pref.name}|${s.name}`
      if (listed.has(key) || unlisted.has(key)) continue
      unlisted.set(key, s)
    }
  }
  if (unreadable.length > 0) {
    console.warn(`Skipped ${unreadable.length} unreadable revision(s): ${unreadable.join(' ')}`)
  }
  if (noPref.size > 0) {
    console.warn(`Skipped ${noPref.size} station(s) without a prefecture: ${[...noPref].slice(0, 5).join(' ')}`)
  }
  if (noName > 0) {
    console.warn(`Skipped ${noName} entr(ies) without a name`)
  }
  const readable = revisions.length - unreadable.length
  if (readable < MIN_READABLE_REVISIONS) {
    throw new Error(
      `中身を読めたリビジョンが ${readable} 件しかありません（全 ${revisions.length} 件・下限 ${MIN_READABLE_REVISIONS}）。`
      + '取得元の形が変わったか、取得が一部失敗しています',
    )
  }
  return unlisted
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`)
  const stations = await fetchJson(SOURCE_URL, '観測点一覧')
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
  const unlistedSource = await collectUnlisted(listedKeys)
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
  if (listedCount < LISTED_RANGE.min || listedCount > LISTED_RANGE.max) {
    throw new Error(`現行の観測点が ${listedCount} 点で、想定の幅（${LISTED_RANGE.min}〜${LISTED_RANGE.max}）から外れています`)
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
