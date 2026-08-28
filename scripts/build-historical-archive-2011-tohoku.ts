// 2011年東北地方太平洋沖地震のローカル履歴アーカイブ（public/data/historical-archives/
// 2011-tohoku.json）を、気象庁の公表資料から機械的に生成する。
//
//   npx tsx scripts/build-historical-archive-2011-tohoku.ts
//
// 対象:
//   - 本震・警報級誘発地震19件の緊急地震速報（全報・全地域） … historicalEewParser/Builder
//   - 津波警報・注意報の発表〜解除（全12回・全国の予報区） … historicalTsunamiParser/Builder
// 地震情報のマグニチュード改定4報（気象庁記者発表に基づく手作業記録）は当スクリプトの対象外
// のため、既存ファイルの当該エントリをそのまま引き継ぐ。
//
// 出典: 気象庁ホームページ（緊急地震速報（警報）発表状況・発表した津波警報・注意報の検証）。
// 政府標準利用規約（第1.0版）に基づき、加工して作成。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEewEntries } from './historicalEewArchiveBuilder'
import { parseEewContentHtml } from './historicalEewParser'
import { buildTsunamiEntries } from './historicalTsunamiArchiveBuilder'
import { parseTsunamiEvaluationHtml } from './historicalTsunamiParser'
import type { HistoricalArchiveEntry, HistoricalArchiveFile } from '../src/types/historicalArchive'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', '2011-tohoku.json')
const INDEX_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', 'index.json')

const EEW_BASE = 'https://www.data.jma.go.jp/eew/data/nc/pub_hist/2011/03'

/** 本震＋気象庁が緊急地震速報（警報）を発表した誘発地震19件（発表状況一覧ページで確認済み）。 */
const EEW_EVENTS: { idPrefix: string; dir: string }[] = [
  { idPrefix: '2011tohoku-mainshock', dir: '20110311144640' },
  { idPrefix: '2011tohoku-as01', dir: '20110311174124' },
  { idPrefix: '2011tohoku-as02', dir: '20110311193547' },
  { idPrefix: '2011tohoku-as03', dir: '20110312031144' },
  { idPrefix: '2011tohoku-as04', dir: '20110312035907' },
  { idPrefix: '2011tohoku-as05', dir: '20110312040850' },
  { idPrefix: '2011tohoku-as06', dir: '20110312041624' },
  { idPrefix: '2011tohoku-as07', dir: '20110312043159' },
  { idPrefix: '2011tohoku-as08', dir: '20110312051153' },
  { idPrefix: '2011tohoku-as09', dir: '20110312054222' },
  { idPrefix: '2011tohoku-as10', dir: '20110312061855' },
  { idPrefix: '2011tohoku-as11', dir: '20110312063429' },
  { idPrefix: '2011tohoku-as12', dir: '20110312064844' },
  { idPrefix: '2011tohoku-as13', dir: '20110312221552' },
  { idPrefix: '2011tohoku-as14', dir: '20110312222439' },
  { idPrefix: '2011tohoku-as15', dir: '20110312222718' },
  { idPrefix: '2011tohoku-as16', dir: '20110312233505' },
  { idPrefix: '2011tohoku-as17', dir: '20110312234325' },
  { idPrefix: '2011tohoku-as18', dir: '20110313082506' },
  { idPrefix: '2011tohoku-as19', dir: '20110313102619' },
]

const TSUNAMI_URL = 'https://www.data.jma.go.jp/eqev/data/tsunamihyoka/20110311Tohokuchihoutaiheiyouoki/index.html'
const TSUNAMI_EVENT_ID = '20110311144618'
// 本震EEWの originTime（historicalEewParser.ts が #hypocentral_element_list から読む
// 「14時46分18.1秒」）と同じ値・同じ精度に揃える。同一の地震を指す2系列のデータで
// originTime の精度が食い違わないようにする。
const TSUNAMI_ORIGIN_TIME_ISO = '2011-03-11T05:46:18.100Z'

/**
 * ステージ1〜4（3/11 14:49〜16:08）は、気象庁が専門調査会へ提出した資料
 * 「東北地方太平洋沖地震に対する津波警報発表経過と課題」（平成23年6月13日）の観測経過図
 * （p.3-4）に、地域ごとの予測高さの推移が時系列で明記されている。それ以外のステージ・地域は
 * 「発表した津波警報・注意報の検証」ページの観測表（その地域が最終的に到達した予測区分）を使う
 * （ステージ5以降、これらの地域はいずれも資料記載の最終区分に達している）。
 */
const TSUNAMI_HEIGHT_OVERRIDES: Record<number, Record<string, number>> = {
  1: { 岩手県: 3, 宮城県: 6, 福島県: 3, 青森県太平洋沿岸: 1, 茨城県: 2, '千葉県九十九里・外房': 2 },
  2: { 岩手県: 6, 福島県: 6, 青森県太平洋沿岸: 3, 茨城県: 4, '千葉県九十九里・外房': 3, 千葉県内房: 1 },
  3: { 青森県太平洋沿岸: 8, 千葉県内房: 2 },
}

/**
 * ステージ番号ごとの、その時点で公表されていたマグニチュード推定値。
 * TSUNAMI_HEIGHT_OVERRIDES と同じ資料（「東北地方太平洋沖地震に対する津波警報発表経過と課題」
 * 平成23年6月13日、p.2）に記者発表時刻が明記されている:
 *   14:49 気象庁マグニチュード(Mj) 7.9 発表 / 16:00 Mj8.4を報道発表 / 17:30 モーメント
 *   マグニチュード(Mw) 8.8 を報道発表。M9.0への最終改定は気象庁が2011/3/13 12:55に発表
 *   （既存の地震情報エントリ 2011tohoku-quake-4 と同じ発表時刻）。
 */
const TSUNAMI_MAGNITUDE_BY_STAGE: Record<number, number> = {
  1: 7.9, 2: 7.9, 3: 7.9, 4: 8.4, 5: 8.8, 6: 8.8, 7: 8.8, 8: 8.8, 9: 8.8, 10: 8.8, 11: 8.8, 12: 9.0,
}

const TSUNAMI_REGION_CODES: Record<string, string> = { 岩手県: '030', 宮城県: '040', 福島県: '050' }

async function fetchText(url: string, retries = 3): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      if (attempt === retries) throw new Error(`取得失敗 ${url}: ${(err as Error).message}`)
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  throw new Error('unreachable')
}

async function buildEewSection(): Promise<HistoricalArchiveEntry[]> {
  const all: HistoricalArchiveEntry[] = []
  for (const { idPrefix, dir } of EEW_EVENTS) {
    const url = `${EEW_BASE}/${dir}/content/content_out.html`
    const html = await fetchText(url)
    const parsed = parseEewContentHtml(html)
    const entries = buildEewEntries(parsed, { idPrefix })
    if (entries.length === 0) throw new Error(`${idPrefix}: 報が1件も生成されませんでした（${url}）`)
    all.push(...entries)
    console.log(`  ${idPrefix}: ${entries.length}報 (${parsed.hypocenter.name} M${parsed.hypocenter.magnitude})`)
  }
  return all
}

async function buildTsunamiSection(): Promise<HistoricalArchiveEntry[]> {
  const html = await fetchText(TSUNAMI_URL)
  const { stages, observations } = parseTsunamiEvaluationHtml(html)
  if (stages.length !== 12) throw new Error(`津波の発表段階が12件のはずが${stages.length}件でした`)
  const entries = buildTsunamiEntries(stages, observations, {
    idPrefix: '2011tohoku',
    eventId: TSUNAMI_EVENT_ID,
    year: 2011,
    hypocenterName: '三陸沖',
    originTimeIso: TSUNAMI_ORIGIN_TIME_ISO,
    magnitudeByStage: TSUNAMI_MAGNITUDE_BY_STAGE,
    heightOverrides: TSUNAMI_HEIGHT_OVERRIDES,
    regionCodes: TSUNAMI_REGION_CODES,
  })
  console.log(`  津波: ${entries.length}段階`)
  return entries
}

async function main() {
  console.log('EEW（本震+誘発地震19件）を取得中...')
  const eewEntries = await buildEewSection()
  console.log('津波警報・注意報を取得中...')
  const tsunamiEntries = await buildTsunamiSection()

  const existingRaw = await readFile(OUT_PATH, 'utf-8')
  const existing = JSON.parse(existingRaw) as HistoricalArchiveFile
  const keptEntries = existing.entries.filter((e) => {
    const event = (e.payload as { event?: { kind?: string } }).event
    return event?.kind !== 'eew' && event?.kind !== 'tsunami'
  })
  console.log(`  地震情報等（既存の手作業記録を引き継ぎ）: ${keptEntries.length}件`)

  const allEntries = [...eewEntries, ...tsunamiEntries, ...keptEntries].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
  )

  // id の重複は、EEW_EVENTS の設定ミス（同じ idPrefix を2回使う等）が無音でデータを
  // 上書き/重複させていないかの最後の砦。件数チェックだけでは見えない。
  const idCounts = new Map<string, number>()
  for (const e of allEntries) {
    const id = (e.payload as { event?: { id?: string } }).event?.id
    if (!id) continue
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1)
  if (duplicateIds.length > 0) {
    throw new Error(`id が重複しています: ${duplicateIds.map(([id, count]) => `${id}(${count}件)`).join(', ')}`)
  }

  // 津波の各段階で、地域数に対して高さが確定した割合を可視化する（0でも異常ではない
  // ——格上げ前の段階は高さ不明が正しい——が、次にこのスクリプトを別の地震に流用した
  // 開発者が、観測テーブルとの名前不一致を見落とさないための目安として出力する）。
  for (const e of tsunamiEntries) {
    const event = (e.payload as { event: { areas: { maxHeight?: unknown }[]; cancelled: boolean } }).event
    if (event.cancelled) continue
    const withHeight = event.areas.filter((a) => a.maxHeight).length
    console.log(`    ${e.time}: 高さ確定 ${withHeight}/${event.areas.length} 地域`)
  }

  if (allEntries.length === 0) throw new Error('entriesが1件もありません（firstEventTimeを決定できません）')

  const out: HistoricalArchiveFile = {
    id: existing.id,
    label: existing.label,
    description: existing.description,
    from: existing.from,
    to: existing.to,
    firstEventTime: allEntries[0].time,
    entries: allEntries,
  }

  const indexRaw = await readFile(INDEX_PATH, 'utf-8')
  const index = JSON.parse(indexRaw) as { description: string }[]
  if (index[0]?.description !== out.description) {
    // description の食い違いは設定タブの一覧に出る利用者向け表示のズレなので、
    // 警告止まりにせず失敗させる（書き出し前に気づけるようにする）。
    throw new Error('index.json の description が 2011-tohoku.json と一致していません。手動で同期してください。')
  }

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8')
  console.log(`書き出し完了: ${OUT_PATH}（全${allEntries.length}件）`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
