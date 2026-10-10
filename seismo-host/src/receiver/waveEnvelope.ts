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
//
// **成分ごとに見る。** 観測点の合成は、測る向きが 3 方向へ散っていない間、解けない成分
// （水平の台だけのときの上）だけを NaN にして残りを出す（`sensorFusion.ts`・2026-10-09 ユーザー承認）。
// その列の上下端は解けた成分だけで取り、解けなかった成分は NaN のまま返す（JSON では `null`）。

import type { ArchivedWaveChunk } from './waveArchive'

/** 列 1 つぶん。**値を持たない列は `null`** なので、ここに「無い」状態は無い。 */
export interface WaveEnvelopeColumn {
  /** 3 成分それぞれの下端（gal）。**その成分の値が列に 1 つも無ければ NaN**（JSON では `null`）。 */
  readonly min: readonly [number, number, number]
  /** 3 成分それぞれの上端（gal）。**その成分の値が列に 1 つも無ければ NaN**（JSON では `null`）。 */
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
  /** 列にサンプルが 1 つでも入ったか（本数を数える起点）。 */
  const filled = new Uint8Array(columnCount)
  /** 成分ごとに、列へ値が入ったか。 */
  const filledAxis = [new Uint8Array(columnCount), new Uint8Array(columnCount), new Uint8Array(columnCount)]

  for (const chunk of chunks) {
    const count = chunk.gal[0].length
    for (let i = 0; i < count; i += 1) {
      // **成分ごとに読む。** 解けなかった成分（NaN）だけを飛ばし、解けた成分は列へ入れる。
      // 3 成分とも読めないサンプル（届かなかった区間）は無かったことにする。
      const values = [chunk.gal[0][i]!, chunk.gal[1][i]!, chunk.gal[2][i]!]
      if (!values.some((v) => Number.isFinite(v))) continue

      const t = chunk.firstSampleMs + i * chunk.msPerSample
      if (t < fromMs || t > toMs) continue
      // **右端を含める。** 素直に割ると `toMs` ちょうどのサンプルだけが範囲外の列へ
      // 落ちて、いちばん新しい値が絵から消える。
      const c = Math.min(columnCount - 1, Math.floor(((t - fromMs) / span) * columnCount))

      const m = chunk.memberCount[i]
      if (filled[c] === 0) {
        filled[c] = 1
        members[c] = m
      } else if (m < members[c]) {
        members[c] = m
      }
      for (let a = 0; a < 3; a += 1) {
        const v = values[a]!
        if (!Number.isFinite(v)) continue
        if (filledAxis[a]![c] === 0) {
          filledAxis[a]![c] = 1
          mins[a]![c] = v
          maxs[a]![c] = v
        } else {
          if (v < mins[a]![c]!) mins[a]![c] = v
          if (v > maxs[a]![c]!) maxs[a]![c] = v
        }
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
    const end = (arrays: Float64Array[], a: number): number => (filledAxis[a]![c] === 1 ? arrays[a]![c]! : Number.NaN)
    for (let a = 0; a < 3; a += 1) {
      if (filledAxis[a]![c] === 0) continue
      const lo = Math.abs(mins[a]![c]!)
      const hi = Math.abs(maxs[a]![c]!)
      if (lo > peakGal) peakGal = lo
      if (hi > peakGal) peakGal = hi
    }
    columns.push({
      min: [end(mins, 0), end(mins, 1), end(mins, 2)],
      max: [end(maxs, 0), end(maxs, 1), end(maxs, 2)],
      minMembers: members[c]!,
    })
  }

  return { fromMs, columnSpanMs: span / columnCount, columns, hasAnyValue, peakGal }
}
