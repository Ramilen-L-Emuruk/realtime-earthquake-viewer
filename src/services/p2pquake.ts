import type { AppEvent, JMAQuake, TelegramLogEntry } from '../types/earthquake'

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

function convertEvent(raw: RawP2PEvent): AppEvent | null {
  const { code, ...rest } = raw
  if (code === 551) return { kind: 'quake', ...rest } as JMAQuake
  if (code === 552) return { kind: 'tsunami', ...rest } as AppEvent
  if (code === 556) return { kind: 'eew', ...rest } as AppEvent
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
