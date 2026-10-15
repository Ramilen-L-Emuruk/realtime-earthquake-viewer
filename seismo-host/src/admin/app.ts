// 管理コンソールのエントリポイント。タブ切替とトークン入力を持つ。
//
// **タブの中身はそれぞれ独立したモジュール（`viewStations.ts` 等）。** ここでは
// どれを表示するかの配線だけを持つ——1 ファイルに全部書くと、どのタブがどの
// `/api/*` を叩くのか見通せなくなる。
//
// **開いているタブと各タブの選択は URL の `#` に載せ、表示の好みは localStorage に置く**
// （`tabState.ts`）。リロードしてもタブを移って戻っても、同じものが同じ見え方で出る。

import { clearStoredToken, getStoredToken, onTokenCleared, setStoredToken } from './api'
import { confirmDiscardUnsaved, qs } from './dom'
import { TabStates, formatHash, parseHash, type Selection, type TabContext, type TabKey } from './tabState'
import { installTips, tipHtml } from './tip'
import { dismissConfirmDialog } from './confirmDialog'
import { initBoardsView } from './viewBoards'
import { initRecordsView } from './viewRecords'
import { initShakesView } from './viewShakes'
import { initStationsView } from './viewStations'
import { initStatusView } from './viewStatus'
import { initStorageView } from './viewStorage'
import { initWavesView } from './viewWaves'

const TABS: readonly { readonly key: TabKey; readonly label: string }[] = [
  { key: 'stations', label: '観測点' },
  { key: 'boards', label: '基板' },
  { key: 'status', label: '稼働状況' },
  { key: 'waves', label: '波形' },
  { key: 'shakes', label: '揺れの記録' },
  // 2026-10-07 ユーザー承認（揺れの記録の右）。
  { key: 'records', label: '波形の記録' },
  // 2026-10-13 ユーザー承認（波形の記録の右）。
  { key: 'storage', label: '保存先' },
]

/** 開いたまま何も指していないときのタブ。 */
const DEFAULT_TAB: TabKey = 'stations'

/**
 * 選択の変化を URL へ書くまでの待ち。
 *
 * **選択が変わるたびに書かない。** 波形の記録はドラッグ・ホイールのたびに範囲が動くので、
 * そのまま `history.replaceState` を呼ぶと 1 秒に数十回になり、ブラウザが履歴の操作を
 * 間引き始める（Chrome は短い間に呼びすぎると警告を出して無視する）。
 * メモリと sessionStorage はその場で書くので、待っている間にタブを移っても選択は消えない。
 */
const URL_WRITE_DELAY_MS = 300

function renderShell(root: HTMLElement): void {
  root.innerHTML = `
    <section class="token-box panel">
      <!-- **説明の付いたラベルを <label> の中に入れない。** 押すと吹き出しを固定する前に入力欄へ
           フォーカスが移る（<label> の働き）。欄とは aria-labelledby で結ぶ。 -->
      <div class="label-like" data-tip-row>
        <span id="token-label">${tipHtml(
          '管理トークン',
          '観測点と基板の編集に使います。ホストの SEISMO_ADMIN_TOKEN と同じ値を入れてください。',
        )}</span>
        <input type="password" class="token-input" autocomplete="off" placeholder="未設定" aria-labelledby="token-label" />
      </div>
      <div class="row">
        <button type="button" class="token-save" style="flex: 0 0 auto">保存</button>
        <button type="button" class="token-clear" style="flex: 0 0 auto">消去</button>
        <span class="token-status muted" style="align-self: center"></span>
      </div>
    </section>
    <div class="tabs" role="tablist"></div>
    <div class="tab-content"></div>
  `
}

function updateTokenStatus(root: HTMLElement): void {
  const statusEl = qs(root, '.token-status')
  const token = getStoredToken()
  statusEl.textContent = token !== null ? '設定済み' : '未設定'
}

const tabStates = new TabStates(sessionStorage, localStorage)

/**
 * いま開いているタブ。
 *
 * `controller` は直前のタブの世代を打ち切る `AbortController`。**タブ 1 つに 1 本**——
 * 呼び出し中の非同期処理（fetch・タイマー）に「自分がまだ現役か」を確認する
 * 手段を渡す。`teardown` イベント方式（旧実装）は、初回の非同期処理が終わる
 * *前*に別タブへ切り替えるとリスナー登録前に発火してしまい、後から登録される
 * タイマー・DOM 書き込みを止められなかった（#313 段 C 敵対的レビューで検出）。
 * `AbortSignal` はそれ自体が「打ち切り済みか」を保持するので、この順序問題が
 * 起きない。
 */
let activeTab: { readonly key: TabKey; readonly controller: AbortController; unsaved: () => boolean } | null = null

let urlWriteTimer: ReturnType<typeof setTimeout> | null = null

/** いまのタブの選択を URL へ書く。待っている書き込みがあれば先に済ませる。 */
function flushUrl(): void {
  if (urlWriteTimer !== null) {
    clearTimeout(urlWriteTimer)
    urlWriteTimer = null
  }
  if (activeTab === null) return
  const hash = formatHash(activeTab.key, tabStates.selectionOf(activeTab.key))
  if (location.hash !== hash) history.replaceState(null, '', hash)
}

function scheduleUrlWrite(): void {
  if (urlWriteTimer !== null) return
  urlWriteTimer = setTimeout(() => {
    urlWriteTimer = null
    flushUrl()
  }, URL_WRITE_DELAY_MS)
}

/**
 * いまのタブに保存していない入力があるか。
 *
 * **問い合わせが投げたら「ある」と答える。** 「無い」に倒すと、確かめずに入力を捨てる。
 */
function activeTabHasUnsaved(): boolean {
  if (activeTab === null) return false
  try {
    return activeTab.unsaved()
  } catch {
    return true
  }
}

/** 離れてよいか。保存していない入力があるときだけ訊く。 */
async function confirmLeave(): Promise<boolean> {
  return !activeTabHasUnsaved() || (await confirmDiscardUnsaved())
}

/**
 * `popstate` で出した確認の窓の通し番号。**答えが返ったとき、まだ最後の問いかを確かめる。**
 * 窓を出している間にもう一度「戻る」「進む」が押されると、前の問いは「キャンセル」で閉じる
 * （`confirmDialog.ts`）。その答えでアドレスを書き戻すと、新しい問いの行き先を潰す。
 */
let popSeq = 0

async function mountTab(root: HTMLElement, key: TabKey): Promise<void> {
  // 前のタブの確認の窓を残さない（`dismissConfirmDialog` の理由）
  dismissConfirmDialog()
  activeTab?.controller.abort()
  const controller = new AbortController()
  const signal = controller.signal
  const tab: { readonly key: TabKey; readonly controller: AbortController; unsaved: () => boolean } = {
    key,
    controller,
    unsaved: () => false,
  }
  activeTab = tab

  const content = qs(root, '.tab-content')
  content.innerHTML = ''

  for (const button of root.querySelectorAll('.tabs button')) {
    button.setAttribute('aria-selected', String((button as HTMLElement).dataset.tabKey === key))
  }

  const ctx: TabContext = {
    signal,
    ...tabStates.storesFor(key, signal, scheduleUrlWrite),
    setUnsavedProbe: (probe) => {
      if (!signal.aborted) tab.unsaved = probe
    },
    openTab: (to, selection) => {
      if (!signal.aborted) void goToTab(root, to, selection)
    },
  }

  if (key === 'stations') await initStationsView(content, ctx)
  else if (key === 'boards') await initBoardsView(content, ctx)
  else if (key === 'waves') await initWavesView(content, ctx)
  else if (key === 'shakes') await initShakesView(content, ctx)
  else if (key === 'records') await initRecordsView(content, ctx)
  else if (key === 'storage') await initStorageView(content, ctx)
  else await initStatusView(content, ctx)
}

/**
 * タブを移る。タブの見出しを押したときと、タブの中から別のタブを開くとき（`TabContext.openTab`）の共通の道。
 *
 * **答えを待つ間に別のタブへ移っていたら何もしない。** 窓は後ろの画面を覆うが、「戻る」は押せる。
 * **選択を渡されたら、行き先のタブの選択をそれで置き換える**（前に覚えていた選択より、いま開きたいものが先）。
 */
async function goToTab(root: HTMLElement, key: TabKey, selection?: Selection): Promise<void> {
  const from = activeTab
  if (!(await confirmLeave()) || activeTab !== from) return
  flushUrl()
  if (selection !== undefined) tabStates.replaceSelection(key, selection)
  if (activeTab?.key !== key || selection !== undefined) history.pushState(null, '', formatHash(key, tabStates.selectionOf(key)))
  void mountTab(root, key)
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
  // 画面を閉じるまで外さない（管理コンソールは 1 ページなので、外す契機が無い）
  installTips(document)
  renderShell(root)
  updateTokenStatus(root)

  const tokenInput = qs<HTMLInputElement>(root, '.token-input')
  tokenInput.value = getStoredToken() ?? ''
  qs(root, '.token-save').addEventListener('click', () => {
    const value = tokenInput.value.trim()
    if (value.length === 0) return
    setStoredToken(value)
    updateTokenStatus(root)
  })
  qs(root, '.token-clear').addEventListener('click', () => {
    clearStoredToken()
    tokenInput.value = ''
    updateTokenStatus(root)
  })

  // **`invalid-token` でトークンが消えたら画面へ反映する。** 消えた事実が
  // バッジ・入力欄に出ないと、運用者は原因に気づけない（`api.ts` 参照）。
  onTokenCleared(() => {
    tokenInput.value = ''
    updateTokenStatus(root)
  })

  // **タブの切り替えは履歴に積む。** ブラウザの「戻る」で前のタブへ戻れる。選択の変化は
  // 積まない（`flushUrl` は置き換え）——観測点を 1 つ選ぶたびに「戻る」が 1 回増えると、
  // 前のタブへ戻るまでに何度も押すことになる。
  renderTabs(root, (key) => {
    void goToTab(root, key)
  })

  const followPopState = (parsed: NonNullable<ReturnType<typeof parseHash>>): void => {
    if (urlWriteTimer !== null) {
      clearTimeout(urlWriteTimer)
      urlWriteTimer = null
    }
    tabStates.replaceSelection(parsed.tab, parsed.selection)
    void mountTab(root, parsed.tab)
  }

  window.addEventListener('popstate', () => {
    const parsed = parseHash(location.hash) ?? { tab: DEFAULT_TAB, selection: {} }
    const seq = ++popSeq
    if (activeTab !== null) {
      const current = formatHash(activeTab.key, tabStates.selectionOf(activeTab.key))
      if (formatHash(parsed.tab, parsed.selection) === current) return
      if (activeTabHasUnsaved()) {
        // **答えを待つ間、アドレスは行き先のまま置く。** 「破棄する」ならその行き先へ直接移る。
        // 先に元へ書き戻して `history.back()` で移り直す形は、「進む」・複数段の移動・アドレス欄の
        // 書き換えで 1 つ前へ着いてしまう（行き先が「1 つ前」とは限らない）。
        // 待つ間に URL の書き込みが走ると、行き先の項目を元のタブで上書きするので止めておく。
        if (urlWriteTimer !== null) {
          clearTimeout(urlWriteTimer)
          urlWriteTimer = null
        }
        const from = activeTab
        void confirmDiscardUnsaved().then((ok) => {
          if (seq !== popSeq || activeTab !== from) return
          if (ok) {
            followPopState(parsed)
            return
          }
          // **断られたら URL を戻す。** 履歴はもう行き先へ動いているので、何もしないと画面と
          // アドレスが食い違ったまま残る。答えを待つ間に選択が変わっていてもよいよう、いま組む。
          history.pushState(null, '', formatHash(from.key, tabStates.selectionOf(from.key)))
        })
        return
      }
    }
    followPopState(parsed)
  })

  // **リロード・ページを閉じる前に確かめる。** 文面はブラウザが決める（こちらからは書けない）。
  // トークン欄も保存を押すまでは入力の途中なので、ここで数える（タブを移っても消えないので、
  // タブ移動では訊かない）。
  window.addEventListener('beforeunload', (e) => {
    flushUrl()
    const tokenUnsaved = tokenInput.value.trim() !== (getStoredToken() ?? '')
    if (!activeTabHasUnsaved() && !tokenUnsaved) return
    e.preventDefault()
    // 古いブラウザは preventDefault を見ず、returnValue が真であることを合図にする
    e.returnValue = true
  })
  window.addEventListener('pagehide', flushUrl)

  // **URL の選択を、前に覚えていた選択より優先する。** アドレスを控えて開き直したときは
  // そちらが見たいもの。`#` が無い（初めて開いた）ときは覚えていた選択を使う。
  const initial = parseHash(location.hash)
  const key = initial?.tab ?? DEFAULT_TAB
  if (initial !== null) tabStates.replaceSelection(key, initial.selection)
  history.replaceState(null, '', formatHash(key, tabStates.selectionOf(key)))
  await mountTab(root, key)
}

void main()
