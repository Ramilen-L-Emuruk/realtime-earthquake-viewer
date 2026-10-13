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
//    外（稼働の印・欠けの帳面）には触らない
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
/** 複製の速さの上限（ライブの書き込みを邪魔しない）。 */
const BYTES_PER_SEC_DEFAULT = 20 * 1024 * 1024
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

export type MigrationState = 'copying' | 'copied' | 'purging' | 'done'

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
  /** 古い場所で消したもの・消さなかったもの。 */
  purged: { files: number; bytes: number; kept: number } | null
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
  readonly lastError: string | null
  /** 承認すれば古い場所で消すもの（`copied` のときだけ）。 */
  readonly purgeable: { readonly files: number; readonly bytes: number; readonly byKind: Record<StorageKind, { files: number; bytes: number }> } | null
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
  if (!['copying', 'copied', 'purging', 'done'].includes(o.state as string)) return null
  if (typeof o.verified !== 'object' || o.verified === null || typeof o.skipped !== 'object' || o.skipped === null) {
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

/**
 * 保存先が変わった起動で、帳面を始める。既に同じ複製元の帳面があればそのまま（続きから）。
 * **別の複製元の帳面が残っていれば投げる**（前の移動の「消してよい物」の記録を上書きしない）。
 */
export async function beginMigration(to: string, from: string, nowMs: number): Promise<void> {
  const existing = await readMigrationJournal(to)
  if (existing !== null) {
    // **続きとして扱うのは複製の途中だけ。** 済んだ帳面（`copied`・`done`）を同じ複製元だからと使い回すと、
    // 行って戻って行き直したとき、前の回の「済んだ」を根拠にこの回の分を複製せず、古い照合で消してしまう。
    // 同じ複製元なら済んだ帳面は作り直してよい（複製先に既にある同じ中身は、照合し直せば済んだに戻る）。
    if (existing.from === from && existing.state === 'copying') return
    if (existing.from !== from && existing.state !== 'done') {
      throw new Error(`新しい保存先に、別の場所（${existing.from}）からの複製の記録が残っている`)
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

async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const h = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    h.update(chunk as Buffer)
    size += (chunk as Buffer).length
  }
  return { size, sha256: h.digest('hex') }
}

async function exists(path: string): Promise<boolean> {
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

/** 2 つのファイルが同じ実体か（同じドライブの同じファイル番号）。 */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })])
  return x.dev === y.dev && x.ino === y.ino
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
  private running = false
  private stopped = false

  constructor(options: StorageMigrationOptions) {
    this.opts = options
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()))
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

  /** 新しい保存先へ移す操作を受け付けてよいか（複製中・削除中は受け付けない）。 */
  blocksNewMove(): boolean {
    return this.journal !== null && (this.journal.state === 'copying' || this.journal.state === 'purging')
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
      if (this.stopped) break
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
      const [a, b] = await Promise.all([hashFile(src), hashFile(dest)])
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
    const rate = this.opts.bytesPerSec ?? BYTES_PER_SEC_DEFAULT
    const h = createHash('sha256')
    const startedAt = this.now()
    let size = 0
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        h.update(chunk)
        size += chunk.length
        const ahead = (size / rate) * 1000 - (this.now() - startedAt)
        if (ahead <= 50) {
          done(null, chunk)
          return
        }
        this.sleep(ahead).then(
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
   * （複製から承認までは日が空くことがある）。合わない・同じ実体・確かめられないものは残す。
   */
  async purge(): Promise<{ files: number; bytes: number; kept: number }> {
    const j = this.journal
    if (j === null || (j.state !== 'copied' && j.state !== 'purging')) throw new Error('複製が終わっていないので消せない')
    if (this.purgingNow) throw new Error('前の保存先を消している最中')
    this.purgingNow = true
    try {
      j.state = 'purging'
      await this.save()
      this.lastError = null
      let files = 0
      let bytes = 0
      let kept = 0
      for (const [key, v] of Object.entries(j.verified)) {
        const src = fromKey(j.from, key)
        const dest = fromKey(this.opts.to, key)
        try {
          // 前の回（途中で止まった回）に消した・人が消した。
          if (!(await exists(src))) continue
          const s = await stat(src)
          if (s.size !== v.size || (await sameFile(src, dest))) {
            kept += 1
            continue
          }
          const d = await hashFile(dest)
          if (d.size !== v.size || d.sha256 !== v.sha256) {
            kept += 1
            continue
          }
          await unlink(src)
          files += 1
          bytes += v.size
        } catch (error) {
          // 複製先が無い・読めない・元を消せない。どれも元は残す。
          kept += 1
          this.fail(`${key} を消さずに残した: ${messageOf(error)}`)
        }
      }
      for (const kind of STORAGE_KINDS) await removeEmptyDirs(join(j.from, kind))
      j.state = 'done'
      j.purgedAtMs = this.now()
      j.purged = { files, bytes, kept }
      await this.save()
      this.opts.log?.(`[migration] 古い場所（${j.from}）から ${files} 本を消した（残したもの ${kept} 本）`)
      return j.purged
    } finally {
      this.purgingNow = false
    }
  }

  snapshot(): MigrationStatus | null {
    const j = this.journal
    if (j === null) return null
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
      lastError: this.lastError,
      purgeable,
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
