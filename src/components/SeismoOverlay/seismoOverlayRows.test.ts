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
    waveStale: false,
    waveTally: { gapSamples: 0, restarts: 0, droppedSamples: 0 },
  }
}

describe('seismoOverlayRows', () => {
  it('観測点が無ければ空', () => {
    expect(seismoOverlayRows([])).toEqual([])
  })

  // **従来の答えを覆した**（2026-10-08）: 以前は四捨五入で 1.26 を「1.3」と出していた。
  // 気象庁は小数第 3 位を四捨五入してから第 2 位を切り捨てる。
  it('計測震度は気象庁の手順で小数 1 桁（1.26 は 1.2）', () => {
    expect(seismoOverlayRows([station(1.26)])[0].valueText).toBe('1.2')
    expect(seismoOverlayRows([station(0.193)])[0].valueText).toBe('0.1')
  })

  // #526: 数字と階級を別々の丸め方で出すと、「2.5」の隣に震度2 が並んだ。
  it('数字と階級は同じ値から出る（2.4951 は「2.5」・震度3、2.46 は「2.4」・震度2）', () => {
    const up = seismoOverlayRows([station(2.4951)])[0]
    expect([up.valueText, up.gradeLabel]).toEqual(['2.5', '3'])
    const down = seismoOverlayRows([station(2.46)])[0]
    expect([down.valueText, down.gradeLabel]).toEqual(['2.4', '2'])
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

  describe('値が途絶えたとき', () => {
    it('正: 出どころを名乗らず、赤くする印を立てる', () => {
      const row = seismoOverlayRows([station(null, { kind: 'silent' })])[0]
      expect(row.silent).toBe(true)
      // **文言は 1 つも足さない。** 止まっていることは行の色で示す（`index.tsx`。
      // 更新時刻の帯が止まったときと同じ作法）。ここで語を増やすと、隣の帯と
      // 同じ事実が 2 通りの見え方になる。
      expect(row.sourceText).toBe('')
      expect(row.valueText).toBeNull()
      expect(row.gradeLabel).toBeNull()
    })

    it('対照: 震度を出せていないだけの行は赤くしない', () => {
      // **`intensity === null` では代われない。** センサーは届いているのに震度が
      // まだ出せない起動直後がこれで、止まっているわけではない。
      const row = seismoOverlayRows([station(null, { kind: 'sensor', sensorCount: 3 })])[0]
      expect(row.silent).toBe(false)
      expect(row.sourceText).toBe('単独 3本')
    })

    it('安全弁: 震度が出ている行は赤くしない', () => {
      expect(seismoOverlayRows([station(0.4)])[0].silent).toBe(false)
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
