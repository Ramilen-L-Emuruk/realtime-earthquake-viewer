import { useEffect, useRef, useState } from 'react'
import type { PsWaveCircle } from '../services/kyoshin'
import { computeSWaveTravelTimeSec } from './useDmdssWaves'
import { haversineKm } from '../utils/geo'

export interface SWaveArrival {
  distanceKm: number
  sRadiusKm: number
  etaSec: number | null  // 到達済みは 0、推定不能は null
  arrived: boolean
}

const S_WAVE_KM_PER_SEC = 4.0  // フォールバック速度定数（Yahoo版フレーム差分が取れない初期）
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
    const arrived = sRadiusKm >= distanceKm

    let etaSec: number | null
    if (arrived) {
      etaSec = 0
    } else if (circle.depth !== undefined && sRadiusKm > 0) {
      // DMDSS版: 2層速度モデルの解析的逆算で正確な ETA を計算
      // computeSWaveTravelTimeSec は computeRadius の逆関数なので
      // 「現在の波面時刻」と「目標距離の到達時刻」の差が残り秒数
      const tNow = computeSWaveTravelTimeSec(sRadiusKm, circle.depth)
      const tArrival = computeSWaveTravelTimeSec(distanceKm, circle.depth)
      etaSec = Math.max(0, Math.round(tArrival - tNow))
    } else {
      // Yahoo版またはS波がまだ地表に出ていない場合: フレーム差分で速度を推定
      // ※Yahoo版の更新間隔は約1秒なので delta ≈ km/s として扱える
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
      etaSec = sRadiusKm === 0 ? null : Math.max(0, Math.round((distanceKm - sRadiusKm) / speed))
    }

    prevSRadiusRef.current = sRadiusKm
    setArrival({ distanceKm, sRadiusKm, etaSec, arrived })
  }, [psWave, home, hasActiveEEW])

  return arrival
}
