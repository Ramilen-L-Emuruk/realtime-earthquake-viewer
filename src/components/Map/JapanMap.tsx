import { Fragment, useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import { MapContainer, TileLayer, Marker, Polyline, Circle, Popup, Tooltip, useMap } from 'react-leaflet'
import type { JMAQuake, JMATsunami, TsunamiGrade, EEWAlert } from '../../types/earthquake'
import { getIntensityColor, getIntensityLabel, getScaleRadius } from '../../utils/intensity'
import { formatMagnitude, formatDepth } from '../../utils/formatters'
import { eewMaxScale } from '../../utils/eew'
import { useStationCoords } from '../../hooks/useStationCoords'
import { lookupPointCoords, type LatLng } from '../../utils/stationCoords'
import { useTsunamiZones } from '../../hooks/useTsunamiZones'
import { KyoshinPoints } from './KyoshinPoints'
import type { SiteCoords, PsWaveCircle } from '../../services/kyoshin'

// 震源の×印アイコン。UI 倍率ごとにキャッシュして再利用する。
const epicenterIconCache = new Map<number, L.DivIcon>()

function getEpicenterIcon(uiScale: number): L.DivIcon {
  const cached = epicenterIconCache.get(uiScale)
  if (cached) return cached

  const s = Math.round(32 * uiScale)
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
  epicenterIconCache.set(uiScale, icon)
  return icon
}

// 震度ラベル付きの塗りつぶし円アイコン。震度 × UI 倍率ごとにキャッシュして再利用する。
const intensityIconCache = new Map<string, L.DivIcon>()

function getIntensityIcon(scale: number, uiScale: number): L.DivIcon {
  const key = `${scale}:${uiScale}`
  const cached = intensityIconCache.get(key)
  if (cached) return cached

  const size = (getScaleRadius(scale) * 2 + 8) * uiScale
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

const CARTO_DARK_URL =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const CARTO_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'

// 与えられた座標群に地図をフィットさせる。signature が変わったときのみ実行する。
function FitToBounds({ signature, positions }: { signature: string; positions: LatLng[] }) {
  const map = useMap()
  const lastFitRef = useRef<string>('')

  useEffect(() => {
    if (!signature || positions.length === 0) return
    if (lastFitRef.current === signature) return
    lastFitRef.current = signature

    if (positions.length === 1) {
      map.flyTo(positions[0], 8, { duration: 1.0 })
      return
    }
    map.flyToBounds(L.latLngBounds(positions), {
      padding: [48, 48],
      maxZoom: 9,
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
    map.flyTo([latitude, longitude], 7, { duration: 0.8 })
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
      map.flyToBounds(bounds, { padding: [60, 60], duration: 0.8 })
    }
  }, [psWave, map])

  return null
}

export type MapMode = 'quake' | 'tsunami' | 'kyoshin'

interface Props {
  mode: MapMode
  quake: JMAQuake | null
  tsunamis: JMATsunami[]
  uiScale?: number
  kyoshinSites?: SiteCoords
  kyoshinIndices?: number[]
  kyoshinPsWave?: PsWaveCircle[]
  eew?: EEWAlert | null
}

export function JapanMap({
  mode,
  quake,
  tsunamis,
  uiScale = 1,
  kyoshinSites = [],
  kyoshinIndices = [],
  kyoshinPsWave = [],
  eew = null,
}: Props) {
  const stationCoords = useStationCoords()
  const tsunamiZones = useTsunamiZones()

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
    >
      <TileLayer url={CARTO_DARK_URL} attribution={CARTO_ATTRIBUTION} />

      {/* 強震モニタ: Yahoo リアルタイム震度の観測点を描画 */}
      {mode === 'kyoshin' && (
        <KyoshinPoints sites={kyoshinSites} indices={kyoshinIndices} uiScale={uiScale} />
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
            icon={getEpicenterIcon(uiScale)}
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
                weight: TSUNAMI_STYLE[line.grade].weight * uiScale,
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

      {/* 各地点の震度マーカー（震度ごとに色分け・震度を表記） */}
      {mode === 'quake' &&
        intensityMarkers.map((m) => (
          <Marker
            key={m.key}
            position={m.position}
            icon={getIntensityIcon(m.scale, uiScale)}
            zIndexOffset={m.scale}
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
          icon={getEpicenterIcon(uiScale)}
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
