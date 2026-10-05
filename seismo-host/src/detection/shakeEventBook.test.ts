import { describe, expect, it } from 'vitest'

import type { P2pReferenceQuake } from './p2pQuake'
import type { DetectedShake } from './quakeDetector'
import { MATCH_DEADLINE_MS, MEMORY_MS, ShakeEventBook } from './shakeEventBook'
import type { ShakeEventRecord } from './shakeEvent'

const HOME = { lat: 35.0, lon: 135.0 }
// 2026-10-03 13:26 の熊本県天草・芦北地方（M3.5）と、引き金の時刻（架空）。
const ORIGIN = Date.UTC(2026, 9, 3, 4, 26, 0)
const ON = Date.UTC(2026, 9, 3, 4, 27, 0)
const AMAKUSA: P2pReferenceQuake = {
  originMs: ORIGIN,
  originPrecisionMs: 60_000,
  lat: 32.5,
  lon: 130.5,
  depthKm: 0,
  magnitude: 3.5,
  name: '熊本県天草・芦北地方',
  maxScale: 20,
  key: '2026/10/03 13:26:00|熊本県天草・芦北地方',
}

function shake(onMs: number, shakeClass: 'quake-like' | 'local-like' = 'quake-like'): DetectedShake {
  return {
    trigger: {
      onMs,
      offMs: onMs + 9_000,
      end: 'quiet',
      peakRatio: 4.4,
      baselineGal: 0.17,
      peakBandGal: 0.9,
      peakHorizontalGal: 2.95,
      peakVectorGal: 3.1,
      bandRmsH: [0.2, 0.3, 0.8, 0.45, 0.3],
      bandRmsZ: [0, 0, 0.3, 0, 0],
    },
    shakeClass,
    ratios: { verticalRatio: 0.38, bandRatios: [0.25, 0.38, 1, 0.56, 0.38] },
    phases: { s: { atMs: onMs - 1000, snr: 3.8 }, p: null, pSnrTried: 1.1 },
    phaseWindow: 'picked',
  }
}

function setup(opts: { covered?: boolean; startNow?: number } = {}) {
  let now = opts.startNow ?? ON + 15_000
  const saved: ShakeEventRecord[] = []
  const published: ShakeEventRecord[] = []
  const book = new ShakeEventBook({
    save: (r) => saved.push(r),
    publish: (r) => published.push(r),
    observerOf: (id) => (id === 'station-1' ? HOME : null),
    feedCovered: () => opts.covered ?? true,
    now: () => now,
    detectorVersion: 1,
  })
  return { book, saved, published, advance: (ms: number) => (now += ms) }
}

const SENSORS = [{ boardKey: 'mac:020000000001', sensorId: 'i2c0-68' }]

describe('ShakeEventBook', () => {
  it('揺れが閉じたら版 1（照合待ち）を残して押し出す。区間の最大の計測震度相当を添える', () => {
    const { book, saved, published } = setup()
    book.noteStationReading('station-1', ON - 10_000, 0.4)
    book.noteStationReading('station-1', ON + 2_000, 1.6)
    book.noteStationReading('station-1', ON + 30_000, 2.5) // 区間の外
    const rec = book.addShake('station-1', shake(ON), SENSORS)
    expect(rec.verdict).toBe('pending')
    expect(rec.rev).toBe(1)
    expect(rec.maxIntensity).toBe(1.6)
    expect(rec.pMs).toBeNull()
    expect(rec.pSnr).toBe(1.1)
    expect(rec.spatialConsistency).toBe('not-evaluated')
    expect(saved).toHaveLength(1)
    expect(published).toHaveLength(1)
  })

  it('正: 時刻の合う地震情報が後から届いたら `quake` の版（rev 2）を足す', () => {
    const { book, saved } = setup()
    book.addShake('station-1', shake(ON), SENSORS)
    book.addQuake(AMAKUSA)
    expect(saved.map((r) => [r.rev, r.verdict])).toEqual([[1, 'pending'], [2, 'quake']])
    expect(saved[1].matchedQuake?.name).toBe('熊本県天草・芦北地方')
    expect(saved[1].matchedQuake?.distanceKm).toBeGreaterThan(0)
  })

  it('正: 先に届いていた地震情報とも、揺れが閉じた時点で照らし合わせる', () => {
    const { book, saved } = setup()
    book.addQuake(AMAKUSA)
    book.addShake('station-1', shake(ON), SENSORS)
    expect(saved.map((r) => r.verdict)).toEqual(['pending', 'quake'])
  })

  it('対照: 時刻の合わない地震情報では判定を変えない', () => {
    const { book, saved } = setup()
    book.addShake('station-1', shake(ON + 5 * 60_000), SENSORS)
    book.addQuake(AMAKUSA)
    expect(saved.map((r) => r.verdict)).toEqual(['pending'])
  })

  it('期限が来たら、合わなかった揺れを揺れ方で決める（受信がずっと繋がっていた場合）', () => {
    const { book, saved, advance } = setup({ covered: true })
    book.addShake('station-1', shake(ON, 'local-like'), SENSORS)
    advance(MATCH_DEADLINE_MS - 1)
    book.tick()
    expect(saved).toHaveLength(1)
    advance(1)
    book.tick()
    expect(saved.map((r) => r.verdict)).toEqual(['pending', 'local-like'])
  })

  it('安全弁: 受信が途切れていたら「合わなかった」とは言わず `unchecked` にする', () => {
    const { book, saved, advance } = setup({ covered: false })
    book.addShake('station-1', shake(ON), SENSORS)
    advance(MATCH_DEADLINE_MS)
    book.tick()
    expect(saved[1].verdict).toBe('unchecked')
  })

  it('期限を過ぎてから届いた地震情報でも、覚えている間なら `quake` へ上書きする', () => {
    const { book, saved, advance } = setup({ covered: false })
    book.addShake('station-1', shake(ON), SENSORS)
    advance(MATCH_DEADLINE_MS)
    book.tick()
    book.addQuake(AMAKUSA)
    expect(saved.map((r) => r.verdict)).toEqual(['pending', 'unchecked', 'quake'])
  })

  it('覚えておく長さを過ぎた揺れは忘れる（その後に地震情報が届いても版を足さない）', () => {
    const { book, saved, advance } = setup()
    book.addShake('station-1', shake(ON), SENSORS)
    advance(MATCH_DEADLINE_MS)
    book.tick()
    advance(MEMORY_MS)
    book.tick()
    book.addQuake(AMAKUSA)
    expect(saved.map((r) => r.verdict)).toEqual(['pending', 'quake-like'])
  })

  it('安全弁: 期限の判定を通らないまま覚えておく長さを過ぎた揺れも、判定を書いてから忘れる', () => {
    // 照合待ちのまま捨てると、その揺れの記録は `pending` で止まる
    const { book, saved, advance } = setup()
    book.addShake('station-1', shake(ON), SENSORS)
    advance(MEMORY_MS + 1)
    const tickedAt = saved.length
    book.tick()
    expect(saved.slice(tickedAt).map((r) => r.verdict)).toEqual(['quake-like'])
  })

  it('正: 同じ地震の続報で規模・震源が変われば、その値で版を足す', () => {
    const { book, saved } = setup()
    book.addShake('station-1', shake(ON), SENSORS)
    book.addQuake(AMAKUSA)
    book.addQuake({ ...AMAKUSA, magnitude: 3.7, lat: 32.45 })
    expect(saved.map((r) => [r.rev, r.verdict])).toEqual([[1, 'pending'], [2, 'quake'], [3, 'quake']])
    expect(saved[2].matchedQuake?.magnitude).toBe(3.7)
    expect(saved[2].matchedQuake?.lat).toBe(32.45)
    expect(saved[2].matchedQuake?.distanceKm).not.toBe(saved[1].matchedQuake?.distanceKm)
  })

  it('対照: 同じ報をもう一度受けても版を足さない', () => {
    const { book, saved } = setup()
    book.addShake('station-1', shake(ON), SENSORS)
    book.addQuake(AMAKUSA)
    book.addQuake({ ...AMAKUSA })
    expect(saved).toHaveLength(2)
  })

  it('観測点の位置が分からなければ照合しない（期限で揺れ方に倒れる）', () => {
    const { book, saved } = setup()
    book.addShake('station-x', shake(ON), SENSORS)
    book.addQuake(AMAKUSA)
    expect(saved.map((r) => r.verdict)).toEqual(['pending'])
  })
})
