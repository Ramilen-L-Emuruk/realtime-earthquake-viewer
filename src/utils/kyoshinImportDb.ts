/**
 * ブラウザで直接インポートしたK-NET/KiK-netイベント（生の`EventResult`）の保存先（IndexedDB）。
 *
 * 構造・失敗時の扱いは `detectionDiagnosticsDb.ts` と同じ方針（接続の使い回し・`onversionchange`
 * での失効・`tx()`ヘルパー・pub/sub）だが、以下の点が異なる:
 *   - ユーザーが手動でダウンロード・インポートしたデータであり、再取得の手間が大きい
 *     （診断ログと違い、失っても実害が無いものではない）ため、失敗はより積極的に可視化する。
 *   - 保存単位はマージ前の生の`EventResult`（1地震ぶん）。`mergeEvents`（`kyoshinEventMerge.ts`）は
 *     安価な純関数なので、複数イベントの統合は読み出すたびにやり直す設計にし、保存側は
 *     イベントの追加・削除だけを扱う単純な形にする。
 */
import { mergeEvents, type EventResult } from './knet/kyoshinEventMerge'
import type { LocalKyoshinArchive } from '../types/localKyoshinArchive'
import { log } from './logger'

const DB_NAME = 'kyoshin-imports'
const DB_VERSION = 1
const STORE = 'events'
const INDEX_BY_ARCHIVE = 'by_archiveId'

interface StoredKyoshinEvent {
  /** `${archiveId}:${originTimeJst}`。同じZIPの再インポートは上書きになる（冪等）。 */
  importId: string
  archiveId: string
  originTimeJst: string
  /** 設定タブでの表示用（インポート日時順の並び替え等には使わない）。 */
  importedAtMs: number
  event: EventResult
}

/** 保存に失敗したか。設定タブが「0件」と「記録できていない」を見分けるために使う。 */
let failed = false
export function hasImportStorageError(): boolean {
  return failed
}

let warned = false
function warnOnce(message: string, e: unknown): void {
  failed = true
  notifyChanged()
  if (warned) return
  warned = true
  log.warn(`[kyoshin-import] ${message}`, e)
}

/** 操作が実際に成功したときに呼ぶ。一度失敗した後でも回復したことをUIへ反映する。 */
function markRecovered(): void {
  if (!failed) return
  failed = false
  notifyChanged()
}

const listeners = new Set<() => void>()
/** インポート内容の増減を購読する。戻り値を呼ぶと解除。 */
export function onImportsChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function notifyChanged(): void {
  for (const cb of listeners) cb()
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'importId' })
          store.createIndex(INDEX_BY_ARCHIVE, 'archiveId')
        }
      }
      req.onsuccess = () => {
        const db = req.result
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        resolve(db)
      }
      req.onerror = () => {
        warnOnce('IndexedDBを開けませんでした（インポートしたデータは保存されません）', req.error)
        resolve(null)
      }
      req.onblocked = () => {
        warnOnce('IndexedDBの版を上げられませんでした（別のタブが開いています）', null)
        resolve(null)
      }
    } catch (e) {
      warnOnce('IndexedDBを開けませんでした（インポートしたデータは保存されません）', e)
      resolve(null)
    }
  })
  return dbPromise
}

/**
 * トランザクションを実行する。**失敗時はreject**する（`detectionDiagnosticsDb.ts`の`tx()`とは
 * ここが異なる）。診断ログと違い、ここで扱うのはユーザーが手動取得した再取得コストの高い
 * データなので、「本当に0件だった」と「読み書きに失敗した」を呼び出し側が区別できる必要がある
 * （区別せずnullへ丸めると、IndexedDB障害時に`getMergedKyoshinArchive`が常に「未インポート」を
 * 返し、`kyoshinLocalArchiveSource.ts`の障害可視化＝`setStalled(true)`が永久に発火しなくなる）。
 * UI表示用に「0件扱いでよい」呼び出し側（`countImportedEvents`等）は自分でcatchして丸める。
 */
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        if (!db) {
          // openDb()自身が失敗時にwarnOnceを呼び済みのため、ここでは二重に記録しない。
          reject(new Error('IndexedDBを開けませんでした'))
          return
        }
        try {
          const req = run(db.transaction(STORE, mode).objectStore(STORE))
          req.onsuccess = () => {
            markRecovered()
            resolve(req.result)
          }
          req.onerror = () => {
            warnOnce('インポートデータの読み書きに失敗しました', req.error)
            reject(req.error ?? new Error('IndexedDBの読み書きに失敗しました'))
          }
        } catch (e) {
          warnOnce('インポートデータの読み書きに失敗しました', e)
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }),
  )
}

/** 1イベントを保存する（同じ`importId`が既にあれば上書き）。保存できたかを返す。 */
export async function saveImportedEvent(archiveId: string, event: EventResult): Promise<boolean> {
  const record: StoredKyoshinEvent = {
    importId: `${archiveId}:${event.originTimeJst}`,
    archiveId,
    originTimeJst: event.originTimeJst,
    importedAtMs: Date.now(),
    event,
  }
  try {
    await tx('readwrite', (s) => s.put(record))
  } catch {
    return false
  }
  notifyChanged()
  return true
}

/**
 * 指定アーカイブに紐づく生イベントを、Origin Time昇順で返す。読み書きに失敗した場合はreject
 * する（`getMergedKyoshinArchive`が「0件」と区別して呼び出し元へ伝播できるようにするため。
 * 「0件扱いでよい」呼び出し側は自分でcatchすること）。
 */
export async function listImportedEvents(archiveId: string): Promise<EventResult[]> {
  const records = await tx<StoredKyoshinEvent[]>('readonly', (s) =>
    s.index(INDEX_BY_ARCHIVE).getAll(IDBKeyRange.only(archiveId)) as IDBRequest<StoredKyoshinEvent[]>,
  )
  return records
    .sort((a, b) => a.originTimeJst.localeCompare(b.originTimeJst))
    .map((r) => r.event)
}

/** 指定アーカイブに紐づく件数。設定タブの表示用のため、読み取りに失敗した場合は0件扱いにする
 * （失敗自体は`hasImportStorageError()`で別途可視化する）。 */
export async function countImportedEvents(archiveId: string): Promise<number> {
  try {
    return await tx<number>('readonly', (s) => s.index(INDEX_BY_ARCHIVE).count(IDBKeyRange.only(archiveId)))
  } catch {
    return 0
  }
}

/** 指定アーカイブに紐づくインポート済みイベントをすべて削除する。消せたかどうかを返す。 */
export async function deleteImportedEvents(archiveId: string): Promise<boolean> {
  let records: StoredKyoshinEvent[]
  try {
    records = await tx<StoredKyoshinEvent[]>('readonly', (s) =>
      s.index(INDEX_BY_ARCHIVE).getAll(IDBKeyRange.only(archiveId)) as IDBRequest<StoredKyoshinEvent[]>,
    )
  } catch {
    // 削除対象を確認できていないため、実際には0件でも「削除できた」と偽らない。
    return false
  }
  let ok = true
  for (const r of records) {
    try {
      await tx('readwrite', (s) => s.delete(r.importId))
    } catch {
      ok = false
    }
  }
  notifyChanged()
  return ok
}

/**
 * IndexedDBの生イベント一覧を読み、`mergeEvents`で統合済みアーカイブへ組み立てる。
 * インポート済みイベントが1件も無ければnull（呼び出し側は静的ファイルへフォールバックする）。
 * **読み取り自体に失敗した場合はrejectする**（呼び出し側 `kyoshinLocalArchiveSource.ts` の
 * `loadFromImportDb` が「未インポート」と区別して`setStalled(true)`を発火できるようにするため）。
 */
export async function getMergedKyoshinArchive(archiveId: string, stepSec: number): Promise<LocalKyoshinArchive | null> {
  const events = await listImportedEvents(archiveId)
  if (events.length === 0) return null
  const { stationOrder, siteCoords, frames } = mergeEvents(events, stepSec)
  return { id: archiveId, sites: siteCoords, stationCodes: stationOrder, frames }
}
