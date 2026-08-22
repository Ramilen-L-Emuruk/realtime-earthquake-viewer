import type * as maplibregl from 'maplibre-gl'

// 「視野の実距離」を物差しにしたズーム閾値の換算。
//
// MapLibre のズーム値が表すのは 1px あたりの実距離（m/px）だけで、**見える地理的範囲は
// m/px × 地図ペインの寸法**で決まる。そのためズーム値のリテラルで閾値を置くと、端末ごとに
// まったく別の基準になってしまう（緯度 38・ズーム 7 は 1px ≒ 482m。スマホの短辺 375px なら
// 視野 181km だが、2K で短辺 1200px なら 578km）。
//
// そこで「視野の短辺が何 km か」で閾値を定め、実行時にその端末での等価ズームへ換算する。
// 短辺を使うのは、自動フィットの着地ズームが短辺で決まるため（画面の向きに依存しない）。
//
// **すべての閾値をこの物差しへ移すわけではない。** 対象は「対象物がどれだけ画に収まるか」で
// 決まる閾値だけ。ラベルの粒度切替（県名 → 区域名）のように **px あたりの密度**で決まるものは
// ズーム値のまま置く（密度は m/px だけで決まりペインの大きさに依らないため、視野基準へ移すと
// 逆に狭いペインで文字が潰し合う）。判断の対象と結論は docs/spec/map-rendering-spec.md §4。

/** Web Mercator の赤道全周（m）。MapLibre の投影と同じ WGS84 球面近似。 */
const EARTH_CIRCUMFERENCE_M = 40075016.686
/**
 * MapLibre のズーム基準タイルサイズ（px）。
 *
 * Leaflet は 256px タイル基準でズームを数えるため、同じ数値でも縮尺が 2 倍ずれる
 * （MapLibre の z は Leaflet の z+1 相当）。**Leaflet 版から値を持ち込むときは 1 段引くこと。**
 * 移行時にこれを見落として自動フィットが意図の 2 倍寄っていた事故がある。
 */
const TILE_SIZE_PX = 512

/**
 * 換算に使う基準緯度（日本の中心付近）。
 *
 * Mercator の m/px は緯度で変わるが、現在の中心緯度を使うと同じ画のまま北へパンしただけで
 * 閾値が動く（沖縄と北海道で cos が 1.2 倍違う）。閾値の意味を「その端末で固定」させるため、
 * 中心緯度ではなくこの定数で換算する。
 */
export const REFERENCE_LAT = 38

/**
 * 定数値の由来となる基準ペイン短辺（px）。デスクトップの実測値。
 *
 * 下記の km 定数は「基準ペインでは従来のズーム値と同じ結果になる」ように決めてある。
 * この値自体が閾値として使われることはない（実際の判定は常に実ペイン寸法で換算する）。
 * 例外は先読み範囲とテストで、そこだけは端末に依らない代表値が必要なため参照する。
 */
export const REFERENCE_SHORT_SIDE_PX = 800

/** ズーム z・基準緯度での 1px あたりの実距離（m）。 */
export function metersPerPixel(zoom: number, lat: number = REFERENCE_LAT): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE_PX * 2 ** zoom)
}

/** 短辺 shortSidePx の地図ペインで、視野の短辺が spanKm になるズーム。 */
export function zoomForSpanKm(spanKm: number, shortSidePx: number): number {
  return Math.log2(metersPerPixel(0) / ((spanKm * 1000) / shortSidePx))
}

/** 短辺 shortSidePx の地図ペインを、ズーム zoom で見たときの視野の短辺（km）。 */
export function spanKmForZoom(zoom: number, shortSidePx: number): number {
  return (metersPerPixel(zoom) * shortSidePx) / 1000
}

/**
 * 地図ペインの短辺（CSS px）。
 *
 * レイアウト前・非表示で実寸が取れない間は基準値を返す。0 をそのまま使うと換算が -Infinity になり、
 * 「どのズームでも閾値を下回る」＝細線とラベルが全部消える側へ倒れるため。
 *
 * 記録は残さない。実寸 0 が一時的（レイアウト前）なのか恒久的（CSS の破綻等）なのかはここでは
 * 判別できず、起動直後の一時的な 0 で毎回警告を出すことになる。
 *
 * **恒久的に 0 になった場合、この関数を見張っていれば気づけたはずの症状は残る。** 複数点のフィット
 * なら `camera.ts` の `flyToBoundsSnapped` が着地ズームを算出できずペインの実寸を添えて警告するが、
 * 日本全体フィット（`fitJapan`）と 1 点への飛行（`flyToPoint`）はその判定を通らないので何も出ない。
 * それでも記録を置かないのは、ペインが恒久的に 0 なら地図自体が見えておらず、閾値のずれより先に
 * 画面で気づけるため。
 */
export function paneShortSidePx(map: maplibregl.Map): number {
  const container = map.getContainer()
  const side = Math.min(container.clientWidth, container.clientHeight)
  return side > 0 ? side : REFERENCE_SHORT_SIDE_PX
}

/**
 * どれだけ寄っても保つ絶対上限ズーム。
 *
 * 視野基準の寄り上限（`fitMaxZoom`）は画面が大きいほど深くなるため、上限を設けないと
 * 大画面・ウルトラワイドで際限なく寄る。境界データは間引きを撤廃済み（約 11m 精度）なので
 * 幾何は保つが、海底地形タイルは実在する最大 z を超えると拡大表示になりぼやける。
 * 短辺 1600px（4K の上下分割相当）でも視野基準の値がこの手前に収まる水準に置いてある。
 */
export const ABSOLUTE_MAX_ZOOM = 8

/** 視野基準の下限ズームをレイヤーへ張り替えるための指定（`bindDynamicZoomRange`）。 */
export interface DynamicZoomRange {
  layerId: string
  /** その端末での下限ズーム。ペイン寸法から都度算出する。 */
  minZoom: (map: maplibregl.Map) => number
  /**
   * 上限ズーム（固定値）。密度で決まる閾値はこちらに置く。
   * 省略時は `MAX_LAYER_ZOOM`（24）。地図の実効最大ズームより十分深いため実質無制限として扱える。
   */
  maxZoom?: number
}

/** MapLibre のレイヤーが取り得る最大ズーム（上限を指定しないときの既定値）。 */
const MAX_LAYER_ZOOM = 24

/** 帯（下限〜上限）として最低限残す幅（ズーム段）。1 段＝縮尺 2 倍。 */
const MIN_ZOOM_BAND = 1

/**
 * 視野基準の下限ズームを、帯が潰れない位置まで引き下げる。
 *
 * 視野基準の下限はペインが大きいほど深くなる。上限を固定値で持つ帯（地方名ラベルの
 * 「下限〜6.5」）では、ペインが十分大きいと**下限が上限を追い越す**——ラベル下限は短辺 3228px で
 * 6.5 に達する（4K を 50% 表示にした程度で届く）。MapLibre は `minzoom > maxzoom` を検証せず
 * そのまま代入し、可視判定は下限と上限を独立に見るため、**どのズームでも描かれないレイヤーが
 * 黙って出来上がる**（例外もログも出ない）。帯が潰れる前にここで止める。
 *
 * レイヤー生成時の `minzoom` にもこれを通すこと（張り替え側だけに置くと初回だけ潰れる）。
 */
export function clampMinZoom(minZoom: number, maxZoom: number = MAX_LAYER_ZOOM): number {
  return Math.min(minZoom, maxZoom - MIN_ZOOM_BAND)
}

/**
 * 視野基準の下限ズームをレイヤーへ適用し、地図ペインの寸法が変わるたび張り替える。
 * 戻り値を呼ぶと購読を解除する。
 *
 * MapLibre のレイヤーは `minzoom`/`maxzoom` をズーム値でしか受け取れないため、視野基準の閾値は
 * 実行時に等価ズームへ換算して張り替えるしかない。**契機は window の resize ではなく地図の
 * `resize`**。このアプリはパネル境界のつまみ（`PanelResizeHandle`）でもペインが変わり、window の
 * resize は発火しない（MapLibre はコンテナを ResizeObserver で監視するため地図側には届く）。
 *
 * レイヤーは生成データの到着後に追加されるため、購読の時点では存在しないことがある。その間は
 * 黙って飛ばす。`setLayerZoomRange` は未知のレイヤーで例外を投げるのではなく `error` イベントを
 * 発火し、それを `JapanMapGL` の `map.on('error')` が `log.error` に流すため、ガードが無いと
 * 正常な経路で毎回エラーログが出る。**レイヤー生成時の `minzoom` にも同じ関数の値を
 * `clampMinZoom` 経由で渡すこと**——初回の値はそこで決まり、以降のリサイズをここが引き継ぐ。
 */
export function bindDynamicZoomRange(map: maplibregl.Map, entries: DynamicZoomRange[]): () => void {
  const apply = () => {
    for (const entry of entries) {
      if (!map.getLayer(entry.layerId)) continue
      const maxZoom = entry.maxZoom ?? MAX_LAYER_ZOOM
      map.setLayerZoomRange(entry.layerId, clampMinZoom(entry.minZoom(map), maxZoom), maxZoom)
    }
  }
  apply()
  map.on('resize', apply)
  return () => {
    map.off('resize', apply)
  }
}
