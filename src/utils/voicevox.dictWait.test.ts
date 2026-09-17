// @vitest-environment jsdom
//
// **合成待ちの予算（`SPEECH_SYNTH_BUDGET_MS`）の起点が、辞書の取得待ちを含むこと。**
//
// `speakOnce` は合成ループの手前で読み上げ用の辞書を待つ（`DICT_FETCH_TIMEOUT_MS` = 5 秒まで）。
// 予算の起点を合成ループの入口に置くと、辞書が遅い日に「辞書 5 秒 ＋ 合成 6 秒 = 11 秒」となり、
// **発話チェーン側の上限（8 秒）が先に尽きる** —— チェーンは「上限まで返ってこないのは鳴っている
// 最中」とみなして既読を進めるので、1 音も出ていないのに既読が進む（その EEW では以後、同じ値を
// 二度と読まない）。定数どうしの大小は `speechTimeouts.test.ts` が固定しているが、**起点をどこに
// 置いたかはそこでは分からない** —— 起点を合成ループの入口へ戻しても、あちらは通り続ける。
//
// **ファイルを分けている理由。** 辞書のモックは `vi.mock` でファイル全体に効くため、取得を
// 遅らせると `voicevox.test.ts` の全テストの時間軸が動く。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { speakWithVoicevox, SPEECH_SYNTH_BUDGET_MS, CHUNK_SYNTH_TIMEOUT_MS } from './voicevox'

/** 句区切り辞書の取得にかかる時間（ms）。テストごとに差し替える。 */
const dict = vi.hoisted(() => ({ delayMs: 0 }))

vi.mock('./ttsPhraseBreakDict', () => ({
  loadTtsPhraseBreakDict: () => new Promise(resolve => { setTimeout(() => resolve(null), dict.delayMs) }),
  getTtsPhraseBreakDictCache: () => null,
  findPhraseBreakMatch: () => null,
  isPlaceNameKey: () => false,
}))
// 観測点の読み・震央地名の句割りはこの検証の対象外（実物のままだと取得とタイムアウト待ちが走る）。
// `mergeSpeechDicts` は純関数なので実物を使う。
vi.mock('./ttsStationReadings', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ttsStationReadings')>(),
  loadTtsStationReadings: () => Promise.resolve({}),
  getTtsStationReadingsCache: () => null,
}))
vi.mock('./ttsEpicenterAccents', () => ({
  loadTtsEpicenterAccents: async () => ({}),
  getTtsEpicenterAccentsCache: () => null,
}))

const CHUNK_DUR_SEC = 1
let baseMs = 0

/** 再生の終わりを fake timers で起こす最小の音源。 */
class FakeSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  private listeners: (() => void)[] = []
  connect() { /* 出力先は検証しない */ }
  addEventListener(_type: string, cb: () => void) { this.listeners.push(cb) }
  start(when: number) {
    const remainMs = (when + (this.buffer?.duration ?? 0) - ctx.currentTime) * 1000
    setTimeout(() => this.fire(), Math.max(0, remainMs))
  }
  stop() { this.fire() }
  private fire() {
    this.onended?.()
    for (const l of this.listeners) l()
  }
}

const ctx = {
  get currentTime() { return (Date.now() - baseMs) / 1000 },
  state: 'running',
  resume: () => Promise.resolve(),
  createGain: () => ({ gain: { value: 0 }, connect: () => {} }),
  createBufferSource: () => new FakeSource(),
  decodeAudioData: () => Promise.resolve({ duration: CHUNK_DUR_SEC }),
}
vi.mock('./alertSound', () => ({
  getAudioContext: () => ctx,
  getMasterInput: () => ({}),
  syncKeepAlive: () => {},
}))

/** /synthesis の応答遅延（ms）。テストごとに差し替える。 */
let synthDelayMs = 0

function installFetch() {
  vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => {
    // 本物の `fetch` に合わせる（abort 済みの signal では即座に失敗する）。この場では
    // 割り込みを起こさないので実際には通らないが、契約を外したモックは将来の改変を素通しする。
    if (init?.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    if (String(url).includes('/synthesis')) {
      return new Promise(resolve => {
        setTimeout(() => resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }), synthDelayMs)
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ accent_phrases: [] }) })
  })
}

/** 1 チャンクに収まる文。合成の往復を 1 回に限って、予算の勘定を単純に保つ。 */
const ONE_CHUNK = '予想最大震度5弱。'

/** 辞書待ちも合成も終わるまで時間を進め、1 音でも鳴ったかを返す。 */
async function speakAndReportSpoke(): Promise<boolean> {
  const done = speakWithVoicevox('http://vv', ONE_CHUNK, 1, 1)
  await vi.advanceTimersByTimeAsync(30_000)
  for (let i = 0; i < 100; i++) await Promise.resolve()
  return (await done).spoke
}

// 辞書の取得が予算の 2/3 を食う状態。
const DICT_SLOW_MS = Math.round(SPEECH_SYNTH_BUDGET_MS * 2 / 3)
// 辞書待ちを引いた残り予算には収まらないが、1 チャンクの上限には収まる合成。
// **この 2 つの条件が揃って初めて起点の位置が発話の差になる。**
const SYNTH_OVER_REMAINING_MS = Math.round(SPEECH_SYNTH_BUDGET_MS / 2)
// 残り予算にも収まる合成。
const SYNTH_WITHIN_REMAINING_MS = Math.round(SPEECH_SYNTH_BUDGET_MS / 6)

beforeEach(() => {
  vi.useFakeTimers()
  baseMs = Date.now()
  dict.delayMs = 0
  synthDelayMs = 0
  installFetch()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('合成待ちの予算は、辞書の取得待ちから数える', () => {
  // 上の 3 つの遅延が、定数を動かしても意味を保っているかを先に確かめる。ここが崩れると
  // 下の 3 件は「同じことを 3 回確かめるテスト」に化け、静かに何も守らなくなる。
  it('前提: 遅延の値が定数に対して意図どおりの位置にある', () => {
    const remaining = SPEECH_SYNTH_BUDGET_MS - DICT_SLOW_MS
    expect(SYNTH_OVER_REMAINING_MS).toBeGreaterThan(remaining)
    expect(SYNTH_OVER_REMAINING_MS).toBeLessThan(CHUNK_SYNTH_TIMEOUT_MS)
    expect(SYNTH_WITHIN_REMAINING_MS).toBeLessThan(remaining)
  })

  // 正: 辞書を待った分だけ予算が減り、残りを超える合成は諦める。
  //
  // **起点を合成ループの入口へ戻すとここが落ちる** —— 予算がまるごと残るので、同じ合成が
  // 1 チャンクの上限（5 秒）まで待って成功してしまう。
  it('辞書を待った分だけ予算が減り、残りを超える合成は諦める（正）', async () => {
    dict.delayMs = DICT_SLOW_MS
    synthDelayMs = SYNTH_OVER_REMAINING_MS
    expect(await speakAndReportSpoke()).toBe(false)
  })

  // 対照: 辞書が即答なら、まったく同じ合成が鳴る。諦めの原因が合成そのものの遅さではなく
  // 「手前で予算を使ったこと」であることを示す。
  it('辞書が即答なら、同じ合成は鳴る（対照）', async () => {
    dict.delayMs = 0
    synthDelayMs = SYNTH_OVER_REMAINING_MS
    expect(await speakAndReportSpoke()).toBe(true)
  })

  // 安全弁: 辞書が遅くても、残り予算に収まる合成は鳴る。**辞書待ちを予算に数える修正が
  // 「辞書が遅い日は読み上げごと落とす」へ広がっていないこと。**
  it('辞書が遅くても、残り予算に収まる合成は鳴る（安全弁）', async () => {
    dict.delayMs = DICT_SLOW_MS
    synthDelayMs = SYNTH_WITHIN_REMAINING_MS
    expect(await speakAndReportSpoke()).toBe(true)
  })
})
