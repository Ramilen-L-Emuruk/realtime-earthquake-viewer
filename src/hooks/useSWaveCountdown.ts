import { useEffect, useRef, useState } from 'react'
import type { PsWaveCircle } from '../services/kyoshin'
import { computeSWaveTravelTimeSec } from './usePsWaveCalc'
import { calcArrivalSafetyMarginSec, calcEEWAutoCancelSec, S_WAVE_FALLBACK_KM_PER_SEC } from '../utils/eew'
import { haversineKm } from '../utils/geo'
import { log } from '../utils/logger'

export interface SWaveArrival {
  distanceKm: number
  sRadiusKm: number
  etaSec: number | null  // 到達済みは 0、推定不能は null
  arrived: boolean
}

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
  const lastLoggedEEWRef = useRef<string | null>(null)

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
    let arrived = sRadiusKm >= distanceKm

    let etaSec: number | null
    if (circle.depth !== undefined && sRadiusKm > 0) {
      // 2層速度モデルの解析的逆算で理論上のS波到達走時を計算し、安全マージンを加算する
      // （震源近傍は直達波がそのまま立ち上がるが、遠方ほど表面波の分離・コーダ波の重畳で
      //  揺れの立ち上がりがなだらかになり、S波理論到達より体感開始が遅れる傾向があるため）
      const marginSec = calcArrivalSafetyMarginSec(distanceKm)
      const tNow = computeSWaveTravelTimeSec(sRadiusKm, circle.depth)
      const tArrivalWithMargin = computeSWaveTravelTimeSec(distanceKm, circle.depth) + marginSec
      arrived = tNow >= tArrivalWithMargin
      etaSec = arrived ? 0 : Math.max(0, Math.round(tArrivalWithMargin - tNow))

      // EEW解除前にS波が自宅に到達しない場合は非表示
      // （安全マージン込みの到達時刻で判定する。マージン無しの理論到達時刻だけで解除前と
      //   判定すると、実際の体感到達は解除後にずれ込むケースをカードで見せてしまうため）
      if (!arrived && circle.magnitude !== undefined) {
        const autoCancelSec = calcEEWAutoCancelSec(circle.magnitude, circle.depth)
        const willArriveBeforeCancel = tArrivalWithMargin < autoCancelSec
        const eewKey = `${circle.magnitude}-${circle.depth}`
        if (lastLoggedEEWRef.current !== eewKey) {
          lastLoggedEEWRef.current = eewKey
          log.debug('[eew] S波到達判定（EEW更新）', {
            sRadiusKm: Number(sRadiusKm.toFixed(1)),
            distanceToHomeKm: Number(distanceKm.toFixed(1)),
            etaSec,
            marginSec: Number(marginSec.toFixed(1)),
            autoCancelSec: Number(autoCancelSec.toFixed(1)),
            tArrivalWithMargin: Number(tArrivalWithMargin.toFixed(1)),
            willArriveBeforeCancel,
          })
        }
        if (!willArriveBeforeCancel) {
          prevSRadiusRef.current = sRadiusKm
          setArrival(null)
          return
        }
      }
    } else if (arrived) {
      etaSec = 0
    } else {
      // S波がまだ地表に出ていない場合: フレーム差分で速度を推定
      // ※更新間隔は約100ms〜1秒なので delta ≈ km/s として扱える
      let speed = S_WAVE_FALLBACK_KM_PER_SEC
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
