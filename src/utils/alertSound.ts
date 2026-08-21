import { log } from './logger'

// 地震情報・緊急地震速報・津波情報の受信時に鳴らす通知音。
// 音声ファイルを持たず Web Audio API で音を生成する（種別ごとに音が異なる）。
//
// 注意: ブラウザの自動再生制限により、ユーザー操作（クリック等）が一度行われるまで
// 音は鳴らない。初回操作時に unlockAudio() を呼んで AudioContext を有効化する。

export type AlertSoundType =
  'earthquake' | 'earthquakePrompt' | 'earthquakeInfo'
  | 'eew' | 'eewUpdate' | 'eewFinal' | 'eewCancel' | 'eewSpecial' | 'eewForecast'
  | 'tsunami' | 'tsunamiMajor' | 'tsunamiWatch' | 'tsunamiForecast' | 'tsunamiUpdate' | 'tsunamiCancel'
  | 'kyoshin' | 'kyoshinCandidate'
  | 'specialInfo' | 'specialInfoCommentary'

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

/**
 * ユーザー操作時に呼び、サスペンド中の AudioContext を再開する。
 *
 * あわせてマスターチェーンを先に作っておく。DynamicsCompressor は生成から
 * 0.4 秒ほどアタックを強く潰すため、最初の音を鳴らす瞬間に作ると **その 1 発だけ
 * 約 8 dB 小さく鳴る**（EEW の初報がそれに当たると、いちばん聞かせたい音が鈍る）。
 * ここで作れば操作から発報までの間に定常へ落ち着く。
 */
export function unlockAudio(): void {
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    // resume の失敗は「以後ずっと無音」を意味する。黙って捨てると原因が追えない
    ctx.resume().catch(err => log.warn(`[sound] AudioContext の再開に失敗: ${String(err)}`))
  }
  try {
    getMasterInput(ctx)
    // 残響も同格の共有リソースとして先に作る。情報系の通知音（pianoNote）は
    // すべて残響を通るため、最初の地震情報の発報時に 1.8 秒ぶんのバッファ生成が
    // 走ることになる。ここで済ませておけば、鳴らす瞬間の処理を軽くできる。
    getReverb(ctx)
  } catch (err) {
    log.error(`[sound] マスターチェーンの事前生成に失敗: ${String(err)}`)
  }
}

/** VOICEVOX 等の外部モジュールが AudioContext を共有するための getter。 */
export function getAudioContext(): AudioContext | null {
  return getCtx()
}

// ─── 内部プリミティブ ─────────────────────────────────────────────

// マスターチェーン: 全音源を Gain → DynamicsCompressor → destination の順で流す。
// 特別警報級 EEW と大津波警報が同時に発火した場合、素の加算合成では波形がクリップして
// ノイズに埋もれるため、compressor で合成音圧の暴走を抑制する（CRIT-3 対応）。
// 単独再生時の音色はほぼ変わらず（threshold 以下は素通し）、複数音が重なったときだけ
// リミッター的に働く。パラメータは音楽制作でリミッターとして使うときの標準的な値。
// _reverb と同じく ctx とペアで保持する。将来 getCtx() が AudioContext を作り直す
// 実装になったとき、古い ctx のノードを掴んだまま無音になるのを防ぐ（getReverb 側だけ
// 対策があって master に無い、という非対称を残さない）。
let _master: GainNode | null = null
let _masterCtx: AudioContext | null = null
/**
 * 全ての音源が最終的に流れ込む master 入力ノード。VOICEVOX 読み上げも含めて
 * このモジュール外の音源もここへ接続することで、合成音圧の暴走を防ぐ。
 */
export function getMasterInput(ctx: AudioContext): AudioNode {
  if (_master && _masterCtx === ctx) return _master
  // 途中で失敗したときに「生成済みだが destination まで繋がっていない _master」を
  // 掴んだままにしない。残すと以後の全ての音と VOICEVOX 読み上げが、例外もログも
  // 出さないまま恒久的に無音になる。破棄して次回やり直せるようにする。
  try {
    const master = ctx.createGain()
    master.gain.value = 1.0
    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -6
    compressor.knee.value = 6
    compressor.ratio.value = 4
    compressor.attack.value = 0.003
    compressor.release.value = 0.25
    master.connect(compressor)
    compressor.connect(ctx.destination)
    _master = master
    _masterCtx = ctx
    return master
  } catch (err) {
    _master = null
    _masterCtx = null
    throw err
  }
}

// LOW-B2: _reverb を ctx とペアで保持する。現状は getCtx() が audioCtx を再生成しないため
// この分岐が実行時に到達することはないが、将来 getCtx() の実装が変わって AudioContext を
// 再生成するようになった場合の防御的コード。ctx が変わったら convolver を作り直す。
let _reverb: ConvolverNode | null = null
let _reverbCtx: AudioContext | null = null
function getReverb(ctx: AudioContext): ConvolverNode {
  if (_reverb && _reverbCtx === ctx) return _reverb
  const len = Math.floor(ctx.sampleRate * 1.8)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2)
  }
  const convolver = ctx.createConvolver()
  convolver.buffer = buf
  convolver.connect(getMasterInput(ctx))
  _reverb = convolver
  _reverbCtx = ctx
  return convolver
}

/**
 * 残響を取れなければ諦める版。**残響の失敗で直接音まで落とさないために使う。**
 *
 * `pianoNote` は全音が残響を通るため、`getReverb` が投げると引数評価の時点で
 * 呼び出し元へ例外が伝わり、`earthquake` のような複数音の音は残りの音が丸ごと
 * 鳴らなくなる（直接音は先にスケジュール済みでも、次の音までは届かない）。
 */
function tryGetReverb(ctx: AudioContext): ConvolverNode | null {
  try {
    return getReverb(ctx)
  } catch (err) {
    log.warn(`[sound] 残響の生成に失敗したため直接音のみで鳴らす: ${String(err)}`)
    return null
  }
}

// 減衰トーンの終わり方。指数減衰は 0 に到達できないため TAIL_FLOOR まで落とすが、
// そこで停止すると TAIL_FLOOR ぶんの段差が残り、無音区間にティックとして聞こえる
// （1 つの音で 2〜6 本のオシレータが同時に切れるため -50 dBFS 前後まで積み上がる）。
// 停止の直前に 0 まで落とし切ってから止める。
const TAIL_FLOOR = 0.001
const TAIL_FADE_SEC = 0.008
const STOP_MARGIN_SEC = 0.012

/**
 * 立ち上がって指数減衰する 1 本のトーンを鳴らす。
 *
 * 通知音のプリミティブ（pianoNote / darkPiano / impact / ding）が共通で使う。
 * 終端の落とし方をここへ集約しているため、各プリミティブは倍音構成だけを持つ。
 * 終端が 0 まで落ちない形に戻すとティックが再発するので、ここを分岐させないこと。
 *
 * @param dest 接続先。通常はマスター入力、残響成分のときは convolver
 * @param t 発音開始時刻（AudioContext 時間）
 * @param attack 0 から peak に達するまでの秒数
 * @param peak 到達する gain（globalVolume は呼び出し側で適用済み）。
 *   0 以下なら何も鳴らさない（音量 0 の設定で無駄なノードを作らないため）
 * @param end 減衰が TAIL_FLOOR に達する時刻。`t + attack` より前を渡した場合は
 *   自動化の順序が壊れるため後ろへ丸める（丸めたことは警告に残す）
 */
function decayTone(
  ctx: AudioContext, dest: AudioNode, type: OscillatorType,
  freq: number, t: number, attack: number, peak: number, end: number,
): void {
  // 音量 0（設定スライダーを絞り切った状態）では TAIL_FLOOR ぶんの残留すら鳴らさない。
  // NaN もここで弾く（放置すると以後の自動化が全滅し、無音の原因が追えなくなる）。
  if (!Number.isFinite(peak) || peak <= 0) {
    if (!Number.isFinite(peak)) log.warn(`[sound] decayTone: peak が不正 (${peak}) freq=${freq}`)
    return
  }
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  osc.connect(g)
  g.connect(dest)
  // 減衰の終わりが立ち上がりより前に来ると gain 自動化の順序が壊れる。
  // 極端に短い dur を渡されても成立するよう下限を設ける。現状の呼び出し元は
  // すべて 2.7 倍以上の余裕があるため到達しないが、丸めが起きたら音の長さが
  // 意図と変わるので黙って通さない（`playCountdownBeep` の警告と同じ流儀）。
  const floor = t + attack + 0.001
  const decayEnd = Math.max(end, floor)
  if (decayEnd > end) {
    log.warn(`[sound] decayTone: 減衰長が短すぎるため丸めた freq=${freq} end=${end} → ${decayEnd}`)
  }
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(peak, t + attack)
  g.gain.exponentialRampToValueAtTime(TAIL_FLOOR, decayEnd)
  g.gain.linearRampToValueAtTime(0, decayEnd + TAIL_FADE_SEC)
  osc.start(t)
  osc.stop(decayEnd + TAIL_FADE_SEC + STOP_MARGIN_SEC)
}

// 情報系（pianoNote）の全音に載せるわずかな残響。呼び出し側の wet に加算する。
// アタックのノイズを廃した分の質感をここで補う。EEW 系（darkPiano）には足さない
// ——警報として硬い質感を保つため、濡らすのは情報系だけに限る。
const PIANO_ROOM_WET = 0.10

// ピアノ風トーン: sine 基音 + triangle 攻撃 + 上部倍音（地震情報・南海トラフ・津波解除に使用）。
//
// かつては頭に 8ms の広帯域ノイズを重ねて「鍵盤を叩いた感じ」を出していたが、
// これが小型スピーカーで「プチ」と聞こえる正体だった。連続して鳴る音
// （地震情報は 0.16 秒間隔の 4 音）では粒が並んで「プチプチ」になる。
// ノイズは廃し、失ったアタックの厚みは上部倍音と PIANO_ROOM_WET で補っている。
function pianoNote(ctx: AudioContext, freq: number, t: number, dur: number, gain: number, wet = 0): void {
  const p = gain * globalVolume
  const dest = getMasterInput(ctx)
  const A = 0.005
  decayTone(ctx, dest, 'sine',     freq,     t, A, p,        t + dur)
  decayTone(ctx, dest, 'triangle', freq,     t, A, p * 0.45, t + dur * 0.18)
  decayTone(ctx, dest, 'sine',     freq * 2, t, A, p * 0.38, t + dur * 0.30)
  decayTone(ctx, dest, 'sine',     freq * 3, t, A, p * 0.18, t + dur * 0.22)
  decayTone(ctx, dest, 'sine',     freq * 4, t, A, p * 0.09, t + dur * 0.16)
  const rev = tryGetReverb(ctx)
  if (rev) decayTone(ctx, rev, 'sine', freq, t, A, p * (wet + PIANO_ROOM_WET), t + dur * 0.80)
}

// ダークピアノ: 純正弦波系 3倍音構成（EEW 系統に使用）。
//
// pianoNote と同じ理由で頭のノイズを廃した。**倍音構成と残響は変えていない**
// ——EEW は警報として硬い質感を保つ判断のため、情報系（pianoNote）のように
// 倍音を厚くしたり残響を足したりしない。ここを情報系に寄せると、EEW 5 系統と
// 特別警報で揃っている「乾いた」質感が崩れる。
function darkPiano(ctx: AudioContext, freq: number, t: number, dur: number, gain: number, wet = 0): void {
  const p = gain * globalVolume
  const dest = getMasterInput(ctx)
  const A = 0.008
  decayTone(ctx, dest, 'sine', freq,     t, A, p,        t + dur)
  decayTone(ctx, dest, 'sine', freq * 2, t, A, p * 0.25, t + dur * 0.35)
  decayTone(ctx, dest, 'sine', freq * 3, t, A, p * 0.08, t + dur * 0.20)
  if (wet > 0) {
    const rev = tryGetReverb(ctx)
    if (rev) decayTone(ctx, rev, 'sine', freq, t, A, p * wet, t + dur * 0.80)
  }
}

// 警報トーン: square + sine(×0.5) + triangle(×1.5) ブレンド（EEW 警報・特別警報に使用）
function darkAlarm(ctx: AudioContext, freq: number, t: number, dur: number, gain: number): void {
  const p = gain * globalVolume
  const hold = Math.max(t + 0.012, t + dur - 0.04)

  const sq = ctx.createOscillator(); const sqG = ctx.createGain()
  sq.type = 'square'; sq.frequency.value = freq
  sq.connect(sqG); sqG.connect(getMasterInput(ctx))
  sqG.gain.setValueAtTime(0, t)
  sqG.gain.linearRampToValueAtTime(p * 0.35, t + 0.010)
  sqG.gain.setValueAtTime(p * 0.35, hold)
  sqG.gain.linearRampToValueAtTime(0, t + dur)
  sq.start(t); sq.stop(t + dur + 0.05)

  const si = ctx.createOscillator(); const siG = ctx.createGain()
  si.type = 'sine'; si.frequency.value = freq * 0.5
  si.connect(siG); siG.connect(getMasterInput(ctx))
  siG.gain.setValueAtTime(0, t)
  siG.gain.linearRampToValueAtTime(p * 0.55, t + 0.010)
  siG.gain.setValueAtTime(p * 0.55, hold)
  siG.gain.linearRampToValueAtTime(0, t + dur)
  si.start(t); si.stop(t + dur + 0.05)

  const tr = ctx.createOscillator(); const trG = ctx.createGain()
  tr.type = 'triangle'; tr.frequency.value = freq * 1.5
  tr.connect(trG); trG.connect(getMasterInput(ctx))
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
  tr.connect(trG); trG.connect(getMasterInput(ctx))
  trG.gain.setValueAtTime(0, t)
  trG.gain.linearRampToValueAtTime(p * 0.60, t + 0.015)
  trG.gain.setValueAtTime(p * 0.60, t + dur - 0.04)
  trG.gain.linearRampToValueAtTime(0, t + dur)
  tr.start(t); tr.stop(t + dur + 0.05)

  const si = ctx.createOscillator(); const siG = ctx.createGain()
  si.type = 'sine'
  si.frequency.setValueAtTime(f1, t)
  si.frequency.exponentialRampToValueAtTime(f2, t + dur)
  si.connect(siG); siG.connect(getMasterInput(ctx))
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
  g.connect(getMasterInput(ctx))
  const peak = gain * globalVolume
  g.gain.setValueAtTime(0, startAt)
  g.gain.linearRampToValueAtTime(peak, startAt + 0.015)
  g.gain.setValueAtTime(peak, startAt + duration - 0.03)
  g.gain.linearRampToValueAtTime(0, startAt + duration)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.05)
}

// 打撃音: sine + triangle + サブオクターブ（強震モニタ揺れ検知に使用）。
// 頭のノイズは pianoNote / darkPiano と同じ理由で廃した。打撃感は triangle の
// 3ms 立ち上がりとサブオクターブで出す（リアルタイム系は残響を足さない）。
function impact(ctx: AudioContext, freq: number, t: number, dur: number, gain: number): void {
  const p = gain * globalVolume
  const dest = getMasterInput(ctx)
  decayTone(ctx, dest, 'sine',     freq,       t, 0.003, p,        t + dur)
  decayTone(ctx, dest, 'triangle', freq,       t, 0.003, p * 0.45, t + dur * 0.18)
  decayTone(ctx, dest, 'sine',     freq * 0.5, t, 0.004, p * 0.35, t + dur * 0.45)
}

// 純音トーン: sine + 第2倍音（強震モニタ更新音・津波情報更新に使用）。
// 元からノイズを持たないため、変わったのは終端の落とし方だけ。
function ding(ctx: AudioContext, freq: number, t: number, dur: number, gain: number): void {
  const p = gain * globalVolume
  const dest = getMasterInput(ctx)
  decayTone(ctx, dest, 'sine', freq,     t, 0.006, p,        t + dur)
  decayTone(ctx, dest, 'sine', freq * 2, t, 0.006, p * 0.20, t + dur * 0.22)
}

// 低音補強トーン: ding + サブオクターブ（高震度更新音に使用）
function dingDeep(ctx: AudioContext, freq: number, t: number, dur: number, gain: number): void {
  ding(ctx, freq, t, dur, gain)
  const p = gain * globalVolume
  decayTone(ctx, getMasterInput(ctx), 'sine', freq * 0.5, t, 0.008, p * 0.50, t + dur * 0.55)
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
    bs.connect(bg); bg.connect(getMasterInput(ctx))
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
    to.connect(tg); tg.connect(getMasterInput(ctx))
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

  // 揺れ検知（強震モニタ first contact）: 打撃2音 + シマー高周波。
  // シマーも decayTone を通す。ここだけ直に書いていたため終端が 0.001 のまま切れ、
  // 打撃音の後ろで 2637Hz のティックが残っていた（他のプリミティブと揃える）。
  kyoshin: (ctx, base) => {
    impact(ctx, 1318, base + 0.00, 0.30, 0.28)
    decayTone(ctx, getMasterInput(ctx), 'sine', 2637,
      base + 0.02, 0.005, 0.28 * globalVolume * 0.10, base + 0.18)
    impact(ctx, 1047, base + 0.24, 0.42, 0.26)
  },

  // 揺れ検知（候補・未確定）: 控えめな単発チャイム（確定音の1/4以下の音量）
  kyoshinCandidate: (ctx, base) => {
    ding(ctx, 880, base, 0.22, 0.07)
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

  // 津波情報更新（グレード不変・観測値更新）: ding 低音 → 高音（穏やかな通知）
  tsunamiUpdate: (ctx, base) => {
    ding(ctx, 370, base + 0.00, 0.55, 0.14)
    ding(ctx, 555, base + 0.28, 0.55, 0.11)
  },

  // 津波解除・取消・失効: ピアノ G4 → C4 の終止形（下行完全 5 度）。
  // ドミナント→トニックの解決で「終わった」を音楽的に言い切る。津波系の
  // tsunamiWatch/tsunami/tsunamiMajor が上昇スイープで緊迫感を出しているのに対し、
  // 解除だけは調性のある 2 音で対比させる。
  // 旧実装は ding の降下 3 音（700→520→380Hz）だったが、音程比が半端で下降グリッサンドの
  // 「ずっこけ」に近い軽さがあり、解除の知らせとして品位を欠いていた。
  // eewCancel（ダークピアノの降下 3 音）と紛れないよう、音色は明るいピアノを使う。
  tsunamiCancel: (ctx, base) => {
    pianoNote(ctx, 392.0, base + 0.00, 0.55, 0.24, 0.12)
    pianoNote(ctx, 261.6, base + 0.26, 1.70, 0.26, 0.20)
  },

  // 南海トラフ臨時情報・後発地震注意情報: ピアノA4×2連打 → D5（情報発表の穏やかな緊張感）
  specialInfo: (ctx, base) => {
    pianoNote(ctx, 440.0, base + 0.00, 0.15, 0.26)
    pianoNote(ctx, 440.0, base + 0.16, 0.15, 0.26)
    pianoNote(ctx, 587.3, base + 0.38, 1.20, 0.22)
  },

  // 南海トラフ関連解説情報: ピアノ下降2音 D5→A4（控えめ）。全体で約1.3秒。
  // **臨時情報（specialInfo）と同じ音にしないこと。** 解説情報は定例解説が平常時にも毎月届く。
  // 段階の発表と同じ音が毎月鳴れば、実際に「巨大地震注意」が出たときに音で区別できなくなる。
  // specialInfo が上昇（A4→D5）なのに対しこちらは下降にして、向きで聞き分けられるようにしている。
  specialInfoCommentary: (ctx, base) => {
    pianoNote(ctx, 587.3, base + 0.00, 0.90, 0.16)
    pianoNote(ctx, 440.0, base + 0.20, 1.10, 0.14)
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

/**
 * 音の合成で例外が出ても外へ投げない。**通知音の失敗でアプリを落とさないため。**
 *
 * 呼び出し元（`useKyoshinAlerts` の useEffect・`useLiveEventHandler` のイベント処理・
 * `App` の S 波カウントダウン）はいずれも try/catch を持たず、このアプリには
 * Error Boundary が無い。React 18 は捕捉されない例外でツリー全体をアンマウントする
 * ため、音の不具合ひとつで地図もカードも読み上げも消える。
 *
 * また `useLiveEventHandler` は通知音を鳴らした**後**にブラウザ通知と読み上げを
 * 出すので、ここで throw すると「音も声も通知も出なかった」という形になる。
 * 音だけを諦めて後続を通す。無音は気づけないので必ず error で残す。
 */
function playGuarded(label: string, play: () => void): void {
  try {
    play()
  } catch (err) {
    log.error(`[sound] ${label} の再生に失敗: ${String(err)}`)
  }
}

/** 指定した種別の通知音を鳴らす。 */
export function playAlertSound(type: AlertSoundType): void {
  const ctx = getCtx()
  if (!ctx) {
    log.debug(`[sound] playAlertSound スキップ (AudioContext なし) type=${type}`)
    return
  }
  log.debug(`[sound] playAlertSound type=${type} ctxState=${ctx.state}`)
  if (ctx.state === 'suspended') void ctx.resume()
  playGuarded(`playAlertSound(${type})`, () => PLAYERS[type](ctx, ctx.currentTime + 0.02))
}

// S波到着カウントダウンの段階ごとのパルス数。ゲート周波数（下記 gateHzMap）と揃えて
// 秒が減るほど「速く・多く」鳴るようにする。
//
// パルス数を鳴動長から割り出す（旧実装の `Math.floor(totalDur / period)`）と、totalDur が
// 固定のためゲート周波数を上げても商が伸びず、5段階が 1・1・2・2・5 に潰れて
// 秒5⇔秒4・秒3⇔秒2 が同じ音になっていた。段階ごとに明示して 5 段階を実際に作る。
const COUNTDOWN_PULSES: Record<number, number> = { 5: 2, 4: 3, 3: 4, 2: 5, 1: 6 }

/** S波到着カウントダウン音（残り1〜5秒）を鳴らす。
 *  ゲート変調パルスアラーム: カウントが進むほどゲート周波数とパルス数が増え焦燥感が増す。
 *  残り1秒はサブ低音＋高音トーンを重ねて衝突感を演出。
 */
export function playCountdownBeep(second: number): void {
  const ctx = getCtx()
  if (!ctx) {
    log.debug(`[sound] playCountdownBeep スキップ (AudioContext なし) second=${second}`)
    return
  }
  if (ctx.state === 'suspended') void ctx.resume()

  const t0 = ctx.currentTime + 0.02
  const gateHzMap: Record<number, number> = { 5: 8, 4: 10, 3: 13, 2: 16, 1: 20 }
  // 想定は残り 1〜5 秒の整数のみ（App.tsx の S 波カウントダウンがこの範囲でしか呼ばない）。
  // 範囲外は最も緩い段階へ丸めるが、黙って別の段階の音を鳴らすと耳で気づくまで誰も分からない。
  // 5 段階が 2 段階に潰れていた不具合を長く見逃したのと同じ轍を踏まないよう、警告を残す。
  if (COUNTDOWN_PULSES[second] === undefined) {
    log.warn(`[sound] playCountdownBeep: 想定外の second=${second}（1〜5 の整数のみ対応）。最も緩い段階で鳴らす`)
  }
  // フォールバックは両方とも「最も緩い段階」＝残り 5 秒の値で揃える。
  // 片方だけ既定値を直書きすると、どの段階とも違う音が鳴って警告文と食い違う。
  const gateHz   = gateHzMap[second] ?? gateHzMap[5]
  const period   = 1 / gateHz
  const pulseW   = period * 0.45
  const steps    = COUNTDOWN_PULSES[second] ?? COUNTDOWN_PULSES[5]
  // 残り1秒の重ね音はパルス列と鳴り終わりを揃える（どの段階でも 0.25〜0.32 秒に収まり、
  // カウントダウンの 1 秒間隔を圧迫しない）。
  const totalDur = steps * period

  playGuarded(`playCountdownBeep(${second})`, () => {
    for (let i = 0; i < steps; i++) {
      const pt  = t0 + i * period
      const osc = ctx.createOscillator(); const env = ctx.createGain()
      osc.type = 'square'; osc.frequency.value = 440
      osc.connect(env); env.connect(getMasterInput(ctx))
      env.gain.setValueAtTime(0, pt)
      env.gain.linearRampToValueAtTime(0.22 * globalVolume, pt + 0.003)
      env.gain.setValueAtTime(0.22 * globalVolume, pt + pulseW - 0.003)
      env.gain.linearRampToValueAtTime(0, pt + pulseW)
      osc.start(pt); osc.stop(pt + pulseW + 0.005)
    }

    if (second === 1) {
      const sub = ctx.createOscillator(); const sg = ctx.createGain()
      sub.type = 'sine'; sub.frequency.value = 110
      sub.connect(sg); sg.connect(getMasterInput(ctx))
      sg.gain.setValueAtTime(0, t0)
      sg.gain.linearRampToValueAtTime(0.30 * globalVolume, t0 + 0.010)
      sg.gain.setValueAtTime(0.30 * globalVolume, t0 + totalDur - 0.06)
      sg.gain.linearRampToValueAtTime(0, t0 + totalDur)
      sub.start(t0); sub.stop(t0 + totalDur + 0.02)

      const hi = ctx.createOscillator(); const hg = ctx.createGain()
      hi.type = 'sine'; hi.frequency.value = 1320
      hi.connect(hg); hg.connect(getMasterInput(ctx))
      hg.gain.setValueAtTime(0, t0)
      hg.gain.linearRampToValueAtTime(0.16 * globalVolume, t0 + 0.005)
      hg.gain.setValueAtTime(0.16 * globalVolume, t0 + totalDur - 0.06)
      hg.gain.linearRampToValueAtTime(0, t0 + totalDur)
      hi.start(t0); hi.stop(t0 + totalDur + 0.02)
    }
  })
}

/**
 * 強震モニタの最大インデックスに応じた震度更新音を鳴らす。
 * @param gainScale 音量倍率（既定1.0）。likely（未確定）中に鳴らす場合は控えめな値を渡し、
 *   confirmed 中の更新と聞き分けられるようにする（確信度に見合わない大きさで鳴らさないため）。
 */
export function playKyoshinUpdateSound(maxIndex: number, gainScale = 1): void {
  const ctx = getCtx()
  if (!ctx) {
    log.debug(`[sound] playKyoshinUpdateSound スキップ (AudioContext なし) maxIndex=${maxIndex}`)
    return
  }
  log.debug(`[sound] playKyoshinUpdateSound maxIndex=${maxIndex} level=${kyoshinLevel(maxIndex)} gainScale=${gainScale} ctxState=${ctx.state}`)
  if (ctx.state === 'suspended') void ctx.resume()
  const p = DING_PATTERNS[kyoshinLevel(maxIndex)]
  const base = ctx.currentTime + 0.02
  const fn = p.deep ? dingDeep : ding
  playGuarded(`playKyoshinUpdateSound(${maxIndex})`, () => {
    p.freqs.forEach((freq, i) => fn(ctx, freq, base + i * p.interval, p.duration, p.gain * gainScale))
  })
}
