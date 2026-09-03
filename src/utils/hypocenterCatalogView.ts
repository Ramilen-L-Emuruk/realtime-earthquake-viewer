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

/**
 * 表示する範囲。すべて両端を含む。
 *
 * 期間（`fromMs` / `toMs`）は日本時間の、開始日の 0 時と終了日の 23:59:59.999。年ではなく
 * 時刻で持つのは、日付ピッカーで年の途中を選べるようにするため。年ファイルの取得範囲は
 * ここから年を導出して決める（`jstYearOf`・`yearsInRange`）。
 */
export interface CatalogFilter extends CatalogPeriod {
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
 *
 * **深い側も段を分けてある。** 青のまま飽和させると 350km より深い地震が同じ色になる。
 * 深発地震の主体は 300〜450km（収録の 2.2%・約 2.2 万件）でちょうどそこが潰れるため、
 * シアン → 青 → 紫 → マゼンタと色相を動かして 100km 刻みで見分けられるようにしている。
 */
const DEPTH_RAMP: Ramp = [
  [0.0, 0.94, 0.26, 0.21],
  [0.08, 0.98, 0.55, 0.15],
  [0.2, 0.96, 0.85, 0.25],
  [0.4, 0.35, 0.78, 0.45],
  [0.6, 0.2, 0.7, 0.9],
  [0.78, 0.3, 0.4, 0.95],
  [1.0, 0.85, 0.35, 0.95],
]

/**
 * 深さの色が飽和する値（km）。
 *
 * **等間隔ではなく浅い側へ寄せてある。** 地震の大半は 30km より浅く、線形に配ると内陸の地震が
 * すべて同じ色になる。段の位置（0.08 = 4.8km, 0.2 = 30km）が浅い側に密なのはそのため
 * （`depthRampT` が平方根で寄せるので、段の位置に対する km は二乗で効く）。
 *
 * 深発地震はマントル遷移層の底より深くでは起きないため、値そのものは物理の限界の側で決めてある。
 */
export const DEPTH_RAMP_MAX_KM = 750

/**
 * マグニチュードの色。小さいほど寒色。
 *
 * **上端は赤で止めずピンクへ抜く。** 赤で飽和させると M8 と M9 が同じ色になり、最大級の
 * 地震どうしを見分けられない。段が上端ほど詰まっているのは、件数の多い M2〜5 の帯
 * （収録の 99% 以上）で色が動く余地を残すため。
 */
const MAGNITUDE_RAMP: Ramp = [
  [0.0, 0.35, 0.6, 0.95],
  [0.3, 0.35, 0.85, 0.6],
  [0.5, 0.95, 0.85, 0.3],
  [0.68, 0.97, 0.55, 0.18],
  [0.83, 0.9, 0.15, 0.2],
  [1.0, 1.0, 0.45, 0.95],
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

/**
 * マグニチュードの色が飽和する範囲。
 *
 * **上端は収録の最大（M9.0）より先へ置く。** 収録の最大ちょうどで飽和させると、それを超える
 * 地震が入った日から最大級どうしを見分けられなくなる。M9.5 は観測史上の最大規模にあたる。
 */
export const MAGNITUDE_RAMP_RANGE = { min: 2, max: 9.5 } as const

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
 * **倍率は M が 1 増えるごとに一定倍**（幾何級数）。一定量を足していく形（線形）だと上端ほど
 * 比が縮み、M2→M3 が 1.7 倍なのに M8→M9 は 1.17 倍にしかならない。最大級の地震どうしが
 * 見分けられなくなるうえ、マグニチュード自体が対数なので比で刻むほうが順序を読み取りやすい。
 *
 * 比を 1.45 に抑えてあるのは、物理量に忠実に写さないため。エネルギーの比で写すと M2 と M9 で
 * 300 億倍、面積に見立てて直径へ落としても 18 万倍になり、図として成立しない。
 * 「大きいほど目立つ」という順序だけを保てばよい。
 */
export function pointSizePx(basePx: number, magnitude: number, sizeBy: CatalogSizeBy): number {
  if (sizeBy === 'fixed') return basePx
  const raw = Number.isFinite(magnitude) ? magnitude : EMPHASIS_BASE_MAGNITUDE
  // **収録の下限より下は下限として扱う。** 幾何級数なので 0 にはならないが、異常な値
  // （データの破損で極端に小さい M）が来たときに点が消えるほど縮むのを止める。
  const m = raw < EMPHASIS_BASE_MAGNITUDE ? EMPHASIS_BASE_MAGNITUDE : raw
  const scale = EMPHASIS_BASE * EMPHASIS_RATIO ** (m - EMPHASIS_BASE_MAGNITUDE)
  return basePx * (scale > EMPHASIS_MAX ? EMPHASIS_MAX : scale)
}

/**
 * 倍率の起点となるマグニチュード。**色の飽和範囲ではなく絞り込みの下端を見る**
 * （借りると、色を調整したときに点の大きさまで一緒に動く）。収録の下限と一致する。
 */
const EMPHASIS_BASE_MAGNITUDE = MAGNITUDE_FILTER_RANGE.min
/** 起点での倍率。**0 にしない**——最も件数の多い地震が 1 つ残らず消える。 */
const EMPHASIS_BASE = 0.3
/** M が 1 増えるごとに直径が何倍になるか（M9 で 4.0 倍・M9.5 で 4.9 倍）。 */
const EMPHASIS_RATIO = 1.45
/**
 * 倍率の上限。**M10 でも頭打ちしない値にしてある**（M10 で 5.9 倍）。上限で切ると、
 * そこを超える規模どうしが同じ大きさになる。
 */
const EMPHASIS_MAX = 8

/** その期間・その下限で、取りこぼしがあるかどうか。 */
export interface CatalogCompleteness {
  /** その期間で取りこぼしが無い M の下限。 */
  completeMin: number
  /** いま選んでいる下限がそれを下回っているか（下回っていれば古い期間ほど薄くなる）。 */
  belowComplete: boolean
}

/** 日本標準時と協定世界時の差（ミリ秒）。カタログの時刻はもともと日本時間。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000
/** 1 日（ミリ秒）。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * その時刻が日本時間で何年か。
 *
 * **実行環境のタイムゾーンを見ない。** `new Date(ms).getFullYear()` は端末の設定で答えが変わり、
 * CI は UTC で回る。日本時間へずらしてから UTC として読む（`hypocenterCatalog.ts` の `timeMs` と同じ扱い）。
 */
export function jstYearOf(ms: number): number {
  return new Date(ms + JST_OFFSET_MS).getUTCFullYear()
}

/** 日本時間のその年の 1 月 1 日 0 時。 */
export function jstYearStartMs(year: number): number {
  return Date.UTC(year, 0, 1) - JST_OFFSET_MS
}

/**
 * 日本時間のその年の最後の瞬間（12 月 31 日 23:59:59.999）。
 *
 * **翌年の頭ではなく 1 ミリ秒手前を返す。** 期間の両端は含む扱いなので、翌年の頭を返すと
 * 元日 0 時ちょうどに起きた地震が翌年ぶんとして混ざる。
 */
export function jstYearEndMs(year: number): number {
  return jstYearStartMs(year + 1) - 1
}

/**
 * 日付ピッカーへ渡す `YYYY-MM-DD`（日本時間の暦日）。
 *
 * **有限な時刻であること。** 非有限な値では `toISOString` が例外を投げ、この戻り値は
 * `<input type="date">` の `value` に入るため、**画面ごと落ちる**（震源カタログタブは
 * 常時マウントなのでアプリ全体に及ぶ）。非有限が入りうるのは索引の年が壊れている場合だけで、
 * それは取得の検分（`loadHypocenterIndex`）で弾いてある。
 */
export function toDateInputValue(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 日付ピッカーの `YYYY-MM-DD` を時刻へ。`edge` はその日のどちら端に寄せるか。
 *
 * **読めない値では `null` を返す。** 日付ピッカーは空にできるうえ、キーボードからは
 * 「2 月 30 日」のような存在しない日も入る。`Date.UTC` はそれを翌月へ繰り上げて別の日を
 * 黙って返すので、組み立てた結果を読み直して一致を確かめている。
 *
 * **年が 0〜99 のときも同じ検査で落ちる。** `Date.UTC` はその範囲を 1900 年代として解釈する
 * ため（`Date.UTC(9, 0, 15)` は 1909 年）、読み直した年が一致しない。年を打ちかけた途中の値
 * （`0009-…`）がここで弾かれるのはその副作用で、狙って書いた規則ではない。
 */
export function fromDateInputValue(value: string, edge: 'start' | 'end'): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const utc = Date.UTC(year, month - 1, day)
  const back = new Date(utc)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null
  const start = utc - JST_OFFSET_MS
  return edge === 'start' ? start : start + DAY_MS - 1
}

/**
 * その時刻が属する日本時間の 1 日を、始まりと終わりで返す。
 *
 * **範囲へ収めるときは、時刻を丸めずにここを通す。** 始まりと終わりを別々に丸めると、
 * 期間が丸ごと範囲の外にあるときに両方が同じ 1 点へ寄り、**幅が消える**。そうなると 1 件も
 * 残らないのに、見出しは「1 日ぶん」ともっともらしく出るので原因に辿り着けない。
 */
function jstDayBounds(ms: number): [number, number] | null {
  // **非有限はここで落とす。** `toDateInputValue` は例外を投げる契約なので、素通りさせると
  // 「読めなければ null」という見た目のこの関数から、null ではなく未捕捉の例外が飛ぶ。
  if (!Number.isFinite(ms)) return null
  const day = toDateInputValue(ms)
  const start = fromDateInputValue(day, 'start')
  const end = fromDateInputValue(day, 'end')
  return start == null || end == null ? null : [start, end]
}

/**
 * 日付ピッカーで選ばれた 1 日を、収録の範囲へ収める。
 *
 * **いまの呼び出し経路では範囲外は届かない**——日付の入力欄（`DateField`）が範囲に収まる日
 * だけを渡すため。それでも収める側を残してあるのは、収めることをこの関数が引き受けているから
 * （入力欄の判定が壊れたときと、呼び出し元が増えたときの備え）。
 *
 * @param minMs 範囲の始まり。**その日の 0 時であること**
 * @param maxMs 範囲の終わり。**その日の最後の瞬間であること**
 * @returns 収めた日の始まりと終わり。値が読めなければ `null`
 */
export function clampDayToRange(value: string, minMs: number, maxMs: number): [number, number] | null {
  const start = fromDateInputValue(value, 'start')
  const end = fromDateInputValue(value, 'end')
  if (start == null || end == null) return null
  if (start >= minMs && end <= maxMs) return [start, end]
  return jstDayBounds(start < minMs ? minMs : maxMs)
}

/**
 * 期間の範囲。`CatalogFilter` のうち、期間だけを取り出したもの。
 *
 * **2 つの不変条件がある**——`fromMs <= toMs` であることと、両端が日本時間の日境界
 * （開始はその日の 0 時、終了はその日の最後の瞬間）であること。守っているのは
 * `periodFromYearChange` / `periodFromDateChange` / `clampPeriodToRange` の 3 つで、
 * **期間を変える経路を新しく足すときは、このどれかを必ず経由すること。** 直に組み立てると
 * 日数の表示と日付ピッカーの値が静かにずれる（絞り込みそのものは消費側が両端を正規化するので、
 * 件数には現れない）。
 */
export interface CatalogPeriod {
  fromMs: number
  toMs: number
}

/**
 * 期間を収録の範囲へ収める。**索引が届いたときに一度通す。**
 *
 * 年が明けた直後は「今年」がまだ収録されておらず、選んでいる期間が範囲の外に出る。
 * **端の 1 日ぶんの幅は残す**——両端をそれぞれ時刻で丸めると、期間が丸ごと外にあるときに
 * 同じ 1 点へ潰れる（理由は `jstDayBounds`）。
 *
 * @param minMs 範囲の始まり。**その日の 0 時であること**
 * @param maxMs 範囲の終わり。**その日の最後の瞬間であること**
 */
export function clampPeriodToRange(period: CatalogPeriod, minMs: number, maxMs: number): CatalogPeriod {
  const fromMs = Math.min(Math.max(period.fromMs, minMs), maxMs)
  const toMs = Math.min(Math.max(period.toMs, minMs), maxMs)
  if (fromMs < toMs) return { fromMs, toMs }
  const day = jstDayBounds(fromMs)
  if (day == null) return { fromMs, toMs }
  return { fromMs: Math.max(day[0], minMs), toMs: Math.min(day[1], maxMs) }
}

/**
 * 年ごとのつまみで期間を変えたときの新しい範囲。
 *
 * **動かしていない側の日付は保つ。** 両方を年へ丸め直すと、片方のつまみを触っただけで
 * もう片方の日付指定が黙って消える。
 */
export function periodFromYearChange(period: CatalogPeriod, fromYear: number, toYear: number): CatalogPeriod {
  return {
    fromMs: fromYear === jstYearOf(period.fromMs) ? period.fromMs : jstYearStartMs(fromYear),
    toMs: toYear === jstYearOf(period.toMs) ? period.toMs : jstYearEndMs(toYear),
  }
}

/**
 * 日付ピッカーで一方の端を変えたときの新しい範囲。
 *
 * **相手を追い越したら押す**（つまみの押し合わせと同じ扱い）。押した先も日の境界に乗る。
 *
 * @returns 値が読めなければ `null`（呼び出し側は今の値を保つ）
 */
export function periodFromDateChange(
  period: CatalogPeriod,
  value: string,
  edge: 'from' | 'to',
  minMs: number,
  maxMs: number,
): CatalogPeriod | null {
  const day = clampDayToRange(value, minMs, maxMs)
  if (day == null) return null
  const [lo, hi] = day
  if (edge === 'from') return { fromMs: lo, toMs: lo > period.toMs ? hi : period.toMs }
  return { fromMs: hi < period.fromMs ? lo : period.fromMs, toMs: hi }
}

/** 日本時間の暦日を「2016年3月14日」の形で。 */
export function formatJstDate(ms: number): string {
  const d = new Date(ms + JST_OFFSET_MS)
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

/** 期間に含まれる日数（両端を含む）。両端が日の境界にそろっている前提。 */
export function periodDayCount(fromMs: number, toMs: number): number {
  const lo = Math.min(fromMs, toMs)
  const hi = Math.max(fromMs, toMs)
  return Math.floor((hi - lo) / DAY_MS) + 1
}

/**
 * 期間の最も古い年を返す。
 *
 * **`fromMs` をそのまま使ってはならない。** 「開始」と「終了」は別々に選べるので、新しい日を
 * 開始に、古い日を終了に置くことができる。年ファイルの取得（`yearsInRange`）は両端を正規化して
 * いるため、そのとき実際に読むのは古い側からになる。完全性の判定だけが `fromMs` を見ていると、
 * **読んでいない年を基準に「網羅している」と答える**（例: 開始 2020・終了 1960 で M2.0 と答える）。
 */
export function oldestYearOf(filter: Pick<CatalogFilter, 'fromMs' | 'toMs'>): number {
  return Math.min(jstYearOf(filter.fromMs), jstYearOf(filter.toMs))
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
 *
 * **色が飽和する値（`DEPTH_RAMP_MAX_KM`）とは別に持つ。** マグニチュードと同じ理由で、
 * 借りていると色を調整したつもりで絞り込みの届く範囲まで一緒に動く（値がたまたま同じでも、
 * 決め方は別）。
 */
export const DEPTH_FILTER_MAX_KM = 750

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
  /** 期間の始まり（この時刻を含む）。 */
  minTimeMs: number
  /** 期間の終わり（この時刻を含む）。 */
  maxTimeMs: number
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
function passes(
  timeMs: number,
  magnitude: number,
  depthKm: number,
  lat: number,
  lng: number,
  b: Bounds,
): boolean {
  // NaN はどの比較でも偽になるので、欠測はここで落ちる。
  if (!(timeMs >= b.minTimeMs && timeMs <= b.maxTimeMs)) return false
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
    // **開始と終了が逆でも同じ範囲として扱う。** 画面の側は押し合わせて逆転を作らせないが、
    // 逆転した値で 1 件も残らないという壊れ方は原因が画面に出ない。
    minTimeMs: Math.min(filter.fromMs, filter.toMs),
    maxTimeMs: Math.max(filter.fromMs, filter.toMs),
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
      if (!passes(y.timeMs[i], y.magnitude[i], y.depth[i], y.lat[i], y.lng[i], bounds)) continue
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
      if (!passes(y.timeMs[i], m, d, y.lat[i], y.lng[i], bounds)) continue
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
