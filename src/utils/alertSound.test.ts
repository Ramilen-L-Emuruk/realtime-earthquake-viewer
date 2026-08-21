import { describe, it, expect, beforeAll, beforeEach } from 'vitest'

// 通知音の合成（Web Audio API）の回帰テスト。
//
// 音そのものの良し悪しは耳でしか判断できないが、「クリックノイズの原因を再び
// 持ち込んでいないか」「gain 自動化の順序が壊れていないか」は機械的に固定できる。
// ここで固定しているのは次の 3 点。
//
//   正     : アタックの広帯域ノイズ（AudioBufferSourceNode）を誰も作らない
//   正     : すべての gain 自動化が最後に 0 へ落ちる（終端の段差＝ティックの防止）
//   安全弁 : 自動化イベントの時刻が単調非減少（順序違反は実行時例外になる）
//
// テストは AudioContext を偽装して自動化イベントを記録する。node 環境には
// window も AudioContext も無いため、モジュールの読み込み前に用意する。

interface AutomationEvent {
  kind: 'setValue' | 'linear' | 'exponential'
  value: number
  time: number
}

class FakeAudioParam {
  readonly events: AutomationEvent[] = []
  value = 1
  setValueAtTime(value: number, time: number): this {
    this.events.push({ kind: 'setValue', value, time }); return this
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ kind: 'linear', value, time }); return this
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    this.events.push({ kind: 'exponential', value, time }); return this
  }
}

class FakeNode {
  connect(): void { /* 接続先は検証対象ではない */ }
  disconnect(): void { /* noop */ }
}

class FakeGainNode extends FakeNode { readonly gain = new FakeAudioParam() }

class FakeOscillatorNode extends FakeNode {
  type = 'sine'
  readonly frequency = new FakeAudioParam()
  startedAt: number | null = null
  stoppedAt: number | null = null
  start(t: number): void { this.startedAt = t }
  stop(t: number): void { this.stoppedAt = t }
}

class FakeBufferSourceNode extends FakeNode {
  buffer: unknown = null
  start(): void { /* noop */ }
  stop(): void { /* noop */ }
}

class FakeAudioContext {
  readonly sampleRate = 48000
  currentTime = 10        // 0 だと「時刻が入っていない」バグを見逃すため非 0 にする
  state = 'running'
  readonly destination = new FakeNode()

  readonly gains: FakeGainNode[] = []
  readonly oscillators: FakeOscillatorNode[] = []
  readonly bufferSources: FakeBufferSourceNode[] = []
  compressors = 0
  convolvers = 0

  resume(): Promise<void> { this.state = 'running'; return Promise.resolve() }
  createGain(): FakeGainNode { const n = new FakeGainNode(); this.gains.push(n); return n }
  createOscillator(): FakeOscillatorNode {
    const n = new FakeOscillatorNode(); this.oscillators.push(n); return n
  }
  createBufferSource(): FakeBufferSourceNode {
    const n = new FakeBufferSourceNode(); this.bufferSources.push(n); return n
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

  reset(): void {
    this.gains.length = 0
    this.oscillators.length = 0
    this.bufferSources.length = 0
  }
}

const ctx = new FakeAudioContext()

// getCtx() は `typeof window === 'undefined'` で null を返すため、window ごと用意する。
// audioCtx はモジュール内でキャッシュされるので、全テストがこの 1 つを共有する。
beforeAll(() => {
  ;(globalThis as unknown as { window: unknown }).window = { AudioContext: FakeAudioContext }
  // getCtx() が new する Ctx を、記録を読める唯一のインスタンスに差し替える
  ;(globalThis as unknown as { window: { AudioContext: unknown } }).window.AudioContext =
    function FakeCtor(this: unknown) { return ctx } as unknown as typeof FakeAudioContext
})

// 静的 import だと beforeAll より前に評価されるが、getCtx() は遅延実行なので問題ない
const sound = await import('./alertSound')

const ALL_TYPES = [
  'earthquake', 'earthquakePrompt', 'earthquakeInfo',
  'eew', 'eewUpdate', 'eewFinal', 'eewCancel', 'eewSpecial', 'eewForecast',
  'tsunami', 'tsunamiMajor', 'tsunamiWatch', 'tsunamiForecast', 'tsunamiUpdate', 'tsunamiCancel',
  'kyoshin', 'kyoshinCandidate',
  'specialInfo', 'specialInfoCommentary',
] as const

beforeEach(() => {
  ctx.reset()
  sound.setSoundVolume(1)
})

describe('通知音: アタックのノイズを持ち込まない', () => {
  // 正: プチプチの原因だった広帯域ノイズバースト（AudioBufferSourceNode）を
  // どの通知音も作らない。pianoNote / darkPiano / impact が持っていたもの。
  it.each(ALL_TYPES)('%s は AudioBufferSourceNode を作らない', (type) => {
    sound.playAlertSound(type)
    expect(ctx.bufferSources).toHaveLength(0)
  })

  it('震度更新音（全 21 段階）も AudioBufferSourceNode を作らない', () => {
    for (let index = 0; index <= 20; index++) sound.playKyoshinUpdateSound(index)
    expect(ctx.bufferSources).toHaveLength(0)
  })

  it('S 波カウントダウンも AudioBufferSourceNode を作らない', () => {
    for (const second of [5, 4, 3, 2, 1]) sound.playCountdownBeep(second)
    expect(ctx.bufferSources).toHaveLength(0)
  })
})

describe('通知音: gain 自動化の終端', () => {
  // 正: 指数減衰は 0 に到達できないため 0.001 で止めていたが、そのまま停止すると
  // 段差が残り無音区間にティックとして聞こえる。すべての gain が最後に 0 へ落ちること。
  it.each(ALL_TYPES)('%s のすべての gain が最後に 0 へ落ちる', (type) => {
    sound.playAlertSound(type)
    const used = ctx.gains.filter(g => g.gain.events.length > 0)
    expect(used.length).toBeGreaterThan(0)
    for (const g of used) {
      const last = g.gain.events[g.gain.events.length - 1]
      expect(last.value).toBe(0)
    }
  })

  it('震度更新音（震度7・7 音連打）のすべての gain が最後に 0 へ落ちる', () => {
    sound.playKyoshinUpdateSound(19)   // index 19 = 震度7
    const used = ctx.gains.filter(g => g.gain.events.length > 0)
    expect(used.length).toBeGreaterThan(0)
    for (const g of used) {
      expect(g.gain.events[g.gain.events.length - 1].value).toBe(0)
    }
  })
})

describe('通知音: 自動化イベントの順序（安全弁）', () => {
  // 安全弁: 時刻が巻き戻ると Web Audio は実行時例外を投げ、音が丸ごと落ちる。
  // decayTone のクランプ（end が attack より前に来る場合の下限）が守る不変条件。
  it.each(ALL_TYPES)('%s の自動化時刻が単調非減少', (type) => {
    sound.playAlertSound(type)
    for (const g of ctx.gains) {
      for (let i = 1; i < g.gain.events.length; i++) {
        expect(g.gain.events[i].time).toBeGreaterThanOrEqual(g.gain.events[i - 1].time)
      }
    }
  })

  it.each(ALL_TYPES)('%s は停止時刻が開始時刻より後', (type) => {
    sound.playAlertSound(type)
    for (const o of ctx.oscillators) {
      expect(o.startedAt).not.toBeNull()
      expect(o.stoppedAt).not.toBeNull()
      expect(o.stoppedAt as number).toBeGreaterThan(o.startedAt as number)
    }
  })
})

describe('通知音: 変更していない音は変わっていない（対照）', () => {
  // 対照: sweep だけで作る津波警報系には手を入れていない。オシレータ本数を固定して、
  // ノイズ除去や終端修正の巻き込みで構成が変わったら気づけるようにする。
  it('津波警報は sweep 3 本のみ', () => {
    sound.playAlertSound('tsunami')
    expect(ctx.oscillators).toHaveLength(3)
  })

  it('大津波警報は sweep 10 本（2 種 × 5 回）のみ', () => {
    sound.playAlertSound('tsunamiMajor')
    expect(ctx.oscillators).toHaveLength(10)
  })

  it('S 波カウントダウン 残り1秒はパルス 6 本 + サブ低音 + 高音の 8 本', () => {
    sound.playCountdownBeep(1)
    expect(ctx.oscillators).toHaveLength(8)
  })
})

describe('通知音: 情報系だけ残響を持つ', () => {
  // pianoNote は全音にわずかな残響（PIANO_ROOM_WET）を載せる。EEW 系（darkPiano）は
  // 警報として硬い質感を保つため、wet を明示しない音には残響を作らない。
  it('地震情報（pianoNote 4 音）は 1 音あたり 6 本のオシレータ（倍音 5 + 残響送り 1）', () => {
    sound.playAlertSound('earthquake')
    expect(ctx.oscillators).toHaveLength(24)
  })

  it('EEW 続報（darkPiano 単音・wet 指定なし）は残響送りを作らず 3 本だけ', () => {
    sound.playAlertSound('eewUpdate')
    expect(ctx.oscillators).toHaveLength(3)
  })

  it('EEW 予報は wet 指定があるため 1 音あたり 4 本（倍音 3 + 残響送り 1）', () => {
    sound.playAlertSound('eewForecast')
    expect(ctx.oscillators).toHaveLength(8)
  })
})

describe('unlockAudio: マスターチェーンを先に作る', () => {
  // DynamicsCompressor は生成から約 0.4 秒アタックを強く潰す。最初の音を鳴らす
  // 瞬間に作ると 1 発目だけ約 8 dB 小さく鳴るため、ユーザー操作の時点で作っておく。
  // 「まだ何も鳴らしていない状態から unlockAudio だけを呼ぶ」検証は、モジュールが
  // _master をキャッシュするためこのファイルでは成立しない（先行するテストが既に
  // 音を鳴らして生成済みにしてしまう）。専用ファイル alertSound.unlock.test.ts で行う。

  it('繰り返し呼んでも compressor を作り直さない（冪等）', () => {
    sound.unlockAudio()
    const after = ctx.compressors
    sound.unlockAudio()
    sound.unlockAudio()
    expect(ctx.compressors).toBe(after)
  })
})

describe('setSoundVolume', () => {
  it('0 を渡すと decayTone 系の音は 1 本もオシレータを作らない', () => {
    // 音量 0 では TAIL_FLOOR（0.001 = -60 dBFS）ぶんの残留すら鳴らさない。
    // 減衰の終端に 0.001 を置く構造上、素通しにすると絞り切っても微かに鳴る。
    sound.setSoundVolume(0)
    sound.playAlertSound('eewUpdate')
    expect(ctx.oscillators).toHaveLength(0)
  })

  it('範囲外の値は 0〜1 に丸める', () => {
    sound.setSoundVolume(5)
    sound.playAlertSound('eewUpdate')
    const max = Math.max(...ctx.gains.flatMap(g => g.gain.events.map(e => e.value)))
    // eewUpdate の基音ピークは gain 0.26。倍率が 1 に丸められていれば 0.26 を超えない
    expect(max).toBeCloseTo(0.26, 5)
  })
})
