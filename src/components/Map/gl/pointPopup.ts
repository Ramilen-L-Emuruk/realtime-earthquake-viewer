import * as maplibregl from 'maplibre-gl'
import type { Map as MapLibreMap, MapMouseEvent, MapGeoJSONFeature, PointLike } from 'maplibre-gl'

// 点レイヤー（観測点ドット等）にホバー／クリックのポップアップを束ねる共通ユーティリティ。
// 線用の bindLinePopup と同じく、当たり判定はクリック点の周囲 ±tolPx の bbox で問い合わせる。
// 観測点の円は震度1で半径 4px しかなく、素の実描画ヒットだとマウスでも指でも外すため。
//
// ホバーとクリックでポップアップを2つ持つ:
//   - ホバー: 閉じるボタン無し・カーソルが離れたら消える簡易表示
//   - クリック: 閉じるボタン付きで、閉じるか点の外をクリックするまで残る詳細表示
// クリック側が開いている間はホバー側を出さない（同じ点に二重で吹き出しが重なるのを防ぐ）。

export interface PointPopupHandle {
  remove: () => void
}

export interface PointPopupOptions {
  /** 当たり判定の許容半径（px）。 */
  tolPx: number
  /** 点が重なったとき、この数値プロパティが最大の feature を採用する（強い震度・高い階級を優先）。 */
  rankKey: string
  /** ホバー時の簡易表示。 */
  buildHoverHtml: (feature: MapGeoJSONFeature) => string
  /** クリック時の詳細表示。 */
  buildClickHtml: (feature: MapGeoJSONFeature) => string
}

// ホバー側のポップアップは CSS で pointer-events を切る（index.css）。
// 吹き出し自身がマウスを受け取ると「点から外れた」と判定され、出る/消えるを繰り返して明滅する。
const HOVER_CLASS = 'map-hover-popup'
const POPUP_OFFSET = 12

/** 重なった点のうち rankKey が最大の feature を返す。 */
function pickTop(feats: MapGeoJSONFeature[], rankKey: string): MapGeoJSONFeature {
  return feats.reduce((best, f) =>
    Number(f.properties?.[rankKey] ?? -Infinity) > Number(best.properties?.[rankKey] ?? -Infinity)
      ? f
      : best,
  )
}

function featureLngLat(f: MapGeoJSONFeature): [number, number] | null {
  if (f.geometry.type !== 'Point') return null
  const [lng, lat] = f.geometry.coordinates
  return [lng, lat]
}

export function bindPointPopup(
  map: MapLibreMap,
  layerId: string,
  opts: PointPopupOptions,
): PointPopupHandle {
  const hoverPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: HOVER_CLASS,
    offset: POPUP_OFFSET,
    maxWidth: '240px',
  })
  // closeOnClick は使わない。同じ click イベント内で「閉じる」と「開く」が競合するため、
  // 点の外をクリックしたときの明示的な remove（onClick 内）で閉じる。
  const clickPopup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: false,
    offset: POPUP_OFFSET,
    maxWidth: '260px',
  })

  // 同じレイヤー種別を複数枚バインドしても互いのカーソルを奪い合わないよう、
  // 自分が pointer にしたときだけ元へ戻す。
  let cursorOwned = false
  // 同じ点の上でマウスが動いている間の setHTML を避ける（DOM 作り直しによる明滅防止）。
  let hoverKey: string | null = null

  const releaseCursor = () => {
    if (!cursorOwned) return
    map.getCanvas().style.cursor = ''
    cursorOwned = false
  }

  const queryAt = (point: maplibregl.Point): MapGeoJSONFeature | null => {
    // 非表示（visibility:none）のレイヤーは queryRenderedFeatures にヒットしないため、
    // 表示切替中のレイヤーは自然に無反応になる。
    if (!map.getLayer(layerId)) return null
    const { x, y } = point
    const box: [PointLike, PointLike] = [
      [x - opts.tolPx, y - opts.tolPx],
      [x + opts.tolPx, y + opts.tolPx],
    ]
    const feats = map.queryRenderedFeatures(box, { layers: [layerId] })
    return feats.length > 0 ? pickTop(feats, opts.rankKey) : null
  }

  const closeHover = () => {
    hoverPopup.remove()
    hoverKey = null
  }

  const onMouseMove = (e: MapMouseEvent) => {
    // パン／ズーム中は吹き出しが地図に引きずられて鬱陶しいので追従しない。
    if (map.isMoving()) {
      closeHover()
      return
    }
    const f = queryAt(e.point)
    if (!f) {
      releaseCursor()
      closeHover()
      return
    }
    map.getCanvas().style.cursor = 'pointer'
    cursorOwned = true
    if (clickPopup.isOpen()) return
    const lngLat = featureLngLat(f)
    if (!lngLat) return
    const key = `${lngLat[0]},${lngLat[1]}`
    if (hoverKey === key && hoverPopup.isOpen()) return
    hoverKey = key
    hoverPopup.setLngLat(lngLat).setHTML(opts.buildHoverHtml(f)).addTo(map)
  }

  const onMouseOut = () => {
    releaseCursor()
    closeHover()
  }

  const onClick = (e: MapMouseEvent) => {
    const f = queryAt(e.point)
    if (!f) {
      clickPopup.remove()
      return
    }
    const lngLat = featureLngLat(f)
    if (!lngLat) return
    closeHover()
    clickPopup.setLngLat(lngLat).setHTML(opts.buildClickHtml(f)).addTo(map)
  }

  map.on('mousemove', onMouseMove)
  map.on('mouseout', onMouseOut)
  map.on('click', onClick)

  return {
    remove: () => {
      map.off('mousemove', onMouseMove)
      map.off('mouseout', onMouseOut)
      map.off('click', onClick)
      closeHover()
      clickPopup.remove()
      releaseCursor()
    },
  }
}
