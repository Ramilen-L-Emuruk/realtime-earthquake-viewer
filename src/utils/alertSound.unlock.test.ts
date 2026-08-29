import { describe, it, expect, beforeAll } from 'vitest'

// `unlockAudio()` がマスターチェーンと残響を「音を鳴らす前に」作ることの検証。
//
// **なぜ専用ファイルなのか。** alertSound は `_master` / `_reverb` をモジュール変数に
// キャッシュするため、一度でも音を鳴らすと以後は生成されない。同じファイルに他の
// テストを置くと、それらが先に音を鳴らして生成済みにしてしまい、`unlockAudio()` の
// 中身を空にしても通る「空振りするテスト」になる（実際に一度そうなった）。
// Vitest はファイル単位でモジュールを分離するため、ここに 1 件だけ置いて守る。
//
// 守っているのは次の性質。Chrome の DynamicsCompressorNode は生成直後の約 0.4 秒だけ
// アタックを 8 dB ほど潰すため、最初の音を鳴らす瞬間にチェーンを作ると 1 発目だけ
// 小さく鳴る（EEW の初報がそれに当たると、いちばん聞かせたい音が鈍る）。

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
  readonly sampleRate = 48000
  currentTime = 10
  state = 'running'
  readonly destination = new FakeNode()

  gains = 0
  oscillators = 0
  compressors = 0
  convolvers = 0
  resumeCalls = 0

  resume(): Promise<void> { this.resumeCalls++; this.state = 'running'; return Promise.resolve() }
  createGain(): FakeNode & { gain: FakeAudioParam } {
    this.gains++
    return Object.assign(new FakeNode(), { gain: new FakeAudioParam() })
  }
  createOscillator(): FakeNode & { type: string; frequency: FakeAudioParam } {
    this.oscillators++
    return Object.assign(new FakeNode(), { type: 'sine', frequency: new FakeAudioParam() })
  }
  createBuffer(channels: number, length: number): { getChannelData: () => Float32Array } {
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return { getChannelData: (ch = 0) => data[ch] ?? data[0] }
  }
  createConvolver(): FakeNode & { buffer: unknown } {
    this.convolvers++
    return Object.assign(new FakeNode(), { buffer: null as unknown })
  }
  createDynamicsCompressor(): FakeNode {
    this.compressors++
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

describe('unlockAudio: 音を鳴らす前にマスターチェーンと残響を作る', () => {
  it('呼ぶ前は何も作られていない（前提の確認）', () => {
    expect(ctx.compressors).toBe(0)
    expect(ctx.convolvers).toBe(0)
  })

  it('unlockAudio() で compressor と残響 2 種が作られ、音は鳴らない', () => {
    sound.unlockAudio()
    expect(ctx.compressors).toBe(1)
    // 情報系（hall）と EEW の穏やかな音（tight）。片方だけだと、その音を初めて
    // 鳴らす発報でバッファ生成が走る
    expect(ctx.convolvers).toBe(2)
    // 事前生成であって発音ではない。オシレータを作ってはいけない
    expect(ctx.oscillators).toBe(0)
  })

  it('繰り返し呼んでも作り直さない（冪等）', () => {
    sound.unlockAudio()
    sound.unlockAudio()
    expect(ctx.compressors).toBe(1)
    expect(ctx.convolvers).toBe(2)
    expect(ctx.oscillators).toBe(0)
  })

  it('その後で音を鳴らしても compressor は作り直されない', () => {
    sound.playAlertSound('eewUpdate')
    expect(ctx.compressors).toBe(1)
    expect(ctx.oscillators).toBeGreaterThan(0)
  })
})
