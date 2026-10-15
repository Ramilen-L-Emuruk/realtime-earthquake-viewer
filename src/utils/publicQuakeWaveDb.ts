import { createLogThrottle, log } from './logger'
import { planPublicWaveEviction, type PublicWaveEntryMeta } from './publicWaveStoreLogic'

/**
 * 地震カードの公開観測点の波形の控え（端末の IndexedDB）。保存庫（EarthScope）が返した miniSEED の生バイトを、
 * 観測点と地震の発生の組ごとに 1 件で持つ（`docs/public-waveform-design.md` §0・§6.1）。
 *
 * **控えるのは生バイトで、読み解いた列ではない**（`utils/archiveBodyDb.ts` と同じ理由）。読み方を変えたときに、
 * 古い形のまま残った解析結果を使い続けないため。
 *
 * **捨てる順は地震の発生が古い順**（最後に使った順ではない）。上限は 50 MB と件数（`publicWaveStoreLogic.ts`）。
 *
 * 作りは `archiveBodyDb.ts` に揃える —— 接続は 1 本を使い回す、目録と本体は 1 つのトランザクションで書く、
 * 開けない・書けないときは控えを持たないだけで動きは止めない。
 */

const DB_NAME = 'public-wave-bodies'
const DB_VERSION = 1
const STORE_META = 'meta'
const STORE_BODY = 'bodies'

interface BodyRow {
  readonly key: string
  readonly bytes: Uint8Array
}

/** 控えの鍵。観測点コードと地震の発生（ms）。同じ発生の別の地震は呼び出し側が見分ける。 */
export function publicWaveKey(stationCode: string, originMs: number): string {
  return `${stationCode}|${originMs}`
}

let warned = false
function warnOnce(message: string, e: unknown): void {
  if (warned) return
  warned = true
  log.warn(`[public-wave] ${message}`, e)
}
const warnLimitCheck = createLogThrottle(60_000)

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' })
        if (!db.objectStoreNames.contains(STORE_BODY)) db.createObjectStore(STORE_BODY, { keyPath: 'key' })
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
        warnOnce('公開観測点の波形の控えを開けませんでした（毎回取得します）', req.error)
        resolve(null)
      }
      req.onblocked = () => {
        warnOnce('公開観測点の波形の控えの版を上げられませんでした（別のタブが開いています）', null)
        resolve(null)
      }
    } catch (e) {
      warnOnce('公開観測点の波形の控えを開けませんでした（毎回取得します）', e)
      resolve(null)
    }
  })
  return dbPromise
}

function inTransaction<T>(mode: IDBTransactionMode, run: (meta: IDBObjectStore, body: IDBObjectStore) => () => T): Promise<{ value: T } | null> {
  return openDb().then(
    (db) =>
      new Promise<{ value: T } | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const t = db.transaction([STORE_META, STORE_BODY], mode)
          const finish = run(t.objectStore(STORE_META), t.objectStore(STORE_BODY))
          t.oncomplete = () => resolve({ value: finish() })
          t.onerror = () => {
            warnOnce('公開観測点の波形の控えの読み書きに失敗しました', t.error)
            resolve(null)
          }
          t.onabort = () => {
            warnOnce('公開観測点の波形の控えの読み書きが中断されました', t.error)
            resolve(null)
          }
        } catch (e) {
          warnOnce('公開観測点の波形の控えの読み書きに失敗しました', e)
          resolve(null)
        }
      }),
  )
}

/** 控えから 1 件読む。無ければ `null`。本体の無い項目（確かな不在）は `bytes: null`。 */
export async function readPublicWave(key: string): Promise<{ meta: PublicWaveEntryMeta; bytes: Uint8Array | null } | null> {
  const got = await inTransaction('readonly', (meta, body) => {
    const m = meta.get(key) as IDBRequest<PublicWaveEntryMeta | undefined>
    const b = body.get(key) as IDBRequest<BodyRow | undefined>
    return () => ({ meta: m.result, body: b.result })
  })
  const meta = got?.value.meta
  if (meta === undefined) return null
  const bytes: unknown = got!.value.body?.bytes
  // `instanceof Uint8Array` で見ない: 複製を作った側（IndexedDB の実装）と別の世界の型で返ることがあり、
  // そのとき本体があるのに「無い」に化ける（jsdom と fake-indexeddb の組み合わせで実際に起きた）
  return {
    meta,
    bytes: ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null,
  }
}

/**
 * 控えへ 1 件書き、上限を超えた分を地震の発生が古い順に捨てる。書けたかどうかを返す。
 * `bytes` が `null` なら本体を持たない項目（確かな不在）として書く。
 */
export async function writePublicWave(meta: Omit<PublicWaveEntryMeta, 'bytes'>, bytes: Uint8Array | null): Promise<boolean> {
  // 切り出しのビューは元のバッファ全体が書かれうるのでコピーして置く（`archiveBodyDb.ts` の `writeArchiveBody`）
  const owned = bytes === null ? null : bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
  const row: PublicWaveEntryMeta = { ...meta, bytes: owned?.byteLength ?? 0 }
  const ok = await inTransaction('readwrite', (m, b) => {
    m.put(row)
    if (owned === null) b.delete(meta.key)
    else b.put({ key: meta.key, bytes: owned } satisfies BodyRow)
    return () => true
  })
  if (ok === null) return false
  await evict()
  return true
}

/** 上限を超えた分を捨てる。**合計は毎回目録から数え直す**（複数のタブが同じ控えを触るため）。 */
async function evict(): Promise<void> {
  const all = await inTransaction('readonly', (m) => {
    const r = m.getAll() as IDBRequest<PublicWaveEntryMeta[]>
    return () => r.result
  })
  if (all === null) {
    // 読めなかったことを「上限以内」と同じに潰さない
    warnLimitCheck(() => log.warn('[public-wave] 公開観測点の波形の控えの上限を確かめられませんでした。古いものが捨てられない可能性があります'))
    return
  }
  const doomed = planPublicWaveEviction(all.value)
  if (doomed.length === 0) return
  await inTransaction('readwrite', (m, b) => {
    for (const key of doomed) {
      m.delete(key)
      b.delete(key)
    }
    return () => undefined
  })
}

/** すべて消す。消せたかどうかを返す。 */
export async function clearPublicWaveDb(): Promise<boolean> {
  const ok = await inTransaction('readwrite', (m, b) => {
    m.clear()
    b.clear()
    return () => true
  })
  return ok !== null
}
