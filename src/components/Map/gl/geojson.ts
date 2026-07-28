import type { LatLng } from '../../../utils/stationCoords'
import type { Feature, FeatureCollection, Polygon, LineString, MultiLineString, GeoJsonProperties } from 'geojson'

// 生成データ（public/data/*.json）は Leaflet の [lat,lng] 順。MapLibre / GeoJSON は [lng,lat] 順の
// ため、リング座標を入れ替える共通ヘルパ。MapLibre 移行の全レイヤーで再利用する。

/** [lat,lng] のリングを GeoJSON の [lng,lat] 位置配列へ変換する。 */
export function ringToLngLat(ring: LatLng[]): [number, number][] {
  return ring.map(([lat, lng]) => [lng, lat])
}

/** リング群を、各リング1枚のポリゴン Feature 群にした FeatureCollection（穴なし・独立描画）。 */
export function ringsToPolygonFC(ringGroups: LatLng[][][]): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = []
  for (const rings of ringGroups) {
    for (const ring of rings) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(ring)] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** リング群を、各リング1本の LineString Feature 群にした FeatureCollection（境界線描画用）。 */
export function ringsToLineFC(ringGroups: LatLng[][][]): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = []
  for (const rings of ringGroups) {
    for (const ring of rings) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: ringToLngLat(ring) },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/**
 * 複数ライン（LatLng[][]）を持つセグメント配列を、セグメント1件=MultiLineString Feature 1件の
 * FeatureCollection にする（活断層・プレート境界のように、1セグメントに属性＋複数ラインを持つデータ用）。
 * props でセグメントからクリック時のポップアップに使う属性を取り出す。
 */
export function segmentsToMultiLineFC<T extends { lines: LatLng[][] }>(
  segments: T[],
  props: (seg: T) => GeoJsonProperties,
): FeatureCollection<MultiLineString> {
  return {
    type: 'FeatureCollection',
    features: segments.map((seg) => ({
      type: 'Feature',
      properties: props(seg),
      geometry: { type: 'MultiLineString', coordinates: seg.lines.map(ringToLngLat) },
    })),
  }
}
