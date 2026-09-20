import { describe, it, expect } from 'vitest'
import { eewEpicenterRankLabel, eewMagnitudeRankLabel, eewMagnitudePointsLabel, isEewHypocenterSettled, eewForecastChangeText, calcArrivalSafetyMarginSec, calcEEWAutoCancelSec, calcEEWCancelTime, calcFeltRadiusKm, diffHypoInfoEvents, computeSingleEEWLevel, eewMaxLpgmClass, eewMaxScale, eewMaxScaleInfo, isForecastScaleHigher, eewNoForecastReason, canPresentLpgmClass, eewSerial, selectEEWSoundType, eewPhase2ScaleStabilityMs, EEW_PHASE2_STABILITY_SMALL_MS, EEW_PHASE2_STABILITY_LARGE_MS, isEewAreaArrived, selectActiveEews, isUnannouncedHypocenter, EEW_HYPOCENTER_RESTATE_KM, type HypoInfoPendingMissing, type AnnouncedHypocenter } from './eew'
import type { YahooHypoInfoItem } from '../services/kyoshin'
import type { EEWAlert, EEWRegion, IntensityScale, LpgmClass } from '../types/earthquake'

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

  // **かつては仮定震源要素を震度・階級とも 0 扱いにしてレベル1に落としていた。** 気象庁が
  // 最大予測震度を発表しない条件は「観測点 1 点による震度予測」と「深さ 150km 超」の 2 つで、
  // 該当すれば電文に値が入らない。値が載っている報を受信側で潰す理由は無く、潰せば深刻な予想を
  // 軽い扱いへ落とすことになる（詳細は eewMaxScaleInfo のコメント）。
  it('仮定震源要素でも電文全体の予想値を採る（震度6弱以上ならレベル2へ上げる）', () => {
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
    expect(computeSingleEEWLevel(eew)).toBe(2)
  })

  // 対照: 値を持たない仮定震源要素（＝気象庁が発表しなかった報）はレベル1のまま。
  // 「condition を無視するようにした」のではなく「値があれば採る」だけであることを固定する。
  it('仮定震源要素で予想値を持たない報はレベル1に留まる', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '仮定震源要素',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 1.0 },
      },
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

describe('eewMaxScaleInfo: 「〜以上」の集約', () => {
  function area(overrides: Partial<EEWRegion>): EEWRegion {
    return { pref: 'A県', name: 'A地域', scaleFrom: 40, scaleTo: 40, kindCode: '10', arrivalTime: null, ...overrides }
  }

  it('「以上」の区域が最大なら orAbove を立てる', () => {
    // 2024/1/1 16:18 の余震の初報に相当（石川県能登 震度4以上・仮定震源要素）。
    const eew = makeEEW({ areas: [area({ scaleFrom: 40, scaleTo: 40, scaleToOrAbove: true })] })
    expect(eewMaxScaleInfo(eew)).toEqual({ scale: 40, orAbove: true })
    expect(eewMaxScale(eew)).toBe(40)
  })

  it('上限が定まっている区域だけなら orAbove は false', () => {
    const eew = makeEEW({ areas: [area({ scaleFrom: 40, scaleTo: 50 })] })
    expect(eewMaxScaleInfo(eew)).toEqual({ scale: 50, orAbove: false })
  })

  it('最大でない区域の「以上」は拾わない（低い階級の以上に引きずられない）', () => {
    const eew = makeEEW({
      areas: [
        area({ name: 'A地域', scaleFrom: 40, scaleTo: 40, scaleToOrAbove: true }),
        area({ name: 'B地域', scaleFrom: 55, scaleTo: 60 }),
      ],
    })
    expect(eewMaxScaleInfo(eew)).toEqual({ scale: 60, orAbove: false })
  })

  it('同じ階級で片方だけ「以上」なら「以上」を採る（強い側の表現を残す）', () => {
    const eew = makeEEW({
      areas: [
        area({ name: 'A地域', scaleFrom: 55, scaleTo: 55 }),
        area({ name: 'B地域', scaleFrom: 55, scaleTo: 55, scaleToOrAbove: true }),
      ],
    })
    expect(eewMaxScaleInfo(eew)).toEqual({ scale: 55, orAbove: true })
  })

  it('areas が空なら電文全体の forecastMaxScale とそのフラグを見る', () => {
    const eew = makeEEW({ forecastMaxScale: 40, forecastMaxScaleOrAbove: true })
    expect(eewMaxScaleInfo(eew)).toEqual({ scale: 40, orAbove: true })
  })

  // **かつては仮定震源要素というだけで forecastMaxScale を捨てていた。** 気象庁が最大予測震度を
  // 発表しないのは「観測点 1 点による震度予測」と「深さ 150km 超」で、該当すれば電文に値が入らない。
  // 受信側で潰す必要はなく、潰していた頃は 2024 能登の 1/1〜1/3 で震度3以上の予想を持つ 25 報が
  // 「予想震度なし」に落ちていた。
  it('仮定震源要素でも areas が空なら電文全体の forecastMaxScale を採る', () => {
    const eew = makeEEW({
      earthquake: { ...makeEEW().earthquake, condition: '仮定震源要素' },
      forecastMaxScale: 30,
      forecastMaxScaleOrAbove: true,
    })
    expect(eewMaxScaleInfo(eew)).toEqual({ scale: 30, orAbove: true })
  })

  // 対照: 値そのものが無い報（＝気象庁が発表しなかった報）は 0 のまま。`condition` を無視する
  // ようにしたのではなく、値があれば採るだけであることを固定する。
  it('仮定震源要素で forecastMaxScale を持たない報は 0 のまま', () => {
    const eew = makeEEW({ earthquake: { ...makeEEW().earthquake, condition: '仮定震源要素' } })
    expect(eewMaxScaleInfo(eew)).toEqual({ scale: 0, orAbove: false })
  })

  // 安全弁: 区域別予想を先に見る順序は変えていない。
  it('仮定震源要素でも areas があればそちらを優先する', () => {
    const eew = makeEEW({
      earthquake: { ...makeEEW().earthquake, condition: '仮定震源要素' },
      areas: [area({ scaleFrom: 40, scaleTo: 40, scaleToOrAbove: true })],
      forecastMaxScale: 70,
    })
    expect(eewMaxScaleInfo(eew)).toEqual({ scale: 40, orAbove: true })
  })

  it('震度が取れないときは orAbove を立てない（「不明以上」を作らない）', () => {
    const eew = makeEEW({ areas: [area({ scaleFrom: -1, scaleTo: -1, scaleToOrAbove: true })] })
    expect(eewMaxScaleInfo(eew)).toEqual({ scale: 0, orAbove: false })
  })

  // ここは**この変更で判定結果が変わる**境界。従来は to='over' を震度7として読んでいたため、
  // 「震度5強以上」の警報級が特別警報（レベル2）へ上がっていた。下限で判定する現在は警報
  // （レベル1）に留まる。危険度が下がる向きの変化なので、意図であることを明示して固定する。
  it('「震度5強以上」の警報級は特別警報にしない（下限で判定する）', () => {
    const eew = makeEEW({ areas: [area({ scaleFrom: 50, scaleTo: 50, scaleToOrAbove: true })] })
    expect(eewMaxScaleInfo(eew)).toEqual({ scale: 50, orAbove: true })
    expect(computeSingleEEWLevel(eew)).toBe(1)
  })

  it('「震度6弱以上」なら特別警報のまま（境界の向こう側）', () => {
    const eew = makeEEW({ areas: [area({ scaleFrom: 55, scaleTo: 55, scaleToOrAbove: true })] })
    expect(computeSingleEEWLevel(eew)).toBe(2)
  })

  it('「以上」でも特別警報の判定は据え置き（震度6弱以上 かつ 警報級）', () => {
    // 「6弱以上」は下限が 6弱 なので特別警報のまま。以上フラグは表現だけに効かせる。
    const eew = makeEEW({ areas: [area({ scaleFrom: 55, scaleTo: 55, scaleToOrAbove: true })] })
    expect(computeSingleEEWLevel(eew)).toBe(2)
    // 「震度4以上」の予報級は据え置きでレベル0（severity 必須の既存規則）。
    const forecast = makeEEW({
      severity: 'Forecast',
      areas: [area({ scaleFrom: 40, scaleTo: 40, scaleToOrAbove: true })],
    })
    expect(computeSingleEEWLevel(forecast)).toBe(0)
  })
})

// 読み上げは引き上げだけを追う。階級値だけで比べると「震度4」→「震度4以上」の変化を
// 捉えられず、上限が消えたことを一度も声に出さないまま終わる。
describe('isForecastScaleHigher', () => {
  it('同じ階級で「以上」が付いたら警戒側とみなす', () => {
    expect(isForecastScaleHigher({ scale: 40, orAbove: true }, { scale: 40, orAbove: false })).toBe(true)
  })

  it('同じ階級で「以上」が外れたら追わない（上限が確定した＝引き下げと同じ扱い）', () => {
    expect(isForecastScaleHigher({ scale: 40, orAbove: false }, { scale: 40, orAbove: true })).toBe(false)
  })

  it('同じ階級・同じ「以上」なら動いていない', () => {
    expect(isForecastScaleHigher({ scale: 40, orAbove: true }, { scale: 40, orAbove: true })).toBe(false)
    expect(isForecastScaleHigher({ scale: 40, orAbove: false }, { scale: 40, orAbove: false })).toBe(false)
  })

  it('階級が上がれば「以上」の有無に関わらず警戒側', () => {
    expect(isForecastScaleHigher({ scale: 45, orAbove: false }, { scale: 40, orAbove: true })).toBe(true)
  })

  it('階級が下がれば「以上」が付いても追わない（階級を先に見る）', () => {
    expect(isForecastScaleHigher({ scale: 40, orAbove: true }, { scale: 55, orAbove: false })).toBe(false)
  })

  it('まだ何も読んでいないなら、読む値があるときだけ真', () => {
    expect(isForecastScaleHigher({ scale: 40, orAbove: false }, undefined)).toBe(true)
    // 震度が取れない報（scale=0）では読む値が無い。「以上」が立っていても真にしない
    expect(isForecastScaleHigher({ scale: 0, orAbove: false }, undefined)).toBe(false)
    expect(isForecastScaleHigher({ scale: 0, orAbove: true }, undefined)).toBe(false)
  })
})

describe('isUnannouncedHypocenter（震源の言い直しを判定する）', () => {
  // 2024-01-03 18:48（石川県能登地方 M5.0）の実電文が 5.4 秒で辿った推移。
  const NOTO_LAND = { name: '石川県能登地方', lat: 37.4, lng: 136.9 }
  const NOTO_SEA = { name: '能登半島沖', lat: 37.7, lng: 136.3 }

  const hypo = (name: string, latitude: number, longitude: number) => ({ name, latitude, longitude })

  it('正: 名乗ったどれとも違う地名で、どれからも離れていれば言い直す', () => {
    // 石川県能登地方 → 日本海中部（117km）。実電文の第 2 報がこれ
    expect(isUnannouncedHypocenter([NOTO_LAND], hypo('日本海中部', 38.1, 135.9))).toBe(true)
  })

  it('対照: 一度名乗った場所へ戻っただけなら黙る（直前とだけ比べない）', () => {
    // 実電文の第 7 報。直前に名乗った能登半島沖からは 69km 離れているが、
    // 初報で名乗った石川県能登地方からは 11km しかない
    const announced = [NOTO_LAND, NOTO_SEA]
    expect(isUnannouncedHypocenter(announced, hypo('石川県能登地方', 37.3, 136.9))).toBe(false)
    // 相手が直前の 1 つだけなら「動いた」と判定されてしまう（この修正が覆した挙動）
    expect(isUnannouncedHypocenter([NOTO_SEA], hypo('石川県能登地方', 37.3, 136.9))).toBe(true)
  })

  it('対照: 地名が同じなら、どれだけ離れていても黙る', () => {
    expect(isUnannouncedHypocenter([NOTO_LAND], hypo('石川県能登地方', 30.0, 131.0))).toBe(false)
  })

  it('対照: 地名が新しくても、名乗ったどれかの近くなら黙る（区域の境目をまたいだだけ）', () => {
    expect(isUnannouncedHypocenter([NOTO_LAND], hypo('能登半島沖', 37.5, 136.7))).toBe(false)
  })

  it('境界: ちょうど下限の距離では黙る（超えたぶんだけ言い直す）', () => {
    // 経度を固定して真北へ、ちょうど下限だけ離れた点を作る
    const deltaDeg = EEW_HYPOCENTER_RESTATE_KM / 111.19492664455873
    expect(isUnannouncedHypocenter([NOTO_LAND], hypo('別の場所', NOTO_LAND.lat + deltaDeg, NOTO_LAND.lng)))
      .toBe(false)
    expect(isUnannouncedHypocenter([NOTO_LAND], hypo('別の場所', NOTO_LAND.lat + deltaDeg * 1.01, NOTO_LAND.lng)))
      .toBe(true)
  })

  it('安全弁: まだ何も名乗っていなければ偽（初報を読むかは別の判定が決める）', () => {
    expect(isUnannouncedHypocenter([], hypo('石川県能登地方', 37.4, 136.9))).toBe(false)
  })

  it('安全弁: 位置不明のセンチネルへ落ちた続報では言い直さない', () => {
    expect(isUnannouncedHypocenter([NOTO_LAND], hypo('遠地地震', -200, -200))).toBe(false)
  })

  it('安全弁: 位置を持たない記録は距離の比較に参加しないが、地名の一致では黙らせる', () => {
    const unknownPos: AnnouncedHypocenter = { name: '震源不明', lat: null, lng: null }
    // 地名が違えば、位置を持たない記録は言い直しを止めない
    expect(isUnannouncedHypocenter([unknownPos], hypo('石川県能登地方', 37.4, 136.9))).toBe(true)
    // 同じ地名なら黙る
    expect(isUnannouncedHypocenter([unknownPos], hypo('震源不明', 37.4, 136.9))).toBe(false)
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

  // 震度側と同じ理由で `condition` では捨てない（`eewMaxScaleInfo` のコメント参照）。
  // 実データ（2024 能登 1/1〜1/3）では仮定震源要素 72 報のすべてが長周期階級を持たなかったので、
  // 捨てる分岐は元から効いていなかった——ここで固定するのは「値が来たら素直に採る」ことだけ。
  it('仮定震源要素でも areas が空なら電文全体の forecastMaxLpgmClass を採る', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '仮定震源要素',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
      },
      forecastMaxLpgmClass: 4,
    })
    expect(eewMaxLpgmClass(eew)).toBe(4)
  })

  // 対照: 値を持たない報は 0 のまま。
  it('仮定震源要素で forecastMaxLpgmClass を持たない報は 0 のまま', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '仮定震源要素',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 1.0 },
      },
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
    //
    // 2026-08-30: 478 → 478.6。震源距離を平らな直角三角形（√(地表距離² + 深さ²)）から
    // 球の弦へ直したぶん（utils/geo.ts の hypocentralDistanceKm）。同じ地表距離なら震源距離が
    // わずかに短くなり、その分だけ有感半径が伸びる。
    expect(calcFeltRadiusKm(6.0, 10)).toBeCloseTo(478.6, 1)
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

  // ---- 時刻が読めなかったとき ----
  //
  // 読めない時刻から作った `Date` は Invalid で、**それを含む大小比較はどちらの向きでも偽**。
  // 素朴に書くと非対称になり、震源時刻が読めないときは発表時刻基準の値が返るのに、
  // 発表時刻が読めないときだけ Invalid が返っていた（下限を採る側が `else` に当たるため）。
  //
  // Invalid Date が返ると、下流は**気づかないまま挙動が変わる** ——
  // `hooks/useEarthquakes.ts` は自動解除の予約をキューに捨てられ（EEW が画面に居座る）、
  // `services/dmdataReplay.ts` は失効の判定が常に偽へ倒れる（失効済みの EEW を復元する）。

  // 正: 発表時刻が読めなくても、震源時刻が読めれば解除時刻は決まる。
  it('発表時刻が読めなくても震源時刻から解除時刻を決める', () => {
    const originTime = '2026-01-01T12:00:00Z'
    const eew = makeEEWFor(5.0, 10, originTime)
    const cancel = calcEEWCancelTime(eew, new Date(''))
    const originBase = new Date(new Date(originTime).getTime() + calcEEWAutoCancelSec(5.0, 10) * 1000)
    expect(cancel.getTime()).toBe(originBase.getTime())
  })

  // 対照: 逆向き（震源時刻が読めず発表時刻は読める）でも同じように決まる。**非対称にしない。**
  it('震源時刻が読めなくても発表時刻から解除時刻を決める', () => {
    const reportTime = new Date('2026-01-01T12:05:00Z')
    const eew = makeEEWFor(5.0, 10, '')
    const cancel = calcEEWCancelTime(eew, reportTime)
    expect(cancel.getTime()).toBe(reportTime.getTime() + 60 * 1000)
  })

  // 安全弁: 両方読めなければ Invalid Date のまま返す。**代わりの値を作らない** ——
  // 作ると呼び出し側は「時刻を決められなかった」ことに気づけず、記録も残せない。
  it('発表時刻も震源時刻も読めなければ Invalid Date を返す', () => {
    const eew = makeEEWFor(5.0, 10, '')
    expect(Number.isNaN(calcEEWCancelTime(eew, new Date('')).getTime())).toBe(true)
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

// 予想震度が出ない理由の判定。読み上げ文と「値の確定を待つかどうか」の両方が同じ判定を使う
// （utils/ttsText.ts の noForecastText / hooks/useLiveEventHandler.ts の第 2 フェーズ）。
// 'unknown' だけは値が遅れて付く可能性が残る＝待つ意味がある、という切り分けが要点。
// 震度を伝えられない報で階級だけ出すと「予想震度なし」と階級の断言が同居する。気象庁の電文では
// 最大予測震度が必須要素・長周期地震動階級が任意なので、この組み合わせは電文として作れない。
// **この述語はカード表示・読み上げ・第 2 フェーズの言い直しの 3 経路で共有する**ため、ここで固定する。
describe('canPresentLpgmClass', () => {
  it('震度と階級が揃っていれば出す', () => {
    expect(canPresentLpgmClass(40, 3)).toBe(true)
  })

  // 対照: 震度が無ければ階級も出さない（これが今回入れたガード）。
  it('震度が取れないときは階級を出さない', () => {
    expect(canPresentLpgmClass(0, 3)).toBe(false)
  })

  // 安全弁: 階級側の 0 を通してしまうと「予想最大階級0。」を作る。震度の有無とは別に弾く。
  it('階級が 0 なら震度があっても出さない', () => {
    expect(canPresentLpgmClass(40, 0)).toBe(false)
  })
})

describe('eewNoForecastReason', () => {
  it('仮定震源要素なら assumed', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '仮定震源要素',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
      },
    })
    expect(eewNoForecastReason(eew)).toBe('assumed')
  })

  it('深さが 150km を超えれば deep', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '以上',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 151, magnitude: 6.0 },
      },
    })
    expect(eewNoForecastReason(eew)).toBe('deep')
  })

  it('深さ 150km ちょうどは deep にしない（境界は含めない）', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '以上',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 150, magnitude: 6.0 },
      },
    })
    expect(eewNoForecastReason(eew)).toBe('unknown')
  })

  // 仮定震源要素の判定を先に置いている。単独点処理で深い震源が仮定されることがあり、
  // そのとき読み上げるべき理由は「単独点処理のため」（震源そのものが未確定）。
  it('仮定震源要素かつ深発なら assumed を優先する', () => {
    const eew = makeEEW({
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '仮定震源要素',
        hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 400, magnitude: 6.0 },
      },
    })
    expect(eewNoForecastReason(eew)).toBe('assumed')
  })

  it('浅い通常の震源なら unknown（値が遅れて付く可能性が残る）', () => {
    expect(eewNoForecastReason(makeEEW())).toBe('unknown')
  })
})

// 2024/01/01 能登本震の第13報（6強→7、1段階の変化）が、直前の確定値からの跳躍幅が
// 1段階しかないために短い猶予（旧仕様: small=300ms）しか与えられず、608ms後に届いた
// 6強への訂正報を待てずに、0.6秒しか存在しなかった震度7がそのまま確定・読み上げられて
// しまった（docs/spec/audio-tts-spec.md §6 参照）。EEW_PHASE2_SCALE_JUMP_STEP_THRESHOLD を
// 2→1 に下げ、1段階以上の変化は常に large（2000ms）待つようにして再発を防ぐ。
describe('eewPhase2ScaleStabilityMs: 震度の跳躍幅から安定待ち時間を決める', () => {
  // 正: 1段階の変化（能登本震13報の6強→7と同じ跳躍幅）でも large（2000ms）を待つ
  it('跳躍幅1段階の変化は large（2000ms）を待つ', () => {
    // 6強(60)→7(70) は SCALE_STEP_ORDER 上で1段階
    expect(eewPhase2ScaleStabilityMs(70, 60)).toBe(EEW_PHASE2_STABILITY_LARGE_MS)
  })

  // 対照: 値が変わっていない（0段階）場合は、閾値を下げても small（300ms）のまま
  it('値が変わっていない（0段階）場合は small（300ms）のまま', () => {
    expect(eewPhase2ScaleStabilityMs(55, 55)).toBe(EEW_PHASE2_STABILITY_SMALL_MS)
  })

  // 安全弁: 2段階以上の急な跳躍（旧仕様でも large だったもの）は、今回の変更後も
  // 引き続き large のまま——閾値を下げたことで緩んだわけではないことを確認する
  it('跳躍幅2段階以上の急な変化も引き続き large（2000ms）を待つ', () => {
    // 6弱(55)→7(70) は SCALE_STEP_ORDER 上で2段階
    expect(eewPhase2ScaleStabilityMs(70, 55)).toBe(EEW_PHASE2_STABILITY_LARGE_MS)
  })
})

// 震源要素の精度・最大予測値の変化の表示（電文解説資料 Ⅱ.21 1-4-2・2-1-4）。
// **語は資料の原文から採り、言い換えない。** 「IPF法（5点以上）」を「精度が高い」と要約すると、
// 資料と突き合わせられなくなるうえ、こちらが評価を足したことになる。
describe('震源要素の精度の表示', () => {
  it('ランクを資料の語で出す', () => {
    expect(eewEpicenterRankLabel(1)).toBe('P波／S波レベル超え、IPF法（1点）、または仮定震源要素')
    expect(eewEpicenterRankLabel(4)).toBe('IPF法（5点以上）')
    expect(eewMagnitudeRankLabel(4)).toBe('P相／全相混在')
    expect(eewMagnitudeRankLabel(8)).toBe('P波／S波レベル超え、または仮定震源要素')
  })

  // 正: **EPOS の括弧書きを落とさない。** 資料は「EPOS（海域〔観測網外〕）」
  // 「EPOS（内陸〔観測網内〕）」と書いており、この括弧が**観測網の外か内か**を言っている。
  // 「海域」「内陸」だけに縮めると、何と対比しているのか画面から読めなくなる。
  it('EPOS は観測網の内外まで出す', () => {
    expect(eewEpicenterRankLabel(7)).toBe('EPOS（海域〔観測網外〕）')
    expect(eewEpicenterRankLabel(8)).toBe('EPOS（内陸〔観測網内〕）')
  })

  // 安全弁: 括弧書きを戻したのは EPOS の 2 つだけ。**他のランクへ波及していないこと。**
  // 資料は 1〜4 に〔 〕を持たせておらず、足すとこちらが原文に無いものを書いたことになる。
  it('EPOS 以外のランクに〔 〕を足していない', () => {
    for (const rank of [1, 2, 3, 4, 5, 6]) {
      expect(eewEpicenterRankLabel(rank), `rank ${rank}`).not.toContain('〔')
    }
    expect(eewMagnitudeRankLabel(6)).toBe('EPOS')   // Ｍ側の EPOS には括弧書きが無い
  })

  // 対照: 0（不明）と未知の値では何も返さない。「不明」と書いても伝わらず、欄が埋まるだけ。
  it('不明・未知・未設定では何も返さない', () => {
    expect(eewEpicenterRankLabel(0)).toBe('')
    expect(eewEpicenterRankLabel(99)).toBe('')
    expect(eewEpicenterRankLabel(undefined)).toBe('')
    expect(eewMagnitudeRankLabel(0)).toBe('')
    expect(eewMagnitudeRankLabel(undefined)).toBe('')
  })

  // 正: 5 は「5点以上」。上限を「5点」と書くと、実際にはもっと多いかもしれないことが消える。
  it('観測点数の 5 は「5点以上」', () => {
    expect(eewMagnitudePointsLabel(3)).toBe('3点')
    expect(eewMagnitudePointsLabel(5)).toBe('5点以上')
    expect(eewMagnitudePointsLabel(0)).toBe('')
    expect(eewMagnitudePointsLabel(undefined)).toBe('')
  })

  // 正・対照: rank2 の 9 だけが「これ以降変化しない」。rank の 9 では立たない。
  it('震源が確定したかは rank2 の 9 だけで判定する', () => {
    expect(isEewHypocenterSettled(makeEEW({ accuracy: { epicenterRank2: 9 } }))).toBe(true)
    expect(isEewHypocenterSettled(makeEEW({ accuracy: { epicenterRank2: 4 } }))).toBe(false)
    expect(isEewHypocenterSettled(makeEEW({ accuracy: { epicenterRank: 9 } }))).toBe(false)
    expect(isEewHypocenterSettled(makeEEW())).toBe(false)
  })
})

describe('最大予測値の変化の一文', () => {
  it('上がった・下がったを理由つきで出す', () => {
    expect(eewForecastChangeText(makeEEW({ forecastChange: { maxInt: 1, reason: 2 } })))
      .toBe('予想が大きくなりました（震央の位置が変わったため）')
    expect(eewForecastChangeText(makeEEW({ forecastChange: { maxInt: 2, reason: 9 } })))
      .toBe('予想が小さくなりました（PLUM法による予測で変わったため）')
  })

  // 正: 長周期階級だけが動いた報でも出す（震度は据え置きでも予想は変わっている）。
  it('長周期階級だけの変化でも出す', () => {
    expect(eewForecastChangeText(makeEEW({ forecastChange: { maxInt: 0, maxLgInt: 1, reason: 1 } })))
      .toBe('予想が大きくなりました（マグニチュードが変わったため）')
  })

  // 安全弁: 震度は上がり階級は下がった報では「変わりました」に倒す。
  // **どちらか一方に決めると、立っていない側を無かったことにする。**
  it('上下が同時に立つ報は「変わりました」に倒す', () => {
    expect(eewForecastChangeText(makeEEW({ forecastChange: { maxInt: 1, maxLgInt: 2, reason: 3 } })))
      .toBe('予想が変わりました（マグニチュードと震央の位置が変わったため）')
  })

  // 正: 理由が読めなければ括弧を出さない。
  it('理由が無ければ括弧を出さない', () => {
    expect(eewForecastChangeText(makeEEW({ forecastChange: { maxInt: 1 } }))).toBe('予想が大きくなりました')
  })

  // 対照: 変化なし（0）と要素が無い報では何も出さない。
  it('変化なし・未設定では出さない', () => {
    expect(eewForecastChangeText(makeEEW({ forecastChange: { maxInt: 0, maxLgInt: 0, reason: 0 } }))).toBe('')
    expect(eewForecastChangeText(makeEEW())).toBe('')
  })
})


// 区域で主要動が既に到達したかの判定。**電文は同じ事実を 2 通りで伝えてくる** ——
// 区域の `Condition`（DMDATA だけが配信）と、種別コードの下 1 桁（両経路が持つ）。
// 片方だけを見ると standard 版（P2PQuake）で到達済みの区域が画面から黙って消える。
describe('isEewAreaArrived', () => {
  const area = (o: Partial<EEWRegion>): EEWRegion => ({
    pref: '', name: 'テスト区域', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: null, ...o,
  })

  // 正: 電文の `Condition` を読めた経路（DMDATA）。
  it('Condition を読めていれば到達済み', () => {
    expect(isEewAreaArrived(area({ arrived: true }))).toBe(true)
  })

  // 正: **`Condition` が無くても種別コードで判る。** これが無いと standard 版で穴が残る。
  it('Condition が無くても種別コードが 01/11 なら到達済み', () => {
    expect(isEewAreaArrived(area({ kindCode: '01' }))).toBe(true)
    expect(isEewAreaArrived(area({ kindCode: '11' }))).toBe(true)
  })

  // 対照: 未到達を表すコード（00/10）では立たない。ここが立つと、まだ来ていない区域を
  // 「到達済み」と表示することになる。
  it('未到達のコードでは立たない', () => {
    expect(isEewAreaArrived(area({ kindCode: '00' }))).toBe(false)
    expect(isEewAreaArrived(area({ kindCode: '10' }))).toBe(false)
  })

  // 安全弁 1: PLUM 法（09/19）は到達済みではない。**時刻は持つが到達の予測ではない**ので、
  // ここへ混ぜると「時刻不明」と出すべき区域が「到達済み」に化ける。
  it('PLUM 法のコードでは立たない', () => {
    expect(isEewAreaArrived(area({ kindCode: '09', arrivalTime: '2026-01-01T12:00:00+09:00' }))).toBe(false)
    expect(isEewAreaArrived(area({ kindCode: '19', arrivalTime: '2026-01-01T12:00:00+09:00' }))).toBe(false)
  })

  // 安全弁 2: コード表に無い値・空のコードでは立たない（安全側は「まだ来ていない」）。
  it('コード表に無い値では立たない', () => {
    expect(isEewAreaArrived(area({ kindCode: '' }))).toBe(false)
    expect(isEewAreaArrived(area({ kindCode: '99' }))).toBe(false)
  })
})

describe('selectActiveEews（その時刻に発表中だった緊急地震速報を選ぶ）', () => {
  // 震源時刻 12:00:00・M6.0・深さ 10km なら自動解除は約 146 秒後（`calcEEWAutoCancelSec` の実測）。
  // 最終報の発表から最低 60 秒という下限もあるので、ここでは震源時刻起点のほうが後になる。
  const ORIGIN = '2026-01-01T12:00:00Z'
  const REPORT = '2026-01-01T12:00:10Z'
  const WITHIN = new Date('2026-01-01T12:01:00Z')   // 震源から 60 秒後（まだ有効）
  const AFTER = new Date('2026-01-01T12:05:00Z')    // 震源から 300 秒後（解除済み）

  function report(overrides: Partial<EEWAlert> = {}): EEWAlert {
    return makeEEW({
      time: REPORT,
      earthquake: { ...makeEEW().earthquake, originTime: ORIGIN },
      issue: { eventId: 'ev1', serial: '3' },
      ...overrides,
    })
  }

  function wrap(...eews: EEWAlert[]) {
    return eews.map(eew => ({ eew, value: eew }))
  }

  it('正: 自動解除の時刻を過ぎていない最終報は残る', () => {
    const eew = report({ isFinal: true })
    expect(selectActiveEews(wrap(eew), WITHIN, 'test')).toEqual([eew])
  })

  it('対照: 自動解除の時刻を過ぎた最終報は落とす', () => {
    const eew = report({ isFinal: true })
    expect(selectActiveEews(wrap(eew), AFTER, 'test')).toEqual([])
  })

  it('安全弁: 取消電文があれば同じ地震の全報を落とす（最終報が未失効でも）', () => {
    const normal = report({ isFinal: true })
    const cancel = report({ cancelled: true, issue: { eventId: 'ev1', serial: '4' } })
    expect(selectActiveEews(wrap(normal, cancel), WITHIN, 'test')).toEqual([])
  })

  it('安全弁: 発表時刻も震源時刻も読めないときは有効として残す', () => {
    // Invalid Date との比較はどちらの向きでも偽になるため、書き分けないとこの分岐が
    // 黙って「常に有効」へ倒れる。倒す向きは意図どおりだが、記録が残ることが要点。
    const eew = report({
      isFinal: true,
      time: '壊れた値',
      earthquake: { ...makeEEW().earthquake, originTime: '壊れた値' },
    })
    expect(selectActiveEews(wrap(eew), AFTER, 'test')).toEqual([eew])
  })

  it('最終報がまだ出ていない地震は、最新の報をそのまま残す', () => {
    const first = report({ time: '2026-01-01T12:00:05Z', issue: { eventId: 'ev1', serial: '1' } })
    const second = report({ time: '2026-01-01T12:00:08Z', issue: { eventId: 'ev1', serial: '2' } })
    expect(selectActiveEews(wrap(first, second), WITHIN, 'test')).toEqual([second])
  })

  it('渡す順序が入れ替わっても最新の報を選ぶ（並べ替えは関数の中で行う）', () => {
    const first = report({ time: '2026-01-01T12:00:05Z', issue: { eventId: 'ev1', serial: '1' } })
    const second = report({ time: '2026-01-01T12:00:08Z', issue: { eventId: 'ev1', serial: '2' } })
    expect(selectActiveEews(wrap(second, first), WITHIN, 'test')).toEqual([second])
  })

  it('地震ごとに 1 件へ畳む', () => {
    const a1 = report({ issue: { eventId: 'evA', serial: '1' } })
    const a2 = report({ isFinal: true, issue: { eventId: 'evA', serial: '2' } })
    const b1 = report({ isFinal: true, issue: { eventId: 'evB', serial: '1' } })
    const got = selectActiveEews(wrap(a1, a2, b1), WITHIN, 'test')
    expect(got).toHaveLength(2)
    expect(got).toEqual(expect.arrayContaining([a2, b1]))
  })
})
