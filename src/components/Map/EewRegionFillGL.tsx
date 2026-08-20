import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getIntensityColor, getIntensityLabel } from '../../utils/intensity'
import type { EewAreaFill } from '../../hooks/useEewLayerData'
import { haversineKm } from '../../utils/geo'
import { serverNow } from '../../utils/clock'
import { computeSWaveTravelTimeSec } from '../../hooks/usePsWaveCalc'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'

// EEW 対象地域の予想最大震度を区域塗りで表示する MapLibre 版（Leaflet の eew-region-fill 相当）。
// 警報域(isWarning: kindCode 10/11/19)は fillOpacity 0.55・枠 weight2 で強調、予報域は 0.3・weight1。
// 塗り色は予想震度色(getIntensityColor)。区域中心マーカーは持たない（Leaflet 版と同じ）。
//
// クリックで区域名・予想震度・警報種別に加え、その区域へのS波到達までの秒数を出す。
// 秒数は時間経過で変わるため、到達の**絶対時刻**を feature に持たせ、表示のたびに現在時刻との差へ直す
// （ポップアップを開いている間は popupRegistry の refreshMs が毎秒作り直す）。

const FILL_SRC = 'eew-region-fill'
const FILL_LYR = 'eew-region-fill'
const LINE_LYR = 'eew-region-fill-line'
// 面レイヤーなので当たり判定の余裕は最小でよい。
const HIT_TOL_PX = 2
const REFRESH_MS = 1000

const EMPTY_FC: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] }

interface Props {
  areaFills: EewAreaFill[]
  visible: boolean
}

/**
 * 区域代表点へのS波到達時刻(epoch ms)を求める。震源未確定なら -1。
 * 距離・深さから走時を解いて発生時刻に足す（自宅向けの useSWaveCountdown と同じ2層速度モデル）。
 */
function sArrivalMsOf(a: EewAreaFill): number {
  if (!a.origin) return -1
  const distanceKm = haversineKm(a.origin.lat, a.origin.lng, a.label[0], a.label[1])
  const travelSec = computeSWaveTravelTimeSec(distanceKm, a.origin.depth)
  const originMs = new Date(a.origin.originTime).getTime()
  if (!Number.isFinite(originMs)) return -1
  return originMs + travelSec * 1000
}

// 各区域の全リングを塗り用 Feature 群にする。弱い予想震度が先（下）・強い方が後（前面）。
function buildFC(areaFills: EewAreaFill[]): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = []
  for (const a of areaFills) {
    const color = getIntensityColor(a.scale)
    const sArrivalMs = sArrivalMsOf(a)
    for (const ring of a.rings) {
      features.push({
        type: 'Feature',
        properties: {
          color,
          fillOpacity: a.isWarning ? 0.55 : 0.3,
          lineWidth: a.isWarning ? 2 : 1,
          name: a.name,
          scale: a.scale,
          isWarning: a.isWarning,
          sArrivalMs,
        },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(ring)] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function hoverHtml(f: MapGeoJSONFeature): string {
  const scale = Number(f.properties?.scale ?? 0)
  return (
    `<div style="display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">` +
    `${badgeHtml(getIntensityLabel(scale), getIntensityColor(scale))}` +
    `<span style="font-weight:600">${escapeHtml(String(f.properties?.name ?? ''))}</span></div>`
  )
}

/** S波到達の一行。到達済み・推定不能は文言を変える。 */
function arrivalRowHtml(sArrivalMs: number): string {
  if (!(sArrivalMs > 0)) return ''
  const etaSec = Math.round((sArrivalMs - serverNow()) / 1000)
  const text = etaSec > 0 ? `S波到達まで 約${etaSec}秒` : 'S波到達済み'
  const color = etaSec > 0 ? '#fca5a5' : '#94a3b8'
  return `<div style="margin-top:4px;font-size:12px;font-weight:700;color:${color}">${text}</div>`
}

function clickHtml(f: MapGeoJSONFeature): string {
  const scale = Number(f.properties?.scale ?? 0)
  const isWarning = Boolean(f.properties?.isWarning)
  // 予報級の電文は VXSE45「緊急地震速報（地震動予報）」。表示も実態に合わせる
  const kind = isWarning ? '警報' : '地震動予報'
  const kindColor = isWarning ? '#f87171' : '#fbbf24'
  return (
    `<div style="min-width:160px">` +
    `<div style="font-weight:700;font-size:13px">${escapeHtml(String(f.properties?.name ?? ''))}</div>` +
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
    `${badgeHtml(getIntensityLabel(scale), getIntensityColor(scale))}` +
    `<span style="color:#cbd5e1">予想震度 ${escapeHtml(getIntensityLabel(scale))}</span>` +
    `<span style="color:${kindColor};font-weight:700">${kind}</span></div>` +
    arrivalRowHtml(Number(f.properties?.sArrivalMs ?? -1)) +
    `</div>`
  )
}

export function EewRegionFillGL({ areaFills, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const popupRef = useRef<PopupHandle | null>(null)

  useEffect(() => {
    if (!map) return
    map.addSource(FILL_SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: FILL_LYR,
      type: 'fill',
      source: FILL_SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'] },
    })
    addOrderedLayer(map, {
      id: LINE_LYR,
      type: 'line',
      source: FILL_SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'lineWidth'] },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: FILL_LYR,
      priority: 'fill',
      tolPx: HIT_TOL_PX,
      rankKey: 'scale',
      buildHoverHtml: hoverHtml,
      buildClickHtml: clickHtml,
      refreshMs: REFRESH_MS,
    })
    addedRef.current = true
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      if (map.getLayer(LINE_LYR)) map.removeLayer(LINE_LYR)
      if (map.getLayer(FILL_LYR)) map.removeLayer(FILL_LYR)
      if (map.getSource(FILL_SRC)) map.removeSource(FILL_SRC)
      addedRef.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(FILL_SRC) as GeoJSONSource | undefined
    src?.setData(buildFC(areaFills))
  }, [map, areaFills])

  useEffect(() => {
    if (!map || !map.getLayer(FILL_LYR)) return
    const v = visible ? 'visible' : 'none'
    map.setLayoutProperty(FILL_LYR, 'visibility', v)
    map.setLayoutProperty(LINE_LYR, 'visibility', v)
  }, [map, visible])

  return null
}
