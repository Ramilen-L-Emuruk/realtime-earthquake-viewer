import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { DATA_FETCH_TIMEOUT_MS } from './fetchJson'
import { GENERATED_DICT_FETCH_TIMEOUT_MS, mergeSpeechDicts } from './ttsGeneratedDict'
// 対象モジュールはここで一度読む。テスト本体の中で初めて読むと、初回の解決・変換が
// 1 件目の所要時間に丸ごと乗って時間切れになる（→ akamaiClock.test.ts 冒頭）。
import './ttsStationReadings'

async function freshModule() {
  vi.resetModules()
  return await import('./ttsStationReadings')
}

const SAMPLE = {
  _comment: 'テスト用',
  札幌北区太平: "サッポロキタクタイヘイ'",
  千歳市北栄: "チトセシホクエイ'",
}

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(relPath, 'utf8'))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('loadTtsStationReadings', { timeout: 15_000 }, () => {
  it('注記のキーを辞書へ入れない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const { loadTtsStationReadings, getTtsStationReadingsCache } = await freshModule()
    const dict = await loadTtsStationReadings()
    expect(dict).toEqual({
      札幌北区太平: "サッポロキタクタイヘイ'",
      千歳市北栄: "チトセシホクエイ'",
    })
    expect(getTtsStationReadingsCache()).toEqual(dict)
  })

  it('読み上げ本体を待たせないよう、生成データ共通より短いタイムアウトを使う', () => {
    // 取れなくても観測点名の誤読が残るだけ。ここで長く待つと読み上げがその分遅れる。
    expect(GENERATED_DICT_FETCH_TIMEOUT_MS).toBeLessThan(DATA_FETCH_TIMEOUT_MS)
  })

  it('200 でも中身が空なら失敗として扱う', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ _comment: '注記だけ' })))
    const { loadTtsStationReadings, getTtsStationReadingsCache } = await freshModule()
    await expect(loadTtsStationReadings()).rejects.toThrow('1 件も入っていません')
    // 失敗をキャッシュしない（次回リトライできる）
    expect(getTtsStationReadingsCache()).toBeNull()
  })

  it('値が文字列でなければ失敗として扱う', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ 札幌北区太平: 42 })))
    const { loadTtsStationReadings } = await freshModule()
    await expect(loadTtsStationReadings()).rejects.toThrow('文字列ではありません')
  })

  it('配列を渡されたら失敗として扱う', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([1, 2, 3])))
    const { loadTtsStationReadings } = await freshModule()
    await expect(loadTtsStationReadings()).rejects.toThrow('JSON オブジェクトではありません')
  })
})

describe('mergeSpeechDicts', () => {
  it('キーが衝突したら句区切り辞書を優先する', () => {
    // 句区切り辞書は人がアクセント核と句区切りを指定したもの。読みを聞いて直したくなったら
    // そちらへ足せば勝てる、という関係を保つ。
    const merged = mergeSpeechDicts({ 塙町塙: "ハナワマチ'ハナワ" }, { 塙町塙: "ハナワマチハナワ'" })
    expect(merged).toEqual({ 塙町塙: "ハナワマチ'ハナワ" })
  })

  it('片方だけあればそれをそのまま返す', () => {
    const base = { 佐渡: "サ'ド" }
    const stations = { 塙町塙: "ハナワマチハナワ'" }
    expect(mergeSpeechDicts(base, null)).toBe(base)
    expect(mergeSpeechDicts(null, stations)).toBe(stations)
    expect(mergeSpeechDicts(null, null)).toBeNull()
  })

  it('両方のキーを引ける', () => {
    const merged = mergeSpeechDicts({ 佐渡: "サ'ド" }, { 塙町塙: "ハナワマチハナワ'" })
    expect(Object.keys(merged ?? {}).sort()).toEqual(['佐渡', '塙町塙'])
  })
})

describe('実データの部分一致の安全性', () => {
  const readings = readJson('public/data/tts-station-readings.json') as Record<string, string>
  const phraseBreak = readJson('public/data/tts-phrase-break-dict.json') as
    Record<string, string> & { _standalone?: string[]; _terms?: string[] }
  const epicenters = readJson('public/data/tts-epicenter-accents.json') as Record<string, string>
  const names = Object.keys(readings).filter(key => !key.startsWith('_'))
  const stationCoords = readJson('public/data/station-coords.json') as {
    stations: Record<string, unknown>
    regionNames: string[]
  }
  /** 座標表にある全観測点名。**誤読の有無を問わない** —— 辞書に無い側も巻き込まれる。 */
  const allStationNames = [...new Set(
    Object.keys(stationCoords.stations).map(key => key.slice(key.indexOf('|') + 1)),
  )]

  /**
   * 実データの辞書を読み込ませたモジュールで、読み上げ文に対する一致を引く。
   *
   * `isStandaloneKey` はモジュール内のキャッシュだけを見るので、**実データで検査するには
   * 3 つの辞書を実際に読み込ませないといけない**（生成辞書のキーが単独語キーとして扱われるのは
   * 読み込み済みのときだけ）。
   */
  async function loadedMatch(text: string) {
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url)
      if (path.includes('tts-station-readings')) return okResponse(readings)
      if (path.includes('tts-epicenter-accents')) return okResponse(epicenters)
      return okResponse(phraseBreak)
    }))
    const stations = await import('./ttsStationReadings')
    const epi = await import('./ttsEpicenterAccents')
    const dict = await import('./ttsPhraseBreakDict')
    await stations.loadTtsStationReadings()
    await epi.loadTtsEpicenterAccents()
    const base = await dict.loadTtsPhraseBreakDict()
    const merged = mergeSpeechDicts(
      base, stations.getTtsStationReadingsCache(), epi.getTtsEpicenterAccentsCache(),
    )
    return dict.findPhraseBreakMatch(text, merged ?? {})
  }

  // 辞書のキーは読み上げ文の中で部分一致する。**衝突しうる面は 5 つある** —— 区域名・都道府県名、
  // 観測点名どうし、津波観測点名・予報区名、震央地名、そして手で書いた句区切り辞書のキー。
  // どれか 1 つでも抜けると、正しく読めていた地名が語中で切られる（そのうえ間まで挟まる）。
  it('観測点名が一次細分区域名・都道府県名の内部に現れない', () => {
    const prefs = new Set(
      Object.keys(stationCoords.stations).map(key => key.slice(0, key.indexOf('|'))),
    )
    const haystack = [...stationCoords.regionNames, ...prefs]
    const contained = names.filter(name => haystack.some(area => area.includes(name)))
    expect(contained).toEqual([])
  })

  it('別の観測点名の内部に現れても、長い側が選ばれる（辞書に無い側でも）', async () => {
    // 検査対象は**座標表の全観測点名**。辞書のキーどうしで探すと、`宮古島市下地` ⊂
    // `宮古島市下地島空港` のように「長い側が正しく読めるので未収録」の組を見落とす。
    // 観測点名は一律で単独語キーとして扱うので、直後が漢字なら短い側は一致しない。
    const pairs = names.flatMap(short => allStationNames
      .filter(long => long !== short && long.includes(short))
      .map(long => ({ short, long })))
    expect(pairs.length).toBeGreaterThan(0)  // 検査対象が無くなっていたら気づけるように
    for (const { short, long } of pairs) {
      const match = await loadedMatch(`${long}では、震度5弱以上と推定されますが、未入電です。`)
      expect(match?.key, `${short} ⊂ ${long}`).toBe(names.includes(long) ? long : undefined)
    }
  })

  it('句区切り辞書のキーが観測点名の語中を切らない', async () => {
    // `呉`（→ `呉市広`）のような短いキーが該当する。単独語キーへ移すか、観測点名の側が
    // 長い一致で勝つ形になっていること。
    const standalone = new Set(phraseBreak._standalone ?? [])
    const baseKeys = Object.keys(phraseBreak).filter(key => !key.startsWith('_'))
    const risky = baseKeys.flatMap(key => allStationNames
      .filter(name => name !== key && name.includes(key))
      .map(name => ({ key, name })))
    expect(risky.length).toBeGreaterThan(0)
    for (const { key, name } of risky) {
      const match = await loadedMatch(`${name}では、震度5弱以上と推定されますが、未入電です。`)
      // 観測点名の側が拾われるか、何も拾われない（＝エンジンの素の読みに任せる）のが正しい。
      // 短い句区切りキーが拾われた場合だけ失敗させる。
      const picked = match?.key
      expect(
        picked === name || picked === undefined || (standalone.has(key) && picked !== key),
        `${key} ⊂ ${name} で「${picked}」が選ばれた`,
      ).toBe(true)
    }
  })

  it('津波観測点名・津波予報区名の語中も切らない', async () => {
    // 同じ辞書が津波の読み上げにも掛かる。**そちらは名前の後ろへ「で」を読点なしで直に付ける**
    // （`ttsText.ts` の `observedHeightSuffix`）ので、観測点名が津波側の名前の内部に現れると
    // その読みを壊す。2026-09 時点で完全一致は 0 件、内包は
    // `中土佐町久礼` ⊂ `中土佐町久礼港` の 1 件だけ（直後が漢字なので境界判定で守られる）。
    const obs = readJson('public/data/tsunami-obs-coords.json') as
      Record<string, unknown> | { name?: string }[]
    const zones = readJson('public/data/tsunami-zones.json') as
      Record<string, unknown> | { name?: string }[]
    const namesOf = (data: Record<string, unknown> | { name?: string }[]) => Array.isArray(data)
      ? data.map(entry => entry.name).filter((name): name is string => !!name)
      : Object.keys(data)
    const haystack = [...namesOf(obs), ...namesOf(zones)]
    const risky = names.flatMap(name => haystack
      .filter(target => target !== name && target.includes(name))
      .map(target => ({ name, target })))
    expect(risky.length).toBeGreaterThan(0)
    for (const { name, target } of risky) {
      const match = await loadedMatch(`${target}で10センチの津波を観測しました。`)
      expect(match?.key, `${name} ⊂ ${target}`).not.toBe(name)
    }
  })

  it('単独語キーは単独で現れれば従来どおり一致する', async () => {
    // 語中で切らせないための境界判定が、本来の一致まで潰していないことの安全弁。
    const match = await loadedMatch('呉では、震度5弱以上と推定されますが、未入電です。')
    expect(match?.key).toBe('呉')
  })
})
