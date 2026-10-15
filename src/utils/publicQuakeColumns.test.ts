import { describe, expect, it } from 'vitest'
import { steim2Record } from '../test-utils/mseed2Fixture'
import { decodePublicQuakeWave, hasSamplesFrom, PUBLIC_QUAKE_COLUMNS, publicQuakeColumns } from './publicQuakeColumns'
import type { PublicStationEpoch } from './publicStations'

const SENS = 1e9 // カウント/(m/s)。1 カウント = 0.001 μm/s

const epoch: PublicStationEpoch = {
  code: 'JMM',
  nameJa: '宮城丸森',
  siteName: 'Marumori',
  lat: 37.9,
  lon: 140.8,
  elevation: 0,
  start: '2000-01-01T00:00:00',
  end: null,
  channels: (['BHE', 'BHN', 'BHZ'] as const).map((code) => ({ code, sampleRate: 20, sensitivity: SENS, sensitivityFreq: 1, azimuth: 0, dip: 0 })),
}

/** 2026-10-13 11:44:29.1234 UTC（通日 286） から 20 Hz で始まるレコード（mseed2Fixture の既定の時刻）。 */
const START = Date.UTC(2026, 9, 13, 11, 44, 29) + 123.4

function constant(value: number, n: number): Int32Array {
  return new Int32Array(n).fill(value)
}

describe('decodePublicQuakeWave', () => {
  it('3 成分を感度で μm/s に直し、窓の平均を引いて返す', () => {
    const recs = (['BHE', 'BHN', 'BHZ'] as const).map((channel, i) =>
      steim2Record(constant(1000 * (i + 1), 200), { station: 'JMM', channel, factor: 20, multiplier: 1 }).bytes,
    )
    const bytes = new Uint8Array(recs.reduce((n, r) => n + r.length, 0))
    let at = 0
    for (const r of recs) {
      bytes.set(r, at)
      at += r.length
    }
    const range = { fromMs: START - 1000, toMs: START + 60_000 }
    const got = decodePublicQuakeWave({ bytes, epoch, range })
    expect(got.unreadable).toBe(0)
    expect(got.rejected).toBe(0)
    expect(got.window).not.toBeNull()
    // 一定値なので平均を引けば 0
    for (let a = 0; a < 3; a += 1) expect(Math.abs(got.window!.gal[a][0])).toBeLessThan(1e-6)
  })

  // 安全弁: 別の観測点・表に無い成分のレコードは置かず、数える（黙って混ぜない）。
  it('別の観測点・表に無い成分は置かずに数える', () => {
    const other = steim2Record(constant(5, 50), { station: 'YOJ', channel: 'BHZ', factor: 20, multiplier: 1 }).bytes
    const odd = steim2Record(constant(5, 50), { station: 'JMM', channel: 'HHZ', factor: 20, multiplier: 1 }).bytes
    const bytes = new Uint8Array(other.length + odd.length)
    bytes.set(other, 0)
    bytes.set(odd, other.length)
    const got = decodePublicQuakeWave({ bytes, epoch, range: { fromMs: START - 1000, toMs: START + 60_000 } })
    expect(got.rejected).toBe(2)
    expect(got.window).toBeNull()
  })
})

describe('publicQuakeColumns', () => {
  it('範囲を一定の本数に割り、範囲の外は入れない', () => {
    const range = { fromMs: 0, toMs: 120_000 }
    const window = {
      firstSampleMs: 0,
      msPerSample: 1000,
      gal: [new Float32Array(200).fill(1), new Float32Array(200).fill(2), new Float32Array(200).fill(3)] as [Float32Array, Float32Array, Float32Array],
      memberCount: new Float32Array(200).fill(Infinity),
    }
    const cols = publicQuakeColumns(window, range)
    expect(cols.columnSpanMs).toBe(120_000 / PUBLIC_QUAKE_COLUMNS)
    expect(cols.columns.length).toBeLessThanOrEqual(PUBLIC_QUAKE_COLUMNS + 1)
  })

  it('サンプルが無ければ列も無い', () => {
    expect(publicQuakeColumns(null, { fromMs: 0, toMs: 1000 }).columns).toEqual([])
  })
})

describe('hasSamplesFrom', () => {
  const window = {
    firstSampleMs: 0,
    msPerSample: 1000,
    gal: [Float32Array.from([1, 1, NaN]), Float32Array.from([1, 1, NaN]), Float32Array.from([1, 1, NaN])] as [Float32Array, Float32Array, Float32Array],
    memberCount: new Float32Array(3).fill(Infinity),
  }
  // 正: その時刻以降に値があれば真。
  it('その時刻以降に値があれば真', () => expect(hasSamplesFrom(window, 1000)).toBe(true))
  // 対照: その時刻以降が欠け（NaN）か範囲の外なら偽（発生より後がまだ届いていない）。
  it('以降が欠けか範囲の外なら偽', () => {
    expect(hasSamplesFrom(window, 2000)).toBe(false)
    expect(hasSamplesFrom(window, 10_000)).toBe(false)
    expect(hasSamplesFrom(null, 0)).toBe(false)
  })
})
