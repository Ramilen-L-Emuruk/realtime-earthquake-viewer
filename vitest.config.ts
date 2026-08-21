import { defineConfig } from 'vitest/config'

// 純粋コア（kyoshinDetector 等）のユニットテスト用の最小構成。
// vite.config.ts（PWA プラグイン等）を読み込ませないよう独立設定にする。
// 検知コアは DOM 非依存のため node 環境で実行する。
export default defineConfig({
  test: {
    environment: 'node',
    // scripts 配下も対象にする（ビルド設定から切り出した純関数のテストが置かれる）。
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // テストのタイムアウトは既定（5 秒）のまま。混雑時に 5 秒を割りうる生成データローダの
    // テストだけが個別に延長している（理由は prefectures.test.ts のコメント）。
    // ここを全体で緩めると、無関係なテストに入り込んだ性能劣化を見逃す網になる。
  },
})
