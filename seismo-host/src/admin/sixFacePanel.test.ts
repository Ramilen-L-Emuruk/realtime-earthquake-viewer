import { describe, expect, it } from 'vitest'

import type { BoardSixFaceFit, BoardSixFaceRefusal, FaceCoverage } from './boardSixFace'
import {
  cardPanelFailureMessage,
  describeFaces,
  parseRestWindowsBody,
  restWindowsFetchProblem,
  sixFaceApplied,
  sixFaceProblem,
} from './sixFacePanel'

const ALL: FaceCoverage = { '+x': true, '-x': true, '+y': true, '-y': true, '+z': true, '-z': true }
const SOME: FaceCoverage = { '+x': true, '-x': true, '+y': false, '-y': false, '+z': true, '-z': false }

describe('parseRestWindowsBody', () => {
  it('正: センサーごとの窓（始まりと終わり）と、いまの静止の始まりを読む', () => {
    const got = parseRestWindowsBody({
      sensors: [
        {
          boardKey: 'mac:aa',
          sensorId: 'i2c0-68',
          stillSinceMs: 0,
          windows: [{ meanGal: [1, 2, 980], sampleCount: 3000, fromMs: 0, atMs: 1, streamKey: 'k', sdGal: [1, 1, 1] }],
        },
      ],
    })
    expect(got).toEqual([
      {
        boardKey: 'mac:aa',
        sensorId: 'i2c0-68',
        stillSinceMs: 0,
        windows: [{ meanGal: [1, 2, 980], sampleCount: 3000, fromMs: 0, atMs: 1 }],
      },
    ])
  })

  it('安全弁: 窓が 1 つでも崩れていれば応答ごと null（黙って落とすと「まだ揃っていない」に化ける）', () => {
    const good = { meanGal: [1, 2, 3], sampleCount: 10, fromMs: 0, atMs: 1 }
    const withBad = (bad: unknown) =>
      parseRestWindowsBody({ sensors: [{ boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, windows: [good, bad] }] })
    expect(withBad({ meanGal: [1, 2, 3, 4], sampleCount: 3000, atMs: 1 })).toBeNull()
    expect(withBad({ meanGal: [1, 2, 3], sampleCount: 0, atMs: 1 })).toBeNull()
    expect(withBad({ meanGal: [1, 2, 3], sampleCount: 10 })).toBeNull()
    expect(withBad({ meanGal: [1, 2, 3], sampleCount: 10, fromMs: 'x', atMs: 1 })).toBeNull()
    expect(withBad(null)).toBeNull()
  })

  // 正（2026-10-10 に覆した: 前は 2 軸のセンサーを飛ばしていた）: 基板の 6 面法と「鉛直を合わせる」は
  // 基板に載った全部の軸を一緒に解くので、2 軸のセンサーの窓も読む。
  it('正: 2 軸のセンサー（窓の平均が 2 本）も読む', () => {
    const two = { boardKey: 'mac:bb', sensorId: 's2', stillSinceMs: 5, windows: [{ meanGal: [1, 2], sampleCount: 10, fromMs: 0, atMs: 1 }] }
    expect(parseRestWindowsBody({ sensors: [two] })).toEqual([
      { boardKey: 'mac:bb', sensorId: 's2', stillSinceMs: 5, windows: [{ meanGal: [1, 2], sampleCount: 10, fromMs: 0, atMs: 1 }] },
    ])
  })

  it('安全弁: 2 軸の窓でも値が数として読めなければ応答ごと null', () => {
    const two = { boardKey: 'mac:bb', sensorId: 's2', stillSinceMs: null, windows: [{ meanGal: [1, 'x'], sampleCount: 10, atMs: 1 }] }
    expect(parseRestWindowsBody({ sensors: [two] })).toBeNull()
  })

  it('安全弁: 1 つのセンサーに 2 本と 3 本の窓が混ざっていれば応答ごと null（ホストは本数が変わると窓を捨てる）', () => {
    const mixed = {
      boardKey: 'mac:bb',
      sensorId: 's2',
      stillSinceMs: null,
      windows: [
        { meanGal: [1, 2], sampleCount: 10, atMs: 1 },
        { meanGal: [1, 2, 3], sampleCount: 10, atMs: 2 },
      ],
    }
    expect(parseRestWindowsBody({ sensors: [mixed] })).toBeNull()
  })

  it('安全弁: センサー 1 件の形が崩れていても応答ごと null', () => {
    const ok = { boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, windows: [] }
    expect(parseRestWindowsBody({ sensors: [ok, { boardKey: 'mac:aa', stillSinceMs: null, windows: [] }] })).toBeNull()
    expect(parseRestWindowsBody({ sensors: [ok, null] })).toBeNull()
  })

  // **欄が無いだけで応答ごと捨てない。** 使わない側まで止まる。どちらも押せない側へ倒れるので、
  // 誤った値は入らない（静止の始まりが無ければ「いま静止していない」、窓の始まりが無ければ 6 面法が断る）。
  it('対照: いまの静止の始まり・窓の始まりの欄が無ければ、null として読む（前の版のホスト）', () => {
    expect(
      parseRestWindowsBody({ sensors: [{ boardKey: 'mac:aa', sensorId: 's', windows: [{ meanGal: [1, 2, 3], sampleCount: 10, atMs: 1 }] }] }),
    ).toEqual([
      { boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, windows: [{ meanGal: [1, 2, 3], sampleCount: 10, fromMs: null, atMs: 1 }] },
    ])
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

describe('文言（2026-10-10 ユーザー承認）', () => {
  const refused = (over: Partial<BoardSixFaceRefusal> & Pick<BoardSixFaceRefusal, 'reason'>): BoardSixFaceRefusal => ({
    ok: false,
    faces: ALL,
    poseCount: 9,
    minPoses: 9,
    sensorId: null,
    cardAxisCount: null,
    windowAxisCount: null,
    maxResidualGal: null,
    ...over,
  })

  it('揃い具合の 1 行（姿勢の数と要る数を末尾に）', () => {
    expect(describeFaces(SOME, 7, 9)).toBe('＋X ✓　−X ✓　＋Y —　−Y —　＋Z ✓　−Z —　姿勢 7／9')
    expect(describeFaces(SOME, 0, Number.POSITIVE_INFINITY)).toBe('＋X ✓　−X ✓　＋Y —　−Y —　＋Z ✓　−Z —　姿勢 0／—')
  })

  it('押せない理由（9 通り）', () => {
    expect(sixFaceProblem(refused({ reason: 'missing-faces', faces: SOME }))).toBe('まだ揃っていない面がある（＋Y・−Y・−Z）')
    expect(sixFaceProblem(refused({ reason: 'no-common-pose', sensorId: 's2' }))).toBe(
      'センサー s2 が、ほかのセンサーと同時に静止した置き方が無い',
    )
    expect(sixFaceProblem(refused({ reason: 'axis-count-mismatch', sensorId: 's2', cardAxisCount: 2, windowAxisCount: 3 }))).toBe(
      'センサー s2 のカードの軸の本数（2 本）が、届いている値の本数（3 本）と合わない',
    )
    expect(sixFaceProblem(refused({ reason: 'prior-degenerate' }))).toBe(
      'カードの軸の向きが 3 方向へ散っていない（立てて付けたセンサーは、大まかな向きを先に入れること）',
    )
    expect(sixFaceProblem(refused({ reason: 'no-window-start' }))).toBe('静止窓に始まりの時刻が無い（ホストの版が古い疑い）')
    expect(sixFaceProblem(refused({ reason: 'too-few-poses', poseCount: 7, minPoses: 9 }))).toBe(
      '姿勢が足りない（7／9）。6 面に加えて、斜めにも置くこと',
    )
    expect(sixFaceProblem(refused({ reason: 'degenerate' }))).toBe('計算できなかった（解が定まらない。置き直して測り直すこと）')
    expect(sixFaceProblem(refused({ reason: 'out-of-range' }))).toBe(
      '出た値が個体差の幅を超えている（倍率 0.5〜2 倍・ゼロ点 ±490 gal）',
    )
    expect(sixFaceProblem(refused({ reason: 'residual-too-large', maxResidualGal: 23.44 }))).toBe(
      '姿勢の間で辻褄が合わない（残差 23.4 gal）。動かしている最中の窓が混ざった疑い',
    )
  })

  it('取り付けの欄を描き直せなかった知らせ（あり・無し）', () => {
    expect(cardPanelFailureMessage(2, false)).toBe('2 枚のセンサーカードで取り付けの診断を出せない。画面を再読込すること')
    // 基板の向きの欄の失敗は、カードの枚数へ足さずに分けて言う（2026-10-10）。
    expect(cardPanelFailureMessage(0, true)).toBe('基板の向きの欄で取り付けの診断を出せない。画面を再読込すること')
    expect(cardPanelFailureMessage(1, true)).toBe(
      '1 枚のセンサーカードと基板の向きの欄で取り付けの診断を出せない。画面を再読込すること',
    )
    expect(cardPanelFailureMessage(0, false)).toBeNull()
  })

  it('取得できなかったとき', () => {
    expect(restWindowsFetchProblem('401')).toBe('静止した窓を取得できない（401）')
  })

  const fit = (maxResidualGal: number | null, poseCount: number): BoardSixFaceFit => ({
    ok: true,
    sensors: [
      {
        sensorId: 's0',
        axes: [
          { vector: [1.0123456789, 0, 0], offset: 12.3456 },
          { vector: [0.0120004, 0.99, 0], offset: -8 },
        ],
      },
      { sensorId: 's1', axes: [{ vector: [0.98, 0.02, -0.0500001], offset: -315.987 }, { vector: [0, 0, 1], offset: 0 }] },
    ],
    faces: ALL,
    poseCount,
    minPoses: 9,
    maxResidualGal,
  })

  it('対照: 押せるなら理由は出さない', () => {
    expect(sixFaceProblem(fit(null, 9))).toBeNull()
  })

  it('押した後: カードの並びで全部のセンサーの軸を、桁を切って入れる。残差があれば添え、無ければ検算なし', () => {
    const got = sixFaceApplied(fit(3.14, 10))
    expect(got.sensors).toEqual([
      [
        { vector: ['1.012346', '0.000000', '0.000000'], offset: '12.35' },
        { vector: ['0.012000', '0.990000', '0.000000'], offset: '-8.00' },
      ],
      [
        { vector: ['0.980000', '0.020000', '-0.050000'], offset: '-315.99' },
        { vector: ['0.000000', '0.000000', '1.000000'], offset: '0.00' },
      ],
    ])
    expect(got.note).toBe(
      '全部のセンサーの軸の向き・倍率・ゼロ点を入れた（姿勢 10・残差 3.1 gal）。保存するまで効かない。保存したら元の場所へ据え直し、「鉛直を合わせる」を押し直すこと',
    )
    expect(sixFaceApplied(fit(null, 9)).note).toContain('（姿勢 9・検算なし）')
  })

  it('安全弁: 丸めて 0 になった負の数は負号を付けずに入れる', () => {
    const tiny: BoardSixFaceFit = {
      ...fit(null, 9),
      sensors: [{ sensorId: 's0', axes: [{ vector: [1, -1e-9, -0.0000004], offset: -0.001 }] }],
    }
    expect(sixFaceApplied(tiny).sensors[0]).toEqual([{ vector: ['1.000000', '0.000000', '0.000000'], offset: '0.00' }])
  })
})
