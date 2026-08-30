import type { Feature, FeatureCollection, MultiLineString } from 'geojson'
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { log } from '../../../utils/logger'

// プレート境界線・活断層線のように「読み込んだら変わらない線データ」を 1 つの geojson ソースへ
// 相乗りさせるための小さな受け皿。レイヤーは `kind` の filter で自分の分だけを描く。
//
// まとめる理由は gl/basemapFeatures.ts と同じ（タイルのクリッピングマスクとタイル被覆の再計算が
// どちらもソース単位で走るため、同じ画に出る fill / line はソースを共有するほど軽くなる）。
// ベースマップと別のソースにしているのは**レイヤーの並び順**が理由——この 2 枚は震度の区域塗り
// より前面で、あいだに別ソースのレイヤーが挟まる。まとめても 1 回ぶんのマスクは避けられない。
//
// **提供元が 2 つあり、データの到着タイミングが別々**（それぞれ独立した遅延読込）。そのため
// ソースを共有するには「先に届いた方でソースを作り、後から届いた方が追記する」形が要る。
// ここがその調停役で、各コンポーネントは自分の分を put して、外れるときに drop するだけでよい。

/** 相乗りする線データの共有ソース id。 */
export const OVERLAY_LINE_SRC = 'overlay-lines'

/** 共有ソース内で feature を描き分ける種別。 */
export type OverlayLineKind = 'plate' | 'fault'

/**
 * 共有ソースへ載せる feature が最低限持つ属性（各提供元は自分の属性をこれに足してよい）。
 *
 * **`kind` に必ずこの型を通すこと。** GeoJSON の属性は `{ [name: string]: any }` なので、
 * 素で書くと打ち間違えても型検査を素通りする。埋め込む側と filter 側は別ファイルの文字列
 * リテラルどうしなので、食い違えば**そのレイヤーは無言で 0 件になる**。
 */
export interface OverlayLineProps {
  kind: OverlayLineKind
}

/** `kind` が一致する feature だけを描くレイヤー filter。 */
export function overlayLineKindFilter(kind: OverlayLineKind): ExpressionSpecification {
  return ['==', ['get', 'kind'], kind]
}

// map ごとの提供元テーブル（key = OverlayLineKind）。map が破棄されれば一緒に消える。
const registry = new WeakMap<MapLibreMap, Map<OverlayLineKind, Feature<MultiLineString>[]>>()

function toFeatureCollection(
  parts: Map<OverlayLineKind, Feature<MultiLineString>[]>,
): FeatureCollection<MultiLineString> {
  const features: Feature<MultiLineString>[] = []
  for (const part of parts.values()) features.push(...part)
  return { type: 'FeatureCollection', features }
}

/**
 * 自分の分の feature を登録し、共有ソースへ反映する（ソースが無ければ作る）。
 *
 * 呼び出し側はこの関数の**後で**自分のレイヤーを追加すること（レイヤーは存在しないソースを
 * 参照できない）。
 */
export function putOverlayLines(
  map: MapLibreMap,
  kind: OverlayLineKind,
  features: Feature<MultiLineString>[],
): void {
  const parts = registry.get(map) ?? new Map<OverlayLineKind, Feature<MultiLineString>[]>()
  registry.set(map, parts)
  parts.set(kind, features)
  const data = toFeatureCollection(parts)
  // この id でソースを作るのはこのモジュールだけなので、geojson 以外の型は入り得ない。
  const source = map.getSource(OVERLAY_LINE_SRC) as GeoJSONSource | undefined
  if (source) source.setData(data)
  else map.addSource(OVERLAY_LINE_SRC, { type: 'geojson', data })
}

/**
 * 自分の分を取り下げる。提供元が 1 つも残らなければソースごと削除する。
 *
 * **呼び出し側は自分のレイヤーを外してから呼ぶこと。** 参照するレイヤーが残っていると MapLibre は
 * ソースを削除しない。最後の提供元が降りる時点で、全ての提供元のレイヤーが外れている必要がある。
 *
 * **その失敗は例外の形では来ない。** `Style.removeSource` はエラーイベントを発火して何もせずに
 * 戻るだけなので（MapLibre 実装）、呼びっぱなしでは気づけない。気づかないまま登録簿を空にすると、
 * 残ったソースへ次の提供元が `setData` した時点で、外し忘れたレイヤーは自分の feature を失って
 * **無言で空になる**。削除できたことを確かめてから登録簿を畳む。
 */
export function dropOverlayLines(map: MapLibreMap, kind: OverlayLineKind): void {
  const parts = registry.get(map)
  if (!parts) return
  parts.delete(kind)
  if (parts.size > 0) {
    const source = map.getSource(OVERLAY_LINE_SRC) as GeoJSONSource | undefined
    // まだ提供元が残っているのにソースが無いのは、このモジュールを通さずに消された場合だけ。
    // 残った側のレイヤーは以後何も描かなくなるので、黙って通さず記録する。
    if (source) source.setData(toFeatureCollection(parts))
    else log.error(`[overlayLineSource] 共有ソース ${OVERLAY_LINE_SRC} が見当たらない`, { droppedKind: kind })
    return
  }
  if (map.getSource(OVERLAY_LINE_SRC)) {
    map.removeSource(OVERLAY_LINE_SRC)
    if (map.getSource(OVERLAY_LINE_SRC)) {
      // 登録簿は残す。次の提供元が put した時点で `setData` 側の経路に入り、そちらは正しく合流する。
      log.error(
        `[overlayLineSource] 共有ソース ${OVERLAY_LINE_SRC} を削除できなかった` +
          `（参照するレイヤーが残っている。降りる前に自分のレイヤーを外していない提供元がある）`,
        { droppedKind: kind },
      )
      return
    }
  }
  registry.delete(map)
}
