/**
 * Service Worker の precache に載せる 1 ファイルの上限と、その手前に置く予算。
 *
 * **上限そのものは vite-plugin-pwa が見ていて、超えるとビルドが exit 1 で落ちる。**
 * 困るのはそこではなく、上限すれすれで走っていることが誰にも見えないこと。実際 2026-09-25 から
 * 4 日間、main チャンクは上限の 99.8〜99.9%（余裕 2 kB 前後）で通り続けていて、次に足した
 * 変更でいきなりビルドが通らなくなった。予算はその状態を作らないために置く。
 *
 * 呼び出し側は 2 つ。`vite.config.ts`（上限と globPatterns を workbox へ渡す）と
 * `scripts/check-precache-budget.ts`（ビルド後にファイルを走査して予算と突き合わせる）。
 * 片方だけ書き換えると検査がすり抜けるので、値はここだけに置く。
 *
 * 全体像は `docs/spec/settings-pwa-spec.md` §5「キャッシュポリシー」を参照。
 */

/**
 * precache へ載せるファイルの拡張子。
 *
 * **`pbf` は地名ラベルの SDF グリフ**（`public/fonts/<stack>/`）。外すとオフライン時に
 * MapLibre が実行時のフォント生成へ落ち、字形がシステムフォントに変わる。
 *
 * 検査スクリプトはこの配列で dist 配下を走査する。glob のパターン文字列と別々に持つと、
 * 片方へ拡張子を足したときに検査の網だけが古いまま残る。
 */
export const PRECACHE_EXTENSIONS = [
  'js',
  'css',
  'html',
  'ico',
  'png',
  'svg',
  'woff2',
  'pbf',
] as const

/** workbox の `globPatterns` へ渡す形。 */
export const PRECACHE_GLOB_PATTERNS: readonly string[] = [
  `**/*.{${PRECACHE_EXTENSIONS.join(',')}}`,
]

/**
 * precache に載せる 1 ファイルの上限（workbox の既定と同値）。
 *
 * 明示するのは、暗黙の既定に依存すると「いつの間にか除外されていた」に気づけないため。
 * 超過時は vite-plugin-pwa がビルドを失敗させる（黙って除外はしない）。
 */
export const PRECACHE_MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * 上限のうち、ここを超えたら検査で止める割合。
 *
 * **1.0 にしない。** 上限ちょうどで止めるのは vite-plugin-pwa がすでにやっていて、
 * それでは「次の 1 コミットで詰む」状態を事前に知らせられない。0.85 なら残り約 300 kB あり、
 * 分割の段取りを組む余裕がある。
 */
export const PRECACHE_BUDGET_RATIO = 0.85

/** 予算の実数値（バイト）。 */
export const PRECACHE_BUDGET_BYTES = Math.floor(PRECACHE_MAX_FILE_BYTES * PRECACHE_BUDGET_RATIO)

export interface PrecacheFile {
  /** 出力ディレクトリからの相対パス（区切りは `/`）。 */
  readonly path: string
  readonly size: number
}

export interface PrecacheBudgetResult {
  /** 予算を超えたファイルが 1 つも無ければ true。 */
  readonly ok: boolean
  /** 大きい順に並べた全件。 */
  readonly files: readonly PrecacheFile[]
  /** 予算を超えたファイル（大きい順）。 */
  readonly over: readonly PrecacheFile[]
}

/**
 * Service Worker 自身かどうか。
 *
 * `sw.js` と `workbox-<hash>.js` は precache の中身ではなく、precache を配る側。
 * 走査の網には掛かるので、数える前に除く。
 */
export function isServiceWorkerAsset(path: string): boolean {
  return path === 'sw.js' || /^workbox-[0-9a-f]+\.js$/.test(path)
}

/** 予算と突き合わせる。判定だけを行い、入出力はしない（テストで固定するため）。 */
export function evaluatePrecacheBudget(
  files: readonly PrecacheFile[],
): PrecacheBudgetResult {
  const sorted = [...files].sort((a, b) => b.size - a.size)
  const over = sorted.filter(f => f.size > PRECACHE_BUDGET_BYTES)
  return { ok: over.length === 0, files: sorted, over }
}

const formatKiB = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`

const formatRatio = (bytes: number): string =>
  `${((bytes / PRECACHE_MAX_FILE_BYTES) * 100).toFixed(1)}%`

/**
 * 結果を人が読む形にする。
 *
 * **通ったときも最大ファイルと使用率を出す。** 予算内かどうかだけを出すと、
 * 82% まで来ていることが誰にも見えないまま次のビルドで 86% になる。
 */
export function formatPrecacheBudget(result: PrecacheBudgetResult, topN = 3): string {
  const lines: string[] = []
  const head = result.ok ? 'precache budget: ok' : 'precache budget: 予算超過'
  lines.push(
    `${head} — 上限 ${formatKiB(PRECACHE_MAX_FILE_BYTES)} / 予算 ${formatKiB(PRECACHE_BUDGET_BYTES)}` +
      `（上限の ${(PRECACHE_BUDGET_RATIO * 100).toFixed(0)}%）・対象 ${result.files.length} 件`,
  )
  for (const f of result.files.slice(0, topN)) {
    lines.push(`  ${formatKiB(f.size).padStart(12)}  ${formatRatio(f.size).padStart(6)}  ${f.path}`)
  }
  if (!result.ok) {
    lines.push('')
    lines.push('  予算を超えたファイルを分割すること。チャンクの分け方は vite.config.ts の manualChunks。')
    lines.push('  上限を引き上げて済ませないこと（理由は docs/spec/settings-pwa-spec.md §5）。')
  }
  return lines.join('\n')
}
