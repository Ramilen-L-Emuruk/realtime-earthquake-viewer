// 管理コンソールの「波形の記録」へ重ねる気象庁の地震を集める係（`GET /api/records/quakes`。#621 段 f）。
//
// 出どころは 3 つ（2026-10-08 ユーザー承認）。秒まで寄せる手順は `detection/quakeRefine.ts`。
//
// | 出どころ | 取るもの | 1 回で |
// |---|---|---|
// | P2PQuake `/v2/jma/quake` | 地震情報（名前・規模・最大震度・分までの発生時刻） | 範囲の日をまとめて 1 本〜（100 件ごとに 1 本・6.5 秒おき） |
// | 気象庁の震源リスト（日別） | 発生時刻 0.1 秒・震源・深さ | 地震のある日ごとに 1 本（1 秒おき）。2 日前まで |
// | DMDATA `/v2/gd/eew` | 緊急地震速報の最終報の発生時刻（秒） | 震源リストで補えなかった日をまとめて 1 本〜（API キーがあるときだけ） |
//
// **範囲は 7 日まで**（2026-10-08 ユーザー承認）。初めて見る 7 日なら、P2PQuake 3 本前後と気象庁 7 本前後。
//
// **日本時間の日ごとに控える。** 確定した日（P2PQuake・DMDATA は翌日以降に取った分、震源リストは 7 日以上
// 経ってから取った分）はディスクから読み、二度と取りに行かない。確定していない日は 10 分（震源リストは
// 1 日）まで控えを使う —— 画面は寄せる・送るたびに読み直すので、控えが無いと操作のたびに外へ投げる。
// **取れなかった日は 5 分取り直さない**（同じ理由。失敗を連打しない）。
//
// **外へ投げるのは 1 本ずつ**（係の中で順に並べる）。2 つの画面が同時に頼んでも並行には投げない。
//
// **投げない。** 取れなかった理由は結果の `problem` と取れなかった日（地震情報は `failedDays`、秒まで寄せる
// 材料は `refineFailedDays`）に入れる。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { extractDailyHypocenterRows, parseDailyHypocenterLine } from '../../../scripts/hypocenterDailyRecord'
import { authHeader, dmdataApiKeyProblem } from '../../../src/utils/dmdataApiKey'
import type { P2pReferenceQuake } from '../detection/p2pQuake'
import { fetchQuakeHistory, JMA_QUAKE_REQUEST_INTERVAL_MS } from '../detection/quakeHistory'
import { REFINE_TIME_MARGIN_MS, refineQuake, type EewOrigin, type HypocenterRow, type RecordQuake } from '../detection/quakeRefine'

/** 1 回に頼める範囲の広さ。 */
export const RECORD_QUAKES_RANGE_MAX_MS = 7 * 24 * 3_600_000
/** 範囲の頭より前に起きた地震も拾う幅（遠い地震の S 波が範囲の中へ届く）。 */
export const RECORD_QUAKES_LEAD_MS = 30 * 60_000

export const HYPOCENTER_LIST_URL = 'https://www.data.jma.go.jp/eqev/data/daily_map'
export const DMDATA_GD_EEW_URL = 'https://api.dmdata.jp/v2/gd/eew'
/** 震源リストの日別ページがある最初の日（2024-01-01 0:00 JST）。それより前は月報カタログ編の担当。 */
export const HYPOCENTER_LIST_FIRST_MS = Date.UTC(2024, 0, 1) - 9 * 3_600_000

const JST_OFFSET_MS = 9 * 3_600_000
const DAY_MS = 24 * 3_600_000
const MINUTE_MS = 60_000
/** 確定していない日の控えを使う長さ。 */
const RECENT_TTL_MS = 10 * MINUTE_MS
const HYPOCENTER_RECENT_TTL_MS = DAY_MS
/** 取れなかった日を取り直さない長さ。 */
const FAILED_RETRY_MS = 5 * MINUTE_MS
/** 震源リストがまだ載っていない（404）日を取り直さない長さ。 */
const NOT_PUBLISHED_RETRY_MS = 60 * MINUTE_MS
/** 震源リストは「2 日前まで」載る。日の終わりからこの長さが過ぎたら取りに行く。 */
const HYPOCENTER_PUBLISH_LAG_MS = DAY_MS
/** 震源リストの速報値が落ち着くまで（この後に取った分は確定とみなす）。 */
const HYPOCENTER_FINAL_AFTER_MS = 7 * DAY_MS
/** 地震情報・緊急地震速報は、日の終わりからこの後に取った分を確定とみなす。 */
const LIST_FINAL_AFTER_MS = DAY_MS
/** 気象庁・DMDATA へ続けて投げるときの間隔。 */
const JMA_REQUEST_INTERVAL_MS = 1000
const DMDATA_REQUEST_INTERVAL_MS = 1000
/** DMDATA の一覧を辿るページの上限（7 日で数件のはずなので桁を余らせる）。 */
const DMDATA_MAX_PAGES = 5
const FORMAT_VERSION = 1

/** 外へ GET を 1 本投げる。失敗（繋がらない・時間切れ）は投げてよい。 */
export type HttpGet = (url: string, headers: Readonly<Record<string, string>>) => Promise<{ readonly status: number; readonly body: string }>

/** 1 本あたりの時間の上限。応答が返らない 1 本で係の順番待ちが止まらないように。 */
export const RECORD_QUAKES_FETCH_TIMEOUT_MS = 20_000

/** 本番の GET（`fetch` に時間の上限を付けたもの）。 */
export const fetchGet: HttpGet = async (url, headers) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(RECORD_QUAKES_FETCH_TIMEOUT_MS) })
  return { status: res.status, body: await res.text() }
}

/** `SEISMO_DMDATA_API_KEY` を読む。空なら null（緊急地震速報では補わない）。 */
export function readDmdataApiKey(raw: string | undefined): string | null {
  const key = raw?.trim() ?? ''
  return key.length === 0 ? null : key
}

export interface RecordQuakesDeps {
  /** 控えの置き場所。 */
  readonly dir: string
  readonly get: HttpGet
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  /** DMDATA の API キー。無ければ緊急地震速報では補わない。 */
  readonly dmdataApiKey: string | null
}

export interface RecordQuakesResult {
  /** 発生時刻が `[fromMs − 30 分, toMs)` に入る地震（古い順）。 */
  readonly quakes: RecordQuake[]
  /** 地震情報を取れなかった日（日本時間の `YYYY-MM-DD`）。その日の地震は漏れているかもしれない。 */
  readonly failedDays: string[]
  /** 地震情報なのに読めなかった報の数（取った回の数え）。 */
  readonly unreadable: number
  /** 取れなかった理由（最初の 1 つ）。範囲が広すぎるときは `range-too-wide`。 */
  readonly problem: string | null
  /**
   * 発生時刻を秒まで寄せる材料を取れなかった日（出どころ別・日本時間の `YYYY-MM-DD`）。その日の地震は、
   * 材料に載っていないときと同じく分の幅のまま返る —— **載っていないのか取れなかったのかを画面が見分けるため**に
   * 分けて返す（2026-10-08 ユーザー承認）。震源リストがまだ載っていない日（404）は数えない。
   */
  readonly refineFailedDays: { readonly hypocenter: string[]; readonly eew: string[] }
}

type Source = 'p2p' | 'hypo' | 'eew'

interface DayFile<T> {
  readonly v: number
  readonly fetchedAtMs: number
  readonly data: T
}

interface P2pDay {
  readonly quakes: P2pReferenceQuake[]
  readonly unreadable: number
}

interface Memo<T> {
  readonly fetchedAtMs: number
  readonly data: T
}

/** 日本時間の日の頭（unix ミリ秒）。 */
function dayStartOf(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS
}

/** 日本時間の `YYYYMMDD`。 */
function dayKey(dayStartMs: number): string {
  return new Date(dayStartMs + JST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '')
}

function dashed(key: string): string {
  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function finalAfter(source: Source): number {
  return source === 'hypo' ? HYPOCENTER_FINAL_AFTER_MS : LIST_FINAL_AFTER_MS
}

function recentTtl(source: Source): number {
  return source === 'hypo' ? HYPOCENTER_RECENT_TTL_MS : RECENT_TTL_MS
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** `/v2/gd/eew` の 1 件から、取り消されていない地震の発生時刻（と読めれば震央）。 */
function eewOriginOf(item: unknown): EewOrigin | null {
  if (typeof item !== 'object' || item === null) return null
  const it = item as { isCanceled?: unknown; earthquake?: { originTime?: unknown; hypocenter?: { coordinate?: { latitude?: { value?: unknown }; longitude?: { value?: unknown } } } } }
  if (it.isCanceled === true) return null
  const originMs = typeof it.earthquake?.originTime === 'string' ? Date.parse(it.earthquake.originTime) : Number.NaN
  if (!Number.isFinite(originMs)) return null
  const c = it.earthquake?.hypocenter?.coordinate
  const lat = num(c?.latitude?.value)
  const lon = num(c?.longitude?.value)
  return { originMs, lat: lat !== null && lon !== null ? lat : null, lon: lat !== null && lon !== null ? lon : null }
}

export class RecordQuakes {
  private readonly deps: RecordQuakesDeps
  private readonly memo = new Map<string, Memo<unknown>>()
  /**
   * 取れなかった（または震源リストがまだ載っていない）日と、次に取りに行ってよい時刻。`failed` は取れなかった
   * ほう（待っている間も「取れなかった日」として返す）。
   */
  private readonly retryAfter = new Map<string, { readonly untilMs: number; readonly failed: boolean }>()
  private queue: Promise<unknown> = Promise.resolve()
  private lastP2pAtMs = Number.NEGATIVE_INFINITY
  private lastJmaAtMs = Number.NEGATIVE_INFINITY
  private lastDmdataAtMs = Number.NEGATIVE_INFINITY
  private lastP2pProblem: string | null = null

  constructor(deps: RecordQuakesDeps) {
    this.deps = deps
  }

  /** 範囲 `[fromMs, toMs)` に重ねる地震を返す。**外へ投げるのは 1 本ずつ**（呼び出しを順に並べる）。 */
  list(fromMs: number, toMs: number): Promise<RecordQuakesResult> {
    const run = this.queue.then(() => this.listNow(fromMs, toMs))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async listNow(fromMs: number, toMs: number): Promise<RecordQuakesResult> {
    if (!(toMs > fromMs) || toMs - fromMs > RECORD_QUAKES_RANGE_MAX_MS) {
      return { quakes: [], failedDays: [], unreadable: 0, problem: 'range-too-wide', refineFailedDays: { hypocenter: [], eew: [] } }
    }
    const originFrom = fromMs - RECORD_QUAKES_LEAD_MS
    const days: number[] = []
    for (let d = dayStartOf(originFrom); d < toMs; d += DAY_MS) days.push(d)

    const p2p = await this.p2pDays(days)
    const quakes = p2p.quakes.filter((q) => q.originMs >= originFrom && q.originMs < toMs).sort((a, b) => a.originMs - b.originMs)

    // 震源リスト: 地震のある日（候補を探す幅が日を跨げば隣の日も）だけ。
    const hypoDays = new Set<number>()
    for (const q of quakes) {
      hypoDays.add(dayStartOf(q.originMs - REFINE_TIME_MARGIN_MS))
      hypoDays.add(dayStartOf(q.originMs + q.originPrecisionMs + REFINE_TIME_MARGIN_MS))
    }
    const hypo = await this.hypocenterRows([...hypoDays].sort((a, b) => a - b))
    const rows = hypo.rows

    // 緊急地震速報: 震源リストで補えなかった地震の日だけ（API キーがあるときだけ）。
    const firstPass = quakes.map((q) => refineQuake(q, rows, []))
    const eewDays = new Set<number>()
    firstPass.forEach((r, i) => {
      if (r.originSource !== 'quake-info') return
      const q = quakes[i]!
      eewDays.add(dayStartOf(q.originMs - REFINE_TIME_MARGIN_MS))
      eewDays.add(dayStartOf(q.originMs + q.originPrecisionMs + REFINE_TIME_MARGIN_MS))
    })
    const eew = eewDays.size === 0 ? { eews: [], failedDays: [] } : await this.eewOrigins([...eewDays].sort((a, b) => a - b))
    const eews = eew.eews
    const refined = eews.length === 0 ? firstPass : quakes.map((q) => refineQuake(q, rows, eews))

    return {
      quakes: refined,
      failedDays: p2p.failedDays,
      unreadable: p2p.unreadable,
      problem: p2p.problem,
      refineFailedDays: { hypocenter: hypo.failedDays, eew: eew.failedDays },
    }
  }

  // ---- 控え ----

  private pathOf(source: Source, key: string): string {
    return join(this.deps.dir, source, `${key}.json`)
  }

  /** 使える控え（確定しているか、まだ新しいもの）。無ければ null。 */
  private async cached<T>(source: Source, dayStartMs: number): Promise<T | null> {
    const id = `${source}/${dayKey(dayStartMs)}`
    const now = this.deps.now()
    const usable = (fetchedAtMs: number): boolean =>
      fetchedAtMs >= dayStartMs + DAY_MS + finalAfter(source) || now - fetchedAtMs < recentTtl(source)
    const m = this.memo.get(id)
    if (m !== undefined && usable(m.fetchedAtMs)) return m.data as T
    let file: DayFile<T>
    try {
      file = JSON.parse(await readFile(this.pathOf(source, dayKey(dayStartMs)), 'utf8')) as DayFile<T>
    } catch {
      return null
    }
    if (file?.v !== FORMAT_VERSION || typeof file.fetchedAtMs !== 'number' || !usable(file.fetchedAtMs)) return null
    this.memo.set(id, { fetchedAtMs: file.fetchedAtMs, data: file.data })
    return file.data
  }

  private async store<T>(source: Source, dayStartMs: number, fetchedAtMs: number, data: T): Promise<void> {
    const key = dayKey(dayStartMs)
    this.memo.set(`${source}/${key}`, { fetchedAtMs, data })
    this.retryAfter.delete(`${source}/${key}`)
    const path = this.pathOf(source, key)
    try {
      await mkdir(join(this.deps.dir, source), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify({ v: FORMAT_VERSION, fetchedAtMs, data } satisfies DayFile<T>))
      await rename(tmp, path)
    } catch (error) {
      // **書けなくても答えは返す**（控えに残らないだけ。次も取りに行くことになる）。
      console.warn(`[record-quakes] 控えを書けなかった（${source}/${key}）: ${messageOf(error)}`)
    }
  }

  /** 取り直しを待っている日なら、取れなかったのか（`failed`）・まだ載っていないのか（`not-yet`）。待っていなければ null。 */
  private waiting(source: Source, dayStartMs: number): 'failed' | 'not-yet' | null {
    const hold = this.retryAfter.get(`${source}/${dayKey(dayStartMs)}`)
    if (hold === undefined || this.deps.now() >= hold.untilMs) return null
    return hold.failed ? 'failed' : 'not-yet'
  }

  private holdOff(source: Source, dayStartMs: number, ms: number, failed: boolean): void {
    this.retryAfter.set(`${source}/${dayKey(dayStartMs)}`, { untilMs: this.deps.now() + ms, failed })
  }

  private async spaceAfter(last: number, intervalMs: number): Promise<void> {
    const wait = last + intervalMs - this.deps.now()
    if (wait > 0) await this.deps.sleep(wait)
  }

  // ---- 地震情報（P2PQuake） ----

  private async p2pDays(days: readonly number[]): Promise<{ quakes: P2pReferenceQuake[]; failedDays: string[]; unreadable: number; problem: string | null }> {
    const quakes: P2pReferenceQuake[] = []
    const failedDays: string[] = []
    let unreadable = 0
    let problem: string | null = null
    const missing: number[] = []
    for (const d of days) {
      const c = await this.cached<P2pDay>('p2p', d)
      if (c !== null) {
        quakes.push(...c.quakes)
        unreadable += c.unreadable
      } else {
        // 待っている日は取りに行かない。数えるのは取れなかった日だけ（震源リストと同じ判定）。
        const held = this.waiting('p2p', d)
        if (held === 'failed') failedDays.push(dashed(dayKey(d)))
        else if (held === null) missing.push(d)
      }
    }
    // 続いた日をまとめて 1 回で引く（日付でしか絞れないので、日の並びがそのまま問い合わせになる）。
    const runs: number[][] = []
    for (const d of missing) {
      const last = runs[runs.length - 1]
      if (last !== undefined && last[last.length - 1]! + DAY_MS === d) last.push(d)
      else runs.push([d])
    }
    for (const run of runs) {
      await this.spaceAfter(this.lastP2pAtMs, JMA_QUAKE_REQUEST_INTERVAL_MS)
      const result = await fetchQuakeHistory({
        fromMs: run[0]!,
        toMs: run[run.length - 1]! + DAY_MS - 1,
        fetchJson: async (url) => {
          const res = await this.deps.get(url, {})
          if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
          return JSON.parse(res.body) as unknown
        },
        sleep: this.deps.sleep,
        now: this.deps.now,
      })
      this.lastP2pAtMs = this.deps.now()
      if (result.error !== null) problem ??= `P2PQuake: ${result.error}`
      // ページの上限で切ったなら、取れた最後の地震より後の日は取りきれていない。
      const lastOrigin = result.quakes.reduce((m, q) => Math.max(m, q.originMs), Number.NEGATIVE_INFINITY)
      const fetchedAtMs = this.deps.now()
      for (const [i, d] of run.entries()) {
        if (result.error !== null || (result.truncated && d + DAY_MS > lastOrigin)) {
          failedDays.push(dashed(dayKey(d)))
          this.holdOff('p2p', d, FAILED_RETRY_MS, true)
          continue
        }
        const ofDay = result.quakes.filter((q) => q.originMs >= d && q.originMs < d + DAY_MS)
        // 読めなかった報の数は日に割り振れないので、問い合わせの最初の日へ付ける。
        const data: P2pDay = { quakes: ofDay, unreadable: i === 0 ? result.unreadable : 0 }
        await this.store('p2p', d, fetchedAtMs, data)
        quakes.push(...ofDay)
        unreadable += data.unreadable
      }
    }
    failedDays.sort()
    // **取り直しを待っている間も理由を返す**（待っている日だけが並ぶと、なぜ取れていないのかが消える）。
    if (problem !== null) this.lastP2pProblem = problem
    else if (failedDays.length > 0) problem = this.lastP2pProblem
    return { quakes, failedDays, unreadable, problem }
  }

  // ---- 震源リスト（気象庁） ----

  /** 震源リストの行と、取れなかった日（まだ載っていない日・載る前の日・日別ページの無い日は数えない）。 */
  private async hypocenterRows(days: readonly number[]): Promise<{ rows: HypocenterRow[]; failedDays: string[] }> {
    const out: HypocenterRow[] = []
    const failedDays: string[] = []
    for (const d of days) {
      if (d < HYPOCENTER_LIST_FIRST_MS || this.deps.now() < d + DAY_MS + HYPOCENTER_PUBLISH_LAG_MS) continue
      const c = await this.cached<HypocenterRow[]>('hypo', d)
      if (c !== null) {
        out.push(...c)
        continue
      }
      const held = this.waiting('hypo', d)
      if (held !== null) {
        if (held === 'failed') failedDays.push(dashed(dayKey(d)))
        continue
      }
      await this.spaceAfter(this.lastJmaAtMs, JMA_REQUEST_INTERVAL_MS)
      const url = `${HYPOCENTER_LIST_URL}/${dayKey(d)}.html`
      try {
        const res = await this.deps.get(url, {})
        this.lastJmaAtMs = this.deps.now()
        if (res.status === 404) {
          this.holdOff('hypo', d, NOT_PUBLISHED_RETRY_MS, false)
          continue
        }
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
        const rows: HypocenterRow[] = []
        for (const line of extractDailyHypocenterRows(res.body)) {
          const r = parseDailyHypocenterLine(line)
          if (r !== null) rows.push({ timeMs: r.timeMs, lat: r.lat, lon: r.lng, depthKm: r.depth, magnitude: r.magnitude })
        }
        await this.store('hypo', d, this.deps.now(), rows)
        out.push(...rows)
      } catch (error) {
        this.lastJmaAtMs = this.deps.now()
        this.holdOff('hypo', d, FAILED_RETRY_MS, true)
        failedDays.push(dashed(dayKey(d)))
        console.warn(`[record-quakes] 震源リストを取れなかった（${dayKey(d)}）: ${messageOf(error)}`)
      }
    }
    return { rows: out, failedDays }
  }

  // ---- 緊急地震速報（DMDATA） ----

  /** 緊急地震速報の発生時刻と、取れなかった日。**API キーが無ければ取りに行かないので、取れなかった日も無い。** */
  private async eewOrigins(days: readonly number[]): Promise<{ eews: EewOrigin[]; failedDays: string[] }> {
    const key = this.deps.dmdataApiKey
    if (key === null || dmdataApiKeyProblem(key) !== null) return { eews: [], failedDays: [] }
    const out: EewOrigin[] = []
    const failedDays: string[] = []
    const missing: number[] = []
    for (const d of days) {
      const c = await this.cached<EewOrigin[]>('eew', d)
      if (c !== null) {
        out.push(...c)
        continue
      }
      const held = this.waiting('eew', d)
      if (held === 'failed') failedDays.push(dashed(dayKey(d)))
      else if (held === null) missing.push(d)
    }
    if (missing.length === 0) return { eews: out, failedDays }
    const fromDay = missing[0]!
    const toDay = missing[missing.length - 1]! + DAY_MS
    // 一覧の `datetime` は UTC の日付の半開区間。終わりの日を含めるよう翌日まで指定する（PWA と同じ）。
    const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
    const params = new URLSearchParams({ datetime: `${utcDate(fromDay)}~${utcDate(toDay + DAY_MS)}`, limit: '100' })
    const got: EewOrigin[] = []
    let complete = false
    try {
      for (let page = 0; page < DMDATA_MAX_PAGES; page++) {
        await this.spaceAfter(this.lastDmdataAtMs, DMDATA_REQUEST_INTERVAL_MS)
        const res = await this.deps.get(`${DMDATA_GD_EEW_URL}?${params.toString()}`, { Authorization: authHeader(key) })
        this.lastDmdataAtMs = this.deps.now()
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
        const json = JSON.parse(res.body) as { items?: unknown; nextToken?: unknown }
        for (const item of Array.isArray(json.items) ? json.items : []) {
          const e = eewOriginOf(item)
          if (e !== null) got.push(e)
        }
        if (typeof json.nextToken !== 'string' || json.nextToken.length === 0) {
          complete = true
          break
        }
        params.set('cursorToken', json.nextToken)
      }
    } catch (error) {
      this.lastDmdataAtMs = this.deps.now()
      console.warn(`[record-quakes] 緊急地震速報の一覧を取れなかった: ${messageOf(error)}`)
    }
    if (!complete) {
      // 取りきれなかった日は控えに残さない（「その日は緊急地震速報が無かった」にしない）。ページの上限で
      // 切った場合も同じ —— 取れた分は使うが、その日は「取れなかった日」として返す。
      for (const d of missing) {
        this.holdOff('eew', d, FAILED_RETRY_MS, true)
        failedDays.push(dashed(dayKey(d)))
      }
      return { eews: [...out, ...got], failedDays: failedDays.sort() }
    }
    const fetchedAtMs = this.deps.now()
    for (const d of missing) {
      await this.store('eew', d, fetchedAtMs, got.filter((e) => e.originMs >= d && e.originMs < d + DAY_MS))
    }
    return { eews: [...out, ...got], failedDays: failedDays.sort() }
  }
}
