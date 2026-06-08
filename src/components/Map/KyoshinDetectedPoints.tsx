import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { DetectedPoint } from '../../hooks/useKyoshinDetection'
import { kyoshinIntensityColor } from '../../utils/kyoshinIntensity'

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

      const radius = 10 * iconScale
      for (const p of points) {
        const pt = map.latLngToContainerPoint(L.latLng(p.lat, p.lng))
        const color = kyoshinIntensityColor(p.index) ?? '#ffffff'
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.globalAlpha = 0.85
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }

    draw()
    map.on('viewreset zoomend move', draw)
    return () => {
      map.off('viewreset zoomend move', draw)
    }
  }, [map, points, iconScale])

  return null
}
