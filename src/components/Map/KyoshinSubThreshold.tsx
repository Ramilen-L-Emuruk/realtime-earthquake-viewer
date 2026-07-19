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
  // 最後のフル描画時のビュー（＝「描画空間」）。cx/cy はこのビューでの containerPoint で
  // 書かれており、その後のパンは mapPane の translate、ズーム変化中は svg 全体への
  // transform（下の applyViewTransform）が描画空間→現在ビューの変換を担う。
  // フル描画を経ない差分更新（indices の useEffect）もこの空間で座標を書く必要がある。
  const drawStateRef = useRef<{ zoom: number; bounds: L.LatLngBounds; origin: L.Point } | null>(null)

  // フル描画関数を最新 props で常に更新（stale closure 回避）。
  // svg をビューポートへ再ピン留めし（飛行中に掛けた transform も setPosition の
  // style.transform 丸ごと上書きでリセットされる）、描画空間を記録した上で、
  // 全点の cx/cy/r を再計算する（表示・非表示を問わず全点分。所属グループの切替時に
  // 古い座標のまま出現しないようにするため）。
  // 更新後に即時実行もする。データ変化時の差分更新（下の useEffect）は「レベルが変わった点」
  // しか半径を触らないため、iconScale だけ変わってレベル据え置きの点は、ここで全点まとめて
  // 半径を再適用しないとアイコンスケール変更に追従できず、ドットの大きさが不揃いになる
  // （circles 未生成時は早期 return するのでマウント時は no-op）。
  useEffect(() => {
    drawFnRef.current = () => {
      const svg = svgRef.current
      const circles = circlesRef.current
      if (!svg || circles.length === 0) return
      const size = map.getSize()
      svg.setAttribute('width', String(size.x))
      svg.setAttribute('height', String(size.y))
      L.DomUtil.setPosition(svg as unknown as HTMLElement, map.containerPointToLayerPoint([0, 0]))
      const zoom = map.getZoom()
      const bounds = map.getBounds()
      drawStateRef.current = { zoom, bounds, origin: map.project(bounds.getNorthWest(), zoom) }
      const radius = BASE_RADIUS * iconScale
      for (let i = 0; i < sites.length; i++) {
        const pt = map.latLngToContainerPoint(L.latLng(sites[i][0], sites[i][1]))
        const c = circles[i]
        c.setAttribute('cx', String(pt.x))
        c.setAttribute('cy', String(pt.y))
        c.setAttribute('r', String(radius))
      }
    }
    drawFnRef.current()
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
    // SVG レンダラーの <svg> と同じクラスを付け、leaflet.css の
    // svg.leaflet-zoom-animated { will-change: transform }（常時の合成レイヤー昇格）と、
    // 標準ズームアニメ中の transition を他レイヤーと共有する。
    svg.classList.add('leaflet-zoom-animated')

    const redraw = () => drawFnRef.current()

    // 描画空間（最後のフル描画時のビュー）から (zoom, center) のビューへの変換を
    // svg 全体の transform 1回で表現する。flyTo・ピンチのようにズームが毎フレーム
    // 変わる間、全点の cx/cy/r を書き直す（約1,700点×3属性/フレーム）代わりにこれを掛け、
    // 着地時（moveend）のフル描画で正確な座標に戻す。
    const applyViewTransform = (zoom: number, center: L.LatLng) => {
      const state = drawStateRef.current
      if (!state) return
      const scale = map.getZoomScale(zoom, state.zoom)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const offset = (map as any)._latLngBoundsToNewLayerBounds(state.bounds, zoom, center).min
      L.DomUtil.setTransform(svgEl, offset, scale)
    }

    // zoomstart〜zoomend（flyTo・ピンチ等ズーム変化を伴う操作）の間だけ 'move' ごとに
    // transform 追従する。ズームを伴わない純粋なパンでは何もしない: 要素は mapPane の
    // translate に乗って地図と一緒に動き、全点を日本全域ぶん描いてある（overflow: visible）
    // ため、画面外から入ってくる点もそのまま現れる。
    let zooming = false
    const onZoomStart = () => { zooming = true }
    const onZoomEnd = () => { zooming = false }
    const onMove = () => {
      if (zooming) applyViewTransform(map.getZoom(), map.getCenter())
    }
    // 標準ズームアニメ（CSS transition）は目標ズーム・中心が zoomanim で一度だけ通知される
    const onZoomAnim = (e: L.ZoomAnimEvent) => applyViewTransform(e.zoom, e.center)

    map.on('viewreset', redraw)
    map.on('moveend', redraw)
    map.on('zoomstart', onZoomStart)
    map.on('zoomend', onZoomEnd)
    map.on('move', onMove)
    map.on('zoomanim', onZoomAnim as L.LeafletEventHandlerFn)
    redraw()

    return () => {
      map.off('viewreset', redraw)
      map.off('moveend', redraw)
      map.off('zoomstart', onZoomStart)
      map.off('zoomend', onZoomEnd)
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
    const state = drawStateRef.current
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
      // フル描画を経ない差分更新のため、座標は現在ビューではなく「描画空間」
      // （最後のフル描画時のビュー）で書く。フル描画後にパンやズーム変化があった場合、
      // 描画空間→現在ビューの変換は svg 側の位置/transform が担っており、現在ビューの
      // containerPoint で書くと二重に変換されてズレるため。
      const latlng = L.latLng(sites[i][0], sites[i][1])
      const pt = state
        ? map.project(latlng, state.zoom).subtract(state.origin)
        : map.latLngToContainerPoint(latlng)
      circle.setAttribute('cx', String(pt.x))
      circle.setAttribute('cy', String(pt.y))
      circle.setAttribute('r', String(radius))
      groups[level - 1].appendChild(circle)
    }
  }, [indices, iconScale, sites, map])

  return null
}
