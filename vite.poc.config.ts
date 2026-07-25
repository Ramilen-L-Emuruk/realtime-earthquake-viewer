import { defineConfig } from 'vite'
import { perfReportPlugin } from './scripts/perf/vite-plugin-perf-report'

// 【PoC専用・使い捨て】層B（フル解像度の線/面の描画負荷）の律速切り分け用の最小 vite 設定。
//
// 本体 vite.config.ts と違い react/PWA/サブパス base を外し、素の maplibre-gl ページ
// （poc/index.html）をノイズ無く配信する。狙いは「描画エンジンの素の負荷特性」を測ることなので、
// React の再レンダーや Service Worker のタイルキャッシュを計測に混ぜない。
//
// - base '/'      : サブパスの取り回しを排除（poc は http://<host>:<port>/poc/index.html で開く）
// - server.host   : 実機（Surface Go 2）から LAN 経由で開けるようにする
// - perfReportPlugin: 本体と同じ /__perf-script・/__perf-report を流用し計測証跡を集約する
//
// 起動: npx vite --config vite.poc.config.ts
export default defineConfig({
  base: '/',
  plugins: [perfReportPlugin()],
  server: { host: true },
  // maplibre-gl を依存最適化(pre-bundle)の対象外にする。pre-bundle されると
  // GeoJSON タイル化を担う web worker のロードが壊れ、line/circle が描画されない
  // （背景 raster は worker 不要なので描けてしまい切り分けにくい）。生 ESM を使わせて回避する。
  optimizeDeps: { exclude: ['maplibre-gl'] },
})
