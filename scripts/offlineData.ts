import type { RuntimeCaching } from 'workbox-build'

/**
 * オフラインでも使えるよう、Service Worker の実行時キャッシュで控える生成データ（`public/data/`）。
 *
 * **事前キャッシュ（precache）には載せられない。** 拾う拡張子に `json` が無く、足しても
 * `subregions.json`（約 2.6 MiB）が 1 ファイルの上限 2 MiB を超えてビルドが落ちる
 * （`scripts/precacheBudget.ts`）。そこで、地図の初回表示で取りに行ったときの応答を
 * NetworkFirst で控え、通信できないときはその控えを返す。
 *
 * **Service Worker が働き始める前に取りに行った分は控えに無い。** 地図のデータは開いた直後に
 * 取りに行くので、初めて開いた回の分はまず入らず、2 回目に開いたときから控えができる
 * （初回訪問の取り直しは入れていない。2026-10-14 ユーザー承認）。
 *
 * 呼び出し側は `vite.config.ts`（`runtimeCaching` へ {@link offlineDataRuntimeCaching} を渡すだけ）と
 * `scripts/offlineData.test.ts`（`public/data/` の全ファイルとアプリが読む URL がどちらかへ分類されていること・
 * 規則の中身）。ファイル名・規則はここだけに置く。
 *
 * 全体像は `docs/spec/settings-pwa-spec.md` §5「キャッシュポリシー」。
 */

/**
 * 実行時キャッシュで控える生成データ（`public/data/` からの相対パス）。
 *
 * 地図の 7 本（地図の初回表示でまとめて要求するもの）・公開観測点の表・読み上げ辞書の 3 本
 * （2026-10-14 ユーザー承認「地図 7 本＋読み上げ辞書 3 本」）。
 */
export const OFFLINE_DATA_FILES = [
  // 地図
  'subregions.json',
  'prefectures.json',
  'tsunami-zones.json',
  'active-faults.json',
  'station-coords.json',
  'plate-boundaries.json',
  'tsunami-obs-coords.json',
  // 公開観測点（端末に控えた波形の名前・感度・運用期間をオフラインでも引く）
  'public-stations.json',
  // 読み上げ辞書
  'tts-phrase-break-dict.json',
  'tts-station-readings.json',
  'tts-epicenter-accents.json',
] as const

/**
 * 控えない生成データ（`public/data/` からの相対パス。`/` で終わるものはその配下すべて）。
 *
 * **新しく生成データを足したら、`OFFLINE_DATA_FILES` かここのどちらかへ必ず載せる。**
 * 載せ忘れは `scripts/offlineData.test.ts` が落とす。理由はオフライン対応の範囲を決めたときのもの
 * （2026-10-14 ユーザー承認。カタログ・履歴アーカイブは対象外）。
 */
export const OFFLINE_DATA_EXCLUDED: readonly { path: string; reason: string }[] = [
  { path: 'hypocenter/', reason: '長期震源カタログ（合計 約 34 MB）。眺めた年だけを取りに行く' },
  { path: 'historical-archives/', reason: 'ローカル履歴アーカイブ。再生するときだけ読む' },
  { path: 'historical-archives-kyoshin/', reason: '手元で生成した K-NET 由来の再生データ（Git 管理外）' },
  { path: 'test-scenarios/', reason: '実地震テストのシナリオ（Git 管理外）。再生するときだけ読む' },
]

/**
 * 実行時キャッシュの名前。**バリアントで分ける。**
 *
 * キャッシュの名前はオリジン全体で共有される。両方の版を同じブラウザで開くと、同じ名前では
 * 2 つの Service Worker が 1 つの控えへ書き込むことになり、どちらの版の控えかが名前から分からない。
 */
export function offlineDataCacheName(variant: string): string {
  return `generated-data-${variant}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 実行時キャッシュの規則に渡す URL の正規表現。
 *
 * **自分の配信パス（`base`）の直下の `data/` だけに当たる。** standard 版の `base`（`/yuremado/`）は
 * DMDSS 版（`/yuremado/dmdss/`）を包むので、`/data/` だけで当てると、standard 版の Service Worker が
 * DMDSS 版のページを制御している間（DMDSS 版を初めて開いたとき）に DMDSS 版の取得まで自分の控えへ入れる。
 *
 * 先頭が `/` なので、Workbox の規則（他オリジンの URL は先頭から一致したときだけ当たる）により
 * 他オリジンの URL には当たらない。
 */
export function offlineDataUrlPattern(base: string): RegExp {
  const names = OFFLINE_DATA_FILES.map(escapeRegExp).join('|')
  return new RegExp(`${escapeRegExp(base)}data/(?:${names})$`)
}

/**
 * 通信がこの秒数のうちに応答の頭を返さなければ、控えを返す（控えが無ければそのまま待つ）。
 *
 * **呼び出し側の時間切れより短くする。** 読み上げ辞書は 5 秒（`GENERATED_DICT_FETCH_TIMEOUT_MS`）で
 * 諦めるので、それより長いと「繋がっているのに応答が来ない回線」で控えに落ちる前に諦めてしまう。
 * 見ているのは応答の頭（ヘッダ）が届くまでで、本体を流し終えるまでではない。時間切れで控えを返した後も
 * 通信は続き、届けば控えを新しい版で置き換える。
 */
export const OFFLINE_DATA_NETWORK_TIMEOUT_SECONDS = 3

/**
 * 控えへ書く前に応答を検分する（Workbox の `cacheWillUpdate`）。
 *
 * 控えるのは「200 で・リダイレクトされておらず・HTML ではない」応答だけ。公衆無線 LAN の
 * ログイン画面のように、200 で HTML を返す回線に繋いだとき、正しい控えをその HTML で上書きしないため
 * （上書きされると、次にオフラインになったときに地図が出ない）。「JSON として配られたものだけ」に
 * 狭めないのは、配信元が `text/plain` などで配ったときに何も控えないまま黙って通るから（URL は規則で
 * `.json` に限ってある）。中身を `JSON.parse` まではしない（`subregions.json` は約 2.6 MiB あり、
 * 取得のたびに Service Worker で解析し直す重さに見合わない）。
 *
 * **この関数は Service Worker の中へ文字列として書き出される。外の変数・import を参照しないこと。**
 */
export async function offlineDataCacheWillUpdate({ response }: { response: Response }): Promise<Response | null> {
  if (response.status !== 200 || response.redirected) return null
  const type = response.headers.get('content-type') ?? ''
  return type.toLowerCase().includes('html') ? null : response
}

/** `vite.config.ts` の `runtimeCaching` へ渡す規則。 */
export function offlineDataRuntimeCaching(base: string, variant: string): RuntimeCaching {
  return {
    urlPattern: offlineDataUrlPattern(base),
    handler: 'NetworkFirst',
    options: {
      cacheName: offlineDataCacheName(variant),
      networkTimeoutSeconds: OFFLINE_DATA_NETWORK_TIMEOUT_SECONDS,
      plugins: [{ cacheWillUpdate: offlineDataCacheWillUpdate }],
    },
  }
}
