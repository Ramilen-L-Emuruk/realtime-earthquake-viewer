import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SENSOR_CALIBRATION,
  EMPTY_STATION_CONFIG,
  StationDirectory,
  loadStationConfig,
  parseStationConfig,
} from './stationConfig'

/** 有効な最小構成。**書斎に基板 1 枚・センサー 1 個。** */
function validRaw(): Record<string, unknown> {
  return {
    stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
    boards: [
      {
        boardKey: 'mac:3c8a1f5d54d8',
        stationId: 'study',
        sensors: [
          {
            sensorId: 'i2c0-68',
            enabled: true,
            rotation: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
            offset: [0, 0, 0],
            sensitivity: [1, 1, 1],
            noiseDensity: 400,
          },
        ],
      },
    ],
  }
}

describe('parseStationConfig', () => {
  it('正: 観測点・基板・センサーが揃った設定を読める', () => {
    const result = parseStationConfig(validRaw())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.stations).toEqual([
      { stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 },
    ])
    expect(result.config.boards).toHaveLength(1)
    expect(result.config.boards[0].boardKey).toBe('mac:3c8a1f5d54d8')
    expect(result.config.boards[0].sensors[0]).toEqual({
      sensorId: 'i2c0-68',
      enabled: true,
      rotation: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      offset: [0, 0, 0],
      sensitivity: [1, 1, 1],
      noiseDensity: 400,
    })
  })

  it('正: noiseDensity は省略できる（null になる）', () => {
    const raw = validRaw()
    // eslint 的には never だが、テスト用の生データなので型を無視して触る
    const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
    delete sensors[0].noiseDensity
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards[0].sensors[0].noiseDensity).toBeNull()
  })

  it('正: enabled は省略できる（true になる）', () => {
    const raw = validRaw()
    const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
    delete sensors[0].enabled
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards[0].sensors[0].enabled).toBe(true)
  })

  it('正: rotation を省略すると単位行列になる', () => {
    const raw = validRaw()
    const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
    delete sensors[0].rotation
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards[0].sensors[0].rotation).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
  })

  it('正: offset を省略するとゼロになる', () => {
    const raw = validRaw()
    const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
    delete sensors[0].offset
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards[0].sensors[0].offset).toEqual([0, 0, 0])
  })

  it('正: sensitivity を省略すると単位倍率になる', () => {
    const raw = validRaw()
    const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
    delete sensors[0].sensitivity
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards[0].sensors[0].sensitivity).toEqual([1, 1, 1])
  })

  it('対照: enabled が真偽値でない（文字列 "false" 等）と弾く（`??` は truthy/falsy ではなく null/undefined だけを既定値へ倒す）', () => {
    const raw = validRaw()
    const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
    sensors[0].enabled = 'false'
    const result = parseStationConfig(raw)
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'sensor-field-invalid',
        boardIndex: 0,
        sensorIndex: 0,
        field: 'enabled',
        value: 'false',
      },
    })
  })

  it('安全弁: 同じ観測点へ複数の基板を割り当てられる（複数台の統合を妨げない）', () => {
    const raw = validRaw()
    ;(raw.boards as unknown[]).push({
      boardKey: 'mac:aaaaaaaaaaaa',
      stationId: 'study',
      sensors: [],
    })
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards).toHaveLength(2)
  })

  it('安全弁: sensors は空配列でもよい（基板だけ先に登録できる）', () => {
    const raw = validRaw()
    ;(raw.boards as Record<string, unknown>[])[0].sensors = []
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
  })

  it('対照: stations が無いと弾く', () => {
    const result = parseStationConfig({ boards: [] })
    expect(result).toEqual({ ok: false, failure: { reason: 'stations-not-array' } })
  })

  it('対照: boards が無いと弾く', () => {
    const result = parseStationConfig({ stations: [] })
    expect(result).toEqual({ ok: false, failure: { reason: 'boards-not-array' } })
  })

  it('対照: 中身がオブジェクトでないと弾く', () => {
    expect(parseStationConfig('not-an-object')).toEqual({
      ok: false,
      failure: { reason: 'not-an-object' },
    })
  })

  it('対照: 観測点のエントリがオブジェクトでないと弾く', () => {
    const result = parseStationConfig({ stations: ['x'], boards: [] })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'station-not-an-object', index: 0 },
    })
  })

  it('対照: 観測点の stationId が空だと弾く', () => {
    const result = parseStationConfig({
      stations: [{ stationId: '  ', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [],
    })
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'station-field-invalid',
        index: 0,
        field: 'stationId',
        value: '  ',
      },
    })
  })

  it('対照: 観測点の displayName が欠けていると弾く', () => {
    const result = parseStationConfig({
      stations: [{ stationId: 'study', lat: 35.6, lon: 139.7 }],
      boards: [],
    })
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'station-field-invalid',
        index: 0,
        field: 'displayName',
        value: undefined,
      },
    })
  })

  it.each([
    ['lat', 91, 'lat'],
    ['lat', Number.NaN, 'lat'],
    ['lon', 181, 'lon'],
    ['lon', -Infinity, 'lon'],
  ])('対照: 観測点の %s が範囲外・非数だと弾く（値=%s）', (field, value) => {
    const result = parseStationConfig({
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7, [field]: value }],
      boards: [],
    })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'station-field-invalid', index: 0, field, value },
    })
  })

  it('安全弁: lat/lon は境界値（±90/±180）を通す', () => {
    const result = parseStationConfig({
      stations: [{ stationId: 'a', displayName: 'A', lat: 90, lon: 180 }],
      boards: [],
    })
    expect(result.ok).toBe(true)
  })

  it('対照: 同じ stationId が 2 度現れると弾く', () => {
    const result = parseStationConfig({
      stations: [
        { stationId: 'study', displayName: '書斎（旧）', lat: 35.6, lon: 139.7 },
        { stationId: 'study', displayName: '書斎（新）', lat: 35.7, lon: 139.8 },
      ],
      boards: [],
    })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'duplicate-station-id', stationId: 'study' },
    })
  })

  it('対照: 基板のエントリがオブジェクトでないと弾く', () => {
    const result = parseStationConfig({ stations: [], boards: ['x'] })
    expect(result).toEqual({ ok: false, failure: { reason: 'board-not-an-object', index: 0 } })
  })

  it('対照: 基板の boardKey が不正だと弾く', () => {
    const result = parseStationConfig({
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [{ boardKey: 'study', stationId: 'study', sensors: [] }],
    })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'board-field-invalid', index: 0, field: 'boardKey', value: 'study' },
    })
  })

  it('対照: 同じ boardKey が 2 度現れると弾く', () => {
    const raw = validRaw()
    ;(raw.boards as Record<string, unknown>[]).push({
      boardKey: 'mac:3c8a1f5d54d8',
      stationId: 'study',
      sensors: [],
    })
    const result = parseStationConfig(raw)
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'duplicate-board-key', boardKey: 'mac:3c8a1f5d54d8' },
    })
  })

  it('対照: 基板が存在しない観測点を指すと弾く（参照整合性）', () => {
    const result = parseStationConfig({
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [{ boardKey: 'mac:aabbccddeeff', stationId: 'living', sensors: [] }],
    })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'unknown-station-id', boardIndex: 0, stationId: 'living' },
    })
  })

  it('対照: sensors が配列でないと弾く', () => {
    const raw = validRaw()
    ;(raw.boards as Record<string, unknown>[])[0].sensors = 'x'
    const result = parseStationConfig(raw)
    expect(result).toEqual({ ok: false, failure: { reason: 'sensors-not-array', boardIndex: 0 } })
  })

  it('対照: センサーのエントリがオブジェクトでないと弾く', () => {
    const raw = validRaw()
    ;(raw.boards as Record<string, unknown>[])[0].sensors = ['x']
    const result = parseStationConfig(raw)
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'sensor-not-an-object', boardIndex: 0, sensorIndex: 0 },
    })
  })

  it('対照: 同じ基板の中で sensorId が重複すると弾く', () => {
    const raw = validRaw()
    const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
    sensors.push({ ...sensors[0] })
    const result = parseStationConfig(raw)
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'duplicate-sensor-id', boardIndex: 0, sensorId: 'i2c0-68' },
    })
  })

  it('安全弁: 別の基板なら同じ sensorId を使い回せる（配線の都合で名前が揃うのは自然）', () => {
    const raw = validRaw()
    ;(raw.boards as Record<string, unknown>[]).push({
      boardKey: 'mac:aaaaaaaaaaaa',
      stationId: 'study',
      sensors: [{ sensorId: 'i2c0-68', enabled: true }],
    })
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
  })

  it.each([
    ['rotation', [[1, 0], [0, 1, 0], [0, 0, 1]]],
    ['rotation', [[1, 0, Number.NaN], [0, 1, 0], [0, 0, 1]]],
    ['rotation', 'not-a-matrix'],
  ])('対照: %s が 3x3 の有限数でなければ弾く', (field, value) => {
    const raw = validRaw()
    const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
    sensors[0][field] = value
    const result = parseStationConfig(raw)
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'sensor-field-invalid',
        boardIndex: 0,
        sensorIndex: 0,
        field,
        value,
      },
    })
  })

  it.each([
    ['offset', [0, 0]],
    ['offset', [0, 0, Number.NaN]],
    ['sensitivity', [1, 1]],
    ['sensitivity', [1, 0, 1]],
    ['sensitivity', [1, -1, 1]],
  ])('対照: %s が 3 要素の有限数（sensitivity は正）でなければ弾く', (field, value) => {
    const raw = validRaw()
    const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
    sensors[0][field] = value
    const result = parseStationConfig(raw)
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'sensor-field-invalid',
        boardIndex: 0,
        sensorIndex: 0,
        field,
        value,
      },
    })
  })

  it('対照: noiseDensity が 0 以下だと弾く', () => {
    const raw = validRaw()
    const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
    sensors[0].noiseDensity = 0
    const result = parseStationConfig(raw)
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'sensor-field-invalid',
        boardIndex: 0,
        sensorIndex: 0,
        field: 'noiseDensity',
        value: 0,
      },
    })
  })

  it('正: mac: は大文字が混じっていても小文字へ正規化する（従来どおり）', () => {
    const raw = validRaw()
    ;(raw.boards as Record<string, unknown>[])[0].boardKey = 'mac:3C8A1F5D54D8'
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards[0].boardKey).toBe('mac:3c8a1f5d54d8')
  })
})

describe('StationDirectory', () => {
  it('正: 設定にある boardKey を解決すると観測点（座標込み）が返る', () => {
    const parsed = parseStationConfig(validRaw())
    if (!parsed.ok) throw new Error('setup failed')
    const dir = new StationDirectory(parsed.config)
    expect(dir.resolve('mac:3c8a1f5d54d8')).toEqual({
      stationId: 'study',
      displayName: '書斎',
      lat: 35.6,
      lon: 139.7,
    })
  })

  it('対照: 設定に無い boardKey は未割当（null）', () => {
    const dir = new StationDirectory(EMPTY_STATION_CONFIG)
    expect(dir.resolve('mac:aa')).toBeNull()
  })

  it('正: 設定にあるセンサーの校正値を解決する', () => {
    const parsed = parseStationConfig(validRaw())
    if (!parsed.ok) throw new Error('setup failed')
    const dir = new StationDirectory(parsed.config)
    expect(dir.resolveSensor('mac:3c8a1f5d54d8', 'i2c0-68')).toEqual({
      enabled: true,
      rotation: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      offset: [0, 0, 0],
      sensitivity: [1, 1, 1],
      noiseDensity: 400,
    })
  })

  it('対照: 設定に無いセンサーは既定の校正値（単位回転・補正なし）を返す（設定は任意という性質を維持）', () => {
    const dir = new StationDirectory(EMPTY_STATION_CONFIG)
    expect(dir.resolveSensor('mac:aa', 's0')).toEqual(DEFAULT_SENSOR_CALIBRATION)
  })

  it('対照: 基板は設定にあるがセンサーは設定に無ければ既定値を返す', () => {
    const parsed = parseStationConfig(validRaw())
    if (!parsed.ok) throw new Error('setup failed')
    const dir = new StationDirectory(parsed.config)
    expect(dir.resolveSensor('mac:3c8a1f5d54d8', 'i2c1-69')).toEqual(DEFAULT_SENSOR_CALIBRATION)
  })

  it('空の帳面はどの boardKey・センサーも未割当／既定値を返す', () => {
    const dir = StationDirectory.empty()
    expect(dir.resolve('mac:aa')).toBeNull()
    expect(dir.resolveSensor('mac:aa', 's0')).toEqual(DEFAULT_SENSOR_CALIBRATION)
  })

  it('正: hasSensorCalibration は設定にあるセンサーで true を返す（resolveSensor だけでは「設定と一致したか」を見分けられない）', () => {
    const parsed = parseStationConfig(validRaw())
    if (!parsed.ok) throw new Error('setup failed')
    const dir = new StationDirectory(parsed.config)
    expect(dir.hasSensorCalibration('mac:3c8a1f5d54d8', 'i2c0-68')).toBe(true)
  })

  it('対照: hasSensorCalibration は設定に無いセンサーで false を返す（既定値へ倒れていても「設定済み」とは言わない）', () => {
    const parsed = parseStationConfig(validRaw())
    if (!parsed.ok) throw new Error('setup failed')
    const dir = new StationDirectory(parsed.config)
    expect(dir.hasSensorCalibration('mac:3c8a1f5d54d8', 'i2c1-69')).toBe(false)
    expect(dir.hasSensorCalibration('mac:aa', 's0')).toBe(false)
  })

  it('安全弁: parseStationConfig を経由しない生成経路で参照整合性が壊れていても、例外を投げず未割当にする（警告は出す）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dir = new StationDirectory({
        stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
        boards: [{ boardKey: 'mac:aabbccddeeff', stationId: 'living', sensors: [] }],
      })
      expect(dir.resolve('mac:aabbccddeeff')).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('living')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('loadStationConfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seismo-station-config-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('対照: ファイルが無ければ空の設定・警告なし（割り当ては任意）', () => {
    const result = loadStationConfig(join(dir, 'stations.json'))
    expect(result).toEqual({ config: EMPTY_STATION_CONFIG, warning: null })
  })

  it('正: 書いたとおりに読める', () => {
    const path = join(dir, 'stations.json')
    writeFileSync(path, JSON.stringify(validRaw()))
    const result = loadStationConfig(path)
    expect(result.warning).toBeNull()
    expect(result.config.boards).toHaveLength(1)
  })

  it('対照: JSON として読めなければ空の設定へ倒し、理由を warning へ出す', () => {
    const path = join(dir, 'stations.json')
    writeFileSync(path, '{not valid json')
    const result = loadStationConfig(path)
    expect(result.config).toEqual(EMPTY_STATION_CONFIG)
    expect(result.warning).not.toBeNull()
  })

  it('対照: 書式が崩れていれば空の設定へ倒し、理由を warning へ出す（実際に書いた不正な値も添える）', () => {
    const path = join(dir, 'stations.json')
    writeFileSync(path, JSON.stringify({ stations: [{ stationId: 'a' }], boards: [] }))
    const result = loadStationConfig(path)
    expect(result.config).toEqual(EMPTY_STATION_CONFIG)
    expect(result.warning).toContain('displayName')
  })
})
