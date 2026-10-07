// 保存した波形を読み返す口（`GET /api/records/*`）。管理コンソールの「波形の記録」が使う。
//
// **`/api/*` の側に置く**（認証つき）。生データの全センサー・全期間は、誰でも読める `/status`・`/waves` に
// 並べる理由が無い（PWA の `/waves` は観測点の合成波形を地震カードへ出すためのもので、そのまま残す）。
//
// この部品は HTTP を知らない。`statusServer.ts` が経路の残り（`/api/records/` の後ろ）と問い合わせを渡し、
// 返した `{ status, body }` をそのまま JSON で答える。
//
// | 経路 | 問い合わせ | 返すもの |
// |---|---|---|
// | `channels` | なし | 保存してあるチャンネルの一覧（`waveRecordChannels.ts`） |
// | `envelope` | `channel`・`from`・`to`・`columns`・`unit` | 列ごとの本数・最小・最大・平均・標準偏差・ノイズ |
// | `samples` | `channel`・`from`・`to`・`unit` | 生のサンプル（{@link SAMPLES_RANGE_MAX_MS} まで） |
// | `spectrum` | `channel`・`from`・`to`・`unit` | 区間のスペクトル |
// | `spectrogram` | `channel`・`from`・`to`・`columns`・`unit` | 列ごとのスペクトル |
// | `reception` | `from`・`to`・`sensor`（任意） | 受信の記録の帯と読めなかったパケット |
//
// `from`・`to` は unix ミリ秒（`to` は含まない）。`unit` は `gal`（既定。カウントを換算する）か `native`。

import { decimalInt } from './httpQuery'
import type { StationConfig } from './stationConfigTypes'
import type { RecordChannelIndex } from './waveRecordChannels'
import {
  SAMPLES_RANGE_MAX_MS,
  chooseEnvelopeSource,
  parseChannelId,
  readReception,
  readSamples,
  readSamplesEnvelope,
  readSpectrogram,
  readSpectrum,
  readSummaryEnvelope,
  round6,
  type ChannelRef,
  type EnvelopeColumns,
  type RecordDirs,
  type UnitChoice,
} from './waveRecords'

/** 1 回に読み返す範囲の広さの上限。 */
export const RECORDS_RANGE_MAX_MS = 400 * 24 * 3_600_000
/** 列の数の上限（`/waves` と同じ）。 */
export const RECORDS_COLUMNS_MAX = 4096

const SENSOR_RE = /^FDSN:[A-Za-z0-9_-]{1,64}$/

export interface RecordsApiDeps {
  readonly dirs: RecordDirs
  readonly channels: RecordChannelIndex
  /** いまの設定（一覧へ名前を添えるのに使う）。 */
  readonly config: () => StationConfig
}

export interface RecordsResponse {
  readonly status: number
  readonly body: unknown
}

type Failure = { readonly ok: false; readonly error: string }

function bad(error: string): RecordsResponse {
  return { status: 400, body: { error } }
}

function readRange(params: URLSearchParams, maxMs: number): { ok: true; fromMs: number; toMs: number } | Failure {
  const fromMs = decimalInt(params.get('from'))
  const toMs = decimalInt(params.get('to'))
  if (fromMs === null || toMs === null || toMs <= fromMs) return { ok: false, error: 'bad-range' }
  if (toMs - fromMs > maxMs) return { ok: false, error: 'range-too-wide' }
  return { ok: true, fromMs, toMs }
}

function readChannel(params: URLSearchParams): { ok: true; ref: ChannelRef } | Failure {
  const raw = params.get('channel')
  const ref = raw === null ? null : parseChannelId(raw)
  return ref === null ? { ok: false, error: 'bad-channel' } : { ok: true, ref }
}

function readColumns(params: URLSearchParams): { ok: true; columns: number } | Failure {
  const n = decimalInt(params.get('columns'))
  if (n === null || n < 1 || n > RECORDS_COLUMNS_MAX) return { ok: false, error: 'bad-columns' }
  return { ok: true, columns: n }
}

function readUnit(params: URLSearchParams): { ok: true; unit: UnitChoice } | Failure {
  const raw = params.get('unit')
  if (raw === null || raw === 'gal') return { ok: true, unit: 'gal' }
  if (raw === 'native') return { ok: true, unit: 'native' }
  return { ok: false, error: 'bad-unit' }
}

/** 数の並びを JSON へ。**有限でない値は `null`**（欠け・測れない区画）。有効数字 6 桁へ丸める。 */
function numbers(values: ArrayLike<number>): (number | null)[] {
  const out = new Array<number | null>(values.length)
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]!
    out[i] = Number.isFinite(v) ? round6(v) : null
  }
  return out
}

function columnsBody(c: EnvelopeColumns): Record<string, unknown> {
  return {
    columnMs: c.columnMs,
    firstColumnMs: c.firstColumnMs,
    n: c.n,
    min: c.min,
    max: c.max,
    mean: c.mean,
    std: c.std,
    noiseStd: c.noiseStd,
  }
}

/** `/api/records/` の後ろ（`route`）と問い合わせから答えを作る。**投げない**（読み手が投げない作りのため）。 */
export async function handleRecordsRequest(route: string, params: URLSearchParams, deps: RecordsApiDeps): Promise<RecordsResponse> {
  const { dirs } = deps
  if (route === 'channels') {
    return { status: 200, body: await deps.channels.list(deps.config()) }
  }
  if (route === 'reception') {
    const range = readRange(params, RECORDS_RANGE_MAX_MS)
    if (!range.ok) return bad(range.error)
    const sensor = params.get('sensor')
    if (sensor !== null && !SENSOR_RE.test(sensor)) return bad('bad-sensor')
    return { status: 200, body: await readReception({ dirs, fromMs: range.fromMs, toMs: range.toMs, sensor }) }
  }
  if (route !== 'envelope' && route !== 'samples' && route !== 'spectrum' && route !== 'spectrogram') {
    return { status: 404, body: { error: 'not-found' } }
  }

  const channel = readChannel(params)
  if (!channel.ok) return bad(channel.error)
  const unit = readUnit(params)
  if (!unit.ok) return bad(unit.error)
  const range = readRange(params, route === 'samples' ? SAMPLES_RANGE_MAX_MS : RECORDS_RANGE_MAX_MS)
  if (!range.ok) return bad(range.error)
  const { ref } = channel
  const { fromMs, toMs } = range

  if (route === 'samples') {
    const got = await readSamples({ dirs, ref, fromMs, toMs, unit: unit.unit })
    return {
      status: 200,
      body: {
        channel: ref.id,
        unit: got.unit,
        runs: got.runs.map((r) => ({
          firstSampleMs: r.firstSampleMs,
          msPerSample: r.msPerSample,
          origin: r.origin,
          timeQuestionable: r.timeQuestionable,
          values: numbers(r.values),
        })),
        files: got.files,
        problems: got.problems,
      },
    }
  }
  if (route === 'spectrum') {
    const got = await readSpectrum({ dirs, ref, fromMs, toMs, unit: unit.unit })
    return {
      status: 200,
      body: {
        channel: ref.id,
        source: got.source,
        unit: got.unit,
        binEdgesHz: numbers(got.binEdgesHz),
        power: numbers(got.power),
        segments: got.segments,
        hours: got.hours,
        files: got.files,
        problems: got.problems,
      },
    }
  }

  const columns = readColumns(params)
  if (!columns.ok) return bad(columns.error)

  if (route === 'spectrogram') {
    const got = await readSpectrogram({ dirs, ref, fromMs, toMs, columns: columns.columns, unit: unit.unit })
    return {
      status: 200,
      body: {
        channel: ref.id,
        unit: got.unit,
        binEdgesHz: numbers(got.binEdgesHz),
        columnMs: got.columnMs,
        firstColumnMs: got.firstColumnMs,
        segments: got.segments,
        power: got.power.map((row) => numbers(row)),
        hours: got.hours,
        problems: got.problems,
      },
    }
  }

  // route === 'envelope'
  const source = chooseEnvelopeSource(fromMs, toMs, columns.columns, SAMPLES_RANGE_MAX_MS)
  if (source === 'samples') {
    const got = await readSamplesEnvelope({ dirs, ref, fromMs, toMs, columns: columns.columns, unit: unit.unit })
    return {
      status: 200,
      body: { channel: ref.id, source, unit: got.unit, ...columnsBody(got.columns), hours: null, files: got.files, problems: got.problems },
    }
  }
  const got = await readSummaryEnvelope({ dirs, ref, source, fromMs, toMs, columns: columns.columns, unit: unit.unit })
  return {
    status: 200,
    body: { channel: ref.id, source, unit: got.unit, ...columnsBody(got.columns), hours: got.hours, files: null, problems: got.problems },
  }
}
