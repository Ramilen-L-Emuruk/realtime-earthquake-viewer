// 地震 1 件ぶんの区間について、自作地震計の震度 2 つをホストへ訊く（`GET /quake-intensity`）。
//
// - **最大リアルタイム震度** —— 押し出しと同じ方式（強震モニタと同じ）で、区間の中の最大
// - **計測震度** —— 気象庁の手順を区間の波形全体へ 1 回当てた値
//
// **計算はホストの仕事。** アプリが持っている波形は列に畳んだ上下端だけで、震度は
// 出せない（サンプルを取り寄せると 1 件で数 MB になる）。ホストは合成波形の控えを
// サンプルのまま持っている（`seismo-host/src/receiver/quakeIntensity.ts`）。
//
// **受け取る形はここに書く。** ホスト側の型を `import type` で借りない（理由は
// `seismoStream.ts` の冒頭と同じ —— 境界を越えてくる値を型どおりと信じない）。

import { log } from '../utils/logger'
import { obj, str } from './parseHelpers'
import { isValidSeismoHostUrl } from './seismoStream'

/**
 * ホストが受ける範囲の上限（ms）。**`seismo-host` 側の `WAVE_RANGE_MAX_MS` と同じ値。**
 * 投げる前に弾く理由は `seismoWaveHistory.ts` の `HOST_RANGE_MAX_MS` と同じ。
 */
export const QUAKE_INTENSITY_RANGE_MAX_MS = 10 * 60 * 1000

/** 取るときの打ち切り（ms）。読む量は `/waves` の列より多いので同じ長さを取る。 */
const FETCH_TIMEOUT_MS = 15_000

/** 計測震度を出せなかった理由（ホストが返す語）。読めない語は `'unknown'` に寄せる。 */
export type MeasuredUnavailable = 'no-data' | 'gap' | 'not-covered' | 'no-value' | 'unknown'

const KNOWN_REASONS: readonly MeasuredUnavailable[] = ['no-data', 'gap', 'not-covered', 'no-value']

/** リアルタイム震度の 1 刻み（1 秒ごと）。 */
export interface RealtimeIntensityPoint {
  /** その刻みの最後のサンプルの時刻。 */
  readonly atMs: number
  /** 値が出なかった刻みは `null`。 */
  readonly value: number | null
}

/** 区間の震度。 */
export interface QuakeIntensity {
  /** 問い合わせた区間。**描く側はこれが自分の区間と一致するときだけ出す。** */
  readonly fromMs: number
  readonly toMs: number
  /** 区間の中の最大のリアルタイム震度。出なければ `null`。 */
  readonly maxRealtime: number | null
  /** 最大を出した刻みの時刻。 */
  readonly maxRealtimeAtMs: number | null
  /**
   * 区間の中の刻みごとのリアルタイム震度（時刻順）。**途切れた所は時刻が飛ぶ**（補っていない）。
   * 詳細ポップアップの震度の推移に使う。
   */
  readonly realtimeSeries: readonly RealtimeIntensityPoint[]
  /** 計測震度。出せなければ `null`（理由は `measuredUnavailable`）。 */
  readonly measured: number | null
  readonly measuredUnavailable: MeasuredUnavailable | null
  /** 区間の中にあった途切れの数。 */
  readonly gapCount: number
  /** 値が壊れていて捨てたまとまりの数。**途切れのうち「届いたが壊れていた」分。** */
  readonly invalidChunkCount: number
  /**
   * ホストが申告した読み込みの欠け（`GET /waves` と同じ欄）。**震度は出ても記録へ残す** ——
   * 計算結果からは、ディスクの不調で読めなかったのか、もともと届いていなかったのかが分からない。
   */
  readonly filesMissing: number
  readonly filesFailed: number
  readonly skippedBytes: number
  readonly truncated: boolean
}

export type QuakeIntensityResult =
  | { readonly kind: 'ok'; readonly intensity: QuakeIntensity }
  /** 範囲・引数が不正で、通信する前に弾いた。 */
  | { readonly kind: 'bad-request'; readonly detail: string }
  /** 応答が返らなかった。 */
  | { readonly kind: 'unreachable'; readonly detail: string }
  /**
   * ホストがこの口を持っていない（404）。**配る前の古いホストへ繋いでいる。**
   * 取り直しても結果は変わらないので、呼び出し側は接続先が変わるまで訊かない。
   */
  | { readonly kind: 'not-supported' }
  /** 応答は返ったが HTTP が成功ではない（404 以外）。 */
  | { readonly kind: 'http-error'; readonly status: number }
  /** 応答は返ったが、こちらが期待する形ではない。 */
  | { readonly kind: 'unreadable'; readonly detail: string }
  /** 呼び出し側が取り消した。**失敗ではないので記録へ残さない**（`seismoWaveHistory.ts` と同じ）。 */
  | { readonly kind: 'aborted' }

/** 数か `null` か。**それ以外（文字列・`NaN` 相当）は読めないとして弾く。** */
function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 震度の推移を読む。**欄が無ければ空**（推移を返す前のホスト。最大と計測震度は出せる）。
 * 欄があって形が崩れていれば `null`（読めない）—— 1 点だけ黙って捨てると、推移の線が
 * そこで「途切れた」ように描かれ、ホストの記録の欠けと見分けが付かない。
 */
function readRealtimeSeries(value: unknown): RealtimeIntensityPoint[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const out: RealtimeIntensityPoint[] = []
  let prevMs = -Infinity
  for (const raw of value) {
    const p = obj(raw)
    const atMs = finiteOrNull(p.atMs)
    const v = finiteOrNull(p.value)
    if (typeof atMs !== 'number' || v === undefined || atMs <= prevMs) return null
    out.push({ atMs, value: v })
    prevMs = atMs
  }
  return out
}

/** 応答を読む。 */
export function readQuakeIntensity(parsed: unknown): { value: QuakeIntensity } | { detail: string } {
  const root = obj(parsed)
  if (str(root.stationId) === '') return { detail: 'stationId が無い' }
  const fromMs = finiteOrNull(root.fromMs)
  const toMs = finiteOrNull(root.toMs)
  if (typeof fromMs !== 'number' || typeof toMs !== 'number') return { detail: '範囲を読めない' }
  const maxRealtime = finiteOrNull(root.maxRealtime)
  const measured = finiteOrNull(root.measured)
  // **欄が欠けている・数でない値は読めないとして弾く。** `null`（値が出なかった）と
  // 取り違えると、壊れた応答が「震度が出なかった地震」として黙って通る。
  if (maxRealtime === undefined || measured === undefined) return { detail: '震度の欄を読めない' }
  const maxRealtimeAtMs = finiteOrNull(root.maxRealtimeAtMs) ?? null
  const realtimeSeries = readRealtimeSeries(root.realtimeSeries)
  if (realtimeSeries === null) return { detail: '震度の推移を読めない' }
  let measuredUnavailable: MeasuredUnavailable | null = null
  if (measured === null) {
    const reason = str(root.measuredUnavailable)
    measuredUnavailable = (KNOWN_REASONS as readonly string[]).includes(reason)
      ? (reason as MeasuredUnavailable)
      : 'unknown'
  }
  const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    value: {
      fromMs,
      toMs,
      maxRealtime,
      maxRealtimeAtMs,
      realtimeSeries,
      measured,
      measuredUnavailable,
      gapCount: count(root.gapCount),
      invalidChunkCount: count(root.invalidChunkCount),
      filesMissing: count(root.filesMissing),
      filesFailed: count(root.filesFailed),
      skippedBytes: count(root.skippedBytes),
      truncated: root.truncated === true,
    },
  }
}

function apiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * 区間の震度を訊く。**失敗しても投げない**（画面は「出さない」だけ。理由は記録へ残す）。
 *
 * **`not-supported`（404）は記録しない。** 配る前のホストへ繋いでいる間はカードの枚数だけ
 * 返ってくるので、毎回書くと記録が埋まる。1 回だけ書くのは呼び出し側の仕事。
 */
export async function fetchSeismoQuakeIntensity(params: {
  baseUrl: string
  stationId: string
  fromMs: number
  toMs: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<QuakeIntensityResult> {
  const { baseUrl, stationId, signal } = params
  const fromMs = Math.floor(params.fromMs)
  const toMs = Math.floor(params.toMs)
  const fetchImpl = params.fetchImpl ?? globalThis.fetch

  const fail = <T extends QuakeIntensityResult>(result: T, why: string): T => {
    log.warn(`[seismo] 地震の区間の震度を訊けず（${result.kind}・${stationId}）: ${why}`)
    return result
  }

  if (!isValidSeismoHostUrl(baseUrl)) return fail({ kind: 'bad-request' as const, detail: 'URL の形が正しくない' }, 'URL の形が正しくない')
  if (stationId === '') return fail({ kind: 'bad-request' as const, detail: '観測点が空' }, '観測点が空')
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return fail({ kind: 'bad-request' as const, detail: '範囲が不正' }, '範囲が不正')
  }
  if (toMs - fromMs > QUAKE_INTENSITY_RANGE_MAX_MS) {
    return fail({ kind: 'bad-request' as const, detail: '範囲が上限を超える' }, '範囲が上限を超える')
  }

  const query = new URLSearchParams({ station: stationId, from: String(fromMs), to: String(toMs) })
  let res: Response
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const onAbort = (): void => ctrl.abort()
    signal?.addEventListener('abort', onAbort)
    if (signal?.aborted === true) ctrl.abort()
    try {
      res = await fetchImpl(`${apiBase(baseUrl)}/quake-intensity?${query.toString()}`, {
        signal: ctrl.signal,
        cache: 'no-store',
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    // 呼び出し側の取り消しと時間切れの見分け方は `seismoWaveHistory.ts` と同じ。
    if (signal?.aborted === true) return { kind: 'aborted' as const }
    const detail = describeError(error)
    return fail({ kind: 'unreachable' as const, detail }, detail)
  }
  if (res.status === 404) return { kind: 'not-supported' as const }
  if (!res.ok) return fail({ kind: 'http-error' as const, status: res.status }, `HTTP ${res.status}`)

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch (error) {
    const detail = describeError(error)
    return fail({ kind: 'unreadable' as const, detail }, detail)
  }
  const read = readQuakeIntensity(parsed)
  if ('detail' in read) return fail({ kind: 'unreadable' as const, detail: read.detail }, read.detail)
  return { kind: 'ok', intensity: read.value }
}
