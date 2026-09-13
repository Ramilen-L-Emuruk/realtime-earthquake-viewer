// 震源の吹き出しに出る都道府県別最大震度。
//
// **「救済」と「印」は別の話。** 救済は値を出すかどうか（観測値が 1 件も無い県だけ）、印は
// 未入電があると伝えるかどうか（**カードと同じく、1 件でもあれば**）。1 つのフラグに畳むと、
// 観測値がある県では未入電を 1 件も伝えられない —— カードが「震度4 愛媛県 未入電あり」と
// 出しているのに、吹き出しは「愛媛県 4」とだけ言う形になる（→ docs/spec/quake-spec.md §4）。
import { describe, it, expect } from 'vitest'
import { buildPopupHtml } from './HypocenterDepthGL'
import type { PrefIntensity } from '../../hooks/useQuakeLayerData'
import type { JMAQuake } from '../../types/earthquake'

const QUAKE: JMAQuake = {
  kind: 'quake',
  id: 'q1',
  time: '2026-09-13T03:00:00Z',
  issue: { source: 'dmdata', time: '2026-09-13T03:00:00Z', type: '震源・震度情報', correct: 'なし' },
  earthquake: {
    time: '2026-09-13T03:00:00Z',
    hypocenter: { name: '日向灘', latitude: 32.7, longitude: 132.1, depth: 40, magnitude: 6.4 },
    maxScale: 55,
    domesticTsunami: 'なし',
  },
  points: [],
}

const row = (over: Partial<PrefIntensity>): PrefIntensity =>
  ({ pref: '愛媛県', scale: 40, unreceived: false, hasUnreceived: false, ...over })

describe('震源の吹き出しの都道府県別最大震度', () => {
  // 正: 観測できた県でも、未入電があれば印を出す。
  it('観測値がある県に「未入電あり」を出す', () => {
    const html = buildPopupHtml(QUAKE, [row({ hasUnreceived: true })])
    expect(html).toContain('愛媛県')
    expect(html).toContain('未入電あり')
    // 値そのものは観測値のまま（印は値を書き換えない）。
    expect(html).toContain('>4<')
  })

  // 対照: 未入電を持たない県には出さない。
  it('未入電を持たない県には出さない', () => {
    expect(buildPopupHtml(QUAKE, [row({})])).not.toContain('未入電')
  })

  // 安全弁: 値そのものが推定の県には重ねない（「5弱以上」が既にそれを言っている）。
  it('値が推定の県に「未入電あり」を重ねない', () => {
    const html = buildPopupHtml(QUAKE, [row({ scale: 45, unreceived: true })])
    expect(html).toContain('5弱以上')
    expect(html).not.toContain('未入電あり')
  })
})
