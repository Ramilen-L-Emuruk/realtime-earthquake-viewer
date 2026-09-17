// リプレイ（過去の電文を時系列に流し直す機能）の共通型。
//
// 取得元はバリアントで異なるが、再生の仕組みは共通なのでここに型を置く。
//   - DMDSS 版: DMDATA の日次アーカイブ（services/dmdataReplay.ts）
//   - standard 版: P2PQuake の日付指定クエリ（services/p2pquakeReplay.ts）
//   - 実地震テストシナリオ: 収録済み JSON（utils/testScenarioReplay.ts）
import type {
  AppEvent, JMAQuake, JMATsunami, JMALpgm, JMANankai, JMANankaiCommentary, JMAKohatsu,
  JMAQuakeNotice, JMAEarthquakeCount, JMAEstimatedIntensity,
} from './earthquake'

export type ReplayPayload =
  | { kind: 'event'; event: AppEvent }
  | { kind: 'lpgm'; data: JMALpgm }
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'nankaiCommentary'; data: JMANankaiCommentary }
  | { kind: 'kohatsu'; data: JMAKohatsu }
  | { kind: 'quakeNotice'; data: JMAQuakeNotice }
  | { kind: 'earthquakeCount'; data: JMAEarthquakeCount }
  /** 推計震度分布図（IXAC41）。**唯一の二進電文**で、分割配信されるため結合してから読む */
  | { kind: 'estimatedIntensity'; data: JMAEstimatedIntensity }

export interface ReplayEntry {
  payload: ReplayPayload
  /** この電文を発火させる再生時刻。 */
  replayTime: Date
  /** true なら音・通知を鳴らさずに状態だけ復元する（初期状態の再現に使う）。 */
  silent?: boolean
}

/**
 * 取得結果。取りこぼしの件数を呼び出し元へ返すため、電文の配列だけでなく
 * 「読めなかったもの」の数も添える。ログにしか出さないと、UI 上は
 * 「静かな時間帯だった」のか「取りこぼした」のかを区別できない。
 */
export interface ReplayFetchResult {
  entries: ReplayEntry[]
  /** 取り込めなかった電文の数（目録エントリの異常・本体の破損・パース失敗の合計）。 */
  skipped: number
  /**
   * 読めなかった取得元の識別子（1 つでも成功していれば例外にはしない）。
   *
   * アーカイブはその URL、アーカイブがまだ無い日を埋める当日経路は引けなかった一覧
   * （`live-telegram:<日>` 等）と全報を引けなかった EEW イベント（`eew:<eventId>`）。
   * その日ぶんが丸ごと読めなかった場合は `live:<JST 日付>`。
   *
   * 件数ではなく識別子を返すのは、呼び出し元が重複を除けるようにするため。本編と初期状態は
   * 日付範囲が重なるので同じアーカイブを両方が読む。取得自体は `archiveCache` により 1 回だが、
   * 件数で返すと呼び出し元が単純合算して実数の 2 倍を表示してしまう。
   *
   * これは DMDSS 版の取得に固有の概念。P2PQuake 経路は 1 日ぶんの取得が失敗した
   * 時点で例外にする（部分的に欠けたまま再生しない）ため、常に空配列を返す。
   *
   * **429 の窓で見送った取得元はここへ入れない**（→ `rateLimitedSources`）。
   */
  failedArchiveUrls: string[]
  /**
   * 429 の窓が明けるまで取りに行かなかった取得元の識別子（DMDSS 版のみ）。
   *
   * **`failedArchiveUrls` と分ける。** 混ぜると 3 つが壊れる:
   *
   * 1. **利用者に打てる手が違う。** 取得の失敗は再読み込みで直りうるが、こちらは窓が明けるまで
   *    （最長 30 分）待つのが正しい。同じ枠にすると「再読み込みで取得し直します」という
   *    案内が嘘になる
   * 2. **全滅判定の分母が変わる。** 「使おうとした取得元がすべて読めなかった」ときだけ例外に
   *    する仕組みは認証切れ・全断を捕まえるためのもので、こちら側の意図的な見送りを混ぜると、
   *    窓が広いあいだ**取れていた分ごと捨てる**
   * 3. 表示側が文面を分けられない
   */
  rateLimitedSources: string[]
  /**
   * 429 の窓が明けるまで取りに行かなかった**電文**の数。
   *
   * **`rateLimitedSources`（取得元）とは単位が違う**ので別に持つ。`skipped` と
   * `failedArchiveUrls` を分けているのと同じ理由で、表示側は「N 件の取得元」
   * 「M 件の電文」と単位を分けて出すため、混ぜると文面が嘘になる。
   *
   * **`skipped` にも数えない。** あちらは恒久的に失ったもので、こちらは待てば取れる。
   */
  rateLimitedTelegrams: number
}

/**
 * 地震カードの履歴を復元した結果。
 *
 * 「初期状態」（`ReplayFetchResult`）とは目的が違う。あちらは指定時刻の時点で発表中だった
 * 津波・EEW を再現するための遡り（24 時間）で、こちらは**カードの一覧をライブ接続時と
 * 同じ厚みにする**ための遡り。ライブは件数基準（50 件）で履歴を取るため、時間基準のまま
 * カードを作ると静かな日ほど一覧が痩せる。
 *
 * 電文は統合前の生の配列で返す。同一イベントの続報どうしの畳み込みは、ライブの履歴取得と
 * 同じ `mergeQuakeHistory` に任せる（経路ごとに畳み込み方が分かれると結果が食い違う）。
 */
export interface QuakeHistoryResult {
  quakes: JMAQuake[]
  /**
   * 同じ遡り幅で拾った津波電文（古い順）。
   *
   * **「いま発表中か」の判定は呼び出し側が持つ。** 期限の引き継ぎ・解除の照合・失効の予約は
   * イベント単位の判断で、電文を集めるここには置けない
   * （→ `tsunami-spec.md` §3「有効期限は報ではなく津波に付く」）。
   *
   * **地震の件数で打ち切らない。** 発表中の津波は数日前に出たものが続いていることがあり、
   * 地震のカードが揃った日で切ると拾えない。
   *
   * P2PQuake 経路は常に空配列。
   */
  tsunamis: JMATsunami[]
  /**
   * まだ遡れるか（目標件数に達して、読んでいない日が残っている）。
   *
   * 「もっと見る」の出し分けに使う。**打ち切ったときは真にしない** —— あれは「もう要らない」で、
   * 在庫が残っているかとは別の話。
   */
  hasMore: boolean
  /**
   * 地震カードと同じ遡り幅で復元する、地震情報以外の電文（種別ごとに最新 1 通へ畳んだもの）。
   *
   * **初期状態（24 時間）では足りないものがここへ入る。** 長周期地震動は地震ごとに紐づくので
   * カードの一覧と同じ厚みが要り、帯（地震回数・お知らせ・南海トラフ臨時情報／解説情報・
   * 後発地震注意情報）は 24 時間より長く画面に出続ける。**種別の列挙は
   * `HISTORY_EXTRA_TYPES` が単一情報源。** どれも取得済みのアーカイブに入っているので、
   * 拾うだけで追加の通信は要らない。
   *
   * 津波・緊急地震速報は入れない（「その時刻に発表中だったか」の判定は初期状態の担当で、
   * 遡り幅も目的も違う）。推計震度分布図も入れない（最新 1 通しか持たない設計で、遡っても
   * 過去のカードには紐づかない。理由は settings-pwa-spec.md §6）。
   *
   * P2PQuake 経路は常に空配列（これらの種別を配信しない）。
   */
  extras: ReplayEntry[]
  /** 取り込めなかった電文の数。 */
  skipped: number
  /**
   * 読めなかった取得元の識別子（DMDSS 版のみ。P2PQuake 経路は常に空配列）。
   *
   * アーカイブはその URL、アーカイブがまだ無い日を埋める当日経路は `live:<JST 日付>`。
   * 両者を 1 本の集合で持つのは全滅判定（共通原因の検出）を成立させるため
   * （`dmdataReplay.ts` の `liveSourceId` 参照）。
   *
   * **429 の窓で見送った取得元はここへ入れない**（→ `rateLimitedSources`）。
   */
  failedArchiveUrls: string[]
  /**
   * 429 の窓が明けるまで取りに行かなかった取得元の識別子（DMDSS 版のみ）。
   *
   * 分ける理由は `ReplayFetchResult.rateLimitedSources` と同じ。
   */
  rateLimitedSources: string[]
  /** 429 の窓で見送った**電文**の数（単位が違うので取得元とは別に持つ）。 */
  rateLimitedTelegrams: number
}
