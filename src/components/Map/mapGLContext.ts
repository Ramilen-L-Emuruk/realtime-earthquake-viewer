import { createContext, useContext } from 'react'
import type * as maplibregl from 'maplibre-gl'

// MapLibre の map インスタンスを子レイヤーコンポーネントへ配るための Context。
// react-leaflet の useMap 相当を自前で用意する（後続フェーズで各レイヤーが購読する）。
// map 生成前は null。
export const MapGLContext = createContext<maplibregl.Map | null>(null)

// レイヤーコンポーネント用フック。map 未生成（null）の間は何もしない前提で使う。
export function useMapGL(): maplibregl.Map | null {
  return useContext(MapGLContext)
}
