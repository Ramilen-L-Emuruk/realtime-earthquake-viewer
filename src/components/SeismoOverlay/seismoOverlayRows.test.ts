import { describe, it, expect } from 'vitest'

import type { SeismoIntensitySource, SeismoStationState } from '../../hooks/useSeismoStation'
import { getIntensityColor } from '../../utils/intensity'
import { SHINDO0_COLOR } from '../../utils/measuredIntensity'

import { seismoOverlayRows } from './seismoOverlayRows'

function station(
  intensity: number | null,
  source: SeismoIntensitySource = { kind: 'station' },
): SeismoStationState {
  return {
    stationId: 'station-1',
    displayName: '自宅',
    intensity,
    atMs: 1_700_000_000_000,
    source,
    waveSampleCount: 0,
    waveTally: { gapSamples: 0, restarts: 0, droppedSamples: 0 },
  }
}

describe('seismoOverlayRows', () => {
  it('観測点が無ければ空', () => {
    expect(seismoOverlayRows([])).toEqual([])
  })

  it('計測震度は小数 1 桁（気象庁の公表に合わせる）', () => {
    expect(seismoOverlayRows([station(1.26)])[0].valueText).toBe('1.3')
    expect(seismoOverlayRows([station(0.193)])[0].valueText).toBe('0.2')
  })

  // 静穏時のホストは負の計測震度を返す。**行ごと消さない** ——
  // 地震計が生きていることがこのカードの主な情報なので、値が見えないと
  // 「繋がっていない」と区別が付かなくなる。
  it('負の計測震度も震度0 として出す', () => {
    const row = seismoOverlayRows([station(-0.32)])[0]
    expect(row.gradeLabel).toBe('0')
    expect(row.gradeColor).toBe(SHINDO0_COLOR)
    expect(row.valueText).toBe('-0.3')
  })

  // `toFixed` は符号を保つので `(-0.04).toFixed(1)` は `"-0.0"` を返す。
  // **マイナスゼロは表示が壊れたようにしか見えない**（静穏時にはこの範囲の値がよく出る）。
  it('丸めて 0 になる負の値を「-0.0」と出さない', () => {
    expect(seismoOverlayRows([station(-0.04)])[0].valueText).toBe('0.0')
    expect(seismoOverlayRows([station(-0.001)])[0].valueText).toBe('0.0')
  })

  it('震度1 以上は気象庁の震度配色', () => {
    const row = seismoOverlayRows([station(4.7)])[0]
    expect(row.gradeLabel).toBe('5弱')
    expect(row.gradeColor).toBe(getIntensityColor(45))
  })

  it('震度を出せない観測点は階級も数字も持たない', () => {
    const row = seismoOverlayRows([station(null)])[0]
    expect(row.gradeLabel).toBeNull()
    expect(row.gradeColor).toBeNull()
    expect(row.valueText).toBeNull()
  })

  // **壊れた値を「計測震度」として見せない。** 数字だけ出すと、階級が空なのは
  // 表示の不具合に見える。
  it('非有限の震度は階級も数字も出さない', () => {
    const row = seismoOverlayRows([station(Number.NaN)])[0]
    expect(row.gradeLabel).toBeNull()
    expect(row.valueText).toBeNull()
  })

  describe('出どころ', () => {
    it('合成（本数は添えない——ホストが持っていない）', () => {
      expect(seismoOverlayRows([station(0.2, { kind: 'station' })])[0].sourceText).toBe('合成')
    })

    it('センサー単独は何本から採ったかを出す', () => {
      const row = seismoOverlayRows([station(1.26, { kind: 'sensor', sensorCount: 7 })])[0]
      expect(row.sourceText).toBe('単独 7本の最大')
    })

    // 1 本しか無いときに「1本の最大」と書くと、最大と呼べる相手がいない。
    it('センサーが 1 本だけなら裏付けが無いことを言い切る', () => {
      const row = seismoOverlayRows([station(1.26, { kind: 'sensor', sensorCount: 1 })])[0]
      expect(row.sourceText).toBe('単独（裏付けなし）')
    })

    // **震度欄が `—` のときに「最大」と書くと食い違って見える。** センサーは届いて
    // いるが震度がまだ出せない起動直後に起きる（ホストは窓が足りなければ `null` を返す）。
    it('震度を出せていないときは「最大」と名乗らない', () => {
      const row = seismoOverlayRows([station(null, { kind: 'sensor', sensorCount: 3 })])[0]
      expect(row.valueText).toBeNull()
      expect(row.sourceText).toBe('単独 3本')
    })

    it('合成は震度を出せていなくても文言が変わらない（本数を持たないため）', () => {
      expect(seismoOverlayRows([station(null, { kind: 'station' })])[0].sourceText).toBe('合成')
    })
  })

  it('渡された順を変えない（並べ替えは状態層の仕事）', () => {
    const rows = seismoOverlayRows([
      { ...station(0.1), stationId: 'b', displayName: '物置' },
      { ...station(0.2), stationId: 'a', displayName: '自宅' },
    ])
    expect(rows.map((r) => r.stationId)).toEqual(['b', 'a'])
  })
})
