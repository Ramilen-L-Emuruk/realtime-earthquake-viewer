import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet'
import type { JMAQuake } from '../../types/earthquake'
import { getIntensityColor, getIntensityLabel } from '../../utils/intensity'
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

  // Build intensity summary by prefecture for the popup legend
  const prefIntensities = quake
    ? Object.entries(
        quake.points.reduce<Record<string, number>>((acc, p) => {
          if (!acc[p.pref] || p.scale > acc[p.pref]) acc[p.pref] = p.scale
          return acc
        }, {}),
      ).sort((a, b) => b[1] - a[1])
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

      {/* Epicenter marker with intensity summary popup */}
      {hasEpicenter && quake && (
        <CircleMarker
          center={[
            quake.earthquake.hypocenter.latitude,
            quake.earthquake.hypocenter.longitude,
          ]}
          radius={12}
          pathOptions={{
            color: '#ff4444',
            fillColor: '#ff0000',
            fillOpacity: 0.9,
            weight: 2,
          }}
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
        </CircleMarker>
      )}
    </MapContainer>
  )
}
