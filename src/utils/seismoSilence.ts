// 「待っている相手から、期待した間隔を超えて何も来ていない」を 1 つの述語にする。
//
// **同じ判定が 3 箇所に要る** —— 観測点の震度（`hooks/useSeismoStation.ts`）・観測点の
// 波形（同）・有感カードの波形の繋ぎ足し（`hooks/useSeismoQuakeWaves.ts`）。この機能で
// いちばん重い失敗は「揺れていない」と「届いていない」の混同で
// （→ `docs/spec/data-sources-spec.md` §4.5）、3 つはどれもその混同が残る形だった。
// **バラバラに書くと、同じ事実に判定が 3 つできて後から食い違う。**
//
// **閾値は渡す側が持つ。** 震度は毎秒 1 件・波形のまとまりは 0.3 秒ごと・カードの
// 繋ぎ足しは 0.3 秒ごとに見に行くだけで、期待する間隔が別物 —— ここへ 1 つの値を
// 置くと、どれかに合わない。

/** 待っている相手の様子。 */
export type SeismoSilence =
  /** 期待どおり来ている。 */
  | { readonly kind: 'flowing' }
  /**
   * **一度も来ていない。**「途絶えた」とは別に持つ。
   *
   * 購読を始めた直後・まだ 1 件も届いていない間がこれ。**ここを「途絶えた」へ倒すと、
   * 繋いだ瞬間に「値が来ていない」と名乗る** —— いちばん頻繁に通る経路なので、混ぜると
   * 警告が常態になって意味を失う。
   */
  | { readonly kind: 'never' }
  /**
   * **来ていたのに途絶えた。** 画面へ出すのはこれだけ。
   *
   * @param forMs 最後に来てからの経過。**画面には出さず、記録へ添える**ための値 ——
   *   瞬断と本物の途絶を事後に見分ける手掛かりがこれしか無い。**state へ載せないこと**
   *   （巡回のたびに変わるので、比較に入れると毎回再描画が起きる）。
   */
  | { readonly kind: 'silent'; readonly forMs: number }

/**
 * 待っている相手が途絶えているかを見る。
 *
 * **時間軸は渡す側のもの。** `useSeismoStation` は `performance.now()`（端末の壁時計を
 * 使うと、スリープからの復帰や時刻補正で跳ねたときに届いている値がまとめて「古い」へ
 * 倒れる）、`useSeismoQuakeWaves` は `serverNow()`（再生中に比較が常に真になるのを防ぐ）。
 * **2 つを混ぜて渡さないこと** —— 別の原点を引き算した値は意味を持たない。
 */
export function judgeSilence(params: {
  /** 最後に何かを受け取った時刻。**一度も受け取っていなければ `null`。** */
  readonly lastReceivedAt: number | null
  /** いまの時刻（`lastReceivedAt` と同じ時間軸で）。 */
  readonly now: number
  /** これを超えて何も来なければ「途絶えた」と見なす。 */
  readonly staleMs: number
}): SeismoSilence {
  const { lastReceivedAt, now, staleMs } = params
  if (lastReceivedAt === null) return { kind: 'never' }
  const forMs = now - lastReceivedAt
  // **境界は `>=`。** 置き換える前の判定（`useSeismoStation` の `waveStale`）が
  // `now - waveReceivedAt >= WAVE_STALE_MS` だったので、揃えないと 1 ms だけずれる。
  //
  // **時刻が巻き戻った場合（`forMs` が負）はここで「来ている」へ落ちる。** `serverNow()`
  // は較正で跳ねるので、未来の時刻を最後の受信として持つことがある —— そこで「途絶えた」
  // と出すと、時計が直った拍子に表示が消えて、揺れとも障害とも関わりのない理由で画面が動く。
  if (forMs < staleMs) return { kind: 'flowing' }
  return { kind: 'silent', forMs }
}
