// Yahoo 強震モニタ（リアルタイム震度）のデータ取得。
// 観測点リストとリアルタイム震度を HTTPS の JSON で取得する。
//
// 参考: https://note.com/looksky758/n/ne9115f77d27a
//   - 観測点: https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList/sitelist.json
//   - 震度  : https://weather-kyoshin.{west|east}.edge.storage-yahoo.jp/RealTimeData/yyyyMMdd/yyyyMMddHHmmss.json
//   - intensity 文字列は各文字の charCode - 100 が観測点ごとの震度インデックス(0〜20)。

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

export interface RealtimeIntensity {
  dataTime: string
  /** 観測点ごとの震度インデックス(0〜20)。sitelist と同順。 */
  indices: number[]
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
      }
      const intensity = json.realTimeData?.intensity ?? ''
      const indices = Array.from(intensity, (c) => c.charCodeAt(0) - 100)
      return { dataTime: json.realTimeData?.dataTime ?? '', indices }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('realtime fetch failed')
}
