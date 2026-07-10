import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import type { PlateBoundarySegment } from '../../utils/plateBoundaries'

interface Props {
  plateBoundaries: PlateBoundarySegment[] | null
  visible: boolean
  renderer: L.Canvas
}

const SUBDUCTION_COLOR = '#b91c1c'
const OTHER_COLOR = '#1d4ed8'

function buildPlatePopupContent(seg: PlateBoundarySegment): HTMLElement {
  const container = document.createElement('div')
  container.className = 'text-sm'
  const title = document.createElement('div')
  title.className = 'font-bold'
  title.textContent = `${seg.plateA} – ${seg.plateB}`
  const subtitle = document.createElement('div')
  subtitle.className = 'text-gray-600 text-xs'
  subtitle.textContent = `プレート境界（${seg.type === 'subduction' ? '沈み込み境界' : '境界種別不明'}・PB2002モデル）`
  container.append(title, subtitle)
  return container
}

// 日本周辺のプレート境界線（PB2002モデル）を Leaflet ネイティブ API で描画するレイヤー。
// ActiveFaultsLayer と同じ理由（react-leaflet の宣言的 Polyline だと強震モニタの毎秒更新の
// たびに再レンダーされ重い）で、useMap + useEffect でマウント時に一度だけ構築する方式にしている。
// セグメント単位で1本の L.polyline（複数ラインをまとめた multi-polyline）にまとめている。
export function PlateBoundariesLayer({ plateBoundaries, visible, renderer }: Props) {
  const map = useMap()
  const groupRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    if (!plateBoundaries) return
    const group = L.layerGroup()
    for (const seg of plateBoundaries) {
      L.polyline(seg.lines, {
        renderer,
        color: seg.type === 'subduction' ? SUBDUCTION_COLOR : OTHER_COLOR,
        weight: 2,
        opacity: 0.55,
        dashArray: '6 4',
      })
        .bindPopup(buildPlatePopupContent(seg))
        .addTo(group)
    }
    groupRef.current = group
    return () => {
      group.remove()
      groupRef.current = null
    }
  }, [plateBoundaries, renderer])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    if (visible) {
      group.addTo(map)
    } else {
      group.remove()
    }
  }, [visible, map, plateBoundaries])

  return null
}
