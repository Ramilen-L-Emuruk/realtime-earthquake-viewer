// 波形を画面幅の列へ落とす処理の回帰テスト。
//
// 固定するのは 3 つ ——**ピークが消えないこと**（間引きでいちばん見たい跳ね上がりを
// 落とさない）、**届かなかった区間が値を持たないまま出てくること**（描く側が線を
// 切れる）、**静穏時に縦が伸びきらないこと**（下限）。

import { describe, it, expect } from 'vitest'
import { buildWaveColumns, buildWaveMeanLines } from './waveColumns'
import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'

const MS = 10
const FIRST = 1000

function win(
  ew: readonly number[],
  ns: readonly number[] = ew.map(() => 0),
  ud: readonly number[] = ew.map(() => 0),
  memberCount: readonly number[] = ew.map(() => 3),
): SeismoWaveWindow {
  return {
    firstSampleMs: FIRST,
    msPerSample: MS,
    gal: [new Float32Array(ew), new Float32Array(ns), new Float32Array(ud)],
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
    const r = buildWaveColumns({ rightEdge: 'last-sample',
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
    const r = buildWaveColumns({ rightEdge: 'last-sample',
      window: win([0, 0, 0, 0, 0, 0, 0, 0, 0, 9]),
      columnCount: 5,
      spanMs: fullSpan(10),
      minScaleGal: 1,
    })
    expect(r.columns[4].max[0]).toBe(9)
  })

  it('3 成分をそれぞれ独立に取る', () => {
    const r = buildWaveColumns({ rightEdge: 'last-sample',
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
      // **届かなかった区間は 3 成分そろって NaN で入る**（1 成分だけの NaN は下の「成分ごと」が見る）。
      const gone = [1, 2, 3, 4, 5, NaN, NaN, NaN, NaN, NaN]
      const r = buildWaveColumns({ rightEdge: 'last-sample',
        window: win(gone, gone, gone),
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
      const r = buildWaveColumns({ rightEdge: 'last-sample',
        window: win([NaN, 2, NaN, 4, NaN]),
        columnCount: 1,
        spanMs: fullSpan(5),
        minScaleGal: 1,
      })
      expect(r.columns[0].hasValue).toBe(true)
      expect(r.columns[0].min[0]).toBe(2)
      expect(r.columns[0].max[0]).toBe(4)
    })

    // 正（2026-10-09 に覆した）: 1 成分だけが読めないサンプルは、読めた成分だけを列へ入れる。
    // 観測点の合成が、測る向きが 3 方向へ散っていない間に解けない成分だけを NaN にして残りを出す
    // ようになった（2026-10-09 ユーザー承認）。以前は「成分によって点の数が変わる」のを避けて
    // サンプルごと落としていたが、それだと上が解けないだけで水平の線まで消える。
    it('1 成分だけ読めないサンプルは、読めた成分だけを列へ入れる', () => {
      const r = buildWaveColumns({ rightEdge: 'last-sample',
        window: win([1, 2], [3, NaN], [5, 6]),
        columnCount: 1,
        spanMs: fullSpan(2),
        minScaleGal: 1,
      })
      expect(r.columns[0].max[0]).toBe(2)
      expect(r.columns[0].max[1]).toBe(3)
      expect(r.columns[0].max[2]).toBe(6)
    })

    // 対照: その成分が列の中で 1 つも読めなければ、その成分だけ NaN（描く側はそこで線を切る）。
    it('成分が列の中で 1 つも読めなければ、その成分だけ NaN で、列は値を持つ', () => {
      const r = buildWaveColumns({ rightEdge: 'last-sample',
        window: win([1, 2], [3, 4], [NaN, NaN]),
        columnCount: 1,
        spanMs: fullSpan(2),
        minScaleGal: 1,
      })
      expect(r.columns[0].hasValue).toBe(true)
      expect(r.columns[0].min[2]).toBeNaN()
      expect(r.columns[0].max[2]).toBeNaN()
      expect(r.scaleGal).toBe(4)
    })

    it('1 点も読めなければ値を持つ列が無い', () => {
      const r = buildWaveColumns({ rightEdge: 'last-sample',
        window: win([NaN, NaN], [NaN, NaN], [NaN, NaN]),
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
      const r = buildWaveColumns({ rightEdge: 'last-sample',
        window: win([1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0], [3, 3, 1, 3]),
        columnCount: 1,
        spanMs: fullSpan(4),
        minScaleGal: 1,
      })
      expect(r.columns[0].minMembers).toBe(1)
    })

    it('値を持たない列は 0', () => {
      const r = buildWaveColumns({ rightEdge: 'last-sample',
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
      const r = buildWaveColumns({ rightEdge: 'last-sample',
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
      const r = buildWaveColumns({ rightEdge: 'last-sample',
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
    const r = buildWaveColumns({ rightEdge: 'last-sample',
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
      const r = buildWaveColumns({ rightEdge: 'last-sample', window: win([1, 2]), columnCount: 0, spanMs: 100, minScaleGal: 3 })
      expect(r.columns).toHaveLength(0)
      expect(r.hasAnyValue).toBe(false)
      expect(r.scaleGal).toBe(3)
    })

    it('幅が無ければ空で返す', () => {
      const r = buildWaveColumns({ rightEdge: 'last-sample', window: win([1, 2]), columnCount: 4, spanMs: 0, minScaleGal: 3 })
      expect(r.columns).toHaveLength(0)
    })

    it('サンプルが 1 つも無ければ空で返す', () => {
      const r = buildWaveColumns({ rightEdge: 'last-sample', window: win([]), columnCount: 4, spanMs: 100, minScaleGal: 3 })
      expect(r.columns).toHaveLength(0)
    })
  })
})

describe('buildWaveColumns の合成', () => {
  // 正: 合成はサンプルごとのベクトルの大きさから取る。成分ごとの端どうしからは作らない。
  it('別々の瞬間に振れた成分を足し合わせない', () => {
    // 1 点目は東西だけ 3、2 点目は南北だけ 4。端どうしなら 5 になるが、正しくは 4。
    const r = buildWaveColumns({ rightEdge: 'last-sample', window: win([3, 0], [0, 4]), columnCount: 1, spanMs: fullSpan(2), minScaleGal: 0.1 })
    expect(r.columns[0].magMax).toBe(4)
    expect(r.columns[0].magMin).toBe(3)
  })

  // 対照: 同じ瞬間なら合わせた大きさになる。
  it('同じ瞬間に振れた成分は合わせた大きさ', () => {
    const r = buildWaveColumns({ rightEdge: 'last-sample', window: win([3], [4]), columnCount: 1, spanMs: 10, minScaleGal: 0.1 })
    expect(r.columns[0].magMax).toBe(5)
  })

  // 安全弁: 消した向きは合成にも数えない（詳細の窓の合成と同じ）。解けなかった成分（NaN）も数えない。
  it('消した向きと解けなかった成分は合成に数えない', () => {
    const hidden = buildWaveColumns({ rightEdge: 'last-sample',
      window: win([3], [4], [12]),
      columnCount: 1,
      spanMs: 10,
      minScaleGal: 0.1,
      visibleAxes: [true, true, false],
    })
    expect(hidden.columns[0].magMax).toBe(5)
    const unsolved = buildWaveColumns({ rightEdge: 'last-sample', window: win([3], [4], [NaN]), columnCount: 1, spanMs: 10, minScaleGal: 0.1 })
    expect(unsolved.columns[0].magMax).toBe(5)
  })
})

describe('buildWaveMeanLines', () => {
  // 正: 正側・負側を分けて平均する（そのまま平均すると 0 に潰れる）。
  it('成分ごとに正側と負側の平均を出す', () => {
    const m = buildWaveMeanLines({ rightEdge: 'last-sample', window: win([2, -2, 2, -2]), columnCount: 1, spanMs: fullSpan(4), includeAxes: true })
    expect(m.axes[0].pos[0]).toBeCloseTo(2)
    expect(m.axes[0].neg[0]).toBeCloseTo(-2)
  })

  // 対照: 合成の均した線は大きさの平均（0 に潰れない）。
  it('合成を均した線は大きさを平均する', () => {
    const m = buildWaveMeanLines({ rightEdge: 'last-sample', window: win([2, -2, 2, -2]), columnCount: 1, spanMs: fullSpan(4), includeAxes: true })
    expect(m.compositeSmooth[0]).toBeCloseTo(2)
  })

  // 安全弁: 値の無い列は NaN（描く側はそこで線を切る）。届いていない区間を 0 にしない。
  it('値の無い列は NaN', () => {
    const m = buildWaveMeanLines({ rightEdge: 'last-sample', window: win([NaN, NaN, 1], [NaN, NaN, 0], [NaN, NaN, 0]), columnCount: 3, spanMs: fullSpan(3), includeAxes: true })
    expect(m.axes[0].pos[0]).toBeNaN()
    expect(m.compositeSmooth[0]).toBeNaN()
    expect(m.axes[0].pos[2]).toBeCloseTo(1)
  })

  // 対照: 成分の平均を頼まなければ作らない（畳んだ合成は均した線しか使わない）。合成の均した線は作る。
  it('成分の平均を頼まなければ成分は NaN のまま', () => {
    const m = buildWaveMeanLines({ rightEdge: 'last-sample', window: win([2, -2, 2, -2]), columnCount: 1, spanMs: fullSpan(4), includeAxes: false })
    expect(m.axes[0].pos[0]).toBeNaN()
    expect(m.compositeSmooth[0]).toBeCloseTo(2)
  })
})

// 地図の下端の波形は右端を時計の「いま」に置く（最後のサンプルより先）。その間は値を持たない列になり、
// 右端より新しいサンプル（時計のずれで先に届いた分）は右端の列へ積まれずに捨てられる。
describe('右端を時刻で渡す', () => {
  // 正: 右端を最後のサンプルより先へ置けば、その先の列は空のまま。
  it('最後のサンプルより先の列は値を持たない', () => {
    // 4 サンプル（1000〜1030 ms）。右端 1080・幅 80（左端 1000）→ 列 8 本（10 ms ずつ）。サンプルは左の 4 本に入る。
    const r = buildWaveColumns({ rightEdge: 1080, window: win([1, 2, 3, 4]), columnCount: 8, spanMs: 80, minScaleGal: 0.1 })
    expect(r.columns.slice(0, 4).every((c) => c.hasValue)).toBe(true)
    expect(r.columns.slice(4).some((c) => c.hasValue)).toBe(false)
  })

  // 安全弁: 右端より新しいサンプルは右端の列へ寄せない（寄せると、右端の先の値が右端に積まれる）。
  it('右端より新しいサンプルは捨てる', () => {
    const r = buildWaveColumns({ rightEdge: 1010, window: win([1, 2, 30, 40]), columnCount: 2, spanMs: 20, minScaleGal: 0.1 })
    expect(Math.max(...r.columns.map((c) => (c.hasValue ? c.max[0] : -Infinity)))).toBe(2)
    const m = buildWaveMeanLines({ rightEdge: 1010, window: win([1, 2, 30, 40]), columnCount: 2, spanMs: 20, includeAxes: false })
    expect(Math.max(...Array.from(m.compositeSmooth).filter(Number.isFinite))).toBeLessThan(30)
  })

  // 対照: 'last-sample' なら従来どおり右端は最後のサンプル（右端の列に最後の値が入る）。
  it("'last-sample' は最後のサンプルを右端にする", () => {
    const r = buildWaveColumns({ rightEdge: 'last-sample', window: win([1, 2, 3, 4]), columnCount: 4, spanMs: fullSpan(4), minScaleGal: 0.1 })
    expect(r.columns[3].hasValue).toBe(true)
    expect(r.columns[3].max[0]).toBe(4)
  })
})
