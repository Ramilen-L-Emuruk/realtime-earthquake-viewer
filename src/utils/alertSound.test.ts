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
  connect(_dest?: unknown): void { /* 既定では接続先を記録しない */ }
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
  // 繋いだ先の gain。声部ごとの音量を検証するために記録する
  connectedTo: unknown = null
  connect(dest: unknown): void { this.connectedTo = dest }
  start(t: number): void { this.startedAt = t }
  stop(t: number): void { this.stoppedAt = t }
}

class FakePannerNode extends FakeNode { readonly pan = { value: 0 } }

// フィルタを通すのは marimba と warningBeep の 2 系統。ここが無いと例外になり、
// playGuarded が握り潰して「オシレータ 0 本」という形でしか症状が出ない。
class FakeBiquadFilterNode extends FakeNode {
  type = 'lowpass'
  readonly frequency = new FakeAudioParam()
  readonly Q = new FakeAudioParam()
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
  readonly panners: FakePannerNode[] = []
  readonly filters: FakeBiquadFilterNode[] = []
  compressors = 0
  convolvers = 0

  resume(): Promise<void> { this.state = 'running'; return Promise.resolve() }
  createStereoPanner(): FakePannerNode { const n = new FakePannerNode(); this.panners.push(n); return n }
  createBiquadFilter(): FakeBiquadFilterNode {
    const n = new FakeBiquadFilterNode(); this.filters.push(n); return n
  }
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
    this.filters.length = 0
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

/**
 * 震度更新音の段ごとに、その段へ落ちる強震モニタのインデックスを 1 つずつ。
 * 気象庁の階級（震度2以下 / 3 / 4 / 5弱 / 5強 / 6弱 / 6強 / 7）と 1 対 1 で並ぶ。
 */
const KYOSHIN_INDEX_BY_LEVEL = [9, 11, 13, 15, 16, 17, 18, 19] as const

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

  it('揺れ検知はマリンバ 2 音で 8 本（基音 + 上部 2 本 + サブ）', () => {
    sound.playAlertSound('kyoshin')
    expect(ctx.oscillators).toHaveLength(8)
    // フィルタを通すのはこの系統だけ。1 音につき 1 つ作る
    expect(ctx.filters).toHaveLength(2)
  })

  it('揺れ検知の予兆は単発なので 4 本（確定音の半分）', () => {
    sound.playAlertSound('kyoshinCandidate')
    expect(ctx.oscillators).toHaveLength(4)
    expect(ctx.filters).toHaveLength(1)
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

describe('通知音: 残響を持たない（全系統）', () => {
  // 残響は情報系と EEW の穏やかな音に載せていたが、連続して鳴る音では尾が重なって
  // 濁るため全廃した。**厚みはユニゾンと倍音だけで作る。**
  // ConvolverNode を 1 つでも作っていたら、どこかに残響が戻っている。

  it('地震情報（pianoNote 4 音）は 1 音あたり 8 本（ユニゾン3 + 攻撃1 + 倍音3 + サブ1）', () => {
    sound.playAlertSound('earthquake')
    expect(ctx.oscillators).toHaveLength(32)
    expect(ctx.convolvers).toBe(0)
  })

  it('EEW 続報（darkPiano 単音）はユニゾン3 + 倍音2 の 5 本', () => {
    sound.playAlertSound('eewUpdate')
    expect(ctx.oscillators).toHaveLength(5)
    expect(ctx.convolvers).toBe(0)
  })

  it('EEW 予報は同じ構成の 2 音で 10 本', () => {
    sound.playAlertSound('eewForecast')
    expect(ctx.oscillators).toHaveLength(10)
  })

  it('全種別を鳴らしても ConvolverNode を 1 つも作らない', () => {
    ALL_TYPES.forEach(t => sound.playAlertSound(t))
    expect(ctx.convolvers).toBe(0)
  })
})

describe('震度更新音: 震度5弱以上で低音が厚くなる', () => {
  // 旧実装は ding / dingDeep という別関数の選択だったが、いまは warningBeep の真偽値引数。
  // 取り違えても型では捕まらないので、効果そのものを固定する。

  /** ある周波数を鳴らしている声部の gain の最大値 */
  const peaksAt = (freqs: number[]): number[] =>
    ctx.oscillators
      .filter(o => freqs.some(f => Math.abs(o.frequency.value - f) < 1))
      .map(o => Math.max(...(o.connectedTo as FakeGainNode).gain.events.map(e => e.value)))

  /**
   * 基音に対するサブオクターブの厚み。**比で測る。**
   *
   * 段階ごとの音量は `BASE_GAIN.beep × BEEP_SEVERITY[段]` で決まるため、実測値を直に書くと
   * 音量設計を触るたびにこのテストが落ちる。ここで固定したいのは deep の効果だけなので、
   * 同じ呼び出しの中の比を見る。
   */
  const subRatio = (baseFreqs: number[]): number => {
    const base = Math.max(...peaksAt(baseFreqs))
    const sub = Math.max(...peaksAt(baseFreqs.map(f => f * 0.5)))
    return sub / base
  }

  it('正: 震度5弱はサブオクターブが厚い', () => {
    sound.playKyoshinUpdateSound(15)      // index 15 = 震度5弱（deep）
    const freqs = [587, 699, 784, 880]
    expect(peaksAt(freqs.map(f => f * 0.5))).toHaveLength(4)
    // deep のとき 0.45 倍。基音の最も厚い声部（矩形波 0.40 倍）との比は 0.45 / 0.40
    expect(subRatio(freqs)).toBeCloseTo(0.45 / 0.40, 5)
  })

  it('対照: 震度4は同じ音でもサブオクターブが薄い', () => {
    sound.playKyoshinUpdateSound(13)      // index 13 = 震度4（deep でない）
    const freqs = [587, 699, 784, 880]
    expect(peaksAt(freqs.map(f => f * 0.5))).toHaveLength(4)
    // deep でないとき 0.20 倍
    expect(subRatio(freqs)).toBeCloseTo(0.20 / 0.40, 5)
  })

  it('安全弁: 段階ごとの音数は変えていない（震度2以下 2 音 → 震度7 8 音）', () => {
    // 1 音 4 本。音数が変わると段階の勾配（音数・間隔・音量）が崩れる。
    // 震度4 と 5弱だけが並ぶ（`deep` の有無で分かれる）
    const counts = KYOSHIN_INDEX_BY_LEVEL.map(index => {
      ctx.reset()
      sound.playKyoshinUpdateSound(index)
      return ctx.oscillators.length / 4
    })
    expect(counts).toEqual([2, 3, 4, 4, 5, 6, 7, 8])
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

describe('通知音: 系統の割り当て', () => {
  // 系統は役割で分けてある。**どの音がどのプリミティブで作られるか**を声部数で固定する。
  // 数が変われば別の系統へ移ったということなので、意図した移動かどうかを立ち止まって考えられる。

  it('純音（正弦＋第2倍音）を使うのは津波の更新・解除と南海トラフの 2 種', () => {
    const cases: Array<[Parameters<typeof sound.playAlertSound>[0], number]> = [
      ['tsunamiUpdate', 4],          // 2 音 × 2 本
      ['tsunamiCancel', 4],          // 2 音 × 2 本
      ['specialInfo', 6],            // 3 音 × 2 本
      ['specialInfoCommentary', 4],  // 2 音 × 2 本
    ]
    for (const [type, count] of cases) {
      ctx.reset()
      sound.playAlertSound(type)
      expect(ctx.oscillators, type).toHaveLength(count)
      // 純音はフィルタを通さない
      expect(ctx.filters, type).toHaveLength(0)
    }
  })

  it('ピアノを使うのは地震そのものを伝える 3 種だけ', () => {
    const cases: Array<[Parameters<typeof sound.playAlertSound>[0], number]> = [
      ['earthquake', 32],        // 4 音 × 8 本
      ['earthquakePrompt', 24],  // 3 音 × 8 本
      ['earthquakeInfo', 16],    // 2 音 × 8 本
    ]
    for (const [type, count] of cases) {
      ctx.reset()
      sound.playAlertSound(type)
      expect(ctx.oscillators, type).toHaveLength(count)
    }
  })

  it('震度更新音は警告ビープ（矩形波 2 本＋正弦の芯＋サブ）', () => {
    sound.playKyoshinUpdateSound(13)   // 震度4 = 4 音
    expect(ctx.oscillators).toHaveLength(16)
    expect(ctx.oscillators.filter(o => o.type === 'square')).toHaveLength(8)
    // 矩形波は左右へ離調して重ねる。同じ周波数で detune の符号だけが違う
    const detunes = ctx.oscillators.filter(o => o.type === 'square').map(o => o.detune.value)
    expect(new Set(detunes)).toEqual(new Set([-10, 10]))
    expect(ctx.filters).toHaveLength(4)
  })
})

describe('通知音: BiquadFilter が無い環境（安全弁）', () => {
  // 安全弁: ローパスは木の柔らかさを出す飾りであって、必須ではない。
  // createBiquadFilter を持たない実行環境で、フィルタを使う 3 種が丸ごと落ちないこと。
  it('マスターへ直結して鳴らす（無音にならない）', () => {
    const key = 'createBiquadFilter'
    ;(ctx as unknown as Record<string, unknown>)[key] = undefined
    try {
      sound.playAlertSound('kyoshin')
      expect(ctx.oscillators).toHaveLength(8)
      expect(ctx.filters).toHaveLength(0)
    } finally {
      delete (ctx as unknown as Record<string, unknown>)[key]
    }
  })

  it('震度更新音も鳴る', () => {
    const key = 'createBiquadFilter'
    ;(ctx as unknown as Record<string, unknown>)[key] = undefined
    try {
      sound.playKyoshinUpdateSound(19)   // 震度7・8 音連打
      expect(ctx.oscillators).toHaveLength(32)
      expect(ctx.filters).toHaveLength(0)
    } finally {
      delete (ctx as unknown as Record<string, unknown>)[key]
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

describe('音量は「系統 × 深刻度」で決まる', () => {
  // 音量は `BASE_GAIN`（系統ごとの基準）× `SEVERITY`（深刻度）だけで決まり、種別ごとの
  // 個別の値は持たない。以前は呼び出し側がその場で決めた値を直に渡していたため、同じ系統の
  // 音どうしでも揃っておらず、深刻度と音圧の順位が食い違っていた。
  //
  // 声部ごとの配分（ユニゾン 0.66 倍・矩形波 0.40 倍など）は系統の中で固定なので、
  // **1 回の呼び出しで最も大きい声部の値**を見れば、渡された基準値どうしを比べられる。

  const loudestVoice = (type: typeof ALL_TYPES[number]): number => {
    ctx.reset()
    sound.playAlertSound(type)
    return Math.max(...ctx.gains.flatMap(g => g.gain.events.map(e => e.value)))
  }

  it('正: 同じ系統・同じ段の音は同じ値で鳴る', () => {
    const families: Array<[string, Array<typeof ALL_TYPES[number]>]> = [
      ['ピアノ × 情報', ['earthquake', 'earthquakePrompt', 'earthquakeInfo']],
      ['ダークピアノ × 更新', ['eewUpdate', 'eewFinal', 'eewCancel']],
      ['純音 × 更新', ['tsunamiUpdate', 'tsunamiCancel', 'specialInfoCommentary']],
    ]
    for (const [, types] of families) {
      const values = types.map(loudestVoice)
      for (const v of values) expect(v).toBeCloseTo(values[0], 10)
    }
  })

  it('対照: 段が違えば値も違う', () => {
    // ダークピアノ: 予報（注意）> 続報（更新）
    expect(loudestVoice('eewForecast')).toBeGreaterThan(loudestVoice('eewUpdate'))
    // 純音: 南海トラフ臨時情報（情報）> 関連解説（更新）
    expect(loudestVoice('specialInfo')).toBeGreaterThan(loudestVoice('specialInfoCommentary'))
    // スイープ: 大津波 > 津波警報 > 注意報 > 予報
    const sweeps = (['tsunamiMajor', 'tsunami', 'tsunamiWatch', 'tsunamiForecast'] as const).map(loudestVoice)
    for (let i = 1; i < sweeps.length; i++) expect(sweeps[i]).toBeLessThan(sweeps[i - 1])
    // マリンバ: 揺れ検知（注意・検知）> その予兆（更新）。
    // **予兆は確定と紛れる大きさで鳴らさない**という設計なので、差が縮むと意味が壊れる
    expect(loudestVoice('kyoshinCandidate')).toBeLessThan(loudestVoice('kyoshin'))
    // 警報アラーム: EEW 特別警報（最重要）> EEW 警報（警報）。
    // **このアプリで最も重い 2 つ**なので、逆転を許すと最悪の場面で最悪の音が小さくなる
    expect(loudestVoice('eewSpecial')).toBeGreaterThan(loudestVoice('eew'))
  })

  it('安全弁: 系統の中の比は段の比とぴったり一致する', () => {
    // 「種別ごとの個別の値を書かない」を機械的に確かめられる数少ない手がかり。ある種別にだけ
    // その場の係数を掛け足すと、同じ系統の別の種別との比が段の比からずれる。
    //
    // **スイープと警報アラームは対象外。** 前者は等級ごとに声部の構成が違い（`SWEEP_VOICINGS`）、
    // 後者は EEW 特別警報だけ 58Hz の支えを重ねるため、最も大きい声部の取り分が種別で変わる。
    // どちらも順序（1 つ上の `対照` テスト）で守っている。
    const FAMILIES: Array<[Array<typeof ALL_TYPES[number]>, number[]]> = [
      [['eewForecast', 'eewUpdate'], [0.50, 0.25]],              // ダークピアノ: 注意 / 更新
      [['specialInfo', 'specialInfoCommentary'], [0.35, 0.25]],  // 純音: 情報 / 更新
      [['kyoshin', 'kyoshinCandidate'], [0.50, 0.25]],           // マリンバ: 注意・検知 / 更新
    ]
    for (const [types, severities] of FAMILIES) {
      const values = types.map(loudestVoice)
      for (let i = 1; i < values.length; i++) {
        expect(values[i] / values[0]).toBeCloseTo(severities[i] / severities[0], 6)
      }
    }
  })

  it('安全弁: どの音も 0.02〜0.45 の帯に収まる', () => {
    // **較正そのものを固定する意図はない。** 目標の dBFS へ寄せる値は実測で詰めるものなので、
    // 触るたびに落ちるテストは邪魔になる。ここで捕まえたいのは桁を取り違えた場合だけ
    // （`BASE_GAIN.beep` を 0.40 のつもりで 0.04 と書くと、震度更新音が全段聞こえなくなる）。
    // 現状の実測は 0.040（震度2以下）〜0.341（EEW 特別警報）。
    const all: number[] = ALL_TYPES.map(loudestVoice)
    for (const index of KYOSHIN_INDEX_BY_LEVEL) {
      ctx.reset()
      sound.playKyoshinUpdateSound(index)
      all.push(Math.max(...ctx.gains.flatMap(g => g.gain.events.map(e => e.value))))
    }
    for (const second of [1, 2, 3, 4, 5]) {
      ctx.reset()
      sound.playCountdownBeep(second)
      all.push(Math.max(...ctx.gains.flatMap(g => g.gain.events.map(e => e.value))))
    }
    for (const v of all) {
      expect(v).toBeGreaterThan(0.02)
      expect(v).toBeLessThan(0.45)
    }
  })

  it('安全弁: 震度更新音は段が上がるほど大きくなる', () => {
    // 音量の勾配が段階の重さを伝える。1 段でも逆転すると、強い揺れが弱く聞こえる
    const byLevel = KYOSHIN_INDEX_BY_LEVEL.map(index => {
      ctx.reset()
      sound.playKyoshinUpdateSound(index)
      return Math.max(...ctx.gains.flatMap(g => g.gain.events.map(e => e.value)))
    })
    for (let i = 1; i < byLevel.length; i++) expect(byLevel[i]).toBeGreaterThan(byLevel[i - 1])
  })
})

describe('音の長さは読み上げの遅延と対で決まっている', () => {
  // 通知音が鳴り終わってから読み上げを始めるため、`useLiveEventHandler` が種別ごとに遅延を
  // 持つ（audio-tts-spec.md §6）。**音を短く・長くしたときに遅延の見直しが漏れる**のが
  // 過去に繰り返した事故なので、対になっている種別だけ音の側の終わりを固定しておく。
  //
  // ここで測るのは gain 自動化が 0 へ到達する時刻。
  //
  // **扱うのは津波の解除だけ。** ほかの種別は鳴り終わる前に読み始める設計で、重なるかどうかは
  // 残っている音の絶対値で判断している（測るには実際の合成波形が要るのでここでは扱えない）。
  // 解除だけは「1200ms の時点で完全に止まっている」と実装のコメントが宣言しているので、
  // その宣言をここで固定する。

  /** その種別の gain 自動化が最後に打たれる時刻（`ctx.currentTime` からの相対秒） */
  const soundEnd = (type: typeof ALL_TYPES[number]): number => {
    ctx.reset()
    sound.playAlertSound(type)
    const times = ctx.gains.flatMap(g => g.gain.events.map(e => e.time))
    return Math.max(...times) - ctx.currentTime
  }

  it('津波の解除は遅延（1200ms）より前に鳴り終わる', () => {
    expect(soundEnd('tsunamiCancel')).toBeLessThan(1.2)
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
    // 実測値を書くと音量設計を触るたびに落ちるので、**音量 1 で鳴らしたものと比べる**。
    // 丸めが効いていなければ 5 倍の値が出る
    const loudest = (): number => Math.max(...ctx.gains.flatMap(g => g.gain.events.map(e => e.value)))
    sound.setSoundVolume(1)
    sound.playAlertSound('eewUpdate')
    const atOne = loudest()
    ctx.reset()
    sound.setSoundVolume(5)
    sound.playAlertSound('eewUpdate')
    expect(loudest()).toBeCloseTo(atOne, 10)
  })
})
