import type { IntensityScale } from '../types/earthquake'
import { hasDepth, hasMagnitude } from './formatters'

export const INTENSITY_LABELS: Record<number, string> = {
  '-1': '不明',
  10: '1',
  20: '2',
  30: '3',
  40: '4',
  45: '5弱',
  50: '5強',
  55: '6弱',
  60: '6強',
  70: '7',
}

export const INTENSITY_COLORS: Record<number, string> = {
  '-1': '#666666',
  10: '#7bb4c8',
  20: '#0070c8',
  30: '#00b050',
  40: '#f5e600',
  45: '#ffa000',
  50: '#ff6600',
  55: '#f00000',
  60: '#a50021',
  70: '#9d0099',
}

export const INTENSITY_BG_COLORS: Record<number, string> = {
  '-1': '#2a2a2a',
  10: '#0f2a30',
  20: '#001533',
  30: '#002010',
  40: '#2a2800',
  45: '#2a1800',
  50: '#2a1000',
  55: '#2a0000',
  60: '#1a0007',
  70: '#1a0020',
}

/**
 * 気象庁の震度階級に対応する値かどうか（`-1` = 不明を含む）。
 *
 * `IntensityScale` 型はコンパイル時にしか効かないため、型検査を通らない経路
 * （実地震シナリオ JSON・`as` キャストで通す P2PQuake レスポンス）から来た値は
 * これで弾く。中間値（`25` 等）や範囲外の値をそのまま比較に使うと、
 * 震度表示が「不明」になったり特別警報へ誤って昇格したりする。
 */
/**
 * 気象庁の震度階級の段数（「不明」を除く）。現在は 9 段（震度1〜7。震度0 は震度1 と同じ階級値）。
 *
 * **「すべての階級を読む」の上限を導くのに使う。** 読み上げの階数は「最大震度に加えて何階級下まで」
 * なので、段数から 1 引いた値で全段を覆う。数を直接書くと、階級が増減したときに選択肢だけが
 * 古い段数のまま残る。
 */
export const INTENSITY_SCALE_COUNT = Object.keys(INTENSITY_LABELS)
  .filter(k => Number(k) >= 0).length

/**
 * 階級値を小さい順に並べたもの（`-1` = 不明を除く）。
 *
 * **段数と同じ表から導く。** 並びを別に書くと、階級が増減したときに片方だけ古くなる。
 */
export const INTENSITY_SCALES_ASC: readonly IntensityScale[] = Object.keys(INTENSITY_LABELS)
  .map(Number)
  .filter(v => v >= 0)
  .sort((a, b) => a - b) as IntensityScale[]

export function isValidIntensityScale(scale: number): scale is IntensityScale {
  // 型が効かない経路を守るための関数なので、自分自身は引数の型を当てにしない。
  // `in` 演算子や添字アクセスは継承プロパティも拾うため（`'toString' in INTENSITY_LABELS` は true）、
  // 実行時に文字列が紛れ込んでも誤って通さないよう hasOwnProperty で判定する。
  return typeof scale === 'number' && Object.prototype.hasOwnProperty.call(INTENSITY_LABELS, scale)
}

export function getIntensityLabel(scale: number): string {
  return INTENSITY_LABELS[scale] ?? '不明'
}

/**
 * 震度ラベルに「以上」を補う（`orAbove` のとき）。
 *
 * **こちらは「5弱以上・未入電」専用。** 電文の値そのものが `震度５弱以上未入電` で、
 * 気象庁が「以上」と書いている（「程度」は付かない）。
 *
 * **EEW の上限を定めない予想震度には使わない** —— そちらの気象庁の表現は「程度以上」で、
 * 語が違う（→ `getIntensityLabelWithApproxAbove`）。同じ関数を使い回していたため、
 * 片方に揃えるともう片方が気象庁の表記から外れる状態だった。
 *
 * 「不明」（階級外）に語を足しても意味を成さないので、その場合は付けない。
 */
export function getIntensityLabelWithOrAbove(scale: number, orAbove: boolean): string {
  const label = getIntensityLabel(scale)
  return orAbove && isValidIntensityScale(scale) && scale > 0 ? `${label}以上` : label
}

/**
 * 震度ラベルに「程度以上」を補う（`over` のとき）。**EEW の予想震度専用。**
 *
 * 予想震度は上限が定まらないことがあり、その報は下限側の階級を持つ
 * （`EEWRegion.scaleToOrAbove` / `eewMaxScaleInfo`）。値だけを見せると
 * 「震度4程度以上」を「震度4」と断定してしまうため、表示・読み上げはこの語を通す。
 *
 * **語は気象庁の表現に合わせる。** 電文解説資料（Ⅱ.21）は `To` の値域を
 * 「7 ：震度 7　over:～程度以上　不明：不明時」と定め、事例も「最大予測震度が
 * 震度 5 弱**程度以上**の場合」と書いている。長周期地震動階級も同じ言い方
 * （→ `getLpgmClassLabelWithApproxAbove`）。
 */
export function getIntensityLabelWithApproxAbove(scale: number, over: boolean): string {
  const label = getIntensityLabel(scale)
  return over && isValidIntensityScale(scale) && scale > 0 ? `${label}程度以上` : label
}

export function getIntensityColor(scale: number): string {
  return INTENSITY_COLORS[scale] ?? '#666666'
}

export function getIntensityBgColor(scale: number): string {
  return INTENSITY_BG_COLORS[scale] ?? '#2a2a2a'
}

/**
 * 深さに応じた色（浅い=赤系、深い=青系）。気象庁震度配色に準拠した段階色。
 */
export function getDepthColor(depth: number): string {
  if (!hasDepth(depth)) return '#666666'  // 不明（formatDepth と同じ判定）
  if (depth === 0) return '#f00000'   // ごく浅い → 赤（震度6弱相当）
  if (depth <= 20) return '#ff6600'   // 〜20km → オレンジ（震度5強相当）
  if (depth <= 40) return '#ffa000'   // 〜40km → 黄橙（震度5弱相当）
  if (depth <= 80) return '#f5e600'   // 〜80km → 黄（震度4相当）
  if (depth <= 150) return '#00b050'  // 〜150km → 緑（震度3相当）
  if (depth <= 300) return '#0070c8'  // 〜300km → 青（震度2相当）
  return '#7bb4c8'                    // 300km超 → 薄青（震度1相当）
}

/**
 * マグニチュードに応じた色。気象庁震度配色のスケールをM2〜M7+に割り当て。
 * 小さい(M2未満)=薄青(震度1相当) → 大きい(M7以上)=紫(震度7相当)
 */
export function getMagnitudeColor(magnitude: number): string {
  // 規模不明のセンチネルは経路によって -1（P2PQuake）と NaN（DMDATA）の二種類がある。
  // NaN は以降の比較がすべて false になり最終行の紫（M7 以上）に落ちてしまうため、
  // formatMagnitude と同じ判定（hasMagnitude）で先に灰色へ弾く。
  if (!hasMagnitude(magnitude)) return '#666666'
  if (magnitude < 2.0) return '#7bb4c8'   // M2未満 → 薄青（震度1相当）
  if (magnitude < 3.0) return '#0070c8'   // M2〜3 → 青（震度2相当）
  if (magnitude < 4.0) return '#00b050'   // M3〜4 → 緑（震度3相当）
  if (magnitude < 5.0) return '#f5e600'   // M4〜5 → 黄（震度4相当）
  if (magnitude < 6.0) return '#ffa000'   // M5〜6 → 黄橙（震度5弱相当）
  if (magnitude < 7.0) return '#f00000'   // M6〜7 → 赤（震度6弱相当）
  return '#9d0099'                         // M7以上 → 紫（震度7相当）
}

export function isHighIntensity(scale: number): boolean {
  return scale >= 50
}

export function isCriticalIntensity(scale: number): boolean {
  return scale >= 55
}

export function getScaleRadius(scale: number): number {
  const radiusMap: Record<number, number> = {
    '-1': 4,
    10: 4,
    20: 5,
    30: 6,
    40: 7,
    45: 9,
    50: 10,
    55: 12,
    60: 14,
    70: 16,
  }
  return radiusMap[scale] ?? 4
}
