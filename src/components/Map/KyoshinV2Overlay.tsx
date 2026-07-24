import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { DetectionEvent } from '../../utils/kyoshinDetector'

const SVG_NS = 'http://www.w3.org/2000/svg'

// 検知エンジンの検知イベントを地図に重ねるオーバーレイ。
// 自動フィットはメンバー観測点に対して行う（本オーバーレイはイベント中心の可視化のみを担う）。
// confirmed / likely / faint を描画（weak は非表示＝カード表示と同基準）。faint（震度0級・無音）は
// 淡色・非脈動で控えめに描く。中心はメンバー観測点の重心（近傍一致型のため震源推定はしない・任意の目印）。
//
// 描画方式は KyoshinDetectedPoints を踏襲（生 SVG を pane に appendChild。flyTo/ズーム中は
// svg 全体の transform 1 回で追従し毎フレームの DOM 再構築を避ける）。理由は同ファイル参照。

// confirmed=赤・likely=橙・faint=淡青（震度0級・無音の控えめ表示）
type OverlayTier = 'confirmed' | 'likely' | 'faint'
const TIER_COLOR: Record<OverlayTier, string> = {
  confirmed: '#ef4444',
  likely: '#f59e0b',
  faint: '#60a5fa',
}
// confirmed を最前面、faint を最背面に描く
const TIER_Z: Record<OverlayTier, number> = { faint: 0, likely: 1, confirmed: 2 }

export function KyoshinV2Overlay({
  detections,
  iconScale,
}: {
  detections: DetectionEvent[]
  iconScale: number
}) {
  const map = useMap()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const drawStateRef = useRef<{ zoom: number; bounds: L.LatLngBounds } | null>(null)
  const zoomingRef = useRef(false)

  useEffect(() => {
    const pane = map.getPane('kyoshin-v2')
    if (!pane) return
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.style.position = 'absolute'
    svg.style.pointerEvents = 'none'
    svg.style.transformOrigin = '0 0'
    svg.style.overflow = 'visible'
    svg.classList.add('leaflet-zoom-animated')
    pane.appendChild(svg)
    svgRef.current = svg
    const onZoomStart = () => { zoomingRef.current = true }
    const onZoomEnd = () => { zoomingRef.current = false }
    map.on('zoomstart', onZoomStart)
    map.on('zoomend', onZoomEnd)
    return () => {
      map.off('zoomstart', onZoomStart)
      map.off('zoomend', onZoomEnd)
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
      L.DomUtil.setPosition(svg as unknown as HTMLElement, map.containerPointToLayerPoint([0, 0]))
      drawStateRef.current = { zoom: map.getZoom(), bounds: map.getBounds() }
      while (svg.firstChild) svg.removeChild(svg.firstChild)

      const events = detections.filter(
        (d): d is DetectionEvent & { confidence: OverlayTier } =>
          (d.confidence === 'confirmed' || d.confidence === 'likely' || d.confidence === 'faint') &&
          d.epicenter != null,
      )
      const sorted = [...events].sort((a, b) => TIER_Z[a.confidence] - TIER_Z[b.confidence])
      const s = iconScale
      for (const ev of sorted) {
        const [lat, lng] = ev.epicenter as [number, number]
        const pt = map.latLngToContainerPoint(L.latLng(lat, lng))
        const color = TIER_COLOR[ev.confidence]
        const faint = ev.confidence === 'faint'

        // 中心（メンバー重心）を不確実性の破線円で表現（震源推定ではない目印）
        const ring = mkCircle(pt.x, pt.y, 22 * s, color)
        ring.setAttribute('fill', 'none')
        ring.setAttribute('stroke-width', String((faint ? 1.5 : 2) * s))
        ring.setAttribute('stroke-dasharray', `${4 * s} ${3 * s}`)
        ring.setAttribute('opacity', faint ? '0.45' : '0.8')
        svg.appendChild(ring)

        // 脈動する外周リング（注意喚起）。faint は無音・控えめのため脈動させない。
        if (!faint) {
          const pulse = mkCircle(pt.x, pt.y, 12 * s, color)
          pulse.setAttribute('fill', 'none')
          pulse.setAttribute('stroke-width', String(2.5 * s))
          pulse.setAttribute('class', 'animate-pulse')
          svg.appendChild(pulse)
        }

        // 中心のドット
        const dot = mkCircle(pt.x, pt.y, (faint ? 3.5 : 4.5) * s, color)
        dot.setAttribute('fill', color)
        dot.setAttribute('stroke', '#ffffff')
        dot.setAttribute('stroke-width', String(1 * s))
        dot.setAttribute('opacity', faint ? '0.7' : '1')
        svg.appendChild(dot)
      }
    }

    const applyViewTransform = (zoom: number, center: L.LatLng) => {
      const svg = svgRef.current
      const state = drawStateRef.current
      if (!svg || !state) return
      const scale = map.getZoomScale(zoom, state.zoom)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const offset = (map as any)._latLngBoundsToNewLayerBounds(state.bounds, zoom, center).min
      L.DomUtil.setTransform(svg as unknown as HTMLElement, offset, scale)
    }

    const onMove = () => {
      if (zoomingRef.current) applyViewTransform(map.getZoom(), map.getCenter())
    }
    const onZoomAnim = (e: L.ZoomAnimEvent) => applyViewTransform(e.zoom, e.center)

    draw()
    map.on('viewreset moveend', draw)
    map.on('move', onMove)
    map.on('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    return () => {
      map.off('viewreset moveend', draw)
      map.off('move', onMove)
      map.off('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    }
  }, [map, detections, iconScale])

  return null
}

function mkCircle(cx: number, cy: number, r: number, stroke: string): SVGCircleElement {
  const c = document.createElementNS(SVG_NS, 'circle')
  c.setAttribute('cx', String(cx))
  c.setAttribute('cy', String(cy))
  c.setAttribute('r', String(r))
  c.setAttribute('stroke', stroke)
  return c
}
