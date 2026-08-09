import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getLpgmClassColor, getLpgmClassLabel } from '../../utils/lpgm'
import type { LpgmMarker } from '../../hooks/useQuakeLayerData'
import { addOrderedLayer } from './gl/layerOrder'
import { bindPointPopup, type PointPopupHandle } from './gl/pointPopup'
import { badgeHtml, escapeHtml } from './gl/popupHtml'

// 長周期地震動観測点を色付きドットで描画する MapLibre 版（Leaflet の LpgmPoints 相当）。
// 高ズーム時（区域集約しないとき）に階級 1〜4 を JMA 公式色で表示する。色は前計算して feature
// プロパティに持たせ、circle-sort-key に lgInt を与えて強い階級を前面へ（弱→強の順）。
//
// ホバー／クリックのポップアップは震度観測点（QuakeIntensityPointsGL）と同じ作法で束ねる。
// この2つは同じ地震モード内で LPGM 表示の有無だけで入れ替わるため、片方だけ無反応にしない。

const SRC = 'quake-lpgm-points'
const LYR = 'quake-lpgm-points'
const BASE_RADIUS = 5
// 円が小さいので当たり判定に余裕を持たせる（QuakeIntensityPointsGL と同じ考え方）。
const HIT_TOL_PX = 8

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  markers: LpgmMarker[]
  iconScale: number
  visible: boolean
}

function buildFC(markers: LpgmMarker[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = markers.map((m) => ({
    type: 'Feature',
    properties: {
      color: getLpgmClassColor(m.lgInt),
      lgInt: m.lgInt,
      name: m.name,
      pref: m.pref,
    },
    geometry: { type: 'Point', coordinates: [m.position[1], m.position[0]] },
  }))
  return { type: 'FeatureCollection', features }
}

function hoverHtml(f: MapGeoJSONFeature): string {
  const lgInt = Number(f.properties?.lgInt ?? 0)
  return (
    `<div style="display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">` +
    `${badgeHtml(String(lgInt), getLpgmClassColor(lgInt))}` +
    `<span style="font-weight:600">${escapeHtml(String(f.properties?.name ?? ''))}</span></div>`
  )
}

function clickHtml(f: MapGeoJSONFeature): string {
  const lgInt = Number(f.properties?.lgInt ?? 0)
  const pref = String(f.properties?.pref ?? '')
  return (
    `<div style="min-width:150px">` +
    `<div style="font-weight:700;font-size:13px">${escapeHtml(String(f.properties?.name ?? ''))}</div>` +
    (pref ? `<div style="margin-top:2px;font-size:11px;color:#94a3b8">${escapeHtml(pref)}</div>` : '') +
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
    `${badgeHtml(String(lgInt), getLpgmClassColor(lgInt))}` +
    `<span style="color:#cbd5e1">長周期地震動${escapeHtml(getLpgmClassLabel(lgInt))}</span></div>` +
    `</div>`
  )
}

export function LpgmPointsGL({ markers, iconScale, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const popupRef = useRef<PointPopupHandle | null>(null)

  useEffect(() => {
    if (!map) return
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: LYR,
      type: 'circle',
      source: SRC,
      layout: {
        'circle-sort-key': ['get', 'lgInt'],
        visibility: visible ? 'visible' : 'none',
      },
      paint: {
        'circle-radius': BASE_RADIUS * iconScale,
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.9,
        'circle-stroke-color': 'rgba(255,255,255,0.7)',
        'circle-stroke-width': 1,
      },
    })
    popupRef.current = bindPointPopup(map, LYR, {
      tolPx: HIT_TOL_PX,
      rankKey: 'lgInt',
      buildHoverHtml: hoverHtml,
      buildClickHtml: clickHtml,
    })
    addedRef.current = true
    return () => {
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
    src?.setData(buildFC(markers))
  }, [map, markers])

  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setPaintProperty(LYR, 'circle-radius', BASE_RADIUS * iconScale)
  }, [map, iconScale])

  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
