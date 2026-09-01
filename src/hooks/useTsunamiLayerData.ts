import { useEffect, useMemo, useRef } from 'react'
import type { JMATsunami, TsunamiGrade, TsunamiObservation } from '../types/earthquake'
import type { LatLng } from '../utils/tsunamiZones'
import { useTsunamiZones } from './useTsunamiZones'
import { useTsunamiObsCoords } from './useTsunamiObsCoords'
import { TSUNAMI_RANK } from '../utils/tsunamiStyle'
import { log } from '../utils/logger'

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

/**
 * 到達は確認されたが最大波高がまだ出ていない観測点（電文の `MaxHeight` が数値を持たず
 * `FirstHeight` だけがある状態。カードの「到達確認 / 観測中」に対応する）。
 *
 * 波高を持たないので観測棒（`TsunamiObsBar`）にはできない。**量ではなく到達した事実だけ**を
 * 地図に出すため、別の一覧として分けてある。値が付いた時点でこちらから消え、観測棒へ移る。
 */
export interface TsunamiArrivalMarker {
  name: string
  lat: number
  lng: number
  /** 第 1 波の到達時刻。ツールチップに出す。 */
  arrivalTime?: string
  /** 押し波・引き波。電文に無ければ undefined。 */
  initial?: string
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
  arrivalMarkers: TsunamiArrivalMarker[]
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

  // 到達確認だけの観測点（波高なし）。観測棒から漏れるぶんをここで拾う。
  //
  // **波高が無いことを理由に落とさないこと。** カード（「到達確認」バッジ）も読み上げ
  // （「到達を確認しました。最大波高は観測中です」）もこの観測点を扱っているため、地図だけが
  // 黙ると「どこに到達したのか」が画面から読めなくなる。
  //
  // 座標表に無い観測点だけは、観測棒と同じく地図に出せない（下記の `missingCoordNames` で記録する）。
  const arrivalMarkers = useMemo<TsunamiArrivalMarker[]>(() => {
    if (!tsunamiObsCoords || observations.length === 0) return []
    const markers: TsunamiArrivalMarker[] = []
    for (const o of observations) {
      if (o.height) continue
      const latLng = tsunamiObsCoords[o.name]
      if (!latLng) continue
      markers.push({
        name: o.name,
        lat: latLng[0],
        lng: latLng[1],
        arrivalTime: o.arrivalTime,
        initial: o.initial,
        blinking: obsUpdateStatus?.has(o.name) ?? false,
      })
    }
    // 観測棒と同じ北→南（後に描くほど手前）。
    return markers.sort((a, b) => b.lat - a.lat)
  }, [tsunamiObsCoords, observations, obsUpdateStatus])

  // 座標表（`tsunami-obs-coords.json`）に名前が無く、地図へ出せなかった観測点。
  //
  // 座標表は手動整備で、気象庁が新しい観測点を載せてくると引けない名前が出る。**黙って消すと
  // 気づく手段が無い**（カードには出るのに地図にだけ現れず、原因も残らない）。棒と到達確認の
  // どちらも同じ表を引くので、ここで一括して見る。
  const missingCoordNames = useMemo<string[]>(() => {
    if (!tsunamiObsCoords) return []
    return observations.filter((o) => !tsunamiObsCoords[o.name]).map((o) => o.name)
  }, [tsunamiObsCoords, observations])

  // 記録は名前ごとに 1 度だけ。観測情報は数分おきに再送され、同じ観測点が電文のたびに現れる。
  const reportedMissingRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const fresh = missingCoordNames.filter((n) => !reportedMissingRef.current.has(n))
    if (fresh.length === 0) return
    for (const n of fresh) reportedMissingRef.current.add(n)
    log.warn('[tsunami] 座標表に無い観測点は地図に出せません（カードには表示されます）', { names: fresh })
  }, [missingCoordNames])

  // カメラフィット対象（描画する海岸線の全座標）とフィット発火判定用シグネチャ。
  const tsunamiFitPositions = useMemo<LatLng[]>(
    () => tsunamiLines.flatMap((l) => l.segments.flat()),
    [tsunamiLines],
  )
  const tsunamiSignature = tsunamiLines.map((l) => `${l.name}:${l.grade}`).join(',')

  return { tsunamiLines, observationBars, arrivalMarkers, tsunamiFitPositions, tsunamiSignature }
}
