import { describe, expect, it } from 'vitest'
import {
  MAX_REMEMBERED_SENSORS,
  applyHiddenAxes,
  readRangeSelection,
  readRecordsPrefs,
  readShakesPrefs,
  readWavesPrefs,
  rememberHiddenAxes,
  rememberSensorChoice,
  writeRecordsPrefs,
  writeShakesPrefs,
  writeWavesPrefs,
} from './viewPrefs'

const SPANS = [5_000, 30_000, 60_000]
const SCALES = ['auto', '1', '10']

describe('readWavesPrefs', () => {
  it('書いたものを読み戻せる', () => {
    const sensors = new Map([
      ['t:s1', false],
      ['b/s', true],
    ])
    const raw = JSON.parse(JSON.stringify(writeWavesPrefs({ spanMs: 60_000, scale: '10', sensors })))
    const read = readWavesPrefs(raw, SPANS, SCALES)
    expect(read.spanMs).toBe(60_000)
    expect(read.scale).toBe('10')
    expect([...read.sensors]).toEqual([...sensors])
  })

  it('選択肢に無い幅・縦の幅は既定へ倒す（ほかの項目は残す）', () => {
    const read = readWavesPrefs({ spanMs: 12_345, scale: '9999', sensors: [['k', true]] }, SPANS, SCALES)
    expect(read.spanMs).toBeNull()
    expect(read.scale).toBeNull()
    expect(read.sensors.get('k')).toBe(true)
  })

  it('形の違う項目は 1 件ずつ捨てる', () => {
    const read = readWavesPrefs({ sensors: [['ok', false], ['bad'], [1, true], 'x', ['also', 'yes']] }, SPANS, SCALES)
    expect([...read.sensors]).toEqual([['ok', false]])
  })

  it('null・配列・文字列など、オブジェクトでないものは全部既定', () => {
    for (const raw of [null, [], 'x', 3]) {
      const read = readWavesPrefs(raw, SPANS, SCALES)
      expect(read).toEqual({ spanMs: null, scale: null, sensors: new Map() })
    }
  })
})

describe('rememberSensorChoice', () => {
  it('付け直すと新しい側へ移り、上限を超えたら古いものから捨てる', () => {
    const sensors = new Map<string, boolean>()
    for (let i = 0; i < MAX_REMEMBERED_SENSORS; i++) rememberSensorChoice(sensors, `k${i}`, true)
    rememberSensorChoice(sensors, 'k0', false) // k0 を新しい側へ
    rememberSensorChoice(sensors, 'new', true) // 上限を超える → いちばん古い k1 が落ちる
    expect(sensors.size).toBe(MAX_REMEMBERED_SENSORS)
    expect(sensors.has('k1')).toBe(false)
    expect(sensors.get('k0')).toBe(false)
    expect([...sensors.keys()].at(-1)).toBe('new')
  })
})

describe('readShakesPrefs', () => {
  const DAYS = [1, 7, 30]

  it('日数の期間と日付の期間を読み戻せる', () => {
    const days = JSON.parse(JSON.stringify(writeShakesPrefs({ period: { kind: 'days', days: 30 }, hideLocal: true })))
    expect(readShakesPrefs(days, DAYS)).toEqual({ period: { kind: 'days', days: 30 }, hideLocal: true })
    const dates = { period: { kind: 'dates', fromMs: 1_000, toMs: 2_000 }, hideLocal: false }
    expect(readShakesPrefs(dates, DAYS)).toEqual(dates)
  })

  it('選択肢に無い日数・逆さの範囲は期間を既定へ倒す', () => {
    expect(readShakesPrefs({ period: { kind: 'days', days: 3 } }, DAYS).period).toBeNull()
    expect(readShakesPrefs({ period: { kind: 'dates', fromMs: 2_000, toMs: 1_000 } }, DAYS).period).toBeNull()
    expect(readShakesPrefs({ period: { kind: 'dates', fromMs: Number.NaN, toMs: 1_000 } }, DAYS).period).toBeNull()
  })

  it('隠す指定は true のときだけ立てる（文字列の "true" などは立てない）', () => {
    expect(readShakesPrefs({ hideLocal: 'true' }, DAYS).hideLocal).toBe(false)
    expect(readShakesPrefs(null, DAYS).hideLocal).toBe(false)
  })
})

describe('readRecordsPrefs / applyHiddenAxes', () => {
  it('単位と記録ごとの隠した軸を読み戻せる', () => {
    const hidden = new Map<string, readonly string[]>([['station/a', ['station/a/X']]])
    const raw = JSON.parse(JSON.stringify(writeRecordsPrefs({ unit: 'native', hidden })))
    const read = readRecordsPrefs(raw)
    expect(read.unit).toBe('native')
    expect(read.hidden.get('station/a')).toEqual(['station/a/X'])
  })

  it('知らない単位は gal', () => {
    expect(readRecordsPrefs({ unit: 'm/s2' }).unit).toBe('gal')
  })

  it('1 本も隠していない記録は覚えない', () => {
    const hidden = new Map<string, readonly string[]>([['g', ['x']]])
    rememberHiddenAxes(hidden, 'g', [])
    expect(hidden.has('g')).toBe(false)
  })

  it('いまの軸に無い id は捨てて当てる', () => {
    expect([...applyHiddenAxes(['a', 'gone'], ['a', 'b', 'c'])]).toEqual(['a'])
  })

  it('全部隠れてしまうなら全部出す（段が 1 つも無いと範囲の操作の手掛かりが無くなる）', () => {
    expect(applyHiddenAxes(['a', 'b'], ['a', 'b']).size).toBe(0)
  })

  it('覚えていなければ何も隠さない', () => {
    expect(applyHiddenAxes(undefined, ['a']).size).toBe(0)
  })
})

describe('readRangeSelection', () => {
  it('整数のミリ秒の組を読む', () => {
    expect(readRangeSelection('1000', '2000')).toEqual({ fromMs: 1000, toMs: 2000 })
  })

  it('片方が無い・数でない・逆さ・幅 0 は読めない', () => {
    expect(readRangeSelection(null, '2000')).toBeNull()
    expect(readRangeSelection('1e3', '2000')).toBeNull()
    expect(readRangeSelection('2000', '1000')).toBeNull()
    expect(readRangeSelection('1000', '1000')).toBeNull()
    expect(readRangeSelection('99999999999999999999', '1')).toBeNull()
  })
})
