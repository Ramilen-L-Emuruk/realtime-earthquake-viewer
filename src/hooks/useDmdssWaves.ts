import { useEffect, useState } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { PsWaveCircle } from '../services/kyoshin'

export const VS_KM_PER_SEC = 3.5
const VP_KM_PER_SEC = 6.0
const UPDATE_INTERVAL_MS = 100

/**
 * DMDSS版専用: アクティブな EEW の震源・発生時刻から P波・S波の地表到達半径を計算する。
 * 速度モデル VP=6.0, VS=3.5 km/s、震源深さによる 3D→地表投影を適用。
 * 100ms ごとに更新することでスムーズな拡張アニメーションを実現する。
 */
export function useDmdssWaves(activeEEWs: EEWAlert[], enabled: boolean): PsWaveCircle[] {
  const [waves, setWaves] = useState<PsWaveCircle[]>([])

  useEffect(() => {
    if (!enabled || activeEEWs.length === 0) {
      setWaves([])
      return
    }

    const compute = () => {
      const now = Date.now()
      const circles: PsWaveCircle[] = []

      for (const eew of activeEEWs) {
        if (eew.cancelled) continue
        const { hypocenter } = eew.earthquake
        if (!Number.isFinite(hypocenter.latitude) || !Number.isFinite(hypocenter.longitude)) continue

        const originMs = new Date(eew.earthquake.originTime).getTime()
        const t = (now - originMs) / 1000
        if (t < 0) continue

        const depth = Math.max(0, hypocenter.depth ?? 0)
        const pHypo = VP_KM_PER_SEC * t
        const sHypo = VS_KM_PER_SEC * t

        circles.push({
          lat: hypocenter.latitude,
          lng: hypocenter.longitude,
          pRadius: pHypo > depth ? Math.sqrt(pHypo * pHypo - depth * depth) : 0,
          sRadius: sHypo > depth ? Math.sqrt(sHypo * sHypo - depth * depth) : 0,
        })
      }

      setWaves(circles)
    }

    compute()
    const id = setInterval(compute, UPDATE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [activeEEWs, enabled])

  return waves
}
