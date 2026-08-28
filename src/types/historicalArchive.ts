import type { ReplayPayload } from './replay'

// 気象庁アーカイブに存在しない期間（DMDATA運用開始=2020年4月より前等）を再現するための
// ローカル収録データ。テスト時刻設定（App.tsx の fetchReplayEvents）が対象時刻をカバーする
// パックを見つけたら、DMDATA/P2PQuakeアーカイブの代わりにこちらから読む。
export interface HistoricalArchiveMeta {
  id: string          // ファイル名（拡張子なし）と一致させる
  label: string        // 設定タブの一覧に出す短い名前
  description: string  // 概要（震源要素・被害規模・出典等）
  from: string          // 収録範囲の開始（ISO、この時刻以降を対象時刻にできる）
  to: string            // 収録範囲の終了（ISO）
  firstEventTime: string // 収録している最初の報の時刻（ISO）。「再生」ボタン（1分前から開始）の起点
}

export interface HistoricalArchiveEntry {
  time: string  // 発表・発信時刻の絶対時刻（ISO）。テストシナリオの offsetMs と異なり相対シフトしない
  payload: ReplayPayload
  silent?: boolean
}

export interface HistoricalArchiveFile extends HistoricalArchiveMeta {
  entries: HistoricalArchiveEntry[]
}

export type HistoricalArchiveIndex = HistoricalArchiveMeta[]
