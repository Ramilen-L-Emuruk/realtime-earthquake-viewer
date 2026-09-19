/**
 * DMDATA のアーカイブ本体（`/v1/archive/:id`）の控え（IndexedDB）。
 *
 * **控えるのは配信元から受け取ったままの gzip。展開後ではない。**
 * 展開比は実測で ×11.5／×17.3／×18.1 あり、「もっと見る」の最大 59 日ぶんは
 * **gz 合計 2.3MB に対し展開後 41MB**。端末に置く物としては桁が違う。
 * 展開は読むたびにやり直せばよい（gunzip と tar の走査だけで、通信は伴わない）。
 *
 * **メモリの控え（`archiveBodyCache.ts`）の下に敷く二層目。** あちらは展開後を持っていて
 * 同じセッションの中では速いが、**タブを開き直すと空になる**。アプリの起動・リロード・
 * 録画で区間ごとに再生を開始し直す使い方では、そのたびにアーカイブを落とし直していた
 * （起動時の履歴 7 本・リプレイの開始 16 本）。
 *
 * **配信元が名指しで求めているのはこちら。** リファレンスは
 * 「同じ`id`に対して短期間にリクエストを繰り返さないように実装してください」と書いている
 * （→ [`docs/spec/data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2）。
 * 取得の間隔を空けることはこの要請に何も寄与しない —— 効くのは控えを持つことだけ。
 *
 * **鍵はアーカイブの URL。** 中に不変のアーカイブ id が入っているので内容に対して不変で、
 * メモリ層と同じ鍵になる（片方だけ別の鍵にすると、二層のどちらに当たったかを追いにくい）。
 *
 * **失敗しても本体を止めない。** プライベートモードや容量超過で IndexedDB が使えない環境がある。
 * 控えが無ければ通常の取得へ落ちるだけなので、警告を一度だけ出して黙って諦める
 * （構造は `telegramBodyCache.ts` と揃えてある）。
 */
import { log, createLogThrottle } from './logger'

const DB_NAME = 'dmdata-archive-bodies'
const DB_VERSION = 1
/**
 * 目録（`{ id, bytes, lastUsedAt }`）と本体（`{ id, gz }`）を**別のストアに分ける**。
 *
 * **捨てる判断に本体を読みたくないため。** IndexedDB には「レコードの一部だけ読む」手段が無く、
 * 1 つのストアに同居させると、古い順に捨てるたびに全件の gzip を読むことになる。
 * アーカイブ 1 本は地震の多い日で gz 1.46MB あり、目録だけなら 1 件数十バイトで済む。
 */
const STORE_META = 'meta'
const STORE_BODY = 'bodies'
/** 目録を古い順に辿るためのインデックス。 */
const INDEX_LAST_USED = 'lastUsedAt'

/**
 * 控える件数の上限。
 *
 * **バイト数の上限より先に効くことはほぼ無い**（gz は 1 日あたり中央値 0.01MB）。
 * 置いているのは、極端に小さいアーカイブが延々と積み上がる形を防ぐため。
 * アプリが遡れるのは地震カードで 59 日ぶんだが、リプレイは任意の過去日を再生できるので
 * 触る日数に上限が無い —— 録画で何百日を通しても収まる幅を採った。
 */
export const MAX_ENTRIES = 4000

/**
 * 控える合計バイト数（gzip のまま）の上限。
 *
 * **展開後ではなく gz で数える**（置いている物がそれなので）。実測では
 * 「もっと見る」の最大 59 日ぶんで gz 合計 2.3MB、地震の多い日でも 1 本 1.46MB。
 * 200MB あれば、録画で何百日を通しても追い出しは起きない。
 *
 * **下回らせてはいけない境界は「1 回のまとまった取得が同時に落とす量」** ——
 * そこを割ると同じ取得の中で追い出しが起き、次の取得でまた落とし直す（控えの意味が消える）。
 * いちばん重いリプレイの開始でも 16 本なので、桁で余裕がある。
 */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024

/**
 * 読み取りで `lastUsedAt` を書き直す間隔。
 *
 * 古い順に捨てるには読むたびに時刻を更新したいが、リプレイの開始で 16 本読むたびに
 * 16 回書き込むのは割に合わない。この幅より新しい記録は触らない —— 捨てる順序が多少
 * ずれても、「最近の再生で読まれたものが残る」という性質は保たれる。
 */
const TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * 控えの有効期限。
 *
 * **アーカイブ id は内容に対して不変**なので、原理上は無期限でよい。当日ぶんは目録に現れず
 * 別の経路が受ける建て付けで、さらに呼び出し側が当日を `cacheable: false` で弾いている。
 *
 * それでも期限を置くのは、**配信元の設計が変わったときに気づく手立てを二重にしておく**ため。
 * 当日の弾き方は「目録に載った日付」を信じているので、**日付の意味が変わる形の変更には効かない**。
 *
 * **メモリ層の 12 時間より長い 30 日を採る**（電文本体の控えと同じ値）。永続層の目的は
 * 「タブを開き直しても残る」ことなので、12 時間だと録画のように数日にわたる作業で切れてしまい、
 * 置いた意味が薄れる。
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 「控えたばかりのものを捨てた」と見なす幅。
 *
 * 上限が足りていないと、開始のたびに追い出しと取り直しを繰り返す。**件数と合計を
 * 守っているだけでは正常と見分けが付かない**ので記録する。
 */
const THRASH_WINDOW_MS = 60_000

/** 目録の 1 件。**本体（`gz`）を持たない**（上記のとおり捨てる判断で読むため）。 */
interface MetaEntry {
  id: string
  /** `gz` のバイト数。合計の上限を見るのに使う。 */
  bytes: number
  /** 最後に読んだ（または書いた）時刻。古い順に捨てるのに使う。 */
  lastUsedAt: number
  /**
   * 控えた時刻。**有効期限の判定に使う**。
   *
   * `lastUsedAt` は読むたびに更新されるので期限には使えない（読み続ける限り永久に残る）。
   */
  createdAt?: number
}

let failed = false
/**
 * いま控えが使えない状態か。
 *
 * **成功したら解除する。** 一度立てたままにすると、一時的な容量不足から回復したあとも
 * 「使えません」のままになる。伝えたいのは履歴ではなく現在の状態。
 */
export function hasArchiveCacheError(): boolean {
  return failed
}

/** パージの実測値。**控えが効かない状態を検知するために数える**。 */
const purgeStats = { purged: 0, purgedRecent: 0 }

/**
 * 上限を確かめる読み取りが失敗した回数。
 *
 * **「読めなかった」と「0 件だった」を潰さないために数える。** IndexedDB の読みは
 * 一時的に失敗しうる（容量の端境・別タブとの競合）。そのとき件数を 0 として扱うと、
 * **上限を超えているのに追い出しが走らない**まま肥大化する経路ができる。
 *
 * **`warnOnce` では足りない。** あちらは一度鳴らすと二度と鳴らないので、
 * 繰り返し起きていることが記録に残らない。
 */
const readFailures = { limitCheck: 0 }

/** 控えを捨てた件数と、上限の確認に失敗した回数（設定タブと検証で読む）。 */
export function archiveCachePurgeStats(): { purged: number; purgedRecent: number; limitCheckFailures: number } {
  return { ...purgeStats, limitCheckFailures: readFailures.limitCheck }
}

/**
 * 控えが増減したときに呼ぶ購読者（設定タブの表示）。
 *
 * **通知はまとめる。** リプレイの開始では 16 本が続けて書き込まれるので、
 * 1 件ごとに通知すると設定タブがその回数だけ描き直される（開いていなくてもマウントされている）。
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
export function onArchiveCacheChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

let warned = false
function warnOnce(message: string, e: unknown): void {
  failed = true
  if (warned) return
  warned = true
  log.warn(`[replay] ${message}`, e)
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
            warnOnce('アーカイブの控えの読み書きに失敗しました', req.error)
            resolve(null)
          }
        } catch (e) {
          warnOnce('アーカイブの控えの読み書きに失敗しました', e)
          resolve(null)
        }
      }),
  )
}

/**
 * 目録と本体を 1 つの読み取りトランザクションでまとめて引く。
 *
 * **別々に開かない。** 1 件読むたびにトランザクションを 2 回張ると、その往復が
 * リプレイの開始（最大 16 本）や履歴の取得（最大 59 本）の本数だけ積み上がる ——
 * **この控えは速くするために置いたもの**なので、そこで往復を増やすのは本末転倒。
 */
function readBoth(key: string): Promise<{ body?: { id: string; gz: Uint8Array }; meta?: MetaEntry } | null> {
  return openDb().then(
    (db) =>
      new Promise<{ body?: { id: string; gz: Uint8Array }; meta?: MetaEntry } | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const t = db.transaction([STORE_META, STORE_BODY], 'readonly')
          const bodyReq = t.objectStore(STORE_BODY).get(key) as IDBRequest<{ id: string; gz: Uint8Array } | undefined>
          const metaReq = t.objectStore(STORE_META).get(key) as IDBRequest<MetaEntry | undefined>
          t.oncomplete = () => resolve({ body: bodyReq.result, meta: metaReq.result })
          t.onerror = () => {
            warnOnce('アーカイブの控えの読み取りに失敗しました', t.error)
            resolve(null)
          }
          t.onabort = () => {
            warnOnce('アーカイブの控えの読み取りが中断されました', t.error)
            resolve(null)
          }
        } catch (e) {
          warnOnce('アーカイブの控えの読み取りに失敗しました', e)
          resolve(null)
        }
      }),
  )
}

/** 目録と本体を 1 つのトランザクションで触る（片方だけ成功した状態を作らない）。 */
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
            warnOnce('アーカイブの控えの読み書きに失敗しました', t.error)
            resolve(false)
          }
          t.onabort = () => {
            warnOnce('アーカイブの控えの読み書きが中断されました', t.error)
            resolve(false)
          }
        } catch (e) {
          warnOnce('アーカイブの控えの読み書きに失敗しました', e)
          resolve(false)
        }
      }),
  )
}

/**
 * 控えから 1 件読む（gzip のまま）。無ければ `null`。
 *
 * 読めたら `lastUsedAt` を更新するが、**`TOUCH_INTERVAL_MS` より新しいものは触らない**。
 */
export async function readArchiveBody(key: string): Promise<Uint8Array | null> {
  // **本体と目録は 1 つのトランザクションで引く**（理由は `readBoth`）。
  const got = await readBoth(key)
  const body = got?.body
  if (!body || !(body.gz instanceof Uint8Array)) return null
  markUsable()

  const meta = got?.meta
  const now = Date.now()
  // **期限切れは使わない**（意図は `MAX_AGE_MS`）。控えた時刻を持たない記録は `lastUsedAt` で代用する
  const bornAt = meta?.createdAt ?? meta?.lastUsedAt ?? 0
  if (bornAt > 0 && now - bornAt > MAX_AGE_MS) {
    void bothStores((m, b) => { m.delete(key); b.delete(key) })
    return null
  }
  if (meta && now - (meta.lastUsedAt ?? 0) > TOUCH_INTERVAL_MS) {
    // 更新の失敗は無視してよい（控えは読めているので、次に捨てる順序がずれるだけ）
    void tx(STORE_META, 'readwrite', (s) => s.put({ ...meta, lastUsedAt: now } satisfies MetaEntry))
  }
  return body.gz
}

/**
 * 控えへ 1 件書き、上限を超えた分を古い順に捨てる。
 *
 * **バッファ全体を抱えているビューはコピーしてから置く。** `Uint8Array` を構造化クローンで
 * 保存すると、`byteOffset` を持つ切り出しでも**元のバッファ全体が書き込まれる**ことがある。
 * いまの呼び出し元は取得した本体をそのまま渡すので該当しないが、切り出しを渡す経路が
 * できたときに、置いた覚えのない大きさが黙って積み上がる。
 */
export async function writeArchiveBody(key: string, gz: Uint8Array): Promise<void> {
  const owned = gz.byteOffset === 0 && gz.byteLength === gz.buffer.byteLength ? gz : gz.slice()
  const bytes = owned.byteLength
  const now = Date.now()
  const ok = await bothStores((meta, body) => {
    meta.put({ id: key, bytes, lastUsedAt: now, createdAt: now } satisfies MetaEntry)
    body.put({ id: key, gz: owned })
  })
  if (!ok) return
  markUsable()
  notifyChanged()

  // **読み取りの失敗を「0 件」に潰さない。** 潰すと「上限を超えているのに読めなかった」が
  // 「上限以内」と同じ扱いになり、**追い出しが黙って走らなくなる**。
  // 読めなかったときは数えたうえで追い出しを試みる側へ倒す（`purgeOldest` が読めれば直る）。
  const n = await tx<number>(STORE_META, 'readonly', (s) => s.count())
  if (n === null) {
    readFailures.limitCheck++
  } else if (n <= MAX_ENTRIES) {
    // 件数が上限以内でも、大きいアーカイブが並べば合計は超えうる。目録は軽いので数える
    const bytesTotal = await totalBytes()
    if (bytesTotal === null) readFailures.limitCheck++
    else if (bytesTotal <= MAX_TOTAL_BYTES) return
  }
  await purgeOldest()
}

/**
 * 目録から合計バイト数を数える（本体は読まない）。**読めなければ `null`。**
 *
 * 「0 バイトだった」と区別する（→ `readFailures`）。
 */
async function totalBytes(): Promise<number | null> {
  const all = await tx<MetaEntry[]>(STORE_META, 'readonly', (s) => s.getAll() as IDBRequest<MetaEntry[]>)
  if (all === null) return null
  return all.reduce((sum, e) => sum + (e.bytes ?? 0), 0)
}

/**
 * 古い順に捨てて、件数とバイト数の両方を上限以下へ戻す。
 *
 * **合計はここで数え直す。** 複数のタブが同じ控えを触るため、プロセス内に持った推定値は
 * ずれる。捨てるときだけ実際の値を見れば、ずれが積み上がらない。
 */
async function purgeOldest(): Promise<void> {
  const all = await tx<MetaEntry[]>(STORE_META, 'readonly', (s) => s.getAll() as IDBRequest<MetaEntry[]>)
  // **ここでも「読めなかった」と「0 件」を潰さない。** 潰すと、上限超えと判定されて
  // 呼ばれたのに**何も消さずに黙って返る** —— しかも数えていないので、
  // 追い出しが機能していないことがどの記録にも出ない（`readFailures` と同じ枠で数える）。
  if (all === null) {
    readFailures.limitCheck++
    return
  }
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

  notifyChanged()
  purgeStats.purged += doomed.length
  const now = Date.now()
  const doomedSet = new Set(doomed)
  const recent = all
    .filter(e => doomedSet.has(e.id))
    .filter(e => now - (e.createdAt ?? e.lastUsedAt ?? 0) < THRASH_WINDOW_MS).length
  if (recent > 0) {
    purgeStats.purgedRecent += recent
    warnThrashing(() => log.warn(
      `[replay] アーカイブの控え（端末）が上限に達しています（控えたばかりの ${recent} 本を捨てました`
      + ` / 累計 ${purgeStats.purgedRecent} 本）。同じアーカイブを取り直している可能性があります`,
    ))
  }
}

/**
 * 控えの件数と合計バイト数。**本体は読まない**。読めなければ `null`。
 *
 * **「0 本」と「読めなかった」を分ける。** 潰すと、読みが失敗した瞬間だけ画面が
 * 「0 本 / 0.0 MB」と言い、控えが空になったかのように見える。
 */
export async function archiveBodyDbStats(): Promise<{ entries: number; bytes: number } | null> {
  const all = await tx<MetaEntry[]>(STORE_META, 'readonly', (s) => s.getAll() as IDBRequest<MetaEntry[]>)
  if (all === null) return null
  return { entries: all.length, bytes: all.reduce((sum, e) => sum + (e.bytes ?? 0), 0) }
}

/** すべて消す。消せたかどうかを返す。 */
export async function clearArchiveBodyDb(): Promise<boolean> {
  const ok = await bothStores((meta, body) => {
    meta.clear()
    body.clear()
  })
  // **成功したときだけ知らせる**（`writeArchiveBody` / `purgeOldest` と揃える）。
  if (ok) notifyChanged()
  return ok
}
