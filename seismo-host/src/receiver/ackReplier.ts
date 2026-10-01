// 基板へ「届いた」と返す。
//
// **基板は送る側なので、自分の送信が届いているかを自分では知れない。** ESP32 の
// `WiFiUDP` は Wi-Fi が切れて戻ったあと、ソケットが無効なまま `endPacket()` に成功を
// 返し続ける（2026-09-30 に 1 枚が 5 日間その状態だった）。基板が自分で立て直すには、
// 外から「届いている」と言ってもらう以外に手掛かりが無い。返事が途絶えたときの
// 段の上げ方は基板の側（`firmware/seismo-node/seismo-node.ino` の `checkAck`）が持つ。
//
// **返事は `seismo-ack <MAC>\n` の 1 行。** 宛名に MAC を書くのは、基板が受け取ったものを
// 自分宛てだと確かめられるようにするため（同じソケットへ別のものが届いても取り違えない）。
//
// **基板ごとに 1 秒に 1 回まで。** 基板は 1 秒に 10 前後のパケットを送るので、
// 1 件ずつ返すと LAN へ同じ数の返事を撒くことになる。基板が段を上げるのは 15 秒
// 返事が無いときなので、1 秒に 1 回で桁が 1 つ以上余る。
import type { DatagramReply } from './udpReceiver'

/** 返事の間隔。基板ごとに数える。 */
export const ACK_INTERVAL_MS = 1000

/**
 * 覚えておく基板の数の上限。
 *
 * **覚えが溢れても害は小さい** —— 忘れた基板には次の 1 件で返事が 1 つ余計に出るだけ。
 * 上限を置くのは、MAC を名乗るパケットを撃たれたときに覚えが際限なく増えないため
 * （速度の上限 `sourceRateLimit.ts` は送信元アドレスで数えるので、1 台から別々の MAC を
 * 名乗られると素通りする）。
 */
export const ACK_MAX_BOARDS = 256

export interface AckReplierOptions {
  /** 偽なら 1 つも返さない。**診断用**（基板が段を上げるかを実機で確かめる）。 */
  readonly enabled: boolean
  readonly intervalMs?: number
  readonly maxBoards?: number
}

export interface AckSnapshot {
  readonly enabled: boolean
  /** 返せた数。 */
  readonly sent: number
  /**
   * 返せなかった数。**増えたら基板のほうで段が上がり始める**（基板は返事の途絶と
   * 送信の失敗を区別できない）。
   */
  readonly failures: number
  /** 間隔の内側だったので返さなかった数。**多いのが正常**（1 秒に 10 件来て 1 件返す）。 */
  readonly throttled: number
  readonly lastError: string | null
}

export class AckReplier {
  readonly enabled: boolean
  private readonly intervalMs: number
  private readonly maxBoards: number
  /** MAC → 最後に返した時刻。**挿入順を新しさの順に保つ**（更新のたびに入れ直す）。 */
  private readonly lastSentMs = new Map<string, number>()
  private sentCount = 0
  private failureCount = 0
  private throttledCount = 0
  private lastErrorText: string | null = null

  constructor(options: AckReplierOptions) {
    this.enabled = options.enabled
    this.intervalMs = options.intervalMs ?? ACK_INTERVAL_MS
    this.maxBoards = options.maxBoards ?? ACK_MAX_BOARDS
  }

  /**
   * 読み取れたパケット 1 つについて、返すかどうかを決めて返す。**投げない。**
   *
   * 呼ぶのは**読み取りに成功し、送り手が返事を求めているとき**だけ
   * （`PacketParseResult` の `ackRequested`）。読めなかったものに返すと、
   * 基板は「届いた」と思い込んだまま壊れた形を送り続ける。
   *
   * @param mac 区切りなしの MAC（`BoardKey` の `mac:` の後ろ）。宛名として返事へ書く。
   */
  offer(mac: string, reply: DatagramReply, nowMs: number): void {
    if (!this.enabled) return
    const last = this.lastSentMs.get(mac)
    // **時計が戻ったら返す側へ倒す。** 引き算が負のまま間隔の内側と読むと、
    // 戻った幅だけ返事が止まり、基板が段を上げ始める。
    if (last !== undefined && nowMs >= last && nowMs - last < this.intervalMs) {
      this.throttledCount += 1
      return
    }
    // **返せなかった回も「返した」として間隔を数える。** 失敗した直後に次のパケットで
    // 撃ち直す形にすると、送れない状態（経路が無い・ソケットが閉じた）の間ずっと 1 秒に
    // 10 回ずつ失敗を積み、`failures` が基板の送信数に比例して膨らむ。基板は 15 秒で
    // 段を上げるので、1 秒に 1 回の再試行でも 15 回の機会がある。
    this.remember(mac, nowMs)
    try {
      reply(`seismo-ack ${mac}\n`, (error) => {
        if (error === null) {
          this.sentCount += 1
        } else {
          this.failureCount += 1
          this.lastErrorText = error.message
        }
      })
    } catch (error) {
      // **受信口の約束では投げない**（`udpReceiver.ts` の `replyTo`）。それでも投げたなら
      // 返せなかった 1 件として数える —— 外へ漏らすと、パケット 1 つの処理（震度・保存）が
      // 返事の都合で途中で止まる。
      this.failureCount += 1
      this.lastErrorText = error instanceof Error ? error.message : String(error)
    }
  }

  get failures(): number {
    return this.failureCount
  }

  snapshot(): AckSnapshot {
    return {
      enabled: this.enabled,
      sent: this.sentCount,
      failures: this.failureCount,
      throttled: this.throttledCount,
      lastError: this.lastErrorText,
    }
  }

  private remember(mac: string, nowMs: number): void {
    this.lastSentMs.delete(mac)
    if (this.lastSentMs.size >= this.maxBoards) {
      // いちばん古いものから捨てる。**間隔の外に出たものは覚えておく意味が無い**ので、
      // 溢れたときはまずそれらを、足りなければ間隔の内側でも古い順に捨てる。
      for (const [key, at] of this.lastSentMs) {
        if (this.lastSentMs.size < this.maxBoards) break
        if (nowMs - at >= this.intervalMs || nowMs < at) this.lastSentMs.delete(key)
      }
      while (this.lastSentMs.size >= this.maxBoards) {
        const oldest = this.lastSentMs.keys().next().value
        if (oldest === undefined) break
        this.lastSentMs.delete(oldest)
      }
    }
    this.lastSentMs.set(mac, nowMs)
  }
}

/**
 * `SEISMO_ACK` を読む。**`on` と `off` のほか（未設定・空を除く）は起動を止める。**
 *
 * 黙って既定へ倒すと、`SEISMO_ACK=of` と打ち間違えたまま返事が出続け、
 * 「止めたのに基板の段が上がらない」を基板の不具合として追いかけることになる
 * （`main.ts` の `readPort` と同じ判断）。
 */
export function readAckEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return true
  if (raw === 'on') return true
  if (raw === 'off') return false
  throw new Error(`SEISMO_ACK は on か off: ${raw}`)
}
