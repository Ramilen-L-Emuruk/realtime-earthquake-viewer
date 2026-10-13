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
  magMin: NaN,
  magMax: NaN,
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
    const { lo, hi } = sourceRangeOf(c, source.length, columnCount)

    let min: [number, number, number] | null = null
    let max: [number, number, number] | null = null
    let members = Number.POSITIVE_INFINITY
    let magMin = NaN
    let magMax = NaN

    for (let i = lo; i < hi; i += 1) {
      const col = source[i]
      if (col === null || col === undefined) continue
      if (min === null || max === null) {
        min = [col.min[0], col.min[1], col.min[2]]
        max = [col.max[0], col.max[1], col.max[2]]
      } else {
        for (let a = 0; a < 3; a += 1) {
          // **その成分の値が無い列（`NaN`）は飛ばし、`NaN` の端は必ず置き換える** —— 観測点の合成が
          // 解けなかった成分は `NaN` で届く。比べるだけだと、最初に拾った `NaN` が居座る。
          if (Number.isFinite(col.min[a]) && (!Number.isFinite(min[a]) || col.min[a] < min[a])) min[a] = col.min[a]
          if (Number.isFinite(col.max[a]) && (!Number.isFinite(max[a]) || col.max[a] > max[a])) max[a] = col.max[a]
        }
      }
      // **いちばん少ない本数を採る。** 裏付けが 1 本まで落ちた瞬間がその範囲に
      // あれば、その列は「裏付けが無い」として示す（見落とす方が重い）。
      if (col.minMembers < members) members = col.minMembers
      // 合成も同じく「下端の最小・上端の最大」で畳む。**`NaN` の端は必ず置き換える。**
      // **合成は `visibleAxes` を反映しない（できない）** —— ホストが 3 成分すべてから出した値を受け取るだけなので、
      // 向きを消しても合成からは外れない。押し出しの窓から作る列（`waveColumns.ts`）は消した向きを外すので、
      // 向きの切替を持つ窓でこれを使うなら、合成の扱いを先に決めること（地震カードは向きを固定で描く）。
      if (Number.isFinite(col.magMin) && (!Number.isFinite(magMin) || col.magMin < magMin)) magMin = col.magMin
      if (Number.isFinite(col.magMax) && (!Number.isFinite(magMax) || col.magMax > magMax)) magMax = col.magMax
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
      magMin,
      magMax,
    })
  }

  return { columns, scaleGal: Math.max(minScaleGal, peak), hasAnyValue }
}

/**
 * 読み返した列に沿った線（`utils/seismoWaveColumns.ts` の `smoothCompositeColumns` が返す、元の列ごとに 1 点の値）を、
 * `columnCount` 列へ畳む。**{@link foldHistoryColumns} と同じ列の割り付けを使う**（ずらすと、線が波形と横にずれる）。
 *
 * 畳むのは平均（線は上下の端ではなく 1 点なので、端を取る必要が無い）。値の無い列だけの範囲は `NaN`（線を切る）。
 */
export function foldHistoryLine(values: ArrayLike<number>, columnCount: number): Float32Array {
  const out = new Float32Array(Math.max(0, columnCount)).fill(Number.NaN)
  if (columnCount <= 0 || values.length === 0) return out
  for (let c = 0; c < columnCount; c += 1) {
    const { lo, hi } = sourceRangeOf(c, values.length, columnCount)
    let sum = 0
    let cnt = 0
    for (let i = lo; i < hi; i += 1) {
      const v = values[i]
      if (!Number.isFinite(v)) continue
      sum += v
      cnt += 1
    }
    if (cnt > 0) out[c] = sum / cnt
  }
  return out
}

/** 出力の列 `c` が引く元の列の範囲 `[lo, hi)`。 */
function sourceRangeOf(c: number, sourceLength: number, columnCount: number): { lo: number; hi: number } {
  const lo = Math.min(sourceLength - 1, Math.floor((c * sourceLength) / columnCount))
  // **最低 1 つは見る。** 素直に `ceil` だけにすると、画面のほうが広いときに
  // `lo === hi` の空区間ができて列が丸ごと落ちる。
  const hi = Math.min(sourceLength, Math.max(lo + 1, Math.ceil(((c + 1) * sourceLength) / columnCount)))
  return { lo, hi }
}
