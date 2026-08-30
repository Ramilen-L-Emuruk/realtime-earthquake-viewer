import { useEffect, useRef } from 'react'
import { useMapGL } from './mapGLContext'
import type { PlateBoundarySegment } from '../../utils/plateBoundaries'
import { segmentsToMultiLineFC } from './gl/geojson'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { twoLinePopupHtml } from './gl/popupHtml'
import { addOrderedLayer } from './gl/layerOrder'
import {
  OVERLAY_LINE_SRC,
  dropOverlayLines,
  overlayLineKindFilter,
  putOverlayLines,
  type OverlayLineProps,
} from './gl/overlayLineSource'

// 全球のプレート境界線（PB2002モデル）を描画する MapLibre 版（Leaflet の PlateBoundariesLayer 相当）。
// セグメント1件=MultiLineString feature 1件にまとめ、1枚の line レイヤーで描く。沈み込み境界と
// その他で色を変えるため type を feature プロパティに持たせ、line-color を match 式で分岐する。
// 破線は Leaflet の dashArray '6 4'（px）相当を、MapLibre の線幅単位 dasharray で weight2 に合わせ [3,2]。
//
// geojson ソースは活断層線と共有する（gl/overlayLineSource.ts）。自分の分は `kind: 'plate'` で
// 区別し、レイヤー側は filter で拾う。

const SUBDUCTION_COLOR = '#b91c1c'
const OTHER_COLOR = '#1d4ed8'
// 線クリックの当たり判定許容（px）。旧 Leaflet の Canvas ヒットレンダラー tolerance:8 に揃える。
const HIT_TOL_PX = 8

const LYR = 'plate-boundaries'

interface Props {
  plateBoundaries: PlateBoundarySegment[] | null
  visible: boolean
}

export function PlateBoundariesGL({ plateBoundaries, visible }: Props) {
  const map = useMapGL()
  const popupRef = useRef<PopupHandle | null>(null)

  useEffect(() => {
    if (!map || !plateBoundaries) return
    const fc = segmentsToMultiLineFC(
      plateBoundaries,
      (seg): OverlayLineProps & { plateA: string; plateB: string; type: string } => ({
        kind: 'plate',
        plateA: seg.plateA,
        plateB: seg.plateB,
        type: seg.type,
      }),
    )
    putOverlayLines(map, 'plate', fc.features)
    // MAP_LAYER_ORDER に従い最下層付近（活断層より下）へ挿入する（追加順非依存）。
    addOrderedLayer(map, {
      id: LYR,
      type: 'line',
      source: OVERLAY_LINE_SRC,
      filter: overlayLineKindFilter('plate'),
      layout: {
        'line-join': 'round',
        // 破線端を丸に（旧 Leaflet SVG レンダラーの既定 line-cap:round に揃える）。
        'line-cap': 'round',
        visibility: visible ? 'visible' : 'none',
      },
      paint: {
        'line-color': ['match', ['get', 'type'], 'subduction', SUBDUCTION_COLOR, OTHER_COLOR],
        'line-width': 2,
        'line-opacity': 0.55,
        'line-dasharray': [3, 2],
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: LYR,
      priority: 'line',
      tolPx: HIT_TOL_PX,
      buildClickHtml: (f) => {
        const p = f.properties ?? {}
        const type = p.type === 'subduction' ? '沈み込み境界' : '境界種別不明'
        return twoLinePopupHtml(
          `${p.plateA ?? ''} – ${p.plateB ?? ''}`,
          `プレート境界（${type}・PB2002モデル）`,
        )
      },
    })
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      // 共有ソースは自分のレイヤーを外してから降りる（参照が残っていると削除できない）。
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      dropOverlayLines(map, 'plate')
    }
  }, [map, plateBoundaries])

  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible, plateBoundaries])

  return null
}
