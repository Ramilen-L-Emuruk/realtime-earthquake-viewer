// @vitest-environment jsdom
// parseEarthquakeFromXml（REST 履歴経路）のテスト。
// DOMParser を使うためこのファイルだけ jsdom 環境で動かす（既定は node）。
import { describe, it, expect } from 'vitest'
import { parseEarthquake, parseEarthquakeFromXml, parseEEW, parseTsunami } from './dmdataParser'

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

// DMD-7: EEW（VXSE43/45）JSON パーサーの基本テスト。severity 付与・cancel・LPGM を検証する。
describe('parseEEW: JSON 電文の severity・cancel・LPGM', () => {
  const baseEEWJson = {
    eventId: '20260101120000',
    serialNo: '1',
    reportDateTime: '2026-01-01T12:00:10+09:00',
    body: {
      earthquake: {
        originTime: '2026-01-01T12:00:00+09:00',
        arrivalTime: '2026-01-01T12:00:00+09:00',
        condition: '以上',
        hypocenter: {
          name: '茨城県沖',
          coordinate: { latitude: { value: '36.2' }, longitude: { value: '141.0' }, height: { value: '-30000' } },
        },
        magnitude: { value: '6.5' },
      },
      intensity: {
        forecastMaxInt: { from: '5-', to: '5+' },
        forecastMaxLgInt: { from: '2', to: '3' },
      },
    },
  }

  it('VXSE45 は severity=Forecast（予報）', () => {
    const eew = parseEEW('VXSE45', baseEEWJson)
    expect(eew).not.toBeNull()
    expect(eew!.severity).toBe('Forecast')
  })

  it('VXSE43 は severity=Warning（警報）', () => {
    const eew = parseEEW('VXSE43', baseEEWJson)
    expect(eew).not.toBeNull()
    expect(eew!.severity).toBe('Warning')
  })

  it('body.isWarning=true なら VXSE45 でも severity=Warning に格上げ', () => {
    const eew = parseEEW('VXSE45', { ...baseEEWJson, body: { ...baseEEWJson.body, isWarning: true } })
    expect(eew).not.toBeNull()
    expect(eew!.severity).toBe('Warning')
  })

  it('isCanceled=true は cancelled 電文（座標 0・areas 空・VXSE43 は severity=Warning 保持）', () => {
    const cancelJson = { ...baseEEWJson, body: { ...baseEEWJson.body, isCanceled: true } }
    const eew = parseEEW('VXSE43', cancelJson)
    expect(eew).not.toBeNull()
    expect(eew!.cancelled).toBe(true)
    expect(eew!.earthquake.hypocenter.latitude).toBe(0)
    expect(eew!.areas).toEqual([])
    expect(eew!.severity).toBe('Warning')
    // 座標欠落でも cancelled=true なら null を返さない
    const noCoord = { ...baseEEWJson, body: { ...baseEEWJson.body, isCanceled: true, earthquake: { ...baseEEWJson.body.earthquake, hypocenter: { name: 'テスト' } } } }
    expect(parseEEW('VXSE43', noCoord)).not.toBeNull()
  })

  it('forecastMaxScale は to 優先・range 外は undefined', () => {
    // parseIntensityStr マップ: 5- → 45 / 5+ → 50 / 6- → 55 / 6+ → 60
    // 正常系: to='5+' → 50（震度5強）
    const eew = parseEEW('VXSE45', baseEEWJson)
    expect(eew!.forecastMaxScale).toBe(50)
    // to のみ・from 欠落: to='6-' → 55
    const toOnly = {
      ...baseEEWJson,
      body: { ...baseEEWJson.body, intensity: { ...baseEEWJson.body.intensity, forecastMaxInt: { to: '6-' } } },
    }
    expect(parseEEW('VXSE45', toOnly)!.forecastMaxScale).toBe(55)
    // 範囲外（不明値）は undefined
    const outOfRange = {
      ...baseEEWJson,
      body: { ...baseEEWJson.body, intensity: { ...baseEEWJson.body.intensity, forecastMaxInt: { to: '不明' } } },
    }
    expect(parseEEW('VXSE45', outOfRange)!.forecastMaxScale).toBeUndefined()
  })

  it('forecastMaxLpgmClass は to 優先、範囲外は undefined', () => {
    const eew = parseEEW('VXSE45', baseEEWJson)
    expect(eew!.forecastMaxLpgmClass).toBe(3)
    // 範囲外は undefined
    const outOfRange = {
      ...baseEEWJson,
      body: { ...baseEEWJson.body, intensity: { ...baseEEWJson.body.intensity, forecastMaxLgInt: { from: '5', to: '5' } } },
    }
    expect(parseEEW('VXSE45', outOfRange)!.forecastMaxLpgmClass).toBeUndefined()
  })

  it('isLastInfo=true は isFinal=true', () => {
    const finalJson = { ...baseEEWJson, body: { ...baseEEWJson.body, isLastInfo: true } }
    expect(parseEEW('VXSE45', finalJson)!.isFinal).toBe(true)
  })

  it('座標が読めない発表電文（非 cancel）は null', () => {
    const badJson = {
      ...baseEEWJson,
      body: {
        ...baseEEWJson.body,
        earthquake: { ...baseEEWJson.body.earthquake, hypocenter: { name: '茨城県沖' } },
      },
    }
    expect(parseEEW('VXSE45', badJson)).toBeNull()
  })
})

// TSU-2: 津波情報 JSON パーサーの基本テスト。発表・取消・sourceEarthquake の付与を検証する。
describe('parseTsunami: JSON 電文の発表・取消・sourceEarthquake', () => {
  const baseTsunamiJson = {
    eventId: '20260101120000',
    serialNo: '1',
    reportDateTime: '2026-01-01T12:05:00+09:00',
    editorialOffice: '気象庁',
    infoType: '発表',
    body: {
      tsunami: {
        forecasts: [
          {
            // 実装は forecasts[].kind.code を見て grade を決める（parseTsunamiGradeByCode）
            kind: { code: '52' },
            name: '関東',
            firstHeight: {
              arrivalTime: '2026-01-01T12:30:00+09:00',
              condition: 'ただちに津波来襲と予測',
            },
            maxHeight: { description: '10m超', height: { value: '10', condition: '巨大' } },
          },
        ],
      },
      earthquakes: [
        {
          hypocenter: { name: '房総半島沖' },
          magnitude: { value: '8.5' },
          originTime: '2026-01-01T12:00:00+09:00',
        },
      ],
    },
  }

  it('通常発表: cancelled=false・eventId・sourceEarthquake が付与される', () => {
    const t = parseTsunami('VTSE51', baseTsunamiJson)
    expect(t).not.toBeNull()
    expect(t!.cancelled).toBe(false)
    expect(t!.eventId).toBe('20260101120000')
    expect(t!.sourceEarthquake?.hypocenterName).toBe('房総半島沖')
    expect(t!.sourceEarthquake?.magnitude).toBe(8.5)
  })

  it('infoType=取消: cancelled=true・cancelReason=retracted・areas 空', () => {
    const cancelJson = { ...baseTsunamiJson, infoType: '取消' }
    const t = parseTsunami('VTSE51', cancelJson)
    expect(t).not.toBeNull()
    expect(t!.cancelled).toBe(true)
    expect(t!.cancelReason).toBe('retracted')
    expect(t!.areas).toEqual([])
  })

  it('eventId 未設定時は eventId プロパティが undefined になる', () => {
    const noId = { ...baseTsunamiJson, eventId: '' }
    const t = parseTsunami('VTSE51', noId)
    expect(t).not.toBeNull()
    expect(t!.eventId).toBeUndefined()
  })

  it('sourceEarthquake は hypocenterName が空なら undefined', () => {
    const noHypo = {
      ...baseTsunamiJson,
      body: { ...baseTsunamiJson.body, earthquakes: [{ magnitude: { value: '8.5' } }] },
    }
    const t = parseTsunami('VTSE51', noHypo)
    expect(t).not.toBeNull()
    expect(t!.sourceEarthquake).toBeUndefined()
  })

  it('forecasts が全て解除系コード（60）のとき areas=[] で cancelReason=lifted', () => {
    // parseTsunamiGradeByCode: 60 は解除系（Unknown）で continue → areas 空 → 正式解除扱い
    const liftedJson = {
      ...baseTsunamiJson,
      body: {
        ...baseTsunamiJson.body,
        tsunami: {
          forecasts: [
            { kind: { code: '60' }, name: '関東' },
          ],
        },
      },
    }
    const t = parseTsunami('VTSE51', liftedJson)
    expect(t).not.toBeNull()
    expect(t!.cancelled).toBe(true)
    expect(t!.cancelReason).toBe('lifted')
    expect(t!.areas).toEqual([])
  })
})
