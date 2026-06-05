// 地震情報・緊急地震速報・津波情報の受信時に鳴らす通知音。
// 音声ファイルを持たず Web Audio API でビープ音を生成する（種別ごとに音が異なる）。
//
// 注意: ブラウザの自動再生制限により、ユーザー操作（クリック等）が一度行われるまで
// 音は鳴らない。初回操作時に unlockAudio() を呼んで AudioContext を有効化する。

export type AlertSoundType = 'earthquake' | 'eew' | 'tsunami'

let audioCtx: AudioContext | null = null

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

interface Tone {
  freq: number
  start: number
  duration: number
  type?: OscillatorType
  gain?: number
}

function playTones(tones: Tone[]): void {
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()

  const base = ctx.currentTime + 0.02
  for (const t of tones) {
    const osc = ctx.createOscillator()
    const gainNode = ctx.createGain()
    osc.type = t.type ?? 'sine'
    osc.frequency.value = t.freq
    osc.connect(gainNode)
    gainNode.connect(ctx.destination)

    const peak = t.gain ?? 0.2
    const startAt = base + t.start
    const endAt = startAt + t.duration
    // クリックノイズ防止のため立ち上がり・立ち下がりをなだらかにする
    gainNode.gain.setValueAtTime(0, startAt)
    gainNode.gain.linearRampToValueAtTime(peak, startAt + 0.012)
    gainNode.gain.setValueAtTime(peak, Math.max(startAt + 0.012, endAt - 0.04))
    gainNode.gain.linearRampToValueAtTime(0, endAt)

    osc.start(startAt)
    osc.stop(endAt + 0.02)
  }
}

const PATTERNS: Record<AlertSoundType, Tone[]> = {
  // 地震情報: 2音のチャイム（ピンポン）
  earthquake: [
    { freq: 880, start: 0, duration: 0.16 },
    { freq: 660, start: 0.18, duration: 0.28 },
  ],
  // 緊急地震速報: 緊急性のある2音の繰り返し
  eew: [
    { freq: 920, start: 0.0, duration: 0.14, type: 'square', gain: 0.16 },
    { freq: 760, start: 0.16, duration: 0.14, type: 'square', gain: 0.16 },
    { freq: 920, start: 0.32, duration: 0.14, type: 'square', gain: 0.16 },
    { freq: 760, start: 0.48, duration: 0.14, type: 'square', gain: 0.16 },
    { freq: 920, start: 0.64, duration: 0.22, type: 'square', gain: 0.16 },
  ],
  // 津波: 低めの警報音を3回
  tsunami: [
    { freq: 520, start: 0.0, duration: 0.35, type: 'triangle', gain: 0.22 },
    { freq: 520, start: 0.45, duration: 0.35, type: 'triangle', gain: 0.22 },
    { freq: 520, start: 0.9, duration: 0.5, type: 'triangle', gain: 0.22 },
  ],
}

/** 指定した種別の通知音を鳴らす。 */
export function playAlertSound(type: AlertSoundType): void {
  playTones(PATTERNS[type])
}
