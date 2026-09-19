// @vitest-environment jsdom
//
// 「鳴らす直前の見直し」（`shouldStillPlay`）の動作を、合成と再生のタイミングを操って検証する。
//
// ここを直接テストする理由は 2 つ。
//   1. チャンクは切れ目を作らないため**前のチャンクの終わりに合わせて先に予約する**。予約した
//      瞬間と鳴り始める瞬間がずれるので、判定を 2 段（予約直前・鳴り始めの直前）に置いている。
//      この 2 段はタイミングでしか区別できない。
//   2. 完了の通知を「最後まで鳴るチャンクの終わり」に合わせている。先行合成が前のチャンクの
//      残り時間より長くかかると、取り下げの判断は**鳴り終わったあと**に届く。もう終わった音源に
//      'ended' を張っても発火しないため、ここを誤ると次の発話が上限まで足止めされる。
//
// AudioContext は偽物に差し替える。fake timers の時間軸に `currentTime` を合わせ、再生の終わりも
// タイマーで起こすことで、本物の音声グラフと同じ順序で 'ended' が届く。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { __resetSpeechAudioCacheForTest } from './speechAudioCache'
import { __resetAudioPlaybackStateForTest } from './voicevox'
import { speakWithVoicevox, speakSequentially, warmFixedPhrases, splitIntoChunks, __resetFixedPhrasesForTest, SPEECH_SYNTH_BUDGET_MS } from './voicevox'
import { eewAlertToText, EEW_LEAD_PHRASES, voicevoxPreviewTexts } from './ttsText'
import type { EEWAlert } from '../types/earthquake'

// 句区切り辞書は使わない（この検証の対象外。読みの補正が挟まると合成回数が増えて筋が追いにくい）
vi.mock('./ttsPhraseBreakDict', () => ({
  loadTtsPhraseBreakDict: () => Promise.resolve(null),
  getTtsPhraseBreakDictCache: () => null,
  findPhraseBreakMatch: () => null,
  isPlaceNameKey: () => false,
}))

// 観測点の読みはこのテストの対象外。実物のままだと取得（と 5 秒のタイムアウト待ち）が走る。
// `mergeSpeechDicts` は純関数なので実物を使う。
vi.mock('./ttsStationReadings', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ttsStationReadings')>(),
  loadTtsStationReadings: () => Promise.resolve({}),
  getTtsStationReadingsCache: () => null,
}))

// 震央地名の句割りも同様に対象外（実物のままだと取得とタイムアウト待ちが走る）。
vi.mock('./ttsEpicenterAccents', () => ({
  loadTtsEpicenterAccents: async () => ({}),
  getTtsEpicenterAccentsCache: () => null,
}))

const DUR_SEC = 1
/** チャンクごとの /synthesis の応答遅延（ms）。テストごとに差し替える。 */
let synthDelaysMs: number[] = []
let synthCallCount = 0
/** /audio_query が返す accent_phrases。既定は空（間の検証をするテストだけ差し替える）。 */
let accentPhrasesFixture: unknown[] = []
/** /synthesis へ送られたリクエストボディ（間が載っているかを見るため）。 */
let synthBodies: string[] = []

class FakeSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  startAt: number | null = null
  stoppedAtSec: number | null = null
  private listeners: (() => void)[] = []
  private endTimer: ReturnType<typeof setTimeout> | undefined
  connect() { /* 出力先は検証しない */ }
  addEventListener(_type: string, cb: () => void) { this.listeners.push(cb) }
  start(when: number) {
    this.startAt = when
    const remainMs = (when + (this.buffer?.duration ?? 0) - ctx.currentTime) * 1000
    this.endTimer = setTimeout(() => this.fireEnded(), Math.max(0, remainMs))
  }
  stop() {
    this.stoppedAtSec = ctx.currentTime
    clearTimeout(this.endTimer)
    // 本物のブラウザは、開始時刻より前に stop() したソースでも 'ended' を発火する
    this.fireEnded()
  }
  /** 1 音も鳴らずに落とされたか（開始時刻より前に stop された）。 */
  get droppedBeforeSound() { return this.stoppedAtSec !== null && this.startAt !== null && this.stoppedAtSec < this.startAt }
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
  decodeAudioData: () => Promise.resolve({ duration: DUR_SEC }),
}
vi.mock('./alertSound', () => ({
  getAudioContext: () => ctx,
  getMasterInput: () => ({}),
  // speakWithVoicevox() が ctx.resume() の直後に呼ぶ。この場のテストはキープアライブの
  // 挙動自体を検証対象にしないため、実体を持たない no-op で足りる
  syncKeepAlive: () => {},
}))

/**
 * 渡された `signal` が abort されたら失敗する Promise。**本物の `fetch` に合わせるために要る** ——
 * 実装は合成のたびに `signal` を渡しており、abort 済みの signal で呼ぶと本物は即座に失敗する。
 * モックがこれを無視すると、**「1 チャンクの中断が後続を巻き添えにする」形の不具合を
 * 素通しする**（合成が普通に成功してしまい、テストが何も守らない）。
 */
function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (!signal) return
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
}

/**
 * **abort 済みの signal で呼ばれたら即座に失敗する。** 本物の `fetch` はそう振る舞う。
 * `Promise.race` で後追いに混ぜるだけでは足りない —— 成功側が同じマイクロタスクで解決すると
 * そちらが勝ってしまい、**中断されたはずの合成が成功して返る**（テストが何も守らなくなる）。
 */
function abortedNow(signal: AbortSignal | undefined): Promise<never> | null {
  return signal?.aborted ? Promise.reject(new DOMException('Aborted', 'AbortError')) : null
}

/** /audio_query は即答、/synthesis はチャンクごとに指定の遅延で答える。 */
function installFetch() {
  vi.stubGlobal('fetch', (url: string, init?: { body?: string; signal?: AbortSignal }) => {
    const aborted = abortedNow(init?.signal)
    if (aborted) return aborted
    if (String(url).includes('/synthesis')) {
      const delay = synthDelaysMs[synthCallCount] ?? 0
      synthCallCount++
      synthBodies.push(init?.body ?? '')
      return Promise.race([
        new Promise(resolve => {
          setTimeout(() => resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }), delay)
        }),
        rejectOnAbort(init?.signal),
      ])
    }
    return Promise.race([
      Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: accentPhrasesFixture }) }),
      rejectOnAbort(init?.signal),
    ])
  })
}

/** 保留中のマイクロタスクを流し切る（発話は Promise チェーンで進むため）。 */
async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}

// 2 チャンクに割れる文（句点の直後で切れ、どちらも 5 文字以上）
const TWO_CHUNKS = '予想最大震度5弱。予想最大階級1。'

beforeEach(() => {
  vi.useFakeTimers()
  baseMs = Date.now()
  sources = []
  synthDelaysMs = []
  synthCallCount = 0
  synthBodies = []
  accentPhrasesFixture = []
  // 合成済みチャンクの控えはモジュールに居座る。捨てないと、同じ文を 2 度読むテストの
  // 2 度目が控えから出て「合成が走らない」ことになる（辞書エントリのキャッシュと同じ事情）。
  __resetSpeechAudioCacheForTest()
  // 音の余韻（isAudioPlaying の猶予）も持ち越さない。残ると「1 音も鳴っていない」状況が作れない。
  __resetAudioPlaybackStateForTest()
  installFetch()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('speakWithVoicevox の鳴らす直前の見直し', () => {
  it('判定を渡さなければ全チャンクを鳴らし、最後のチャンクの終わりで完了する', async () => {
    synthDelaysMs = [100, 100]
    let done = false
    void speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1).then(() => { done = true })

    await advance(300)
    expect(sources).toHaveLength(2)
    expect(done).toBe(false)      // まだ鳴っている（2 チャンクで 2 秒）
    await advance(2000)
    expect(done).toBe(true)
    expect(sources.every(s => !s.droppedBeforeSound)).toBe(true)
  })

  it('合成を待つ間に判定が外れたら 1 音も鳴らさず、待たせずに完了する', async () => {
    synthDelaysMs = [500]
    let done = false
    void speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1, () => false).then(() => { done = true })

    await advance(600)
    expect(sources).toHaveLength(0)  // 予約すらしない
    expect(done).toBe(true)
  })

  it('鳴っている途中で判定が外れたら、次のチャンクは 1 音も鳴らさない', async () => {
    synthDelaysMs = [100, 100]
    let valid = true
    let done = false
    void speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1, () => valid).then(() => { done = true })

    await advance(300)
    expect(sources).toHaveLength(2)  // 2 チャンク目は 1 チャンク目の終わりに予約済み
    valid = false                    // 1 チャンク目を鳴らしている途中で新しい情報が届いた

    // 2 チャンク目の鳴り始めの直前（1.05 秒）に判定が走り、落とされる。
    // 1 チャンク目はまだ 1.1 秒まで鳴っているので、**ここで完了してはいけない**
    // （早く完了すると、次の発話の冒頭の一括停止が鳴っている末尾を削る）。
    await advance(760)
    expect(sources[1].droppedBeforeSound).toBe(true)   // 続きは鳴らさない
    expect(done).toBe(false)

    await advance(100)
    expect(sources[0].droppedBeforeSound).toBe(false)  // 鳴り始めた分は最後まで鳴らす
    expect(done).toBe(true)                            // 上限を待たずに完了する
  })

  it('直前のチャンクが鳴り終わったあとに判定が外れても、完了を待たせない', async () => {
    // 2 チャンク目の合成（3 秒）が 1 チャンク目の再生（1 秒）より長くかかる状況。
    // 取り下げの判断は「1 チャンク目が鳴り終わったあと」に届く。
    synthDelaysMs = [100, 3000]
    let valid = true
    let done = false
    void speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1, () => valid).then(() => { done = true })

    await advance(1300)               // 1 チャンク目は鳴り終わっている
    expect(sources).toHaveLength(1)
    valid = false

    await advance(2000)               // 2 チャンク目の合成が返る
    expect(sources).toHaveLength(1)   // 予約されない
    expect(done).toBe(true)           // ここが false だと呼び出し側が 8 秒足止めされる
  })
})

// 「1 音でも鳴ったか」（`SpeechOutcome.spoke`）。
//
// **呼び出し側の既読がこれに依存している。** この関数は例外を投げない設計で、VOICEVOX 未起動・
// ネットワーク断でも正常終了するため、戻り値を見ないと「読み上げが完了した」と区別が付かず、
// 1 音も出ていないのに既読が進む（→ `useLiveEventHandler` の EEW 各フェーズ）。
//
// **ここでしか実装経路を通らない。** `useLiveEventHandler` 側のテストは `./voicevox` を丸ごと
// モックするので、`spoke` の値は手で書いたものが返るだけで、この判定は 1 行も走らない。
describe('1 音でも鳴ったかを返す', () => {
  // 正: 最後まで鳴れば真
  it('全チャンクが鳴れば真', async () => {
    synthDelaysMs = [100, 100]
    const p = speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1)
    await advance(2400)
    expect((await p).spoke).toBe(true)
  })

  // 対照: 合成が 1 つも成功しなければ偽（VOICEVOX 未起動・ネットワーク断がこの形）
  it('合成が 1 つも成功しなければ偽', async () => {
    vi.stubGlobal('fetch', (url: string) => (String(url).includes('/synthesis')
      ? Promise.resolve({ ok: false, status: 500 })
      : Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) })))
    const p = speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1)
    await advance(500)
    expect((await p).spoke).toBe(false)
    expect(sources).toHaveLength(0)
  })

  // 対照: 鳴り出す前に取り下げたら偽（合成を待つ間に情報が新しくなった）
  it('1 音も鳴らさずに取り下げたら偽', async () => {
    synthDelaysMs = [500]
    const p = speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1, () => false)
    await advance(600)
    expect((await p).spoke).toBe(false)
    expect(sources).toHaveLength(0)
  })

  // 対照: 合成が**応答を返さない**ときも偽。**ここが今回の要**（`CHUNK_SYNTH_TIMEOUT_MS`）——
  // VOICEVOX への合成要求そのものには上限が無く、接続は受け付けるのに応答が返らない状況
  // （機器のスリープ・経路が黙って捨てる）では、上限が無いと読み上げが完了も失敗もしないまま
  // 宙に浮く。呼び出し側からは「鳴っている最中」と区別が付かず、**1 音も出ていないのに
  // 既読が進む**（→ `useLiveEventHandler` の EEW 各フェーズ）。
  it('合成が応答を返さなくても、上限で諦めて偽を返す', async () => {
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => abortedNow(init?.signal)
      ?? (String(url).includes('/synthesis')
        ? Promise.race([new Promise(() => { /* 応答を返さない */ }), rejectOnAbort(init?.signal)])
        : Promise.race([
          Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
          rejectOnAbort(init?.signal),
        ])))
    // **1 チャンクの文で確かめる。** 複数チャンクだと上限がチャンクごとに掛かり、
    // 待つ時間がテストの制限（5 秒）を越える。
    const p = speakWithVoicevox('http://vv', '最大震度5弱です。', 1, 1)
    await advance(6000)          // 上限（5 秒）を越える
    expect((await p).spoke).toBe(false)
    expect(sources).toHaveLength(0)
  })

  // 安全弁: **1 チャンクのタイムアウトが、後続のチャンクを巻き添えにしない。**
  //
  // 合成に渡す `signal` はその発話の全チャンクで共有している。上限で見切るときに abort すると
  // `AbortSignal` は解除できないので、以降のチャンクは要求を送る前に即死する ——「このチャンク
  // だけ諦める」が「残り全部を無音にする」に化ける。地方を列挙する読み上げなら、途中で 1 回
  // 詰まっただけで残りの警戒対象が丸ごと声にならない。
  it('1 チャンクが上限で諦めても、次のチャンクは鳴る', async () => {
    let call = 0
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => {
      const aborted = abortedNow(init?.signal)
      if (aborted) return aborted
      if (!String(url).includes('/synthesis')) {
        return Promise.race([
          Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
          rejectOnAbort(init?.signal),
        ])
      }
      call++
      // 1 チャンク目だけ応答を返さない。2 チャンク目は正常に返る
      if (call === 1) return Promise.race([new Promise(() => { /* 応答なし */ }), rejectOnAbort(init?.signal)])
      return Promise.race([
        Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
        rejectOnAbort(init?.signal),
      ])
    })
    const p = speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1)
    await advance(6000)          // 1 チャンク目の上限（5 秒）を越える
    await advance(2000)          // 2 チャンク目が鳴り終わる
    expect(sources).toHaveLength(1)   // 2 チャンク目だけが鳴る
    expect((await p).spoke).toBe(true)
  })

  // 安全弁: **複数チャンクが連続して無応答でも、合成待ちの合計は予算内に収まる。**
  //
  // 合成待ちは直列に積み上がる（次のチャンクは前の結果が出てから始める）。チャンクごとの上限
  // だけだと `チャンク数 × 5 秒` になり、発話チェーンの待ち上限（8 秒）を越える —— **チェーン側が
  // 先に見切って「鳴っている最中」と誤認し、1 音も出ていないのに既読が進む**。
  it('複数チャンクが無応答でも、合成待ちの合計は予算内で打ち切る', async () => {
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => abortedNow(init?.signal)
      ?? (String(url).includes('/synthesis')
        ? Promise.race([new Promise(() => { /* 応答なし */ }), rejectOnAbort(init?.signal)])
        : Promise.race([
          Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) }),
          rejectOnAbort(init?.signal),
        ])))
    let done = false
    void speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1).then(() => { done = true })

    // 予算（6 秒）を過ぎた時点で、2 チャンクとも諦めて完了しているはず。
    // チャンクごとの上限だけなら 2 × 5 = 10 秒かかり、ここではまだ終わっていない。
    await advance(SPEECH_SYNTH_BUDGET_MS + 500)
    expect(done).toBe(true)
    expect(sources).toHaveLength(0)
  })

  // 安全弁: 鳴り始めてから取り下げたら真。**「最後まで鳴ったか」ではなく「鳴ったか」**を返す
  // ——聞き手には届いているので、既読を進める側から見れば鳴ったのと同じ。
  //
  // **予約が全部落ちる形はここで作れていない。** 判定は `scheduled.some(s => !s.dropped)` だが、
  // 1 チャンク目は予約と同時に鳴り始めるため「鳴り始めの直前」の再判定を受けず、全件が
  // `dropped` になる並びを組めない（`scheduled.length > 0` に書き換えてもこの 4 件は通る）。
  it('鳴り始めてから取り下げたら真', async () => {
    synthDelaysMs = [100, 100]
    let valid = true
    const p = speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1, () => valid)
    await advance(300)
    valid = false
    await advance(900)
    expect(sources[1].droppedBeforeSound).toBe(true)   // 続きは鳴っていない
    expect((await p).spoke).toBe(true)                 // 1 チャンク目は鳴った
  })
})

// 切り出し語の作り置き（`warmFixedPhrases`）。
//
// 狙いは「合成の往復を待たずに 1 音目を出すこと」なので、検証も**待たずに鳴ったか**で見る。
// 合成の呼び出し回数だけを数えると、作り置きを引けていなくても数が合ってしまうことがある。
describe('切り出し語の作り置き', () => {
  const makeEew = (name: string) => ({ earthquake: { hypocenter: { name } } }) as unknown as EEWAlert

  // **読み上げ文もチャンク分割も実物を使う。** ここで文字列を手書きすると、切り出し語の文言や
  // `splitIntoChunks` の分割条件を変えたときに、作り置きが効かなくなってもテストは緑のまま通る。
  const EEW_TEXT = eewAlertToText(makeEew('能登半島沖'), 'warning')
  const LEAD = splitIntoChunks(EEW_TEXT)[0]

  it('読み上げ文の 1 チャンク目が、作り置きの対象と一致する', () => {
    // この一致が崩れると、作り置きは正常に作られるのに一度も引かれない
    // （症状は「緊急地震速報の第 1 報だけ毎回わずかに遅い」だけで、ログにも何も出ない）。
    for (const kind of ['forecast', 'warning', 'hypocenterUpdate'] as const) {
      const first = splitIntoChunks(eewAlertToText(makeEew('能登半島沖'), kind))[0]
      expect(EEW_LEAD_PHRASES).toContain(first)
    }
    // 震源名が短くても切り出し語が次のチャンクに巻き込まれないこと
    expect(EEW_LEAD_PHRASES).toContain(splitIntoChunks(eewAlertToText(makeEew('石狩湾'), 'warning'))[0])
  })

  /** 作り置きを 1 件用意する（合成の往復を済ませた状態にする）。 */
  async function warmed(baseUrl = 'http://vv', speakerId = 1) {
    synthDelaysMs = [0]
    warmFixedPhrases(baseUrl, speakerId, [LEAD])
    await advance(10)
    // 以降の計測に持ち越さないよう、合成の記録と予約済みソースを仕切り直す
    synthCallCount = 0
    sources = []
  }

  beforeEach(() => { __resetFixedPhrasesForTest() })

  it('作り置きは 1 件ずつ順に投げる（VOICEVOX の直列処理を占有しない）', async () => {
    // まとめて投げると起動直後を占有し、その窓に届いた緊急地震速報の 2 チャンク目が後ろに並ぶ。
    // `Promise.all` へ戻すと、この検証だけが落ちる。
    expect(EEW_LEAD_PHRASES.length).toBeGreaterThan(1)
    synthDelaysMs = EEW_LEAD_PHRASES.map(() => 100)

    warmFixedPhrases('http://vv', 1, EEW_LEAD_PHRASES)
    await advance(10)
    expect(synthCallCount).toBe(1)   // 並行なら全件がここで発火している

    await advance(120)
    expect(synthCallCount).toBe(2)   // 1 件目が終わってから 2 件目
  })

  // 作り置きと合成し直しは、同じ句に**同じ末尾の間**を付けなければならない。
  // 切り出し語（`EEW_LEAD_PHRASES`）はすべて読点で終わる 1 チャンク目で、後ろに震源名が続く。
  // つまり `hasNextChunk` は常に true。片方が既定の false で焼くと、**どちらの経路が先に
  // キャッシュを埋めたかで間が変わる**非決定的な不揃いになる（音は鳴るので気づけない）。
  //
  // このテストは 3 点を対にしている:
  //   正   … 作り置きの合成に間が載る
  //   対照 … 同じ句を合成し直した経路にも同じ間が載る（両者が一致する）
  //   安全弁… 最後のチャンクには間を載せない（読み終わりに無音を伸ばさない）
  describe('末尾の間は作り置きと合成し直しで一致する', () => {
    /** 間（pause_mora）を持つ形の accent_phrases を 1 つ返す。 */
    const withPauseSlot = () => [{ moras: [], accent: 1, pause_mora: null }]
    /** 記録したボディから、末尾アクセント句の pause_mora を取り出す。 */
    const tailPause = (body: string) => {
      const phrases = (JSON.parse(body) as { accent_phrases: { pause_mora: unknown }[] }).accent_phrases
      return phrases[phrases.length - 1].pause_mora
    }

    it('作り置きの合成に末尾の間が載る（正）', async () => {
      accentPhrasesFixture = withPauseSlot()
      synthDelaysMs = [0]
      warmFixedPhrases('http://vv', 1, [LEAD])
      await advance(10)

      expect(synthBodies).toHaveLength(1)
      expect(tailPause(synthBodies[0])).not.toBeNull()
    })

    it('合成し直した経路の間が、作り置きと一致する（対照）', async () => {
      accentPhrasesFixture = withPauseSlot()

      // 作り置きだけを焼く
      synthDelaysMs = [0]
      warmFixedPhrases('http://vv', 1, [LEAD])
      await advance(10)
      const warmBody = synthBodies[0]

      // 作り置きを捨てて、同じ句を読み上げ経路で合成し直す。
      // **控えも一緒に捨てる**（`speechAudioCache`）。作り置きだけ捨てても控えが当たって
      // 合成し直しが起きず、「合成し直した経路」を観測できない。
      __resetFixedPhrasesForTest()
      __resetSpeechAudioCacheForTest()
      synthBodies = []
      synthCallCount = 0
      synthDelaysMs = [0, 0]
      void speakWithVoicevox('http://vv', EEW_TEXT, 1, 1)
      await advance(10)

      expect(synthBodies.length).toBeGreaterThan(0)
      expect(tailPause(synthBodies[0])).toEqual(tailPause(warmBody))
    })

    it('最後のチャンクには間を載せない（安全弁）', async () => {
      accentPhrasesFixture = withPauseSlot()
      synthDelaysMs = [0, 0]
      void speakWithVoicevox('http://vv', EEW_TEXT, 1, 1)
      await advance(50)

      // 2 チャンク以上に割れていること自体を前提にする（割れ方が変わったら気づけるように）
      expect(splitIntoChunks(EEW_TEXT).length).toBeGreaterThan(1)
      expect(tailPause(synthBodies[synthBodies.length - 1])).toBeNull()
    })
  })

  // 複数の文を順に鳴らす（`speakSequentially`）。設定タブの VOICEVOX 試聴が使う。
  //
  // **1 つの文字列へ繋げるのとは鳴り方が違う。** 繋げると文の境目がチャンクの途中になり、
  // 末尾の句読点に間（`CHUNK_BREAK_PAUSE`）が入る。実運用の緊急地震速報は第 1 フェーズと
  // 第 2 フェーズを別々の読み上げとして鳴らすので、試聴でも分けないと実運用には無い無音が
  // 「〇〇で地震。」の後ろに挟まる。
  //
  // 3 点を対にしている:
  //   正   … 分けて渡すと 1 文目の末尾に間が入らない
  //   対照 … 同じ内容を繋げて渡すと、同じ位置に間が入る
  //   安全弁… 鳴らしている間に別の読み上げが始まったら、続きを鳴らさない
  describe('複数の文を順に鳴らす', () => {
    const withPauseSlot = () => [{ moras: [], accent: 1, pause_mora: null }]
    const tailPause = (body: string) => {
      const phrases = (JSON.parse(body) as { accent_phrases: { pause_mora: unknown }[] }).accent_phrases
      return phrases[phrases.length - 1].pause_mora
    }
    // 実物を使う。手書きすると、試聴文の分け方が変わったときにここだけ古い形で残る。
    const TEXTS = voicevoxPreviewTexts()
    /** 1 文目が割れるチャンク数。この最後のチャンクが「〇〇で地震。」にあたる。 */
    const firstChunks = splitIntoChunks(TEXTS[0]).length

    /**
     * 始めた読み上げを最後まで進めてから抜ける。**列を途中で残さないこと** ——
     * 2 文目は 1 文目の再生完了を待つので、残すと次のテストの時間送りでそこから鳴り出し、
     * 無関係なテストの合成回数・音源数が狂う（実際に既存テストを 1 件巻き込んだ）。
     */
    const drain = async (p: Promise<unknown>) => { await advance(5000); await p }

    it('分けて渡すと 1 文目の末尾に間が入らない（正）', async () => {
      // 2 チャンク以上に割れていること自体を前提にする（割れ方が変わったら気づけるように）
      expect(TEXTS.length).toBe(2)
      expect(firstChunks).toBeGreaterThan(1)

      accentPhrasesFixture = withPauseSlot()
      synthDelaysMs = [0, 0, 0, 0]
      const seq = speakSequentially('http://vv', TEXTS, 1, 1)
      await advance(50)

      expect(synthBodies.length).toBe(firstChunks)   // 2 文目はまだ（1 文目の再生を待つ）
      expect(tailPause(synthBodies[firstChunks - 1])).toBeNull()

      // **割り込みが無ければ最後まで読み切ること**も見る。ここを見ないと過剰抑制に気づけない
      // —— 下の安全弁は「2 文目が鳴らない」ことを確かめるので、何かの拍子に**常に**降りる
      // ようになっても通り続ける（むしろ正しく動いているように見える）。
      await drain(seq)
      expect(synthBodies.length).toBe(firstChunks + splitIntoChunks(TEXTS[1]).length)
    })

    it('繋げて渡すと同じ位置に間が入る（対照）', async () => {
      accentPhrasesFixture = withPauseSlot()
      synthDelaysMs = [0, 0, 0, 0]
      const p = speakWithVoicevox('http://vv', TEXTS.join(''), 1, 1)
      await advance(50)

      expect(tailPause(synthBodies[firstChunks - 1])).not.toBeNull()

      await drain(p)
    })

    // 安全弁: 前の文が止められたら降りる。判定を外すと、止められたことに気づかないまま次の文を
    // 鳴らし、**今度はこちらが相手を止める**。相手は同じ列とは限らない —— 緊急地震速報の
    // 読み上げは `speakWithVoicevox` を直接呼ぶので、警報の声をこの列の続きが上書きしうる。
    /** 合成に回ったテキストを記録する（どの文が実際に読まれたかを見るため）。 */
    const recordQueriedTexts = () => {
      const queried: string[] = []
      vi.stubGlobal('fetch', (url: string, init?: { body?: string }) => {
        const s = String(url)
        if (s.includes('/synthesis')) {
          synthBodies.push(init?.body ?? '')
          return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })
        }
        queried.push(decodeURIComponent(s.split('text=')[1]?.split('&')[0] ?? ''))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: accentPhrasesFixture }) })
      })
      return queried
    }

    it('鳴らしている間に別の読み上げが始まったら、続きを鳴らさない（安全弁）', async () => {
      const queried = recordQueriedTexts()

      const seq = speakSequentially('http://vv', TEXTS, 1, 1)
      await advance(50)   // 1 文目を鳴らしている最中

      // この列を通らない読み上げ（実運用の緊急地震速報がこの形で呼ぶ）が割り込む
      const other = speakWithVoicevox('http://vv', '緊急地震速報、能登半島沖で地震。', 1, 1)
      await drain(other)
      await seq

      expect(queried).not.toContain(TEXTS[1])
    })

    // **連打（試聴ボタンの 2 度押し）はここでは固定していない。** 判定が守る相手は同じなのだが、
    // この環境では判定を外しても止め合いが再現しない（止められた側が合成のループに留まり、
    // 次の文へ進まない）。**落ちないと分かっているテストは、守っているように見えて何も守らない。**
    // 実機では確認済みで、確かめ方は `speakSequentially` のコメントに書いてある。
  })

  it('作り置きが当たれば、合成を待たずに 1 音目を鳴らす', async () => {
    await warmed()

    synthDelaysMs = [800]  // 2 チャンク目の合成。これを待っていたら 1 音目は鳴らない
    void speakWithVoicevox('http://vv', EEW_TEXT, 1, 1)
    await advance(10)

    expect(sources).toHaveLength(1)   // 往復ゼロで鳴っている
    expect(synthCallCount).toBe(1)    // 走ったのは 2 チャンク目の合成だけ
  })

  it('作り置きが無ければ従来どおり合成を待つ（対照）', async () => {
    // warm を呼ばないだけで、他は上のケースと同じ条件にする
    synthDelaysMs = [800, 0]
    void speakWithVoicevox('http://vv', EEW_TEXT, 1, 1)
    await advance(10)

    expect(sources).toHaveLength(0)   // 1 チャンク目の合成待ち
    await advance(900)
    expect(sources.length).toBeGreaterThan(0)
  })

  it('話者が変われば作り置きを使わない（別の声のまま鳴らさない）', async () => {
    await warmed('http://vv', 1)

    synthDelaysMs = [800]
    void speakWithVoicevox('http://vv', EEW_TEXT, 2, 1)  // 話者 2
    await advance(10)

    expect(sources).toHaveLength(0)   // 話者 1 の作り置きは引かず、合成し直す
  })

  it('接続先が変われば作り置きを使わない', async () => {
    await warmed('http://vv', 1)

    synthDelaysMs = [800]
    void speakWithVoicevox('http://other', EEW_TEXT, 1, 1)
    await advance(10)

    expect(sources).toHaveLength(0)
  })

  // ここから 2 件は「作り置きを待たない」ことの回帰。
  // VOICEVOX への合成要求にはタイムアウトが無く、応答が返らないまま止まることがある。
  // 待つ設計にすると、その句を使う読み上げが軒並み無音になる（外側の待ち合わせが上限で
  // 諦めるため、記録も残らずに消える）。しかも作り置きは埋まらないままなので**復旧しない**。
  it('作り置きの合成が返ってこなくても、読み上げは待たされない', async () => {
    synthDelaysMs = [10_000_000]        // 作り置きの合成が返らない
    warmFixedPhrases('http://vv', 1, [LEAD])
    await advance(10)
    synthCallCount = 0
    sources = []

    synthDelaysMs = [0, 0]
    void speakWithVoicevox('http://vv', EEW_TEXT, 1, 1)
    await advance(50)

    expect(sources.length).toBeGreaterThan(0)  // 普通に合成して鳴らしている
  })

  it('作り置きが合成中のままでも、読み上げた結果で埋め直す', async () => {
    synthDelaysMs = [10_000_000]
    warmFixedPhrases('http://vv', 1, [LEAD])
    await advance(10)

    // 1 回目: 作り置きは未完了なので普通に合成し、その結果を作り置きへ残す
    synthCallCount = 0
    sources = []
    synthDelaysMs = [0, 0]
    void speakWithVoicevox('http://vv', EEW_TEXT, 1, 1)
    await advance(2000)

    // 2 回目: 埋め直した作り置きが効く（「登録済みなら触らない」だと永久に効かない）。
    // **控えは捨てる。** ここで見たいのは作り置きの効きで、控え（`speechAudioCache`）が
    // 残っていると 2 チャンク目まで即座に鳴り、作り置きが効いたかどうかが読めない。
    __resetSpeechAudioCacheForTest()
    sources = []
    synthCallCount = 0
    synthDelaysMs = [800]
    void speakWithVoicevox('http://vv', EEW_TEXT, 1, 1)
    await advance(10)

    expect(sources).toHaveLength(1)
  })

  it('作り置きに失敗していても、一度読み上げれば次から効く（自己修復）', async () => {
    // VOICEVOX が未起動で作り置きに失敗した状況
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false }))
    warmFixedPhrases('http://vv', 1, [LEAD])
    await advance(10)

    // VOICEVOX が起動した。1 回目は合成を待たされるが、その結果を作り置きに残す
    installFetch()
    synthDelaysMs = [800, 0]
    void speakWithVoicevox('http://vv', EEW_TEXT, 1, 1)
    await advance(10)
    expect(sources).toHaveLength(0)   // まだ待たされる
    await advance(2000)

    // 控えは捨てる（理由は 1 つ上のテストと同じ。見たいのは作り置きの効き）
    __resetSpeechAudioCacheForTest()
    sources = []
    synthCallCount = 0
    synthDelaysMs = [800]
    void speakWithVoicevox('http://vv', EEW_TEXT, 1, 1)
    await advance(10)
    expect(sources).toHaveLength(1)   // 2 回目は待たずに鳴る
  })
})

// 画面を読み上げに追従させる側へ渡す予約の通知（`onChunkScheduled`）。
//
// 「鳴り始め」ではなく「予約」を報告する契約なので、通知はチャンクを予約した時点で届き、
// `startAt` は未来を指す。受け取る側がその時刻と `getSpeechClock()` を突き合わせて
// 現在位置を決める（voicevox 側にタイマーを持たせない理由は型の説明を参照）。
describe('speakWithVoicevox の予約の通知', () => {
  it('鳴らすチャンクごとに、添字と再生開始時刻を渡す', async () => {
    synthDelaysMs = [100, 100]
    const seen: { index: number; startAt: number; chunkCount: number }[] = []

    void speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1, undefined, null,
      (index, startAt, chunks) => seen.push({ index, startAt, chunkCount: chunks.length }))

    await advance(150)
    // 1 チャンク目は即時再生。予約と同時に通知が来る
    expect(seen).toHaveLength(1)
    expect(seen[0].index).toBe(0)
    expect(seen[0].chunkCount).toBe(2)
    const firstStart = seen[0].startAt

    await advance(150)
    // 2 チャンク目は「1 チャンク目の終わり」に予約される。鳴る前に通知が届く
    expect(seen).toHaveLength(2)
    expect(seen[1].index).toBe(1)
    expect(seen[1].startAt).toBeCloseTo(firstStart + DUR_SEC, 2)
    // まだ鳴っていない時刻を指している（これが「予約」である証拠）
    expect(seen[1].startAt).toBeGreaterThan(ctx.currentTime)
  })

  it('割り込みで取り下げたチャンクは通知しない', async () => {
    // 2 チャンク目の合成を待っている間に判定が外れる状況（既存の取り下げ経路と同じ条件）
    synthDelaysMs = [100, 3000]
    let valid = true
    const seen: number[] = []

    void speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1, () => valid, null,
      index => seen.push(index))

    await advance(150)
    expect(seen).toEqual([0])

    valid = false
    await advance(3000)
    // 予約されなかったチャンクは通知も来ない（画面が読まれていない箇所へ動かないこと）
    expect(seen).toEqual([0])
  })

  // この関数は「例外を投げない」契約（未起動・通信失敗でも無音で正常終了する）。追従の通知から
  // throw が抜けると再生ループが中断し、**警報の本文が途中で切れる**。画面が動かないより重い。
  it('通知が例外を投げても、読み上げは最後まで続ける', async () => {
    synthDelaysMs = [100, 100]
    const seen: number[] = []
    let done = false

    void speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1, undefined, null, index => {
      seen.push(index)
      throw new Error('追従側の不具合')
    }).then(() => { done = true })

    await advance(150)
    expect(sources).toHaveLength(1)

    await advance(150)
    // 1 チャンク目の通知で例外が出ても 2 チャンク目は予約される
    expect(sources).toHaveLength(2)
    expect(seen).toEqual([0, 1])

    await advance(2000)
    expect(done).toBe(true)
  })

  it('合成に失敗したチャンクは飛ばすので、添字は連番にならない', async () => {
    // 1 チャンク目の /synthesis だけ失敗させる
    let synthCalls = 0
    vi.stubGlobal('fetch', (url: string) => {
      if (String(url).includes('/synthesis')) {
        synthCalls++
        if (synthCalls === 1) return Promise.resolve({ ok: false })
        return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) })
    })
    const seen: number[] = []

    void speakWithVoicevox('http://vv', TWO_CHUNKS, 1, 1, undefined, null, index => seen.push(index))

    await advance(200)
    expect(seen).toEqual([1])
  })
})
