// 波形を描くための当て方。**Canvas に触らない部分だけをここへ置く。**
//
// 目盛りの刻みの選び方・縦の幅の丸め方・値の桁は、絵を見ただけでは正しさを確かめにくい
// （「なんとなく読める」で通ってしまう）。分けておけば、境目の振る舞いを試せる。

/** 時間軸の目盛りの刻みの候補（ミリ秒）。**細かい側から並べる。** */
const TIME_STEPS_MS: readonly number[] = [
  100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
]

/**
 * 縦の半幅の下限（gal）。
 *
 * **静かなときに目盛りが 0 へ潰れないため。** 揺れていない窓では平均からの隔たりが
 * ほぼ 0 になり、そのまま半幅にすると**ノイズが画面いっぱいに描かれる** ——
 * 静かなことと揺れていることが、絵で見分けられなくなる。
 */
const MIN_HALF_SPAN_GAL = 1

/**
 * センサーを重ねたときの色。
 *
 * **明るさを揃えつつ色相を離す。** 明暗の地（`color-scheme: light dark`）どちらでも
 * 読めることを優先し、薄い色は入れない。
 */
export const SENSOR_COLORS: readonly string[] = [
  '#2563a8',
  '#b3261e',
  '#1e8e3e',
  '#8a5a00',
  '#7b3fa0',
  '#00808a',
  '#a0286b',
  '#4a5a20',
]

/** 何本目のセンサーかで色を決める。**本数が色数を超えたら巡回する。** */
export function colorForIndex(index: number): string {
  // 負の添字でも壊さない（並びの作り方が変わったときに色だけで落ちる理由が無い）。
  const at = ((index % SENSOR_COLORS.length) + SENSOR_COLORS.length) % SENSOR_COLORS.length
  return SENSOR_COLORS[at]
}

/**
 * 縦の半幅を、切りのいい値へ上向きに丸める。
 *
 * **上向きに丸める。** 下向きだと、いちばん大きい山が枠の外へ出る。
 */
export function niceHalfSpanGal(maxDeviationGal: number): number {
  if (!Number.isFinite(maxDeviationGal) || maxDeviationGal <= MIN_HALF_SPAN_GAL) {
    return MIN_HALF_SPAN_GAL
  }
  const exponent = Math.floor(Math.log10(maxDeviationGal))
  const base = Math.pow(10, exponent)
  for (const step of [1, 2, 5]) {
    if (maxDeviationGal <= step * base) return step * base
  }
  return 10 * base
}

/**
 * 時間軸の目盛りの位置（unix ミリ秒）。
 *
 * **刻みの倍数へ揃える。** 窓の端から等間隔に置くと、少しスクロールするだけで
 * 数字が全部動き、目で追えなくなる。
 */
export function timeTicks(fromMs: number, toMs: number, maxTicks: number): readonly number[] {
  if (!(toMs > fromMs) || maxTicks < 1) return []
  const span = toMs - fromMs
  const step = TIME_STEPS_MS.find((s) => span / s <= maxTicks) ?? TIME_STEPS_MS[TIME_STEPS_MS.length - 1]
  const ticks: number[] = []
  // **`Math.ceil` で窓の中の最初の倍数から始める。**
  for (let at = Math.ceil(fromMs / step) * step; at <= toMs; at += step) ticks.push(at)
  return ticks
}

/** 時刻を `hh:mm:ss`（窓が短いときは小数第 1 位まで）で。 */
export function formatClock(atMs: number, withTenths: boolean): string {
  if (!Number.isFinite(atMs)) return '—'
  const at = new Date(atMs)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  const ss = String(at.getSeconds()).padStart(2, '0')
  if (!withTenths) return `${hh}:${mm}:${ss}`
  return `${hh}:${mm}:${ss}.${Math.floor(at.getMilliseconds() / 100)}`
}

/**
 * gal の桁。**大きいほど桁を落とす。**
 *
 * 重力が乗った軸は 980 付近になるので、小数を 2 桁出しても読む意味が無い。
 */
export function formatGal(gal: number | null): string {
  if (gal === null || !Number.isFinite(gal)) return '—'
  const magnitude = Math.abs(gal)
  if (magnitude >= 100) return gal.toFixed(0)
  if (magnitude >= 10) return gal.toFixed(1)
  return gal.toFixed(2)
}

/** 窓の長さから、時刻に小数を付けるかを決める。**1 秒あたり 1 目盛りより細かいなら付ける。** */
export function needsTenths(spanMs: number): boolean {
  return spanMs < 10_000
}
