import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { EewEpicenter } from '../../hooks/useEewLayerData'

// EEW（緊急地震速報）の震源(×印・点滅)を描画する MapLibre 版（Leaflet 版 JapanMap の
// EEW 震源マーカー相当）。全モードで表示し、リアルタイム震度モード以外は半透明にする。
// 複数 EEW 時は全震源を表示する。
// 仮定震源要素（単独観測点処理）の震源はかなり薄く描いて確定震源と区別する
// （予報円を出さない・カードで M/深さを隠すのと同じ扱いを地図にも与える）。

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
  el.style.cssText = `width:${s}px;height:${s}px`
  if (isAssumed) el.title = '震源未確定（単独観測点処理）'
  // eew-blink クラスで点滅（Leaflet 版 getEpicenterIcon(blink=true) と同じ CSS）。
  el.innerHTML =
    `<svg viewBox="0 0 32 32" width="${s}" height="${s}" class="eew-blink" xmlns="http://www.w3.org/2000/svg">` +
    `<line x1="4" y1="4" x2="28" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/>` +
    `<line x1="28" y1="4" x2="4" y2="28" stroke="#ff2222" stroke-width="4" stroke-linecap="round"/></svg>`
  return el
}

export function EewEpicentersGL({ epicenters, iconScale, fullOpacity }: Props) {
  const map = useMapGL()
  const markersRef = useRef<maplibregl.Marker[]>([])

  useEffect(() => {
    if (!map) return
    const baseOpacity = fullOpacity ? 1 : 0.4
    for (const ep of epicenters) {
      const opacity = String(ep.isAssumed
        ? Math.max(baseOpacity * ASSUMED_OPACITY_RATIO, ASSUMED_OPACITY_MIN)
        : baseOpacity)
      const el = buildCrossEl(iconScale, ep.isAssumed)
      // opacityWhenCovered も同値にする（未指定だと地形有効時に既定の 0.2 が効いてしまう）。
      const marker = new maplibregl.Marker({ element: el, opacity, opacityWhenCovered: opacity })
        .setLngLat([ep.position[1], ep.position[0]])
        .addTo(map)
      markersRef.current.push(marker)
    }
    return () => {
      for (const mk of markersRef.current) mk.remove()
      markersRef.current = []
    }
  }, [map, epicenters, iconScale, fullOpacity])

  return null
}
