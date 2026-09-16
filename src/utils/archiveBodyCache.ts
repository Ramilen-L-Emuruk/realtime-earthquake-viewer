/**
 * アーカイブ本体（`data.api.dmdata.jp/v1/archive/:id`）の控え。
 *
 * **配信元がこのエンドポイント固有に求めている。** `Archive Data v1` の「注意」にこうある ——
 * 「**同じ id に対して短期間にリクエストを繰り返さないように実装してください**」。
 *
 * 控えが無かった頃は**ページを再読込するたびに同じ日のアーカイブを取り直していた**
 * （`dmdataReplay.ts` の `archiveCache` はモジュールスコープの `Map` で、リロードで消える）。
 * 起動 1 回で 6〜7 件なので、開発中の連続リロードでも利用者の再読込でも、その形が成り立つ。
 *
 * **電文本体の控え（`telegramBodyCache.ts`）とは別の DB にしている。** 寿命も量も性質が違う:
 *
 * | | 電文本体 | アーカイブ本体 |
 * |---|---|---|
 * | 中身 | 1 通の XML | 1 日 × 1 分類の tar.gz |
 * | 大きさ | 数 KB〜数十 KB | 実測 gzip 10KB |
 * | 変わるか | 変わらない | 変わらない（生成後） |
 * | 件数の見込み | 起動あたり数十 | 最大 59 日 × 2 分類 |
 *
 * **上限を共有すると互いを追い出す。** 電文本体は大きい地震のとき一度に数十件増えるので、
 * 同じ枠に入れるとアーカイブが押し出され、次の起動で全部取り直すことになる。
 */
import { log, createLogThrottle } from './logger'

const DB_NAME = 'dmdata-archive-bodies'
const DB_VERSION = 1

const STORE_META = 'meta'
const STORE_BODY = 'bodies'
const INDEX_LAST_USED = 'lastUsedAt'

/**
 * 控える件数の上限。
 *
 * 「もっと見る」の上限は 59 日（`MAX_HISTORY_DAYS`）で、リプレイは 2 分類（`CLASSIFICATIONS`）を
 * 要求する。**59 × 2 ＝ 118 件を覆う値に余裕を足した。** 実測 gzip 10KB なので全部持っても
 * 1.5MB ほどで、容量よりも「取り直しを起こさないこと」を優先してよい。
 */
export const MAX_ENTRIES = 150

/**
 * 控える総バイト数の上限。
 *
 * 実測（gzip 10KB）から見れば 150 件で 1.5MB 程度だが、**大きい地震の日は電文が集中して
 * アーカイブも膨らむ**ので余裕を取る。`telegramBodyCache` の 24MB より小さいのは、
 * 1 件あたりが圧縮済みで済むため。
 */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024

/**
 * 控えの有効期限。
 *
 * アーカイブの中身は生成後に変わらないので、**古くなったから捨てるのではなく、
 * 読む見込みが無くなったから捨てる**。「もっと見る」の上限（59 日）より先に置く。
 */
const MAX_AGE_MS = 70 * 24 * 60 * 60 * 1000

/** 使った時刻を書き戻す間隔。毎回書くとトランザクションが増えるだけで得が無い。 */
const TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000

interface MetaEntry {
  id: string
  bytes: number
  createdAt: number
  lastUsedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null
let warnedOnce = false
const warnAtCapacity = createLogThrottle(60_000)

function warnOnce(message: string, e: unknown): void {
  if (warnedOnce) return
  warnedOnce = true
  log.warn(`[dmdata] ${message}`, e)
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        // IndexedDB を持たない実行環境（テストの node 環境など）。控えを持てないだけなので黙る
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'id' }).createIndex(INDEX_LAST_USED, 'lastUsedAt')
        }
        if (!db.objectStoreNames.contains(STORE_BODY)) {
          db.createObjectStore(STORE_BODY, { keyPath: 'id' })
        }
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
        warnOnce('アーカイブの控えを開けませんでした（毎回取得します）', req.error)
        resolve(null)
      }
      req.onblocked = () => {
        warnOnce('アーカイブの控えの版を上げられませんでした（別のタブが開いています）', null)
        resolve(null)
      }
    } catch (e) {
      warnOnce('アーカイブの控えを開けませんでした（毎回取得します）', e)
      resolve(null)
    }
  })
  return dbPromise
}

/** 1 つのストアに対する読み書き。失敗は `null` で返し、呼び出し側は通常の取得へ落ちる。 */
async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise<T | null>((resolve) => {
    try {
      const t = db.transaction(store, mode)
      const req = run(t.objectStore(store))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      t.onabort = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** meta と bodies をまとめて書き換える。成否だけ返す。 */
async function bothStores(run: (meta: IDBObjectStore, body: IDBObjectStore) => void): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise<boolean>((resolve) => {
    try {
      const t = db.transaction([STORE_META, STORE_BODY], 'readwrite')
      run(t.objectStore(STORE_META), t.objectStore(STORE_BODY))
      t.oncomplete = () => resolve(true)
      t.onerror = () => resolve(false)
      t.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

/**
 * 控えから読む。無ければ `null`。
 *
 * **有効期限を過ぎたものは返さず、その場で捨てる。**
 */
export async function readArchiveBody(id: string): Promise<Uint8Array | null> {
  const meta = await tx<MetaEntry | undefined>(STORE_META, 'readonly', s => s.get(id) as IDBRequest<MetaEntry | undefined>)
  if (!meta) return null
  const now = Date.now()
  if (now - (meta.createdAt ?? 0) > MAX_AGE_MS) {
    await bothStores((m, b) => { m.delete(id); b.delete(id) })
    return null
  }
  const row = await tx<{ id: string; bytes: Uint8Array } | undefined>(
    STORE_BODY, 'readonly', s => s.get(id) as IDBRequest<{ id: string; bytes: Uint8Array } | undefined>,
  )
  if (!row?.bytes) {
    // meta だけ残った半端な状態。次の書き込みで直るが、いまは控え無しとして扱う
    return null
  }
  // **使った時刻は間引いて書き戻す。** 毎回書くとトランザクションが増えるだけで得が無い
  if (now - (meta.lastUsedAt ?? 0) > TOUCH_INTERVAL_MS) {
    void tx(STORE_META, 'readwrite', s => s.put({ ...meta, lastUsedAt: now }) as IDBRequest<IDBValidKey>)
  }
  return row.bytes
}

/**
 * 控えへ書く。**失敗しても投げない**（控えられないだけで、取得そのものは成立している）。
 */
export async function writeArchiveBody(id: string, bytes: Uint8Array): Promise<void> {
  const now = Date.now()
  const meta: MetaEntry = { id, bytes: bytes.byteLength, createdAt: now, lastUsedAt: now }
  const ok = await bothStores((m, b) => {
    m.put(meta)
    b.put({ id, bytes })
  })
  if (!ok) return
  await purgeOldest()
}

/**
 * 上限を超えた分を古い順に捨てる。
 *
 * **捨てたことを記録する。** 上限に達した状態が続くと控えはほとんど効かなくなるが、
 * 「上限を守っている」だけでは正常と見分けが付かない。しかも**いちばん効いてほしい場面
 * （「もっと見る」を上限まで押したとき）で起こる**ので、痕跡を残す。
 */
async function purgeOldest(): Promise<void> {
  const all = (await tx<MetaEntry[]>(STORE_META, 'readonly', s => s.getAll() as IDBRequest<MetaEntry[]>)) ?? []
  if (all.length === 0) return
  // 古い順（`lastUsedAt` 昇順）。時刻を持たない壊れた記録は先に捨てる
  all.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
  let entries = all.length
  let bytes = all.reduce((sum, e) => sum + (e.bytes ?? 0), 0)
  const doomed: string[] = []
  for (const e of all) {
    if (entries <= MAX_ENTRIES && bytes <= MAX_TOTAL_BYTES) break
    doomed.push(e.id)
    entries--
    bytes -= e.bytes ?? 0
  }
  if (doomed.length === 0) return
  // **1 つのトランザクションでまとめて消す**（1 件ずつ開くと待ちが積み上がる）
  const ok = await bothStores((m, b) => {
    for (const victim of doomed) {
      m.delete(victim)
      b.delete(victim)
    }
  })
  if (!ok) return
  warnAtCapacity(() => log.warn(
    `[dmdata] アーカイブの控えが上限に達しています（${doomed.length} 件を捨てました`
    + ` / 上限 ${MAX_ENTRIES} 件・${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB）。`
    + '同じ日のアーカイブを取り直している可能性があります',
  ))
}

/** テスト用。控えを空にする。 */
export async function clearArchiveBodyCacheForTest(): Promise<void> {
  await bothStores((m, b) => { m.clear(); b.clear() })
}
