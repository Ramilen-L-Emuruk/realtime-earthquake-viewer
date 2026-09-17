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

  // 「津波警報等」はエンジンが 1 アクセント句へまとめ、核を 8 モーラ目（「ト」）へ置く
  // （`ツナミケエホオトオ[8]`）。「ケイホウ」で下がらないまま「トウ」が文中で最も高くなる。
  // 単独の「津波警報」は `ツナミケエホオ[4]` で正しく下がるので、崩れるのは「等」が付いた形だけ。
  // **誤読ではないので、読ませて聞き比べない限り気づけない。**
  //
  // **「等」単体は鍵にできない。** あの字は「など」「ひとしい」とも読み、「等級」の一部にもなる。
  // 語形を丸ごと鍵にする。
  //
  // **助詞込みの鍵（「津波警報等を」「津波警報等は」）は並べない。** 鍵の後ろで割れた助詞は
  // 1 モーラの独立した句になるが、`refineProsody`（voicevox.ts）の引き直しで通しと同じ高さまで
  // 下がる（実測は docs/spec/audio-tts-spec.md §3「何を収録するか」）。
  it('「津波警報等」は警報と「等」の境界で割る', async () => {
    const { findPhraseBreakMatch, isPlaceNameKey, dict } = await loadedRealDictModule()

    // 正: 読み上げに乗る 3 つの形（津波区分「警報等」／全解除／誤報取消。いずれも ttsText.ts）
    expect(findPhraseBreakMatch('現在津波警報等を発表中です。', dict)?.key).toBe('津波警報等')
    expect(findPhraseBreakMatch('津波警報等は全て解除されました。', dict)?.key).toBe('津波警報等')
    expect(findPhraseBreakMatch('津波警報等は誤って発表されたため取り消されました。', dict)?.key)
      .toBe('津波警報等')

    // 正: 値は 2 句のまま（「等」を別のアクセント句へ出す）。1 句へまとめない
    expect(dict['津波警報等']).toBe("ツナミケ'イホオ/ト'オ")

    // 対照: 「等」が付かない形には鍵を置かない（素の核がそのまま正しい）
    expect(findPhraseBreakMatch('現在津波警報を発表中です。', dict)?.key).toBeUndefined()
    expect(Object.keys(dict), '「津波警報」は鍵に入れない').not.toContain('津波警報')

    // 対照: 「大津波警報等」では左にある長い鍵が勝ち、「等」は後続側へ回る
    // （`オオツナミケ'イホオ` ＋ 独立句の「等」。こちらも 1 句への融合は起きない）
    expect(findPhraseBreakMatch('大津波警報等を発表中です。', dict)?.key).toBe('大津波警報')

    // 安全弁: 「等」だけを鍵にしない（「等級」にも「〜など」にも食い込む）
    expect(Object.keys(dict)).not.toContain('等')

    // 安全弁: 地名ではないので鍵の直後にポーズを挟まない（_terms に列挙する）
    expect(isPlaceNameKey('津波警報等'), '「津波警報等」は地名ではない').toBe(false)
  })

  // 日付も「17日」→ `ジュウ[2] | シチニチ[2]` のように 2 つのアクセント句へ割れる。ただし
  // **1 句へまとめてはいけない。** VOICEVOX は「核が 1 モーラ目なら頭高、2 モーラ目以降なら
  // 頭は低い」という規則で鳴らすので、`ニジュウ[1]`（頭高）で始まる語を 1 句へ繋いだ瞬間に
  // 頭が低くなる（実測: 186 件中 95 件で反転した）。**句の割り方はエンジンに任せ、核だけ直す。**
  //
  // 後半の核は末尾へ置く。単独の「N日」がどれも末尾核であることに合わせた
  // （`1日`=イチニチ[4]・`2日`=フツカ[3]・`9日`=ココノカ[4]）。
  //
  // **「1日」「0時」「0分」は誤読**（`イチニチ`・`ゼロジ`・`ゼロフン`）。日付の「1日」は「ついたち」。
  // **24日は鍵を置かない**（`ニジュウ[1] | ヨッカ[3]` で「ヨッカ」に「日」が溶けている）。
  // **時刻と裸の分も鍵を置かない** —— エンジンの核がそのまま正しい。
  it('日付は句の割り方を変えず、核だけ直す', async () => {
    const { findPhraseBreakMatch, isPlaceNameKey, dict } = await loadedRealDictModule()

    // 正: アプリが組む読み上げ文の形（ttsText の formatDayTime / formatCountSpanForSpeech）
    expect(findPhraseBreakMatch('17日3時10分頃、', dict)?.key).toBe('17日')
    expect(findPhraseBreakMatch('16日4時から', dict)?.key).toBe('16日')
    // 値は 2 句のまま（`/` で繋ぐ）。1 句へまとめない
    expect(dict['17日']).toContain('/')
    expect(dict['21日']).toContain('/')

    // 正: 分は「頃」「ころ」まで鍵に含める（切ると連濁が落ちて「ころ」に化ける）
    expect(findPhraseBreakMatch('3時27分頃、', dict)?.key).toBe('27分頃')
    expect(findPhraseBreakMatch('1時25分ころ、地震がありました', dict)?.key).toBe('25分ころ')

    // 対照: **曖昧な鍵は辞書に置かない。** 「1日」は日付なら「ついたち」、期間なら「いちにち」で
    // 読みが変わるが、辞書は文字列しか見ないので区別できない。アプリは `d.getDate()` から作って
    // いて日付だと確定しているので、生成側で読みへ直す（`ttsText` の `speakableDay`）
    expect(Object.keys(dict), '「1日」は辞書に置かない').not.toContain('1日')
    expect(findPhraseBreakMatch('今後1日程度は注意してください', dict)?.key).toBeUndefined()

    // 対照: エンジンの核がそのまま正しいものには鍵を置かない
    for (const key of ['24日', '14日', '20日', '30日', '2日', '17時', '23時', '27分', '3分']) {
      expect(Object.keys(dict), `「${key}」は鍵に入れない`).not.toContain(key)
    }

    // 安全弁: 地名ではないので鍵の直後にポーズを挟まない（_terms に列挙する）
    for (const key of ['0時', '0分', '17日', '27分頃']) {
      expect(isPlaceNameKey(key), `「${key}」は地名ではない`).toBe(false)
    }
  })

  // 「0時」「0分」は読みを直す鍵（ゼロジ→レイジ／ゼロフン→レイフン）。**2 文字の鍵なので
  // 長い語に食い込む** —— `10時` `20時` の 2 文字目、`10分`〜`50分` の 2 文字目にも現れる。
  // 前が数字なら弾かないと「イチ | レイジ」と読まれる（鍵を外して実際に再現した）。
  //
  // 後続でも絞る。「後」「間」が続く形で切ると、後続が独立した文として合成されて
  // `後` が `アト`、`間` が `アイダ` に化ける（実電文に「15分後」「1分間」がある）。
  it('裸の「0時」「0分」は前後で絞る', async () => {
    const { findPhraseBreakMatch, dict } = await loadedRealDictModule()

    // 正: 単体で現れたときは当てる（読み上げ文は `3日0時0分` の形を作る）
    expect(findPhraseBreakMatch('0時0分', dict)?.key).toBe('0時')
    expect(findPhraseBreakMatch('0分現在の、', dict)?.key).toBe('0分')

    // 安全弁: 長い語の 2 文字目には当てない。**2 桁の鍵にも同じガードが掛かる** ——
    // `117日` で `17日` を拾うと「イチ｜ジュウシチニチ」と数値そのものを割って読む
    expect(findPhraseBreakMatch('117日', dict)?.key).toBeUndefined()
    expect(findPhraseBreakMatch('127分頃、', dict)?.key).toBeUndefined()
    // 安全弁: 長い語の 2 文字目には当てない
    expect(findPhraseBreakMatch('10時、', dict)?.key).toBeUndefined()
    expect(findPhraseBreakMatch('20時5分', dict)?.key).toBeUndefined()
    expect(findPhraseBreakMatch('30分現在の、', dict)?.key).toBeUndefined()
    expect(findPhraseBreakMatch('50分、', dict)?.key).toBeUndefined()

    // 正: **アプリが組む文の形も見る。** 取消の読み上げは `12時0分に発表された…` を組む
    // （`ttsText` の eewCancelToText / earthquakeCancelToText）。後続の「に」は実電文の
    // 自由文には 1 件も無く、電文だけを走査していたときはこの形を取りこぼしていた
    expect(findPhraseBreakMatch('12時0分に発表された地震情報は取り消されました。', dict)?.key)
      .toBe('0分')
    expect(findPhraseBreakMatch('0時0分に発表された', dict)?.key).toBe('0時')

    // 既知の限界: 後続は見ない。「0分後」「0分間」で切ると後続が独立した文として合成され
    // `後` が `アト` に化けるが、**「0 分後」「0 分間」という言い方はしない**ので実害が無い。
    // 期間の用法を持つ鍵（「1日」）を辞書へ置かないことで、この判定は「前が数字か」だけで済む
  })

  // 分は読み上げ文では必ず「N分頃」の形で出る（ttsText が `${time}頃、` を組む）。ここも 2 句へ
  // 割れる（実測: `57分頃` → `ゴジュウ[3] | ナナフンゴロ[4]`）。型は「『分』の直後に核」で、
  // エンジンが 1 句で読めている `30分頃`（サンジュップンゴロ[6]）・`5分頃`（ゴフンゴロ[3]）と同じ。
  //
  // **「N分」だけを鍵にしてはいけない。** 鍵の位置で切ると後続の「頃」が別に合成されて連濁が落ち、
  // `ゴジュウナナフン | コロ` と「ころ」に化ける（実測）。だから「頃」まで鍵に含める。
  //
  // 気象庁が書いた文は「ころ」（ひらがな）で書かれる。そちらは連濁しないのが原文どおりなので、
  // 読みを変えずに句だけ繋ぐ鍵を別に持つ。
  it('分は「頃」まで鍵に含める', async () => {
    const { findPhraseBreakMatch, dict } = await loadedRealDictModule()

    // 正: アプリが組む形と、気象庁が書いた文（正規化後）の形
    expect(findPhraseBreakMatch('2時57分頃、', dict)?.key).toBe('57分頃')
    expect(findPhraseBreakMatch('1時25分ころ、地震がありました', dict)?.key).toBe('25分ころ')

    // 安全弁: 元から 1 句で読める分にも「頃」版が要る。`50分` の鍵が先に当たると
    // `ゴジュッ'プン` ＋「コロ」に切れて連濁が落ちる
    for (const key of ['0分頃', '10分頃', '20分頃', '30分頃', '40分頃', '50分頃']) {
      expect(Object.keys(dict), `「${key}」は連濁を落とさないために要る`).toContain(key)
    }
    expect(findPhraseBreakMatch('1時50分頃、', dict)?.key).toBe('50分頃')
    expect(findPhraseBreakMatch('1時0分頃、', dict)?.key).toBe('0分頃')

    // 対照: 1 桁の分は 1 句で読めるうえ `N分` の鍵も無いので、鍵を置かない
    for (const key of ['5分頃', '7分頃', '5分', '7分']) {
      expect(Object.keys(dict), `「${key}」は鍵に入れない`).not.toContain(key)
    }
  })


  // 裸の鍵（`0時` `0分`）が引ける位置は、実電文の自由文とアプリが組む文の両方から
  // 導く必要がある。**電文だけを走査していたときは取りこぼした** —— 取消の読み上げが組む
  // `12時0分に発表された…` の「に」は、実電文の自由文には 1 件も無かった。
  //
  // ここでは `ttsText.ts` を読んで「日時を埋めた直後の文字」を機械的に集め、そのすべてで鍵が
  // 引けることを確かめる。**新しいテンプレートを足して直後の文字が変わったら、ここが落ちる。**
  it('日時を埋めるテンプレートの直後の文字を、辞書が覆っている', async () => {
    const { findPhraseBreakMatch, dict } = await loadedRealDictModule()
    const src = readFileSync('src/utils/ttsText.ts', 'utf8')

    // `${time}頃、` `${formatted}に発表された…` のような形から、直後の 1 文字を集める
    const suffixes = new Set<string>()
    for (const m of src.matchAll(/\$\{(?:time|dayTime|formatted)\}([^`$\s{])/g)) suffixes.add(m[1])

    // 1 つも拾えなかったら失敗させる（正規表現が実装とずれた合図）
    expect(suffixes.size, 'ttsText.ts から日時テンプレートを拾えていない').toBeGreaterThan(0)

    for (const suffix of suffixes) {
      // 「頃」は `N分頃` の鍵が覆う（連濁を落とさないため「頃」まで鍵に含めてある）
      const expected = suffix === '頃' ? '0分頃' : '0分'
      expect(findPhraseBreakMatch(`0分${suffix}`, dict)?.key, `「0分${suffix}」が引けない`)
        .toBe(expected)
    }
  })
})
