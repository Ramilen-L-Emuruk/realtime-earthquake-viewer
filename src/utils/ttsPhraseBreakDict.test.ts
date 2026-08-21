import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { DATA_FETCH_TIMEOUT_MS } from './fetchJson'
import { DICT_FETCH_TIMEOUT_MS } from './ttsPhraseBreakDict'

// この辞書のローダは読み上げ本体（speakWithVoicevox）が取得を待つため、
// 生成データ共通の 60 秒ではなく短いタイムアウトを使う。その差が保たれているかを検証する。

async function freshModule() {
  vi.resetModules()
  return await import('./ttsPhraseBreakDict')
}

const SAMPLE = {
  _comment: 'テスト用',
  _terms: ['深発地震'],
  能登地方: 'ノトチホー',
  深発地震: 'シンパツジシン',
}

// 単独語キーの検証用。「佐渡」は単独で現れたときだけ一致させ、「佐渡市小木」は素の部分一致で拾う。
const STANDALONE_SAMPLE = {
  _comment: 'テスト用',
  _standalone: ['佐渡'],
  佐渡: "サ'ド",
  佐渡市小木: "サド'シ/オギ'",
  能登地方: 'ノトチホー',
}

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(relPath, 'utf8'))
}

function readDictData() {
  return readJson('public/data/tts-phrase-break-dict.json') as
    Record<string, string> & { _standalone?: string[] }
}

async function loadedStandaloneModule() {
  vi.stubGlobal('fetch', vi.fn(async () => okResponse(STANDALONE_SAMPLE)))
  const mod = await freshModule()
  const dict = await mod.loadTtsPhraseBreakDict()
  return { ...mod, dict }
}

/**
 * 実データの辞書ファイルをそのまま読み込んだモジュールを返す。
 * `isStandaloneKey` が見るのはモジュール内のキャッシュだけなので、実データを検証するテストは
 * 実ファイルから読ませないと「テスト用フィクスチャの _standalone」を検証してしまう。
 */
async function loadedRealDictModule() {
  vi.stubGlobal('fetch', vi.fn(async () => okResponse(readDictData())))
  const mod = await freshModule()
  const dict = await mod.loadTtsPhraseBreakDict()
  return { ...mod, dict }
}

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

/** signal が abort されるまで解決しない fetch（応答が返らない回線の再現）。 */
function hangingFetch(init?: { signal?: AbortSignal }) {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// resetModules ＋動的 import の再評価コストで既定タイムアウトを割ることがある（理由は prefectures.test.ts）。
describe('loadTtsPhraseBreakDict', { timeout: 15_000 }, () => {
  it('取得に成功すると _comment / _terms を除いた辞書を返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(SAMPLE)))
    const { loadTtsPhraseBreakDict, isPlaceNameKey } = await freshModule()

    const dict = await loadTtsPhraseBreakDict()

    expect(dict).toEqual({ 能登地方: 'ノトチホー', 深発地震: 'シンパツジシン' })
    // _terms に載っているものは地名ではない（読み上げ後のポーズを付けない側）
    expect(isPlaceNameKey('能登地方')).toBe(true)
    expect(isPlaceNameKey('深発地震')).toBe(false)
  })

  it('読み上げを長く止めないよう、生成データ共通より短い専用の値で打ち切る', async () => {
    expect(DICT_FETCH_TIMEOUT_MS).toBeLessThan(DATA_FETCH_TIMEOUT_MS)

    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { signal?: AbortSignal }) => hangingFetch(init)),
    )
    const { loadTtsPhraseBreakDict } = await freshModule()

    let settled = false
    const p = loadTtsPhraseBreakDict().catch(() => { settled = true })

    // 時間ちょうどまでは待つ（早すぎる打ち切りで正常な取得を殺していないこと）
    await vi.advanceTimersByTimeAsync(DICT_FETCH_TIMEOUT_MS - 1)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(settled).toBe(true)
  })

  it('タイムアウト後に呼び直すと再取得する', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => hangingFetch(init))
      .mockResolvedValueOnce(okResponse(SAMPLE))
    vi.stubGlobal('fetch', fetchMock)
    const { loadTtsPhraseBreakDict, getTtsPhraseBreakDictCache } = await freshModule()

    const assertion = expect(loadTtsPhraseBreakDict()).rejects.toThrow(
      `tts-phrase-break-dict fetch timed out after ${DICT_FETCH_TIMEOUT_MS}ms`,
    )
    await vi.advanceTimersByTimeAsync(DICT_FETCH_TIMEOUT_MS)
    await assertion
    expect(getTtsPhraseBreakDictCache()).toBeNull()

    expect(await loadTtsPhraseBreakDict()).toEqual({ 能登地方: 'ノトチホー', 深発地震: 'シンパツジシン' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// 短いキー（「佐渡」）は長い地名（「佐渡市小木」「新潟県佐渡」「佐渡付近」）の一部にもなる。
// VOICEVOX が正しく読める長い側を語中で切らないよう、_standalone のキーは単独出現だけに限る。
describe('findPhraseBreakMatch（単独語キー）', { timeout: 15_000 }, () => {
  it('単独で現れた単独語キーに一致する（文頭・読点の前・助詞の前）', async () => {
    const { findPhraseBreakMatch, dict } = await loadedStandaloneModule()

    expect(findPhraseBreakMatch('佐渡、佐渡市小木で10センチ', dict)).toEqual({ key: '佐渡', index: 0 })
    expect(findPhraseBreakMatch('佐渡に津波注意報が発表されています。', dict)).toEqual({ key: '佐渡', index: 0 })
    // 助詞（ひらがな・カタカナ）は地名の続きと見なさない。見なすと予報区名の読み上げで一致しなくなる。
    expect(findPhraseBreakMatch('また、佐渡で弱い津波', dict)).toEqual({ key: '佐渡', index: 3 })
  })

  it('前後が漢字なら地名の一部と見て一致しない', async () => {
    const { findPhraseBreakMatch, dict } = await loadedStandaloneModule()

    // どれも VOICEVOX が「サド」と正しく読む。切ると語中に間が入るだけ損をする
    expect(findPhraseBreakMatch('新潟県佐渡', dict)).toBeNull()
    expect(findPhraseBreakMatch('佐渡付近を震源とする', dict)).toBeNull()
    expect(findPhraseBreakMatch('佐渡沖', dict)).toBeNull()
  })

  it('地名の一部になっている出現を飛ばし、後方の単独出現を拾う', async () => {
    const { findPhraseBreakMatch, dict } = await loadedStandaloneModule()

    expect(findPhraseBreakMatch('新潟県佐渡で震度3、佐渡に津波注意報', dict)).toEqual({ key: '佐渡', index: 10 })
  })

  it('単独語キーが長い側の専用エントリを奪わない', async () => {
    const { findPhraseBreakMatch, dict } = await loadedStandaloneModule()

    // 「佐渡」は後続が「市」（漢字）なので除外され、長い側の読み仮名がそのまま使われる。
    // 同一位置での長さ比較（findPhraseBreakMatch のタイブレーク）はここまで来ずに決まる。
    expect(findPhraseBreakMatch('佐渡市小木で20センチ', dict)).toEqual({ key: '佐渡市小木', index: 0 })
  })

  it('拡張漢字や漢字扱いの記号が隣接しても地名の続きと見なす', async () => {
    const { findPhraseBreakMatch, dict } = await loadedStandaloneModule()

    // 拡張漢字（U+10000 以降）はサロゲートペア。前後 1 文字をコードポイント単位で取らないと
    // 片割れだけを見て「漢字でない」と誤判定する
    const extKanji = String.fromCodePoint(0x20000)
    expect(findPhraseBreakMatch(`${extKanji}佐渡`, dict)).toBeNull()
    expect(findPhraseBreakMatch(`佐渡${extKanji}`, dict)).toBeNull()
    // 々〇 は \p{Script=Han} に含まれる（明示的に足していないので、ここで固定しておく）
    expect(findPhraseBreakMatch('佐渡々', dict)).toBeNull()
    expect(findPhraseBreakMatch('〇佐渡', dict)).toBeNull()
    // 〆ヶヵ は Han に含まれないため明示的に足している
    expect(findPhraseBreakMatch('佐渡ヶ', dict)).toBeNull()
  })

  it('_standalone に無いキーは従来どおり語中でも一致する', async () => {
    const { findPhraseBreakMatch, isStandaloneKey, dict } = await loadedStandaloneModule()

    expect(isStandaloneKey('能登地方')).toBe(false)
    expect(findPhraseBreakMatch('石川県能登地方で震度4', dict)).toEqual({ key: '能登地方', index: 3 })
  })

  it('辞書データの _standalone は全て読み仮名エントリを持つ', () => {
    const data = readDictData()

    // 配列でないと new Set() が 1 文字ずつに分解し、単独語の指定が黙って壊れる
    expect(Array.isArray(data._standalone)).toBe(true)
    // 列挙だけして読み仮名を書き忘れると、単独語の指定が黙って無効になる
    for (const key of data._standalone ?? []) {
      expect(typeof data[key], `_standalone のキー「${key}」に読み仮名エントリが無い`).toBe('string')
    }
  })

  // 生成データ（区域名・予報区名・津波観測点名）の側が変わったときに気付けるようにする。
  // 合成した文字列だけで検証していると、観測点名が増減しても境界判定の当否が目視任せになる。
  it('実データの地名に対して単独出現だけを拾う', async () => {
    const { findPhraseBreakMatch, isStandaloneKey, dict } = await loadedRealDictModule()
    const data = readDictData()
    // 単独語キーだけを残した辞書で引く（他のキーに一致してしまうと単独語の判定を見られない）
    const realDict = Object.fromEntries(
      (data._standalone ?? []).map((key) => [key, dict[key]]),
    ) as Record<string, string>
    expect((data._standalone ?? []).every(isStandaloneKey)).toBe(true)

    const placeNames = new Set<string>([
      ...(readJson('public/data/subregions.json') as { name: string }[]).map((sr) => sr.name),
      ...Object.keys(readJson('public/data/prefectures.json') as Record<string, unknown>),
      ...Object.keys(readJson('public/data/tsunami-zones.json') as Record<string, unknown>),
      ...Object.keys(readJson('public/data/tsunami-obs-coords.json') as Record<string, unknown>),
    ])

    for (const key of data._standalone ?? []) {
      for (const name of placeNames) {
        const match = findPhraseBreakMatch(name, realDict)
        // 名前そのものが単独語キーのときだけ一致する。長い地名の一部なら一致してはいけない
        expect(match?.key === key, `「${name}」に対する「${key}」の一致判定`).toBe(name === key)
      }
    }
  })
})
