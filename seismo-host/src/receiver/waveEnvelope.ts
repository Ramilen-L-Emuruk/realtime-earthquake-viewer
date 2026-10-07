// 読み返した合成波形を、画面の列の数まで落とす。
//
// **点を間引かない。列ごとに上下の端を取る。** 「n 個おきに 1 点」の形にすると、いちばん
// 見たいピークが確率的に消える —— 10 分ぶん（6 万点）を 300 列へ落とすなら 200 点に 1 点
// しか見ないことになり、単発の跳ね上がりはまず絵に出ない。上下を取って縦棒で結べば
// 振幅が保たれる（PWA 側の `src/components/SeismoWaveChart/waveColumns.ts`・管理コンソールの
// 波形タブと同じ方針）。
//
// **落とすのはサーバー側の仕事。** 10 分ぶんの生の値は 3 軸で 18 万個あり、JSON にすれば
// 数 MB になる。描く側が使うのは列ごとの上下だけなので、送ってから捨てる形は通信量が丸ごと無駄。
//
// **値を持たない列は持たないまま返す**（`null`）。描く側はそこで線を切る —— 埋めると、
// 届いていない区間が「静かだった区間」に化ける。

import type { ArchivedWaveChunk } from './waveArchive'

/** 列 1 つぶん。**値を持たない列は `null`** なので、ここに「無い」状態は無い。 */
export interface WaveEnvelopeColumn {
  /** 3 成分それぞれの下端（gal）。 */
  readonly min: readonly [number, number, number]
  /** 3 成分それぞれの上端（gal）。 */
  readonly max: readonly [number, number, number]
  /**
   * その列に効いたセンサーの最小本数。
   *
   * 1 以下のところは合成の裏付けが無い（1 台だけの値）。**いちばん少ない本数を採る** ——
   * 裏付けが 1 本まで落ちた瞬間が列の中にあれば、その列は「裏付けが無い」として示す
   * （見落とすほうが重い）。
   */
  readonly minMembers: number
}

export interface WaveEnvelope {
  /** 列の左端（unix ミリ秒）。**問い合わせの範囲の始まりと同じ。** */
  readonly fromMs: number
  /**
   * 1 列の幅（ミリ秒）。
   *
   * **受け手に割り算をさせない。** 列 i が覆うのは `fromMs + i * columnSpanMs` から
   * その次まで —— 範囲と列数から同じ値を出せるが、2 箇所で解くと端の扱い（右端を
   * 含めるか）が片方だけずれる。
   */
  readonly columnSpanMs: number
  readonly columns: readonly (WaveEnvelopeColumn | null)[]
  /** 値を持つ列が 1 つでもあるか。**無ければ描く意味が無い。** */
  readonly hasAnyValue: boolean
  /** 3 成分を通した最大の絶対値（gal）。**値のある列が無ければ 0。** */
  readonly peakGal: number
}

const EMPTY: WaveEnvelope = {
  fromMs: 0,
  columnSpanMs: 0,
  columns: [],
  hasAnyValue: false,
  peakGal: 0,
}

/**
 * まとまりの並びを列へ落とす。
 *
 * @param fromMs 範囲の始まり（この時刻が左端）。
 * @param toMs 範囲の終わり。**この時刻のサンプルも最後の列へ含める。**
 */
export function buildWaveEnvelope(params: {
  readonly chunks: readonly ArchivedWaveChunk[]
  readonly fromMs: number
  readonly toMs: number
  readonly columnCount: number
}): WaveEnvelope {
  const { chunks, fromMs, toMs, columnCount } = params
  const span = toMs - fromMs
  if (columnCount <= 0 || !Number.isFinite(span) || span <= 0) {
    return { ...EMPTY, fromMs: Number.isFinite(fromMs) ? fromMs : 0 }
  }

  const mins = [
    new Float64Array(columnCount),
    new Float64Array(columnCount),
    new Float64Array(columnCount),
  ]
  const maxs = [
    new Float64Array(columnCount),
    new Float64Array(columnCount),
    new Float64Array(columnCount),
  ]
  const members = new Float64Array(columnCount)
  const filled = new Uint8Array(columnCount)

  for (const chunk of chunks) {
    const count = chunk.gal[0].length
    for (let i = 0; i < count; i += 1) {
      const ns = chunk.gal[0][i]
      const ew = chunk.gal[1][i]
      const ud = chunk.gal[2][i]
      // **1 成分でも読めなければ、そのサンプルは無かったことにする。** 届かなかった
      // 区間は 3 成分そろって読めない形で入る。
      if (!Number.isFinite(ns) || !Number.isFinite(ew) || !Number.isFinite(ud)) continue

      const t = chunk.firstSampleMs + i * chunk.msPerSample
      if (t < fromMs || t > toMs) continue
      // **右端を含める。** 素直に割ると `toMs` ちょうどのサンプルだけが範囲外の列へ
      // 落ちて、いちばん新しい値が絵から消える。
      const c = Math.min(columnCount - 1, Math.floor(((t - fromMs) / span) * columnCount))

      const m = chunk.memberCount[i]
      if (filled[c] === 0) {
        filled[c] = 1
        mins[0][c] = ns
        maxs[0][c] = ns
        mins[1][c] = ew
        maxs[1][c] = ew
        mins[2][c] = ud
        maxs[2][c] = ud
        members[c] = m
      } else {
        if (ns < mins[0][c]) mins[0][c] = ns
        if (ns > maxs[0][c]) maxs[0][c] = ns
        if (ew < mins[1][c]) mins[1][c] = ew
        if (ew > maxs[1][c]) maxs[1][c] = ew
        if (ud < mins[2][c]) mins[2][c] = ud
        if (ud > maxs[2][c]) maxs[2][c] = ud
        if (m < members[c]) members[c] = m
      }
    }
  }

  let peakGal = 0
  let hasAnyValue = false
  const columns: (WaveEnvelopeColumn | null)[] = []
  for (let c = 0; c < columnCount; c += 1) {
    if (filled[c] === 0) {
      columns.push(null)
      continue
    }
    hasAnyValue = true
    for (let a = 0; a < 3; a += 1) {
      const lo = Math.abs(mins[a][c])
      const hi = Math.abs(maxs[a][c])
      if (lo > peakGal) peakGal = lo
      if (hi > peakGal) peakGal = hi
    }
    columns.push({
      min: [mins[0][c], mins[1][c], mins[2][c]],
      max: [maxs[0][c], maxs[1][c], maxs[2][c]],
      minMembers: members[c],
    })
  }

  return { fromMs, columnSpanMs: span / columnCount, columns, hasAnyValue, peakGal }
}
