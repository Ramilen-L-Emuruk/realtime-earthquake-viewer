import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './index.css'
import { App } from './App'

// autoUpdate モードで新 SW がコントローラーになったら sw-updated イベントを発火する。
// 初回インストール時（controller が null → SW）は除外し、更新時のみ通知する。
// 実際のリロードは App.tsx 側で「情報発表なし」を確認してから行う。
if ('serviceWorker' in navigator) {
  const wasControlled = Boolean(navigator.serviceWorker.controller)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (wasControlled) window.dispatchEvent(new CustomEvent('sw-updated'))
  })
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
