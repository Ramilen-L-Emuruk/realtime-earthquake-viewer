/**
 * テストボタン用のデータ（`utils/testData.ts`）を**押されてから読む**ための入口。
 *
 * ## なぜ静的に取り込まないのか
 *
 * `testData.ts` が抱える実データ 5 本（`src/data/noto-honshin-2024-*.json` の 3 つと
 * `src/data/test-estimated-intensity.json`・`src/data/hyuganada-2022-quake.json`）は合わせて
 * 1.1 MB ある。静的に取り込むと
 * **テストボタンを一度も押さない利用者にも初回表示で届く**うえ、2026-09-09 にはメインバンドルが
 * Service Worker のプリキャッシュ上限
 * （`vite.config.ts` の `maximumFileSizeToCacheInBytes`＝2 MiB）を超えて本番ビルドが落ちた。
 *
 * **静的 import を 1 つでも戻すと分割は無言で解ける** —— 同じモジュールを静的に参照する箇所が
 * あれば Rollup はメインバンドルへ畳み込む。ビルドが上限に触れるまで気づけない。
 */

type TestDataModule = typeof import('./testData')
type TestDataImporter = () => Promise<TestDataModule>

/**
 * 実際の取り込み。**この形の `import()` がまとまりの切れ目を作る**ので、書き換えるときは
 * 静的 import へ倒れていないか確かめること。
 */
const defaultImporter: TestDataImporter = () => import('./testData')

let pending: Promise<TestDataModule> | null = null

/**
 * テストデータを読む（2 回目以降は読み込み済みのものを返す）。
 *
 * **失敗したら覚えない。** `??=` で握ったままにすると、一度 reject した Promise を以後ずっと
 * 返し続け、**ページを開き直すまで全てのテストボタンが無反応になる**。動的 import の失敗は
 * PWA では現実に起きる —— 画面を開いたまま新しい版がデプロイされると、古いハッシュ付きの
 * chunk が 404 になる。次に押したときに取り直せるよう、失敗は捨てる。
 */
export function loadTestData(importer: TestDataImporter = defaultImporter): Promise<TestDataModule> {
  if (!pending) {
    pending = importer().catch(err => {
      pending = null
      throw err
    })
  }
  return pending
}

/**
 * 先に読んでおく（設定タブを開いた時点で呼ぶ）。
 *
 * テストボタンを押してから読むと、**chunk の取得を待つあいだに初回履歴取得（REST）の応答が
 * 割り込み、テスト電文を上書きしうる**（履歴の取り込みは表示中のイベントを置き換える作りの
 * ため）。ボタンが並ぶ画面を開いた時点で読み始めておけば、押した時には解決済みで、待ちは
 * 静的に取り込んでいた頃と同じ「無し」に戻る。
 *
 * **失敗は握りつぶす。** これは前倒しにすぎず、本当に要るのは押されたときで、そのときに
 * `loadTestData()` が取り直す。ここで例外を投げると、設定タブを開いただけで画面が壊れる。
 */
export function prefetchTestData(importer: TestDataImporter = defaultImporter): void {
  void loadTestData(importer).catch(() => {})
}
