// 各タブの表示の好み（localStorage に置くもの）を読み書きする。
//
// **読むときに 1 項目ずつ確かめ、読めない項目だけ既定へ倒す。** localStorage には前の版の
// 管理コンソールが書いた値も、手で書き換えた値も残りうる。1 項目が壊れただけで全部を
// 捨てると、ほかの好みまで消える。
//
// 置き場所の振り分けと理由は `tabState.ts` の冒頭。

/** 波形タブ。センサーごとのチェックは「付けた」「外した」の両方を覚える。 */
export interface WavesPrefs {
  readonly spanMs: number | null
  readonly scale: string | null
  /** 鍵（`waveBuffer.ts` の `keyOf`）ごとの表示。古いものから並ぶ。 */
  readonly sensors: ReadonlyMap<string, boolean>
}

/**
 * 覚えておくセンサーのチェックの数の上限。
 *
 * **鍵は差分の組・ずれの台まで含むので、選び直すたびに増える。** 上限で古いものから捨てる ——
 * 捨てたものは次に届いたとき既定の扱いに戻るだけで、表示が壊れるわけではない。
 */
export const MAX_REMEMBERED_SENSORS = 200

export function readWavesPrefs(
  raw: unknown,
  spanChoices: readonly number[],
  scaleChoices: readonly string[],
): WavesPrefs {
  const obj = isRecord(raw) ? raw : {}
  const spanMs = typeof obj.spanMs === 'number' && spanChoices.includes(obj.spanMs) ? obj.spanMs : null
  const scale = typeof obj.scale === 'string' && scaleChoices.includes(obj.scale) ? obj.scale : null
  const sensors = new Map<string, boolean>()
  if (Array.isArray(obj.sensors)) {
    for (const entry of obj.sensors.slice(-MAX_REMEMBERED_SENSORS)) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'boolean') {
        sensors.set(entry[0], entry[1])
      }
    }
  }
  return { spanMs, scale, sensors }
}

export function writeWavesPrefs(prefs: WavesPrefs): unknown {
  return {
    spanMs: prefs.spanMs,
    scale: prefs.scale,
    sensors: [...prefs.sensors].slice(-MAX_REMEMBERED_SENSORS),
  }
}

/** チェックを覚える（いちばん新しい側へ置き直す。古いものは上限で捨てる）。 */
export function rememberSensorChoice(sensors: Map<string, boolean>, key: string, shown: boolean): void {
  sensors.delete(key)
  sensors.set(key, shown)
  while (sensors.size > MAX_REMEMBERED_SENSORS) {
    const oldest = sensors.keys().next().value
    if (oldest === undefined) break
    sensors.delete(oldest)
  }
}

/** 揺れの記録タブの期間。直近の日数か、日本時間の日付で区切った範囲。 */
export type ShakePeriodPref =
  | { readonly kind: 'days'; readonly days: number }
  | { readonly kind: 'dates'; readonly fromMs: number; readonly toMs: number }

export interface ShakesPrefs {
  readonly period: ShakePeriodPref | null
  readonly hideLocal: boolean
}

export function readShakesPrefs(raw: unknown, dayChoices: readonly number[]): ShakesPrefs {
  const obj = isRecord(raw) ? raw : {}
  let period: ShakePeriodPref | null = null
  const p = obj.period
  if (isRecord(p)) {
    if (p.kind === 'days' && typeof p.days === 'number' && dayChoices.includes(p.days)) {
      period = { kind: 'days', days: p.days }
    } else if (
      p.kind === 'dates' &&
      typeof p.fromMs === 'number' &&
      typeof p.toMs === 'number' &&
      Number.isFinite(p.fromMs) &&
      Number.isFinite(p.toMs) &&
      p.fromMs < p.toMs
    ) {
      period = { kind: 'dates', fromMs: p.fromMs, toMs: p.toMs }
    }
  }
  return { period, hideLocal: obj.hideLocal === true }
}

export function writeShakesPrefs(prefs: ShakesPrefs): unknown {
  return { period: prefs.period, hideLocal: prefs.hideLocal }
}

/** 波形の記録タブ。隠した軸は記録（グループの鍵）ごとに覚える。 */
export interface RecordsPrefs {
  readonly unit: 'gal' | 'native'
  readonly hidden: ReadonlyMap<string, readonly string[]>
}

/** 隠した軸を覚えておく記録の数の上限（古いものから捨てる）。 */
export const MAX_REMEMBERED_RECORD_GROUPS = 100

export function readRecordsPrefs(raw: unknown): RecordsPrefs {
  const obj = isRecord(raw) ? raw : {}
  const unit = obj.unit === 'native' ? 'native' : 'gal'
  const hidden = new Map<string, readonly string[]>()
  if (Array.isArray(obj.hidden)) {
    for (const entry of obj.hidden.slice(-MAX_REMEMBERED_RECORD_GROUPS)) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        Array.isArray(entry[1]) &&
        entry[1].every((id: unknown) => typeof id === 'string')
      ) {
        hidden.set(entry[0], entry[1] as string[])
      }
    }
  }
  return { unit, hidden }
}

export function writeRecordsPrefs(prefs: RecordsPrefs): unknown {
  return { unit: prefs.unit, hidden: [...prefs.hidden].slice(-MAX_REMEMBERED_RECORD_GROUPS) }
}

/**
 * 記録の隠した軸を覚える。**1 本も隠していなければ消す**（既定と同じなので覚えておく意味が無い）。
 */
export function rememberHiddenAxes(hidden: Map<string, readonly string[]>, groupKey: string, ids: readonly string[]): void {
  hidden.delete(groupKey)
  if (ids.length > 0) hidden.set(groupKey, [...ids])
  while (hidden.size > MAX_REMEMBERED_RECORD_GROUPS) {
    const oldest = hidden.keys().next().value
    if (oldest === undefined) break
    hidden.delete(oldest)
  }
}

/**
 * 覚えていた隠した軸を、いまの記録の軸へ当てる。
 *
 * **いまの軸に無い id は捨て、1 本も見えなくなるなら全部出す。** 覚えた後にセンサーを
 * 入れ替えると軸の顔ぶれが変わる。軸のボタンは最後の 1 本を消させないが、ここはそれを
 * 通らないので、同じ守りを自分で持つ（段が 1 つも無いと、範囲の操作の手掛かりが無くなる）。
 */
export function applyHiddenAxes(remembered: readonly string[] | undefined, axisIds: readonly string[]): Set<string> {
  if (remembered === undefined) return new Set()
  const hidden = new Set(remembered.filter((id) => axisIds.includes(id)))
  return hidden.size >= axisIds.length ? new Set() : hidden
}

/** 波形の記録の時間の範囲（URL の `from`・`to`）を読む。読めなければ `null`。 */
export function readRangeSelection(from: string | null, to: string | null): { fromMs: number; toMs: number } | null {
  if (from === null || to === null) return null
  if (!/^-?\d+$/.test(from) || !/^-?\d+$/.test(to)) return null
  const fromMs = Number(from)
  const toMs = Number(to)
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || !(fromMs < toMs)) return null
  return { fromMs, toMs }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
