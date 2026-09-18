/**
 * アーカイブ本体（`/v1/archive/:id`）の控え。**リプレイの開始をまたいで残る**。
 *
 * ## なぜ開始をまたいで残す必要があるのか
 *
 * かつてこの控えはメモリだけに持ち、**リプレイを開始するたびに丸ごと捨てていた**
 * （`dmdataReplay.ts` の `clearReplayCache`）。1 回再生するだけなら害は無いが、
 * **同じ日を何度も再生し直す使い方では、そのたびに同じファイルを取り直す**。
 *
 * 電文本体（`/v1/:id`）には控え（`telegramBodyCache.ts`）と 6 秒間隔の門
 * （`requestGate.ts`）が入っているが、**どちらもアーカイブ経路には掛かっていなかった**。
 * 過去の地震を再生する経路は最初から最後までアーカイブなので、保護が 1 つも効いていない。
 *
 * 実測（2026-09-16）。**区間ごとに開始し直す使い方**で数えた —— 8 日を跨ぐ 239 区間を
 * 順に再生する形:
 *
 * | | 区間ごとに捨てる（従来） | 開始をまたいで残す |
 * |---|---|---|
 * | リクエスト数 | 1,000〜3,800 | **落とす実数だけ**（8 日 × 分類 2 つ ＝ 16 本） |
 *
 * 落とす物は毎回同じ —— アーカイブ id は電文 id と同じく**内容に対して不変**で、
 * 内容が変われば別の id になる。配信元のリファレンスが
 * 「同じ`id`に対して短期間にリクエストを繰り返さないように実装してください」と
 * 明記している形そのものだった（→ [`docs/spec/data-sources-spec.md`](../../docs/spec/data-sources-spec.md)
 * §2「リクエスト数を抑える」）。
 *
 * ## バイト数は展開後の tar の長さで数える
 *
 * **エントリの合計ではない。** `utils/tarParser.ts` は `bytes.subarray(...)` を返すので、
 * 展開後のバッファへの**切り出し（ビュー）**になっている。1 エントリでも参照が残れば
 * バッファ全体が残るため、エントリの合計で数えると実際の使用量を下に見積もる
 * （tar のヘッダぶんだけ少なく出る、という程度の差ではない —— 使わなかったエントリの
 * 領域がまるごと数から漏れる）。
 *
 * ## メモリだけに持つ（IndexedDB へ置かない）
 *
 * 開始をまたいで残すだけで 3,800 → 16 まで落ちる。**そこから先の取り分は
 * 「タブを開き直したとき」に限られる**のに対し、置く物は数十 MB あるので採らなかった。
 * 電文本体を IndexedDB へ置いているのは、あちらが 1 通ずつ数百通に及び、
 * 控えが無いと起動のたびに 85 件取り直していたため —— 事情が違う。
 */
import { log, createLogThrottle } from './logger'

/**
 * 控える本数の上限。
 *
 * **下回らせてはいけない境界は「1 回のまとまった取得が同時に落とす本数」**。そこを割ると、
 * 同じ取得の中で追い出しが起き、**次の取得でまた落とし直す**——この控えを入れた意味が消える。
 * まとまった取得は 2 種類ある。
 *
 * | 取得 | 落とす本数 |
 * |---|---|
 * | リプレイの開始 | 3 つの窓（地震カードの履歴・最大 7 日／初期状態・24 時間／本編・1 時間）の和集合 × 分類 2 つ ＝ **最大 16 本** |
 * | 地震カードの「もっと見る」 | `MAX_HISTORY_DAYS`（59 日）× 分類 1 つ（`telegram.earthquake`）＝ **最大 59 本** |
 *
 * **後者を見落とすと足りない。** 「もっと見る」は押すたびに `maxDays` を 7 日伸ばして窓全体を
 * 組み直すので、控えに溜まる本数は押した回数ぶん積み上がる（**5 回押すだけで 32 本を越える**）。
 *
 * 2 つは同時に走らない（再生中は「もっと見る」を出さない）が、控えは両方を抱えうるので和で見る。
 *
 * **上の 16 本は「窓が重なったときの本数」で、境界テスト（`archiveBodyCache.test.ts`）は
 * 窓を独立に切り上げた 20 本で見積もる。** どちらも 96 を十分に下回るので値は変えていないが、
 * 16 を「保証された上限」と読まないこと —— 保証しているのはテストが導く側。
 */
export const MAX_ENTRIES = 96

/**
 * 控える合計バイト数（展開後）の上限。
 *
 * **実測から決めた値**（2026-09-16・目録の `fileSize` と実際の展開で確かめた。展開比は
 * 実測 3 本で ×11.5／×17.3／×18.1）。
 *
 * | まとまった取得 | 展開後の合計 |
 * |---|---|
 * | 8 日 × 分類 2 つ（区間ごとに開始し直す使い方でいちばん重い例） | 約 **55MB**（うち能登の本震当日の 2 分類だけで 30MB） |
 * | 「もっと見る」の最大 59 日 × 分類 1 つ | 約 **41MB**（**測れたのは 58 日ぶん** —— 60 日の範囲を指定して目録が返した日数。gz 合計 2.3MB・1 日の中央値は gz 0.01MB） |
 *
 * **地震の多い日が重く、ふだんの日は桁が違う**（能登の本震当日は `telegram.earthquake` が
 * gz 1.46MB → 展開 22MB・`eew.forecast` が gz 0.55MB → 展開 8MB で合わせて 30MB。
 * 中央値の日は 1 分類あたり gz 0.01MB）。日数ではなく「重い日を何本抱えるか」で決まる。
 *
 * 上記 `MAX_ENTRIES` と同じく、**下回らせてはいけない境界は「1 回のまとまった取得が
 * 同時に落とす量」**。2 つを足しても 96MB なので、そこに余裕を足した値を採った。
 *
 * DMDATA のアーカイブは 2020-11-18 以降しか無いので、これより重い日は
 * （東北地方太平洋沖地震のような規模が来なければ）現れない。
 */
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024

/**
 * 控えの有効期限。
 *
 * **アーカイブ id は内容に対して不変**なので、原理上は無期限でよい。当日ぶんは目録に現れず
 * 別の経路（`dmdataReplayLive.ts`）が受ける建て付けで、さらに呼び出し側が当日を
 * `cacheable: false` で弾いている（`dmdataReplay.ts` の `downloadArchive`）。
 *
 * それでも期限を置くのは、**配信元の設計が変わったときに気づく手立てを二重にしておく**ため。
 * 当日の弾き方は「目録に載った日付」を信じているので、**日付の意味が変わる形の変更には効かない**。
 * 電文本体の控えが 30 日の期限を置いているのと同じ考え。
 *
 * 12 時間にしたのは、切れたときの代償が「その窓の日数ぶんを取り直す」だけで済むため
 * （録画の通しなら 16 本・「もっと見る」を限界まで押した状態でも 59 本）。
 *
 * **ただし期限切れは、目録と電文のパース結果（上限も期限も持たない）との寿命の差を作る。**
 * そこで落とし直した本体は 1 バイトも読まれずに捨てられるので、呼び出し側は
 * **控えで読み切れる日の本体を落とさない**（`dmdataReplay.ts` の `ManifestPlan`）。
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000

/**
 * 「控えたばかりのものを追い出した」と見なす幅。
 *
 * 上限が足りていないと、開始のたびに追い出しと取り直しを繰り返す。**件数と合計を
 * 守っているだけでは正常と見分けが付かない**ので記録する（電文本体の控えと同じ理由）。
 */
const THRASH_WINDOW_MS = 60_000

/** 控えの 1 件。`files` は展開済みの tar の中身（ファイル名 → 内容）。 */
interface Entry {
  files: Map<string, Uint8Array>
  /** 展開後の tar の長さ。上記のとおりエントリの合計では数えない。 */
  bytes: number
  /**
   * 最後に読んだ（または書いた）順番。古い順に追い出すのに使う。
   *
   * **時刻ではなく単調な連番。** 1 回の再生開始は 3 つの窓ぶんのアーカイブを数ミリ秒のうちに
   * 並べて取るので、`Date.now()` で記録すると全件が同値になり、**読み直した印が効かない**
   * （同値を安定ソートすると挿入順になるため、いま使ったものから追い出す）。
   */
  usedSeq: number
  /** 控えた時刻。追い出しが早すぎないかの判定に使う。 */
  createdAt: number
}

/** 控えへ入れる 1 件（取得側が返すもの）。 */
export interface DownloadedArchive {
  files: Map<string, Uint8Array>
  /** 展開後の tar の長さ。 */
  bytes: number
  /**
   * 控えてよいか。既定は `true`。
   *
   * **「まだ育っているかもしれないファイル」を控えないための口。** 上記 `MAX_AGE_MS` が
   * 前提の崩れに気づくための時間の歯止めなのに対し、こちらは**呼び出し側が知っている事実で
   * 前もって外す**もの。渡された `false` は記録に残す（`uncacheable`）—— 現状の経路では
   * 立たないはずの値なので、立ったら前提が変わった印になる。
   */
  cacheable?: boolean
}

export interface ArchiveBodyCacheStats {
  /** 控えから返した回数。 */
  hits: number
  /** 取得した回数（＝実際に配信元へ出た回数）。 */
  misses: number
  /** 取得中のものへ相乗りした回数。 */
  coalesced: number
  /** 追い出した本数。 */
  evicted: number
  /** 期限切れで捨てた本数。 */
  expired: number
  /** そのうち、控えたばかりで追い出した本数。0 でなければ上限が足りていない。 */
  evictedRecent: number
  /** 呼び出し側が「控えるな」と言った本数（→ `DownloadedArchive.cacheable`）。 */
  uncacheable: number
  /** いま控えている本数と合計バイト数。 */
  entries: number
  bytes: number
}

export interface ArchiveBodyCache {
  /**
   * 控えから返す。無ければ `download` で取って控える。
   *
   * **同じ URL への同時要求は 1 本にまとめる。** 控えは「取り終わってから」効くので、
   * 並行する取得には間に合わない（本編・初期状態・履歴の 3 つの窓は日が重なるため、
   * 同じアーカイブを同時に要求するのが普通の状態）。
   */
  get: (url: string, download: () => Promise<DownloadedArchive>) => Promise<Map<string, Uint8Array>>
  stats: () => ArchiveBodyCacheStats
  /** テスト用。空にする。 */
  clear: () => void
}

export function createArchiveBodyCache(opts?: {
  maxEntries?: number
  maxTotalBytes?: number
  now?: () => number
}): ArchiveBodyCache {
  const maxEntries = opts?.maxEntries ?? MAX_ENTRIES
  const maxTotalBytes = opts?.maxTotalBytes ?? MAX_TOTAL_BYTES
  const now = opts?.now ?? (() => Date.now())

  const entries = new Map<string, Entry>()
  /** 読み直しの順番を刻む連番（時計の分解能に依らせないため。→ `Entry.usedSeq`）。 */
  let seq = 0
  const inFlight = new Map<string, Promise<Map<string, Uint8Array>>>()
  const counters = {
    hits: 0, misses: 0, coalesced: 0, evicted: 0, evictedRecent: 0, expired: 0, uncacheable: 0,
  }
  const warnThrashing = createLogThrottle(60_000)

  function totalBytes(): number {
    let sum = 0
    for (const e of entries.values()) sum += e.bytes
    return sum
  }

  /** 古い順に追い出して、本数とバイト数の両方を上限以下へ戻す。 */
  function evict(): void {
    if (entries.size <= maxEntries && totalBytes() <= maxTotalBytes) return
    // 古い順（`usedSeq` 昇順）
    const sorted = [...entries.entries()].sort((a, b) => a[1].usedSeq - b[1].usedSeq)
    let count = entries.size
    let bytes = totalBytes()
    const t = now()
    let recent = 0
    for (const [url, e] of sorted) {
      if (count <= maxEntries && bytes <= maxTotalBytes) break
      entries.delete(url)
      count--
      bytes -= e.bytes
      counters.evicted++
      if (t - e.createdAt < THRASH_WINDOW_MS) recent++
    }
    if (recent > 0) {
      counters.evictedRecent += recent
      warnThrashing(() => log.warn(
        `[replay] アーカイブの控えが上限に達しています（控えたばかりの ${recent} 本を追い出しました`
        + ` / 累計 ${counters.evictedRecent} 本）。同じアーカイブを取り直している可能性があります`,
      ))
    }
  }

  return {
    get(url, download) {
      const hit = entries.get(url)
      if (hit && now() - hit.createdAt > MAX_AGE_MS) {
        // 期限切れ。**`usedSeq` ではなく `createdAt` で見る** —— 読むたびに更新される値では、
        // 読み続けている限り永久に期限が来ない。
        entries.delete(url)
        counters.expired++
      } else if (hit) {
        counters.hits++
        hit.usedSeq = ++seq
        return Promise.resolve(hit.files)
      }
      const pending = inFlight.get(url)
      if (pending) {
        counters.coalesced++
        return pending
      }
      counters.misses++
      // **取得中の印を外すのは `finally` で行う（別のチェーンに分けない）。**
      // かつては `promise.catch(() => {}).then(() => inFlight.delete(url))` と書いていたが、
      // あれは `catch` が作った別の Promise へさらに繋ぐ形なので、**外すのが 1 マイクロタスク
      // 遅れる** —— 呼び出し側の `catch` が走る時点ではまだ印が残っており、そこで同じ URL を
      // （`await` を挟まずに）取り直すと、reject 済みの Promise を相乗りとして受け取って
      // **同じ失敗が即座に返る**。いまの呼び出し元はそう書いていないが、書いた瞬間に黙って壊れる。
      let settledSync = false
      const promise = (async () => {
        try {
          const got = await download()
          if (got.cacheable === false) {
            // 呼び出し側が「控えるな」と言っている。**取得はできているので値は返す。**
            counters.uncacheable++
            return got.files
          }
          const t = now()
          entries.set(url, { files: got.files, bytes: got.bytes, usedSeq: ++seq, createdAt: t })
          evict()
          return got.files
        } finally {
          settledSync = true
          inFlight.delete(url)
        }
      })()
      // **`download` が同期的に投げた場合は印を置かない。** 上の `finally` が `inFlight.set` より
      // 先に走ってしまうため、置くと reject 済みの Promise がそのまま残り、以後ずっと同じ失敗を返す。
      // いまの呼び出し元は `async` 関数を渡すので起きないが、この控えは他からも使える。
      if (!settledSync) inFlight.set(url, promise)
      return promise
    },
    stats: () => ({ ...counters, entries: entries.size, bytes: totalBytes() }),
    clear() {
      entries.clear()
      inFlight.clear()
      counters.hits = 0
      counters.misses = 0
      counters.coalesced = 0
      counters.evicted = 0
      counters.evictedRecent = 0
      counters.expired = 0
      counters.uncacheable = 0
    },
  }
}
