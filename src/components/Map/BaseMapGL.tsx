import { useEffect } from 'react'
import { useMapGL } from './mapGLContext'
import { loadPrefectures } from '../../utils/prefectures'
import { loadSubRegions } from '../../utils/subregions'
import { ringsToPolygonFC, ringsToLineFC } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { log } from '../../utils/logger'

// 行政区域ベースマップ（MapLibre 版・Leaflet の BaseMap 相当）。ダーク背景の上に
// 海底地形ラスタ（暗色化）＋陸地塗り＋一次細分区域の細線＋県境を描画する。
// ラベル（地方/県/区域名）はグリフパイプラインを要するため F2 で別途実装する。
// MapLibre 移行計画 docs/webgl-migration-implementation-plan.md F1。

// 海底地形タイル（GEBCO・JapanMap.tsx と同一 URL）。
const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'

// 配色（Leaflet 版 BaseMap.tsx と一致させる）。
const LAND_FILL = '#161b24'        // 陸地の塗り
const PREF_BORDER = '#56607a'      // 都道府県境界（強調）
const SUBREGION_BORDER = '#39414f' // 一次細分区域の境界（細く控えめ）
// TileTintLayer の暗色化（黒 multiply・opacity 0.58）は raster-brightness-max 0.42 で等価に再現する
// （backdrop*(1-0.58)=0.42。TileTintLayer.tsx のコメント参照）。
const BATHYMETRY_BRIGHTNESS_MAX = 0.42

const SRC_LAND = 'basemap-land'
const SRC_SUB = 'basemap-sub-borders'
const SRC_PREF = 'basemap-pref-borders'
const SRC_GEBCO = 'gebco'
const LYR_GEBCO = 'gebco-raster'
const LYR_LAND = 'land-fill'
const LYR_SUB = 'sub-borders'
const LYR_PREF = 'pref-borders'

interface Props {
  showBathymetry: boolean
}

export function BaseMapGL({ showBathymetry }: Props) {
  const map = useMapGL()

  useEffect(() => {
    if (!map) return
    let cancelled = false

    // 海底地形ラスタ（陸地塗りの下）。showBathymetry の初期値で可視を決める。
    map.addSource(SRC_GEBCO, { type: 'raster', tiles: [BATHYMETRY_URL], tileSize: 256, maxzoom: 10 })
    addOrderedLayer(map, {
      id: LYR_GEBCO,
      type: 'raster',
      source: SRC_GEBCO,
      layout: { visibility: showBathymetry ? 'visible' : 'none' },
      paint: { 'raster-brightness-max': BATHYMETRY_BRIGHTNESS_MAX },
    })

    // 陸地塗り・境界線は生成データ（遅延読込）の到着後に追加する。
    Promise.allSettled([loadPrefectures(), loadSubRegions()]).then(([prefRes, subRes]) => {
      if (cancelled) return
      const prefs = prefRes.status === 'fulfilled' ? prefRes.value : null
      const subs = subRes.status === 'fulfilled' ? subRes.value : null
      if (prefRes.status === 'rejected') log.warn('[data] prefectures 取得失敗（陸地塗りなしで継続）', prefRes.reason)
      if (subRes.status === 'rejected') log.warn('[data] subregions 取得失敗（境界線なしで継続）', subRes.reason)

      // MAP_LAYER_ORDER に従い最下層スロット（land-fill < sub-borders < pref-borders）へ挿入する。
      // 遅延読込で faults/plates 等のオーバーレイより後に追加されても、常にその背面へ入る。
      // 1) 陸地塗り（都道府県ポリゴン・塗りのみ）
      if (prefs) {
        const rings = Object.values(prefs).map((s) => s.rings)
        map.addSource(SRC_LAND, { type: 'geojson', data: ringsToPolygonFC(rings) })
        addOrderedLayer(map, { id: LYR_LAND, type: 'fill', source: SRC_LAND, paint: { 'fill-color': LAND_FILL } })
      }
      // 2) 一次細分区域の細い境界線（陸地塗りより前面）
      if (subs) {
        const rings = subs.map((sr) => sr.rings)
        map.addSource(SRC_SUB, { type: 'geojson', data: ringsToLineFC(rings) })
        addOrderedLayer(map, {
          id: LYR_SUB,
          type: 'line',
          source: SRC_SUB,
          paint: { 'line-color': SUBREGION_BORDER, 'line-width': 0.5 },
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
          paint: { 'line-color': PREF_BORDER, 'line-width': 1 },
        })
      }
    })

    return () => {
      cancelled = true
      for (const id of [LYR_PREF, LYR_SUB, LYR_LAND, LYR_GEBCO]) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_PREF, SRC_SUB, SRC_LAND, SRC_GEBCO]) {
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }, [map])

  // 海底地形の表示切替（形状は作り直さず可視だけ更新）。
  useEffect(() => {
    if (!map || !map.getLayer(LYR_GEBCO)) return
    map.setLayoutProperty(LYR_GEBCO, 'visibility', showBathymetry ? 'visible' : 'none')
  }, [map, showBathymetry])

  return null
}
