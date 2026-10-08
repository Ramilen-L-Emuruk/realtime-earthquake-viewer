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
// 生データの時だけ、受信の記録の要約（`<名前の元>.reception.json`・`receptionSummary.ts`）も置く。
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
import { encodeReceptionSummary } from './receptionSummary'
import { summarizeMseedHourWithReception, summarizeWaveHour } from './waveSummarySources'

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

/** 生データの時の、受信の記録の要約（`receptionSummary.ts`）の場所。合成波形には無い。 */
export function receptionSummaryPath(summaryBase: string): string {
  return `${summaryBase}.reception.json`
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

/** 置き場所にある要約 1 本（元の名前ごとに、部分・受信の記録・書きかけの一時ファイルをまとめたもの）。 */
export interface SummaryOnDisk {
  readonly kind: 'raw' | 'wave'
  /** 名前の元（`SummaryJob.summaryPath` と同じ形）。 */
  readonly summaryPath: string
  readonly files: string[]
}

export interface SummaryListResult {
  readonly summaries: SummaryOnDisk[]
  /** 読み損ねた場所。**1 つでもあれば、この回の一覧で「無い」と判断してはならない。** */
  readonly errors: string[]
}

const SUMMARY_SUFFIX_RE = new RegExp(
  `\\.(?:(?:${SUMMARY_PARTS.join('|')})\\.wsum|reception\\.json)(?:\\.tmp)?$`,
)
const WAVE_SUMMARY_BASE_RE = /^wave-.+-\d{4}-\d{2}-\d{2}T\d{2}$/

/**
 * 要約の置き場所（`raw/<日>/` と `wave/`）にある要約を数え上げる。**要約の名前の形をしたものだけ**
 * を拾い、それ以外（地震一覧の控え `quakes/` など）には触れない。置き場所がまだ無いのは異常ではない。
 */
export async function listSummaryFiles(summaryDir: string): Promise<SummaryListResult> {
  const groups = new Map<string, SummaryOnDisk>()
  const errors: string[] = []
  const add = (kind: 'raw' | 'wave', dir: string, name: string, baseRe: RegExp): void => {
    const m = SUMMARY_SUFFIX_RE.exec(name)
    if (m === null) return
    const base = name.slice(0, m.index)
    if (!baseRe.test(base)) return
    const summaryPath = join(dir, base)
    let g = groups.get(summaryPath)
    if (g === undefined) {
      g = { kind, summaryPath, files: [] }
      groups.set(summaryPath, g)
    }
    g.files.push(join(dir, name))
  }

  const rawRoot = join(summaryDir, 'raw')
  let days: string[] = []
  try {
    days = (await readdir(rawRoot)).filter((d) => DAY_DIR_RE.test(d))
  } catch (error) {
    if (!isMissing(error)) errors.push(`要約（生データ）の置き場所を読めず: ${messageOf(error)}`)
  }
  for (const day of days) {
    const dir = join(rawRoot, day)
    // **名前の日付と置き場所の日が違うものは拾わない。** 書き手（`rawSummaryPath`）は必ず揃えて置くので、
    // 違うものは書き手以外が置いたもの。拾うと元の名前と突き合わず、元があっても捨てる側へ倒れる。
    const sameDay = new RegExp(`^raw-${day}T\\d{2}$`)
    try {
      for (const name of await readdir(dir)) add('raw', dir, name, sameDay)
    } catch (error) {
      if (!isMissing(error)) errors.push(`要約 ${day} を読めず: ${messageOf(error)}`)
    }
  }

  const waveRoot = join(summaryDir, 'wave')
  try {
    for (const name of await readdir(waveRoot)) add('wave', waveRoot, name, WAVE_SUMMARY_BASE_RE)
  } catch (error) {
    if (!isMissing(error)) errors.push(`要約（合成波形）の置き場所を読めず: ${messageOf(error)}`)
  }
  return { summaries: [...groups.values()], errors }
}

/** 要約のファイルを消す。既に無いものは飛ばす。**消せなかったものがあれば、全部試してから最初の失敗を投げる。** */
export async function removeSummaryFiles(files: readonly string[]): Promise<void> {
  let first: unknown = null
  for (const path of files) {
    try {
      await unlink(path)
    } catch (error) {
      if (!isMissing(error) && first === null) first = error
    }
  }
  if (first !== null) throw first
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
    const built =
      job.kind === 'raw'
        ? summarizeMseedHourWithReception(buf, job.hourStartMs)
        : { file: summarizeWaveHour(buf, job.stationKey ?? '', job.hourStartMs), reception: null }
    const file = built.file
    await mkdir(dirname(job.summaryPath), { recursive: true })
    let summaryBytes = 0
    // **受信の記録の要約は PSD より先に置く**（作り直すかは PSD の頭で決めるので、ここで落ちても作り直しになる）。
    if (built.reception !== null) {
      const encoded = encodeReceptionSummary(built.reception)
      const path = receptionSummaryPath(job.summaryPath)
      tmp = `${path}.tmp`
      await writeFile(tmp, encoded)
      await rename(tmp, path)
      tmp = null
      summaryBytes += Buffer.byteLength(encoded)
    }
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
