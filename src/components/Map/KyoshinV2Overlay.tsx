import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { DetectionEvent } from '../../utils/kyoshinDetector'

const SVG_NS = 'http://www.w3.org/2000/svg'

// 新検知エンジン(v2)の検知イベントを地図に重ねる視覚オーバーレイ（実験的）。
// 音・自動タブ切替・自動フィットには一切関与しない（App 側で分離済み）。
// confirmed / likely のみ描画（weak は平常時ノイズが多いため除外＝カード表示と同基準）。
// 震央は最早オンセット点（＝最短距離の点）。片側配置(type-B)では距離が不確実なので、
// 破線円の代わりに bearing 方向へ矢印を伸ばして「震源はこちら・距離は不確実」を示す。
//
// 描画方式は KyoshinDetectedPoints を踏襲（生 SVG を pane に appendChild。flyTo/ズーム中は
// svg 全体の transform 1 回で追従し毎フレームの DOM 再構築を避ける）。理由は同ファイル参照。

const TIER_COLOR: Record<'confirmed' | 'likely', string> = {
  confirmed: '#ef4444',
  likely: '#f59e0b',
}
// confirmed を likely より前面に描く
const TIER_Z: Record<'confirmed' | 'likely', number> = { likely: 0, confirmed: 1 }

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
        (d): d is DetectionEvent & { confidence: 'confirmed' | 'likely' } =>
          (d.confidence === 'confirmed' || d.confidence === 'likely') && d.epicenter != null,
      )
      const sorted = [...events].sort((a, b) => TIER_Z[a.confidence] - TIER_Z[b.confidence])
      const s = iconScale
      for (const ev of sorted) {
        const [lat, lng] = ev.epicenter as [number, number]
        const pt = map.latLngToContainerPoint(L.latLng(lat, lng))
        const color = TIER_COLOR[ev.confidence]

        if (ev.oneSided && ev.bearingDeg != null) {
          // 片側配置: 震源方位（真北0°時計回り）へ矢印。画面 y は下向き。
          const rad = (ev.bearingDeg * Math.PI) / 180
          const dx = Math.sin(rad)
          const dy = -Math.cos(rad)
          const near = 14 * s
          const far = 52 * s
          const x1 = pt.x + dx * near
          const y1 = pt.y + dy * near
          const x2 = pt.x + dx * far
          const y2 = pt.y + dy * far
          svg.appendChild(mkLine(x1, y1, x2, y2, color, 2.5 * s))
          // 矢じり（三角形）
          const head = 9 * s
          const halfW = 5 * s
          const bx = x2 - dx * head
          const by = y2 - dy * head
          const px = -dy
          const py = dx
          const poly = document.createElementNS(SVG_NS, 'polygon')
          poly.setAttribute(
            'points',
            `${x2},${y2} ${bx + px * halfW},${by + py * halfW} ${bx - px * halfW},${by - py * halfW}`,
          )
          poly.setAttribute('fill', color)
          svg.appendChild(poly)
        } else {
          // 震源を囲む配置: 不確実性を破線円で表現
          const ring = mkCircle(pt.x, pt.y, 22 * s, color)
          ring.setAttribute('fill', 'none')
          ring.setAttribute('stroke-width', String(2 * s))
          ring.setAttribute('stroke-dasharray', `${4 * s} ${3 * s}`)
          ring.setAttribute('opacity', '0.8')
          svg.appendChild(ring)
        }

        // 脈動する外周リング（注意喚起）
        const pulse = mkCircle(pt.x, pt.y, 12 * s, color)
        pulse.setAttribute('fill', 'none')
        pulse.setAttribute('stroke-width', String(2.5 * s))
        pulse.setAttribute('class', 'animate-pulse')
        svg.appendChild(pulse)

        // 震央中心のドット
        const dot = mkCircle(pt.x, pt.y, 4.5 * s, color)
        dot.setAttribute('fill', color)
        dot.setAttribute('stroke', '#ffffff')
        dot.setAttribute('stroke-width', String(1 * s))
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

function mkLine(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number): SVGLineElement {
  const l = document.createElementNS(SVG_NS, 'line')
  l.setAttribute('x1', String(x1))
  l.setAttribute('y1', String(y1))
  l.setAttribute('x2', String(x2))
  l.setAttribute('y2', String(y2))
  l.setAttribute('stroke', stroke)
  l.setAttribute('stroke-width', String(width))
  l.setAttribute('stroke-linecap', 'round')
  return l
}
