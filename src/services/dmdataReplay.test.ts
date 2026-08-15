// DMDATA archive リプレイ取得の耐障害性テスト。
//
// 重点は「一部が壊れていても、壊れていない分は取り込めること」。
// 従来は電文 1 通の破損で Promise.all ごと reject し、その日を含む期間の再生が
// 丸ごと不可能になっていた。また目録（telegrams.json）が無いアーカイブは無言で
// 捨てられ、「電文 0 件だが成功」に化けて原因が追えなかった。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchDmdataReplayEvents, clearReplayCache } from './dmdataReplay'

const HEADER = 512
const enc = new TextEncoder()

function makeTarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(HEADER)
  h.set(enc.encode(name), 0)
  h.set(enc.encode(size.toString(8).padStart(11, '0')), 124)
  h[156] = '0'.charCodeAt(0)
  return h
}

function makeTar(files: Array<{ name: string; content: string }>): Uint8Array {
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
  const out = new Uint8Array(total)
  let offset = 0
  for (const b of blocks) { out.set(b, offset); offset += b.length }
  return out
}

async function makeTarGz(files: Array<{ name: string; content: string }>): Promise<Uint8Array> {
  const stream = new Blob([makeTar(files) as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// 電文 1 通の中身（VXSE53 = 震源・震度に関する情報）。parseEarthquake が通る最小形。
function quakeBody(hypocenterName: string): string {
  return JSON.stringify({
    eventId: '20260810120000',
    serialNo: '1',
    infoType: '発表',
    reportDateTime: '2026-08-10T12:05:00+09:00',
    targetDateTime: '2026-08-10T12:00:00+09:00',
    editorialOffice: '気象庁',
    body: {
      earthquake: {
        arrivalTime: '2026-08-10T12:00:00+09:00',
        hypocenter: {
          name: hypocenterName,
          coordinate: { latitude: { value: '39.9' }, longitude: { value: '142.2' }, height: { value: '-50000' } },
        },
        magnitude: { value: '5.1' },
        maxInt: '4',
      },
      intensity: { maxInt: '4' },
    },
  })
}

/** manifest 1 件分。ファイル名は id の先頭 7 文字を含む必要がある。 */
function manifestEntry(id: string, type = 'VXSE53', time = '2026-08-10T12:05:00+09:00') {
  return { id, originalId: id, classification: 'telegram.earthquake', head: { type, time, test: false } }
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
      { name: '1234567abc_20260810120500000_0.json', content: quakeBody('岩手県沖') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)
    expect(entries).toHaveLength(1)
    expect(entries[0].payload.kind).toBe('event')
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
      { name: 'aaaaaaa1_20260810120500000_0.json', content: '{ 壊れた JSON' },
      { name: 'ddddddd4_20260810120800000_0.json', content: quakeBody('石廊崎沖') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO)

    expect(result.entries).toHaveLength(1)
    expect(result.skipped).toBe(3)
    expect(result.failedArchiveUrls).toHaveLength(0)
  })

  it('一部のアーカイブが失敗した件数を戻り値で返す', async () => {
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('eeeeeee5')]) },
      { name: 'eeeeeee5_20260810120500000_0.json', content: quakeBody('房総沖') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/broken', gz: 'error' },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO)

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
      { name: 'ggggggg7_20260810120500000_0.json', content: quakeBody('駿河湾') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/nomanifest', gz: noManifest },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO)

    expect(result.entries).toHaveLength(1)
    expect(result.failedArchiveUrls).toEqual(['https://x/nomanifest'])
  })

  it('目録が壊れているアーカイブを読めなかった数に含める', async () => {
    const brokenManifest = await makeTarGz([{ name: 'telegrams.json', content: '[[[壊れた' }])
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('hhhhhhh8')]) },
      { name: 'hhhhhhh8_20260810120500000_0.json', content: quakeBody('相模湾') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/brokenmanifest', gz: brokenManifest },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO)

    expect(result.entries).toHaveLength(1)
    expect(result.failedArchiveUrls).toEqual(['https://x/brokenmanifest'])
  })

  it('全アーカイブの目録が読めない場合は例外にする（無警告の成功にしない）', async () => {
    const noManifest = await makeTarGz([{ name: 'body.json', content: quakeBody('無関係') }])
    globalThis.fetch = mockArchives([
      { url: 'https://x/a', gz: noManifest },
      { url: 'https://x/b', gz: noManifest },
    ]) as unknown as typeof fetch

    await expect(fetchDmdataReplayEvents('key', FROM, TO)).rejects.toThrow(/すべてを読み取れませんでした/)
  })

  it('読めなかったアーカイブは URL で返す（呼び出し元が重複を除けるように）', async () => {
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('iiiiiii9')]) },
      { name: 'iiiiiii9_20260810120500000_0.json', content: quakeBody('若狭湾') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/broken', gz: 'error' },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO)

    // 本編と初期状態が同じアーカイブを読んでも、呼び出し元は URL で重複を除ける
    expect(result.failedArchiveUrls).toEqual(['https://x/broken'])
  })

  it('すべて正常なら skipped も failedArchives も 0', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('fffffff6')]) },
      { name: 'fffffff6_20260810120500000_0.json', content: quakeBody('伊豆大島近海') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO)

    expect(result.entries).toHaveLength(1)
    expect(result.skipped).toBe(0)
    expect(result.failedArchiveUrls).toHaveLength(0)
  })

  it('破損した電文が 1 通あっても、他の電文は取り込まれる（全滅しない）', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('aaaaaaa1'), manifestEntry('bbbbbbb2')]) },
      { name: 'aaaaaaa1_20260810120500000_0.json', content: '{ これは JSON ではない' },
      { name: 'bbbbbbb2_20260810120600000_0.json', content: quakeBody('宮城県沖') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)

    // 壊れていない側は取り込めている
    expect(entries).toHaveLength(1)
    // 捨てた事実はログに残る（無言で消さない）
    expect(errors.join('\n')).toMatch(/aaaaaaa1/)
  })

  it('telegrams.json が無いアーカイブは警告を残してスキップし、他のアーカイブは処理する', async () => {
    const broken = await makeTarGz([{ name: 'body.json', content: quakeBody('無関係') }])
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('ccccccc3')]) },
      { name: 'ccccccc3_20260810120500000_0.json', content: quakeBody('福島県沖') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/broken', gz: broken },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)

    expect(entries).toHaveLength(1)
    expect(warns.join('\n')).toMatch(/telegrams\.json/)
  })

  it('telegrams.json 自体が壊れていても他のアーカイブは処理する', async () => {
    const broken = await makeTarGz([{ name: 'telegrams.json', content: '[[[壊れた目録' }])
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('ddddddd4')]) },
      { name: 'ddddddd4_20260810120500000_0.json', content: quakeBody('三陸沖') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/broken', gz: broken },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)

    expect(entries).toHaveLength(1)
    expect(errors.join('\n')).toMatch(/telegrams\.json/)
  })

  it('本体ファイルが見つからない電文は警告を残してスキップする', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('eeeeeee5')]) },
      // eeeeeee5 に対応する本体を意図的に入れない
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)

    expect(entries).toHaveLength(0)
    expect(warns.join('\n')).toMatch(/本体が見つからず/)
  })

  it('head.time が不正な電文は警告を残してスキップする（Invalid Date を通さない）', async () => {
    const gz = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('fffffff6', 'VXSE53', 'not-a-date')]) },
      { name: 'fffffff6_20260810120500000_0.json', content: quakeBody('日向灘') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)

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
      { name: 'jjjjjjj0_20260810120500000_0.json', content: quakeBody('種子島近海') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const result = await fetchDmdataReplayEvents('key', FROM, TO)

    expect(result.entries).toHaveLength(1)
    expect(result.skipped).toBe(1)
    expect(warns.join('\n')).toMatch(/head\.time/)
  })

  it('対象外の種別は警告を出さない（正常運転でログを埋めない）', async () => {
    const gz = await makeTarGz([
      // VZSE40 等の対象外種別。本体ファイルが無くても警告は出ないこと
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('9999999z', 'VZSE40')]) },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)

    expect(entries).toHaveLength(0)
    expect(warns.join('\n')).not.toMatch(/本体が見つからず/)
  })

  // 実アーカイブでは manifest に同じ電文が XML 版と JSON 版の 2 エントリで載る
  // （originalId を持つ方が JSON 版）。XML 版を落とすのは正常な重複排除なので、
  // ここで警告を出すと通常のリプレイ 1 回で数十件のログが出て異常が埋もれる。
  it('originalId を持たない XML 版エントリは、警告なしで JSON 版だけを取り込む', async () => {
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
      { name: `${xmlId}_20260810120500000_0.xml`, content: '<Report/>' },
      { name: `${jsonId}_20260810120500000_0.json`, content: quakeBody('石狩地方中部') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)

    // 二重に取り込まれない
    expect(entries).toHaveLength(1)
    // XML 版を落としたことで警告が出ない
    expect(warns.join('\n')).not.toMatch(/originalId/)
    expect(warns.join('\n')).not.toMatch(/本体が見つからず/)
  })

  it('アーカイブ取得が全滅した場合は例外として伝播する（無言で 0 件にしない）', async () => {
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz: 'error' }]) as unknown as typeof fetch

    await expect(fetchDmdataReplayEvents('key', FROM, TO)).rejects.toThrow(/Archive fetch failed/)
  })

  // ここが今回の要。1 つのアーカイブの破損で、他のアーカイブから読めた電文まで
  // 巻き添えにしてはいけない（Promise.all の即時 reject に素通しすると全滅する）。
  it('一部のアーカイブが取得失敗しても、残りのアーカイブの電文は取り込まれる', async () => {
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('8888888h')]) },
      { name: '8888888h_20260810120500000_0.json', content: quakeBody('十勝沖') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/broken', gz: 'error' },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)

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
      { name: '6666666k_20260810120500000_0.json', content: quakeBody('遠州灘') },
    ])
    globalThis.fetch = mockArchives([
      { url: 'https://x/brokentar', gz: brokenGz },
      { url: 'https://x/good', gz: good },
    ]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)

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
      { name: `${jsonId}_20260810120500000_0.json`, content: '{}' },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    await fetchDmdataReplayEvents('key', FROM, TO)

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
      { name: '5555555m_20260810120500000_0.json', content: quakeBody('紀伊水道') },
    ])
    globalThis.fetch = mockArchives([{ url: 'https://x/a', gz }]) as unknown as typeof fetch

    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)

    expect(entries).toHaveLength(1)
    expect(warns.join('\n')).toMatch(/head を持たない/)
  })

  it('取得に失敗したアーカイブはキャッシュに残らず、次の試行で再取得される', async () => {
    // 1 回目は 500、2 回目は成功する fetch を用意する
    const good = await makeTarGz([
      { name: 'telegrams.json', content: JSON.stringify([manifestEntry('7777777g')]) },
      { name: '7777777g_20260810120500000_0.json', content: quakeBody('浦河沖') },
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

    await expect(fetchDmdataReplayEvents('key', FROM, TO)).rejects.toThrow()
    // clearReplayCache を挟まずに再試行しても、失敗はキャッシュされていないので回復する
    const { entries } = await fetchDmdataReplayEvents('key', FROM, TO)
    expect(entries).toHaveLength(1)
  })
})
