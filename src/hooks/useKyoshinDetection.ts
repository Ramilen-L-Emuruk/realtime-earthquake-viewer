import { useEffect, useRef, useState } from 'react'
import type { SiteCoords } from '../services/kyoshin'

export interface DetectedPoint {
  lat: number
  lng: number
  index: number
}

export interface KyoshinDetection {
  detected: boolean
  maxIndex: number
  /** 急上昇した観測点（震度インデックス降順、最大50点） */
  points: DetectedPoint[]
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const toRad = (deg: number) => deg * (Math.PI / 180)
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// 1秒で index が 2 以上増加した観測点を「変化あり」とみなす（約1.0 計測震度相当の上昇）
const DELTA_THRESHOLD = 2
// 近接判定の距離 (km)
const PROXIMITY_KM = 80
// 検知後の表示維持時間 (ms)
const DETECTION_DURATION_MS = 60_000

const EMPTY: KyoshinDetection = { detected: false, maxIndex: 0, points: [] }

/**
 * 直前と比べてインデックスが急上昇した観測点が、近接 PROXIMITY_KM km 以内に
 * 2点以上存在すれば地震の揺れとして検知する。
 * 単独の観測点スパイク（誤検知）は無視する。
 */
export function useKyoshinDetection(
  sites: SiteCoords,
  indices: number[],
): KyoshinDetection {
  const prevRef = useRef<number[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [detection, setDetection] = useState<KyoshinDetection>(EMPTY)

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = indices.slice()

    if (sites.length === 0 || indices.length === 0 || prev.length !== indices.length) return

    // 急上昇した観測点を収集
    const changed: Array<{ siteIdx: number; index: number }> = []
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] - (prev[i] ?? 0) >= DELTA_THRESHOLD) {
        changed.push({ siteIdx: i, index: indices[i] })
      }
    }
    if (changed.length < 2) return

    // 近接ペアが存在するか確認
    let foundCluster = false
    outer: for (let a = 0; a < changed.length; a++) {
      const siteA = sites[changed[a].siteIdx]
      if (!siteA) continue
      for (let b = a + 1; b < changed.length; b++) {
        const siteB = sites[changed[b].siteIdx]
        if (!siteB) continue
        if (haversineKm(siteA[0], siteA[1], siteB[0], siteB[1]) <= PROXIMITY_KM) {
          foundCluster = true
          break outer
        }
      }
    }
    if (!foundCluster) return

    // 検知：座標付きの点を震度降順で収集（上位50点）
    const points: DetectedPoint[] = changed
      .map(c => {
        const site = sites[c.siteIdx]
        if (!site) return null
        return { lat: site[0], lng: site[1], index: c.index }
      })
      .filter((p): p is DetectedPoint => p !== null)
      .sort((a, b) => b.index - a.index)
      .slice(0, 50)

    const maxIndex = points[0]?.index ?? 0
    setDetection({ detected: true, maxIndex, points })
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setDetection(EMPTY), DETECTION_DURATION_MS)
  }, [sites, indices])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return detection
}
