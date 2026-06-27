import type { EEWAlert, JMAQuake, JMATsunami, JMANankai, JMAKohatsu, JMALpgm, IntensityScale, TsunamiGrade, EarthquakePoint } from '../types/earthquake'
import { eewMaxScale } from './eew'
import { getIntensityLabel } from './intensity'
import { tsunamiMaxGrade } from './tsunami'

const GRADE_ORDER: TsunamiGrade[] = ['MajorWarning', 'Warning', 'Watch']

// 震度スケールの降順リスト
const SCALE_DESCENDING: IntensityScale[] = [70, 60, 55, 50, 45, 40, 30, 20, 10] as IntensityScale[]

function regionNamesForScale(points: EarthquakePoint[], scale: IntensityScale): string[] {
  const matched = points.filter(p => p.scale === scale)
  const areas = [...new Set(matched.filter(p => p.isArea && p.addr !== p.pref).map(p => p.addr))]
  if (areas.length > 0) return areas
  return [...new Set(matched.map(p => p.pref).filter(Boolean))]
}

export interface TtsRegionOptions {
  intensityLevels: number  // 最大震度から何階級分読むか（0 = 最大のみ）
  maxRegions: number       // 読み上げる最大地域数（0 = 無制限）
}

function buildRegionText(
  points: EarthquakePoint[],
  maxScale: IntensityScale,
  opts: TtsRegionOptions,
): string {
  const maxIdx = SCALE_DESCENDING.indexOf(maxScale)
  if (maxIdx < 0) return ''

  const parts: string[] = []
  for (let i = 0; i <= opts.intensityLevels; i++) {
    const scale = SCALE_DESCENDING[maxIdx + i]
    if (scale == null) break
    let names = regionNamesForScale(points, scale)
    if (names.length === 0) continue
    if (opts.maxRegions > 0) names = names.slice(0, opts.maxRegions)
    parts.push(`${parts.length === 0 ? '最大' : ''}震度${intensityText(scale)}を${names.join('、')}で`)
  }

  if (parts.length === 0) return ''
  return parts.join('、') + '観測しました。'
}

function magnitudeText(mag: number): string {
  // toFixed(1) で小数点以下1桁を明示し「きゅう」→「きゅうてんぜろ」のような誤読を防ぐ
  return mag.toFixed(1)
}

function depthText(depth: number): string {
  if (depth <= 0) return 'ごく浅い'
  return `${depth}キロメートル`
}

function intensityText(scale: IntensityScale | number): string {
  if (scale <= 0) return ''
  return getIntensityLabel(scale as IntensityScale)
}

function formatTime(isoTime: string): string {
  const d = new Date(isoTime)
  return `${d.getHours()}時${String(d.getMinutes()).padStart(2, '0')}分`
}

/** code 556 EEW キャンセル（誤報取消）の読み上げテキストを生成する。 */
export function eewCancelToText(event: EEWAlert): string {
  const time = event.issue?.time ? formatTime(event.issue.time) : null
  return time
    ? `${time}に発表された緊急地震速報はキャンセルされました。`
    : '緊急地震速報はキャンセルされました。'
}

/** EEW 第1フェーズ（isNew 即時）: 「緊急地震速報、〇〇で地震。」 */
export function eewAlertToText(event: EEWAlert): string {
  return `緊急地震速報、${event.earthquake.hypocenter.name}で地震。`
}

/** EEW 第2フェーズ（デバウンス後）: 「予想最大震度〇〇。」scale なし時は空文字 */
export function eewIntensityToText(event: EEWAlert): string {
  const scale = eewMaxScale(event)
  let text = ''
  if (scale > 0) {
    text += `予想最大震度${intensityText(scale)}。`
  }
  if (event.forecastMaxLpgmClass != null && event.forecastMaxLpgmClass >= 1) {
    text += `予想最大階級${event.forecastMaxLpgmClass}。`
  }
  return text
}

/** code 556 EEW の読み上げテキストを生成する。 */
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

/** code 551 地震情報の読み上げテキストを生成する。 */
export function earthquakeToText(event: JMAQuake, opts: TtsRegionOptions): string {
  const { hypocenter, maxScale, domesticTsunami } = event.earthquake
  const type = event.issue.type

  if (type === 'ScalePrompt') {
    const regionText = buildRegionText(event.points, maxScale, opts)
    return `震度速報。${regionText || `最大震度${intensityText(maxScale)}を観測しました。`}`
  }

  const time = formatTime(event.earthquake.time)

  if (type === 'DestinationAmended') {
    return `顕著な地震の震源要素更新のお知らせ。${time}頃発生した${hypocenter.name}の地震について、震源の深さ${depthText(hypocenter.depth)}、マグニチュード${magnitudeText(hypocenter.magnitude)}に更新されました。`
  }

  if (type === 'Destination' || type === 'Foreign' || type === 'Other') {
    return `震源情報。${time}頃、${hypocenter.name}、深さ${depthText(hypocenter.depth)}を震源とするマグニチュード${magnitudeText(hypocenter.magnitude)}の地震が発生しました。`
  }

  // ScaleAndDestination / DetailScale
  let text = `地震情報。${time}頃、${hypocenter.name}、深さ${depthText(hypocenter.depth)}を震源とするマグニチュード${magnitudeText(hypocenter.magnitude)}の地震が発生しました。`
  const regionText = buildRegionText(event.points, maxScale, opts)
  if (regionText) {
    text += regionText
  }

  if (domesticTsunami === 'None' || domesticTsunami === 'NonEffective') {
    text += 'この地震による津波の心配はありません。'
  } else if (domesticTsunami === 'Watch') {
    text += 'この地震により、一部の沿岸に津波注意報が発表されています。'
  } else if (domesticTsunami === 'Warning') {
    text += 'この地震により、一部の沿岸に津波警報等が発表されています。注意してください。'
  }

  return text
}

/** code 552 津波情報の読み上げテキストを生成する（新規発表・引き上げ時）。 */
export function tsunamiToText(event: JMATsunami): string {
  const topGrade = GRADE_ORDER.find(g => event.areas.some(a => a.grade === g))
  if (!topGrade) return ''

  const areas = event.areas.filter(a => a.grade === topGrade).map(a => a.name)
  const gradeLabel = topGrade === 'MajorWarning' ? 'おおつなみけいほう'
    : topGrade === 'Warning' ? '津波警報' : '津波注意報'
  const action = topGrade === 'MajorWarning' ? 'ただちに高台へ避難してください。'
    : topGrade === 'Warning' ? '海岸から離れてください。' : ''

  return `${gradeLabel}。${areas.join('、')}に${gradeLabel}が発表されました。${action}`
}

/** code 552 津波情報 引き下げ時の読み上げテキストを生成する。 */
export function tsunamiDowngradeToText(event: JMATsunami): string {
  const topGrade = GRADE_ORDER.find(g => event.areas.some(a => a.grade === g))
  if (!topGrade) return tsunamiCancelToText()

  const areas = event.areas.filter(a => a.grade === topGrade).map(a => a.name)
  const gradeLabel = topGrade === 'MajorWarning' ? 'おおつなみけいほう'
    : topGrade === 'Warning' ? '津波警報' : '津波注意報'

  return `津波情報が更新されました。現在、${areas.join('、')}に${gradeLabel}が発表されています。`
}

/** code 552 津波警報等 全解除の読み上げテキストを生成する。 */
export function tsunamiCancelToText(): string {
  return '津波警報等は全て解除されました。'
}

/** 南海トラフ地震臨時情報（VYSE50/51/52）の読み上げテキストを生成する。 */
export function nankaiToText(event: JMANankai): string {
  if (event.cancelled || event.kindName === '調査終了') {
    return '南海トラフ地震臨時情報、調査終了。南海トラフ地震の発生可能性は通常の範囲内でした。'
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

/** VXSE62 長周期地震動情報の読み上げテキストを生成する。 */
export function lpgmToText(lpgm: JMALpgm): string {
  const time = formatTime(lpgm.originTime)
  return `長周期地震動情報。${time}頃発生した地震で、長周期地震動階級${lpgm.maxClass}を観測しました。`
}

export { tsunamiMaxGrade }
