import { useEffect, useState } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { PsWaveCircle } from '../services/kyoshin'

// 地殻速度モデル（日本の平均的な1D速度構造に基づく）
const VP1 = 6.0   // 地殻 P波 [km/s]
const VP2 = 7.8   // マントル P波 / Pn波 [km/s]
const VS1 = 3.5   // 地殻 S波 [km/s]
const VS2 = 4.5   // マントル S波 / Sn波 [km/s]
const MOHO_KM = 33 // モホ面深度 [km]（日本平均値）

// Pn/Sn の臨界角の余弦
const COS_IC_P = Math.sqrt(1 - (VP1 / VP2) ** 2)
const COS_IC_S = Math.sqrt(1 - (VS1 / VS2) ** 2)

const UPDATE_INTERVAL_MS = 100

/**
 * 2層速度モデルで地表距離 R に S波が到達するまでの走時を返す。
 * computeRadius の逆関数（解析的逆算）。
 *
 * depth <= MOHO_KM の場合:
 *   直達波: t_direct = sqrt(R² + depth²) / VS1
 *   屈折波: t_head   = R / VS2 + interceptTime
 *   → 先に到達する方（min）が実際の到達時刻
 *
 * depth > MOHO_KM の場合:
 *   マントル速度のみ: t = sqrt(R² + depth²) / VS2
 */
export function computeSWaveTravelTimeSec(surfaceDistKm: number, depth: number): number {
  if (depth > MOHO_KM) {
    return Math.sqrt(surfaceDistKm ** 2 + depth ** 2) / VS2
  }
  const tDirect = Math.sqrt(surfaceDistKm ** 2 + depth ** 2) / VS1
  const interceptTime = (2 * MOHO_KM - depth) * COS_IC_S / VS1
  const tHead = surfaceDistKm / VS2 + interceptTime
  return Math.min(tDirect, tHead)
}

/**
 * S波の走時モデルで、経過時間 t における地表到達半径を返す。
 * computeSWaveTravelTimeSec の逆関数。PsWaveLayer で「durationSec秒前の
 * 波面半径」（揺れ継続時間の後端）を求めるために使用する。
 */
export function computeSWaveRadiusAtTime(t: number, depth: number): number {
  if (t <= 0) return 0
  return computeRadius(t, depth, VS1, VS2, COS_IC_S)
}

/**
 * 2層速度モデル（地殻＋マントル）で地表到達半径を計算する。
 *
 * 震源が地殻内（depth <= MOHO_KM）の場合:
 *   - 直達波（P/S）: √((V1·t)² − depth²)
 *   - 屈折波（Pn/Sn）: (t − t_intercept) · V2  ← モホ面沿いの高速伝播
 *   - 両者の大きい方が実際の波面位置
 *
 * 震源がマントル内（depth > MOHO_KM）の場合:
 *   - マントル速度（V2）で直達波計算
 *
 * これにより震源から 150km 超の P波円・160km 超の S波円の精度が向上する。
 */
function computeRadius(t: number, depth: number, v1: number, v2: number, cosIc: number): number {
  if (depth <= MOHO_KM) {
    // 直達波の地表半径
    const directHypo = v1 * t
    const directRadius = directHypo > depth ? Math.sqrt(directHypo ** 2 - depth ** 2) : 0

    // Pn/Sn 屈折波の地表半径
    // インターセプト時刻: 波がモホ面に達して戻ってくるまでの余分な時間
    const interceptTime = (2 * MOHO_KM - depth) * cosIc / v1
    const headRadius = t > interceptTime ? (t - interceptTime) * v2 : 0

    return Math.max(directRadius, headRadius)
  } else {
    // 震源がマントル内: マントル速度で直達波
    const hypo = v2 * t
    return hypo > depth ? Math.sqrt(hypo ** 2 - depth ** 2) : 0
  }
}

/**
 * DMDSS版専用: アクティブな EEW の震源・発生時刻から P波・S波の地表到達半径を計算する。
 * 100ms ごとに更新することでスムーズな拡張アニメーションを実現する。
 */
export function useDmdssWaves(
  activeEEWs: EEWAlert[],
  enabled: boolean,
  replayTimeOffset: number | null = null,
): PsWaveCircle[] {
  const [waves, setWaves] = useState<PsWaveCircle[]>([])

  useEffect(() => {
    if (!enabled || activeEEWs.length === 0) {
      setWaves([])
      return
    }

    const compute = () => {
      const now = Date.now() + (replayTimeOffset ?? 0)
      const circles: PsWaveCircle[] = []

      for (const eew of activeEEWs) {
        if (eew.cancelled || eew.cancelledAt) continue
        const { hypocenter } = eew.earthquake
        if (!Number.isFinite(hypocenter.latitude) || !Number.isFinite(hypocenter.longitude)) continue

        const originMs = new Date(eew.earthquake.originTime).getTime()
        const t = (now - originMs) / 1000
        if (t < 0) continue

        const depth = Math.max(0, hypocenter.depth ?? 0)

        circles.push({
          lat: hypocenter.latitude,
          lng: hypocenter.longitude,
          pRadius: computeRadius(t, depth, VP1, VP2, COS_IC_P),
          sRadius: computeRadius(t, depth, VS1, VS2, COS_IC_S),
          depth,
          magnitude: hypocenter.magnitude,
        })
      }

      setWaves(circles)
    }

    compute()
    const id = setInterval(compute, UPDATE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [activeEEWs, enabled, replayTimeOffset])

  return waves
}
