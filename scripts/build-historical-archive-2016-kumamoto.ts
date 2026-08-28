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
// 二次配信の契約上の制限によるものと見られる）。EEWだけは気象庁の発表状況ページ（pub_hist）
// から取得する。
//
// 地震活動ごとに変わらない処理（NII時刻のパース・電文種別の解釈・取消電文の扱い・
// 集計の整合性チェック等）は localEarthquakeArchiveBuilder.ts に共通化している。
//
// 出典・ライセンス:
//   - 地震情報・津波: 気象庁防災情報XMLデータベース（国立情報学研究所 CPS-IIP, Asanobu KITAMOTO）
//     https://agora.ex.nii.ac.jp/cps/weather/report/ 、CC BY 4.0
//   - EEW: 気象庁ホームページ（緊急地震速報（警報）発表状況）。政府標準利用規約（第1.0版）
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { buildEewSection, buildQuakeAndTsunamiSection, finalizeArchive, type EewEventSpec } from './localEarthquakeArchiveBuilder'

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
const EEW_EVENTS: EewEventSpec[] = [
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

// この地震活動の震央地名（本震・前震・誘発地震が使う名前。EEWの一覧で確認済み）。
// 震度速報等は全国の地震を対象に発表されるため、無関係な地震の電文を取り込まないよう
// 震央地名で絞り込む。
const HYPOCENTER_NAMES = new Set(['熊本県熊本地方', '熊本県阿蘇地方', '熊本県天草・芦北地方', '大分県中部', '大分県西部', '熊本県球磨地方'])

// 震度速報（VXSE51）は震源が未確定の段階で発表されるため震央地名を持たない。
// KUMAMOTO_HYPOCENTER_NAMES（震央地名の完全一致）より意図的に粗い前方一致にしている
// （震度速報は一次細分区域名を返すため、県名・地方名レベルでしか震央と対応が取れない）。
// この粒度の非対称自体は許容するが、時刻ウィンドウ（WINDOW_START/END）と併用することで
// 誤って別の地震を拾わないよう二重に絞る設計にしている。
const AREA_PREFIXES = ['熊本', '阿蘇', '大分県中部', '大分県西部']

// EEW対象19件（前震4/14 21:26 〜 誘発地震4/19 17:52）を漏れなく含むよう、収録範囲を
// 最後のイベントの翌日0時（JST）まで確保する。地震情報・津波もこの範囲に合わせて取得する
// （収録範囲より後に発生したEEWが再生不能になる事故が過去レビューで発覚したため、
// EEW_EVENTSの実際の日付レンジとDATES/WINDOW_ENDを必ず連動させること）。
const DATES = ['20160414', '20160415', '20160416', '20160417', '20160418', '20160419']
const WINDOW_START = new Date('2016-04-14T12:00:00+09:00')
const WINDOW_END = new Date('2016-04-20T00:00:00+09:00')

async function main() {
  console.log('EEW（前震・本震・誘発地震19件）を取得中...')
  const eewEntries = await buildEewSection(EEW_BASE, EEW_EVENTS)

  console.log('地震情報・津波（NIIアーカイブの実電文）を取得中...')
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
    id: '2016-kumamoto',
    label: '2016年熊本地震',
    description:
      '2016年4月14日21時26分頃、熊本県熊本地方を震源とするM6.5の地震（前震）が発生。同16日1時25分頃には同地方でM7.3の地震（本震）が発生し、いずれも熊本県益城町で震度7を観測した（熊本地震）。',
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
