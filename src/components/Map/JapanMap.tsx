import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, Popup, Pane, useMap, useMapEvents } from 'react-leaflet'
import type { JMAQuake, JMATsunami, TsunamiGrade, EEWAlert, JMALpgm } from '../../types/earthquake'
import { getIntensityColor, getIntensityLabel, getScaleRadius } from '../../utils/intensity'
import { getLpgmClassColor, getLpgmClassLabel } from '../../utils/lpgm'
import { formatMagnitude, formatDepth } from '../../utils/formatters'
import { eewAreas } from '../../utils/eew'
import { useStationCoords } from '../../hooks/useStationCoords'
import { lookupPointCoords, buildAreaPrefIndex, buildStationPrefIndex, type LatLng } from '../../utils/stationCoords'
import { useTsunamiZones } from '../../hooks/useTsunamiZones'
import { useSubRegions } from '../../hooks/useSubRegions'
import type { SubRegion } from '../../utils/subregions'
import { pointInRings, normalizeEpicenterLng } from '../../utils/geo'
import { BaseMap } from './BaseMap'
import { IntensityPoints } from './IntensityPoints'
import { LpgmPoints } from './LpgmPoints'
import { KyoshinPoints } from './KyoshinPoints'
import { KyoshinSubThreshold } from './KyoshinSubThreshold'
import { KyoshinDetectedPoints } from './KyoshinDetectedPoints'
import { KyoshinMaxEffect } from './KyoshinMaxEffect'
import { PsWaveLayer } from './PsWaveLayer'
import type { SiteCoords, PsWaveCircle } from '../../services/kyoshin'
import type { DetectedPoint } from '../../hooks/useKyoshinDetection'

// 震源の×印アイコン。UI 倍率・点滅フラグごとにキャッシュして再利用する。
const epicenterIconCache = new Map<string, L.DivIcon>()

function getEpicenterIcon(iconScale: number, blink = false): L.DivIcon {
  const key = `${iconScale}:${blink}`
  const cached = epicenterIconCache.get(key)
  if (cached) return cached

  const s = Math.round(32 * iconScale)
  const icon = L.divIcon({
    className: '',
    html: `<svg viewBox="0 0 32 32" width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg"${blink ? ' class="eew-blink"' : ''}>
    <line x1="4" y1="4" x2="28" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/>
    <line x1="28" y1="4" x2="4"  y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/>
  </svg>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
    popupAnchor: [0, -s * 0.56],
  })
  epicenterIconCache.set(key, icon)
  return icon
}

// 震度ラベル付きの塗りつぶし円アイコン。震度 × UI 倍率ごとにキャッシュして再利用する。
const intensityIconCache = new Map<string, L.DivIcon>()

function getIntensityIcon(scale: number, iconScale: number): L.DivIcon {
  const key = `${scale}:${iconScale}`
  const cached = intensityIconCache.get(key)
  if (cached) return cached

  const size = (getScaleRadius(scale) * 2 + 8) * iconScale
  const color = getIntensityColor(scale)
  const label = getIntensityLabel(scale)
  const fontSize = label.length > 1 ? size * 0.42 : size * 0.6
  const icon = L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;background:${color};border:1px solid rgba(255,255,255,0.7);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${fontSize}px;line-height:1;box-shadow:0 0 3px rgba(0,0,0,0.7)">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
  intensityIconCache.set(key, icon)
  return icon
}

// 長周期地震動階級の四角ラベルアイコン。階級 × UI 倍率ごとにキャッシュして再利用する。
const lpgmRegionIconCache = new Map<string, L.DivIcon>()

function getLpgmRegionIcon(lgInt: number, iconScale: number): L.DivIcon {
  const key = `${lgInt}:${iconScale}`
  const cached = lpgmRegionIconCache.get(key)
  if (cached) return cached

  const size = 32 * iconScale
  const color = getLpgmClassColor(lgInt)
  const label = getLpgmClassLabel(lgInt).replace('階級', '')
  const fontSize = size * 0.5
  const icon = L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;background:${color};border:2px solid rgba(255,255,255,0.8);border-radius:3px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${fontSize}px;line-height:1;box-shadow:0 0 3px rgba(0,0,0,0.7)">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
  lpgmRegionIconCache.set(key, icon)
  return icon
}

interface IntensityMarker {
  key: string
  position: LatLng
  scale: number
  pref: string
  addr: string
}

// 津波等級ごとの海岸線スタイルと優先度（同一区域に複数等級が来た場合は高い方を採用）
const TSUNAMI_STYLE: Record<TsunamiGrade, { color: string; weight: number; label: string }> = {
  MajorWarning: { color: '#c026d3', weight: 6, label: '大津波警報' },
  Warning:      { color: '#ef4444', weight: 5, label: '津波警報' },
  Watch:        { color: '#f59e0b', weight: 4, label: '津波注意報' },
  Forecast:     { color: '#22d3ee', weight: 3, label: '津波予報' },
  Unknown:      { color: '#9ca3af', weight: 2, label: '津波予報' },
}
const TSUNAMI_RANK: Record<TsunamiGrade, number> = {
  MajorWarning: 4,
  Warning:      3,
  Watch:        2,
  Forecast:     1,
  Unknown:      0,
}

interface TsunamiLine {
  name: string
  grade: TsunamiGrade
  segments: LatLng[][]
}

const JAPAN_CENTER: [number, number] = [38.25, 137.7]
// 本土四端（宗谷岬・納沙布岬・神崎鼻・佐多岬）を囲むバウンディングボックス
const JAPAN_BOUNDS: L.LatLngBoundsExpression = [[30.99, 129.43], [45.52, 145.82]]

// 背景の海底地形タイル（ESRI World Ocean Base）。CSS でダークテーマへ暗く調整する。
const BATHYMETRY_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}'
const BATHYMETRY_ATTRIBUTION =
  'Esri, GEBCO, NOAA, National Geographic, and other contributors'
// 自動ズームの上限。このズーム以下では一次細分区域ごとの最大震度に集約表示する。
const MAX_ZOOM = 8

// 震度マーカーの重なり順。Leaflet は「画面 y 座標 + zIndexOffset」で z を決めるため、
// 緯度差(数百〜数千px)を上回る係数を掛け、最大震度が高いほど確実に前面へ出す。
const INTENSITY_Z = 1000
// 震源（×印）は全ての震度マーカー（最大 70×INTENSITY_Z）より確実に前面へ。
const EPICENTER_Z = 1_000_000

// 現在のズームレベルを親へ伝えるだけのコンポーネント。
function ZoomWatcher({ onZoom }: { onZoom: (zoom: number) => void }) {
  const map = useMap()
  useEffect(() => {
    onZoom(map.getZoom())
  }, [map, onZoom])
  useMapEvents({ zoomend: () => onZoom(map.getZoom()) })
  return null
}

// 与えられた座標群に地図をフィットさせる。signature が変わったときのみ実行する。
function FitToBounds({ signature, positions }: { signature: string; positions: LatLng[] }) {
  const map = useMap()
  const lastFitRef = useRef<string>('')

  useEffect(() => {
    if (!signature || positions.length === 0) return
    if (lastFitRef.current === signature) return
    lastFitRef.current = signature

    if (positions.length === 1) {
      map.flyTo(positions[0], MAX_ZOOM, { duration: 1.0 })
      return
    }
    map.flyToBounds(L.latLngBounds(positions), {
      padding: [48, 48],
      maxZoom: MAX_ZOOM,
      duration: 1.0,
    })
  }, [signature, positions, map])

  return null
}

// 緊急地震速報の発報時: まず震源を中心に表示し、予報円が現在の表示に
// 収まらなくなったらその大きさに合わせてズームアウトする。
// P波があれば P波を、なければ S波を基準にする。
// 複数EEWがある場合は originTime が最新のものを追従対象とする。
// ユーザーが手動でズーム/パンした場合は idleRevertSec 秒間追従を停止する（0=EEW更新まで停止）。
function FitToEEW({ eews, psWave, idleRevertSec = 30 }: { eews: EEWAlert[]; psWave: PsWaveCircle[]; idleRevertSec?: number }) {
  const map = useMap()
  const lastEewIdRef = useRef<string | null>(null)
  const isAutoFlyingRef = useRef(false)
  const userInteractedRef = useRef(false)
  const resetTimerRef = useRef<number | undefined>(undefined)
  const prevEewsCountRef = useRef<number>(0)
  const prevPsWaveCountRef = useRef<number>(0)

  // 最新 EEW（originTime 降順）を追従対象とする
  const latest = eews.length > 0
    ? [...eews].sort((a, b) => b.earthquake.originTime.localeCompare(a.earthquake.originTime))[0]
    : null

  // 新しい EEW を受信したら: ユーザー操作ロックをリセットし震源を中心に表示
  // EEW が解除されたら（lastEewIdRef が非 null → latest が null）日本全体に戻す
  useEffect(() => {
    if (!latest) {
      if (lastEewIdRef.current !== null) {
        lastEewIdRef.current = null
        if (!userInteractedRef.current) {
          isAutoFlyingRef.current = true
          map.flyToBounds(JAPAN_BOUNDS, { padding: [20, 20], duration: 1.0 })
        }
      }
      return
    }
    const { latitude, longitude } = latest.earthquake.hypocenter
    if (latitude <= -200 || longitude <= -200) return
    const eewEventId = latest.issue?.eventId ?? latest.id
    if (lastEewIdRef.current === eewEventId) return
    lastEewIdRef.current = eewEventId
    userInteractedRef.current = false
    window.clearTimeout(resetTimerRef.current)
    isAutoFlyingRef.current = true
    // P/S波円が既にある場合は波円に直接フィット（タブ切り替え時の震源→波円ギクシャク防止）
    if (psWave.length > 0) {
      let bounds: L.LatLngBounds | null = null
      for (const c of psWave) {
        const radius = c.pRadius > 0 ? c.pRadius : c.sRadius
        const b = L.latLng(c.lat, c.lng).toBounds(radius * 2 * 1000)
        bounds = bounds ? bounds.extend(b) : b
      }
      if (bounds) {
        map.flyToBounds(bounds, { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 0.8 })
      }
      return
    }
    map.flyTo([latitude, longitude], MAX_ZOOM, { duration: 0.8 })
  }, [latest, map])

  // ユーザーの手動ズーム/パンを検知し、idleRevertSec 秒後に追従を再開する。
  // プログラム的な flyTo/flyToBounds 中（isAutoFlyingRef = true）は無視する。
  useEffect(() => {
    const onInteraction = () => {
      if (isAutoFlyingRef.current) return
      userInteractedRef.current = true
      window.clearTimeout(resetTimerRef.current)
      if (idleRevertSec > 0) {
        resetTimerRef.current = window.setTimeout(() => {
          userInteractedRef.current = false
        }, idleRevertSec * 1000)
      }
    }
    const onMoveEnd = () => { isAutoFlyingRef.current = false }
    map.on('zoomstart', onInteraction)
    map.on('dragstart', onInteraction)
    map.on('moveend', onMoveEnd)
    return () => {
      map.off('zoomstart', onInteraction)
      map.off('dragstart', onInteraction)
      map.off('moveend', onMoveEnd)
      window.clearTimeout(resetTimerRef.current)
    }
  }, [map, idleRevertSec])

  // EEW 数が減少（=1つ以上が解除）かつ残りがある場合: 残りの P/S波円に強制再フィット
  // 「収まっているかどうか」を問わずフィットし直す（解除前のズームアウト状態を補正するため）
  // psWave 数の減少にも反応する: DMDSS版では activeEEWs 変化と dmdssWaves 更新の間に
  // 1レンダーのタイムラグがあり、EEW 解除時に古い psWave で一度フィットしてしまうため
  useEffect(() => {
    const prevCount = prevEewsCountRef.current
    const prevPsCount = prevPsWaveCountRef.current
    prevEewsCountRef.current = eews.length
    prevPsWaveCountRef.current = psWave.length
    const eewDecreased = eews.length < prevCount
    const psWaveDecreased = psWave.length < prevPsCount
    if (!eewDecreased && !psWaveDecreased) return
    if (eews.length === 0) return
    if (userInteractedRef.current) return

    if (psWave.length === 0) {
      if (latest) {
        const { latitude, longitude } = latest.earthquake.hypocenter
        if (latitude > -200 && longitude > -200) {
          isAutoFlyingRef.current = true
          map.flyTo([latitude, longitude], MAX_ZOOM, { duration: 0.8 })
        }
      }
      return
    }

    let bounds: L.LatLngBounds | null = null
    for (const c of psWave) {
      const radius = c.pRadius > 0 ? c.pRadius : c.sRadius
      const b = L.latLng(c.lat, c.lng).toBounds(radius * 2 * 1000)
      bounds = bounds ? bounds.extend(b) : b
    }
    if (bounds) {
      isAutoFlyingRef.current = true
      map.flyToBounds(bounds, { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 0.8 })
    }
  }, [eews.length, psWave, latest, map])

  // 予報円の成長に追従してズームアウト（表示に収まらなくなった時のみ）
  // P波があれば P波円を、なければ S波円を基準にする
  useEffect(() => {
    if (psWave.length === 0) return
    if (userInteractedRef.current) return
    if (isAutoFlyingRef.current) return
    let bounds: L.LatLngBounds | null = null
    for (const c of psWave) {
      const radius = c.pRadius > 0 ? c.pRadius : c.sRadius
      const b = L.latLng(c.lat, c.lng).toBounds(radius * 2 * 1000)
      bounds = bounds ? bounds.extend(b) : b
    }
    if (bounds && !map.getBounds().contains(bounds)) {
      isAutoFlyingRef.current = true
      map.flyToBounds(bounds, { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 0.8 })
    }
  }, [psWave, map])

  return null
}

// 揺れ検知時に検知点群が収まるようにフィットし、検知終了時は日本全体に戻す。
// EEW 発報中は検知終了後も日本全体には戻さない。
function FitToDetection({ points, hasEew }: { points: DetectedPoint[]; hasEew: boolean }) {
  const map = useMap()
  const fittedRef = useRef(false)

  useEffect(() => {
    if (points.length === 0) {
      if (fittedRef.current) {
        fittedRef.current = false
        if (!hasEew) {
          map.flyToBounds(JAPAN_BOUNDS, { padding: [20, 20], duration: 1.0 })
        }
      }
      return
    }
    if (fittedRef.current) return
    fittedRef.current = true

    if (points.length === 1) {
      map.flyTo([points[0].lat, points[0].lng], MAX_ZOOM, { duration: 1.0 })
      return
    }
    map.flyToBounds(
      L.latLngBounds(points.map(p => [p.lat, p.lng] as [number, number])),
      { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 1.0 },
    )
  }, [points, hasEew, map])

  return null
}

// リアルタイムタブを開いた時点でズームをリセットする。
// EEW が無ければ日本全体を表示。EEW 発報中は P波/S波 境界（P波優先）にフィット。
// （地図は全タブ共通のため、他タブで寄った表示をリセットする）
function FitJapanOnEnter({
  hasEew,
  eews,
  psWave,
  hasDetection,
}: {
  hasEew: boolean
  eews: EEWAlert[]
  psWave: PsWaveCircle[]
  hasDetection: boolean
}) {
  const map = useMap()
  useEffect(() => {
    // 揺れ検知中はFitToDetectionに任せ、日本全体へのリセットをスキップする
    if (hasDetection) return
    if (!hasEew) {
      map.flyToBounds(JAPAN_BOUNDS, { padding: [20, 20], duration: 1.0 })
      return
    }
    if (psWave.length > 0) {
      let bounds: L.LatLngBounds | null = null
      for (const c of psWave) {
        const radius = c.pRadius > 0 ? c.pRadius : c.sRadius
        const b = L.latLng(c.lat, c.lng).toBounds(radius * 2 * 1000)
        bounds = bounds ? bounds.extend(b) : b
      }
      if (bounds) {
        map.flyToBounds(bounds, { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 0.8 })
        return
      }
    }
    const latest = [...eews].sort(
      (a, b) => b.earthquake.originTime.localeCompare(a.earthquake.originTime),
    )[0]
    if (latest) {
      const { latitude, longitude } = latest.earthquake.hypocenter
      if (latitude > -200 && longitude > -200) {
        map.flyTo([latitude, longitude], MAX_ZOOM, { duration: 0.8 })
      }
    }
    // マウント時（タブ入室時）のみ実行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

export type MapMode = 'quake' | 'tsunami' | 'kyoshin'

interface Props {
  mode: MapMode
  quake: JMAQuake | null
  tsunamis: JMATsunami[]
  lpgm?: JMALpgm
  iconScale?: number
  showBathymetry?: boolean
  kyoshinSites?: SiteCoords
  kyoshinIndices?: number[]
  kyoshinPsWave?: PsWaveCircle[]
  eews?: EEWAlert[]
  detectedPoints?: DetectedPoint[]
  idleRevertSec?: number
  eewLpgmEventId?: string | null
}

export function JapanMap({
  mode,
  quake,
  tsunamis,
  lpgm,
  iconScale = 1,
  showBathymetry = true,
  kyoshinSites = [],
  kyoshinIndices = [],
  kyoshinPsWave = [],
  eews = [],
  detectedPoints = [],
  idleRevertSec = 30,
  eewLpgmEventId = null,
}: Props) {
  const stationCoords = useStationCoords()
  const tsunamiZones = useTsunamiZones()
  const subregions = useSubRegions()
  const [zoom, setZoom] = useState(6)
  // ズームに応じて強震モニタ観測点のサイズを補正する係数。
  // ズーム8を基準（×1.0）とし、ズームアウト時は小さく・ズームイン時は大きくする。
  const kyoshinZoomScale = Math.max(0.2, Math.min(3.5, Math.pow(2, (zoom - 8) / 2)))

  const hasEpicenter =
    quake &&
    quake.earthquake.hypocenter.latitude > -200 &&
    quake.earthquake.hypocenter.longitude > -200

  // 震源ポップアップ用の都道府県別最大震度サマリー
  const prefIntensities = quake
    ? Object.entries(
        quake.points.reduce<Record<string, number>>((acc, p) => {
          if (!acc[p.pref] || p.scale > acc[p.pref]) acc[p.pref] = p.scale
          return acc
        }, {}),
      ).sort((a, b) => b[1] - a[1])
    : []

  // DMDATA JSON 電文は stations[]/regions[] に都道府県情報を含まないため、
  // station-coords.json の逆引きインデックスで pref を補完する。
  const areaPrefIndex = useMemo(
    () => (stationCoords ? buildAreaPrefIndex(stationCoords) : new Map<string, string>()),
    [stationCoords],
  )
  const stationPrefIndex = useMemo(
    () => (stationCoords ? buildStationPrefIndex(stationCoords) : new Map<string, string>()),
    [stationCoords],
  )

  // 各地点を座標に解決し、震度の弱い順に並べる（強い震度を最前面に描画するため）
  const intensityMarkers = useMemo<IntensityMarker[]>(() => {
    if (mode !== 'quake' || !quake || !stationCoords) return []
    const markers: IntensityMarker[] = []
    quake.points.forEach((p, i) => {
      const pref = p.pref ||
        ((p.isArea ? areaPrefIndex.get(p.addr) : stationPrefIndex.get(p.addr)) ?? '')
      const position = lookupPointCoords(stationCoords, pref, p.addr, p.isArea)
      if (!position) return
      markers.push({
        key: `${pref}|${p.addr}|${i}`,
        position,
        scale: p.scale,
        pref,
        addr: p.addr,
      })
    })
    return markers.sort((a, b) => a.scale - b.scale)
  }, [mode, quake, stationCoords, areaPrefIndex, stationPrefIndex])

  // MAX_ZOOM 以下では観測点ごとではなく一次細分区域ごとの最大震度に集約する。
  const aggregateByRegion = mode === 'quake' && !!quake && zoom <= MAX_ZOOM

  // 一次細分区域に bbox を付与（点内包判定の前段フィルタ用）
  const subregionIndex = useMemo(() => {
    if (!subregions) return []
    return subregions.map((sr) => {
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
      for (const ring of sr.rings) for (const [la, ln] of ring) {
        if (la < minLat) minLat = la
        if (la > maxLat) maxLat = la
        if (ln < minLng) minLng = ln
        if (ln > maxLng) maxLng = ln
      }
      return { sr, minLat, maxLat, minLng, maxLng }
    })
  }, [subregions])

  // 各観測点がどの一次細分区域に含まれるか判定し、区域ごとの最大震度を集約する。
  // 区域形状（塗りつぶし）＋区域中心マーカーとして引き当てる。
  const regionAggregates = useMemo(() => {
    if (!aggregateByRegion || subregionIndex.length === 0) return []
    const maxByName = new Map<string, number>()

    // パス1: isArea:false 観測点 → 点内包判定
    for (const m of intensityMarkers) {
      const [lat, lng] = m.position
      for (const e of subregionIndex) {
        if (lat < e.minLat || lat > e.maxLat || lng < e.minLng || lng > e.maxLng) continue
        if (pointInRings(lat, lng, e.sr.rings)) {
          const cur = maxByName.get(e.sr.name)
          if (cur == null || m.scale > cur) maxByName.set(e.sr.name, m.scale)
          break
        }
      }
    }

    // パス2: isArea:true の地点 → 区域名で直接マッチ（観測点が海上でも確実に塗りつぶす）
    if (quake) {
      for (const p of quake.points) {
        if (!p.isArea) continue
        const cur = maxByName.get(p.addr)
        if (cur == null || p.scale > cur) maxByName.set(p.addr, p.scale)
      }
    }

    const list: { name: string; scale: number; rings: LatLng[][]; label: LatLng }[] = []
    for (const e of subregionIndex) {
      const scale = maxByName.get(e.sr.name)
      if (scale != null) list.push({ name: e.sr.name, scale, rings: e.sr.rings, label: e.sr.label })
    }
    // 弱い震度を先に描画し、強い震度を前面に重ねる
    return list.sort((a, b) => a.scale - b.scale)
  }, [aggregateByRegion, subregionIndex, intensityMarkers, quake])

  // LPGM 観測点マーカー（zoom > MAX_ZOOM 時に個別ドット表示）
  const lpgmMarkers = useMemo(() => {
    if (!lpgm || lpgm.cancelled || !lpgm.points?.length || !stationCoords) return []
    const markers: { position: LatLng; lgInt: number }[] = []
    for (const p of lpgm.points) {
      const pref = p.pref || stationPrefIndex.get(p.name) || ''
      const position = lookupPointCoords(stationCoords, pref, p.name, false)
      if (!position) continue
      markers.push({ position, lgInt: p.lgInt })
    }
    return markers.sort((a, b) => a.lgInt - b.lgInt)
  }, [lpgm, stationCoords, stationPrefIndex])

  // LPGM 一次細分区域集約（zoom <= MAX_ZOOM 時に区域塗り）
  const lpgmRegionAggregates = useMemo(() => {
    if (!lpgm || lpgm.cancelled || !lpgm.regions?.length || !subregions) return []
    const maxByName = new Map(lpgm.regions.map(r => [r.name, r.maxLgInt]))
    return subregions
      .filter(sr => (maxByName.get(sr.name) ?? 0) >= 1)
      .map(sr => ({ ...sr, maxLgInt: maxByName.get(sr.name)! }))
      .sort((a, b) => a.maxLgInt - b.maxLgInt)
  }, [lpgm, subregions])

  // EEW LPGM 一次細分区域集約（選択された EEW の地域別予想長周期地震動階級）
  const eewLpgmRegionAggregates = useMemo(() => {
    if (!eewLpgmEventId || !subregions) return []
    const eew = eews.find(e => (e.issue?.eventId ?? e.id) === eewLpgmEventId)
    if (!eew) return []
    const areas = eewAreas(eew).filter(a => (a.lgIntTo ?? 0) >= 1)
    if (areas.length === 0) return []
    const maxByName = new Map(areas.map(a => [a.name, a.lgIntTo!]))
    return subregions
      .filter(sr => (maxByName.get(sr.name) ?? 0) >= 1)
      .map(sr => ({ ...sr, maxLgInt: maxByName.get(sr.name)! }))
      .sort((a, b) => a.maxLgInt - b.maxLgInt)
  }, [eewLpgmEventId, eews, subregions])

  // 一次細分区域名 -> 形状（EEW の予想震度塗り用に名前で引く）
  const subregionByName = useMemo(() => {
    const m = new Map<string, SubRegion>()
    if (subregions) for (const sr of subregions) m.set(sr.name, sr)
    return m
  }, [subregions])

  // EEW 受信時: 対象地域（一次細分区域）を予想最大震度(scaleTo)の色で塗りつぶす。
  // 複数EEWがある場合は地域ごとの最大予想震度を採用する。
  // kindCode '10'/'11'/'19' は強震動警戒域（警報対象）。'19' は PLUM 法警報。警報域は不透明度・枠線を強くして視覚的に区別する。
  const eewAreaFills = useMemo(() => {
    if (mode !== 'kyoshin' || eews.length === 0) return []
    const maxByName = new Map<string, number>()
    const warningNames = new Set<string>()
    for (const eew of eews) {
      for (const a of eewAreas(eew)) {
        maxByName.set(a.name, Math.max(maxByName.get(a.name) ?? 0, a.scaleTo))
        if (a.kindCode === '10' || a.kindCode === '11' || a.kindCode === '19') warningNames.add(a.name)
      }
    }
    const list: { name: string; scale: number; isWarning: boolean; rings: LatLng[][] }[] = []
    for (const [name, scale] of maxByName) {
      const sr = subregionByName.get(name)
      if (sr && scale > 0) list.push({ name, scale, isWarning: warningNames.has(name), rings: sr.rings })
    }
    // 弱い予想震度を先に描画し、強い予想震度を前面に重ねる
    return list.sort((a, b) => a.scale - b.scale)
  }, [mode, eews, subregionByName])

  // 津波: 進行中の警報・注意報を区域名→最大等級にまとめ、海岸線を引き当てる
  // 発報中は全モードで描画するため mode を問わず常時計算する
  const tsunamiLines = useMemo<TsunamiLine[]>(() => {
    if (!tsunamiZones) return []
    const grades = new Map<string, TsunamiGrade>()
    tsunamis
      .filter((t) => !t.cancelled)
      .forEach((t) => {
        t.areas.forEach((a) => {
          const current = grades.get(a.name)
          if (!current || TSUNAMI_RANK[a.grade] > TSUNAMI_RANK[current]) {
            grades.set(a.name, a.grade)
          }
        })
      })
    const lines: TsunamiLine[] = []
    grades.forEach((grade, name) => {
      const segments = tsunamiZones[name]
      if (segments) lines.push({ name, grade, segments })
    })
    // 弱い等級を先に描画し、強い等級を前面に重ねる
    return lines.sort((a, b) => TSUNAMI_RANK[a.grade] - TSUNAMI_RANK[b.grade])
  }, [tsunamis, tsunamiZones])

  // 地震モードのフィット対象（各観測点 + 震源）
  const quakeFitPositions = useMemo<LatLng[]>(() => {
    const positions = intensityMarkers.map((m) => m.position)
    if (hasEpicenter && quake) {
      positions.push([
        quake.earthquake.hypocenter.latitude,
        normalizeEpicenterLng(quake.earthquake.hypocenter.longitude, JAPAN_CENTER[1]),
      ])
    }
    // 遠地地震は国内観測点がなく震源のみになるため、日本中心を追加して両方を収める
    if (quake?.issue.type === 'Foreign' && hasEpicenter) {
      positions.push(JAPAN_CENTER)
    }
    return positions
  }, [intensityMarkers, hasEpicenter, quake])

  // 津波モードのフィット対象（描画する海岸線の全座標）
  const tsunamiFitPositions = useMemo<LatLng[]>(
    () => tsunamiLines.flatMap((l) => l.segments.flat()),
    [tsunamiLines],
  )

  const quakeSignature = `${quake?.id ?? ''}:${quakeFitPositions.length}`
  const tsunamiSignature = tsunamiLines.map((l) => `${l.name}:${l.grade}`).join(',')

  return (
    <MapContainer
      bounds={JAPAN_BOUNDS}
      boundsOptions={{ padding: [20, 20] }}
      className="h-full w-full"
      zoomControl={false}
      preferCanvas
      zoomSnap={0.5}
      zoomDelta={0.5}
      wheelPxPerZoomLevel={100}
    >
      {/* 背景: 海底地形タイル（tilePane z=200。CSS でダーク化） */}
      {showBathymetry && (
        <TileLayer
          url={BATHYMETRY_URL}
          attribution={BATHYMETRY_ATTRIBUTION}
          maxNativeZoom={13}
        />
      )}

      <ZoomWatcher onZoom={setZoom} />

      {/* 行政区域ベースマップ（タイル不使用・自前描画）。
          リアルタイム表示は観測点ドットで埋もれるため引きの地方ラベルは出さない。 */}
      <BaseMap suppressRegionLabels={mode === 'kyoshin'} />

      {/* EEW 受信時: 対象地域を予想震度で色塗り（ラベル z270 より背面・観測点ドットの下）
          警報域(isWarning): fillOpacity 0.55 + weight 2 で強調。予報域: 0.3 + weight 1 */}
      {mode === 'kyoshin' && eewAreaFills.length > 0 && eewLpgmRegionAggregates.length === 0 && (
        <Pane name="eew-region-fill" style={{ zIndex: 260 }}>
          {eewAreaFills.map((a) =>
            a.rings.map((ring, i) => (
              <Polygon
                key={`eew-fill-${a.name}-${i}`}
                positions={ring}
                pathOptions={{
                  color: getIntensityColor(a.scale),
                  weight: a.isWarning ? 2 : 1,
                  fillColor: getIntensityColor(a.scale),
                  fillOpacity: a.isWarning ? 0.55 : 0.3,
                }}
              />
            )),
          )}
        </Pane>
      )}

      {/* EEW LPGM overlay: 選択された EEW の地域別予想長周期地震動階級を区域塗りで表示 */}
      {mode === 'kyoshin' && eewLpgmRegionAggregates.length > 0 && (
        <Pane name="eew-lpgm-region-fill" style={{ zIndex: 261 }}>
          {eewLpgmRegionAggregates.flatMap((r, ri) =>
            r.rings.map((ring, i) => (
              <Polygon
                key={`eew-lpgm-${ri}-${i}`}
                positions={ring}
                pathOptions={{
                  color: getLpgmClassColor(r.maxLgInt),
                  weight: 2,
                  fillColor: getLpgmClassColor(r.maxLgInt),
                  fillOpacity: 0.5,
                }}
              />
            ))
          )}
        </Pane>
      )}

      {/* 強震モニタ: Yahoo リアルタイム震度の観測点を描画 */}
      {mode === 'kyoshin' && (
        <>
          <KyoshinPoints sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale * kyoshinZoomScale} />
          <KyoshinSubThreshold sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale * kyoshinZoomScale} />
        </>
      )}

      {/* リアルタイムタブ入室時: EEW が無ければ日本全体を、EEW 中は波円にフィット */}
      {mode === 'kyoshin' && (
        <FitJapanOnEnter hasEew={eews.length > 0} eews={eews} psWave={kyoshinPsWave} hasDetection={detectedPoints.length > 0} />
      )}

      {/* 揺れ検知点: FitToDetection は常時レンダリングして検知終了時の日本全体戻しを担う */}
      {mode === 'kyoshin' && (
        <>
          <FitToDetection points={detectedPoints} hasEew={eews.length > 0} />
          <KyoshinDetectedPoints points={detectedPoints} iconScale={iconScale * kyoshinZoomScale} />
          <KyoshinMaxEffect sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale * kyoshinZoomScale} />
        </>
      )}

      {/* EEW 発報時: 震源中心→予報円に合わせてズームアウト */}
      {mode === 'kyoshin' && <FitToEEW eews={eews} psWave={kyoshinPsWave} idleRevertSec={idleRevertSec} />}

      {/* 緊急地震速報の予報円（S波=塗りつぶし / P波=外周）。全タブで表示する。 */}
      <PsWaveLayer psWave={kyoshinPsWave} />

      {/* 緊急地震速報の震源マーカー。複数EEW時は全震源を表示する。リアルタイムタブ以外は半透明。 */}
      {eews.map((eew) =>
        eew.earthquake.hypocenter.latitude > -200 &&
        eew.earthquake.hypocenter.longitude > -200
          ? (
            <Marker
              key={`eew-epicenter-${eew.id}`}
              position={[
                eew.earthquake.hypocenter.latitude,
                normalizeEpicenterLng(eew.earthquake.hypocenter.longitude, JAPAN_CENTER[1]),
              ]}
              icon={getEpicenterIcon(iconScale, true)}
              zIndexOffset={EPICENTER_Z}
              opacity={mode === 'kyoshin' ? 1 : 0.4}
            />
          )
          : null
      )}

      {mode === 'quake' && (
        <FitToBounds signature={quakeSignature} positions={quakeFitPositions} />
      )}
      {mode === 'tsunami' && (
        <FitToBounds signature={tsunamiSignature} positions={tsunamiFitPositions} />
      )}

      {/* 津波予報区の海岸線（等級ごとに色分け）。津波発報中は全モードで表示・点滅する。
          preferCanvas 環境では Polyline への className が効かないため Pane 全体に適用する。 */}
      {tsunamiLines.length > 0 && (
        <Pane name="tsunami-lines" style={{ zIndex: 270 }} className="tsunami-blink">
          {tsunamiLines.map((line) =>
            line.segments.map((segment, i) => (
              <Polyline
                key={`${line.name}-${i}`}
                positions={segment}
                pathOptions={{
                  color: TSUNAMI_STYLE[line.grade].color,
                  weight: TSUNAMI_STYLE[line.grade].weight * iconScale,
                  opacity: 0.9,
                }}
              >
                <Popup>
                  <div className="text-sm">
                    <div className="font-bold">{line.name}</div>
                    <div className="text-gray-600 text-xs">
                      {TSUNAMI_STYLE[line.grade].label}
                    </div>
                  </div>
                </Popup>
              </Polyline>
            )),
          )}
        </Pane>
      )}

      {/* 中間より引き: 一次細分区域ごとの最大震度を区域塗りつぶし＋区域中心マーカーで表示。
          LPGM 表示中は震度と重なるため非表示にする。
          塗りはラベル(basemap-labels z270)より背面の専用ペイン(z260)に置く。 */}
      {aggregateByRegion && !(lpgm && !lpgm.cancelled) && (
        <Pane name="quake-region-fill" style={{ zIndex: 260 }}>
          {regionAggregates.map((p) =>
            p.rings.map((ring, i) => (
              <Polygon
                key={`region-fill-${p.name}-${i}`}
                positions={ring}
                pathOptions={{
                  color: getIntensityColor(p.scale),
                  weight: 1,
                  fillColor: getIntensityColor(p.scale),
                  fillOpacity: 0.5,
                }}
              />
            )),
          )}
        </Pane>
      )}
      {aggregateByRegion && !(lpgm && !lpgm.cancelled) &&
        regionAggregates.map((p) => (
          <Marker
            key={`region-mark-${p.name}`}
            position={p.label}
            icon={getIntensityIcon(p.scale, iconScale)}
            zIndexOffset={p.scale * INTENSITY_Z}
          >
            <Popup>
              <div className="text-sm">
                <div className="font-bold">{p.name}</div>
                <div className="text-gray-600 text-xs">
                  最大震度 {getIntensityLabel(p.scale)}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}

      {/* 各地点の震度（寄りのとき）。LPGM 表示中は非表示。多数になるため Canvas の色付きドットで軽量描画。 */}
      {mode === 'quake' && !aggregateByRegion && !(lpgm && !lpgm.cancelled) && (
        <IntensityPoints markers={intensityMarkers} iconScale={iconScale} />
      )}

      {/* LPGM overlay: ズームアウト時は一次細分区域塗り、ズームイン時は観測点ドット */}
      {mode === 'quake' && lpgm && !lpgm.cancelled && (
        <>
          {aggregateByRegion && lpgmRegionAggregates.length > 0 && (
            <>
              <Pane name="lpgm-region-fill" style={{ zIndex: 261 }}>
                {lpgmRegionAggregates.flatMap((r, ri) =>
                  r.rings.map((ring, i) => (
                    <Polygon
                      key={`lpgm-${ri}-${i}`}
                      positions={ring}
                      pathOptions={{
                        color: getLpgmClassColor(r.maxLgInt),
                        weight: 1,
                        fillColor: getLpgmClassColor(r.maxLgInt),
                        fillOpacity: 0.5,
                      }}
                    />
                  ))
                )}
              </Pane>
              {lpgmRegionAggregates.map((r) => (
                <Marker
                  key={`lpgm-region-mark-${r.name}`}
                  position={r.label}
                  icon={getLpgmRegionIcon(r.maxLgInt, iconScale)}
                  zIndexOffset={r.maxLgInt * INTENSITY_Z}
                >
                  <Popup>
                    <div className="text-sm">
                      <div className="font-bold">{r.name}</div>
                      <div className="text-gray-600 text-xs">
                        長周期地震動 {getLpgmClassLabel(r.maxLgInt)}
                      </div>
                    </div>
                  </Popup>
                </Marker>
              ))}
            </>
          )}
          {!aggregateByRegion && lpgmMarkers.length > 0 && (
            <LpgmPoints markers={lpgmMarkers} iconScale={iconScale} />
          )}
        </>
      )}

      {/* 震源マーカー（震度サマリーのポップアップ付き） */}
      {mode === 'quake' && hasEpicenter && quake && (
        <Marker
          position={[
            quake.earthquake.hypocenter.latitude,
            normalizeEpicenterLng(quake.earthquake.hypocenter.longitude, JAPAN_CENTER[1]),
          ]}
          icon={getEpicenterIcon(iconScale)}
          zIndexOffset={EPICENTER_Z}
        >
          <Popup>
            <div className="text-sm min-w-[160px]">
              <div className="font-bold mb-1">{quake.earthquake.hypocenter.name}</div>
              <div className="text-gray-600 text-xs">
                {formatMagnitude(quake.earthquake.hypocenter.magnitude)} /
                深さ {formatDepth(quake.earthquake.hypocenter.depth)}
              </div>
              {prefIntensities.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {prefIntensities.slice(0, 6).map(([pref, scale]) => (
                    <div key={pref} className="flex items-center gap-2 text-xs">
                      <span
                        className="inline-block w-5 text-center font-bold rounded text-white text-[10px]"
                        style={{ backgroundColor: getIntensityColor(scale) }}
                      >
                        {getIntensityLabel(scale)}
                      </span>
                      <span className="text-gray-700">{pref}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Popup>
        </Marker>
      )}
    </MapContainer>
  )
}
