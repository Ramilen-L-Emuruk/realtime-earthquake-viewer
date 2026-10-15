// 公開観測点 1 点ぶんの波形を抱える入れ物（`docs/public-waveform-design.md` §5.3・§5.4）。
//
// **成分ごとに時刻の格子へ置く。** SeedLink は成分ごとに別のレコード（約 21 秒ぶん）で届き、届く時刻も成分ごとにずれる
// （右端が成分ごとに違う長さで伸びるのは許す。§0）。自作地震計の入れ物（`seismoWaveBuffer.ts`）は 3 成分が揃って届く
// 前提なので使わない。サンプルの番号は `round(時刻 / 刻み)` で、同じ時刻のサンプルは成分をまたいで同じ番号になる。
//
// **値は速度（μm/s）**（縦軸は速度のまま。§0）。カウントを感度（カウント/(m/s)）で割り、10⁶ 倍する。**直流は読み出すときに
// 窓の平均を引く**（置くときに引くと、窓の端で値が跳ぶ）。
//
// **「まだ届いていない」と「欠けている」を分ける**（§5.3）。どちらも `NaN` だが、まだ届いていない分は最後のサンプルより右に
// しか無いので、描く側は何も描かずに済む。届いたサンプルどうしの間の穴は線を切る。

import type { SeismoWaveWindow } from './seismoWaveBuffer'
import type { PublicChannelCode } from './publicStations'

/** 成分 → 段の並び（東・北・上。自作地震計の `AXIS_LABELS` と揃える）。 */
const AXIS_OF: Readonly<Record<PublicChannelCode, 0 | 1 | 2>> = { BHE: 0, BHN: 1, BHZ: 2 }

/**
 * 裏付けの本数として渡す値。**公開観測点は合成ではない**（1 台の広帯域地震計）ので、「裏付けが 1 本しか無い」として
 * 薄く塗る自作地震計の考え方は当てはまらない（§5.4）。描く側の判定（1 以下を塗る）に掛からない値を渡す。
 */
export const PUBLIC_MEMBER_COUNT = Number.POSITIVE_INFINITY

export type PublicPushResult =
  | { readonly kind: 'ok'; readonly samples: number }
  /** 採取率がこの入れ物の刻みと違う（置かない）。 */
  | { readonly kind: 'rate-mismatch'; readonly sampleRate: number }
  /** 全部が抱える範囲より古い（置かない）。 */
  | { readonly kind: 'too-old' }
  /** 値が使えない（採取率・時刻・感度が数でない）。 */
  | { readonly kind: 'invalid' }

interface ChannelRing {
  readonly values: Float32Array
  /** そのスロットに置いたサンプルの番号。置いていなければ `NaN`。 */
  readonly index: Float64Array
}

export class PublicWaveBuffer {
  private msPerSample: number | null = null
  private capacity = 0
  private rings: ChannelRing[] | null = null
  /** いちばん新しく置いたサンプルの番号（成分をまたいで）。 */
  private head = Number.NEGATIVE_INFINITY
  /** いちばん古く置いたサンプルの番号（成分をまたいで）。窓の頭はここから（抱えられる長さの端ではない）。 */
  private earliest = Number.POSITIVE_INFINITY

  constructor(private readonly retainSec: number) {}

  /** 1 成分ぶんのレコードを置く。 */
  push(channel: PublicChannelCode, startMs: number, sampleRate: number, counts: ArrayLike<number>, sensitivity: number): PublicPushResult {
    if (!Number.isFinite(startMs) || !(sampleRate > 0) || !Number.isFinite(sampleRate) || !(sensitivity > 0)) return { kind: 'invalid' }
    const ms = 1000 / sampleRate
    if (this.msPerSample === null || this.rings === null) {
      this.msPerSample = ms
      this.capacity = Math.ceil((this.retainSec * 1000) / ms) + 1
      this.rings = [0, 1, 2].map(() => ({
        values: new Float32Array(this.capacity).fill(Number.NaN),
        index: new Float64Array(this.capacity).fill(Number.NaN),
      }))
    } else if (Math.abs(ms - this.msPerSample) > 1e-6 * this.msPerSample) {
      return { kind: 'rate-mismatch', sampleRate }
    }
    const ring = this.rings[AXIS_OF[channel]]
    const first = Math.round(startMs / this.msPerSample)
    const last = first + counts.length - 1
    const newHead = Math.max(this.head, last)
    if (last <= newHead - this.capacity) return { kind: 'too-old' }
    const scale = 1e6 / sensitivity
    let placed = 0
    for (let i = 0; i < counts.length; i += 1) {
      const idx = first + i
      if (idx <= newHead - this.capacity) continue
      const slot = ((idx % this.capacity) + this.capacity) % this.capacity
      ring.values[slot] = counts[i] * scale
      ring.index[slot] = idx
      placed += 1
      if (idx < this.earliest) this.earliest = idx
    }
    this.head = newHead
    return { kind: 'ok', samples: placed }
  }

  /** いちばん新しいサンプルの時刻（成分をまたいで）。1 つも無ければ `null`。 */
  lastSampleMs(): number | null {
    if (this.msPerSample === null || !Number.isFinite(this.head)) return null
    return this.head * this.msPerSample
  }

  /**
   * `untilMs` 以前で、いずれかの成分に値のあるいちばん新しいサンプルの時刻。無ければ `null`。
   * 再生中の途絶の判定に使う（先取りした分が再生時刻より先まで入っているので、{@link lastSampleMs} では測れない）。
   */
  lastFiniteSampleMs(untilMs: number): number | null {
    const ms = this.msPerSample
    const rings = this.rings
    if (ms === null || rings === null || !Number.isFinite(this.head) || !Number.isFinite(untilMs)) return null
    const oldest = Math.max(this.head - this.capacity + 1, this.earliest)
    for (let idx = Math.min(this.head, Math.floor(untilMs / ms)); idx >= oldest; idx -= 1) {
      const slot = ((idx % this.capacity) + this.capacity) % this.capacity
      for (const ring of rings) if (ring.index[slot] === idx && Number.isFinite(ring.values[slot])) return idx * ms
    }
    return null
  }

  /**
   * 抱えているぶんを時刻の昇順に返す（`fromMs` より前は写さない。`null` なら全部）。**各成分から窓の平均を引く。**
   * `untilMs` を渡すとそれより後は写さない（再生中は先取りした分が再生時刻より先まで入っているため）。
   * 1 つも無ければ `null`。
   */
  snapshot(
    fromMs: number | null,
    options: { readonly removeMean: boolean; readonly untilMs?: number } = { removeMean: true },
  ): SeismoWaveWindow | null {
    const ms = this.msPerSample
    const rings = this.rings
    if (ms === null || rings === null || !Number.isFinite(this.head)) return null
    const oldest = Math.max(this.head - this.capacity + 1, this.earliest)
    const from = fromMs === null || !Number.isFinite(fromMs) ? oldest : Math.max(oldest, Math.ceil(fromMs / ms))
    const last = options.untilMs === undefined || !Number.isFinite(options.untilMs) ? this.head : Math.min(this.head, Math.floor(options.untilMs / ms))
    const count = last - from + 1
    if (count <= 0) return null
    const gal: [Float32Array, Float32Array, Float32Array] = [new Float32Array(count), new Float32Array(count), new Float32Array(count)]
    for (let a = 0; a < 3; a += 1) {
      const ring = rings[a]
      const out = gal[a]
      let sum = 0
      let n = 0
      for (let i = 0; i < count; i += 1) {
        const idx = from + i
        const slot = ((idx % this.capacity) + this.capacity) % this.capacity
        const v = ring.index[slot] === idx ? ring.values[slot] : Number.NaN
        out[i] = v
        if (Number.isFinite(v)) {
          sum += v
          n += 1
        }
      }
      // 平均を引かないのは、別の窓と継いでから 1 回だけ引く呼び出し（地震カードの継ぎ足し）。別々に引くと継ぎ目で段差が出る
      if (n > 0 && options.removeMean) {
        const mean = sum / n
        for (let i = 0; i < count; i += 1) out[i] -= mean
      }
    }
    return {
      firstSampleMs: from * ms,
      msPerSample: ms,
      gal,
      memberCount: new Float32Array(count).fill(PUBLIC_MEMBER_COUNT),
    }
  }
}
