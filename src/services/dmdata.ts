// DMDATA.JP WebSocket クライアント。
// POST /v2/socket → チケット取得 → WebSocket(dmdata.v2) 接続 → Ping/Pong → データ受信。
// 切断時は指数バックオフで再接続する（チケット再取得から）。
//
// 重要: data メッセージの body は formatMode:"json" でも base64 + gzip のまま届く
// （仕様: data.encoding="base64" / data.compression="gzip"）。
// クライアント側で「base64 デコード → gunzip → JSON.parse」を行う必要がある。

import type { JMAQuake, JMATsunami, JMALpgm, JMANankai, JMANankaiCommentary, JMAKohatsu, EEWAlert, ConnectionStatus, TelegramLogEntry } from '../types/earthquake'
import { parseEEW, parseEarthquake, parseTsunami, parseLpgm, parseEarthquakeFromXml, parseTsunamiFromXml, parseLpgmFromXml, parseNankaiFromXml, parseNankaiCommentaryFromXml, parseVyse60FromXml } from './dmdataParser'
import { serverNow, serverDate } from '../utils/clock'
import { gunzip } from '../utils/gzip'
import { log } from '../utils/logger'

const API_BASE = 'https://api.dmdata.jp/v2'
// DMDATA WebSocket 購読分類。telegram.earthquake は地震・津波両方の電文を配信する。
// telegram.tsunami という分類は存在しないため含めない。
const CLASSIFICATIONS = ['eew.forecast', 'eew.warning', 'telegram.earthquake']
// EEW 電文種別: VXSE43=警報, VXSE45=地震動予報。
// VXSE44（予報）は廃止予定のため除外。VXSE45 で同等情報＋長周期地震動が得られる。
// VXSE42（配信テスト）は震源データを持たず EEW として表示できないため別途処理する。
const EEW_TYPES = new Set(['VXSE43', 'VXSE45'])
// VYSE50=南海トラフ地震臨時情報、VYSE51/52=南海トラフ地震関連解説情報、
// VYSE60=北海道・三陸沖後発地震注意情報。
// これらは XML 電文（format: "xml"）として配信されるため REST API 経由で取得する。
//
// 臨時情報（VYSE50）と解説情報（VYSE51/52）は別物として扱う。段階（調査中・巨大地震注意等）を
// 持つのは臨時情報だけで、解説情報は状況の解説にとどまる。同じスロットに入れると解説情報が
// 段階の表示を上書きしてしまう（VYSE51 は臨時情報の発表期間中、毎日届く）。
// VYSE51=臨時解説（臨時情報の期間中）、VYSE52=定例解説（平常時に毎月）。
const VYSE_NANKAI_TYPES = new Set(['VYSE50'])
const VYSE_COMMENTARY_TYPES = new Set(['VYSE51', 'VYSE52'])
const VYSE_KOHATSU_TYPES = new Set(['VYSE60'])
const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 30000
const RECONNECT_FACTOR = 1.5
// DMDATA v2 は概ね 15〜30 秒間隔で ping を送出する。90 秒間 ping/data の受信が無い場合は
// 半開通信（TCP は生きているが実質無応答）と判定して自発 close → 再接続する。
const PING_WATCHDOG_MS = 90000
const PING_WATCHDOG_CHECK_MS = 15000
// start 受信後、この時間だけ接続が維持できたら reconnectAttempt をリセットする。
// start 受信直後にリセットしてしまうと「open→start→即切断」を繰り返すフラッピングで
// バックオフが効かず高頻度でチケット再取得を叩き続ける状態になるため、健全性を確認してからリセットする。
const STABLE_CONNECTION_MS = 15000

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

// 意図的に console.debug ではなく info を使う: opt-in のログのため、有効化したら
// DevTools の Verbose 設定なしでも即座に見えるようにする。
function dlog(...args: unknown[]): void {
  log.info('[DMDSS]', ...args)
}

/**
 * REST 取得の失敗を記録する。401/403（契約スコープ不足・キー不正）はリトライしても直らないため
 * error に上げ、確認先を添える。それ以外（500・429 等）は一時的な失敗として warn に留める。
 * WebSocket チケット取得（`fetchTicketUrl`）が 401/403 を特別扱いしているのと同じ切り分けを、
 * REST 取得側にも揃えるためのヘルパー。
 */
function logRestFailure(what: string, status: number): void {
  if (status === 401 || status === 403) {
    log.error(`[DMDSS] ${what}: 認証エラー (${status})。APIキーの契約スコープを確認してください（再試行では解消しません）`)
  } else {
    log.warn(`[DMDSS] ${what}: 取得失敗 (${status})`)
  }
}

// base64 文字列をバイト列にデコードする。
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
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
  if (res.status === 200) {
    if (debug) dlog('socket チケット取得 OK', { status: res.status })
  } else {
    // 403/401/409 等の理由（契約スコープ不足・同時接続数上限など）は実エラーのため、
    // デバッグフラグに関係なく常に可視化する。
    const e = (body as { error?: { message?: string; code?: number } }).error
    log.warn('[DMDSS] socket チケット取得 失敗', { status: res.status, errorCode: e?.code, errorMessage: e?.message })
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
  | { kind: 'nankaiCommentary'; data: JMANankaiCommentary }
  | { kind: 'kohatsu'; data: JMAKohatsu }

export class DmdataWebSocket {
  private ws: WebSocket | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private authError = false
  // 最後にサーバー活動を確認した時刻（ping / data 受信）。ping ウォッチドッグが読む。
  private lastActivityAt = 0
  private pingWatchdogTimer: ReturnType<typeof setInterval> | null = null
  // start 受信後の安定判定タイマー。STABLE_CONNECTION_MS 継続で reconnectAttempt をリセットする。
  private stableConnectionTimer: ReturnType<typeof setTimeout> | null = null

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
        // APIキー不正・契約スコープ不足は復旧不能の実エラーのため常に出力する。
        log.error('[DMDSS] 認証エラーのため再接続しない（APIキーの契約スコープ・WebSocket権限を確認）', { reason })
        this.authError = true
        this.onStatusChange?.('disconnected')
        return
      }
      if (this.debug) dlog('接続失敗', { reason })
      this.scheduleReconnect()
    }
  }

  private openWs(url: string) {
    const ws = new WebSocket(url, 'dmdata.v2')
    this.ws = ws
    // start 受信で正常購読が確定するまで reconnectAttempt を維持する（DMD-3）。
    // onopen で 0 リセットしてしまうと、start 前に切断される状態で指数バックオフが効かなくなる。
    this.lastActivityAt = performance.now()
    this.startPingWatchdog()

    ws.onopen = () => {
      if (this.debug) dlog('WebSocket open')
    }

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(ev.data as string) as Record<string, unknown>
      } catch { return /* メッセージエンベロープのパース失敗は無視 */ }
      // 任意メッセージ受信でサーバー活動を確認したとみなす（ping ウォッチドッグ用）。
      // duration 計測は単調増加する performance.now() を使う（壁時計・serverNow は NTP 補正で
      // 非連続にジャンプするため duration 計測には不適）。
      this.lastActivityAt = performance.now()
      // body の復号は非同期（gunzip）。発火後は待たない。
      void this.handleMessage(msg)
    }

    ws.onclose = (ev) => {
      if (this.debug) dlog('WebSocket close', { code: ev.code, reason: ev.reason })
      this.stopPingWatchdog()
      this.stopStableConnectionTimer()
      // 既知の非回復系 close code は authError 相当に停止する（DMD-2）。
      // 現状は 1008（Policy Violation）のみを非回復扱いにする。4xxx（application-defined）は
      // DMDATA が実際に何を送るか公式仕様の裏取りが取れておらず、一律停止だと誤判定時に
      // 自動復旧経路が無くなるため、通常の再接続対象に含めておく。
      if (!this.stopped && isNonRecoverableCloseCode(ev.code)) {
        log.error('[DMDSS] 非回復系 close code のため再接続しない', { code: ev.code, reason: ev.reason })
        this.authError = true
        this.onStatusChange?.('disconnected')
        return
      }
      if (!this.stopped && !this.authError) {
        this.onStatusChange?.('disconnected')
        this.scheduleReconnect()
      }
    }

    ws.onerror = () => {
      if (this.debug) dlog('WebSocket error')
    }
  }

  // DMDATA v2 は概ね 15〜30 秒間隔で ping を送出する。PING_WATCHDOG_MS 以上受信が
  // 無ければ半開通信と判定して自発的に close する（onclose 経由で再接続される）。
  // duration 計測は単調増加する performance.now() を使うため、クロック較正ジャンプの影響は受けない。
  // 注意: 真の半開通信では ws.close() は要求として動くだけで、実際の onclose 発火まで
  // ブラウザ/OS のタイムアウトに依存して数十秒〜遅延することがある。
  private startPingWatchdog() {
    this.stopPingWatchdog()
    this.pingWatchdogTimer = setInterval(() => {
      if (this.stopped || this.authError) return
      const elapsed = performance.now() - this.lastActivityAt
      if (elapsed > PING_WATCHDOG_MS) {
        if (this.debug) dlog('ping ウォッチドッグ発火・自発 close', { elapsedMs: Math.round(elapsed) })
        try { this.ws?.close() } catch { /* 既に close 済みは無視 */ }
      }
    }, PING_WATCHDOG_CHECK_MS)
  }

  private stopPingWatchdog() {
    if (this.pingWatchdogTimer !== null) {
      clearInterval(this.pingWatchdogTimer)
      this.pingWatchdogTimer = null
    }
  }

  // start 受信後、STABLE_CONNECTION_MS 継続で reconnectAttempt をリセットする。
  // 「start 受信直後にリセット」だとフラッピング（start→即切断の繰り返し）でバックオフが
  // 効かず高頻度でチケット再取得を叩き続ける状態になるため、安定を確認してからリセットする。
  private scheduleStableReset() {
    this.stopStableConnectionTimer()
    this.stableConnectionTimer = setTimeout(() => {
      if (this.stopped || this.authError) return
      this.reconnectAttempt = 0
      if (this.debug) dlog('接続安定・reconnectAttempt リセット')
    }, STABLE_CONNECTION_MS)
  }

  private stopStableConnectionTimer() {
    if (this.stableConnectionTimer !== null) {
      clearTimeout(this.stableConnectionTimer)
      this.stableConnectionTimer = null
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
      receivedAt: serverDate(),
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
      // 購読開始が確定してから安定判定を予約する（DMD-3）。
      // STABLE_CONNECTION_MS 継続で reconnectAttempt をリセット。
      // start 直後の即時リセットだと start→即切断のフラッピングでバックオフが効かない。
      this.scheduleStableReset()
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

    // VYSE50（南海トラフ臨時情報）・VYSE51/52（同 関連解説情報）・VYSE60（後発地震）は
    // format:"xml" で配信される。WebSocket メッセージの body.uri から XML を取得してパースする。
    if (VYSE_NANKAI_TYPES.has(headType) || VYSE_COMMENTARY_TYPES.has(headType) || VYSE_KOHATSU_TYPES.has(headType)) {
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
          const nankai = parseNankaiFromXml(xml)
          if (nankai) {
            if (this.debug) dlog('南海トラフ臨時情報受信', { headType, kindName: nankai.kindName })
            this.onRawMessage?.(this.makeLogEntry(headType, head, xml, isTest, 'parsed', 'nankai'))
            this.onEvent?.({ kind: 'nankai', data: nankai })
          } else {
            // VYSE50 は必ず段階（調査中・巨大地震注意等）を持つ電文なので、読めないのは書式が
            // 変わった等の異常。電文ログ（設定タブ）だけに残すと開かないと気づけないため、
            // debug フラグに関わらずコンソールへ出す。
            log.warn(`[DMDSS] 南海トラフ臨時情報 (${headType}) の段階を解析できませんでした`)
            this.onRawMessage?.(this.makeLogEntry(headType, head, xml, isTest, 'filtered'))
          }
        } else if (VYSE_COMMENTARY_TYPES.has(headType)) {
          const commentary = parseNankaiCommentaryFromXml(xml)
          if (commentary) {
            if (this.debug) dlog('南海トラフ関連解説情報受信', { headType, serialName: commentary.serialName })
            this.onRawMessage?.(this.makeLogEntry(headType, head, xml, isTest, 'parsed', 'nankaiCommentary'))
            this.onEvent?.({ kind: 'nankaiCommentary', data: commentary })
          } else {
            // 取消電文は cancelled を立てて返るためここには来ない。null は書式の異常だけ
            log.warn(`[DMDSS] 南海トラフ関連解説情報 (${headType}) を解析できませんでした`)
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
    if (this.debug) dlog('再接続をスケジュール', { attempt: this.reconnectAttempt, delayMs: Math.round(delay) })
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
    this.stopPingWatchdog()
    this.stopStableConnectionTimer()
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }
}

// 非回復系 WebSocket close code を判定する。
// 保守的に 1008（Policy Violation）のみ非回復扱いにする。4xxx（application-defined）は
// DMDATA v2 の公式仕様の裏取りが取れておらず、一律停止だと誤判定時に自動復旧経路が
// 無くなるため通常の再接続対象に含める。実運用ログで意味が判明したら個別に列挙する。
export function isNonRecoverableCloseCode(code: number): boolean {
  return code === 1008
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

// DMDATA REST API で地震履歴（VXSE51/52/53: 震度速報・震源情報・震源＋各地震度）を取得する。
// VXSE61（顕著な地震震源要素更新）も並列取得する。同一 eventId の電文どうしの統合
// （VXSE61 の震源マージ・震度の保持・優先度判定など）は呼び出し側（useEarthquakes の
// mergeQuakeHistory）がリアルタイム経路と同一ロジックで行うため、ここでは cutoffTime による
// 不完全カードの除外だけを行い、種別横断の生電文をそのまま返す。
// VXSE51/52 は VXSE53 未発表の地震速報をカバーするため初期表示の欠落を防ぐ。
// cursorToken を指定するとカーソル位置以降の古い電文を取得する（「もっと見る」用・VXSE53 に適用）。
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
      .filter((v): v is JMAQuake => v !== null && 'kind' in v && v.kind === 'quake')

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

  // cutoffTime による不完全カード除外のみ行い、種別横断（VXSE51/52/53/61）の生電文を返す。
  // 同一 eventId の統合（VXSE61 の震源マージ・震度の保持・優先度判定）は呼び出し側の
  // mergeQuakeHistory がリアルタイム経路と同一ロジックで行う。
  const quakes = [...parsed53, ...parsed51, ...parsed52, ...parsed61].filter(withinCutoff)

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
    .filter((v): v is JMATsunami => v !== null && 'kind' in (v as object) && (v as JMATsunami).kind === 'tsunami')
}

// DMDATA REST API で南海トラフ地震臨時情報（VYSE50）の最新1件を取得する。
// 取得失敗時は null を返す（補助情報なのでアプリを壊さない）が、失敗した事実はログに残す。
// 「発表なし」と「取得できていない」は同じ null になるため、記録が無いと区別できなくなる。
//
// 段階（調査中／巨大地震注意／巨大地震警戒／調査終了）はすべて VYSE50 で配信されるため、
// 発令中かどうかはこの 1 種別だけで判定できる。解説情報（VYSE51/52）は段階を持たないので
// ここでは見ない（以前は VYSE51 を優先して見ており、解説情報が段階を騙る原因になっていた）。
export async function fetchDmdataNankai(apiKey: string): Promise<JMANankai | null> {
  const headers = { Authorization: authHeader(apiKey) }
  try {
    const res = await fetch(`${API_BASE}/telegram?type=VYSE50&limit=1`, { headers })
    if (!res.ok) { logRestFailure('南海トラフ地震臨時情報 (VYSE50) の一覧', res.status); return null }
    const json = await res.json() as { items?: Array<{ id: string; url: string }> }
    const item = (json.items ?? [])[0]
    if (!item) return null
    const xmlRes = await fetch(item.url, { headers })
    if (!xmlRes.ok) { logRestFailure('南海トラフ地震臨時情報 (VYSE50) の電文本体', xmlRes.status); return null }
    const nankai = parseNankaiFromXml(await xmlRes.text())
    // 取得はできたのに読めなかった場合を黙って「発表なし」に混ぜない。VYSE50 は必ず段階を持つため、
    // ここが null になるのは書式が変わった等の異常であり、記録が無いと追跡できなくなる。
    if (!nankai) {
      log.warn('[DMDSS] 南海トラフ地震臨時情報 (VYSE50) の段階を解析できませんでした')
      return null
    }
    // 調査終了・取消は「発令中ではない」ので表示しない
    if (!nankai.cancelled) return nankai
  } catch (err) {
    log.error('[DMDSS] 南海トラフ地震臨時情報の取得に失敗', err)
  }
  return null
}

// DMDATA REST API で南海トラフ地震関連解説情報（VYSE51/52）の最新1件を取得する。
// 取得失敗時の扱いは fetchDmdataNankai と同じ。
//
// 臨時解説（VYSE51）と定例解説（VYSE52）のうち、発表が新しい方を採る。臨時情報の発表期間中は
// 毎日 VYSE51 が出るためそちらが勝ち、平常時は毎月の VYSE52 が残る。
// 期限切れ（発表から 7 日）のものは初期表示に出さない。定例解説は月 1 回しか来ないため、
// これを見ないと「先月の解説」が起動時に毎回出てしまう。
export async function fetchDmdataNankaiCommentary(apiKey: string): Promise<JMANankaiCommentary | null> {
  const headers = { Authorization: authHeader(apiKey) }
  let newest: JMANankaiCommentary | null = null
  // try は種別ごとに分ける。1 つの try でループ全体を包むと、VYSE51 側の例外（ネットワーク断・
  // JSON 破損など !res.ok で捕まらない失敗）でループが中断し、取得できたはずの VYSE52 まで
  // 諦めることになる。平常時は VYSE52 しか存在しないため、そちらを守る必要がある。
  for (const type of ['VYSE51', 'VYSE52']) {
    try {
      const res = await fetch(`${API_BASE}/telegram?type=${type}&limit=1`, { headers })
      if (!res.ok) { logRestFailure(`南海トラフ地震関連解説情報 (${type}) の一覧`, res.status); continue }
      const json = await res.json() as { items?: Array<{ id: string; url: string }> }
      const item = (json.items ?? [])[0]
      if (!item) continue
      const xmlRes = await fetch(item.url, { headers })
      if (!xmlRes.ok) { logRestFailure(`南海トラフ地震関連解説情報 (${type}) の電文本体`, xmlRes.status); continue }
      const commentary = parseNankaiCommentaryFromXml(await xmlRes.text())
      // 取得はできたのに読めなかった場合を黙って「発表なし」に混ぜない
      if (!commentary) {
        log.warn(`[DMDSS] 南海トラフ地震関連解説情報 (${type}) を解析できませんでした`)
        continue
      }
      // 取消済みのものは起動時の表示対象にしない
      if (commentary.cancelled) continue
      if (new Date(commentary.expireAt).getTime() <= serverNow()) continue
      // 文字列比較にしないこと。ISO 文字列のタイムゾーン表記が揃っている保証はない
      if (!newest || new Date(commentary.reportDateTime).getTime() > new Date(newest.reportDateTime).getTime()) {
        newest = commentary
      }
    } catch (err) {
      log.error(`[DMDSS] 南海トラフ地震関連解説情報 (${type}) の取得に失敗`, err)
    }
  }
  return newest
}

// DMDATA REST API で北海道・三陸沖後発地震注意情報（VYSE60）の最新1件を取得する。
// 取得失敗時は null を返すが、失敗した事実はログに残す（理由は fetchDmdataNankai と同じ）。
export async function fetchDmdataKohatsu(apiKey: string): Promise<JMAKohatsu | null> {
  const headers = { Authorization: authHeader(apiKey) }
  try {
    const res = await fetch(`${API_BASE}/telegram?type=VYSE60&limit=1`, { headers })
    if (!res.ok) { logRestFailure('後発地震注意情報 (VYSE60) の一覧', res.status); return null }
    const json = await res.json() as { items?: Array<{ id: string; url: string; head: { type: string } }> }
    const item = (json.items ?? [])[0]
    if (!item) return null
    const xmlRes = await fetch(item.url, { headers })
    if (!xmlRes.ok) { logRestFailure('後発地震注意情報 (VYSE60) の電文本体', xmlRes.status); return null }
    const xml = await xmlRes.text()
    const kohatsu = parseVyse60FromXml(xml)
    if (!kohatsu || kohatsu.cancelled) return null
    // 有効期限チェック: expireAt が過去なら null
    if (new Date(kohatsu.expireAt) <= serverDate()) return null
    return kohatsu
  } catch (err) {
    log.error('[DMDSS] 後発地震注意情報の取得に失敗', err)
    return null
  }
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

// GD Earthquake List（gd.earthquake スコープ）の1件分。震源緯度経度・マグニチュードが
// レスポンス内で完結しており、telegram 系のような電文個別取得（N+1）が不要。
export interface GdEarthquakeItem {
  eventId: string
  originTime: string
  latitude: number
  longitude: number
  /** マグニチュード。値なし・数値化できない（「不明」等）場合は -1。 */
  magnitude: number
  /** 震源地名。レスポンスに含まれない場合は空文字。 */
  name: string
  /** 深さ(km)。値なし・数値化できない（「不明」等）場合は -1。 */
  depth: number
}

/** GD Earthquake List の深さフィールドを km の数値にする。取れなければ -1。 */
function gdDepthKm(depth?: { value?: string | null }): number {
  const raw = depth?.value
  if (raw == null) return -1
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : -1
}

const GD_EARTHQUAKE_MAX_PAGES = 20

// DMDATA REST API で震源カタログ（GD Earthquake List）を取得し、直近 `days` 日分に絞って返す。
// 通常版の fetchJmaQuakeHistory に相当するヒートマップ用データ源。
// 震源または発生時刻が決まっていない項目は地図に置けないため、その1件だけ除いて取得を続ける。
// 通常版（P2PQuake）も震源未確定を落とすが、判定は別物。あちらは欠測を -200 等のセンチネル値で
// 受け取るため `hasValidHypocenter` が値域で判定する。DMDATA はフィールドごと欠けるので、
// ここでは「数値として読めるか」で判定する（同じ関数を使い回すと判定の根拠が入れ替わる）。
// 新しい順（降順）で返る前提で、cutoff に達した時点で全ページの探索を打ち切る。
// ただし走査できる範囲を読み切っても 1 件も残らなかった場合は例外を投げる（理由は関数末尾のコメント）。
// gd.earthquake スコープが契約に含まれない場合は 403 で例外を投げる。
export async function fetchDmdataGdEarthquakes(apiKey: string, days: number): Promise<GdEarthquakeItem[]> {
  const headers = { Authorization: authHeader(apiKey) }
  const cutoffMs = serverNow() - days * 24 * 60 * 60 * 1000
  const collected: GdEarthquakeItem[] = []
  let cursorToken: string | undefined
  // 捨てた件数。取得後に 1 行だけ出す（P2PQuake 側の warnField/warnMissing と同じく、
  // 既定の扱いに落とすこと自体は許すが黙っては通さない）。理由を分けて数えるのは、
  // 障害時に「震源未確定が急増した」のか「API のフィールドが変わった」のかを切り分けるため。
  let skippedNoTime = 0
  let skippedNoCoord = 0
  // 期間の端まで到達したか。ページを跨いで保持する（末尾の全滅判定が読む）。
  let reachedCutoff = false

  for (let page = 0; page < GD_EARTHQUAKE_MAX_PAGES; page++) {
    const qs = cursorToken ? `&cursorToken=${cursorToken}` : ''
    const res = await fetch(`${API_BASE}/gd/earthquake?limit=100${qs}`, { headers })
    if (!res.ok) {
      // 呼び出し側は失敗の中身で挙動を変えないため、恒久（スコープ不足）と一時（500 等）の
      // 区別はここでログに残す。例外自体は従来どおり投げて取得を止める。
      logRestFailure('震源カタログ (gd/earthquake)', res.status)
      throw new Error(`gd/earthquake: ${res.status}`)
    }
    const json = await res.json() as {
      items?: Array<{
        eventId: string
        // 震源が未決定の地震（震度速報だけが出て震源・震度情報がまだ発表されていない等）は、
        // originTime も hypocenter も持たない項目として返る（eventId・arrivalTime・maxInt のみ）。
        // 実データに合わせて optional とし、読む側で必ず存在を確かめる。必須と宣言すると
        // 「あるはず」の思い込みのまま参照して例外になり、1件の欠測で全ページ分を失う。
        originTime?: string
        hypocenter?: {
          // 震源地名・深さはヒートマップのポップアップ表示に使う。契約や電文の種別によっては
          // 欠けることがあるため optional として扱い、欠測時は空文字 / -1 に倒す。
          name?: string
          coordinate?: { latitude?: { value?: string }; longitude?: { value?: string } }
          depth?: { value?: string | null }
        }
        magnitude?: { value?: string }
      }>
      nextToken?: string
    }
    const items = json.items ?? []
    if (items.length === 0) break

    for (const it of items) {
      // 期間の打ち切りは発生時刻を持つ項目だけで判断する。震源未決定の項目は時刻も持たないため、
      // ここで打ち切ると以降のページを取り逃がす（新しい側に1件混ざるだけで1ヶ月分が欠ける）。
      const originTime = it.originTime
      const originMs = originTime ? new Date(originTime).getTime() : NaN
      if (Number.isFinite(originMs) && originMs < cutoffMs) { reachedCutoff = true; break }
      const latitude = parseFloat(it.hypocenter?.coordinate?.latitude?.value ?? '')
      const longitude = parseFloat(it.hypocenter?.coordinate?.longitude?.value ?? '')
      // 置く場所（震源）と時刻のどちらかが無ければヒートマップに載せられない。この1件だけ捨てる。
      if (!originTime || !Number.isFinite(originMs)) { skippedNoTime++; continue }
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) { skippedNoCoord++; continue }
      const magnitude = parseFloat(it.magnitude?.value ?? '')
      collected.push({
        eventId: it.eventId,
        originTime,
        latitude,
        longitude,
        // 深さと同じく、値なし・数値化できない場合は -1（不明）に倒す。NaN のまま流すと
        // 重みの計算結果も NaN になり、ヒートマップの描画が壊れる。
        magnitude: Number.isFinite(magnitude) ? magnitude : -1,
        name: it.hypocenter?.name ?? '',
        depth: gdDepthKm(it.hypocenter?.depth),
      })
    }
    if (reachedCutoff || !json.nextToken) break
    // 1 ページ丸ごと捨てて 1 件も残らなかったなら、応答の形が変わった可能性が高い。残りのページを
    // 取りに行っても同じことになるので、ここで打ち切って末尾の全滅判定に落とす。
    // （震源未決定の項目は cutoff 判定を素通りするため、この打ち切りが無いと GD_EARTHQUAKE_MAX_PAGES
    //   ぶんのリクエストを空振りに費やしてから例外になる。）
    if (collected.length === 0) break
    cursorToken = json.nextToken
  }

  const skipped = skippedNoTime + skippedNoCoord
  if (skipped > 0) {
    log.warn(
      `[DMDSS] GD Earthquake List: ${collected.length + skipped} 件中 ${skipped} 件をスキップしました` +
        `（発生時刻なし ${skippedNoTime} 件 / 震源座標なし ${skippedNoCoord} 件）`,
    )
  }
  // 走査できる範囲を読み切っても 1 件も地図に置けなかったときは、応答の形が変わった可能性が高い。
  // ここで空配列を「正常な結果」として返すと、呼び出し側（useQuakeHeatmap）がそれをキャッシュし、
  // 直前まで出ていたヒートマップを消したうえで TTL の間そのままにしてしまう。例外にして、既存の
  // 失敗経路（前回のキャッシュを使い続ける）へ倒す。
  // 判定に付いている 3 つの条件はそれぞれ別の正常系を除けるためのもの。
  //   - skipped > 0 …… 期間内に地震が本当に無くて 0 件だった場合を異常としない
  //   - !reachedCutoff … 期間の端まで正常に読み切った結果 0 件だった場合を異常としない
  //     （直近の数件が偶然すべて震源未決定で、その次が期間外だった、という並びで起こりうる）
  // 割合ではなく「全滅」だけを異常とみなすのは、大地震の直後は震源未確定の項目が一時的に増える
  // ため。割合で切ると、最も見たいときにヒートマップを消すことになる。
  if (collected.length === 0 && skipped > 0 && !reachedCutoff) {
    throw new Error(
      `gd/earthquake: 走査した ${skipped} 件すべてを除外（発生時刻なし ${skippedNoTime} 件 / ` +
        `震源座標なし ${skippedNoCoord} 件）。地図に置ける項目がありません`,
    )
  }
  return collected
}
