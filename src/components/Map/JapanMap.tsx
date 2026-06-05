import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, Circle, CircleMarker, Popup, Tooltip, Pane, useMap, useMapEvents } from 'react-leaflet'
import type { JMAQuake, JMATsunami, TsunamiGrade, EEWAlert } from '../../types/earthquake'
import { getIntensityColor, getIntensityLabel, getScaleRadius } from '../../utils/intensity'
import { formatMagnitude, formatDepth } from '../../utils/formatters'
import { eewMaxScale } from '../../utils/eew'
import { useStationCoords } from '../../hooks/useStationCoords'
import { lookupPointCoords, type LatLng } from '../../utils/stationCoords'
import { useTsunamiZones } from '../../hooks/useTsunamiZones'
import { usePrefectures } from '../../hooks/usePrefectures'
import { BaseMap } from './BaseMap'
import { KyoshinPoints } from './KyoshinPoints'
import type { SiteCoords, PsWaveCircle } from '../../services/kyoshin'
import type { DetectedPoint } from '../../hooks/useKyoshinDetection'
import { kyoshinColor } from '../../utils/kyoshinColor'

// 震源の×印アイコン。UI 倍率ごとにキャッシュして再利用する。
const epicenterIconCache = new Map<number, L.DivIcon>()

function getEpicenterIcon(iconScale: number): L.DivIcon {
  const cached = epicenterIconCache.get(iconScale)
  if (cached) return cached

  const s = Math.round(32 * iconScale)
  const icon = L.divIcon({
    className: '',
    html: `<svg viewBox="0 0 32 32" width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg">
    <line x1="4" y1="4" x2="28" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/>
    <line x1="28" y1="4" x2="4"  y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/>
  </svg>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
    popupAnchor: [0, -s * 0.56],
  })
  epicenterIconCache.set(iconScale, icon)
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
  Warning: { color: '#ef4444', weight: 5, label: '津波警報' },
  Watch: { color: '#f59e0b', weight: 4, label: '津波注意報' },
  Unknown: { color: '#9ca3af', weight: 3, label: '津波予報' },
}
const TSUNAMI_RANK: Record<TsunamiGrade, number> = {
  MajorWarning: 3,
  Warning: 2,
  Watch: 1,
  Unknown: 0,
}

interface TsunamiLine {
  name: string
  grade: TsunamiGrade
  segments: LatLng[][]
}

const JAPAN_CENTER: [number, number] = [36.5, 137.5]
const JAPAN_ZOOM = 5

// 背景の海底地形タイル（ESRI World Ocean Base）。CSS でダークテーマへ暗く調整する。
const BATHYMETRY_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}'
const BATHYMETRY_ATTRIBUTION =
  'Esri, GEBCO, NOAA, National Geographic, and other contributors'
// 自動ズームの上限（地方単位が収まる程度）
const MAX_ZOOM = 8
// このズーム未満（中間より引き）では、地震モードで観測点ごとではなく
// 都道府県ごとの最大震度（県中心＋県塗りつぶし）に集約表示する。
const PREF_AGGREGATE_MAX_ZOOM = 8

// 震度マーカーの重なり順。Leaflet は「画面 y 座標 + zIndexOffset」で z を決めるため、
// 緯度差(数百〜数千px)を上回る係数を掛け、最大震度が高いほど確実に前面へ出す。
const INTENSITY_Z = 1000

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

// 緊急地震速報の発報時: まず震源を中心に表示し、予報円(S波)が現在の表示に
// 収まらなくなったらその大きさに合わせてズームアウトする。
function FitToEEW({ eew, psWave }: { eew: EEWAlert | null; psWave: PsWaveCircle[] }) {
  const map = useMap()
  const lastEewIdRef = useRef<string | null>(null)

  // 新しい EEW を受信したら震源を中心に表示
  useEffect(() => {
    if (!eew) {
      lastEewIdRef.current = null
      return
    }
    const { latitude, longitude } = eew.earthquake.hypocenter
    if (latitude <= -200 || longitude <= -200) return
    if (lastEewIdRef.current === eew.id) return
    lastEewIdRef.current = eew.id
    map.flyTo([latitude, longitude], MAX_ZOOM, { duration: 0.8 })
  }, [eew, map])

  // 予報円の成長に追従してズームアウト（表示に収まらなくなった時のみ）
  useEffect(() => {
    if (psWave.length === 0) return
    let bounds: L.LatLngBounds | null = null
    for (const c of psWave) {
      const b = L.latLng(c.lat, c.lng).toBounds(c.sRadius * 2 * 1000)
      bounds = bounds ? bounds.extend(b) : b
    }
    if (bounds && !map.getBounds().contains(bounds)) {
      map.flyToBounds(bounds, { padding: [60, 60], maxZoom: MAX_ZOOM, duration: 0.8 })
    }
  }, [psWave, map])

  return null
}

// 揺れ検知時に検知点群が収まるようにフィットし、検知終了時は日本全体に戻す。
function FitToDetection({ points }: { points: DetectedPoint[] }) {
  const map = useMap()
  const fittedRef = useRef(false)

  useEffect(() => {
    if (points.length === 0) {
      if (fittedRef.current) {
        fittedRef.current = false
        map.flyTo(JAPAN_CENTER, JAPAN_ZOOM, { duration: 1.0 })
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
  }, [points, map])

  return null
}

// リアルタイムタブを開いた時点で EEW が無ければ日本全体を表示する。
// （地図は全タブ共通のため、他タブで寄った表示をリセットする）
function FitJapanOnEnter({ hasEew }: { hasEew: boolean }) {
  const map = useMap()
  useEffect(() => {
    if (!hasEew) map.setView(JAPAN_CENTER, JAPAN_ZOOM)
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
  iconScale?: number
  showBathymetry?: boolean
  kyoshinSites?: SiteCoords
  kyoshinIndices?: number[]
  kyoshinPsWave?: PsWaveCircle[]
  eew?: EEWAlert | null
  detectedPoints?: DetectedPoint[]
}

export function JapanMap({
  mode,
  quake,
  tsunamis,
  iconScale = 1,
  showBathymetry = true,
  kyoshinSites = [],
  kyoshinIndices = [],
  kyoshinPsWave = [],
  eew = null,
  detectedPoints = [],
}: Props) {
  const stationCoords = useStationCoords()
  const tsunamiZones = useTsunamiZones()
  const prefectures = usePrefectures()
  const [zoom, setZoom] = useState(JAPAN_ZOOM)

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

  // 各地点を座標に解決し、震度の弱い順に並べる（強い震度を最前面に描画するため）
  const intensityMarkers = useMemo<IntensityMarker[]>(() => {
    if (mode !== 'quake' || !quake || !stationCoords) return []
    const markers: IntensityMarker[] = []
    quake.points.forEach((p, i) => {
      const position = lookupPointCoords(stationCoords, p.pref, p.addr, p.isArea)
      if (!position) return
      markers.push({
        key: `${p.pref}|${p.addr}|${i}`,
        position,
        scale: p.scale,
        pref: p.pref,
        addr: p.addr,
      })
    })
    return markers.sort((a, b) => a.scale - b.scale)
  }, [mode, quake, stationCoords])

  // 中間より引きのときは観測点ごとではなく都道府県ごとの最大震度に集約する。
  const aggregateByPref = mode === 'quake' && !!quake && zoom < PREF_AGGREGATE_MAX_ZOOM

  // 都道府県ごとの最大震度を境界形状（塗りつぶし）＋県中心マーカーとして引き当てる。
  const prefAggregates = useMemo(() => {
    if (!aggregateByPref || !prefectures) return []
    const list: { name: string; scale: number; rings: LatLng[][]; label: LatLng }[] = []
    for (const [name, scale] of prefIntensities) {
      const shape = prefectures[name]
      if (shape) list.push({ name, scale, rings: shape.rings, label: shape.label })
    }
    // 弱い震度を先に描画し、強い震度を前面に重ねる
    return list.sort((a, b) => a.scale - b.scale)
  }, [aggregateByPref, prefectures, prefIntensities])

  // 津波: 進行中の警報・注意報を区域名→最大等級にまとめ、海岸線を引き当てる
  const tsunamiLines = useMemo<TsunamiLine[]>(() => {
    if (mode !== 'tsunami' || !tsunamiZones) return []
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
  }, [mode, tsunamis, tsunamiZones])

  // 地震モードのフィット対象（各観測点 + 震源）
  const quakeFitPositions = useMemo<LatLng[]>(() => {
    const positions = intensityMarkers.map((m) => m.position)
    if (hasEpicenter && quake) {
      positions.push([
        quake.earthquake.hypocenter.latitude,
        quake.earthquake.hypocenter.longitude,
      ])
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
      center={JAPAN_CENTER}
      zoom={JAPAN_ZOOM}
      className="h-full w-full"
      zoomControl={false}
      preferCanvas
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

      {/* 強震モニタ: Yahoo リアルタイム震度の観測点を描画 */}
      {mode === 'kyoshin' && (
        <KyoshinPoints sites={kyoshinSites} indices={kyoshinIndices} iconScale={iconScale} detailMinZoom={PREF_AGGREGATE_MAX_ZOOM} />
      )}

      {/* リアルタイムタブ入室時: EEW が無ければ日本全体を表示 */}
      {mode === 'kyoshin' && <FitJapanOnEnter hasEew={!!eew} />}

      {/* 揺れ検知点: FitToDetection は常時レンダリングして検知終了時の日本全体戻しを担う */}
      {mode === 'kyoshin' && (
        <>
          <FitToDetection points={detectedPoints} />
          {detectedPoints.map((p, i) => (
            <CircleMarker
              key={`det-${i}`}
              center={[p.lat, p.lng]}
              radius={10 * iconScale}
              pathOptions={{
                color: '#ffffff',
                weight: 1.5,
                fillColor: kyoshinColor(p.index),
                fillOpacity: 0.85,
              }}
            />
          ))}
        </>
      )}

      {/* EEW 発報時: 震源中心→予報円に合わせてズームアウト */}
      {mode === 'kyoshin' && <FitToEEW eew={eew} psWave={kyoshinPsWave} />}

      {/* 緊急地震速報の予報円（S波=塗りつぶし / P波=外周） */}
      {mode === 'kyoshin' &&
        kyoshinPsWave.map((c, i) => (
          <Fragment key={`ps-${i}`}>
            <Circle
              center={[c.lat, c.lng]}
              radius={c.sRadius * 1000}
              pathOptions={{ color: '#ff3c00', weight: 2, fillColor: '#ff3c00', fillOpacity: 0.12 }}
            />
            <Circle
              center={[c.lat, c.lng]}
              radius={c.pRadius * 1000}
              pathOptions={{ color: '#38bdf8', weight: 2, fill: false, dashArray: '4 4' }}
            />
          </Fragment>
        ))}

      {/* 緊急地震速報の震源（震源地名ラベル付き） */}
      {mode === 'kyoshin' &&
        eew &&
        eew.earthquake.hypocenter.latitude > -200 &&
        eew.earthquake.hypocenter.longitude > -200 && (
          <Marker
            position={[
              eew.earthquake.hypocenter.latitude,
              eew.earthquake.hypocenter.longitude,
            ]}
            icon={getEpicenterIcon(iconScale)}
            zIndexOffset={1000}
          >
            <Tooltip permanent direction="top" offset={[0, -10]}>
              <span className="font-bold">{eew.earthquake.hypocenter.name}</span>
              {' '}
              M{eew.earthquake.hypocenter.magnitude.toFixed(1)}
              {eewMaxScale(eew) > 0 && ` 最大震度${getIntensityLabel(eewMaxScale(eew))}予想`}
            </Tooltip>
          </Marker>
        )}

      {mode === 'quake' && (
        <FitToBounds signature={quakeSignature} positions={quakeFitPositions} />
      )}
      {mode === 'tsunami' && (
        <FitToBounds signature={tsunamiSignature} positions={tsunamiFitPositions} />
      )}

      {/* 津波予報区の海岸線（等級ごとに色分け） */}
      {mode === 'tsunami' &&
        tsunamiLines.map((line) =>
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

      {/* 中間より引き: 都道府県ごとの最大震度を県塗りつぶし＋県中心マーカーで表示。
          塗りはラベル(basemap-labels z270)より背面の専用ペイン(z260)に置く。 */}
      {aggregateByPref && (
        <Pane name="quake-pref-fill" style={{ zIndex: 260 }}>
          {prefAggregates.map((p) =>
            p.rings.map((ring, i) => (
              <Polygon
                key={`pref-fill-${p.name}-${i}`}
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
      {aggregateByPref &&
        prefAggregates.map((p) => (
          <Marker
            key={`pref-mark-${p.name}`}
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

      {/* 各地点の震度マーカー（震度ごとに色分け・震度を表記。寄りのときのみ） */}
      {mode === 'quake' && !aggregateByPref &&
        intensityMarkers.map((m) => (
          <Marker
            key={m.key}
            position={m.position}
            icon={getIntensityIcon(m.scale, iconScale)}
            zIndexOffset={m.scale * INTENSITY_Z}
          >
            <Popup>
              <div className="text-sm">
                <div className="font-bold">
                  {m.pref}
                  {m.addr}
                </div>
                <div className="text-gray-600 text-xs">
                  震度 {getIntensityLabel(m.scale)}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}

      {/* 震源マーカー（震度サマリーのポップアップ付き） */}
      {mode === 'quake' && hasEpicenter && quake && (
        <Marker
          position={[
            quake.earthquake.hypocenter.latitude,
            quake.earthquake.hypocenter.longitude,
          ]}
          icon={getEpicenterIcon(iconScale)}
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
