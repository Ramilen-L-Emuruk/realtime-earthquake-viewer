import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import type { SiteCoords } from '../../services/kyoshin'
import { kyoshinIntensityColor, SHINDO0_COLOR } from '../../utils/kyoshinIntensity'
import { MAP_CANVAS_PADDING } from './mapCanvasPadding'

interface Props {
  sites: SiteCoords
  indices: number[]
  iconScale: number
}

// 震度0の点（および未データ）のドット半径
const BASE_RADIUS = 2.5

// 強震モニタの観測点（約1725点）を SVG の色付きドットで描画するレイヤー。
// Canvas ではなく SVG レンダラー（L.svg）を使うことで、flyTo/ズームアニメーション中に
// 大きな Canvas バッファを再合成するコストが発生しない（理由は BaseMap.tsx の同種コメント参照。
// このため専用ペイン kyoshin-points は flyToLite.ts の HIDDEN_DURING_FLY_PANES に含めていない）。
//   index 0（データ無し）= 非表示 / index 1〜6（震度0以下）= KyoshinSubThreshold が描画 / index 7+（震度1以上）= 気象庁配色・固定サイズ（確定後は KyoshinDetectedPoints が可変サイズで上書き）
// ドットは観測点リスト取得時に一度だけ生成し、毎秒の更新は色と半径の変更のみ行う。
export function KyoshinPoints({ sites, indices, iconScale }: Props) {
  const map = useMap()
  const markersRef = useRef<L.CircleMarker[]>([])

  // 観測点が揃ったら一度だけマーカーを生成して地図に追加する
  useEffect(() => {
    if (sites.length === 0) return
    const renderer = L.svg({ pane: 'kyoshin-points', padding: MAP_CANVAS_PADDING })
    const group = L.layerGroup()
    const markers = sites.map(([lat, lng]) =>
      L.circleMarker([lat, lng], {
        renderer,
        radius: BASE_RADIUS * iconScale,
        stroke: false,
        fillOpacity: 0,
        fillColor: SHINDO0_COLOR,
        interactive: false,
      }),
    )
    markers.forEach((m) => m.addTo(group))
    group.addTo(map)
    markersRef.current = markers
    return () => {
      group.remove()
      // renderer は circleMarker 経由で暗黙に地図へ追加されるため、明示的に外さないと
      // 空になった <svg> コンテナが kyoshin-points ペインに残り続ける
      // （React StrictMode の mount→cleanup→再mount で特に顕在化する）。
      renderer.remove()
      markersRef.current = []
    }
    // sites は初回取得後は不変。map も不変。
  }, [sites, map])

  // 震度インデックス・UI倍率の更新時に各ドットの色を更新。半径は震度によらず BASE_RADIUS 固定。
  //   index 0（データ無し）・1〜6（震度0以下）= fillOpacity=0（index 1〜6 は KyoshinSubThreshold が描画）
  //   index 7+（震度1以上）= 気象庁配色・固定サイズ
  useEffect(() => {
    const markers = markersRef.current
    if (markers.length === 0) return
    const radius = BASE_RADIUS * iconScale
    for (let i = 0; i < markers.length; i++) {
      const idx = indices[i]
      const color = kyoshinIntensityColor(idx)
      // index 1〜6（震度0以下）は KyoshinSubThreshold が OffscreenCanvas で描画（index 0 はどちらも非表示）
      const fillOpacity = idx != null && idx <= 6 ? 0 : color ? 0.85 : 0
      markers[i].setRadius(radius)
      markers[i].setStyle({ fillColor: color ?? SHINDO0_COLOR, fillOpacity })
    }
  }, [indices, iconScale])

  return null
}
