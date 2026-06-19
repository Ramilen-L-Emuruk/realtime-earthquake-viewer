// DMDATA.JP WebSocket クライアント。
// POST /v2/socket → チケット取得 → WebSocket(dmdata.v2) 接続 → Ping/Pong → データ受信。
// 切断時は指数バックオフで再接続する（チケット再取得から）。
//
// 重要: data メッセージの body は formatMode:"json" でも base64 + gzip のまま届く
// （仕様: data.encoding="base64" / data.compression="gzip"）。
// クライアント側で「base64 デコード → gunzip → JSON.parse」を行う必要がある。

import type { JMAQuake, JMATsunami, JMALpgm, EEWAlert, ConnectionStatus } from '../types/earthquake'
import { parseEEW, parseEarthquake, parseTsunami, parseLpgm, parseEarthquakeFromXml, parseTsunamiFromXml, parseLpgmFromXml } from './dmdataParser'

const API_BASE = 'https://api.dmdata.jp/v2'
// DMDATA WebSocket 購読分類。telegram.earthquake は地震・津波両方の電文を配信する。
// telegram.tsunami という分類は存在しないため含めない。
const CLASSIFICATIONS = ['eew.forecast', 'eew.warning', 'telegram.earthquake']
// EEW 電文種別: VXSE43=警報, VXSE44=予報(廃止予定), VXSE45=地震動予報。
// VXSE42（配信テスト）は震源データを持たず EEW として表示できないため別途処理する。
const EEW_TYPES = new Set(['VXSE43', 'VXSE44', 'VXSE45'])
const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 30000
const RECONNECT_FACTOR = 1.5

function authHeader(apiKey: string): string {
  return 'Basic ' + btoa(apiKey + ':')
}

// 検証用デバッグログ。includeTest（試験報受信）が有効、または localStorage['dmdss-debug']='1'
// のときに有効化する。APIキー等の機密値は出力しない。
function isDebugEnabled(includeTest: boolean): boolean {
  try {
    if (localStorage.getItem('dmdss-debug') === '1') return true
  } catch { /* localStorage 利用不可環境は無視 */ }
  return includeTest
}

function dlog(...args: unknown[]): void {
  console.info('[DMDSS]', ...args)
}

// base64 文字列をバイト列にデコードする。
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// gzip バイト列をブラウザネイティブの DecompressionStream で展開する。
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

// data メッセージの body を encoding/compression/format に従って復号し、JSON オブジェクトを返す。
// format が json 以外（xml 等）や復号失敗時は null。
async function decodeTelegramBody(msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const raw = msg.body
  // 既に object（将来仕様変更時の保険）
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw !== 'string') return null

  const encoding = typeof msg.encoding === 'string' ? msg.encoding : 'utf-8'
  const compression = typeof msg.compression === 'string' ? msg.compression : null
  const format = typeof msg.format === 'string' ? msg.format : 'json'

  let text: string
  try {
    if (encoding === 'base64') {
      const bytes = base64ToBytes(raw)
      if (compression === 'gzip') {
        text = new TextDecoder().decode(await gunzip(bytes))
      } else if (compression === null) {
        text = new TextDecoder().decode(bytes)
      } else {
        // zip 等は DecompressionStream 非対応のため未サポート
        return null
      }
    } else {
      // encoding="utf-8" 等は生テキスト
      text = raw
    }
  } catch {
    return null
  }

  if (format !== 'json') return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

async function tryFetchTicket(
  apiKey: string,
  classifications: string[],
  includeTest: boolean,
  debug: boolean,
): Promise<{ url: string; status: number; body: unknown }> {
  const testParam = includeTest ? 'including' : 'no'
  if (debug) dlog('socket チケット要求', { classifications, test: testParam })
  const res = await fetch(`${API_BASE}/socket`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      classifications,
      // 試験報・訓練報（EEW 配信テスト VXSE42 等）は including 指定時のみ配信される。
      test: testParam,
      formatMode: 'json',
      appName: 'quake-viewer-dmdss',
    }),
  })
  const body = await res.json() as Record<string, unknown>
  if (debug) {
    if (res.status === 200) {
      dlog('socket チケット取得 OK', { status: res.status })
    } else {
      // 403/401/409 等の理由（契約スコープ不足・同時接続数上限など）を可視化する。
      const e = (body as { error?: { message?: string; code?: number } }).error
      dlog('socket チケット取得 失敗', { status: res.status, errorCode: e?.code, errorMessage: e?.message })
    }
  }
  return { url: (body as { websocket?: { url: string } }).websocket?.url ?? '', status: res.status, body }
}

async function fetchTicketUrl(apiKey: string, includeTest: boolean, debug: boolean): Promise<string> {
  const result = await tryFetchTicket(apiKey, CLASSIFICATIONS, includeTest, debug)
  if (result.status === 200) return result.url
  if (result.status === 401 || result.status === 403) throw new Error('auth')
  throw new Error(`ticket: ${result.status}`)
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

  private readonly debug: boolean

  // includeTest: 試験報・訓練報（EEW 配信テスト VXSE42 等）も受信する（検証用）。
  constructor(private apiKey: string, private includeTest = false) {
    this.debug = isDebugEnabled(includeTest)
  }

  connect() {
    this.stopped = false
    this.authError = false
    if (this.debug) dlog('connect()', { includeTest: this.includeTest })
    this.tryConnect()
  }

  private async tryConnect() {
    this.onStatusChange?.('connecting')
    try {
      const url = await fetchTicketUrl(this.apiKey, this.includeTest, this.debug)
      if (this.stopped) return
      this.openWs(url)
    } catch (err) {
      if (this.stopped) return
      const reason = err instanceof Error ? err.message : String(err)
      // 認証エラーは再試行しない
      if (err instanceof Error && err.message === 'auth') {
        if (this.debug) dlog('認証エラーのため再接続しない（APIキーの契約スコープ・WebSocket権限を確認）', { reason })
        this.authError = true
        this.onStatusChange?.('disconnected')
        return
      }
      if (this.debug) dlog('接続失敗 → 再接続をスケジュール', { reason })
      this.scheduleReconnect()
    }
  }

  private openWs(url: string) {
    const ws = new WebSocket(url, 'dmdata.v2')
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempt = 0
      if (this.debug) dlog('WebSocket open')
    }

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(ev.data as string) as Record<string, unknown>
      } catch { return /* メッセージエンベロープのパース失敗は無視 */ }
      // body の復号は非同期（gunzip）。発火後は待たない。
      void this.handleMessage(msg)
    }

    ws.onclose = (ev) => {
      if (this.debug) dlog('WebSocket close', { code: ev.code, reason: ev.reason })
      if (!this.stopped && !this.authError) {
        this.onStatusChange?.('disconnected')
        this.scheduleReconnect()
      }
    }

    ws.onerror = () => {
      if (this.debug) dlog('WebSocket error')
    }
  }

  private async handleMessage(msg: Record<string, unknown>) {
    if (msg.type === 'start') {
      if (this.debug) dlog('start（購読開始）', { classifications: (msg as { classifications?: unknown }).classifications })
      this.onStatusChange?.('connected')
      return
    }
    if (msg.type === 'ping') {
      this.ws?.send(JSON.stringify({ type: 'pong', pingId: msg.pingId }))
      if (this.debug) dlog('ping → pong')
      return
    }
    if (msg.type === 'error') {
      if (this.debug) dlog('error メッセージ受信', { error: (msg as { error?: unknown }).error, code: (msg as { code?: unknown }).code })
      return
    }
    if (msg.type !== 'data') {
      if (this.debug) dlog('未処理メッセージ', { type: msg.type })
      return
    }

    const head = msg.head as Record<string, unknown> | undefined
    const isTest = head?.test === true
    const headType = head?.type as string | undefined
    if (this.debug) {
      dlog('data 受信', {
        headType,
        test: isTest,
        classification: (msg as { classification?: unknown }).classification,
        format: msg.format,
        compression: msg.compression,
        encoding: msg.encoding,
      })
    }
    // 試験報・訓練報は includeTest 有効時のみ通す（既定は無効＝従来どおり破棄）。
    if (isTest && !this.includeTest) {
      if (this.debug) dlog('試験報を破棄（includeTest 無効）', { headType })
      return
    }
    if (!headType) return

    // body は base64 + gzip。復号して JSON 化する（仕様準拠）。
    const data = await decodeTelegramBody(msg)
    if (!data) {
      if (this.debug) dlog('body 復号失敗', { headType, format: msg.format, compression: msg.compression, encoding: msg.encoding })
      return
    }

    // VXSE42（配信テスト）: 震源データなし。配信経路の疎通確認のみ。
    if (headType === 'VXSE42') {
      if (this.debug) dlog('VXSE42 配信テスト受信（EEWデータなし・配信経路正常）')
      return
    }

    if (EEW_TYPES.has(headType)) {
      const eew = parseEEW(headType, data)
      if (!eew) {
        if (this.debug) dlog('EEW パース結果が null', { headType })
        return
      }
      if (this.debug) dlog('EEW 受信 → 通知', { headType, test: isTest, eventId: eew.issue?.eventId, severity: eew.severity, forecastMaxScale: eew.forecastMaxScale })
      // 検証用に受信した試験報 EEW はカード・音・地図へ流すため test:false で通知する。
      this.onEvent?.({ kind: 'eew', data: isTest ? { ...eew, test: false } : eew })
    } else if (headType === 'VXSE51' || headType === 'VXSE52' || headType === 'VXSE53') {
      const quake = parseEarthquake(headType, data)
      if (this.debug) dlog('地震情報', { headType, parsed: !!quake })
      if (quake) this.onEvent?.({ kind: 'quake', data: quake })
    } else if (headType === 'VTSE41' || headType === 'VTSE51' || headType === 'VTSE52') {
      const tsunami = parseTsunami(headType, data)
      if (this.debug) dlog('津波情報', { headType, parsed: !!tsunami })
      if (tsunami) this.onEvent?.({ kind: 'tsunami', data: tsunami })
    } else if (headType === 'VXSE62') {
      const lpgm = parseLpgm(data)
      if (lpgm) this.onEvent?.({ kind: 'lpgm', data: lpgm })
    } else if (this.debug) {
      dlog('対象外の電文種別', { headType })
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
