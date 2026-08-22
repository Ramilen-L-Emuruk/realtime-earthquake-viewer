import { useEffect, useRef } from 'react'
import type { ExpressionSpecification, GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { HeatPoint } from '../../utils/quakeHeatmap'
import { formatMagnitude, formatDepth, formatDateTimeMin } from '../../utils/formatters'
import { getMagnitudeColor } from '../../utils/intensity'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'

// 直近1ヶ月の地震活動ヒートマップを描画する MapLibre 版（Leaflet 版 QuakeHeatmapLayer 相当）。
// Leaflet は leaflet.heat（Canvas）だったが、MapLibre はネイティブの heatmap レイヤーで描く。
// 区域塗り（quake-region-fill）より背面（MAP_LAYER_ORDER の quake-heat スロット）に置き、
// 震度色塗り・震源マーカーの視認性と競合させない。weight は各点の重み（0〜1 前提）。
//
// クリック／ホバーで個々の地震（震源名・M・深さ・発生時刻）を出す。ただし **heatmap レイヤーは
// queryRenderedFeatures にヒットしない**（密度を描くだけで個別 feature を返さない仕様）ため、
// 同じ点を透明な circle レイヤーで重ねて当たり判定を作る。

const SRC = 'quake-heat'
const LYR = 'quake-heat'
const HIT_LYR = 'quake-heat-hit'

// 拡散半径と密度強度がここまで上がりきる基準ズーム（これ以上寄っても値は変わらない）。
// MapLibre 基準（512px タイル）なので Leaflet 版の 8 から 1 段引いた値＝同じ縮尺（gl/viewSpan.ts 参照）。
// 「点の強度が最大に達する縮尺」＝ px あたりの密度で決まる値なので、視野の実距離ではなくズーム値で持つ。
// **レイヤーの表示上限（maxzoom）には使わない。** 移植元 leaflet.heat の `maxZoom` は「点の強度が
// 最大に達するズーム」を指す設定で表示を止めるものではなく、Leaflet 版は寄っても消えなかった。
// これを layer.maxzoom に流用していた間は、手で 1 段寄せただけでヒートマップとポップアップが
// 揃って消えていた（自動フィットの寄り上限がこの付近にあるため、自動追従では気づけない）。
const HEAT_MAX_ZOOM = 7
// 当たり判定の円半径(px)。見た目には出ないので、指で押しやすい大きさにする。
// 地図アイコンの倍率は掛けない——これは「押しやすさ」の値であって見た目の大きさではなく、
// 倍率に連れて広げると密集地域で隣の震源を拾いやすくなるため。
const HIT_RADIUS_PX = 9
const HIT_TOL_PX = 4

// ヒートマップの拡散半径(px・iconScale 適用前の基準値)。ズームに応じて補間する。
// 引きの画では「見やすい大きさ」を優先して px で決め打ちする（HEAT_MAX_ZOOM まで）。
const HEAT_RADIUS_MIN = 14
const HEAT_RADIUS_MID = 22
const HEAT_RADIUS_MID_ZOOM = 4
const HEAT_RADIUS_MAX = 30

// HEAT_MAX_ZOOM より寄ったときは、半径を「ズーム 1 段で 2 倍」＝地理的な距離が一定になるよう
// 伸ばす。**取得できる震源の座標が 0.1 度（約 11km）刻みのため**（実データで 696 点のうち 695 点が
// 0.1 度グリッド上・ユニークな座標は 139 個だけ）、それより細かく描くと 11km 格子の点描になり、
// 配信された座標より細かい位置が分かっているように見えてしまう。データの粒度に合わせてぼかす方が
// 正直で、格子も埋まる。
// なお 0.1 度は気象庁の決定精度ではなく公表時の丸め（精密な値が別電文にある事情は
// docs/spec/data-sources-spec.md §2 を参照）。カタログ API から取れるのが 0.1 度まで、という制約。
const HEAT_GEO_ZOOM = 11
const HEAT_GEO_RADIUS = HEAT_RADIUS_MAX * 2 ** (HEAT_GEO_ZOOM - HEAT_MAX_ZOOM)

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

/**
 * 拡散半径のズーム補間式。地図アイコンの倍率を掛けた値で組む。
 * 補間は `exponential` の base 2。この基数だと「ズームが 1 段上がると値が 2 倍」に正確に一致するため、
 * HEAT_MAX_ZOOM 以降で地理的な距離を保てる。低ズーム側は曲線が下に凸になって細くなりすぎるので、
 * 日本全体の縮尺付近（HEAT_RADIUS_MID_ZOOM）にストップを 1 つ挟んで持ち上げる。
 */
function heatRadiusExpr(iconScale: number): ExpressionSpecification {
  return [
    'interpolate',
    ['exponential', 2],
    ['zoom'],
    0,
    HEAT_RADIUS_MIN * iconScale,
    HEAT_RADIUS_MID_ZOOM,
    HEAT_RADIUS_MID * iconScale,
    HEAT_MAX_ZOOM,
    HEAT_RADIUS_MAX * iconScale,
    HEAT_GEO_ZOOM,
    HEAT_GEO_RADIUS * iconScale,
  ]
}

interface Props {
  points: HeatPoint[]
  /** 地図アイコンの倍率（設定値）。震度マーカー等と揃えて拡散半径を拡縮する。 */
  iconScale: number
  visible: boolean
}

function buildFC(points: HeatPoint[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = points.map((p) => ({
    type: 'Feature',
    properties: {
      weight: p.weight,
      name: p.name,
      time: p.time,
      depth: p.depth,
      magnitude: p.magnitude,
    },
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  }))
  return { type: 'FeatureCollection', features }
}

/** 震源地名。DMDSS の GD Earthquake List は名前を返さないことがある。 */
function titleOf(f: MapGeoJSONFeature): string {
  const name = String(f.properties?.name ?? '').trim()
  return name || '震源地不明'
}

function hoverHtml(f: MapGeoJSONFeature): string {
  const m = Number(f.properties?.magnitude ?? -1)
  return (
    `<div style="display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">` +
    `${badgeHtml(formatMagnitude(m), getMagnitudeColor(m))}` +
    `<span style="font-weight:600">${escapeHtml(titleOf(f))}</span></div>`
  )
}

function clickHtml(f: MapGeoJSONFeature): string {
  const m = Number(f.properties?.magnitude ?? -1)
  const depth = Number(f.properties?.depth ?? -1)
  const time = String(f.properties?.time ?? '')
  return (
    `<div style="min-width:160px">` +
    `<div style="font-weight:700;font-size:13px">${escapeHtml(titleOf(f))}</div>` +
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
    `${badgeHtml(formatMagnitude(m), getMagnitudeColor(m))}` +
    `<span style="color:#cbd5e1">深さ ${escapeHtml(formatDepth(depth))}</span></div>` +
    (time ? `<div style="margin-top:4px;font-size:11px;color:#94a3b8">${escapeHtml(formatDateTimeMin(time))}</div>` : '') +
    `</div>`
  )
}

export function QuakeHeatmapGL({ points, iconScale, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const popupRef = useRef<PopupHandle | null>(null)
  // レイヤー構築は [map] 依存のため、構築時は ref 経由で最新の倍率を読む
  // （クロージャが握った初期値のままだと、構築前に倍率を変えた場合に旧値で組まれる）。
  const iconScaleRef = useRef(iconScale)
  iconScaleRef.current = iconScale

  useEffect(() => {
    if (!map) return
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: LYR,
      type: 'heatmap',
      source: SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: {
        // 各点の重み（quakeHeatmap 側で 0〜1 に正規化済み）。
        'heatmap-weight': ['coalesce', ['get', 'weight'], 0.5],
        // 密度強度。ズームで上げるが、値そのものは低く抑える。理由は下の色ランプのコメント参照。
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.04, HEAT_MAX_ZOOM, 0.09],
        // 密度→色。**折れ点を対数的に配置する**（等間隔にしない）。
        // 地震活動は場所によって桁で違う。実データでは 0.1 度メッシュあたりの重み合計が
        // 中央値 0.15 に対し最大 16.6 と 100 倍以上開く。これを等間隔のランプで写すと、
        // 濃い側は上限に張り付いて一様な赤（境界のはっきりした塊）になり、薄い側は透明に
        // 潰れて、結局どちらの濃淡も読めなくなる。低い側を引き延ばして高い側を圧縮する。
        'heatmap-color': [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0, 'rgba(0,0,255,0)',
          0.005, 'rgba(0,0,255,0.45)',
          0.02, 'rgba(0,170,255,0.6)',
          0.08, 'rgba(0,255,128,0.7)',
          0.3, 'rgba(255,238,0,0.8)',
          0.9, 'rgba(255,0,0,0.9)',
        ],
        'heatmap-radius': heatRadiusExpr(iconScaleRef.current),
        // 寄るほど薄くする。半径を地理的な距離に合わせて伸ばす（heatRadiusExpr 参照）ため、
        // 濃さを保ったままだと高ズームでは画面全体が塗り潰されて地図が読めなくなる。
        // 引きの画は従来の濃さのまま、寄ったら下地に沈む「背景の情報」として残す。
        'heatmap-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          HEAT_MAX_ZOOM, 0.85,
          HEAT_GEO_ZOOM, 0.3,
        ],
      },
    })
    // 当たり判定専用の透明レイヤー。ヒートマップ本体と同じズーム範囲で出す（どちらもズーム上限を持たない）。
    addOrderedLayer(map, {
      id: HIT_LYR,
      type: 'circle',
      source: SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: {
        'circle-radius': HIT_RADIUS_PX,
        'circle-color': '#000000',
        'circle-opacity': 0,
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: HIT_LYR,
      priority: 'heat',
      tolPx: HIT_TOL_PX,
      rankKey: 'magnitude',
      buildHoverHtml: hoverHtml,
      buildClickHtml: clickHtml,
    })
    addedRef.current = true
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      if (map.getLayer(HIT_LYR)) map.removeLayer(HIT_LYR)
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
    }
  }, [map])

  // 倍率変更を既存レイヤーへ反映する（レイヤーの作り直しは伴わない）。
  useEffect(() => {
    if (!map || !addedRef.current) return
    if (map.getLayer(LYR)) map.setPaintProperty(LYR, 'heatmap-radius', heatRadiusExpr(iconScale))
  }, [map, iconScale])

  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(buildFC(points))
  }, [map, points])

  // 表示切替（津波モードとの往復用）。
  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    const v = visible ? 'visible' : 'none'
    map.setLayoutProperty(LYR, 'visibility', v)
    map.setLayoutProperty(HIT_LYR, 'visibility', v)
  }, [map, visible])

  return null
}
