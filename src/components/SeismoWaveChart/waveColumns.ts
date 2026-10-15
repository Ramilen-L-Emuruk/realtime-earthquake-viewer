// 抱えている波形（見えている幅ぶん。60 秒 × 100 Hz で 6000 サンプル）を、画面幅の列へ落とす。
//
// **点を間引かない。列ごとに上下の端を取る。** 「n 個おきに 1 点」の形にすると、
// いちばん見たいピークが確率的に消える —— 6000 点を 300 列へ落とすなら 20 点に 1 点
// しか見ないので、単発の跳ね上がりは 95% の確率で絵に出ない。上下を取って縦棒で
// 結べば振幅が保たれる（管理コンソールの波形タブと同じ方針）。
//
// **時間軸は右端を決め（最後に届いたサンプルか、渡された時刻。`WaveRightEdge`）、そこから遡って引く。**
// 抱えている量が少ないうち（起動直後）は左が空く。全体を引き伸ばす形にすると、
// **10 秒ぶんの絵と 60 秒ぶんの絵が見分けられなくなる**（どちらも画面いっぱいに
// なる）。
//
// **値を持たない列は持たないまま返す。** 描く側はそこで線を切る —— Canvas 2D の
// `lineTo` は非有限の座標を渡すと何もしない（no-op）ので、`NaN` をそのまま渡しても
// 前後の点が 1 本に結ばれるだけ。**欠測を分けて持った意味が描画で消える**
// （`seismoWaveBuffer.ts` のヘッダが避けたいと書いている「そこだけ時間の縮んだ絵」）。

import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'
import { vectorMagnitudeOf3 } from '../../utils/seismoWaveColumns'
import { movingAverage, signedMovingAverages, MEAN_LINE_WINDOW_MS } from '../../utils/waveMeanLines'

/** 画面の 1 列ぶん。 */
export interface WaveColumn {
  /**
   * 値を持つか（どれか 1 成分でも）。**持たない列では {@link min}・{@link max} は `NaN`。**
   *
   * 理由は 2 通りあるが描く側の扱いは同じ（線を切る）ので分けていない ——
   * 届かなかった区間（`NaN` で残っている）と、まだ抱えていない区間（起動直後の左側）。
   */
  readonly hasValue: boolean
  /**
   * 3 成分それぞれの下端（gal）。**値を持つ列でも、その成分だけ `NaN` のことがある** ——
   * 観測点の合成が、測る向きが 3 方向へ散っていない間に解けない成分だけを欠けにする
   * （`seismo-host/src/receiver/sensorFusion.ts`・2026-10-09 ユーザー承認）。描く側はその成分の線をそこで切る。
   */
  readonly min: readonly [number, number, number]
  /** 3 成分それぞれの上端（gal）。`min` と同じく、その成分だけ `NaN` のことがある。 */
  readonly max: readonly [number, number, number]
  /**
   * その列に効いたセンサーの最小本数。**値を持たない列では 0。**
   *
   * 1 以下のところは合成の裏付けが無い（1 台だけの値）。
   */
  readonly minMembers: number
  /**
   * 合成（ベクトルの大きさ）の下端と上端（gal）。**サンプルごとに出してから列の端を取る**（成分ごとの端からは
   * 作れない —— 別々の瞬間の最大を組み合わせると実際より大きく出る）。**作れないときは `NaN`**
   * （値を持たない列・合成を返さない古いホストから読み返した列）。
   */
  readonly magMin: number
  readonly magMax: number
}

export interface WaveColumns {
  readonly columns: readonly WaveColumn[]
  /**
   * 縦の振れ幅（gal）。**中心 0 からの片側。**
   *
   * 窓の中の最大の絶対値。ただし下限を下回らない —— 素の自動にすると静穏時の
   * ノイズが画面いっぱいに広がり、**揺れているようにしか見えなくなる**。
   */
  readonly scaleGal: number
  /** 値を持つ列が 1 つでもあるか。**無ければ描く意味が無い。** */
  readonly hasAnyValue: boolean
}

/**
 * 横軸の右端。**`'last-sample'` は窓の最後のサンプル**、数値はその時刻（ms）。
 *
 * 地図の下端の波形は右端を時計の「いま」で進める（滑らかに流すため。`docs/public-waveform-design.md` §5.4）ので、
 * 最後のサンプルより先の時刻を右端に置く。その間は何も描かない（まだ届いていない）。
 */
export type WaveRightEdge = 'last-sample' | number

function rightEdgeMsOf(edge: WaveRightEdge, lastSampleMs: number): number {
  return edge === 'last-sample' ? lastSampleMs : edge
}

const NO_VALUE: WaveColumn = {
  hasValue: false,
  min: [NaN, NaN, NaN],
  max: [NaN, NaN, NaN],
  minMembers: 0,
  magMin: NaN,
  magMax: NaN,
}

/**
 * 窓を列へ落とす。
 *
 * @param spanMs 横軸の幅（ms）。右端は {@link WaveRightEdge} で決める。
 * @param minScaleGal 縦の振れ幅の下限（gal）。
 */
export function buildWaveColumns(params: {
  window: SeismoWaveWindow
  columnCount: number
  spanMs: number
  rightEdge: WaveRightEdge
  minScaleGal: number
  /**
   * 振れ幅に数える向き（東西・南北・上下の順）。**省略すれば 3 成分すべて。**
   *
   * **消した向きを分母から外す**（読み返し側の `foldHistoryColumns` と揃える）——
   * 外さないと、いちばん大きい成分を消しても残りが潰れたままになる。
   */
  visibleAxes?: readonly boolean[]
}): WaveColumns {
  const { window: win, columnCount, spanMs, rightEdge, minScaleGal, visibleAxes } = params
  const count = win.gal[0].length
  // **列が無い・幅が無いなら何も作らない。** 幅ゼロの canvas（畳まれている・
  // まだ測れていない）でここへ来ると、下の除算が `Infinity` になる。
  if (columnCount <= 0 || !(spanMs > 0) || count === 0) {
    return { columns: [], scaleGal: minScaleGal, hasAnyValue: false }
  }

  // 列ごとの集計。**`Float32Array` で持つ**（列数ぶんのオブジェクトを毎回作ると、
  // 10 回/秒の描き直しで小さなごみが積み上がる）。
  const mins = [new Float32Array(columnCount), new Float32Array(columnCount), new Float32Array(columnCount)]
  const maxs = [new Float32Array(columnCount), new Float32Array(columnCount), new Float32Array(columnCount)]
  const members = new Float32Array(columnCount)
  const magMins = new Float32Array(columnCount)
  const magMaxs = new Float32Array(columnCount)
  /** 合成に数える向き（消した向きは合成からも外す —— 詳細の窓の合成と同じ）。 */
  const magAxes = magAxesOf(visibleAxes)
  /** 列にサンプルが 1 つでも入ったか（本数を数える起点）。 */
  const filled = new Uint8Array(columnCount)
  /** 成分ごとに、列へ値が入ったか。 */
  const filledAxis = [new Uint8Array(columnCount), new Uint8Array(columnCount), new Uint8Array(columnCount)]

  const rightMs = rightEdgeMsOf(rightEdge, win.firstSampleMs + (count - 1) * win.msPerSample)
  const leftMs = rightMs - spanMs

  /** 1 サンプルの 3 成分。**使い回す**（サンプルごとに配列を作らない）。 */
  const values = [0, 0, 0]
  for (let i = 0; i < count; i += 1) {
    values[0] = win.gal[0][i]
    values[1] = win.gal[1][i]
    values[2] = win.gal[2][i]
    // **成分ごとに読む。** 届かなかった区間は 3 成分そろって `NaN` で入るのでそこで落ちる。
    // 1 成分だけ `NaN`（観測点の合成が解けなかった成分）なら、残りの成分は列へ入れる。
    if (!Number.isFinite(values[0]) && !Number.isFinite(values[1]) && !Number.isFinite(values[2])) continue

    const t = win.firstSampleMs + i * win.msPerSample
    // **右端より新しいサンプルは描かない。** 列の上限へ寄せると、右端の先の値が右端に積まれる。
    if (t > rightMs) continue
    // **右端を含める。** 素直に割ると最後のサンプルだけが `columnCount` 番目
    // （範囲外）へ落ちて、いちばん新しい値が絵から消える。
    const c = Math.min(columnCount - 1, Math.floor(((t - leftMs) / spanMs) * columnCount))
    // 幅より古いサンプル（呼び出し側が抱えている量より狭い幅を指定した場合）。
    if (c < 0) continue

    const m = win.memberCount[i]
    const mag = vectorMagnitudeOf3(values[0], values[1], values[2], magAxes)
    if (filled[c] === 0) {
      filled[c] = 1
      members[c] = m
      magMins[c] = mag
      magMaxs[c] = mag
    } else {
      // **いちばん少ない本数を採る。** 裏付けが 1 本まで落ちた瞬間が列の中に
      // あれば、その列は「裏付けが無い」として示す（見落とす方が重い）。
      if (m < members[c]) members[c] = m
      // **`NaN` の端は必ず置き換える**（`v < NaN` は偽なので、比べるだけだと最初の欠けが居座る）。
      if (Number.isFinite(mag)) {
        if (!Number.isFinite(magMins[c]) || mag < magMins[c]) magMins[c] = mag
        if (!Number.isFinite(magMaxs[c]) || mag > magMaxs[c]) magMaxs[c] = mag
      }
    }
    for (let a = 0; a < 3; a += 1) {
      const v = values[a]
      if (!Number.isFinite(v)) continue
      if (filledAxis[a][c] === 0) {
        filledAxis[a][c] = 1
        mins[a][c] = v
        maxs[a][c] = v
      } else {
        if (v < mins[a][c]) mins[a][c] = v
        if (v > maxs[a][c]) maxs[a][c] = v
      }
    }
  }

  let peak = 0
  let hasAnyValue = false
  const columns: WaveColumn[] = []
  for (let c = 0; c < columnCount; c += 1) {
    if (filled[c] === 0) {
      columns.push(NO_VALUE)
      continue
    }
    // **`hasAnyValue` は向きの取捨に左右させない**（「その区間に届いているか」の話）。
    hasAnyValue = true
    const end = (arrays: Float32Array[], a: number): number => (filledAxis[a][c] === 1 ? arrays[a][c] : NaN)
    for (let a = 0; a < 3; a += 1) {
      if (visibleAxes !== undefined && visibleAxes[a] === false) continue
      if (filledAxis[a][c] === 0) continue
      const lo = Math.abs(mins[a][c])
      const hi = Math.abs(maxs[a][c])
      if (lo > peak) peak = lo
      if (hi > peak) peak = hi
    }
    columns.push({
      hasValue: true,
      min: [end(mins, 0), end(mins, 1), end(mins, 2)],
      max: [end(maxs, 0), end(maxs, 1), end(maxs, 2)],
      minMembers: members[c],
      magMin: magMins[c],
      magMax: magMaxs[c],
    })
  }

  return { columns, scaleGal: Math.max(minScaleGal, peak), hasAnyValue }
}

/** 列ごとの平均の線（{@link buildWaveMeanLines}）。**値の無い列は `NaN`**（描く側はそこで線を切る）。 */
export interface WaveMeanLines {
  /** 成分ごとの正側・負側の平均（東西・南北・上下の順）。 */
  readonly axes: readonly { readonly pos: Float32Array; readonly neg: Float32Array }[]
  /** 合成を前後 1 秒で均した線。 */
  readonly compositeSmooth: Float32Array
}

/**
 * 抱えている窓から、列ごとの平均の線を作る（地図の下端の波形を展開したときに重ねる）。
 *
 * **計算は詳細の窓・管理コンソールと共有する**（`utils/waveMeanLines.ts`。前後 1 秒）。サンプルごとに出した平均を、
 * 列ごとに平均して 1 点にする —— 1 秒で均した線は列（60 秒を画面幅で割った 0.1 秒ほど）の中でほとんど動かない。
 *
 * **合成は見えている向きだけで出す**（{@link buildWaveColumns} と同じ）。
 */
export function buildWaveMeanLines(params: {
  window: SeismoWaveWindow
  columnCount: number
  spanMs: number
  rightEdge: WaveRightEdge
  visibleAxes?: readonly boolean[]
  /**
   * 成分の正側・負側の平均も作るか。**作らなければ `axes` はすべて `NaN`。** 畳んだ合成は合成の均した線しか使わないので、
   * 0.3 秒ごとに 3 成分ぶんの移動平均を回さずに済ませる（常時表示の端末の負荷）。
   */
  includeAxes: boolean
}): WaveMeanLines {
  const { window: win, columnCount, spanMs, rightEdge, visibleAxes, includeAxes } = params
  const n = win.gal[0].length
  const empty = (): Float32Array => new Float32Array(Math.max(0, columnCount)).fill(NaN)
  if (columnCount <= 0 || !(spanMs > 0) || n === 0) {
    return { axes: [0, 1, 2].map(() => ({ pos: empty(), neg: empty() })), compositeSmooth: empty() }
  }
  const t = new Float64Array(n)
  for (let i = 0; i < n; i += 1) t[i] = win.firstSampleMs + i * win.msPerSample
  const series = { t, length: n }
  const magAxes = magAxesOf(visibleAxes)
  const mag = new Float32Array(n)
  for (let i = 0; i < n; i += 1) mag[i] = vectorMagnitudeOf3(win.gal[0][i], win.gal[1][i], win.gal[2][i], magAxes)

  const rightMs = rightEdgeMsOf(rightEdge, t[n - 1])
  const leftMs = rightMs - spanMs
  /** 右端より新しいサンプルは `-1`（どの列にも入れない）。 */
  const columnOf = (i: number): number =>
    t[i] > rightMs ? -1 : Math.min(columnCount - 1, Math.floor(((t[i] - leftMs) / spanMs) * columnCount))
  /** サンプルごとの値を、列ごとの平均へ落とす。 */
  const toColumns = (values: ArrayLike<number>): Float32Array => {
    const sum = new Float64Array(columnCount)
    const cnt = new Uint32Array(columnCount)
    for (let i = 0; i < n; i += 1) {
      const v = values[i]
      if (!Number.isFinite(v)) continue
      const c = columnOf(i)
      if (c < 0) continue
      sum[c] += v
      cnt[c] += 1
    }
    const out = new Float32Array(columnCount)
    for (let c = 0; c < columnCount; c += 1) out[c] = cnt[c] === 0 ? NaN : sum[c] / cnt[c]
    return out
  }
  return {
    axes: [0, 1, 2].map((a) => {
      if (!includeAxes) return { pos: empty(), neg: empty() }
      const { pos, neg } = signedMovingAverages(series, win.gal[a], MEAN_LINE_WINDOW_MS)
      return { pos: toColumns(pos), neg: toColumns(neg) }
    }),
    compositeSmooth: toColumns(movingAverage(series, mag, MEAN_LINE_WINDOW_MS)),
  }
}

/** 合成に数える向き。**消した向きは合成からも外す**（詳細の窓の合成と同じ）。 */
function magAxesOf(visibleAxes: readonly boolean[] | undefined): [boolean, boolean, boolean] {
  return [0, 1, 2].map((a) => visibleAxes === undefined || visibleAxes[a] !== false) as [boolean, boolean, boolean]
}
