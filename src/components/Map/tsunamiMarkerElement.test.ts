// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { buildArrivalMarkerEl } from './TsunamiArrivalMarkersGL'
import { buildMissingMarkerEl } from './TsunamiMissingMarkersGL'

// 到達確認マーカー・欠測マーカーの根の要素が、MapLibre の配置を邪魔しないことを固定する。
//
// **`position` を書くと、マーカーが DOM の並び順に下へ積み上がる。** MapLibre は
// `.maplibregl-marker` クラスの CSS で `position: absolute` を与えており、インラインで指定すると
// それを上書きして通常フローへ戻してしまう。2026-09-11 に実測した時点では 14 番目の点が 117px
// 南へずれていた（詳細は `docs/spec/map-rendering-spec.md` §10）。
//
// ずれはピクセルで固定なので、寄ると正しく見え、引くほど大きく見える。**型検査でも既存の
// テストでも捕まらない**ため、ここで押さえる。
describe('津波マーカーの根の要素', () => {
  const cases = [
    ['到達確認', () => buildArrivalMarkerEl({ name: 'x', lat: 40, lng: 141, blinking: false }, 1)],
    ['欠測', () => buildMissingMarkerEl({ name: 'x', lat: 40, lng: 141, blinking: false }, 1)],
  ] as const

  for (const [label, build] of cases) {
    it(`${label}: position を指定しない（MapLibre の absolute を残す）`, () => {
      expect(build().style.position).toBe('')
    })

    it(`${label}: 寸法は指定する（倍率の変更が反映される側）`, () => {
      const el = build()
      expect(el.style.width).not.toBe('')
      expect(el.style.height).not.toBe('')
    })

    it(`${label}: 内側の見た目は絶対配置で根に重ねる`, () => {
      // 根が `absolute` でも containing block になるので、内側は `inset: 0` で広がる。
      expect(build().innerHTML).toContain('position:absolute;inset:0')
    })
  }
})
