import { parseEEW, parseEarthquake, parseTsunami, parseLpgm, parseVyse5xFromXml, parseVyse60FromXml } from './dmdataParser'
import { parseTar } from '../utils/tarParser'
import type { P2PQuakeEvent, JMALpgm, JMANankai, JMAKohatsu } from '../types/earthquake'

const QUAKE_TYPES = new Set(['VXSE51', 'VXSE52', 'VXSE53', 'VXSE61'])
const TSUNAMI_TYPES = new Set(['VTSE41', 'VTSE51', 'VTSE52'])
const EEW_TYPES = new Set(['VXSE43', 'VXSE45'])
const LPGM_TYPES = new Set(['VXSE62'])
const NANKAI_TYPES = new Set(['VYSE50', 'VYSE51'])
const KOHATSU_TYPES = new Set(['VYSE60'])

function authHeader(apiKey: string): string {
  return 'Basic ' + btoa(apiKey + ':')
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  const reader = ds.readable.getReader()
  writer.write(bytes as unknown as ArrayBuffer)
  writer.close()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

interface ArchiveItem {
  classification: string
  date: string
  url: string
}

interface ManifestEntry {
  id: string
  originalId?: string
  classification: string
  head: { type: string; time: string; test: boolean }
}

// 日次アーカイブのキャッシュ（URL → ファイル名マップ）
const archiveCache = new Map<string, Promise<Map<string, Uint8Array>>>()

async function downloadArchive(url: string, apiKey: string): Promise<Map<string, Uint8Array>> {
  const cached = archiveCache.get(url)
  if (cached) return cached
  const promise = (async () => {
    const res = await fetch(url, { headers: { Authorization: authHeader(apiKey) } })
    if (!res.ok) throw new Error(`Archive fetch failed: ${res.status}`)
    const gz = new Uint8Array(await res.arrayBuffer())
    const tar = await gunzipBytes(gz)
    const files = new Map<string, Uint8Array>()
    for (const entry of parseTar(tar)) {
      files.set(entry.name, entry.content)
    }
    return files
  })()
  archiveCache.set(url, promise)
  return promise
}

export function clearReplayCache(): void {
  archiveCache.clear()
}

export type ReplayPayload =
  | { kind: 'p2p'; event: P2PQuakeEvent }
  | { kind: 'lpgm'; data: JMALpgm }
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'kohatsu'; data: JMAKohatsu }

export interface ReplayEntry {
  payload: ReplayPayload
  replayTime: Date
}

export async function fetchDmdataReplayEvents(
  apiKey: string,
  fromTime: Date,
  toTime: Date,
): Promise<ReplayEntry[]> {
  // アーカイブは JST 日付で索引されているため、UTC 日付との差を吸収するため
  // 開始日を -1 日、終了日を +1 日して確実に対象アーカイブを含める
  const startDateObj = new Date(fromTime)
  startDateObj.setDate(startDateObj.getDate() - 1)
  const startDate = toDateStr(startDateObj)
  const endDateObj = new Date(toTime)
  endDateObj.setDate(endDateObj.getDate() + 1)
  const endDate = toDateStr(endDateObj)

  const listRes = await fetch(
    `https://api.dmdata.jp/v2/archive?datetime=${startDate}~${endDate}&classification=telegram.earthquake,eew.forecast,eew.warning`,
    { headers: { Authorization: authHeader(apiKey) } },
  )
  if (!listRes.ok) throw new Error(`Archive list failed: ${listRes.status}`)
  const listJson = (await listRes.json()) as { status: string; items: ArchiveItem[] }
  if (listJson.status !== 'ok') throw new Error('Archive list error')

  const dec = new TextDecoder()
  const entries: ReplayEntry[] = []

  await Promise.all(
    listJson.items.map(async (item) => {
      const files = await downloadArchive(item.url, apiKey)

      const manifestBytes = files.get('telegrams.json')
      if (!manifestBytes) return
      const manifest: ManifestEntry[] = JSON.parse(dec.decode(manifestBytes))

      for (const entry of manifest) {
        if (entry.head.test) continue
        const entryTime = new Date(entry.head.time)
        if (entryTime < fromTime || entryTime >= toTime) continue

        const headType = entry.head.type
        const idPrefix = entry.id.slice(0, 7)

        if (NANKAI_TYPES.has(headType) || KOHATSU_TYPES.has(headType)) {
          // XML 形式電文（VYSE50/51/60）: originalId を持たない場合があるため別処理
          const xmlFileName = [...files.keys()].find(
            (n) => n.endsWith('.xml') && n.includes(idPrefix),
          )
          if (!xmlFileName) continue
          const bodyBytes = files.get(xmlFileName)
          if (!bodyBytes) continue
          const xmlText = dec.decode(bodyBytes)

          let payload: ReplayPayload | null = null
          if (NANKAI_TYPES.has(headType)) {
            const nankai = parseVyse5xFromXml(xmlText)
            if (nankai) payload = { kind: 'nankai', data: nankai }
          } else {
            const kohatsu = parseVyse60FromXml(xmlText)
            if (kohatsu) payload = { kind: 'kohatsu', data: kohatsu }
          }
          if (payload) entries.push({ payload, replayTime: entryTime })
          continue
        }

        // JSON 形式電文（地震・津波・EEW・VXSE62）
        if (!entry.originalId) continue
        const jsonFileName = [...files.keys()].find(
          (n) => n.endsWith('.json') && n !== 'telegrams.json' && n.includes(idPrefix),
        )
        if (!jsonFileName) continue

        const bodyBytes = files.get(jsonFileName)
        if (!bodyBytes) continue
        const data = JSON.parse(dec.decode(bodyBytes)) as Record<string, unknown>

        let payload: ReplayPayload | null = null
        if (EEW_TYPES.has(headType)) {
          const event = parseEEW(headType, data)
          if (event) payload = { kind: 'p2p', event }
        } else if (QUAKE_TYPES.has(headType)) {
          const event = parseEarthquake(headType, data)
          if (event) payload = { kind: 'p2p', event }
        } else if (TSUNAMI_TYPES.has(headType)) {
          const event = parseTsunami(headType, data)
          if (event) payload = { kind: 'p2p', event }
        } else if (LPGM_TYPES.has(headType)) {
          const lpgm = parseLpgm(data)
          if (lpgm) payload = { kind: 'lpgm', data: lpgm }
        }

        if (payload) {
          // pressDateTime（実際の発表時刻）をキュー時刻に使うことで、同一 reportDateTime を持つ
          // 複数電文（例: VXSE51 の重複送信）がライブ受信時と同じ時系列で再生されるようにする
          const pressDateTime = (data.pressDateTime as string | undefined) ?? entryTime.toISOString()
          entries.push({ payload, replayTime: new Date(pressDateTime) })
        }
      }
    }),
  )

  entries.sort((a, b) => a.replayTime.getTime() - b.replayTime.getTime())

  return entries
}
