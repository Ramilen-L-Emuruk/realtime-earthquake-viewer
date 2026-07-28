import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Feature, FeatureCollection, MultiLineString } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { TsunamiLine } from '../../hooks/useTsunamiLayerData'
import { TSUNAMI_STYLE } from '../../utils/tsunamiStyle'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { bindLinePopup, twoLinePopupHtml, type LinePopupHandle } from './gl/linePopup'

// 津波予報区の海岸線を等級ごとに色分けして描画する MapLibre 版（Leaflet の tsunami-lines 相当）。
// 等級1件=MultiLineString feature 1件にまとめ、色・太さを feature プロパティに前計算して
// paint 式で読む（太さは iconScale 連動）。発報中は line-opacity をパルスさせて点滅を再現。
// クリック時は bbox tolerance で当たり判定し、区域名＋等級ラベルのポップアップを出す。

const SRC = 'tsunami-lines'
const LYR = 'tsunami-lines'
const HIT_TOL_PX = 5
const BLINK_PERIOD_MS = 1000

const EMPTY_FC: FeatureCollection<MultiLineString> = { type: 'FeatureCollection', features: [] }

interface Props {
  lines: TsunamiLine[]
  iconScale: number
}

function buildFC(lines: TsunamiLine[], iconScale: number): FeatureCollection<MultiLineString> {
  const features: Feature<MultiLineString>[] = lines.map((line) => {
    const style = TSUNAMI_STYLE[line.grade]
    return {
      type: 'Feature',
      properties: { color: style.color, width: style.weight * iconScale, label: style.label, name: line.name },
      geometry: { type: 'MultiLineString', coordinates: line.segments.map(ringToLngLat) },
    }
  })
  return { type: 'FeatureCollection', features }
}

export function TsunamiLinesGL({ lines, iconScale }: Props) {
  const map = useMapGL()
  const popupRef = useRef<LinePopupHandle | null>(null)
  const rafRef = useRef<number | null>(null)
  const addedRef = useRef(false)

  useEffect(() => {
    if (!map) return
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: LYR,
      type: 'line',
      source: SRC,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['get', 'width'],
        'line-opacity': 0.9,
      },
    })
    popupRef.current = bindLinePopup(map, LYR, HIT_TOL_PX, (f) =>
      twoLinePopupHtml(String(f.properties?.name ?? ''), String(f.properties?.label ?? '津波予報')),
    )
    // 点滅（Leaflet の tsunami-blink CSS 相当）: line-opacity を正弦で 0.45〜0.9 に揺らす。
    const start = performance.now()
    const pulse = () => {
      if (!map.getLayer(LYR)) return
      const t = ((performance.now() - start) % BLINK_PERIOD_MS) / BLINK_PERIOD_MS
      const opacity = 0.45 + 0.45 * (0.5 + 0.5 * Math.cos(t * Math.PI * 2))
      map.setPaintProperty(LYR, 'line-opacity', opacity)
      rafRef.current = requestAnimationFrame(pulse)
    }
    rafRef.current = requestAnimationFrame(pulse)
    addedRef.current = true
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      popupRef.current?.remove()
      popupRef.current = null
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(buildFC(lines, iconScale))
  }, [map, lines, iconScale])

  return null
}
