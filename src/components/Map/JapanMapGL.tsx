import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MapGLContext } from './mapGLContext'
import type { JapanMapProps } from './mapTypes'
import { log } from '../../utils/logger'

// MapLibre GL JS 版の地図コンポーネント（Leaflet 版 JapanMap と同一 Props）。
// MapLibre 移行計画 docs/webgl-migration-implementation-plan.md のフェーズ順に、
// このコンポーネントへレイヤーを積み増していく。F0 は空地図の骨格のみ
// （背景色＋日本中心・map インスタンスを Context 提供）。以降のレイヤーは
// 子コンポーネントが useMapGL() で map を購読して描画する。
//
// maplibre-gl 6 は default export を持たないため `import * as maplibregl`。

// JapanMap.tsx の JAPAN_CENTER は Leaflet の [lat,lng]。MapLibre は [lng,lat] のため入れ替える。
const JAPAN_CENTER: [number, number] = [138.0, 38.0]
const INITIAL_ZOOM = 5

export function JapanMapGL(_props: JapanMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [map, setMap] = useState<maplibregl.Map | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const m = new maplibregl.Map({
      container: containerRef.current,
      center: JAPAN_CENTER,
      zoom: INITIAL_ZOOM,
      attributionControl: false,
      // F0: 背景色のみの空スタイル。ソース/レイヤーは後続フェーズで追加する。
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } }],
      },
    })
    mapRef.current = m
    m.on('error', (e) => log.error('[JapanMapGL] map error', e.error))
    m.once('load', () => setMap(m))
    return () => {
      mapRef.current = null
      setMap(null)
      m.remove()
    }
  }, [])

  return (
    <div ref={containerRef} className="absolute inset-0">
      <MapGLContext.Provider value={map}>
        {/* 後続フェーズのレイヤーコンポーネントはここに置く（map を Context で購読） */}
      </MapGLContext.Provider>
    </div>
  )
}
