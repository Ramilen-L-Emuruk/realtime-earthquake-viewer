import type { EEWAlert, JMAQuake, JMATsunami, JMANankai, JMAKohatsu, JMALpgm, IntensityScale, TsunamiGrade, EarthquakePoint, DomesticTsunami, TsunamiObservation } from '../types/earthquake'
import { eewMaxScale } from './eew'
import { getIntensityLabel } from './intensity'
import { tsunamiMaxGrade } from './tsunami'
import { getSubRegionsCache } from './subregions'
import { getPrefecturesCache } from './prefectures'
import { getStationCoordsCache, buildAreaPrefIndex, buildPrefAreaNamesIndex } from './stationCoords'

const GRADE_ORDER: TsunamiGrade[] = ['MajorWarning', 'Warning', 'Watch', 'Forecast']

function tsunamiGradeLabel(grade: TsunamiGrade): string {
  switch (grade) {
    case 'MajorWarning': return '大津波警報'
    case 'Warning':      return '津波警報'
    case 'Watch':        return '津波注意報'
    case 'Forecast':     return '津波予報'
    default:              return ''
  }
}

// 震度スケールの降順リスト
const SCALE_DESCENDING: IntensityScale[] = [70, 60, 55, 50, 45, 40, 30, 20, 10] as IntensityScale[]

// 県内の一次細分区域が全部同じ階級で揃っている場合、区域名の列挙を「〇〇県」1件にまとめる。
// DMDATA JSON 電文由来の区域点は pref が空文字（dmdataParser.ts 参照）のため、
// areaPrefIndex（区域名→県名の逆引き）で補完してからグルーピングする。
// prefAreaNames が引けない（未読み込み）場合はまとめず区域名をそのまま返す。
function aggregateAreaNamesByPref(
  areaNames: { pref: string; addr: string }[],
  prefAreaNames: Map<string, Set<string>> | null,
  areaPrefIndex: Map<string, string> | null,
): string[] {
  const byPref = new Map<string, Set<string>>()
  for (const { pref, addr } of areaNames) {
    const resolvedPref = pref || areaPrefIndex?.get(addr) || ''
    const set = byPref.get(resolvedPref) ?? new Set<string>()
    set.add(addr)
    byPref.set(resolvedPref, set)
  }
  const result: string[] = []
  for (const [pref, names] of byPref) {
    const fullSet = prefAreaNames?.get(pref)
    const isWholePref = pref !== '' && fullSet != null && fullSet.size > 0
      && names.size === fullSet.size && [...names].every(n => fullSet.has(n))
    if (isWholePref) result.push(pref)
    else result.push(...names)
  }
  return result
}

function regionNamesForScale(
  points: EarthquakePoint[],
  scale: IntensityScale,
  prefAreaNames: Map<string, Set<string>> | null,
  areaPrefIndex: Map<string, string> | null,
): string[] {
  const matched = points.filter(p => p.scale === scale)
  const areaPoints = matched.filter(p => p.isArea && p.addr !== p.pref)
  if (areaPoints.length > 0) return aggregateAreaNamesByPref(areaPoints, prefAreaNames, areaPrefIndex)
  return [...new Set(matched.map(p => p.pref).filter(Boolean))]
}

// ソート用二乗距離（緯度方向補正あり）
function distSq(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dlat = lat1 - lat2
  const dlon = (lon1 - lon2) * Math.cos((lat1 + lat2) * Math.PI / 360)
  return dlat * dlat + dlon * dlon
}

// 地域名 → 代表座標（一次細分区域 → 都道府県 の順で検索）
function coordForName(name: string): [number, number] | null {
  const sub = getSubRegionsCache()?.find(r => r.name === name)
  if (sub) return sub.label
  const prefs = getPrefecturesCache()
  if (prefs && name in prefs) return prefs[name].label
  return null
}

export interface TtsRegionOptions {
  intensityLevels: number  // 最大震度から何階級分読むか（0 = 最大のみ）
  maxRegions: number       // 読み上げる最大地域数（0 = 無制限）
}

function buildRegionText(
  points: EarthquakePoint[],
  maxScale: IntensityScale,
  opts: TtsRegionOptions,
  hypocenter?: { latitude: number; longitude: number },
): string {
  const maxIdx = SCALE_DESCENDING.indexOf(maxScale)
  if (maxIdx < 0) return ''

  const hasEpicenter = hypocenter != null && (hypocenter.latitude !== 0 || hypocenter.longitude !== 0)
  const stationData = getStationCoordsCache()
  const prefAreaNames = stationData ? buildPrefAreaNamesIndex(stationData) : null
  const areaPrefIndex = stationData ? buildAreaPrefIndex(stationData) : null

  const parts: string[] = []
  const mentioned = new Set<string>()  // 上位階で読み上げ済みの地域名
  for (let i = 0; i <= opts.intensityLevels; i++) {
    const scale = SCALE_DESCENDING[maxIdx + i]
    if (scale == null) break
    let names = regionNamesForScale(points, scale, prefAreaNames, areaPrefIndex).filter(n => !mentioned.has(n))
    if (names.length === 0) continue
    if (hasEpicenter) {
      names = [...names].sort((a, b) => {
        const ca = coordForName(a)
        const cb = coordForName(b)
        if (!ca && !cb) return 0
        if (!ca) return 1
        if (!cb) return -1
        return distSq(hypocenter!.latitude, hypocenter!.longitude, ca[0], ca[1])
             - distSq(hypocenter!.latitude, hypocenter!.longitude, cb[0], cb[1])
      })
    }
    let omittedCount = 0
    if (opts.maxRegions > 0 && names.length > opts.maxRegions) {
      omittedCount = names.length - opts.maxRegions
      names = names.slice(0, opts.maxRegions)
    }
    names.forEach(n => mentioned.add(n))
    const omittedSuffix = omittedCount > 0 ? `、ほか${omittedCount}地域` : ''
    parts.push(`${parts.length === 0 ? '最大' : ''}震度${intensityText(scale)}を${names.join('、')}${omittedSuffix}で`)
  }

  if (parts.length === 0) return ''
  return parts.join('、') + '観測しました。'
}

function magnitudeText(mag: number): string {
  // toFixed(1) で小数点以下1桁を明示し「きゅう」→「きゅうてんぜろ」のような誤読を防ぐ
  return mag.toFixed(1)
}

/** 「〇〇を震源とする」の〇〇部分を返す（Destination/ScaleAndDestination 系） */
function depthSourcePhrase(depth: number): string {
  if (depth <= 0) return 'ごく浅い場所'
  return `深さ${depth}キロメートル`
}

/** 「震源の深さ〇〇」の〇〇部分を返す（顕著な地震の震源要素更新のお知らせ 系） */
function depthAmendPhrase(depth: number): string {
  if (depth <= 0) return '震源の深さはごく浅く'
  return `震源の深さ${depth}キロメートル`
}

function intensityText(scale: IntensityScale | number): string {
  if (scale <= 0) return ''
  return getIntensityLabel(scale as IntensityScale)
}

function formatTime(isoTime: string): string {
  const d = new Date(isoTime)
  // 分をゼロ埋めすると VOICEVOX が「06分」を「ぜろろくふん」と桁読みしてしまうため、
  // TTS 用テキストではゼロ埋めしない（表示用の formatters.ts の formatTime とは別）
  return `${d.getHours()}時${d.getMinutes()}分`
}

/** VXSE43/45 EEW キャンセル（誤報取消）の読み上げテキストを生成する。 */
export function eewCancelToText(event: EEWAlert): string {
  const time = event.issue?.time ? formatTime(event.issue.time) : null
  return time
    ? `${time}に発表された緊急地震速報はキャンセルされました。`
    : '緊急地震速報はキャンセルされました。'
}

/**
 * VXSE51/52/53/61 地震情報取消の読み上げテキストを生成する。
 * time は取消電文自体の発表時刻ではなく、同一 eventId で最後に受信した地震情報の発表時刻を渡すこと
 * （呼び出し側 useLiveEventHandler.ts で解決する）。
 */
export function earthquakeCancelToText(time: string | null): string {
  const formatted = time ? formatTime(time) : null
  if (formatted) return `${formatted}に発表された地震情報はキャンセルされました。`
  return '地震情報はキャンセルされました。'
}

/**
 * EEW 第1フェーズ（isNew 即時、または続報での震源更新時）の読み上げテキストを生成する。
 * isHypocenterUpdate=true のとき「震源を更新、〇〇で地震。」（続報で震源名が大きく変わったケース向け）。
 */
export function eewAlertToText(event: EEWAlert, isHypocenterUpdate = false): string {
  const prefix = isHypocenterUpdate ? '震源を更新、' : '緊急地震速報、'
  return `${prefix}${event.earthquake.hypocenter.name}で地震。`
}

/** EEW 第2フェーズ（デバウンス後）: 「予想最大震度〇〇。」scale なし時は理由付き「予想震度なし。」 */
export function eewIntensityToText(event: EEWAlert): string {
  const scale = eewMaxScale(event)
  let text = ''
  if (scale > 0) {
    text += `予想最大震度${intensityText(scale)}。`
  } else {
    const condition = event.earthquake.condition
    const depth = event.earthquake.hypocenter.depth
    if (condition === '仮定震源要素') {
      text += '単独点処理のため、予想震度なし。'
    } else if (depth > 150) {
      text += '深発地震のため、予想震度なし。'
    } else {
      text += '予想震度なし。'
    }
  }
  if (event.forecastMaxLpgmClass != null && event.forecastMaxLpgmClass >= 1) {
    text += `予想最大階級${event.forecastMaxLpgmClass}。`
  }
  return text
}

/** VXSE43/45 EEW の読み上げテキストを生成する。 */
export function eewToText(event: EEWAlert): string {
  const { hypocenter } = event.earthquake
  const scale = eewMaxScale(event)
  let text = `緊急地震速報。${hypocenter.name}を震源とするマグニチュード${magnitudeText(hypocenter.magnitude)}の地震が発生しました。`
  if (scale > 0) {
    text += `予想最大震度${intensityText(scale)}。`
  }
  if (event.forecastMaxLpgmClass != null && event.forecastMaxLpgmClass >= 1) {
    text += `予想最大階級${event.forecastMaxLpgmClass}。`
  }
  return text
}

function domesticTsunamiText(t: DomesticTsunami): string {
  switch (t) {
    case 'なし':           return 'この地震による津波の心配はありません。'
    case '若干の海面変動':  return 'この地震による若干の海面変動が予想されますが、被害の心配はありません。'
    case '調査中':         return 'この地震による津波の有無を調査中です。'
    case '海面変動の可能性': return '震源が海底のため、津波が発生するおそれがあります。'
    case '注意報':         return '現在津波注意報を発表中です。'
    case '警報等':         return '現在津波警報等を発表中です。'
    case '不明':           return '津波情報は不明です。'
  }
}

/** VXSE51/52/53/61 地震情報の読み上げテキストを生成する。isNew=false のとき更新報として冒頭に通知する。 */
export function earthquakeToText(event: JMAQuake, opts: TtsRegionOptions, isNew: boolean): string {
  const { hypocenter, maxScale, domesticTsunami } = event.earthquake
  const type = event.issue.type

  if (type === '震度速報') {
    const prefix = isNew ? '震度速報。' : '震度速報が更新されました。'
    const regionText = buildRegionText(event.points, maxScale, opts, hypocenter)
    return `${prefix}${regionText || `最大震度${intensityText(maxScale)}を観測しました。`}`
  }

  const time = formatTime(event.earthquake.time)

  if (type === '顕著な地震の震源要素更新のお知らせ') {
    // この電文（VXSE61）は震源要素の更新のみを伝え、津波の有無は含まない。
    // 津波情報は別電文（VTSE41/51/52）で発表されるため、ここでは読み上げない。
    return `顕著な地震の震源要素更新のお知らせ。${time}頃発生した${hypocenter.name}の地震について、${depthAmendPhrase(hypocenter.depth)}、マグニチュード${magnitudeText(hypocenter.magnitude)}に更新されました。`
  }

  if (type === '震源情報' || type === '遠地地震' || type === 'その他') {
    const prefix = isNew ? '震源情報。' : '震源情報が更新されました。'
    let text = `${prefix}${time}頃、${hypocenter.name}、${depthSourcePhrase(hypocenter.depth)}を震源とするマグニチュード${magnitudeText(hypocenter.magnitude)}の地震が発生しました。`
    text += domesticTsunamiText(domesticTsunami)
    return text
  }

  // ScaleAndDestination / DetailScale
  const prefix = isNew ? '地震情報。' : '地震情報が更新されました。'
  let text = `${prefix}${time}頃、${hypocenter.name}、${depthSourcePhrase(hypocenter.depth)}を震源とするマグニチュード${magnitudeText(hypocenter.magnitude)}の地震が発生しました。`

  text += domesticTsunamiText(domesticTsunami)

  const regionText = buildRegionText(event.points, maxScale, opts, hypocenter)
  if (regionText) {
    text += regionText
  }

  return text
}

/** VTSE41/51/52 津波情報の読み上げテキストを生成する（新規発表・引き上げ時）。 */
function tsunamiHeightToSpeech(description: string): string {
  // "３ｍ" → "3メートル"、"１０ｍ以上" → "10メートル以上"、"０．５ｍ" → "0.5メートル" など
  return description
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, '.')
    .replace(/ｍ/g, 'メートル')
}

// 同じ波高の区域をグループ化し「岩手県・宮城県で10メートル以上、福島県で6メートル」のような文を生成する
function tsunamiHeightSentence(areas: import('../types/earthquake').TsunamiArea[]): string {
  const withHeight = areas.filter(a => a.maxHeight)
  if (withHeight.length === 0) return ''

  // description をキーにグループ化
  const groups = new Map<string, string[]>()
  for (const a of withHeight) {
    const key = a.maxHeight!.description
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(a.name)
  }

  const parts = [...groups.entries()].map(([desc, names]) =>
    `${names.join('・')}で${tsunamiHeightToSpeech(desc)}`
  )

  return `予想最大波高は、${parts.join('、')}です。`
}

// 下位グレード区域を1文にまとめる。例:「また、〇〇に津波警報、××に津波注意報が発表されています。」
function lowerGradeSentence(areas: import('../types/earthquake').TsunamiArea[], topGrade: string): string {
  const parts = GRADE_ORDER
    .filter(g => g !== topGrade)
    .map(g => {
      const matched = areas.filter(a => a.grade === g)
      if (matched.length === 0) return ''
      return `${matched.map(a => a.name).join('・')}に${tsunamiGradeLabel(g)}`
    })
    .filter(Boolean)
  return parts.length > 0 ? `また、${parts.join('、')}が発表されています。` : ''
}

export function tsunamiToText(event: JMATsunami): string {
  const topGrade = GRADE_ORDER.find(g => event.areas.some(a => a.grade === g))
  if (!topGrade) return ''

  const topAreas = event.areas.filter(a => a.grade === topGrade)
  const areaNames = topAreas.map(a => a.name).join('、')
  const gradeLabel = tsunamiGradeLabel(topGrade)
  const action = topGrade === 'MajorWarning' ? 'ただちに高台へ避難してください。'
    : topGrade === 'Warning' ? '海岸から離れてください。'
    : topGrade === 'Forecast' ? '若干の海面変動が予想されますが、被害の心配はありません。' : ''
  const heightPart = tsunamiHeightSentence(topAreas)
  const lowerPart = lowerGradeSentence(event.areas, topGrade)

  return `${gradeLabel}。${areaNames}に${gradeLabel}が発表されました。${action}${heightPart}${lowerPart}`
}

/** VTSE41/51/52 津波情報 引き下げ時の読み上げテキストを生成する。 */
export function tsunamiDowngradeToText(event: JMATsunami): string {
  const topGrade = GRADE_ORDER.find(g => event.areas.some(a => a.grade === g))
  if (!topGrade) return tsunamiCancelToText()

  const topAreas = event.areas.filter(a => a.grade === topGrade)
  const areaNames = topAreas.map(a => a.name).join('、')
  const gradeLabel = tsunamiGradeLabel(topGrade)
  const heightPart = tsunamiHeightSentence(topAreas)
  const lowerPart = lowerGradeSentence(event.areas, topGrade)

  return `${gradeLabel}に切り替えられました。現在、${areaNames}に${gradeLabel}が発表されています。${heightPart}${lowerPart}`
}

/** VTSE41/51/52 津波警報等 全解除の読み上げテキストを生成する。 */
export function tsunamiCancelToText(): string {
  return '津波警報等は全て解除されました。'
}

// 観測点を districtName（津波予報区）ごとにグループ化し、「区域名、地点1で〜、地点2で〜」の形にまとめる。
// districtName が無い観測（沖合単独観測など）は区域名を付けず、単独の項目として扱う。
function tsunamiObservationDetailText(items: TsunamiObservation[]): string {
  const groups: { districtName: string | null; items: TsunamiObservation[] }[] = []
  for (const o of items) {
    const key = o.districtName ?? null
    const existing = key !== null ? groups.find(g => g.districtName === key) : undefined
    if (existing) existing.items.push(o)
    else groups.push({ districtName: key, items: [o] })
  }
  return groups.map(g => {
    const stations = g.items.map(o => `${o.name}で${o.height!.description.replace(/m(?=以上|$)/i, 'メートル')}`).join('、')
    return g.districtName ? `${g.districtName}、${stations}` : stations
  }).join('、')
}

/** VTSE41/51/52 津波観測情報 読み上げテキストを生成する（波高の大きい順に上位 maxPoints 件）。 */
export function tsunamiObservationToText(event: JMATsunami, maxPoints = 5): string {
  const obs = (event.observations ?? []).filter(o => o.height !== undefined)
  if (obs.length === 0) return ''
  const sorted = [...obs].sort((a, b) => b.height!.value - a.height!.value).slice(0, maxPoints)
  const total = obs.length
  // headline の全角数字・全角ｍ・全角ピリオドを半角に変換して VOICEVOX の誤読を防ぐ
  const rawHeadline = event.headline ? event.headline.trim() : ''
  const headline = tsunamiHeightToSpeech(rawHeadline)
  const headlinePart = headline ? `${headline}` : `${total}か所で津波を観測しています。`
  const detail = tsunamiObservationDetailText(sorted)
  return `津波観測情報。${headlinePart}${detail}。`
}

/**
 * VTSE41/51/52 津波観測情報 更新点のみ読み上げテキストを生成する。
 * updatedObs は最大波高が更新された観測点のみを渡す（波高降順で最大 maxPoints 件）。
 */
export function tsunamiObservationUpdateToText(updatedObs: TsunamiObservation[], headline?: string, maxPoints = 5): string {
  const obs = updatedObs.filter(o => o.height !== undefined)
  if (obs.length === 0) return ''
  const sorted = [...obs].sort((a, b) => b.height!.value - a.height!.value).slice(0, maxPoints)
  const detail = tsunamiObservationDetailText(sorted)
  // headline の全角数字・全角ｍ・全角ピリオドを半角に変換して VOICEVOX の誤読を防ぐ
  const headlinePart = headline?.trim() ? tsunamiHeightToSpeech(headline.trim()) : ''
  return `津波観測情報。${headlinePart}${detail}を観測しました。`
}

// 観測点を districtName（津波予報区）ごとにグループ化し、地点名のみ列挙する（tsunamiObservationDetailText の波高なし版）。
function tsunamiArrivalDetailText(items: TsunamiObservation[]): string {
  const groups: { districtName: string | null; items: TsunamiObservation[] }[] = []
  for (const o of items) {
    const key = o.districtName ?? null
    const existing = key !== null ? groups.find(g => g.districtName === key) : undefined
    if (existing) existing.items.push(o)
    else groups.push({ districtName: key, items: [o] })
  }
  return groups.map(g => {
    const stations = g.items.map(o => o.name).join('・')
    return g.districtName ? `${g.districtName}、${stations}` : stations
  }).join('、')
}

/**
 * 最大波高が未確定（「観測中」）のまま新規に到達が確認された観測点の読み上げテキストを生成する。
 * まだ maxHeight の数値が出ていない観測点（JMA電文で maxHeight.condition = "観測中"）が対象。
 * 波高が未確定であること自体も明示的に読み上げる。件数は maxPoints で絞り、他 tsunami 系読み上げと同様に上限を設ける。
 * 波高読み上げ（tsunamiObservationDetailText）と同様に districtName（津波予報区）ごとにグループ化する。
 */
export function tsunamiArrivalToText(obs: TsunamiObservation[], maxPoints = 5): string {
  if (obs.length === 0) return ''
  const shown = obs.slice(0, maxPoints)
  const omitted = obs.length - shown.length
  const suffix = omitted > 0 ? `、ほか${omitted}地点` : ''
  const detail = tsunamiArrivalDetailText(shown)
  return `${detail}${suffix}で到達を確認しました。最大波高は観測中です。`
}

/** 南海トラフ地震臨時情報（VYSE50/51/52）の読み上げテキストを生成する。 */
export function nankaiToText(event: JMANankai): string {
  if (event.cancelled || event.kindName === '調査終了') {
    return '南海トラフ地震臨時情報、調査終了。南海トラフ地震の発生可能性は通常の範囲内でした。'
  }
  if (event.kindName === '調査中') {
    return '南海トラフ地震臨時情報、調査中。南海トラフ地震の発生可能性について調査しています。最新情報に注意してください。'
  }
  if (event.kindName === '巨大地震警戒') {
    return '南海トラフ地震臨時情報、巨大地震警戒。南海トラフ地震の想定震源域内で大規模な地震が発生しました。直ちに防災対応をとってください。'
  }
  if (event.kindName === '巨大地震注意') {
    return '南海トラフ地震臨時情報、巨大地震注意。南海トラフ地震の想定震源域内で地震が発生しました。防災対応の確認をしてください。'
  }
  return '南海トラフ地震臨時情報。南海トラフ地震に関する臨時情報が発表されました。最新情報に注意してください。'
}

/** 北海道・三陸沖後発地震注意情報（VYSE60）の読み上げテキストを生成する。 */
export function kohatsuToText(event: JMAKohatsu): string {
  const headline = event.headline.replace(/北海道・三陸沖後発地震注意情報/g, '')
  return `北海道・三陸沖後発地震注意情報。${headline ? headline + '。' : ''}今後、大規模地震の発生可能性が平常時より高まっています。防災対応の確認をしてください。`
}

// 一次細分区域名のリストのうち、県内全区域が同じ階級で揃っているものを「〇〇県」1件にまとめる。
// areaPrefIndex / prefAreaNames が引けない（未読み込み）場合はまとめず区域名をそのまま返す。
function aggregateLpgmNamesByPref(
  names: string[],
  areaPrefIndex: Map<string, string> | null,
  prefAreaNames: Map<string, Set<string>> | null,
): string[] {
  if (!areaPrefIndex) return names
  const byPref = new Map<string, Set<string>>()
  const noPref: string[] = []
  for (const name of names) {
    const pref = areaPrefIndex.get(name)
    if (!pref) { noPref.push(name); continue }
    const set = byPref.get(pref) ?? new Set<string>()
    set.add(name)
    byPref.set(pref, set)
  }
  const result: string[] = [...noPref]
  for (const [pref, regionNames] of byPref) {
    const fullSet = prefAreaNames?.get(pref)
    const isWholePref = fullSet != null && fullSet.size > 0
      && regionNames.size === fullSet.size && [...regionNames].every(n => fullSet.has(n))
    if (isWholePref) result.push(pref)
    else result.push(...regionNames)
  }
  return result
}

// 長周期地震動の観測地域テキストを生成する（buildRegionText の LPGM 版）
function buildLpgmRegionText(lpgm: JMALpgm, opts: TtsRegionOptions): string {
  if (!lpgm.regions || lpgm.regions.length === 0) return ''

  // 階級ごとに地域名をまとめる（降順）
  const byClass = new Map<number, string[]>()
  for (const r of lpgm.regions) {
    if (r.maxLgInt < 1) continue
    const names = byClass.get(r.maxLgInt) ?? []
    names.push(r.name)
    byClass.set(r.maxLgInt, names)
  }
  const classes = [...byClass.keys()].sort((a, b) => b - a)
  if (classes.length === 0) return ''

  const stationData = getStationCoordsCache()
  const areaPrefIndex = stationData ? buildAreaPrefIndex(stationData) : null
  const prefAreaNames = stationData ? buildPrefAreaNamesIndex(stationData) : null

  const parts: string[] = []
  const mentioned = new Set<string>()
  for (let i = 0; i <= opts.intensityLevels; i++) {
    const cls = classes[i]
    if (cls == null) break
    let names = aggregateLpgmNamesByPref((byClass.get(cls) ?? []), areaPrefIndex, prefAreaNames)
      .filter(n => !mentioned.has(n))
    if (names.length === 0) continue
    let omittedCount = 0
    if (opts.maxRegions > 0 && names.length > opts.maxRegions) {
      omittedCount = names.length - opts.maxRegions
      names = names.slice(0, opts.maxRegions)
    }
    names.forEach(n => mentioned.add(n))
    const omittedSuffix = omittedCount > 0 ? `、ほか${omittedCount}地域` : ''
    parts.push(`階級${cls}を${names.join('、')}${omittedSuffix}で`)
  }

  if (parts.length === 0) return ''
  return parts.join('、') + '観測しました。'
}

/** VXSE62 長周期地震動情報の読み上げテキストを生成する。isNew=false のとき更新報として冒頭に通知する。 */
export function lpgmToText(lpgm: JMALpgm, opts: TtsRegionOptions, isNew: boolean): string {
  if (lpgm.cancelled) {
    return '長周期地震動情報はキャンセルされました。'
  }
  const time = formatTime(lpgm.originTime)
  const prefix = isNew ? '長周期地震動情報。' : '長周期地震動情報が更新されました。'
  const regionText = buildLpgmRegionText(lpgm, opts)
  if (regionText) {
    return `${prefix}${time}頃発生した地震で、長周期地震動${regionText}`
  }
  return `${prefix}${time}頃発生した地震で、長周期地震動階級${lpgm.maxClass}を観測しました。`
}

export { tsunamiMaxGrade }
