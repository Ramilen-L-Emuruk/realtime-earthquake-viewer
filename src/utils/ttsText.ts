import type { EEWAlert, JMAQuake, JMATsunami, IntensityScale, TsunamiGrade } from '../types/earthquake'
import { eewMaxScale } from './eew'
import { getIntensityLabel } from './intensity'
import { tsunamiMaxGrade } from './tsunami'

const GRADE_ORDER: TsunamiGrade[] = ['MajorWarning', 'Warning', 'Watch']

function magnitudeText(mag: number): string {
  // toFixed(1) で小数点以下1桁を明示し「きゅう」→「きゅうてんぜろ」のような誤読を防ぐ
  return mag.toFixed(1)
}

function intensityText(scale: IntensityScale | number): string {
  if (scale <= 0) return ''
  return getIntensityLabel(scale as IntensityScale)
}

function formatTime(isoTime: string): string {
  const d = new Date(isoTime)
  return `${d.getHours()}時${String(d.getMinutes()).padStart(2, '0')}分`
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
export function earthquakeToText(event: JMAQuake): string {
  const { hypocenter, maxScale, domesticTsunami } = event.earthquake
  const type = event.issue.type

  if (type === 'ScalePrompt') {
    const prefs = [...new Set(event.points.filter(p => p.scale === maxScale).map(p => p.pref))]
    return `震度速報。最大震度${intensityText(maxScale)}を${prefs.join('、')}で観測しました。`
  }

  const time = formatTime(event.earthquake.time)

  if (type === 'DestinationAmended') {
    return `顕著な地震の震源要素更新のお知らせ。${time}頃発生した${hypocenter.name}の地震について、震源の深さ${hypocenter.depth}キロメートル、マグニチュード${magnitudeText(hypocenter.magnitude)}に更新されました。`
  }

  if (type === 'Destination' || type === 'Foreign' || type === 'Other') {
    return `震源情報。${time}頃、${hypocenter.name}、深さ${hypocenter.depth}キロメートルを震源とするマグニチュード${magnitudeText(hypocenter.magnitude)}の地震が発生しました。`
  }

  // ScaleAndDestination / DetailScale
  const prefs = [...new Set(event.points.filter(p => p.scale === maxScale).map(p => p.pref))]
  let text = `地震情報。${time}頃、${hypocenter.name}、深さ${hypocenter.depth}キロメートルを震源とするマグニチュード${magnitudeText(hypocenter.magnitude)}の地震が発生しました。`
  if (prefs.length > 0) {
    text += `最大震度${intensityText(maxScale)}を${prefs.join('、')}で観測しました。`
  }

  if (domesticTsunami === 'None' || domesticTsunami === 'NonEffective') {
    text += '津波の心配はありません。'
  } else if (domesticTsunami === 'Watch') {
    text += 'この地震により、一部の沿岸に津波注意報が発表されています。'
  } else if (domesticTsunami === 'Warning') {
    text += 'この地震により、一部の沿岸に津波警報等が発表されています。注意してください。'
  }

  return text
}

/** code 552 津波情報の読み上げテキストを生成する。 */
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

export { tsunamiMaxGrade }
