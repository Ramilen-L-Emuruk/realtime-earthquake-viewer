import { describe, it, expect } from 'vitest'
import { calcArrivalSafetyMarginSec, diffHypoInfoEvents, computeSingleEEWLevel, eewMaxLpgmClass, type HypoInfoPendingMissing } from './eew'
import type { YahooHypoInfoItem } from '../services/kyoshin'
import type { EEWAlert } from '../types/earthquake'

function makeEEW(overrides: Partial<EEWAlert> = {}): EEWAlert {
  return {
    kind: 'eew',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '以上',
      hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
    },
    severity: 'Warning',
    cancelled: false,
    ...overrides,
  }
}

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

describe('computeSingleEEWLevel', () => {
  it('severityがForecastなら震度・長周期地震動階級が高くても常にレベル0', () => {
    const eew = makeEEW({ severity: 'Forecast', forecastMaxScale: 60, forecastMaxLpgmClass: 4 })
    expect(computeSingleEEWLevel(eew)).toBe(0)
  })

  it('severity=Warningかつ震度6弱未満・長周期地震動階級なしはレベル1（警報）', () => {
    const eew = makeEEW({ forecastMaxScale: 50 })
    expect(computeSingleEEWLevel(eew)).toBe(1)
  })

  it('severity=Warningかつ震度6弱以上はレベル2（特別警報）', () => {
    const eew = makeEEW({ forecastMaxScale: 55 })
    expect(computeSingleEEWLevel(eew)).toBe(2)
  })

  it('震度算出不能(scaleTo:99)は特別警報の対象外でレベル1', () => {
    const eew = makeEEW({
      areas: [{ pref: 'テスト県', name: 'テスト地域', scaleFrom: 99, scaleTo: 99, kindCode: '10', arrivalTime: null }],
    })
    expect(computeSingleEEWLevel(eew)).toBe(1)
  })

  it('震度は6弱未満でも長周期地震動階級4以上ならレベル2（特別警報）', () => {
    const eew = makeEEW({ forecastMaxScale: 40, forecastMaxLpgmClass: 4 })
    expect(computeSingleEEWLevel(eew)).toBe(2)
  })

  it('地域別lgIntToの最大値が4以上ならレベル2（特別警報）', () => {
    const eew = makeEEW({
      areas: [
        { pref: 'A県', name: 'A地域', scaleFrom: 30, scaleTo: 40, kindCode: '10', arrivalTime: null, lgIntTo: 3 },
        { pref: 'B県', name: 'B地域', scaleFrom: 30, scaleTo: 40, kindCode: '10', arrivalTime: null, lgIntTo: 4 },
      ],
    })
    expect(computeSingleEEWLevel(eew)).toBe(2)
  })

  it('長周期地震動階級3以下・震度も低ければレベル1（警報）', () => {
    const eew = makeEEW({ forecastMaxScale: 40, forecastMaxLpgmClass: 3 })
    expect(computeSingleEEWLevel(eew)).toBe(1)
  })

  it('仮定震源要素（単独点処理）は震度・長周期地震動階級とも0扱いでレベル1', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '仮定震源要素',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
      },
      forecastMaxScale: 60,
      forecastMaxLpgmClass: 4,
    })
    expect(computeSingleEEWLevel(eew)).toBe(1)
  })

  it('震度6弱以上と長周期地震動階級4以上を同時に満たしてもレベル2のまま', () => {
    const eew = makeEEW({ forecastMaxScale: 60, forecastMaxLpgmClass: 4 })
    expect(computeSingleEEWLevel(eew)).toBe(2)
  })
})

describe('eewMaxLpgmClass', () => {
  it('areasもforecastMaxLpgmClassも無ければ0', () => {
    const eew = makeEEW()
    expect(eewMaxLpgmClass(eew)).toBe(0)
  })

  it('areasが空配列でもforecastMaxLpgmClassがあればそれを返す', () => {
    const eew = makeEEW({ areas: [], forecastMaxLpgmClass: 2 })
    expect(eewMaxLpgmClass(eew)).toBe(2)
  })

  it('areas内のlgIntTo最大値をforecastMaxLpgmClassより優先する', () => {
    const eew = makeEEW({
      areas: [{ pref: 'A県', name: 'A地域', scaleFrom: 30, scaleTo: 40, kindCode: '10', arrivalTime: null, lgIntTo: 2 }],
      forecastMaxLpgmClass: 4,
    })
    expect(eewMaxLpgmClass(eew)).toBe(2)
  })

  it('areas内にlgIntToを持つ地域が無ければforecastMaxLpgmClassにフォールバックする', () => {
    const eew = makeEEW({
      areas: [{ pref: 'A県', name: 'A地域', scaleFrom: 30, scaleTo: 40, kindCode: '10', arrivalTime: null }],
      forecastMaxLpgmClass: 3,
    })
    expect(eewMaxLpgmClass(eew)).toBe(3)
  })

  it('仮定震源要素かつareasが空なら0（forecastMaxLpgmClassがあっても無視）', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '仮定震源要素',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
      },
      forecastMaxLpgmClass: 4,
    })
    expect(eewMaxLpgmClass(eew)).toBe(0)
  })

  it('仮定震源要素でもareas内にlgIntToがあればそちらを優先する（areasMax>0の判定が先のため）', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '仮定震源要素',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
      },
      areas: [{ pref: 'A県', name: 'A地域', scaleFrom: 30, scaleTo: 40, kindCode: '10', arrivalTime: null, lgIntTo: 3 }],
    })
    expect(eewMaxLpgmClass(eew)).toBe(3)
  })
})
