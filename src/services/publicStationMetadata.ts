import { API_FETCH_TIMEOUT_MS, fetchWithTimeout } from '../utils/fetchWithTimeout'
import type { PublicChannel, PublicChannelCode, PublicStationEpoch, PublicStationsFile } from '../utils/publicStations'

/** 感度を含むStationXML。全運用期間を1回で照合し、過去のカードにも使う。 */
export const PUBLIC_STATION_METADATA_URL = 'https://service.earthscope.org/fdsnws/station/1/query?net=JP&cha=BH?&level=response&format=xml&nodata=404'
const COMPONENTS: readonly PublicChannelCode[] = ['BHE', 'BHN', 'BHZ']
const children = (el: Element, name: string) => Array.from(el.children).filter(c => c.localName === name)
function child(el: Element, name: string): Element {
  const found = children(el, name)[0]
  if (!found) throw new Error(`StationXML: ${name} がない`)
  return found
}
function number(el: Element, name: string): number {
  const raw = child(el, name).textContent?.trim() ?? ''
  const value = Number(raw)
  if (raw === '' || !Number.isFinite(value)) throw new Error(`StationXML: ${name} が数値でない`)
  return value
}
/** 上流の終わりは含む側。生成時と同じく秒へ切り上げ、半開区間へ直す。 */
function time(raw: string | null, end = false): number {
  if (!raw) return end ? Infinity : NaN
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : raw + 'Z'
  const value = Date.parse(normalized)
  if (!Number.isFinite(value)) throw new Error('StationXML: 時刻が読めない')
  const fraction = /\.(\d+)/.exec(raw)?.[1] ?? ''
  return Math.floor(value / 1000) * 1000 + (end && /[1-9]/.test(fraction) ? 1000 : 0)
}
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + 'Z'
const endMs = (epoch: PublicStationEpoch) => epoch.end === null ? Infinity : Date.parse(epoch.end)
function properties(epoch: PublicStationEpoch): string {
  return JSON.stringify([epoch.code, epoch.nameJa, epoch.siteName, epoch.lat, epoch.lon, epoch.elevation,
    epoch.channels.map(c => [c.code, c.sampleRate, c.sensitivity, c.sensitivityFreq, c.azimuth, c.dip]).sort()])
}

/** 座標・名前・感度・成分・運用期間を読む。応答の一部が壊れていれば表全体を採用しない。 */
export function parsePublicStationXml(xml: string, baseline: PublicStationsFile): PublicStationEpoch[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagNameNS('*', 'parsererror').length || doc.documentElement.localName !== 'FDSNStationXML') throw new Error('StationXML: XMLが読めない')
  const epochs: PublicStationEpoch[] = []
  for (const network of children(doc.documentElement, 'Network')) {
    if (network.getAttribute('code') !== 'JP') continue
    for (const station of children(network, 'Station')) {
      const code = station.getAttribute('code') ?? ''
      if (!/^[A-Z0-9]{1,5}$/.test(code)) throw new Error('StationXML: 観測点コードが不正')
      const start = time(station.getAttribute('startDate'))
      const end = time(station.getAttribute('endDate'), true)
      if (!(start < end)) throw new Error('StationXML: 運用期間が不正')
      const lat = number(station, 'Latitude'), lon = number(station, 'Longitude'), elevation = number(station, 'Elevation')
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('StationXML: 座標が不正')
      const siteName = child(child(station, 'Site'), 'Name').textContent?.trim() || code
      // 既知の地点名には気象庁の日本語名を保つ。新しい地点名は推測で訳さず上流の名前を使う。
      const nameJa = baseline.stations.find(s => s.code === code && s.siteName === siteName)?.nameJa ?? siteName
      const channels: { start: number; end: number; value: PublicChannel }[] = []
      for (const channel of children(station, 'Channel')) {
        const component = channel.getAttribute('code') as PublicChannelCode
        if (!COMPONENTS.includes(component) || (channel.getAttribute('locationCode') ?? '') !== '') continue
        const from = Math.max(start, time(channel.getAttribute('startDate')))
        const to = Math.min(end, time(channel.getAttribute('endDate'), true))
        if (!(from < to)) throw new Error('StationXML: 成分の運用期間が不正')
        const sensitivity = child(child(channel, 'Response'), 'InstrumentSensitivity')
        const unit = child(child(sensitivity, 'InputUnits'), 'Name').textContent?.trim().toUpperCase()
        if (unit !== 'M/S') throw new Error('StationXML: 速度以外の単位')
        const value: PublicChannel = { code: component, sampleRate: number(channel, 'SampleRate'), sensitivity: number(sensitivity, 'Value'), sensitivityFreq: number(sensitivity, 'Frequency'), azimuth: number(channel, 'Azimuth'), dip: number(channel, 'Dip') }
        if (!(value.sampleRate > 0 && value.sensitivity > 0 && value.sensitivityFreq > 0)) throw new Error('StationXML: 採取率・感度が不正')
        channels.push({ start: from, end: to, value })
      }
      const boundaries = [...new Set(channels.flatMap(c => [c.start, c.end]))].sort((a, b) => a - b)
      for (let i = 0; i + 1 < boundaries.length; i++) {
        const from = boundaries[i], to = boundaries[i + 1]
        const values: PublicChannel[] = []
        for (const component of COMPONENTS) {
          const active = channels.filter(c => c.value.code === component && c.start <= from && from < c.end)
          if (active.length > 1) throw new Error('StationXML: 同じ成分の運用期間が重なる')
          if (active.length === 1) values.push(active[0].value)
        }
        // 3成分が揃わない更新は、既存の有効な表を消す材料にしない。
        if (values.length !== COMPONENTS.length) continue
        epochs.push({ code, nameJa, siteName, lat, lon, elevation, start: iso(from), end: to === Infinity ? null : iso(to), channels: values })
      }
    }
  }
  if (epochs.length === 0) throw new Error('StationXML: 3成分のある観測点がない')
  return epochs
}

/** 上流を優先して期間ごとに重ねる。応答に無い観測点・期間を削除とは解釈しない。 */
export function mergePublicStationEpochs(baseline: PublicStationsFile, remote: readonly PublicStationEpoch[]): PublicStationsFile {
  const merged: PublicStationEpoch[] = []
  const codes = [...new Set([...baseline.stations, ...remote].map(e => e.code))].sort()
  for (const code of codes) {
    const old = baseline.stations.filter(e => e.code === code)
    const fresh = remote.filter(e => e.code === code)
    const boundaries = [...new Set([...old, ...fresh].flatMap(e => [Date.parse(e.start), endMs(e)]))].sort((a, b) => a - b)
    for (let i = 0; i + 1 < boundaries.length; i++) {
      const from = boundaries[i], to = boundaries[i + 1]
      const active = fresh.filter(e => Date.parse(e.start) <= from && from < endMs(e))
      if (active.length > 1) throw new Error('StationXML: 観測点の運用期間が重なる')
      const prior = old.find(e => Date.parse(e.start) <= from && from < endMs(e))
      // 同じ旧期間に重なる更新が始まった後は、その終了・期間の穴も上流の明示として扱う。
      // 別の観測点や、応答に含まれない別期間を保つためのfallbackで旧い無期限の期間を復活させない。
      const superseded = prior !== undefined && fresh.some(e => Date.parse(e.start) <= from && Date.parse(e.start) < endMs(prior) && Date.parse(prior.start) < endMs(e))
      const chosen = active[0] ?? (superseded ? undefined : prior)
      if (!chosen) continue
      const last = merged[merged.length - 1]
      if (last?.code === code && last.end === iso(from) && properties(last) === properties(chosen)) last.end = to === Infinity ? null : iso(to)
      else merged.push({ ...chosen, start: iso(from), end: to === Infinity ? null : iso(to) })
    }
  }
  const signature = (rows: readonly PublicStationEpoch[]) => rows.map(e => JSON.stringify([e.start, e.end, properties(e)])).sort().join('|')
  return signature(merged) === signature(baseline.stations) ? baseline : { ...baseline, stations: merged }
}

export async function fetchPublicStationMetadata(baseline: PublicStationsFile): Promise<PublicStationsFile> {
  return fetchWithTimeout(PUBLIC_STATION_METADATA_URL, { timeoutMs: API_FETCH_TIMEOUT_MS, signal: null }, async response => {
    if (!response.ok) throw new Error(`StationXML: HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const declaration = new TextDecoder().decode(bytes.subarray(0, 150))
    const encoding = /encoding=["']([^"']+)/i.exec(declaration)?.[1] ?? 'utf-8'
    const xml = new TextDecoder(encoding).decode(bytes)
    return mergePublicStationEpochs(baseline, parsePublicStationXml(xml, baseline))
  })
}
