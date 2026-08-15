import { useEffect, useRef } from 'react'
import type { Map as MapLibreMap, RasterLayerSpecification } from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import { loadPrefectures } from '../../utils/prefectures'
import { loadSubRegions } from '../../utils/subregions'
import { ringsToPolygonFC, ringsToLineFC } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { DETAIL_MIN_ZOOM } from './gl/zoomLevels'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { twoLinePopupHtml } from './gl/popupHtml'
import { log } from '../../utils/logger'
import {
  BATHYMETRY_URL,
  GEBCO_HIRES_MIN_ZOOM,
  GEBCO_OVERVIEW_MAX_ZOOM,
  GEBCO_SOURCE_MAX_ZOOM,
  GEBCO_TILE_SIZE,
  prefetchBathymetryTiles,
} from '../../utils/gebcoPrefetch'

// 行政区域ベースマップ（MapLibre 版・Leaflet の BaseMap 相当）。ダーク背景の上に
// 海底地形ラスタ（暗色化）＋陸地塗り＋一次細分区域の細線＋県境を描画する。
// ラベル（地方/県/区域名）はグリフパイプラインを要するため F2 で別途実装する。
// MapLibre 移行計画 docs/webgl-migration-implementation-plan.md F1。

// 配色（Leaflet 版 BaseMap.tsx と一致させる）。
const LAND_FILL = '#161b24'        // 陸地の塗り
const PREF_BORDER = '#56607a'      // 都道府県境界（強調）
const SUBREGION_BORDER = '#39414f' // 一次細分区域の境界（細く控えめ）
// TileTintLayer の暗色化（黒 multiply・opacity 0.58）は raster-brightness-max 0.42 で等価に再現する
// （backdrop*(1-0.58)=0.42。TileTintLayer.tsx のコメント参照）。
const BATHYMETRY_BRIGHTNESS_MAX = 0.42

const SRC_LAND = 'basemap-land'
const SRC_SUB = 'basemap-sub-borders'
const SRC_SUB_HIT = 'basemap-subregion-hit'
const LYR_SUB_HIT = 'subregion-hit'
const SRC_PREF = 'basemap-pref-borders'
const SRC_GEBCO = 'gebco'
const LYR_GEBCO = 'gebco-raster'
const SRC_GEBCO_OVERVIEW = 'gebco-overview'
const LYR_GEBCO_OVERVIEW = 'gebco-overview-raster'
const LYR_LAND = 'land-fill'
const LYR_SUB = 'sub-borders'
const LYR_PREF = 'pref-borders'

interface BathymetryLayerOptions {
  sourceId: string
  layerId: string
  /** ソース側の最大タイル z（タイル座標系）。マップズームがこれを超えると MapLibre はこの z のタイルを拡大して描き続ける。 */
  sourceMaxZoom: number
  visible: boolean
  /** 描画を始めるマップズーム（マップズーム基準）。省略時は全ズームで描画する。 */
  minZoom?: number
  /** 省略時は MapLibre 既定（300ms のクロスフェード）。 */
  fadeMs?: number
}

// 海底地形ラスタ層を 1 枚追加する（オーバービュー層と高解像度層は maxzoom・minzoom・フェードだけが違う）。
function addBathymetryLayer(map: MapLibreMap, opts: BathymetryLayerOptions): void {
  map.addSource(opts.sourceId, {
    type: 'raster',
    tiles: [BATHYMETRY_URL],
    tileSize: GEBCO_TILE_SIZE,
    maxzoom: opts.sourceMaxZoom,
  })
  const paint: NonNullable<RasterLayerSpecification['paint']> = {
    'raster-brightness-max': BATHYMETRY_BRIGHTNESS_MAX,
  }
  if (opts.fadeMs !== undefined) paint['raster-fade-duration'] = opts.fadeMs
  addOrderedLayer(map, {
    id: opts.layerId,
    type: 'raster',
    source: opts.sourceId,
    ...(opts.minZoom !== undefined ? { minzoom: opts.minZoom } : {}),
    layout: { visibility: opts.visible ? 'visible' : 'none' },
    paint,
  })
}

interface Props {
  showBathymetry: boolean
}

export function BaseMapGL({ showBathymetry }: Props) {
  const map = useMapGL()
  const popupRef = useRef<PopupHandle | null>(null)

  useEffect(() => {
    if (!map) return
    let cancelled = false
    const prefetchAbort = new AbortController()

    // 海底地形ラスタ（陸地塗りの下）は 2 層構成にする。showBathymetry の初期値で可視を決める。
    // GEBCO_SOURCE_MAX_ZOOM / GEBCO_OVERVIEW_MAX_ZOOM はタイル座標側の z（Leaflet 版の
    // maxNativeZoom={10} 相当）で、マップズーム基準の閾値（gl/camera.ts の MAX_ZOOM や下記の
    // GEBCO_HIRES_MIN_ZOOM）とは別の座標系。両者を混同しないこと。いずれも先読み
    // （gebcoPrefetch.ts）と関係する値のため同ファイルが持つ。
    //
    // 2 層にする理由: MapLibre は現在の視野に必要なタイルしか保持しないため、沖縄→北海道のような
    // 遠距離フィットの直後は飛行先のタイルが未取得で、1 層だと素の背景色（style の bg）が数百 ms
    // 露出する（HTTP キャッシュは先読みで温めてあるが、デコード＋テクスチャ化＋フェードの分は残る）。
    // 下層は maxzoom を低く固定し、MapLibre が maxzoom 超のズームでそのタイルを拡大して描き続ける
    // 性質を使って「どのズーム・どの位置でも粗い海底地形が必ず下地にある」状態を作る。上層の高解像度が
    // 届いたらその上に載って差し替わる。下層はフェード 0（常在の下地なので、クロスフェードの対象は
    // 上層だけでよい）。上層には minzoom を付け、2 層が同一タイルを要求するだけになる低ズーム帯を
    // 描画対象から外す（GEBCO_HIRES_MIN_ZOOM のコメント参照）。
    addBathymetryLayer(map, {
      sourceId: SRC_GEBCO_OVERVIEW,
      layerId: LYR_GEBCO_OVERVIEW,
      sourceMaxZoom: GEBCO_OVERVIEW_MAX_ZOOM,
      visible: showBathymetry,
      fadeMs: 0,
    })
    addBathymetryLayer(map, {
      sourceId: SRC_GEBCO,
      layerId: LYR_GEBCO,
      sourceMaxZoom: GEBCO_SOURCE_MAX_ZOOM,
      visible: showBathymetry,
      minZoom: GEBCO_HIRES_MIN_ZOOM,
    })
    // 沖縄〜択捉相当の範囲を、アイドル時に低ズーム優先でバックグラウンド先読み。
    // 初期表示（fitJapan）の通信と競合しないよう遅延なく開始してよい
    // （requestIdleCallback 経由でメインスレッドの空きを待つため即座には走らない）。
    prefetchBathymetryTiles(prefetchAbort.signal)

    // 陸地塗り・境界線は生成データ（遅延読込）の到着後に追加する。
    Promise.allSettled([loadPrefectures(), loadSubRegions()]).then(([prefRes, subRes]) => {
      if (cancelled) return
      const prefs = prefRes.status === 'fulfilled' ? prefRes.value : null
      const subs = subRes.status === 'fulfilled' ? subRes.value : null
      // 何が欠けるかを具体的に書く（陸地が真っ黒＝海底地形ラスタだけ、という見た目から
      // 原因を辿れるようにする）。ベースマップの塗り・境界線は全ズームで出す想定のため、
      // ラベル（LabelsGL）と違いズーム帯による出し分けは無い。
      if (prefRes.status === 'rejected')
        log.warn('[data] prefectures 取得失敗（陸地塗りと県境が全ズームで出ない。海底地形ラスタのみになる）', prefRes.reason)
      if (subRes.status === 'rejected')
        log.warn('[data] subregions 取得失敗（区域境界線と区域名ポップアップの当たり判定が全ズームで出ない）', subRes.reason)

      // MAP_LAYER_ORDER に従い最下層スロット（land-fill < sub-borders < pref-borders）へ挿入する。
      // 遅延読込で faults/plates 等のオーバーレイより後に追加されても、常にその背面へ入る。
      // 1) 陸地塗り（都道府県ポリゴン・塗りのみ）
      if (prefs) {
        const rings = Object.values(prefs).map((s) => s.rings)
        map.addSource(SRC_LAND, { type: 'geojson', data: ringsToPolygonFC(rings) })
        addOrderedLayer(map, { id: LYR_LAND, type: 'fill', source: SRC_LAND, paint: { 'fill-color': LAND_FILL } })
      }
      // 2) 一次細分区域の細い境界線（陸地塗りより前面）
      // 区域線・県境は引いた画で網目が潰れるため minzoom を設ける（gl/zoomLevels.ts）。
      // 陸地塗りには設けない（列島のシルエットは低ズームでも位置の手掛かりになるため）。
      if (subs) {
        const rings = subs.map((sr) => sr.rings)
        map.addSource(SRC_SUB, { type: 'geojson', data: ringsToLineFC(rings) })
        addOrderedLayer(map, {
          id: LYR_SUB,
          type: 'line',
          source: SRC_SUB,
          minzoom: DETAIL_MIN_ZOOM,
          paint: { 'line-color': SUBREGION_BORDER, 'line-width': 0.5 },
        })
        // 区域名ポップアップの当たり判定。塗りは完全透明で見た目に出さず、区域名だけを載せる。
        // 地図のどこを押しても「そこがどの一次細分区域か」は分かる、という最後の受け皿にする
        // （優先度 basemap ＝ 観測点・線・区域塗り・ヒートマップのどれにも当たらなかったときだけ出る）。
        map.addSource(SRC_SUB_HIT, {
          type: 'geojson',
          data: ringsToPolygonFC(rings, (i) => ({ name: subs[i].name })),
        })
        // 区域線が消える倍率では当たり判定も消す（線が見えないのに区域名だけ出るのを避ける）。
        addOrderedLayer(map, {
          id: LYR_SUB_HIT,
          type: 'fill',
          source: SRC_SUB_HIT,
          minzoom: DETAIL_MIN_ZOOM,
          paint: { 'fill-color': '#000000', 'fill-opacity': 0 },
        })
        popupRef.current = registerPopupSource(map, {
          layerId: LYR_SUB_HIT,
          priority: 'basemap',
          tolPx: 1,
          // 全面を覆うレイヤーなので、カーソルは変えない（どこでも指マークになってしまう）。
          hoverCursor: false,
          buildClickHtml: (f) => twoLinePopupHtml(String(f.properties?.name ?? ''), '一次細分区域'),
        })
      }
      // 3) 県境（強調・細線より前面）
      if (prefs) {
        const rings = Object.values(prefs).map((s) => s.rings)
        map.addSource(SRC_PREF, { type: 'geojson', data: ringsToLineFC(rings) })
        addOrderedLayer(map, {
          id: LYR_PREF,
          type: 'line',
          source: SRC_PREF,
          minzoom: DETAIL_MIN_ZOOM,
          paint: { 'line-color': PREF_BORDER, 'line-width': 1 },
        })
      }
    })

    return () => {
      cancelled = true
      prefetchAbort.abort()
      popupRef.current?.remove()
      popupRef.current = null
      for (const id of [LYR_PREF, LYR_SUB, LYR_SUB_HIT, LYR_LAND, LYR_GEBCO, LYR_GEBCO_OVERVIEW]) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_PREF, SRC_SUB, SRC_SUB_HIT, SRC_LAND, SRC_GEBCO, SRC_GEBCO_OVERVIEW]) {
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }, [map])

  // 海底地形の表示切替（形状は作り直さず可視だけ更新）。オーバービュー層も同じ設定で連動させる。
  useEffect(() => {
    if (!map) return
    for (const id of [LYR_GEBCO_OVERVIEW, LYR_GEBCO]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', showBathymetry ? 'visible' : 'none')
    }
  }, [map, showBathymetry])

  return null
}
