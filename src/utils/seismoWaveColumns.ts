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
// **手元のバッファは伸ばさない**（`WAVE_RETAIN_SEC` は 60 秒のまま）。継ぎ足した列は
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
  const added = new Map<number, { min: [number, number, number]; max: [number, number, number]; members: number }>()

  for (let i = 0; i < count; i += 1) {
    const ns = win.gal[0][i]
    const ew = win.gal[1][i]
    const ud = win.gal[2][i]
    // **1 成分でも読めなければ、そのサンプルは無かったことにする**（`waveColumns.ts` と同じ）。
    if (!Number.isFinite(ns) || !Number.isFinite(ew) || !Number.isFinite(ud)) continue

    const t = win.firstSampleMs + i * win.msPerSample
    const c = Math.floor((t - base.fromMs) / span)
    if (c < startIndex || c > maxIndex) continue

    const m = win.memberCount[i]
    const cur = added.get(c)
    if (cur === undefined) {
      added.set(c, { min: [ns, ew, ud], max: [ns, ew, ud], members: m })
      continue
    }
    if (ns < cur.min[0]) cur.min[0] = ns
    if (ns > cur.max[0]) cur.max[0] = ns
    if (ew < cur.min[1]) cur.min[1] = ew
    if (ew > cur.max[1]) cur.max[1] = ew
    if (ud < cur.min[2]) cur.min[2] = ud
    if (ud > cur.max[2]) cur.max[2] = ud
    // **いちばん少ない本数を採る**（裏付けが落ちた瞬間を見落とさない）。
    if (m < cur.members) cur.members = m
  }

  if (added.size === 0) return base

  const highest = Math.max(...added.keys())
  const next: (WaveHistoryColumn | null)[] = base.columns.slice(0, startIndex)
  for (let c = startIndex; c <= highest; c += 1) {
    const a = added.get(c)
    // **間が空いたら空のまま置く。** 詰めると、そこだけ時間の縮んだ絵になる。
    next.push(a === undefined ? null : { min: a.min, max: a.max, minMembers: a.members })
  }
  return { ...base, columns: next }
}
