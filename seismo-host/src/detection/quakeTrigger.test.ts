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

/** まとまりの時刻を `ms` だけずらす。 */
function shifted(chunks: readonly TriggerInput[], ms: number): TriggerInput[] {
  return chunks.map((c) => ({ ...c, firstSampleMs: c.firstSampleMs + ms }))
}

describe('TriggerDetector.health — 静かだっただけか、止まっているか', () => {
  const HOUR = 3_600_000

  it('一度も受けていなければ、どの値も「無い」で返す', () => {
    const h = new TriggerDetector().health()
    expect(h).toMatchObject({
      lastSampleMs: null,
      firstSampleMs: null,
      armed: false,
      warmUntilMs: null,
      inEvent: false,
      baselineGal: null,
      ratio: null,
      peak24h: null,
      peakWindowFromMs: null,
    })
    expect(h.onRatio).toBe(TRIGGER_CONFIG_DEFAULT.onRatio)
  })

  it('正: 静かな波形だけでも、引き金が生きていることが値で分かる（比の最大は引き金に届かない）', () => {
    const det = new TriggerDetector()
    run(signal(150, []), det)
    const h = det.health()
    expect(h.armed).toBe(true)
    expect(h.warmUntilMs).toBeNull()
    expect(h.inEvent).toBe(false)
    expect(h.lastSampleMs).toBe(T0 + 150_000 - DT)
    expect(h.firstSampleMs).toBe(T0)
    // ノイズ 0.5 gal を 5〜10 Hz で絞った水平 2 成分の合成は約 0.3 gal
    expect(h.baselineGal).toBeGreaterThan(0.15)
    expect(h.baselineGal).toBeLessThan(0.5)
    expect(h.ratio).toBeGreaterThan(0.3)
    expect(h.ratio).toBeLessThan(TRIGGER_CONFIG_DEFAULT.onRatio)
    expect(h.peak24h).not.toBeNull()
    expect(h.peak24h!.ratio).toBeGreaterThan(1)
    expect(h.peak24h!.ratio).toBeLessThan(TRIGGER_CONFIG_DEFAULT.onRatio)
    // 助走の間は比を数えないので、最大は助走が明けた後
    expect(h.peak24h!.atMs).toBeGreaterThanOrEqual(T0 + TRIGGER_CONFIG_DEFAULT.warmupSec * 1000)
    // 起動して 24 時間に満たないので、見ている範囲は最初に受けた時刻から
    expect(h.peakWindowFromMs).toBe(T0)
  })

  it('正: 揺れがあれば、比の最大とその時刻がその揺れを指す', () => {
    const det = new TriggerDetector()
    run(signal(150, [{ startSec: 100, durationSec: 6, hz: 7, amplitude: 1.5 }]), det)
    const p = det.health().peak24h!
    expect(p.ratio).toBeGreaterThan(3)
    expect(p.atMs - T0).toBeGreaterThanOrEqual(100_000)
    expect(p.atMs - T0).toBeLessThan(107_000)
  })

  it('正: 揺れの区間を開いている間は inEvent が立つ', () => {
    const det = new TriggerDetector()
    for (const c of signal(103, [{ startSec: 100, durationSec: 6, hz: 7, amplitude: 1.5 }])) det.push(c)
    expect(det.health().inEvent).toBe(true)
  })

  it('対照: 助走の間は引き金を引けない状態として返し、比も最大も出さない（平常時の強さは出す）', () => {
    const det = new TriggerDetector()
    run(signal(30, []), det)
    const h = det.health()
    expect(h.armed).toBe(false)
    expect(h.warmUntilMs).toBe(T0 + TRIGGER_CONFIG_DEFAULT.warmupSec * 1000)
    expect(h.ratio).toBeNull()
    expect(h.peak24h).toBeNull()
    expect(h.baselineGal).toBeGreaterThan(0)
  })

  it('対照: 平らな値しか来なければ、平常時の強さが 0 になる（比も 0 のまま）', () => {
    const det = new TriggerDetector()
    const flat: TriggerInput[] = []
    for (let i = 0; i < 90 * FS; i += 30) {
      const z = new Array(30).fill(0)
      flat.push({ firstSampleMs: T0 + i * DT, msPerSample: DT, gal: [z, z, z] })
    }
    run(flat, det)
    const h = det.health()
    expect(h.armed).toBe(true)
    expect(h.baselineGal).toBe(0)
    expect(h.ratio).toBe(0)
    expect(h.peak24h!.ratio).toBe(0)
  })

  it('安全弁: 24 時間より前の揺れは、比の最大から外れる', () => {
    const det = new TriggerDetector()
    run(signal(150, [{ startSec: 100, durationSec: 6, hz: 7, amplitude: 1.5 }]), det)
    // 25 時間後に静かな波形が戻ってくる（途切れたので助走からやり直す）
    run(shifted(signal(150, [], 0.5, 2), 25 * HOUR), det)
    const h = det.health()
    expect(h.peak24h!.ratio).toBeLessThan(TRIGGER_CONFIG_DEFAULT.onRatio)
    expect(h.peak24h!.atMs).toBeGreaterThanOrEqual(T0 + 25 * HOUR)
    // 見ている範囲の頭は 24 時間前（1 分単位）。最初に受けた時刻より後になる
    expect(h.peakWindowFromMs).toBeGreaterThan(T0)
    expect(h.lastSampleMs! - h.peakWindowFromMs!).toBeLessThanOrEqual(24 * HOUR)
    expect(h.lastSampleMs! - h.peakWindowFromMs!).toBeGreaterThan(24 * HOUR - 60_000)
  })

  it('安全弁: 途切れて助走へ戻っても、それまでの 24 時間の最大は残る', () => {
    const det = new TriggerDetector()
    run(signal(150, [{ startSec: 100, durationSec: 6, hz: 7, amplitude: 1.5 }]), det)
    run(shifted(signal(30, [], 0.5, 2), HOUR), det)
    const h = det.health()
    expect(h.armed).toBe(false)
    expect(h.peak24h!.ratio).toBeGreaterThan(3)
  })

  it('peakBetween: 範囲（1 分単位）に入る最大だけを返し、入らなければ null', () => {
    const det = new TriggerDetector()
    run(signal(200, [{ startSec: 130, durationSec: 6, hz: 7, amplitude: 1.5 }]), det)
    expect(det.peakBetween(T0, T0 + 200_000)!.ratio).toBeGreaterThan(3)
    // 揺れ（130 秒〜）より前の 1 分（60〜120 秒）だけ
    const before = det.peakBetween(T0 + 60_000, T0 + 110_000)
    expect(before!.ratio).toBeLessThan(TRIGGER_CONFIG_DEFAULT.onRatio)
    // 1 分単位へ外向きに丸める: 121 秒〜122 秒を訊いても、その分（120〜180 秒）にある揺れを返す
    const rounded = det.peakBetween(T0 + 121_000, T0 + 122_000)
    expect(rounded!.ratio).toBeGreaterThan(3)
    expect(rounded!.atMs - T0).toBeGreaterThanOrEqual(130_000)
    // 何も受けていない範囲
    expect(det.peakBetween(T0 + HOUR, T0 + 2 * HOUR)).toBeNull()
  })

  it('安全弁: 刻みが変わってフィルタを組めなくなったら、「引き金を引ける」状態も落とす（古い比を残さない）', () => {
    const det = new TriggerDetector()
    run(signal(150, []), det)
    expect(det.health().armed).toBe(true)
    // 50 Hz（特徴量の最上の帯を組めない刻み）のまとまりが続きに来る
    det.push({ firstSampleMs: T0 + 150_000, msPerSample: 20, gal: [[1, 2], [1, 2], [1, 2]] })
    const h = det.health()
    expect(h.armed).toBe(false)
    expect(h.ratio).toBeNull()
    expect(h.warmUntilMs).toBeNull()
    expect(det.droppedChunks).toBe(1)
  })

  it('安全弁: 時計が最初のサンプルより前へ戻っても、比の最大の範囲の頭は最後のサンプルを越えない', () => {
    const det = new TriggerDetector()
    run(signal(150, []), det)
    run(shifted(signal(30, [], 0.5, 3), -2 * HOUR), det)
    const h = det.health()
    expect(h.lastSampleMs!).toBeLessThan(T0)
    expect(h.peakWindowFromMs!).toBeLessThanOrEqual(h.lastSampleMs!)
  })

  it('安全弁: 状態を読んでも、切り出す区間は変わらない', () => {
    const chunks = signal(200, [
      { startSec: 100, durationSec: 3, hz: 7, amplitude: 1.5 },
      { startSec: 130, durationSec: 3, hz: 7, amplitude: 1.5 },
    ])
    const plain = run(chunks)
    const det = new TriggerDetector()
    const watched: TriggerEvent[] = []
    for (const c of chunks) {
      watched.push(...det.push(c))
      det.health()
      det.peakBetween(T0, T0 + 200_000)
    }
    watched.push(...det.flush())
    expect(watched).toEqual(plain)
  })
})
