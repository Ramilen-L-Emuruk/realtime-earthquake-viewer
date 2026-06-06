import { useRef, useEffect } from 'react'
import type { KnetChannel } from '../../types/replay'

interface Props {
  channel: KnetChannel
  currentTime: Date | null
  height?: number
}

export function WaveformChart({ channel, currentTime, height = 56 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)

    // 背景
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, w, h)

    // ゼロライン
    ctx.strokeStyle = '#1e293b'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, h / 2)
    ctx.lineTo(w, h / 2)
    ctx.stroke()

    const { data } = channel
    if (data.length === 0) return

    // 再生済みエリアをハイライト（現在時刻まで）
    if (currentTime) {
      const elapsed = (currentTime.getTime() - channel.recordTime.getTime()) / 1000
      const ratio = Math.min(1, Math.max(0, elapsed / channel.durationSec))
      ctx.fillStyle = 'rgba(59, 130, 246, 0.07)'
      ctx.fillRect(0, 0, ratio * w, h)
    }

    // 波形描画（ピクセル幅にダウンサンプリング）
    const maxAbs = Math.max(Math.abs(channel.maxAccGal), 1)
    const margin = 4
    ctx.strokeStyle = '#60a5fa'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let px = 0; px < w; px++) {
      const idx = Math.floor((px / w) * data.length)
      const gal = data[Math.min(idx, data.length - 1)]
      const y = h / 2 - (gal / maxAbs) * ((h - margin * 2) / 2)
      if (px === 0) ctx.moveTo(px, y)
      else ctx.lineTo(px, y)
    }
    ctx.stroke()

    // 現在時刻マーカー
    if (currentTime) {
      const elapsed = (currentTime.getTime() - channel.recordTime.getTime()) / 1000
      const ratio = Math.min(1, Math.max(0, elapsed / channel.durationSec))
      const x = ratio * w
      ctx.strokeStyle = '#ef4444'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
  }, [channel, currentTime])

  return (
    <div>
      <div className="flex justify-between text-xs text-secondary mb-0.5 px-0.5">
        <span className="font-mono">{channel.direction}</span>
        <span>最大 {channel.maxAccGal.toFixed(1)} gal</span>
      </div>
      <canvas
        ref={canvasRef}
        width={320}
        height={height}
        className="w-full rounded block"
      />
    </div>
  )
}
