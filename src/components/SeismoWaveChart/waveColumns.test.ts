// 波形を画面幅の列へ落とす処理の回帰テスト。
//
// 固定するのは 3 つ ——**ピークが消えないこと**（間引きでいちばん見たい跳ね上がりを
// 落とさない）、**届かなかった区間が値を持たないまま出てくること**（描く側が線を
// 切れる）、**静穏時に縦が伸びきらないこと**（下限）。

import { describe, it, expect } from 'vitest'
import { buildWaveColumns } from './waveColumns'
import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'

const MS = 10
const FIRST = 1000

function win(
  ns: readonly number[],
  ew: readonly number[] = ns.map(() => 0),
  ud: readonly number[] = ns.map(() => 0),
  memberCount: readonly number[] = ns.map(() => 3),
): SeismoWaveWindow {
  return {
    firstSampleMs: FIRST,
    msPerSample: MS,
    gal: [new Float32Array(ns), new Float32Array(ew), new Float32Array(ud)],
    memberCount: new Float32Array(memberCount),
  }
}

/** 窓の全体がちょうど収まる幅。10 サンプルなら先頭が左端・末尾が右端に来る。 */
function fullSpan(count: number): number {
  return (count - 1) * MS
}

describe('buildWaveColumns', () => {
  // 正: 20 点に 1 点を拾う形にすると、単発の跳ね上がりは 95% の確率で絵から消える。
  it('列ごとに上下の端を取る（ピークを落とさない）', () => {
    const r = buildWaveColumns({
      window: win([0, 0, 0, 0, 5, 0, 0, 0, -3, 0]),
      columnCount: 2,
      spanMs: fullSpan(10),
      minScaleGal: 1,
    })
    expect(r.columns).toHaveLength(2)
    expect(r.columns[0].min[0]).toBe(0)
    expect(r.columns[0].max[0]).toBe(5)
    expect(r.columns[1].min[0]).toBe(-3)
    expect(r.columns[1].max[0]).toBe(0)
  })

  it('いちばん新しいサンプルを落とさない', () => {
    const r = buildWaveColumns({
      window: win([0, 0, 0, 0, 0, 0, 0, 0, 0, 9]),
      columnCount: 5,
      spanMs: fullSpan(10),
      minScaleGal: 1,
    })
    expect(r.columns[4].max[0]).toBe(9)
  })

  it('3 成分をそれぞれ独立に取る', () => {
    const r = buildWaveColumns({
      window: win([1, 2], [-4, -5], [7, 8]),
      columnCount: 1,
      spanMs: fullSpan(2),
      minScaleGal: 1,
    })
    expect(r.columns[0].min).toEqual([1, -5, 7])
    expect(r.columns[0].max).toEqual([2, -4, 8])
  })

  describe('届かなかった区間', () => {
    it('その列は値を持たない', () => {
      const r = buildWaveColumns({
        window: win([1, 2, 3, 4, 5, NaN, NaN, NaN, NaN, NaN]),
        columnCount: 2,
        spanMs: fullSpan(10),
        minScaleGal: 1,
      })
      expect(r.columns[0].hasValue).toBe(true)
      expect(r.columns[1].hasValue).toBe(false)
      expect(r.columns[1].min[0]).toBeNaN()
      expect(r.hasAnyValue).toBe(true)
    })

    // 対照: 同じ列に有効な点が残っていれば、その列は値を持つ（欠測の 1 点で
    // 列ごと落とすと、正常運転でも絵が虫食いになる）。
    it('同じ列に有効な点が残っていれば値を持つ', () => {
      const r = buildWaveColumns({
        window: win([NaN, 2, NaN, 4, NaN]),
        columnCount: 1,
        spanMs: fullSpan(5),
        minScaleGal: 1,
      })
      expect(r.columns[0].hasValue).toBe(true)
      expect(r.columns[0].min[0]).toBe(2)
      expect(r.columns[0].max[0]).toBe(4)
    })

    // 安全弁: 1 成分だけが読めないサンプルは、そのサンプルごと落とす。
    // 片方だけ採ると、成分によって時間軸の点の数が変わる。
    it('1 成分でも読めないサンプルは数えない', () => {
      const r = buildWaveColumns({
        window: win([1, 2], [3, NaN], [5, 6]),
        columnCount: 1,
        spanMs: fullSpan(2),
        minScaleGal: 1,
      })
      expect(r.columns[0].max[0]).toBe(1)
      expect(r.columns[0].max[2]).toBe(5)
    })

    it('1 点も読めなければ値を持つ列が無い', () => {
      const r = buildWaveColumns({
        window: win([NaN, NaN]),
        columnCount: 2,
        spanMs: fullSpan(2),
        minScaleGal: 4,
      })
      expect(r.hasAnyValue).toBe(false)
      expect(r.scaleGal).toBe(4)
    })
  })

  describe('裏付けの本数', () => {
    it('その列でいちばん少なかった本数を採る', () => {
      const r = buildWaveColumns({
        window: win([1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0], [3, 3, 1, 3]),
        columnCount: 1,
        spanMs: fullSpan(4),
        minScaleGal: 1,
      })
      expect(r.columns[0].minMembers).toBe(1)
    })

    it('値を持たない列は 0', () => {
      const r = buildWaveColumns({
        window: win([NaN, NaN], [NaN, NaN], [NaN, NaN], [3, 3]),
        columnCount: 1,
        spanMs: fullSpan(2),
        minScaleGal: 1,
      })
      expect(r.columns[0].minMembers).toBe(0)
    })
  })

  describe('縦の振れ幅', () => {
    // 正: 揺れたら広げる。
    it('窓の中の最大の絶対値まで広げる', () => {
      const r = buildWaveColumns({
        window: win([0, -25, 3]),
        columnCount: 3,
        spanMs: fullSpan(3),
        minScaleGal: 10,
      })
      expect(r.scaleGal).toBe(25)
    })

    // 対照: 静穏時に伸びきらない。素の自動にすると、ノイズが画面いっぱいに広がって
    // 揺れているようにしか見えなくなる。
    it('下限を下回らない', () => {
      const r = buildWaveColumns({
        window: win([0.01, -0.02, 0.03]),
        columnCount: 3,
        spanMs: fullSpan(3),
        minScaleGal: 10,
      })
      expect(r.scaleGal).toBe(10)
    })
  })

  // 抱えている量が窓の幅に満たないうち（起動直後）。全体を引き伸ばすと、
  // 10 秒ぶんの絵と 60 秒ぶんの絵が見分けられなくなる。
  it('抱えている量が少ないうちは右へ寄せ、左を空ける', () => {
    const r = buildWaveColumns({
      // 10 サンプル（90ms ぶん）を 900ms の幅へ
      window: win([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
      columnCount: 10,
      spanMs: 900,
      minScaleGal: 1,
    })
    expect(r.columns.slice(0, 9).every(c => !c.hasValue)).toBe(true)
    expect(r.columns[9].hasValue).toBe(true)
  })

  describe('描けない寸法', () => {
    // 幅ゼロの canvas（畳まれている・まだ測れていない）で呼ばれうる。
    it('列が無ければ空で返す', () => {
      const r = buildWaveColumns({ window: win([1, 2]), columnCount: 0, spanMs: 100, minScaleGal: 3 })
      expect(r.columns).toHaveLength(0)
      expect(r.hasAnyValue).toBe(false)
      expect(r.scaleGal).toBe(3)
    })

    it('幅が無ければ空で返す', () => {
      const r = buildWaveColumns({ window: win([1, 2]), columnCount: 4, spanMs: 0, minScaleGal: 3 })
      expect(r.columns).toHaveLength(0)
    })

    it('サンプルが 1 つも無ければ空で返す', () => {
      const r = buildWaveColumns({ window: win([]), columnCount: 4, spanMs: 100, minScaleGal: 3 })
      expect(r.columns).toHaveLength(0)
    })
  })
})
