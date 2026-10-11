import { describe, expect, it } from 'vitest'

import type { BoardSixFaceFit, BoardSixFaceProgress, BoardSixFaceRefusal, FaceCoverage } from './boardSixFace'
import {
  cardPanelFailureMessage,
  describePlacement,
  describeProgress,
  parseRestWindowsBody,
  restWindowsFetchProblem,
  sixFaceApplied,
  sixFaceProblem,
} from './sixFacePanel'

const ALL: FaceCoverage = { '+x': true, '-x': true, '+y': true, '-y': true, '+z': true, '-z': true }
const SOME: FaceCoverage = { '+x': true, '-x': true, '+y': false, '-y': false, '+z': true, '-z': false }

describe('parseRestWindowsBody', () => {
  it('正: ホストの時刻・窓の長さと、センサーごとの窓（始まりと終わり）・いまの静止の始まり・溜めかけの窓を読む', () => {
    const got = parseRestWindowsBody({
      nowMs: 40_000,
      windowMs: 30_000,
      sensors: [
        {
          boardKey: 'mac:aa',
          sensorId: 'i2c0-68',
          stillSinceMs: 0,
          pending: { fromMs: 30_000, sampleCount: 1000, still: true, voided: false },
          windows: [{ meanGal: [1, 2, 980], sampleCount: 3000, fromMs: 0, atMs: 1, streamKey: 'k', sdGal: [1, 1, 1] }],
        },
      ],
    })
    expect(got).toEqual({
      nowMs: 40_000,
      windowMs: 30_000,
      sensors: [
        {
          boardKey: 'mac:aa',
          sensorId: 'i2c0-68',
          stillSinceMs: 0,
          pending: { fromMs: 30_000, still: true, voided: false },
          windows: [{ meanGal: [1, 2, 980], sampleCount: 3000, fromMs: 0, atMs: 1 }],
        },
      ],
    })
  })

  it('対照: 溜めかけの窓の still は false・null もそのまま読む', () => {
    const body = (still: unknown) => ({
      nowMs: 0,
      windowMs: 30_000,
      sensors: [{ boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, pending: { fromMs: 0, sampleCount: 1, still, voided: false }, windows: [] }],
    })
    expect(parseRestWindowsBody(body(false))?.sensors[0]?.pending).toEqual({ fromMs: 0, still: false, voided: false })
    expect(parseRestWindowsBody(body(null))?.sensors[0]?.pending).toEqual({ fromMs: 0, still: null, voided: false })
  })

  it('安全弁: 時刻・窓の長さ・溜めかけの窓が崩れていれば応答ごと null', () => {
    const sensor = { boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, windows: [] }
    expect(parseRestWindowsBody({ nowMs: 'x', sensors: [sensor] })).toBeNull()
    expect(parseRestWindowsBody({ windowMs: 0, sensors: [sensor] })).toBeNull()
    expect(parseRestWindowsBody({ sensors: [{ ...sensor, pending: { fromMs: 'x', still: true } }] })).toBeNull()
    expect(parseRestWindowsBody({ sensors: [{ ...sensor, pending: { fromMs: 0, still: 'yes' } }] })).toBeNull()
    expect(parseRestWindowsBody({ sensors: [{ ...sensor, pending: 7 }] })).toBeNull()
    expect(parseRestWindowsBody({ sensors: [{ ...sensor, pending: { fromMs: 0, still: true, voided: 'x' } }] })).toBeNull()
    // 途切れの印が欠けていても応答ごと null（「途切れていない」へ倒すと、数えない窓を数える側へ倒れる）。
    expect(parseRestWindowsBody({ sensors: [{ ...sensor, pending: { fromMs: 0, still: true } }] })).toBeNull()
  })

  it('正: 溜めかけの窓の途切れの印を読む', () => {
    const sensor = { boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, windows: [] }
    expect(parseRestWindowsBody({ sensors: [{ ...sensor, pending: { fromMs: 0, still: true, voided: true } }] })?.sensors[0]?.pending).toEqual({
      fromMs: 0,
      still: true,
      voided: true,
    })
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
    expect(parseRestWindowsBody({ sensors: [two] })?.sensors).toEqual([
      { boardKey: 'mac:bb', sensorId: 's2', stillSinceMs: 5, pending: null, windows: [{ meanGal: [1, 2], sampleCount: 10, fromMs: 0, atMs: 1 }] },
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
  it('対照: いまの静止の始まり・窓の始まり・時刻・窓の長さ・溜めかけの窓の欄が無ければ、null として読む（前の版のホスト）', () => {
    expect(
      parseRestWindowsBody({ sensors: [{ boardKey: 'mac:aa', sensorId: 's', windows: [{ meanGal: [1, 2, 3], sampleCount: 10, atMs: 1 }] }] }),
    ).toEqual({
      nowMs: null,
      windowMs: null,
      sensors: [
        { boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, pending: null, windows: [{ meanGal: [1, 2, 3], sampleCount: 10, fromMs: null, atMs: 1 }] },
      ],
    })
  })

  it('安全弁: いまの静止の始まりが数として読めなければ応答ごと null', () => {
    expect(
      parseRestWindowsBody({ sensors: [{ boardKey: 'mac:aa', sensorId: 's', stillSinceMs: 'x', windows: [] }] }),
    ).toBeNull()
  })

  it('対照: 窓の無いセンサー・いま静止していないセンサーはそのまま読む（形は正しい）', () => {
    expect(
      parseRestWindowsBody({ sensors: [{ boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, windows: [] }] }),
    ).toEqual({ nowMs: null, windowMs: null, sensors: [{ boardKey: 'mac:aa', sensorId: 's', stillSinceMs: null, pending: null, windows: [] }] })
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

  const progress = (over: Partial<BoardSixFaceProgress> = {}): BoardSixFaceProgress => ({
    commonPose: true,
    faces: SOME,
    poseCount: 7,
    minPoses: 9,
    spreadOk: false,
    remainingPoses: 3,
    current: 'not-counted',
    ...over,
  })

  it('進み具合の 4 行（解く条件の順）', () => {
    expect(describeProgress(progress())).toEqual([
      '① 同時に静止　✓',
      '② 6 面　＋X ✓　−X ✓　＋Y —　−Y —　＋Z ✓　−Z —',
      '③ 向き　7／9（あと 3 姿勢）',
      '④ 斜めの散らばり　—',
    ])
  })

  it('対照: 揃ったら「あと N 姿勢」を出さず、✓ を並べる', () => {
    expect(describeProgress(progress({ faces: ALL, poseCount: 9, spreadOk: true, remainingPoses: 0 }))).toEqual([
      '① 同時に静止　✓',
      '② 6 面　＋X ✓　−X ✓　＋Y ✓　−Y ✓　＋Z ✓　−Z ✓',
      '③ 向き　9／9',
      '④ 斜めの散らばり　✓',
    ])
  })

  it('安全弁: 同時に静止した置き方が無ければ ① は —、要る数が解けない形なら —', () => {
    const lines = describeProgress(
      progress({ commonPose: false, poseCount: 0, minPoses: Number.POSITIVE_INFINITY, remainingPoses: Number.POSITIVE_INFINITY }),
    )
    expect(lines[0]).toBe('① 同時に静止　—')
    expect(lines[2]).toBe('③ 向き　0／—（あと — 姿勢）')
  })

  describe('いまの置き方の行', () => {
    const clock = { nowMs: 100_000, sampledAtMs: 100_000, windowMs: 30_000 }
    const source = (pending: { fromMs: number; still: boolean | null; voided?: boolean } | null, stillSinceMs: number | null = null) => ({
      boardKey: 'mac:aa',
      sensorId: 's',
      stillSinceMs,
      pending: pending === null ? null : { voided: false, ...pending },
      windows: [],
    })
    const one = (pending: { fromMs: number; still: boolean | null; voided?: boolean } | null, stillSinceMs: number | null = null) => [
      { sensorId: 's1', source: source(pending, stillSinceMs) },
    ]

    const placementText = (...args: Parameters<typeof describePlacement>) => describePlacement(...args)?.text ?? null

    it('正: 溜めかけの窓が静止のまま閉じるまでの秒を、いちばん遅いセンサーで数える', () => {
      // s1 は 23 秒後、s2 は 5 秒後に閉じる → 遅いほうの 23 秒。
      const sources = [
        { sensorId: 's1', source: source({ fromMs: 93_000, still: true }) },
        { sensorId: 's2', source: source({ fromMs: 75_000, still: true }) },
      ]
      expect(placementText('not-counted', sources, clock)).toBe(
        'いまの置き方: このまま動かさなければ、あと 23 秒で 1 姿勢として数える',
      )
    })

    it('対照: 判定に足りない溜めかけ（still が null）も、静止のまま閉じる見込みで数える', () => {
      expect(placementText('not-counted', one({ fromMs: 99_000, still: null }), clock)).toBe(
        'いまの置き方: このまま動かさなければ、あと 29 秒で 1 姿勢として数える',
      )
    })

    it('正: 動いていれば、次の窓が閉じるまでを足して「いま止めれば」で言う', () => {
      expect(placementText('not-counted', one({ fromMs: 90_000, still: false }), clock)).toBe(
        'いまの置き方: 動いている。いま止めれば、あと 50 秒で数える',
      )
    })

    it('正: 窓の途中で波形が途切れたら、次の窓が閉じるまでを数える（動いてはいないので「動いている」とは言わない）', () => {
      expect(placementText('not-counted', one({ fromMs: 90_000, still: true, voided: true }, 60_000), clock)).toBe(
        'いまの置き方: このまま動かさなければ、あと 50 秒で 1 姿勢として数える',
      )
    })

    it('対照: もう静止した窓が閉じているセンサーは待たない', () => {
      const sources = [
        { sensorId: 's1', source: source({ fromMs: 90_000, still: true }, 60_000) },
        { sensorId: 's2', source: source({ fromMs: 80_000, still: true }) },
      ]
      expect(placementText('not-counted', sources, clock)).toBe(
        'いまの置き方: このまま動かさなければ、あと 10 秒で 1 姿勢として数える',
      )
    })

    it('正: 閉じているはずの窓が窓の長さ ＋ 5 秒を過ぎても開いていれば、そのセンサーの波形が届いていないと名指す', () => {
      // s2 は 64 秒に始まった窓が 94 秒に閉じるはずで、99 秒を過ぎても開いたまま（パケットが止まっている）。
      // 名指さないと、閉じる時刻が過去に残って「まもなく数える」と取り直しを繰り返す。
      const sources = [
        { sensorId: 's1', source: source({ fromMs: 90_000, still: true }, 60_000) },
        { sensorId: 's2', source: source({ fromMs: 64_000, still: true }, 34_000) },
      ]
      expect(placementText('not-counted', sources, clock)).toBe('いまの置き方: センサー s2 の波形が届いていない')
      expect(describePlacement('not-counted', sources, clock)?.due).toBe(false)
      // 閉じていないセンサーでも同じ（still が null のまま止まった形）。
      expect(placementText('not-counted', one({ fromMs: 60_000, still: null }), clock)).toBe(
        'いまの置き方: センサー s1 の波形が届いていない',
      )
    })

    it('対照: 窓の長さ ＋ 5 秒ちょうどまでは止まったとみなさない（閉じる直前のパケット待ち）', () => {
      expect(placementText('not-counted', one({ fromMs: 65_000, still: true }), clock)).toBe('いまの置き方: まもなく数える')
    })

    it('対照: 止まったかは応答を作った時点で見る（取り直しが遅れただけなら、名指さずに取り直す）', () => {
      // 応答は 90 秒のもの（そのとき窓は 20 秒目）。手元で 20 秒進めた 110 秒では長さ ＋ 5 秒も過ぎているが、
      // ホストではもう閉じて次の窓へ進んでいる。届いていないとは言わず、取り直しの合図を立てる。
      const late = { nowMs: 110_000, sampledAtMs: 90_000, windowMs: 30_000 }
      expect(describePlacement('not-counted', one({ fromMs: 70_000, still: true }), late)).toEqual({
        text: 'いまの置き方: まもなく数える',
        due: true,
      })
    })

    it('安全弁: 全員の静止した窓がもう閉じているのに数えていなければ、全員の溜めかけの窓が閉じるまでを数える', () => {
      // 境目の取り合わせで、まだ重なっていない形（届き続けているセンサーだけ）。s1 は 120 秒、s2 は 125 秒に閉じる。
      const sources = [
        { sensorId: 's1', source: source({ fromMs: 90_000, still: true }, 60_000) },
        { sensorId: 's2', source: source({ fromMs: 95_000, still: true }, 80_000) },
      ]
      expect(placementText('not-counted', sources, clock)).toBe(
        'いまの置き方: このまま動かさなければ、あと 25 秒で 1 姿勢として数える',
      )
      expect(describePlacement('not-counted', sources, clock)?.due).toBe(false)
    })

    it('安全弁: センサーが 1 つも無ければ行を出さない（「まもなく数える」で取り直し続けない）', () => {
      expect(describePlacement('not-counted', [], clock)).toBeNull()
    })

    it('安全弁: 0 秒を過ぎて取り直すまでは「まもなく数える」', () => {
      expect(placementText('not-counted', one({ fromMs: 68_000, still: true }), clock)).toBe('いまの置き方: まもなく数える')
      // 0 を過ぎたときだけ取り直しの合図を立てる（10 秒ごとの取り直しを待たせない）。
      expect(describePlacement('not-counted', one({ fromMs: 68_000, still: true }), clock)?.due).toBe(true)
      expect(describePlacement('not-counted', one({ fromMs: 93_000, still: true }), clock)?.due).toBe(false)
    })

    it('正: 数えたら、新しい向きか測った向きと同じかで言い分ける', () => {
      const fresh = one({ fromMs: 90_000, still: true }, 60_000)
      expect(placementText('counted-new', fresh, clock)).toBe('いまの置き方: 数えた。次の向きへ置き換えてよい')
      expect(placementText('counted-same', fresh, clock)).toBe(
        'いまの置き方: 数えたが、測った向きと同じ（姿勢は増えない）。違う向きへ置くこと',
      )
    })

    it('安全弁: 数えた直後に波形が止まったら、数えたことより先に止まったセンサーを名指す', () => {
      // 数えたのは s1 の窓が 64 秒に始まる前。その窓は 99 秒を過ぎても開いたまま（パケットが止まっている）。
      // 後に回すと、ホストが窓を手放す 60 秒まで「次の向きへ置き換えてよい」が出続ける。
      expect(placementText('counted-new', one({ fromMs: 64_000, still: true }, 34_000), clock)).toBe(
        'いまの置き方: センサー s1 の波形が届いていない',
      )
      expect(placementText('counted-same', one(null), clock)).toBe('いまの置き方: センサー s1 の波形が届いていない')
    })

    it('安全弁: 波形が届いていないセンサーがあれば、そのセンサーを名指す', () => {
      expect(placementText('not-counted', [{ sensorId: 's1', source: null }], clock)).toBe(
        'いまの置き方: センサー s1 の波形が届いていない',
      )
      expect(placementText('not-counted', one(null), clock)).toBe('いまの置き方: センサー s1 の波形が届いていない')
    })

    it('安全弁: 前の版のホスト（時計が無い）なら行を出さない', () => {
      expect(placementText('counted-new', one({ fromMs: 0, still: true }), null)).toBeNull()
    })
  })

  it('押せない理由（10 通り）', () => {
    expect(sixFaceProblem(refused({ reason: 'directions-biased' }))).toBe(
      '斜めの置き方が同じ向きに偏っている。違う向きに斜めに置くこと',
    )
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
