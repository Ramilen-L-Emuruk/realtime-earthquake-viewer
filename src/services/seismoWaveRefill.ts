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

export interface SeismoWaveRefillerDeps {
  /** その観測点の入れ物。**抱えていなければ `null`**（その観測点の波形がまだ届いていない）。 */
  readonly bufferOf: (stationId: string) => SeismoWaveBuffer | null
  /** 区間 `[fromMs, toMs)` のサンプルを取る（`fetchSeismoWaveSamples` に接続先と `signal` を渡したもの）。 */
  readonly fetchSamples: (params: { stationId: string; fromMs: number; toMs: number }) => Promise<WaveSamplesResult>
  /** 繋ぎを切ったら立つ。**立った後は取りに行かない。** */
  readonly signal: AbortSignal
  /** 埋めた数（記録用）。0 のときも呼ぶ —— 取りに行ったのに埋まらなかったことも事後に追えるように。 */
  readonly onFilled: (stationId: string, filled: number) => void
  /** 取りに行く途中で投げた（こちらの不具合。記録用）。 */
  readonly onError: (stationId: string, error: unknown) => void
}

/**
 * 下部の波形の穴を埋める。**取る範囲は穴の範囲だけ** —— 知らせの範囲は作り直しの区間（前後に余白が付く）で、
 * 穴より広い。
 */
export class SeismoWaveRefiller {
  private readonly runner: RangeCoalescer

  constructor(private readonly deps: SeismoWaveRefillerDeps) {
    this.runner = new RangeCoalescer((stationId, range) => this.refill(stationId, range), deps.signal, deps.onError)
  }

  /** 作り直しの知らせを 1 件受ける。**待たない**（取りに行くのは裏で進める）。 */
  notice(revised: SeismoStationWaveRevised): void {
    this.runner.push(revised.stationId, revised)
  }

  private async refill(stationId: string, range: RefillRange): Promise<void> {
    const holes = this.deps.bufferOf(stationId)?.holesIn(range.fromMs, range.toMs) ?? null
    if (holes === null) return
    const got = await this.deps.fetchSamples({ stationId, fromMs: holes.fromMs, toMs: holes.toMs })
    // **失敗は取得の層が記録へ残す**（`seismoWaveSamples.ts` の `fail`）。ここでは次の知らせを待つ ——
    // 同じ範囲を訊き直し続けると、ホストが落ちている間ずっと叩くことになる。
    if (got.kind !== 'ok' || this.deps.signal.aborted) return
    // **取りに行っている間に入れ物が作り直されていることがある**（時刻の飛び・繋ぎ直し）。
    // 引き直してから書く。時刻で突き合わせるので、別の起点の入れ物へ書いても位置はずれない。
    const buffer = this.deps.bufferOf(stationId)
    if (buffer === null) return
    this.deps.onFilled(stationId, buffer.fill(got.samples.chunks))
  }
}
