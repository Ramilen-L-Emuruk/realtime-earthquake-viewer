import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { EewEpicenter } from '../../hooks/useEewLayerData'
import { getIntensityColor, getIntensityLabel } from '../../utils/intensity'
import { formatMagnitude, formatDepth } from '../../utils/formatters'
import { attachMarkerClaim, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'

// EEW（緊急地震速報）の震源(×印・点滅)を描画する MapLibre 版（Leaflet 版 JapanMap の
// EEW 震源マーカー相当）。全モードで表示し、リアルタイム震度モード以外は半透明にする。
// 複数 EEW 時は全震源を表示する。
// 仮定震源要素（単独観測点処理）の震源はかなり薄く描いて確定震源と区別する
// （予報円を出さない・カードで M/深さを隠すのと同じ扱いを地図にも与える）。
//
// クリックで震源名・第何報・M・深さ・予想最大震度・警報種別を出す（地震情報の震源マーカーと対）。

/** 仮定震源要素の×印の不透明度倍率。確定震源に対してかなり薄くする。 */
const ASSUMED_OPACITY_RATIO = 0.35
/** 同・下限。地震/津波モードは元が 0.4 のため、倍率だけだと 0.14 まで落ちて事実上見えなくなる。 */
const ASSUMED_OPACITY_MIN = 0.2

interface Props {
  epicenters: EewEpicenter[]
  iconScale: number
  /** リアルタイム震度モードのとき不透明、それ以外は半透明（0.4）。 */
  fullOpacity: boolean
}

// 不透明度はここでは設定しない。element の style.opacity は Marker 自身が
// （地形に隠れたときの制御のため）毎フレーム上書きするので、Marker のオプションで渡す。
function buildCrossEl(iconScale: number, isAssumed: boolean): HTMLDivElement {
  const s = Math.round(32 * iconScale)
  const el = document.createElement('div')
  el.style.cssText = `width:${s}px;height:${s}px;cursor:pointer`
  if (isAssumed) el.title = '震源未確定（単独観測点処理）'
  // eew-blink クラスで点滅（Leaflet 版 getEpicenterIcon(blink=true) と同じ CSS）。
  el.innerHTML =
    `<svg viewBox="0 0 32 32" width="${s}" height="${s}" class="eew-blink" xmlns="http://www.w3.org/2000/svg">` +
    `<line x1="4" y1="4" x2="28" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/>` +
    `<line x1="28" y1="4" x2="4" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/></svg>`
  return el
}

function buildPopupHtml(ep: EewEpicenter): string {
  const isWarning = ep.severity === 'Warning'
  const kindColor = isWarning ? '#f87171' : '#fbbf24'
  const kind = isWarning ? '警報' : '予報'
  // 報番号は電文由来。最終報なら第N報より「最終報」の方が状態が伝わる。
  const serialText = ep.isFinal ? '最終報' : ep.serial ? `第${escapeHtml(ep.serial)}報` : ''
  // 単独観測点処理の初期報は震源が確定していない。数値を鵜呑みにしないよう明示する
  // （×印を薄く描く判定と同じ isAssumed を使い、判定を二重に持たない）。
  const provisional = ep.isAssumed
  return (
    `<div style="min-width:170px">` +
    `<div style="display:flex;align-items:baseline;gap:8px">` +
    `<span style="font-weight:700;font-size:13px">${escapeHtml(ep.name)}</span>` +
    (serialText ? `<span style="font-size:11px;color:#94a3b8">${serialText}</span>` : '') +
    `</div>` +
    `<div style="margin-top:2px;font-size:11px;color:#94a3b8">` +
    `${escapeHtml(formatMagnitude(ep.magnitude))} / 深さ ${escapeHtml(formatDepth(ep.depth))}</div>` +
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px">` +
    `${badgeHtml(getIntensityLabel(ep.maxScale), getIntensityColor(ep.maxScale))}` +
    `<span style="color:#cbd5e1">予想最大震度 ${escapeHtml(getIntensityLabel(ep.maxScale))}</span>` +
    `<span style="color:${kindColor};font-weight:700">${kind}</span></div>` +
    (provisional
      ? `<div style="margin-top:4px;font-size:11px;color:#fbbf24">仮定震源要素（単独観測点処理・震源未確定）</div>`
      : '') +
    `</div>`
  )
}

export function EewEpicentersGL({ epicenters, iconScale, fullOpacity }: Props) {
  const map = useMapGL()
  const markersRef = useRef<maplibregl.Marker[]>([])
  // マーカーのクリック宣言（レイヤー由来のポップアップと二重に開かないための調停）。
  const claimsRef = useRef<PopupHandle[]>([])

  useEffect(() => {
    if (!map) return
    const baseOpacity = fullOpacity ? 1 : 0.4
    for (const ep of epicenters) {
      const opacity = String(ep.isAssumed
        ? Math.max(baseOpacity * ASSUMED_OPACITY_RATIO, ASSUMED_OPACITY_MIN)
        : baseOpacity)
      const el = buildCrossEl(iconScale, ep.isAssumed)
      const popup = new maplibregl.Popup({ closeButton: true, offset: Math.round(32 * iconScale) * 0.4 }).setHTML(
        buildPopupHtml(ep),
      )
      // opacityWhenCovered は指定しない。このアプリは terrain（3D地形）を使っておらず
      // 「覆われたとき」が起きないため効果が無い一方、指定すると Marker がオクルージョン判定の
      // 経路に入り、ポップアップのクリックが効かなくなる（外すと開くことを実測で確認）。
      const marker = new maplibregl.Marker({ element: el, opacity })
        .setLngLat([ep.position[1], ep.position[0]])
        .setPopup(popup)
        .addTo(map)
      claimsRef.current.push(attachMarkerClaim(map, el))
      markersRef.current.push(marker)
    }
    return () => {
      for (const c of claimsRef.current) c.remove()
      claimsRef.current = []
      for (const mk of markersRef.current) mk.remove()
      markersRef.current = []
    }
  }, [map, epicenters, iconScale, fullOpacity])

  return null
}
