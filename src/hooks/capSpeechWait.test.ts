// 発話の完了待ち（`capSpeechWait`）そのものの振る舞い。
//
// **ここだけは関数を直接呼ぶ。** 読み上げ全体を通したテスト
// （`useLiveEventHandler.ttsPriority.test.ts` ほか）では、待ち合わせのループが相手の解決に
// 連動して進むため「同じ理由で待ち続けたまま相手だけが入れ替わる」状況を作れなかった。
// 延長の上限はまさにその形で破れるので、穴を再現できる粒度まで下ろしている。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 音が出ているかはモックで切り替える（実物は再生中の音源を数える）
let audioPlaying = false
vi.mock('../utils/voicevox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/voicevox')>()),
  isAudioPlaying: () => audioPlaying,
}))

// トップレベルで一度読む（テスト本体で初めて読むと、モジュールの解決が 1 件目の所要時間に
// 乗って時間切れになる）
import { capSpeechWait, SPEECH_WAIT_HARD_CAP_MS, EEW_SPEECH_CHAIN_MAX_WAIT_MS } from './useLiveEventHandler'

/** 解決しない Promise（＝待ち続ける相手）。 */
function never<T>(): Promise<T> {
  return new Promise<T>(() => { /* 解決しない */ })
}

beforeEach(() => {
  vi.useFakeTimers()
  audioPlaying = false
})

afterEach(() => {
  vi.useRealTimers()
})

describe('発話の完了待ち', () => {
  // 対照: 音が出ていなければ、上限で打ち切る（合成が返ってこないときの保険）
  it('音が出ていなければ、上限で打ち切る', async () => {
    const waited = capSpeechWait(never(), 8000)
    let done = false
    void waited.then(() => { done = true })

    await vi.advanceTimersByTimeAsync(7000)
    await Promise.resolve()
    expect(done).toBe(false)

    await vi.advanceTimersByTimeAsync(2000)
    expect(await waited).toBeUndefined()
  })

  // 正: 音が出ている間は、上限を過ぎても待つ
  it('音が出ている間は、上限を過ぎても待つ', async () => {
    audioPlaying = true
    const waited = capSpeechWait(never(), 8000)
    let done = false
    void waited.then(() => { done = true })

    await vi.advanceTimersByTimeAsync(60000)
    await Promise.resolve()
    expect(done).toBe(false)

    // 鳴り止めば明ける
    audioPlaying = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(await waited).toBeUndefined()
  })

  // 安全弁: 鳴り続けても、延長の上限で打ち切る
  it('音が鳴り続けても、延長の上限で打ち切る', async () => {
    audioPlaying = true
    const waited = capSpeechWait(never(), 8000)
    let done = false
    void waited.then(() => { done = true })

    await vi.advanceTimersByTimeAsync(SPEECH_WAIT_HARD_CAP_MS - 5000)
    await Promise.resolve()
    expect(done).toBe(false)

    await vi.advanceTimersByTimeAsync(10000)
    expect(await waited).toBeUndefined()
  })

  // 安全弁: **延長の上限の起点は、呼び出しではなく渡された「待ち始め」。**
  //
  // 待ち合わせのループは相手が入れ替わるたびに呼び直す。呼び出しごとに起点を取り直すと、
  // **入れ替わるたびに上限が振り出しに戻って事実上無くなる**。
  it('延長の上限は、渡された待ち始めを起点に測る', async () => {
    audioPlaying = true
    // 待ち始めは「もう上限に達している」過去の時刻
    const waitingSince = Date.now() - SPEECH_WAIT_HARD_CAP_MS
    const waited = capSpeechWait(never(), 8000, waitingSince)

    // 上限（8 秒）に達した時点で、既に延長の余地は無い
    await vi.advanceTimersByTimeAsync(8000 + 500)
    expect(await waited).toBeUndefined()
  })

  // 対照: 待ち始めを渡さなければ、この呼び出しの開始が起点（単発の呼び出し向けの既定）
  it('待ち始めを渡さなければ、この呼び出しの開始が起点になる', async () => {
    audioPlaying = true
    const waited = capSpeechWait(never(), 8000)
    let done = false
    void waited.then(() => { done = true })

    // 上の例と同じだけ進めても、起点が「いま」なのでまだ明けない
    await vi.advanceTimersByTimeAsync(8000 + 500)
    await Promise.resolve()
    expect(done).toBe(false)

    audioPlaying = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(await waited).toBeUndefined()
  })

  // 相手が先に解決したら、上限を待たずにその値を返す
  it('相手が解決したら、その値を返す', async () => {
    const waited = capSpeechWait(Promise.resolve('done'), EEW_SPEECH_CHAIN_MAX_WAIT_MS)
    expect(await waited).toBe('done')
  })
})
