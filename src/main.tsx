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
      log.info('[sw] 新バージョン検知 → sw-updated 発火')
      window.dispatchEvent(new CustomEvent('sw-updated'))
    }
  })

  // 新 SW のインストールが中断されると installing → redundant で終わり、activate も controllerchange も
  // 起きない。つまり上の更新検知は沈黙し、ユーザーは古い版のまま更新に気づけず、開発側にも痕跡が残らない
  // （DevTools を開かない限り不可視）。せめてログに残す。
  //
  // 検知できる範囲は限定的で、そこを取り違えないよう明示しておく:
  //   - redundant は「インストール失敗」だけでなく「より新しい SW に正当に置き換えられた」ときにも起きる。
  //     両者をここで区別できないため、断定せず「中断」と表現する。
  //   - ready はアクティブな SW が現れるまで解決しないため、初回インストール自体が失敗した場合はここに
  //     到達しない（その場合オフライン機能が使えないだけで、アプリの通常動作には影響しない）。
  //   - ready は仕様上 reject しない。下の catch は then 内で予期せぬ例外が出たときの保険であって、
  //     登録失敗を捕まえるものではない。
  navigator.serviceWorker.ready
    .then((registration) => {
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'redundant') {
            log.error('[sw] 新バージョンのインストールが中断（失敗、または更に新しい版に置き換えられた）。前者なら古い版のまま動作し続ける')
          }
        })
      })
    })
    .catch((e) => log.error('[sw] 更新失敗の監視を設定できなかった（以後この検知は働かない）', e))
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
