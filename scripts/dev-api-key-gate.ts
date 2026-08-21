/**
 * dev サーバーで DMDATA の API キーを自動投入してよいかを判定する。
 *
 * 判定材料をすべて引数で受け取り、`vite.config.ts` から切り離してあるのはユニットテストで
 * 固定するため。ここは「認証を持たない dev サーバーに実キーを載せない」ための最後の関門なので、
 * 条件を書き換えたときに CI が気づける形にしておく。
 *
 * 呼び出し側は `vite.config.ts` の `devApiKeyDefine`。自動投入の全体像は
 * `docs/spec/settings-pwa-spec.md` §6「dev サーバーでの API キー自動投入」を参照。
 */
export function shouldInjectDevApiKey(
  config: { command: string; isPreview?: boolean },
  isDmdssVariant: boolean,
  argv: readonly string[],
): boolean {
  // build には渡さない。`vite preview` も command が 'serve' になるため isPreview で別に弾く。
  if (config.command !== 'serve' || config.isPreview) return false
  // このキーを使うのは DMDSS 版だけ。使わない側のバンドルに値を配らない。
  if (!isDmdssVariant) return false
  // `--host` は LAN 公開。この dev サーバーは認証を持たない（実機計測フローが LAN 公開を使う。
  // scripts/perf/vite-plugin-perf-report.ts 参照）ため、公開時は自動投入をやめて手入力に委ねる。
  return !argv.some(a => a === '--host' || a.startsWith('--host='))
}
