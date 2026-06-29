import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import { getLpgmClassColor } from '../../utils/lpgm'
import type { LatLng } from '../../utils/stationCoords'

interface Point {
  position: LatLng
  lgInt: number
}

interface Props {
  /** 長周期地震動階級の弱い順（強い階級を後＝前面に描画する想定） */
  markers: Point[]
  iconScale: number
}

// 長周期地震動観測点を Canvas の色付きドットで描画するレイヤー。
// 階級 1〜4 を JMA 公式色（黄・橙・赤・暗赤）で表現。
export function LpgmPoints({ markers, iconScale }: Props) {
  const map = useMap()
  const groupRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    const renderer = L.canvas({ padding: 0.5 })
    const group = L.layerGroup()
    for (const m of markers) {
      L.circleMarker(m.position, {
        renderer,
        radius: 5 * iconScale,
        weight: 1,
        color: 'rgba(255,255,255,0.7)',
        fillColor: getLpgmClassColor(m.lgInt),
        fillOpacity: 0.9,
      }).addTo(group)
    }
    group.addTo(map)
    groupRef.current = group
    return () => {
      group.remove()
      groupRef.current = null
    }
  }, [markers, iconScale, map])

  return null
}
