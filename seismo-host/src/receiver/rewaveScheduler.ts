// 合成波形を作り直す区間を観測点ごとに覚え、作り直してよくなったら 1 件ずつ渡す。
//
// **いつ作り直すか。** 取り戻した時刻の範囲を観測点ごとに広げておき、
// - 最後に取り戻してから {@link RewaveSchedulerOptions.settleMs} 経った（続けて届く取り戻しを 1 件へまとめる）
// - 取り戻しが続いて落ち着かなくても、最初に取り戻してから {@link RewaveSchedulerOptions.maxWaitMs} 経った
// のどちらかで渡す。
//
// **観測点にまだ欠けが残っていても待たない**（2026-10-07 ユーザー承認）。以前は欠けが全部片付く（取り戻したか
// 諦めた）まで最長 2 分待っていたが、電子レンジの干渉の最中は欠けが片付かず、合間に取り戻せた区間まで 1〜2 分
// 遅れた —— その間に PWA の下部の波形（直近 60 秒）から穴が流れ出て、作り直しの知らせが届いても埋まらなかった
// （2026-10-07 の電子レンジの試験。ホストのログでは 12:47:13 に欠け始め、作り直しは 12:49:20 と 12:51:21 の
// 2 回だけ —— 2 回目は最後の欠けを取り戻した 4 秒後に走っていたが、取り戻しそのものが基板へ繋がらず遅れていた）。欠けの残る区間を先に作り直しても困らない：作り直しは受け取った分と
// 取り戻した分の生データから組むのでライブの合成より劣らず、後でその欠けを取り戻せばその区間はまた作り直され、
// 控えは後から書いた作り直しを採る（`waveArchive.ts` の `resolveRevisions`）。
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
  /** 取り戻しが続いて落ち着かなくても、最初に取り戻してからこれだけ経ったら作り直す。 */
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
   * 最初に取り戻した順に見る。
   */
  take(nowMs: number): RewaveJob | null {
    const { padMs, settleMs, maxWaitMs, maxSpanMs } = this.options
    const order = [...this.dirty.entries()].sort((a, b) => a[1].firstNoteMs - b[1].firstNoteMs)
    for (const [stationId, d] of order) {
      if (nowMs - d.lastNoteMs < settleMs && nowMs - d.firstNoteMs < maxWaitMs) continue
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
