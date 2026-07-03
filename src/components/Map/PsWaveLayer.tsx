import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { PsWaveCircle } from '../../services/kyoshin'
import { computeSWaveRadiusAtTime, computeSWaveTravelTimeSec } from '../../hooks/useDmdssWaves'
import { calcShakingDurationSec, S_WAVE_FALLBACK_KM_PER_SEC } from '../../utils/eew'

// 後端フェードの幅[km]（固定）。sPx全体に対する割合にすると、後端境界が
// 円の中心付近にある間はフェード帯が円の大半を覆ってしまい、境界出現時に
// 急に穴が空いたように見えるため、常に一定幅でなめらかに遷移させる。
const TRAILING_EDGE_FADE_KM = 15

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
          const durationSec = calcShakingDurationSec(c.magnitude, c.sRadius)
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
          ctx.lineWidth = 2

          if (sInnerRadiusKm > 0 && sInnerRadiusKm < c.sRadius) {
            // 後端（揺れ継続時間を過ぎた領域）を透明にフェードさせる。
            // フェード帯は innerPx から固定幅(TRAILING_EDGE_FADE_KM)分だけ外側までとし、
            // それより外は不透明（Canvasのグラデーションはstop 1.0以降を最終色で塗る）。
            const lonOffsetInner = (sInnerRadiusKm * 1000) / (111320 * cosLat)
            const edgeInner = map.latLngToContainerPoint(L.latLng(c.lat, c.lng + lonOffsetInner))
            const innerPx = Math.abs(edgeInner.x - center.x)
            const lonOffsetFadeOuter = ((sInnerRadiusKm + TRAILING_EDGE_FADE_KM) * 1000) / (111320 * cosLat)
            const edgeFadeOuter = map.latLngToContainerPoint(L.latLng(c.lat, c.lng + lonOffsetFadeOuter))
            const fadeOuterPx = Math.min(Math.abs(edgeFadeOuter.x - center.x), sPx)
            const gradient = ctx.createRadialGradient(center.x, center.y, innerPx, center.x, center.y, fadeOuterPx)
            gradient.addColorStop(0, 'rgba(255, 60, 0, 0)')
            gradient.addColorStop(1, 'rgba(255, 60, 0, 0.12)')
            ctx.fillStyle = gradient
          } else {
            ctx.fillStyle = 'rgba(255, 60, 0, 0.12)'
          }

          ctx.beginPath()
          ctx.arc(center.x, center.y, sPx, 0, Math.PI * 2)
          ctx.fill()
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
