import type { AppEvent, JMAQuake, IssueType, CorrectType, DomesticTsunami, TelegramLogEntry } from '../types/earthquake'
import { serverNow, serverDate } from '../utils/clock'

const API_BASE = 'https://api.p2pquake.net/v2'
const WS_URL = 'wss://api.p2pquake.net/v2/ws'

// P2PQuake API はイベント種別を数値 code で返すため、内部の kind 識別子に変換する
type RawP2PEvent = { code: number; [key: string]: unknown }

function codeToLogKind(code: number): TelegramLogEntry['kind'] {
  if (code === 551) return 'quake'
  if (code === 552) return 'tsunami'
  if (code === 556) return 'eew'
  return undefined
}

const CORRECT_TYPE_MAP: Record<string, CorrectType> = {
  None: 'なし', Unknown: '訂正', ScaleOnly: '震度のみ訂正',
  DestinationOnly: '震源を訂正', ScaleAndDestination: '震度・震源を訂正',
}

const DOMESTIC_TSUNAMI_MAP: Record<string, DomesticTsunami> = {
  None: 'なし', Unknown: '不明', Checking: '調査中',
  SeaFloor: '海面変動の可能性', NonEffective: '若干の海面変動',
  Watch: '注意報', Warning: '警報等',
  // QUAKE-5: 大津波警報。欠落していると DOMESTIC_TSUNAMI_MAP[raw]=undefined → '不明' 灰色格下げに
  MajorWarning: '警報等',
}

const ISSUE_TYPE_MAP: Record<string, IssueType> = {
  ScalePrompt: '震度速報',
  Destination: '震源情報',
  ScaleAndDestination: '震源・震度情報',
  DetailScale: '各地の震度情報',
  DestinationAmended: '顕著な地震の震源要素更新のお知らせ',
  Foreign: '遠地地震',
  Other: 'その他',
}

export function convertEvent(raw: RawP2PEvent): AppEvent | null {
  const { code, ...rest } = raw
  let converted = rest
  // issue.type を日本語に変換
  if (converted.issue && typeof (converted.issue as Record<string, unknown>).type === 'string') {
    const mapped = ISSUE_TYPE_MAP[(converted.issue as Record<string, unknown>).type as string]
    if (mapped) {
      converted = { ...converted, issue: { ...(converted.issue as object), type: mapped } }
    }
  }
  // issue.correct を日本語に変換
  if (converted.issue && typeof (converted.issue as Record<string, unknown>).correct === 'string') {
    const rawCorrect = (converted.issue as Record<string, unknown>).correct as string
    const mappedCorrect = CORRECT_TYPE_MAP[rawCorrect] ?? 'なし'
    converted = { ...converted, issue: { ...(converted.issue as object), correct: mappedCorrect } }
  }
  // earthquake.domesticTsunami を日本語に変換
  if (converted.earthquake && typeof (converted.earthquake as Record<string, unknown>).domesticTsunami === 'string') {
    const rawDt = (converted.earthquake as Record<string, unknown>).domesticTsunami as string
    const mappedDt = DOMESTIC_TSUNAMI_MAP[rawDt] ?? '不明'
    converted = { ...converted, earthquake: { ...(converted.earthquake as object), domesticTsunami: mappedDt } }
  }
  if (code === 551) return { kind: 'quake', ...converted } as JMAQuake
  if (code === 552) return { kind: 'tsunami', ...converted } as AppEvent
  // P2PQuake API v2 の code=556 は気象庁 EEW 警報（VXSE43/45 相当）の二次配信のみで、
  // ペイロードに severity 相当フィールドが含まれない。JMA の仕様上ここで配信される
  // ものは全て警報級であり、Warning を明示付与しないと後段の computeSingleEEWLevel が
  // 常に Forecast 扱い（レベル0）に格下げして警報音・特別警報表示が発火しなくなる。
  // スプレッドの後に置くことで、将来 P2PQuake が severity フィールドを追加しても
  // 「常に Warning で確定させる」意図をコード順で保証する。
  if (code === 556) return { kind: 'eew', ...converted, severity: 'Warning' } as AppEvent
  return null
}

export async function fetchHistory(
  codes: number[] = [551, 552, 556],
  limit = 20,
  offset = 0,
): Promise<AppEvent[]> {
  const params = new URLSearchParams()
  codes.forEach(c => params.append('codes', String(c)))
  params.set('limit', String(limit))
  if (offset > 0) params.set('offset', String(offset))
  const res = await fetch(`${API_BASE}/history?${params.toString()}`)
  if (!res.ok) throw new Error(`P2PQuake API error: ${res.status}`)
  const raws = await res.json() as RawP2PEvent[]
  return raws.flatMap(r => { const e = convertEvent(r); return e ? [e] : [] })
}

// /v2/history より大幅に深い履歴（2015年〜）を持つ地震情報専用エンドポイント
export async function fetchJmaQuake(limit = 50, offset = 0): Promise<JMAQuake[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (offset > 0) params.set('offset', String(offset))
  const res = await fetch(`${API_BASE}/jma/quake?${params.toString()}`)
  if (!res.ok) throw new Error(`P2PQuake jma/quake error: ${res.status}`)
  const raws = await res.json() as RawP2PEvent[]
  return raws.flatMap(r => { const e = convertEvent(r); return e && e.kind === 'quake' ? [e as JMAQuake] : [] })
}

// jma/quake のレート制限は 10リクエスト/分（IPごと）。ヒートマップ用の遡り取得では
// リクエスト間隔を空けて上限に触れないようにする。
const JMA_QUAKE_HISTORY_REQUEST_INTERVAL_MS = 6500
const JMA_QUAKE_HISTORY_MAX_PAGES = 20

// ヒートマップ用: 直近 `days` 日分の地震履歴を offset ページングでまとめて取得する。
export async function fetchJmaQuakeHistory(days: number): Promise<JMAQuake[]> {
  const cutoffMs = serverNow() - days * 24 * 60 * 60 * 1000
  const collected: JMAQuake[] = []
  let offset = 0
  for (let page = 0; page < JMA_QUAKE_HISTORY_MAX_PAGES; page++) {
    const batch = await fetchJmaQuake(100, offset)
    if (batch.length === 0) break
    collected.push(...batch)
    const oldestTime = new Date(batch[batch.length - 1].earthquake.time).getTime()
    if (oldestTime < cutoffMs || batch.length < 100) break
    offset += batch.length
    await new Promise(resolve => setTimeout(resolve, JMA_QUAKE_HISTORY_REQUEST_INTERVAL_MS))
  }
  // 同一地震でも「震度速報→震源情報→震源・震度情報→各地の震度情報」と複数の issue が
  // 別レコードとして history に載るため、useEarthquakes.ts の sortQuakes と同じく
  // earthquake.time で重複排除する（id は issue ごとに異なり重複排除のキーにならない）。
  const seenTimes = new Set<string>()
  const deduped = collected.filter(q => {
    if (seenTimes.has(q.earthquake.time)) return false
    seenTimes.add(q.earthquake.time)
    return true
  })
  return deduped.filter(q => new Date(q.earthquake.time).getTime() >= cutoffMs)
}

export class P2PQuakeWebSocket {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 3000
  private shouldReconnect = false

  onEvent: ((event: AppEvent) => void) | null = null
  onStatusChange: ((status: 'connecting' | 'connected' | 'disconnected') => void) | null = null
  onRawMessage: ((entry: TelegramLogEntry) => void) | null = null

  connect() {
    this.shouldReconnect = true
    this.createConnection()
  }

  private createConnection() {
    this.onStatusChange?.('connecting')
    this.ws = new WebSocket(WS_URL)

    this.ws.onopen = () => {
      this.reconnectDelay = 3000
      this.onStatusChange?.('connected')
    }

    this.ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data as string) as RawP2PEvent
        const appEvent = convertEvent(raw)
        this.onRawMessage?.({
          id: `${Date.now()}-${Math.random()}`,
          receivedAt: serverDate(),
          source: 'p2pquake',
          headType: String(raw.code),
          isTest: false,
          status: appEvent ? 'parsed' : 'filtered',
          kind: codeToLogKind(raw.code),
          rawBody: raw,
        })
        if (appEvent) this.onEvent?.(appEvent)
      } catch {
        // ignore malformed messages
      }
    }

    this.ws.onclose = () => {
      this.onStatusChange?.('disconnected')
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000)
          this.createConnection()
        }, this.reconnectDelay)
      }
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  disconnect() {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }
}
