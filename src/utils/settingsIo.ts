/**
 * 設定の書き出しと読み込み。
 *
 * 端末を移るとき・ブラウザのデータを消すとき・用途別の設定一式を作り置きするときのための機能。
 * 設定は localStorage にしか無いので、ここが無いと作り込んだ設定を持ち出す手段が無い。
 *
 * **React に依存しない純関数だけを置く。** 画面側（`SettingsTab`）はここを呼ぶだけにして、
 * 書式の決まりと検証をテストで固定できるようにする。
 */
import type { AppSettings } from '../hooks/useSettings'
import { sanitize } from '../hooks/useSettings'
import { formatFileStamp } from './formatters'

/** 書き出したファイルの中身。 */
export interface SettingsFile {
  app: 'realtime-earthquake-viewer'
  kind: 'settings'
  version: 1
  /** どちらのビルドで書き出したか。読み込み側で食い違いを知らせるために持つ。 */
  variant: SettingsVariant
  exportedAt: string
  settings: AppSettings
}
export type SettingsVariant = 'dmdss' | 'standard'

export const SETTINGS_FILE_VERSION = 1

/**
 * 書き出す中身を組み立てる。
 *
 * **API キーは含めない。** 書き出したファイルはディスクに残り、人に渡ることも、うっかり
 * リポジトリへ入ることもある。`stripDevApiKey`（`useSettings.ts`）が dev の注入値を
 * localStorage へ保存しないのと同じ考え方で、ここでも外に出さない。
 */
export function buildSettingsFile(settings: AppSettings, variant: SettingsVariant, now = new Date()): SettingsFile {
  return {
    app: 'realtime-earthquake-viewer',
    kind: 'settings',
    version: SETTINGS_FILE_VERSION,
    variant,
    exportedAt: now.toISOString(),
    settings: { ...settings, dmdataApiKey: '' },
  }
}

/**
 * 書き出すファイル名。
 *
 * 時刻印は `formatFileStamp` を使う（診断ログの書き出しと同じ）。独自に組むと、ゼロ埋めや
 * 時間帯の扱いが 2 か所に分かれる。
 */
export function settingsFileName(variant: SettingsVariant, now = new Date()): string {
  return `${formatFileStamp(now.getTime())}_quake-viewer-settings-${variant}.json`
}

export type ParseResult =
  | {
      ok: true
      settings: AppSettings
      variant: SettingsVariant
      exportedAt: string | null
      usedFileApiKey: boolean
      /** 値が入っていたのに読めず、既定値へ落ちた項目名。→ {@link parseSettingsFile} */
      rejectedKeys: string[]
    }
  | { ok: false; error: string }

/**
 * 読み込んだ中身を検証して設定へ落とす。
 *
 * **検証は既存の `sanitize()` に任せる。** 読み込み専用の検証を別に書くと、設定の項目を
 * 足したときに片方だけ古くなり、新しい項目が既定値に戻らないまま実装へ渡る。
 *
 * ただし `sanitize()` は弾いた値をほとんど黙って既定値へ落とすので、**値が入っていたのに
 * 読めなかった項目は名前を集めて返す**（`rejectedKeys`）。画面がそれを出さないと、壊れた
 * ファイルを読み込んでも「読み込みました」としか出ず、設定が既定へ戻ったことに気づけない。
 * **項目が丸ごと欠けている場合は数えない** —— 古い版で書き出したファイルには新しい項目が
 * 無いのが当たり前で、それは欠損補完であって失敗ではない（`useSettings.ts` の `load()` が
 * 警告を出し分けているのと同じ線引き）。
 *
 * @param current いま画面が持っている設定。ファイルに API キーが入っていなければこちらを残す。
 */
export function parseSettingsFile(raw: unknown, current: AppSettings): ParseResult {
  if (raw == null || typeof raw !== 'object') return { ok: false, error: '設定ファイルとして読めません（中身がありません）' }
  const o = raw as Partial<SettingsFile>
  if (o.app !== 'realtime-earthquake-viewer') return { ok: false, error: 'このアプリの設定ファイルではありません' }
  // `kind` は将来ほかの書き出し（設定以外）を足したときの取り違え防止。いまのところ設定しか無い。
  if (o.kind !== 'settings') return { ok: false, error: 'このアプリのファイルですが、設定ではありません' }
  // 形式の番号が無いものと、この版より新しいものを分ける。**同じ文面にしない** ——
  // 前者は壊れたファイルで、アプリを新しくしても直らない。
  if (typeof o.version !== 'number') return { ok: false, error: '設定ファイルの形式が正しくありません（壊れている可能性があります）' }
  if (o.version > SETTINGS_FILE_VERSION) {
    return { ok: false, error: 'より新しいアプリで書き出されたファイルです。アプリを更新してください' }
  }
  if (o.settings == null || typeof o.settings !== 'object') return { ok: false, error: '設定の中身がありません' }

  const incoming = o.settings as Partial<AppSettings>
  const settings = sanitize(incoming)
  const rejectedKeys = collectRejectedKeys(incoming, settings)

  // API キーは書き出しに含めないので、通常はファイル側が空になる。**空のときは今の値を残す**
  // ——空で塗ると、入力済みのキーが読み込みのたびに消える。
  // 手で書き足された場合だけ、その値を使う（意図して入れたものを無視しない）。
  const fileKey = typeof incoming.dmdataApiKey === 'string' ? incoming.dmdataApiKey : ''
  const usedFileApiKey = fileKey !== ''
  settings.dmdataApiKey = usedFileApiKey ? fileKey : current.dmdataApiKey

  return {
    ok: true,
    settings,
    variant: o.variant === 'dmdss' ? 'dmdss' : 'standard',
    exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : null,
    usedFileApiKey,
    rejectedKeys: rejectedKeys.filter(k => k !== 'dmdataApiKey'),
  }
}

/**
 * 値が入っていたのに `sanitize()` が採らなかった項目を集める。
 *
 * 欠けている項目（`undefined`）は数えない —— 項目が増える前に書き出したファイルでは普通のこと。
 */
function collectRejectedKeys(incoming: Partial<AppSettings>, sanitized: AppSettings): string[] {
  const out: string[] = []
  for (const key of Object.keys(incoming) as (keyof AppSettings)[]) {
    const before = incoming[key]
    if (before === undefined) continue
    if (!(key in sanitized)) continue // 設定に無い項目が書かれていた（古い版の残骸など）
    if (!keptAsWritten(before, sanitized[key])) out.push(key)
  }
  return out
}

/**
 * 書かれていた値がそのまま採られたか。
 *
 * **オブジェクトは全体の一致で見ない。** 中のキーが 1 つ欠けているだけの古いファイルを
 * 「読めなかった」と誤報するため。欠けたキーは `sanitize()` が既定値で埋めるだけで、
 * それは欠損補完であって失敗ではない —— トップレベルに適用している線引きを、入れ子の
 * 内側にも同じように当てる。
 *
 * **入っているキーだけを突き合わせる。** 中に読めない値があれば、そのオブジェクトの項目名を
 * 挙げる（どのサブキーが駄目だったかまでは言わない。利用者に伝わる粒度は項目名で足りる）。
 */
function keptAsWritten(before: unknown, after: unknown): boolean {
  if (typeof before === 'number' && typeof after === 'number') {
    // `Object.is` に任せない —— `-0` と `0` を別物として扱うため、`clampNumber` が
    // `-0` を `0` へ均しただけの値が「読めなかった」と誤報される。NaN は同一と見たいので
    // `===` だけでも足りない。
    return before === after || (Number.isNaN(before) && Number.isNaN(after))
  }
  if (typeof before !== 'object' || before === null) return Object.is(before, after)
  if (typeof after !== 'object' || after === null) return false
  if (Array.isArray(before) !== Array.isArray(after)) return false
  if (Array.isArray(before) && Array.isArray(after)) {
    // **いまの `AppSettings` に配列の項目は無い。** それでも持たせてあるのは、この関数が
    // `unknown` を受けるため——オブジェクトとして扱うと添字が「サブキー」になり、
    // 短くなった配列を「欠損補完」と読み違えて見逃す。テストで挙動を固定してある。
    return before.length === after.length && before.every((v, i) => keptAsWritten(v, after[i]))
  }
  const b = before as Record<string, unknown>
  const a = after as Record<string, unknown>
  for (const k of Object.keys(b)) {
    if (b[k] === undefined) continue
    if (!(k in a)) continue // 設定に無いサブキーが書かれていた
    if (!keptAsWritten(b[k], a[k])) return false
  }
  return true
}
