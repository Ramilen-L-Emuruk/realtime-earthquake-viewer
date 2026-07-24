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
// ドットは観測点リスト取得時に一度だけ生成し、毎秒の更新は表示レベルが変化した点の色替えのみ
// （半径は iconScale 変更時のみ全点再適用）。KyoshinSubThreshold と同じ差分更新方式。
export function KyoshinPoints({ sites, indices, iconScale }: Props) {
  const map = useMap()
  const markersRef = useRef<L.CircleMarker[]>([])
  // 各点に前回適用した表示レベル（0 = 不可視、7+ = 可視・気象庁配色）。差分更新用。
  const prevLevelsRef = useRef<Int8Array>(new Int8Array(0))
  // 前回適用した iconScale（半径の全点再適用が必要かの判定用）
  const prevScaleRef = useRef(iconScale)

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
    // 生成直後は全点 fillOpacity 0（レベル 0 相当）・そのときの iconScale の半径
    prevLevelsRef.current = new Int8Array(sites.length)
    prevScaleRef.current = iconScale
    return () => {
      group.remove()
      // renderer は circleMarker 経由で暗黙に地図へ追加されるため、明示的に外さないと
      // 空になった <svg> コンテナが kyoshin-points ペインに残り続ける
      // （React StrictMode の mount→cleanup→再mount で特に顕在化する）。
      renderer.remove()
      markersRef.current = []
      prevLevelsRef.current = new Int8Array(0)
    }
    // sites は初回取得後は不変。map も不変。
  }, [sites, map])

  // 震度インデックス・UI倍率の更新時の差分更新。全点を毎秒無条件に触ると
  // 約1,725点×6属性/秒の DOM 書き込みになるため（移行計画 §6 段階0）、二経路に分ける:
  //   - 半径: 震度によらず BASE_RADIUS × iconScale 固定のため、iconScale 変化時のみ全点再適用
  //   - 色: 可視になるのは index 7+（震度1以上）のみ。index 0〜6（震度0以下は
  //     KyoshinSubThreshold が描画）と未データは fillOpacity=0 の同一描画状態のため
  //     レベル 0 に正規化し、前回適用レベルから変化した点だけ setStyle する
  //     （静止時はほぼ全点据え置きになり、毎秒の DOM 書き込みがほぼ 0 になる）
  useEffect(() => {
    const markers = markersRef.current
    if (markers.length === 0) return
    if (prevScaleRef.current !== iconScale) {
      prevScaleRef.current = iconScale
      const radius = BASE_RADIUS * iconScale
      for (let i = 0; i < markers.length; i++) markers[i].setRadius(radius)
    }
    const prevLevels = prevLevelsRef.current
    for (let i = 0; i < markers.length; i++) {
      const idx = indices[i]
      const level = idx != null && idx >= 7 ? idx : 0
      if (level === prevLevels[i]) continue
      prevLevels[i] = level
      const color = kyoshinIntensityColor(level)
      markers[i].setStyle({ fillColor: color ?? SHINDO0_COLOR, fillOpacity: color ? 0.85 : 0 })
    }
  }, [indices, iconScale])

  return null
}
