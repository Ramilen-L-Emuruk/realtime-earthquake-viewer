import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  OFFLINE_DATA_EXCLUDED,
  OFFLINE_DATA_FILES,
  OFFLINE_DATA_NETWORK_TIMEOUT_SECONDS,
  offlineDataCacheName,
  offlineDataCacheWillUpdate,
  offlineDataRuntimeCaching,
  offlineDataUrlPattern,
} from './offlineData'
import { GENERATED_DICT_FETCH_TIMEOUT_MS } from '../src/utils/ttsGeneratedDict'

const DATA_DIR = join('public', 'data')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
}

// 走査と読み込みはテスト本体ではなくここで行う（読み込みの待ちを 1 件目の所要時間へ
// 乗せないため。理由は CLAUDE.md「検証」節）。
const DATA_FILES = walk(DATA_DIR).map(p => relative(DATA_DIR, p).split(sep).join('/'))
const VITE_CONFIG = readFileSync('vite.config.ts', 'utf8')
const SRC_FILES = walk('src')
  .filter(p => /\.(ts|tsx)$/.test(p) && !/\.(test|probe\.test)\.tsx?$/.test(p))
  .map(p => ({ path: p, text: readFileSync(p, 'utf8') }))

function isExcluded(path: string): boolean {
  return OFFLINE_DATA_EXCLUDED.some(e => (e.path.endsWith('/') ? path.startsWith(e.path) : path === e.path))
}

/**
 * アプリが `public/data/` から読む先（ファイル名、またはディレクトリの頭）を src から拾う。
 * 拾う形は 2 つ —— `${import.meta.env.BASE_URL}data/<…>` と、生成辞書のローダへ渡すファイル名。
 * これ以外の組み立て方（`BASE_URL + 'data/…'`・`new URL(…)`・変数を挟む形）は拾わない。読み先を足すときは
 * この 2 形のどちらかで書くこと。
 */
function referencedDataPaths(): { path: string; ref: string }[] {
  const out: { path: string; ref: string }[] = []
  for (const f of SRC_FILES) {
    for (const m of f.text.matchAll(/BASE_URL\}data\/([^`'"$]*)/g)) {
      if (m[1] !== '') out.push({ path: f.path, ref: m[1] })
    }
    for (const m of f.text.matchAll(/createGeneratedDictLoader\s*(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/g)) {
      out.push({ path: f.path, ref: m[1] })
    }
  }
  return out
}

function isClassifiedRef(ref: string): boolean {
  if ((OFFLINE_DATA_FILES as readonly string[]).includes(ref)) return true
  // `data/hypocenter` のように末尾の `/` を付けずにディレクトリを指す書き方もある
  return isExcluded(ref) || isExcluded(`${ref}/`)
}

// 生成データを足したとき、控えるか控えないかを決めずに済ませると、オフラインでだけ
// その表示が欠ける。どちらかへ載せることを強制する。
describe('public/data の分類', () => {
  it('全ファイルが「控える」「控えない」のどちらかに載っている（足し忘れを落とす）', () => {
    const offline = new Set<string>(OFFLINE_DATA_FILES)
    const unclassified = DATA_FILES.filter(p => !offline.has(p) && !isExcluded(p))
    expect(unclassified).toEqual([])
  })

  it('両方に載っているファイルは無い', () => {
    expect(OFFLINE_DATA_FILES.filter(isExcluded)).toEqual([])
  })

  it('控える一覧のファイルはすべて実在する（消したのに一覧へ残っていない）', () => {
    expect(OFFLINE_DATA_FILES.filter(f => !existsSync(join(DATA_DIR, f)))).toEqual([])
  })

  it('アプリが読む先もすべてどちらかに載っている（public/data に無い名前で読みに行っていない）', () => {
    const refs = referencedDataPaths()
    // 拾えていることの検算（0 件だと「全部載っている」と区別が付かない）
    expect(refs.length).toBeGreaterThanOrEqual(OFFLINE_DATA_FILES.length)
    expect(refs.filter(r => !isClassifiedRef(r.ref))).toEqual([])
  })

  it('控える生成データはすべてアプリから読まれている（読まれないものを控える一覧に残していない）', () => {
    const refs = new Set(referencedDataPaths().map(r => r.ref))
    expect(OFFLINE_DATA_FILES.filter(f => !refs.has(f))).toEqual([])
  })

  it('控えない一覧の理由は空でない', () => {
    expect(OFFLINE_DATA_EXCLUDED.filter(e => e.reason.trim() === '')).toEqual([])
  })
})

describe('offlineDataUrlPattern', () => {
  const standard = offlineDataUrlPattern('/yuremado/')
  const dmdss = offlineDataUrlPattern('/yuremado/dmdss/')
  const origin = 'https://example.github.io'

  it('自分の配信パスの控える生成データに当たる（正）', () => {
    for (const f of OFFLINE_DATA_FILES) {
      expect(standard.test(`${origin}/yuremado/data/${f}`)).toBe(true)
      expect(dmdss.test(`${origin}/yuremado/dmdss/data/${f}`)).toBe(true)
    }
  })

  it('控えない生成データには当たらない（対照）', () => {
    expect(standard.test(`${origin}/yuremado/data/hypocenter/2024.json`)).toBe(false)
    expect(standard.test(`${origin}/yuremado/data/historical-archives/index.json`)).toBe(false)
    expect(standard.test(`${origin}/yuremado/data/test-scenarios/index.json`)).toBe(false)
    // 名前の一部だけが一致するもの（`.` を任意の 1 文字として扱っていない）
    expect(standard.test(`${origin}/yuremado/data/subregionsXjson`)).toBe(false)
    expect(standard.test(`${origin}/yuremado/data/subregions.json.bak`)).toBe(false)
  })

  it('standard 版の規則は DMDSS 版の取得に当たらない（安全弁 — 配信パスが包むため）', () => {
    expect(standard.test(`${origin}/yuremado/dmdss/data/subregions.json`)).toBe(false)
    expect(dmdss.test(`${origin}/yuremado/data/subregions.json`)).toBe(false)
  })

  it('一致は URL の途中から始まる（他オリジンの URL には Workbox が当てない形）', () => {
    // Workbox の RegExpRoute は他オリジンの URL を「先頭から一致したとき」だけ採る。
    // 規則が `/` から始まる限り `https://` から始まる href の先頭とは一致しない。
    const m = standard.exec(`${origin}/yuremado/data/subregions.json`)
    expect(m?.index).toBeGreaterThan(0)
  })
})

describe('offlineDataCacheName', () => {
  it('バリアントで名前が分かれる（同じオリジンで 2 つの版が同じ控えへ書かない）', () => {
    expect(offlineDataCacheName('standard')).not.toBe(offlineDataCacheName('dmdss'))
  })
})

describe('offlineDataRuntimeCaching', () => {
  it('NetworkFirst で、バリアントのキャッシュ名・時間切れ・検分を持つ', () => {
    const rule = offlineDataRuntimeCaching('/yuremado/dmdss/', 'dmdss')
    expect(rule.handler).toBe('NetworkFirst')
    expect(String(rule.urlPattern)).toBe(String(offlineDataUrlPattern('/yuremado/dmdss/')))
    expect(rule.options?.cacheName).toBe('generated-data-dmdss')
    expect(rule.options?.networkTimeoutSeconds).toBe(OFFLINE_DATA_NETWORK_TIMEOUT_SECONDS)
    expect(rule.options?.plugins?.[0]?.cacheWillUpdate).toBe(offlineDataCacheWillUpdate)
  })

  it('時間切れは読み上げ辞書の取得の時間切れより短い（安全弁 — 先に諦められて控えに落ちない）', () => {
    expect(OFFLINE_DATA_NETWORK_TIMEOUT_SECONDS * 1000).toBeLessThan(GENERATED_DICT_FETCH_TIMEOUT_MS)
  })

  it('vite.config.ts が規則をそのまま runtimeCaching へ渡している', () => {
    expect(VITE_CONFIG).toMatch(/^\s*offlineDataRuntimeCaching\(base, variant\),\s*$/m)
  })
})

describe('offlineDataCacheWillUpdate', () => {
  const json = (init: ResponseInit = {}) =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' }, ...init })

  it('200 の JSON は控える（正）', async () => {
    const res = json()
    expect(await offlineDataCacheWillUpdate({ response: res })).toBe(res)
  })

  it('200 でも HTML は控えない（対照 — 公衆無線 LAN のログイン画面で控えを上書きしない）', async () => {
    const res = new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    expect(await offlineDataCacheWillUpdate({ response: res })).toBeNull()
  })

  it('JSON 以外の型で配られても HTML でなければ控える（何も控えないまま黙って通らない）', async () => {
    const plain = new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } })
    expect(await offlineDataCacheWillUpdate({ response: plain })).toBe(plain)
    const none = new Response('{}', { status: 200 })
    none.headers.delete('content-type')
    expect(await offlineDataCacheWillUpdate({ response: none })).toBe(none)
  })

  it('200 以外は控えない（安全弁）', async () => {
    expect(await offlineDataCacheWillUpdate({ response: json({ status: 404 }) })).toBeNull()
    expect(await offlineDataCacheWillUpdate({ response: json({ status: 206 }) })).toBeNull()
  })

  it('リダイレクトされた応答は控えない', async () => {
    const res = json()
    Object.defineProperty(res, 'redirected', { value: true })
    expect(await offlineDataCacheWillUpdate({ response: res })).toBeNull()
  })

  it('外の変数を参照しない（Service Worker へ文字列として書き出されるため）', () => {
    // 見るのは本体だけ（関数名そのものは見出しに含まれる）
    const src = offlineDataCacheWillUpdate.toString()
    const body = src.slice(src.indexOf(')'))
    expect(body).not.toMatch(/OFFLINE_DATA|offlineData[A-Z]|import/)
  })
})
