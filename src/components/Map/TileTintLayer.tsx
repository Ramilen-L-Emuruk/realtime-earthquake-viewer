import { useEffect } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import { MAP_CANVAS_PADDING } from './mapCanvasPadding'

// brightness(0.42) と数式的に等価な暗さになる不透明度。
// 黒(0,0,0)を multiply でブレンドすると結果は常に黒になり、その後の通常のアルファ合成で
// backdrop * (1 - TINT_OPACITY) になる。1 - 0.58 = 0.42 で旧filterのbrightness値と一致する。
const TINT_OPACITY = 0.58

// 緯度は Web Mercator の安全上限（±85.0511...）の内側。経度は遠地地震の flyTo が
// normalizeEpicenterLng（utils/geo.ts）で最寄りの ±360 コピーへ正規化されるケースを
// カバーするため世界地図3周分（±540）を確保し、日付変更線を跨ぐ地震でも継ぎ目が出ないようにする。
const WORLD_BOUNDS: L.LatLngBoundsExpression = [
  [-85, -540],
  [85, 540],
]

// 海底地形タイル（tilePane, z=200）専用の暗色オーバーレイ。
// 従来は .leaflet-tile-pane に CSS filter (brightness/saturate/contrast) をかけていたが、
// filter は適用先のサブツリー内で何か1つでも変化するとサブツリー全体をオフスクリーンに
// 描き直してシェーダーを通す必要があり、パン中に新規タイルが継続的に読み込まれる
// （Leaflet の TileLayer はデスクトップで updateWhenIdle:false のため）たびに
// タイルペイン全体の再フィルタが走っていた。非力なGPUではこれがパン時のカクつきの主因になる。
// mix-blend-mode によるブレンド合成は GPU の通常の合成パスで完結し、タイルの増減に対して
// 追加コストがほぼ発生しない。tilePane(200) と basemap(250) の間にペインを1つ作り、
// そこに全球を覆う単色矩形を1回だけ描画する（パン・ズーム追従と再描画は Leaflet の
// Renderer 標準機構が担うため、BaseMap.tsx の陸地塗りポリゴンと同様、追加のJSによる
// 毎フレーム位置合わせは不要）。
//
// padding は必須（他のCanvas描画レイヤーと共通の理由。mapCanvasPadding.ts 参照）。
// 単色矩形1枚の描画コストはバッファが大きくなってもほぼ変わらないため、他レイヤーと
// 揃えても実質コスト増はない。
export function TileTintLayer() {
  const map = useMap()

  useEffect(() => {
    if (!map.getPane('tile-tint')) {
      const pane = map.createPane('tile-tint')
      pane.style.zIndex = '220'
      pane.style.pointerEvents = 'none'
      pane.style.mixBlendMode = 'multiply'
    }
    const renderer = L.canvas({ pane: 'tile-tint', padding: MAP_CANVAS_PADDING })
    const tint = L.rectangle(WORLD_BOUNDS, {
      renderer,
      interactive: false,
      stroke: false,
      fill: true,
      fillColor: '#000000',
      fillOpacity: TINT_OPACITY,
    }).addTo(map)
    return () => {
      tint.remove()
    }
  }, [map])

  return null
}
