// アーカイブ本体の控えの**結線**を、端から端まで本物で通す。
//
// **どのテストもこの経路を通っていなかった。**
//
// | テスト | 何が本物で、何が偽物か |
// |---|---|
// | `archiveBodyDb.test.ts` | IndexedDB は本物だが、中身はゼロ埋めのバイト列（gzip も tar も通らない） |
// | `archiveBodyCache.test.ts` | 二層の繋ぎ方は見るが、`persist` が偽物（IndexedDB も gzip も通らない） |
// | `dmdataReplay.test.ts` | IndexedDB を用意しないので、端末の控えは常に no-op |
//
// ここが見るのは **「配信元から落とした実 gzip → 端末へ書く → 読み戻す → 展開する」** の 1 本。
// この経路が壊れると、症状は「なぜか毎回アーカイブを取り直す」だけで、例外もログも出ない。
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { fetchDmdataQuakeHistory, clearReplayCache, clearArchiveCacheForTest, clearParseCachesForTest } from './dmdataReplay'
import { clearArchiveBodyDb, archiveBodyDbStats } from '../utils/archiveBodyDb'
import { setDataApiGateIntervalForTest, resetDataApiGateForTest, setApiGateIntervalForTest, resetApiGateForTest, resetRateLimitsForTest } from './dmdataRequestGates'

// 電文の読み取りに DOMParser が要る（環境は node のまま。理由は `dmdataReplay.test.ts` と同じ）
import { JSDOM } from 'jsdom'
globalThis.DOMParser = new JSDOM().window.DOMParser
afterAll(() => { delete (globalThis as { DOMParser?: unknown }).DOMParser })

const HEADER = 512
const enc = new TextEncoder()
const originalFetch = globalThis.fetch

function makeTarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(HEADER)
  h.set(enc.encode(name), 0)
  h.set(enc.encode(size.toString(8).padStart(11, '0')), 124)
  h[156] = '0'.charCodeAt(0)
  return h
}

/** **本物の gzip + tar を作る。** ここを偽物にすると、この結線テストの意味が消える。 */
async function makeTarGz(files: { name: string; content: string }[]): Promise<Uint8Array> {
  const blocks: Uint8Array[] = []
  for (const f of files) {
    const body = enc.encode(f.content)
    blocks.push(makeTarHeader(f.name, body.length))
    const padded = new Uint8Array(Math.ceil(body.length / HEADER) * HEADER)
    padded.set(body)
    blocks.push(padded)
  }
  blocks.push(new Uint8Array(HEADER * 2))
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const tar = new Uint8Array(total)
  let offset = 0
  for (const b of blocks) { tar.set(b, offset); offset += b.length }
  const stream = new Blob([tar as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** 震度速報 1 通ぶんの XML（読み取りが通ればカードが 1 枚立つ）。 */
function quakeXml(eventId: string, reportTime: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
  <Control><Title>震度速報</Title><DateTime>${reportTime}</DateTime><Status>通常</Status></Control>
  <Head><Title>震度速報</Title><ReportDateTime>${reportTime}</ReportDateTime>
    <TargetDateTime>${reportTime}</TargetDateTime><EventID>${eventId}</EventID>
    <InfoType>発表</InfoType><Serial/><InfoKind>震度速報</InfoKind></Head>
  <Body><Intensity><Observation><MaxInt>4</MaxInt>
    <Pref><Name>石川県</Name><Code>17</Code><MaxInt>4</MaxInt>
      <Area><Name>石川県能登</Name><Code>390</Code><MaxInt>4</MaxInt></Area>
    </Pref></Observation></Intensity></Body>
</Report>`
}

const MANIFEST = [{
  id: 'w1',
  classification: 'telegram.earthquake',
  // tar 側の名前と必ず一致させる。本体はこの値だけで引く（`findBodyFileName`）
  filename: 'w1.xml',
  head: { type: 'VXSE51', time: '2026-08-10T03:05:00Z', test: false },
}]

/**
 * 目録（`/v2/archive`）と本体を返す偽の配信元。**取得回数を数える。**
 *
 * 応答の形は `dmdataReplay.test.ts` の `mockHistoryArchives` に合わせてある
 * （本体は `arrayBuffer()` で返す）。
 */
function mockArchive(gz: Uint8Array) {
  const calls = { list: 0, body: 0 }
  const items = [{ classification: 'telegram.earthquake', date: '2026-08-10', url: 'https://x/body1' }]
  globalThis.fetch = (async (input: string) => {
    const url = String(input)
    if (url.includes('/v2/archive?')) {
      calls.list++
      return { ok: true, json: async () => ({ status: 'ok', items }) } as unknown as Response
    }
    if (url === 'https://x/body1') {
      calls.body++
      return { ok: true, arrayBuffer: async () => gz as unknown as ArrayBuffer } as unknown as Response
    }
    // 当日経路の一覧は空で返す（この結線テストの関心ではない）
    return { ok: true, json: async () => ({ status: 'ok', items: [] }) } as unknown as Response
  }) as unknown as typeof fetch
  return calls
}

beforeEach(async () => {
  clearReplayCache()
  clearArchiveCacheForTest()
  clearParseCachesForTest()
  await clearArchiveBodyDb()
  setDataApiGateIntervalForTest(0)
  resetDataApiGateForTest()
  setApiGateIntervalForTest(0)
  resetApiGateForTest()
  resetRateLimitsForTest()
})
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('アーカイブ本体の控えの結線（実 gzip × 実 IndexedDB）', () => {
  // 正: **メモリの控えを捨てても、端末の控えから読み戻して展開できる。**
  // これが「タブを開き直しても取り直さない」の実体で、この 1 本が通らなければ
  // 端末の控えは置いた意味を持たない。
  it('メモリの控えを捨てても、端末の控えから読み戻して同じカードを作れる', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify(MANIFEST) },
      { name: 'w1.xml', content: quakeXml('20260810120000', '2026-08-10T12:05:00+09:00') },
    ])
    const calls = mockArchive(gz)
    const before = new Date('2026-08-10T23:00:00+09:00')

    const first = await fetchDmdataQuakeHistory('key', before, 50, 1, false)
    expect(first.quakes).toHaveLength(1)
    expect(calls.body).toBe(1)

    // 端末へ書かれていること（gzip のまま・展開後ではない）
    const stats = await archiveBodyDbStats()
    expect(stats?.entries).toBe(1)
    expect(stats?.bytes).toBe(gz.byteLength)

    // **メモリの控えと解析結果だけ捨てる**（タブを開き直した状態に相当）
    clearArchiveCacheForTest()
    clearParseCachesForTest()

    const second = await fetchDmdataQuakeHistory('key', before, 50, 1, false)

    // 本体は取りに行かない（端末の控えから読み、gunzip と tar 展開を通っている）
    expect(calls.body).toBe(1)
    // それでいて同じカードが立つ —— 読み戻しと展開が本当に通った証拠
    expect(second.quakes).toHaveLength(1)
    expect(second.quakes[0]?.earthquake.hypocenter.name ?? second.quakes[0]?.points?.[0]?.addr)
      .toBeDefined()
  })

  // 対照: **端末の控えも捨てれば取り直す。** 上のテストが「控えが残っていただけ」ではなく
  // 「取得経路が生きている」ことを示す裏返し。
  it('端末の控えも捨てれば、もう一度落としに行く', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify(MANIFEST) },
      { name: 'w1.xml', content: quakeXml('20260810120000', '2026-08-10T12:05:00+09:00') },
    ])
    const calls = mockArchive(gz)
    const before = new Date('2026-08-10T23:00:00+09:00')

    await fetchDmdataQuakeHistory('key', before, 50, 1, false)
    expect(calls.body).toBe(1)

    clearArchiveCacheForTest()
    clearParseCachesForTest()
    await clearArchiveBodyDb()

    await fetchDmdataQuakeHistory('key', before, 50, 1, false)

    expect(calls.body).toBe(2)
  })

  // 安全弁: **端末の控えが壊れていても、取得へ落ちて値を返す。**
  // 速くするための仕組みが、機能そのものを止めてはいけない。
  it('端末の控えが壊れていても、取得へ落ちてカードを作る', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify(MANIFEST) },
      { name: 'w1.xml', content: quakeXml('20260810120000', '2026-08-10T12:05:00+09:00') },
    ])
    const calls = mockArchive(gz)
    const before = new Date('2026-08-10T23:00:00+09:00')

    await fetchDmdataQuakeHistory('key', before, 50, 1, false)
    clearArchiveCacheForTest()
    clearParseCachesForTest()

    // 控えの中身を gzip として読めない値へ差し替える（展開で失敗する形）
    const { writeArchiveBody } = await import('../utils/archiveBodyDb')
    await writeArchiveBody('https://x/body1', new Uint8Array([1, 2, 3, 4]))

    const result = await fetchDmdataQuakeHistory('key', before, 50, 1, false)

    // 展開に失敗したので落とし直し、カードは作れている
    expect(calls.body).toBe(2)
    expect(result.quakes).toHaveLength(1)
  })
})
