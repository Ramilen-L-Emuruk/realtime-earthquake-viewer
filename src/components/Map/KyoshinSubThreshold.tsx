import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import type { SiteCoords } from '../../services/kyoshin'
import { SHINDO0_COLOR } from '../../utils/kyoshinIntensity'

interface Props {
  sites: SiteCoords
  indices: number[]
  iconScale: number
}

// index 1〜6（震度0以下）を対象とする最大インデックス（index 0 はデータ無しのため非表示）
const MAX_SUB_IDX = 6
// 観測点のドット半径（KyoshinPoints と共通）
const BASE_RADIUS = 2.5
const SVG_NS = 'http://www.w3.org/2000/svg'

// 指数関数カーブで不透明度を算出: index 0 → 0、index 6 → 0.35
// 低いほど透明になり、かつ重なっても濃くならない（レベルごとの <g opacity> 合成）
function subThresholdOpacity(idx: number): number {
  if (idx <= 0) return 0
  const t = idx / MAX_SUB_IDX
  return ((Math.exp(t) - 1) / (Math.E - 1)) * 0.35
}

// 強震モニタの震度0以下（index 1〜6）を SVG で描画するレイヤー。
// レベルごとに専用の <g opacity> グループへ <circle> を格納することで、同レベルのドット同士が
// 重なっても fill-opacity の重ね合わせで濃くならないようにする（SVG はグループ全体を一枚のレイヤーとして
// 合成してから group の opacity を掛けるため、旧実装の OffscreenCanvas 合成と同じ効果が得られる）。
// Canvas を使わないため flyTo/ズームアニメーション中の再合成コストが発生しない（KyoshinPoints 参照）。
// 観測点ぶんの <circle> は一度だけ生成し、毎秒の更新はレベルが変化した点だけ所属グループを
// 付け替える（未変化の点は一切触らない）。
export function KyoshinSubThreshold({ sites, indices, iconScale }: Props) {
  const map = useMap()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const circlesRef = useRef<SVGCircleElement[]>([])
  const groupsRef = useRef<SVGGElement[]>([])
  // 各観測点が現在所属しているレベル（0 = どのグループにも属さない＝非表示）
  const levelsRef = useRef<Int8Array>(new Int8Array(0))
  const drawFnRef = useRef<() => void>(() => {})

  // 位置更新関数を最新 props で常に更新（stale closure 回避）。
  // 全点の cx/cy/r を再計算する（表示・非表示を問わず全点分。所属グループの切替時に
  // 古い座標のまま出現しないようにするため）。
  useEffect(() => {
    drawFnRef.current = () => {
      const circles = circlesRef.current
      if (circles.length === 0) return
      const radius = BASE_RADIUS * iconScale
      for (let i = 0; i < sites.length; i++) {
        const pt = map.latLngToContainerPoint(L.latLng(sites[i][0], sites[i][1]))
        const c = circles[i]
        c.setAttribute('cx', String(pt.x))
        c.setAttribute('cy', String(pt.y))
        c.setAttribute('r', String(radius))
      }
    }
  }, [sites, iconScale, map])

  // svg/group/circle のライフサイクル: sites 取得後に kyoshin-points ペインへ追加し、地図イベントで再配置
  useEffect(() => {
    if (sites.length === 0) return
    const pane = map.getPane('kyoshin-points')
    if (!pane) return

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.style.position = 'absolute'
    svg.style.pointerEvents = 'none'
    svg.style.transformOrigin = '0 0'
    svg.style.overflow = 'visible'

    const groups: SVGGElement[] = []
    for (let level = 1; level <= MAX_SUB_IDX; level++) {
      const g = document.createElementNS(SVG_NS, 'g')
      g.style.opacity = String(subThresholdOpacity(level))
      svg.appendChild(g)
      groups.push(g)
    }
    groupsRef.current = groups

    const circles = sites.map(() => {
      const c = document.createElementNS(SVG_NS, 'circle')
      c.setAttribute('fill', SHINDO0_COLOR)
      return c
    })
    circlesRef.current = circles
    levelsRef.current = new Int8Array(sites.length)

    pane.appendChild(svg)
    svgRef.current = svg

    // L.DomUtil.setPosition/setTransform は型定義上 HTMLElement を要求するが、実装は
    // style.transform の書き換えのみで SVGElement でも問題なく動作する。
    const svgEl = svg as unknown as HTMLElement

    const onViewReset = () => {
      const size = map.getSize()
      svg.setAttribute('width', String(size.x))
      svg.setAttribute('height', String(size.y))
      const topLeft = map.containerPointToLayerPoint([0, 0])
      L.DomUtil.setPosition(svgEl, topLeft)
      drawFnRef.current()
    }

    const onMove = () => {
      const topLeft = map.containerPointToLayerPoint([0, 0])
      L.DomUtil.setPosition(svgEl, topLeft)
      drawFnRef.current()
    }

    const onZoomAnim = (e: L.ZoomAnimEvent) => {
      const scale = map.getZoomScale(e.zoom)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const offset = (map as any)._latLngBoundsToNewLayerBounds(map.getBounds(), e.zoom, e.center).min
      L.DomUtil.setTransform(svgEl, offset, scale)
    }

    map.on('viewreset', onViewReset)
    map.on('zoomend', onViewReset)
    map.on('move', onMove)
    map.on('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    onViewReset()

    return () => {
      map.off('viewreset', onViewReset)
      map.off('zoomend', onViewReset)
      map.off('move', onMove)
      map.off('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
      svg.remove()
      svgRef.current = null
      circlesRef.current = []
      groupsRef.current = []
    }
  }, [sites, map])

  // データ変化時: レベルが変わった点だけ所属グループを付け替える（座標もその場で更新する）
  useEffect(() => {
    const circles = circlesRef.current
    const groups = groupsRef.current
    const levels = levelsRef.current
    if (circles.length === 0 || groups.length === 0) return
    const radius = BASE_RADIUS * iconScale

    for (let i = 0; i < circles.length; i++) {
      const idx = indices[i] ?? 0
      const level = idx >= 1 && idx <= MAX_SUB_IDX ? idx : 0
      if (level === levels[i]) continue
      levels[i] = level
      const circle = circles[i]
      if (level === 0) {
        circle.remove()
        continue
      }
      const pt = map.latLngToContainerPoint(L.latLng(sites[i][0], sites[i][1]))
      circle.setAttribute('cx', String(pt.x))
      circle.setAttribute('cy', String(pt.y))
      circle.setAttribute('r', String(radius))
      groups[level - 1].appendChild(circle)
    }
  }, [indices, iconScale, sites, map])

  return null
}
