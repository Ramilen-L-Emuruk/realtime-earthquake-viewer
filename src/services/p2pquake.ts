import type { P2PQuakeEvent } from '../types/earthquake'

const API_BASE = 'https://api.p2pquake.net/v2'
const WS_URL = 'wss://api.p2pquake.net/v2/ws'

export async function fetchHistory(
  codes: number[] = [551, 552, 556],
  limit = 20,
): Promise<P2PQuakeEvent[]> {
  const codesParam = codes.join(',')
  const res = await fetch(`${API_BASE}/history?codes=${codesParam}&limit=${limit}`)
  if (!res.ok) throw new Error(`P2PQuake API error: ${res.status}`)
  return res.json() as Promise<P2PQuakeEvent[]>
}

export class P2PQuakeWebSocket {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 3000
  private shouldReconnect = false

  onEvent: ((event: P2PQuakeEvent) => void) | null = null
  onStatusChange: ((status: 'connecting' | 'connected' | 'disconnected') => void) | null = null

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
        const data = JSON.parse(event.data as string) as P2PQuakeEvent
        this.onEvent?.(data)
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
