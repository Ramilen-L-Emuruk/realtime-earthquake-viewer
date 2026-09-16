/**
 * 配信元の制限を守るために、ネットワークへ出る間隔を空ける門。
 *
 * **件数を減らすだけでは足りない。** 起動時の履歴取得は `Promise.allSettled(items.map(...))` で
 * 全件を同時に投げる形だったため、窓を絞って 174 件 → 85 件にしても**瞬間のレートは
 * 変わらなかった**（実測 2026-09-15: 起動直後に 110 件超が同時。地震 85・津波 26・補助情報）。
 * 件数だけを見ていると、この形は何も起きていないように見える。
 *
 * **待たせてよいのは緊急でない取得だけ。** ライブ受信（WebSocket）は電文本文を同梱して届き、
 * 本体を取りに行かない（`decodeTelegramText`。復号に失敗しても REST へは落ちない）ので、
 * この門に並ぶのは履歴・補助情報・リプレイ・起動時の復元に限られる。
 * **地震の報せがこの待ちで遅れることはない。**
 * ライブが本体を取る形へ変えるなら、この前提が崩れるので門の設計から見直すこと。
 *
 * **そのうち「待たせたくないもの」は先に通す**（`urgent`）。起動時に発表中の緊急地震速報を
 * 復元する経路がそれで、履歴の後ろに並ぶと最悪 24 秒遅れて画面に出る —— いちばん見たいものが
 * 遅れるのは本末転倒なので、**間隔そのものは変えずに順番だけ入れ替える**。
 */

/** 待ちを実測できるようにしておく（検証で `window.__telegramBodyStats()` と併せて読む）。 */
export interface RateGate {
  /**
   * 次の枠が来るまで待つ。
   *
   * `urgent` を渡したものは、待っている通常の要求を追い越して先に通る（間隔は守る）。
   * 追い越しの中では到来順。
   */
  wait: (opts?: { urgent?: boolean }) => Promise<void>
  /** いま枠を待っている数。逐次反映の進捗と、詰まりの検証に使う。 */
  waiting: () => number
  /** テスト用。待っているものを通してから空にする。 */
  resetForTest: () => void
}

/**
 * 最小間隔 `minIntervalMs` の門を作る。
 *
 * **枠は 1 件ずつ配る（キュー方式）。** 呼び出しごとに「自分の枠の時刻」を予約して各自が待つ形
 * では、**後から来たものを先に通せない** —— 予約済みの時刻はもう動かせないため。順番を
 * 入れ替えられるようにするには、配る側が待っている列を持っている必要がある。
 *
 * **配る直前に選ぶ。** 列へ入れた時点で順番を決めてしまうと、待っているあいだに `urgent` が
 * 来ても追い越せない。
 *
 * **一斉発火させないこと**がこの門の目的そのもの。1 件配ってから次の枠まで待つ形なので、
 * 並列で N 本入れても `前回 + N×間隔` へ階段状に並ぶ。
 *
 * 同じ穴を調査スクリプト側で踏んでいる（`scripts/telegram-audit/archive-cache.mjs` の `gate`。
 * 「プロセス内で直列化する」とコメントに書きながら予約が `await` の後にあり、
 * 並列 8 本なら 6 秒ごとに 8 件のバーストになっていた）。**実装を写すのではなく、
 * この性質を保っているかをテストで確かめること。**
 */
export function createRateGate(minIntervalMs: number): RateGate {
  interface Waiter { resolve: () => void; urgent: boolean }
  const queue: Waiter[] = []
  /** 最後に枠を配った時刻。0 は「まだ 1 件も配っていない」。 */
  let lastFiredAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  /** 列の先頭に出すものを選ぶ。`urgent` が居ればその最初のもの、居なければ到来順の先頭。 */
  function takeNext(): Waiter | undefined {
    const i = queue.findIndex(w => w.urgent)
    return queue.splice(i >= 0 ? i : 0, 1)[0]
  }

  function pump(): void {
    // すでに次の枠を待っている、または配る相手が居ない
    if (timer !== null || queue.length === 0) return
    const delay = Math.max(0, lastFiredAt + minIntervalMs - Date.now())
    timer = setTimeout(() => {
      timer = null
      const next = takeNext()
      if (!next) return
      lastFiredAt = Date.now()
      next.resolve()
      // 続きが居れば次の枠を張る（resolve の中で新しく積まれた分もここで拾う）
      pump()
    }, delay)
  }

  return {
    wait(opts): Promise<void> {
      // **待っている相手が居らず枠も空いているなら、その場で通す。**
      // `setTimeout` を必ず通る形にすると、**偽のタイマーを使うテストが 1 件も進まない**
      // （タイマーを進めない限り永久に待つ）。予約方式だった頃は `delay <= 0` で
      // `sleep` を呼ばずに返していたので、その性質をここで保つ。
      // 追い越しの順序には影響しない —— 待っている相手が居ないときだけ通るため。
      if (queue.length === 0 && timer === null && Date.now() >= lastFiredAt + minIntervalMs) {
        lastFiredAt = Date.now()
        return Promise.resolve()
      }
      return new Promise<void>(resolve => {
        queue.push({ resolve, urgent: opts?.urgent ?? false })
        pump()
      })
    },
    waiting: () => queue.length,
    resetForTest: () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      // **通してから空にする。** 捨てると待っている Promise が永久に解決せず、
      // テストが落ちる代わりにハングする（→ `rules/common/testing.md`）。
      const pending = queue.splice(0, queue.length)
      lastFiredAt = 0
      for (const w of pending) w.resolve()
    },
  }
}
