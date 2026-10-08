// ホストが返した列を、画面の幅へ畳む。
//
// **列は上下の端なので、まとめるのは正しく縮む** ——「下端の最小・上端の最大」を
// 取るだけで振幅が保たれる。**逆に足りない列を増やすことはできない**ので、
// ホストへは画面より多めに要求してある（`useSeismoQuakeWaves` の
// `WAVE_HISTORY_COLUMNS`）。
//
// **点を間引く形にしない。** 「n 列おきに 1 列」ではピークが確率的に消える
// （`waveColumns.ts` の冒頭と同じ理由）。

import type { WaveHistoryColumn } from '../../services/seismoWaveHistory'
import type { PaintableColumns } from './paintWave'
import type { WaveColumn } from './waveColumns'

const NO_VALUE: WaveColumn = {
  hasValue: false,
  min: [NaN, NaN, NaN],
  max: [NaN, NaN, NaN],
  minMembers: 0,
}

/**
 * 読み返した列を、`columnCount` 列へ畳む。
 *
 * **要求した列数より画面が広いこともある。** そのときは隣り合う出力列が同じ入力列を
 * 引く（絵は階段状になるが、値は正しい）。**空の列にしない** ——線が切れて「届いて
 * いない区間」に見えてしまう。
 */
export function foldHistoryColumns(params: {
  source: readonly (WaveHistoryColumn | null)[]
  columnCount: number
  minScaleGal: number
  /**
   * 振れ幅に数える向き（東西・南北・上下の順）。**省略すれば 3 成分すべて。**
   *
   * **消した向きを分母から外す。** 外さないと、いちばん大きい成分を消しても
   * 残りが潰れたままで、消した意味がなくなる。
   */
  visibleAxes?: readonly boolean[]
}): PaintableColumns {
  const { source, columnCount, minScaleGal, visibleAxes } = params
  if (columnCount <= 0 || source.length === 0) {
    return { columns: [], scaleGal: minScaleGal, hasAnyValue: false }
  }

  const columns: WaveColumn[] = []
  let peak = 0
  let hasAnyValue = false

  for (let c = 0; c < columnCount; c += 1) {
    const lo = Math.min(source.length - 1, Math.floor((c * source.length) / columnCount))
    // **最低 1 つは見る。** 素直に `ceil` だけにすると、画面のほうが広いときに
    // `lo === hi` の空区間ができて列が丸ごと落ちる。
    const hi = Math.min(
      source.length,
      Math.max(lo + 1, Math.ceil(((c + 1) * source.length) / columnCount)),
    )

    let min: [number, number, number] | null = null
    let max: [number, number, number] | null = null
    let members = Number.POSITIVE_INFINITY

    for (let i = lo; i < hi; i += 1) {
      const col = source[i]
      if (col === null || col === undefined) continue
      if (min === null || max === null) {
        min = [col.min[0], col.min[1], col.min[2]]
        max = [col.max[0], col.max[1], col.max[2]]
      } else {
        for (let a = 0; a < 3; a += 1) {
          if (col.min[a] < min[a]) min[a] = col.min[a]
          if (col.max[a] > max[a]) max[a] = col.max[a]
        }
      }
      // **いちばん少ない本数を採る。** 裏付けが 1 本まで落ちた瞬間がその範囲に
      // あれば、その列は「裏付けが無い」として示す（見落とす方が重い）。
      if (col.minMembers < members) members = col.minMembers
    }

    if (min === null || max === null) {
      columns.push(NO_VALUE)
      continue
    }
    // **`hasAnyValue` は向きの取捨に左右させない。** これは「その区間にデータが
    // 届いているか」で、3 成分すべてを消しても「届いていない」ことにはならない。
    hasAnyValue = true
    for (let a = 0; a < 3; a += 1) {
      if (visibleAxes !== undefined && visibleAxes[a] === false) continue
      const lowAbs = Math.abs(min[a])
      const highAbs = Math.abs(max[a])
      if (lowAbs > peak) peak = lowAbs
      if (highAbs > peak) peak = highAbs
    }
    columns.push({
      hasValue: true,
      min,
      max,
      minMembers: Number.isFinite(members) ? members : 0,
    })
  }

  return { columns, scaleGal: Math.max(minScaleGal, peak), hasAnyValue }
}
