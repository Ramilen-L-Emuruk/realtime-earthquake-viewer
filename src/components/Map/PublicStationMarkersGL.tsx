import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { escapeHtml } from './gl/popupHtml'
import { ensurePublicStationIcons, PUBLIC_STATION_ICON_BASE_RADIUS, publicStationIconId } from './gl/publicStationIcons'
import { publicStationHeading } from '../SeismoWaveChart'

// 公開観測点（波形を出している気象庁の観測点）の位置に、波形の見出しと同じ番号の三角を置く
// （`docs/public-waveform-design.md` §0・§7）。印の焼き方は gl/publicStationIcons.ts。
//
// **出すのは波形を出している間**: 下部の波形に公開観測点を出していればその観測点（地図のモードを問わない）、
// 出していなければ地震モードで開いた地震カードの観測点（どちらを出すかは App が決める。下部の波形を優先する）。

const SRC = 'public-stations'
const LYR = 'public-stations'
// 当たり判定の余裕（震度観測点のドットと揃える）。
const HIT_TOL_PX = 8
/** 表示の大きさ（外接円の半径・px・倍率を掛ける前。2026-10-15 ユーザー承認）。 */
const DISPLAY_RADIUS_PX = 14

export interface PublicStationMarker {
  readonly code: string
  readonly number: number
  readonly nameJa: string
  readonly lat: number
  readonly lon: number
}

const EMPTY_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

function buildFC(markers: readonly PublicStationMarker[], iconScale: number): FeatureCollection<Point> {
  const iconSize = (DISPLAY_RADIUS_PX * iconScale) / PUBLIC_STATION_ICON_BASE_RADIUS
  const features: Feature<Point>[] = markers.map((m) => ({
    type: 'Feature',
    properties: {
      icon: publicStationIconId(m.number),
      iconSize,
      heading: publicStationHeading(m.number, m.nameJa),
      // **若い番号を手前へ**（`symbol-sort-key` は値が大きいほど手前）。重なったとき #1 が読めるように。
      sortKey: -m.number,
    },
    geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
  }))
  return { type: 'FeatureCollection', features }
}

/** 吹き出し（ホバーとクリック）。波形の見出しと同じ「#1 宮城丸森」だけを出す。 */
function popupHtml(f: MapGeoJSONFeature): string {
  return `<div style="font-weight:600;font-size:12px;white-space:nowrap">${escapeHtml(String(f.properties?.heading ?? ''))}</div>`
}

interface Props {
  markers: readonly PublicStationMarker[]
  iconScale: number
  visible: boolean
}

export function PublicStationMarkersGL({ markers, iconScale, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  /** 最後に流し込んだ内容の署名。**同じなら流し込まない**（参照が変わるたびに geojson を作り直すと空回りする）。 */
  const lastSigRef = useRef<string | null>(null)
  const popupRef = useRef<PopupHandle | null>(null)

  useEffect(() => {
    if (!map) return
    ensurePublicStationIcons(map)
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: LYR,
      type: 'symbol',
      source: SRC,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['get', 'iconSize'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'sortKey'],
        visibility: visible ? 'visible' : 'none',
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: LYR,
      priority: 'point',
      tolPx: HIT_TOL_PX,
      buildHoverHtml: popupHtml,
      buildClickHtml: popupHtml,
    })
    addedRef.current = true
    lastSigRef.current = null
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
    }
    // 表示の切り替えは下の effect が持つ（ここで visible を見ると、切り替えのたびにレイヤーを作り直す）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  useEffect(() => {
    if (!map || !addedRef.current) return
    const sig = `${iconScale}|${markers.map((m) => `${m.code},${m.number},${m.nameJa},${m.lat},${m.lon}`).join(';')}`
    if (sig === lastSigRef.current) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    if (src === undefined) return
    src.setData(buildFC(markers, iconScale))
    lastSigRef.current = sig
  }, [map, markers, iconScale])

  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
