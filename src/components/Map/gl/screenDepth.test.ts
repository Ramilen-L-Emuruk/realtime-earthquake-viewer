// 同じ階級のバッジを画面の手前から並べる仕組みを固定する。
// 実際の描画は WebGL なのでここでは触れない（ブラウザ確認の担当）。
// 背景と実測値は docs/spec/map-rendering-spec.md §15。
import { describe, it, expect } from 'vitest'
import {
  mercatorProps,
  frontness01,
  frontSortKeyExpression,
  bearingChangedEnough,
  BEARING_STEP_DEG,
  FRONT_WEIGHT,
  FRONT_SORTED_LAYERS,
  MERCATOR_X_PROP,
  MERCATOR_Y_PROP,
} from './screenDepth'

const front = (lng: number, lat: number, bearing: number) => {
  const p = mercatorProps(lng, lat)
  return frontness01(p[MERCATOR_X_PROP], p[MERCATOR_Y_PROP], bearing)
}

describe('mercatorProps', () => {
  it('MapLibre の MercatorCoordinate と同じ定義', () => {
    expect(mercatorProps(0, 0)[MERCATOR_X_PROP]).toBeCloseTo(0.5, 10)
    expect(mercatorProps(0, 0)[MERCATOR_Y_PROP]).toBeCloseTo(0.5, 10)
    expect(mercatorProps(180, 0)[MERCATOR_X_PROP]).toBeCloseTo(1, 10)
  })

  it('y は南ほど大きい（画面の下＝手前に対応する向き）', () => {
    expect(mercatorProps(139, 30)[MERCATOR_Y_PROP]).toBeGreaterThan(mercatorProps(139, 40)[MERCATOR_Y_PROP])
  })
})

describe('frontness01', () => {
  // 正: 方位 0（北が上）では、南にあるものほど手前。
  it('方位 0 では南ほど手前', () => {
    expect(front(139, 30, 0)).toBeGreaterThan(front(139, 40, 0))
  })

  // 方位を回すと「手前」の向きも回る。90 度（東が上）では西にあるものが手前。
  it('方位 90 では西ほど手前', () => {
    expect(front(130, 35, 90)).toBeGreaterThan(front(145, 35, 90))
  })

  it('方位 180 では北ほど手前（方位 0 の逆）', () => {
    expect(front(139, 40, 180)).toBeGreaterThan(front(139, 30, 180))
  })

  it('方位 270 では東ほど手前（方位 90 の逆）', () => {
    expect(front(145, 35, 270)).toBeGreaterThan(front(130, 35, 270))
  })

  // 安全弁: 合成キーで階級を追い越さないため、0〜1 に収まっていなければならない。
  it('つねに 0〜1 に収まる', () => {
    for (const bearing of [0, 37, 90, 180, 213, 300, 359]) {
      for (const [lng, lat] of [[-180, 85], [180, -85], [0, 0], [139, 35], [-45, -60]]) {
        const v = front(lng, lat, bearing)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('frontSortKeyExpression', () => {
  /** 式を JS で評価する（MapLibre の式インタプリタは使わず、構造をそのまま辿る）。 */
  function evaluate(expr: unknown, props: Record<string, number>): number {
    if (typeof expr === 'number') return expr
    const [op, ...args] = expr as [string, ...unknown[]]
    if (op === 'get') return props[args[0] as string]
    const vals = args.map((a) => evaluate(a, props))
    if (op === '+') return vals.reduce((a, b) => a + b, 0)
    if (op === '-') return vals[0] - vals[1]
    if (op === '*') return vals.reduce((a, b) => a * b, 1)
    if (op === '/') return vals[0] / vals[1]
    throw new Error(`未対応の演算子: ${op}`)
  }

  const evalKey = (levelProp: string, level: number, lng: number, lat: number, bearing: number) =>
    evaluate(frontSortKeyExpression(levelProp, bearing), { [levelProp]: level, ...mercatorProps(lng, lat) })

  // 正: 式の中身が frontness01 と一致していること。**片方だけ直すと、テストが通ったまま
  // 地図の並びだけがずれる**（テストは JS 側、描画は式側を使うため）。
  it('式は frontness01 と同じ値を出す', () => {
    for (const bearing of [0, 37, 90, 213, 300]) {
      const key = evalKey('scale', 0, 139, 35, bearing)
      expect(key).toBeCloseTo(front(139, 35, bearing) * FRONT_WEIGHT, 12)
    }
  })

  // 正: 階級が違えば、手前らしさに関わらず階級で決まる。
  it('階級が第一（手前らしさでは追い越せない）', () => {
    // 震度 4（40）で最も奥の点 vs 震度 3（30）で最も手前の点。
    const weak = evalKey('scale', 30, 139, -85, 0) // 最も手前になりうる位置
    const strong = evalKey('scale', 40, 139, 85, 0) // 最も奥になりうる位置
    expect(strong).toBeGreaterThan(weak)
  })

  it('階級が 1 しか離れていなくても追い越さない（長周期の階級は 1 刻み）', () => {
    const weak = evalKey('lgInt', 2, 139, -85, 0)
    const strong = evalKey('lgInt', 3, 139, 85, 0)
    expect(strong).toBeGreaterThan(weak)
  })

  // 正: 同じ階級なら手前が大きい（＝ MapLibre で前面に描かれる。値の大小と前後の対応は実測）。
  it('同じ階級なら手前の点の方が大きい', () => {
    expect(evalKey('scale', 40, 139, 30, 0)).toBeGreaterThan(evalKey('scale', 40, 139, 40, 0))
  })
})

describe('bearingChangedEnough', () => {
  it('刻みに満たない変化では作り直さない', () => {
    expect(bearingChangedEnough(0, BEARING_STEP_DEG - 1)).toBe(false)
  })

  it('刻み以上なら作り直す', () => {
    expect(bearingChangedEnough(0, BEARING_STEP_DEG)).toBe(true)
  })

  // 安全弁: 360 度の折り返し。素朴な引き算だと 359→1 が 358 度の変化に見え、
  // 少し回しただけで毎回作り直す。
  it('0 度をまたぐ変化を正しく測る', () => {
    expect(bearingChangedEnough(359, 1)).toBe(false)
    expect(bearingChangedEnough(1, 359)).toBe(false)
    expect(bearingChangedEnough(359, 10)).toBe(true)
  })

  it('逆回りでも対称', () => {
    expect(bearingChangedEnough(10, 0)).toBe(bearingChangedEnough(0, 10))
  })
})

describe('FRONT_SORTED_LAYERS', () => {
  // 安全弁: レイヤー id の重複は「後から入れた式が前のを上書きする」形の事故になる。
  it('レイヤー id が重複していない', () => {
    const ids = FRONT_SORTED_LAYERS.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('階級のプロパティ名が空でない', () => {
    for (const l of FRONT_SORTED_LAYERS) expect(l.levelProp.length).toBeGreaterThan(0)
  })
})
