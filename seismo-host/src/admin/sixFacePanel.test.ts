import { describe, expect, it } from 'vitest'

import {
  cardPanelFailureMessage,
  describeFaces,
  parseRestWindowsBody,
  restWindowsFetchProblem,
  sixFaceApplied,
  sixFaceProblem,
} from './sixFacePanel'
import type { FaceCoverage } from './sixFaceFit'
import type { Vec3 } from '../receiver/stationConfigTypes'

const ALL: FaceCoverage = { '+x': true, '-x': true, '+y': true, '-y': true, '+z': true, '-z': true }
const SOME: FaceCoverage = { '+x': true, '-x': true, '+y': false, '-y': false, '+z': true, '-z': false }

describe('parseRestWindowsBody', () => {
  it('正: センサーごとの窓と、いまの静止の始まりを読む', () => {
    const got = parseRestWindowsBody({
      sensors: [
        {
          boardKey: 'mac:aa',
          sensorId: 'i2c0-68',
          stillSinceMs: 0,
          windows: [{ meanGal: [1, 2, 980], sampleCount: 3000, atMs: 1, streamKey: 'k', sdGal: [1, 1, 1] }],
        },
      ],
    })
    expect(got).toEqual([
      { boardKey: 'mac:aa', sensorId: 'i2c0-68', stillSinceMs: 0, windows: [{ meanGal: [1, 2, 980], sampleCount: 3000, atMs: 1 }] },
    ])
  })

  it('安全弁: 窓が 1 つでも崩れていれば応答ごと null（黙って落とすと「まだ揃っていない」に化ける）', () => {
    const good = { meanGal: [1, 2, 3], sampleCount: 10, atMs: 1 }
    const withBad = (bad: unknown) =>
      parseRestWindowsBody({ sensors: [{ boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, windows: [good, bad] }] })
    expect(withBad({ meanGal: [1, 2], sampleCount: 3000, atMs: 1 })).toBeNull()
    expect(withBad({ meanGal: [1, 2, 3], sampleCount: 0, atMs: 1 })).toBeNull()
    expect(withBad({ meanGal: [1, 2, 3], sampleCount: 10 })).toBeNull()
    expect(withBad(null)).toBeNull()
  })

  it('安全弁: センサー 1 件の形が崩れていても応答ごと null', () => {
    const ok = { boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, windows: [] }
    expect(parseRestWindowsBody({ sensors: [ok, { boardKey: 'mac:aa', stillSinceMs: null, windows: [] }] })).toBeNull()
    expect(parseRestWindowsBody({ sensors: [ok, null] })).toBeNull()
  })

  // **欄が無いだけで応答ごと捨てない。** この欄を使わない 6 面法まで止まる。押せない側
  // （いま静止していない）へ倒れるので、誤った回転は入らない。
  it('対照: いまの静止の始まりの欄が無ければ、そのセンサーを「いま静止していない」と読む', () => {
    expect(
      parseRestWindowsBody({ sensors: [{ boardKey: 'mac:aa', sensorId: 's', windows: [{ meanGal: [1, 2, 3], sampleCount: 10, atMs: 1 }] }] }),
    ).toEqual([{ boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, windows: [{ meanGal: [1, 2, 3], sampleCount: 10, atMs: 1 }] }])
  })

  it('安全弁: いまの静止の始まりが数として読めなければ応答ごと null', () => {
    expect(
      parseRestWindowsBody({ sensors: [{ boardKey: 'mac:aa', sensorId: 's', stillSinceMs: 'x', windows: [] }] }),
    ).toBeNull()
  })

  it('対照: 窓の無いセンサー・いま静止していないセンサーはそのまま読む（形は正しい）', () => {
    expect(
      parseRestWindowsBody({ sensors: [{ boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, windows: [] }] }),
    ).toEqual([{ boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, windows: [] }])
  })

  it('対照: 応答の外側が違えば null', () => {
    expect(parseRestWindowsBody(null)).toBeNull()
    expect(parseRestWindowsBody({ sensors: 'x' })).toBeNull()
  })
})

describe('文言', () => {
  it('揃い具合の 1 行', () => {
    expect(describeFaces(SOME)).toBe('＋X ✓　−X ✓　＋Y —　−Y —　＋Z ✓　−Z —')
  })

  it('押せない理由（4 通り）', () => {
    expect(sixFaceProblem({ ok: false, reason: 'missing-faces', faces: SOME, maxResidualGal: null })).toBe(
      'まだ揃っていない面がある（＋Y・−Y・−Z）',
    )
    expect(sixFaceProblem({ ok: false, reason: 'degenerate', faces: ALL, maxResidualGal: null })).toBe(
      '計算できなかった（方程式が解けない。置き直して測り直すこと）',
    )
    expect(sixFaceProblem({ ok: false, reason: 'out-of-range', faces: ALL, maxResidualGal: null })).toBe(
      '出た値が個体差の幅を超えている（倍率 0.5〜2 倍・ゼロ点 ±490 gal）',
    )
    expect(sixFaceProblem({ ok: false, reason: 'residual-too-large', faces: ALL, maxResidualGal: 24.06 })).toBe(
      '姿勢の間で辻褄が合わない（残差 24.1 gal）。動かしている最中の窓が混ざった疑い',
    )
  })

  it('カードの欄を描き直せなかった知らせは 1 行にまとめる（両方・片方ずつ・無し）', () => {
    expect(cardPanelFailureMessage(2, 3)).toBe(
      '2 枚のセンサーカードで取り付けの診断を、3 枚で 6 面法の欄を出せない。画面を再読込すること',
    )
    expect(cardPanelFailureMessage(2, 0)).toBe('2 枚のセンサーカードで取り付けの診断を出せない。画面を再読込すること')
    expect(cardPanelFailureMessage(0, 1)).toBe('1 枚のセンサーカードで 6 面法の欄を出せない。画面を再読込すること')
    expect(cardPanelFailureMessage(0, 0)).toBeNull()
  })

  it('取得できなかったとき', () => {
    expect(restWindowsFetchProblem('401')).toBe('静止した窓を取得できない（401）')
  })

  it('対照: 押せるなら理由は出さない', () => {
    expect(
      sixFaceProblem({ ok: true, offset: [0, 0, 0], sensitivity: [1, 1, 1], faces: ALL, poseCount: 6, maxResidualGal: null }),
    ).toBeNull()
  })

  const UNIT: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]

  it('押した後: 7 姿勢なら残差、6 姿勢なら検算なし。ゼロ点と、長さを 1/倍率 にした向きを桁を切って入れる', () => {
    const seven = sixFaceApplied(
      {
        ok: true,
        offset: [-82.123456, 5, -315.987],
        sensitivity: [1.0234567, 0.98, 1.01],
        faces: ALL,
        poseCount: 7,
        maxResidualGal: 3.21,
      },
      UNIT,
    )
    if (!seven.ok) throw new Error(seven.reason)
    expect(seven.axes.map((a) => a.offset)).toEqual(['-82.12', '5.00', '-315.99'])
    expect(seven.axes.map((a) => a.vector)).toEqual([
      ['0.977081', '0.000000', '0.000000'],
      ['0.000000', '1.020408', '0.000000'],
      ['0.000000', '0.000000', '0.990099'],
    ])
    expect(seven.note).toBe(
      'ゼロ点と向きの長さを入れた（姿勢 7・残差 3.2 gal）。保存するまで効かない。保存したら元の場所へ据え直し、「鉛直を合わせる」を押し直すこと',
    )
    const six = sixFaceApplied({ ok: true, offset: [0, 0, 0], sensitivity: [1, 1, 1], faces: ALL, poseCount: 6, maxResidualGal: null }, UNIT)
    if (!six.ok) throw new Error(six.reason)
    expect(six.note).toContain('（姿勢 6・検算なし）')
  })

  it('押した後: 測る向きはいまの欄の向きのまま、長さだけを変える（傾けて付けた軸の向きを保つ）', () => {
    const tilted: Vec3[] = [
      [0.6, 0.8, 0],
      [-0.8, 0.6, 0],
      [0, 0, 2],
    ]
    const got = sixFaceApplied({ ok: true, offset: [0, 0, 0], sensitivity: [2, 1, 1], faces: ALL, poseCount: 6, maxResidualGal: null }, tilted)
    if (!got.ok) throw new Error(got.reason)
    expect(got.axes.map((a) => a.vector)).toEqual([
      ['0.300000', '0.400000', '0.000000'],
      ['-0.800000', '0.600000', '0.000000'],
      ['0.000000', '0.000000', '1.000000'],
    ])
  })

  it('安全弁: 2 軸のセンサーには入れない（6 面法は 3 軸の当てはめ）', () => {
    const got = sixFaceApplied({ ok: true, offset: [0, 0, 0], sensitivity: [1, 1, 1], faces: ALL, poseCount: 6, maxResidualGal: null }, UNIT.slice(0, 2))
    expect(got).toEqual({ ok: false, reason: '6 面法は 3 軸のセンサーにしか使えない' })
  })
})
