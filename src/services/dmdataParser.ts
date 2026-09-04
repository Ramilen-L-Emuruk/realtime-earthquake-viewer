// DMDATA.JP の formatMode:"json" 電文を内部型に変換する。
// 各 parse* 関数は null を返すことがある（必須フィールド欠損時）。

import type {
  JMAQuake,
  JMATsunami,
  JMALpgm,
  JMANankai,
  JMANankaiCommentary,
  JMAKohatsu,
  EEWAlert,
  EEWRegion,
  IntensityScale,
  DomesticTsunami,
  IssueType,
  CorrectType,
  TsunamiArea,
  TsunamiGrade,
} from '../types/earthquake'
import { isValidLpgmClass } from '../utils/lpgm'
import { parseTsunamiObservationCondition } from '../utils/tsunami'
import { log } from '../utils/logger'
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

/** 上限を定めない予想震度を表す DMDATA の値。P2PQuake の `scaleTo: 99` と同じ意味。 */
const DMDATA_INTENSITY_OVER = 'over'

/** 区域が警報の対象であることを表す Kind 名（XML 経路で `body.isWarning` を復元するのに使う）。 */
const EEW_WARNING_KIND_NAME = '緊急地震速報（警報）'

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

const VXSE_ISSUE_TYPE: Record<string, IssueType> = {
  VXSE51: '震度速報',
  VXSE52: '震源情報',
  VXSE53: '震源・震度情報',
  VXSE61: '顕著な地震の震源要素更新のお知らせ',
}

// DMDATA JSON v1.1.0 では earthquake.domesticTsunami が存在しない。
// body.comments.forecast.codes（気象庁防災情報XML 固定付加文コード表）から津波情報区分を導出する。
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
function extractForecastText(rawText: string, codes: unknown[]): string {
  const text = normalizeForecastText(rawText)
  if (!text && codes.length > 0) {
    log.warn(`[dmdata] 付加文コード(${codes.join(' ')})はあるが原文を取得できませんでした`)
  }
  return text
}

/**
 * 電文種別コードと Head/Title（JSON は `title`）から issue.type を決める。
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
// PublishingOffice（例「気象庁」）を併せ持つ。JSON 経路が
// `data.editorialOffice ?? data.publishingOffice` の順で読むため、XML 経路も同じ順で解決する。
//
// Control 直下に限るのは、同名要素が他の位置に現れた電文で取り違えないため。
// どちらも無ければ空文字を返す（JSON 経路も str() で空文字に落ちる）。
//
// **空文字の扱いだけは JSON 経路と一致しない。** ここは `||` なので
// `<EditorialOffice></EditorialOffice>`（要素はあるが空）でも PublishingOffice へ落ちるが、
// JSON 経路は `??` なので `editorialOffice: ''` はそのまま空文字を返す。issue.source は
// 現状どのコンポーネントからも読まれないため実害は無いが、この値を使うコードを足すときは見ておくこと。
function parseIssueSourceFromXml(doc: Document): string {
  const controlEl = xmlQ(doc, 'Control')
  if (!controlEl) return ''
  return xmlText(xmlChild(controlEl, 'EditorialOffice'))
    || xmlText(xmlChild(controlEl, 'PublishingOffice'))
}

function xmlText(el: Element | null): string {
  return el?.textContent?.trim() ?? ''
}

// 度分表記（"+4012.6" = 北緯 40 度 12.6 分）を 10 進度へ直す。読めない値は NaN を返す。
//
// 小数第 4 位で丸めるのは DMDATA の JSON 変換に合わせるため（"40.2100" / "142.3033"）。
// 丸めないと同じ電文でも経路によって末尾がずれる。
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
 * XML 電文（VXSE45 等）を EEWAlert に読む。JSON 版 `parseEEW` と対になる。
 *
 * JSON 版が真偽値で受け取る 3 つは、XML では次の形で現れる（実電文 21 通で確かめた）。
 *
 * | JSON | XML |
 * |---|---|
 * | `body.isCanceled` | `Head/InfoType` が「取消」 |
 * | `body.isLastInfo` | `Body/NextAdvisory` に最終報の文言 |
 * | `body.isWarning` | 区域の `Category/Kind/Name` が「緊急地震速報（警報）」 |
 *
 * **`Condition` は要素の位置で意味が変わる。** `Earthquake` 直下は震源の状態（「仮定震源要素」）、
 * `Pref/Area` 直下は区域の状態（「既に主要動到達と推測」）。子孫から拾うと、警報級の電文で
 * 区域側の文言が震源の `condition` に化け、仮定震源要素の判定が誤って立つ。
 */
export function parseEEWFromXml(headType: string, xml: string): EEWAlert | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return null
  } catch { return null }

  const eventId = xmlText(xmlQ(doc, 'EventID'))
  const serial = xmlText(xmlQ(doc, 'Serial')) || '1'
  const reportTime = xmlText(xmlQ(doc, 'ReportDateTime'))
  const isCanceled = xmlText(xmlQ(doc, 'InfoType')) === '取消'

  const eqEl = xmlQ(doc, 'Earthquake')
  const areaEl = eqEl ? xmlQ(xmlQ(eqEl, 'Hypocenter') ?? eqEl, 'Area') : null
  const { lat, lng, depth } = areaEl
    ? parseJmaCoord(xmlText(xmlQ(areaEl, 'Coordinate')))
    : { lat: NaN, lng: NaN, depth: -1 }

  // 取消以外で震源が読めない電文は不正として捨てる（JSON 経路と同じ判定）。
  if (!isCanceled && (!Number.isFinite(lat) || !Number.isFinite(lng))) return null

  const forecastEl = xmlQ(doc, 'Forecast')
  const intRange = (el: Element | null): { from: string; to: string } => ({
    from: xmlText(el ? xmlChild(el, 'From') : null),
    to: xmlText(el ? xmlChild(el, 'To') : null),
  })
  const { scale: forecastScale, orAbove: forecastOrAbove } =
    parseForecastInt(intRange(forecastEl ? xmlChild(forecastEl, 'ForecastInt') : null))
  const lgTop = intRange(forecastEl ? xmlChild(forecastEl, 'ForecastLgInt') : null)
  const lgClass = parseInt(lgTop.to || lgTop.from, 10)

  const areas: EEWRegion[] = []
  // 警報級かどうかは区域の Kind 名で判る（実電文 21 通で JSON の body.isWarning と一致）。
  // 区域を回るついでに拾う ―― 名前で引き直すと、同名の区域があるときに取り違える。
  let sawWarningKind = false
  for (const prefEl of forecastEl ? xmlAll(forecastEl, 'Pref') : []) {
    for (const a of xmlAll(prefEl, 'Area')) {
      const name = xmlText(xmlChild(a, 'Name'))
      if (!name) continue
      const fi = intRange(xmlChild(a, 'ForecastInt'))
      const { scale: scaleTo, orAbove } = parseForecastInt(fi)
      const lg = intRange(xmlChild(a, 'ForecastLgInt'))
      const lgVal = parseInt(lg.to || lg.from, 10)
      const kindEl = xmlQ(a, 'Kind')
      if (xmlText(kindEl ? xmlChild(kindEl, 'Name') : null) === EEW_WARNING_KIND_NAME) sawWarningKind = true
      areas.push({
        pref: '',
        name,
        scaleFrom: parseIntensityStr(fi.from),
        scaleTo,
        ...(orAbove && { scaleToOrAbove: true }),
        kindCode: xmlText(kindEl ? xmlChild(kindEl, 'Code') : null),
        arrivalTime: xmlText(xmlChild(a, 'ArrivalTime')) || null,
        lgIntTo: isValidLpgmClass(lgVal) ? lgVal : undefined,
      })
    }
  }

  return {
    kind: 'eew',
    id: `dmdata-eew-${eventId}-${serial}`,
    time: reportTime,
    test: false,
    earthquake: {
      originTime: xmlText(eqEl ? xmlChild(eqEl, 'OriginTime') : null),
      arrivalTime: xmlText(eqEl ? xmlChild(eqEl, 'ArrivalTime') : null),
      // Earthquake 直下だけを見る（上記のとおり Area 直下にも Condition がある）。
      condition: xmlText(eqEl ? xmlChild(eqEl, 'Condition') : null),
      hypocenter: {
        name: xmlText(areaEl ? xmlChild(areaEl, 'Name') : null),
        latitude: isCanceled ? -200 : lat,
        longitude: isCanceled ? -200 : lng,
        depth,
        magnitude: eqEl ? parseFloat(xmlText(xmlQ(eqEl, 'Magnitude'))) : NaN,
      },
    },
    severity: (headType === 'VXSE43' || sawWarningKind) ? 'Warning' : 'Forecast',
    cancelled: isCanceled,
    // 取消はそのイベントの打ち切りなので最終報として扱う。取消電文は Body に Text しか持たず
    // NextAdvisory が無い（実電文 2026-03-07 の取消で確認）ため、文言だけを見ると false に落ちる。
    isFinal: isCanceled || (xmlText(xmlQ(doc, 'NextAdvisory')) || '').includes('最終報'),
    forecastMaxScale: (!isCanceled && forecastScale >= 0) ? forecastScale as IntensityScale : undefined,
    ...(!isCanceled && forecastScale > 0 && forecastOrAbove && { forecastMaxScaleOrAbove: true }),
    forecastMaxLpgmClass: (!isCanceled && isValidLpgmClass(lgClass)) ? lgClass : undefined,
    issue: { eventId, serial, time: reportTime },
    areas: isCanceled ? [] : areas,
  }
}

// REST API 経由の JMA XML（VXSE51/52/53）を JMAQuake にパース
export function parseEarthquakeFromXml(headType: string, xml: string): JMAQuake | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return null
  } catch { return null }

  const reportDateTime = xmlText(xmlQ(doc, 'ReportDateTime')) || xmlText(xmlQ(doc, 'DateTime'))
  const eventId = xmlText(xmlQ(doc, 'EventID'))
  const infoType = xmlText(xmlQ(doc, 'InfoType'))
  const serial = xmlText(xmlQ(doc, 'Serial')) || '1'
  // Head/Title を見る（Control/Title と区別するため Head 要素を先に取得する）。
  // 取消報でも同じ判定が要るため、取消の早期リターンより前で解決しておく。
  const headInfoEl = xmlQ(doc, 'Head')
  const issueType = resolveIssueType(headType, headInfoEl ? xmlText(xmlQ(headInfoEl, 'Title')) : '')
  const source = parseIssueSourceFromXml(doc)

  // 取消電文（InfoType === '取消'）: Earthquake 要素が存在しないため早期リターン
  if (infoType === '取消') {
    return {
      kind: 'quake',
      id: `dmdata-quake-${eventId}-${serial}`,
      // JSON 経路の取消と同じ理由で持たせる（そちらのコメント参照）。
      eventId: eventId || undefined,
      time: reportDateTime,
      cancelled: true,
      issue: { source, time: reportDateTime, type: issueType, correct: 'なし' as CorrectType },
      earthquake: { time: '', hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 }, maxScale: -1, domesticTsunami: '不明' },
      points: [],
    }
  }

  // VXSE51（震度速報）は震源が未確定の段階で発表されるため Earthquake 要素を持たない。
  // JSON 経路（parseEarthquake）と同じく、この電文だけ震源なしを許容する。
  const earthquakeEl = xmlQ(doc, 'Earthquake')
  if (!earthquakeEl && headType !== 'VXSE51') return null

  const hypocenterEl = earthquakeEl ? xmlQ(earthquakeEl, 'Hypocenter') : null
  const areaEl = hypocenterEl ? xmlQ(hypocenterEl, 'Area') : null
  // 遠地地震は Area/DetailedName に詳細震央地名（例: "ベネズエラ沿岸"）が入る。なければ Area/Name にフォールバック。
  const hypName = (areaEl ? xmlText(xmlQ(areaEl, 'DetailedName')) : '')
    || (areaEl ? xmlText(xmlQ(areaEl, 'Name')) : '')
  const { lat, lng, depth } = areaEl
    ? readHypocenterCoord(areaEl, headType)
    : { lat: NaN, lng: NaN, depth: -1 }

  // 震源を持つ電文で座標が読めないものは不正として捨てる（震度速報は上で除外済み）。
  if (earthquakeEl && (!Number.isFinite(lat) || !Number.isFinite(lng))) return null

  // 震度速報は Head/TargetDateTime（地震検知時刻）を earthquake.time に充てる。
  // 通常電文は arrivalTime を優先し、無ければ originTime にフォールバックする（JSON 経路の
  // parseEarthquake と揃える。DMD-4: 従来 XML は OriginTime を採用し JSON と 1 分ずれていた）。
  const originTime = earthquakeEl
    ? (xmlText(xmlQ(earthquakeEl, 'ArrivalTime')) || xmlText(xmlQ(earthquakeEl, 'OriginTime')))
    : xmlText(xmlQ(doc, 'TargetDateTime'))

  // Magnitude 要素が空・欠落の電文は「規模不明」。`|| 0` で 0 に潰すと M0.0 と実測値のように
  // 表示・読み上げされるため、NaN のまま返して不明判定（formatters の hasMagnitude）に委ねる。
  // VXSE51（震度速報）は Earthquake 要素自体を持たない。**ここも 0 ではなく NaN にする**——
  // 0 は `hasMagnitude` を通るので「Ｍ０．０」と読める形になってしまう。
  const magnitude = earthquakeEl
    ? parseFloat(xmlText(xmlQ(earthquakeEl, 'Magnitude')))
    : NaN

  // MaxInt は Intensity > Observation 直下
  const obsEl = xmlQ(doc, 'Observation')
  const maxIntStr = obsEl ? xmlText(xmlQ(obsEl, 'MaxInt')) : ''
  const maxScale = parseIntensityStr(maxIntStr || null)

  // 震度は Pref 配下に「一次細分区域(Area) → 市区町村(City) → 観測点(IntensityStation)」と
  // 入れ子で入る。震度速報は Area までしか持たず、震源・震度情報は両方を持つ。
  const points: JMAQuake['points'] = []
  const allEls = doc.getElementsByTagName('*')
  const prefEls: Element[] = []
  for (let i = 0; i < allEls.length; i++) {
    if (allEls[i].localName === 'Pref') prefEls.push(allEls[i])
  }
  for (const prefEl of prefEls) {
    // 都道府県ロールアップ点。JSON 経路の intensity.prefectures[] に対応する。
    // EarthquakeCard は pref の有無で「都道府県の点」と「区域の点」を見分けるため、
    // ここだけ pref に名前を入れる（区域・観測点は下で pref: '' にする）。
    //
    // 実電文は Pref 直下に MaxInt を持つ（能登半島地震の震度速報で
    // <Pref><Name>石川県</Name><Code>17</Code><MaxInt>5+</MaxInt> を確認）。
    // xmlChild で直下に限るのは、MaxInt を持たない電文で配下 Area の値を拾わないため。
    const prefName = xmlText(xmlChild(prefEl, 'Name'))
    const prefScale = parseIntensityStr(xmlText(xmlChild(prefEl, 'MaxInt')) || null)
    if (prefName && prefScale >= 0) {
      points.push({ pref: prefName, addr: prefName, isArea: true, scale: prefScale as IntensityScale })
    }

    const descendants = prefEl.getElementsByTagName('*')
    for (let i = 0; i < descendants.length; i++) {
      const el = descendants[i]

      if (el.localName === 'Area') {
        // 区域は JSON 経路の regions[] と同じ規約で pref を空にする。EarthquakeCard は
        // pref の有無で「都道府県の点」と「区域の点」を見分けるため（座標側は
        // useQuakeLayerData が区域名から都道府県を逆引きして引き当てる）。
        const areaName = xmlText(xmlChild(el, 'Name'))
        const areaScale = parseIntensityStr(xmlText(xmlChild(el, 'MaxInt')) || null)
        if (areaName && areaScale >= 0) {
          points.push({ pref: '', addr: areaName, isArea: true, scale: areaScale as IntensityScale })
        }
        continue
      }

      if (el.localName !== 'IntensityStation') continue
      // JMA XML では地方公共団体の観測局名末尾に '＊'(U+FF0A) が付く。
      // station-coords.json のキーには '＊' がないため除去して引き当てる。
      const stName = xmlText(xmlChild(el, 'Name')).replace(/＊$/, '')
      const intStr = xmlText(xmlChild(el, 'Int'))
      const scale = parseIntensityStr(intStr || null)
      if (stName && scale >= 0) {
        // QUAKE-2: 観測点は JSON 経路の stations[] と同じ規約で pref を空にする。
        // 以前は pref: prefName を付けていたため EarthquakeCard.prefGroups が
        // 「観測点値」を都道府県別最大震度と誤解し、区域単位の最大震度が観測点値に
        // 上書きされて低震度に見える不具合があった。
        points.push({ pref: '', addr: stName, isArea: false, scale: scale as IntensityScale })
      }
    }
  }

  const correct: CorrectType = infoType === '訂正' ? '訂正' : 'なし'

  // ForecastComment > Code から domesticTsunami を導出。
  // 実電文はスペース区切りで 1 要素にまとまる（例: <Code>0226 0230</Code>）が、兄弟要素に
  // 分割された場合でもコードを取りこぼさないよう、配下の Code をすべて集めて連結する。
  const forecastCommentEl = xmlQ(doc, 'ForecastComment')
  const forecastCodes = forecastCommentEl
    ? xmlAll(forecastCommentEl, 'Code').flatMap(el => xmlText(el).split(/\s+/)).filter(Boolean)
    : []
  const domestic = parseDomesticTsunamiFromComments({ forecast: { codes: forecastCodes } })
  // 付加文の原文（ForecastComment > Text）。JSON 経路の comments.forecast.text と同じ内容。
  const forecastText = extractForecastText(
    forecastCommentEl ? xmlText(xmlQ(forecastCommentEl, 'Text')) : '',
    forecastCodes,
  )
  // 自由付加文（JSON 経路の comments.free と同じ内容）。`xmlText` が前後の空白だけを落とす。
  const freeText = xmlText(xmlQ(doc, 'FreeFormComment'))

  return {
    kind: 'quake',
    id: `dmdata-quake-${eventId}-${serial}`,
    // 空文字は undefined に落とす（JSON 経路の `eventId || undefined` と同じ形）。
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
      time: originTime,
      hypocenter: {
        name: hypName,
        // 震度速報は震源情報なし。-200 は「位置不明」センチネル（JSON 経路と同じ）。
        latitude: Number.isFinite(lat) ? lat : -200,
        longitude: Number.isFinite(lng) ? lng : -200,
        depth,
        magnitude,
      },
      maxScale: maxScale >= 0 ? maxScale as IntensityScale : -1,
      domesticTsunami: domestic,
    },
    points,
    forecastText: forecastText || undefined,
    freeText: freeText || undefined,
  }
}

// REST API 経由の JMA XML（VTSE41/VTSE51/VTSE52）を JMATsunami にパース。
// 観測データ（Observation のみ）の場合は null を返す。
// 波高の表示文字列（XML の `description` 属性）を半角へ直す。
//
// 気象庁の原文は全角（"０．２ｍ未満" / "８．５ｍ以上"）だが、画面と読み上げはずっと半角で
// 出してきた。JSON 経路も数値から `${value}m` と半角で組むため、XML 経路だけ全角になると
// **同じ津波でも履歴で開いたかライブで受信したかで表示が変わる**。
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

export function parseTsunamiFromXml(xml: string): JMATsunami | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return null
  } catch { return null }

  const reportDateTime = xmlText(xmlQ(doc, 'ReportDateTime')) || xmlText(xmlQ(doc, 'DateTime'))
  // 空文字は undefined に落とす（JSON 経路の `str(data.eventId) || undefined` と同じ形）。
  // 「同一イベントか」の判定はどこも falsy 判定で書かれているのに対し、キーの導出側が空文字を
  // 有効な識別子として扱うと、識別子を持たない電文どうしが同じ津波として束ねられる。
  const eventId = xmlText(xmlQ(doc, 'EventID')) || undefined
  const serial = xmlText(xmlQ(doc, 'Serial')) || '1'
  const infoType = xmlText(xmlQ(doc, 'InfoType'))
  const source = parseIssueSourceFromXml(doc)
  const validDateTime = xmlText(xmlQ(doc, 'ValidDateTime')) || undefined
  // Headline 配下には <Information> など区域名・コードの入れ子要素が続くことがあるため、
  // xmlText(xmlQ(doc,'Headline')) のような全文連結ではなく <Text> だけを狙って取得する。
  const headlineEl = xmlQ(doc, 'Headline')
  const headline = (headlineEl ? xmlText(xmlQ(headlineEl, 'Text')) : '') || undefined
  const commentsEl = xmlQ(doc, 'Comments')
  const warningCommentEl = commentsEl ? xmlQ(commentsEl, 'WarningComment') : null
  const warningComment = (warningCommentEl ? xmlText(xmlQ(warningCommentEl, 'Text')) : '') || undefined
  // この津波を引き起こした地震（Earthquake 要素）
  const eqEl = xmlQ(doc, 'Earthquake')
  const eqHypoEl = eqEl ? xmlQ(eqEl, 'Hypocenter') : null
  const eqHypoName = eqHypoEl ? xmlText(xmlQ(eqHypoEl, 'Name')) : ''
  const eqMagnitudeEl = eqEl ? xmlQ(eqEl, 'Magnitude') : null
  const eqMagnitude = eqMagnitudeEl ? parseFloat(xmlText(eqMagnitudeEl)) : NaN
  const sourceEarthquake = eqHypoName
    ? { hypocenterName: eqHypoName, magnitude: !isNaN(eqMagnitude) ? eqMagnitude : undefined, originTime: (eqEl ? xmlText(xmlQ(eqEl, 'OriginTime')) : '') || undefined }
    : undefined

  const id = `dmdata-tsunami-${eventId ?? ''}-${serial}`
  const cancelled = infoType === '取消'

  // InfoType=取消: 誤って発表した電文そのものの取消（誤報取消）
  if (cancelled) {
    return { kind: 'tsunami', id, eventId, time: reportDateTime, cancelled: true, cancelReason: 'retracted', issue: { source, time: reportDateTime, type: 'Focus' }, areas: [] }
  }

  const forecastEl = xmlQ(doc, 'Forecast')
  const observationEl = xmlQ(doc, 'Observation')

  // Forecast も Observation もなければパース不可
  if (!forecastEl && !observationEl) return null

  // Observation のみ（VTSE51②: 津波観測情報）
  if (!forecastEl && observationEl) {
    const observations = parseTsunamiObservationsFromXml(observationEl)
    if (observations.length === 0) return null
    return { kind: 'tsunami', id, eventId, time: reportDateTime, cancelled: false, headline, warningComment, sourceEarthquake, issue: { source, time: reportDateTime, type: 'Focus' }, areas: [], observations }
  }

  const allEls = forecastEl!.getElementsByTagName('*')
  const itemEls: Element[] = []
  for (let i = 0; i < allEls.length; i++) {
    if (allEls[i].localName === 'Item') itemEls.push(allEls[i])
  }

  const areas: TsunamiArea[] = []
  // 解除コード（00/50/60）で `areas` から落とした区域の名前。全区域が落ちれば正式解除だが、
  // **他の区域が残ったまま一部だけ落ちた場合は区域単位の等級変化として検出できない**
  // （`lastGrade` は残った区域にしか付かない）。下で記録を残す。
  const droppedByCancelCode: string[] = []
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
    const lastGrade = parseLastKindGrade(lastKindEl ? xmlText(xmlQ(lastKindEl, 'Code')) : '', '[tsunami XML]')
    if (!areaName) continue
    if (grade === 'Unknown') {
      if (isKnownCancelCode(kindCode)) {
        droppedByCancelCode.push(areaName)
        continue
      }
      // DMD-5: 未知コードは silent lifted 誤認を避けるため Warning 相当で保持し警告する
      log.warn(`[tsunami XML] 未知の Kind/Code: "${kindCode}" → 安全側で Warning として areas 保持`)
      grade = 'Warning'
    }

    const fhEl = xmlQ(itemEl, 'FirstHeight')
    const arrivalTime = fhEl ? xmlText(xmlQ(fhEl, 'ArrivalTime')) : ''
    const condition = fhEl ? xmlText(xmlQ(fhEl, 'Condition')) : ''

    const mhEl = xmlQ(itemEl, 'MaxHeight')
    const heightEl = mhEl ? xmlQ(mhEl, 'TsunamiHeight') : null
    const heightVal = heightEl ? parseFloat(xmlText(heightEl)) : NaN
    // description 属性は実電文では入っていた（確かめた範囲は
    // → docs/spec/tsunami-spec.md §6「観測波高の「以上」」）。それでも数値から組む道を残すのは、
    // JSON 経路が condition が空のとき同じことをしているため（表示・読み上げは description しか
    // 見ないので、空だと波高が画面から消える）。
    const heightDesc = toHalfWidthHeightDesc(heightEl?.getAttribute('description') ?? '')
      || (!isNaN(heightVal) ? `${heightVal}m` : '')

    // Station 要素（各潮位観測点の満潮時刻・到達予想時刻）
    const stationEls = itemEl.getElementsByTagName('Station')
    const stations: import('../types/earthquake').TsunamiStation[] = []
    for (let i = 0; i < stationEls.length; i++) {
      const st = stationEls[i]
      const stName = xmlText(xmlQ(st, 'Name'))
      const stCode = xmlText(xmlQ(st, 'Code'))
      if (!stName) continue
      const highTide = xmlText(xmlQ(st, 'HighTideDateTime')) || undefined
      const stFhEl = xmlQ(st, 'FirstHeight')
      const stArrival = stFhEl ? xmlText(xmlQ(stFhEl, 'ArrivalTime')) : ''
      const stCondition = stFhEl ? xmlText(xmlQ(stFhEl, 'Condition')) : ''
      stations.push({
        name: stName,
        code: stCode,
        highTideDateTime: highTide,
        arrivalTime: stArrival || undefined,
        arrivalCondition: stCondition || undefined,
      })
    }

    areas.push({
      grade,
      lastGrade,
      immediate: condition === 'ただちに津波来襲と予測',
      name: areaName,
      code: areaCode,
      firstHeight: { arrivalTime: arrivalTime || undefined, condition },
      maxHeight: !isNaN(heightVal) ? { description: heightDesc, value: heightVal } : undefined,
      stations: stations.length > 0 ? stations : undefined,
    })
  }

  // Forecast があるのに有効エリアが0件 = 気象庁による正式な解除（区域が電文から消える）
  if (areas.length === 0) return { kind: 'tsunami', id, eventId, time: reportDateTime, cancelled: true, cancelReason: 'lifted', issue: { source, time: reportDateTime, type: 'Focus' }, areas: [] }
  warnPartialDrop(droppedByCancelCode, '[tsunami XML]')

  // Observation も含む場合（VTSE51①: Forecast + Observation 両方あり）
  const observations = observationEl ? parseTsunamiObservationsFromXml(observationEl) : undefined

  return { kind: 'tsunami', id, eventId, time: reportDateTime, cancelled: false, validDateTime, headline, warningComment, sourceEarthquake, issue: { source, time: reportDateTime, type: 'Focus' }, areas, observations: observations && observations.length > 0 ? observations : undefined }
}

function parseTsunamiObservationsFromXml(observationEl: Element): import('../types/earthquake').TsunamiObservation[] {
  const observations: import('../types/earthquake').TsunamiObservation[] = []
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
      if (!name) continue
      const fhEl = xmlQ(st, 'FirstHeight')
      const arrivalTime = fhEl ? xmlText(xmlQ(fhEl, 'ArrivalTime')) : ''
      const initial = fhEl ? xmlText(xmlQ(fhEl, 'Initial')) : ''
      const mhEl = xmlQ(st, 'MaxHeight')
      const heightEl = mhEl ? xmlQ(mhEl, 'TsunamiHeight') : null
      const heightVal = heightEl ? parseFloat(xmlText(heightEl)) : NaN
      // 電文が書いた表示文字列。over の判定と下の記録はこの生の値だけを見る
      // （表示のために補った文字列を混ぜると「電文が何と言ったか」が分からなくなる）。
      const rawHeightDesc = heightEl?.getAttribute('description') ?? ''
      // 観測可能範囲を超えた値・機器が被災した値は「〇m以上」の形で発表される。JSON 経路は
      // maxHeight.height.over の真偽値で受け取るが、XML の TsunamiHeight に真偽値の属性は無いため、
      // 気象庁が組んだ表示文字列である description の文言から復元する。
      // **「以上」が付く実電文は未確認。** 語彙の傍証と、この判定が空振りしうる条件は
      // → docs/spec/tsunami-spec.md §6「観測波高の「以上」」。
      // false ではなく undefined に落とすのは JSON 経路（over || undefined）と形を揃えるため。
      const over = rawHeightDesc.includes('以上') || undefined
      // description が空だと over を復元する手がかりが無い。JSON 経路には「波高は読めないが
      // over は立っていた」ケースの記録が下にあるのに対し、XML 経路の over は description が
      // 唯一の情報源なので、落ちた事実を残さないと「以上」が黙って通常値として扱われる。
      // 波高そのものが読めない電文は下の height ごと落ちる経路で扱うため、ここでは除く。
      if (!isNaN(heightVal) && !rawHeightDesc) {
        log.warn(`[tsunami XML] 波高の description 属性が空のため「以上」を判定できません: ${name}`)
      }
      // 逆に、数値が読めないのに「以上」が書かれている電文。height ごと落ちるので表示は
      // 変わらないが、JSON 経路には対になる記録があるため、XML 経路だけ痕跡が残らない状態を作らない。
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
        districtCode,
        districtName,
      })
    }
  }
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
 * 発表中の区域が残っているのに、一部の区域だけが解除コード（00/50/60）で `areas` から
 * 落ちた場合に記録を残す。
 *
 * 2024 年能登半島地震（`eventId=20240101161010`）の津波電文を確かめた範囲では、解除された区域も
 * **予報への降格**として電文に残り、この形は現れなかった（01/01〜01/02 の VTSE41 7 通と 01/02 の
 * VTSE51 11 通で、現れた `Kind/Code` は 51・53・62・71・72 だけ）。再確認するには DMDATA archive
 * API（`/v2/archive` の `telegram.earthquake` 分類）から 2024-01-01・2024-01-02 の tar を展開し、
 * VTSE41/51 の `forecasts[].kind.code` を数える。もし気象庁がこの表現を使った場合、落ちた区域は
 * `lastGrade` を持てないため「区域単位で等級が動いた報」として検出できず、カードから
 * 説明もなく消える（→ docs/spec/tsunami-spec.md §10）。画面には何も出ないので、
 * 追う手がかりをここに残す。
 */
function warnPartialDrop(droppedNames: string[], logPrefix: string): void {
  if (droppedNames.length === 0) return
  log.warn(`${logPrefix} 発表中の区域が残っているのに解除コードで落ちた区域があります（区域単位の等級変化として検出できません）: ${droppedNames.join('・')}`)
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
export function parseLpgmFromXml(xml: string): JMALpgm | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return null
  } catch { return null }

  const reportDateTime = xmlText(xmlQ(doc, 'ReportDateTime')) || xmlText(xmlQ(doc, 'DateTime'))
  const eventId        = xmlText(xmlQ(doc, 'EventID'))
  const serial         = xmlText(xmlQ(doc, 'Serial')) || '1'
  const infoType       = xmlText(xmlQ(doc, 'InfoType'))
  const id             = `dmdata-lpgm-${eventId}-${serial}`
  const cancelled      = infoType === '取消'

  const earthquakeEl = xmlQ(doc, 'Earthquake')
  const originTime   = earthquakeEl ? xmlText(xmlQ(earthquakeEl, 'OriginTime')) : ''

  if (cancelled) return { id, eventId, time: reportDateTime, originTime, maxClass: 0, cancelled: true }
  if (!originTime) return null

  // VXSE62 XML: Intensity > Observation > MaxLgInt が最大長周期地震動階級
  const obsEl       = xmlQ(doc, 'Observation')
  const maxClassStr = obsEl ? xmlText(xmlQ(obsEl, 'MaxLgInt')) : ''
  const maxClass    = parseInt(maxClassStr, 10)

  if (!(maxClass >= 1 && maxClass <= 4)) return null

  // 観測点・細分区域データを抽出
  const points: import('../types/earthquake').LpgmPoint[] = []
  const regions: import('../types/earthquake').LpgmRegion[] = []

  const allEls = doc.getElementsByTagName('*')
  const prefEls: Element[] = []
  for (let i = 0; i < allEls.length; i++) {
    if (allEls[i].localName === 'Pref') prefEls.push(allEls[i])
  }
  for (const prefEl of prefEls) {
    // DMD-6: Pref 配下には Area/Name（孫要素）も存在するため、xmlQ（子孫全体検索）は
    // 文書順で先に出た方を拾って誤検出しうる。Pref 直下の Name だけを取る xmlChild に置換。
    const prefName = xmlText(xmlChild(prefEl, 'Name'))
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
      const areaMaxLgInt = parseInt(xmlText(xmlChild(areaEl, 'MaxLgInt')), 10)
      if (areaMaxLgInt >= 1) regions.push({ code: areaCode, name: areaName, maxLgInt: areaMaxLgInt })

      const areaChildren = areaEl.getElementsByTagName('*')
      for (let i = 0; i < areaChildren.length; i++) {
        if (areaChildren[i].localName !== 'IntensityStation') continue
        const stEl  = areaChildren[i]
        // IntensityStation 直下には Name/Code/LgInt しかなく、これらと同名の子孫要素は
        // 存在しないため xmlQ（子孫検索）でも xmlChild と同じ結果になる（DMD-6 対象外）。
        const stName = xmlText(xmlQ(stEl, 'Name'))
        const stCode = xmlText(xmlQ(stEl, 'Code'))
        const lgInt  = parseInt(xmlText(xmlQ(stEl, 'LgInt')), 10)
        if (lgInt >= 1) points.push({ code: stCode, name: stName, pref: prefName, lgInt })
      }
    }
  }

  return { id, eventId, time: reportDateTime, originTime, maxClass, cancelled: false, points, regions }
}

// 臨時情報の段階。Head/Title（情報名）の括弧内に現れるキーワードで判別する。
// 「調査終了」と「調査中」は互いに部分文字列にならないため、並び順に依存しない。
const NANKAI_STAGES: ReadonlyArray<{ keyword: string; code: string }> = [
  { keyword: '巨大地震警戒', code: '0203' },
  { keyword: '巨大地震注意', code: '0202' },
  { keyword: '調査終了',     code: '0204' },
  { keyword: '調査中',       code: '0201' },
]

// REST API 経由の JMA XML（VYSE50: 南海トラフ地震臨時情報）を JMANankai にパース。
// 段階を判別できない電文（= 解説情報 VYSE51/52）は null を返す。解説情報は
// parseNankaiCommentaryFromXml で別の型に読む。
//
// 段階の情報源は Head/Title（例「南海トラフ地震臨時情報（巨大地震注意）」）。
// **Head/InfoKind は使えない。** 実電文 14 通すべてで「南海トラフ地震に関連する情報」で
// 固定されており、段階のキーワードを含まないため、以前はどの電文も既定値の「調査中」に
// 落ちていた（「巨大地震注意」が「調査中」と表示される不具合）。
export function parseNankaiFromXml(xml: string): JMANankai | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return null
  } catch { return null }

  const reportDateTime = xmlText(xmlQ(doc, 'ReportDateTime')) || xmlText(xmlQ(doc, 'DateTime'))
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

  const stage = NANKAI_STAGES.find(s => headline.includes(s.keyword))
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
    id, time: reportDateTime, eventId,
    kindCode: stage.code, kindName: stage.keyword,
    headline, body: bodyText,
    cancelled: stage.code === '0204', reportDateTime,
  }
}

// REST API 経由の JMA XML（VYSE51/52: 南海トラフ地震関連解説情報）を JMANankaiCommentary に
// パース。段階を持つ電文（= 臨時情報 VYSE50）は null を返す。
//
// 種別は Body/EarthquakeInfo/InfoSerial（地震関連情報番号コード）で判別する。実電文で
// 確認できたのは臨時解説 210 と定例解説 200 の 2 値のみ。コード表は非公開のため、
// 未知のコードでも解説情報として通し、名称はそのまま表示に使う。
export function parseNankaiCommentaryFromXml(xml: string): JMANankaiCommentary | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return null
  } catch { return null }

  const headEl   = xmlQ(doc, 'Head')
  const headline = headEl ? xmlText(xmlQ(headEl, 'Title')) : ''

  // 段階キーワードを持つのは臨時情報。呼び出し側（dmdata.ts / dmdataReplay.ts）が電文種別で
  // 振り分けているため通常は発火しない二重防御。単体で呼んだときに臨時情報を取り違えないための
  // 保険であり、相互排他は dmdataParser.test.ts で固定している。
  if (NANKAI_STAGES.some(s => headline.includes(s.keyword))) return null

  const reportDateTime = xmlText(xmlQ(doc, 'ReportDateTime')) || xmlText(xmlQ(doc, 'DateTime'))
  // 期限（expireAt）の計算に使うため、日時として解釈できることをここで確かめる。
  // 不正な文字列のまま進むと new Date(...).toISOString() が RangeError を投げる。
  const reportMs = new Date(reportDateTime).getTime()
  if (!Number.isFinite(reportMs)) return null
  const eventId = xmlText(xmlQ(doc, 'EventID'))
  const serial  = xmlText(xmlQ(doc, 'Serial')) || '1'

  // Head 内の Text は Headline/Text（一文要約）
  const summary = headEl ? xmlText(xmlQ(headEl, 'Text')) : ''

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
    id: `dmdata-nankai-commentary-${eventId}-${serial}`,
    time: reportDateTime, eventId,
    serialCode, serialName: serialName || '解説情報',
    headline, summary, body: bodyText,
    cancelled, reportDateTime, expireAt,
  }
}

// REST API 経由の JMA XML（VYSE60: 北海道・三陸沖後発地震注意情報）を JMAKohatsu にパース
export function parseVyse60FromXml(xml: string): JMAKohatsu | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return null
  } catch { return null }

  const reportDateTime = xmlText(xmlQ(doc, 'ReportDateTime')) || xmlText(xmlQ(doc, 'DateTime'))
  const eventId        = xmlText(xmlQ(doc, 'EventID'))
  const serial         = xmlText(xmlQ(doc, 'Serial')) || '1'
  const infoType       = xmlText(xmlQ(doc, 'InfoType'))
  const id             = `dmdata-kohatsu-${eventId}-${serial}`

  // 取消の扱いは南海トラフ臨時情報と同じ（理由はそちらのコメント）。段階を持たない電文なので
  // 名乗りの取り違えは起きないが、**取消であることと理由は残す**。
  if (infoType === '取消') {
    const cancelBodyEl = xmlQ(doc, 'Body')
    return {
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

  // 有効期限は発表時刻 + 7日
  const expireAt = new Date(new Date(reportDateTime).getTime() + 7 * 24 * 3600 * 1000).toISOString()

  return { id, time: reportDateTime, eventId, headline, body: bodyText, cancelled: false, reportDateTime, expireAt }
}
