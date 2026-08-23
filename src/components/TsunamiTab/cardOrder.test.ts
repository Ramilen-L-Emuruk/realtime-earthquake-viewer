// @vitest-environment jsdom
//
// 「観測点の並び」の単一情報源（`sortObservationsForCardDisplay`）が、カードが実際に描く順と
// 一致していることを守るテスト。
//
// 読み上げはこの関数の返す順で観測点を読む（→ docs/spec/tsunami-spec.md §9）。関数はカードの
// 入れ子を**写して**いるだけなので、カード側が並べ方を変えると黙って食い違い、追従スクロールが
// カード上を往復する。写し間違いを検出できるのは、描いた結果と突き合わせるここだけ。
//
// JSX を使わず createElement で書くのは、このプロジェクトのテストが `src/**/*.test.ts` のみを
// 対象にしているため（`RealtimeTab/index.test.ts` と同じ作法）。
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { TsunamiTab } from './index'
import { sortObservationsForCardDisplay } from '../../utils/tsunami'
import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../../types/earthquake'

afterEach(cleanup)

// jsdom は ResizeObserver を持たない。カードはバナーの高さ計測にだけ使うので、
// 何も観測しない最小の実装で足りる（並び順の検証には影響しない）。
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver

const area = (name: string, code: string, grade: TsunamiArea['grade'], height?: string): TsunamiArea =>
  ({ name, code, grade, immediate: false, maxHeight: height ? { description: height, value: 0 } : undefined })

const obs = (name: string, districtName: string, code: string, value?: number): TsunamiObservation =>
  ({ name, districtCode: code, districtName, height: value === undefined ? undefined : { value, description: `${value}m` } })

/** 描画されたカードから観測点名の出現順を読む（観測点名は互いに部分文字列にならない名前を使う）。 */
function renderedOrder(tsunami: JMATsunami, names: string[]): string[] {
  const { container } = render(createElement(TsunamiTab, { tsunamis: [tsunami] }))
  const text = container.textContent ?? ''
  return names
    .map(name => ({ name, at: text.indexOf(name) }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(x => x.name)
}

describe('津波カードの観測点の並び', () => {
  // 等級（重い順）・区域（実測の深刻な順）・区域内（電文順）・沖合（最後）を 1 つの電文で通す
  const areas = [
    area('青森県太平洋沿岸', '060', 'Watch', '1m'),
    area('岩手県', '030', 'Warning', '3m'),
    area('宮城県', '040', 'Warning', '3m'),
  ]
  const observations = [
    obs('八戸', '青森県太平洋沿岸', '060', 0.4),
    obs('宮古', '岩手県', '030', 1.2),
    obs('大船渡', '岩手県', '030', 3.0),
    obs('鮎川', '宮城県', '040', 2.4),
    obs('沖合ブイ', '沖合', '999', 0.2),
  ]
  const tsunami: JMATsunami = {
    kind: 'tsunami',
    id: 'card-order',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas,
    observations,
  }

  it('単一情報源の並びがカードの描画順と一致する', () => {
    const expected = sortObservationsForCardDisplay(observations, areas).map(o => o.name)
    expect(renderedOrder(tsunami, expected)).toEqual(expected)
  })

  // 上のテストは「両方が同じ関数を使っている」だけでも通ってしまう。並びが実際に
  // 電文順ではないことをここで押さえる（等級・区域の並べ替えが効いていることの確認）。
  it('並びは電文順ではない（等級と区域の並べ替えが効いている）', () => {
    const expected = sortObservationsForCardDisplay(observations, areas).map(o => o.name)
    expect(expected).toEqual(['宮古', '大船渡', '鮎川', '八戸', '沖合ブイ'])
    expect(expected).not.toEqual(observations.map(o => o.name))
  })
})
