import { useEffect } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'

// brightness(0.42) と数式的に等価な暗さになる不透明度。
// 黒(0,0,0)を multiply でブレンドすると結果は常に黒になり、その後の通常のアルファ合成で
// backdrop * (1 - TINT_OPACITY) になる。1 - 0.58 = 0.42 で旧filterのbrightness値と一致する。
const TINT_OPACITY = 0.58

// ビューポートの何倍の余白を確保するか。Canvasと違いプレーンなdiv（テクスチャを持たない
// 単色塗り）はサイズを大きくしてもGPU合成コストがほぼ変わらないため、Canvas系レイヤーの
// MAP_CANVAS_PADDING（=2）より余裕を持たせても実質コスト増にならない。
const MARGIN_FACTOR = 3

// 海底地形タイル（tilePane, z=200）専用の暗色オーバーレイ。
// 従来は .leaflet-tile-pane に CSS filter (brightness/saturate/contrast) をかけていたが、
// filter は適用先のサブツリー内で何か1つでも変化するとサブツリー全体をオフスクリーンに
// 描き直してシェーダーを通す必要があり、パン中に新規タイルが継続的に読み込まれる
// （Leaflet の TileLayer はデスクトップで updateWhenIdle:false のため）たびに
// タイルペイン全体の再フィルタが走っていた。非力なGPUではこれがパン時のカクつきの主因になる。
//
// 以前は L.canvas + L.rectangle（Leaflet ネイティブのベクター描画）で実装していたが、
// Canvas レンダラーは flyTo アニメーション中に毎フレーム発火する 'zoom' イベントのたびに
// 自身の canvas 要素（padding分だけ実バッファがビューポートより大きい）へ CSS transform を
// 掛け直す（Renderer._onZoom）。この「大きなテクスチャを毎フレーム再配置する」コストが
// 非力なGPUで無視できない重さになっていた。
//
// このレイヤーの中身は単色塗りでテクスチャを持たないため、Canvas を使う必然性が無い。
// マーカーと同じ「地図中心のレイヤーポイントに位置決めし、あとは Leaflet 標準の
// パン用共有transform（.leaflet-map-pane の translate）に乗せる」方式のプレーンな div に
// 置き換える。'move'/'zoom' イベント（パン・flyTo中を含め継続的に発火）のたびに
// 位置を再計算するが、対象がプレーンな単色divなのでこの再計算・再配置は
// Canvasの毎フレーム transform 更新と違ってGPU的にほぼ無コストで済む。
export function TileTintLayer() {
  const map = useMap()

  useEffect(() => {
    if (!map.getPane('tile-tint')) {
      const pane = map.createPane('tile-tint')
      pane.style.zIndex = '220'
      pane.style.pointerEvents = 'none'
      pane.style.mixBlendMode = 'multiply'
    }
    const pane = map.getPane('tile-tint')!

    const tint = document.createElement('div')
    tint.style.position = 'absolute'
    tint.style.top = '0'
    tint.style.left = '0'
    tint.style.backgroundColor = '#000000'
    tint.style.opacity = String(TINT_OPACITY)
    pane.appendChild(tint)

    let width = 0
    let height = 0

    function updateSize() {
      const size = map.getSize()
      width = size.x * (1 + 2 * MARGIN_FACTOR)
      height = size.y * (1 + 2 * MARGIN_FACTOR)
      tint.style.width = `${width}px`
      tint.style.height = `${height}px`
    }

    function updatePosition() {
      const centerPoint = map.latLngToLayerPoint(map.getCenter())
      L.DomUtil.setPosition(tint, centerPoint.subtract([width / 2, height / 2]))
    }

    function onResize() {
      updateSize()
      updatePosition()
    }

    updateSize()
    updatePosition()

    map.on('move zoom', updatePosition)
    map.on('resize', onResize)

    return () => {
      map.off('move zoom', updatePosition)
      map.off('resize', onResize)
      tint.remove()
    }
  }, [map])

  return null
}
