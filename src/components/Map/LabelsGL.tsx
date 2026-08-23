import { useEffect, useRef } from 'react'
import type { FeatureCollection, Point } from 'geojson'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import { loadPrefectures } from '../../utils/prefectures'
import { loadSubRegions } from '../../utils/subregions'
import { REGIONS } from '../../utils/regions'
import { addOrderedLayer } from './gl/layerOrder'
import { JP_FONT_STACK } from './gl/fontStack'
import { log } from '../../utils/logger'
import {
  LABEL_TEXT_OPACITY_EXPR,
  computeLabelPlacements,
  isUsableRoom,
  labelTextOffsetExpr,
  type LabelOverlapTarget,
  type LabelPlacement,
} from './gl/labelOverlap'
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

// 震度バッジ等と重なったときに退避する量（em＝text-size に対する比）。**平常時は退避しない**——
// 重なりを検知したときだけ、この量だけ上下へ逃がす（gl/labelOverlap.ts の判定）。
// 区域名が県名より広いのは、震度7バッジの実描画半径が約20px（gl/intensityIcons.ts の
// INTENSITY_ICON_BASE_RADIUS=32 と getScaleRadius の比率換算）で、text-size 13px の 1.5em では
// ぎりぎり干渉しうるため。倍率 100% での関係だが、退避量は em 指定でバッジ半径にも同じ iconScale が
// 掛かるので、倍率を変えても比率は崩れない。
// 逃がせるのは領域（県・区域）の内側に収まる範囲まで。上限は生成データの `room` が決める。
// なお長周期の区域バッジ（LpgmRegionFillGL）は最大 22px とわずかに大きく、2.2em 逃がしても縁が
// 重なる。ただし自区域のバッジは退避**後**の判定から外しているため薄くはならない
// （gl/labelOverlap.ts の `excludeName`）。この 2 つは対で効いている。
const PREF_SHIFT_EM = 1.5
const SUB_SHIFT_EM = 2.2

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

/** 退避なし・表示のまま（レイヤー構築時の初期値）。 */
const DEFAULT_PLACEMENT: LabelPlacement = { shift: 'none', dimmed: false }

/**
 * ラベルの GeoJSON を組み立てる。判定結果（退避方向・薄くするか）は properties に載せる
 * （text-offset は layout プロパティで feature-state を受け付けないため。gl/labelOverlap.ts 冒頭）。
 */
function labelFeatureCollection(
  items: { t: LabelOverlapTarget; p: LabelPlacement }[],
): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: items.map(({ t, p }) => ({
      type: 'Feature',
      id: t.id,
      properties: { name: t.text, shift: p.shift, dimmed: p.dimmed },
      geometry: { type: 'Point', coordinates: t.lngLat },
    })),
  }
}

/** 判定前（レイヤー構築時）の GeoJSON。 */
function initialFeatureCollection(targets: LabelOverlapTarget[]): FeatureCollection<Point> {
  return labelFeatureCollection(targets.map((t) => ({ t, p: DEFAULT_PLACEMENT })))
}

/**
 * 退避の余地（`room`）を持たないラベルがあれば、**ソース単位で 1 回だけ**警告する。
 *
 * `room` が無いラベルは退避を試さず、重なった時点で薄くなる。これは安全側の挙動なので画面上は
 * 「やや読みにくいラベルがある」程度にしか見えず、生成データが古い（`dir` しか持たない旧スキーマ・
 * 配信キャッシュの取り残し）のか、本当に重なっているだけなのかを区別できない。その手がかりを残す。
 *
 * ラベルごとに出すと 239 行のログになるため件数だけを 1 行にまとめる。
 */
function warnIfRoomMissing(targets: LabelOverlapTarget[], file: string, kind: string): void {
  const broken = targets.filter((t) => !isUsableRoom(t.room)).length
  if (broken === 0) return
  log.warn(
    `[LabelsGL] ${file} の room が ${broken}/${targets.length} 件で使えない形。` +
      `該当する${kind}ラベルは震度バッジ等と重なっても退避せず、そのまま薄くなる（生成データが古い可能性）`,
  )
}

/**
 * 判定結果を各ソースへ書き戻す。**ソース単位で前回と比べ、変化が無ければ setData しない**——
 * setData は symbol の再配置を伴い、配置フェードを切ってある（map-rendering-spec §8）本アプリでは
 * 瞬間的な描き直しとして出るため、無駄な呼び出しを避ける。
 */
function applyPlacements(
  map: MapLibreMap,
  targets: LabelOverlapTarget[],
  placements: LabelPlacement[],
  lastSig: Record<string, string>,
): void {
  const bySource = new Map<string, { t: LabelOverlapTarget; p: LabelPlacement }[]>()
  targets.forEach((t, i) => {
    const items = bySource.get(t.source)
    if (items) items.push({ t, p: placements[i] })
    else bySource.set(t.source, [{ t, p: placements[i] }])
  })
  for (const [id, items] of bySource) {
    const source = map.getSource(id) as GeoJSONSource | undefined
    if (!source) continue
    const sig = items.map(({ p }) => (p.dimmed ? 'x' : p.shift)).join(',')
    if (lastSig[id] === sig) continue
    lastSig[id] = sig
    source.setData(labelFeatureCollection(items))
  }
}

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
  // 前回 setData した配置結果のソース別署名（applyPlacements の空振り判定に使う）。
  const lastSigRef = useRef<Record<string, string>>({})
  // 重なり判定のスケジュール関数（下のトリガー用 useEffect が設定する）。県名・区域名の
  // 非同期ロード完了時にもここから呼べるようにするため ref に持たせる。
  const scheduleOverlapCheckRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!map) return
    let cancelled = false

    // 地方ラベルは定数（境界データ非依存）なので即座に用意する。退避はさせない（境界データを持たない
    // ため、逃がした先が地方の内側かを判断できない。重なったときは薄くするだけにとどめる）。
    targetsRef.current = REGIONS.map((r, i) => ({
      source: REGION_SRC,
      id: i,
      lngLat: [r.lng, r.lat],
      text: r.name,
      textSize: REGION_TEXT_SIZE,
    }))
    map.addSource(REGION_SRC, { type: 'geojson', data: initialFeatureCollection(targetsRef.current) })
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

    // 県名・区域名は境界データ（label 座標・退避の余地 room）に依存するため取得後に追加する。
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

      // 県名ラベル。県中心の最大震度バッジと重なったときだけ、県内に収まる範囲で上下へ退避する。
      const prefs = prefRes.status === 'fulfilled' ? prefRes.value : null
      if (prefs) {
        const prefTargets: LabelOverlapTarget[] = Object.entries(prefs).map(([name, shape], i) => ({
          source: PREF_SRC,
          id: i,
          lngLat: [shape.label[1], shape.label[0]],
          text: name,
          textSize: PREF_TEXT_SIZE,
          shiftEm: PREF_SHIFT_EM,
          room: shape.room,
        }))
        warnIfRoomMissing(prefTargets, 'prefectures.json', '県名')
        targetsRef.current = [...targetsRef.current, ...prefTargets]
        map.addSource(PREF_SRC, { type: 'geojson', data: initialFeatureCollection(prefTargets) })
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
            'text-offset': labelTextOffsetExpr(PREF_SHIFT_EM),
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
      // 重なったときだけ、区域内に収まる範囲で上下へ退避する（退避量は SUB_SHIFT_EM）。
      const subs = subRes.status === 'fulfilled' ? subRes.value : null
      if (subs) {
        const subTargets: LabelOverlapTarget[] = subs.map((sr, i) => ({
          source: SUB_SRC,
          id: i,
          lngLat: [sr.label[1], sr.label[0]],
          text: sr.name,
          textSize: SUB_TEXT_SIZE,
          shiftEm: SUB_SHIFT_EM,
          room: sr.room,
          // 自分の区域の塗り（当然重なる）は無視し、隣接する別区域の塗りとだけ重なりを判定する。
          excludeName: sr.name,
        }))
        warnIfRoomMissing(subTargets, 'subregions.json', '区域名')
        targetsRef.current = [...targetsRef.current, ...subTargets]
        map.addSource(SUB_SRC, { type: 'geojson', data: initialFeatureCollection(subTargets) })
        addOrderedLayer(map, {
          id: SUB_SRC,
          type: 'symbol',
          source: SUB_SRC,
          minzoom: CITY_LABEL_MIN_ZOOM,
          layout: {
            'text-field': ['get', 'name'],
            'text-font': JP_TEXT_FONT,
            'text-size': SUB_TEXT_SIZE * iconScaleRef.current,
            'text-offset': labelTextOffsetExpr(SUB_SHIFT_EM),
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
      // ソースごと捨てるので、次に構築したときは必ず書き直させる（残すと初回の setData が空振りする）。
      targetsRef.current = []
      lastSigRef.current = {}
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
      const targets = targetsRef.current
      applyPlacements(map, targets, computeLabelPlacements(map, targets, iconScaleRef.current), lastSigRef.current)
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
