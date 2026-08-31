import { useEffect, useRef } from 'react'
import type { MapGeoJSONFeature } from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import { addOrderedLayer } from './gl/layerOrder'
import { createDepthPointLayer, type DepthPointLayer } from './gl/depthPointLayer'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { formatMagnitude } from '../../utils/formatters'
import { log } from '../../utils/logger'
import { reportRenderFailure, clearRenderFailure } from '../../utils/renderHealth'
import type { CatalogPointCloud } from '../../utils/hypocenterCatalogView'

// 長期震源カタログの点群。**深さを持つ点**として地下へ描く（gl/depthPointLayer.ts）。
//
// 点は数十万〜100 万件になるため、`setPoints`（オブジェクトの配列）ではなく列指向の
// `setPointsColumnar` へ渡す。絞り込みや色の組み立ては utils/hypocenterCatalogView.ts の担当で、
// ここは「渡して描く」だけに徹する。
//
// **クリック判定はカラーピッキング**（同レイヤー）。MapLibre はカスタムレイヤーが何を描いたかを
// 知らず `queryRenderedFeatures` にヒットしないため、`popupRegistry` へ自前の判定を渡す。

const LYR = 'hypocenter-catalog'
/** 不調を知らせるときに画面へ出す名前（`utils/renderHealth.ts`）。 */
const LABEL = '震源カタログ'

interface Props {
  cloud: CatalogPointCloud
  /** 深さ方向の誇張率。1 が実スケール。地震情報の震源と同じ設定を共有する。 */
  exaggeration: number
  /** 表示するか。false なら点を空にする（レイヤー自体は残す）。 */
  visible: boolean
}

/** 発生時刻を日本時間で読める形へ。カタログの時刻は UTC epoch ミリ秒で入っている。 */
function formatCatalogTime(ms: number): string {
  // 実行環境のタイムゾーンに依らず日本時間で出す（`getFullYear` 等は端末の設定で答えが変わる）。
  const d = new Date(ms + 9 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  )
}

/**
 * 深さの表示（km）。
 *
 * **`formatDepth` を使わない。** あちらは気象庁電文の深さ（10km 刻みの整数）向けで丸めを行わず、
 * カタログの小数の深さをそのまま渡すと単精度の誤差が露出する（実測: 55.38 が
 * `55.380001068115234` になる）。カタログの格納単位は 0.01km だが、表示は 0.1km で足りる。
 */
function formatCatalogDepth(depthKm: number): string {
  return `${depthKm.toFixed(1)}km`
}

function buildPopupHtml(cloud: CatalogPointCloud, i: number): string {
  const lat = cloud.columns.lat[i]
  const lng = cloud.columns.lng[i]
  const coord = `北緯 ${lat.toFixed(3)}° 東経 ${lng.toFixed(3)}°`
  return (
    `<div class="text-sm" style="min-width:170px">` +
    `<div class="font-bold" style="margin-bottom:4px">${formatCatalogTime(cloud.timeMs[i])}</div>` +
    `<div class="text-xs" style="color:#94a3b8">` +
    `${formatMagnitude(cloud.magnitude[i])} / 深さ ${formatCatalogDepth(cloud.columns.depthKm[i])}</div>` +
    `<div class="text-xs" style="color:#64748b;margin-top:4px">${coord}</div>` +
    `</div>`
  )
}

export function HypocenterCatalogGL({ cloud, exaggeration, visible }: Props) {
  const map = useMapGL()
  const layerRef = useRef<DepthPointLayer | null>(null)
  // ポップアップの中身は毎回いまの点群から作る（レイヤー登録は map の寿命で 1 回だけなので、
  // クロージャに古い点群を閉じ込めない）。**判定が返す添字は、渡した列と同じ並びを指す。**
  const cloudRef = useRef(cloud)
  cloudRef.current = cloud
  // 判定で引き当てた添字。`buildClickHtml` は引数を取らないため、pick から受け渡す。
  const hitRef = useRef<number | null>(null)

  useEffect(() => {
    if (!map) return
    const layer = createDepthPointLayer(LYR, map, LABEL)
    layerRef.current = layer

    const add = () => {
      try {
        if (!map.getLayer(LYR)) addOrderedLayer(map, layer)
        // 載せられたら不調の記録を消す（前回の失敗を引きずらない）。
        clearRenderFailure(LYR, 'draw')
      } catch (err) {
        log.error('[HypocenterCatalogGL] custom layer add failed', err)
        // **ここも画面へ出す。** 載せられなければ `render()` が一度も呼ばれず、
        // 描画側の検出（シェーダーの可否）には永久に到達しない。
        reportRenderFailure(LYR, LABEL, 'draw')
      }
    }
    add()

    // MAP-1: WebGL context lost/restored 時に MapLibre は custom layer を復元しない。
    const onRestored = () => {
      log.warn('[HypocenterCatalogGL] WebGL context restored, re-adding custom layer')
      if (map.isStyleLoaded()) add()
      else map.once('style.load', add)
    }
    map.on('webglcontextrestored', onRestored)

    let popup: PopupHandle | null = null
    try {
      popup = registerPopupSource(map, {
        layerId: LYR,
        label: LABEL,
        priority: 'point',
        tolPx: 0,
        pick: (point, forClick) => {
          const hit = layerRef.current?.pick(point.x, point.y, forClick)
          if (hit === 'pending') return 'pending'
          if (hit == null) return null
          // **添字が範囲外なら何も返さない。** 点を差し替えた直後の 1 フレームは、判定の結果が
          // 前の点群のものでありうる（件数が減っていれば範囲外になる）。
          const c = cloudRef.current
          if (hit >= c.columns.count) return null
          hitRef.current = hit
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [c.columns.lng[hit], c.columns.lat[hit]] },
            properties: {},
          } as unknown as MapGeoJSONFeature
        },
        buildClickHtml: () => {
          const i = hitRef.current
          const c = cloudRef.current
          if (i == null || i >= c.columns.count) return ''
          return buildPopupHtml(c, i)
        },
      })
    } catch (err) {
      log.error('[HypocenterCatalogGL] popup source registration failed', err)
      // **画面にも出す。** 描画は出るのにクリックしても何も返らない状態は、
      // 見た目からは仕様と区別がつかない。
      reportRenderFailure(LYR, LABEL, 'interact')
    }

    return () => {
      popup?.remove()
      // 画面から外れたら不調の記録も消す（残すと、もう出てこないものの名前が居座る）。
      clearRenderFailure(LYR, 'interact')
      map.off('webglcontextrestored', onRestored)
      map.off('style.load', add)
      layerRef.current = null
      if (map.getLayer(LYR)) map.removeLayer(LYR)
    }
  }, [map])

  useEffect(() => {
    // **`map` を依存に含めること。** レイヤーを作るのは別の effect（`[map]`）で、地図の生成は
    // 非同期（`load` を待つ）。先にこの効果が走ると点が入らないまま残る。
    layerRef.current?.setPointsColumnar(cloud.columns)
  }, [map, cloud])

  useEffect(() => {
    // **隠すときも点は持たせたまま。** 空を渡して隠すと、タブへ戻るたびに詰め直しと
    // GPU への転送が走る（型定義の `setVisible` 参照）。
    layerRef.current?.setVisible(visible)
  }, [map, visible])

  useEffect(() => {
    layerRef.current?.setExaggeration(exaggeration)
  }, [map, exaggeration])

  return null
}
