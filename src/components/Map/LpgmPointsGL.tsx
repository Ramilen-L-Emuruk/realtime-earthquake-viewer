import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import { getLpgmClassColor, getLpgmClassLabel } from '../../utils/lpgm'
import type { LpgmMarker } from '../../hooks/useQuakeLayerData'
import { buildLpgmBadgeEl, LPGM_BADGE_Z } from './gl/lpgmBadge'
import { attachMarkerClaim, HOVER_CLASS, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'

// 長周期地震動観測点を階級ラベル付き四角バッジで描画する MapLibre 版。
// 区域ラベル（LpgmRegionFillGL）と同じ HTML Marker 方式（バッジ要素は gl/lpgmBadge.ts 共有）。
// 震度観測点（QuakeIntensityPointsGL）と違い、LPGM の points は常に観測点そのもの
// （区域代表点は points ではなく regions という別枠の電文データから来る）ため、isArea の
// 出し分けは不要。
//
// 更新は電文切替時のみ（頻度が低い）なので、region-fill 同様に毎回作り直す。
// ホバーで観測点名＋階級、クリックで都道府県まで出す。

interface Props {
  markers: LpgmMarker[]
  iconScale: number
  visible: boolean
}

function hoverHtml(m: LpgmMarker): string {
  return (
    `<div style="display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap">` +
    `${badgeHtml(String(m.lgInt), getLpgmClassColor(m.lgInt))}` +
    `<span style="font-weight:600">${escapeHtml(m.name)}</span></div>`
  )
}

function clickHtml(m: LpgmMarker): string {
  return (
    `<div style="min-width:150px">` +
    `<div style="font-weight:700;font-size:13px">${escapeHtml(m.name)}</div>` +
    (m.pref ? `<div style="margin-top:2px;font-size:11px;color:#94a3b8">${escapeHtml(m.pref)}</div>` : '') +
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
    `${badgeHtml(String(m.lgInt), getLpgmClassColor(m.lgInt))}` +
    `<span style="color:#cbd5e1">長周期地震動${escapeHtml(getLpgmClassLabel(m.lgInt))}</span></div>` +
    `</div>`
  )
}

export function LpgmPointsGL({ markers, iconScale, visible }: Props) {
  const map = useMapGL()
  const markersRef = useRef<maplibregl.Marker[]>([])
  const hoverPopupsRef = useRef<maplibregl.Popup[]>([])
  const claimsRef = useRef<PopupHandle[]>([])

  // データ／倍率／表示切替のたびに全バッジを作り直す（region-fill と同じ差し替え方式）。
  useEffect(() => {
    if (!map || !visible) return

    for (const m of markers) {
      const el = buildLpgmBadgeEl(m.lgInt, iconScale)
      // 強い階級ほど前面（区域ラベルと同じ zIndex 係数）。
      el.style.zIndex = String(m.lgInt * LPGM_BADGE_Z)
      const lngLat: [number, number] = [m.position[1], m.position[0]]

      const hoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: HOVER_CLASS,
        offset: 12,
        maxWidth: '240px',
      }).setHTML(hoverHtml(m))
      const clickPopup = new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: '280px' }).setHTML(
        clickHtml(m),
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
  }, [map, markers, iconScale, visible])

  return null
}
