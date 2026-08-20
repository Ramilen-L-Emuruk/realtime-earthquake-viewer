// リプレイ（過去の電文を時系列に流し直す機能）の共通型。
//
// 取得元はバリアントで異なるが、再生の仕組みは共通なのでここに型を置く。
//   - DMDSS 版: DMDATA の日次アーカイブ（services/dmdataReplay.ts）
//   - standard 版: P2PQuake の日付指定クエリ（services/p2pquakeReplay.ts）
//   - 実地震テストシナリオ: 収録済み JSON（utils/testScenarioReplay.ts）
import type { AppEvent, JMALpgm, JMANankai, JMANankaiCommentary, JMAKohatsu } from './earthquake'

export type ReplayPayload =
  | { kind: 'event'; event: AppEvent }
  | { kind: 'lpgm'; data: JMALpgm }
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'nankaiCommentary'; data: JMANankaiCommentary }
  | { kind: 'kohatsu'; data: JMAKohatsu }

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
   * 取り込めなかったアーカイブの URL（1 件でも成功していれば例外にはしない）。
   *
   * 件数ではなく URL を返すのは、呼び出し元が重複を除けるようにするため。本編と初期状態は
   * 日付範囲が重なるので同じアーカイブを両方が読む。取得自体は `archiveCache` により 1 回だが、
   * 件数で返すと呼び出し元が単純合算して実数の 2 倍を表示してしまう。
   *
   * これは DMDSS 版のアーカイブ取得に固有の概念。P2PQuake 経路は 1 日ぶんの取得が失敗した
   * 時点で例外にする（部分的に欠けたまま再生しない）ため、常に空配列を返す。
   */
  failedArchiveUrls: string[]
}
