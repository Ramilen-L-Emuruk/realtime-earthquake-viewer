import { describe, it, expect, beforeAll } from 'vitest'

// 残響の生成に失敗したときの振る舞いの検証。
//
// **なぜ専用ファイルなのか。** alertSound は残響の成否をモジュール変数
// （`_reverbs` / `_reverbFailed`）にキャッシュするため、一度でも成功すると以後は
// 失敗経路へ入らない。同じファイルに他のテストを置くと、それらが先に残響を作って
// しまい、失敗時の分岐を一度も通らない「空振りするテスト」になる
// （`alertSound.unlock.test.ts` を分けているのと同じ理由）。
//
// 守っているのは次の 2 つ。
//
//   正     : 一方の種類が失敗しても、もう一方は作られる
//            （`unlockAudio` が 2 種をまとめて 1 つの try に入れていたときは、
//             hall の失敗で tight の生成行に到達しなかった）
//   安全弁 : 失敗した種類は再試行しない
//            （成功時しかキャッシュに載らないため、記録しないと発報のたびに
//             数秒ぶんのバッファ合成をやり直す）

// hall は 2.9 秒・tight は 0.85 秒。長さで種類を見分けて hall だけ失敗させる。
const SAMPLE_RATE = 48000
const HALL_LENGTH = Math.floor(SAMPLE_RATE * 2.9)

class FakeAudioParam {
  value = 1
  setValueAtTime(): this { return this }
  linearRampToValueAtTime(): this { return this }
  exponentialRampToValueAtTime(): this { return this }
}

class FakeNode {
  connect(): void { /* 接続先は検証対象ではない */ }
}

class FakeAudioContext {
  readonly sampleRate = SAMPLE_RATE
  currentTime = 10
  state = 'running'
  readonly destination = new FakeNode()

  /** hall の長さで createBuffer が呼ばれた回数（＝ hall の生成を試みた回数） */
  hallAttempts = 0
  /** tight の長さで createBuffer が呼ばれた回数 */
  tightAttempts = 0
  convolvers = 0

  resume(): Promise<void> { this.state = 'running'; return Promise.resolve() }
  createGain(): FakeNode & { gain: FakeAudioParam } {
    return Object.assign(new FakeNode(), { gain: new FakeAudioParam() })
  }
  createOscillator(): FakeNode & { type: string; frequency: FakeAudioParam; detune: FakeAudioParam } {
    return Object.assign(new FakeNode(), {
      type: 'sine', frequency: new FakeAudioParam(), detune: new FakeAudioParam(),
      start(): void { /* noop */ }, stop(): void { /* noop */ },
    })
  }
  createStereoPanner(): FakeNode & { pan: { value: number } } {
    return Object.assign(new FakeNode(), { pan: { value: 0 } })
  }
  createBuffer(channels: number, length: number): { getChannelData: () => Float32Array } {
    if (length === HALL_LENGTH) {
      this.hallAttempts++
      // 実環境で起きうるのはメモリ不足等。種類を問わない失敗として例外を投げる
      throw new Error('テスト: hall の IR バッファを生成できない')
    }
    this.tightAttempts++
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return { getChannelData: (ch = 0) => data[ch] ?? data[0] }
  }
  createConvolver(): FakeNode & { buffer: unknown } {
    this.convolvers++
    return Object.assign(new FakeNode(), { buffer: null as unknown })
  }
  createDynamicsCompressor(): FakeNode {
    return Object.assign(new FakeNode(), {
      threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
      attack: { value: 0 }, release: { value: 0 },
    })
  }
}

const ctx = new FakeAudioContext()

beforeAll(() => {
  ;(globalThis as unknown as { window: unknown }).window = {
    AudioContext: function FakeCtor(this: unknown) { return ctx } as unknown as typeof AudioContext,
  }
})

const sound = await import('./alertSound')

describe('残響の生成に失敗したとき', () => {
  it('hall が失敗しても tight は作られる（unlockAudio が 2 種を独立して試す）', () => {
    sound.unlockAudio()
    expect(ctx.hallAttempts).toBe(1)
    expect(ctx.tightAttempts).toBe(1)
    // 作られた convolver は tight のぶんだけ
    expect(ctx.convolvers).toBe(1)
  })

  it('失敗した種類は再試行しない（発報のたびにバッファ合成をやり直さない）', () => {
    const before = ctx.hallAttempts
    // 情報系（pianoNote）は hall を要求する。何度鳴らしても再試行しない
    sound.setSoundVolume(1)
    sound.playAlertSound('earthquake')
    sound.playAlertSound('earthquake')
    sound.unlockAudio()
    expect(ctx.hallAttempts).toBe(before)
  })

  it('残響が無くても直接音は鳴る（警報を落とさない）', () => {
    let oscillators = 0
    const origCreate = ctx.createOscillator.bind(ctx)
    ;(ctx as unknown as { createOscillator: () => unknown }).createOscillator = () => {
      oscillators++
      return origCreate()
    }
    try {
      sound.playAlertSound('earthquake')
      // 残響送りの 2 本は作られないが、直接音（1 音あたり 8 本 × 4 音）は鳴る
      expect(oscillators).toBe(32)
    } finally {
      ;(ctx as unknown as { createOscillator: unknown }).createOscillator = origCreate
    }
  })
})
