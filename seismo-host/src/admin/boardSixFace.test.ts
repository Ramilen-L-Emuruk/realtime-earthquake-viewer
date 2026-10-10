import { describe, expect, it } from 'vitest'

import { GAL_PER_G } from '../intensity/units'
import { directionsSpread, fitBoardSixFace, fitBoardSixFaceWith, minPosesFor } from './boardSixFace'
import type { BoardFitSensor, BoardFitWindow } from './boardSixFace'
import type { AxisCalibration, Vec3 } from '../receiver/stationConfigTypes'

/** 単位ベクトルへ。 */
function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2])
  return [v[0] / n, v[1] / n, v[2] / n]
}

/** 真の軸 1 本（基板の座標・長さが倍率）とゼロ点（gal）。 */
interface TrueAxis {
  readonly vector: Vec3
  readonly offset: number
}

/** 真の軸が、基板の座標で向き `dir` に 1 g 掛かったときに読む値（校正前・gal）。 */
function reads(axis: TrueAxis, dir: Vec3): number {
  const u = unit(dir)
  return GAL_PER_G * (axis.vector[0] * u[0] + axis.vector[1] * u[1] + axis.vector[2] * u[2]) + axis.offset
}

/** 6 面ぶん。**わざと数度ずつ傾けて置く**（机の上に手で置いた形）。 */
const SIX: readonly Vec3[] = [
  [1, 0.03, -0.02],
  [-1, 0.02, 0.04],
  [0.05, 1, 0.01],
  [-0.03, -1, 0.02],
  [0.02, -0.04, 1],
  [0.01, 0.03, -1],
]

/** 斜めに置いた姿勢（辺で立てた形）。 */
const OBLIQUE: readonly Vec3[] = [
  [1, 1, 0.02],
  [0.03, 1, 1],
  [1, -0.02, -1],
  [-1, 1, 1],
]

const T0 = 1_700_000_000_000
const WINDOW_MS = 30_000

/**
 * 姿勢ごとに 3 窓ずつ静止させた窓の列。姿勢の間（置き換え）は窓が無い。
 * `shiftMs` でセンサーごとに窓の区切りをずらす（同じ基板でも窓の区切りは揃っていない）。
 */
function windowsFor(axes: readonly TrueAxis[], dirs: readonly Vec3[], shiftMs = 0): BoardFitWindow[] {
  const out: BoardFitWindow[] = []
  dirs.forEach((d, k) => {
    const start = T0 + k * 150_000 + shiftMs
    for (let w = 0; w < 3; w++) {
      out.push({
        fromMs: start + w * WINDOW_MS,
        atMs: start + (w + 1) * WINDOW_MS,
        sampleCount: 3000,
        meanGal: axes.map((a) => reads(a, d)),
      })
    }
  })
  return out
}

function prior(vectors: readonly Vec3[]): AxisCalibration[] {
  return vectors.map((vector) => ({ vector, offset: 0 }))
}

// IIS2ICLX 3 個の基板（水平 1・立てて 90° 回した 2）。**真の値は直角から少しずつずらしてある**
// （チップの中の軸どうし・ステーの角度とも）。基板の座標は 1 個目のセンサーの 1 本目を X、
// 2 本目を XY 面に置いた形なので、1 個目の 1 本目は Y・Z を、2 本目は Z を持たない。
const IIS: readonly (readonly TrueAxis[])[] = [
  [
    { vector: [1.01, 0, 0], offset: 12 },
    { vector: [0.012, 0.99, 0], offset: -8 },
  ],
  [
    { vector: [0.98, 0.02, 0.05], offset: -20 },
    { vector: [0.04, -0.03, 1.02], offset: 35 },
  ],
  [
    { vector: [0.03, 1.0, -0.02], offset: 5 },
    { vector: [-0.05, 0.02, 0.99], offset: -15 },
  ],
]

/** カードに入れる大まかな向き（ステーの設計どおり）。 */
const IIS_PRIOR: readonly (readonly Vec3[])[] = [
  [
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [1, 0, 0],
    [0, 0, 1],
  ],
  [
    [0, 1, 0],
    [0, 0, 1],
  ],
]

function iisBoard(dirs: readonly Vec3[], priors: readonly (readonly Vec3[])[] = IIS_PRIOR): BoardFitSensor[] {
  return IIS.map((axes, i) => ({
    sensorId: `s${i}`,
    prior: prior(priors[i]!),
    windows: windowsFor(axes, dirs, i * 10_000),
  }))
}

// 3 軸のセンサー 1 個（MPU6050 の基板）。軸どうしは 1 度ほど直角からずれ、Z のゼロ点が大きくずれている。
const MPU: readonly TrueAxis[] = [
  { vector: [0.98, 0, 0], offset: -82 },
  { vector: [0.017, 1.02, 0], offset: 5 },
  { vector: [-0.012, 0.02, 0.99], offset: -315 },
]
const MPU_PRIOR: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

function mpuBoard(dirs: readonly Vec3[], priorVectors: readonly Vec3[] = MPU_PRIOR): BoardFitSensor[] {
  return [{ sensorId: 'i2c0-68', prior: prior(priorVectors), windows: windowsFor(MPU, dirs) }]
}

function expectAxes(got: readonly AxisCalibration[], want: readonly TrueAxis[]): void {
  expect(got).toHaveLength(want.length)
  got.forEach((a, j) => {
    for (const k of [0, 1, 2]) expect(a.vector[k]).toBeCloseTo(want[j]!.vector[k]!, 6)
    expect(a.offset).toBeCloseTo(want[j]!.offset, 4)
  })
}

describe('minPosesFor（要る姿勢の数）', () => {
  it('軸の本数に依らず 6 面と斜め 3 回の 9 を下回らない', () => {
    expect(minPosesFor(3)).toBe(9)
    expect(minPosesFor(4)).toBe(9)
    expect(minPosesFor(6)).toBe(9)
    expect(minPosesFor(9)).toBe(9)
    expect(minPosesFor(2)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('directionsSpread（置いた向きの散り具合）', () => {
  const dirs = (vs: readonly Vec3[]) => vs.map(unit)
  it('正: 6 面に違う向きの斜めを 3 回足せば散っている', () => {
    expect(directionsSpread(dirs([...SIX, ...OBLIQUE.slice(0, 3)]))).toBeGreaterThan(0.1)
  })
  // 対照: 6 面は X・Y・Z とその裏返しで、向きを歪める変換の 3 つの自由度が残る。
  it('対照: 6 面だけ・斜めが 2 回だけでは散っていない', () => {
    expect(directionsSpread(dirs(SIX))).toBeLessThan(1e-3)
    expect(directionsSpread(dirs([...SIX, ...OBLIQUE.slice(0, 2)]))).toBeLessThan(1e-3)
  })
  it('安全弁: 斜めを 3 回足しても、同じ面の中に偏っていれば散っていない', () => {
    expect(directionsSpread(dirs([...SIX, [1, 1, 0.02], [1, -1, 0.01], [-1, 1, 0.02]]))).toBeLessThan(1e-3)
  })
})

describe('fitBoardSixFace', () => {
  it('正: IIS2ICLX 3 個の基板で、全部の軸の向き・倍率・ゼロ点を一緒に戻す（直角からのずれも）', () => {
    const r = fitBoardSixFace(iisBoard([...SIX, ...OBLIQUE]))
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    r.sensors.forEach((s, i) => {
      expect(s.sensorId).toBe(`s${i}`)
      expectAxes(s.axes, IIS[i]!)
    })
    expect(r.faces).toEqual({ '+x': true, '-x': true, '+y': true, '-y': true, '+z': true, '-z': true })
    expect(r.poseCount).toBe(10)
    expect(r.minPoses).toBe(9)
    expect(r.maxResidualGal).not.toBeNull()
    expect(r.maxResidualGal!).toBeLessThan(1e-3)
  })

  // 対照: 軸が多くても、6 面だけでは向きを歪める変換が残る（式の数は足りていても定まらない）。
  it('対照: IIS2ICLX 3 個でも 6 面だけなら、姿勢が足りないとして断る（6／9）', () => {
    const r = fitBoardSixFace(iisBoard(SIX))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('too-few-poses')
    expect(r.poseCount).toBe(6)
    expect(r.minPoses).toBe(9)
  })

  it('安全弁: 9 姿勢あっても、斜めの置き方が同じ面の中に偏っていれば解けないとして断る', () => {
    const r = fitBoardSixFace(iisBoard([...SIX, [1, 1, 0.02], [1, -1, 0.01], [-1, 1, 0.02]]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('degenerate')
    expect(r.poseCount).toBe(9)
  })

  // 正（2026-10-10 ユーザー承認: 軸を 1 本ずつ自由に解く）: 3 軸のセンサーの軸どうしの直角のずれも戻す。
  // 前の 6 面法（センサーごと）は直交と見なしていたので、ここは戻せなかった。
  it('正: 3 軸のセンサー 1 個でも、9 姿勢あれば直角のずれごと戻す', () => {
    const r = fitBoardSixFace(mpuBoard([...SIX, ...OBLIQUE.slice(0, 3)]))
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expectAxes(r.sensors[0]!.axes, MPU)
    // 9 姿勢ちょうどでは未知数と式の数が同じなので、必ずぴったり解けて検算にならない。
    expect(r.maxResidualGal).toBeNull()
  })

  it('正: 3 軸のセンサー 1 個で 10 姿勢あれば残差が出る', () => {
    const r = fitBoardSixFace(mpuBoard([...SIX, ...OBLIQUE]))
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expect(r.maxResidualGal).not.toBeNull()
    expect(r.maxResidualGal!).toBeLessThan(1e-3)
  })

  // 対照: 6 面だけでは 3 軸のセンサー 1 個の未知数（9）に式が足りない。
  it('対照: 3 軸のセンサー 1 個で 6 面だけなら、姿勢が足りないとして断る（6／9）', () => {
    const r = fitBoardSixFace(mpuBoard(SIX))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('too-few-poses')
    expect(r.poseCount).toBe(6)
    expect(r.minPoses).toBe(9)
    expect(r.faces['-z']).toBe(true)
  })

  it('正: 同じ面へ置き直した姿勢は 1 つにまとめて数える', () => {
    const r = fitBoardSixFace(iisBoard([...SIX, ...OBLIQUE.slice(0, 3), SIX[0]!, SIX[4]!]))
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expect(r.poseCount).toBe(9)
    // 数えるのは 9 でも、置き直した 2 回も式を足すので検算が付く（解くのは区間ごと）。
    expect(r.maxResidualGal).not.toBeNull()
    expect(r.maxResidualGal).toBeLessThan(1e-6)
  })

  // 安全弁: 同じ向きに何度置き直しても（区間が増えても）、解いた値は変わらない。
  it('安全弁: 同じ面へ何度置き直しても、真値を戻す', () => {
    const r = fitBoardSixFace(iisBoard([...SIX, ...OBLIQUE, SIX[0]!, SIX[0]!, SIX[4]!, SIX[4]!]))
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expect(r.poseCount).toBe(10)
    r.sensors.forEach((s, i) => expectAxes(s.axes, IIS[i]!))
  })

  // 安全弁: まとめ方は置いた順に依らない。＋Z を挟んで両側へ 24° ずつ傾けた置き方（互いには 48° 離れる）は、
  // ＋Z を橋渡しに 1 つへまとまる。先に出来た向きへ寄せていく形だと、傾けた側を先に置くと 2 つに数えていた。
  it('安全弁: 近い置き方のまとめ方は、置いた順に依らない', () => {
    const t = (24 * Math.PI) / 180
    const east: Vec3 = [Math.sin(t), 0, Math.cos(t)]
    const west: Vec3 = [-Math.sin(t), 0, Math.cos(t)]
    const zFirst = fitBoardSixFace(iisBoard([...SIX, ...OBLIQUE, east, west]))
    const tiltFirst = fitBoardSixFace(iisBoard([east, ...SIX, ...OBLIQUE, west]))
    if (!zFirst.ok || !tiltFirst.ok) throw new Error('拒まれた')
    expect(zFirst.poseCount).toBe(10)
    expect(tiltFirst.poseCount).toBe(10)
    tiltFirst.sensors.forEach((s, i) => expectAxes(s.axes, IIS[i]!))
  })

  // 回帰（2026-10-10 管理コンソールで確認）: 6 面法を測り終えてから元の場所へ据えると、＋Z から数度傾いた
  // 置き方が 30 分の窓に残る。前は 25° 以内の区間の値を平均して 1 つの姿勢にしてから解いていたので、
  // ＋Z の面と混ざった実在しない姿勢ができ、ゼロ点が 0.5 gal ずれた（残差には 0.03 gal しか出ない）。
  it('正: 数えるときは 1 つにまとめる近い置き方も、解くときは別の姿勢として扱い、真値を戻す', () => {
    const settled: Vec3 = [Math.sin((5.4 * Math.PI) / 180), 0, Math.cos((5.4 * Math.PI) / 180)]
    const r = fitBoardSixFace(iisBoard([...SIX, ...OBLIQUE, settled]))
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expect(r.poseCount).toBe(10)
    r.sensors.forEach((s, i) => expectAxes(s.axes, IIS[i]!))
    expect(r.maxResidualGal).toBeLessThan(1e-6)
  })

  it('対照: 6 面のどれかが無ければ、揃っていない面を挙げて断る', () => {
    // 斜めの置き方も −Z の側へ傾けない（傾ければ −Z の面として数わる）。
    const r = fitBoardSixFace(iisBoard([...SIX.slice(0, 5), ...OBLIQUE.filter((d) => d[2] >= 0)]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('missing-faces')
    expect(r.faces['-z']).toBe(false)
    expect(r.faces['+z']).toBe(true)
  })

  // 安全弁: 同じ置き方かどうかは時間の重なりでしか決められない。重ならないセンサーの窓を
  // 向きの近さで勝手に組ませない（別々に置いた 2 枚の基板の窓を混ぜることになる）。
  it('安全弁: ほかのセンサーと時間が重ならないセンサーがあれば、その名前を挙げて断る', () => {
    const board = iisBoard([...SIX, ...OBLIQUE])
    const late = { ...board[2]!, windows: board[2]!.windows.map((w) => ({ ...w, fromMs: w.fromMs! + 3_600_000, atMs: w.atMs + 3_600_000 })) }
    const r = fitBoardSixFace([board[0]!, board[1]!, late])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('no-common-pose')
    expect(r.sensorId).toBe('s2')
  })

  it('対照: 窓の間に静止と言えない窓が挟まれば、続きの静止とは見なさない（間で動かした）', () => {
    // 1 個目のセンサーだけ各姿勢の 2 窓目を落とす（そこで揺れていた）。残りの窓どうしは重なるので解ける。
    const board = iisBoard([...SIX, ...OBLIQUE.slice(0, 3)])
    const holed = { ...board[0]!, windows: board[0]!.windows.filter((_, i) => i % 3 !== 1) }
    const r = fitBoardSixFace([holed, board[1]!, board[2]!])
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expect(r.poseCount).toBe(9)
  })

  it('安全弁: 始まりの時刻が無い窓（前の版のホスト）があれば断る', () => {
    const board = iisBoard([...SIX, ...OBLIQUE])
    const old = { ...board[1]!, windows: board[1]!.windows.map((w) => ({ ...w, fromMs: null })) }
    const r = fitBoardSixFace([board[0]!, old, board[2]!])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('no-window-start')
  })

  // 安全弁: 2 軸のセンサーだけの基板では、鏡に映した解とデータの上で区別が付かない。カードの
  // 大まかな向きが 3 方向へ散っていなければ、どちらの解を採るか決められない。
  it('安全弁: カードの向きが 3 方向へ散っていなければ断る（立てたセンサーが既定の X・Y のまま）', () => {
    const flat: Vec3[][] = [
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
    ]
    const r = fitBoardSixFace(iisBoard([...SIX, ...OBLIQUE], flat))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('prior-degenerate')
  })

  it('正: 2 軸のセンサーだけの基板では、面に垂直な向きの符号をカードの向きに合わせる', () => {
    // 立てた 2 個の Z を逆向きに入れると、全体を鏡に映した解（データには同じだけ合う）を採る。
    const flipped: Vec3[][] = [
      IIS_PRIOR[0]!.map((v) => [...v] as unknown as Vec3),
      [
        [1, 0, 0],
        [0, 0, -1],
      ],
      [
        [0, 1, 0],
        [0, 0, -1],
      ],
    ]
    const r = fitBoardSixFace(iisBoard([...SIX, ...OBLIQUE], flipped))
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expect(r.sensors[1]!.axes[1]!.vector[2]).toBeCloseTo(-IIS[1]![1]!.vector[2], 6)
    expect(r.sensors[2]!.axes[1]!.vector[2]).toBeCloseTo(-IIS[2]![1]!.vector[2], 6)
    expect(r.sensors[1]!.axes[0]!.offset).toBeCloseTo(IIS[1]![0]!.offset, 4)
  })

  // 安全弁: 3 軸のセンサーはチップの軸が右手系なので、カードの向きを逆に入れても鏡像を採らない。
  it('安全弁: 3 軸のセンサーがあれば、カードの Z を逆に入れても右手系の解を採る', () => {
    const r = fitBoardSixFace(
      mpuBoard(
        [...SIX, ...OBLIQUE],
        [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, -1],
        ],
      ),
    )
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expectAxes(r.sensors[0]!.axes, MPU)
  })

  // 安全弁: 式と未知数が同じ数（3 軸 1 個・9 姿勢）では検算が走らない。回数の上限で打ち切っただけの
  // 解を成功として返すと、誤った値がそのままカードへ入る。
  it('安全弁: 収束する前に回数の上限で打ち切ったら、解けなかったとして断る', () => {
    const board = mpuBoard([...SIX, ...OBLIQUE.slice(0, 3)])
    const r = fitBoardSixFaceWith(board, { warmupRounds: 0, lmMaxRounds: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('degenerate')
    // 対照: 同じ材料で上限を戻せば解ける。
    expect(fitBoardSixFaceWith(board, { warmupRounds: 30, lmMaxRounds: 200 }).ok).toBe(true)
  })

  // 安全弁: 静止の続きは 1 秒までの隙間を繋いで作る。その隙間にだけ重なる区間で投げない。
  it('安全弁: 窓の無い隙間にだけ重なる区間は捨てて、投げずに解く', () => {
    // 1 姿勢目（＋X）を最後にもう 1 回置き、1 姿勢目は隙間の区間だけになるように窓を組む。
    const dirs = [...SIX, ...OBLIQUE, SIX[0]!]
    const s0 = windowsFor(IIS[0]!, dirs, 0).map((w, i) => (i === 0 ? { ...w, atMs: w.atMs - 500 } : w)) // 29.5〜30 秒に隙間
    const s1 = windowsFor(IIS[1]!, dirs, 10_000).map((w, i) =>
      i < 3 ? { ...w, fromMs: T0 + 29_600 + i * WINDOW_MS, atMs: T0 + 29_600 + (i + 1) * WINDOW_MS } : w,
    )
    const s2 = [{ ...windowsFor(IIS[2]!, dirs, 20_000)[0]!, fromMs: T0 - 100, atMs: T0 + 29_900 }, ...windowsFor(IIS[2]!, dirs, 20_000).slice(3)]
    const board = [s0, s1, s2].map((windows, i) => ({ sensorId: `s${i}`, prior: prior(IIS_PRIOR[i]!), windows }))
    const r = fitBoardSixFace(board)
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    expect(r.poseCount).toBe(10)
    r.sensors.forEach((s, i) => expectAxes(s.axes, IIS[i]!))
  })

  it('安全弁: 1 個目のセンサーの 1 本目と 2 本目のカードの向きがほぼ平行なら、基板の座標を決められないとして断る', () => {
    const nearlyParallel: Vec3[][] = [
      [
        [1, 0, 0],
        [1, 0.05, 0],
      ],
      IIS_PRIOR[1]!.map((v) => [...v] as unknown as Vec3),
      IIS_PRIOR[2]!.map((v) => [...v] as unknown as Vec3),
    ]
    const r = fitBoardSixFace(iisBoard([...SIX, ...OBLIQUE], nearlyParallel))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('prior-degenerate')
  })

  it('対照: 揺れていた窓が混ざって辻褄が合わなければ、残差を添えて断る', () => {
    const board = iisBoard([...SIX, ...OBLIQUE])
    const bumped = {
      ...board[1]!,
      windows: board[1]!.windows.map((w, i) => (i < 3 ? { ...w, meanGal: [w.meanGal[0]! + 150, w.meanGal[1]!] } : w)),
    }
    const r = fitBoardSixFace([board[0]!, bumped, board[2]!])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('residual-too-large')
    expect(r.maxResidualGal!).toBeGreaterThan(GAL_PER_G * 0.02)
  })

  it('対照: 倍率が個体差の幅を超えていれば断る', () => {
    const tripled = IIS.map((axes) => axes.map((a) => ({ vector: a.vector.map((v) => v * 3) as unknown as Vec3, offset: a.offset })))
    const board = tripled.map((axes, i) => ({
      sensorId: `s${i}`,
      prior: prior(IIS_PRIOR[i]!),
      windows: windowsFor(axes, [...SIX, ...OBLIQUE], i * 10_000),
    }))
    const r = fitBoardSixFace(board)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('out-of-range')
  })

  // 2026-10-10 に覆した: 前は窓を捨てたまま進み、「同時に静止した置き方が無い」（no-common-pose）と
  // 断っていた。原因はカードの本数なので、本数の話として断る。
  it('安全弁: カードの軸の本数と窓の本数が合わないセンサーがあれば、本数が合わないとして断る', () => {
    const board = iisBoard([...SIX, ...OBLIQUE])
    const wrong = { ...board[2]!, windows: board[2]!.windows.map((w) => ({ ...w, meanGal: [...w.meanGal, 0] })) }
    const r = fitBoardSixFace([board[0]!, board[1]!, wrong])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('axis-count-mismatch')
    expect(r.sensorId).toBe('s2')
    expect(r.cardAxisCount).toBe(2)
    expect(r.windowAxisCount).toBe(3)
  })

  it('対照: 本数の合わない窓が一部だけなら、その窓を除いて解く', () => {
    const board = iisBoard([...SIX, ...OBLIQUE])
    const first = board[2]!.windows[0]!
    const mixed = { ...board[2]!, windows: [{ ...first, meanGal: [...first.meanGal, 0] }, ...board[2]!.windows] }
    const r = fitBoardSixFace([board[0]!, board[1]!, mixed])
    if (!r.ok) throw new Error(`拒まれた: ${r.reason}`)
    r.sensors.forEach((s, i) => expectAxes(s.axes, IIS[i]!))
  })
})
