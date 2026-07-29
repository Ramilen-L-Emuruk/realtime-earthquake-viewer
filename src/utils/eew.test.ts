import { describe, it, expect } from 'vitest'
import { calcArrivalSafetyMarginSec, diffHypoInfoEvents, type HypoInfoPendingMissing } from './eew'
import type { YahooHypoInfoItem } from '../services/kyoshin'

function makeItem(overrides: Partial<YahooHypoInfoItem> = {}): YahooHypoInfoItem {
  return {
    reportId: '20260101120000',
    reportNum: '1',
    reportTime: '2026/01/01 12:00:01',
    originTime: '2026/01/01 12:00:00',
    regionName: 'テスト地方',
    latitude: '35.0N',
    longitude: '135.0E',
    depth: '10km',
    magnitude: '6.0',
    calcintensity: '04',
    isFinal: 'false',
    isCancel: 'false',
    isTraining: 'false',
    ...overrides,
  }
}

const noPending = new Map<string, HypoInfoPendingMissing>()

describe('diffHypoInfoEvents', () => {
  it('新規発報時は解除イベントを出さずに1件のEEWイベントを出す', () => {
    const item = makeItem()
    const { events, pendingMissing } = diffHypoInfoEvents([], [item], noPending)
    expect(events).toHaveLength(1)
    expect(events[0].cancelled).toBe(false)
    expect(pendingMissing.size).toBe(0)
  })

  it('reportNum が変化した続報を検知する', () => {
    const prevItem = makeItem({ reportNum: '1' })
    const currItem = makeItem({ reportNum: '2' })
    const { events } = diffHypoInfoEvents([prevItem], [currItem], noPending)
    expect(events).toHaveLength(1)
    expect(events[0].issue?.serial).toBe('2')
  })

  it('reportNum が同じ再受信ではイベントを出さない', () => {
    const item = makeItem()
    const { events } = diffHypoInfoEvents([item], [item], noPending)
    expect(events).toHaveLength(0)
  })

  it('1回だけリストから消えても即座には解除しない（瞬間的な欠測の猶予）', () => {
    const item = makeItem()
    const { events, pendingMissing } = diffHypoInfoEvents([item], [], noPending)
    expect(events).toHaveLength(0)
    expect(pendingMissing.get(item.reportId)).toEqual({ item, missingTicks: 1 })
  })

  it('猶予中に復活すれば解除イベントを出さず pendingMissing もクリアされる', () => {
    const item = makeItem()
    const pending = new Map([[item.reportId, { item, missingTicks: 1 }]])
    // 消滅を検知した回の prev には既に item が含まれないため空配列で渡す
    const { events, pendingMissing } = diffHypoInfoEvents([], [item], pending)
    expect(events).toHaveLength(0)
    expect(pendingMissing.size).toBe(0)
  })

  it('猶予回数を超えて消え続けたら解除を確定する（isCancel=false → 自動終了扱い）', () => {
    const item = makeItem({ isCancel: 'false' })
    const pending = new Map([[item.reportId, { item, missingTicks: 1 }]])
    const { events, pendingMissing } = diffHypoInfoEvents([], [], pending)
    expect(events).toHaveLength(1)
    expect(events[0].cancelled).toBe(true)
    // 誤報取消ではなく自動終了として expired を立てる（誤報取消の音・通知を鳴らさないため）
    expect(events[0].expired).toBe(true)
    expect(pendingMissing.size).toBe(0)
  })

  it('猶予回数を超えて消え続けたら解除を確定する（isCancel=true → 誤報取消扱い）', () => {
    const item = makeItem({ isCancel: 'true' })
    const pending = new Map([[item.reportId, { item, missingTicks: 1 }]])
    const { events } = diffHypoInfoEvents([], [], pending)
    expect(events).toHaveLength(1)
    expect(events[0].cancelled).toBe(true)
    expect(events[0].expired).toBeUndefined()
  })

  it('複数EEW同時追跡中、片方だけ消滅してももう片方は影響を受けない', () => {
    const itemA = makeItem({ reportId: 'eventA' })
    const itemB = makeItem({ reportId: 'eventB' })
    // itemA だけがリストから消える
    const { events: tick1Events, pendingMissing } = diffHypoInfoEvents([itemA, itemB], [itemB], noPending)
    expect(tick1Events).toHaveLength(0)
    expect(pendingMissing.size).toBe(1)
    expect(pendingMissing.has('eventA')).toBe(true)

    // itemB は続報（reportNum更新）、itemA は猶予回数超過で解除確定
    const itemBUpdated = { ...itemB, reportNum: '2' }
    const { events: tick2Events } = diffHypoInfoEvents([itemB], [itemBUpdated], pendingMissing)
    expect(tick2Events).toHaveLength(2)
    const cancelledA = tick2Events.find(e => e.issue?.eventId === 'eventA')
    const updatedB = tick2Events.find(e => e.issue?.eventId === 'eventB')
    expect(cancelledA?.cancelled).toBe(true)
    expect(updatedB?.issue?.serial).toBe('2')
    expect(updatedB?.cancelled).toBe(false)
  })
})

describe('calcArrivalSafetyMarginSec', () => {
  it('震源直上(0km)ではマージンが0になる', () => {
    expect(calcArrivalSafetyMarginSec(0)).toBe(0)
  })

  it('距離に比例して増加する（70kmで約2.1秒）', () => {
    expect(calcArrivalSafetyMarginSec(70)).toBeCloseTo(2.1, 5)
  })

  it('上限(4秒)を超える距離では頭打ちになる', () => {
    expect(calcArrivalSafetyMarginSec(1000)).toBe(4)
  })

  it('上限に到達する境界(約133.3km)の前後で連続的に頭打ちに切り替わる', () => {
    expect(calcArrivalSafetyMarginSec(133.3)).toBeCloseTo(4, 1)
    expect(calcArrivalSafetyMarginSec(133.34)).toBe(4)
  })
})
