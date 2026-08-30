// ベースマップ 4 レイヤーが 1 ソースを共有するための feature 組み立て。
//
// **見たいのは「レイヤーが自分の分だけを拾えるか」**。ソースを共有した以上、`kind` の付け漏れは
// 「陸地の塗りが県境として描かれる」ような形で表に出る。件数と種別を固定しておく。
import { describe, it, expect } from 'vitest'
import type { Feature, LineString, Polygon } from 'geojson'
import { basemapKindFilter, buildBasemapFC } from './basemapFeatures'
import type { Prefectures } from '../../../utils/prefectures'
import type { SubRegion } from '../../../utils/subregions'

// 三角形 1 枚のリング（[lat, lng] 順＝生成データと同じ並び）。
const ring: [number, number][] = [
  [35, 139],
  [36, 139],
  [36, 140],
  [35, 139],
]

const prefs = {
  東京都: { label: [35.7, 139.7], room: [0.1, 0.1], rings: [ring] },
  埼玉県: { label: [36.0, 139.4], room: [0.1, 0.1], rings: [ring, ring] },
} as unknown as Prefectures

const subs = [
  { name: '東京都23区', label: [35.7, 139.7], room: [0.1, 0.1], rings: [ring] },
] as unknown as SubRegion[]

function kindsOf(features: Feature<Polygon | LineString>[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const f of features) {
    const kind = String(f.properties?.kind ?? '(none)')
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return counts
}

describe('buildBasemapFC', () => {
  it('リング 1 本につき 1 feature を、塗りと線の両方へ作る', () => {
    // 県のリングは計 3 本（東京 1 + 埼玉 2）、区域は 1 本。
    const fc = buildBasemapFC(prefs, subs)
    expect(kindsOf(fc.features)).toEqual({
      land: 3,
      'pref-line': 3,
      'sub-line': 1,
      'sub-hit': 1,
    })
  })

  it('区域名は当たり判定の feature だけが持つ（ポップアップの本文に使う）', () => {
    const fc = buildBasemapFC(prefs, subs)
    const hit = fc.features.filter((f) => f.properties?.kind === 'sub-hit')
    expect(hit.map((f) => f.properties?.name)).toEqual(['東京都23区'])
    // 区域の境界線には名前を載せない（載せると当たり判定の重複ヒットになる）。
    const subLine = fc.features.filter((f) => f.properties?.kind === 'sub-line')
    expect(subLine.every((f) => f.properties?.name === undefined)).toBe(true)
  })

  it('塗りは Polygon・境界線は LineString で作る', () => {
    const fc = buildBasemapFC(prefs, subs)
    const geomOf = (kind: string) =>
      new Set(fc.features.filter((f) => f.properties?.kind === kind).map((f) => f.geometry.type))
    expect(geomOf('land')).toEqual(new Set(['Polygon']))
    expect(geomOf('sub-hit')).toEqual(new Set(['Polygon']))
    expect(geomOf('pref-line')).toEqual(new Set(['LineString']))
    expect(geomOf('sub-line')).toEqual(new Set(['LineString']))
  })

  it('生成データは [lat,lng] 順なので、GeoJSON の [lng,lat] へ入れ替える', () => {
    const fc = buildBasemapFC(prefs, null)
    const land = fc.features.find((f) => f.properties?.kind === 'land') as Feature<Polygon>
    expect(land.geometry.coordinates[0][0]).toEqual([139, 35])
  })

  it('片方の生成データが取得できなくても、取れた側だけで組み立てる', () => {
    // 区域だけ失敗した場合。県の 2 種別だけが残る。
    expect(kindsOf(buildBasemapFC(prefs, null).features)).toEqual({ land: 3, 'pref-line': 3 })
    // 県だけ失敗した場合。
    expect(kindsOf(buildBasemapFC(null, subs).features)).toEqual({ 'sub-line': 1, 'sub-hit': 1 })
    // 両方失敗しても例外にはせず空を返す（呼び出し側はこのときソース自体を作らない）。
    expect(buildBasemapFC(null, null)).toEqual({ type: 'FeatureCollection', features: [] })
  })
})

describe('basemapKindFilter', () => {
  it('レイヤーの filter は kind の一致だけを見る', () => {
    expect(basemapKindFilter('land')).toEqual(['==', ['get', 'kind'], 'land'])
  })
})
