import { describe, it, expect } from 'vitest'
import type { ParsedEewHypocenter } from './historicalEewParser'
import {
  intensityTokenToScale,
  parseDegMin,
  parseHeadlineScale,
  parseTierLabel,
  parseTimeOnly,
  parseWarekiDateTime,
  prefFromRegionName,
  resolveHypocenterName,
  toHalfWidthDigits,
} from './historicalEewParser'

function hypo(name: string, latitude: number, longitude: number): ParsedEewHypocenter {
  return { originTimeIso: '2011-03-12T00:00:00.000Z', name, latitude, longitude, depthKm: 10, magnitude: 5, maxIntensityText: '4' }
}

describe('toHalfWidthDigits', () => {
  it('全角数字を半角へ変換する', () => {
    expect(toHalfWidthDigits('震度４程度')).toBe('震度4程度')
  })
})

describe('intensityTokenToScale', () => {
  it('1〜4,7は10倍する', () => {
    expect(intensityTokenToScale('4', undefined)).toBe(40)
    expect(intensityTokenToScale('7', undefined)).toBe(70)
  })
  it('5弱=45 5強=50 6弱=55 6強=60', () => {
    expect(intensityTokenToScale('5', '弱')).toBe(45)
    expect(intensityTokenToScale('5', '強')).toBe(50)
    expect(intensityTokenToScale('6', '弱')).toBe(55)
    expect(intensityTokenToScale('6', '強')).toBe(60)
  })
})

describe('parseTierLabel', () => {
  it('単一震度（震度４程度）は scaleFrom=scaleTo になる', () => {
    expect(parseTierLabel('震度４程度')).toEqual([40, 40])
  })
  it('範囲（震度４から５弱程度）は [下限,上限] になる', () => {
    expect(parseTierLabel('震度４から５弱程度')).toEqual([40, 45])
  })
  it('5弱〜6弱のような弱/強混在も解析できる', () => {
    expect(parseTierLabel('震度５弱から６弱程度')).toEqual([45, 55])
  })
  it('解析できないラベルは例外を投げる（無音で握りつぶさない）', () => {
    expect(() => parseTierLabel('該当なし')).toThrow()
  })
})

describe('parseHeadlineScale', () => {
  it('「最大震度１程度以上」から震度値を取り出す', () => {
    expect(parseHeadlineScale('最大震度１程度以上')).toBe(10)
  })
  it('弱/強付きの見出しも解析できる', () => {
    expect(parseHeadlineScale('最大震度５強程度以上')).toBe(50)
  })
})

describe('parseWarekiDateTime', () => {
  it('平成年をJSTからUTCへ変換する', () => {
    // 平成23年 = 1988+23 = 2011年。14:46:18.1 JST → 05:46:18.1 UTC
    expect(parseWarekiDateTime('平成23年03月11日14時46分18.1秒')).toBe('2011-03-11T05:46:18.100Z')
  })
})

describe('parseTimeOnly', () => {
  it('同日内の時刻をJSTからUTCへ変換する', () => {
    const ref = '2011-03-11T05:46:18.100Z' // 14:46:18.1 JST
    expect(parseTimeOnly('14時46分45.6秒', ref)).toBe('2011-03-11T05:46:45.600Z')
  })
  it('日付をまたぐ場合（23時台の検知→翌0時台の報）も正しい日付になる', () => {
    const ref = '2011-03-12T14:35:05.700Z' // 23:35:05.7 JST 3/12
    // 3/13 00:00頃JSTの報（=前日からほぼ25分後）
    const result = parseTimeOnly('00時00分05.0秒', ref)
    expect(result).toBe('2011-03-12T15:00:05.000Z') // 3/13 00:00:05 JST
  })
})

describe('parseDegMin', () => {
  it('度分表記を10進度へ変換する', () => {
    expect(parseDegMin('38°06.2′')).toBeCloseTo(38.10333, 4)
  })
})

describe('prefFromRegionName', () => {
  it('通常の都道府県名+地域名から都道府県だけを取り出す', () => {
    expect(prefFromRegionName('岩手県沿岸南部')).toBe('岩手県')
    expect(prefFromRegionName('東京都２３区')).toBe('東京都')
    expect(prefFromRegionName('北海道太平洋沿岸東部')).toBe('北海道')
  })
})

describe('resolveHypocenterName', () => {
  it('候補が1件のみなら、それをそのまま使う', () => {
    const candidates = [hypo('福島県沖', 37.3, 141.2)]
    expect(resolveHypocenterName({ latitude: 999, longitude: 999 }, candidates)).toBe('福島県沖')
  })

  it('対照（バグ回帰）: 1ページに複数の地震が束ねられている場合、1行目を無条件採用しない', () => {
    // 実例（2011/3/12 23:35頃、dir 20110312233505）: 1行目は「茨城県沖」だが、
    // 実際の報の座標は一貫して「長野県北部」寄り。1行目を無条件採用すると、
    // 地図上の震源位置と地震名の表示が食い違う誤情報になる。
    const candidates = [hypo('茨城県沖', 35.9, 141.8), hypo('長野県北部', 37.0, 138.6)]
    expect(resolveHypocenterName({ latitude: 37.0, longitude: 138.6 }, candidates)).toBe('長野県北部')
  })

  it('正: 報の座標が1行目の震源に近ければ1行目の名前を使う', () => {
    const candidates = [hypo('福島県沖', 37.3, 141.2), hypo('新潟県中越地方', 37.0, 138.6)]
    expect(resolveHypocenterName({ latitude: 37.3, longitude: 141.2 }, candidates)).toBe('福島県沖')
  })

  it('安全弁: 座標が欠けている報は1行目の名前へ倒す（例外にしない）', () => {
    const candidates = [hypo('福島県沖', 37.3, 141.2), hypo('新潟県中越地方', 37.0, 138.6)]
    expect(resolveHypocenterName({ latitude: null, longitude: null }, candidates)).toBe('福島県沖')
  })
})
