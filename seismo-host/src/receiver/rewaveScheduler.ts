// 合成波形を作り直す区間を観測点ごとに覚え、作り直してよくなったら 1 件ずつ渡す。
//
// **いつ作り直すか。** 欠けを取り戻すたびに作り直すと、干渉が続いている間は同じ区間を何度も作り直す。
// そこで、取り戻した時刻の範囲を観測点ごとに広げておき、
// - その観測点の流れに欠けが 1 つも残っていない（取り戻したか諦めた）
// - 最後に取り戻してから {@link RewaveSchedulerOptions.settleMs} 経った
// の 2 つが揃ったら渡す。**欠けが片付かないまま長く続いたら**（{@link RewaveSchedulerOptions.maxWaitMs}）、
// そこまでの分で作り直す —— 欠けは最長 20 分諦めないので、待ち続けると画面へ戻すのがそれだけ遅れる。
//
// **1 件の長さには上限を置く**（{@link RewaveSchedulerOptions.maxSpanMs}）。長い区間を一度に作り直すと
// 生データを読む量も流す量も比例して増えるので、頭から区切って渡し、残りは次の回へ回す。

/** 作り直す 1 件。`[fromMs, toMs)` は控えへ書く区間（余白込み）。 */
export interface RewaveJob {
  readonly stationId: string
  readonly fromMs: number
  readonly toMs: number
}

export interface RewaveSchedulerOptions {
  /** 取り戻した範囲の前後へ足す余白。作り直した分とライブの分の継ぎ目を、欠けから離すため。 */
  readonly padMs: number
  /** 最後に取り戻してから待つ時間。続けて届く取り戻しを 1 件へまとめるため。 */
  readonly settleMs: number
  /** 欠けが片付かなくても、最初に取り戻してからこれだけ経ったら作り直す。 */
  readonly maxWaitMs: number
  /** 1 件の区間の長さの上限。超えたら頭から区切る。 */
  readonly maxSpanMs: number
}

interface Dirty {
  fromMs: number
  toMs: number
  readonly firstNoteMs: number
  lastNoteMs: number
}

export class RewaveScheduler {
  private readonly options: RewaveSchedulerOptions
  private readonly dirty = new Map<string, Dirty>()

  constructor(options: RewaveSchedulerOptions) {
    this.options = options
  }

  /** その観測点の `[fromMs, toMs)`（波形の時刻）を取り戻した。 */
  note(stationId: string, fromMs: number, toMs: number, nowMs: number): void {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return
    const d = this.dirty.get(stationId)
    if (d === undefined) {
      this.dirty.set(stationId, { fromMs, toMs, firstNoteMs: nowMs, lastNoteMs: nowMs })
      return
    }
    d.fromMs = Math.min(d.fromMs, fromMs)
    d.toMs = Math.max(d.toMs, toMs)
    d.lastNoteMs = nowMs
  }

  /**
   * いま作り直してよい 1 件。無ければ null。**渡した分は覚えから外す**（区切ったなら残りを残す）。
   *
   * `hasPending` はその観測点の流れにまだ欠けが残っているか（`BacklogBook.hasPendingWhere`）。
   * 最初に取り戻した順に見る。
   */
  take(nowMs: number, hasPending: (stationId: string) => boolean): RewaveJob | null {
    const { padMs, settleMs, maxWaitMs, maxSpanMs } = this.options
    const order = [...this.dirty.entries()].sort((a, b) => a[1].firstNoteMs - b[1].firstNoteMs)
    for (const [stationId, d] of order) {
      if (nowMs - d.lastNoteMs < settleMs) continue
      if (hasPending(stationId) && nowMs - d.firstNoteMs < maxWaitMs) continue
      const fromMs = d.fromMs - padMs
      const toMs = d.toMs + padMs
      if (toMs - fromMs <= maxSpanMs) {
        this.dirty.delete(stationId)
        return { stationId, fromMs, toMs }
      }
      // 頭から区切る。残りは余白を差し引いた形で覚え直す（次の回でまた余白を足す）。
      const cut = fromMs + maxSpanMs
      d.fromMs = cut + padMs
      return { stationId, fromMs, toMs: cut }
    }
    return null
  }

  /** 作り直しを待っている観測点の数。 */
  get waiting(): number {
    return this.dirty.size
  }
}
