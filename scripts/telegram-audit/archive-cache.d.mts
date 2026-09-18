// `archive-cache.mjs` の型宣言。**実装は JS 側が正**で、ここはそれを TypeScript から
// 呼ぶための宣言だけ（`scripts/lib/stationSource.d.mts` と同じ扱い）。
//
// 実装を .ts へ移していないのは、監査スクリプト（`scripts/telegram-audit/*.mjs`）が
// 素の node から import する形を保つため。

/**
 * DMDATA の `/v2/archive` が返す 1 日分のアーカイブ。
 *
 * **中身は上流が決める**ので、使う側が必要な分だけ見る。日は `dayOf` で読むこと。
 */
export interface ArchiveItem {
  /** アーカイブが束ねる日（`2024-01-01`）。**`date` で返る応答もある**ので直接読まない */
  readonly datetime?: string
  readonly date?: string
  /** 本体（`.tar.gz`）の取得先 */
  readonly url: string
  /** 上流がアーカイブを作り直すと変わる。控えの名前に含める */
  readonly id?: string
}

/** `apiAuthHeader()` が組む認証ヘッダー。 */
export interface ArchiveAuth {
  readonly Authorization: string
}

/** 取得の実測値。「何件を控えで済ませたか」と「見ていない範囲」を分けて持つ。 */
export interface ArchiveCacheStats {
  /** 控えから読めた件数 */
  readonly cacheHits: number
  /** ネットワークへ出た件数 */
  readonly downloads: number
  /** 429 / 409 / 5xx で待ち直した回数 */
  readonly retryWaits: number
  readonly bytesDownloaded: number
  /** 取得できなかった範囲。**「0 件だった」と混ぜないため別に持つ** */
  readonly failures: readonly { classification: string; day: string; error: string }[]
}

/** 控えの置き場所（`DMDATA_ARCHIVE_CACHE` で変更できる）。 */
export const ARCHIVE_CACHE_DIR: string

/** 地震情報・津波・長周期地震動・推計震度分布図が入る分類。**呼び出し側で文字列を書かない。** */
export const EARTHQUAKE_CLASSIFICATION: string

/** API キーを読んで認証ヘッダーを組む。`DMDATA_API_KEY` か `.env.local` から取り、無ければ投げる。 */
export function apiAuthHeader(): ArchiveAuth

/** 一覧のアイテムが指す日。**`datetime ?? date` を呼び出し側で書き写さないため**に公開している。 */
export function dayOf(item: ArchiveItem): string

/**
 * アーカイブの一覧を全ページ辿って返す。
 *
 * **分類ごとに分かれている**（地震情報と津波は `telegram.earthquake`、緊急地震速報は
 * `eew.forecast` / `eew.warning`）。ページ上限に達した場合と取得に失敗した場合は投げる。
 */
export function listArchive(options: {
  classification: string
  from: string
  to: string
  auth: ArchiveAuth
}): Promise<ArchiveItem[]>

/** 1 日分のアーカイブを tar の中身（gzip を解いた Buffer）として返す。控えがあればそれを使う。 */
export function loadArchiveTar(options: {
  classification: string
  item: ArchiveItem
  auth: ArchiveAuth
}): Promise<Buffer>

/** tar の中身を順に返す。**同じ展開を自前で持たないこと**（同じ実装が増えると片方だけ直る日が来る）。 */
export function tarEntries(buf: Buffer): Generator<{ name: string; body: Buffer }>

/** 取得の実測値を読む。 */
export function archiveCacheStats(): ArchiveCacheStats

/** 走査の終わりに実測値を標準エラーへ出す。取りこぼしの報告は `incompleteness.mjs` の担当。 */
export function reportArchiveCacheStats(label?: string): void

/** テスト用。枠の予約・印の台帳・実測値をまとめて空にする。 */
export function resetArchiveCacheForTest(): void

/**
 * アーカイブを取るスクリプトの定型。本体を包み、**取得の実測値と取りこぼしの印を
 * 成功・失敗のどちらでも出す**（印が残って完走したときは終了コードを立てる）。
 *
 * `label` は同じスクリプトを引数違いで走らせる場合に変えること。
 */
export function runArchiveScript(label: string, build: () => Promise<void>): Promise<void>
