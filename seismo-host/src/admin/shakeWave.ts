// 揺れの記録タブで、押した行の区間の波形を描くための当て方（DOM・Canvas に触らない部分）。
//
// **読み返すのは列ごとの上下の端**（`GET /waves?columns=`。`receiver/waveEnvelope.ts`）。サンプルの
// まま返す形は 2 分までしか取れない（`statusServer.ts` の `WAVE_RAW_RANGE_MAX_MS`）ので、10 分まで
// 描くにはこちらしか無い。列ごとに上下を取ってあるので、間引いてもピークは消えない。
//
// 文言はどれも 2026-10-06 ユーザー承認（範囲・目盛り・線の名前・残っていないときの文）。

import { readFinite } from './readJson'
import { QUAKE_OFF_TEXT, quakeFailedDaysText, type QuakeMarkView, type QuakesView } from './recordsMarks'

/** 始まりの何ミリ秒前から描くか。 */
export const DETAIL_BEFORE_MS = 10_000
/** 終わりの何ミリ秒後まで描くか。 */
export const DETAIL_AFTER_MS = 20_000
/** 描く範囲の上限（`/waves` の列ごとの読み返しの上限と同じ 10 分）。 */
export const DETAIL_MAX_MS = 10 * 60_000

/** 気象庁の P より前に取る余裕（ms）。 */
export const DETAIL_BEFORE_JMA_P_MS = 5_000
/** 気象庁の P に合わせて左端を広げる上限（始まりの何ミリ秒前まで）。**60 秒**（S−P 60 秒はおよそ 500 km）。 */
export const DETAIL_BEFORE_MAX_MS = 60_000

/**
 * 詳細に描く範囲。**照合した地震の気象庁 P が始まりの 10 秒前より前なら、左端をその P の 5 秒前まで広げる**
 * （始まりの 60 秒前が上限）—— 揺れの始まりは S で引き金が引かれることが多く、P は S−P 時間ぶん前に来る。
 * 10 秒前で切ったままだと、引いた気象庁 P が範囲の外に落ちて描かれない（2026-10-15 ユーザー承認「進めて」の範囲）。
 *
 * **広げても、終わりの 20 秒後は 10 分の上限で削らない**（削るのは広げる幅のほう）。揺れそのものが主で、
 * 気象庁 P は添え物。揺れが 10 分より長いときだけは、これまでどおり始まりの 10 秒前から 10 分で切る。
 */
export function detailWindow(
  r: { readonly startMs: number; readonly endMs: number },
  jma: Pick<QuakeMarkView, 'p'> | null = null,
): {
  readonly fromMs: number
  readonly toMs: number
} {
  const jmaFrom = jma?.p == null ? Number.POSITIVE_INFINITY : jma.p.fromMs - DETAIL_BEFORE_JMA_P_MS
  const baseFrom = r.startMs - DETAIL_BEFORE_MS
  const wantedTo = Math.ceil(r.endMs + DETAIL_AFTER_MS)
  // 広げる先は、始まりの 60 秒前と、終わりの 20 秒後から 10 分さかのぼった所の遅いほうまで。
  const widenFloor = Math.max(r.startMs - DETAIL_BEFORE_MAX_MS, wantedTo - DETAIL_MAX_MS)
  const leftMs = Math.min(baseFrom, Math.max(widenFloor, jmaFrom))
  // **先に整数のミリ秒へ丸める。** 問い合わせで両端を別々に丸めると、幅が上限をわずかに越えて断られうる。
  const fromMs = Math.floor(leftMs)
  return { fromMs, toMs: Math.min(wantedTo, fromMs + DETAIL_MAX_MS) }
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

/**
 * 記録が持つ縦の線（始まり・終わり・波形から拾った S・P）。**範囲の外の線は引かない。S・P は拾えたときだけ。**
 *
 * 拾った S・P は「拾った」を名乗る —— 照合した地震から計算した「気象庁 P」「気象庁 S」（{@link jmaArrivalMarks}）と
 * 同じ絵に並ぶので、名前が同じだと別の量に見えない（2026-10-15 ユーザー承認）。
 */
export function detailMarkers(
  r: { readonly startMs: number; readonly endMs: number; readonly sMs: number | null; readonly pMs: number | null },
  win: { readonly fromMs: number; readonly toMs: number },
): readonly { readonly atMs: number; readonly label: string }[] {
  const all: { atMs: number | null; label: string }[] = [
    { atMs: r.startMs, label: '始まり' },
    { atMs: r.endMs, label: '終わり' },
    { atMs: r.sMs, label: '拾った S' },
    { atMs: r.pMs, label: '拾った P' },
  ]
  return all.flatMap((m) => (m.atMs !== null && m.atMs >= win.fromMs && m.atMs <= win.toMs ? [{ atMs: m.atMs, label: m.label }] : []))
}

/** 照合したときの地震（記録が持っている分）。 */
export interface MatchedQuakeRef {
  readonly name: string
  readonly originMs: number | null
  readonly originPrecisionMs: number | null
}

/**
 * 地震一覧の発生時刻を照合したときの発生時刻と結ぶ余白（ミリ秒）。**ホストが秒を補う幅と同じ 60 秒**
 * （`detection/quakeRefine.ts` の `REFINE_TIME_MARGIN_MS`）—— 一覧の発生時刻は震源リスト・緊急地震速報で秒まで
 * 寄せてあり、照合したときの分の値からその幅まで動きうる。
 */
const MATCH_MARGIN_MS = 60_000

/**
 * 記録が照合した地震を、波形の記録と同じ地震一覧（`GET /api/records/quakes`）から引き当てる。**決まらなければ null。**
 *
 * 名前が同じで、発生時刻が照合したときの分の幅（＋前後 60 秒）に入るもの。複数あれば、**分の幅までの隔たり**が
 * 小さいほう（幅の中にあるものは隔たり 0 で、幅の外のものより先に選ばれる）。
 * **照合したときの発生時刻を持たない記録は、名前の合うものがちょうど 1 つのときだけ**（取り違えると線が数十秒ずれ、
 * 「その揺れはこの地震ではない」と読ませてしまう）。
 */
export function findMatchedQuake(quakes: readonly QuakeMarkView[], m: MatchedQuakeRef): QuakeMarkView | null {
  const named = quakes.filter((q) => q.name === m.name)
  if (m.originMs === null) return named.length === 1 ? named[0]! : null
  const from = m.originMs - MATCH_MARGIN_MS
  const to = m.originMs + (m.originPrecisionMs ?? 0) + MATCH_MARGIN_MS
  const near = named.filter((q) => q.originMs >= from && q.originMs <= to)
  if (near.length === 0) return null
  const spanFrom = m.originMs
  const spanTo = m.originMs + (m.originPrecisionMs ?? 0)
  const gap = (q: QuakeMarkView): number => Math.max(0, spanFrom - q.originMs, q.originMs - spanTo)
  return near.reduce((best, q) => (gap(q) < gap(best) ? q : best))
}

/** 気象庁の P・S の印 1 つ。**秒まで分かれば線（`fromMs === toMs` 相当）、幅があれば帯。** */
export interface JmaArrivalMark {
  readonly phase: 'P' | 'S'
  readonly label: string
  readonly fromMs: number
  readonly toMs: number
}

/**
 * 照合した地震から計算した P・S（ホストが JMA2001 走時表で解いた幅）を、詳細に引く印へ落とす。
 * **範囲と重ならない印は出さない。** 幅が 1 秒以下なら線として扱う（波形の記録の `arrivalMark` と同じ境）。
 */
export function jmaArrivalMarks(q: QuakeMarkView, win: { readonly fromMs: number; readonly toMs: number }): readonly JmaArrivalMark[] {
  const out: JmaArrivalMark[] = []
  for (const [phase, span] of [
    ['P', q.p],
    ['S', q.s],
  ] as const) {
    if (span === null || span.toMs < win.fromMs || span.fromMs > win.toMs) continue
    const line = span.toMs - span.fromMs <= 1000
    const mid = (span.fromMs + span.toMs) / 2
    out.push({ phase, label: `気象庁 ${phase}`, fromMs: line ? mid : span.fromMs, toMs: line ? mid : span.toMs })
  }
  return out
}

/** 気象庁の P・S が引けたときに添える説明（波形の記録の凡例 `QUAKE_LEGEND` の言い回しに揃えた。2026-10-15 ユーザー承認）。 */
export const JMA_ARRIVAL_LEGEND =
  '気象庁: 破線 = この観測点に P・S が届く時刻（JMA2001 走時表）・帯 = 発生時刻が分までしか分からず、届く時刻に幅があるもの。灰の破線 = 波形から拾った P・S'
/** 照合した地震が一覧に見つからないとき（2026-10-15 ユーザー承認）。 */
export const JMA_ARRIVAL_NOT_FOUND_TEXT = '照合した地震が気象庁の地震一覧に見つからないので、気象庁の P・S の線は引けない'
/** 観測点の位置が分からないとき（2026-10-15 ユーザー承認）。 */
export const JMA_ARRIVAL_UNLOCATED_TEXT = 'この観測点の位置が分からないので、気象庁の P・S の線は引けない'
/**
 * 気象庁の P・S について詳細に添える一行。**照合していない記録は null**（線を引く対象が無い）。
 *
 * - 一覧を取らない設定 → `QUAKE_OFF_TEXT`（波形の記録と同じ文）
 * - 観測点の位置が分からない → {@link JMA_ARRIVAL_UNLOCATED_TEXT}
 * - 一覧に見つからず、取得できなかった日がある → `quakeFailedDaysText`（波形の記録と同じ文。取れなかっただけかも
 *   しれないので「見つからない」と言い切らない。2026-10-15 ユーザー承認）
 * - 一覧に見つからない → {@link JMA_ARRIVAL_NOT_FOUND_TEXT}
 * - 引けた（範囲に掛からなくても） → {@link JMA_ARRIVAL_LEGEND}
 */
export function jmaArrivalNote(quakes: QuakesView, found: QuakeMarkView | null): string {
  if (quakes.off) return QUAKE_OFF_TEXT
  if (!quakes.located) return JMA_ARRIVAL_UNLOCATED_TEXT
  if (found === null) {
    return quakes.failedDays.length > 0 ? quakeFailedDaysText(quakes.failedDays, quakes.problem) : JMA_ARRIVAL_NOT_FOUND_TEXT
  }
  return JMA_ARRIVAL_LEGEND
}

/**
 * 波形の記録をこの区間で開くときに渡す選択（`TabContext.openTab`）。**記録はホストが添えた札で探す**
 * （`viewRecords.ts` の `RECORDS_STATION_KEY_KEY`）—— 観測点 ID で探すと、設定から外した・ID を変えた観測点の
 * 記録を見つけられない。観測点 ID は、見つからなかったときに知らせる一行にだけ使う。
 */
export function recordsSelectionFor(
  record: { readonly stationId: string; readonly stationKey: string },
  win: { readonly fromMs: number; readonly toMs: number },
): Readonly<Record<string, string>> {
  return {
    from: String(Math.round(win.fromMs)),
    station: record.stationId,
    stationKey: record.stationKey,
    to: String(Math.round(win.toMs)),
  }
}
