import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchDayListing, fetchRawXml } from './niiJmaXmlArchive'

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
