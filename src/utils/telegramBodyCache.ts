/**
 * DMDATA の電文本体（XML の原文）の控え（IndexedDB）。
 *
 * **配信元が名指しで求めている。** `data.api.dmdata.jp/v1/:id` は 50req/5min で、
 * リファレンスが「同じ`id`に対して短期間にリクエストを繰り返さないように実装してください」と
 * 明記している（→ [`docs/spec/data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2
 * 「リクエスト数を抑える」）。控えを持たなかった頃は、**起動のたびに同じ id を取り直していた**
 * （実測 2026-09-15: 1 起動で 85 件。**在庫で動く値**なので日をまたいだ測定とは直接比べられない）。
 *
 * **控えるのは XML の原文で、パース結果ではない。** パース結果を控えると、型を変えたときに
 * 中身が古いまま残る —— しかも生成物へ型を付け直して使う形なので**コンパイルは通り**、
 * 画面に出るまで気づけない。原文なら電文そのものなので陳腐化しない。
 *
 * **鍵は電文 id。** URL の末尾の id は電文ごとに一意で、内容が変われば別の id になる。
 *
 * **失敗しても本体を止めない。** プライベートモードや容量超過で IndexedDB が使えない環境がある。
 * 控えが無ければ通常の取得へ落ちるだけなので、警告を一度だけ出して黙って諦める
 * （構造は `detectionDiagnosticsDb.ts` と同じ方針）。
 */
import { log, createLogThrottle } from './logger'

const DB_NAME = 'dmdata-telegram-bodies'
const DB_VERSION = 1
/**
 * 目録（`{ id, bytes, lastUsedAt }`）と本体（`{ id, xml }`）を**別のストアに分ける**。
 *
 * **捨てる判断に本体を読みたくないため。** IndexedDB には「レコードの一部だけ読む」手段が無く、
 * 1 つのストアに同居させると、古い順に捨てるたびに全件の XML を読むことになる。
 * 電文の大きさは桁で違い（平常時の震度速報が 3KB 前後、各地の震度情報は観測点が数千点で
 * 500KB を超える）、**電文が集中して届く地震の最中に数十 MB を読む**形になって
 * 画面の更新と同じスレッドを奪い合う。目録だけなら 1 件数十バイトで済む。
 */
const STORE_META = 'meta'
const STORE_BODY = 'bodies'
/** 目録を古い順に辿るためのインデックス。 */
const INDEX_LAST_USED = 'lastUsedAt'

/**
 * 控える件数の上限。
 *
 * 起動 1 回で読むのは 90 件前後（地震 4 種別・津波・長周期・補助情報）。数回ぶんの起動と、
 * その間に届く新着を抱えられる幅を採った。
 */
export const MAX_ENTRIES = 600

/**
 * 控える合計バイト数の上限。
 *
 * **件数だけでは容量を読めない。** 上記のとおり電文の大きさは桁で違うので、件数の上限だけを
 * 置くと、大きい電文が並んだときに利用者の端末を無闇に使う。
 */
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024

/**
 * 読み取りで `lastUsedAt` を書き直す間隔。
 *
 * 古い順に捨てるには読むたびに時刻を更新したいが、**起動時に 90 件読むたびに 90 回書き込む**のは
 * 割に合わない。この幅より新しい記録は触らない —— 捨てる順序が多少ずれても、
 * 「最近の起動で読まれたものが残る」という性質は保たれる。
 */
const TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * 控えの有効期限。
 *
 * **電文 id は内容に対して不変**なので、原理上は無期限でよい —— 配信元の注意書き
 * 「同じ`id`に対して短期間にリクエストを繰り返さないように」自体が、id と内容が
 * 1 対 1 であることを前提にしている。それでも期限を置くのは、**その前提が崩れたときに
 * 気づく手立てが他に無い**ため（訂正報が同じ id を使い回す等、配信元の設計が変われば、
 * 無期限の控えは永久に古い内容を返し続ける。例外もログも出ない）。
 *
 * 起動時の再取得を防ぐ目的には数日で足りるが、「もっと見る」で数週間前まで遡ることを
 * 考えて 30 日を採った。
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 「控えたばかりのものを捨てた」と見なす幅。
 *
 * 上限に達した状態で大きい電文が続くと、**書き込むたびにパージが走り、直前に控えたものまで
 * 追い出される**（各地の震度情報は 1 通 500KB を超えるので、24MB の上限には数十件で届く）。
 * この状態では控えがほとんど効かないのに、件数の上限を守っているだけでは誰も気づけない。
 * **いちばん効いてほしい場面（大きい地震で電文が集中するとき）で起こる**ため、記録する。
 */
const THRASH_WINDOW_MS = 60_000

/** 目録の 1 件。**本体（`xml`）を持たない**（上記のとおり捨てる判断で読むため）。 */
interface MetaEntry {
  id: string
  /** `xml` のバイト数。合計の上限を見るのに使う。 */
  bytes: number
  /** 最後に読んだ（または書いた）時刻。古い順に捨てるのに使う。 */
  lastUsedAt: number
  /**
   * 控えた時刻。**有効期限の判定に使う**。
   *
   * `lastUsedAt` は読むたびに更新されるので期限には使えない（読み続ける限り永久に残る）。
   * 版を上げる前に控えた記録はこれを持たないので、無ければ `lastUsedAt` で代用する。
   */
  createdAt?: number
}

let failed = false
/**
 * いま控えが使えない状態か。**利用者へ見せるために持つ**（設定タブの「電文の控え」の注記）。
 *
 * **成功したら解除する。** 一度立てたままにすると、一時的な容量不足から回復したあとも
 * 「使えません」と出し続ける。伝えたいのは履歴ではなく現在の状態。
 */
export function hasTelegramCacheError(): boolean {
  return failed
}

/** パージの実測値。**控えが効かない状態を検知するために数える**（下記 `THRASH_WINDOW_MS`）。 */
const purgeStats = { purged: 0, purgedRecent: 0 }
/** 控えを捨てた件数（設定タブと検証で読む）。 */
export function telegramCachePurgeStats(): { purged: number; purgedRecent: number } {
  return { ...purgeStats }
}

/**
 * 控えが増減したときに呼ぶ購読者（設定タブの表示）。
 *
 * **通知はまとめる。** 起動時は 90 件前後が連続して書き込まれるので、1 件ごとに通知すると
 * 設定タブがその回数だけ描き直される（開いていなくてもマウントされている）。
 */
const listeners = new Set<() => void>()
let notifyTimer: ReturnType<typeof setTimeout> | null = null
function notifyChanged(): void {
  if (notifyTimer !== null) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    for (const cb of listeners) cb()
  }, 500)
}
/** 控えの増減を購読する。戻り値を呼ぶと解除。 */
export function onTelegramCacheChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

let warned = false
function warnOnce(message: string, e: unknown): void {
  failed = true
  if (warned) return
  warned = true
  log.warn(`[dmdata] ${message}`, e)
}
/** 読み書きが通ったら「使えない」を解除する。 */
function markUsable(): void {
  failed = false
}

// 上限に達している間はパージが続くので、毎回鳴らさず間引く
const warnThrashing = createLogThrottle(60_000)

/**
 * 接続は 1 本だけ持って使い回す。
 *
 * **呼び出しごとに開くと接続が積み上がる。** 閉じないまま溜まった接続は、将来 `DB_VERSION` を
 * 上げたときに版の昇格を塞ぎ（`onblocked`）、どのハンドラも発火しないまま止まる。
 */
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        // 古いブラウザ・IndexedDB を持たない実行環境。控えを持てないだけなので警告は出さない
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
        warnOnce('電文の控えを開けませんでした（毎回取得します）', req.error)
        resolve(null)
      }
      req.onblocked = () => {
        warnOnce('電文の控えの版を上げられませんでした（別のタブが開いています）', null)
        resolve(null)
      }
    } catch (e) {
      warnOnce('電文の控えを開けませんでした（毎回取得します）', e)
      resolve(null)
    }
  })
  return dbPromise
}

/**
 * ストアを 1 つ触る。
 *
 * **目録と本体を同時に変える操作は `bothStores` を使う。** 別々のトランザクションで書くと、
 * 片方だけ成功した状態（目録にあるのに本体が無い等）が残りうる。
 */
function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const req = run(db.transaction(store, mode).objectStore(store))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => {
            warnOnce('電文の控えの読み書きに失敗しました', req.error)
            resolve(null)
          }
        } catch (e) {
          warnOnce('電文の控えの読み書きに失敗しました', e)
          resolve(null)
        }
      }),
  )
}

/** 目録と本体を 1 つのトランザクションで触る（片方だけ書けた状態を作らない）。 */
function bothStores(run: (meta: IDBObjectStore, body: IDBObjectStore) => void): Promise<boolean> {
  return openDb().then(
    (db) =>
      new Promise<boolean>((resolve) => {
        if (!db) return resolve(false)
        try {
          const t = db.transaction([STORE_META, STORE_BODY], 'readwrite')
          run(t.objectStore(STORE_META), t.objectStore(STORE_BODY))
          t.oncomplete = () => resolve(true)
          t.onerror = () => {
            warnOnce('電文の控えの読み書きに失敗しました', t.error)
            resolve(false)
          }
          t.onabort = () => {
            warnOnce('電文の控えの書き込みが中断しました（容量超過の可能性）', t.error)
            resolve(false)
          }
        } catch (e) {
          warnOnce('電文の控えの読み書きに失敗しました', e)
          resolve(false)
        }
      }),
  )
}

/**
 * 控えから 1 件読む。無ければ `null`。
 *
 * 読めたら `lastUsedAt` を更新するが、**`TOUCH_INTERVAL_MS` より新しいものは触らない**
 * （起動時に 90 件読むたびに 90 回書き込まないため）。
 */
export async function readTelegramBody(id: string): Promise<string | null> {
  const body = await tx<{ id: string; xml: string } | undefined>(
    STORE_BODY, 'readonly', (s) => s.get(id) as IDBRequest<{ id: string; xml: string } | undefined>,
  )
  if (!body || typeof body.xml !== 'string') return null
  markUsable()

  const meta = await tx<MetaEntry | undefined>(
    STORE_META, 'readonly', (s) => s.get(id) as IDBRequest<MetaEntry | undefined>,
  )
  const now = Date.now()
  // **期限切れは使わない。** 控えた時刻を持たない記録（版を上げる前のもの）は
  // `lastUsedAt` で代用する。期限の意図は `MAX_AGE_MS` を見ること
  const bornAt = meta?.createdAt ?? meta?.lastUsedAt ?? 0
  if (bornAt > 0 && now - bornAt > MAX_AGE_MS) {
    void bothStores((m, b) => { m.delete(id); b.delete(id) })
    return null
  }
  if (meta && now - (meta.lastUsedAt ?? 0) > TOUCH_INTERVAL_MS) {
    // 更新の失敗は無視してよい（控えは読めているので、次に捨てる順序がずれるだけ）
    void tx(STORE_META, 'readwrite', (s) => s.put({ ...meta, lastUsedAt: now } satisfies MetaEntry))
  }
  return body.xml
}

/**
 * 控えへ 1 件書き、上限を超えた分を古い順に捨てる。
 *
 * **件数は `count()` で先に見て、超えているときだけ目録を走査する。** 上限付近では書き込みごとに
 * パージが走るため、ここで本体まで読む作りにすると重い（だから目録を分けてある）。
 */
export async function writeTelegramBody(id: string, xml: string): Promise<void> {
  // UTF-16 の概算。厳密な値は要らない（合計の上限を見る目安にしか使わない）
  const bytes = xml.length * 2
  const now = Date.now()
  const ok = await bothStores((meta, body) => {
    meta.put({ id, bytes, lastUsedAt: now, createdAt: now } satisfies MetaEntry)
    body.put({ id, xml })
  })
  if (!ok) return
  markUsable()
  notifyChanged()
  const n = (await tx<number>(STORE_META, 'readonly', (s) => s.count())) ?? 0
  if (n <= MAX_ENTRIES) {
    // 件数が上限以内でも、大きい電文が並べば合計は超えうる。目録は軽いので数える
    const bytesTotal = await totalBytes()
    if (bytesTotal <= MAX_TOTAL_BYTES) return
  }
  await purgeOldest()
}

/** 目録から合計バイト数を数える（本体は読まない）。 */
async function totalBytes(): Promise<number> {
  const all = (await tx<MetaEntry[]>(STORE_META, 'readonly', (s) => s.getAll() as IDBRequest<MetaEntry[]>)) ?? []
  return all.reduce((sum, e) => sum + (e.bytes ?? 0), 0)
}

/**
 * 古い順に捨てて、件数とバイト数の両方を上限以下へ戻す。
 *
 * **合計はここで数え直す。** 複数のタブが同じ控えを触るため、プロセス内に持った推定値は
 * ずれる。捨てるときだけ実際の値を見れば、ずれが積み上がらない。
 */
async function purgeOldest(): Promise<void> {
  const all = (await tx<MetaEntry[]>(STORE_META, 'readonly', (s) => s.getAll() as IDBRequest<MetaEntry[]>)) ?? []
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
  // **1 つのトランザクションでまとめて消す。** 1 件ずつ開くと、上限付近で書き込みが続いたときに
  // トランザクションの数だけ待ちが積み上がる
  const ok = await bothStores((meta, body) => {
    for (const victim of doomed) {
      meta.delete(victim)
      body.delete(victim)
    }
  })
  if (!ok) return

  // **捨てたことを数える。** 上限に達した状態が続くと控えはほとんど効かなくなるが、
  // 「上限を守っている」だけでは正常と見分けが付かない。**いちばん効いてほしい場面
  // （大きい地震で電文が集中するとき）で起こる**ので、痕跡を残す。
  notifyChanged()
  purgeStats.purged += doomed.length
  const now = Date.now()
  const recent = all
    .filter(e => doomed.includes(e.id))
    .filter(e => now - (e.createdAt ?? e.lastUsedAt ?? 0) < THRASH_WINDOW_MS).length
  if (recent > 0) {
    purgeStats.purgedRecent += recent
    warnThrashing(() => log.warn(
      `[dmdata] 電文の控えが上限に達しています（控えたばかりの ${recent} 件を捨てました / 累計 ${purgeStats.purgedRecent} 件）。`
      + '控えがほとんど効かず、同じ電文を取り直している可能性があります',
    ))
  }
}

/** 控えの件数と合計バイト数（設定タブの表示用）。**本体は読まない**。 */
export async function telegramCacheStats(): Promise<{ entries: number; bytes: number }> {
  const all = (await tx<MetaEntry[]>(STORE_META, 'readonly', (s) => s.getAll() as IDBRequest<MetaEntry[]>)) ?? []
  return { entries: all.length, bytes: all.reduce((sum, e) => sum + (e.bytes ?? 0), 0) }
}

/** すべて消す。消せたかどうかを返す。 */
export async function clearTelegramBodyCache(): Promise<boolean> {
  const ok = await bothStores((meta, body) => {
    meta.clear()
    body.clear()
  })
  notifyChanged()
  return ok
}
