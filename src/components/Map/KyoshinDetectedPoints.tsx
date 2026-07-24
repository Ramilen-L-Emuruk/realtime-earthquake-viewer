import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import { kyoshinIndexToJma, kyoshinIntensityColor } from '../../utils/kyoshinIntensity'
import { getScaleRadius } from '../../utils/intensity'

const SVG_NS = 'http://www.w3.org/2000/svg'

// 揺れ検知済み（確定）観測点を SVG で描画するレイヤー。
// Canvas ではなく SVG を使うことで flyTo/ズームアニメーション中の再合成コストが発生しない
// （理由は KyoshinPoints 参照）。points は検知中のみの少数（最大でも数十点程度）なので、
// KyoshinPoints/KyoshinSubThreshold のような差分更新はせず、更新のたびに中身を作り直す
// （元の Canvas 実装と同じく毎回フルクリア＋再描画）。
// フル描画は viewreset/moveend とデータ変化時のみ。ズーム変化を伴うアニメーション中
// （flyTo・ピンチ、zoomstart〜zoomend）は svg 全体への transform 1回で追従し、
// 毎フレームの DOM 再構築を避ける（KyoshinSubThreshold と同じ方式）。
export function KyoshinDetectedPoints({
  points,
  iconScale,
}: {
  points: DetectedPoint[]
  iconScale: number
}) {
  const map = useMap()
  const svgRef = useRef<SVGSVGElement | null>(null)
  // 最後のフル描画時のビュー（描画空間）。飛行中の transform 追従の基準。
  const drawStateRef = useRef<{ zoom: number; bounds: L.LatLngBounds } | null>(null)
  // zoomstart〜zoomend の間 true（flyTo・ピンチ等）。points は検知中毎秒更新されて
  // 下の描画 effect が再実行されるため、飛行状態はローカル変数ではなく ref で持ち、
  // effect の再実行をまたいで維持する。
  const zoomingRef = useRef(false)

  useEffect(() => {
    const pane = map.getPane('kyoshin-points')
    if (!pane) return
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.style.position = 'absolute'
    svg.style.pointerEvents = 'none'
    svg.style.transformOrigin = '0 0'
    svg.style.overflow = 'visible'
    // leaflet.css の svg.leaflet-zoom-animated { will-change: transform }（常時の合成
    // レイヤー昇格）と標準ズームアニメ中の transition を他レイヤーと共有する
    svg.classList.add('leaflet-zoom-animated')
    pane.appendChild(svg)
    svgRef.current = svg
    const onZoomStart = () => { zoomingRef.current = true }
    const onZoomEnd = () => { zoomingRef.current = false }
    map.on('zoomstart', onZoomStart)
    map.on('zoomend', onZoomEnd)
    return () => {
      map.off('zoomstart', onZoomStart)
      map.off('zoomend', onZoomEnd)
      svg.remove()
      svgRef.current = null
    }
  }, [map])

  useEffect(() => {
    const draw = () => {
      const svg = svgRef.current
      if (!svg) return
      const size = map.getSize()
      svg.setAttribute('width', String(size.x))
      svg.setAttribute('height', String(size.y))
      // L.DomUtil.setPosition は型定義上 HTMLElement を要求するが、実装は style.transform の
      // 書き換えのみで SVGElement でも問題なく動作する。飛行中に掛けた transform も
      // ここで丸ごと上書きされてリセットされる。
      L.DomUtil.setPosition(svg as unknown as HTMLElement, map.containerPointToLayerPoint([0, 0]))
      drawStateRef.current = { zoom: map.getZoom(), bounds: map.getBounds() }
      while (svg.firstChild) svg.removeChild(svg.firstChild)

      // 震度の低い点から描画し、高い点を上に重ねる
      const sorted = [...points].sort((a, b) => a.index - b.index)
      for (const p of sorted) {
        const pt = map.latLngToContainerPoint(L.latLng(p.lat, p.lng))
        const color = kyoshinIntensityColor(p.index) ?? '#ffffff'
        const jma = kyoshinIndexToJma(p.index)
        const radius = jma && jma.label !== '0' ? (getScaleRadius(jma.scale) + 2) * iconScale : 2.5 * iconScale
        const circle = document.createElementNS(SVG_NS, 'circle')
        circle.setAttribute('cx', String(pt.x))
        circle.setAttribute('cy', String(pt.y))
        circle.setAttribute('r', String(radius))
        circle.setAttribute('fill', color)
        svg.appendChild(circle)
      }
    }

    // 描画空間（最後のフル描画時のビュー）から (zoom, center) のビューへの変換を
    // svg 全体の transform 1回で表現する（KyoshinSubThreshold の同名関数参照）
    const applyViewTransform = (zoom: number, center: L.LatLng) => {
      const svg = svgRef.current
      const state = drawStateRef.current
      if (!svg || !state) return
      const scale = map.getZoomScale(zoom, state.zoom)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const offset = (map as any)._latLngBoundsToNewLayerBounds(state.bounds, zoom, center).min
      L.DomUtil.setTransform(svg as unknown as HTMLElement, offset, scale)
    }

    // ズーム変化を伴うアニメーション中のみ 'move' ごとに transform 追従。
    // 純粋なパンは mapPane の translate に乗って動くため何もしない。
    const onMove = () => {
      if (zoomingRef.current) applyViewTransform(map.getZoom(), map.getCenter())
    }
    const onZoomAnim = (e: L.ZoomAnimEvent) => applyViewTransform(e.zoom, e.center)

    draw()
    map.on('viewreset moveend', draw)
    map.on('move', onMove)
    map.on('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    return () => {
      map.off('viewreset moveend', draw)
      map.off('move', onMove)
      map.off('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    }
  }, [map, points, iconScale])

  return null
}
