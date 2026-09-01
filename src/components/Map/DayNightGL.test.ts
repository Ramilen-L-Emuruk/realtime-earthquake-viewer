import { describe, it, expect } from 'vitest'
import { createExpression } from '@maplibre/maplibre-gl-style-spec'
import { opacityExpression } from './DayNightGL'
import { SHADOW_STEPS } from '../../utils/solarTerminator'

// 濃さは MapLibre の式として渡すので、JS で書き直した近似ではなく**その式そのもの**を評価する。
// 書き直すと、式を直したのにテストだけ古い計算のまま通り続ける。
function evaluateOpacity(nightOpacity: number, totalSteps: number, depth?: number): number {
  const compiled = createExpression(opacityExpression(nightOpacity, totalSteps), 'fill-opacity')
  if (compiled.result !== 'success') throw new Error(String(compiled.value))
  return compiled.value.evaluate(
    { zoom: 5 },
    { type: 'Polygon', properties: depth === undefined ? {} : { depth } },
  )
}

describe('opacityExpression', () => {
  it('最も内側の帯は設定どおりの濃さになる', () => {
    for (const nightOpacity of [0.2, 0.5, 0.7, 0.95]) {
      expect(evaluateOpacity(nightOpacity, SHADOW_STEPS, SHADOW_STEPS)).toBeCloseTo(nightOpacity, 10)
    }
  })

  it('最も外側の帯は、段を 1 枚重ねたぶんの濃さになる（重ね塗りだった頃と同じ濃さの付き方）', () => {
    for (const nightOpacity of [0.2, 0.5, 0.7, 0.95]) {
      const oneLayer = 1 - Math.pow(1 - nightOpacity, 1 / SHADOW_STEPS)
      expect(evaluateOpacity(nightOpacity, SHADOW_STEPS, 1)).toBeCloseTo(oneLayer, 10)
    }
  })

  it('途中の帯は、その深さまで重ねたぶんの濃さになる', () => {
    for (const depth of [2, 8, 16, 31]) {
      const stacked = 1 - Math.pow(1 - 0.7, depth / SHADOW_STEPS)
      expect(evaluateOpacity(0.7, SHADOW_STEPS, depth)).toBeCloseTo(stacked, 10)
    }
  })

  it('深さが外側から内側へ単調に濃くなる', () => {
    let previous = -1
    for (let depth = 1; depth <= SHADOW_STEPS; depth++) {
      const value = evaluateOpacity(0.7, SHADOW_STEPS, depth)
      expect(value).toBeGreaterThan(previous)
      previous = value
    }
  })

  it('段数を変えても、最も内側の帯の濃さは設定値のまま変わらない', () => {
    for (const steps of [4, 8, 32, 64]) {
      expect(evaluateOpacity(0.7, steps, steps)).toBeCloseTo(0.7, 10)
    }
  })

  // 安全弁。`depth` が無い feature を混ぜると MapLibre は式の評価に失敗し、そのプロパティの
  // 既定値へ落ちる。`fill-opacity` の既定は 1（＝真っ黒な不透明の板）なので、そちらへ倒れて
  // いないことを確かめる。
  it('深さを持たない feature では、濃くなる側ではなく透明へ倒れる', () => {
    expect(evaluateOpacity(0.7, SHADOW_STEPS, undefined)).toBe(0)
    expect(evaluateOpacity(0.95, SHADOW_STEPS, undefined)).toBe(0)
  })
})
