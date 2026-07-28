import type { Map as MapLibreMap, LayerSpecification } from 'maplibre-gl'

// kyoshin モードのレイヤー描画順（配列の先頭ほど下、末尾ほど前面）。
// 各レイヤーはデータ到着タイミングの違いでマウント順が前後する（例: SubThreshold/Points は
// sites 到着後に追加され、DetectedPoints/MaxEffect は map 準備直後に追加される）。addLayer は既定で
// スタック最上段へ積むため、マウント順に任せると意図した重畳順にならない。この配列を単一の情報源として、
// addKyoshinLayer が「このレイヤーより前面に来るべき既存レイヤー」の直前へ挿入することで、
// 追加順に依存せず常にこの並びを保証する。
export const KYOSHIN_LAYER_ORDER = [
  'kyoshin-subthreshold',
  'kyoshin-points',
  'kyoshin-detected',
  'kyoshin-ripple',
] as const

// layer を KYOSHIN_LAYER_ORDER の正しいスロットへ追加する。自分より後段（前面）にあるべき
// 既存レイヤーのうち最初のものを beforeId に指定して、その直前へ挿入する（該当が無ければ最上段）。
export function addKyoshinLayer(map: MapLibreMap, layer: LayerSpecification): void {
  const selfPos = KYOSHIN_LAYER_ORDER.indexOf(layer.id as (typeof KYOSHIN_LAYER_ORDER)[number])
  let beforeId: string | undefined
  if (selfPos >= 0) {
    for (let i = selfPos + 1; i < KYOSHIN_LAYER_ORDER.length; i++) {
      const above = KYOSHIN_LAYER_ORDER[i]
      if (map.getLayer(above)) {
        beforeId = above
        break
      }
    }
  }
  map.addLayer(layer, beforeId)
}
