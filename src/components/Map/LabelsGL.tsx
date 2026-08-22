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
import { bindDynamicZoomRange, clampMinZoom } from './gl/viewSpan'
import { labelMinZoom } from './gl/zoomLevels'

// 地名ラベル（地方名／県名／区域名）を MapLibre の symbol レイヤーで描画する（Leaflet 版 BaseMap の
// basemap-labels 相当）。日本語は事前生成した SDF グリフ（public/fonts/M PLUS Rounded 1c/・JapanMapGL の
// style.glyphs と localIdeographFontFamily:false 設定を参照）を GPU 描画する。
//
// ズームによる粒度切替は各レイヤーの minzoom/maxzoom で宣言的に行う（Leaflet 版の zoomend ハンドラ相当）:
//   下限〜6.5 : 地方ラベル（引きの画。日本全体フィットはこの帯に入る）
//   6.5 〜 8  : 県名ラベル
//   8 以上    : 一次細分区域名ラベル（寄り。自動フィットの寄り上限より深いため、手動でさらに
//               寄ったときだけ出る）
//
// **下限だけが視野の実距離基準で、粒度の切替はズーム値のまま。** 地方名を出し始める下限は
// 「日本全体が画に収まっているか」で決まるため視野の広さで持つ（ズーム値で固定すると、狭いペインの
// 日本全体表示が閾値に届かず地名が一切出ない。移行直後に実際に起きている）。一方 地方名 → 県名 →
// 区域名 の切替は「文字が何 px 間隔で並ぶか」＝密度の問題で、これは m/px だけで決まりペインの
// 大きさに依らない。視野基準へ移すと逆に狭いペインで 47 県が潰し合う。判断の詳細は gl/viewSpan.ts。
//
// ズーム値は MapLibre 基準（512px タイル）。Leaflet 版 BaseMap.tsx の 7.5/9 は 256px タイル基準なので
// 同じ縮尺は 1 段引いた値になる（gl/viewSpan.ts 参照）。

// 地方名の下限（視野の実距離基準）は gl/zoomLevels.ts が持つ。ここに置くのは粒度の切替だけ。
//
// REGION_MAX_ZOOM を export しているのは、地方名の帯（可変の下限 〜 この固定の上限）が潰れない
// ことを回帰テストで固定するため（gl/zoomConstants.test.ts）。可変の下限と固定の上限が同じ帯に
// 同居しているのはここだけで、崩れ方が無症状（どのズームでもラベルが出ない）なので外から見張る。
export const REGION_MAX_ZOOM = 6.5
const CITY_LABEL_MIN_ZOOM = 8

// 各粒度の基準 text-size（px）。実描画は iconScale（地図アイコンの倍率）を掛けた値。
// 震度バッジ側も同じ iconScale で拡縮するため、両者を同倍率で動かすことで
// 「バッジとラベルの相対的な間隔」（下の text-offset の em 指定）が倍率によらず保たれる。
const REGION_TEXT_SIZE = 17
const PREF_TEXT_SIZE = 14
const SUB_TEXT_SIZE = 13

// symbol レイヤーの text-font。フォントスタック名は gl/fontStack.ts が単一情報源
// （build-glyphs.mjs の出力ディレクトリ名と本値の一致はビルド時に照合される。詳細は fontStack.ts）。
const JP_TEXT_FONT = [JP_FONT_STACK]

// 縁取り: ダーク地図上での視認性を確保するため、太めの halo-width＋halo-blur で背景色のソフトなグローを
// 敷く（旧 Leaflet の三重 text-shadow 相当）。グリフ自体も ExtraBold(800)で焼いている（build-glyphs.mjs）。
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
  /** 地図アイコンの倍率（設定値）。震度バッジ等と揃えてラベルも拡縮する。 */
  iconScale: number
}

export function LabelsGL({ overlapSignature, iconScale }: Props) {
  const map = useMapGL()
  // レイヤー構築は [map] 依存の useEffect 内で行い、県名・区域名は非同期ロード後に追加される。
  // その追加が倍率変更より後になることがあるため、構築時は ref 経由で最新の倍率を読む
  // （クロージャが握った初期値のままだと、後から出るラベルだけ旧倍率になる）。
  const iconScaleRef = useRef(iconScale)
  iconScaleRef.current = iconScale
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
      textSize: REGION_TEXT_SIZE,
    }))
    map.addSource(REGION_SRC, { type: 'geojson', data: regionFC })
    addOrderedLayer(map, {
      id: REGION_SRC,
      type: 'symbol',
      source: REGION_SRC,
      minzoom: clampMinZoom(labelMinZoom(map), REGION_MAX_ZOOM),
      maxzoom: REGION_MAX_ZOOM,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': JP_TEXT_FONT,
        'text-size': REGION_TEXT_SIZE * iconScaleRef.current,
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

    // 地方名の下限は視野の実距離で決まるため、ペインの寸法が変わるたび張り替える（上の初期値と
    // 同じ関数）。県名・区域名の帯はズーム値固定なので張り替え不要。
    const unbindZoomRange = bindDynamicZoomRange(map, [
      { layerId: REGION_SRC, minZoom: labelMinZoom, maxZoom: REGION_MAX_ZOOM },
    ])

    // 県名・区域名は境界データ（label 座標・dir）に依存するため取得後に追加する。
    Promise.allSettled([loadPrefectures(), loadSubRegions()]).then(([prefRes, subRes]) => {
      if (cancelled || !map.getSource(REGION_SRC)) return
      // 失敗ログには「どのズーム帯のラベルが欠けるか」を書く。ラベルはズーム帯ごとに粒度を
      // 切り替える（上の対応表）ため、これが無いと「取得に失敗して出ない」のか「そのズーム帯では
      // 元々出さない設計」なのかを、地図を見ても console を見ても区別できない。
      if (prefRes.status === 'rejected')
        log.warn(
          `[LabelsGL] prefectures 取得失敗（zoom ${REGION_MAX_ZOOM}〜${CITY_LABEL_MIN_ZOOM} の県名ラベルが出ない。他ズーム帯の地方名・区域名ラベルは影響なし）`,
          prefRes.reason,
        )
      if (subRes.status === 'rejected')
        log.warn(
          `[LabelsGL] subregions 取得失敗（zoom ${CITY_LABEL_MIN_ZOOM} 以上の区域名ラベルが出ない。それ未満の地方名・県名ラベルは影響なし）`,
          subRes.reason,
        )

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
            textSize: PREF_TEXT_SIZE,
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
            'text-size': PREF_TEXT_SIZE * iconScaleRef.current,
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
      // この「約20px 対 2.2em」の関係は倍率 100% での値だが、退避量は em 指定（text-size 比）であり
      // text-size とバッジ半径の双方に同じ iconScale が掛かるため、倍率を変えても比率は崩れない。
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
            textSize: SUB_TEXT_SIZE,
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
            'text-size': SUB_TEXT_SIZE * iconScaleRef.current,
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
      unbindZoomRange()
      for (const id of [REGION_SRC, PREF_SRC, SUB_SRC]) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }, [map])

  // 倍率変更を既存レイヤーへ反映する（レイヤーの作り直しは伴わない）。ラベルの実サイズが変われば
  // 重なり判定に使う矩形も変わるため、反映後に再評価をかける。
  //
  // この effect は上下の effect と宣言順で噛み合っている: 構築（[map]）→ 本 effect → 重なり判定（下）。
  // マウント時点では scheduleOverlapCheckRef がまだ未設定（no-op）のため、ここからの再評価要求は
  // 空振りする。初回の判定は下の effect が自前で schedule() を呼ぶことで成立している。
  // 3 つの順序を入れ替えるときは、この噛み合わせが崩れていないか確認すること。
  useEffect(() => {
    if (!map) return
    const sizes: [string, number][] = [
      [REGION_SRC, REGION_TEXT_SIZE],
      [PREF_SRC, PREF_TEXT_SIZE],
      [SUB_SRC, SUB_TEXT_SIZE],
    ]
    for (const [id, base] of sizes) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'text-size', base * iconScale)
    }
    scheduleOverlapCheckRef.current()
  }, [map, iconScale])

  // 重なり判定の再評価。地図の移動完了時（moveend）と、マーカー側の位置情報が変わったとき
  // （overlapSignature の変化）の両方をトリガーにする。デバウンスして連続操作中の負荷を抑える。
  useEffect(() => {
    if (!map) return
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const run = () => {
      if (!map.getSource(REGION_SRC)) return
      updateLabelOverlap(map, targetsRef.current, iconScaleRef.current)
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
