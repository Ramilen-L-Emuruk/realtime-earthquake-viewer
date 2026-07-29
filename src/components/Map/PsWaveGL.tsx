import { useEffect, useRef } from 'react'
import { useMapGL } from './mapGLContext'
import type { PsWaveCircle } from '../../services/kyoshin'
import { computeSWaveRadiusAtTime, computeSWaveTravelTimeSec } from '../../hooks/usePsWaveCalc'
import { calcShakingDurationSec, S_WAVE_FALLBACK_KM_PER_SEC } from '../../utils/eew'

// 緊急地震速報の予報円（S波=塗りつぶし＋後端フェード / P波=破線外周）を描画する MapLibre 版
// （Leaflet 版 PsWaveLayer 相当）。MapLibre のレイヤーでは km 半径の円＋動的グラデーションを
// そのまま表現しづらいため、コンテナ上にオーバーレイ canvas を重ね、map.project で lng/lat→px を
// 得て 2D で描画する（Leaflet 版が latLngToContainerPoint で行っていたのと同じ手法）。
// カメラ移動（move）とデータ更新のたびに再描画する。予報円は実 EEW 発報時のみ値が入る。

// 後端フェード（揺れ継続時間を過ぎた領域）の幅パラメータ（Leaflet 版と一致）。
const TRAILING_EDGE_FADE_RATIO = 0.2
const TRAILING_EDGE_FADE_MIN_KM = 15

interface Props {
  psWave: PsWaveCircle[]
}

export function PsWaveGL({ psWave }: Props) {
  const map = useMapGL()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const psWaveRef = useRef<PsWaveCircle[]>(psWave)
  const drawRef = useRef<(() => void) | null>(null)
  psWaveRef.current = psWave

  useEffect(() => {
    if (!map) return
    const canvas = document.createElement('canvas')
    canvas.style.position = 'absolute'
    canvas.style.top = '0'
    canvas.style.left = '0'
    canvas.style.pointerEvents = 'none'
    map.getCanvasContainer().appendChild(canvas)
    canvasRef.current = canvas

    const draw = () => {
      const container = map.getContainer()
      const w = container.clientWidth
      const h = container.clientHeight
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      for (const c of psWaveRef.current) {
        const center = map.project([c.lng, c.lat])
        // 東方向（同一緯度）で km→px 変換（北方向だと Mercator のスケール係数が緯度で変動するため）。
        const cosLat = Math.cos((c.lat * Math.PI) / 180)

        if (c.sRadius > 0) {
          const durationSec = calcShakingDurationSec(c.magnitude, c.sRadius)
          let sInnerRadiusKm = 0
          if (c.depth !== undefined) {
            const tNow = computeSWaveTravelTimeSec(c.sRadius, c.depth)
            const tTrailing = tNow - durationSec
            sInnerRadiusKm = tTrailing > 0 ? computeSWaveRadiusAtTime(tTrailing, c.depth) : 0
          } else {
            sInnerRadiusKm = Math.max(0, c.sRadius - S_WAVE_FALLBACK_KM_PER_SEC * durationSec)
          }

          const lonOffsetS = (c.sRadius * 1000) / (111320 * cosLat)
          const edgeS = map.project([c.lng + lonOffsetS, c.lat])
          const sPx = Math.abs(edgeS.x - center.x)

          ctx.setLineDash([])
          ctx.strokeStyle = '#ff3c00'
          ctx.lineWidth = 2

          if (sInnerRadiusKm > 0 && sInnerRadiusKm < c.sRadius) {
            const lonOffsetInner = (sInnerRadiusKm * 1000) / (111320 * cosLat)
            const edgeInner = map.project([c.lng + lonOffsetInner, c.lat])
            const innerPx = Math.abs(edgeInner.x - center.x)
            const fadeWidthKm = Math.max(TRAILING_EDGE_FADE_MIN_KM, c.sRadius * TRAILING_EDGE_FADE_RATIO)
            const lonOffsetFadeOuter = ((sInnerRadiusKm + fadeWidthKm) * 1000) / (111320 * cosLat)
            const edgeFadeOuter = map.project([c.lng + lonOffsetFadeOuter, c.lat])
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
          const edgeP = map.project([c.lng + lonOffsetP, c.lat])
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

    // カメラ移動（move は pan/zoom/rotate すべてで連続発火）と再描画要求で描き直す。
    draw()
    map.on('move', draw)
    map.on('resize', draw)
    // psWave 更新時にも描き直せるよう ref を露出（下の effect が呼ぶ）。
    drawRef.current = draw
    return () => {
      map.off('move', draw)
      map.off('resize', draw)
      drawRef.current = null
      canvas.remove()
      canvasRef.current = null
    }
  }, [map])

  // データ更新時に再描画（psWaveRef は同期済み）。
  useEffect(() => {
    drawRef.current?.()
  }, [psWave])

  return null
}
