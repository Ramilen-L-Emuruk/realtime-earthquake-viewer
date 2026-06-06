import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import type { SiteCoords } from '../../services/kyoshin'
import { kyoshinIndexToJma, kyoshinIntensityColor, SHINDO0_COLOR } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'

interface Props {
  sites: SiteCoords
  indices: number[]
  iconScale: number
}

// 震度0の点（および未データ）のドット半径
const BASE_RADIUS = 2.5

// 強震モニタの観測点（約1725点）を Canvas の色付きドットで描画するレイヤー。
// DOM（divIcon）を使わず Canvas に集約することで、観測点が多くても軽快に動作する。
//   震度0未満 = 非表示 / 震度0 = 小さい灰色の点 / 震度1以上 = 気象庁配色・震度で大きさを変える点
// ドットは観測点リスト取得時に一度だけ生成し、毎秒の更新は色と半径の変更のみ行う。
export function KyoshinPoints({ sites, indices, iconScale }: Props) {
  const map = useMap()
  const markersRef = useRef<L.CircleMarker[]>([])

  // 観測点が揃ったら一度だけマーカーを生成して地図に追加する
  useEffect(() => {
    if (sites.length === 0) return
    const renderer = L.canvas({ padding: 0.5 })
    const group = L.layerGroup()
    const markers = sites.map(([lat, lng]) =>
      L.circleMarker([lat, lng], {
        renderer,
        radius: BASE_RADIUS * iconScale,
        stroke: false,
        fillOpacity: 0,
        fillColor: SHINDO0_COLOR,
      }),
    )
    markers.forEach((m) => m.addTo(group))
    group.addTo(map)
    markersRef.current = markers
    return () => {
      group.remove()
      markersRef.current = []
    }
    // sites は初回取得後は不変。map も不変。
  }, [sites, map])

  // 震度インデックス・UI倍率の更新時に各ドットの色と半径を更新。
  //   震度0未満 = 透明（非表示） / 震度0 = 小さい灰色 / 震度1以上 = 気象庁配色・震度で大きさ
  useEffect(() => {
    const markers = markersRef.current
    if (markers.length === 0) return
    for (let i = 0; i < markers.length; i++) {
      const idx = indices[i]
      const color = kyoshinIntensityColor(idx)
      const jma = kyoshinIndexToJma(idx)
      const radius =
        jma && jma.label !== '0'
          ? (getScaleRadius(jma.scale) + 2) * iconScale
          : BASE_RADIUS * iconScale
      markers[i].setRadius(radius)
      markers[i].setStyle({ fillColor: color ?? SHINDO0_COLOR, fillOpacity: color ? 0.85 : 0 })
    }
  }, [indices, iconScale])

  return null
}
