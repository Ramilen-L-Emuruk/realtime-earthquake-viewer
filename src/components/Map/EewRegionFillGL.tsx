import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getIntensityColor, getIntensityLabelWithApproxAbove } from '../../utils/intensity'
import type { EewAreaFill } from '../../hooks/useEewLayerData'
import { serverNow } from '../../utils/clock'
import { eewArrivalEtaSecFromMs } from '../../utils/eew'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'

// EEW 対象地域の予想最大震度を区域塗りで表示する MapLibre 版（Leaflet の eew-region-fill 相当）。
// 警報域（種別コードで判定。→ `isEewWarningKindCode`）は fillOpacity 0.55・枠 weight2 で強調、予報域は 0.3・weight1。
// 塗り色は予想震度色(getIntensityColor)。区域中心マーカーは持たない（Leaflet 版と同じ）。
//
// クリックで区域名・予想震度・警報種別に加え、その区域への主要動到達までの秒数を出す。
//
// **秒数は気象庁が電文で出した到達予測時刻（`Area/ArrivalTime`）から作る。** 自前で走時を解いて
// 「この区域へ何秒後」を出すのは、気象庁が許可制と定める地震動の予報業務に当たりうる
// （→ `docs/spec/eew-spec.md` §6）。ここは気象庁の値をそのまま伝える側。
//
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

// 各区域の全リングを塗り用 Feature 群にする。弱い予想震度が先（下）・強い方が後（前面）。
function buildFC(areaFills: EewAreaFill[]): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = []
  for (const a of areaFills) {
    const color = getIntensityColor(a.scale)
    const { kind: arrivalKind, arrivalMs } = a.arrival
    for (const ring of a.rings) {
      features.push({
        type: 'Feature',
        properties: {
          color,
          fillOpacity: a.isWarning ? 0.55 : 0.3,
          lineWidth: a.isWarning ? 2 : 1,
          name: a.name,
          scale: a.scale,
          scaleOrAbove: a.scaleOrAbove,
          isWarning: a.isWarning,
          // GeoJSON の属性は原始値しか持てないので、組を解いて 2 つの属性へ入れる。
          arrivalKind,
          arrivalMs: arrivalMs ?? -1,
        },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(ring)] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

// 上限が定まらない区域（「震度4以上」）はバッジにも語を出す。塗り色は下限の階級色のままで、
// 色を変える手立ては無いため、断定に見えないよう文字側で補う。
function scaleLabelOf(f: MapGeoJSONFeature): string {
  return getIntensityLabelWithApproxAbove(
    Number(f.properties?.scale ?? 0),
    Boolean(f.properties?.scaleOrAbove),
  )
}

function hoverHtml(f: MapGeoJSONFeature): string {
  const scale = Number(f.properties?.scale ?? 0)
  return (
    `<div style="display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">` +
    `${badgeHtml(scaleLabelOf(f), getIntensityColor(scale))}` +
    `<span style="font-weight:600">${escapeHtml(String(f.properties?.name ?? ''))}</span></div>`
  )
}

/**
 * 主要動到達の一行。**気象庁が到達を伝えていない区域では行そのものを出さない。**
 *
 * 「約」を付けているのは、これが**区域という単位に対する発表値**で、同じ区域の中でも場所に
 * よって到達が変わるため。**気象庁がこの値をどう算出しているかは確かめていない**ので、
 * 算出の方法には踏み込まない（区域の代表点に対する値だ、とは書けない）。
 */
function arrivalRowHtml(f: MapGeoJSONFeature): string {
  const kind = String(f.properties?.arrivalKind ?? 'none')
  if (kind === 'none') return ''
  if (kind === 'arrived') {
    return `<div style="margin-top:4px;font-size:12px;font-weight:700;color:#94a3b8">主要動 到達済み</div>`
  }
  // **属性の値をそのまま信じない。** GeoJSON の属性は何でも入りうるうえ、到達の情報が無い区域は
  // `-1` が入る（原始値しか持てないので「無い」を数値で表している）。有限で正の値だけ通す。
  const arrivalMs = Number(f.properties?.arrivalMs ?? NaN)
  if (!(arrivalMs > 0)) return ''
  // 残り秒数の丸めは `eewArrivalEtaSecFromMs` の 1 箇所に任せる（出す先が 3 つあるため）。
  const etaSec = eewArrivalEtaSecFromMs(arrivalMs, serverNow())
  if (etaSec === null) return ''
  const text = etaSec > 0 ? `主要動の到達まで 約${etaSec}秒` : '主要動 到達済み'
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
    `${badgeHtml(scaleLabelOf(f), getIntensityColor(scale))}` +
    `<span style="color:#cbd5e1">予想震度 ${escapeHtml(scaleLabelOf(f))}</span>` +
    `<span style="color:${kindColor};font-weight:700">${kind}</span></div>` +
    arrivalRowHtml(f) +
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
