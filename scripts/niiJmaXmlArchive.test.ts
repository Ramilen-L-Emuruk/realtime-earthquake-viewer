import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// キャッシュの実体をメモリ上の Map で置き換える。テストが実際の `.claude/nii-cache/` を
// 汚さないようにするため（vi.mock のファクトリは巻き上げられるので vi.hoisted で用意する）。
const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }))

// 読み書きを失敗させたいテストのための差し込み口（null なら通常どおり読み書きできる）。
const { writeFailure, readFailure } = vi.hoisted(() => ({
  writeFailure: { message: null as string | null },
  readFailure: { message: null as string | null, code: 'EACCES' },
}))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  unlink: vi.fn(async (p: unknown) => {
    files.delete(String(p))
  }),
  readFile: vi.fn(async (p: unknown) => {
    if (readFailure.message) throw Object.assign(new Error(readFailure.message), { code: readFailure.code })
    const hit = files.get(String(p))
    if (hit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return hit
  }),
  writeFile: vi.fn(async (p: unknown, data: unknown) => {
    if (writeFailure.message) throw new Error(writeFailure.message)
    files.set(String(p), String(data))
  }),
  rename: vi.fn(async (from: unknown, to: unknown) => {
    const body = files.get(String(from))
    if (body === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    files.delete(String(from))
    files.set(String(to), body)
  }),
}))

import { fetchDayListing, fetchRawXml } from './niiJmaXmlArchive'

beforeEach(() => {
  files.clear()
  writeFailure.message = null
  readFailure.message = null
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockFetchOnce(text: string, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, text: () => Promise.resolve(text) }),
  )
}

// 実サイトのHTMLは `</a><br><a ...>` が改行・字下げを挟まず連続する（report_day.pl の
// 実出力で確認済み）。テストの断片もその形をそのまま模す。
function row(id: string, time: string, typeLabel: string): string {
  return `<a class="time" href="/cgi-bin/cps/report_each.pl?id=${id}">${time}</a><br><a class="nowrap" href="/cgi-bin/cps/report_list.pl?type=x">${typeLabel}</a><br><a class="nowrap" href="/cgi-bin/cps/report_list.pl?office=x">気象庁本庁</a>`
}

describe('fetchDayListing', () => {
  it('正: 1日ぶんの一覧HTMLから id・時刻・種別ラベルを抽出する', async () => {
    mockFetchOnce(row('uuid-1', '2016-04-14 21:28:06+09', '震度速報'))
    const items = await fetchDayListing('20160414')
    expect(items).toEqual([{ id: 'uuid-1', time: '2016-04-14 21:28:06+09', typeLabel: '震度速報' }])
  })

  it('対照: 該当する行が無ければ空配列を返す（例外にしない）', async () => {
    mockFetchOnce('<html>no matching rows</html>')
    const items = await fetchDayListing('20160101')
    expect(items).toEqual([])
  })

  it('安全弁: 複数件を発表時刻順のまま全て拾う', async () => {
    const html = row('uuid-1', '2016-04-14 21:28:06+09', '震度速報') + row('uuid-2', '2016-04-14 21:32:25+09', '震源に関する情報')
    mockFetchOnce(html)
    const items = await fetchDayListing('20160414')
    expect(items.map((i) => i.id)).toEqual(['uuid-1', 'uuid-2'])
  })

  it('安全弁（バグ回帰）: time要素はあるがマッチしない行があれば例外を投げる（無警告で読み飛ばさない）', async () => {
    // 2件目だけ想定外のマークアップ（nowrapリンクの手前に余分な要素）にして正規表現から外す。
    const broken = '<a class="time" href="/cgi-bin/cps/report_each.pl?id=uuid-2">2016-04-14 21:32:25+09</a><br><span>予期しない要素</span><a class="nowrap" href="/cgi-bin/cps/report_list.pl?type=x">震源に関する情報</a>'
    const html = row('uuid-1', '2016-04-14 21:28:06+09', '震度速報') + broken
    mockFetchOnce(html)
    await expect(fetchDayListing('20160414')).rejects.toThrow(/パースできませんでした/)
  })
})

describe('fetchRawXml', () => {
  it('正: <pre>ブロック内のHTMLエスケープ済みXMLを復元する', async () => {
    mockFetchOnce('<html><body><pre>&lt;Report&gt;&lt;Title&gt;震度速報&lt;/Title&gt;&lt;/Report&gt;</pre></body></html>')
    const xml = await fetchRawXml('uuid-1')
    expect(xml).toBe('<Report><Title>震度速報</Title></Report>')
  })

  it('対照（バグ回帰）: <pre>ブロックが無ければ例外を投げる（空文字列を返さない）', async () => {
    mockFetchOnce('<html><body>no xml here</body></html>')
    await expect(fetchRawXml('uuid-1')).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 取得を諦めない仕組み（キャッシュ・リトライ）と、残してよい内容かの検分。
//
// 配信元は小規模な学術サーバーで、混雑すると 1 応答に 60〜90 秒かかり 502 も返す（実測）。
// 1 件の地震活動で数百通を 1 通ずつ取るため、途中で落ちたときに最初からやり直すと
// 相手にも負荷をかける。
// ---------------------------------------------------------------------------

describe('取得はキャッシュして二度取らない', () => {
  it('正: 一度取った一覧は、次の呼び出しで配信元を叩かない', async () => {
    mockFetchOnce(row('uuid-1', '2016-04-14 21:28:06+09', '震度速報'))
    const first = await fetchDayListing('20160414')
    expect(first).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)

    const second = await fetchDayListing('20160414')
    expect(second).toEqual(first)
    // **2 回目で増えていないことが肝心。** ここが崩れると、数百通の取り直しが
    // そのまま配信元への負荷になる
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('正: 電文もキャッシュする。鍵が違えば別々に取る', async () => {
    mockFetchOnce('<html><body><pre>&lt;Report&gt;&lt;/Report&gt;</pre></body></html>')
    await fetchRawXml('uuid-1')
    await fetchRawXml('uuid-1')
    expect(fetch).toHaveBeenCalledTimes(1)

    await fetchRawXml('uuid-2')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('名乗りを送る（配信元が自動取得を識別できるようにする）', async () => {
    mockFetchOnce(row('uuid-1', '2016-04-14 21:28:06+09', '震度速報'))
    await fetchDayListing('20160414')

    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers['user-agent']).toMatch(/realtime-earthquake-viewer/)
    // **ブラウザを騙らない。** 相手から見て何が叩いているか分かる形にしておく
    expect(init.headers['user-agent']).not.toMatch(/Mozilla/)
  })
})

describe('残してよい内容かを検分してから保存する', () => {
  it('対照: 1件も載っていない一覧はキャッシュしない（次回また取りに行く）', async () => {
    mockFetchOnce('<html>ただいま混み合っています</html>')
    await fetchDayListing('20160101')
    // **残すと、その日は二度と取り直されないまま「電文が 1 通も無い日」として固定される**
    expect(files.size).toBe(0)

    // 2 回目はキャッシュが無いので、もう一度取りに行く
    await fetchDayListing('20160101')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('対照: 電文の本体が入っていない応答はキャッシュしない', async () => {
    // `<pre>` はあるが気象庁防災情報XMLの根要素が無い ——
    // エラーページも整形済みテキストを `<pre>` で包みうる。
    // **この形は例外にならず、中身がそのまま返る**（`<pre>` があるかどうかしか見ないため）。
    // 電文として読めないことは呼び出し側が「パース失敗」として数えるので、ここで塞ぐ必要は無い。
    // ただし**残してはいけない** —— 残すとその電文は二度と取り直されず、
    // 恒久的に「読めない電文」として居座る
    mockFetchOnce('<html><pre>Internal Server Error</pre></html>')
    await expect(fetchRawXml('uuid-1')).resolves.toBe('Internal Server Error')
    expect(files.size).toBe(0)
  })

  it('安全弁: 検分に落ちても例外にはしない（呼び出し側の判断を飛び越えない）', async () => {
    // 「該当行が無ければ空配列」は fetchDayListing が元から持っている振る舞い。
    // **キャッシュの都合でここを例外に変えてしまわないこと**
    mockFetchOnce('<html>no matching rows</html>')
    await expect(fetchDayListing('20160101')).resolves.toEqual([])
    // リトライも走らない（HTTP 200 が返っている以上、取得そのものは成功している）
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('正: 検分を通った応答は残り、次回はそれが返る', async () => {
    mockFetchOnce(row('uuid-1', '2016-04-14 21:28:06+09', '震度速報'))
    await fetchDayListing('20160414')
    expect(files.size).toBe(1)
  })

  it('安全弁: 壊れて残っていたキャッシュは無かったことにして取り直す', async () => {
    // 数百通を数分かけて取るので、途中で中断されれば切り詰められた内容が残りうる。
    // **読むときにも検分しないと、それが下流へ流れる**
    const html = row('uuid-1', '2016-04-14 21:28:06+09', '震度速報')
    mockFetchOnce(html)
    await fetchDayListing('20160414')
    expect(fetch).toHaveBeenCalledTimes(1)

    // 保存済みの内容を、書きかけで切れた形へ差し替える
    const key = [...files.keys()][0]!
    files.set(key, html.slice(0, 40))

    const items = await fetchDayListing('20160414')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(items.map((i) => i.id)).toEqual(['uuid-1'])
  })
})

describe('キャッシュが使えない状態を黙って見過ごさない', () => {
  it('安全弁: 読めない理由が「まだ無い」以外なら記録する', async () => {
    // 権限や I/O の異常で読めない状態が続くと、キャッシュが無いのと同じことになり
    // 数百通を毎回取り直す。**その負荷が誰にも気づかれずに戻るのを避ける**
    readFailure.message = 'EACCES: permission denied'
    readFailure.code = 'EACCES'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchOnce(row('uuid-1', '2016-04-14 21:28:06+09', '震度速報'))

    const items = await fetchDayListing('20160414')
    expect(items.map((i) => i.id)).toEqual(['uuid-1'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('読めませんでした'))
    warn.mockRestore()
  })

  it('対照: まだ残していないだけ（ENOENT）では記録しない', async () => {
    // これは正常な経路。ここで鳴らすと、初回取得のたびに警告が出て本物の異常が埋もれる
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchOnce(row('uuid-1', '2016-04-14 21:28:06+09', '震度速報'))

    await fetchDayListing('20160414')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('保存の失敗は取得の失敗と切り離す', () => {
  it('安全弁: 残せなくても取得は成功する（配信元を叩き直さない）', async () => {
    // ディスクが一杯・書き込み権限が無い等はローカル起因で、配信元とは無関係。
    // **ここでリトライすると、既に取れている応答を捨てて低速な相手をもう一度叩くことになる**
    writeFailure.message = 'ENOSPC: no space left on device'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchOnce(row('uuid-1', '2016-04-14 21:28:06+09', '震度速報'))

    const items = await fetchDayListing('20160414')
    expect(items.map((i) => i.id)).toEqual(['uuid-1'])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(files.size).toBe(0)
    // **黙って捨てない。** 残せていないことは次回の取り直しで効いてくる
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('残せませんでした'))
    warn.mockRestore()
  })
})

describe('通信の失敗は粘る', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** リトライのバックオフ（2/4/8/16/32 秒）を飛ばして決着させる。 */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    const raced = promise.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    )
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    const r = await raced
    if (r.ok) return r.v
    throw r.e
  }

  it('正: 502 が続いたあとに 200 が返れば、その内容を返す', async () => {
    const html = row('uuid-1', '2016-04-14 21:28:06+09', '震度速報')
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 502, text: () => Promise.resolve('') })
        .mockResolvedValueOnce({ ok: false, status: 502, text: () => Promise.resolve('') })
        .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(html) }),
    )

    const items = await settle(fetchDayListing('20160414'))
    expect(items.map((i) => i.id)).toEqual(['uuid-1'])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('安全弁: 失敗し続けても 6 回で打ち切る（無限に粘らない）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: () => Promise.resolve('') }))

    await expect(settle(fetchDayListing('20160414'))).rejects.toThrow(/取得失敗/)
    expect(fetch).toHaveBeenCalledTimes(6)
  })
})
