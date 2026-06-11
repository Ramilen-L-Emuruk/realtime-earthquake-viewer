import { useEffect, useRef, useState } from 'react'
import type { PsWaveCircle } from '../services/kyoshin'
import { haversineKm } from '../utils/geo'

export interface SWaveArrival {
  distanceKm: number
  sRadiusKm: number
  etaSec: number | null  // 到達済みは 0、推定不能は null
  arrived: boolean
}

const S_WAVE_KM_PER_SEC = 4.0  // フォールバック速度定数
const SPEED_SMOOTH_FRAMES = 3   // 移動平均フレーム数
const MIN_VALID_SPEED = 0.5     // この速度(km/s)未満はフォールバック使用

export function useSWaveCountdown(
  psWave: PsWaveCircle[],
  home: { lat: number; lng: number } | null,
  hasActiveEEW: boolean,
): SWaveArrival | null {
  const [arrival, setArrival] = useState<SWaveArrival | null>(null)
  const prevSRadiusRef = useRef<number | null>(null)
  const speedHistoryRef = useRef<number[]>([])

  useEffect(() => {
    if (home === null || psWave.length === 0 || !hasActiveEEW) {
      prevSRadiusRef.current = null
      speedHistoryRef.current = []
      setArrival(null)
      return
    }

    // 最大 sRadius の円（最も波面が外側にある）を対象とする
    const circle = psWave.reduce((best, c) => c.sRadius > best.sRadius ? c : best, psWave[0])
    const distanceKm = haversineKm(circle.lat, circle.lng, home.lat, home.lng)
    const sRadiusKm = circle.sRadius

    // S波速度を推定（フレーム差分 → 移動平均）
    let speed = S_WAVE_KM_PER_SEC
    if (prevSRadiusRef.current !== null) {
      const delta = sRadiusKm - prevSRadiusRef.current
      if (delta > 0) {
        speedHistoryRef.current.push(delta)
        if (speedHistoryRef.current.length > SPEED_SMOOTH_FRAMES) {
          speedHistoryRef.current.shift()
        }
        const avg = speedHistoryRef.current.reduce((s, v) => s + v, 0) / speedHistoryRef.current.length
        if (avg >= MIN_VALID_SPEED) speed = avg
      }
    }
    prevSRadiusRef.current = sRadiusKm

    const arrived = sRadiusKm >= distanceKm
    const etaSec = arrived ? 0 : Math.max(0, Math.round((distanceKm - sRadiusKm) / speed))

    setArrival({ distanceKm, sRadiusKm, etaSec, arrived })
  }, [psWave, home, hasActiveEEW])

  return arrival
}
