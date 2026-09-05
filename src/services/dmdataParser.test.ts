// @vitest-environment jsdom
// parseEarthquakeFromXml（REST 履歴経路）のテスト。
// DOMParser を使うためこのファイルだけ jsdom 環境で動かす（既定は node）。
import { describe, it, expect, vi } from 'vitest'
import { parseEarthquakeFromXml, parseEEWFromXml, parseTsunamiFromXml, parseLpgmFromXml, parseNankaiFromXml, parseNankaiCommentaryFromXml } from './dmdataParser'
import { log } from '../utils/logger'
import { hasKnownEpicenter } from '../utils/geo'
import { hasMagnitude } from '../utils/formatters'
import { isMaxScaleUnreceived } from '../utils/quakePoints'

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

/**
 * 実電文から採った未入電の断片（令和6年能登半島地震・2024-01-01 16:16 発表の震源・震度情報）。
 *
 * **推測で組まないこと。** 以前この値を `!5-` と書いており、テストは通るのに実電文を 1 件も
 * 拾えない状態だった。実物の特徴は 3 つ ——
 *   1. 値は「震度５弱以上未入電」で**数字が全角**
 *   2. 現れるのは `IntensityStation/Int` だけ（`MaxInt` には出ない）
 *   3. 地方公共団体の観測局は名前の末尾に '＊' が付く
 * 同じ市に観測値（6+）と未入電が同居する形も実物どおり。
 */
const NOTO_UNRECEIVED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
  <Control>
    <Title>震源・震度に関する情報</Title>
    <DateTime>2024-01-01T07:16:00Z</DateTime>
    <Status>通常</Status>
    <EditorialOffice>気象庁本庁</EditorialOffice>
    <PublishingOffice>気象庁</PublishingOffice>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>震源・震度情報</Title>
    <ReportDateTime>2024-01-01T16:16:00+09:00</ReportDateTime>
    <TargetDateTime>2024-01-01T16:16:00+09:00</TargetDateTime>
    <EventID>20240101161010</EventID>
    <InfoType>発表</InfoType>
    <Serial>1</Serial>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
    <Earthquake>
      <OriginTime>2024-01-01T16:10:00+09:00</OriginTime>
      <ArrivalTime>2024-01-01T16:10:00+09:00</ArrivalTime>
      <Hypocenter>
        <Area>
          <Name>石川県能登地方</Name>
          <Coordinate>+37.5+137.3-16000/</Coordinate>
        </Area>
      </Hypocenter>
      <jmx_eb:Magnitude type="Mj">7.6</jmx_eb:Magnitude>
    </Earthquake>
    <Intensity>
      <Observation>
        <MaxInt>6+</MaxInt>
        <Pref>
          <Name>石川県</Name>
          <Code>17</Code>
          <MaxInt>6+</MaxInt>
          <Area>
            <Name>石川県能登</Name>
            <Code>390</Code>
            <MaxInt>6+</MaxInt>
            <City>
              <Name>輪島市</Name>
              <Code>1720400</Code>
              <MaxInt>6+</MaxInt>
              <IntensityStation><Name>輪島市鳳至町</Name><Code>1720402</Code><Int>6+</Int></IntensityStation>
              <IntensityStation><Name>輪島市舳倉島</Name><Code>1720401</Code><Int>5-</Int></IntensityStation>
              <IntensityStation><Name>輪島市門前町走出＊</Name><Code>1720431</Code><Int>震度５弱以上未入電</Int></IntensityStation>
            </City>
          </Area>
        </Pref>
      </Observation>
    </Intensity>
  </Body>
</Report>`

// VXSE53_XML と同じ地震。下の describe が、XML 経路で落としてはいけない項目を項目ごとに固定する。
// 実電文の Control は EditorialOffice（気象庁本庁）と PublishingOffice（気象庁）の両方を持ち、
// 編集官署を先に採るため、発表元は「気象庁本庁」になる。

describe('parseEarthquakeFromXml: 震度速報（VXSE51）', () => {
  it('Earthquake 要素が無くてもパースできる', () => {
    const quake = parseEarthquakeFromXml('VXSE51', VXSE51_XML)
    expect(quake).not.toBeNull()
    expect(quake!.issue.type).toBe('震度速報')
  })

  // 規模の期待値を 0 から NaN へ覆した。0 は `hasMagnitude` を通ってしまい「Ｍ０．０」と
  // 表示・読み上げされる（震度速報は規模を伴わないので、これは実測値のような嘘になる）。
  // 規模を伴わない電文なので、値そのものを持たない形にする。
  it('震源は「位置不明」センチネル(-200)、規模は不明（NaN）になる', () => {
    const hc = parseEarthquakeFromXml('VXSE51', VXSE51_XML)!.earthquake.hypocenter
    expect(hc.latitude).toBe(-200)
    expect(hc.longitude).toBe(-200)
    expect(Number.isNaN(hc.magnitude)).toBe(true)
    // 安全弁: 0 に戻ると「Ｍ０．０」を表示する側の判定を通ってしまう。
    expect(hasMagnitude(hc.magnitude)).toBe(false)
  })

  it('earthquake.time に Head/TargetDateTime を使う', () => {
    const quake = parseEarthquakeFromXml('VXSE51', VXSE51_XML)!
    expect(quake.earthquake.time).toBe('2026-08-09T02:58:00+09:00')
  })

  // 都道府県ロールアップ点（pref 付き）を含む。以前はこれを落としていたため、
  // EarthquakeCard が区域点からの逆引き集計に落ち、区域の震度が揃わない県では
  // 気象庁発表の代表値と粒度がずれていた。
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

  // 正: 「震度5弱以上と推定されるが観測値が入電していない」地点を落とさない。
  //
  // **揺れが強い地域ほどこの形で届く。** 観測点からの通信が途絶えるためで、階級として
  // 読めないからと捨てると、大地震のときに最も震度が高いはずの地点が画面から消える。
  //
  // **電文の断片は実物から採っている**（令和6年能登半島地震・2024-01-01 16:16 発表の
  // 震源・震度情報）。値は「震度５弱以上未入電」で数字は全角。以前ここを推測で `!5-` と
  // 書いており、テストは通るのに実電文を 1 件も拾えない状態だった。
  it('未入電の震度を 5弱以上として持つ', () => {
    const station = parseEarthquakeFromXml('VXSE53', NOTO_UNRECEIVED_XML)!.points
      .find(p => !p.isArea && p.addr === '輪島市門前町走出')!
    // 階級は下限へ寄せる（上限を定めない予想震度と同じ扱い）
    expect(station.scale).toBe(45)
    expect(station.unreceived).toBe(true)
  })

  // 正: 基準が変わって未知の表記になったら、**黙って落とさず記録する**。
  //
  // 解説資料は「当面は震度５弱を基準とし」と断っており、表記は将来変わりうる。
  // 表記を推測して先回りはしない（`!5-` で実際に外した）が、消えたことに気づけるようにする。
  // 未入電は最も震度が高いはずの地点に付く値なので、**全滅を待たず 1 件でも記録する**。
  it('未知の未入電表記は読めないが記録を残す', () => {
    const err = vi.spyOn(log, 'error').mockImplementation(() => {})
    try {
      const xml = NOTO_UNRECEIVED_XML.replace('震度５弱以上未入電', '震度６弱以上未入電')
      const points = parseEarthquakeFromXml('VXSE53', xml)!.points
      // 読めないので点は積まれない
      expect(points.some(p => p.addr === '輪島市門前町走出')).toBe(false)
      expect(err).toHaveBeenCalledWith(expect.stringContaining('震度６弱以上未入電'))
    } finally {
      err.mockRestore()
    }
  })

  // 対照: 既知の表記では記録を出さない（通常運転で毎回鳴らない）
  it('既知の未入電表記では記録を出さない', () => {
    const err = vi.spyOn(log, 'error').mockImplementation(() => {})
    try {
      parseEarthquakeFromXml('VXSE53', NOTO_UNRECEIVED_XML)
      expect(err).not.toHaveBeenCalled()
    } finally {
      err.mockRestore()
    }
  })

  // 対照: 同じ電文の観測値には印を付けない。実電文では未入電と観測値が同じ市に同居する。
  it('同じ市の観測値には未入電の印を付けない', () => {
    const points = parseEarthquakeFromXml('VXSE53', NOTO_UNRECEIVED_XML)!.points
    const observed = points.find(p => !p.isArea && p.addr === '輪島市鳳至町')!
    expect(observed.scale).toBe(60)
    expect(observed.unreceived).toBeUndefined()
  })

  // 安全弁: 観測点名末尾の '＊'（地方公共団体の観測局）は落として座標テーブルのキーに揃える。
  it('観測点名の末尾の ＊ を落とす', () => {
    const points = parseEarthquakeFromXml('VXSE53', NOTO_UNRECEIVED_XML)!.points
    expect(points.some(p => p.addr.endsWith('＊'))).toBe(false)
  })

  // 安全弁: **全体の最大震度は観測値のまま**。未入電の地点があっても、観測できた地点が
  // あればそちらが最大になる（実電文でもこの形だった）。ここが未入電に化けると、
  // 見出しに要らない「以上」が付く。
  it('未入電の地点があっても最大震度は観測値のまま', () => {
    const q = parseEarthquakeFromXml('VXSE53', NOTO_UNRECEIVED_XML)!
    expect(q.earthquake.maxScale).toBe(60)
    expect(isMaxScaleUnreceived(q.earthquake.maxScale, q.points)).toBe(false)
  })

  // 正: **電文全体の最大震度**も未入電を読む。最も強い地点が未入電なら要約値もこの形で届く。
  // ここを `-1`（不明）に落とすと、行動チェックリストが発火せず、読み上げの「最大」も消え、
  // カードの見出しが「?」になる —— **通信が途絶えるほどの地震で、そこだけ情報が薄くなる**。
  it('電文全体の最大震度が未入電でも 5弱以上として持つ', () => {
    // 区域の MaxInt も同時に差し替える（最大値なので、その値を持つ点が必ずある）。
    // 最大値なので、その値を持つ点が必ずある）
    const xml = VXSE53_XML
      .replace(/(<Observation>[\s\S]*?<MaxInt>)4(<\/MaxInt>)/, '$1震度５弱以上未入電$2')
      .replace(/(<Name>岩手県沿岸北部<\/Name>[\s\S]*?<MaxInt>)4(<\/MaxInt>)/, '$1震度５弱以上未入電$2')
    const q = parseEarthquakeFromXml('VXSE53', xml)!
    expect(q.earthquake.maxScale).toBe(45)
    // 未入電かは `points` から導く（フィールドで持たない。理由は `isMaxScaleUnreceived`）
    expect(isMaxScaleUnreceived(q.earthquake.maxScale, q.points)).toBe(true)
  })

  // 対照: 観測された最大震度には印を付けない
  it('観測された最大震度には未入電の印を付けない', () => {
    const q = parseEarthquakeFromXml('VXSE53', VXSE53_XML)!
    expect(isMaxScaleUnreceived(q.earthquake.maxScale, q.points)).toBe(false)
  })

  // 対照: 観測された 5弱 には印を付けない。付けると「実際にはもっと強いかもしれない」が
  // 観測値にまで及び、逆の誤解を生む
  it('観測された 5弱 には未入電の印を付けない', () => {
    const xml = VXSE53_XML.replace('<Int>3</Int>', '<Int>5-</Int>')
    const station = parseEarthquakeFromXml('VXSE53', xml)!.points.find(p => !p.isArea)!
    expect(station.scale).toBe(45)
    expect(station.unreceived).toBeUndefined()
  })

  // 安全弁: 区域・都道府県の `MaxInt` でも同じ扱いにする。3 箇所のうち 1 つでも
  // 読み落とすと、その粒度だけ地図から消える
  it('区域の MaxInt が未入電でも落とさない', () => {
    // 「岩手県沿岸北部」の直下にある MaxInt だけを差し替える（同名要素が入れ子で並ぶため）
    const xml = VXSE53_XML.replace(/(<Name>岩手県沿岸北部<\/Name>[\s\S]*?<MaxInt>)4(<\/MaxInt>)/, '$1震度５弱以上未入電$2')
    const area = parseEarthquakeFromXml('VXSE53', xml)!.points.find(p => p.isArea && p.addr === '岩手県沿岸北部')!
    expect(area.scale).toBe(45)
    expect(area.unreceived).toBe(true)
  })

  it('観測点は区域と同じ規約で pref を空文字にする（QUAKE-2）', () => {
    // 以前は pref: prefName を付けていたが、EarthquakeCard.prefGroups が「観測点値」を
    // 都道府県別最大震度と誤解し、区域単位の最大震度が観測点値に上書きされる問題があった。
    // 区域点と揃えて pref: '' に統一する。
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

// 電文の読み取りは XML 経路だけ。**ここは「落ちていないこと」を項目ごとに固定する場所**で、
// 経路を 1 本にする前、撤去した JSON 版と突き合わせて確かめた値をそのまま書き留めてある。
// **実装をコピーした値ではなく、2 つの読み取りが一致していた時点の値**であることに意味がある。
//
// ここが崩れたら、電文から取れていたはずの項目が落ちたということ。**画面には
// 「情報が少し粗くなった」以上には現れない**ので、テストで固定しておくしかない。
describe('XML 経路が落としてはいけない項目（地震）', () => {
  const fromXml = () => parseEarthquakeFromXml('VXSE53', VXSE53_XML)!

  // 正: eventId を「フィールドとして」持つ。id 文字列には両経路とも埋め込まれているが、
  // TsunamiTab は q.eventId を直接比較して原因地震カードへのリンクを作るため、
  // フィールドが無いと津波バナーからのリンクが引き当たらない。
  it('eventId をフィールドとして持つ', () => {
    expect(fromXml().eventId).toBe('20260809025800')
  })

  // 正: 都道府県ロールアップ点（pref 付き）。実電文の Pref 直下には MaxInt があり
  // （能登半島地震の震度速報で <Pref><Name>石川県</Name><Code>17</Code><MaxInt>5+</MaxInt> を確認）。
  // これが無いと EarthquakeCard は区域点からの逆引き集計に落ち、気象庁発表の代表値と粒度がずれる。
  it('都道府県ロールアップ点（pref 付き）を持つ', () => {
    const expected = { pref: '岩手県', addr: '岩手県', isArea: true, scale: 40 }
    expect(fromXml().points).toContainEqual(expected)
  })

  it('区域点は pref を空にする', () => {
    const expected = { pref: '', addr: '岩手県沿岸北部', isArea: true, scale: 40 }
    expect(fromXml().points).toContainEqual(expected)
  })

  // QUAKE-2: 観測点の pref を空にする規約。以前 XML 側だけ pref: prefName を付けていて、
  // EarthquakeCard が観測点値を都道府県別最大震度と誤解する不具合があった。
  it('観測点は pref を空にする（QUAKE-2）', () => {
    const expected = { pref: '', addr: '普代村銅屋', isArea: false, scale: 30 }
    expect(fromXml().points).toContainEqual(expected)
  })

  // 安全弁: 都道府県点を足しても区域点・観測点の数は変わらない。
  // Pref 直下の MaxInt を Area としても数えると、区域点が二重になる。
  it('点の内訳は都道府県1・区域1・観測点1', () => {
    for (const q of [fromXml()]) {
      expect(q.points.filter(p => p.pref !== '')).toHaveLength(1)
      expect(q.points.filter(p => p.pref === '' && p.isArea)).toHaveLength(1)
      expect(q.points.filter(p => !p.isArea)).toHaveLength(1)
    }
  })

  // issue.source は現状どのコンポーネントからも読まれないが、両経路で同じ値になる状態を保つ。
  // XML 側を '気象庁' 固定にすると、電文が持つ編集官署（実電文では「気象庁本庁」）が落ちる。
  it('issue.source を電文の編集官署から読む', () => {
    expect(fromXml().issue.source).toBe('気象庁本庁')
  })

  // 対照: 編集官署が無い電文では発表官署へ落ちる（両経路とも同じ順序で解決する）。
  // 値を「気象庁」以外にしておくのは、フォールバックが効いたのか元の固定値が残ったのかを
  // 区別するため（両方とも「気象庁」だと、実装を固定値へ戻してもこのテストが通ってしまう）。
  it('編集官署が無ければ発表官署を使う', () => {
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
    const xml = VXSE53_XML.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
    expect(parseEarthquakeFromXml('VXSE53', xml)!.eventId).toBe('20260809025800')
  })

  // 安全弁: eventId を足したことで取消の判定そのものは変わらない
  it('取消電文は cancelled=true のまま', () => {
    const xml = VXSE53_XML.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
    expect(parseEarthquakeFromXml('VXSE53', xml)!.cancelled).toBe(true)
  })

})

describe('訂正フラグ（Head/InfoType）の伝播', () => {
  const withInfoType = (v: string | null) => {
    const xml = VXSE53_XML.replace('<InfoType>発表</InfoType>', v === null ? '' : `<InfoType>${v}</InfoType>`)
    return parseEarthquakeFromXml('VXSE53', xml)
  }

  it('InfoType が「訂正」なら correct=訂正 になる', () => {
    expect(withInfoType('訂正')!.issue.correct).toBe('訂正')
  })

  it('InfoType が「発表」なら correct=なし のまま', () => {
    expect(withInfoType('発表')!.issue.correct).toBe('なし')
  })

  it('InfoType 欠落時は correct=なし', () => {
    expect(withInfoType(null)!.issue.correct).toBe('なし')
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


describe('遠地地震に関する情報（VXSE53・Head/Title で識別）', () => {
  // 付加文の区分を導出できなかった警告だけを数える。parseEarthquakeFromXml は別の理由でも
  // 警告を出すため、`not.toHaveBeenCalled()` で見ると無関係な警告が増えたときに落ちる。
  const warnCount = (calls: unknown[][]) =>
    calls.filter(c => String(c[0]).includes('導出できません')).length

  it('XML: Control/Title ではなく Head/Title を見て 遠地地震 と判定する', () => {
    const quake = parseEarthquakeFromXml('VXSE53', FOREIGN_XML)
    expect(quake).not.toBeNull()
    expect(quake!.issue.type).toBe('遠地地震')
  })

  it('震源名は詳細震央地名を採る', () => {
    expect(parseEarthquakeFromXml('VXSE53', FOREIGN_XML)!.earthquake.hypocenter.name).toBe('メキシコ、チアパス州沿岸')
  })

  it('深さ不明は -1 センチネルになる（0＝ごく浅い と区別する）', () => {
    expect(parseEarthquakeFromXml('VXSE53', FOREIGN_XML)!.earthquake.hypocenter.depth).toBe(-1)
  })

  it('付加文 0230（日本への津波の影響なし）を津波区分に反映する', () => {
    expect(parseEarthquakeFromXml('VXSE53', FOREIGN_XML)!.earthquake.domesticTsunami).toBe('なし')
  })

  it('付加文の原文を1行に整形して forecastText に保持する', () => {
    const expected = '震源の近傍で津波発生の可能性があります。この地震による日本への津波の影響はありません。'
    expect(parseEarthquakeFromXml('VXSE53', FOREIGN_XML)!.forecastText).toBe(expected)
  })

  it('国内震度を伴わないため maxScale は -1・points は空', () => {
    const quake = parseEarthquakeFromXml('VXSE53', FOREIGN_XML)!
    expect(quake.earthquake.maxScale).toBe(-1)
    expect(quake.points).toEqual([])
  })

  it('取消電文でも 遠地地震 と判定する（既存カードと issue.type が一致しないと取消が反映されない）', () => {
    const cancelXml = FOREIGN_XML.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
    const fromXml = parseEarthquakeFromXml('VXSE53', cancelXml)!
    expect(fromXml.cancelled).toBe(true)
    expect(fromXml.issue.type).toBe('遠地地震')

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

  // 対照: 付加文が無ければ空文字ではなく undefined。空文字だと「付加文はあるが本文が空」と
  // 見分けが付かず、表示側が空の枠を作る。
  it('付加文が無い電文では forecastText を undefined にする', () => {
    const noComments = FOREIGN_XML.replace(/<Comments>[\s\S]*<\/Comments>/, '')
    expect(parseEarthquakeFromXml('VXSE53', noComments)!.forecastText).toBeUndefined()
  })

  // 自由付加文（Comments/FreeFormComment）。固定付加文が津波区分ごとの定型文であるのに対し、
  // こちらは電文ごとに書き起こされる本文で、**続報での更新はこちらにしか現れないことがある**。
  // 実例: 2026-08-25 のアンバエ火山噴火に伴う遠地地震情報は全 4 報で震源要素も固定付加文も
  // 同一で、潮位変化の観測状況と次報の予定時刻だけが自由付加文で更新された。
  describe('自由付加文（FreeFormComment）', () => {
    const xmlWithFree = (free: string) =>
      FOREIGN_XML.replace('</ForecastComment>', `</ForecastComment>
      <FreeFormComment>${free}</FreeFormComment>`)

    it('改行を保ったまま freeText に持つ', () => {
      const free = `現在、海外および国内の観測点で有意な潮位変化は観測されていません。
次の遠地地震に関する情報は、２６日０２時３０分頃に発表の予定です。`
      expect(parseEarthquakeFromXml('VXSE53', xmlWithFree(free))!.freeText).toBe(free)
    })

    // 実例: 2026-06-08 フィリピン付近 M8.2 の第 2 報以降は、検潮所ごとの最大波の高さが
    // 全角スペース整形の表で入る。1 行へ潰すと列が崩れるため forecastText のような整形はしない
    it('全角スペースで整形された表を崩さない', () => {
      const table = `国・地域名　　　検潮所名　　　これまでの最大波の高さ
フィリピン　　　ダバオ　　　　０．４６ｍ`
      expect(parseEarthquakeFromXml('VXSE53', xmlWithFree(table))!.freeText).toBe(table)
    })

    // 対照: 大半の遠地地震は自由付加文を持たない（4 か月 6 事象のうち 2 事象は空）
    it('自由付加文が無ければ freeText は undefined', () => {
      expect(parseEarthquakeFromXml('VXSE53', FOREIGN_XML)!.freeText).toBeUndefined()
    })
  })

  // 火山の大規模噴火に伴う遠地地震情報で使われるコード。対応表から漏らすと津波区分が
  // '不明' へ落ち、調査中であることがカードにも読み上げにも出ない（灰色の「不明」になる）
  it('付加文 0229（日本への津波の有無は調査中）を 調査中 として扱う', () => {

    const xml = FOREIGN_XML.replace('<Code>0226 0230</Code>', '<Code>0229</Code>')
    expect(parseEarthquakeFromXml('VXSE53', xml)!.earthquake.domesticTsunami).toBe('調査中')
  })

  // 安全弁: 0228 は「一般的に、この規模の地震が海域の浅い領域で発生すると…」という一般論で、
  // 日本国内への影響区分ではない。区分に写さないのは 022x 系と同じだが、既知として扱わないと
  // 単独で届いたときに「導出できません」の警告が出る（正常系で鳴らすと警告の価値が下がる）
  it('付加文 0228 単独は区分に写さないが警告も出さない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const xml = FOREIGN_XML.replace('<Code>0226 0230</Code>', '<Code>0228</Code>')
      // 区分は導出されない（既知だが日本への影響を表すコードではない）
      expect(parseEarthquakeFromXml('VXSE53', xml)!.earthquake.domesticTsunami).toBe('不明')
      expect(warnCount(warn.mock.calls)).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })

  // 正: 未知のコードは記録に残す。区分を導出できないまま黙って流すと、気象庁が新しい付加文を
  // 足したことに誰も気づけない。
  it('未知の付加文コードだけなら警告を出す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const xml = FOREIGN_XML.replace('<Code>0226 0230</Code>', '<Code>9999</Code>')
      expect(parseEarthquakeFromXml('VXSE53', xml)!.earthquake.domesticTsunami).toBe('不明')
      expect(warnCount(warn.mock.calls)).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  // 安全弁: 既知のコードが 1 つでもあれば黙る、という形にしない。**既知を取り除いて残ったもの**で
  // 判定しないと、022x 系と同居した新しいコードを見逃す。
  it('既知の 0228 と未知のコードが同居したら未知の側だけを警告する', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const xml = FOREIGN_XML.replace('<Code>0226 0230</Code>', '<Code>0228 9999</Code>')
      parseEarthquakeFromXml('VXSE53', xml)
      expect(warnCount(warn.mock.calls)).toBe(1)
      expect(warn.mock.calls.flat().join(' ')).toContain('9999')
    } finally {
      warn.mockRestore()
    }
  })


})

// 震度点を積めなかったときの記録。
//
// `if (name && scale >= 0)` は条件を満たさない要素を無言で捨てる。落ちても下流の不変条件は
// 破れない（`EarthquakeCard.prefGroups` は区域点からの逆引き集計へ静かに落ち、震度の面は
// 「届く点は必ず階級表の値を持つ」前提のまま成り立つ）ため、**点が丸ごと消えても画面には
// 「情報が少し粗くなった」以上には現れない**。2026-09-04 の都道府県ロールアップ点の欠落は
// それで長く見つからなかった。
//
// 記録するのは**その種別が全滅したときだけ**。部分的な脱落で鳴らすとログが埋まり、本当の
// 全滅が埋もれる。以下は 6 箇所（3 種 × 2 経路）それぞれについて、正（全滅で鳴る）・
// 対照（元要素が 0 件なら鳴らない）・安全弁（部分脱落で鳴らさない）を対で固定する。
describe('震度点を積めなかったときの記録', () => {
  // log.warn を差し替え、出た警告文を文字列として集める。
  // 種別ラベルの部分一致で数えるのは、どの種別について鳴ったかを見分けるため。
  const captureWarnings = (run: () => void): string[] => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      run()
      return warn.mock.calls.map(c => c.join(' '))
    } finally {
      warn.mockRestore()
    }
  }
  const matching = (warnings: string[], label: string) => warnings.filter(w => w.includes(label))

  const REGION = '震度の区域'
  const STATION = '震度の観測点'
  const PREF = '都道府県の代表震度'
  const NO_POINTS = '震度の点を 1 件も取り出せませんでした'
  describe('XML 経路（parseEarthquakeFromXml）', () => {
    // Pref 直下の MaxInt。Observation 直下・Area 直下にも同じ要素名があるため、
    // 直前の Code で位置を特定して差し替える
    const breakPrefMaxInt = (xml: string) =>
      xml.replace('<Code>03</Code>\n          <MaxInt>4</MaxInt>', '<Code>03</Code>\n          <MaxInt>不明</MaxInt>')
    const breakArea221 = (xml: string) =>
      xml.replace('<Code>221</Code>\n            <MaxInt>4</MaxInt>', '<Code>221</Code>\n            <MaxInt>不明</MaxInt>')
    const breakArea211 = (xml: string) =>
      xml.replace('<Code>211</Code>\n            <MaxInt>3</MaxInt>', '<Code>211</Code>\n            <MaxInt>不明</MaxInt>')

    it('都道府県が全滅すると読めなかった値つきで記録する', () => {
      const warnings = captureWarnings(() => {
        parseEarthquakeFromXml('VXSE51', breakPrefMaxInt(VXSE51_XML))
      })
      expect(matching(warnings, PREF)).toHaveLength(1)
      expect(matching(warnings, PREF)[0]).toContain('岩手県="不明"')
      expect(matching(warnings, REGION)).toHaveLength(0)
    })

    it('区域が全滅すると記録する', () => {
      const warnings = captureWarnings(() => {
        parseEarthquakeFromXml('VXSE51', breakArea211(breakArea221(VXSE51_XML)))
      })
      expect(matching(warnings, REGION)).toHaveLength(1)
      expect(matching(warnings, PREF)).toHaveLength(0)
    })

    it('観測点が全滅すると記録する', () => {
      const warnings = captureWarnings(() => {
        parseEarthquakeFromXml('VXSE53', VXSE53_XML.replace('<Int>3</Int>', '<Int>不明</Int>'))
      })
      expect(matching(warnings, STATION)).toHaveLength(1)
    })

    // 対照: 震度速報は Area までしか持たない。観測点について鳴らせば毎回鳴る
    it('観測点を持たない震度速報では観測点について鳴らない', () => {
      const warnings = captureWarnings(() => { parseEarthquakeFromXml('VXSE51', VXSE51_XML) })
      expect(matching(warnings, STATION)).toHaveLength(0)
    })

    // 対照: 手を入れていない実電文どおりの形では 1 件も鳴らない。
    // 実電文 120 通（VXSE51/53 各 60 通）で Pref 246 件すべてが直下に MaxInt を持つことを確認済み
    it('そのままの電文では何も鳴らない', () => {
      expect(captureWarnings(() => { parseEarthquakeFromXml('VXSE51', VXSE51_XML) })).toHaveLength(0)
      expect(captureWarnings(() => { parseEarthquakeFromXml('VXSE53', VXSE53_XML) })).toHaveLength(0)
    })

    it('一部だけ読めない区域では鳴らない', () => {
      const warnings = captureWarnings(() => {
        parseEarthquakeFromXml('VXSE51', breakArea211(VXSE51_XML))
      })
      expect(matching(warnings, REGION)).toHaveLength(0)
    })

    it('一部だけ読めない観測点では鳴らない', () => {
      const twoStations = VXSE53_XML.replace('</IntensityStation>', `</IntensityStation>
              <IntensityStation>
                <Name>普代村第二</Name>
                <Code>3350632</Code>
                <Int>不明</Int>
              </IntensityStation>`)
      const warnings = captureWarnings(() => { parseEarthquakeFromXml('VXSE53', twoStations) })
      expect(matching(warnings, STATION)).toHaveLength(0)
    })
  })

  // 種別ごとの全滅検知は「元要素はあるのに読めなかった」しか捕まえられない。元要素そのものが
  // 見えなくなった場合（Observation の位置が変わった・要素名が改名された）は数える対象が
  // 0 件になって素通りするため、電文単位でもう一段見る。
  describe('震度を伝える電文なのに点が 0 件', () => {
    const stripIntensity = (xml: string) => xml.replace(/<Intensity>[\s\S]*<\/Intensity>/, '')

    // 正: 種別ごとの検知は 1 件も鳴らない（数える対象が無い）のに、こちらは鳴る
    it('Intensity が丸ごと無ければ記録する', () => {
      const warnings = captureWarnings(() => {
        parseEarthquakeFromXml('VXSE53', stripIntensity(VXSE53_XML))
      })
      expect(matching(warnings, NO_POINTS)).toHaveLength(1)
      expect(matching(warnings, REGION)).toHaveLength(0)
      expect(matching(warnings, STATION)).toHaveLength(0)
      expect(matching(warnings, PREF)).toHaveLength(0)
    })

    // 対照: 震源情報（VXSE52）は観測データを持たないのが正常
    it('震源情報では鳴らない', () => {
      const xmlWarnings = captureWarnings(() => {
        parseEarthquakeFromXml('VXSE52', stripIntensity(VXSE53_XML))
      })
      expect(matching(xmlWarnings, NO_POINTS)).toHaveLength(0)
    })

    // 対照: 遠地地震は VXSE53 として配信されるが国内の震度を持たない。
    // Head/Title でしか見分けられないため、ここだけ issueType で除いている
    it('遠地地震では鳴らない', () => {
      const farXml = stripIntensity(VXSE53_XML)
        .split('<Title>震源・震度に関する情報</Title>')
        .join('<Title>遠地地震に関する情報</Title>')
      expect(matching(captureWarnings(() => {
        parseEarthquakeFromXml('VXSE53', farXml)
      }), NO_POINTS)).toHaveLength(0)
    })

    // 安全弁: 判定は headType で行う。points を作るかどうかを決めているのが headType なので、
    // issueType で言い換えると 2 つの判定がいずれずれる（resolveIssueType は未知の headType を
    // '震源・震度情報' へ落とすため、点を作らない電文が「震度を伝える電文」に見える）
    it('未知の種別では鳴らない（issueType では震源・震度情報に見える）', () => {
      const warnings = captureWarnings(() => {
        parseEarthquakeFromXml('VXSE99', stripIntensity(VXSE53_XML))
      })
      expect(matching(warnings, NO_POINTS)).toHaveLength(0)
    })

    // 安全弁: 訂正報（InfoType=訂正）を特別扱いしない。**点が 0 件なら訂正報でも鳴る。**
    //
    // 「訂正報は震源だけを訂正するので震度を持たない。鳴るのは誤検知だ」という見立てが
    // レビューで出たが、実装からは支持されなかった——気象庁は震源要素だけの訂正を
    // **別の種別（VXSE61）** に分けており、そちらは判定の対象外。VXSE53 の訂正報は
    // 通常報と同じ経路で読まれ、`correct` フラグが立つだけ（`取消` だけが早期 return で分かれる）。
    // 気象庁の電文解説資料も、震源要素を訂正する報に「＊印は気象庁以外の震度観測点」の
    // 固定付加文（0262）を併記する例を載せている＝観測点の震度を持つ形。
    //
    // **`infoType` を見て黙らせる変更が入ったらここが落ちる。** 見立てだけで検知を止めない
    // ための歯止めなので、覆すなら訂正報が震度を落とす実電文を先に見つけること
    it('訂正報でも点が 0 件なら鳴る（訂正報を特別扱いしない）', () => {
      const corrected = stripIntensity(VXSE53_XML).replace('<InfoType>発表</InfoType>', '<InfoType>訂正</InfoType>')
      const quake = parseEarthquakeFromXml('VXSE53', corrected)!
      expect(quake.issue.correct).toBe('訂正')
      const warnings = captureWarnings(() => { parseEarthquakeFromXml('VXSE53', corrected) })
      expect(matching(warnings, NO_POINTS)).toHaveLength(1)
    })

    // 安全弁: 訂正報（VXSE61）は震源要素だけを伝える。点を持たないのが正常
    it('顕著な地震の震源要素更新では鳴らない', () => {
      const warnings = captureWarnings(() => {
        parseEarthquakeFromXml('VXSE61', stripIntensity(VXSE53_XML))
      })
      expect(matching(warnings, NO_POINTS)).toHaveLength(0)
    })
  })
})

// EEW（VXSE45）の XML 電文。予想震度・長周期階級・区域・震源を差し替えて使う。
function eewXml(o: {
  infoType?: string
  forecastInt?: string
  forecastLgInt?: string
  pref?: string
  area?: string
  nextAdvisory?: string
  /**
   * 実電文の取消と同じく `Earthquake` 要素を持たない形にする。
   * `area` は `Earthquake` の中にあるため同時に渡せない（渡すと黙って無視されるので手前で弾く）。
   * `pref` は `Intensity/Forecast` の中なので影響を受けない。
   */
  noEarthquake?: boolean
  /** 固定付加文（`Comments/Warning/Text`）。避難行動の呼びかけなどが入る。 */
  warningComment?: string
} = {}): string {
  if (o.noEarthquake && o.area) throw new Error('eewXml: noEarthquake と area は同時に指定できない')
  const area = o.area ?? '<Name>茨城県沖</Name><jmx_eb:Coordinate>+36.2+141.0-30000/</jmx_eb:Coordinate>'
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">',
    '<Control><Title>緊急地震速報（地震動予報）</Title><Status>通常</Status><EditorialOffice>気象庁</EditorialOffice></Control>',
    '<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">',
    '<Title>緊急地震速報（地震動予報）</Title>',
    '<ReportDateTime>2026-01-01T12:00:10+09:00</ReportDateTime>',
    '<EventID>20260101120000</EventID>',
    '<InfoType>' + (o.infoType ?? '発表') + '</InfoType>',
    '<Serial>1</Serial>',
    '</Head>',
    '<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">',
    o.nextAdvisory ?? '',
    ...(o.noEarthquake ? [] : [
      '<Earthquake>',
      '<OriginTime>2026-01-01T12:00:00+09:00</OriginTime>',
      '<ArrivalTime>2026-01-01T12:00:00+09:00</ArrivalTime>',
      '<Hypocenter><Area>' + area + '</Area></Hypocenter>',
      '<jmx_eb:Magnitude type="Mj">6.5</jmx_eb:Magnitude>',
      '</Earthquake>',
    ]),
    '<Intensity><Forecast>',
    '<ForecastInt>' + (o.forecastInt ?? '<From>5-</From><To>5+</To>') + '</ForecastInt>',
    '<ForecastLgInt>' + (o.forecastLgInt ?? '<From>2</From><To>3</To>') + '</ForecastLgInt>',
    o.pref ?? '',
    '</Forecast></Intensity>',
    ...(o.warningComment
      ? ['<Comments><Warning><Text>' + o.warningComment + '</Text></Warning></Comments>']
      : []),
    '</Body></Report>',
  ].join('\n')
}

/** 区域 1 件。`kindName` を「緊急地震速報（警報）」にすると警報級として読まれる。 */
function eewPref(forecastInt: string, kindCode = '09', kindName = '緊急地震速報（予報）'): string {
  return '<Pref><Name>石川</Name><Code>9170</Code><Area>'
    + '<Name>石川県能登</Name><Code>390</Code>'
    + '<Category><Kind><Name>' + kindName + '</Name><Code>' + kindCode + '</Code></Kind></Category>'
    + '<ForecastInt>' + forecastInt + '</ForecastInt>'
    + '</Area></Pref>'
}

describe('parseEEWFromXml: severity・cancel・LPGM', () => {
  it('VXSE45 は severity=Forecast（予報）', () => {
    expect(parseEEWFromXml('VXSE45', eewXml())!.severity).toBe('Forecast')
  })

  it('VXSE43 は severity=Warning（警報）', () => {
    expect(parseEEWFromXml('VXSE43', eewXml())!.severity).toBe('Warning')
  })

  it('区域の Kind が「緊急地震速報（警報）」なら VXSE45 でも severity=Warning に格上げ', () => {
    const xml = eewXml({ pref: eewPref('<From>5+</From><To>5+</To>', '11', '緊急地震速報（警報）') })
    expect(parseEEWFromXml('VXSE45', xml)!.severity).toBe('Warning')
  })

  // **座標は -200（位置不明センチネル）で埋める。0 にしてはならない** ——0 はギニア湾沖の有効な
  // 座標として `hasKnownEpicenter` を通り、地図に震源×印を立てうる。いまは取消済みの EEW が
  // `cancelledAt` で先に除かれるため表に出ないが、二重防御の奥が壊れた状態を残さない。
  // 他の経路（VXSE51・震度速報・p2pquake の COORD_UNKNOWN）と同じ値に揃えてある。
  it('取消は cancelled 電文（座標は位置不明センチネル・areas 空・VXSE43 は severity=Warning 保持）', () => {
    const xml = eewXml({ infoType: '取消', pref: eewPref('<From>5+</From><To>5+</To>') })
    const eew = parseEEWFromXml('VXSE43', xml)!
    expect(eew.cancelled).toBe(true)
    expect(eew.earthquake.hypocenter.latitude).toBe(-200)
    expect(eew.earthquake.hypocenter.longitude).toBe(-200)
    expect(hasKnownEpicenter(eew.earthquake.hypocenter.latitude, eew.earthquake.hypocenter.longitude)).toBe(false)
    expect(eew.areas).toEqual([])
    expect(eew.severity).toBe('Warning')
    // 安全弁: 実電文の取消は Earthquake 要素ごと持たない。それでも null を返さない
    // （構造の異常として捨てる判定が取消を外していること。→ `parseEEWFromXml` の `!isCanceled`）
    const noEq = eewXml({ infoType: '取消', noEarthquake: true })
    expect(noEq).not.toContain('<Earthquake>')
    expect(parseEEWFromXml('VXSE43', noEq)).not.toBeNull()
  })

  it('forecastMaxScale は To 優先・range 外は undefined', () => {
    // parseIntensityStr マップ: 5- → 45 / 5+ → 50 / 6- → 55 / 6+ → 60
    expect(parseEEWFromXml('VXSE45', eewXml())!.forecastMaxScale).toBe(50)
    // To のみ・From 欠落
    expect(parseEEWFromXml('VXSE45', eewXml({ forecastInt: '<To>6-</To>' }))!.forecastMaxScale).toBe(55)
    // 範囲外（不明値）は undefined
    expect(parseEEWFromXml('VXSE45', eewXml({ forecastInt: '<To>不明</To>' }))!.forecastMaxScale).toBeUndefined()
  })

  // To='over' は「上限を定めない」。震度7と読むと、下限しか決まっていない報（仮定震源要素の
  // 初報など）が最大震度7として塗られ・読み上げられる。2024/1/1 16:18 の余震の初報が
  // 実際にこの形（石川県能登 From='4' / To='over'）で、震度7の警戒色が能登一帯に出ていた。
  describe('予想震度の To=over（上限なし）', () => {
    const withInt = (fi: string, pref?: string) =>
      parseEEWFromXml('VXSE45', eewXml({ forecastInt: fi, pref }))!

    it('電文全体は From に寄せ、「以上」をフラグで持つ', () => {
      const eew = withInt('<From>4</From><To>over</To>')
      expect(eew.forecastMaxScale).toBe(40)
      expect(eew.forecastMaxScaleOrAbove).toBe(true)
    })

    it('地域別も From に寄せ、「以上」をフラグで持つ', () => {
      const eew = withInt('<From>4</From><To>over</To>', eewPref('<From>4</From><To>over</To>'))
      expect(eew.areas).toEqual([
        { pref: '', name: '石川県能登', scaleFrom: 40, scaleTo: 40, scaleToOrAbove: true, kindCode: '09', arrivalTime: null, lgIntTo: undefined },
      ])
    })

    it('上限が定まっている報には「以上」を立てない（境界の手前）', () => {
      const eew = withInt('<From>6-</From><To>7</To>', eewPref('<From>6-</From><To>7</To>', '11'))
      expect(eew.forecastMaxScale).toBe(70)
      expect(eew.forecastMaxScaleOrAbove).toBeUndefined()
      expect(eew.areas![0].scaleTo).toBe(70)
      expect(eew.areas![0].scaleToOrAbove).toBeUndefined()
    })

    it('From が無い over は「以上」を立てない（「不明以上」は意味を成さない）', () => {
      const eew = withInt('<To>over</To>', eewPref('<To>over</To>'))
      expect(eew.forecastMaxScale).toBeUndefined()
      expect(eew.forecastMaxScaleOrAbove).toBeUndefined()
      expect(eew.areas![0].scaleTo).toBe(-1)
      expect(eew.areas![0].scaleToOrAbove).toBeUndefined()
    })

    // over 以外の値の扱いは変えない。ここを From へ落とすと、上限が不明な報の震度が
    // 下限の値で出るようになる（over の修正に紛れて別の挙動が変わる）。
    it('To が読めない値なら From があっても不明のまま（over 以外の挙動は据え置き）', () => {
      const eew = withInt('<From>4</From><To>不明</To>', eewPref('<From>4</From><To>不明</To>'))
      expect(eew.forecastMaxScale).toBeUndefined()
      expect(eew.areas![0].scaleTo).toBe(-1)
      expect(eew.areas![0].scaleFrom).toBe(40)
      expect(eew.areas![0].scaleToOrAbove).toBeUndefined()
    })

    it('To が空なら From を上限として採る（従来どおり）', () => {
      const eew = withInt('<From>5+</From>', eewPref('<From>5+</From>', '11'))
      expect(eew.forecastMaxScale).toBe(50)
      expect(eew.areas![0].scaleTo).toBe(50)
      expect(eew.areas![0].scaleToOrAbove).toBeUndefined()
    })

    it('取消電文では「以上」を残さない（areas も空になる）', () => {
      const eew = parseEEWFromXml('VXSE43', eewXml({
        infoType: '取消',
        forecastInt: '<From>4</From><To>over</To>',
        pref: eewPref('<From>4</From><To>over</To>'),
      }))!
      expect(eew.forecastMaxScale).toBeUndefined()
      expect(eew.forecastMaxScaleOrAbove).toBeUndefined()
      expect(eew.areas).toEqual([])
    })
  })

  it('forecastMaxLpgmClass は To 優先、範囲外は undefined', () => {
    expect(parseEEWFromXml('VXSE45', eewXml())!.forecastMaxLpgmClass).toBe(3)
    const outOfRange = eewXml({ forecastLgInt: '<From>5</From><To>5</To>' })
    expect(parseEEWFromXml('VXSE45', outOfRange)!.forecastMaxLpgmClass).toBeUndefined()
  })

  // 安全弁: 取消はそのイベントの打ち切りなので最終報として扱う。実電文の取消は Body に Text しか
  // 持たず NextAdvisory が無い（2026-03-07 の取消で確認）ので、文言だけを見ると false に落ちる。
  // 取消の後に続報は来ないので、最終報と同じに扱う。
  it('取消は最終報として扱う（NextAdvisory が無くても）', () => {
    const xml = eewXml({ infoType: '取消' })
    expect(xml).not.toContain('NextAdvisory')
    expect(parseEEWFromXml('VXSE45', xml)!.isFinal).toBe(true)
  })

  it('NextAdvisory に最終報の文言があれば isFinal=true', () => {
    const xml = eewXml({ nextAdvisory: '<NextAdvisory>この情報をもって、緊急地震速報：最終報とします。</NextAdvisory>' })
    expect(parseEEWFromXml('VXSE45', xml)!.isFinal).toBe(true)
  })

  it('座標が読めない発表電文（非 cancel）は null', () => {
    expect(parseEEWFromXml('VXSE45', eewXml({ area: '<Name>茨城県沖</Name>' }))).toBeNull()
  })

  // 正: 捨てたことを**常に残る側**へ記録する。EEW は最も落としてはいけない電文なのに、
  // ここだけ素の `return null` で、電文が 1 通丸ごと消えても何も残らない形だった。
  it('座標が読めずに捨てたことを記録する', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      parseEEWFromXml('VXSE45', eewXml({ area: '<Name>茨城県沖</Name>' }))
      const hit = warn.mock.calls.map(c => c.join(' ')).filter(w => w.includes('震源座標が読めません'))
      expect(hit).toHaveLength(1)
      expect(hit[0]).toContain('VXSE45')
      // 対照: 要素はある電文なので、構造が変わったときの文言のほうへ落ちてはならない。
      expect(warn.mock.calls.map(c => c.join(' ')).filter(w => w.includes('Earthquake 要素がありません'))).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  // 正: `Earthquake` 要素そのものが無い電文は、座標の書式が変わった場合と別の文言で記録する。
  // 要素が無いと `Coordinate` は空文字になるので、同じ文言にまとめるとログから
  // 「電文の構造が変わった」のか「座標の書式が変わった」のかを見分けられない。
  // 取消は `Earthquake` 要素が無くても捨てない（`parseEEWFromXml` の `!isCanceled`）。その安全弁は、
  // `noEarthquake` を渡した取消電文が null にならないことを見ている箇所が固定している。
  it('Earthquake 要素が無い発表電文は構造の異常として記録する', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const xml = eewXml({ noEarthquake: true })
      expect(xml).not.toContain('<Earthquake>')
      expect(parseEEWFromXml('VXSE45', xml)).toBeNull()
      const hit = warn.mock.calls.map(c => c.join(' ')).filter(w => w.includes('Earthquake 要素がありません'))
      expect(hit).toHaveLength(1)
      expect(hit[0]).toContain('VXSE45')
      expect(warn.mock.calls.map(c => c.join(' ')).filter(w => w.includes('震源座標が読めません'))).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  // 正: 固定付加文を読む。地震情報・津波では読んでいたが EEW だけ落としていた。
  // 避難行動の呼びかけなどが入る
  it('固定付加文を読む', () => {
    const xml = eewXml({ warningComment: '強い揺れに警戒してください。' })
    expect(parseEEWFromXml('VXSE45', xml)!.warningComment).toBe('強い揺れに警戒してください。')
  })

  // 対照: 付加文が無い電文では持たない。空文字を入れると、画面に空の枠が出る
  it('固定付加文が無ければ持たない', () => {
    expect(parseEEWFromXml('VXSE45', eewXml())!.warningComment).toBeUndefined()
  })

  // 正: XML として読めない電文も同じく記録する（`parsererror` は例外にならないので見落としやすい）。
  it('XML として読めない電文を記録して捨てる', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      expect(parseEEWFromXml('VXSE45', '<Report><Head></Report>')).toBeNull()
      expect(warn.mock.calls.map(c => c.join(' ')).filter(w => w.includes('電文を読み取れなかった'))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })
})

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

// 長周期地震動の読み取りを項目ごとに固定する。
//
// フィクスチャは実電文（2024-01-01 能登半島地震の長周期地震動に関する観測情報）の構造に
// 合わせている。要点は 3 つ:
//   - Pref / Area 直下に MaxInt（震度）と MaxLgInt（長周期階級）が併存する
//   - IntensityStation は Int / LgInt に加えて LgIntPerPeriod（帯域別・複数）を持つ
//   - 観測点名に県名が入らない（例「上越市中ノ俣」）
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

describe('XML 経路が落としてはいけない項目（長周期地震動）', () => {
  const fromXml = () => parseLpgmFromXml(PARITY_LPGM_XML)!

  it('eventId・発表時刻・震源時刻・最大階級を同じに読む', () => {
    for (const l of [fromXml()]) {
      expect(l.eventId).toBe('20260813185800')
      expect(l.time).toBe('2026-08-13T19:00:00+09:00')
      expect(l.originTime).toBe('2026-08-13T18:58:00+09:00')
      expect(l.maxClass).toBe(2)
      expect(l.cancelled).toBe(false)
    }
  })

  it('区域別の最大階級を同じに読む', () => {
    for (const l of [fromXml()]) {
      expect(l.regions).toEqual([{ code: '370', name: '新潟県上越', maxLgInt: 2 }])
    }
  })

  it('観測点のコードと階級を同じに読む', () => {
    for (const l of [fromXml()]) {
      expect(l.points).toHaveLength(1)
      expect(l.points![0].code).toBe('1522201')
      expect(l.points![0].lgInt).toBe(2)
    }
  })

  // 観測点名に県名が入らないので、Pref/Name から都道府県を補って pref に持つ。
  // types/earthquake.ts の LpgmPoint.pref のコメントがこの扱いを定めている。
  it('観測点は名前に県名を含まず、pref を Pref/Name から補う', () => {
    expect(fromXml().points![0]).toEqual({ code: '1522201', name: '上越市中ノ俣', pref: '新潟県', lgInt: 2 })
  })

  it('取消電文は両経路とも cancelled=true で返す', () => {
    const xml = PARITY_LPGM_XML.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
    expect(parseLpgmFromXml(xml)!.cancelled).toBe(true)
  })

  // 対照: 対象階級（1〜4）の外は両経路とも null。階級 0 は「長周期地震動なし」であって
  // 「階級 0 の観測」ではないため、イベントとして立てない。
  it('最大階級が対象外なら両経路とも null', () => {
    const xml = PARITY_LPGM_XML.replace('<MaxLgInt>2</MaxLgInt>\n        <Pref>', '<MaxLgInt>0</MaxLgInt>\n        <Pref>')
    expect(parseLpgmFromXml(xml)).toBeNull()
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

// 長周期地震動でも「読めなかった要素」を記録する。震度点と同じ構造の穴が残っていた。
//
// **震度点との違いは「階級 0」の扱い。** `lgInt >= 1` の除外には「階級 0 ＝該当なし」という
// 正常な脱落が混ざるため、数えるのは 0 かどうかではなく **値として解釈できたか**。
// 0 を落ちた扱いにすると平常時に鳴り続ける。
describe('長周期地震動: 読めなかった要素の記録', () => {
  const captureWarnings = (run: () => void): string[] => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      run()
      return warn.mock.calls.map(c => c.join(' '))
    } finally {
      warn.mockRestore()
    }
  }
  const matching = (warnings: string[], label: string) => warnings.filter(w => w.includes(label))
  const LG_REGION = '長周期地震動の区域'
  const LG_STATION = '長周期地震動の観測点'
  const NO_LG_REGION = '階級を持つ区域を 1 件も取り出せませんでした'

  // 対照: 手を入れていない実電文どおりの形では 1 件も鳴らない
  it('そのままの電文では何も鳴らない', () => {
    expect(captureWarnings(() => { parseLpgmFromXml(PARITY_LPGM_XML) })).toHaveLength(0)
  })

  // 正: 区域の階級が数値として読めなければ記録する（XML）
  it('XML: 区域の階級が読めなければ記録する', () => {
    const broken = PARITY_LPGM_XML.replace('<Code>370</Code>\n            <MaxInt>3</MaxInt>\n            <MaxLgInt>2</MaxLgInt>', '<Code>370</Code>\n            <MaxInt>3</MaxInt>\n            <MaxLgInt>不明</MaxLgInt>')
    const warnings = captureWarnings(() => { parseLpgmFromXml(broken) })
    expect(matching(warnings, LG_REGION)).toHaveLength(1)
    expect(matching(warnings, LG_REGION)[0]).toContain('新潟県上越="不明"')
  })

  // 正: 観測点の階級が数値として読めなければ記録する（XML）
  it('XML: 観測点の階級が読めなければ記録する', () => {
    const broken = PARITY_LPGM_XML.replace('<LgInt>2</LgInt>', '<LgInt></LgInt>')
    expect(matching(captureWarnings(() => { parseLpgmFromXml(broken) }), LG_STATION)).toHaveLength(1)
  })

  /** 区域（Area）を丸ごと差し替える。`<Area>` は 1 つしかないので単純置換でよい。 */
  const withAreas = (...areas: { name: string; code: string; lgInt: string }[]) =>
    PARITY_LPGM_XML.replace(
      /<Area>[\s\S]*<\/Area>/,
      areas.map(a =>
        `<Area><Name>${a.name}</Name><Code>${a.code}</Code><MaxInt>3</MaxInt><MaxLgInt>${a.lgInt}</MaxLgInt></Area>`,
      ).join(''),
    )

  // 対照: 階級 0 は「読めている」。該当なしを表す正常な値なので鳴らしてはいけない
  it('階級 0 の区域が混ざっても鳴らない', () => {
    const xml = withAreas(
      { name: '新潟県上越', code: '370', lgInt: '2' },
      { name: '新潟県中越', code: '371', lgInt: '0' },
    )
    const warnings = captureWarnings(() => { parseLpgmFromXml(xml) })
    expect(matching(warnings, LG_REGION)).toHaveLength(0)
    expect(matching(warnings, NO_LG_REGION)).toHaveLength(0)
  })

  // 安全弁: 一部だけ読めない場合は鳴らさない（震度点と同じ「全滅のときだけ」の規則）
  it('一部だけ読めない区域では鳴らない', () => {
    const xml = withAreas(
      { name: '新潟県上越', code: '370', lgInt: '2' },
      { name: '新潟県中越', code: '371', lgInt: '不明' },
    )
    expect(matching(captureWarnings(() => { parseLpgmFromXml(xml) }), LG_REGION)).toHaveLength(0)
  })

  // 正: 電文が最大階級を名乗っているのに、その階級を持つ区域が 1 件も無い。
  // 種別ごとの検知は「元要素はあるのに読めなかった」しか拾えないため、元要素ごと
  // 見えなくなった場合（Pref/Area の位置が変わった等）はこちらで拾う
  it('最大階級を名乗るのに区域が 1 件も無ければ記録する', () => {
    const xml = PARITY_LPGM_XML.replace(/<Pref>[\s\S]*<\/Pref>/, '')
    expect(matching(captureWarnings(() => { parseLpgmFromXml(xml) }), NO_LG_REGION)).toHaveLength(1)
  })

  // 正: 最大階級そのものが読めない電文は、階級 0（正常な振り分け）と区別して記録する。
  // **この 2 つを同じ `return null` に落とすと、電文が壊れていても無言で捨てられる**——
  // 区域・観測点の階級で同じ区別をしているのに、それを読みにいくかを決めるゲートだけ
  // 素通しになっていた
  it('最大階級が読めない電文は記録して捨てる', () => {
    // 最初の <MaxLgInt> は Observation 直下（＝電文全体の最大階級）。String.replace は
    // 先頭の 1 件だけ置換するので、Pref・Area 配下の同名要素には触れない
    const xml = PARITY_LPGM_XML.replace('<MaxLgInt>2</MaxLgInt>', '<MaxLgInt>不明</MaxLgInt>')
    const xmlWarnings = captureWarnings(() => {
      expect(parseLpgmFromXml(xml)).toBeNull()
    })
    expect(xmlWarnings.filter(w => w.includes('最大長周期地震動階級を読めません'))).toHaveLength(1)
  })

  // 対照: 階級1以上を観測していない報（maxLgInt 0）は手前で null を返す正常な振り分け。
  // ここで鳴らすと、長周期地震動を伴わない地震のたびに記録が出る
  it('階級1以上を観測していない報では鳴らない', () => {
    const xml = PARITY_LPGM_XML.replace('<MaxLgInt>2</MaxLgInt>', '<MaxLgInt>0</MaxLgInt>')
    const warnings = captureWarnings(() => {
      expect(parseLpgmFromXml(xml)).toBeNull()
    })
    expect(warnings).toHaveLength(0)
  })
})

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
    expect(commentary?.id).toBe('dmdata-nankai-commentary-20260820170000-1')
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

// 津波の読み取りを項目ごとに固定する。ライブ（WebSocket）・REST 履歴・リプレイのいずれも
// この 1 本を通るので、ここが崩れると進行中の津波の見え方がまるごと変わる。
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

describe('XML 経路が落としてはいけない項目（津波）', () => {
  const fromXml = () => parseTsunamiFromXml(PARITY_TSUNAMI_XML)!

  it('等級・区域名・ただちに来襲の別を同じに読む', () => {
    for (const t of [fromXml()]) {
      expect(t.areas).toHaveLength(1)
      expect(t.areas[0].grade).toBe('MajorWarning')
      expect(t.areas[0].name).toBe('関東')
      expect(t.areas[0].immediate).toBe(true)
    }
  })

  it('eventId と原因地震を同じに読む', () => {
    for (const t of [fromXml()]) {
      expect(t.eventId).toBe('20260101120000')
      expect(t.sourceEarthquakes?.[0].hypocenterName).toBe('房総半島沖')
      expect(t.sourceEarthquakes?.[0].magnitude).toBe(8.5)
    }
  })

  it('観測点の到達時刻・押し引き・波高を同じに読む', () => {
    for (const t of [fromXml()]) {
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
    for (const t of [fromXml()]) {
      expect(t.observations![0].height?.over).toBe(true)
    }
  })

  // 対照: 振り切っていない観測値では立てない。false ではなく undefined に落とす
  // （「以上」が付かない大多数の観測点に、意味の無いフィールドを持たせない）。
  it('通常の観測値では over を立てない', () => {
    const xml = PARITY_TSUNAMI_XML.replace('description="８．５ｍ以上"', 'description="８．５ｍ"')
    expect(parseTsunamiFromXml(xml)!.observations![0].height?.over).toBeUndefined()
  })

  it('issue.source を電文の編集官署から読む', () => {
    expect(fromXml().issue.source).toBe('気象庁本庁')
  })

  // 安全弁: 表示文字列が無い電文でも数値から作る。表示・読み上げは description しか見ないため、
  // 空のまま返すと波高が画面から消える。実電文は必ず description を持つので異常時の保険。
  it('予想波高の表示文字列が無ければ数値から作る', () => {
    const xml = PARITY_TSUNAMI_XML.replace(' description="１０ｍ超"', '')
    expect(parseTsunamiFromXml(xml)!.areas[0].maxHeight?.description).toBe('10m')
  })

  // 正: 数値にならない予想波高を落とさない。
  //
  // **これが出るのは最も重大な場面。** M8 を超える地震では規模を速報できないため、気象庁は
  // 大津波警報・津波警報の第一報で高さを「巨大」「高い」と発表し、本文を "NaN" にする。
  // 数値が無いことを理由に落とすと、そのとき波高が 1 つも画面に出ない。
  //
  // **電文の形は解説資料の事例そのまま。** `condition` は固定値「不明」で、定性的表現は
  // `description` の側に入る（取り違えていた）。
  it('数値にならない予想波高（巨大・高い）を description に持つ', () => {
    const xml = PARITY_TSUNAMI_XML.replace(
      '<jmx_eb:TsunamiHeight type="津波の高さ" unit="m" description="１０ｍ超">10</jmx_eb:TsunamiHeight>',
      '<jmx_eb:TsunamiHeight type="津波の高さ" unit="m" condition="不明" description="巨大">NaN</jmx_eb:TsunamiHeight>',
    )
    const area = parseTsunamiFromXml(xml)!.areas[0]
    expect(area.maxHeight?.description).toBe('巨大')
    // 数値は持たない。`value` を 0 や NaN で埋めると、波高の比較や並べ替えが狂う
    expect(area.maxHeight?.value).toBeUndefined()
  })

  // 対照: 数値がある通常の電文では `condition` を見ない。優先順を取り違えると発表値が化ける
  it('数値がある電文では condition を採らない', () => {
    const xml = PARITY_TSUNAMI_XML.replace(
      'description="１０ｍ超">10<',
      'description="１０ｍ超" condition="不明">10<',
    )
    const area = parseTsunamiFromXml(xml)!.areas[0]
    expect(area.maxHeight?.description).toBe('10m超')
    expect(area.maxHeight?.value).toBe(10)
  })

  // 安全弁: **`condition` を表示文字列のフォールバックに使わない。**
  //
  // 解説資料いわく「定性的表現がない津波注意報や津波予報の場合は、@description は空属性となる」。
  // そこで `condition` へ落ちると、波高として**「不明」と表示・読み上げする**ことになる
  // （実際にそうなっていた）。数値も語も無ければ波高は持たせない。
  it('description が空で condition だけある電文では maxHeight を作らない', () => {
    const xml = PARITY_TSUNAMI_XML.replace(
      '<jmx_eb:TsunamiHeight type="津波の高さ" unit="m" description="１０ｍ超">10</jmx_eb:TsunamiHeight>',
      '<jmx_eb:TsunamiHeight type="津波の高さ" unit="m" condition="不明" description="">NaN</jmx_eb:TsunamiHeight>',
    )
    expect(parseTsunamiFromXml(xml)!.areas[0].maxHeight).toBeUndefined()
  })

  // 安全弁: 数値も表示文字列も無ければ、`maxHeight` そのものを作らない。
  // 空の `description` を持つオブジェクトを返すと、`hasForecastHeight` は偽なのに
  // オブジェクトはあるという食い違いが生まれる
  it('何も言えない予想波高では maxHeight を作らない', () => {
    const xml = PARITY_TSUNAMI_XML.replace(
      '<jmx_eb:TsunamiHeight type="津波の高さ" unit="m" description="１０ｍ超">10</jmx_eb:TsunamiHeight>',
      '<jmx_eb:TsunamiHeight type="津波の高さ" unit="m"></jmx_eb:TsunamiHeight>',
    )
    expect(parseTsunamiFromXml(xml)!.areas[0].maxHeight).toBeUndefined()
  })


  // 数値が読めないのに「以上」が書かれている電文。height ごと落ちるので表示は変わらないが、
  // 痕跡が残らない状態を作らない（下の空 description と対になる記録）。
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
  // description 属性が落ちると over を復元する手がかりが無くなる（電文ではこの属性が唯一の
  // 情報源）。上の「波高は読めないが over は立っていた」と対になる記録を置く。
  // 無いと「以上」が黙って通常値として扱われる。
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

// 区域の名前を読めなかったときに「正式解除」へ化けないこと。
//
// XML 経路は名前を読めない区域を捨てる（`if (!areaName) continue`）。捨てた結果 0 件になったものを
// 「気象庁による正式な解除」と解釈していたため、電文の構造が変われば
// **「津波警報が解除されました」という事実と逆の内容を発表する**——無言で消えるより重い。
describe('津波 XML: 区域を読めなかったときに解除へ化けないこと', () => {
  const captureWarnings = (run: () => void): string[] => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      run()
      return warn.mock.calls.map(c => c.join(' '))
    } finally {
      warn.mockRestore()
    }
  }
  // 区域名の要素だけを潰す（Kind/LastKind はそのまま＝「解除コードで落ちた」形にはしない）
  const breakAreaNames = (xml: string) => xml.replace(/<Name>(石川県能登|福岡県日本海沿岸|長崎県西方)<\/Name>/g, '<Name></Name>')

  // 正: 全区域の名前が読めなければ、解除にせず電文ごと捨てて記録する
  // （元電文の等級は 62・72・71 でどれも現役なので、3 件とも「解除と言えない」側に入る）
  it('全区域の名前が読めなければ解除にせず捨てる', () => {
    const broken = breakAreaNames(VTSE41_PARTIAL_LIFT_XML)
    const warnings = captureWarnings(() => {
      expect(parseTsunamiFromXml(broken)).toBeNull()
    })
    expect(warnings.filter(w => w.includes('解除済みとも判定できません'))).toHaveLength(1)
  })

  // 対照: 手を入れていない電文は従来どおり 3 区域を読み、解除にもならない
  it('そのままの電文では 3 区域を読み解除にならない', () => {
    const t = parseTsunamiFromXml(VTSE41_PARTIAL_LIFT_XML)!
    expect(t.cancelled).toBe(false)
    expect(t.areas).toHaveLength(3)
  })

  // 安全弁: **本物の解除は解除のまま。** 区域が電文から消える（Item が無い）形は気象庁の
  // 正式な解除で、名前が読めなかったわけではない。ここを巻き込むと解除が届かなくなる
  it('区域が電文から消えた形は従来どおり解除として扱う', () => {
    const lifted = VTSE41_PARTIAL_LIFT_XML.replace(/<Item>[\s\S]*<\/Item>/, '')
    const t = parseTsunamiFromXml(lifted)!
    expect(t.cancelled).toBe(true)
    expect(t.cancelReason).toBe('lifted')
  })

  // 正: **等級が現役のまま名前だけ壊れた区域**が混ざっていたら、他に解除コードの区域があっても
  // 解除にしない。他の区域の解除コードは、その区域が解除されたことしか意味しない。
  //
  // ここを通してしまうと「まだ津波予報が出ている区域について解除されましたと伝える」ことになる。
  // 元の電文では福岡（Code 72）・長崎（Code 71）がどちらも現役の津波予報
  it('現役の等級のまま名前が読めない区域があれば解除にしない', () => {
    const mixed = VTSE41_PARTIAL_LIFT_XML
      .replace('<Kind><Name>津波注意報</Name><Code>62</Code></Kind>', '<Kind><Name>津波注意報解除</Name><Code>60</Code></Kind>')
      .replace('<Name>福岡県日本海沿岸</Name>', '<Name></Name>')
      .replace('<Name>長崎県西方</Name>', '<Name></Name>')
    const warnings = captureWarnings(() => {
      expect(parseTsunamiFromXml(mixed)).toBeNull()
    })
    expect(warnings.filter(w => w.includes('解除済みとも判定できません'))).toHaveLength(1)
  })

  // 対照: 名前が読めなくても **解除コードが読めていれば** その区域は解除済み。
  // 全区域がそうなら解除として通す（「解除と言えない」区域が 0 件なので断定できる）
  it('名前が読めなくても全区域が解除コードなら解除として通す', () => {
    const allCancelled = VTSE41_PARTIAL_LIFT_XML
      .replace('<Code>62</Code></Kind>', '<Code>60</Code></Kind>')
      .replace('<Code>72</Code></Kind>', '<Code>60</Code></Kind>')
      .replace('<Code>71</Code></Kind>', '<Code>60</Code></Kind>')
      .replace('<Name>福岡県日本海沿岸</Name>', '<Name></Name>')
    const t = parseTsunamiFromXml(allCancelled)
    expect(t).not.toBeNull()
    expect(t!.cancelled).toBe(true)
    expect(t!.cancelReason).toBe('lifted')
  })

  // 読めなかった区域があった事実は、解除として通す場合でも記録する
  it('解除として通す場合でも読めなかった区域を記録する', () => {
    const allCancelled = VTSE41_PARTIAL_LIFT_XML
      .replace('<Code>62</Code></Kind>', '<Code>60</Code></Kind>')
      .replace('<Code>72</Code></Kind>', '<Code>60</Code></Kind>')
      .replace('<Code>71</Code></Kind>', '<Code>60</Code></Kind>')
      .replace('<Name>福岡県日本海沿岸</Name>', '<Name></Name>')
    const warnings = captureWarnings(() => { parseTsunamiFromXml(allCancelled) })
    expect(warnings.filter(w => w.includes('名前を読めませんでした'))).toHaveLength(1)
  })

  // 有効な区域が残ったまま一部だけ解除コードで落ちる形。**気象庁は一部解除でも区域を電文から
  // 消さず等級の降格として載せる**ため実電文では稀だが、コード自身がこれを
  // 「区域単位の等級変化として検出できない」既知のリスクとして名指ししている
  // （→ docs/spec/tsunami-spec.md §10）。この関数は判定を何度も書き換えているので、
  // 隣接する経路が黙って壊れないよう記録が出ることだけ固定しておく
  it('一部だけ解除コードで落ちたら記録する（残りは通常の津波として成立）', () => {
    const partialLift = VTSE41_PARTIAL_LIFT_XML
      .replace('<Kind><Name>津波注意報</Name><Code>62</Code></Kind>', '<Kind><Name>津波注意報解除</Name><Code>60</Code></Kind>')
    const warnings = captureWarnings(() => {
      const t = parseTsunamiFromXml(partialLift)!
      expect(t.cancelled).toBe(false)
      expect(t.areas).toHaveLength(2)
    })
    expect(warnings.filter(w => w.includes('解除コードで落ちた区域があります'))).toHaveLength(1)
  })

  // 安全弁: 一部の区域だけ名前が読めない場合は、読めた区域で通常どおり成立させる。
  // 0 件になったときだけ解除との取り違えが起きるので、そこ以外は止めない
  it('一部の区域だけ読めない場合は残りで成立する', () => {
    const partial = VTSE41_PARTIAL_LIFT_XML.replace('<Name>石川県能登</Name>', '<Name></Name>')
    const t = parseTsunamiFromXml(partial)!
    expect(t.cancelled).toBe(false)
    expect(t.areas).toHaveLength(2)
  })
})

// 取消・全解除・原因地震の欠落は、いずれも「津波が消える」経路。
describe('津波の取消・全解除・原因地震', () => {
  it('InfoType=取消 なら cancelled=true・cancelReason=retracted・areas 空', () => {
    const xml = PARITY_TSUNAMI_XML.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
    const t = parseTsunamiFromXml(xml)!
    expect(t.cancelled).toBe(true)
    expect(t.cancelReason).toBe('retracted')
    expect(t.areas).toEqual([])
  })

  // 全区域が解除系コードなら、電文としては発表でも中身は「津波なし」。
  // 取消（誤報の取り下げ）とは理由が違うので cancelReason で区別する。
  // 対照: EventID が空の電文で空文字を持たせない。津波の同一性判定はこのキーを使うので、
  // 空文字が入ると「EventID を持つ別の津波」と区別できなくなる。
  it('EventID が空なら eventId を持たない', () => {
    const xml = PARITY_TSUNAMI_XML.replace('<EventID>20260101120000</EventID>', '<EventID></EventID>')
    expect(parseTsunamiFromXml(xml)!.eventId).toBeUndefined()
  })

  it('全区域が解除系コード（60）なら areas=[] で cancelReason=lifted', () => {
    const xml = PARITY_TSUNAMI_XML
      .replace('<Kind><Name>大津波警報：発表</Name><Code>52</Code></Kind>', '<Kind><Name>津波警報解除</Name><Code>60</Code></Kind>')
    const t = parseTsunamiFromXml(xml)!
    expect(t.areas).toEqual([])
    expect(t.cancelReason).toBe('lifted')
  })

  // 対照: 震源名が無ければ原因地震を名乗らない（空文字の見出しを作らない）。
  // 正: 規模が数値で求まらないとき、気象庁が添えた説明を持つ。
  //
  // **「規模不明」と「Ｍ８を超える巨大地震」は別物。** 後者は M8 を超えていて速報できない
  // ことを表し、同じ電文で予想波高が「巨大」「高い」になる。数値が無いことだけを見て
  // 「不明」と出すと、最大級の地震ほど画面が薄くなる。
  it('規模が数値で求まらないときは説明を持つ', () => {
    const xml = PARITY_TSUNAMI_XML.replace(
      '<jmx_eb:Magnitude type="Mj">8.5</jmx_eb:Magnitude>',
      '<jmx_eb:Magnitude type="Mj" condition="不明" description="Ｍ８を超える巨大地震">NaN</jmx_eb:Magnitude>',
    )
    const eq = parseTsunamiFromXml(xml)!.sourceEarthquakes![0]
    expect(eq.magnitude).toBeUndefined()
    expect(eq.magnitudeCondition).toBe('Ｍ８を超える巨大地震')
  })

  // 対照: 数値が読めるときは説明を持たない。両方を持たせると表示が二重になる
  it('規模が読めるときは説明を持たない', () => {
    const eq = parseTsunamiFromXml(PARITY_TSUNAMI_XML)!.sourceEarthquakes![0]
    expect(eq.magnitude).toBe(8.5)
    expect(eq.magnitudeCondition).toBeUndefined()
  })

  // 正: 原因地震が複数ある電文で全件を読む。短い間に起きた地震がまとめて 1 つの
  // 津波情報として発表されることがあり、1 件目だけ読むと残りが画面から消える
  it('原因地震が複数あれば全件を持つ', () => {
    const second = [
      '<Earthquake>',
      '<OriginTime>2026-01-01T12:05:00+09:00</OriginTime>',
      '<Hypocenter><Area><Name>三陸沖</Name></Area></Hypocenter>',
      '<jmx_eb:Magnitude type="Mj">7.2</jmx_eb:Magnitude>',
      '</Earthquake>',
    ].join('')
    const xml = PARITY_TSUNAMI_XML.replace('</Earthquake>', '</Earthquake>' + second)
    const eqs = parseTsunamiFromXml(xml)!.sourceEarthquakes!
    expect(eqs).toHaveLength(2)
    expect(eqs.map(e => e.hypocenterName)).toEqual(['房総半島沖', '三陸沖'])
  })

  // 安全弁: 名前を読めない地震は落とす（画面に出しようがない）。**残りは残す** ——
  // 1 件読めないだけで全部捨てると、読めた震源まで画面から消える
  it('名前を読めない地震だけを落とし、残りは残す', () => {
    const broken = [
      '<Earthquake>',
      '<OriginTime>2026-01-01T12:05:00+09:00</OriginTime>',
      '<Hypocenter><Area></Area></Hypocenter>',
      '<jmx_eb:Magnitude type="Mj">7.2</jmx_eb:Magnitude>',
      '</Earthquake>',
    ].join('')
    const xml = PARITY_TSUNAMI_XML.replace('</Earthquake>', '</Earthquake>' + broken)
    const eqs = parseTsunamiFromXml(xml)!.sourceEarthquakes!
    expect(eqs).toHaveLength(1)
    expect(eqs[0].hypocenterName).toBe('房総半島沖')
  })

  it('震源名が無ければ原因地震を持たない', () => {
    const xml = PARITY_TSUNAMI_XML.replace('<Hypocenter><Area><Name>房総半島沖</Name></Area></Hypocenter>', '<Hypocenter><Area></Area></Hypocenter>')
    expect(parseTsunamiFromXml(xml)!.sourceEarthquakes).toBeUndefined()
  })
})

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
    // 観測できていた事実（ここでは大津波警報の基準超え）が画面から消える。
    // description の「以上」は観測可能範囲の超過を表すため over も立つ
    // （→ docs/spec/tsunami-spec.md §6「観測波高の「以上」」）
    // 表示文字列の期待値を全角から半角へ覆した。電文の原文は全角だが、画面と読み上げは
    // ずっと半角で出してきた（→ 下記「波高の表示文字列は半角に揃える」）。
    expect(miyako.height).toEqual({ value: 3.2, description: '3.2m以上', over: true })
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


  it('安全弁: 状態を持たない観測点に condition を作らない', () => {
    const t = parseTsunamiFromXml(VTSE41_PARTIAL_LIFT_XML)
    // 区域だけの電文（観測点なし）でも壊れないこと
    expect(t!.observations).toBeUndefined()
  })
})

// VXSE61（顕著な地震の震源要素更新のお知らせ）は Coordinate を 2 つ持つ。
// 1 つ目は度単位へ丸めた値で、電文自身が「度単位の震源要素は、津波情報等を引き続き
// 発表する場合に使用されます」と用途を断っている。震源要素として採るのは 2 つ目の
// type="震源位置（度分）"（実電文 2026-06-25 岩手県沖 M7.2 の写し）。
const VXSE61_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control>
<Title>顕著な地震の震源要素更新のお知らせ</Title>
<DateTime>2026-06-25T01:15:12Z</DateTime>
<Status>通常</Status>
<EditorialOffice>気象庁本庁</EditorialOffice>
<PublishingOffice>気象庁</PublishingOffice>
</Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>顕著な地震の震源要素更新のお知らせ</Title>
<ReportDateTime>2026-06-25T10:15:00+09:00</ReportDateTime>
<TargetDateTime>2026-06-25T10:15:00+09:00</TargetDateTime>
<EventID>20260625073021</EventID>
<InfoType>発表</InfoType>
<Serial></Serial>
<InfoKind>震源要素更新のお知らせ</InfoKind>
<InfoKindVersion>1.0_0</InfoKindVersion>
<Headline><Text>令和　８年　６月２５日１０時１５分をもって、地震の発生場所と規模を更新します。</Text></Headline>
</Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Earthquake>
<OriginTime>2026-06-25T07:30:00+09:00</OriginTime>
<ArrivalTime>2026-06-25T07:30:00+09:00</ArrivalTime>
<Hypocenter><Area>
<Name>岩手県沖</Name>
<Code type="震央地名">286</Code>
<jmx_eb:Coordinate description="北緯４０．２度　東経１４２．３度　深さ　４０ｋｍ">+40.2+142.3-40000/</jmx_eb:Coordinate>
<jmx_eb:Coordinate type="震源位置（度分）" description="北緯４０度１２．６分　東経１４２度１８．２分　深さ　４４ｋｍ">+4012.6+14218.2-44000/</jmx_eb:Coordinate>
</Area></Hypocenter>
<jmx_eb:Magnitude type="Mj" description="Ｍ７．２">7.2</jmx_eb:Magnitude>
</Earthquake>
<Comments><FreeFormComment>度単位の震源要素は、津波情報等を引き続き発表する場合に使用されます。</FreeFormComment></Comments>
</Body>
</Report>`


// 沖合の観測から導いた沿岸への推定（VTSE52 の `Estimation`）。
//
// 沖合の観測点は沿岸より先に津波を捉えるため、ここには**まだ到達していない沿岸**の
// 到達予想と高さが入る。観測値でも気象庁の発表値でもないので、実測と混ぜない。
const VTSE52_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">',
  '<Control><Title>沖合の津波観測に関する情報</Title><Status>通常</Status><EditorialOffice>気象庁</EditorialOffice></Control>',
  '<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">',
  '<Title>沖合の津波観測に関する情報</Title>',
  '<ReportDateTime>2026-01-01T12:30:00+09:00</ReportDateTime>',
  '<EventID>20260101120000</EventID><InfoType>発表</InfoType><Serial>1</Serial>',
  '</Head>',
  '<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">',
  '<Tsunami>',
  '<Observation>',
  '<Item><Area><Name>三陸沖北部</Name><Code>901</Code></Area>',
  '<Station><Name>岩手中部沖</Name><Code>21401</Code>',
  '<MaxHeight><jmx_eb:TsunamiHeight type="最大波の高さ" unit="m" description="１．２ｍ">1.2</jmx_eb:TsunamiHeight></MaxHeight>',
  '</Station></Item>',
  '</Observation>',
  '<Estimation>',
  '<Item><Area><Name>岩手県</Name><Code>210</Code></Area>',
  '<FirstHeight><ArrivalTime>2026-01-01T12:50:00+09:00</ArrivalTime></FirstHeight>',
  '<MaxHeight><jmx_eb:TsunamiHeight type="津波の高さ" unit="m" description="３ｍ">3</jmx_eb:TsunamiHeight></MaxHeight>',
  '</Item>',
  '<Item><Area><Name>宮城県</Name><Code>220</Code></Area>',
  '<FirstHeight><Condition>早いところでは既に津波到達と推定</Condition></FirstHeight>',
  '</Item>',
  '</Estimation>',
  '</Tsunami>',
  '</Body></Report>',
].join('')

describe('沖合の観測から導いた沿岸への推定（VTSE52）', () => {
  // 正: 区域名・到達予想時刻・予想高さを読む
  it('推定の区域名・到達予想時刻・高さを読む', () => {
    const est = parseTsunamiFromXml(VTSE52_XML)!.estimations!
    expect(est).toHaveLength(2)
    expect(est[0].name).toBe('岩手県')
    expect(est[0].code).toBe('210')
    expect(est[0].arrivalTime).toBe('2026-01-01T12:50:00+09:00')
    expect(est[0].maxHeight).toEqual({ description: '3m', value: 3 })
  })

  // 正: 時刻を出せないときの説明を読む。ここを落とすと、既に到達している可能性が伝わらない
  it('時刻の代わりの説明を読む', () => {
    const est = parseTsunamiFromXml(VTSE52_XML)!.estimations!
    expect(est[1].arrivalTime).toBeUndefined()
    expect(est[1].arrivalCondition).toBe('早いところでは既に津波到達と推定')
  })

  // 対照: 沖合の実測は観測点として読む（推定と混ざらない）
  it('沖合の実測は観測点として読み、推定と混ぜない', () => {
    const t = parseTsunamiFromXml(VTSE52_XML)!
    expect(t.observations!.map(o => o.name)).toEqual(['岩手中部沖'])
    expect(t.estimations!.map(e => e.name)).toEqual(['岩手県', '宮城県'])
  })

  // 安全弁: `Estimation` を持たない電文では作らない。空配列を返すと、画面が
  // 「推定あり」の見出しだけを出す
  it('Estimation が無い電文では持たない', () => {
    expect(parseTsunamiFromXml(PARITY_TSUNAMI_XML)!.estimations).toBeUndefined()
  })
})

describe('震源要素更新（VXSE61）は「度分」の座標を採る', () => {
  // 正: 度分の座標を 10 進度へ直した値になる。
  // 度単位のほうを採ると 40.2 / 142.3 / 深さ 40km になり、最大 1.2km ずれる。
  it('度分の座標を 10 進度で返す', () => {
    const q = parseEarthquakeFromXml('VXSE61', VXSE61_XML)!
    expect(q.earthquake.hypocenter.latitude).toBe(40.21)
    expect(q.earthquake.hypocenter.longitude).toBe(142.3033)
    expect(q.earthquake.hypocenter.depth).toBe(44)
  })

  // 正: 規模も併せて読む（座標だけ直して規模を落とす、という壊し方を塞ぐ）。
  it('規模も同じ電文から読む', () => {
    expect(parseEarthquakeFromXml('VXSE61', VXSE61_XML)!.earthquake.hypocenter.magnitude).toBe(7.2)
  })

  // 丸めた側へ落ちたことを数える。parseEarthquakeFromXml は別の理由でも警告を出すため、
  // `not.toHaveBeenCalled()` で見ると無関係な警告が増えたときに目的と関係なく落ちる。
  const fallbackWarnCount = (calls: unknown[][]) =>
    calls.filter(c => String(c[0]).includes('度単位へ丸めた座標を使います')).length

  const withWarnSpy = <T,>(fn: () => T): { value: T; warns: number } => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      return { value: fn(), warns: fallbackWarnCount(warn.mock.calls) }
    } finally {
      warn.mockRestore()
    }
  }

  // 対照: 正常な電文では記録を残さない。鳴りっぱなしだと本物の異常が埋もれる。
  it('度分を読めたときは記録を残さない', () => {
    expect(withWarnSpy(() => parseEarthquakeFromXml('VXSE61', VXSE61_XML)!).warns).toBe(0)
  })

  // 安全弁: VXSE61 なのに度分が無い電文。度単位へ落ちること自体は許すが、黙って落ちない。
  // ずれは有効な座標の形をしていて画面にも読み上げにも異常として出ないため、記録が唯一の手がかり。
  it('VXSE61 に度分が無ければ度単位へ落ちたことを記録する', () => {
    const xml = VXSE61_XML.replace(/<jmx_eb:Coordinate type="震源位置（度分）"[\s\S]*?<\/jmx_eb:Coordinate>/, '')
    const r = withWarnSpy(() => parseEarthquakeFromXml('VXSE61', xml)!)
    expect(r.value.earthquake.hypocenter.latitude).toBe(40.2)
    expect(r.value.earthquake.hypocenter.depth).toBe(40)
    expect(r.warns).toBe(1)
  })

  // 安全弁: 度分として読めない値（分が 60 以上）。度単位の値を誤って度分の要素へ入れた電文が
  // これにあたる。「0 度 40.2 分」＝ 0.67 度という有限だが全く違う座標にせず、丸めた側へ落とす。
  it('度分が壊れていれば度単位へ落として記録する', () => {
    const xml = VXSE61_XML.replace('+4012.6+14218.2-44000/', '+40.2+142.3-44000/')
    const r = withWarnSpy(() => parseEarthquakeFromXml('VXSE61', xml)!)
    expect(r.value.earthquake.hypocenter.latitude).toBe(40.2)
    expect(r.value.earthquake.hypocenter.longitude).toBe(142.3)
    expect(r.warns).toBe(1)
  })

  // 安全弁: 分が 60 以上の値（分として成り立たない）。`degreeMinuteToDegrees` の `min < 60` は
  // 突き合わせとは別の防御で、こちらは**突き合わせる相手が無くても**効く。閾値の向きが
  // 静かに反転しても気づけるよう、この分岐だけを踏むケースを固定しておく。
  it('分が 60 以上の度分は採らない', () => {
    const xml = VXSE61_XML.replace('+4012.6+14218.2-44000/', '+4065.5+14218.2-44000/')
    const r = withWarnSpy(() => parseEarthquakeFromXml('VXSE61', xml)!)
    expect(r.value.earthquake.hypocenter.latitude).toBe(40.2)
    expect(r.warns).toBe(1)
  })

  // 突き合わせる相手（度単位の座標）を消した電文。`degreeMinuteCoordProblem` は相手が無いと
  // 無条件に許すので、ここで効くのは `degreeMinuteToDegrees` の `min < 60` だけになる。
  const dmOnly = (coord: string) => VXSE61_XML
    .replace(/<jmx_eb:Coordinate description=[^>]*>[^<]*<\/jmx_eb:Coordinate>/, '')
    .replace('+4012.6+14218.2-44000/', coord)

  // 対照: 度単位を消しただけなら、度分がそのまま読める（下の安全弁が「消したせい」で
  // 通っているのではないことを示す）。
  it('度分しか無い電文でも度分を読む', () => {
    const q = parseEarthquakeFromXml('VXSE61', dmOnly('+4012.6+14218.2-44000/'))!
    expect(q.earthquake.hypocenter.latitude).toBe(40.21)
  })

  // 安全弁: 分が 60 以上（分として成り立たない値）。突き合わせが使えないこの経路では
  // `min < 60` だけが防御になる。採ってしまうと 41.09 度という有限だが誤った座標が流れる。
  it('突き合わせる相手が無くても分が 60 以上の度分は採らない', () => {
    expect(parseEarthquakeFromXml('VXSE61', dmOnly('+4065.5+14218.2-44000/'))).toBeNull()
  })

  // 対照: 度分の座標を持たない電文（VXSE53 等）は従来どおり度単位の座標を読む。
  // 選び方を「常に 2 つ目」にすると、この経路が壊れる。
  it('度分の座標を持たない電文は 1 つ目の座標を読む', () => {
    const q = parseEarthquakeFromXml('VXSE53', VXSE53_XML)!
    expect(Number.isFinite(q.earthquake.hypocenter.latitude)).toBe(true)
    expect(q.earthquake.hypocenter.latitude).toBeGreaterThan(20)
    expect(q.earthquake.hypocenter.latitude).toBeLessThan(50)
  })
})


// 気象庁の原文は全角（"０．２ｍ未満"）だが、画面と読み上げはずっと半角で出してきた。
// 原文のまま流すと同じ値でも全角と半角が混じって並ぶ。実電文 62 通の照合で 375 箇所ずれていた。
describe('波高の表示文字列は半角に揃える', () => {
  const xmlWith = (desc: string) => PARITY_TSUNAMI_XML.replace('description="８．５ｍ以上"', `description="${desc}"`)

  // 正: 全角の数字・小数点・単位を半角へ直す。
  it('全角の数字・小数点・単位を半角にする', () => {
    const t = parseTsunamiFromXml(xmlWith('０．２ｍ'))!
    expect(t.observations![0].height?.description).toBe('0.2m')
  })

  // 安全弁: 「未満」「以上」「超」といった語は残す。数字だけを見て組み直すと、
  // 「０．２ｍ未満」（津波予報・若干の海面変動）が「0.2m」に化けて意味が変わる。
  it('数値に添えられた語は落とさない', () => {
    expect(parseTsunamiFromXml(xmlWith('０．２ｍ未満'))!.observations![0].height?.description).toBe('0.2m未満')
    expect(parseTsunamiFromXml(xmlWith('８．５ｍ以上'))!.observations![0].height?.description).toBe('8.5m以上')
  })

  // 対照: 数字を含まない表示文字列（「巨大」「高い」）はそのまま通す。
  it('数値で表せない波高はそのまま残す', () => {
    expect(parseTsunamiFromXml(xmlWith('巨大'))!.observations![0].height?.description).toBe('巨大')
  })

  // 安全弁: 前後の空白は落とす（実電文に先頭が全角空白の "　１ｍ" があった）。
  it('前後の空白を落とす', () => {
    expect(parseTsunamiFromXml(xmlWith('　１ｍ'))!.observations![0].height?.description).toBe('1m')
  })

  // 安全弁: over の判定は生の description を見ている。半角化した文字列で判定するように
  // 変えても「以上」は残るので通ってしまうが、判定の入力を取り違えないことを固定しておく。
  it('半角化しても「以上」から over を立てる', () => {
    expect(parseTsunamiFromXml(xmlWith('８．５ｍ以上'))!.observations![0].height?.over).toBe(true)
    expect(parseTsunamiFromXml(xmlWith('８．５ｍ'))!.observations![0].height?.over).toBeUndefined()
  })
})

// EEW の XML 電文（VXSE45）。実電文 2026-09-03 福島県会津 M3.5 の写しを最小化したもの。
// 予報級・最終報。取消・警報級は下でこれを書き換えて作る。
const EEW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>緊急地震速報（地震動予報）</Title><DateTime>2026-09-03T13:35:37Z</DateTime><Status>通常</Status><EditorialOffice>気象庁本庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>緊急地震速報（地震動予報）</Title>
<ReportDateTime>2026-09-03T22:35:37+09:00</ReportDateTime>
<TargetDateTime>2026-09-03T22:35:37+09:00</TargetDateTime>
<EventID>20260903223458</EventID>
<InfoType>発表</InfoType>
<Serial>3</Serial>
<InfoKind>緊急地震速報</InfoKind>
<InfoKindVersion>1.2_0</InfoKindVersion>
</Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<NextAdvisory>この情報をもって、緊急地震速報：最終報とします。</NextAdvisory>
<Earthquake>
<OriginTime>2026-09-03T22:34:56+09:00</OriginTime>
<ArrivalTime>2026-09-03T22:34:58+09:00</ArrivalTime>
<Hypocenter><Area>
<Name>福島県会津</Name>
<Code type="震央地名">252</Code>
<jmx_eb:Coordinate description="北緯３７．２度　東経１３９．３度　深さ　１０ｋｍ">+37.2+139.3-10000/</jmx_eb:Coordinate>
<ReduceName>福島県</ReduceName>
</Area></Hypocenter>
<jmx_eb:Magnitude type="Mj" description="Ｍ３．５">3.5</jmx_eb:Magnitude>
</Earthquake>
<Intensity><Forecast>
<ForecastInt><From>2</From><To>2</To></ForecastInt>
<ForecastLgInt><From>0</From><To>0</To></ForecastLgInt>
</Forecast></Intensity>
</Body>
</Report>`

// 警報級（実電文 2024-08-09 の写し）。区域の Kind が「緊急地震速報（警報）」で、
// 区域側にも Condition（「既に主要動到達と推測」）が入る。
const EEW_WARNING_PREF = `<Pref><Name>神奈川</Name><Code>9140</Code><Area>
<Name>神奈川県東部</Name><Code>360</Code>
<Category><Kind><Name>緊急地震速報（警報）</Name><Code>11</Code></Kind></Category>
<ForecastInt><From>5-</From><To>5-</To></ForecastInt>
<ForecastLgInt><From>1</From><To>1</To></ForecastLgInt>
<Condition>既に主要動到達と推測</Condition>
</Area></Pref>`

describe('parseEEWFromXml（VXSE45 の XML 経路）', () => {
  // 正: 震源・予想最大震度・最終報を読む。
  it('予報級の報を読む', () => {
    const e = parseEEWFromXml('VXSE45', EEW_XML)!
    expect(e.issue).toEqual({ eventId: '20260903223458', serial: '3', time: '2026-09-03T22:35:37+09:00' })
    expect(e.earthquake.hypocenter).toEqual({ name: '福島県会津', latitude: 37.2, longitude: 139.3, depth: 10, magnitude: 3.5 })
    expect(e.forecastMaxScale).toBe(20)
    expect(e.severity).toBe('Forecast')
    expect(e.isFinal).toBe(true)
    expect(e.areas).toEqual([])
  })

  // 対照: 最終報の文言が無ければ isFinal は立たない。
  it('最終報の文言が無ければ isFinal を立てない', () => {
    const xml = EEW_XML.replace(/<NextAdvisory>[^<]*<\/NextAdvisory>/, '')
    expect(parseEEWFromXml('VXSE45', xml)!.isFinal).toBe(false)
  })

  // 正: 区域の Kind が「緊急地震速報（警報）」なら警報級として扱う。
  it('区域の Kind から警報級を判定し、区域を読む', () => {
    const xml = EEW_XML.replace('</Forecast>', `${EEW_WARNING_PREF}</Forecast>`)
    const e = parseEEWFromXml('VXSE45', xml)!
    expect(e.severity).toBe('Warning')
    expect(e.areas).toEqual([{
      pref: '', name: '神奈川県東部', scaleFrom: 45, scaleTo: 45,
      kindCode: '11', arrivalTime: null, lgIntTo: 1,
    }])
  })

  // 対照: 予報の Kind しか無ければ警報級にしない。
  it('予報の区域だけなら警報級にしない', () => {
    const xml = EEW_XML.replace('</Forecast>', `${EEW_WARNING_PREF.replace('緊急地震速報（警報）', '緊急地震速報（予報）').replace('<Code>11</Code>', '<Code>00</Code>')}</Forecast>`)
    const e = parseEEWFromXml('VXSE45', xml)!
    expect(e.severity).toBe('Forecast')
    expect(e.areas![0].kindCode).toBe('00')
  })

  // 安全弁: Condition は要素の位置で意味が変わる。Earthquake 直下は震源の状態（「仮定震源要素」）、
  // Pref/Area 直下は区域の状態（「既に主要動到達と推測」）。子孫から拾うと、警報級の電文で
  // 区域側の文言が震源の condition に化け、仮定震源要素の判定が誤って立つ。
  it('区域の Condition を震源の condition に混ぜない', () => {
    const xml = EEW_XML.replace('</Forecast>', `${EEW_WARNING_PREF}</Forecast>`)
    expect(parseEEWFromXml('VXSE45', xml)!.earthquake.condition).toBe('')
  })

  // 正: 震源側の Condition は読む（仮定震源要素。表示・読み上げを抑える判定に使う）。
  it('震源の Condition（仮定震源要素）は読む', () => {
    const xml = EEW_XML.replace('<OriginTime>', '<Condition>仮定震源要素</Condition><OriginTime>')
    expect(parseEEWFromXml('VXSE45', xml)!.earthquake.condition).toBe('仮定震源要素')
  })

  // 安全弁: 上限を定めない予想震度（To が over）を震度7に読まない。下限へ寄せて「以上」を持つ。
  it('To が over の予想震度は下限＋「以上」にする', () => {
    const xml = EEW_XML.replace('<ForecastInt><From>2</From><To>2</To></ForecastInt>', '<ForecastInt><From>4</From><To>over</To></ForecastInt>')
    const e = parseEEWFromXml('VXSE45', xml)!
    expect(e.forecastMaxScale).toBe(40)
    expect(e.forecastMaxScaleOrAbove).toBe(true)
  })

  // 安全弁: 取消は Head/InfoType で伝わる。座標は「位置不明」センチネルにし、区域は空にする。
  it('取消は座標をセンチネルにして区域を空にする', () => {
    const xml = EEW_XML.replace('<InfoType>発表</InfoType>', '<InfoType>取消</InfoType>')
      .replace('</Forecast>', `${EEW_WARNING_PREF}</Forecast>`)
    const e = parseEEWFromXml('VXSE45', xml)!
    expect(e.cancelled).toBe(true)
    expect(e.earthquake.hypocenter.latitude).toBe(-200)
    expect(e.earthquake.hypocenter.longitude).toBe(-200)
    expect(e.areas).toEqual([])
    expect(e.forecastMaxScale).toBeUndefined()
  })
})

// EEW_XML が読めていることを、項目ごとに固定する。かつては JSON 版のパーサーと突き合わせて
// いたが、経路を XML へ一本化したので比較相手が無くなった。**値そのものを書き留める形へ変えた**
// ——実電文 24 通で JSON 版と差分ゼロを確認した時点の値なので、ここが崩れたら退行と分かる。
describe('XML 経路が落としてはいけない項目（EEW）', () => {
  const parsed = () => parseEEWFromXml('VXSE45', EEW_XML)!

  // 正: カードの同一性・続報の判定に使う識別子。
  it('id と issue（イベント ID・報番号・発表時刻）を持つ', () => {
    expect(parsed().id).toBe('dmdata-eew-20260903223458-3')
    expect(parsed().issue).toEqual({ eventId: '20260903223458', serial: '3', time: '2026-09-03T22:35:37+09:00' })
  })

  // 正: 震源要素。予報円・地図・読み上げがすべてここを見る。
  it('震源要素（名前・緯度経度・深さ・規模）を持つ', () => {
    expect(parsed().earthquake.hypocenter).toEqual({
      name: '福島県会津', latitude: 37.2, longitude: 139.3, depth: 10, magnitude: 3.5,
    })
  })

  it('発生時刻・到達時刻・震源の状態を持つ', () => {
    const e = parsed().earthquake
    expect([e.originTime, e.arrivalTime, e.condition])
      .toEqual(['2026-09-03T22:34:56+09:00', '2026-09-03T22:34:58+09:00', ''])
  })

  it('予想最大震度・長周期階級・区分・最終報を持つ', () => {
    const e = parsed()
    expect(e.forecastMaxScale).toBe(20)
    // 階級 0 は「階級なし」。1〜4 だけが有効なので undefined に落とす。
    expect(e.forecastMaxLpgmClass).toBeUndefined()
    expect(e.severity).toBe('Forecast')
    expect(e.isFinal).toBe(true)
    expect(e.cancelled).toBe(false)
  })

  // 正: 警報級の区域。予想震度の区域塗りと読み上げに直結する。
  it('警報級の区域を読む', () => {
    const xml = EEW_XML.replace('</Forecast>', `${EEW_WARNING_PREF}</Forecast>`)
    const e = parseEEWFromXml('VXSE45', xml)!
    expect(e.severity).toBe('Warning')
    expect(e.areas).toEqual([{
      pref: '', name: '神奈川県東部', scaleFrom: 45, scaleTo: 45,
      kindCode: '11', arrivalTime: null, lgIntTo: 1,
    }])
  })

  // 安全弁: 上限を定めない予想震度（`To` が over）を震度7に読まない。下限へ寄せて「以上」を持つ。
  it('上限のない予想震度は下限＋「以上」にする', () => {
    const xml = EEW_XML.replace('<ForecastInt><From>2</From><To>2</To></ForecastInt>', '<ForecastInt><From>4</From><To>over</To></ForecastInt>')
    const e = parseEEWFromXml('VXSE45', xml)!
    expect(e.forecastMaxScale).toBe(40)
    expect(e.forecastMaxScaleOrAbove).toBe(true)
  })
})
