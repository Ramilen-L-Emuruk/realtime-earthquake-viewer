// @vitest-environment jsdom
// parseEarthquakeFromXml（REST 履歴経路）のテスト。
// DOMParser を使うためこのファイルだけ jsdom 環境で動かす（既定は node）。
import { describe, it, expect } from 'vitest'
import { parseEarthquake, parseEarthquakeFromXml } from './dmdataParser'

// 震度速報（VXSE51）。震源が未確定の段階で出るため Earthquake 要素を持たず、
// 震度は Pref > Area（一次細分区域）までしか無い。
const VXSE51_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>震度速報</Title>
    <DateTime>2026-08-08T18:00:00Z</DateTime>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>震度速報</Title>
    <ReportDateTime>2026-08-09T03:00:00+09:00</ReportDateTime>
    <TargetDateTime>2026-08-09T02:58:00+09:00</TargetDateTime>
    <EventID>20260809025800</EventID>
    <InfoType>発表</InfoType>
    <Serial>1</Serial>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
    <Intensity>
      <Observation>
        <MaxInt>4</MaxInt>
        <Pref>
          <Name>岩手県</Name>
          <Code>03</Code>
          <MaxInt>4</MaxInt>
          <Area>
            <Name>岩手県沿岸北部</Name>
            <Code>221</Code>
            <MaxInt>4</MaxInt>
          </Area>
          <Area>
            <Name>岩手県内陸北部</Name>
            <Code>211</Code>
            <MaxInt>3</MaxInt>
          </Area>
        </Pref>
      </Observation>
    </Intensity>
  </Body>
</Report>`

// 震源・震度に関する情報（VXSE53）。区域(Area)と観測点(IntensityStation)を併せ持つ。
// Area 直下の MaxInt(4) と、その配下 City の MaxInt(3) をわざと食い違わせている。
const VXSE53_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
  <Control>
    <Title>震源・震度に関する情報</Title>
    <DateTime>2026-08-08T18:02:00Z</DateTime>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>震源・震度に関する情報</Title>
    <ReportDateTime>2026-08-09T03:02:00+09:00</ReportDateTime>
    <TargetDateTime>2026-08-09T02:58:00+09:00</TargetDateTime>
    <EventID>20260809025800</EventID>
    <InfoType>発表</InfoType>
    <Serial>1</Serial>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
    <Earthquake>
      <OriginTime>2026-08-09T02:58:00+09:00</OriginTime>
      <ArrivalTime>2026-08-09T02:58:00+09:00</ArrivalTime>
      <Hypocenter>
        <Area>
          <Name>岩手県沖</Name>
          <Coordinate>+39.9+142.2-50000/</Coordinate>
        </Area>
      </Hypocenter>
      <jmx_eb:Magnitude type="Mj">5.1</jmx_eb:Magnitude>
    </Earthquake>
    <Intensity>
      <Observation>
        <MaxInt>4</MaxInt>
        <Pref>
          <Name>岩手県</Name>
          <Code>03</Code>
          <MaxInt>4</MaxInt>
          <Area>
            <Name>岩手県沿岸北部</Name>
            <Code>221</Code>
            <MaxInt>4</MaxInt>
            <City>
              <Name>普代村</Name>
              <Code>03506</Code>
              <MaxInt>3</MaxInt>
              <IntensityStation>
                <Name>普代村銅屋</Name>
                <Code>3350631</Code>
                <Int>3</Int>
              </IntensityStation>
            </City>
          </Area>
        </Pref>
      </Observation>
    </Intensity>
  </Body>
</Report>`

describe('parseEarthquakeFromXml: 震度速報（VXSE51）', () => {
  it('Earthquake 要素が無くてもパースできる', () => {
    const quake = parseEarthquakeFromXml('VXSE51', VXSE51_XML)
    expect(quake).not.toBeNull()
    expect(quake!.issue.type).toBe('震度速報')
  })

  it('震源は「位置不明」センチネル(-200)になる', () => {
    const hc = parseEarthquakeFromXml('VXSE51', VXSE51_XML)!.earthquake.hypocenter
    expect(hc.latitude).toBe(-200)
    expect(hc.longitude).toBe(-200)
    expect(hc.magnitude).toBe(0)
  })

  it('earthquake.time に Head/TargetDateTime を使う', () => {
    const quake = parseEarthquakeFromXml('VXSE51', VXSE51_XML)!
    expect(quake.earthquake.time).toBe('2026-08-09T02:58:00+09:00')
  })

  it('points は一次細分区域のみで、pref は空にする', () => {
    const points = parseEarthquakeFromXml('VXSE51', VXSE51_XML)!.points
    expect(points).toEqual([
      { pref: '', addr: '岩手県沿岸北部', isArea: true, scale: 40 },
      { pref: '', addr: '岩手県内陸北部', isArea: true, scale: 30 },
    ])
  })
})

describe('parseEarthquakeFromXml: 震源・震度に関する情報（VXSE53）', () => {
  it('区域と観測点の両方を points に持つ', () => {
    const points = parseEarthquakeFromXml('VXSE53', VXSE53_XML)!.points
    expect(points.filter(p => p.isArea)).toHaveLength(1)
    expect(points.filter(p => !p.isArea)).toHaveLength(1)
  })

  it('区域の震度は Area 直下の MaxInt を採り、配下 City の値に引きずられない', () => {
    const points = parseEarthquakeFromXml('VXSE53', VXSE53_XML)!.points
    const area = points.find(p => p.isArea)!
    expect(area).toEqual({ pref: '', addr: '岩手県沿岸北部', isArea: true, scale: 40 })
  })

  it('観測点は所属都道府県を pref に持つ', () => {
    const points = parseEarthquakeFromXml('VXSE53', VXSE53_XML)!.points
    const station = points.find(p => !p.isArea)!
    expect(station).toEqual({ pref: '岩手県', addr: '普代村銅屋', isArea: false, scale: 30 })
  })

  it('震源を持つ電文では震源要素を読む', () => {
    const eq = parseEarthquakeFromXml('VXSE53', VXSE53_XML)!.earthquake
    expect(eq.hypocenter.name).toBe('岩手県沖')
    expect(eq.hypocenter.latitude).toBeCloseTo(39.9)
    expect(eq.hypocenter.longitude).toBeCloseTo(142.2)
    expect(eq.hypocenter.magnitude).toBeCloseTo(5.1)
    expect(eq.time).toBe('2026-08-09T02:58:00+09:00')
  })

  it('震源を持つはずの電文で座標が読めなければ捨てる', () => {
    const broken = VXSE53_XML.replace('+39.9+142.2-50000/', '')
    expect(parseEarthquakeFromXml('VXSE53', broken)).toBeNull()
  })
})

// JSON 経路（parseEarthquake）: infoType の訂正フラグが握り潰されないことを確認する。
// 従来は correct を 'なし' 固定にしていて、UI での「訂正」バッジ表示が発火しなかった。
describe('parseEarthquake: JSON 訂正フラグの伝播', () => {
  const baseJson = {
    eventId: '20260809025800',
    serialNo: '2',
    reportDateTime: '2026-08-09T03:05:00+09:00',
    targetDateTime: '2026-08-09T02:58:00+09:00',
    editorialOffice: '気象庁',
    body: {
      earthquake: {
        arrivalTime: '2026-08-09T02:58:00+09:00',
        hypocenter: {
          name: '岩手県沖',
          coordinate: { latitude: { value: '39.9' }, longitude: { value: '142.2' }, height: { value: '-50000' } },
        },
        magnitude: { value: '5.1' },
        maxInt: '4',
      },
      intensity: { maxInt: '4' },
    },
  }

  it('infoType が「訂正」なら correct=訂正 になる', () => {
    const quake = parseEarthquake('VXSE53', { ...baseJson, infoType: '訂正' })
    expect(quake).not.toBeNull()
    expect(quake!.issue.correct).toBe('訂正')
  })

  it('infoType が「発表」なら correct=なし のまま', () => {
    const quake = parseEarthquake('VXSE53', { ...baseJson, infoType: '発表' })
    expect(quake).not.toBeNull()
    expect(quake!.issue.correct).toBe('なし')
  })

  it('infoType 欠落時は correct=なし', () => {
    const quake = parseEarthquake('VXSE53', baseJson)
    expect(quake).not.toBeNull()
    expect(quake!.issue.correct).toBe('なし')
  })
})
