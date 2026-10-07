// 読み返した初動へ、押し出しの続きを繋ぐところ。
//
// 固定するのは 3 つ ——**繋ぎ目で上書きしないこと**、**上限で打ち切ること**、
// **空の終端を切ること**（要求した窓の右端はまだ来ていない時刻を含む）。

import { describe, expect, it } from 'vitest'

import type { WaveHistoryColumn } from '../services/seismoWaveHistory'
import type { SeismoWaveWindow } from './seismoWaveBuffer'
import {
  appendWaveWindow,
  isSettled,
  lastFilledIndex,
  revisedColumnSpan,
  spliceRevisedColumns,
  trimAfter,
  trimTrailingGap,
  type TimedColumns,
} from './seismoWaveColumns'

function col(v: number, members = 9): WaveHistoryColumn {
  return { min: [-v, -v, -v], max: [v, v, v], minMembers: members }
}

/** 1 サンプル 10 ms の窓を作る。 */
function win(firstSampleMs: number, values: readonly number[], members = 9): SeismoWaveWindow {
  const n = values.length
  const axis = () => Float32Array.from(values)
  return {
    firstSampleMs,
    msPerSample: 10,
    gal: [axis(), axis(), axis()],
    memberCount: Float32Array.from(new Array(n).fill(members)),
  }
}

/** 起点 1000・1 列 100 ms・最初の 2 列に値がある束。 */
const BASE: TimedColumns = {
  fromMs: 1000,
  columnSpanMs: 100,
  columns: [col(1), col(2), null, null, null],
}

describe('lastFilledIndex', () => {
  it('値を持つ最後の列を返す', () => {
    expect(lastFilledIndex(BASE.columns)).toBe(1)
  })

  it('1 つも無ければ -1', () => {
    expect(lastFilledIndex([null, null])).toBe(-1)
    expect(lastFilledIndex([])).toBe(-1)
  })
})

describe('trimTrailingGap', () => {
  it('末尾の空を切る', () => {
    expect(trimTrailingGap(BASE).columns).toHaveLength(2)
  })

  it('切るものが無ければ同じ参照を返す', () => {
    const full: TimedColumns = { ...BASE, columns: [col(1), col(2)] }
    expect(trimTrailingGap(full)).toBe(full)
  })
})

describe('trimAfter', () => {
  // 起点 1000・1 列 100 ms なので、列 i は [1000 + 100i, 1000 + 100(i+1))。
  const FULL: TimedColumns = { ...BASE, columns: [col(1), col(2), col(3), col(4), col(5)] }

  it('打ち切りより後の列を落とす', () => {
    // 1250 は列 2（1200〜1300）の中。**その列までは残す。**
    expect(trimAfter(FULL, 1250).columns).toHaveLength(3)
  })

  it('境界は appendWaveWindow と揃える（その列の始まりが打ち切り以下なら残す）', () => {
    // **揃えないと、切り戻した直後の繋ぎ足しが同じ列を足し直して往復する。**
    expect(trimAfter(FULL, 1300).columns).toHaveLength(4)
    expect(trimAfter(FULL, 1299).columns).toHaveLength(3)
  })

  it('打ち切りが無ければ（Infinity）そのまま返す', () => {
    // **対照。** いちばん新しい地震には打ち切りが無い。
    expect(trimAfter(FULL, Infinity)).toBe(FULL)
  })

  it('打ち切りが右端より後なら同じ参照を返す', () => {
    expect(trimAfter(FULL, 99_999)).toBe(FULL)
  })

  it('打ち切りが起点より前なら空にする', () => {
    // **安全弁。** 負の長さで `slice` すると末尾から数えてしまう。
    expect(trimAfter(FULL, 0).columns).toEqual([])
  })

  it('列の幅が無ければそのまま返す（0 除算を作らない）', () => {
    const broken: TimedColumns = { ...FULL, columnSpanMs: 0 }
    expect(trimAfter(broken, 1250)).toBe(broken)
  })

  it('途中の空は残す（そこだけ時間が縮むのを避ける）', () => {
    const gapped: TimedColumns = { ...BASE, columns: [col(1), null, col(2), null] }
    const out = trimTrailingGap(gapped)
    expect(out.columns).toHaveLength(3)
    expect(out.columns[1]).toBeNull()
  })
})

describe('isSettled', () => {
  /** 1 列 100 ms・`n` 列すべて振幅 `v` の束。 */
  const flat = (n: number, v: number): TimedColumns => ({
    fromMs: 1000,
    columnSpanMs: 100,
    columns: new Array(n).fill(null).map(() => col(v)),
  })

  it('末尾が静かなら収まったと見なす', () => {
    // 500 ms ぶん（5 列）を見て、すべて 3 gal 未満。
    expect(isSettled(flat(10, 1), 500, 3)).toBe(true)
  })

  it('まだ揺れていれば収まっていない', () => {
    expect(isSettled(flat(10, 20), 500, 3)).toBe(false)
  })

  it('末尾だけ揺れていれば収まっていない', () => {
    const base = flat(10, 1)
    const columns = [...base.columns]
    columns[9] = col(20)
    expect(isSettled({ ...base, columns }, 500, 3)).toBe(false)
  })

  it('見るべき長さぶんの列がまだ無ければ収まっていない', () => {
    // **繋ぎ始めた直後に打ち切らないための歯止め。** 初動の直前は必ず静か。
    expect(isSettled(flat(3, 1), 500, 3)).toBe(false)
  })

  it('値の無い列は静穏と見なさない', () => {
    // 届いていないだけで、揺れていないことの証明ではない。
    const base = flat(10, 1)
    const columns = [...base.columns]
    columns[7] = null
    expect(isSettled({ ...base, columns }, 500, 3)).toBe(false)
  })

  it('1 列も無ければ収まっていない', () => {
    expect(isSettled({ fromMs: 0, columnSpanMs: 100, columns: [] }, 500, 3)).toBe(false)
  })
})

describe('appendWaveWindow', () => {
  it('続きの列を足す', () => {
    // 3 列目（1200〜1300）に入るサンプル。
    const out = appendWaveWindow({ base: BASE, window: win(1200, [3, -3]), limitMs: 2000 })
    expect(out.columns).toHaveLength(3)
    expect(out.columns[2]?.max[0]).toBe(3)
    expect(out.columns[2]?.min[0]).toBe(-3)
  })

  it('既に値のある列は上書きしない', () => {
    // 1 列目（1000〜1100）へ入るサンプルを渡しても、読み返した値が残る。
    const out = appendWaveWindow({ base: BASE, window: win(1000, [99]), limitMs: 2000 })
    expect(out.columns[0]?.max[0]).toBe(1)
  })

  it('上限より先へは伸ばさない', () => {
    // limitMs = 1250 なので 3 列目（始まり 1200）まで。4 列目（1300）は作らない。
    const out = appendWaveWindow({
      base: BASE,
      window: win(1200, new Array(30).fill(3)),
      limitMs: 1250,
    })
    expect(out.columns).toHaveLength(3)
  })

  it('間が空いたら空の列を置く（詰めない）', () => {
    // 3 列目を飛ばして 4 列目（1300〜1400）だけに値がある。
    const out = appendWaveWindow({ base: BASE, window: win(1300, [4]), limitMs: 2000 })
    expect(out.columns).toHaveLength(4)
    expect(out.columns[2]).toBeNull()
    expect(out.columns[3]?.max[0]).toBe(4)
  })

  it('読めないサンプルは無かったことにする', () => {
    const w = win(1200, [NaN, NaN])
    expect(appendWaveWindow({ base: BASE, window: w, limitMs: 2000 })).toBe(BASE)
  })

  it('窓が無ければ何もしない', () => {
    expect(appendWaveWindow({ base: BASE, window: null, limitMs: 2000 })).toBe(BASE)
  })

  it('足すものが無ければ同じ参照を返す', () => {
    // 既にある列の範囲にしか値が無い。
    expect(appendWaveWindow({ base: BASE, window: win(1000, [1]), limitMs: 2000 })).toBe(BASE)
  })

  it('裏付けの本数は畳んだ範囲の最小を採る', () => {
    const w: SeismoWaveWindow = {
      firstSampleMs: 1200,
      msPerSample: 10,
      gal: [Float32Array.from([1, 1]), Float32Array.from([1, 1]), Float32Array.from([1, 1])],
      memberCount: Float32Array.from([9, 1]),
    }
    const out = appendWaveWindow({ base: BASE, window: w, limitMs: 2000 })
    expect(out.columns[2]?.minMembers).toBe(1)
  })
})

// 取り戻した区間の列を、ホストから取り直して差し替える（#597）。
describe('revisedColumnSpan', () => {
  it('正: 作り直した範囲に掛かる列を、列の境目へ揃えて返す', () => {
    // 1150〜1320 ms に掛かるのは列 1（1100〜1200）〜列 3（1300〜1400）。
    expect(revisedColumnSpan(BASE, 1150, 1320)).toEqual({ first: 1, count: 3, fromMs: 1100, toMs: 1400 })
  })

  it('対照: 持っている列の外は取りに行かない（その先は押し出しの継ぎ足しが受け持つ）', () => {
    // 列は 5 つ（1000〜1500 ms）。1450〜2000 ms で掛かるのは列 4 だけ。
    expect(revisedColumnSpan(BASE, 1450, 2000)).toEqual({ first: 4, count: 1, fromMs: 1400, toMs: 1500 })
    expect(revisedColumnSpan(BASE, 1500, 2000)).toBeNull()
    expect(revisedColumnSpan(BASE, 0, 1000)).toBeNull()
  })

  it('安全弁: 刻みが壊れていれば取りに行かない', () => {
    expect(revisedColumnSpan({ ...BASE, columnSpanMs: 0 }, 1000, 1500)).toBeNull()
  })
})

describe('spliceRevisedColumns', () => {
  it('正: ホストが値を持つ列を差し替える（穴だった列も、押し出しで作った列も）', () => {
    const base: TimedColumns = { ...BASE, columns: [col(1), null, col(2), null, null] }
    const out = spliceRevisedColumns(base, { fromMs: 1100, columnSpanMs: 100, columns: [col(5), col(6)] })

    expect(out.columns).toEqual([col(1), col(5), col(6), null, null])
  })

  it('対照: ホストが値を持たない列は触らない（値のある列を穴へ戻さない）', () => {
    const base: TimedColumns = { ...BASE, columns: [col(1), col(2), col(3), null, null] }
    const out = spliceRevisedColumns(base, { fromMs: 1100, columnSpanMs: 100, columns: [null, col(7)] })

    expect(out.columns).toEqual([col(1), col(2), col(7), null, null])
  })

  it('安全弁: 起点か刻みが列の境目と合わなければ、何も変えずに同じ参照を返す', () => {
    // ずれた列を差し込むと、別の時刻の値を描くことになる。
    expect(spliceRevisedColumns(BASE, { fromMs: 1150, columnSpanMs: 100, columns: [col(9)] })).toBe(BASE)
    expect(spliceRevisedColumns(BASE, { fromMs: 1100, columnSpanMs: 50, columns: [col(9)] })).toBe(BASE)
  })

  it('安全弁: 持っている列の外へは足さない（継ぎ足しの起点を動かさない）', () => {
    const base: TimedColumns = { ...BASE, columns: [col(1), null] }
    const out = spliceRevisedColumns(base, { fromMs: 1100, columnSpanMs: 100, columns: [col(4), col(5), col(6)] })

    expect(out.columns).toEqual([col(1), col(4)])
  })

  it('正: 何も変わらなければ同じ参照を返す', () => {
    expect(spliceRevisedColumns(BASE, { fromMs: 1200, columnSpanMs: 100, columns: [null, null] })).toBe(BASE)
  })
})
