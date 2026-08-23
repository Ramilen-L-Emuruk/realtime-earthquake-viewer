// earthquakeToText / lpgmToText（読み上げ文生成）のテスト。
// 「〇時〇分」はローカルタイムゾーン依存のため、時刻の数値そのものではなく
// 「日から読む／時分だけ読む」という書式の違いを正規表現で検証する。
import { describe, it, expect } from 'vitest'
import { earthquakeToText, earthquakeToSegments, createQuakeSpokenState, applySpokenRefs, eewIntensityToText, lpgmToText, tsunamiToText, tsunamiArrivalToText, tsunamiObservationUpdateToText, type TtsRegionOptions, type QuakeSpokenState } from './ttsText'
import { joinSegments, type SpeechSegment } from './ttsFollow'
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

  // 上限が定まらない報（DMDATA の to='over' / P2PQuake の scaleTo=99）は下限側の階級を持つ。
  // 語を落とすと「震度4以上」を「震度4」と断定した放送になる。
  describe('eewIntensityToText: 「〜以上」の読み上げ', () => {
    it('上限が定まらない予想は「以上」を付けて読む', () => {
      const eew = makeEEW(undefined, {
        areas: [{ pref: '石川県', name: '石川県能登', scaleFrom: 40, scaleTo: 40, scaleToOrAbove: true, kindCode: '09', arrivalTime: null }],
      })
      expect(eewIntensityToText(eew)).toBe('予想最大震度4以上。')
    })

    it('上限が定まっている予想には付けない（境界の手前）', () => {
      const eew = makeEEW(undefined, {
        areas: [{ pref: '石川県', name: '石川県能登', scaleFrom: 40, scaleTo: 45, kindCode: '11', arrivalTime: null }],
      })
      expect(eewIntensityToText(eew)).toBe('予想最大震度5弱。')
    })

    it('「以上」でも「予想震度なし」の経路は変えない（仮定震源要素で areas が空のとき）', () => {
      const text = eewIntensityToText(makeEEW(undefined, { condition: '仮定震源要素' }))
      expect(text).toContain('予想震度なし。')
      expect(text).not.toContain('以上。')
    })
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

  // 安全弁: 到達確認も観測波高と同じ `omittedPointsSentence` で打ち切り件数を言う（地点数の
  // 言い方を共有している）。どちらか一方だけ文言が変わったらここで落ちる。
  // 述語への糊付けをやめて独立した一文にしたのは、観測波高側の述語が新規・更新で変わるため
  // （外した地点を「更新されました」に巻き込まない）
  it('到達確認も maxPoints で外した地点数を読み上げる', () => {
    const obs: TsunamiObservation[] = [
      { name: '佐渡市鷲崎', districtName: '佐渡' },
      { name: '小木', districtName: '佐渡' },
      { name: '柏崎', districtName: '新潟県上中下越' },
    ]
    expect(tsunamiArrivalToText(obs, 1)).toContain('ほか2地点でも到達を確認しています。')
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
    // 述語（「〜を観測しました」／「〜に更新されました」）に貼り付けず独立した一文にする
    expect(tsunamiObservationUpdateToText(obs, undefined, 1)).toContain('ほか2地点でも観測しています。')
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

// 観測情報の続報は「津波が新しい場所に届いた」と「既に届いた場所で波が高くなった」を言い分ける。
// 新旧の境界は**前に声にした波高があるかどうか**だけで、名前を聞いたことがあるかでは判定しない
// （→ docs/spec/audio-tts-spec.md §4「新規と更新を言い分ける」）。
describe('津波観測情報の読み上げ: 新規と更新の言い分け', () => {
  const OFUNATO: TsunamiObservation = { name: '大船渡', districtCode: '030', districtName: '岩手県', height: { value: 3.0, description: '3.0m' } }
  const MIYAKO: TsunamiObservation = { name: '宮古', districtCode: '030', districtName: '岩手県', height: { value: 1.2, description: '1.2m' } }

  // 正: 前に声にした波高が無い観測点は「新たに」を冠する
  it('前値の無い観測点は「新たに」を付けて読む', () => {
    const text = tsunamiObservationUpdateToText([MIYAKO], undefined, undefined, new Set<string>())
    expect(text).toContain('新たに岩手県、宮古で1.2メートルを観測しました。')
    expect(text).not.toContain('更新')
  })

  // 対照: 前値のある観測点は「更新されました」で、「新たに」を付けない
  it('前値のある観測点は「更新されました」と読む', () => {
    const text = tsunamiObservationUpdateToText([OFUNATO], undefined, undefined, new Set(['大船渡']))
    expect(text).toContain('岩手県、大船渡で3.0メートルに更新されました。')
    expect(text).not.toContain('新たに')
  })

  // 正: 両方が混ざったら 2 文に分け、後ろを「また、」で継ぐ。深刻な波高を含む群が先に来る
  it('深刻な波高を含む群を先に読み、後ろを「また、」で継ぐ', () => {
    const raisedIsWorse = tsunamiObservationUpdateToText([MIYAKO, OFUNATO], undefined, undefined, new Set(['大船渡']))
    expect(raisedIsWorse).toContain('津波観測情報。岩手県、大船渡で3.0メートルに更新されました。また、新たに岩手県、宮古で1.2メートルを観測しました。')

    const firstTimeIsWorse = tsunamiObservationUpdateToText([MIYAKO, OFUNATO], undefined, undefined, new Set(['宮古']))
    expect(firstTimeIsWorse).toContain('津波観測情報。新たに岩手県、大船渡で3.0メートルを観測しました。また、岩手県、宮古で1.2メートルに更新されました。')
  })

  // 対照: 群が 1 つしかできない電文では「また、」を出さない
  it('群が 1 つなら「また、」を出さない', () => {
    expect(tsunamiObservationUpdateToText([MIYAKO, OFUNATO], undefined, undefined, new Set<string>())).not.toContain('また、')
    expect(tsunamiObservationUpdateToText([MIYAKO, OFUNATO], undefined, undefined, new Set(['宮古', '大船渡']))).not.toContain('また、')
  })

  // 安全弁: 前値の記憶を渡さない経路（既定）は全件を初出として扱う。初報がこの形になる
  it('前値の記憶が無ければ全件を初出として読む', () => {
    const text = tsunamiObservationUpdateToText([MIYAKO, OFUNATO])
    expect(text).toContain('新たに岩手県、宮古で1.2メートル、大船渡で3.0メートルを観測しました。')
    expect(text).not.toContain('更新')
  })

  // 正: 読む順は渡された並び（呼び出し側がカードの並びで渡す）。深刻な順に読み直さない。
  // 読み直すとカード上を上下に往復する（→ docs/spec/tsunami-spec.md §9）
  it('読む順は渡された並びのまま（深刻な順に読み直さない）', () => {
    expect(tsunamiObservationUpdateToText([MIYAKO, OFUNATO])).toContain('宮古で1.2メートル、大船渡で3.0メートル')
    expect(tsunamiObservationUpdateToText([OFUNATO, MIYAKO])).toContain('大船渡で3.0メートル、宮古で1.2メートル')
  })

  // 安全弁: 並び順を入力に委ねても、**どれを読むかの選抜は深刻な順**のまま。
  // 上限に掛かるとき、渡された並びの先頭から切ってはいけない（「以上」の地点が落ちる）
  it('選抜は深刻な順のまま（並びの先頭から切らない）', () => {
    const overLimit: TsunamiObservation = { name: '釜石', districtCode: '030', districtName: '岩手県', height: { value: 1.5, description: '1.5m以上', over: true } }
    // 渡す並びでは宮古が先頭だが、深刻なのは「1.5m以上」の釜石
    const text = tsunamiObservationUpdateToText([MIYAKO, overLimit], undefined, 1)
    expect(text).toContain('釜石で1.5メートル以上')
    expect(text).not.toContain('宮古')
  })

  // 安全弁: 群に割っても件数上限は合計。群ごとに選抜し直すと上限が実質 2 倍になり、
  // 既読を記録する側（selectObservationUpdatesToSpeak）と読み上げた集合が食い違う
  it('群に割っても maxPoints は合計で数える', () => {
    const obs: TsunamiObservation[] = [
      OFUNATO,
      MIYAKO,
      { name: '釜石', districtCode: '030', districtName: '岩手県', height: { value: 2.8, description: '2.8m' } },
    ]
    // 上限 2 件。深刻な順は 大船渡(3.0) → 釜石(2.8) → 宮古(1.2) なので宮古が落ちる
    const text = tsunamiObservationUpdateToText(obs, undefined, 2, new Set(['釜石']))
    expect(text).toContain('新たに岩手県、大船渡で3.0メートルを観測しました。')
    expect(text).toContain('また、岩手県、釜石で2.8メートルに更新されました。')
    expect(text).not.toContain('宮古')
    expect(text).toContain('ほか1地点でも観測しています。')
  })
})

describe('earthquakeToSegments: 続報は差分だけ読む', () => {
  function area(pref: string, addr: string, scale: number): EarthquakePoint {
    return { pref, addr, isArea: true, scale: scale as IntensityScale }
  }

  // 震源座標を 0 にして震源距離での並べ替えを通さず、列挙順を points の順に固定する。
  function quakeOf(points: EarthquakePoint[], maxScale: number, over: Parameters<typeof makeQuake>[0] = {}): JMAQuake {
    const base = makeQuake({ type: '震度速報', maxScale: maxScale as IntensityScale, ...over })
    return {
      ...base,
      earthquake: {
        ...base.earthquake,
        hypocenter: { ...base.earthquake.hypocenter, name: over.name ?? '宮城県沖', latitude: 0, longitude: 0 },
      },
      points,
    }
  }

  const OPTS: TtsRegionOptions = { intensityLevels: 2, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0 }

  /**
   * 読み上げた内容を記録へ反映する。**規則は本番と同じものを使う**（`applySpokenRefs`）。
   * 書き写すと、実装だけ変えたときにテストが古い規則のまま緑で残る。
   */
  function markSpoken(state: QuakeSpokenState, segments: SpeechSegment[]): void {
    applySpokenRefs(state, segments.flatMap(seg => seg.refs))
  }

  it('正: 新しく現れた区域だけを読む', () => {
    const state = createQuakeSpokenState()
    const first = earthquakeToSegments(quakeOf([area('宮城県', '宮城県北部', 40)], 40), OPTS, true, state)
    expect(joinSegments(first)).toBe('震度速報。最大震度4を宮城県北部で観測しました。')
    markSpoken(state, first)

    const second = earthquakeToSegments(
      quakeOf([area('宮城県', '宮城県北部', 40), area('福島県', '福島県中通り', 30)], 40),
      OPTS, false, state,
    )
    expect(joinSegments(second)).toBe('震度速報が更新されました。新たに震度3を福島県中通りで観測しました。')
  })

  it('正: 上がった区域と初出の区域は群に分け、上がった分を先に「また、新たに」で繋ぐ', () => {
    const state = createQuakeSpokenState()
    // 初報: 石川県能登=5強、富山県東部=4
    markSpoken(state, earthquakeToSegments(
      quakeOf([area('石川県', '石川県能登', 50), area('富山県', '富山県東部', 40)], 50), OPTS, true, state))

    // 続報: 能登が 5強→6強（上がり）、富山県東部は据え置き、新潟県中越が初出で 4
    const second = earthquakeToSegments(quakeOf([
      area('石川県', '石川県能登', 60),
      area('富山県', '富山県東部', 40),
      area('新潟県', '新潟県中越', 40),
    ], 60), OPTS, false, state)
    expect(joinSegments(second)).toBe(
      '震度速報が更新されました。最大震度6強を石川県能登で観測しました。'
      + 'また、新たに震度4を新潟県中越で観測しました。',
    )
  })

  it('正: 同じ階級に上がりと初出が混ざっても、群が分かれて「新たに」が初出だけに掛かる', () => {
    const state = createQuakeSpokenState()
    // 初報: 栃木県北部=3
    markSpoken(state, earthquakeToSegments(
      quakeOf([area('栃木県', '栃木県北部', 30)], 30), OPTS, true, state))

    // 続報: 栃木県北部が 3→4（上がり）、山形県村山が初出で 4。**同じ震度4に両方が並ぶ**
    const second = earthquakeToSegments(quakeOf([
      area('栃木県', '栃木県北部', 40),
      area('山形県', '山形県村山', 40),
    ], 40), OPTS, false, state)
    const text = joinSegments(second)
    expect(text).toBe(
      '震度速報が更新されました。最大震度4を栃木県北部で観測しました。'
      + 'また、新たに震度4を山形県村山で観測しました。',
    )
    // 上がった区域が「新たに」の後ろへ回っていないこと（この誤りがこの群分けの動機）
    expect(text.indexOf('栃木県北部')).toBeLessThan(text.indexOf('また、新たに'))
  })

  it('対照: 初出だけの続報には「また、」が付かない', () => {
    const state = createQuakeSpokenState()
    markSpoken(state, earthquakeToSegments(quakeOf([area('宮城県', '宮城県北部', 40)], 40), OPTS, true, state))
    const second = earthquakeToSegments(
      quakeOf([area('宮城県', '宮城県北部', 40), area('福島県', '福島県中通り', 30)], 40), OPTS, false, state)
    const text = joinSegments(second)
    expect(text).toContain('新たに')
    expect(text).not.toContain('また、')
  })

  it('安全弁: 地域数の上限は群ごとに数える（「ほかN地域」が両群で出る）', () => {
    const state = createQuakeSpokenState()
    const upgradedNames = ['青森県津軽北部', '青森県津軽南部', '青森県三八上北']
    const freshNames = ['岩手県沿岸北部', '岩手県沿岸南部', '岩手県内陸北部']
    // 初報でこの 3 区域を震度3として伝える
    markSpoken(state, earthquakeToSegments(
      quakeOf(upgradedNames.map(n => area('青森県', n, 30)), 30), OPTS, true, state))

    // 続報: 青森の 3 区域が 3→4（上がり）、岩手の 3 区域が初出で 4。上限 1・許容超過 0
    const opts = { ...OPTS, maxRegions: 1, regionTolerance: 0 }
    const second = earthquakeToSegments(quakeOf([
      ...upgradedNames.map(n => area('青森県', n, 40)),
      ...freshNames.map(n => area('岩手県', n, 40)),
    ], 40), opts, false, state)
    const text = joinSegments(second)
    // 群ごとに 1 件 + 「ほか2地域」。合わせて上限の 2 倍まで伸びる
    expect((text.match(/ほか2地域/g) ?? []).length).toBe(2)
  })

  it('正: 震度が上がった区域は読み直す', () => {
    const state = createQuakeSpokenState()
    markSpoken(state, earthquakeToSegments(quakeOf([area('石川県', '石川県能登', 60)], 60), OPTS, true, state))
    const upgraded = earthquakeToSegments(quakeOf([area('石川県', '石川県能登', 70)], 70), OPTS, false, state)
    expect(joinSegments(upgraded)).toBe('震度速報が更新されました。最大震度7を石川県能登で観測しました。')
  })

  // 2026-08-22 に反転: 据え置きの続報でも**名乗りだけは読む**ようにした。黙ると「電文が来たのに
  // 何も起きなかった」ようにしか聞こえないため（内容が続かないことで変化なしが伝わる）。
  it('対照: 据え置きの続報は名乗りだけで終える（地域を挙げない）', () => {
    const state = createQuakeSpokenState()
    const points = [area('宮城県', '宮城県北部', 40)]
    markSpoken(state, earthquakeToSegments(quakeOf(points, 40), OPTS, true, state))
    expect(joinSegments(earthquakeToSegments(quakeOf(points, 40), OPTS, false, state)))
      .toBe('震度速報が更新されました。')
  })

  it('対照: 震度が下がった区域は読み直さない', () => {
    const state = createQuakeSpokenState()
    markSpoken(state, earthquakeToSegments(quakeOf([area('石川県', '石川県能登', 60)], 60), OPTS, true, state))
    // 訂正で震度が下がるケース。既に伝えた値より低いので地域は挙げない（名乗りだけで終わる）
    expect(joinSegments(earthquakeToSegments(quakeOf([area('石川県', '石川県能登', 50)], 50), OPTS, false, state)))
      .toBe('震度速報が更新されました。')
  })

  it('安全弁: 記録を渡さなければ全区域を読む（既存の全文経路が変わらない）', () => {
    const points = [area('宮城県', '宮城県北部', 40), area('福島県', '福島県中通り', 30)]
    expect(earthquakeToText(quakeOf(points, 40), OPTS, false))
      .toBe('震度速報が更新されました。最大震度4を宮城県北部、震度3を福島県中通りで観測しました。')
  })

  it('安全弁: まだ何も声にしていなければ、差分が空でも黙らない', () => {
    const state = createQuakeSpokenState()
    // 区域を持たない電文（異常系）。記録が空なので最大震度だけでも伝える
    const segments = earthquakeToSegments(quakeOf([], 40), OPTS, true, state)
    expect(joinSegments(segments)).toBe('震度速報。最大震度4を観測しました。')
  })

  it('安全弁: 「ほかN地域」に切られた区域には参照が付かない（既読にならない）', () => {
    const state = createQuakeSpokenState()
    const points = [area('宮城県', '宮城県北部', 40), area('福島県', '福島県中通り', 40)]
    const first = earthquakeToSegments(quakeOf(points, 40), { ...OPTS, maxRegions: 1 }, true, state)
    expect(joinSegments(first)).toBe('震度速報。最大震度4を宮城県北部、ほか1地域で観測しました。')
    markSpoken(state, first)
    expect(state.regions.has('福島県中通り')).toBe(false)
    // 切られた区域は次の報で読まれる
    const second = earthquakeToSegments(quakeOf(points, 40), { ...OPTS, maxRegions: 1 }, false, state)
    // 初出の群なので「新たに」が付き、「最大」は冠さない（初出の群には冠しない規則）
    expect(joinSegments(second)).toBe('震度速報が更新されました。新たに震度4を福島県中通りで観測しました。')
  })

  it('「最大」を冠せるのは最大震度に一致する階級だけ', () => {
    const state = createQuakeSpokenState()
    const points = [area('石川県', '石川県能登', 60), area('富山県', '富山県東部', 40)]
    markSpoken(state, earthquakeToSegments(quakeOf(points, 60), OPTS, true, state))
    // 最大震度の区域は据え置き。残る震度4の句に「最大」を付けてはいけない
    // （初出の群なので、そもそも「最大」は冠さない）
    const second = earthquakeToSegments(
      quakeOf([...points, area('新潟県', '新潟県中越', 40)], 60), OPTS, false, state,
    )
    expect(joinSegments(second)).toBe('震度速報が更新されました。新たに震度4を新潟県中越で観測しました。')
  })

  it('階数の打ち切りに差分を混ぜない（上位が据え置きでも下位が繰り上がらない）', () => {
    const state = createQuakeSpokenState()
    const points = [
      area('宮城県', '宮城県北部', 50),
      area('福島県', '福島県中通り', 40),
      area('岩手県', '岩手県内陸南部', 30),
    ]
    const opts = { ...OPTS, intensityLevels: 1 }
    markSpoken(state, earthquakeToSegments(quakeOf(points, 50), opts, true, state))
    // 震度3は初報でも読まれていない（階数 1 の外）。据え置きの続報でも繰り上げて読まない
    // （地域を挙げないので名乗りだけで終わる）
    expect(joinSegments(earthquakeToSegments(quakeOf(points, 50), opts, false, state)))
      .toBe('震度速報が更新されました。')
  })

  it('続報でマグニチュードが変われば、震度に変化が無くても読む', () => {
    const state = createQuakeSpokenState()
    const first = quakeOf([area('石川県', '石川県能登', 70)], 70, { type: '震源・震度情報', name: '石川県能登地方', depth: 10, magnitude: 7.4, domesticTsunami: '警報等' })
    markSpoken(state, earthquakeToSegments(first, OPTS, true, state))
    const second = quakeOf([area('石川県', '石川県能登', 70)], 70, { type: '震源・震度情報', name: '石川県能登地方', depth: 10, magnitude: 7.6, domesticTsunami: '警報等' })
    expect(joinSegments(earthquakeToSegments(second, OPTS, false, state)))
      .toBe('地震情報が更新されました。マグニチュードは7.6に更新されました。')
  })

  it('正: 初報で不明だった深さが確定したら、続報でも初報と同じ形で読む', () => {
    const state = createQuakeSpokenState()
    // 深さ不明（-1）の震源情報。深さの句は出ないので記録にも残らない
    const first = quakeOf([], -1, { type: '震源情報', name: '日向灘', depth: -1, magnitude: 5.2, domesticTsunami: 'なし' })
    markSpoken(state, earthquakeToSegments(first, OPTS, true, state))
    expect(state.facts.has('depth')).toBe(false)

    // 続報で深さが確定。「まだ声にしていない事実」があるので通しの文で言い直す
    const second = quakeOf([], -1, { type: '震源情報', name: '日向灘', depth: 30, magnitude: 5.2, domesticTsunami: 'なし' })
    const text = joinSegments(earthquakeToSegments(second, OPTS, false, state))
    expect(text).toContain('深さ30キロメートルを震源とする')
    expect(text).toContain('震源情報が更新されました。')
  })

  it('正: 声にならなかった事実は続報で言い直す（記録が空なら差分にしない）', () => {
    const state = createQuakeSpokenState()
    const first = quakeOf([area('石川県', '石川県能登', 40)], 40, { type: '震源・震度情報', name: '石川県能登地方', depth: 10, magnitude: 5.7, domesticTsunami: 'なし' })
    const segments = earthquakeToSegments(first, OPTS, true, state)
    // 区域だけが声になり、震源要素の断片は鳴らなかった（割り込み）状況を作る
    markSpoken(state, segments.filter(seg => seg.refs.some(r => r.kind === 'quakeRegion')))
    expect(state.regions.has('石川県能登')).toBe(true)
    expect(state.facts.size).toBe(0)

    const second = quakeOf([area('石川県', '石川県能登', 40)], 40, { type: '震源・震度情報', name: '石川県能登地方', depth: 10, magnitude: 5.7, domesticTsunami: 'なし' })
    const text = joinSegments(earthquakeToSegments(second, OPTS, false, state))
    expect(text).toContain('マグニチュード5.7')
    expect(text).toContain('津波の心配はありません')
  })

  it('安全弁: 震源名が空の電文でも差分に入れる（声にしようのない深さを待たない）', () => {
    const state = createQuakeSpokenState()
    // 震源名が取れない電文。深さは判っているが「〇〇、深さ10キロメートルを震源とする」の句ごと
    // 落ちるため、深さは声にならない＝記録される機会が無い
    const first = quakeOf([], -1, { type: '震源情報', name: '', depth: 10, magnitude: 5.2, domesticTsunami: 'なし' })
    const firstText = joinSegments(earthquakeToSegments(first, OPTS, true, state))
    expect(firstText).not.toContain('キロメートル')
    markSpoken(state, earthquakeToSegments(first, OPTS, true, state))
    expect(state.facts.has('depth')).toBe(false)

    // 値に変化が無い続報。記録できない深さを待って全文へ戻ってはいけない（名乗りだけで終わる）
    const second = quakeOf([], -1, { type: '震源情報', name: '', depth: 10, magnitude: 5.2, domesticTsunami: 'なし' })
    expect(joinSegments(earthquakeToSegments(second, OPTS, false, state)))
      .toBe('震源情報が更新されました。')
  })

  it('深さの更新文で「深さ」が重ならない', () => {
    const state = createQuakeSpokenState()
    const first = quakeOf([], -1, { type: '震源情報', name: '日向灘', depth: 30, magnitude: 5.2, domesticTsunami: 'なし' })
    markSpoken(state, earthquakeToSegments(first, OPTS, true, state))
    const second = quakeOf([], -1, { type: '震源情報', name: '日向灘', depth: 50, magnitude: 5.2, domesticTsunami: 'なし' })
    const text = joinSegments(earthquakeToSegments(second, OPTS, false, state))
    expect(text).toBe('震源情報が更新されました。震源の深さは50キロメートルに更新されました。')
    expect(text).not.toContain('深さは深さ')
  })

  it('震度速報を津波区分の変化とみなさない（震源情報の直後でも読み直さない）', () => {
    const state = createQuakeSpokenState()
    // 震源情報が「津波の心配はありません」を伝える
    const focus = quakeOf([], -1, { type: '震源情報', name: '石川県能登地方', depth: 10, magnitude: 5.7, domesticTsunami: 'なし' })
    markSpoken(state, earthquakeToSegments(focus, OPTS, true, state))
    expect(state.facts.get('domesticTsunami')).toBe('なし')
    // 続く震度速報の domesticTsunami は「調査中」だが、津波を伝える電文ではない
    const prompt = quakeOf([area('石川県', '石川県能登', 50)], 50, { domesticTsunami: '調査中' })
    const text = joinSegments(earthquakeToSegments(prompt, OPTS, false, state))
    expect(text).toBe('震度速報が更新されました。最大震度5強を石川県能登で観測しました。')
    expect(text).not.toContain('調査中')
  })
})

// 観測点から一次細分区域を逆引きするには座標テーブル（station-coords.json）が要る。読み込みが
// 済む前に地震が来ても地域名を黙って落とさず、都道府県名まで下げて読むことを確かめる。
// 逆引きが効いた場合の粒度は ttsRegionOrder.test.ts が実データで受け持つ。
describe('earthquakeToText: 座標テーブルが無いときの地域名', () => {
  /** 震源を国内に置いた震度電文。type と maxScale・points を差し替えて使う。 */
  function makeLocalQuake(
    type: IssueType,
    maxScale: IntensityScale,
    points: EarthquakePoint[],
  ): JMAQuake {
    const base = makeQuake({ type, name: '新潟県中越地方', maxScale })
    return {
      ...base,
      earthquake: {
        ...base.earthquake,
        hypocenter: { ...base.earthquake.hypocenter, latitude: 0, longitude: 0, depth: 10, magnitude: 5.0 },
      },
      points,
    }
  }

  it('観測点しか持たない電文では都道府県名で読む', () => {
    expect(getStationCoordsCache()).toBeNull()
    const quake = makeLocalQuake('各地の震度情報', 40 as IntensityScale, [
      { pref: '新潟県', addr: '糸魚川市一の宮', isArea: false, scale: 40 as IntensityScale },
      { pref: '新潟県', addr: '長岡市幸町', isArea: false, scale: 40 as IntensityScale },
    ])
    expect(earthquakeToText(quake, TTS_OPTS, true)).toContain('最大震度4を新潟県で観測しました。')
  })

  // DMDATA は観測点を pref: '' で積む（→ docs/spec/quake-spec.md §4）。座標テーブルが未読み込みだと
  // 都道府県も区域も引けず地域名が 1 件も作れない。震度に触れずに終わる読み上げにしない。
  it('地域名を 1 件も作れなくても最大震度は伝える', () => {
    expect(getStationCoordsCache()).toBeNull()
    const quake = makeLocalQuake('各地の震度情報', 40 as IntensityScale, [
      { pref: '', addr: '糸魚川市一の宮', isArea: false, scale: 40 as IntensityScale },
    ])
    expect(earthquakeToText(quake, TTS_OPTS, true)).toContain('最大震度4を観測しました。')
  })

  // 安全弁: 地域名が読めているときはフォールバックの一文を重ねない（`||` の短絡に依存している）。
  it('地域名が読めていれば最大震度だけの一文は足さない', () => {
    const quake = makeLocalQuake('各地の震度情報', 40 as IntensityScale, [
      { pref: '新潟県', addr: '糸魚川市一の宮', isArea: false, scale: 40 as IntensityScale },
    ])
    const text = earthquakeToText(quake, TTS_OPTS, true)
    expect(text).toContain('最大震度4を新潟県で観測しました。')
    expect(text).not.toContain('最大震度4を観測しました。')
  })

  // 対照: 震度が判っていないなら足すものが無い。震度の値が欠けた文にしない
  // （P2PQuake の maxScale は「無いのが正常」なケースがある。→ docs/spec/data-sources-spec.md §3）
  it('震度が判らない電文では言いかけの一文を足さない（地震情報）', () => {
    const quake = makeLocalQuake('各地の震度情報', -1 as IntensityScale, [
      { pref: '', addr: '糸魚川市一の宮', isArea: false, scale: -1 as IntensityScale },
    ])
    expect(earthquakeToText(quake, TTS_OPTS, true)).not.toContain('最大震度を観測しました')
  })

  it('震度が判らない電文では言いかけの一文を足さない（震度速報）', () => {
    const quake = makeLocalQuake('震度速報', -1 as IntensityScale, [
      { pref: '', addr: '糸魚川市一の宮', isArea: false, scale: -1 as IntensityScale },
    ])
    const text = earthquakeToText(quake, TTS_OPTS, true)
    expect(text).not.toContain('最大震度を観測しました')
    expect(text).toBe('震度速報。')
  })

  // 観測点が座標テーブルで解決できない状態は、その地震の続報でも続く。差分の経路に保険が
  // 無いと、初報の 1 回しか震度を伝えられない（震源要素だけで「何か伝えた」と見なされ、
  // 以降は区域も差分も空のまま黙る）。
  describe('続報でも地域名を作れないとき', () => {
    const unresolved = (scale: number): EarthquakePoint[] =>
      [{ pref: '', addr: '座標テーブルに無い観測点', isArea: false, scale: scale as IntensityScale }]

    /** 初報を読ませて既読状態を作る。 */
    function speakFirst(state: QuakeSpokenState, scale: number): string {
      const segs = earthquakeToSegments(
        makeLocalQuake('各地の震度情報', scale as IntensityScale, unresolved(scale)), TTS_OPTS, true, state)
      applySpokenRefs(state, segs.flatMap(s => s.refs))
      return joinSegments(segs)
    }

    it('正: 震度が上がれば続報でも伝える', () => {
      const state = createQuakeSpokenState()
      expect(speakFirst(state, 40)).toContain('最大震度4を観測しました。')

      // 45 = 震度5弱（50 は 5 強）。→ src/utils/intensity.ts
      const segs = earthquakeToSegments(
        makeLocalQuake('各地の震度情報', 45 as IntensityScale, unresolved(45)), TTS_OPTS, false, state)
      expect(joinSegments(segs)).toContain('最大震度5弱を観測しました。')
    })

    it('対照: 震度が同じなら続報では言い直さない（名乗りだけで終わる）', () => {
      const state = createQuakeSpokenState()
      speakFirst(state, 40)

      const segs = earthquakeToSegments(
        makeLocalQuake('各地の震度情報', 40 as IntensityScale, unresolved(40)), TTS_OPTS, false, state)
      expect(joinSegments(segs)).toBe('地震情報が更新されました。')
    })

    // 震度が下がった続報も伝える。区域側（isUnspokenRegion）は上がったときしか読み直さないが、
    // 地域名を引けない地震ではこれが震度を伝える唯一の経路なので、下方修正も落とさない。
    it('正: 震度が下がっても続報で伝える（区域側とは非対称）', () => {
      const state = createQuakeSpokenState()
      speakFirst(state, 40)

      const segs = earthquakeToSegments(
        makeLocalQuake('各地の震度情報', 30 as IntensityScale, unresolved(30)), TTS_OPTS, false, state)
      expect(joinSegments(segs)).toContain('最大震度3を観測しました。')
    })

    // 震度速報の分岐にも同じ条件を置いてある。地震情報側のテストでは通らない経路なので別に固定する。
    it('正・対照: 震度速報でも同じ扱いをする', () => {
      const state = createQuakeSpokenState()
      const first = earthquakeToSegments(
        makeLocalQuake('震度速報', 40 as IntensityScale, unresolved(40)), TTS_OPTS, true, state)
      applySpokenRefs(state, first.flatMap(s => s.refs))
      expect(joinSegments(first)).toBe('震度速報。最大震度4を観測しました。')

      const same = earthquakeToSegments(
        makeLocalQuake('震度速報', 40 as IntensityScale, unresolved(40)), TTS_OPTS, false, state)
      expect(joinSegments(same)).toBe('震度速報が更新されました。')

      const raised = earthquakeToSegments(
        makeLocalQuake('震度速報', 45 as IntensityScale, unresolved(45)), TTS_OPTS, false, state)
      expect(joinSegments(raised)).toBe('震度速報が更新されました。最大震度5弱を観測しました。')
    })

    it('安全弁: 地域名を読めた地震では代替を使わない（差分の経路を壊さない）', () => {
      const state = createQuakeSpokenState()
      // 区域の点を持つ電文なら座標テーブルが無くても地域名を作れる。
      const points: EarthquakePoint[] = [{ pref: '', addr: '宮城県北部', isArea: true, scale: 40 as IntensityScale }]
      const first = earthquakeToSegments(
        makeLocalQuake('各地の震度情報', 40 as IntensityScale, points), TTS_OPTS, true, state)
      applySpokenRefs(state, first.flatMap(s => s.refs))

      expect(joinSegments(first)).toContain('最大震度4を宮城県北部で観測しました。')
      // 代替は記録に残らない。残ると、後で地域名が作れなくなったときに「既に伝えた」と誤判定する。
      expect(state.facts.has('maxScaleOnly')).toBe(false)
      // 同じ内容の続報は差分が無いので名乗りだけで終わる（代替の一文も足さない）。
      const second = earthquakeToSegments(
        makeLocalQuake('各地の震度情報', 40 as IntensityScale, points), TTS_OPTS, false, state)
      expect(joinSegments(second)).toBe('地震情報が更新されました。')
    })
  })
})
