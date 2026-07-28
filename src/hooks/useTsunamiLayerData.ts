import { useMemo } from 'react'
import type { JMATsunami, TsunamiGrade, TsunamiObservation } from '../types/earthquake'
import type { LatLng } from '../utils/tsunamiZones'
import { useTsunamiZones } from './useTsunamiZones'
import { useTsunamiObsCoords } from './useTsunamiObsCoords'
import { TSUNAMI_RANK } from '../utils/tsunamiStyle'

// 津波モードの描画に必要な派生データ（海岸線＋観測棒）を計算する共有フック。
// Leaflet 版 JapanMap 内の tsunamiLines / observationBars memo と同じ導出。
// 発報中は全モードで描画するため mode を問わず常時計算する（呼び出し側でモード条件を判断）。

export interface TsunamiLine {
  name: string
  grade: TsunamiGrade
  segments: LatLng[][]
}

export interface TsunamiObsBar {
  name: string
  lat: number
  lng: number
  barPx: number
  color: string
  height: { value: number; description: string; over?: boolean }
  blinking: boolean
}

// 観測棒の高さ→ピクセル換算パラメータ（Leaflet 版と一致）。
const OBS_MAX_M = 5.0
const OBS_MAX_PX = 400
const OBS_MIN_PX = 8

export function useTsunamiLayerData(
  tsunamis: JMATsunami[],
  observations: TsunamiObservation[],
  obsUpdateStatus?: Map<string, 'new' | 'updated'>,
): {
  tsunamiLines: TsunamiLine[]
  observationBars: TsunamiObsBar[]
  tsunamiFitPositions: LatLng[]
  tsunamiSignature: string
} {
  const tsunamiZones = useTsunamiZones()
  const tsunamiObsCoords = useTsunamiObsCoords()

  const tsunamiLines = useMemo<TsunamiLine[]>(() => {
    if (!tsunamiZones) return []
    // 区域名→最大等級にまとめる。
    const grades = new Map<string, TsunamiGrade>()
    tsunamis
      .filter((t) => !t.cancelled)
      .forEach((t) => {
        t.areas.forEach((a) => {
          const current = grades.get(a.name)
          if (!current || TSUNAMI_RANK[a.grade] > TSUNAMI_RANK[current]) grades.set(a.name, a.grade)
        })
      })
    const lines: TsunamiLine[] = []
    grades.forEach((grade, name) => {
      const segments = tsunamiZones[name]
      if (segments) lines.push({ name, grade, segments })
    })
    // 弱い等級を先（下）、強い等級を後（前面）に。
    return lines.sort((a, b) => TSUNAMI_RANK[a.grade] - TSUNAMI_RANK[b.grade])
  }, [tsunamis, tsunamiZones])

  const observationBars = useMemo<TsunamiObsBar[]>(() => {
    if (!tsunamiObsCoords || observations.length === 0) return []
    const bars: TsunamiObsBar[] = []
    for (const o of observations) {
      if (!o.height) continue
      const latLng = tsunamiObsCoords[o.name]
      if (!latLng) continue
      const v = o.height.value
      const barPx = Math.round(Math.max(OBS_MIN_PX, Math.min(OBS_MAX_PX, (v / OBS_MAX_M) * OBS_MAX_PX)))
      // 気象庁津波観測階級: 3m以上=紫, 1m以上=赤, 0.2m以上=オレンジ, 0.2m未満=シアン。
      const color = v >= 3 ? '#a855f7' : v >= 1 ? '#ef4444' : v >= 0.2 ? '#f97316' : '#22d3ee'
      const blinking = obsUpdateStatus?.has(o.name) ?? false
      bars.push({ name: o.name, lat: latLng[0], lng: latLng[1], barPx, color, height: o.height, blinking })
    }
    // 北→南（後に描くほど手前）。
    return bars.sort((a, b) => b.lat - a.lat)
  }, [tsunamiObsCoords, observations, obsUpdateStatus])

  // カメラフィット対象（描画する海岸線の全座標）とフィット発火判定用シグネチャ。
  const tsunamiFitPositions = useMemo<LatLng[]>(
    () => tsunamiLines.flatMap((l) => l.segments.flat()),
    [tsunamiLines],
  )
  const tsunamiSignature = tsunamiLines.map((l) => `${l.name}:${l.grade}`).join(',')

  return { tsunamiLines, observationBars, tsunamiFitPositions, tsunamiSignature }
}
