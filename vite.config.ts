import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { perfReportPlugin } from './scripts/perf/vite-plugin-perf-report'

const variant = process.env.VITE_VARIANT ?? 'standard'
const isDmdss = variant === 'dmdss'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
)

// DMDSS版は /dmdss/ サブパスに配信。base が異なるため SW スコープも自動で分離される。
const base = isDmdss
  ? '/realtime-earthquake-viewer/dmdss/'
  : '/realtime-earthquake-viewer/'

// SEC-4/manifest の DMDSS 版文言の単一情報源。以前は transformIndexHtml と manifest の
// 2 箇所に同一リテラルがハードコードされて DRY 違反だった。
const APP_STRINGS = {
  standard: {
    title: 'リアルタイム地震ビューアー',
    shortName: '地震ビューアー',
    description: '気象庁の地震情報・緊急地震速報・津波情報をリアルタイムに表示します。',
    appleTitle: '地震ビューアー',
  },
  dmdss: {
    title: 'リアルタイム地震ビューアー (DM-D.S.S)',
    shortName: '地震ビューアー DM-D.S.S',
    description: 'DMDATA.JP (Project DM-D.S.S) で地震情報・緊急地震速報・津波情報をリアルタイムに表示します。',
    appleTitle: '地震ビューアー DM-D.S.S',
  },
} as const

const strings = isDmdss ? APP_STRINGS.dmdss : APP_STRINGS.standard

export default defineConfig({
  base,
  build: {
    outDir: isDmdss ? 'dist-dmdss' : 'dist',
  },
  // maplibre-gl を依存最適化(pre-bundle)の対象外にする。pre-bundle されると GeoJSON タイル化を
  // 担う web worker のロードが壊れ、line/circle が描画されない（背景 raster は worker 不要なので
  // 描けてしまい切り分けにくい）。PoC で確認済みの既知の罠（MapLibre 移行 F0）。
  optimizeDeps: { exclude: ['maplibre-gl'] },
  define: {
    'import.meta.env.VITE_VARIANT': JSON.stringify(variant),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    // dev サーバー専用: 実機計測の証跡収集（/__perf-script・/__perf-report）。build には含まれない
    perfReportPlugin(),
    // SEC-4: index.html はバリアントに関係なく1本しかないため、build/dev 双方で置換して
    // <title>・description・apple-mobile-web-app-title を DMDSS 版のときに書き換える。
    // 文言は APP_STRINGS から取り、manifest との重複を避ける。
    {
      name: 'transform-index-html-variant',
      transformIndexHtml(html) {
        if (!isDmdss) return html
        return html
          .replace(
            /<title>[^<]*<\/title>/,
            `<title>${strings.title}</title>`,
          )
          .replace(
            /<meta name="description" content="[^"]*"\s*\/?>/,
            `<meta name="description" content="${strings.description}" />`,
          )
          .replace(
            /<meta name="apple-mobile-web-app-title" content="[^"]*"\s*\/?>/,
            `<meta name="apple-mobile-web-app-title" content="${strings.appleTitle}" />`,
          )
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.svg'],
      manifest: {
        name: strings.title,
        short_name: strings.shortName,
        description: strings.description,
        theme_color: '#12151a',
        background_color: '#0a0c10',
        display: 'standalone',
        lang: 'ja',
        start_url: base,
        scope: base,
        // SEC-5: public/icons/ には icon.svg しか存在しないため、以前は manifest に列挙されていた
        // icon-192.png / icon-512.png が本番で 404 になっていた。SVG は sizes: 'any' 対応で
        // Android/iOS のホーム画面追加でも正しくラスタライズされるため、SVG 単一に統合する。
        // maskable も同じ SVG を purpose に併記して兼用（icon.svg 側でセーフゾーン考慮）。
        icons: [
          {
            src: 'icons/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
        screenshots: [],
      },
      workbox: {
        // pbf は地名ラベルの SDF グリフ（public/fonts/<stack>/）。これを含めないとオフライン時に
        // グリフだけ取得できず、MapLibre が実行時のフォント生成にフォールバックする（字形がシステム
        // フォントに変わり、事前生成で消したはずのメインスレッド停止も復活する）。
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,pbf}'],
        // SEC-3: standard 版の scope が /realtime-earthquake-viewer/ で DMDSS 版の /dmdss/
        // サブパスも包含するため、両バリアントを同一オリジンで訪れると standard の SW が
        // DMDSS 版のナビゲーションリクエストを横取りしうる。standard 版のみ /dmdss/ を
        // ナビゲーションフォールバックの対象外にする（DMDSS 版は自分自身のパスなので影響なし）。
        // 末尾スラッシュ有り無し両対応: `/realtime-earthquake-viewer/dmdss`（手打ちで末尾スラッシュ抜け）
        // でも `/realtime-earthquake-viewer/dmdss/`（正規パス）でもマッチさせる。
        navigateFallbackDenylist: isDmdss
          ? []
          : [/^\/realtime-earthquake-viewer\/dmdss(\/|$)/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[abc]\.basemaps\.cartocdn\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: {
                maxEntries: 1000,
                maxAgeSeconds: 7 * 24 * 60 * 60,
              },
            },
          },
          {
            urlPattern: /^https:\/\/api\.p2pquake\.net\/v2\/history.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'p2pquake-history',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 5 * 60,
              },
            },
          },
        ],
      },
    }),
  ],
})
