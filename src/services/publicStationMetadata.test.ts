// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPublicStationMetadata, mergePublicStationEpochs, parsePublicStationXml } from './publicStationMetadata'
import type { PublicStationEpoch, PublicStationsFile } from '../utils/publicStations'

const epoch: PublicStationEpoch = { code: 'JMN', nameJa: '高知物部', siteName: 'Monobe', lat: 33, lon: 134, elevation: 10, start: '2000-01-01T00:00:00Z', end: null, channels: (['BHE', 'BHN', 'BHZ'] as const).map(code => ({ code, sampleRate: 20, sensitivity: 1e9, sensitivityFreq: 8, azimuth: code === 'BHE' ? 90 : 0, dip: code === 'BHZ' ? -90 : 0 })) }
const file: PublicStationsFile = { source: { station: '', channel: '' }, fetchedOn: '2026-10-15', stations: [epoch], excluded: [] }
function xml(sensitivity = 1e9, from = '2000-01-01T00:00:00.0000', site = 'Monobe'): string {
  return `<FDSNStationXML xmlns="http://www.fdsn.org/xml/station/1"><Network code="JP"><Station code="JMN" startDate="2000-01-01T00:00:00.0000"><Latitude>33</Latitude><Longitude>134</Longitude><Elevation>10</Elevation><Site><Name>${site}</Name></Site>${epoch.channels.map(c => `<Channel code="${c.code}" locationCode="" startDate="${from}"><SampleRate>20</SampleRate><Azimuth>${c.azimuth}</Azimuth><Dip>${c.dip}</Dip><Response><InstrumentSensitivity><Value>${sensitivity}</Value><Frequency>8</Frequency><InputUnits><Name>M/S</Name></InputUnits></InstrumentSensitivity></Response></Channel>`).join('')}</Station></Network></FDSNStationXML>`
}

afterEach(() => vi.unstubAllGlobals())
describe('公開観測点情報の照合', () => {
  it('名前・場所・感度・成分・期間を読み、変化が無ければ生成済みの表の参照を保つ', () => {
    const parsed = parsePublicStationXml(xml(), file)
    expect(parsed).toEqual([epoch])
    expect(mergePublicStationEpochs(file, parsed)).toBe(file)
  })
  it('新しい感度の期間を優先し、過去の期間を残す', () => {
    const next = mergePublicStationEpochs(file, parsePublicStationXml(xml(2e9, '2026-10-01T00:00:00.0000'), file))
    expect(next.stations).toHaveLength(2)
    expect(next.stations[0]).toMatchObject({ end: '2026-10-01T00:00:00Z', channels: epoch.channels })
    expect(next.stations[1]).toMatchObject({ start: '2026-10-01T00:00:00Z', channels: [{ sensitivity: 2e9 }, { sensitivity: 2e9 }, { sensitivity: 2e9 }] })
    expect(epoch.end).toBeNull()
  })
  it('応答に含まれない観測点を削除せず、未知の地点名は推測で訳さない', () => {
    const baseline = { ...file, stations: [epoch, { ...epoch, code: 'JTM' }] }
    const next = mergePublicStationEpochs(baseline, parsePublicStationXml(xml(2e9, '2026-10-01T00:00:00', 'New site'), baseline))
    expect(next.stations.some(s => s.code === 'JTM')).toBe(true)
    expect(next.stations.find(s => s.code === 'JMN' && s.start === '2026-10-01T00:00:00Z')?.nameJa).toBe('New site')
  })
  it('上流が明示した終了後に、旧い無期限の期間を復活させない', () => {
    const closed = { ...epoch, end: '2026-10-01T00:00:00Z' }
    const next = mergePublicStationEpochs(file, [closed])
    expect(next).not.toBe(file)
    expect(next.stations).toEqual([closed])
    // 運用期間の間に実在する穴も、旧い無期限の行で埋めない。
    const resumed = { ...epoch, start: '2026-10-02T00:00:00Z', channels: epoch.channels.map(c => ({ ...c, sensitivity: 2e9 })) }
    expect(mergePublicStationEpochs(file, [closed, resumed]).stations).toEqual([closed, resumed])
  })

  it('含む側の小数秒の終わりを秒へ切り上げる', () => {
    const closed = xml().replace('<Station code="JMN"', '<Station endDate="2026-09-30T23:59:59.9999" code="JMN"')
    expect(parsePublicStationXml(closed, file)[0].end).toBe('2026-10-01T00:00:00Z')
  })
  it.each([['XML破損', '<bad>'], ['速度以外', xml().split('M/S').join('M/S**2')], ['感度不正', xml(-1)], ['成分欠け', xml().replace('code="BHE"', 'code="LHE"')]])('%sなら既存表を置き換える材料にしない', (_label, value) => {
    expect(() => parsePublicStationXml(value, file)).toThrow()
  })
  it('上流の重複期間は黙って片方を選ばない', () => {
    expect(() => mergePublicStationEpochs(file, [epoch, { ...epoch }])).toThrow(/重なる/)
  })
  it('HTTP成功だけを読み、失敗応答は採用しない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(xml(), { status: 200 })).mockResolvedValueOnce(new Response('', { status: 503 })))
    expect(await fetchPublicStationMetadata(file)).toBe(file)
    await expect(fetchPublicStationMetadata(file)).rejects.toThrow('503')
  })
})
