import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { BoardKey } from '../protocol/types'
import { applyCalibration } from './calibration'
import { invert3 } from './matrix3'
import { parseStationConfig } from './stationConfig'
import type { Mat3, SensorEntry, StationConfig } from './stationConfigTypes'
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

/** 実機の設定の履歴から取った値（10-03 15:44 の i2c0-68）。直交からのずれは 10⁻⁶ ほど。 */
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

const BOARD_A: BoardKey = 'mac:020000000003'
const BOARD_B: BoardKey = 'mac:020000000001'

function sensor(id: string, overrides: Partial<SensorEntry> = {}): SensorEntry {
  return {
    sensorId: id,
    enabled: true,
    rotation: REAL_ROTATION,
    offset: [18.55, 2.25, 235.5],
    sensitivity: [1.0064, 0.9987, 0.99363],
    noiseDensity: null,
    ...overrides,
  }
}

function config(sensors: SensorEntry[], lat = 35.6, boardKey: BoardKey = BOARD_A): StationConfig {
  return {
    stations: [{ stationId: 'station-1', displayName: '書斎', lat, lon: 139.7 }],
    boards: [{ boardKey, stationId: 'station-1', sensors }],
  }
}

function roundTrip(doc: StationHistoryDoc): StationHistoryDoc {
  return readStationXml(writeStationXml(doc, T2))
}

describe('書いて読み戻す', () => {
  it('回転行列・感度・ゼロ点が、元の値のまま（1 ビットも違わず）戻る', () => {
    // 方位・傾き・倍率から組み直すと 8e-15 ずれる。元の値を拡張に持つので、そのまま戻る。
    const c = config([sensor('i2c0-68'), sensor('i2c0-69', { rotation: SHEAR, noiseDensity: 400, enabled: false })])
    const doc = roundTrip(applyStationConfig(EMPTY_STATION_HISTORY, c, T0, 'startup'))
    expect(configAt(doc, T0)).toEqual(c)
  })

  it('観測点・基板・センサーの並びが、設定のまま戻る（合成の基準は並びで決まる）', () => {
    const c: StationConfig = {
      stations: [
        { stationId: 'station-2', displayName: '居間', lat: 35.7, lon: 139.8 },
        { stationId: 'station-1', displayName: '書斎', lat: 35.6, lon: 139.7 },
      ],
      boards: [
        { boardKey: BOARD_B, stationId: 'station-1', sensors: [sensor('i2c1-68'), sensor('i2c0-68')] },
        { boardKey: BOARD_A, stationId: 'station-1', sensors: [sensor('i2c0-69'), sensor('i2c0-68')] },
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
      boards: [{ boardKey: BOARD_A, stationId: 'st<&"\'>\t1', sensors: [sensor('i2c0-68')] }],
    }
    const doc = roundTrip(applyStationConfig(EMPTY_STATION_HISTORY, c, T0, 'startup'))
    expect(configAt(doc, T0)).toEqual(c)
  })

  it('雛形（config/stations.example.xml）が読めて、設定の検証も通る', () => {
    const xml = readFileSync(fileURLToPath(new URL('../../config/stations.example.xml', import.meta.url)), 'utf8')
    const parsed = parseStationConfig(currentConfig(readStationXml(xml)))
    expect(parsed.ok).toBe(true)
  })

  it('期間と記録を、そのまま読み戻す', () => {
    let doc = applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a')]), T0, 'startup')
    doc = applyStationConfig(doc, config([sensor('a'), sensor('b', { rotation: SHEAR })]), T1, 'changed')
    expect(roundTrip(doc)).toEqual(doc)
  })

  it('チャンネルの向きと多項式は、標準の読み方でホストの補正と同じ変換になる', () => {
    // StationXML の意味: チャンネル j は向き û_j の加速度を測り、(û_j·a) = c0 + c1 × m_j。
    // ホストの補正 a = R × diag(s) × (m − o) と、すべての m で一致しなければならない。
    const s = sensor('i2c0-69', { rotation: SHEAR })
    const xml = writeStationXml(applyStationConfig(EMPTY_STATION_HISTORY, config([s]), T0, 'startup'), T0)
    const m = [37.1, -12.4, 990.2]
    const [a0, a1, a2] = applyCalibration([[m[0] as number], [m[1] as number], [m[2] as number]], s).map((v) => v[0] as number)
    const channels = [...xml.matchAll(/<Channel code="HN(\d)"[\s\S]*?<\/Channel>/g)]
    expect(channels).toHaveLength(3)
    for (const ch of channels) {
      const j = Number(ch[1]) - 1
      const body = ch[0]
      const az = (Number(/<Azimuth>([^<]+)</.exec(body)?.[1]) * Math.PI) / 180
      const dip = (Number(/<Dip>([^<]+)</.exec(body)?.[1]) * Math.PI) / 180
      const poly = /<InstrumentPolynomial>[\s\S]*?<\/InstrumentPolynomial>/.exec(body)?.[0] ?? ''
      const c0 = Number(/number="0">([^<]+)</.exec(poly)?.[1])
      const c1 = Number(/number="1">([^<]+)</.exec(poly)?.[1])
      // ENU（X＝東・Y＝北・Z＝上）。dip は下向きが正。
      const u = [Math.cos(dip) * Math.sin(az), Math.cos(dip) * Math.cos(az), -Math.sin(dip)]
      const projected = (u[0] as number) * a0 + (u[1] as number) * a1 + (u[2] as number) * a2
      expect(c0 + c1 * (m[j] as number)).toBeCloseTo(projected, 9)
    }
  })

  it('回転が純粋な回転なら、向きは回転行列の列と同じ', () => {
    // 対照。直交なら R⁻¹ の行 = R の列。
    const theta = (30 * Math.PI) / 180
    const yaw: Mat3 = [
      [Math.cos(theta), -Math.sin(theta), 0],
      [Math.sin(theta), Math.cos(theta), 0],
      [0, 0, 1],
    ]
    const xml = writeStationXml(applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a', { rotation: yaw })]), T0, 'startup'), T0)
    const azimuths = [...xml.matchAll(/<Azimuth>([^<]+)</g)].map((x) => Number(x[1]))
    const dips = [...xml.matchAll(/<Dip>([^<]+)</g)].map((x) => Number(x[1]))
    // 列 1 = (cos30, sin30, 0) → 北から東へ 60°。列 2 = (-sin30, cos30, 0) → 330°。列 3 = 上 → dip -90。
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
    const c = config([sensor('a'), sensor('b', { rotation: SHEAR })])
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

  it('1 本のセンサーの 1 軸の感度だけ変えたら、その軸だけ期間を切る', () => {
    const before = applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a'), sensor('b')]), T0, 'startup')
    const changed = sensor('a', { sensitivity: [1.0064, 0.95, 0.99363] })
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

  it('特異な回転行列は投げる（設定の検証を通っていれば起きない）', () => {
    const singular: Mat3 = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 0],
    ]
    expect(() => applyStationConfig(EMPTY_STATION_HISTORY, config([sensor('a', { rotation: singular })]), T0, 'startup')).toThrow(
      StationXmlError,
    )
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
    expect(() => readStationXml(base.replace(/<seismo:Rotation [^>]*\/>/, ''))).toThrow(/Rotation/)
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
