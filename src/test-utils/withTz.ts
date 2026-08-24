/**
 * テストの間だけ時間帯を切り替える。**テスト専用**（アプリ本体からは参照しない）。
 *
 * `process.env.TZ` は Node が実行時に読み直すため、`getTimezoneOffset` だけでなく壁時計
 * （`getHours` 等）も一緒に動く。
 *
 * **`Date.prototype.getTimezoneOffset` を差し替えるだけでは足りない。** それだと壁時計が実行環境の
 * ままになるので、UTC で走る CI（`.github/workflows/deploy.yml` は `ubuntu-latest`・TZ 指定なし）では、
 * ローカル時刻で作る実装と UTC で作る実装の出力が一致してしまい、回帰を捕まえられない。
 *
 * テストファイルどうしに漏れないのは、vitest の pool が既定の `forks`（v3 以降）でファイルごとに
 * 別プロセスになるため。実測で確認している（別 PID・`isMainThread === true`）。**`threads` へ変えると
 * 同一ワーカー内で最初の `Date` 呼び出し時に時間帯が固定される**（V8/ICU のキャッシュ）ので、
 * pool を変えるならこの前提も見直すこと。
 *
 * @param tz IANA の時間帯名（`Asia/Tokyo` 等）
 * @param run その時間帯で走らせる処理
 */
export function withTz<T>(tz: string, run: () => T): T {
  const orig = process.env.TZ
  process.env.TZ = tz
  try {
    return run()
  } finally {
    // 元が未設定なら未設定へ戻す（空文字を入れると UTC 扱いになり、元の状態と変わってしまう）
    if (orig === undefined) delete process.env.TZ
    else process.env.TZ = orig
  }
}
