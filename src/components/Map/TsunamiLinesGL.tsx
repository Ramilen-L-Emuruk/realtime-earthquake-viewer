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
// 点滅周期。Leaflet の tsunami-blink（2.5s step-end）に合わせる。
const BLINK_PERIOD_MS = 2500
// サイクル内で点灯している割合（0〜80% は点灯・80〜100% は消灯）。step-end 相当のハード切替。
const BLINK_ON_RATIO = 0.8

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
        // トランジションを無効化。既定(約300ms)のままだと setPaintProperty のたびに
        // 補間され、オン(0.9)↔オフ(0) の切替が中間の透明度を経てフェードしてしまう。
        // duration:0 で瞬時に切り替え、はっきりした点滅にする。
        'line-opacity-transition': { duration: 0, delay: 0 },
      },
    })
    popupRef.current = bindLinePopup(map, LYR, HIT_TOL_PX, (f) =>
      twoLinePopupHtml(String(f.properties?.name ?? ''), String(f.properties?.label ?? '津波予報')),
    )
    // 点滅（Leaflet の tsunami-blink CSS を忠実再現）: 2.5s 周期で 0〜80% は不透明(0.9)・
    // 80〜100% は消灯(0) のハード切替（step-end 相当）。滑らかな脈動ではなくフラッシュ点滅。
    const start = performance.now()
    const pulse = () => {
      if (!map.getLayer(LYR)) return
      const t = ((performance.now() - start) % BLINK_PERIOD_MS) / BLINK_PERIOD_MS
      const opacity = t < BLINK_ON_RATIO ? 0.9 : 0
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
