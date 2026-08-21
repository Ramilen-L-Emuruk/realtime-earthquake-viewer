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
import { speakWithVoicevox, warmFixedPhrases, splitIntoChunks, __resetFixedPhrasesForTest } from './voicevox'
import { eewAlertToText, EEW_LEAD_PHRASES } from './ttsText'
import type { EEWAlert } from '../types/earthquake'

// 句区切り辞書は使わない（この検証の対象外。読みの補正が挟まると合成回数が増えて筋が追いにくい）
vi.mock('./ttsPhraseBreakDict', () => ({
  loadTtsPhraseBreakDict: () => Promise.resolve(null),
  getTtsPhraseBreakDictCache: () => null,
  findPhraseBreakMatch: () => null,
  isPlaceNameKey: () => false,
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
}))

/** /audio_query は即答、/synthesis はチャンクごとに指定の遅延で答える。 */
function installFetch() {
  vi.stubGlobal('fetch', (url: string, init?: { body?: string }) => {
    if (String(url).includes('/synthesis')) {
      const delay = synthDelaysMs[synthCallCount] ?? 0
      synthCallCount++
      synthBodies.push(init?.body ?? '')
      return new Promise(resolve => {
        setTimeout(() => resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }), delay)
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: accentPhrasesFixture }) })
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

      // 作り置きを捨てて、同じ句を読み上げ経路で合成し直す
      __resetFixedPhrasesForTest()
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

    // 2 回目: 埋め直した作り置きが効く（「登録済みなら触らない」だと永久に効かない）
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

    sources = []
    synthCallCount = 0
    synthDelaysMs = [800]
    void speakWithVoicevox('http://vv', EEW_TEXT, 1, 1)
    await advance(10)
    expect(sources).toHaveLength(1)   // 2 回目は待たずに鳴る
  })
})
