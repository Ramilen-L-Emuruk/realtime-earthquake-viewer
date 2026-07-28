import { useEffect, useRef } from 'react'
import { useMapGL } from './mapGLContext'
import type { ActiveFaultSegment } from '../../utils/activeFaults'
import { segmentsToMultiLineFC } from './gl/geojson'
import { bindLinePopup, twoLinePopupHtml, type LinePopupHandle } from './gl/linePopup'
import { KYOSHIN_LAYER_ORDER, firstExistingLayerId } from './gl/kyoshinLayers'

// 全国活断層線（産総研 活断層データベース）を描画する MapLibre 版（Leaflet の ActiveFaultsLayer 相当）。
// セグメント1件=MultiLineString feature 1件（約580件）にまとめ、1枚の line レイヤーで描く。
// 表示/非表示は layout.visibility の切替のみ（データ再構築はしない）。クリック時は bbox tolerance で
// 当たり判定し、活断層名のポップアップを出す（Leaflet 版の透明ヒット線＋tolerance に相当）。

const FAULT_COLOR = '#c2410c'
const HIT_TOL_PX = 4

const SRC = 'active-faults'
const LYR = 'active-faults'

interface Props {
  activeFaults: ActiveFaultSegment[] | null
  visible: boolean
}

export function ActiveFaultsGL({ activeFaults, visible }: Props) {
  const map = useMapGL()
  const popupRef = useRef<LinePopupHandle | null>(null)

  // データ到着で一度だけ source + layer を構築。
  useEffect(() => {
    if (!map || !activeFaults) return
    const fc = segmentsToMultiLineFC(activeFaults, (seg) => ({ name: seg.name }))
    map.addSource(SRC, { type: 'geojson', data: fc })
    // 線は kyoshin ドット群の下（＝あれば最初の kyoshin レイヤーの直前、無ければ最上段）へ挿入する。
    map.addLayer(
      {
        id: LYR,
        type: 'line',
        source: SRC,
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
          visibility: visible ? 'visible' : 'none',
        },
        paint: {
          'line-color': FAULT_COLOR,
          'line-width': 1.2,
          'line-opacity': 0.65,
        },
      },
      firstExistingLayerId(map, KYOSHIN_LAYER_ORDER),
    )
    popupRef.current = bindLinePopup(map, LYR, HIT_TOL_PX, (f) =>
      twoLinePopupHtml(String(f.properties?.name ?? ''), '活断層（産総研 活断層データベース）'),
    )
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
    }
  }, [map, activeFaults])

  // 表示/非表示の切替。
  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible, activeFaults])

  return null
}
