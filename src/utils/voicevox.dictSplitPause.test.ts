// @vitest-environment jsdom
//
// 句区切り辞書での分割によって落ちた句読点を補う処理のテスト。
//
// `buildAccentPhrases` は辞書キーの前後を別々に `/audio_query` にかけるため、**断片の端に来た
// 句読点は音にならない**。チャンク末尾で起きていたのと同じことが、チャンクの内側でも起きていた。
// 実測（話者 6）: `audio_query("山形県、")` の pause_mora は null、`audio_query("、")` は空配列。
// 結果「山形県、新潟県上中下越」は間ゼロで一続きに聞こえていた（分割せず取れば 0.432 が付く）。
//
// 直し方は「落ちた位置に種を置き、`/mora_data` に文脈から引き直させる」。**種の値は通常使われない**
// （実測: 種を 0.01 にしても 0.11 にしても引き直し後は同じ 0.432）。そのため、ここで固定すべきは
// 「種の値」ではなく「引き直された値を採ったか、元の値へ戻したか」の**選び分け**になる。
//
// **落ちるのは句読点だけではない。空白も同じように落ちる。** 気象庁が書いた文を読むと必ず現れる
// （電文の改行を半角スペースへ直すため）。実測: 「…極めて大きな揺れ 波形、」を丸ごと読ませると
// 0.430 秒の間が入るが、辞書の「波形」で切り出すと 0 秒になる。
//
// 固定するのは 4 点。
//   正 : 分割で落ちた句読点の位置は、引き直された値を採る（前・後ろのどちらの断片でも）
//   正 : 空白の位置も同じように扱う（前・後ろのどちらの断片でも）
//   対照: 区切り文字を伴わない純粋な辞書境界は DICT_TRAILING_PAUSE のまま（引き直し値を採らない）
//   安全弁: チャンク末尾は CHUNK_BREAK_PAUSE の担当なので種を置かない（読み終わりの無音を伸ばさない）
//   安全弁: 空白はチャンク分割の集合には入れない（割らない位置に間だけが入ることを防ぐ）
//
// 併せて、引き直しが失敗したときに種が残ること（＝無音ではなく妥当な間へ倒れること）も固定する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { speakWithVoicevox, splitIntoChunks, __resetPhraseBreakCacheForTest } from './voicevox'
import { log } from './logger'

// 辞書の中身はテストごとに差し替える。
const dictState: { keys: string[]; terms: string[] } = { keys: [], terms: [] }
/** 辞書キーに対応するカナ表記（実物と同じく `/accent_phrases` へ渡る文字列）。 */
const kanaOf = (key: string) => `カナ:${key}`
// **実物を土台にして、差し替えるのは辞書の中身と引き当てだけ。** いま代役が覆っているのは
// `voicevox.ts` が使う export と同じ集合なので、丸ごと代役にしても症状は出ない。それでも実物を
// 土台にしておくのは、**次に `voicevox.ts` が別の export を使い始めたときに黙って壊れないため**
// —— 代役に無い export は undefined になり、例外で `synthesizeChunk` の catch へ落ちて
// **そのチャンクが無音で脱落する**（助詞の切り出しを別モジュールへ分ける前に実際に踏んだ形）。
vi.mock('./ttsPhraseBreakDict', async (importOriginal) => {
  // カナ表記はキーごとに変える。/accent_phrases へ渡るテキストがこれなので、
  // 「このキーは何句に分解されるか」を代役へ指示する手がかりに使う（multiPhrase）。
  const dict = () => Object.fromEntries(dictState.keys.map(k => [k, kanaOf(k)]))
  return {
    ...await importOriginal<typeof import('./ttsPhraseBreakDict')>(),
    loadTtsPhraseBreakDict: async () => dict(),
    getTtsPhraseBreakDictCache: () => (dictState.keys.length > 0 ? dict() : null),
    // 実物と同じ選び方（最初に現れる位置のもの・同位置なら長い方）
    findPhraseBreakMatch: (text: string) => {
      let best: { key: string; index: number } | null = null
      for (const key of dictState.keys) {
        const index = text.indexOf(key)
        if (index < 0) continue
        if (best == null || index < best.index || (index === best.index && key.length > best.key.length)) {
          best = { key, index }
        }
      }
      return best
    },
    isPlaceNameKey: (key: string) => !dictState.terms.includes(key),
  }
})

// 観測点の読みはこのテストの対象外。実物のままだと取得（と 5 秒のタイムアウト待ち）が走る。
// `mergeSpeechDicts` は純関数なので実物を使う。
vi.mock('./ttsStationReadings', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ttsStationReadings')>(),
  loadTtsStationReadings: async () => ({}),
  getTtsStationReadingsCache: () => null,
}))

// 震央地名の句割りも同様に対象外（実物のままだと取得とタイムアウト待ちが走る）。
vi.mock('./ttsEpicenterAccents', () => ({
  loadTtsEpicenterAccents: async () => ({}),
  getTtsEpicenterAccentsCache: () => null,
}))

const fakeCtx = {
  state: 'running' as AudioContextState,
  currentTime: 0,
  resume: vi.fn(async () => {}),
  decodeAudioData: vi.fn(async () => ({ duration: 0.4 }) as unknown as AudioBuffer),
  createGain: () => ({ gain: { value: 0 }, connect: vi.fn() }),
  createBufferSource: () => ({
    buffer: null as AudioBuffer | null,
    connect: vi.fn(),
    onended: null,
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener: vi.fn((_ev: string, cb: () => void) => { cb() }),
  }),
}
vi.mock('./alertSound', () => ({
  getAudioContext: () => fakeCtx,
  getMasterInput: () => ({ connect: vi.fn() }),
  syncKeepAlive: () => {},
}))

type Mora = { vowel: string; vowel_length: number }
type Phrase = { moras: Mora[]; pause_mora: Mora | null }

/** 引き直しで返す無音の長さ。実装のどの定数とも重ならない値にして、採否を一目で判別できるようにする。 */
const ESTIMATED = 0.99

let sentPhrases: Phrase[][] = []
/** 辞書エントリの取得（`/accent_phrases?is_kana=true`）へ渡したカナ表記。 */
let kanaRequests: string[] = []
/** /mora_data を失敗させるか（安全弁のテスト用）。 */
let moraDataFails = false
/**
 * 辞書エントリの取得（`is_kana=true`）を**例外で**終わらせるか（安全弁のテスト用）。
 * 非 200 応答（`buildAccentPhrases` が null を返す経路）とは別で、こちらは組み直しの途中で
 * 投げられる形を再現する。
 */
let dictFetchThrows = false
/**
 * 辞書エントリの取得を**割り込み（`AbortError`）で**終わらせるか（対照テスト用）。
 * 実装は割り込みだけ投げ直すので、上の `dictFetchThrows` とは通る枝が違う。
 */
let dictFetchAborts = false
/** /mora_data が `pause_mora` を落として返すか（200 応答のまま中身が期待外れになる場合）。 */
let moraDataDropsPause = false
/**
 * 複数のアクセント句に分解して返すテキスト（キーはテキスト、値は句数）。
 *
 * **実物では辞書キー 1 件が複数句になる**（カナ表記の `/` が句区切り。実測: `新潟県上中下越` は
 * `ニイガタ'ケン/ジョ'オチュウ/カエツ'` で 3 句）。1 句しか返さない代役だけで固めると、
 * 「配列の**末尾**に間を置く」つもりの実装が先頭や決め打ちの添字を触るようになっても気づけない。
 */
const multiPhrase = new Map<string, number>()

/**
 * VOICEVOX の代役。実物の要点だけを再現する。
 *  - /audio_query・/accent_phrases: テキスト 1 つにつきアクセント句 1 つ。**末尾の句読点には
 *    pause_mora を付けない**。句読点だけのテキストは空配列（これが今回の症状の源）
 *  - /mora_data: **既にある pause_mora だけ引き直す。無いところには作らない**（実測どおり）
 */
function installFetch() {
  sentPhrases = []
  kanaRequests = []
  moraDataFails = false
  dictFetchThrows = false
  dictFetchAborts = false
  moraDataDropsPause = false
  multiPhrase.clear()
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (/audio_query|accent_phrases/.test(url)) {
      const text = new URL(url).searchParams.get('text') ?? ''
      // 辞書エントリの取得（is_kana=true）だけ記録する。助詞を取り込めたかはここに現れる
      if (/is_kana=true/.test(url)) {
        kanaRequests.push(text)
        if (dictFetchThrows) throw new TypeError('代役: 辞書エントリの取得で例外')
        if (dictFetchAborts) throw new DOMException('代役: 割り込み', 'AbortError')
      }
      // **区切り文字しか無いテキストは、実物も 0 句を返す。** 句読点だけでなく空白も同じ
      // （実測・話者 6: `audio_query(" ")`・`audio_query("　")`・`audio_query("、")` はいずれも 0 句）。
      // ここで空白を残すと、辞書キーどうしが空白 1 つで隣り合ったときに代役だけが句を返し、
      // **実物では起こらない二重の間**をテストが許してしまう
      const bare = text.replace(/[。、！？\s]/g, '')
      const count = bare === '' ? 0 : multiPhrase.get(text) ?? 1
      const phrases: Phrase[] = Array.from({ length: count }, () => ({
        moras: [{ vowel: 'a', vowel_length: 0.1 }], pause_mora: null,
      }))
      return {
        ok: true,
        json: async () => (/accent_phrases/.test(url) ? phrases : { accent_phrases: phrases }),
      } as unknown as Response
    }
    if (/mora_data/.test(url)) {
      if (moraDataFails) return { ok: false, status: 500 } as unknown as Response
      const body = JSON.parse(String(init?.body)) as Phrase[]
      return {
        ok: true,
        json: async () => body.map(p => ({
          ...p,
          pause_mora: p.pause_mora && !moraDataDropsPause
            ? { vowel: 'pau', vowel_length: ESTIMATED }
            : null,
        })),
      } as unknown as Response
    }
    sentPhrases.push((JSON.parse(String(init?.body)) as { accent_phrases: Phrase[] }).accent_phrases)
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Response
  }) as unknown as typeof fetch
}

/** チャンクごとの「各アクセント句に付いた無音の長さ」（無ければ null）。 */
function pauses(): (number | null)[][] {
  return sentPhrases.map(ps => ps.map(p => (p.pause_mora ? p.pause_mora.vowel_length : null)))
}

beforeEach(() => {
  dictState.keys = []
  dictState.terms = []
  // 辞書エントリのキャッシュはモジュールに居座る。捨てないと、同じキーを別の句数で使うテストが
  // 実行順に依存して結果を変える（先に走った側の句数を掴む）
  __resetPhraseBreakCacheForTest()
  installFetch()
})
afterEach(() => { vi.restoreAllMocks() })

describe('辞書分割で落ちた句読点の間', () => {
  it('辞書キーの直前の読点は、引き直された間で復活する', async () => {
    dictState.keys = ['新潟県上中下越']
    const text = '山形県、新潟県上中下越、富山県で3メートル。'
    // 「山形県、」は 5 文字未満なので次と合体し、辞書キーがチャンクの内側に来る
    expect(splitIntoChunks(text)).toEqual(['山形県、新潟県上中下越、', '富山県で3メートル。'])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 1 句目（山形県）＝落ちていた読点の位置に引き直された間が入る
    // 2 句目（辞書キー）＝チャンク末尾なので CHUNK_BREAK_PAUSE
    expect(pauses()).toEqual([[ESTIMATED, 0.11], [null]])
  })

  it('辞書キーの直後の読点も、引き直された間で復活する（辞書の間 0.12 では足りない）', async () => {
    dictState.keys = ['佐渡']
    const text = '佐渡、富山県で3メートル。'
    // 「佐渡、」は 5 文字未満なので次と合体する
    expect(splitIntoChunks(text)).toEqual(['佐渡、富山県で3メートル。'])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 辞書キーの句に引き直された間が入る（DICT_TRAILING_PAUSE の 0.12 ではない）
    expect(pauses()).toEqual([[ESTIMATED, null]])
  })

  it('一般用語のキーでも、直後の読点は復活する', async () => {
    dictState.keys = ['大津波']
    dictState.terms = ['大津波']
    const text = '大津波、津波警報が発表されました。'
    expect(splitIntoChunks(text)).toEqual(['大津波、津波警報が発表されました。'])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 一般用語は句読点が無ければ間を入れない語だが、読点があるならその間は要る
    expect(pauses()).toEqual([[ESTIMATED, null]])
  })

  it('【対照】句読点も助詞も伴わない辞書境界は、引き直された間を採らない（0.12 のまま）', async () => {
    // 部分一致のキーが長い地名の中に当たる形（「三角町」の「三角」）。直後が漢字なので
    // 助詞として取り込めず、辞書境界の間がそのまま残る。
    dictState.keys = ['三角']
    const text = '三角町で震度3を観測しました。'
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 辞書キー＋「町で震度3を観測しました。」。辞書の短い間（0.12）が保たれる
    expect(pauses()).toEqual([[0.12, null]])
  })

  it('【安全弁】チャンク末尾の句読点には種を置かない（末尾の間は CHUNK_BREAK_PAUSE のまま）', async () => {
    dictState.keys = ['新潟県上中下越']
    const text = '新潟県上中下越、富山県で3メートル。'
    expect(splitIntoChunks(text)).toEqual(['新潟県上中下越、', '富山県で3メートル。'])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 引き直された値（0.99）ではなく、チャンク境界ぶんの足し分（0.11）が入る
    expect(pauses()).toEqual([[0.11], [null]])
  })

  it('【安全弁】最後のチャンクの末尾に引き直された長い無音を残さない', async () => {
    dictState.keys = ['新潟県上中下越']
    const text = '富山県、新潟県上中下越。'
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    const [first] = pauses()
    // 直前の読点は復活する。一方、末尾の句点は種を置かないので引き直し値が乗らない
    expect(first[0]).toBe(ESTIMATED)
    expect(first[first.length - 1]).not.toBe(ESTIMATED)
  })

  it('【安全弁】引き直しに失敗しても、間は無音ではなく種の値へ倒れる', async () => {
    dictState.keys = ['新潟県上中下越']
    const text = '山形県、新潟県上中下越、富山県で3メートル。'

    installFetch()
    moraDataFails = true
    await speakWithVoicevox('http://vv', text, 0, 1)

    // 種（SPLIT_PUNCT_PAUSE = 0.35）が残る。null に戻ると元の症状（間なし）に逆戻りする
    expect(pauses()[0][0]).toBe(0.35)
  })

  it('【安全弁】引き直しが 200 のまま間を返さなくても、種の値へ倒れる', async () => {
    dictState.keys = ['新潟県上中下越']
    const text = '山形県、新潟県上中下越、富山県で3メートル。'

    installFetch()
    // 非 200 でも句数不一致でもない「正常応答なのに中身が期待外れ」の場合。
    // 素直に採ると間が消え、元の症状へ静かに戻る
    moraDataDropsPause = true
    await speakWithVoicevox('http://vv', text, 0, 1)

    expect(pauses()[0][0]).toBe(0.35)
  })

  it('辞書キーが複数の句に分解されても、間は末尾の句だけに付く', async () => {
    dictState.keys = ['丁']
    installFetch()
    // 実物と同じく、辞書キー 1 件が 3 句に分解される状況を作る
    multiPhrase.set(kanaOf('丁'), 3)
    const text = '戊、丁、己で3メートル。'
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 句は 戊(1) + 丁(3) + 己(1) = 5 個。間が付くのは「戊」と「丁の 3 句目」だけで、
    // 丁の途中の句（添字 1・2）は触らない
    expect(pauses()).toEqual([[ESTIMATED, null, null, ESTIMATED, null]])
  })

  it('辞書キーが読点で 2 つ続いても、両方の間が復活する（位置の積み上げ）', async () => {
    dictState.keys = ['甲', '乙']
    installFetch()
    multiPhrase.set(kanaOf('甲'), 2)
    multiPhrase.set(kanaOf('乙'), 3)
    const text = '甲、乙、丙で3メートル。'
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 句は 甲(2) + 乙(3) + 丙(1) = 6 個。間が付くのは添字 1（甲の末尾）と 4（乙の末尾）。
    // 再帰の内側で見つけた位置を親がずらして積むので、ここがずれると別の句に間が付く
    expect(pauses()).toEqual([[null, ESTIMATED, null, null, ESTIMATED, null]])
  })

  it('【安全弁】後続の句が返らず種が末尾に来ても、引き直しの長い無音は採らない', async () => {
    dictState.keys = ['辛']
    installFetch()
    // 辞書キーの後ろに読点＋文字が続くのに、その断片から句が 1 つも返らない状況。
    // 種が配列の末尾に残るため、引き直し値（実物では 0.968 秒）を採ると読み終わりが伸びる
    multiPhrase.set('、庚、', 0)
    const text = '辛、庚、'
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    expect(pauses()).toEqual([[0.35]])
  })

  it('辞書キーの直前の空白も、引き直された間で復活する', async () => {
    dictState.keys = ['波形']
    dictState.terms = ['波形']
    // 気象庁の自由付加文の形。原文では改行で、読み上げ文へ直すときに半角スペースになる
    const text = '極めて大きな揺れ 波形を観測しました。'
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 句は「極めて大きな揺れ 」＋辞書キー＋「を観測しました。」。空白の位置に引き直された間が入る。
    // 一般用語なので辞書キー自身の後ろには間を入れない
    expect(pauses()).toEqual([[ESTIMATED, null, null]])
  })

  it('辞書キーの直後の空白も、引き直された間で復活する', async () => {
    dictState.keys = ['波形']
    dictState.terms = ['波形']
    const text = '波形 スペクトルを観測しました。'
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 前半が空なので句は 辞書キー＋「 スペクトルを観測しました。」の 2 つ。
    // 落ちるのは後半の先頭の空白だが、間を掛けられるのは辞書キーの側
    expect(pauses()).toEqual([[ESTIMATED, null]])
  })

  it('【安全弁】辞書キーが空白 1 つで隣り合っても、間は 1 つだけ', async () => {
    dictState.keys = ['波形', '深発地震']
    dictState.terms = ['波形', '深発地震']
    const text = '波形 深発地震を観測しました。'
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 内側の再帰では前半が空白 1 文字だけになる。**実物はそこへ句を返さない**ので掛ける先が
    // 無く、外側が辞書キーへ置いた 1 つだけが残る。空白を区切り文字へ足したことで初めて
    // 生まれる形（句読点ではチャンクが割れるのでこの並びにならない）
    expect(pauses()).toEqual([[ESTIMATED, null, null]])
  })

  it('【安全弁】空白ではチャンクを割らない', async () => {
    // 「落ちた区切りを補う」集合へ空白を足したが、**チャンク分割の集合は句読点のまま**。
    // 混ぜると、割れない位置に間だけが入るチャンクができる
    expect(splitIntoChunks('極めて大きな揺れ 波形を観測しました。')).toEqual(['極めて大きな揺れ 波形を観測しました。'])
  })
})

// 辞書キーの直後に続く助詞を、辞書の読みへ足して同じアクセント句に入れる処理のテスト。
//
// 取り込まないと、助詞は次の断片の先頭になって **1 モーラで自らアクセント核を持つ句**として鳴る
// （実測・話者 6: 「宮古で〜」の `デ` が `accent=1` の単独句）。日本語に附属語だけのアクセント句は
// 無いので、そこが繋ぎ目の違和感になる。`DICT_TRAILING_PAUSE` の 0.12 秒は「区切って言い直した」
// ように聞かせてそれを隠していたにすぎない。
//
// 固定するのは次の 6 点。
//   正 : 直後の助詞が読みへ足され、辞書境界の間（0.12）が入らない
//   正 : 「では」を「で」より先に当てる（最長一致）
//   対照: 直後が助詞でなければ読みへ足さず、間は 0.12 のまま
//   安全弁: 助詞の後ろの区切り文字の間は、従来どおり引き直された値で復活する
//   安全弁: 一般用語（`_terms`）のキーでも取り込む
//   安全弁: 同じキーでも助詞が違えば別に取得する（キャッシュキーに助詞を含める）
describe('辞書キーの直後の助詞を読みへ取り込む', () => {
  it('直後の「では」は読みへ足され、辞書境界の間は入らない', async () => {
    dictState.keys = ['能登町柳田']
    const text = '能登町柳田では、震度5弱以上と推定されますが、未入電です。'
    expect(splitIntoChunks(text)).toEqual([
      '能登町柳田では、', '震度5弱以上と推定されますが、', '未入電です。',
    ])

    await speakWithVoicevox('http://vv', text, 0, 1)

    expect(kanaRequests).toEqual([`${kanaOf('能登町柳田')}デワ`])
    // 助詞まで同じ句に入るので 0.12 は置かれない。残るのはチャンク末尾の足し分だけ
    expect(pauses()).toEqual([[0.11], [0.11], [null]])
  })

  it('直後の「で」も読みへ足す', async () => {
    dictState.keys = ['宮古']
    const text = '岩手県、宮古で到達を確認しました。'
    // 「岩手県、」は 5 文字未満なので次と合体し、辞書キーがチャンクの内側に来る
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    expect(kanaRequests).toEqual([`${kanaOf('宮古')}デ`])
    // 1 句目（岩手県）＝落ちていた読点の位置に引き直された間。2 句目（辞書キー＋助詞）＝間なし
    expect(pauses()).toEqual([[ESTIMATED, null, null]])
  })

  it('「では」を「で」より先に当てる（最長一致）', async () => {
    dictState.keys = ['宮古']
    // 「で」で切ってしまうと、残った「は」が独立したアクセント句になって元の症状に戻る
    await speakWithVoicevox('http://vv', '宮古では、震度5弱以上と推定されますが、未入電です。', 0, 1)

    expect(kanaRequests).toEqual([`${kanaOf('宮古')}デワ`])
  })

  it('【対照】直後が助詞でなければ読みへ足さない', async () => {
    // 部分一致のキーが長い地名の中に当たる形（「三角町」の「三角」）
    dictState.keys = ['三角']
    await speakWithVoicevox('http://vv', '三角町で震度3を観測しました。', 0, 1)

    expect(kanaRequests).toEqual([kanaOf('三角')])
  })

  it('【安全弁】助詞の後ろの区切り文字は、引き直された間で復活する', async () => {
    dictState.keys = ['宮古']
    const text = '宮古で、到達を確認しました。'
    // 「宮古で、」は 5 文字未満なので次と合体し、読点がチャンクの内側に来る
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 助詞を取り込んでも、その後ろの読点は落ちた区切りとして補う（種 → 引き直し）
    expect(pauses()).toEqual([[ESTIMATED, null]])
  })

  it('【安全弁】一般用語のキーでも助詞を取り込む', async () => {
    dictState.keys = ['深発地震']
    dictState.terms = ['深発地震']
    await speakWithVoicevox('http://vv', '深発地震を観測しました。', 0, 1)

    // 一般用語は元から間を置かない語だが、助詞が独立した句になる問題は同じなので取り込む
    expect(kanaRequests).toEqual([`${kanaOf('深発地震')}オ`])
    expect(pauses()).toEqual([[null, null]])
  })

  it('【安全弁】同じキーでも助詞が違えば別に取得する', async () => {
    dictState.keys = ['宮古']
    await speakWithVoicevox('http://vv', '岩手県、宮古で到達を確認しました。', 0, 1)
    await speakWithVoicevox('http://vv', '岩手県、宮古は欠測となっています。', 0, 1)

    // キャッシュキーに助詞を含めないと、2 回目が「デ」の結果を引いて「は」が消える
    expect(kanaRequests).toEqual([`${kanaOf('宮古')}デ`, `${kanaOf('宮古')}ワ`])
  })

  // 辞書の値が複数句（カナ表記の `/` が句区切り）のとき、助詞は末尾の句へ入って**句数は変わらない**
  // （3 辞書の全エントリ × 全助詞で実測）。下の 2 件は、その前提に乗っている `punctAt` の添字が
  // 句数によらず正しい位置を指すことを固めるもの。1 句しか返さない代役だけで固めると、
  // 決め打ちの添字へ書き換わっても気づけない。
  it('【安全弁】多句の辞書キーに助詞を取り込んでも、間は末尾の句だけに付く', async () => {
    dictState.keys = ['新潟県上中下越']
    multiPhrase.set(`${kanaOf('新潟県上中下越')}デ`, 3)
    const text = '新潟県上中下越で、富山県で3メートル。'
    expect(splitIntoChunks(text)).toEqual(['新潟県上中下越で、', '富山県で3メートル。'])

    await speakWithVoicevox('http://vv', text, 0, 1)

    expect(kanaRequests).toEqual([`${kanaOf('新潟県上中下越')}デ`])
    // 3 句のうち末尾だけにチャンク境界ぶんの間が付く（先頭・中間には付かない）
    expect(pauses()).toEqual([[null, null, 0.11], [null]])
  })

  it('【安全弁】辞書の組み直しで例外が出ても、チャンクは素の読みで鳴る', async () => {
    // **例外を `synthesizeChunk` の catch まで飛ばすと、そのチャンクが無音で脱落する**
    // （呼び出し側は `if (!buffer) continue`）。組み直しだけを諦めれば、読みが崩れても声は続く。
    dictState.keys = ['宮古']
    dictFetchThrows = true
    const text = '岩手県、宮古で到達を確認しました。'
    expect(splitIntoChunks(text)).toEqual([text])

    // **`console.warn` ではなく `log.warn` を見る。** 記録が残ることを固定したいのであって、
    // logger がどの出力先を使うかは別の話。**`mockRestore()` は記録も消す**ので呼ばない
    // （`afterEach` の `vi.restoreAllMocks()` が元へ戻す）。
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    await speakWithVoicevox('http://vv', text, 0, 1)

    // /synthesis へ 1 チャンク分が渡っている（0 件なら脱落している）
    expect(sentPhrases.length).toBe(1)
    // **記録も固定する。** 上の 1 行だけだと、catch の中身を消して例外を握り潰すだけの形に
    // 書き換えても通ってしまう。読みが崩れたことは聞くまで分からず画面にも出ないので、
    // 記録が消えたら気づく手立てが無くなる。
    // **この経路の記録は 30 秒に 1 回へ間引かれる**（`warnDictRebuildFailed`）。同じ形の
    // テストを増やすなら、2 つ目は記録を当てにできない。
    const rebuildWarnings = warn.mock.calls
      .map(c => c.join(' '))
      .filter(m => m.includes('辞書の組み直しで例外'))
    expect(rebuildWarnings.length).toBe(1)
  })

  it('【対照】割り込み（AbortError）は投げ直し、そのチャンクを鳴らさない', () => {
    // **中断は正常系。素の読みで合成を続けてはいけない。** 続けると、新しい読み上げへ切り替わった
    // のに古い文が読みだけ崩れた形で鳴る。組み直しの失敗としても記録しない —— 割り込みは読み上げの
    // 切替ごとに起きるので、記録すると本物の失敗が 30 秒の間引きに埋もれる。
    dictState.keys = ['宮古']
    dictFetchAborts = true
    const text = '岩手県、宮古で到達を確認しました。'

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    return speakWithVoicevox('http://vv', text, 0, 1).then(() => {
      // /synthesis へ渡っていない（＝素の読みで鳴らしていない）
      expect(sentPhrases.length).toBe(0)
      const rebuildWarnings = warn.mock.calls
        .map(c => c.join(' '))
        .filter(m => m.includes('辞書の組み直しで例外'))
      expect(rebuildWarnings).toEqual([])
    })
  })

  it('【安全弁】助詞と同じ字面で始まる辞書キーは、助詞として切り出さない', async () => {
    // 実データに 1 件ある（`にかほ市金浦`。先頭の `に` が助詞と同形）。剥がすと残りは辞書に無い
    // 形になり、**その名前の読みが二度と当たらない** —— 誤読を直すために置いた辞書が助詞 1 文字で
    // 無効化される。記録も残らないので聞くまで気づけない。
    dictState.keys = ['宮古', 'にかほ市金浦']
    const text = '宮古にかほ市金浦で到達を確認しました。'
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 「宮古」は助詞を取り込まず（直後が辞書キー）、「にかほ市金浦」は辞書の読みで引けている
    expect([...kanaRequests].sort()).toEqual(['カナ:にかほ市金浦デ', 'カナ:宮古'])
  })

  it('【安全弁】多句の辞書キーに助詞を取り込んでも、直前の区切りの位置は引き直し値を採る', async () => {
    dictState.keys = ['新潟県上中下越']
    multiPhrase.set(`${kanaOf('新潟県上中下越')}デ`, 3)
    const text = '山形県、新潟県上中下越で3メートル。'
    // 「山形県、」は 5 文字未満なので次と合体し、読点がチャンクの内側に来る
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // pre（山形県）へ置いた種が引き直される。辞書キーの 3 句には間が付かない
    expect(pauses()).toEqual([[ESTIMATED, null, null, null, null]])
  })
})
