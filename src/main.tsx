import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// MapLibre の既定スタイルは index.css より先に読む。CSS は同じ詳細度なら後勝ちのため、
// 逆順（地図コンポーネント側で import）だと index.css のポップアップのダーク化が
// MapLibre 既定の白背景に上書きされて効かなくなる。
import 'maplibre-gl/dist/maplibre-gl.css'
import './index.css'
import { App } from './App'
import { log } from './utils/logger'

// autoUpdate モードで新 SW がコントローラーになったら sw-updated イベントを発火する。
// 初回インストール時（controller が null → SW）は除外し、更新時のみ通知する。
// 実際のリロードは App.tsx 側で「情報発表なし」を確認してから行う。
if ('serviceWorker' in navigator) {
  const wasControlled = Boolean(navigator.serviceWorker.controller)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (wasControlled) {
      log.debug('[sw] 新バージョン検知 → sw-updated 発火')
      window.dispatchEvent(new CustomEvent('sw-updated'))
    }
  })
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
