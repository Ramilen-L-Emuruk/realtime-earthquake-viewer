// 2016年熊本地震のローカル履歴アーカイブ（public/data/historical-archives/2016-kumamoto.json）を
// 一次資料から機械的に生成する。
//
//   npx tsx scripts/build-historical-archive-2016-kumamoto.ts
//
// 2011年東北地方太平洋沖地震と違い、気象庁防災情報XMLフォーマットの運用開始（2011年5月12日）
// より後の地震のため、当時配信された本物のXML電文が国立情報学研究所（NII）CPS-IIPプロジェクト
// 「気象庁防災情報XMLデータベース」に残っている。地震情報（震度速報・震源に関する情報・
// 震源・震度情報・顕著な地震の震源要素更新のお知らせ）と津波は、そこから取得した生XMLを
// アプリ本番と同じパーサー（src/services/dmdataParser.ts の parseEarthquakeFromXml /
// parseTsunamiFromXml）にそのまま通す。
//
// ただし緊急地震速報（VXSE43/45）はこのNIIアーカイブに1件も収録されていない（確認済み。
// 二次配信の契約上の制限によるものと見られる）。EEWだけは東北地方太平洋沖地震と同じ、
// 気象庁の発表状況ページ（pub_hist）から取得する。
//
// 出典・ライセンス:
//   - 地震情報・津波: 気象庁防災情報XMLデータベース（国立情報学研究所 CPS-IIP, Asanobu KITAMOTO）
//     https://agora.ex.nii.ac.jp/cps/weather/report/ 、CC BY 4.0
//   - EEW: 気象庁ホームページ（緊急地震速報（警報）発表状況）。政府標準利用規約（第1.0版）
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { buildEewEntries } from './historicalEewArchiveBuilder'
import { parseEewContentHtml } from './historicalEewParser'
import { fetchDayListing, fetchRawXml, fetchText } from './niiJmaXmlArchive'
import type { HistoricalArchiveEntry, HistoricalArchiveFile } from '../src/types/historicalArchive'
import type { AppEvent } from '../src/types/earthquake'

// dmdataParser.ts の XML パースが `new DOMParser()` をブラウザグローバルとして参照するため、
// Node.js環境ではjsdomで代替する（capture-test-scenario.ts と同じ対処）。
const { window: jsdomWindow } = new JSDOM('')
globalThis.DOMParser = jsdomWindow.DOMParser as unknown as typeof DOMParser

// jsdomの差し込みより後でないとdmdataParser.tsの読み込み時にDOMParser未定義で失敗しうるため、
// 動的importで順序を保証する。
const { parseEarthquakeFromXml, parseTsunamiFromXml } = await import('../src/services/dmdataParser')

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', '2016-kumamoto.json')
const INDEX_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', 'index.json')

const EEW_BASE = 'https://www.data.jma.go.jp/eew/data/nc/pub_hist/2016/04'

/** 気象庁の発表状況ページで確認済みの、この地震活動で緊急地震速報（警報）が発表された19件。 */
const EEW_EVENTS: { idPrefix: string; dir: string }[] = [
  { idPrefix: '2016kumamoto-foreshock', dir: '20160414212638' },
  { idPrefix: '2016kumamoto-as01', dir: '20160414220739' },
  { idPrefix: '2016kumamoto-as02', dir: '20160414223846' },
  { idPrefix: '2016kumamoto-as03', dir: '20160415000349' },
  { idPrefix: '2016kumamoto-mainshock', dir: '20160416012510' },
  { idPrefix: '2016kumamoto-as04', dir: '20160416014412' },
  { idPrefix: '2016kumamoto-as05', dir: '20160416014601' },
  { idPrefix: '2016kumamoto-as06', dir: '20160416030315' },
  { idPrefix: '2016kumamoto-as07', dir: '20160416035558' },
  { idPrefix: '2016kumamoto-as08', dir: '20160416041512' },
  { idPrefix: '2016kumamoto-as09', dir: '20160416071139' },
  { idPrefix: '2016kumamoto-as10', dir: '20160416074226' },
  { idPrefix: '2016kumamoto-as11', dir: '20160416094838' },
  { idPrefix: '2016kumamoto-as12', dir: '20160416112859' },
  { idPrefix: '2016kumamoto-as13', dir: '20160416142706' },
  { idPrefix: '2016kumamoto-as14', dir: '20160416160204' },
  { idPrefix: '2016kumamoto-as15', dir: '20160417193033' },
  { idPrefix: '2016kumamoto-as16', dir: '20160418204204' },
  { idPrefix: '2016kumamoto-as17', dir: '20160419175215' },
]

// 地震情報・津波として取り込む対象の電文の見分け方。
//
// NIIサイトの表示ラベルは、完全一致で辞書引きするには信用できないことが分かっている
// （実際に2回踏んだ事故: 「震源・震度情報」だと思っていたら実際は「震源・震度に関する
// 情報」だった／津波系のラベルには末尾に説明のつかない"a"が付く）。そのため、まず
// 「地震・津波に関係しそうな候補」を広くキーワードで拾い、個別の種別判定は含有文字列で
// 行う。どれにも一致しない候補は黙って捨てず例外にする（次にラベルが変わった時に
// 気づけるようにする。silent-failure-hunterレビューで指摘された「未知の入力を黙って
// スキップする」経路を作らない）。
const QUAKE_CANDIDATE_KEYWORDS = ['震度', '震源', '顕著な地震']
const TSUNAMI_CANDIDATE_KEYWORD = '津波'

/**
 * 地震情報の種別ラベルから、より具体的なパターンを先に判定する（「震源・震度」は
 * 「震源」も含むため、判定順を間違えると全てVXSE52に丸め込まれる）。
 */
function resolveQuakeHeadType(typeLabel: string): string {
  if (typeLabel.includes('震度速報')) return 'VXSE51'
  if (typeLabel.includes('顕著な地震')) return 'VXSE61'
  if (typeLabel.includes('震源・震度')) return 'VXSE53'
  if (typeLabel.includes('震源')) return 'VXSE52'
  throw new Error(`地震情報の種別ラベルを解釈できません: "${typeLabel}"`)
}

// この地震活動の震央地名（本震・前震・誘発地震が使う名前。EEWの一覧で確認済み）。
// 震度速報等は全国の地震を対象に発表されるため、無関係な地震の電文を取り込まないよう
// 震央地名で絞り込む。
const KUMAMOTO_HYPOCENTER_NAMES = new Set(['熊本県熊本地方', '熊本県阿蘇地方', '熊本県天草・芦北地方', '大分県中部', '大分県西部', '熊本県球磨地方'])

// 震度速報（VXSE51）は震源が未確定の段階で発表されるため震央地名を持たない
// （parseEarthquakeFromXmlの仕様どおり、hypocenter.nameは常に空文字になる）。
// そのため震度速報だけは、観測震度の対象地域名で判定する。
// KUMAMOTO_HYPOCENTER_NAMES（震央地名の完全一致）より意図的に粗い前方一致にしている
// （震度速報は一次細分区域名を返すため、県名・地方名レベルでしか震央と対応が取れない）。
// この粒度の非対称自体は許容するが、時刻ウィンドウ（WINDOW_START/END）と併用することで
// 誤って別の地震を拾わないよう二重に絞る設計にしている。
const KUMAMOTO_AREA_PREFIXES = ['熊本', '阿蘇', '大分県中部', '大分県西部']

function isKumamotoRelated(quake: { earthquake: { hypocenter: { name: string } }; points: { addr: string }[] }): boolean {
  if (quake.earthquake.hypocenter.name) return KUMAMOTO_HYPOCENTER_NAMES.has(quake.earthquake.hypocenter.name)
  return quake.points.some((p) => KUMAMOTO_AREA_PREFIXES.some((prefix) => p.addr.startsWith(prefix)))
}

// 取消電文（InfoType==='取消'）は parseEarthquakeFromXml が points・hypocenter.name を
// 両方とも空にして返す仕様のため、isKumamotoRelated() のどちらの経路にも一致しない
// （必ず false になる）。震央地名・観測地域名のどちらでも判定できない構造上の穴であり、
// 誤って「無関係」に丸め込まず専用の判定・専用カウンタで扱う。
function isUnverifiableCancellation(quake: { cancelled?: boolean; earthquake: { hypocenter: { name: string } }; points: { addr: string }[] }): boolean {
  return quake.cancelled === true && !quake.earthquake.hypocenter.name && quake.points.length === 0
}

// EEW対象19件（前震4/14 21:26 〜 誘発地震4/19 17:52）を漏れなく含むよう、収録範囲を
// 最後のイベントの翌日0時（JST）まで確保する。地震情報・津波もこの範囲に合わせて取得する
// （収録範囲より後に発生したEEWが再生不能になる事故が過去レビューで発覚したため、
// EEW_EVENTSの実際の日付レンジとDATES/WINDOW_ENDを必ず連動させること）。
const DATES = ['20160414', '20160415', '20160416', '20160417', '20160418', '20160419']
const WINDOW_START = new Date('2016-04-14T12:00:00+09:00')
const WINDOW_END = new Date('2016-04-20T00:00:00+09:00')

// NIIサイトの一覧表示時刻（例: "2016-04-14 21:28:06+09"）はISO 8601ではない
// （タイムゾーンオフセットが分無しの2桁）。`new Date()` にそのまま渡すと Invalid Date に
// なり、Invalid Date 同士の比較は常に false を返すため、時刻ウィンドウによる絞り込みが
// 無警告で機能しなくなる（実際に踏んだ事故）。分を補ってからパースし、それでも
// Invalid Date ならログでは気づけないため例外にする。
function parseNiiTime(niiTime: string): Date {
  const m = niiTime.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\+(\d{2})$/)
  if (!m) throw new Error(`NII一覧の時刻表記を解釈できません: "${niiTime}"`)
  const parsed = new Date(`${m[1]}T${m[2]}+${m[3]}:00`)
  if (Number.isNaN(parsed.getTime())) throw new Error(`NII一覧の時刻をDateとして解釈できません: "${niiTime}"`)
  return parsed
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

async function buildEewSection(): Promise<HistoricalArchiveEntry[]> {
  const all: HistoricalArchiveEntry[] = []
  for (const { idPrefix, dir } of EEW_EVENTS) {
    const url = `${EEW_BASE}/${dir}/content/content_out.html`
    const html = await fetchText(url)
    if (!html || html.includes('404')) throw new Error(`${idPrefix}: EEWページを取得できません（${url}）`)
    const parsed = parseEewContentHtml(html)
    const entries = buildEewEntries(parsed, { idPrefix })
    if (entries.length === 0) throw new Error(`${idPrefix}: 報が1件も生成されませんでした（${url}）`)
    all.push(...entries)
    console.log(`  ${idPrefix}: ${entries.length}報 (${parsed.hypocenter.name} M${parsed.hypocenter.magnitude})`)
  }
  return all
}

async function buildQuakeAndTsunamiSection(): Promise<HistoricalArchiveEntry[]> {
  const entries: HistoricalArchiveEntry[] = []
  let totalCandidates = 0
  let fetched = 0
  let kept = 0
  let skippedOutOfWindow = 0
  let skippedUnrelated = 0
  let skippedParseFailed = 0
  let skippedCancelledUnverifiable = 0

  for (const date of DATES) {
    console.log(`  ${date} の電文一覧を取得中...`)
    const listing = await fetchDayListing(date)
    // 全国対象の天気・警報等も含む一覧が1件も無い日は、対象日の指定ミスかサイト側の
    // 構造異常のいずれかであり、平常時でもまずあり得ない。黙って「候補0件」に進めず
    // 例外にする（候補0件そのもの＝フィルタ後の結果は正当にありうるので許容する）。
    if (listing.length === 0) throw new Error(`${date}: 電文一覧が0件でした（一覧ページの取得に問題がある可能性）`)

    const candidates = listing.filter(
      (it) => QUAKE_CANDIDATE_KEYWORDS.some((k) => it.typeLabel.includes(k)) || it.typeLabel.includes(TSUNAMI_CANDIDATE_KEYWORD),
    )
    console.log(`    候補 ${candidates.length}件`)
    totalCandidates += candidates.length

    for (const item of candidates) {
      const itemTime = parseNiiTime(item.time)
      if (itemTime < WINDOW_START || itemTime > WINDOW_END) {
        skippedOutOfWindow++
        continue
      }

      const xml = await fetchRawXml(item.id)
      fetched++
      await sleep(120) // 小規模なアカデミックサーバーへの配慮

      if (item.typeLabel.includes(TSUNAMI_CANDIDATE_KEYWORD)) {
        const tsunami = parseTsunamiFromXml(xml)
        if (!tsunami) {
          skippedParseFailed++
          continue
        }
        // 津波電文には震源要素（sourceEarthquake）が無い場合がある（観測情報のみの続報等）。
        // 持っている場合だけ震央地名で関連性を確認する。持たない場合はキーワード＋時刻
        // ウィンドウのみが頼りになる（isKumamotoRelated と非対称だが、津波電文の構造上
        // これ以上の判定材料が無い）。
        if (tsunami.sourceEarthquake?.hypocenterName && !KUMAMOTO_HYPOCENTER_NAMES.has(tsunami.sourceEarthquake.hypocenterName)) {
          skippedUnrelated++
          continue
        }
        // dmdataParser.ts の id 生成は eventId+serial を使うが、Serial が空の電文（震度速報等）
        // では固定値'1'に丸められるため、同じ地震の別種別の電文と衝突しうる。NIIの電文ID
        // （電文ごとに一意）を足して確実に一意にする。
        entries.push({ time: tsunami.time, payload: { kind: 'event', event: { ...tsunami, id: `${tsunami.id}-${item.id}` } as AppEvent } })
        kept++
        continue
      }

      const headType = resolveQuakeHeadType(item.typeLabel)
      const quake = parseEarthquakeFromXml(headType, xml)
      if (!quake) {
        skippedParseFailed++
        continue
      }
      if (isUnverifiableCancellation(quake)) {
        // 取消電文は震央地名・観測地域名のどちらも持たないため isKumamotoRelated() で
        // 判定できない（構造上の制約）。無関係と決めつけて捨てず、専用カウンタで
        // 可視化した上で見送る。
        skippedCancelledUnverifiable++
        continue
      }
      if (!isKumamotoRelated(quake)) {
        skippedUnrelated++
        continue
      }
      entries.push({ time: quake.time, payload: { kind: 'event', event: { ...quake, id: `${quake.id}-${item.id}` } as AppEvent } })
      kept++
    }
  }

  console.log(
    `  地震情報・津波: 取得${fetched}件 → 採用${kept}件` +
      `（期間外${skippedOutOfWindow}件・無関係${skippedUnrelated}件・パース失敗${skippedParseFailed}件・` +
      `取消電文（判定不能）${skippedCancelledUnverifiable}件を除外）`,
  )
  if (kept === 0) throw new Error('地震情報・津波が1件も採用されませんでした')
  const accountedFor = kept + skippedOutOfWindow + skippedUnrelated + skippedParseFailed + skippedCancelledUnverifiable
  if (accountedFor !== totalCandidates) {
    throw new Error(`集計の不整合: 候補${totalCandidates}件に対し内訳の合計が${accountedFor}件です`)
  }
  return entries
}

async function main() {
  console.log('EEW（前震・本震・誘発地震19件）を取得中...')
  const eewEntries = await buildEewSection()

  console.log('地震情報・津波（NIIアーカイブの実電文）を取得中...')
  const quakeTsunamiEntries = await buildQuakeAndTsunamiSection()

  const allEntries = [...eewEntries, ...quakeTsunamiEntries].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
  )

  const idCounts = new Map<string, number>()
  for (const e of allEntries) {
    const id = (e.payload as { event?: { id?: string } }).event?.id
    if (!id) throw new Error(`idを持たないエントリがあります: ${JSON.stringify(e)}`)
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1)
  if (duplicateIds.length > 0) {
    throw new Error(`id が重複しています: ${duplicateIds.map(([id, count]) => `${id}(${count}件)`).join(', ')}`)
  }

  if (allEntries.length === 0) throw new Error('entriesが1件もありません（firstEventTimeを決定できません）')

  const out: HistoricalArchiveFile = {
    id: '2016-kumamoto',
    label: '2016年熊本地震',
    description:
      '2016年4月14日21時26分頃、熊本県熊本地方を震源とするM6.5の地震（前震）が発生。同16日1時25分頃には同地方でM7.3の地震（本震）が発生し、いずれも熊本県益城町で震度7を観測した（熊本地震）。',
    from: WINDOW_START.toISOString(),
    to: WINDOW_END.toISOString(),
    firstEventTime: allEntries[0].time,
    entries: allEntries,
  }

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8')
  console.log(`書き出し完了: ${OUT_PATH}（全${allEntries.length}件）`)

  const indexRaw = await readFile(INDEX_PATH, 'utf-8')
  const index = JSON.parse(indexRaw) as { id: string; description: string }[]
  const newIndexEntry = { id: out.id, label: out.label, description: out.description, from: out.from, to: out.to, firstEventTime: out.firstEventTime }
  const updatedIndex = [...index.filter((e) => e.id !== out.id), newIndexEntry]
  await writeFile(INDEX_PATH, JSON.stringify(updatedIndex, null, 2) + '\n', 'utf-8')
  console.log('index.json を更新しました')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
