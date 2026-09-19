/**
 * 配信元の制限を守るために、ネットワークへ出る量を抑える門。
 *
 * **配信元が定めているのは「窓ごとの上限」であって、配り方ではない。**
 * ([API v2 リファレンス](https://dmdata.jp/docs/reference/api/v2/)「レートリミット」)
 *
 * > 各ドメイン（api.dmdata.jp, data.api.dmdata.jpなど）とIPの組み合わせごとに10分間で2000
 * > リクエストを超えた場合、または以下の表に達した場合に制限が発生します。
 *
 * 表は `data.api.dmdata.jp/v1/:id`（電文本体）と `data.api.dmdata.jp/v1/archive/:id`
 * （アーカイブ本体）に **50req/5min** を掛けている。どちらも AWS WAF のカウンタで、
 * **窓の中で上限に達したときに 429 が返る**。「均等に配れ」とはどこにも書かれていない。
 *
 * **だからこの門も窓で数える。上限に達するまでは 1 件も待たせない。**
 *
 * かつては上限を均等割りした固定間隔（電文本体・アーカイブ本体で 6 秒）だった。
 * 5 分あたりの総量は窓方式と同じ 50 件が上限のままなので**配信元にかかる量は 1 件も
 * 変わらない**のに、まとまった取得が「本数 × 6 秒」そのまま待たされていた ——
 * 起動時の履歴（7 日）で約 42 秒、リプレイの開始（最大 16 本）で約 96 秒。
 * **上限の 14〜32% しか使っていない取得が、上限いっぱいのペースで配られていた。**
 *
 * **件数を減らすだけでは足りない。** 起動時の履歴取得は窓で絞ったあとの全件を
 * `Promise.allSettled(items.map(...))` で同時に投げる形だったため、174 件 → 85 件に減らしても
 * **瞬間のレートは変わらなかった**（実測 2026-09-15: 起動直後に 110 件超が同時）。
 * 窓で数える形でも、上限に達すればそこから先は待たせる —— この門が要る理由は変わっていない。
 *
 * **待たせてよいのは緊急でない取得だけ。** ライブ受信（WebSocket）は電文本文を同梱して届き、
 * 本体を取りに行かない（`decodeTelegramText`。復号に失敗しても REST へは落ちない）ので、
 * この門に並ぶのは履歴・補助情報・リプレイ・起動時の復元に限られる。
 * **地震の報せがこの待ちで遅れることはない。**
 * ライブが本体を取る形へ変えるなら、この前提が崩れるので門の設計から見直すこと。
 *
 * **そのうち「待たせたくないもの」は先に通す**（`urgent`）。起動時に発表中の緊急地震速報を
 * 復元する経路がそれ。**枠そのものは増やさない** —— 入れ替えるのは順番だけ。
 */

import { log, createLogThrottle } from './logger'

/**
 * 「この長さの窓で、この件数まで」という 1 本の制限。
 *
 * **配信元の表の 1 行に対応させる。** 複数渡したときは**すべてを同時に満たす**まで待つので、
 * 「5 分で 50 件」と「10 分で 2000 件」のように重なった制限をそのまま並べて書ける。
 *
 * **固定間隔もこの形で表せる** —— `{ windowMs: 6000, max: 1 }` は「6 秒に 1 件」。
 * テスト用の差し替え（`setDataApiGateIntervalForTest`）はこれを使っている。
 */
export interface RateLimitWindow {
  /** 窓の長さ（ミリ秒）。 */
  windowMs: number
  /** その窓の中で通してよい件数。 */
  max: number
}

/** 待ちを実測できるようにしておく（検証で `window.__telegramBodyStats()` と併せて読む）。 */
export interface RateGate {
  /**
   * 枠が空くまで待つ。**上限に達していなければ待たない。**
   *
   * `urgent` を渡したものは、待っている通常の要求を追い越して先に通る（上限は守る）。
   * 追い越しの中では到来順。
   */
  wait: (opts?: { urgent?: boolean }) => Promise<void>
  /** いま枠を待っている数。逐次反映の進捗と、詰まりの検証に使う。 */
  waiting: () => number
  /**
   * いま上限に達していて待たせているなら、次の枠が空く時刻（ミリ秒）。待ちが無ければ `null`。
   *
   * **画面へ「取得制限中」を出すために読む。** 待っている相手が居ないときは `null` を返す ——
   * 枠が埋まっていること自体は利用者に関係がなく、**実際に誰かが待たされて初めて**
   * 画面に出す意味が生まれる。
   */
  throttledUntil: () => number | null
  /** テスト用。待っているものを通してから空にする。 */
  resetForTest: () => void
}

/**
 * 窓ごとの上限を守る門を作る。
 *
 * **枠は 1 件ずつ配る（キュー方式）。** 呼び出しごとに「自分の枠の時刻」を予約して各自が待つ形
 * では、**後から来たものを先に通せない** —— 予約済みの時刻はもう動かせないため。順番を
 * 入れ替えられるようにするには、配る側が待っている列を持っている必要がある。
 *
 * **配る直前に選ぶ。** 列へ入れた時点で順番を決めてしまうと、待っているあいだに `urgent` が
 * 来ても追い越せない。
 *
 * **通した時刻は「実際に通した瞬間」を記録する。** `setTimeout` は遅れて発火しうるので、
 * 予定時刻を記録すると窓の判定が実時刻から少しずつずれる。
 *
 * **一斉発火させないこと**がこの門の目的そのもの。上限に達したあとは 1 件配ってから次の枠まで
 * 待つ形なので、並列で N 本入れても階段状に並ぶ。
 *
 * 同じ穴を調査スクリプト側で踏んでいる（`scripts/telegram-audit/archive-cache.mjs` の `gate`。
 * 「プロセス内で直列化する」とコメントに書きながら予約が `await` の後にあり、
 * 並列 8 本なら 6 秒ごとに 8 件のバーストになっていた）。**実装を写すのではなく、
 * この性質を保っているかをテストで確かめること。**
 *
 * @param limits 守る制限。**空なら一切待たせない**（テストで門を素通しさせるときに使う）。
 *   複数渡したときはすべてを同時に満たすまで待つ。
 */
export function createRateGate(limits: readonly RateLimitWindow[]): RateGate {
  // 上限 0 件は毎回の判定で通るので、鳴らしっぱなしにせず間引く
  const warnZeroLimit = createLogThrottle(60_000)
  interface Waiter { resolve: () => void; urgent: boolean }
  const queue: Waiter[] = []
  /** 実際に通した時刻（昇順）。いちばん長い窓より古いものは捨てる。 */
  const fired: number[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  /** いちばん長い窓。これより古い記録はどの制限の判定にも効かない。 */
  const maxWindowMs = limits.reduce((m, l) => Math.max(m, l.windowMs), 0)

  /** どの窓にも効かなくなった記録を落とす（放っておくと際限なく積み上がる）。 */
  function prune(now: number): void {
    const cutoff = now - maxWindowMs
    let drop = 0
    while (drop < fired.length && fired[drop] <= cutoff) drop++
    if (drop > 0) fired.splice(0, drop)
  }

  /**
   * 次に 1 件通してよい時刻。いま通してよければ `now` を返す。
   *
   * **すべての制限を満たす時刻を採る**（いちばん遅いものに合わせる）。ある制限が上限に
   * 達していたら、その窓に効いている記録のうち**いちばん古いものが窓から抜けた瞬間**に
   * 1 枠だけ空く —— だから 5 分まるごと止まるわけではない。
   */
  function nextSlotAt(now: number): number {
    prune(now)
    let at = now
    for (const l of limits) {
      // 0 件しか通さない設定は使っていないが、入ってきたら永久に待たせる側へ倒す
      // （通してしまうと、上限を守るというこの門の意味が消える）。
      //
      // **黙って待たせない。** `wait()` は拒否する経路を持たないので、この値が紛れ込むと
      // 取得が**例外もタイムアウトも無く無期限に止まる** —— 記録が無いと原因を追う
      // 手掛かりが 1 つも残らない。
      if (l.max <= 0) {
        warnZeroLimit(() => log.error(
          `[gate] 上限 0 件の窓が渡されました（windowMs=${l.windowMs}）。この門を通る取得は永久に待ちます`,
        ))
        return Number.POSITIVE_INFINITY
      }
      if (fired.length < l.max) continue
      // `fired` は昇順。窓に入っているのは `now - windowMs` より後のもの。
      const from = now - l.windowMs
      let i = fired.length
      while (i > 0 && fired[i - 1] > from) i--
      if (fired.length - i < l.max) continue
      // 窓の中で上限に達している。抜けるのを待つのは「上限の枚数ぶん遡った 1 件」。
      at = Math.max(at, fired[fired.length - l.max] + l.windowMs)
    }
    return at
  }

  /** 列の先頭に出すものを選ぶ。`urgent` が居ればその最初のもの、居なければ到来順の先頭。 */
  function takeNext(): Waiter | undefined {
    const i = queue.findIndex(w => w.urgent)
    return queue.splice(i >= 0 ? i : 0, 1)[0]
  }

  function pump(): void {
    // すでに次の枠を待っている、または配る相手が居ない
    if (timer !== null || queue.length === 0) return
    const now = Date.now()
    const delay = Math.max(0, nextSlotAt(now) - now)
    timer = setTimeout(() => {
      timer = null
      const next = takeNext()
      if (!next) return
      fired.push(Date.now())
      next.resolve()
      // 続きが居れば次の枠を張る（resolve の中で新しく積まれた分もここで拾う）
      pump()
    }, delay)
  }

  return {
    wait(opts): Promise<void> {
      // **待っている相手が居らず枠も空いているなら、その場で通す。**
      // `setTimeout` を必ず通る形にすると、**偽のタイマーを使うテストが 1 件も進まない**
      // （タイマーを進めない限り永久に待つ）。
      // 追い越しの順序には影響しない —— 待っている相手が居ないときだけ通るため。
      const now = Date.now()
      if (queue.length === 0 && timer === null && nextSlotAt(now) <= now) {
        fired.push(now)
        return Promise.resolve()
      }
      return new Promise<void>(resolve => {
        queue.push({ resolve, urgent: opts?.urgent ?? false })
        pump()
      })
    },
    waiting: () => queue.length,
    throttledUntil: () => {
      // **待っている相手が居ないなら、枠が埋まっていても「制限中」ではない。**
      // 画面へ出すのは「いま誰かが待たされている」ことだけ。
      if (queue.length === 0) return null
      const now = Date.now()
      const at = nextSlotAt(now)
      return at > now ? at : null
    },
    resetForTest: () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      fired.length = 0
      // **通してから空にする。** 捨てると待っている Promise が永久に解決せず、
      // テストが落ちる代わりにハングする（→ `rules/common/testing.md`）。
      const pending = queue.splice(0, queue.length)
      for (const w of pending) w.resolve()
    },
  }
}
