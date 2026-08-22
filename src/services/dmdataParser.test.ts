// @vitest-environment jsdom
// parseEarthquakeFromXml（REST 履歴経路）のテスト。
// DOMParser を使うためこのファイルだけ jsdom 環境で動かす（既定は node）。
import { describe, it, expect, vi } from 'vitest'
import { parseEarthquake, parseEarthquakeFromXml, parseEEW, parseTsunami, parseLpgmFromXml, parseNankaiFromXml, parseNankaiCommentaryFromXml } from './dmdataParser'
import { log } from '../utils/logger'

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

  it('観測点は JSON 経路の stations[] と同じ規約で pref を空文字にする（QUAKE-2）', () => {
    // 以前は pref: prefName を付けていたが、EarthquakeCard.prefGroups が「観測点値」を
    // 都道府県別最大震度と誤解し、区域単位の最大震度が観測点値に上書きされる問題があった。
    // 対称性のため JSON stations[] と同じ pref: '' に統一する。
    const points = parseEarthquakeFromXml('VXSE53', VXSE53_XML)!.points
    const station = points.find(p => !p.isArea)!
    expect(station).toEqual({ pref: '', addr: '普代村銅屋', isArea: false, scale: 30 })
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

// 遠地地震に関する情報。VXSE53 で配信され、Control/Title は「震源・震度に関する情報」のまま
// Head/Title だけが「遠地地震に関する情報」になる。国内震度を伴わず、深さ不明の報が多い。
// 付加文は 021x 系ではなく 0226（震源近傍で津波発生の可能性）＋0230（日本への津波の影響なし）
// のように 022x/023x 系を併用する（コードはスペース区切りで 1 つの Code 要素に入る）。
const FOREIGN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
  <Control>
    <Title>震源・震度に関する情報</Title>
    <DateTime>2026-07-17T14:55:00Z</DateTime>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>遠地地震に関する情報</Title>
    <ReportDateTime>2026-07-17T23:55:00+09:00</ReportDateTime>
    <TargetDateTime>2026-07-17T23:55:00+09:00</TargetDateTime>
    <EventID>20260717235535</EventID>
    <InfoType>発表</InfoType>
    <Serial>1</Serial>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
    <Earthquake>
      <OriginTime>2026-07-17T23:49:00+09:00</OriginTime>
      <ArrivalTime>2026-07-17T23:49:00+09:00</ArrivalTime>
      <Hypocenter>
        <Area>
          <Name>中米</Name>
          <Code type="震央地名">945</Code>
          <jmx_eb:Coordinate description="北緯１４．４度　西経　９３．０度　深さ不明">+14.4-093.0/</jmx_eb:Coordinate>
          <DetailedName>メキシコ、チアパス州沿岸</DetailedName>
        </Area>
      </Hypocenter>
      <jmx_eb:Magnitude type="M">7.4</jmx_eb:Magnitude>
    </Earthquake>
    <Comments>
      <ForecastComment codeType="固定付加文">
        <Text>震源の近傍で津波発生の可能性があります。
この地震による日本への津波の影響はありません。</Text>
        <Code>0226 0230</Code>
      </ForecastComment>
    </Comments>
  </Body>
</Report>`

const FOREIGN_JSON = {
  type: '震源・震度に関する情報',
  title: '遠地地震に関する情報',
  infoType: '発表',
  editorialOffice: '気象庁本庁',
  eventId: '20260717235535',
  serialNo: '1',
  reportDateTime: '2026-07-17T23:55:00+09:00',
  targetDateTime: '2026-07-17T23:55:00+09:00',
  headline: '１７日２３時４９分ころ、海外で規模の大きな地震がありました。',
  body: {
    earthquake: {
      originTime: '2026-07-17T23:49:00+09:00',
      arrivalTime: '2026-07-17T23:49:00+09:00',
      hypocenter: {
        code: '945',
        name: '中米',
        // 深さ不明の報は coordinate.height ごと省かれる（高さフォールバックも効かない）
        coordinate: { latitude: { value: '14.4000' }, longitude: { value: '-93.0000' } },
        depth: { type: '深さ', unit: 'km', value: null, condition: '不明' },
        detailed: { code: '1069', name: 'メキシコ、チアパス州沿岸' },
      },
      magnitude: { type: 'マグニチュード', value: '7.4', unit: 'M' },
    },
    comments: {
      forecast: {
        text: '震源の近傍で津波発生の可能性があります。\nこの地震による日本への津波の影響はありません。',
        codes: ['0226', '0230'],
      },
    },
  },
}

describe('遠地地震に関する情報（VXSE53・Head/Title で識別）', () => {
  it('XML: Control/Title ではなく Head/Title を見て 遠地地震 と判定する', () => {
    const quake = parseEarthquakeFromXml('VXSE53', FOREIGN_XML)
    expect(quake).not.toBeNull()
    expect(quake!.issue.type).toBe('遠地地震')
  })

  it('JSON: title で 遠地地震 と判定する', () => {
    expect(parseEarthquake('VXSE53', FOREIGN_JSON)!.issue.type).toBe('遠地地震')
  })

  it('震源名は詳細震央地名を採る', () => {
    expect(parseEarthquakeFromXml('VXSE53', FOREIGN_XML)!.earthquake.hypocenter.name).toBe('メキシコ、チアパス州沿岸')
    expect(parseEarthquake('VXSE53', FOREIGN_JSON)!.earthquake.hypocenter.name).toBe('メキシコ、チアパス州沿岸')
  })

  it('深さ不明は -1 センチネルになる（0＝ごく浅い と区別する）', () => {
    expect(parseEarthquakeFromXml('VXSE53', FOREIGN_XML)!.earthquake.hypocenter.depth).toBe(-1)
    expect(parseEarthquake('VXSE53', FOREIGN_JSON)!.earthquake.hypocenter.depth).toBe(-1)
  })

  it('付加文 0230（日本への津波の影響なし）を津波区分に反映する', () => {
    expect(parseEarthquakeFromXml('VXSE53', FOREIGN_XML)!.earthquake.domesticTsunami).toBe('なし')
    expect(parseEarthquake('VXSE53', FOREIGN_JSON)!.earthquake.domesticTsunami).toBe('なし')
  })

  it('付加文の原文を1行に整形して forecastText に保持する', () => {
    const expected = '震源の近傍で津波発生の可能性があります。この地震による日本への津波の影響はありません。'
    expect(parseEarthquakeFromXml('VXSE53', FOREIGN_XML)!.forecastText).toBe(expected)
    expect(parseEarthquake('VXSE53', FOREIGN_JSON)!.forecastText).toBe(expected)
  })

  it('国内震度を伴わないため maxScale は -1・points は空', () => {
    const quake = parseEarthquake('VXSE53', FOREIGN_JSON)!
    expect(quake.earthquake.maxScale).toBe(-1)
    expect(quake.points).toEqual([])
  })

  it('取消電文でも 遠地地震 と判定する（既存カードと issue.type が一致しないと取消が反映されない）', () => {
    const cancelXml = FOREIGN_XML.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
    const fromXml = parseEarthquakeFromXml('VXSE53', cancelXml)!
    expect(fromXml.cancelled).toBe(true)
    expect(fromXml.issue.type).toBe('遠地地震')

    const fromJson = parseEarthquake('VXSE53', { ...FOREIGN_JSON, infoType: '取消' })!
    expect(fromJson.cancelled).toBe(true)
    expect(fromJson.issue.type).toBe('遠地地震')
  })

  it('規模が欠落した XML は 0 ではなく不明（NaN）として返す', () => {
    const noMag = FOREIGN_XML.replace('<jmx_eb:Magnitude type="M">7.4</jmx_eb:Magnitude>', '<jmx_eb:Magnitude type="M"></jmx_eb:Magnitude>')
    const quake = parseEarthquakeFromXml('VXSE53', noMag)!
    expect(Number.isNaN(quake.earthquake.hypocenter.magnitude)).toBe(true)
  })

  it('付加文コードが複数の Code 要素に分かれていても取りこぼさない', () => {
    // 実電文はスペース区切りで 1 要素にまとまるが、兄弟要素に分割された場合も 0230 を拾う
    const split = FOREIGN_XML.replace('<Code>0226 0230</Code>', '<Code>0226</Code>\n        <Code>0230</Code>')
    expect(parseEarthquakeFromXml('VXSE53', split)!.earthquake.domesticTsunami).toBe('なし')
  })

  it('付加文が無い電文では forecastText を undefined にする', () => {
    const noComments = { ...FOREIGN_JSON, body: { ...FOREIGN_JSON.body, comments: {} } }
    expect(parseEarthquake('VXSE53', noComments)!.forecastText).toBeUndefined()
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

  // 観測波高の「以上」（観測可能範囲の超過）。この 3 件が、カード・地図・読み上げで
  // 「以上」を優先して扱う仕組み（`compareObservedHeightDesc`）の土台になる。
  // → docs/spec/tsunami-spec.md §6「観測波高の「以上」」
  describe('観測波高の over フラグ', () => {
    const withStations = (station: Record<string, unknown>) => ({
      ...baseTsunamiJson,
      body: {
        ...baseTsunamiJson.body,
        tsunami: {
          ...baseTsunamiJson.body.tsunami,
          observations: [{ code: '030', name: '岩手県', stations: [{ name: '宮古', ...station }] }],
        },
      },
    })

    // 正: over=true が読み取られ、description にも「以上」が入る
    it('over=true は over と「以上」付きの description になる', () => {
      const t = parseTsunami('VTSE51', withStations({ maxHeight: { height: { value: '8.5', over: true } } }))
      expect(t!.observations?.[0].height).toEqual({ value: 8.5, description: '8.5m以上', over: true })
    })

    // 対照: over が無い観測点は従来どおり（false ではなく undefined に落ちる）
    it('over 省略時は over が undefined・description に「以上」を付けない', () => {
      const t = parseTsunami('VTSE51', withStations({ maxHeight: { height: { value: '7.2' } } }))
      expect(t!.observations?.[0].height).toEqual({ value: 7.2, description: '7.2m', over: undefined })
    })

    // 安全弁: condition があると description はそちらで確定する（「以上」が落ちうる形）。
    // `overSuffixedHeight`（src/utils/tsunami.ts）がこの形を前提に「数字を含まないなら足さない」判定をしている
    it('condition があれば description はその文字列になる（over は残る）', () => {
      const t = parseTsunami('VTSE51', withStations({ maxHeight: { height: { value: '8.5', condition: '巨大', over: true } } }))
      expect(t!.observations?.[0].height).toEqual({ value: 8.5, description: '巨大', over: true })
    })

    // 安全弁: 波高が数値として読めなければ height ごと落ちる（over も一緒に消える）。
    // 表示・並び順・読み上げのどこにも痕跡が残らないため、警告だけは出ることを固定する
    it('波高が読めなければ height は undefined・over が立っていたら警告を出す', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      try {
        const t = parseTsunami('VTSE51', withStations({ maxHeight: { height: { value: '', over: true } } }))
        expect(t!.observations?.[0].height).toBeUndefined()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('宮古'))
      } finally {
        warn.mockRestore()
      }
    })

    // 対照: over が立っていなければ（単なる欠測）警告は出さない
    it('波高が読めず over も無ければ警告を出さない', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      try {
        parseTsunami('VTSE51', withStations({ maxHeight: { height: { value: '' } } }))
        expect(warn).not.toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })
})

// 長周期地震動観測情報（VXSE62）。Area 直下と City 配下に同名の Name/MaxLgInt があるため
// DMD-6 で xmlChild（直下限定）が正しく Area 直下だけを拾うことを検証する。
const VXSE62_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:eb="http://xml.kishou.go.jp/jmaxml1/body/earthquake1/">
  <Control>
    <Title>長周期地震動に関する観測情報</Title>
    <DateTime>2026-08-13T10:00:00Z</DateTime>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>長周期地震動に関する観測情報</Title>
    <ReportDateTime>2026-08-13T19:00:00+09:00</ReportDateTime>
    <TargetDateTime>2026-08-13T18:58:00+09:00</TargetDateTime>
    <EventID>20260813185800</EventID>
    <Serial>1</Serial>
    <InfoType>発表</InfoType>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
    <Earthquake>
      <OriginTime>2026-08-13T18:58:00+09:00</OriginTime>
    </Earthquake>
    <Intensity xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
      <Observation>
        <MaxLgInt>3</MaxLgInt>
        <Pref>
          <Name>東京都</Name>
          <Code>13</Code>
          <Area>
            <Name>東京都２３区</Name>
            <Code>250</Code>
            <MaxLgInt>3</MaxLgInt>
            <City>
              <Name>千代田区</Name>
              <Code>13101</Code>
              <MaxLgInt>2</MaxLgInt>
            </City>
          </Area>
        </Pref>
      </Observation>
    </Intensity>
  </Body>
</Report>`

describe('parseLpgmFromXml: xmlChild が Area 直下の値を拾い、配下 City の値に引きずられない（DMD-6）', () => {
  it('regions に Area 直下の Name/Code/MaxLgInt が入る', () => {
    const lpgm = parseLpgmFromXml(VXSE62_XML)
    if (!lpgm) throw new Error('parseLpgmFromXml returned null unexpectedly')
    if (lpgm.cancelled) throw new Error('expected発表 but got取消')
    expect(lpgm.regions).toEqual([
      { code: '250', name: '東京都２３区', maxLgInt: 3 },
    ])
  })

  it('取消電文は cancelled=true で返す', () => {
    const cancelXml = VXSE62_XML.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
    const lpgm = parseLpgmFromXml(cancelXml)
    if (!lpgm) throw new Error('parseLpgmFromXml returned null unexpectedly')
    expect(lpgm.cancelled).toBe(true)
  })

  it('MaxLgInt が 0 のときは null（対象階級外）', () => {
    const noClassXml = VXSE62_XML.replace('<MaxLgInt>3</MaxLgInt>\n        <Pref>', '<MaxLgInt>0</MaxLgInt>\n        <Pref>')
    expect(parseLpgmFromXml(noClassXml)).toBeNull()
  })
})

// ─── 南海トラフ関連（VYSE50 臨時情報 / VYSE51・VYSE52 関連解説情報）───────────────
//
// 実電文 14 通（2024年8月の臨時情報・臨時解説、2026年3〜8月の定例解説）で確認した構造に
// 合わせている。要点は **段階のキーワードが Head/Title にしか現れないこと**。
// Head/InfoKind は段階に関わらず「南海トラフ地震に関連する情報」で固定されており、
// そこを判定に使うと全電文が既定値の「調査中」に落ちる（実際にそうなっていた）。

function nankaiXml(opts: {
  title: string
  infoType?: string
  reportDateTime?: string
  body?: string
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>南海トラフ地震臨時情報</Title>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>${opts.title}</Title>
    <ReportDateTime>${opts.reportDateTime ?? '2026-08-20T17:00:00+09:00'}</ReportDateTime>
    <EventID>20260820170000</EventID>
    <InfoType>${opts.infoType ?? '発表'}</InfoType>
    <Serial>1</Serial>
    <InfoKind>南海トラフ地震に関連する情報</InfoKind>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
    <EarthquakeInfo>
      <InfoKind>南海トラフ地震臨時情報</InfoKind>
      <Text>${opts.body ?? '想定震源域内でマグニチュード7.0以上の地震が発生しました。'}</Text>
    </EarthquakeInfo>
  </Body>
</Report>`
}

function commentaryXml(opts: {
  title: string
  serialName: string
  serialCode: string
  reportDateTime?: string
  summary?: string
  body?: string
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>南海トラフ地震関連解説情報</Title>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>${opts.title}</Title>
    <ReportDateTime>${opts.reportDateTime ?? '2026-08-20T17:00:00+09:00'}</ReportDateTime>
    <EventID>20260820170000</EventID>
    <InfoType>発表</InfoType>
    <Serial></Serial>
    <InfoKind>南海トラフ地震に関連する情報</InfoKind>
    <Headline>
      <Text>${opts.summary ?? '評価検討会で南海トラフ周辺の地殻活動を評価しました。'}</Text>
    </Headline>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
    <EarthquakeInfo>
      <InfoKind>南海トラフ地震関連解説情報</InfoKind>
      <InfoSerial codeType="地震関連情報番号コード">
        <Name>${opts.serialName}</Name>
        <Code>${opts.serialCode}</Code>
      </InfoSerial>
      <Text>${opts.body ?? '特段の変化は観測されていません。'}</Text>
      <Appendix>情報発表条件の解説（表示・読み上げの対象外）</Appendix>
    </EarthquakeInfo>
  </Body>
</Report>`
}

describe('parseNankaiFromXml（VYSE50 南海トラフ地震臨時情報）', () => {
  it('巨大地震注意を Head/Title から判定する（Head/InfoKind には現れない）', () => {
    const nankai = parseNankaiFromXml(nankaiXml({ title: '南海トラフ地震臨時情報（巨大地震注意）' }))
    if (!nankai) throw new Error('parseNankaiFromXml returned null unexpectedly')
    expect(nankai.kindName).toBe('巨大地震注意')
    expect(nankai.kindCode).toBe('0202')
    expect(nankai.cancelled).toBe(false)
  })

  it('調査中を判定する', () => {
    const nankai = parseNankaiFromXml(nankaiXml({ title: '南海トラフ地震臨時情報（調査中）' }))
    expect(nankai?.kindName).toBe('調査中')
    expect(nankai?.kindCode).toBe('0201')
  })

  it('巨大地震警戒を判定する', () => {
    const nankai = parseNankaiFromXml(nankaiXml({ title: '南海トラフ地震臨時情報（巨大地震警戒）' }))
    expect(nankai?.kindName).toBe('巨大地震警戒')
    expect(nankai?.kindCode).toBe('0203')
  })

  it('調査終了は cancelled=true（帯を消す条件）', () => {
    const nankai = parseNankaiFromXml(nankaiXml({ title: '南海トラフ地震臨時情報（調査終了）' }))
    expect(nankai?.kindName).toBe('調査終了')
    expect(nankai?.kindCode).toBe('0204')
    expect(nankai?.cancelled).toBe(true)
  })

  it('取消電文は調査終了相当として cancelled=true', () => {
    const nankai = parseNankaiFromXml(nankaiXml({
      title: '南海トラフ地震臨時情報（巨大地震注意）',
      infoType: '取消',
    }))
    expect(nankai?.cancelled).toBe(true)
    expect(nankai?.kindName).toBe('調査終了')
  })

  it('本文（Body/Text）を body に取り込む', () => {
    const nankai = parseNankaiFromXml(nankaiXml({
      title: '南海トラフ地震臨時情報（調査中）',
      body: 'テスト本文',
    }))
    expect(nankai?.body).toBe('テスト本文')
  })

  it('解説情報を渡すと null（段階を「調査中」と騙らない）', () => {
    const xml = commentaryXml({
      title: '南海トラフ地震関連解説情報（第１号）',
      serialName: '臨時解説',
      serialCode: '210',
    })
    expect(parseNankaiFromXml(xml)).toBeNull()
  })
})

describe('parseNankaiCommentaryFromXml（VYSE51/52 南海トラフ地震関連解説情報）', () => {
  it('臨時解説を InfoSerial から判定し、要約と本文を分けて取る', () => {
    const commentary = parseNankaiCommentaryFromXml(commentaryXml({
      title: '南海トラフ地震関連解説情報（第１号）',
      serialName: '臨時解説',
      serialCode: '210',
      summary: '要約テキスト',
      body: '本文テキスト',
    }))
    if (!commentary) throw new Error('parseNankaiCommentaryFromXml returned null unexpectedly')
    expect(commentary.serialName).toBe('臨時解説')
    expect(commentary.serialCode).toBe('210')
    expect(commentary.headline).toBe('南海トラフ地震関連解説情報（第１号）')
    expect(commentary.summary).toBe('要約テキスト')
    // Appendix（情報発表条件の定型解説）を本文に巻き込まないこと
    expect(commentary.body).toBe('本文テキスト')
  })

  it('定例解説を判定する', () => {
    const commentary = parseNankaiCommentaryFromXml(commentaryXml({
      title: '南海トラフ地震関連解説情報',
      serialName: '定例解説',
      serialCode: '200',
    }))
    expect(commentary?.serialName).toBe('定例解説')
    expect(commentary?.serialCode).toBe('200')
  })

  it('expireAt は発表から7日後', () => {
    const commentary = parseNankaiCommentaryFromXml(commentaryXml({
      title: '南海トラフ地震関連解説情報',
      serialName: '定例解説',
      serialCode: '200',
      reportDateTime: '2026-08-20T17:00:00+09:00',
    }))
    // 2026-08-20T17:00+09:00 = 08-20T08:00Z なので +7日は 08-27T08:00Z
    expect(commentary?.expireAt).toBe('2026-08-27T08:00:00.000Z')
  })

  it('Serial が空でも id を組み立てられる（実電文の定例解説は空）', () => {
    const commentary = parseNankaiCommentaryFromXml(commentaryXml({
      title: '南海トラフ地震関連解説情報',
      serialName: '定例解説',
      serialCode: '200',
    }))
    expect(commentary?.id).toBe('dmdata-xml-nankai-commentary-20260820170000-1')
  })

  it('臨時情報を渡すと null（段階を持つ電文はこちらで扱わない）', () => {
    const xml = nankaiXml({ title: '南海トラフ地震臨時情報（巨大地震注意）' })
    expect(parseNankaiCommentaryFromXml(xml)).toBeNull()
  })

  it('発表日時が日時として読めなければ null（期限計算が壊れるため）', () => {
    const xml = commentaryXml({
      title: '南海トラフ地震関連解説情報',
      serialName: '定例解説',
      serialCode: '200',
      reportDateTime: 'not-a-date',
    })
    expect(parseNankaiCommentaryFromXml(xml)).toBeNull()
  })

  it('InfoSerial/Name が無ければ既定名「解説情報」で通す（コード表は非公開のため）', () => {
    const xml = commentaryXml({
      title: '南海トラフ地震関連解説情報',
      serialName: '',
      serialCode: '',
    })
    expect(parseNankaiCommentaryFromXml(xml)?.serialName).toBe('解説情報')
  })

  it('取消電文は cancelled=true で返す（null にすると解析失敗と区別できない）', () => {
    const xml = commentaryXml({
      title: '南海トラフ地震関連解説情報',
      serialName: '定例解説',
      serialCode: '200',
    }).replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
    const commentary = parseNankaiCommentaryFromXml(xml)
    if (!commentary) throw new Error('parseNankaiCommentaryFromXml returned null unexpectedly')
    expect(commentary.cancelled).toBe(true)
  })

  it('発表電文は cancelled=false', () => {
    const commentary = parseNankaiCommentaryFromXml(commentaryXml({
      title: '南海トラフ地震関連解説情報',
      serialName: '定例解説',
      serialCode: '200',
    }))
    expect(commentary?.cancelled).toBe(false)
  })

  // 実電文では Appendix は本文 Text より後ろに来る。文書順で本文が先に当たるため、
  // このテストは本文抽出を EarthquakeInfo 直下に絞る前の実装でも通る（回帰検出力は無い）。
  // 構造が変わって Appendix が Text 要素を持ったときに本文が壊れないことの確認として残す。
  // 抽出範囲を絞ったこと自体は次の「EarthquakeInfo より前に別の Text がある構造」で検証する。
  it('Appendix が Text 要素を持つ構造でも本文を取れる', () => {
    const xml = commentaryXml({
      title: '南海トラフ地震関連解説情報',
      serialName: '定例解説',
      serialCode: '200',
      body: '本文テキスト',
    }).replace(
      '<Appendix>情報発表条件の解説（表示・読み上げの対象外）</Appendix>',
      '<Appendix><Text>付録の定型解説</Text></Appendix>',
    )
    expect(parseNankaiCommentaryFromXml(xml)?.body).toBe('本文テキスト')
  })

  it('EarthquakeInfo より前に別の Text がある構造でも本文を取り違えない', () => {
    // Body 全体から最初の Text を拾う実装だと、ここで別セクションの文を本文として掴む
    const xml = commentaryXml({
      title: '南海トラフ地震関連解説情報',
      serialName: '定例解説',
      serialCode: '200',
      body: '本文テキスト',
    }).replace('<EarthquakeInfo>', '<Comments><Text>別セクションの文</Text></Comments><EarthquakeInfo>')
    expect(parseNankaiCommentaryFromXml(xml)?.body).toBe('本文テキスト')
  })
})
