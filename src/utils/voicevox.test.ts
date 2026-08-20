// @vitest-environment jsdom
//
// 先行合成（`prewarmVoicevox`）のテスト。
//
// 通知音と声が重ならないよう電文ごとに 0.5〜4.2 秒の間を置いているため、その間に最初の
// ひと区切りを合成しておく。ここで固定したいのは 3 つ。
//   1. 先行合成は**進行中の再生を止めない**（止めると、間を置いている最中に前の声が切れる）
//   2. 使わなかった先行合成は次の読み上げが始まるときに打ち切る（VOICEVOX の直列処理を明け渡す）
//   3. 打ち切られていた・失敗していたら再生側で合成し直す（**無音にしない**）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { prewarmVoicevox, speakWithVoicevox } from './voicevox'

// ---- AudioContext の代役 ----------------------------------------------------
// 再生した AudioBufferSourceNode を記録して「鳴ったか」「止められたか」を観測する。
const started: { stopped: boolean }[] = []

function makeFakeCtx() {
  return {
    state: 'running' as AudioContextState,
    currentTime: 0,
    resume: vi.fn(async () => {}),
    decodeAudioData: vi.fn(async () => ({ duration: 0.4 }) as unknown as AudioBuffer),
    createGain: () => ({ gain: { value: 0 }, connect: vi.fn() }),
    createBufferSource: () => {
      const rec = { stopped: false }
      return {
        buffer: null as AudioBuffer | null,
        connect: vi.fn(),
        onended: null,
        start: vi.fn(() => { started.push(rec) }),
        stop: vi.fn(() => { rec.stopped = true }),
        // 最後のチャンクの完了待ちを即座に解決させる（実際の再生時間は待たない）
        addEventListener: vi.fn((_ev: string, cb: () => void) => { cb() }),
      }
    },
  }
}

let fakeCtx = makeFakeCtx()
vi.mock('./alertSound', () => ({
  getAudioContext: () => fakeCtx,
  getMasterInput: () => ({ connect: vi.fn() }),
}))

// 句区切り辞書は先行合成の対象外の話なので、常に「未取得」にして経路を通さない
vi.mock('./ttsPhraseBreakDict', () => ({
  loadTtsPhraseBreakDict: async () => null,
  getTtsPhraseBreakDictCache: () => null,
  findPhraseBreakMatch: () => null,
  isPlaceNameKey: () => false,
}))

// ---- fetch の代役 ----------------------------------------------------------
const fetched: string[] = []
let synthesisDelay = 0

function installFetch() {
  fetched.length = 0
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const signal = init?.signal
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    fetched.push(url.replace(/^.*?\/(audio_query|synthesis).*$/, '$1'))
    if (/audio_query/.test(url)) {
      return { ok: true, json: async () => ({ accent_phrases: [] }) } as unknown as Response
    }
    // 合成には時間がかかる。abort されたらそこで失敗させる（実装と同じ扱いにする）
    if (synthesisDelay > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, synthesisDelay)
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) })
      })
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Response
  }) as unknown as typeof fetch
}

/** audio_query / synthesis が何回走ったか。 */
function counts() {
  return {
    query: fetched.filter(f => f === 'audio_query').length,
    synth: fetched.filter(f => f === 'synthesis').length,
  }
}

beforeEach(() => {
  started.length = 0
  synthesisDelay = 0
  fakeCtx = makeFakeCtx()
  installFetch()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('先行合成', () => {
  it('最初のひと区切りだけを合成する（残りは再生側に任せる）', async () => {
    const pre = prewarmVoicevox('http://x', '地震情報。石川県能登地方で地震。深さは十キロメートル。', 1)
    expect(pre).not.toBeNull()
    await pre!.first
    // 1 チャンク分（audio_query → synthesis）だけで止まる
    expect(counts()).toEqual({ query: 1, synth: 1 })
  })

  it('進行中の再生を止めない', async () => {
    // 先に鳴らしておく
    await speakWithVoicevox('http://x', '大津波警報。', 1, 1)
    expect(started).toHaveLength(1)
    expect(started[0].stopped).toBe(false)

    // 間を置いている最中の先行合成では、鳴っているものに触らない
    const pre = prewarmVoicevox('http://x', '地震情報。', 1)
    await pre!.first
    expect(started[0].stopped).toBe(false)
  })

  it('先行合成した音声を使うので、再生時に合成し直さない', async () => {
    const text = '地震情報。'
    const pre = prewarmVoicevox('http://x', text, 1)
    await pre!.first
    expect(counts()).toEqual({ query: 1, synth: 1 })

    await speakWithVoicevox('http://x', text, 1, 1, pre)
    // 1 チャンクのテキストなので、再生時の合成は増えない
    expect(counts()).toEqual({ query: 1, synth: 1 })
    expect(started).toHaveLength(1)
  })

  it('合成の途中で打ち切られたら、再生側で作り直す（無音にしない）', async () => {
    synthesisDelay = 5_000
    const text = '地震情報。'
    const pre = prewarmVoicevox('http://x', text, 1)
    // 合成が始まるのを待ってから打ち切る（実際に打ち切られるのはこの状態）
    await vi.waitFor(() => expect(counts().synth).toBe(1))
    pre!.abort()
    await expect(pre!.first).resolves.toBeNull()

    synthesisDelay = 0
    await speakWithVoicevox('http://x', text, 1, 1, pre)
    // 作り直したぶんが増え、ちゃんと鳴っている
    expect(counts().synth).toBe(2)
    expect(started).toHaveLength(1)
  })

  it('合成が始まる前に打ち切られても、再生側で作り直す', async () => {
    const text = '地震情報。'
    const pre = prewarmVoicevox('http://x', text, 1)
    pre!.abort()  // 辞書の待ちが明ける前なので、最初の要求すら飛んでいない
    await expect(pre!.first).resolves.toBeNull()

    await speakWithVoicevox('http://x', text, 1, 1, pre)
    expect(counts()).toEqual({ query: 1, synth: 1 })
    expect(started).toHaveLength(1)
  })

  it('テキストが違う先行合成は使わない', async () => {
    const pre = prewarmVoicevox('http://x', '津波警報。', 1)
    await pre!.first
    const before = counts().synth

    await speakWithVoicevox('http://x', '地震情報。', 1, 1, pre)
    expect(counts().synth).toBeGreaterThan(before)
    expect(started).toHaveLength(1)
  })

  it('使わなかった先行合成は、次の読み上げが始まるときに打ち切る', async () => {
    // 打ち切りを観測するため、合成が終わらないうちに別の読み上げを始める
    synthesisDelay = 10_000
    const orphan = prewarmVoicevox('http://x', '長周期地震動情報。', 1)

    synthesisDelay = 0
    await speakWithVoicevox('http://x', '大津波警報。', 1, 1)

    // 打ち切られた側は null に解決する（待たされ続けない）
    await expect(orphan!.first).resolves.toBeNull()
  })

  it('自分の先行合成は打ち切らない', async () => {
    const text = '大津波警報。'
    const pre = prewarmVoicevox('http://x', text, 1)
    await speakWithVoicevox('http://x', text, 1, 1, pre)
    // 打ち切られていれば作り直しで synthesis が 2 回になる。1 回なら使えている
    expect(counts()).toEqual({ query: 1, synth: 1 })
    expect(started).toHaveLength(1)
  })

  it('ほぼ同時に 2 件届いても、先に始まった側の先行合成を後から始まった側が打ち切らない', async () => {
    // 地震情報と長周期地震動はほぼ同時に届く。実測（本番ビルド）で「最初の音まで 2820ms」と
    // なる回があり、後から始まった読み上げが、先に始まった側がこれから使う先行合成を
    // 打ち切っていた。打ち切られた側は作り直すので無音にはならないが、先に合成した意味が
    // 失われ、待ちが先行合成の無かった頃より長くなる。
    // 合成がまだ終わっていない（＝ activePrewarms に残っている）状況を作る
    synthesisDelay = 300
    const quake = prewarmVoicevox('http://x', '地震情報。', 1)
    const lpgm = prewarmVoicevox('http://x', '長周期地震動情報。', 1)
    await vi.waitFor(() => expect(counts().synth).toBe(2))

    // 地震情報の再生が始まる（この時点で長周期の先行合成は打ち切られてよい）
    const quakePlay = speakWithVoicevox('http://x', '地震情報。', 1, 1, quake)
    // 直後に長周期の再生が始まっても、地震情報がこれから使うものは残す
    const lpgmPlay = speakWithVoicevox('http://x', '長周期地震動情報。', 1, 1, lpgm)
    await Promise.all([quakePlay, lpgmPlay])

    // 使われた側は打ち切られず、作り直しにもなっていない
    await expect(quake!.first).resolves.not.toBeNull()
    // 使われなかった側（長周期の先行合成）は打ち切られ、再生側で作り直している
    await expect(lpgm!.first).resolves.toBeNull()
  })
})
