import type { Map as MapLibreMap, LayerSpecification, CustomLayerInterface } from 'maplibre-gl'

// 地図オーバーレイ全レイヤーの描画順（先頭ほど下＝背面、末尾ほど前面）を単一の情報源に定める。
// MapLibre の addLayer は既定でスタック最上段に積むため、データ到着タイミングの差でマウント順が
// 前後すると意図した重畳順にならない（例: 活断層線は遅延ロードで後から乗り、強震点の上に来てしまう）。
// addOrderedLayer が「この配列上で自分より前面にあるべき既存レイヤーのうち最初のもの」を beforeId に
// 指定して挿入することで、追加順に依存せず常にこの並びを保証する。
//
// quake モードのレイヤー群と kyoshin モードのレイヤー群は排他（mode 切替で同時には存在しない）だが、
// アルゴリズム上の全順序として一列に並べておけば齟齬は起きない。
export const MAP_LAYER_ORDER = [
  // ベースマップ（BaseMapGL）。陸地塗り・境界線は生成データの遅延読込後に追加されるため、
  // 素の addLayer（最上段）だと読込順次第でオーバーレイの上に乗る事故がある。最下層スロットとして
  // ここに含め、BaseMapGL も addOrderedLayer で追加することで常に最背面へ固定する。
  'gebco-raster',
  'land-fill',
  'sub-borders',
  'pref-borders',
  'plate-boundaries',
  'active-faults',
  'quake-heat',
  'quake-region-fill',
  'quake-region-fill-line',
  'quake-lpgm-region-fill',
  'quake-lpgm-region-fill-line',
  'quake-points',
  'quake-lpgm-points',
  'epicenter',
  'eew-region-fill',
  'eew-region-fill-line',
  'eew-lpgm-region-fill',
  'eew-lpgm-region-fill-line',
  'kyoshin-subthreshold',
  'kyoshin-points',
  'kyoshin-detected',
  'kyoshin-ripple',
  'pswave',
  // 津波海岸線は発報中は全モードで最前面付近に描く（Leaflet の z270 相当）。
  'tsunami-lines',
  // 地名ラベル（地方/県/区域名）は最前面（Leaflet の basemap-labels z450 相当）。
  'basemap-region-labels',
  'basemap-pref-labels',
  'basemap-subregion-labels',
] as const

export type MapLayerId = (typeof MAP_LAYER_ORDER)[number]

// ids のうち map 上に既に存在する最初のレイヤー id を返す（無ければ undefined）。
export function firstExistingLayerId(map: MapLibreMap, ids: readonly string[]): string | undefined {
  for (const id of ids) {
    if (map.getLayer(id)) return id
  }
  return undefined
}

// layer を MAP_LAYER_ORDER の正しいスロットへ追加する。自分より後段（前面）に来るべき既存レイヤーの
// うち最初のものを beforeId に指定して、その直前へ挿入する（該当が無ければ最上段）。
export function addOrderedLayer(map: MapLibreMap, layer: LayerSpecification | CustomLayerInterface): void {
  const selfPos = MAP_LAYER_ORDER.indexOf(layer.id as MapLayerId)
  const beforeId =
    selfPos >= 0 ? firstExistingLayerId(map, MAP_LAYER_ORDER.slice(selfPos + 1)) : undefined
  map.addLayer(layer, beforeId)
}
