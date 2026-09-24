// 送信元アドレスごとに、受け取るパケットの速度へ上限を掛ける。
//
// **止まるのは「壊れた送り手が同じアドレスから撃ち続ける」形だけ。** UDP の送信元
// アドレスは詐称できるので、これは悪意ある相手を止める仕組みではない。名前や MAC の
// 許可制にしないのも同じ理由 —— 設置のたびに書き換える運用になるのに、詐称した相手を
// 止める役には立たない。**守っているのは「1 つの送り手の暴走で受け手全体が潰れないこと」。**
//
// 1 台あたり毎秒 2.5 パケット（100 Hz・40 サンプル）なので、既定は桁で余裕を取る。
// 実機で詰め直せるよう、上限も瞬間の余裕も引数にしてある。
//
// **読み取りより前に掛ける。** あとに置くと、落とすと決めたパケットの JSON を
// 先に読むことになり、いちばん抑えたい場面で仕事が減らない。

import { MAX_STREAMS_DEFAULT } from '../timebase/segmenter'

/** 1 秒あたりに通す件数。1 台 2.5 件/秒に対して 10 倍。 */
const PER_SECOND_DEFAULT = 25

/** 瞬間に許す件数。**上限の 2 秒ぶん。** 詰まって届いたまとまりを弾かないための余裕。 */
const BURST_DEFAULT = 50

/**
 * 覚えていられる送信元の数。
 *
 * **`Segmenter` の流れの上限をそのまま読む。** 1 台につき 1 つの枠、が大きさの根拠。
 */
const MAX_SOURCES_DEFAULT = MAX_STREAMS_DEFAULT

export interface SourceRateLimitOptions {
  readonly perSecond?: number
  readonly burst?: number
  readonly maxSources?: number
  /** 時計。テストのために差し替える。 */
  readonly now?: () => number
}

interface Bucket {
  tokens: number
  lastMs: number
}

export class SourceRateLimit {
  private readonly perSecond: number
  private readonly burst: number
  private readonly maxSources: number
  private readonly now: () => number
  private readonly buckets = new Map<string, Bucket>()
  private evicted = 0

  constructor(options: SourceRateLimitOptions = {}) {
    this.perSecond = options.perSecond ?? PER_SECOND_DEFAULT
    this.burst = options.burst ?? BURST_DEFAULT
    this.maxSources = options.maxSources ?? MAX_SOURCES_DEFAULT
    this.now = options.now ?? Date.now
  }

  /**
   * 枠を捨てた回数。
   *
   * **送信元を詐称されるとこの数だけが動く。** 1 つずつ違うアドレスから撃たれると、
   * どの枠も満杯のまま使われるので上限には一度も掛からない。**上限の件数が 0 のまま
   * ここだけ増えている**のが、その形の唯一の手掛かりになる。
   */
  get evictions(): number {
    return this.evicted
  }

  /** いま覚えている送信元の数。 */
  get size(): number {
    return this.buckets.size
  }

  /** 通してよければ true。落とすなら false。 */
  allow(source: string): boolean {
    const now = this.now()
    const bucket = this.take(source, now)

    // **時計が戻っても減らさない。** 引き算をそのまま使うと、時刻合わせで戻った分だけ
    // トークンが減って、正常な送り手をしばらく落とすことになる。
    //
    // **非有限の値は素通りさせない。** 残量が `NaN` になると `NaN < 1` が**偽**なので、
    // 以後その送信元は一度も落ちなくなる —— **上限そのものが黙って効かなくなる**。
    // 残量は有限に見えないだけで例外も記録も出ないため、気づく手立てが無い。
    // `lastMs` にも同じ手当てが要る。汚すと時計が戻ったあとも引き算が `NaN` のままになる。
    const elapsed = Number.isFinite(now) ? Math.max(0, now - bucket.lastMs) : 0
    bucket.lastMs = Number.isFinite(now) ? now : bucket.lastMs
    bucket.tokens = Math.min(this.burst, bucket.tokens + (elapsed / 1000) * this.perSecond)

    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  /**
   * 枠を引く。**満杯なら最も古い枠を捨てる。**
   *
   * `packetTally.ts` は逆に「その他」へ合算する。あちらが守るのは合計の正しさで、
   * こちらが守るのは**正規の基板を落とさないこと** —— 新しい相手を断る作りにすると、
   * 詐称した相手で枠を埋めるだけで本物の基板を締め出せてしまう。捨てた側に起きるのは
   * 「その相手への上限が緩む」ことだけで、落とす側へは倒れない。
   */
  private take(source: string, now: number): Bucket {
    const found = this.buckets.get(source)
    if (found !== undefined) {
      // 使った順に並べ直す（`Map` は入れた順を保つので、先頭が最も古い）。
      this.buckets.delete(source)
      this.buckets.set(source, found)
      return found
    }
    while (this.buckets.size >= this.maxSources) {
      const oldest = this.buckets.keys().next()
      if (oldest.done === true) break
      this.buckets.delete(oldest.value)
      this.evicted += 1
    }
    const created: Bucket = { tokens: this.burst, lastMs: Number.isFinite(now) ? now : 0 }
    this.buckets.set(source, created)
    return created
  }
}
