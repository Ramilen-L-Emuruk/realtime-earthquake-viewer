import { describe, expect, it } from 'vitest'

import { DEFAULT_SENSOR_CALIBRATION } from './stationConfig'
import type { SensorCalibration } from './stationConfig'
import { applyCalibration } from './calibration'

/** 3 サンプルぶんの gal 値。軸ごとに違う値にして取り違えに気づけるようにする。 */
function gal(): readonly [readonly number[], readonly number[], readonly number[]] {
  return [
    [10, 20, 30],
    [1, 2, 3],
    [100, 200, 300],
  ]
}

function calibration(over: Partial<SensorCalibration>): SensorCalibration {
  return { ...DEFAULT_SENSOR_CALIBRATION, ...over }
}

describe('applyCalibration', () => {
  it('対照: 既定の校正値（単位行列・オフセット0・感度1）を通すと、元の値と一致する', () => {
    const input = gal()
    const out = applyCalibration(input, DEFAULT_SENSOR_CALIBRATION)
    expect(out).toEqual(input.map((axis) => [...axis]))
  })

  it('正: offset を各サンプルから引く（rotation は単位行列のまま）', () => {
    const out = applyCalibration(gal(), calibration({ offset: [5, 1, 50] }))
    expect(out[0]).toEqual([5, 15, 25])
    expect(out[1]).toEqual([0, 1, 2])
    expect(out[2]).toEqual([50, 150, 250])
  })

  it('正: sensitivity を offset 適用後の値へ掛ける', () => {
    const out = applyCalibration(gal(), calibration({ offset: [5, 0, 0], sensitivity: [2, 3, 1] }))
    // (10-5)*2=10, (20-5)*2=30, (30-5)*2=50
    expect(out[0]).toEqual([10, 30, 50])
    // 1*3=3, 2*3=6, 3*3=9
    expect(out[1]).toEqual([3, 6, 9])
    expect(out[2]).toEqual([100, 200, 300])
  })

  it('正: rotation で軸を入れ替える（offset・sensitivity は既定のまま）', () => {
    // 軸0↔軸1を入れ替える回転行列
    const swap = calibration({
      rotation: [
        [0, 1, 0],
        [1, 0, 0],
        [0, 0, 1],
      ],
    })
    const out = applyCalibration(gal(), swap)
    expect(out[0]).toEqual([1, 2, 3])
    expect(out[1]).toEqual([10, 20, 30])
    expect(out[2]).toEqual([100, 200, 300])
  })

  it('正: offset・sensitivity・rotation を組み合わせた順序（バイアス除去 → 感度 → 回転）で適用する', () => {
    // 軸0を (v - 10) * 2 したうえで、軸2へ足し込む回転（軸2' = 軸0' + 軸2）
    const combo = calibration({
      offset: [10, 0, 0],
      sensitivity: [2, 1, 1],
      rotation: [
        [1, 0, 0],
        [0, 1, 0],
        [1, 0, 1],
      ],
    })
    const out = applyCalibration(gal(), combo)
    // 軸0' = (10-10)*2=0, (20-10)*2=20, (30-10)*2=40
    expect(out[0]).toEqual([0, 20, 40])
    expect(out[1]).toEqual([1, 2, 3])
    // 軸2' = 軸0' + 軸2 = [0+100, 20+200, 40+300]
    expect(out[2]).toEqual([100, 220, 340])
  })

  it('安全弁: enabled フラグは適用結果に影響しない（呼び出し側が別途見る責務）', () => {
    const disabled = calibration({ enabled: false, offset: [5, 5, 5] })
    const enabled = calibration({ enabled: true, offset: [5, 5, 5] })
    expect(applyCalibration(gal(), disabled)).toEqual(applyCalibration(gal(), enabled))
  })

  it('安全弁: 空の入力（サンプル0件）でも例外を投げず空配列を返す', () => {
    const out = applyCalibration([[], [], []], DEFAULT_SENSOR_CALIBRATION)
    expect(out).toEqual([[], [], []])
  })
})
