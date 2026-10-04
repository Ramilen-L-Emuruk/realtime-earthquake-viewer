import { describe, expect, test } from 'vitest'
import type { NoiseBand } from '../../utils/seismoQuakeWindow'
import { emphasizeColumns, MIN_EMPHASIZED_SCALE_GAL } from './emphasizeColumns'
import type { PaintableColumns } from './paintWave'
import type { WaveColumn } from './waveColumns'

const col = (lo: [number, number, number], hi: [number, number, number]): WaveColumn => ({
  hasValue: true,
  min: lo,
  max: hi,
  minMembers: 3,
})
const EMPTY: WaveColumn = { hasValue: false, min: [NaN, NaN, NaN], max: [NaN, NaN, NaN], minMembers: 0 }
const folded = (columns: WaveColumn[]): PaintableColumns => ({ columns, scaleGal: 10, hasAnyValue: true })
// 実測に近い帯（水平 1.3〜1.4・上下 2.0）
const noise: NoiseBand = { center: [0, 0, 0], width: [1.3, 1.4, 2.0] }

describe('emphasizeColumns', () => {
  // 正: 幅を超えた分だけが残り、縦はそれに合わせて伸びる。
  test('幅を超えた分だけを残し、縦の表示は「±幅〜±上端」', () => {
    const r = emphasizeColumns({ folded: folded([col([-2.6, -2.0, -1.8], [2.6, 2.0, 1.8])]), noise })
    expect(r.columns[0].max[0]).toBeCloseTo(1.3)
    expect(r.columns[0].max[1]).toBeCloseTo(0.6)
    expect(r.columns[0].max[2]).toBe(0)
    expect(r.columns[0].min[0]).toBeCloseTo(-1.3)
    expect(r.columns[0].min[1]).toBeCloseTo(-0.6)
    expect(r.columns[0].min[2]).toBe(0)
    expect(r.scaleGal).toBeCloseTo(1.3)
    expect(r.scaleLabel).toBe('±1.3〜±2.6 gal')
  })

  // 対照: 幅の内側に収まる振れは平らになる（ノイズを揺れに見せない）。
  test('幅の内側の振れは 0 へ潰れる', () => {
    const r = emphasizeColumns({ folded: folded([col([-1.0, -1.2, -1.9], [1.0, 1.2, 1.9])]), noise })
    expect(r.columns[0].min).toEqual([0, 0, 0])
    expect(r.columns[0].max).toEqual([0, 0, 0])
  })

  // 安全弁: 少しだけ超えたノイズの尖りを枠いっぱいに伸ばさない。
  test('残りが小さくても縦は最低 0.5 gal 取る', () => {
    const r = emphasizeColumns({ folded: folded([col([-1.4, 0, 0], [1.4, 0, 0])]), noise })
    expect(r.scaleGal).toBe(MIN_EMPHASIZED_SCALE_GAL)
    expect(r.scaleLabel).toBe('±1.3〜±1.8 gal')
  })

  test('どの成分も超えていなければ、いちばん近かった成分の幅を出す', () => {
    // 上下は 1.9/2.0（差 −0.1）、南北は 0.5/1.3（差 −0.8）→ 上下を採る
    const r = emphasizeColumns({ folded: folded([col([-0.5, -0.5, -1.9], [0.5, 0.5, 1.9])]), noise })
    expect(r.scaleLabel).toBe('±2.0〜±2.5 gal')
  })

  test('中心がずれていれば、中心から測って潰す', () => {
    const r = emphasizeColumns({
      folded: folded([col([0, 0, 0], [3.0, 0, 0])]),
      noise: { center: [0.5, 0, 0], width: [1.3, 1.4, 2.0] },
    })
    expect(r.columns[0].max[0]).toBeCloseTo(1.2)
    expect(r.columns[0].min[0]).toBe(0)
  })

  test('消した向きは縦の分母にも表示にも数えない', () => {
    const r = emphasizeColumns({
      folded: folded([col([-5, -1.6, 0], [5, 1.6, 0])]),
      noise,
      visibleAxes: [false, true, true],
    })
    expect(r.scaleLabel).toBe('±1.4〜±1.9 gal')
  })

  test('値の無い列は値の無いまま（線を切る）', () => {
    const r = emphasizeColumns({ folded: folded([EMPTY, col([-3, 0, 0], [3, 0, 0])]), noise })
    expect(r.columns[0]).toBe(EMPTY)
  })

  test('描く向きが無ければ潰さずに返す', () => {
    const f = folded([col([-3, 0, 0], [3, 0, 0])])
    expect(emphasizeColumns({ folded: f, noise, visibleAxes: [false, false, false] })).toBe(f)
  })

  test('値が 1 つも無ければそのまま返す', () => {
    const f: PaintableColumns = { columns: [EMPTY], scaleGal: 10, hasAnyValue: false }
    expect(emphasizeColumns({ folded: f, noise })).toBe(f)
  })
})

describe('emphasizeColumns（非有限の値）', () => {
  // 安全弁: 欠けた値を「ノイズの内側＝0」に化けさせない。
  test('非有限の値は 0 にせず、そのまま残す', () => {
    const r = emphasizeColumns({ folded: folded([col([NaN, -3, 0], [NaN, 3, 0])]), noise })
    expect(r.columns[0].max[0]).toBeNaN()
    expect(r.columns[0].max[1]).toBeCloseTo(1.6)
  })
})
