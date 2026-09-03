// @vitest-environment jsdom
// parseEarthquakeFromXml（REST 履歴経路）のテスト。
// DOMParser を使うためこのファイルだけ jsdom 環境で動かす（既定は node）。
import { describe, it, expect, vi } from 'vitest'
import { parseEarthquake, parseEarthquakeFromXml, parseEEW, parseTsunami, parseTsunamiFromXml, parseLpgm, parseLpgmFromXml, parseNankaiFromXml, parseNankaiCommentaryFromXml } from './dmdataParser'
import { log } from '../utils/logger'
import { hasKnownEpicenter } from '../utils/geo'

// 震度速報（VXSE51）。震源が未確定の段階で出るため Earthquake 要素を持たず、
// 震度は Pref > Area（一次細分区域）までしか無い。
const VXSE51_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>震度速報</Title>
    <DateTime>2026-08-08T18:00:00Z</DateTime>
    <Status>通常</Status>
    <EditorialOffice>気象庁本庁</EditorialOffice>
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
    <Status>通常</Status>
    <EditorialOffice>気象庁本庁</EditorialOffice>
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

// VXSE53_XML と同じ地震を JSON 版で表したもの。両パーサーの結果を突き合わせるために対で持つ。
// 実電文の Control は EditorialOffice（気象庁本庁）と PublishingOffice（気象庁）の両方を持ち、
// JSON 経路は前者を優先するため、発表元は「気象庁本庁」になる。
const VXSE53_JSON = {
  type: '震源・震度に関する情報',
  title: '震源・震度に関する情報',
  eventId: '20260809025800',
  serialNo: '1',
  infoType: '発表',
  editorialOffice: '気象庁本庁',
  publishingOffice: '気象庁',
  reportDateTime: '2026-08-09T03:02:00+09:00',
  targetDateTime: '2026-08-09T02:58:00+09:00',
  body: {
    earthquake: {
      originTime: '2026-08-09T02:58:00+09:00',
      arrivalTime: '2026-08-09T02:58:00+09:00',
      hypocenter: {
        name: '岩手県沖',
        coordinate: { latitude: { value: '39.9' }, longitude: { value: '142.2' } },
        depth: { value: '50' },
      },
      magnitude: { value: '5.1' },
    },
    intensity: {
      maxInt: '4',
      prefectures: [{ code: '03', name: '岩手県', maxInt: '4' }],
      regions: [{ code: '221', name: '岩手県沿岸北部', maxInt: '4' }],
      stations: [{ code: '3350631', name: '普代村銅屋', int: '3' }],
    },
  },
}

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

  // 都道府県ロールアップ点（pref 付き）を含む。以前は XML 経路だけこれを落としていたため、
  // EarthquakeCard が区域点からの逆引き集計に落ち、区域の震度が揃わない県では
  // 気象庁発表の代表値と粒度がずれていた（JSON 経路の intensity.prefectures[] に対応する）。
  it('points は都道府県ロールアップ点と一次細分区域を持ち、区域の pref は空にする', () => {
    const points = parseEarthquakeFromXml('VXSE51', VXSE51_XML)!.points
    expect(points).toEqual([
      { pref: '岩手県', addr: '岩手県', isArea: true, scale: 40 },
      { pref: '', addr: '岩手県沿岸北部', isArea: true, scale: 40 },
      { pref: '', addr: '岩手県内陸北部', isArea: true, scale: 30 },
    ])
  })
})

describe('parseEarthquakeFromXml: 震源・震度に関する情報（VXSE53）', () => {
  it('区域と観測点の両方を points に持つ', () => {
    const points = parseEarthquakeFromXml('VXSE53', VXSE53_XML)!.points
    // 都道府県ロールアップ点も isArea: true なので、区域は pref が空であることで見分ける
    expect(points.filter(p => p.isArea && p.pref === '')).toHaveLength(1)
    expect(points.filter(p => !p.isArea)).toHaveLength(1)
  })

  it('区域の震度は Area 直下の MaxInt を採り、配下 City の値に引きずられない', () => {
    const points = parseEarthquakeFromXml('VXSE53', VXSE53_XML)!.points
    // 都道府県ロールアップ点（pref 付き）と取り違えないよう pref が空のものを探す
    const area = points.find(p => p.isArea && p.pref === '')!
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

  // 自由付加文は遠地地震専用ではない。国内地震にも付く
  // （実例: 2026-06-08 フィリピン付近 M8.2 に伴う津波注意報の発表中に起きた国内地震）
  it('国内地震の電文でも自由付加文を freeText に持つ', () => {
    const free = 'なお、茨城県から沖縄県地方にかけての太平洋側を中心に津波注意報を発表中です。'
    const xml = VXSE53_XML.replace('</Body>', `  <Comments>
      <FreeFormComment>${free}</FreeFormComment>
    </Comments>
  </Body>`)
    expect(parseEarthquakeFromXml('VXSE53', xml)!.freeText).toBe(free)
  })
})

// JSON 経路（parseEarthquake）: infoType の訂正フラグが握り潰されないことを確認する。
// 従来は correct を 'なし' 固定にしていて、UI での「訂正」バッジ表示が発火しなかった。
// 同じ地震を JSON 版と XML 版で読み、結果を突き合わせる。
//
// XML 経路は REST の個別電文取得（fetchOneTelegram）だけが通る道で、これは起動時の初期履歴表示と
// 「もっと見る」が叩く。つまり **同じ地震でも、履歴で読み込まれたかライブで受信したかで中身が
// 変わりうる**。片方だけが埋めるフィールドを作らないよう、対で検証する。
//
// この describe は「両経路が揃っていること」だけを見る。片方にしか無い挙動（JSON の訂正フラグ等）は
// それぞれの describe で扱う。
describe('地震: JSON 経路と XML 経路の読み取り一致', () => {
  const fromJson = () => parseEarthquake('VXSE53', VXSE53_JSON)!
  const fromXml = () => parseEarthquakeFromXml('VXSE53', VXSE53_XML)!

  // 正: eventId を「フィールドとして」持つ。id 文字列には両経路とも埋め込まれているが、
  // TsunamiTab は q.eventId を直接比較して原因地震カードへのリンクを作るため、
  // フィールドが無いと津波バナーからのリンクが引き当たらない。
  it('eventId をフィールドとして持つ', () => {
    expect(fromJson().eventId).toBe('20260809025800')
    expect(fromXml().eventId).toBe('20260809025800')
  })

  // 正: 都道府県ロールアップ点（pref 付き）。実電文の Pref 直下には MaxInt があり
  // （能登半島地震の震度速報で <Pref><Name>石川県</Name><Code>17</Code><MaxInt>5+</MaxInt> を確認）、
  // JSON 経路は intensity.prefectures[] として同じ値を受け取る。
  // これが無いと EarthquakeCard は区域点からの逆引き集計に落ち、気象庁発表の代表値と粒度がずれる。
  it('都道府県ロールアップ点（pref 付き）を持つ', () => {
    const expected = { pref: '岩手県', addr: '岩手県', isArea: true, scale: 40 }
    expect(fromJson().points).toContainEqual(expected)
    expect(fromXml().points).toContainEqual(expected)
  })

  it('区域点は pref を空にする', () => {
    const expected = { pref: '', addr: '岩手県沿岸北部', isArea: true, scale: 40 }
    expect(fromJson().points).toContainEqual(expected)
    expect(fromXml().points).toContainEqual(expected)
  })

  // QUAKE-2: 観測点の pref を空にする規約。以前 XML 側だけ pref: prefName を付けていて、
  // EarthquakeCard が観測点値を都道府県別最大震度と誤解する不具合があった。
  it('観測点は pref を空にする（QUAKE-2）', () => {
    const expected = { pref: '', addr: '普代村銅屋', isArea: false, scale: 30 }
    expect(fromJson().points).toContainEqual(expected)
    expect(fromXml().points).toContainEqual(expected)
  })

  // 安全弁: 都道府県点を足しても区域点・観測点の数は変わらない。
  // Pref 直下の MaxInt を Area としても数えると、区域点が二重になる。
  it('点の内訳は都道府県1・区域1・観測点1', () => {
    for (const q of [fromJson(), fromXml()]) {
      expect(q.points.filter(p => p.pref !== '')).toHaveLength(1)
      expect(q.points.filter(p => p.pref === '' && p.isArea)).toHaveLength(1)
      expect(q.points.filter(p => !p.isArea)).toHaveLength(1)
    }
  })

  // issue.source は現状どのコンポーネントからも読まれないが、両経路で同じ値になる状態を保つ。
  // XML 側を '気象庁' 固定にすると、電文が持つ編集官署（実電文では「気象庁本庁」）が落ちる。
  it('issue.source を電文の編集官署から読む', () => {
    expect(fromJson().issue.source).toBe('気象庁本庁')
    expect(fromXml().issue.source).toBe('気象庁本庁')
  })

  // 対照: 編集官署が無い電文では発表官署へ落ちる（両経路とも同じ順序で解決する）。
  // 値を「気象庁」以外にしておくのは、フォールバックが効いたのか元の固定値が残ったのかを
  // 区別するため（両方とも「気象庁」だと、実装を固定値へ戻してもこのテストが通ってしまう）。
  it('編集官署が無ければ発表官署を使う', () => {
    const json = { ...VXSE53_JSON, editorialOffice: undefined, publishingOffice: '大阪管区気象台' }
    expect(parseEarthquake('VXSE53', json)!.issue.source).toBe('大阪管区気象台')
    const xml = VXSE53_XML
      .replace('<EditorialOffice>気象庁本庁</EditorialOffice>', '')
      .replace('<PublishingOffice>気象庁</PublishingOffice>', '<PublishingOffice>大阪管区気象台</PublishingOffice>')
    expect(parseEarthquakeFromXml('VXSE53', xml)!.issue.source).toBe('大阪管区気象台')
  })
  // 取消電文も eventId を持つ。同一性判定（sameQuakeEntry・coalesceByEventId）はどれも
  // id 文字列から 14 桁を抜く extractQuakeEventId を通るため、このフィールドの有無で挙動は
  // 変わらない。通常報と形を揃えておくのは、次にこのフィールドを使うコードが
  // 「取消だけ持たない」ことを知らずに取りこぼすのを防ぐため。
  it('取消電文でも eventId をフィールドとして持つ', () => {
    const json = { ...VXSE53_JSON, infoType: '取消' }
    expect(parseEarthquake('VXSE53', json)!.eventId).toBe('20260809025800')
    const xml = VXSE53_XML.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
    expect(parseEarthquakeFromXml('VXSE53', xml)!.eventId).toBe('20260809025800')
  })

  // 安全弁: eventId を足したことで取消の判定そのものは変わらない
  it('取消電文は cancelled=true のまま', () => {
    const json = { ...VXSE53_JSON, infoType: '取消' }
    expect(parseEarthquake('VXSE53', json)!.cancelled).toBe(true)
    const xml = VXSE53_XML.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
    expect(parseEarthquakeFromXml('VXSE53', xml)!.cancelled).toBe(true)
  })

})

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

  // 自由付加文（Comments/FreeFormComment）。固定付加文が津波区分ごとの定型文であるのに対し、
  // こちらは電文ごとに書き起こされる本文で、**続報での更新はこちらにしか現れないことがある**。
  // 実例: 2026-08-25 のアンバエ火山噴火に伴う遠地地震情報は全 4 報で震源要素も固定付加文も
  // 同一で、潮位変化の観測状況と次報の予定時刻だけが自由付加文で更新された。
  describe('自由付加文（FreeFormComment）', () => {
    const withFree = (free: string) => ({
      ...FOREIGN_JSON,
      body: { ...FOREIGN_JSON.body, comments: { ...FOREIGN_JSON.body.comments, free } },
    })
    const xmlWithFree = (free: string) =>
      FOREIGN_XML.replace('</ForecastComment>', `</ForecastComment>
      <FreeFormComment>${free}</FreeFormComment>`)

    it('改行を保ったまま freeText に持つ（JSON・XML 両経路）', () => {
      const free = `現在、海外および国内の観測点で有意な潮位変化は観測されていません。
次の遠地地震に関する情報は、２６日０２時３０分頃に発表の予定です。`
      expect(parseEarthquake('VXSE53', withFree(free))!.freeText).toBe(free)
      expect(parseEarthquakeFromXml('VXSE53', xmlWithFree(free))!.freeText).toBe(free)
    })

    // 実例: 2026-06-08 フィリピン付近 M8.2 の第 2 報以降は、検潮所ごとの最大波の高さが
    // 全角スペース整形の表で入る。1 行へ潰すと列が崩れるため forecastText のような整形はしない
    it('全角スペースで整形された表を崩さない', () => {
      const table = `国・地域名　　　検潮所名　　　これまでの最大波の高さ
フィリピン　　　ダバオ　　　　０．４６ｍ`
      expect(parseEarthquake('VXSE53', withFree(table))!.freeText).toBe(table)
      expect(parseEarthquakeFromXml('VXSE53', xmlWithFree(table))!.freeText).toBe(table)
    })

    // 対照: 大半の遠地地震は自由付加文を持たない（4 か月 6 事象のうち 2 事象は空）
    it('自由付加文が無ければ freeText は undefined', () => {
      expect(parseEarthquake('VXSE53', FOREIGN_JSON)!.freeText).toBeUndefined()
      expect(parseEarthquakeFromXml('VXSE53', FOREIGN_XML)!.freeText).toBeUndefined()
    })
  })

  // 火山の大規模噴火に伴う遠地地震情報で使われるコード。対応表から漏らすと津波区分が
  // '不明' へ落ち、調査中であることがカードにも読み上げにも出ない（灰色の「不明」になる）
  it('付加文 0229（日本への津波の有無は調査中）を 調査中 として扱う', () => {
    const json = {
      ...FOREIGN_JSON,
      body: {
        ...FOREIGN_JSON.body,
        comments: { forecast: { text: '日本への津波の有無については現在調査中です。', codes: ['0229'] } },
      },
    }
    expect(parseEarthquake('VXSE53', json)!.earthquake.domesticTsunami).toBe('調査中')

    const xml = FOREIGN_XML.replace('<Code>0226 0230</Code>', '<Code>0229</Code>')
    expect(parseEarthquakeFromXml('VXSE53', xml)!.earthquake.domesticTsunami).toBe('調査中')
  })

  // 安全弁: 0228 は「一般的に、この規模の地震が海域の浅い領域で発生すると…」という一般論で、
  // 日本国内への影響区分ではない。区分に写さないのは 022x 系と同じだが、既知として扱わないと
  // 単独で届いたときに「導出できません」の警告が出る（正常系で鳴らすと警告の価値が下がる）
  it('付加文 0228 単独は区分に写さないが警告も出さない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const json = {
        ...FOREIGN_JSON,
        body: {
          ...FOREIGN_JSON.body,
          comments: {
            forecast: {
              text: '一般的に、この規模の地震が海域の浅い領域で発生すると、津波が発生することがあります。',
              codes: ['0228'],
            },
          },
        },
      }
      expect(parseEarthquake('VXSE53', json)!.earthquake.domesticTsunami).toBe('不明')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  // 安全弁: 既知のコードと未知のコードが同居しても、未知の側を取りこぼさない。
  // 「1 つでも既知なら黙る」判定にすると、022x 系が頻出する遠地地震で構造の変化を丸ごと見逃す
  it('既知の 0228 と未知のコードが同居したら未知の側だけを警告する', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const json = {
        ...FOREIGN_JSON,
        body: {
          ...FOREIGN_JSON.body,
          comments: { forecast: { text: '一般的に、この規模の地震が…。', codes: ['0228', '9999'] } },
        },
      }
      expect(parseEarthquake('VXSE53', json)!.earthquake.domesticTsunami).toBe('不明')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('9999'))
      // 既知のコードは警告文に載せない（読む側が未知のコードだけを見て判断できるように）
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('0228'))
    } finally {
      warn.mockRestore()
    }
  })

  // 対照: 本当に知らないコードだけが届いたときは従来どおり警告を出す（電文構造の変化を検知する）
  it('未知の付加文コードだけなら警告を出す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const json = {
        ...FOREIGN_JSON,
        body: {
          ...FOREIGN_JSON.body,
          comments: { forecast: { text: '将来足されるかもしれない付加文。', codes: ['9999'] } },
        },
      }
      expect(parseEarthquake('VXSE53', json)!.earthquake.domesticTsunami).toBe('不明')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('導出できません'))
    } finally {
      warn.mockRestore()
    }
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

  // **座標は -200（位置不明センチネル）で埋める。0 にしてはならない** ——0 はギニア湾沖の有効な
  // 座標として `hasKnownEpicenter` を通り、地図に震源×印を立てうる。いまは取消済みの EEW が
  // `cancelledAt` で先に除かれるため表に出ないが、二重防御の奥が壊れた状態を残さない。
  // 他の経路（VXSE51・震度速報・p2pquake の COORD_UNKNOWN）と同じ値に揃えてある。
  it('isCanceled=true は cancelled 電文（座標は位置不明センチネル・areas 空・VXSE43 は severity=Warning 保持）', () => {
    const cancelJson = { ...baseEEWJson, body: { ...baseEEWJson.body, isCanceled: true } }
    const eew = parseEEW('VXSE43', cancelJson)
    expect(eew).not.toBeNull()
    expect(eew!.cancelled).toBe(true)
    expect(eew!.earthquake.hypocenter.latitude).toBe(-200)
    expect(eew!.earthquake.hypocenter.longitude).toBe(-200)
    expect(hasKnownEpicenter(eew!.earthquake.hypocenter.latitude, eew!.earthquake.hypocenter.longitude)).toBe(false)
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

  // to='over' は「上限を定めない」。震度7と読むと、下限しか決まっていない報（仮定震源要素の
  // 初報など）が最大震度7として塗られ・読み上げられる。2024/1/1 16:18 の余震の初報が
  // 実際にこの形（石川県能登 from='4' / to='over'）で、震度7の警戒色が能登一帯に出ていた。
  describe("予想震度の to='over'（上限なし）", () => {
    function withIntensity(intensity: Record<string, unknown>) {
      return parseEEW('VXSE45', { ...baseEEWJson, body: { ...baseEEWJson.body, intensity } })!
    }

    it('電文全体は from に寄せ、「以上」をフラグで持つ', () => {
      const eew = withIntensity({ forecastMaxInt: { from: '4', to: 'over' } })
      expect(eew.forecastMaxScale).toBe(40)
      expect(eew.forecastMaxScaleOrAbove).toBe(true)
    })

    it('地域別も from に寄せ、「以上」をフラグで持つ', () => {
      const eew = withIntensity({
        forecastMaxInt: { from: '4', to: 'over' },
        regions: [{ code: '390', name: '石川県能登', forecastMaxInt: { from: '4', to: 'over' }, kind: { code: '09' } }],
      })
      expect(eew.areas).toEqual([
        { pref: '', name: '石川県能登', scaleFrom: 40, scaleTo: 40, scaleToOrAbove: true, kindCode: '09', arrivalTime: null, lgIntTo: undefined },
      ])
    })

    it('上限が定まっている報には「以上」を立てない（境界の手前）', () => {
      const eew = withIntensity({
        forecastMaxInt: { from: '6-', to: '7' },
        regions: [{ code: '390', name: '石川県能登', forecastMaxInt: { from: '6-', to: '7' }, kind: { code: '11' } }],
      })
      expect(eew.forecastMaxScale).toBe(70)
      expect(eew.forecastMaxScaleOrAbove).toBeUndefined()
      expect(eew.areas![0].scaleTo).toBe(70)
      expect(eew.areas![0].scaleToOrAbove).toBeUndefined()
    })

    it('from が無い over は「以上」を立てない（「不明以上」は意味を成さない）', () => {
      const eew = withIntensity({
        forecastMaxInt: { to: 'over' },
        regions: [{ code: '390', name: '石川県能登', forecastMaxInt: { to: 'over' }, kind: { code: '09' } }],
      })
      expect(eew.forecastMaxScale).toBeUndefined()
      expect(eew.forecastMaxScaleOrAbove).toBeUndefined()
      expect(eew.areas![0].scaleTo).toBe(-1)
      expect(eew.areas![0].scaleToOrAbove).toBeUndefined()
    })

    // over 以外の値の扱いは変えない。ここを from へ落とすと、上限が不明な報の震度が
    // 下限の値で出るようになる（over の修正に紛れて別の挙動が変わる）。
    it('to が読めない値なら from があっても不明のまま（over 以外の挙動は据え置き）', () => {
      const eew = withIntensity({
        forecastMaxInt: { from: '4', to: '不明' },
        regions: [{ code: '390', name: '石川県能登', forecastMaxInt: { from: '4', to: '不明' }, kind: { code: '09' } }],
      })
      expect(eew.forecastMaxScale).toBeUndefined()
      expect(eew.areas![0].scaleTo).toBe(-1)
      expect(eew.areas![0].scaleFrom).toBe(40)
      expect(eew.areas![0].scaleToOrAbove).toBeUndefined()
    })

    it('to が空なら from を上限として採る（従来どおり）', () => {
      const eew = withIntensity({
        forecastMaxInt: { from: '5+' },
        regions: [{ code: '390', name: '石川県能登', forecastMaxInt: { from: '5+' }, kind: { code: '11' } }],
      })
      expect(eew.forecastMaxScale).toBe(50)
      expect(eew.areas![0].scaleTo).toBe(50)
      expect(eew.areas![0].scaleToOrAbove).toBeUndefined()
    })

    it('取消電文では「以上」を残さない（areas も空になる）', () => {
      const eew = parseEEW('VXSE43', {
        ...baseEEWJson,
        body: { ...baseEEWJson.body, isCanceled: true, intensity: { forecastMaxInt: { from: '4', to: 'over' } } },
      })!
      expect(eew.forecastMaxScale).toBeUndefined()
      expect(eew.forecastMaxScaleOrAbove).toBeUndefined()
      expect(eew.areas).toEqual([])
    })
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

    // 安全弁: 波高の condition（観測点に現れるのは「上昇中」）で数値を潰さない。
    // **以前はここで description が condition の文字列に置き換わっていた**（「以上」も数値も落ちた）。
    // 状態は `condition` 側が持つので、description は数値だけで組む
    it('波高の condition があっても description は数値のまま（状態は condition へ）', () => {
      const t = parseTsunami('VTSE51', withStations({ maxHeight: { height: { value: '8.5', condition: '上昇中', over: true } } }))
      expect(t!.observations?.[0].height).toEqual({ value: 8.5, description: '8.5m以上', over: true })
      expect(t!.observations?.[0].condition).toEqual({ rising: true })
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

// 長周期地震動: JSON 経路と XML 経路の読み取り一致。
//
// この対を置くまで、JSON 側の parseLpgm にはテストが 1 件も存在しなかった（XML 側は上記
// DMD-6 のみ）。両方を同じ電文で突き合わせる場所が無かったため、片方だけ触っても気づけない。
//
// フィクスチャは実電文（2024-01-01 能登半島地震の長周期地震動に関する観測情報）の構造に
// 合わせている。要点は 3 つ:
//   - Pref / Area 直下に MaxInt（震度）と MaxLgInt（長周期階級）が併存する
//   - IntensityStation は Int / LgInt に加えて LgIntPerPeriod（帯域別・複数）を持つ
//   - 観測点名に県名が入らない（例「上越市中ノ俣」）。JSON 側は県略称込み（例「新潟上越市中ノ俣」）
const PARITY_LPGM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
  <Control>
    <Title>長周期地震動に関する観測情報</Title>
    <DateTime>2026-08-13T10:00:00Z</DateTime>
    <Status>通常</Status>
    <EditorialOffice>気象庁本庁</EditorialOffice>
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
    <Intensity>
      <Observation>
        <MaxLgInt>2</MaxLgInt>
        <Pref>
          <Name>新潟県</Name>
          <Code>15</Code>
          <MaxInt>3</MaxInt>
          <MaxLgInt>2</MaxLgInt>
          <Area>
            <Name>新潟県上越</Name>
            <Code>370</Code>
            <MaxInt>3</MaxInt>
            <MaxLgInt>2</MaxLgInt>
            <IntensityStation>
              <Name>上越市中ノ俣</Name>
              <Code>1522201</Code>
              <Int>3</Int>
              <LgInt>2</LgInt>
              <LgIntPerPeriod PeriodicBand="1" PeriodUnit="秒台">2</LgIntPerPeriod>
              <LgIntPerPeriod PeriodicBand="2" PeriodUnit="秒台">2</LgIntPerPeriod>
            </IntensityStation>
          </Area>
        </Pref>
      </Observation>
    </Intensity>
  </Body>
</Report>`

// 上の XML と同じ電文を JSON 版で表したもの。観測点名は DMDATA の JSON スキーマどおり
// 県略称を含む形式で入る（parseLpgm のコメント参照）。
const PARITY_LPGM_JSON = {
  eventId: '20260813185800',
  serialNo: '1',
  infoType: '発表',
  reportDateTime: '2026-08-13T19:00:00+09:00',
  editorialOffice: '気象庁本庁',
  publishingOffice: '気象庁',
  body: {
    earthquake: { originTime: '2026-08-13T18:58:00+09:00' },
    intensity: {
      maxLgInt: '2',
      regions: [{ code: '370', name: '新潟県上越', maxLgInt: '2' }],
      stations: [{ code: '1522201', name: '新潟上越市中ノ俣', lgInt: '2' }],
    },
  },
}

describe('長周期地震動: JSON 経路と XML 経路の読み取り一致', () => {
  const fromJson = () => parseLpgm(PARITY_LPGM_JSON)!
  const fromXml = () => parseLpgmFromXml(PARITY_LPGM_XML)!

  it('eventId・発表時刻・震源時刻・最大階級を同じに読む', () => {
    for (const l of [fromJson(), fromXml()]) {
      expect(l.eventId).toBe('20260813185800')
      expect(l.time).toBe('2026-08-13T19:00:00+09:00')
      expect(l.originTime).toBe('2026-08-13T18:58:00+09:00')
      expect(l.maxClass).toBe(2)
      expect(l.cancelled).toBe(false)
    }
  })

  it('区域別の最大階級を同じに読む', () => {
    for (const l of [fromJson(), fromXml()]) {
      expect(l.regions).toEqual([{ code: '370', name: '新潟県上越', maxLgInt: 2 }])
    }
  })

  it('観測点のコードと階級を同じに読む', () => {
    for (const l of [fromJson(), fromXml()]) {
      expect(l.points).toHaveLength(1)
      expect(l.points![0].code).toBe('1522201')
      expect(l.points![0].lgInt).toBe(2)
    }
  })

  // 意図的な差: 観測点の pref と name は経路で異なる。電文自体の構造が違うためで、
  // 揃えようとすると片方の情報を捨てることになる。
  //   - XML: 観測点名に県名が入らないので、Pref/Name から都道府県を補って pref に持つ
  //   - JSON: 観測点名が県略称込みなので pref は空。座標解決は JapanMap の stationPrefIndex が行う
  // types/earthquake.ts の LpgmPoint.pref のコメントがこの差を定めている。
  it('観測点の pref と name は電文構造の差をそのまま残す', () => {
    expect(fromXml().points![0]).toEqual({ code: '1522201', name: '上越市中ノ俣', pref: '新潟県', lgInt: 2 })
    expect(fromJson().points![0]).toEqual({ code: '1522201', name: '新潟上越市中ノ俣', pref: '', lgInt: 2 })
  })

  it('取消電文は両経路とも cancelled=true で返す', () => {
    const xml = PARITY_LPGM_XML.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
    expect(parseLpgmFromXml(xml)!.cancelled).toBe(true)
    expect(parseLpgm({ ...PARITY_LPGM_JSON, infoType: '取消' })!.cancelled).toBe(true)
  })

  // 対照: 対象階級（1〜4）の外は両経路とも null。階級 0 は「長周期地震動なし」であって
  // 「階級 0 の観測」ではないため、イベントとして立てない。
  it('最大階級が対象外なら両経路とも null', () => {
    const xml = PARITY_LPGM_XML.replace('<MaxLgInt>2</MaxLgInt>\n        <Pref>', '<MaxLgInt>0</MaxLgInt>\n        <Pref>')
    expect(parseLpgmFromXml(xml)).toBeNull()
    const json = structuredClone(PARITY_LPGM_JSON)
    json.body.intensity.maxLgInt = '0'
    expect(parseLpgm(json)).toBeNull()
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

  // 正: 取消は「その電文の撤回」でしかない。**以前は「調査終了」に化かしていた**（気象庁が
  // 発表していない「可能性は通常の範囲内」という判断を、アプリが作っていた）
  it('取消電文は retracted=true。調査終了を名乗らない', () => {
    const nankai = parseNankaiFromXml(nankaiXml({
      title: '南海トラフ地震臨時情報（巨大地震注意）',
      infoType: '取消',
    }))
    expect(nankai?.retracted).toBe(true)
    expect(nankai?.cancelled).toBe(true)   // 帯を引っ込める点は調査終了と同じ
    expect(nankai?.kindName).not.toBe('調査終了')
    expect(nankai?.kindCode).not.toBe('0204')
  })

  // 対照: 本物の調査終了は retracted を立てない（名乗りも従来どおり）
  it('調査終了は retracted を立てない', () => {
    const nankai = parseNankaiFromXml(nankaiXml({ title: '南海トラフ地震臨時情報（調査終了）' }))
    expect(nankai?.retracted).toBeFalsy()
    expect(nankai?.kindName).toBe('調査終了')
  })

  // 安全弁: 取消の理由（資料が Body/Text と定めている）を捨てない
  it('取消の理由を body に取り込む', () => {
    const nankai = parseNankaiFromXml(nankaiXml({
      title: '南海トラフ地震臨時情報（巨大地震注意）',
      infoType: '取消',
      body: 'システム障害のため取り消します。',
    }))
    expect(nankai?.body).toBe('システム障害のため取り消します。')
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

// 津波: JSON 経路と XML 経路の読み取り一致。
//
// XML 経路は REST 履歴取得（fetchDmdataTsunamis）だけが通る道で、起動時に直近の津波を読み込む。
// 進行中の津波がある状態でアプリを開くと、まずこちらが画面とカードを作る。
//
// フィクスチャは実電文（2024-01-01 能登半島地震の津波情報a）の構造に合わせている。
// 実電文の TsunamiHeight は type / unit / description の 3 属性を持ち、description は全角
// （「０．５ｍ」）で入る。観測点の Station は Observation > Item > Area の下に並ぶ。
const PARITY_TSUNAMI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
  <Control>
    <Title>津波情報a</Title>
    <DateTime>2026-01-01T03:05:00Z</DateTime>
    <Status>通常</Status>
    <EditorialOffice>気象庁本庁</EditorialOffice>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>津波情報</Title>
    <ReportDateTime>2026-01-01T12:05:00+09:00</ReportDateTime>
    <EventID>20260101120000</EventID>
    <InfoType>発表</InfoType>
    <Serial>1</Serial>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
    <Tsunami>
      <Forecast>
        <Item>
          <Area><Name>関東</Name><Code>350</Code></Area>
          <Category>
            <Kind><Name>大津波警報：発表</Name><Code>52</Code></Kind>
          </Category>
          <FirstHeight>
            <ArrivalTime>2026-01-01T12:30:00+09:00</ArrivalTime>
            <Condition>ただちに津波来襲と予測</Condition>
          </FirstHeight>
          <MaxHeight>
            <jmx_eb:TsunamiHeight type="津波の高さ" unit="m" description="１０ｍ超">10</jmx_eb:TsunamiHeight>
          </MaxHeight>
        </Item>
      </Forecast>
      <Observation>
        <Item>
          <Area><Name>関東</Name><Code>350</Code></Area>
          <Station><Name>銚子</Name><Code>35001</Code>
            <FirstHeight>
              <ArrivalTime>2026-01-01T12:20:00+09:00</ArrivalTime>
              <Initial>押し</Initial>
            </FirstHeight>
            <MaxHeight>
              <DateTime>2026-01-01T12:40:00+09:00</DateTime>
              <jmx_eb:TsunamiHeight type="これまでの最大波の高さ" unit="m" description="８．５ｍ以上">8.5</jmx_eb:TsunamiHeight>
            </MaxHeight>
          </Station>
        </Item>
      </Observation>
    </Tsunami>
    <Earthquake>
      <OriginTime>2026-01-01T12:00:00+09:00</OriginTime>
      <Hypocenter><Area><Name>房総半島沖</Name></Area></Hypocenter>
      <jmx_eb:Magnitude type="Mj">8.5</jmx_eb:Magnitude>
    </Earthquake>
  </Body>
</Report>`

// 上の XML と同じ津波を JSON 版で表したもの。DMDATA の JSON は観測点の「以上」を
// maxHeight.height.over の真偽値で持つ（XML では description の文言に現れる）。
const PARITY_TSUNAMI_JSON = {
  eventId: '20260101120000',
  serialNo: '1',
  reportDateTime: '2026-01-01T12:05:00+09:00',
  editorialOffice: '気象庁本庁',
  publishingOffice: '気象庁',
  infoType: '発表',
  body: {
    tsunami: {
      forecasts: [
        {
          kind: { code: '52' },
          name: '関東',
          code: '350',
          firstHeight: {
            arrivalTime: '2026-01-01T12:30:00+09:00',
            condition: 'ただちに津波来襲と予測',
          },
          maxHeight: { height: { value: '10', condition: '10m超' } },
        },
      ],
      observations: [
        {
          code: '350',
          name: '関東',
          stations: [
            {
              name: '銚子',
              code: '35001',
              firstHeight: { arrivalTime: '2026-01-01T12:20:00+09:00', initial: '押し' },
              maxHeight: { height: { value: '8.5', over: true } },
            },
          ],
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

describe('津波: JSON 経路と XML 経路の読み取り一致', () => {
  const fromJson = () => parseTsunami('VTSE51', PARITY_TSUNAMI_JSON)!
  const fromXml = () => parseTsunamiFromXml(PARITY_TSUNAMI_XML)!

  it('等級・区域名・ただちに来襲の別を同じに読む', () => {
    for (const t of [fromJson(), fromXml()]) {
      expect(t.areas).toHaveLength(1)
      expect(t.areas[0].grade).toBe('MajorWarning')
      expect(t.areas[0].name).toBe('関東')
      expect(t.areas[0].immediate).toBe(true)
    }
  })

  it('eventId と sourceEarthquake を同じに読む', () => {
    for (const t of [fromJson(), fromXml()]) {
      expect(t.eventId).toBe('20260101120000')
      expect(t.sourceEarthquake?.hypocenterName).toBe('房総半島沖')
      expect(t.sourceEarthquake?.magnitude).toBe(8.5)
    }
  })

  it('観測点の到達時刻・押し引き・波高を同じに読む', () => {
    for (const t of [fromJson(), fromXml()]) {
      expect(t.observations).toHaveLength(1)
      expect(t.observations![0].name).toBe('銚子')
      expect(t.observations![0].arrivalTime).toBe('2026-01-01T12:20:00+09:00')
      expect(t.observations![0].initial).toBe('押し')
      expect(t.observations![0].height?.value).toBe(8.5)
    }
  })

  // 正: 観測施設の観測可能範囲を超えた値（「〇m以上」）の印。
  // utils/tsunami.ts の compareObservedHeightDesc が「over を数値の大小より先に見る」規則で
  // 深刻度順と代表値を決めるため、片方で落ちると並び順と代表値だけが経路で変わる。
  it('観測波高の over（観測可能範囲の超過）を両経路で立てる', () => {
    for (const t of [fromJson(), fromXml()]) {
      expect(t.observations![0].height?.over).toBe(true)
    }
  })

  // 対照: 振り切っていない観測値では立てない。false ではなく undefined に落とす
  // （JSON 経路が over || undefined としているため、形まで揃える）。
  it('通常の観測値では over を立てない', () => {
    const json = structuredClone(PARITY_TSUNAMI_JSON)
    delete (json.body.tsunami.observations[0].stations[0].maxHeight.height as { over?: boolean }).over
    const xml = PARITY_TSUNAMI_XML.replace('description="８．５ｍ以上"', 'description="８．５ｍ"')
    expect(parseTsunami('VTSE51', json)!.observations![0].height?.over).toBeUndefined()
    expect(parseTsunamiFromXml(xml)!.observations![0].height?.over).toBeUndefined()
  })

  it('issue.source を電文の編集官署から読む', () => {
    expect(fromJson().issue.source).toBe('気象庁本庁')
    expect(fromXml().issue.source).toBe('気象庁本庁')
  })

  // 安全弁: 表示文字列が無い電文でも数値から作る。表示・読み上げは description しか見ないため、
  // 空のまま返すと波高が画面から消える。実電文は必ず description を持つので異常時の保険。
  it('予想波高の表示文字列が無ければ数値から作る', () => {
    const json = structuredClone(PARITY_TSUNAMI_JSON)
    delete (json.body.tsunami.forecasts[0].maxHeight.height as { condition?: string }).condition
    expect(parseTsunami('VTSE51', json)!.areas[0].maxHeight?.description).toBe('10m')
    const xml = PARITY_TSUNAMI_XML.replace(' description="１０ｍ超"', '')
    expect(parseTsunamiFromXml(xml)!.areas[0].maxHeight?.description).toBe('10m')
  })


  // 数値が読めないのに「以上」が書かれている電文。height ごと落ちるので表示は変わらないが、
  // JSON 経路に対になる記録があるため、XML 経路だけ痕跡が残らない状態を作らない。
  it('波高が読めないのに「以上」がある電文は記録を残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const xml = PARITY_TSUNAMI_XML.replace('>8.5</jmx_eb:TsunamiHeight>', '></jmx_eb:TsunamiHeight>')
      expect(parseTsunamiFromXml(xml)!.observations![0].height).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('数値として読めません'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('銚子'))
    } finally {
      warn.mockRestore()
    }
  })
  // description 属性が落ちると over を復元する手がかりが無くなる（XML ではこの属性が唯一の
  // 情報源）。JSON 経路には「波高は読めないが over は立っていた」ケースの記録があるので、
  // XML 経路にも対になる記録を置く。無いと「以上」が黙って通常値として扱われる。
  describe('波高の description 属性が空のとき', () => {
    // 「以上」判定に関する記録だけを数える。parseTsunamiFromXml は未知の Kind/Code など
    // 別の理由でも警告を出すため、`not.toHaveBeenCalled()` で見ると、無関係な警告が
    // 増えたときにこのテストが本来の目的と関係なく落ちる。
    const overWarnCount = (calls: unknown[][]) =>
      calls.filter(c => String(c[0]).includes('description 属性が空')).length

    const withoutDesc = () => PARITY_TSUNAMI_XML.replace(' description="８．５ｍ以上"', '')

    it('観測点名を添えて記録を残す', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      try {
        const t = parseTsunamiFromXml(withoutDesc())!
        expect(t.observations![0].height?.over).toBeUndefined()
        expect(overWarnCount(warn.mock.calls)).toBe(1)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('銚子'))
      } finally {
        warn.mockRestore()
      }
    })

    // 表示・読み上げは description しか見ないため、空のまま返すと利用者から波高が消える
    // （カードの数値・地図の観測棒のツールチップ・読み上げの数値部分がすべて空になる）。
    // 予想波高側が同じ理由で数値から組んでいるので、観測点側も揃える。
    it('表示文字列は数値から補う（波高が画面から消えないように）', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      try {
        const t = parseTsunamiFromXml(withoutDesc())!
        expect(t.observations![0].height?.value).toBe(8.5)
        expect(t.observations![0].height?.description).toBe('8.5m')
      } finally {
        warn.mockRestore()
      }
    })

    // 対照: 属性がある通常の電文では黙っている（出すと正常運転でログが埋まり、
    // 本当の異常が見えなくなる）
    it('description があれば記録しない', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      try {
        parseTsunamiFromXml(PARITY_TSUNAMI_XML)
        expect(overWarnCount(warn.mock.calls)).toBe(0)
      } finally {
        warn.mockRestore()
      }
    })

    // 安全弁: 波高そのものが読めない観測点では出さない。その場合は height ごと落ちる経路で
    // 扱うため、ここでも出すと同じ事象に 2 つの記録が並ぶ。
    it('波高が数値として読めなければ記録しない', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      try {
        const xml = withoutDesc().replace('>8.5</jmx_eb:TsunamiHeight>', '></jmx_eb:TsunamiHeight>')
        expect(parseTsunamiFromXml(xml)!.observations![0].height).toBeUndefined()
        expect(overWarnCount(warn.mock.calls)).toBe(0)
      } finally {
        warn.mockRestore()
      }
    })
  })
})

// 区域単位の等級変化（`lastGrade`）。気象庁は一部解除でも区域を電文から消さず、
// 「津波予報（Kind=72）／前回は津波注意報（LastKind=62）」の形で降格として載せる。
// これを読み落とすと、他の区域に注意報が残る限り最上位等級は動かないため、
// アプリからは「変化なし」に見える（→ docs/spec/tsunami-spec.md §10「区域単位で等級が動いた報」）。
// フィクスチャは 2024 年能登半島地震 01/02 02:30 の VTSE41 を 3 区域に縮めたもの。
const VTSE41_PARTIAL_LIFT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>津波警報・注意報・予報a</Title>
    <DateTime>2024-01-01T17:30:42Z</DateTime>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>津波注意報・津波予報</Title>
    <ReportDateTime>2024-01-02T02:30:00+09:00</ReportDateTime>
    <EventID>20240101161010</EventID>
    <InfoType>発表</InfoType>
    <Headline><Text>津波注意報を一部解除しました。</Text></Headline>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
    <Tsunami>
      <Forecast>
        <Item>
          <Area><Name>石川県能登</Name><Code>360</Code></Area>
          <Category>
            <Kind><Name>津波注意報</Name><Code>62</Code></Kind>
            <LastKind><Name>津波注意報</Name><Code>62</Code></LastKind>
          </Category>
        </Item>
        <Item>
          <Area><Name>福岡県日本海沿岸</Name><Code>711</Code></Area>
          <Category>
            <Kind><Name>津波予報（若干の海面変動）</Name><Code>72</Code></Kind>
            <LastKind><Name>津波注意報</Name><Code>62</Code></LastKind>
          </Category>
        </Item>
        <Item>
          <Area><Name>長崎県西方</Name><Code>730</Code></Area>
          <Category>
            <Kind><Name>津波予報（若干の海面変動）</Name><Code>71</Code></Kind>
          </Category>
        </Item>
      </Forecast>
    </Tsunami>
  </Body>
</Report>`

describe('津波電文の LastKind（区域単位の等級変化）', () => {
  it('正: XML 経路で LastKind を前回の等級として読む', () => {
    const t = parseTsunamiFromXml(VTSE41_PARTIAL_LIFT_XML)
    expect(t).not.toBeNull()
    // 解除された区域は電文から消えない（3 区域すべてが載る）
    expect(t!.cancelled).toBe(false)
    expect(t!.areas.map(a => [a.name, a.grade, a.lastGrade])).toEqual([
      ['石川県能登', 'Watch', 'Watch'],
      ['福岡県日本海沿岸', 'Forecast', 'Watch'],
      ['長崎県西方', 'Forecast', undefined],
    ])
  })

  it('対照: LastKind が無い区域は lastGrade を持たない（「前回は津波なし」と偽らない）', () => {
    const t = parseTsunamiFromXml(VTSE41_PARTIAL_LIFT_XML)
    expect(t!.areas.find(a => a.name === '長崎県西方')!.lastGrade).toBeUndefined()
  })

  it('正: JSON 経路でも kind.lastKind.code を前回の等級として読む', () => {
    const json = {
      eventId: '20240101161010',
      serialNo: '1',
      reportDateTime: '2024-01-02T02:30:00+09:00',
      infoType: '発表',
      body: {
        tsunami: {
          forecasts: [
            { kind: { code: '72', lastKind: { code: '62' } }, name: '福岡県日本海沿岸', code: '711' },
            { kind: { code: '62' }, name: '石川県能登', code: '360' },
          ],
        },
      },
    }
    const t = parseTsunami('VTSE41', json)
    expect(t).not.toBeNull()
    expect(t!.areas.map(a => [a.name, a.grade, a.lastGrade])).toEqual([
      ['福岡県日本海沿岸', 'Forecast', 'Watch'],
      ['石川県能登', 'Watch', undefined],
    ])
  })

  it('安全弁: 解除系コード（60）の区域は従来どおり areas から除かれる', () => {
    const json = {
      eventId: '20240101161010',
      serialNo: '1',
      reportDateTime: '2024-01-02T10:00:00+09:00',
      infoType: '発表',
      body: {
        tsunami: {
          forecasts: [
            { kind: { code: '60', lastKind: { code: '62' } }, name: '福岡県日本海沿岸', code: '711' },
          ],
        },
      },
    }
    const t = parseTsunami('VTSE41', json)
    expect(t!.cancelled).toBe(true)
    expect(t!.areas).toEqual([])
  })
})

// 潮位観測点の観測状態（電文の `Condition`）。気象庁は 2025-07-24 から「欠測」を発表しており、
// 「重要 欠測」のように複数の内容を全角スペースで併記する（電文解説資料 Ⅱ.12 の事例）。
// 読み落とすと、欠測の観測点が「到達確認・波高は観測中」として画面と読み上げに出る
// （→ docs/spec/tsunami-spec.md §6「観測状態（欠測・微弱・観測中・重要）」）。
const VTSE51_MISSING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>津波情報a</Title>
    <DateTime>2026-09-03T01:00:00Z</DateTime>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>津波観測に関する情報</Title>
    <ReportDateTime>2026-09-03T10:00:00+09:00</ReportDateTime>
    <EventID>20260903095500</EventID>
    <InfoType>発表</InfoType>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/"
        xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
    <Tsunami>
      <Observation>
        <Item>
          <Area><Name>岩手県</Name><Code>030</Code></Area>
          <Station>
            <Name>宮古</Name><Code>0031</Code>
            <FirstHeight><ArrivalTime>2026-09-03T09:58:00+09:00</ArrivalTime><Initial>押し</Initial></FirstHeight>
            <MaxHeight>
              <DateTime>2026-09-03T09:59:00+09:00</DateTime>
              <Condition>重要　欠測</Condition>
              <jmx_eb:TsunamiHeight type="これまでの最大波の高さ" unit="m" description="３．２ｍ以上">3.2</jmx_eb:TsunamiHeight>
            </MaxHeight>
          </Station>
          <Station>
            <Name>大船渡</Name><Code>0033</Code>
            <FirstHeight><Condition>欠測</Condition></FirstHeight>
            <MaxHeight><Condition>欠測</Condition></MaxHeight>
          </Station>
          <Station>
            <Name>釜石</Name><Code>0032</Code>
            <FirstHeight><ArrivalTime>2026-09-03T09:57:00+09:00</ArrivalTime><Initial>押し</Initial></FirstHeight>
            <MaxHeight><Condition>観測中　欠測</Condition></MaxHeight>
          </Station>
          <Station>
            <Name>久慈</Name><Code>0034</Code>
            <FirstHeight><ArrivalTime>2026-09-03T09:56:00+09:00</ArrivalTime><Initial>押し</Initial></FirstHeight>
            <MaxHeight><Condition>観測中</Condition></MaxHeight>
          </Station>
        </Item>
      </Observation>
    </Tsunami>
  </Body>
</Report>`

describe('潮位観測点の観測状態（Condition）', () => {
  const byName = (t: ReturnType<typeof parseTsunamiFromXml>, name: string) =>
    t!.observations!.find(o => o.name === name)!

  it('正: XML 経路で「重要 欠測」を両方立て、これまでの最大波も残す', () => {
    const t = parseTsunamiFromXml(VTSE51_MISSING_XML)
    const miyako = byName(t, '宮古')
    // 電文は欠測と同時に「これまでの最大波の高さ」を載せる。値を捨てると、
    // 観測できていた事実（ここでは大津波警報の基準超え）が画面から消える
    expect(miyako.height).toEqual({ value: 3.2, description: '３．２ｍ以上' })
    expect(miyako.condition).toEqual({ important: true, maxHeightMissing: true })
  })

  it('正: 第1波・最大波がどちらも欠測の観測点は到達時刻を持たない', () => {
    const t = parseTsunamiFromXml(VTSE51_MISSING_XML)
    const ofunato = byName(t, '大船渡')
    expect(ofunato.arrivalTime).toBeUndefined()
    expect(ofunato.height).toBeUndefined()
    expect(ofunato.condition).toEqual({ firstHeightMissing: true, maxHeightMissing: true })
  })

  it('正: 「観測中 欠測」は到達だけ確定していて波高が欠測の状態', () => {
    const t = parseTsunamiFromXml(VTSE51_MISSING_XML)
    const kamaishi = byName(t, '釜石')
    expect(kamaishi.arrivalTime).toBe('2026-09-03T09:57:00+09:00')
    expect(kamaishi.condition).toEqual({ observing: true, maxHeightMissing: true })
  })

  it('対照: 「観測中」だけの観測点は欠測を立てない（従来の到達確認の経路）', () => {
    const t = parseTsunamiFromXml(VTSE51_MISSING_XML)
    const kuji = byName(t, '久慈')
    expect(kuji.condition).toEqual({ observing: true })
    expect(kuji.height).toBeUndefined()
  })

  it('正: JSON 経路は condition と status を合わせて同じ結果になる', () => {
    // DMDATA は電文の Condition を condition（重要）と status（欠測）に分けて配る
    const json = {
      eventId: '20260903095500',
      serialNo: '1',
      type: '津波情報',
      status: '通常',
      infoType: '発表',
      reportDateTime: '2026-09-03T10:00:00+09:00',
      body: {
        tsunami: {
          observations: [{
            code: '030',
            name: '岩手県',
            stations: [{
              name: '宮古',
              code: '0031',
              firstHeight: { arrivalTime: '2026-09-03T09:58:00+09:00', initial: '押し' },
              maxHeight: {
                condition: '重要',
                status: '欠測',
                height: { type: 'これまでの最大波の高さ', unit: 'm', value: '3.2', over: true },
              },
            }],
          }],
        },
      },
    }
    const t = parseTsunami('VTSE51', json)
    expect(t!.observations?.[0].condition).toEqual({ important: true, maxHeightMissing: true })
    expect(t!.observations?.[0].height).toEqual({ value: 3.2, description: '3.2m以上', over: true })
  })

  it('安全弁: 状態を持たない観測点に condition を作らない', () => {
    const t = parseTsunamiFromXml(VTSE41_PARTIAL_LIFT_XML)
    // 区域だけの電文（観測点なし）でも壊れないこと
    expect(t!.observations).toBeUndefined()
  })
})
