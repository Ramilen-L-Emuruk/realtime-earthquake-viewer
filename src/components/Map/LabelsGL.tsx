import { useEffect } from 'react'
import type { FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import { loadPrefectures } from '../../utils/prefectures'
import { loadSubRegions } from '../../utils/subregions'
import { REGIONS } from '../../utils/regions'
import { addOrderedLayer } from './gl/layerOrder'
import { log } from '../../utils/logger'

// 地名ラベル（地方名／県名／区域名）を MapLibre の symbol レイヤーで描画する（Leaflet 版 BaseMap の
// basemap-labels 相当）。日本語は事前生成した SDF グリフ（public/fonts/Noto Sans JP/・JapanMapGL の
// style.glyphs と localIdeographFontFamily:false 設定を参照）を GPU 描画する。
//
// ズームによる粒度切替は各レイヤーの minzoom/maxzoom で宣言的に行う（Leaflet 版の zoomend ハンドラ
// 相当・境界値は BaseMap.tsx と一致）:
//   5.5 <= zoom < 7.5 : 地方ラベル（引きの画）
//   7.5 <= zoom < 9   : 県名ラベル
//   9   <= zoom       : 一次細分区域名ラベル（寄り）
// リアルタイム（強震モニタ）表示では観測点ドットに埋もれるため地方ラベルを抑制する
// （suppressRegionLabels・Leaflet 版と同じく地方帯のみ対象。県／区域は影響しない）。

const LABEL_MIN_ZOOM = 5.5
const REGION_MAX_ZOOM = 7.5
const CITY_LABEL_MIN_ZOOM = 9

// 事前生成グリフのフォントスタック名（scripts/build-glyphs.mjs の GLYPH_STACK・出力ディレクトリ名
// public/fonts/Noto Sans JP/ と完全一致させる。MapLibre は text-font 値を glyphs URL の {fontstack} に使う）。
const JP_TEXT_FONT = ['Noto Sans JP']

// 縁取り: 本番(index.css)は text-shadow を重ねたソフトなグローで縁取る。MapLibre の text-halo-width は
// ハードエッジのため、幅を絞り halo-blur でぼかして近づける（PoC で調整済みの値）。
const HALO_COLOR = '#0a0c10'

const REGION_SRC = 'basemap-region-labels'
const PREF_SRC = 'basemap-pref-labels'
const SUB_SRC = 'basemap-subregion-labels'

interface Props {
  /** 引きの画で地方ラベルを表示しない（リアルタイム表示用・Leaflet 版と同じ）。 */
  suppressRegionLabels: boolean
}

export function LabelsGL({ suppressRegionLabels }: Props) {
  const map = useMapGL()

  useEffect(() => {
    if (!map) return
    let cancelled = false

    // 地方ラベルは定数（境界データ非依存）なので即座に用意する。
    const regionFC: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: REGIONS.map((r) => ({
        type: 'Feature',
        properties: { name: r.name },
        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      })),
    }
    map.addSource(REGION_SRC, { type: 'geojson', data: regionFC })
    addOrderedLayer(map, {
      id: REGION_SRC,
      type: 'symbol',
      source: REGION_SRC,
      minzoom: LABEL_MIN_ZOOM,
      maxzoom: REGION_MAX_ZOOM,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': JP_TEXT_FONT,
        'text-size': 15,
        'text-letter-spacing': 0.05,
        visibility: suppressRegionLabels ? 'none' : 'visible',
      },
      paint: {
        'text-color': '#dbe3ee',
        'text-halo-color': HALO_COLOR,
        'text-halo-width': 0.8,
        'text-halo-blur': 0.5,
      },
    })

    // 県名・区域名は境界データ（label 座標・dir）に依存するため取得後に追加する。
    Promise.allSettled([loadPrefectures(), loadSubRegions()]).then(([prefRes, subRes]) => {
      if (cancelled || !map.getSource(REGION_SRC)) return
      if (prefRes.status === 'rejected') log.warn('[LabelsGL] prefectures 取得失敗（県名ラベルなしで継続）', prefRes.reason)
      if (subRes.status === 'rejected') log.warn('[LabelsGL] subregions 取得失敗（区域名ラベルなしで継続）', subRes.reason)

      // 県名ラベル。県中心の最大震度バッジと重ならないよう dir（up/down）で 1.5em ずらす
      // （Leaflet 版 base-pref-label--up/down の transform 相当。text-offset の単位は em）。
      const prefs = prefRes.status === 'fulfilled' ? prefRes.value : null
      if (prefs) {
        const prefFC: FeatureCollection<Point> = {
          type: 'FeatureCollection',
          features: Object.entries(prefs).map(([name, shape]) => ({
            type: 'Feature',
            properties: { name, dir: shape.dir },
            geometry: { type: 'Point', coordinates: [shape.label[1], shape.label[0]] },
          })),
        }
        map.addSource(PREF_SRC, { type: 'geojson', data: prefFC })
        addOrderedLayer(map, {
          id: PREF_SRC,
          type: 'symbol',
          source: PREF_SRC,
          minzoom: REGION_MAX_ZOOM,
          maxzoom: CITY_LABEL_MIN_ZOOM,
          layout: {
            'text-field': ['get', 'name'],
            'text-font': JP_TEXT_FONT,
            'text-size': 12,
            'text-offset': ['case', ['==', ['get', 'dir'], 'up'], ['literal', [0, -1.5]], ['literal', [0, 1.5]]],
          },
          paint: {
            'text-color': '#cbd5e1',
            'text-halo-color': HALO_COLOR,
            'text-halo-width': 0.7,
            'text-halo-blur': 0.5,
          },
        })
      }

      // 区域名ラベル。
      const subs = subRes.status === 'fulfilled' ? subRes.value : null
      if (subs) {
        const subFC: FeatureCollection<Point> = {
          type: 'FeatureCollection',
          features: subs.map((sr) => ({
            type: 'Feature',
            properties: { name: sr.name },
            geometry: { type: 'Point', coordinates: [sr.label[1], sr.label[0]] },
          })),
        }
        map.addSource(SUB_SRC, { type: 'geojson', data: subFC })
        addOrderedLayer(map, {
          id: SUB_SRC,
          type: 'symbol',
          source: SUB_SRC,
          minzoom: CITY_LABEL_MIN_ZOOM,
          layout: {
            'text-field': ['get', 'name'],
            'text-font': JP_TEXT_FONT,
            'text-size': 11,
          },
          paint: {
            'text-color': '#93a3b8',
            'text-halo-color': HALO_COLOR,
            'text-halo-width': 0.6,
            'text-halo-blur': 0.4,
          },
        })
      }
    })

    return () => {
      cancelled = true
      for (const id of [REGION_SRC, PREF_SRC, SUB_SRC]) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
    }
    // suppressRegionLabels は生成時の初期値のみ使用（変化は下の visibility 更新で反映）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  // リアルタイム表示の切替で地方ラベルの表示/非表示だけ更新する（形状は作り直さない）。
  useEffect(() => {
    if (!map || !map.getLayer(REGION_SRC)) return
    map.setLayoutProperty(REGION_SRC, 'visibility', suppressRegionLabels ? 'none' : 'visible')
  }, [map, suppressRegionLabels])

  return null
}
