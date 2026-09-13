import { useEffect, useRef } from 'react'
import { frontSortKeyExpression, mercatorProps } from './gl/screenDepth'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getIntensityLabelWithOrAbove } from '../../utils/intensity'
import type { IntensityMarker } from '../../hooks/useQuakeLayerData'
import type { LatLng } from '../../utils/stationCoords'
import { haversineKm } from '../../utils/geo'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'
import { NON_JMA_MARK_TITLE, withNonJmaMark } from '../../utils/formatters'
import { ensureIntensityIcons, UNRECEIVED_ICON_ID, UNRECEIVED_COLOR, INTENSITY_ICON_BASE_RADIUS } from './gl/intensityIcons'

// 震度が届いていない観測点（「震度５弱以上未入電」）を無彩色の丸で描く。
//
// 観測値の丸バッジ（QuakeIntensityPointsGL）と対になる。あちらは震度が届いた観測点、こちらは
// 届いていない観測点を受け持つ。振り分けは useQuakeLayerData（stationMarkers / unreceivedMarkers）で
// 排他なので、同じ観測点が両方に出ることはない。
//
// **出す条件が観測値のドットと違う。** 未入電モードが開いている間は寄り具合に関わらず出す
// （判定は JapanMapGL）。自動フィットの着地は常に区域集約のズームなので、観測値のドットと同じ
// 条件だけにすると**既定の画では一度も出ない**。
//
// **モードを開いている間は、地図に残るのはこの印だけ。** 区域塗り・区域バッジ・観測点のドット・
// 震度の面はまとめて引っ込み、カメラも未入電の地点だけへ寄る（→ docs/spec/quake-spec.md §9
// 「未入電モード」）。件数が多いとき（実電文で最大 60 点）に震度の表現を残すと、印が塗りの上へ
// 散って「どこが届いていないのか」が読めなくなる。
//
// 丸の形・色・文字を入れない理由は gl/intensityIcons.ts の `UNRECEIVED_ICON_ID` 付近。

const SRC = 'quake-unreceived-points'
const LYR = 'quake-unreceived-points'
// 当たり判定の余裕。観測値のドット（QuakeIntensityPointsGL）と揃える。
const HIT_TOL_PX = 8

/**
 * 丸の半径（px・倍率適用前）。
 *
 * **震度の丸バッジの大きさを借りない。** あちらは半径が震度そのものを表しており（表示半径は
 * 震度1 で 7px、震度7 で 19px）、5弱 の表示半径（12px）を当てると「5弱 のバッジが灰色に
 * なったもの」に見える。
 * 未入電は値を持たないので、**値を持たない印の大きさ**——津波の到達確認マーカー（半径 4.5px）と
 * 同じ水準——に置く。実測でも、60 点を引いた画（zoom 4.5）で 5弱 の寸法にすると灰色の塊が
 * 区域塗りを覆い隠した。
 */
const UNRECEIVED_RADIUS_PX = 5

/**
 * 並びの合成キーに渡す段（gl/screenDepth.ts）。未入電はどれも同じ値なので、実際に効くのは
 * 「画面の手前らしさ」だけ。読み取りが未入電を寄せている下限に合わせてある。
 */
const UNRECEIVED_SORT_LEVEL = 45

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
  const radius = UNRECEIVED_RADIUS_PX * iconScale
  const features: Feature<Point>[] = markers.map((m) => ({
    type: 'Feature',
    properties: {
      iconSizeRatio: radius / INTENSITY_ICON_BASE_RADIUS,
      scale: UNRECEIVED_SORT_LEVEL,
      addr: m.addr,
      pref: m.pref,
      region: m.region ?? '',
      nonJma: m.nonJma ?? false,
      // 震源が無い電文では距離を出さない（-1 を「不明」の番兵として扱う）。
      distanceKm: epicenter
        ? Math.round(haversineKm(epicenter[0], epicenter[1], m.position[0], m.position[1]))
        : -1,
      ...mercatorProps(m.position[1], m.position[0]),
    },
    geometry: { type: 'Point', coordinates: [m.position[1], m.position[0]] },
  }))
  return { type: 'FeatureCollection', features }
}

/** 吹き出しの見出し。気象庁以外が運用する観測点には `＊` を戻す（観測値のドットと同じ扱い）。 */
function popupTitle(f: MapGeoJSONFeature): string {
  return withNonJmaMark(String(f.properties?.addr ?? ''), Boolean(f.properties?.nonJma))
}

/**
 * 断定形にしないこと。**この地点の震度は観測できていない**ので、「震度5弱」と書くと嘘になる。
 * 語はカード・読み上げと揃える（気象庁の「未入電」をそのまま使う → docs/spec/quake-spec.md §4）。
 */
const UNRECEIVED_BADGE_LABEL = getIntensityLabelWithOrAbove(UNRECEIVED_SORT_LEVEL, true)

function hoverHtml(f: MapGeoJSONFeature): string {
  return (
    `<div style="display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">` +
    `${badgeHtml(UNRECEIVED_BADGE_LABEL, UNRECEIVED_COLOR)}` +
    `<span style="font-weight:600">${escapeHtml(popupTitle(f))}</span></div>`
  )
}

function clickHtml(f: MapGeoJSONFeature): string {
  const pref = String(f.properties?.pref ?? '')
  const region = String(f.properties?.region ?? '')
  const distanceKm = Number(f.properties?.distanceKm ?? -1)
  const nonJma = Boolean(f.properties?.nonJma)
  const sub = [pref, region].filter(Boolean).join(' / ')

  return (
    `<div style="min-width:150px">` +
    `<div style="font-weight:700;font-size:13px"` +
      (nonJma ? ` title="${escapeHtml(NON_JMA_MARK_TITLE)}"` : '') +
      `>${escapeHtml(popupTitle(f))}</div>` +
    (sub ? `<div style="margin-top:2px;font-size:11px;color:#94a3b8">${escapeHtml(sub)}</div>` : '') +
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
      `${badgeHtml(UNRECEIVED_BADGE_LABEL, UNRECEIVED_COLOR)}` +
      `<span style="color:#cbd5e1">震度 ${escapeHtml(UNRECEIVED_BADGE_LABEL)}</span></div>` +
    // **推定したのは気象庁**であることを書く。このアプリは強震モニタ由来の値にも「推定」を
    // 使っており（リアルタイムタブ）、主語が無いと「アプリが推定した値」と取り違えられる。
    `<div style="margin-top:4px;font-size:11px;color:#9ca3af">` +
      `気象庁は震度5弱以上と推定していますが、震度が届いていません（未入電）</div>` +
    (distanceKm >= 0
      ? `<div style="margin-top:4px;font-size:11px;color:#94a3b8">震源から約 ${distanceKm}km</div>`
      : '') +
    `</div>`
  )
}

export function QuakeUnreceivedPointsGL({ markers, iconScale, visible, epicenter }: Props) {
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
        'icon-image': UNRECEIVED_ICON_ID,
        'icon-size': ['get', 'iconSizeRatio'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': frontSortKeyExpression('scale', 0),
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

  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
