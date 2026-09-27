// 管理コンソールのエントリポイント。タブ切替とトークン入力を持つ。
//
// **タブの中身はそれぞれ独立したモジュール（`viewStations.ts` 等）。** ここでは
// どれを表示するかの配線だけを持つ——1 ファイルに全部書くと、どのタブがどの
// `/api/*` を叩くのか見通せなくなる。

import { clearStoredToken, getStoredToken, onTokenCleared, setStoredToken } from './api'
import { qs } from './dom'
import { initBoardsView } from './viewBoards'
import { initStationsView } from './viewStations'
import { initStatusView } from './viewStatus'

type TabKey = 'stations' | 'boards' | 'status'

const TABS: readonly { readonly key: TabKey; readonly label: string }[] = [
  { key: 'stations', label: '観測点' },
  { key: 'boards', label: '基板' },
  { key: 'status', label: '稼働状況' },
]

function renderShell(root: HTMLElement): void {
  root.innerHTML = `
    <section class="token-box">
      <label>
        管理トークン（<code>Authorization: Bearer</code>）
        <input type="password" class="token-input" autocomplete="off" placeholder="未設定" />
      </label>
      <button type="button" class="token-save">保存</button>
      <button type="button" class="token-clear">消去</button>
      <span class="token-status muted"></span>
    </section>
    <div class="tabs" role="tablist"></div>
    <div class="tab-content"></div>
  `
}

function updateTokenStatus(root: HTMLElement): void {
  const statusEl = qs(root, '.token-status')
  const token = getStoredToken()
  statusEl.textContent = token !== null ? 'トークン設定済み' : 'トークン未設定（観測点・基板の編集は 401 になる）'
}

/**
 * 直前のタブの世代を打ち切る `AbortController`。**タブ 1 つに 1 本**——
 * 呼び出し中の非同期処理（fetch・タイマー）に「自分がまだ現役か」を確認する
 * 手段を渡す。`teardown` イベント方式（旧実装）は、初回の非同期処理が終わる
 * *前*に別タブへ切り替えるとリスナー登録前に発火してしまい、後から登録される
 * タイマー・DOM 書き込みを止められなかった（#313 段 C 敵対的レビューで検出）。
 * `AbortSignal` はそれ自体が「打ち切り済みか」を保持するので、この順序問題が
 * 起きない。
 */
let activeTabController: AbortController | null = null

async function mountTab(root: HTMLElement, key: TabKey): Promise<void> {
  activeTabController?.abort()
  const controller = new AbortController()
  activeTabController = controller

  const content = qs(root, '.tab-content')
  content.innerHTML = ''

  for (const tab of root.querySelectorAll('.tabs button')) {
    tab.setAttribute('aria-selected', String((tab as HTMLElement).dataset.tabKey === key))
  }

  if (key === 'stations') await initStationsView(content, controller.signal)
  else if (key === 'boards') await initBoardsView(content, controller.signal)
  else await initStatusView(content, controller.signal)
}

function renderTabs(root: HTMLElement, onSelect: (key: TabKey) => void): void {
  const tabsEl = qs(root, '.tabs')
  tabsEl.innerHTML = TABS.map(
    (t) => `<button type="button" role="tab" data-tab-key="${t.key}">${t.label}</button>`,
  ).join('')
  tabsEl.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('button[data-tab-key]')
    if (target === null) return
    onSelect(target.dataset.tabKey as TabKey)
  })
}

async function main(): Promise<void> {
  const root = qs<HTMLElement>(document, '#app')
  renderShell(root)
  updateTokenStatus(root)

  qs<HTMLInputElement>(root, '.token-input').value = getStoredToken() ?? ''
  qs(root, '.token-save').addEventListener('click', () => {
    const value = qs<HTMLInputElement>(root, '.token-input').value.trim()
    if (value.length === 0) return
    setStoredToken(value)
    updateTokenStatus(root)
  })
  qs(root, '.token-clear').addEventListener('click', () => {
    clearStoredToken()
    qs<HTMLInputElement>(root, '.token-input').value = ''
    updateTokenStatus(root)
  })

  // **`invalid-token` でトークンが消えたら画面へ反映する。** 消えた事実が
  // バッジ・入力欄に出ないと、運用者は原因に気づけない（`api.ts` 参照）。
  onTokenCleared(() => {
    qs<HTMLInputElement>(root, '.token-input').value = ''
    updateTokenStatus(root)
  })

  renderTabs(root, (key) => void mountTab(root, key))
  await mountTab(root, 'stations')
}

void main()
