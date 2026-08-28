import { describe, it, expect } from 'vitest'
import { buildTsunamiEntries } from './historicalTsunamiArchiveBuilder'
import type { ParsedTsunamiObservationRow, ParsedTsunamiStage } from './historicalTsunamiParser'

function stage(overrides: Partial<ParsedTsunamiStage>): ParsedTsunamiStage {
  return {
    monthDay: '3月11日',
    timeText: '14時49分',
    summary: '津波警報・注意報発表',
    majorWarning: [],
    warning: [],
    watch: [],
    isFullCancel: false,
    ...overrides,
  }
}

const baseOpts = {
  idPrefix: 'test',
  eventId: '20110311144618',
  year: 2011,
  hypocenterName: '三陸沖',
  originTimeIso: '2011-03-11T05:46:00.000Z',
  magnitudeByStage: { 1: 7.9, 2: 8.8 },
}

describe('buildTsunamiEntries の高さ判定', () => {
  it('正: 今の等級が最終到達等級と一致する地域は、観測表の予測高さを使う', () => {
    const stages = [stage({ majorWarning: ['宮城県'] })]
    const observations: ParsedTsunamiObservationRow[] = [
      { regionName: '宮城県', grade: 'ootsunami', predictedText: '大津波（10m以上）', predictedHeightM: 10 },
    ]
    const [entry] = buildTsunamiEntries(stages, observations, baseOpts)
    const area = (entry.payload as { event: { areas: { maxHeight?: { description: string } }[] } }).event.areas[0]
    expect(area.maxHeight).toEqual({ description: '10m以上', value: 10 })
  })

  it('対照（バグ回帰）: まだ最終到達等級に届いていない段階では、観測表の最終値を流用しない', () => {
    // 実例: 北海道太平洋沿岸中部は最終的に「大津波(8m)」に到達するが、本震発生直後の
    // 第1報時点ではまだ「津波警報（津波）」段階だった。ここで最終値8mを出すと過大表示になる。
    const stages = [stage({ warning: ['北海道太平洋沿岸中部'] })]
    const observations: ParsedTsunamiObservationRow[] = [
      { regionName: '北海道太平洋沿岸中部', grade: 'ootsunami', predictedText: '大津波(8m)', predictedHeightM: 8 },
    ]
    const [entry] = buildTsunamiEntries(stages, observations, baseOpts)
    const area = (entry.payload as { event: { areas: { maxHeight?: unknown }[] } }).event.areas[0]
    expect(area.maxHeight).toBeUndefined()
  })

  it('安全弁: 明示的な上書き値があれば、観測表の値より優先する', () => {
    const stages = [stage({ warning: ['千葉県内房'] })]
    const observations: ParsedTsunamiObservationRow[] = [
      { regionName: '千葉県内房', grade: 'ootsunami', predictedText: '大津波（4m）', predictedHeightM: 4 },
    ]
    const [entry] = buildTsunamiEntries(stages, observations, {
      ...baseOpts,
      heightOverrides: { 1: { 千葉県内房: 1 } },
    })
    const area = (entry.payload as { event: { areas: { maxHeight?: { value: number } }[] } }).event.areas[0]
    expect(area.maxHeight?.value).toBe(1)
  })

  it('津波注意報は常に0.5m（観測表の値を見ない）', () => {
    const stages = [stage({ watch: ['和歌山県'] })]
    const observations: ParsedTsunamiObservationRow[] = [
      { regionName: '和歌山県', grade: 'ootsunami', predictedText: '大津波（3m）', predictedHeightM: 3 },
    ]
    const [entry] = buildTsunamiEntries(stages, observations, baseOpts)
    const area = (entry.payload as { event: { areas: { maxHeight?: { value: number } }[] } }).event.areas[0]
    expect(area.maxHeight?.value).toBe(0.5)
  })

  it('全解除ステージは cancelled:true・areas:[] になる', () => {
    const stages = [stage({ isFullCancel: true, timeText: '17時58分', summary: '津波注意報解除' })]
    const [entry] = buildTsunamiEntries(stages, [], baseOpts)
    const event = (entry.payload as { event: { cancelled: boolean; cancelReason?: string; areas: unknown[] } }).event
    expect(event.cancelled).toBe(true)
    expect(event.cancelReason).toBe('lifted')
    expect(event.areas).toEqual([])
  })
})
