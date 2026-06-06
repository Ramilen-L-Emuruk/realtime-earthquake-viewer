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
  // 地震情報（震源・震度情報 / 各地の震度情報）: 2音のチャイム（ピンポン）
  earthquake: [
    { freq: 880, start: 0, duration: 0.16 },
    { freq: 660, start: 0.18, duration: 0.28 },
  ],
  // 震度速報: 速報感のある3連音（震源未定だが有感情報）
  earthquakePrompt: [
    { freq: 880, start: 0.0, duration: 0.12 },
    { freq: 880, start: 0.16, duration: 0.12 },
    { freq: 660, start: 0.32, duration: 0.28 },
  ],
  // 震源情報 / 遠地地震 / その他: 控えめな単音
  earthquakeInfo: [
    { freq: 660, start: 0, duration: 0.3, gain: 0.15 },
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
  // 揺れ検知（強震モニタ first contact）: 控えめな単音
  kyoshin: [
    { freq: 440, start: 0, duration: 0.25 },
  ],
  // EEW続報: 初報より短く軽めの2音
  eewUpdate: [
    { freq: 760, start: 0.0, duration: 0.1, type: 'square', gain: 0.10 },
    { freq: 920, start: 0.14, duration: 0.1, type: 'square', gain: 0.10 },
  ],
  // EEWキャンセル: 下降する解除音
  eewCancel: [
    { freq: 440, start: 0, duration: 0.18 },
    { freq: 330, start: 0.22, duration: 0.28 },
  ],
  // EEW特別警報: 高音高速8連（震度6弱以上）
  eewSpecial: [
    { freq: 1000, start: 0.00, duration: 0.12, type: 'square', gain: 0.18 },
    { freq: 800,  start: 0.14, duration: 0.12, type: 'square', gain: 0.18 },
    { freq: 1000, start: 0.28, duration: 0.12, type: 'square', gain: 0.18 },
    { freq: 800,  start: 0.42, duration: 0.12, type: 'square', gain: 0.18 },
    { freq: 1000, start: 0.56, duration: 0.12, type: 'square', gain: 0.18 },
    { freq: 800,  start: 0.70, duration: 0.12, type: 'square', gain: 0.18 },
    { freq: 1000, start: 0.84, duration: 0.12, type: 'square', gain: 0.18 },
    { freq: 800,  start: 0.98, duration: 0.22, type: 'square', gain: 0.18 },
  ],
  // EEW低震度予報: 3音サイン波（緩やか）
  eewForecast: [
    { freq: 660, start: 0.0,  duration: 0.12, gain: 0.12 },
    { freq: 660, start: 0.16, duration: 0.12, gain: 0.12 },
    { freq: 550, start: 0.32, duration: 0.22, gain: 0.12 },
  ],
  // 大津波警報: 低音5連（tsunamiより強い）
  tsunamiMajor: [
    { freq: 420, start: 0.00, duration: 0.35, type: 'triangle', gain: 0.25 },
    { freq: 420, start: 0.45, duration: 0.35, type: 'triangle', gain: 0.25 },
    { freq: 420, start: 0.90, duration: 0.35, type: 'triangle', gain: 0.25 },
    { freq: 420, start: 1.35, duration: 0.35, type: 'triangle', gain: 0.25 },
    { freq: 420, start: 1.80, duration: 0.5,  type: 'triangle', gain: 0.25 },
  ],
  // 津波注意報: 中音2連（tsunamiより軽い）
  tsunamiWatch: [
    { freq: 600, start: 0.00, duration: 0.25, type: 'triangle', gain: 0.18 },
    { freq: 600, start: 0.35, duration: 0.35, type: 'triangle', gain: 0.18 },
  ],
}

// 強震モニタ index → 震度7段階のマッピング
// index 9=震度2相当、14=震度3、19=震度4、25=震度5弱、34=震度5強、40=震度6弱/6強、50=震度7
const KYOSHIN_LEVEL_PATTERNS: Tone[][] = [
  // Lv1 (index 9-13, 震度2): 低め単音
  [{ freq: 440, start: 0, duration: 0.2 }],
  // Lv2 (index 14-18, 震度3): 単音
  [{ freq: 523, start: 0, duration: 0.22 }],
  // Lv3 (index 19-24, 震度4): 2音
  [{ freq: 659, start: 0, duration: 0.15 }, { freq: 659, start: 0.2, duration: 0.2 }],
  // Lv4 (index 25-33, 震度5弱): 2音・やや強め
  [{ freq: 784, start: 0, duration: 0.15, gain: 0.24 }, { freq: 784, start: 0.2, duration: 0.22, gain: 0.24 }],
  // Lv5 (index 34-39, 震度5強): 3音
  [{ freq: 880, start: 0, duration: 0.13 }, { freq: 880, start: 0.18, duration: 0.13 }, { freq: 880, start: 0.36, duration: 0.2 }],
  // Lv6 (index 40-49, 震度6弱〜6強): square 3音・緊急感
  [
    { freq: 1047, start: 0.0, duration: 0.12, type: 'square', gain: 0.16 },
    { freq: 1047, start: 0.17, duration: 0.12, type: 'square', gain: 0.16 },
    { freq: 1047, start: 0.34, duration: 0.18, type: 'square', gain: 0.16 },
  ],
  // Lv7 (index 50+, 震度7): 下降する緊急音×3
  [
    { freq: 1175, start: 0.0, duration: 0.12, type: 'square', gain: 0.18 },
    { freq: 880,  start: 0.16, duration: 0.12, type: 'square', gain: 0.18 },
    { freq: 1175, start: 0.32, duration: 0.12, type: 'square', gain: 0.18 },
    { freq: 880,  start: 0.48, duration: 0.18, type: 'square', gain: 0.18 },
  ],
]

function kyoshinLevel(index: number): number {
  if (index >= 50) return 6
  if (index >= 40) return 5
  if (index >= 34) return 4
  if (index >= 25) return 3
  if (index >= 19) return 2
  if (index >= 14) return 1
  return 0
}

/** 指定した種別の通知音を鳴らす。 */
export function playAlertSound(type: AlertSoundType): void {
  playTones(PATTERNS[type])
}

/** 強震モニタの最大インデックスに応じた震度更新音を鳴らす。 */
export function playKyoshinUpdateSound(maxIndex: number): void {
  playTones(KYOSHIN_LEVEL_PATTERNS[kyoshinLevel(maxIndex)])
}
