import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet'
import type { JMAQuake } from '../../types/earthquake'
import { getIntensityColor, getIntensityLabel, getScaleRadius } from '../../utils/intensity'
import { formatMagnitude, formatDepth } from '../../utils/formatters'

const JAPAN_CENTER: [number, number] = [36.5, 137.5]
const JAPAN_ZOOM = 5

const CARTO_DARK_URL =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const CARTO_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'

interface FlyToProps {
  lat: number
  lng: number
}

function FlyTo({ lat, lng }: FlyToProps) {
  const map = useMap()
  const prevRef = useRef<{ lat: number; lng: number } | null>(null)

  useEffect(() => {
    if (prevRef.current?.lat === lat && prevRef.current?.lng === lng) return
    prevRef.current = { lat, lng }
    const zoom = Math.max(map.getZoom(), 6)
    map.flyTo([lat, lng], zoom, { duration: 1.2 })
  }, [lat, lng, map])

  return null
}

interface Props {
  quake: JMAQuake | null
}

export function JapanMap({ quake }: Props) {
  const hasEpicenter =
    quake &&
    quake.earthquake.hypocenter.latitude > -200 &&
    quake.earthquake.hypocenter.longitude > -200

  const sortedPoints = quake
    ? [...quake.points].sort((a, b) => a.scale - b.scale)
    : []

  return (
    <MapContainer
      center={JAPAN_CENTER}
      zoom={JAPAN_ZOOM}
      className="h-full w-full"
      zoomControl={false}
    >
      <TileLayer url={CARTO_DARK_URL} attribution={CARTO_ATTRIBUTION} />

      {hasEpicenter && (
        <FlyTo
          lat={quake.earthquake.hypocenter.latitude}
          lng={quake.earthquake.hypocenter.longitude}
        />
      )}

      {/* Intensity observation points */}
      {sortedPoints.map((point, i) => (
        <CircleMarker
          key={`${point.pref}-${point.addr}-${i}`}
          center={[0, 0]}
          radius={getScaleRadius(point.scale)}
          pathOptions={{
            color: getIntensityColor(point.scale),
            fillColor: getIntensityColor(point.scale),
            fillOpacity: 0.8,
            weight: 1,
          }}
        >
          <Popup>
            <div className="text-sm">
              <div className="font-bold">{point.addr}</div>
              <div className="text-gray-600">{point.pref}</div>
              <div>震度 {getIntensityLabel(point.scale)}</div>
            </div>
          </Popup>
        </CircleMarker>
      ))}

      {/* Epicenter marker */}
      {hasEpicenter && quake && (
        <CircleMarker
          center={[
            quake.earthquake.hypocenter.latitude,
            quake.earthquake.hypocenter.longitude,
          ]}
          radius={10}
          pathOptions={{
            color: '#ff4444',
            fillColor: '#ff0000',
            fillOpacity: 0.9,
            weight: 2,
          }}
        >
          <Popup>
            <div className="text-sm">
              <div className="font-bold">{quake.earthquake.hypocenter.name}</div>
              <div>{formatMagnitude(quake.earthquake.hypocenter.magnitude)}</div>
              <div>深さ {formatDepth(quake.earthquake.hypocenter.depth)}</div>
            </div>
          </Popup>
        </CircleMarker>
      )}
    </MapContainer>
  )
}
