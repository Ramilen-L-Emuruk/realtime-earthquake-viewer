import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import type { SiteCoords } from '../../services/kyoshin'
import { SHINDO0_COLOR } from '../../utils/kyoshinIntensity'

interface Props {
  sites: SiteCoords
  indices: number[]
  iconScale: number
}

// index 0〜6（震度0以下）を対象とする最大インデックス
const MAX_SUB_IDX = 6
// 観測点のドット半径（KyoshinPoints と共通）
const BASE_RADIUS = 2.5

// 指数関数カーブで不透明度を算出: index 0 → 0、index 6 → 0.35
// 低いほど透明になり、かつ重なっても濃くならない（OffscreenCanvas 合成）
function subThresholdOpacity(idx: number): number {
  if (idx <= 0) return 0
  const t = idx / MAX_SUB_IDX
  return ((Math.exp(t) - 1) / (Math.E - 1)) * 0.35
}

// 強震モニタの震度0以下（index 1〜6）を OffscreenCanvas を使って描画するレイヤー。
// 同レベルのドットはオフスクリーンに全不透明で描き、グループ単位で alpha 合成するため
// 重なりによる alpha 加算（accumulation）が起きない。
export function KyoshinSubThreshold({ sites, indices, iconScale }: Props) {
  const map = useMap()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawFnRef = useRef<() => void>(() => {})

  // drawFn を最新 props で常に更新（stale closure 回避）
  useEffect(() => {
    drawFnRef.current = () => {
      const canvas = canvasRef.current
      if (!canvas || sites.length === 0) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const radius = BASE_RADIUS * iconScale

      for (let level = 1; level <= MAX_SUB_IDX; level++) {
        const opacity = subThresholdOpacity(level)
        const offscreen = new OffscreenCanvas(canvas.width, canvas.height)
        const offCtx = offscreen.getContext('2d')!
        offCtx.fillStyle = SHINDO0_COLOR

        let hasPoints = false
        for (let i = 0; i < sites.length; i++) {
          if (indices[i] !== level) continue
          const pt = map.latLngToContainerPoint(L.latLng(sites[i][0], sites[i][1]))
          offCtx.beginPath()
          offCtx.arc(pt.x, pt.y, radius, 0, Math.PI * 2)
          offCtx.fill()
          hasPoints = true
        }

        if (!hasPoints) continue
        ctx.globalAlpha = opacity
        ctx.drawImage(offscreen, 0, 0)
      }

      ctx.globalAlpha = 1
    }
  }, [sites, indices, iconScale, map])

  // canvas ライフサイクル: sites 取得後に overlayPane へ追加し、地図イベントで再描画
  useEffect(() => {
    if (sites.length === 0) return
    const pane = map.getPane('overlayPane')
    if (!pane) return

    const canvas = document.createElement('canvas')
    canvas.style.pointerEvents = 'none'
    pane.appendChild(canvas)
    canvasRef.current = canvas

    const onViewReset = () => {
      const size = map.getSize()
      canvas.width = size.x
      canvas.height = size.y
      const topLeft = map.containerPointToLayerPoint([0, 0])
      L.DomUtil.setPosition(canvas, topLeft)
      drawFnRef.current()
    }

    const onMove = () => {
      const topLeft = map.containerPointToLayerPoint([0, 0])
      L.DomUtil.setPosition(canvas, topLeft)
      drawFnRef.current()
    }

    map.on('viewreset', onViewReset)
    map.on('zoomend', onViewReset)
    map.on('move', onMove)
    onViewReset()

    return () => {
      map.off('viewreset', onViewReset)
      map.off('zoomend', onViewReset)
      map.off('move', onMove)
      canvas.remove()
      canvasRef.current = null
    }
  }, [sites, map])

  // データ変化時のみ再描画（位置・サイズ変更は不要）
  useEffect(() => {
    drawFnRef.current()
  }, [indices, iconScale])

  return null
}
