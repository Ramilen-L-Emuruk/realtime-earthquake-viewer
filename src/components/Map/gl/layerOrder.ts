import type { Map as MapLibreMap, LayerSpecification, CustomLayerInterface } from 'maplibre-gl'

// 地図オーバーレイ全レイヤーの描画順（先頭ほど下＝背面、末尾ほど前面）を単一の情報源に定める。
// MapLibre の addLayer は既定でスタック最上段に積むため、データ到着タイミングの差でマウント順が
// 前後すると意図した重畳順にならない（例: 活断層線は遅延ロードで後から乗り、強震点の上に来てしまう）。
// addOrderedLayer が「この配列上で自分より前面にあるべき既存レイヤーのうち最初のもの」を beforeId に
// 指定して挿入することで、追加順に依存せず常にこの並びを保証する。
//
// quake モードのレイヤー群と kyoshin モードのレイヤー群は排他（mode 切替で同時には存在しない）だが、
// アルゴリズム上の全順序として一列に並べておけば齟齬は起きない。
// 旧 Leaflet 実装のペイン z-index（tile-tint220 / basemap250 / quake-heat255 /
// region-fill系260-261 / line-layers263 / tsunami-lines270 / ps-wave280 /
// kyoshin-points・quake-points400 / basemap-labels450）を踏襲した並び。
export const MAP_LAYER_ORDER = [
  // ベースマップ（BaseMapGL）。陸地塗り・境界線は生成データの遅延読込後に追加されるため、
  // 素の addLayer（最上段）だと読込順次第でオーバーレイの上に乗る事故がある。最下層スロットとして
  // ここに含め、BaseMapGL も addOrderedLayer で追加することで常に最背面へ固定する。
  // 海底地形は 2 層（下: 低ズーム固定のオーバービュー／上: 現在ズーム相当の高解像度）。理由は BaseMapGL 参照。
  'gebco-overview-raster',
  'gebco-raster',
  'land-fill',
  // 一次細分区域の当たり判定用の透明 fill（区域名ポップアップの受け皿）。描画には寄与しないが、
  // 下地の一部としてここに置く。他に何もヒットしないときだけ出るよう優先度は basemap。
  'subregion-hit',
  'sub-borders',
  'pref-borders',
  // 地震活動ヒートマップ（旧 z255）。プレート境界線・活断層線（旧 z263）より背面。
  'quake-heat',
  // ヒートマップのクリック当たり判定用の透明レイヤー。heatmap レイヤーは queryRenderedFeatures に
  // ヒットしない（密度描画のため個別 feature を返さない）ので、同じ点を circle で重ねて拾う。
  'quake-heat-hit',
  'quake-region-fill',
  'quake-region-fill-line',
  'eew-region-fill',
  'eew-region-fill-line',
  'quake-lpgm-region-fill',
  'quake-lpgm-region-fill-line',
  'eew-lpgm-region-fill',
  'eew-lpgm-region-fill-line',
  'plate-boundaries',
  'active-faults',
  // 津波海岸線（旧 z270）。プレート境界線・活断層線より前面だが、予報円・観測点よりは背面。
  'tsunami-lines',
  // EEW 予報円（旧 z280）。海岸線より前面、観測点・ラベルよりは背面。
  'pswave',
  // 区域中心の震度・階級ラベル（旧 HTML Marker・常に最前面だった）。観測点と同じ前面グループに置く。
  'quake-region-label',
  'quake-lpgm-region-label',
  'quake-points',
  'quake-lpgm-points',
  'kyoshin-subthreshold',
  'kyoshin-points',
  'kyoshin-detected',
  'kyoshin-ripple',
  // 震源（深さを持つ点）。地下に置くため深度バッファを使う custom layer で、地表の描画物より前面。
  // 地名ラベルよりは背面（ラベルは常に最前面という既存の方針を崩さない）。
  // 地震情報の震源と EEW の震源は同じ仕組みで描く（gl/depthPointLayer.ts）。EEW を前面に置くのは、
  // 進行中の揺れの方が過去の地震より優先して見えるべきだから。
  'hypocenter-depth',
  'eew-epicenters',
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
