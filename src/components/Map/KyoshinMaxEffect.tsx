import { useCallback, useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { SiteCoords } from '../../services/kyoshin'
import { kyoshinIntensityColor, kyoshinIndexToJma } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'

const DURATION = 600
const MIN_TRIGGER_INDEX = 7
const SVG_NS = 'http://www.w3.org/2000/svg'

interface Ripple {
  lat: number
  lng: number
  color: string
  startTime: number
  baseRadius: number
  el: SVGCircleElement
}

// 最大震度更新時の波紋エフェクトを SVG で描画するレイヤー。
// Canvas ではなく SVG を使うことで flyTo/ズームアニメーション中の再合成コストが発生しない
// （理由は KyoshinPoints 参照）。同時に有効な波紋は通常 0〜1個程度の短命なアニメーションなので、
// 波紋ごとに <circle> を1個生成し、rAF ループでその属性（cx/cy/r/stroke-opacity）だけを
// 毎フレーム更新する。
export function KyoshinMaxEffect({
  sites,
  indices,
  iconScale,
}: {
  sites: SiteCoords
  indices: number[]
  iconScale: number
}) {
  const map = useMap()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const ripplesRef = useRef<Ripple[]>([])
  const rafRef = useRef<number | null>(null)
  const prevMaxIdxRef = useRef<number>(-1)

  useEffect(() => {
    const pane = map.getPane('kyoshin-points')
    if (!pane) return
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.style.position = 'absolute'
    svg.style.pointerEvents = 'none'
    svg.style.transformOrigin = '0 0'
    svg.style.overflow = 'visible'
    pane.appendChild(svg)
    svgRef.current = svg
    return () => {
      svg.remove()
      svgRef.current = null
    }
  }, [map])

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return

    const loop = () => {
      const svg = svgRef.current
      if (!svg) {
        rafRef.current = null
        return
      }
      const now = performance.now()
      const size = map.getSize()
      svg.setAttribute('width', String(size.x))
      svg.setAttribute('height', String(size.y))
      // L.DomUtil.setPosition は型定義上 HTMLElement を要求するが、実装は style.transform の
      // 書き換えのみで SVGElement でも問題なく動作する。
      L.DomUtil.setPosition(svg as unknown as HTMLElement, map.containerPointToLayerPoint([0, 0]))

      const expired = ripplesRef.current.filter((r) => now - r.startTime >= DURATION)
      for (const r of expired) r.el.remove()
      ripplesRef.current = ripplesRef.current.filter((r) => now - r.startTime < DURATION)

      for (const r of ripplesRef.current) {
        const t = (now - r.startTime) / DURATION
        const eased = 1 - (1 - t) * (1 - t)
        const radius = r.baseRadius + r.baseRadius * 3 * eased
        const alpha = 0.75 * (1 - t)
        const pt = map.latLngToContainerPoint(L.latLng(r.lat, r.lng))
        r.el.setAttribute('cx', String(pt.x))
        r.el.setAttribute('cy', String(pt.y))
        r.el.setAttribute('r', String(radius))
        r.el.setAttribute('stroke-opacity', String(alpha))
      }

      if (ripplesRef.current.length > 0) {
        rafRef.current = requestAnimationFrame(loop)
      } else {
        rafRef.current = null
      }
    }

    rafRef.current = requestAnimationFrame(loop)
  }, [map])

  useEffect(() => {
    if (indices.length === 0 || sites.length === 0) return

    let maxIdx = -1
    let maxSiteIdx = -1
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] > maxIdx) {
        maxIdx = indices[i]
        maxSiteIdx = i
      }
    }

    // 再生リセット・データソース切替で最大値が大幅に下落した場合は前回最大をリセット
    if (maxIdx < prevMaxIdxRef.current - 5) {
      prevMaxIdxRef.current = maxIdx
      return
    }

    if (maxIdx >= MIN_TRIGGER_INDEX && maxIdx > prevMaxIdxRef.current && maxSiteIdx >= 0) {
      const svg = svgRef.current
      if (svg) {
        const [lat, lng] = sites[maxSiteIdx]
        const color = kyoshinIntensityColor(maxIdx) ?? '#ffffff'
        const jma = kyoshinIndexToJma(maxIdx)
        const baseRadius = jma ? (getScaleRadius(jma.scale) + 2) * iconScale : 3 * iconScale
        const el = document.createElementNS(SVG_NS, 'circle')
        el.setAttribute('fill', 'none')
        el.setAttribute('stroke', color)
        el.setAttribute('stroke-width', '2.5')
        svg.appendChild(el)
        ripplesRef.current = [
          ...ripplesRef.current,
          { lat, lng, color, startTime: performance.now(), baseRadius, el },
        ]
        startLoop()
      }
    }

    prevMaxIdxRef.current = maxIdx
  }, [indices, sites, iconScale, startLoop])

  useEffect(() => {
    const onZoomAnim = (e: L.ZoomAnimEvent) => {
      const svg = svgRef.current
      if (!svg) return
      const scale = map.getZoomScale(e.zoom)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const offset = (map as any)._latLngBoundsToNewLayerBounds(map.getBounds(), e.zoom, e.center).min
      L.DomUtil.setTransform(svg as unknown as HTMLElement, offset, scale)
    }
    map.on('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    return () => {
      map.off('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    }
  }, [map])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  return null
}
