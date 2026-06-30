// 地震情報・緊急地震速報・津波情報の受信時に鳴らす通知音。
// 音声ファイルを持たず Web Audio API で音を生成する（種別ごとに音が異なる）。
//
// 注意: ブラウザの自動再生制限により、ユーザー操作（クリック等）が一度行われるまで
// 音は鳴らない。初回操作時に unlockAudio() を呼んで AudioContext を有効化する。

export type AlertSoundType =
  'earthquake' | 'earthquakePrompt' | 'earthquakeInfo'
  | 'eew' | 'eewUpdate' | 'eewFinal' | 'eewCancel' | 'eewSpecial' | 'eewForecast'
  | 'tsunami' | 'tsunamiMajor' | 'tsunamiWatch' | 'tsunamiForecast'
  | 'kyoshin'
  | 'specialInfo'

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

/** VOICEVOX 等の外部モジュールが AudioContext を共有するための getter。 */
export function getAudioContext(): AudioContext | null {
  return getCtx()
}

// ─── 内部プリミティブ ─────────────────────────────────────────────

let _reverb: ConvolverNode | null = null
function getReverb(ctx: AudioContext): ConvolverNode {
  if (_reverb) return _reverb
  const len = Math.floor(ctx.sampleRate * 1.8)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2)
  }
  _reverb = ctx.createConvolver()
  _reverb.buffer = buf
  _reverb.connect(ctx.destination)
  return _reverb
}

// ピアノ風トーン: triangle 攻撃 + sine 余韻 + 第2倍音 + ノイズ鍵盤感（地震情報系に使用）
function pianoNote(ctx: AudioContext, freq: number, t: number, dur: number, gain: number, wet = 0): void {
  const p = gain * globalVolume

  const sin = ctx.createOscillator(); const sinG = ctx.createGain()
  sin.type = 'sine'; sin.frequency.value = freq
  sin.connect(sinG); sinG.connect(ctx.destination)
  sinG.gain.setValueAtTime(0, t)
  sinG.gain.linearRampToValueAtTime(p, t + 0.005)
  sinG.gain.exponentialRampToValueAtTime(0.001, t + dur)
  sin.start(t); sin.stop(t + dur + 0.05)

  const tri = ctx.createOscillator(); const triG = ctx.createGain()
  tri.type = 'triangle'; tri.frequency.value = freq
  tri.connect(triG); triG.connect(ctx.destination)
  triG.gain.setValueAtTime(0, t)
  triG.gain.linearRampToValueAtTime(p * 0.50, t + 0.005)
  triG.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.18)
  tri.start(t); tri.stop(t + dur + 0.05)

  const h2 = ctx.createOscillator(); const h2G = ctx.createGain()
  h2.type = 'sine'; h2.frequency.value = freq * 2
  h2.connect(h2G); h2G.connect(ctx.destination)
  h2G.gain.setValueAtTime(0, t)
  h2G.gain.linearRampToValueAtTime(p * 0.18, t + 0.005)
  h2G.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.25)
  h2.start(t); h2.stop(t + dur + 0.05)

  const nlen = Math.floor(ctx.sampleRate * 0.008)
  const nbuf = ctx.createBuffer(1, nlen, ctx.sampleRate)
  const nd = nbuf.getChannelData(0)
  for (let i = 0; i < nlen; i++) nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nlen, 1.5)
  const ns = ctx.createBufferSource(); const ng = ctx.createGain()
  ns.buffer = nbuf
  ng.gain.setValueAtTime(p * 0.28, t)
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.008)
  ns.connect(ng); ng.connect(ctx.destination)
  ns.start(t); ns.stop(t + 0.010)

  if (wet > 0) {
    const rev = getReverb(ctx)
    const wo = ctx.createOscillator(); const wg = ctx.createGain()
    wo.type = 'sine'; wo.frequency.value = freq
    wo.connect(wg); wg.connect(rev)
    wg.gain.setValueAtTime(0, t)
    wg.gain.linearRampToValueAtTime(p * wet, t + 0.005)
    wg.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.80)
    wo.start(t); wo.stop(t + dur + 0.05)
  }
}

// ダークピアノ: 純正弦波系 3倍音構成 + 微量ノイズ（EEW 系統に使用）
function darkPiano(ctx: AudioContext, freq: number, t: number, dur: number, gain: number, wet = 0): void {
  const p = gain * globalVolume

  const s1 = ctx.createOscillator(); const g1 = ctx.createGain()
  s1.type = 'sine'; s1.frequency.value = freq
  s1.connect(g1); g1.connect(ctx.destination)
  g1.gain.setValueAtTime(0, t)
  g1.gain.linearRampToValueAtTime(p, t + 0.008)
  g1.gain.exponentialRampToValueAtTime(0.001, t + dur)
  s1.start(t); s1.stop(t + dur + 0.05)

  const s2 = ctx.createOscillator(); const g2 = ctx.createGain()
  s2.type = 'sine'; s2.frequency.value = freq * 2
  s2.connect(g2); g2.connect(ctx.destination)
  g2.gain.setValueAtTime(0, t)
  g2.gain.linearRampToValueAtTime(p * 0.25, t + 0.008)
  g2.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.35)
  s2.start(t); s2.stop(t + dur + 0.05)

  const s3 = ctx.createOscillator(); const g3 = ctx.createGain()
  s3.type = 'sine'; s3.frequency.value = freq * 3
  s3.connect(g3); g3.connect(ctx.destination)
  g3.gain.setValueAtTime(0, t)
  g3.gain.linearRampToValueAtTime(p * 0.08, t + 0.008)
  g3.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.20)
  s3.start(t); s3.stop(t + dur + 0.05)

  const nlen = Math.floor(ctx.sampleRate * 0.006)
  const nbuf = ctx.createBuffer(1, nlen, ctx.sampleRate)
  const nd = nbuf.getChannelData(0)
  for (let i = 0; i < nlen; i++) nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nlen, 1.5)
  const ns = ctx.createBufferSource(); const ng = ctx.createGain()
  ns.buffer = nbuf
  ng.gain.setValueAtTime(p * 0.14, t)
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.006)
  ns.connect(ng); ng.connect(ctx.destination)
  ns.start(t); ns.stop(t + 0.008)

  if (wet > 0) {
    const rev = getReverb(ctx)
    const wo = ctx.createOscillator(); const wg = ctx.createGain()
    wo.type = 'sine'; wo.frequency.value = freq
    wo.connect(wg); wg.connect(rev)
    wg.gain.setValueAtTime(0, t)
    wg.gain.linearRampToValueAtTime(p * wet, t + 0.008)
    wg.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.80)
    wo.start(t); wo.stop(t + dur + 0.05)
  }
}

// 警報トーン: square + sine(×0.5) + triangle(×1.5) ブレンド（EEW 警報・特別警報に使用）
function darkAlarm(ctx: AudioContext, freq: number, t: number, dur: number, gain: number): void {
  const p = gain * globalVolume
  const hold = Math.max(t + 0.012, t + dur - 0.04)

  const sq = ctx.createOscillator(); const sqG = ctx.createGain()
  sq.type = 'square'; sq.frequency.value = freq
  sq.connect(sqG); sqG.connect(ctx.destination)
  sqG.gain.setValueAtTime(0, t)
  sqG.gain.linearRampToValueAtTime(p * 0.35, t + 0.010)
  sqG.gain.setValueAtTime(p * 0.35, hold)
  sqG.gain.linearRampToValueAtTime(0, t + dur)
  sq.start(t); sq.stop(t + dur + 0.05)

  const si = ctx.createOscillator(); const siG = ctx.createGain()
  si.type = 'sine'; si.frequency.value = freq * 0.5
  si.connect(siG); siG.connect(ctx.destination)
  siG.gain.setValueAtTime(0, t)
  siG.gain.linearRampToValueAtTime(p * 0.55, t + 0.010)
  siG.gain.setValueAtTime(p * 0.55, hold)
  siG.gain.linearRampToValueAtTime(0, t + dur)
  si.start(t); si.stop(t + dur + 0.05)

  const tr = ctx.createOscillator(); const trG = ctx.createGain()
  tr.type = 'triangle'; tr.frequency.value = freq * 1.5
  tr.connect(trG); trG.connect(ctx.destination)
  trG.gain.setValueAtTime(0, t)
  trG.gain.linearRampToValueAtTime(p * 0.18, t + 0.010)
  trG.gain.setValueAtTime(p * 0.18, hold)
  trG.gain.linearRampToValueAtTime(0, t + dur)
  tr.start(t); tr.stop(t + dur + 0.05)
}

// 上昇スイープ: triangle + sine の指数周波数ランプ（EEW 特別警報に使用）
function darkSweep(ctx: AudioContext, f1: number, f2: number, t: number, dur: number, gain: number): void {
  const p = gain * globalVolume

  const tr = ctx.createOscillator(); const trG = ctx.createGain()
  tr.type = 'triangle'
  tr.frequency.setValueAtTime(f1, t)
  tr.frequency.exponentialRampToValueAtTime(f2, t + dur)
  tr.connect(trG); trG.connect(ctx.destination)
  trG.gain.setValueAtTime(0, t)
  trG.gain.linearRampToValueAtTime(p * 0.60, t + 0.015)
  trG.gain.setValueAtTime(p * 0.60, t + dur - 0.04)
  trG.gain.linearRampToValueAtTime(0, t + dur)
  tr.start(t); tr.stop(t + dur + 0.05)

  const si = ctx.createOscillator(); const siG = ctx.createGain()
  si.type = 'sine'
  si.frequency.setValueAtTime(f1, t)
  si.frequency.exponentialRampToValueAtTime(f2, t + dur)
  si.connect(siG); siG.connect(ctx.destination)
  siG.gain.setValueAtTime(0, t)
  siG.gain.linearRampToValueAtTime(p * 0.40, t + 0.015)
  siG.gain.setValueAtTime(p * 0.40, t + dur - 0.04)
  siG.gain.linearRampToValueAtTime(0, t + dur)
  si.start(t); si.stop(t + dur + 0.05)
}


// 周波数スイープ: freqStart → freqEnd → freqStart の往復サイレン（津波音に使用）
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

// 打撃音: sine + triangle + sub + ノイズ（強震モニタ揺れ検知に使用）
function impact(ctx: AudioContext, freq: number, t: number, dur: number, gain: number, noiseMix = 0.20): void {
  const p = gain * globalVolume

  const so = ctx.createOscillator(); const sg = ctx.createGain()
  so.type = 'sine'; so.frequency.value = freq
  so.connect(sg); sg.connect(ctx.destination)
  sg.gain.setValueAtTime(0, t)
  sg.gain.linearRampToValueAtTime(p, t + 0.003)
  sg.gain.exponentialRampToValueAtTime(0.001, t + dur)
  so.start(t); so.stop(t + dur + 0.05)

  const to = ctx.createOscillator(); const tg = ctx.createGain()
  to.type = 'triangle'; to.frequency.value = freq
  to.connect(tg); tg.connect(ctx.destination)
  tg.gain.setValueAtTime(0, t)
  tg.gain.linearRampToValueAtTime(p * 0.45, t + 0.003)
  tg.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.18)
  to.start(t); to.stop(t + dur + 0.05)

  const subO = ctx.createOscillator(); const subG = ctx.createGain()
  subO.type = 'sine'; subO.frequency.value = freq * 0.5
  subO.connect(subG); subG.connect(ctx.destination)
  subG.gain.setValueAtTime(0, t)
  subG.gain.linearRampToValueAtTime(p * 0.35, t + 0.004)
  subG.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.45)
  subO.start(t); subO.stop(t + dur + 0.05)

  const nlen = Math.floor(ctx.sampleRate * 0.007)
  const nbuf = ctx.createBuffer(1, nlen, ctx.sampleRate)
  const nd = nbuf.getChannelData(0)
  for (let i = 0; i < nlen; i++) nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nlen, 1.5)
  const ns = ctx.createBufferSource(); const ngn = ctx.createGain()
  ns.buffer = nbuf
  ngn.gain.setValueAtTime(p * noiseMix, t)
  ngn.gain.exponentialRampToValueAtTime(0.001, t + 0.007)
  ns.connect(ngn); ngn.connect(ctx.destination)
  ns.start(t); ns.stop(t + 0.009)
}

// 純音トーン: sine + 第2倍音（強震モニタ更新音に使用）
function ding(ctx: AudioContext, freq: number, t: number, dur: number, gain: number): void {
  const p = gain * globalVolume

  const so = ctx.createOscillator(); const sg = ctx.createGain()
  so.type = 'sine'; so.frequency.value = freq
  so.connect(sg); sg.connect(ctx.destination)
  sg.gain.setValueAtTime(0, t)
  sg.gain.linearRampToValueAtTime(p, t + 0.006)
  sg.gain.exponentialRampToValueAtTime(0.001, t + dur)
  so.start(t); so.stop(t + dur + 0.05)

  const ho = ctx.createOscillator(); const hg = ctx.createGain()
  ho.type = 'sine'; ho.frequency.value = freq * 2
  ho.connect(hg); hg.connect(ctx.destination)
  hg.gain.setValueAtTime(0, t)
  hg.gain.linearRampToValueAtTime(p * 0.20, t + 0.006)
  hg.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.22)
  ho.start(t); ho.stop(t + dur + 0.05)
}

// 低音補強トーン: ding + サブオクターブ（高震度更新音に使用）
function dingDeep(ctx: AudioContext, freq: number, t: number, dur: number, gain: number): void {
  ding(ctx, freq, t, dur, gain)

  const so = ctx.createOscillator(); const sg = ctx.createGain()
  so.type = 'sine'; so.frequency.value = freq * 0.5
  so.connect(sg); sg.connect(ctx.destination)
  const p = gain * globalVolume
  sg.gain.setValueAtTime(0, t)
  sg.gain.linearRampToValueAtTime(p * 0.50, t + 0.008)
  sg.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.55)
  so.start(t); so.stop(t + dur + 0.05)
}

// ─── サウンドプレーヤー ───────────────────────────────────────────

type SoundPlayer = (ctx: AudioContext, base: number) => void

const PLAYERS: Record<AlertSoundType, SoundPlayer> = {
  // 地震情報（震源・震度情報 / 各地の震度情報）: ピアノ上昇4音 E4→G#4→B4→E5
  earthquake: (ctx, base) => {
    const arpFreqs = [329.6, 415.3, 493.9, 659.3] as const
    arpFreqs.forEach((f, i) => pianoNote(ctx, f, base + i * 0.16, 0.90, 0.26))
  },

  // 震度速報: ピアノ上昇3音 G#4→B4→E5
  earthquakePrompt: (ctx, base) => {
    const freqs = [415.3, 493.9, 659.3] as const
    freqs.forEach((f, i) => pianoNote(ctx, f, base + i * 0.13, 0.60, 0.26))
  },

  // 遠地地震 / その他: ピアノ2音 G4→B4（控えめ）
  earthquakeInfo: (ctx, base) => {
    pianoNote(ctx, 392.0, base,        1.20, 0.18)
    pianoNote(ctx, 493.9, base + 0.20, 1.40, 0.16)
  },

  // EEW 予報: ダークピアノ F4→A4（緩やか）
  eewForecast: (ctx, base) => {
    darkPiano(ctx, 349.2, base,        0.90, 0.26, 0.12)
    darkPiano(ctx, 440.0, base + 0.22, 0.95, 0.26, 0.14)
  },

  // EEW 最終報: ダークピアノ F4→C4 降下2音
  eewFinal: (ctx, base) => {
    darkPiano(ctx, 349.2, base,        0.55, 0.24)
    darkPiano(ctx, 261.6, base + 0.18, 0.60, 0.23)
  },

  // EEW 続報: ダークピアノ F4 単音
  eewUpdate: (ctx, base) => {
    darkPiano(ctx, 349.2, base, 0.50, 0.26)
  },

  // EEW 警報: ダークピアノ F4×3連打 + darkAlarm Bb3
  eew: (ctx, base) => {
    darkPiano(ctx, 349.2, base + 0 * 0.16, 0.12, 0.26)
    darkPiano(ctx, 349.2, base + 1 * 0.16, 0.12, 0.26)
    darkPiano(ctx, 349.2, base + 2 * 0.16, 0.12, 0.26)
    darkAlarm(ctx, 233.1, base + 0.50, 0.46, 0.26)
  },

  // EEW 特別警報: 低音上昇 → スイープ → darkAlarm 9連打交互 → 三角波ドローン（震度6弱以上）
  eewSpecial: (ctx, base) => {
    const bs = ctx.createOscillator(); const bg = ctx.createGain()
    bs.type = 'sine'
    bs.frequency.setValueAtTime(55, base)
    bs.frequency.exponentialRampToValueAtTime(110, base + 0.30)
    bs.connect(bg); bg.connect(ctx.destination)
    const bp = 0.22 * globalVolume
    bg.gain.setValueAtTime(0, base)
    bg.gain.linearRampToValueAtTime(bp, base + 0.02)
    bg.gain.setValueAtTime(bp, base + 0.26)
    bg.gain.linearRampToValueAtTime(0, base + 0.30)
    bs.start(base); bs.stop(base + 0.35)

    darkSweep(ctx, 150, 800, base + 0.30, 0.34, 0.22)

    const alarmFreqs = [466.2, 349.2, 466.2, 349.2, 466.2, 349.2, 466.2, 349.2, 466.2] as const
    alarmFreqs.forEach((f, i) => darkAlarm(ctx, f, base + 0.68 + i * 0.108, 0.095, 0.26))

    const to = ctx.createOscillator(); const tg = ctx.createGain()
    to.type = 'triangle'; to.frequency.value = 880
    to.connect(tg); tg.connect(ctx.destination)
    const tp = 0.032 * globalVolume
    tg.gain.setValueAtTime(0, base + 0.65)
    tg.gain.linearRampToValueAtTime(tp, base + 0.68)
    tg.gain.setValueAtTime(tp, base + 1.62)
    tg.gain.linearRampToValueAtTime(0, base + 1.66)
    to.start(base + 0.65); to.stop(base + 1.70)
  },

  // EEW 解除: ダークピアノ A4→F4→C4 降下3音（100ms 間隔）
  eewCancel: (ctx, base) => {
    darkPiano(ctx, 440.0, base + 0 * 0.10, 0.90, 0.26)
    darkPiano(ctx, 349.2, base + 1 * 0.10, 0.95, 0.25)
    darkPiano(ctx, 261.6, base + 2 * 0.10, 1.00, 0.24)
  },

  // 揺れ検知（強震モニタ first contact）: 打撃2音 + シマー高周波
  kyoshin: (ctx, base) => {
    impact(ctx, 1318, base + 0.00, 0.30, 0.28, 0.28)
    const sh = ctx.createOscillator(); const shg = ctx.createGain()
    sh.type = 'sine'; sh.frequency.value = 2637
    sh.connect(shg); shg.connect(ctx.destination)
    shg.gain.setValueAtTime(0, base + 0.02)
    shg.gain.linearRampToValueAtTime(0.28 * globalVolume * 0.10, base + 0.025)
    shg.gain.exponentialRampToValueAtTime(0.001, base + 0.18)
    sh.start(base + 0.02); sh.stop(base + 0.20)
    impact(ctx, 1047, base + 0.24, 0.42, 0.26, 0.18)
  },

  // 津波予報（若干の海面変動）: sine 穏やかなスイープ 380→460Hz × 2回（tsunamiWatch より低緊迫・低音量）
  tsunamiForecast: (ctx, base) => {
    for (let i = 0; i < 2; i++) sweep(ctx, 'sine', 380, 460, base + i * 0.90, 0.70, 0.15)
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

  // 南海トラフ臨時情報・後発地震注意情報: ピアノA4×2連打 → D5（情報発表の穏やかな緊張感）
  specialInfo: (ctx, base) => {
    pianoNote(ctx, 440.0, base + 0.00, 0.15, 0.26)
    pianoNote(ctx, 440.0, base + 0.16, 0.15, 0.26)
    pianoNote(ctx, 587.3, base + 0.38, 1.20, 0.22)
  },
}

// ─── 震度更新音（強震モニタ）─────────────────────────────────────
// 震度が上がるにつれ音程・回数・音量が連動して増加する。

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

interface DingPattern {
  freqs: number[]
  interval: number
  duration: number
  gain: number
  deep: boolean
}

const DING_PATTERNS: DingPattern[] = [
  { freqs: [659, 880],                              interval: 0.18, duration: 0.28, gain: 0.24, deep: false }, // 震度2以下
  { freqs: [880, 1047, 1175],                       interval: 0.15, duration: 0.22, gain: 0.32, deep: false }, // 震度3
  { freqs: [880, 1047, 1175, 1318],                 interval: 0.13, duration: 0.20, gain: 0.34, deep: false }, // 震度4
  { freqs: [880, 1047, 1175, 1318],                 interval: 0.12, duration: 0.18, gain: 0.36, deep: true  }, // 震度5弱
  { freqs: [1047, 784, 1047, 784, 1047],            interval: 0.11, duration: 0.17, gain: 0.38, deep: true  }, // 震度5強
  { freqs: [1175, 880, 1175, 880, 1175, 880],       interval: 0.10, duration: 0.16, gain: 0.40, deep: true  }, // 震度6弱〜強
  { freqs: [1318, 880, 1318, 880, 1318, 880, 1318], interval: 0.09, duration: 0.15, gain: 0.42, deep: true  }, // 震度7
]

// ─── 公開 API ───────────────────────────────────────────────────

/** 指定した種別の通知音を鳴らす。 */
export function playAlertSound(type: AlertSoundType): void {
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  PLAYERS[type](ctx, ctx.currentTime + 0.02)
}

/** S波到着カウントダウン音（残り1〜5秒）を鳴らす。
 *  ゲート変調パルスアラーム: カウントが進むほどゲート周波数が上がり焦燥感が増す。
 *  残り1秒はサブ低音＋高音トーンを重ねて衝突感を演出。
 */
export function playCountdownBeep(second: number): void {
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()

  const t0 = ctx.currentTime + 0.02
  const gateHzMap: Record<number, number> = { 5: 8, 4: 10, 3: 13, 2: 16, 1: 20 }
  const gateHz   = gateHzMap[second] ?? 8
  const totalDur = second === 1 ? 0.30 : 0.18
  const period   = 1 / gateHz
  const pulseW   = period * 0.45
  const steps    = Math.floor(totalDur / period)

  for (let i = 0; i < steps; i++) {
    const pt  = t0 + i * period
    const osc = ctx.createOscillator(); const env = ctx.createGain()
    osc.type = 'square'; osc.frequency.value = 440
    osc.connect(env); env.connect(ctx.destination)
    env.gain.setValueAtTime(0, pt)
    env.gain.linearRampToValueAtTime(0.22 * globalVolume, pt + 0.003)
    env.gain.setValueAtTime(0.22 * globalVolume, pt + pulseW - 0.003)
    env.gain.linearRampToValueAtTime(0, pt + pulseW)
    osc.start(pt); osc.stop(pt + pulseW + 0.005)
  }

  if (second === 1) {
    const sub = ctx.createOscillator(); const sg = ctx.createGain()
    sub.type = 'sine'; sub.frequency.value = 110
    sub.connect(sg); sg.connect(ctx.destination)
    sg.gain.setValueAtTime(0, t0)
    sg.gain.linearRampToValueAtTime(0.30 * globalVolume, t0 + 0.010)
    sg.gain.setValueAtTime(0.30 * globalVolume, t0 + 0.24)
    sg.gain.linearRampToValueAtTime(0, t0 + 0.30)
    sub.start(t0); sub.stop(t0 + 0.32)

    const hi = ctx.createOscillator(); const hg = ctx.createGain()
    hi.type = 'sine'; hi.frequency.value = 1320
    hi.connect(hg); hg.connect(ctx.destination)
    hg.gain.setValueAtTime(0, t0)
    hg.gain.linearRampToValueAtTime(0.16 * globalVolume, t0 + 0.005)
    hg.gain.setValueAtTime(0.16 * globalVolume, t0 + 0.24)
    hg.gain.linearRampToValueAtTime(0, t0 + 0.30)
    hi.start(t0); hi.stop(t0 + 0.32)
  }
}

/** 強震モニタの最大インデックスに応じた震度更新音を鳴らす。 */
export function playKyoshinUpdateSound(maxIndex: number): void {
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  const p = DING_PATTERNS[kyoshinLevel(maxIndex)]
  const base = ctx.currentTime + 0.02
  const fn = p.deep ? dingDeep : ding
  p.freqs.forEach((freq, i) => fn(ctx, freq, base + i * p.interval, p.duration, p.gain))
}
