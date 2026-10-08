// 「波形の記録」タブの当て方（DOM・Canvas に触らない部分）。読み返しの口は `/api/records/*`
// （`receiver/waveRecordsApi.ts`）。**画面に出す文言はどれも 2026-10-07 ユーザー承認。**
//
// - **記録の選び方**: 一覧はチャンネル（1 軸ずつ）で届くので、観測点の合成波形は札ごと、生データは
//   センサーごとに 3 軸を 1 つの「記録」へ束ねる（{@link groupChannels}）
// - **範囲**: 幅のボタン・送り・ホイール・ドラッグのどれも {@link clampRange} を通す。記録がある期間の外へは出ない
// - **取り方**: 10 分以内は生のサンプル、それより広ければ列（要約）。境目はホストの `samples` の上限と同じ
// - **描き方**: 軸ごとに 1 本の「なぞり」（{@link AxisTrace}）へ揃え、列でもサンプルでも同じ関数で
//   最大・欠け・画素への割り付けを出す
//
// **値が無いことと、取っていないことを混ぜない。** 取った範囲の外は「欠け」として描かない
// （描く側が取った範囲を持って判定する）。取った範囲の中で値の無い所だけが欠け。

import { readFinite, readFiniteArray, readFiniteArrayWithGaps, readNonEmptyString } from './readJson'
import { formatGal, niceHalfSpanGal } from './wavePlot'

const SECOND_MS = 1000
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** 生のサンプルで描く範囲の上限。**ホストの `samples`・`intensity` の上限（`SAMPLES_RANGE_MAX_MS`）と同じ 10 分。** */
export const SAMPLES_RANGE_MAX_MS = 10 * MINUTE_MS
/** 列の数の上限（ホストの `RECORDS_COLUMNS_MAX` と同じ）。 */
export const COLUMNS_MAX = 4096
/** 寄せられる幅の下限。100 Hz なら 10 サンプル —— 1 サンプルずつの点が見分けられる。 */
export const MIN_SPAN_MS = 100
/**
 * 一度に読む範囲の上限（ホストの `RECORDS_RANGE_MAX_MS` と同じ 400 日）。**全体の帯にも、段の範囲にも掛ける** ——
 * 記録が 400 日より長い機で段だけを期間の幅まで広げると、ホストが `range-too-wide` で弾いて何も描けない。
 */
export const RANGE_MAX_MS = 400 * DAY_MS

// ---- 一覧 -----------------------------------------------------------------------------------

/** `GET /api/records/channels` の 1 行（`receiver/waveRecordChannels.ts` の `RecordChannel`）。 */
export interface RecordChannelView {
  readonly id: string
  readonly kind: 'raw' | 'station'
  readonly firstHourMs: number
  readonly lastHourMs: number
  readonly hours: number
  readonly sensor: string | null
  readonly board: { readonly boardKey: string; readonly sensorId: string; readonly stationId: string; readonly stationName: string | null } | null
  readonly station: { readonly stationId: string; readonly displayName: string } | null
}

export interface ChannelListView {
  readonly channels: readonly RecordChannelView[]
  readonly unreadable: number
}

function readBoard(v: unknown): RecordChannelView['board'] | undefined {
  if (v === null) return null
  if (typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const boardKey = readNonEmptyString(o.boardKey)
  const sensorId = readNonEmptyString(o.sensorId)
  const stationId = readNonEmptyString(o.stationId)
  if (boardKey === null || sensorId === null || stationId === null) return undefined
  const stationName = o.stationName === null ? null : readNonEmptyString(o.stationName)
  if (stationName === null && o.stationName !== null) return undefined
  return { boardKey, sensorId, stationId, stationName }
}

function readStation(v: unknown): RecordChannelView['station'] | undefined {
  if (v === null) return null
  if (typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const stationId = readNonEmptyString(o.stationId)
  const displayName = typeof o.displayName === 'string' ? o.displayName : null
  return stationId === null || displayName === null ? undefined : { stationId, displayName }
}

/** 一覧の応答を読む。**1 行でも形が違えば応答ごと読めない（null）** —— 黙って行を落とすと、その記録が選べないことに気づけない。 */
export function readChannelList(value: unknown): ChannelListView | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const unreadable = readFinite(v.unreadable)
  if (unreadable === null || !Array.isArray(v.channels)) return null
  const channels: RecordChannelView[] = []
  for (const c of v.channels) {
    if (typeof c !== 'object' || c === null) return null
    const o = c as Record<string, unknown>
    const id = readNonEmptyString(o.id)
    const kind = o.kind === 'raw' || o.kind === 'station' ? o.kind : null
    const firstHourMs = readFinite(o.firstHourMs)
    const lastHourMs = readFinite(o.lastHourMs)
    const hours = readFinite(o.hours)
    const sensor = o.sensor === null ? null : readNonEmptyString(o.sensor)
    const board = readBoard(o.board)
    const station = readStation(o.station)
    if (id === null || kind === null || firstHourMs === null || lastHourMs === null || hours === null) return null
    if ((sensor === null && o.sensor !== null) || board === undefined || station === undefined) return null
    channels.push({ id, kind, firstHourMs, lastHourMs, hours, sensor, board, station })
  }
  return { channels, unreadable }
}

/** 記録 1 つの軸。 */
export interface RecordAxis {
  readonly id: string
  /** 段の名前（`X 軸（東が ＋）`・`1 軸（センサーの向きのまま）`）。 */
  readonly label: string
  /** 指した所の値の行で使う短い名前（`X`・`1`）。 */
  readonly short: string
}

/** 選ぶ欄の 1 行（観測点の合成波形の 3 軸、またはセンサー 1 つの 3 軸）。 */
export interface RecordGroup {
  readonly key: string
  readonly kind: 'raw' | 'station'
  readonly label: string
  readonly axes: readonly RecordAxis[]
  /** 合成波形の札（震度の推移を引くのに使う）。生データは null。 */
  readonly stationKey: string | null
  /**
   * いまの設定での観測点 ID（気象庁の地震の P・S と揺れの記録を引くのに使う）。合成波形は自分の観測点、
   * 生データは割り当て先。**設定から外した観測点・割り当ての無いセンサーは null。**
   */
  readonly stationId: string | null
  /** 受信の帯を重ねるセンサー。合成波形はいまこの観測点に割り当てている基板のもの、生データは自分。 */
  readonly sensors: readonly string[]
  readonly firstHourMs: number
  readonly lastHourMs: number
  /** 軸のうち要約がある時のいちばん多い数。 */
  readonly hours: number
}

/** 合成波形の段の名前。**波形タブ（`viewWaves.ts`）と同じ**（共通座標 ENU）。 */
const STATION_AXIS_LABELS: Readonly<Record<string, string>> = {
  X: 'X 軸（東が ＋）',
  Y: 'Y 軸（北が ＋）',
  Z: 'Z 軸（上が ＋）',
}

const STATION_ID_RE = /^station\/([A-Za-z0-9_-]+)\/([XYZ])$/

/** 生データの識別子（`…_H_N_1`）の末尾の 1 文字（軸）。 */
function rawAxisShort(id: string): string {
  return id.slice(-1)
}

function groupLabel(first: RecordChannelView, stationKey: string | null): string {
  if (first.kind === 'station') return first.station !== null ? first.station.displayName : `外した観測点（札 ${stationKey ?? ''}）`
  const b = first.board
  if (b === null) return `割り当ての無いセンサー（${first.sensor ?? first.id}）`
  return `${b.stationName ?? b.stationId} ／ 基板 ${b.boardKey} のセンサー ${b.sensorId}`
}

/**
 * チャンネルを記録へ束ねる。**合成波形を先に、生データを後に**（選ぶ欄のまとまりの順）。それぞれの中は名前の順。
 * 軸は X・Y・Z（生データは識別子の順）。
 */
export function groupChannels(channels: readonly RecordChannelView[]): RecordGroup[] {
  const buckets = new Map<string, { stationKey: string | null; items: RecordChannelView[] }>()
  for (const c of channels) {
    let key: string
    let stationKey: string | null = null
    if (c.kind === 'station') {
      const m = STATION_ID_RE.exec(c.id)
      if (m === null) continue
      stationKey = m[1]!
      key = `station/${stationKey}`
    } else {
      key = c.sensor ?? c.id
    }
    let b = buckets.get(key)
    if (b === undefined) {
      b = { stationKey, items: [] }
      buckets.set(key, b)
    }
    b.items.push(c)
  }
  // 観測点ごとの、いま割り当てているセンサー（生データの一覧の割り当てから引く）。
  const sensorsOfStation = new Map<string, Set<string>>()
  for (const c of channels) {
    if (c.kind !== 'raw' || c.board === null || c.sensor === null) continue
    let set = sensorsOfStation.get(c.board.stationId)
    if (set === undefined) {
      set = new Set()
      sensorsOfStation.set(c.board.stationId, set)
    }
    set.add(c.sensor)
  }
  const groups: RecordGroup[] = []
  for (const [key, b] of buckets) {
    const items = [...b.items].sort((a, c) => (a.id < c.id ? -1 : a.id > c.id ? 1 : 0))
    const first = items[0]!
    const stationId = first.kind === 'station' ? (first.station?.stationId ?? null) : (first.board?.stationId ?? null)
    const sensors =
      first.kind === 'station'
        ? stationId === null
          ? []
          : [...(sensorsOfStation.get(stationId) ?? [])].sort()
        : first.sensor === null
          ? []
          : [first.sensor]
    const axes = items.map((c): RecordAxis => {
      if (c.kind === 'station') {
        const short = c.id.slice(-1)
        return { id: c.id, label: STATION_AXIS_LABELS[short] ?? `${short} 軸`, short }
      }
      const short = rawAxisShort(c.id)
      return { id: c.id, label: `${short} 軸（センサーの向きのまま）`, short }
    })
    groups.push({
      key,
      kind: first.kind,
      label: groupLabel(first, b.stationKey),
      axes,
      stationKey: b.stationKey,
      stationId,
      sensors,
      firstHourMs: Math.min(...items.map((c) => c.firstHourMs)),
      lastHourMs: Math.max(...items.map((c) => c.lastHourMs)),
      hours: Math.max(...items.map((c) => c.hours)),
    })
  }
  return groups.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'station' ? -1 : 1
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
  })
}

// ---- 時刻の書き方 ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `10/07 12:00`（ブラウザの時計の地域で）。 */
export function formatDateMinute(atMs: number): string {
  const d = new Date(atMs)
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** `12:03:04`・`12:03:04.2`・`12:03:04.25`（`digits` は秒の小数の桁）。 */
export function formatClockDigits(atMs: number, digits: 0 | 1 | 2): string {
  const d = new Date(atMs)
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  if (digits === 0) return base
  const frac = String(Math.floor(d.getMilliseconds() / (digits === 1 ? 100 : 10))).padStart(digits, '0')
  return `${base}.${frac}`
}

/** 長さの言い方（`3 秒`・`2 分`・`1 時間`・`1 日`）。 */
export function durationLabel(ms: number): string {
  if (ms < MINUTE_MS) return `${Math.round(ms / SECOND_MS)} 秒`
  if (ms < HOUR_MS) return `${Math.round(ms / MINUTE_MS)} 分`
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)} 時間`
  return `${Math.round(ms / DAY_MS)} 日`
}

/** 記録がある期間の行。**終わりは最後の時の終わり**（要約は時の頭で名乗る）。 */
export function periodText(g: RecordGroup): string {
  return `記録がある期間: ${formatDateMinute(g.firstHourMs)}〜${formatDateMinute(g.lastHourMs + HOUR_MS)}（${g.hours} 時間ぶん）`
}

// ---- 範囲 -----------------------------------------------------------------------------------

export interface TimeRange {
  readonly fromMs: number
  readonly toMs: number
}

/** 幅のボタン。`null` は「全体」。 */
export const SPAN_CHOICES: readonly { readonly label: string; readonly ms: number | null }[] = [
  { label: '全体', ms: null },
  { label: '1 週', ms: 7 * DAY_MS },
  { label: '1 日', ms: DAY_MS },
  { label: '6 時間', ms: 6 * HOUR_MS },
  { label: '1 時間', ms: HOUR_MS },
  { label: '10 分', ms: 10 * MINUTE_MS },
  { label: '1 分', ms: MINUTE_MS },
  { label: '10 秒', ms: 10 * SECOND_MS },
]

/** 記録がある期間（最初の時の頭〜最後の時の終わり）。 */
export function boundsOf(g: RecordGroup): TimeRange {
  return { fromMs: g.firstHourMs, toMs: g.lastHourMs + HOUR_MS }
}

/**
 * 「全体」の幅。期間の幅だが、{@link RANGE_MAX_MS} を超えればそこまで。**範囲の切り詰め（`clampRange`・`withSpan`）と
 * 「全体」が押された見た目の判定（`viewRecords.ts`）はどれもこれを使う** —— 別々に求めると、400 日を超える記録で「全体」を
 * 押しても押された見た目にならない。全体の帯（{@link overviewRange}）も同じ新しい側の範囲を指す。
 */
export function fullSpanMs(bounds: TimeRange): number {
  return Math.min(bounds.toMs - bounds.fromMs, RANGE_MAX_MS)
}

/**
 * 範囲を期間の中へ収める。**幅は {@link MIN_SPAN_MS} から {@link fullSpanMs} まで**、
 * はみ出した分は位置をずらして戻す（幅は変えない）。端は整数のミリ秒へ —— ホストは整数でない時刻を `bad-range` で弾く。
 */
export function clampRange(r: TimeRange, bounds: TimeRange): TimeRange {
  const span = Math.min(Math.max(r.toMs - r.fromMs, MIN_SPAN_MS), fullSpanMs(bounds))
  let fromMs = Number.isFinite(r.fromMs) ? r.fromMs : bounds.fromMs
  if (fromMs < bounds.fromMs) fromMs = bounds.fromMs
  if (fromMs + span > bounds.toMs) fromMs = bounds.toMs - span
  fromMs = Math.round(fromMs)
  return { fromMs, toMs: fromMs + Math.round(span) }
}

/** 中心を保って幅を変える。`spanMs` が null なら期間の全体（長ければ全体の帯と同じ新しい側の {@link RANGE_MAX_MS}）。 */
export function withSpan(r: TimeRange, spanMs: number | null, bounds: TimeRange): TimeRange {
  if (spanMs === null) return clampRange({ fromMs: bounds.toMs - fullSpanMs(bounds), toMs: bounds.toMs }, bounds)
  const center = (r.fromMs + r.toMs) / 2
  return clampRange({ fromMs: center - spanMs / 2, toMs: center + spanMs / 2 }, bounds)
}

/** `anchorMs` を動かさずに `factor` 倍へ（1 より小さければ寄る）。 */
export function zoomAt(r: TimeRange, factor: number, anchorMs: number, bounds: TimeRange): TimeRange {
  const span = (r.toMs - r.fromMs) * factor
  const ratio = (anchorMs - r.fromMs) / (r.toMs - r.fromMs)
  const fromMs = anchorMs - span * ratio
  return clampRange({ fromMs, toMs: fromMs + span }, bounds)
}

/** 幅を保って送る。 */
export function shiftBy(r: TimeRange, deltaMs: number, bounds: TimeRange): TimeRange {
  return clampRange({ fromMs: r.fromMs + deltaMs, toMs: r.toMs + deltaMs }, bounds)
}

/** 幅を保って `atMs` を中心へ。 */
export function centerAt(r: TimeRange, atMs: number, bounds: TimeRange): TimeRange {
  const half = (r.toMs - r.fromMs) / 2
  return clampRange({ fromMs: atMs - half, toMs: atMs + half }, bounds)
}

/** 全体の帯で読む範囲。**期間が長ければ新しい側の {@link RANGE_MAX_MS} に留める。** */
export function overviewRange(g: RecordGroup): TimeRange {
  const b = boundsOf(g)
  return { fromMs: Math.max(b.fromMs, b.toMs - RANGE_MAX_MS), toMs: b.toMs }
}

// ---- 取り方 ---------------------------------------------------------------------------------

export type FetchPlan = { readonly kind: 'samples' } | { readonly kind: 'envelope'; readonly columns: number }

/** **10 分以内は生のサンプル**、それより広ければ画面の幅ぶんの列。 */
export function planFetch(r: TimeRange, widthPx: number): FetchPlan {
  if (r.toMs - r.fromMs <= SAMPLES_RANGE_MAX_MS) return { kind: 'samples' }
  return { kind: 'envelope', columns: Math.min(COLUMNS_MAX, Math.max(1, Math.round(widthPx))) }
}

/** `/api/records/<route>` の URL。時刻と列の数は整数へ。 */
export function recordsUrl(route: string, params: Readonly<Record<string, string | number>>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) q.set(k, typeof v === 'number' ? String(Math.round(v)) : v)
  return `/api/records/${route}?${q.toString()}`
}

// ---- 応答を読む ------------------------------------------------------------------------------

export type ValueUnit = 'gal' | 'count'

export interface ReadProblemsView {
  readonly skippedBytes: number
  readonly badRecords: number
  readonly unscaledHours: number
}

export interface HourTallyView {
  readonly ok: number
  readonly stale: number
  readonly pending: number
  readonly failed: number
  readonly absent: number
}

export interface IrregularHourView {
  readonly hourStartMs: number
  readonly state: 'stale' | 'pending' | 'failed'
}

export interface EnvelopeData {
  readonly source: 'coarse' | 'fine' | 'samples'
  readonly unit: ValueUnit
  readonly columnMs: number
  readonly firstColumnMs: number
  readonly n: readonly number[]
  /** 本数が 0 の列は NaN。 */
  readonly min: readonly number[]
  readonly max: readonly number[]
  readonly mean: readonly number[]
  /** 1 秒より速い揺れの強さ（ノイズ水準の推移に使う）。本数が 0 の列は NaN。 */
  readonly noiseStd: readonly number[]
  /** 要約から作ったときだけ（生のサンプルから束ねたときは null）。 */
  readonly hours: HourTallyView | null
  readonly irregularHours: readonly IrregularHourView[]
  readonly problems: ReadProblemsView
}

/** 正常でない時の一覧を読む。`null` は「一覧が無い」（生のサンプルから作った応答）で、空の一覧として返す。 */
export function readIrregularHours(v: unknown): IrregularHourView[] | null {
  if (v === null) return []
  if (!Array.isArray(v)) return null
  const out: IrregularHourView[] = []
  for (const h of v) {
    if (typeof h !== 'object' || h === null) return null
    const o = h as Record<string, unknown>
    const hourStartMs = readFinite(o.hourStartMs)
    const state = o.state === 'stale' || o.state === 'pending' || o.state === 'failed' ? o.state : null
    if (hourStartMs === null || state === null) return null
    out.push({ hourStartMs, state })
  }
  return out
}

export function readProblems(v: unknown): ReadProblemsView | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const skippedBytes = readFinite(o.skippedBytes)
  const badRecords = readFinite(o.badRecords)
  const unscaledHours = readFinite(o.unscaledHours)
  return skippedBytes === null || badRecords === null || unscaledHours === null ? null : { skippedBytes, badRecords, unscaledHours }
}

/** 時の数え（`ok`・`stale`・`pending`・`failed`・`absent`）を読む。 */
export function readTally(v: unknown): HourTallyView | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const ok = readFinite(o.ok)
  const stale = readFinite(o.stale)
  const pending = readFinite(o.pending)
  const failed = readFinite(o.failed)
  const absent = readFinite(o.absent)
  if (ok === null || stale === null || pending === null || failed === null || absent === null) return null
  return { ok, stale, pending, failed, absent }
}

export function readUnit(v: unknown): ValueUnit | null {
  return v === 'gal' || v === 'count' ? v : null
}

/** `envelope` の応答を読む。**1 か所でも形が違えば null**（読めない列を欠けとして描かない）。 */
export function readEnvelopeData(value: unknown): EnvelopeData | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const source = v.source === 'coarse' || v.source === 'fine' || v.source === 'samples' ? v.source : null
  const unit = readUnit(v.unit)
  const columnMs = readFinite(v.columnMs)
  const firstColumnMs = readFinite(v.firstColumnMs)
  const n = readFiniteArray(v.n)
  const min = readFiniteArrayWithGaps(v.min)
  const max = readFiniteArrayWithGaps(v.max)
  const mean = readFiniteArrayWithGaps(v.mean)
  const noiseStd = readFiniteArrayWithGaps(v.noiseStd)
  const problems = readProblems(v.problems)
  if (source === null || unit === null || columnMs === null || columnMs <= 0 || firstColumnMs === null) return null
  if (n === null || min === null || max === null || mean === null || noiseStd === null || problems === null) return null
  if (min.length !== n.length || max.length !== n.length || mean.length !== n.length || noiseStd.length !== n.length) return null
  let hours: HourTallyView | null = null
  if (v.hours !== null) {
    hours = readTally(v.hours)
    if (hours === null) return null
  }
  const irregularHours = readIrregularHours(v.irregularHours)
  if (irregularHours === null) return null
  return { source, unit, columnMs, firstColumnMs, n, min, max, mean, noiseStd, hours, irregularHours, problems }
}

/** そのサンプルがどう届いたか（ホストの `SampleOrigin`）。知らない値は `unknown` として読む。 */
export type SampleOriginView = 'live' | 'backlog' | 'late' | 'revised' | 'unknown'

const SAMPLE_ORIGINS: readonly SampleOriginView[] = ['live', 'backlog', 'late', 'revised', 'unknown']

export interface SampleRunView {
  readonly firstSampleMs: number
  readonly msPerSample: number
  /** 値の無いサンプルは NaN。 */
  readonly values: readonly number[]
  readonly origin: SampleOriginView
  /** 生データのレコードが「時刻が疑わしい」の印を持っていたか。 */
  readonly timeQuestionable: boolean
}

export interface SamplesData {
  readonly unit: ValueUnit
  readonly runs: readonly SampleRunView[]
  readonly problems: ReadProblemsView
}

/** `samples` の応答を読む。 */
export function readSamplesData(value: unknown): SamplesData | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const unit = readUnit(v.unit)
  const problems = readProblems(v.problems)
  if (unit === null || problems === null || !Array.isArray(v.runs)) return null
  const runs: SampleRunView[] = []
  for (const r of v.runs) {
    if (typeof r !== 'object' || r === null) return null
    const o = r as Record<string, unknown>
    const firstSampleMs = readFinite(o.firstSampleMs)
    const msPerSample = readFinite(o.msPerSample)
    const values = readFiniteArrayWithGaps(o.values)
    if (firstSampleMs === null || msPerSample === null || msPerSample <= 0 || values === null) return null
    // 届き方は印を描くだけなので、知らない値で応答ごと捨てない（`unknown` として線を引かない）。
    const origin = SAMPLE_ORIGINS.find((x) => x === o.origin) ?? 'unknown'
    runs.push({ firstSampleMs, msPerSample, values, origin, timeQuestionable: o.timeQuestionable === true })
  }
  runs.sort((a, b) => a.firstSampleMs - b.firstSampleMs)
  return { unit, runs, problems }
}

export interface IntensityData {
  readonly series: readonly { readonly atMs: number; readonly value: number | null }[]
  readonly maxRealtime: number | null
  readonly maxRealtimeAtMs: number | null
  readonly measured: number | null
}

function finiteOrNull(v: unknown): number | null | undefined {
  if (v === null) return null
  const n = readFinite(v)
  return n === null ? undefined : n
}

/** `intensity` の応答を読む。 */
export function readIntensityData(value: unknown): IntensityData | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const maxRealtime = finiteOrNull(v.maxRealtime)
  const maxRealtimeAtMs = finiteOrNull(v.maxRealtimeAtMs)
  const measured = finiteOrNull(v.measured)
  if (maxRealtime === undefined || maxRealtimeAtMs === undefined || measured === undefined || !Array.isArray(v.realtimeSeries)) return null
  const series: { atMs: number; value: number | null }[] = []
  for (const p of v.realtimeSeries) {
    if (typeof p !== 'object' || p === null) return null
    const o = p as Record<string, unknown>
    const atMs = readFinite(o.atMs)
    const pv = finiteOrNull(o.value)
    if (atMs === null || pv === undefined) return null
    series.push({ atMs, value: pv })
  }
  return { series, maxRealtime, maxRealtimeAtMs, measured }
}

// ---- 軸ごとのなぞり --------------------------------------------------------------------------

/** 軸 1 本ぶんの描く材料。**列（要約）でもサンプルでも、以下の関数は同じように扱う。** */
export type AxisTrace =
  | {
      readonly kind: 'columns'
      readonly columnMs: number
      readonly firstColumnMs: number
      readonly n: readonly number[]
      readonly min: readonly number[]
      readonly max: readonly number[]
      readonly mean: readonly number[]
    }
  | { readonly kind: 'samples'; readonly runs: readonly SampleRunView[] }

export function traceOfEnvelope(e: EnvelopeData): AxisTrace {
  return { kind: 'columns', columnMs: e.columnMs, firstColumnMs: e.firstColumnMs, n: e.n, min: e.min, max: e.max, mean: e.mean }
}

export function traceOfSamples(s: SamplesData): AxisTrace {
  return { kind: 'samples', runs: s.runs }
}

/** 範囲の中の値を時刻の順に辿る（列は 1 列を「頭の時刻・最小・最大・平均・本数」で渡す）。 */
function forEachInRange(
  t: AxisTrace,
  r: TimeRange,
  visit: (atMs: number, lo: number, hi: number, mean: number, weight: number) => void,
): void {
  if (t.kind === 'columns') {
    for (let j = 0; j < t.n.length; j++) {
      const at = t.firstColumnMs + j * t.columnMs
      if (at + t.columnMs <= r.fromMs || at >= r.toMs) continue
      const n = t.n[j]!
      if (n <= 0 || !Number.isFinite(t.min[j]!) || !Number.isFinite(t.max[j]!)) continue
      visit(at, t.min[j]!, t.max[j]!, t.mean[j]!, n)
    }
    return
  }
  for (const run of t.runs) {
    const first = Math.max(0, Math.ceil((r.fromMs - run.firstSampleMs) / run.msPerSample))
    for (let i = first; i < run.values.length; i++) {
      const at = run.firstSampleMs + i * run.msPerSample
      if (at >= r.toMs) break
      const v = run.values[i]!
      if (!Number.isFinite(v)) continue
      visit(at, v, v, v, 1)
    }
  }
}

/** 範囲の中の平均（本数で重みを付ける）。値が無ければ NaN。**段の縦の中心に使う。** */
export function traceCenter(t: AxisTrace, r: TimeRange): number {
  let sum = 0
  let w = 0
  forEachInRange(t, r, (_at, _lo, _hi, mean, weight) => {
    if (!Number.isFinite(mean)) return
    sum += mean * weight
    w += weight
  })
  return w > 0 ? sum / w : Number.NaN
}

export interface TracePeak {
  /** 中心からの隔たり（≥ 0）。 */
  readonly deviation: number
  /** その点の値。 */
  readonly value: number
  readonly atMs: number
  /** 列から出した（時刻は列の頭で、列の幅のどこか）。 */
  readonly approximate: boolean
}

/**
 * 範囲の中で中心からいちばん隔たった点。**中心からの隔たりで測る** —— 生データの上下の軸は重力が乗って
 * 980 gal 付近にいるので、値そのものの最大では揺れの大きさにならない（合成波形は中心がほぼ 0 なので、値の最大と同じ）。
 */
export function tracePeak(t: AxisTrace, r: TimeRange, center: number): TracePeak | null {
  if (!Number.isFinite(center)) return null
  let best: TracePeak | null = null
  forEachInRange(t, r, (at, lo, hi) => {
    for (const v of lo === hi ? [lo] : [lo, hi]) {
      const d = Math.abs(v - center)
      if (best === null || d > best.deviation) best = { deviation: d, value: v, atMs: at, approximate: t.kind === 'columns' }
    }
  })
  return best
}

/** 画素ごとの描き方。点が画素より少なければ線、多ければ画素ごとの上下の端。 */
export type PixelPlan =
  | { readonly mode: 'band'; readonly lo: Float64Array; readonly hi: Float64Array }
  | { readonly mode: 'line'; readonly segments: readonly { readonly xs: readonly number[]; readonly vs: readonly number[] }[] }

/** 時刻を画素の位置（左端 0・右端 `width`）へ。 */
export function xOf(atMs: number, r: TimeRange, width: number): number {
  return ((atMs - r.fromMs) / (r.toMs - r.fromMs)) * width
}

/**
 * なぞりを画素へ割り付ける。**列は覆う画素すべてへ**（1 列が数画素にまたがるとき、間を空けない）、
 * **サンプルは画素ごとに上下の端を取る**（間引きでピークを落とさない）。値の無い画素は NaN（描く側が線を切る）。
 */
export function pixelPlan(t: AxisTrace, r: TimeRange, width: number): PixelPlan {
  const w = Math.max(1, Math.floor(width))
  if (t.kind === 'samples') {
    let count = 0
    forEachInRange(t, r, () => {
      count += 1
    })
    if (count <= w) {
      // 点を線で結ぶ。**途切れたら線を切る**（刻みの 1.5 倍より空いたら別の線）。
      const segments: { xs: number[]; vs: number[] }[] = []
      for (const run of t.runs) {
        let cur: { xs: number[]; vs: number[] } | null = null
        for (let i = 0; i < run.values.length; i++) {
          const at = run.firstSampleMs + i * run.msPerSample
          if (at < r.fromMs - run.msPerSample || at > r.toMs + run.msPerSample) continue
          const v = run.values[i]!
          if (!Number.isFinite(v)) {
            cur = null
            continue
          }
          if (cur === null) {
            cur = { xs: [], vs: [] }
            segments.push(cur)
          }
          cur.xs.push(xOf(at, r, w))
          cur.vs.push(v)
        }
      }
      return { mode: 'line', segments: segments.filter((s) => s.xs.length > 0) }
    }
  }
  const lo = new Float64Array(w).fill(Number.NaN)
  const hi = new Float64Array(w).fill(Number.NaN)
  const put = (x: number, a: number, b: number): void => {
    if (x < 0 || x >= w) return
    if (Number.isNaN(lo[x]!) || a < lo[x]!) lo[x] = a
    if (Number.isNaN(hi[x]!) || b > hi[x]!) hi[x] = b
  }
  const span = t.kind === 'columns' ? t.columnMs : 0
  forEachInRange(t, r, (at, a, b) => {
    const x0 = Math.floor(xOf(at, r, w))
    const x1 = span > 0 ? Math.ceil(xOf(at + span, r, w)) - 1 : x0
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, Math.max(x0, x1)); x++) put(x, a, b)
  })
  return { mode: 'band', lo, hi }
}

/** 欠けの区間。`pending` は「要約がまだ無い」（作り終えると出る）、`none` は「記録が無い」。 */
export interface GapSpan {
  readonly fromMs: number
  readonly toMs: number
  readonly kind: 'none' | 'pending'
}

function pushGap(out: GapSpan[], g: GapSpan): void {
  const last = out[out.length - 1]
  if (last !== undefined && last.kind === g.kind && last.toMs >= g.fromMs) {
    out[out.length - 1] = { ...last, toMs: Math.max(last.toMs, g.toMs) }
    return
  }
  out.push(g)
}

/**
 * 取った範囲 `fetched` の中で、値の無い区間（見ている範囲 `r` で切る）。
 *
 * - 列: 本数が 0 の列。**その列が「要約がまだ無い」か「作ったあとで元の記録が伸びた」時にあれば `pending`**、
 *   それ以外は `none`。読めない時（`failed`）は「作り終えると出る」とは言えないので `none` に数える（数は状態の行で出す）
 * - サンプル: 続きの間（刻みの 1.5 倍より空いた所）と、取った範囲の両端で値の無い所
 *
 * **取った範囲の外は欠けにしない**（まだ取っていないだけ）。
 */
export function traceGaps(t: AxisTrace, r: TimeRange, fetched: TimeRange, irregular: readonly IrregularHourView[]): GapSpan[] {
  const lo = Math.max(r.fromMs, fetched.fromMs)
  const hi = Math.min(r.toMs, fetched.toMs)
  const out: GapSpan[] = []
  if (!(hi > lo)) return out
  if (t.kind === 'columns') {
    const pendingHour = (at: number): boolean =>
      irregular.some((h) => h.state !== 'failed' && at < h.hourStartMs + HOUR_MS && at + t.columnMs > h.hourStartMs)
    for (let j = 0; j < t.n.length; j++) {
      const at = t.firstColumnMs + j * t.columnMs
      if (at + t.columnMs <= lo || at >= hi) continue
      if (t.n[j]! > 0) continue
      pushGap(out, { fromMs: Math.max(lo, at), toMs: Math.min(hi, at + t.columnMs), kind: pendingHour(at) ? 'pending' : 'none' })
    }
    return out
  }
  let cursor = lo
  for (const run of t.runs) {
    const start = run.firstSampleMs
    const end = run.firstSampleMs + run.values.length * run.msPerSample
    if (end <= lo || start >= hi) continue
    if (start - cursor > run.msPerSample * 1.5) pushGap(out, { fromMs: cursor, toMs: Math.min(hi, start), kind: 'none' })
    cursor = Math.max(cursor, end)
  }
  if (hi - cursor > 0 && cursor < hi) {
    // 末尾: 最後の刻みの 1 つ分は欠けにしない（最後のサンプルの後ろの 1 刻みは値の幅のうち）
    const step = t.runs.length > 0 ? t.runs[t.runs.length - 1]!.msPerSample : 0
    if (hi - cursor > step * 1.5) pushGap(out, { fromMs: cursor, toMs: hi, kind: 'none' })
  }
  return out
}

/** 指した時刻の値。サンプルはいちばん近い 1 点（刻みの半分より離れていれば無し）、列はその時刻を含む列。 */
export type TraceValue =
  | { readonly kind: 'sample'; readonly atMs: number; readonly value: number }
  | { readonly kind: 'column'; readonly columnStartMs: number; readonly columnMs: number; readonly min: number; readonly max: number }

export function traceValueAt(t: AxisTrace, atMs: number): TraceValue | null {
  if (t.kind === 'columns') {
    const j = Math.floor((atMs - t.firstColumnMs) / t.columnMs)
    if (j < 0 || j >= t.n.length || t.n[j]! <= 0) return null
    const min = t.min[j]!
    const max = t.max[j]!
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    return { kind: 'column', columnStartMs: t.firstColumnMs + j * t.columnMs, columnMs: t.columnMs, min, max }
  }
  for (const run of t.runs) {
    const i = Math.round((atMs - run.firstSampleMs) / run.msPerSample)
    if (i < 0 || i >= run.values.length) continue
    const at = run.firstSampleMs + i * run.msPerSample
    if (Math.abs(at - atMs) > run.msPerSample / 2) continue
    const v = run.values[i]!
    return Number.isFinite(v) ? { kind: 'sample', atMs: at, value: v } : null
  }
  return null
}

/**
 * 軸の合成（見えている軸だけ・各軸の範囲の平均を引いてから √Σ²）。**サンプルで描くときだけ作る** ——
 * 列の上下の端からは、同じ時刻に揃った値が取れない（各軸の山は列の中の別の時刻にありうる）。
 *
 * 時刻は 1 本目の軸の刻みに揃え、他の軸はその時刻にいちばん近い 1 点を使う。**1 軸でも値が無い時刻は NaN**
 * （欠けた軸を 0 として足すと、合成が小さく出る）。
 */
export function compositeRuns(traces: readonly AxisTrace[], centers: readonly number[]): SampleRunView[] | null {
  if (traces.length === 0 || traces.some((t) => t.kind !== 'samples')) return null
  if (centers.some((c) => !Number.isFinite(c))) return null
  const base = traces[0] as Extract<AxisTrace, { kind: 'samples' }>
  return base.runs.map((run) => {
    const values = run.values.map((v0, i) => {
      if (!Number.isFinite(v0)) return Number.NaN
      const at = run.firstSampleMs + i * run.msPerSample
      let sum = (v0 - centers[0]!) ** 2
      for (let k = 1; k < traces.length; k++) {
        const got = traceValueAt(traces[k]!, at)
        if (got === null || got.kind !== 'sample') return Number.NaN
        sum += (got.value - centers[k]!) ** 2
      }
      return Math.sqrt(sum)
    })
    // 届き方は 1 本目の軸のものを引き継ぐ（合成の段には届き方の線を引かない。`recordsMarks.ts` の `originUnderline`）。
    return { firstSampleMs: run.firstSampleMs, msPerSample: run.msPerSample, values, origin: run.origin, timeQuestionable: run.timeQuestionable }
  })
}

/** 全体の帯の列: 列ごとに、軸のうち振れ幅（最大 − 最小）がいちばん大きいもの。値の無い列は NaN。 */
export function overviewSpread(envelopes: readonly EnvelopeData[]): { readonly firstColumnMs: number; readonly columnMs: number; readonly spread: number[] } | null {
  if (envelopes.length === 0) return null
  const e0 = envelopes[0]!
  if (envelopes.some((e) => e.columnMs !== e0.columnMs || e.firstColumnMs !== e0.firstColumnMs || e.n.length !== e0.n.length)) return null
  const spread = e0.n.map((_, j) => {
    let best = Number.NaN
    for (const e of envelopes) {
      if (e.n[j]! <= 0) continue
      const d = e.max[j]! - e.min[j]!
      if (Number.isFinite(d) && !(d <= best)) best = d
    }
    return best
  })
  return { firstColumnMs: e0.firstColumnMs, columnMs: e0.columnMs, spread }
}

// ---- 文言 -----------------------------------------------------------------------------------

/** 単位の書き方。 */
export function unitText(unit: ValueUnit): string {
  return unit === 'gal' ? 'gal' : 'カウント'
}

/** 値（負号は `−`）。 */
export function formatValue(v: number): string {
  return formatGal(v).replace('-', '−')
}

/** 段の縦の物差し（`±20 gal`）。半幅は切りのいい値（1・2・5 の倍数）なので、整数なら小数を付けない。 */
export function scaleLabel(halfSpan: number, unit: ValueUnit): string {
  return `±${Number.isInteger(halfSpan) ? String(halfSpan) : formatValue(halfSpan)} ${unitText(unit)}`
}

/** 全段で共通の縦の半幅（切りのいい値へ上向きに丸める）。 */
export function sharedHalfSpan(peaks: readonly (TracePeak | null)[]): number {
  let max = 0
  for (const p of peaks) if (p !== null && p.deviation > max) max = p.deviation
  return niceHalfSpanGal(max)
}

/** 時刻を、範囲の広さに合わせた細かさで。**範囲が 1 日を超えたら日付を添える。** */
function timeForSpan(atMs: number, spanMs: number, digits: 0 | 1 | 2): string {
  return spanMs > DAY_MS ? formatDateMinute(atMs) : formatClockDigits(atMs, digits)
}

/** 段の見出しの最大（`最大 12.3 gal（12:03:04.25）`・要約からなら `最大 12.3 gal（12:03 ごろ）`）。 */
export function peakLabel(p: TracePeak, unit: ValueUnit, spanMs: number, columnMs: number | null): string {
  let when: string
  if (!p.approximate) when = timeForSpan(p.atMs, spanMs, 2)
  else if (spanMs > DAY_MS) when = `${formatDateMinute(p.atMs)} ごろ`
  else if (columnMs !== null && columnMs >= MINUTE_MS) when = `${formatClockDigits(p.atMs, 0).slice(0, 5)} ごろ`
  else when = `${formatClockDigits(p.atMs, 0)} ごろ`
  return `最大 ${formatValue(p.deviation)} ${unitText(unit)}（${when}）`
}

/** 描いている段の行。 */
export function sourceNote(source: 'coarse' | 'fine' | 'samples' | 'raw-samples', columnMs: number | null): string {
  if (source === 'raw-samples' || source === 'samples' || columnMs === null) return '生のサンプルから描いている'
  const which = source === 'coarse' ? '1 分の要約' : '1 秒の要約'
  return `${which}から描いている（列 1 本＝${durationLabel(columnMs)}）`
}

/** 要約の不調の行。**どれも 0 なら null。** */
export function problemsNote(t: HourTallyView | null): string | null {
  if (t === null || t.pending + t.stale + t.failed === 0) return null
  return `要約がまだ無い時が ${t.pending}、作ったあとで元の記録が伸びた時が ${t.stale}（末尾が欠けているかもしれない）、読めない時が ${t.failed}`
}

/** 換算できない時の行。**0 なら null。** */
export function unscaledNote(hours: number): string | null {
  return hours > 0 ? `換算の係数が判らない時が ${hours} あり、そこは描いていない（生の値に切り替えると出る）` : null
}

/** 一覧から漏れているかもしれない行。**0 なら null。** */
export function unreadableListNote(n: number): string | null {
  return n > 0 ? `読めない要約が ${n} 件あり、一覧から漏れているかもしれない` : null
}

export const EMPTY_RANGE_TEXT = 'この範囲に記録は無い'
export const TOKEN_MISSING_TEXT = '管理トークンを設定すると読める'
/**
 * 合成の段の見出し。**見えている軸だけで合成する**ので軸の数を名乗らない（PWA の詳細の窓と同じ。
 * 2026-10-08 ユーザー承認）。
 */
export const COMPOSITE_TITLE = '合成'
export const COMPOSITE_TOO_WIDE_TEXT = '合成は 10 分以内まで寄せると出る'
export const INTENSITY_TITLE = 'リアルタイム震度の推移'
export const INTENSITY_TOO_WIDE_TEXT = '震度の推移は 10 分以内まで寄せると出る'
export const INTENSITY_STATION_ONLY_TEXT = '震度の推移は観測点の合成波形にだけ出る'
export const GAP_NONE_LEGEND = '斜線: 記録が無い'
export const GAP_PENDING_LEGEND = '灰色の斜線: 要約がまだ無い（作り終えると出る）'
export const OVERVIEW_CAPTION = '全体（振れ幅がいちばん大きい軸）。押すとその時刻へ寄る'

/** 取れなかったときの行。 */
export function fetchFailureText(reason: string): string {
  return `波形の記録を取得できていない（${reason}）`
}

/**
 * 震度の段の見出し（`最大 1.2（12:03:06） 計測 0.8`）。**最大と計測の間は常に半角空白**（2026-10-08 ユーザー承認）
 * —— 値が無いと `最大 —計測 —` と詰まって読めなかった。
 */
export function intensityHeader(d: IntensityData): string {
  const max = d.maxRealtime === null ? '—' : d.maxRealtime.toFixed(1)
  const at = d.maxRealtime !== null && d.maxRealtimeAtMs !== null ? `（${formatClockDigits(d.maxRealtimeAtMs, 0)}）` : ''
  const measured = d.measured === null ? '—' : d.measured.toFixed(1)
  return `最大 ${max}${at} 計測 ${measured}`
}

/** 指した所の値の行。**軸ごとの値は同じ種類（サンプルか列）で揃っているものだけ並べる。** */
export function readoutText(
  values: readonly { readonly short: string; readonly value: TraceValue | null }[],
  unit: ValueUnit,
  atMs: number,
  spanMs: number,
): string {
  const first = values.find((v) => v.value !== null)?.value ?? null
  if (first === null) return `${timeForSpan(atMs, spanMs, 2)}　${EMPTY_RANGE_TEXT}`
  if (first.kind === 'sample') {
    const parts = values.map((v) => `${v.short} ${v.value !== null && v.value.kind === 'sample' ? formatValue(v.value.value) : '—'}`)
    return `${formatClockDigits(first.atMs, 2)}　${parts.join('　')} ${unitText(unit)}`
  }
  const head = `${timeForSpan(first.columnStartMs, spanMs, 0)} からの ${durationLabel(first.columnMs)}`
  const parts = values.map((v) =>
    v.value !== null && v.value.kind === 'column' ? `${v.short} ${formatValue(v.value.min)}〜${formatValue(v.value.max)}` : `${v.short} —`,
  )
  return `${head}　${parts.join('　')} ${unitText(unit)}`
}

// ---- 時間軸の目盛り --------------------------------------------------------------------------

/** 目盛りの刻みの候補（ミリ秒）。細かい側から。 */
const TICK_STEPS_MS: readonly number[] = [
  10, 20, 50, 100, 200, 500, SECOND_MS, 2 * SECOND_MS, 5 * SECOND_MS, 10 * SECOND_MS, 15 * SECOND_MS, 30 * SECOND_MS,
  MINUTE_MS, 2 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS,
  HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 7 * DAY_MS,
]

/**
 * 時間軸の目盛り。**刻みは時計の切りのいい所（地域の時刻）へ揃える** —— 1 日の刻みが 9 時に並ぶと読めない。
 * 文字は刻みの細かさで決める（1 秒未満は小数 2 桁・1 分未満は秒まで・1 日未満は分まで、0 時と 1 日以上は日付）。
 */
export function recordTicks(r: TimeRange, maxTicks: number): readonly { readonly atMs: number; readonly label: string }[] {
  if (!(r.toMs > r.fromMs) || maxTicks < 1) return []
  const span = r.toMs - r.fromMs
  const step = TICK_STEPS_MS.find((s) => span / s <= maxTicks) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!
  // 地域の時刻のずれ（夏時間の無い前提で、範囲の頭のずれを使う）。
  const offset = -new Date(r.fromMs).getTimezoneOffset() * MINUTE_MS
  const out: { atMs: number; label: string }[] = []
  for (let k = Math.ceil((r.fromMs + offset) / step); k * step - offset <= r.toMs; k++) {
    const at = k * step - offset
    const d = new Date(at)
    const midnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0
    let label: string
    if (step < SECOND_MS) label = formatClockDigits(at, 2)
    else if (step < MINUTE_MS) label = formatClockDigits(at, 0)
    else if (step >= DAY_MS || (step >= HOUR_MS && midnight)) label = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`
    else label = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    out.push({ atMs: at, label })
  }
  return out
}
