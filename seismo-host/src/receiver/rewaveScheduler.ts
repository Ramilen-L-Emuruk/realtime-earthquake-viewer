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
//
// **依頼された作り直し（`POST /api/rewave`）は別の列に積む**（{@link RewaveScheduler.request}）。取り戻しの分と
// 範囲を混ぜると、依頼の指定（ノイズ密度をいまの設定から取る）がふだんの欠けの作り直しまで及ぶ。
// **取り戻しの分を先に渡す** —— あちらはいま見ている下部の波形の穴を埋めるもので、待たせると穴が流れ出る。

/**
 * ノイズ密度（合成の重み）をどこから取るか。
 *
 * - `historical` —— 区間の当時の設定のまま（取り戻した区間の作り直しは必ずこれ）
 * - `current` —— いまの設定のノイズ密度を当時の設定へ重ねる（依頼されたときだけ。2026-10-11 ユーザー承認）
 */
export type RewaveNoiseDensitySource = 'historical' | 'current'

/**
 * 作り直す 1 件がどこから来たか。**結果を分けて数えるため**（`rewaveRunner.ts` の `RewaveSnapshot.requested`）——
 * 依頼の分が空振りしても、取り戻しの分の件数に紛れて見えなくなる。
 *
 * - `backlog` —— 取り戻した区間（ホストが自分で決める）
 * - `requested` —— `POST /api/rewave` で依頼された区間
 */
export type RewaveJobOrigin = 'backlog' | 'requested'

/** 作り直す 1 件。`[fromMs, toMs)` は控えへ書く区間（余白込み）。 */
export interface RewaveJob {
  readonly stationId: string
  readonly fromMs: number
  readonly toMs: number
  readonly noiseDensity: RewaveNoiseDensitySource
  readonly origin: RewaveJobOrigin
}

/** 依頼された範囲をどう割ったか（{@link planRequestedRewave}）。 */
export interface RequestedRewavePlan {
  /** 作り直す区間（時刻順・1 件は `maxSpanMs` 以下）。 */
  readonly spans: readonly { readonly fromMs: number; readonly toMs: number }[]
  /** 設定変更の前後で作り直せない長さの合計（ミリ秒）。 */
  readonly skippedMs: number
}

/**
 * 依頼された `[fromMs, toMs)` を、作り直せる区間に割る。**純関数。**
 *
 * **設定変更の位置で先に割る。** 作り直しは助走（`leadMs`）から後ろの余白（`tailMs`）まで同じ設定で
 * なければ組めない（`rewaveRunner.ts` が `config-changed` で飛ばす）。決まった幅で区切ってから流すと、
 * 変更を含む区切りが丸ごと飛ぶ（10/10 08:36〜10:29 は 23 回の変更で 2 時間のうち 40 分ほどが残る計算だった）。
 * 変更の直後 `leadMs` と直前 `tailMs` だけを避ければ、残るのはそこだけになる。
 *
 * `changeTimes` は設定の中身が変わった時刻（`StationStore.changeTimes`）。範囲の外のものも渡してよい
 * （範囲の手前の変更でも、助走に掛かれば効く）。
 */
export function planRequestedRewave(input: {
  readonly fromMs: number
  readonly toMs: number
  readonly changeTimes: readonly number[]
  readonly leadMs: number
  readonly tailMs: number
  readonly maxSpanMs: number
}): RequestedRewavePlan {
  const { fromMs, toMs, leadMs, tailMs, maxSpanMs } = input
  if (!(toMs > fromMs) || !(maxSpanMs > 0)) return { spans: [], skippedMs: 0 }
  const changes = [...input.changeTimes].filter(Number.isFinite).sort((a, b) => a - b)
  const spans: { fromMs: number; toMs: number }[] = []
  let covered = 0
  // 設定が同じ区間ごとに、助走と余白の取れる部分だけを残す。
  const bounds = [Number.NEGATIVE_INFINITY, ...changes, Number.POSITIVE_INFINITY]
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = Math.max(fromMs, bounds[i]! + leadMs)
    const b = Math.min(toMs, bounds[i + 1]! - tailMs)
    for (let s = a; s < b; s += maxSpanMs) {
      const e = Math.min(b, s + maxSpanMs)
      spans.push({ fromMs: s, toMs: e })
      covered += e - s
    }
  }
  return { spans, skippedMs: toMs - fromMs - covered }
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
  /** 依頼された作り直し（時刻順）。取り戻しの分が無いときに 1 件ずつ渡す。 */
  private readonly requested: RewaveJob[] = []

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
        return { stationId, fromMs, toMs, noiseDensity: 'historical', origin: 'backlog' }
      }
      // 頭から区切る。残りは余白を差し引いた形で覚え直す（次の回でまた余白を足す）。
      const cut = fromMs + maxSpanMs
      d.fromMs = cut + padMs
      return { stationId, fromMs, toMs: cut, noiseDensity: 'historical', origin: 'backlog' }
    }
    return this.requested.shift() ?? null
  }

  /**
   * 依頼された作り直しを積む（区間は {@link planRequestedRewave} で割ったもの）。**前の依頼が残っていれば
   * 積まずに `false`** —— 同じ範囲を 2 度送ってしまったときに、同じ作り直しを二重に回さないため。
   *
   * **メモリにしか持たない。** ホストを止めると、まだ回していない分は消える（止める側が残りの件数を記録へ出す）。
   * 作り直さなかった区間（理由は `rewaveRunner.ts` の `RewaveSkipReason`）も積み直さない。
   */
  request(stationId: string, spans: RequestedRewavePlan['spans'], noiseDensity: RewaveNoiseDensitySource): boolean {
    if (this.requested.length > 0) return false
    for (const s of spans) {
      this.requested.push({ stationId, fromMs: s.fromMs, toMs: s.toMs, noiseDensity, origin: 'requested' })
    }
    return true
  }

  /** 作り直しを待っている観測点の数（取り戻しの分）。 */
  get waiting(): number {
    return this.dirty.size
  }

  /** 依頼された作り直しのうち、まだ渡していない件数。 */
  get requestedWaiting(): number {
    return this.requested.length
  }
}
