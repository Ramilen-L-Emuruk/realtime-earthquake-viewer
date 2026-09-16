/**
 * 強震モニタの秒フレームの控え。**再生を開始し直しても残る**。
 *
 * ## なぜ要るのか
 *
 * 検知エンジンの助走（`utils/kyoshinWarmup`）は、開始時刻より前の秒ファイルを遡って取る。
 * **これが再生を開始するたびに丸ごと取り直されていた** —— 秒ファイルは時刻ごとに不変なのに、
 * 控えがどこにも無かった。
 *
 * 実測（2026-09-16・DMDSS 版・能登半島地震の本震を再生）:
 *
 * | | 値 |
 * |---|---|
 * | 1 回の開始で投げる助走フレーム | 667〜668 件（2 回の実測。上限は `WARMUP_MAX_BLOCKS × WARMUP_BLOCK_SEC` ＝ 900） |
 * | 投げ方 | 約 3 秒で一気に（**毎秒 185 件**） |
 *
 * 区間ごとに開始し直す使い方（8 日を跨ぐ 239 区間）では、これが区間の数だけ掛かる。
 *
 * ## 何を控えるか
 *
 * **観測点の値は文字列のまま控える**（展開した配列では持たない）。文字列なら 1 点 2 バイトだが、
 * 数値の配列に展開すると 1 点 8 バイト —— **4 倍**。展開は読むたびに `Array.from` で作り直す。
 *
 * **サイズは観測点の数で決まり、その数は増えていく。** 実測:
 *
 * | フレームの日 | 観測点 | 文字列のまま | 配列に展開 |
 * |---|---:|---:|---:|
 * | 2024-01-01 | 1,133 点 | 2.2KB | 8.9KB |
 * | 2026-09-16 | 1,725 点 | 3.4KB | 13.5KB |
 *
 * **だから上限のバイト数を点数から逆算して固定しないこと。** この控えは件数で上限を置き、
 * 1 件あたりは新しい側（3.4KB）で見積もっている。
 *
 * **作り直すのは得だからだけではない。** 配列を控えて返すと、複数の読み手が同じ配列を
 * 共有することになる。いまの読み手は書き換えないが、書き換えた瞬間に**控えの中身が化ける**
 * （症状は「前のフレームの値が混ざる」で、例外もログも出ない）。
 *
 * ## ライブでは控えない
 *
 * ライブは毎秒「新しい時刻」を取るので、控えても一度も当たらない。当たらない控えは
 * ただメモリを使うだけなので、**呼び出し側が再生のときだけ控えるよう指定する**
 * （`services/kyoshin.ts` の `fetchRealtimeIntensity`）。
 *
 * ## 追い出しは挿入順で行う（並べ替えない）
 *
 * アーカイブ本体の控え（`utils/archiveBodyCache.ts`）は追い出しのたびに全件を並べ替えるが、
 * あちらは高々 96 本。**こちらは 2,700 件を毎秒 185 件の勢いで入れる**ので、同じ書き方だと
 * 追い出しのたびに O(n log n) が走る。`Map` が挿入順を保つ性質を使い、読んだものを
 * 末尾へ付け替える形にして、追い出しは先頭から 1 件ずつにしてある。
 */
import { WARMUP_BLOCK_SEC, WARMUP_MAX_BLOCKS } from './kyoshinWarmup'
// 型だけの参照。**実行時の import は作らない**（`services/kyoshin.ts` はこの控えを使うので、
// 値として読むと循環になる）。
import type { YahooHypoInfoItem } from '../services/kyoshin'

/** 助走 1 回が遡りうる最大フレーム数。 */
const WARMUP_MAX_FRAMES = WARMUP_MAX_BLOCKS * WARMUP_BLOCK_SEC

/**
 * 控えるフレーム数の上限。
 *
 * **要るのは「次の助走が欲しがる範囲」まで。** 助走が遡るのは開始時刻から高々
 * `WARMUP_MAX_FRAMES` 秒なので、
 *
 * 1. いまの助走が取った分（最大 `WARMUP_MAX_FRAMES`）
 * 2. 次の区間の助走が遡る範囲（＝直前の再生でふつうに取った分。同じ幅）
 * 3. 余裕 1 つ分
 *
 * の 3 つ分を持てば足りる。**それより多く持っても当たらない** —— 助走はそれ以上
 * 遡らないため。逆に 2 を割ると、区間を送るたびに助走が取り直しになる。
 *
 * 1 フレーム 3.4KB（実測・1,725 点）なので、上限に達しても **9MB ほど**。
 */
export const MAX_FRAMES = WARMUP_MAX_FRAMES * 3

/** 控える 1 フレーム。**観測点の値は文字列のまま**（上記のとおり展開しない）。 */
export interface CachedKyoshinFrame {
  dataTime: string
  siteConfigId: string
  /** 観測点の値を詰めた文字列。読むときに `Array.from` で展開する。 */
  intensity: string
  hypoInfo: YahooHypoInfoItem[]
}

export interface KyoshinFrameCacheStats {
  /** 控えから返した回数。 */
  hits: number
  /**
   * 控えに無かった回数。
   *
   * **同じ鍵への再試行も 1 回ずつ数える。** 未登録の秒（403）は成功するまで再試行されるので、
   * 1 つの「本当に控えに無かった秒」が再試行の回数だけ miss として積まれる。
   * **hit 率をそのまま「控えの効き」と読まないこと** —— 取得が不調なだけで下がる。
   */
  misses: number
  /** 追い出した件数。 */
  evicted: number
  /** いま控えている件数。 */
  entries: number
}

export interface KyoshinFrameCache {
  get: (key: string) => CachedKyoshinFrame | undefined
  set: (key: string, frame: CachedKyoshinFrame) => void
  stats: () => KyoshinFrameCacheStats
  /**
   * 空にする。**テスト用**。
   *
   * **本番では、時間軸が変わっても呼ばない。** フレームは時刻ごとに不変なので捨てる理由が
   * 無く、捨てないことがこの控えの設計そのもの（強震モニタの**値**を落とす規則は
   * `docs/spec/settings-pwa-spec.md` §6「強震モニタは自分で落とす」。あちらは画面へ流れる
   * 値の話で、こちらは取得の控え）。
   */
  clear: () => void
}

export function createKyoshinFrameCache(opts?: { maxFrames?: number }): KyoshinFrameCache {
  const maxFrames = opts?.maxFrames ?? MAX_FRAMES
  const frames = new Map<string, CachedKyoshinFrame>()
  const counters = { hits: 0, misses: 0, evicted: 0 }

  return {
    get(key) {
      const hit = frames.get(key)
      if (!hit) {
        counters.misses++
        return undefined
      }
      counters.hits++
      // **読んだものを末尾へ付け替える。** `Map` は挿入順を保つので、これだけで
      // 「いちばん古く使ったもの」が先頭に来る（並べ替えずに済む）。
      frames.delete(key)
      frames.set(key, hit)
      return hit
    },
    set(key, frame) {
      // 同じ鍵を入れ直すときも末尾へ移す（古い位置に残すと、新しいのに先に追い出される）
      frames.delete(key)
      frames.set(key, frame)
      while (frames.size > maxFrames) {
        // 先頭＝いちばん古く使ったもの。`Map` のイテレータは挿入順
        const oldest = frames.keys().next()
        if (oldest.done) break
        frames.delete(oldest.value)
        counters.evicted++
      }
    },
    stats: () => ({ ...counters, entries: frames.size }),
    clear() {
      frames.clear()
      counters.hits = 0
      counters.misses = 0
      counters.evicted = 0
    },
  }
}
