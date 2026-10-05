import { describe, expect, it } from 'vitest'

import type { WaveHistoryColumn } from '../../services/seismoWaveHistory'
import type { TimedColumns } from '../../utils/seismoWaveColumns'
import {
  clampView,
  columnsRange,
  MIN_VIEW_MS,
  panView,
  peakPerAxis,
  seriesSegments,
  sliceColumns,
  zoomView,
} from './detailView'

const T0 = 1_790_000_000_000
const BOUNDS = { fromMs: T0, toMs: T0 + 270_000 }

function col(v: number): WaveHistoryColumn {
  return { min: [-v, -v / 2, -v / 4], max: [v, v / 2, v / 4], minMembers: 3 }
}

function columns(n: number, spanMs: number, value: (i: number) => number | null = () => 1): TimedColumns {
  return {
    fromMs: T0,
    columnSpanMs: spanMs,
    columns: Array.from({ length: n }, (_, i) => {
      const v = value(i)
      return v === null ? null : col(v)
    }),
  }
}

describe('clampView', () => {
  it('はみ出した範囲は幅を保って内側へずらす', () => {
    expect(clampView({ fromMs: T0 - 5_000, toMs: T0 + 5_000 }, BOUNDS)).toEqual({ fromMs: T0, toMs: T0 + 10_000 })
    expect(clampView({ fromMs: T0 + 265_000, toMs: T0 + 275_000 }, BOUNDS)).toEqual({
      fromMs: T0 + 260_000,
      toMs: T0 + 270_000,
    })
  })

  // 安全弁: 寄せすぎない・広げすぎない。
  it('幅は最小幅以上・記録の幅以下', () => {
    const narrow = clampView({ fromMs: T0 + 1_000, toMs: T0 + 1_100 }, BOUNDS)
    expect(narrow.toMs - narrow.fromMs).toBe(MIN_VIEW_MS)
    expect(clampView({ fromMs: T0 - 1e6, toMs: T0 + 1e6 }, BOUNDS)).toEqual(BOUNDS)
  })

  it('記録が最小幅より短ければ記録そのもの', () => {
    const tiny = { fromMs: T0, toMs: T0 + 1_000 }
    expect(clampView({ fromMs: T0, toMs: T0 + 500 }, tiny)).toEqual(tiny)
  })
})

describe('zoomView', () => {
  it('押さえた位置の時刻は動かない', () => {
    const view = { fromMs: T0 + 100_000, toMs: T0 + 200_000 }
    const next = zoomView(view, BOUNDS, 0.5, 0.25)
    const anchorBefore = view.fromMs + 0.25 * 100_000
    const anchorAfter = next.fromMs + 0.25 * (next.toMs - next.fromMs)
    expect(next.toMs - next.fromMs).toBe(50_000)
    expect(anchorAfter).toBeCloseTo(anchorBefore, 6)
  })

  // 対照: 端で縮めたら記録の外へは出ない。
  it('縮めても記録の外へは出ない', () => {
    const next = zoomView({ fromMs: T0, toMs: T0 + 100_000 }, BOUNDS, 2, 0)
    expect(next.fromMs).toBe(T0)
    expect(next.toMs).toBe(T0 + 200_000)
    expect(zoomView(next, BOUNDS, 10, 0.5)).toEqual(BOUNDS)
  })
})

describe('panView', () => {
  it('幅の割合で送り、端で止まる', () => {
    const view = { fromMs: T0 + 100_000, toMs: T0 + 110_000 }
    expect(panView(view, BOUNDS, 0.5)).toEqual({ fromMs: T0 + 105_000, toMs: T0 + 115_000 })
    expect(panView(view, BOUNDS, -100)).toEqual({ fromMs: T0, toMs: T0 + 10_000 })
  })
})

describe('sliceColumns', () => {
  it('範囲に掛かる列を、一部だけ掛かる端の列も含めて切り出す', () => {
    const src = columns(100, 1_000)
    const s = sliceColumns(src, { fromMs: T0 + 10_500, toMs: T0 + 20_500 })
    expect(s.fromMs).toBe(T0 + 10_000)
    expect(s.columns.length).toBe(11)
    expect(columnsRange(s)).toEqual({ fromMs: T0 + 10_000, toMs: T0 + 21_000 })
  })

  it('範囲が列の外なら空', () => {
    expect(sliceColumns(columns(10, 1_000), { fromMs: T0 + 50_000, toMs: T0 + 60_000 }).columns).toEqual([])
  })
})

describe('peakPerAxis', () => {
  it('範囲の中の成分ごとの絶対値の最大と、その列の中ほどの時刻', () => {
    const src = columns(10, 1_000, (i) => (i === 5 ? 8 : i === 9 ? 20 : 1))
    const at = T0 + 5_500
    expect(peakPerAxis(src, { fromMs: T0, toMs: T0 + 9_000 })).toEqual([
      { gal: 8, atMs: at },
      { gal: 4, atMs: at },
      { gal: 2, atMs: at },
    ])
  })

  // 対照: 同じ大きさが続くときは最初の列（いちばん早く記録した瞬間）。
  it('同じ最大が続けば最初の時刻', () => {
    const src = columns(10, 1_000, (i) => (i >= 3 ? 5 : 1))
    expect(peakPerAxis(src, { fromMs: T0, toMs: T0 + 10_000 })[0]).toEqual({ gal: 5, atMs: T0 + 3_500 })
  })

  // 安全弁: 値の無い列だけなら null（0 gal と言わない）。
  it('値が 1 つも無ければ null', () => {
    expect(peakPerAxis(columns(3, 1_000, () => null), BOUNDS)).toEqual([null, null, null])
  })
})

describe('seriesSegments', () => {
  const pt = (sec: number, value: number | null) => ({ atMs: T0 + sec * 1000, value })

  it('途切れと値の無い刻みで線を切る', () => {
    const series = [pt(0, 1), pt(1, 1.2), pt(2, null), pt(3, 1.1), pt(4, 1.3), pt(10, 2), pt(11, 2.1)]
    const segs = seriesSegments(series, { fromMs: T0, toMs: T0 + 20_000 }, 1_500)
    expect(segs.map((s) => s.length)).toEqual([2, 2, 2])
  })

  it('範囲の外は落とし、端をまたぐ隣の 1 点ずつは残す', () => {
    const series = [pt(0, 1), pt(1, 1), pt(2, 1), pt(3, 1), pt(4, 1), pt(5, 1)]
    const segs = seriesSegments(series, { fromMs: T0 + 2_500, toMs: T0 + 3_500 }, 1_500)
    expect(segs[0].map((p) => (p.atMs - T0) / 1000)).toEqual([2, 3, 4])
  })
})
