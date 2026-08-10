import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getLpgmClassColor, getLpgmClassLabel } from '../../utils/lpgm'
import type { LpgmMarker } from '../../hooks/useQuakeLayerData'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'
import { ensureLpgmIcons, lpgmIconId, LPGM_ICON_BASE_RADIUS } from './gl/lpgmIcons'

// 長周期地震動観測点を階級ラベル付き四角バッジで描画する MapLibre 版。
// バッジは Canvas2D で事前ラスタライズした画像を icon-image として貼る（gl/lpgmIcons.ts、
// 震度観測点 QuakeIntensityPointsGL と同じ理由）。
// LPGM の points は常に観測点そのもの（区域代表点は points ではなく regions という別枠の
// 電文データから来る）ため、isArea の出し分けは不要。
//
// 更新は電文切替時のみ（頻度が低い）なので setData で丸ごと差し替える。
// ホバーで観測点名＋階級、クリックで都道府県まで出す。

const SRC = 'quake-lpgm-points'
const LYR = 'quake-lpgm-points'
const BASE_RADIUS = 8
const HIT_TOL_PX = 8

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  markers: LpgmMarker[]
  iconScale: number
  visible: boolean
}

function buildFC(markers: LpgmMarker[], iconScale: number): FeatureCollection<Point> {
  const features: Feature<Point>[] = markers.map((m) => ({
    type: 'Feature',
    properties: {
      iconId: lpgmIconId(m.lgInt),
      iconSizeRatio: (BASE_RADIUS * iconScale) / LPGM_ICON_BASE_RADIUS,
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
  const popupRef = useRef<PopupHandle | null>(null)

  useEffect(() => {
    if (!map) return
    ensureLpgmIcons(map)
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: LYR,
      type: 'symbol',
      source: SRC,
      layout: {
        'icon-image': ['get', 'iconId'],
        'icon-size': ['get', 'iconSizeRatio'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'lgInt'],
        visibility: visible ? 'visible' : 'none',
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: LYR,
      priority: 'point',
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
    src?.setData(buildFC(markers, iconScale))
  }, [map, markers, iconScale])

  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
