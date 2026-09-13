import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
// **`node:fs` は素のまま使う。** 下で `node:fs/promises` をモックするが別モジュールなので、
// キャッシュの読み書きを模した `files` の Map には掛からない
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'

const SCRIPTS_DIR = 'scripts'

/** キャッシュを通る取得。これを取り込む側が要約を出す責任を負う */
const CACHED_FETCHERS = new Set(['fetchDayListing', 'fetchRawXml'])

/** `niiJmaXmlArchive` を指すモジュール名か（サブディレクトリからは `../` になる） */
function isNiiModule(node: ts.Expression | undefined): boolean {
  return node !== undefined && ts.isStringLiteral(node) && /^(?:\.\.?\/)+niiJmaXmlArchive$/.test(node.text)
}

/** `{ a, b as c }` の並びに、キャッシュを通る取得が含まれるか。**別名で受けても元の名前で見る** */
function hasCachedFetcher(elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): boolean {
  // 型だけの取り込みは実行時に何も起こさないので咎めない
  return elements.some((e) => !e.isTypeOnly && CACHED_FETCHERS.has((e.propertyName ?? e.name).text))
}

/**
 * そのソースが、キャッシュを通る取得を `niiJmaXmlArchive` から取り込んでいるか。
 *
 * **構文解析で見る。** 字面を追う作りだと、書き方を変えるだけですり抜ける穴が形を変えて
 * 出続ける（再エクスポート・動的 import・1 行に複数の文、を実際に取りこぼした）。
 *
 * **中身を追えない取り込み方は、名前を問わず一律で咎める。** どれも「何を使っているか」が
 * その場所からは判らないため。
 *
 *   `import * as nii from ...`     あとで `nii.fetchRawXml(...)` と呼べる
 *   `export * from ...`            再エクスポート（`export * as ns from ...` も同じ）
 *   `import(...)` / `require(...)` 取り込んだ先で何を使うかは追えない
 *                                  （`import nii = require(...)` も。**別のノード種別**）
 *
 * 型だけの取り込み（`import type` ／ `{ type X }`）は実行時に何も起こさないので咎めない。
 */
function importsCachedFetchers(src: string): boolean {
  const sourceFile = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true)
  let found = false

  const visit = (node: ts.Node): void => {
    if (found) return

    if (ts.isImportDeclaration(node) && isNiiModule(node.moduleSpecifier)) {
      const clause = node.importClause
      // `import './niiJmaXmlArchive'`（副作用のみ）は何も持ち出さない
      if (clause && !clause.isTypeOnly && clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) found = true
        else if (hasCachedFetcher(clause.namedBindings.elements)) found = true
      }
    }

    if (ts.isExportDeclaration(node) && isNiiModule(node.moduleSpecifier) && !node.isTypeOnly) {
      // `export * from ...` は `exportClause` を持たない
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) found = true
      else if (hasCachedFetcher(node.exportClause.elements)) found = true
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      // このリポジトリの `scripts/` は ESM 前提なので現れないが、同じ理由で咎める側に置く
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if ((isDynamicImport || isRequire) && isNiiModule(node.arguments[0])) found = true
    }

    // `import nii = require('...')`。**`require` の呼び出し形とは別のノード**なので、
    // 上の分岐では拾えない（右辺は `CallExpression` ではなく `ExternalModuleReference`）
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isNiiModule(node.moduleReference.expression)
    ) {
      found = true
    }

    if (!found) ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

// キャッシュの実体をメモリ上の Map で置き換える。テストが実際の `.claude/nii-cache/` を
// 汚さないようにするため（vi.mock のファクトリは巻き上げられるので vi.hoisted で用意する）。
const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }))

// 読み書きを失敗させたいテストのための差し込み口（null なら通常どおり読み書きできる）。
const { writeFailure, readFailure } = vi.hoisted(() => ({
  writeFailure: { message: null as string | null, code: 'ENOSPC' },
  // `code` は `undefined` にもできる（fs 由来でない例外を模す）
  readFailure: { message: null as string | null, code: 'EACCES' as string | undefined },
}))

/**
 * `fs` の例外メッセージを模す。**対象パスを含める** ——
 * 実物は `EACCES: permission denied, open 'C:\...\day-20160414.html'` の形で、
 * 同じ原因でもファイルごとに文面が変わる。ここを固定文字列にすると、
 * 「文面が違う＝別の異常」という前提のコードが実運用と食い違っていても気づけない。
 *
 * `code` を持たない例外（`fs` 由来でないもの）はパスを含まないので、そのまま返す。
 */
const { fsErrorMessage } = vi.hoisted(() => ({
  fsErrorMessage: (failure: { message: string | null; code?: string }, path: unknown): string =>
    failure.code === undefined ? String(failure.message) : `${failure.message}, open '${String(path)}'`,
}))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  unlink: vi.fn(async (p: unknown) => {
    files.delete(String(p))
  }),
  readFile: vi.fn(async (p: unknown) => {
    if (readFailure.message) throw Object.assign(new Error(fsErrorMessage(readFailure, p)), { code: readFailure.code })
    const hit = files.get(String(p))
    if (hit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return hit
  }),
  writeFile: vi.fn(async (p: unknown, data: unknown) => {
    if (writeFailure.message) throw Object.assign(new Error(fsErrorMessage(writeFailure, p)), { code: writeFailure.code })
    files.set(String(p), String(data))
  }),
  rename: vi.fn(async (from: unknown, to: unknown) => {
    const body = files.get(String(from))
    if (body === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    files.delete(String(from))
    files.set(String(to), body)
  }),
}))

import { fetchDayListing, fetchRawXml, flushSuppressedCacheWarnings } from './niiJmaXmlArchive'

beforeEach(() => {
  files.clear()
  writeFailure.message = null
  writeFailure.code = 'ENOSPC'
  readFailure.message = null
  readFailure.code = 'EACCES'
  // 同じ原因を数える表は実行全体で共有される（間引きのため）。前のテストが残した分を
  // 持ち越さない。出力は捨てる —— ここで数を確かめたいテストは無い
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  flushSuppressedCacheWarnings()
  warn.mockRestore()
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

// 恒常的に読み書きできない状態だと、電文1通ごとに同じ警告が出る（2016年熊本地震は653通で、
// 読みと保存の両方が失敗すれば最大1,306行）。あいだに挟まる進捗ログが埋もれるため間引くが、
// **間引いた分は件数として必ず残す。**
describe('同じ原因が続く警告は間引く', () => {
  /** 読めない状態にして、別々の日を `count` 回取りに行く（キーが違うので毎回キャッシュを読む）。 */
  async function fetchDaysWithUnreadableCache(count: number): Promise<void> {
    mockFetchOnce(row('uuid-1', '2016-04-14 21:28:06+09', '震度速報'))
    for (let i = 0; i < count; i++) await fetchDayListing(`2016041${i}`)
  }

  it('正: 同じ原因なら、記録されるのは最初の1回だけ', async () => {
    readFailure.message = 'EACCES: permission denied'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await fetchDaysWithUnreadableCache(3)

    const readWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('読めませんでした'))
    expect(readWarnings).toHaveLength(1)
    // **黙ったわけではないことを、その1行で伝える** —— 以後が消えたように見えると、
    // 読んだ人は「途中で直った」と受け取る
    expect(readWarnings[0][0]).toContain('以後、同じ原因（EACCES）は件数だけ最後にまとめる')
    warn.mockRestore()
  })

  it('対照: 原因（エラーコード）が違えば、それぞれ1回ずつ出す', async () => {
    // 1つ目で黙らせてしまうと、別の異常が起きたことが分からない
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchOnce(row('uuid-1', '2016-04-14 21:28:06+09', '震度速報'))

    readFailure.message = 'EACCES: permission denied'
    await fetchDayListing('20160414')
    readFailure.message = 'EIO: i/o error'
    readFailure.code = 'EIO'
    await fetchDayListing('20160415')

    expect(warn.mock.calls.filter((c) => String(c[0]).includes('読めませんでした'))).toHaveLength(2)
    warn.mockRestore()
  })

  it('対照: 読みと保存は、原因が同じでも別々に数える', async () => {
    // 「読めない」と「残せない」は別の事実。まとめると、後から起きたほうが痕跡を残さない
    readFailure.message = 'EACCES: permission denied'
    writeFailure.message = 'EACCES: permission denied'
    writeFailure.code = 'EACCES'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await fetchDaysWithUnreadableCache(2)

    expect(warn.mock.calls.filter((c) => String(c[0]).includes('読めませんでした'))).toHaveLength(1)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('残せませんでした'))).toHaveLength(1)
    warn.mockRestore()
  })

  it('安全弁: 間引いた分は件数として残る（黙って捨てない）', async () => {
    readFailure.message = 'EACCES: permission denied'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await fetchDaysWithUnreadableCache(3)
    flushSuppressedCacheWarnings()

    // 3回のうち1回目は起きた時点で出ているので、残りは2件。
    // **原因（エラーコード）まで出す** —— 件数だけでは、どの不調が続いていたか分からない。
    // 文面まで同じなので見本は付かない（付く場合は次のテスト）。厳密一致で固定しているのは、
    // 同じことを繰り返し並べないことまで含めて決めているため
    expect(warn).toHaveBeenCalledWith('[nii-cache] 読めませんでした（EACCES）: ほかに2件')
    warn.mockRestore()
  })

  it('対照: 原因（エラーコード）が取れていれば、文面がファイルごとに違っても見本は付けない', async () => {
    // **`fs` の例外はメッセージに対象パスを含む**ので、同じ権限エラーでも文面は毎回変わる。
    // 文面の違いだけで見本を集めると、単一の原因が数百通ぶん繰り返しているだけの実行で
    // 毎回見本が付き、**別の異常が混ざっているかのように読める**
    readFailure.message = 'EACCES: permission denied'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await fetchDaysWithUnreadableCache(5)
    flushSuppressedCacheWarnings()

    expect(warn).toHaveBeenCalledWith('[nii-cache] 読めませんでした（EACCES）: ほかに4件')
    warn.mockRestore()
  })

  it('安全弁: 原因（エラーコード）が取れない異常は、文面が違えば見本を残す', async () => {
    // `code` が無いと鍵は `UNKNOWN` ひとつに集まる。件数だけにすると、**別の異常が
    // 1件目のメッセージの陰に隠れる** —— まさにこの間引きが起こしかねない握り潰し
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchOnce(row('uuid-1', '2016-04-14 21:28:06+09', '震度速報'))

    readFailure.code = undefined
    readFailure.message = '読み取りが中断されました'
    await fetchDayListing('20160414')
    readFailure.message = 'まったく別の異常'
    await fetchDayListing('20160415')
    flushSuppressedCacheWarnings()

    expect(warn).toHaveBeenCalledWith(
      '[nii-cache] 読めませんでした（UNKNOWN）: ほかに1件（ほかの文面: まったく別の異常）',
    )
    warn.mockRestore()
  })

  it('安全弁: 見本を打ち切ったことを伝える（並んだ数件で全部だと読ませない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchOnce(row('uuid-1', '2016-04-14 21:28:06+09', '震度速報'))

    readFailure.code = undefined
    // 1件目 + 見本の上限3件 + あふれる1件
    for (const [i, message] of ['異常1', '異常2', '異常3', '異常4', '異常5'].entries()) {
      readFailure.message = message
      await fetchDayListing(`2016041${i}`)
    }
    flushSuppressedCacheWarnings()

    expect(warn).toHaveBeenCalledWith(
      '[nii-cache] 読めませんでした（UNKNOWN）: ほかに4件（ほかの文面: 異常2 / 異常3 / 異常4 ほか）',
    )
    warn.mockRestore()
  })

  it('安全弁: 出したら数え直す（同じ件数を二度出さない）', async () => {
    readFailure.message = 'EACCES: permission denied'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await fetchDaysWithUnreadableCache(3)
    flushSuppressedCacheWarnings()
    warn.mockClear()
    flushSuppressedCacheWarnings()

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // **間引きは「誰かが最後に出す」ことを前提にしている。** その前提が守られているかを、
  // JSDoc の注意書きではなくここで機械的に見る（`scriptEntrypoints.test.ts` と同じ考え方）。
  // 新しいスクリプトがキャッシュ経由の取得を直接 import すると、その経路の2件目以降は
  // **件数すらどこにも現れない** —— まさにこの仕組みが防ごうとしている握り潰しに戻る。
  it('安全弁: キャッシュを通る取得を import してよいのは、要約を出す呼び出し元だけ', () => {
    // 要約（`flushSuppressedCacheWarnings`）を呼ぶ責任を負っているファイル
    const ALLOWED = ['localEarthquakeArchiveBuilder.ts']

    const offenders = readdirSync(SCRIPTS_DIR, { recursive: true, encoding: 'utf-8' })
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => !ALLOWED.includes(name.replace(/\\/g, '/')))
      .filter((name) => importsCachedFetchers(readFileSync(join(SCRIPTS_DIR, name), 'utf-8')))

    expect(offenders).toEqual([])
  })

  it('対照: 要約を出す責任のない取得（`fetchText`）の import は咎めない', () => {
    // キャッシュを通らないので要約とは無関係（`buildEewSection` が実際にこの形で使う）
    expect(importsCachedFetchers("import { fetchText } from './niiJmaXmlArchive'\n")).toBe(false)
  })

  it('安全弁: 名前空間 import・上位ディレクトリからの import・別モジュールとの同名も取り違えない', () => {
    // **どれも実際にすり抜け／誤検出した書き方。** 走査を素朴な1本の正規表現で書くと、
    // 検査が通っていること自体が「守られている」という誤った安心になる
    const ns = "import * as nii from './niiJmaXmlArchive'\nnii.fetchRawXml('x')\n"
    const fromSubDir = "import { fetchRawXml } from '../niiJmaXmlArchive'\n"
    const multiline = "import {\n  fetchRawXml,\n} from './niiJmaXmlArchive'\n"
    // 同名の関数を別モジュールから取っているだけ。`niiJmaXmlArchive` からはキャッシュを通らない取得しか使っていない
    const sameNameElsewhere =
      "import { fetchRawXml } from './someOtherHelper'\nimport { fetchText } from './niiJmaXmlArchive'\n"

    expect(importsCachedFetchers(ns)).toBe(true)
    expect(importsCachedFetchers(fromSubDir)).toBe(true)
    expect(importsCachedFetchers(multiline)).toBe(true)
    expect(importsCachedFetchers(sameNameElsewhere)).toBe(false)
  })

  it('安全弁: 再エクスポート・動的 import・1行に複数の文も取り違えない', () => {
    // **字面を追う作りで実際にすり抜けた3つ。** 構文解析へ替えた理由がこれ
    const starReExport = "export * from './niiJmaXmlArchive'\n"
    const namespaceReExport = "export * as nii from './niiJmaXmlArchive'\n"
    const namedReExport = "export { fetchRawXml } from './niiJmaXmlArchive'\n"
    const dynamic = "const nii = await import('./niiJmaXmlArchive')\n"
    const required = "const nii = require('./niiJmaXmlArchive')\n"
    // 1行に `;` で 2 文。`fetchRawXml` は別モジュール由来なので咎めない
    const twoOnOneLine =
      "import { fetchRawXml } from './someOtherHelper'; import { fetchText } from './niiJmaXmlArchive'\n"

    expect(importsCachedFetchers(starReExport)).toBe(true)
    expect(importsCachedFetchers(namespaceReExport)).toBe(true)
    expect(importsCachedFetchers(namedReExport)).toBe(true)
    expect(importsCachedFetchers(dynamic)).toBe(true)
    expect(importsCachedFetchers(required)).toBe(true)
    expect(importsCachedFetchers(twoOnOneLine)).toBe(false)
  })

  it('安全弁: `import x = require(...)` も咎める（`require` の呼び出し形とは別のノード）', () => {
    // 右辺は `CallExpression` ではないので、`require(...)` を拾う分岐だけでは素通りする
    const importEquals = "import nii = require('./niiJmaXmlArchive')\nnii.fetchRawXml('x')\n"
    // 型としてだけ別名を付けるのは実行時に何も起こさない
    const typeOnlyImportEquals = "import type nii = require('./niiJmaXmlArchive')\n"

    expect(importsCachedFetchers(importEquals)).toBe(true)
    expect(importsCachedFetchers(typeOnlyImportEquals)).toBe(false)
  })

  it('対照: 型だけの取り込みは咎めない（実行時に何も起こらない）', () => {
    // `NiiTelegramListItem` のような型を取るのは正当。**咎めると正しい書き方を塞ぐ**
    const typeOnlyClause = "import type { NiiTelegramListItem } from './niiJmaXmlArchive'\n"
    const typeOnlySpecifier = "import { type fetchRawXml } from './niiJmaXmlArchive'\n"
    const typeOnlyReExport = "export type * from './niiJmaXmlArchive'\n"
    const sideEffectOnly = "import './niiJmaXmlArchive'\n"

    expect(importsCachedFetchers(typeOnlyClause)).toBe(false)
    expect(importsCachedFetchers(typeOnlySpecifier)).toBe(false)
    expect(importsCachedFetchers(typeOnlyReExport)).toBe(false)
    expect(importsCachedFetchers(sideEffectOnly)).toBe(false)
  })

  it('安全弁: 別名で受けても元の名前で見る', () => {
    // `fetchRawXml as f` と書いても、使っているのはキャッシュを通る取得そのもの
    expect(importsCachedFetchers("import { fetchRawXml as f } from './niiJmaXmlArchive'\n")).toBe(true)
    expect(importsCachedFetchers("export { fetchRawXml as f } from './niiJmaXmlArchive'\n")).toBe(true)
    // 逆に、別モジュールの何かを `fetchRawXml` という名前で受けただけなら咎めない
    expect(importsCachedFetchers("import { fetchText as fetchRawXml } from './niiJmaXmlArchive'\n")).toBe(false)
  })

  it('対照: 不調が1件も無ければ何も出さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    flushSuppressedCacheWarnings()

    expect(warn).not.toHaveBeenCalled()
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
