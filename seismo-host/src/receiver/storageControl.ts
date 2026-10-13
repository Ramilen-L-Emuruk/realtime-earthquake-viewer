// 保存先の口（`GET`/`PUT /api/storage`・`POST /api/storage/purge-old`）の実体。
//
// 起動時に決めた保存先（`hostSettings.ts` の `resolveStorage`）・容量の係（`storageUsage.ts`）・複製の係
// （`storageMigration.ts`）を束ね、管理画面から見える形と、変える操作を 1 か所に置く。
//
// **保存先を変える操作は「次の起動で使う場所を設定ファイルへ書く」だけ。** 稼働中の書き手・読み手は
// 付け替えない（`hostSettings.ts` の冒頭）。受け付ける前に、書けるか・入れ子でないか・空きが足りるかを確かめる。

import { mkdir, statfs, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type HostSettings,
  type ResolvedStorage,
  type StorageRootProblem,
  resolveStorage,
  storageRootProblem,
  writeHostSettings,
} from './hostSettings'
import { SPACE_MARGIN_BYTES, canonicalPath, type MigrationStatus, type StorageMigration } from './storageMigration'
import type { StorageUsage, StorageUsageStatus } from './storageUsage'

export interface StorageStartup {
  readonly resolved: ResolvedStorage
  /** 起動後の設定（昇格を書き戻したならその後のもの）。 */
  readonly settings: HostSettings
  /** 保存先を移せなかった理由。移せなかったときは前の保存先のまま動き、待っている変更は残す。 */
  readonly problem: string | null
}

/**
 * 起動時に保存先を決める。保存先が変わる起動では、**複製の帳面を先に書き、それから設定を書き戻す**
 * （間で落ちても、次の起動でまた昇格して同じ帳面を見つける）。
 *
 * **帳面を始められなければ移さない**（前の保存先のまま動く）。ホストを止めると震度まで止まるので、
 * 落とさずに理由を画面へ出す（`StorageReport.startupProblem`）。
 */
export async function openStorageAtStartup(input: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly settings: HostSettings
  readonly settingsPath: string
  readonly defaultRoot: string
  readonly nowMs: number
  readonly begin: (to: string, from: string, nowMs: number) => Promise<void>
  readonly write: (path: string, settings: HostSettings) => void
  /** 別名を解いた実体のパス（`storageMigration.ts` の `canonicalPath`）。 */
  readonly canonical: (path: string) => Promise<string>
  /** 複製元のフォルダがあるか。 */
  readonly exists: (path: string) => Promise<boolean>
}): Promise<StorageStartup> {
  const { env, settings, defaultRoot } = input
  const resolved = resolveStorage({ env, settings, defaultRoot })
  if (resolved.nextSettings === null) return { resolved, settings, problem: null }
  if (resolved.movedFrom !== null && resolved.root !== null) {
    const stay = (): ResolvedStorage =>
      resolveStorage({ env, settings: { ...settings, pendingDataRoot: null }, defaultRoot })
    // **別名を解いた実体でも比べる。** 画面の検査（`setPending`）を通らない形 —— 設定ファイルを手で書いた・
    // 保存した後でジャンクションを張った —— で同じ場所や入れ子を指していると、移したことにして帳面を作り、
    // 複製は 1 本も成り立たないまま「複製中」から抜けられなくなる。移さずに理由を出す。
    try {
      const [to, from] = await Promise.all([input.canonical(resolved.root), input.canonical(resolved.movedFrom)])
      if (storageRootProblem(to, from) !== null) {
        return {
          resolved: stay(),
          settings,
          problem: `移す先（${resolved.root}）が今の保存先（${resolved.movedFrom}）と同じ場所か入れ子なので、移さなかった`,
        }
      }
    } catch (error) {
      return { resolved: stay(), settings, problem: messageOf(error) }
    }
    // **複製元が無ければ移さない。** 選んだ時の場所（`pendingFrom`）のドライブが外れている・フォルダを
    // 動かした間に移すと、複製が 1 本も運べないまま新しい保存先へ書き始める。待っている変更は残すので、
    // 戻せば次の起動で移る。
    try {
      if (!(await input.exists(resolved.movedFrom))) {
        return { resolved: stay(), settings, problem: `前の保存先（${resolved.movedFrom}）が見つからないので、移さなかった` }
      }
    } catch (error) {
      return { resolved: stay(), settings, problem: messageOf(error) }
    }
    try {
      await input.begin(resolved.root, resolved.movedFrom, input.nowMs)
      input.write(input.settingsPath, resolved.nextSettings)
      return { resolved, settings: resolved.nextSettings, problem: null }
    } catch (error) {
      return {
        resolved: stay(),
        settings,
        // **素の理由だけ**（画面が「保存先を移せなかった: 」を前に付ける）。
        problem: messageOf(error),
      }
    }
  }
  // 待ちが今と同じ場所だった（変えて戻した）。待ちを片付けるだけ。書けなくても動作は変わらない。
  try {
    input.write(input.settingsPath, resolved.nextSettings)
    return { resolved, settings: resolved.nextSettings, problem: null }
  } catch {
    return { resolved, settings, problem: null }
  }
}

export interface StorageReport {
  /** どこから決めたか。`env` のときは画面から変えられない。 */
  readonly source: ResolvedStorage['source']
  readonly root: string | null
  readonly dirs: ResolvedStorage['dirs']
  /** 次の起動で使う保存先（待っている変更）。 */
  readonly pendingRoot: string | null
  /** 環境変数が効いているので、待っている変更が効かない。 */
  readonly pendingIgnored: string | null
  /** 起動時に保存先を移せなかった理由（`openStorageAtStartup`）。 */
  readonly startupProblem: string | null
  /**
   * 複製の帳面（`migration.json`）を起動時に読めなかった理由。読めない間は複製を始めず、要約の
   * 「元が無い要約を捨てる」も止めたままにする（`main.ts`）—— どちらも画面に出さないと、止まったことに気づけない。
   */
  readonly journalProblem: string | null
  readonly usage: StorageUsageStatus
  readonly migration: MigrationStatus | null
}

/**
 * 状態の口（`/status`・認証なし）へ出す分。稼働状況タブの警告と毎分の要約が読む。
 * **保存先のパスは欄として載せない**（どこに何を置いているかは `/api/storage` の側）。ただし失敗の理由
 * （`lastError` など）は OS の例外の文面をそのまま載せるので、パスが混ざりうる —— ほかの欄（要約の見回り・
 * 観測点の設定の `lastError`）と同じ扱い。
 */
export interface StorageBrief {
  readonly drives: StorageUsageStatus['drives']
  readonly countedAtMs: number | null
  readonly lastError: string | null
  readonly migration: {
    readonly state: MigrationStatus['state']
    readonly doneFiles: number
    readonly totalFiles: number | null
    readonly blockedBySpace: boolean
    readonly lastError: string | null
  } | null
  readonly startupProblem: string | null
  readonly journalProblem: string | null
}

export function storageBrief(report: StorageReport): StorageBrief {
  const m = report.migration
  return {
    drives: report.usage.drives,
    countedAtMs: report.usage.countedAtMs,
    lastError: report.usage.lastError,
    migration:
      m === null
        ? null
        : {
            state: m.state,
            doneFiles: m.doneFiles,
            totalFiles: m.totalFiles,
            blockedBySpace: m.blockedBySpace !== null,
            lastError: m.lastError,
          },
    startupProblem: report.startupProblem,
    journalProblem: report.journalProblem,
  }
}

export type SetPendingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: StorageRootProblem; readonly detail?: string }

/** 受け付けたら `ok: true`（消すのは裏で。結果と進み具合は `get()` の `migration` に出る）。 */
export type PurgeResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'not-copied' | 'busy' }

/** `not-missing` は、前の保存先が見えている・複製中でない（やめる理由が無い）。 */
export type AbandonResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-missing' | 'failed'; readonly detail?: string }

export interface StorageOps {
  get(): StorageReport
  /** 次の起動で使う保存先を設定する。`null` は待っている変更を取り消す。 */
  setPending(root: string | null): Promise<SetPendingResult>
  /** 古い場所を消す（承認されたとき）。 */
  purgeOld(): Promise<PurgeResult>
  /** 複製をやめる（前の保存先が見つからない間に承認されたとき）。 */
  abandonMigration(): Promise<AbandonResult>
}

export interface StorageControlOptions {
  readonly resolved: ResolvedStorage
  readonly startupProblem: string | null
  readonly journalProblem: string | null
  /** 起動後の設定（昇格を書き戻した後のもの）。 */
  readonly settings: HostSettings
  readonly settingsPath: string
  /** いまの保存先の親フォルダ（環境変数のときは既定の親フォルダ。比較にだけ使う）。 */
  readonly currentRoot: string
  readonly usage: StorageUsage
  readonly migration: StorageMigration
  /** 差し替えられるのはテストのため。 */
  readonly probeWritable?: (root: string) => Promise<string | null>
  readonly freeBytesOf?: (root: string) => Promise<number>
  readonly writeSettings?: (path: string, settings: HostSettings) => void
  readonly canonical?: (path: string) => Promise<string>
  readonly platform?: NodeJS.Platform
  /** 失敗をログへ出す口（画面だけに置くと、管理画面を開かない運用で誰にも届かない）。 */
  readonly log: (line: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 作れるか・書けるかを試す。書けなければ理由。**試しに書いたファイルは消す。** */
async function defaultProbeWritable(root: string): Promise<string | null> {
  const probe = join(root, `.seismo-write-test-${process.pid}`)
  try {
    await mkdir(root, { recursive: true })
    await writeFile(probe, 'ok')
    await unlink(probe)
    return null
  } catch (error) {
    return messageOf(error)
  }
}

async function defaultFreeBytesOf(root: string): Promise<number> {
  const s = await statfs(root)
  return Number(s.bavail) * Number(s.bsize)
}

export class StorageControl implements StorageOps {
  private readonly opts: StorageControlOptions
  private settings: HostSettings
  private purging = false
  private purgeTask: Promise<void> = Promise.resolve()

  constructor(options: StorageControlOptions) {
    this.opts = options
    this.settings = options.settings
  }

  get(): StorageReport {
    const r = this.opts.resolved
    return {
      source: r.source,
      root: r.root,
      dirs: r.dirs,
      pendingRoot: this.settings.pendingDataRoot,
      pendingIgnored: r.source === 'env' ? this.settings.pendingDataRoot : null,
      startupProblem: this.opts.startupProblem,
      journalProblem: this.opts.journalProblem,
      usage: this.opts.usage.snapshot(),
      migration: this.opts.migration.snapshot(),
    }
  }

  async setPending(root: string | null): Promise<SetPendingResult> {
    if (this.opts.resolved.source === 'env') return { ok: false, problem: 'locked' }
    if (root === null) {
      try {
        this.write({ ...this.settings, pendingDataRoot: null, pendingFrom: null })
      } catch (error) {
        return { ok: false, problem: 'not-writable', detail: `設定ファイルを書けず: ${messageOf(error)}` }
      }
      return { ok: true }
    }
    if (this.opts.migration.blocksNewMove()) return { ok: false, problem: 'migrating' }
    const problem = storageRootProblem(root, this.opts.currentRoot, this.opts.platform)
    if (problem !== null) return { ok: false, problem }
    // **別名を解いた実体でも比べる**（短い名前・ジャンクション）。文字列で違って見える同じフォルダを
    // 通すと、複製が 1 バイトも動かないまま全部「照合済み」になり、前の保存先を消すと実体ごと消える。
    try {
      const [rc, rr] = await Promise.all([
        (this.opts.canonical ?? canonicalPath)(root),
        (this.opts.canonical ?? canonicalPath)(this.opts.currentRoot),
      ])
      const realProblem = storageRootProblem(rc, rr, this.opts.platform)
      if (realProblem !== null) return { ok: false, problem: realProblem }
    } catch (error) {
      return { ok: false, problem: 'not-writable', detail: messageOf(error) }
    }
    const notWritable = await (this.opts.probeWritable ?? defaultProbeWritable)(root)
    if (notWritable !== null) return { ok: false, problem: 'not-writable', detail: notWritable }
    // **空きは、いまの使用量がまるごと入るか**（複製の係も始める前にもう一度確かめる）。
    // 数え終えていなければここでは見ない —— 受け付けを数えるまで待たせない。
    const kinds = this.opts.usage.snapshot().kinds
    if (kinds !== null) {
      const needed = kinds.reduce((a, k) => a + k.bytes, 0) + SPACE_MARGIN_BYTES
      let free: number
      try {
        free = await (this.opts.freeBytesOf ?? defaultFreeBytesOf)(root)
      } catch (error) {
        return { ok: false, problem: 'not-writable', detail: messageOf(error) }
      }
      if (free < needed) return { ok: false, problem: 'not-enough-space', detail: `${needed}/${free}` }
    }
    try {
      // **いまの保存先も一緒に書く**（`HostSettings.pendingFrom`）。次の起動はここから複製する。
      this.write({ ...this.settings, pendingDataRoot: root, pendingFrom: this.opts.currentRoot })
    } catch (error) {
      return { ok: false, problem: 'not-writable', detail: `設定ファイルを書けず: ${messageOf(error)}` }
    }
    return { ok: true }
  }

  /**
   * 前の保存先を消し始める。**消し終わるのを待たずに返す** —— 消す前に複製先を 1 本ずつ読み直すので、
   * 量によっては何時間もかかり、HTTP の応答の中では終わらない（速さの上限は `storageMigration.ts`）。
   * 進み具合と結果は `get()` の `migration`（`purgeProgress`・`purged`）で見る。
   */
  async purgeOld(): Promise<PurgeResult> {
    if (this.purging) return { ok: false, reason: 'busy' }
    // 途中で止まった削除（`purging`）は続きから消し直せる（`StorageMigration.purge`）。
    if (this.opts.migration.snapshot()?.purgeable == null) return { ok: false, reason: 'not-copied' }
    this.purging = true
    this.purgeTask = this.opts.migration
      .purge()
      .then(
        // 消した分を使用量へすぐ映す（次の定期の数え直しを待たない）。投げない作り（`count`）。
        () => void this.opts.usage.count(),
        // 裏で投げても受信ごと落とさない。理由はログへ残し、次の承認は受け付ける。
        (error: unknown) => this.opts.log(`[storage] 前の保存先を消せず: ${messageOf(error)}`),
      )
      .finally(() => {
        this.purging = false
      })
      // 最後の受け皿。上の受け止めそのものが投げても、未処理の拒否としてプロセスを落とさない。
      .catch((error: unknown) => console.error(`[storage] 前の保存先の削除の後始末で失敗: ${messageOf(error)}`))
    return { ok: true }
  }

  /** 複製をやめる（前の保存先が見つからない間だけ。`StorageMigration.abandon`）。 */
  async abandonMigration(): Promise<AbandonResult> {
    try {
      return (await this.opts.migration.abandon()) ? { ok: true } : { ok: false, reason: 'not-missing' }
    } catch (error) {
      this.opts.log(`[storage] 複製をやめられず: ${messageOf(error)}`)
      return { ok: false, reason: 'failed', detail: messageOf(error) }
    }
  }

  /** 裏の削除が終わるまで待つ（テストのため。消していなければすぐ返る）。 */
  async purgeSettled(): Promise<void> {
    await this.purgeTask
  }

  private write(next: HostSettings): void {
    ;(this.opts.writeSettings ?? writeHostSettings)(this.opts.settingsPath, next)
    this.settings = next
  }
}
