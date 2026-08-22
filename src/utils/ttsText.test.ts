// earthquakeToText / lpgmToText（読み上げ文生成）のテスト。
// 「〇時〇分」はローカルタイムゾーン依存のため、時刻の数値そのものではなく
// 「日から読む／時分だけ読む」という書式の違いを正規表現で検証する。
import { describe, it, expect } from 'vitest'
import { earthquakeToText, eewIntensityToText, lpgmToText, tsunamiToText, tsunamiArrivalToText, tsunamiObservationUpdateToText, type TtsRegionOptions } from './ttsText'
import { getStationCoordsCache } from './stationCoords'
import type { JMAQuake, JMALpgm, EarthquakePoint, IssueType, DomesticTsunami, IntensityScale, EEWAlert, LpgmClass, JMATsunami, TsunamiArea, TsunamiObservation } from '../types/earthquake'

const TTS_OPTS: TtsRegionOptions = { intensityLevels: 0, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0 }

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

describe('eewIntensityToText: 長周期地震動階級の読み上げ', () => {
  function makeEEW(
    forecastMaxLpgmClass?: LpgmClass,
    over: { condition?: EEWAlert['earthquake']['condition']; areas?: EEWAlert['areas']; depth?: number } = {},
  ): EEWAlert {
    return {
      kind: 'eew',
      id: 'test-eew',
      time: '2026-01-01T12:00:00Z',
      test: false,
      earthquake: {
        originTime: '2026-01-01T12:00:00Z',
        arrivalTime: '2026-01-01T12:00:20Z',
        condition: over.condition ?? '以上',
        hypocenter: { name: '三陸沖', latitude: 38.1, longitude: 142.9, depth: over.depth ?? 24, magnitude: 7.2 },
      },
      severity: 'Warning',
      cancelled: false,
      forecastMaxLpgmClass,
      issue: { eventId: 'e1', serial: '1', time: '2026-01-01T12:00:00Z' },
      areas: over.areas ?? [],
    }
  }

  it('階級 1〜4 は読み上げる', () => {
    expect(eewIntensityToText(makeEEW(4))).toContain('予想最大階級4。')
  })

  it('階級が無ければ読み上げない', () => {
    expect(eewIntensityToText(makeEEW(undefined))).not.toContain('予想最大階級')
  })

  // 読み上げは地図の色フォールバックのような逃げ場が無く、不正値がそのまま音声で出てしまう。
  it('範囲外の階級は読み上げない（「予想最大階級99」を声に出さない）', () => {
    const text = eewIntensityToText(makeEEW(99 as unknown as LpgmClass))
    expect(text).not.toContain('予想最大階級')
    expect(text).not.toContain('99')
  })

  // 以下 3 件は、読み上げが電文全体の forecastMaxLpgmClass を直読みしていた頃の回帰テスト。
  // 震度は eewMaxScale を通していたのに階級だけ生フィールドを見ており、集約関数が持つ
  // 「地域別優先」「仮定震源要素の除外」の 2 つのガードが読み上げにだけ効いていなかった。
  it('地域別 lgIntTo があれば電文全体の forecastMaxLpgmClass より地域別の最大を優先する', () => {
    const eew = makeEEW(1, {
      areas: [
        { pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: null, lgIntTo: 3 },
        { pref: '大分県', name: '大分県南部', scaleFrom: 30, scaleTo: 40, kindCode: '10', arrivalTime: null, lgIntTo: 2 },
      ],
    })
    expect(eewIntensityToText(eew)).toContain('予想最大階級3。')
  })

  // 震度側が「予想震度なし」と読む状況で階級だけ断言すると矛盾した発話になる。
  it('仮定震源要素では「予想震度なし」と読み、階級句を付けない', () => {
    const text = eewIntensityToText(makeEEW(3, { condition: '仮定震源要素' }))
    expect(text).toContain('単独点処理のため、予想震度なし。')
    expect(text).not.toContain('予想最大階級')
  })

  // 深発地震は震源が確定していても地域別予想が付かないことがある。理由の判定は
  // eewNoForecastReason に一本化してあり、ここではその文言への写し取りを見る。
  it('深発地震では理由を添えて「予想震度なし」と読む', () => {
    expect(eewIntensityToText(makeEEW(undefined, { depth: 400 })))
      .toContain('深発地震のため、予想震度なし。')
  })

  describe('eewIntensityToText: 格上げの前置き', () => {
    function areasWith(scaleTo: IntensityScale, lgIntTo?: LpgmClass): EEWAlert['areas'] {
      return [{ pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: 40, scaleTo, kindCode: '10', arrivalTime: null, lgIntTo }]
    }

    it('前置きしない指定では格上げを述べない', () => {
      const eew = makeEEW(undefined, { areas: areasWith(45) })
      expect(eewIntensityToText(eew, false)).toBe('予想最大震度5弱。')
    })

    it('前置きする指定では遷移の言い方を付ける', () => {
      const eew = makeEEW(undefined, { areas: areasWith(50) })
      expect(eewIntensityToText(eew, true)).toBe('緊急地震速報に切り替わりました。予想最大震度5強。')
    })

    // 気象庁は震度6弱以上（または長周期地震動階級4以上）を予想した緊急地震速報（警報）を
    // 特別警報に位置づけるが、発表時に「特別警報」の名称は用いない。音声でも使わない。
    it('特別警報の条件を満たしても「特別警報」とは読まない', () => {
      const eew = makeEEW(undefined, { areas: areasWith(55) })
      const text = eewIntensityToText(eew, true)
      expect(text).toBe('緊急地震速報に切り替わりました。予想最大震度6弱。')
      expect(text).not.toContain('特別警報')
    })

    it('引数を省略すると前置きなし（既定は付けない）', () => {
      const eew = makeEEW(undefined, { areas: areasWith(45) })
      expect(eewIntensityToText(eew)).toBe('予想最大震度5弱。')
    })

    it('前置きは予想震度が取れない場合にも付く', () => {
      const eew = makeEEW(undefined, { condition: '仮定震源要素' })
      expect(eewIntensityToText(eew, true)).toBe('緊急地震速報に切り替わりました。単独点処理のため、予想震度なし。')
    })

    it('階級句は前置きの後ろ・震度句の後に続く', () => {
      const eew = makeEEW(undefined, { areas: areasWith(55, 4) })
      expect(eewIntensityToText(eew, true)).toBe('緊急地震速報に切り替わりました。予想最大震度6弱。予想最大階級4。')
    })
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
    const text = earthquakeToText(makeScaleQuake(), { ...TTS_OPTS, intensityLevels: 1 }, true)
    expect(text).toBe('震度速報。最大震度4を宮城県北部、福島県中通り、震度3を岩手県内陸南部で観測しました。')
    expect(text).not.toContain('で、')
  })

  it('最大震度のみ読み上げる設定では文が変わらない', () => {
    const text = earthquakeToText(makeScaleQuake(), TTS_OPTS, true)
    expect(text).toBe('震度速報。最大震度4を宮城県北部、福島県中通りで観測しました。')
  })

  it('地域数を絞って「ほか N 地域」が付く場合も末尾だけに置く', () => {
    const text = earthquakeToText(makeScaleQuake(), { ...TTS_OPTS, intensityLevels: 1, maxRegions: 1 }, true)
    expect(text).toBe('震度速報。最大震度4を宮城県北部、ほか1地域、震度3を岩手県内陸南部で観測しました。')
    expect(text).not.toContain('で、')
  })

  it('観測点が無ければ地域を列挙せず最大震度だけ伝える', () => {
    const text = earthquakeToText(makeQuake({ type: '震度速報', maxScale: 40 as IntensityScale }), { ...TTS_OPTS, intensityLevels: 1 }, true)
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
    const text = lpgmToText(makeLpgm(), { ...TTS_OPTS, intensityLevels: 1 }, true)
    expect(text).toContain('長周期地震動階級3を東京都23区、階級2を神奈川県東部で観測しました。')
    expect(text).not.toContain('東京都23区で、')
  })

  it('最大階級のみ読み上げる設定では文が変わらない', () => {
    const text = lpgmToText(makeLpgm(), TTS_OPTS, true)
    expect(text).toContain('長周期地震動階級3を東京都23区で観測しました。')
  })
})

// 「必ず読み上げる震度」(alwaysReadScale) と「地域数の許容超過」(regionTolerance) の検証。
// 上と同様に観測点座標は未読み込みのため、区域名は県単位にまとめられず points の順に列挙される。
describe('earthquakeToText: 階数の下限震度と地域数の許容超過', () => {
  function area(pref: string, addr: string, scale: number): EarthquakePoint {
    return { pref, addr, isArea: true, scale: scale as IntensityScale }
  }

  // 震源座標を 0 にして震源距離での並べ替えを通さず、列挙順を points の順に固定する。
  function quakeOf(points: EarthquakePoint[], maxScale: number): JMAQuake {
    const base = makeQuake({ type: '震度速報', maxScale: maxScale as IntensityScale })
    return {
      ...base,
      earthquake: {
        ...base.earthquake,
        hypocenter: { ...base.earthquake.hypocenter, name: '宮城県沖', latitude: 0, longitude: 0 },
      },
      points,
    }
  }

  const laddered = [
    area('宮城県', '宮城県北部', 50),
    area('福島県', '福島県中通り', 40),
    area('岩手県', '岩手県内陸南部', 30),
    area('山形県', '山形県村山', 20),
  ]

  it('階数を超えても下限震度以上の階級は読み上げる', () => {
    const text = earthquakeToText(quakeOf(laddered, 50), { ...TTS_OPTS, intensityLevels: 0, alwaysReadScale: 30 }, true)
    expect(text).toBe('震度速報。最大震度5強を宮城県北部、震度4を福島県中通り、震度3を岩手県内陸南部で観測しました。')
  })

  it('下限震度を無効(-1)にすると階数どおりで打ち切る', () => {
    const text = earthquakeToText(quakeOf(laddered, 50), { ...TTS_OPTS, intensityLevels: 0, alwaysReadScale: -1 }, true)
    expect(text).toBe('震度速報。最大震度5強を宮城県北部で観測しました。')
  })

  it('下限震度未満の階級は階数を超えて読み上げない', () => {
    const text = earthquakeToText(quakeOf(laddered, 50), { ...TTS_OPTS, intensityLevels: 0, alwaysReadScale: 30 }, true)
    expect(text).not.toContain('山形県村山')
  })

  it('観測 0 地域の階級は読み上げ枠を空費しない', () => {
    // 最大 6弱 で 5強 が 0 地域。階数 1 なら「6弱 と 震度4」が読まれる
    // （震度スケール上の位置で数えていた頃は 5強 が枠を使い 震度4 に届かなかった）。
    const points = [area('宮城県', '宮城県北部', 55), area('福島県', '福島県中通り', 40)]
    const text = earthquakeToText(quakeOf(points, 55), { ...TTS_OPTS, intensityLevels: 1, alwaysReadScale: -1 }, true)
    expect(text).toBe('震度速報。最大震度6弱を宮城県北部、震度4を福島県中通りで観測しました。')
  })

  const four = [
    area('宮城県', '宮城県北部', 40),
    area('福島県', '福島県中通り', 40),
    area('岩手県', '岩手県内陸南部', 40),
    area('山形県', '山形県村山', 40),
  ]

  it('許容超過の範囲内なら上限を超えても全地域を読み上げる', () => {
    const text = earthquakeToText(quakeOf(four, 40), { ...TTS_OPTS, maxRegions: 3, regionTolerance: 1 }, true)
    expect(text).toBe('震度速報。最大震度4を宮城県北部、福島県中通り、岩手県内陸南部、山形県村山で観測しました。')
    expect(text).not.toContain('ほか')
  })

  it('許容超過を 0 にすると従来どおり上限で打ち切る', () => {
    const text = earthquakeToText(quakeOf(four, 40), { ...TTS_OPTS, maxRegions: 3, regionTolerance: 0 }, true)
    expect(text).toBe('震度速報。最大震度4を宮城県北部、福島県中通り、岩手県内陸南部、ほか1地域で観測しました。')
  })

  it('許容超過を上回る場合は上限ちょうどで切って残りを件数で伝える', () => {
    const five = [...four, area('秋田県', '秋田県沿岸南部', 40)]
    const text = earthquakeToText(quakeOf(five, 40), { ...TTS_OPTS, maxRegions: 3, regionTolerance: 1 }, true)
    expect(text).toBe('震度速報。最大震度4を宮城県北部、福島県中通り、岩手県内陸南部、ほか2地域で観測しました。')
  })
})

describe('lpgmToText: 地域数の許容超過', () => {
  function makeLpgm(): JMALpgm {
    return {
      id: 'dmdata-lpgm-20260817230900-1',
      eventId: '20260817230900',
      time: '2026-08-17T23:12:00+09:00',
      originTime: '2026-08-17T23:09:00+09:00',
      maxClass: 3,
      cancelled: false,
      regions: [
        { code: '130', name: '東京都23区', maxLgInt: 3 as LpgmClass },
        { code: '140', name: '神奈川県東部', maxLgInt: 3 as LpgmClass },
        { code: '110', name: '埼玉県南部', maxLgInt: 3 as LpgmClass },
      ],
    }
  }

  it('許容超過の範囲内なら上限を超えても全地域を読み上げる', () => {
    const text = lpgmToText(makeLpgm(), { ...TTS_OPTS, maxRegions: 2, regionTolerance: 1 }, true)
    expect(text).toContain('長周期地震動階級3を東京都23区、神奈川県東部、埼玉県南部で観測しました。')
    expect(text).not.toContain('ほか')
  })

  it('許容超過を 0 にすると従来どおり上限で打ち切る', () => {
    const text = lpgmToText(makeLpgm(), { ...TTS_OPTS, maxRegions: 2, regionTolerance: 0 }, true)
    expect(text).toContain('長周期地震動階級3を東京都23区、神奈川県東部、ほか1地域で観測しました。')
  })
})

// 津波の区域名・地点名は読点（、）で連結する。中黒（・）は VOICEVOX が音として鳴らさず、
// splitIntoChunks（voicevox.ts）のチャンク境界にもならないため、並べた区域名が一続きに
// 聞こえてしまう（例:「山形県新潟県上中下越」）。句区切り辞書のポーズは辞書に載っている
// 地名の直後にしか入らないので、区切りをそれに頼ることはできない。
describe('津波の読み上げ: 区域名・地点名の区切り', () => {
  function makeTsunami(areas: TsunamiArea[]): JMATsunami {
    const now = '2026-01-01T00:00:00Z'
    return {
      kind: 'tsunami',
      id: 'test-tsunami',
      time: now,
      cancelled: false,
      issue: { source: 'テスト', time: now, type: 'Focus' },
      areas,
    }
  }

  // 2024-01-01 能登半島地震で津波警報の対象になった区域構成を模したもの
  const notoAreas: TsunamiArea[] = [
    { grade: 'MajorWarning', immediate: true, name: '石川県能登', maxHeight: { description: '５ｍ', value: 5 } },
    { grade: 'Warning', immediate: true, name: '山形県', maxHeight: { description: '３ｍ', value: 3 } },
    { grade: 'Warning', immediate: true, name: '新潟県上中下越', maxHeight: { description: '３ｍ', value: 3 } },
    { grade: 'Watch', immediate: false, name: '北海道日本海沿岸南部', maxHeight: { description: '１ｍ', value: 1 } },
    { grade: 'Watch', immediate: false, name: '青森県日本海沿岸', maxHeight: { description: '１ｍ', value: 1 } },
  ]

  it('下位グレードの区域名を読点で区切る', () => {
    const text = tsunamiToText(makeTsunami(notoAreas))
    expect(text).toContain('山形県、新潟県上中下越で3メートル')
    expect(text).toContain('北海道日本海沿岸南部、青森県日本海沿岸で1メートル')
  })

  it('予想波高が同じ区域をまとめるときも読点で区切る', () => {
    const text = tsunamiToText(makeTsunami([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'MajorWarning', immediate: true, name: '宮城県', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'MajorWarning', immediate: true, name: '福島県', maxHeight: { description: '６ｍ', value: 6 } },
    ]))
    expect(text).toContain('岩手県、宮城県で10メートル以上、福島県で6メートルが予想されています。')
  })

  it('到達確認の地点名を読点で区切る', () => {
    const obs: TsunamiObservation[] = [
      { name: '佐渡市鷲崎', districtName: '佐渡' },
      { name: '小木', districtName: '佐渡' },
      { name: '柏崎', districtName: '新潟県上中下越' },
    ]
    const text = tsunamiArrivalToText(obs)
    expect(text).toContain('佐渡、佐渡市鷲崎、小木')
    expect(text).toContain('新潟県上中下越、柏崎')
  })

  // 安全弁: 到達確認も観測波高と同じ `omittedSuffix` で打ち切り件数を言う（文言を共有している）。
  // 実装を共有関数へ寄せたので、どちらか一方だけ文言が変わったらここで落ちる
  it('到達確認も maxPoints で外した地点数を読み上げる', () => {
    const obs: TsunamiObservation[] = [
      { name: '佐渡市鷲崎', districtName: '佐渡' },
      { name: '小木', districtName: '佐渡' },
      { name: '柏崎', districtName: '新潟県上中下越' },
    ]
    expect(tsunamiArrivalToText(obs, 1)).toContain('、ほか2地点で到達を確認しました。')
    expect(tsunamiArrivalToText(obs, 5)).not.toContain('ほか')
  })

  // 津波予報区名そのものに中黒を含むものが実データに 9 件ある（「伊勢・三河湾」「壱岐・対馬」など。
  // tsunami-zones.json 参照）。区域名の中の中黒は名前の一部なのでそのまま残し、
  // 区域名どうしを繋ぐ位置にだけ読点を使う。「中黒を一切含まない」を条件にはできない。
  it('区域名に含まれる中黒は残し、区域名どうしの連結にだけ読点を使う', () => {
    const text = tsunamiToText(makeTsunami([
      { grade: 'Warning', immediate: true, name: '伊勢・三河湾', maxHeight: { description: '３ｍ', value: 3 } },
      { grade: 'Warning', immediate: true, name: '愛知県外海', maxHeight: { description: '３ｍ', value: 3 } },
      { grade: 'Watch', immediate: false, name: '壱岐・対馬', maxHeight: { description: '１ｍ', value: 1 } },
      { grade: 'Watch', immediate: false, name: '有明・八代海', maxHeight: { description: '１ｍ', value: 1 } },
    ]))
    expect(text).toContain('伊勢・三河湾、愛知県外海で3メートルが予想されています。')
    expect(text).toContain('壱岐・対馬、有明・八代海で1メートル')
  })
})

// 読み上げの区域列挙はカードの表示順（sortAreasForCardDisplay）に揃える。
//
// 電文順（気象庁の地理順・北から南）のままにすると、観測が入り始めた続報でカードの並びと
// 乖離する。カードは同じ予想波高のグループ内を実測波高の降順に並べ替えるため、電文順で
// 後ろの区域に先に実測が入ると繰り上がる。読み上げがそれを追わないと、読み上げに追従する
// スクロールが 1 チャンクごとに上下へ往復する（docs/spec/audio-tts-spec.md §4）。
describe('津波の読み上げ: 区域の並び順はカードに揃える', () => {
  function makeTsunamiWithObs(areas: TsunamiArea[], observations: TsunamiObservation[]): JMATsunami {
    const now = '2026-01-01T00:00:00Z'
    return {
      kind: 'tsunami',
      id: 'test-tsunami-order',
      time: now,
      cancelled: false,
      issue: { source: 'テスト', time: now, type: 'Focus' },
      areas,
      observations,
    }
  }

  // 同じ予想波高（10m以上）で 1 グループになる 3 区域。電文順は岩手→宮城→福島
  const sameHeightAreas: TsunamiArea[] = [
    { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '１０ｍ以上', value: 10 } },
    { grade: 'MajorWarning', immediate: true, name: '宮城県', code: '040', maxHeight: { description: '１０ｍ以上', value: 10 } },
    { grade: 'MajorWarning', immediate: true, name: '福島県', code: '050', maxHeight: { description: '１０ｍ以上', value: 10 } },
  ]

  // 正: 電文順で 2 番目の区域に実測が入ったら、読み上げでも先頭に繰り上がる
  it('実測が入った区域を先に読む', () => {
    const text = tsunamiToText(makeTsunamiWithObs(sameHeightAreas, [
      { name: '石巻港', districtCode: '040', districtName: '宮城県', height: { value: 7.2, description: '7.2m' } },
    ]))
    expect(text).toContain('宮城県、岩手県、福島県で10メートル以上が予想されています。')
  })

  // 対照: 観測が無ければ電文順のまま（気象庁の地理順を崩さない）
  it('観測が無ければ電文順のまま読む', () => {
    const text = tsunamiToText(makeTsunamiWithObs(sameHeightAreas, []))
    expect(text).toContain('岩手県、宮城県、福島県で10メートル以上が予想されています。')
  })

  // 正: 実測が複数あれば波高の降順に読む
  it('実測が複数あれば波高の大きい区域から読む', () => {
    const text = tsunamiToText(makeTsunamiWithObs(sameHeightAreas, [
      { name: '小名浜', districtCode: '050', districtName: '福島県', height: { value: 3.1, description: '3.1m' } },
      { name: '石巻港', districtCode: '040', districtName: '宮城県', height: { value: 7.2, description: '7.2m' } },
    ]))
    expect(text).toContain('宮城県、福島県、岩手県で10メートル以上が予想されています。')
  })

  // 安全弁: 並べ替えは波高グループの中だけ。グループの順序（電文順）は動かさない
  it('予想波高が違う区域は繰り上がらない', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'MajorWarning', immediate: true, name: '宮城県', code: '040', maxHeight: { description: '６ｍ', value: 6 } },
    ], [
      { name: '石巻港', districtCode: '040', districtName: '宮城県', height: { value: 5.5, description: '5.5m' } },
    ]))
    expect(text).toContain('岩手県で10メートル以上、宮城県で6メートルが予想されています。')
  })

  // 安全弁: 予想最大波高の文はカードの波高見出しと同じ区切りで読む。
  //
  // 波高の文字列だけをキーにまとめると、間に別の波高の区域が挟まっていても飛び越えて 1 つの
  // 句にしてしまう。カードは位置ベースで見出しを分ける（`groupAreasByHeight` は連続一致のみ）
  // ため、そこで食い違うと追従スクロールが「いま読んでいる区域」の間にある行を跨いだ範囲を
  // 対象にし、読んでいる区域が画面外に残る。
  it('間に別の波高が挟まる区域は、まとめずに分けて読む', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '３ｍ', value: 3 } },
      { grade: 'MajorWarning', immediate: true, name: '宮城県', code: '040', maxHeight: { description: '６ｍ', value: 6 } },
      { grade: 'MajorWarning', immediate: true, name: '福島県', code: '050', maxHeight: { description: '３ｍ', value: 3 } },
    ], []))
    // 「岩手県、福島県で3メートル、宮城県で6メートル」とまとめない
    expect(text).toContain('岩手県で3メートル、宮城県で6メートル、福島県で3メートルが予想されています。')
  })

  // 対照: 隣り合う同じ波高はこれまでどおり 1 つの句にまとめる
  it('隣り合う同じ波高の区域はまとめて読む', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'MajorWarning', immediate: true, name: '宮城県', code: '040', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'MajorWarning', immediate: true, name: '福島県', code: '050', maxHeight: { description: '６ｍ', value: 6 } },
    ], []))
    expect(text).toContain('岩手県、宮城県で10メートル以上、福島県で6メートルが予想されています。')
  })

  // 正: 上位の警報と同時に出ている下位等級でも、その区域の波高を読む。
  // 読まないと、注意報の区域にいる人へ高さが伝わらない。
  it('下位等級の波高も読む', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', code: '060', maxHeight: { description: '３ｍ', value: 3 } },
      { grade: 'Watch', immediate: false, name: '北海道太平洋沿岸東部', code: '080', maxHeight: { description: '１ｍ', value: 1 } },
    ], []))
    expect(text).toContain('また、次の地域に津波警報が発表されています。青森県太平洋沿岸で3メートルが予想されています。')
    expect(text).toContain('また、次の地域に津波注意報が発表されています。北海道太平洋沿岸東部で1メートルが予想されています。')
  })

  // 安全弁: 区域名は読み上げ文に **1 回だけ** 出す。区域を挙げる文と波高の文に分けると、
  // 予報区が数十に及ぶ大規模警報で読み上げが倍近く伸び、優先度の低い電文の待ち上限
  // （HIGHER_PRIORITY_SPEECH_MAX_WAIT_MS）に達して津波の読み上げが途中で切られうる。
  // 追従スクロールの側も「同じ箇所を読み直さない」前提に立っており、2 周読む形に戻すなら
  // 一度出した箇所を追わない仕掛けを併せて戻す必要がある（`TsunamiTab` のコメント参照）。
  it('区域名を 2 回読まない', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', code: '060', maxHeight: { description: '３ｍ', value: 3 } },
    ], []))
    expect(text.match(/岩手県/g)?.length).toBe(1)
    expect(text.match(/青森県太平洋沿岸/g)?.length).toBe(1)
  })

  // 安全弁: 等級ごとに文を閉じる。等級をまたいで波高を 1 文にまとめると、カードは等級ごとに
  // 分かれているので読み上げの句がカードを跨ぎ、追従がその間の行を含んだ範囲を対象にする。
  it('等級をまたいで波高を 1 文にまとめない', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', code: '060', maxHeight: { description: '３ｍ', value: 3 } },
    ], []))
    expect(text).toContain('岩手県で10メートル以上が予想されています。')
    expect(text).not.toContain('岩手県で10メートル以上、青森県太平洋沿岸で3メートル')
  })

  // 正: 予想波高が付いていない区域も読み上げから落とさない。区域名を波高の文でだけ挙げる作りなので、
  // 補う文が無いと発表されている区域を黙って省くことになる（「巨大」「高い」は DMDATA 経路で
  // maxHeight ごと落ちるほか、警報が先に出て波高が後続報で付くこともある）。
  it('波高が付いていない区域は別の文で挙げる', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'MajorWarning', immediate: true, name: '宮城県', code: '040' },
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', code: '060', maxHeight: { description: '３ｍ', value: 3 } },
      { grade: 'Warning', immediate: true, name: '茨城県', code: '070' },
    ], []))
    expect(text).toContain('岩手県で10メートル以上が予想されています。宮城県にも大津波警報が発表されています。')
    expect(text).toContain('青森県太平洋沿岸で3メートルが予想されています。茨城県にも津波警報が発表されています。')
  })

  // 安全弁: 波高の判定は **`maxHeight` の有無ではなく `description` の中身**で行う
  // （`hasForecastHeight`）。電文の解析は値が取れれば `maxHeight` を作るので、値 0 で条件も
  // 無いときに `description` が空文字のオブジェクトが残る。オブジェクトの有無で判定すると、
  // カードは波高なしとして扱うのに読み上げは波高ありとして扱い、**どちらの文にも出ない**。
  it('波高の説明が空文字の区域も落とさない', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'MajorWarning', immediate: true, name: '宮城県', code: '040', maxHeight: { description: '', value: 0 } },
    ], []))
    expect(text).toContain('宮城県にも大津波警報が発表されています。')
    // 空文字を波高として読まないこと（「宮城県でが予想されています」にならない）
    expect(text).not.toMatch(/宮城県で[^0-9]*が予想/)
  })

  // 対照: 波高がどの区域にも無ければ、区域名を直接挙げる形に落とす
  // （「次の地域に」と言ったのに挙げる先が無い、という文にしない）
  it('波高がまったく無ければ区域名を直接挙げる', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', code: '060' },
      { grade: 'Watch', immediate: false, name: '北海道太平洋沿岸東部', code: '080' },
    ], []))
    expect(text).toContain('青森県太平洋沿岸に津波警報が発表されました。')
    expect(text).toContain('また、北海道太平洋沿岸東部に津波注意報が発表されています。')
    expect(text).not.toContain('次の地域に')
  })

  // 気象庁は規模が数値化できないとき「巨大」「高い」と表記する。そのまま並べると
  // 「岩手県で巨大が予想されています」と崩れるので語を補う（活用が違うので表記ごとに持つ）。
  it('数値で表せない波高は語を補って読む', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '巨大', value: undefined as unknown as number } },
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', code: '060', maxHeight: { description: '高い', value: undefined as unknown as number } },
    ], []))
    expect(text).toContain('岩手県で巨大な津波が予想されています。')
    expect(text).toContain('青森県太平洋沿岸で高い津波が予想されています。')
  })

  // 下位等級はそれぞれ「また、」で始める（文の切れ目が耳で分かるように）
  it('下位等級はどれも「また、」で始める', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', code: '060', maxHeight: { description: '３ｍ', value: 3 } },
      { grade: 'Watch', immediate: false, name: '北海道太平洋沿岸東部', code: '080', maxHeight: { description: '１ｍ', value: 1 } },
    ], []))
    expect(text.match(/また、/g)?.length).toBe(2)
  })

  // 波高の単位は全角・半角のどちらでも読み替える。経路によって表記が違い（XML 履歴は全角、
  // JSON は半角）、片方だけ変換すると素通りした側が「えむ」と読まれる。
  it('半角の m も全角の ｍ も「メートル」と読む', () => {
    const halfWidth = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '10m以上', value: 10 } },
    ], []))
    expect(halfWidth).toContain('岩手県で10メートル以上が予想されています。')

    const fullWidth = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '０．５ｍ', value: 0.5 } },
    ], []))
    expect(fullWidth).toContain('岩手県で0.5メートルが予想されています。')
  })

  // 安全弁: 数字の直後だけを置き換える。cm のように数字と m の間に別の英字が挟まる表記を壊さない
  it('数字に直接続かない m は読み替えない', () => {
    const text = tsunamiObservationUpdateToText(
      [{ name: '宮古', districtCode: '030', districtName: '岩手県', height: { value: 1.2, description: '1.2m' } }],
      '50cm程度の潮位変化を観測しています。',
    )
    expect(text).toContain('50cm程度の潮位変化を観測しています。')
  })

  it('観測点の波高も同じ規則で読む', () => {
    const text = tsunamiObservationUpdateToText([
      { name: '宮古', districtCode: '030', districtName: '岩手県', height: { value: 8.5, description: '8.5m以上', over: true } },
    ])
    expect(text).toContain('宮古で8.5メートル以上')
  })

  // 正: maxPoints で打ち切る選抜が「○m以上」を確定値の下に置かない（音は落ちたら気づけない）
  it('「以上」の観測点は maxPoints の打ち切りで落とさない', () => {
    const obs: TsunamiObservation[] = [
      { name: '大船渡', districtCode: '030', districtName: '岩手県', height: { value: 3.0, description: '3.0m' } },
      { name: '釜石', districtCode: '030', districtName: '岩手県', height: { value: 2.8, description: '2.8m' } },
      { name: '宮古', districtCode: '030', districtName: '岩手県', height: { value: 1.5, description: '1.5m以上', over: true } },
    ]
    const text = tsunamiObservationUpdateToText(obs, undefined, 1)
    expect(text).toContain('宮古で1.5メートル以上')
    expect(text).not.toContain('大船渡')
  })

  // 正: 上限で外した地点数を言う（黙って捨てない）。「以上」が複数あって上限を超える場面が本番
  it('maxPoints で外した地点数を読み上げる', () => {
    const obs: TsunamiObservation[] = [
      { name: '宮古', districtCode: '030', districtName: '岩手県', height: { value: 8.5, description: '8.5m以上', over: true } },
      { name: '釜石', districtCode: '030', districtName: '岩手県', height: { value: 5.0, description: '5.0m以上', over: true } },
      { name: '大船渡', districtCode: '030', districtName: '岩手県', height: { value: 3.0, description: '3.0m' } },
    ]
    expect(tsunamiObservationUpdateToText(obs, undefined, 1)).toContain('、ほか2地点を観測しました。')
  })

  // 対照: 上限に掛からなければ余計な句を足さない
  it('上限に掛からなければ地点数の句を足さない', () => {
    const obs: TsunamiObservation[] = [
      { name: '宮古', districtCode: '030', districtName: '岩手県', height: { value: 8.5, description: '8.5m以上', over: true } },
    ]
    expect(tsunamiObservationUpdateToText(obs, undefined, 5)).not.toContain('ほか')
  })

  // 対照: 「以上」が無ければ従来どおり値の大きい観測点が選ばれる
  it('「以上」が無ければ値の大きい観測点を選ぶ', () => {
    const obs: TsunamiObservation[] = [
      { name: '釜石', districtCode: '030', districtName: '岩手県', height: { value: 2.8, description: '2.8m' } },
      { name: '大船渡', districtCode: '030', districtName: '岩手県', height: { value: 3.0, description: '3.0m' } },
    ]
    const text = tsunamiObservationUpdateToText(obs, undefined, 1)
    expect(text).toContain('大船渡で3.0メートル')
    expect(text).not.toContain('釜石')
  })

  // 安全弁: 数字の直後だけを置き換える。headline は電文の文章なので、無条件に m を替えると
  // 文中の語を壊す。大文字の M を対象にしないのはマグニチュード（「M7.6」）と衝突するため。
  it('文章に含まれるマグニチュード表記は壊さない', () => {
    const text = tsunamiObservationUpdateToText(
      [{ name: '宮古', districtCode: '030', districtName: '岩手県', height: { value: 1.2, description: '1.2m' } }],
      'M7.6の地震による津波を観測しています。',
    )
    expect(text).toContain('M7.6の地震による津波を観測しています。')
    expect(text).toContain('宮古で1.2メートル')
  })

  // 安全弁: 下位等級の列挙にも同じ並び順が効く（別カードだが同じ規則で並ぶ）
  it('下位等級の区域列挙も実測の順に読む', () => {
    const text = tsunamiToText(makeTsunamiWithObs([
      { grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030', maxHeight: { description: '１０ｍ以上', value: 10 } },
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', code: '060', maxHeight: { description: '３ｍ', value: 3 } },
      { grade: 'Warning', immediate: true, name: '茨城県', code: '070', maxHeight: { description: '３ｍ', value: 3 } },
    ], [
      { name: '大洗', districtCode: '070', districtName: '茨城県', height: { value: 1.9, description: '1.9m' } },
    ]))
    expect(text).toContain('茨城県、青森県太平洋沿岸で3メートルが予想されています。')
  })
})
