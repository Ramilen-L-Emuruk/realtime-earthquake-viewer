import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import { getIntensityColor, getScaleRadius } from '../../utils/intensity'
import type { LatLng } from '../../utils/stationCoords'
import { MAP_CANVAS_PADDING } from './mapCanvasPadding'

interface Point {
  position: LatLng
  scale: number
}

interface Props {
  /** 震度の弱い順（強い震度を後＝前面に描画する想定） */
  markers: Point[]
  iconScale: number
}

// 地震情報タブの各地点の震度を SVG の色付きドットで描画するレイヤー。
// 大きな地震では観測点が数百〜数千になり divIcon では重いため、SVG に集約して軽量化する。
// （震度は色と大きさで表現。数字・クリックポップアップは持たない）
// Canvas ではなく SVG レンダラー（L.svg）を使うことで、flyTo/ズームアニメーション中に
// 大きな Canvas バッファを再合成するコストが発生しない（理由は KyoshinPoints.tsx 参照。
// このため専用ペイン quake-points は flyToLite.ts の HIDDEN_DURING_FLY_PANES に含めていない）。
export function IntensityPoints({ markers, iconScale }: Props) {
  const map = useMap()
  const groupRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    const renderer = L.svg({ pane: 'quake-points', padding: MAP_CANVAS_PADDING })
    const group = L.layerGroup()
    // markers は震度の弱い順。先に弱い点、後に強い点を描くことで強い震度が前面に出る。
    for (const m of markers) {
      L.circleMarker(m.position, {
        renderer,
        radius: (getScaleRadius(m.scale) + 3) * iconScale,
        weight: 1,
        color: 'rgba(255,255,255,0.7)',
        fillColor: getIntensityColor(m.scale),
        fillOpacity: 0.9,
        interactive: false,
      }).addTo(group)
    }
    group.addTo(map)
    groupRef.current = group
    return () => {
      group.remove()
      renderer.remove()
      groupRef.current = null
    }
  }, [markers, iconScale, map])

  return null
}
