import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const variant = process.env.VITE_VARIANT ?? 'standard'
const isDmdss = variant === 'dmdss'

// DMDSS版は /dmdss/ サブパスに配信。base が異なるため SW スコープも自動で分離される。
const base = isDmdss
  ? '/realtime-earthquake-viewer/dmdss/'
  : '/realtime-earthquake-viewer/'

export default defineConfig({
  base,
  build: {
    outDir: isDmdss ? 'dist-dmdss' : 'dist',
  },
  define: {
    'import.meta.env.VITE_VARIANT': JSON.stringify(variant),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.svg', 'icons/*.png'],
      manifest: {
        name: isDmdss ? 'リアルタイム地震ビューアー (DM-D.S.S)' : 'リアルタイム地震ビューアー',
        short_name: isDmdss ? '地震ビューアー DM-D.S.S' : '地震ビューアー',
        description: isDmdss
          ? 'DMDATA.JP (Project DM-D.S.S) で地震情報・緊急地震速報・津波情報をリアルタイムに表示します。'
          : '気象庁の地震情報・緊急地震速報・津波情報をリアルタイムに表示します。',
        theme_color: '#12151a',
        background_color: '#0a0c10',
        display: 'standalone',
        lang: 'ja',
        start_url: base,
        scope: base,
        icons: [
          {
            src: 'icons/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
        screenshots: [],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
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
