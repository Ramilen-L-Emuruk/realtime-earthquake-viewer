import { useCallback, useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { SiteCoords } from '../../services/kyoshin'
import { kyoshinIntensityColor, kyoshinIndexToJma } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'

const DURATION = 600
const MIN_TRIGGER_INDEX = 7

interface Ripple {
  lat: number
  lng: number
  color: string
  startTime: number
  baseRadius: number
}

export function KyoshinMaxEffect({
  sites,
  indices,
  iconScale,
}: {
  sites: SiteCoords
  indices: number[]
  iconScale: number
}) {
  const map = useMap()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ripplesRef = useRef<Ripple[]>([])
  const rafRef = useRef<number | null>(null)
  const prevMaxIdxRef = useRef<number>(-1)

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

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return

    const loop = () => {
      const canvas = canvasRef.current
      if (!canvas) {
        rafRef.current = null
        return
      }
      const now = performance.now()
      const size = map.getSize()
      canvas.width = size.x
      canvas.height = size.y
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        rafRef.current = null
        return
      }

      ripplesRef.current = ripplesRef.current.filter((r) => now - r.startTime < DURATION)
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      for (const r of ripplesRef.current) {
        const t = (now - r.startTime) / DURATION
        const eased = 1 - (1 - t) * (1 - t)
        const radius = r.baseRadius + r.baseRadius * 3 * eased
        const alpha = 0.75 * (1 - t)
        const pt = map.latLngToContainerPoint(L.latLng(r.lat, r.lng))
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2)
        ctx.strokeStyle = r.color
        ctx.lineWidth = 2.5
        ctx.globalAlpha = alpha
        ctx.stroke()
      }

      if (ripplesRef.current.length > 0) {
        rafRef.current = requestAnimationFrame(loop)
      } else {
        rafRef.current = null
      }
    }

    rafRef.current = requestAnimationFrame(loop)
  }, [map])

  useEffect(() => {
    if (indices.length === 0 || sites.length === 0) return

    let maxIdx = -1
    let maxSiteIdx = -1
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] > maxIdx) {
        maxIdx = indices[i]
        maxSiteIdx = i
      }
    }

    // 再生リセット・データソース切替で最大値が大幅に下落した場合は前回最大をリセット
    if (maxIdx < prevMaxIdxRef.current - 5) {
      prevMaxIdxRef.current = maxIdx
      return
    }

    if (maxIdx >= MIN_TRIGGER_INDEX && maxIdx > prevMaxIdxRef.current && maxSiteIdx >= 0) {
      const [lat, lng] = sites[maxSiteIdx]
      const color = kyoshinIntensityColor(maxIdx) ?? '#ffffff'
      const jma = kyoshinIndexToJma(maxIdx)
      const baseRadius = jma ? (getScaleRadius(jma.scale) + 2) * iconScale : 3 * iconScale
      ripplesRef.current = [
        ...ripplesRef.current,
        { lat, lng, color, startTime: performance.now(), baseRadius },
      ]
      startLoop()
    }

    prevMaxIdxRef.current = maxIdx
  }, [indices, sites, iconScale, startLoop])

  useEffect(() => {
    const onZoomAnim = (e: L.ZoomAnimEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const scale = map.getZoomScale(e.zoom)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const offset = (map as any)._latLngBoundsToNewLayerBounds(map.getBounds(), e.zoom, e.center).min
      L.DomUtil.setTransform(canvas, offset, scale)
    }
    map.on('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    return () => {
      map.off('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    }
  }, [map])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  return null
}
