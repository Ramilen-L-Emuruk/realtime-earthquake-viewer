// 設定タブ「K-NETデータの取り込み」用フック。NIEDから利用者が手動でダウンロードした
// K-NET/KiK-netの生ZIPを受け取り、震度時系列を算出してIndexedDBへ保存する。
// 対応する収録済みアーカイブ（HistoricalArchiveMeta）は、ZIPヘッダーのOrigin Timeから自動検出する。
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HistoricalArchiveIndex } from '../types/historicalArchive'
import { findCoveringArchiveSync } from '../services/localArchiveReplay'
import { buildEventResultFromZip, parseJstTimestamp, STEP_SEC_DEFAULT, WINDOW_SEC_DEFAULT } from '../utils/knet/buildEventResultFromZip'
import { countImportedEvents, deleteImportedEvents, hasImportStorageError, onImportsChanged, saveImportedEvent } from '../utils/kyoshinImportDb'

export interface KyoshinImportSummary {
  archiveId: string
  label: string
  eventCount: number
}

export interface KyoshinImportFileError {
  fileName: string
  message: string
}

export interface UseKyoshinImportResult {
  /** インポート済みイベントが1件以上あるアーカイブだけを列挙する。 */
  summaries: KyoshinImportSummary[]
  /** ZIPの取り込み処理中か（削除中はここに含めない。ボタンの表示文言を取り違えないため）。 */
  importing: boolean
  /** 削除処理中のアーカイブID（同時に複数は削除できない前提）。削除中でなければnull。 */
  deletingArchiveId: string | null
  /** 直近の`importFiles`呼び出しで失敗したファイル（成功したファイルはここに含めない）。 */
  errors: KyoshinImportFileError[]
  /** 直近の`deleteArchive`呼び出しが失敗した場合のメッセージ。成功時・未実行時はnull。 */
  deleteError: string | null
  /**
   * 保存先に一度でも異常があったか。`summaries`は読み取り失敗時に0件へ丸めるため、
   * 「インポート済みデータが本当に無い」のか「保存先を読めていないだけ」なのかを、これで見分ける。
   */
  storageError: boolean
  importFiles: (files: FileList) => Promise<void>
  deleteArchive: (archiveId: string) => Promise<void>
}

export function useKyoshinImport(historicalArchives: HistoricalArchiveIndex): UseKyoshinImportResult {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [importing, setImporting] = useState(false)
  const [deletingArchiveId, setDeletingArchiveId] = useState<string | null>(null)
  const [errors, setErrors] = useState<KyoshinImportFileError[]>([])
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [storageError, setStorageError] = useState(false)

  const refresh = useCallback(() => {
    void Promise.all(historicalArchives.map(async (a) => [a.id, await countImportedEvents(a.id)] as const))
      .then((pairs) => {
        setCounts(Object.fromEntries(pairs))
        setStorageError(hasImportStorageError())
      })
  }, [historicalArchives])

  // 設定タブは常時マウントされたまま非表示になるだけなので、一定間隔で問い合わせる作りにすると
  // 開いていない間もIndexedDBを叩き続ける（DiagnosticLogRowと同じ理由でpub/subにする）。
  useEffect(() => {
    refresh()
    return onImportsChanged(refresh)
  }, [refresh])

  const summaries = useMemo<KyoshinImportSummary[]>(
    () => historicalArchives
      .map((a) => ({ archiveId: a.id, label: a.label, eventCount: counts[a.id] ?? 0 }))
      .filter((s) => s.eventCount > 0),
    [historicalArchives, counts],
  )

  const importFiles = useCallback(async (files: FileList) => {
    setImporting(true)
    try {
      // ファイルごとに独立してtry/catchする: 複数ファイルを一括選択した場合、1件の失敗
      // （対応するアーカイブが無い・破損したZIP等）で残りの取り込みを無駄にしないため
      // （capture-kyoshin-waveform.tsのイベント単位try/catchと同じ考え方）。
      const fileErrors: KyoshinImportFileError[] = []
      for (const file of Array.from(files)) {
        try {
          const zip = new Uint8Array(await file.arrayBuffer())
          const event = buildEventResultFromZip(zip, WINDOW_SEC_DEFAULT, STEP_SEC_DEFAULT)
          const originTime = parseJstTimestamp(event.originTimeJst)
          const meta = findCoveringArchiveSync(historicalArchives, originTime, new Date(originTime.getTime() + 1))
          if (!meta) {
            throw new Error(`この地震（${originTime.toLocaleString('ja-JP')}）に対応するデータが見つかりません`)
          }
          if (!(await saveImportedEvent(meta.id, event))) {
            throw new Error('保存に失敗しました（この端末では保存機能が使えない可能性があります）')
          }
        } catch (err) {
          fileErrors.push({ fileName: file.name, message: err instanceof Error ? err.message : String(err) })
        }
      }
      setErrors(fileErrors)
    } finally {
      setImporting(false)
    }
  }, [historicalArchives])

  const deleteArchive = useCallback(async (archiveId: string) => {
    setDeletingArchiveId(archiveId)
    setDeleteError(null)
    try {
      if (!(await deleteImportedEvents(archiveId))) {
        setDeleteError('削除に失敗しました（この端末では保存機能が使えない可能性があります）')
      }
    } finally {
      setDeletingArchiveId(null)
    }
  }, [])

  return { summaries, importing, deletingArchiveId, errors, deleteError, storageError, importFiles, deleteArchive }
}
