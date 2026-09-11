// 分割配信された二進電文（BUFR）の結合。現状の対象は IXAC41（推計震度分布図）だけ。
//
// 気象庁は 512KiB を超える電文をオクテット単位で分割して配信する。DMDATA では 2 報目以降に
// **分割報符号 `RRA`〜`RRX`**（WMO の遅延報の符号）が付き、API では `head.designation` に載る。
// 1 報目には付かない。実測では 1 報目がちょうど 511,900 バイトで、最大 24 断片まで有りうる。
//
// **完了の判定は BUFR 第0節が宣言する全長で行う。** DMDATA のドキュメントは「末尾に終端符号
// `7777` があるか」で判定する実装例を載せているが、そこには「受信順序などにより正しく動作
// しない場合があります」と自ら断りがある。全長は 1 報目の 5〜7 オクテットに入っているので、
// **順不同で届いても・断片が 3 つ以上でも**、揃ったかどうかを数で言い切れる。
//
// 実配信で観測できたのは 2 断片までだが、それを前提にした作りにはしない（`RRB` 以降が来た日に
// 静かに末尾を欠いた分布が出るのがいちばん困る）。
import { log } from '../utils/logger'
import { bufrDeclaredLength } from '../utils/bufrEstimatedIntensity'

/** 分割報符号を並び順の番号へ。1 報目（符号なし）が 0、`RRA` が 1、…、`RRX` が 24。 */
export function fragmentIndex(designation: string | null | undefined): number | null {
  if (designation === null || designation === undefined || designation === '') return 0
  const m = /^RR([A-X])$/.exec(designation)
  if (!m) return null
  return m[1].charCodeAt(0) - 'A'.charCodeAt(0) + 1
}

/** 揃わなかった断片を抱え続けないための時限。地震 1 回ぶんの配信が終わるには十分長い。 */
const DEFAULT_TTL_MS = 10 * 60 * 1000
/**
 * 同時に抱える電文の数の上限。1 電文が 1MB 近くなるので、無制限にすると
 * 断片が欠け続ける障害でメモリを食い潰す。
 */
const DEFAULT_MAX_GROUPS = 4

interface Group {
  parts: Map<number, Uint8Array>
  /** 1 報目が宣言する全長。1 報目が来るまでは null */
  total: number | null
  updatedAt: number
}

/**
 * 断片を貯めて、揃ったら結合したバイト列を返す入れ物。
 *
 * ライブ（WebSocket）・アーカイブ・当日経路で**それぞれ別のインスタンスを持つ**。取得元ごとに
 * 電文の到来の仕方が違い、混ぜると再生中にライブの断片が紛れ込む。
 */
export class BufrFragmentStore {
  private readonly groups = new Map<string, Group>()
  private readonly ttlMs: number
  private readonly maxGroups: number

  constructor(opts: { ttlMs?: number; maxGroups?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.maxGroups = opts.maxGroups ?? DEFAULT_MAX_GROUPS
  }

  /**
   * 断片を 1 つ足す。揃えば結合したバイト列を返し、その電文を忘れる。まだなら `null`。
   *
   * @param key 電文の識別名。DMDATA のドキュメントに倣い `種別 + 発表官署 + 発表時刻`
   * @param designation 分割報符号（1 報目は null）
   * @param nowMs 現在時刻。時限の判定に使う（テストから渡せるよう引数にしている）
   */
  add(key: string, designation: string | null | undefined, bytes: Uint8Array, nowMs: number): Uint8Array | null {
    this.sweep(nowMs)

    const index = fragmentIndex(designation)
    if (index === null) {
      // 符号の形が変わった＝分割の規約が変わった印。**その断片だけ捨てて残りを待つのではなく、
      // 電文ごと諦める**（どこに入る断片か分からないまま結合すると順序が狂う）。
      log.warn(`[bufr] 知らない分割報符号なので電文を捨てます designation=${String(designation)} key=${key}`)
      this.groups.delete(key)
      return null
    }

    let g = this.groups.get(key)
    if (!g) {
      if (this.groups.size >= this.maxGroups) {
        // いちばん古いものから落とす。断片が欠けたまま残っている電文が対象になる。
        const oldest = [...this.groups.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
        log.warn(`[bufr] 抱えている分割電文が上限（${this.maxGroups}）に達したので古いものを捨てます key=${oldest[0]}`)
        this.groups.delete(oldest[0])
      }
      g = { parts: new Map(), total: null, updatedAt: nowMs }
      this.groups.set(key, g)
    }
    g.updatedAt = nowMs
    g.parts.set(index, bytes)   // 同じ番号が二度来たら上書き（重複配信で二重に数えない）

    if (index === 0) {
      const total = bufrDeclaredLength(bytes)
      if (total === null) {
        log.warn(`[bufr] 1 報目が BUFR で始まっていないので電文を捨てます key=${key}`)
        this.groups.delete(key)
        return null
      }
      g.total = total
    }
    if (g.total === null) return null   // 1 報目がまだ

    // 0 から連続して揃っていて、合計が宣言全長に一致したら完成。
    let size = 0
    for (let i = 0; ; i++) {
      const part = g.parts.get(i)
      if (!part) return null
      size += part.length
      if (size > g.total) {
        log.warn(`[bufr] 断片の合計が宣言全長を超えました（宣言 ${g.total} / 合計 ${size}）。電文を捨てます key=${key}`)
        this.groups.delete(key)
        return null
      }
      if (size === g.total) {
        const out = new Uint8Array(g.total)
        let o = 0
        for (let j = 0; j <= i; j++) {
          const p = g.parts.get(j)!
          out.set(p, o)
          o += p.length
        }
        this.groups.delete(key)
        return out
      }
    }
  }

  /**
   * 時限を過ぎた電文を捨てる。揃わないまま残った断片はここでしか消えない。
   *
   * **`add()` からだけでなく外からも呼べるようにしてある。** IXAC41 は 13 か月で 28 通しか
   * 来ないので、`add()` の中でしか掃除しないと「次の分割電文が届くまで時限が働かない」
   * ——数週間後に、事象から遠く離れた時刻の警告が出ることになり、診断で見落とされる。
   * ライブ経路は ping のたびに呼んでいる（新しいタイマーを増やさずに済む）。
   */
  sweep(nowMs: number): void {
    for (const [key, g] of this.groups) {
      const ageMs = nowMs - g.updatedAt
      if (ageMs <= this.ttlMs) continue
      log.warn(
        `[bufr] 分割電文が揃わないまま時限を過ぎました（断片 ${g.parts.size} 個・`
        + `最後の受信から ${Math.round(ageMs / 60000)} 分）key=${key}`,
      )
      this.groups.delete(key)
    }
  }

  /** 再生の開始・リセットで呼ぶ。時間軸が変わると持ち越した断片は意味を失う。 */
  clear(): void { this.groups.clear() }

  /** テストと診断用。抱えている電文の数。 */
  get pendingCount(): number { return this.groups.size }

  /**
   * 揃わないまま残っている電文の識別名。**取得が終わったあとに確かめるため**にある。
   *
   * リプレイは 1 回きりのインスタンスを使い捨てるので、残った断片は誰にも見られずに
   * 消える。呼び出し側がここを見て取りこぼしとして数える。
   */
  get pendingKeys(): string[] { return [...this.groups.keys()] }
}

/** DMDATA のドキュメントに倣った電文の識別名（GTS 基準）。 */
export function fragmentKey(type: string, author: string, time: string): string {
  return `${type} ${author} ${time}`
}
