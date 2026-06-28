// DMDATA.JP WebSocket クライアント。
// POST /v2/socket → チケット取得 → WebSocket(dmdata.v2) 接続 → Ping/Pong → データ受信。
// 切断時は指数バックオフで再接続する（チケット再取得から）。
//
// 重要: data メッセージの body は formatMode:"json" でも base64 + gzip のまま届く
// （仕様: data.encoding="base64" / data.compression="gzip"）。
// クライアント側で「base64 デコード → gunzip → JSON.parse」を行う必要がある。

import type { JMAQuake, JMATsunami, JMALpgm, JMANankai, JMAKohatsu, EEWAlert, ConnectionStatus, TelegramLogEntry } from '../types/earthquake'
import { parseEEW, parseEarthquake, parseTsunami, parseLpgm, parseEarthquakeFromXml, parseTsunamiFromXml, parseLpgmFromXml, parseVyse5xFromXml, parseVyse60FromXml } from './dmdataParser'

const API_BASE = 'https://api.dmdata.jp/v2'
// DMDATA WebSocket 購読分類。telegram.earthquake は地震・津波両方の電文を配信する。
// telegram.tsunami という分類は存在しないため含めない。
const CLASSIFICATIONS = ['eew.forecast', 'eew.warning', 'telegram.earthquake']
// EEW 電文種別: VXSE43=警報, VXSE45=地震動予報。
// VXSE44（予報）は廃止予定のため除外。VXSE45 で同等情報＋長周期地震動が得られる。
// VXSE42（配信テスト）は震源データを持たず EEW として表示できないため別途処理する。
const EEW_TYPES = new Set(['VXSE43', 'VXSE45'])
// VYSE50/51/52=南海トラフ地震臨時情報、VYSE60=北海道・三陸沖後発地震注意情報
// これらは XML 電文（format: "xml"）として配信されるため REST API 経由で取得する
// VYSE52（関連解説情報）は補足解説電文でステータス判定に使えないため除外する
const VYSE_NANKAI_TYPES = new Set(['VYSE50', 'VYSE51'])
const VYSE_KOHATSU_TYPES = new Set(['VYSE60'])
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
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'kohatsu'; data: JMAKohatsu }

export class DmdataWebSocket {
  private ws: WebSocket | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private authError = false

  onEvent: ((ev: DmdataEvent) => void) | null = null
  onStatusChange: ((s: ConnectionStatus) => void) | null = null
  onRawMessage: ((entry: TelegramLogEntry) => void) | null = null

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

  private makeLogEntry(
    headType: string,
    rawHead: unknown,
    rawBody: unknown,
    isTest: boolean,
    status: TelegramLogEntry['status'],
    kind?: TelegramLogEntry['kind'],
    errorMessage?: string,
  ): TelegramLogEntry {
    return {
      id: `${Date.now()}-${Math.random()}`,
      receivedAt: new Date(),
      source: 'dmdss',
      headType,
      isTest,
      status,
      kind,
      rawHead,
      rawBody,
      errorMessage,
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
      if (headType) this.onRawMessage?.(this.makeLogEntry(headType, head, msg.body, true, 'filtered'))
      return
    }
    if (!headType) return

    // VYSE50/51/52（南海トラフ）・VYSE60（後発地震）は format:"xml" で配信される。
    // WebSocket メッセージの body.uri から XML を取得してパースする。
    if (VYSE_NANKAI_TYPES.has(headType) || VYSE_KOHATSU_TYPES.has(headType)) {
      const uri = (msg as { body?: { uri?: string } }).body?.uri
      if (!uri) {
        if (this.debug) dlog('VYSE 電文に uri がない', { headType })
        this.onRawMessage?.(this.makeLogEntry(headType, head, msg.body, isTest, 'error', undefined, 'no uri'))
        return
      }
      try {
        const res = await fetch(uri, { headers: { Authorization: authHeader(this.apiKey) } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const xml = await res.text()
        if (VYSE_NANKAI_TYPES.has(headType)) {
          const nankai = parseVyse5xFromXml(xml)
          if (nankai) {
            if (this.debug) dlog('南海トラフ臨時情報受信', { headType, kindName: nankai.kindName })
            this.onRawMessage?.(this.makeLogEntry(headType, head, xml, isTest, 'parsed', 'nankai'))
            this.onEvent?.({ kind: 'nankai', data: nankai })
          } else {
            this.onRawMessage?.(this.makeLogEntry(headType, head, xml, isTest, 'filtered'))
          }
        } else {
          const kohatsu = parseVyse60FromXml(xml)
          if (kohatsu) {
            if (this.debug) dlog('後発地震注意情報受信', { headType })
            this.onRawMessage?.(this.makeLogEntry(headType, head, xml, isTest, 'parsed', 'kohatsu'))
            this.onEvent?.({ kind: 'kohatsu', data: kohatsu })
          } else {
            this.onRawMessage?.(this.makeLogEntry(headType, head, xml, isTest, 'filtered'))
          }
        }
      } catch (e) {
        if (this.debug) dlog('VYSE XML 取得失敗', { headType, error: String(e) })
        this.onRawMessage?.(this.makeLogEntry(headType, head, msg.body, isTest, 'error', undefined, String(e)))
      }
      return
    }

    // body は base64 + gzip。復号して JSON 化する（仕様準拠）。
    const data = await decodeTelegramBody(msg)
    if (!data) {
      if (this.debug) dlog('body 復号失敗', { headType, format: msg.format, compression: msg.compression, encoding: msg.encoding })
      if (headType) this.onRawMessage?.(this.makeLogEntry(headType, head, msg.body, isTest, 'error', undefined, 'body decode failed'))
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
        this.onRawMessage?.(this.makeLogEntry(headType, head, data, isTest, 'filtered'))
        return
      }
      if (this.debug) dlog('EEW 受信 → 通知', { headType, test: isTest, eventId: eew.issue?.eventId, severity: eew.severity, forecastMaxScale: eew.forecastMaxScale })
      this.onRawMessage?.(this.makeLogEntry(headType, head, data, isTest, 'parsed', 'eew'))
      // 検証用に受信した試験報 EEW はカード・音・地図へ流すため test:false で通知する。
      this.onEvent?.({ kind: 'eew', data: isTest ? { ...eew, test: false } : eew })
    } else if (headType === 'VXSE51' || headType === 'VXSE52' || headType === 'VXSE53' || headType === 'VXSE61') {
      const quake = parseEarthquake(headType, data)
      if (this.debug) dlog('地震情報', { headType, parsed: !!quake })
      if (quake) {
        this.onRawMessage?.(this.makeLogEntry(headType, head, data, isTest, 'parsed', 'quake'))
        this.onEvent?.({ kind: 'quake', data: quake })
      } else {
        this.onRawMessage?.(this.makeLogEntry(headType, head, data, isTest, 'filtered'))
      }
    } else if (headType === 'VTSE41' || headType === 'VTSE51' || headType === 'VTSE52') {
      const tsunami = parseTsunami(headType, data)
      if (this.debug) dlog('津波情報', { headType, parsed: !!tsunami })
      if (tsunami) {
        this.onRawMessage?.(this.makeLogEntry(headType, head, data, isTest, 'parsed', 'tsunami'))
        this.onEvent?.({ kind: 'tsunami', data: tsunami })
      } else {
        this.onRawMessage?.(this.makeLogEntry(headType, head, data, isTest, 'filtered'))
      }
    } else if (headType === 'VXSE62') {
      const lpgm = parseLpgm(data)
      if (lpgm) {
        this.onRawMessage?.(this.makeLogEntry(headType, head, data, isTest, 'parsed', 'lpgm'))
        this.onEvent?.({ kind: 'lpgm', data: lpgm })
      } else {
        this.onRawMessage?.(this.makeLogEntry(headType, head, data, isTest, 'filtered'))
      }
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
  if (headType === 'VXSE51' || headType === 'VXSE52' || headType === 'VXSE53' || headType === 'VXSE61') {
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

// 地震情報の優先度（高いほど優先）。useEarthquakes.ts の ISSUE_PRIORITY と同じ値。
const QUAKE_ISSUE_PRIORITY: Record<string, number> = {
  DestinationAmended: 5, DetailScale: 4, ScaleAndDestination: 3,
  Destination: 2, ScalePrompt: 1, Foreign: 0, Other: 0,
}

// 電文 ID から eventId（14桁タイムスタンプ）を抽出する。
// VXSE51/52/53/61 はすべて同じ eventId を共有するため、同一地震の同定に使用できる。
function extractQuakeEventId(q: JMAQuake): string | null {
  return q.id?.match(/^dmdata-(?:xml-)?quake-(\d{14})-/)?.[1] ?? null
}

// DMDATA REST API で地震履歴（VXSE51/52/53: 震度速報・震源情報・震源＋各地震度）を取得する。
// VXSE61（顕著な地震震源要素更新）も並列取得し、同一イベントの hypocenter をマージする。
// VXSE51/52 は VXSE53 未発表の地震速報をカバーするため初期表示の欠落を防ぐ。
// cursorToken を指定するとカーソル位置以降の古い電文を取得する（「もっと見る」用）。
//
// 初回フェッチの時刻窓統一:
// 各タイプは同じ limit でも発生頻度が違うため取得できる受信時刻範囲がズレる。
// 各タイプの最古受信時刻（time）を比較し、最も新しいもの（cutoffTime）より古いアイテムは
// 全タイプ問わず除外する。これにより不完全なカードが初期表示されることを防ぐ。
export async function fetchDmdataEarthquakes(
  apiKey: string,
  limit: number,
  cursorToken?: string,
): Promise<{ quakes: JMAQuake[]; nextToken?: string }> {
  const qs = cursorToken ? `&cursorToken=${cursorToken}` : ''
  const headers = { Authorization: authHeader(apiKey) }

  const [res51, res52, res53, res61] = await Promise.allSettled([
    fetch(`${API_BASE}/telegram?type=VXSE51&limit=${limit}`, { headers }),
    fetch(`${API_BASE}/telegram?type=VXSE52&limit=${limit}`, { headers }),
    fetch(`${API_BASE}/telegram?type=VXSE53&limit=${limit}${qs}`, { headers }),
    fetch(`${API_BASE}/telegram?type=VXSE61&limit=${limit}`, { headers }),
  ])

  if (res53.status === 'rejected' || !res53.value.ok) {
    const status = res53.status === 'rejected' ? 'network error' : res53.value.status
    throw new Error(`earthquake history: ${status}`)
  }

  type ItemList = { items?: Array<{ url: string; head: { type: string } }>; nextToken?: string }
  const json53 = await res53.value.json() as ItemList

  // VXSE51/52/61 の JSON を並列取得（失敗時は空リストで続行）
  const [json51, json52, json61] = await Promise.all([
    res51.status === 'fulfilled' && res51.value.ok
      ? res51.value.json() as Promise<ItemList>
      : Promise.resolve({ items: [] } as ItemList),
    res52.status === 'fulfilled' && res52.value.ok
      ? res52.value.json() as Promise<ItemList>
      : Promise.resolve({ items: [] } as ItemList),
    res61.status === 'fulfilled' && res61.value.ok
      ? res61.value.json() as Promise<ItemList>
      : Promise.resolve({ items: [] } as ItemList),
  ])

  // VXSE51/52/53/61 の全電文を一括並列取得（タイプ別のインデックス境界を記録）
  const items53 = json53.items ?? []
  const items51 = json51.items ?? []
  const items52 = json52.items ?? []
  const items61 = json61.items ?? []
  const boundary53 = items53.length
  const boundary51 = boundary53 + items51.length
  const boundary52 = boundary51 + items52.length

  const allItems = [
    ...items53.map(it => ({ url: it.url, headType: it.head.type })),
    ...items51.map(it => ({ url: it.url, headType: it.head.type })),
    ...items52.map(it => ({ url: it.url, headType: it.head.type })),
    ...items61.map(it => ({ url: it.url, headType: it.head.type })),
  ]
  const allResults = await Promise.allSettled(
    allItems.map(({ url, headType }) => fetchOneTelegram(apiKey, url, headType)),
  )

  const toQuakes = (results: typeof allResults): JMAQuake[] =>
    results
      .filter((r): r is PromiseFulfilledResult<JMAQuake | JMATsunami | JMALpgm | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter((v): v is JMAQuake => v !== null && 'code' in v && v.code === 551)

  const parsed53 = toQuakes(allResults.slice(0, boundary53))
  const parsed51 = toQuakes(allResults.slice(boundary53, boundary51))
  const parsed52 = toQuakes(allResults.slice(boundary51, boundary52))
  const parsed61 = toQuakes(allResults.slice(boundary52))

  // 各タイプの最古受信時刻（time）を求め、最大値を cutoffTime とする。
  // cutoffTime より古いアイテムは全タイプ問わず除外する。
  const oldestOf = (qs: JMAQuake[]): string | null =>
    qs.reduce<string | null>((acc, q) => acc === null || q.time < acc ? q.time : acc, null)
  const allOldest = [oldestOf(parsed53), oldestOf(parsed51), oldestOf(parsed52), oldestOf(parsed61)]
    .filter((t): t is string => t !== null)
  const cutoffTime = allOldest.length > 0 ? allOldest.reduce((max, t) => t > max ? t : max) : null

  const withinCutoff = (q: JMAQuake): boolean => !cutoffTime || q.time >= cutoffTime

  const rawQuakes = [...parsed53, ...parsed51, ...parsed52].filter(withinCutoff)

  // 同一イベントの VXSE51/52/53 を eventId で重複排除（高優先度を保持）
  // VXSE51 は earthquake.time が targetDateTime、VXSE52/53 は originTime で異なるため
  // earthquake.time ではなく eventId で同一性を判定する。
  const seenByEid = new Map<string, JMAQuake>()
  const noEidQuakes: JMAQuake[] = []
  for (const q of rawQuakes) {
    const eid = extractQuakeEventId(q)
    if (!eid) { noEidQuakes.push(q); continue }
    const existing = seenByEid.get(eid)
    if (!existing || (QUAKE_ISSUE_PRIORITY[q.issue.type] ?? 0) > (QUAKE_ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
      seenByEid.set(eid, q)
    }
  }
  const quakes = [...Array.from(seenByEid.values()), ...noEidQuakes]

  // VXSE61（顕著な地震震源要素更新）: cutoffTime 内のものを対応エントリに震源マージ、なければ単独カードとして追加
  for (const amended of parsed61.filter(withinCutoff)) {
    if (amended.issue.type !== 'DestinationAmended') continue
    const amendedEid = extractQuakeEventId(amended)
    const idx = quakes.findIndex(q =>
      amendedEid ? extractQuakeEventId(q) === amendedEid : q.earthquake.time === amended.earthquake.time,
    )
    if (idx >= 0) {
      quakes[idx] = {
        ...quakes[idx],
        time: amended.time,
        issue: amended.issue,
        earthquake: { ...quakes[idx].earthquake, hypocenter: amended.earthquake.hypocenter },
      }
    } else {
      quakes.push(amended)
    }
  }

  return { quakes, nextToken: json53.nextToken }
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

// DMDATA REST API で南海トラフ地震臨時情報（VYSE50/51）の最新1件を取得する。
// 取得失敗時は null を返す（補助情報なのでアプリを壊さない）。
//
// VYSE52（関連解説情報）は補足解説電文であり InfoKind にステータスキーワードが入らないため
// 発令中/調査終了の判定に使えない。VYSE51（臨時情報の更新）と VYSE50（初報・調査中）のみで判定する。
export async function fetchDmdataNankai(apiKey: string): Promise<JMANankai | null> {
  const headers = { Authorization: authHeader(apiKey) }
  try {
    // VYSE51 が最終状態（調査終了/巨大地震注意/巨大地震警戒）を決定する。
    // VYSE51 がなければ VYSE50（調査中）が発令中。
    for (const type of ['VYSE51', 'VYSE50']) {
      const res = await fetch(`${API_BASE}/telegram?type=${type}&limit=1`, { headers })
      if (!res.ok) continue
      const json = await res.json() as { items?: Array<{ id: string; url: string }> }
      const item = (json.items ?? [])[0]
      if (!item) continue
      const xmlRes = await fetch(item.url, { headers })
      if (!xmlRes.ok) continue
      const xml = await xmlRes.text()
      const nankai = parseVyse5xFromXml(xml)
      if (nankai && !nankai.cancelled) return nankai
      if (nankai?.cancelled) return null
    }
  } catch { /* 取得失敗は無視 */ }
  return null
}

// DMDATA REST API で北海道・三陸沖後発地震注意情報（VYSE60）の最新1件を取得する。
// 取得失敗時は null を返す。
export async function fetchDmdataKohatsu(apiKey: string): Promise<JMAKohatsu | null> {
  const headers = { Authorization: authHeader(apiKey) }
  try {
    const res = await fetch(`${API_BASE}/telegram?type=VYSE60&limit=1`, { headers })
    if (!res.ok) return null
    const json = await res.json() as { items?: Array<{ id: string; url: string; head: { type: string } }> }
    const item = (json.items ?? [])[0]
    if (!item) return null
    const xmlRes = await fetch(item.url, { headers })
    if (!xmlRes.ok) return null
    const xml = await xmlRes.text()
    const kohatsu = parseVyse60FromXml(xml)
    if (!kohatsu || kohatsu.cancelled) return null
    // 有効期限チェック: expireAt が過去なら null
    if (new Date(kohatsu.expireAt) <= new Date()) return null
    return kohatsu
  } catch { return null }
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
