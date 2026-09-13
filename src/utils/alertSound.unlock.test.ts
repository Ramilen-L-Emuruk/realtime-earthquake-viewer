import { describe, it, expect, beforeAll, vi } from 'vitest'
import { log } from './logger'

// `unlockAudio()` がマスターチェーンを「音を鳴らす前に」作ることの検証。
//
// **なぜ専用ファイルなのか。** alertSound は `_master` をモジュール変数にキャッシュする
// ため、一度でも音を鳴らすと以後は生成されない。同じファイルに他のテストを置くと、
// それらが先に音を鳴らして生成済みにしてしまい、`unlockAudio()` の中身を空にしても
// 通る「空振りするテスト」になる（実際に一度そうなった）。
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

class FakeBufferSourceNode extends FakeNode {
  buffer: { getChannelData: () => Float32Array } | null = null
  loop = false
  started = false
  stopped = false
  onended: (() => void) | null = null
  start(): void { this.started = true }
  stop(): void { this.stopped = true }
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
  readonly bufferSources: FakeBufferSourceNode[] = []
  // キープアライブの失敗パスを試すためのフラグ。実プロダクトの createBufferSource()
  // が例外を投げうるケース（実装差異等）を模す
  throwOnCreateBufferSource = false

  resume(): Promise<void> { this.resumeCalls++; this.state = 'running'; return Promise.resolve() }
  createGain(): FakeNode & { gain: FakeAudioParam } {
    this.gains++
    return Object.assign(new FakeNode(), { gain: new FakeAudioParam() })
  }
  createOscillator(): FakeNode & { type: string; frequency: FakeAudioParam } {
    this.oscillators++
    return Object.assign(new FakeNode(), { type: 'sine', frequency: new FakeAudioParam() })
  }
  createBufferSource(): FakeBufferSourceNode {
    if (this.throwOnCreateBufferSource) throw new Error('createBufferSource に失敗（テスト用）')
    const n = new FakeBufferSourceNode()
    this.bufferSources.push(n)
    return n
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

describe('unlockAudio: 音を鳴らす前にマスターチェーンを作る', () => {
  it('呼ぶ前は何も作られていない（前提の確認）', () => {
    expect(ctx.compressors).toBe(0)
    expect(ctx.convolvers).toBe(0)
    expect(ctx.bufferSources).toHaveLength(0)
  })

  it('unlockAudio() で compressor が作られ、音は鳴らない', () => {
    sound.unlockAudio()
    expect(ctx.compressors).toBe(1)
    // 残響は全系統で廃した。ここで作られていたら、どこかに戻っている
    expect(ctx.convolvers).toBe(0)
    // 事前生成であって発音ではない。オシレータを作ってはいけない
    expect(ctx.oscillators).toBe(0)
    // setKeepAliveEnabled() を誰も呼んでいないので、この時点ではキープアライブも作らない
    expect(ctx.bufferSources).toHaveLength(0)
  })

  it('繰り返し呼んでも作り直さない（冪等）', () => {
    sound.unlockAudio()
    sound.unlockAudio()
    expect(ctx.compressors).toBe(1)
    expect(ctx.convolvers).toBe(0)
    expect(ctx.oscillators).toBe(0)
  })

  it('その後で音を鳴らしても compressor は作り直されない', () => {
    sound.playAlertSound('eewUpdate')
    expect(ctx.compressors).toBe(1)
    expect(ctx.oscillators).toBeGreaterThan(0)
  })
})

describe('キープアライブ: soundEnabled/voicevoxEnabled と音量が揃ったときだけ鳴らす', () => {
  // 対照: setKeepAliveEnabled(true) を呼ぶまでは作られない（前の describe で
  // unlockAudio() は既に複数回呼ばれているが、それだけでは発火しないことの確認でもある）
  it('setKeepAliveEnabled(true) を呼ぶまでは作られない', () => {
    expect(ctx.bufferSources).toHaveLength(0)
  })

  // 正: 実体のある（全ゼロでない）波形でループ再生が始まる。createBuffer() のサンプルは
  // 既定で全て 0 のため、書き込みを忘れると「無音のループ」という見た目だけの
  // キープアライブになり、実機の遅延症状に効かない（一度踏んだ罠）
  it('setKeepAliveEnabled(true) で非ゼロの波形の AudioBufferSourceNode が 1 つ作られる', () => {
    sound.setKeepAliveEnabled(true)
    expect(ctx.bufferSources).toHaveLength(1)
    const [keepAlive] = ctx.bufferSources
    expect(keepAlive.loop).toBe(true)
    expect(keepAlive.started).toBe(true)
    const data = keepAlive.buffer?.getChannelData() ?? new Float32Array(0)
    expect(data.length).toBeGreaterThan(0)
    expect(data.some(v => v !== 0)).toBe(true)
  })

  // 安全弁: 繰り返し呼んでも 2 つ目を作らない（冪等）
  it('繰り返し有効化しても作り直さない', () => {
    sound.setKeepAliveEnabled(true)
    sound.setKeepAliveEnabled(true)
    expect(ctx.bufferSources).toHaveLength(1)
  })

  // 正: 音量 0（既存の「音量0=無音」契約）では、通知音・読み上げが有効でも鳴らす意味が
  // 無いため止める
  it('setSoundVolume(0) で稼働中のループ音源を停止する', () => {
    const [keepAlive] = ctx.bufferSources
    sound.setSoundVolume(0)
    expect(keepAlive.stopped).toBe(true)
  })

  // 対照: 音量を戻しても soundEnabled/voicevoxEnabled 側が無効なままなら再開しない
  it('setKeepAliveEnabled(false) の状態で音量を戻しても再開しない', () => {
    sound.setKeepAliveEnabled(false)
    sound.setSoundVolume(1)
    expect(ctx.bufferSources).toHaveLength(1) // 停止済みの 1 つのみ、新規は無い
  })

  it('両方揃えば再開する（新しいループ音源が 1 つ増える）', () => {
    sound.setKeepAliveEnabled(true)
    expect(ctx.bufferSources).toHaveLength(2)
    expect(ctx.bufferSources[1].started).toBe(true)
    expect(ctx.bufferSources[1].stopped).toBe(false)
  })
})

describe('キープアライブ: 失敗しても例外を外へ投げず、次の機会に立て直す', () => {
  it('createBufferSource が失敗しても外へ投げず、警告だけ残す', () => {
    sound.setKeepAliveEnabled(false) // 一旦止めて素の状態に戻す
    const before = ctx.bufferSources.length
    ctx.throwOnCreateBufferSource = true
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(() => sound.setKeepAliveEnabled(true)).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    expect(ctx.bufferSources).toHaveLength(before) // 失敗したので増えていない
    warnSpy.mockRestore()
  })

  it('その後の再同期（設定変更）で正常に復帰する', () => {
    ctx.throwOnCreateBufferSource = false
    // 前のテストで失敗した状態のまま keepAliveWanted=true が残っているはずなので、
    // playAlertSound 等の発報経路を借りた再同期でも復帰できることを確認する
    sound.playAlertSound('eewUpdate')
    expect(ctx.bufferSources.some(b => b.loop && b.started && !b.stopped)).toBe(true)
  })
})

// 正: 音声割り込み等で外部要因により停止した場合（stopKeepAlive() を経由しない）の
// 立て直し。1巡目レビューの HIGH「静かに停止しても再起動手段が無い」の核心部分
describe('キープアライブ: onended で静かに停止しても次の同期で立て直す', () => {
  it('onended が発火すると参照を手放し、次の syncKeepAlive() で新しいループ音源が作られる', () => {
    const before = ctx.bufferSources.length
    const active = ctx.bufferSources[before - 1]
    expect(active.stopped).toBe(false) // 前提: まだ動いている（stop() は呼んでいない）

    // 音声割り込み等でブラウザ側からノードが停止した状況を模す
    active.onended?.()

    sound.syncKeepAlive()
    expect(ctx.bufferSources).toHaveLength(before + 1)
    const revived = ctx.bufferSources[before]
    expect(revived.loop).toBe(true)
    expect(revived.started).toBe(true)
  })
})
