// 取り戻した区間の知らせ（`station-wave-revised`）を受けて、波形の穴を `/waves` から埋める係（#597）。
//
// 受け手は 2 つある —— 下部の波形（{@link SeismoWaveRefiller}・`hooks/useSeismoStation.ts`）と、
// 有感の地震カード（`hooks/useSeismoQuakeWaves.ts`）。どちらも「同じ相手へは 1 本ずつ取りに行き、
// 最中に届いた知らせは範囲をまとめて取り終えてから取り直す」ので、その部分を {@link RangeCoalescer} に置く。
//
// **取りに行くのは、知らせの範囲に穴があるときだけ。** ホストは欠けを取り戻したら作り直して知らせてくるが、
// 下部の波形が抱えているのは直近 60 秒だけ（`hooks/useSeismoStation.ts` の `WAVE_RETAIN_SEC`）。作り直しが
// 終わる頃には、穴がもう窓の外へ流れていることがある —— そのときに取りに行っても書く場所が無い。

import type { SeismoStationWaveRevised } from './seismoStream'
import type { WaveSamplesResult } from './seismoWaveSamples'
import type { SeismoWaveBuffer } from '../utils/seismoWaveBuffer'

/** 取りに行く範囲 `[fromMs, toMs)`。 */
export interface RefillRange {
  readonly fromMs: number
  readonly toMs: number
}

/**
 * 鍵ごとに 1 本ずつ `run` を走らせ、走っている間に届いた範囲はまとめて次の 1 回にする。
 *
 * **捨てない。** 電子レンジの干渉のように欠けが細かく続くと、知らせも続けて届く。走っている最中の
 * 知らせを捨てると、その範囲は次の知らせが来るまで埋まらない。**並行して走らせない** —— 同じ相手へ
 * 同時に取りに行くと、ホストへ同じ範囲を重ねて訊くことになる。
 */
export class RangeCoalescer {
  private readonly pending = new Map<string, { fromMs: number; toMs: number }>()
  private readonly running = new Set<string>()

  /**
   * @param run 1 回ぶんを片付ける。**投げてよい**（次の範囲は続けて片付ける）。
   * @param signal 立った後は走らせない。
   * @param onError `run` が投げたとき（記録用）。
   */
  constructor(
    private readonly run: (key: string, range: RefillRange) => Promise<void>,
    private readonly signal: AbortSignal,
    private readonly onError: (key: string, error: unknown) => void,
  ) {}

  push(key: string, range: RefillRange): void {
    if (this.signal.aborted) return
    const cur = this.pending.get(key)
    if (cur === undefined) this.pending.set(key, { fromMs: range.fromMs, toMs: range.toMs })
    else {
      cur.fromMs = Math.min(cur.fromMs, range.fromMs)
      cur.toMs = Math.max(cur.toMs, range.toMs)
    }
    if (!this.running.has(key)) void this.drain(key)
  }

  private async drain(key: string): Promise<void> {
    this.running.add(key)
    try {
      for (;;) {
        if (this.signal.aborted) return
        const range = this.pending.get(key)
        if (range === undefined) return
        this.pending.delete(key)
        try {
          await this.run(key, range)
        } catch (error) {
          this.onError(key, error)
        }
      }
    } finally {
      this.running.delete(key)
    }
  }
}

/** 1 回ぶんの結果。0 件のときに原因を追えるよう、取った範囲とまとまりの数も渡す。 */
export interface SeismoWaveRefillResult {
  /** 抱えている区間の穴を埋めた数。 */
  readonly filled: number
  /** 最も古いサンプルの手前へ継ぎ足した数。 */
  readonly prepended: number
  /** 取った範囲 `[fromMs, toMs)`。 */
  readonly fromMs: number
  readonly toMs: number
  /** ホストが返したまとまりの数。 */
  readonly chunks: number
}

/**
 * 何もせずに終えた理由。
 *
 * - `no-buffer`: その観測点の波形をまだ 1 つも抱えていない（知らせが先に届いた）
 * - `nothing-to-do`: 範囲に穴も手前の空きも無い（正常）
 * - `restarted`: 取りに行っている間に入れ物が起点から作り直された。**取った値は書かない** —— 作り直しは
 *   それ自体が新しい起点で予約を入れるので、そちらに任せる。書くと、遠い過去の値との間を穴で埋めることになる
 */
export type SeismoWaveRefillSkip = 'no-buffer' | 'nothing-to-do' | 'restarted'

export interface SeismoWaveRefillerDeps {
  /** その観測点の入れ物。**抱えていなければ `null`**（その観測点の波形がまだ届いていない）。 */
  readonly bufferOf: (stationId: string) => SeismoWaveBuffer | null
  /** 区間 `[fromMs, toMs)` のサンプルを取る（`fetchSeismoWaveSamples` に接続先と `signal` を渡したもの）。 */
  readonly fetchSamples: (params: { stationId: string; fromMs: number; toMs: number }) => Promise<WaveSamplesResult>
  /** 繋ぎを切ったら立つ。**立った後は取りに行かない。** */
  readonly signal: AbortSignal
  /**
   * {@link SeismoWaveRefiller.schedule} の予約から取りに行くまで待つ時間。
   *
   * **待つ理由は 2 つ。** ホストは押し出しと同時に控えへ書くが、書き込みは非同期なので、届いた直後は
   * まだ読めないことがある（`seismo-host/src/receiver/waveArchive.ts`）。もう 1 つは、細かい穴が続けて
   * できたとき（電子レンジの干渉）に 1 回へまとめるため。
   */
  readonly delayMs: number
  /**
   * 1 回ぶんの結果（記録用）。`filled` は抱えている区間の穴を埋めた数、`prepended` は最も古いサンプルの
   * 手前へ継ぎ足した数。**どちらも 0 のときも呼ぶ** —— 取りに行ったのに埋まらなかったことも事後に追えるように。
   */
  readonly onFilled: (stationId: string, result: SeismoWaveRefillResult) => void
  /**
   * 取りに行かずに（または取った値を書かずに）終えた（記録用）。**正常に起きる理由も含む**ので、受け手は
   * 強い記録にしないこと。理由を分けて渡すのは、「取る物が無かった」と「入れ物が消えていた」を記録の上で
   * 見分けるため —— どちらも画面では「埋まらない」としか見えない。
   */
  readonly onSkipped: (stationId: string, reason: SeismoWaveRefillSkip) => void
  /** 取りに行く途中で投げた（こちらの不具合。記録用）。 */
  readonly onError: (stationId: string, error: unknown) => void
}

/**
 * 下部の波形の穴を埋め、空いていれば最も古いサンプルの手前へ継ぎ足す。**取る範囲は要る分だけ** ——
 * 知らせの範囲は作り直しの区間（前後に余白が付く）で、穴より広い。
 *
 * 入口は 2 つある。
 *
 * - {@link notice}: ホストが取り戻した区間を作り直した知らせ。**ホストの側で欠けた穴**はこれでしか埋まらない
 *   （作り直すまで控えにも無い）
 * - {@link schedule}: こちらで見つけた穴と、起点から作り直したときの手前の空き。**繋ぎ直しの間や、押し出しが
 *   遅い受け手のぶんを捨てた（`seismo-host/src/receiver/readingHub.ts`）間**は、ホストは受け取れているので
 *   作り直しも知らせも起きない。控えには最初からあるので、こちらから取りに行く（2026-10-07 ユーザー承認）
 */
export class SeismoWaveRefiller {
  private readonly runner: RangeCoalescer
  /** 予約して待っている範囲。**待っている間に届いた予約はここで束ねる。** */
  private readonly waiting = new Map<string, { range: { fromMs: number; toMs: number }; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly deps: SeismoWaveRefillerDeps) {
    this.runner = new RangeCoalescer((stationId, range) => this.refill(stationId, range), deps.signal, deps.onError)
    // **繋ぎを切ったら待っている予約も落とす。** 残すと、切った後に時計が 1 本ずつ発火する。
    deps.signal.addEventListener('abort', () => {
      for (const w of this.waiting.values()) clearTimeout(w.timer)
      this.waiting.clear()
    })
  }

  /** 作り直しの知らせを 1 件受ける。**待たない**（取りに行くのは裏で進める）。 */
  notice(revised: SeismoStationWaveRevised): void {
    // **知らせが受け持つのは、抱えている区間の穴だけ。** 最も古いサンプルより前で切る ——
    // 手前の空きを埋めるのは {@link schedule} の担当で、知らせの範囲まで広げて取りに行く理由が無い。
    const oldestMs = this.deps.bufferOf(revised.stationId)?.oldestSampleMs ?? null
    if (oldestMs === null) {
      this.deps.onSkipped(revised.stationId, 'no-buffer')
      return
    }
    this.runner.push(revised.stationId, { fromMs: Math.max(revised.fromMs, oldestMs), toMs: revised.toMs })
  }

  /**
   * `range` を {@link SeismoWaveRefillerDeps.delayMs} 待ってから片付ける。**待っている間の予約は束ねる。**
   *
   * 範囲が最も古いサンプルより前へ掛かっていれば、空きの分だけ手前を継ぎ足す（**長さは入れ物が抱える長さで
   * 決まる**。ここでは数値を持たない）。
   */
  schedule(stationId: string, range: RefillRange): void {
    if (this.deps.signal.aborted) return
    const found = this.waiting.get(stationId)
    if (found !== undefined) {
      found.range.fromMs = Math.min(found.range.fromMs, range.fromMs)
      found.range.toMs = Math.max(found.range.toMs, range.toMs)
      return
    }
    const entry = {
      range: { fromMs: range.fromMs, toMs: range.toMs },
      timer: setTimeout(() => {
        this.waiting.delete(stationId)
        this.runner.push(stationId, entry.range)
      }, this.deps.delayMs),
    }
    this.waiting.set(stationId, entry)
  }

  private async refill(stationId: string, range: RefillRange): Promise<void> {
    const before = this.deps.bufferOf(stationId)
    const oldestMs = before?.oldestSampleMs ?? null
    const restartsBefore = before?.tally.restarts ?? null
    if (before === null || oldestMs === null) {
      this.deps.onSkipped(stationId, 'no-buffer')
      return
    }
    // **手前の空き。** 範囲が最も古いサンプルより前へ掛かり、空きがあるときだけ。
    const prependFromMs = before.prependFromMs
    const headFromMs =
      prependFromMs !== null && range.fromMs < oldestMs ? Math.max(range.fromMs, prependFromMs) : null
    const holes = before.holesIn(range.fromMs, range.toMs)
    // **取る範囲は入れ物のいまの姿から決める。** 継ぎ足すときの終わりは呼び手の `range.toMs` ではなく、
    // 穴の終わりか最も古いサンプル —— 予約を束ねると範囲は広がるが、取りに行く分は要る分だけでよい。
    let fromMs: number
    let toMs: number
    if (headFromMs !== null) {
      fromMs = headFromMs
      toMs = holes?.toMs ?? oldestMs
    } else if (holes !== null) {
      fromMs = holes.fromMs
      toMs = holes.toMs
    } else {
      this.deps.onSkipped(stationId, 'nothing-to-do')
      return
    }
    const got = await this.deps.fetchSamples({ stationId, fromMs, toMs })
    // **失敗は取得の層が記録へ残す**（`seismoWaveSamples.ts` の `fail`）。ここでは次の予約・知らせを待つ ——
    // 同じ範囲を訊き直し続けると、ホストが落ちている間ずっと叩くことになる。
    if (got.kind !== 'ok' || this.deps.signal.aborted) return
    // **取りに行っている間に起点から作り直されていたら、書かない**（{@link SeismoWaveRefillSkip}）。
    // 作り直した回数で見分ける。**最も古いサンプルの時刻では見分けない** —— 抱える長さが埋まった後は、
    // 新しいまとまりが届くたびに古い側が押し出されてそこが動くので、ふだんの穴埋めまで見送ることになる。
    const buffer = this.deps.bufferOf(stationId)
    if (buffer === null || buffer !== before || buffer.tally.restarts !== restartsBefore) {
      this.deps.onSkipped(stationId, 'restarted')
      return
    }
    // **継ぎ足しを先に置く。** 継ぎ足しが置いた穴（控えにも無かった分）は同じ値では埋まらないので、
    // 順を入れ替えても結果は同じだが、埋める側が手前の穴を数えずに済む。
    const prepended = buffer.prepend(got.samples.chunks)
    const filled = buffer.fill(got.samples.chunks)
    this.deps.onFilled(stationId, { filled, prepended, fromMs, toMs, chunks: got.samples.chunks.length })
  }
}
