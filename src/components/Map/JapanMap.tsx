import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, Popup, Pane, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import type { JMAQuake, JMATsunami, TsunamiGrade, TsunamiObservation, EEWAlert, JMALpgm } from '../../types/earthquake'
import { getIntensityColor, getIntensityLabel, getScaleRadius } from '../../utils/intensity'
import { getLpgmClassColor, getLpgmClassLabel } from '../../utils/lpgm'
import { formatMagnitude, formatDepth } from '../../utils/formatters'
import { eewAreas } from '../../utils/eew'
import { useStationCoords } from '../../hooks/useStationCoords'
import { lookupPointCoords, buildAreaPrefIndex, buildStationPrefIndex, type LatLng } from '../../utils/stationCoords'
import { useTsunamiZones } from '../../hooks/useTsunamiZones'
import { useTsunamiObsCoords } from '../../hooks/useTsunamiObsCoords'
import { useSubRegions } from '../../hooks/useSubRegions'
import type { SubRegion } from '../../utils/subregions'
import { useActiveFaults } from '../../hooks/useActiveFaults'
import { usePlateBoundaries } from '../../hooks/usePlateBoundaries'
import { ActiveFaultsLayer } from './ActiveFaultsLayer'
import { PlateBoundariesLayer } from './PlateBoundariesLayer'
import { pointInRings, normalizeEpicenterLng } from '../../utils/geo'
import { BaseMap } from './BaseMap'
import { TileTintLayer } from './TileTintLayer'
import { IntensityPoints } from './IntensityPoints'
import { LpgmPoints } from './LpgmPoints'
import { KyoshinPoints } from './KyoshinPoints'
import { KyoshinSubThreshold } from './KyoshinSubThreshold'
import { KyoshinDetectedPoints } from './KyoshinDetectedPoints'
import { KyoshinMaxEffect } from './KyoshinMaxEffect'
import { PsWaveLayer } from './PsWaveLayer'
import { QuakeHeatmapLayer } from './QuakeHeatmapLayer'
import { MAP_CANVAS_PADDING } from './mapCanvasPadding'
import { flyToLite, flyToBoundsLite } from './flyToLite'
import type { SiteCoords, PsWaveCircle } from '../../services/kyoshin'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import type { HeatPoint } from '../../utils/quakeHeatmap'
import { log } from '../../utils/logger'

// 津波観測棒アイコン。波高・色ごとにキャッシュして再利用する。
const obsBarIconCache = new Map<string, L.DivIcon>()

function getTsunamiObsBarIcon(color: string, barPx: number, blinking = false): L.DivIcon {
  const key = `${color}:${barPx}:${blinking}`
  const cached = obsBarIconCache.get(key)
  if (cached) return cached

  const W = 6
  const FOOT = 3
  // スリムバー＋底面フェードで地図に馴染む。白枠なし。アンカーは棒の底辺中央。
  const icon = L.divIcon({
    className: '',
    html: `<div style="display:flex;flex-direction:column;align-items:center;width:${W + FOOT}px;height:${barPx + FOOT}px;"${blinking ? ' class="tsunami-obs-blink"' : ''}>
      <div style="width:${W}px;height:${barPx}px;background:${color};border-radius:3px 3px 0 0;opacity:0.9;"></div>
      <div style="width:${W + FOOT}px;height:${FOOT}px;background:${color};border-radius:0 0 3px 3px;opacity:0.3;"></div>
    </div>`,
    iconSize: [W + FOOT, barPx + FOOT],
    iconAnchor: [(W + FOOT) / 2, barPx + FOOT],
  })
  obsBarIconCache.set(key, icon)
  return icon
}

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

// 背景の海底地形タイル（GEBCO_basemap_NCEI）。CSS でダークテーマへ暗く調整する。
// ESRI World Ocean Base は日本近海の実データがほぼ 1:577k 相当までしか無く、
// それ以深にズームすると空タイル（単色の塗り）が返り「真っ青」になるため、
// 全球で一貫した海底地形陰影を持つ GEBCO グリッド由来のタイルに変更した。
const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'
const BATHYMETRY_ATTRIBUTION =
  'GEBCO; NOAA National Centers for Environmental Information (NCEI)'
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
      log.debug(`[map] flyTo lat=${positions[0][0].toFixed(3)} lng=${positions[0][1].toFixed(3)} (FitToBounds 1点)`)
      flyToLite(map, positions[0], MAX_ZOOM, { duration: 1.0 })
      return
    }
    log.debug(`[map] flyToBounds (FitToBounds ${positions.length}点)`)
    flyToBoundsLite(map, L.latLngBounds(positions), {
      padding: [48, 48],
      maxZoom: MAX_ZOOM,
      duration: 1.0,
    })
  }, [signature, positions, map])

  return null
}

// 津波モード専用のフィット。海岸線フィットと観測点フィットを統合し、
// 観測点更新を優先する。常時レンダリングして ref をタブ切替をまたいで保持する。
// - observationBars が更新された: 観測点へフィット（優先）。海岸線 sig も同時に消費して競合を防ぐ。
// - tsunamiSig が新規（obs 更新なし）: 海岸線へフィット。
// - 他タブ中に obs が更新された場合: フラグに座標を保持し、津波タブ入室時に発火する。
// - 津波タブ入室時に観測点更新・海岸線シグネチャ変化のどちらも無かった場合: 変化なしフォールバックとして
//   全海岸線（無ければ日本全体）にフィットし、直前の表示位置に取り残されるのを防ぐ。
// 注: useMemo 内で前回値 ref を更新すると React StrictMode の二重実行により誤判定が起きるため、
//     前回値の比較・更新を useEffect 内で行う。
function TsunamiFitToBounds({
  mode,
  tsunamiSignature,
  tsunamiFitPositions,
  observationBars,
}: {
  mode: MapMode
  tsunamiSignature: string
  tsunamiFitPositions: LatLng[]
  observationBars: { name: string; lat: number; lng: number; height: { value: number } }[]
}) {
  const map = useMap()
  const lastTsunamiSigRef = useRef<string>('')
  const prevObsMapRef = useRef<Map<string, number>>(new Map())
  const pendingObsPositionsRef = useRef<LatLng[]>([])
  const prevModeRef = useRef<MapMode>(mode)

  useEffect(() => {
    const enteredTsunamiTab = mode === 'tsunami' && prevModeRef.current !== 'tsunami'
    prevModeRef.current = mode

    // Step 1: 前回値と比較して更新された観測バーを検出し、フラグにセット
    const prevMap = prevObsMapRef.current
    const updatedBars = observationBars.filter((b) => prevMap.get(b.name) !== b.height.value)
    const newMap = new Map<string, number>()
    for (const b of observationBars) newMap.set(b.name, b.height.value)
    prevObsMapRef.current = newMap

    if (updatedBars.length > 0) {
      pendingObsPositionsRef.current = updatedBars.map((b) => [b.lat, b.lng] as LatLng)
      // 海岸線 sig を消費して、obs と同時更新時の競合を防ぐ
      lastTsunamiSigRef.current = tsunamiSignature
    }

    // Step 2: 津波タブのときだけフィット実行
    if (mode !== 'tsunami') return

    if (pendingObsPositionsRef.current.length > 0) {
      const positions = pendingObsPositionsRef.current
      pendingObsPositionsRef.current = []
      if (positions.length === 1) {
        log.debug(`[map] flyTo lat=${positions[0][0].toFixed(3)} lng=${positions[0][1].toFixed(3)} (TsunamiFit 観測点 1点)`)
        flyToLite(map, positions[0], MAX_ZOOM, { duration: 1.0 })
      } else {
        log.debug(`[map] flyToBounds (TsunamiFit 観測点 ${positions.length}点)`)
        flyToBoundsLite(map, L.latLngBounds(positions), { padding: [48, 48], maxZoom: MAX_ZOOM, duration: 1.0 })
      }
      return
    }

    if (tsunamiSignature && tsunamiSignature !== lastTsunamiSigRef.current && tsunamiFitPositions.length > 0) {
      lastTsunamiSigRef.current = tsunamiSignature
      log.debug(`[map] flyToBounds (TsunamiFit 海岸線 ${tsunamiFitPositions.length}点)`)
      flyToBoundsLite(map, L.latLngBounds(tsunamiFitPositions), { padding: [48, 48], maxZoom: MAX_ZOOM, duration: 1.0 })
      return
    }

    // Step 3: 入室時に変化なし（観測点更新も海岸線シグネチャ変化も無し）→ フォールバックフィット
    if (enteredTsunamiTab) {
      if (tsunamiFitPositions.length > 0) {
        log.debug(`[map] flyToBounds (TsunamiFit 入室・変化なし 海岸線${tsunamiFitPositions.length}点)`)
        flyToBoundsLite(map, L.latLngBounds(tsunamiFitPositions), { padding: [48, 48], maxZoom: MAX_ZOOM, duration: 1.0 })
      } else {
        log.debug('[map] flyToBounds JAPAN_BOUNDS (TsunamiFit 入室・変化なし・海岸線なし)')
        flyToBoundsLite(map, JAPAN_BOUNDS, { padding: [20, 20], duration: 1.0 })
      }
    }
  }, [mode, tsunamiSignature, tsunamiFitPositions, observationBars, map])

  return null
}

// 津波タブの観測行クリック時に該当観測点へ flyTo する。
function FocusObsPoint({
  focusObsName,
  observationBars,
}: {
  focusObsName: { name: string; ts: number } | null
  observationBars: { name: string; lat: number; lng: number }[]
}) {
  const map = useMap()
  useEffect(() => {
    if (!focusObsName) return
    const bar = observationBars.find((b) => b.name === focusObsName.name)
    if (!bar) return
    flyToLite(map, [bar.lat, bar.lng], MAX_ZOOM, { duration: 1.0 })
  }, [focusObsName, observationBars, map])
  return null
}

// 緊急地震速報の発報時: まず震源を中心に表示し、予報円が現在の表示に
// 収まらなくなったらその大きさに合わせてズームアウトする。
// P波があれば P波を、なければ S波を基準にする。
// 複数EEWがある場合は originTime が最新のものを追従対象とする。
// ユーザーが手動でズーム/パンした場合は idleRevertSec 秒間追従を停止する（0=EEW更新まで停止）。
function FitToEEW({ eews, psWave, idleRevertSec = 30, detectedPoints = [] }: { eews: EEWAlert[]; psWave: PsWaveCircle[]; idleRevertSec?: number; detectedPoints?: DetectedPoint[] }) {
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
        if (userInteractedRef.current) {
          log.debug(`[map] flyToBounds スキップ (EEW解除 userInteracted=${userInteractedRef.current})`)
        } else if (detectedPoints.length > 0) {
          log.debug(`[map] flyToBounds (EEW解除・揺れ検知中 ${detectedPoints.length}点にフィット)`)
          isAutoFlyingRef.current = true
          flyToBoundsLite(map,
            L.latLngBounds(detectedPoints.map(p => [p.lat, p.lng] as [number, number])),
            { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 1.0 },
          )
        } else {
          log.debug('[map] flyToBounds JAPAN_BOUNDS (EEW解除)')
          isAutoFlyingRef.current = true
          flyToBoundsLite(map, JAPAN_BOUNDS, { padding: [20, 20], duration: 1.0 })
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
        log.debug(`[map] flyToBounds (EEW新規 波円${psWave.length}個 eewId=${eewEventId})`)
        flyToBoundsLite(map, bounds, { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 0.8 })
      }
      return
    }
    log.debug(`[map] flyTo lat=${latitude.toFixed(3)} lng=${longitude.toFixed(3)} (EEW新規 震源のみ eewId=${eewEventId})`)
    flyToLite(map, [latitude, longitude], MAX_ZOOM, { duration: 0.8 })
  }, [latest, map])

  // ユーザーの手動ズーム/パンを検知し、idleRevertSec 秒後に追従を再開する。
  // プログラム的な flyTo/flyToBounds 中（isAutoFlyingRef = true）は無視する。
  useEffect(() => {
    const onInteraction = () => {
      if (isAutoFlyingRef.current) return
      if (!userInteractedRef.current) {
        log.debug(`[map] ユーザー手動操作検知 → 自動フィット抑制開始 (idleRevertSec=${idleRevertSec})`)
      }
      userInteractedRef.current = true
      window.clearTimeout(resetTimerRef.current)
      if (idleRevertSec > 0) {
        resetTimerRef.current = window.setTimeout(() => {
          log.debug('[map] 自動フィット抑制解除 (idleRevertSec経過)')
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
          log.debug(`[map] flyTo lat=${latitude.toFixed(3)} lng=${longitude.toFixed(3)} (EEW数減少・波円なし 再フィット)`)
          isAutoFlyingRef.current = true
          flyToLite(map, [latitude, longitude], MAX_ZOOM, { duration: 0.8 })
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
      log.debug(`[map] flyToBounds (EEW数減少・波円${psWave.length}個 再フィット)`)
      isAutoFlyingRef.current = true
      flyToBoundsLite(map, bounds, { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 0.8 })
    }
  }, [eews.length, psWave, latest, map])

  // 予報円の成長に追従してズームアウト（表示に収まらなくなった時のみ）
  // P波があれば P波円を、なければ S波円を基準にする
  // eews.length === 0 のときは psWave を無視する: activeEEWs（eews）は解除時に即時反映されるが、
  // psWave（dmdssWaves/kyoshin.psWave）は別 useEffect 経由のため 1 レンダー遅れて残ることがある
  useEffect(() => {
    if (eews.length === 0) return
    if (psWave.length === 0) return
    if (userInteractedRef.current) {
      log.debug('[map] flyToBounds スキップ (EEW波円成長フォロー・ユーザー操作中)')
      return
    }
    if (isAutoFlyingRef.current) return
    let bounds: L.LatLngBounds | null = null
    for (const c of psWave) {
      const radius = c.pRadius > 0 ? c.pRadius : c.sRadius
      const b = L.latLng(c.lat, c.lng).toBounds(radius * 2 * 1000)
      bounds = bounds ? bounds.extend(b) : b
    }
    if (bounds && !map.getBounds().contains(bounds)) {
      log.debug(`[map] flyToBounds (EEW波円成長フォロー 波円${psWave.length}個)`)
      isAutoFlyingRef.current = true
      flyToBoundsLite(map, bounds, { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 0.8 })
    }
  }, [eews.length, psWave, map])

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
          log.debug('[map] flyToBounds JAPAN_BOUNDS (揺れ検知終了)')
          flyToBoundsLite(map, JAPAN_BOUNDS, { padding: [20, 20], duration: 1.0 })
        } else {
          log.debug('[map] flyToBounds JAPAN スキップ (揺れ検知終了・EEW発報中)')
        }
      }
      return
    }
    if (fittedRef.current) return
    fittedRef.current = true

    if (points.length === 1) {
      log.debug(`[map] flyTo lat=${points[0].lat.toFixed(3)} lng=${points[0].lng.toFixed(3)} (揺れ検知 1点)`)
      flyToLite(map, [points[0].lat, points[0].lng], MAX_ZOOM, { duration: 1.0 })
      return
    }
    log.debug(`[map] flyToBounds (揺れ検知 ${points.length}点)`)
    flyToBoundsLite(map,
      L.latLngBounds(points.map(p => [p.lat, p.lng] as [number, number])),
      { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 1.0 },
    )
  }, [points, hasEew, map])

  return null
}

// 候補クラスタ（未確定・主候補1件）が立った時点で候補点群にフィットする。
// confirmed への昇格・別候補への交代・期限切れで解除/更新される。
// hasDetection=true（確定検知中）の間は Japan へのリセットを行わない
// （FitToDetection への引き継ぎ時にズームが往復してちらつくのを防ぐ）。
function FitToCandidate({
  points, candidateId, hasEew, hasDetection,
}: { points: DetectedPoint[]; candidateId: number | null; hasEew: boolean; hasDetection: boolean }) {
  const map = useMap()
  const fittedIdRef = useRef<number | null>(null)

  useEffect(() => {
    // 確定検知中は地図フィットを FitToDetection に完全に委譲する。
    // 確定済み観測点を含むクラスタが pendingRef に「幽霊候補」として再登録され続けるケース
    // （既存アルゴリズムの副作用: 確定済みサイトも changed に含まれるため、成長中のクラスタは
    // 毎フレーム新しい candidateId で登録され得る）で、地図が数秒おきに再フィットし続けるのを防ぐ。
    if (hasDetection) return
    if (candidateId === null) {
      if (fittedIdRef.current !== null) {
        fittedIdRef.current = null
        if (!hasEew) {
          log.debug('[map] flyToBounds JAPAN_BOUNDS (候補クラスタ失効)')
          flyToBoundsLite(map, JAPAN_BOUNDS, { padding: [20, 20], duration: 1.0 })
        } else {
          log.debug('[map] flyToBounds JAPAN スキップ (候補クラスタ失効・EEW発報中)')
        }
      }
      return
    }
    if (fittedIdRef.current === candidateId) return  // 同じ候補に既にフィット済み
    fittedIdRef.current = candidateId  // 新規登録 or 別候補への交代 → 再フィット
    if (points.length === 0) return  // 座標解決できた観測点が無い（通常発生しない）

    if (points.length === 1) {
      log.debug(`[map] flyTo lat=${points[0].lat.toFixed(3)} lng=${points[0].lng.toFixed(3)} (候補クラスタ 1点)`)
      flyToLite(map, [points[0].lat, points[0].lng], MAX_ZOOM, { duration: 1.0 })
      return
    }
    log.debug(`[map] flyToBounds (候補クラスタ ${points.length}点 id=${candidateId})`)
    flyToBoundsLite(map,
      L.latLngBounds(points.map(p => [p.lat, p.lng] as [number, number])),
      { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 1.0 },
    )
  }, [points, candidateId, hasEew, hasDetection, map])

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
    if (hasDetection) {
      log.debug('[map] FitJapanOnEnter スキップ (揺れ検知中)')
      return
    }
    if (!hasEew) {
      log.debug('[map] flyToBounds JAPAN_BOUNDS (realtimeタブ入室・EEWなし)')
      flyToBoundsLite(map, JAPAN_BOUNDS, { padding: [20, 20], duration: 1.0 })
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
        log.debug(`[map] flyToBounds (realtimeタブ入室・EEWあり 波円${psWave.length}個)`)
        flyToBoundsLite(map, bounds, { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 0.8 })
        return
      }
    }
    const latest = [...eews].sort(
      (a, b) => b.earthquake.originTime.localeCompare(a.earthquake.originTime),
    )[0]
    if (latest) {
      const { latitude, longitude } = latest.earthquake.hypocenter
      if (latitude > -200 && longitude > -200) {
        log.debug(`[map] flyTo lat=${latitude.toFixed(3)} lng=${longitude.toFixed(3)} (realtimeタブ入室・EEWあり 震源のみ)`)
        flyToLite(map, [latitude, longitude], MAX_ZOOM, { duration: 0.8 })
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
  observations?: TsunamiObservation[]
  lpgm?: JMALpgm
  iconScale?: number
  showBathymetry?: boolean
  showActiveFaults?: boolean
  heatPoints?: HeatPoint[] | null
  showPlateBoundaries?: boolean
  kyoshinSites?: SiteCoords
  kyoshinIndices?: number[]
  kyoshinPsWave?: PsWaveCircle[]
  eews?: EEWAlert[]
  detectedPoints?: DetectedPoint[]
  candidatePoints?: DetectedPoint[]
  candidateId?: number | null
  idleRevertSec?: number
  eewLpgmEventId?: string | null
  focusObsName?: { name: string; ts: number } | null
  obsUpdateStatus?: Map<string, 'new' | 'updated'>
}

export function JapanMap({
  mode,
  quake,
  tsunamis,
  observations = [],
  lpgm,
  iconScale = 1,
  showBathymetry = true,
  showActiveFaults = true,
  heatPoints = null,
  showPlateBoundaries = true,
  kyoshinSites = [],
  kyoshinIndices = [],
  kyoshinPsWave = [],
  eews = [],
  detectedPoints = [],
  candidatePoints = [],
  candidateId = null,
  idleRevertSec = 30,
  eewLpgmEventId = null,
  focusObsName = null,
  obsUpdateStatus,
}: Props) {
  const stationCoords = useStationCoords()
  const tsunamiZones = useTsunamiZones()
  const tsunamiObsCoords = useTsunamiObsCoords()
  const subregions = useSubRegions()
  const activeFaults = useActiveFaults()
  const plateBoundaries = usePlateBoundaries()
  // ポップアップ付きの線レイヤーを別々のペイン（別々の描画要素）に分けて重ねると、
  // 上のペインの要素が（そのペイン自身に線が無い場所でも）クリックを吸収し、下のペインへ
  // イベントが届かなくなる。プレート境界線・活断層線は地震情報・リアルタイムタブで
  // 常に同時に表示され得るため、1つの共有ペイン・共有レンダラーにまとめる。
  // 津波海岸線は tsunami-blink（点滅アニメ）をペイン全体に適用する都合上、
  // 別ペインのまま独立させる（同時クリックの競合は稀なため許容する）。
  // padding: パン中に途切れないよう広めに確保する（理由は mapCanvasPadding.ts 参照）。
  // 津波海岸線も同じ理由で活断層線・プレート境界線と揃える。
  //
  // レンダラーは SVG（Canvas ではない）。理由は BaseMap.tsx のコメント参照——Canvas は
  // 実バッファがpadding分・retina環境ではさらに2倍膨れ、flyTo中の毎フレームtransformで
  // 非力なGPUに負荷が乗るが、SVGは解像度非依存のベクター要素のためその負荷が原理的に
  // 発生しない。これにより flyToLite.ts の HIDDEN_DURING_FLY_PANES からも除外できる。
  const lineLayerRenderer = useMemo(() => L.svg({ pane: 'line-layers', padding: MAP_CANVAS_PADDING }), [])
  const tsunamiLineRenderer = useMemo(() => L.svg({ pane: 'tsunami-lines', padding: MAP_CANVAS_PADDING }), [])
  // 上記の可視線は SVG。SVG は tolerance（クリック許容範囲）を持てず、当たり判定が実ストローク幅
  // ぶんしかない（ポップアップ付きの細い線だと中心の数pxしか反応しない）。そこで可視線とは別ペインに
  // 透明な Canvas レンダラーを重ね、tolerance:8 で線から数pxずれてもポップアップが開くようにする
  // （Canvas 時代に入れていた緩和の復元）。透明かつ flyToLite.ts の HIDDEN_DURING_FLY_PANES で
  // flyTo 中は隠すため、Canvas 特有の flyTo 再合成コストも視覚的な影響も無い。
  const lineLayerHitRenderer = useMemo(() => L.canvas({ pane: 'line-layers-hit', tolerance: 8, padding: MAP_CANVAS_PADDING }), [])
  const tsunamiLineHitRenderer = useMemo(() => L.canvas({ pane: 'tsunami-lines-hit', tolerance: 8, padding: MAP_CANVAS_PADDING }), [])
  const quakeRegionFillRenderer = useMemo(() => L.svg({ pane: 'quake-region-fill', padding: MAP_CANVAS_PADDING }), [])
  const eewRegionFillRenderer = useMemo(() => L.svg({ pane: 'eew-region-fill', padding: MAP_CANVAS_PADDING }), [])
  const eewLpgmRegionFillRenderer = useMemo(() => L.svg({ pane: 'eew-lpgm-region-fill', padding: MAP_CANVAS_PADDING }), [])
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

  // 津波観測棒: 波高が判明している観測点を座標付きで整理し、緯度降順（北→南）でソート
  type ObsBar = { name: string; lat: number; lng: number; barPx: number; color: string; height: { value: number; description: string; over?: boolean }; blinking: boolean }
  const observationBars = useMemo<ObsBar[]>(() => {
    if (!tsunamiObsCoords || observations.length === 0) return []
    const OBS_MAX_M = 5.0
    const OBS_MAX_PX = 400
    const OBS_MIN_PX = 8
    const bars: ObsBar[] = []
    for (const o of observations) {
      if (!o.height) continue
      const latLng = tsunamiObsCoords[o.name]
      if (!latLng) continue
      const v = o.height.value
      const barPx = Math.round(Math.max(OBS_MIN_PX, Math.min(OBS_MAX_PX, (v / OBS_MAX_M) * OBS_MAX_PX)))
      // 気象庁津波観測階級に準拠: 3m以上=紫, 1m以上=赤, 0.2m以上=オレンジ, 0.2m未満=シアン
      const color = v >= 3 ? '#a855f7' : v >= 1 ? '#ef4444' : v >= 0.2 ? '#f97316' : '#22d3ee'
      const blinking = obsUpdateStatus?.has(o.name) ?? false
      bars.push({ name: o.name, lat: latLng[0], lng: latLng[1], barPx, color, height: o.height, blinking })
    }
    // 北→南ソート: 後から描画するほど手前(z高め)になるため南側を最後に描く
    return bars.sort((a, b) => b.lat - a.lat)
  }, [tsunamiObsCoords, observations, obsUpdateStatus])


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
    if (quake?.issue.type === '遠地地震' && hasEpicenter) {
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
      {/* 背景: 海底地形タイル（tilePane z=200）。ダーク化は tile-tint ペイン（TileTintLayer,
          z=220）の mix-blend-mode オーバーレイで行う（CSS filter は非力なGPUでパン時に
          重いため不使用。詳細は TileTintLayer.tsx 参照）。keepBuffer はパン中のタイル
          増減（＝tile-tintの再合成トリガー）自体を減らすため既定値2から引き上げている。
          updateWhenZooming=false: Leaflet の GridLayer は既定で「flyTo/ピンチズーム中、
          通過する整数ズームレベルごとに新しいタイルを読み込んで描画し直す」
          （leaflet-src.js の GridLayer options コメント参照）。flyTo は開始と終了で
          複数ズームレベルをまたぐことが多く（例: 日本全体 zoom5 → MAX_ZOOM=8）、
          飛行中に何度も新規タイルの取得・DOM挿入・ペイントが走り、非力なGPUでは
          これが体感カクつきの主因になる（実測: 海底地形ONで平均フレーム間隔が
          約3倍に悪化）。false にすると飛行中は現在のズームのタイルをCSS transform で
          拡縮したまま維持し（既存タイルの再利用なのでスケール変化のみ・新規読込なし）、
          着地（moveend）時に一度だけ新しいズームのタイルへ切り替える。見た目の差は
          「フィット中だけ地形が一瞬ぼやける」程度（通常のズーム操作でも起きる自然な現象）で、
          ペインを隠す方式のような消灯・再点灯のチラつきは発生しない。
          updateWhenIdle=true: 上記の updateWhenZooming はズームレベルが変わる瞬間の
          読込を止めるだけで、ズームレベルが変わらない「パン（視点移動）」中の新規タイル
          読込は別の仕組み（GridLayer._onMoveEnd、moveイベントに updateInterval=200ms
          間隔でスロットル）で今も継続的に走る。flyTo は大きく視点を動かすことが多く、
          飛行中この経路で「まだ見えていなかった範囲」のタイルが届くたびデコード・DOM挿入・
          ペイントが挟まり、フレーム間隔の突発的なスパイク（実測で最大300〜500ms級）の
          一因になっていた。true にすると新規タイル読込は着地（moveend）まで一切行わず、
          飛行中は出発時点で既に読み込み済みのタイルのみを表示し続ける。見た目の差は、
          出発時点で未読込だった範囲へ大きく飛ぶ場合、着地までその範囲のタイルが
          表示されない（背景色のまま）点。keepBuffer=4 の余白内に収まる移動では
          影響しない。 */}
      {showBathymetry && (
        <>
          <TileLayer
            url={BATHYMETRY_URL}
            attribution={BATHYMETRY_ATTRIBUTION}
            maxNativeZoom={10}
            keepBuffer={4}
            updateWhenZooming={false}
            updateWhenIdle
          />
          <TileTintLayer />
        </>
      )}

      <ZoomWatcher onZoom={setZoom} />

      {/* 行政区域ベースマップ（タイル不使用・自前描画）。
          リアルタイム表示は観測点ドットで埋もれるため引きの地方ラベルは出さない。 */}
      <BaseMap suppressRegionLabels={mode === 'kyoshin'} />

      {/* 直近1ヶ月の地震活動ヒートマップ。区域塗り(z260)より背面のため震度色塗りと競合しない。 */}
      {(mode === 'quake' || mode === 'kyoshin') && heatPoints && heatPoints.length > 0 && (
        <QuakeHeatmapLayer points={heatPoints} />
      )}

      {/* プレート境界線・活断層線の共有ペイン。react-leaflet の <Pane> は同名で二重に
          作成すると例外を投げるため、ペインの生成はここ一箇所のみで行い、各レイヤーは
          renderer={lineLayerRenderer} を指定するだけで同じペインへ描画する。
          2つの線レイヤーを別ペイン（別Canvas）に分けると、上のペインの全画面Canvasが
          （自身に線が無い場所でも）下のペインのクリックを吸収してしまうため、同時に
          表示され得る線レイヤーは必ず同じペインにまとめる。
          z=263 は区域塗り(z260/261)より前面・津波海岸線(z270)より背面。描画順は
          プレート境界線→活断層線の順（JSX順）で、活断層線が視覚的に前面に来る。
          ペインは mode に関わらず常時マウントする。mode をまたいで <Pane> を着脱すると、
          専用 SVG レンダラー（lineLayerRenderer, useMemo で使い回し）は map の内部レイヤー
          登録簿から外れないため、ペイン DOM が作り直されても renderer.onAdd() が再実行されず、
          孤立した旧コンテナへ描画され続けて線が二度と表示されなくなる（quake-region-fill
          側のコメント参照）。表示可否は各レイヤーの visible prop 側で制御する。 */}
      <Pane name="line-layers" style={{ zIndex: 263 }} />

      {/* 上の可視線(SVG)のポップアップ当たり判定用の透明 Canvas ヒットペイン（z264, 可視線より前面）。
          プレート境界線・活断層線はこの単一ペインを共有する（別ペインに分けると、上のペインの
          全画面Canvasが自身に線の無い場所でも下のペインのクリックを吸収するため。理由は上の
          line-layers のコメントと同じ）。透明なので flyTo 中は隠して差し支えない（flyToLite.ts）。
          ペインは line-layers と同じく常時マウントする。mode をまたいで <Pane> を着脱すると、
          専用 Canvas レンダラー（lineLayerHitRenderer, useMemo で使い回し）が孤立し、往復後に
          当たり判定が二度と効かなくなるため（表示可否は各レイヤーの visible prop 側で制御）。 */}
      <Pane name="line-layers-hit" style={{ zIndex: 264 }} />

      {/* 日本周辺のプレート境界線（PB2002モデル）。地震情報・リアルタイムタブのみ。
          活断層線と同様に本数が多いため、react-leaflet の宣言的 Polyline ではなく専用レイヤー
          コンポーネント（PlateBoundariesLayer）で Leaflet ネイティブ描画する。 */}
      <PlateBoundariesLayer
        plateBoundaries={plateBoundaries}
        visible={(mode === 'quake' || mode === 'kyoshin') && showPlateBoundaries}
        renderer={lineLayerRenderer}
        hitRenderer={lineLayerHitRenderer}
      />

      {/* 全国活断層線（産総研 活断層データベース）。地震情報・リアルタイムタブのみ、
          区域塗り(z260/261)より前面に表示し、震度色塗りの上からでも視認できるようにする。
          プレート境界線と同じ line-layers 共有ペイン（z263、生成はプレート境界線側で実施済み）を使う。
          本数が多い（約3,400本）ため、react-leaflet の宣言的 Polyline ではなく専用レイヤー
          コンポーネント（ActiveFaultsLayer）で Leaflet ネイティブ描画する。詳細はそちらのコメント参照。 */}
      <ActiveFaultsLayer
        activeFaults={activeFaults}
        visible={(mode === 'quake' || mode === 'kyoshin') && showActiveFaults}
        renderer={lineLayerRenderer}
        hitRenderer={lineLayerHitRenderer}
      />

      {/* EEW 受信時: 対象地域を予想震度で色塗り（ラベル z270 より背面・観測点ドットの下）
          警報域(isWarning): fillOpacity 0.55 + weight 2 で強調。予報域: 0.3 + weight 1
          ペインは常時マウントし、表示条件（mode==='kyoshin' や EEW 受信有無）は中身の
          JSX 側だけで出し分ける。mode をまたいで <Pane> を着脱すると、専用 SVG レンダラー
          （eewRegionFillRenderer, useMemo で使い回し）は map の内部レイヤー登録簿から
          外れないため、ペイン DOM が作り直されても renderer.onAdd() が再実行されず、
          孤立した旧コンテナへ描画され続けて塗りが二度と表示されなくなる（quake-region-fill
          側のコメント参照）。 */}
      <Pane name="eew-region-fill" style={{ zIndex: 260 }}>
        {mode === 'kyoshin' &&
          eewAreaFills.length > 0 &&
          eewLpgmRegionAggregates.length === 0 &&
          eewAreaFills.map((a) =>
            a.rings.map((ring, i) => (
              <Polygon
                key={`eew-fill-${a.name}-${i}`}
                positions={ring}
                renderer={eewRegionFillRenderer}
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

      {/* EEW LPGM overlay: 選択された EEW の地域別予想長周期地震動階級を区域塗りで表示
          ペインの常時マウント方針は直上の eew-region-fill と同じ。 */}
      <Pane name="eew-lpgm-region-fill" style={{ zIndex: 261 }}>
        {mode === 'kyoshin' &&
          eewLpgmRegionAggregates.length > 0 &&
          eewLpgmRegionAggregates.flatMap((r, ri) =>
            r.rings.map((ring, i) => (
              <Polygon
                key={`eew-lpgm-${ri}-${i}`}
                positions={ring}
                renderer={eewLpgmRegionFillRenderer}
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

      {/* 強震モニタ: Yahoo リアルタイム震度の観測点を描画 */}
      {mode === 'kyoshin' && (
        <>
          <KyoshinPoints sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale * kyoshinZoomScale} />
          <KyoshinSubThreshold sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale * kyoshinZoomScale} />
        </>
      )}

      {/* リアルタイムタブ入室時: EEW が無ければ日本全体を、EEW 中は波円にフィット。
          候補クラスタ発生時のタブ自動切替でも FitToCandidate のフィットを上書きしないよう、
          hasDetection には候補段階（未確定）も含める。 */}
      {mode === 'kyoshin' && (
        <FitJapanOnEnter hasEew={eews.length > 0} eews={eews} psWave={kyoshinPsWave} hasDetection={detectedPoints.length > 0 || candidatePoints.length > 0} />
      )}

      {/* 揺れ検知点: FitToDetection は常時レンダリングして検知終了時の日本全体戻しを担う */}
      {mode === 'kyoshin' && (
        <>
          <FitToCandidate points={candidatePoints} candidateId={candidateId} hasEew={eews.length > 0} hasDetection={detectedPoints.length > 0} />
          <FitToDetection points={detectedPoints} hasEew={eews.length > 0} />
          <KyoshinDetectedPoints points={detectedPoints} iconScale={iconScale * kyoshinZoomScale} />
          <KyoshinMaxEffect sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale * kyoshinZoomScale} />
        </>
      )}

      {/* EEW 発報時: 震源中心→予報円に合わせてズームアウト */}
      {mode === 'kyoshin' && <FitToEEW eews={eews} psWave={kyoshinPsWave} idleRevertSec={idleRevertSec} detectedPoints={detectedPoints} />}

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
      {/* 津波予報区の海岸線（等級ごとに色分け）。津波発報中は全モードで表示・点滅する。
          個々の Polyline ではなく Pane 全体に点滅クラスを適用する（線の本数に関わらず
          常に一箇所の指定で済むため）。
          ペインは常時マウントし、表示条件（tsunamiLines の有無）は中身の JSX 側で出し分ける。
          津波の解除→再発報で <Pane> を着脱すると、専用 SVG レンダラー（tsunamiLineRenderer,
          useMemo で使い回し）は map の内部レイヤー登録簿から外れないため、ペイン DOM が
          作り直されても renderer.onAdd() が再実行されず、孤立した旧コンテナへ描画され続けて
          海岸線が二度と表示されなくなる（quake-region-fill 側のコメント参照）。 */}
      <Pane name="tsunami-lines" style={{ zIndex: 270 }} className="tsunami-blink">
        {tsunamiLines.length > 0 &&
          tsunamiLines.map((line) =>
            line.segments.map((segment, i) => (
              // 可視線（SVG）。当たり判定は持たせず（interactive:false）、下の透明ヒット線に委ねる。
              <Polyline
                key={`${line.name}-${i}`}
                positions={segment}
                renderer={tsunamiLineRenderer}
                pathOptions={{
                  color: TSUNAMI_STYLE[line.grade].color,
                  weight: TSUNAMI_STYLE[line.grade].weight * iconScale,
                  opacity: 0.9,
                  interactive: false,
                }}
              />
            )),
          )}
      </Pane>

      {/* 津波海岸線ポップアップの当たり判定用・透明 Canvas ヒットレイヤー（可視線と別ペイン z271）。
          可視線(z270)は interactive:false としてこちらへ委譲する。仕組み・理由は line-layers-hit と同じ。
          ペインは常時マウントし、表示条件は中身の JSX 側で出し分ける（tsunamiLineHitRenderer は
          useMemo で使い回す専用 Canvas レンダラーのため、<Pane> を着脱すると孤立して当たり判定が
          二度と効かなくなる。可視線側 tsunami-lines と同じ機構）。 */}
      <Pane name="tsunami-lines-hit" style={{ zIndex: 271 }}>
        {tsunamiLines.length > 0 &&
          tsunamiLines.map((line) =>
            line.segments.map((segment, i) => (
              <Polyline
                key={`hit-${line.name}-${i}`}
                positions={segment}
                renderer={tsunamiLineHitRenderer}
                pathOptions={{
                  weight: TSUNAMI_STYLE[line.grade].weight * iconScale,
                  opacity: 0,
                }}
              >
                <Popup pane="popupPane">
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

      {/* 津波フィット統合コンポーネント。観測点更新を優先し、海岸線フィットとの競合を防ぐ。
          モード切替をまたいで ref を保持するため常時レンダリング */}
      <TsunamiFitToBounds
        mode={mode}
        tsunamiSignature={tsunamiSignature}
        tsunamiFitPositions={tsunamiFitPositions}
        observationBars={observationBars}
      />
      <FocusObsPoint focusObsName={focusObsName} observationBars={observationBars} />

      {/* 津波観測棒: 波高が判明している観測点に水位バーを描画。tsunami-lines(z270)より前面。
          緯度降順（北→南）でレンダリングし、南側ほど手前に表示される。 */}
      {mode === 'tsunami' && observationBars.length > 0 && (
        <Pane name="tsunami-obs-bars" style={{ zIndex: 280 }}>
          {observationBars.map((bar) => (
            <Marker
              key={`obs-bar-${bar.name}`}
              position={[bar.lat, bar.lng]}
              icon={getTsunamiObsBarIcon(bar.color, bar.barPx, bar.blinking)}
              zIndexOffset={0}
            >
              <Tooltip direction="right" offset={[10, -bar.barPx / 2]} pane="tooltipPane">
                <div className="text-sm">
                  <div className="font-bold">{bar.name}</div>
                  <div className="text-xs" style={{ color: bar.color }}>
                    {bar.height.over ? '>' : ''}{bar.height.description}
                  </div>
                </div>
              </Tooltip>
            </Marker>
          ))}
        </Pane>
      )}

      {/* 中間より引き: 一次細分区域ごとの最大震度を区域塗りつぶし＋区域中心マーカーで表示。
          LPGM 表示中は震度と重なるため非表示にする。
          塗りはラベル(basemap-labels z270)より背面の専用ペイン(z260)に置く。
          ペイン自体は mode==='quake' の間は常時マウントし、中身だけを条件で出し分ける。
          ズーム閾値をまたぐ度に <Pane> を丸ごと着脱すると、react-leaflet がペインの DOM を
          破棄してもこのペイン専用に保持している SVG レンダラー（quakeRegionFillRenderer）は
          map の内部レイヤー登録簿からは外れないため、次にペインが作り直されても
          renderer.onAdd() が再実行されず、新しい（誰にも見えない孤立した）ペインDOMの
          外側に取り残された古いコンテナへ描画され続け、塗りが二度と表示されなくなる。 */}
      <Pane name="quake-region-fill" style={{ zIndex: 260 }}>
        {aggregateByRegion &&
          !(lpgm && !lpgm.cancelled) &&
          regionAggregates.map((p) =>
            p.rings.map((ring, i) => (
              <Polygon
                key={`region-fill-${p.name}-${i}`}
                positions={ring}
                renderer={quakeRegionFillRenderer}
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
