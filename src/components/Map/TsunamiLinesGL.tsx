import { useEffect, useRef } from 'react'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Feature, FeatureCollection, MultiLineString } from 'geojson'
import { useMapGL } from './mapGLContext'
import type { TsunamiLine } from '../../hooks/useTsunamiLayerData'
import { TSUNAMI_STYLE } from '../../utils/tsunamiStyle'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { twoLinePopupHtml } from './gl/popupHtml'
import { createTsunamiBlink, TSUNAMI_LINE_OPACITY_ON, type TsunamiBlink } from './gl/tsunamiBlink'

// 津波予報区の海岸線を等級ごとに色分けして描画する MapLibre 版（Leaflet の tsunami-lines 相当）。
// 等級1件=MultiLineString feature 1件にまとめ、色・太さを feature プロパティに前計算して
// paint 式で読む（太さは iconScale 連動）。発報中は line-opacity を切り替えて点滅させる
// （切り替えるのは点く・消える瞬間だけ。理由は `gl/tsunamiBlink.ts`）。
// クリック時は bbox tolerance で当たり判定し、区域名＋等級ラベルのポップアップを出す。

const SRC = 'tsunami-lines'
const LYR = 'tsunami-lines'
// 線クリックの当たり判定許容（px）。旧 Leaflet の Canvas ヒットレンダラー tolerance:8 に揃える。
const HIT_TOL_PX = 8

const EMPTY_FC: FeatureCollection<MultiLineString> = { type: 'FeatureCollection', features: [] }

interface Props {
  lines: TsunamiLine[]
  iconScale: number
  visible: boolean
}

function buildFC(lines: TsunamiLine[], iconScale: number): FeatureCollection<MultiLineString> {
  const features: Feature<MultiLineString>[] = lines.map((line) => {
    const style = TSUNAMI_STYLE[line.grade]
    return {
      type: 'Feature',
      properties: { color: style.color, width: style.weight * iconScale, label: style.label, name: line.name },
      geometry: { type: 'MultiLineString', coordinates: line.segments.map(ringToLngLat) },
    }
  })
  return { type: 'FeatureCollection', features }
}

export function TsunamiLinesGL({ lines, iconScale, visible }: Props) {
  const map = useMapGL()
  const popupRef = useRef<PopupHandle | null>(null)
  const blinkRef = useRef<TsunamiBlink | null>(null)
  const addedRef = useRef(false)
  // 点滅を作る effect（依存は map だけ）から、作った時点の visible を読むための ref。
  // 以後の切り替えは下の表示切替の effect が点滅へ伝える。
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  useEffect(() => {
    if (!map) return
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC })
    addOrderedLayer(map, {
      id: LYR,
      type: 'line',
      source: SRC,
      layout: { 'line-join': 'round', 'line-cap': 'round', visibility: visible ? 'visible' : 'none' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['get', 'width'],
        'line-opacity': TSUNAMI_LINE_OPACITY_ON,
        // トランジションを無効化。既定(約300ms)のままだと setPaintProperty のたびに
        // 補間され、オン(0.9)↔オフ(0) の切替が中間の透明度を経てフェードしてしまう。
        // duration:0 で瞬時に切り替え、はっきりした点滅にする。
        'line-opacity-transition': { duration: 0, delay: 0 },
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: LYR,
      priority: 'line',
      tolPx: HIT_TOL_PX,
      buildClickHtml: (f) =>
        twoLinePopupHtml(String(f.properties?.name ?? ''), String(f.properties?.label ?? '津波予報')),
    })
    // 点滅（Leaflet の tsunami-blink CSS を再現）: 2.5s 周期で前 8 割は不透明・残り 2 割は消灯の
    // ハード切替（step-end 相当）。**海岸線が見えていない間は止める** —— 止めないと、津波が
    // 無いときも切り替えのたびに地図を描き直す。
    const blink = createTsunamiBlink((opacity) => {
      if (!map.getLayer(LYR)) return false
      map.setPaintProperty(LYR, 'line-opacity', opacity)
      return true
    })
    blink.setActive(visibleRef.current)
    blinkRef.current = blink
    // 隠れていたタブ（PWA のウィンドウ）が前面へ戻ったら位相を合わせ直す。隠れている間は
    // タイマーが間引かれ、戻った時点で次の切り替わりの予約が数十秒先に残っていることがある。
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') blink.resync()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    addedRef.current = true
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      blink.dispose()
      blinkRef.current = null
      popupRef.current?.remove()
      popupRef.current = null
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      addedRef.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !addedRef.current) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(buildFC(lines, iconScale))
  }, [map, lines, iconScale])

  // 表示切替（津波警報の発表/全解除用）。
  useEffect(() => {
    // **点滅への通知はレイヤーの有無と切り離す。** レイヤーが一時的に引けない間（WebGL の
    // コンテキストロスト中など）に表示が変わっても、点滅の状態だけは追随させておく。
    blinkRef.current?.setActive(visible)
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible])

  return null
}
