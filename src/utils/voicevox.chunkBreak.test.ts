// @vitest-environment jsdom
//
// チャンク末尾の句読点に間を持たせる処理のテスト。
//
// `splitIntoChunks` は句読点の**後ろ**で割るので、句読点は必ずチャンクの末尾に来る。この位置の
// 句読点に VOICEVOX は `pause_mora` を付けず（後ろに何も続かないため）、チャンクは隙間なく
// 詰めて鳴らすため、補わないと読点・句点が音にならない。地名を読点で並べても一続きに聞こえる、
// というのがこれで起きていた症状（辞書に載っている地名の後だけは DICT_TRAILING_PAUSE で間が
// 入るため、そこだけ区切って聞こえて不均一になる）。
//
// ここで固定するのは 3 点。
//   正 : 後続のチャンクがあるとき、末尾の句読点に間が入る（読点・句点の両方）
//   対照: 最後のチャンクには入らない（読み終わりの無音が伸びて次の読み上げが遅れる）
//   安全弁: 辞書地名がチャンク末尾に来ても間は二重にならない（辞書側の値を置き換える）
//
// 合成の入口は 3 つ（`prewarmVoicevox`／再生側の先頭チャンク作り直し／ループ内の先行合成）で、
// **間を入れるかどうかは呼び出し側が渡す引数で決まる**。渡し忘れると黙って「間なし」に倒れ、
// 直したはずの症状へ静かに戻るため、`prewarmVoicevox` 経由の経路も個別に固定する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { prewarmVoicevox, speakWithVoicevox, splitIntoChunks } from './voicevox'

// 辞書は既定で使わない。安全弁のテストだけ findPhraseBreakMatch を差し替える。
const dictState: { key: string | null } = { key: null }
vi.mock('./ttsPhraseBreakDict', () => ({
  loadTtsPhraseBreakDict: async () => (dictState.key ? { [dictState.key]: 'テ,スト' } : null),
  getTtsPhraseBreakDictCache: () => (dictState.key ? { [dictState.key]: 'テ,スト' } : null),
  findPhraseBreakMatch: (text: string) => {
    if (!dictState.key) return null
    const index = text.indexOf(dictState.key)
    return index < 0 ? null : { key: dictState.key, index }
  },
  isPlaceNameKey: () => true,
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
    // 完了待ちを即座に解決させる（実際の再生時間は待たない）
    addEventListener: vi.fn((_ev: string, cb: () => void) => { cb() }),
  }),
}
vi.mock('./alertSound', () => ({
  getAudioContext: () => fakeCtx,
  getMasterInput: () => ({ connect: vi.fn() }),
}))

type Mora = { vowel: string; vowel_length: number }
type Phrase = { moras: Mora[]; pause_mora: Mora | null }

/** /synthesis へ送られた accent_phrases を、リクエスト順に記録する。 */
let sentPhrases: Phrase[][] = []

/**
 * /audio_query は「テキスト 1 つにつきアクセント句 1 つ」を返す代役。
 * 実物と同じく、末尾の句読点には pause_mora を付けない（これが補正の対象）。
 * 句読点だけのテキストは実物と同じく空配列で返す。
 */
function installFetch() {
  sentPhrases = []
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (/audio_query|accent_phrases/.test(url)) {
      const text = new URL(url).searchParams.get('text') ?? ''
      const bare = text.replace(/[。、！？]/g, '')
      const phrases: Phrase[] = bare === ''
        ? []
        : [{ moras: [{ vowel: 'a', vowel_length: 0.1 }], pause_mora: null }]
      return {
        ok: true,
        json: async () => (/accent_phrases/.test(url) ? phrases : { accent_phrases: phrases }),
      } as unknown as Response
    }
    if (/mora_data/.test(url)) {
      // 引き直しは長さと音高だけを返す。pause_mora は呼び出し側が元の値へ戻す。
      const body = JSON.parse(String(init?.body)) as Phrase[]
      return { ok: true, json: async () => body.map(p => ({ ...p, pause_mora: null })) } as unknown as Response
    }
    sentPhrases.push((JSON.parse(String(init?.body)) as { accent_phrases: Phrase[] }).accent_phrases)
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Response
  }) as unknown as typeof fetch
}

/** 各チャンクの「最後のアクセント句に付いた無音の長さ」（無ければ null）。 */
function trailingPauses(): (number | null)[] {
  return sentPhrases.map(ps => {
    const last = ps[ps.length - 1]
    return last?.pause_mora ? last.pause_mora.vowel_length : null
  })
}

beforeEach(() => {
  dictState.key = null
  installFetch()
})
afterEach(() => { vi.restoreAllMocks() })

describe('チャンク末尾の句読点の間', () => {
  it('読点で並べた地名は、最後を除く全チャンクの末尾に間が入る', async () => {
    const text = '震度5弱を新潟県上越、新潟県下越、新潟県佐渡で観測しました。'
    expect(splitIntoChunks(text)).toHaveLength(3)

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 前 2 つ（読点で終わる）には間が入り、最後（句点で終わる）には入らない
    expect(trailingPauses()).toEqual([0.11, 0.11, null])
  })

  it('句点で終わるチャンクにも間が入る（後続がある場合）', async () => {
    const text = '震度速報。最大震度5弱です。'
    expect(splitIntoChunks(text)).toEqual(['震度速報。', '最大震度5弱です。'])

    await speakWithVoicevox('http://vv', text, 0, 1)

    expect(trailingPauses()).toEqual([0.11, null])
  })

  it('チャンクが 1 つだけなら間は入らない（読み終わりの無音を伸ばさない）', async () => {
    await speakWithVoicevox('http://vv', '最大震度5弱です。', 0, 1)

    expect(sentPhrases).toHaveLength(1)
    expect(trailingPauses()).toEqual([null])
  })

  it('辞書地名がチャンク末尾に来ても間は二重にならず、句読点ぶんに置き換わる', async () => {
    dictState.key = '新潟県上越'
    const text = '震度5弱を新潟県上越、新潟県佐渡で観測しました。'
    expect(splitIntoChunks(text)).toHaveLength(2)

    await speakWithVoicevox('http://vv', text, 0, 1)

    // 1 つめのチャンクは「震度5弱を」＋辞書地名。辞書の間（0.12）ではなく句読点の間（0.11）が残る
    expect(trailingPauses()).toEqual([0.11, null])
    // 辞書由来の句が確かに前段に居ること（末尾の句だけが置き換わっている）
    expect(sentPhrases[0].length).toBeGreaterThan(1)
  })

  it('先行合成した最初のチャンクにも間が入り、そのまま再生に使われる', async () => {
    const text = '震度5弱を新潟県上越、新潟県下越で観測しました。'
    expect(splitIntoChunks(text)).toHaveLength(2)

    const prewarmed = prewarmVoicevox('http://vv', text, 0)
    expect(prewarmed).not.toBeNull()
    await prewarmed!.first
    // 先行合成の時点で 1 チャンク目が送られ、後続があるので間が入っている
    expect(trailingPauses()).toEqual([0.11])

    await speakWithVoicevox('http://vv', text, 0, 1, undefined, prewarmed)

    // 作り直しは起きず、2 チャンク目（最後なので間なし）だけが追加で送られる
    expect(trailingPauses()).toEqual([0.11, null])
  })

  it('チャンクが 1 つだけなら先行合成でも間は入らない', async () => {
    const prewarmed = prewarmVoicevox('http://vv', '最大震度5弱です。', 0)
    expect(prewarmed).not.toBeNull()
    await prewarmed!.first

    expect(trailingPauses()).toEqual([null])
  })
})
