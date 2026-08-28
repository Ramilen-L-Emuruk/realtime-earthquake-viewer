// 2018年北海道胆振東部地震のローカル履歴アーカイブ（public/data/historical-archives/2018-iburi.json）を
// 一次資料から機械的に生成する。
//
//   npx tsx scripts/build-historical-archive-2018-iburi.ts
//
// 気象庁防災情報XMLフォーマットの運用開始（2011年5月12日）より後の地震のため、当時配信された
// 本物のXML電文が国立情報学研究所（NII）CPS-IIPプロジェクト「気象庁防災情報XMLデータベース」に
// 残っている。地震情報はそこから取得した生XMLをアプリ本番と同じパーサー
// （src/services/dmdataParser.ts の parseEarthquakeFromXml）にそのまま通す。津波警報・注意報の
// 発表は無い（内陸直下型）。
//
// 緊急地震速報（VXSE43/45）はNIIアーカイブに1件も収録されていないため、気象庁の発表状況
// ページ（pub_hist）から取得する。
//
// **他の2地震（熊本・鳥取）と違い、警報級の余震が5ヶ月以上にわたって散発している**
// （本震2018/9/6・同日余震・約1ヶ月後の余震2018/10/5・約5ヶ月半後の余震2019/2/21。
// 気象庁の発表状況一覧ページで確認済み。震度6弱以上の再委任は無いが、いずれも同じ
// 「胆振地方中東部」を震央とする一連の地震活動として扱う）。この間を連続した日付範囲で
// 全て取得すると、無関係な全国の電文まで169日分読み込むことになり、NIIサイトへの負荷・
// 実行時間の両面で非現実的。そのため DATES は実際にEEWが出た日の前後だけを指定する
// （間の期間は取得しない＝データが存在しないのではなく、意図的に取得対象から外している）。
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
const OUT_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', '2018-iburi.json')
const INDEX_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', 'index.json')

// 年月をまたぐため、Kumamoto/Osaka/Tottoriと違いEEW_BASEに年月を含めず、
// dirの側に年/月/ディレクトリ名のフルパスを持たせる。
const EEW_BASE = 'https://www.data.jma.go.jp/eew/data/nc/pub_hist'

/** 気象庁の発表状況ページで確認済みの、この地震活動で緊急地震速報（警報）が発表された4件。 */
const EEW_EVENTS: EewEventSpec[] = [
  { idPrefix: '2018iburi-mainshock', dir: '2018/09/20180906030805' },
  { idPrefix: '2018iburi-as01', dir: '2018/09/20180906061139' },
  { idPrefix: '2018iburi-as02', dir: '2018/10/20181005085853' },
  { idPrefix: '2018iburi-as03', dir: '2019/02/20190221212246' },
]

// 震央地名（気象庁震度データベースで確認済み）。
const HYPOCENTER_NAMES = new Set(['胆振地方中東部'])
// 震度速報は震源未確定のため観測地域名で判定する（Kumamoto方式と同じ）。
// 「胆振」は胆振地方中東部・西部・東部を広くカバーする。他の3アーカイブと違い、この
// アーカイブではDATESが疎（下記）なため、時刻ウィンドウは実質的に「この6日間なら
// 全部通す」以上の絞り込みを提供しない（DATES自体が既に日付を強く絞っているので、
// 二重の安全網にはなっていない）。この6日間に胆振地方西部・東部の無関係な地震が
// 発表されていれば誤って取り込む余地が残るが、finalizeArchive()の震央地名事後検証
// （HYPOCENTER_NAMES以外の地震情報が混ざっていたら例外）で、震央地名を持つ電文に
// 限っては検出できる。震度速報（震央地名を持たない）はこの事後検証をすり抜けうる。
const AREA_PREFIXES = ['胆振']

// 実際にEEWが出た4件それぞれの前後1〜2日のみを取得する（上記コメント参照。169日分の
// 連続取得は非現実的）。
const DATES = ['20180906', '20180907', '20181005', '20181006', '20190221', '20190222']
const WINDOW_START = new Date('2018-09-06T00:00:00+09:00')
// DATES最終日（20190222）の翌日0時にする（他3スクリプトと同じ規約）。20190222当日の
// 00:00にすると、その日に取得した候補は全て itemTime > windowEnd になり、その日ぶんの
// フェッチが丸ごと無駄になった上で無警告に「期間外」扱いされる（レビューで検出した実バグ）。
const WINDOW_END = new Date('2019-02-23T00:00:00+09:00')

async function main() {
  console.log('EEW（本震+散発する余震3件）を取得中...')
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
    id: '2018-iburi',
    label: '2018年北海道胆振東部地震',
    description:
      '2018年9月6日3時8分頃、胆振地方中東部を震源とするM6.7の地震が発生。厚真町で震度7を観測した（北海道胆振東部地震）。',
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
