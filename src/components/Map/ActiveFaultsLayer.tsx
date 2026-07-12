import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import type { ActiveFaultSegment } from '../../utils/activeFaults'

interface Props {
  activeFaults: ActiveFaultSegment[] | null
  visible: boolean
  /** 可視線を描く SVG レンダラー（flyTo 中も表示を維持するため SVG）。 */
  renderer: L.Renderer
  /** ポップアップの当たり判定用の透明 Canvas レンダラー（tolerance 付き）。 */
  hitRenderer: L.Renderer
}

const FAULT_COLOR = '#c2410c'

function buildFaultPopupContent(name: string): HTMLElement {
  const container = document.createElement('div')
  container.className = 'text-sm'
  const title = document.createElement('div')
  title.className = 'font-bold'
  title.textContent = name
  const subtitle = document.createElement('div')
  subtitle.className = 'text-gray-600 text-xs'
  subtitle.textContent = '活断層（産総研 活断層データベース）'
  container.append(title, subtitle)
  return container
}

// 全国活断層線（産総研 活断層データベース、約580セグメント・3,400本超のライン）を
// Leaflet ネイティブ API で描画するレイヤー。react-leaflet の宣言的 Polyline/Popup（本数分の
// React要素）を使うと、強震モニタの毎秒更新（indices等）で JapanMap が再レンダーされるたびに
// 全本数分の差分計算が走り重くなるため、useMap + useEffect でマウント時に一度だけ Leaflet
// レイヤーを構築し、以降は表示/非表示の切替のみ行う。
// セグメント単位で1本の L.polyline（複数ラインをまとめた multi-polyline）にまとめることで、
// Leaflet レイヤー数も本数分から seg 数分（約580）に削減している。
export function ActiveFaultsLayer({ activeFaults, visible, renderer, hitRenderer }: Props) {
  const map = useMap()
  const groupRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    if (!activeFaults) return
    const group = L.layerGroup()
    for (const seg of activeFaults) {
      // 可視線（SVG）。当たり判定は持たせず（interactive:false）、下記の透明ヒット線に委ねる。
      L.polyline(seg.lines, {
        renderer,
        color: FAULT_COLOR,
        weight: 1.2,
        opacity: 0.65,
        interactive: false,
      }).addTo(group)
      // 当たり判定用の透明線（Canvas, tolerance 付きレンダラー）。可視線と同一形状を opacity:0 で
      // 重ね、ポップアップはこちらに紐付ける。Canvas の tolerance により線から数pxずれても開く。
      L.polyline(seg.lines, {
        renderer: hitRenderer,
        weight: 1.2,
        opacity: 0,
      })
        .bindPopup(buildFaultPopupContent(seg.name))
        .addTo(group)
    }
    groupRef.current = group
    return () => {
      group.remove()
      groupRef.current = null
    }
  }, [activeFaults, renderer, hitRenderer])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    if (visible) {
      group.addTo(map)
    } else {
      group.remove()
    }
  }, [visible, map, activeFaults])

  return null
}
