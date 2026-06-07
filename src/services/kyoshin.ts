// Yahoo 強震モニタ（リアルタイム震度）のデータ取得。
// 観測点リストとリアルタイム震度を HTTPS の JSON で取得する。
//
// 参考: https://note.com/looksky758/n/ne9115f77d27a
//   - 観測点: https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList/sitelist.json
//   - 震度  : https://weather-kyoshin.{west|east}.edge.storage-yahoo.jp/RealTimeData/yyyyMMdd/yyyyMMddHHmmss.json
//   - intensity 文字列は各文字の charCode - 100 が観測点ごとの震度インデックス(0〜20)。

import type { EEWAlert, IntensityScale } from '../types/earthquake'

/** 観測点座標の配列（[緯度, 経度]）。インデックスが intensity 文字列の位置に対応。 */
export type SiteCoords = [number, number][]

const SITELIST_URL =
  'https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList/sitelist.json'
const REALTIME_BASE = (edge: 'west' | 'east') =>
  `https://weather-kyoshin.${edge}.edge.storage-yahoo.jp/RealTimeData`

/** 観測点リストを取得する。 */
export async function fetchSiteList(): Promise<SiteCoords> {
  const res = await fetch(SITELIST_URL)
  if (!res.ok) throw new Error(`sitelist fetch failed: ${res.status}`)
  const json = (await res.json()) as { items: SiteCoords }
  return json.items
}

/** 日時を JST(UTC+9)の {yyyyMMdd, yyyyMMddHHmmss} 文字列に変換する。 */
function jstParts(date: Date): { dateStr: string; ts: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  const hour = get('hour') === '24' ? '00' : get('hour')
  const dateStr = `${get('year')}${get('month')}${get('day')}`
  return { dateStr, ts: `${dateStr}${hour}${get('minute')}${get('second')}` }
}

/** 緊急地震速報の予報円（P波/S波）。半径は km。 */
export interface PsWaveCircle {
  lat: number
  lng: number
  pRadius: number
  sRadius: number
}

/** Yahoo hypoInfo の EEW 情報（1件）。フィールドはすべて文字列。 */
export interface YahooHypoInfoItem {
  reportId: string
  reportNum: string
  reportTime: string
  originTime: string
  regionCode?: string
  regionName: string
  latitude: string
  longitude: string
  depth: string
  magnitude: string
  calcintensity: string
  isFinal: string
  isCancel: string
  isTraining: string
}

export interface RealtimeIntensity {
  dataTime: string
  /** 観測点ごとの震度インデックス(0〜20)。sitelist と同順。 */
  indices: number[]
  /** 予報円（EEW 発報中のみ要素を持つ）。 */
  psWave: PsWaveCircle[]
  /** EEW 情報（発報中のみ要素を持つ）。 */
  hypoInfo: YahooHypoInfoItem[]
}

/** "35.5N" / "139.5E" 形式の座標文字列を数値に変換する。 */
function parseCoord(value: string | undefined): number {
  if (!value) return NaN
  return parseFloat(value.replace(/[NESW]/i, ''))
}

/** "60km" などの深さ文字列を km 数値に変換する。不明な場合は -1。 */
function parseDepth(value: string | undefined): number {
  if (!value) return -1
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : -1
}

/**
 * Yahoo の calcintensity コードを IntensityScale に変換する。
 * フォーマット: "01"→10, "02"→20, "03"→30, "04"→40,
 *              "5-"→45, "5+"→50, "6-"→55, "6+"→60, "07"→70, "//"→-1(不明)
 */
function calcintensityToScale(s: string): IntensityScale {
  const map: Record<string, IntensityScale> = {
    '01': 10, '02': 20, '03': 30, '04': 40,
    '5-': 45, '5+': 50, '6-': 55, '6+': 60, '07': 70,
  }
  return map[s] ?? -1
}

/** Yahoo hypoInfo の1件を EEWAlert に変換する。 */
export function hypoInfoItemToEEW(item: YahooHypoInfoItem): EEWAlert {
  const scale = calcintensityToScale(item.calcintensity)
  const scaleNum = scale === -1 ? 0 : scale
  return {
    code: 556,
    id: `yahoo-eew-${item.reportId}`,
    time: item.reportTime,
    test: item.isTraining === 'true',
    earthquake: {
      originTime: item.originTime,
      arrivalTime: '',
      condition: '以上',
      hypocenter: {
        name: item.regionName,
        latitude: parseCoord(item.latitude),
        longitude: parseCoord(item.longitude),
        depth: parseDepth(item.depth),
        magnitude: parseFloat(item.magnitude) || 0,
      },
    },
    severity: scaleNum >= 45 ? 'Warning' : 'Forecast',
    forecastMaxScale: scale >= 0 ? scale : undefined,
    cancelled: item.isCancel === 'true',
    isFinal: item.isFinal === 'true',
    issue: {
      eventId: item.reportId,
      serial: item.reportNum,
      time: item.reportTime,
    },
    areas: [],
  }
}

/**
 * 指定時刻のリアルタイム震度を取得する。配信遅延を見込んで約2秒巻き戻す。
 * west エッジが失敗したら east エッジにフォールバックする。
 */
export async function fetchRealtimeIntensity(now: Date): Promise<RealtimeIntensity> {
  const { dateStr, ts } = jstParts(new Date(now.getTime() - 2000))
  let lastErr: unknown = null
  for (const edge of ['west', 'east'] as const) {
    try {
      const res = await fetch(`${REALTIME_BASE(edge)}/${dateStr}/${ts}.json`)
      if (!res.ok) {
        lastErr = new Error(`realtime fetch failed: ${res.status}`)
        continue
      }
      const json = (await res.json()) as {
        realTimeData?: { dataTime?: string; intensity?: string }
        psWave?: {
          items?: { latitude?: string; longitude?: string; pRadius?: number; sRadius?: number }[]
        }
        hypoInfo?: { items?: YahooHypoInfoItem[] }
      }
      const intensity = json.realTimeData?.intensity ?? ''
      const indices = Array.from(intensity, (c) => c.charCodeAt(0) - 100)
      const psWave: PsWaveCircle[] = (json.psWave?.items ?? [])
        .map((it) => ({
          lat: parseCoord(it.latitude),
          lng: parseCoord(it.longitude),
          pRadius: Number(it.pRadius) || 0,
          sRadius: Number(it.sRadius) || 0,
        }))
        .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng))
      const hypoInfo: YahooHypoInfoItem[] = json.hypoInfo?.items ?? []
      return { dataTime: json.realTimeData?.dataTime ?? '', indices, psWave, hypoInfo }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('realtime fetch failed')
}
