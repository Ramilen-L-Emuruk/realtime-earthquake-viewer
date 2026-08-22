import { useEffect, useRef } from 'react'
import { useMapGL } from './mapGLContext'
import type { ActiveFaultSegment } from '../../utils/activeFaults'
import { segmentsToMultiLineFC } from './gl/geojson'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { twoLinePopupHtml } from './gl/popupHtml'
import { addOrderedLayer } from './gl/layerOrder'
import { detailMinZoom } from './gl/zoomLevels'
import { bindDynamicZoomRange, clampMinZoom } from './gl/viewSpan'

// 全国活断層線（産総研 活断層データベース）を描画する MapLibre 版（Leaflet の ActiveFaultsLayer 相当）。
// セグメント1件=MultiLineString feature 1件（約580件）にまとめ、1枚の line レイヤーで描く。
// 表示/非表示は layout.visibility の切替のみ（データ再構築はしない）。クリック時は bbox tolerance で
// 当たり判定し、活断層名のポップアップを出す（Leaflet 版の透明ヒット線＋tolerance に相当）。

// ダーク地図に馴染ませた控えめな活断層色（鮮やかな #c2410c は目立ちすぎるため彩度を落とした暗い赤茶）。
const FAULT_COLOR = '#96421f'
// 線クリックの当たり判定許容（px）。旧 Leaflet の Canvas ヒットレンダラー tolerance:8 に揃える。
const HIT_TOL_PX = 8

const SRC = 'active-faults'
const LYR = 'active-faults'

interface Props {
  activeFaults: ActiveFaultSegment[] | null
  visible: boolean
  opacity: number
}

export function ActiveFaultsGL({ activeFaults, visible, opacity }: Props) {
  const map = useMapGL()
  const popupRef = useRef<PopupHandle | null>(null)

  // データ到着で一度だけ source + layer を構築。
  useEffect(() => {
    if (!map || !activeFaults) return
    const fc = segmentsToMultiLineFC(activeFaults, (seg) => ({ name: seg.name }))
    map.addSource(SRC, { type: 'geojson', data: fc })
    // MAP_LAYER_ORDER に従い kyoshin/quake の各レイヤーより下へ挿入する（追加順非依存）。
    addOrderedLayer(map, {
      id: LYR,
      type: 'line',
      source: SRC,
      // 引いた画では線が潰れて列島が塗り潰された塊になるため描画しない（gl/zoomLevels.ts）。
      minzoom: clampMinZoom(detailMinZoom(map)),
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
        visibility: visible ? 'visible' : 'none',
      },
      paint: {
        'line-color': FAULT_COLOR,
        'line-width': 1,
        'line-opacity': opacity,
        // スライダー操作が引きずらないよう既定トランジションを無効化。
        'line-opacity-transition': { duration: 0, delay: 0 },
      },
    })
    // 下限ズームは視野の実距離で決まるため、ペインの寸法が変わるたび張り替える（上の初期値と同じ関数）。
    const unbindZoomRange = bindDynamicZoomRange(map, [{ layerId: LYR, minZoom: detailMinZoom }])
    popupRef.current = registerPopupSource(map, {
      layerId: LYR,
      priority: 'line',
      tolPx: HIT_TOL_PX,
      buildClickHtml: (f) =>
        twoLinePopupHtml(String(f.properties?.name ?? ''), '活断層（産総研 活断層データベース）'),
    })
    return () => {
      unbindZoomRange()
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

  // 濃さ（不透明度）の変更を反映。
  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setPaintProperty(LYR, 'line-opacity', opacity)
  }, [map, opacity, activeFaults])

  return null
}
