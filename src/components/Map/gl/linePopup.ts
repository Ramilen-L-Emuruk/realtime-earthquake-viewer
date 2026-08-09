import * as maplibregl from 'maplibre-gl'
import type { Map as MapLibreMap, MapMouseEvent, MapGeoJSONFeature } from 'maplibre-gl'
import { escapeHtml } from './popupHtml'

// 線レイヤーのクリック当たり判定＋ポップアップを担う共通ユーティリティ。
// MapLibre の queryRenderedFeatures はクリック点の実描画ピクセルにヒットした feature を返すため、
// 細い線では数 px ずれると外れる。Leaflet 版が透明ヒット線＋tolerance で吸収していたのに合わせ、
// クリック点の周囲 ±tolPx の bbox で問い合わせて許容範囲を持たせる。
// カーソルも線上でポインタに変える（mouseenter/leave は実ジオメトリ判定で十分）。

export interface LinePopupHandle {
  remove: () => void
}

export function bindLinePopup(
  map: MapLibreMap,
  layerId: string,
  tolPx: number,
  buildHtml: (feature: MapGeoJSONFeature) => string,
): LinePopupHandle {
  const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '260px' })

  const onClick = (e: MapMouseEvent) => {
    const { x, y } = e.point
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [x - tolPx, y - tolPx],
      [x + tolPx, y + tolPx],
    ]
    const feats = map.queryRenderedFeatures(box, { layers: [layerId] })
    if (feats.length === 0) return
    popup.setLngLat(e.lngLat).setHTML(buildHtml(feats[0])).addTo(map)
  }
  const onEnter = () => { map.getCanvas().style.cursor = 'pointer' }
  const onLeave = () => { map.getCanvas().style.cursor = '' }

  map.on('click', onClick)
  map.on('mouseenter', layerId, onEnter)
  map.on('mouseleave', layerId, onLeave)

  return {
    remove: () => {
      map.off('click', onClick)
      map.off('mouseenter', layerId, onEnter)
      map.off('mouseleave', layerId, onLeave)
      popup.remove()
    },
  }
}

// ポップアップ本文の共通スタイル（Leaflet 版の buildXxxPopupContent と同じ2段組み）。
// title / subtitle はプレーンテキストとして埋め込むため、呼び出し側で信頼できる値のみ渡す
// （データは自前生成の public/data 由来で、ユーザー入力は含まない）。
export function twoLinePopupHtml(title: string, subtitle: string): string {
  return (
    `<div class="text-sm"><div class="font-bold">${escapeHtml(title)}</div>` +
    `<div class="text-xs" style="color:#94a3b8">${escapeHtml(subtitle)}</div></div>`
  )
}
