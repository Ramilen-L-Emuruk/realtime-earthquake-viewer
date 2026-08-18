// earthquakeToText / lpgmToText（読み上げ文生成）のテスト。
// 「〇時〇分」はローカルタイムゾーン依存のため、時刻の数値そのものではなく
// 「日から読む／時分だけ読む」という書式の違いを正規表現で検証する。
import { describe, it, expect } from 'vitest'
import { earthquakeToText, eewToText, lpgmToText } from './ttsText'
import { getStationCoordsCache } from './stationCoords'
import type { JMAQuake, JMALpgm, EarthquakePoint, IssueType, DomesticTsunami, IntensityScale, EEWAlert, LpgmClass } from '../types/earthquake'

const TTS_OPTS = { intensityLevels: 0, maxRegions: 0 }

function makeQuake(over: {
  type?: IssueType
  name?: string
  depth?: number
  magnitude?: number
  maxScale?: IntensityScale
  domesticTsunami?: DomesticTsunami
  forecastText?: string
} = {}): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20260717234900-1',
    time: '2026-07-17T23:52:00+09:00',
    issue: { source: '気象庁', time: '2026-07-17T23:52:00+09:00', type: over.type ?? '遠地地震', correct: 'なし' },
    earthquake: {
      time: '2026-07-17T23:49:00+09:00',
      hypocenter: {
        name: over.name ?? 'メキシコ、チアパス州沿岸',
        latitude: 14.4,
        longitude: -93.0,
        depth: over.depth ?? -1,
        magnitude: over.magnitude ?? 7.4,
      },
      maxScale: over.maxScale ?? -1,
      domesticTsunami: over.domesticTsunami ?? 'なし',
    },
    points: [],
    forecastText: over.forecastText,
  }
}

describe('earthquakeToText: 遠地地震', () => {
  it('「震源情報」ではなく「遠地地震に関する情報」と名乗る', () => {
    const text = earthquakeToText(makeQuake(), TTS_OPTS, true)
    expect(text.startsWith('遠地地震に関する情報。')).toBe(true)
    expect(text).not.toContain('震源情報')
  })

  it('続報では更新報として名乗る', () => {
    const text = earthquakeToText(makeQuake(), TTS_OPTS, false)
    expect(text.startsWith('遠地地震に関する情報が更新されました。')).toBe(true)
  })

  it('日付から読み上げる（発表が発生の数十分後になるため）', () => {
    const text = earthquakeToText(makeQuake(), TTS_OPTS, true)
    expect(text).toMatch(/情報。\d{1,2}日\d{1,2}時\d{1,2}分頃、/)
  })

  it('深さ不明（-1）では深さ句ごと省き「ごく浅い場所」と言わない', () => {
    const text = earthquakeToText(makeQuake({ depth: -1 }), TTS_OPTS, true)
    expect(text).toContain('メキシコ、チアパス州沿岸を震源とする')
    expect(text).not.toContain('ごく浅い場所')
    expect(text).not.toContain('深さ')
  })

  it('深さ 0 は「ごく浅い場所」と読む', () => {
    const text = earthquakeToText(makeQuake({ depth: 0 }), TTS_OPTS, true)
    expect(text).toContain('メキシコ、チアパス州沿岸、ごく浅い場所を震源とする')
  })

  it('深さが判明していれば深さを読む', () => {
    const text = earthquakeToText(makeQuake({ name: 'コロンビア', depth: 120, magnitude: 7.1 }), TTS_OPTS, true)
    expect(text).toContain('コロンビア、深さ120キロメートルを震源とするマグニチュード7.1の地震が発生しました。')
  })

  it('付加文の原文があればそれを読み、区分から起こした文は使わない', () => {
    const forecastText = '震源の近傍で津波発生の可能性があります。この地震による日本への津波の影響はありません。'
    const text = earthquakeToText(makeQuake({ forecastText }), TTS_OPTS, true)
    expect(text.endsWith(forecastText)).toBe(true)
    expect(text).not.toContain('この地震による津波の心配はありません。')
  })

  it('付加文が無い経路（P2PQuake）では津波区分から文を起こす', () => {
    const text = earthquakeToText(makeQuake({ forecastText: undefined }), TTS_OPTS, true)
    expect(text.endsWith('この地震による津波の心配はありません。')).toBe(true)
  })

  it('震源名が取れない電文では震源に触れず規模だけを伝える', () => {
    const text = earthquakeToText(makeQuake({ name: '' }), TTS_OPTS, true)
    expect(text).not.toContain('を震源とする')
    expect(text).toContain('マグニチュード7.4の地震が発生しました。')
    expect(text).not.toContain('、、')
  })

  it('規模不明（NaN・負値）ではマグニチュード句を省く', () => {
    for (const magnitude of [NaN, -1]) {
      const text = earthquakeToText(makeQuake({ magnitude }), TTS_OPTS, true)
      expect(text).toContain('を震源とする地震が発生しました。')
      expect(text).not.toContain('マグニチュード')
      expect(text).not.toContain('NaN')
    }
  })
})

describe('earthquakeToText: 震源情報（深さ不明の共通対応）', () => {
  it('深さ不明では深さ句を省く', () => {
    const text = earthquakeToText(makeQuake({ type: '震源情報', name: '日向灘', depth: -1, magnitude: 5.2 }), TTS_OPTS, true)
    expect(text).toContain('震源情報。')
    expect(text).toContain('日向灘を震源とするマグニチュード5.2の地震が発生しました。')
    expect(text).not.toContain('ごく浅い場所')
  })

  it('日付は読まず時分のみ読む（遠地地震との差）', () => {
    const text = earthquakeToText(makeQuake({ type: '震源情報', name: '日向灘', depth: 30 }), TTS_OPTS, true)
    expect(text).toMatch(/震源情報。\d{1,2}時\d{1,2}分頃、/)
    expect(text).not.toMatch(/情報。\d{1,2}日/)
  })
})

describe('earthquakeToText: 顕著な地震の震源要素更新のお知らせ', () => {
  const type: IssueType = '顕著な地震の震源要素更新のお知らせ'

  it('深さ不明では深さを読まず規模だけ伝える', () => {
    const text = earthquakeToText(makeQuake({ type, name: '石川県能登地方', depth: -1, magnitude: 7.6 }), TTS_OPTS, true)
    expect(text).toContain('マグニチュード7.6に更新されました。')
    expect(text).not.toContain('ごく浅く')
  })

  it('深さ・規模とも不明なら更新があった事実だけを伝える', () => {
    const text = earthquakeToText(makeQuake({ type, name: '石川県能登地方', depth: -1, magnitude: -1 }), TTS_OPTS, true)
    expect(text.endsWith('震源要素が更新されました。')).toBe(true)
  })

  it('深さ・規模が揃っていれば両方読む', () => {
    const text = earthquakeToText(makeQuake({ type, name: '石川県能登地方', depth: 16, magnitude: 7.6 }), TTS_OPTS, true)
    expect(text).toContain('震源の深さ16キロメートル、マグニチュード7.6に更新されました。')
  })
})

describe('eewToText: 長周期地震動階級の読み上げ', () => {
  function makeEEW(forecastMaxLpgmClass?: LpgmClass): EEWAlert {
    return {
      kind: 'eew',
      id: 'test-eew',
      time: '2026-01-01T12:00:00Z',
      test: false,
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: '以上',
        hypocenter: { name: '三陸沖', latitude: 38.1, longitude: 142.9, depth: 24, magnitude: 7.2 },
      },
      severity: 'Warning',
      cancelled: false,
      forecastMaxLpgmClass,
      issue: { eventId: 'e1', serial: '1', time: '2026-01-01T12:00:00Z' },
      areas: [],
    }
  }

  it('階級 1〜4 は読み上げる', () => {
    expect(eewToText(makeEEW(4))).toContain('予想最大階級4。')
  })

  it('階級が無ければ読み上げない', () => {
    expect(eewToText(makeEEW(undefined))).not.toContain('予想最大階級')
  })

  // 読み上げは地図の色フォールバックのような逃げ場が無く、不正値がそのまま音声で出てしまう。
  it('範囲外の階級は読み上げない（「予想最大階級99」を声に出さない）', () => {
    const text = eewToText(makeEEW(99 as unknown as LpgmClass))
    expect(text).not.toContain('予想最大階級')
    expect(text).not.toContain('99')
  })
})

// 助詞「で」は末尾（述語の直前）にだけ置く。階級ごとの句末に付けると一文字の「で」が
// 読点で挟まれ、読み上げがぶつ切りに聞こえるため（ttsText.ts の buildRegionText 参照）。
// 観測点座標（station-coords.json）は未読み込みのため、区域名は県単位にまとめられず
// points の addr がそのまま列挙される。
describe('earthquakeToText: 震度階級ごとの地域列挙', () => {
  const points: EarthquakePoint[] = [
    { pref: '宮城県', addr: '宮城県北部', isArea: true, scale: 40 as IntensityScale },
    { pref: '福島県', addr: '福島県中通り', isArea: true, scale: 40 as IntensityScale },
    { pref: '岩手県', addr: '岩手県内陸南部', isArea: true, scale: 30 as IntensityScale },
  ]

  // 震源座標を 0 にして震源距離での並べ替えを通さず、列挙順を points の順に固定する
  // （並べ替えの検証はこのテストの対象ではない）。
  function makeScaleQuake(): JMAQuake {
    const base = makeQuake({ type: '震度速報', maxScale: 40 as IntensityScale })
    return {
      ...base,
      earthquake: {
        ...base.earthquake,
        hypocenter: { ...base.earthquake.hypocenter, name: '宮城県沖', latitude: 0, longitude: 0 },
      },
      points,
    }
  }

  it('複数階級を跨いでも「で」は末尾だけに置く', () => {
    // 区域名がそのまま並ぶ前提（県単位への集約が働かないこと）を明示する
    expect(getStationCoordsCache()).toBeNull()
    const text = earthquakeToText(makeScaleQuake(), { intensityLevels: 1, maxRegions: 0 }, true)
    expect(text).toBe('震度速報。最大震度4を宮城県北部、福島県中通り、震度3を岩手県内陸南部で観測しました。')
    expect(text).not.toContain('で、')
  })

  it('最大震度のみ読み上げる設定では文が変わらない', () => {
    const text = earthquakeToText(makeScaleQuake(), { intensityLevels: 0, maxRegions: 0 }, true)
    expect(text).toBe('震度速報。最大震度4を宮城県北部、福島県中通りで観測しました。')
  })

  it('地域数を絞って「ほか N 地域」が付く場合も末尾だけに置く', () => {
    const text = earthquakeToText(makeScaleQuake(), { intensityLevels: 1, maxRegions: 1 }, true)
    expect(text).toBe('震度速報。最大震度4を宮城県北部、ほか1地域、震度3を岩手県内陸南部で観測しました。')
    expect(text).not.toContain('で、')
  })

  it('観測点が無ければ地域を列挙せず最大震度だけ伝える', () => {
    const text = earthquakeToText(makeQuake({ type: '震度速報', maxScale: 40 as IntensityScale }), { intensityLevels: 1, maxRegions: 0 }, true)
    expect(text).toBe('震度速報。最大震度4を観測しました。')
  })
})

describe('lpgmToText: 階級ごとの地域列挙', () => {
  function makeLpgm(): JMALpgm {
    return {
      id: 'dmdata-lpgm-20260817230900-1',
      eventId: '20260817230900',
      time: '2026-08-17T23:12:00+09:00',
      originTime: '2026-08-17T23:09:00+09:00',
      maxClass: 3,
      cancelled: false,
      regions: [
        { code: '130', name: '東京都23区', maxLgInt: 3 },
        { code: '140', name: '神奈川県東部', maxLgInt: 2 },
      ],
    }
  }

  it('複数階級を跨いでも「で」は末尾だけに置く', () => {
    const text = lpgmToText(makeLpgm(), { intensityLevels: 1, maxRegions: 0 }, true)
    expect(text).toContain('長周期地震動階級3を東京都23区、階級2を神奈川県東部で観測しました。')
    expect(text).not.toContain('東京都23区で、')
  })

  it('最大階級のみ読み上げる設定では文が変わらない', () => {
    const text = lpgmToText(makeLpgm(), { intensityLevels: 0, maxRegions: 0 }, true)
    expect(text).toContain('長周期地震動階級3を東京都23区で観測しました。')
  })
})
