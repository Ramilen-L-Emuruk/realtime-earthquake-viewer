// DMDATA.JP の formatMode:"json" 電文を内部型に変換する。
// 各 parse* 関数は null を返すことがある（必須フィールド欠損時）。

import type {
  JMAQuake,
  JMAQuakeCity,
  JMATsunami,
  JMALpgm,
  JMANankai,
  JMANankaiCommentary,
  JMAKohatsu,
  JMAQuakeNotice,
  JMAEarthquakeCount,
  JMAEarthquakeCountItem,
  EEWAccuracy,
  EEWAlert,
  EEWForecastChange,
  EEWRegion,
  IntensityScale,
  DomesticTsunami,
  IssueType,
  CorrectType,
  TsunamiArea,
  TsunamiGrade,
  LpgmClass,
  TelegramOperationStatus,
} from '../types/earthquake'
import { isValidLpgmClass } from '../utils/lpgm'
import { isEewForecastKindCode, isEewWarningKindCode, isEewArrivedKindCode } from '../utils/eewKind'
import { parseTsunamiEstimationCondition, parseTsunamiForecastHeightImportant, parseTsunamiObservationCondition } from '../utils/tsunami'
import { createPerLabelLogGate, log, UNREADABLE_VALUE_LOG_KINDS, UNREADABLE_VALUE_LOG_INTERVAL_MS } from '../utils/logger'
import { NON_JMA_MARK } from '../utils/formatters'
import { arr, obj, str } from './parseHelpers'

// EEW: "1","2","3","4","5-","5+","6-","6+","7","不明" 等
// 地震情報: "1","2","3","4","5弱","5強","6弱","6強","7","不明" 等
//
// `"over"` は**震度7ではない**。「上限を定めない（下限以上）」を表す値なので、ここでは
// 階級に写さず -1（不明）を返し、範囲として読む parseForecastInt() 側で下限に寄せる。
function parseIntensityStr(s: string | undefined | null): IntensityScale {
  if (!s) return -1
  const map: Record<string, IntensityScale> = {
    '1': 10, '2': 20, '3': 30, '4': 40,
    '5-': 45, '5弱': 45,
    '5+': 50, '5強': 50,
    '6-': 55, '6弱': 55,
    '6+': 60, '6強': 60,
    '7': 70,
  }
  return map[s] ?? -1
}

/**
 * 「震度5弱以上と推定されるが、観測値が入電していない」を表す気象庁の表記。
 *
 * 揺れの強い地域ほど観測点からの通信が途絶えやすく、**最も震度が高いはずの観測点が
 * この値で届く**。階級として読めないからと捨てると、大地震のときにその地点が画面から消える。
 *
 * **値は実電文から採っている。** 令和6年能登半島地震（2024-01-01 16:16 発表の震源・震度情報）に
 * 次の形で現れる —— 数字は**全角**。
 *
 *     <IntensityStation><Name>輪島市門前町走出＊</Name><Code>1720431</Code>
 *       <Int>震度５弱以上未入電</Int></IntensityStation>
 *
 * 短縮形（`!5-` 等）で書かない。2024-01-01〜06 の全電文 853 通を走査したが、この文字列以外の
 * 表記は 1 度も現れなかった。**推測で書くとテストが通っても実電文で 1 件も拾えない**
 * （実際にそうなっていた）。
 *
 * 気象庁の電文解説資料（地震火山関連）によれば、この語が入るのは `IntensityStation/Int` の
 * ほかに `City/Condition` と見出し部（`Information/Item/Kind/Name`）がある。
 *
 * - **`City/Condition` は読む**（下記 `City` の分岐）。同じ市町村の観測点にも未入電が並ぶが、
 *   市町村の行の意味は `MaxInt` の有無で 2 通りに分かれ、観測点からは復元できない
 * - **見出し部は読まない** —— 未入電の市町村を列挙するだけで、`City/Condition` と同じ事実になる
 */
const UNRECEIVED_INTENSITY = '震度５弱以上未入電'

/**
 * 震度の文字列を、階級と「未入電かどうか」に分けて読む。
 *
 * **未入電を階級表へ入れない。** 階級値は観測された震度を表すもので、そこへ混ぜると
 * 「5弱を観測した」と区別できなくなる。下限（5弱）へ寄せ、未入電であることは別に持つ
 * —— 上限を定めない予想震度を下限へ寄せて「以上」をフラグで持つのと同じ扱い。
 */
function readIntensity(s: string | null): { scale: IntensityScale; unreceived: boolean } {
  if (s === UNRECEIVED_INTENSITY) return { scale: 45, unreceived: true }
  if (s && s.includes('未入電')) unknownUnreceivedValues.add(s)
  return { scale: parseIntensityStr(s), unreceived: false }
}

/**
 * 「未入電」を含むのに解釈できなかった震度の値。
 *
 * **基準は将来変わりうる。** 電文解説資料は「当面は震度５弱を基準とし」と断っており、
 * 「震度６弱以上未入電」のような表記が現れる余地がある。**表記を推測して先回りしない**
 * —— どう書かれるかの定めが無いまま実装すると、また実物と食い違う（`!5-` で実際に起きた）。
 *
 * 読めないままでよいが、**黙って落とさない**。未入電は最も震度が高いはずの地点に付く値で、
 * 1 件消えるだけでも重い。全滅を待つ `ReadTally` と違い、**1 件でも記録する**。
 */
const unknownUnreceivedValues = new Set<string>()

/** 上の記録を 1 電文につき 1 行にまとめて出し、次の電文のために空にする。 */
function flushUnknownUnreceived(logPrefix: string): void {
  if (unknownUnreceivedValues.size === 0) return
  const values = [...unknownUnreceivedValues].map(v => `"${v}"`).join('・')
  log.error(`${logPrefix} 未入電を表す未知の震度表記のため、その地点を読めませんでした（画面と読み上げから落ちます）: ${values}`)
  unknownUnreceivedValues.clear()
}

/** 上限を定めない予想震度を表す DMDATA の値。P2PQuake の `scaleTo: 99` と同じ意味。 */
const DMDATA_INTENSITY_OVER = 'over'

/**
 * 区域が警報の対象であることを表す Kind 名。
 *
 * **判定の本筋は `Category/Kind/Code`**（→ `isEewWarningKindCode`）。この名前は、
 * コード表に無い値が来たときに警報を取りこぼさないための控え。
 */
const EEW_WARNING_KIND_NAME = '緊急地震速報（警報）'

/**
 * 区域について主要動が既に到達したと推測されることを表す `Area/Condition` の値。
 *
 * **資料が値域をこの 1 つに定めている**（電文解説資料 Ⅱ.21 2-1-5-3-7。「値：“既に主要動到達と
 * 推測”」）。到達予測時刻（`ArrivalTime`）とは排他で、どちらか一方しか出ない。
 */
const EEW_AREA_ARRIVED_CONDITION = '既に主要動到達と推測'

/**
 * EEW の予想震度の範囲（`{ from, to }`）を、階級 1 つと「以上」フラグに畳む。
 *
 * `to: "over"` は上限を定めない表現（例: `from: "4", to: "over"` = 「震度4以上」）。
 * これを震度7と読むと、仮定震源要素の初報のように下限しか決まっていない報が
 * 最大震度7として塗られ・読み上げられる。上限には下限側の値を採り、「以上」は
 * フラグで持ち越して表示・読み上げで語を補う（P2PQuake の `scaleTo: 99` と同じ扱い）。
 */
function parseForecastInt(range: Record<string, unknown>): { scale: IntensityScale; orAbove: boolean } {
  const fromStr = str(range.from)
  const toStr = str(range.to)
  if (toStr === DMDATA_INTENSITY_OVER) {
    const from = parseIntensityStr(fromStr)
    // 下限が読めなければ「以上」も意味を成さない（「不明以上」を作らない）。
    return { scale: from, orAbove: from > 0 }
  }
  // over 以外は従来どおり「to があれば to・空なら from」。**`"不明"` のような読めない値でも
  // to があれば to を採る**（不明のまま返す）。ここで from へ落とすと、上限が不明な報の震度が
  // 下限の値で出るようになり、over 以外の挙動を静かに変えてしまう。
  return { scale: parseIntensityStr(toStr || fromStr), orAbove: false }
}

/**
 * 長周期地震動階級の予測（`ForecastLgInt`）を読む。**震度側と同じく `over` を扱う。**
 *
 * 電文解説資料（Ⅱ.21 2-1-3-2）が定める値域:
 *
 * > （1 回，値："0"/"1"/"2"/"3"/"4"/"over"/"不明"） 最大予測長周期地震動階級の上限を示す。
 * > 0 ：長周期地震動階級 1 未満 …… 4 ：長周期地震動階級 4　over:～程度以上　不明：不明時
 * > 事例１（最大予測長周期地震動階級が階級 3 程度以上の場合（「程度以上」の表現））
 * >   `<ForecastLgInt><From>3</From><To>over</To></ForecastLgInt>`
 *
 * **`parseInt("over")` は `NaN` になる。** そのまま階級として扱っていたため、
 * 気象庁が「階級3程度以上」と発表した報では**長周期の予測が丸ごと消えていた**
 * （震度側は対応済みだったのに長周期側だけ抜けていた）。上限には下限側の値を採り、
 * 「程度以上」はフラグで持ち越して表示・読み上げで語を補う。
 */
function parseForecastLgInt(range: Record<string, unknown>): { cls: LpgmClass | undefined; over: boolean } {
  const fromStr = str(range.from)
  const toStr = str(range.to)
  const pick = (v: string): LpgmClass | undefined => {
    const n = parseInt(v, 10)
    return isValidLpgmClass(n) ? n : undefined
  }
  if (toStr === DMDATA_INTENSITY_OVER) {
    const from = pick(fromStr)
    // 下限が読めなければ「程度以上」も意味を成さない（「不明程度以上」を作らない）。
    return { cls: from, over: from !== undefined }
  }
  // over 以外は従来どおり「to があれば to・空なら from」。
  return { cls: pick(toStr || fromStr), over: false }
}

const VXSE_ISSUE_TYPE: Record<string, IssueType> = {
  VXSE51: '震度速報',
  VXSE52: '震源情報',
  VXSE53: '震源・震度情報',
  VXSE61: '顕著な地震の震源要素更新のお知らせ',
}

// 記録に付ける印。同じ「読めなかった」でも、地震・長周期の電文と津波の電文では次に見る場所が
// 違うため分けている。**電文の読み取りは XML 経路 1 本**なので、経路の別は印に含めない。
const DMDATA_LOG_PREFIX = '[dmdata XML]'
const TSUNAMI_LOG_PREFIX = '[tsunami XML]'

/**
 * 電文を丸ごと捨てたことを記録し `null` を返す。
 *
 * **点が 1 種類消えるより被害が大きい。** カード自体が画面に出ないのに、素の `return null` は
 * 理由を何も残さない。呼び出し側で `return dropTelegram(...)` と書けるよう `null` を返す。
 *
 * **正常な振り分けには使わないこと。** ここへ来てよいのは「読めるはずのものが読めなかった」
 * 場合だけで、電文の種別を見分けて呼び出し側へ返す早期 return（南海トラフの臨時情報と解説情報の
 * 振り分け・長周期地震動で階級1以上を観測していない報）は対象外。混ぜると平常時に鳴り続ける。
 */
function dropTelegram(logPrefix: string, reason: string): null {
  log.warn(`${logPrefix} 電文を読み取れなかったため捨てました: ${reason}`)
  return null
}

/**
 * 電文の XML を DOM へ起こす。読めなければ記録して `null` を返す。
 *
 * `DOMParser` は不正な XML でも例外を投げず `parsererror` 要素を持つ文書を返すため、両方を見る。
 * **6 つの XML パーサで同じ手順を書き写していた**ので 1 箇所へ寄せた（片方の判定だけ足す・
 * 記録を片方にだけ入れる、といったずれが起きる形だった）。
 */
function parseTelegramXml(xml: string, logPrefix: string): Document | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
  } catch (e) {
    return dropTelegram(logPrefix, `XML の解析で例外が出ました: ${String(e)}`)
  }
  if (doc.querySelector('parsererror')) {
    return dropTelegram(logPrefix, 'XML として読めません（parsererror）')
  }
  return doc
}

// 電文の要素を「読めたか」で数えるための入れ物。1 種別（震度の区域・観測点・都道府県、
// 長周期地震動の区域・観測点、津波の観測点…）につき 1 つ作る。
//
// **記録するのはその種別が全滅したときだけで、部分的な脱落では黙る。** 階級表に無い値を持つ
// 要素が 1 点混じるのは正常運転で起こりうるため、1 件ずつ鳴らすとログが埋まって本当の全滅が
// 埋もれる。「元要素はあるのに 1 件も使える値が無い」ときだけ出す形は、震度の面が採っている
// 判定と同じ（→ docs/spec/map-rendering-spec.md §17）。
//
// **読めなかった値そのものを見本に載せる。** 件数だけだと、次に鳴ったとき電文を掘り直すことに
// なる。気象庁が新しい表記を出したときは、その文字列がログに名前で出る。
interface ReadTally {
  /** 読めた要素を 1 件数える */
  readable(): void
  /** 読めなかった要素を数え、見本を控える */
  unreadable(name: string, rawValue: string): void
  /** 全滅していれば記録する。1 件でも読めていれば、または読めなかった要素が 0 件なら何もしない */
  warnIfNoneReadable(logPrefix: string): void
}

// **「読めた」と「積んだ」は同じではない。** 震度点は積む条件（`name && scale >= 0`）が
// そのまま読めたかどうかなので一致するが、長周期地震動は「階級 0 ＝該当なし」を読めたうえで
// 積まない。**0 を読めなかった扱いにすると平常時に鳴り続ける**ので、数えるのは
// 「値として解釈できたか」であって「結果に残ったか」ではない。

/** 警告文に載せる見本の上限。全滅した電文の 1 行で読み切れる程度に留める。 */
const READ_TALLY_SAMPLE_LIMIT = 3

function createReadTally(kindLabel: string): ReadTally {
  let readableCount = 0
  let unreadableCount = 0
  const samples: string[] = []
  return {
    readable: () => { readableCount++ },
    unreadable: (name, rawValue) => {
      unreadableCount++
      if (samples.length < READ_TALLY_SAMPLE_LIMIT) {
        // 名前が空の要素もここへ来る（積む条件は「名前がある」と「値が読める」を畳んでいる）。
        // どちらが欠けたのか読めるよう、空でも印を残す。
        samples.push(`${name || '(名前なし)'}="${rawValue}"`)
      }
    },
    warnIfNoneReadable: (logPrefix) => {
      if (unreadableCount === 0 || readableCount > 0) return
      const more = unreadableCount > samples.length ? ' ほか' : ''
      log.warn(`${logPrefix} ${kindLabel}が ${unreadableCount} 件ありますが 1 件も読めませんでした（読めなかった値: ${samples.join('・')}${more}）`)
    },
  }
}

// 長周期地震動観測情報が階級1以上を伝えているのに、その階級を持つ区域が 1 件も無い場合を記録する。
//
// ここまで来た電文は `maxClass` が 1〜4 に収まっている（0 は「階級1以上を観測していない」報として
// 手前で `null` を返す）。**電文が最大階級を名乗っている以上、その値を持つ区域が必ずある**はずで、
// 0 件なら区域を読めていない。種別ごとの検知（`ReadTally`）は「元要素はあるのに読めなかった」しか
// 拾えないため、`Pref`/`Area` の位置が変わって元要素ごと見えなくなった場合はこちらで拾う。
function warnIfNoLpgmRegions(maxClass: number, regionCount: number, logPrefix: string): void {
  if (regionCount > 0) return
  log.warn(`${logPrefix} VXSE62 は最大長周期地震動階級 ${maxClass} を伝えていますが、階級を持つ区域を 1 件も取り出せませんでした`)
}

// 震度を伝える電文（VXSE51/53）なのに点を 1 件も取り出せなかった場合を記録する。
//
// 種別ごとの全滅検知（`IntensityDropTally`）は「元要素はあるのに読めなかった」を捕まえるが、
// **元要素そのものが見えなくなった場合**（`Observation` の位置が変わった・要素名が改名された・
// セレクタが壊れた）は数える対象が 0 件になるため素通りする。そこだけをこちらで拾う。
//
// **「震度を伝える電文か」の判定は `headType` で行う。** 点を取り出すかどうかを決めている
// `parseEarthquakeFromXml` の条件（`headType === 'VXSE53' || headType === 'VXSE51'`）をそのまま持って
// きている。`issueType` で言い換えると、同じ事実を別々に導いた 2 つの判定ができて、いずれ
// ずれる ―― `resolveIssueType` は**未知の headType を `'震源・震度情報'` へ落とす**ので、
// 点を作らない電文が「震度を伝える電文」に見える。
//
// 遠地地震だけは `issueType` で除く。VXSE53 として配信され `Head/Title` でしか見分けられず、
// 国内の震度を持たないのが正常なため。
//
// **この除外だけで足りることを実電文で確かめてある。** 解説資料は「国内で震度が観測されない
// 場合、本要素（Intensity）は出現しない」と書いており、国内の電文でも震度が無い形がありうる
// ように読める。DMDATA のアーカイブ 20 か月分（2025-01〜2026-09）を数えたところ、
// `Intensity` を持たない VXSE51/VXSE53 は 58 通あって**その全部が遠地地震**、国内の
// VXSE53 6,169 通は 1 通残らず震度を持っていた。偽陽性は 0 件。
function warnIfNoIntensityPoints(
  headType: string,
  issueType: IssueType,
  points: JMAQuake['points'],
  logPrefix: string,
): void {
  if (headType !== 'VXSE51' && headType !== 'VXSE53') return
  if (issueType === '遠地地震') return
  if (points.length > 0) return
  log.warn(`${logPrefix} ${headType} は震度を伝える電文ですが、震度の点を 1 件も取り出せませんでした`)
}

// 電文は津波情報区分を 1 つの要素では持たない。固定付加文のコード
//（気象庁防災情報XML 固定付加文コード表）から導出する。
// 0211: 津波警報等（大津波警報・津波警報あるいは津波注意報）を発表中
// 0212: 日本の沿岸では若干の海面変動、被害の心配なし
// 0213: 海面変動継続、海水浴や磯釣り等注意
// 0214: 海面変動継続、磯釣り等注意
// 0215: この地震による津波の心配はない
// 0216: 震源が海底の場合、津波が発生するおそれあり（調査中）
// 0217: 今後の情報に注意（調査中）
// 0229: 日本への津波の有無については調査中（遠地地震で使われる）
// 0230: この地震による日本への津波の影響はない（遠地地震で使われる）
//
// 遠地地震は上記に加えて 022x 系（0221「太平洋の広域に津波発生の可能性」・0222「太平洋で
// 津波発生の可能性」・0226「震源の近傍で津波発生の可能性」・0228「一般的に、この規模の地震が
// 海域の浅い領域で発生すると津波が発生することがある」）を併用する。これらは震源周辺・太平洋側の
// 状況や一般論を述べるもので日本国内への影響区分ではないため、domesticTsunami には反映しない
// （付加文の原文は forecastText に保持し、読み上げ側で使う）。
function parseDomesticTsunamiFromComments(comments: Record<string, unknown>): DomesticTsunami {
  const codes = arr(obj(comments.forecast).codes)
  for (const code of codes) {
    if (code === '0211') return '警報等'
    if (code === '0212') return '若干の海面変動'
    if (code === '0213') return '若干の海面変動'
    if (code === '0214') return '若干の海面変動'
    if (code === '0215') return 'なし'
    if (code === '0216') return '海面変動の可能性'
    if (code === '0217') return '調査中'
    if (code === '0229') return '調査中'
    if (code === '0230') return 'なし'
  }
  // 022x 系（震源近傍・太平洋側で津波発生の可能性・規模による一般論）は日本国内への影響区分では
  // ないため、単独で来ても正常。警告は**既知のコードを取り除いて残ったもの**に絞る
  // （正常系で鳴らすと、電文構造が本当に変わったときの検知価値が下がる）。
  //
  // 「1 つでも既知なら黙る」形にしないこと。022x 系は遠地地震で頻出するため、新しいコードが
  // それと同居した電文で構造の変化を丸ごと見逃す。
  const knownNonDomesticCodes = new Set(['0221', '0222', '0226', '0228'])
  const unknownCodes = codes.map(String).filter(code => !knownNonDomesticCodes.has(code))
  if (unknownCodes.length > 0) {
    log.warn(`[dmdata] 付加文コードから津波区分を導出できません: ${unknownCodes.join(' ')} → 不明`)
  }
  return '不明'
}

// 気象庁の固定付加文（複数行）を1行に整形する。各行は句点で終わるため連結で文が繋がる。
// 例: "震源の近傍で津波発生の可能性があります。\nこの地震による日本への津波の影響はありません。"
//   → "震源の近傍で津波発生の可能性があります。この地震による日本への津波の影響はありません。"
function normalizeForecastText(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('')
}

// 付加文の原文を取り出す。コードは届いているのに原文が空という状態は電文構造の変化を示す。
// この場合 TTS は区分由来の文へ静かに退行し、022x/023x 系の前置き（「震源の近傍で津波発生の
// 可能性があります」等）が落ちたまま一見自然な文が読み上げられるため、警告を残して検知可能にする。
/** 震源要素の訂正を表す固定付加文のコード（電文解説資料 Ⅱ.33 4-2 の事例２）。 */
const CORRECT_HYPOCENTER_CODE = '0256'

/**
 * 訂正報（`Head/InfoType` = 訂正）が何を訂正したのかを、固定付加文（その他）から読む。
 *
 * 気象庁は訂正の中身を `VarComment/Code` に載せる。**現行のコード表で訂正を表すのは
 * `0256`「震源要素を訂正します。」1 つだけ**で、震度だけの訂正に当たるコードは無い
 * （`AdditionalCommentEarthquake` コード表）。そのため区別できるのは「震源を訂正」と
 * 「（内容の判らない）訂正」の 2 つで、P2PQuake 経路が持つ 5 値とは揃わない。
 *
 * `VarComment` を持たない訂正報・コードを読めなかった訂正報は `'訂正'` のまま返す。
 * 訂正であること自体は `InfoType` が確定させているので、ここで落としてはならない。
 */
function resolveCorrectType(doc: Document): CorrectType {
  const varCommentEl = xmlQ(doc, 'VarComment')
  if (!varCommentEl) return '訂正'
  // 複数の固定付加文は 1 つの Code へ空白区切りで併記される（同資料）。兄弟要素へ分かれた
  // 場合も取りこぼさないよう、ForecastComment 側と同じ集め方をする。
  const codes = xmlAll(varCommentEl, 'Code').flatMap(el => xmlText(el).split(/\s+/)).filter(Boolean)
  return codes.includes(CORRECT_HYPOCENTER_CODE) ? '震源を訂正' : '訂正'
}

/**
 * 付加文の原文を読み、**コードはあるのに原文が無い**電文を記録する。
 *
 * 気象庁は付加文をコードと原文の対で送る。原文だけが欠けると、その注意書きが画面から
 * 黙って消える（コードから文面を組み直す仕組みは持っていない）。地震情報の固定付加文には
 * 同じ検査が入っていた（→ `extractForecastText`）ので、原文を画面に出している他の経路へも
 * 揃える。
 *
 * **未知コードは記録しない。** これらの経路は原文をそのまま出しており、コードで分岐して
 * いないため、知らないコードが来ても表示は壊れない。鳴らすと正常系が警告で埋まるだけになる
 * （コードで分岐している地震情報の津波区分だけが、未知コードを記録する意味を持つ）。
 *
 * @param commentEl `WarningComment` / `ForecastComment` / `VarComment` の要素
 * @param label 記録に出す付加文の呼び名
 */
function readCommentText(commentEl: Element | null, label: string, logPrefix: string): string {
  if (!commentEl) return ''
  const text = xmlText(xmlChild(commentEl, 'Text'))
  if (text) return text
  const codes = xmlAll(commentEl, 'Code').flatMap(el => xmlText(el).split(/\s+/)).filter(Boolean)
  if (codes.length > 0) {
    log.warn(`${logPrefix} ${label}のコード(${codes.join(' ')})はありますが原文がありません（画面から落ちます）`)
  }
  return ''
}

function extractForecastText(rawText: string, codes: unknown[]): string {
  const text = normalizeForecastText(rawText)
  if (!text && codes.length > 0) {
    log.warn(`[dmdata] 付加文コード(${codes.join(' ')})はあるが原文を取得できませんでした`)
  }
  return text
}

/**
 * 電文種別コードと `Head/Title` から issue.type を決める。
 *
 * 遠地地震は各地の震度と同じ VXSE53 で配信され、`Head/Title` だけが「遠地地震に関する情報」になる
 * （`Control/Title` は「震源・震度に関する情報」のまま）。通常報・取消報のどちらもこの規則で判定する。
 * 取消報でこの判定を落とすと `'震源・震度情報'` になり、既存カードの `'遠地地震'` と一致しないため、
 * 取消マッチング（`useEarthquakes` の eventId ＋ issue.type 照合）が外れてカードが消えずに残る。
 */
function resolveIssueType(headType: string, title: string): IssueType {
  if (title === '遠地地震に関する情報') return '遠地地震'
  return VXSE_ISSUE_TYPE[headType] ?? '震源・震度情報'
}

// XML ヘルパー: localName で最初の要素を返す
function xmlQ(parent: Element | Document, localName: string): Element | null {
  const els = parent.getElementsByTagName('*')
  for (let i = 0; i < els.length; i++) {
    if (els[i].localName === localName) return els[i]
  }
  return null
}

// XML ヘルパー: localName が一致する子孫要素をすべて返す（xmlQ の複数版）。
function xmlAll(parent: Element | Document, localName: string): Element[] {
  const els = parent.getElementsByTagName('*')
  const result: Element[] = []
  for (let i = 0; i < els.length; i++) {
    if (els[i].localName === localName) result.push(els[i])
  }
  return result
}

// XML ヘルパー: 直下の子要素だけを localName で返す。
// xmlQ は子孫すべてを探すため、Area 直下の MaxInt と City 配下の MaxInt のように
// 同名要素が入れ子になっている箇所では取り違える。階層を特定したいときはこちらを使う。
function xmlChild(parent: Element, localName: string): Element | null {
  const children = parent.children
  for (let i = 0; i < children.length; i++) {
    if (children[i].localName === localName) return children[i]
  }
  return null
}

// 電文の発表元（issue.source）。実電文の Control は EditorialOffice（例「気象庁本庁」）と
// PublishingOffice（例「気象庁」）を併せ持ち、編集官署を先に採る。
//
// Control 直下に限るのは、同名要素が他の位置に現れた電文で取り違えないため。
// どちらも無ければ空文字を返す。
//
// **空の要素は「無い」と同じに扱う。** `||` なので `<EditorialOffice></EditorialOffice>`
// （要素はあるが空）でも PublishingOffice へ落ちる。issue.source は現状どのコンポーネントからも
// 読まれないため実害は無いが、この値を使うコードを足すときは見ておくこと。
function parseIssueSourceFromXml(doc: Document): string {
  const controlEl = xmlQ(doc, 'Control')
  if (!controlEl) return ''
  return xmlText(xmlChild(controlEl, 'EditorialOffice'))
    || xmlText(xmlChild(controlEl, 'PublishingOffice'))
}

function xmlText(el: Element | null): string {
  return el?.textContent?.trim() ?? ''
}

const JST_OFFSET_MS = 9 * 3600_000

/**
 * 発表時刻を読む。`Head/ReportDateTime` が空なら `Control/DateTime` へ落ちる。
 *
 * **落ちた値はタイムゾーン表記を JST へ揃える。** 実電文 135 通では `Head/ReportDateTime` が
 * 常に JST（`+09:00`）、`Control/DateTime` が常に UTC（`Z`）だった。揃えずに落ちると、
 * その電文だけ `2026-08-23T13:47:32Z`、他は `2026-08-23T22:47:00+09:00` という形になる。
 * 地震情報の続報判定（`utils/quakeMerge.ts` の `mergeQuakeInto`）は **`Date` を経由しない
 * 文字列の辞書順**で新旧を比べるため、同じ時刻でも UTC 表記の側が必ず小さくなり、
 * **その報は永久に「古い」と判定されて捨てられる。**
 *
 * 手元のサンプルでは `ReportDateTime` が常に埋まっていて受け皿は一度も通らなかったが、
 * 通ったときに例外もログも出さずに壊れる形なので塞いでおく。
 *
 * **なお `Control/DateTime` は秒値まで有効で、`Head/ReportDateTime` はそれを分へ切り捨てた値**
 * （実電文 135 通のうち 96 通で最大 55 秒ずれ、符号は常に負）。解説資料 Ⅰ.（ⅱ）8 は
 * 「同一種別の情報における最新情報の検索にあたっては `Serial` ではなく `Control/DateTime` を
 * 参照すること」と書いているが、**本実装は秒精度へ上げていない** —— 理由は
 * `docs/spec/quake-spec.md` §6.4。
 *
 * @param kindLabel 記録に出す電文種別の名前。**呼び出し元ごとに違う値を渡すこと** ——
 *   この関数は 9 種別から呼ばれており、固定文字列にすると記録の間引きの枠を全種別で
 *   食い合う（ある種別のノイズで別の種別の異常が黙る。→ `createPerLabelLogGate`）
 * @param logPrefix 記録の接頭辞。**津波だけ `[tsunami XML]`** で、他は `[dmdata XML]`
 *   （→ `docs/spec/data-sources-spec.md` §2「読めなかったものは記録する」）。既定値を
 *   置かないのは、種別を足したときの決め忘れを型検査で捕まえるため
 */
function readReportDateTime(doc: Document, kindLabel: string, logPrefix: string): string {
  const report = xmlText(xmlQ(doc, 'ReportDateTime'))
  if (report) {
    // **主経路は値を捨てず、記録だけ残す。** 下の受け皿と扱いが違うのは意図したもの ——
    // 発表時刻は全種別の骨格で、空にした場合に何が壊れるか（続報の新旧判定・表示・共有
    // カード・読み上げ）を確かめていない。受け皿は元から空へ倒す作りで、そちらは
    // `Head/ReportDateTime` が欠けた電文しか通らないため影響範囲が狭い。
    warnIfUnreadableDateTime(logPrefix, `${kindLabel}の発表時刻`, report, '空にしたときの影響を確かめていない')
    return report
  }
  const control = xmlText(xmlQ(doc, 'DateTime'))
  if (!control) return ''
  // **読めない値をそのまま通さない。** 通すと以降の時刻比較がすべてこの値に引きずられる。
  // 空にすれば `mergeQuakeInto` が「発表時刻が空の電文」として据え置く（安全側）。
  //
  // **時間帯を明示していない値も通さない。** `2026-08-08T18:02:00` のようにオフセットが無いと
  // `Date.parse` は**実行環境のローカル時刻**として解釈する。このアプリは利用者のブラウザで
  // 動くので、同じ電文が端末ごとに違う時刻になり、しかも「読めない」とも判定されない
  // （`Number.isNaN` は素通りする）。実電文は常に `Z` 付きだが、静かにずれる形なので弾く。
  // 判定は `readableDateTimeMs` に集約してある（この 2 段を書き写すと片方だけずれる）。
  const ms = readableDateTimeMs(control)
  if (ms === null) {
    reportUnreadableTelegramDateTime(logPrefix, `${kindLabel}の発表時刻`, control, '空として扱います')
    return ''
  }
  return new Date(ms + JST_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+09:00')
}

/** ISO 8601 の日時が時間帯を明示しているか（末尾が `Z` か `±HH:MM` / `±HHMM`）。 */
const HAS_EXPLICIT_TIMEZONE = /(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * 日時として使えるならミリ秒値、使えなければ `null`。読めることと、時間帯を明示していることの
 * 2 段で見る。
 *
 * 判定と値を 1 回で返すのは、`readReportDateTime` が判定の後にミリ秒値を使うため
 * （別々にすると `Date.parse` を 2 度呼ぶことになる）。
 */
function readableDateTimeMs(raw: string): number | null {
  const ms = Date.parse(raw)
  return Number.isFinite(ms) && HAS_EXPLICIT_TIMEZONE.test(raw) ? ms : null
}

/** 日時として使える値か。値が要らない呼び出し元はこちら。 */
function isReadableDateTime(raw: string): boolean {
  return readableDateTimeMs(raw) !== null
}

/**
 * 読めない日時の記録。**要素の種別ごとに、同じ値では二度鳴らさない。**
 *
 * ここの呼び出しは繰り返しの中にある（津波なら区域・潮位観測点・沖合観測点でそれぞれ）。
 * 上流の日時書式がまとめて変わると、1 通の電文で観測点の数だけ同じ行が並び、**他の警告が
 * 埋もれる**。表示の整形（`formatters.ts`）が同じ理由で間引いているので、濃さを揃える。
 *
 * 種類が上限を超えたあとも時間で間引いて出し続ける（黙らせない理由は `createFirstSeenLogGate`）。
 */
const gateTelegramDateTime = createPerLabelLogGate(UNREADABLE_VALUE_LOG_KINDS, UNREADABLE_VALUE_LOG_INTERVAL_MS)

function reportUnreadableTelegramDateTime(logPrefix: string, label: string, raw: string, disposition: string): void {
  gateTelegramDateTime(`${logPrefix} ${label}`, raw, overflowed => {
    const tail = overflowed
      ? `（読めない値が ${UNREADABLE_VALUE_LOG_KINDS} 種類を超えたため、以後は間引いて記録します）`
      : ''
    log.warn(`${logPrefix} ${label}を日時として読めません（${disposition}）: "${raw}"${tail}`)
  })
}

/**
 * 電文の日時要素を読む。**日時として読めない値・時間帯を明示していない値は捨てて記録する。**
 *
 * `readReportDateTime` / `readObservationDateTime` と同じ厳しさで見る。片方だけ検証すると、
 * 隣り合った 2 つの時刻で守りの強さが食い違う。
 *
 * **時間帯の明示まで確かめるのがこの関数の要**。`2026-01-01T12:00:00` のようにオフセットが
 * 無い値を `Date` は実行環境のローカル時刻として解釈し、**有効な日時を返す** —— 表示側の
 * ガード（`formatters.ts` の `readDateTime`）では原理的に捕まらず、同じ電文が端末ごとに
 * 違う時刻として画面に出る。実電文はすべて `Z` か `+09:00` を持つ。
 *
 * **同一性の判定に使う時刻へは当てない**（下記「捨てずに記録だけ残す」）。空文字へ倒すと、
 * 別々の電文が同じキーを共有して 1 つの地震として束ねられる —— 読めない時刻をキーに残すより
 * 重い事故になる。
 *
 * @returns 読めた値。読めなければ空文字（要素が無いのと同じ扱いへ倒す）
 */
function readTelegramDateTime(logPrefix: string, label: string, raw: string): string {
  if (!raw) return ''
  if (!isReadableDateTime(raw)) {
    reportUnreadableTelegramDateTime(logPrefix, label, raw, '無視します')
    return ''
  }
  return raw
}

/**
 * 日時として読めないことを記録するだけで、値は捨てない。
 *
 * **捨てるほうが害になる時刻に使う。** 残す理由は呼び出し元ごとに違う。
 *
 * - **同一性の判定に使う時刻**（地震情報の `earthquake.time`・津波の `originTime`）。
 *   空文字へ倒すと、識別子を持たない電文どうしが同じキーになって束ねられる
 * - **その電文に必須の要素**（長周期地震動観測情報の `OriginTime`）。捨てると電文ごと
 *   落ちる作りなので、階級の情報まで道連れになる
 * - **落としたときの影響を確かめていない時刻**（全種別の発表時刻。`readReportDateTime` の
 *   主経路）。空にすると続報の新旧判定・表示・共有カード・読み上げのどこが壊れるかを
 *   調べていない
 *
 * **理由を引数で受け取るのは、文面で決めつけないため。** 固定文にすると、長周期の
 * `OriginTime`（同一性の判定には使わない）で「同一性の判定に使うため」と記録され、
 * 次に調べる人を別の場所へ誘導する。
 *
 * 表示・読み上げは `formatters.ts` の `readDateTime` が受け止める（時刻の句ごと落とす）。
 *
 * @param keepReason 値を残す理由。「〜ため値は残します」の形に埋め込む
 */
function warnIfUnreadableDateTime(logPrefix: string, label: string, raw: string, keepReason: string): void {
  if (!raw || isReadableDateTime(raw)) return
  reportUnreadableTelegramDateTime(logPrefix, label, raw, `${keepReason}ため値は残します`)
}

/**
 * 観測状況を確定した時刻（`Head/TargetDateTime`）。**日時として読めない値は捨てる。**
 *
 * **`readReportDateTime` と同じ厳しさで見る。** 片方だけ検証すると、隣り合った 2 つの時刻で
 * 守りの強さが食い違う。
 *
 * 表示側（`TsunamiTab` の `formatTimeMin`）も読めない値を弾くようになったので、守りは二重。
 * それでも入口で捨てるのは、**時間帯を明示していない値は表示側では捕まえられない**ため
 * （`Date` がローカル時刻として解釈し、端末ごとに違う時刻が出る）。
 */
function readObservationDateTime(headEl: Element): string | undefined {
  const raw = xmlText(xmlChild(headEl, 'TargetDateTime'))
  if (!raw) return undefined
  // **時間帯の明示まで確かめる**（`readReportDateTime` と同じガード）。`Date.parse` は
  // オフセットの無い `2026-01-01T12:00:00` を**実行環境のローカル時刻**として解釈し、
  // 有限値を返す —— つまり `Number.isFinite` だけでは素通りする。このアプリは利用者の
  // ブラウザで動くので、同じ電文が端末ごとに違う時刻として画面に出る。
  if (!isReadableDateTime(raw)) {
    reportUnreadableTelegramDateTime(TSUNAMI_LOG_PREFIX, '観測状況を確定した時刻', raw, '無視します')
    return undefined
  }
  return raw
}

// 度分表記（"+4012.6" = 北緯 40 度 12.6 分）を 10 進度へ直す。読めない値は NaN を返す。
//
// 小数第 4 位で丸めるのは、度分を 60 で割った端数を切るため（"40.2100" / "142.3033"）。
// 丸めないと 40.21000000000001 のような値が座標として流れる。
//
// **分が 60 以上の値は捨てる**（例: "+4065.5"）。分として成り立たない値なので、有限性しか
// 見ていない呼び出し元の防御を素通りさせず、ここで NaN にして落とす。
//
// **このガードが守るのはそこまで。** 度単位の座標（"+40.2"）が誤って度分の要素に入っていても
// 「0 度 40.2 分」で分は 60 未満のため、ここは通ってしまう。その取り違えを捕まえているのは
// 下記 `degreeMinuteCoordProblem`（度単位側との突き合わせ）で、**別の防御**。
// 片方を消してもう片方が代わりを務めることはない。
function degreeMinuteToDegrees(v: number): number {
  const sign = v < 0 ? -1 : 1
  const abs = Math.abs(v)
  const deg = Math.floor(abs / 100)
  const min = abs - deg * 100
  if (!(min < 60)) return NaN
  return sign * Math.round((deg + min / 60) * 1e4) / 1e4
}

// JMA XML 座標文字列（例: "+36.3+140.0-70000/"）→ lat/lng/depth(km)
//
// @param degreeMinute 緯度経度が度分表記（"+4012.6+14218.2-44000/"）か。
//   要素の type 属性で判別する（下記 readHypocenterCoord）。桁数から推測しない
//   ——度単位の経度は 3 桁になりうるので、桁だけでは度分と見分けられない。
function parseJmaCoord(s: string, degreeMinute = false): { lat: number; lng: number; depth: number } {
  const m = s.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\//)
  if (!m) return { lat: NaN, lng: NaN, depth: -1 }
  const lat = degreeMinute ? degreeMinuteToDegrees(parseFloat(m[1])) : parseFloat(m[1])
  const lng = degreeMinute ? degreeMinuteToDegrees(parseFloat(m[2])) : parseFloat(m[2])
  // 高さフィールドは負値・メートル単位（海面下）
  const depth = m[3] != null ? Math.abs(parseFloat(m[3])) / 1000 : -1
  return { lat, lng, depth }
}

// 震源の座標を読む。
//
// VXSE61（顕著な地震の震源要素更新のお知らせ）は Coordinate を 2 つ持つ。1 つ目は度単位へ
// 丸めた値で、電文自身が「度単位の震源要素は、津波情報等を引き続き発表する場合に使用されます」
// と用途を断っている。震源要素として採るのは type="震源位置（度分）" のほうで、DMDATA の
// JSON 変換もそちらを 10 進度へ直した値を返す。丸めた側を採ると深さが 4km ずれた実例がある
// （2026-06-25 岩手県沖 M7.2: 度単位 40km ／度分 44km）。
//
// **丸めた側へ落ちたことは必ず記録する。** ずれは有効な座標の形をしていて、画面にも
// 読み上げにも「おかしい」とは出ない。落ちた事実を残さないと、4km のずれが起きていることに
// 誰も気づけない。ただし記録するのは VXSE61 のときだけ——他の種別は Coordinate を元から
// 1 つしか持たず、そこで鳴らすと正常系が警告で埋まる。
// 度分から起こした座標を、度単位の座標と突き合わせて許す差。度単位側は同じ震源を 0.1 度へ
// 丸めた値なので、正しければ差は 0.05 度に収まる。実電文 8 通で測った最大の食い違いは
// 0.048 度で、その約 2 倍を取っている。
const COORD_CROSS_CHECK_TOLERANCE_DEG = 0.1

// 度分から起こした座標が信用できるか。信用できないなら理由を返す（記録の文面に使う）。
//
// **有限性だけでは足りない。** 度単位の値（"+40.2"）が誤って度分の要素に入っていると
// 「0 度 40.2 分」＝ 0.67 度という、有限だがまるで違う座標になる。度単位の座標は同じ震源を
// 丸めたものなので、突き合わせればこの取り違えを捕まえられる。
function degreeMinuteCoordProblem(
  dm: { lat: number; lng: number },
  plain: { lat: number; lng: number },
): string | null {
  if (!Number.isFinite(dm.lat) || !Number.isFinite(dm.lng)) return '座標を読めません'
  // 突き合わせる相手が無い電文（度分しか持たない）は、そのまま採るしかない。
  if (!Number.isFinite(plain.lat) || !Number.isFinite(plain.lng)) return null
  const off = Math.max(Math.abs(dm.lat - plain.lat), Math.abs(dm.lng - plain.lng))
  if (off > COORD_CROSS_CHECK_TOLERANCE_DEG) return `度単位の座標と ${off.toFixed(2)} 度食い違います`
  return null
}

/**
 * 電文の運用種別（`Control/Status`。電文解説資料 Ⅰ.3）を読む。
 *
 * 値域は「通常」「訓練」「試験」。**「通常」では何も返さない** —— 既定の状態なので、
 * 持たせても表示側が毎回それを弾くだけになる。
 *
 * **`test` フラグとは別物。** あちらは「画面・音・地図へ流さない」抑制で、検証用に受信した
 * 試験報はあえて流している（`services/dmdata.ts`）。ここで読むのは電文自身の名乗り。
 */
function parseOperationStatus(doc: Document): TelegramOperationStatus | undefined {
  const raw = xmlText(xmlQ(doc, 'Status'))
  if (raw === '訓練' || raw === '試験') return raw
  if (raw && raw !== '通常') {
    log.warn(`${DMDATA_LOG_PREFIX} 電文の運用種別を読めません（無視します）: "${raw}"`)
  }
  return undefined
}

/**
 * 震源要素が「全要素とも不明」と書かれた電文か。
 *
 * 気象庁は震源を決められないとき、座標を空にして理由を属性へ書く（電文解説資料の例外表現。
 * 津波 VTSE41/51/52・EEW VXSE45・地震 VXSE52/53・長周期 VXSE62 の 7 種別で定義されている）。
 *
 * ```xml
 * <jmx_eb:Coordinate description="震源要素不明" />
 * ```
 *
 * **これを「座標の書式が壊れている」と一緒にしない。** 前者は気象庁が意図して送っている形で、
 * 震源が判らないだけで震度は全国分そろっている。電文ごと捨てると、**最も異常な地震で
 * 全国の震度が丸ごと消える**。後者は電文の書式が変わった疑いなので、従来どおり捨てて記録する。
 *
 * 属性値の空白は落としてから照合する。解説資料の他の事例（「北緯　３９．０度…」）は
 * 全角空白で区切られており、この属性だけ空白が入らないと決めてかかる根拠が無い。
 */
function isUnknownHypocenterCoord(areaEl: Element | null): boolean {
  if (!areaEl) return false
  return xmlAll(areaEl, 'Coordinate').some(el =>
    (el.getAttribute('description') ?? '').replace(/[\s　]/g, '').includes('震源要素不明'))
}

function readHypocenterCoord(areaEl: Element, headType: string): { lat: number; lng: number; depth: number } {
  const els = xmlAll(areaEl, 'Coordinate')
  const dm = els.find(el => (el.getAttribute('type') ?? '').includes('度分'))
  // 度分の要素そのものを度単位として読み直さないよう、退避先は「度分ではないほう」から採る。
  const plain = parseJmaCoord(xmlText(els.find(el => el !== dm) ?? null))
  if (!dm) {
    if (headType === 'VXSE61') {
      log.warn(`[quake XML] ${headType}: 「震源位置（度分）」の座標が見当たらないため、度単位へ丸めた座標を使います`)
    }
    return plain
  }
  const parsed = parseJmaCoord(xmlText(dm), true)
  const problem = degreeMinuteCoordProblem(parsed, plain)
  if (!problem) return parsed
  // 電文ごと捨てると震源要素更新が丸ごと消えるため、丸めた側へ落として記録を残す
  // （退避先が無ければ座標なしのまま返り、呼び出し元の有限性チェックで電文が捨てられる）。
  log.warn(`[quake XML] ${headType}: 「震源位置（度分）」の${problem}。度単位へ丸めた座標を使います: ${xmlText(dm)}`)
  return plain
}

/**
 * 震源の位置要素（`Hypocenter/Area`）のうち、**座標を含まないもの**を読む。
 *
 * **座標と分けてあるのは、読み方が種別で違うから。** 地震情報は VXSE61 が `Coordinate` を
 * 2 つ持ち、度分の側を選び直す必要がある（→ `readHypocenterCoord`）。座標だけがその事情を
 * 抱えていて、震央地名コードと震央補助表現の材料は全種別で同じに読める。
 *
 * **経路ごとに書き分けない。** 同じ `Area` を地震情報・長周期地震動観測情報・津波の 3 つが
 * 読んでおり、足す項目を 1 つの経路にだけ書くと必ず他が遅れる（実績が 2 度ある。津波だけ
 * 震央補助表現の材料が落ちていた件と、地震情報だけ震央補助表現そのものが落ちていた件）。
 */
function readHypocenterAreaLabels(
  areaEl: Element,
): Omit<import('../types/earthquake').HypocenterAreaDetail, 'latitude' | 'longitude' | 'depth'> {
  const code = xmlText(xmlChild(areaEl, 'Code'))
  const nameFromMark = xmlText(xmlChild(areaEl, 'NameFromMark'))
  const detailedCode = xmlText(xmlChild(areaEl, 'DetailedCode'))
  const markCode = xmlText(xmlChild(areaEl, 'MarkCode'))
  const direction = xmlText(xmlChild(areaEl, 'Direction'))
  const distance = parseFloat(xmlText(xmlChild(areaEl, 'Distance')))
  return {
    ...(code && { code }),
    ...(detailedCode && { detailedCode }),
    ...(nameFromMark && { nameFromMark }),
    ...(markCode && { markCode }),
    ...(direction && { direction }),
    ...(Number.isFinite(distance) && { distanceKm: distance }),
  }
}

/**
 * 震源決定機関（`Hypocenter/Source`）。**`Area` の外**にあるので上の読み手には入らない。
 *
 * 遠地地震など、気象庁以外が決めた震源に入る（電文解説資料 Ⅱ.11/33/37 の各 1-3-2・2-3-2）。
 * 地震情報・長周期・津波の 3 経路で共有する。
 */
function readHypocenterSource(hypoEl: Element | null): string {
  return hypoEl ? xmlText(xmlChild(hypoEl, 'Source')) : ''
}

/**
 * 震源の位置要素（`Hypocenter/Area`）から、電文種別をまたいで同じ意味を持つものを読む。
 * 上の `readHypocenterAreaLabels` に座標を足したもの。
 *
 * **地震情報（`parseEarthquakeFromXml`）はここを通らない。** VXSE61 が `Coordinate` を
 * 2 つ持ち、度分の側を選び直す必要があるため（→ `readHypocenterCoord`）。座標以外は
 * 向こうも `readHypocenterAreaLabels` を通る。
 *
 * 座標が読めなかったときは、電文が自分で書いた文字表現（`@description`）を添えて記録する。
 * **数値が落ちたことは画面に出ない** ——「震源が判っていない」と「こちらが読めなかった」が
 * 同じ顔になるため、記録がなければ後から見分けられない。
 */
function readHypocenterAreaDetail(
  areaEl: Element,
  logPrefix: string,
): import('../types/earthquake').HypocenterAreaDetail {
  const coordEl = xmlChild(areaEl, 'Coordinate')
  const { lat, lng, depth } = parseJmaCoord(xmlText(coordEl))
  if (coordEl && !(Number.isFinite(lat) && Number.isFinite(lng))) {
    const desc = coordEl.getAttribute('description')?.trim() ?? ''
    log.warn(`${logPrefix} 震源座標を読めません: "${xmlText(coordEl)}"${desc ? `（電文の表現「${desc}」）` : ''}`)
  }
  return {
    ...readHypocenterAreaLabels(areaEl),
    ...(Number.isFinite(lat) && { latitude: lat }),
    ...(Number.isFinite(lng) && { longitude: lng }),
    // **深さの `-1` は「読めなかった」の目印。** 有限だからと通すと、深さ 1km 未満と
    // 区別が付かない値が入る（`parseJmaCoord` は読めないとき -1 を返す）。
    // `0`（ごく浅い）は有効値なので落とさない。
    ...(depth >= 0 && { depth }),
  }
}

/**
 * 名前を読めなかったものを記録に出すときの表示。**コードだけが手がかりになる**ので、
 * 空欄にせずコードを添える（コードも無ければ、その旨を書く）。
 */
function codeOnlyLabel(code: string): string {
  return code ? `（名称なし・コード ${code}）` : '（名称もコードも読めません）'
}

/**
 * 観測点名の末尾に付く「気象庁以外の観測点」の印（`＊` U+FF0A）を外し、印の有無を返す。
 *
 * 気象庁は自局以外が運用する観測点の名前へこの印を付け、電文の固定付加文でも
 * 「＊印は気象庁以外の震度観測点についての情報です。」（コード `0262`。長周期は `0263`）と
 * 断っている（電文解説資料 Ⅱ.33 4-2 / Ⅱ.37 4-2）。**自治体だけではない**ので、
 * 「自治体の観測点」と言い換えないこと。
 *
 * **外すのは引き当てのため。** 座標表（`station-coords.json`）の鍵に印は入っていない
 * （4560 点すべて）。座標のほかにも印の無い名前を鍵にしている先がいくつもあり、
 * **その一覧はここへ写さない**（単一情報源は
 * {@link import('../types/earthquake').EarthquakePoint.nonJma} が指す仕様書の表）。
 *
 * **印を外すだけで事実を捨てないこと** —— 誰が測った値かは利用者が知ってよい事実なので、
 * 印を外した先で `nonJma` として持ち回り、**表示するときに名前へ戻す**
 * （→ `withNonJmaMark`。{@link import('../types/earthquake').EarthquakePoint.nonJma}）。
 */
function stripNonJmaMark(rawName: string): { name: string; nonJma: boolean } {
  // **印の文字は付け直す側と同じものを使う**（`NON_JMA_MARK`）。ここへ直書きすると、
  // 片方だけ変えたときに剥がせない名前ができ、座標表の鍵に当たらず地図から静かに消える。
  const nonJma = rawName.endsWith(NON_JMA_MARK)
  return { name: nonJma ? rawName.slice(0, -NON_JMA_MARK.length) : rawName, nonJma }
}

/**
 * 津波電文の本文（`Body` 直下の `Text`）。
 *
 * **発表報と取消報で中身が入れ替わるだけの同じ要素。** 発表報では「いつ来ていつまで続くか」、
 * 取消報では取消しの理由が入る（電文解説資料 Ⅱ.11 3）。読み手を分けると、片方だけ扱いを
 * 変えたときに静かにずれる。
 */
function readTsunamiBodyText(doc: Document): string | undefined {
  const bodyEl = xmlQ(doc, 'Body')
  return (bodyEl ? xmlText(xmlChild(bodyEl, 'Text')) : '') || undefined
}

/**
 * 見出し文（`Head/Headline/Text`）。気象庁が電文へ添えた一文の要約。
 *
 * **`Headline` 直下の `Text` だけを狙う。** `Headline` は `Information`（見出しの構造化）を
 * 入れ子に持ちうるので、全文連結にすると区域名まで混ざる。
 *
 * **どの種別でも、本文や既読の要素に無い事実は含まない**（実電文で確かめた。地震情報は
 * 震源と時刻、長周期は階級、緊急地震速報は空、震源要素更新の文中の時刻は `ReportDateTime` と
 * 同じ）。落とさないために読むだけで、画面に出すのは本文が長い南海トラフ・後発地震だけ。
 */
function readHeadlineText(doc: Document): string {
  const headEl = xmlQ(doc, 'Head')
  const headlineEl = headEl ? xmlChild(headEl, 'Headline') : null
  return headlineEl ? xmlText(xmlChild(headlineEl, 'Text')) : ''
}

/**
 * 電文が名乗る情報名（`Head/Title`）。
 *
 * **`Control/Title` とは別物。** あちらは種別の固定名で、津波では末尾に記号が付く
 * （「津波情報a」）。こちらは**その報が何を出しているか**を表し、実電文では次のように動く。
 *
 * | 種別 | `Control/Title`（固定） | `Head/Title`（報ごとに変わる） |
 * |---|---|---|
 * | VTSE41 | 津波警報・注意報・予報a | 津波予報／大津波警報・津波警報・津波注意報 … |
 * | VTSE51 | 津波情報a | 津波観測に関する情報／各地の満潮時刻・津波到達予想時刻に関する情報 |
 * | VXSE53 | 震源・震度に関する情報 | 震源・震度情報／遠地地震に関する情報 |
 *
 * **`Head` 直下に限る。** `Control/Title` を取り違えないため（`parseIssueSourceFromXml` が
 * `Control` 直下に限っているのと同じ理由）。
 *
 * 読み取りをここへ集約するのは、同じ要素を複数の経路が別々に読むと必ず片方が遅れるため。
 */
function readInfoName(doc: Document): string {
  const headEl = xmlQ(doc, 'Head')
  return headEl ? xmlText(xmlChild(headEl, 'Title')) : ''
}

/**
 * 巨大地震に関する情報（南海トラフ・後発地震）が共通して持つ要素を読む。
 *
 * **3 つの電文（VYSE50 / VYSE51・52 / VYSE60）で書き分けない。** 構造が同じなのに
 * 経路ごとに読んでいたため、「解説情報だけが見出し文を読んでいて、臨時情報と後発地震は
 * 読んでいない」という非対称ができていた。→ {@link EarthquakeInfoMeta}
 */
function readEarthquakeInfoMeta(doc: Document): import('../types/earthquake').EarthquakeInfoMeta {
  const summary = readHeadlineText(doc)
  const bodyEl = xmlQ(doc, 'Body')
  const quakeInfoEl = bodyEl ? xmlQ(bodyEl, 'EarthquakeInfo') : null
  // 次回発表予定は `Body` 直下（`EarthquakeInfo` の中ではない）。
  const nextAdvisory = bodyEl ? xmlText(xmlChild(bodyEl, 'NextAdvisory')) : ''
  const appendix = quakeInfoEl ? xmlText(xmlChild(quakeInfoEl, 'Appendix')) : ''
  const infoKind = quakeInfoEl ? xmlText(xmlChild(quakeInfoEl, 'InfoKind')) : ''
  const infoType = quakeInfoEl?.getAttribute('type')?.trim() ?? ''
  return {
    ...(summary && { summary }),
    ...(nextAdvisory && { nextAdvisory }),
    ...(appendix && { appendix }),
    ...(infoKind && { earthquakeInfoKind: infoKind }),
    ...(infoType && { earthquakeInfoType: infoType }),
  }
}

/**
 * 波高の要素が名乗っている種別（`jmx_eb:TsunamiHeight@type`）を、読み手の文脈と突き合わせる。
 *
 * **予想か観測かは要素の位置（`Forecast` / `Observation` / `Estimation`）で判定している。**
 * それ自体は確実なのでこの関数の返り値では分岐させない。ただし電文も型を書いているので、
 * 食い違ったら記録する ——位置での判定は電文の構造に乗った代理指標で、気象庁が構造を
 * 変えたときに黙ってずれる。**型の側で分岐させないのは、未知の語が来たときに
 * 全部の分岐が同時に外れるため。**
 */
function checkTsunamiHeightType(heightEl: Element | null, expected: string, where: string, name: string): void {
  if (!heightEl) return
  const type = heightEl.getAttribute('type')?.trim() ?? ''
  if (!type || type === expected) return
  // **名前を必ず添える。** 添えないと同じ文が観測点の数だけ並び、どこが原因か電文を
  // 掘り直さないと分からない。
  log.warn(`${TSUNAMI_LOG_PREFIX} ${where}「${name}」の波高が「${expected}」ではなく「${type}」と名乗っています`)
}

/**
 * 数値として読める整数だけを返す。**読めない値は持たせない**（既定値へ丸めると、
 * 「気象庁が 0 と言った」と「読めなかった」が区別できなくなる。0 は「不明」「変化なし」という
 * 意味のある値なので、この区別は消せない）。
 */
function intAttr(el: Element | null, name: string): number | undefined {
  if (!el) return undefined
  const raw = el.getAttribute(name)
  if (raw == null) return undefined
  const n = parseInt(raw.trim(), 10)
  return Number.isInteger(n) ? n : undefined
}

function intText(el: Element | null): number | undefined {
  if (!el) return undefined
  const n = parseInt(xmlText(el), 10)
  return Number.isInteger(n) ? n : undefined
}

/**
 * 震源要素の精度（`Hypocenter/Accuracy`。電文解説資料 Ⅱ.21 1-4-2）を読む。
 *
 * 本文はどれも `"NaN"` 固定で、**意味はすべて属性に入っている**（`NumberOfMagnitudeCalculation`
 * だけは本文に数値）。値はそのまま持ち、意味への読み替えは表示側に任せる。
 */
function parseEEWAccuracy(hypocenterEl: Element | null): EEWAccuracy | undefined {
  const el = hypocenterEl ? xmlChild(hypocenterEl, 'Accuracy') : null
  if (!el) return undefined
  const a: EEWAccuracy = {
    epicenterRank: intAttr(xmlChild(el, 'Epicenter'), 'rank'),
    epicenterRank2: intAttr(xmlChild(el, 'Epicenter'), 'rank2'),
    depthRank: intAttr(xmlChild(el, 'Depth'), 'rank'),
    magnitudeRank: intAttr(xmlChild(el, 'MagnitudeCalculation'), 'rank'),
    magnitudePoints: intText(xmlChild(el, 'NumberOfMagnitudeCalculation')),
  }
  // 1 つも読めなければ持たせない（要素はあるが中身が読めない＝書式が変わった疑い）
  return Object.values(a).some(v => v !== undefined) ? a : undefined
}

/** `MaxIntChange` / `MaxLgIntChange` の値域（解説資料 Ⅱ.21 2-1-4-1・2-1-4-2）。 */
const FORECAST_CHANGE_VALUES: ReadonlySet<number> = new Set([0, 1, 2])
/** `MaxIntChangeReason` の値域（同 2-1-4-3）。**5〜8 は定義されていない。** */
const FORECAST_CHANGE_REASONS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 9])

/**
 * 最大予測値の変化（`Intensity/Forecast/Appendix`。電文解説資料 Ⅱ.21 2-1-4）を読む。
 *
 * **値域の外は捨てて記録する。** ここは「気象庁が何と言ったか」を持つ場所で、知らない値を
 * 通すと表示側が対応表を引けずに空欄になる（なぜ空なのかもどこにも残らない）。
 */
function parseEEWForecastChange(doc: Document): EEWForecastChange | undefined {
  // **`Forecast` の下に限って探す。** `Appendix` という要素名は南海トラフ（Ⅱ.41）でも
  // 「参考情報」として使われており、名前だけで文書全体から引くと別の電文の中身を掴みうる。
  const forecastEl = xmlQ(doc, 'Forecast')
  const el = forecastEl ? xmlChild(forecastEl, 'Appendix') : null
  if (!el) return undefined
  const pick = <T extends number>(name: string, allowed: ReadonlySet<number>): T | undefined => {
    const child = xmlChild(el, name)
    if (!child) return undefined
    const n = intText(child)
    if (n !== undefined && allowed.has(n)) return n as T
    log.warn(`${DMDATA_LOG_PREFIX} 緊急地震速報の ${name} を読めません（無視します）: "${xmlText(child)}"`)
    return undefined
  }
  const c: EEWForecastChange = {
    maxInt: pick<0 | 1 | 2>('MaxIntChange', FORECAST_CHANGE_VALUES),
    maxLgInt: pick<0 | 1 | 2>('MaxLgIntChange', FORECAST_CHANGE_VALUES),
    reason: pick<0 | 1 | 2 | 3 | 4 | 9>('MaxIntChangeReason', FORECAST_CHANGE_REASONS),
  }
  return Object.values(c).some(v => v !== undefined) ? c : undefined
}

/**
 * XML 電文（VXSE45 等）を EEWAlert に読む。
 *
 * **`EEWAlert` の真偽値は、電文の形から組み立てる。** 電文はどれも真偽値では持たない
 * （実電文 21 通で確かめた）。
 *
 * | 立てるもの | 電文での表れ |
 * |---|---|
 * | `cancelled` | `Head/InfoType` が「取消」 |
 * | `isFinal` | `Body/NextAdvisory` に最終報の文言（取消も打ち切りなので立てる） |
 * | `severity: 'Warning'` | 区域の `Category/Kind/Name` が「緊急地震速報（警報）」 |
 *
 * **`Condition` は要素の位置で意味が変わる。** `Earthquake` 直下は震源の状態（「仮定震源要素」）、
 * `Pref/Area` 直下は区域の状態（「既に主要動到達と推測」）。子孫から拾うと、警報級の電文で
 * 区域側の文言が震源の `condition` に化け、仮定震源要素の判定が誤って立つ。
 */
export function parseEEWFromXml(headType: string, xml: string): EEWAlert | null {
  // **記録は他の XML パーサーと同じ仕組みに乗せる。** ここだけ素の `return null` にすると、
  // 電文が 1 通丸ごと消えたことがどこにも残らない（EEW は最も落としてはいけない電文）。
  const doc = parseTelegramXml(xml, DMDATA_LOG_PREFIX)
  if (!doc) return null

  const eventId = xmlText(xmlQ(doc, 'EventID'))
  const serial = xmlText(xmlQ(doc, 'Serial')) || '1'
  // **他の XML パーサーと同じ経路で読む。** かつてここだけ素読みで、`Control/DateTime` への
  // 受け皿も、読めない値・時間帯を明示しない値を空にする検証も持っていなかった。
  //
  // 緊急地震速報では `Head/ReportDateTime` と `Control/DateTime` が**秒まで一致する**。
  // 地震情報は `ReportDateTime` が分へ丸められて最大 55 秒ずれるが、こちらにその丸めは
  // 無いので、受け皿へ落ちても指す瞬間は変わらない。
  //
  // **受け皿が実運用で働くことは期待していない。** `Head/ReportDateTime` の欠落は 1 通も
  // 観測できていない。それでも揃えるのは、欠けた電文が来たときに**例外もログも出さずに**
  // 発表時刻が空になり、自動解除の時刻計算（`utils/eew.ts` の `calcEEWCancelTime`）が
  // Invalid Date へ落ちるため。
  //
  // 上の 2 つは DMDATA アーカイブの `eew.forecast` と `eew.warning`（2022-07-20〜2026-09-12・
  // XML 80,725 通。2026-09-13 に数えた値）を走査した実測。差の分布は 0 秒のみ、
  // `ReportDateTime` の欠落は 0 通だった。**目録は後から縮むので、別の日に数えた値とは
  // 範囲が同じでも数が食い違いうる**（→ `docs/spec/quake-spec.md` §6.2）。
  const reportTime = readReportDateTime(doc, '緊急地震速報', DMDATA_LOG_PREFIX)
  const isCanceled = xmlText(xmlQ(doc, 'InfoType')) === '取消'

  const eqEl = xmlQ(doc, 'Earthquake')
  const eewMagnitudeEl = eqEl ? xmlQ(eqEl, 'Magnitude') : null
  // マグニチュードの種別（`Mj` / `M`）。地震情報・津波・長周期と同じく持つだけで画面には
  // 出さない。**緊急地震速報だけ別のパーサーを通るため落ちていた。**
  const eewMagnitudeType = eewMagnitudeEl?.getAttribute('type')?.trim() || undefined
  // 見出し文。実電文では空だが、警報の報で入りうる（→ `readHeadlineText`）。
  // 地震情報・長周期と同じく持つだけで画面には出さない。
  const eewHeadline = readHeadlineText(doc)
  const eewInfoName = readInfoName(doc)
  const hypocenterEl = eqEl ? xmlQ(eqEl, 'Hypocenter') : null
  const areaEl = eqEl ? xmlQ(hypocenterEl ?? eqEl, 'Area') : null
  const { lat, lng, depth } = areaEl
    ? parseJmaCoord(xmlText(xmlQ(areaEl, 'Coordinate')))
    : { lat: NaN, lng: NaN, depth: -1 }

  // 取消以外で震源が読めない電文は不正として捨てる。地震情報側（`parseEarthquakeFromXml`）と同じく
  // **要素が無いのか、要素はあるが座標が読めないのかを書き分ける。** 前者では `coordStr` が空文字に
  // なるため 1 つの文言にまとめると、「電文の構造が変わった」のか「座標の書式が変わった」のかが
  // ログから読み取れない。取消は Body に Text しか持たず `Earthquake` を持たないので、どちらの
  // 判定からも外す。
  if (!isCanceled && !eqEl) {
    return dropTelegram(DMDATA_LOG_PREFIX, `${headType}（緊急地震速報）に Earthquake 要素がありません`)
  }
  // **「震源要素不明」だけは捨てない**（→ `isUnknownHypocenterCoord`）。地震情報側と同じ扱いで、
  // 震源が判らないだけの電文と、座標の書式が壊れた電文を分ける。予想震度と対象区域は残るので、
  // 予報円が描けなくても伝えるべきことがある。
  //
  // **位置を使う側は `hasKnownEpicenter` を通すこと。** `Number.isFinite` だけでは足りない ——
  // センチネル `-200` は有限で、すり抜けると予報円が MapLibre の緯度検証で例外を投げ、
  // 揺れ検知の同一地震判定が距離のフォールバックへ到達しなくなる（どちらも実際に起きていた）。
  if (!isCanceled && (!Number.isFinite(lat) || !Number.isFinite(lng))) {
    if (!isUnknownHypocenterCoord(areaEl)) {
      const coordStr = areaEl ? xmlText(xmlQ(areaEl, 'Coordinate')) : ''
      return dropTelegram(DMDATA_LOG_PREFIX, `${headType}（緊急地震速報）の震源座標が読めません: Coordinate="${coordStr}"`)
    }
    log.warn(`${DMDATA_LOG_PREFIX} ${headType}（緊急地震速報）は震源要素不明の電文です。震源を伏せて予想震度と対象区域を出します: EventID=${eventId} 第${serial}報`)
  }

  // 要素名は `WarningComment`。電文解説資料の事例（Ⅱ.21 4-1）:
  //
  //     <Comments><WarningComment codeType="固定付加文">
  //       <Text>強い揺れに警戒してください。</Text><Code>0201</Code></WarningComment></Comments>
  //
  // **`Warning` と書いていて実電文を 1 件も拾えていなかった。** 同じファイルの津波側は
  // 正しく `WarningComment` を引いており、EEW 側だけ取り違えていた。テストのヘルパーも
  // 同じ誤った要素名で電文を組んでいたため、緑でも何も保証していなかった。
  const eewCommentsEl = xmlQ(doc, 'Comments')
  const eewWarningCommentEl = eewCommentsEl ? xmlQ(eewCommentsEl, 'WarningComment') : null
  // 原文を画面に出す他の経路（津波・地震情報・長周期）と同じ検査を通す。
  // **ここだけ生で読んでいたため、コードはあるのに原文が無い電文で黙って空になっていた。**
  const warningComment = readCommentText(eewWarningCommentEl, '固定付加文', DMDATA_LOG_PREFIX) || undefined

  const forecastEl = xmlQ(doc, 'Forecast')
  const intRange = (el: Element | null): { from: string; to: string } => ({
    from: xmlText(el ? xmlChild(el, 'From') : null),
    to: xmlText(el ? xmlChild(el, 'To') : null),
  })
  const { scale: forecastScale, orAbove: forecastOrAbove } =
    parseForecastInt(intRange(forecastEl ? xmlChild(forecastEl, 'ForecastInt') : null))
  const { cls: lgClass, over: lgClassOver } =
    parseForecastLgInt(intRange(forecastEl ? xmlChild(forecastEl, 'ForecastLgInt') : null))

  const areas: EEWRegion[] = []
  // 警報級かどうかは区域の `Category/Kind/Code` で判る。
  // 区域を回るついでに拾う ―― 名前で引き直すと、同名の区域があるときに取り違える。
  let sawWarningKind = false
  const unknownKindCodes = new Set<string>()
  // 区域の到達状況（`Area/Condition`）で読めなかった値。**電文ごとに 1 行へまとめる** ——
  // 区域は数十個あるので 1 件ずつ出すと他の記録が埋もれる。
  const unknownArrivalConditions = new Set<string>()
  for (const prefEl of forecastEl ? xmlAll(forecastEl, 'Pref') : []) {
    for (const a of xmlAll(prefEl, 'Area')) {
      const name = xmlText(xmlChild(a, 'Name'))
      if (!name) continue
      const fi = intRange(xmlChild(a, 'ForecastInt'))
      const { scale: scaleTo, orAbove } = parseForecastInt(fi)
      const { cls: lgVal, over: lgOver } = parseForecastLgInt(intRange(xmlChild(a, 'ForecastLgInt')))
      const kindEl = xmlQ(a, 'Kind')
      const kindCode = xmlText(kindEl ? xmlChild(kindEl, 'Code') : null)
      if (isEewWarningKindCode(kindCode)) sawWarningKind = true
      else if (!isEewForecastKindCode(kindCode)) {
        // コード表に無い値。**名前へ落として警報を取りこぼさない**（安全側）。
        if (xmlText(kindEl ? xmlChild(kindEl, 'Name') : null) === EEW_WARNING_KIND_NAME) sawWarningKind = true
        // **「載っていない」と「読めなかった」を分ける。** 区域が `Category/Kind` を
        // 持たない電文は正常にあり（画面もそのとき警報／予報に分けずに出す）、
        // 数えるとその形の電文すべてで警告が鳴って本当に未知のコードが埋もれる。
        // **要素はあるのにコードが空**なら話が別で、そちらは記録する。
        if (kindCode) unknownKindCodes.add(kindCode)
        else if (kindEl) unknownKindCodes.add('（空）')
      }
      // 主要動の到達状況。**電文は同じ事実を 2 通りで伝えてくる** —— 区域の `Condition`
      //（「既に主要動到達と推測」。解説資料 Ⅱ.21 2-1-5-3-7）と、種別コードの下 1 桁
      //（01/11。コード表 12。→ `isEewArrivedKindCode`）。
      //
      // **ここで 1 つの値へ畳む。** 画面が別々に判定すると、片方だけ直したときに静かにずれる。
      // どちらかが立てば到達済みとして扱う ―― 片方しか無い電文が来ても取りこぼさないため。
      //
      // **片方しか無いことを異常として記録しない。** 資料が排他だと定めているのは `Condition` と
      // `ArrivalTime` のあいだ（同 2-1-5-3-6）だけで、**コードと `Condition` が必ず同時に出るとは
      // 書いていない**。手元の実電文で両方そろっている例は数えるほどしかなく、そこから
      // 「常にそろう」と決めるのは標本が薄い。鳴らすようにすると、正常な電文でログが埋まって
      // 本物の異常が沈む。
      //
      // 到達済みの区域では `ArrivalTime` が出ない（同 2-1-5-3-6）。時刻の側は電文どおり読み、
      // 排他であることは型のコメント（`EEWRegion.arrived`）に置く。
      const arrivalConditionRaw = xmlText(xmlChild(a, 'Condition'))
      const arrivedByCondition = arrivalConditionRaw === EEW_AREA_ARRIVED_CONDITION
      const arrived = arrivedByCondition || isEewArrivedKindCode(kindCode)
      // 値域は資料が「既に主要動到達と推測」の 1 つに定めている。外れた値は捨てて記録する
      // ——表示側が意味を決められないため（`LandOrSea` と同じ扱い）。**こちらは資料が
      // 値域を定めているので、外れれば確かに異常。**
      if (arrivalConditionRaw && !arrivedByCondition) unknownArrivalConditions.add(arrivalConditionRaw)
      areas.push({
        pref: '',
        name,
        scaleFrom: parseIntensityStr(fi.from),
        scaleTo,
        ...(orAbove && { scaleToOrAbove: true }),
        kindCode,
        arrivalTime: readTelegramDateTime(DMDATA_LOG_PREFIX, '緊急地震速報の区域の到達予測時刻', xmlText(xmlChild(a, 'ArrivalTime'))) || null,
        ...(arrived && { arrived: true }),
        lgIntTo: lgVal,
        ...(lgOver && { lgIntToOver: true }),
      })
    }
  }

  if (unknownKindCodes.size > 0) {
    // コード表に無い種別。**名前で警報かどうかは判定できている**ので表示は壊れないが、
    // コード表が増えたことに気づけるよう残す。
    log.warn(`${DMDATA_LOG_PREFIX} 緊急地震速報の種別コードを読めません（名前で判定しました）: ${[...unknownKindCodes].join(', ')}`)
  }
  if (unknownArrivalConditions.size > 0) {
    // 資料が定めていない到達状況。**到達済みの区域が「時刻を持たない区域」に紛れる**ので、
    // 値域が増えたことに気づけるよう残す。
    log.warn(`${DMDATA_LOG_PREFIX} 緊急地震速報の区域の到達状況を読めません（無視します）: ${[...unknownArrivalConditions].join(', ')}`)
  }

  // 取消しの概要（`Body/Text`）。地震情報・津波情報と同じ扱い（`Comments` は取消電文に出現しない）。
  const eewCancelBodyEl = isCanceled ? xmlQ(doc, 'Body') : null
  const eewCancelText = eewCancelBodyEl ? xmlText(xmlChild(eewCancelBodyEl, 'Text')) : ''

  // 震央地名まわりの補助情報（`Hypocenter/Area` 配下）。値は電文どおりに持つ。
  // **`LandOrSea` は値域が「内陸」「海域」の 2 つだけ**（解説資料 Ⅱ.21 1-4-1-6）。外れた値は
  // 捨てて記録する —— 表示側が対応表を引けずに黙って空欄になるため。
  const landOrSeaRaw = areaEl ? xmlText(xmlChild(areaEl, 'LandOrSea')) : ''
  const landOrSea = landOrSeaRaw === '内陸' || landOrSeaRaw === '海域' ? landOrSeaRaw : undefined
  if (landOrSeaRaw && !landOrSea) {
    log.warn(`${DMDATA_LOG_PREFIX} 緊急地震速報の内陸判定を読めません（無視します）: "${landOrSeaRaw}"`)
  }
  const reduceName = areaEl ? xmlText(xmlChild(areaEl, 'ReduceName')) : ''
  // 震央地名コードと短縮用震央地名コード。名前の側は既に読んでいたので扱いを揃える。
  const eewAreaCode = areaEl ? xmlText(xmlChild(areaEl, 'Code')) : ''
  const eewReduceCode = areaEl ? xmlText(xmlChild(areaEl, 'ReduceCode')) : ''
  const operationStatus = parseOperationStatus(doc)
  const accuracy = parseEEWAccuracy(hypocenterEl)
  const forecastChange = isCanceled ? undefined : parseEEWForecastChange(doc)

  return {
    kind: 'eew',
    id: `dmdata-eew-${eventId}-${serial}`,
    time: reportTime,
    test: false,
    ...(eewHeadline && { headline: eewHeadline }),
    ...(eewInfoName && { infoName: eewInfoName }),
    ...(eewCancelText && { cancelText: eewCancelText }),
    earthquake: {
      // 緊急地震速報は `eventId` で束ねるので、この 2 つは表示・共有カードにしか使わない。
      // 読めない値は捨ててよい（同一性の判定に使う地震情報・津波とは扱いが違う）。
      originTime: readTelegramDateTime(DMDATA_LOG_PREFIX, '緊急地震速報の地震発生時刻', xmlText(eqEl ? xmlChild(eqEl, 'OriginTime') : null)),
      arrivalTime: readTelegramDateTime(DMDATA_LOG_PREFIX, '緊急地震速報の地震発現時刻', xmlText(eqEl ? xmlChild(eqEl, 'ArrivalTime') : null)),
      // Earthquake 直下だけを見る（上記のとおり Area 直下にも Condition がある）。
      condition: xmlText(eqEl ? xmlChild(eqEl, 'Condition') : null),
      hypocenter: {
        name: xmlText(areaEl ? xmlChild(areaEl, 'Name') : null),
        // 取消と震源要素不明はどちらも「位置が無い」。**NaN のまま渡さない** —— 取消が
        // 既にセンチネルへ倒しているので、同じ状態を 2 通りの値で表すと弾き方が 2 つに割れる。
        latitude: isCanceled ? -200 : (Number.isFinite(lat) ? lat : -200),
        longitude: isCanceled ? -200 : (Number.isFinite(lng) ? lng : -200),
        depth,
        magnitude: eewMagnitudeEl ? parseFloat(xmlText(eewMagnitudeEl)) : NaN,
        ...(eewMagnitudeType && { magnitudeType: eewMagnitudeType }),
        ...(eewAreaCode && { code: eewAreaCode }),
      },
    },
    // 震源要素の精度・内陸判定・短縮用震央地名（`Hypocenter` 配下）。**取消電文は `Earthquake` を
    // 持たないので自然に付かない。** 予想と同じく、取り消された報の中身を残さない。
    ...(operationStatus && { operationStatus }),
    ...(accuracy && { accuracy }),
    ...(landOrSea && { landOrSea }),
    ...(reduceName && { reduceName }),
    ...(eewReduceCode && { reduceCode: eewReduceCode }),
    // 最大予測値の変化（`Intensity/Forecast/Appendix`）。取消電文は予想を持たないので付かない。
    ...(forecastChange && { forecastChange }),
    severity: (headType === 'VXSE43' || sawWarningKind) ? 'Warning' : 'Forecast',
    cancelled: isCanceled,
    // 取消はそのイベントの打ち切りなので最終報として扱う。取消電文は Body に Text しか持たず
    // NextAdvisory が無い（実電文 2026-03-07 の取消で確認）ため、文言だけを見ると false に落ちる。
    isFinal: isCanceled || (xmlText(xmlQ(doc, 'NextAdvisory')) || '').includes('最終報'),
    forecastMaxScale: (!isCanceled && forecastScale >= 0) ? forecastScale as IntensityScale : undefined,
    ...(!isCanceled && forecastScale > 0 && forecastOrAbove && { forecastMaxScaleOrAbove: true }),
    forecastMaxLpgmClass: isCanceled ? undefined : lgClass,
    ...(!isCanceled && lgClassOver && { forecastMaxLpgmClassOver: true }),
    issue: { eventId, serial, time: reportTime },
    areas: isCanceled ? [] : areas,
    // 固定付加文（`Comments/WarningComment/Text`）。地震情報・津波では既に読んでいたが EEW だけ
    // 落としていた。避難行動の呼びかけなどが入る。取消電文の Text は付加文ではなく取消の
    // 理由なので、`Comments` の下に限って拾う。
    ...(warningComment && { warningComment }),
  }
}

// REST API 経由の JMA XML（VXSE51/52/53）を JMAQuake にパース
export function parseEarthquakeFromXml(headType: string, xml: string): JMAQuake | null {
  const doc = parseTelegramXml(xml, DMDATA_LOG_PREFIX)
  if (!doc) return null

  const quakeOperationStatus = parseOperationStatus(doc)
  // 見出し文。**読んで持つだけで画面には出さない**（→ `readHeadlineText`）。
  const quakeHeadline = readHeadlineText(doc)
  const reportDateTime = readReportDateTime(doc, '地震情報', DMDATA_LOG_PREFIX)
  const eventId = xmlText(xmlQ(doc, 'EventID'))
  const infoType = xmlText(xmlQ(doc, 'InfoType'))
  const serial = xmlText(xmlQ(doc, 'Serial')) || '1'
  // 電文が名乗る情報名（`Head/Title`）。**読み取りは `readInfoName` へ集約する** ——
  // `Control/Title` と紛れる要素で、複数の経路が別々に読むと片方が遅れる。
  // 取消報でも同じ判定が要るため、取消の早期リターンより前で解決しておく。
  const quakeInfoName = readInfoName(doc)
  const issueType = resolveIssueType(headType, quakeInfoName)
  const source = parseIssueSourceFromXml(doc)

  // 取消電文（InfoType === '取消'）: Earthquake 要素が存在しないため早期リターン
  if (infoType === '取消') {
    const cancelBodyEl = xmlQ(doc, 'Body')
    const cancelBodyText = cancelBodyEl ? xmlText(xmlChild(cancelBodyEl, 'Text')) : ''
    return {
      kind: 'quake',
      id: `dmdata-quake-${eventId}-${serial}`,
      // **取消でも通常報と形を揃える。** 同一性の判定（`sameQuakeEntry` 等）は id 文字列から
      // 14 桁を抜く `extractQuakeEventId` を通るので、このフィールドの有無では挙動は変わらない。
      // 揃えておくのは、次にこのフィールドを使うコードが「取消だけ持たない」ことを知らずに
      // 取りこぼすのを防ぐため（読んでいるのは TsunamiTab の原因地震リンク）。
      eventId: eventId || undefined,
      time: reportDateTime,
      ...(quakeOperationStatus && { operationStatus: quakeOperationStatus }),
      cancelled: true,
      // 取消しの概要（`Body/Text`）。**`Comments` ではなく `Body` 直下**——取消電文は付加文を
      // 持たない（電文解説資料が「情報形態が"取消"の場合、本要素は出現しない」と定めている）。
      ...(cancelBodyText && { cancelText: cancelBodyText }),
      issue: { source, time: reportDateTime, type: issueType, correct: 'なし' as CorrectType },
      earthquake: { time: '', hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 }, maxScale: -1, domesticTsunami: '不明' },
      points: [],
    }
  }

  // VXSE51（震度速報）は震源が未確定の段階で発表されるため Earthquake 要素を持たない。
  // **この電文だけ震源なしを許容する。** 他の種別で無いのは電文の異常。
  const earthquakeEl = xmlQ(doc, 'Earthquake')
  if (!earthquakeEl && headType !== 'VXSE51') {
    return dropTelegram(DMDATA_LOG_PREFIX, `${headType} に Earthquake 要素がありません`)
  }

  const hypocenterEl = earthquakeEl ? xmlQ(earthquakeEl, 'Hypocenter') : null
  const areaEl = hypocenterEl ? xmlQ(hypocenterEl, 'Area') : null
  // 遠地地震は Area/DetailedName に詳細震央地名（例: "ベネズエラ沿岸"）が入る。なければ Area/Name にフォールバック。
  const hypName = (areaEl ? xmlText(xmlQ(areaEl, 'DetailedName')) : '')
    || (areaEl ? xmlText(xmlQ(areaEl, 'Name')) : '')
  // 震央地名コード・震央補助表現（`NameFromMark` とその材料）。**座標以外は津波・長周期と
  // 同じ読み手を通す**（→ `readHypocenterAreaLabels`）。座標だけは VXSE61 が要素を 2 つ持つ
  // 事情があるため下で別に読む。
  const hypLabels = areaEl ? readHypocenterAreaLabels(areaEl) : {}
  // 震源決定機関（`Hypocenter/Source`）。`Area` の外にあるので上の読み手には入らない。
  const hypSource = readHypocenterSource(hypocenterEl)
  const { lat, lng, depth } = areaEl
    ? readHypocenterCoord(areaEl, headType)
    : { lat: NaN, lng: NaN, depth: -1 }

  // 震源を持つ電文で座標が読めないものは不正として捨てる（震度速報は上で除外済み）。
  // **ただし「震源要素不明」だけは捨てない**（→ `isUnknownHypocenterCoord`）。震源が判らない
  // だけで震度は全国分そろっており、捨てると最も異常な地震で震度が丸ごと消える。位置不明の
  // センチネル（-200）へ倒せば、カード（`hasLocation`）も地図（`useQuakeLayerData`）も
  // 既にあるガードで震源だけを伏せる。
  //
  // **読めなかった値そのものを記録に載せる。** 座標の要素は 2 つ載ることがある（度単位と度分。
  // → `readHypocenterCoord`）ので、どちらが来ていたか分かるよう両方を並べる。
  if (earthquakeEl && (!Number.isFinite(lat) || !Number.isFinite(lng))) {
    if (!isUnknownHypocenterCoord(areaEl)) {
      const coordStr = areaEl ? xmlAll(areaEl, 'Coordinate').map(el => xmlText(el)).join(' / ') : ''
      return dropTelegram(DMDATA_LOG_PREFIX, `${headType} の震源座標が読めません: Coordinate="${coordStr}"`)
    }
    log.warn(`${DMDATA_LOG_PREFIX} ${headType} は震源要素不明の電文です。震源を伏せて震度だけを出します: EventID=${eventId} 第${serial}報`)
  }

  // 震度速報は Head/TargetDateTime（地震検知時刻）を earthquake.time に充てる。
  // 通常電文は arrivalTime を優先し、無ければ originTime にフォールバックする
  // （DMD-4: かつて OriginTime を採っていて、同じ地震の時刻が 1 分ずれていた）。
  //
  // **変数名を `originTime` にしない。** 中身は発現時刻が優先で、電文の
  // `OriginTime`（地震発生時刻）とは別物。同じ名前を付けると、実装を読んで裏を取る人が
  // 「`originTime` という名前なのに発現時刻？」で止まる（実際に止まった）。
  // 津波側の選択（`sourceEarthquakeTime`）と同じ規則であることは
  // `docs/spec/tsunami-spec.md` §4 に書いてある。
  //
  // **読めない値でも捨てない。** この値は `earthquake.time` になり、`eventId` を持たない経路
  // （P2PQuake）の同一性キー（`eventKey`）に入る。空文字へ倒すと別々の地震が同じキーになって
  // 1 枚のカードへ束ねられる —— 読めない時刻を残すより重い。記録だけ残し、表示・読み上げ側の
  // ガード（`formatters.ts` の `readDateTime`）に受け止めさせる。
  const earthquakeTime = earthquakeEl
    ? (xmlText(xmlQ(earthquakeEl, 'ArrivalTime')) || xmlText(xmlQ(earthquakeEl, 'OriginTime')))
    : xmlText(xmlQ(doc, 'TargetDateTime'))
  warnIfUnreadableDateTime(DMDATA_LOG_PREFIX, '地震の発現時刻（または発生時刻）', earthquakeTime, '同一性の判定に使う')

  // Magnitude 要素が空・欠落の電文は「規模不明」。`|| 0` で 0 に潰すと M0.0 と実測値のように
  // 表示・読み上げされるため、NaN のまま返して不明判定（formatters の hasMagnitude）に委ねる。
  // VXSE51（震度速報）は Earthquake 要素自体を持たない。**ここも 0 ではなく NaN にする**——
  // 0 は `hasMagnitude` を通るので「Ｍ０．０」と読める形になってしまう。
  const magnitudeEl = earthquakeEl ? xmlQ(earthquakeEl, 'Magnitude') : null
  const magnitude = magnitudeEl ? parseFloat(xmlText(magnitudeEl)) : NaN
  // 規模が数値にならないときに気象庁が添える説明。**「Ｍ不明」と「Ｍ８を超える巨大地震」は
  // 電文上どちらも本文 NaN・`@condition="不明"`** で、`description` でしか見分けられない
  // （電文解説資料 Ⅱ.32/33/36）。津波側（`parseTsunamiFromXml`）と同じ規則で、数値が
  // 読めたときは持たせない。
  const magnitudeCondition = isNaN(magnitude)
    ? (magnitudeEl?.getAttribute('description')?.trim() || undefined)
    : undefined
  // マグニチュードの種別（`Mj` = 気象庁マグニチュード / `M` = 気象庁以外の機関が決めた値）。
  // 画面には出さない（→ `TsunamiSourceEarthquake.magnitudeType`）。
  const magnitudeType = magnitudeEl?.getAttribute('type')?.trim() || undefined

  // MaxInt は Intensity > Observation 直下。
  // **仕様外への保険。** 電文解説資料は `MaxInt` の値域を "1"〜"7" と定めており
  // （震度速報 VXSE51 だけは "3"〜"7"。震度3未満では発表しないため）、
  // その範囲に未入電の観測点しか無い場合は **`MaxInt` 要素そのものが出現しない**（未入電の
  // 文字列は入らない）。実電文 853 通でも `MaxInt` に現れたことは無い。
  // 仕様が変わってここへ入った場合に `-1` へ落として最大震度を失わないよう、読めるようにだけ
  // しておく。**この保険が働かない限り `isMaxScaleUnreceived` は真にならない。**
  const obsEl = xmlQ(doc, 'Observation')
  const maxIntStr = obsEl ? xmlText(xmlQ(obsEl, 'MaxInt')) : ''
  const { scale: maxScale } = readIntensity(maxIntStr || null)

  // 震度は Pref 配下に「一次細分区域(Area) → 市区町村(City) → 観測点(IntensityStation)」と
  // 入れ子で入る。震度速報は Area までしか持たず、震源・震度情報は両方を持つ。
  const points: JMAQuake['points'] = []
  // 種別ごとに全滅を数える。
  // 前の電文の解析が途中で終わっていた場合に備えて空にしてから始める（解析は同期なので、
  // 1 電文ぶんの記録がここから下で完結する）。
  unknownUnreceivedValues.clear()
  const prefTally = createReadTally('都道府県の代表震度')
  const areaTally = createReadTally('震度の区域')
  const cityTally = createReadTally('震度の市町村')
  const stationTally = createReadTally('震度の観測点')
  // 市町村は `points` へ混ぜない（4 種目を足すと `pref` と `isArea` による見分けが狂う。
  // → `JMAQuakeCity` のコメント）。区域と観測点のあいだの粒度として別に持つ。
  const cities: JMAQuakeCity[] = []
  const allEls = doc.getElementsByTagName('*')
  const prefEls: Element[] = []
  for (let i = 0; i < allEls.length; i++) {
    if (allEls[i].localName === 'Pref') prefEls.push(allEls[i])
  }
  for (const prefEl of prefEls) {
    // 都道府県ロールアップ点（電文の Pref 直下が持つ県別の最大震度）。
    // EarthquakeCard は pref の有無で「都道府県の点」と「区域の点」を見分けるため、
    // ここだけ pref に名前を入れる（区域・観測点は下で pref: '' にする）。
    //
    // 実電文は Pref 直下に MaxInt を持つ（能登半島地震の震度速報で
    // <Pref><Name>石川県</Name><Code>17</Code><MaxInt>5+</MaxInt> を確認）。
    // xmlChild で直下に限るのは、MaxInt を持たない電文で配下 Area の値を拾わないため。
    const prefName = xmlText(xmlChild(prefEl, 'Name'))
    const prefCode = xmlText(xmlChild(prefEl, 'Code'))
    const prefRawInt = xmlText(xmlChild(prefEl, 'MaxInt'))
    const { scale: prefScale, unreceived: prefUnreceived } = readIntensity(prefRawInt || null)
    // 続報での変化（`Revise`）。気象庁が「追加」「上方修正」「下方修正」を直接伝えている
    // （→ `EarthquakePoint.revise`）。**直下に限る** —— 配下の Area / City も同名要素を持つ。
    const prefRevise = xmlText(xmlChild(prefEl, 'Revise'))
    if (prefName && prefScale >= 0) {
      points.push({
        pref: prefName, addr: prefName, isArea: true, scale: prefScale as IntensityScale,
        ...(prefUnreceived && { unreceived: true }),
        ...(prefRevise && { revise: prefRevise }),
        ...(prefCode && { code: prefCode }),
      })
      prefTally.readable()
    } else {
      // **記録にコードを載せる。** 名前が読めない都道府県は名前で追えないので、
      // コードだけが手がかりになる（区域・市町村・観測点も同じ）。
      prefTally.unreadable(prefName || codeOnlyLabel(prefCode), prefRawInt)
    }

    // 市町村がどの区域に属するかは、電文の並び順（Area → その配下の City）で決まる。
    // `City` から親を辿ってもよいが、`getElementsByTagName` の平坦な走査と混ぜると
    // 区域を持たない電文（震度速報）で親が無い場合の扱いが分かれるため、直前の区域名を覚える。
    let currentAreaName = ''
    // 観測点がどの市町村に属するかも同じく並び順で決まる（City → その配下の IntensityStation）。
    // **区域が変わったら空に戻す** —— 戻さないと、市町村を持たない区域の観測点に隣の区域の
    // 市町村名が付く。座標表は観測点の所属市町村を持たないので、ここで拾わないと後から引けない。
    let currentCityName = ''
    const descendants = prefEl.getElementsByTagName('*')
    for (let i = 0; i < descendants.length; i++) {
      const el = descendants[i]

      if (el.localName === 'Area') {
        // 区域は pref を空にする。EarthquakeCard は
        // pref の有無で「都道府県の点」と「区域の点」を見分けるため（座標側は
        // useQuakeLayerData が区域名から都道府県を逆引きして引き当てる）。
        const areaName = xmlText(xmlChild(el, 'Name'))
        const areaCode = xmlText(xmlChild(el, 'Code'))
        const areaRawInt = xmlText(xmlChild(el, 'MaxInt'))
        const { scale: areaScale, unreceived: areaUnreceived } = readIntensity(areaRawInt || null)
        // 続報での変化（`Revise`）。都道府県側と同じ扱い（解説資料 Ⅱ.33 2-1-3-3-2）。
        const areaRevise = xmlText(xmlChild(el, 'Revise'))
        if (areaName && areaScale >= 0) {
          points.push({
            pref: '', addr: areaName, isArea: true, scale: areaScale as IntensityScale,
            ...(areaUnreceived && { unreceived: true }),
            ...(areaRevise && { revise: areaRevise }),
            ...(areaCode && { code: areaCode }),
          })
          areaTally.readable()
        } else {
          areaTally.unreadable(areaName || codeOnlyLabel(areaCode), areaRawInt)
        }
        currentAreaName = areaName
        currentCityName = ''
        continue
      }

      if (el.localName === 'City') {
        // 市町村の未入電は `Condition` に入る（観測点は `Int` に入るのと違う。
        // 解説資料 Ⅱ.33 2-1-3-3-3）。**`MaxInt` と併存しうる** —— 市町村の最大震度が
        // 基準未満でも、配下に未入電の観測点があればこの要素が出る。
        const cityName = xmlText(xmlChild(el, 'Name'))
        const cityCode = xmlText(xmlChild(el, 'Code'))
        const cityRawInt = xmlText(xmlChild(el, 'MaxInt'))
        const cityCondition = xmlText(xmlChild(el, 'Condition'))
        // 続報での変化（`Revise`）。都道府県・地域と同じ扱い（解説資料 Ⅱ.33 2-1-3-3-3-2）。
        // **直下に限る** —— 上位の Pref / Area も同名要素を持つ。
        const cityRevise = xmlText(xmlChild(el, 'Revise'))
        const { scale: cityScale } = readIntensity(cityRawInt || null)
        const cityUnreceived = cityCondition.includes(UNRECEIVED_INTENSITY)
        if (cityName && (cityScale >= 0 || cityUnreceived)) {
          cities.push({
            name: cityName,
            area: currentAreaName,
            pref: prefName,
            // 未入電しか無い市町村は `MaxInt` が出現しない（解説資料の同項）。観測点側と
            // 同じく下限の 45（5弱）へ寄せる —— もっと強いかもしれないことは印が伝える。
            scale: (cityScale >= 0 ? cityScale : 45) as IntensityScale,
            // **`MaxInt` の有無で意味が変わる。** 値があれば「観測できた震度＋配下に未入電あり」、
            // 無ければ「この市町村の値そのものが未入電」。畳むと、観測できた値が下限のように見える。
            ...(cityUnreceived && (cityScale >= 0 ? { hasUnreceived: true } : { unreceived: true })),
            ...(cityCode && { code: cityCode }),
            ...(cityRevise && { revise: cityRevise }),
          })
          cityTally.readable()
        } else {
          cityTally.unreadable(cityName || codeOnlyLabel(cityCode), cityRawInt || cityCondition)
        }
        // 震度を読めなかった市町村でも名前は覚える。配下の観測点は読めていることがあり、
        // その所属を落とす理由が無い（名前も読めなければ空のまま）。
        currentCityName = cityName
        continue
      }

      if (el.localName !== 'IntensityStation') continue
      // 「気象庁以外の観測点」の印を外し、印の有無を持つ（→ `stripNonJmaMark`）。
      const { name: stName, nonJma: stNonJma } = stripNonJmaMark(xmlText(xmlChild(el, 'Name')))
      const stCode = xmlText(xmlChild(el, 'Code'))
      const intStr = xmlText(xmlChild(el, 'Int'))
      const { scale, unreceived } = readIntensity(intStr || null)
      if (stName && scale >= 0) {
        // QUAKE-2: 観測点も区域と同じく pref を空にする。
        // 以前は pref: prefName を付けていたため EarthquakeCard.prefGroups が
        // 「観測点値」を都道府県別最大震度と誤解し、区域単位の最大震度が観測点値に
        // 上書きされて低震度に見える不具合があった。
        points.push({
          pref: '', addr: stName, isArea: false, scale: scale as IntensityScale,
          ...(unreceived && { unreceived: true }),
          ...(stNonJma && { nonJma: true }),
          ...(stCode && { code: stCode }),
          // 所属する市町村と一次細分区域（→ `EarthquakePoint.city` / `.area`）。
          // **どちらも座標表からは引けない**ので、電文の並びで拾えるここでしか持てない。
          // 区域まで持つのは、市町村名が全国で一意でないため（同名の市町村を取り違えない）
          // ・市町村の震度が読めなかった観測点の置き場所を残すため・座標表が無くても
          // 区域へ置けるようにするため。3 つの理由は型の注記にある。
          ...(currentCityName && { city: currentCityName }),
          ...(currentAreaName && { area: currentAreaName }),
        })
        stationTally.readable()
      } else {
        // **読めなかったときの記録にコードを載せる。** 名前が読めない観測点は名前で追えないので、
        // コードだけが手がかりになる。
        stationTally.unreadable(stName || codeOnlyLabel(stCode), intStr)
      }
    }
  }

  prefTally.warnIfNoneReadable(DMDATA_LOG_PREFIX)
  areaTally.warnIfNoneReadable(DMDATA_LOG_PREFIX)
  cityTally.warnIfNoneReadable(DMDATA_LOG_PREFIX)
  stationTally.warnIfNoneReadable(DMDATA_LOG_PREFIX)
  flushUnknownUnreceived(DMDATA_LOG_PREFIX)
  warnIfNoIntensityPoints(headType, issueType, points, DMDATA_LOG_PREFIX)

  const correct: CorrectType = infoType === '訂正' ? resolveCorrectType(doc) : 'なし'

  // ForecastComment > Code から domesticTsunami を導出。
  // 実電文はスペース区切りで 1 要素にまとまる（例: <Code>0226 0230</Code>）が、兄弟要素に
  // 分割された場合でもコードを取りこぼさないよう、配下の Code をすべて集めて連結する。
  const forecastCommentEl = xmlQ(doc, 'ForecastComment')
  const forecastCodes = forecastCommentEl
    ? xmlAll(forecastCommentEl, 'Code').flatMap(el => xmlText(el).split(/\s+/)).filter(Boolean)
    : []
  const domestic = parseDomesticTsunamiFromComments({ forecast: { codes: forecastCodes } })
  // 付加文の原文（ForecastComment > Text）。
  const forecastText = extractForecastText(
    forecastCommentEl ? xmlText(xmlQ(forecastCommentEl, 'Text')) : '',
    forecastCodes,
  )
  // 固定付加文（その他）（VarComment > Text）。実電文で現れるのは観測点名に付く `＊` の
  // 説明（コード 0262）で、**震度を伝える電文のほぼ全てに入る**。アプリは印を名前へ戻して
  // 出しているので、その説明もそのまま出す（→ `stripNonJmaMark` / `withNonJmaMark`）。
  const varCommentText = readCommentText(xmlQ(doc, 'VarComment'), '固定付加文（その他）', DMDATA_LOG_PREFIX)
  // 自由付加文（FreeFormComment）。`xmlText` が前後の空白だけを落とす。
  const freeText = xmlText(xmlQ(doc, 'FreeFormComment'))

  return {
    kind: 'quake',
    id: `dmdata-quake-${eventId}-${serial}`,
    // 空文字は undefined に落とす。
    // TsunamiTab は q.eventId を直接比較して原因地震カードへのリンクを作るため、
    // フィールドを落とすと履歴経由のカードがそのリンクに引き当たらない。
    eventId: eventId || undefined,
    time: reportDateTime,
    issue: {
      source,
      time: reportDateTime,
      type: issueType,
      correct,
    },
    earthquake: {
      time: earthquakeTime,
      hypocenter: {
        name: hypName,
        // 震度速報は震源情報なし。-200 は「位置不明」センチネル（P2PQuake 経路と揃えてある）。
        latitude: Number.isFinite(lat) ? lat : -200,
        longitude: Number.isFinite(lng) ? lng : -200,
        depth,
        magnitude,
        ...(magnitudeCondition && { magnitudeCondition }),
        ...(magnitudeType && { magnitudeType }),
        // 震央地名コード・詳細震央地名コード・震央補助表現とその材料。
        ...hypLabels,
        ...(hypSource && { source: hypSource }),
      },
      maxScale: maxScale >= 0 ? maxScale as IntensityScale : -1,
      domesticTsunami: domestic,
    },
    ...(quakeOperationStatus && { operationStatus: quakeOperationStatus }),
    ...(quakeHeadline && { headline: quakeHeadline }),
    points,
    ...(cities.length > 0 && { cities }),
    forecastText: forecastText || undefined,
    varCommentText: varCommentText || undefined,
    freeText: freeText || undefined,
  }
}

// REST API 経由の JMA XML（VTSE41/VTSE51/VTSE52）を JMATsunami にパース。
// 観測データ（Observation のみ）の場合は null を返す。
// 波高の表示文字列（XML の `description` 属性）を半角へ直す。
//
// 気象庁の原文は全角（"０．２ｍ未満" / "８．５ｍ以上"）だが、画面と読み上げはずっと半角で
// 出してきた。**原文のまま流すと、同じ値でも全角と半角が混じって並ぶ。**
//
// 直すのは数字・小数点・単位だけ。「未満」「以上」「超」「巨大」といった語はそのまま残す
// （原文が持つ意味を落とさないため。数字を含まない "巨大" は素通りする）。
// 前後の空白は落とす（実電文に先頭が全角空白の "　１ｍ" があった）。
function toHalfWidthHeightDesc(s: string): string {
  return s
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, '.')
    .replace(/ｍ/g, 'm')
    .trim()
}

/**
 * 固定付加文の主題を表す鍵を作る。→ {@link import('../types/earthquake').TsunamiWarningComment.key}
 *
 * 値は電文種別。**津波情報（VTSE51）だけは情報名も含める** —— 気象庁はこの種別で
 * 「各地の満潮時刻・津波到達予想時刻に関する情報」と「津波観測に関する情報」を名乗り分けており、
 * 付加文の中身も別物だから。他の種別で情報名を含めないのは、津波警報等（VTSE41）の情報名が
 * 等級とともに変わるため（「津波警報・津波注意報・津波予報」→「津波注意報・津波予報」→
 * 「津波予報」と実電文で 3 回変わった）。含めると、解除済みの等級の避難呼びかけが別の鍵として
 * 画面に残る。
 */
function tsunamiWarningCommentKey(headType: string, infoName: string | undefined): string {
  if (headType !== 'VTSE51') return headType
  if (!infoName) {
    // 情報名が読めないと満潮時刻の報と観測情報の報が同じ鍵へ落ち、続報のマージで片方が消える。
    // **消えたことは画面にもログにも出ない**ので、読めなかった事実をここで残す。
    log.warn(`${TSUNAMI_LOG_PREFIX} 情報名を読めないため固定付加文の主題を分けられません（満潮時刻と観測情報が同じ鍵になります）`)
    return 'VTSE51'
  }
  return `VTSE51|${infoName}`
}

/**
 * 津波電文（VTSE41 / VTSE51 / VTSE52）を読む。
 *
 * `headType` は**電文の中身からは決められない 3 つの判定**に使う。いずれも中身に現れる差は
 * 副作用であって根拠ではないので、種別から立てる。
 *
 * 1. **沖合と沿岸の区別**。VTSE52「沖合の津波観測に関する情報」の観測点は沿岸と「重要」の基準が
 *    違う（→ `tsunami.ts` の `importantBadgeText`）が、電文の中身では区域名が空であることでしか
 *    区別できない
 * 2. **区域ごとの潮位観測点を運ぶ種別か**（`carriesForecastStations`）。「区域に観測点が無い」が
 *    「運ばない種別だから」なのか「気象庁が出さなくなった」なのかを分ける
 *    （→ `tsunami.ts` の `mergeTsunamiAreas`）
 * 3. **固定付加文の主題の鍵**（→ `tsunamiWarningCommentKey`）
 */
export function parseTsunamiFromXml(headType: string, xml: string): JMATsunami | null {
  const doc = parseTelegramXml(xml, TSUNAMI_LOG_PREFIX)
  if (!doc) return null

  const tsunamiOperationStatus = parseOperationStatus(doc)
  const reportDateTime = readReportDateTime(doc, '津波情報', TSUNAMI_LOG_PREFIX)
  // 空文字は undefined に落とす。
  // 「同一イベントか」の判定はどこも falsy 判定で書かれているのに対し、キーの導出側が空文字を
  // 有効な識別子として扱うと、識別子を持たない電文どうしが同じ津波として束ねられる。
  const eventId = xmlText(xmlQ(doc, 'EventID')) || undefined
  const serial = xmlText(xmlQ(doc, 'Serial')) || '1'
  const infoType = xmlText(xmlQ(doc, 'InfoType'))
  const source = parseIssueSourceFromXml(doc)
  // 有効期限。**読めない値は採らない** —— 残すと以後の比較（`new Date(...) <= now`）がすべて
  // 偽へ倒れ、表示は続くのに失効の予約も積まれない津波ができる。消費側（`useEarthquakes.ts`）も
  // 予約を積む直前に同じ検査をしているが、そこを通らない比較が他に 4 箇所ある。
  const validDateTime = readTelegramDateTime(TSUNAMI_LOG_PREFIX, '津波の有効期限', xmlText(xmlQ(doc, 'ValidDateTime'))) || undefined
  // 観測状況を確定した時刻（`Head/TargetDateTime`）。**観測情報の 2 種別だけで読む。**
  //
  // この要素は種別で意味が変わる（電文解説資料 Ⅰ.（ⅱ）3）。津波警報・注意報・予報（VTSE41）は
  // 観測情報ではないので対象外で、実電文でも `ReportDateTime` と一致していた（差 0 秒・8 通）。
  // 観測情報では最大 6 分さかのぼる（VTSE52 で 60〜360 秒・VTSE51 で 0〜120 秒）。
  //
  // **`Head` 直下に限る。** 同名要素が他の位置に現れた電文で取り違えないため
  // （`parseIssueSourceFromXml` が `Control` 直下に限っているのと同じ理由）。
  const tsunamiHeadEl = xmlQ(doc, 'Head')
  const observationDateTime = (headType === 'VTSE51' || headType === 'VTSE52') && tsunamiHeadEl
    ? readObservationDateTime(tsunamiHeadEl)
    : undefined
  // 見出し文。**他の種別と同じ読み手を通す**（→ `readHeadlineText`）——
  // 同じ事実を 2 通りの書き方で表すと、片方だけ静かにずれる。
  const headline = readHeadlineText(doc) || undefined
  // 電文が名乗る情報名（`Head/Title`）。**続報では引き継がない** —— その報が何を出しているかを
  // 表すもので、最新の報の名乗りをそのまま見せる（`useEarthquakes` の続報処理は新しい報を
  // 基に組み立てるため、明示的な引き継ぎを書かない限り自動的にそうなる）。
  const infoName = readInfoName(doc) || undefined
  const commentsEl = xmlQ(doc, 'Comments')
  const warningCommentEl = commentsEl ? xmlQ(commentsEl, 'WarningComment') : null
  const warningCommentText = readCommentText(warningCommentEl, '固定付加文', TSUNAMI_LOG_PREFIX) || undefined
  // 固定付加文は**電文種別ごとに別の話をする**（避難行動／満潮／観測値／沖合）。1 つの枠を
  // 報どうしで奪い合わせると最後に届いた注記しか残らないため、主題を表す鍵を添えて配列で渡し、
  // 続報のマージ（`mergeTsunamiWarningComments`）が束ねる。鍵の作り方は
  // `TsunamiWarningComment.key`（津波情報だけ情報名まで含める）。
  const warningComments = warningCommentText
    ? [{ key: tsunamiWarningCommentKey(headType, infoName), text: warningCommentText }]
    : undefined
  // 区域ごとの潮位観測点を運ぶ種別か。→ `JMATsunami.carriesForecastStations`
  const carriesForecastStations = headType === 'VTSE51'
  // 自由付加文。**地震情報・長周期では読んで出していたのに津波だけ落ちていた。**
  // 種別ごとの定型文（`warningComments`）と違い、続報で実際に書き換わるのはこちら側。
  // `xmlText` が前後の空白だけを落とす（中の改行と整形は保つ）。
  const freeText = (commentsEl ? xmlText(xmlChild(commentsEl, 'FreeFormComment')) : '') || undefined
  // 電文の本文（`Body` 直下の `Text`）。**発表報でも入る** —— 解説資料は取消を「例」として
  // 挙げているだけなのに、かつては取消のときしか拾っていなかった。津波予報（若干の海面変動）
  // では区域に波高も到達時刻も付かないので、いつ来ていつまで続くかはここにしか無い。
  //
  // **取消電文の取消しの概要も同じ要素。** 発表報と取消報で中身が入れ替わるだけなので、
  // 読み取りは 1 箇所に置く（別々に書くと、片方だけ扱いを変えたときに静かにずれる）。
  const tsunamiBodyText = readTsunamiBodyText(doc)
  // この津波を引き起こした地震。**電文は複数持ちうる**（短い間に起きた地震がまとめて
  // 1 つの津波情報になる）。1 件目だけを読むと残りの震源が画面から消える。
  const sourceEarthquakeList = xmlAll(doc, 'Earthquake').map(eqEl => {
    const hypoEl = xmlQ(eqEl, 'Hypocenter')
    // **詳細震央地名を優先する**（地震情報側（`parseEarthquakeFromXml`）と同じ規則）。
    // 国外の地震では `Name` が「中米」のように粗く、`DetailedName` に「メキシコ、チアパス州沿岸」が
    // 入る。津波側だけ粗い名前を出していた。
    const hypoAreaEl = hypoEl ? xmlQ(hypoEl, 'Area') : null
    const hypoName = (hypoAreaEl ? xmlText(xmlQ(hypoAreaEl, 'DetailedName')) : '')
      || (hypoEl ? xmlText(xmlQ(hypoEl, 'Name')) : '')
    // 震源決定機関（`Hypocenter` 直下）。地震情報・長周期と同じ読み手を通す。
    const tsunamiHypoSource = readHypocenterSource(hypoEl)
    const magnitudeEl = xmlQ(eqEl, 'Magnitude')
    const magnitude = magnitudeEl ? parseFloat(xmlText(magnitudeEl)) : NaN
    // 規模が数値で求まらないとき、気象庁は本文を空にして `condition="不明"` を立て、
    // **`description` に理由を書く**（「Ｍ８を超える巨大地震」）。`condition` は「不明」固定なので、
    // それだけでは「観測が足りず不明」と「M8 を超えていて速報できない」を見分けられない。
    // 後者は同じ電文で予想波高が「巨大」「高い」になる場面で、最も伝えるべき事実にあたる。
    const magnitudeCondition = magnitudeEl?.getAttribute('description')?.trim() || undefined
    // マグニチュードの種別。`Mj` は気象庁マグニチュード、`M` は気象庁以外の機関が決めた値で、
    // 実電文では遠地地震による津波（`Source` を伴う電文）に `M` が現れる。画面には出さない。
    const magnitudeType = magnitudeEl?.getAttribute('type')?.trim() || undefined
    // 震央補助表現・座標・震央地名コードは `Hypocenter/Area` 直下、震源決定機関は
    // `Hypocenter` 直下（`Source`）。**位置要素は長周期側と同じ読み手を通す** ——
    // 経路ごとに書くと、いま直したのと同じ取りこぼしがまた起きる。
    //
    // 2 つの時刻は扱いが違う。発生時刻は**読めなくても捨てない** —— `isTsunamiNewFire` が、
    // 識別子が両側そろっていない電文の同一性判定にこの値を使うため、空へ倒すと別々の津波が
    // 同じものとして扱われる。発現時刻は表示にしか使わないので捨てる。
    const sourceOriginTime = xmlText(xmlQ(eqEl, 'OriginTime'))
    warnIfUnreadableDateTime(TSUNAMI_LOG_PREFIX, '原因地震の発生時刻', sourceOriginTime, '同一性の判定に使う')
    const sourceArrivalTime = readTelegramDateTime(TSUNAMI_LOG_PREFIX, '原因地震の発現時刻', xmlText(xmlChild(eqEl, 'ArrivalTime')))
    return {
      hypocenterName: hypoName,
      magnitude: !isNaN(magnitude) ? magnitude : undefined,
      ...(isNaN(magnitude) && magnitudeCondition && { magnitudeCondition }),
      ...(magnitudeType && { magnitudeType }),
      originTime: sourceOriginTime || undefined,
      // 地震発現時刻。**`originTime` へ混ぜない** —— あちらは識別子を持たない電文の
      // 同一性判定に使われている（→ `TsunamiSourceEarthquake.arrivalTime`）。
      ...(sourceArrivalTime && { arrivalTime: sourceArrivalTime }),
      ...(hypoAreaEl && readHypocenterAreaDetail(hypoAreaEl, TSUNAMI_LOG_PREFIX)),
      ...(tsunamiHypoSource && { source: tsunamiHypoSource }),
    }
  // 震源名を読めなかったものは落とす（名前が無いと画面に出しようがない）。
  }).filter(eq => eq.hypocenterName)
  const sourceEarthquakes = sourceEarthquakeList.length > 0 ? sourceEarthquakeList : undefined

  const id = `dmdata-tsunami-${eventId ?? ''}-${serial}`
  const cancelled = infoType === '取消'

  // InfoType=取消: 誤って発表した電文そのものの取消（誤報取消）
  if (cancelled) {
    // 取消しの概要は上で読んだ本文と同じ要素（`Body/Text`）。
    const cancelText = tsunamiBodyText ?? ''
    return { kind: 'tsunami', id, eventId, time: reportDateTime, ...(tsunamiOperationStatus && { operationStatus: tsunamiOperationStatus }), cancelled: true, cancelReason: 'retracted', ...(cancelText && { cancelText }), issue: { source, time: reportDateTime, type: 'Focus' }, areas: [] }
  }

  const forecastEl = xmlQ(doc, 'Forecast')
  const observationEl = xmlQ(doc, 'Observation')

  // Forecast も Observation もなければパース不可
  if (!forecastEl && !observationEl) {
    return dropTelegram(TSUNAMI_LOG_PREFIX, 'Forecast も Observation もありません')
  }

  // 沖合の観測から導いた沿岸への推定（VTSE52 のみ）。観測と同じ電文に入る。
  const estimationEl = xmlQ(doc, 'Estimation')
  const estimationList = estimationEl ? parseTsunamiEstimationsFromXml(estimationEl) : []
  const estimations = estimationList.length > 0 ? estimationList : undefined

  // 沖合の潮位観測点かどうか。「重要」の基準が沿岸と違うためここで分ける。
  const offshore = headType === 'VTSE52'

  // Observation のみ（VTSE51②: 津波観測情報 / VTSE52: 沖合の津波観測に関する情報）
  if (!forecastEl && observationEl) {
    const observations = parseTsunamiObservationsFromXml(observationEl, offshore)
    if (observations.length === 0) {
      return dropTelegram(TSUNAMI_LOG_PREFIX, 'Observation はありますが観測点を 1 件も読めません')
    }
    // **`infoName` と `observationDateTime` をここにも載せる。** この分岐は VTSE52（沖合の津波
    // 観測）と VTSE51 の観測のみ続報が通る主経路で、まさに観測時点が最も効く形。載せ忘れると
    // 「観測 ◯◯ 時点」が肝心の電文で一度も出ない（続報のマージは `?? current` で前報へ倒れる
    // ため、画面には古い時点が残るか、前報が無ければ何も出ない）。
    return { kind: 'tsunami', id, eventId, time: reportDateTime, ...(tsunamiOperationStatus && { operationStatus: tsunamiOperationStatus }), cancelled: false, headline, infoName, warningComments, carriesForecastStations, freeText, bodyText: tsunamiBodyText, sourceEarthquakes, issue: { source, time: reportDateTime, type: 'Focus' }, areas: [], observations, observationDateTime, estimations }
  }

  const allEls = forecastEl!.getElementsByTagName('*')
  const itemEls: Element[] = []
  for (let i = 0; i < allEls.length; i++) {
    if (allEls[i].localName === 'Item') itemEls.push(allEls[i])
  }

  const areas: TsunamiArea[] = []
  // 解除コード（00/50/60）が付いた区域。**`areas` へは積まない**（もう等級が出ていないため）が、
  // 捨てもしない —— 他の区域が残ったまま一部だけ解除された報では、この区域が
  // 「津波注意報が解除されました」として伝わる唯一の手がかりになる
  // （→ `JMATsunami.cancelledAreas`）。全区域がここへ落ちれば正式解除で、下の分岐が拾う。
  const cancelledAreas: TsunamiArea[] = []
  // 解除されたのに前回の等級（`LastKind`）を読めなかった区域の名前。**何から解除されたかを
  // 言えないので伝えようがない**。画面にも音にも出ないため、記録だけ残す。
  const undescribableCancel: string[] = []
  const forecastStationTally = createReadTally('津波の到達予想の観測点')
  // 名前を読めなかった区域は、**等級まで見て 2 つに分ける**。名前だけで一緒くたにすると、
  // まだ有効かもしれない区域を巻き込んで「解除」を発表する（下の判定を参照）。
  //   解除済み       … 解除コード（00/50/60）が読めた。名前が無くてもこの区域は解除されている
  //   解除と言えない … 解除コードではない。**等級が現役と読めたものと、未知コードで本当に
  //                    分からないものの両方が入る**。どちらも「解除ではない」側なので分けない
  let unreadableCancelledCount = 0
  let unreadableActiveCount = 0
  for (const itemEl of itemEls) {
    const areaName = xmlText(xmlQ(itemEl, 'Name'))
    const areaCode = xmlText(xmlQ(itemEl, 'Code')) || undefined
    const kindEl = xmlQ(itemEl, 'Kind')
    const kindCode = kindEl ? xmlText(xmlQ(kindEl, 'Code')) : ''
    let grade = parseTsunamiGradeByCode(kindCode)
    // 前回この区域に発表されていた等級（Category/LastKind/Code）。区域単位の切替・引き上げは
    // これでしか分からない（理由は `TsunamiArea.lastGrade`）。`LastKind` は Item 直下の Category
    // にしか現れないため、子孫全探索でも Station 配下と取り違えない。
    const lastKindEl = xmlQ(itemEl, 'LastKind')
    const lastGrade = parseLastKindGrade(lastKindEl ? xmlText(xmlQ(lastKindEl, 'Code')) : '', TSUNAMI_LOG_PREFIX)
    if (!areaName) {
      if (isKnownCancelCode(kindCode)) unreadableCancelledCount++
      else unreadableActiveCount++
      continue
    }
    if (grade === 'Unknown') {
      if (isKnownCancelCode(kindCode)) {
        // 解除された区域。実電文の `Item` は `Area` と `Category` しか持たないので、
        // 波高・到達時刻・潮位観測点は読まない（下の読み取りへ進ませない）。
        cancelledAreas.push({ grade: 'Unknown', lastGrade, immediate: false, name: areaName, code: areaCode })
        if (lastGrade === undefined) undescribableCancel.push(areaName)
        continue
      }
      // DMD-5: 未知コードは silent lifted 誤認を避けるため Warning 相当で保持し警告する
      log.warn(`[tsunami XML] 未知の Kind/Code: "${kindCode}" → 安全側で Warning として areas 保持`)
      grade = 'Warning'
    }

    const fhEl = xmlQ(itemEl, 'FirstHeight')
    const arrivalTime = readTelegramDateTime(TSUNAMI_LOG_PREFIX, '区域の到達予想時刻', fhEl ? xmlText(xmlQ(fhEl, 'ArrivalTime')) : '')
    const condition = fhEl ? xmlText(xmlQ(fhEl, 'Condition')) : ''

    const mhEl = xmlQ(itemEl, 'MaxHeight')
    const heightEl = mhEl ? xmlQ(mhEl, 'TsunamiHeight') : null
    checkTsunamiHeightType(heightEl, '津波の高さ', '予想区域', areaName)
    const heightVal = heightEl ? parseFloat(xmlText(heightEl)) : NaN
    // description 属性は実電文では入っていた（確かめた範囲は
    // → docs/spec/tsunami-spec.md §6「観測波高の「以上」」）。それでも数値から組む道を残すのは、
    // 属性が空でも波高を出せるようにするため（表示・読み上げは description しか
    // 見ないので、空だと波高が画面から消える）。
    //
    // **数値にならない予想波高は `description` に入る。`condition` ではない。**
    // M8 を超える地震では規模を速報できないため、気象庁は高さを「巨大」「高い」と発表するが、
    // 電文解説資料によれば `condition` は**固定値「不明」**で、定性的表現は `description` の側。
    // 本文は "NaN" になる。
    //
    //     <jmx_eb:TsunamiHeight type="津波の高さ" unit="m" condition="不明"
    //       description="巨大">NaN</jmx_eb:TsunamiHeight>
    //
    // **`condition` を表示文字列のフォールバックに使わないこと。** 定性的表現がない津波注意報・
    // 予報では `description` が空属性になり、そこへ落ちると波高として「不明」と表示・読み上げ
    // することになる（実際にそうなっていた）。数値も語も無ければ波高は持たせない。
    // 読み上げ側は語を補う仕組みを持っている（`ttsText.ts` の `NON_NUMERIC_HEIGHT_PHRASE`）。
    const heightDesc = toHalfWidthHeightDesc(heightEl?.getAttribute('description') ?? '')
      || (!isNaN(heightVal) ? `${heightVal}m` : '')

    // Station 要素（各潮位観測点の満潮時刻・到達予想時刻）
    const stationEls = itemEl.getElementsByTagName('Station')
    const stations: import('../types/earthquake').TsunamiStation[] = []
    for (let i = 0; i < stationEls.length; i++) {
      const st = stationEls[i]
      const stName = xmlText(xmlQ(st, 'Name'))
      const stCode = xmlText(xmlQ(st, 'Code'))
      if (!stName) {
        forecastStationTally.unreadable(stName, stCode)
        continue
      }
      forecastStationTally.readable()
      const highTide = readTelegramDateTime(TSUNAMI_LOG_PREFIX, '満潮時刻', xmlText(xmlQ(st, 'HighTideDateTime'))) || undefined
      const stFhEl = xmlQ(st, 'FirstHeight')
      const stArrival = readTelegramDateTime(TSUNAMI_LOG_PREFIX, '潮位観測点の到達予想時刻', stFhEl ? xmlText(xmlQ(stFhEl, 'ArrivalTime')) : '')
      const stCondition = stFhEl ? xmlText(xmlQ(stFhEl, 'Condition')) : ''
      stations.push({
        name: stName,
        code: stCode,
        highTideDateTime: highTide,
        arrivalTime: stArrival || undefined,
        arrivalCondition: stCondition || undefined,
        // **予想区域の中の潮位観測点も同じ `Revise` を持つ。** 区域側だけ読むと、
        // 同じ電文の同じ意味の要素で扱いが割れる。
        ...(stFhEl && xmlText(xmlChild(stFhEl, 'Revise')) && { revise: xmlText(xmlChild(stFhEl, 'Revise')) }),
      })
    }

    areas.push({
      grade,
      lastGrade,
      immediate: condition === 'ただちに津波来襲と予測',
      name: areaName,
      code: areaCode,
      firstHeight: {
        arrivalTime: arrivalTime || undefined,
        condition,
        // 続報での位置づけ（観測点側の `firstHeightRevise` と同じ軸）。
        ...(fhEl && xmlText(xmlChild(fhEl, 'Revise')) && { revise: xmlText(xmlChild(fhEl, 'Revise')) }),
      },
      // 数値が無くても `description`（「巨大」等）があれば持たせる。`value` は型でも
      // オプショナルで、表示・読み上げはどちらも `description` しか見ない。
      maxHeight: (!isNaN(heightVal) || heightDesc)
        ? { description: heightDesc, ...(!isNaN(heightVal) && { value: heightVal }) }
        : undefined,
      // 大津波警報の区域で予想波高が初めて数値になった／上方修正された合図。
      // 観測・推定の「重要」とは意味が違う（→ TsunamiArea.forecastHeightImportant）。
      forecastHeightImportant: parseTsunamiForecastHeightImportant(mhEl ? xmlText(xmlQ(mhEl, 'Condition')) : undefined),
      stations: stations.length > 0 ? stations : undefined,
    })
  }

  // Forecast があるのに有効エリアが0件 = 気象庁による正式な解除（区域が電文から消える）。
  //
  // **「区域を読めなかった」をここへ流し込まないこと。** 名前が読めない区域を捨てた結果として
  // 0 件になった場合まで解除と解釈すると、電文の構造が変わったときに
  // **「津波警報が解除されました」という事実と逆の内容を発表する**（無言で消えるより重い）。
  // 読めなかった区域が 1 件でもあれば解除と見なさず、電文ごと捨てる。
  // 電文の区域は 3 つのどれかに入る —— **有効**（`areas` へ積んだ）・**解除済み**（解除コードが
  // 読めた。名前の可否を問わない）・**解除と言えない**（名前が読めず、解除コードでもない）。
  //
  // **「解除」と断定してよいのは、解除と言えない区域が 1 つも無いときだけ。** そこには等級が
  // 現役のまま名前だけ壊れた区域が入りうるので、解除として通すと**まだ津波予報・注意報が
  // 出ている区域について「解除されました」と伝える**ことになる。他の区域に解除コードがあることは
  // その区域の解除を意味するだけで、こちらについては何も保証しない。
  //
  // 逆に、有効が 0 で解除と言えない区域も 0 なら、残るのは解除済みだけなので解除として正しい
  // （区域が電文から丸ごと消える通常の全解除も、区域 0 件でここへ来る）。
  const unreadableAreaCount = unreadableCancelledCount + unreadableActiveCount
  if (areas.length === 0 && unreadableActiveCount > 0) {
    return dropTelegram(
      TSUNAMI_LOG_PREFIX,
      `Forecast の区域 ${unreadableActiveCount} 件で名前を読めず、解除済みとも判定できません（解除と取り違えないため電文を捨てます）`,
    )
  }
  // 捨てるほどではないが、読めなかった区域があった事実は残す。
  if (unreadableAreaCount > 0) {
    log.warn(`${TSUNAMI_LOG_PREFIX} Forecast の区域 ${unreadableAreaCount} 件で名前を読めませんでした（うち解除済みと判定できたもの: ${unreadableCancelledCount} 件）`)
  }
  if (areas.length === 0) return { kind: 'tsunami', id, eventId, time: reportDateTime, cancelled: true, cancelReason: 'lifted', issue: { source, time: reportDateTime, type: 'Focus' }, areas: [] }
  warnUndescribableCancel(undescribableCancel, TSUNAMI_LOG_PREFIX)
  forecastStationTally.warnIfNoneReadable(TSUNAMI_LOG_PREFIX)

  // Observation も含む場合（VTSE51①: Forecast + Observation 両方あり）
  const observations = observationEl ? parseTsunamiObservationsFromXml(observationEl, offshore) : undefined

  return { kind: 'tsunami', id, eventId, time: reportDateTime, ...(tsunamiOperationStatus && { operationStatus: tsunamiOperationStatus }), cancelled: false, validDateTime, headline, infoName, warningComments, carriesForecastStations, freeText, bodyText: tsunamiBodyText, sourceEarthquakes, issue: { source, time: reportDateTime, type: 'Focus' }, areas, cancelledAreas: cancelledAreas.length > 0 ? cancelledAreas : undefined, observations: observations && observations.length > 0 ? observations : undefined, observationDateTime, estimations }
}

/**
 * 沖合の観測から導いた沿岸への推定（`Estimation`）を読む。VTSE52 でのみ現れる。
 *
 * 構造は `Forecast` と同じで、`Item` ごとに津波予報区（`Area`）と `FirstHeight` /
 * `MaxHeight` を持つ。**発表中の予想と混ぜない** —— こちらは観測から導いた推定で、
 * 気象庁が発表している予想波高とは別物。
 */
function parseTsunamiEstimationsFromXml(estimationEl: Element): import('../types/earthquake').TsunamiEstimation[] {
  const estimations: import('../types/earthquake').TsunamiEstimation[] = []
  const tally = createReadTally('沖合からの推定')
  for (const itemEl of xmlAll(estimationEl, 'Item')) {
    const areaEl = xmlQ(itemEl, 'Area')
    const name = areaEl ? xmlText(xmlQ(areaEl, 'Name')) : ''
    const code = areaEl ? xmlText(xmlQ(areaEl, 'Code')) : ''
    if (!name) {
      tally.unreadable(name, code)
      continue
    }
    tally.readable()
    const fhEl = xmlQ(itemEl, 'FirstHeight')
    const mhEl = xmlQ(itemEl, 'MaxHeight')
    const heightEl = mhEl ? xmlQ(mhEl, 'TsunamiHeight') : null
    // **推定は観測から導くが、電文は予想側と同じ「津波の高さ」と名乗る**（実電文で確認）。
    checkTsunamiHeightType(heightEl, '津波の高さ', '沿岸への推定', name)
    const heightVal = heightEl ? parseFloat(xmlText(heightEl)) : NaN
    // 予想側・観測側と同じ 2 段で組む（表示文字列 → 数値から組む）。
    // **`condition` をフォールバックに足さないこと。** 固定値「不明」なので、定性的表現の
    // ない津波注意報・予報（解説資料いわく `@description` が空属性になる）でそこへ落ちると、
    // 波高として「不明」と表示・読み上げすることになる。予想側は同じ形を直しており
    // （→ tsunami-spec.md §9「数値にならない予想波高」）、推定側だけ 3 段で残っていた。
    const heightDesc = toHalfWidthHeightDesc(heightEl?.getAttribute('description') ?? '')
      || (!isNaN(heightVal) ? `${heightVal}m` : '')
    // 数値が無い理由（「推定中」）と、基準を超えた合図（「重要」）。
    // **`MaxHeight/Condition` は `DateTime` と `jmx_eb:TsunamiHeight` の代わりに出る**ので
    // （電文解説資料 Ⅱ.13 1-2-2-3）、ここを読まないと「推定中」の沿岸は波高欄が空のままになる。
    const condition = parseTsunamiEstimationCondition(mhEl ? xmlText(xmlQ(mhEl, 'Condition')) : undefined)
    // 2 つの時刻はどちらも表示にしか使わないので、日時として読めなければ捨てる。
    const estArrivalTime = readTelegramDateTime(TSUNAMI_LOG_PREFIX, '沿岸への推定の到達時刻', fhEl ? xmlText(xmlQ(fhEl, 'ArrivalTime')) : '')
    const estMaxHeightDateTime = readTelegramDateTime(TSUNAMI_LOG_PREFIX, '沿岸への推定の最大波の時刻', mhEl ? xmlText(xmlChild(mhEl, 'DateTime')) : '')
    estimations.push({
      name,
      ...(code && { code }),
      ...(estArrivalTime && { arrivalTime: estArrivalTime }),
      // 到達についての説明（「早いところでは既に津波到達と推定」）。**時刻と併存する**ので、
      // 時刻があるかどうかで拾い分けない（理由は TsunamiEstimation.arrivalCondition）。
      ...(fhEl && xmlText(xmlQ(fhEl, 'Condition')) && { arrivalCondition: xmlText(xmlQ(fhEl, 'Condition')) }),
      ...((!isNaN(heightVal) || heightDesc) && {
        maxHeight: { description: heightDesc, ...(!isNaN(heightVal) && { value: heightVal }) },
      }),
      ...(condition && { condition }),
      // 推定した時刻と、続報での位置づけ。観測点側と同じ項目を同じ形で持つ。
      ...(estMaxHeightDateTime && { maxHeightDateTime: estMaxHeightDateTime }),
      ...(fhEl && xmlText(xmlChild(fhEl, 'Revise')) && { firstHeightRevise: xmlText(xmlChild(fhEl, 'Revise')) }),
      ...(mhEl && xmlText(xmlChild(mhEl, 'Revise')) && { maxHeightRevise: xmlText(xmlChild(mhEl, 'Revise')) }),
    })
  }
  tally.warnIfNoneReadable(TSUNAMI_LOG_PREFIX)
  return estimations
}

function parseTsunamiObservationsFromXml(observationEl: Element, offshore: boolean): import('../types/earthquake').TsunamiObservation[] {
  const observations: import('../types/earthquake').TsunamiObservation[] = []
  const tally = createReadTally('津波の観測点')
  const allEls = observationEl.getElementsByTagName('*')
  const itemEls: Element[] = []
  for (let i = 0; i < allEls.length; i++) {
    if (allEls[i].localName === 'Item') itemEls.push(allEls[i])
  }
  for (const itemEl of itemEls) {
    // Item/Area/Name・Code は Item/Station/Code・Item/Category/Kind/Code より文書順で先に出現するため、
    // 既存の areaName 抽出（parseTsunamiFromXml）と同じパターンで先頭マッチを取得すれば Area の値になる。
    const districtName = xmlText(xmlQ(itemEl, 'Name')) || undefined
    const districtCode = xmlText(xmlQ(itemEl, 'Code')) || undefined
    const stationEls = itemEl.getElementsByTagName('Station')
    for (let i = 0; i < stationEls.length; i++) {
      const st = stationEls[i]
      const name = xmlText(xmlQ(st, 'Name'))
      const obsCode = xmlText(xmlQ(st, 'Code'))
      if (!name) {
        tally.unreadable(codeOnlyLabel(obsCode), obsCode)
        continue
      }
      tally.readable()
      const fhEl = xmlQ(st, 'FirstHeight')
      const arrivalTime = readTelegramDateTime(TSUNAMI_LOG_PREFIX, '観測点の第1波の到達時刻', fhEl ? xmlText(xmlQ(fhEl, 'ArrivalTime')) : '')
      const initial = fhEl ? xmlText(xmlQ(fhEl, 'Initial')) : ''
      const mhEl = xmlQ(st, 'MaxHeight')
      // 表示にしか使わないので、日時として読めなければ捨てる。
      const maxHeightDateTime = readTelegramDateTime(TSUNAMI_LOG_PREFIX, '観測点の最大波の時刻', mhEl ? xmlText(xmlChild(mhEl, 'DateTime')) : '')
      const heightEl = mhEl ? xmlQ(mhEl, 'TsunamiHeight') : null
      checkTsunamiHeightType(heightEl, 'これまでの最大波の高さ', '観測点', name)
      const heightVal = heightEl ? parseFloat(xmlText(heightEl)) : NaN
      // 電文が書いた表示文字列。over の判定と下の記録はこの生の値だけを見る
      // （表示のために補った文字列を混ぜると「電文が何と言ったか」が分からなくなる）。
      const rawHeightDesc = heightEl?.getAttribute('description') ?? ''
      // 観測可能範囲を超えた値・機器が被災した値は「〇m以上」の形で発表される。
      // **電文はこれを真偽値では持たない**（`TsunamiHeight` にその属性は無い）ので、
      // 気象庁が組んだ表示文字列である description の文言から復元する。
      // **「以上」が付く実電文は未確認。** 語彙の傍証と、この判定が空振りしうる条件は
      // → docs/spec/tsunami-spec.md §6「観測波高の「以上」」。
      // false ではなく undefined に落とす。「以上」が付かない大多数の観測点に
      // 意味の無いフィールドを持たせない。
      const over = rawHeightDesc.includes('以上') || undefined
      // description が空だと over を復元する手がかりが無い。下には「波高は読めないが
      // over は立っていた」ケースの記録があるのに対し、over は description が
      // 唯一の情報源なので、落ちた事実を残さないと「以上」が黙って通常値として扱われる。
      // 波高そのものが読めない電文は下の height ごと落ちる経路で扱うため、ここでは除く。
      if (!isNaN(heightVal) && !rawHeightDesc) {
        log.warn(`[tsunami XML] 波高の description 属性が空のため「以上」を判定できません: ${name}`)
      }
      // 逆に、数値が読めないのに「以上」が書かれている電文。height ごと落ちるので表示は
      // 変わらないが、痕跡が残らない状態を作らない（上の空 description と対になる記録）。
      if (isNaN(heightVal) && over) {
        log.warn(`[tsunami XML] 「以上」の観測値だが波高が数値として読めません: ${name}`)
      }
      // 表示・読み上げは description しか見ないため、空のまま返すと**利用者から波高が消える**
      // （カードの数値・地図の観測棒のツールチップ・読み上げの数値部分がすべて空になる。
      // overSuffixedHeight は over が無ければ description をそのまま返すだけ）。
      // 予想波高側と同じ形で数値から組む。over は上で生の値から判定済みなので、
      // ここで補った文字列（「以上」を含まない）が判定に混ざることはない。
      // 半角へ直すのは表示に使う側だけ。上の over 判定と記録は生の `rawHeightDesc` を見ている
      // （「電文が何と言ったか」を判定から見えなくしないため）。
      const heightDesc = toHalfWidthHeightDesc(rawHeightDesc) || (!isNaN(heightVal) ? `${heightVal}m` : '')
      observations.push({
        name,
        ...(obsCode && { code: obsCode }),
        height: !isNaN(heightVal) ? { value: heightVal, description: heightDesc, over } : undefined,
        // 欠測・微弱・観測中・重要はここでしか判らない（数値の有無では見分けられない）。
        // 併記されるため読み取りは `parseTsunamiObservationCondition` に任せる。
        condition: parseTsunamiObservationCondition({
          firstHeight: fhEl ? xmlText(xmlQ(fhEl, 'Condition')) : undefined,
          maxHeight: mhEl ? xmlText(xmlQ(mhEl, 'Condition')) : undefined,
          heightCondition: heightEl?.getAttribute('condition') ?? undefined,
        }),
        arrivalTime: arrivalTime || undefined,
        initial: initial || undefined,
        // 沿岸（VTSE51）と沖合（VTSE52）で「重要」の基準が違うため、出所を持ち回す。
        ...(offshore && { offshore: true }),
        // 続報での位置づけ。**値の変化では代わりが利かない信号**を運ぶ
        // （→ `TsunamiObservation.maxHeightRevise`）。
        // `Revise` / `DateTime` は `FirstHeight` / `MaxHeight` の直下にしか現れない。
        // **同じブロックで探索の緩さを揃える** —— 片方が子孫探索だと、入れ子の同名要素が
        // 増えたときにそちらだけ静かにずれる。
        ...(mhEl && xmlText(xmlChild(mhEl, 'Revise')) && { maxHeightRevise: xmlText(xmlChild(mhEl, 'Revise')) }),
        // **第1波側も同じ形で読む。** 最大波だけを読んでいたので、第1波が「追加」なのか
        // 「更新」なのかは値の変化から推し量るしかなかった（電文が直接述べている事実を
        // 代理値で置き換えていた）。
        ...(fhEl && xmlText(xmlChild(fhEl, 'Revise')) && { firstHeightRevise: xmlText(xmlChild(fhEl, 'Revise')) }),
        // 最大波を観測した時刻。**波高の数値だけでは、それがいつの値かが分からない。**
        ...(maxHeightDateTime && { maxHeightDateTime }),
        // 特殊観測機器の名称（Ⅱ.13 1-1-2-2）。沖合の観測点だけが持つ
        ...(xmlText(xmlQ(st, 'Sensor')) && { sensor: xmlText(xmlQ(st, 'Sensor')) }),
        districtCode,
        districtName,
      })
    }
  }
  tally.warnIfNoneReadable(TSUNAMI_LOG_PREFIX)
  return observations
}

// Kind/Code による津波グレード判定（仕様: 気象庁防災情報XML 警報等情報要素コード表）
// 52/53: 大津波警報、51: 津波警報、62: 津波注意報
// 71/72/73: 津波予報（若干の海面変動）、50/60: 解除、00: 津波なし
function parseTsunamiGradeByCode(code: string): TsunamiGrade {
  if (code === '52' || code === '53') return 'MajorWarning'
  if (code === '51') return 'Warning'
  if (code === '62') return 'Watch'
  if (code === '71' || code === '72' || code === '73') return 'Forecast'
  return 'Unknown'
}

// DMD-5: 既知の「解除」相当コード。areas 空の判定で lifted 扱いに落として良いのはこれのみ。
// 未知コードは JMA のコード改定により生じうる。silent に解除扱いにすると警報継続中でも UI が
// 「解除」と表示するため危険。呼び出し側で「grade==='Unknown' かつ !isKnownCancelCode」を
// 検知したら log.warn の上、安全側の grade（Warning）で areas を保持する。
function isKnownCancelCode(code: string): boolean {
  return code === '50' || code === '60' || code === '00'
}

/**
 * 解除された区域（`Kind/Code` = 00/50/60）のうち、**前回の等級を読めなかったもの**を記録する。
 *
 * 解除そのものは `cancelledAreas` で持ち回るので画面にも読み上げにも出る。ただし
 * 「何から解除されたか」は `LastKind` にしか無く、そこが読めないと文にできない
 * （`tsunamiAreaGradeChanges` が遷移元を持たない区域を落とす）。**その区域だけは画面にも音にも
 * 現れない**ので、追う手がかりをここに残す。
 *
 * 実電文で `LastKind` を欠く区域は観測できていない（走査した区域 19,906 件で 0 件。範囲と
 * 数え直す手順は → docs/spec/tsunami-spec.md §10「区域の顔ぶれが報ごとに変わること」）。
 * コード改定で未知の値が来た場合は `parseLastKindGrade` 側でも警告が出る。
 */
function warnUndescribableCancel(cancelledNames: string[], logPrefix: string): void {
  if (cancelledNames.length === 0) return
  log.warn(`${logPrefix} 解除された区域の前回の等級を読めませんでした（解除を伝えられません）: ${cancelledNames.join('・')}`)
}

/**
 * `LastKind/Code`（前回その区域に発表されていた等級）を等級へ写す。
 *
 * **未知コードを `Unknown` のまま採らないこと。** `Unknown` は「前回は津波なし」を意味し、
 * 読み上げでは「〇〇に津波注意報が発表されました」という**別内容の文**に化ける
 * （`ttsText.ts` の `tsunamiAreaGradeChangeToSegments`）。JMA のコード改定で未知コードが来たとき、
 * 事実と違う説明を無警告で出すことになる。判定から外して警告を残す ―― 現在の等級（`Kind/Code`）
 * 側が「安全側の `Warning` へ倒して警告する」のと同じ思想で、こちらは倒す先が無いので諦める。
 *
 * 既知の解除コード（00/50/60）は「前回は津波なし」で正しい。新規発表の第一報がこの形で届く
 * （2024 年能登半島地震の第一報は全区域が `LastKind=00`）。
 */
function parseLastKindGrade(code: string, logPrefix: string): TsunamiGrade | undefined {
  if (!code) return undefined
  const grade = parseTsunamiGradeByCode(code)
  if (grade !== 'Unknown') return grade
  if (isKnownCancelCode(code)) return 'Unknown'
  log.warn(`${logPrefix} 未知の LastKind/Code: "${code}" → 前回の等級を判定しません`)
  return undefined
}

// REST API 経由の JMA XML（VXSE62: 長周期地震動観測情報）を JMALpgm にパース
/**
 * 周期帯の番号（`PeriodicBand`）の値域。気象庁は 1.5〜2.5 秒台を第 1 帯とし、
 * 1 秒刻みで 7.5〜8.5 秒台の第 7 帯まで置く（電文解説資料 Ⅱ.37 2-1-6・2-1-7）。
 */
const LPGM_PERIOD_BAND_MAX = 7

/**
 * 観測点の周期帯ごとの内訳（`LgIntPerPeriod` / `SvaPerPeriod`）。
 *
 * **帯は `PeriodicBand` 属性が決める。** 文書順に並んでいる前提で番号を振ると、
 * 帯が 1 つ欠けた電文で以後がすべて 1 つずつずれる（値は妥当な形をしているので画面にも
 * 異常として出ない）。**値域（1〜7）の外も捨てる** —— 表示側は「周期不明」へ倒すので
 * 画面は壊れないが、そのままでは電文の書式が変わったことに誰も気づけない。
 *
 * **階級 0 の帯も持つ。** 0 は「その周期帯では該当なし」を表す正常な値で、落とすと
 * 「短い周期だけが強く出た」形が「短い周期しか観測していない」ように見える。
 *
 * **記録は電文ごとに 1 行へまとめる**（`ReadTally`）。この要素は 1 電文に数千個ある
 * （能登本震の実電文で観測点 198 × 帯 7 × 2 種 ＝ 2772 個）。1 件ずつ記録すると、
 * 書式が変わったとき数千行が一度に出て他の警告が埋もれる。
 */
function readLpgmPeriodBands(
  stEl: Element,
  tally: ReadTally,
): import('../types/earthquake').LpgmPeriodBand[] {
  const byBand = new Map<number, import('../types/earthquake').LpgmPeriodBand>()
  const put = (el: Element, key: 'lgInt' | 'sva') => {
    const rawBand = el.getAttribute('PeriodicBand') ?? ''
    const band = parseInt(rawBand, 10)
    const raw = xmlText(el)
    const value = parseFloat(raw)
    const bandOk = Number.isInteger(band) && band >= 1 && band <= LPGM_PERIOD_BAND_MAX
    // 階級は 1〜4 の階級表に載る値だけを採る（0 は「該当なし」で正常なのでそのまま通す）。
    // 応答スペクトルは物理量なので負値だけ弾く。
    const valueOk = key === 'lgInt'
      ? Number.isInteger(value) && (value === 0 || isValidLpgmClass(value))
      : Number.isFinite(value) && value >= 0
    if (!bandOk || !valueOk) {
      tally.unreadable(`${el.localName}[${rawBand}]`, raw)
      return
    }
    tally.readable()
    const rec = byBand.get(band) ?? { band }
    rec[key] = value
    byBand.set(band, rec)
  }
  for (const el of xmlAll(stEl, 'LgIntPerPeriod')) put(el, 'lgInt')
  for (const el of xmlAll(stEl, 'SvaPerPeriod')) put(el, 'sva')
  return [...byBand.values()].sort((a, b) => a.band - b.band)
}

export function parseLpgmFromXml(xml: string): JMALpgm | null {
  const doc = parseTelegramXml(xml, DMDATA_LOG_PREFIX)
  if (!doc) return null
  // 電文の運用種別（`Control/Status`）。**全種別に付ける** —— ヘッダ部の要素なので、
  // 種別によって付けたり付けなかったりすると、試験報の印が電文の種類次第で出たり出なかったりする。
  const lpgmOperationStatus = parseOperationStatus(doc)

  const reportDateTime = readReportDateTime(doc, '長周期地震動観測情報', DMDATA_LOG_PREFIX)
  const eventId        = xmlText(xmlQ(doc, 'EventID'))
  const serial         = xmlText(xmlQ(doc, 'Serial')) || '1'
  const infoType       = xmlText(xmlQ(doc, 'InfoType'))
  const id             = `dmdata-lpgm-${eventId}-${serial}`
  const cancelled      = infoType === '取消'

  const earthquakeEl = xmlQ(doc, 'Earthquake')
  // **読めない値でも捨てない。** この要素が無いと電文ごと落とす作り（次の行）なので、
  // 捨てると階級の情報まで道連れになる。読み上げ側（`ttsText.ts` の `lpgmToText`）が
  // 時刻の句ごと落として受け止める。
  const originTime   = earthquakeEl ? xmlText(xmlQ(earthquakeEl, 'OriginTime')) : ''
  warnIfUnreadableDateTime(DMDATA_LOG_PREFIX, '長周期地震動観測情報の地震発生時刻', originTime, 'この要素が無いと電文ごと落とす')

  if (cancelled) return { ...(lpgmOperationStatus && { operationStatus: lpgmOperationStatus }), id, eventId, time: reportDateTime, originTime, maxClass: 0, cancelled: true }
  if (!originTime) return dropTelegram(DMDATA_LOG_PREFIX, 'VXSE62（長周期地震動観測情報）に OriginTime がありません')

  // VXSE62 XML: Intensity > Observation > MaxLgInt が最大長周期地震動階級
  const obsEl       = xmlQ(doc, 'Observation')
  const maxClassStr = obsEl ? xmlText(xmlQ(obsEl, 'MaxLgInt')) : ''
  const maxClass    = parseInt(maxClassStr, 10)

  // **階級 0 と「読めない」を同じ `return null` に落とさないこと。** 0 は「階級1以上を
  // 観測していない」という正常な報で、記録すると長周期地震動を伴わない地震のたびに鳴る。
  // 読めない値（欠損・想定外の表記）は電文を捨てた理由として残す。区域・観測点の階級で
  // 同じ区別をしているのに、それを読みにいくかを決めるこのゲートだけ素通しだった。
  if (maxClass === 0) return null
  if (!(maxClass >= 1 && maxClass <= 4)) {
    return dropTelegram(DMDATA_LOG_PREFIX, `VXSE62 の最大長周期地震動階級を読めません: "${maxClassStr}"`)
  }

  // 観測点・細分区域データを抽出
  const points: import('../types/earthquake').LpgmPoint[] = []
  const regions: import('../types/earthquake').LpgmRegion[] = []
  const prefs: import('../types/earthquake').LpgmPref[] = []
  // 震度点と同じ構造の穴がここにもある。**数えるのは「階級として読めたか」で、階級 0 は
  // 読めている**（該当なしを表す正常な値）。0 を落ちた扱いにすると平常時に鳴り続ける。
  const lgRegionTally = createReadTally('長周期地震動の区域')
  const lgStationTally = createReadTally('長周期地震動の観測点')
  // **震度も階級と同じ規律で数える。** 隣の `MaxLgInt` は全滅すれば警告が出るのに、
  // 併記のために足した `MaxInt` 側だけ黙って落ちる、という非対称を作らないため。
  const lgIntensityTally = createReadTally('長周期地震動の電文に入っている震度')
  // 周期帯は 1 電文に 800 個を超えるので、1 件ずつではなく電文ごとに 1 行へまとめる。
  const lgPeriodTally = createReadTally('長周期地震動の周期帯')

  const allEls = doc.getElementsByTagName('*')
  const prefEls: Element[] = []
  for (let i = 0; i < allEls.length; i++) {
    if (allEls[i].localName === 'Pref') prefEls.push(allEls[i])
  }
  for (const prefEl of prefEls) {
    // DMD-6: Pref 配下には Area/Name（孫要素）も存在するため、xmlQ（子孫全体検索）は
    // 文書順で先に出た方を拾って誤検出しうる。Pref 直下の Name だけを取る xmlChild に置換。
    const prefName = xmlText(xmlChild(prefEl, 'Name'))
    const prefCode = xmlText(xmlChild(prefEl, 'Code'))
    // 都道府県の最大値。**区域から計算し直さない** —— 気象庁が電文に書いている値を使う
    // （積み上げると、区域を 1 つ読み落としたときに静かにずれる）。
    // **採用の基準は区域（`regions`）と揃える** —— 階級 1 以上だけを積む。同じ関数の中で
    // 同じ性質の値に別の基準を当てると、次に触る人がどちらが正しいのか読めない。
    const prefRawLgInt = xmlText(xmlChild(prefEl, 'MaxLgInt'))
    const prefMaxLgInt = parseInt(prefRawLgInt, 10)
    const prefRawInt = xmlText(xmlChild(prefEl, 'MaxInt'))
    const prefMaxInt = readIntensity(prefRawInt || null).scale
    if (prefRawInt) {
      if (prefMaxInt >= 0) lgIntensityTally.readable()
      else lgIntensityTally.unreadable(prefName || codeOnlyLabel(prefCode), prefRawInt)
    }
    // 続報での変化（`Revise`）。地震情報と同じ扱い（→ `EarthquakePoint.revise`）。
    // **直下に限る** —— 配下の Area も同名要素を持つ。
    const prefLgRevise = xmlText(xmlChild(prefEl, 'Revise'))
    if (isValidLpgmClass(prefMaxLgInt)) {
      prefs.push({
        code: xmlText(xmlChild(prefEl, 'Code')),
        name: prefName,
        maxLgInt: prefMaxLgInt,
        ...(prefMaxInt >= 0 && { maxInt: prefMaxInt }),
        ...(prefLgRevise && { revise: prefLgRevise }),
      })
    }
    const prefChildren = prefEl.getElementsByTagName('*')
    const areaElsArr: Element[] = []
    for (let i = 0; i < prefChildren.length; i++) {
      if (prefChildren[i].localName === 'Area') areaElsArr.push(prefChildren[i])
    }
    for (const areaEl of areaElsArr) {
      // DMD-6: xmlQ は子孫全体検索のため、Area 配下に別の Name/Code（例: 観測点の Name）
      // があると先に出た方を拾って誤検出する可能性がある。Area 直下の要素だけを取る
      // xmlChild に置換してレイアウト変更に対する脆弱性を減らす。
      // MaxLgInt も同様（Area 直下と City 直下に同名要素あり）。
      const areaName    = xmlText(xmlChild(areaEl, 'Name'))
      const areaCode    = xmlText(xmlChild(areaEl, 'Code'))
      const areaRawLgInt = xmlText(xmlChild(areaEl, 'MaxLgInt'))
      const areaMaxLgInt = parseInt(areaRawLgInt, 10)
      // 区域の最大震度。階級と並べると「揺れは小さいのに高層階が大きく揺れた」形が出る。
      const areaRawInt = xmlText(xmlChild(areaEl, 'MaxInt'))
      const areaMaxInt = readIntensity(areaRawInt || null).scale
      if (areaRawInt) {
        if (areaMaxInt >= 0) lgIntensityTally.readable()
        else lgIntensityTally.unreadable(areaName || codeOnlyLabel(areaCode), areaRawInt)
      }
      // 続報での変化（`Revise`）。都道府県側と同じ扱い（解説資料 Ⅱ.37 2-1-5-4-3）。
      const areaLgRevise = xmlText(xmlChild(areaEl, 'Revise'))
      if (Number.isFinite(areaMaxLgInt)) {
        lgRegionTally.readable()
        if (areaMaxLgInt >= 1) {
          regions.push({
            code: areaCode, name: areaName, maxLgInt: areaMaxLgInt, pref: prefName,
            ...(areaMaxInt >= 0 && { maxInt: areaMaxInt }),
            ...(areaLgRevise && { revise: areaLgRevise }),
          })
        }
      } else {
        lgRegionTally.unreadable(areaName || codeOnlyLabel(areaCode), areaRawLgInt)
      }

      const areaChildren = areaEl.getElementsByTagName('*')
      for (let i = 0; i < areaChildren.length; i++) {
        if (areaChildren[i].localName !== 'IntensityStation') continue
        const stEl  = areaChildren[i]
        // IntensityStation 直下には Name/Code/LgInt しかなく、これらと同名の子孫要素は
        // 存在しないため xmlQ（子孫検索）でも xmlChild と同じ結果になる（DMD-6 対象外）。
        // **地震情報側と同じく印を外す。** 外していなかったため、印の付く観測点が
        // 座標表に当たらず**地図から消えていた**（実電文で 11 点）。
        const { name: stName, nonJma: stNonJma } = stripNonJmaMark(xmlText(xmlQ(stEl, 'Name')))
        const stCode = xmlText(xmlQ(stEl, 'Code'))
        const stRawLgInt = xmlText(xmlChild(stEl, 'LgInt'))
        const lgInt  = parseInt(stRawLgInt, 10)
        // 観測点の震度と絶対速度応答スペクトル、周期帯ごとの内訳。
        // **`Int` は `xmlChild` で取る** —— `LgInt` と前方一致しないので誤りはしないが、
        // 直下だけを見る形に揃えておく（この電文は同名要素を入れ子にしないが、
        // 揃えておかないと構造が変わったときに静かに別の値を拾う）。
        const stRawInt = xmlText(xmlChild(stEl, 'Int'))
        const stInt = readIntensity(stRawInt || null).scale
        if (stRawInt) {
          if (stInt >= 0) lgIntensityTally.readable()
          else lgIntensityTally.unreadable(stName || codeOnlyLabel(stCode), stRawInt)
        }
        // 応答スペクトルは物理量なので負値は採らない（読めない値と同じ扱い）
        const stRawSva = xmlText(xmlChild(stEl, 'Sva'))
        const stSva = parseFloat(stRawSva)
        const periods = readLpgmPeriodBands(stEl, lgPeriodTally)
        if (Number.isFinite(lgInt)) {
          lgStationTally.readable()
          if (lgInt >= 1) {
            points.push({
              // **区域は電文の入れ子からしか拾えない**（→ `LpgmPoint.area`）。
              // ここで拾わないと、カードの「県 → 区域 → 観測点」で行き先が決まらない。
              code: stCode, name: stName, pref: prefName, ...(areaName && { area: areaName }), lgInt,
              ...(stNonJma && { nonJma: true }),
              ...(stInt >= 0 && { int: stInt }),
              ...(Number.isFinite(stSva) && stSva >= 0 && { sva: stSva }),
              ...(periods.length > 0 && { periods }),
            })
          }
        } else {
          lgStationTally.unreadable(stName || codeOnlyLabel(stCode), stRawLgInt)
        }
      }
    }
  }

  lgRegionTally.warnIfNoneReadable(DMDATA_LOG_PREFIX)
  lgStationTally.warnIfNoneReadable(DMDATA_LOG_PREFIX)
  lgIntensityTally.warnIfNoneReadable(DMDATA_LOG_PREFIX)
  lgPeriodTally.warnIfNoneReadable(DMDATA_LOG_PREFIX)
  warnIfNoLpgmRegions(maxClass, regions.length, DMDATA_LOG_PREFIX)
  const lpgmInfoName = readInfoName(doc)

  // 長周期地震動に関する観測情報の種類（Ⅱ.37 2-1-4）。値域は "1"〜"4"。
  // **読めない値は持たせない**（分類が無いことと、知らない分類が来たことを区別する必要はない
  // ——どちらも「意味を出せない」に落ちる）。値域の外は記録して捨てる。
  const categoryStr = obsEl ? xmlText(xmlQ(obsEl, 'LgCategory')) : ''
  const category = parseInt(categoryStr, 10)
  if (categoryStr && !(category >= 1 && category <= 4)) {
    log.warn(`${DMDATA_LOG_PREFIX} 長周期地震動の観測情報の種類を読めません（無視します）: "${categoryStr}"`)
  }
  const categoryValue = category >= 1 && category <= 4 ? category : undefined

  // 全国の最大震度。最大階級と並べて出すと「震度は大きくないのに高層階が大きく揺れた」
  // 地震かどうかがひと目で分かる。
  const obsRawInt = obsEl ? xmlText(xmlChild(obsEl, 'MaxInt')) : ''
  const obsMaxInt = readIntensity(obsRawInt || null).scale
  if (obsRawInt && obsMaxInt < 0) {
    log.warn(`${DMDATA_LOG_PREFIX} VXSE62 の全国の最大震度を読めません（無視します）: "${obsRawInt}"`)
  }

  // 震源の要素。**読んで持つが、画面には出していない**（→ `LpgmHypocenter`）。
  // 同じ地震の震源・規模は地震カードが出すため重複する。電文が持っているものを落とさない
  // ために保持している。
  const lpgmHypoEl = earthquakeEl ? xmlQ(earthquakeEl, 'Hypocenter') : null
  const lpgmHypoAreaEl = lpgmHypoEl ? xmlQ(lpgmHypoEl, 'Area') : null
  let lpgmHypocenter: import('../types/earthquake').LpgmHypocenter | undefined
  if (lpgmHypoAreaEl) {
    // **詳細震央地名を優先する**（地震情報・津波と同じ規則）。国外の地震では `Name` が
    // 「中米」のように粗く、`DetailedName` に「メキシコ、チアパス州沿岸」が入る。
    // 長周期だけ粗い名前を持っていた。
    const name = xmlText(xmlChild(lpgmHypoAreaEl, 'DetailedName'))
      || xmlText(xmlChild(lpgmHypoAreaEl, 'Name'))
    // 座標・震央地名コード・震央補助表現は津波側と同じ読み手を通す（→ `readHypocenterAreaDetail`）。
    // 震源決定機関は `Area` の外にあるので別に読む（→ `readHypocenterSource`）。
    if (name) {
      const lpgmSource = readHypocenterSource(lpgmHypoEl)
      lpgmHypocenter = {
        name,
        ...readHypocenterAreaDetail(lpgmHypoAreaEl, DMDATA_LOG_PREFIX),
        ...(lpgmSource && { source: lpgmSource }),
      }
    }
  }
  const lpgmMagnitudeEl = earthquakeEl ? xmlQ(earthquakeEl, 'Magnitude') : null
  const lpgmMagnitude = lpgmMagnitudeEl ? parseFloat(xmlText(lpgmMagnitudeEl)) : NaN
  // 規模が数値にならないときの説明（「Ｍ８を超える巨大地震」）と種別（`Mj` / `M`）。
  // **地震情報・津波では読んでいたのに、長周期だけ読んでいなかった。** 解説資料 Ⅱ.37 2-4 は
  // 他の種別と同じく M8 超えの事例を載せている。
  const lpgmMagnitudeCondition = Number.isFinite(lpgmMagnitude)
    ? undefined
    : (lpgmMagnitudeEl?.getAttribute('description')?.trim() || undefined)
  const lpgmMagnitudeType = lpgmMagnitudeEl?.getAttribute('type')?.trim() || undefined
  const lpgmArrivalTime = readTelegramDateTime(DMDATA_LOG_PREFIX, '長周期地震動観測情報の地震発現時刻', earthquakeEl ? xmlText(xmlChild(earthquakeEl, 'ArrivalTime')) : '')

  // 付加文と、気象庁の詳細ページ。**アプリが出せない情報（波形・スペクトル）の在りかを
  // 電文自身が示している**ので、そこへ行ける導線を残す。
  const lpgmCommentsEl = xmlQ(doc, 'Comments')
  const lpgmForecastEl = lpgmCommentsEl ? xmlChild(lpgmCommentsEl, 'ForecastComment') : null
  const lpgmForecastText = readCommentText(lpgmForecastEl, '固定付加文', DMDATA_LOG_PREFIX)
  const lpgmVarEl = lpgmCommentsEl ? xmlChild(lpgmCommentsEl, 'VarComment') : null
  const lpgmVarText = readCommentText(lpgmVarEl, '固定付加文（その他）', DMDATA_LOG_PREFIX)
  const lpgmFreeText = lpgmCommentsEl ? xmlText(xmlChild(lpgmCommentsEl, 'FreeFormComment')) : ''
  const lpgmUri = lpgmCommentsEl ? xmlText(xmlChild(lpgmCommentsEl, 'URI')) : ''
  const lpgmHeadline = readHeadlineText(doc)

  return {
    ...(lpgmOperationStatus && { operationStatus: lpgmOperationStatus }),
    ...(lpgmInfoName && { infoName: lpgmInfoName }),
    id, eventId, time: reportDateTime, originTime, maxClass, cancelled: false, points, regions,
    ...(prefs.length > 0 && { prefs }),
    ...(obsMaxInt >= 0 && { maxInt: obsMaxInt }),
    ...(Number.isFinite(lpgmMagnitude) && { magnitude: lpgmMagnitude }),
    ...(lpgmMagnitudeCondition && { magnitudeCondition: lpgmMagnitudeCondition }),
    ...(lpgmMagnitudeType && { magnitudeType: lpgmMagnitudeType }),
    ...(lpgmArrivalTime && { arrivalTime: lpgmArrivalTime }),
    ...(lpgmHypocenter && { hypocenter: lpgmHypocenter }),
    ...(lpgmForecastText && { forecastText: lpgmForecastText }),
    ...(lpgmVarText && { varCommentText: lpgmVarText }),
    ...(lpgmFreeText && { freeFormText: lpgmFreeText }),
    ...(lpgmUri && { uri: lpgmUri }),
    // 見出し文。地震情報と同じ扱い（持つだけで画面には出さない）。
    ...(lpgmHeadline && { headline: lpgmHeadline }),
    ...(categoryValue && { category: categoryValue }),
  }
}

// 臨時情報の段階。Head/Title（情報名）の括弧内に現れるキーワードで判別する。
// 「調査終了」と「調査中」は互いに部分文字列にならないため、並び順に依存しない。
/**
 * 南海トラフ地震臨時情報の段階（気象庁「地震関連情報番号コード」）。
 *
 * 値は気象庁のコード表（`EarthquakeInformation` コード表・種別「地震関連情報番号」）そのまま。
 * **調査中に 3 つあるのは発表の契機が違うため**（111＝監視領域内の M6.8 以上の地震、
 * 112＝ひずみ計の有意な変化、113＝その他の現象）。段階としてはどれも「調査中」で、
 * いまは画面・読み上げとも契機を出し分けていない。
 */
const NANKAI_STAGE_BY_CODE: Readonly<Record<string, string>> = {
  '111': '調査中',
  '112': '調査中',
  '113': '調査中',
  '120': '巨大地震警戒',
  '130': '巨大地震注意',
  '190': '調査終了',
}

/**
 * 段階の名称。`InfoSerial` を読めなかった電文で `Head/Title` から拾うための落とし先。
 *
 * **一次情報源は `InfoSerial`**（上の表）。`Head/Title` は電文がそこから組み立てた結果で、
 * 文字列の一致に頼ると表記が変わった日に黙って読めなくなる。ただし `InfoSerial` は
 * 電文仕様上は省略可（0 回/1 回）なので、落とし先は残す。
 */
const NANKAI_STAGE_KEYWORDS: readonly string[] = ['巨大地震警戒', '巨大地震注意', '調査終了', '調査中']

/** 解説情報が `Body/EarthquakeInfo/InfoKind` に名乗る値（電文解説資料 Ⅱ.41 1-1）。 */
const NANKAI_COMMENTARY_INFO_KIND = '南海トラフ地震関連解説情報'

/**
 * 解説情報の地震関連情報番号コード（200＝定例解説／210・219＝臨時解説）。
 *
 * **臨時情報と同じ番号体系にある。** 段階のコードだけを見ると解説情報を段階として読むので、
 * 段階の判定から明示的に外す。
 */
const NANKAI_COMMENTARY_CODES: ReadonlySet<string> = new Set(['200', '210', '219'])

// REST API 経由の JMA XML（VYSE50: 南海トラフ地震臨時情報）を JMANankai にパース。
// 段階を判別できない電文（= 解説情報 VYSE51/52）は null を返す。解説情報は
// parseNankaiCommentaryFromXml で別の型に読む。
//
// 段階の一次情報源は Body/EarthquakeInfo/InfoSerial（地震関連情報番号コード。電文解説資料 Ⅱ.41 1-2）。
// 実電文（2024-08-08 の 2 通）でも `<InfoSerial codeType="地震関連情報番号コード"><Name>調査中</Name>
// <Code>111</Code></InfoSerial>` の形で入っていた。**実電文で裏が取れているのは 111（調査中）と
// 130（巨大地震注意）の 2 つだけ**で、残りは公開コード表からの写し（120・190 が発表された
// ことは過去に一度も無い）。食い違いに気づけるよう、表と電文の名乗りがずれたら記録を残す。
//
// **Head/InfoKind は使えない。** 実電文 14 通すべてで「南海トラフ地震に関連する情報」で
// 固定されており、段階のキーワードを含まない（以前はここを見ていて、どの電文も既定値の
// 「調査中」に落ちていた）。**Head/Title は落とし先**——段階は読めるが、電文が `InfoSerial` から
// 組み立てた結果なので文字列の一致に頼ることになる。
export function parseNankaiFromXml(xml: string): JMANankai | null {
  const doc = parseTelegramXml(xml, DMDATA_LOG_PREFIX)
  if (!doc) return null
  // 電文の運用種別（`Control/Status`）。**全種別に付ける** —— ヘッダ部の要素なので、
  // 種別によって付けたり付けなかったりすると、試験報の印が電文の種類次第で出たり出なかったりする。
  const nankaiOperationStatus = parseOperationStatus(doc)

  const reportDateTime = readReportDateTime(doc, '南海トラフ地震臨時情報', DMDATA_LOG_PREFIX)
  const eventId        = xmlText(xmlQ(doc, 'EventID'))
  const serial         = xmlText(xmlQ(doc, 'Serial')) || '1'
  const infoType       = xmlText(xmlQ(doc, 'InfoType'))
  const id             = `dmdata-nankai-${eventId}-${serial}`

  // 取消は「その電文を撤回する」だけで、段階の判断を含まない（電文解説資料 Ⅰ.別紙ウ
  // 「取消電文の運用」）。**`kindName` に「調査終了」を詰めない** —— 調査終了は
  // 「調べた結果、可能性は通常の範囲内だった」という気象庁の判断で、意味が正反対になる。
  // 取り消された事実は `retracted` で持ち、帯を引っ込める点だけ `cancelled` を共有する。
  //
  // 取消の理由は `Body/Text` に入ると資料が定めているので拾う。**いまは画面に出ない**（帯は取消で
  // 引っ込むため）。将来ログや画面へ出す余地を残すために持たせている。
  if (infoType === '取消') {
    const cancelBodyEl = xmlQ(doc, 'Body')
    return {
      ...(nankaiOperationStatus && { operationStatus: nankaiOperationStatus }),
      id, time: reportDateTime, eventId,
      kindCode: '', kindName: '',
      headline: '南海トラフ地震臨時情報（取消）',
      body: cancelBodyEl ? xmlText(xmlQ(cancelBodyEl, 'Text')) : '',
      cancelled: true, retracted: true, reportDateTime,
    }
  }

  // Head > Title が情報名（ヘッドライン兼、段階の判定元）
  const headEl   = xmlQ(doc, 'Head')
  const headline = headEl ? xmlText(xmlQ(headEl, 'Title')) : ''

  const stage = resolveNankaiStage(doc, headline)
  // 段階が読めない電文は臨時情報ではない（解説情報など）。既定値で「調査中」を騙るより
  // 呼び出し側に判断を返す。
  if (!stage) return null

  // 本文は EarthquakeInfo 直下の Text（解説情報側の parseNankaiCommentaryFromXml と揃える）。
  // 実電文の VYSE50 に Comment 要素は無いが、他の地震電文と同じ形が来たときの保険として先に見る。
  // Body 直下のフォールバックは、EarthquakeInfo を持たない電文形のため。
  const bodyEl      = xmlQ(doc, 'Body')
  const commentEl   = bodyEl ? xmlQ(bodyEl, 'Comment') : null
  const quakeInfoEl = bodyEl ? xmlQ(bodyEl, 'EarthquakeInfo') : null
  const bodyText  = (commentEl ? xmlText(xmlQ(commentEl, 'Text')) : '')
    || (quakeInfoEl ? xmlText(xmlQ(quakeInfoEl, 'Text')) : '')
    || (bodyEl ? xmlText(xmlQ(bodyEl, 'Text')) : '')

  return {
    ...(nankaiOperationStatus && { operationStatus: nankaiOperationStatus }),
    id, time: reportDateTime, eventId,
    kindCode: stage.code, kindName: stage.name,
    headline, body: bodyText,
    // 見出し文・次回発表予定・参考情報。解説情報（VYSE51/52）と同じ読み手を通す。
    ...readEarthquakeInfoMeta(doc),
    // 調査終了で帯を引っ込める。**コードではなく名称で見る**——`InfoSerial` を読めず
    // `Head/Title` へ落ちた電文はコードを持たないため、コードで判定すると帯が残る。
    cancelled: stage.name === '調査終了', reportDateTime,
  }
}

/**
 * 南海トラフ地震臨時情報の段階を決める。臨時情報でなければ `null`。
 *
 * `InfoSerial/Code` を先に見て、読めなければ `Head/Title` のキーワードへ落とす。
 * **落ちたことは記録する** —— 段階そのものは読めているので画面には異常が出ず、
 * 一次情報源が消えたことに気づく手がかりが他に無い。
 */
function resolveNankaiStage(doc: Document, headline: string): { code: string; name: string } | null {
  const bodyEl = xmlQ(doc, 'Body')
  const quakeInfoEl = bodyEl ? xmlQ(bodyEl, 'EarthquakeInfo') : null
  // **臨時情報と解説情報は電文自身が名乗り分けている**（Ⅱ.41 1-1「”南海トラフ地震臨時情報”
  // 又は”南海トラフ地震関連解説情報”を記載する」）。段階のコードは両者で同じ番号体系を使う
  // （200/210/219 が解説情報）ので、ここで先に分けないと解説情報を段階として読んでしまう。
  // **Head/InfoKind ではない** —— あちらは「南海トラフ地震に関連する情報」で固定。
  const infoKind = quakeInfoEl ? xmlText(xmlQ(quakeInfoEl, 'InfoKind')) : ''
  if (infoKind === NANKAI_COMMENTARY_INFO_KIND) return null

  const serialEl = quakeInfoEl ? xmlQ(quakeInfoEl, 'InfoSerial') : null
  const code = serialEl ? xmlText(xmlQ(serialEl, 'Code')) : ''
  const serialName = serialEl ? xmlText(xmlQ(serialEl, 'Name')) : ''

  const known = NANKAI_STAGE_BY_CODE[code]
  if (known) {
    // **表と電文の名乗りが食い違ったら黙って通さない。** 表は気象庁の公開コード表を写したものだが、
    // 実電文で裏を取れているのは 111（調査中）と 130（巨大地震注意）の 2 つだけ。残り 4 つは
    // 過去に発表されたことが無く、写し間違いや改訂に気づく手立てが他に無い。
    if (serialName && serialName !== known) {
      log.warn(`[dmdata] 南海トラフ臨時情報のコードと名称が食い違います: ${code}（表では"${known}"）／電文の名称は"${serialName}"`)
      // **電文が段階名を名乗っているならそちらを採る。** 表が古い可能性のほうを先に潰す ——
      // 取り違えの向きによっては、巨大地震警戒の報を調査終了として帯ごと消しかねない。
      // 名乗りが段階名そのものでない（表記ゆれ・注記付き）ときは表を採る（アプリ内の判定は
      // `kindName` の一致で書かれているため、揺れた文字列を通すとそちらが崩れる）。
      if (NANKAI_STAGE_KEYWORDS.includes(serialName)) return { code, name: serialName }
    }
    return { code, name: known }
  }

  // **解説情報のコードは段階として通さない。** 上の `InfoKind` の分岐で弾けているはずだが、
  // その 1 枚だけに頼ると、名乗りが揺れた電文で解説情報が「段階」として画面へ出る。
  if (NANKAI_COMMENTARY_CODES.has(code)) return null

  // コードは読めたが表に無い。気象庁が段階を増やした場合で、電文の `Name` をそのまま使う。
  // **既定値へ丸めない** —— 知らない段階を「調査中」と名乗ると、警戒の報を軽く見せうる。
  // **帯を引っ込めるかは名称の一致（`kindName === '調査終了'`）で決まる**ので、終了に相当する
  // 段階が新しい名前で来た場合は帯が残る。軽く見せない側を優先した結果として受け入れている。
  if (code && serialName) {
    log.warn(`[dmdata] 南海トラフ臨時情報に未知の地震関連情報番号コードがあります（名称をそのまま使います）: ${code} "${serialName}"`)
    return { code, name: serialName }
  }

  const keyword = NANKAI_STAGE_KEYWORDS.find(k => headline.includes(k))
  if (!keyword) return null
  log.warn(`[dmdata] 南海トラフ臨時情報の InfoSerial を読めないため Head/Title から段階を採ります: "${headline}"`)
  return { code: '', name: keyword }
}

// REST API 経由の JMA XML（VYSE51/52: 南海トラフ地震関連解説情報）を JMANankaiCommentary に
// パース。段階を持つ電文（= 臨時情報 VYSE50）は null を返す。
//
// 種別は Body/EarthquakeInfo/InfoSerial（地震関連情報番号コード）で判別する。コード表が定める
// 解説情報の値は 200＝定例解説／210＝臨時解説（次回も臨時）／219＝臨時解説（次回は定例）の 3 つで、
// **名称はどちらの臨時解説も「臨時解説」**（次回の予定だけがコードで分かれる）。実電文で
// 確認できたのは 210 と 200。未知のコードでも解説情報として通し、名称はそのまま表示に使う。
export function parseNankaiCommentaryFromXml(xml: string): JMANankaiCommentary | null {
  const doc = parseTelegramXml(xml, DMDATA_LOG_PREFIX)
  if (!doc) return null
  // 電文の運用種別（`Control/Status`）。**全種別に付ける** —— ヘッダ部の要素なので、
  // 種別によって付けたり付けなかったりすると、試験報の印が電文の種類次第で出たり出なかったりする。
  const commentaryOperationStatus = parseOperationStatus(doc)

  const headEl   = xmlQ(doc, 'Head')
  const headline = headEl ? xmlText(xmlQ(headEl, 'Title')) : ''

  // 段階キーワードを持つのは臨時情報。呼び出し側（dmdata.ts / dmdataReplay.ts）が電文種別で
  // 振り分けているため通常は発火しない二重防御。単体で呼んだときに臨時情報を取り違えないための
  // 保険であり、相互排他は dmdataParser.test.ts で固定している。
  if (NANKAI_STAGE_KEYWORDS.some(k => headline.includes(k))) return null

  const reportDateTime = readReportDateTime(doc, '南海トラフ地震関連解説情報', DMDATA_LOG_PREFIX)
  // 期限（expireAt）の計算に使うため、日時として解釈できることをここで確かめる。
  // 不正な文字列のまま進むと new Date(...).toISOString() が RangeError を投げる。
  const reportMs = new Date(reportDateTime).getTime()
  if (!Number.isFinite(reportMs)) {
    return dropTelegram(DMDATA_LOG_PREFIX, `南海トラフ関連解説情報の発表時刻を日時として読めません: "${reportDateTime}"`)
  }
  const eventId = xmlText(xmlQ(doc, 'EventID'))
  const serial  = xmlText(xmlQ(doc, 'Serial')) || '1'

  // 本文は EarthquakeInfo 直下の Text。Body 全体から最初の Text を拾うと、将来 Body の構造が
  // 変わったとき（EarthquakeInfo より前に別の節が入る等）に別の文を本文として掴む。
  // 実電文では今のところ Body 配下の Text は 1 つだけだが、「たまたま当たっている」状態に
  // 依存しないよう対象を絞る（臨時情報側の parseNankaiFromXml も同じ形に揃えている）。
  const bodyEl     = xmlQ(doc, 'Body')
  const quakeInfoEl = bodyEl ? xmlQ(bodyEl, 'EarthquakeInfo') : null
  const bodyText   = (quakeInfoEl ? xmlText(xmlQ(quakeInfoEl, 'Text')) : '')
    || (bodyEl ? xmlText(xmlQ(bodyEl, 'Text')) : '')
  const serialEl   = bodyEl ? xmlQ(bodyEl, 'InfoSerial') : null
  const serialName = serialEl ? xmlText(xmlQ(serialEl, 'Name')) : ''
  const serialCode = serialEl ? xmlText(xmlQ(serialEl, 'Code')) : ''

  const expireAt = new Date(reportMs + 7 * 24 * 3600 * 1000).toISOString()

  // 取消電文は null にせず cancelled で返す。null にすると呼び出し側から「解析できなかった」と
  // 区別できず、正常な取消のたびに異常と同じ警告が出る。cancelled なら帯を消す経路にも乗せられる。
  // 実電文（2024年8月の臨時解説6通・直近の定例解説6通）はすべて InfoType=発表 で、解説情報の
  // 取消は一度も発表されていない。
  const cancelled = xmlText(xmlQ(doc, 'InfoType')) === '取消'

  return {
    ...(commentaryOperationStatus && { operationStatus: commentaryOperationStatus }),
    id: `dmdata-nankai-commentary-${eventId}-${serial}`,
    time: reportDateTime, eventId,
    serialCode, serialName: serialName || '解説情報',
    headline, body: bodyText,
    // 見出し文（要約）・次回発表予定・参考情報。臨時情報・後発地震と同じ読み手を通す。
    // **かつては `Head` 配下の最初の `Text` を拾っていた** —— たまたま当たっているだけで、
    // `Head` の構造が変わると別の文を要約として掴む。
    ...readEarthquakeInfoMeta(doc),
    cancelled, reportDateTime, expireAt,
  }
}

// REST API 経由の JMA XML（VYSE60: 北海道・三陸沖後発地震注意情報）を JMAKohatsu にパース
export function parseVyse60FromXml(xml: string): JMAKohatsu | null {
  const doc = parseTelegramXml(xml, DMDATA_LOG_PREFIX)
  if (!doc) return null
  // 電文の運用種別（`Control/Status`）。**全種別に付ける** —— ヘッダ部の要素なので、
  // 種別によって付けたり付けなかったりすると、試験報の印が電文の種類次第で出たり出なかったりする。
  const kohatsuOperationStatus = parseOperationStatus(doc)

  const reportDateTime = readReportDateTime(doc, '北海道・三陸沖後発地震注意情報', DMDATA_LOG_PREFIX)
  const eventId        = xmlText(xmlQ(doc, 'EventID'))
  const serial         = xmlText(xmlQ(doc, 'Serial')) || '1'
  const infoType       = xmlText(xmlQ(doc, 'InfoType'))
  const id             = `dmdata-kohatsu-${eventId}-${serial}`

  // 取消の扱いは南海トラフ臨時情報と同じ（理由はそちらのコメント）。段階を持たない電文なので
  // 名乗りの取り違えは起きないが、**取消であることと理由は残す**。
  if (infoType === '取消') {
    const cancelBodyEl = xmlQ(doc, 'Body')
    return {
    ...(kohatsuOperationStatus && { operationStatus: kohatsuOperationStatus }),
      id, time: reportDateTime, eventId,
      headline: '北海道・三陸沖後発地震注意情報（取消）',
      body: cancelBodyEl ? xmlText(xmlQ(cancelBodyEl, 'Text')) : '',
      cancelled: true, retracted: true, reportDateTime,
      expireAt: reportDateTime,
    }
  }

  const headEl   = xmlQ(doc, 'Head')
  const headline = headEl ? xmlText(xmlQ(headEl, 'Title')) : ''

  const bodyEl    = xmlQ(doc, 'Body')
  const commentEl = bodyEl ? xmlQ(bodyEl, 'Comment') : null
  const bodyText  = (commentEl ? xmlText(xmlQ(commentEl, 'Text')) : '')
    || (bodyEl ? xmlText(xmlQ(bodyEl, 'Text')) : '')

  // 有効期限は発表時刻 + 7日。
  // **日時として解釈できることを先に確かめる**（南海トラフ関連解説情報と同じガード）。
  // 不正な文字列のまま進むと `new Date(...).toISOString()` が RangeError を投げ、
  // 電文 1 通が例外で落ちる。`readReportDateTime` は読めない値を空文字で返すので、
  // ここは到達しうる経路。
  const kohatsuReportMs = new Date(reportDateTime).getTime()
  if (!Number.isFinite(kohatsuReportMs)) {
    return dropTelegram(DMDATA_LOG_PREFIX, `後発地震注意情報の発表時刻を日時として読めません: "${reportDateTime}"`)
  }
  const expireAt = new Date(kohatsuReportMs + 7 * 24 * 3600 * 1000).toISOString()

  return {
    ...(kohatsuOperationStatus && { operationStatus: kohatsuOperationStatus }),
    id, time: reportDateTime, eventId, headline, body: bodyText,
    ...readEarthquakeInfoMeta(doc),
    cancelled: false, reportDateTime, expireAt,
  }
}

/**
 * VZSE40（地震・津波に関するお知らせ）を {@link JMAQuakeNotice} にパースする。
 *
 * 構造は他の解説系より単純で、見出し（`Head/Headline/Text`）と自由文（`Body/Text`）だけ。
 * 段階も等級も持たない。
 *
 * **見出しは `Head/Headline/Text` から採る。`Head/Title` ではない。** `Title` はどの報でも
 * 「地震・津波に関するお知らせ」で固定なので、それを帯に出すと 43 通すべてが同じ文字列になり、
 * 何のお知らせか分からない。中身を言い分けているのは `Headline` のほう
 * （「和歌山県の自治体震度データ入電停止のお知らせ」等）。
 *
 * **本文の改行と全角スペースは保つ。** 記書き（「　　　記」や項番）の体裁で書かれていて、
 * 詰めると読めなくなる。自由付加文と同じ扱い（→ docs/spec/quake-spec.md §3）。
 */
export function parseQuakeNoticeFromXml(xml: string): JMAQuakeNotice | null {
  const doc = parseTelegramXml(xml, DMDATA_LOG_PREFIX)
  if (!doc) return null
  const operationStatus = parseOperationStatus(doc)

  const reportDateTime = readReportDateTime(doc, '地震・津波に関するお知らせ', DMDATA_LOG_PREFIX)
  // 期限の計算に使うので、日時として解釈できることをここで確かめる（解説情報と同じ理由）。
  const reportMs = new Date(reportDateTime).getTime()
  if (!Number.isFinite(reportMs)) {
    return dropTelegram(DMDATA_LOG_PREFIX, `地震・津波に関するお知らせの発表時刻を日時として読めません: "${reportDateTime}"`)
  }
  const eventId = xmlText(xmlQ(doc, 'EventID'))
  // `Serial` は実電文でもサンプルでも空。id の一意性は eventId（発表時刻由来）が担う。
  const serial = xmlText(xmlQ(doc, 'Serial')) || '1'

  const headEl = xmlQ(doc, 'Head')
  const headlineEl = headEl ? xmlQ(headEl, 'Headline') : null
  const headline = headlineEl ? xmlText(xmlQ(headlineEl, 'Text')) : ''

  // 本文は Body 直下の Text に限る（Body 配下の別の節にある Text を掴まないため。
  // 解説情報の本文読み取りと同じ考え方）。
  const bodyEl = xmlQ(doc, 'Body')
  const body = bodyEl ? xmlText(xmlChild(bodyEl, 'Text')) : ''

  // 取消は null にせず cancelled で返す（解析できなかった場合と区別するため）。
  const cancelled = xmlText(xmlQ(doc, 'InfoType')) === '取消'

  return {
    ...(operationStatus && { operationStatus }),
    id: `dmdata-quake-notice-${eventId}-${serial}`,
    time: reportDateTime, eventId,
    headline, body,
    cancelled, reportDateTime,
    expireAt: new Date(reportMs + 7 * 24 * 3600 * 1000).toISOString(),
  }
}

/** {@link parseEarthquakeCountFromXml} が数える区間の集計。全滅したときだけ記録する。 */
const COUNT_ITEM_LABEL = '地震回数の区間'

/**
 * VXSE60（地震回数に関する情報）を {@link JMAEarthquakeCount} にパースする。
 *
 * **実配信では観測できていない種別。** 読み取りは気象庁公式のサンプル電文
 * （`jmaxml_20260723_Samples.zip` の `32-35_03_01_100514_VXSE60.xml`＝発表、
 * `32-35_10_02_220510_VXSE60.xml`＝取消）に拠っている。実電文が届いたら形を確かめ直すこと。
 *
 * **区間は文書順を保つ。** サンプルでは「地震回数」→「１時間地震回数」×N →「累積地震回数」の
 * 順に並び、最後の累積が全体像を表す。並べ替えると、どれが累積か画面から判らなくなる。
 *
 * **`type` は電文の語をそのまま持つ。** 3 種類しか確認できていないので、値の集合を決め打ちして
 * 未知の区間を捨てると、増えたときに黙って落ちる。
 */
export function parseEarthquakeCountFromXml(xml: string): JMAEarthquakeCount | null {
  const doc = parseTelegramXml(xml, DMDATA_LOG_PREFIX)
  if (!doc) return null
  const operationStatus = parseOperationStatus(doc)

  const reportDateTime = readReportDateTime(doc, '地震回数に関する情報', DMDATA_LOG_PREFIX)
  // 期限（発表から 7 日）の計算に使うので、日時として解釈できることをここで確かめる
  // （お知らせ・後発地震・南海トラフ関連解説情報と同じ扱い）。
  const reportMs = new Date(reportDateTime).getTime()
  if (!Number.isFinite(reportMs)) {
    return dropTelegram(DMDATA_LOG_PREFIX, `地震回数に関する情報の発表時刻を日時として読めません: "${reportDateTime}"`)
  }
  const eventId = xmlText(xmlQ(doc, 'EventID'))
  const serial = xmlText(xmlQ(doc, 'Serial')) || '1'

  const headEl = xmlQ(doc, 'Head')
  const headlineEl = headEl ? xmlQ(headEl, 'Headline') : null
  const headline = headlineEl ? xmlText(xmlQ(headlineEl, 'Text')) : ''

  const cancelled = xmlText(xmlQ(doc, 'InfoType')) === '取消'
  const bodyEl = xmlQ(doc, 'Body')

  // 取消電文は区間を持たず、Body 直下の Text に取消しの理由が入る（他種別と同じ形。
  // → docs/spec/quake-spec.md §8「取消しの理由は電文にしかない」）。
  if (cancelled) {
    const cancelText = bodyEl ? xmlText(xmlChild(bodyEl, 'Text')) : ''
    return {
      ...(operationStatus && { operationStatus }),
      id: `dmdata-quake-count-${eventId}-${serial}`,
      time: reportDateTime, eventId, headline,
      items: [], ...(cancelText && { cancelText }),
      cancelled: true, reportDateTime,
      expireAt: new Date(reportMs + 7 * 24 * 3600 * 1000).toISOString(),
    }
  }

  const countEl = bodyEl ? xmlQ(bodyEl, 'EarthquakeCount') : null
  // **元要素そのものが見えなくなった場合を別に拾う。** `ReadTally` は「要素はあるのに読めなかった」
  // を数えるので、`EarthquakeCount` ごと消えると数える対象が 0 件になって素通りする
  // （長周期の `warnIfNoLpgmRegions`・震度点の `warnIfNoIntensityPoints` と同じ盲点）。
  // **この種別は実配信でほぼ観測できない**ので、痕跡が残らないと構造の変化に何年も気づけない。
  // （取消は上で `return` 済みなので、ここに来る時点で必ず発表報）
  if (!countEl) {
    log.warn(`${DMDATA_LOG_PREFIX} VXSE60（地震回数に関する情報）に EarthquakeCount 要素が見つかりません`)
  }
  const items: JMAEarthquakeCountItem[] = []
  const tally = createReadTally(COUNT_ITEM_LABEL)
  for (const itemEl of countEl ? xmlAll(countEl, 'Item') : []) {
    const type = itemEl.getAttribute('type') ?? ''
    // 区間の両端。表示にしか使わないので、日時として読めなければ捨てる。
    const startTime = readTelegramDateTime(DMDATA_LOG_PREFIX, '地震回数の区間の開始時刻', xmlText(xmlQ(itemEl, 'StartTime')))
    const endTime = readTelegramDateTime(DMDATA_LOG_PREFIX, '地震回数の区間の終了時刻', xmlText(xmlQ(itemEl, 'EndTime')))
    const numberText = xmlText(xmlQ(itemEl, 'Number'))
    const feltText = xmlText(xmlQ(itemEl, 'FeltNumber'))
    // 回数が数として読めない区間は採らない。
    //
    // **0 は有効な値**（有感 0 回はふつうに起きる）だが、**空文字と混ぜてはいけない** ――
    // `Number('')` は `0` を返すので、`Number.isFinite` だけで見ていると要素の欠落が
    // 「0 回」として通る。空欄と 0 回は画面でも読み上げでも同じ顔になり、
    // 群発の最中に「地震は起きていない」と伝えかねない。
    const number = numberText === '' ? NaN : Number(numberText)
    const feltNumber = feltText === '' ? NaN : Number(feltText)
    if (!type || !Number.isFinite(number) || !Number.isFinite(feltNumber)) {
      tally.unreadable(type || '(種類なし)', numberText)
      continue
    }
    items.push({ type, startTime, endTime, number, feltNumber })
    tally.readable()
  }
  tally.warnIfNoneReadable(DMDATA_LOG_PREFIX)

  return {
    ...(operationStatus && { operationStatus }),
    id: `dmdata-quake-count-${eventId}-${serial}`,
    time: reportDateTime, eventId, headline, items,
    ...(bodyEl && xmlText(xmlQ(bodyEl, 'NextAdvisory')) && { nextAdvisory: xmlText(xmlQ(bodyEl, 'NextAdvisory')) }),
    ...(bodyEl && xmlText(xmlQ(bodyEl, 'FreeFormComment')) && { freeText: xmlText(xmlQ(bodyEl, 'FreeFormComment')) }),
    cancelled: false, reportDateTime,
    expireAt: new Date(reportMs + 7 * 24 * 3600 * 1000).toISOString(),
  }
}
