import { useEffect, useRef } from 'react'
import type { FeatureCollection, Point } from 'geojson'
import { useMapGL } from './mapGLContext'
import { loadPrefectures } from '../../utils/prefectures'
import { loadSubRegions } from '../../utils/subregions'
import { REGIONS } from '../../utils/regions'
import { addOrderedLayer } from './gl/layerOrder'
import { JP_FONT_STACK } from './gl/fontStack'
import { log } from '../../utils/logger'
import { LABEL_TEXT_OPACITY_EXPR, updateLabelOverlap, type LabelOverlapTarget } from './gl/labelOverlap'

// 地名ラベル（地方名／県名／区域名）を MapLibre の symbol レイヤーで描画する（Leaflet 版 BaseMap の
// basemap-labels 相当）。日本語は事前生成した SDF グリフ（public/fonts/Noto Sans JP/・JapanMapGL の
// style.glyphs と localIdeographFontFamily:false 設定を参照）を GPU 描画する。
//
// ズームによる粒度切替は各レイヤーの minzoom/maxzoom で宣言的に行う（Leaflet 版の zoomend ハンドラ相当）:
//   4.5 <= zoom < 6.5 : 地方ラベル（引きの画。日本全体フィットはこの帯に入る）
//   6.5 <= zoom < 8   : 県名ラベル
//   8   <= zoom       : 一次細分区域名ラベル（寄り。自動フィットは MAX_ZOOM=7 でキャップされるため
//                       手動でさらに寄ったときだけ出る）
//
// 値は MapLibre 基準（512px タイル）。Leaflet 版 BaseMap.tsx の 5.5/7.5/9 は 256px タイル基準なので
// 同じ縮尺は 1 段引いた値になる（gl/camera.ts の MAX_ZOOM 参照）。移行時に旧値をそのまま持ち込んで
// いたため、日本全体フィット（MapLibre 基準で約 5.1）が LABEL_MIN_ZOOM=5.5 に届かず地名が
// 一切出ない状態になっていた。

const LABEL_MIN_ZOOM = 4.5
const REGION_MAX_ZOOM = 6.5
const CITY_LABEL_MIN_ZOOM = 8

// symbol レイヤーの text-font。フォントスタック名は gl/fontStack.ts が単一情報源
// （build-glyphs.mjs の出力ディレクトリ名と本値の一致はビルド時に照合される。詳細は fontStack.ts）。
const JP_TEXT_FONT = [JP_FONT_STACK]

// 縁取り: ダーク地図上での視認性を確保するため、太めの halo-width＋halo-blur で背景色のソフトなグローを
// 敷く（旧 Leaflet の三重 text-shadow 相当）。グリフ自体も Bold(700)で焼いている（build-glyphs.mjs）。
const HALO_COLOR = '#0a0c10'

const REGION_SRC = 'basemap-region-labels'
const PREF_SRC = 'basemap-pref-labels'
const SUB_SRC = 'basemap-subregion-labels'

// moveend 後、重なり判定を実行するまでの待ち時間。連続的なパン/ズーム操作の度に評価が
// 挟まらないようデバウンスする。
const OVERLAP_CHECK_DEBOUNCE_MS = 200

interface Props {
  /**
   * 重なり判定の再評価トリガー。震度塗り・観測点・検知点等「マーカー」側の位置情報が変わったときだけ
   * 値が変わる文字列（JapanMapGL 側で構築）。震度・指数の値のみの更新（毎秒のリアルタイム更新等）では
   * 変化しないようにする（位置が変わらない限り重なりの有無自体は変わらないため）。
   */
  overlapSignature: string
}

export function LabelsGL({ overlapSignature }: Props) {
  const map = useMapGL()
  // 各ラベルの生データ（重なり判定の再計算に使う）。ロード完了後に確定する。
  const targetsRef = useRef<LabelOverlapTarget[]>([])
  // 重なり判定のスケジュール関数（下のトリガー用 useEffect が設定する）。県名・区域名の
  // 非同期ロード完了時にもここから呼べるようにするため ref に持たせる。
  const scheduleOverlapCheckRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!map) return
    let cancelled = false

    // 地方ラベルは定数（境界データ非依存）なので即座に用意する。
    const regionFC: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: REGIONS.map((r, i) => ({
        type: 'Feature',
        id: i,
        properties: { name: r.name },
        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      })),
    }
    targetsRef.current = REGIONS.map((r, i) => ({
      source: REGION_SRC,
      id: i,
      lngLat: [r.lng, r.lat],
      text: r.name,
      textSize: 17,
    }))
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
        'text-size': 17,
        'text-letter-spacing': 0.05,
      },
      paint: {
        'text-color': '#eef2f7',
        'text-halo-color': HALO_COLOR,
        'text-halo-width': 1.8,
        'text-halo-blur': 0.6,
        'text-opacity': LABEL_TEXT_OPACITY_EXPR,
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
        const prefEntries = Object.entries(prefs)
        const prefFC: FeatureCollection<Point> = {
          type: 'FeatureCollection',
          features: prefEntries.map(([name, shape], i) => ({
            type: 'Feature',
            id: i,
            properties: { name, dir: shape.dir },
            geometry: { type: 'Point', coordinates: [shape.label[1], shape.label[0]] },
          })),
        }
        targetsRef.current = [
          ...targetsRef.current,
          ...prefEntries.map(([name, shape], i) => ({
            source: PREF_SRC,
            id: i,
            lngLat: [shape.label[1], shape.label[0]] as [number, number],
            text: name,
            textSize: 14,
            offsetEm: 1.5,
            dir: shape.dir,
          })),
        ]
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
            'text-size': 14,
            'text-offset': ['case', ['==', ['get', 'dir'], 'up'], ['literal', [0, -1.5]], ['literal', [0, 1.5]]],
          },
          paint: {
            'text-color': '#e3e9f0',
            'text-halo-color': HALO_COLOR,
            'text-halo-width': 1.7,
            'text-halo-blur': 0.6,
            'text-opacity': LABEL_TEXT_OPACITY_EXPR,
          },
        })
      }

      // 区域名ラベル。区域中心の震度バッジ（QuakeRegionFillGL・同じ label 座標にアイコンを置く）と
      // 重ならないよう、県名ラベルと同じ dir（up/down）で text-offset をかけて退避させる。
      // 震度7バッジの実描画半径は約20px（intensityIcons.ts の INTENSITY_ICON_BASE_RADIUS=32 と
      // getScaleRadius の比率換算）に対し、text-size 13px の 1.5em（県名と同値）だとぎりぎり干渉しうる
      // ため、区域名は 2.2em とやや広めに取る。
      const subs = subRes.status === 'fulfilled' ? subRes.value : null
      if (subs) {
        const subFC: FeatureCollection<Point> = {
          type: 'FeatureCollection',
          features: subs.map((sr, i) => ({
            type: 'Feature',
            id: i,
            properties: { name: sr.name, dir: sr.dir },
            geometry: { type: 'Point', coordinates: [sr.label[1], sr.label[0]] },
          })),
        }
        targetsRef.current = [
          ...targetsRef.current,
          ...subs.map((sr, i) => ({
            source: SUB_SRC,
            id: i,
            lngLat: [sr.label[1], sr.label[0]] as [number, number],
            text: sr.name,
            textSize: 13,
            offsetEm: 2.2,
            dir: sr.dir,
            // 自分の区域の塗り（当然重なる）は無視し、隣接する別区域の塗りとだけ重なりを判定する。
            excludeName: sr.name,
          })),
        ]
        map.addSource(SUB_SRC, { type: 'geojson', data: subFC })
        addOrderedLayer(map, {
          id: SUB_SRC,
          type: 'symbol',
          source: SUB_SRC,
          minzoom: CITY_LABEL_MIN_ZOOM,
          layout: {
            'text-field': ['get', 'name'],
            'text-font': JP_TEXT_FONT,
            'text-size': 13,
            'text-offset': ['case', ['==', ['get', 'dir'], 'up'], ['literal', [0, -2.2]], ['literal', [0, 2.2]]],
          },
          paint: {
            'text-color': '#b3bece',
            'text-halo-color': HALO_COLOR,
            'text-halo-width': 1.4,
            'text-halo-blur': 0.5,
            'text-opacity': LABEL_TEXT_OPACITY_EXPR,
          },
        })
      }
      scheduleOverlapCheckRef.current()
    })

    return () => {
      cancelled = true
      for (const id of [REGION_SRC, PREF_SRC, SUB_SRC]) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }, [map])

  // 重なり判定の再評価。地図の移動完了時（moveend）と、マーカー側の位置情報が変わったとき
  // （overlapSignature の変化）の両方をトリガーにする。デバウンスして連続操作中の負荷を抑える。
  useEffect(() => {
    if (!map) return
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const run = () => {
      if (!map.getSource(REGION_SRC)) return
      updateLabelOverlap(map, targetsRef.current)
    }
    const schedule = () => {
      if (timeoutId != null) clearTimeout(timeoutId)
      timeoutId = setTimeout(run, OVERLAP_CHECK_DEBOUNCE_MS)
    }

    scheduleOverlapCheckRef.current = schedule
    map.on('moveend', schedule)
    schedule()

    return () => {
      if (timeoutId != null) clearTimeout(timeoutId)
      map.off('moveend', schedule)
      scheduleOverlapCheckRef.current = () => {}
    }
  }, [map, overlapSignature])

  return null
}
