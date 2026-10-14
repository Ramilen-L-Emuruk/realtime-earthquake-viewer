// @vitest-environment jsdom
// 電文の読み取りに DOMParser を使うため jsdom 環境で動かす（既定は node）。
//
// 一部の区分しか受けられない人のライブ接続（`DmdataWebSocket`）を固定する。
// 配信元の応えの文は 2026-10-14 の実測に合わせてある（docs/spec/data-sources-spec.md §2）。
//
// **電文は最小化した合成のもの。** 緊急地震速報の実電文はリポジトリへ入れない（DMDATA.JP の
// 利用規約で二次配信が制限されるため）。実電文の VXSE43 を読めることは、手元の控えで確かめてある。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { gzipSync, gunzipSync } from 'node:zlib'
import { DmdataWebSocket } from './dmdata'

// 本文の復号は jsdom の Blob が `stream()` を持たないので、node の zlib へ差し替える。
// ここで見たいのは区分の判定で、復号そのものは `dmdata.test.ts`（node 環境）が確かめている。
vi.mock('../utils/gzip', () => ({
  gunzip: async (bytes: Uint8Array) => new Uint8Array(gunzipSync(bytes)),
}))
import { setApiGateIntervalForTest, resetApiGateForTest } from './dmdataRequestGates'
import { PREFERRED_CLASSIFICATIONS } from './dmdataClassifications'

beforeEach(() => {
  setApiGateIntervalForTest(0)
  resetApiGateForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/** 最小の WebSocket の替え玉。受信を流すために要る。 */
class FakeWs {
  static last: FakeWs | null = null
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  readyState = 1
  constructor() { FakeWs.last = this }
  send() {}
  close() { this.onclose?.({ code: 1006, reason: '' }) }
}

type Region = 'eew.forecast' | 'eew.warning' | 'telegram.earthquake'

/**
 * 契約している区分だけを通す Socket Start の偽物。申し込まれた区分を記録する。
 * 実測どおり、契約の無い区分があれば 402 `No contract. [区分]` で申し込みごと断る。
 */
function stubSocketStart(contract: Region[]) {
  const requested: string[][] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { classifications: string[] }
    requested.push(body.classifications)
    const missing = body.classifications.filter((c) => !contract.includes(c as Region))
    if (missing.length > 0) {
      return {
        status: 402,
        json: async () => ({ status: 'error', error: { message: `No contract. [${missing[0]}]`, code: 402 } }),
      } as unknown as Response
    }
    return {
      status: 200,
      json: async () => ({
        status: 'ok', websocket: { id: 1, url: 'wss://example.invalid/ws' }, classifications: body.classifications,
      }),
    } as unknown as Response
  }))
  vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket)
  return requested
}

/** base64 + gzip（配信の形）へ包む。jsdom の Blob は `stream()` を持たないので node の zlib で包む。 */
function pack(text: string): string {
  return gzipSync(Buffer.from(text, 'utf-8')).toString('base64')
}

// 2024-01-01 能登半島地震の緊急地震速報（警報）を最小化したもの。
const EEW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>緊急地震速報（警報）</Title><Status>通常</Status><EditorialOffice>気象庁本庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>緊急地震速報（警報）</Title>
<ReportDateTime>2024-01-01T16:11:07+09:00</ReportDateTime>
<EventID>20240101161010</EventID>
<InfoType>発表</InfoType>
<Serial>1</Serial>
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

async function deliver(headType: string): Promise<void> {
  const body = pack(EEW_XML)
  FakeWs.last?.onmessage?.({
    data: JSON.stringify({
      type: 'data', head: { type: headType, test: false }, body,
      encoding: 'base64', compression: 'gzip', format: 'xml',
    }),
  })
  // 本文の復号（gunzip）は非同期なので、実時間で少し待つ
  await new Promise((r) => setTimeout(r, 50))
  await drain()
}

describe('DmdataWebSocket: 一部の区分しか契約していない人', () => {
  // 正: 予報の契約が無ければ警報へ切り替えて繋がり、VXSE43 を緊急地震速報として流す
  it('警報＋地震・津波の人は、警報へ切り替えて繋がり、VXSE43 を受ける', async () => {
    const requested = stubSocketStart(['eew.warning', 'telegram.earthquake'])
    const ws = new DmdataWebSocket('valid-key')
    const accepted: string[][] = []
    ws.onClassifications = (c) => { accepted.push([...c]) }
    const events: string[] = []
    ws.onEvent = (ev) => { events.push(ev.kind) }
    try {
      ws.connect()
      await drain()
      expect(requested).toEqual([['eew.forecast', 'telegram.earthquake'], ['eew.warning', 'telegram.earthquake']])
      expect(accepted).toEqual([['eew.warning', 'telegram.earthquake']])
      await expect(ws.classificationsReady).resolves.toEqual(['eew.warning', 'telegram.earthquake'])

      await deliver('VXSE43')
      expect(events).toEqual(['eew'])
    } finally {
      ws.disconnect()
    }
  })

  // 対照: 予報を受けている人には VXSE43 を流さない（VXSE45 の警報報の複製で、区域塗りを削るため）
  it('全部ある人は予報で繋がり、VXSE45 を受けて VXSE43 は流さない', async () => {
    const requested = stubSocketStart(['eew.forecast', 'eew.warning', 'telegram.earthquake'])
    const ws = new DmdataWebSocket('valid-key')
    const events: string[] = []
    ws.onEvent = (ev) => { events.push(ev.kind) }
    try {
      ws.connect()
      await drain()
      expect(requested).toEqual([['eew.forecast', 'telegram.earthquake']])

      await deliver('VXSE43')
      expect(events).toEqual([])
      await deliver('VXSE45')
      expect(events).toEqual(['eew'])
    } finally {
      ws.disconnect()
    }
  })

  // 正: 再接続は前に通った区分から申し込む（断られる申し込みを再接続のたびに投げ直さない）
  it('再接続は前に通った区分から申し込む', async () => {
    const requested = stubSocketStart(['telegram.earthquake'])
    const ws = new DmdataWebSocket('valid-key')
    try {
      ws.connect()
      await drain()
      expect(requested[requested.length - 1]).toEqual(['telegram.earthquake'])
      const before = requested.length

      vi.useFakeTimers()
      FakeWs.last?.close()
      await vi.advanceTimersByTimeAsync(10_000)
      await drain()
      expect(requested.slice(before)).toEqual([['telegram.earthquake']])
    } finally {
      ws.disconnect()
    }
  })

  // 正: 最初の申し込みが一時的に失敗（409）しても、区分はその場で既定値に決めない。
  // 決めてしまうと、再接続で警報だけで繋がっても履歴と復元が既定の区分のまま走る
  it('初回が 409 でも、再接続で通った区分で classificationsReady が決まる', async () => {
    vi.useFakeTimers()
    const requested = stubSocketStart(['eew.warning', 'telegram.earthquake'])
    const realFetch = globalThis.fetch
    let first = true
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (first && init?.method === 'POST') {
        first = false
        return { status: 409, json: async () => ({ status: 'error', error: { message: 'full', code: 409 } }) } as unknown as Response
      }
      return realFetch(url, init)
    }))
    const ws = new DmdataWebSocket('valid-key')
    let settled: readonly string[] | null = null
    void ws.classificationsReady.then((c) => { settled = c })
    try {
      ws.connect()
      await drain()
      expect(settled).toBeNull()
      await vi.advanceTimersByTimeAsync(10_000)
      await drain()
      expect(settled).toEqual(['eew.warning', 'telegram.earthquake'])
      expect(requested.length).toBeGreaterThan(0)
    } finally {
      ws.disconnect()
    }
  })

  // 安全弁: 決まらないまま待たせ続けない。上限の時間で既定の区分に倒す
  it('409 が続くと、上限の時間で既定の区分に決まる', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => (
      { status: 409, json: async () => ({ status: 'error', error: { message: 'full', code: 409 } }) } as unknown as Response
    )))
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket)
    const ws = new DmdataWebSocket('valid-key')
    let settled: readonly string[] | null = null
    void ws.classificationsReady.then((c) => { settled = c })
    try {
      ws.connect()
      await vi.advanceTimersByTimeAsync(14_000)
      expect(settled).toBeNull()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(settled).toEqual(PREFERRED_CLASSIFICATIONS)
    } finally {
      ws.disconnect()
    }
  })

  // 安全弁: 受けられる区分が 1 つも無ければ、認証エラーと同じく止まる（断られる申し込みを繰り返さない）。
  // 履歴などの REST は既定の区分のまま取りに行き、従来どおりの失敗の伝え方を残す
  it('受けられる区分が無ければ切断で止まり、再接続しない', async () => {
    const requested = stubSocketStart([])
    const ws = new DmdataWebSocket('valid-key')
    const statuses: string[] = []
    ws.onStatusChange = (s) => { statuses.push(s) }
    try {
      vi.useFakeTimers()
      ws.connect()
      await drain()
      const count = requested.length
      expect(statuses[statuses.length - 1]).toBe('disconnected')
      await expect(ws.classificationsReady).resolves.toEqual(PREFERRED_CLASSIFICATIONS)

      await vi.advanceTimersByTimeAsync(600_000)
      expect(requested.length).toBe(count)
    } finally {
      ws.disconnect()
    }
  })
})
