// 2016年鳥取県中部地震のローカル履歴アーカイブ（public/data/historical-archives/2016-tottori.json）を
// 一次資料から機械的に生成する。
//
//   npx tsx scripts/build-historical-archive-2016-tottori.ts
//
// 気象庁防災情報XMLフォーマットの運用開始（2011年5月12日）より後の地震のため、当時配信された
// 本物のXML電文が国立情報学研究所（NII）CPS-IIPプロジェクト「気象庁防災情報XMLデータベース」に
// 残っている。地震情報はそこから取得した生XMLをアプリ本番と同じパーサー
// （src/services/dmdataParser.ts の parseEarthquakeFromXml）にそのまま通す。
// この地震活動では警報級EEWが本震・同日の余震1件のみで、津波警報・注意報の発表も無い
// （内陸直下型）。
//
// 緊急地震速報（VXSE43/45）はNIIアーカイブに1件も収録されていないため、気象庁の発表状況
// ページ（pub_hist）から取得する。
//
// 地震活動ごとに変わらない処理は localEarthquakeArchiveBuilder.ts に共通化している
// （2016年熊本地震向けに書いたロジックを一般化したもの）。
//
// 出典・ライセンス:
//   - 地震情報: 気象庁防災情報XMLデータベース（国立情報学研究所 CPS-IIP, Asanobu KITAMOTO）
//     https://agora.ex.nii.ac.jp/cps/weather/report/ 、CC BY 4.0
//   - EEW: 気象庁ホームページ（緊急地震速報（警報）発表状況）。政府標準利用規約（第1.0版）
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { buildEewSection, buildQuakeAndTsunamiSection, finalizeArchive, type EewEventSpec } from './localEarthquakeArchiveBuilder'

const { window: jsdomWindow } = new JSDOM('')
globalThis.DOMParser = jsdomWindow.DOMParser as unknown as typeof DOMParser

const { parseEarthquakeFromXml, parseTsunamiFromXml } = await import('../src/services/dmdataParser')

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', '2016-tottori.json')
const INDEX_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', 'index.json')

const EEW_BASE = 'https://www.data.jma.go.jp/eew/data/nc/pub_hist/2016/10'

/** 気象庁の発表状況ページで確認済みの、この地震活動で緊急地震速報（警報）が発表された2件（本震+同日の余震）。 */
const EEW_EVENTS: EewEventSpec[] = [
  { idPrefix: '2016tottori-mainshock', dir: '20161021140724' },
  { idPrefix: '2016tottori-as01', dir: '20161021145318' },
]

// 震央地名（気象庁震度データベースで確認済み）。
const HYPOCENTER_NAMES = new Set(['鳥取県中部'])
// 震度速報は震源未確定のため観測地域名で判定する（Kumamoto方式と同じ）。
const AREA_PREFIXES = ['鳥取県中部']

// 警報級の余震は本震当日の1件のみで津波も無いため、本震当日＋翌々日（訂正報・改定報の余地）
// までを取得する。
const DATES = ['20161021', '20161022']
const WINDOW_START = new Date('2016-10-21T00:00:00+09:00')
const WINDOW_END = new Date('2016-10-23T00:00:00+09:00')

async function main() {
  console.log('EEW（本震・同日の余震1件）を取得中...')
  const eewEntries = await buildEewSection(EEW_BASE, EEW_EVENTS)

  console.log('地震情報（NIIアーカイブの実電文）を取得中...')
  const quakeTsunamiEntries = await buildQuakeAndTsunamiSection({
    dates: DATES,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    hypocenterNames: HYPOCENTER_NAMES,
    areaPrefixes: AREA_PREFIXES,
    parseEarthquakeFromXml,
    parseTsunamiFromXml,
  })

  await finalizeArchive({
    id: '2016-tottori',
    label: '2016年鳥取県中部地震',
    description:
      '2016年10月21日14時7分頃、鳥取県中部を震源とするM6.6の地震が発生。倉吉市・湯梨浜町・北栄町で震度6弱を観測した（鳥取県中部地震）。',
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    entries: [...eewEntries, ...quakeTsunamiEntries],
    outPath: OUT_PATH,
    indexPath: INDEX_PATH,
    hypocenterNames: HYPOCENTER_NAMES,
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
