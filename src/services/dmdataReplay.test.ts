// DMDATA archive リプレイ取得の耐障害性テスト。
//
// 重点は「一部が壊れていても、壊れていない分は取り込めること」。
// 従来は電文 1 通の破損で Promise.all ごと reject し、その日を含む期間の再生が
// 丸ごと不可能になっていた。また目録（telegrams.json）が無いアーカイブは無言で
// 捨てられ、「電文 0 件だが成功」に化けて原因が追えなかった。
//
// **このファイルは IndexedDB を用意しない（`fake-indexeddb` を入れない）。** ここが測るのは
// 「本体を落とすかどうかの判定」（`planNeedsBody` と窓の絞り込み）で、その物差しは
// `fetch` の呼び出し回数。**端末の控えを挟むと 2 回目が必ず 0 回になり、判定そのものを
// 測れなくなる。** 端末の控えを通した結線は `archivePersistWiring.test.ts` が見る。
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import {
  fetchDmdataReplayEvents, fetchDmdataQuakeHistory, clearReplayCache, clearArchiveCacheForTest,
  clearParseCachesForTest, filterPreWindowEvents, isArchiveCacheable, HISTORY_WINDOW_DAYS,
} from './dmdataReplay'
import { clearArchiveBodyDb } from '../utils/archiveBodyDb'

/**
 * 控えを全部空にする。
 *
 * **本番の経路（`clearReplayCache()`）はアーカイブ本体もパース結果も捨てない** —— どちらも
 * 内容に対して不変な鍵で引くため。テストは同じ URL・同じ id に違う中身を載せて使い回すので、
 * ここで明示的に空にする。
 */
async function clearAllCaches(): Promise<void> {
  clearReplayCache()
  clearArchiveCacheForTest()
  clearParseCachesForTest()
  // **端末の控え（IndexedDB）も空にする。** ここを落とすと、メモリ層だけ空にしても
  // 端末層が本体を返すので「取り直すはず」のテストが取り直さない —— 控えが二層に
  // なった以上、**片方だけ空にするのは「控えを空にした」ことにならない**。
  await clearArchiveBodyDb()
}
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
// **アーカイブ本体の取得も門（`services/dmdataRequestGates.ts`）を通る**ので、本番の 6 秒間隔のままでは
// 1 件取るだけで既定のタイムアウト（5 秒）を超える。**門が効いているかは
// `utils/requestGate.test.ts` が本物の間隔で確かめている**ので、ここでは 0 にして経路だけを見る。
//
// **トップレベルに置くのは、`describe` 内の `beforeEach` が兄弟の `describe` に届かないため。**
// 待ち行列の持ち越しも切る（前のテストが残した待ちが次へ影響しないように）。
beforeEach(async () => {
  // **端末の控えも空にする。** 残すとテスト間で同じ URL の中身を引き継ぐ
  // （このファイルは作り物の URL を使い回すため）。
  await clearArchiveBodyDb()
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

/** テスト用: 日ごとの取りこぼしを合計する（実装が日ごとに持つようになったため）。 */
function skippedTotal(m: ReadonlyMap<string, number>): number {
  return [...m.values()].reduce((a, b) => a + b, 0)
}
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
    // **アーカイブ本体の控えも空にする。** `clearReplayCache()` は**これを捨てない**
    // （開始をまたいで残すのが設計）ので、呼ばないとテスト間で持ち越す。
    // **同じ URL を使うテストが並ぶと、後のテストが前の書き込みを読んでしまい、
    // 「1 回目で控えへ載る」経路を一度も通らない** —— 書き込みが壊れても通り続ける。
    clearArchiveCacheForTest()
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

  // 対照: 控えから読めた分は門を通らない（通信しないので待つ理由がない）。
  // **控えそのものの振る舞い**（書く・読む・当日は控えない・開始をまたいで残る）は
  // `utils/archiveBodyCache.test.ts` とこのファイルの「アーカイブ本体の控え」節が見る。
  // ここで見るのは**門との噛み合わせ**だけ。
  //
  // **測るのは取得回数で、経過時間ではない。** 当初は「間隔を長くしても待たない」形で
  // 書いていたが、`setDataApiGateIntervalForTest` は**門を作り直す**（前回の発火時刻も
  // 消える）ので、控えが効いていなくても待たずに通った —— **控えの書き込みを止めても
  // 通る**ことを検算で確かめた。通信しなければ門も通らないので、「取りに行かない」ことを
  // 見れば足りる。
  it('控えから読めた分は取りに行かない', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: enc.encode(JSON.stringify([manifestEntry('a1', 'VXSE53')])) },
      { name: 'a1.xml', content: enc.encode(quakeBody('石川県能登地方')) },
    ])
    /** 本体を取りに行った回数（目録は数えない）。 */
    let bodyFetches = 0
    const base = mockArchives([
      { url: 'https://data.api.dmdata.jp/v1/archive/d1', gz },
    ])
    globalThis.fetch = (async (input: string) => {
      if (String(input).includes('/v1/archive/')) bodyFetches++
      return base(String(input))
    }) as unknown as typeof fetch

    await fetchDmdataReplayEvents('key', FROM, TO, false)
    const afterFirst = bodyFetches
    expect(afterFirst).toBeGreaterThan(0)

    // **セッション内の展開結果だけ捨てる。** 控えは開始をまたいで残るのが設計なので、
    // 2 回目は本体を取りに行かない（→ `utils/archiveBodyCache.ts`）
    clearReplayCache()
    await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(bodyFetches).toBe(afterFirst)
  })
})

describe('fetchDmdataReplayEvents の耐障害性', () => {
  const originalFetch = globalThis.fetch
  let warns: string[]
  let errors: string[]

  beforeEach(async () => {
    await clearAllCaches()
    warns = []
    errors = []
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await clearAllCaches()
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
      const { entries, skippedByDay } = await fetchDmdataReplayEvents('key', FROM, TO, false)
      expect(entries).toHaveLength(1)
      // 落としたのは「対象外」であって取りこぼしではない
      expect(skippedTotal(skippedByDay)).toBe(0)
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
    expect(skippedTotal(result.skippedByDay)).toBe(3)
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

    const { entries, skippedByDay } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(skippedTotal(skippedByDay)).toBe(0)
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

    const { entries, skippedByDay } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(skippedTotal(skippedByDay)).toBe(0)
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

    const { entries, skippedByDay } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(entries).toHaveLength(0)
    expect(skippedTotal(skippedByDay)).toBe(1)
    expect(warns.join(' ')).toContain('断片が揃いませんでした')
  })

  // 安全弁: 本体が入っていなければ取りこぼしに数える（XML 側と同じ扱い）。
  it('二進電文の本体が無ければ取りこぼしに数える', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('bin0005', 'IXAC41', BIN_TIME)]) },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries, skippedByDay } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(entries).toHaveLength(0)
    expect(skippedTotal(skippedByDay)).toBe(1)
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

    const { entries, skippedByDay } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(entries).toHaveLength(0)
    expect(skippedTotal(skippedByDay)).toBe(1)
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

    const { entries, skippedByDay } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(entries).toHaveLength(0)
    expect(skippedTotal(skippedByDay)).toBe(1)
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

    const { skippedByDay } = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(skippedTotal(skippedByDay)).toBe(2)
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
    expect(skippedTotal(result.skippedByDay)).toBe(0)
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

  // かつては目録の時刻が読めないだけで落としていた（純粋な損失）。アーカイブ経路は本体が
  // 既に手元にあるので、**追加リクエスト 0 で**ファイル名の受信時刻から救える。
  it('正: 目録の発表時刻が読めなくても、本体のファイル名の受信時刻で救う', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('fffffff6', 'VXSE53', 'not-a-date')]) },
      { name: 'fffffff6_20260810120500000_0.xml', content: quakeBody('日向灘') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(result.entries).toHaveLength(1)
    // 救えたものを取りこぼしに数えない
    expect(skippedTotal(result.skippedByDay)).toBe(0)
    // 補ったことは残す（目録が壊れている事実は消えていない）
    expect(warns.join('\n')).toMatch(/ファイル名から補った/)
  })

  // new Date(null) は Invalid Date ではなく 1970-01-01 を返す。数値チェックだけだと
  // すり抜けて、直後の「範囲外なら continue」に古い電文として無言で吸収される。
  //
  // **この電文には本体が無い**（`nulltime` に対応する .xml/.bin がアーカイブに入っていない）ので、
  // ファイル名からの補いも効かない ＝ 対照として「どちらも読めなければ落とす」を押さえている。
  //
  // **`originalId` は持たせない。** あれは JSON 版の印（値は元の XML エントリの id を指すので、
  // 自分自身の id と同じにはならない）で、持たせると正常な重複排除で落ちてしまい
  // 「時刻が読めないから落ちた」ことを確かめられない。
  it('対照: 発表時刻も受信時刻も読めなければスキップする（1970年に化けさせない）', async () => {
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          { id: 'nulltime', classification: 'telegram.earthquake', head: { type: 'VXSE53', time: null, test: false } },
          manifestEntry('jjjjjjj0'),
        ]),
      },
      { name: 'jjjjjjj0_20260810120500000_0.xml', content: quakeBody('種子島近海') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(result.entries).toHaveLength(1)
    expect(skippedTotal(result.skippedByDay)).toBe(1)
    expect(warns.join('\n')).toMatch(/発表時刻も受信時刻も読めない/)
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

  // リプレイ本編は同じ日を何度も走査する（初期状態 24 時間・本編 1 時間・毎時の先読み）。
  // 走査のたびに数え直すと、**壊れた 1 通が走査した回数だけ増える**。
  //
  // **報告するのは前回からの増分だけ**（→ `reportedReplaySkipCounts`）。「報告済みの日」の
  // 集合で持つと、当日ぶんに後から届いた電文が壊れていても「その日はもう見た」として黙る。
  describe('本編の取りこぼしは前回からの増分だけ報告する', () => {
    /** `head` を持たない（＝取りこぼしとして数える）エントリ n 件と、正常な電文 1 件。 */
    const archiveWith = (broken: number) => makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          ...Array.from({ length: broken }, (_, i) => ({ id: `nohead0${i}`, classification: 'telegram.earthquake' })),
          manifestEntry('5555555m'),
        ]),
      },
      { name: '5555555m_20260810120500000_0.xml', content: quakeBody('紀伊水道') },
    ])

    it('対照: 同じ日を読み直しても二度は数えない', async () => {
      globalThis.fetch = mockArchives([{ url: 'https://x/a', gz: await archiveWith(1) }]) as unknown as typeof fetch

      const first = await fetchDmdataReplayEvents('key', FROM, TO, false)
      const second = await fetchDmdataReplayEvents('key', FROM, TO, false)

      expect(first.skippedByDay).toEqual(new Map([['2026-08-10', 1]]))
      expect(second.skippedByDay).toEqual(new Map())
    })

    // 当日ぶんのアーカイブは控えないので、走査のたびに件数が増えうる。
    // ここでは別 URL の目録を返して同じ形を作る（本体の控えは URL を鍵にするため）。
    it('正: 破損が増えたら、増えた分だけ報告する', async () => {
      globalThis.fetch = mockArchives([{ url: 'https://x/a', gz: await archiveWith(1) }]) as unknown as typeof fetch
      const first = await fetchDmdataReplayEvents('key', FROM, TO, false)
      expect(first.skippedByDay).toEqual(new Map([['2026-08-10', 1]]))

      globalThis.fetch = mockArchives([{ url: 'https://x/b', gz: await archiveWith(3) }]) as unknown as typeof fetch
      const second = await fetchDmdataReplayEvents('key', FROM, TO, false)

      // **増えた 2 件だけ。** 3 件だと最初の 1 通を二度報告することになる
      expect(second.skippedByDay).toEqual(new Map([['2026-08-10', 2]]))
    })

    // **窓が違えば、同じ日でも別の電文が壊れている。**
    //
    // リプレイの開始は本編（`[T, T+1h)`）と初期状態（`[T-24h, T)`）を**並行に**読む
    // （`useReplayController`）。どちらの窓も `T` の日を含むので、その日を 2 回走査する
    // ことになるが、**窓の中でしか判らない破損（本体が無い・パースできない）は
    // 互いに素**——窓は重ならないので、1 通はどちらか片方にしか入らない。
    //
    // 「日ごとの件数」で増分を取ると、この 2 つが同じ日の集計値 1 と 1 になって
    // **後から報告した側が丸ごと消える**。取りこぼしを少なく見せる側の壊れ方で、
    // 画面には「静かな時間帯だった」としか出ない。
    it('正: 窓が違えば、同じ日でも別の破損として数える', async () => {
      // 09:00 の電文は前半の窓だけ、11:00 の電文は後半の窓だけに入る。
      // どちらも本体を置かないので「本体が見つからず」で取りこぼしになる
      const gz = await makeTarGz([
        {
          name: 'telegrams.json',
          content: JSON.stringify([
            manifestEntry('early001', 'VXSE53', '2026-08-10T09:00:00+09:00'),
            manifestEntry('late0001', 'VXSE53', '2026-08-10T11:00:00+09:00'),
          ]),
        },
      ])
      globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

      const mid = new Date('2026-08-10T10:00:00+09:00')
      const [pre, main] = await Promise.all([
        fetchDmdataReplayEvents('key', FROM, mid, false),
        fetchDmdataReplayEvents('key', mid, TO, false),
      ])

      const total = skippedTotal(pre.skippedByDay) + skippedTotal(main.skippedByDay)
      expect(total).toBe(2)
    })

    // 安全弁: 時間軸が変わったら数え直す。別の再生で同じ日を読むのは別の取得。
    it('安全弁: リプレイの開始（clearReplayCache）では数え直す', async () => {
      globalThis.fetch = mockArchives([{ url: 'https://x/a', gz: await archiveWith(1) }]) as unknown as typeof fetch

      const first = await fetchDmdataReplayEvents('key', FROM, TO, false)
      clearReplayCache()
      const second = await fetchDmdataReplayEvents('key', FROM, TO, false)

      expect(first.skippedByDay).toEqual(new Map([['2026-08-10', 1]]))
      expect(second.skippedByDay).toEqual(new Map([['2026-08-10', 1]]))
    })
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

  beforeEach(async () => { await clearAllCaches() })
  afterEach(async () => {
    globalThis.fetch = originalFetch
    await clearAllCaches()
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

  // **`head` を持たない目録エントリは取りこぼしとして数える**（本編の `planReplayEntries` と
  // 同じ扱い）。黙って落とすと、**目録が壊れている日ほど「静かな日」に見える**。
  //
  // 鍵まで見る —— 日を取り違えても合計だけなら通ってしまう。
  it('head を持たない目録エントリを取りこぼしとして数える', async () => {
    const gz = await makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([
          { id: 'nohead01', classification: 'telegram.earthquake' },
          manifestEntry('aaaaaaa1', 'VXSE53', '2026-08-10T09:05:00+09:00'),
        ]),
      },
      {
        name: 'aaaaaaa1_20260810120500000_0.xml',
        content: historyBody('20260810090000', '2026-08-10T09:05:00+09:00'),
      },
    ])
    globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    // 壊れた 1 件を数えつつ、残りは取り込む
    expect(result.quakes).toHaveLength(1)
    expect(result.skippedByDay).toEqual(new Map([['2026-08-10', 1]]))
  })

  // ここから 4 件はカーソル（`oldestLoadedDay`）と在庫判定（`hasMore`）。
  //
  // **この 2 つが噛み合わないと「押しても増えないボタン」か「読み残したまま死ぬボタン」に
  // なる。** どちらも取得は成功しているので、画面には何の警告も出ない。
  //
  // 直近の日（`LIVE_FALLBACK_DAYS` ぶん）まで目録で埋めておく。埋めないとその日は当日経路の
  // 担当になり、**当日経路で読み切った日のほうが古くなる**ので、カーソルが目録の最古の日には
  // ならない（当日経路の日も読み切っている以上、カーソルに入るのは正しい）。
  it('正: 読み切った最古の日をカーソルとして返す', async () => {
    const gz8 = await dayArchive([{ id: 'ccccccc3', eventId: '20260808010000', time: '2026-08-08T01:05:00+09:00' }])
    const gz9 = await dayArchive([{ id: 'aaaaaaa1', eventId: '20260809010000', time: '2026-08-09T01:05:00+09:00' }])
    const gz10 = await dayArchive([{ id: 'bbbbbbb2', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00' }])
    globalThis.fetch = mockHistoryArchives([
      { date: '2026-08-08', url: 'https://x/d08', gz: gz8 },
      { date: '2026-08-09', url: 'https://x/d09', gz: gz9 },
      { date: '2026-08-10', url: 'https://x/d10', gz: gz10 },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    expect(result.oldestLoadedDay).toBe('2026-08-08')
    expect(result.hasMore).toBe(true)
  })

  // **安全弁に達した日は読んでいない**（打ち切りの判定は日の頭で見る）。その日をカーソルに
  // 含めると、次の窓がそこより古い範囲から始まり、読み残した日の地震が二度と出ない。
  //
  // 実運用では窓（7 日）を丸ごと読み切るのでここへは達しない。効くのは群発の最中だけ
  // （→ `HISTORY_EVENT_SAFETY_CAP`）。ここでは上限 1 件にして同じ経路を通す。
  it('対照: 件数の安全弁で読まなかった日はカーソルに含めない', async () => {
    const gz9 = await dayArchive([{ id: 'aaaaaaa1', eventId: '20260809010000', time: '2026-08-09T01:05:00+09:00' }])
    const gz10 = await dayArchive([{ id: 'bbbbbbb2', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00' }])
    globalThis.fetch = mockHistoryArchives([
      { date: '2026-08-09', url: 'https://x/d09', gz: gz9 },
      { date: '2026-08-10', url: 'https://x/d10', gz: gz10 },
    ]) as unknown as typeof fetch

    // 上限 1 件 → 新しい日（08-10）で達し、08-09 は地震を取り込まない
    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 1, 7, false)

    expect(result.oldestLoadedDay).toBe('2026-08-10')
    // 読み残した日があるので、まだ押せる
    expect(result.hasMore).toBe(true)
  })

  // **カーソルは取得に失敗した日を跨いではいけない。**
  //
  // 窓は重ならないので、跨ぐとその日は二度と要求されない。とくに 429 は「窓が明けるまで
  // 待てば取れる」ものなので、跨ぐと設計意図ごと失われる。
  it('安全弁: 取得に失敗した日でカーソルを止める', async () => {
    const gz8 = await dayArchive([{ id: 'ccccccc3', eventId: '20260808010000', time: '2026-08-08T01:05:00+09:00' }])
    const gz10 = await dayArchive([{ id: 'bbbbbbb2', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00' }])
    globalThis.fetch = mockHistoryArchives([
      { date: '2026-08-08', url: 'https://x/d08', gz: gz8 },
      { date: '2026-08-09', url: 'https://x/d09', gz: 'error' },
      { date: '2026-08-10', url: 'https://x/d10', gz: gz10 },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    // 08-09 で止まる。**08-08 まで進めてはいけない**（読めてはいるが、その手前に穴がある）
    expect(result.oldestLoadedDay).toBe('2026-08-10')
    expect(result.failedArchiveUrls).toContain('https://x/d09')
    // 失敗しても、読めた日のカードは捨てない
    expect(result.quakes).toHaveLength(2)
    // まだ在庫はあるので押せる（押し直せば 08-09 から読み直す）
    expect(result.hasMore).toBe(true)
  })

  // **カーソルは「どの担当にもならなかった日」も跨いではいけない。**
  //
  // アーカイブの目録にも当日経路の範囲（`LIVE_FALLBACK_DAYS`）にも当たらない日は `sources` に
  // 現れない。`sources` を素直に辿るだけだと、配列に無い日は `break` の対象にすらならず
  // **素通りしてさらに古い日までカーソルが進む** —— 窓は重ならないので、その日は二度と
  // 要求されない。記録（`log.warn`）は残るが画面には何も出ないので、静かに欠ける。
  it('安全弁: どの担当にもならなかった日でカーソルを止める', async () => {
    const gz10 = await dayArchive([{ id: 'bbbbbbb2', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00' }])
    const gz6 = await dayArchive([{ id: 'ccccccc3', eventId: '20260806010000', time: '2026-08-06T01:05:00+09:00' }])
    // 08-07 は目録に無く、当日経路の範囲（上端から 2 日）からも外れる＝どの担当にもならない
    globalThis.fetch = mockHistoryArchives([
      { date: '2026-08-10', url: 'https://x/d10', gz: gz10 },
      { date: '2026-08-06', url: 'https://x/d06', gz: gz6 },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    // 当日経路が埋める 08-09・08-08 までで止まる。**08-06 まで進めてはいけない**
    expect(result.oldestLoadedDay).toBe('2026-08-08')
    // 読めた日のカードは捨てない
    expect(result.quakes.length).toBeGreaterThan(0)
    expect(result.hasMore).toBe(true)
  })

  // **止まった状態は画面に出す。** 欠落が解消しない限りカーソルは進まず、押しても同じ窓を
  // 読み直すだけになる。**それ自体は正しい**（跨げばその日は永久に失われる）が、出さないと
  // 「押しても何も増えないボタン」が理由の分からないまま残る。
  it('対照: 担当外の日は「読めなかった取得元」として画面へ出す', async () => {
    const gz10 = await dayArchive([{ id: 'bbbbbbb2', eventId: '20260810010000', time: '2026-08-10T01:05:00+09:00' }])
    const gz6 = await dayArchive([{ id: 'ccccccc3', eventId: '20260806010000', time: '2026-08-06T01:05:00+09:00' }])
    globalThis.fetch = mockHistoryArchives([
      { date: '2026-08-10', url: 'https://x/d10', gz: gz10 },
      { date: '2026-08-06', url: 'https://x/d06', gz: gz6 },
    ]) as unknown as typeof fetch
    const before = new Date('2026-08-10T12:00:00+09:00')

    const first = await fetchDmdataQuakeHistory('key', before, 50, 7, false)
    expect(first.failedArchiveUrls).toContain('uncovered:2026-08-07')

    // カーソルは欠落日の手前（08-08）で止まる
    expect(first.oldestLoadedDay).toBe('2026-08-08')

    // **押し直せば前へ進む。恒久的には詰まらない。** 次の窓の上端は欠落日そのものになり、
    // 当日経路が担当するのは上端から `LIVE_FALLBACK_DAYS`（2 日）ぶんなので、
    // **前の窓で担当外だった日が次の窓では担当内に入る**。欠落が何日続いても
    // 1 回につき 2 日ずつは前へ進む
    const second = await fetchDmdataQuakeHistory(
      'key', new Date(new Date('2026-08-08T00:00:00+09:00').getTime() - 1), 50, 7, false,
    )
    expect(second.oldestLoadedDay).not.toBe(null)
    expect(second.oldestLoadedDay! < '2026-08-08').toBe(true)
    expect(second.hasMore).toBe(true)
  })

  // 止まってよい理由は「窓が保存開始（2020-11-18）より古い」ことだけ。
  //
  // **「目録が空だから在庫の端」と決めつけないこと。** 一時的な障害や生成の遅れでも目録は
  // 空になる。そこで打ち切ると、**読めるはずの期間を「もう無い」として閉じてしまう**
  // （窓は重ならないので、閉じた先は押し直しても戻らない）。
  //
  // かつては「目録が空なら押せなくする」で、当日経路の日を在庫と数えない対照としていた。
  // 数えないことは今も正しいが、**押せなくする理由にはしない**。
  it('目録が空でも、窓が在庫の範囲に掛かるうちは押せる', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    globalThis.fetch = mockHistoryArchives([]) as unknown as typeof fetch

    const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T12:00:00+09:00'), 50, 7, false)

    expect(result.hasMore).toBe(true)
    // 読めなかった日は黙って消さない（三層の記録のどれにも載らない日なので、ここが唯一の痕跡）
    expect(warn.mock.calls.flat().join(' ')).toMatch(/アーカイブにも当日経路にも当たらない日/)
  })

  // 対照: 在庫の端より古い窓まで来たら止める。
  it('対照: 窓が保存開始より古くなったら押せなくする', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    globalThis.fetch = mockHistoryArchives([]) as unknown as typeof fetch

    // 窓 7 日 → 2020-11-04〜11-10。どの日も保存開始（2020-11-18）より古い
    const result = await fetchDmdataQuakeHistory('key', new Date('2020-11-10T12:00:00+09:00'), 50, 7, false)

    expect(result.hasMore).toBe(false)
    // 在庫の外なので、読めなかったことを鳴らさない（遡り切るたびに警告が出ても困る）
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/アーカイブにも当日経路にも当たらない日/)
  })

  // `mergeQuakeHistory` は安定ソートで畳み込むため、**発表時刻が同値の電文どうしは入力配列の
  // 相対順序がそのまま結果に効く**。目録の並びも日の処理順（新しい日から）も、この並びを
  // 保証しない。
  //
  // **完全版 ⇄ 速報段階の逆転は、並べ直さなくても統合側が防ぐ**（`utils/quakeMerge.ts` の
  // `isSupersededByExistingCard`）。ここで揃えるのは**同じ段階どうしの並び**のため —— 同じ分に
  // 震度速報が複数あれば、後に置いた方が勝つ。
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

  // 全日ぶんの解析を待ってから流すと、そのあいだカードが空のままになる。1 日読み終えるたびに流す。
  describe('取れた日から順に反映する', () => {
    // 正: 2 日ぶんのうち 1 日目を解析し終えた時点で、その 1 件だけが流れる。
    //
    // **見るのは「流れた時点で解析が終わっている日数」**。かつては「何件目の本体を
    // 落としている時点か」で測っていたが、**本体はループへ入る前にまとめて投げる形へ
    // 変えた**ので（→ `prefetchedBodies`）、ダウンロード数では測れなくなった。
    // 揃えてから流す形なら 1 回目で 2 件とも来るので、この形でも見分けは付く。
    it('全日ぶんの解析を待たずに、読み終えた日から流す', async () => {
      const day = async (eventId: string, time: string) => makeTarGz([
        { name: 'telegrams.json', content: enc.encode(JSON.stringify([manifestEntry('h1', 'VXSE53')])) },
        { name: 'h1.xml', content: enc.encode(historyBody(eventId, time)) },
      ])
      /** `onPartial` が呼ばれたときの件数。 */
      const partialCounts: number[] = []
      globalThis.fetch = mockHistoryArchives([
        { date: '2026-08-09', url: 'https://x/d09', gz: await day('20260809010000', '2026-08-09T01:05:00+09:00') },
        { date: '2026-08-10', url: 'https://x/d10', gz: await day('20260810120000', '2026-08-10T12:06:00+09:00') },
      ]) as unknown as typeof fetch

      await fetchDmdataQuakeHistory(
        'key', new Date('2026-08-10T23:00:00+09:00'), 50, 7, false,
        (quakes) => { partialCounts.push(quakes.length) },
      )

      // **1 回目が 1 件**であること（揃えてから流す形だと 1 回目から 2 件になる）。
      // 呼び出し回数そのものは見ない —— アーカイブが無い日は当日経路を通り、そちらも流すため。
      expect(partialCounts[0]).toBe(1)
      expect(partialCounts[partialCounts.length - 1]).toBe(2)
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

    beforeEach(async () => {
      // **控えを空にする（メモリと端末の両方）。** この describe は同じ URL に違う中身を
      // 載せた 2 つのテストを並べているので、残すと 2 件目が 1 件目の中身を引く。
      await clearAllCaches()
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

    // **上のテストと URL を分ける。**
    //
    // 上のテストは `shouldStop` が最初から真なので、実際には**本体を 1 件も投げない**
    // （`prefetchedBodies` の構築ループが最初の反復で `break` する）。ここで URL を
    // 分けているのは保険で、**打ち切りが途中から真になる形**（`StrictMode` の二重実行など）
    // では投げた分が控えへ載り、しかもそれが**このテストが始まったあと**に届きうるため。
    // `beforeEach` で空にしても間に合わないので、同じ URL に違う中身を載せない形にしておく。
    it('対照: 打ち切っていない 0 件は従来どおり警告として残す', async () => {
      const gz = await dayArchive([])
      globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10-empty', gz }]) as unknown as typeof fetch

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
    expect(result.failedArchiveUrls).toContain('https://x/d10')
    // 目録に無く当日経路の範囲からも外れる日は `uncovered:<日>` として同じ枠に出る
    // （この mock は 2 日ぶんしか目録を返さないので、窓 7 日の残りがそれに当たる）
    expect(result.failedArchiveUrls.filter(u => !u.startsWith('uncovered:'))).toEqual(['https://x/d10'])
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

  // 「もっと見る」は遡る日数を伸ばして呼び直す形なので、押すたびに既に読んだ日の目録と電文も
  // 解析し直していた（上限まで押すと日ごとの解析が累計 311 日ぶん＝実日数 59 日の約 5 倍）。
  //
  // **控えが効いていることは同一参照で確かめる。** 解析し直せば別のオブジェクトになるので、
  // 「同じ中身が返る」では区別が付かない。
  describe('二度目の取得は控えから返す', () => {
    const BEFORE = new Date('2026-08-10T13:00:00+09:00')

    it('正: 日数を伸ばして呼び直しても、同じ日の電文を解析し直さない', async () => {
      const gz = await dayArchive([
        { id: 'ccccccc1', eventId: '20260810030000', time: '2026-08-10T12:05:00+09:00' },
      ])
      globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

      const first = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)
      const second = await fetchDmdataQuakeHistory('key', BEFORE, 100, 14, false)

      expect(first.quakes).toHaveLength(1)
      expect(second.quakes).toHaveLength(1)
      expect(second.quakes[0]).toBe(first.quakes[0])
    })

    // **リプレイの開始（`clearReplayCache()`）では捨てない。** 捨てるのはテスト専用の
    // `clearParseCachesForTest()` だけ（内容に対して不変な鍵で引くため）。
    it('対照: 控えを捨てれば解析し直す', async () => {
      const gz = await dayArchive([
        { id: 'ccccccc2', eventId: '20260810030000', time: '2026-08-10T12:05:00+09:00' },
      ])
      globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

      const first = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)
      await clearAllCaches()
      const second = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)

      expect(second.quakes[0]).not.toBe(first.quakes[0])
      expect(second.quakes[0].id).toBe(first.quakes[0].id)
    })

    // **リプレイの開始で捨ててはいけない。** 鍵は内容に対して不変なので捨てる正当性が無く、
    // 捨てると「同じ日を何度も再生し直す」使い方でそのたびに解析し直す。
    // `clearReplayCache()` へ戻す変更が入ったとき、ここで止まる。
    it('安全弁: リプレイの開始（clearReplayCache）では捨てない', async () => {
      const gz = await dayArchive([
        { id: 'ccccccc3', eventId: '20260810030000', time: '2026-08-10T12:05:00+09:00' },
      ])
      globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

      const first = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)
      clearReplayCache()
      const second = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)

      expect(second.quakes[0]).toBe(first.quakes[0])
    })

    // 控えるのは**実際に解析した分だけ**。打ち切りで読まなかった日の地震は控えに乗らないので、
    // 目標件数を増やした 2 度目にはちゃんと読まれる（控えが打ち切りの意味を変えないこと）。
    it('安全弁: 打ち切りで読まなかった日は、目標を増やせば読める', async () => {
      const newer = await dayArchive([
        { id: 'ddddddd1', eventId: '20260810030000', time: '2026-08-10T12:05:00+09:00' },
      ])
      const older = await dayArchive([
        { id: 'eeeeeee1', eventId: '20260809030000', time: '2026-08-09T12:05:00+09:00' },
      ])
      globalThis.fetch = mockHistoryArchives([
        { date: '2026-08-10', url: 'https://x/d10', gz: newer },
        { date: '2026-08-09', url: 'https://x/d09', gz: older },
      ]) as unknown as typeof fetch

      const first = await fetchDmdataQuakeHistory('key', BEFORE, 1, 7, false)
      expect(first.quakes).toHaveLength(1)

      const second = await fetchDmdataQuakeHistory('key', BEFORE, 2, 7, false)
      expect(second.quakes).toHaveLength(2)
      // 1 度目に読んだ側は控えから返る
      expect(second.quakes.some(q => q === first.quakes[0])).toBe(true)
    })

    // 失敗を控えると、警告も取りこぼしの件数も 1 度目しか出なくなる。実運用では 0 件なので、
    // 解析し直させても費用はかからない。
    it('安全弁: 解析に失敗した電文は控えないので、二度目も取りこぼしに数える', async () => {
      const gz = await makeTarGz([
        {
          name: 'telegrams.json',
          content: JSON.stringify([manifestEntry('fffffff1', 'VXSE53', '2026-08-10T12:05:00+09:00')]),
        },
        { name: 'fffffff1_20260810030500000_0.xml', content: '<Report><これは XML ではない' },
      ])
      globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

      const first = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)
      const second = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)

      expect(skippedTotal(first.skippedByDay)).toBe(1)
      expect(skippedTotal(second.skippedByDay)).toBe(1)
    })
  })

  // アーカイブ本体を「控えが外れた日だけ」落とす。
  //
  // **控えの寿命が揃っていない。** 目録（`manifestCache`）と電文のパース結果
  // （`parsedTelegramCache`）は上限も期限も持たないのに、本体の控え
  // （`utils/archiveBodyCache.ts`）は 96 本・128MB・12 時間で落ちる。そのため
  // 「解析結果は手元にあるのに本体だけ消えた」状態が普通に起き、かつてはそこで
  // 落とし直した本体を 1 バイトも読まずに捨てていた。
  describe('控えで読み切れる日は本体を落とさない', () => {
    const BEFORE = new Date('2026-08-10T13:00:00+09:00')

    /**
     * 本体を取りに行った回数を数える fetch を差す（目録・当日経路は数えない）。
     *
     * **測るのは取得回数で、結果の中身ではない。** 中身は控えから返るので、落とし直しても
     * 画面に出るものは変わらない —— 回数を見なければ無駄なダウンロードに気づけない。
     */
    function countingFetch(archives: Array<{ date: string; url: string; gz: Uint8Array | 'error' }>) {
      const base = mockHistoryArchives(archives)
      const counter = { bodies: 0 }
      globalThis.fetch = (async (input: string) => {
        if (archives.some(a => a.url === String(input))) counter.bodies++
        return base(String(input))
      }) as unknown as typeof fetch
      return counter
    }

    it('正: 本体の控えだけが落ちても、解析結果で読み切れるなら落とし直さない', async () => {
      const gz = await dayArchive([
        { id: 'hhhhhhh1', eventId: '20260810030000', time: '2026-08-10T12:05:00+09:00' },
      ])
      const counter = countingFetch([{ date: '2026-08-10', url: 'https://x/d10', gz }])

      const first = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)
      expect(first.quakes).toHaveLength(1)
      expect(counter.bodies).toBe(1)

      // 期限切れ・追い出しで本体だけが消えた状態（目録とパース結果は残る）
      clearArchiveCacheForTest()
      const second = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)

      expect(counter.bodies).toBe(1)
      // 控えから返っているので同一参照（解析し直せば別のオブジェクトになる）
      expect(second.quakes[0]).toBe(first.quakes[0])
    })

    // 解析に失敗した電文は控えに乗らない（`parsedTelegramCache` は成功分だけ）。
    // 読むものが残っているなら、本体は要る。
    it('対照: 解析結果が控えに無い電文が残っていれば落とし直す', async () => {
      const gz = await makeTarGz([
        {
          name: 'telegrams.json',
          content: JSON.stringify([manifestEntry('hhhhhhh2', 'VXSE53', '2026-08-10T12:05:00+09:00')]),
        },
        { name: 'hhhhhhh2_20260810030500000_0.xml', content: '<Report><これは XML ではない' },
      ])
      const counter = countingFetch([{ date: '2026-08-10', url: 'https://x/d10', gz }])

      const first = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)
      expect(skippedTotal(first.skippedByDay)).toBe(1)
      expect(counter.bodies).toBe(1)

      clearArchiveCacheForTest()
      const second = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)

      expect(counter.bodies).toBe(2)
      expect(skippedTotal(second.skippedByDay)).toBe(1)
    })

    // 目録は本体の中に入っているので、そちらが控えに無ければ落とすしかない。
    it('対照: 目録の控えも落ちていれば落とす', async () => {
      const gz = await dayArchive([
        { id: 'hhhhhhh3', eventId: '20260810030000', time: '2026-08-10T12:05:00+09:00' },
      ])
      const counter = countingFetch([{ date: '2026-08-10', url: 'https://x/d10', gz }])

      await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)
      expect(counter.bodies).toBe(1)

      await clearAllCaches()
      await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)

      expect(counter.bodies).toBe(2)
    })

    // 打ち切り（`takeQuakes`）は計画にも効く。目標に達した時点より古い日は読まないので
    // 本体も要らないが、**目標を増やせば落としに行く**（控えに乗っていないため）。
    it('安全弁: 打ち切りで読まなかった日は、目標を増やせば落としに行く', async () => {
      const newer = await dayArchive([
        { id: 'hhhhhhh4', eventId: '20260810030000', time: '2026-08-10T12:05:00+09:00' },
      ])
      const older = await dayArchive([
        { id: 'hhhhhhh5', eventId: '20260809030000', time: '2026-08-09T12:05:00+09:00' },
      ])
      const counter = countingFetch([
        { date: '2026-08-10', url: 'https://x/d10', gz: newer },
        { date: '2026-08-09', url: 'https://x/d09', gz: older },
      ])

      // 目標 1 件。新しい日で足りるので古い日の地震は読まない（目録のために落ちる）
      const first = await fetchDmdataQuakeHistory('key', BEFORE, 1, 7, false)
      expect(first.quakes).toHaveLength(1)
      const afterFirst = counter.bodies

      clearArchiveCacheForTest()
      const second = await fetchDmdataQuakeHistory('key', BEFORE, 2, 7, false)

      expect(second.quakes).toHaveLength(2)
      // 新しい日は控えで済み、古い日だけを落としに行く
      expect(counter.bodies).toBe(afterFirst + 1)
    })

    // 同じ日に「控え済み」と「未控え」が混じる形。**1 件でも要れば落とす**（`planNeedsBody`）。
    //
    // **これは普通に起きる。** 再生開始時刻より後に発表された電文はその時点で存在しないので
    // 読まないが、時刻が進めば同じ日の中で読む対象に変わる。
    it('正: 同じ日に未控えの電文が 1 件でも残っていれば落とす', async () => {
      const gz = await dayArchive([
        { id: 'hhhhhhh7', eventId: '20260810030000', time: '2026-08-10T12:05:00+09:00' },
        { id: 'hhhhhhh8', eventId: '20260810090000', time: '2026-08-10T18:05:00+09:00' },
      ])
      const counter = countingFetch([{ date: '2026-08-10', url: 'https://x/d10', gz }])

      // 13:00 時点では 18:05 の電文はまだ存在しないので読まない（控えにも乗らない）
      const first = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)
      expect(first.quakes).toHaveLength(1)
      expect(counter.bodies).toBe(1)

      clearArchiveCacheForTest()
      // 19:00 時点では 2 件とも対象。1 件は控えにあるが、もう 1 件のために本体が要る
      const second = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T19:00:00+09:00'), 50, 7, false)

      expect(counter.bodies).toBe(2)
      expect(second.quakes).toHaveLength(2)
      // 控えにあった側は同一参照で返る（解析し直していない）
      expect(second.quakes.some(q => q === first.quakes[0])).toBe(true)
    })

    // **落とさない日を「読めなかった日」に数えないこと。** 数えると全滅判定の分母
    // （`judgedDays`）と等号が成立して例外になり、控えから読めていたカードごと捨てられる。
    it('安全弁: 落とさない日は取得の失敗に数えない', async () => {
      const gz = await dayArchive([
        { id: 'hhhhhhh6', eventId: '20260810030000', time: '2026-08-10T12:05:00+09:00' },
      ])
      countingFetch([{ date: '2026-08-10', url: 'https://x/d10', gz }])
      const first = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)
      expect(first.quakes).toHaveLength(1)

      // 本体の控えだけを捨て、以後その URL は落とせない状態にする
      clearArchiveCacheForTest()
      countingFetch([{ date: '2026-08-10', url: 'https://x/d10', gz: 'error' }])

      const second = await fetchDmdataQuakeHistory('key', BEFORE, 50, 7, false)

      // 見るのは取得の失敗だけ。`uncovered:<日>`（目録にも当日経路にも当たらない日）は
      // この mock が 1 日ぶんしか目録を返さないことの現れで、落とさなかった日の話ではない
      expect(second.failedArchiveUrls.filter(u => !u.startsWith('uncovered:'))).toEqual([])
      expect(second.rateLimitedSources).toEqual([])
      expect(second.quakes).toHaveLength(1)
    })
  })

  // 目録の発表時刻が読めない電文を、アーカイブ本体のファイル名（17 桁の受信時刻）で救う。
  // 追加リクエストは 0 件。当日経路には同じ補いを置けない（本体を取る前に判定するため）。
  describe('目録の発表時刻が読めないとき', () => {
    /**
     * 目録の時刻だけを壊した 1 日ぶん。
     *
     * @param fileStamp 本体のファイル名に埋める 17 桁（UTC）。受信時刻として読まれる
     */
    async function brokenTimeArchive(manifestTime: unknown, fileStamp: string) {
      return makeTarGz([
        {
          name: 'telegrams.json',
          content: JSON.stringify([
            {
              id: 'ggggggg1',
              classification: 'telegram.earthquake',
              head: { type: 'VXSE53', time: manifestTime, test: false },
            },
          ]),
        },
        {
          name: 'ggggggg1_' + fileStamp + '_0.xml',
          content: historyBody('20260810030000', '2026-08-10T12:05:00+09:00'),
        },
      ])
    }

    it('正: 本体のファイル名の受信時刻で救う', async () => {
      // 03:05Z ＝ JST 12:05。指定時刻（JST 13:00）より前なので採る
      const gz = await brokenTimeArchive('not-a-date', '20260810030500000')
      globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

      const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T13:00:00+09:00'), 50, 7, false)

      expect(result.quakes).toHaveLength(1)
      expect(skippedTotal(result.skippedByDay)).toBe(0)
    })

    // 受信時刻は発表時刻以降なので、境界では**採らない側**（安全側）へ倒れる。
    it('安全弁: 救った受信時刻でも窓の判定をする（指定時刻より後なら採らない）', async () => {
      // 12:05Z ＝ JST 21:05。指定時刻（JST 13:00）より後
      const gz = await brokenTimeArchive('not-a-date', '20260810120500000')
      globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

      const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T13:00:00+09:00'), 50, 7, false)

      expect(result.quakes).toHaveLength(0)
      // 窓の外なのは正常。取りこぼしには数えない
      expect(skippedTotal(result.skippedByDay)).toBe(0)
    })

    // 「もっと見る」もリプレイの先読みも同じ日を何度も走査するので、控えないと押した回数だけ
    // 同じ行が並び、他の異常が埋もれる。**黙らせるのではなく、2 度目は控えから返す。**
    it('安全弁: 同じ電文について警告を繰り返さない', async () => {
      const warns: string[] = []
      vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
      const gz = await brokenTimeArchive('not-a-date', '20260810030500000')
      globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch
      const before = new Date('2026-08-10T13:00:00+09:00')

      await fetchDmdataQuakeHistory('key', before, 50, 7, false)
      await fetchDmdataQuakeHistory('key', before, 100, 14, false)

      const filled = warns.filter(w => w.includes('ファイル名から補った'))
      expect(filled).toHaveLength(1)
    })

    // `new Date(null)` は Invalid Date ではなく 1970-01-01 を返す。素通しさせると
    // 窓の判定に「ただの古い電文」として無言で吸収される。
    it('対照: 本体が見つからなければ落として取りこぼしに数える', async () => {
      const gz = await makeTarGz([
        {
          name: 'telegrams.json',
          content: JSON.stringify([
            {
              id: 'hhhhhhh1',
              classification: 'telegram.earthquake',
              head: { type: 'VXSE53', time: null, test: false },
            },
          ]),
        },
        // 対応する本体が無い（id の先頭 7 文字を含むファイルが 1 つも無い）
        {
          name: 'zzzzzzz9_20260810030500000_0.xml',
          content: historyBody('20260810030000', '2026-08-10T12:05:00+09:00'),
        },
      ])
      globalThis.fetch = mockHistoryArchives([{ date: '2026-08-10', url: 'https://x/d10', gz }]) as unknown as typeof fetch

      const result = await fetchDmdataQuakeHistory('key', new Date('2026-08-10T13:00:00+09:00'), 50, 7, false)

      expect(result.quakes).toHaveLength(0)
      expect(skippedTotal(result.skippedByDay)).toBe(1)
    })
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

// かつてここは「`MAX_HISTORY_DAYS` が `MAX_ENUMERATED_DAYS` - 1 であること」を固定していた。
// **遡り幅の上限そのものを撤廃した**（カーソル方式）ので、その境界は無くなっている。
//
// 代わりに固定するのは、**窓の広さが当日経路の暴走防止に触れないこと**。ここが崩れると、
// 窓を広げた瞬間に「押すたび例外を投げるだけのボタン」へ戻る（元の不具合がまさにそれ）。
describe('当日経路の列挙は窓の広さに引きずられない', () => {
  const before = new Date('2026-09-15T03:00:00Z')
  const rangeFor = (days: number) => {
    const from = new Date(before)
    from.setDate(from.getDate() - days)
    return [from, new Date(before.getTime() + 1)] as const
  }

  // 実際に当日経路へ渡るのは `LIVE_FALLBACK_DAYS` ぶんだけだが、窓の幅をそのまま渡しても
  // 歯止めに触れない余裕を保っておく（絞り込みを外しても即座に壊れない側へ倒す）。
  it('正: 1 回の窓の幅を渡しても列挙できる', () => {
    const [from, to] = rangeFor(HISTORY_WINDOW_DAYS)
    expect(enumerateJstDates(from, to)).toHaveLength(HISTORY_WINDOW_DAYS + 1)
  })

  it('対照: 歯止め自体は生きている', () => {
    const [from, to] = rangeFor(MAX_ENUMERATED_DAYS)
    expect(() => enumerateJstDates(from, to)).toThrow(/対象期間が広すぎます/)
  })
})

// リプレイの開始をまたいでアーカイブ本体を落とし直さないこと。
//
// **区間ごとにリプレイを開始し直す使い方（録画の自動化）で効く。** かつて
// `clearReplayCache()` がアーカイブの控えまで捨てていたため、開始のたびに同じファイルを
// 取り直していた（能登の録画計画 239 区間で 1,000〜3,800 リクエスト。実測 2026-09-16）。
// アーカイブ id は内容に対して不変なので、落とし直す理由が無い。
describe('アーカイブ本体の控えは開始をまたいで残る', () => {
  const originalFetch = globalThis.fetch
  const URL_A = 'https://x/a'

  // **パース結果の控えもここで空にする。** 目録の控えは `clearReplayCache()` では消えないので、
  // この describe の各 `it` は同じ URL・同じ作り物の id を使い回すぶん、残すと 1 件目が入れた
  // 目録を 2 件目以降が引く。いまは fixture の中身が同じなので揃って通っているだけ。
  beforeEach(async () => { await clearAllCaches() })
  afterEach(async () => {
    globalThis.fetch = originalFetch
    await clearAllCaches()
    vi.restoreAllMocks()
  })

  function archiveGz(): Promise<Uint8Array> {
    return makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('1234567abc')]) },
      { name: '1234567abc_20260810120500000_0.xml', content: quakeBody('岩手県沖') },
    ])
  }

  /** アーカイブ本体（目録ではない）を取りに行った回数。 */
  function bodyFetches(mock: ReturnType<typeof vi.fn>): number {
    return mock.mock.calls.filter(c => c[0] === URL_A).length
  }

  /** 目録を引いた回数。 */
  function listFetches(mock: ReturnType<typeof vi.fn>): number {
    return mock.mock.calls.filter(c => String(c[0]).includes('/v2/archive?')).length
  }

  it('正: clearReplayCache() を挟んでも本体を取り直さない', async () => {
    const mock = mockArchives([{ url: URL_A, gz: await archiveGz() }])
    globalThis.fetch = mock as unknown as typeof fetch

    const first = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(first.entries).toHaveLength(1)
    expect(bodyFetches(mock)).toBe(1)

    // 区間が変わってリプレイを開始し直した、という状況
    clearReplayCache()
    const second = await fetchDmdataReplayEvents('key', FROM, TO, false)

    // 中身は 1 度目と同じだけ取り込めている
    expect(second.entries).toHaveLength(1)
    // **本体は落とし直していない**
    expect(bodyFetches(mock)).toBe(1)
  })

  it('対照: 控えを空にすれば取り直す（残っていただけで、取得経路が死んでいるのではない）', async () => {
    const mock = mockArchives([{ url: URL_A, gz: await archiveGz() }])
    globalThis.fetch = mock as unknown as typeof fetch

    await fetchDmdataReplayEvents('key', FROM, TO, false)
    clearArchiveCacheForTest()
    const second = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(second.entries).toHaveLength(1)
    expect(bodyFetches(mock)).toBe(2)
  })

  // 安全弁: 目録は控えない。新しく届いた電文が永久に見えなくなるのを防ぐため
  // （理由は `dmdataReplayLive.ts` の `bodyCache` のコメントと同じ）。
  it('安全弁: 目録は毎回引き直す', async () => {
    const mock = mockArchives([{ url: URL_A, gz: await archiveGz() }])
    globalThis.fetch = mock as unknown as typeof fetch

    await fetchDmdataReplayEvents('key', FROM, TO, false)
    const afterFirst = listFetches(mock)
    clearReplayCache()
    await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(listFetches(mock)).toBeGreaterThan(afterFirst)
  })
})

// 当日ぶんのアーカイブは控えない、という安全弁そのものを固定する。
//
// **この判定が壊れても、他のどのテストも落ちない。** 現状は目録に当日が現れないので分岐へ
// 到達せず、実機で確かめることもできない（`uncacheable` は 0 のまま）。
describe('当日ぶんのアーカイブは控えない（isArchiveCacheable）', () => {
  // JST の 2026-09-16 09:00（UTC では 00:00）を「いま」とする
  const nowMs = Date.parse('2026-09-16T09:00:00+09:00')

  it('正: 当日と同じ日は控えない', () => {
    expect(isArchiveCacheable('2026-09-16', nowMs)).toBe(false)
  })

  it('対照: 前日は控える', () => {
    expect(isArchiveCacheable('2026-09-15', nowMs)).toBe(true)
  })

  // **日境界は JST で見る。** UTC で数えると、JST の 00:00〜09:00 のあいだ「今日」が
  // 1 日前にずれ、当日ぶんを控えてしまう（いちばん弾きたい時間帯で弾けない）。
  it('安全弁: JST の日境界で判定する（UTC 基準にずれない）', () => {
    const justAfterJstMidnight = Date.parse('2026-09-16T00:30:00+09:00')
    expect(isArchiveCacheable('2026-09-16', justAfterJstMidnight)).toBe(false)
    expect(isArchiveCacheable('2026-09-15', justAfterJstMidnight)).toBe(true)
  })
})

// 本編の再生でも、窓に 1 件も入らない日は本体を落とさない。
//
// **履歴側と条件が違う。** 本編はパース結果を控えない（窓を前へ進めるので同じ電文を二度
// 読まない）ので、窓に入るエントリがあれば必ず本体が要る。効くのは静かな窓のほうで、
// そこでは目録だけで「読むものが無い」と決められる。
describe('窓に入る電文が無い日は本体を落とさない', () => {
  const originalFetch = globalThis.fetch
  const URL_D1 = 'https://x/only'
  /** 目録の唯一の電文。JST 12:00 発表。 */
  const ENTRY_TIME = '2026-08-10T12:00:00+09:00'
  /** 上の電文を含まない窓（JST 01:00〜02:00）。 */
  const QUIET_FROM = new Date('2026-08-10T01:00:00+09:00')
  const QUIET_TO = new Date('2026-08-10T02:00:00+09:00')

  beforeEach(async () => { await clearAllCaches() })
  afterEach(async () => {
    globalThis.fetch = originalFetch
    await clearAllCaches()
    vi.restoreAllMocks()
  })

  async function oneEntryArchive(): Promise<Uint8Array> {
    return makeTarGz([
      {
        name: 'telegrams.json',
        content: JSON.stringify([manifestEntry('i1', 'VXSE53', ENTRY_TIME)]),
      },
      { name: 'i1.xml', content: quakeBody('石川県能登地方') },
    ])
  }

  /** 本体を取りに行った回数を数える fetch を差す。 */
  function countingFetch(gz: Uint8Array): { bodies: number } {
    const base = mockArchives([{ url: URL_D1, gz }])
    const counter = { bodies: 0 }
    globalThis.fetch = (async (input: string) => {
      if (String(input) === URL_D1) counter.bodies++
      return base(String(input))
    }) as unknown as typeof fetch
    return counter
  }

  it('正: 目録が控えにあり窓に 1 件も入らないなら落とさない', async () => {
    const counter = countingFetch(await oneEntryArchive())

    // 1 回目は目録のために落とす（窓はその電文を含む）
    const first = await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(first.entries).toHaveLength(1)
    expect(counter.bodies).toBe(1)

    // 本体の控えだけが落ちた状態で、静かな窓を再生する
    clearArchiveCacheForTest()
    const quiet = await fetchDmdataReplayEvents('key', QUIET_FROM, QUIET_TO, false)

    expect(quiet.entries).toHaveLength(0)
    expect(counter.bodies).toBe(1)
  })

  it('対照: 窓に入る電文が 1 件でもあれば落とす', async () => {
    const counter = countingFetch(await oneEntryArchive())

    await fetchDmdataReplayEvents('key', FROM, TO, false)
    expect(counter.bodies).toBe(1)

    clearArchiveCacheForTest()
    const again = await fetchDmdataReplayEvents('key', FROM, TO, false)

    expect(again.entries).toHaveLength(1)
    expect(counter.bodies).toBe(2)
  })

  it('安全弁: 目録の控えが無ければ、静かな窓でも落とす', async () => {
    const counter = countingFetch(await oneEntryArchive())

    const quiet = await fetchDmdataReplayEvents('key', QUIET_FROM, QUIET_TO, false)

    expect(quiet.entries).toHaveLength(0)
    expect(counter.bodies).toBe(1)
  })
})
