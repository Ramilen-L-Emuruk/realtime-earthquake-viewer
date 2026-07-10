import L from 'leaflet'

// Leaflet の flyTo/flyToBounds はアニメーション中、ズームレベルが変化している間
// 毎フレーム 'zoom' イベントを発火する（Leaflet Map.js の _flyToFrame → _move）。
// Canvas レンダラーはこの 'zoom' イベントのたびに自身の canvas 要素へ CSS transform を
// 掛け直す（Renderer.js の _onZoom → _updateTransform）。この canvas は
// mapCanvasPadding.ts の padding 分だけ実バッファがビューポートより大きく確保されて
// いる上、retina環境ではさらに縦横2倍（Canvas.js の _update）になるため、非力な GPU
// では毎フレームの transform + 再合成コストが無視できない重さになる。
//
// flyTo/flyToBounds の呼び出し元は全てこのモジュール経由にし、アニメーション中だけ
// 対象ペインを非表示にして transform コストそのものを発生させない。Leaflet のレンダラーは
// moveend で必ずフル再描画・再配置を行うため（Renderer.getEvents() の moveend: this._update）、
// 着地時に表示へ戻すだけで最終的な位置ズレは起きない。
//
// 'basemap' はここに含めない。BaseMap.tsx で SVG レンダラーに変更済みで、SVG は
// 解像度非依存のベクター要素のため Canvas 特有の「大きなテクスチャの毎フレーム再合成」
// コストの土台自体が無く、隠さず表示したままで問題ない（BaseMap.tsx のコメント参照）。
//
// 海底地形タイル（tilePane）・その暗色オーバーレイ（tile-tint）も対象外。
// tile-tint だけ隠すと明るい生タイルが露出し、tilePane も一緒に隠すと着地までタイルが
// 消えて見える（どちらも見た目上のチラつきとして許容できない）。tile-tint は独自の
// 軽量実装（TileTintLayer.tsx 参照）でこの制約を回避している。
const HIDDEN_DURING_FLY_PANES = [
  'quake-heat',
  'quake-region-fill',
  'eew-region-fill',
  'eew-lpgm-region-fill',
  'line-layers',
  'tsunami-lines',
]

function hidePanesUntilMoveEnd(map: L.Map): void {
  for (const name of HIDDEN_DURING_FLY_PANES) {
    const pane = map.getPane(name)
    if (pane) pane.style.visibility = 'hidden'
  }
  map.once('moveend', () => {
    for (const name of HIDDEN_DURING_FLY_PANES) {
      const pane = map.getPane(name)
      if (pane) pane.style.visibility = ''
    }
  })
}

export function flyToLite(
  map: L.Map,
  latlng: L.LatLngExpression,
  zoom?: number,
  options?: L.ZoomPanOptions,
): void {
  hidePanesUntilMoveEnd(map)
  map.flyTo(latlng, zoom, options)
}

export function flyToBoundsLite(
  map: L.Map,
  bounds: L.LatLngBoundsExpression,
  options?: L.FitBoundsOptions,
): void {
  hidePanesUntilMoveEnd(map)
  map.flyToBounds(bounds, options)
}
