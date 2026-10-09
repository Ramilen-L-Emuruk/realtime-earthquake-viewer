import { describe, expect, it, vi } from 'vitest'

import {
  EMPTY_STATION_CONFIG,
  IDENTITY_MATRIX,
  StationDirectory,
  defaultSensorCalibration,
  parseStationConfig,
  stationsWithMultipleBoards,
} from './stationConfig'
import type { StationConfig } from './stationConfig'

const UNIT_AXES = [
  { vector: [1, 0, 0], offset: 0 },
  { vector: [0, 1, 0], offset: 0 },
  { vector: [0, 0, 1], offset: 0 },
]

/** 有効な最小構成。**書斎に基板 1 枚・センサー 1 個。** */
function validRaw(): Record<string, unknown> {
  return {
    stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
    boards: [
      {
        boardKey: 'mac:020000000003',
        stationId: 'study',
        orientation: IDENTITY_MATRIX,
        sensors: [
          {
            sensorId: 'i2c0-68',
            enabled: true,
            axes: UNIT_AXES,
            noiseDensity: 400,
          },
        ],
      },
    ],
  }
}

function sensorsOf(raw: Record<string, unknown>): Record<string, unknown>[] {
  return (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
}

function boardOf(raw: Record<string, unknown>): Record<string, unknown> {
  return (raw.boards as Record<string, unknown>[])[0]
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
    expect(result.config.boards[0].boardKey).toBe('mac:020000000003')
    expect(result.config.boards[0].orientation).toEqual(IDENTITY_MATRIX)
    expect(result.config.boards[0].sensors[0]).toEqual({
      sensorId: 'i2c0-68',
      enabled: true,
      axes: UNIT_AXES,
      noiseDensity: 400,
    })
  })

  it('正: 2 軸のセンサー（立てて付けた IIS2ICLX など）を読める', () => {
    const raw = validRaw()
    sensorsOf(raw)[0].axes = [
      { vector: [1, 0, 0], offset: 3 },
      { vector: [0, 0, 1.02], offset: -5 },
    ]
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards[0].sensors[0].axes).toHaveLength(2)
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

  it('正: axes を省略すると補正なしの 3 軸になる', () => {
    const raw = validRaw()
    delete sensorsOf(raw)[0].axes
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards[0].sensors[0].axes).toEqual(UNIT_AXES)
  })

  it('正: 軸のゼロ点を省略すると 0 になる', () => {
    const raw = validRaw()
    sensorsOf(raw)[0].axes = [{ vector: [1, 0, 0] }, { vector: [0, 1, 0] }, { vector: [0, 0, 1] }]
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards[0].sensors[0].axes.map((a) => a.offset)).toEqual([0, 0, 0])
  })

  it('正: 基板の向きを省略すると単位行列になる', () => {
    const raw = validRaw()
    delete boardOf(raw).orientation
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards[0].orientation).toEqual(IDENTITY_MATRIX)
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

  it('対照: XML に書けない文字（制御文字）を含む stationId・displayName は弾く', () => {
    // `/api/stations/:stationId` は URL から来るので、`%01` が JSON の段で弾かれずに届く。
    expect(
      parseStationConfig({
        stations: [{ stationId: 'st\u0001', displayName: '書斎', lat: 35.6, lon: 139.7 }],
        boards: [],
      }),
    ).toEqual({
      ok: false,
      failure: { reason: 'station-field-invalid', index: 0, field: 'stationId', value: 'st\u0001' },
    })
    expect(
      parseStationConfig({
        stations: [{ stationId: 'study', displayName: '書\uD800斎', lat: 35.6, lon: 139.7 }],
        boards: [],
      }),
    ).toMatchObject({ ok: false, failure: { reason: 'station-field-invalid', field: 'displayName' } })
  })

  it('安全弁: 改行や絵文字を含む表示名は受け付ける（XML に書ける文字）', () => {
    const result = parseStationConfig({
      stations: [{ stationId: 'study', displayName: '書斎\n🏠', lat: 35.6, lon: 139.7 }],
      boards: [],
    })
    expect(result.ok).toBe(true)
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
      boardKey: 'mac:020000000003',
      stationId: 'study',
      sensors: [],
    })
    const result = parseStationConfig(raw)
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'duplicate-board-key', boardKey: 'mac:020000000003' },
    })
  })

  it('MAC を名乗らない基板（版 1）は観測点へ割り当てられない（miniSEED・StationXML で名乗れない）', () => {
    const result = parseStationConfig({
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [{ boardKey: 'name:seismo-3', stationId: 'study', sensors: [] }],
    })
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'board-field-invalid', index: 0, field: 'boardKey', value: 'name:seismo-3' },
    })
  })

  it('MAC の下位 8 桁が同じ基板は、鍵が違っても重複として弾く（局コードがぶつかる）', () => {
    const raw = validRaw()
    ;(raw.boards as Record<string, unknown>[]).push({ boardKey: 'mac:ffff00000003', stationId: 'study', sensors: [] })
    const result = parseStationConfig(raw)
    expect(result).toEqual({ ok: false, failure: { reason: 'duplicate-board-key', boardKey: 'mac:ffff00000003' } })
  })

  it('ロケーションコードを作れないセンサー ID は弾く（記号・9 文字以上・「--」）', () => {
    for (const sensorId of ['i2c0_68', 'i2c0-68-x', '--']) {
      const raw = validRaw()
      const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
      sensors[0] = { ...sensors[0], sensorId }
      const result = parseStationConfig(raw)
      expect(result).toEqual({
        ok: false,
        failure: { reason: 'sensor-field-invalid', boardIndex: 0, sensorIndex: 0, field: 'sensorId', value: sensorId },
      })
    }
  })

  it('大文字小文字だけが違うセンサー ID は重複として弾く（ロケーションコードは大文字）', () => {
    const raw = validRaw()
    const sensors = (raw.boards as Record<string, unknown>[])[0].sensors as Record<string, unknown>[]
    sensors.push({ ...sensors[0], sensorId: 'I2C0-68' })
    const result = parseStationConfig(raw)
    expect(result).toEqual({ ok: false, failure: { reason: 'duplicate-sensor-id', boardIndex: 0, sensorId: 'I2C0-68' } })
  })

  it('対照: 基板が存在しない観測点を指すと弾く（参照整合性）', () => {
    const result = parseStationConfig({
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [{ boardKey: 'mac:aabbccddeeff', stationId: 'living', orientation: IDENTITY_MATRIX, sensors: [] }],
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
    ['配列でない', 'not-axes'],
    ['1 本だけ', [{ vector: [1, 0, 0], offset: 0 }]],
    ['4 本ある', [...UNIT_AXES, { vector: [1, 1, 1], offset: 0 }]],
    ['向きが 2 要素', [{ vector: [1, 0], offset: 0 }, ...UNIT_AXES.slice(1)]],
    ['向きに NaN', [{ vector: [1, 0, Number.NaN], offset: 0 }, ...UNIT_AXES.slice(1)]],
    ['ゼロ点が数でない', [{ vector: [1, 0, 0], offset: '0' }, ...UNIT_AXES.slice(1)]],
    ['ゼロ点が NaN', [{ vector: [1, 0, 0], offset: Number.NaN }, ...UNIT_AXES.slice(1)]],
  ])('対照: axes の形が読めなければ弾く（%s）', (_, value) => {
    const raw = validRaw()
    sensorsOf(raw)[0].axes = value
    expect(parseStationConfig(raw)).toEqual({
      ok: false,
      failure: { reason: 'sensor-field-invalid', boardIndex: 0, sensorIndex: 0, field: 'axes', value },
    })
  })

  it.each([
    ['向きの長さが 0', [{ vector: [0, 0, 0], offset: 0 }, ...UNIT_AXES.slice(1)]],
    ['3 本が 1 つの面に寄っている', [{ vector: [1, 0, 0], offset: 0 }, { vector: [0, 1, 0], offset: 0 }, { vector: [1, 1, 0], offset: 0 }]],
    ['3 本がほぼ 1 つの面（アダマール比 1e-7）', [{ vector: [1, 0, 0], offset: 0 }, { vector: [0, 1, 0], offset: 0 }, { vector: [0, 1, 1e-7], offset: 0 }]],
    ['2 本が平行', [{ vector: [1, 0, 0], offset: 0 }, { vector: [-2, 0, 0], offset: 0 }]],
  ])('正: 解けない測る向きは弾く（%s）', (_, value) => {
    // その向きの揺れを消す値で、設定の履歴（StationXML）も地面での向きを書けない。
    const raw = validRaw()
    sensorsOf(raw)[0].axes = value
    expect(parseStationConfig(raw)).toEqual({
      ok: false,
      failure: { reason: 'sensor-field-invalid', boardIndex: 0, sensorIndex: 0, field: 'axes', value },
    })
  })

  it.each([
    ['直交でない（軸どうしの直角のずれを直す）', [[1.2, 0.1, 0], [0.05, 0.9, 0.2], [0, -0.3, 1.1]]],
    ['倍率を含む（長さが 1 でない）', [[3, 0, 0], [0, 0.01, 0], [0, 0, 7]]],
  ])('対照: 解ける向きなら直交でなくても通す（%s）', (_, vectors) => {
    const raw = validRaw()
    sensorsOf(raw)[0].axes = vectors.map((vector) => ({ vector, offset: 0 }))
    expect(parseStationConfig(raw).ok).toBe(true)
  })

  it.each([
    ['3x3 でない', [[1, 0], [0, 1, 0], [0, 0, 1]]],
    ['倍率を含む', [[2, 0, 0], [0, 1, 0], [0, 0, 1]]],
    ['せん断を含む', [[1, 0.1, 0], [0, 1, 0], [0, 0, 1]]],
    ['鏡映（行列式が負）', [[-1, 0, 0], [0, 1, 0], [0, 0, 1]]],
    ['NaN を含む', [[1, 0, 0], [0, Number.NaN, 0], [0, 0, 1]]],
  ])('対照: 基板の向きが純粋な回転でなければ弾く（%s）', (_, value) => {
    // 軸の倍率・直角のずれは各軸の向きが持つ。基板の向きで受けると同じ事実を 2 か所で書ける。
    const raw = validRaw()
    boardOf(raw).orientation = value
    expect(parseStationConfig(raw)).toEqual({
      ok: false,
      failure: { reason: 'board-field-invalid', index: 0, field: 'orientation', value },
    })
  })

  it('安全弁: 小数 6 桁へ丸めた回転（管理コンソールの提案）は通す', () => {
    const raw = validRaw()
    boardOf(raw).orientation = [
      [0.999844, -0.000312, 0.017659],
      [-0.000312, 0.999688, 0.024984],
      [-0.017659, -0.024984, 0.999532],
    ]
    expect(parseStationConfig(raw).ok).toBe(true)
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
    ;(raw.boards as Record<string, unknown>[])[0].boardKey = 'mac:020000000003'
    const result = parseStationConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.boards[0].boardKey).toBe('mac:020000000003')
  })
})

describe('StationDirectory', () => {
  it('正: 設定にある boardKey を解決すると観測点（座標込み）が返る', () => {
    const parsed = parseStationConfig(validRaw())
    if (!parsed.ok) throw new Error('setup failed')
    const dir = new StationDirectory(parsed.config)
    expect(dir.resolve('mac:020000000003')).toEqual({
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
    expect(dir.resolveSensor('mac:020000000003', 'i2c0-68', 3)).toEqual({
      ok: true,
      calibration: {
        enabled: true,
        noiseDensity: 400,
        axes: UNIT_AXES,
        unmix: IDENTITY_MATRIX,
      },
    })
  })

  /** 補正なしの 3 軸・単位行列の基板を解いた形。 */
  const DEFAULT_RESOLVED = { ok: true, calibration: { enabled: true, noiseDensity: null, axes: UNIT_AXES, unmix: IDENTITY_MATRIX } }

  it('対照: 設定に無いセンサーは補正なしの校正値を返す（設定は任意という性質を維持）', () => {
    const dir = new StationDirectory(EMPTY_STATION_CONFIG)
    expect(dir.resolveSensor('mac:aa', 's0', 3)).toEqual(DEFAULT_RESOLVED)
    expect(dir.isSensorEnabled('mac:aa', 's0')).toBe(true)
  })

  it('対照: 基板は設定にあるがセンサーは設定に無ければ既定値を返す', () => {
    const parsed = parseStationConfig(validRaw())
    if (!parsed.ok) throw new Error('setup failed')
    const dir = new StationDirectory(parsed.config)
    expect(dir.resolveSensor('mac:020000000003', 'i2c1-69', 3)).toEqual(DEFAULT_RESOLVED)
  })

  it('空の帳面はどの boardKey・センサーも未割当／既定値を返す', () => {
    const dir = StationDirectory.empty()
    expect(dir.resolve('mac:aa')).toBeNull()
    expect(dir.resolveSensor('mac:aa', 's0', 3)).toEqual(DEFAULT_RESOLVED)
  })

  it('正: 設定に無い 2 軸のセンサーは、補正なしの 2 軸を返す（3 成分へは解かない）', () => {
    const dir = StationDirectory.empty()
    expect(dir.resolveSensor('mac:aa', 's0', 2)).toEqual({
      ok: true,
      calibration: { enabled: true, noiseDensity: null, axes: UNIT_AXES.slice(0, 2), unmix: null },
    })
  })

  it('安全弁: 設定の軸の本数と問い合わせの本数が違えば失敗を返す（どちらの本数で読んでも軸を取り違える）', () => {
    const parsed = parseStationConfig(validRaw())
    if (!parsed.ok) throw new Error('setup failed')
    const dir = new StationDirectory(parsed.config)
    expect(dir.resolveSensor('mac:020000000003', 'i2c0-68', 2)).toEqual({
      ok: false,
      reason: 'axis-count-mismatch',
      configuredAxes: 3,
    })
    // 使うかどうかは本数と別に答える。
    expect(dir.isSensorEnabled('mac:020000000003', 'i2c0-68')).toBe(true)
  })

  it('正: 基板の向きは、その基板の設定に無いセンサーにも掛かる', () => {
    const raw = validRaw()
    boardOf(raw).orientation = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]
    const parsed = parseStationConfig(raw)
    if (!parsed.ok) throw new Error('setup failed')
    const got = new StationDirectory(parsed.config).resolveSensor('mac:020000000003', 'i2c1-69', 3)
    if (!got.ok) throw new Error('解けない')
    // 基板の X が北を向くので、軸 1（基板の X）の地面での向きは北。
    expect(got.calibration.axes[0]!.vector).toEqual([0, 1, 0])
  })

  it('正: hasSensorCalibration は設定にあるセンサーで true を返す（resolveSensor だけでは「設定と一致したか」を見分けられない）', () => {
    const parsed = parseStationConfig(validRaw())
    if (!parsed.ok) throw new Error('setup failed')
    const dir = new StationDirectory(parsed.config)
    expect(dir.hasSensorCalibration('mac:020000000003', 'i2c0-68')).toBe(true)
  })

  it('対照: hasSensorCalibration は設定に無いセンサーで false を返す（既定値へ倒れていても「設定済み」とは言わない）', () => {
    const parsed = parseStationConfig(validRaw())
    if (!parsed.ok) throw new Error('setup failed')
    const dir = new StationDirectory(parsed.config)
    expect(dir.hasSensorCalibration('mac:020000000003', 'i2c1-69')).toBe(false)
    expect(dir.hasSensorCalibration('mac:aa', 's0')).toBe(false)
  })

  it('安全弁: parseStationConfig を経由しない生成経路で参照整合性が壊れていても、例外を投げず未割当にする（警告は出す）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dir = new StationDirectory({
        stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
        boards: [{ boardKey: 'mac:aabbccddeeff', stationId: 'living', orientation: IDENTITY_MATRIX, sensors: [] }],
      })
      expect(dir.resolve('mac:aabbccddeeff')).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('living')
    } finally {
      warn.mockRestore()
    }
  })

  // **状態の口と震度の口が同じ答えを返すこと。** 前は解けない校正値で `isSensorEnabled` だけが
  // 「有効」と答え続け、状態の口では健全なのに震度が 1 つも出なかった（敵対的レビューで検出）。
  it('安全弁: parseStationConfig を経由せず解けない軸が渡っても、そのセンサーは無効と答え、震度の材料を返さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dir = new StationDirectory({
        stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
        boards: [
          {
            boardKey: 'mac:aabbccddeeff',
            stationId: 'study',
            orientation: IDENTITY_MATRIX,
            sensors: [
              {
                sensorId: 's0',
                enabled: true,
                noiseDensity: null,
                axes: [
                  { vector: [1, 0, 0], offset: 0 },
                  { vector: [0, 1, 0], offset: 0 },
                  { vector: [1, 1, 0], offset: 0 },
                ],
              },
            ],
          },
        ],
      })
      expect(dir.isSensorEnabled('mac:aabbccddeeff', 's0')).toBe(false)
      const got = dir.resolveSensor('mac:aabbccddeeff', 's0', 3)
      expect(got.ok && got.calibration.enabled).toBe(false)
      expect(got.ok && got.calibration.unmix).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('対照: 設定に無いセンサーの既定値は、設定にあるセンサーとして数えない', () => {
    const parsed = parseStationConfig(validRaw())
    if (!parsed.ok) throw new Error('setup failed')
    const dir = new StationDirectory(parsed.config)
    expect(dir.resolveSensor('mac:020000000003', 'i2c1-69', 3).ok).toBe(true)
    expect(dir.hasSensorCalibration('mac:020000000003', 'i2c1-69')).toBe(false)
    expect(dir.isSensorEnabled('mac:020000000003', 'i2c1-69')).toBe(true)
  })
})

describe('stationsWithMultipleBoards', () => {
  const CAL = defaultSensorCalibration(3)

  it('正: 同一観測点へ 2 台以上の基板を割り当てていれば拾う（sensors[] が空でも）', () => {
    const config: StationConfig = {
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [
        { boardKey: 'mac:aaaaaaaaaaaa', stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] },
        { boardKey: 'mac:bbbbbbbbbbbb', stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [{ sensorId: 's', ...CAL }] },
      ],
    }
    expect(stationsWithMultipleBoards(config)).toEqual(['study'])
  })

  it('対照: 1 台しか割り当てていない観測点は拾わない', () => {
    const config: StationConfig = {
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [{ boardKey: 'mac:aaaaaaaaaaaa', stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [{ sensorId: 's', ...CAL }] }],
    }
    expect(stationsWithMultipleBoards(config)).toEqual([])
  })

  it('安全弁: 観測点が複数あっても、それぞれ独立に判定する', () => {
    const config: StationConfig = {
      stations: [
        { stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 },
        { stationId: 'garage', displayName: '車庫', lat: 35.7, lon: 139.8 },
      ],
      boards: [
        { boardKey: 'mac:aaaaaaaaaaaa', stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] },
        { boardKey: 'mac:bbbbbbbbbbbb', stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] },
        { boardKey: 'mac:cccccccccccc', stationId: 'garage', orientation: IDENTITY_MATRIX, sensors: [] },
      ],
    }
    expect(stationsWithMultipleBoards(config)).toEqual(['study'])
  })
})
