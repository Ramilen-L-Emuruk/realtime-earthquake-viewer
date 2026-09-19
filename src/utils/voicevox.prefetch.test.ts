// 合成待ちの予算（段 A・F）と、投機的先行合成の制御（段 D）。
//
// **ここが守っているのは「長い文の後半が黙って落ちない」こと。** 症状は無音で、例外も
// 画面表示も出ない —— 録画を見返すまで気づけない種類の壊れ方なので、テストで固定する。
//
// 正・対照・安全弁の分担:
//   正   ＝ 鳴っている間は予算が減らず、合成が遅くても最後まで読む
//   対照 ＝ 鳴っていない間は従来どおり予算を消費する
//   安全弁＝ 1 音も鳴らないまま無応答なら、予算で見切る（宙吊りにしない）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  speakWithVoicevox, prefetchSpeechTexts, abortSpeechPrefetch,
  setSpeechSynthBudgetRelaxed, splitIntoChunks,
  __resetFixedPhrasesForTest, __resetSpeechPrefetchForTest, __resetAudioPlaybackStateForTest,
  SPEECH_SYNTH_BUDGET_MS, RECORDING_SYNTH_BUDGET_MS, PREFETCH_SYNTH_TIMEOUT_MS,
} from './voicevox'
import { __resetSpeechAudioCacheForTest, speechAudioCacheStats } from './speechAudioCache'

// 辞書は対象外（読みの補正が挟まると合成回数が増えて筋が追いにくい）
vi.mock('./ttsPhraseBreakDict', () => ({
  loadTtsPhraseBreakDict: () => Promise.resolve(null),
  getTtsPhraseBreakDictCache: () => null,
  findPhraseBreakMatch: () => null,
  isPlaceNameKey: () => false,
}))
vi.mock('./ttsStationReadings', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ttsStationReadings')>(),
  loadTtsStationReadings: () => Promise.resolve({}),
  getTtsStationReadingsCache: () => null,
}))
vi.mock('./ttsEpicenterAccents', () => ({
  loadTtsEpicenterAccents: async () => ({}),
  getTtsEpicenterAccentsCache: () => null,
}))

/**
 * 1 チャンクの再生時間。
 *
 * **長めに取る。** 「鳴っている間の待ち」を作るには、次のチャンクの合成が終わるまで
 * 前のチャンクが鳴り続けている必要がある（`isAudioPlaying` の猶予は 1 秒しかない）。
 */
const DUR_SEC = 5
let synthDelaysMs: number[] = []
let synthCallCount = 0

class FakeSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  startAt: number | null = null
  private listeners: (() => void)[] = []
  private endTimer: ReturnType<typeof setTimeout> | undefined
  connect() { /* 出力先は検証しない */ }
  addEventListener(_type: string, cb: () => void) { this.listeners.push(cb) }
  start(when: number) {
    this.startAt = when
    const remainMs = (when + (this.buffer?.duration ?? 0) - ctx.currentTime) * 1000
    this.endTimer = setTimeout(() => this.fireEnded(), Math.max(0, remainMs))
  }
  stop() { clearTimeout(this.endTimer); this.fireEnded() }
  private fireEnded() {
    this.onended?.()
    for (const l of this.listeners) l()
  }
}

let sources: FakeSource[] = []
let baseMs = 0
const ctx = {
  get currentTime() { return (Date.now() - baseMs) / 1000 },
  state: 'running',
  resume: () => Promise.resolve(),
  createGain: () => ({ gain: { value: 0 }, connect: () => {} }),
  createBufferSource: () => { const s = new FakeSource(); sources.push(s); return s },
  decodeAudioData: () => Promise.resolve({ duration: DUR_SEC, length: 120_000, numberOfChannels: 1 }),
}
vi.mock('./alertSound', () => ({
  getAudioContext: () => ctx,
  getMasterInput: () => ({}),
  syncKeepAlive: () => {},
}))

function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (!signal) return
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
}
function abortedNow(signal: AbortSignal | undefined): Promise<never> | null {
  return signal?.aborted ? Promise.reject(new DOMException('Aborted', 'AbortError')) : null
}

/** /synthesis を要求したチャンクのテキスト（順に記録する）。 */
let synthesizedTexts: string[] = []

function installFetch() {
  vi.stubGlobal('fetch', (url: string, init?: { body?: string; signal?: AbortSignal }) => {
    const aborted = abortedNow(init?.signal)
    if (aborted) return aborted
    const s = String(url)
    if (s.includes('/synthesis')) {
      const delay = synthDelaysMs[synthCallCount] ?? 0
      synthCallCount++
      return Promise.race([
        new Promise(resolve => {
          setTimeout(() => resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }), delay)
        }),
        rejectOnAbort(init?.signal),
      ])
    }
    if (s.includes('/audio_query')) {
      // 要求したテキストを控える（投機が何を焼いたかを見るため）
      const m = /text=([^&]*)/.exec(s)
      if (m) synthesizedTexts.push(decodeURIComponent(m[1]))
    }
    return Promise.race([
      Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
      rejectOnAbort(init?.signal),
    ])
  })
}

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}

/** 4 チャンクに割れる文。どの断片も 5 文字以上で、句点の直後で切れる。 */
const FOUR_CHUNKS = '石川県能登地方で地震がありました。震度7を観測しました。深さは16キロ。マグニチュードは7.6です。'

/**
 * もう 1 つの 4 チャンクの文。**{@link FOUR_CHUNKS} とチャンクを 1 つも共有しないこと。**
 * 共有すると控えが当たって、合成を待たせたい場面で待たずに鳴ってしまう。
 */
const OTHER_FOUR_CHUNKS = '宮城県沖で地震がありました。震度5弱を観測しました。深さは60キロ。マグニチュードは6.8です。'

beforeEach(() => {
  vi.useFakeTimers()
  baseMs = Date.now()
  sources = []
  synthDelaysMs = []
  synthCallCount = 0
  synthesizedTexts = []
  setSpeechSynthBudgetRelaxed(false)
  __resetFixedPhrasesForTest()
  __resetSpeechPrefetchForTest()
  __resetSpeechAudioCacheForTest()
  __resetAudioPlaybackStateForTest()
  installFetch()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('合成待ちの予算は、音が鳴っている間は減らない', () => {
  // 4 チャンク × 合成 3 秒 ＝ 待ちの合計 9 秒で、既定の予算（6 秒）を超える。
  // 1 チャンクの再生は 5 秒あるので、待っている間つねに前のチャンクが鳴っている。
  it('合成が遅くても、鳴り続けていれば最後のチャンクまで読む（正）', async () => {
    expect(splitIntoChunks(FOUR_CHUNKS)).toHaveLength(4)
    synthDelaysMs = [0, 3000, 3000, 3000]

    void speakWithVoicevox('http://vv', FOUR_CHUNKS, 1, 1)
    // 1 チャンク目が鳴り始め、以降は再生と並行して合成が進む
    await advance(30_000)

    expect(sources).toHaveLength(4)
  })

  // **対照。** 1 音も鳴らないうちから待たされる形では、従来どおり予算で見切る。
  // ここを残しておかないと「予算がどこでも効かない」に転んだとき気づけない。
  it('鳴り始める前の待ちは予算を消費する（対照）', async () => {
    // 1 チャンク目の合成が返らない。音が出ないまま待ち続ける形。
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => abortedNow(init?.signal)
      ?? (String(url).includes('/synthesis')
        ? Promise.race([new Promise(() => { /* 応答なし */ }), rejectOnAbort(init?.signal)])
        : Promise.race([
          Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
          rejectOnAbort(init?.signal),
        ])))

    let done = false
    void speakWithVoicevox('http://vv', FOUR_CHUNKS, 1, 1).then(() => { done = true })
    await advance(SPEECH_SYNTH_BUDGET_MS + 500)

    // 予算を使い切って完了している（チャンクごとの上限だけなら 4 × 5 = 20 秒かかる）
    expect(done).toBe(true)
    expect(sources).toHaveLength(0)
  })

  // **安全弁。** 音が途切れたら消費を再開する ―― つまり予算そのものは生きている。
  // ここが効かないと、VOICEVOX が無応答になったときに宙吊りが戻る。
  it('音が途切れたら消費を再開する（安全弁）', async () => {
    // 1 チャンク目だけ鳴り、2 チャンク目以降は応答が返らない。
    // 再生 5 秒 ＋ 猶予 1 秒を過ぎれば `isAudioPlaying()` は偽になり、予算が減り始める。
    let calls = 0
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => abortedNow(init?.signal)
      ?? (String(url).includes('/synthesis')
        ? (calls++ === 0
          ? Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })
          : Promise.race([new Promise(() => { /* 応答なし */ }), rejectOnAbort(init?.signal)]))
        : Promise.race([
          Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
          rejectOnAbort(init?.signal),
        ])))

    let done = false
    void speakWithVoicevox('http://vv', FOUR_CHUNKS, 1, 1).then(() => { done = true })
    // 再生 5 秒 + 猶予 1 秒 + 予算 6 秒 + 余白。無制限に待つ作りなら、ここでは終わらない。
    await advance(5000 + 1000 + SPEECH_SYNTH_BUDGET_MS + 2000)

    expect(done).toBe(true)
    expect(sources).toHaveLength(1)   // 鳴ったのは 1 チャンク目だけ
  })
})

describe('録画モードの予算', () => {
  // 録画は後で編集するので、間が空いても最後まで読み切るほうが価値がある。
  it('録画中は、鳴っていない待ちでも既定より長く粘る（正）', async () => {
    setSpeechSynthBudgetRelaxed(true)
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => abortedNow(init?.signal)
      ?? (String(url).includes('/synthesis')
        ? Promise.race([new Promise(() => { /* 応答なし */ }), rejectOnAbort(init?.signal)])
        : Promise.race([
          Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
          rejectOnAbort(init?.signal),
        ])))

    let done = false
    void speakWithVoicevox('http://vv', FOUR_CHUNKS, 1, 1).then(() => { done = true })
    // 既定の予算を過ぎても、まだ諦めていない
    await advance(SPEECH_SYNTH_BUDGET_MS + 500)
    expect(done).toBe(false)
  })

  // **無制限にはしない（安全弁）。** VOICEVOX が応答しなくなったときに宙吊りになる。
  it('録画中でも、上限に達すれば見切る（安全弁）', async () => {
    setSpeechSynthBudgetRelaxed(true)
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => abortedNow(init?.signal)
      ?? (String(url).includes('/synthesis')
        ? Promise.race([new Promise(() => { /* 応答なし */ }), rejectOnAbort(init?.signal)])
        : Promise.race([
          Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
          rejectOnAbort(init?.signal),
        ])))

    let done = false
    void speakWithVoicevox('http://vv', FOUR_CHUNKS, 1, 1).then(() => { done = true })
    await advance(RECORDING_SYNTH_BUDGET_MS + 1000)
    expect(done).toBe(true)
  })

  // **予算はその発話の開始時に確定する**（`speakOnce` がループの外で 1 回だけ読む）。
  // 途中で切り替わっても混ざらない —— 混ざる形にすると、どの予算で見切ったのかが
  // 記録からも挙動からも読めなくなる。
  it('発話の途中で録画モードへ切り替えても、その発話の予算は変わらない（安全弁）', async () => {
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => abortedNow(init?.signal)
      ?? (String(url).includes('/synthesis')
        ? Promise.race([new Promise(() => { /* 応答なし */ }), rejectOnAbort(init?.signal)])
        : Promise.race([
          Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
          rejectOnAbort(init?.signal),
        ])))

    let done = false
    void speakWithVoicevox('http://vv', FOUR_CHUNKS, 1, 1).then(() => { done = true })
    await advance(1000)
    // 読み上げの最中に録画モードへ
    setSpeechSynthBudgetRelaxed(true)

    // 既定の予算（6 秒）で見切る。切り替えが効いていたら 30 秒まで粘ってしまう。
    await advance(SPEECH_SYNTH_BUDGET_MS + 1000)
    expect(done).toBe(true)
  })

  it('既定に戻せば従来どおりの予算で見切る（対照）', async () => {
    setSpeechSynthBudgetRelaxed(true)
    setSpeechSynthBudgetRelaxed(false)
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => abortedNow(init?.signal)
      ?? (String(url).includes('/synthesis')
        ? Promise.race([new Promise(() => { /* 応答なし */ }), rejectOnAbort(init?.signal)])
        : Promise.race([
          Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
          rejectOnAbort(init?.signal),
        ])))

    let done = false
    void speakWithVoicevox('http://vv', FOUR_CHUNKS, 1, 1).then(() => { done = true })
    await advance(SPEECH_SYNTH_BUDGET_MS + 500)
    expect(done).toBe(true)
  })
})

describe('投機的先行合成', () => {
  it('渡した文のチャンクを焼いて控えへ入れる（正）', async () => {
    prefetchSpeechTexts('http://vv', [FOUR_CHUNKS], 1)
    await advance(100)

    expect(speechAudioCacheStats().entries).toBe(4)
    // 焼いたものが当たれば、本番では 1 件も合成しない
    synthCallCount = 0
    void speakWithVoicevox('http://vv', FOUR_CHUNKS, 1, 1)
    await advance(100)
    expect(synthCallCount).toBe(0)
    expect(sources).toHaveLength(4)
  })

  // **本番を邪魔しないことが最優先。** 読み上げの最中に投機を投げると、VOICEVOX の
  // 直列処理を占有して、これから読む方が後ろで待つ。
  it('読み上げの最中は投げない（安全弁）', async () => {
    synthDelaysMs = [0, 3000, 3000, 3000]
    void speakWithVoicevox('http://vv', FOUR_CHUNKS, 1, 1)
    await advance(50)

    const before = synthCallCount
    prefetchSpeechTexts('http://vv', ['別の地震の文です。これも焼きたい文です。'], 1)
    await advance(100)
    // 投機による合成は 1 件も増えていない（増えた分は本番のパイプライン）
    expect(synthesizedTexts).not.toContain('別の地震の文です。')
    expect(synthCallCount).toBeGreaterThanOrEqual(before)

    // **読み上げを終わらせてから抜ける。** 発話の本数（`isSpeaking`）はモジュールに居座り、
    // 途中で抜けると**以降のテストがすべて「読み上げ中」と見なされて投機が自制する** ——
    // 投機のテストが軒並み「0 件焼いた」で通ってしまい、何も守らなくなる（実際に踏んだ）。
    await advance(30_000)
  })

  // 打ち切りは `speakOnce` の冒頭でも呼ばれる（本番が始まった瞬間に止める）。
  it('打ち切れば、残りのチャンクは焼かない（安全弁）', async () => {
    // 2 件目の合成に時間をかけ、その最中に打ち切る
    synthDelaysMs = [0, 5000, 0, 0]
    prefetchSpeechTexts('http://vv', [FOUR_CHUNKS], 1)
    await advance(10)
    // **打ち切る前に 1 件は焼けていること。** ここを確かめないと「そもそも投機が
    // 動いていない」ときも通ってしまう（0 < 4 は真）。
    expect(speechAudioCacheStats().entries).toBeGreaterThan(0)

    abortSpeechPrefetch()
    await advance(10_000)
    expect(speechAudioCacheStats().entries).toBeLessThan(4)
  })

  // **打ち切りは進行中の旗も同期で降ろす。** ループの `finally` まで待つ形にすると、そこへ
  // 届くのは中断の拒否がマイクロタスクとして処理された後 —— 次の投機が「まだ走っている」と
  // 誤認されて黙って見送られる。再生を切り替えた直後の 1 回目がまさにそれで、いちばん効いて
  // ほしい区間の立ち上がりで 1 周期ぶん空振りする。
  it('打ち切った直後でも、次の投機はその場で走る（正）', async () => {
    synthDelaysMs = [5000, 0, 0, 0]
    prefetchSpeechTexts('http://vv', [FOUR_CHUNKS], 1)
    await advance(10)

    // 本番の読み上げが始まったときと同じ打ち切り（`speakOnce` の冒頭が呼ぶもの）
    abortSpeechPrefetch()

    // 間を置かずに次のバッチを積む。旗が降りていなければ、ここが無言でスキップされる。
    synthCallCount = 0
    prefetchSpeechTexts('http://vv', [OTHER_FOUR_CHUNKS], 1)
    await advance(200)
    expect(synthCallCount).toBeGreaterThan(0)
  })

  it('控えに既にあるチャンクは焼き直さない（対照）', async () => {
    prefetchSpeechTexts('http://vv', [FOUR_CHUNKS], 1)
    await advance(100)
    const first = synthCallCount
    // 1 回目で実際に焼けていること（0 と 0 を比べて通る形にしない）
    expect(first).toBe(4)

    prefetchSpeechTexts('http://vv', [FOUR_CHUNKS], 1)
    await advance(100)
    expect(synthCallCount).toBe(first)
  })

  it('同じチャンクが複数の文に現れても 1 回しか焼かない（対照）', async () => {
    prefetchSpeechTexts('http://vv', ['同じ文です。ちがう文です。', '同じ文です。'], 1)
    await advance(100)
    // 「同じ文です。」「ちがう文です。」の 2 つだけ。ただし末尾の間の有無で
    // 「同じ文です。」は 2 通りになる（1 つ目の文では後続があり、2 つ目では最後）。
    expect(speechAudioCacheStats().entries).toBe(3)
  })

  // **無応答で固まらないこと。** VOICEVOX は合成要求にタイムアウトを持たないので、上限を
  // 張らないと `prefetchRunning` が真のまま残り、**以後の投機が丸ごと死ぬ**（症状は
  // 「なんとなく速くならない」だけで、ログにも画面にも出ない）。
  it('合成が返らなくても、上限で諦めて次の投機を受け付ける（安全弁）', async () => {
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => abortedNow(init?.signal)
      ?? (String(url).includes('/synthesis')
        ? Promise.race([new Promise(() => { /* 応答なし */ }), rejectOnAbort(init?.signal)])
        : Promise.race([
          Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
          rejectOnAbort(init?.signal),
        ])))

    prefetchSpeechTexts('http://vv', [FOUR_CHUNKS], 1)
    await advance(1000)
    // まだ 1 件目を待っている
    expect(speechAudioCacheStats().entries).toBe(0)

    // **1 件の上限だけでは終わらない。** 持ち手はチャンクごとに分けてあるので、詰まった
    // 1 件を諦めても次のチャンクへ進む（残りを巻き添えにしない）。バッチごと降りるのは
    // 続けて焼けなかったときで、そこまでに上限 2 回ぶんかかる。
    await advance(PREFETCH_SYNTH_TIMEOUT_MS * 2 + 1000)

    // VOICEVOX が復帰したあと、次の投機がちゃんと動く（固まっていない）
    installFetch()
    synthCallCount = 0
    prefetchSpeechTexts('http://vv', [FOUR_CHUNKS], 1)
    await advance(200)
    expect(synthCallCount).toBeGreaterThan(0)
    expect(speechAudioCacheStats().entries).toBeGreaterThan(0)
  })
})

describe('前の発話の余韻では、予算の免除は働かない', () => {
  // **`isAudioPlaying()` だけを見ると誤って免除される。** 音が止んでから 1 秒は真を返し、
  // しかも `lastAudioEndedAt` を更新するのは `onended`（非同期）—— 割り込みで止めた前の発話の
  // `ended` が、新しい発話の最初の待ちの最中に発火する。1 音も鳴らしていないのに免除が働くと、
  // 予算がいちばん効くべき「最初の合成が返るか」の瞬間だけ素通りする。
  it('割り込んだ直後の発話は、1 音も鳴っていなければ予算を消費する（対照）', async () => {
    // 1 本目: 鳴らす（再生 5 秒）
    synthDelaysMs = [0, 0, 0, 0]
    void speakWithVoicevox('http://vv', FOUR_CHUNKS, 1, 1)
    await advance(100)
    expect(sources.length).toBeGreaterThan(0)

    // 2 本目: 前の音を止めて割り込む。合成は返らない。
    // **1 本目と別の文にすること。** 同じ文だと控えが当たって合成を待たずに鳴ってしまい、
    // 「1 音も鳴っていない状態での待ち」を作れない（最初これで自分のテストを外した）。
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => abortedNow(init?.signal)
      ?? (String(url).includes('/synthesis')
        ? Promise.race([new Promise(() => { /* 応答なし */ }), rejectOnAbort(init?.signal)])
        : Promise.race([
          Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
          rejectOnAbort(init?.signal),
        ])))
    sources = []
    let done = false
    void speakWithVoicevox('http://vv', OTHER_FOUR_CHUNKS, 1, 1).then(() => { done = true })

    // 予算（6 秒）＋余白で完了しているはず。余韻で免除されるなら
    // チャンクごとの上限（5 秒）× 4 で 20 秒かかり、ここでは終わらない。
    await advance(SPEECH_SYNTH_BUDGET_MS + 1500)
    expect(done).toBe(true)
    expect(sources).toHaveLength(0)
  })
})
