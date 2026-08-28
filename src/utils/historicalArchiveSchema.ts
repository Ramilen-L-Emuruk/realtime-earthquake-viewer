import type { HistoricalArchiveFile, HistoricalArchiveIndex, HistoricalArchiveMeta } from '../types/historicalArchive'
import { isValidIntensityScale } from './intensity'

// ローカル履歴アーカイブ（`public/data/historical-archives/`）の型検証ガード。
// testScenarioSchema.ts と同じ考え方: 壊れた JSON を検証なしで使うと実行時例外や
// 破損エントリの再生につながるため、配信側の破損に対して防御的に振る舞う。
//
// このファイルの内容は `capture-test-scenario.ts` のように実電文から機械生成されるのではなく、
// 気象庁公表資料を典拠に手作業で書き起こしている（`docs/spec/settings-pwa-spec.md` §6 参照）。
// typo が混入しやすい経路であり、かつこのアプリには React の ErrorBoundary が無いため、
// 判別子（kind）の存在だけでなく、震度値・警報区分など描画に直結するフィールドの値域まで
// ここで弾く。中間値（`25` 等）や未知の区分がそのまま state に乗ると、既存の実地震シナリオ
// （`testScenarioSchema.ts`・`eew-spec.md` §4）と同じ理由でカードやバッジの表示が壊れる。

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidIso(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !Number.isNaN(new Date(v).getTime())
}

function isArchiveMeta(v: unknown): v is HistoricalArchiveMeta {
  if (!isRecord(v)) return false
  if (typeof v.id !== 'string' || v.id.length === 0) return false
  if (typeof v.label !== 'string') return false
  if (typeof v.description !== 'string') return false
  if (!isValidIso(v.from) || !isValidIso(v.to)) return false
  if (new Date(v.from).getTime() >= new Date(v.to).getTime()) return false
  if (!isValidIso(v.firstEventTime)) return false
  const firstEventMs = new Date(v.firstEventTime).getTime()
  if (firstEventMs < new Date(v.from).getTime() || firstEventMs > new Date(v.to).getTime()) return false
  return true
}

/** index.json の型検証。壊れた要素は落として通ったものだけ返す（testScenarioSchema.ts と同じ方針）。 */
export function validateHistoricalArchiveIndex(
  v: unknown,
): { valid: HistoricalArchiveIndex; skipped: number; malformed: boolean } {
  if (!Array.isArray(v)) return { valid: [], skipped: 0, malformed: true }
  const valid: HistoricalArchiveMeta[] = []
  let skipped = 0
  for (const item of v) {
    if (isArchiveMeta(item)) valid.push(item)
    else skipped++
  }
  return { valid, skipped, malformed: false }
}

// ReplayPayload の判別子。types/replay.ts の ReplayPayload / testScenarioSchema.ts の
// PAYLOAD_KINDS と一致させる。
const PAYLOAD_KINDS = new Set(['event', 'lpgm', 'nankai', 'nankaiCommentary', 'kohatsu'])
const TSUNAMI_GRADES = new Set(['MajorWarning', 'Warning', 'Watch', 'Forecast', 'Unknown'])

function isValidScaleIfPresent(v: unknown): boolean {
  return v === undefined || (typeof v === 'number' && isValidIntensityScale(v))
}

/**
 * AppEvent の値域を検証する。判別子（kind）ごとに、震度・警報区分など
 * 描画に直結するフィールドだけを見る（構造全体を網羅する型検査の代替ではない）。
 */
function isValidAppEvent(event: Record<string, unknown>): boolean {
  switch (event.kind) {
    case 'quake': {
      const eq = event.earthquake
      if (!isRecord(eq) || !isValidScaleIfPresent(eq.maxScale)) return false
      const points = event.points
      if (points !== undefined) {
        if (!Array.isArray(points)) return false
        if (points.some((p) => !isRecord(p) || !isValidScaleIfPresent(p.scale))) return false
      }
      return true
    }
    case 'eew': {
      for (const key of ['areas', 'regions']) {
        const list = event[key]
        if (list === undefined) continue
        if (!Array.isArray(list)) return false
        if (list.some((r) => !isRecord(r) || !isValidScaleIfPresent(r.scaleFrom) || !isValidScaleIfPresent(r.scaleTo))) return false
      }
      return isValidScaleIfPresent(event.forecastMaxScale)
    }
    case 'tsunami': {
      const areas = event.areas
      if (!Array.isArray(areas)) return false
      return areas.every((a) => isRecord(a) && typeof a.grade === 'string' && TSUNAMI_GRADES.has(a.grade))
    }
    default:
      // 未知の kind は AppEvent として描画できないため弾く。
      return false
  }
}

function isValidPayload(p: Record<string, unknown>): boolean {
  const kind = p.kind
  if (typeof kind !== 'string' || !PAYLOAD_KINDS.has(kind)) return false
  if (kind === 'event') return isRecord(p.event) && isValidAppEvent(p.event)
  return isRecord(p.data)
}

/**
 * アーカイブ本体の型検証。entries は時刻・payload の判別子とAppEventの値域まで検証する。
 * `skipped` は壊れて落としたエントリ数（呼び出し側でログ出力に使う。ReplayFetchResult の
 * `skipped` には反映しない。理由は `localArchiveReplay.ts` の loadFile 参照）。
 */
export function validateHistoricalArchiveFile(v: unknown): { file: HistoricalArchiveFile; skipped: number } | null {
  if (!isRecord(v)) return null
  if (!isArchiveMeta(v)) return null
  if (!Array.isArray(v.entries)) return null
  const entries: HistoricalArchiveFile['entries'] = []
  let skipped = 0
  for (const e of v.entries) {
    if (!isRecord(e) || !isValidIso(e.time) || !isRecord(e.payload) || !isValidPayload(e.payload)) {
      skipped++
      continue
    }
    entries.push({
      time: e.time,
      payload: e.payload as HistoricalArchiveFile['entries'][number]['payload'],
      silent: typeof e.silent === 'boolean' ? e.silent : undefined,
    })
  }
  return {
    file: {
      id: v.id as string,
      label: v.label as string,
      description: v.description as string,
      from: v.from as string,
      to: v.to as string,
      firstEventTime: v.firstEventTime as string,
      entries,
    },
    skipped,
  }
}
