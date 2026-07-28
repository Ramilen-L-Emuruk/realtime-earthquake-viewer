import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MapGLContext } from './mapGLContext'
import { BaseMapGL } from './BaseMapGL'
import { JAPAN_CENTER, fitJapan } from './gl/camera'
import type { JapanMapProps } from './mapTypes'
import { log } from '../../utils/logger'

// MapLibre GL JS 版の地図コンポーネント（Leaflet 版 JapanMap と同一 Props）。
// MapLibre 移行計画 docs/webgl-migration-implementation-plan.md のフェーズ順に、
// このコンポーネントへレイヤーを積み増していく。F0 は空地図の骨格のみ
// （背景色＋日本中心・map インスタンスを Context 提供）。以降のレイヤーは
// 子コンポーネントが useMapGL() で map を購読して描画する。
//
// maplibre-gl 6 は default export を持たないため `import * as maplibregl`。

// 初期ズーム（load 後に fitJapan で日本全体フレーミングへ合わせるため暫定値）。
const INITIAL_ZOOM = 5

export function JapanMapGL({ showBathymetry = true }: JapanMapProps) {
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
    // 検証用（Playwright から map を操作・レイヤー確認するため。PoC の __labelMap と同様の dev 補助）。
    ;(window as unknown as Record<string, unknown>).__mapGL = m
    m.on('error', (e) => log.error('[JapanMapGL] map error', e.error))
    m.once('load', () => {
      // 本アプリの既定フレーミング（日本全体・padding 20）へ即時に合わせる。
      fitJapan(m, 0)
      setMap(m)
    })
    return () => {
      mapRef.current = null
      setMap(null)
      m.remove()
    }
  }, [])

  // MapLibre は container に position:relative を強制するため、地図領域を埋める absolute inset-0 は
  // 外側ラッパーに掛け、MapLibre コンテナ自身は h-full/w-full でラッパーいっぱいに広げる
  // （container 直下に absolute inset-0 を掛けると position を上書きされ高さ0に潰れる）。
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full">
        <MapGLContext.Provider value={map}>
          {/* 後続フェーズのレイヤーコンポーネントはここに置く（map を Context で購読） */}
          <BaseMapGL showBathymetry={showBathymetry} />
        </MapGLContext.Provider>
      </div>
    </div>
  )
}
