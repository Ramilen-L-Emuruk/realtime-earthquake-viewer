import { useEffect } from 'react'
import L from 'leaflet'
import 'leaflet.heat'
import { useMap } from 'react-leaflet'
import type { HeatPoint } from '../../utils/quakeHeatmap'

interface Props {
  points: HeatPoint[]
}

// 直近1ヶ月の地震活動ヒートマップ。区域塗り(z260)より背面のペインに描画し、
// 震度色塗り・震源マーカーの視認性と競合しないようにする。
export function QuakeHeatmapLayer({ points }: Props) {
  const map = useMap()

  useEffect(() => {
    if (!map.getPane('quake-heat')) {
      const pane = map.createPane('quake-heat')
      pane.style.zIndex = '255'
      pane.style.pointerEvents = 'none'
    }
    const layer = L.heatLayer(
      points.map((p): [number, number, number] => [p.lat, p.lng, p.weight]),
      { radius: 22, blur: 18, maxZoom: 8, minOpacity: 0.15 },
    ).addTo(map)
    // leaflet.heat は canvas を常に overlayPane 直下へ追加し pane オプションを見ないため、
    // 生成後に専用ペインへ付け替える（全ペインは mapPane 基準で同一原点のため描画位置は崩れない）。
    const canvas = (layer as unknown as { _canvas: HTMLCanvasElement })._canvas
    map.getPane('quake-heat')?.appendChild(canvas)

    // leaflet.heat は 'moveend' でのみ再描画するため、flyTo 等のアニメーション中は
    // 地図の動きに追従できず一瞬置いていかれる。PsWaveLayer 同様 'move'（アニメーション中も
    // 連続発火）にも追従させ、常時位置を合わせる。
    const reset = (layer as unknown as { _reset: () => void })._reset.bind(layer)
    map.on('move', reset)

    return () => {
      map.off('move', reset)
      // onRemove は canvas が overlayPane の子であることを前提に removeChild するため、
      // 付け替えたままだと例外になる。removeLayer 前に元へ戻す。
      map.getPane('overlayPane')?.appendChild(canvas)
      map.removeLayer(layer)
    }
  }, [map, points])

  return null
}
