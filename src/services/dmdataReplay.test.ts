// DMDATA archive リプレイ取得の耐障害性テスト。
//
// 重点は「一部が壊れていても、壊れていない分は取り込めること」。
// 従来は電文 1 通の破損で Promise.all ごと reject し、その日を含む期間の再生が
// 丸ごと不可能になっていた。また目録（telegrams.json）が無いアーカイブは無言で
// 捨てられ、「電文 0 件だが成功」に化けて原因が追えなかった。
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { fetchDmdataReplayEvents, fetchDmdataQuakeHistory, clearReplayCache, filterPreWindowEvents, MAX_HISTORY_DAYS } from './dmdataReplay'
import { enumerateJstDates, MAX_ENUMERATED_DAYS } from './dmdataReplayLive'
import type { JMATsunami, EEWAlert } from '../types/earthquake'
import type { ReplayEntry } from '../types/replay'
import { DmdataApiKeyError } from '../utils/dmdataApiKey'
import { log } from '../utils/logger'
import { buildSampleTelegram } from '../test-utils/bufrBuild'
import {
  setDataApiGateIntervalForTest, resetDataApiGateForTest,
  setApiGateIntervalForTest, resetApiGateForTest, resetRateLimitsForTest,
} from './dmdataRequestGates'
import { readArchiveBody, writeArchiveBody } from '../utils/archiveBodyCache'

// **永続の控え（IndexedDB）はモックする。** 本物を通すと、テストごとに同じ URL を使う既存の
// 70 件が「2 回目は取得しない」挙動になって壊れる。控え自身の振る舞いは
// `utils/archiveBodyCache.test.ts` が `fake-indexeddb` で確かめている。
vi.mock('../utils/archiveBodyCache', () => ({
  readArchiveBody: vi.fn(async () => null),
  writeArchiveBody: vi.fn(async () => {}),
}))

// **アーカイブ本体の取得も門（`services/dmdataRequestGates.ts`）を通る**ので、本番の 6 秒間隔のままでは
// 1 件取るだけで既定のタイムアウト（5 秒）を超える。**門が効いているかは
// `utils/requestGate.test.ts` が本物の間隔で確かめている**ので、ここでは 0 にして経路だけを見る。
//
// **トップレベルに置くのは、`describe` 内の `beforeEach` が兄弟の `describe` に届かないため。**
// 待ち行列の持ち越しも切る（前のテストが残した待ちが次へ影響しないように）。
beforeEach(() => {
  setDataApiGateIntervalForTest(0)
  resetDataApiGateForTest()
  // 目録（`api.dmdata.jp/v2/archive`）の門も同じ理由で 0 にする。
  setApiGateIntervalForTest(0)
  resetApiGateForTest()
  // **429 の窓も空にする。** 持ち越すと、前のテストが立てた窓で次のテストが取得を
  // 見送り、症状が「なぜかそのテストだけ電文 0 件」になる。
  resetRateLimitsForTest()
})

// 電文の読み取りが XML に一本化されたため DOMParser が要る。**環境ごと jsdom へ移さない**
// ——このファイルの tar 生成は Blob.stream() と CompressionStream を使っており、jsdom の Blob は
// stream() を持たないため全件が落ちる。必要な 1 つだけを node 環境へ足す。
import { JSDOM } from 'jsdom'
globalThis.DOMParser = new JSDOM().window.DOMParser
// 差したままにしない。vitest はファイルごとに実行コンテキストを分けるので現状は漏れないが、
// 分離設定に依存した「たまたま漏れていない」状態を残さない。
afterAll(() => { delete (globalThis as { DOMParser?: unknown }).DOMParser })

const HEADER = 512
const enc = new TextEncoder()

function makeTarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(HEADER)
  h.set(enc.encode(name), 0)
  h.set(enc.encode(size.toString(8).padStart(11, '0')), 124)
  h[156] = '0'.charCodeAt(0)
  return h
}

// 中身はバイト列でも渡せる。**二進電文（IXAC41）は文字列に写せない** ——
// UTF-8 として読めないバイトが U+FFFD へ潰れ、戻せなくなる。
type TarFile = { name: string; content: string | Uint8Array }

function makeTar(files: TarFile[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const f of files) {
    const body = typeof f.content === 'string' ? enc.encode(f.content) : f.content
    blocks.push(makeTarHeader(f.name, body.length))
    const padded = new Uint8Array(Math.ceil(body.length / HEADER) * HEADER)
    padded.set(body)
    blocks.push(padded)
  }
  blocks.push(new Uint8Array(HEADER * 2))
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const b of blocks) { out.set(b, offset); offset += b.length }
  return out
}

async function makeTarGz(files: TarFile[]): Promise<Uint8Array> {
  const stream = new Blob([makeTar(files) as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// 電文 1 通の中身（VXSE53 = 震源・震度に関する情報）。parseEarthquakeFromXml が通る最小形。
function quakeBody(hypocenterName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>震源・震度に関する情報</Title><Status>通常</Status><EditorialOffice>気象庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>震源・震度に関する情報</Title>
<ReportDateTime>2026-08-10T12:05:00+09:00</ReportDateTime>
<TargetDateTime>2026-08-10T12:00:00+09:00</TargetDateTime>
<EventID>20260810120000</EventID>
<InfoType>発表</InfoType>
<Serial>1</Serial>
<InfoKind>地震情報</InfoKind>
</Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Earthquake>
<OriginTime>2026-08-10T12:00:00+09:00</OriginTime>
<ArrivalTime>2026-08-10T12:00:00+09:00</ArrivalTime>
<Hypocenter><Area><Name>${hypocenterName}</Name><jmx_eb:Coordinate>+39.9+142.2-50000/</jmx_eb:Coordinate></Area></Hypocenter>
<jmx_eb:Magnitude type="Mj">5.1</jmx_eb:Magnitude>
</Earthquake>
<Intensity><Observation><MaxInt>4</MaxInt></Observation></Intensity>
</Body>
</Report>`
}

/** manifest 1 件分。ファイル名は id の先頭 7 文字を含む必要がある。 */
function manifestEntry(
  id: string, type = 'VXSE53', time = '2026-08-10T12:05:00+09:00', designation?: string | null,
) {
  return { id, classification: 'telegram.earthquake', head: { type, time, test: false, designation } }
}

/**
 * 試験・訓練報の目録エントリ。
 *
 * **アーカイブの索引は訓練報に `head.test = true` を立てる。** 電文の中身の運用種別
 * （`Control/Status` ＝「訓練」）とは別の印で、実配信で確かめてある（2026-07-23 の訓練報）。
 */
function manifestTestEntry(id: string, type = 'VXSE53', time = '2026-08-10T12:06:00+09:00') {
  return { id, classification: 'telegram.earthquake', head: { type, time, test: true, designation: null } }
}

const FROM = new Date('2026-08-10T00:00:00+09:00')
const TO = new Date('2026-08-11T00:00:00+09:00')

/** archive リスト API と各アーカイブ URL の応答を組み立てる。 */
function mockArchives(archives: Array<{ url: string; gz: Uint8Array | 'error' }>) {
  const items = archives.map((a, i) => ({
    classification: 'telegram.earthquake',
    date: `2026-08-1${i}`,
    url: a.url,
  }))
  return vi.fn(async (input: string) => {
    if (input.includes('/v2/archive?')) {
      return { ok: true, json: async () => ({ status: 'ok', items }) } as unknown as Response
    }
    const hit = archives.find(a => input === a.url)
    if (!hit || hit.gz === 'error') {
      return { ok: false, status: 500 } as unknown as Response
    }
    return { ok: true, arrayBuffer: async () => hit.gz as unknown as ArrayBuffer } as unknown as Response
  })
}

// アーカイブ本体（`data.api.dmdata.jp/v1/archive/:id`）が門を通ること。
//
// 配信元のレート表は電文本体（`/v1/:id`）とアーカイブ本体へ `rowspan` で 50req/5min を掛けており、
// **「3 行それぞれ」とも「3 行の合計」とも読める**。合算として扱う判断をしたので、
// **アーカイブ本体も電文本体と同じ門を共有する**（→ `services/dmdataRequestGates.ts`）。
//
// 門を通す前は素の `fetch` を `Promise.all` で**上限なく並列**に投げていた
// （起動時の履歴は 7 日ぶん ＝ 瞬間 7req/s）。
describe('アーカイブ本体の取得は門を通る', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    clearReplayCache()
    setDataApiGateIntervalForTest(0)
    // **モックの持ち越しを切る。** `mockResolvedValueOnce` が消費されないまま残ると、
    // 次の describe のテストがそれを拾って別の結果になる（実際に 1 件巻き込んだ）。
    vi.clearAllMocks()
  })

  // 正: 並列に投げても、門が間隔を空ける。
  // **間隔は実時間で測る**（偽のタイマーでは門の `setTimeout` が進まない）。
  it('並列に投げても間隔が空く', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: enc.encode(JSON.stringify([manifestEntry('a1', 'VXSE53')])) },
      { name: 'a1.xml', content: enc.encode(quakeBody('石川県能登地方')) },
    ])
    const at: number[] = []
    const base = mockArchives([
      { url: 'https://data.api.dmdata.jp/v1/archive/d1', gz },
      { url: 'https://data.api.dmdata.jp/v1/archive/d2', gz },
    ])
    globalThis.fetch = (async (input: string) => {
      if (String(input).includes('/v1/archive/')) at.push(Date.now())
      return base(String(input))
    }) as unknown as typeof fetch

    setDataApiGateIntervalForTest(60)
    await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(at.length).toBe(2)
    // 門を通らなければ 2 件はほぼ同時（実測 1ms 未満）に飛ぶ。
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(50)
  })

  // 正: 取得したアーカイブは永続の控えへ書く。
  // **これが無いとページを再読込するたびに同じ日を取り直す**（配信元が
  // 「同じ id に対して短期間にリクエストを繰り返さないように」と求めている形）。
  it('取得したアーカイブを永続の控えへ書く', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: enc.encode(JSON.stringify([manifestEntry('a1', 'VXSE53')])) },
      { name: 'a1.xml', content: enc.encode(quakeBody('石川県能登地方')) },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://data.api.dmdata.jp/v1/archive/d1', gz },
    ]) as unknown as typeof fetch

    await fetchDmdataReplayEvents('key', FROM, TO, false)

    // **鍵は URL ではなく id。** クエリや基底が変われば同じアーカイブを別物として取り直す
    expect(vi.mocked(writeArchiveBody)).toHaveBeenCalledWith('d1', expect.any(Uint8Array))
  })

  // 正: 控えから読めたら取得しない。
  // **取得を失敗させたうえで成功することを見る** —— 控えを読んでいなければ電文が 1 通も出ない。
  it('控えから読めたら取得しない', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: enc.encode(JSON.stringify([manifestEntry('a1', 'VXSE53')])) },
      { name: 'a1.xml', content: enc.encode(quakeBody('石川県能登地方')) },
    ])
    vi.mocked(readArchiveBody).mockResolvedValueOnce(gz)
    // 本体の取得は 500 を返す設定。控えが効かなければ取りこぼしになる
    globalThis.fetch = mockArchives([
      { url: 'https://data.api.dmdata.jp/v1/archive/d1', gz: 'error' },
    ]) as unknown as typeof fetch

    const res = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(res.entries.length).toBeGreaterThan(0)
    expect(vi.mocked(writeArchiveBody)).not.toHaveBeenCalled()
  })

  // 対照: 控えから読めた分は門を通らない（通信しないので待つ理由がない）。
  // これが無いと「常に待つ」実装でもテストが通り、同じ日を読み直すたびに待たされる。
  it('控えから読めた分は待たない', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: enc.encode(JSON.stringify([manifestEntry('a1', 'VXSE53')])) },
      { name: 'a1.xml', content: enc.encode(quakeBody('石川県能登地方')) },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://data.api.dmdata.jp/v1/archive/d1', gz },
    ]) as unknown as typeof fetch

    // 1 回目で控えへ載せる（間隔 0 なので待たない）
    setDataApiGateIntervalForTest(0)
    await fetchDmdataReplayEvents('key', FROM, TO, false)

    // 2 回目は控えから読むので、間隔を長くしても待たない
    setDataApiGateIntervalForTest(5_000)
    const started = Date.now()
    await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('fetchDmdataReplayEvents の耐障害性', () => {
  const originalFetch = globalThis.fetch
  let warns: string[]
  let errors: string[]

  beforeEach(() => {
    clearReplayCache()
    warns = []
    errors = []
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearReplayCache()
    vi.restoreAllMocks()
  })

  it('正常なアーカイブから電文を取り込む', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('1234567abc')]) },
      { name: '1234567abc_20260810120500000_0.xml', content: quakeBody('岩手県沖') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(entries).toHaveLength(1)
    expect(entries[0].payload.kind).toBe('event')
  })

  // 設定「試験報を受信（検証用）」は**ライブだけでなく再生にも効く**。設定の文面は経路を
  // 限っていないのに片方だけに効かせると、名前から読み取れない食い違いになる。
  // 訓練報は年に数回しか流れないため、再生で拾えないと実電文で確かめる手段が事実上無くなる。
  describe('試験・訓練報の取り込み', () => {
    async function archiveWithBoth() {
      return makeTarGz([
        {
          name: 'telegrams.json',
          content: JSON.stringify([manifestEntry('1234567abc'), manifestTestEntry('7654321def')]),
        },
        { name: '1234567abc_20260810120500000_0.xml', content: quakeBody('岩手県沖') },
        { name: '7654321def_20260810120600000_0.xml', content: quakeBody('日本海中部') },
      ])
    }

    // 対照: 既定では捨てる。無条件に通すと平常時の再生が訓練版の報で混ざる。
    // **防いでいるのは扱う種別の訓練版**（VXSE45・VXSE51〜53 等）で、配信テストの VXSE42 は
    // この判定より後段の `HANDLED_TYPES` で落ちる（→ dmdataTelegramPayload.ts）。
    it('既定では試験報を取り込まない', async () => {
      globalThis.fetch = mockArchives([{ url: 'https://x/a', gz: await archiveWithBoth() }]) as unknown as typeof fetch
      const { entries, skipped } = await fetchDmdataReplayEvents('key', FROM, TO, false)
      expect(entries).toHaveLength(1)
      // 落としたのは「対象外」であって取りこぼしではない
      expect(skipped).toBe(0)
    })

    // 正: 設定を入れれば通る。**ここが落ちると、訓練報は実電文では一生画面に出ない。**
    it('設定を入れると試験報も取り込む', async () => {
      globalThis.fetch = mockArchives([{ url: 'https://x/a', gz: await archiveWithBoth() }]) as unknown as typeof fetch
      const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, true)
      expect(entries).toHaveLength(2)
    })

    // 正: 履歴（再生開始より前の地震カード）も同じ扱いにする。**別のコードパス**（QUAKE_TYPES
    // 限定・窓の判定が違う）なので、本編のテストでは写し間違いを検出できない。
    it('設定を入れると履歴にも試験報が入る', async () => {
      const gz = await makeTarGz([
        {
          name: 'telegrams.json',
          content: JSON.stringify([manifestEntry('1234567abc'), manifestTestEntry('7654321def')]),
        },
        { name: '1234567abc_20260810120500000_0.xml', content: quakeBody('岩手県沖') },
        { name: '7654321def_20260810120600000_0.xml', content: quakeBody('日本海中部') },
      ])
      globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch
      const withTest = await fetchDmdataQuakeHistory('key', TO, 10, 7, true)
      const without = await fetchDmdataQuakeHistory('key', TO, 10, 7, false)
      expect(withTest.quakes.length).toBe(without.quakes.length + 1)
    })

    // 安全弁: 緩めるのは `head.test` の判定だけ。対象外の種別まで通してはいけない。
    it('設定を入れても対象外の種別は取り込まない', async () => {
      const gz = await makeTarGz([
        {
          name: 'telegrams.json',
          // VXSE56 は「扱わないと決めた種別」（→ data-sources-spec.md §2）
          content: JSON.stringify([manifestTestEntry('7654321def', 'VXSE56')]),
        },
        { name: '7654321def_20260810120600000_0.xml', content: quakeBody('日本海中部') },
      ])
      globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch
      const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, true)
      expect(entries).toHaveLength(0)
    })
  })

  // 取りこぼしは UI へ出すため、件数を戻り値でも返す（ログだけだと
  // 「静かな時間帯だった」のか「取りこぼした」のかを呼び出し元が区別できない）。
  it('取りこぼした電文の件数を戻り値で返す', async () => {
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          manifestEntry('aaaaaaa1'),                                  // 本体が壊れている
          manifestEntry('bbbbbbb2'),                                  // 本体が無い
          manifestEntry('ccccccc3', 'VXSE53', 'not-a-date'),          // 時刻が不正
          manifestEntry('ddddddd4'),                                  // 正常
        ]),
      },
      { name: 'aaaaaaa1_20260810120500000_0.xml', content: '<Report><壊れた' },
      { name: 'ddddddd4_20260810120800000_0.xml', content: quakeBody('石廊崎沖') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(result.entries).toHaveLength(1)
    expect(result.skipped).toBe(3)
    expect(result.failedArchiveUrls).toHaveLength(0)
  })

  // ── 二進電文（IXAC41 推計震度分布図） ──
  //
  // アーカイブの中では `.bin` で入り、512KiB を超えると**目録の複数エントリに分かれる**。
  // 分割の結合はライブ経路と同じ入れ物を使うが、**呼び出し方はここにしか無い**。

  const BIN_TIME = '2026-08-10T12:06:00+09:00'

  // 正: `.bin` を読み取って分布として積む。
  // **これは「二進を文字列へ通していないか」の検査でもある。** `TextDecoder` を通すと
  // BUFR のバイトが U+FFFD へ潰れて読めなくなるので、読めた時点で素通しが保証される。
  it('二進電文を取り込む', async () => {
    const bin = buildSampleTelegram()
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('bin0001', 'IXAC41', BIN_TIME)]) },
      { name: 'bin0001_20260810120600000_0.bin', content: bin },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries, skipped } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(skipped).toBe(0)
    expect(entries).toHaveLength(1)
    expect(entries[0].payload.kind).toBe('estimatedIntensity')
  })

  // 正: 分割された 2 通が 1 つの分布に戻る。**目録では別々のエントリ**なので、
  // 結合しなければ「先頭だけ読めて末尾が化ける」ではなく、どちらも読めずに消える。
  it('分割された二進電文を結合して 1 通にする', async () => {
    const bin = buildSampleTelegram()
    const cut = 32
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          manifestEntry('bin0002', 'IXAC41', BIN_TIME, null),
          manifestEntry('bin0003', 'IXAC41', BIN_TIME, 'RRA'),
        ]),
      },
      { name: 'bin0002_20260810120600000_0.bin', content: bin.slice(0, cut) },
      { name: 'bin0003_20260810120600100_0.bin', content: bin.slice(cut) },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries, skipped } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(skipped).toBe(0)
    expect(entries).toHaveLength(1)
    expect(entries[0].payload.kind).toBe('estimatedIntensity')
  })

  // 安全弁: **揃わなかった断片を取りこぼしに数える。** 数えないと、他の電文は全部
  // 読めているのにその地震だけ分布が出ない状態が、手掛かりなしで起きる。
  it('断片が揃わなければ取りこぼしに数える', async () => {
    const bin = buildSampleTelegram()
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([manifestEntry('bin0004', 'IXAC41', BIN_TIME, null)]),
      },
      { name: 'bin0004_20260810120600000_0.bin', content: bin.slice(0, 32) },   // 続きが無い
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries, skipped } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(entries).toHaveLength(0)
    expect(skipped).toBe(1)
    expect(warns.join(' ')).toContain('断片が揃いませんでした')
  })

  // 安全弁: 本体が入っていなければ取りこぼしに数える（XML 側と同じ扱い）。
  it('二進電文の本体が無ければ取りこぼしに数える', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('bin0005', 'IXAC41', BIN_TIME)]) },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries, skipped } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(entries).toHaveLength(0)
    expect(skipped).toBe(1)
    expect(warns.join(' ')).toContain('二進電文の本体が見つからず')
  })

  // 安全弁: **1 通の障害を 2 件に数えない。** 断片の本体が入っていなければその電文は
  // 二度と揃わないので `pendingKeys` でも数えられる。取りこぼしの件数は「何通読めなかったか」を
  // 伝える値で、多い側へずれても嘘になる。
  it('断片の本体が欠けても取りこぼしを二重に数えない', async () => {
    const bin = buildSampleTelegram()
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          manifestEntry('bin0006', 'IXAC41', BIN_TIME, null),
          manifestEntry('bin0007', 'IXAC41', BIN_TIME, 'RRA'),
        ]),
      },
      { name: 'bin0006_20260810120600000_0.bin', content: bin.slice(0, 32) },   // RRA の本体が無い
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries, skipped } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(entries).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  // 安全弁: **断片が 2 つとも欠けても 1 件。** アーカイブの部分破損では複数が同時に欠ける。
  it('断片が 2 つとも欠けても取りこぼしは 1 件', async () => {
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          manifestEntry('bin0008', 'IXAC41', BIN_TIME, null),
          manifestEntry('bin0009', 'IXAC41', BIN_TIME, 'RRA'),
        ]),
      },
      // どちらの本体も入っていない
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries, skipped } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(entries).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  // 対照: 別々の電文なら別々に数える（まとめすぎていないこと）。
  it('別の電文の本体が欠けたらそれぞれ数える', async () => {
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          manifestEntry('bin0010', 'IXAC41', BIN_TIME, null),
          manifestEntry('bin0011', 'IXAC41', '2026-08-10T12:20:00+09:00', null),
        ]),
      },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { skipped } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(skipped).toBe(2)
  })

  it('一部のアーカイブが失敗した件数を戻り値で返す', async () => {
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('eeeeeee5')]) },
      { name: 'eeeeeee5_20260810120500000_0.xml', content: quakeBody('房総沖') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/broken', gz: 'error' },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(result.entries).toHaveLength(1)
    expect(result.failedArchiveUrls).toHaveLength(1)
  })

  // 「アーカイブは落ちてきたが目録が無い／壊れている」は、取得エラーと同じく中身を
  // 丸ごと読めない状態。ここを数え漏らすと、全アーカイブがこれに該当したときに
  // { skipped: 0, failedArchiveUrls: [] } が返り、UI が無警告のまま
  // 「電文 0 件の成功」に化ける。
  it('目録が無いアーカイブを読めなかった数に含める', async () => {
    const noManifest = await makeTarGz([{ name: 'body.json', content: quakeBody('無関係') }])
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('ggggggg7')]) },
      { name: 'ggggggg7_20260810120500000_0.xml', content: quakeBody('駿河湾') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/nomanifest', gz: noManifest },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(result.entries).toHaveLength(1)
    expect(result.failedArchiveUrls).toEqual(['https://x/nomanifest'])
  })

  it('目録が壊れているアーカイブを読めなかった数に含める', async () => {
    const brokenManifest = await makeTarGz([{ name: 'telegrams.json', content: '[[[壊れた' }])
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('hhhhhhh8')]) },
      { name: 'hhhhhhh8_20260810120500000_0.xml', content: quakeBody('相模湾') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/brokenmanifest', gz: brokenManifest },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(result.entries).toHaveLength(1)
    expect(result.failedArchiveUrls).toEqual(['https://x/brokenmanifest'])
  })

  it('全アーカイブの目録が読めない場合は例外にする（無警告の成功にしない）', async () => {
    const noManifest = await makeTarGz([{ name: 'body.json', content: quakeBody('無関係') }])
    globalThis.fetch = mockArchives([
      { url: 'https://x/a', gz: noManifest },
      { url: 'https://x/b', gz: noManifest },
    ]) as unknown as typeof fetch

    await expect(fetchDmdataReplayEvents('key', FROM, TO, false)).rejects.toThrow(/すべてを読み取れませんでした/)
  })

  /**
   * アーカイブが窓の日（JST 2026-08-10）を覆わないときの応答。
   * その日は当日経路（/v2/telegram・/v2/gd/eew）へ回る。
   */
  function mockArchivesWithLive(
    archives: Array<{ date: string; url: string; gz: Uint8Array | 'error' }>,
    live: 'empty' | 'error',
  ) {
    const items = archives.map(a => ({ classification: 'telegram.earthquake', date: a.date, url: a.url }))
    return vi.fn(async (input: string) => {
      if (input.includes('/v2/archive?')) {
        return { ok: true, json: async () => ({ status: 'ok', items }) } as unknown as Response
      }
      if (input.includes('/v2/telegram?') || input.includes('/v2/gd/eew')) {
        if (live === 'error') return { ok: false, status: 500 } as unknown as Response
        return { ok: true, json: async () => ({ status: 'ok', items: [] }) } as unknown as Response
      }
      const hit = archives.find(a => input === a.url)
      if (!hit || hit.gz === 'error') return { ok: false, status: 500 } as unknown as Response
      return { ok: true, arrayBuffer: async () => hit.gz as unknown as ArrayBuffer } as unknown as Response
    })
  }

  // 当日経路の失敗をそのまま投げると、既に読めているアーカイブ側の電文まで巻き添えで捨てられる。
  // この関数は本編と初期状態の 2 回 Promise.all で呼ばれるため、再生自体が始まらなくなる。
  //
  // **窓の日（8/10）のアーカイブは無く、翌日（8/11）のアーカイブに 8/10 23:59 発表の電文が
  // 入っている形にしてある。** アーカイブの日の区切りは配信（受信）側なので、日付の境目を
  // 跨いだ電文はこう入る（→ `dmdataReplayLive.ts` の `archiveDaysForWindow`）。翌日を
  // 落とさない実装だとこの電文が消え、同時に 8/10 が当日経路へ回ることも確かめられる。
  it('当日経路が読めなくても、アーカイブから読めた分は残す', async () => {
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([manifestEntry('aaaaaaa1', 'VXSE53', '2026-08-10T23:59:00+09:00')]),
      },
      // ファイル名の 17 桁は UTC のミリ秒精度の受信時刻（= JST 8/10 23:59:30）
      { name: 'aaaaaaa1_20260810145930000_0.xml', content: quakeBody('岩手県沖') },
    ])
    globalThis.fetch = mockArchivesWithLive([{ date: '2026-08-11', url: 'https://x/d11', gz }], 'error') as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(result.entries).toHaveLength(1)
    // 読めなかった日は取得元の識別子として数える（無言で消すと「静かな時間帯」と区別が付かない）
    expect(result.failedArchiveUrls).toContain('live:2026-08-10')
  })

  // 目録の範囲も窓の JST 日から導く。**左端は排他**なので 1 日手前を指す（実測。
  // → `dmdataReplayLive.ts` の `archiveListRange`）。かつては窓の **UTC 日付**へ
  // 両端 ±1 日を足しており、1 日に収まる窓でも余計な日が返っていた。
  it('目録の範囲は窓の JST 日から導く（左端は 1 日手前）', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('aaaaaaa1')]) },
      { name: 'aaaaaaa1_20260810120500000_0.xml', content: quakeBody('岩手県沖') },
    ])
    const fn = mockArchivesWithLive([{ date: '2026-08-10', url: 'https://x/d10', gz }], 'empty')
    globalThis.fetch = fn as unknown as typeof fetch

    // 窓は JST 8/10 00:00〜8/11 00:00（終端は含まない）
    await fetchDmdataReplayEvents('key', FROM, TO, false)

    const listUrl = fn.mock.calls.map(c => c[0]).find(u => u.includes('/v2/archive?'))
    expect(listUrl).toContain('datetime=2026-08-09%7E2026-08-11')
  })

  // **`limit` は明示して渡す。** 配信元の既定は 20 件で、指定すれば 100 件まで返る
  // （リファレンス「デフォルト: 20 … 最大は100」）。渡さないでいた頃は「この API は 1 回に
  // 20 件しか返さない」と誤解しており、同じ範囲を読むのに 5 倍のページを辿っていた。
  it('目録の取得は limit を明示して渡す', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('aaaaaaa1')]) },
      { name: 'aaaaaaa1_20260810120500000_0.xml', content: quakeBody('岩手県沖') },
    ])
    const fn = mockArchivesWithLive([{ date: '2026-08-10', url: 'https://x/d10', gz }], 'empty')
    globalThis.fetch = fn as unknown as typeof fetch

    await fetchDmdataReplayEvents('key', FROM, TO, false)

    const listUrl = fn.mock.calls.map(c => c[0]).find(u => u.includes('/v2/archive?'))
    expect(listUrl).toContain('limit=100')
    // `URLSearchParams` の初期化をまとめて書き換えたので、**他のパラメータが落ちていないことも
    // ここで見る**（範囲と分類はどちらも欠けると目録が別のものになる）。
    expect(listUrl).toContain('datetime=2026-08-09%7E2026-08-11')
    expect(listUrl).toContain('classification=')
  })

  // 対照: 本体（`/v1/archive/:id`）は目録が返した URL をそのまま叩く。件数の概念が無いので
  // `limit` は付かない。一覧の組み立て方を本体へ流用すると、意味を持たないパラメータが付く。
  // **いまの実装では一覧と本体で `fetch` の呼び出しが分かれているので、このテストは恒常的に通る。**
  // 両者のコードパスを 1 本へまとめるリファクタが入ったときに意味を持つ。
  it('アーカイブ本体の URL には limit を付けない', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('aaaaaaa1')]) },
      { name: 'aaaaaaa1_20260810120500000_0.xml', content: quakeBody('岩手県沖') },
    ])
    const fn = mockArchivesWithLive([{ date: '2026-08-10', url: 'https://x/d10', gz }], 'empty')
    globalThis.fetch = fn as unknown as typeof fetch

    await fetchDmdataReplayEvents('key', FROM, TO, false)

    const bodyUrls = fn.mock.calls.map(c => c[0] as string).filter(u => u.startsWith('https://x/'))
    expect(bodyUrls).toEqual(['https://x/d10'])
  })

  // 安全弁: **2 ページ目以降も `limit` と範囲が落ちない。** 配信元は cursorToken を使うとき
  // 「以前と同じ検索クエリパラメータを指定する」ことを求めており、落とすと 2 ページ目から
  // 既定の 20 件へ戻る（ページ数が増え、上限にも早く達する）。`URLSearchParams` をページごとに
  // 作り直す形なので、初期化から外して `set` で足すと落ちうる。
  it('2 ページ目以降も limit と範囲を渡し続ける', async () => {
    const fn = vi.fn(async (input: string) => {
      if (input.includes('/v2/archive?')) {
        // 1 ページ目だけ nextToken を返して 2 ページ目を辿らせる
        if (input.includes('cursorToken=tok1')) {
          return { ok: true, json: async () => ({ status: 'ok', items: [] }) } as unknown as Response
        }
        return {
          ok: true,
          json: async () => ({ status: 'ok', items: [], nextToken: 'tok1' }),
        } as unknown as Response
      }
      if (input.includes('/v2/telegram?') || input.includes('/v2/gd/eew')) {
        return { ok: true, json: async () => ({ status: 'ok', items: [] }) } as unknown as Response
      }
      return { ok: false, status: 500 } as unknown as Response
    })
    globalThis.fetch = fn as unknown as typeof fetch

    await fetchDmdataReplayEvents('key', FROM, TO, false)

    const listUrls = fn.mock.calls.map(c => c[0] as string).filter(u => u.includes('/v2/archive?'))
    expect(listUrls.length).toBeGreaterThanOrEqual(2)
    for (const u of listUrls) {
      expect(u).toContain('limit=100')
      expect(u).toContain('datetime=2026-08-09%7E2026-08-11')
    }
    expect(listUrls.filter(u => u.includes('cursorToken=tok1'))).toHaveLength(1)
  })
  // 本体（`/v1/archive/:id`）は 1 日分がまとめて入っていて重い。目録が返した分をそのまま
  // 全件落としていた頃は、1 日に収まる窓でも余計な日を取って時刻で捨てていた。
  it('窓の外の日のアーカイブ本体は落とさない', async () => {
    const inside = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('aaaaaaa1')]) },
      { name: 'aaaaaaa1_20260810120500000_0.xml', content: quakeBody('岩手県沖') },
    ])
    const outside = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('bbbbbbb2', 'VXSE53', '2026-08-08T12:05:00+09:00')]) },
      { name: 'bbbbbbb2_20260808120500000_0.xml', content: quakeBody('宮城県沖') },
    ])
    const fn = mockArchivesWithLive([
      // 窓は JST 8/10 の 1 日。8/08 は窓の外（前日より前）
      { date: '2026-08-08', url: 'https://x/d08', gz: outside },
      { date: '2026-08-10', url: 'https://x/d10', gz: inside },
    ], 'empty')
    globalThis.fetch = fn as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(result.entries).toHaveLength(1)
    const fetched = fn.mock.calls.map(c => c[0]).filter(u => u.startsWith('https://x/'))
    expect(fetched).toEqual(['https://x/d10'])
  })

  // 安全弁: **前日は落とさないが、翌日は落とす。** 受信は発表より前になりえないので前日は
  // 要らないが、翌日は日付の境目を跨いだ電文が入りうるので外せない。
  it('翌日のアーカイブ本体は落とす（前日は落とさない）', async () => {
    const day = async (id: string, pub: string) => makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry(id, 'VXSE53', pub)]) },
      { name: `${id}_20260810120500000_0.xml`, content: quakeBody('岩手県沖') },
    ])
    const fn = mockArchivesWithLive([
      { date: '2026-08-09', url: 'https://x/d09', gz: await day('aaaaaaa1', '2026-08-09T12:05:00+09:00') },
      { date: '2026-08-10', url: 'https://x/d10', gz: await day('bbbbbbb2', '2026-08-10T12:05:00+09:00') },
      { date: '2026-08-11', url: 'https://x/d11', gz: await day('ccccccc3', '2026-08-10T23:59:00+09:00') },
    ], 'empty')
    globalThis.fetch = fn as unknown as typeof fetch

    await fetchDmdataReplayEvents('key', FROM, TO, false)

    const fetched = fn.mock.calls.map(c => c[0]).filter(u => u.startsWith('https://x/')).sort()
    expect(fetched).toEqual(['https://x/d10', 'https://x/d11'])
  })

  // 取得元が当日経路 1 本しか無い窓（＝当日だけを指す本編の 1 時間）でこれを部分成功に落とすと、
  // 電文 0 件のまま「再生中」になる。全滅判定の分母をアーカイブの本数ではなく取得元の日数で
  // 取っているのはこのため。
  it('取得元が当日経路だけで、それが読めなければ例外にする', async () => {
    globalThis.fetch = mockArchivesWithLive([], 'error') as unknown as typeof fetch

    await expect(fetchDmdataReplayEvents('key', FROM, TO, false)).rejects.toThrow(/すべてを読み取れませんでした/)
  })

  it('読めなかったアーカイブは URL で返す（呼び出し元が重複を除けるように）', async () => {
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('iiiiiii9')]) },
      { name: 'iiiiiii9_20260810120500000_0.xml', content: quakeBody('若狭湾') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/broken', gz: 'error' },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO, false)

    // 本編と初期状態が同じアーカイブを読んでも、呼び出し元は URL で重複を除ける
    expect(result.failedArchiveUrls).toEqual(['https://x/broken'])
  })

  it('すべて正常なら skipped も failedArchives も 0', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('fffffff6')]) },
      { name: 'fffffff6_20260810120500000_0.xml', content: quakeBody('伊豆大島近海') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(result.entries).toHaveLength(1)
    expect(result.skipped).toBe(0)
    expect(result.failedArchiveUrls).toHaveLength(0)
  })

  it('破損した電文が 1 通あっても、他の電文は取り込まれる（全滅しない）', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('aaaaaaa1'), manifestEntry('bbbbbbb2')]) },
      { name: 'aaaaaaa1_20260810120500000_0.xml', content: '<Report><これは XML ではない' },
      { name: 'bbbbbbb2_20260810120600000_0.xml', content: quakeBody('宮城県沖') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)

    // 壊れていない側は取り込めている
    expect(entries).toHaveLength(1)
    // 捨てた事実はログに残る（無言で消さない）
    // **XML の壊れ方は例外にならない** ―― DOMParser は投げず parsererror を含む文書を返すため、
    // パーサが null を返して warn 側に出る（JSON だった頃は JSON.parse が投げて error 側だった）。
    // どちらに出るかではなく「残ること」が要件なので、両方を見る。
    expect([...warns, ...errors].join('\n')).toMatch(/aaaaaaa1/)
  })

  it('telegrams.json が無いアーカイブは警告を残してスキップし、他のアーカイブは処理する', async () => {
    const broken = await makeTarGz([{ name: 'body.json', content: quakeBody('無関係') }])
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('ccccccc3')]) },
      { name: 'ccccccc3_20260810120500000_0.xml', content: quakeBody('福島県沖') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/broken', gz: broken },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(entries).toHaveLength(1)
    expect(warns.join('\n')).toMatch(/telegrams\.json/)
  })

  it('telegrams.json 自体が壊れていても他のアーカイブは処理する', async () => {
    const broken = await makeTarGz([{ name: 'telegrams.json', content: '[[[壊れた目録' }])
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('ddddddd4')]) },
      { name: 'ddddddd4_20260810120500000_0.xml', content: quakeBody('三陸沖') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/broken', gz: broken },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(entries).toHaveLength(1)
    expect(errors.join('\n')).toMatch(/telegrams\.json/)
  })

  it('本体ファイルが見つからない電文は警告を残してスキップする', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('eeeeeee5')]) },
      // eeeeeee5 に対応する本体を意図的に入れない
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(entries).toHaveLength(0)
    expect(warns.join('\n')).toMatch(/本体が見つからず/)
  })

  it('head.time が不正な電文は警告を残してスキップする（Invalid Date を通さない）', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('fffffff6', 'VXSE53', 'not-a-date')]) },
      { name: 'fffffff6_20260810120500000_0.xml', content: quakeBody('日向灘') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(entries).toHaveLength(0)
    expect(warns.join('\n')).toMatch(/head\.time/)
  })

  // new Date(null) は Invalid Date ではなく 1970-01-01 を返す。数値チェックだけだと
  // すり抜けて、直後の「範囲外なら continue」に古い電文として無言で吸収される。
  it('head.time が null の電文も警告を残してスキップする（1970年に化けさせない）', async () => {
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          { id: 'nulltime', originalId: 'nulltime', classification: 'telegram.earthquake', head: { type: 'VXSE53', time: null, test: false } },
          manifestEntry('jjjjjjj0'),
        ]),
      },
      { name: 'jjjjjjj0_20260810120500000_0.xml', content: quakeBody('種子島近海') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(result.entries).toHaveLength(1)
    expect(result.skipped).toBe(1)
    expect(warns.join('\n')).toMatch(/head\.time/)
  })

  it('対象外の種別は警告を出さない（正常運転でログを埋めない）', async () => {
    const gz = await makeTarGz([
      // 対象外の種別（VXSE56＝南海トラフ地震に関連する情報。VYSE50 と同内容の複製なので
      // 扱わないと決めている。→ docs/spec/data-sources-spec.md §2「扱う電文種別」）。
      // 本体ファイルが無くても警告は出ないこと
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('9999999z', 'VXSE56')]) },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(entries).toHaveLength(0)
    expect(warns.join('\n')).not.toMatch(/本体が見つからず/)
  })

  // 実アーカイブでは manifest に同じ電文が XML 版と JSON 版の 2 エントリで載る
  // （originalId を持つ方が JSON 版）。XML 版を落とすのは正常な重複排除なので、
  // ここで警告を出すと通常のリプレイ 1 回で数十件のログが出て異常が埋もれる。
  it('originalId を持つ JSON 版エントリは、警告なしで XML 版だけを取り込む', async () => {
    const xmlId = 'aaa1111x'
    const jsonId = 'bbb2222j'
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          { id: xmlId, classification: 'telegram.earthquake', head: { type: 'VXSE53', time: '2026-08-10T12:05:00+09:00', test: false } },
          { id: jsonId, originalId: xmlId, classification: 'telegram.earthquake', head: { type: 'VXSE53', time: '2026-08-10T12:05:00+09:00', test: false } },
        ]),
      },
      { name: `${xmlId}_20260810120500000_0.xml`, content: quakeBody('石狩地方中部') },
      // 拡張子も実アーカイブどおり分ける。`.xml` を探す処理が JSON 版を拾わないことも併せて見る。
      { name: `${jsonId}_20260810120500000_0.json`, content: '{"_originalId":"x"}' },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)

    // 二重に取り込まれない
    expect(entries).toHaveLength(1)
    // JSON 版を落としたことで警告が出ない
    expect(warns.join('\n')).not.toMatch(/originalId/)
    expect(warns.join('\n')).not.toMatch(/本体が見つからず/)
  })

  it('アーカイブ取得が全滅した場合は例外として伝播する（無言で 0 件にしない）', async () => {
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz: 'error' }]) as unknown as typeof fetch

    await expect(fetchDmdataReplayEvents('key', FROM, TO, false)).rejects.toThrow(/Archive fetch failed/)
  })

  // ここが今回の要。1 つのアーカイブの破損で、他のアーカイブから読めた電文まで
  // 巻き添えにしてはいけない（Promise.all の即時 reject に素通しすると全滅する）。
  it('一部のアーカイブが取得失敗しても、残りのアーカイブの電文は取り込まれる', async () => {
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('8888888h')]) },
      { name: '8888888h_20260810120500000_0.xml', content: quakeBody('十勝沖') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/broken', gz: 'error' },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(entries).toHaveLength(1)
    expect(errors.join('\n')).toMatch(/アーカイブの取得・展開に失敗/)
  })

  it('tar が破損したアーカイブがあっても、他のアーカイブの電文は取り込まれる', async () => {
    // サイズヘッダを壊した tar（parseTar が throw する）を gzip したもの
    const brokenTar = (() => {
      const h = new Uint8Array(HEADER)
      h.set(enc.encode('broken.json'), 0)
      h.set(enc.encode('zzzzzzzzzzz'), 124)
      h[156] = '0'.charCodeAt(0)
      const out = new Uint8Array(HEADER * 3)
      out.set(h, 0)
      return out
    })()
    const brokenGz = new Uint8Array(await new Response(
      new Blob([brokenTar as BlobPart]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer())

    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('6666666k')]) },
      { name: '6666666k_20260810120500000_0.xml', content: quakeBody('遠州灘') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/brokentar', gz: brokenGz },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(entries).toHaveLength(1)
    expect(errors.join('\n')).toMatch(/アーカイブの取得・展開に失敗/)
  })

  it('南海トラフ系（VYSE）の JSON 版エントリは警告なしでスキップされる', async () => {
    // VYSE は XML パーサでしか読めないため XML 版のみを拾う。JSON 版を弾かないと
    // 「.xml が見つからない」警告が実運用で出続ける。
    const xmlId = 'vvvv111x'
    const jsonId = 'vvvv222j'
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          { id: xmlId, classification: 'telegram.earthquake', head: { type: 'VYSE51', time: '2026-08-10T12:05:00+09:00', test: false } },
          { id: jsonId, originalId: xmlId, classification: 'telegram.earthquake', head: { type: 'VYSE51', time: '2026-08-10T12:05:00+09:00', test: false } },
        ]),
      },
      { name: `${xmlId}_20260810120500000_0.xml`, content: '<Report/>' },
      { name: `${jsonId}_20260810120500000_0.xml`, content: '{}' },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(warns.join('\n')).not.toMatch(/本体が見つからず/)
  })

  it('head を持たない目録エントリがあっても他の電文は取り込まれる', async () => {
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          { id: 'nohead01', classification: 'telegram.earthquake' },
          manifestEntry('5555555m'),
        ]),
      },
      { name: '5555555m_20260810120500000_0.xml', content: quakeBody('紀伊水道') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(entries).toHaveLength(1)
    expect(warns.join('\n')).toMatch(/head を持たない/)
  })

  it('取得に失敗したアーカイブはキャッシュに残らず、次の試行で再取得される', async () => {
    // 1 回目は 500、2 回目は成功する fetch を用意する
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('7777777g')]) },
      { name: '7777777g_20260810120500000_0.xml', content: quakeBody('浦河沖') },
    ])
    let attempt = 0
    globalThis.fetch = vi.fn(async (input: string) => {
      if (input.includes('/v2/archive?')) {
        return {
          ok: true,
          json: async () => ({ status: 'ok', items: [{ classification: 'telegram.earthquake', date: '2026-08-10', url: 'https://x/a' }] }),
        } as unknown as Response
      }
      attempt++
      if (attempt === 1) return { ok: false, status: 500 } as unknown as Response
      return { ok: true, arrayBuffer: async () => good as unknown as ArrayBuffer } as unknown as Response
    }) as unknown as typeof fetch

    await expect(fetchDmdataReplayEvents('key', FROM, TO, false)).rejects.toThrow()
    // clearReplayCache を挟まずに再試行しても、失敗はキャッシュされていないので回復する
    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(entries).toHaveLength(1)
  })
})

// リプレイは設定タブのボタンで起動し、デバウンス前の生のキーをそのまま使う（App.tsx の意図的な設計）。
// ライブ経路と違って事前ゲートが無いため、ここが最後の防壁になる。
// 投げるのが DOMException ではなく DmdataApiKeyError であることを固定する
//（呼び出し側の useReplayController はメッセージをそのまま replayError として画面に出すため、
//  英語の DOMException に戻ると利用者に理由が伝わらなくなる）。
describe('APIキーが不正なとき', () => {
  // fetch を直接差し替えるため、この describe でも後始末をする。
  // 上の describe の afterEach は届かない（兄弟のため）。
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('通信を試みず DmdataApiKeyError を投げる', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('通信してはいけない') })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(fetchDmdataReplayEvents('abc123あ', FROM, TO, false)).rejects.toThrow(DmdataApiKeyError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// 地震カードの履歴取得。再生される電文の取得とは目的が違い、「指定時刻より前に発表された
// 地震を、必要な件数だけ集める」ことに絞ってある。日次アーカイブを新しい日から遡り、
// 件数に届いた時点でそれより古い日は解析しない。
describe('fetchDmdataQuakeHistory', () => {
  const originalFetch = globalThis.fetch

  /**
   * 履歴用に、日付を明示できる archive リストを組み立てる（新旧の順序が判定に効くため）。
   *
   * アーカイブが無い日は当日経路（/v2/telegram）へ回るため、そちらの応答も用意する。
   * 既定は「電文なし」。全断を再現したいときだけ `live: 'error'` を渡す。
   */
  function mockHistoryArchives(
    archives: Array<{ date: string; url: string; gz: Uint8Array | 'error' }>,
    live: 'empty' | 'error' = 'empty',
  ) {
    const items = archives.map(a => ({ classification: 'telegram.earthquake', date: a.date, url: a.url }))
    return vi.fn(async (input: string) => {
      if (input.includes('/v2/archive?')) {
        return { ok: true, json: async () => ({ status: 'ok', items }) } as unknown as Response
      }
      if (input.includes('/v2/telegram?')) {
        if (live === 'error') return { ok: false, status: 500 } as unknown as Response
        return { ok: true, json: async () => ({ status: 'ok', items: [] }) } as unknown as Response
      }
      const hit = archives.find(a => input === a.url)
      if (!hit || hit.gz === 'error') return { ok: false, status: 500 } as unknown as Response
      return { ok: true, arrayBuffer: async () => hit.gz as unknown as ArrayBuffer } as unknown as Response
    })
  }

  /** eventId と発表時刻を指定できる電文本体（既定の quakeBody は eventId が固定のため）。 */
  function historyBody(eventId: string, reportTime: string, serial = '1'): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>震源・震度に関する情報</Title><Status>通常</Status><EditorialOffice>気象庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>震源・震度に関する情報</Title>
<ReportDateTime>${reportTime}</ReportDateTime>
<TargetDateTime>${reportTime}</TargetDateTime>
<EventID>${eventId}</EventID>
<InfoType>発表</InfoType>
<Serial>${serial}</Serial>
</Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Earthquake>
<OriginTime>${reportTime}</OriginTime>
<ArrivalTime>${reportTime}</ArrivalTime>
<Hypocenter><Area><Name>岩手県沖</Name><jmx_eb:Coordinate>+39.9+142.2-50000/</jmx_eb:Coordinate></Area></Hypocenter>
<jmx_eb:Magnitude type="Mj">5.1</jmx_eb:Magnitude>
</Earthquake>
<Intensity><Observation><MaxInt>4</MaxInt></Observation></Intensity>
</Body>
</Report>`
  }

  /** 1 日ぶんのアーカイブ。id 先頭 7 文字がファイル名に含まれる必要がある。 */
  async function dayArchive(
    telegrams: Array<{
      id: string; eventId: string; time: string; serial?: string; type?: string
      /** 電文本体の `Head/ReportDateTime`。目録の `head.time` と別の値にしたいときだけ渡す。 */
      bodyTime?: string
    }>,
  ) {
    return makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify(telegrams.map(t => manifestEntry(t.id, t.type ?? 'VXSE53', t.time))),
      },
      ...telegrams.map(t => ({
        name: `${t.id}_20260810120500000_0.xml`,
        content: historyBody(t.eventId, t.bodyTime ?? t.time, t.serial),
      })),
    ])
  }

  beforeEach(() => { clearReplayCache() })
  afterEach(() => {
    globalThis.fetch = originalFetch
    clearReplayCache()
    vi.restoreAllMocks()
  })

  // アーカイブは日単位なので、指定時刻と同じ日の「まだ発表されていない」電文が必ず混ざる。
  // 落とさないと、再生開始前の一覧に未来の地震が並ぶ。
  it('指定時刻より後に発表された電文は採らない', async () => {
    const gz = await dayArchive([
      { id: 'aaaaaaa1', eventId: '20260810090000', time: '2026-08-10T09:05:00+09:00' },
      { id: 'bbbbbbb2', eventId: '20260810180000', time: '2026-08-10T18:05:00+09:00' },
    ])
    globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    expect(result.quakes).toHaveLength(1)
    expect(result.quakes[0].id).toContain('20260810090000')
  })

  // `mergeQuakeHistory` は安定ソートで畳み込むため、**発表時刻が同値の電文どうしは入力配列の
  // 相対順序がそのまま結果に効く**。詳しい電文が先・粗い電文が後だと粗い方が上書きする。
  // 目録の並びも日の処理順（新しい日から）も、この並びを保証しない。
  it('正: 発表時刻が同値なら「速報→詳細」の順に並べ直す', async () => {
    const gz = await dayArchive([
      // 目録では詳細（VXSE53）が先。並べ直さなければこの順で返る
      { id: 'aaaaaaa1', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00', type: 'VXSE53' },
      { id: 'bbbbbbb2', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00', type: 'VXSE51' },
    ])
    globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    expect(result.quakes.map(q => q.issue.type)).toEqual(['震度速報', '震源・震度情報'])
  })

  // 対照: 種別優先度で並べ替えるのは同値のときだけ。時刻が違えば時刻に従う
  // （常に種別で並べると、あとから届いた震度速報の続報が古い詳細より前に来る）。
  it('対照: 発表時刻が違えば時刻の昇順に従う（種別では入れ替えない）', async () => {
    const gz = await dayArchive([
      { id: 'aaaaaaa1', eventId: '20260810010000', time: '2026-08-10T02:05:00+09:00', type: 'VXSE51' },
      { id: 'bbbbbbb2', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00', type: 'VXSE53' },
    ])
    globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    expect(result.quakes.map(q => q.issue.type)).toEqual(['震源・震度情報', '震度速報'])
  })

  // 安全弁: 日時として読めない時刻が混ざっても、比較関数が全順序のままであること。
  // 「読めないものは据え置いて種別だけで比べる」形だと、読めない a と読める b・c について
  // a=b・a=c なのに b<c が成り立ちうる（`Array.prototype.sort` の結果が実装依存になる）。
  // 読めない時刻を末尾へ寄せることで全順序になり、並びが決まる。
  it('安全弁: 読めない発表時刻は末尾へ寄せ、読める分の並びを崩さない', async () => {
    const gz = await dayArchive([
      { id: 'aaaaaaa1', eventId: '20260810020000', time: '2026-08-10T02:05:00+09:00' },
      // 目録の時刻は読めるが、**電文本体の発表時刻**が読めない形（目録側が読めない電文は
      // 本体を取る前に取りこぼしとして弾かれるので、この並べ替えには届かない）
      { id: 'bbbbbbb2', eventId: '20260810030000', time: '2026-08-10T03:05:00+09:00', bodyTime: 'これは日時ではない' },
      { id: 'ccccccc3', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00' },
    ])
    globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    // 読めない 1 件も捨てない（同一性の判定に使う時刻を落とさない方針）
    expect(result.quakes).toHaveLength(3)
    // 01:05 → 02:05 → 読めない分、の順
    expect(result.quakes.map(q => q.time)).toEqual([
      '2026-08-10T01:05:00+09:00',
      '2026-08-10T02:05:00+09:00',
      'これは日時ではない',
    ])
  })

  // 安全弁: 日は新しい順に処理するので、並べ直さないと日をまたいだ並びが逆になる。
  it('安全弁: 日をまたいでも時刻の昇順で返す', async () => {
    const newer = await dayArchive([
      { id: 'aaaaaaa1', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00' },
    ])
    const older = await dayArchive([
      { id: 'ccccccc3', eventId: '20260809010000', time: '2026-08-09T01:05:00+09:00' },
    ])
    globalThis.fetch = mockHistoryArchives([
      { date: '2026-08-09', url: 'https://x/d09', gz: older },
      { date: '2026-08-10', url: 'https://x/d10', gz: newer },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    expect(result.quakes.map(q => q.id.includes('20260809010000'))).toEqual([true, false])
  })

  // アーカイブ本体は 6 秒の門を通るので、**揃うまで待つと 7 日ぶんで 40 秒ちかく画面が空になる**
  // （実測）。1 日ずつ落として、読めた日から `onPartial` へ流す。
  describe('取れた日から順に反映する', () => {
    // 正: 2 日ぶんのうち 1 日目を読み終えた時点で流れる。
    // **`onPartial` の呼び出し回数ではなく「本体を全部落とし終える前に流れたか」を見る** ——
    // 回数だけだと、`Promise.all` で揃えてから日ごとに流す形（＝直したかった形）でも通る。
    it('本体を全部落とし終える前に流す', async () => {
      const gz = await makeTarGz([
        { name: 'telegrams.json', content: enc.encode(JSON.stringify([manifestEntry('h1', 'VXSE53')])) },
        { name: 'h1.xml', content: enc.encode(historyBody('20260810120000', '2026-08-10T12:06:00+09:00')) },
      ])
      /** 何件目の本体を落としている時点で `onPartial` が呼ばれたか。 */
      const partialAt: number[] = []
      let downloaded = 0
      const base = mockHistoryArchives([
        { date: '2026-08-09', url: 'https://x/d09', gz },
        { date: '2026-08-10', url: 'https://x/d10', gz },
      ])
      globalThis.fetch = (async (input: string) => {
        if (String(input).startsWith('https://x/')) downloaded++
        return base(String(input))
      }) as unknown as typeof fetch

      await fetchDmdataQuakeHistory(
        'key', new Date('2026-08-10T23:00:00+09:00'), 50, 7, false,
        () => { partialAt.push(downloaded) },
      )

      expect(downloaded).toBe(2)
      // 2 件目を落とす前に 1 回は流れている（揃えてから流す形だと最小値が 2 になる）
      expect(Math.min(...partialAt)).toBe(1)
    })
  })

  // 429 の窓による見送りは「取得できなかった」ではない。**打てる手が違う**（取得の失敗は
  // 再読み込み、こちらは窓が明けるまで待つ）ので、別の枠で数える。
  describe('429 の窓による見送りは取得の失敗と分ける', () => {
    /** 本体だけ 429 を返す（目録と当日経路は通す）。 */
    function mock429(url: string) {
      return vi.fn(async (input: string) => {
        if (input.includes('/v2/archive?')) {
          return {
            ok: true,
            json: async () => ({ status: 'ok', items: [{ classification: 'telegram.earthquake', date: '2026-08-10', url }] }),
          } as unknown as Response
        }
        if (input.includes('/v2/telegram?')) {
          return { ok: true, json: async () => ({ status: 'ok', items: [] }) } as unknown as Response
        }
        return { ok: false, status: 429 } as unknown as Response
      })
    }

    // 正: 1 度 429 を受けたら窓が立ち、次は取りに行かず `rateLimitedSources` へ入る。
    // **`failedArchiveUrls` へ入れてはいけない** —— 表示側がそれを読んで
    // 「再読み込みで取得し直します」と案内するため、窓待ちには当たらない案内になる。
    it('窓が立っているあいだは rateLimitedSources へ入り、failedArchiveUrls には入らない', async () => {
      const url = 'https://data.api.dmdata.jp/v1/archive/rl1'
      globalThis.fetch = mock429(url) as unknown as typeof fetch

      // 1 回目: 配信元から 429 を受ける（ここは取得の失敗として数える）
      const first = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T23:00:00+09:00'), 50, 7, false)
      expect(first.failedArchiveUrls).toContain(url)
      expect(first.rateLimitedSources).toEqual([])

      // 2 回目: 窓が明けていないので投げずに見送る
      clearReplayCache()
      const second = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T23:00:00+09:00'), 50, 7, false)
      expect(second.rateLimitedSources).toContain(url)
      expect(second.failedArchiveUrls).not.toContain(url)
    })

    // 安全弁: 全部が見送りでも例外にしない。
    // **全滅判定は認証切れ・全断を捕まえるためのもの**で、こちら側の意図的な待ちを混ぜると
    // 窓が広いあいだ「取得に失敗した」として例外へ倒れ、取れていた分ごと捨てる。
    it('全部が見送りでも例外にしない', async () => {
      const url = 'https://data.api.dmdata.jp/v1/archive/rl2'
      globalThis.fetch = mock429(url) as unknown as typeof fetch

      await fetchDmdataQuakeHistory('key', new Date('2026-08-10T23:00:00+09:00'), 50, 7, false)
      clearReplayCache()

      // 窓が立った状態で呼び直す。この日以外の取得元は当日経路（電文なし）だけ
      await expect(
        fetchDmdataQuakeHistory('key', new Date('2026-08-10T23:00:00+09:00'), 50, 7, false),
      ).resolves.toMatchObject({ rateLimitedSources: [url] })
    })

    // 安全弁: **失敗と見送りが混ざって「1 件も取れていない」ときは例外にする。**
    //
    // 分子（`failedArchiveUrls`）から見送りを外すだけでは足りない —— 分母（`usedDays`）は
    // 見送った日も数えているので、そのままだと等号が成立せず**例外が飛ばない**。
    // 認証切れ・全断を捕まえるための判定が握り潰され、「履歴 0 件の成功」に化ける。
    it('失敗と見送りが混ざって 1 件も取れなければ例外にする', async () => {
      const rlUrl = 'https://data.api.dmdata.jp/v1/archive/mix-rl'
      const failUrl = 'https://data.api.dmdata.jp/v1/archive/mix-fail'
      // **取得元を全部落とす。** 目録が返すのは 2 日ぶんで、残りの日は当日経路へ回るので、
      // そちらも失敗させないと「全滅」にならない（当日経路が電文 0 件で成功すると、
      // それは取得元として読めた日に数える）。
      const mock = (rlStatus: number) => vi.fn(async (input: string) => {
        if (String(input).includes('/v2/archive?')) {
          return {
            ok: true,
            json: async () => ({
              status: 'ok',
              items: [
                { classification: 'telegram.earthquake', date: '2026-08-10', url: rlUrl },
                { classification: 'telegram.earthquake', date: '2026-08-09', url: failUrl },
              ],
            }),
          } as unknown as Response
        }
        if (String(input).includes('/v2/telegram?')) return { ok: false, status: 500 } as unknown as Response
        return { ok: false, status: String(input) === rlUrl ? rlStatus : 500 } as unknown as Response
      })

      // 1 回目: 429 と 500 をそれぞれ受ける（どちらも取得の失敗なので全滅）
      globalThis.fetch = mock(429) as unknown as typeof fetch
      await expect(
        fetchDmdataQuakeHistory('key', new Date('2026-08-10T23:00:00+09:00'), 50, 7, false),
      ).rejects.toThrow(/すべてを読み取れませんでした/)

      // 2 回目: 429 側は窓で見送り、残りは取りに行って失敗する。
      // **実質は 1 件も取れていない**ので、ここでも例外にならなければおかしい。
      // 分母から見送りを引いていないと、等号が成立せず素通りする。
      clearReplayCache()
      await expect(
        fetchDmdataQuakeHistory('key', new Date('2026-08-10T23:00:00+09:00'), 50, 7, false),
      ).rejects.toThrow(/すべてを読み取れませんでした/)
    })

    // 対照: 429 以外の失敗では窓を置かない（次の操作で取り直してよい）。
    it('429 以外の失敗では窓を置かない', async () => {
      const url = 'https://data.api.dmdata.jp/v1/archive/rl3'
      globalThis.fetch = vi.fn(async (input: string) => {
        if (String(input).includes('/v2/archive?')) {
          return {
            ok: true,
            json: async () => ({ status: 'ok', items: [{ classification: 'telegram.earthquake', date: '2026-08-10', url }] }),
          } as unknown as Response
        }
        if (String(input).includes('/v2/telegram?')) {
          return { ok: true, json: async () => ({ status: 'ok', items: [] }) } as unknown as Response
        }
        return { ok: false, status: 500 } as unknown as Response
      }) as unknown as typeof fetch

      await fetchDmdataQuakeHistory('key', new Date('2026-08-10T23:00:00+09:00'), 50, 7, false)
      clearReplayCache()
      const second = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T23:00:00+09:00'), 50, 7, false)

      // 窓が立っていないので、2 回目も取りに行って失敗する
      expect(second.failedArchiveUrls).toContain(url)
      expect(second.rateLimitedSources).toEqual([])
    })
  })

  // 打ち切りは正常系（`StrictMode` の二重実行・時間軸の切り替え・画面を離れた）。
  // 「読んだが 0 件」と同じ文面にすると、記録が「静かな期間だった」と主張してしまう。
  describe('打ち切ったことは「0 件」と言い分ける', () => {
    // このファイルは logger を差し替えていないので、テストごとに spy を張る
    // （`afterEach` の `vi.restoreAllMocks()` が外す）。
    const captured: { warn: string[]; info: string[] } = { warn: [], info: [] }
    const warnings = () => captured.warn
    const infos = () => captured.info

    beforeEach(() => {
      captured.warn = []
      captured.info = []
      vi.spyOn(log, 'warn').mockImplementation((...a: unknown[]) => { captured.warn.push(a.join(' ')) })
      vi.spyOn(log, 'info').mockImplementation((...a: unknown[]) => { captured.info.push(a.join(' ')) })
    })

    it('正: 読み始める前に打ち切られたら、打ち切りとして記録する', async () => {
      const gz = await dayArchive([
        { id: 'aaaaaaa1', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00' },
      ])
      globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

      const result = await fetchDmdataQuakeHistory(
        'key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false, undefined, () => true,
      )

      expect(result.quakes).toHaveLength(0)
      expect(result.hasMore).toBe(false)
      expect(infos().filter(m => m.includes('打ち切った'))).toHaveLength(1)
      // 「0 件」の警告と「復元」の報告はどちらも出さない
      expect(warnings().filter(m => m.includes('地震電文は 0 件'))).toHaveLength(0)
      expect(infos().filter(m => m.includes('履歴を復元'))).toHaveLength(0)
    })

    it('対照: 打ち切っていない 0 件は従来どおり警告として残す', async () => {
      const gz = await dayArchive([])
      globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

      const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

      expect(result.quakes).toHaveLength(0)
      expect(warnings().filter(m => m.includes('地震電文は 0 件'))).toHaveLength(1)
      expect(infos().filter(m => m.includes('打ち切った'))).toHaveLength(0)
    })
  })

  // 打ち切りが無いと、地震の少ない期間で上限日数ぶんを常に読みに行くことになる。
  it('目標件数に達したら、それより古い日は読み込まない', async () => {
    const newer = await dayArchive([
      { id: 'aaaaaaa1', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00' },
      { id: 'bbbbbbb2', eventId: '20260810020000', time: '2026-08-10T02:05:00+09:00' },
    ])
    const older = await dayArchive([
      { id: 'ccccccc3', eventId: '20260809010000', time: '2026-08-09T01:05:00+09:00' },
    ])
    globalThis.fetch = mockHistoryArchives([
      // リストの並びは新しい順とは限らないので、古い側を先に置いて並べ替えを確かめる
      { date: '2026-08-09', url: 'https://x/d09', gz: older },
      { date: '2026-08-10', url: 'https://x/d10', gz: newer },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 2, 7, false)

    // 新しい日だけで 2 件に達するので、古い日の電文は入らない
    expect(result.quakes).toHaveLength(2)
    expect(result.quakes.every(q => q.id.includes('202608100'))).toBe(true)
  })

  /**
   * 地震回数に関する情報（VXSE60）の電文本体。
   *
   * 中身は最小限（区間 1 つ）。ここで見たいのは「拾うかどうか」だけで、読み取りそのものは
   * `dmdataParser.test.ts` が実電文の形で固定している。
   */
  function countBody(eventId: string, reportTime: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>地震回数に関する情報</Title><Status>通常</Status><EditorialOffice>気象庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>地震回数に関する情報</Title>
<ReportDateTime>${reportTime}</ReportDateTime>
<TargetDateTime>${reportTime}</TargetDateTime>
<EventID>${eventId}</EventID>
<InfoType>発表</InfoType>
<Serial>1</Serial>
</Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
<EarthquakeCount>
<Item type="累積地震回数"><StartTime>${reportTime}</StartTime><EndTime>${reportTime}</EndTime><Number>12</Number><FeltNumber>3</FeltNumber></Item>
</EarthquakeCount>
</Body>
</Report>`
  }

  /** 地震と地震回数を混ぜた 1 日ぶんのアーカイブ。 */
  async function dayArchiveWithCount(
    quakes: Array<{ id: string; eventId: string; time: string }>,
    counts: Array<{ id: string; eventId: string; time: string }>,
  ) {
    return makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          ...quakes.map(t => manifestEntry(t.id, 'VXSE53', t.time)),
          ...counts.map(t => manifestEntry(t.id, 'VXSE60', t.time)),
        ]),
      },
      ...quakes.map(t => ({ name: `${t.id}_20260810120500000_0.xml`, content: historyBody(t.eventId, t.time) })),
      ...counts.map(t => ({ name: `${t.id}_20260810120500000_0.xml`, content: countBody(t.eventId, t.time) })),
    ])
  }

  // 7 日間表示され続ける帯（と地震ごとに紐づく長周期）は、初期状態の 24 時間では足りない。
  // **地震の打ち切りに巻き込まれると、群発の最中ほど復元できなくなる**（地震が多い日ほど
  // 早く目標件数に達するため）。
  it('地震が目標件数に達した後の古い日からも、帯は拾う', async () => {
    const newer = await dayArchiveWithCount(
      [
        { id: 'aaaaaaa1', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00' },
        { id: 'bbbbbbb2', eventId: '20260810020000', time: '2026-08-10T02:05:00+09:00' },
      ],
      [],
    )
    const older = await dayArchiveWithCount(
      [{ id: 'ccccccc3', eventId: '20260809010000', time: '2026-08-09T01:05:00+09:00' }],
      [{ id: 'ddddddd4', eventId: '20260809000000', time: '2026-08-09T02:05:00+09:00' }],
    )
    globalThis.fetch = mockHistoryArchives([
      { date: '2026-08-10', url: 'https://x/d10', gz: newer },
      { date: '2026-08-09', url: 'https://x/d09', gz: older },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 2, 7, false)

    // 地震は新しい日の 2 件で打ち切られるが、帯は古い日からも拾う
    expect(result.quakes).toHaveLength(2)
    expect(result.extras).toHaveLength(1)
    expect(result.extras[0].payload.kind).toBe('earthquakeCount')
    expect(result.extras[0].silent).toBe(true)
  })

  // 帯は画面に 1 つしか出ない。古い報まで流すと、初期状態が入れた新しい値を上書きしうる。
  it('同じ種別の帯は最新 1 通だけを返す', async () => {
    const day = await dayArchiveWithCount(
      [],
      [
        { id: 'aaaaaaa1', eventId: '20260810000000', time: '2026-08-10T01:05:00+09:00' },
        { id: 'bbbbbbb2', eventId: '20260810000000', time: '2026-08-10T03:05:00+09:00' },
      ],
    )
    globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz: day }]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    expect(result.extras).toHaveLength(1)
    expect(result.extras[0].replayTime.toISOString()).toBe(new Date('2026-08-10T03:05:00+09:00').toISOString())
  })

  // 続報を別イベントとして数えると、同じ地震が続いた日で打ち切りが早まりカードが増えない。
  it('同じ地震の続報は 1 件として数える', async () => {
    const day = await dayArchive([
      { id: 'aaaaaaa1', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00', serial: '1' },
      { id: 'bbbbbbb2', eventId: '20260810010000', time: '2026-08-10T01:07:00+09:00', serial: '2' },
    ])
    const older = await dayArchive([
      { id: 'ccccccc3', eventId: '20260809010000', time: '2026-08-09T01:05:00+09:00' },
    ])
    globalThis.fetch = mockHistoryArchives([
      { date: '2026-08-10', url: 'https://x/d10', gz: day },
      { date: '2026-08-09', url: 'https://x/d09', gz: older },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 2, 7, false)

    // 当日は続報 2 通＝イベント 1 件。目標 2 件に届かないので前日も読む
    expect(result.quakes).toHaveLength(3)
  })

  it('一部のアーカイブが読めなくても、残りから履歴を作る', async () => {
    const good = await dayArchive([
      { id: 'aaaaaaa1', eventId: '20260809010000', time: '2026-08-09T01:05:00+09:00' },
    ])
    globalThis.fetch = mockHistoryArchives([
      { date: '2026-08-10', url: 'https://x/d10', gz: 'error' },
      { date: '2026-08-09', url: 'https://x/d09', gz: good },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    expect(result.quakes).toHaveLength(1)
    expect(result.failedArchiveUrls).toEqual(['https://x/d10'])
  })

  // 全滅は共通原因（認証切れ・全断）のことがほとんど。握り潰すと「履歴 0 件の成功」に化ける。
  // アーカイブと当日経路は同じ APIキー・同じホストを叩くため、共通原因なら両方倒れる。
  it('読もうとした取得元が全滅したら例外にする', async () => {
    globalThis.fetch = mockHistoryArchives([
      { date: '2026-08-10', url: 'https://x/d10', gz: 'error' },
      { date: '2026-08-09', url: 'https://x/d09', gz: 'error' },
    ], 'error') as unknown as typeof fetch

    await expect(fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false))
      .rejects.toThrow(/すべてを読み取れませんでした/)
  })

  // 当日経路だけがこけたときにアーカイブ側の成果まで捨てると、当日の一覧 API が一度
  // 失敗しただけで過去数日ぶんのカードが消える。
  it('当日経路が読めなくても、アーカイブから読めた分は残す', async () => {
    const good = await dayArchive([
      { id: 'aaaaaaa1', eventId: '20260809010000', time: '2026-08-09T01:05:00+09:00' },
    ])
    globalThis.fetch = mockHistoryArchives([
      { date: '2026-08-09', url: 'https://x/d09', gz: good },
    ], 'error') as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    expect(result.quakes).toHaveLength(1)
    // 読めなかった日は取得元の識別子として数える（無言で消すと「静かな期間」と区別が付かない）
    expect(result.failedArchiveUrls).toContain('live:2026-08-10')
  })

  // 通信前に弾く判定は `listArchives` 経由で本編の取得と共有しているが、共有をやめた
  // ときに気づけるよう履歴側にも置く（キーが不正なまま外へ投げない、が守るべき性質）。
  it('APIキーに使えない文字が含まれていたら通信せずに失敗する', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('通信してはいけない') })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(fetchDmdataQuakeHistory('abc123あ', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false))
      .rejects.toThrow(DmdataApiKeyError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('filterPreWindowEvents の津波', () => {
  // 有効期限は報ではなく津波に付く事実として扱う（詳細は utils/tsunami の latestValidDateTime）。
  // ここで再現するのは 2024 年能登半島地震の実電文の並び:
  //   01/02 10:00 VTSE41  期限「01/02 17:00 まで」を伝える唯一の報
  //   01/02 10:03 VTSE51  期限を持たない最後の報（以降、解除電文は出ない）
  function tsunamiEntry(
    time: string,
    opts: { eventId?: string; validDateTime?: string; cancelled?: boolean } = {},
  ): ReplayEntry {
    const tsunami: JMATsunami = {
      kind: 'tsunami',
      id: `dmdata-tsunami-${opts.eventId ?? 'E1'}-${time}`,
      eventId: opts.eventId ?? 'E1',
      time,
      cancelled: !!opts.cancelled,
      cancelReason: opts.cancelled ? 'lifted' : undefined,
      validDateTime: opts.validDateTime,
      issue: { source: '気象庁', time, type: 'Focus' },
      areas: opts.cancelled
        ? []
        : [{ grade: 'Forecast', immediate: false, name: '石川県能登', code: '360' }],
    }
    return { replayTime: new Date(time), payload: { kind: 'event', event: tsunami } }
  }

  function keptTsunamis(entries: ReplayEntry[], target: string): JMATsunami[] {
    return filterPreWindowEvents(entries, new Date(target))
      .map(e => (e.payload.kind === 'event' ? e.payload.event : null))
      .filter((ev): ev is JMATsunami => ev?.kind === 'tsunami')
  }

  const notoEntries = [
    tsunamiEntry('2024-01-02T10:00:00+09:00', { validDateTime: '2024-01-02T17:00:00+09:00' }),
    tsunamiEntry('2024-01-02T10:03:00+09:00'),
  ]

  it('期限を過ぎた時刻を開始点にしたら、期限を持たない最後の報も残さない', () => {
    expect(keptTsunamis(notoEntries, '2024-01-02T17:30:00+09:00')).toEqual([])
  })

  it('期限より前を開始点にしたら残し、期限を持たない報にも期限を補う', () => {
    const kept = keptTsunamis(notoEntries, '2024-01-02T16:50:00+09:00')
    expect(kept.map(t => t.time)).toEqual([
      '2024-01-02T10:00:00+09:00',
      '2024-01-02T10:03:00+09:00',
    ])
    // 補わないと最後の報で失効の予約が積まれず、期限を過ぎても消えない
    expect(kept[1].validDateTime).toBe('2024-01-02T17:00:00+09:00')
  })

  it('期限を伝えた報が 1 通も無ければ残す（standard 版・期限がまだ決まっていない段階）', () => {
    const entries = [tsunamiEntry('2024-01-01T16:12:00+09:00'), tsunamiEntry('2024-01-01T16:22:00+09:00')]
    expect(keptTsunamis(entries, '2024-01-01T18:00:00+09:00')).toHaveLength(2)
  })

  it('解除電文がある津波は発表報ごと残さない（解除済みの津波を復活させない）', () => {
    const entries = [
      tsunamiEntry('2024-08-08T20:00:00+09:00'),
      tsunamiEntry('2024-08-08T22:00:00+09:00', { cancelled: true }),
    ]
    expect(keptTsunamis(entries, '2024-08-09T02:00:00+09:00')).toEqual([])
  })

  // P2PQuake（standard 版）の 552 は eventId を持たず id も報ごとに変わるため、報 1 通ずつが
  // 別グループになる。この経路で解除の足切りを時刻だけで行うと、同じ 24 時間に無関係な津波が
  // 2 つあったとき、解除された側の時刻でまだ発表中の側まで消える。解除報ごと全部を流し、照合は
  // `isCancelForCurrentTsunami` に委ねる。
  it('eventId が無い経路では解除報も含めて全報を通す（無関係な津波を巻き込まない）', () => {
    const unkeyed = (time: string, cancelled?: boolean): ReplayEntry => {
      const entry = tsunamiEntry(time, { cancelled })
      const tsunami = entry.payload.kind === 'event' ? (entry.payload.event as JMATsunami) : null
      return { ...entry, payload: { kind: 'event', event: { ...tsunami!, eventId: undefined } } }
    }
    const entries = [
      unkeyed('2024-08-08T20:00:00+09:00'),
      unkeyed('2024-08-08T22:00:00+09:00', true),
      unkeyed('2024-08-08T23:00:00+09:00'),
    ]
    const kept = keptTsunamis(entries, '2024-08-09T02:00:00+09:00')
    expect(kept.map(t => `${t.time} cancelled=${t.cancelled}`)).toEqual([
      '2024-08-08T20:00:00+09:00 cancelled=false',
      '2024-08-08T22:00:00+09:00 cancelled=true',
      '2024-08-08T23:00:00+09:00 cancelled=false',
    ])
  })

  // 期限の判定は識別子の有無で分けない（識別子が無ければ報 1 通ずつが 1 グループになり、その報
  // 自身の期限で判定される＝報単位で見ていた従来と同じ）。
  it('eventId が無い報でも、その報自身の期限が過ぎていれば載せない', () => {
    const entry = tsunamiEntry('2024-01-02T10:00:00+09:00', { validDateTime: '2024-01-02T17:00:00+09:00' })
    const tsunami = entry.payload.kind === 'event' ? (entry.payload.event as JMATsunami) : null
    const unkeyed = { ...entry, payload: { kind: 'event' as const, event: { ...tsunami!, eventId: undefined } } }
    expect(keptTsunamis([unkeyed], '2024-01-02T17:30:00+09:00')).toEqual([])
  })

  it('別イベントの津波は互いに影響しない（一方が失効しても他方は残る）', () => {
    const entries = [
      tsunamiEntry('2024-01-02T10:00:00+09:00', { eventId: 'E1', validDateTime: '2024-01-02T17:00:00+09:00' }),
      tsunamiEntry('2024-01-02T18:00:00+09:00', { eventId: 'E2' }),
    ]
    const kept = keptTsunamis(entries, '2024-01-02T19:00:00+09:00')
    expect(kept.map(t => t.eventId)).toEqual(['E2'])
  })
})

// EEW の最終報は「開始時刻の時点で自動解除済みか」で載せるかを決める（`calcEEWCancelTime`）。
// 判定に使う 2 つの時刻（発表時刻・震源時刻）が読めないと Invalid Date になり、**Invalid Date
// との比較はどちらの向きでも偽**なので、書き分けないと判定そのものが黙って無効化される。
describe('filterPreWindowEvents の EEW（解除時刻を決められないとき）', () => {
  function eewEntry(
    time: string,
    opts: { originTime?: string; eventId?: string } = {},
  ): ReplayEntry {
    const eventId = opts.eventId ?? 'EEW1'
    const eew: EEWAlert = {
      kind: 'eew',
      id: `dmdata-eew-${eventId}-1`,
      time,
      test: false,
      earthquake: {
        originTime: opts.originTime ?? time,
        arrivalTime: opts.originTime ?? time,
        condition: '',
        hypocenter: { name: 'テスト震源', latitude: 35, longitude: 135, depth: 10, magnitude: 5.0 },
      },
      severity: 'Forecast',
      cancelled: false,
      isFinal: true,
      issue: { eventId, serial: '1', time },
    }
    return { replayTime: new Date(time || '2026-01-01T12:00:00+09:00'), payload: { kind: 'event', event: eew } }
  }

  const keptEews = (entries: ReplayEntry[], target: string): EEWAlert[] =>
    filterPreWindowEvents(entries, new Date(target))
      .map(e => (e.payload.kind === 'event' ? e.payload.event : null))
      .filter((ev): ev is EEWAlert => ev?.kind === 'eew')

  // 対照: 両方の時刻が読める最終報は、解除時刻を過ぎていれば載せない（従来どおり）。
  it('解除時刻を過ぎた最終報は載せない', () => {
    const entries = [eewEntry('2026-01-01T12:00:00+09:00')]
    expect(keptEews(entries, '2026-01-01T12:30:00+09:00')).toEqual([])
  })

  // 安全弁: 発表時刻が読めなくても、震源時刻が読めれば判定は効く。**無条件に有効側へ倒さない。**
  it('発表時刻が読めなくても震源時刻で判定し、過ぎていれば載せない', () => {
    const entries = [eewEntry('', { originTime: '2026-01-01T12:00:00+09:00' })]
    expect(keptEews(entries, '2026-01-01T12:30:00+09:00')).toEqual([])
  })

  // 正: どちらも読めなければ判定できないので、有効として残す（再現する電文を落とさない）。
  //
  // **倒したことを記録する。** 残す挙動自体は書き分けなくても同じ結果になる（Invalid Date との
  // 比較が偽へ倒れるため）ので、この判定が意図したものだと分かるのは記録があるときだけ。
  it('発表時刻も震源時刻も読めなければ、記録を残したうえで有効として残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const entries = [eewEntry('', { originTime: '' })]
      expect(keptEews(entries, '2026-01-01T12:30:00+09:00')).toHaveLength(1)
      expect(warn.mock.calls.filter(c => String(c[0]).includes('失効を判定できない'))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  // 対照: 判定できた側では記録を出さない（正常系で鳴らすと記録の価値が下がる）。
  it('時刻が読める最終報では記録を出さない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      keptEews([eewEntry('2026-01-01T12:00:00+09:00')], '2026-01-01T12:30:00+09:00')
      expect(warn.mock.calls.filter(c => String(c[0]).includes('失効を判定できない'))).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })
})

// `MAX_HISTORY_DAYS` は `MAX_ENUMERATED_DAYS` から 1 日引いただけの値で、引き算そのものが
// 正しいかは型でも実行でも確かめられない。**1 日ずれても症状は「8 回目に押したときだけ
// 例外」**で、通常の検証には現れないため、ここで境界を固定する。
//
// `fetchDmdataQuakeHistory` が当日経路へ列挙させる範囲は `[before - maxDays, before + 1ms)`。
describe('遡れる日数の上限（MAX_HISTORY_DAYS）', () => {
  const before = new Date('2026-09-15T03:00:00Z')
  const rangeFor = (maxDays: number) => {
    const from = new Date(before)
    from.setDate(from.getDate() - maxDays)
    return [from, new Date(before.getTime() + 1)] as const
  }

  it('正: 上限ちょうどの日数なら列挙できる', () => {
    const [from, to] = rangeFor(MAX_HISTORY_DAYS)
    expect(enumerateJstDates(from, to)).toHaveLength(MAX_ENUMERATED_DAYS)
  })

  it('対照: 1 日でも超えると投げる', () => {
    const [from, to] = rangeFor(MAX_HISTORY_DAYS + 1)
    expect(() => enumerateJstDates(from, to)).toThrow(/対象期間が広すぎます/)
  })
})
