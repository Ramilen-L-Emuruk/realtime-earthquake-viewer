import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { log } from './logger'

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
  // ユニゾンの離調（同じ周波数を左右へわずかにずらす）で使う
  readonly detune = new FakeAudioParam()
  startedAt: number | null = null
  stoppedAt: number | null = null
  start(t: number): void { this.startedAt = t }
  stop(t: number): void { this.stoppedAt = t }
}

class FakePannerNode extends FakeNode { readonly pan = { value: 0 } }

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
  readonly panners: FakePannerNode[] = []
  compressors = 0
  convolvers = 0

  resume(): Promise<void> { this.state = 'running'; return Promise.resolve() }
  createStereoPanner(): FakePannerNode { const n = new FakePannerNode(); this.panners.push(n); return n }
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
    this.panners.length = 0
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

describe('通知音: 刷新で入れたもの（正）', () => {
  // 正: 「電子音っぽい・薄い」への手当てとして入れた 3 点を固定する。
  // どれも耳では確かめられても、外すと静かに元の質感へ戻る。

  it('ピアノ系の基音はユニゾン（わずかに離調した 2 本を伴う）', () => {
    sound.playAlertSound('eewUpdate')   // darkPiano の単音
    // 基音 349.2Hz のすぐ隣（±0.3% 以内・完全一致は除く）に 2 本。
    // 単一オシレータに戻すとうねりが消え、「電子音っぽさ」が返ってくる
    const detuned = ctx.oscillators.filter(o =>
      o.frequency.value !== 349.2 && Math.abs(o.frequency.value - 349.2) < 349.2 * 0.003)
    expect(detuned).toHaveLength(2)
  })

  it('警報アラームは左右へ振り分ける（モノラルで鳴らさない）', () => {
    sound.playAlertSound('eew')
    expect(ctx.panners.length).toBeGreaterThan(0)
    const pans = ctx.panners.map(p => p.pan.value)
    expect(pans.some(v => v < 0)).toBe(true)
    expect(pans.some(v => v > 0)).toBe(true)
  })

  it('EEW 特別警報は前置きを持たない（周波数を動かすオシレータが 1 本も無い）', () => {
    // 旧構成は「低音上昇 55→110Hz」と「スイープ 150→800Hz」で 0.68 秒を使っていた。
    // どちらも周波数の自動化を持つため、残っていればここで捕まる。
    sound.playAlertSound('eewSpecial')
    const swept = ctx.oscillators.filter(o => o.frequency.events.length > 0)
    expect(swept).toHaveLength(0)
  })
})

describe('通知音: 声部構成（対照）', () => {
  // 対照: 本数はレシピそのもの。音色を作り変えるときに、関係ない種別まで
  // 巻き込んで構成が変わっていないかをここで見る。

  it('津波警報は 6 声部 × 3 回の 18 本', () => {
    sound.playAlertSound('tsunami')
    expect(ctx.oscillators).toHaveLength(18)
  })

  it('大津波警報は 6 声部 × 5 回の 30 本', () => {
    sound.playAlertSound('tsunamiMajor')
    expect(ctx.oscillators).toHaveLength(30)
  })

  it('津波予報は段階が下がるぶん声部が減り 4 声部 × 2 回の 8 本', () => {
    // レベル 0 の声部（subDeep / high）はオシレータを作らない。
    // 全段階が同じ本数になっていたら、段階ごとの作り分けが効いていない
    sound.playAlertSound('tsunamiForecast')
    expect(ctx.oscillators).toHaveLength(8)
  })

  it('津波の声部数は段階が下がるほど減る（打ち間違いで消えた声部を捕まえる）', () => {
    // SWEEP_VOICINGS のレベル 0 は「その段階では使わない」という正当な指定だが、
    // 実行時のログでは「意図した 0」と「打ち間違いの 0」を区別できない。
    // 段階間の大小関係を固定して、静かに声部が消える変更をここで止める。
    const voices = (type: Parameters<typeof sound.playAlertSound>[0], repeats: number): number => {
      ctx.reset()
      sound.playAlertSound(type)
      return ctx.oscillators.length / repeats
    }
    const major    = voices('tsunamiMajor', 5)
    const warning  = voices('tsunami', 3)
    const watch    = voices('tsunamiWatch', 2)
    const forecast = voices('tsunamiForecast', 2)
    expect([major, warning, watch, forecast]).toEqual([6, 6, 5, 4])
    expect(major).toBeGreaterThanOrEqual(warning)
    expect(warning).toBeGreaterThanOrEqual(watch)
    expect(watch).toBeGreaterThanOrEqual(forecast)
  })

  it('EEW 特別警報は低音の支えを 9 連打より先にスケジュールする', () => {
    // 連打の途中で例外が出ても低音だけは鳴るようにするため、順序に意味がある。
    // 後ろに置くと、最も重い警報が低音を失った状態で途切れる
    sound.playAlertSound('eewSpecial')
    expect(ctx.oscillators[0].frequency.value).toBe(58)
  })

  it('S 波カウントダウン 残り1秒はパルス 6×4 本 + 重ね 4 本の 28 本', () => {
    sound.playCountdownBeep(1)
    expect(ctx.oscillators).toHaveLength(28)
  })

  it('揺れ検知は据え置き（打撃 2 音 + シマーの 7 本）', () => {
    // 打撃・純音系（impact / ding）はこの刷新の対象外。変わっていたら巻き込み
    sound.playAlertSound('kyoshin')
    expect(ctx.oscillators).toHaveLength(7)
  })
})

describe('通知音: 津波の段階は掃引の形で聞き分ける', () => {
  // 周波数と回数だけで差を付けていた頃（大津波 200→500Hz × 5 回 / 津波 260→560Hz × 3 回）は、
  // 掃引の途中で互いの音域を通過するため冒頭の 1〜2 秒で判別できなかった。
  // 形（最高音に達する位置）とテンポで分けるのが弁別の要。

  /** 1 声部の「開始 → 最高音 → 開始値へ戻る」から、最高音に達する位置の比を取る */
  const peakRatio = (osc: FakeOscillatorNode): number => {
    const ev = osc.frequency.events
    expect(ev).toHaveLength(3)
    return (ev[1].time - ev[0].time) / (ev[2].time - ev[0].time)
  }
  /** 1 声部が受け持つ 1 周期の長さ */
  const cycleDur = (osc: FakeOscillatorNode): number => {
    const ev = osc.frequency.events
    return ev[2].time - ev[0].time
  }

  it('大津波警報は上昇主体（周期の 88% まで上がり続ける）', () => {
    sound.playAlertSound('tsunamiMajor')
    expect(ctx.oscillators).toHaveLength(30)   // 6 声部 × 5 回（回数は据え置き）
    for (const osc of ctx.oscillators) expect(peakRatio(osc)).toBeCloseTo(0.88, 2)
  })

  it('津波警報・注意報・予報は往復（周期の 55% で折り返す）', () => {
    for (const type of ['tsunami', 'tsunamiWatch', 'tsunamiForecast'] as const) {
      const before = ctx.oscillators.length
      sound.playAlertSound(type)
      const added = ctx.oscillators.slice(before)
      expect(added.length).toBeGreaterThan(0)
      for (const osc of added) expect(peakRatio(osc)).toBeCloseTo(0.55, 2)
    }
  })

  it('大津波警報と津波警報の折り返し点は十分に離れている（揃えると弁別が消える）', () => {
    sound.playAlertSound('tsunami')
    const warning = peakRatio(ctx.oscillators[0])
    const n = ctx.oscillators.length
    sound.playAlertSound('tsunamiMajor')
    const major = peakRatio(ctx.oscillators[n])
    expect(Math.abs(major - warning)).toBeGreaterThan(0.25)
  })

  it('大津波警報の 1 周期は津波警報の半分以下（テンポでも差を付ける）', () => {
    sound.playAlertSound('tsunami')
    const warning = cycleDur(ctx.oscillators[0])
    const n = ctx.oscillators.length
    sound.playAlertSound('tsunamiMajor')
    const major = cycleDur(ctx.oscillators[n])
    expect(major).toBeLessThanOrEqual(warning * 0.5)
  })
})

describe('通知音: 残響の掛け方', () => {
  // 音階を持つ音だけが残響を通る。**警報アラームと津波サイレンは通さない**
  // ——警報として乾いた質感を保つため。
  it('地震情報（pianoNote 4 音）は 1 音あたり 10 本（ユニゾン3 + 攻撃1 + 倍音3 + サブ1 + 残響送り2）', () => {
    sound.playAlertSound('earthquake')
    expect(ctx.oscillators).toHaveLength(40)
  })

  it('EEW 続報（darkPiano 単音）はユニゾン3 + 倍音2 + 残響送り1 の 6 本', () => {
    sound.playAlertSound('eewUpdate')
    expect(ctx.oscillators).toHaveLength(6)
  })

  it('EEW 予報は同じ構成の 2 音で 12 本', () => {
    sound.playAlertSound('eewForecast')
    expect(ctx.oscillators).toHaveLength(12)
  })
})

describe('通知音: 不正な音量の扱い（安全弁）', () => {
  // 0 は音量スライダーを絞り切った正当な状態。NaN と負値は必ずどこかの計算ミスで、
  // 同じ無言の早期 return に合流させると、声部が消えたことに誰も気づけない。
  // 判定と「報告する値」は decayTone / gateTone / sweep の 3 つで揃えてある。

  it('音量 0 では警告を出さない（正当な設定）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      sound.setSoundVolume(0)
      sound.playAlertSound('eewUpdate')
      expect(ctx.oscillators).toHaveLength(0)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('音量が NaN になると警告して鳴らさない（無言で全音が消えない）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      // setSoundVolume のクランプ（Math.min / Math.max）は NaN を素通しする
      sound.setSoundVolume(NaN)
      sound.playAlertSound('eewUpdate')   // decayTone 経路
      expect(ctx.oscillators).toHaveLength(0)
      // 報告するのはスケール後の peak（生の gain ではない）
      expect(warn.mock.calls.some(c => String(c[0]).includes('decayTone: peak が不正'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('警報アラームと掃引サイレンでも同じ扱い', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      sound.setSoundVolume(NaN)
      sound.playAlertSound('eew')       // gateTone 経路
      sound.playAlertSound('tsunami')   // sweep 経路
      expect(ctx.oscillators).toHaveLength(0)
      const messages = warn.mock.calls.map(c => String(c[0]))
      expect(messages.some(m => m.includes('gateTone: peak が不正'))).toBe(true)
      expect(messages.some(m => m.includes('sweep: peak が不正'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('通知音: StereoPanner が無い環境（安全弁）', () => {
  // 安全弁: 左右への振り分けは音を良くするための飾りであって、必須ではない。
  // createStereoPanner を持たない実行環境で音が丸ごと落ちないこと。
  it('マスターへ直結して鳴らす（無音にならない）', () => {
    const key = 'createStereoPanner'
    ;(ctx as unknown as Record<string, unknown>)[key] = undefined
    try {
      sound.playAlertSound('eew')
      expect(ctx.oscillators.length).toBeGreaterThan(0)
      expect(ctx.panners).toHaveLength(0)
    } finally {
      delete (ctx as unknown as Record<string, unknown>)[key]
    }
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
    // eewUpdate の gain は 0.26。基音はユニゾン 3 本に配分され、主音がその 0.66 倍を
    // 受け持つ。倍率が 1 に丸められていればこの値を超えない
    expect(max).toBeCloseTo(0.26 * 0.66, 5)
  })
})
