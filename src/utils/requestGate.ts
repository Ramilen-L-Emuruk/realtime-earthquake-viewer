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
 * この門に並ぶのは履歴・補助情報・リプレイに限られる。**地震の報せがこの待ちで遅れることはない。**
 * ライブが本体を取る形へ変えるなら、この前提が崩れるので門の設計から見直すこと。
 */

/** 待ちを実測できるようにしておく（検証で `window.__telegramBodyStats()` と併せて読む）。 */
export interface RateGate {
  /** 次の枠が来るまで待つ。 */
  wait: () => Promise<void>
  /** いま枠を待っている数。逐次反映の進捗と、詰まりの検証に使う。 */
  waiting: () => number
  /** テスト用。予約済みの枠を空にする。 */
  resetForTest: () => void
}

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))

/**
 * 最小間隔 `minIntervalMs` の門を作る。
 *
 * **待つ前に枠を予約する。** `await` の後で時刻を書き込む形にすると、並列で入った呼び出しが
 * そろって同じ「前回の時刻」を読み、同じ待ち時間を計算して**一斉に発火する**。
 * 同期的に予約してから待てば、N 本目は `前回 + N×間隔` へ並ぶ。
 *
 * 同じ穴を調査スクリプト側で踏んでいる（`scripts/telegram-audit/archive-cache.mjs` の `gate`。
 * 「プロセス内で直列化する」とコメントに書きながら予約が `await` の後にあり、
 * 並列 8 本なら 6 秒ごとに 8 件のバーストになっていた）。**実装を写すのではなく、
 * この性質を保っているかをテストで確かめること。**
 */
export function createRateGate(minIntervalMs: number): RateGate {
  let nextSlotAt = 0
  let waiting = 0
  return {
    async wait(): Promise<void> {
      const now = Date.now()
      const target = Math.max(now, nextSlotAt)
      nextSlotAt = target + minIntervalMs
      const delay = target - now
      if (delay <= 0) return
      waiting++
      try {
        await sleep(delay)
      } finally {
        waiting--
      }
    },
    waiting: () => waiting,
    resetForTest: () => { nextSlotAt = 0; waiting = 0 },
  }
}
