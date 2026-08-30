// 長期震源カタログを点群として描くための変換。**描画も取得もここには無い**（純粋な計算だけ）。
//
// カタログの読み込みは utils/hypocenterCatalog.ts、描画は components/Map/HypocenterCatalogGL.tsx。
// 背景と判断は docs/spec/data-sources-spec.md §6「長期震源カタログ」。
import type { HypocenterIndex, HypocenterYear } from './hypocenterCatalog'
import { completeMinMagnitude } from './hypocenterCatalog'
import type { DepthPointColumns } from '../components/Map/gl/depthPointLayer'

/**
 * 絞り込みを変えてから点群を作り直すまでの待ち（ミリ秒）。
 *
 * スライダーを掴んでいる間は毎フレーム値が飛んでくる。全期間（約 102 万点）では 1 回の
 * 組み立てが 16ms（最悪 45ms）、GPU バッファの転送が 52ms かかるため、素直に繋ぐと引っかかる。
 * **つまみと数値のラベルはこの待ちを経ずに動く。** 遅らせるのは点群の作り直しだけ。
 */
export const CATALOG_REBUILD_DEBOUNCE_MS = 150

/** 点の色を何で決めるか。 */
export type CatalogColorBy = 'depth' | 'magnitude' | 'time'

/** 点の大きさを何で決めるか。 */
export type CatalogSizeBy = 'fixed' | 'magnitude'

/** 表示する範囲。年は両端を含む。 */
export interface CatalogFilter {
  fromYear: number
  toYear: number
  /** マグニチュードの下限（この値を含む）。 */
  minMagnitude: number
  /** 深さの範囲（km・両端を含む）。 */
  minDepthKm: number
  maxDepthKm: number
}

/** 見せ方。 */
export interface CatalogViewOptions {
  colorBy: CatalogColorBy
  sizeBy: CatalogSizeBy
  /** 点の直径（CSS px）。`sizeBy` が `'magnitude'` のときは倍率が掛かる前の基準。 */
  sizePx: number
}

/**
 * 描画用の列と、クリックされた点を説明するための元の値。
 *
 * **添字は全部そろえてある。** `pick` が返す番号でそのまま引ける。
 */
export interface CatalogPointCloud {
  columns: DepthPointColumns
  /** 発生時刻（UTC epoch ミリ秒）。 */
  timeMs: Float64Array
  /** マグニチュード。 */
  magnitude: Float32Array
}

/** 色の段。位置（0〜1）と RGB（0〜1）。 */
type Ramp = readonly (readonly [number, number, number, number])[]

/**
 * 深さの色。**浅いほど暖色**——地震学の図でこの向きが定着しており、逆にすると読み違えられる。
 * 段の位置は下の `DEPTH_RAMP_MAX_KM` に対する割合。
 */
const DEPTH_RAMP: Ramp = [
  [0.0, 0.94, 0.26, 0.21],
  [0.08, 0.98, 0.55, 0.15],
  [0.2, 0.96, 0.85, 0.25],
  [0.4, 0.35, 0.78, 0.45],
  [0.7, 0.2, 0.55, 0.9],
  [1.0, 0.45, 0.3, 0.75],
]

/**
 * 深さの色が飽和する値（km）。
 *
 * **等間隔ではなく浅い側へ寄せてある。** 地震の大半は 30km より浅く、線形に配ると内陸の地震が
 * すべて同じ色になる。段の位置（0.08 = 56km, 0.2 = 140km）が浅い側に密なのはそのため。
 */
export const DEPTH_RAMP_MAX_KM = 700

/** マグニチュードの色。小さいほど寒色。 */
const MAGNITUDE_RAMP: Ramp = [
  [0.0, 0.35, 0.6, 0.95],
  [0.35, 0.35, 0.85, 0.6],
  [0.6, 0.95, 0.85, 0.3],
  [0.8, 0.97, 0.5, 0.2],
  [1.0, 0.9, 0.15, 0.3],
]

/** マグニチュードの色が飽和する範囲。 */
export const MAGNITUDE_RAMP_RANGE = { min: 2, max: 8 } as const

/** 発生年の色。古いほど暗く沈む。 */
const TIME_RAMP: Ramp = [
  [0.0, 0.25, 0.3, 0.45],
  [0.5, 0.4, 0.6, 0.75],
  [1.0, 0.95, 0.95, 0.7],
]

/**
 * 色の段を引く。位置は 0〜1 に丸める。
 *
 * **段は位置の昇順であること**を前提にしている（定数なので単体テストで固定する）。
 */
export function sampleRamp(ramp: Ramp, t: number): [number, number, number] {
  // **比較の向きに意味がある。** `t <= 0 ? 0 : t >= 1 ? 1 : t` と書くと NaN がどちらの比較でも
  // 偽になって素通りし、色が丸ごと NaN になる（点が消える）。真のときだけ通す形にして、
  // NaN は下端へ倒す。
  const x = t > 0 ? (t < 1 ? t : 1) : 0
  for (let i = 1; i < ramp.length; i++) {
    const [p1, r1, g1, b1] = ramp[i]
    if (x > p1) continue
    const [p0, r0, g0, b0] = ramp[i - 1]
    const span = p1 - p0
    const k = span > 0 ? (x - p0) / span : 0
    return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k]
  }
  const last = ramp[ramp.length - 1]
  return [last[1], last[2], last[3]]
}

/**
 * 深さから色の位置（0〜1）へ。**平方根で寄せている**（理由は `DEPTH_RAMP_MAX_KM`）。
 */
export function depthRampT(depthKm: number): number {
  const d = depthKm > 0 ? depthKm : 0
  return Math.sqrt(Math.min(d, DEPTH_RAMP_MAX_KM) / DEPTH_RAMP_MAX_KM)
}

/**
 * 点の直径（CSS px）。
 *
 * **マグニチュードには線形に効かせる。** エネルギーは M が 1 増えるごとに約 32 倍なので、M2 と M9 では
 * 300 億倍を超える。面積に見立てて直径へ落としても 18 万倍で、図として成立しない。「大きいほど目立つ」
 * という順序だけを保てばよい。
 */
export function pointSizePx(basePx: number, magnitude: number, sizeBy: CatalogSizeBy): number {
  if (sizeBy === 'fixed') return basePx
  const m = Number.isFinite(magnitude) ? magnitude : MAGNITUDE_RAMP_RANGE.min
  const scale = 0.5 + 0.35 * (m - MAGNITUDE_RAMP_RANGE.min)
  return basePx * (scale < 0.35 ? 0.35 : scale > 3.5 ? 3.5 : scale)
}

/** その期間・その下限で、取りこぼしがあるかどうか。 */
export interface CatalogCompleteness {
  /** その期間で取りこぼしが無い M の下限。 */
  completeMin: number
  /** いま選んでいる下限がそれを下回っているか（下回っていれば古い期間ほど薄くなる）。 */
  belowComplete: boolean
}

/**
 * 期間の最も古い年を返す。
 *
 * **`fromYear` をそのまま使ってはならない。** 「開始」と「終了」は別々に選べるので、新しい年を
 * 開始に、古い年を終了に置くことができる。年ファイルの取得（`yearsInRange`）は両端を正規化して
 * いるため、そのとき実際に読むのは古い側からになる。完全性の判定だけが `fromYear` を見ていると、
 * **読んでいない年を基準に「網羅している」と答える**（例: 開始 2020・終了 1960 で M2.0 と答える）。
 */
export function oldestYearOf(filter: Pick<CatalogFilter, 'fromYear' | 'toYear'>): number {
  return Math.min(filter.fromYear, filter.toYear)
}

/**
 * 選んだ期間に対する完全性を返す。
 *
 * **判定に使うのは期間の最も古い年。** カタログは古い時代ほど観測網が疎で、同じ M でも取りこぼす。
 * 期間の新しい側で完全でも、古い側が欠けていれば「昔は地震が少なかった」という嘘になる。
 */
export function catalogCompleteness(
  index: HypocenterIndex,
  filter: CatalogFilter,
): CatalogCompleteness {
  const completeMin = completeMinMagnitude(index, oldestYearOf(filter))
  return { completeMin, belowComplete: filter.minMagnitude < completeMin }
}

/**
 * 収録されている年のうち、指定した範囲に入るものを昇順で返す。
 *
 * **索引に無い年は落とす。** 範囲の指定だけで年ファイルを取りに行くと、存在しない年で 404 になる。
 */
export function yearsInRange(index: HypocenterIndex, fromYear: number, toYear: number): number[] {
  const lo = Math.min(fromYear, toYear)
  const hi = Math.max(fromYear, toYear)
  return index.years.filter((y) => y >= lo && y <= hi)
}

/**
 * 取得できなかった年を「1990〜1992, 1995」のように詰めて書く。
 *
 * **並んだ年を 1 つずつ挙げない。** 通信が不調なときは連続した年がまとめて落ちるので、
 * 素朴に並べると 100 個の数字が出て読めなくなる。
 */
export function formatMissingYears(years: readonly number[]): string {
  if (years.length === 0) return ''
  const runs: [number, number][] = []
  for (const y of years) {
    const last = runs[runs.length - 1]
    if (last && y === last[1] + 1) last[1] = y
    else runs.push([y, y])
  }
  return runs.map(([a, b]) => (a === b ? String(a) : `${a}〜${b}`)).join(', ')
}

/** 絞り込みに残るかどうか。**取り込みと件数の見積もりで同じ述語を使う**ため切り出してある。 */
function passes(
  magnitude: number,
  depthKm: number,
  minMagnitude: number,
  minDepthKm: number,
  maxDepthKm: number,
): boolean {
  if (!(magnitude >= minMagnitude)) return false
  return depthKm >= minDepthKm && depthKm <= maxDepthKm
}

/**
 * 年ごとのデータを 1 本の点群へまとめる。
 *
 * **2 周する。** 1 周目で残る件数を数え、2 周目で詰める。伸ばしながら足すと、27 万点規模で
 * 配列の作り直しが何度も走る。
 *
 * `years` の順序はそのまま点の順序になる（呼び出し側は昇順で渡すこと）。
 */
export function buildCatalogPointCloud(
  years: readonly HypocenterYear[],
  filter: CatalogFilter,
  options: CatalogViewOptions,
): CatalogPointCloud {
  const { minMagnitude, minDepthKm, maxDepthKm } = filter
  // 1 周目。件数と、発生年で色を付けるときの分母を同時に取る。
  // **分母は絞り込みに残った点だけで測る。** 年ファイルの端で測ると、深さや M で絞った結果
  // 実際には狭い範囲しか残っていないときに、色が 1 段ぶんしか出ない。
  let count = 0
  let timeLo = Infinity
  let timeHi = -Infinity
  for (const y of years) {
    for (let i = 0; i < y.count; i++) {
      if (!passes(y.magnitude[i], y.depth[i], minMagnitude, minDepthKm, maxDepthKm)) continue
      count++
      const t = y.timeMs[i]
      if (t < timeLo) timeLo = t
      if (t > timeHi) timeHi = t
    }
  }
  const timeSpan = count > 0 ? timeHi - timeLo : 0

  const lng = new Float64Array(count)
  const lat = new Float64Array(count)
  const depthKm = new Float32Array(count)
  const magnitude = new Float32Array(count)
  const timeMs = new Float64Array(count)
  const color = new Float32Array(count * 3)
  const sizePx = new Float32Array(count)

  let k = 0
  for (const y of years) {
    for (let i = 0; i < y.count; i++) {
      const m = y.magnitude[i]
      const d = y.depth[i]
      if (!passes(m, d, minMagnitude, minDepthKm, maxDepthKm)) continue
      lng[k] = y.lng[i]
      lat[k] = y.lat[i]
      depthKm[k] = d
      magnitude[k] = m
      timeMs[k] = y.timeMs[i]
      const [r, g, b] =
        options.colorBy === 'depth'
          ? sampleRamp(DEPTH_RAMP, depthRampT(d))
          : options.colorBy === 'magnitude'
            ? sampleRamp(
                MAGNITUDE_RAMP,
                (m - MAGNITUDE_RAMP_RANGE.min) / (MAGNITUDE_RAMP_RANGE.max - MAGNITUDE_RAMP_RANGE.min),
              )
            : sampleRamp(TIME_RAMP, timeSpan > 0 ? (y.timeMs[i] - timeLo) / timeSpan : 1)
      const c = k * 3
      color[c] = r
      color[c + 1] = g
      color[c + 2] = b
      sizePx[k] = pointSizePx(options.sizePx, m, options.sizeBy)
      k++
    }
  }

  return {
    columns: { count, lng, lat, depthKm, color, sizePx, shape: 'circle' },
    timeMs,
    magnitude,
  }
}
