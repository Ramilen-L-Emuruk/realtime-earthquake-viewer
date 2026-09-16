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

  // 読み仮名の記法そのものを検証する。**壊れていても静かに効かなくなるだけ**なので、
  // このテストが無いと気付けない。値が壊れていても取得・一致判定は成功し、VOICEVOX が 400
  // （ACCENT_NOTFOUND / ACCENT_TWICE / UNKNOWN_TEXT）を返しても `synthesizeChunk` は
  // 辞書適用前の accent_phrases で合成を続ける。つまり声は出て、誤読が直らないまま残る。
  it('辞書データの読み仮名は AquesTalk 風カナ記法として成立している', () => {
    const data = readDictData()

    for (const [key, value] of Object.entries(data)) {
      // `_comment`（文字列）・`_terms`・`_standalone`（配列）はメタ情報なので読み仮名ではない
      if (key.startsWith('_') || typeof value !== 'string') continue
      // 長音記号は is_kana=true で UNKNOWN_TEXT になる。長音は母音を直接書く
      // （「チョー」ではなく「チョウ」か「チョオ」。どちらも解釈され、辞書には両方の表記が入っている）
      expect(value.includes('ー'), `「${key}」の読み仮名に長音記号がある: ${value}`).toBe(false)
      // アクセント核は 1 つのアクセント句にちょうど 1 つ要る。0 個でも 2 個でも解釈できない
      for (const phrase of value.split('/')) {
        expect(
          (phrase.match(/'/g) ?? []).length,
          `「${key}」のアクセント句「${phrase}」のアクセント核の数`,
        ).toBe(1)
      }
    }
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
      // 震度観測点名（「県名|観測点名」の後半）。短い単独語キーが最も衝突しやすい相手がここにいる
      // （「宮古」に対する「宮古市田老」、「鳥羽」に対する「鳥羽市鳥羽」）。読み上げは観測点名を
      // 区域名へ丸めるため声にはならないが、境界判定の当否をここで固定しておく。
      ...Object.keys(
        (readJson('public/data/station-coords.json') as { stations: Record<string, unknown> }).stations,
      ).map((key) => key.split('|')[1]),
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

// 電文本文に出る語の読み。**誤読する形だけを、その語形のまま収録する**（→ audio-tts-spec.md §3
// 「何を収録するか」）。ここで固定するのは「一致してほしい形」と「一致してはいけない形」の対。
describe('電文本文の語（実データの辞書で引く）', { timeout: 15_000 }, () => {
  // 「方」は複合語の一部として頻出する。実電文 2287 通（2024-08-06〜22 と 2026-03-16〜09-16）を
  // 走査したところ、本文に現れた「方」は「地方」12 件・「方向」5 件・「一方」「南方」各 1 件に対し、
  // **「かた」と読むのは「地域の方は」だけ**だった。「方」単体を鍵にすると残りが全部壊れる。
  it('「方」は「地域の方は」の形でだけ一致する', async () => {
    const { findPhraseBreakMatch, dict } = await loadedRealDictModule()

    // 正: 南海トラフ地震臨時情報（調査中）の見出し文の形
    expect(
      findPhraseBreakMatch('南海トラフ地震で被害が想定される地域の方は、個々の状況に応じて', dict)?.key,
    ).toBe('地域の方は')

    // 対照: 「ほう」と読む用例（実電文から採った 5 種）には当たらない
    for (const text of [
      '関東地方から九州地方にかけての広い範囲',
      'この地震は、発震機構が東西方向に張力軸を持つ',
      '一方、千島海溝・日本海溝沿いでは',
      '和歌山県南方沖から四国沖にかけて',
      '津波の到達時刻は早いところ（沖縄県地方）で',
    ]) {
      expect(
        findPhraseBreakMatch(text, dict)?.key,
        `「${text}」に「地域の方は」が当たらないこと`,
      ).not.toBe('地域の方は')
    }

    // 安全弁: 「方」単体を鍵にしない。入れた瞬間に上の 5 種がすべて誤読へ倒れる
    expect(Object.keys(dict)).not.toContain('方')
  })

  // 「行」は語形で読みが変わる。実電文 2287 通の走査で本文に現れた形は
  // 「行って（います）」「行います」「行う」「行われます」「行動」「刊行物」で、**「いく」と読む
  // 用例は 1 件も無い**。そのうち**エンジンが誤読するのは「行って」だけ**（実測: `イッテ'`。
  // 他は `オコナイマ'ス`・`オコナウ'`・`オコナワレマ'ス`・`コオドオ'`・`カンコオブツ'` と正しい）。
  it('「行って」に一致し、他の語形は素通しする', async () => {
    const { findPhraseBreakMatch, dict } = await loadedRealDictModule()

    // 正: 実電文（南海トラフ地震臨時情報・関連解説情報の本文）の形
    expect(findPhraseBreakMatch('現在気象庁が調査を行っています', dict)?.key).toBe('行って')
    expect(findPhraseBreakMatch('地域判定会と一体となって検討を行っています', dict)?.key).toBe('行って')

    // 対照: 正しく読める語形には当たらない
    for (const text of [
      '地震活動を監視し、適宜情報発表を行います',
      '海水浴や磯釣り等を行う際は注意してください',
      'システムの保守点検が下記期間に行われます',
      '身の安全を守る行動を取ってください',
      '地震毎の震度観測は、定期刊行物をご覧願います',
    ]) {
      expect(findPhraseBreakMatch(text, dict)?.key, `「${text}」に「行って」が当たらないこと`)
        .not.toBe('行って')
    }
  })

  // 「浅部」だけが誤読される（実測: `アサ'ブ`）。隣り合って現れる「深部低周波地震」は
  // `シ'ンブ/テエシュウハジ'シン` と正しく読めるので、鍵を広げない。
  it('「浅部超低周波地震」に一致し、「深部低周波地震」は素通しする', async () => {
    const { findPhraseBreakMatch, dict } = await loadedRealDictModule()

    expect(
      findPhraseBreakMatch('日向灘及び九州地方南東沖で浅部超低周波地震を観測しています', dict)?.key,
    ).toBe('浅部超低周波地震')
    expect(
      findPhraseBreakMatch('プレート境界付近を震源とする深部低周波地震（微動）', dict)?.key,
    ).toBeUndefined()
  })

  // 「心配は」「影響は」「ものは」（名詞＋係助詞）と述語「ありません」が 1 アクセント句へ融合する
  // （実測: `シンパイワアリマセン` accent=9・10 モーラ）。読みそのものは正しいので誤読の判定には
  // 掛からないが、文節の切れ目が消えて一息に上がりきる抑揚になる。読点を挟めばエンジン自身も
  // `シンパイワ`（accent=5）と `アリマセン`（accent=4）に割るので、その形を辞書で固定する。
  //
  // 融合はエンジンの癖で**名詞を問わない**（「被害は」「変化は」「異常は」でも同じ）。それでも鍵を
  // 「はありません」へ広げてはいけない。広げると切り出されるのは係助詞から始まる「ワアリマセン」で、
  // 名詞から係助詞が剥がれて元より悪くなる。読み上げに乗る語形だけを、その形のまま収録する。
  //
  // 既知の限界: 鍵は部分一致なので「心配はありませんが、」のように後ろが続く形にも当たり、
  // 「アリマセン」と「ガ」が別の句へ割れる（この 3 つに固有の話ではなく、部分一致で切り出す鍵は
  // どれも同じ）。`public/data/historical-archives/*.json` と `src/data/*.json` を走査したところ、
  // 現れる「ありません」767 件はすべて句点で終わっており、この形は無い。
  it('「〜はありません」は名詞と述語の境界で割る', async () => {
    const { findPhraseBreakMatch, isPlaceNameKey, dict } = await loadedRealDictModule()

    // 正: 読み上げに乗る 3 つの形（津波区分「なし」／遠地地震の固定付加文／地震回数）
    expect(findPhraseBreakMatch('この地震による津波の心配はありません。', dict)?.key)
      .toBe('心配はありません')
    expect(findPhraseBreakMatch('この地震による日本への津波の影響はありません。', dict)?.key)
      .toBe('影響はありません')
    expect(findPhraseBreakMatch('このうち、震度1以上を観測したものはありません。', dict)?.key)
      .toBe('ものはありません')

    // 正: 津波区分「若干の海面変動」の文も同じ鍵で当たる（実電文にある「被害の心配はありません」）
    expect(
      findPhraseBreakMatch('この地震による若干の海面変動が予想されますが、被害の心配はありません。', dict)?.key,
    ).toBe('心配はありません')

    // 対照: 語形が崩れた出現には当たらない。鍵は「名詞＋係助詞＋述語」の形のまま持つ
    expect(findPhraseBreakMatch('津波の心配について', dict)?.key).toBeUndefined()
    expect(findPhraseBreakMatch('日本への津波の影響について', dict)?.key).toBeUndefined()
    expect(findPhraseBreakMatch('震度1以上を観測したものは1回です', dict)?.key).toBeUndefined()

    // 安全弁: 述語側だけを鍵にしない（上のコメントの理由で、入れた瞬間に 3 つとも悪化する）
    expect(Object.keys(dict)).not.toContain('ありません')
    expect(Object.keys(dict)).not.toContain('はありません')

    // 安全弁: 地名ではないので鍵の直後にポーズを挟まない（_terms に列挙する）
    for (const key of ['心配はありません', '影響はありません', 'ものはありません']) {
      expect(isPlaceNameKey(key), `「${key}」は地名ではない`).toBe(false)
    }
  })
})
