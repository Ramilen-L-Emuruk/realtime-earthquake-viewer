// 同じことを繰り返し記録するのを間引く。
//
// **速度の上限を入れた時点で、記録のほうに穴が開く。** 落ちたパケット 1 つにつき 1 行
// 出す作りのままだと、上限いっぱいで撃たれたとき毎秒 25 行が流れて他の警告が埋もれ、
// 生データの保存先（4-3）も食う。
//
// **黙らせはしない。** 初回は必ず出し、以後も間隔ごとに出し続ける。抑えた件数は
// 出す行へ添えられるよう返すので、**行を読んだ人が件数を取り違えない。**
// 正確な数は `packetTally.ts` が持つ —— こちらが出すのは見本。
//
// **枠は種別ごとに分ける。** 1 つの鍵空間を全種別で分け合うと、送信元アドレスを含む
// 鍵（`read` 等・相手が決める値なので際限なく増える）が枠を食い尽くしたあとに初めて
// 起きた別種の異常（`close` ＝ 締めくくりの失敗）が、共有の溢れ先へ合流して
// **一度も出ないまま抑えられる**。いちばん注意が要る場面で、いちばん重要な報せが
// 黙ることになる。種別ごとに分ければ「その種別で初めて」は必ず出る。
//
// `src/utils/logger.ts` の `createLogThrottle` は流用しない。あちらはブラウザ側の資材で、
// 読み込むと Node で動く受け手の型検査へアプリのコードが入る（同じ穴を段 4-1 で
// `buildEventResultFromZip` から定数を取ろうとして踏んだ）。

import { MAX_STREAMS_DEFAULT } from '../timebase/segmenter'

/** 同じ鍵をもう一度出すまでの間隔。 */
const INTERVAL_MS_DEFAULT = 60_000

/**
 * 種別ごとに覚えていられる鍵の数。**`Segmenter` の流れの上限と揃える。**
 *
 * 鍵の細目（相手 × 理由）はパケットと送信元から来る＝こちらで決められない。
 */
const MAX_KEYS_PER_KIND_DEFAULT = MAX_STREAMS_DEFAULT

/** 上限に達したあとの細目をまとめる枠。**本物の細目と衝突しない**（NUL は入らない）。 */
const OVERFLOW_DETAIL = '\u0000overflow'

export interface LogThrottleOptions {
  readonly intervalMs?: number
  readonly maxKeysPerKind?: number
  /** 時計。テストのために差し替える。 */
  readonly now?: () => number
}

export interface LogDecision {
  /** 前回この鍵で出してから抑えた件数。0 なら 1 件も抑えていない。 */
  readonly suppressed: number
}

interface Entry {
  nextAtMs: number
  suppressed: number
}

export class LogThrottle {
  private readonly intervalMs: number
  private readonly maxKeysPerKind: number
  private readonly now: () => number
  private readonly kinds = new Map<string, Map<string, Entry>>()
  private lastMs = 0

  constructor(options: LogThrottleOptions = {}) {
    this.intervalMs = options.intervalMs ?? INTERVAL_MS_DEFAULT
    this.maxKeysPerKind = options.maxKeysPerKind ?? MAX_KEYS_PER_KIND_DEFAULT
    this.now = options.now ?? Date.now
  }

  /**
   * 出してよければ抑えた件数を添えて返す。抑えるなら null。
   *
   * `kind` は出来事の種類（`read` / `drop` / `close` ほか）、`detail` は同じ種類の中での
   * 区別（相手・理由）。**枠は `kind` ごとに分ける**ので、ある種別が溢れても別の種別の
   * 「初めて」は必ず出る。
   */
  shouldLog(kind: string, detail: string): LogDecision | null {
    // **時計が壊れても進んだことにしない。** 非有限の値を素通りさせると `NaN < nextAtMs` が
    // **偽**になり、以後その鍵は毎回そのまま出る ＝ **間引きが黙って効かなくなる**。
    // 上限いっぱいで撃たれている最中にこれが起きると、間引きを入れた意味がそこで消える。
    const raw = this.now()
    const now = Number.isFinite(raw) ? raw : this.lastMs
    this.lastMs = now

    const entry = this.entryOf(kind, detail, now)
    if (entry === null) return { suppressed: 0 }

    if (now < entry.nextAtMs) {
      entry.suppressed += 1
      return null
    }
    const decision: LogDecision = { suppressed: entry.suppressed }
    entry.suppressed = 0
    entry.nextAtMs = now + this.intervalMs
    return decision
  }

  /**
   * 枠を引く。初めて作ったときは `null`（＝そのまま出す）。
   *
   * **上限に達していたらその種別の共有枠へ倒す。古い鍵を捨てる形（LRU）にはしない** ——
   * 細目が入れ替わり続ける状況（送信元を詐称された・基板の名前が毎回違う）では、
   * 捨てた鍵が毎回「初めて」に戻って**1 件ごとに行が出る**。間引きたいのはまさに
   * その形なので、逆立ちする。共有枠なら、内訳は混ざるかわりに行の量は間隔ぶんで
   * 頭打ちになる。
   *
   * **溢れたあとは、その種別の新しい細目が最大で間隔 1 つぶん遅れて出る。** 種別ごとに
   * 分けてあるので「その種別で初めて」は即座に出るが、同じ種別の 2 つ目以降は共有枠の
   * 間隔に従う。件数そのものは `packetTally.ts` が常に正確に持つ。
   */
  private entryOf(kind: string, detail: string, now: number): Entry | null {
    let entries = this.kinds.get(kind)
    if (entries === undefined) {
      entries = new Map<string, Entry>()
      this.kinds.set(kind, entries)
    }
    const found = entries.get(detail)
    if (found !== undefined) return found
    const target = entries.size >= this.maxKeysPerKind ? OVERFLOW_DETAIL : detail
    const shared = entries.get(target)
    if (shared !== undefined) return shared
    entries.set(target, { nextAtMs: now + this.intervalMs, suppressed: 0 })
    return null
  }
}

/** 抑えた件数を行へ添える形。0 件なら何も添えない。 */
export function suppressedSuffix(decision: LogDecision): string {
  return decision.suppressed === 0 ? '' : `（同じものをほか ${decision.suppressed} 件）`
}
