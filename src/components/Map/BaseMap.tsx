import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import { loadPrefectures } from '../../utils/prefectures'
import { loadSubRegions } from '../../utils/subregions'
import { REGIONS } from '../../utils/regions'

// ラベルの粒度を切り替えるズーム境界。
//   zoom < REGION_MAX        : 地方ラベル（引きの画）
//   REGION_MAX <= zoom < CITY: 県名ラベル
//   zoom >= CITY             : 一次細分区域名ラベル（寄り）
const REGION_MAX_ZOOM = 7
const CITY_LABEL_MIN_ZOOM = 9

interface Props {
  /** 引きの画で地方ラベルを表示しない（観測点ドットに埋もれるリアルタイム表示用）。 */
  suppressRegionLabels?: boolean
}

// ダークテーマ用の配色
const LAND_FILL = '#161b24'       // 陸地の塗り（海＝コンテナ背景 #0a0c10 より少し明るい）
const PREF_BORDER = '#56607a'     // 都道府県境界（強調）
const SUBREGION_BORDER = '#39414f' // 一次細分区域の境界（細く控えめ）

/**
 * 行政区域ベースマップ（タイル不使用）。ダーク背景の上に、陸地塗り＋一次細分区域の
 * 細線＋県境＋ラベル（地方/県/区域名）を描画する。点数が多いため canvas に命令的描画し、
 * 専用ペイン（タイルとデータ描画の中間 z）へ載せる。
 */
export function BaseMap({ suppressRegionLabels = false }: Props) {
  const map = useMap()
  // 最新の抑制フラグと再適用関数を ref で保持し、形状の再生成を避けつつ反映する。
  const suppressRegionRef = useRef(suppressRegionLabels)
  suppressRegionRef.current = suppressRegionLabels
  const applyRef = useRef<() => void>()

  useEffect(() => {
    // ペイン構成（いずれも overlayPane z=400 より下）:
    //   basemap(250)        : 陸地塗り・区域境界・県境
    //   quake-pref-fill(260): 地震モードの県別震度塗り（JapanMap が使用）
    //   basemap-labels(270) : 地方/県/区域名ラベル（塗りより前面）
    if (!map.getPane('basemap')) {
      const pane = map.createPane('basemap')
      pane.style.zIndex = '250'
      pane.style.pointerEvents = 'none'
    }
    if (!map.getPane('basemap-labels')) {
      const pane = map.createPane('basemap-labels')
      pane.style.zIndex = '270'
      pane.style.pointerEvents = 'none'
    }
    const renderer = L.canvas({ pane: 'basemap', padding: 0.5 })
    const shapes = L.layerGroup().addTo(map)
    const regionLabels = L.layerGroup()
    const prefLabels = L.layerGroup()
    const subregionLabels = L.layerGroup()

    // 地方ラベル（引きの画）。境界データに依存しないため先に用意する。
    for (const region of REGIONS) {
      L.marker([region.lat, region.lng], {
        pane: 'basemap-labels',
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: 'base-region-label', html: `<span>${region.name}</span>`, iconSize: [0, 0] }),
      }).addTo(regionLabels)
    }

    map.attributionControl?.addAttribution(
      '「気象庁 予報区等GISデータ（都道府県・地震情報／細分区域）」',
    )

    let cancelled = false

    Promise.allSettled([loadPrefectures(), loadSubRegions()]).then(([prefRes, subRes]) => {
      if (cancelled) return
      const prefs = prefRes.status === 'fulfilled' ? prefRes.value : null
      const subs = subRes.status === 'fulfilled' ? subRes.value : null

      // 1) 陸地塗り（都道府県ポリゴン・塗りのみ）
      if (prefs) {
        for (const shape of Object.values(prefs)) {
          for (const ring of shape.rings) {
            L.polygon(ring, {
              renderer, pane: 'basemap', interactive: false,
              fill: true, fillColor: LAND_FILL, fillOpacity: 1, stroke: false,
            }).addTo(shapes)
          }
        }
      }

      // 2) 一次細分区域の細い境界線（塗りなし）
      if (subs) {
        for (const sr of subs) {
          for (const ring of sr.rings) {
            L.polygon(ring, {
              renderer, pane: 'basemap', interactive: false,
              fill: false, color: SUBREGION_BORDER, weight: 0.5,
            }).addTo(shapes)
          }
          L.marker(sr.label, {
            pane: 'basemap-labels', interactive: false, keyboard: false,
            icon: L.divIcon({ className: 'base-subregion-label', html: `<span>${sr.name}</span>`, iconSize: [0, 0] }),
          }).addTo(subregionLabels)
        }
      }

      // 3) 県境（強調・塗りなし）を細線より前面に重ねる＋県名ラベル
      if (prefs) {
        for (const [name, shape] of Object.entries(prefs)) {
          for (const ring of shape.rings) {
            L.polygon(ring, {
              renderer, pane: 'basemap', interactive: false,
              fill: false, color: PREF_BORDER, weight: 1,
            }).addTo(shapes)
          }
          L.marker(shape.label, {
            pane: 'basemap-labels', interactive: false, keyboard: false,
            icon: L.divIcon({ className: `base-pref-label base-pref-label--${shape.dir}`, html: `<span>${name}</span>`, iconSize: [0, 0] }),
          }).addTo(prefLabels)
        }
      }

      applyLabelVisibility()
    })

    // ズームに応じて 地方 → 県名 → 区域名 とラベルの粒度を切り替える。
    // リアルタイム表示など抑制時は、地方ラベルの帯ではラベルを出さない。
    function applyLabelVisibility() {
      const zoom = map.getZoom()
      let active: L.LayerGroup | null =
        zoom < REGION_MAX_ZOOM ? regionLabels
        : zoom < CITY_LABEL_MIN_ZOOM ? prefLabels
        : subregionLabels
      if (active === regionLabels && suppressRegionRef.current) active = null
      for (const group of [regionLabels, prefLabels, subregionLabels]) {
        if (group === active) {
          if (!map.hasLayer(group)) group.addTo(map)
        } else if (map.hasLayer(group)) {
          map.removeLayer(group)
        }
      }
    }
    applyRef.current = applyLabelVisibility

    map.on('zoomend', applyLabelVisibility)
    applyLabelVisibility() // 初期表示（地方ラベルは境界データ取得を待たずに出す）

    return () => {
      cancelled = true
      applyRef.current = undefined
      map.off('zoomend', applyLabelVisibility)
      map.removeLayer(shapes)
      map.removeLayer(regionLabels)
      map.removeLayer(prefLabels)
      map.removeLayer(subregionLabels)
    }
  }, [map])

  // モード切替などで抑制フラグが変わったら、形状を作り直さずに表示だけ更新する。
  useEffect(() => {
    applyRef.current?.()
  }, [suppressRegionLabels])

  return null
}
