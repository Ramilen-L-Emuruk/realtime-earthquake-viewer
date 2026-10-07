// 基板へ「届いた」と返す。
//
// **基板は送る側なので、自分の送信が届いているかを自分では知れない。** ESP32 の
// `WiFiUDP` は Wi-Fi が切れて戻ったあと、ソケットが無効なまま `endPacket()` に成功を
// 返し続ける（2026-09-30 に 1 枚が 5 日間その状態だった）。基板が自分で立て直すには、
// 外から「届いている」と言ってもらう以外に手掛かりが無い。返事が途絶えたときの
// 段の上げ方は基板の側（`firmware/seismo-node/seismo-node.ino` の `checkAck`）が持つ。
//
// **返事は `seismo-ack <MAC>[ gap=<sid>:<seq>,…]\n` の 1 行。** 宛名に MAC を書くのは、
// 基板が受け取ったものを自分宛てだと確かめられるようにするため（同じソケットへ別のものが
// 届いても取り違えない）。
//
// **`gap=` は「この基板の分に、まだ取り戻せていない欠けがある」。** センサーごとに、いちばん古い
// 欠けの始まりの通し番号を並べる（`backlogBook.ts` の `pendingGapStarts`）。基板はこれを見て、
// 返事が途絶えていなくてもフラッシュへの書き出しを始める —— 返事がまばらに届く干渉では
// 途絶えの判定が立たず、取りに行く前にメモリの輪から消えていた（2026-10-06 の電子レンジ）。
// 欠けを知っているのはホストだけなので、こちらから言うしかない。
//
// **この形を読めるのは `gap=` を読むファーム（`seismo-node.ino` の `parseGapField` を持つ版）から。** それより前のファームは
// 行を 1 文字違わず照合するので、`gap=` 付きの行を自分宛てと読めず、返事が途絶えたと取り違える。
// 配るときは基板を先に焼く（新しいファームは `gap=` の無い行もそのまま読む）。
//
// **基板ごとに 1 秒に 1 回まで。** 基板は 1 秒に 10 前後のパケットを送るので、
// 1 件ずつ返すと LAN へ同じ数の返事を撒くことになる。基板が段を上げるのは 15 秒
// 返事が無いときなので、1 秒に 1 回で桁が 1 つ以上余る。
import type { GapStart } from './backlogBook'
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

/**
 * `gap=` に並べる数の上限。**基板の受け取りの入れ物（ファームの `ACK_LINE_MAX`）に収める。**
 * 基板 1 枚のセンサーは 3 個なので、ふだんは届かない。上限を置くのは、帳面に名乗りの
 * おかしなセンサーが積もっても、返事が入れ物からはみ出して読めなくならないようにするため。
 */
export const ACK_MAX_GAP_ENTRIES = 4

/**
 * `gap=` に載せてよい名前。**英数字・`-`・`_` 以外を含む名前は載せない**（区切りの ` ` `,` `:` を確実に外すため） —— 基板の
 * 読み取りが区切りを取り違えると、返事ごと読めなくなりうる。実機の名前は `i2c0-68` の形。
 */
const SENSOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/

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
  /** `sent` のうち `gap=` を載せて返せた数。**干渉の間に増えていれば、基板へ書き出しを頼めている。** */
  readonly withGaps: number
  /** 欠けを引き出せなかった回数（`gap=` 無しで返した）。**0 のままが正常。** */
  readonly gapLookupFailures: number
  /**
   * 名前や番号が載せられない形だったので `gap=` から外した欠けの数。**0 のままが正常** ——
   * 増えていたら、その基板の欠けは基板へ知らされていない（基板は途絶えの判定だけに頼る）。
   * 件数の上限（`ACK_MAX_GAP_ENTRIES`）で切った分は数えない（仕様どおりの打ち切り）。
   */
  readonly gapEntriesRejected: number
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
  private withGapsCount = 0
  private gapLookupFailureCount = 0
  private gapEntriesRejectedCount = 0
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
   * @param gapStarts その基板の取り戻し待ちの欠け（`BacklogBook.pendingGapStarts`）。
   *   **返すと決めた回にだけ呼ぶ** —— 1 秒に 10 件来るパケットごとに帳面を走査しない。
   *   投げたら `gap=` 無しで返す（返事を止めると基板が繋ぎ直しと再起動を始める）。
   */
  offer(mac: string, gapStarts: () => readonly GapStart[], reply: DatagramReply, nowMs: number): void {
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
    const gap = this.gapField(gapStarts)
    try {
      reply(`seismo-ack ${mac}${gap}\n`, (error) => {
        if (error === null) {
          this.sentCount += 1
          if (gap !== '') this.withGapsCount += 1
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
      withGaps: this.withGapsCount,
      gapLookupFailures: this.gapLookupFailureCount,
      gapEntriesRejected: this.gapEntriesRejectedCount,
      lastError: this.lastErrorText,
    }
  }

  /** 返事の末尾に付ける ` gap=…`。載せるものが無ければ空。**投げない。** */
  private gapField(gapStarts: () => readonly GapStart[]): string {
    let starts: readonly GapStart[]
    try {
      starts = gapStarts()
    } catch {
      this.gapLookupFailureCount += 1
      return ''
    }
    const entries: string[] = []
    // **載せられない形のものは数えてから飛ばす。** 件数の枠は載せられたものだけで数えるので、
    // 名前の壊れた欠けが本物のセンサーの枠を食うことはない。
    for (const s of starts) {
      if (entries.length >= ACK_MAX_GAP_ENTRIES) break
      if (!SENSOR_ID_PATTERN.test(s.sensorId)
          || !Number.isInteger(s.from) || s.from < 0 || s.from > 0xffff_ffff) {
        this.gapEntriesRejectedCount += 1
        continue
      }
      entries.push(`${s.sensorId}:${s.from}`)
    }
    return entries.length === 0 ? '' : ` gap=${entries.join(',')}`
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
