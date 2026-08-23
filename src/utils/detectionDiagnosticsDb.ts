/**
 * 揺れ検知の診断ログの保存先（IndexedDB）。
 *
 * 1 件あたり 61 秒ぶんの生の観測値（1725 観測点 × 61 文字）と観測点の座標を持つため 150KB 前後になる。
 * localStorage（5MB・同期・設定と同居）には置けないので IndexedDB を使う。上限
 * （`MAX_RECORDS`）を超えたら古いものから捨てる。
 *
 * **失敗しても本体を止めない。** プライベートモードや容量超過で IndexedDB が使えない環境がある。
 * 診断ログは無くても地震情報の表示には影響しないため、警告だけ出して黙って諦める（同じ警告が
 * 毎秒積み上がらないよう一度きりに絞る）。
 */
import { MAX_RECORDS, type DiagnosticRecord } from './detectionDiagnostics'
import { log } from './logger'

const DB_NAME = 'kyoshin-diagnostics'
const DB_VERSION = 1
const STORE = 'records'

/**
 * 保存に失敗したか。**利用者へ見せるために持つ。** 設定タブは件数しか出さないので、
 * 記録できていない端末（プライベートモード・容量超過・IndexedDB 無効）でも「0 件」と表示され、
 * 「まだ検知が起きていないだけ」と区別が付かない。
 */
let failed = false
/** 保存に失敗したことがあるか（設定タブが注記を出すのに使う）。 */
export function hasStorageError(): boolean {
  return failed
}

let warned = false
function warnOnce(message: string, e: unknown): void {
  failed = true
  notifyChanged()
  if (warned) return
  warned = true
  log.warn(`[diagnostics] ${message}`, e)
}

/** 記録が増減したときに呼ぶ購読者（設定タブの件数表示）。 */
const listeners = new Set<() => void>()
/** 記録の増減を購読する。戻り値を呼ぶと解除。 */
export function onRecordsChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function notifyChanged(): void {
  for (const cb of listeners) cb()
}

/**
 * 接続は 1 本だけ持って使い回す。
 *
 * **呼び出しごとに開くと接続が積み上がる。** 閉じないまま溜まった接続は、将来 `DB_VERSION` を
 * 上げたときに版の昇格を塞ぎ（`onblocked`）、`onupgradeneeded` も `onsuccess` も `onerror` も
 * 発火しないまま止まる。開いた接続を 1 本に保ち、版の変更要求が来たら自分から閉じる。
 */
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      }
      req.onsuccess = () => {
        const db = req.result
        // 別のタブが版を上げようとしたら道を空ける（次の呼び出しで開き直す）
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        resolve(db)
      }
      req.onerror = () => {
        warnOnce('IndexedDB を開けませんでした（診断ログは記録されません）', req.error)
        resolve(null)
      }
      req.onblocked = () => {
        warnOnce('IndexedDB の版を上げられませんでした（別のタブが開いています）', null)
        resolve(null)
      }
    } catch (e) {
      warnOnce('IndexedDB を開けませんでした（診断ログは記録されません）', e)
      resolve(null)
    }
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const req = run(db.transaction(STORE, mode).objectStore(STORE))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => {
            warnOnce('診断ログの読み書きに失敗しました', req.error)
            resolve(null)
          }
        } catch (e) {
          warnOnce('診断ログの読み書きに失敗しました', e)
          resolve(null)
        }
      }),
  )
}

/**
 * 1 件保存し、上限を超えた分を古い順に捨てる。
 *
 * 件数の確認に `count()` を使い、超えているときだけ全件を読む。**保存が集中するのは地震の最中**で、
 * そこで毎回 5MB を読むと検知エンジンや画面更新と同じスレッドを奪い合う。
 */
export async function saveRecord(record: DiagnosticRecord): Promise<void> {
  await tx('readwrite', (s) => s.put(record))
  notifyChanged()
  const n = await countRecords()
  if (n <= MAX_RECORDS) return
  const all = await listRecords()
  const excess = all.slice(0, all.length - MAX_RECORDS)
  for (const r of excess) await tx('readwrite', (s) => s.delete(r.id))
  notifyChanged()
}

/** 保存済みの記録をデータ時刻の昇順で返す。 */
export async function listRecords(): Promise<DiagnosticRecord[]> {
  const all = (await tx<DiagnosticRecord[]>('readonly', (s) => s.getAll() as IDBRequest<DiagnosticRecord[]>)) ?? []
  return all.sort((a, b) => a.dataTimeMs - b.dataTimeMs)
}

/** 保存済みの件数。 */
export async function countRecords(): Promise<number> {
  return (await tx<number>('readonly', (s) => s.count())) ?? 0
}

/** すべて消す。消せたかどうかを返す（呼び出し側が失敗を伝えられるように）。 */
export async function clearRecords(): Promise<boolean> {
  const ok = (await tx('readwrite', (s) => s.clear())) !== null
  notifyChanged()
  return ok
}
