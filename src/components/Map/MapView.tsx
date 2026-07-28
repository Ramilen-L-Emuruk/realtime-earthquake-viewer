import { JapanMapGL } from './JapanMapGL'
import type { JapanMapProps, MapMode } from './mapTypes'

// 地図描画は MapLibre GL JS（JapanMapGL）に一本化済み。旧 Leaflet 版 JapanMap とエンジン切替フラグは
// F7 で撤去した。MapView は App と地図実装の間の薄いラッパーとして残し、Props 契約（mapTypes）を仲介する。
export type { MapMode }

export function MapView(props: JapanMapProps) {
  return <JapanMapGL {...props} />
}
