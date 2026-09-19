// @vitest-environment jsdom
//
// 「いま読み上げ中か」（`isSpeaking`）と、読み上げが途切れたときの通知（`onSpeechIdle`）のテスト。
//
// これを見ているのはアイドル復帰（`App.tsx`）で、声が流れているあいだは既定の状態へ戻さない
// ための門になっている。壊れ方が 2 方向あり、どちらも画面には静かな形でしか出ない。
//   - 真へ張り付く  → 既定のタブへ二度と戻らなくなる（安全弁のテストが見る）
//   - 早く偽へ落ちる → 読み上げの最中に画面を持っていかれる（正・対照のテストが見る）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { __resetSpeechAudioCacheForTest } from './speechAudioCache'
import { __resetAudioPlaybackStateForTest } from './voicevox'
import { speakWithVoicevox, stopSpeech, isSpeaking, onSpeechIdle } from './voicevox'

// ---- AudioContext の代役（`voicevox.prewarm.test.ts` と同じ作り） ----------
function makeFakeCtx() {
  return {
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
      // 最後のチャンクの完了待ちを即座に解決させる（実際の再生時間は待たない）
      addEventListener: vi.fn((_ev: string, cb: () => void) => { cb() }),
    }),
  }
}

let fakeCtx = makeFakeCtx()
vi.mock('./alertSound', () => ({
  getAudioContext: () => fakeCtx,
  getMasterInput: () => ({ connect: vi.fn() }),
  syncKeepAlive: () => {},
}))

// 読み仮名の辞書はこのテストの対象外。実物のままだと取得とタイムアウト待ちが走る。
vi.mock('./ttsPhraseBreakDict', () => ({
  loadTtsPhraseBreakDict: async () => null,
  getTtsPhraseBreakDictCache: () => null,
  findPhraseBreakMatch: () => null,
  isPlaceNameKey: () => false,
}))
vi.mock('./ttsStationReadings', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ttsStationReadings')>(),
  loadTtsStationReadings: async () => ({}),
  getTtsStationReadingsCache: () => null,
}))
vi.mock('./ttsEpicenterAccents', () => ({
  loadTtsEpicenterAccents: async () => ({}),
  getTtsEpicenterAccentsCache: () => null,
}))

// ---- fetch の代役 ----------------------------------------------------------
/** 合成（/synthesis）の応答までの待ち時間（ms）。読み上げ中の状態を作るのに使う。 */
let synthesisDelay = 0
/** 合成を失敗させるか（VOICEVOX が落ちている状況の再現）。 */
let synthesisFails = false
/** 合成の応答を返さないか（読み上げが終わらなくなった状況の再現。abort でだけ解ける）。 */
let synthesisHangs = false

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const signal = init?.signal
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (/audio_query/.test(url)) {
      if (synthesisFails) throw new TypeError('failed to fetch')
      return { ok: true, json: async () => ({ accent_phrases: [] }) } as unknown as Response
    }
    if (synthesisHangs) {
      // 応答を返さない。`stopSpeech()` の abort でだけ解ける。
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    if (synthesisDelay > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, synthesisDelay)
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) })
      })
    }
    if (synthesisFails) throw new TypeError('failed to fetch')
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Response
  }) as unknown as typeof fetch
}

beforeEach(() => {
  synthesisDelay = 0
  synthesisFails = false
  synthesisHangs = false
  fakeCtx = makeFakeCtx()
  // 合成済みチャンクの控えはモジュールに居座る。捨てないと、同じ文を 2 度読むテストの
  // 2 度目が控えから出て「合成が走らない」ことになる（辞書エントリのキャッシュと同じ事情）。
  __resetSpeechAudioCacheForTest()
  // 音の余韻（isAudioPlaying の猶予）も持ち越さない。残ると「1 音も鳴っていない」状況が作れない。
  __resetAudioPlaybackStateForTest()
  installFetch()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('読み上げ中かどうか', () => {
  // 正: 読んでいる間は真、読み終われば偽へ戻り、そこで 1 度だけ通知する。
  it('読み上げの最中は真を返し、終わると偽へ戻って通知する', async () => {
    const idle = vi.fn()
    const stop = onSpeechIdle(idle)
    synthesisDelay = 30

    const playing = speakWithVoicevox('http://x', '石川県能登地方で地震。', 1, 1)
    expect(isSpeaking()).toBe(true)
    expect(idle).not.toHaveBeenCalled()

    await playing
    expect(isSpeaking()).toBe(false)
    expect(idle).toHaveBeenCalledTimes(1)
    stop()
  })

  // 対照: 「1 本終わった」では通知しない。続きが鳴っている最中に計り直すと、そのぶん
  // 復帰が遅れるだけで意味が無い（通知の契機は「最後の 1 本が終わった瞬間」だけ）。
  it('次の読み上げが走っている間は、前の読み上げが終わっても偽にならない', async () => {
    const idle = vi.fn()
    const stop = onSpeechIdle(idle)
    synthesisDelay = 60

    const first = speakWithVoicevox('http://x', '震度速報。', 1, 1)
    // 2 本目は 1 本目を止めてから始まる（止められた側は例外ではなく正常終了で返る）。
    const second = speakWithVoicevox('http://x', '各地の震度。', 1, 1)

    await first
    expect(isSpeaking()).toBe(true)
    expect(idle).not.toHaveBeenCalled()

    await second
    expect(isSpeaking()).toBe(false)
    expect(idle).toHaveBeenCalledTimes(1)
    stop()
  })

  // 安全弁 1: 合成が全滅しても数が戻ること。戻らないと既定のタブへ二度と復帰しなくなる
  // ——しかも VOICEVOX が落ちている端末だけで起きるので、気づく手掛かりが無い。
  it('合成に失敗して無音で終わったときも偽へ戻る', async () => {
    const idle = vi.fn()
    const stop = onSpeechIdle(idle)
    synthesisFails = true

    await speakWithVoicevox('http://x', '津波警報。', 1, 1)
    expect(isSpeaking()).toBe(false)
    expect(idle).toHaveBeenCalledTimes(1)
    stop()
  })

  // 安全弁 2: 購読者の 1 人が投げても、残りには届くこと。届かなかった購読者は計り直しの
  // 契機を失い、症状は「タブが戻らない」という静かな形で出る。
  it('購読者が例外を投げても、ほかの購読者には届く', async () => {
    const broken = vi.fn(() => { throw new Error('purposely broken') })
    const healthy = vi.fn()
    const stopBroken = onSpeechIdle(broken)
    const stopHealthy = onSpeechIdle(healthy)

    await speakWithVoicevox('http://x', '地震情報。', 1, 1)
    expect(broken).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledTimes(1)

    stopBroken()
    stopHealthy()
  })

  // 安全弁 3: 読み上げが終わらなくなったら、読み上げ中の扱いを自分で解くこと。
  // 解かないと既定の状態へ戻る仕組みごと止まり、症状は「タブが戻らない」だけで例外もログも
  // 出ない（→ `SPEECH_STALE_MS`）。上限は 5 分。
  it('読み上げが終わらないまま上限を超えたら、読み上げ中の扱いを解除する', async () => {
    synthesisHangs = true
    const playing = speakWithVoicevox('http://x', '各地の震度。', 1, 1)
    expect(isSpeaking()).toBe(true)

    const base = performance.now()
    // 対照: 上限の手前では解かない（正常な長い読み上げを巻き込まない）。
    const clock = vi.spyOn(performance, 'now').mockReturnValue(base + 4 * 60_000)
    expect(isSpeaking()).toBe(true)
    // 正: 上限を超えたら解く。
    clock.mockReturnValue(base + 5 * 60_000 + 1)
    expect(isSpeaking()).toBe(false)
    clock.mockRestore()

    // 後片付け（止めると abort で合成が失敗し、読み上げは無音のまま正常終了する）
    stopSpeech()
    await playing
    expect(isSpeaking()).toBe(false)
  })

  // 安全弁 4: **割り込みで読み上げが続いている間は解けないこと。** 実運用の連鎖はこの形で、
  // 新しい読み上げは古いものを止めてから始まるため、本数は 1 → 2 → 1 と動いて**一度も 0 を
  // 通らない**（止められた側が返るのは次のマイクロタスク以降）。起点を「1 本の実時間」で
  // 測る作りだと、群発で読み続けている最中に解けてしまう —— いちばん解けてほしくない場面。
  it('割り込みで読み上げが続いている間は、上限を超えても解けない', async () => {
    synthesisDelay = 40
    const first = speakWithVoicevox('http://x', '震度速報。', 1, 1)
    const base = performance.now()
    const clock = vi.spyOn(performance, 'now')

    // 1 本目の開始から 4 分後に 2 本目が割り込む（`stopSpeech()` は挟まない＝実運用と同じ）
    clock.mockReturnValue(base + 4 * 60_000)
    const second = speakWithVoicevox('http://x', '各地の震度。', 1, 1)
    // 1 本目の開始からは 5 分を超えたが、2 本目が起点を引き直しているので解けない
    clock.mockReturnValue(base + 5 * 60_000 + 1)
    expect(isSpeaking()).toBe(true)
    clock.mockRestore()

    await first
    await second
    expect(isSpeaking()).toBe(false)
  })

  // 安全弁 5: 上限を超えたあと次の読み上げが始まったら、起点を引き直すこと。
  // 引き直さないと、以後の読み上げがすべて「終わらない」と見なされて門が効かなくなる。
  it('次の読み上げでは起点を引き直す', async () => {
    synthesisHangs = true
    const stuck = speakWithVoicevox('http://x', '各地の震度。', 1, 1)
    const base = performance.now()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(base + 5 * 60_000 + 1)
    expect(isSpeaking()).toBe(false)
    clock.mockRestore()

    // 詰まった側を止めてから、次の読み上げを始める
    stopSpeech()
    await stuck
    synthesisHangs = false
    synthesisDelay = 30
    const next = speakWithVoicevox('http://x', '震度速報。', 1, 1)
    expect(isSpeaking()).toBe(true)
    await next
  })

  // 安全弁 6: 解除したら呼ばれないこと（画面から消えた後も呼び続けると、生きていない
  // タイマーを張り直すことになる）。
  it('購読を解除すると呼ばれなくなる', async () => {
    const idle = vi.fn()
    const stop = onSpeechIdle(idle)
    stop()

    await speakWithVoicevox('http://x', '地震情報。', 1, 1)
    expect(idle).not.toHaveBeenCalled()
  })
})
