import type { TsunamiObsBar } from '../../../hooks/useTsunamiLayerData'

// 津波観測棒（波高バー・TsunamiObsBarsGL）の寸法計算。
//
// バー幅・脚・高さは地図アイコン倍率（設定の `mapIconScale`）で拡縮する。角丸だけは倍率に
// 連動させない——枠線・影と同じ「装飾のヘアライン」の扱いに揃えるため（index.css の方針と同じ）。
//
// 倍率の乗算をここに集約するのは、バー本体・コンテナ・ツールチップ位置が同じ値を見る必要が
// あるため。各所に式を散らすと、片方だけ直したときにバーと吹き出しの位置が静かにズレる。

/** バー本体の幅（px・倍率適用前の基準値）。 */
export const BAR_WIDTH = 6
/** 脚の張り出し（px・同上）。バー下端に台座として左右へ出る。 */
export const BAR_FOOT = 3
/** バー上端・脚の角丸（px）。装飾のため倍率に連動しない。 */
export const BAR_RADIUS = 3
/** ツールチップの横オフセット（px）。バーの右脇に出す。倍率に連動しない。 */
export const POPUP_OFFSET_X = 10

export interface BarMetrics {
  /** バー本体の幅（px）。 */
  w: number
  /** 脚の張り出し（px）。 */
  foot: number
  /** バー本体の高さ（px）。波高に比例する。 */
  barPx: number
}

/** 倍率適用後の実寸を返す。 */
export function barMetrics(bar: TsunamiObsBar, iconScale: number): BarMetrics {
  return {
    w: BAR_WIDTH * iconScale,
    foot: BAR_FOOT * iconScale,
    barPx: bar.barPx * iconScale,
  }
}

/**
 * ツールチップの表示位置（バーの中ほどの高さ・右脇）。
 * 縦は負値＝アンカー（バー下端）から上方向。
 */
export function popupOffset(bar: TsunamiObsBar, iconScale: number): [number, number] {
  return [POPUP_OFFSET_X, -barMetrics(bar, iconScale).barPx / 2]
}
