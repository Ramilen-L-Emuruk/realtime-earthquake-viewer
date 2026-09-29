/**
 * ビルドバリアントごとの出力先。
 *
 * `vite.config.ts` の `build.outDir` と、ビルド後に出力を読む検査
 * （`scripts/check-precache-budget.ts`）が共有する。検査側が別に文字列を持つと、
 * 出力先を変えたときに**存在しないディレクトリを見て 0 件で通る**という静かな失敗になる。
 */
export function outDirForVariant(variant: string | undefined): string {
  return variant === 'dmdss' ? 'dist-dmdss' : 'dist'
}
