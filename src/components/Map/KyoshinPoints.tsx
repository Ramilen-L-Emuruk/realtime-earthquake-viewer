import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import type { SiteCoords } from '../../services/kyoshin'
import { kyoshinColor } from '../../utils/kyoshinColor'
import { kyoshinIndexToJma } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'

interface Props {
  sites: SiteCoords
  indices: number[]
  iconScale: number
  /** このズーム以上で各点に震度階級ラベルを表示（地震タブの詳細表示と同じ閾値）。 */
  detailMinZoom?: number
}

function intensityBadgeIcon(index: number, label: string, scale: number, iconScale: number): L.DivIcon {
  const size = (getScaleRadius(scale) * 2 + 8) * iconScale
  const fontSize = label.length > 1 ? size * 0.42 : size * 0.6
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;background:${kyoshinColor(index)};border:1px solid rgba(255,255,255,0.7);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${fontSize}px;line-height:1;box-shadow:0 0 3px rgba(0,0,0,0.7)">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// 強震モニタの観測点（約1725点）を Canvas で描画するレイヤー。
// マーカーは観測点リスト取得時に一度だけ生成し、毎秒の更新は色（と半径）の
// 変更のみ行うことで、React の再レンダリングコストを避ける。
// さらに詳細ズーム時は、揺れのある点（震度1相当以上）にだけ震度階級ラベルを重ねる。
export function KyoshinPoints({ sites, indices, iconScale, detailMinZoom = 8 }: Props) {
  const map = useMap()
  const markersRef = useRef<L.CircleMarker[]>([])
  const labelGroupRef = useRef<L.LayerGroup | null>(null)
  const [zoom, setZoom] = useState(map.getZoom())

  // 観測点が揃ったら一度だけマーカーを生成して地図に追加する
  useEffect(() => {
    if (sites.length === 0) return
    const renderer = L.canvas({ padding: 0.5 })
    const group = L.layerGroup()
    const markers = sites.map(([lat, lng]) =>
      L.circleMarker([lat, lng], {
        renderer,
        radius: 2.5 * iconScale,
        stroke: false,
        fillOpacity: 0.85,
        fillColor: kyoshinColor(undefined),
      }),
    )
    markers.forEach((m) => m.addTo(group))
    group.addTo(map)
    markersRef.current = markers
    const labelGroup = L.layerGroup().addTo(map)
    labelGroupRef.current = labelGroup
    return () => {
      group.remove()
      labelGroup.remove()
      markersRef.current = []
      labelGroupRef.current = null
    }
    // sites は初回取得後は不変。map も不変。
  }, [sites, map])

  // 震度インデックスの更新時に各マーカーの色を更新
  useEffect(() => {
    const markers = markersRef.current
    if (markers.length === 0) return
    for (let i = 0; i < markers.length; i++) {
      markers[i].setStyle({ fillColor: kyoshinColor(indices[i]) })
    }
  }, [indices])

  // UI 倍率の変更時に各マーカーの半径を更新
  useEffect(() => {
    markersRef.current.forEach((m) => m.setRadius(2.5 * iconScale))
  }, [iconScale])

  // ズーム変化を購読（詳細ズームでのラベル表示切替に使う）
  useEffect(() => {
    const onZoom = () => setZoom(map.getZoom())
    map.on('zoomend', onZoom)
    return () => {
      map.off('zoomend', onZoom)
    }
  }, [map])

  // 詳細ズーム時のみ、揺れのある点に震度階級ラベルを重ねる。
  // 毎秒の indices 更新で対象集合・震度が変わるため作り直す（対象は通常少数で軽量）。
  useEffect(() => {
    const group = labelGroupRef.current
    if (!group) return
    group.clearLayers()
    if (zoom < detailMinZoom) return
    for (let i = 0; i < sites.length; i++) {
      const info = kyoshinIndexToJma(indices[i])
      if (!info) continue
      const [lat, lng] = sites[i]
      L.marker([lat, lng], {
        icon: intensityBadgeIcon(indices[i], info.label, info.scale, iconScale),
        interactive: false,
        keyboard: false,
        zIndexOffset: info.scale * 1000,
      }).addTo(group)
    }
  }, [sites, indices, iconScale, zoom, detailMinZoom])

  return null
}
