import { describe, expect, it } from 'vitest'

import { SHAKE_ENVELOPE_DEFAULT } from './eventClassifier'
import { QuakeDetector, phaseWindowFrom } from './quakeDetector'
import type { TriggerInput } from './quakeTrigger'

const FS = 100
const DT = 1000 / FS
const T0 = Date.UTC(2026, 9, 3, 4, 0, 0)

function gaussian(seed: number): () => number {
  let s = seed >>> 0
  const uniform = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s + 1) / 4294967297
  }
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
}

/**
 * 地震に似せた波形: 静穏な雑音に、`sSec` から 7 Hz の水平動（上下動は水平の 0.45 倍）を重ねる。
 * `zRatio`・`lowHz` で揺れ方を変えられる。
 */
function quakeLike(totalSec: number, sSec: number, opts: { zRatio?: number; hz?: number; amp?: number } = {}): TriggerInput[] {
  const g = gaussian(11)
  const hz = opts.hz ?? 7
  const amp = opts.amp ?? 1.5
  const zRatio = opts.zRatio ?? 0.45
  const n = totalSec * FS
  const axes: [number[], number[], number[]] = [[], [], []]
  for (let i = 0; i < n; i++) {
    const t = i / FS
    const on = t >= sSec && t < sSec + 6
    const s = on ? Math.sin(2 * Math.PI * hz * (t - sSec)) : 0
    const c = on ? Math.cos(2 * Math.PI * hz * (t - sSec)) : 0
    axes[0].push(0.5 * g() + amp * s)
    axes[1].push(0.5 * g() + amp * c)
    axes[2].push(0.5 * g() + amp * zRatio * Math.sin(2 * Math.PI * hz * (t - sSec) + 1) * (on ? 1 : 0))
  }
  const chunks: TriggerInput[] = []
  for (let i = 0; i < n; i += 30) {
    chunks.push({
      firstSampleMs: T0 + i * DT,
      msPerSample: DT,
      gal: [axes[0].slice(i, i + 30), axes[1].slice(i, i + 30), axes[2].slice(i, i + 30)],
    })
  }
  return chunks
}

function run(chunks: readonly TriggerInput[]) {
  const det = new QuakeDetector()
  const out = chunks.flatMap((c) => det.push(c))
  out.push(...det.flush())
  return { det, out }
}

describe('QuakeDetector', () => {
  it('正: 7 Hz の水平動が主で上下動が控えめな揺れは「地震らしい」とし、S を引き金の近くに拾う', () => {
    const { out } = run(quakeLike(160, 100))
    expect(out).toHaveLength(1)
    expect(out[0].shakeClass).toBe('quake-like')
    expect(out[0].phases?.s).not.toBeNull()
    expect(Math.abs(out[0].phases!.s!.atMs - (T0 + 100_000))).toBeLessThan(500)
  })

  it('対照: 上下動が水平動と同じくらい強い揺れは「生活振動らしい」', () => {
    const { out } = run(quakeLike(160, 100, { zRatio: 1.2 }))
    expect(out).toHaveLength(1)
    expect(out[0].shakeClass).toBe('local-like')
  })

  it('窓の扱いを記録に残す: 拾えたときは picked', () => {
    const { out } = run(quakeLike(160, 100))
    expect(out[0].phaseWindow).toBe('picked')
  })

  /** `startSec` から `durSec` ぶんのまとまりを抜く（引き金は 1 秒までの途切れを 1 区間のまま扱う）。 */
  function withGap(startSec: number, durSec = 0.6): TriggerInput[] {
    return quakeLike(160, 100).filter((c) => {
      const t = c.firstSampleMs - T0
      return t < startSec * 1000 || t >= (startSec + durSec) * 1000
    })
  }

  /** `atSec` のサンプルを 1 つ非有限にする。 */
  function withNaN(atSec: number): TriggerInput[] {
    const chunks = quakeLike(160, 100)
    const at = chunks.findIndex((c) => c.firstSampleMs - T0 >= atSec * 1000)
    const bad = chunks[at]
    const x = Array.from(bad.gal[0])
    x[5] = Number.NaN
    chunks[at] = { ...bad, gal: [x, bad.gal[1], bad.gal[2]] }
    return chunks
  }

  it('正: S の 20 秒前の途切れでは、途切れの後ろから窓を始め直して S を拾う', () => {
    const { det, out } = run(withGap(80))
    expect(out).toHaveLength(1)
    expect(out[0].phaseWindow).toBe('picked')
    expect(Math.abs(out[0].phases!.s!.atMs - (T0 + 100_000))).toBeLessThan(500)
    expect(det.phaseWindowsBroken).toBe(0)
  })

  it('安全弁: S を探す範囲に途切れが掛かったら P/S を拾わず、数えて gap と残す', () => {
    const { det, out } = run(withGap(95))
    expect(out).toHaveLength(1)
    expect(out[0].phaseWindow).toBe('gap')
    expect(out[0].phases).toBeNull()
    expect(det.phaseWindowsBroken).toBe(1)
  })

  it('正: S を探す範囲より前の非有限値では、その後ろから始め直して S を拾う', () => {
    const { det, out } = run(withNaN(70))
    expect(out[0].phaseWindow).toBe('picked')
    expect(Math.abs(out[0].phases!.s!.atMs - (T0 + 100_000))).toBeLessThan(500)
    expect(det.phaseWindowsBroken).toBe(0)
  })

  it('安全弁: S を探す範囲の近くに非有限値が混じっていたら P/S を拾わず non-finite と残す', () => {
    const { det, out } = run(withNaN(90))
    expect(out[0].phaseWindow).toBe('non-finite')
    expect(out[0].phases).toBeNull()
    expect(det.phaseWindowsBroken).toBe(1)
  })

  it('対照: 窓の終わり（引き金の 10 秒後）をまたぐまとまりの、窓の外にだけある非有限値では止めない', () => {
    // 窓の終わり T0+110000 をまたぐのは T0+109800 から始まるまとまり。その 25 番目（T0+110050）を壊す。
    const chunks = quakeLike(160, 100)
    const at = chunks.findIndex((c) => c.firstSampleMs === T0 + 109_800)
    const bad = chunks[at]
    const x = Array.from(bad.gal[0])
    x[25] = Number.NaN
    chunks[at] = { ...bad, gal: [x, bad.gal[1], bad.gal[2]] }
    const r = phaseWindowFrom(chunks, T0 + 100_000, [5, 10])
    expect(r.kind).toBe('picked')
  })

  it('対照: 窓より前の途切れ（フィルタの助走より古い）では拾い出しを止めない', () => {
    const { det, out } = run(withGap(20))
    expect(out[0].phaseWindow).toBe('picked')
    expect(det.phaseWindowsBroken).toBe(0)
  })

  it('安全弁: 刻みの読めないまとまりは窓の材料に残さない（窓の位置の計算を壊さない）', () => {
    const chunks = quakeLike(160, 100)
    chunks.splice(5, 0, { firstSampleMs: T0 + 50, msPerSample: 0, gal: [[1], [1], [1]] })
    const { det, out } = run(chunks)
    expect(out[0].phaseWindow).toBe('picked')
    expect(det.phaseFailures).toBe(0)
  })

  it('対照: 継ぎ目の小さなずれ（1 サンプル）は位置で吸収し、S の時刻を狂わせない', () => {
    // 窓の中のまとまりを 1 つおきに 1 サンプルぶん後ろへずらす（時刻の揺らぎ）
    const chunks = quakeLike(160, 100).map((c, i) =>
      i % 2 === 0 && c.firstSampleMs - T0 > 60_000 ? { ...c, firstSampleMs: c.firstSampleMs + DT } : c,
    )
    const r = phaseWindowFrom(chunks, T0 + 100_000, [5, 10])
    expect(r.kind).toBe('picked')
    if (r.kind !== 'picked') return
    expect(Math.abs(r.phases.s!.atMs - (T0 + 100_000))).toBeLessThan(500)
  })

  it('手元に窓の波形が無ければ no-data（途切れとは数えない）', () => {
    expect(phaseWindowFrom([], T0, [5, 10]).kind).toBe('no-data')
    // 窓の終わり間際から始まった波形（起動直後）: フィルタを落ち着かせる余地が無い
    const late = quakeLike(160, 100).filter((c) => c.firstSampleMs - T0 >= 107_000)
    expect(phaseWindowFrom(late, T0 + 100_000, [5, 10]).kind).toBe('no-data')
  })

  it('揺れ方の比は枠が持つ基準の帯で取る（引き金の帯の設定に引きずられない）', () => {
    const det = new QuakeDetector({ envelope: { ...SHAKE_ENVELOPE_DEFAULT, referenceBandHz: [2, 5] } })
    const out = quakeLike(160, 100).flatMap((c) => det.push(c))
    out.push(...det.flush())
    // 7 Hz の揺れなので、2〜5 Hz を基準にすると 5〜10 Hz の比が 1 を大きく超える
    expect(out[0].ratios!.bandRatios[1]).toBe(1)
    expect(out[0].ratios!.bandRatios[2]).toBeGreaterThan(1)
  })

  it('安全弁: 枠の基準の帯が特徴量の帯に無ければ、作るときに投げる', () => {
    expect(() => new QuakeDetector({ envelope: { ...SHAKE_ENVELOPE_DEFAULT, referenceBandHz: [5, 9] } })).toThrow()
  })

  it('安全弁: P/S の窓より古い波形は捨て、長く流しても抱える量が増えない', () => {
    const det = new QuakeDetector()
    const chunks = quakeLike(1200, 1100)
    for (const c of chunks) det.push(c)
    // 内部の保持は「P/S の窓 ＋ 助走 ＋ 区間の最長」ぶん（約 250 秒）に収まる
    const kept = (det as unknown as { kept: TriggerInput[] }).kept
    const spanSec = (kept[kept.length - 1].firstSampleMs - kept[0].firstSampleMs) / 1000
    expect(spanSec).toBeLessThan(300)
  })
})
