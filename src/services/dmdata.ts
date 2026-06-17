// DMDATA.JP WebSocket クライアント。
// POST /v2/socket → チケット取得 → WebSocket(dmdata.v2) 接続 → Ping/Pong → データ受信。
// 切断時は指数バックオフで再接続する（チケット再取得から）。

import type { JMAQuake, JMATsunami, EEWAlert, ConnectionStatus } from '../types/earthquake'
import { parseEEW, parseEarthquake, parseTsunami, parseEarthquakeFromXml, parseTsunamiFromXml } from './dmdataParser'

const API_BASE = 'https://api.dmdata.jp/v2'
const CLASSIFICATIONS = ['eew.forecast', 'eew.warning', 'telegram.earthquake']
const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 30000
const RECONNECT_FACTOR = 1.5

function authHeader(apiKey: string): string {
  return 'Basic ' + btoa(apiKey + ':')
}

async function fetchTicketUrl(apiKey: string): Promise<string> {
  const res = await fetch(`${API_BASE}/socket`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      classifications: CLASSIFICATIONS,
      formatMode: 'json',
      appName: 'quake-viewer-dmdss',
    }),
  })
  if (res.status === 401 || res.status === 403) throw new Error('auth')
  if (!res.ok) throw new Error(`ticket: ${res.status}`)
  const json = await res.json() as { websocket: { url: string } }
  return json.websocket.url
}

export type DmdataEvent =
  | { kind: 'eew'; data: EEWAlert }
  | { kind: 'quake'; data: JMAQuake }
  | { kind: 'tsunami'; data: JMATsunami }

export class DmdataWebSocket {
  private ws: WebSocket | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private authError = false

  onEvent: ((ev: DmdataEvent) => void) | null = null
  onStatusChange: ((s: ConnectionStatus) => void) | null = null

  constructor(private apiKey: string) {}

  connect() {
    this.stopped = false
    this.authError = false
    this.tryConnect()
  }

  private async tryConnect() {
    this.onStatusChange?.('connecting')
    try {
      const url = await fetchTicketUrl(this.apiKey)
      if (this.stopped) return
      this.openWs(url)
    } catch (err) {
      if (this.stopped) return
      // 認証エラーは再試行しない
      if (err instanceof Error && err.message === 'auth') {
        this.authError = true
        this.onStatusChange?.('disconnected')
        return
      }
      this.scheduleReconnect()
    }
  }

  private openWs(url: string) {
    const ws = new WebSocket(url, 'dmdata.v2')
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempt = 0
    }

    ws.onmessage = (ev) => {
      try {
        this.handleMessage(JSON.parse(ev.data as string) as Record<string, unknown>)
      } catch { /* ignore parse errors */ }
    }

    ws.onclose = () => {
      if (!this.stopped && !this.authError) {
        this.onStatusChange?.('disconnected')
        this.scheduleReconnect()
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>) {
    if (msg.type === 'start') {
      this.onStatusChange?.('connected')
      return
    }
    if (msg.type === 'ping') {
      this.ws?.send(JSON.stringify({ type: 'pong', pingId: msg.pingId }))
      return
    }
    if (msg.type !== 'data') return

    const head = msg.head as Record<string, unknown> | undefined
    // 訓練電文はスキップ
    if (head?.test === true) return
    const headType = head?.type as string | undefined
    if (!headType) return

    // formatMode:"json" 時は文字列、既に object の場合も許容する
    const rawBody = msg.body
    let data: Record<string, unknown>
    try {
      data = typeof rawBody === 'string'
        ? JSON.parse(rawBody) as Record<string, unknown>
        : rawBody as Record<string, unknown>
    } catch { return }

    if (headType === 'VXSE45' || headType === 'VXSE47') {
      const eew = parseEEW(headType, data)
      if (eew) this.onEvent?.({ kind: 'eew', data: eew })
    } else if (headType === 'VXSE51' || headType === 'VXSE52' || headType === 'VXSE53') {
      const quake = parseEarthquake(headType, data)
      if (quake) this.onEvent?.({ kind: 'quake', data: quake })
    } else if (headType === 'VTSE41' || headType === 'VTSE51' || headType === 'VTSE52') {
      const tsunami = parseTsunami(headType, data)
      if (tsunami) this.onEvent?.({ kind: 'tsunami', data: tsunami })
    }
  }

  private scheduleReconnect() {
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(RECONNECT_FACTOR, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped && !this.authError) this.tryConnect()
    }, delay)
  }

  disconnect() {
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }
}

// REST API で電文1件を取得し、地震情報または津波情報にパースして返す。
// url は一覧レスポンスの item.url（data.api.dmdata.jp/v1/{id}）を使う。
// /v2/telegram/{id} は CORS でブロックされるため使わない。
async function fetchOneTelegram(
  apiKey: string,
  url: string,
  headType: string,
): Promise<JMAQuake | JMATsunami | null> {
  const res = await fetch(url, {
    headers: { Authorization: authHeader(apiKey) },
  })
  if (!res.ok) return null
  const xml = await res.text()
  if (headType === 'VXSE51' || headType === 'VXSE52' || headType === 'VXSE53') {
    return parseEarthquakeFromXml(headType, xml)
  }
  if (headType === 'VTSE41' || headType === 'VTSE51' || headType === 'VTSE52') {
    return parseTsunamiFromXml(xml)
  }
  return null
}

// DMDATA REST API で地震履歴（VXSE53: 震源＋各地震度）を取得する
export async function fetchDmdataEarthquakes(
  apiKey: string,
  limit: number,
): Promise<JMAQuake[]> {
  const res = await fetch(`${API_BASE}/telegram?type=VXSE53&limit=${limit}`, {
    headers: { Authorization: authHeader(apiKey) },
  })
  if (!res.ok) throw new Error(`earthquake history: ${res.status}`)
  const json = await res.json() as {
    items?: Array<{ id: string; url: string; head: { type: string } }>
  }
  const items = json.items ?? []
  const results = await Promise.allSettled(
    items.map(it => fetchOneTelegram(apiKey, it.url, it.head.type)),
  )
  return results
    .filter((r): r is PromiseFulfilledResult<JMAQuake | JMATsunami | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((v): v is JMAQuake => v !== null && v.code === 551)
}

// DMDATA REST API で津波履歴（VTSE41: 大津波警報特別、VTSE51: 警報・注意報・解除、VTSE52: 沖合観測）を取得する。
export async function fetchDmdataTsunamis(
  apiKey: string,
  limit: number,
): Promise<JMATsunami[]> {
  const headers = { Authorization: authHeader(apiKey) }

  const [r41, r51, r52] = await Promise.allSettled([
    fetch(`${API_BASE}/telegram?type=VTSE41&limit=${limit}`, { headers }),
    fetch(`${API_BASE}/telegram?type=VTSE51&limit=${limit}`, { headers }),
    fetch(`${API_BASE}/telegram?type=VTSE52&limit=${limit}`, { headers }),
  ])

  if (r51.status === 'rejected' || !r51.value.ok) {
    const status = r51.status === 'rejected' ? 'network error' : r51.value.status
    throw new Error(`tsunami history: ${status}`)
  }
  const json51 = await r51.value.json() as {
    items?: Array<{ id: string; url: string; head: { type: string } }>
  }
  const items: Array<{ id: string; url: string; head: { type: string } }> = [...(json51.items ?? [])]

  if (r41.status === 'fulfilled' && r41.value.ok) {
    const json41 = await r41.value.json() as {
      items?: Array<{ id: string; url: string; head: { type: string } }>
    }
    items.push(...(json41.items ?? []))
  }

  if (r52.status === 'fulfilled' && r52.value.ok) {
    const json52 = await r52.value.json() as {
      items?: Array<{ id: string; url: string; head: { type: string } }>
    }
    items.push(...(json52.items ?? []))
  }

  const results = await Promise.allSettled(
    items.map(it => fetchOneTelegram(apiKey, it.url, it.head.type)),
  )
  return results
    .filter((r): r is PromiseFulfilledResult<JMAQuake | JMATsunami | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((v): v is JMATsunami => v !== null && v.code === 552)
}
