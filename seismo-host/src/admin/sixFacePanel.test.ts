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

const ALL: FaceCoverage = { '+x': true, '-x': true, '+y': true, '-y': true, '+z': true, '-z': true }
const SOME: FaceCoverage = { '+x': true, '-x': true, '+y': false, '-y': false, '+z': true, '-z': false }

describe('parseRestWindowsBody', () => {
  it('正: センサーごとの窓を読む', () => {
    const got = parseRestWindowsBody({
      sensors: [{ boardKey: 'mac:aa', sensorId: 'i2c0-68', windows: [{ meanGal: [1, 2, 980], sampleCount: 3000, atMs: 1 }] }],
    })
    expect(got).toEqual([{ boardKey: 'mac:aa', sensorId: 'i2c0-68', windows: [{ meanGal: [1, 2, 980], sampleCount: 3000 }] }])
  })

  it('安全弁: 窓が 1 つでも崩れていれば応答ごと null（黙って落とすと「まだ揃っていない」に化ける）', () => {
    const good = { meanGal: [1, 2, 3], sampleCount: 10 }
    const withBad = (bad: unknown) =>
      parseRestWindowsBody({ sensors: [{ boardKey: 'mac:aa', sensorId: 's', windows: [good, bad] }] })
    expect(withBad({ meanGal: [1, 2], sampleCount: 3000 })).toBeNull()
    expect(withBad({ meanGal: [1, 2, 3], sampleCount: 0 })).toBeNull()
    expect(withBad(null)).toBeNull()
  })

  it('安全弁: センサー 1 件の形が崩れていても応答ごと null', () => {
    const ok = { boardKey: 'mac:aa', sensorId: 's', windows: [] }
    expect(parseRestWindowsBody({ sensors: [ok, { boardKey: 'mac:aa', windows: [] }] })).toBeNull()
    expect(parseRestWindowsBody({ sensors: [ok, null] })).toBeNull()
  })

  it('対照: 窓の無いセンサーはそのまま読む（形は正しい）', () => {
    expect(parseRestWindowsBody({ sensors: [{ boardKey: 'mac:aa', sensorId: 's', windows: [] }] })).toEqual([
      { boardKey: 'mac:aa', sensorId: 's', windows: [] },
    ])
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
      '出た値が個体差の幅を超えている（感度 0.5〜2 倍・オフセット ±490 gal）',
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

  it('押した後: 7 姿勢なら残差、6 姿勢なら検算なし。桁を切って入れる', () => {
    const seven = sixFaceApplied({
      ok: true,
      offset: [-82.123456, 5, -315.987],
      sensitivity: [1.0234567, 0.98, 1.01],
      faces: ALL,
      poseCount: 7,
      maxResidualGal: 3.21,
    })
    expect(seven.offset).toEqual(['-82.12', '5.00', '-315.99'])
    expect(seven.sensitivity).toEqual(['1.02346', '0.98000', '1.01000'])
    expect(seven.note).toBe(
      'オフセットと感度を入れた（姿勢 7・残差 3.2 gal）。保存するまで効かない。保存したら元の場所へ据え直し、「鉛直を合わせる」を押し直すこと',
    )
    const six = sixFaceApplied({ ok: true, offset: [0, 0, 0], sensitivity: [1, 1, 1], faces: ALL, poseCount: 6, maxResidualGal: null })
    expect(six.note).toContain('（姿勢 6・検算なし）')
  })
})
