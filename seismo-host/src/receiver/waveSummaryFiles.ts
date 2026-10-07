// 要約（`waveSummary.ts`）の置き場所と、要約を 1 本作る処理。
//
// **要約は元のファイル 1 本につき 1 本。** 置き場所は元のファイルの並びを写す。
//
// ```
// <要約の置き場所>/raw/<日>/raw-<日>T<時>.<部分>.wsum      ← <生データ>/<日>/raw-<日>T<時>.mseed3
// <要約の置き場所>/wave/wave-<札>-<日>T<時>.<部分>.wsum    ← <合成波形>/wave-<札>-<日>T<時>.bin
// ```
//
// 部分は `fine`（1 秒ごとの段）・`coarse`（1 分ごとの段）・`psd`（1 分ごとの PSD）の 3 本
// （分ける理由は `waveSummary.ts` の書き出しの節）。`SummaryJob.summaryPath` は部分を除いた名前の元。
//
// **合成波形は観測点の札（`stationFileToken`）で引く。** 札から観測点の識別子へは戻せない
// （均して指紋を足した名前なので）。読み返す側は識別子から札を作って引く。
//
// **書くときは一時ファイルへ書いてから置き換える。** 読み返しが書きかけを掴むと、壊れた要約として
// 捨てるだけで済む（`decodeSummary` が長さを確かめる）が、置き換えれば掴む機会そのものが無くなる。

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  SUMMARY_LAST_PART,
  SUMMARY_PARTS,
  SUMMARY_PEEK_BYTES,
  encodeSummaryPart,
  peekSummarySourceBytes,
  type SourceProblems,
  type SummaryPart,
} from './waveSummary'
import { summarizeMseedHour, summarizeWaveHour } from './waveSummarySources'

const RAW_FILE_RE = /^raw-(\d{4}-\d{2}-\d{2}T\d{2})\.mseed3$/
const WAVE_FILE_RE = /^wave-(.+)-(\d{4}-\d{2}-\d{2}T\d{2})\.bin$/
const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/

/** 要約を作る 1 件。 */
export interface SummaryJob {
  readonly kind: 'raw' | 'wave'
  readonly sourcePath: string
  readonly summaryPath: string
  /** 日本時間の時（`YYYY-MM-DDTHH`）。 */
  readonly hourKey: string
  readonly hourStartMs: number
  /** 合成波形なら観測点の札。生データは `null`。 */
  readonly stationKey: string | null
}

export type SummaryJobResult =
  | {
      readonly ok: true
      /** 要約を作ったときに読んだ元のファイルの大きさ。 */
      readonly sourceBytes: number
      readonly summaryBytes: number
      readonly channels: number
      readonly problems: SourceProblems
      readonly outOfWindowSamples: number
      readonly ms: number
    }
  | { readonly ok: false; readonly error: string }

/** 日本時間の時（`YYYY-MM-DDTHH`）の頭。読めなければ `null`。 */
export function hourStartOf(hourKey: string): number | null {
  const ms = Date.parse(`${hourKey}:00:00+09:00`)
  return Number.isFinite(ms) ? ms : null
}

/** 生データの時の要約の名前の元（部分を付ける前）。 */
export function rawSummaryPath(summaryDir: string, hourKey: string): string {
  return join(summaryDir, 'raw', hourKey.slice(0, 10), `raw-${hourKey}`)
}

/** 合成波形の時の要約の名前の元（部分を付ける前）。 */
export function waveSummaryPath(summaryDir: string, stationKey: string, hourKey: string): string {
  return join(summaryDir, 'wave', `wave-${stationKey}-${hourKey}`)
}

/** 名前の元に部分を付けた、実際のファイルの場所。 */
export function summaryPartPath(summaryBase: string, part: SummaryPart): string {
  return `${summaryBase}.${part}.wsum`
}

/** 一覧を作れなかった場所。**「元のファイルが無い」と区別する**（数えて状態の口へ出す）。 */
export interface ListResult {
  readonly jobs: SummaryJob[]
  readonly errors: string[]
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 元のファイルを数え上げ、要約を作る 1 件ずつにする。**置き場所がまだ無いのは異常ではない**
 * （生データも合成波形もまだ 1 本も書いていない）。それ以外の読み損ねは `errors` に積む。
 */
export async function listSummaryJobs(dirs: {
  readonly rawDir: string
  readonly waveDir: string
  readonly summaryDir: string
}): Promise<ListResult> {
  const jobs: SummaryJob[] = []
  const errors: string[] = []

  let days: string[] = []
  try {
    days = (await readdir(dirs.rawDir)).filter((d) => DAY_DIR_RE.test(d))
  } catch (error) {
    if (!isMissing(error)) errors.push(`生データの置き場所を読めず: ${messageOf(error)}`)
  }
  for (const day of days) {
    let names: string[]
    try {
      names = await readdir(join(dirs.rawDir, day))
    } catch (error) {
      if (!isMissing(error)) errors.push(`${day} を読めず: ${messageOf(error)}`)
      continue
    }
    for (const name of names) {
      const m = RAW_FILE_RE.exec(name)
      if (m === null) continue
      const hourKey = m[1]!
      const hourStartMs = hourStartOf(hourKey)
      if (hourStartMs === null) continue
      jobs.push({
        kind: 'raw',
        sourcePath: join(dirs.rawDir, day, name),
        summaryPath: rawSummaryPath(dirs.summaryDir, hourKey),
        hourKey,
        hourStartMs,
        stationKey: null,
      })
    }
  }

  let waves: string[] = []
  try {
    waves = await readdir(dirs.waveDir)
  } catch (error) {
    if (!isMissing(error)) errors.push(`合成波形の置き場所を読めず: ${messageOf(error)}`)
  }
  for (const name of waves) {
    const m = WAVE_FILE_RE.exec(name)
    if (m === null) continue
    const stationKey = m[1]!
    const hourKey = m[2]!
    const hourStartMs = hourStartOf(hourKey)
    if (hourStartMs === null) continue
    jobs.push({
      kind: 'wave',
      sourcePath: join(dirs.waveDir, name),
      summaryPath: waveSummaryPath(dirs.summaryDir, stationKey, hourKey),
      hourKey,
      hourStartMs,
      stationKey,
    })
  }
  return { jobs, errors }
}

/** 元のファイルの大きさ。無ければ `null`。 */
export async function sourceSizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/**
 * 要約が控えている元のファイルの大きさ（**最後に書く部分**の頭だけ読む）。要約が無い・読めない・形が
 * 違うなら `null`（作り直せばよい）。最後に書く部分で見るのは、途中の部分を書いたところで落ちたとき、
 * 最後の部分が古いまま残って作り直しになるため。
 */
export async function summarizedSourceBytes(summaryBase: string): Promise<number | null> {
  let handle
  try {
    handle = await open(summaryPartPath(summaryBase, SUMMARY_LAST_PART), 'r')
  } catch {
    return null
  }
  try {
    const head = Buffer.alloc(SUMMARY_PEEK_BYTES)
    const { bytesRead } = await handle.read(head, 0, SUMMARY_PEEK_BYTES, 0)
    return peekSummarySourceBytes(head.subarray(0, bytesRead))
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * 要約を 1 本作って書く。**投げない**（失敗は `ok: false` で返す）。
 *
 * 別スレッド（`waveSummaryWorker.ts`）から呼ぶ。同じスレッドで呼ぶと、生データ 1 時間で 1 秒あまり
 * 受信を塞ぐ。
 */
export async function buildSummaryFile(job: SummaryJob): Promise<SummaryJobResult> {
  const started = performance.now()
  let tmp: string | null = null
  try {
    const buf = await readFile(job.sourcePath)
    const file =
      job.kind === 'raw'
        ? summarizeMseedHour(buf, job.hourStartMs)
        : summarizeWaveHour(buf, job.stationKey ?? '', job.hourStartMs)
    await mkdir(dirname(job.summaryPath), { recursive: true })
    let summaryBytes = 0
    // **最後に書く部分（`SUMMARY_LAST_PART`）を最後に置き換える。** 作り直すかはその頭で決める。
    for (const part of SUMMARY_PARTS) {
      const encoded = encodeSummaryPart(file, part)
      const path = summaryPartPath(job.summaryPath, part)
      tmp = `${path}.tmp`
      await writeFile(tmp, encoded)
      await rename(tmp, path)
      tmp = null
      summaryBytes += encoded.length
    }
    return {
      ok: true,
      sourceBytes: file.sourceBytes,
      summaryBytes,
      channels: file.channels.length,
      problems: file.sourceProblems,
      outOfWindowSamples: file.outOfWindowSamples,
      ms: performance.now() - started,
    }
  } catch (error) {
    if (tmp !== null) await unlink(tmp).catch(() => undefined)
    return { ok: false, error: messageOf(error) }
  }
}
