// 揺れの記録タブで、押した行の区間の波形を描くための当て方（DOM・Canvas に触らない部分）。
//
// **読み返すのは列ごとの上下の端**（`GET /waves?columns=`。`receiver/waveEnvelope.ts`）。サンプルの
// まま返す形は 2 分までしか取れない（`statusServer.ts` の `WAVE_RAW_RANGE_MAX_MS`）ので、10 分まで
// 描くにはこちらしか無い。列ごとに上下を取ってあるので、間引いてもピークは消えない。
//
// 文言はどれも 2026-10-06 ユーザー承認（範囲・目盛り・線の名前・残っていないときの文）。

import { readFinite } from './readJson'

/** 始まりの何ミリ秒前から描くか。 */
export const DETAIL_BEFORE_MS = 10_000
/** 終わりの何ミリ秒後まで描くか。 */
export const DETAIL_AFTER_MS = 20_000
/** 描く範囲の上限（`/waves` の列ごとの読み返しの上限と同じ 10 分）。 */
export const DETAIL_MAX_MS = 10 * 60_000

export function detailWindow(r: { readonly startMs: number; readonly endMs: number }): {
  readonly fromMs: number
  readonly toMs: number
} {
  // **先に整数のミリ秒へ丸める。** 問い合わせで両端を別々に丸めると、幅が上限をわずかに越えて断られうる。
  const fromMs = Math.floor(r.startMs - DETAIL_BEFORE_MS)
  return { fromMs, toMs: Math.min(Math.ceil(r.endMs + DETAIL_AFTER_MS), fromMs + DETAIL_MAX_MS) }
}

/**
 * 読み返しの問い合わせ。**時刻と列の数は整数へ丸める** —— ホストは整数でない値を `bad-range` で弾く
 * （`statusServer.ts` の `decimalInt`）。終わりは切り上げて、範囲を狭めない。
 */
export function wavesUrl(stationId: string, fromMs: number, toMs: number, columns: number): string {
  const q = new URLSearchParams({
    station: stationId,
    from: String(Math.floor(fromMs)),
    to: String(Math.ceil(toMs)),
    columns: String(Math.max(1, Math.floor(columns))),
  })
  return `/waves?${q.toString()}`
}

/** 列 1 つぶん（3 成分の下端と上端・gal）。 */
export interface EnvelopeColumnView {
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
}

export interface EnvelopeView {
  readonly fromMs: number
  readonly columnSpanMs: number
  /** **値を持たない列は null**（描く側はそこで線を切る）。 */
  readonly columns: readonly (EnvelopeColumnView | null)[]
  readonly hasAnyValue: boolean
  /**
   * 読めなかった部分があるか（開けたが読めなかったファイル・途中で打ち切ったバイト・開く数の上限で
   * 切った）。**ファイルが無かっただけは含めない** —— その時は記録していないだけで、読めなかったのとは違う。
   */
  readonly partial: boolean
}

/**
 * 3 成分の端を読む。**`null` の成分は「その列にその成分の値が無い」として NaN にする** ——
 * 観測点の合成は、測る向きが 3 方向へ散っていない間、解けない成分だけを欠けにする
 * （`sensorFusion.ts`・2026-10-09 ユーザー承認）。**`null` 以外の読めない値は形が違うとして通さない。**
 */
function readTriple(value: unknown): readonly [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const read = (x: unknown): number | null => (x === null ? Number.NaN : readFinite(x))
  const a = read(value[0])
  const b = read(value[1])
  const c = read(value[2])
  return a === null || b === null || c === null ? null : [a, b, c]
}

/**
 * `GET /waves?columns=` の応答を読む。**1 列でも形が違えば応答ごと読めない（null）** ——
 * 読めない列を欠けた列（null）として描くと、形の食い違いが「届かなかった区間」に化ける。
 */
export function readEnvelope(value: unknown): EnvelopeView | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const fromMs = readFinite(v.fromMs)
  const columnSpanMs = readFinite(v.columnSpanMs)
  if (fromMs === null || columnSpanMs === null || columnSpanMs <= 0 || !Array.isArray(v.columns)) return null
  const columns: (EnvelopeColumnView | null)[] = []
  for (const c of v.columns) {
    if (c === null) {
      columns.push(null)
      continue
    }
    if (typeof c !== 'object') return null
    const min = readTriple((c as Record<string, unknown>).min)
    const max = readTriple((c as Record<string, unknown>).max)
    if (min === null || max === null) return null
    columns.push({ min, max })
  }
  // **欠けを 0 や「打ち切っていない」へ倒さない。** ホストは 3 つとも必ず返す（`buildWaveResponse`）ので、
  // 無ければ形が違う —— 埋めると「読めなかった部分がある」が黙って出なくなる。
  const filesFailed = readFinite(v.filesFailed)
  const skippedBytes = readFinite(v.skippedBytes)
  if (filesFailed === null || skippedBytes === null || typeof v.truncated !== 'boolean') return null
  const partial = filesFailed > 0 || skippedBytes > 0 || v.truncated
  return { fromMs, columnSpanMs, columns, hasAnyValue: v.hasAnyValue === true, partial }
}

/** 波形の下に添える一言。**無ければ null。** */
export function detailNote(e: EnvelopeView): string | null {
  if (!e.hasAnyValue) return 'この区間の波形は残っていない'
  if (e.partial) return '読めなかった部分がある'
  return null
}

/** 目盛りの刻みの候補（秒）。細かい側から。 */
const TICK_STEPS_SEC: readonly number[] = [1, 2, 5, 10, 15, 30, 60, 120, 300]

/**
 * 横軸の目盛り。**始まりからの秒**（`+10s`。前は `-10s`）。刻みは揺れの始まりを起点に揃える ——
 * 時計の秒に揃えると、始まりの位置に目盛りが来ない。
 */
export function detailTicks(
  fromMs: number,
  toMs: number,
  startMs: number,
  maxTicks: number,
): readonly { readonly atMs: number; readonly label: string }[] {
  if (!(toMs > fromMs) || maxTicks < 1) return []
  const spanSec = (toMs - fromMs) / 1000
  const step = TICK_STEPS_SEC.find((s) => spanSec / s <= maxTicks) ?? TICK_STEPS_SEC[TICK_STEPS_SEC.length - 1]
  const stepMs = step * 1000
  const out: { atMs: number; label: string }[] = []
  for (let k = Math.ceil((fromMs - startMs) / stepMs); startMs + k * stepMs <= toMs; k += 1) {
    const sec = k * step
    out.push({ atMs: startMs + k * stepMs, label: sec === 0 ? '0s' : sec > 0 ? `+${sec}s` : `${sec}s` })
  }
  return out
}

/** 縦に引く線。**範囲の外の線は引かない。S・P は拾えたときだけ。** */
export function detailMarkers(
  r: { readonly startMs: number; readonly endMs: number; readonly sMs: number | null; readonly pMs: number | null },
  win: { readonly fromMs: number; readonly toMs: number },
): readonly { readonly atMs: number; readonly label: string }[] {
  const all: { atMs: number | null; label: string }[] = [
    { atMs: r.startMs, label: '始まり' },
    { atMs: r.endMs, label: '終わり' },
    { atMs: r.sMs, label: 'S' },
    { atMs: r.pMs, label: 'P' },
  ]
  return all.flatMap((m) => (m.atMs !== null && m.atMs >= win.fromMs && m.atMs <= win.toMs ? [{ atMs: m.atMs, label: m.label }] : []))
}
