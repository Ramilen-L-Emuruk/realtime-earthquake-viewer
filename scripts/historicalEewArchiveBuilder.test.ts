import { describe, it, expect } from 'vitest'
import { buildEewEntries } from './historicalEewArchiveBuilder'
import type { ParsedEewPage, ParsedEewReport } from './historicalEewParser'

function hypo(name: string, latitude: number, longitude: number) {
  return { originTimeIso: '2011-03-12T00:00:00.000Z', name, latitude, longitude, depthKm: 10, magnitude: 5, maxIntensityText: '4' }
}

function report(overrides: Partial<ParsedEewReport>): ParsedEewReport {
  return {
    reportNum: 1,
    timeIso: '2011-03-12T00:00:05.000Z',
    latitude: 37.0,
    longitude: 138.6,
    depthKm: 10,
    magnitude: 6,
    forecastCell: '※1',
    isPublicWarningRow: false,
    ...overrides,
  }
}

const footnotes = new Map([['※1', [{ scaleFrom: 30, scaleTo: 55, regionNames: ['長野県北部'] }]]])

describe('buildEewEntries の severity 判定', () => {
  it('対照（バグ回帰）: scaleTo>=45 の区域があっても、isPublicWarningRow が立つまでは Forecast のまま', () => {
    // 実例（dir 20110312043159）: 第1報は震度5強程度以上の区域を含むが、
    // 気象庁が公式に警報化したのは第3報から。予想震度だけで逆算すると
    // 第1報から誤って Warning になる。
    const parsed: ParsedEewPage = {
      hypocenter: hypo('長野県北部', 37.0, 138.6),
      hypocenterCandidates: [hypo('長野県北部', 37.0, 138.6)],
      reports: [report({ reportNum: 1, isPublicWarningRow: false })],
      footnotes,
    }
    const [entry] = buildEewEntries(parsed, { idPrefix: 'test' })
    const event = (entry.payload as { event: { severity: string } }).event
    expect(event.severity).toBe('Forecast')
  })

  it('正: isPublicWarningRow が立った報から Warning になる', () => {
    const parsed: ParsedEewPage = {
      hypocenter: hypo('長野県北部', 37.0, 138.6),
      hypocenterCandidates: [hypo('長野県北部', 37.0, 138.6)],
      reports: [report({ reportNum: 1, isPublicWarningRow: true })],
      footnotes,
    }
    const [entry] = buildEewEntries(parsed, { idPrefix: 'test' })
    const event = (entry.payload as { event: { severity: string } }).event
    expect(event.severity).toBe('Warning')
  })

  it('安全弁: 一度 Warning になったら、以後の報で isPublicWarningRow が立たなくても Warning のまま', () => {
    const parsed: ParsedEewPage = {
      hypocenter: hypo('長野県北部', 37.0, 138.6),
      hypocenterCandidates: [hypo('長野県北部', 37.0, 138.6)],
      reports: [
        report({ reportNum: 1, isPublicWarningRow: true, timeIso: '2011-03-12T00:00:05.000Z' }),
        report({ reportNum: 2, isPublicWarningRow: false, timeIso: '2011-03-12T00:00:10.000Z' }),
      ],
      footnotes,
    }
    const entries = buildEewEntries(parsed, { idPrefix: 'test' })
    const severities = entries.map((e) => (e.payload as { event: { severity: string } }).event.severity)
    expect(severities).toEqual(['Warning', 'Warning'])
  })
})

describe('buildEewEntries の震央地名解決', () => {
  it('報ごとの座標に最も近い震源候補の名前を使う（1行目を無条件採用しない）', () => {
    const parsed: ParsedEewPage = {
      hypocenter: hypo('茨城県沖', 35.9, 141.8),
      hypocenterCandidates: [hypo('茨城県沖', 35.9, 141.8), hypo('長野県北部', 37.0, 138.6)],
      reports: [report({ reportNum: 1, latitude: 37.0, longitude: 138.6 })],
      footnotes,
    }
    const [entry] = buildEewEntries(parsed, { idPrefix: 'test' })
    const event = (entry.payload as { event: { earthquake: { hypocenter: { name: string } } } }).event
    expect(event.earthquake.hypocenter.name).toBe('長野県北部')
  })
})
