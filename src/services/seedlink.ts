/**
 * 公開観測点の波形を SeedLink（WebSocket）で受ける。手順は `seedlinkSession.ts`、レコードの読み取りは
 * `utils/miniseed2.ts`。ここは接続を開き、期限を見張り、閉じた理由を種類で返すだけ。
 *
 * **繋ぎ直しはしない。** いつ・どこから繋ぎ直すか（どこまで遡るか・何回まで試すか）は使う側の判断で、
 * ここは「閉じた」と理由を知らせて終わる。**どの失敗も `onClosed` へ 1 回だけ届く**（開く前の例外・
 * 送れなかった・使う側の処理が投げた、を含む）。
 *
 * ブラウザからは中継なしで繋がる（2026-10-14 に GitHub Pages の配信元から Chromium で確かめた。
 * 開くまで約 2.0 秒・最初のレコードまで約 2.6 秒）。
 */
import { Mseed2Error, parseMseed2Record, type Mseed2Problem, type Mseed2Record } from '../utils/miniseed2'
import { SeedlinkSession, type SeedlinkEvent, type SeedlinkRequest } from './seedlinkSession'

export const EARTHSCOPE_SEEDLINK_URL = 'wss://rtserve.earthscope.org/seedlink'
export const SEEDLINK_SUBPROTOCOL = 'SeedLink3.1'

export type SeedlinkCloseReason =
  /** 呼び出し側が閉じた */
  | 'closed-by-caller'
  /** 接続を始められなかった（命令の組み立て・WebSocket の生成が投げた） */
  | 'failed-to-start'
  /** 期限までに開かなかった */
  | 'open-timeout'
  /** 命令への応答が期限までに来なかった */
  | 'reply-timeout'
  /** 命令が断られた（`ERROR`） */
  | 'refused'
  /** 応答が `OK` でも `ERROR` でもなかった（手順がずれた） */
  | 'protocol-error'
  /** `END` を送った後、期限のあいだ読めるレコードが 1 本も届かなかった */
  | 'stalled'
  /** 相手が閉じた・通信が切れた・送れなかった */
  | 'closed-by-peer'
  /** 使う側の `onRecord`・`onStreaming`・`onUnreadable` が投げた（受けたものを渡せないので、閉じて知らせる） */
  | 'handler-error'
  /** 手順や切り分けの側が想定外の例外を投げた（この部品の不具合。受信の残りを黙って失わないよう閉じる） */
  | 'unexpected-exception'

export interface SeedlinkClosed {
  reason: SeedlinkCloseReason
  /** 断られた命令と応答・閉じたときの code・開いていたかなど、記録に残す補足 */
  detail: string
  /** 読めたレコードの本数 */
  records: number
  /** 読めなかったレコード・読み飛ばした区切りの数 */
  unreadable: number
}

/** 読めなかったものの種類。`garbled` は区切りとして読めないバイト列、`internal-error` は読み手の想定外の例外 */
export type SeedlinkUnreadable = Mseed2Problem | 'garbled' | 'internal-error'

export interface SeedlinkHandlers {
  onRecord(record: Mseed2Record): void
  /** 読めないレコード・切り分けられないバイト列。数えて記録へ残すため、理由の種類で渡す */
  onUnreadable(problem: SeedlinkUnreadable, detail: string): void
  /** 最初の読めるレコードが届いた（`END` を送っただけでは呼ばない） */
  onStreaming(): void
  /**
   * 閉じた。1 回だけ呼ばれる。`close()` の中から同期で呼ばれることがある。
   * **ここで投げた例外は飲み込まない。** 知らせる先がもう無いので、次の順番で未捕捉の例外として投げ直す
   * （受信の処理を包んだ見張りに拾われて消えないように）
   */
  onClosed(closed: SeedlinkClosed): void
}

export interface SeedlinkOptions {
  url: string
  request: SeedlinkRequest
  /** 開くまでの期限（ミリ秒） */
  openTimeoutMs: number
  /** 命令 1 つへの応答の期限（ミリ秒） */
  replyTimeoutMs: number
  /**
   * `END` を送ってから、読めるレコードが 1 本も届かない時間がこれを超えたら止まったと見なす（ミリ秒）。
   * 静かなとき 1 成分のレコードは約 21 秒おきに届く（設計書 §3.2）。値は使う側が実測から決める
   */
  stallTimeoutMs: number
  /** WebSocket の実装。ブラウザでは `globalThis.WebSocket` を渡す（テストは偽物を渡す） */
  webSocket: typeof WebSocket
}

export interface SeedlinkConnection {
  close(): void
}

export function connectSeedlink(options: SeedlinkOptions, handlers: SeedlinkHandlers): SeedlinkConnection {
  let records = 0
  let unreadable = 0
  let finished = false
  let opened = false
  let streamingSeen = false
  let lastError = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let ws: WebSocket | null = null
  let session: SeedlinkSession

  const finish = (reason: SeedlinkCloseReason, detail: string) => {
    if (finished) return
    finished = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    let closeProblem = ''
    if (ws !== null) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      // error の聞き手は外さない（実装によっては閉じる途中で error を起こし、聞き手が無いと未捕捉になる）
      ws.onerror = () => {}
      try {
        if (ws.readyState === options.webSocket.CONNECTING || ws.readyState === options.webSocket.OPEN) ws.close()
      } catch (e) {
        closeProblem = `・閉じるときに失敗: ${String(e)}`
      }
    }
    try {
      handlers.onClosed({ reason, detail: `${detail}${closeProblem}`, records, unreadable })
    } catch (e) {
      setTimeout(() => {
        throw e
      }, 0)
    }
  }

  const arm = (ms: number, reason: SeedlinkCloseReason, detail: string) => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => finish(reason, detail), ms)
  }
  const armStall = () => arm(options.stallTimeoutMs, 'stalled', `${options.stallTimeoutMs} ms のあいだ読めるレコードが届かなかった`)

  const send = (command: string): boolean => {
    try {
      ws!.send(`${command}\r\n`)
      return true
    } catch (e) {
      finish('closed-by-peer', `${command} を送れなかった: ${String(e)}`)
      return false
    }
  }

  /** 読めなかったものを数えて渡す。使う側が投げたら閉じて false */
  const reportUnreadable = (problem: SeedlinkUnreadable, detail: string): boolean => {
    unreadable++
    try {
      handlers.onUnreadable(problem, detail)
      return true
    } catch (e) {
      finish('handler-error', `onUnreadable（${problem}）を渡したところで投げた: ${String(e)}`)
      return false
    }
  }

  /** 受信と開いたときの処理を包む。想定外の例外で、その回の残りを黙って失わない */
  const guarded = (what: string, body: () => void) => {
    try {
      body()
    } catch (e) {
      finish('unexpected-exception', `${what}の処理で投げた: ${String(e)}`)
    }
  }

  const run = (events: SeedlinkEvent[]) => {
    for (const ev of events) {
      if (finished) return
      switch (ev.type) {
        case 'send':
          if (session.isStreaming) armStall()
          else arm(options.replyTimeoutMs, 'reply-timeout', `${ev.command} への応答が来なかった`)
          if (!send(ev.command)) return
          break
        case 'refused':
          finish('refused', `${ev.command} → ${ev.reply}`)
          return
        case 'unexpected':
          finish('protocol-error', `${ev.command || '（命令なし）'} → ${JSON.stringify(ev.reply.slice(0, 40))}`)
          return
        case 'garbled':
          if (!reportUnreadable('garbled', `${ev.droppedBytes} バイトを読み飛ばした（先頭 ${JSON.stringify(ev.head)}）`)) return
          break
        case 'packet': {
          let record: Mseed2Record
          try {
            record = parseMseed2Record(ev.record)
          } catch (e) {
            const ok =
              e instanceof Mseed2Error
                ? reportUnreadable(e.problem, `連番 ${ev.sequence}: ${e.message}`)
                : reportUnreadable('internal-error', `連番 ${ev.sequence}: ${String(e)}`)
            if (!ok) return
            break
          }
          records++
          armStall()
          try {
            if (!streamingSeen) {
              streamingSeen = true
              handlers.onStreaming()
            }
            handlers.onRecord(record)
          } catch (e) {
            finish('handler-error', `連番 ${ev.sequence} を渡したところで投げた: ${String(e)}`)
            return
          }
          break
        }
      }
    }
  }

  try {
    session = new SeedlinkSession(options.request)
    ws = new options.webSocket(options.url, [SEEDLINK_SUBPROTOCOL])
    ws.binaryType = 'arraybuffer'
  } catch (e) {
    const detail = String(e)
    // 呼び出し側が戻り値を受け取る前に onClosed が走らないよう、次の順番へ回す
    setTimeout(() => finish('failed-to-start', detail), 0)
    return { close: () => finish('closed-by-caller', '') }
  }

  arm(options.openTimeoutMs, 'open-timeout', `${options.openTimeoutMs} ms のあいだ開かなかった`)
  ws.onopen = () =>
    guarded('開いたとき', () => {
      opened = true
      run(session.start())
    })
  ws.onmessage = (ev: MessageEvent) =>
    guarded('受信', () => {
      const data: unknown = ev.data
      let bytes: Uint8Array
      if (typeof data === 'string') {
        // 応答の文字列はバイトとしてそのまま読む（手順の側は latin1 で読む）
        bytes = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff
      } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data)
      } else {
        reportUnreadable('garbled', `想定していない型の受信: ${Object.prototype.toString.call(data)}`)
        return
      }
      run(session.feed(bytes))
    })
  ws.onerror = (ev: Event) => {
    // error の後には close が続く（WHATWG の WebSocket）。理由は close で残し、ここでは中身だけ覚える
    const msg = (ev as Event & { message?: unknown }).message
    lastError = typeof msg === 'string' && msg !== '' ? msg : ev.type
  }
  ws.onclose = (ev: CloseEvent) =>
    finish(
      'closed-by-peer',
      `code ${ev.code}${ev.reason ? `・${ev.reason}` : ''}・${opened ? '開いた後' : '開く前'}${lastError ? `・error: ${lastError}` : ''}`,
    )

  return { close: () => finish('closed-by-caller', '') }
}
