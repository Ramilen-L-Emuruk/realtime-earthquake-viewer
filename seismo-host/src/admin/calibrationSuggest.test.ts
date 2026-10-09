import { describe, expect, it } from 'vitest'

import { legacyAxes } from '../receiver/calibration'
import { multiplyMatVec3 } from '../receiver/matrix3'
import { defaultSensorCalibration, IDENTITY_MATRIX } from '../receiver/stationConfigTypes'
import type { Mat3, SensorCalibration, Vec3 } from '../receiver/stationConfigTypes'
import {
  boardGravityForTilt,
  multiplyMat3,
  NO_STILL_THREE_AXIS,
  NO_STILL_WINDOW,
  stillMeanGal,
  suggestRotation,
} from './calibrationSuggest'
import type { TiltSource } from './calibrationSuggest'

const G = 980.665

/** 行列をベクトルへ適用する。**提案が本当に鉛直を向かせるかを確かめる手。** */
function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ]
}

/**
 * その回転を設定したとき、1 本目の軸が指す方位（度・真北から時計回り。東＝90）。
 *
 * 行列の第 1 列が、センサーの 1 本目の軸が共通座標（ENU）でどこを向くか。
 * 東成分と北成分を `atan2` へこの順で渡すと、そのまま方位になる。
 */
function bearingOf(m: Mat3): number {
  const deg = (Math.atan2(m[0][0], m[1][0]) * 180) / Math.PI
  return deg < 0 ? deg + 360 : deg
}

/** 傾いて据えた基板が測る重力。上下軸を Y の向きへ `deg` 度倒したもの。 */
function tilted(deg: number): Vec3 {
  const rad = (deg * Math.PI) / 180
  return [0, G * Math.sin(rad), G * Math.cos(rad)]
}

/** 提案を受け取る（拒否されたら投げる）。 */
function suggest(input: Parameters<typeof suggestRotation>[0]): {
  rotation: Mat3
  tiltDeg: number
  upsideDown: boolean
} {
  const got = suggestRotation(input)
  if (!got.ok) throw new Error(`提案されなかった: ${got.reason}`)
  return got
}

describe('suggestRotation', () => {
  it('既に真上を向いていれば、いまの回転をそのまま返す', () => {
    const got = suggest({ gravity: [0, 0, G], rotation: IDENTITY_MATRIX, headingDeg: null })

    expect(got.tiltDeg).toBe(0)
    expect(got.upsideDown).toBe(false)
    expect(got.rotation).toEqual(IDENTITY_MATRIX)
  })

  it('傾いた基板は、提案どおりに設定すれば重力が真上を向く', () => {
    // **これが本題。** 提案した行列を、そのセンサーが生で出している値へ適用すると
    // 鉛直になる——`rotation` が単位行列なので、測った重力がそのまま生の値。
    const gravity = tilted(15)

    const got = suggest({ gravity, rotation: IDENTITY_MATRIX, headingDeg: null })

    expect(got.tiltDeg).toBe(15)
    const fixed = apply(got.rotation, gravity)
    expect(fixed[0]).toBeCloseTo(0, 3)
    expect(fixed[1]).toBeCloseTo(0, 3)
    expect(fixed[2]).toBeCloseTo(G, 3)
  })

  it('既に回転を設定してあっても、生の値から鉛直へ行く', () => {
    // **追加の回転をいまの設定へ左から掛けている**ことの確認。測った重力は
    // 校正適用後の値なので、生の値は `現在の回転 × 生 ＝ 測った値` の関係にある。
    const current: Mat3 = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ] // 上向き軸まわりに 90 度
    const raw = tilted(20)
    const measured = apply(current, raw)

    const got = suggest({ gravity: measured, rotation: current, headingDeg: null })

    expect(got.tiltDeg).toBe(20)
    const fixed = apply(got.rotation, raw)
    expect(fixed[0]).toBeCloseTo(0, 3)
    expect(fixed[1]).toBeCloseTo(0, 3)
    expect(fixed[2]).toBeCloseTo(G, 3)
  })

  it('上下逆さまなら印を立て、それでも鉛直へ向ける', () => {
    const gravity: Vec3 = [0, 0, -G]

    const got = suggest({ gravity, rotation: IDENTITY_MATRIX, headingDeg: null })

    expect(got.upsideDown).toBe(true)
    expect(got.tiltDeg).toBe(180)
    expect(apply(got.rotation, gravity)[2]).toBeCloseTo(G, 3)
  })

  it('方角を入れなければ、水平面は一切回さない', () => {
    // **重力は方角について何も語らない。** 既定値で回すと、合っていた方角を
    // 黙って崩す——この対照が無いと、既定値を入れる変更に誰も気づけない。
    const got = suggest({ gravity: [0, 0, G], rotation: IDENTITY_MATRIX, headingDeg: null })

    expect(got.rotation).toEqual(IDENTITY_MATRIX)
  })

  it('1 本目の軸が東を向いているなら（90 度）、水平面は回らない', () => {
    // 共通座標の X が東なので、90 は「ずれていない」を意味する。
    const got = suggest({ gravity: [0, 0, G], rotation: IDENTITY_MATRIX, headingDeg: 90 })

    expect(got.rotation).toEqual(IDENTITY_MATRIX)
  })

  it('1 本目の軸が北を向いているなら（0 度）、その軸を北（Y）へ移す', () => {
    const got = suggest({ gravity: [0, 0, G], rotation: IDENTITY_MATRIX, headingDeg: 0 })

    // センサーの 1 本目（北を向いている）が共通座標の Y＝北へ行く。
    const north = apply(got.rotation, [1, 0, 0])
    expect(north[0]).toBeCloseTo(0, 6)
    expect(north[1]).toBeCloseTo(1, 6)
    // 2 本目は東から 90 度反時計回り＝北なので、共通座標では西（X の負）へ。
    const second = apply(got.rotation, [0, 1, 0])
    expect(second[0]).toBeCloseTo(-1, 6)
    expect(second[1]).toBeCloseTo(0, 6)
  })

  it('鉛直を合わせてから方角を回す（順序が逆だと両方ずれる）', () => {
    const gravity = tilted(25)

    const got = suggest({ gravity, rotation: IDENTITY_MATRIX, headingDeg: 210 })

    // 方角をどう回しても鉛直は保たれる——上向き軸まわりの回転だから。
    const fixed = apply(got.rotation, gravity)
    expect(fixed[0]).toBeCloseTo(0, 3)
    expect(fixed[1]).toBeCloseTo(0, 3)
    expect(fixed[2]).toBeCloseTo(G, 3)
  })

  it('もう一度かけても、ほとんど何も足さない（収束する）', () => {
    // **提案を適用した後にボタンをもう一度押しても暴れない**ことの確認。
    const raw = tilted(12)
    const first = suggest({ gravity: raw, rotation: IDENTITY_MATRIX, headingDeg: null })

    const measured = apply(first.rotation, raw)
    const second = suggest({ gravity: measured, rotation: first.rotation, headingDeg: null })

    expect(second.tiltDeg).toBe(0)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(second.rotation[i][j]).toBeCloseTo(first.rotation[i][j], 5)
      }
    }
  })

  // **方角を入れた状態でもう一度押しても壊れないこと。** 重力から作る傾きは
  // 2 回目に単位行列へ収束するが、方角は測れないので自分では収まらない ——
  // 「いまどちらを向いているか」との差だけ回す形にしていないと、押すたびに
  // 同じ角を足し続ける（敵対的レビューが実測で再現した回帰）。
  it('方角を入れて 2 回続けて押しても、方角は動かない', () => {
    const raw = tilted(12)
    const first = suggest({ gravity: raw, rotation: IDENTITY_MATRIX, headingDeg: 30 })

    // 1 回目を適用したセンサーが、次の窓で測る重力。
    const measured = apply(first.rotation, raw)
    const second = suggest({ gravity: measured, rotation: first.rotation, headingDeg: 30 })

    expect(bearingOf(second.rotation)).toBeCloseTo(30, 3)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(second.rotation[i][j]).toBeCloseTo(first.rotation[i][j], 5)
      }
    }
  })

  it('1 回目で、1 本目の軸が指定した方角を向く', () => {
    // **対照。** 冪等にした結果「1 回目も何もしない」に化けていないことを見る。
    for (const heading of [0, 30, 90, 210, 359]) {
      const got = suggest({ gravity: tilted(8), rotation: IDENTITY_MATRIX, headingDeg: heading })
      expect(bearingOf(got.rotation)).toBeCloseTo(heading, 3)
    }
  })

  it('方角を変えて押し直せば、新しい方角へ向く', () => {
    // **安全弁。** 冪等にしたせいで「2 回目以降は何を入れても効かない」に
    // なっていないこと。
    const raw = tilted(12)
    const first = suggest({ gravity: raw, rotation: IDENTITY_MATRIX, headingDeg: 30 })
    const measured = apply(first.rotation, raw)

    const second = suggest({ gravity: measured, rotation: first.rotation, headingDeg: 200 })

    expect(bearingOf(second.rotation)).toBeCloseTo(200, 3)
  })

  it('1 本目の軸が真上を向いていると、方角を決められないので提案しない', () => {
    // 基板を垂直に立てた状態。水平面での向きが定まらない。
    const standing: Mat3 = [
      [0, 0, 1],
      [0, 1, 0],
      [-1, 0, 0],
    ]
    const got = suggestRotation({ gravity: [0, 0, G], rotation: standing, headingDeg: 30 })

    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('方角')
  })

  it('重力が小さすぎるときは提案しない', () => {
    // 倍率が 1000 分の 1 に狂っている窓。**向きではなく倍率の問題**なので、
    // ここで「回せば直る」形の提案を出すと、狂いを回転へ塗り込むことになる。
    const got = suggestRotation({
      gravity: [0, 0, 0.98],
      rotation: IDENTITY_MATRIX,
      headingDeg: null,
    })

    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('倍率')
  })

  it('数として読めない入力では提案しない', () => {
    expect(
      suggestRotation({
        gravity: [Number.NaN, 0, G],
        rotation: IDENTITY_MATRIX,
        headingDeg: null,
      }).ok,
    ).toBe(false)
    expect(
      suggestRotation({ gravity: [0, 0, G], rotation: IDENTITY_MATRIX, headingDeg: Number.NaN })
        .ok,
    ).toBe(false)
    const brokenRotation = [
      [Number.NaN, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as unknown as Mat3
    expect(
      suggestRotation({ gravity: [0, 0, G], rotation: brokenRotation, headingDeg: null }).ok,
    ).toBe(false)
  })

  it('-0 を書き出さない（設定ファイルを読む人が値を疑う）', () => {
    const got = suggest({ gravity: tilted(30), rotation: IDENTITY_MATRIX, headingDeg: null })

    for (const row of got.rotation) {
      for (const v of row) expect(Object.is(v, -0)).toBe(false)
    }
  })
})

describe('multiplyMat3', () => {
  it('単位行列を掛けても変わらない', () => {
    const m: Mat3 = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]

    expect(multiplyMat3(m, IDENTITY_MATRIX)).toEqual(m)
    expect(multiplyMat3(IDENTITY_MATRIX, m)).toEqual(m)
  })

  it('順序が意味を持つ（先に右、次に左）', () => {
    // 上向き軸まわり 90 度 → 東向き軸まわり 90 度、の順で掛ける。
    const up90: Mat3 = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]
    const east90: Mat3 = [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ]

    expect(multiplyMat3(east90, up90)).not.toEqual(multiplyMat3(up90, east90))
  })
})

describe('「鉛直を合わせる」の材料（校正前の静止窓 → カードの軸の向きを通した、基板の座標の重力）', () => {
  const still = (meanGal: Vec3): TiltSource => ({ stillSinceMs: 0, windows: [{ atMs: 1, meanGal, sampleCount: 3000 }] })
  const UNIT3: SensorCalibration = defaultSensorCalibration(3)

  it('正: いまの静止が始まった後の窓を、サンプル数で重み付けして平均する', () => {
    const got = stillMeanGal({
      stillSinceMs: 100,
      windows: [
        { atMs: 130, meanGal: [0, 0, 970], sampleCount: 1000 },
        { atMs: 160, meanGal: [0, 0, 990], sampleCount: 3000 },
      ],
    })
    expect(got.ok && got.meanGal[2]).toBeCloseTo(985, 9)
  })

  it('対照: 静止の始まり以前に閉じた窓（前の置き方）は混ぜない', () => {
    const got = stillMeanGal({
      stillSinceMs: 100,
      windows: [
        { atMs: 100, meanGal: [G, 0, 0], sampleCount: 3000 },
        { atMs: 130, meanGal: [0, 0, G], sampleCount: 3000 },
      ],
    })
    expect(got.ok && got.meanGal).toEqual([0, 0, G])
  })

  it('安全弁: いま静止していない・窓が無い・いまの置き方の窓がまだ閉じていないなら理由を返す', () => {
    const w = { atMs: 50, meanGal: [0, 0, G] as Vec3, sampleCount: 3000 }
    expect(stillMeanGal(null)).toEqual({ ok: false, reason: NO_STILL_WINDOW })
    expect(stillMeanGal({ stillSinceMs: null, windows: [w] })).toEqual({ ok: false, reason: NO_STILL_WINDOW })
    expect(stillMeanGal({ stillSinceMs: 100, windows: [w] })).toEqual({ ok: false, reason: NO_STILL_WINDOW })
  })

  it('正: ゼロ点を引き、軸の測る向きを解いて、基板の座標の重力を返す（横倒しに付けたセンサー）', () => {
    // 軸 1 が基板の Z を、軸 3 が基板の X を測る。軸 1 は 1 gal の揺れで 500/G gal 読む。
    const sensor: SensorCalibration = {
      enabled: true,
      noiseDensity: null,
      axes: [
        { vector: [0, 0, 500 / G], offset: 100 },
        { vector: [0, 1, 0], offset: 0 },
        { vector: [1, 0, 0], offset: 0 },
      ],
    }
    const got = boardGravityForTilt([{ source: still([500 + 100, 0, 0]), sensor }])
    if (!got.ok) throw new Error(got.reason)
    expect(got.gravity[2]).toBeCloseTo(G, 9)
    expect(got.gravity[0]).toBeCloseTo(0, 9)
  })

  it('正: 旧形式（回転・感度）から読み替えた軸でも、同じ重力になる', () => {
    const swapXZ: Mat3 = [
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ]
    const axes = legacyAxes(swapXZ, [G / 500, 1, 1], [100, 0, 0])
    if (axes === null) throw new Error('読み替えられなかった')
    const got = boardGravityForTilt([{ source: still([500 + 100, 0, 0]), sensor: { ...UNIT3, axes } }])
    expect(got.ok && got.gravity[2]).toBeCloseTo(G, 9)
  })

  // **回帰（2026-10-04 実機）:** 出した向きをカードへ入れて同じ材料でもう一度出すと、
  // 傾きは 0 になり向きは変わらない。前は向きを二重に掛けて約 140 度ずれた。いまは材料が
  // 基板の座標なので、地面の座標へ移すのは呼ぶ側（いまの基板の向きを掛ける）。
  it('正: 出した向きを基板へ入れてもう一度押すと、傾き 0° で同じ向きのまま', () => {
    const got = boardGravityForTilt([{ source: still(tilted(15)), sensor: UNIT3 }])
    if (!got.ok) throw new Error(got.reason)
    const r1 = suggestRotation({ gravity: multiplyMatVec3(IDENTITY_MATRIX, got.gravity), rotation: IDENTITY_MATRIX, headingDeg: null })
    if (!r1.ok) throw new Error(r1.reason)

    const r2 = suggestRotation({ gravity: multiplyMatVec3(r1.rotation, got.gravity), rotation: r1.rotation, headingDeg: null })
    if (!r2.ok) throw new Error(r2.reason)
    expect(r2.tiltDeg).toBe(0)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) expect(r2.rotation[i][j]).toBeCloseTo(r1.rotation[i][j], 5)
    }
  })

  it('正: 静止している 3 軸のセンサーが複数あれば、基板の座標で平均する', () => {
    const got = boardGravityForTilt([
      { source: still([0, 0, 970]), sensor: UNIT3 },
      { source: still([0, 0, 990]), sensor: UNIT3 },
    ])
    expect(got.ok && got.gravity).toEqual([0, 0, 980])
  })

  it('対照: 2 軸のセンサーと、いま静止していない 3 軸のセンサーは混ぜない', () => {
    const got = boardGravityForTilt([
      { source: still([0, 0, 970]), sensor: UNIT3 },
      { source: still([5000, 5000, 5000]), sensor: defaultSensorCalibration(2) },
      { source: { stillSinceMs: null, windows: [] }, sensor: UNIT3 },
      { source: null, sensor: UNIT3 },
    ])
    expect(got.ok && got.gravity).toEqual([0, 0, 970])
  })

  it('安全弁: 静止している 3 軸のセンサーが 1 つも無ければ理由を返す（2 軸だけでは重力の 3 成分が決まらない）', () => {
    expect(boardGravityForTilt([])).toEqual({ ok: false, reason: NO_STILL_THREE_AXIS })
    expect(boardGravityForTilt([{ source: still([0, 0, G]), sensor: defaultSensorCalibration(2) }])).toEqual({
      ok: false,
      reason: NO_STILL_THREE_AXIS,
    })
    expect(boardGravityForTilt([{ source: null, sensor: UNIT3 }])).toEqual({ ok: false, reason: NO_STILL_THREE_AXIS })
  })

  it('安全弁: 軸の向きが 1 つの面に寄っていて解けないなら、向きを出さない', () => {
    const flat: SensorCalibration = {
      ...UNIT3,
      axes: [
        { vector: [1, 0, 0], offset: 0 },
        { vector: [0, 1, 0], offset: 0 },
        { vector: [1, 1, 0], offset: 0 },
      ],
    }
    expect(boardGravityForTilt([{ source: still([0, 0, G]), sensor: flat }])).toEqual({
      ok: false,
      reason: '軸の向きが解けない形になっている',
    })
  })

  it('安全弁: 軸の向きの長さ（倍率）が狂っていて重力の大きさが 1 g から 3 倍以上離れたら、向きを出さない', () => {
    // 旧形式の感度 0.3 は、軸の向きの長さ 1/0.3 にあたる。
    const withZLength = (length: number): SensorCalibration => ({
      ...UNIT3,
      axes: [
        { vector: [1, 0, 0], offset: 0 },
        { vector: [0, 1, 0], offset: 0 },
        { vector: [0, 0, length], offset: 0 },
      ],
    })
    expect(boardGravityForTilt([{ source: still([0, 0, G]), sensor: withZLength(1 / 0.3) }])).toEqual({
      ok: false,
      reason: '換算の倍率が合っていない。先にそちらを確かめること',
    })
    // 対照: 3 分の 1 の手前なら出す。
    expect(boardGravityForTilt([{ source: still([0, 0, G]), sensor: withZLength(1 / 0.34) }]).ok).toBe(true)
  })
})
