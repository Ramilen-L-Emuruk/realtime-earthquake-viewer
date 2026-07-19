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
// 'basemap'・'quake-region-fill'・'eew-region-fill'・'eew-lpgm-region-fill'・'lpgm-region-fill'・
// 'line-layers'・'tsunami-lines'・'kyoshin-points'・'quake-points' はここに含めない。いずれも
// SVG レンダラーに変更済み（BaseMap.tsx・JapanMap.tsx・KyoshinPoints.tsx・IntensityPoints.tsx 等の
// renderer 定義参照）。SVG は解像度非依存のベクター要素のため Canvas 特有の「大きなテクスチャの
// 毎フレーム再合成」コストの土台自体が無く、隠さず表示したままで問題ない。
//
// 'quake-heat'（直近1ヶ月の地震活動ヒートマップ）は対象のまま残す。leaflet.heat
// プラグインによる密度勾配の描画で、単色矩形やベクター図形と違い実際にラスタライズが
// 必要なためSVG化できず、Canvas特有のコストがそのまま残っている。
// （JS 側の毎フレーム全点再描画も QuakeHeatmapLayer 側で zoomstart〜zoomend 間は
// スキップする。ここで隠すのは合成コスト、あちらで止めるのは描画コスト。）
//
// 'line-layers-hit'・'tsunami-lines-hit' は、プレート境界線・活断層線・津波海岸線の
// ポップアップ当たり判定用に可視線(SVG)へ重ねた「透明な Canvas レイヤー」（JapanMap.tsx の
// lineLayerHitRenderer/tsunamiLineHitRenderer 参照。SVG は tolerance を持てないため Canvas で
// クリック許容範囲を稼ぐ）。Canvas なので flyTo 中の再合成コストが発生するが、完全に透明で
// あり飛行中にホバー/クリックも発生しないため、ここで隠しても視覚・機能への影響は一切無い。
// 可視線本体（'line-layers'・'tsunami-lines'）は SVG のままここに含めず、飛行中も表示を維持する。
//
// 海底地形タイル（tilePane）・その暗色オーバーレイ（tile-tint）も対象外。
// tile-tint だけ隠すと明るい生タイルが露出し、tilePane も一緒に隠すと着地までタイルが
// 消えて見える（どちらも見た目上のチラつきとして許容できない）。tile-tint は独自の
// 軽量実装（TileTintLayer.tsx 参照）でこの制約を回避している。
const HIDDEN_DURING_FLY_PANES = [
  'quake-heat',
  'line-layers-hit',
  'tsunami-lines-hit',
]

// flyTo 中だけ地図コンテナへ付与するクラス（CSS 本体は src/index.css）。
// Leaflet 標準 CSS の will-change: transform は、SVG レンダラーの <svg> には常時付く
// （svg.leaflet-zoom-animated）が、タイルコンテナや divIcon マーカー等の div 系
// .leaflet-zoom-animated には標準ズームアニメ中（.leaflet-zoom-anim が付く間）しか
// 付かない。flyTo は毎フレーム JS で transform を書き換える方式で、このクラスを
// 一切付けないため、div 系要素の transform 変更が毎フレームのメインスレッド再描画に
// なってしまう。飛行中だけ will-change を効かせて合成レイヤーへ昇格させ、
// コンポジタ側のテクスチャ移動・拡縮で済むようにする。
// Leaflet 純正の leaflet-zoom-anim クラスを流用しないのは、あちらには
// transition: transform 0.25s が同居しており（leaflet.css）、毎フレーム transform を
// 書く flyTo に乗せるとレイヤーがトランジション遅延で波打つため。
const FLY_BOOST_CLASS = 'fly-anim-boost'

function boostFlightUntilMoveEnd(map: L.Map): void {
  map.getContainer().classList.add(FLY_BOOST_CLASS)
  for (const name of HIDDEN_DURING_FLY_PANES) {
    const pane = map.getPane(name)
    if (pane) pane.style.visibility = 'hidden'
  }
  map.once('moveend', () => {
    map.getContainer().classList.remove(FLY_BOOST_CLASS)
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
  boostFlightUntilMoveEnd(map)
  map.flyTo(latlng, zoom, options)
}

export function flyToBoundsLite(
  map: L.Map,
  bounds: L.LatLngBoundsExpression,
  options?: L.FitBoundsOptions,
): void {
  boostFlightUntilMoveEnd(map)
  map.flyToBounds(bounds, options)
}
