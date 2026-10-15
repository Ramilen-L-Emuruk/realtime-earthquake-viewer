// 地図の下端の波形の縦の単位と、静かさから縦の下限を決める物差し。**観測点の種類ごとに持つ**
// （`docs/public-waveform-design.md` §5.4）。
//
// - 自作地震計: 加速度（gal）。物差しは `utils/seismoQuietScale.ts`
// - 公開観測点: 速度（μm/s。縦軸は速度のまま。§0）。広帯域地震計の雑音は自作地震計より桁違いに小さい（§3.3）ので、
//   物差しの下限と、測れなかったときの値を別に持つ。倍率（畳むと ×3・展開すると ×1.5）は自作地震計と揃える

import { NOISE_FLOOR_GAL } from '../../utils/seismoQuakeWindow'
import { QUIET_LEVEL_MIN_GAL, QUIET_SCALE_RATIO, quietScaledGal } from '../../utils/seismoQuietScale'

/** 縦の下限を決める用途（畳んだ絵か、展開した段か）。 */
export type LiveScaleUse = 'card' | 'detail'

export interface WaveUnit {
  /** 縦の表示に添える単位。 */
  readonly label: string
  /** 静かさの物差しの下限（この単位で）。これ未満の測り値は覚えない（`QuietLevelMemory`）。 */
  readonly quietMinLevel: number
  /** 地震カードで揺れ始めを探すときのノイズの下限（この単位で。`selectQuakeWindow` の `noiseFloor`）。 */
  readonly onsetNoiseFloor: number
  /** 物差し（測れなければ `null`）から縦の下限を出す。 */
  readonly minScale: (use: LiveScaleUse, quietLevel: number | null) => number
}

export const SEISMO_WAVE_UNIT: WaveUnit = {
  label: 'gal',
  quietMinLevel: QUIET_LEVEL_MIN_GAL,
  onsetNoiseFloor: NOISE_FLOOR_GAL,
  minScale: quietScaledGal,
}

/**
 * 公開観測点の物差しの下限（μm/s）。**測り値が 0 近くに縮んだときの受け皿**（張り付いた窓を覚えないため）。
 * 生の波形（高域通過を掛けない。§0）の静かなときの振れは脈動が占めるので、ふだんはこれより十分大きい（推測。§12）。
 */
export const PUBLIC_QUIET_LEVEL_MIN_UMS = 0.01

/**
 * 公開観測点で静かさを測れなかったときの縦の下限（μm/s）。**仮の値**（静かなときの振れを測ってから合わせる。§12）。
 * 繋いだ直後で 10 秒ぶん届いていないときに使う。
 */
export const PUBLIC_QUIET_FALLBACK_UMS: Readonly<Record<LiveScaleUse, number>> = {
  card: 3,
  detail: 1.5,
}

export const PUBLIC_WAVE_UNIT: WaveUnit = {
  label: 'μm/s',
  quietMinLevel: PUBLIC_QUIET_LEVEL_MIN_UMS,
  // 受け皿としての意味は物差しの下限と同じ（縮んだ測り値で閾値が 0 へ潰れないため）なので、同じ値を置く
  onsetNoiseFloor: PUBLIC_QUIET_LEVEL_MIN_UMS,
  minScale: (use, quietLevel) => {
    if (quietLevel === null || !Number.isFinite(quietLevel)) return PUBLIC_QUIET_FALLBACK_UMS[use]
    return QUIET_SCALE_RATIO[use] * Math.max(quietLevel, PUBLIC_QUIET_LEVEL_MIN_UMS)
  },
}
