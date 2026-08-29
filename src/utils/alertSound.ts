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
// ctx とペアで保持する。将来 getCtx() が AudioContext を作り直す実装になったとき、
// 古い ctx のノードを掴んだまま無音になるのを防ぐ。
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

// BiquadFilterNode の欠落を報告済みか。マリンバは 1 音ごとに呼ぶため 1 度だけ記録する。
let _filterFallbackWarned = false

/**
 * ローパスを掛けた接続先を作る。**`BiquadFilterNode` を持たない環境ではマスターへ直結する。**
 *
 * フィルタを使うのはマリンバ（検知・更新系）だけで、無ければ木の柔らかさが出ないものの
 * 音そのものは鳴る。ここで諦めると 4 種の通知音が丸ごと無音になるため繋ぎ替える。
 */
function lowpassOrMaster(ctx: AudioContext, cutoffHz: number): AudioNode {
  if (typeof ctx.createBiquadFilter !== 'function') {
    if (!_filterFallbackWarned) {
      _filterFallbackWarned = true
      log.warn('[sound] BiquadFilterNode が無い環境のため、マリンバのローパスを省く')
    }
    return getMasterInput(ctx)
  }
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = cutoffHz
  lp.Q.value = 0.7
  lp.connect(getMasterInput(ctx))
  return lp
}

// StereoPannerNode の欠落を報告済みか。高頻度に呼ばれるため 1 度だけ記録する。
let _pannerFallbackWarned = false

/**
 * 左右への振り分け先を作る。**`StereoPannerNode` を持たない環境ではマスターへ直結する**
 * ——音が消えるより中央で鳴るほうがよいため、ここで諦めずに繋ぎ替える。
 *
 * ただし黙って落とすと、警報のうなりと広がりが恒久的にモノラルへ退化しても
 * 後から診断できない（音は鳴るので「無音」としては現れない）。初回だけ記録する。
 */
function panTo(ctx: AudioContext, pan: number): AudioNode {
  if (typeof ctx.createStereoPanner !== 'function') {
    if (!_pannerFallbackWarned) {
      _pannerFallbackWarned = true
      log.warn('[sound] StereoPannerNode が無い環境のため、通知音の左右への振り分けを行わない')
    }
    return getMasterInput(ctx)
  }
  const node = ctx.createStereoPanner()
  node.pan.value = pan
  node.connect(getMasterInput(ctx))
  return node
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
 * 通知音のプリミティブ（pianoNote / darkPiano / darkAlarm / marimba）が共通で使う。
 * 終端の落とし方をここへ集約しているため、各プリミティブは倍音構成だけを持つ。
 * 終端が 0 まで落ちない形に戻すとティックが再発するので、ここを分岐させないこと。
 *
 * @param dest 接続先。通常はマスター入力、マリンバのときはローパスフィルタ
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
  // **0 は正当だが負値は必ず計算ミス。** 同じ無言の early return に合流させると、
  // 声部が 1 本消えたことに誰も気づけない。
  if (!Number.isFinite(peak) || peak <= 0) {
    if (!Number.isFinite(peak) || peak < 0) log.warn(`[sound] decayTone: peak が不正 (${peak}) freq=${freq}`)
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

/** `gateTone` の包絡の形。省略時は持続音（アラーム・サイレン）向けの値を使う。 */
interface GateShape {
  /** 0 から peak に達するまでの秒数 */
  attack?: number
  /** peak から 0 へ落とすのにかける秒数。**短いパルスでは必ず縮めること**
   *  （既定の 0.04 秒は 20Hz ゲートのパルス幅より長く、切れ味が鈍る） */
  release?: number
  /** 離調（セント）。同じ周波数を左右へわずかにずらして重ねるとうなりが生まれる */
  detuneCents?: number
}

/**
 * 立ち上がって一定に保ち、最後に落とす 1 本のトーン。
 *
 * `decayTone`（減衰する音）と対になるプリミティブで、警報アラーム・津波サイレン・
 * S 波カウントダウンが共通で使う。**終端が必ず 0 で終わる点は `decayTone` と同じ。**
 * ここを 0 以外で止める形に戻すと、無音区間にティックが出る。
 *
 * @param peak 到達する gain（globalVolume は呼び出し側で適用済み）。
 *   0 以下なら何も鳴らさない（音量 0 の設定で無駄なノードを作らないため）
 */
function gateTone(
  ctx: AudioContext, dest: AudioNode, type: OscillatorType,
  freq: number, t: number, dur: number, peak: number, shape: GateShape = {},
): void {
  if (!Number.isFinite(peak) || peak <= 0) {
    if (!Number.isFinite(peak) || peak < 0) log.warn(`[sound] gateTone: peak が不正 (${peak}) freq=${freq}`)
    return
  }
  const attack = shape.attack ?? 0.006
  const release = shape.release ?? 0.04
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  if (shape.detuneCents) osc.detune.value = shape.detuneCents
  osc.connect(g)
  g.connect(dest)
  // 極端に短い dur を渡されても自動化の順序が壊れないよう、保持の開始と終端に下限を置く。
  // 丸めが起きたら音の長さが意図と変わるので黙って通さない（decayTone と同じ流儀）。
  const hold = Math.max(t + attack + 0.001, t + dur - release)
  const end = Math.max(hold + 0.001, t + dur)
  if (end > t + dur) {
    log.warn(`[sound] gateTone: 鳴動長が短すぎるため丸めた freq=${freq} dur=${dur} → ${end - t}`)
  }
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(peak, t + attack)
  g.gain.setValueAtTime(peak, hold)
  g.gain.linearRampToValueAtTime(0, end)
  osc.start(t)
  osc.stop(end + 0.05)
}

// ピアノの 1 音は複数本の弦で鳴っており、その張力のわずかな差がうねりを生む。
// 基音を 1 本のオシレータで出すとこのうねりが無く、「電子音」として聞こえる。
const PIANO_UNISON_CENTS = 3.0

// 実際の弦は硬さを持つため、倍音は整数倍よりわずかに高いところに立つ（インハーモニシティ）。
// 整数倍のまま重ねると響きがオルガンやシンセ寄りになる。
const PIANO_INHARMONICITY = 0.0007

/** インハーモニシティを織り込んだ第 n 倍音の周波数。 */
function partialFreq(fundamental: number, n: number, b: number): number {
  return n * fundamental * Math.sqrt(1 + b * n * n)
}

// 上部倍音の相対レベル。添字が倍音の次数（第 2 倍音から使う）。
const PIANO_PARTIAL_LEVELS = [0, 0, 0.272, 0.136, 0.068] as const

// ピアノ風トーン: 3 本のユニゾン基音 + triangle 攻撃 + 非整数の上部倍音 + サブオクターブ
// （地震情報・南海トラフ・津波解除に使用）。
//
// かつては頭に 8ms の広帯域ノイズを重ねて「鍵盤を叩いた感じ」を出していたが、
// これが小型スピーカーで「プチ」と聞こえる正体だった。連続して鳴る音
// （地震情報は 0.16 秒間隔の 4 音）では粒が並んで「プチプチ」になる。
// ノイズは廃し、厚みはユニゾンのうねりと上部倍音で作っている。
function pianoNote(ctx: AudioContext, freq: number, t: number, dur: number, gain: number): void {
  const p = gain * globalVolume
  const dest = getMasterInput(ctx)
  const A = 0.012
  const spread = Math.pow(2, PIANO_UNISON_CENTS / 1200)
  // 基音は 3 本。合計が単一オシレータ相当の音圧になるよう配分する
  decayTone(ctx, dest, 'sine', freq,          t, A, p * 0.62, t + dur)
  decayTone(ctx, dest, 'sine', freq * spread, t, A, p * 0.38, t + dur * 1.02)
  decayTone(ctx, dest, 'sine', freq / spread, t, A, p * 0.34, t + dur * 0.98)
  decayTone(ctx, dest, 'triangle', freq, t, A * 0.7, p * 0.15, t + dur * 0.13)
  // 高次の倍音ほど速く立ち上がり、速く消える
  for (let n = 2; n < PIANO_PARTIAL_LEVELS.length; n++) {
    decayTone(ctx, dest, 'sine', partialFreq(freq, n, PIANO_INHARMONICITY),
      t, Math.max(0.002, A - (n - 2) * 0.0008), p * PIANO_PARTIAL_LEVELS[n],
      t + dur * (0.36 - (n - 2) * 0.05))
  }
  decayTone(ctx, dest, 'sine', freq * 0.5, t, 0.010, p * 0.10, t + dur * 0.55)
}

// EEW 系のユニゾン幅。情報系より狭くして、うねりを付けつつ緊張感を残す。
const EEW_UNISON_CENTS = 2.2

// ダークピアノ: 3 本のユニゾン基音 + 整数倍音 2 本（EEW 予報・続報・最終報・誤報取消に使用）。
//
// pianoNote と同じ理由で頭のノイズを廃している。**倍音は整数倍のまま**
// ——EEW は警報として硬い質感を保つ判断のため、情報系のようにインハーモニシティで
// 響きを豊かにはしない。足したのはユニゾンのうねりだけ。
function darkPiano(ctx: AudioContext, freq: number, t: number, dur: number, gain: number): void {
  const p = gain * globalVolume
  const dest = getMasterInput(ctx)
  const A = 0.008
  const spread = Math.pow(2, EEW_UNISON_CENTS / 1200)
  decayTone(ctx, dest, 'sine', freq,          t, A, p * 0.66, t + dur)
  decayTone(ctx, dest, 'sine', freq * spread, t, A, p * 0.34, t + dur * 1.02)
  decayTone(ctx, dest, 'sine', freq / spread, t, A, p * 0.30, t + dur * 0.97)
  decayTone(ctx, dest, 'sine', freq * 2, t, A, p * 0.24, t + dur * 0.35)
  decayTone(ctx, dest, 'sine', freq * 3, t, A, p * 0.08, t + dur * 0.20)
}

// 警報アラームの離調とステレオ幅。同じ矩形波を左右へ ±7 セントずらして重ねると、
// 干渉によるうなりが生まれてサイレンらしい厚みが出る。**モノラルで鳴らすと薄くなる。**
const ALARM_DETUNE_CENTS = 7
const ALARM_STEREO_WIDTH = 0.55

// 警報トーン: 左右へ振った矩形波 + 鋸波 + サブ 2 段 + 三角波（EEW 警報・特別警報に使用）。
// 頭の短い倍音バーストが打撃感を担う（広帯域ノイズは使わない。理由は pianoNote 参照）。
function darkAlarm(ctx: AudioContext, freq: number, t: number, dur: number, gain: number): void {
  const p = gain * globalVolume
  const dest = getMasterInput(ctx)
  const A = 0.006
  gateTone(ctx, panTo(ctx, -ALARM_STEREO_WIDTH), 'square', freq, t, dur, p * 0.20,
    { attack: A, detuneCents: -ALARM_DETUNE_CENTS })
  gateTone(ctx, panTo(ctx, ALARM_STEREO_WIDTH), 'square', freq, t, dur, p * 0.20,
    { attack: A, detuneCents: ALARM_DETUNE_CENTS })
  gateTone(ctx, dest, 'sawtooth', freq,        t, dur, p * 0.10, { attack: A })
  gateTone(ctx, dest, 'sine',     freq * 0.5,  t, dur, p * 0.42, { attack: A })
  gateTone(ctx, dest, 'sine',     freq * 0.25, t, dur, p * 0.26, { attack: A })
  gateTone(ctx, panTo(ctx, 0.3),  'triangle', freq * 1.5,  t, dur, p * 0.13, { attack: A, detuneCents: 4 })
  gateTone(ctx, panTo(ctx, -0.3), 'triangle', freq * 2.01, t, dur, p * 0.06, { attack: A, detuneCents: -4 })
  decayTone(ctx, dest, 'square', freq * 2, t, 0.001, p * 0.16, t + 0.045)
}

/** 津波サイレンの声部構成。段階が下がるほど波形を穏やかにし、低域とステレオ幅を絞る。 */
interface SweepVoicing {
  /** 主となる波形。警報級は鋸波、注意報以下は正弦波 */
  readonly type: OscillatorType
  /** 左右へ振る主波形のレベル */
  readonly main: number
  /** 1 オクターブ下 */
  readonly sub: number
  /** 2 オクターブ下 */
  readonly subDeep: number
  /** 1 オクターブ上 */
  readonly high: number
  /** 三角波（1.5 倍） */
  readonly mid: number
  readonly detuneCents: number
  readonly width: number
  /**
   * 1 周期のうち最高音に達する位置（比）。**掃引の形はこの 1 つの値で決まる。**
   *
   * - `0.55` … 上がって下がる往復。時間をほぼ半分ずつ昇降に充てる
   * - `0.88` … 上がりきってから急に戻る。落ちてこないので「進行している」印象になる
   *
   * **大津波警報だけを 0.88 にしているのは、津波警報と聞き分けるため。** 周波数と回数だけで
   * 差を付けていた頃（大津波 200→500Hz × 5 回 / 津波 260→560Hz × 3 回）は、掃引の途中で
   * 互いの音域を通過するため冒頭の 1〜2 秒では判別できなかった。回数の違いは最後まで
   * 聴かなければ分からず、避難を促す最上位の警報がそれでは用をなさない。
   * 耳は音の高さより**動きの向き**で先に区別するため、形を変えるのが最も効く。
   *
   * **ここを揃えると弁別が消える。** 値を動かすときは 2 つの段階を続けて鳴らして確かめること
   * （`alertSound.test.ts` の「津波の段階は掃引の形で聞き分ける」が、折り返し点と 1 周期の
   * 長さの両方を固定している。**周波数は弁別の根拠に使っていない**ため固定していない）。
   */
  readonly peakAt: number
}

// 4 段階の声部。**注意報・予報を鋸波にしないこと**——平常時にも届く階級のため、
// 警報級と同じ荒さで鳴らすと刺さりすぎる。段階を波形で分ける設計は従来どおり。
const SWEEP_VOICINGS = {
  major:    { type: 'sawtooth', main: 0.16, sub: 0.32, subDeep: 0.22, high: 0.06, mid: 0.09, detuneCents: 8, width: 0.60, peakAt: 0.88 },
  warning:  { type: 'sawtooth', main: 0.15, sub: 0.30, subDeep: 0.16, high: 0.05, mid: 0.08, detuneCents: 8, width: 0.55, peakAt: 0.55 },
  watch:    { type: 'sine',     main: 0.30, sub: 0.20, subDeep: 0.06, high: 0,    mid: 0.10, detuneCents: 5, width: 0.40, peakAt: 0.55 },
  forecast: { type: 'sine',     main: 0.34, sub: 0.14, subDeep: 0,    high: 0,    mid: 0.06, detuneCents: 4, width: 0.30, peakAt: 0.55 },
} as const satisfies Record<string, SweepVoicing>

// 周波数スイープ: freqStart → freqEnd → freqStart のサイレン（津波音に使用）。
// 各声部が同じ軌跡を倍率違いで辿るため、うねりながら全体が上下する。
// 最高音に達する位置は声部構成の `peakAt` が決める（往復か、上昇主体か）。
function sweep(
  ctx: AudioContext, voicing: SweepVoicing,
  freqStart: number, freqEnd: number, startAt: number, duration: number, gain: number,
): void {
  const peak = gain * globalVolume
  // 音量 0 では 1 本も作らない。0 は正当だが負値と NaN は計算ミス——判定も報告する値も
  // decayTone / gateTone と揃える（関数ごとにログの読み方が変わらないようにする）
  if (!Number.isFinite(peak) || peak <= 0) {
    if (!Number.isFinite(peak) || peak < 0) log.warn(`[sound] sweep: peak が不正 (${peak})`)
    return
  }
  const layer = (type: OscillatorType, mul: number, level: number, detune: number, pan: number): void => {
    // レベル 0 は「その段階では使わない声部」という正当な指定（SWEEP_VOICINGS 参照）。
    // NaN と負値は必ず計算ミスで、放置すると AudioParam が同期的に例外を投げ、
    // 呼び出し元のループごと（津波警報なら残りの回数まで）鳴らなくなる。
    if (!Number.isFinite(level) || level < 0) {
      log.warn(`[sound] sweep: 声部の level が不正 (${level}) type=${type} mul=${mul}`)
      return
    }
    if (level === 0) return
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freqStart * mul, startAt)
    osc.frequency.linearRampToValueAtTime(freqEnd * mul, startAt + duration * voicing.peakAt)
    osc.frequency.linearRampToValueAtTime(freqStart * mul, startAt + duration)
    if (detune !== 0) osc.detune.value = detune
    osc.connect(g)
    g.connect(pan === 0 ? getMasterInput(ctx) : panTo(ctx, pan))
    g.gain.setValueAtTime(0, startAt)
    g.gain.linearRampToValueAtTime(peak * level, startAt + 0.018)
    g.gain.setValueAtTime(peak * level, startAt + duration - 0.035)
    g.gain.linearRampToValueAtTime(0, startAt + duration)
    osc.start(startAt)
    osc.stop(startAt + duration + 0.06)
  }
  layer(voicing.type, 1,    voicing.main,    -voicing.detuneCents, -voicing.width)
  layer(voicing.type, 1,    voicing.main,     voicing.detuneCents,  voicing.width)
  layer('sine',       0.5,  voicing.sub,      0,  0)
  layer('sine',       0.25, voicing.subDeep,  0,  0)
  layer('sine',       2,    voicing.high,     3,  0.25)
  layer('triangle',   1.5,  voicing.mid,     -3, -0.25)
}

/**
 * マリンバ（木琴）。観測と検知を伝える音——揺れ検知・その予兆・震度の更新・
 * 津波の観測値の更新——をこれ 1 つで作る。
 *
 * **他の 4 系統が波形を重ねるだけで作られているのに対し、ここだけフィルタを持つ。**
 * 木琴の音は板の共鳴が高域を吸うところに柔らかさがあり、波形を足すだけでは作れない。
 *
 * 木琴は上部の部分音を **1 : 4 : 10** に調律する（弦の 1 : 2 : 3 とは違う）。倍音が上へ
 * 大きく離れるため、基音の周りが濁らず、短く鳴らしても音程がはっきり出る。
 * 実測の板はここからわずかに外れるので 3.9 / 9.8 を使う。
 *
 * 理由: 加算合成のままでは「硬い」を解消できず、方式ごと入れ替えた
 * （経緯は audio-tts-spec.md §10 の 2026-08-29 の項）。
 *
 * @param deep 低音を厚くする（震度 5 弱以上の更新音）
 */
function marimba(ctx: AudioContext, freq: number, t: number, dur: number, gain: number, deep = false): void {
  const p = gain * globalVolume
  // 板の共鳴が高域を吸うのを模す。基音の 6 倍で切ると、上の部分音が角を残さず馴染む。
  // **フィルタを持たない環境ではマスターへ直結する**（`panTo` と同じ方針）——ここで
  // 例外を投げると playGuarded が握り潰し、検知・更新系の 4 種が丸ごと無音になる。
  const lp = lowpassOrMaster(ctx, freq * 6)
  decayTone(ctx, lp, 'sine', freq,       t, 0.006, p,        t + dur)
  decayTone(ctx, lp, 'sine', freq * 3.9, t, 0.004, p * 0.22, t + dur * 0.24)
  decayTone(ctx, lp, 'sine', freq * 9.8, t, 0.003, p * 0.07, t + dur * 0.10)
  decayTone(ctx, lp, 'sine', freq * 0.5, t, 0.008, p * (deep ? 0.45 : 0.18), t + dur * 0.55)
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
    darkPiano(ctx, 349.2, base,        0.90, 0.26)
    darkPiano(ctx, 440.0, base + 0.22, 0.95, 0.26)
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

  // EEW 警報: 警報アラーム Bb3 の 2 連。
  //
  // 以前は頭にダークピアノ F4×3 連打の前置きがあったが、警報の到達が 0.5 秒遅れる。
  // **前置きは置かず、1 音目から警報アラームで始める。**
  eew: (ctx, base) => {
    darkAlarm(ctx, 233.1, base,        0.42, 0.26)
    darkAlarm(ctx, 233.1, base + 0.52, 0.46, 0.26)
  },

  // EEW 特別警報: 警報アラーム Bb4/F4 の交互 9 連打 + 低音の支え（震度6弱以上）。
  //
  // 以前は「低音上昇 → スイープ → 9 連打 → 高音ドローン」の 4 部構成だったが、
  // 前置き 2 つで 0.68 秒を使っていた。**最も重い警報が最も遅く鳴り始める**状態
  // だったため、前置きとドローンを廃して 9 連打から直接始める。
  // 警報（`eew`）との聞き分けは、1 オクターブ上から始まることと下の 58Hz が担う。
  eewSpecial: (ctx, base) => {
    // 9 連打の下に敷く低音。連打の隙間が空いても重さが途切れないよう、全体を貫かせる。
    // **連打より先にスケジュールすること。** 後ろに置くと、連打の途中で例外が出た場合に
    // この行へ到達せず、最も重い警報が低音を失った状態で途切れる。
    decayTone(ctx, getMasterInput(ctx), 'sine', 58, base + 0.03, 0.02, 0.20 * globalVolume, base + 1.15)
    const alarmFreqs = [466.2, 349.2, 466.2, 349.2, 466.2, 349.2, 466.2, 349.2, 466.2] as const
    alarmFreqs.forEach((f, i) => darkAlarm(ctx, f, base + 0.03 + i * 0.108, 0.095, 0.30))
  },

  // EEW 解除: ダークピアノ A4→F4→C4 降下3音（100ms 間隔）
  eewCancel: (ctx, base) => {
    darkPiano(ctx, 440.0, base + 0 * 0.10, 0.90, 0.26)
    darkPiano(ctx, 349.2, base + 1 * 0.10, 0.95, 0.25)
    darkPiano(ctx, 261.6, base + 2 * 0.10, 1.00, 0.24)
  },

  // 揺れ検知（強震モニタ first contact）: マリンバ 2 音 C#6→A5（下行長 3 度）。
  // 以前は打撃音 2 つに 2637Hz のシマーを重ねていたが、高域はマリンバの部分音が担うため
  // 別途足さない。**地震情報（329〜659Hz）と音域が重ならないよう上に置いている**——
  // 落ち着いた知らせと緊急の気づきが同じ高さで鳴ると、役割の差が消える。
  kyoshin: (ctx, base) => {
    marimba(ctx, 1108, base + 0.00, 0.34, 0.28)
    marimba(ctx, 880,  base + 0.24, 0.46, 0.26)
  },

  // 揺れ検知（候補・未確定）: 控えめな単発 F#5（確定音の1/4以下の音量）
  kyoshinCandidate: (ctx, base) => {
    marimba(ctx, 740, base, 0.24, 0.07)
  },

  // 津波予報（若干の海面変動）: 穏やかなスイープ 380→460Hz × 2回（tsunamiWatch より低緊迫・低音量）
  tsunamiForecast: (ctx, base) => {
    for (let i = 0; i < 2; i++) sweep(ctx, SWEEP_VOICINGS.forecast, 380, 460, base + i * 0.90, 0.70, 0.15)
  },

  // 津波注意報: スイープ 300→500Hz × 2回（緩やか・低め）
  tsunamiWatch: (ctx, base) => {
    for (let i = 0; i < 2; i++) sweep(ctx, SWEEP_VOICINGS.watch, 300, 500, base + i * 0.80, 0.60, 0.22)
  },

  // 津波警報: 鋸波スイープ 260→560Hz × 3回（鋸波の荒さで緊迫感）
  tsunami: (ctx, base) => {
    for (let i = 0; i < 3; i++) sweep(ctx, SWEEP_VOICINGS.warning, 260, 560, base + i * 0.85, 0.70, 0.26)
  },

  // 大津波警報: 上昇サイレン 220→620Hz × 5回。
  // **津波警報と聞き分けられることを最優先にした構成**（`peakAt` の注記を参照）。掃引が
  // 落ちてこないうえ、1 周期を津波警報の半分以下（0.34 秒）に詰めてあるため、1 周期目で違いが出る。
  // 回数は据え置き。増やすと全体が伸び、避難を促す音が長く鳴り続けるだけになる。
  // 高音は声部（SWEEP_VOICINGS.major の high）が担うため、別のスイープを重ねない。
  tsunamiMajor: (ctx, base) => {
    for (let i = 0; i < 5; i++) sweep(ctx, SWEEP_VOICINGS.major, 220, 620, base + i * 0.40, 0.34, 0.28)
  },

  // 津波情報更新（グレード不変・観測値更新）: マリンバ 2 音 F#4→C#5（穏やかな通知）。
  // **他の観測・検知音と違い、周波数を下げていない。** 元から低いため、揃えて下げると
  // 185Hz まで落ちて小型スピーカーでは痩せる（下げ幅は音域に余裕のある高い音だけに掛ける）。
  tsunamiUpdate: (ctx, base) => {
    marimba(ctx, 370, base + 0.00, 0.55, 0.14)
    marimba(ctx, 555, base + 0.28, 0.55, 0.11)
  },

  // 津波解除・取消・失効: ピアノ G4 → C4 の終止形（下行完全 5 度）。
  // ドミナント→トニックの解決で「終わった」を音楽的に言い切る。津波系の
  // tsunamiWatch/tsunami/tsunamiMajor が上昇スイープで緊迫感を出しているのに対し、
  // 解除だけは調性のある 2 音で対比させる。
  // 旧実装は ding の降下 3 音（700→520→380Hz）だったが、音程比が半端で下降グリッサンドの
  // 「ずっこけ」に近い軽さがあり、解除の知らせとして品位を欠いていた。
  // eewCancel（ダークピアノの降下 3 音）と紛れないよう、音色は明るいピアノを使う。
  tsunamiCancel: (ctx, base) => {
    pianoNote(ctx, 392.0, base + 0.00, 0.58, 0.24)
    pianoNote(ctx, 261.6, base + 0.26, 1.70, 0.26)
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

interface MarimbaPattern {
  freqs: number[]
  interval: number
  duration: number
  gain: number
  /** 低音を厚くする（震度 5 弱以上）。段階の重さを音量とは別の軸で示す */
  deep: boolean
}

// 震度が上がるほど音数が増え、間隔が詰まり、音量が上がる。**この勾配が段階の重さを伝える**
// ので、音色を変えるときも数値の並びは崩さないこと。
// 周波数は揺れ検知と同じく短 3 度下げてある（旧: 659〜1318Hz → 現: 554〜1108Hz）。
const MARIMBA_PATTERNS: MarimbaPattern[] = [
  { freqs: [554, 740],                         interval: 0.18, duration: 0.28, gain: 0.24, deep: false }, // 震度2以下
  { freqs: [740, 880, 988],                    interval: 0.15, duration: 0.22, gain: 0.32, deep: false }, // 震度3
  { freqs: [740, 880, 988, 1108],              interval: 0.13, duration: 0.20, gain: 0.34, deep: false }, // 震度4
  { freqs: [740, 880, 988, 1108],              interval: 0.12, duration: 0.18, gain: 0.36, deep: true  }, // 震度5弱
  { freqs: [880, 659, 880, 659, 880],          interval: 0.11, duration: 0.17, gain: 0.38, deep: true  }, // 震度5強
  { freqs: [988, 740, 988, 740, 988, 740],     interval: 0.10, duration: 0.16, gain: 0.40, deep: true  }, // 震度6弱〜強
  { freqs: [1108, 740, 1108, 740, 1108, 740, 1108], interval: 0.09, duration: 0.15, gain: 0.42, deep: true }, // 震度7
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
  if (ctx.state === 'suspended') {
    ctx.resume().catch(err =>
      log.warn(`[sound] playAlertSound(${type}) 中の AudioContext 再開に失敗: ${String(err)}`))
  }
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
 *  残り1秒はサブ低音 2 本と高音を重ねて衝突感を演出。
 *
 *  音色は警報アラーム（`darkAlarm`）に揃えてある——直後に鳴る警報と質感が
 *  食い違わないようにするため。**段階の作り方（ゲート周波数とパルス数）は別の話で、
 *  ここは変えていない。** 5 段階の聞き分けはそちらが担っている。
 */
export function playCountdownBeep(second: number): void {
  const ctx = getCtx()
  if (!ctx) {
    log.debug(`[sound] playCountdownBeep スキップ (AudioContext なし) second=${second}`)
    return
  }
  if (ctx.state === 'suspended') {
    ctx.resume().catch(err =>
      log.warn(`[sound] playCountdownBeep(${second}) 中の AudioContext 再開に失敗: ${String(err)}`))
  }

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
    const dest = getMasterInput(ctx)
    // パルスは短いため release を 3ms まで詰める。gateTone の既定（40ms）のままだと
    // 20Hz ゲートのパルス幅（22.5ms）を超えて減衰し、カウントの切れ味が鈍る。
    const pulse = { attack: 0.003, release: 0.003 }
    for (let i = 0; i < steps; i++) {
      const pt = t0 + i * period
      gateTone(ctx, panTo(ctx, -0.5), 'square', 440, pt, pulseW, 0.12 * globalVolume,
        { ...pulse, detuneCents: -ALARM_DETUNE_CENTS })
      gateTone(ctx, panTo(ctx, 0.5), 'square', 440, pt, pulseW, 0.12 * globalVolume,
        { ...pulse, detuneCents: ALARM_DETUNE_CENTS })
      gateTone(ctx, dest, 'sine', 220, pt, pulseW, 0.15 * globalVolume, pulse)
      decayTone(ctx, dest, 'square', 880, pt, 0.001, 0.07 * globalVolume, pt + 0.018)
    }

    if (second === 1) {
      gateTone(ctx, dest, 'sine', 110, t0, totalDur, 0.30 * globalVolume, { attack: 0.010, release: 0.06 })
      gateTone(ctx, dest, 'sine',  55, t0, totalDur, 0.18 * globalVolume, { attack: 0.012, release: 0.06 })
      gateTone(ctx, panTo(ctx, 0.35), 'sine', 1320, t0, totalDur, 0.13 * globalVolume,
        { attack: 0.005, release: 0.06, detuneCents: 5 })
      gateTone(ctx, panTo(ctx, -0.35), 'sine', 1320, t0, totalDur, 0.13 * globalVolume,
        { attack: 0.005, release: 0.06, detuneCents: -5 })
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
  if (ctx.state === 'suspended') {
    ctx.resume().catch(err =>
      log.warn(`[sound] playKyoshinUpdateSound(${maxIndex}) 中の AudioContext 再開に失敗: ${String(err)}`))
  }
  const p = MARIMBA_PATTERNS[kyoshinLevel(maxIndex)]
  const base = ctx.currentTime + 0.02
  playGuarded(`playKyoshinUpdateSound(${maxIndex})`, () => {
    p.freqs.forEach((freq, i) =>
      marimba(ctx, freq, base + i * p.interval, p.duration, p.gain * gainScale, p.deep))
  })
}
