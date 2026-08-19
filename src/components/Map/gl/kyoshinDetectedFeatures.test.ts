import { describe, it, expect } from 'vitest'
import { buildDetectedFC } from './kyoshinDetectedFeatures'
import type { DetectedPoint } from '../../../utils/kyoshinDetectionView'

// 検知点マーカーが「今どうなっている点」を描くのかを固定する回帰テスト。
//
// 2026-08-18 の実測で、リアルタイムタブの検知カードが「震度0: 24点」と出している時点で、
// 地図には震度0バッジが 361 個描かれていた（うち 337 個は震度0未満または欠測）。原因は
// メンバー観測点（kyoshinDetector の memberKeys）がイベント解除まで縮まないまま、
// 震度階級への変換失敗を rank 0（震度0）へフォールバックしていたこと。
// カードは震度0以上だけを数えるため、揺れが収まるほど桁違いにずれていた。

const P = (lat: number, lng: number, index: number): DetectedPoint => ({ key: `${lat},${lng}`, lat, lng, index })

/** index → 計測震度は value = -3.0 + index * 0.5。6=震度0(0.0) / 7=震度1(0.5) / 5=震度0未満(-0.5)。 */
const IDX_SHINDO0 = 6
const IDX_SHINDO1 = 7
const IDX_BELOW_ZERO = 5
const IDX_MISSING = -1

const BASE_RADIUS = 32 // KYOSHIN_DETECTED_ICON_BASE_RADIUS

describe('buildDetectedFC: 震度0未満・欠測の点は描かない', () => {
  it('震度0未満（index 5 以下）の点は feature にならない', () => {
    const fc = buildDetectedFC([P(35, 139, IDX_BELOW_ZERO), P(35.1, 139.1, 0)], [], 1)
    expect(fc.features).toHaveLength(0)
  })

  it('欠測（index -1）の点は feature にならない', () => {
    const fc = buildDetectedFC([P(35, 139, IDX_MISSING)], [], 1)
    expect(fc.features).toHaveLength(0)
  })

  it('震度0以上の点だけが残る（混在時）', () => {
    const fc = buildDetectedFC(
      [P(35, 139, IDX_SHINDO0), P(35.1, 139.1, IDX_BELOW_ZERO), P(35.2, 139.2, IDX_SHINDO1), P(35.3, 139.3, IDX_MISSING)],
      [],
      1,
    )
    expect(fc.features.map((f) => f.properties?.index)).toEqual([IDX_SHINDO0, IDX_SHINDO1])
  })

  it('unconfirmed 側にも同じ除外が効く', () => {
    const fc = buildDetectedFC([], [P(35, 139, IDX_BELOW_ZERO), P(35.1, 139.1, IDX_SHINDO0)], 1)
    expect(fc.features).toHaveLength(1)
    expect(fc.features[0]?.properties?.index).toBe(IDX_SHINDO0)
  })
})

describe('buildDetectedFC: バッジの選び方', () => {
  it('震度0は rank 0・震度1は rank 1 のバッジになる', () => {
    const fc = buildDetectedFC([P(35, 139, IDX_SHINDO0), P(35.1, 139.1, IDX_SHINDO1)], [], 1)
    expect(fc.features.map((f) => f.properties?.iconId)).toEqual([
      'kyoshin-detected-badge-0-confirmed',
      'kyoshin-detected-badge-1-confirmed',
    ])
  })

  it('confirmed と unconfirmed でバッジの種類が分かれる', () => {
    const fc = buildDetectedFC([P(35, 139, IDX_SHINDO1)], [P(36, 140, IDX_SHINDO1)], 1)
    expect(fc.features.map((f) => f.properties?.iconId)).toEqual([
      'kyoshin-detected-badge-1-confirmed',
      'kyoshin-detected-badge-1-candidate',
    ])
  })

  // 同一座標に複数の実体がある観測点が実在する（kyoshinDetectionView の buildSiteIndex 参照）。
  // 座標での重複除去はその 2 点を取り違えて落とすため、ここでは行わない。
  // confirmed / unconfirmed の重複排除は deriveKyoshinView が観測点キーで済ませている。
  it('同一座標でも両方描く（座標では重複除去しない）', () => {
    const fc = buildDetectedFC([P(35, 139, IDX_SHINDO1)], [P(35, 139, IDX_SHINDO0)], 1)
    expect(fc.features.map((f) => f.properties?.iconId)).toEqual([
      'kyoshin-detected-badge-1-confirmed',
      'kyoshin-detected-badge-0-candidate',
    ])
  })
})

describe('buildDetectedFC: 半径', () => {
  it('震度0は固定小半径（confirmed 4.5px / unconfirmed 2.5px）', () => {
    const fc = buildDetectedFC([P(35, 139, IDX_SHINDO0)], [P(36, 140, IDX_SHINDO0)], 1)
    expect(fc.features[0]?.properties?.iconSizeRatio).toBeCloseTo(4.5 / BASE_RADIUS)
    expect(fc.features[1]?.properties?.iconSizeRatio).toBeCloseTo(2.5 / BASE_RADIUS)
  })

  it('震度1以上は計測震度連動（getScaleRadius(10)=4 に確信度別ボーナスを加算）', () => {
    const fc = buildDetectedFC([P(35, 139, IDX_SHINDO1)], [P(36, 140, IDX_SHINDO1)], 1)
    expect(fc.features[0]?.properties?.iconSizeRatio).toBeCloseTo((4 + 6) / BASE_RADIUS)
    expect(fc.features[1]?.properties?.iconSizeRatio).toBeCloseTo((4 + 2) / BASE_RADIUS)
  })

  it('iconScale が半径に掛かる', () => {
    const fc = buildDetectedFC([P(35, 139, IDX_SHINDO1)], [], 2)
    expect(fc.features[0]?.properties?.iconSizeRatio).toBeCloseTo((4 + 6) * 2 / BASE_RADIUS)
  })
})

describe('buildDetectedFC: 座標', () => {
  it('GeoJSON は [lng, lat] の順で出す', () => {
    const fc = buildDetectedFC([P(35.5, 139.5, IDX_SHINDO1)], [], 1)
    expect(fc.features[0]?.geometry).toMatchObject({ type: 'Point', coordinates: [139.5, 35.5] })
  })
})
