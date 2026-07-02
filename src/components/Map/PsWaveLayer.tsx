import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { PsWaveCircle } from '../../services/kyoshin'
import { computeSWaveRadiusAtTime, computeSWaveTravelTimeSec } from '../../hooks/useDmdssWaves'
import { calcShakingDurationSec, S_WAVE_FALLBACK_KM_PER_SEC } from '../../utils/eew'

export function PsWaveLayer({ psWave }: { psWave: PsWaveCircle[] }) {
  const map = useMap()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.style.position = 'absolute'
    canvas.style.pointerEvents = 'none'
    canvas.style.transformOrigin = '0 0'
    map.getPane('ps-wave')?.appendChild(canvas)
    canvasRef.current = canvas
    return () => {
      canvas.remove()
      canvasRef.current = null
    }
  }, [map])

  useEffect(() => {
    const isZoomAnimating = { current: false }

    const draw = () => {
      if (isZoomAnimating.current) return
      const canvas = canvasRef.current
      if (!canvas) return
      const size = map.getSize()
      canvas.width = size.x
      canvas.height = size.y
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      for (const c of psWave) {
        const center = map.latLngToContainerPoint(L.latLng(c.lat, c.lng))
        // 東方向（同一緯度）で km→ピクセル変換。北方向だと Mercator のスケール係数が
        // 緯度上昇で増加し、円が haversine 距離より大きく描かれるため。
        const cosLat = Math.cos(c.lat * Math.PI / 180)

        if (c.sRadius > 0) {
          const durationSec = calcShakingDurationSec(c.magnitude)
          let sInnerRadiusKm = 0

          if (c.depth !== undefined) {
            // DMDSS版: 解析的走時モデルで「durationSec秒前の波面半径」を逆算
            const tNow = computeSWaveTravelTimeSec(c.sRadius, c.depth)
            const tTrailing = tNow - durationSec
            sInnerRadiusKm = tTrailing > 0 ? computeSWaveRadiusAtTime(tTrailing, c.depth) : 0
          } else {
            // Yahoo版: depth が無いため定速フォールバックで後端半径を近似
            sInnerRadiusKm = Math.max(0, c.sRadius - S_WAVE_FALLBACK_KM_PER_SEC * durationSec)
          }

          const lonOffsetS = (c.sRadius * 1000) / (111320 * cosLat)
          const edgeS = map.latLngToContainerPoint(L.latLng(c.lat, c.lng + lonOffsetS))
          const sPx = Math.abs(edgeS.x - center.x)

          ctx.setLineDash([])
          ctx.strokeStyle = '#ff3c00'
          ctx.fillStyle = 'rgba(255, 60, 0, 0.12)'
          ctx.lineWidth = 2

          ctx.beginPath()
          ctx.arc(center.x, center.y, sPx, 0, Math.PI * 2)
          if (sInnerRadiusKm > 0) {
            const lonOffsetInner = (sInnerRadiusKm * 1000) / (111320 * cosLat)
            const edgeInner = map.latLngToContainerPoint(L.latLng(c.lat, c.lng + lonOffsetInner))
            const innerPx = Math.abs(edgeInner.x - center.x)
            ctx.moveTo(center.x + innerPx, center.y)
            ctx.arc(center.x, center.y, innerPx, 0, Math.PI * 2, true) // 逆回りにしてevenoddで穴あけ
          }
          ctx.fill('evenodd')

          ctx.beginPath()
          ctx.arc(center.x, center.y, sPx, 0, Math.PI * 2)
          ctx.stroke()
        }

        if (c.pRadius > 0) {
          const lonOffsetP = (c.pRadius * 1000) / (111320 * cosLat)
          const edgeP = map.latLngToContainerPoint(L.latLng(c.lat, c.lng + lonOffsetP))
          const pPx = Math.abs(edgeP.x - center.x)
          ctx.setLineDash([4, 4])
          ctx.strokeStyle = '#38bdf8'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(center.x, center.y, pPx, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    }

    const onZoomStart = () => { isZoomAnimating.current = true }
    const onZoomEnd = () => {
      isZoomAnimating.current = false
      draw()
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
    map.on('viewreset move', draw)
    map.on('zoomstart', onZoomStart)
    map.on('zoomend', onZoomEnd)
    map.on('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    return () => {
      map.off('viewreset move', draw)
      map.off('zoomstart', onZoomStart)
      map.off('zoomend', onZoomEnd)
      map.off('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    }
  }, [map, psWave])

  return null
}
