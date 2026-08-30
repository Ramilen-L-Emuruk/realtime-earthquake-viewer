import { useEffect, useRef } from 'react'
import type { MapGeoJSONFeature } from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import { addOrderedLayer } from './gl/layerOrder'
import { createDepthPointLayer, type DepthPointLayer } from './gl/depthPointLayer'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { getIntensityColor, getIntensityLabel } from '../../utils/intensity'
import { readableTextColor } from '../../utils/contrast'
import { formatMagnitude, formatDepth } from '../../utils/formatters'
import { log } from '../../utils/logger'
import type { JMAQuake } from '../../types/earthquake'
import type { LatLng } from '../../utils/stationCoords'

// 地震モードの震源（× 印）を、**深さを持つ点**として地下へ描く。
//
// 地図の傾きが常態になったので、震源を「震央＝地表の真上」ではなく実際の深さへ置ける
// （docs/spec/map-rendering-spec.md §6）。DOM マーカー（maplibregl.Marker）は地表にしか
// 置けないため、描画を custom layer へ移した（gl/depthPointLayer.ts）。長期震源カタログの
// 点群も同じレイヤーの仕組みに乗る。
//
// **クリック判定はカラーピッキング**（同レイヤー）。MapLibre はカスタムレイヤーが何を描いたかを
// 知らず `queryRenderedFeatures` にヒットしないため、`popupRegistry` へ自前の判定を渡している。

const LYR = 'hypocenter-depth'

// 旧 EpicenterGL の SVG（× 印）と同じ色・大きさ。
const CROSS_COLOR: readonly [number, number, number] = [255 / 255, 34 / 255, 34 / 255]
const CROSS_SIZE_PX = 32
// 震央（地表の真上）の印。震源より控えめにして、主役が震源であることを保つ。
const EPICENTER_COLOR: readonly [number, number, number] = [0.62, 0.16, 0.16]
const EPICENTER_SIZE_PX = 12

interface Props {
  quake: JMAQuake
  /** 震源の位置（[緯度, 経度]）。 */
  epicenter: LatLng
  prefIntensities: [string, number][]
  iconScale: number
  /** 深さ方向の誇張率。1 が実スケール。 */
  exaggeration: number
}

function buildPopupHtml(quake: JMAQuake, prefIntensities: [string, number][]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const hc = quake.earthquake.hypocenter
  const rows = prefIntensities
    .slice(0, 6)
    .map(([pref, scale]) => {
      const color = getIntensityColor(scale)
      const label = getIntensityLabel(scale)
      return (
        `<div style="display:flex;align-items:center;gap:8px;font-size:12px">` +
        `<span style="display:inline-block;width:20px;text-align:center;font-weight:700;border-radius:3px;` +
        `color:${readableTextColor(color)};font-size:10px;background:${color}">${esc(label)}</span>` +
        `<span style="color:#cbd5e1">${esc(pref)}</span></div>`
      )
    })
    .join('')
  return (
    `<div class="text-sm" style="min-width:160px">` +
    `<div class="font-bold" style="margin-bottom:4px">${esc(hc.name)}</div>` +
    `<div class="text-xs" style="color:#94a3b8">${esc(formatMagnitude(hc.magnitude))} / 深さ ${esc(formatDepth(hc.depth))}</div>` +
    (rows ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:2px">${rows}</div>` : '') +
    `</div>`
  )
}

export function HypocenterDepthGL({ quake, epicenter, prefIntensities, iconScale, exaggeration }: Props) {
  const map = useMapGL()
  const layerRef = useRef<DepthPointLayer | null>(null)
  // ポップアップの中身は毎回いまの値から作る（レイヤー登録は map の寿命で 1 回だけのため、
  // クロージャに古い quake を閉じ込めないよう ref を経由する）。
  const contentRef = useRef({ quake, prefIntensities, epicenter })
  contentRef.current = { quake, prefIntensities, epicenter }

  useEffect(() => {
    if (!map) return
    const layer = createDepthPointLayer(LYR, map)
    layerRef.current = layer

    const add = () => {
      try {
        if (!map.getLayer(LYR)) addOrderedLayer(map, layer)
      } catch (err) {
        log.error('[HypocenterDepthGL] custom layer add failed', err)
      }
    }
    add()

    // MAP-1: WebGL context lost/restored 時に MapLibre は custom layer を復元しない。
    // PsWaveGL と同じ手当て（style.load を待ってから再追加し、例外はここで隔離する）。
    const onRestored = () => {
      log.warn('[HypocenterDepthGL] WebGL context restored, re-adding custom layer')
      if (map.isStyleLoaded()) add()
      else map.once('style.load', add)
    }
    map.on('webglcontextrestored', onRestored)

    // カスタムレイヤーは queryRenderedFeatures にヒットしないので、判定を自前で渡す。
    let popup: PopupHandle | null = null
    try {
      popup = registerPopupSource(map, {
        layerId: LYR,
        priority: 'point',
        // pick を渡すとき tolPx は使われない（許容範囲はレイヤー側の HIT_PAD_PX）。
        tolPx: 0,
        pick: (point, forClick) => {
          const hit = layerRef.current?.pick(point.x, point.y, forClick)
          if (hit === 'pending') return 'pending'
          if (hit == null) return null
          const [lat, lng] = contentRef.current.epicenter
          // 吹き出しの位置は地表（震央）に置く。Popup は LngLat しか受け付けないため、
          // 地下の × 印とは深さのぶんだけ離れて出る。
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: {},
          } as unknown as MapGeoJSONFeature
        },
        buildClickHtml: () => buildPopupHtml(contentRef.current.quake, contentRef.current.prefIntensities),
      })
    } catch (err) {
      log.error('[HypocenterDepthGL] popup source registration failed', err)
    }

    return () => {
      popup?.remove()
      map.off('webglcontextrestored', onRestored)
      map.off('style.load', add)
      layerRef.current = null
      if (map.getLayer(LYR)) map.removeLayer(LYR)
    }
  }, [map])

  useEffect(() => {
    const depthKm = quake.earthquake.hypocenter.depth ?? 0
    layerRef.current?.setPoints([
      // 震央（地表）。深さがあることを示す控えめな印で、震源と線で結ぶ。
      // 深さ 0（ごく浅い・不明）のときは震源と重なるので、見た目は 1 つの × 印になる。
      {
        lng: epicenter[1],
        lat: epicenter[0],
        depthKm: 0,
        shape: 'circle',
        // 柄が潰れる状況（真上・浅い震源・誇張率が低い）では自動で消える。
        auxiliary: true,
        color: EPICENTER_COLOR,
        sizePx: EPICENTER_SIZE_PX * iconScale,
      },
      // 震源（地下）。
      {
        lng: epicenter[1],
        lat: epicenter[0],
        depthKm,
        shape: 'cross',
        color: CROSS_COLOR,
        sizePx: CROSS_SIZE_PX * iconScale,
        stem: true,
      },
    ])
    // **`map` を依存に含めること。** レイヤーを作るのは別の effect（`[map]`）で、地図の生成は
    // 非同期（`load` を待つ）。先にこの効果が走ると `layerRef.current` が null のまま素通りし、
    // 後からレイヤーができても点が入らない。
  }, [map, epicenter, quake, iconScale])

  useEffect(() => {
    layerRef.current?.setExaggeration(exaggeration)
    // 同上。誇張率もレイヤーができる前に決まっていることがある。
  }, [map, exaggeration])

  return null
}
