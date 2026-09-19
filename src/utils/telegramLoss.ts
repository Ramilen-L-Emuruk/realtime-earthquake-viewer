/**
 * 電文の取得で取りこぼした量を持つ入れ物。
 *
 * **リプレイとライブの両方が使う。** リプレイは `ReplayLoss`（`hooks/useReplayController.ts`）
 * として先読みの失敗も足す。数え方を 2 本持つと、片方だけ「同じ取得元を二重に数えない」を落とす。
 *
 * **合流の仕方は 3 つあり、「何を合流するのか」で決まる。** 取り違えると、直したはずの
 * 「失敗が画面に出ない」の裏返し（取れているのに失敗中と出続ける）か、その逆（欠けている
 * のに何も出ない）を作る。
 *
 * | 場面 | 使う関数 | 電文（`skippedByDay`）の扱い |
 * |---|---|---|
 * | 起点になる取得（起動時の履歴・時間軸が変わった後の読み直し） | `telegramLossFrom` | 前の値を引き継がない |
 * | **別々のもの**を 1 つの入れ物へ集める（リプレイの本編・初期状態・履歴・先読み） | `addTelegramLoss` | **足す** |
 * | **同じ範囲をもう一度読む**ことがある（ライブの「もっと見る」） | `mergeHistoryLoss` | 同じ日は**置き換える** |
 *
 * **「別々のものを集める」ところで置き換えてはいけない。** 同じ日に別々の電文が壊れていれば
 * それは足すべき 2 件で、片方を捨ててよいものではない。日付範囲が重なる取得どうしで同じ破損を
 * 二度数えることはあるが、**少なく見せて「静かな時間帯だった」と誤読されるより、多めに申告する
 * 側へ倒す**（旧実装からの方針）。
 *
 * ## 持ち方のほうを疑う
 *
 * **「積むか置き換えるか」で悩んだら、中身の持ち方を疑うこと。** 「同じものを二度数えうる」形
 * （＝ただの件数）だと、積めば重複し、置き換えれば前に確定した分が消える —— **どちらを選んでも
 * 正しくならない**。鍵を持たせれば（取得元は識別子の集合・電文は日ごと）、少なくとも
 * 「同じものか別のものか」を問える形になる。
 *
 * 同じ落とし穴を 3 度踏んでいる。`failedSources` を集合にしたとき、`skippedByDay` を日ごとに
 * したとき、そして**日ごとにした直後に「同じ日は上書き」を全部の合流へ当ててしまったとき**。
 * 3 つ目は、カーソル方式の「もっと見る」（窓が重ならない）でだけ正しい規則を、別々のものを
 * 集めるリプレイ側にも当てていた。
 */
export interface TelegramLoss {
  /**
   * 取り込めなかった電文の通数を、**JST 日ごとに**持つ。画面へ出すのは合計（`totalSkipped`）。
   *
   * **件数ひとつで持たない。** 同じ日を二度読めば同じ壊れた電文を二度数えることになり、
   * かといって置き換えると、別の日で確定していた損失が消える —— **件数で持つ限り、積んでも
   * 置き換えても正しくならない**。日を鍵にすれば、同じ日は上書き・別の日は加算で両方が立つ。
   *
   * これは `failedSources` を集合にしたのと同じ理屈（そちらの注記も参照）。**あちらが通った道を
   * こちらだけ通っていなかった。**
   *
   * 日が分からない取りこぼしは `UNKNOWN_SKIP_DAY` へまとめる。
   */
  skippedByDay: ReadonlyMap<string, number>
  /**
   * 読めなかった取得元の識別子。
   *
   * **件数ではなく集合で持つ。** 本編と初期状態は日付範囲が重なるため同じアーカイブを両方が
   * 読み、件数で合算すると 1 件の障害が「2 件」と表示される。
   *
   * 中身はアーカイブの URL と、当日経路の識別子（`live:<日付>`）が混ざる。どちらも
   * 「1 日ぶんの取得元」なので同じ枠で数える。
   */
  failedSources: Set<string>
  /**
   * 429 の窓が明けていないため**取りに行かなかった**取得元。
   *
   * **`failedSources` と分ける。** あちらは「投げたのに駄目だった」で恒久的な喪失、
   * こちらは「こちらの判断で待っている」もの。混ぜると**待てば取れるものが取り返しの
   * つかない損失として画面に出る**うえ、「すべて読めなかった」の判定に入って
   * **取れていた分ごと捨てる**（→ `types/replay.ts` の `rateLimitedSources`）。
   */
  rateLimitedSources: Set<string>
  /**
   * 429 の窓で見送った**電文**の数。
   *
   * **取得元とは単位が違う**ので別に数える。取得元単位で見送った日は「その日に何通
   * あったか」すら分からないため、電文数へ合算できない。
   */
  rateLimitedTelegrams: number
}

/**
 * 取りこぼした日が分からないときの鍵。
 *
 * 電文を捨てる場所のうち、どの日のものか辿れないものをここへまとめる。**同じ日として
 * 上書きされる**ので、日が分かる分と混ぜて数えると取りこぼしを少なく見せうるが、
 * 鍵を持たない以上これ以上は分けられない。
 */
export const UNKNOWN_SKIP_DAY = '(日付不明)'

/**
 * 取りこぼしを日ごとに数える入れ物。取得側が積み、最後に `toMap()` で取り出す。
 *
 * **数える側に「どの日か」を必ず渡させるために用意している。** 素の数値カウンタだと、
 * 呼び出し箇所を足したときに日を添え忘れても型検査を通ってしまい、その分が
 * `UNKNOWN_SKIP_DAY` へも入らず**丸ごと消える**。
 */
export interface SkipCounter {
  /** 1 通ぶん数える。日が辿れないときは `UNKNOWN_SKIP_DAY`。 */
  add(day: string): void
  /**
   * 別の取得（当日経路など）の結果を取り込む。**同じ日でも足す。**
   *
   * **上書きにしてはいけない。** ここで合流するのは「同じ範囲を読み直した結果」ではなく
   * **別々のものを読んだ結果**（アーカイブ経路と当日経路・当日経路の複数日）。同じ日に
   * 別々の電文が壊れていれば、それは足すべき 2 件で、片方を捨ててよいものではない。
   *
   * **とくに `UNKNOWN_SKIP_DAY` で効く。** あれは窓を持たない固定の鍵なので、上書きにすると
   * 「日が辿れない取りこぼし」を複数の取得が報告したときに必ず 1 件ぶんしか残らない。
   */
  addAll(other: ReadonlyMap<string, number>): void
  toMap(): Map<string, number>
}

export function createSkipCounter(): SkipCounter {
  const byDay = new Map<string, number>()
  return {
    add(day) { byDay.set(day, (byDay.get(day) ?? 0) + 1) },
    addAll(other) { for (const [day, n] of other) byDay.set(day, (byDay.get(day) ?? 0) + n) },
    toMap() { return new Map(byDay) },
  }
}

/** 日ごとの取りこぼしの合計（画面へ出すのはこの数）。 */
export function totalSkipped(loss: TelegramLoss): number {
  let total = 0
  for (const n of loss.skippedByDay.values()) total += n
  return total
}

/**
 * 日ごとの取りこぼしを**足し合わせる**（同じ日でも加える）。
 *
 * **別々のものを読んだ結果を集めるとき**に使う —— リプレイは本編・初期状態・履歴・先読みを
 * 1 つの入れ物へ集めており、同じ日に別々の電文が壊れていれば足すべき 2 件になる。
 * 1 回の取得の中でも、**互いに素だと分かっている 2 つの集計を束ねる**のに使う
 * （→ `services/dmdataReplay.ts` の `scanSkips` / `windowSkips`）。
 * 日付範囲が重なる取得どうしで同じ破損を二度数えることはあるが、**少なく見せて「静かな
 * 時間帯だった」と誤読されるより、多めに申告する側へ倒す**（旧実装からの方針）。
 */
export function sumSkippedByDay(
  base: ReadonlyMap<string, number>,
  add: ReadonlyMap<string, number>,
): Map<string, number> {
  const merged = new Map(base)
  for (const [day, n] of add) merged.set(day, (merged.get(day) ?? 0) + n)
  return merged
}

/**
 * 日ごとの取りこぼしを合流し、**同じ日は新しい結果で置き換える**。
 *
 * **「同じ範囲をもう一度読んだ」ときだけ**使える。その日の最新の事実が新しい結果だから。
 * カーソル方式の「もっと見る」（→ `mergeHistoryLoss`）がこれにあたり、カーソルが停滞して
 * 同じ窓を読み直したときに件数が無制限に積み上がるのを防ぐ。
 *
 * **別々のものを読んだ結果に当てないこと**（そちらは `sumSkippedByDay`）。同じ日に別々の
 * 電文が壊れていたとき、片方を黙って捨てる。
 */
function replaceSkippedByDay(
  base: ReadonlyMap<string, number>,
  fresh: ReadonlyMap<string, number>,
): Map<string, number> {
  const merged = new Map(base)
  for (const [day, n] of fresh) merged.set(day, n)
  return merged
}

export function createEmptyTelegramLoss(): TelegramLoss {
  return {
    skippedByDay: new Map(),
    failedSources: new Set(),
    rateLimitedSources: new Set(),
    rateLimitedTelegrams: 0,
  }
}

/**
 * 取得結果を損失に足し込む（取得元は集合・電文は日ごとなので二重計上されない）。
 *
 * 元の損失は書き換えない。`ReplayLoss` のように項目を足した型でもそのまま使えるよう、
 * 受け取った型を保って返す。
 */
export function addTelegramLoss<T extends TelegramLoss>(
  loss: T,
  skippedByDay: ReadonlyMap<string, number>,
  failedSourceIds: readonly string[],
  rateLimited?: { sources?: readonly string[]; telegrams?: number },
): T {
  const failedSources = new Set(loss.failedSources)
  for (const id of failedSourceIds) failedSources.add(id)
  const rateLimitedSources = new Set(loss.rateLimitedSources)
  for (const id of rateLimited?.sources ?? []) rateLimitedSources.add(id)
  return {
    ...loss,
    skippedByDay: sumSkippedByDay(loss.skippedByDay, skippedByDay),
    failedSources,
    rateLimitedSources,
    rateLimitedTelegrams: loss.rateLimitedTelegrams + (rateLimited?.telegrams ?? 0),
  }
}

/**
 * 取得結果**そのもの**を損失にする（前の値を引き継がない）。
 *
 * **その入れ物がその取得の結果だけを持つときに使う**（上の表を参照）。遡りの起点になる
 * 取得 —— 起動時の履歴と、時間軸が変わった後の読み直し —— がこれにあたる。
 *
 * **続きを読む取得には使わない。** 窓が重ならないので、前の窓で確定した損失を消してしまう
 * （そちらは `addTelegramLoss` で合流する）。
 */
export function telegramLossFrom(
  skippedByDay: ReadonlyMap<string, number>,
  failedSourceIds: readonly string[],
  rateLimited?: { sources?: readonly string[]; telegrams?: number },
): TelegramLoss {
  return {
    skippedByDay: new Map(skippedByDay),
    failedSources: new Set(failedSourceIds),
    rateLimitedSources: new Set(rateLimited?.sources ?? []),
    rateLimitedTelegrams: rateLimited?.telegrams ?? 0,
  }
}

/**
 * 履歴の取得結果を、いま画面に出ている損失へ合流する（「もっと見る」で続きを読んだとき）。
 *
 * **中身によって残し方が違うので、呼び出し側に選ばせない。**
 *
 * | 中身 | 扱い | 理由 |
 * |---|---|---|
 * | 壊れた電文（`skippedByDay`） | 前の窓の分を残す | 取り直しても直らない。窓は重ならないので次の取得では 0 件になり、捨てると**何も直っていないのに表示だけ消える** |
 * | 取得元の失敗・429 の見送り | その取得の結果で置き換える | **失敗した日でカーソルが止まる**（→ `QuakeHistoryResult.oldestLoadedDay`）ので、次に押せば必ず読み直す。消えた表示は「もう再試行した」か「いま再試行できる」のどちらか |
 *
 * **カーソルが失敗日を跨ぐ作りへ戻すなら、取得元の側も残す形へ変えること。** 跨いだ日は
 * 二度と要求されないのに表示だけが消える —— いちばん質の悪い形になる。
 */
export function mergeHistoryLoss(
  prev: TelegramLoss,
  result: {
    skippedByDay: ReadonlyMap<string, number>
    failedArchiveUrls: readonly string[]
    rateLimitedSources: readonly string[]
    rateLimitedTelegrams: number
  },
): TelegramLoss {
  return {
    skippedByDay: replaceSkippedByDay(prev.skippedByDay, result.skippedByDay),
    failedSources: new Set(result.failedArchiveUrls),
    rateLimitedSources: new Set(result.rateLimitedSources),
    rateLimitedTelegrams: result.rateLimitedTelegrams,
  }
}

export function isTelegramLossEmpty(loss: TelegramLoss): boolean {
  return loss.skippedByDay.size === 0 && loss.failedSources.size === 0
    && loss.rateLimitedSources.size === 0 && loss.rateLimitedTelegrams === 0
}

/**
 * 取得元と電文の件数を語に直す（0 件のものは並べない）。
 *
 * **確定した損失（`describeTelegramLossParts`）と 429 の見送り（`formatRateLimitedNotice`）で
 * 共有する。** 同じ画面に並びうるので、片方だけ語順を変えると同じ内訳が別物に見える。
 */
function countParts(sources: number, telegrams: number): string[] {
  const parts: string[] = []
  if (sources > 0) parts.push(`取得元${sources}件`)
  if (telegrams > 0) parts.push(`電文${telegrams}件`)
  return parts
}

/**
 * 損失の内訳を語に直す（何も欠けていなければ空）。
 *
 * **取得元単位の失敗（丸ごと読めなかった 1 日）と電文単位の失敗（1 通ずつの破損）は粒度が
 * 違うので分けて数える。** 前者は「その日の電文が何通あったか」すら分からないため、電文数に
 * 合算できない。
 *
 * リプレイとライブで同じ語を使うためにここへ置く。片方だけ言い換えると、同じ障害が経路に
 * よって別の重さに見える。
 */
export function describeTelegramLossParts(loss: TelegramLoss): string[] {
  return countParts(loss.failedSources.size, totalSkipped(loss))
}

/**
 * ライブの履歴取得で欠けた分を、地震タブに出す一文へ直す。何も欠けていなければ null。
 *
 * **1 件でも出す。** 取得元が「日」単位になったぶん、1 日落ちれば失う電文は多い。リプレイ側
 * （`formatLossNotice`）も 1 件から出しており、ライブだけ黙ると同じ障害が片方でしか見えない。
 *
 * **「取得し直す手立て」を必ず添える。** 自動では取り直さないため、添えないと打てる手が
 * 分からない（生成データの `MapDataStatus` と同じ書き方に揃えてある）。
 *
 * **語は「取り込めず」で、`formatRateLimitedNotice` の「未取得」と分ける。** 2 つは同じ
 * `notices` に並びうる（→ `components/EarthquakeTab/index.tsx`）。こちらは取りに行って
 * 失敗した確定の損失、あちらは上限で取りに行かなかった分で、形を揃えたぶん差は語が担う。
 *
 * 文の形の規約（言い切りで止める理由・括弧の中身の決め方）は
 * `docs/spec/settings-pwa-spec.md` §5.5「通知の文の形」が単一情報源。
 */
export function formatHistoryLossNotice(loss: TelegramLoss): string | null {
  const parts = describeTelegramLossParts(loss)
  if (parts.length === 0) return null
  return `${parts.join('・')}を取り込めず（再読み込みで取得し直します）`
}

/**
 * 「もっと見る」がまるごと失敗したときの一文。
 *
 * **確定した損失とは別に出す。** こちらは押し直せば回復しうるもので、遡る日数も押す前の値へ
 * 戻してある。混ぜると、戻せない損失と戻せる失敗が同じ重さに見える。
 *
 * **主節から違える。** 2 つは同時に並ぶので（`historyLossNotice.test.tsx` の「両方あれば両方
 * 出す」）、末尾の括弧書きだけが違う形にすると、同じ主張が重複しているように見えて肝心の差
 * （戻らない／もう一度で直るかもしれない）を読み飛ばされる。
 */
export const HISTORY_LOAD_MORE_FAILED_NOTICE = '続きの読み込みに失敗（もう一度お試しください）'

/**
 * いま配信元の上限に達していて、取得を待たせていることを知らせる一文。
 *
 * **失敗ではない。** 枠が空けばそのまま取りに行くので、欠けは出ない —— だから
 * 損失の帯とは別の見た目で出す（→ `components/EarthquakeTab/index.tsx`）。
 *
 * **「間をおいてください」と依頼形にしない。** 利用者が何かを間違えたわけではないし、
 * 待てば自動で再開するので、依頼にすると「何かしないといけない」と読まれる。
 *
 * 下の `formatRateLimitedNotice` と**主節をそろえてある** —— 利用者にとっては
 * どちらも「アプリが自分で取得を絞っている」という同じ事実で、違うのは結果だけ。
 */
export const FETCH_THROTTLED_NOTICE = 'リクエスト過多のため、取得制限中（自動で再開します）'

/**
 * 429 の窓で取りに行かなかった分を知らせる一文。見送りが無ければ null。
 *
 * **上の `FETCH_THROTTLED_NOTICE` と主節をそろえ、括弧だけ変える。** あちらは「待っていて、
 * これから取る」、こちらは「その回は取らずに先へ進んだ」。
 *
 * **取得元と電文は単位が違うので混ぜない**（`describeTelegramLossParts` と同じ理由）。
 * 取得元単位で見送った日は、その日に何通あったかが分からないため電文数へ足せない。
 *
 * **この見送り自体がほとんど起きない。** 控えを端末へ残し、門を窓ごとの上限へ変えた今、
 * 429 は「同じ id の取り直し」に返るもので、控えが効いていれば取り直さない。
 *
 * **内訳の語は `countParts` を `describeTelegramLossParts` と共有する。** 同じ画面に並びうる
 * ので、片方だけ語順を変えると同じ内訳が別物に見える。
 *
 * **主節の語は「未取得」で、`formatHistoryLossNotice` の「取り込めず」と分ける。**
 * 形を揃えたぶん、「取りに行って失敗した」と「上限で取りに行かなかった」の差は語だけが担う。
 *
 * 文の形の規約（括弧へ行動ではなく内訳を入れる理由も含む）は
 * `docs/spec/settings-pwa-spec.md` §5.5「通知の文の形」が単一情報源。
 */
export function formatRateLimitedNotice(loss: TelegramLoss): string | null {
  const parts = countParts(loss.rateLimitedSources.size, loss.rateLimitedTelegrams)
  if (parts.length === 0) return null
  return `リクエスト過多のため、取得制限中（${parts.join('・')}が未取得）`
}
