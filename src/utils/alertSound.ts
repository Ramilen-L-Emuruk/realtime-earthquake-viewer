// 地震情報・緊急地震速報・津波情報の受信時に鳴らす通知音。
// 音声ファイルを持たず Web Audio API でビープ音を生成する（種別ごとに音が異なる）。
//
// 注意: ブラウザの自動再生制限により、ユーザー操作（クリック等）が一度行われるまで
// 音は鳴らない。初回操作時に unlockAudio() を呼んで AudioContext を有効化する。

export type AlertSoundType =
  'earthquake' | 'earthquakePrompt' | 'earthquakeInfo'
  | 'eew' | 'eewUpdate' | 'eewCancel' | 'eewSpecial' | 'eewForecast'
  | 'tsunami' | 'tsunamiMajor' | 'tsunamiWatch'
  | 'kyoshin'

let audioCtx: AudioContext | null = null

// グローバル音量 (0.0 〜 1.0)。setSoundVolume() で外部から変更できる。
let globalVolume = 1.0

/** 通知音の全体音量を設定する（0.0 = 無音、1.0 = 最大）。 */
export function setSoundVolume(v: number): void {
  globalVolume = Math.min(1, Math.max(0, v))
}

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!audioCtx) {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    audioCtx = new Ctx()
  }
  return audioCtx
}

/** ユーザー操作時に呼び、サスペンド中の AudioContext を再開する。 */
export function unlockAudio(): void {
  const ctx = getCtx()
  if (ctx && ctx.state === 'suspended') void ctx.resume()
}

// ─── 内部プリミティブ ─────────────────────────────────────────────

// 矩形エンベロープのオシレーター（クリックノイズ防止の立上り・立下り込み）
function beep(ctx: AudioContext, type: OscillatorType, freq: number, startAt: number, duration: number, gain: number): void {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  osc.connect(g)
  g.connect(ctx.destination)
  const peak = gain * globalVolume
  g.gain.setValueAtTime(0, startAt)
  g.gain.linearRampToValueAtTime(peak, startAt + 0.012)
  g.gain.setValueAtTime(peak, Math.max(startAt + 0.012, startAt + duration - 0.04))
  g.gain.linearRampToValueAtTime(0, startAt + duration)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.05)
}

// FM合成ベル: carrier を modulator で変調し倍音豊かな残響音を生成する
function bell(ctx: AudioContext, freq: number, ratio: number, depth: number, startAt: number, duration: number, gain: number): void {
  const carrier = ctx.createOscillator()
  const mod = ctx.createOscillator()
  const modGain = ctx.createGain()
  const ampGain = ctx.createGain()
  mod.frequency.value = freq * ratio
  carrier.frequency.value = freq
  mod.connect(modGain)
  modGain.connect(carrier.frequency)
  carrier.connect(ampGain)
  ampGain.connect(ctx.destination)
  modGain.gain.setValueAtTime(depth, startAt)
  modGain.gain.exponentialRampToValueAtTime(0.1, startAt + duration * 0.6)
  const peak = gain * globalVolume
  ampGain.gain.setValueAtTime(0, startAt)
  ampGain.gain.linearRampToValueAtTime(peak, startAt + 0.008)
  ampGain.gain.exponentialRampToValueAtTime(0.001, startAt + duration)
  mod.start(startAt)
  carrier.start(startAt)
  mod.stop(startAt + duration + 0.1)
  carrier.stop(startAt + duration + 0.1)
}

// 周波数スイープ: freqStart → freqEnd → freqStart の往復サイレン
function sweep(ctx: AudioContext, type: OscillatorType, freqStart: number, freqEnd: number, startAt: number, duration: number, gain: number): void {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freqStart, startAt)
  osc.frequency.linearRampToValueAtTime(freqEnd, startAt + duration * 0.55)
  osc.frequency.linearRampToValueAtTime(freqStart, startAt + duration)
  osc.connect(g)
  g.connect(ctx.destination)
  const peak = gain * globalVolume
  g.gain.setValueAtTime(0, startAt)
  g.gain.linearRampToValueAtTime(peak, startAt + 0.015)
  g.gain.setValueAtTime(peak, startAt + duration - 0.03)
  g.gain.linearRampToValueAtTime(0, startAt + duration)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.05)
}

// 指数減衰パルス: sine + 任意の square ブレンド（震度更新音用）
function ping(ctx: AudioContext, freq: number, startAt: number, duration: number, gain: number, squareMix = 0): void {
  const peak = gain * globalVolume
  const so = ctx.createOscillator()
  const sg = ctx.createGain()
  so.type = 'sine'
  so.frequency.value = freq
  so.connect(sg)
  sg.connect(ctx.destination)
  sg.gain.setValueAtTime(0, startAt)
  sg.gain.linearRampToValueAtTime(peak * (1 - squareMix * 0.4), startAt + 0.01)
  sg.gain.exponentialRampToValueAtTime(0.001, startAt + duration)
  so.start(startAt)
  so.stop(startAt + duration + 0.05)
  if (squareMix > 0) {
    const qo = ctx.createOscillator()
    const qg = ctx.createGain()
    qo.type = 'square'
    qo.frequency.value = freq
    qo.connect(qg)
    qg.connect(ctx.destination)
    qg.gain.setValueAtTime(0, startAt)
    qg.gain.linearRampToValueAtTime(peak * squareMix * 0.22, startAt + 0.01)
    qg.gain.exponentialRampToValueAtTime(0.001, startAt + duration * 0.5)
    qo.start(startAt)
    qo.stop(startAt + duration + 0.05)
  }
}

// ─── サウンドプレーヤー ───────────────────────────────────────────

type SoundPlayer = (ctx: AudioContext, base: number) => void

const PLAYERS: Record<AlertSoundType, SoundPlayer> = {
  // 地震情報（震源・震度情報 / 各地の震度情報）: FM ベル 2音（残響チャイム）
  earthquake: (ctx, base) => {
    bell(ctx, 880, 3.5, 200, base,        0.80, 0.28)
    bell(ctx, 660, 3.5, 180, base + 0.22, 1.10, 0.28)
  },

  // 震度速報: FM ベル 3音（速報感）
  earthquakePrompt: (ctx, base) => {
    bell(ctx, 880, 2.0, 120, base,        0.35, 0.22)
    bell(ctx, 880, 2.0, 120, base + 0.20, 0.35, 0.22)
    bell(ctx, 660, 2.0, 160, base + 0.40, 0.50, 0.24)
  },

  // 遠地地震 / その他: FM ベル 単音（控えめ）
  earthquakeInfo: (ctx, base) => {
    bell(ctx, 660, 1.5, 80, base, 0.55, 0.18)
  },

  // EEW 予報: FM ベル 下降2音（緩やか）
  eewForecast: (ctx, base) => {
    bell(ctx, 784, 1.8, 90, base,        0.35, 0.20)
    bell(ctx, 622, 1.8, 90, base + 0.22, 0.45, 0.20)
  },

  // EEW 警報: di-di-di-DAA パターン（3連ビープ + 長音）
  eew: (ctx, base) => {
    beep(ctx, 'square', 920, base + 0.00, 0.09, 0.18)
    beep(ctx, 'square', 920, base + 0.13, 0.09, 0.18)
    beep(ctx, 'square', 920, base + 0.26, 0.09, 0.18)
    beep(ctx, 'square', 740, base + 0.41, 0.28, 0.20)
  },

  // EEW 特別警報: 上昇スイープ + 高速8連打（震度6弱以上）
  eewSpecial: (ctx, base) => {
    sweep(ctx, 'sawtooth', 500, 1100, base, 0.22, 0.18)
    const freqs = [1060, 820, 1060, 820, 1060, 820, 1060, 820] as const
    freqs.forEach((f, i) => beep(ctx, 'square', f, base + 0.26 + i * 0.11, 0.08, 0.20))
  },

  // EEW 続報: FM ベル 短2音（軽め）
  eewUpdate: (ctx, base) => {
    bell(ctx, 880,  4.0, 300, base,        0.18, 0.18)
    bell(ctx, 1100, 4.0, 300, base + 0.14, 0.14, 0.15)
  },

  // EEW 解除: FM ベル 下降3和音（安堵感）
  eewCancel: (ctx, base) => {
    bell(ctx, 523, 1.5, 60, base,        0.90, 0.22)
    bell(ctx, 392, 1.5, 60, base + 0.10, 1.00, 0.20)
    bell(ctx, 330, 1.5, 60, base + 0.25, 1.10, 0.18)
  },

  // 揺れ検知（強震モニタ first contact）: FM ベル 上昇2音
  kyoshin: (ctx, base) => {
    bell(ctx, 660, 2.5, 140, base,        0.45, 0.24)
    bell(ctx, 880, 2.5, 160, base + 0.20, 0.65, 0.26)
  },

  // 津波注意報: sine スイープ 300→500Hz × 2回（緩やか・低め）
  tsunamiWatch: (ctx, base) => {
    for (let i = 0; i < 2; i++) sweep(ctx, 'sine', 300, 500, base + i * 0.80, 0.60, 0.22)
  },

  // 津波警報: sawtooth スイープ 260→560Hz × 3回（鋸波の荒さで緊迫感）
  tsunami: (ctx, base) => {
    for (let i = 0; i < 3; i++) sweep(ctx, 'sawtooth', 260, 560, base + i * 0.85, 0.70, 0.26)
  },

  // 大津波警報: sawtooth 低音 + sine 高音 ダブルスイープ × 5回（重みと貫通力）
  tsunamiMajor: (ctx, base) => {
    for (let i = 0; i < 5; i++) {
      sweep(ctx, 'sawtooth', 200, 500, base + i * 0.77,        0.65, 0.28)
      sweep(ctx, 'sine',     300, 750, base + i * 0.77 + 0.05, 0.60, 0.18)
    }
  },
}

// ─── 震度更新音（強震モニタ）─────────────────────────────────────
// 震度が上がるにつれ音程・回数・音量・波形の荒さが連動して増加する。

// 強震モニタ index → 震度7段階のマッピング（インデックスは 0〜20、計測震度 = index * 0.5 - 3.0）
// index 9=震度2相当、11=震度3、13=震度4、15=震度5弱、16=震度5強、17=震度6弱/6強、19=震度7
export function kyoshinLevel(index: number): number {
  if (index >= 19) return 6  // 震度7 (計測震度 6.5+)
  if (index >= 17) return 5  // 震度6弱/6強 (計測震度 5.5〜6.5)
  if (index >= 16) return 4  // 震度5強 (計測震度 5.0〜5.5)
  if (index >= 15) return 3  // 震度5弱 (計測震度 4.5〜5.0)
  if (index >= 13) return 2  // 震度4 (計測震度 3.5〜4.5)
  if (index >= 11) return 1  // 震度3 (計測震度 2.5〜3.5)
  return 0                    // 震度2以下
}

interface PingPattern {
  freq: number
  count: number
  interval: number
  duration: number
  gain: number
  squareMix: number
  altFreq?: number  // 奇数番目の音に使う別周波数（震度7の高低交互）
}

const PING_PATTERNS: PingPattern[] = [
  { freq: 440,  count: 1, interval: 0,    duration: 0.22, gain: 0.12, squareMix: 0.00 },                        // 震度2
  { freq: 523,  count: 1, interval: 0,    duration: 0.24, gain: 0.15, squareMix: 0.00 },                        // 震度3
  { freq: 659,  count: 2, interval: 0.20, duration: 0.20, gain: 0.18, squareMix: 0.00 },                        // 震度4
  { freq: 784,  count: 2, interval: 0.18, duration: 0.20, gain: 0.22, squareMix: 0.05 },                        // 震度5弱
  { freq: 880,  count: 3, interval: 0.16, duration: 0.18, gain: 0.24, squareMix: 0.10 },                        // 震度5強
  { freq: 1047, count: 3, interval: 0.13, duration: 0.16, gain: 0.26, squareMix: 0.35 },                        // 震度6弱〜強
  { freq: 1175, count: 4, interval: 0.14, duration: 0.15, gain: 0.28, squareMix: 0.60, altFreq: 880 },          // 震度7
]

// ─── 公開 API ───────────────────────────────────────────────────

/** 指定した種別の通知音を鳴らす。 */
export function playAlertSound(type: AlertSoundType): void {
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  PLAYERS[type](ctx, ctx.currentTime + 0.02)
}

/** 強震モニタの最大インデックスに応じた震度更新音を鳴らす。 */
export function playKyoshinUpdateSound(maxIndex: number): void {
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  const p = PING_PATTERNS[kyoshinLevel(maxIndex)]
  const base = ctx.currentTime + 0.02
  for (let i = 0; i < p.count; i++) {
    const freq = (p.altFreq !== undefined && i % 2 === 1) ? p.altFreq : p.freq
    ping(ctx, freq, base + i * p.interval, p.duration, p.gain, p.squareMix)
  }
}
