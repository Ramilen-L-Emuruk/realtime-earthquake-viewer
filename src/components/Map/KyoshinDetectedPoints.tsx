import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { DetectedPoint } from '../../hooks/useKyoshinDetection'
import { kyoshinIndexToJma, kyoshinIntensityColor } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'

const SVG_NS = 'http://www.w3.org/2000/svg'

// 揺れ検知済み（確定）観測点を SVG で描画するレイヤー。
// Canvas ではなく SVG を使うことで flyTo/ズームアニメーション中の再合成コストが発生しない
// （理由は KyoshinPoints 参照）。points は検知中のみの少数（最大でも数十点程度）なので、
// KyoshinPoints/KyoshinSubThreshold のような差分更新はせず、更新のたびに中身を作り直す
// （元の Canvas 実装と同じく毎回フルクリア＋再描画）。
export function KyoshinDetectedPoints({
  points,
  iconScale,
}: {
  points: DetectedPoint[]
  iconScale: number
}) {
  const map = useMap()
  const svgRef = useRef<SVGSVGElement | null>(null)

  useEffect(() => {
    const pane = map.getPane('kyoshin-points')
    if (!pane) return
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.style.position = 'absolute'
    svg.style.pointerEvents = 'none'
    svg.style.transformOrigin = '0 0'
    svg.style.overflow = 'visible'
    pane.appendChild(svg)
    svgRef.current = svg
    return () => {
      svg.remove()
      svgRef.current = null
    }
  }, [map])

  useEffect(() => {
    const draw = () => {
      const svg = svgRef.current
      if (!svg) return
      const size = map.getSize()
      svg.setAttribute('width', String(size.x))
      svg.setAttribute('height', String(size.y))
      // L.DomUtil.setPosition は型定義上 HTMLElement を要求するが、実装は style.transform の
      // 書き換えのみで SVGElement でも問題なく動作する。
      L.DomUtil.setPosition(svg as unknown as HTMLElement, map.containerPointToLayerPoint([0, 0]))
      while (svg.firstChild) svg.removeChild(svg.firstChild)

      // 震度の低い点から描画し、高い点を上に重ねる
      const sorted = [...points].sort((a, b) => a.index - b.index)
      for (const p of sorted) {
        const pt = map.latLngToContainerPoint(L.latLng(p.lat, p.lng))
        const color = kyoshinIntensityColor(p.index) ?? '#ffffff'
        const jma = kyoshinIndexToJma(p.index)
        const radius = jma && jma.label !== '0' ? (getScaleRadius(jma.scale) + 2) * iconScale : 2.5 * iconScale
        const circle = document.createElementNS(SVG_NS, 'circle')
        circle.setAttribute('cx', String(pt.x))
        circle.setAttribute('cy', String(pt.y))
        circle.setAttribute('r', String(radius))
        circle.setAttribute('fill', color)
        svg.appendChild(circle)
      }
    }

    const onZoomAnim = (e: L.ZoomAnimEvent) => {
      const svg = svgRef.current
      if (!svg) return
      const scale = map.getZoomScale(e.zoom)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const offset = (map as any)._latLngBoundsToNewLayerBounds(map.getBounds(), e.zoom, e.center).min
      L.DomUtil.setTransform(svg as unknown as HTMLElement, offset, scale)
    }

    draw()
    map.on('viewreset zoomend move', draw)
    map.on('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    return () => {
      map.off('viewreset zoomend move', draw)
      map.off('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    }
  }, [map, points, iconScale])

  return null
}
