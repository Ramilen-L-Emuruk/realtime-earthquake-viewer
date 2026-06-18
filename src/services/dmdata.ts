// DMDATA.JP WebSocket クライアント。
// POST /v2/socket → チケット取得 → WebSocket(dmdata.v2) 接続 → Ping/Pong → データ受信。
// 切断時は指数バックオフで再接続する（チケット再取得から）。

import type { JMAQuake, JMATsunami, JMALpgm, EEWAlert, ConnectionStatus } from '../types/earthquake'
import { parseEEW, parseEarthquake, parseTsunami, parseLpgm, parseEarthquakeFromXml, parseTsunamiFromXml, parseLpgmFromXml } from './dmdataParser'

const API_BASE = 'https://api.dmdata.jp/v2'
// フル購読クラスで接続を試みる。スコープ不足の 403 の場合は段階的にフォールバックする。
const CLASSIFICATIONS_FULL    = ['eew.forecast', 'eew.warning', 'telegram.earthquake', 'telegram.tsunami']
const CLASSIFICATIONS_NO_TSUN = ['eew.forecast', 'eew.warning', 'telegram.earthquake']
const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 30000
const RECONNECT_FACTOR = 1.5

function authHeader(apiKey: string): string {
  return 'Basic ' + btoa(apiKey + ':')
}

async function tryFetchTicket(apiKey: string, classifications: string[]): Promise<{ url: string; status: number; body: unknown }> {
  const res = await fetch(`${API_BASE}/socket`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      classifications,
      formatMode: 'json',
      appName: 'quake-viewer-dmdss',
    }),
  })
  const body = await res.json() as Record<string, unknown>
  return { url: (body as { websocket?: { url: string } }).websocket?.url ?? '', status: res.status, body }
}

async function fetchTicketUrl(apiKey: string): Promise<string> {
  // まずフル（EEW + 地震 + 津波）で試みる
  const full = await tryFetchTicket(apiKey, CLASSIFICATIONS_FULL)
  if (full.status === 200) return full.url
  if (full.status === 401) throw new Error('auth')

  // スコープ不足で津波が含まれる場合は、津波なしで再試行
  if (full.status === 403) {
    const errMsg = ((full.body as { error?: { message?: string } }).error?.message ?? '').toLowerCase()
    if (errMsg.includes('tsunami') || errMsg.includes('scope')) {
      const noTsun = await tryFetchTicket(apiKey, CLASSIFICATIONS_NO_TSUN)
      if (noTsun.status === 200) return noTsun.url
      if (noTsun.status === 401 || noTsun.status === 403) throw new Error('auth')
      throw new Error(`ticket: ${noTsun.status}`)
    }
    throw new Error('auth')
  }

  throw new Error(`ticket: ${full.status}`)
}

export type DmdataEvent =
  | { kind: 'eew'; data: EEWAlert }
  | { kind: 'quake'; data: JMAQuake }
  | { kind: 'tsunami'; data: JMATsunami }
  | { kind: 'lpgm'; data: JMALpgm }

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

    if (headType === 'VXSE45' || headType === 'VXSE43') {
      const eew = parseEEW(headType, data)
      if (eew) this.onEvent?.({ kind: 'eew', data: eew })
    } else if (headType === 'VXSE51' || headType === 'VXSE52' || headType === 'VXSE53') {
      const quake = parseEarthquake(headType, data)
      if (quake) this.onEvent?.({ kind: 'quake', data: quake })
    } else if (headType === 'VTSE41' || headType === 'VTSE51' || headType === 'VTSE52') {
      const tsunami = parseTsunami(headType, data)
      if (tsunami) this.onEvent?.({ kind: 'tsunami', data: tsunami })
    } else if (headType === 'VXSE62') {
      const lpgm = parseLpgm(data)
      if (lpgm) this.onEvent?.({ kind: 'lpgm', data: lpgm })
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

// REST API で電文1件を取得し、地震情報・津波情報・長周期地震動観測情報のいずれかにパースして返す。
// url は一覧レスポンスの item.url（data.api.dmdata.jp/v1/{id}）を使う。
// /v2/telegram/{id} は CORS でブロックされるため使わない。
async function fetchOneTelegram(
  apiKey: string,
  url: string,
  headType: string,
): Promise<JMAQuake | JMATsunami | JMALpgm | null> {
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
  if (headType === 'VXSE62') {
    return parseLpgmFromXml(xml)
  }
  return null
}

// DMDATA REST API で地震履歴（VXSE53: 震源＋各地震度）を取得する。
// cursorToken を指定するとカーソル位置以降の古い電文を取得する（「もっと見る」用）。
export async function fetchDmdataEarthquakes(
  apiKey: string,
  limit: number,
  cursorToken?: string,
): Promise<{ quakes: JMAQuake[]; nextToken?: string }> {
  const qs = cursorToken ? `&cursorToken=${cursorToken}` : ''
  const res = await fetch(`${API_BASE}/telegram?type=VXSE53&limit=${limit}${qs}`, {
    headers: { Authorization: authHeader(apiKey) },
  })
  if (!res.ok) throw new Error(`earthquake history: ${res.status}`)
  const json = await res.json() as {
    items?: Array<{ id: string; url: string; head: { type: string } }>
    nextToken?: string
  }
  const items = json.items ?? []
  const results = await Promise.allSettled(
    items.map(it => fetchOneTelegram(apiKey, it.url, it.head.type)),
  )
  const quakes = results
    .filter((r): r is PromiseFulfilledResult<JMAQuake | JMATsunami | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((v): v is JMAQuake => v !== null && v.code === 551)
  return { quakes, nextToken: json.nextToken }
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
    .filter((r): r is PromiseFulfilledResult<JMAQuake | JMATsunami | JMALpgm | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((v): v is JMATsunami => v !== null && 'code' in (v as object) && (v as JMATsunami).code === 552)
}

// DMDATA REST API で長周期地震動観測情報（VXSE62）を取得する。
// oldestOriginTime より古い電文が見つかった時点でページネーションを停止する。
// 取得失敗時は空配列を返す（補助情報なのでアプリを壊さない）。
export async function fetchDmdataLpgms(
  apiKey: string,
  oldestOriginTime: string,
): Promise<JMALpgm[]> {
  const headers  = { Authorization: authHeader(apiKey) }
  const collected: JMALpgm[] = []
  let nextToken: string | undefined
  const cutoffMs = new Date(oldestOriginTime).getTime()

  for (;;) {
    const qs  = nextToken ? `&cursorToken=${nextToken}` : ''
    let res: Response
    try {
      res = await fetch(`${API_BASE}/telegram?type=VXSE62&limit=20${qs}`, { headers })
    } catch { break }
    if (!res.ok) break

    const json = await res.json() as {
      items?: Array<{ id: string; url: string; head: { type: string; time?: string } }>
      nextToken?: string
    }

    const items = json.items ?? []
    if (items.length === 0) break

    // ページ内で cutoff より古い発報時刻が見つかればそこで停止
    let reachedCutoff = false
    const targets: typeof items = []
    for (const item of items) {
      const t = item.head.time ? new Date(item.head.time).getTime() : Infinity
      if (t < cutoffMs) { reachedCutoff = true; break }
      targets.push(item)
    }

    const pageResults = await Promise.allSettled(
      targets.map(it => fetchOneTelegram(apiKey, it.url, it.head.type)),
    )
    for (const r of pageResults) {
      if (r.status === 'fulfilled' && r.value !== null && 'maxClass' in (r.value as object)) {
        collected.push(r.value as JMALpgm)
      }
    }

    if (reachedCutoff || !json.nextToken) break
    nextToken = json.nextToken
  }

  return collected
}
