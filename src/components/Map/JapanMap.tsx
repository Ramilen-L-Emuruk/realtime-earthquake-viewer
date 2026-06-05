import { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from 'react-leaflet'
import type { JMAQuake, JMATsunami, TsunamiGrade } from '../../types/earthquake'
import { getIntensityColor, getIntensityLabel, getScaleRadius } from '../../utils/intensity'
import { formatMagnitude, formatDepth } from '../../utils/formatters'
import { useStationCoords } from '../../hooks/useStationCoords'
import { lookupPointCoords, type LatLng } from '../../utils/stationCoords'
import { useTsunamiZones } from '../../hooks/useTsunamiZones'

const epicenterIcon = L.divIcon({
  className: '',
  html: `<svg viewBox="0 0 32 32" width="32" height="32" xmlns="http://www.w3.org/2000/svg">
    <line x1="4" y1="4" x2="28" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/>
    <line x1="28" y1="4" x2="4"  y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/>
  </svg>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -18],
})

// 震度ラベル付きの塗りつぶし円アイコン。震度ごとにキャッシュして再利用する。
const intensityIconCache = new Map<number, L.DivIcon>()

function getIntensityIcon(scale: number): L.DivIcon {
  const cached = intensityIconCache.get(scale)
  if (cached) return cached

  const size = getScaleRadius(scale) * 2 + 8
  const color = getIntensityColor(scale)
  const label = getIntensityLabel(scale)
  const fontSize = label.length > 1 ? size * 0.42 : size * 0.6
  const icon = L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;background:${color};border:1px solid rgba(255,255,255,0.7);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${fontSize}px;line-height:1;box-shadow:0 0 3px rgba(0,0,0,0.7)">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
  intensityIconCache.set(scale, icon)
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

export type MapMode = 'quake' | 'tsunami'

interface Props {
  mode: MapMode
  quake: JMAQuake | null
  tsunamis: JMATsunami[]
}

export function JapanMap({ mode, quake, tsunamis }: Props) {
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
                weight: TSUNAMI_STYLE[line.grade].weight,
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
            icon={getIntensityIcon(m.scale)}
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
          icon={epicenterIcon}
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
