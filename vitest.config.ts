import { defineConfig } from 'vitest/config'

// 純粋コア（kyoshinDetector 等）のユニットテスト用の最小構成。
// vite.config.ts（PWA プラグイン等）を読み込ませないよう独立設定にする。
// 検知コアは DOM 非依存のため node 環境で実行する。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 生成データのローダ系テスト（prefectures / subregions / stationCoords 等 7 ファイル）は
    // vi.resetModules() + 動的 import でモジュールを作り直すため、全ファイルを並列実行すると
    // 変換コストが乗って既定の 5 秒を超えることがある（単体実行では 1 秒台で終わるものが、
    // 全体実行では実測 2.3〜5.3 秒まで振れる）。ハング検知の役目は残したいので無制限にはしない。
    //
    // これは対症療法で、全テストのハング検知が 5 秒 → 15 秒に遅れる副作用を一律で負う。CI のような
    // 遅い環境で再び境界に近づいたら、poolOptions で並列度を絞るか、resetModules 系だけを別
    // プロジェクトとして直列実行する方向で根治すること。
    testTimeout: 15_000,
  },
})
