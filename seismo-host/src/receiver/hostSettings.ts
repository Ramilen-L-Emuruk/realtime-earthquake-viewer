// ホスト全体の設定（いまは保存先だけ）を `config/host-settings.json` に持つ。
//
// **保存先は 1 つの親フォルダで決める**（2026-10-13 ユーザー決定）。その下に `raw/`・`wave/`・`summary/`・
// `events/` を並べる。種類ごとに別々の場所を選べる形にしない —— 生データだけ移して要約を据え置くと、
// 要約の見回り（`waveSummaryKeeper.ts`）が古い時の要約を「元が無くなった」と読んで捨てる。
//
// **管理コンソールで変えた保存先は、次の起動で効く**（同じ日のユーザー決定）。変えた値は
// `pendingDataRoot` に置き、起動時に `dataRoot` へ昇格させる。稼働中に書き手と読み手を付け替えないので、
// 開いたままのファイル・片方だけが新しい場所を見る食い違いが構造的に起きない。
//
// **設定ファイル自身は保存先の中に置かない**（保存先を読むために保存先が要る形になる）。観測点の設定
// （`stations.xml`）と同じ `config/` に置く。
//
// **環境変数（`SEISMO_RAW_DIR` ほか 4 つ）が 1 つでもあれば、そちらを使う。** 従来の起動方法を壊さない。
// そのときは画面からは変えられない（`locked`）。

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, win32 } from 'node:path'

export const HOST_SETTINGS_FILE = 'host-settings.json'

/** 保存先の下に並べる 4 つの置き場所の名前。**複製（`storageMigration.ts`）もこの名前だけを辿る。** */
export const STORAGE_KINDS = ['raw', 'wave', 'events', 'summary'] as const
export type StorageKind = (typeof STORAGE_KINDS)[number]

export const STORAGE_ENV_VARS = {
  raw: 'SEISMO_RAW_DIR',
  wave: 'SEISMO_WAVE_DIR',
  summary: 'SEISMO_SUMMARY_DIR',
  events: 'SEISMO_EVENT_DIR',
} as const satisfies Record<StorageKind, string>

export interface HostSettings {
  /** いま使っている保存先。`null` は既定（`seismo-host/data/`）。 */
  readonly dataRoot: string | null
  /** 次の起動で使う保存先。`null` は変更なし。 */
  readonly pendingDataRoot: string | null
  /**
   * 保存先を選んだ時点の保存先（絶対パス）。次の起動では**ここから複製する**（2026-10-13 ユーザー承認）。
   * 既定の保存先はプログラムの置き場所から決まるので、変更を待たせたままプログラムのフォルダを移すと、
   * 起動した時の「今の保存先」は移した先の空のフォルダになる。選んだ時の場所を覚えておけば、元のデータの
   * ある場所から複製できる。v5.49.0 までの設定には無い（`null` なら起動した時の保存先から複製する）。
   */
  readonly pendingFrom: string | null
}

export const EMPTY_HOST_SETTINGS: HostSettings = { dataRoot: null, pendingDataRoot: null, pendingFrom: null }

export interface StorageDirs {
  readonly raw: string
  readonly wave: string
  readonly summary: string
  readonly events: string
}

export interface ResolvedStorage {
  /** どこから決めたか。`env` のときは画面から変えられない。 */
  readonly source: 'env' | 'settings' | 'default'
  /** 保存先の親フォルダ。環境変数で決めたときは `null`（4 つが同じ親にあるとは限らない）。 */
  readonly root: string | null
  readonly dirs: StorageDirs
  /**
   * この起動で保存先が変わった。複製元の親フォルダ（保存先を選んだ時の場所。覚えていなければ起動した時の
   * 保存先）。変わっていなければ `null`。
   */
  readonly movedFrom: string | null
  /** 書き戻す設定。**昇格させたときだけ** `null` 以外。 */
  readonly nextSettings: HostSettings | null
  /** 環境変数が効いているのに、画面で変えた保存先が待っている（効かないことを知らせる）。 */
  readonly pendingIgnored: string | null
}

export function dirsUnder(root: string): StorageDirs {
  return {
    raw: join(root, 'raw'),
    wave: join(root, 'wave'),
    summary: join(root, 'summary'),
    events: join(root, 'events'),
  }
}

/**
 * 起動時に保存先を決める（純関数）。順番は 環境変数 → 待っている変更 → 設定の保存先 → 既定。
 *
 * **環境変数は 1 つだけでも全体を環境変数の扱いにする**（画面からは変えられず、待っている変更も効かない）。
 * 一部の種類だけを待っている変更で動かすと、生データだけ移って要約が据え置かれる形になり、要約の見回りが
 * 古い時の要約を捨てる。足りない種類は、いまの保存先（設定の保存先、無ければ既定）の下に置いたまま動かさない。
 */
export function resolveStorage(input: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly settings: HostSettings
  readonly defaultRoot: string
}): ResolvedStorage {
  const { env, settings, defaultRoot } = input
  const fromEnv = (kind: StorageKind): string | undefined => {
    const v = env[STORAGE_ENV_VARS[kind]]
    return v === undefined || v === '' ? undefined : v
  }
  if (STORAGE_KINDS.some((k) => fromEnv(k) !== undefined)) {
    // 足りない種類は、画面で選んであった保存先（無ければ既定）から補う。既定へ戻すと、画面で移した後に
    // 環境変数を 1 つ足しただけで、残りの種類が黙って既定の場所へ書き始め、データが 2 か所に割れる。
    const d = dirsUnder(settings.dataRoot ?? defaultRoot)
    return {
      source: 'env',
      root: null,
      dirs: {
        raw: fromEnv('raw') ?? d.raw,
        wave: fromEnv('wave') ?? d.wave,
        summary: fromEnv('summary') ?? d.summary,
        events: fromEnv('events') ?? d.events,
      },
      movedFrom: null,
      nextSettings: null,
      pendingIgnored: settings.pendingDataRoot,
    }
  }
  const current = settings.dataRoot ?? defaultRoot
  if (settings.pendingDataRoot !== null && !samePath(settings.pendingDataRoot, current)) {
    const root = settings.pendingDataRoot
    return {
      source: 'settings',
      root,
      dirs: dirsUnder(root),
      movedFrom: settings.pendingFrom ?? current,
      nextSettings: { dataRoot: root, pendingDataRoot: null, pendingFrom: null },
      pendingIgnored: null,
    }
  }
  if (settings.pendingDataRoot !== null) {
    // 今と同じ場所が待っていた（変えて戻した）。待ちだけ片付ける。
    return {
      source: settings.dataRoot === null ? 'default' : 'settings',
      root: current,
      dirs: dirsUnder(current),
      movedFrom: null,
      nextSettings: { dataRoot: settings.dataRoot, pendingDataRoot: null, pendingFrom: null },
      pendingIgnored: null,
    }
  }
  return {
    source: settings.dataRoot === null ? 'default' : 'settings',
    root: current,
    dirs: dirsUnder(current),
    movedFrom: null,
    nextSettings: null,
    pendingIgnored: null,
  }
}

/**
 * 比べるときのパスの作法は `platform` のものを使う（実行している OS のものではない）。
 * **区切り・絶対パスの判定・解決を実行環境の `node:path` に任せると、`platform` を渡しても半分しか効かない** ——
 * Linux の CI で Windows のパスを渡すと絶対パスと見なされず、比べる前に弾かれる。
 */
function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** Windows ではパスの大文字・小文字を区別しない。比べる前に揃える。 */
function normalizeForCompare(path: string, platform: NodeJS.Platform): string {
  const { resolve, sep } = pathFor(platform)
  const r = resolve(path)
  const trimmed = r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizeForCompare(a, platform) === normalizeForCompare(b, platform)
}

/** `inner` が `outer` の中（同じ場所は含まない）にあるか。 */
export function isInside(inner: string, outer: string, platform: NodeJS.Platform = process.platform): boolean {
  const i = normalizeForCompare(inner, platform)
  const o = normalizeForCompare(outer, platform)
  const { sep } = pathFor(platform)
  const prefix = o.endsWith(sep) ? o : o + sep
  return i.startsWith(prefix)
}

/** 保存先として受け付けられない理由。受け付けられるなら `null`。**ディスクに触らない部分だけ。** */
export function storageRootProblem(
  candidate: string,
  current: string,
  platform: NodeJS.Platform = process.platform,
): StorageRootProblem | null {
  if (candidate.trim() === '' || !pathFor(platform).isAbsolute(candidate)) return 'not-absolute'
  if (samePath(candidate, current, platform)) return 'same'
  if (isInside(candidate, current, platform) || isInside(current, candidate, platform)) return 'nested'
  return null
}

export type StorageRootProblem =
  | 'not-absolute'
  | 'same'
  | 'nested'
  | 'not-writable'
  | 'not-enough-space'
  | 'locked'
  | 'migrating'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

export function parseHostSettings(text: string): HostSettings | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  const pathOrNull = (v: unknown): string | null | undefined =>
    v === undefined || v === null ? null : typeof v === 'string' && isAbsolute(v) ? v : undefined
  const dataRoot = pathOrNull(o.dataRoot)
  const pendingDataRoot = pathOrNull(o.pendingDataRoot)
  const pendingFrom = pathOrNull(o.pendingFrom)
  if (dataRoot === undefined || pendingDataRoot === undefined || pendingFrom === undefined) return null
  return { dataRoot, pendingDataRoot, pendingFrom }
}

/**
 * 設定ファイルを読む。無ければ空の設定。
 *
 * **読めない・形が合わないときは投げる**（ホストは起動しない）。既定の場所へ黙って倒すと、前に選んだ
 * 保存先と違う場所へ書き始め、データが 2 か所に割れる。生データの置き場所を作れないときに落ちるのと同じ判断。
 */
export function readHostSettings(path: string): HostSettings {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return EMPTY_HOST_SETTINGS
    throw new Error(`ホストの設定（${path}）を読めず: ${messageOf(error)}`)
  }
  const parsed = parseHostSettings(text)
  if (parsed === null) throw new Error(`ホストの設定（${path}）の形が合わない`)
  return parsed
}

/** 一時ファイルへ書いてから置き換える（`stationStore.ts` と同じ手順）。失敗は投げる。 */
export function writeHostSettings(path: string, settings: HostSettings): void {
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, `${JSON.stringify(settings, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}
