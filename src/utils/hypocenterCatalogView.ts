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
  /** マグニチュードの範囲（両端を含む）。 */
  minMagnitude: number
  maxMagnitude: number
  /** 深さの範囲（km・両端を含む）。 */
  minDepthKm: number
  maxDepthKm: number
  /** 緯度の範囲（度・両端を含む）。深さと合わせて直方体で切り出す。 */
  minLat: number
  maxLat: number
  /** 経度の範囲（度・両端を含む）。 */
  minLng: number
  maxLng: number
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

/**
 * マグニチュードの絞り込みで選べる範囲。
 *
 * **色の飽和範囲（`MAGNITUDE_RAMP_RANGE`）とは別に持つ。** 「色をどこで飽和させるか」と
 * 「どこまで絞り込めるか」は別の判断で、片方を借りていると、色を調整したつもりで絞り込みの
 * 届く範囲まで一緒に動く。
 *
 * 上端は収録の最大（M9.0・2011 年東北地方太平洋沖）に合わせてある。**上端で取りこぼしは
 * 起きない**——下限の絞り込みなので、上端より大きい地震も残る。
 */
export const MAGNITUDE_FILTER_RANGE = { min: 2, max: 9 } as const

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
 * **マグニチュードには線形に効かせる。マグニチュードが既に対数**なので、これで物理量に対しては
 * 300 億倍を超える。面積に見立てて直径へ落としても 18 万倍で、図として成立しない。「大きいほど目立つ」
 * という順序だけを保てばよい。
 */
export function pointSizePx(basePx: number, magnitude: number, sizeBy: CatalogSizeBy): number {
  if (sizeBy === 'fixed') return basePx
  const m = Number.isFinite(magnitude) ? magnitude : MAGNITUDE_RAMP_RANGE.min
  const scale = EMPHASIS_SLOPE * (m - MAGNITUDE_RAMP_RANGE.min)
  return basePx * (scale < EMPHASIS_MIN ? EMPHASIS_MIN : scale > EMPHASIS_MAX ? EMPHASIS_MAX : scale)
}

/** 強調の傾き。M が 1 増えるごとに直径がこの割合ぶん伸びる（M3 で 0.6 倍・M9 で 4.2 倍）。 */
const EMPHASIS_SLOPE = 0.6
/**
 * 倍率の下限。**0 まで落とさない。** 傾きだけで決めると収録の下限（M2.0）で 0 倍になり、
 * 最も件数の多い地震が 1 つ残らず消える。
 */
const EMPHASIS_MIN = 0.35
/** 倍率の上限。 */
const EMPHASIS_MAX = 5

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
 * 期間の古い側が変わったときに、マグニチュードの下限をその期間の完全性へ合わせる。
 *
 * **手で選んだ下限は捨てない。** 合わせ直してよいのは、前の下限が前の期間の完全性そのもの
 * だったとき——つまりこの関数が置いた値をそのまま持っているときだけ。M6.0 に絞って大きい
 * 地震だけを見ている最中に期間のつまみを少し動かしただけで下限が M2.0 へ戻ると、絞り込みが
 * 無言で解ける（戻った値はちょうど完全性の下限なので、注意書きも出ない）。
 *
 * 手で選ばれていた場合に行うのは**引き上げだけ**。完全性を割る側へ勝手に下げると、記録に
 * 残っていない地震を数えることになる。逆に引き上げたまま据え置かないのは、期間を戻したときに
 * 下限が下がらず「動かして戻しただけなのに件数が減ったまま」になるため（合わせた値であれば
 * 往復できる）。
 *
 * **上限も一緒に見ること。** 下限だけ上げると上限を追い越すことがある——M2.0〜3.0 に絞った
 * まま期間を 1919 年まで広げると、下限が 5.0 になって上限 3.0 を越える。そうなると 1 件も
 * 残らないうえ、**「なぜ 0 件なのか」が画面のどこにも出ない**（完全性の注意書きは
 * 「下限が完全性を割っているか」しか見ないので、この状態では黙っている）。
 *
 * 追い越すなら上限を外す。利用者が選んだ上限は別の下限を前提に選ばれたもので、
 * 新しい下限より下に留め置く意味が無いため。
 *
 * @param prev 変更前の絞り込み。**下限が「合わせた値」か「手で選んだ値」かの判別にだけ使う**
 * @param next 変更後の絞り込み
 */
export function withCompleteMagnitudeFloor(
  index: HypocenterIndex,
  prev: CatalogFilter,
  next: CatalogFilter,
): CatalogFilter {
  const completeMin = completeMinMagnitude(index, oldestYearOf(next))
  // 下限に手が入っていない（`next` が前と同じ値を持つ）うえ、その値が前の期間の完全性と
  // 一致するなら、この関数が置いた値。付け替えてよい。
  const wasAuto =
    next.minMagnitude === prev.minMagnitude &&
    prev.minMagnitude === completeMinMagnitude(index, oldestYearOf(prev))
  const minMagnitude = wasAuto ? completeMin : Math.max(next.minMagnitude, completeMin)
  if (minMagnitude <= next.maxMagnitude) return { ...next, minMagnitude }
  return { ...next, minMagnitude, maxMagnitude: MAGNITUDE_FILTER_RANGE.max }
}

/**
 * 範囲の見出しを 1 つの文にする。
 *
 * **片側だけ制限があるなら、その側だけを書く。** 「M 4.0 以上 〜 制限なし」は読みにくく、
 * 「M 4.0 以上」だけで絞り込みの内容を過不足なく表せる。
 */
export function rangeLabel(minText: string, maxText: string, unlimited = '制限なし'): string {
  if (minText === unlimited && maxText === unlimited) return unlimited
  if (minText === unlimited) return maxText
  if (maxText === unlimited) return minText
  return `${minText} 〜 ${maxText}`
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

/**
 * 深さのつまみが取りうる最大値（km）。**これはスライダーの端であって、地震の深さの上限ではない。**
 *
 * 端に置いたときは「上限なし」として扱う（`effectiveMaxDepthKm`）。端の値で切ると、カタログを
 * 作り直してこれより深い地震が入ったときに**黙って消える**。収録の最深は 698.4km なので、
 * いまは切っても結果は変わらないが、変わらないうちに正しくしておく。
 */
export const DEPTH_FILTER_MAX_KM = DEPTH_RAMP_MAX_KM

/**
 * 端に置いたつまみを「制限なし」へ読み替える。**上下で対称にすること。**
 *
 * 見出しは両端とも「制限なし」と書く（`depthBoundLabel`）。下限だけ 0 のまま比較していると、
 * **深さが負の地震が黙って落ちる**——「制限なし」と表示しながら外すことになる。いまの生成側は
 * 負の深さを作らないので結果は変わらないが、その不変条件はここからは見えない。片方だけ
 * 読み替える形にしておくと、取得元が増えたときに気づけない。
 */
export function effectiveMaxDepthKm(maxDepthKm: number): number {
  return maxDepthKm >= DEPTH_FILTER_MAX_KM ? Infinity : maxDepthKm
}

/**
 * マグニチュードの上端を「制限なし」へ読み替える。
 *
 * **端で切らない。** 収録の最大は M9.0 だが、より大きい地震が入ったときに端で切っていると
 * 黙って消える。深さと同じ扱い。
 */
export function effectiveMaxMagnitude(maxMagnitude: number): number {
  return maxMagnitude >= MAGNITUDE_FILTER_RANGE.max ? Infinity : maxMagnitude
}

/** マグニチュードの範囲の見出し。端は「制限なし」と書く（理由は `depthBoundLabel` と同じ）。 */
export function magnitudeBoundLabel(value: number, bound: 'min' | 'max'): string {
  if (bound === 'min') return value <= MAGNITUDE_FILTER_RANGE.min ? '制限なし' : `M ${value.toFixed(1)} 以上`
  return value >= MAGNITUDE_FILTER_RANGE.max ? '制限なし' : `M ${value.toFixed(1)} 以下`
}

/** 上と対（下限の端は「下限なし」）。 */
export function effectiveMinDepthKm(minDepthKm: number): number {
  return minDepthKm <= 0 ? -Infinity : minDepthKm
}

/**
 * 深さの絞り込みの見出し。
 *
 * **端は「制限なし」と書く。** 「700km 以浅」と出すと、それより深い地震はこのアプリでは
 * 見られないと読めてしまう（実際は端＝制限なしで、全部入っている）。
 */
export function depthBoundLabel(valueKm: number, bound: 'min' | 'max'): string {
  if (bound === 'min') return valueKm <= 0 ? '制限なし' : `${valueKm} km 以深`
  return valueKm >= DEPTH_FILTER_MAX_KM ? '制限なし' : `${valueKm} km 以浅`
}

/**
 * 緯度・経度の絞り込みで選べる範囲（度）。
 *
 * **収録の実測は緯度 17.41〜54.97・経度 114.78〜160.16**（日付変更線はまたがない。西経の地震は 0 件）。
 * それを含む丸い値にしてある。**端は「制限なし」として扱う**ので、これより外の地震が将来入っても、
 * つまみを端に置いているかぎり落ちない。
 */
export const LATITUDE_FILTER_RANGE = { min: 15, max: 56 } as const
export const LONGITUDE_FILTER_RANGE = { min: 110, max: 165 } as const

/** 緯度・経度の端を「制限なし」へ読み替える（深さ・マグニチュードと同じ扱い）。 */
export function effectiveLatRange(minLat: number, maxLat: number): [number, number] {
  return [
    minLat <= LATITUDE_FILTER_RANGE.min ? -Infinity : minLat,
    maxLat >= LATITUDE_FILTER_RANGE.max ? Infinity : maxLat,
  ]
}

export function effectiveLngRange(minLng: number, maxLng: number): [number, number] {
  return [
    minLng <= LONGITUDE_FILTER_RANGE.min ? -Infinity : minLng,
    maxLng >= LONGITUDE_FILTER_RANGE.max ? Infinity : maxLng,
  ]
}

/**
 * 緯度・経度の範囲の見出し。端は「制限なし」と書く（理由は `depthBoundLabel` と同じ）。
 *
 * 向きの語は深さに揃える（深さが「以深／以浅」なので、緯度は「以北／以南」・経度は「以東／以西」）。
 */
export function latBoundLabel(value: number, bound: 'min' | 'max'): string {
  if (bound === 'min') return value <= LATITUDE_FILTER_RANGE.min ? '制限なし' : `北緯 ${value.toFixed(1)}° 以北`
  return value >= LATITUDE_FILTER_RANGE.max ? '制限なし' : `北緯 ${value.toFixed(1)}° 以南`
}

export function lngBoundLabel(value: number, bound: 'min' | 'max'): string {
  if (bound === 'min') return value <= LONGITUDE_FILTER_RANGE.min ? '制限なし' : `東経 ${value.toFixed(1)}° 以東`
  return value >= LONGITUDE_FILTER_RANGE.max ? '制限なし' : `東経 ${value.toFixed(1)}° 以西`
}

/** 絞り込みに残るかどうか。**取り込みと件数の見積もりで同じ述語を使う**ため切り出してある。 */
/**
 * 絞り込みの境界。**端を「制限なし」へ読み替えたあとの値**が入る。
 *
 * 引数を並べずに 1 つのオブジェクトで渡すのは、境界が 5 対 10 個あり、**すべて `number` なので
 * 順序を取り違えても型検査に掛からない**ため（緯度と経度を入れ替えても通ってしまう）。
 */
interface Bounds {
  minMagnitude: number
  maxMagnitude: number
  minDepthKm: number
  maxDepthKm: number
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

/** 絞り込みに残るかどうか。**取り込みと件数の見積もりで同じ述語を使う**ため切り出してある。 */
function passes(magnitude: number, depthKm: number, lat: number, lng: number, b: Bounds): boolean {
  // NaN はどの比較でも偽になるので、欠測はここで落ちる。
  if (!(magnitude >= b.minMagnitude && magnitude <= b.maxMagnitude)) return false
  if (!(depthKm >= b.minDepthKm && depthKm <= b.maxDepthKm)) return false
  if (!(lat >= b.minLat && lat <= b.maxLat)) return false
  return lng >= b.minLng && lng <= b.maxLng
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
  // **端のつまみは「制限なし」。すべての境界で読み替える**（理由は `effectiveMaxDepthKm`）。
  const [minLat, maxLat] = effectiveLatRange(filter.minLat, filter.maxLat)
  const [minLng, maxLng] = effectiveLngRange(filter.minLng, filter.maxLng)
  const bounds: Bounds = {
    minMagnitude: filter.minMagnitude,
    maxMagnitude: effectiveMaxMagnitude(filter.maxMagnitude),
    minDepthKm: effectiveMinDepthKm(filter.minDepthKm),
    maxDepthKm: effectiveMaxDepthKm(filter.maxDepthKm),
    minLat,
    maxLat,
    minLng,
    maxLng,
  }
  // 1 周目。件数と、発生年で色を付けるときの分母を同時に取る。
  // **分母は絞り込みに残った点だけで測る。** 年ファイルの端で測ると、深さや M で絞った結果
  // 実際には狭い範囲しか残っていないときに、色が 1 段ぶんしか出ない。
  let count = 0
  let timeLo = Infinity
  let timeHi = -Infinity
  for (const y of years) {
    for (let i = 0; i < y.count; i++) {
      if (!passes(y.magnitude[i], y.depth[i], y.lat[i], y.lng[i], bounds)) continue
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
      if (!passes(m, d, y.lat[i], y.lng[i], bounds)) continue
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
