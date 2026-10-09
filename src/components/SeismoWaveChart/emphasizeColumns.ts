// 地震カードの波形を**強調して描く**ため、平常時のノイズの内側を潰す。
//
// **成分ごとに、ノイズの帯の内側を 0 にして、はみ出した分だけを残す**（帯の測り方は
// `utils/seismoQuakeWindow.ts` の `measureNoiseBand`）。残った量に合わせて縦を伸ばすので、
// 弱い揺れでも枠いっぱいに出る。**縦は一定ではなくなる** —— 正確な絵は詳細の窓で見る、
// という役割分担（2026-10-03 のユーザー判断）。
//
// **揺れが無ければ平らな線になる。** ノイズを揺れに見せないための形で、平らなこと自体が
// 「揺れは記録されなかった」を示す。
//
// **畳んだ後に潰してよい。** 潰す操作（幅の内側を 0 へ・外側を幅だけ寄せる）は単調なので、
// 「下端の最小・上端の最大」を取ってから潰しても、潰してから取っても同じ値になる。

import type { NoiseBand } from '../../utils/seismoQuakeWindow'
import type { PaintableColumns } from './paintWave'
import type { WaveColumn } from './waveColumns'
import { formatEmphasizedScaleGal } from './waveLabels'

/**
 * 潰した後の縦の最小（gal）。**0.5 gal。**
 *
 * 残った最大値でそのまま縦を伸ばすと、地震の無い窓に残るノイズの尖り（実測で最大 0.52 gal。
 * 18 窓中 2 窓が 0.3 gal を超えた）が枠いっぱいに描かれて揺れに見える。震度2〜3 の地震は
 * 8 件のうち 7 件で 0.4〜1.3 gal 残ったので、この値ならそれらは枠の 8 割以上の高さに出る。
 */
export const MIN_EMPHASIZED_SCALE_GAL = 0.5

/**
 * 中心からの距離のうち、幅を超えた分だけを残す（符号は保つ）。
 *
 * **非有限の値は非有限のまま返す。** 0 へ落とすと「欠測」が「ノイズの内側（本物の 0）」に化けて
 * 描かれる（観測点の合成が解けなかった成分は、値を持つ列でもその成分だけ `NaN` で届く）。
 */
function shrink(value: number, center: number, width: number): number {
  const d = value - center
  if (!Number.isFinite(d)) return d
  if (d > width) return d - width
  if (d < -width) return d + width
  return 0
}

/**
 * 畳んだ列のノイズを潰し、縦の目盛りと表示を作り直す。
 *
 * **縦の表示は、いちばん幅を超えた成分の幅と上端**（`±W〜±(W + 縦) gal`）。成分ごとに幅が
 * 違うので、ほかの成分の幅はこの数字と少し違う（2026-10-04 のユーザー判断）。どの成分も
 * 幅を超えていなければ、超えるのにいちばん近かった成分を採る。
 *
 * **描く向きが 1 つも無ければ潰さずに返す。** 分母にする成分が無い。
 *
 * @param folded 畳んだ列（`foldHistoryColumns`）
 * @param noise 平常時のノイズの帯
 * @param visibleAxes 描く向き。**消した向きは縦の分母にも表示にも数えない**（畳む側と同じ）
 */
export function emphasizeColumns(params: {
  readonly folded: PaintableColumns
  readonly noise: NoiseBand
  readonly visibleAxes?: readonly boolean[]
}): PaintableColumns {
  const { folded, noise, visibleAxes } = params
  if (!folded.hasAnyValue) return folded
  const isVisible = (a: number): boolean => visibleAxes === undefined || visibleAxes[a] !== false
  if (![0, 1, 2].some(isVisible)) return folded

  // 成分ごとに「中心からの振れの最大 − 幅」。負なら幅の内側に収まっている。
  const excess = [-Infinity, -Infinity, -Infinity]
  const columns: WaveColumn[] = folded.columns.map((col) => {
    if (!col.hasValue) return col
    const min: [number, number, number] = [0, 0, 0]
    const max: [number, number, number] = [0, 0, 0]
    for (let a = 0; a < 3; a += 1) {
      const c = noise.center[a]
      const w = noise.width[a]
      min[a] = shrink(col.min[a], c, w)
      max[a] = shrink(col.max[a], c, w)
      const reach = Math.max(Math.abs(col.max[a] - c), Math.abs(col.min[a] - c)) - w
      if (reach > excess[a]) excess[a] = reach
    }
    return { ...col, min, max }
  })

  let best = -1
  for (let a = 0; a < 3; a += 1) {
    if (!isVisible(a) || !Number.isFinite(excess[a])) continue
    if (best < 0 || excess[a] > excess[best]) best = a
  }
  // **振れの測れる向きが無ければ潰さずに返す**（値はあるのに全部非有限、という壊れ方）。
  if (best < 0) return folded
  const scaleGal = Math.max(MIN_EMPHASIZED_SCALE_GAL, excess[best])
  const width = noise.width[best]
  return {
    columns,
    scaleGal,
    hasAnyValue: true,
    scaleLabel: formatEmphasizedScaleGal(width, width + scaleGal),
  }
}
