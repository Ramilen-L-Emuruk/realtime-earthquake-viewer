import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { DetectedPoint } from '../../hooks/useKyoshinDetection'
import { kyoshinIndexToJma, kyoshinIntensityColor } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'

export function KyoshinDetectedPoints({
  points,
  iconScale,
}: {
  points: DetectedPoint[]
  iconScale: number
}) {
  const map = useMap()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.style.position = 'absolute'
    canvas.style.pointerEvents = 'none'
    map.getPanes().overlayPane?.appendChild(canvas)
    canvasRef.current = canvas
    return () => {
      canvas.remove()
      canvasRef.current = null
    }
  }, [map])

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const size = map.getSize()
      canvas.width = size.x
      canvas.height = size.y
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // 震度の低い点から描画し、高い点を上に重ねる
      const sorted = [...points].sort((a, b) => a.index - b.index)
      for (const p of sorted) {
        const pt = map.latLngToContainerPoint(L.latLng(p.lat, p.lng))
        const color = kyoshinIntensityColor(p.index) ?? '#ffffff'
        const jma = kyoshinIndexToJma(p.index)
        const radius = jma && jma.label !== '0' ? (getScaleRadius(jma.scale) + 2) * iconScale : 2.5 * iconScale
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.globalAlpha = 1
        ctx.fill()
      }
    }

    const onZoomAnim = (e: L.ZoomAnimEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const scale = map.getZoomScale(e.zoom)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const offset = (map as any)._latLngBoundsToNewLayerBounds(map.getBounds(), e.zoom, e.center).min
      L.DomUtil.setTransform(canvas, offset, scale)
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
