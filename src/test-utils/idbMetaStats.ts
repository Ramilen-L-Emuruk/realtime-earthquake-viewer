// 控え（IndexedDB）の目録を、テストから直接数える。
//
// **本体のモジュールには数える口を持たせない。** 件数を返す関数はかつて設定タブの表示のために
// あったが、その表示を外したので本体からも外した（2026-10-05 ユーザー承認）。追い出しが効いているかは
// テストで確かめ続けたいので、テストの側から同じデータベースを開いて数える。
//
// 目録の各記録は `bytes` を持つ（`utils/telegramBodyCache.ts` と `utils/archiveBodyDb.ts` の `MetaEntry`）。

/** 目録ストアの名前。両方の控えで同じ。 */
const STORE_META = 'meta'

/** データベースの名前（本体のモジュールが持つ `DB_NAME` と揃える）。 */
export const TELEGRAM_CACHE_DB = 'dmdata-telegram-bodies'
export const ARCHIVE_CACHE_DB = 'dmdata-archive-bodies'

/** 目録の件数と合計バイト数を数える。 */
export function idbMetaStats(dbName: string): Promise<{ entries: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName)
    // **まだ無いデータベースを作らない。** ここで版 1 の空のデータベースを作ると、後から本体が
    // 同じ版で開いたときに作成処理（ストアの作成）が走らず、控えが壊れる。無ければ 0 件とする
    let missing = false
    open.onupgradeneeded = () => {
      missing = true
      open.transaction?.abort()
    }
    open.onerror = () => {
      if (missing) resolve({ entries: 0, bytes: 0 })
      else reject(open.error)
    }
    open.onsuccess = () => {
      const db = open.result
      // まだ一度も書いていなければストアが無い。それは 0 件として扱う
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.close()
        resolve({ entries: 0, bytes: 0 })
        return
      }
      const req = db.transaction(STORE_META, 'readonly').objectStore(STORE_META).getAll()
      req.onerror = () => { db.close(); reject(req.error) }
      req.onsuccess = () => {
        const all = req.result as { bytes?: number }[]
        db.close()
        resolve({ entries: all.length, bytes: all.reduce((sum, e) => sum + (e.bytes ?? 0), 0) })
      }
    }
  })
}
