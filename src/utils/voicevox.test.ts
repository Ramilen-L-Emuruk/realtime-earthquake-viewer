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
import { speakWithVoicevox } from './voicevox'

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
  vi.stubGlobal('fetch', (url: string) => {
    if (String(url).includes('/synthesis')) {
      const delay = synthDelaysMs[synthCallCount] ?? 0
      synthCallCount++
      return new Promise(resolve => {
        setTimeout(() => resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }), delay)
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) })
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
