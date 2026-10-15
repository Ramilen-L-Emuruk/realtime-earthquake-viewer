// タブの状態を、リロードとタブ移動をまたいで保つ。
//
// **置き場所は 2 つに分ける**（2026-10-10 ユーザー承認）。
//
// - **選択（何を見ているか）は URL の `#`。** 開いているタブ・編集中の観測点や基板・
//   開いている揺れの記録・波形の記録の時間の範囲。リロードしても同じものが出て、
//   アドレスを控えれば同じ画面へ戻れる。
// - **表示の好み（どう見ているか）は localStorage。** 見る幅・チェック・隠した軸・単位など。
//   見ているものが変わっても持ち越したい値なので、URL には載せない。
//
// **未保存の入力は戻さない**（同承認）。戻すのは表示の状態だけで、入力の途中は
// 離れる前に確かめる（`app.ts`）。
//
// `#` に載るのはいま開いているタブの分だけなので、**別のタブで選んでいたものは
// sessionStorage にも置く。** これが無いと、タブを移って戻ったとき・リロードの後に
// 別のタブへ移ったときに、そのタブの選択が消える。

export type TabKey = 'stations' | 'boards' | 'status' | 'waves' | 'shakes' | 'records' | 'storage'

export const TAB_KEYS: readonly TabKey[] = ['stations', 'boards', 'status', 'waves', 'shakes', 'records', 'storage']

export function isTabKey(value: string): value is TabKey {
  return (TAB_KEYS as readonly string[]).includes(value)
}

/** タブの選択。キーと値はどちらも文字列（URL にそのまま載る）。 */
export type Selection = Readonly<Record<string, string>>

/**
 * `#<タブ>?<キー>=<値>&…` を読む。タブ名が分からなければ `null`。
 *
 * **値は信用しない。** URL は誰でも書き換えられるので、ここでは形だけを読み、
 * 指す相手が実在するかは各タブが自分の一覧で確かめる。
 */
export function parseHash(hash: string): { readonly tab: TabKey; readonly selection: Selection } | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  const q = body.indexOf('?')
  const tab = q < 0 ? body : body.slice(0, q)
  if (!isTabKey(tab)) return null
  return { tab, selection: q < 0 ? {} : selectionFromQuery(body.slice(q + 1)) }
}

export function formatHash(tab: TabKey, selection: Selection): string {
  const query = selectionToQuery(selection)
  return query.length === 0 ? `#${tab}` : `#${tab}?${query}`
}

function selectionFromQuery(query: string): Selection {
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(query)) {
    if (k.length > 0 && v.length > 0) out[k] = v
  }
  return out
}

/** キーの順で並べる。同じ選択がいつも同じ文字列になるので、URL を比べられる。 */
function selectionToQuery(selection: Selection): string {
  const params = new URLSearchParams()
  for (const k of Object.keys(selection).sort()) {
    const v = selection[k]!
    if (v.length > 0) params.set(k, v)
  }
  return params.toString()
}

/** タブが自分の選択を読み書きする窓口。 */
export interface SelectionStore {
  get(key: string): string | null
  /** `null` を渡したキーは消す。渡さなかったキーはそのまま残す。 */
  set(updates: Readonly<Record<string, string | null>>): void
}

/**
 * タブが自分の表示の好みを読み書きする窓口。
 *
 * **中身の形はタブが決めて、読むときに自分で確かめる。** localStorage は前の版の
 * 管理コンソールが書いた値も、手で書き換えた値も残りうる。
 */
export interface PrefsStore {
  /** 保存が無い・JSON として読めないときは `null`。 */
  load(): unknown
  save(value: unknown): void
}

/** 各タブの初期化へ渡すもの。 */
export interface TabContext {
  /** タブを離れたら打ち切られる（`app.ts` の `mountTab`）。 */
  readonly signal: AbortSignal
  readonly selection: SelectionStore
  readonly prefs: PrefsStore
  /**
   * 「保存していない入力があるか」を答える関数を登録する。
   *
   * タブを移る前とリロードの前に `app.ts` が呼ぶ。**フォームを持つタブは必ず登録する** ——
   * 登録しないと、入力の途中でもタブ移動とリロードが確認なしに捨てる。
   */
  readonly setUnsavedProbe: (probe: () => boolean) => void
  /**
   * 別のタブを、選択を渡して開く（揺れの記録 →「波形の記録で開く」）。**タブの見出しを押したのと同じ道を通る** ——
   * 保存していない入力の確認・アドレスの履歴（「戻る」で戻れる）・選択の置き換えを、ここで別に組まない。
   */
  readonly openTab: (key: TabKey, selection: Selection) => void
}

/** ブラウザの Storage のうち、ここで使う分だけ（テストで置き換えるため）。 */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const SELECTION_KEY_PREFIX = 'seismo-admin-selection:'
const PREFS_KEY_PREFIX = 'seismo-admin-view:'

/**
 * タブごとの選択と表示の好みを持つ。
 *
 * 選択はメモリに持ち、変わるたびに sessionStorage へ書いて `onSelectionChange` を呼ぶ
 * （URL へ書くのは `app.ts`）。
 */
export class TabStates {
  private readonly selections = new Map<TabKey, Selection>()

  constructor(
    private readonly session: KeyValueStorage,
    private readonly local: KeyValueStorage,
  ) {}

  selectionOf(tab: TabKey): Selection {
    const cached = this.selections.get(tab)
    if (cached !== undefined) return cached
    const stored = safeGet(this.session, SELECTION_KEY_PREFIX + tab)
    const selection = stored === null ? {} : selectionFromQuery(stored)
    this.selections.set(tab, selection)
    return selection
  }

  /** URL から読んだ選択で置き換える（起動時・「戻る」のとき）。 */
  replaceSelection(tab: TabKey, selection: Selection): void {
    this.selections.set(tab, selection)
    safeSet(this.session, SELECTION_KEY_PREFIX + tab, selectionToQuery(selection))
  }

  /**
   * そのタブの窓口を作る。
   *
   * **打ち切られた後の書き込みは捨てる。** 前のタブの遅れた応答が選択を書き換えると、
   * 移った先の URL に前のタブの値が混ざる。
   */
  storesFor(
    tab: TabKey,
    signal: AbortSignal,
    onSelectionChange: () => void,
  ): { readonly selection: SelectionStore; readonly prefs: PrefsStore } {
    const selection: SelectionStore = {
      get: (key) => this.selectionOf(tab)[key] ?? null,
      set: (updates) => {
        if (signal.aborted) return
        const next: Record<string, string> = { ...this.selectionOf(tab) }
        for (const [k, v] of Object.entries(updates)) {
          if (v === null || v.length === 0) delete next[k]
          else next[k] = v
        }
        this.replaceSelection(tab, next)
        onSelectionChange()
      },
    }
    const prefs: PrefsStore = {
      load: () => {
        const raw = safeGet(this.local, PREFS_KEY_PREFIX + tab)
        if (raw === null) return null
        try {
          return JSON.parse(raw) as unknown
        } catch {
          return null
        }
      },
      save: (value) => {
        if (signal.aborted) return
        safeSet(this.local, PREFS_KEY_PREFIX + tab, JSON.stringify(value))
      },
    }
    return { selection, prefs }
  }
}

// **保存できなくても画面は動かす。** プライベートブラウズや容量超過で Storage は投げることがある。
// 落ちるのは「次に開いたとき戻らない」だけで、いまの操作には関わらない。
function safeGet(storage: KeyValueStorage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(storage: KeyValueStorage, key: string, value: string): void {
  try {
    if (value.length === 0) storage.removeItem(key)
    else storage.setItem(key, value)
  } catch {
    // 上の理由で捨てる
  }
}

/** Storage を使わない窓口（テスト用・Storage が無い環境の代わり）。 */
export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
}

/**
 * テスト用の窓口。選択・表示の好みはメモリに置き、未保存の問い合わせは `unsaved()` で読める。
 */
export function memoryTabContext(
  signal: AbortSignal,
  tab: TabKey,
  init: { readonly selection?: Selection; readonly prefs?: unknown } = {},
): TabContext & {
  readonly unsaved: () => boolean
  readonly states: TabStates
  /** `openTab` で開こうとしたタブ（呼ばれた順）。 */
  readonly opened: readonly { readonly key: TabKey; readonly selection: Selection }[]
} {
  const states = new TabStates(memoryStorage(), memoryStorage())
  if (init.selection !== undefined) states.replaceSelection(tab, init.selection)
  const stores = states.storesFor(tab, signal, () => {})
  if (init.prefs !== undefined) stores.prefs.save(init.prefs)
  let probe: () => boolean = () => false
  const opened: { key: TabKey; selection: Selection }[] = []
  return {
    signal,
    ...stores,
    setUnsavedProbe: (p) => {
      probe = p
    },
    openTab: (key, selection) => {
      opened.push({ key, selection })
    },
    unsaved: () => probe(),
    states,
    opened,
  }
}
