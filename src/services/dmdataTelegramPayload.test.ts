// @vitest-environment jsdom
// 電文の読み取りが XML に一本化されたため、DOMParser を使う jsdom 環境で動かす（既定は node）。
// アプリが受け取る電文の入口（購読分類・EEW 種別）を固定するテスト。
//
// 守りたいのは「VXSE43（緊急地震速報・警報）を取り込まない」こと。取り込むと遅れて届く複製が
// 新しい VXSE45 を上書きし、地図の区域塗りが削られる（根拠と実害は
// docs/spec/data-sources-spec.md §2「EEW は VXSE45 だけを受ける」）。
// この集合はライブ（services/dmdata.ts）とリプレイ（dmdataReplay.ts / dmdataReplayLive.ts）が
// 共有する。かつて二重定義でライブ側だけ VXSE43 を含み、ライブでのみ塗りが削られていた。
import { describe, it, expect } from 'vitest'
import { CLASSIFICATIONS, EEW_TYPES, HANDLED_TYPES, buildXmlPayload } from './dmdataTelegramPayload'

// 2024-01-01 能登半島地震の緊急地震速報（地震動予報・警報級）を最小化したもの。
const EEW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>緊急地震速報（地震動予報）</Title><Status>通常</Status><EditorialOffice>気象庁本庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>緊急地震速報（地震動予報）</Title>
<ReportDateTime>2024-01-01T16:11:07+09:00</ReportDateTime>
<EventID>20240101161010</EventID>
<InfoType>発表</InfoType>
<Serial>30</Serial>
</Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Earthquake>
<OriginTime>2024-01-01T16:10:10+09:00</OriginTime>
<ArrivalTime>2024-01-01T16:10:10+09:00</ArrivalTime>
<Hypocenter><Area><Name>石川県能登地方</Name><jmx_eb:Coordinate>+37.5+137.2-10000/</jmx_eb:Coordinate></Area></Hypocenter>
<jmx_eb:Magnitude type="Mj">7.6</jmx_eb:Magnitude>
</Earthquake>
<Intensity><Forecast>
<ForecastInt><From>7</From><To>7</To></ForecastInt>
<Pref><Name>石川</Name><Code>9170</Code><Area>
<Name>石川県能登</Name><Code>390</Code>
<Category><Kind><Name>緊急地震速報（警報）</Name><Code>11</Code></Kind></Category>
<ForecastInt><From>6+</From><To>7</To></ForecastInt>
</Area></Pref>
</Forecast></Intensity>
</Body>
</Report>`

describe('EEW として扱う電文種別', () => {
  it('VXSE45（地震動予報）は取り込む', () => {
    expect(EEW_TYPES.has('VXSE45')).toBe(true)
    expect(HANDLED_TYPES.has('VXSE45')).toBe(true)
  })

  // 対照: 取り込まないことがこの修正の本体。含めると新しい予想が古い複製で上書きされる。
  it('VXSE43（警報）は取り込まない', () => {
    expect(EEW_TYPES.has('VXSE43')).toBe(false)
    expect(HANDLED_TYPES.has('VXSE43')).toBe(false)
  })

  // VXSE44（予報）は廃止予定で、同時刻の VXSE45 より区域が少ない（能登本震で 45 対 77）。
  it('VXSE44（予報・廃止予定）も取り込まない', () => {
    expect(EEW_TYPES.has('VXSE44')).toBe(false)
  })

  it('種別が対象外なら電文本体があってもペイロードを作らない', () => {
    expect(buildXmlPayload('VXSE43', EEW_XML)).toBeNull()
    expect(buildXmlPayload('VXSE44', EEW_XML)).toBeNull()
  })

  it('VXSE45 はペイロードを作る（区域も落とさない）', () => {
    const payload = buildXmlPayload('VXSE45', EEW_XML)
    expect(payload?.kind).toBe('event')
    const event = payload?.kind === 'event' ? payload.event : null
    expect(event?.kind).toBe('eew')
    // 警報級の判定は VXSE43 を取らなくても、区域の Kind 名から立つ。
    expect(event?.kind === 'eew' ? event.severity : null).toBe('Warning')
    expect(event?.kind === 'eew' ? event.areas?.length : null).toBe(1)
  })
})

// 購読分類は「そもそもどの電文が届くか」を決める最上流。ここが変わると型検査も
// パーサのテストも素通りしたまま挙動だけが変わるため、集合そのものを固定する。
describe('購読分類', () => {
  // 対照: この修正の本体。戻すと能登本震で起きた区域塗りの後退（76→40）が再発する。
  it('eew.warning（VXSE43 だけを含む分類）を購読しない', () => {
    expect(CLASSIFICATIONS).not.toContain('eew.warning')
  })

  it('EEW（eew.forecast）と地震・津波（telegram.earthquake）は購読する', () => {
    expect(CLASSIFICATIONS).toContain('eew.forecast')
    expect(CLASSIFICATIONS).toContain('telegram.earthquake')
  })

  // 安全弁: 分類と種別は別の層で、片方だけ直しても穴が残る。両方が要る。
  it('分類を絞ったうえで、種別フィルタでも VXSE43 を扱わない', () => {
    expect(EEW_TYPES.has('VXSE43')).toBe(false)
    expect(EEW_TYPES.has('VXSE45')).toBe(true)
  })
})
