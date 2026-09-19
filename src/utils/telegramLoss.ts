/**
 * 電文の取得で取りこぼした量を持つ入れ物。
 *
 * **リプレイとライブの両方が使う。** リプレイは `ReplayLoss`（`hooks/useReplayController.ts`）
 * として先読みの失敗も足す。数え方を 2 本持つと、片方だけ「同じ取得元を二重に数えない」を落とす。
 *
 * **置き換えてよいのは、その入れ物がその取得の結果だけを持つときに限る。** 取り違えると、
 * 直したはずの「失敗が画面に出ない」の裏返し（取れているのに失敗中と出続ける）を作る。
 *
 * | 入れ物 | 中身 | 使う関数 |
 * |---|---|---|
 * | ライブの `historyLoss`（`hooks/useEarthquakes.ts`） | 履歴の取得 1 本だけ。**毎回その時点の全範囲**を数え直して返る | `telegramLossFrom`（置き換える） |
 * | リプレイの `ReplayLoss`（`hooks/useReplayController.ts`） | 本編・初期状態・履歴・先読みを**同じ入れ物へ集める** | `addTelegramLoss`（積む） |
 *
 * **リプレイも同じ `fetchDmdataQuakeHistory` を呼ぶが、そちらは積む。** 入れ物を他の取得と
 * 共有しているので、置き換えると他の取得の損失を消してしまう。あちらは 1 セッションにつき
 * 1 回しか呼ばず、空の状態から足すので「回数だけ数える」問題は起きない。**リプレイ側から
 * 同じ取得を複数回呼ぶようにするなら、その分だけを別に持ってから集める形へ直すこと。**
 *
 * 積む側は、一度失われた電文が後続の取得では戻らないので成功で上書きして消してはいけない。
 * 置き換える側は、範囲が伸びるだけで縮まないため次の呼び出しの結果が前回を包含する ——
 * 積むと **①同じ壊れた電文を呼び出しの回数だけ数える ②取得が回復しても損失が消えない**
 * （アーカイブ本体の失敗は控えから外れて再試行され、429 なら普通に回復する）。
 */
export interface TelegramLoss {
  /** 取り込めなかった電文の通数。 */
  skippedTelegrams: number
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

export function createEmptyTelegramLoss(): TelegramLoss {
  return {
    skippedTelegrams: 0,
    failedSources: new Set(),
    rateLimitedSources: new Set(),
    rateLimitedTelegrams: 0,
  }
}

/**
 * 取得結果を損失に足し込む（取得元は集合なので二重計上されない）。
 *
 * 元の損失は書き換えない。`ReplayLoss` のように項目を足した型でもそのまま使えるよう、
 * 受け取った型を保って返す。
 */
export function addTelegramLoss<T extends TelegramLoss>(
  loss: T,
  skipped: number,
  failedSourceIds: readonly string[],
  rateLimited?: { sources?: readonly string[]; telegrams?: number },
): T {
  const failedSources = new Set(loss.failedSources)
  for (const id of failedSourceIds) failedSources.add(id)
  const rateLimitedSources = new Set(loss.rateLimitedSources)
  for (const id of rateLimited?.sources ?? []) rateLimitedSources.add(id)
  return {
    ...loss,
    skippedTelegrams: loss.skippedTelegrams + skipped,
    failedSources,
    rateLimitedSources,
    rateLimitedTelegrams: loss.rateLimitedTelegrams + (rateLimited?.telegrams ?? 0),
  }
}

/**
 * 取得結果**そのもの**を損失にする（積まない）。
 *
 * **その入れ物がその取得の結果だけを持つときに使う**（上の表を参照）。積むと、同じ壊れた電文を
 * 呼び出しの回数だけ数え、取得が回復しても損失が消えない。
 *
 * **前回より狭い範囲の結果で置き換えないこと。** 遡る日数は伸びるだけで縮まないという前提に
 * 乗っている。狭い範囲の結果を当てると、範囲の外で確定していた損失が黙って消える。
 */
export function telegramLossFrom(
  skipped: number,
  failedSourceIds: readonly string[],
  rateLimited?: { sources?: readonly string[]; telegrams?: number },
): TelegramLoss {
  return {
    skippedTelegrams: skipped,
    failedSources: new Set(failedSourceIds),
    rateLimitedSources: new Set(rateLimited?.sources ?? []),
    rateLimitedTelegrams: rateLimited?.telegrams ?? 0,
  }
}

export function isTelegramLossEmpty(loss: TelegramLoss): boolean {
  return loss.skippedTelegrams === 0 && loss.failedSources.size === 0
    && loss.rateLimitedSources.size === 0 && loss.rateLimitedTelegrams === 0
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
  const parts: string[] = []
  if (loss.failedSources.size > 0) parts.push(`${loss.failedSources.size} 件の取得元`)
  if (loss.skippedTelegrams > 0) parts.push(`${loss.skippedTelegrams} 件の電文`)
  return parts
}

/**
 * ライブの履歴取得で欠けた分を、地震タブに出す一文へ直す。何も欠けていなければ null。
 *
 * **1 件でも出す。** 取得元が「日」単位になったぶん、1 日落ちれば失う電文は多い。リプレイ側
 * （`formatLossNotice`）も 1 件から出しており、ライブだけ黙ると同じ障害が片方でしか見えない。
 *
 * **「取得し直す手立て」を必ず添える。** 自動では取り直さないため、添えないと打てる手が
 * 分からない（生成データの `MapDataStatus` と同じ書き方に揃えてある）。
 */
export function formatHistoryLossNotice(loss: TelegramLoss): string | null {
  const parts = describeTelegramLossParts(loss)
  if (parts.length === 0) return null
  return `${parts.join('・')}を取り込めませんでした（再読み込みで取得し直します）`
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
export const HISTORY_LOAD_MORE_FAILED_NOTICE = '続きの読み込みに失敗しました（もう一度お試しください）'

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
 * **兄弟の通知と違って、括弧の中に行動の案内を書いていない。** あちら 3 つ
 * （「再読み込みで取得し直します」「もう一度お試しください」「自動で再開します」）と
 * 揃っていないのは承知のうえで、**簡潔さを採った** —— 控えを端末へ残し、門を窓ごとの
 * 上限へ変えた今、この見送り自体がほとんど起きない（429 は「同じ id の取り直し」に返るもので、
 * 控えが効いていれば取り直さない）。**起きる頻度が上がったら、そのとき案内を足すこと。**
 *
 * **語順も `describeTelegramLossParts`（`N 件の取得元`）と逆**（こちらは `取得元N件`）。
 * 同じ画面に並びうるので、揃える判断もありうる。短さを採って揃えていない。
 */
export function formatRateLimitedNotice(loss: TelegramLoss): string | null {
  const parts: string[] = []
  if (loss.rateLimitedSources.size > 0) parts.push(`取得元${loss.rateLimitedSources.size}件`)
  if (loss.rateLimitedTelegrams > 0) parts.push(`電文${loss.rateLimitedTelegrams}件`)
  if (parts.length === 0) return null
  return `リクエスト過多のため、取得制限中（${parts.join('・')}が未取得）`
}
