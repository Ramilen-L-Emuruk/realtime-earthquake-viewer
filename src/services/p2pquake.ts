import type { AppEvent, JMAQuake, IssueType, CorrectType, DomesticTsunami, TelegramLogEntry } from '../types/earthquake'

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

function convertEvent(raw: RawP2PEvent): AppEvent | null {
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
  if (code === 556) return { kind: 'eew', ...converted } as AppEvent
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
          receivedAt: new Date(),
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
