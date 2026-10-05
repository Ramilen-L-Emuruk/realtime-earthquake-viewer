import { describe, expect, it } from 'vitest'

import { TRIGGER_CONFIG_DEFAULT, TriggerDetector } from './quakeTrigger'
import type { TriggerEvent, TriggerInput } from './quakeTrigger'

const FS = 100
const DT = 1000 / FS
const T0 = Date.UTC(2026, 9, 3, 4, 0, 0)

/** 決まった種から作る正規乱数（テストを毎回同じにする）。 */
function gaussian(seed: number): () => number {
  let s = seed >>> 0
  const uniform = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s + 1) / 4294967297
  }
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
}

interface Burst {
  readonly startSec: number
  readonly durationSec: number
  readonly hz: number
  /** 水平 2 成分それぞれの振幅（gal）。 */
  readonly amplitude: number
  /** 上下動の振幅（gal）。既定 0。 */
  readonly zAmplitude?: number
}

/** 静穏なノイズ（成分ごとに標準偏差 `noise` gal）に揺れを重ねた波形を、0.3 秒のまとまりで作る。 */
function signal(totalSec: number, bursts: readonly Burst[], noise = 0.5, seed = 1): TriggerInput[] {
  const g = gaussian(seed)
  const n = totalSec * FS
  const axes: [number[], number[], number[]] = [[], [], []]
  for (let i = 0; i < n; i++) {
    const t = i / FS
    let x = noise * g()
    let y = noise * g()
    let z = noise * g()
    for (const b of bursts) {
      if (t >= b.startSec && t < b.startSec + b.durationSec) {
        const s = Math.sin(2 * Math.PI * b.hz * (t - b.startSec))
        x += b.amplitude * s
        y += b.amplitude * Math.cos(2 * Math.PI * b.hz * (t - b.startSec))
        z += (b.zAmplitude ?? 0) * s
      }
    }
    axes[0].push(x)
    axes[1].push(y)
    axes[2].push(z)
  }
  const chunks: TriggerInput[] = []
  const per = 30
  for (let i = 0; i < n; i += per) {
    chunks.push({
      firstSampleMs: T0 + i * DT,
      msPerSample: DT,
      gal: [axes[0].slice(i, i + per), axes[1].slice(i, i + per), axes[2].slice(i, i + per)],
    })
  }
  return chunks
}

function run(chunks: readonly TriggerInput[], det = new TriggerDetector()): TriggerEvent[] {
  const out: TriggerEvent[] = []
  for (const c of chunks) out.push(...det.push(c))
  out.push(...det.flush())
  return out
}

describe('TriggerDetector', () => {
  // ノイズ 0.5 gal（成分ごと）を 5〜10 Hz で絞ると、水平 2 成分の合成で約 0.3 gal になる。
  it('正: 平常時の数倍の 7 Hz の揺れを 1 区間として切り出す', () => {
    const events = run(signal(150, [{ startSec: 100, durationSec: 6, hz: 7, amplitude: 1.5 }]))
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.end).toBe('quiet')
    expect(ev.onMs - T0).toBeGreaterThanOrEqual(100_000)
    expect(ev.onMs - T0).toBeLessThan(101_500)
    expect(ev.peakRatio).toBeGreaterThan(3)
    // 引き金の帯（5〜10 Hz・並びの 3 番目）がいちばん強い
    const strongest = ev.bandRmsH.indexOf(Math.max(...ev.bandRmsH))
    expect(strongest).toBe(2)
  })

  it('対照: 平常時の 2 倍に届かない揺れでは切り出さない', () => {
    const events = run(signal(150, [{ startSec: 100, durationSec: 6, hz: 7, amplitude: 0.35 }]))
    expect(events).toHaveLength(0)
  })

  it('対照: 帯域の外（1 Hz）は強くても引き金を引かない', () => {
    const events = run(signal(150, [{ startSec: 100, durationSec: 6, hz: 1, amplitude: 5 }]))
    expect(events).toHaveLength(0)
  })

  it('静穏なノイズだけでは 10 分流しても何も切り出さない', () => {
    const events = run(signal(600, []))
    expect(events).toHaveLength(0)
  })

  it('P と S の間の静かな数秒（holdSec 未満）は 1 区間に繋ぐ', () => {
    const events = run(
      signal(160, [
        { startSec: 100, durationSec: 2, hz: 7, amplitude: 1.2 },
        { startSec: 104, durationSec: 5, hz: 7, amplitude: 2 },
      ]),
    )
    expect(events).toHaveLength(1)
  })

  it('間が holdSec より長く空いた 2 つの揺れは別の区間にする', () => {
    const events = run(
      signal(200, [
        { startSec: 100, durationSec: 3, hz: 7, amplitude: 1.5 },
        { startSec: 130, durationSec: 3, hz: 7, amplitude: 1.5 },
      ]),
    )
    expect(events).toHaveLength(2)
  })

  it('安全弁: 助走（warmupSec）の間は引き金を引かない', () => {
    const events = run(signal(150, [{ startSec: 20, durationSec: 6, hz: 7, amplitude: 1.5 }]))
    expect(events).toHaveLength(0)
  })

  it('安全弁: 区間の最中は基準（LTA）を進めない —— 長い揺れでも比が落ちていかない', () => {
    const events = run(signal(220, [{ startSec: 100, durationSec: 60, hz: 7, amplitude: 1.5 }]))
    expect(events).toHaveLength(1)
    expect(events[0].offMs - events[0].onMs).toBeGreaterThan(55_000)
  })

  it('安全弁: 波形が途切れたら開いている区間を閉じ、助走からやり直す', () => {
    const chunks = signal(200, [{ startSec: 100, durationSec: 20, hz: 7, amplitude: 1.5 }])
    // 105 秒〜 の 10 秒ぶんを抜く（途切れ）
    const cut = chunks.filter((c) => c.firstSampleMs - T0 < 105_000 || c.firstSampleMs - T0 >= 115_000)
    const det = new TriggerDetector()
    const events = run(cut, det)
    expect(events.map((e) => e.end)).toEqual(['gap'])
    expect(det.resets).toBe(1)
  })

  it('安全弁: 長さの上限で閉じる', () => {
    const det = new TriggerDetector({ ...TRIGGER_CONFIG_DEFAULT, maxEventSec: 20 })
    const events = run(signal(220, [{ startSec: 100, durationSec: 60, hz: 7, amplitude: 1.5 }]), det)
    expect(events[0].end).toBe('max-length')
    expect(events[0].offMs - events[0].onMs).toBeLessThanOrEqual(20_010)
  })

  it('安全弁: 刻みが粗すぎて帯域フィルタを組めないまとまり（50 Hz）は捨てて数え、投げない', () => {
    const det = new TriggerDetector()
    const chunk = { firstSampleMs: T0, msPerSample: 20, gal: [[1, 2], [1, 2], [1, 2]] as [number[], number[], number[]] }
    expect(() => det.push(chunk)).not.toThrow()
    expect(det.droppedChunks).toBe(1)
    // 組める刻みが来たら、そこから普段どおり受ける
    expect(det.push({ firstSampleMs: T0 + 40, msPerSample: 10, gal: [[1], [1], [1]] })).toEqual([])
    expect(det.droppedChunks).toBe(1)
  })

  it('刻みの読めないまとまりは捨てて数え、投げない', () => {
    const det = new TriggerDetector()
    expect(det.push({ firstSampleMs: T0, msPerSample: Number.NaN, gal: [[1], [1], [1]] })).toEqual([])
    expect(det.droppedChunks).toBe(1)
  })
})
