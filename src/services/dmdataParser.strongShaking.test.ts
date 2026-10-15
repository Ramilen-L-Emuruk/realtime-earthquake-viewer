// @vitest-environment jsdom
// DOMParser を使うため jsdom 環境で動かす（既定は node）。
//
// 「非常に強い揺れを検知・最大予測震度のみ」の緊急地震速報（気象庁「地震火山関連 XML 電文解説資料」Ⅱ.21）。
//
// この形の報は発生時刻・仮定震源要素の印・規模・区域のどれも持たず、震央は強い揺れを検知した観測点、
// 深さ 10km は仮の値。**確定した震源の報として扱わない**ことを、読み取りから画面・地図・予報円・自動解除
// まで固定する。電文の本文は解説資料の事例 1（Ⅱ.21－21）をそのまま使う。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseEEWFromXml } from './dmdataParser'
import { log } from '../utils/logger'
import { calcEEWCancelTime, compareEewNewestFirst, eewMaxScale, eewNoForecastReason, eewSortTimeMs, isProvisionalHypocenter } from '../utils/eew'
import { computeEewCircle } from '../hooks/usePsWaveCalc'
import { createTestEEWStrongShaking } from '../utils/testData'
import type { EEWAlert } from '../types/earthquake'

afterEach(() => {
  vi.restoreAllMocks()
})

const STRONG_SHAKING_TEXT = '１４日１９時４１分１５秒頃\n千葉県銚子市付近  最大震度５弱程度以上と推定'

/** この形の電文。`withOriginTime` で通常の報（発生時刻あり）に戻せる。 */
function strongShakingXml(o: { withOriginTime?: boolean; infoType?: string; bodyText?: string | null } = {}): string {
  const canceled = o.infoType === '取消'
  const bodyText = o.bodyText === undefined ? STRONG_SHAKING_TEXT : o.bodyText
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">',
    '<Control><Title>緊急地震速報（地震動予報）</Title><DateTime>2026-01-14T10:41:16Z</DateTime><Status>通常</Status><EditorialOffice>気象庁本庁</EditorialOffice></Control>',
    '<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">',
    '<Title>緊急地震速報（地震動予報）</Title>',
    '<ReportDateTime>2026-01-14T19:41:16+09:00</ReportDateTime>',
    '<EventID>20260114194115</EventID>',
    `<InfoType>${o.infoType ?? '発表'}</InfoType>`,
    '<Serial>1</Serial>',
    '<Headline><Text/></Headline>',
    '</Head>',
    '<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">',
    ...(canceled ? [] : [
      '<Earthquake>',
      ...(o.withOriginTime ? ['<OriginTime>2026-01-14T19:41:14+09:00</OriginTime>'] : []),
      '<ArrivalTime>2026-01-14T19:41:15+09:00</ArrivalTime>',
      '<Hypocenter><Area><Name>千葉県東方沖</Name><Code type="震央地名">350</Code>',
      '<jmx_eb:Coordinate description="北緯３５．７度　東経１４０．８度　深さ　１０ｋｍ" datum="日本測地系">+35.7+140.8-10000/</jmx_eb:Coordinate>',
      '</Area></Hypocenter>',
      '<jmx_eb:Magnitude type="Mj" condition="不明" description="Ｍ不明">NaN</jmx_eb:Magnitude>',
      '</Earthquake>',
      '<Intensity><Forecast><ForecastInt><From>5-</From><To>over</To></ForecastInt></Forecast></Intensity>',
    ]),
    ...(bodyText !== null ? [`<Text>${canceled ? '先ほどの、緊急地震速報（予報）は取り消します。' : bodyText}</Text>`] : []),
    '</Body></Report>',
  ].join('\n')
}

describe('parseEEWFromXml: 「非常に強い揺れを検知」の報', () => {
  it('発生時刻が無い報に印を付け、本文を持つ', () => {
    const eew = parseEEWFromXml('VXSE45', strongShakingXml())!
    expect(eew.strongShakingOnly).toBe(true)
    expect(eew.strongShakingText).toBe(STRONG_SHAKING_TEXT)
    expect(eew.cancelText).toBeUndefined()
    expect(eew.earthquake.originTime).toBe('')
    expect(eew.earthquake.condition).toBe('')
    expect(Number.isNaN(eew.earthquake.hypocenter.magnitude)).toBe(true)
    expect(eew.earthquake.hypocenter.depth).toBe(10)
    expect(eew.forecastMaxScale).toBe(45)
    expect(eew.forecastMaxScaleOrAbove).toBe(true)
    expect(isProvisionalHypocenter(eew)).toBe(true)
  })

  it('対照: 発生時刻のある報は印も本文も持たず、想定外の本文として記録する', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const eew = parseEEWFromXml('VXSE45', strongShakingXml({ withOriginTime: true }))!
    expect(eew.strongShakingOnly).toBeUndefined()
    expect(eew.strongShakingText).toBeUndefined()
    expect(isProvisionalHypocenter(eew)).toBe(false)
    expect(warn.mock.calls.some(c => String(c[0]).includes('想定外の本文'))).toBe(true)
  })

  it('安全弁: 取消は印を付けず、本文は取消の概要として持つ', () => {
    const eew = parseEEWFromXml('VXSE45', strongShakingXml({ infoType: '取消' }))!
    expect(eew.strongShakingOnly).toBeUndefined()
    expect(eew.strongShakingText).toBeUndefined()
    expect(eew.cancelText).toBe('先ほどの、緊急地震速報（予報）は取り消します。')
  })

  it('本文が欠けた報でも、発生時刻が無ければ仮の震源として扱い、本文の欠落を記録する', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const eew = parseEEWFromXml('VXSE45', strongShakingXml({ bodyText: null }))!
    expect(eew.strongShakingOnly).toBe(true)
    expect(eew.strongShakingText).toBeUndefined()
    expect(warn.mock.calls.some(c => String(c[0]).includes('本文（Body/Text）がありません'))).toBe(true)
  })

  it('資料どおりの形なら警告を出さない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    parseEEWFromXml('VXSE45', strongShakingXml())
    expect(warn).not.toHaveBeenCalled()
  })

  it('安全弁: 発生時刻の要素が中身だけ空・規模が数値・警報の報は、この形と見なさず記録だけ残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const xml = strongShakingXml()
      .replace('<ArrivalTime>', '<OriginTime> </OriginTime><ArrivalTime>')
      .replace('>NaN</jmx_eb:Magnitude>', '>6.8</jmx_eb:Magnitude>')
    const eew = parseEEWFromXml('VXSE43', xml)!
    // 確定した震源の警報を読み損ねたなら、M・深さを消すほうが害が大きい
    expect(eew.strongShakingOnly).toBeUndefined()
    expect(isProvisionalHypocenter(eew)).toBe(false)
    const msg = warn.mock.calls.map(c => String(c[0])).find(m => m.includes('仮の震源とは扱いません')) ?? ''
    expect(msg).toContain('発生時刻の要素はあるが中身が空')
    expect(msg).toContain('規模が数値')
    expect(msg).toContain('警報の報')
  })

  it.each([
    ['警報の報だけ', 'VXSE43', (x: string) => x],
    ['規模が数値だけ', 'VXSE45', (x: string) => x.replace('>NaN</jmx_eb:Magnitude>', '>5.1</jmx_eb:Magnitude>')],
  ])('安全弁: %s食い違っても、この形と見なさない', (_label, head, edit) => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(parseEEWFromXml(head, edit(strongShakingXml()))!.strongShakingOnly).toBeUndefined()
  })

  it('予想震度が載っているので、予想震度が無い理由（単独点処理）の対象にしない', () => {
    const eew = parseEEWFromXml('VXSE45', strongShakingXml())!
    // 理由の判定は「仮定震源要素」だけを見る。この形を巻き込むと「単独点処理のため」と言い出す
    expect(eewNoForecastReason(eew)).not.toBe('assumed')
    expect(eewMaxScale(eew)).toBe(45)
  })
})

describe('仮の震源の報を確定した震源として扱わない', () => {
  const strong = (): EEWAlert => parseEEWFromXml('VXSE45', strongShakingXml())!

  it('予報円（とそれを拾うカウントダウン）の対象にしない', () => {
    expect(computeEewCircle(strong(), Date.parse('2026-01-14T10:41:30Z'))).toBeNull()
  })

  it('発生時刻が読めない報は、仮の震源でなくても円の対象にしない（NaN を `t < 0` が通していた）', () => {
    const base = parseEEWFromXml('VXSE45', strongShakingXml({ withOriginTime: true }))!
    const unreadable: EEWAlert = { ...base, earthquake: { ...base.earthquake, originTime: '' } }
    expect(computeEewCircle(unreadable, Date.parse('2026-01-14T10:41:30Z'))).toBeNull()
    // 対照: 発生時刻が読めれば円を作る
    expect(computeEewCircle(base, Date.parse('2026-01-14T10:41:30Z'))).not.toBeNull()
  })

  it('並べる時刻は、発生時刻が無ければ発現時刻を使う', () => {
    expect(eewSortTimeMs(strong())).toBe(Date.parse('2026-01-14T10:41:15Z'))
    const base = parseEEWFromXml('VXSE45', strongShakingXml({ withOriginTime: true }))!
    expect(eewSortTimeMs(base)).toBe(Date.parse('2026-01-14T10:41:14Z'))
  })

  it('他の地震と並べても、発生時刻の無い報を最も古い扱いにしない（書式の違う時刻も揃えて比べる）', () => {
    // 1 秒前に起きた別の地震（時刻は `Z` の書式）
    const older = createTestEEWStrongShaking('older', 2, new Date('2026-01-14T10:41:14Z'))
    const sorted = [older, strong()].sort(compareEewNewestFirst)
    expect(sorted[0].earthquake.hypocenter.name).toBe('千葉県東方沖')
    // 安全弁: どちらの時刻も読めない報は最後へ回る
    const unreadable: EEWAlert = { ...strong(), earthquake: { ...strong().earthquake, originTime: '', arrivalTime: '' } }
    expect([unreadable, older].sort(compareEewNewestFirst)[0]).toBe(older)
  })
})

describe('calcEEWCancelTime: 規模が判らない報', () => {
  it('規模が NaN の報は、規模 6.0 の報と同じ時刻に解除する', () => {
    const base = parseEEWFromXml('VXSE45', strongShakingXml({ withOriginTime: true }))!
    const report = new Date('2026-01-14T10:41:16Z')
    const unknown: EEWAlert = { ...base, earthquake: { ...base.earthquake, hypocenter: { ...base.earthquake.hypocenter, magnitude: NaN } } }
    const m6: EEWAlert = { ...base, earthquake: { ...base.earthquake, hypocenter: { ...base.earthquake.hypocenter, magnitude: 6.0 } } }
    expect(calcEEWCancelTime(unknown, report).getTime()).toBe(calcEEWCancelTime(m6, report).getTime())
    // 安全弁: M6 相当は最終報の 60 秒後（下限）より後ろへ伸びる ——NaN のまま流れると下限に張り付いていた
    expect(calcEEWCancelTime(unknown, report).getTime()).toBeGreaterThan(report.getTime() + 60_000)
  })

  it('実際のこの形（発生時刻も無い）では、発現時刻を起点に規模 6.0 として解除する', () => {
    const strong = parseEEWFromXml('VXSE45', strongShakingXml())!
    const report = new Date('2026-01-14T10:41:16Z')
    // 比べる相手: 同じ報に発現時刻と同じ発生時刻・M6 を与えたもの
    const asM6: EEWAlert = {
      ...strong,
      earthquake: { ...strong.earthquake, originTime: strong.earthquake.arrivalTime, hypocenter: { ...strong.earthquake.hypocenter, magnitude: 6.0 } },
    }
    expect(calcEEWCancelTime(strong, report).getTime()).toBe(calcEEWCancelTime(asM6, report).getTime())
    expect(calcEEWCancelTime(strong, report).getTime()).toBeGreaterThan(report.getTime() + 60_000)
  })

  it('仮の震源でなくても、発生時刻だけが壊れた報は発現時刻を起点にする', () => {
    const base = parseEEWFromXml('VXSE45', strongShakingXml({ withOriginTime: true }))!
    const report = new Date('2026-01-14T10:41:16Z')
    const broken: EEWAlert = { ...base, earthquake: { ...base.earthquake, originTime: '壊れた値' } }
    const fromArrival: EEWAlert = { ...base, earthquake: { ...base.earthquake, originTime: base.earthquake.arrivalTime } }
    expect(calcEEWCancelTime(broken, report).getTime()).toBe(calcEEWCancelTime(fromArrival, report).getTime())
    // 対照: 発生時刻が読めればそちらを使う（発現時刻より 1 秒早い起点）
    expect(calcEEWCancelTime(base, report).getTime()).toBe(calcEEWCancelTime(fromArrival, report).getTime() - 1000)
  })

  it('安全弁: 発生時刻も発現時刻も読めなければ、発表時刻の下限だけで決める（従来どおり）', () => {
    const strong = parseEEWFromXml('VXSE45', strongShakingXml())!
    const report = new Date('2026-01-14T10:41:16Z')
    const none: EEWAlert = { ...strong, earthquake: { ...strong.earthquake, originTime: '', arrivalTime: '' } }
    expect(calcEEWCancelTime(none, report).getTime()).toBe(report.getTime() + 60_000)
  })
})

describe('createTestEEWStrongShaking（テストボタン）', () => {
  it('第 1 報はこの形、第 2 報は仮定震源要素（実電文の流れ）', () => {
    const first = createTestEEWStrongShaking('e', 1, new Date('2026-01-14T10:41:15Z'))
    expect(first.strongShakingOnly).toBe(true)
    expect(first.strongShakingText).toContain('最大震度５弱程度以上と推定')
    expect(first.earthquake.originTime).toBe('')
    expect(isProvisionalHypocenter(first)).toBe(true)
    const second = createTestEEWStrongShaking('e', 2, new Date('2026-01-14T10:41:15Z'))
    expect(second.strongShakingOnly).toBeUndefined()
    expect(second.earthquake.condition).toBe('仮定震源要素')
    expect(isProvisionalHypocenter(second)).toBe(true)
  })

  it('本文の日時は全角・JST・ゼロ詰め', () => {
    const first = createTestEEWStrongShaking('e', 1, new Date('2026-01-14T10:41:05Z'))
    expect(first.strongShakingText!.startsWith('１４日１９時４１分０５秒頃')).toBe(true)
  })
})
