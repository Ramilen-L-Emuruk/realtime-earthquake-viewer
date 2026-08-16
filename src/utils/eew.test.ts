import { describe, it, expect } from 'vitest'
import { calcArrivalSafetyMarginSec, calcEEWAutoCancelSec, calcEEWCancelTime, calcFeltRadiusKm, diffHypoInfoEvents, computeSingleEEWLevel, eewMaxLpgmClass, eewMaxScale, eewSerial, selectEEWSoundType, type HypoInfoPendingMissing } from './eew'
import type { YahooHypoInfoItem } from '../services/kyoshin'
import type { EEWAlert, IntensityScale, LpgmClass } from '../types/earthquake'

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

  it('震度未確定(scaleTo:-1)は特別警報の対象外でレベル1', () => {
    const eew = makeEEW({
      areas: [{ pref: 'テスト県', name: 'テスト地域', scaleFrom: -1, scaleTo: -1, kindCode: '10', arrivalTime: null }],
    })
    expect(computeSingleEEWLevel(eew)).toBe(1)
  })

  // 実地震シナリオ JSON など型検査を通らない経路から不正値が来た場合の防御。
  // 震度スケール外の値をそのまま比較に使うと特別警報へ誤昇格する。
  it('areas の震度スケール外の値(scaleTo:99)は採用せず特別警報にしない', () => {
    const eew = makeEEW({
      areas: [{
        pref: 'テスト県',
        name: 'テスト地域',
        scaleFrom: -1,
        scaleTo: 99 as unknown as IntensityScale,
        kindCode: '10',
        arrivalTime: null,
      }],
    })
    expect(eewMaxScale(eew)).toBe(0)
    expect(computeSingleEEWLevel(eew)).toBe(1)
  })

  it('震度スケール外の forecastMaxScale(66)も採用せず特別警報にしない', () => {
    const eew = makeEEW({ forecastMaxScale: 66 as unknown as IntensityScale })
    expect(eewMaxScale(eew)).toBe(0)
    expect(computeSingleEEWLevel(eew)).toBe(1)
  })

  // 特別警報は震度と長周期地震動階級の OR 判定なので、震度側だけ守っても誤昇格は防げない。
  it('範囲外の長周期地震動階級(lgIntTo:99)は採用せず特別警報にしない', () => {
    const eew = makeEEW({
      areas: [{
        pref: 'A県',
        name: 'A地域',
        scaleFrom: 30,
        scaleTo: 40,
        kindCode: '10',
        arrivalTime: null,
        lgIntTo: 99 as unknown as LpgmClass,
      }],
    })
    expect(eewMaxLpgmClass(eew)).toBe(0)
    expect(computeSingleEEWLevel(eew)).toBe(1)
  })

  it('範囲外の forecastMaxLpgmClass(99)も採用せず特別警報にしない', () => {
    const eew = makeEEW({ forecastMaxLpgmClass: 99 as unknown as LpgmClass })
    expect(eewMaxLpgmClass(eew)).toBe(0)
    expect(computeSingleEEWLevel(eew)).toBe(1)
  })

  it('areas に有効値と不正値が混在する場合は有効値の最大を採る', () => {
    const eew = makeEEW({
      areas: [
        { pref: 'A県', name: 'A地域', scaleFrom: 30, scaleTo: 40, kindCode: '10', arrivalTime: null },
        { pref: 'B県', name: 'B地域', scaleFrom: -1, scaleTo: 99 as unknown as IntensityScale, kindCode: '10', arrivalTime: null },
      ],
    })
    expect(eewMaxScale(eew)).toBe(40)
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

describe('selectEEWSoundType', () => {
  it('新規発報・特別警報級は eewSpecial', () => {
    expect(selectEEWSoundType(true, false, 2, false)).toBe('eewSpecial')
  })

  it('新規発報・警報級は eew', () => {
    expect(selectEEWSoundType(true, false, 1, false)).toBe('eew')
  })

  it('新規発報・予報級は eewForecast', () => {
    expect(selectEEWSoundType(true, false, 0, false)).toBe('eewForecast')
  })

  it('新規発報かつ最終報でも新規側の音（警報系）を優先する', () => {
    expect(selectEEWSoundType(true, false, 2, true)).toBe('eewSpecial')
  })

  it('レベル格上げは新規と同じ扱い（特別警報級）', () => {
    expect(selectEEWSoundType(false, true, 2, false)).toBe('eewSpecial')
  })

  it('レベル格上げは新規と同じ扱い（警報級）', () => {
    expect(selectEEWSoundType(false, true, 1, false)).toBe('eew')
  })

  it('最終報かつレベル格上げは eewFinal より eewSpecial を優先する（CRIT-2 対応：最終報で震度が上がる最重要ケースを警戒音で知らせる）', () => {
    expect(selectEEWSoundType(false, true, 2, true)).toBe('eewSpecial')
  })

  it('続報の最終報（新規でも格上げでもない）は eewFinal', () => {
    expect(selectEEWSoundType(false, false, 1, true)).toBe('eewFinal')
  })

  it('通常続報（最終でも新規でも格上げでもない）は eewUpdate', () => {
    expect(selectEEWSoundType(false, false, 1, false)).toBe('eewUpdate')
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

// EEW-4: 司・翠川式ベースの自動解除ロジック。細部の丸めに依存しない性質ベースのテスト。
describe('calcFeltRadiusKm: 司・翠川式による有感半径の逆算', () => {
  it('マグニチュードが大きいほど有感半径が大きくなる（浅発 depth=10）', () => {
    const r5 = calcFeltRadiusKm(5.0, 10)
    const r6 = calcFeltRadiusKm(6.0, 10)
    const r7 = calcFeltRadiusKm(7.0, 10)
    expect(r5).toBeLessThan(r6)
    expect(r6).toBeLessThan(r7)
  })

  it('浅発と深発（同 M6.0）: 半径は 0 より大きく上限内に収まる', () => {
    const rShallow = calcFeltRadiusKm(6.0, 10)
    const rDeep = calcFeltRadiusKm(6.0, 300)
    expect(rShallow).toBeGreaterThan(0)
    expect(rDeep).toBeGreaterThan(0)
    expect(rShallow).toBeLessThanOrEqual(2500)
    expect(rDeep).toBeLessThanOrEqual(2500)
  })

  it('targetIntensity が大きいほど有感半径は狭くなる（震度1 > 震度3 > 震度5）', () => {
    const r1 = calcFeltRadiusKm(7.0, 10, 1.0)
    const r3 = calcFeltRadiusKm(7.0, 10, 3.0)
    const r5 = calcFeltRadiusKm(7.0, 10, 5.0)
    expect(r1).toBeGreaterThan(r3)
    expect(r3).toBeGreaterThan(r5)
  })

  it('MAX_FELT_RADIUS_KM=2500 の上限にクランプする（M9.5 で発火）', () => {
    // M9.0 では実測 ~1935km でクランプ未発火。M9.5 で理論値が上限を超えクランプが効く。
    expect(calcFeltRadiusKm(9.5, 10)).toBeLessThanOrEqual(2500)
    // 二分探索の丸め誤差で 2500.0 に近い値になる（Number.EPSILON レベル）
    expect(calcFeltRadiusKm(10.0, 10)).toBeCloseTo(2500, 10)
  })

  it('mjma<3.0 は 3.0 として扱う（下限クランプ）', () => {
    expect(calcFeltRadiusKm(2.0, 10)).toBe(calcFeltRadiusKm(3.0, 10))
  })

  it('ゴールデン値: M6.0 depth=10 の有感半径（現在値ピン留め・係数改変時の警戒用）', () => {
    // 実装式の絶対値ピン留め。将来の係数改変や式リファクタで大きくずれたら気付く。
    // 単調性テストだけでは係数の絶対値変化を検知できないため。
    expect(calcFeltRadiusKm(6.0, 10)).toBeCloseTo(478, 0)
  })
})

describe('calcEEWAutoCancelSec: 自動解除までの秒数（有感半径のS波到達 + 30秒）', () => {
  it('マグニチュードが大きいほど自動解除秒数も長くなる', () => {
    expect(calcEEWAutoCancelSec(5.0, 10)).toBeLessThan(calcEEWAutoCancelSec(7.0, 10))
  })

  it('30 秒（FIXED_BUFFER_SEC）以上を返す', () => {
    expect(calcEEWAutoCancelSec(5.0, 10)).toBeGreaterThanOrEqual(30)
    expect(calcEEWAutoCancelSec(3.0, 10)).toBeGreaterThanOrEqual(30)
  })
})

describe('calcEEWCancelTime: 発震時刻起点の自動解除時刻（MIN_CANCEL_SEC 下限保証付き）', () => {
  function makeEEWFor(m: number, depth: number, originTime: string): EEWAlert {
    return makeEEW({
      earthquake: {
        originTime,
        arrivalTime: originTime,
        condition: '以上',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth, magnitude: m },
      },
    })
  }

  it('originTime + autoCancelSec が reportTime + 60 秒より後なら originTime 基準を返す（大 M）', () => {
    const originTime = '2026-01-01T12:00:00Z'
    const reportTime = new Date('2026-01-01T12:00:10Z')
    const eew = makeEEWFor(7.0, 10, originTime)
    const cancel = calcEEWCancelTime(eew, reportTime)
    const originBase = new Date(new Date(originTime).getTime() + calcEEWAutoCancelSec(7.0, 10) * 1000)
    expect(cancel.getTime()).toBe(originBase.getTime())
    expect(cancel.getTime()).toBeGreaterThan(reportTime.getTime() + 60 * 1000)
  })

  it('小さな M・遅い reportTime では reportTime + MIN_CANCEL_SEC(60秒) の下限が採用される', () => {
    const originTime = '2026-01-01T12:00:00Z'
    const reportTime = new Date('2026-01-01T12:05:00Z')
    const eew = makeEEWFor(5.0, 10, originTime)
    const cancel = calcEEWCancelTime(eew, reportTime)
    const minTime = new Date(reportTime.getTime() + 60 * 1000)
    expect(cancel.getTime()).toBe(minTime.getTime())
  })
})

describe('eewSerial', () => {
  it('issue.serial が正の整数文字列なら number に変換して返す', () => {
    const eew = makeEEW({ issue: { time: '2026-01-01T12:00:00Z', eventId: 'e1', serial: '3' } })
    expect(eewSerial(eew)).toBe(3)
  })

  it('serial が "1" でも受け付ける（初報）', () => {
    const eew = makeEEW({ issue: { time: '2026-01-01T12:00:00Z', eventId: 'e1', serial: '1' } })
    expect(eewSerial(eew)).toBe(1)
  })

  it('serial が数値以外の文字列なら null', () => {
    const eew = makeEEW({ issue: { time: '2026-01-01T12:00:00Z', eventId: 'e1', serial: 'abc' } })
    expect(eewSerial(eew)).toBeNull()
  })

  it('serial が 0 以下なら null（第0報は仕様上ない）', () => {
    const eew = makeEEW({ issue: { time: '2026-01-01T12:00:00Z', eventId: 'e1', serial: '0' } })
    expect(eewSerial(eew)).toBeNull()
  })

  it('serial が負なら null', () => {
    const eew = makeEEW({ issue: { time: '2026-01-01T12:00:00Z', eventId: 'e1', serial: '-2' } })
    expect(eewSerial(eew)).toBeNull()
  })

  it('serial が浮動小数点なら null（整数のみ受け付ける）', () => {
    const eew = makeEEW({ issue: { time: '2026-01-01T12:00:00Z', eventId: 'e1', serial: '1.5' } })
    expect(eewSerial(eew)).toBeNull()
  })

  it('serial が空文字なら null', () => {
    const eew = makeEEW({ issue: { time: '2026-01-01T12:00:00Z', eventId: 'e1', serial: '' } })
    expect(eewSerial(eew)).toBeNull()
  })

  it('issue 自体が無ければ null', () => {
    const eew = makeEEW()
    // issue プロパティが未定義（optional chain で null を返すルート）
    expect(eewSerial(eew)).toBeNull()
  })
})
