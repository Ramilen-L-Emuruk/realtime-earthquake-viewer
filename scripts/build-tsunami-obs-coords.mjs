// 津波観測点の座標テーブルを生成する。
//
// 出力: public/data/tsunami-obs-coords.json
//   { "岩手沖６０ｋｍＡ": [39.2312, 142.7684], ... }   ← [緯度, 経度]
//
// 津波情報（VTSE51/52）の電文は観測点を名前とコードでしか伝えない（座標は入っていない）。
// 地図へ観測棒・到達確認の印を出し、カメラを寄せるには、名前から座標を引く表が要る。
//
// ## 取得元
//
// | # | 取得元 | 役割 |
// |---|--------|------|
// | 1 | 気象庁 防災情報XML 個別コード表（PointTsunami） | 電文に現れる観測点名の網羅リスト |
// | 2 | 同（PointTidalLevel） | 沿岸の観測点の座標 |
// | 3 | 気象庁 津波観測点（全国）の地域図 | 観測点名・運用機関・図上の位置 |
// | 4 | 地震調査研究推進本部 検潮・津波観測施設 | 全機関の観測施設の座標 |
// | 5 | 防災科学技術研究所 海底地震津波観測網 観測点情報 | 4 の座標を独立に検証する |
//
// **名前から座標へ直接引ける表は、どこも公開していない。** 1 の名前（「岩手沖６０ｋｍＡ」）は
// 気象庁が津波情報のために付けたもので、2・4 が使う運用機関側の名前（「三陸沖１」「下北」）とは
// 別の体系にある。そこで 3 の地域図を仲立ちにする —— 図には両者を結ぶ手掛かり（気象庁の名前が
// 図のどこにあるか）があるので、図上の位置を緯度経度へ直してから 4・2 の施設に突き合わせる。
//
// ## 図上の位置を緯度経度へ直す
//
// 地域図には座標を既に知っている観測点（名前が 2・4 と一致するもの）が 1 図あたり 6〜33 点ある。
// その対応から、図のピクセルと緯度経度の間の 1 次式を地域ごとに当てる（残差は 1〜3km）。
// 当てた式で残りの観測点の位置を割り出し、最も近い施設を選ぶ。沖合の観測点は 20〜30km 間隔で
// 並んでいるので、この精度でも取り違えない（第 2 候補との差で確かめている）。
//
// 更新方法: node scripts/build-tsunami-obs-coords.mjs
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { findWorkbookInZip } from './lib/xlsx.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_FILE = join(__dirname, '..', 'public', 'data', 'tsunami-obs-coords.json')

// 個別コード表の zip は URL に更新日が入る（jmaxml_20260826_Code.zip）ため、技術資料ページから解決する。
const JMA_TEC_MATERIAL = 'https://xml.kishou.go.jp/tec_material.html'
// 津波観測点（全国）。地域ごとの図に観測点名・運用機関・図上の位置（イメージマップ）が入っている。
const JMA_TSUNAMI_MAP = 'https://www.jma.go.jp/jma/kishou/know/jishin/tsunamimap/'
const JMA_MAP_REGIONS = [
  'Hokkaidou', 'Tohoku', 'Kanto', 'Tokai', 'Hokuriku',
  'Kinki', 'Chugoku', 'Shikoku', 'Kyushu', 'Nansei',
]
// 検潮・津波観測施設。CSV の URL にも年が入るため、一覧ページから解決する。
const JISHIN_STATION_INDEX = 'https://www.jishin.go.jp/database/observation_station/spots/'
// 海底地震津波観測網（S-net／DONET／N-net／相模湾）の観測点情報。
const NIED_STATION_INFO = 'https://www.seafloor.bosai.go.jp/st_info/'
// 上の観測網を運用する機関。検潮・津波観測施設の表でこの名前が付く施設は、必ず観測点情報にも載る。
const NIED_ORG = '防災科学技術研究所'

// --- 突き合わせの閾値 ----------------------------------------------------------------

/** 図から割り出した位置と、名前が一致した施設との差がこれを超えたら別物とみなす（km）。 */
const NAME_MATCH_MAX_KM = 5
/** 名前が一致しないとき、図から割り出した位置の近くにある施設を採る上限（km）。 */
const NEAR_MATCH_MAX_KM = 8
/** 最も近い施設を採るには、2 番目に近い施設がこの倍率より遠くにある必要がある。 */
const NEAR_MATCH_MARGIN = 2.5
/**
 * 名前で照合できない観測点の別名。指す施設の名前（と、同名が複数あるときは所在地の手掛かり）を書く。
 *
 * **座標はここに書かない** —— 位置は公表されている表から引く。
 */
const STATION_ALIASES = new Map([
  // 「奥尻」は 2 件あり、奥尻町松江の検潮所と奥尻港の観測施設で 10km 離れている。
  ['奥尻島松江', { name: '奥尻', addr: '松江' }],
  // 港の名前は「三田尻中関港」だが、潮位を観測しているのは三田尻（防府市新田）。
  ['三田尻中関港', { name: '三田尻' }],
])

/**
 * どの一覧にも載っていない観測点の座標。
 *
 * 気象庁の観測点図にも、潮位観測点・検潮・津波観測施設のどちらの表にも現れない観測点がある。
 * 電文には出てくるので、座標が無いと地図から落ちる。**ここに足す前に、名前の食い違いで
 * 引けていないだけでないかを確かめること**（その場合は `STATION_ALIASES` が正しい置き場所）。
 */
const UNLISTED_COORDS = new Map([
  ['羽幌港', [44.37, 141.7]],
  ['久米島', [26.35, 126.8]],
])

/** 同じ名前の施設がこれだけ近ければ、取得元が違うだけの同じ場所とみなす（km）。 */
const SAME_PLACE_MAX_KM = 2
/**
 * 当てはめの種を増やすときに、その対応を信じてよい距離（km）。
 *
 * **突き合わせ本番（`NEAR_MATCH_MAX_KM`）より厳しくすること。** 種は次の回の当てはめを動かすので、
 * 少しずれた対応を入れると式がそちらへ引っ張られ、引っ張られた式がさらにずれた対応を選ぶ。
 * 沖合の観測点は南北に等間隔で並んでおり、全体が隣へ 1 つずれても残差は小さいままになる
 * （実際、この歯止めが無いと東北の図が丸ごと 0.87 度＝約 97km 北へずれ、残差は 0.49km だった）。
 */
const SEED_GROW_MAX_KM = 2
/** 種を増やした結果、図の中心が指す位置がこれ以上動いたら、増やす前の式へ戻す（km）。 */
const SEED_GROW_MAX_DRIFT_KM = 3

// --- 検査の閾値 ----------------------------------------------------------------------

/** 図の 1 次式の残差（RMS）がこれを超えたら、図の描き方が変わったとみなして止める（km）。 */
const MAX_FIT_RMS_KM = 5
/** 防災科学技術研究所の座標との食い違い（中央値・最大）の許容（km）。 */
const MAX_CROSS_CHECK_MEDIAN_KM = 0.5
const MAX_CROSS_CHECK_WORST_KM = 5
/**
 * 沖合の観測点で、名前が示す距離に対して実際の距離が収まるべき比。
 *
 * 観測点は港にあり海岸線そのものではないうえ、名前の距離がどこから測ったものかは公表されていない。
 * 実測では 246 点中 245 点が 0.35〜2.2 倍に収まり、外れた 1 点（高知沖３０ｋｍＡ）も
 * 土佐湾の奥にある観測点が近いだけだった。取り違えを捕まえるには広めで足りる。
 */
const OFFSHORE_DISTANCE_MIN_RATIO = 0.3
const OFFSHORE_DISTANCE_MAX_RATIO = 2.5
/** 上の比から外れる観測点をいくつまで許すか（0 にすると海岸の形だけで落ちる）。 */
const MAX_OFFSHORE_DISTANCE_GAPS = 3
/** 公式の座標へ解決できず図から読み取った座標で埋めた点の上限（これを超えたら取得元の変化を疑う）。 */
const MAX_MAP_DERIVED = 40
/**
 * 取得元ごとの件数の下限。
 *
 * **結果どうしを突き合わせる検査だけでは、入力そのものが縮んだ場合を捕まえられない。** 表の列が
 * 1 つ増えて読み取りがずれれば、観測点の大半が黙って落ちる。落ちた後の集合を基準に「全部解決できた」と
 * 判定してしまうので、入力の段階で絶対値を見る。値は実測（2026-09 時点）の 8〜9 割。
 */
const MIN_COUNTS = { stations: 400, tidal: 270, jishin: 380, nied: 200, mapPoints: 450 }
const INPUT_LABELS = {
  stations: '電文に現れる観測点名',
  tidal: '潮位観測点',
  jishin: '検潮・津波観測施設',
  nied: '海底地震津波観測網の観測点',
  mapPoints: '観測点図に載っている点',
}
/**
 * 防災科学技術研究所の観測点と照合できるべき件数の下限（2026-09 時点の実測は実行ログに出る）。
 *
 * **「照合できなかった」を見逃さないための下限。** 座標を大きく取り違えると近くに観測点が無くなり、
 * 食い違いとしてではなく「照合対象から外れる」形で消える。件数を見ていれば、そちらの経路で気づける。
 */
const MIN_CROSS_CHECKED = 200
/**
 * その研究所が運用する施設として解決できているべき件数の下限（2026-09 時点の実測は 240 点前後）。
 *
 * **この検査そのものが死んでいないかを見る番人。** 運用機関の照合は名前の完全一致なので、上流が
 * 表記を変えれば（法人格を付ける・全角半角が変わる）1 件も一致しなくなり、**照合の検査は
 * 「異常なし」を返し続ける**。件数の下限を置いておけば、一致しなくなった瞬間に気づける。
 */
const MIN_NIED_OPERATED = 190
/**
 * 同じ施設を 2 つの観測点へ割り当ててしまったとみなす距離（km）。
 *
 * **取得元をまたいで見るため、名前ではなく座標の近さで判定する**（同じ場所が潮位観測点の表と
 * 検潮・津波観測施設の表の両方に、わずかに違う座標で載っている）。実データで最も近い別々の
 * 観測点は三浦市三崎漁港と三浦市油壺の 1.71km なので、これを下回る値にする。
 */
const DUPLICATE_PLACE_MAX_KM = 0.5

/**
 * 生成結果が期待どおりかを確かめる観測点。取得元ごとに 1 点以上を選んである。
 *
 * **2 種類が混ざっていることに注意。** 前半は取得元の公表値をそのまま書いたもので、生成とは
 * 独立に裏が取れる。後半は生成結果を写した回帰の固定で、**「いま正しいか」ではなく「前と変わって
 * いないか」しか言えない**。気象庁の観測点名と運用機関側の施設との対応は、気象庁の観測点図を
 * 通してしか辿れないため、独立な出典を書けるものが限られる。
 */
const EXPECTED = [
  // --- 取得元の公表値（独立に確認できる） ---
  // 気象庁のケーブル式海底津波計。検潮・津波観測施設の「東南海３」の公表座標。
  { name: '静岡沖５０ｋｍ', lat: 34.2173, lng: 137.692 },
  // 同じく「東南海１」（DONET1）。
  { name: '三重南東沖６０ｋｍＢ', lat: 33.6543, lng: 136.8406 },
  // 潮位観測点の「釧路」（北海道釧路市港町）。
  { name: '釧路', lat: 42.9756, lng: 144.3714 },
  // 潮位観測点の「宮古島」。南西諸島は地域図 1 枚あたりの点が最も少なく、当てはめが最も苦しい。
  { name: '宮古島平良', lat: 24.8133, lng: 125.2783 },
  // 潮位観測点の「奥尻」（奥尻町松江）。同名がもう 1 件 10km 離れてあり、別名で振り分けている。
  { name: '奥尻島松江', lat: 42.0783, lng: 139.4892 },

  // --- 生成結果の固定（前と変わっていないことだけを見る） ---
  // 防災科学技術研究所 S-net。名前と施設の対応は観測点図を通してしか辿れない。
  { name: '岩手沖６０ｋｍＡ', lat: 40.1088, lng: 142.6222 },
  // 同 N-net。運用開始が新しく、取得元の更新が最も早く現れる。
  { name: '宮崎沖３０ｋｍＡ', lat: 31.6551, lng: 131.7699 },
  // 公式の座標一覧が無く、図から読み取る観測点（GNSS 波浪計）。読み取りの誤差を見込んで許容を広げる。
  { name: '岩手宮古沖', lat: 39.6245, lng: 142.1801, toleranceKm: 3 },
  // `UNLISTED_COORDS` と同じ値。**座標の裏取りではなく、その経路が生きているかを見る。**
  { name: '羽幌港', lat: 44.37, lng: 141.7 },
]

// --- 取得 --------------------------------------------------------------------------

/** 応答が返らない相手で止まらないよう、取得は打ち切る（`fetch` は既定で待ち続ける）。 */
const FETCH_TIMEOUT_MS = 60_000

async function fetchBytes(url, label) {
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `${FETCH_TIMEOUT_MS / 1000} 秒待っても応答がありません` : err.message
    throw new Error(`${label} を取得できません（${reason}）: ${url}`)
  }
  if (!res.ok) throw new Error(`${label} を取得できません（HTTP ${res.status}）: ${url}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function fetchText(url, label) {
  const buf = await fetchBytes(url, label)
  // BOM 付きで配られるものがある（地震調査研究推進本部の CSV・防災科学技術研究所の HTML）。
  const text = new TextDecoder('utf-8').decode(buf)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 気象庁の個別コード表から、観測点名の一覧（PointTsunami）と沿岸の座標（PointTidalLevel）を読む。
 */
async function fetchJmaCodeTables() {
  const index = await fetchText(JMA_TEC_MATERIAL, '気象庁 技術資料ページ')
  const file = /href="(jmaxml_\d+_Code\.zip)"/i.exec(index)?.[1]
  if (!file) throw new Error('気象庁 技術資料ページに個別コード表（jmaxml_*_Code.zip）へのリンクがありません')
  const zip = await fetchBytes(new URL(file, JMA_TEC_MATERIAL).href, '気象庁 個別コード表')

  const quake = findWorkbookInZip(zip, (sheets) =>
    String(sheets.get('35')?.[0]?.[0] ?? '').includes('PointTsunami'))
  if (!quake) throw new Error('個別コード表に PointTsunami のシート（地震火山関連コード表のシート 35）がありません')
  const tidalBook = findWorkbookInZip(zip, (sheets) => sheets.has('tidallevel_master'))
  if (!tidalBook) throw new Error('個別コード表に潮位観測点のシート（tidallevel_master）がありません')

  // PointTsunami: [Code, Name, ふりがな, 簡略名Code, 簡略名Name, 備考]。
  // 備考が付く行は「ヘッダ部でのみ使用する簡略化した観測点名」で、電文の内容部には現れない
  // （観測値を伴わないので座標も要らない）。
  const stations = []
  for (const row of quake.get('35').slice(3)) {
    const [code, name, kana, , , note] = row
    if (typeof code !== 'number' || typeof name !== 'string' || !name) continue
    if (typeof note === 'string' && note.includes('ヘッダ部でのみ使用')) continue
    stations.push({ code, name, kana: typeof kana === 'string' ? kana : '' })
  }

  // tidallevel_master: [番号, 所管機関, 観測所名, カナ, 所在地, 緯度度, 緯度分, 経度度, 経度分, 観測方式, ...]。
  // 度と分が別の列に入っている。**`typeof x === 'number'` で確かめないこと** —— `NaN` も number なので
  // 素通りし、`[null, null]` という座標が例外も出さずに書き出される（`JSON.stringify` が `NaN` を
  // `null` にする）。分だけが読めない場合も 0 として扱わず、件数を数えて後で報告する
  // （分が 1 つ落ちるだけで最大 1.8km ずれ、名前の一致で採ってしまえばどの検査にも掛からない）。
  const tidal = []
  let brokenMinutes = 0
  for (const row of tidalBook.get('tidallevel_master').slice(2)) {
    const [id, org, name, , addr, latDeg, latMin, lngDeg, lngMin] = row
    if (typeof id !== 'number' || typeof name !== 'string') continue
    if (!Number.isFinite(latDeg) || !Number.isFinite(lngDeg)) continue
    if (!Number.isFinite(latMin) || !Number.isFinite(lngMin)) { brokenMinutes++; continue }
    tidal.push({
      source: 'tidal',
      name: name.trim(),
      org: typeof org === 'string' ? org : '',
      addr: typeof addr === 'string' ? addr : '',
      lat: latDeg + latMin / 60,
      lng: lngDeg + lngMin / 60,
    })
  }
  return { stations, tidal, brokenMinutes }
}

/**
 * 気象庁の津波観測点（全国）の地域図から、観測点名・運用機関・図上の位置を読む。
 *
 * 図はイメージマップになっており、`<area>` の `title` が「名前（運用機関）」、`coords` が
 * その点を囲む矩形（図の左上を原点としたピクセル）になっている。
 */
async function fetchObservationMaps() {
  const points = []
  for (const region of JMA_MAP_REGIONS) {
    const html = await fetchText(`${JMA_TSUNAMI_MAP}${region}.html`, `気象庁 津波観測点（${region}）`)
    const before = points.length
    // 属性は順不同で拾う（`coords` が `title` より先に書かれている前提を置かない）。
    for (const m of html.matchAll(/<area\b([^>]*)>/g)) {
      const coords = /\bcoords="([\d,\s]+)"/.exec(m[1])?.[1]
      const title = /\btitle="([^"]*)"/.exec(m[1])?.[1]
      if (!coords || !title) continue
      const box = coords.split(',').map((v) => Number(v.trim()))
      if (box.length < 4 || box.some((v) => !Number.isFinite(v))) continue
      // 「名前（運用機関）」の形。機関が書かれていない点があっても名前だけは拾う。
      const label = /^(.*)（(.*)）$/.exec(title)
      points.push({
        region,
        name: label ? label[1] : title,
        org: label ? label[2] : '',
        x: (box[0] + box[2]) / 2,
        y: (box[1] + box[3]) / 2,
      })
    }
    if (points.length === before) {
      throw new Error(`気象庁 津波観測点（${region}）に観測点のイメージマップがありません`)
    }
  }
  return points
}

/** 地震調査研究推進本部の検潮・津波観測施設（全機関・座標つき）を読む。 */
async function fetchJishinStations() {
  const index = await fetchText(JISHIN_STATION_INDEX, '地震調査研究推進本部 地震観測施設一覧')
  const path = /href="([^"]*\/csv\/tsunami_\d+\.csv)"/.exec(index)?.[1]
  if (!path) throw new Error('地震調査研究推進本部の一覧ページに検潮・津波観測施設の CSV へのリンクがありません')
  const csv = await fetchText(new URL(path, JISHIN_STATION_INDEX).href, '地震調査研究推進本部 検潮・津波観測施設')

  const rows = parseCsv(csv)
  const header = rows.findIndex((row) => row[0] === '観測の種類')
  if (header < 0) throw new Error('検潮・津波観測施設の CSV に見出し行（観測の種類）がありません')
  const out = []
  for (const row of rows.slice(header + 1)) {
    const lat = Number(row[4])
    const lng = Number(row[5])
    if (!row[1] || !Number.isFinite(lat) || !Number.isFinite(lng)) continue
    out.push({ source: 'jishin', kind: row[0], name: row[1].trim(), org: (row[8] ?? '').trim(), lat, lng })
  }
  return out
}

/** 防災科学技術研究所の観測点情報（S-net／DONET／N-net／相模湾）を読む。検証専用。 */
async function fetchNiedStations() {
  const html = await fetchText(NIED_STATION_INFO, '防災科学技術研究所 観測点情報')
  const rows = [...html.matchAll(
    /<td>([^<]+)<\/td>\s*<td>([A-Z]\.[^<]+)<\/td>\s*<td>([\d.]+)<\/td>\s*<td>([\d.]+)<\/td>/g,
  )].map((m) => ({ net: m[1], code: m[2], lat: Number(m[3]), lng: Number(m[4]) }))
  if (rows.length === 0) throw new Error('防災科学技術研究所の観測点情報から観測点を読めません（表の形が変わった可能性）')
  return rows
}

/** 引用符つきの CSV を行と列に分ける。 */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

// --- 幾何 --------------------------------------------------------------------------

const EARTH_KM_PER_DEG = 111.19

function distanceKm(aLat, aLng, bLat, bLng) {
  const midLat = ((aLat + bLat) / 2) * (Math.PI / 180)
  return Math.hypot((aLat - bLat) * EARTH_KM_PER_DEG, (aLng - bLng) * EARTH_KM_PER_DEG * Math.cos(midLat))
}

/** 最小二乗で y = a*x + b を当てる。 */
function fitLine(xs, ys) {
  const n = xs.length
  const sumX = xs.reduce((a, v) => a + v, 0)
  const sumY = ys.reduce((a, v) => a + v, 0)
  const sumXX = xs.reduce((a, v) => a + v * v, 0)
  const sumXY = xs.reduce((a, v, i) => a + v * ys[i], 0)
  const den = n * sumXX - sumX * sumX
  if (den === 0) throw new Error('図の 1 次式を当てられません（対応点が一直線に並んでいます）')
  const a = (n * sumXY - sumX * sumY) / den
  return { a, b: (sumY - a * sumX) / n }
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.floor(sorted.length / 2)]
}

// --- 突き合わせ --------------------------------------------------------------------

/**
 * 地域図ごとに、ピクセルから緯度経度への 1 次式を当てる。
 *
 * 種は「名前が施設の名前と一致する観測点」。当てた式で全点の位置を割り出し、そこで新たに
 * 突き合わせられた点を種に加えて当て直す（沖合のように名前が一致しない点ばかりの図でも、
 * 回を重ねるごとに種が増える）。残差の大きい種は落とす —— 取得元の座標そのものが誤っている
 * ことがあるため（実例: 潮位観測点の「徳山」は 2 件あり、片方の経度が 70km ずれている）。
 */
function fitRegions(mapPoints, facilities) {
  const byName = new Map()
  for (const f of facilities) {
    if (!byName.has(f.name)) byName.set(f.name, [])
    byName.get(f.name).push(f)
  }
  const byRegion = new Map()
  for (const p of mapPoints) {
    if (!byRegion.has(p.region)) byRegion.set(p.region, [])
    byRegion.get(p.region).push(p)
  }

  const fits = new Map()
  for (const [region, points] of byRegion) {
    // 1 回目の種は、名前の一致だけで位置が決まる観測点。同じ名前の施設が複数あっても、
    // それらが互いに近ければ同じ場所を指しているので種に使える（2 つの取得元に同じ観測点が
    // 載っている場合がこれにあたる。離れていれば別物なので、位置を決めてからでないと選べない）。
    let seeds = points
      .map((p) => ({ point: p, facility: unambiguous(byName.get(p.name) ?? []) }))
      .filter((s) => s.facility)
    if (seeds.length < 3) {
      throw new Error(`${region} の図に、位置の判っている観測点が ${seeds.length} 点しかありません（3 点以上必要）`)
    }
    let fit = solveFit(seeds)
    const baseline = fit
    const center = centerOf(points)
    for (let round = 0; round < 4; round++) {
      // 残差の大きい種を落として当て直す。取得元の座標そのものが誤っていることがあるため
      // （実例: 潮位観測点の「徳山」は 2 件あり、片方の経度が 70km ずれている）。
      const trimmed = seeds.filter((s) => residualKm(fit, s) < Math.max(2.5 * fit.rms, 2))
      if (trimmed.length >= 3 && trimmed.length < seeds.length) {
        seeds = trimmed
        fit = solveFit(seeds)
      }
      // 当てた式で新しく突き合わせられた点を種に加える（名前の一致しない沖合の観測点も、
      // 位置で対応が付けば次の回の種になる）。
      const known = new Set(seeds.map((s) => s.point))
      const grown = [...seeds]
      for (const p of points) {
        if (known.has(p)) continue
        const at = project(fit, p)
        const hit = nearestUnique(facilities, at.lat, at.lng)
        if (hit && distanceKm(at.lat, at.lng, hit.lat, hit.lng) <= SEED_GROW_MAX_KM) {
          grown.push({ point: p, facility: hit })
        }
      }
      if (grown.length === seeds.length) break
      const grownFit = solveFit(grown)
      const before = project(fit, center)
      const after = project(grownFit, center)
      if (distanceKm(before.lat, before.lng, after.lat, after.lng) > SEED_GROW_MAX_DRIFT_KM) {
        // 種を増やしたら図全体が動いた。増やした対応のどれかが間違っているので、増やす前で打ち切る。
        break
      }
      seeds = grown
      fit = grownFit
    }
    // 最初の種（名前の一致だけで決まる、最も確かな対応）から離れていないかを最後に見る。
    const drift = driftKm(baseline, fit, center)
    if (drift > SEED_GROW_MAX_DRIFT_KM) {
      throw new Error(`${region} の図の当てはめが、名前で対応の付く点だけで当てた式から ${drift.toFixed(1)}km ずれています`)
    }
    if (fit.rms > MAX_FIT_RMS_KM) {
      throw new Error(`${region} の図の当てはめが粗すぎます（残差 ${fit.rms.toFixed(2)}km・上限 ${MAX_FIT_RMS_KM}km）`)
    }
    fits.set(region, fit)
  }
  return fits
}

/**
 * 同じ名前の施設が互いに近ければ 1 つを返す（同じ場所を別の取得元が載せているだけ）。
 * 離れたものが混ざっていたら、名前だけでは位置を決められないので返さない。
 */
function unambiguous(candidates) {
  if (candidates.length === 0) return null
  const [first] = candidates
  const scattered = candidates.some((f) => distanceKm(first.lat, first.lng, f.lat, f.lng) > SAME_PLACE_MAX_KM)
  return scattered ? null : first
}

/** 図の点の重心（当てはめの違いを比べる基準にする）。 */
function centerOf(points) {
  return {
    x: points.reduce((a, p) => a + p.x, 0) / points.length,
    y: points.reduce((a, p) => a + p.y, 0) / points.length,
  }
}

/** 2 つの当てはめが、同じ図上の点に対してどれだけ違う位置を返すか（km）。 */
function driftKm(a, b, point) {
  const pa = project(a, point)
  const pb = project(b, point)
  return distanceKm(pa.lat, pa.lng, pb.lat, pb.lng)
}

function solveFit(seeds) {
  const lng = fitLine(seeds.map((s) => s.point.x), seeds.map((s) => s.facility.lng))
  const lat = fitLine(seeds.map((s) => s.point.y), seeds.map((s) => s.facility.lat))
  const fit = { lng, lat, rms: 0, seeds: seeds.length }
  const residuals = seeds.map((s) => residualKm(fit, s))
  fit.rms = Math.sqrt(residuals.reduce((a, v) => a + v * v, 0) / residuals.length)
  return fit
}

function project(fit, point) {
  return { lat: fit.lat.a * point.y + fit.lat.b, lng: fit.lng.a * point.x + fit.lng.b }
}

function residualKm(fit, seed) {
  const at = project(fit, seed.point)
  return distanceKm(at.lat, at.lng, seed.facility.lat, seed.facility.lng)
}

/** 指定の距離内で最も近い施設を返す。 */
function nearestWithin(facilities, lat, lng, maxKm) {
  let best = null
  let bestDistance = Infinity
  for (const f of facilities) {
    const d = distanceKm(lat, lng, f.lat, f.lng)
    if (d < bestDistance) { best = f; bestDistance = d }
  }
  return bestDistance <= maxKm ? best : null
}

/** 最も近い施設を返す。2 番目に近い施設が十分離れていなければ（決め手に欠けるので）返さない。 */
function nearestUnique(facilities, lat, lng) {
  const sorted = facilities
    .map((f) => ({ f, d: distanceKm(lat, lng, f.lat, f.lng) }))
    .sort((x, y) => x.d - y.d)
  const [first, second] = sorted
  if (!first || first.d > NEAR_MATCH_MAX_KM) return null
  if (second && second.d < first.d * NEAR_MATCH_MARGIN) return null
  return first.f
}

/**
 * 名前で施設を絞る。強い手掛かりから順に試し、最初に当たった段階の候補だけを返す。
 *
 * 観測点名（気象庁が津波情報のために付けた名前）と施設の名前は別々に管理されていて、
 * 同じ場所でも「小樽市忍路」と「忍路」のように食い違う。一方で短い名前は他所と衝突しやすく
 * （「小樽市忍路」は「小樽」も含んでしまう）、部分一致だけでは決められない。所在地まで見ると
 * 「小樽市 忍路１丁目」が観測点名をそのまま含むので、そこで振り分けられる。
 */
function matchByName(station, facilities) {
  const alias = STATION_ALIASES.get(station.name)
  if (alias) {
    const name = normalizeName(alias.name)
    const addr = alias.addr ? normalizeName(alias.addr) : ''
    return facilities.filter(
      (f) => normalizeName(f.name) === name && (!addr || normalizeName(f.addr ?? '').includes(addr)),
    )
  }
  const target = normalizeName(station.name)
  const exact = facilities.filter((f) => normalizeName(f.name) === target)
  if (exact.length) return exact
  const byAddress = facilities.filter((f) => facilityHaystack(f).includes(target))
  if (byAddress.length) return byAddress
  // 最後は部分一致。1 文字の施設名は地名の一部にたまたま現れるだけのことが多いので除く。
  return facilities.filter((f) => {
    const name = normalizeName(f.name)
    return name.length >= 2 && (name.includes(target) || target.includes(name))
  })
}

/**
 * 観測点 1 つの座標を決める。
 *
 * 名前の一致を最優先にし、図から割り出した位置は「その一致が正しいか」の裏取りと、名前で
 * 引けないときの手掛かりに使う。どちらでも決められなければ図の位置をそのまま採る。
 */
function resolveStation(station, at, facilities) {
  const named = matchByName(station, facilities)
  const only = unambiguous(named)
  if (only && (!at || distanceKm(at.lat, at.lng, only.lat, only.lng) <= NAME_MATCH_MAX_KM)) {
    return { ...pick(only), via: '名前' }
  }
  if (named.length > 1 && at) {
    // 同じ名前の施設が離れて複数ある（実例: 潮位観測点の「徳山」は 2 件あり、片方の経度が
    // 70km ずれている）。図の位置に近いほうを採る。
    const best = named
      .map((f) => ({ f, d: distanceKm(at.lat, at.lng, f.lat, f.lng) }))
      .sort((x, y) => x.d - y.d)[0]
    if (best.d <= NAME_MATCH_MAX_KM) return { ...pick(best.f), via: '名前と位置' }
  }
  if (at) {
    const near = nearestUnique(facilities, at.lat, at.lng)
    if (near) return { ...pick(near), via: '位置' }
    // 公式の座標一覧に無い（GNSS 波浪計が該当する）。図から読み取った位置で埋める。
    return { lat: at.lat, lng: at.lng, source: 'map', facility: '', via: '図' }
  }
  const fallback = UNLISTED_COORDS.get(station.name)
  if (fallback) return { lat: fallback[0], lng: fallback[1], source: 'unlisted', facility: '', via: '一覧に無い' }
  return null
}

/**
 * 名前を突き合わせる前に表記のゆれを均す。
 *
 * 気象庁の観測点名と施設の名前は別々に管理されており、同じ地名でも「鼠ケ関」「鼠ヶ関」のように
 * 小書きの有無が食い違う。ここで均さないと、その 1 文字だけを理由に対応が付かない。
 */
function normalizeName(name) {
  return name.replace(/[ヶヵ]/g, 'ケ').replace(/\s+/g, '')
}

/** 施設を指しうる文字列（所在地と名前）。観測点名に市町村名が入る組を拾うために所在地も見る。 */
function facilityHaystack(facility) {
  return normalizeName(`${facility.addr ?? ''}${facility.name}`)
}

function pick(facility) {
  return {
    lat: facility.lat, lng: facility.lng, source: facility.source,
    facility: facility.name, org: facility.org ?? '',
  }
}

// --- 検査 --------------------------------------------------------------------------

/**
 * 生成結果を確かめる。ここで見つかる食い違いは、どれも出来上がった JSON からは見えない
 * （座標は有効な数値の形をしているので、地図には「それらしい位置」として描かれてしまう）。
 */
function verify(resolved, stations, nied, fits, inputs, crossCheck = {}) {
  const problems = []

  for (const [key, min] of Object.entries(MIN_COUNTS)) {
    const got = inputs[key]
    if (got < min) problems.push(`${INPUT_LABELS[key]}が ${got} 件しかありません（${min} 件以上を見込んでいます）`)
  }
  if (inputs.brokenMinutes > 0) {
    problems.push(`潮位観測点の表で、度は読めたのに分を読めなかった行が ${inputs.brokenMinutes} 件あります（列の並びが変わった可能性）`)
  }

  const missing = stations.filter((s) => !resolved.has(s.name))
  if (missing.length) {
    problems.push(`座標を決められなかった観測点が ${missing.length} 点あります: ${missing.slice(0, 5).map((s) => s.name).join('・')}`)
  }

  // 1 つの施設を 2 つ以上の観測点に割り当てていたら、どこかで取り違えている。
  // **取得元をまたいで見ること** —— 同じ場所が潮位観測点の表と検潮・津波観測施設の表の両方に、
  // わずかに違う座標で載っている。取得元ごとに数えると、別々の観測点名が同じ場所を指していても
  // 気づけない。
  const placed = [...resolved.entries()].filter(([, r]) => r.source !== 'map' && r.source !== 'unlisted')
  const shared = []
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const [nameA, a] = placed[i]
      const [nameB, b] = placed[j]
      const apart = distanceKm(a.lat, a.lng, b.lat, b.lng)
      // 座標が重なっているか、同じ施設名を別々の取得元から引いているか。**後者を距離だけで
      // 捉えようとすると閾値を `SAME_PLACE_MAX_KM`（2km）まで広げることになり、1.71km しか
      // 離れていない別々の観測点（三浦市三崎漁港と三浦市油壺）を誤って束ねてしまう。**
      const sameFacility = a.facility && a.facility === b.facility && apart <= SAME_PLACE_MAX_KM
      if (apart <= DUPLICATE_PLACE_MAX_KM || sameFacility) shared.push(`${nameA} と ${nameB}`)
    }
  }
  if (shared.length) {
    problems.push(`同じ場所を複数の観測点に割り当てています: ${shared.slice(0, 5).join(' / ')}`)
  }

  // 検潮・津波観測施設の座標を、防災科学技術研究所の観測点情報で突き合わせる。
  //
  // **これが見ているのは 2 つの取得元が同じ場所を指しているかであって、名前と施設の対応が
  // 正しいかではない**（取り違えても、掴んだ先が観測網の別の点なら 0km で一致してしまう）。
  // 代わりに、**その研究所が運用する施設に解決した点は必ず観測点情報にも載っているはず**という
  // 関係を使い、載っていなければ 1 点でも異常として扱う —— 別の機関の施設を掴んだ取り違えは
  // ここに現れる。
  //
  // 照合には最近傍をそのまま使う（`nearestUnique` の「2 番目が十分遠いこと」は掴む先を決める
  // ための条件で、既に決まった座標を突き合わせるには厳しすぎる。実際、相模湾の観測施設は
  // 6 点が密に並んでおり、3.9km 離れた正しい相手を引けずに未照合へ落ちた）。
  const niedPoints = nied.map((n) => ({ ...n, name: n.code, source: 'nied' }))
  const gaps = []
  const unmatched = []
  for (const [name, r] of resolved) {
    if (r.source !== 'jishin') continue
    const hit = nearestWithin(niedPoints, r.lat, r.lng, NEAR_MATCH_MAX_KM)
    if (hit) gaps.push(distanceKm(r.lat, r.lng, hit.lat, hit.lng))
    else if (r.org === NIED_ORG) unmatched.push(name)
  }
  if (unmatched.length) {
    problems.push(
      `${NIED_ORG}が運用する施設に割り当てたのに、その観測点情報と照合できない観測点が ${unmatched.length} 点あります: ${unmatched.slice(0, 5).join('・')}`,
    )
  }
  const operated = [...resolved.values()].filter((r) => r.org === NIED_ORG).length
  crossCheck.operated = operated
  if (operated < MIN_NIED_OPERATED) {
    problems.push(
      `${NIED_ORG}が運用する施設として解決できたのが ${operated} 点しかありません（${MIN_NIED_OPERATED} 点以上を見込んでいます）。`
      + `上の照合が名前の完全一致に頼っているので、運用機関の表記が変わるとこの数が落ちます`,
    )
  }
  crossCheck.count = gaps.length
  crossCheck.median = gaps.length ? median(gaps) : 0
  crossCheck.worst = gaps.length ? Math.max(...gaps) : 0
  if (gaps.length < MIN_CROSS_CHECKED) {
    problems.push(`防災科学技術研究所の観測点と照合できたのが ${gaps.length} 点しかありません（${MIN_CROSS_CHECKED} 点以上を見込んでいます）`)
  } else {
    const mid = median(gaps)
    const worst = Math.max(...gaps)
    if (mid > MAX_CROSS_CHECK_MEDIAN_KM || worst > MAX_CROSS_CHECK_WORST_KM) {
      problems.push(`防災科学技術研究所の座標と食い違っています（中央値 ${mid.toFixed(2)}km・最大 ${worst.toFixed(2)}km）`)
    }
  }

  const mapDerived = [...resolved.values()].filter((r) => r.source === 'map')
  if (mapDerived.length > MAX_MAP_DERIVED) {
    problems.push(`公式の座標へ解決できず図から読み取った観測点が ${mapDerived.length} 点あります（上限 ${MAX_MAP_DERIVED} 点）`)
  }

  // 沖合の観測点は名前に沿岸からの距離が入っている（「岩手沖６０ｋｍＡ」）。**対応付けを取り違えると
  // ここが合わなくなる** —— 隣の観測点を掴めば距離が 1 段ずれ、別の海域を掴めば桁で外れる。
  // 観測点の側は港にあって海岸線そのものではないため、比の許容は広めに採る。
  const offshoreGaps = []
  const coastal = [...resolved.entries()].filter(([name]) => !/ｋｍ/.test(name)).map(([, r]) => r)
  const byArea = new Map()
  for (const [name, r] of resolved) {
    const declared = /^(.+?)([０-９]+)ｋｍ/.exec(name)
    if (!declared || coastal.length === 0) continue
    const namedKm = Number(declared[2].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
    if (!Number.isFinite(namedKm) || namedKm <= 0) continue
    const nearest = Math.min(...coastal.map((c) => distanceKm(r.lat, r.lng, c.lat, c.lng)))
    const ratio = nearest / namedKm
    if (ratio < OFFSHORE_DISTANCE_MIN_RATIO || ratio > OFFSHORE_DISTANCE_MAX_RATIO) {
      offshoreGaps.push(`${name}（名前は ${namedKm}km・最寄りの沿岸まで ${nearest.toFixed(1)}km）`)
    }
    if (!byArea.has(declared[1])) byArea.set(declared[1], [])
    byArea.get(declared[1]).push({ name, declared: namedKm, actual: nearest })
  }
  if (offshoreGaps.length > MAX_OFFSHORE_DISTANCE_GAPS) {
    problems.push(`名前の距離と実際の位置が合わない沖合の観測点が ${offshoreGaps.length} 点あります: ${offshoreGaps.slice(0, 5).join('・')}`)
  }

  // **上の比では、同じ距離帯の中での取り違え（隣の施設を 1 つ掴む）を捉えられない。** それを狙って
  // 「同じ海域では名前の距離が大きいほど沿岸から遠いはず」という順序も見ようとしたが、採らなかった。
  // 物差しにできる「沿岸までの距離」が最寄りの沿岸観測点までの距離でしかなく、観測点は港に疎らに
  // あるので海岸線からの距離とは別物になる。**正しい生成結果でも 2,162 組中 62 組（2.9%）が逆転し、
  // 枝番まで揃えても 913 組中 22 組が逆転した** —— 取り違えを見分けられる余地が残らない。
  // 隣を掴む取り違えは、上の「同じ場所を複数の観測点に割り当てていないか」で玉突きとして
  // 現れるものを拾う。**2 点がちょうど入れ替わる形だけは、どの検査にも掛からない。**

  for (const expected of EXPECTED) {
    const got = resolved.get(expected.name)
    if (!got) {
      problems.push(`照合用の観測点「${expected.name}」がありません`)
      continue
    }
    const d = distanceKm(got.lat, got.lng, expected.lat, expected.lng)
    const tolerance = expected.toleranceKm ?? 2
    if (d > tolerance) {
      problems.push(
        `照合用の観測点「${expected.name}」の座標が期待と ${d.toFixed(2)}km 違います`
        + `（期待 ${expected.lat},${expected.lng} / 生成 ${got.lat.toFixed(4)},${got.lng.toFixed(4)}・許容 ${tolerance}km）`,
      )
    }
  }

  for (const [region, fit] of fits) {
    if (fit.seeds < 3) problems.push(`${region} の図の当てはめに使えた点が ${fit.seeds} 点しかありません`)
  }
  return problems
}

// --- 本体 --------------------------------------------------------------------------

async function main() {
  const [{ stations, tidal, brokenMinutes }, mapPoints, jishin, nied] = await Promise.all([
    fetchJmaCodeTables(),
    fetchObservationMaps(),
    fetchJishinStations(),
    fetchNiedStations(),
  ])
  console.log(`観測点名 ${stations.length} 点 / 図の点 ${mapPoints.length} / 潮位観測点 ${tidal.length} / 検潮・津波観測施設 ${jishin.length} / 海底観測網 ${nied.length}`)

  // 沿岸は気象庁の潮位観測点を先に見る（津波情報の観測点名と同じ体系にあるため名前で引ける）。
  // 沖合はそこに無いので、結果として地震調査研究推進本部の施設が選ばれる。
  const facilities = [...tidal, ...jishin]
  const byName = new Map()
  for (const f of facilities) {
    if (!byName.has(f.name)) byName.set(f.name, [])
    byName.get(f.name).push(f)
  }

  const fits = fitRegions(mapPoints, facilities)
  for (const [region, fit] of fits) {
    console.log(`  ${region.padEnd(10)} 対応点 ${String(fit.seeds).padStart(3)} 残差 ${fit.rms.toFixed(2)}km`)
  }

  // 同じ観測点が隣り合う地域の図に重複して載ることがある。残差の小さい図の位置を採る。
  const projected = new Map()
  for (const p of mapPoints) {
    const fit = fits.get(p.region)
    const current = projected.get(p.name)
    if (!current || fit.rms < current.rms) projected.set(p.name, { ...project(fit, p), rms: fit.rms })
  }

  const resolved = new Map()
  for (const station of stations) {
    const hit = resolveStation(station, projected.get(station.name) ?? null, facilities)
    if (hit) resolved.set(station.name, hit)
  }

  const crossCheck = {}
  const problems = verify(resolved, stations, nied, fits, {
    stations: stations.length, tidal: tidal.length, jishin: jishin.length,
    nied: nied.length, mapPoints: mapPoints.length, brokenMinutes,
  }, crossCheck)
  const byVia = new Map()
  for (const r of resolved.values()) byVia.set(r.via, (byVia.get(r.via) ?? 0) + 1)
  console.log(`座標を決めた観測点 ${resolved.size} / ${stations.length}`)
  console.log(`  引き当て方: ${[...byVia].map(([k, v]) => `${k} ${v}`).join(' / ')}`)
  const bySource = new Map()
  for (const r of resolved.values()) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1)
  console.log(`  取得元: ${[...bySource].map(([k, v]) => `${k} ${v}`).join(' / ')}`)
  console.log(`  ${NIED_ORG}の観測点情報と照合できた点: ${crossCheck.count}（中央値 ${crossCheck.median?.toFixed(3)}km・最大 ${crossCheck.worst?.toFixed(2)}km）`)
  console.log(`  うち同研究所が運用する施設として解決したもの: ${crossCheck.operated}`)

  if (problems.length) {
    console.error('\n生成を中止します（検査に通りませんでした）:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }

  // 並びは気象庁のコード順（電文のコードそのもの）。取得元が増減しても並びが揺れない。
  const out = {}
  for (const station of stations) {
    const r = resolved.get(station.name)
    out[station.name] = [round4(r.lat), round4(r.lng)]
  }
  await writeFile(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`, 'utf-8')
  console.log(`\n${OUT_FILE} に ${Object.keys(out).length} 点を書き出しました`)
}

/** 小数第 4 位（約 11m）へ丸める。取得元の公表精度（分単位・小数第 4 位）を下回らない。 */
function round4(value) {
  return Math.round(value * 10000) / 10000
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
