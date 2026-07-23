import { defineConfig } from 'vitest/config'

// 純粋コア（kyoshinDetector 等）のユニットテスト用の最小構成。
// vite.config.ts（PWA プラグイン等）を読み込ませないよう独立設定にする。
// 検知コアは DOM 非依存のため node 環境で実行する。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
