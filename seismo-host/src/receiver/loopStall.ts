// ホストの処理（Node のイベントループ）が止まった区間を測る。
//
// **止まっている間、ホストは何も書けない。** 2026-10-02 13:41 に ramsdesktop でホストが
// 約 45 秒止まったとき、ログには 1 行も残らず、毎分の集計が「直近 75 秒」と名乗ったことと
// 番号の飛びから逆算するしかなかった。止まった理由は外（同じ機械で起動した GPU を使う
// 道具）にあり、ホストの側では防げない —— だから**起きたことを、止まり明けに自分で書く。**
//
// **測り方。** 一定の間隔で刻みを置き、前の刻みからの実際の間隔が予定より長かった分を
// 「止まっていた時間」とする。刻みはイベントループが空いたときにしか走らないので、
// 遅れはそのままループが塞がっていた長さになる。
//
// **測るのは単調時計。** 壁時計で測ると、OS が時刻を合わせ直しただけで「止まった」に見える。
// 壁時計は「いつ明けたか」を書くためだけに受け取る。

/** 刻みの間隔。**閾値より十分短く、走らせても負荷にならない長さ。** */
export const LOOP_TICK_MS_DEFAULT = 250

/**
 * 止まったと数える遅れの下限。
 *
 * **ガベージコレクションの一時停止（数十 ms）や、毎分の集計の処理では越えない高さ。**
 * 一方で、UDP の受信バッファの既定（64 KB）は基板 3 枚の約 3 秒ぶんしか抱えられず、
 * 基板の返事の待ち（15 秒）も数秒の停止なら越えない —— 1 秒はその手前で気づける高さ。
 */
export const LOOP_STALL_THRESHOLD_MS_DEFAULT = 1000

/** 止まった区間 1 つ。 */
export interface LoopStallEvent {
  /** 止まり明けの壁時計（ミリ秒）。 */
  readonly endedAtMs: number
  /** 予定より遅れた長さ（ミリ秒）。 */
  readonly stalledMs: number
}

export interface LoopStallSnapshot {
  readonly thresholdMs: number
  /** 起動してから数えた区間の数。 */
  readonly count: number
  /** 止まっていた時間の累計（ミリ秒）。 */
  readonly totalMs: number
  /** いちばん長かった区間。**無ければ null**（0 は「0 ms 止まった」と読めてしまう）。 */
  readonly longestMs: number | null
  /** 最後の区間。無ければ null。 */
  readonly last: LoopStallEvent | null
}

export interface LoopStallBookOptions {
  readonly tickMs: number
  readonly thresholdMs: number
}

export class LoopStallBook {
  private readonly tickMs: number
  private readonly thresholdMs: number
  private prevMonoMs: number | null = null
  private count = 0
  private totalMs = 0
  private longestMs: number | null = null
  private last: LoopStallEvent | null = null

  constructor(options: LoopStallBookOptions) {
    this.tickMs = options.tickMs
    this.thresholdMs = options.thresholdMs
  }

  /**
   * 刻みが 1 つ走った。止まっていたなら、その区間を返す（呼び出し側がログへ出す）。
   *
   * `monoMs` は単調時計（`performance.now()`）、`wallMs` は壁時計（`Date.now()`）。
   *
   * **単調時計が読めない・戻ったときは測らず、そこを新しい起点にする。** 比べる相手を
   * 持ち越すと、戻った幅だけ次の刻みが「止まった」に化ける。
   */
  tick(monoMs: number, wallMs: number): LoopStallEvent | null {
    const prev = this.prevMonoMs
    if (!Number.isFinite(monoMs)) {
      this.prevMonoMs = null
      return null
    }
    this.prevMonoMs = monoMs
    if (prev === null || monoMs < prev) return null

    const stalledMs = monoMs - prev - this.tickMs
    if (stalledMs < this.thresholdMs) return null

    const event: LoopStallEvent = { endedAtMs: wallMs, stalledMs }
    this.count += 1
    this.totalMs += stalledMs
    this.longestMs = this.longestMs === null ? stalledMs : Math.max(this.longestMs, stalledMs)
    this.last = event
    return event
  }

  snapshot(): LoopStallSnapshot {
    return {
      thresholdMs: this.thresholdMs,
      count: this.count,
      totalMs: this.totalMs,
      longestMs: this.longestMs,
      last: this.last,
    }
  }
}
