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

function intensityBadgeIcon(color: string, label: string, scale: number, iconScale: number): L.DivIcon {
  const size = (getScaleRadius(scale) * 2 + 8) * iconScale
  const fontSize = label.length > 1 ? size * 0.42 : size * 0.6
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;background:${color};border:1px solid rgba(255,255,255,0.7);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${fontSize}px;line-height:1;box-shadow:0 0 3px rgba(0,0,0,0.7)">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// 強震モニタの観測点（約1725点）を Canvas で描画するレイヤー。
// ドットは観測点リスト取得時に一度だけ生成し、毎秒の更新は色の変更のみ行う
// （震度0未満=非表示 / 震度0=灰色の点 / 震度1以上=気象庁配色の点）。
// さらに、震度1以上の各点には震度階級の数字バッジを常時重ねて表示する。
export function KyoshinPoints({ sites, indices, iconScale }: Props) {
  const map = useMap()
  const markersRef = useRef<L.CircleMarker[]>([])
  const labelGroupRef = useRef<L.LayerGroup | null>(null)

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
        fillOpacity: 0,
        fillColor: SHINDO0_COLOR,
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

  // 震度インデックスの更新時に各ドットの色を更新。震度0未満は透明（非表示）。
  useEffect(() => {
    const markers = markersRef.current
    if (markers.length === 0) return
    for (let i = 0; i < markers.length; i++) {
      const color = kyoshinIntensityColor(indices[i])
      markers[i].setStyle({
        fillColor: color ?? SHINDO0_COLOR,
        fillOpacity: color ? 0.85 : 0,
      })
    }
  }, [indices])

  // UI 倍率の変更時に各ドットの半径を更新
  useEffect(() => {
    markersRef.current.forEach((m) => m.setRadius(2.5 * iconScale))
  }, [iconScale])

  // 震度1以上の各点に震度階級の数字バッジを常時表示（ズームに依らない）。
  // 毎秒の indices 更新で対象集合・震度が変わるため作り直す。
  useEffect(() => {
    const group = labelGroupRef.current
    if (!group) return
    group.clearLayers()
    for (let i = 0; i < sites.length; i++) {
      const jma = kyoshinIndexToJma(indices[i])
      // 震度0未満は非表示、震度0は灰色の点のみ（数字バッジは出さない）。震度1以上にバッジ。
      if (!jma || jma.label === '0') continue
      const color = kyoshinIntensityColor(indices[i]) ?? SHINDO0_COLOR
      const [lat, lng] = sites[i]
      L.marker([lat, lng], {
        icon: intensityBadgeIcon(color, jma.label, jma.scale, iconScale),
        interactive: false,
        keyboard: false,
        zIndexOffset: jma.scale * 1000,
      }).addTo(group)
    }
  }, [sites, indices, iconScale])

  return null
}
