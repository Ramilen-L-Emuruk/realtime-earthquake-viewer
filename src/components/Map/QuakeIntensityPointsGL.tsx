import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import { getIntensityColor, getIntensityLabel } from '../../utils/intensity'
import type { IntensityMarker } from '../../hooks/useQuakeLayerData'
import type { LatLng } from '../../utils/stationCoords'
import { haversineKm } from '../../utils/geo'
import { buildIntensityBadgeEl, INTENSITY_BADGE_Z } from './gl/intensityBadge'
import { attachMarkerClaim, HOVER_CLASS, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'

// 地震情報タブの各観測点の震度を丸バッジ（震度ラベル付き）で描画する MapLibre 版。
// 高ズーム時（区域集約しないとき）に観測点ごとに表示する。
// 区域ラベル（QuakeRegionFillGL）と同じ HTML Marker 方式（バッジ要素は gl/intensityBadge.ts 共有）。
// GL circle レイヤーではないため、区域塗りと違って symbol の自動衝突回避は効かない
// （観測点が密集する場所ではバッジ同士が重なりうる）。
//
// 更新は地震電文の切替時のみ（頻度が低い）なので、region-fill 同様に毎回作り直す。
// ホバーで観測点名＋震度、クリックで所属区域・震源距離まで出す。
// ズームアウト時の区域塗り（QuakeRegionFillGL）が区域名を出すのに対し、観測点表示に切り替わると
// 地図から情報が取れなくなるのを避けるため、同じ情報量をこちら側にも持たせている。

interface Props {
  markers: IntensityMarker[]
  iconScale: number
  visible: boolean
  /** 震源（ポップアップの震源距離用）。無効な電文では null。 */
  epicenter: LatLng | null
}

/** ホバー時の簡易表示（震度バッジ＋観測点名）。 */
function hoverHtml(m: IntensityMarker): string {
  return (
    `<div style="display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">` +
    `${badgeHtml(getIntensityLabel(m.scale), getIntensityColor(m.scale))}` +
    `<span style="font-weight:600">${escapeHtml(m.addr)}</span></div>`
  )
}

/** クリック時の詳細表示（震度・所属区域・震源距離）。 */
function clickHtml(m: IntensityMarker, epicenter: LatLng | null): string {
  // 観測点は「都道府県 / 所属一次細分区域」、区域代表点は区分そのものを添える。
  const sub = m.isArea
    ? [m.pref, '一次細分区域（代表点）'].filter(Boolean).join(' / ')
    : [m.pref, m.region ?? ''].filter(Boolean).join(' / ')
  const distanceKm = epicenter
    ? Math.round(haversineKm(epicenter[0], epicenter[1], m.position[0], m.position[1]))
    : -1

  const rows = [
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
      `${badgeHtml(getIntensityLabel(m.scale), getIntensityColor(m.scale))}` +
      `<span style="color:#cbd5e1">震度 ${escapeHtml(getIntensityLabel(m.scale))}</span></div>`,
    distanceKm >= 0
      ? `<div style="margin-top:4px;font-size:11px;color:#94a3b8">震源から約 ${distanceKm}km</div>`
      : '',
  ].join('')

  return (
    `<div style="min-width:150px">` +
    `<div style="font-weight:700;font-size:13px">${escapeHtml(m.addr)}</div>` +
    (sub ? `<div style="margin-top:2px;font-size:11px;color:#94a3b8">${escapeHtml(sub)}</div>` : '') +
    rows +
    `</div>`
  )
}

export function QuakeIntensityPointsGL({ markers, iconScale, visible, epicenter }: Props) {
  const map = useMapGL()
  const markersRef = useRef<maplibregl.Marker[]>([])
  const hoverPopupsRef = useRef<maplibregl.Popup[]>([])
  const claimsRef = useRef<PopupHandle[]>([])

  // データ／倍率／表示切替のたびに全バッジを作り直す（region-fill と同じ差し替え方式）。
  useEffect(() => {
    if (!map || !visible) return

    for (const m of markers) {
      const el = buildIntensityBadgeEl(m.scale, iconScale)
      // 強い震度ほど前面（区域ラベルと同じ zIndex 係数）。
      el.style.zIndex = String(m.scale * INTENSITY_BADGE_Z)
      const lngLat: [number, number] = [m.position[1], m.position[0]]

      const hoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: HOVER_CLASS,
        offset: 12,
        maxWidth: '240px',
      }).setHTML(hoverHtml(m))
      const clickPopup = new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: '280px' }).setHTML(
        clickHtml(m, epicenter),
      )

      // クリックでポップアップが開いている間はホバー吹き出しを重ねて出さない。
      el.addEventListener('mouseenter', () => {
        if (clickPopup.isOpen()) return
        hoverPopup.setLngLat(lngLat).addTo(map)
      })
      el.addEventListener('mouseleave', () => hoverPopup.remove())

      const marker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).setPopup(clickPopup).addTo(map)

      claimsRef.current.push(attachMarkerClaim(map, el))
      hoverPopupsRef.current.push(hoverPopup)
      markersRef.current.push(marker)
    }

    return () => {
      for (const c of claimsRef.current) c.remove()
      claimsRef.current = []
      for (const p of hoverPopupsRef.current) p.remove()
      hoverPopupsRef.current = []
      for (const mk of markersRef.current) mk.remove()
      markersRef.current = []
    }
  }, [map, markers, iconScale, epicenter, visible])

  return null
}
