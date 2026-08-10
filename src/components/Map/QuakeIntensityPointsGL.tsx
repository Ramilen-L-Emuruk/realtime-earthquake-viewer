import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getIntensityColor, getIntensityLabel, getScaleRadius } from '../../utils/intensity'
import type { IntensityMarker } from '../../hooks/useQuakeLayerData'
import type { LatLng } from '../../utils/stationCoords'
import { haversineKm } from '../../utils/geo'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'
import { ensureIntensityIcons, intensityIconId, INTENSITY_ICON_BASE_RADIUS } from './gl/intensityIcons'

// 地震情報タブの各観測点の震度を丸バッジ（震度ラベル付き）で描画する MapLibre 版。
// 高ズーム時（区域集約しないとき）に観測点ごとに表示する。
// バッジは Canvas2D で事前ラスタライズした画像を icon-image として貼る（gl/intensityIcons.ts）。
// symbol の text-field＋text-offset でフォントのグリフを丸の中心に揃える案は、CJK フォントの
// ベースライン特性により安定した中央揃えができなかったため不採用（詳細は intensityIcons.ts）。
// 更新は地震電文の切替時のみ（頻度が低い）なので setData で丸ごと差し替える。
//
// ホバーで観測点名＋震度、クリックで所属区域・震源距離まで出す（gl/popupRegistry.ts）。
// ズームアウト時の区域塗り（QuakeRegionFillGL）が区域名を出すのに対し、観測点表示に切り替わると
// 地図から情報が取れなくなるのを避けるため、同じ情報量をこちら側にも持たせている。

const SRC = 'quake-points'
const LYR = 'quake-points'
// 震度1の円は半径 4px しかないため、当たり判定に余裕を持たせる（指でも外さない程度）。
const HIT_TOL_PX = 8

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  markers: IntensityMarker[]
  iconScale: number
  visible: boolean
  /** 震源（ポップアップの震源距離用）。無効な電文では null。 */
  epicenter: LatLng | null
}

function buildFC(
  markers: IntensityMarker[],
  iconScale: number,
  epicenter: LatLng | null,
): FeatureCollection<Point> {
  const features: Feature<Point>[] = markers.map((m) => {
    const radius = (getScaleRadius(m.scale) + 3) * iconScale
    return {
      type: 'Feature',
      properties: {
        iconId: intensityIconId(m.scale),
        iconSizeRatio: radius / INTENSITY_ICON_BASE_RADIUS,
        scale: m.scale,
        addr: m.addr,
        pref: m.pref,
        region: m.region ?? '',
        isArea: m.isArea,
        // 震源が無い電文では距離を出さない（-1 を「不明」の番兵として扱う）。
        distanceKm: epicenter
          ? Math.round(haversineKm(epicenter[0], epicenter[1], m.position[0], m.position[1]))
          : -1,
      },
      geometry: { type: 'Point', coordinates: [m.position[1], m.position[0]] },
    }
  })
  return { type: 'FeatureCollection', features }
}

/** ポップアップの見出し。電文の addr は観測点名、isArea の地点では一次細分区域名が入っている。 */
function titleOf(f: MapGeoJSONFeature): string {
  return String(f.properties?.addr ?? '')
}

function hoverHtml(f: MapGeoJSONFeature): string {
  const scale = Number(f.properties?.scale ?? -1)
  return (
    `<div style="display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">` +
    `${badgeHtml(getIntensityLabel(scale), getIntensityColor(scale))}` +
    `<span style="font-weight:600">${escapeHtml(titleOf(f))}</span></div>`
  )
}

function clickHtml(f: MapGeoJSONFeature): string {
  const scale = Number(f.properties?.scale ?? -1)
  const pref = String(f.properties?.pref ?? '')
  const region = String(f.properties?.region ?? '')
  const isArea = Boolean(f.properties?.isArea)
  const distanceKm = Number(f.properties?.distanceKm ?? -1)

  // 観測点は「都道府県 / 所属一次細分区域」、区域代表点は区分そのものを添える。
  const sub = isArea
    ? [pref, '一次細分区域（代表点）'].filter(Boolean).join(' / ')
    : [pref, region].filter(Boolean).join(' / ')

  const rows = [
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
      `${badgeHtml(getIntensityLabel(scale), getIntensityColor(scale))}` +
      `<span style="color:#cbd5e1">震度 ${escapeHtml(getIntensityLabel(scale))}</span></div>`,
    distanceKm >= 0
      ? `<div style="margin-top:4px;font-size:11px;color:#94a3b8">震源から約 ${distanceKm}km</div>`
      : '',
  ].join('')

  return (
    `<div style="min-width:150px">` +
    `<div style="font-weight:700;font-size:13px">${escapeHtml(titleOf(f))}</div>` +
    (sub ? `<div style="margin-top:2px;font-size:11px;color:#94a3b8">${escapeHtml(sub)}</div>` : '') +
    rows +
    `</div>`
  )
}

export function QuakeIntensityPointsGL({ markers, iconScale, visible, epicenter }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const popupRef = useRef<PopupHandle | null>(null)

  useEffect(() => {
    if (!map) return
    ensureIntensityIcons(map)
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
        'symbol-sort-key': ['get', 'scale'],
        visibility: visible ? 'visible' : 'none',
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: LYR,
      priority: 'point',
      tolPx: HIT_TOL_PX,
      rankKey: 'scale',
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

  // データ／倍率変化で丸ごと差し替え。
  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(buildFC(markers, iconScale, epicenter))
  }, [map, markers, iconScale, epicenter])

  // 表示切替（区域集約時は非表示）。
  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
