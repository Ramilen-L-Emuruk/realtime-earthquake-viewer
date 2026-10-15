// 読み返した初動の続きを、押し出しで届いた波形から作って継ぎ足す。
//
// **取りに行くのは最初の 1 回だけ。** アプリは常時リアルタイムで受信しているので
// （設定が `off` でなければ購読は張りっぱなし）、初動より後は手元の窓から作れる
// ——定期的に読み返すのは同じものを 2 度取ることになる（2026-09-30 のユーザー指摘
// 「繋げればいいじゃん」）。
//
// **粒度を揃えてから繋ぐ。** 読み返しは列（上下の端）、押し出しは生のサンプル。
// 押し出しの側を同じ `columnSpanMs` の列へ畳めば、境目のない 1 本の絵になる。
//
// **手元のバッファは伸ばさない**（`WAVE_RETAIN_SEC` は下部の波形の時間幅のいちばん長いもの・180 秒のまま）。継ぎ足した列は
// こちらが保持するので、生のサンプルは直近だけあればよい。

import type { WaveHistoryColumn } from '../services/seismoWaveHistory'
import type { SeismoWaveWindow } from './seismoWaveBuffer'

/** 時刻の起点と刻みを持つ列の束。**値の無い列は `null`。** */
export interface TimedColumns {
  /** 先頭の列が覆う範囲の始まり。 */
  readonly fromMs: number
  /** 1 列が覆う長さ（ms）。 */
  readonly columnSpanMs: number
  readonly columns: readonly (WaveHistoryColumn | null)[]
}

/** 値を持つ最後の列の番号。**1 つも無ければ `-1`。** */
export function lastFilledIndex(columns: readonly (WaveHistoryColumn | null)[]): number {
  for (let i = columns.length - 1; i >= 0; i -= 1) {
    if (columns[i] !== null) return i
  }
  return -1
}

/**
 * 列の束が合成（`magMin`/`magMax`）を持っているか。**値のある列がすべて持っているときだけ `complete`。**
 *
 * **1 列でも欠けていれば合成で描かない。** 合成を返さない古いホストの列と、押し出しで継ぎ足した列
 * （こちらは必ず合成を持つ）が混ざると、合成の線は継ぎ足した区間にだけ現れ、読み返した区間は
 * 値が届いているのに空いて見える —— 揺れていないように読める。3 成分を重ねた絵へ戻すほうがよい。
 */
export interface CompositeCoverage {
  /** 値のある列（`null` でない列）の数。 */
  readonly valued: number
  /** そのうち合成を持つ列の数。 */
  readonly withComposite: number
  readonly complete: boolean
}

export function compositeCoverage(columns: readonly (WaveHistoryColumn | null)[]): CompositeCoverage {
  let valued = 0
  let withComposite = 0
  for (const c of columns) {
    if (c === null) continue
    valued += 1
    if (Number.isFinite(c.magMin) && Number.isFinite(c.magMax)) withComposite += 1
  }
  return { valued, withComposite, complete: withComposite === valued }
}

/**
 * 合成を前後 `windowMs` の幅で均した線を、**列ごとに 1 点**で返す（値の無い列は `NaN`）。地震カードの合成に重ねる。
 *
 * **列の和と数をまとめて割る**（`magSum`・`magCount`）。列の中心が `windowMs / 2` 以内に入る列を数える ——
 * サンプルで均す `utils/waveMeanLines.ts` の `movingAverage` と同じ幅で、窓の端が列 1 つぶん（カードでは 0.2 秒ほど）
 * 粗いだけの違い。
 *
 * **値のある列のうち 1 列でも材料を持たなければ `null`**（{@link compositeCoverage} と同じ考え方）。材料を返さない古い
 * ホストの列と、押し出しで継ぎ足した列（必ず持つ）が混ざると、線が継ぎ足した区間にだけ現れて読み返した区間が
 * 空いて見える —— 揺れの輪郭がそこで途切れたように読める。
 */
export function smoothCompositeColumns(base: TimedColumns, windowMs: number): Float32Array | null {
  const n = base.columns.length
  const span = base.columnSpanMs
  if (n === 0 || !(span > 0) || !(windowMs > 0)) return null
  // 列の和と数の累積（`prefix[i]` は 0〜i-1 列の合計）。
  const sumPrefix = new Float64Array(n + 1)
  const cntPrefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i += 1) {
    const c = base.columns[i]
    let s = 0
    let k = 0
    if (c !== null) {
      if (!(c.magCount > 0) || !Number.isFinite(c.magSum)) return null
      s = c.magSum
      k = c.magCount
    }
    sumPrefix[i + 1] = sumPrefix[i] + s
    cntPrefix[i + 1] = cntPrefix[i] + k
  }
  /** 中心から何列先までを窓に入れるか。 */
  const reach = Math.floor(windowMs / 2 / span + 1e-9)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    // **元の列に値が無ければ `NaN`** —— 途切れで線を切る扱いを均した線でも保つ（`movingAverage` と同じ）。
    if (base.columns[i] === null) {
      out[i] = Number.NaN
      continue
    }
    const lo = Math.max(0, i - reach)
    const hi = Math.min(n, i + reach + 1)
    const cnt = cntPrefix[hi] - cntPrefix[lo]
    out[i] = cnt > 0 ? (sumPrefix[hi] - sumPrefix[lo]) / cnt : Number.NaN
  }
  return out
}

/**
 * 切り出した列（`part`）に沿って、均した線を返す。**均すのは切り出す前の列（`base`）で行う** —— 切り出した後で均すと、
 * 範囲の端の列が窓の外側（値はある）を取り込めず、端だけ生の値に寄る。
 *
 * `part` が `base` の列の境目に揃っていないとき（刻みが違う・起点がずれている・範囲の外）は、`part` だけで均す
 * （端が粗くなるだけで、別の時刻の値を描くことはない）。
 *
 * **前提: 列の刻みが窓の半分（0.5 秒）より細かいこと。** 刻みがそれ以上だと前後の列が窓に入らず、列ごとの平均になる
 * （地震カードは 5 分を 1200 列で、刻みは 0.25 秒ほど）。
 */
export function smoothCompositeWithin(base: TimedColumns, part: TimedColumns, windowMs: number): Float32Array | null {
  const span = base.columnSpanMs
  const offset = span > 0 ? (part.fromMs - base.fromMs) / span : Number.NaN
  const first = Math.round(offset)
  const aligned =
    Math.abs(part.columnSpanMs - span) <= 1e-6 &&
    Math.abs(offset - first) <= 1e-6 &&
    first >= 0 &&
    first + part.columns.length <= base.columns.length
  if (!aligned) return smoothCompositeColumns(part, windowMs)
  // **材料の有無は切り出した範囲で決める**（範囲の外に古い列が残っていても、見えている区間で線を引けるように）。
  const inner = smoothCompositeColumns(part, windowMs)
  if (inner === null) return null
  // 範囲の外に材料の無い列があれば、外側を借りずに切り出した列で均した線を使う（端が粗くなるだけ）。
  const whole = smoothCompositeColumns(base, windowMs)
  return whole === null ? inner : whole.slice(first, first + part.columns.length)
}

/**
 * 値を持つ最後の列までで切る。
 *
 * **空の区間を描かない**（2026-09-30 のユーザー指摘「終端はそれに合わせてカットしてほしい。
 * 揺れが無いみたいなので」）。要求した窓の右端はまだ来ていない時刻を含むので、そのまま
 * 描くと**絵の大半が空**になる。
 *
 * **変わらなければ同じ参照を返す。** 描き直しの判定に参照を使えるようにするため。
 */
export function trimTrailingGap(base: TimedColumns): TimedColumns {
  const last = lastFilledIndex(base.columns)
  if (last === base.columns.length - 1) return base
  return { ...base, columns: base.columns.slice(0, last + 1) }
}

/**
 * `limitMs` より後の列を落とす。
 *
 * **後から現れた地震に合わせて、既に繋いだ分を切り戻すために要る。** 繋いでいる最中は
 * その地震がいちばん新しいので右端の打ち切りが無く、**次の有感地震の電文が届くまでの間
 * （実測でおよそ 90 秒）に「次の地震の揺れ」を取り込んでしまう**。足すときの上限
 * （{@link appendWaveWindow} の `limitMs`）だけでは、既に入った分は残ったまま。
 *
 * **境界は `appendWaveWindow` と揃える** ——`limitMs` を含む列までは残す。揃えないと、
 * 切り戻した直後の繋ぎ足しが同じ列を足し直して行ったり来たりする。
 *
 * **変わらなければ同じ参照を返す**（描き直しの判定に参照を使う）。
 */
export function trimAfter(base: TimedColumns, limitMs: number): TimedColumns {
  // 打ち切りが無い（いちばん新しい地震）ときは `Infinity` が来る。
  if (!Number.isFinite(limitMs)) return base
  const span = base.columnSpanMs
  if (!(span > 0)) return base
  const keep = Math.floor((limitMs - base.fromMs) / span) + 1
  if (keep >= base.columns.length) return base
  return { ...base, columns: keep <= 0 ? [] : base.columns.slice(0, keep) }
}

/**
 * 末尾の一定時間ぶんが静穏か（＝揺れが収まったか）。
 *
 * **時間で打ち切るのではなく、収まったかで決めるための判定**（2026-09-30 のユーザー判断）。
 * 「発生から N 分」で切ると、長く揺れる大地震でいちばん見たい後半が入らない。
 *
 * **その長さぶんの列がまだ無ければ「収まっていない」とする。** 足りない材料で
 * 「静か」と判断すると、**繋ぎ始めた直後に打ち切る**（初動の直前は必ず静かなので）。
 *
 * @param quietGal これを下回っていれば静穏とみなす（3 成分の絶対値のいずれも）。
 */
export function isSettled(base: TimedColumns, windowMs: number, quietGal: number): boolean {
  const last = lastFilledIndex(base.columns)
  if (last < 0) return false
  const span = base.columnSpanMs
  if (!(span > 0)) return false
  const need = Math.ceil(windowMs / span)
  // **末尾がまだその長さに満たない。** 判定できないので収まっていないほうへ倒す。
  if (last + 1 < need) return false

  for (let i = last; i > last - need; i -= 1) {
    const col = base.columns[i]
    // **値の無い列は静穏と見なさない。** 届いていないだけで、揺れていないことの証明ではない。
    if (col === null) return false
    // **値の無い成分（`NaN`）は判断に入れない**（観測点の合成が解けなかった成分）。解けた成分で収まりを見る ——
    // 欠けた成分を「揺れている」へ倒すと、上を解けない観測点のカードは打ち切りの上限まで伸び続ける。
    // `Math.abs(NaN) >= quietGal` は偽なので、比べるだけでそうなる。
    for (let a = 0; a < 3; a += 1) {
      if (Math.abs(col.min[a]) >= quietGal || Math.abs(col.max[a]) >= quietGal) return false
    }
  }
  return true
}

/**
 * 押し出しの窓から続きを作って足す。
 *
 * **既に値のある列は上書きしない。** 読み返した値（ホストが保存したもの）と押し出しの値は
 * 同じはずだが、重なる区間で入れ替えても得るものが無い —— **書き換えると、同じ絵が
 * 描き直しのたびに微妙に変わる**（列の境目に入るサンプルが変わるため）。
 *
 * @param limitMs これ以降は足さない（地震の発生 + 窓の長さ）。**上限が無いと、
 *   揺れていない時間がいつまでも右へ伸びる。**
 */
export function appendWaveWindow(params: {
  base: TimedColumns
  window: SeismoWaveWindow | null
  limitMs: number
}): TimedColumns {
  const { base, window: win, limitMs } = params
  if (win === null) return base
  const span = base.columnSpanMs
  if (!(span > 0)) return base
  const count = win.gal[0].length
  if (count === 0) return base

  // 既にある列の次から。**値のある最後の列は触らない**（上記）。
  const startIndex = lastFilledIndex(base.columns) + 1
  // 足せる上限（この列の始まりが `limitMs` を超えたら打ち切る）。
  const maxIndex = Math.floor((limitMs - base.fromMs) / span)
  if (startIndex > maxIndex) return base

  // 追加ぶんの集計。**列の番号で引ける疎な入れ物**（届いていない時間帯は空のまま）。
  const added = new Map<
    number,
    {
      min: [number, number, number]
      max: [number, number, number]
      members: number
      magMin: number
      magMax: number
      magSum: number
      magCount: number
    }
  >()

  for (let i = 0; i < count; i += 1) {
    const values = [win.gal[0][i], win.gal[1][i], win.gal[2][i]] as const
    // **成分ごとに読む**（`waveColumns.ts` と同じ）。3 成分とも読めないサンプルだけを無かったことにする。
    if (!values.some((v) => Number.isFinite(v))) continue

    const t = win.firstSampleMs + i * win.msPerSample
    const c = Math.floor((t - base.fromMs) / span)
    if (c < startIndex || c > maxIndex) continue

    const m = win.memberCount[i]
    // **合成はサンプルごとに出す**（ホストの `waveEnvelope.ts` と同じ。解けた成分だけで）。
    const mag = vectorMagnitudeOf(values)
    const cur = added.get(c)
    if (cur === undefined) {
      // 読めない成分は `NaN` のまま置く（下の比較は `NaN` を必ず上書きする形にしてある）。
      added.set(c, {
        min: [values[0], values[1], values[2]],
        max: [values[0], values[1], values[2]],
        members: m,
        magMin: mag,
        magMax: mag,
        magSum: mag,
        magCount: 1,
      })
      continue
    }
    cur.magSum += mag
    cur.magCount += 1
    if (mag < cur.magMin) cur.magMin = mag
    if (mag > cur.magMax) cur.magMax = mag
    for (let a = 0; a < 3; a += 1) {
      const v = values[a]!
      if (!Number.isFinite(v)) continue
      // **`NaN` の端は必ず置き換える**（`v < NaN` は偽なので、比べるだけだと最初の欠けが居座る）。
      if (!Number.isFinite(cur.min[a]!) || v < cur.min[a]!) cur.min[a] = v
      if (!Number.isFinite(cur.max[a]!) || v > cur.max[a]!) cur.max[a] = v
    }
    // **いちばん少ない本数を採る**（裏付けが落ちた瞬間を見落とさない）。
    if (m < cur.members) cur.members = m
  }

  if (added.size === 0) return base

  const highest = Math.max(...added.keys())
  const next: (WaveHistoryColumn | null)[] = base.columns.slice(0, startIndex)
  for (let c = startIndex; c <= highest; c += 1) {
    const a = added.get(c)
    // **間が空いたら空のまま置く。** 詰めると、そこだけ時間の縮んだ絵になる。
    next.push(
      a === undefined
        ? null
        : {
            min: a.min,
            max: a.max,
            minMembers: a.members,
            magMin: a.magMin,
            magMax: a.magMax,
            magSum: a.magSum,
            magCount: a.magCount,
          },
    )
  }
  return { ...base, columns: next }
}

/** 取り直す列の範囲（{@link revisedColumnSpan}）。`first` 番目から `count` 列・時刻では `[fromMs, toMs)`。 */
export interface RevisedColumnSpan {
  readonly first: number
  readonly count: number
  readonly fromMs: number
  readonly toMs: number
}

/**
 * ホストが作り直した範囲 `[fromMs, toMs)` に掛かる列を、列の境目へ揃えて返す（#597）。
 * **持っている列の外は含めない。掛かる列が無ければ `null`。**
 *
 * **境目へ揃えるのは、取り直した列をそのまま差し替えるため。** ホストは頼まれた範囲を頼まれた列数で
 * 等分して返すので（`seismo-host/src/receiver/waveEnvelope.ts`）、境目から列数ぶんを頼めば同じ刻みで返る。
 *
 * **持っている列の外を含めないのは、継ぎ足しの起点を動かさないため。** {@link appendWaveWindow} は
 * 値のある最後の列の次から足すので、先の列を埋めるとその間を押し出しで足せなくなる。
 */
export function revisedColumnSpan(base: TimedColumns, fromMs: number, toMs: number): RevisedColumnSpan | null {
  const span = base.columnSpanMs
  if (!(span > 0) || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null
  const first = Math.max(0, Math.floor((fromMs - base.fromMs) / span))
  const end = Math.min(base.columns.length, Math.ceil((toMs - base.fromMs) / span))
  if (end <= first) return null
  return { first, count: end - first, fromMs: base.fromMs + first * span, toMs: base.fromMs + end * span }
}

/**
 * ホストから取り直した列で差し替える（#597）。**変わらなければ同じ参照を返す。**
 *
 * **ホストが値を持つ列だけを差し替える。** 穴だった列も、押し出しで作った列も、取り戻した区間では
 * ホストのほうが材料が揃っている（押し出しの列は届いた分だけで上下の端を取っている）。**ホストが値を
 * 持たない列は触らない** —— 値のある列を穴へ戻すと、見えていたものが消える。
 *
 * **起点か刻みが列の境目と合わなければ何もしない。** ずれた列を差し込むと、別の時刻の値を描くことになる。
 */
export function spliceRevisedColumns(
  base: TimedColumns,
  revised: { readonly fromMs: number; readonly columnSpanMs: number; readonly columns: readonly (WaveHistoryColumn | null)[] },
): TimedColumns {
  const span = base.columnSpanMs
  if (!(span > 0) || Math.abs(revised.columnSpanMs - span) > 1e-6) return base
  const offset = (revised.fromMs - base.fromMs) / span
  const first = Math.round(offset)
  if (Math.abs(offset - first) > 1e-6) return base

  let next: (WaveHistoryColumn | null)[] | null = null
  for (let i = 0; i < revised.columns.length; i += 1) {
    const at = first + i
    if (at < 0) continue
    if (at >= base.columns.length) break
    const col = revised.columns[i]
    if (col === null) continue
    next ??= base.columns.slice()
    next[at] = col
  }
  return next === null ? base : { ...base, columns: next }
}

/**
 * 1 サンプルの合成（ベクトルの大きさ）。**解けた成分（有限）だけで出す。** 1 つも解けていなければ `NaN`。
 *
 * ホスト（`seismo-host/src/receiver/waveEnvelope.ts`）と同じ数え方 —— 読み返した列と押し出しで継ぎ足した列が
 * 同じ絵の中で並ぶので、数え方がずれると継ぎ目で合成の大きさが跳ぶ。
 */
export function vectorMagnitudeOf(values: readonly number[]): number {
  let sq = 0
  let any = false
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    sq += v * v
    any = true
  }
  return any ? Math.sqrt(sq) : Number.NaN
}

/**
 * 3 成分のうち `use` が真の成分だけで出す合成。**{@link vectorMagnitudeOf} と同じ数え方**で、
 * 配列を作らない —— 描き直しのたびに 6000 サンプルぶん回すので、サンプルごとの小さな配列が積み上がる。
 */
export function vectorMagnitudeOf3(
  x: number,
  y: number,
  z: number,
  use: readonly [boolean, boolean, boolean],
): number {
  const vx = use[0] && Number.isFinite(x)
  const vy = use[1] && Number.isFinite(y)
  const vz = use[2] && Number.isFinite(z)
  if (!vx && !vy && !vz) return Number.NaN
  return Math.sqrt((vx ? x * x : 0) + (vy ? y * y : 0) + (vz ? z * z : 0))
}
