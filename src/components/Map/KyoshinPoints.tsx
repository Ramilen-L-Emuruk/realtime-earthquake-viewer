import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import type { SiteCoords } from '../../services/kyoshin'
import { kyoshinColor } from '../../utils/kyoshinColor'

interface Props {
  sites: SiteCoords
  indices: number[]
  iconScale: number
}

// 強震モニタの観測点（約1725点）を Canvas で描画するレイヤー。
// マーカーは観測点リスト取得時に一度だけ生成し、毎秒の更新は色（と半径）の
// 変更のみ行うことで、React の再レンダリングコストを避ける。
export function KyoshinPoints({ sites, indices, iconScale }: Props) {
  const map = useMap()
  const markersRef = useRef<L.CircleMarker[]>([])

  // 観測点が揃ったら一度だけマーカーを生成して地図に追加する
  useEffect(() => {
    if (sites.length === 0) return
    const renderer = L.canvas({ padding: 0.5 })
    const group = L.layerGroup()
    const markers = sites.map(([lat, lng]) =>
      L.circleMarker([lat, lng], {
        renderer,
        radius: 2.5 * iconScale,
        stroke: false,
        fillOpacity: 0.85,
        fillColor: kyoshinColor(undefined),
      }),
    )
    markers.forEach((m) => m.addTo(group))
    group.addTo(map)
    markersRef.current = markers
    return () => {
      group.remove()
      markersRef.current = []
    }
    // sites は初回取得後は不変。map も不変。
  }, [sites, map])

  // 震度インデックスの更新時に各マーカーの色を更新
  useEffect(() => {
    const markers = markersRef.current
    if (markers.length === 0) return
    for (let i = 0; i < markers.length; i++) {
      markers[i].setStyle({ fillColor: kyoshinColor(indices[i]) })
    }
  }, [indices])

  // UI 倍率の変更時に各マーカーの半径を更新
  useEffect(() => {
    markersRef.current.forEach((m) => m.setRadius(2.5 * iconScale))
  }, [iconScale])

  return null
}
