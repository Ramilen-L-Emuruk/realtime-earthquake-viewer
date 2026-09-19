// 分割配信された二進電文（BUFR）の結合。対象は推計震度分布図の 2 種（IXAC41・IXAC40）。
//
// 気象庁は大きな電文をオクテット単位で分割して配信する。API では分割の符号が
// `head.designation` に載るが、**2 種で体系が違う。**
//
// | 種別 | 符号 | 1 報目 |
// |---|---|---|
// | IXAC41 | `RRA`〜`RRX`（WMO の遅延報） | **符号が付かない** |
// | IXAC40 | `PAA`・`PAB`・`PZC` …（WMO のセグメント） | **符号が付く**（`PAA`） |
//
// IXAC41 は実測で 1 報目がちょうど 511,900 バイト（512KiB 境界）で、最大 24 断片まで有りうる。
// IXAC40 は 1 電文あたりの上限がもっと小さく（技術情報 第172 号）、実測 31KB が 3 断片で届く。
//
// **完了の判定は BUFR 第0節が宣言する全長で行う。** DMDATA のドキュメントは「末尾に終端符号
// `7777` があるか」で判定する実装例を載せているが、そこには「受信順序などにより正しく動作
// しない場合があります」と自ら断りがある。全長は 1 報目の 5〜7 オクテットに入っているので、
// **順不同で届いても・断片が 3 つ以上でも**、揃ったかどうかを数で言い切れる。
//
// IXAC41 で実配信で観測できたのは 2 断片までだが、それを前提にした作りにはしない
// （`RRB` 以降が来た日に静かに末尾を欠いた分布が出るのがいちばん困る）。
import { log } from '../utils/logger'
import { bufrDeclaredLength } from '../utils/bufrEstimatedIntensity'

/**
 * 分割の符号を並び順の番号へ。**どちらの体系でも、BUFR ヘッダを持つ断片が 0 になる。**
 * `BufrFragmentStore` が `index === 0` で全長を読むので、ここが揃っていないと完了を判定できない。
 *
 * - IXAC41（遅延報）: 符号なしが 0、`RRA` が 1、…、`RRX` が 24
 * - IXAC40（セグメント）: `PAA` が 0、`PAB` が 1、`PZC` が 2、…
 *
 * **セグメント符号の順序を決めるのは 3 文字目だけ。** 2 文字目は最終セグメントの印と見ている
 * （実配信の 2 セットがどちらも `PAA` → `PAB` → `PZC` で、3 番目だけ `Z` を名乗る）が、
 * **WMO の規約そのものは確かめていない。** 順序を取り違えても結合後の BUFR が全長・終端
 * （`7777`）の検査で弾かれるので、誤った分布が画面に出ることはない。
 * **2 文字目が `A`・`Z` 以外なら記録する** —— この読みが違っていたことに気づける場所が他に無い。
 */
/** セグメント符号（IXAC40 の体系）。順序は 3 文字目、2 文字目は最終セグメントの印と見ている。 */
const SEGMENT_DESIGNATION = /^P([A-Z])([A-Z])$/

/**
 * セグメント符号かどうか。
 *
 * **使い道は「見出しが見つからなかったときに記録するか」の判定だけ**（`stripWmoHeading`）。
 * 剥がすかどうかを決めているのはバイト列の書式で、ここではない。この体系の断片は全部に
 * WMO の見出しが付くので、無いのは配信の形が変わった印になる。
 */
function isSegmentDesignation(d: string | null | undefined): boolean {
  return typeof d === 'string' && SEGMENT_DESIGNATION.test(d)
}

export function fragmentIndex(designation: string | null | undefined): number | null {
  if (designation === null || designation === undefined || designation === '') return 0
  const delayed = /^RR([A-X])$/.exec(designation)
  if (delayed) return delayed[1].charCodeAt(0) - 'A'.charCodeAt(0) + 1
  const segment = SEGMENT_DESIGNATION.exec(designation)
  if (segment) {
    if (segment[1] !== 'A' && segment[1] !== 'Z') {
      log.warn(`[bufr] セグメント符号の 2 文字目が想定外です designation=${designation}（順序は 3 文字目で決めます）`)
    }
    return segment[2].charCodeAt(0) - 'A'.charCodeAt(0)
  }
  return null
}

/**
 * WMO の見出し（`IXAC40 RJTD 211614 PAA`）。**種別で配信の形が違う。**
 *
 * | 種別 | 本体の先頭 |
 * |---|---|
 * | IXAC41 | `BUFR` から始まる（DMDATA が見出しを `head.designation` へ出す） |
 * | IXAC40 | **見出しを含んだまま届く**（実測 22 バイト。全断片に付く） |
 *
 * 結合の完了判定は 1 報目が宣言する全長に依るので、**剥がさないと「BUFR で始まっていない」で
 * 電文ごと捨てる**。実際に IXAC40 を扱い始めた最初の実機確認がこれで落ちた。
 *
 * 書式は WMO No.386 の `TTAAii CCCC YYGGgg BBB`（分割されていなければ `BBB` が無い）。
 */
const WMO_HEADING = /^([A-Z]{4}\d{2} [A-Z]{4} \d{6}(?: ([A-Z]{3}))?)/

/** 見出しを探す範囲（オクテット）。実測 22 で、書式どおりなら最長 22。余裕を見て倍。 */
const HEADING_SCAN_BYTES = 44

function startsWithBufr(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x42 && b[1] === 0x55 && b[2] === 0x46 && b[3] === 0x52
}

/**
 * WMO の見出しを落として、BUFR 本体の先頭へ揃える。見出しが無ければそのまま返す。
 *
 * **2 報目以降も見出しを持つ**（IXAC40 は全断片に付く）。2 報目は `BUFR` で始まらないので、
 * 「`BUFR` を探す」方式では剥がせない —— 書式で見分ける。
 *
 * **見出しの分割符号が `designation` と一致することも確かめる。** 二進データの中身が偶然
 * この書式に見えることは実質ないが、符号まで揃う確率はさらに低い。ここを緩めると、
 * **本体の先頭 22 バイトを黙って削った電文**を読もうとして「それらしい値」が出る。
 *
 * **剥がさずに返す 3 経路のうち、記録するのは 2 つ。**
 *
 * | 経路 | 記録 | 理由 |
 * |---|---|---|
 * | `BUFR` で始まる | しない | IXAC41 の正常な形 |
 * | 書式に合わない | **セグメント符号のときだけする** | IXAC41 の継続断片（`RRA` 等）は見出しを持たないので、無条件に鳴らすと**正常な分割配信のたびに警告が出る**。IXAC40 は全断片に付く前提なので、そこで無いのは配信の形が変わった印 |
 * | 符号が `designation` と食い違う | する | どちらの体系でも異常 |
 */
export function stripWmoHeading(bytes: Uint8Array, designation: string | null | undefined): Uint8Array {
  if (startsWithBufr(bytes)) return bytes
  let head = ''
  for (let i = 0; i < Math.min(HEADING_SCAN_BYTES, bytes.length); i++) head += String.fromCharCode(bytes[i])
  const m = WMO_HEADING.exec(head)
  if (!m) {
    if (isSegmentDesignation(designation)) {
      // 剥がせないまま進むと、1 報目なら「BUFR で始まっていない」で捨てられ、継続断片なら
      // 見出しのぶんだけ合計が膨らんで「宣言全長を超えました」になる。**どちらも根本原因を
      // 名指ししない**ので、ここで印を残す。
      log.warn(`[bufr] セグメント断片に WMO の見出しが見つかりません designation=${designation}（剥がさずに進めます）`)
    }
    return bytes
  }
  // 見出しが分割符号を名乗るなら、API の `designation` と合っていること。
  if (m[2] !== undefined && designation !== null && designation !== undefined && designation !== '' && m[2] !== designation) {
    log.warn(`[bufr] 見出しの分割符号が designation と違うので剥がしません heading=${m[2]} designation=${designation}`)
    return bytes
  }
  return bytes.subarray(m[1].length)
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
   * @param designation 分割報符号（IXAC41 の 1 報目は null）
   * @param bytes 断片の本文。**WMO の見出しが付いていれば剥がす**（IXAC40 は全断片に付く）
   * @param nowMs 現在時刻。時限の判定に使う（テストから渡せるよう引数にしている）
   */
  add(key: string, designation: string | null | undefined, bytes: Uint8Array, nowMs: number): Uint8Array | null {
    this.sweep(nowMs)

    // **剥がすのは結合より先。** 完了の判定も並び順も 1 報目の中身に依るので、見出しが
    // 残っていると「BUFR で始まっていない」で電文ごと捨てることになる。
    const body = stripWmoHeading(bytes, designation)

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
    g.parts.set(index, body)   // 同じ番号が二度来たら上書き（重複配信で二重に数えない）

    if (index === 0) {
      const total = bufrDeclaredLength(body)
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
