import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { BoardKey } from '../protocol/types'
import { applyCalibration, legacyAxes, resolveCalibration } from './calibration'
import { invert3 } from './matrix3'
import { parseStationConfig } from './stationConfig'
import type { AxisCalibration, Mat3, SensorEntry, StationConfig, Vec3 } from './stationConfigTypes'
import { IDENTITY_MATRIX } from './stationConfigTypes'
import {
  applyStationConfig,
  configAt,
  currentConfig,
  EMPTY_STATION_HISTORY,
  readStationXml,
  type StationHistoryDoc,
  StationXmlError,
  writeStationXml,
} from './stationXml'

const T0 = Date.UTC(2026, 9, 3, 3, 40, 21, 698)
const T1 = T0 + 60_000
const T2 = T0 + 120_000
const T3 = T0 + 180_000

/**
 * 実機の設定の履歴から取った値（10-03 15:44 の i2c0-68）。純粋な回転からは少しずれている
 * （`RᵀR` の対角は 10⁻⁷、非対角は最大 1.8×10⁻⁴）。
 */
const REAL_ROTATION: Mat3 = [
  [0.999844, -0.000312, 0.017659],
  [-0.000312, 0.999688, 0.024984],
  [-0.017659, -0.024984, 0.999532],
]

const SHEAR: Mat3 = [
  [1.2, 0.1, 0],
  [0.05, 0.9, 0.2],
  [0, -0.3, 1.1],
]

/** Z 軸まわりに 30° 回した基板の向き。 */
const YAW30: Mat3 = (() => {
  const t = (30 * Math.PI) / 180
  return [
    [Math.cos(t), -Math.sin(t), 0],
    [Math.sin(t), Math.cos(t), 0],
    [0, 0, 1],
  ]
})()

const BOARD_A: BoardKey = 'mac:020000000003'
const BOARD_B: BoardKey = 'mac:020000000001'

/** 前の形の値（`R`・`s`・`o`）を写した軸。実機の 6 面法の値に近い。 */
function axesFrom(rotation: Mat3, sensitivity: Vec3 = [1.0064, 0.9987, 0.99363], offset: Vec3 = [18.55, 2.25, 235.5]): AxisCalibration[] {
  const axes = legacyAxes(rotation, sensitivity, offset)
  if (axes === null) throw new Error('写せない')
  return axes
}

function sensor(id: string, overrides: Partial<SensorEntry> = {}): SensorEntry {
  return { sensorId: id, enabled: true, axes: axesFrom(REAL_ROTATION), noiseDensity: null, ...overrides }
}

/** 立てて付けた 2 軸のセンサー（基板の X と Z を測る）。 */
function twoAxis(id: string): SensorEntry {
  return {
    sensorId: id,
    enabled: true,
    axes: [
      { vector: [1.0021, 0.0034, -0.0012], offset: 4.5 },
      { vector: [0.0008, -0.0017, 0.9968], offset: -12.25 },
    ],
    noiseDensity: 25,
  }
}

function config(sensors: SensorEntry[], lat = 35.6, boardKey: BoardKey = BOARD_A, orientation: Mat3 = IDENTITY_MATRIX): StationConfig {
  return {
    stations: [{ stationId: 'station-1', displayName: '書斎', lat, lon: 139.7 }],
    boards: [{ boardKey, stationId: 'station-1', orientation, sensors }],
  }
}

function roundTrip(doc: StationHistoryDoc): StationHistoryDoc {
  return readStationXml(writeStationXml(doc, T2))
}

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
}

/** StationXML の標準の読み方で、チャンネル j が測る `(ŵ_j · a)` を `m_j` から出す。 */
function standardReadings(xml: string): { j: number; u: Vec3; c0: number; c1: number }[] {
  return [...xml.matchAll(/<Channel code="HN(\d)"[\s\S]*?<\/Channel>/g)].map((ch) => {
    const body = ch[0]
    const az = (Number(/<Azimuth>([^<]+)</.exec(body)?.[1]) * Math.PI) / 180
    const dip = (Number(/<Dip>([^<]+)</.exec(body)?.[1]) * Math.PI) / 180
    const poly = /<InstrumentPolynomial>[\s\S]*?<\/InstrumentPolynomial>/.exec(body)?.[0] ?? ''
    // ENU（東・北・上）。dip は下向きが正。
    const u: Vec3 = [Math.cos(dip) * Math.sin(az), Math.cos(dip) * Math.cos(az), -Math.sin(dip)]
    return {
      j: Number(ch[1]) - 1,
      u,
      c0: Number(/number="0">([^<]+)</.exec(poly)?.[1]),
      c1: Number(/number="1">([^<]+)</.exec(poly)?.[1]),
    }
  })
}

describe('書いて読み戻す', () => {
  it('軸ごとの測る向き・ゼロ点・基板の向きが、元の値のまま（1 ビットも違わず）戻る', () => {
    // 方位・傾き・倍率から組み直すとずれる。元の値を拡張に持つので、そのまま戻る。
    const c = config(
      [sensor('i2c0-68'), sensor('i2c0-69', { axes: axesFrom(SHEAR), noiseDensity: 400, enabled: false }), twoAxis('i2c1-6a')],
      35.6,
      BOARD_A,
      REAL_ROTATION,
    )
    const doc = roundTrip(applyStationConfig(EMPTY_STATION_HISTORY, c, T0, 'startup'))
    expect(configAt(doc, T0)).toEqual(c)
  })

  it('2 軸のセンサーは HN1・HN2 の 2 本だけを書く', () => {
    const xml = writeStationXml(applyStationConfig(EMPTY_STATION_HISTORY, config([twoAxis('i2c0-6a')]), T0, 'startup'), T0)
    expect([...xml.matchAll(/<Channel code="(HN\d)"/g)].map((m) => m[1])).toEqual(['HN1', 'HN2'])
  })

  it('観測点・基板・センサーの並びが、設定のまま戻る（合成の基準は並びで決まる）', () => {
    const c: StationConfig = {
      stations: [
        { stationId: 'station-2', displayName: '居間', lat: 35.7, lon: 139.8 },
        { stationId: 'station-1', displayName: '書斎', lat: 35.6, lon: 139.7 },
      ],
      boards: [
        { boardKey: BOARD_B, stationId: 'station-1', orientation: IDENTITY_MATRIX, sensors: [sensor('i2c1-68'), sensor('i2c0-68')] },
        { boardKey: BOARD_A, stationId: 'station-1', orientation: IDENTITY_MATRIX, sensors: [sensor('i2c0-69'), sensor('i2c0-68')] },
      ],
    }
    const doc = roundTrip(applyStationConfig(EMPTY_STATION_HISTORY, c, T0, 'startup'))
    expect(configAt(doc, T0)).toEqual(c)
  })

  it('基板を割り当てていない観測点も戻る', () => {
    const c: StationConfig = {
      stations: [{ stationId: 'station-9', displayName: '未設置', lat: 10, lon: 20 }],
      boards: [],
    }
    const doc = roundTrip(applyStationConfig(EMPTY_STATION_HISTORY, c, T0, 'startup'))
    expect(doc.boards).toEqual([])
    expect(configAt(doc, T0)).toEqual(c)
  })

  it('記号・改行・タブを含む観測点の ID と名前が、そのまま戻る（属性値でも空白に化けない）', () => {
    const c: StationConfig = {
      stations: [{ stationId: 'st<&"\'>\t1', displayName: '書斎\n東側\t"窓際" & 🏠', lat: 35.6, lon: 139.7 }],
      boards: [{ boardKey: BOARD_A, stationId: 'st<&"\'>\t1', orientation: IDENTITY_MATRIX, sensors: [sensor('i2c0-68')] }],
    }
    const doc = roundTrip(applyStationConfig(EMPTY_STATION_HISTORY, c, T0, 'startup'))
    expect(configAt(doc, T0)).toEqual(c)
  })

  it('雛形（config/stations.example.xml）が読めて、設定の検証も通る', () => {
    const parsed = parseStationConfig(currentConfig(readStationXml(fixture('../../config/stations.example.xml'))))
    expect(parsed.ok).toBe(true)
  })

  it('期間と記録を、そのまま読み戻す', () => {
    let doc = applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a')]), T0, 'startup')
    doc = applyStationConfig(doc, config([sensor('a'), sensor('b', { axes: axesFrom(SHEAR) }), twoAxis('c')]), T1, 'changed')
    expect(roundTrip(doc)).toEqual(doc)
  })

  it('チャンネルの向きと多項式は、標準の読み方でホストの補正と同じ変換になる（3 軸・基板の向きあり）', () => {
    // StationXML の意味: チャンネル j は向き ŵ_j の加速度を測り、(ŵ_j·a) = c0 + c1 × m_j。
    // ホストの補正 a = B × H⁻¹ × (m − o) と、すべての m で一致しなければならない。
    const s = sensor('i2c0-69', { axes: axesFrom(SHEAR) })
    const xml = writeStationXml(applyStationConfig(EMPTY_STATION_HISTORY, config([s], 35.6, BOARD_A, YAW30), T0, 'startup'), T0)
    const resolved = resolveCalibration(YAW30, s)
    if (resolved === null || resolved.unmix === null) throw new Error('解けない')
    const m = [37.1, -12.4, 990.2]
    const offsets = [resolved.axes[0]!.offset, resolved.axes[1]!.offset, resolved.axes[2]!.offset] as const
    const a = applyCalibration([[m[0]!], [m[1]!], [m[2]!]], offsets, resolved.unmix).map((v) => v[0]!)
    const readings = standardReadings(xml)
    expect(readings).toHaveLength(3)
    for (const r of readings) {
      const projected = r.u[0] * a[0]! + r.u[1] * a[1]! + r.u[2] * a[2]!
      expect(r.c0 + r.c1 * m[r.j]!).toBeCloseTo(projected, 9)
    }
  })

  it('2 軸のセンサーも、標準の読み方で「その軸が測った向きの加速度」になる', () => {
    const s = twoAxis('i2c0-6a')
    const xml = writeStationXml(applyStationConfig(EMPTY_STATION_HISTORY, config([s], 35.6, BOARD_A, YAW30), T0, 'startup'), T0)
    const resolved = resolveCalibration(YAW30, s)
    if (resolved === null) throw new Error('解けない')
    // 地面の加速度 a のとき、軸 j は m_j = w_j · a + o_j を読む。
    const a: Vec3 = [12.5, -3.25, 981.7]
    for (const r of standardReadings(xml)) {
      const w = resolved.axes[r.j]!.vector
      const mj = w[0] * a[0] + w[1] * a[1] + w[2] * a[2] + resolved.axes[r.j]!.offset
      expect(r.c0 + r.c1 * mj).toBeCloseTo(r.u[0] * a[0] + r.u[1] * a[1] + r.u[2] * a[2], 9)
    }
  })

  it('補正なしの軸を回転させた基板に載せたら、向きは基板の向きの列と同じ', () => {
    // 対照。列 1 = (cos30, sin30, 0) → 北から東へ 60°。列 2 = (-sin30, cos30, 0) → 330°。列 3 = 上 → dip -90。
    const unit: SensorEntry = { sensorId: 'a', enabled: true, axes: axesFrom(IDENTITY_MATRIX, [1, 1, 1], [0, 0, 0]), noiseDensity: null }
    const xml = writeStationXml(applyStationConfig(EMPTY_STATION_HISTORY, config([unit], 35.6, BOARD_A, YAW30), T0, 'startup'), T0)
    const azimuths = [...xml.matchAll(/<Azimuth>([^<]+)</g)].map((x) => Number(x[1]))
    const dips = [...xml.matchAll(/<Dip>([^<]+)</g)].map((x) => Number(x[1]))
    expect(azimuths[0]).toBeCloseTo(60, 9)
    expect(azimuths[1]).toBeCloseTo(330, 9)
    expect(dips[2]).toBeCloseTo(-90, 9)
  })

  it('名乗れない基板・センサーは投げる（設定の検証を通っていれば起きない）', () => {
    expect(() => applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a')], 35.6, 'name:old'), T0, 'startup')).toThrow(StationXmlError)
    expect(() => applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('i2c0_68')]), T0, 'startup')).toThrow(StationXmlError)
  })
})

describe('期間の切り方', () => {
  it('読み戻した履歴へ同じ設定を足しても、期間は切れない（起動のたびに切れない）', () => {
    // 安全弁。読み戻した値と計算し直した値が 1 ビットでもずれると、ここで期間が増える。
    const c = config([sensor('a'), sensor('b', { axes: axesFrom(SHEAR) }), twoAxis('c')], 35.6, BOARD_A, YAW30)
    const first = roundTrip(applyStationConfig(EMPTY_STATION_HISTORY, c, T0, 'startup'))
    const second = applyStationConfig(first, configAt(first, T0), T1, 'startup')
    expect(second.boards).toEqual(first.boards)
    expect(second.revisions).toHaveLength(2)
  })

  it('並びだけ変えたら、期間は切らずに記録だけ増え、その時刻からは新しい並びで戻る', () => {
    const before = applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a'), sensor('b')]), T0, 'startup')
    const after = roundTrip(applyStationConfig(before, config([sensor('b'), sensor('a')]), T1, 'changed'))
    expect(after.boards).toEqual(before.boards)
    expect(configAt(after, T0).boards[0]?.sensors.map((s) => s.sensorId)).toEqual(['a', 'b'])
    expect(configAt(after, T1).boards[0]?.sensors.map((s) => s.sensorId)).toEqual(['b', 'a'])
  })

  it('1 本のセンサーの 1 軸のゼロ点だけ変えたら、その軸だけ期間を切る', () => {
    const before = applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a'), sensor('b')]), T0, 'startup')
    const axes = axesFrom(REAL_ROTATION)
    const changed = sensor('a', { axes: [axes[0]!, { ...axes[1]!, offset: 3.5 }, axes[2]!] })
    const after = applyStationConfig(before, config([changed, sensor('b')]), T1, 'changed')

    expect(after.boards).toHaveLength(1)
    const closed = after.boards[0]?.channels.filter((c) => c.endMs !== null) ?? []
    expect(closed.map((c) => [c.sensorId, c.axis, c.endMs])).toEqual([['a', 1, T1]])
    expect(configAt(roundTrip(after), T0)).toEqual(config([sensor('a'), sensor('b')]))
    expect(configAt(roundTrip(after), T1)).toEqual(config([changed, sensor('b')]))
  })

  it('観測点の座標が変わったら、基板の期間ごと閉じて開き直す', () => {
    const before = applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a')]), T0, 'startup')
    const after = applyStationConfig(before, config([sensor('a')], 36.0), T1, 'changed')
    expect(after.boards.map((b) => [b.startMs, b.endMs, b.station.lat])).toEqual([
      [T0, T1, 35.6],
      [T1, null, 36.0],
    ])
    // 閉じた基板の期間の中の軸も閉じる（期間が基板をはみ出さない）。
    expect(after.boards[0]?.channels.every((c) => c.endMs === T1)).toBe(true)
  })

  it('基板の向きが変わったら、基板の期間ごと閉じて開き直す（全部の軸の地面での向きが動く）', () => {
    const before = applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a'), twoAxis('b')]), T0, 'startup')
    const after = applyStationConfig(before, config([sensor('a'), twoAxis('b')], 35.6, BOARD_A, YAW30), T1, 'changed')
    expect(after.boards.map((b) => [b.startMs, b.endMs])).toEqual([
      [T0, T1],
      [T1, null],
    ])
    expect(after.boards[0]?.channels.every((c) => c.endMs === T1)).toBe(true)
    expect(configAt(roundTrip(after), T1).boards[0]?.orientation).toEqual(YAW30)
  })

  it('設定から外した基板は閉じ、戻したら新しい期間を開く', () => {
    let doc = applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a')]), T0, 'startup')
    doc = applyStationConfig(doc, { stations: [], boards: [] }, T1, 'changed')
    expect(configAt(doc, T1)).toEqual({ stations: [], boards: [] })
    doc = applyStationConfig(doc, config([sensor('a')]), T2, 'startup')
    expect(doc.boards.map((b) => [b.startMs, b.endMs])).toEqual([
      [T0, T1],
      [T2, null],
    ])
    const back = roundTrip(doc)
    expect([T0, T1, T2].map((t) => configAt(back, t).boards.length)).toEqual([1, 0, 1])
    expect(currentConfig(back)).toEqual(config([sensor('a')]))
  })

  it('最初の記録より前の時刻は空の設定・履歴が空ならいまの設定も空', () => {
    const doc = applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a')]), T1, 'startup')
    expect(configAt(doc, T0)).toEqual({ stations: [], boards: [] })
    expect(currentConfig(EMPTY_STATION_HISTORY)).toEqual({ stations: [], boards: [] })
  })

  it('時計が戻っても、終わりが始まりより前の期間も、前後が入れ替わった記録も作らない', () => {
    const before = applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a')]), T1, 'startup')
    const after = applyStationConfig(before, config([sensor('a')], 36.0), T0, 'changed')
    expect(after.boards[0]?.endMs).toBe(T1)
    expect(after.boards[1]?.startMs).toBe(T1)
    // 記録には実際の時刻も残し、区切りの時刻は前の記録へ寄せる。
    expect(after.revisions[1]).toMatchObject({ atMs: T0, effectiveMs: T1 })
    expect(roundTrip(after)).toEqual(after)
    expect(currentConfig(roundTrip(after))).toEqual(config([sensor('a')], 36.0))
  })

  it('期間を変えない記録のあとで時計が戻っても、記録の順を崩さない', () => {
    // 期間の始まりだけを見ると T0 へ戻ってしまう形（2 つ目の記録は期間を作らない）。
    let doc = applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a')]), T0, 'startup')
    doc = applyStationConfig(doc, config([sensor('a')]), T2, 'startup')
    doc = applyStationConfig(doc, config([sensor('a')]), T1, 'startup')
    expect(doc.revisions.map((r) => r.effectiveMs)).toEqual([T0, T2, T2])
    expect(() => roundTrip(doc)).not.toThrow()
  })

  it('長さが 0 の測る向き・逆行列を持たない基板の向きは投げる（設定の検証を通っていれば起きない）', () => {
    const zero = sensor('a', { axes: [{ vector: [0, 0, 0], offset: 0 }, ...axesFrom(REAL_ROTATION).slice(1)] })
    expect(() => applyStationConfig(EMPTY_STATION_HISTORY, config([zero]), T0, 'startup')).toThrow(StationXmlError)
    const singular: Mat3 = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 0],
    ]
    expect(() => applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a')], 35.6, BOARD_A, singular), T0, 'startup')).toThrow(
      StationXmlError,
    )
  })
})

describe('前の形（2026-10-09 まで）を読む', () => {
  // 書き換え前のホストが書いた履歴。`stations-legacy-history.xml` は次の 3 回の記録を持つ:
  //   T0: i2c0-68（REAL_ROTATION・既定の倍率とゼロ点）と i2c0-69（SHEAR・ノイズ密度 400）
  //   T1: i2c0-68 の 2 軸目の倍率だけ 0.95 に変える（その軸の期間だけが切れる）
  //   T2: 観測点の緯度を 36.0 に変える（基板の期間ごと切れる）
  const LEGACY_SENS: Vec3 = [1.0064, 0.9987, 0.99363]
  const LEGACY_OFFSET: Vec3 = [18.55, 2.25, 235.5]
  const legacyAt = (t: number): { sensorId: string; rotation: Mat3; sensitivity: Vec3 }[] => [
    { sensorId: 'i2c0-68', rotation: REAL_ROTATION, sensitivity: t >= T1 ? [1.0064, 0.95, 0.99363] : LEGACY_SENS },
    { sensorId: 'i2c0-69', rotation: SHEAR, sensitivity: LEGACY_SENS },
  ]

  /** 前の形の式（`a = R × diag(s) × (m − o)`）。 */
  function legacyApply(rotation: Mat3, sensitivity: Vec3, m: Vec3): Vec3 {
    const x = [0, 1, 2].map((i) => (m[i]! - LEGACY_OFFSET[i]!) * sensitivity[i]!)
    return [0, 1, 2].map((r) => rotation[r]![0] * x[0]! + rotation[r]![1] * x[1]! + rotation[r]![2] * x[2]!) as unknown as Vec3
  }

  const history = fixture('./testdata/stations-legacy-history.xml')

  it('正: 写した校正値で解いた加速度が、前の式と 1e-12 以内で一致する（どの記録の時点でも）', () => {
    const doc = readStationXml(history)
    for (const t of [T0, T1, T2]) {
      const board = configAt(doc, t).boards[0]!
      expect(board.orientation).toEqual(IDENTITY_MATRIX)
      for (const legacy of legacyAt(t)) {
        const s = board.sensors.find((x) => x.sensorId === legacy.sensorId)!
        const r = resolveCalibration(board.orientation, s)
        if (r === null || r.unmix === null) throw new Error('解けない')
        const offsets = [r.axes[0]!.offset, r.axes[1]!.offset, r.axes[2]!.offset] as const
        for (const m of [
          [37.1, -12.4, 990.2],
          [-981, 3, 0.5],
        ] as Vec3[]) {
          const want = legacyApply(legacy.rotation, legacy.sensitivity, m)
          const got = applyCalibration([[m[0]], [m[1]], [m[2]]], offsets, r.unmix).map((v) => v[0]!)
          for (let i = 0; i < 3; i++) expect(Math.abs(got[i]! - want[i]!)).toBeLessThan(1e-12 * Math.max(1, Math.abs(want[i]!)))
        }
      }
    }
  })

  it('正: 期間の区切りは前のまま（軸の期間 1 本が T1 で、基板の期間が T2 で切れている）', () => {
    const doc = readStationXml(history)
    expect(doc.boards.map((b) => [b.startMs, b.endMs])).toEqual([
      [T0, T2],
      [T2, null],
    ])
    const first = doc.boards[0]!
    expect(first.channels.filter((c) => c.endMs === T1).map((c) => [c.sensorId, c.axis])).toEqual([['i2c0-68', 1]])
    expect(first.channels.filter((c) => c.startMs === T1).map((c) => [c.sensorId, c.axis])).toEqual([['i2c0-68', 1]])
    expect(doc.revisions.map((r) => r.effectiveMs)).toEqual([T0, T1, T2])
  })

  it('安全弁: 読んだ設定を起動時と同じように当て直しても、期間は 1 本も切れない', () => {
    const doc = readStationXml(history)
    const next = applyStationConfig(doc, currentConfig(doc), T3, 'startup')
    expect(next.boards).toEqual(doc.boards)
    // 今の形で書き戻して読み直しても、期間と設定はそのまま。
    const back = roundTrip(next)
    expect(back.boards).toEqual(doc.boards)
    for (const t of [T0, T1, T2, T3]) expect(configAt(back, t)).toEqual(configAt(doc, t))
  })

  it('安全弁: 雛形と同じ 1 期間だけの前の形も読め、当て直しても切れない', () => {
    const doc = readStationXml(fixture('./testdata/stations-legacy.xml'))
    expect(parseStationConfig(currentConfig(doc)).ok).toBe(true)
    expect(applyStationConfig(doc, currentConfig(doc), Date.UTC(2026, 9, 10), 'startup').boards).toEqual(doc.boards)
  })

  it('対照: 前の形の標準の欄を書き換えた履歴は、読めないとして退ける', () => {
    const azimuth = /<Azimuth>([^<]+)</.exec(history)?.[1] ?? ''
    const tampered = history.replace(`<Azimuth>${azimuth}<`, `<Azimuth>${Number(azimuth) + 1}<`)
    expect(() => readStationXml(tampered)).toThrow(/食い違う/)
  })

  it('対照: 基板の向きと前の形のチャンネルが同じ Station にある履歴は退ける（どちらの向きで読むか決まらない）', () => {
    const withOrientation = history.replace(
      /(<seismo:StationId>[^<]*<\/seismo:StationId>)/,
      '$1<seismo:Orientation><seismo:X e="1" n="0" u="0"/><seismo:Y e="0" n="1" u="0"/><seismo:Z e="0" n="0" u="1"/></seismo:Orientation>',
    )
    expect(() => readStationXml(withOrientation)).toThrow(/両方ある/)
  })
})

describe('読めない履歴', () => {
  const base = writeStationXml(applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a')]), T0, 'startup'), T0)

  it('基の形は読める（対照）', () => {
    expect(() => readStationXml(base)).not.toThrow()
  })

  it('同じ基板の期間が重なっていたら投げる', () => {
    const station = /<Station [\s\S]*?<\/Station>/.exec(base)?.[0] ?? ''
    const doubled = base.replace(station, `${station}\n${station}`)
    expect(() => readStationXml(doubled)).toThrow(/重なっている/)
  })

  it('段が欠けていたら投げる', () => {
    expect(() => readStationXml(base.replace(/<Stage number="2">[\s\S]*?<\/Stage>/, ''))).toThrow(/段 2/)
  })

  it('標準の欄が元の値から計算したものと食い違えば投げる（どちらが正しいか決められない）', () => {
    const azimuth = /<Azimuth>([^<]+)</.exec(base)?.[1] ?? ''
    const tampered = base.replace(`<Azimuth>${azimuth}<`, `<Azimuth>${Number(azimuth) + 1}<`)
    expect(() => readStationXml(tampered)).toThrow(/食い違う/)
  })

  it('元の値が無ければ投げる', () => {
    expect(() => readStationXml(base.replace(/<seismo:Vector [^>]*\/>/, ''))).toThrow(/Vector も Rotation も無い/)
  })

  it('記録に載っている基板の期間が無ければ投げる', () => {
    const noStation = base.replace(/<Station [\s\S]*?<\/Station>/, '')
    expect(() => readStationXml(noStation)).toThrow(/期間が 0 本/)
  })

  it('記録に載っていない基板の期間が効いていたら投げる', () => {
    const noListing = base.replace(/<seismo:Board key=[\s\S]*?<\/seismo:Board>/, '')
    expect(() => readStationXml(noListing)).toThrow(/載っていない基板/)
  })

  it('FDSNStationXML でなければ投げる', () => {
    expect(() => readStationXml('<a xmlns="urn:x"/>')).toThrow(StationXmlError)
  })
})

describe('invert3', () => {
  it('逆行列を掛けると単位行列になる', () => {
    const inv = invert3(REAL_ROTATION)
    expect(inv).not.toBeNull()
    if (inv === null) return
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const v = [0, 1, 2].reduce((sum, k) => sum + (REAL_ROTATION[i]?.[k] as number) * (inv[k]?.[j] as number), 0)
        expect(v).toBeCloseTo(i === j ? 1 : 0, 12)
      }
    }
  })
})
