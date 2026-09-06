// 長周期地震動階級のラベル・配色ユーティリティ（JMA公式色）
import type { LpgmClass } from '../types/earthquake'
const LPGM_COLORS: Record<number, string> = {
  1: '#c8c800',
  2: '#ff9600',
  3: '#ff2800',
  4: '#c83200',
}

const LPGM_BG_COLORS: Record<number, string> = {
  1: 'rgba(200,200,0,0.15)',
  2: 'rgba(255,150,0,0.15)',
  3: 'rgba(255,40,0,0.15)',
  4: 'rgba(200,50,0,0.15)',
}

/**
 * 長周期地震動階級として妥当な値か（1〜4）。
 *
 * `isValidIntensityScale()`（`intensity.ts`）と同じく、型検査が及ばない経路
 * （実地震シナリオ JSON・`as` キャストで通す外部レスポンス）から来た値を実行時に弾くためのもの。
 * EEW の特別警報は震度と長周期地震動階級の OR 判定なので、片方だけ守っても誤昇格は防げない。
 * 型が効かない経路を守る関数なので、自分自身は引数の型を当てにしない。
 */
export function isValidLpgmClass(v: number): v is LpgmClass {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4
}

export function getLpgmClassLabel(cls: number): string {
  return isValidLpgmClass(cls) ? `階級${cls}` : '階級不明'
}

/**
 * 階級ラベルに「程度以上」を補う（`over` のとき）。**EEW の予測階級専用。**
 *
 * **語は気象庁の表現に合わせる。** 電文解説資料（Ⅱ.21 2-1-3-2）は `To` の値域を
 * 「4 ：長周期地震動階級 4　over:～程度以上　不明：不明時」と定め、事例も
 * 「最大予測長周期地震動階級が階級 3 **程度以上**の場合」と書いている。
 * 震度側の予想も同じ言い方（→ `getIntensityLabelWithApproxAbove`）。
 *
 * 「階級不明」に語を足しても意味を成さないので、その場合は付けない。
 */
export function getLpgmClassLabelWithApproxAbove(cls: number, over: boolean): string {
  const label = getLpgmClassLabel(cls)
  return over && isValidLpgmClass(cls) ? `${label}程度以上` : label
}

export function getLpgmClassColor(cls: number): string {
  return LPGM_COLORS[cls] ?? '#9ca3af'
}

/**
 * 地図バッジの半径（正方形バッジの一辺の半分・px）。震度の `getScaleRadius()` と同じ役割で、
 * 階級が上がるほど大きくする。
 *
 * 以前は階級によらず固定サイズだった（旧 HTML Marker 版からの移植の名残）ため、
 * 最も重い階級4 が階級1 と同じ大きさで描かれ、重大さが大きさに出ていなかった。
 * 階級不明は最小に倒す。
 */
export function getLpgmClassRadius(cls: number): number {
  const radiusMap: Record<number, number> = { 1: 8, 2: 10, 3: 12, 4: 14 }
  return radiusMap[cls] ?? 8
}

export function getLpgmClassBgColor(cls: number): string {
  return LPGM_BG_COLORS[cls] ?? 'transparent'
}
