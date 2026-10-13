// 保存先を変えたあと、前の保存先にあるデータを新しい保存先へ裏で複製する係。
//
// **流れ**（2026-10-13 ユーザー決定「裏で複製・照合して、承認したら消す」）
// 1. 起動時に保存先が変わっていたら（`hostSettings.ts` の `movedFrom`）、新しい保存先に帳面
//    `migration.json` を作る。**帳面は設定ファイルより先に書く** —— 間で落ちても、次の起動でまた昇格し、
//    同じ複製元の帳面を見つけて続きから始める
// 2. 稼働したまま 1 本ずつ複製する。前の保存先はもう誰も書かないので、開いたままのファイルは無い
// 3. 1 本ごとに、一時名で書きながら元の SHA-256 を取り、書いた先を読み直して大きさと SHA-256 を照合して
//    から正式な名前にする。**正式な名前に既にファイルがあれば上書きしない**（切り替えた時に新しい保存先へ
//    書き始めた分。照合できなかったものとして残し、古い場所の同じファイルは消す対象から外す）
// 4. 全部終わったら `copied`。古い場所を消すのは、管理画面で承認されたとき（`purge`）だけ。消すのは
//    **照合を通ったファイルだけ**で、消す直前に元と複製先の大きさをもう一度比べる。複製元の 4 つの置き場所の
//    外（稼働の印・欠けの帳面）には触らない。1 本ごとの結果は帳面に残し（`purgeResult`）、一時的に読めなかった
//    分だけを `purging` のまま残して、承認し直せばそこから消す
//
// **読み直しにも速さの上限を掛ける**（`ReadThrottle`）。複製・既にある分の照合・消す前の読み直しは同じ枠を
// 使う（3 つは同時に走らない）。複製した直後の一時ファイルの読み直しだけは枠の外 —— 書いたばかりで、
// 枠に入れると複製の速さが半分になる。
//
// **順番は 要約 → 揺れの記録 → 合成波形 → 生データ。** 要約は元のファイルの大きさを控えていて、元と
// 大きさが合えば作り直さない（`waveSummaryKeeper.ts`）。先に要約を置けば、後から来た元とそのまま合う。
// 逆にすると、見回りが要約の無い元を見つけて作り直しにかかる。合成波形は前の時の大きさも見るので、
// 名前の順（観測点ごとに古い時から）で運ぶ。
//
// **複製が終わるまでは、要約の見回りの「元が無くなった要約を捨てる」を止める**（`isCopying()` を見回りへ渡す）。
// 要約を先に運ぶので、止めないと元が届く前に捨てられる。

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, link, mkdir, readFile, readdir, realpath, rename, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { STORAGE_KINDS, isInside, samePath, type StorageKind } from './hostSettings'

export const MIGRATION_FILE = 'migration.json'
const TMP_SUFFIX = '.migrating'
/** 読み書きの速さの上限（ライブの書き込みを邪魔しない）。 */
const BYTES_PER_SEC_DEFAULT = 20 * 1024 * 1024
/** これより長く読まなかったら、速さの勘定をやり直す（間を置いた後に溜まった分をまとめて速く読まない）。 */
const THROTTLE_IDLE_RESET_MS = 1000
/** 帳面を書き直す間隔（ファイル数）。落ちても失うのはこの本数ぶんの「済んだ」印だけ（照合し直せば戻る）。 */
const SAVE_EVERY = 20
/** 読めなかったファイルを諦めるまでの回数。 */
const MAX_ATTEMPTS = 3
/** 空きが足りない・元が見えないときに、やり直すまでの間。 */
const RETRY_MS_DEFAULT = 10 * 60_000
/** 複製先に残しておく空き（これを割り込むなら始めない）。 */
export const SPACE_MARGIN_BYTES = 1024 ** 3

/** 複製する順番（冒頭のコメント）。`STORAGE_KINDS` と同じ顔ぶれ。 */
export const COPY_ORDER: readonly StorageKind[] = ['summary', 'events', 'wave', 'raw']

/**
 * `abandoned` は複製の途中でやめた帳面（前の保存先が見つからなくなり、管理画面でやめた。2026-10-13 ユーザー承認）。
 * 帳面は残すが、状態の口には出さない（複製の欄ごと消える）。
 */
export type MigrationState = 'copying' | 'copied' | 'purging' | 'done' | 'abandoned'

export interface MigrationJournal {
  readonly version: 1
  readonly from: string
  readonly startedAtMs: number
  state: MigrationState
  /** 照合を通ったもの。鍵は `<種類>/<置き場所からの相対パス>`（区切りは `/`）。 */
  verified: Record<string, { size: number; sha256: string }>
  /** 複製しなかったもの（複製先に既にあった・読めなかった）。古い場所でも消さない。 */
  skipped: Record<string, 'exists' | 'unreadable'>
  copiedAtMs: number | null
  purgedAtMs: number | null
  /**
   * 古い場所で消したもの・消さなかったもの。`files`・`bytes` は承認の回をまたいだ合計、`kept` は直近の回で
   * 残したもの（合わなかった分と、一時的に読めなかった分）。
   */
  purged: { files: number; bytes: number; kept: number } | null
  /**
   * 照合済みのファイルごとの削除の結果。`removed` は古い場所から無くなった（消した・前から無かった）、
   * `mismatch` は消さないと決めた（複製先と合わない・複製先が無い・同じ実体）。**載っていないものが
   * まだ消していない分**で、承認し直すとそこだけを試す（一時的に読めなかった分はここに載せない）。
   * v5.49.0 までの帳面には無い（読むときに空で補う）。
   */
  purgeResult: Record<string, 'removed' | 'mismatch'>
}

export interface MigrationStatus {
  readonly from: string
  readonly to: string
  readonly state: MigrationState
  readonly startedAtMs: number
  /** 複製元を数え上げた結果。まだ数え上げていなければ `null`。 */
  readonly totalFiles: number | null
  readonly totalBytes: number | null
  readonly doneFiles: number
  readonly doneBytes: number
  readonly skippedExists: number
  readonly skippedUnreadable: number
  /** 空きが足りずに待っている（必要なバイト数・空き）。 */
  readonly blockedBySpace: { readonly neededBytes: number; readonly freeBytes: number } | null
  /** 複製の途中で前の保存先のフォルダが見つからない（`abandon` でやめられる）。 */
  readonly sourceMissing: boolean
  readonly lastError: string | null
  /** 承認すれば古い場所で消すもの（`copied`・止まった `purging` のときだけ）。まだ消していない分だけを数える。 */
  readonly purgeable: { readonly files: number; readonly bytes: number; readonly byKind: Record<StorageKind, { files: number; bytes: number }> } | null
  /** いま消している最中の進み具合（この回に試す件数と、そのうち済んだ件数）。消していなければ `null`。 */
  readonly purgeProgress: { readonly doneFiles: number; readonly totalFiles: number } | null
  readonly purged: MigrationJournal['purged']
  readonly copiedAtMs: number | null
  readonly purgedAtMs: number | null
}

export interface StorageMigrationOptions {
  /** 新しい保存先（帳面を置く場所）。 */
  readonly to: string
  readonly now?: () => number
  readonly bytesPerSec?: number
  readonly retryMs?: number
  /** 複製先の空き。差し替えられるのはテストのため。 */
  readonly freeBytesOf?: (path: string) => Promise<number>
  readonly sleep?: (ms: number) => Promise<void>
  readonly log?: (line: string) => void
}

interface SourceFile {
  readonly key: string
  readonly kind: StorageKind
  readonly rel: string
  readonly size: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
}

function isMissing(error: unknown): boolean {
  return codeOf(error) === 'ENOENT'
}

function toKey(kind: StorageKind, rel: string): string {
  return `${kind}/${rel.split(sep).join('/')}`
}

function fromKey(root: string, key: string): string {
  return join(root, ...key.split('/'))
}

export function parseMigrationJournal(text: string): MigrationJournal | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o.version !== 1 || typeof o.from !== 'string' || typeof o.startedAtMs !== 'number') return null
  if (!['copying', 'copied', 'purging', 'done', 'abandoned'].includes(o.state as string)) return null
  if (typeof o.verified !== 'object' || o.verified === null || typeof o.skipped !== 'object' || o.skipped === null) {
    return null
  }
  if (o.purgeResult === undefined) {
    o.purgeResult = {}
  } else if (typeof o.purgeResult !== 'object' || o.purgeResult === null) {
    return null
  }
  return o as unknown as MigrationJournal
}

/** 帳面を読む。無ければ `null`、読めなければ投げる（読めないまま新しく始めると、消してよい物の記録を失う）。 */
export async function readMigrationJournal(to: string): Promise<MigrationJournal | null> {
  const path = join(to, MIGRATION_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw new Error(`複製の記録（${path}）を読めず: ${messageOf(error)}`)
  }
  const j = parseMigrationJournal(text)
  if (j === null) throw new Error(`複製の記録（${path}）の形が合わない`)
  return j
}

async function writeJournal(to: string, journal: MigrationJournal): Promise<void> {
  const path = join(to, MIGRATION_FILE)
  await mkdir(to, { recursive: true })
  await writeFile(`${path}.tmp`, `${JSON.stringify(journal)}\n`)
  await rename(`${path}.tmp`, path)
}

export interface BeginMigrationOptions {
  /** パスを比べる作法（`hostSettings.ts` の `samePath`）。 */
  readonly platform: NodeJS.Platform
  /** 別の場所からの帳面を置き換えたことを残す口。 */
  readonly log: (line: string) => void
}

/** 2 つの複製元が同じ場所か。書き方の違い（大文字・小文字・末尾の区切り）を見てから、別名を解いた実体で比べる。 */
async function sameSource(a: string, b: string, platform: NodeJS.Platform): Promise<boolean> {
  if (samePath(a, b, platform)) return true
  const [ca, cb] = await Promise.all([canonicalPath(a), canonicalPath(b)])
  return samePath(ca, cb, platform)
}

/**
 * 保存先が変わった起動で、帳面を始める。既に同じ複製元の帳面があればそのまま（続きから）。
 * **同じかどうかは文字列ではなく `sameSource` で比べる** —— 書き方が違うだけで別の場所に見えると、
 * 済んだ帳面の残る場所へ戻す移動を起動のたびに断り続ける。
 *
 * 別の複製元の帳面は、**複製の途中（`copying`）なら投げる**（その場所からの複製がまだ済んでいない）。
 * 済んだ帳面（`copied`・`purging`・`done`）は置き換える（2026-10-13 ユーザー承認）。失うのは前の複製元を
 * 画面から消せる記録だけで、どちらの場所のファイルも消えない。置き換えたことはログへ残す。
 */
export async function beginMigration(to: string, from: string, nowMs: number, options: BeginMigrationOptions): Promise<void> {
  const existing = await readMigrationJournal(to)
  if (existing !== null) {
    const same = await sameSource(existing.from, from, options.platform)
    // **続きとして扱うのは複製の途中だけ。** 済んだ帳面（`copied`・`done`）を同じ複製元だからと使い回すと、
    // 行って戻って行き直したとき、前の回の「済んだ」を根拠にこの回の分を複製せず、古い照合で消してしまう。
    // 同じ複製元なら済んだ帳面は作り直してよい（複製先に既にある同じ中身は、照合し直せば済んだに戻る）。
    if (same && existing.state === 'copying') return
    if (!same && existing.state === 'copying') {
      throw new Error(`新しい保存先に、別の場所（${existing.from}）からの複製の記録が残っている`)
    }
    if (!same && existing.state !== 'done' && existing.state !== 'abandoned') {
      options.log(
        `[migration] ${to} に残っていた別の場所（${existing.from}）からの複製の記録を置き換えた。` +
          `${existing.from} に残っている分は、管理画面からは削除できなくなる`,
      )
    }
  }
  await writeJournal(to, {
    version: 1,
    from,
    startedAtMs: nowMs,
    state: 'copying',
    verified: {},
    skipped: {},
    copiedAtMs: null,
    purgedAtMs: null,
    purged: null,
    purgeResult: {},
  })
}

/** 複製元の置き場所を辿り、`COPY_ORDER` の順・名前の順に並べる。 */
async function listSource(from: string): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  for (const kind of COPY_ORDER) {
    const base = join(from, kind)
    const found: SourceFile[] = []
    const stack = [base]
    while (stack.length > 0) {
      const dir = stack.pop()!
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) stack.push(p)
        else if (e.isFile() && !e.name.endsWith(TMP_SUFFIX) && !e.name.endsWith('.tmp')) {
          const rel = relative(base, p)
          let size: number
          try {
            size = (await stat(p)).size
          } catch (error) {
            if (isMissing(error)) continue
            throw error
          }
          found.push({ key: toKey(kind, rel), kind, rel, size })
        }
      }
    }
    found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    out.push(...found)
  }
  return out
}

/**
 * 読み書きの速さの上限。読んだ（書いた）量を受け取り、上限より先へ進んでいれば待つ。**複製・照合・消す前の
 * 読み直しで 1 つを共有する**（冒頭）。しばらく読まなかったら勘定をやり直す —— 前に読んだ時刻を起点に
 * 数え続けると、間を置いた後の読み直しが「遅れを取り戻す」ように上限を超えて速く走る。
 */
export class ReadThrottle {
  private startedAt = 0
  private sent = 0
  private lastAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly bytesPerSec: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async take(bytes: number): Promise<void> {
    const t = this.now()
    if (t - this.lastAt > THROTTLE_IDLE_RESET_MS) {
      this.startedAt = t
      this.sent = 0
    }
    // **遅れの貸しは THROTTLE_IDLE_RESET_MS ぶんまで。** 読む側が上限より遅い区間（ディスクが混んでいる）が
    // 続くと、経過時間が送った量を追い越し続け、その後の速い区間で貸しが尽きるまで上限なしに読んでしまう。
    const earliest = t - THROTTLE_IDLE_RESET_MS - (this.sent / this.bytesPerSec) * 1000
    if (this.startedAt < earliest) this.startedAt = earliest
    this.sent += bytes
    const ahead = (this.sent / this.bytesPerSec) * 1000 - (t - this.startedAt)
    if (ahead > 50) await this.sleep(ahead)
    this.lastAt = this.now()
  }
}

async function hashFile(path: string, throttle: ReadThrottle | null = null): Promise<{ size: number; sha256: string }> {
  const h = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    h.update(chunk as Buffer)
    size += (chunk as Buffer).length
    if (throttle !== null) await throttle.take((chunk as Buffer).length)
  }
  return { size, sha256: h.digest('hex') }
}

/** パスがあるか。無ければ `false`、確かめられなければ投げる（起動時に複製元を確かめるのにも使う）。 */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/**
 * 別名（短い名前・ジャンクション・シンボリックリンク）を解いた実体のパス。まだ無い部分は、いちばん近い
 * 既にある上のフォルダを解いてから繋ぐ。**保存先どうしを比べる前に必ず通す** —— 文字列だけで比べると、
 * 同じフォルダを別名で指したとき「別の場所」に見え、複製が 1 バイトも動かないまま全部「照合済み」になって、
 * 古い場所を消すと実体ごと消える。
 */
export async function canonicalPath(path: string): Promise<string> {
  const rest: string[] = []
  let p = path
  for (;;) {
    try {
      const real = await realpath(p)
      return rest.length === 0 ? real : join(real, ...[...rest].reverse())
    } catch (error) {
      const parent = dirname(p)
      if (!isMissing(error) || parent === p) throw error
      rest.push(basename(p))
      p = parent
    }
  }
}

/**
 * ファイル番号から同じ実体かを決める。**番号が 0 なら決めない（`null`）** —— 番号を持たないファイルシステム
 * では全部のファイルが 0 になり、同じドライブなら何でも「同じ実体」に見える。
 */
export function sameIdentity(x: { dev: bigint; ino: bigint }, y: { dev: bigint; ino: bigint }): boolean | null {
  if (x.ino === 0n || y.ino === 0n) return null
  return x.dev === y.dev && x.ino === y.ino
}

/** 2 つのファイルが同じ実体か。ファイル番号で決められなければ、別名を解いた実体のパスで比べる。 */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })])
  const byIdentity = sameIdentity(x, y)
  if (byIdentity !== null) return byIdentity
  const [ra, rb] = await Promise.all([realpath(a), realpath(b)])
  return samePath(ra, rb)
}

/**
 * 一時ファイルを正式な名前へ置く。**既にあれば置かない**（`rename` は上書きするので使わない）。
 * ハードリンクを張れないドライブ（exFAT など）では、上書きしない指定で写してから一時ファイルを消す。
 * 置けなかった（既にあった）ら `false`。
 */
async function placeNoOverwrite(tmp: string, dest: string): Promise<boolean> {
  try {
    await link(tmp, dest)
  } catch (error) {
    const code = codeOf(error)
    if (code === 'EEXIST') {
      await unlink(tmp)
      return false
    }
    try {
      await copyFile(tmp, dest, constants.COPYFILE_EXCL)
    } catch (error2) {
      if (codeOf(error2) === 'EEXIST') {
        await unlink(tmp)
        return false
      }
      throw error2
    }
  }
  await unlink(tmp)
  return true
}

export class StorageMigration {
  private readonly opts: StorageMigrationOptions
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private journal: MigrationJournal | null = null
  private sources: SourceFile[] | null = null
  private attempts = new Map<string, number>()
  private doneBytes = 0
  private copiedThisRun = 0
  private blockedBySpace: MigrationStatus['blockedBySpace'] = null
  private lastError: string | null = null
  private purgingNow = false
  private purgeProgress: { doneFiles: number; totalFiles: number } | null = null
  /** 直近の複製の回で、前の保存先のフォルダが見つからなかった（`abandon` を受け付ける）。 */
  private sourceMissing = false
  private running = false
  private stopped = false
  private readonly throttle: ReadThrottle

  constructor(options: StorageMigrationOptions) {
    this.opts = options
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()))
    this.throttle = new ReadThrottle(options.bytesPerSec ?? BYTES_PER_SEC_DEFAULT, this.now, this.sleep)
  }

  /** 帳面を読み込む。帳面が無ければ何もしない係になる。 */
  async load(): Promise<void> {
    this.journal = await readMigrationJournal(this.opts.to)
    if (this.journal !== null) {
      for (const v of Object.values(this.journal.verified)) this.doneBytes += v.size
    }
  }

  /** 複製がまだ終わっていないか。**要約の見回りはこれが真の間、元の無い要約を捨てない。** */
  isCopying(): boolean {
    return this.journal !== null && this.journal.state === 'copying'
  }

  /**
   * 新しい保存先へ移す操作を受け付けないか（複製中・いま消している最中）。**止まった削除（`purging` で
   * 消していない）は止めない** —— 一時的に読めなかった分が読めないままだと、承認し直しても抜けられず、
   * 保存先を二度と変えられなくなる。移した後もこの帳面と前の保存先のファイルはそのまま残る。
   */
  blocksNewMove(): boolean {
    return this.journal !== null && (this.journal.state === 'copying' || this.purgingNow)
  }

  /** この起動で複製した累計のバイト数（容量の増え方から引く）。 */
  copiedBytesThisRun(): number {
    return this.copiedThisRun
  }

  stop(): void {
    this.stopped = true
  }

  /** 裏で走らせる。**投げない。** 帳面が無い・既に `copied` 以降なら何もしない。 */
  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.stopped && this.journal !== null && this.journal.state === 'copying') {
        let finished = false
        try {
          finished = await this.pass()
        } catch (error) {
          // `pass` の中で拾い損ねた例外。投げ返すと受信ごと落ちるので、理由を残してやり直しを待つ。
          this.fail(`複製が止まった: ${messageOf(error)}`)
        }
        if (finished) break
        await this.sleep(this.opts.retryMs ?? RETRY_MS_DEFAULT)
      }
    } finally {
      this.running = false
    }
  }

  /** 1 回通す。全部片付いたら `true`。 */
  async pass(): Promise<boolean> {
    const j = this.journal
    if (j === null || j.state !== 'copying') return true
    const { to } = this.opts
    // **複製元と複製先が同じ実体・入れ子なら 1 本も動かさない**（`canonicalPath` の注記）。管理画面の検査も
    // 実体で比べるが、設定ファイルを手で書いた場合や後からジャンクションを張った場合は、ここでしか止まらない。
    try {
      // **複製元のフォルダそのものが無ければ待つ。** ドライブが外れている・名前が変わった間に数え上げると
      // 0 件のまま `copied` になり、元のデータは 1 本も運ばれないまま「済んだ」になる。
      // 戻らないときは管理画面でやめられる（`abandon`）。
      if (!(await exists(j.from))) {
        this.sourceMissing = true
        this.fail(`前の保存先（${j.from}）が見つからない`)
        return false
      }
      this.sourceMissing = false
      const [rf, rt] = await Promise.all([canonicalPath(j.from), canonicalPath(to)])
      if (samePath(rf, rt) || isInside(rf, rt) || isInside(rt, rf)) {
        this.fail(`複製元（${j.from}）と複製先（${to}）が同じ場所か入れ子なので、複製しない`)
        return false
      }
    } catch (error) {
      this.fail(`複製元（${j.from}）か複製先の場所を確かめられず: ${messageOf(error)}`)
      return false
    }
    try {
      this.sources = await listSource(j.from)
    } catch (error) {
      this.fail(`複製元（${j.from}）を数え上げられず: ${messageOf(error)}`)
      return false
    }
    const remaining = this.sources.filter((f) => j.verified[f.key] === undefined && j.skipped[f.key] === undefined)
    const neededBytes = remaining.reduce((a, f) => a + f.size, 0)
    if (this.opts.freeBytesOf !== undefined && remaining.length > 0) {
      try {
        const free = await this.opts.freeBytesOf(to)
        if (free < neededBytes + SPACE_MARGIN_BYTES) {
          this.blockedBySpace = { neededBytes: neededBytes + SPACE_MARGIN_BYTES, freeBytes: free }
          return false
        }
      } catch (error) {
        this.fail(`複製先の空きを測れず: ${messageOf(error)}`)
        return false
      }
    }
    this.blockedBySpace = null
    // ここまで来たら前の回の失敗は過去のもの。この回の失敗だけを残す。
    this.lastError = null

    let sinceSave = 0
    let failed = 0
    for (const f of remaining) {
      if (this.stopped || !this.stillCopying(j)) break
      try {
        await this.copyOne(j, f)
      } catch (error) {
        const n = (this.attempts.get(f.key) ?? 0) + 1
        this.attempts.set(f.key, n)
        this.lastError = `${f.key} を複製できず: ${messageOf(error)}`
        if (n >= MAX_ATTEMPTS) {
          j.skipped[f.key] = 'unreadable'
          this.opts.log?.(`[migration] ${f.key} を ${n} 回複製できず、諦めた（古い場所には残す）: ${messageOf(error)}`)
        } else {
          failed += 1
        }
      }
      sinceSave += 1
      if (sinceSave >= SAVE_EVERY) {
        await this.save()
        sinceSave = 0
      }
    }
    if (this.stopped) {
      await this.save()
      return true
    }
    // 途中でやめられた（`abandon` が書いた）。`copied` で上書きすると、やめた帳面が「済んだ」に化ける。
    // **`true` で返さない** —— `abandon` がこの後で書けずに `copying` へ戻すと、`run` が終わったまま
    // 係が居なくなる。`false` なら `run` は待ってから帳面を見直し、やめていれば抜け、戻っていれば続ける。
    if (!this.stillCopying(j)) return false
    if (failed > 0) {
      await this.save()
      return false
    }
    j.state = 'copied'
    j.copiedAtMs = this.now()
    await this.save()
    this.opts.log?.(
      `[migration] 複製を終えた（${Object.keys(j.verified).length} 本・既にあったので残したもの ${
        Object.values(j.skipped).filter((s) => s === 'exists').length
      } 本・読めなかったもの ${Object.values(j.skipped).filter((s) => s === 'unreadable').length} 本）`,
    )
    return true
  }

  private async save(): Promise<void> {
    if (this.journal === null) return
    try {
      await writeJournal(this.opts.to, this.journal)
    } catch (error) {
      this.fail(`複製の記録を書けず: ${messageOf(error)}`)
    }
  }

  /** 失敗を残し、ログにも出す（画面だけに置くと、管理画面を開かない運用で誰にも届かない）。 */
  private fail(message: string): void {
    this.lastError = message
    this.opts.log?.(`[migration] ${message}`)
  }

  private async copyOne(j: MigrationJournal, f: SourceFile): Promise<void> {
    const src = fromKey(j.from, f.key)
    const dest = fromKey(this.opts.to, f.key)
    if (await exists(dest)) {
      // 同じ実体なら複製したことにならない（消すと実体ごと消える）。済んだにも残すにも数えず、失敗にする。
      if (await sameFile(src, dest)) throw new Error('複製元と複製先が同じファイル')
      // 前の起動で置いた後、帳面へ書く前に落ちた分なら中身が同じ。同じなら済んだ扱い。
      // 帳面を作り直した後は全部がここを通るので、2 本とも速さの上限を通して順に読む。
      const a = await hashFile(src, this.throttle)
      const b = await hashFile(dest, this.throttle)
      if (a.size === b.size && a.sha256 === b.sha256) {
        j.verified[f.key] = a
        this.doneBytes += a.size
      } else {
        j.skipped[f.key] = 'exists'
      }
      return
    }
    await mkdir(dirname(dest), { recursive: true })
    const tmp = `${dest}${TMP_SUFFIX}`
    let srcHash: { size: number; sha256: string }
    let placed: boolean
    try {
      srcHash = await this.copyThrottled(src, tmp)
      const destHash = await hashFile(tmp)
      if (srcHash.size !== destHash.size || srcHash.sha256 !== destHash.sha256) {
        throw new Error('書いた先が元と合わない')
      }
      const st = await stat(src)
      await utimes(tmp, st.atime, st.mtime)
      placed = await placeNoOverwrite(tmp, dest)
    } catch (error) {
      // 書きかけの一時ファイルを残さない（満杯で止まったなら、残骸がさらに空きを食う）。
      await unlink(tmp).catch(() => {})
      throw error
    }
    if (!placed) {
      j.skipped[f.key] = 'exists'
      return
    }
    j.verified[f.key] = srcHash
    this.doneBytes += srcHash.size
    this.copiedThisRun += srcHash.size
  }

  /**
   * 元を読みながら SHA-256 を取り、速さの上限を守って書く。**読み・書きの失敗はどちらも投げ返す**
   * （`pipeline` がまとめて受ける）。書き込み口の `error` を誰も受けないと、複製先が満杯になったり
   * ドライブが外れたりした瞬間にホストごと落ちる。
   */
  private async copyThrottled(src: string, dest: string): Promise<{ size: number; sha256: string }> {
    const h = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        h.update(chunk)
        size += chunk.length
        this.throttle.take(chunk.length).then(
          () => done(null, chunk),
          (error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
        )
      },
    })
    await pipeline(createReadStream(src), meter, createWriteStream(dest))
    return { size, sha256: h.digest('hex') }
  }

  /**
   * 古い場所を消す（管理画面で承認されたときだけ呼ぶ）。`copied` か、途中で止まった `purging` のときだけ動く
   * （既に消えたものは飛ばし、残っているものだけを消し直すので、何度呼んでも同じところへ着く）。
   * **消すのは照合を通ったファイルだけ**で、消す直前に複製先を読み直し、大きさと SHA-256 を帳面と比べる
   * （複製から承認までは日が空くことがある）。合わない・同じ実体・複製先が無いものは残し、そう決めたことを
   * 帳面に残す（`mismatch`）。**読めない・消せないもの（一時的な失敗）は結果を残さず `purging` のまま終え**、
   * 承認し直せばそこだけを試す。止める合図が来たら、そこまでの結果を残して抜ける。
   *
   * 返すのはこの回の分（`kept` は合わなかった分と一時的に失敗した分）。帳面の `purged` は回をまたいだ合計。
   */
  async purge(): Promise<{ files: number; bytes: number; kept: number }> {
    const j = this.journal
    if (j === null || (j.state !== 'copied' && j.state !== 'purging')) throw new Error('複製が終わっていないので消せない')
    if (this.purgingNow) throw new Error('前の保存先を消している最中')
    this.purgingNow = true
    const pending = Object.entries(j.verified).filter(([key]) => j.purgeResult[key] === undefined)
    this.purgeProgress = { doneFiles: 0, totalFiles: pending.length }
    try {
      // 前の回の失敗は過去のもの。保存に失敗したらそれを残す（`save` が入れる）ので、消すのは保存より先。
      this.lastError = null
      j.state = 'purging'
      // **前の保存先・いまの保存先のフォルダそのものが見えなければ、1 本も結果を残さずにやめる。** ドライブが
      // 外れているだけなのに、全部を「前から無かった」「複製先が無い」と記録して終わらせない。確かめるのは
      // 帳面の保存より前 —— 保存は置き場所を作り直すので、後で確かめると見えないことに気づけない。
      // 帳面は書き換えない（読み直せば元の状態のまま。この起動の間だけ「削除の途中」として承認し直せる）。
      for (const [root, label] of [
        [j.from, '前の保存先'],
        [this.opts.to, 'いまの保存先'],
      ] as const) {
        if (!(await exists(root))) {
          this.fail(`${label}（${root}）が見つからない`)
          return { files: 0, bytes: 0, kept: pending.length }
        }
      }
      await this.save()
      // 種類ごとの置き場所が複製先に無いのも同じ扱い（その種類の分は結果を残さず、承認し直しで試す）。
      const destKindMissing = new Map<string, boolean>()
      let files = 0
      let bytes = 0
      let failed = 0
      let firstFailure: string | null = null
      let sinceSave = 0
      let stoppedEarly = false
      for (const [key, v] of pending) {
        if (this.stopped) {
          stoppedEarly = true
          break
        }
        const src = fromKey(j.from, key)
        const dest = fromKey(this.opts.to, key)
        try {
          // 前の回（途中で止まった回）に消した・人が消した。
          if (!(await exists(src))) {
            j.purgeResult[key] = 'removed'
            continue
          }
          const kind = key.split('/')[0]
          let kindMissing = destKindMissing.get(kind)
          if (kindMissing === undefined) {
            kindMissing = !(await exists(join(this.opts.to, kind)))
            destKindMissing.set(kind, kindMissing)
          }
          if (kindMissing) throw new Error(`いまの保存先に ${kind} の置き場所が見つからない`)
          // 複製先が無いのは、何度試しても合わない。読めないのは一時的かもしれないので結果を残さない（catch へ）。
          const s = await stat(src)
          if (s.size !== v.size || !(await exists(dest)) || (await sameFile(src, dest))) {
            j.purgeResult[key] = 'mismatch'
            continue
          }
          const d = await hashFile(dest, this.throttle)
          if (d.size !== v.size || d.sha256 !== v.sha256) {
            j.purgeResult[key] = 'mismatch'
            continue
          }
          await unlink(src)
          j.purgeResult[key] = 'removed'
          files += 1
          bytes += v.size
        } catch (error) {
          // 複製先を読めない・元を消せない。元は残し、承認し直したときにもう一度試す。
          failed += 1
          firstFailure ??= `${key}: ${messageOf(error)}`
        } finally {
          this.purgeProgress.doneFiles += 1
          sinceSave += 1
          if (sinceSave >= SAVE_EVERY) {
            await this.save()
            sinceSave = 0
          }
        }
      }
      for (const kind of STORAGE_KINDS) await removeEmptyDirs(join(j.from, kind))
      const remaining = Object.keys(j.verified).filter((key) => j.purgeResult[key] === undefined).length
      // 残したものは帳面から数え直す（前の回に「合わない」と決めた分も、画面の「残すもの」から消さない）。
      const mismatched = Object.values(j.purgeResult).filter((r) => r === 'mismatch').length
      const prev = j.purged
      j.purged = {
        files: (prev?.files ?? 0) + files,
        bytes: (prev?.bytes ?? 0) + bytes,
        kept: mismatched + failed,
      }
      if (remaining === 0) {
        j.state = 'done'
        j.purgedAtMs = this.now()
      }
      await this.save()
      // **失敗は 1 件ずつ出さずにまとめる**（同じ理由で数千件が並ぶと、ほかのログが流れて読めなくなる）。
      if (failed > 0) {
        this.fail(`前の保存先で ${failed} 件を消さずに残した（もう一度承認すれば消し直す。最初の理由: ${firstFailure}）`)
      }
      this.opts.log?.(
        `[migration] 古い場所（${j.from}）から ${files} 本を消した（合わずに残したもの ${mismatched} 本・まだ消していないもの ${remaining} 本）${
          stoppedEarly ? '。止める合図で途中でやめた' : ''
        }`,
      )
      return { files, bytes, kept: mismatched + failed }
    } finally {
      this.purgingNow = false
      this.purgeProgress = null
    }
  }

  /**
   * 複製をやめる（管理画面で承認されたときだけ呼ぶ。2026-10-13 ユーザー承認）。**前の保存先が見つからない
   * 間だけ**受け付ける —— 見えている間にやめる理由は無く、やめると前の保存先の残りは画面から消せなくなる。
   * どちらの場所のファイルにも触らず、帳面を `abandoned` にして閉じる（複製中ではなくなるので、保存先の変更と
   * 要約の片付けが戻る）。受け付けなければ `false`。**やめた記録を書けなければ投げ、複製中のまま残す** ——
   * 書けないまま閉じると、次の起動で帳面が `copying` のまま読まれ、画面では「やめた」のに複製が戻る。
   */
  async abandon(): Promise<boolean> {
    const j = this.journal
    if (j === null || j.state !== 'copying' || !this.sourceMissing) return false
    // 印は直近の回のもの。押されるまでの間に戻っていれば、やめずに戻った場所から複製を続ける。
    if (await exists(j.from)) {
      this.sourceMissing = false
      return false
    }
    if (!this.stillCopying(j)) return false
    j.state = 'abandoned'
    try {
      await writeJournal(this.opts.to, j)
    } catch (error) {
      j.state = 'copying'
      this.fail(`複製をやめた記録を書けず: ${messageOf(error)}`)
      throw error
    }
    this.lastError = null
    this.sourceMissing = false
    this.opts.log?.(`[migration] 前の保存先（${j.from}）からの複製をやめた（複製済み ${Object.keys(j.verified).length} 本）`)
    return true
  }

  /**
   * 帳面がまだ複製中か。**`pass` の途中で `abandon` に閉じられうる**ので、待ちを挟んだ後に見直す口
   * （型の上では入口の判定で `copying` に絞られたままに見えるので、関数を通して読み直す）。
   */
  private stillCopying(j: MigrationJournal): boolean {
    return j.state === 'copying'
  }

  snapshot(): MigrationStatus | null {
    const j = this.journal
    // やめた帳面は状態の口に出さない（複製の欄ごと消える）。
    if (j === null || j.state === 'abandoned') return null
    const skippedValues = Object.values(j.skipped)
    let purgeable: MigrationStatus['purgeable'] = null
    // 途中で止まった削除（`purging`）も、いま消していなければもう一度承認できる。
    if (j.state === 'copied' || (j.state === 'purging' && !this.purgingNow)) {
      const byKind = Object.fromEntries(STORAGE_KINDS.map((k) => [k, { files: 0, bytes: 0 }])) as Record<
        StorageKind,
        { files: number; bytes: number }
      >
      let files = 0
      let bytes = 0
      for (const [key, v] of Object.entries(j.verified)) {
        // 消した・消さないと決めた分は数えない（承認しても何も起きない分を「削除する件数」に入れない）。
        if (j.purgeResult[key] !== undefined) continue
        const kind = key.split('/')[0] as StorageKind
        if (byKind[kind] === undefined) continue
        byKind[kind].files += 1
        byKind[kind].bytes += v.size
        files += 1
        bytes += v.size
      }
      purgeable = { files, bytes, byKind }
    }
    return {
      from: j.from,
      to: this.opts.to,
      state: j.state,
      startedAtMs: j.startedAtMs,
      totalFiles: this.sources?.length ?? null,
      totalBytes: this.sources?.reduce((a, f) => a + f.size, 0) ?? null,
      doneFiles: Object.keys(j.verified).length,
      doneBytes: this.doneBytes,
      skippedExists: skippedValues.filter((s) => s === 'exists').length,
      skippedUnreadable: skippedValues.filter((s) => s === 'unreadable').length,
      blockedBySpace: this.blockedBySpace,
      sourceMissing: j.state === 'copying' && this.sourceMissing,
      lastError: this.lastError,
      purgeable,
      purgeProgress: this.purgeProgress === null ? null : { ...this.purgeProgress },
      purged: j.purged,
      copiedAtMs: j.copiedAtMs,
      purgedAtMs: j.purgedAtMs,
    }
  }
}

/** 空になったフォルダだけを下から片付ける。中身が残っていれば残す。**`root` 自身も空なら消す。** */
async function removeEmptyDirs(root: string): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) if (e.isDirectory()) await removeEmptyDirs(join(root, e.name))
  try {
    await rmdir(root)
  } catch {
    // 空でない・消せないなら残す。
  }
}
