// 要約（`waveSummary.ts`）の置き場所と、要約を 1 本作る処理。
//
// **要約は元のファイル 1 本につき 1 本。** 置き場所は元のファイルの並びを写す。
//
// ```
// <要約の置き場所>/raw/<日>/raw-<日>T<時>.<部分>.wsum      ← <生データ>/<日>/raw-<日>T<時>.mseed3
// <要約の置き場所>/wave/wave-<札>-<日>T<時>.<部分>.wsum    ← <合成波形>/wave-<札>-<日>T<時>.bin
// ```
//
// 部分は `fine`（1 秒ごとの段）・`coarse`（1 分ごとの段）・`psd`（1 分ごとの PSD）と、合成と震度の
// `derived-fine`・`derived-coarse`（`waveSummaryDerived.ts`）の 5 本（分ける理由は `waveSummary.ts` の
// 書き出しの節）。`SummaryJob.summaryPath` は部分を除いた名前の元。
// 生データの時だけ、受信の記録の要約（`<名前の元>.reception.json`・`receptionSummary.ts`）も置く。
//
// **合成波形の要約は前の時のファイルも読む**（震度を前の時の末尾から通すため）。前の時が後から伸びたら
// この時も作り直すので、作ったときの前の時の大きさを最後に書く部分の頭に控える。
//
// **合成波形は観測点の札（`stationFileToken`）で引く。** 札から観測点の識別子へは戻せない
// （均して指紋を足した名前なので）。読み返す側は識別子から札を作って引く。
//
// **書くときは一時ファイルへ書いてから置き換える。** 読み返しが書きかけを掴むと、壊れた要約として
// 捨てるだけで済む（`decodeSummary` が長さを確かめる）が、置き換えれば掴む機会そのものが無くなる。

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { jstHour } from './jstTime'
import { waveFileNameOfToken } from './waveArchive'
import { SUMMARY_PARTS, encodeSummaryPart, type SourceProblems, type SummaryPart } from './waveSummary'
import {
  DERIVED_LAST_PART,
  DERIVED_PARTS,
  DERIVED_PEEK_BYTES,
  encodeDerivedPart,
  peekDerivedHead,
  type DerivedPart,
} from './waveSummaryDerived'
import { encodeReceptionSummary } from './receptionSummary'
import { summarizeMseedHourWithReception, summarizeWaveHourWithDerived } from './waveSummarySources'

const HOUR_MS = 3_600_000

/** 要約のファイルの部分（軸の段・PSD と、合成と震度）。 */
export type SummaryFilePart = SummaryPart | DerivedPart
/** 書く順。**最後の部分（`DERIVED_LAST_PART`）の頭で作り直すかを決める。** */
export const SUMMARY_FILE_PARTS: readonly SummaryFilePart[] = [...SUMMARY_PARTS, ...DERIVED_PARTS]

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
  /** 合成波形なら前の時の元のファイルの場所（震度の助走）。生データは `null`（前の時を読まない）。 */
  readonly prevSourcePath: string | null
}

export type SummaryJobResult =
  | {
      readonly ok: true
      /** 要約を作ったときに読んだ元のファイルの大きさ。 */
      readonly sourceBytes: number
      /** そのときの前の時の元のファイルの大きさ。前の時を読まない・無かったなら `null`。 */
      readonly prevSourceBytes: number | null
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

/** 合成波形の時の、前の時の元のファイルの場所。時を読めなければ `null`。 */
export function prevWaveSourcePath(waveDir: string, stationKey: string, hourStartMs: number): string | null {
  const prevKey = jstHour(hourStartMs - HOUR_MS)
  return prevKey === null ? null : join(waveDir, waveFileNameOfToken(stationKey, prevKey))
}

/** 名前の元に部分を付けた、実際のファイルの場所。 */
export function summaryPartPath(summaryBase: string, part: SummaryFilePart): string {
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
        prevSourcePath: null,
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
      prevSourcePath: prevWaveSourcePath(dirs.waveDir, stationKey, hourStartMs),
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
  `\\.(?:(?:${SUMMARY_FILE_PARTS.join('|')})\\.wsum|reception\\.json)(?:\\.tmp)?$`,
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

/** 要約が控えている、作ったときの元のファイルと前の時のファイルの大きさ。 */
export interface SummarizedSources {
  readonly sourceBytes: number
  /** 前の時を読まない（生データ）・作ったとき前の時が無かったなら `null`。 */
  readonly prevSourceBytes: number | null
}

/**
 * 要約が控えている元のファイルの大きさ（**最後に書く部分**の頭だけ読む）。要約が無い・読めない・形が
 * 違うなら `null`（作り直せばよい）。最後に書く部分で見るのは、途中の部分を書いたところで落ちたとき、
 * 最後の部分が古いまま残って作り直しになるため。**合成と震度の部分を足す前に作った要約は、最後の部分が
 * 無いので `null` になる**（版を上げずに、見回りの係が順に作り直す。2026-10-11 ユーザー承認）。
 */
export async function summarizedSources(summaryBase: string): Promise<SummarizedSources | null> {
  let handle
  try {
    handle = await open(summaryPartPath(summaryBase, DERIVED_LAST_PART), 'r')
  } catch {
    return null
  }
  try {
    const head = Buffer.alloc(DERIVED_PEEK_BYTES)
    const { bytesRead } = await handle.read(head, 0, DERIVED_PEEK_BYTES, 0)
    return peekDerivedHead(head.subarray(0, bytesRead))
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 前の時のファイルを読む。**無いのは異常ではない**（`null`）。それ以外の読み損ねは投げる。 */
async function readPrevSource(path: string | null): Promise<Buffer | null> {
  if (path === null) return null
  try {
    return await readFile(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
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
  const put = async (path: string, encoded: Buffer | string): Promise<number> => {
    tmp = `${path}.tmp`
    await writeFile(tmp, encoded)
    await rename(tmp, path)
    tmp = null
    return Buffer.byteLength(encoded)
  }
  try {
    const buf = await readFile(job.sourcePath)
    const built =
      job.kind === 'raw'
        ? summarizeMseedHourWithReception(buf, job.hourStartMs)
        : {
            ...summarizeWaveHourWithDerived(buf, job.stationKey ?? '', job.hourStartMs, await readPrevSource(job.prevSourcePath)),
            reception: null,
          }
    const { file, derived } = built
    await mkdir(dirname(job.summaryPath), { recursive: true })
    let summaryBytes = 0
    // **受信の記録の要約は最後の部分より先に置く**（作り直すかは最後の部分の頭で決めるので、ここで落ちても作り直しになる）。
    if (built.reception !== null) {
      summaryBytes += await put(receptionSummaryPath(job.summaryPath), encodeReceptionSummary(built.reception))
    }
    for (const part of SUMMARY_PARTS) summaryBytes += await put(summaryPartPath(job.summaryPath, part), encodeSummaryPart(file, part))
    // **最後に書く部分（`DERIVED_LAST_PART`）を最後に置き換える。** 作り直すかはその頭で決める。
    for (const part of DERIVED_PARTS) summaryBytes += await put(summaryPartPath(job.summaryPath, part), encodeDerivedPart(derived, part))
    return {
      ok: true,
      sourceBytes: file.sourceBytes,
      prevSourceBytes: derived.prevSourceBytes,
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
