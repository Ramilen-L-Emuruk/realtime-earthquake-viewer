// 地震カードの波形のうち、**どこからどこまでを描くか**を決める。
//
// **取りに行く範囲と描く範囲は分ける。** 読み返しは地震カードの時刻（分の頭）の 60 秒前から 5 分ぶんを広めに取る
// （`services/seismoWaveHistory.ts`）。そのまま描くと、発生前の静かな区間と揺れが収まった後の
// 長い平らな線に、肝心の揺れが埋もれる。
//
// 考え方は「**この地震の揺れが届きうる時間帯**」を走時表から出し、その中で揺れ始めたかを
// 平常時のノイズと比べて判定する。
//
// - **揺れ始めとして認めるのは届きうる時間帯の中だけ。** 前の地震の揺れの残りや、
//   次の地震の揺れを、この地震の窓を決める根拠にしない
// - **平常時のノイズは発生前 30 秒の 1 秒ごとの値の中央値で測る。** 最大値で測ると、
//   直前の地震の揺れの残りでノイズを大きく見積もり、揺れ始めを見落とす
//
// **それでも切り分けられないもの**: 届きうる時間帯が重なる 2 つの地震（同じ分に起きた・
// 震源が近い）と、地震情報に載らない地震の揺れ。波形からは見分けようがない。

import { QUAKE_MINUTE_LEAD_MS, QUAKE_MINUTE_TAIL_MS, type OriginSecondsSource } from './quakeOriginSeconds'
import type { WaveArrival } from './seismoWaveArrival'
import { lastFilledIndex, trimTrailingGap, type TimedColumns } from './seismoWaveColumns'

/** 時間軸の 0 をどこに置くか。**秒まで取れたかで意味が変わる**ので、型で分ける。 */
export type WaveAxisZero =
  /** 発生時刻（秒まで）。目盛りの 0 は「発生」。 */
  | { readonly kind: 'origin'; readonly ms: number; readonly source: OriginSecondsSource }
  /**
   * 地震情報の時刻の分の頭。**発生はこの分の 0〜59 秒のどこか**で、0 は発生を名乗らない
   * （目盛りの 0 には時刻を書く）。
   */
  | { readonly kind: 'minute'; readonly ms: number }

/** 届きうる時間帯（エポックミリ秒の閉区間）。 */
export interface ReachBand {
  readonly fromMs: number
  readonly toMs: number
}

const SECOND_MS = 1000
/** 1 分（ms）。分の頭へ切り捨てる側（`useSeismoQuakeWaves`）と共有する。 */
export const MINUTE_MS = 60_000

/**
 * P 波の到達より前に取る余裕（ms）。**発生時刻の出どころで変える。**
 *
 * - 緊急地震速報: 秒まで発表された値なので、走時表と実際の伝わり方の差だけを見込む（3 秒）。
 *   震源の決まった最後の報と気象庁の震源リストの差は −7.8〜+0.6 秒（58 地震。負は速報が早い）。
 *   速報が早いと計算した P・S の到達も早く出るので、前は広がり、**後ろの余裕（S の 10 秒後）は最大
 *   7.8 秒ぶん削られる**（残り約 2 秒）。後ろは揺れの尾を切る位置にしか効かず、描く範囲は揺れ始めと
 *   静かさの戻りでも決まる（{@link selectQuakeWindow}）ので、ここでは足していない
 * - 長期震源カタログ: 気象庁の震源リストの値（0.01 秒）。走時表との差だけを見込む（3 秒）
 */
const REACH_LEAD_MS: Readonly<Record<OriginSecondsSource, number>> = {
  eew: 3 * SECOND_MS,
  catalog: 3 * SECOND_MS,
}

/** S 波の到達より後に取る余裕（ms）。 */
const REACH_TAIL_MS = 10 * SECOND_MS

/**
 * この地震の揺れが届きうる時間帯を出す。**走時を出せなければ `null`。**
 *
 * @param arrival 時間軸の 0 を起点に解いた P・S の到達（`computeWaveArrival`）。分の頭を
 *   起点に解いた値なら、**実際の発生はその分の頭の {@link QUAKE_MINUTE_LEAD_MS} 前〜
 *   {@link QUAKE_MINUTE_TAIL_MS} 後のどこか**（カードの時刻は地震発現の分で、発生はそれより前へ出うる。
 *   → `utils/quakeOriginSeconds.ts`）なので、同じ幅だけ前後へ広げる。
 */
export function computeReachBand(zero: WaveAxisZero, arrival: WaveArrival | null): ReachBand | null {
  if (arrival === null) return null
  if (!Number.isFinite(arrival.pMs) || !Number.isFinite(arrival.sMs)) return null
  if (zero.kind === 'minute') {
    return { fromMs: arrival.pMs - QUAKE_MINUTE_LEAD_MS, toMs: arrival.sMs + QUAKE_MINUTE_TAIL_MS }
  }
  return { fromMs: arrival.pMs - REACH_LEAD_MS[zero.source], toMs: arrival.sMs + REACH_TAIL_MS }
}

/**
 * 揺れ始めとみなす倍率（平常時のノイズに対して）。**1.3 倍。**
 *
 * **実波形で決めた値**（2026-10-04・自宅の観測点。2026-09-30〜10-04 の有感地震 21 件と、
 * 地震の無い時刻 18 窓）。地震の無い窓の 3 秒値 4230 個のうち、1.3 倍を超えたのは 0.21%。
 * 有感地震で超えたのは震度2〜3 の 5 件で、**震度1 の地震はどれもノイズと見分けが付かない**
 * （この観測点では、弱い揺れは平常時の振れ幅と同じ桁に収まる）。
 *
 * **取り違えても害は小さい。** ノイズを揺れ始めと読んでも、静かさがすぐ戻るので描く範囲は
 * 「時間帯の終わり ＋ 20 秒」へ落ちる（揺れが無いときの ＋ 30 秒とほぼ同じ）。逆に見落とすのは
 * ノイズに埋もれる弱い揺れだけで、長く続く強い揺れは確実に超える。
 */
export const ONSET_RATIO = 1.3

/**
 * 強さをならす長さ（秒）。**3 秒。**
 *
 * **1 秒ごとの最大では見分けられない**（同じ実測で、地震の比の最大 1.93 に対して地震の無い窓が
 * 1.88）。ノイズの尖りが 1 秒の最大へそのまま乗るため。3 秒の平均にすると尖りがならされ、
 * 揺れのように続く振れだけが残る。
 */
const SMOOTH_SECONDS = 3

/**
 * 平常時のノイズの下限（gal）。**中央値がこれを下回ったらこの値で測る。**
 *
 * 記録の欠けや丸めでノイズが 0 近くに測れると、倍率の閾値が 0 へ潰れて何でも揺れに見える。
 *
 * **実際のノイズより十分に下に置く。** 縮んだ測り値を受け止めるための値で、ふだんの判定に効いては
 * いけない。IIS2ICLX を観測点の合成へ入れてから、1 秒ごとの振れの最大の中央値は成分ごとに
 * 0.16〜0.24 gal まで下がった（2026-10-11・10/11 の 7 時刻の実測。入れる前の 10/9 は 0.76〜1.41 gal）。
 * 以前の 0.2 gal はこれに掛かり、揺れ始めの閾値とノイズの帯を実際より広げていた。
 */
export const NOISE_FLOOR_GAL = 0.05

/** ノイズを測る区間の長さ（ms）。**時間軸の 0 の手前 30 秒。** 読み返しの手前の幅（`WAVE_HISTORY_LEAD_MS`）はこれを覆うように決めてある。 */
export const NOISE_SPAN_MS = 30 * SECOND_MS

/** ノイズを測るのに要る 1 秒ぶんの値の数。**足りなければ判定しない**（推測でノイズを置かない）。 */
export const NOISE_MIN_SECONDS = 10

/** 「ノイズの水準へ戻った」とみなす静かさの長さ（ms）。 */
const QUIET_HOLD_MS = 10 * SECOND_MS

/** ノイズの水準へ戻ってから描き足す長さ（ms）。 */
const AFTER_QUIET_MS = 15 * SECOND_MS

/**
 * 揺れの有無に関わらず、少なくとも描く長さ（届きうる時間帯の終わりから・ms）。
 *
 * **揺れがあった場合は 20 秒**（秒まで取れたときは S 波の到達 ＋ 30 秒にあたる）。
 * **揺れが無かった場合は 30 秒** —— 平らな線がそのまま「揺れを記録しなかった」を示す長さ。
 */
const MIN_AFTER_REACH_WITH_ONSET_MS = 20 * SECOND_MS
const MIN_AFTER_REACH_NO_ONSET_MS = 30 * SECOND_MS

/** 描く範囲と、その判定の中身。 */
export interface QuakeWindow {
  /** 描く列（`base` から切り出したもの）。**変わらなければ `base` と同じ参照。** */
  readonly columns: TimedColumns
  /** 時間軸の 0（目盛りの起点）。 */
  readonly zeroMs: number
  /** 揺れ始め（閾値を初めて超えた 3 秒の頭）。**見つからなければ `null`。** */
  readonly onsetMs: number | null
  /**
   * 範囲をどう決めたか。
   *
   * - `onset`: 揺れ始めを見つけた
   * - `no-onset`: 届きうる時間帯に揺れが無かった
   * - `untrimmed`: 判定できなかった（走時が出せない・ノイズを測れない）。**取った範囲をそのまま描く**
   */
  readonly basis: 'onset' | 'no-onset' | 'untrimmed'
  /**
   * 判定できなかった理由（`basis` が `untrimmed` のときだけ）。**描く側が記録へ残すのに使う** ——
   * 絵は取った範囲のまま出るので、画面からは「切れなかった」と「切る必要が無かった」が見分けられない。
   * **複数当てはまるときは、下の順で最初のもの**（判定の順）。
   *
   * - `no-data`: 値のある列が 1 つも無い
   * - `no-reach`: 届きうる時間帯が出せない（震源・深さ・観測点の座標のどれかが判らない）
   * - `no-noise`: 0 の手前の記録が足りず、平常時のノイズを測れない
   */
  readonly untrimmedReason: 'no-data' | 'no-reach' | 'no-noise' | null
}

/**
 * 秒ごとの揺れの強さ。**値の無い秒は `null`。**
 *
 * 1. 列ごとに、3 成分それぞれの振れ幅の半分（`(max − min) / 2`）を取り、いちばん大きい成分を採る
 * 2. 1 秒の箱の中で平均する
 * 3. **その秒から {@link SMOOTH_SECONDS} 秒ぶんを平均する**（そのうち 1 秒でも欠けていれば `null`）
 *
 * **ならした値は窓の頭の秒に置く。** 終わりの秒に置くと、揺れが収まった時刻が窓の長さ
 * ぶん（2 秒）後ろへずれる。頭に置けば「この秒から 3 秒静か」がそのまま読める。
 *
 * **絶対値の最大ではなく振れ幅を使う。** 合成波形は直流を引いた変動分だが、引ききれない
 * ずれが残ると絶対値はそのぶん持ち上がる。振れ幅ならずれに左右されない。
 *
 * 箱は `zeroMs` を基準に 1 秒刻みで切る（`zeroMs + k 秒` が箱の始まり）。
 */
function secondStrengths(
  base: TimedColumns,
  zeroMs: number,
): { readonly firstSecond: number; readonly values: readonly (number | null)[] } {
  const span = base.columnSpanMs
  const last = lastFilledIndex(base.columns)
  if (last < 0 || !(span > 0)) return { firstSecond: 0, values: [] }
  const firstSecond = Math.floor((base.fromMs - zeroMs) / SECOND_MS)
  const sums: number[] = []
  const counts: number[] = []
  for (let i = 0; i <= last; i += 1) {
    const col = base.columns[i]
    if (col === null) continue
    // **列の中点で箱を決める。** 列の幅（実測 225 ms）は 1 秒を割り切らないので、始まりで
    // 決めると境目の列が前の箱へ寄る。
    const mid = base.fromMs + (i + 0.5) * span
    const k = Math.floor((mid - zeroMs) / SECOND_MS) - firstSecond
    if (k < 0) continue
    let swing = 0
    for (let a = 0; a < 3; a += 1) {
      const v = (col.max[a] - col.min[a]) / 2
      if (v > swing) swing = v
    }
    while (sums.length <= k) {
      sums.push(0)
      counts.push(0)
    }
    sums[k] += swing
    counts[k] += 1
  }
  const perSecond = sums.map((s, k) => (counts[k] > 0 ? s / counts[k] : null))
  const values = perSecond.map((_, k) => {
    if (k + SMOOTH_SECONDS > perSecond.length) return null
    let total = 0
    for (let j = 0; j < SMOOTH_SECONDS; j += 1) {
      const v = perSecond[k + j]
      if (v === null) return null
      total += v
    }
    return total / SMOOTH_SECONDS
  })
  return { firstSecond, values }
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** `[fromMs, toMs)` に掛かる列だけを切り出す。**変わらなければ同じ参照。** */
function slice(base: TimedColumns, fromMs: number, toMs: number): TimedColumns {
  const span = base.columnSpanMs
  const start = Math.max(0, Math.floor((fromMs - base.fromMs) / span))
  const end = Math.min(base.columns.length, Math.ceil((toMs - base.fromMs) / span))
  if (start === 0 && end === base.columns.length) return base
  if (end <= start) return { ...base, fromMs: base.fromMs + start * span, columns: [] }
  return { ...base, fromMs: base.fromMs + start * span, columns: base.columns.slice(start, end) }
}

/**
 * 描く範囲を決める。
 *
 * | 場合 | 描く範囲 |
 * |---|---|
 * | 揺れ始めが見つかった | 0 〜 ノイズの水準へ戻ってから 15 秒（少なくとも時間帯の終わり ＋ 20 秒） |
 * | 揺れ始めが見つからない | 0 〜 時間帯の終わり ＋ 30 秒 |
 * | 走時が出せない・ノイズを測れない | 取った範囲をそのまま（末尾の空は切る） |
 *
 * **右端は届いている最新の値で頭打ちにする**（まだ伸びている途中の地震）。
 *
 * @param base 読み返し＋継ぎ足しの列。**次の地震の発生時刻で既に切ってある**（`trimAfter`）
 * @param reach 届きうる時間帯（{@link computeReachBand}）
 * @param noiseFloor 平常時のノイズの下限（列の単位で）。自作地震計は {@link NOISE_FLOOR_GAL}、公開観測点は速度の単位の値
 *   （`components/SeismoWaveChart/waveUnit.ts` の `quietMinLevel`）。**単位の違う列へ gal の下限を当てると、
 *   静かな広帯域地震計では閾値が実際のノイズより何桁も上に張り付く。**
 */
export function selectQuakeWindow(params: {
  readonly base: TimedColumns
  readonly zero: WaveAxisZero
  readonly reach: ReachBand | null
  readonly noiseFloor: number
}): QuakeWindow {
  const { zero, reach } = params
  // **先に末尾の空を切る。** 要求した窓の右端はまだ来ていない時刻を含むので、どの経路でも
  // 「値のある最後の列」より右は描かない（P/S の線が過去の区間にしか引かれない保証もこれ。
  // → `docs/forecast-computation-audit.md`）。
  const base = trimTrailingGap(params.base)
  const span = base.columnSpanMs
  const last = base.columns.length - 1
  const untrimmed = (reason: NonNullable<QuakeWindow['untrimmedReason']>): QuakeWindow => ({
    columns: base,
    zeroMs: zero.ms,
    onsetMs: null,
    basis: 'untrimmed',
    untrimmedReason: reason,
  })
  if (last < 0 || !(span > 0)) return untrimmed('no-data')
  if (reach === null) return untrimmed('no-reach')
  const dataEndMs = base.fromMs + (last + 1) * span

  const { firstSecond, values } = secondStrengths(base, zero.ms)
  const atSecond = (sec: number): number | null => values[sec - firstSecond] ?? null

  // **平常時のノイズ。** 0 の手前 30 秒の中央値。
  const noiseSamples: number[] = []
  for (let sec = -NOISE_SPAN_MS / SECOND_MS; sec < 0; sec += 1) {
    const v = atSecond(sec)
    if (v !== null) noiseSamples.push(v)
  }
  if (noiseSamples.length < NOISE_MIN_SECONDS) return untrimmed('no-noise')
  const threshold = Math.max(median(noiseSamples), params.noiseFloor) * ONSET_RATIO

  // **揺れ始め。** 届きうる時間帯に掛かる秒だけを見る。**0 より手前は見ない** —— 分までしか無い地震では
  // 時間帯が 0 の手前へ広がる（発生が分の頭より前へ出うる）が、そこはノイズを測った区間でもあり、
  // 前の地震の揺れの残りを揺れ始めと取り違える。
  const reachFirst = Math.max(0, Math.floor((reach.fromMs - zero.ms) / SECOND_MS))
  const reachLast = Math.floor((reach.toMs - zero.ms) / SECOND_MS)
  let onsetSec: number | null = null
  for (let sec = reachFirst; sec <= reachLast; sec += 1) {
    const v = atSecond(sec)
    if (v !== null && v >= threshold) {
      onsetSec = sec
      break
    }
  }

  const fromMs = Math.max(zero.ms, base.fromMs)
  if (onsetSec === null) {
    const toMs = Math.min(reach.toMs + MIN_AFTER_REACH_NO_ONSET_MS, dataEndMs)
    return { columns: slice(base, fromMs, toMs), zeroMs: zero.ms, onsetMs: null, basis: 'no-onset', untrimmedReason: null }
  }

  // **ノイズの水準へ戻った時刻。** 閾値を下回る秒が `QUIET_HOLD_MS` 続いた最初の秒。
  // **値の無い秒は静かと見なさない**（届いていないだけで、揺れていないことの証明ではない）。
  const holdSeconds = QUIET_HOLD_MS / SECOND_MS
  const lastSec = firstSecond + values.length - 1
  let quietSec: number | null = null
  let run = 0
  for (let sec = onsetSec + 1; sec <= lastSec; sec += 1) {
    const v = atSecond(sec)
    if (v !== null && v < threshold) {
      run += 1
      if (run >= holdSeconds) {
        quietSec = sec - holdSeconds + 1
        break
      }
    } else {
      run = 0
    }
  }
  const minToMs = reach.toMs + MIN_AFTER_REACH_WITH_ONSET_MS
  // **まだ戻っていなければ最新まで描く**（揺れの最中・伸びている途中）。
  const quietToMs = quietSec === null ? dataEndMs : zero.ms + quietSec * SECOND_MS + AFTER_QUIET_MS
  const toMs = Math.min(Math.max(quietToMs, minToMs), dataEndMs)
  return {
    columns: slice(base, fromMs, toMs),
    zeroMs: zero.ms,
    onsetMs: zero.ms + onsetSec * SECOND_MS,
    basis: 'onset',
    untrimmedReason: null,
  }
}

/**
 * 列が覆う区間（左端〜右端）。**列が 1 つも無ければ `null`。**
 *
 * **震度を訊く区間と、描いた区間を突き合わせる物差し。** 訊く側（`useSeismoQuakeWaves`）と
 * 描く側（`QuakeSeismoWave`）が同じ {@link selectQuakeWindow} の結果をこれへ通すので、
 * どちらかだけ別の式で区間を書くと、出した震度が描いた絵と別の区間の値になる。
 */
export function columnsSpan(columns: TimedColumns): { readonly fromMs: number; readonly toMs: number } | null {
  const n = columns.columns.length
  if (n === 0 || !(columns.columnSpanMs > 0) || !Number.isFinite(columns.fromMs)) return null
  return { fromMs: columns.fromMs, toMs: columns.fromMs + n * columns.columnSpanMs }
}

/**
 * 0 の手前 30 秒の**静かさの物差し**（gal）。**測れなければ `null`。**
 *
 * 成分ごとに「1 秒ごとの、中心からの振れの最大」の中央値を取り、
 * **3 成分のうち最大**を返す。縦の幅の下限はこれに倍率を掛けて決める（→ `seismoQuietScale.ts`）。
 *
 * **値の無い成分は外して測る**。上を解けない観測点でも、
 * 水平の 2 成分で静かさは測れる —— 揃うまで待つと、その観測点の絵は下限が決まらず決め打ちの値へ戻る。
 * **1 成分も測れなければ `null`。**
 */
export function measureQuietLevel(base: TimedColumns, zeroMs: number): number | null {
  const quiet = quietPeaksBeforeZero(base, zeroMs)
  if (quiet === null) return null
  let level: number | null = null
  for (const m of quiet.peaks) {
    if (m.size < NOISE_MIN_SECONDS) continue
    const v = median([...m.values()])
    if (level === null || v > level) level = v
  }
  return level
}

/**
 * 0 の手前 30 秒から、成分ごとの中心と「1 秒ごとの、中心からの振れの最大」を集める。
 * **列が 1 つも無ければ `null`。**
 */
function quietPeaksBeforeZero(
  base: TimedColumns,
  zeroMs: number,
): { readonly center: readonly [number, number, number]; readonly peaks: readonly Map<number, number>[] } | null {
  const span = base.columnSpanMs
  if (!(span > 0) || !Number.isFinite(zeroMs)) return null
  const fromMs = zeroMs - NOISE_SPAN_MS
  const picked: { readonly second: number; readonly min: readonly number[]; readonly max: readonly number[] }[] = []
  const centers: number[][] = [[], [], []]
  base.columns.forEach((col, i) => {
    if (col === null) return
    const mid = base.fromMs + (i + 0.5) * span
    if (mid < fromMs || mid >= zeroMs) return
    picked.push({ second: Math.floor((mid - zeroMs) / SECOND_MS), min: col.min, max: col.max })
    // **値の無い成分（`NaN`）は混ぜない。** 観測点の合成が解けなかった成分は `NaN` で届く —— 混ぜると中央値が壊れる。
    for (let a = 0; a < 3; a += 1) {
      const center = (col.min[a] + col.max[a]) / 2
      if (Number.isFinite(center)) centers[a].push(center)
    }
  })
  if (picked.length === 0) return null
  const center = [median(centers[0]), median(centers[1]), median(centers[2])] as const
  const peaks: Map<number, number>[] = [new Map(), new Map(), new Map()]
  for (const p of picked) {
    for (let a = 0; a < 3; a += 1) {
      const v = Math.max(Math.abs(p.max[a] - center[a]), Math.abs(p.min[a] - center[a]))
      if (!Number.isFinite(v)) continue
      peaks[a].set(p.second, Math.max(peaks[a].get(p.second) ?? 0, v))
    }
  }
  return { center, peaks }
}
