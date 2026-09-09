// @vitest-environment jsdom
//
// 読み上げ辞書の合成（`speechDict`）のテスト。
//
// 辞書は 2 つある —— 手で書いた句区切り辞書と、震度観測点名の読み（生成物）。**他の voicevox の
// テストはどれも観測点側を「未取得」にしてあるため、両方が揃った状態で合成が働く経路はここでしか
// 通らない。** 合成そのものの単体テストは `ttsStationReadings.test.ts`（`mergeSpeechDicts`）に
// あるので、ここで見るのは「合成した辞書が実際に合成へ渡っているか」と「片方が後から取れたときに
// 作り直されるか」（合成結果は参照比較でキャッシュしている）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// 対象モジュールはここで一度読む（テスト本体の中で初めて読むと、初回の解決・変換が 1 件目の
// 所要時間に丸ごと乗る）。**実際に使うのはテストごとに作り直したもの** —— 辞書のキャッシュは
// モジュール内に持つため、作り直さないと前のテストの取得結果が残る。
import './voicevox'

async function freshVoicevox() {
  vi.resetModules()
  const mod = await import('./voicevox')
  mod.__resetPhraseBreakCacheForTest()
  return mod
}

const PHRASE_BREAK_DICT = {
  _comment: 'テスト用',
  _standalone: [] as string[],
  石川県能登: "イシカワ'ケン/ノト'",
  // 観測点読み辞書と同じキー。**衝突したらこちらが勝つ**（人がアクセント核を指定したもの）。
  能登町柳田: "ノトチョウ'ヤナギダ",
}
const STATION_READINGS = {
  _comment: 'テスト用',
  能登町柳田: "ノトチョウヤナギダ'",
  輪島市門前町走出: "ワジマシモンゼンマチハシリデ'",
}

/** 観測点の読みを取得できるか。false のときは fetch が失敗する（未取得の状態を作る）。 */
let stationReadingsAvailable = true

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

/** `/accent_phrases?is_kana=true` へ渡ったカナ表記を、リクエスト順に記録する。 */
let kanaRequests: string[] = []

function installFetch() {
  kanaRequests = []
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('tts-phrase-break-dict.json')) {
      return { ok: true, json: async () => PHRASE_BREAK_DICT } as unknown as Response
    }
    if (url.includes('tts-station-readings.json')) {
      if (!stationReadingsAvailable) return { ok: false, status: 503 } as unknown as Response
      return { ok: true, json: async () => STATION_READINGS } as unknown as Response
    }
    if (url.includes('is_kana=true')) {
      kanaRequests.push(new URL(url).searchParams.get('text') ?? '')
      return {
        ok: true,
        json: async () => [{ moras: [{ text: 'ア', vowel: 'a', vowel_length: 0.1 }], pause_mora: null }],
      } as unknown as Response
    }
    if (/audio_query|accent_phrases/.test(url)) {
      const phrases = [{ moras: [{ text: 'ア', vowel: 'a', vowel_length: 0.1 }], pause_mora: null }]
      return {
        ok: true,
        json: async () => (/accent_phrases/.test(url) ? phrases : { accent_phrases: phrases }),
      } as unknown as Response
    }
    if (/mora_data/.test(url)) {
      const body = JSON.parse(String(init?.body)) as unknown[]
      return { ok: true, json: async () => body } as unknown as Response
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Response
  }) as unknown as typeof fetch
}

beforeEach(() => {
  stationReadingsAvailable = true
  installFetch()
})
afterEach(() => { vi.restoreAllMocks() })

describe('読み上げ辞書の合成', () => {
  it('観測点の読みも句区切り辞書と同じ経路で合成に渡る', async () => {
    const { speakWithVoicevox: speak } = await freshVoicevox()
    await speak('http://vv', '輪島市門前町走出では、震度5弱以上と推定されますが、未入電です。', 0, 1)

    expect(kanaRequests).toContain("ワジマシモンゼンマチハシリデ'")
  })

  it('句区切り辞書のキーも従来どおり引ける', async () => {
    const { speakWithVoicevox: speak } = await freshVoicevox()
    await speak('http://vv', '震度5弱を石川県能登で観測しました。', 0, 1)

    expect(kanaRequests).toContain("イシカワ'ケン/ノト'")
  })

  it('キーが衝突したら句区切り辞書の読みが使われる', async () => {
    const { speakWithVoicevox: speak } = await freshVoicevox()
    await speak('http://vv', '能登町柳田では、震度5弱以上と推定されますが、未入電です。', 0, 1)

    expect(kanaRequests).toContain("ノトチョウ'ヤナギダ")
    expect(kanaRequests).not.toContain("ノトチョウヤナギダ'")
  })

  it('観測点の読みが取れていなければ句区切り辞書だけで進む', async () => {
    const { speakWithVoicevox: speak } = await freshVoicevox()
    stationReadingsAvailable = false

    await speak('http://vv', '輪島市門前町走出では、震度5弱以上と推定されますが、未入電です。', 0, 1)

    // 観測点名の読みは効かない（誤読が残る）が、読み上げ自体は成立する
    expect(kanaRequests).toEqual([])
  })

  it('後から観測点の読みが取れたら、合成し直して引けるようになる', async () => {
    const { speakWithVoicevox: speak } = await freshVoicevox()
    // 合成結果は両キャッシュの参照でメモ化している。片方が後から解決したときに
    // 古い合成を返し続けると、その回以降ずっと観測点名の読みが効かない。
    stationReadingsAvailable = false
    const text = '輪島市門前町走出では、震度5弱以上と推定されますが、未入電です。'
    await speak('http://vv', text, 0, 1)
    expect(kanaRequests).toEqual([])

    stationReadingsAvailable = true
    await speak('http://vv', text, 0, 1)

    expect(kanaRequests).toContain("ワジマシモンゼンマチハシリデ'")
  })
})
