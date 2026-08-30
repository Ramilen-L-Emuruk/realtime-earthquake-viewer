import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson'
import type { ExpressionSpecification } from 'maplibre-gl'
import type { Prefectures } from '../../../utils/prefectures'
import type { SubRegion } from '../../../utils/subregions'
import { ringsToLineFC, ringsToPolygonFC } from './geojson'

// ベースマップの静的な形（陸地塗り・県境・区域境界線・区域の当たり判定）を、**1 つの geojson
// ソース**へまとめるための feature 組み立て。レイヤーは `kind` プロパティの filter で描き分ける。
//
// なぜ 1 ソースにまとめるか。MapLibre は fill / line レイヤーを描く前に「タイルのクリッピング
// マスク」をステンシルバッファへ描く（`Painter.renderTileClippingMasks`）。この処理は
// **直前のレイヤーと同じソースなら省略される**が、ソースが変わるたびに描き直す。しかも境界あり／
// なしの 2 パスで、タイル 1 枚ごとに 1 ドローコール。ベースマップの 4 枚（陸地塗り・当たり判定・
// 区域線・県境）はレイヤー順で連続しているのに、ソースが別々だったため 4 回ぶん描いていた。
//
// 加えて、タイル被覆の再計算（`coveringTiles`）もソース単位で走る。4 ソースはタイルサイズも
// ズーム範囲も同一なので結果は毎回同じなのに、四分木の走査を 4 回繰り返していた。
//
// 実測（CPU を 4 倍遅くした状態・傾き 45 度・自動移動中の 1 フレーム平均）: 共有ソース 2 本へ
// まとめてソースを 24 個から 20 個へ減らし、マスク描画 15.2ms → 5.4ms、ドローコール 397 本 → 209 本、
// 1 フレーム 73.4ms → 53.0ms。数字の出どころは docs/spec/map-rendering-spec.md §17（改訂履歴）。
//
// **レイヤー ID と描画順は変えない。** 描き分けは filter で行うため、見た目は統合前と同一になる。

/**
 * ベースマップ 1 ソース内で feature を描き分けるための種別。
 *
 * - `land`: 都道府県ポリゴン（陸地の塗り）
 * - `pref-line`: 都道府県の境界線
 * - `sub-line`: 一次細分区域の境界線
 * - `sub-hit`: 一次細分区域ポリゴン（区域名ポップアップの当たり判定・見た目には出さない）
 */
export type BasemapKind = 'land' | 'pref-line' | 'sub-line' | 'sub-hit'

/**
 * 共有ソースへ載せる feature の属性。
 *
 * **`kind` に必ずこの型を通すこと。** GeoJSON の属性は `{ [name: string]: any }` なので、
 * 素で書くと `'land'` を `'lands'` と打ち間違えても型検査を素通りする。埋め込む側と filter 側は
 * 別ファイルの文字列リテラルどうしなので、食い違えば**そのレイヤーは無言で 0 件になる**。
 */
interface BasemapFeatureProps {
  kind: BasemapKind
  /** 区域名。当たり判定の feature だけが持つ（ポップアップの本文に使う）。 */
  name?: string
}

/** `kind` が一致する feature だけを描くレイヤー filter。 */
export function basemapKindFilter(kind: BasemapKind): ExpressionSpecification {
  return ['==', ['get', 'kind'], kind]
}

/**
 * ベースマップ共有ソースの中身を組み立てる。
 *
 * `prefs` / `subs` は生成データの遅延読込で、**片方だけ取得できることがある**（もう片方は
 * ネットワーク失敗）。取れた分だけを入れ、欠けた種別の feature は 0 件になる。呼び出し側は
 * 同じ条件でレイヤーの追加可否を決めること（feature が 0 件のレイヤーを足しても描画は空になる
 * だけだが、当たり判定の登録まで走ってしまう）。**両方欠けたときはソース自体を作らないこと。**
 */
export function buildBasemapFC(
  prefs: Prefectures | null,
  subs: SubRegion[] | null,
): FeatureCollection<Polygon | LineString> {
  const features: Feature<Polygon | LineString>[] = []
  if (prefs) {
    const rings = Object.values(prefs).map((s) => s.rings)
    features.push(...ringsToPolygonFC(rings, (): BasemapFeatureProps => ({ kind: 'land' })).features)
    features.push(...ringsToLineFC(rings, (): BasemapFeatureProps => ({ kind: 'pref-line' })).features)
  }
  if (subs) {
    const rings = subs.map((sr) => sr.rings)
    features.push(...ringsToLineFC(rings, (): BasemapFeatureProps => ({ kind: 'sub-line' })).features)
    features.push(
      ...ringsToPolygonFC(rings, (i): BasemapFeatureProps => ({ kind: 'sub-hit', name: subs[i].name })).features,
    )
  }
  return { type: 'FeatureCollection', features }
}
