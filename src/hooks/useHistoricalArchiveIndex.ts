import { useEffect, useState } from 'react'
import type { HistoricalArchiveIndex } from '../types/historicalArchive'
import { listHistoricalArchives } from '../services/localArchiveReplay'

export interface UseHistoricalArchiveIndexResult {
  archives: HistoricalArchiveIndex
  /**
   * index.json の読み込みがまだ完了していないか。
   *
   * 起動直後、この一覧がまだ空のまま「確定」を押すと findCoveringArchiveSync が必ず
   * null を返し、ローカル履歴アーカイブが丸ごとスキップされて DMDATA/P2PQuake（そもそも
   * データの無い時代）へ問い合わせる的外れな経路に入ってしまう。呼び出し側（設定タブ）が
   * 読み込み中を理由に「確定」を待たせられるよう、空配列と区別して公開する。
   */
  isLoading: boolean
}

// 設定タブの「テスト時刻設定」に出す、収録済みローカル履歴アーカイブの一覧。
// fetchReplayEvents（App.tsx）にも同じ一覧を渡し、対象時刻がこの中の期間に該当すれば
// DMDATA/P2PQuakeアーカイブの代わりにこちらを再生する（localArchiveReplay.ts 参照）。
export function useHistoricalArchiveIndex(): UseHistoricalArchiveIndexResult {
  const [archives, setArchives] = useState<HistoricalArchiveIndex>([])
  const [isLoading, setIsLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    listHistoricalArchives().then((list) => {
      if (cancelled) return
      setArchives(list)
      setIsLoading(false)
    })
    return () => { cancelled = true }
  }, [])
  return { archives, isLoading }
}
