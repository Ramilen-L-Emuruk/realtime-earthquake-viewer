import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { DATA_FETCH_TIMEOUT_MS } from './fetchJson'
import { GENERATED_DICT_FETCH_TIMEOUT_MS, mergeSpeechDicts } from './ttsGeneratedDict'
import { findPhraseBreakMatch } from './ttsPhraseBreakDict'
// 対象モジュールはここで一度読む（テスト本体の中で初めて読むと、初回の解決・変換が
// 1 件目の所要時間に丸ごと乗って時間切れになる）。
import './ttsEpicenterAccents'

async function freshModule() {
  vi.resetModules()
  return await import('./ttsEpicenterAccents')
}

const SAMPLE = {
  _comment: 'テスト用',
  宮古島近海: "ミヤコジマ'/キンカイ'",
  能登半島沖: "ノトハントウ'/オキ'",
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

describe('loadTtsEpicenterAccents', { timeout: 15_000 }, () => {
  it('注記のキーを辞書へ入れない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const { loadTtsEpicenterAccents, getTtsEpicenterAccentsCache } = await freshModule()
    const dict = await loadTtsEpicenterAccents()
    expect(dict).toEqual({
      宮古島近海: "ミヤコジマ'/キンカイ'",
      能登半島沖: "ノトハントウ'/オキ'",
    })
    expect(getTtsEpicenterAccentsCache()).toEqual(dict)
  })

  it('読み上げ本体を待たせないよう、生成データ共通より短いタイムアウトを使う', () => {
    expect(GENERATED_DICT_FETCH_TIMEOUT_MS).toBeLessThan(DATA_FETCH_TIMEOUT_MS)
  })

  it('200 でも中身が空なら失敗として扱う', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ _comment: '注記だけ' })))
    const { loadTtsEpicenterAccents, getTtsEpicenterAccentsCache } = await freshModule()
    await expect(loadTtsEpicenterAccents()).rejects.toThrow('1 件も入っていません')
    expect(getTtsEpicenterAccentsCache()).toBeNull()
  })
})

describe('実データの震央地名の句割り', () => {
  const epicenters = readJson('public/data/tts-epicenter-accents.json') as Record<string, string>
  const names = Object.keys(epicenters).filter(key => !key.startsWith('_'))
  const phraseBreak = readJson('public/data/tts-phrase-break-dict.json') as Record<string, string>

  it('値は句区切りを 1 つ持つ AquesTalk 風カナ', () => {
    // 句を割るのが目的なので、`/` が無い値は用を成さない。核は各句に 1 つずつ。
    const bad = names.filter(name => !/^[ァ-ヴ]+'\/[ァ-ヴ]+'$/.test(epicenters[name]))
    expect(bad).toEqual([])
  })

  it('値に長音記号を含まない', () => {
    // 長音記号は /accent_phrases?is_kana=true が受け付けない（400 UNKNOWN_TEXT）。
    expect(names.filter(name => epicenters[name].includes('ー'))).toEqual([])
  })

  it('観測点の読みとキーが衝突しない', () => {
    // 震央地名と観測点名は別の名前空間。衝突すると合成辞書でどちらが勝つかに依存してしまう。
    const stations = readJson('public/data/tts-station-readings.json') as Record<string, string>
    const stationNames = new Set(Object.keys(stations).filter(key => !key.startsWith('_')))
    expect(names.filter(name => stationNames.has(name))).toEqual([])
  })

  it('震央地名のキーが、別の名前の内部に現れない', () => {
    // 辞書のキーは読み上げ文の中で部分一致する。他の名前の語中に現れると、その読みを壊す。
    // 2026-09 時点で他の震央地名・観測点名・区域名・都道府県名のいずれに対しても 0 件
    // （生成辞書のキーは単独語キーとして扱うので境界判定でも守られるが、そもそも無いことを固定する）。
    const stationCoords = readJson('public/data/station-coords.json') as {
      stations: Record<string, unknown>
      regionNames: string[]
    }
    const stationNames = [...new Set(
      Object.keys(stationCoords.stations).map(key => key.slice(key.indexOf('|') + 1)),
    )]
    const prefs = [...new Set(
      Object.keys(stationCoords.stations).map(key => key.slice(0, key.indexOf('|'))),
    )]
    const haystack = [...names, ...stationNames, ...stationCoords.regionNames, ...prefs]
    const contained = names.flatMap(name => haystack
      .filter(target => target !== name && target.includes(name))
      .map(target => `${name} ⊂ ${target}`))
    expect(contained).toEqual([])
  })

  it('キーが完全に一致するものは、手で書いた句区切り辞書が勝つ', () => {
    // 誤読の手当てで既にエントリがある震央地名（渡島地方系・日本海系）が該当する。
    // 生成物に残っているのは、手書き側が消えたときに句割りが失われないための保険。
    const conflicts = names.filter(name => Object.prototype.hasOwnProperty.call(phraseBreak, name))
    expect(conflicts.length).toBeGreaterThan(0)
    const merged = mergeSpeechDicts(phraseBreak, epicenters)
    for (const name of conflicts) {
      expect(merged?.[name]).toBe(phraseBreak[name])
    }
  })

  it('手書きキーが震央地名の一部になっている組では、長い側（震央地名）が勝つ', () => {
    // **辞書の別が効くのは完全一致のときだけ。** 読み上げ文の中では「同じ位置なら長い方」で
    // 選ばれるので、`西表島`（手書き）と `西表島付近`（生成物）では後者が勝つ。これは意図した
    // 挙動 —— 短い側を当てると「ジマ」の後に間が入って「付近」が孤立する。
    // 単独語キー（`_standalone`）は境界判定で弾かれるので、ここでは非 standalone だけを見る。
    const standalone = new Set(
      (phraseBreak as { _standalone?: string[] })._standalone ?? [],
    )
    const baseKeys = Object.keys(phraseBreak)
      .filter(key => !key.startsWith('_') && !standalone.has(key))
    const nested = baseKeys.flatMap(key => names
      .filter(name => name !== key && name.startsWith(key))
      .map(name => ({ key, name })))
    expect(nested.length).toBeGreaterThan(0)   // 検査対象が無くなっていたら気づけるように
    for (const { key, name } of nested) {
      const merged = mergeSpeechDicts(phraseBreak, epicenters) ?? {}
      const match = findPhraseBreakMatch(`${name}で地震。`, merged)
      // 完全一致のキーが手書き側にもある場合（渡島地方北部 等）は、そちらが同じキーで勝つ。
      expect(match?.key, `${key} ⊂ ${name}`).toBe(name)
    }
  })
})
