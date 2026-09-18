// 「変化を伝えない津波の続報」の読み上げ（満潮時刻の報・最大波の観測時刻だけの更新）のテスト。
//
// これらの報は等級も観測波高も動かさないまま届くので、従来は読み上げ文が空になり、通知音だけが
// 鳴っていた（2024 年能登半島地震の 26 時間で、取消を除く津波電文 56 通のうち 7 通）。
import { describe, it, expect } from 'vitest'
import {
  tideReportChange, collectTideEntries, rememberTideEntries, tideStationKey, isTideReport,
  TIDE_REPORT_INFO_NAME, type SpokenTideEntry,
} from './tsunami'
import {
  tsunamiTideToSegments, tsunamiMaxHeightTimeToSegments, tsunamiObservationNoChangeSegments,
  selectMaxHeightTimeUpdatesToSpeak, MAX_HEIGHT_TIME_SPEAK_MAX_POINTS,
} from './ttsText'
import type { JMATsunami, TsunamiArea, TsunamiObservation, TsunamiStation } from '../types/earthquake'

const text = (segments: { text: string }[]) => segments.map(s => s.text).join('')

const area = (code: string, stations: TsunamiStation[]): TsunamiArea => ({
  grade: 'Watch', immediate: false, name: `予報区${code}`, code, stations,
})

const station = (name: string, highTide?: string, arrival?: string): TsunamiStation => ({
  name, code: `s-${name}`, highTideDateTime: highTide, arrivalCondition: arrival,
})

const obs = (name: string, value: number, maxHeightDateTime?: string): TsunamiObservation => ({
  name, districtCode: '210', districtName: '岩手県',
  height: { value, description: `${value}m` },
  maxHeightDateTime,
})

// ============================================================
// tideReportChange —— 満潮時刻の報が何を動かしたか
// ============================================================

describe('tideReportChange', () => {
  const areas = [area('210', [
    station('宮古', '2024-01-02T05:00:00+09:00', '津波到達中と推測'),
    station('釜石', '2024-01-02T05:10:00+09:00', '津波到達中と推測'),
  ])]

  it('まだ一度も声にしていなければ first（名乗りだけで意味が通る）', () => {
    expect(tideReportChange(areas, new Map())).toBe('first')
  })

  // 正: 満潮時刻が進んだら tide
  it('満潮時刻が動いた地点があれば tide', () => {
    const spoken = collectTideEntries(areas)
    const next = [area('210', [
      station('宮古', '2024-01-02T17:20:00+09:00', '津波到達中と推測'),
      station('釜石', '2024-01-02T05:10:00+09:00', '津波到達中と推測'),
    ])]
    expect(tideReportChange(next, spoken)).toBe('tide')
  })

  // 対照: 到達状況だけでは tide にしない（実配信の 6 通中 2 通がこの形）
  it('到達状況だけが動いたら arrival', () => {
    const spoken = collectTideEntries(areas)
    const next = [area('210', [
      station('宮古', '2024-01-02T05:00:00+09:00', '第１波の到達を確認'),
      station('釜石', '2024-01-02T05:10:00+09:00', '津波到達中と推測'),
    ])]
    expect(tideReportChange(next, spoken)).toBe('arrival')
  })

  // 対照: 同じ中身の再送では何も言わない
  it('どちらも動いていなければ none', () => {
    const spoken = collectTideEntries(areas)
    expect(tideReportChange(areas, spoken)).toBe('none')
  })

  // 安全弁: 初出の地点を「到達状況が変わっただけ」に落とさない
  it('記録に無い地点があれば tide（その地点の満潮時刻をまだ伝えていないため）', () => {
    const spoken = collectTideEntries(areas)
    const next = [area('210', [
      ...areas[0].stations!,
      station('大船渡', '2024-01-02T05:20:00+09:00', '津波到達中と推測'),
    ])]
    expect(tideReportChange(next, spoken)).toBe('tide')
  })

  // 安全弁: 到達状況の変化が満潮時刻の変化を隠さない
  it('満潮時刻と到達状況が同時に動いたら tide を優先する', () => {
    const spoken = collectTideEntries(areas)
    const next = [area('210', [
      station('宮古', '2024-01-02T17:20:00+09:00', '第１波の到達を確認'),
      station('釜石', '2024-01-02T05:10:00+09:00', '津波到達中と推測'),
    ])]
    expect(tideReportChange(next, spoken)).toBe('tide')
  })

  // 安全弁: 区域をまたいで同じ地点コードが現れても取り違えない
  it('地点のキーには区域コードを含める', () => {
    const a = area('210', [station('宮古', '2024-01-02T05:00:00+09:00')])
    const b = area('220', [station('宮古', '2024-01-02T06:00:00+09:00')])
    expect(tideStationKey(a, a.stations![0])).not.toBe(tideStationKey(b, b.stations![0]))
    expect(collectTideEntries([a, b]).size).toBe(2)
  })

  it('rememberTideEntries はその報の全地点を既読へ移す', () => {
    const spoken = new Map<string, SpokenTideEntry>()
    rememberTideEntries(areas, spoken)
    expect(spoken.size).toBe(2)
    expect(tideReportChange(areas, spoken)).toBe('none')
  })
})

describe('isTideReport', () => {
  const tsunami = (infoName?: string) => ({ infoName } as JMATsunami)

  it('情報名が一致すれば真', () => {
    expect(isTideReport(tsunami(TIDE_REPORT_INFO_NAME))).toBe(true)
  })

  // 対照: 同じ VTSE51 でも観測情報は別の主題
  it('津波観測に関する情報は偽（どちらも stations を運ぶので中身では見分けられない）', () => {
    expect(isTideReport(tsunami('津波観測に関する情報'))).toBe(false)
    expect(isTideReport(tsunami(undefined))).toBe(false)
  })
})

// ============================================================
// 読み上げ文
// ============================================================

describe('tsunamiTideToSegments', () => {
  const headline = '各地の満潮時刻と津波到達予想時刻をお知らせします。'

  // 正: 初報は名乗りだけ（まだ伝えていないものを「更新されました」とは言えない）
  it('first では名乗りだけを読む', () => {
    expect(text(tsunamiTideToSegments('first', headline))).toBe(headline)
  })

  it('tide では満潮時刻の更新を伝える', () => {
    expect(text(tsunamiTideToSegments('tide', headline))).toBe(`${headline}満潮時刻が更新されました。`)
  })

  // 対照: 満潮時刻が動いていない報で「満潮時刻が更新されました」と言わない
  it('arrival では到達状況の更新を伝える', () => {
    expect(text(tsunamiTideToSegments('arrival', headline))).toBe(`${headline}津波の到達状況が更新されました。`)
  })

  it('none では変化が無いことを伝える', () => {
    expect(text(tsunamiTideToSegments('none', headline))).toBe(`${headline}内容に変わりはありません。`)
  })

  // 安全弁: 名乗りを欠かさない（見出し文が無い電文でも文が成立する）
  it('見出し文が無ければ定数から補う', () => {
    expect(text(tsunamiTideToSegments('none'))).toBe(`${headline}内容に変わりはありません。`)
    expect(text(tsunamiTideToSegments('none', '   '))).toBe(`${headline}内容に変わりはありません。`)
  })
})

describe('tsunamiMaxHeightTimeToSegments', () => {
  // 正: 地点名と述語を読む
  it('予報区と地点名を並べて述語を付ける', () => {
    const t = text(tsunamiMaxHeightTimeToSegments([obs('宮古', 0.4), obs('釜石', 0.1)]))
    expect(t).toBe('津波観測情報。岩手県、宮古、釜石で、最大波の観測時刻が更新されました。')
  })

  // 対照: 対象が無ければ何も返さない（空の断片列が名乗りだけの発話になるのを防ぐ）
  it('観測点が無ければ空', () => {
    expect(tsunamiMaxHeightTimeToSegments([])).toEqual([])
  })

  // 安全弁: 波高を読まない（前の報で既に声にした値を繰り返さない）
  it('波高は読まない', () => {
    expect(text(tsunamiMaxHeightTimeToSegments([obs('宮古', 8.5)]))).not.toContain('8.5')
  })

  // 安全弁: 上限で落ちた分を黙って捨てない
  it('件数上限を超えたら「ほか◯地点」を足す', () => {
    const many = Array.from({ length: MAX_HEIGHT_TIME_SPEAK_MAX_POINTS + 2 }, (_, i) => obs(`地点${i}`, 0.2))
    const t = text(tsunamiMaxHeightTimeToSegments(many))
    expect(t).toContain('ほか2地点でも更新されています。')
    expect(selectMaxHeightTimeUpdatesToSpeak(many)).toHaveLength(MAX_HEIGHT_TIME_SPEAK_MAX_POINTS)
  })
})

describe('tsunamiObservationNoChangeSegments', () => {
  // 正: 名乗りだけで終わらせない
  it('観測波高が据え置きであることを伝える', () => {
    expect(text(tsunamiObservationNoChangeSegments())).toBe('津波観測情報。観測された波高に変わりはありません。')
  })

  // 安全弁: 言い切る範囲を波高に限る（最大波の時刻・到達状況は動いていることがある）
  it('波高以外について変わりがないとは言わない', () => {
    const t = text(tsunamiObservationNoChangeSegments())
    expect(t).not.toContain('最大波')
    expect(t).not.toContain('到達')
  })
})
