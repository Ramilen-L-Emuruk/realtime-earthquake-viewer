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
// 固定するのは 3 点。
//   正 : 分割で落ちた句読点の位置は、引き直された値を採る（前・後ろのどちらの断片でも）
//   対照: 句読点を伴わない純粋な辞書境界は DICT_TRAILING_PAUSE のまま（引き直し値を採らない）
//   安全弁: チャンク末尾は CHUNK_BREAK_PAUSE の担当なので種を置かない（読み終わりの無音を伸ばさない）
//
// 併せて、引き直しが失敗したときに種が残ること（＝無音ではなく妥当な間へ倒れること）も固定する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { speakWithVoicevox, splitIntoChunks, __resetPhraseBreakCacheForTest } from './voicevox'

// 辞書の中身はテストごとに差し替える。
const dictState: { keys: string[]; terms: string[] } = { keys: [], terms: [] }
/** 辞書キーに対応するカナ表記（実物と同じく `/accent_phrases` へ渡る文字列）。 */
const kanaOf = (key: string) => `カナ:${key}`
vi.mock('./ttsPhraseBreakDict', () => {
  // カナ表記はキーごとに変える。/accent_phrases へ渡るテキストがこれなので、
  // 「このキーは何句に分解されるか」を代役へ指示する手がかりに使う（multiPhrase）。
  const dict = () => Object.fromEntries(dictState.keys.map(k => [k, kanaOf(k)]))
  return {
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
}))

type Mora = { vowel: string; vowel_length: number }
type Phrase = { moras: Mora[]; pause_mora: Mora | null }

/** 引き直しで返す無音の長さ。実装のどの定数とも重ならない値にして、採否を一目で判別できるようにする。 */
const ESTIMATED = 0.99

let sentPhrases: Phrase[][] = []
/** /mora_data を失敗させるか（安全弁のテスト用）。 */
let moraDataFails = false
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
  moraDataFails = false
  moraDataDropsPause = false
  multiPhrase.clear()
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (/audio_query|accent_phrases/.test(url)) {
      const text = new URL(url).searchParams.get('text') ?? ''
      const bare = text.replace(/[。、！？]/g, '')
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

  it('【対照】句読点を伴わない辞書境界は、引き直された間を採らない（0.12 のまま）', async () => {
    dictState.keys = ['宮崎県北部平野部']
    const text = '震度5弱を宮崎県北部平野部で観測しました。'
    expect(splitIntoChunks(text)).toEqual([text])

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 「震度5弱を」＋辞書キー＋「で観測しました。」。辞書の短い間（0.12）が保たれる
    expect(pauses()).toEqual([[null, 0.12, null]])
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
})
