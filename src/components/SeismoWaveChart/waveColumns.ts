// 抱えている波形（60 秒 × 100 Hz ＝ 6000 サンプル）を、画面幅の列へ落とす。
//
// **点を間引かない。列ごとに上下の端を取る。** 「n 個おきに 1 点」の形にすると、
// いちばん見たいピークが確率的に消える —— 6000 点を 300 列へ落とすなら 20 点に 1 点
// しか見ないので、単発の跳ね上がりは 95% の確率で絵に出ない。上下を取って縦棒で
// 結べば振幅が保たれる（管理コンソールの波形タブと同じ方針）。
//
// **時間軸は右端を「最後に届いたサンプル」に固定し、そこから遡って引く。**
// 抱えている量が少ないうち（起動直後）は左が空く。全体を引き伸ばす形にすると、
// **10 秒ぶんの絵と 60 秒ぶんの絵が見分けられなくなる**（どちらも画面いっぱいに
// なる）。
//
// **値を持たない列は持たないまま返す。** 描く側はそこで線を切る —— Canvas 2D の
// `lineTo` は非有限の座標を渡すと何もしない（no-op）ので、`NaN` をそのまま渡しても
// 前後の点が 1 本に結ばれるだけ。**欠測を分けて持った意味が描画で消える**
// （`seismoWaveBuffer.ts` のヘッダが避けたいと書いている「そこだけ時間の縮んだ絵」）。

import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'

/** 画面の 1 列ぶん。 */
export interface WaveColumn {
  /**
   * 値を持つか。**持たない列では {@link min}・{@link max} は `NaN`。**
   *
   * 理由は 2 通りあるが描く側の扱いは同じ（線を切る）ので分けていない ——
   * 届かなかった区間（`NaN` で残っている）と、まだ抱えていない区間（起動直後の左側）。
   */
  readonly hasValue: boolean
  /** 3 成分それぞれの下端（gal）。 */
  readonly min: readonly [number, number, number]
  /** 3 成分それぞれの上端（gal）。 */
  readonly max: readonly [number, number, number]
  /**
   * その列に効いたセンサーの最小本数。**値を持たない列では 0。**
   *
   * 1 以下のところは合成の裏付けが無い（1 台だけの値）。
   */
  readonly minMembers: number
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

const NO_VALUE: WaveColumn = {
  hasValue: false,
  min: [NaN, NaN, NaN],
  max: [NaN, NaN, NaN],
  minMembers: 0,
}

/**
 * 窓を列へ落とす。
 *
 * @param spanMs 横軸の幅（ms）。**右端は窓の最後のサンプル。**
 * @param minScaleGal 縦の振れ幅の下限（gal）。
 */
export function buildWaveColumns(params: {
  window: SeismoWaveWindow
  columnCount: number
  spanMs: number
  minScaleGal: number
  /**
   * 振れ幅に数える向き（東西・南北・上下の順）。**省略すれば 3 成分すべて。**
   *
   * **消した向きを分母から外す**（読み返し側の `foldHistoryColumns` と揃える）——
   * 外さないと、いちばん大きい成分を消しても残りが潰れたままになる。
   */
  visibleAxes?: readonly boolean[]
}): WaveColumns {
  const { window: win, columnCount, spanMs, minScaleGal, visibleAxes } = params
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
  const filled = new Uint8Array(columnCount)

  const lastMs = win.firstSampleMs + (count - 1) * win.msPerSample
  const leftMs = lastMs - spanMs

  for (let i = 0; i < count; i += 1) {
    const ew = win.gal[0][i]
    const ns = win.gal[1][i]
    const ud = win.gal[2][i]
    // **1 成分でも読めなければ、そのサンプルは無かったことにする。** 届かなかった
    // 区間は 3 成分そろって `NaN` で入るので、通常はここで 3 つとも落ちる。
    if (!Number.isFinite(ew) || !Number.isFinite(ns) || !Number.isFinite(ud)) continue

    const t = win.firstSampleMs + i * win.msPerSample
    // **右端を含める。** 素直に割ると最後のサンプルだけが `columnCount` 番目
    // （範囲外）へ落ちて、いちばん新しい値が絵から消える。
    const c = Math.min(columnCount - 1, Math.floor(((t - leftMs) / spanMs) * columnCount))
    // 幅より古いサンプル（呼び出し側が抱えている量より狭い幅を指定した場合）。
    if (c < 0) continue

    const m = win.memberCount[i]
    if (filled[c] === 0) {
      filled[c] = 1
      mins[0][c] = ew; maxs[0][c] = ew
      mins[1][c] = ns; maxs[1][c] = ns
      mins[2][c] = ud; maxs[2][c] = ud
      members[c] = m
    } else {
      if (ew < mins[0][c]) mins[0][c] = ew
      if (ew > maxs[0][c]) maxs[0][c] = ew
      if (ns < mins[1][c]) mins[1][c] = ns
      if (ns > maxs[1][c]) maxs[1][c] = ns
      if (ud < mins[2][c]) mins[2][c] = ud
      if (ud > maxs[2][c]) maxs[2][c] = ud
      // **いちばん少ない本数を採る。** 裏付けが 1 本まで落ちた瞬間が列の中に
      // あれば、その列は「裏付けが無い」として示す（見落とす方が重い）。
      if (m < members[c]) members[c] = m
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
    for (let a = 0; a < 3; a += 1) {
      if (visibleAxes !== undefined && visibleAxes[a] === false) continue
      const lo = Math.abs(mins[a][c])
      const hi = Math.abs(maxs[a][c])
      if (lo > peak) peak = lo
      if (hi > peak) peak = hi
    }
    columns.push({
      hasValue: true,
      min: [mins[0][c], mins[1][c], mins[2][c]],
      max: [maxs[0][c], maxs[1][c], maxs[2][c]],
      minMembers: members[c],
    })
  }

  return { columns, scaleGal: Math.max(minScaleGal, peak), hasAnyValue }
}
