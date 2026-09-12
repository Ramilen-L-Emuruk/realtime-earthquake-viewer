// @vitest-environment jsdom
// リプレイの当日経路（アーカイブ未生成の日を埋める取得）のテスト。
//
// XML 電文（南海トラフ系）の取り込みで DOMParser を使うため jsdom 環境で動かす（既定は node）。
//
// 重点は 3 つ。
//   - **日付の基準**: アーカイブは JST 日、電文一覧は UTC の半開区間。取り違えると丸一日ずれる
//   - **担当日の排他**: アーカイブが持つ日を当日経路が二重に取らないこと
//   - **版の選択**: 同じ電文が XML 版と JSON 版で一覧に載るため、種別ごとに片方だけ拾うこと
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildSampleTelegram } from '../test-utils/bufrBuild'
import {
  enumerateJstDates, resolveLiveDates, toJstDateStr,
  fetchLiveReplayEntries, fetchLiveQuakeTelegrams, clearLiveReplayCache,
} from './dmdataReplayLive'

/** 電文一覧が返す 1 件分。 */
interface MockTelegram {
  id: string
  originalId?: string
  type: string
  headTime: string
  receivedTime: string
  url: string
  test?: boolean
  /** 分割配信された二進電文の 2 報目以降だけが持つ（`RRA`〜`RRX`）。 */
  designation?: string | null
}

function listItem(t: MockTelegram) {
  return {
    id: t.id,
    ...(t.originalId ? { originalId: t.originalId } : {}),
    head: { type: t.type, time: t.headTime, test: t.test ?? false, designation: t.designation },
    receivedTime: t.receivedTime,
    url: t.url,
  }
}

function quakeBody(eventId: string, reportTime: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>震源・震度に関する情報</Title><Status>通常</Status><EditorialOffice>気象庁</EditorialOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>震源・震度に関する情報</Title><ReportDateTime>${reportTime}</ReportDateTime>
<EventID>${eventId}</EventID><InfoType>発表</InfoType><Serial>1</Serial></Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Earthquake><OriginTime>${reportTime}</OriginTime><ArrivalTime>${reportTime}</ArrivalTime>
<Hypocenter><Area><Name>岩手県沖</Name><jmx_eb:Coordinate>+39.9+142.2-50000/</jmx_eb:Coordinate></Area></Hypocenter>
<jmx_eb:Magnitude type="Mj">5.1</jmx_eb:Magnitude></Earthquake>
<Intensity><Observation><MaxInt>4</MaxInt></Observation></Intensity>
</Body></Report>`
}

function eewBody(eventId: string, serial: string, reportTime: string, isWarning = false): string {
  const pref = isWarning
    ? `<Pref><Name>茨城</Name><Code>9080</Code><Area><Name>茨城県南部</Name><Code>301</Code>
<Category><Kind><Name>緊急地震速報（警報）</Name><Code>11</Code></Kind></Category>
<ForecastInt><From>5+</From><To>5+</To></ForecastInt></Area></Pref>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>緊急地震速報（地震動予報）</Title><Status>通常</Status><EditorialOffice>気象庁</EditorialOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>緊急地震速報（地震動予報）</Title><ReportDateTime>${reportTime}</ReportDateTime>
<EventID>${eventId}</EventID><InfoType>発表</InfoType><Serial>${serial}</Serial></Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Earthquake><OriginTime>${reportTime}</OriginTime><ArrivalTime>${reportTime}</ArrivalTime>
<Hypocenter><Area><Name>茨城県南部</Name><jmx_eb:Coordinate>+36.0+140.1-80000/</jmx_eb:Coordinate></Area></Hypocenter>
<jmx_eb:Magnitude type="Mj">6.4</jmx_eb:Magnitude></Earthquake>
<Intensity><Forecast><ForecastInt><From>5+</From><To>5+</To></ForecastInt>${pref}</Forecast></Intensity>
</Body></Report>`
}

const VYSE60_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report><Control><DateTime>2026-08-23T03:00:00Z</DateTime></Control>
<Head><Title>北海道・三陸沖後発地震注意情報</Title><ReportDateTime>2026-08-23T12:00:00+09:00</ReportDateTime>
<EventID>20260823120000</EventID><Serial>1</Serial><InfoType>発表</InfoType></Head>
<Body><Comment><Text>巨大地震に注意してください。</Text></Comment></Body></Report>`

/**
 * 当日経路が叩く API に応答するモック。
 *
 * @param opts.list  電文一覧が返す件（XML 版・JSON 版の両方が載る）
 * @param opts.eew   gd/eew のイベントと、その全報の電文
 * @param opts.bodies URL → 本体
 * @param opts.binaries URL → 二進の本体（IXAC41）。**テキストの入れ物と分ける** ——
 *   同じ経路へ混ぜると、実装が `text()` で取っていても気づけない
 */
function mockLive(opts: {
  list?: MockTelegram[]
  eew?: Array<{ eventId: string; dateTime: string; originTime?: string; telegrams: MockTelegram[] }>
  bodies?: Record<string, string | 'error'>
  binaries?: Record<string, Uint8Array>
  /** 引けなくする一覧。2 本を個別に落とせないと「1 本だけ失敗」を再現できない。 */
  listError?: Array<'telegram' | 'eew'>
}) {
  const fails = new Set(opts.listError ?? [])
  const urls: string[] = []
  const fn = vi.fn(async (input: string) => {
    urls.push(input)
    const ok = (json: unknown) => ({ ok: true, json: async () => json } as unknown as Response)
    if (input.includes('/v2/telegram?')) {
      if (fails.has('telegram')) return { ok: false, status: 500 } as unknown as Response
      return ok({ status: 'ok', items: (opts.list ?? []).map(listItem) })
    }
    if (input.includes('/v2/gd/eew?')) {
      if (fails.has('eew')) return { ok: false, status: 500 } as unknown as Response
      return ok({
        status: 'ok',
        items: (opts.eew ?? []).map(e => ({
          eventId: e.eventId,
          dateTime: e.dateTime,
          earthquake: { originTime: e.originTime ?? e.dateTime },
        })),
      })
    }
    if (input.includes('/v2/gd/eew/')) {
      const eventId = input.split('/v2/gd/eew/')[1]
      const ev = (opts.eew ?? []).find(e => e.eventId === eventId)
      if (!ev) return { ok: false, status: 404 } as unknown as Response
      return ok({ status: 'ok', items: ev.telegrams.map((t, i) => ({ serial: i + 1, telegrams: [listItem(t)] })) })
    }
    const bin = opts.binaries?.[input]
    if (bin) return { ok: true, arrayBuffer: async () => bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) } as unknown as Response
    const body = opts.bodies?.[input]
    if (body === undefined || body === 'error') return { ok: false, status: 500 } as unknown as Response
    return { ok: true, text: async () => body } as unknown as Response
  })
  return { fn, urls }
}

describe('JST 日付の扱い', () => {
  it('JST 日付へ変換する（UTC との 9 時間差を吸収する）', () => {
    // UTC 2026-08-22T15:00Z は JST 2026-08-23 00:00
    expect(toJstDateStr(new Date('2026-08-22T15:00:00Z'))).toBe('2026-08-23')
    expect(toJstDateStr(new Date('2026-08-22T14:59:59Z'))).toBe('2026-08-22')
  })

  it('期間が跨る JST 日を列挙する（終端は含まない）', () => {
    expect(enumerateJstDates(new Date('2026-08-23T03:00:00Z'), new Date('2026-08-23T04:00:00Z')))
      .toEqual(['2026-08-23'])
    // JST の日付境界（UTC 15:00）をまたぐと 2 日になる
    expect(enumerateJstDates(new Date('2026-08-22T14:59:00Z'), new Date('2026-08-22T15:01:00Z')))
      .toEqual(['2026-08-22', '2026-08-23'])
    // 終端ちょうどは含まない（JST 8/23 00:00 まで＝8/22 だけ）
    expect(enumerateJstDates(new Date('2026-08-22T10:00:00Z'), new Date('2026-08-22T15:00:00Z')))
      .toEqual(['2026-08-22'])
  })

  // 黙って切ると、落とした日ぶんの電文が取りこぼしとして数えられないまま消える。
  // 現在の呼び出し元はいずれも数日以内しか渡さないため、到達すること自体が異常。
  it('期間が上限を超えたら黙って切らずに投げる', () => {
    const from = new Date('2026-01-01T00:00:00Z')
    const to = new Date('2026-06-01T00:00:00Z')
    expect(() => enumerateJstDates(from, to)).toThrow(/対象期間が広すぎます/)
  })

  it('終わりが始まり以前なら空を返す', () => {
    expect(enumerateJstDates(new Date('2026-08-23T04:00:00Z'), new Date('2026-08-23T04:00:00Z'))).toEqual([])
    expect(enumerateJstDates(new Date('2026-08-23T05:00:00Z'), new Date('2026-08-23T04:00:00Z'))).toEqual([])
  })

  // ここが担当日の排他そのもの。アーカイブが持つ日を当日経路が読むと電文が二重に再生される。
  it('アーカイブが持つ日を当日経路の担当から外す', () => {
    const from = new Date('2026-08-22T10:00:00Z') // JST 8/22 19:00
    const to = new Date('2026-08-23T04:00:00Z')   // JST 8/23 13:00
    expect(resolveLiveDates(from, to, ['2026-08-22'])).toEqual(['2026-08-23'])
    expect(resolveLiveDates(from, to, ['2026-08-22', '2026-08-23'])).toEqual([])
    expect(resolveLiveDates(from, to, [])).toEqual(['2026-08-22', '2026-08-23'])
  })
})

describe('fetchLiveReplayEntries', () => {
  const originalFetch = globalThis.fetch
  const FROM = new Date('2026-08-22T15:00:00Z') // JST 8/23 00:00
  const TO = new Date('2026-08-23T15:00:00Z')   // JST 8/24 00:00
  const DAYS = ['2026-08-23']

  beforeEach(() => {
    clearLiveReplayCache()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    clearLiveReplayCache()
    vi.restoreAllMocks()
  })

  it('担当日が無ければ何も要求しない', async () => {
    const { fn } = mockLive({})
    globalThis.fetch = fn as unknown as typeof fetch
    const result = await fetchLiveReplayEntries('key', FROM, TO, [], false)
    expect(result).toEqual({ entries: [], skipped: 0, failedSources: [] })
    expect(fn).not.toHaveBeenCalled()
  })

  // 一覧の datetime は UTC の半開区間。JST 日 D は UTC の [D-1T15:00Z, DT15:00Z) にあるため、
  // D-1 から D+1 までを要求しないと端が落ちる。
  it('JST 日を覆う UTC 範囲で一覧を要求する', async () => {
    const { fn, urls } = mockLive({})
    globalThis.fetch = fn as unknown as typeof fetch
    await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)
    const decoded = urls.map(u => decodeURIComponent(u))
    expect(decoded.some(u => u.includes('/v2/telegram?') && u.includes('datetime=2026-08-22~2026-08-24'))).toBe(true)
    expect(decoded.some(u => u.includes('/v2/gd/eew?') && u.includes('datetime=2026-08-22~2026-08-24'))).toBe(true)
  })

  // 同じ電文が XML 版（originalId 無し）と JSON 版（originalId 有り）で一覧に載る。
  // 版を選ばないと同じ電文を二重に取り込む。
  it('地震電文は XML 版だけを取り込む', async () => {
    const { fn } = mockLive({
      list: [
        { id: 'x1', type: 'VXSE53', headTime: '2026-08-23T02:00:00Z', receivedTime: '2026-08-23T02:00:01.500Z', url: 'https://b/x1' },
        { id: 'j1', originalId: 'x1', type: 'VXSE53', headTime: '2026-08-23T02:00:00Z', receivedTime: '2026-08-23T02:00:01.500Z', url: 'https://b/j1' },
      ],
      // 本体を用意するのは XML 版だけ。JSON 版まで拾えば取得に失敗して取りこぼしに数えられる。
      bodies: { 'https://b/x1': quakeBody('20260823110000', '2026-08-23T11:00:00+09:00') },
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(1)
    expect(result.skipped).toBe(0)
    expect(result.entries[0].payload.kind).toBe('event')
    // 再生時刻は受信時刻（ミリ秒精度）
    expect(result.entries[0].replayTime.toISOString()).toBe('2026-08-23T02:00:01.500Z')
  })

  // ── 二進電文（IXAC41 推計震度分布図） ──
  //
  // アーカイブ経路と違い、こちらは**電文 1 通につき 1 リクエスト**で本体を引く。
  // テキストと取り方を分けているのはこの経路にしか無い分岐なので、ここで固定する。

  // 正: 本体を bytes で引いて分布として積む。
  // **`text()` で取っていればここで落ちる** —— モックが二進の本体を `arrayBuffer` でしか
  // 返さないうえ、文字列へ写した BUFR は読み取れない。
  it('二進電文は bytes で引いて取り込む', async () => {
    const { fn } = mockLive({
      list: [{ id: 'ix1', type: 'IXAC41', headTime: '2026-08-23T02:05:00Z', receivedTime: '2026-08-23T02:05:02.250Z', url: 'https://b/ix1' }],
      binaries: { 'https://b/ix1': buildSampleTelegram() },
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.skipped).toBe(0)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].payload.kind).toBe('estimatedIntensity')
    expect(result.entries[0].replayTime.toISOString()).toBe('2026-08-23T02:05:02.250Z')
  })

  // 正: 分割された 2 通が 1 つの分布に戻る。一覧では別々のエントリで、
  // **並行して引く**（同時取得数 8）ので到着順は保証されない。
  it('分割された二進電文を結合して 1 通にする', async () => {
    const bin = buildSampleTelegram()
    const cut = 32
    const { fn } = mockLive({
      list: [
        { id: 'ix2', type: 'IXAC41', headTime: '2026-08-23T02:05:00Z', receivedTime: '2026-08-23T02:05:02.000Z', url: 'https://b/ix2', designation: null },
        { id: 'ix3', type: 'IXAC41', headTime: '2026-08-23T02:05:00Z', receivedTime: '2026-08-23T02:05:03.000Z', url: 'https://b/ix3', designation: 'RRA' },
      ],
      binaries: { 'https://b/ix2': bin.slice(0, cut), 'https://b/ix3': bin.slice(cut) },
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.skipped).toBe(0)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].payload.kind).toBe('estimatedIntensity')
  })

  // 安全弁: **揃わなかった断片を取りこぼしに数える。** この入れ物は取得 1 回きりで
  // 使い捨てるので、数えなければ残った断片は黙って消える。
  it('断片が揃わなければ取りこぼしに数える', async () => {
    const bin = buildSampleTelegram()
    const { fn } = mockLive({
      list: [{ id: 'ix4', type: 'IXAC41', headTime: '2026-08-23T02:05:00Z', receivedTime: '2026-08-23T02:05:02.000Z', url: 'https://b/ix4', designation: null }],
      binaries: { 'https://b/ix4': bin.slice(0, 32) },   // 続きが一覧に無い
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  // 安全弁: **1 通の障害を 2 件に数えない。** 断片の取得が落ちたとき、その電文は二度と
  // 揃わないので `pendingKeys` でも数えられる。取りこぼしの件数は「何通読めなかったか」を
  // 伝える値で、多い側へずれても嘘になる。
  it('断片の取得に失敗しても取りこぼしを二重に数えない', async () => {
    const bin = buildSampleTelegram()
    const { fn } = mockLive({
      list: [
        { id: 'ix6', type: 'IXAC41', headTime: '2026-08-23T02:05:00Z', receivedTime: '2026-08-23T02:05:02.000Z', url: 'https://b/ix6', designation: null },
        { id: 'ix7', type: 'IXAC41', headTime: '2026-08-23T02:05:00Z', receivedTime: '2026-08-23T02:05:03.000Z', url: 'https://b/ix7-missing', designation: 'RRA' },
      ],
      binaries: { 'https://b/ix6': bin.slice(0, 32) },   // RRA 側は用意しない＝取得が落ちる
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  // 安全弁: **断片が 2 つとも落ちても 1 件。** 分割は最大 24 断片あり、通信の不調では
  // 複数が同時に落ちる。断片ごとに数えると 1 通の障害が断片の数だけ膨らむ。
  it('断片が 2 つとも落ちても取りこぼしは 1 件', async () => {
    const { fn } = mockLive({
      list: [
        { id: 'ix8', type: 'IXAC41', headTime: '2026-08-23T02:05:00Z', receivedTime: '2026-08-23T02:05:02.000Z', url: 'https://b/ix8-missing', designation: null },
        { id: 'ix9', type: 'IXAC41', headTime: '2026-08-23T02:05:00Z', receivedTime: '2026-08-23T02:05:03.000Z', url: 'https://b/ix9-missing', designation: 'RRA' },
      ],
      binaries: {},   // どちらの本体も用意しない
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  // 対照: 別々の電文なら別々に数える（まとめすぎていないこと）。
  it('別の電文の断片が落ちたらそれぞれ数える', async () => {
    const { fn } = mockLive({
      list: [
        { id: 'ixA', type: 'IXAC41', headTime: '2026-08-23T02:05:00Z', receivedTime: '2026-08-23T02:05:02.000Z', url: 'https://b/ixA-missing', designation: null },
        { id: 'ixB', type: 'IXAC41', headTime: '2026-08-23T02:20:00Z', receivedTime: '2026-08-23T02:20:02.000Z', url: 'https://b/ixB-missing', designation: null },
      ],
      binaries: {},
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.skipped).toBe(2)
  })

  it('南海トラフ系も XML 版だけを取り込む', async () => {
    const { fn } = mockLive({
      list: [
        { id: 'x2', type: 'VYSE60', headTime: '2026-08-23T03:00:00Z', receivedTime: '2026-08-23T03:00:00.100Z', url: 'https://b/x2' },
        { id: 'j2', originalId: 'x2', type: 'VYSE60', headTime: '2026-08-23T03:00:00Z', receivedTime: '2026-08-23T03:00:00.100Z', url: 'https://b/j2' },
      ],
      bodies: { 'https://b/x2': VYSE60_XML },
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].payload.kind).toBe('kohatsu')
  })

  it('窓の外の電文と、担当日でない電文を落とす', async () => {
    const { fn } = mockLive({
      list: [
        // 窓より前（head.time が FROM 未満）
        { id: 'a', type: 'VXSE53', headTime: '2026-08-22T14:00:00Z', receivedTime: '2026-08-23T02:00:00.000Z', url: 'https://b/a' },
        // 担当日でない（受信が JST 8/24）
        { id: 'b', type: 'VXSE53', headTime: '2026-08-23T02:00:00Z', receivedTime: '2026-08-23T15:00:00.000Z', url: 'https://b/b' },
        // テスト電文
        { id: 'c', type: 'VXSE53', headTime: '2026-08-23T02:00:00Z', receivedTime: '2026-08-23T02:00:00.000Z', url: 'https://b/c', test: true },
        // 対象外の種別（VXSE56。扱わないと決めた種別を使う ―― 扱う種別を増やすたびに
        // このテストが「取りこぼし 1 件」で落ちるのを避けるため）
        { id: 'd', type: 'VXSE56', headTime: '2026-08-23T02:00:00Z', receivedTime: '2026-08-23T02:00:00.000Z', url: 'https://b/d' },
      ],
      bodies: {},
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(0)
    // 落としたのは「対象外」であって取りこぼしではない
    expect(result.skipped).toBe(0)
  })

  // 当日経路（アーカイブがまだ無い日）も同じ扱いにする。**ただしこちらは一覧 API が
  // 既定で試験報を返さない**ので、判定を緩めるだけでは 1 通も拾えない。
  describe('試験・訓練報の取り込み', () => {
    const TESTED = {
      list: [
        { id: 'n1', type: 'VXSE53', headTime: '2026-08-23T02:00:00Z', receivedTime: '2026-08-23T02:00:01.000Z', url: 'https://b/n1' },
        { id: 't1', type: 'VXSE53', headTime: '2026-08-23T03:00:00Z', receivedTime: '2026-08-23T03:00:01.000Z', url: 'https://b/t1', test: true },
      ],
      bodies: {
        'https://b/n1': quakeBody('20260823110000', '2026-08-23T11:00:00+09:00'),
        'https://b/t1': quakeBody('20260823120000', '2026-08-23T12:00:00+09:00'),
      },
    }

    // 対照: 既定では要求もしないし、混ざっていても捨てる。
    it('既定では一覧に試験報を要求せず、混ざっていても落とす', async () => {
      const { fn, urls } = mockLive(TESTED)
      globalThis.fetch = fn as unknown as typeof fetch
      const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)
      const decoded = urls.map(u => decodeURIComponent(u))
      expect(decoded.some(u => u.includes('/v2/telegram?') && u.includes('test='))).toBe(false)
      expect(result.entries).toHaveLength(1)
      expect(result.skipped).toBe(0)
    })

    // 正: 設定を入れたら一覧へ `test=including` を付けて要求し、取り込む。
    // **判定を緩めるだけでは足りない** —— 一覧が返さなければ拾いようがない。
    it('設定を入れると一覧に試験報を要求して取り込む', async () => {
      const { fn, urls } = mockLive(TESTED)
      globalThis.fetch = fn as unknown as typeof fetch
      const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, true)
      const decoded = urls.map(u => decodeURIComponent(u))
      expect(decoded.some(u => u.includes('/v2/telegram?') && u.includes('test=including'))).toBe(true)
      expect(result.entries).toHaveLength(2)
    })

    // 安全弁: 緩めるのは `head.test` だけ。対象外の種別まで通してはいけない
    // （アーカイブ経路にも同じ形の安全弁がある。片方だけだと非対称になる）。
    it('設定を入れても対象外の種別は取り込まない', async () => {
      const { fn } = mockLive({
        // VXSE56 は「扱わないと決めた種別」（→ data-sources-spec.md §2）
        list: [
          { id: 't3', type: 'VXSE56', headTime: '2026-08-23T02:00:00Z', receivedTime: '2026-08-23T02:00:01.000Z', url: 'https://b/t3', test: true },
        ],
      })
      globalThis.fetch = fn as unknown as typeof fetch
      const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, true)
      expect(result.entries).toHaveLength(0)
      expect(result.skipped).toBe(0)
    })

    // 安全弁: 緩めるのは `head.test` だけ。担当日でない電文まで通してはいけない。
    it('設定を入れても担当日でない電文は落とす', async () => {
      const { fn } = mockLive({
        list: [
          // 受信が JST 8/24（担当日の外）
          { id: 't2', type: 'VXSE53', headTime: '2026-08-23T02:00:00Z', receivedTime: '2026-08-23T15:00:00.000Z', url: 'https://b/t2', test: true },
        ],
        bodies: { 'https://b/t2': quakeBody('20260823110000', '2026-08-23T11:00:00+09:00') },
      })
      globalThis.fetch = fn as unknown as typeof fetch
      const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, true)
      expect(result.entries).toHaveLength(0)
      expect(result.skipped).toBe(0)
    })
  })

  // EEW は電文一覧に載らないため gd/eew から辿る。一覧は最終報しか返さないので、
  // 報の推移を再現するにはイベント詳細まで引く必要がある。
  it('EEW は gd/eew のイベント詳細から全報を取り込む', async () => {
    const { fn } = mockLive({
      eew: [{
        eventId: '20260823110000',
        dateTime: '2026-08-23T11:00:05+09:00',
        originTime: '2026-08-23T11:00:00+09:00',
        telegrams: [
          { id: 'e1', originalId: 'xe1', type: 'VXSE45', headTime: '2026-08-23T02:00:01Z', receivedTime: '2026-08-23T02:00:01.100Z', url: 'https://b/e1' },
          { id: 'e2', originalId: 'xe2', type: 'VXSE45', headTime: '2026-08-23T02:00:03Z', receivedTime: '2026-08-23T02:00:03.200Z', url: 'https://b/e2' },
        ],
      }],
      bodies: {
        'https://data.api.dmdata.jp/v1/xe1': eewBody('20260823110000', '1', '2026-08-23T11:00:01+09:00'),
        'https://data.api.dmdata.jp/v1/xe2': eewBody('20260823110000', '2', '2026-08-23T11:00:03+09:00', true),
      },
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(2)
    const severities = result.entries
      .map(e => e.payload.kind === 'event' && e.payload.event.kind === 'eew' ? e.payload.event.severity : null)
    // 警報級は VXSE45 の body.isWarning で立つ（VXSE43 を取り込まなくても再現できる）
    expect(severities).toContain('Forecast')
    expect(severities).toContain('Warning')
  })

  // EEW の全報は JSON 版を指して返るので、XML 版の URL は originalId から組む。
  // 欠けていれば XML の在り処が分からず読めない ―― 黙って捨てると「取りこぼし 0 件」の
  // 表示のまま報が欠ける（実測では常に付いてくるが、数え落としの穴を残さない）。
  it('EEW の電文に originalId が無ければ取りこぼしとして数える', async () => {
    const { fn } = mockLive({
      eew: [{
        eventId: '20260823110000',
        dateTime: '2026-08-23T11:00:05+09:00',
        originTime: '2026-08-23T11:00:00+09:00',
        telegrams: [
          { id: 'e1', originalId: 'xe1', type: 'VXSE45', headTime: '2026-08-23T02:00:01Z', receivedTime: '2026-08-23T02:00:01.100Z', url: 'https://b/e1' },
          // originalId 無し（XML を引けない）
          { id: 'e2', type: 'VXSE45', headTime: '2026-08-23T02:00:03Z', receivedTime: '2026-08-23T02:00:03.200Z', url: 'https://b/e2' },
        ],
      }],
      bodies: { 'https://data.api.dmdata.jp/v1/xe1': eewBody('20260823110000', '1', '2026-08-23T11:00:01+09:00') },
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(1)
    expect(result.skipped).toBe(1)
    // 失ったのが 1 通と分かっているので、取得元（イベント丸ごと）としては数えない
    expect(result.failedSources).toEqual([])
  })

  // 窓に一報も掛からないイベントの詳細を引くと、揺れの多い日にリクエストが跳ね上がる。
  it('窓に掛からない EEW イベントは詳細を引かない', async () => {
    const { fn, urls } = mockLive({
      eew: [{
        // 最終報が窓より十分前（余裕 3 分より前）
        eventId: '20260822200000',
        dateTime: '2026-08-22T20:00:05+09:00',
        originTime: '2026-08-22T20:00:00+09:00',
        telegrams: [],
      }],
    })
    globalThis.fetch = fn as unknown as typeof fetch

    await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(urls.some(u => u.includes('/v2/gd/eew/'))).toBe(false)
  })

  it('本体が取れなかった電文は取りこぼしとして数え、残りは活かす', async () => {
    const { fn } = mockLive({
      list: [
        { id: 'ok', type: 'VXSE53', headTime: '2026-08-23T02:00:00Z', receivedTime: '2026-08-23T02:00:00.000Z', url: 'https://b/ok' },
        { id: 'ng', type: 'VXSE53', headTime: '2026-08-23T02:01:00Z', receivedTime: '2026-08-23T02:01:00.000Z', url: 'https://b/ng' },
      ],
      bodies: {
        'https://b/ok': quakeBody('20260823110000', '2026-08-23T11:00:00+09:00'),
        'https://b/ng': 'error',
      },
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(1)
    expect(result.skipped).toBe(1)
  })

  // 電文の件数と「取得元」は単位が違う。数十報のイベントを失っても電文 1 件として
  // 数えると、UI の取りこぼし表示が実態より軽く見える。
  it('EEW イベントの詳細が引けなかったら、電文の件数ではなく取得元として数える', async () => {
    const { fn } = mockLive({
      eew: [{
        eventId: '20260823110000',
        dateTime: '2026-08-23T11:00:05+09:00',
        originTime: '2026-08-23T11:00:00+09:00',
        telegrams: [],
      }],
    })
    // 詳細だけ 500 にする（一覧は成功させる）
    const orig = fn.getMockImplementation()!
    globalThis.fetch = (async (input: string) => {
      if (input.includes('/v2/gd/eew/')) return { ok: false, status: 500 } as unknown as Response
      return orig(input)
    }) as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.skipped).toBe(0)
    expect(result.failedSources).toEqual(['eew:20260823110000'])
  })

  // アーカイブ経路は同じ状況を取りこぼしとして数える。ここだけ「対象外」に混ぜると
  // UI の取りこぼし通知に出ず、静かな時間帯と区別が付かなくなる。
  it('時刻が壊れた電文は取りこぼしとして数える', async () => {
    const { fn } = mockLive({
      list: [
        { id: 'bad1', type: 'VXSE53', headTime: 'not-a-date', receivedTime: '2026-08-23T02:00:00.000Z', url: 'https://b/bad1' },
        { id: 'bad2', type: 'VXSE53', headTime: '2026-08-23T02:00:00Z', receivedTime: 'not-a-date', url: 'https://b/bad2' },
      ],
      bodies: {},
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(0)
    expect(result.skipped).toBe(2)
  })

  // 2 本の一覧は互いに隔離する。片方の一時障害でもう片方の成果まで捨てると、
  // 「EEW の一覧がこけただけで今日の地震も津波も出ない」ことになる。しかも取得元が
  // 当日経路 1 本しか無い窓では、それが全滅と見なされて再生ごと止まる。
  it('EEW の一覧が引けなくても、地震電文は残す', async () => {
    const { fn } = mockLive({
      list: [{ id: 'j1', type: 'VXSE53', headTime: '2026-08-23T02:00:00Z', receivedTime: '2026-08-23T02:00:01.500Z', url: 'https://b/j1' }],
      bodies: { 'https://b/j1': quakeBody('20260823110000', '2026-08-23T11:00:00+09:00') },
      listError: ['eew'],
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(1)
    expect(result.failedSources).toEqual(['live-eew:2026-08-23'])
  })

  it('地震電文の一覧が引けなくても、EEW は残す', async () => {
    const { fn } = mockLive({
      eew: [{
        eventId: '20260823110000',
        dateTime: '2026-08-23T11:00:05+09:00',
        originTime: '2026-08-23T11:00:00+09:00',
        telegrams: [
          { id: 'e1', originalId: 'xe1', type: 'VXSE45', headTime: '2026-08-23T02:00:01Z', receivedTime: '2026-08-23T02:00:01.100Z', url: 'https://b/e1' },
        ],
      }],
      bodies: { 'https://data.api.dmdata.jp/v1/xe1': eewBody('20260823110000', '1', '2026-08-23T11:00:01+09:00') },
      listError: ['telegram'],
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveReplayEntries('key', FROM, TO, DAYS, false)

    expect(result.entries).toHaveLength(1)
    expect(result.failedSources).toEqual(['live-telegram:2026-08-23'])
  })

  // すべて引けなければその日は 1 通も取れていない。呼び出し元が日単位の失敗として
  // 扱えるよう投げる（部分的に取れた場合と区別が付かなくなるため）。
  it('2 本の一覧をすべて引けなければ例外にする', async () => {
    const { fn } = mockLive({ listError: ['telegram', 'eew'] })
    globalThis.fetch = fn as unknown as typeof fetch
    await expect(fetchLiveReplayEntries('key', FROM, TO, DAYS, false)).rejects.toThrow(/一覧をすべて取得できませんでした/)
  })
})

describe('fetchLiveQuakeTelegrams', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    clearLiveReplayCache()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    clearLiveReplayCache()
    vi.restoreAllMocks()
  })

  // 一覧はその日ぶんを丸ごと返すため、再生開始より後の電文が必ず混ざる。
  // 落とさないと、再生開始前の一覧に未来の地震が並ぶ。
  it('指定時刻より後に発表された電文は採らない', async () => {
    const { fn } = mockLive({
      list: [
        { id: 'past', type: 'VXSE53', headTime: '2026-08-23T00:05:00Z', receivedTime: '2026-08-23T00:05:01.000Z', url: 'https://b/past' },
        { id: 'future', type: 'VXSE53', headTime: '2026-08-23T09:05:00Z', receivedTime: '2026-08-23T09:05:01.000Z', url: 'https://b/future' },
      ],
      bodies: {
        'https://b/past': quakeBody('20260823090500', '2026-08-23T09:05:00+09:00'),
        'https://b/future': quakeBody('20260823180500', '2026-08-23T18:05:00+09:00'),
      },
    })
    globalThis.fetch = fn as unknown as typeof fetch

    // JST 8/23 12:00 時点
    const result = await fetchLiveQuakeTelegrams('key', '2026-08-23', new Date('2026-08-23T03:00:00Z'), false)

    expect(result.quakes).toHaveLength(1)
    expect(result.quakes[0].id).toContain('20260823090500')
  })

  // 発表が前日の深夜・受信が日付をまたいだ電文は、両側の呼び出しから漏れやすい。
  // 前日ぶんの呼び出しでは受信日が違い、当日ぶんの呼び出しでは発表が日の始まりより前になる。
  it('発表が前日深夜・受信が当日にまたがった電文を落とさない', async () => {
    const { fn } = mockLive({
      list: [
        // JST 8/22 23:59 発表 → JST 8/23 00:00:05 受信
        { id: 'across', type: 'VXSE53', headTime: '2026-08-22T14:59:00Z', receivedTime: '2026-08-22T15:00:05.000Z', url: 'https://b/across' },
      ],
      bodies: { 'https://b/across': quakeBody('20260822235900', '2026-08-22T23:59:00+09:00') },
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveQuakeTelegrams('key', '2026-08-23', new Date('2026-08-23T03:00:00Z'), false)

    expect(result.quakes).toHaveLength(1)
  })

  it('地震以外の種別は採らない', async () => {
    const { fn } = mockLive({
      list: [
        { id: 'ts', type: 'VTSE51', headTime: '2026-08-23T00:05:00Z', receivedTime: '2026-08-23T00:05:01.000Z', url: 'https://b/ts' },
      ],
      bodies: { 'https://b/ts': '{}' },
    })
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchLiveQuakeTelegrams('key', '2026-08-23', new Date('2026-08-23T03:00:00Z'), false)

    expect(result.quakes).toHaveLength(0)
    expect(result.skipped).toBe(0)
  })
})
