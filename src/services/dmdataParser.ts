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
  TsunamiObservation,
} from '../types/earthquake'
import { isValidLpgmClass } from '../utils/lpgm'
import { log } from '../utils/logger'
import { arr, obj, parseNum, str } from './parseHelpers'

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

/**
 * EEW の予想震度の範囲（`{ from, to }`）を、階級 1 つと「以上」フラグに畳む。
 *
 * `to: "over"` は上限を定めない表現（例: `from: "4", to: "over"` = 「震度4以上」）。
 * これを震度7と読むと、単独観測点処理の初報のように下限しか決まっていない報が
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

// DMDATA の震源座標から緯度・経度・深さを取得する。
// coordinate.height.value は m 単位の負値（海面下が負）。
// depth.value は km 単位の文字列の場合もある。
function parseHypocenterCoord(hypo: Record<string, unknown>): {
  lat: number; lng: number; depth: number
} {
  const coord = obj(hypo.coordinate)
  const lat = parseNum(obj(coord.latitude).value)
  const lng = parseNum(obj(coord.longitude).value)
  const depthKm = parseNum(obj(hypo.depth).value)
  const heightM = parseNum(obj(coord.height).value)
  // depth.value が km の数値として取れればそれを優先
  const depth = Number.isFinite(depthKm) && depthKm >= 0
    ? depthKm
    : Number.isFinite(heightM)
      ? Math.abs(heightM) / 1000
      : -1
  return { lat, lng, depth }
}

// EEW 電文の body.intensity.regions[] を地域別予想震度（EEWRegion[]）に変換する。
// 各要素は細分化地域コード(code)・地域名(name)・予測震度(forecastMaxInt.{from,to}) を持つ。
// pref はこの電文に単体では含まれないため空文字とし、フック層で station-coords から補完する。
function parseEEWRegions(intensity: Record<string, unknown>): EEWRegion[] {
  const regions: EEWRegion[] = []
  for (const raw of arr(intensity.regions)) {
    const r = obj(raw)
    const name = str(r.name)
    if (!name) continue
    const fm = obj(r.forecastMaxInt)
    const { scale: scaleTo, orAbove } = parseForecastInt(fm)
    const scaleFrom = parseIntensityStr(str(fm.from))
    const lgRaw = obj(r.forecastMaxLgInt)
    const lgVal = parseInt(str(lgRaw.to) || str(lgRaw.from), 10)
    const lgIntTo = isValidLpgmClass(lgVal) ? lgVal : undefined
    regions.push({
      pref: '',
      name,
      scaleFrom,
      scaleTo,
      ...(orAbove && { scaleToOrAbove: true }),
      kindCode: str(obj(r.kind).code),
      arrivalTime: str(r.arrivalTime) || null,
      lgIntTo,
    })
  }
  return regions
}

// EEW (VXSE42: 配信テスト, VXSE43: 警報, VXSE44: 予報(廃止予定), VXSE45: 地震動予報)
// data は WebSocket body を復号・JSON.parse した後のオブジェクト（トップレベル電文）
export function parseEEW(headType: string, data: Record<string, unknown>): EEWAlert | null {
  const body = obj(data.body)
  const earthquake = obj(body.earthquake)
  const hypo = obj(earthquake.hypocenter)
  const { lat, lng, depth } = parseHypocenterCoord(hypo)
  const isCanceled = body.isCanceled === true
  const eventId = str(data.eventId)
  const serial = str(data.serialNo ?? data.serial ?? '1')
  const reportTime = str(data.reportDateTime ?? data.pressDateTime ?? data.reportTime)

  if (!isCanceled && (!Number.isFinite(lat) || !Number.isFinite(lng))) return null

  const intensity = obj(body.intensity)
  const forecastMaxInt = obj(intensity.forecastMaxInt)
  // 電文全体の予想最大震度。to が上限値だが、"over"（上限なし）なら from に寄せて
  // 「以上」をフラグで持つ（地域別と同じ扱い。parseForecastInt の JSDoc 参照）。
  const { scale: forecastScale, orAbove: forecastOrAbove } = parseForecastInt(forecastMaxInt)
  // 各地の予想震度（地域別）。キャンセル時は空にする。
  const areas = isCanceled ? [] : parseEEWRegions(intensity)

  // 推定最大長周期地震動階級（1〜4）。to 優先、なければ from
  const forecastMaxLgInt = obj(intensity.forecastMaxLgInt)
  const lpgmStr = str(forecastMaxLgInt.to) || str(forecastMaxLgInt.from)
  const lpgmClass = parseInt(lpgmStr, 10)
  const forecastMaxLpgmClass = (!isCanceled && isValidLpgmClass(lpgmClass)) ? lpgmClass : undefined

  return {
    kind: 'eew',
    id: `dmdata-eew-${eventId}-${serial}`,
    time: reportTime,
    test: false,
    earthquake: {
      originTime: str(earthquake.originTime),
      arrivalTime: str(earthquake.arrivalTime),
      condition: str(earthquake.condition),
      hypocenter: {
        name: str(hypo.name),
        latitude: isCanceled ? 0 : lat,
        longitude: isCanceled ? 0 : lng,
        depth,
        magnitude: parseNum(obj(earthquake.magnitude).value),
      },
    },
    severity: (headType === 'VXSE43' || body.isWarning === true) ? 'Warning' : 'Forecast',
    cancelled: isCanceled,
    isFinal: body.isLastInfo === true,
    forecastMaxScale: (!isCanceled && forecastScale >= 0) ? forecastScale as IntensityScale : undefined,
    ...(!isCanceled && forecastScale > 0 && forecastOrAbove && { forecastMaxScaleOrAbove: true }),
    forecastMaxLpgmClass,
    issue: { eventId, serial, time: reportTime },
    areas,
  }
}

const VXSE_ISSUE_TYPE: Record<string, IssueType> = {
  VXSE51: '震度速報',
  VXSE52: '震源情報',
  VXSE53: '震源・震度情報',
  VXSE61: '顕著な地震の震源要素更新のお知らせ',
}

// VXSE51/53 JSON 電文（earthquake-information v1.1.0）の body.intensity から震度データを取り出す。
// v1.1.0 スキーマは regions[]/stations[] のフラット配列構造を持つ。
// regions[]    → 一次細分区域（isArea:true・pref:''・地図の subregion 色付けに使用）
// stations[]   → 観測点（isArea:false・pref:''・末尾の全角アスタリスク除去）
// prefectures[] → pref: name 付きで追加（EarthquakeCard の都道府県別表示専用）
//   ※ 都道府県名は subregions.json に存在しないため地図描画には影響しない
function parseIntensityPoints(intensity: Record<string, unknown>): JMAQuake['points'] {
  const points: JMAQuake['points'] = []

  for (const rawRegion of arr(intensity.regions)) {
    const r = obj(rawRegion)
    const name = str(r.name)
    const scale = parseIntensityStr(str(r.maxInt) || null)
    if (name && scale >= 0) {
      points.push({ pref: '', addr: name, isArea: true, scale: scale as IntensityScale })
    }
  }

  for (const rawSt of arr(intensity.stations)) {
    const s = obj(rawSt)
    const name = str(s.name).replace(/＊$/, '')
    const scale = parseIntensityStr(str(s.int) || null)
    if (name && scale >= 0) {
      points.push({ pref: '', addr: name, isArea: false, scale: scale as IntensityScale })
    }
  }

  // JSON スキーマは stations/regions に親都道府県情報を持たないため、
  // prefectures を pref: name 付きで追加し EarthquakeCard の都道府県別表示に使う。
  // regions が空の場合も含め常に追加する（旧フォールバックを統合）。
  for (const rawPref of arr(intensity.prefectures)) {
    const p = obj(rawPref)
    const name = str(p.name)
    const scale = parseIntensityStr(str(p.maxInt) || null)
    if (name && scale >= 0) {
      points.push({ pref: name, addr: name, isArea: true, scale: scale as IntensityScale })
    }
  }

  return points
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

// 地震情報 (VXSE51/52/53)
export function parseEarthquake(headType: string, data: Record<string, unknown>): JMAQuake | null {
  const body = obj(data.body)

  // 取消電文（infoType === '取消'）: 最小限の情報だけ持つ cancelled JMAQuake を返す
  if (str(data.infoType) === '取消') {
    const eventId = str(data.eventId)
    const serial = str(data.serialNo ?? data.serial ?? '1')
    const reportTime = str(data.reportDateTime ?? data.pressDateTime)
    const issueType = resolveIssueType(headType, str(data.title))
    return {
      kind: 'quake',
      id: `dmdata-quake-${eventId}-${serial}`,
      time: reportTime,
      cancelled: true,
      issue: { source: str(data.editorialOffice ?? data.publishingOffice), time: reportTime, type: issueType, correct: 'なし' as CorrectType },
      earthquake: { time: '', hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: 0 }, maxScale: -1, domesticTsunami: '不明' },
      points: [],
    }
  }

  const earthquake = obj(body.earthquake)
  const hypo = obj(earthquake.hypocenter)
  const { lat, lng, depth } = parseHypocenterCoord(hypo)

  // VXSE51（震度速報）は震源情報を持たないため座標チェックをスキップする。
  // それ以外は有効な座標が必須。
  if (headType !== 'VXSE51' && (!Number.isFinite(lat) || !Number.isFinite(lng))) return null

  const intensity = obj(body.intensity)
  // maxInt は v1.1.0 では body.intensity.maxInt に存在する（earthquake.maxInt は存在しない）
  const maxIntStr = str(earthquake.maxInt) || str(body.maxInt) || str(intensity.maxInt)
  const maxScale = parseIntensityStr(maxIntStr || null)
  // domesticTsunami は DMDATA JSON スキーマに存在しないため comments コードから導出する
  const domestic = (str(earthquake.domesticTsunami) as DomesticTsunami)
    || parseDomesticTsunamiFromComments(obj(body.comments))
  const forecastText = extractForecastText(
    str(obj(obj(body.comments).forecast).text),
    arr(obj(obj(body.comments).forecast).codes),
  )
  // 自由付加文。固定付加文と違い電文ごとに書き起こされ、続報での更新はこちらに現れる。
  // 全角スペースで整形された表が入るため**改行・空白をそのまま残し**、前後の空白だけ落とす
  // （`trim()` は全角スペースも対象。XML 経路の `xmlText` と挙動を揃えている）。
  const freeText = str(obj(body.comments).free).trim()

  // VXSE51/53 は intensity から地域別震度を取り出す。VXSE52 は観測データなし。
  const points = (headType === 'VXSE53' || headType === 'VXSE51')
    ? parseIntensityPoints(intensity)
    : []

  // earthquake.time にはヘッドラインと一致する到達時刻（arrivalTime）を使う。
  // VXSE51 は earthquake フィールドがなく targetDateTime（= arrivalTime 相当）を使う。
  // VXSE52/53/61 は arrivalTime を優先し、欠けている場合のみ originTime にフォールバックする。
  // originTime は地震の物理的起源時刻で常に arrivalTime より1分前になるため、
  // そのまま使うとヘッドライン・eventId の時刻とずれて同一イベントが別カード扱いになる。
  const eventId = str(data.eventId)
  const originTime = (headType === 'VXSE51' ? str(data.targetDateTime) : str(earthquake.arrivalTime))
    || str(earthquake.originTime)

  // 遠地地震は data.title で判定する（data.body.type には現れない）。判定規則は resolveIssueType 参照。
  const issueType = resolveIssueType(headType, str(data.title))

  const correct: CorrectType = str(data.infoType) === '訂正' ? '訂正' : 'なし'

  return {
    kind: 'quake',
    id: `dmdata-quake-${eventId}-${str(data.serialNo ?? data.serial ?? '1')}`,
    eventId: eventId || undefined,
    time: str(data.reportDateTime ?? data.pressDateTime),
    issue: {
      source: str(data.editorialOffice ?? data.publishingOffice),
      time: str(data.reportDateTime ?? data.pressDateTime),
      type: issueType,
      correct,
    },
    earthquake: {
      time: originTime,
      hypocenter: {
        name: str(obj(hypo.detailed).name) || str(hypo.name),
        // VXSE51 は震源情報なし。-200 は「位置不明」センチネル（地図・カードで非表示判定に使用）。
        latitude: Number.isFinite(lat) ? lat : -200,
        longitude: Number.isFinite(lng) ? lng : -200,
        depth,
        magnitude: parseNum(obj(earthquake.magnitude).value),
      },
      maxScale: maxScale >= 0 ? maxScale as IntensityScale : -1,
      domesticTsunami: domestic,
    },
    points,
    forecastText: forecastText || undefined,
    freeText: freeText || undefined,
  }
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

function xmlText(el: Element | null): string {
  return el?.textContent?.trim() ?? ''
}

// JMA XML 座標文字列（例: "+36.3+140.0-70000/"）→ lat/lng/depth(km)
function parseJmaCoord(s: string): { lat: number; lng: number; depth: number } {
  const m = s.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\//)
  if (!m) return { lat: NaN, lng: NaN, depth: -1 }
  const lat = parseFloat(m[1])
  const lng = parseFloat(m[2])
  // 高さフィールドは負値・メートル単位（海面下）
  const depth = m[3] != null ? Math.abs(parseFloat(m[3])) / 1000 : -1
  return { lat, lng, depth }
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

  // 取消電文（InfoType === '取消'）: Earthquake 要素が存在しないため早期リターン
  if (infoType === '取消') {
    return {
      kind: 'quake',
      id: `dmdata-xml-quake-${eventId}-${serial}`,
      time: reportDateTime,
      cancelled: true,
      issue: { source: '気象庁', time: reportDateTime, type: issueType, correct: 'なし' as CorrectType },
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
  const coordStr = areaEl ? xmlText(xmlQ(areaEl, 'Coordinate')) : ''
  const { lat, lng, depth } = parseJmaCoord(coordStr)

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
  // VXSE51（震度速報）は Earthquake 要素自体を持たず、震源情報なしの意味で 0 を維持する。
  const magnitude = earthquakeEl
    ? parseFloat(xmlText(xmlQ(earthquakeEl, 'Magnitude')))
    : 0

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
    id: `dmdata-xml-quake-${eventId}-${serial}`,
    time: reportDateTime,
    issue: {
      source: '気象庁',
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
export function parseTsunamiFromXml(xml: string): JMATsunami | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return null
  } catch { return null }

  const reportDateTime = xmlText(xmlQ(doc, 'ReportDateTime')) || xmlText(xmlQ(doc, 'DateTime'))
  const eventId = xmlText(xmlQ(doc, 'EventID'))
  const serial = xmlText(xmlQ(doc, 'Serial')) || '1'
  const infoType = xmlText(xmlQ(doc, 'InfoType'))
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

  const id = `dmdata-xml-tsunami-${eventId}-${serial}`
  const cancelled = infoType === '取消'

  // InfoType=取消: 誤って発表した電文そのものの取消（誤報取消）
  if (cancelled) {
    return { kind: 'tsunami', id, eventId, time: reportDateTime, cancelled: true, cancelReason: 'retracted', issue: { source: '気象庁', time: reportDateTime, type: 'Focus' }, areas: [] }
  }

  const forecastEl = xmlQ(doc, 'Forecast')
  const observationEl = xmlQ(doc, 'Observation')

  // Forecast も Observation もなければパース不可
  if (!forecastEl && !observationEl) return null

  // Observation のみ（VTSE51②: 津波観測情報）
  if (!forecastEl && observationEl) {
    const observations = parseTsunamiObservationsFromXml(observationEl)
    if (observations.length === 0) return null
    return { kind: 'tsunami', id, eventId, time: reportDateTime, cancelled: false, headline, warningComment, sourceEarthquake, issue: { source: '気象庁', time: reportDateTime, type: 'Focus' }, areas: [], observations }
  }

  const allEls = forecastEl!.getElementsByTagName('*')
  const itemEls: Element[] = []
  for (let i = 0; i < allEls.length; i++) {
    if (allEls[i].localName === 'Item') itemEls.push(allEls[i])
  }

  const areas: TsunamiArea[] = []
  for (const itemEl of itemEls) {
    const areaName = xmlText(xmlQ(itemEl, 'Name'))
    const areaCode = xmlText(xmlQ(itemEl, 'Code')) || undefined
    const kindEl = xmlQ(itemEl, 'Kind')
    const kindCode = kindEl ? xmlText(xmlQ(kindEl, 'Code')) : ''
    let grade = parseTsunamiGradeByCode(kindCode)
    if (!areaName) continue
    if (grade === 'Unknown') {
      if (isKnownCancelCode(kindCode)) continue
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
    const heightDesc = heightEl?.getAttribute('description') ?? ''

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
      immediate: condition === 'ただちに津波来襲と予測',
      name: areaName,
      code: areaCode,
      firstHeight: { arrivalTime: arrivalTime || undefined, condition },
      maxHeight: !isNaN(heightVal) ? { description: heightDesc, value: heightVal } : undefined,
      stations: stations.length > 0 ? stations : undefined,
    })
  }

  // Forecast があるのに有効エリアが0件 = 気象庁による正式な解除（区域が電文から消える）
  if (areas.length === 0) return { kind: 'tsunami', id, eventId, time: reportDateTime, cancelled: true, cancelReason: 'lifted', issue: { source: '気象庁', time: reportDateTime, type: 'Focus' }, areas: [] }

  // Observation も含む場合（VTSE51①: Forecast + Observation 両方あり）
  const observations = observationEl ? parseTsunamiObservationsFromXml(observationEl) : undefined

  return { kind: 'tsunami', id, eventId, time: reportDateTime, cancelled: false, validDateTime, headline, warningComment, sourceEarthquake, issue: { source: '気象庁', time: reportDateTime, type: 'Focus' }, areas, observations: observations && observations.length > 0 ? observations : undefined }
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
      const heightDesc = heightEl?.getAttribute('description') ?? ''
      observations.push({
        name,
        height: !isNaN(heightVal) ? { value: heightVal, description: heightDesc } : undefined,
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

// 津波情報 (VTSE41: 大津波警報特別、VTSE51: 警報・注意報・解除、VTSE52: 沖合観測)
export function parseTsunami(headType: string, data: Record<string, unknown>): JMATsunami | null {
  const cancelled = str(data.infoType) === '取消'
  const rawEventId = str(data.eventId)
  const id = `dmdata-tsunami-${rawEventId}-${str(data.serialNo ?? data.serial ?? '1')}`
  const time = str(data.reportDateTime ?? data.pressDateTime)
  const source = str(data.editorialOffice ?? data.publishingOffice)
  const validDateTime = str(data.validDateTime) || undefined
  const headline = str(data.headline) || undefined
  // 付加文（固定文）。避難行動の呼びかけなど。FreeFormComment（長文の高さ区分解説）は対象外。
  const warningComment = str(obj(obj(data.comments).warning).text) || undefined
  // この津波を引き起こした地震（先頭の1件のみ使用）。earthquakes は body 配下にある。
  const rawEq = obj(arr(obj(data.body).earthquakes)[0])
  const eqHypoName = str(obj(rawEq.hypocenter).name)
  const eqMagnitude = parseFloat(str(obj(rawEq.magnitude).value))
  const sourceEarthquake = eqHypoName
    ? { hypocenterName: eqHypoName, magnitude: !isNaN(eqMagnitude) ? eqMagnitude : undefined, originTime: str(rawEq.originTime) || undefined }
    : undefined
  const eventId = rawEventId || undefined

  // InfoType=取消: 誤って発表した電文そのものの取消（誤報取消）
  if (cancelled) {
    return { kind: 'tsunami', id, eventId, time, cancelled: true, cancelReason: 'retracted', issue: { source, time, type: 'Focus' }, areas: [] }
  }

  const body = obj(data.body)
  const tsunami = obj(body.tsunami)

  // VTSE52（沖合観測）は forecasts を持たず observations を持つ。
  // v1.1.0 スキーマ: observations[].stations[] 配下に各潮位観測点データがある。
  if (headType === 'VTSE52') {
    const rawObs = arr(tsunami.observations)
    if (rawObs.length === 0) return null
    const observations: TsunamiObservation[] = []
    for (const rawDistrict of rawObs) {
      const district = obj(rawDistrict)
      const districtCode = str(district.code) || undefined
      const districtName = str(district.name) || undefined
      for (const rawSt of arr(district.stations)) {
        const st = obj(rawSt)
        const name = str(st.name)
        if (!name) continue
        const fh = obj(st.firstHeight)
        const mh = obj(st.maxHeight)
        const hObj = obj(mh.height)
        const heightVal = parseFloat(str(hObj.value))
        const over = hObj.over === true
        // 数値が読めないと height ごと落ちるため、over（観測可能範囲の超過）の情報も一緒に消える。
        // 表示・並び順・読み上げのどこにも痕跡が残らないので、記録だけは残す。
        if (isNaN(heightVal) && over) log.warn(`[tsunami] 「以上」の観測値だが波高が数値として読めません: ${name}`)
        observations.push({
          name,
          height: !isNaN(heightVal)
            ? { value: heightVal, description: str(hObj.condition) || (over ? `${heightVal}m以上` : `${heightVal}m`), over: over || undefined }
            : undefined,
          arrivalTime: str(fh.arrivalTime) || undefined,
          initial: str(fh.initial) || undefined,
          districtCode,
          districtName,
        })
      }
    }
    if (observations.length === 0) return null
    return { kind: 'tsunami', id, eventId, time, cancelled: false, headline, warningComment, sourceEarthquake, issue: { source, time, type: 'Focus' }, areas: [], observations }
  }

  // VTSE51（津波情報）は forecasts + observations の両方を持つ場合がある。
  // forecasts: 予報区別の警報等・到達予想、observations: 各観測点の実測値
  const rawObs = arr(tsunami.observations)
  let observations: TsunamiObservation[] | undefined
  if (headType === 'VTSE51' && rawObs.length > 0) {
    observations = []
    for (const rawDistrict of rawObs) {
      const district = obj(rawDistrict)
      const districtCode = str(district.code) || undefined
      const districtName = str(district.name) || undefined
      for (const rawSt of arr(district.stations)) {
        const st = obj(rawSt)
        const name = str(st.name)
        if (!name) continue
        const fh = obj(st.firstHeight)
        const mh = obj(st.maxHeight)
        const hObj = obj(mh.height)
        const heightVal = parseFloat(str(hObj.value))
        const over = hObj.over === true
        // 数値が読めないと height ごと落ちるため、over（観測可能範囲の超過）の情報も一緒に消える。
        // 表示・並び順・読み上げのどこにも痕跡が残らないので、記録だけは残す。
        if (isNaN(heightVal) && over) log.warn(`[tsunami] 「以上」の観測値だが波高が数値として読めません: ${name}`)
        observations.push({
          name,
          height: !isNaN(heightVal)
            ? { value: heightVal, description: str(hObj.condition) || (over ? `${heightVal}m以上` : `${heightVal}m`), over: over || undefined }
            : undefined,
          arrivalTime: str(fh.arrivalTime) || undefined,
          initial: str(fh.initial) || undefined,
          districtCode,
          districtName,
        })
      }
    }
    if (observations.length === 0) observations = undefined
  }

  // DMDATA JSON v1.1.0: body.tsunami.forecasts が直接の配列（tsunami.forecast.items ではない）
  const rawItems = arr(tsunami.forecasts)

  // forecasts がなく observations のみ = 観測情報のみ電文（VTSE51②）
  if (rawItems.length === 0) {
    if (!observations || observations.length === 0) return null
    return { kind: 'tsunami', id, eventId, time, cancelled: false, headline, warningComment, sourceEarthquake, issue: { source, time, type: 'Focus' }, areas: [], observations }
  }

  const areas: TsunamiArea[] = []
  for (const item of rawItems) {
    const it = obj(item)
    const kind = obj(it.kind)
    const codeStr = str(kind.code)
    let grade = parseTsunamiGradeByCode(codeStr)
    if (grade === 'Unknown') {
      if (isKnownCancelCode(codeStr)) continue  // 既知の解除コード（50/60/00）は除外
      // DMD-5: 未知コードは JMA コード改定の可能性。silent に解除扱いにせず、
      // 安全側の grade（Warning）で areas を保持し警告ログを残す。
      log.warn(`[tsunami] 未知の Kind/Code: "${codeStr}" → 安全側で Warning として areas 保持`)
      grade = 'Warning'
    }
    const firstHeight = obj(it.firstHeight)
    const maxHeight = obj(it.maxHeight)
    // DMDATA JSON v1.1.0: maxHeight.height.value が m 単位（maxHeight.value ではない）
    const heightObj = obj(maxHeight.height)
    const heightVal = parseFloat(str(heightObj.value))

    // VTSE51① の場合 stations（満潮時刻・到達予想時刻）がある
    const rawStations = arr(it.stations)
    let stations: import('../types/earthquake').TsunamiStation[] | undefined
    if (rawStations.length > 0) {
      stations = []
      for (const rawSt of rawStations) {
        const st = obj(rawSt)
        const stName = str(st.name)
        if (!stName) continue
        const stFh = obj(st.firstHeight)
        stations.push({
          name: stName,
          code: str(st.code),
          highTideDateTime: str(st.highTideDateTime) || undefined,
          arrivalTime: str(stFh.arrivalTime) || undefined,
          arrivalCondition: str(stFh.condition) || undefined,
        })
      }
      if (stations.length === 0) stations = undefined
    }

    areas.push({
      grade,
      immediate: firstHeight.condition === 'ただちに津波来襲と予測',
      name: str(it.name),
      code: str(it.code) || undefined,
      firstHeight: {
        arrivalTime: str(firstHeight.arrivalTime) || undefined,
        condition: str(firstHeight.condition),
      },
      maxHeight: !isNaN(heightVal)
        ? {
          description: str(heightObj.condition) || (heightVal ? `${heightVal}m` : ''),
          value: heightVal,
        }
        : undefined,
      stations,
    })
  }

  // 全区域が電文から消えた = 気象庁による正式な解除（Kind/Code が 50/60/00 など、grade判定不能で除外された結果0件）
  if (areas.length === 0) return { kind: 'tsunami', id, eventId, time, cancelled: true, cancelReason: 'lifted', issue: { source, time, type: 'Focus' }, areas: [] }

  return { kind: 'tsunami', id, eventId, time, cancelled: false, validDateTime, headline, warningComment, sourceEarthquake, issue: { source, time, type: 'Focus' }, areas, observations }
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
  const id             = `dmdata-xml-lpgm-${eventId}-${serial}`
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
  const id             = `dmdata-xml-nankai-${eventId}-${serial}`

  // 取消の場合は調査終了相当として扱う
  if (infoType === '取消') {
    return {
      id, time: reportDateTime, eventId,
      kindCode: '0204', kindName: '調査終了',
      headline: '南海トラフ地震臨時情報（取消）', body: '',
      cancelled: true, reportDateTime,
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
    id: `dmdata-xml-nankai-commentary-${eventId}-${serial}`,
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
  const id             = `dmdata-xml-kohatsu-${eventId}-${serial}`

  if (infoType === '取消') {
    return {
      id, time: reportDateTime, eventId,
      headline: '北海道・三陸沖後発地震注意情報（取消）', body: '',
      cancelled: true, reportDateTime,
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

// WebSocket 受信の JSON 電文（VXSE62: 長周期地震動観測情報）を JMALpgm にパース
// v1.1.0 スキーマ: 最大長周期地震動階級は body.intensity.maxLgInt（文字列 "0"〜"4"）
export function parseLpgm(data: Record<string, unknown>): JMALpgm | null {
  const cancelled = str(data.infoType) === '取消'
  const eventId = str(data.eventId)
  const serial = str(data.serialNo ?? data.serial ?? '1')
  const time = str(data.reportDateTime ?? data.pressDateTime)
  const id = `dmdata-lpgm-${eventId}-${serial}`

  const body = obj(data.body)
  const earthquake = obj(body.earthquake)
  const originTime = str(earthquake.originTime)

  if (cancelled) {
    return { id, eventId, time, originTime, maxClass: 0, cancelled: true }
  }

  if (!originTime) return null

  const intensity = obj(body.intensity)
  const maxClassStr = str(intensity.maxLgInt)
  const maxClass = parseInt(maxClassStr, 10)

  if (!(maxClass >= 1 && maxClass <= 4)) return null

  // 細分区域・観測点データを抽出
  const rawRegions = arr(intensity.regions)
  const regions: import('../types/earthquake').LpgmRegion[] = rawRegions
    .map(r => ({ code: str(obj(r).code), name: str(obj(r).name), maxLgInt: parseInt(str(obj(r).maxLgInt), 10) }))
    .filter(r => r.maxLgInt >= 1)

  // JSON電文の station.name は都道府県略称を含む形式（例: "茨城鹿嶋市鉢形"）
  // pref は空文字で格納し、座標解決は JapanMap 側の stationPrefIndex に委ねる
  const rawStations = arr(intensity.stations)
  const points: import('../types/earthquake').LpgmPoint[] = rawStations
    .map(s => ({ code: str(obj(s).code), name: str(obj(s).name), pref: '', lgInt: parseInt(str(obj(s).lgInt), 10) }))
    .filter(p => p.lgInt >= 1)

  return { id, eventId, time, originTime, maxClass, cancelled: false, points, regions }
}
