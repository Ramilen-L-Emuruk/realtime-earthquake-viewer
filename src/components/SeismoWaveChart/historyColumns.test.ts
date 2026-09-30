// 読み返した列を画面の幅へ畳むところ。
//
// 固定するのは 3 つ ——**振幅が保たれること**（縮めてもピークが消えない）、
// **広げても列が落ちないこと**（空の列は線が切れて「届いていない区間」に見える）、
// **裏付けの本数は最小を採ること**。

import { describe, expect, it } from 'vitest'

import type { WaveHistoryColumn } from '../../services/seismoWaveHistory'
import { foldHistoryColumns } from './historyColumns'

function col(lo: number, hi: number, members = 9): WaveHistoryColumn {
  return { min: [lo, lo, lo], max: [hi, hi, hi], minMembers: members }
}

describe('foldHistoryColumns', () => {
  it('縮めても振幅が消えない（列ごとの端を採る）', () => {
    // 4 列 → 2 列。2 列目に単発のピーク（-30/+30）がある。
    const source = [col(-1, 1), col(-30, 30), col(-1, 1), col(-2, 2)]
    const { columns, scaleGal } = foldHistoryColumns({ source, columnCount: 2, minScaleGal: 10 })
    expect(columns).toHaveLength(2)
    // **間引きだとここでピークが落ちる。**
    expect(columns[0].max[0]).toBe(30)
    expect(columns[0].min[0]).toBe(-30)
    expect(scaleGal).toBe(30)
  })

  it('画面のほうが広ければ、同じ入力列を繰り返して埋める', () => {
    // **空の列を作らない。** 線が切れると「届いていない区間」に見える。
    const source = [col(-1, 1), col(-2, 2)]
    const { columns } = foldHistoryColumns({ source, columnCount: 6, minScaleGal: 10 })
    expect(columns).toHaveLength(6)
    expect(columns.every((c) => c.hasValue)).toBe(true)
  })

  it('値の無い列は値なしのまま残す', () => {
    const source = [col(-1, 1), null, col(-1, 1)]
    const { columns } = foldHistoryColumns({ source, columnCount: 3, minScaleGal: 10 })
    expect(columns[0].hasValue).toBe(true)
    expect(columns[1].hasValue).toBe(false)
    expect(Number.isNaN(columns[1].min[0])).toBe(true)
    expect(columns[2].hasValue).toBe(true)
  })

  it('全部が値なしなら hasAnyValue は false', () => {
    const { columns, hasAnyValue } = foldHistoryColumns({
      source: [null, null],
      columnCount: 2,
      minScaleGal: 10,
    })
    expect(hasAnyValue).toBe(false)
    expect(columns.every((c) => !c.hasValue)).toBe(true)
  })

  it('裏付けの本数は畳んだ範囲の最小を採る', () => {
    // **見落とす方が重い。** 1 本まで落ちた瞬間が範囲にあれば、その列は裏付けが無い。
    const source = [col(-1, 1, 9), col(-1, 1, 1)]
    const { columns } = foldHistoryColumns({ source, columnCount: 1, minScaleGal: 10 })
    expect(columns[0].minMembers).toBe(1)
  })

  it('振れ幅は下限を下回らない', () => {
    // 静穏時のノイズが画面いっぱいに広がるのを防ぐ（`SeismoWaveChart` と同じ下限）。
    const { scaleGal } = foldHistoryColumns({
      source: [col(-0.3, 0.3)],
      columnCount: 1,
      minScaleGal: 10,
    })
    expect(scaleGal).toBe(10)
  })

  it('列が無い・幅が無いときは何も作らない', () => {
    expect(foldHistoryColumns({ source: [], columnCount: 4, minScaleGal: 10 }).columns).toEqual([])
    expect(
      foldHistoryColumns({ source: [col(-1, 1)], columnCount: 0, minScaleGal: 10 }).columns,
    ).toEqual([])
  })

  it('入力の端をすべて見る（末尾の列を落とさない）', () => {
    // 3 列 → 1 列。最後の列にピークがある。
    const source = [col(-1, 1), col(-2, 2), col(-50, 50)]
    const { scaleGal } = foldHistoryColumns({ source, columnCount: 1, minScaleGal: 10 })
    expect(scaleGal).toBe(50)
  })

  describe('向きを消したとき', () => {
    /** 上下（3 本目）だけが大きい列。 */
    const BIG_UD: WaveHistoryColumn = {
      min: [-5, -5, -80],
      max: [5, 5, 80],
      minMembers: 9,
    }

    it('消した向きは振れ幅の分母から外す', () => {
      // **正。** 外さないと、いちばん大きい成分を消しても残りが潰れたままで、
      // 消した意味がなくなる。
      const { scaleGal } = foldHistoryColumns({
        source: [BIG_UD],
        columnCount: 1,
        minScaleGal: 1,
        visibleAxes: [true, true, false],
      })
      expect(scaleGal).toBe(5)
    })

    it('渡さなければ 3 成分すべてで測る', () => {
      // **対照。**
      const { scaleGal } = foldHistoryColumns({ source: [BIG_UD], columnCount: 1, minScaleGal: 1 })
      expect(scaleGal).toBe(80)
    })

    it('全部消しても「届いていない」ことにはしない', () => {
      // **安全弁。** `hasAnyValue` は「その区間にデータが届いているか」の話なので、
      // 向きの取捨に左右させない（偽にすると絵ごと描かれなくなる）。
      const got = foldHistoryColumns({
        source: [BIG_UD],
        columnCount: 1,
        minScaleGal: 10,
        visibleAxes: [false, false, false],
      })
      expect(got.hasAnyValue).toBe(true)
      expect(got.scaleGal).toBe(10)
    })
  })
})
