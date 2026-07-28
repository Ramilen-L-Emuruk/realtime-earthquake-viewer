import { JapanMap } from './JapanMap'
import { JapanMapGL } from './JapanMapGL'
import type { JapanMapProps, MapMode } from './mapTypes'

// 地図エンジンの切替点。Leaflet 版 JapanMap と MapLibre 版 JapanMapGL を同一 Props で出し分ける。
// MapLibre 移行計画 docs/webgl-migration-implementation-plan.md F0。移行完了（F7）まで既定は
// Leaflet で、フラグ ON のときだけ MapLibre を使う（本番挙動は既定のまま不変）。
//
// 優先順位: 環境変数 VITE_MAP_ENGINE='maplibre'（dev 専用の強制）＞ engine prop（設定タブ由来）＞ 既定 'leaflet'。
export type MapEngine = 'leaflet' | 'maplibre'
export type { MapMode }

const ENV_ENGINE = (import.meta.env as Record<string, string | undefined>).VITE_MAP_ENGINE as
  | MapEngine
  | undefined

interface MapViewProps extends JapanMapProps {
  engine?: MapEngine
}

export function MapView({ engine, ...props }: MapViewProps) {
  const resolved: MapEngine = ENV_ENGINE ?? engine ?? 'leaflet'
  return resolved === 'maplibre' ? <JapanMapGL {...props} /> : <JapanMap {...props} />
}
