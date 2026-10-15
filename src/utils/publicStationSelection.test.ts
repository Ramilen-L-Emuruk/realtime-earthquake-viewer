// どの公開観測点の波形を出すか（`docs/public-waveform-design.md` §4）。表は本物（`public/data/public-stations.json`）を使う。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { haversineKm } from './geo'
import { activeEpochsAt, type PublicStationsFile } from './publicStations'
import {
  candidateCodes,
  EMPTY_PUBLIC_SELECTION,
  PUBLIC_STATION_DETECTION_RADIUS_KM,
  PUBLIC_STATION_NEAREST_COUNT,
  selectPublicStations,
} from './publicStationSelection'
import { predictMeasuredIntensity } from './eew'

const file = JSON.parse(readFileSync('public/data/public-stations.json', 'utf8')) as PublicStationsFile
const NOW = Date.parse('2026-10-15T00:00:00Z')
const epochs = activeEpochsAt(file, NOW)

/** 宮城県沖（JMM 宮城丸森の東方）。 */
const MIYAGI = { lat: 38.3, lon: 142.0 }

describe('candidateCodes（震源があるとき）', () => {
  // 正: 予測計測震度が −1.5 以上の観測点は全部入り、近い順に並ぶ。
  it('予測が −1.5 以上の観測点を近い順に選ぶ', () => {
    const codes = candidateCodes(epochs, { kind: 'hypocenter', ...MIYAGI, depthKm: 40, magnitude: 6.5, assumed: false }, null)
    expect(codes[0]).toBe('JMM')
    for (const code of codes) {
      const e = epochs.find((x) => x.code === code)!
      expect(predictMeasuredIntensity(6.5, 40, haversineKm(MIYAGI.lat, MIYAGI.lon, e.lat, e.lon))).toBeGreaterThanOrEqual(-1.5)
    }
  })

  // 対照: −1.5 に届かない観測点は入らない（小さな地震なら近くの数点だけ）。
  it('予測が −1.5 に届かない観測点は入れない', () => {
    const small = candidateCodes(epochs, { kind: 'hypocenter', ...MIYAGI, depthKm: 40, magnitude: 3.0, assumed: false }, null)
    const big = candidateCodes(epochs, { kind: 'hypocenter', ...MIYAGI, depthKm: 40, magnitude: 6.5, assumed: false }, null)
    expect(small.length).toBeLessThan(big.length)
    expect(small).not.toContain('YOJ')
  })

  // 安全弁: 深さだけ不明なら浅い（0 km）とみなす（§0）。揺れ検知へは落とさない。
  it('深さ不明は 0 km と同じ', () => {
    const unknown = candidateCodes(epochs, { kind: 'hypocenter', ...MIYAGI, depthKm: null, magnitude: 5.0, assumed: false }, { lat: 26, lon: 127.7 })
    const shallow = candidateCodes(epochs, { kind: 'hypocenter', ...MIYAGI, depthKm: 0, magnitude: 5.0, assumed: false }, null)
    expect(unknown).toEqual(shallow)
  })
})

describe('candidateCodes（震源の要素が欠けるとき・揺れ検知だけのとき）', () => {
  const OKINAWA = { lat: 26.6, lon: 128.0 }

  // 正: 揺れ検知だけなら検知点から 150 km の中。
  it('揺れ検知だけなら検知点から 150 km の中', () => {
    const codes = candidateCodes(epochs, { kind: 'detection', ...OKINAWA }, null)
    expect(codes.length).toBeGreaterThan(0)
    for (const code of codes) {
      const e = epochs.find((x) => x.code === code)!
      expect(haversineKm(OKINAWA.lat, OKINAWA.lon, e.lat, e.lon)).toBeLessThanOrEqual(PUBLIC_STATION_DETECTION_RADIUS_KM)
    }
  })

  // 正: 仮定震源で揺れ検知があれば、検知点の選び方を使う（震源の予測は使わない）。
  it('仮定震源は揺れ検知の点で選ぶ', () => {
    const codes = candidateCodes(epochs, { kind: 'hypocenter', ...MIYAGI, depthKm: 10, magnitude: 7.0, assumed: true }, OKINAWA)
    expect(codes).toEqual(candidateCodes(epochs, { kind: 'detection', ...OKINAWA }, null))
  })

  // 対照: 規模不明で揺れ検知も無ければ、震央の近い順に決まった点数。
  it('規模不明・検知なしは震央の近い順に数点', () => {
    const codes = candidateCodes(epochs, { kind: 'hypocenter', ...MIYAGI, depthKm: 10, magnitude: null, assumed: false }, null)
    expect(codes).toHaveLength(PUBLIC_STATION_NEAREST_COUNT)
    expect(codes[0]).toBe('JMM')
  })
})

describe('selectPublicStations（番号と持ち越し）', () => {
  // 正: 番号は近い順に 1 から振る。
  it('近い順に 1 から番号を振る', () => {
    const { selected } = selectPublicStations({
      prev: EMPTY_PUBLIC_SELECTION,
      epochs,
      source: { kind: 'hypocenter', ...MIYAGI, depthKm: 40, magnitude: 6.5, assumed: false },
      detection: null,
    })
    expect(selected[0]).toMatchObject({ number: 1, epoch: { code: 'JMM' } })
    expect(selected.map((s) => s.number)).toEqual(selected.map((_, i) => i + 1))
  })

  // 安全弁: 選び直しても一度振った番号は変えず、外れた観測点も残す。新しく入った観測点は続きの番号。
  it('選び直しても番号を変えず、外れた観測点も残す', () => {
    const first = selectPublicStations({
      prev: EMPTY_PUBLIC_SELECTION,
      epochs,
      source: { kind: 'detection', lat: 38.0, lon: 140.7 },
      detection: null,
    })
    const second = selectPublicStations({
      prev: first.state,
      epochs,
      source: { kind: 'detection', lat: 26.6, lon: 128.0 },
      detection: null,
    })
    for (const s of first.selected) expect(second.state.numbers.get(s.epoch.code)).toBe(s.number)
    const added = second.selected.filter((s) => !first.state.numbers.has(s.epoch.code))
    expect(added.length).toBeGreaterThan(0)
    expect(Math.min(...added.map((s) => s.number))).toBe(first.selected.length + 1)
  })

  // 対照: いまの時刻で運用していない観測点は出さない（番号は記憶に残る）。
  it('運用していない観測点は出さない', () => {
    const prev = { numbers: new Map([['ASAJ', 1]]) }
    const { selected, state } = selectPublicStations({ prev, epochs, source: { kind: 'detection', lat: 0, lon: 0 }, detection: null })
    expect(selected).toEqual([])
    expect(state.numbers.get('ASAJ')).toBe(1)
  })
})
