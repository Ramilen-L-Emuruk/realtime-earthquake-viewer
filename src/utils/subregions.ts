// 一次細分区域（地震情報・緊急地震速報の「地域」区分）の境界（public/data/subregions.json）
// を読み込むユーティリティ。ベースマップの細分境界線＋区域名ラベル、震度・EEW 予想の区域塗りと
// そのカメラフィットに使う。
//
// データは scripts/build-subregions.mjs で生成・更新する。

import type { LabelRoom, LatLng } from './prefectures'
import { fetchJsonWithTimeout } from './fetchJson'

export interface SubRegion {
  /** 区域名（例: 神奈川県東部・石狩地方北部） */
  name: string
  /** 区域名ラベルを置く代表点（最大リングの重心） */
  label: LatLng
  /** 代表点からラベルを退避させられる余地（→ `LabelRoom`） */
  room: LabelRoom
  /** 区域の境界リング */
  rings: LatLng[][]
}

/** 区域ポリゴンの外接矩形（bbox）。 */
export interface RingsBounds {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

/**
 * 境界リング群の外接矩形を返す。頂点が 1 つも無ければ null。
 *
 * 区域を「代表点（label）」ではなく bbox で扱うための共通計算。カメラフィットでは、区域が代表点より
 * はみ出た形のときにフレームから溢れるのを防ぐために使い（`useQuakeLayerData` の `quakeFitPositions`・
 * `useEewLayerData` の `eewFitPositions`）、区域集約では点内包判定（`pointInRings`）の前段フィルタと
 * して使う。両者が同じ矩形を指していないと「塗られるのにフィット対象から漏れる区域」が生まれるため、
 * 導出をここ一箇所に置く。
 */
export function ringsBounds(rings: LatLng[][]): RingsBounds | null {
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const ring of rings)
    for (const [lat, lng] of ring) {
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
    }
  if (minLat === Infinity) return null
  return { minLat, maxLat, minLng, maxLng }
}

/**
 * 名前 → 外接矩形の索引。**入力の参照をキーにして 1 度だけ作る。**
 *
 * 境界は県 47 件で全頂点 97,562 点・区域 192 件で 142,471 点あり、呼び出しごとに走査すると重い。
 * 地震カードの一覧は仮想化していないので、カードの中で走らせると**畳んだカードも含めて全枚数ぶん**
 * 繰り返される。データは読み込んだら変わらないので、参照が同じなら作り直す理由が無い。
 *
 * 同じ形のキャッシュが `stationCoords.ts` の `getAreaPrefIndexCache` にもある。
 *
 * @param source キャッシュの鍵。読み込んだデータそのものを渡す（参照が変われば作り直す）。
 * @param entries 名前とリング群の組。**キャッシュに当たったときは呼ばれない**ので、
 *   呼び出し側で組を作り直す費用もかからない。
 */
const boundsIndexCache = new WeakMap<object, Map<string, RingsBounds>>()

/** 境界データが未読み込みのときの空の索引。呼び出し側が毎レンダー作り直さないよう 1 つだけ持つ。 */
export const EMPTY_BOUNDS_INDEX: ReadonlyMap<string, RingsBounds> = new Map()

export function ringsBoundsIndex(
  source: object,
  entries: () => Iterable<readonly [string, LatLng[][]]>,
): Map<string, RingsBounds> {
  const hit = boundsIndexCache.get(source)
  if (hit) return hit
  const index = new Map<string, RingsBounds>()
  for (const [name, rings] of entries()) {
    const bounds = ringsBounds(rings)
    if (bounds) index.set(name, bounds)
  }
  boundsIndexCache.set(source, index)
  return index
}

const DATA_URL = `${import.meta.env.BASE_URL}data/subregions.json`

let cache: SubRegion[] | null = null
let inflight: Promise<SubRegion[]> | null = null
/** 取得成功を待っている購読者（onSubRegionsLoaded）。成功時に一度呼んで捨てる。 */
const waiters = new Set<(data: SubRegion[]) => void>()

export function getSubRegionsCache(): SubRegion[] | null {
  return cache
}

/**
 * 取得成功時に一度だけ呼ばれるコールバックを登録する。既に取得済みなら即座に呼ぶ。
 * 戻り値は購読解除関数。
 *
 * 本データは複数の呼び出し元（ベースマップ・ラベル・地震/EEW の派生データ）が別々のタイミングで
 * 要求する。loadSubRegions は失敗時に inflight を捨てて次回リトライ可能にするため、先に要求した
 * 側が失敗しても、後から要求した側の再取得が成功することがある。その成功を、既に失敗を見た側にも
 * 伝えるための仕組み（伝えないと、地図の境界線は復活したのに震度だけ代替表示に固定される）。
 *
 * 前提: 要求のタイミングがずれていること。震度側（useSubRegions）は JapanMapGL のマウント直後に、
 * ベースマップ側（BaseMapGL / LabelsGL）は MapLibre の load イベント後（effect の依存が [map]）に
 * 走るため、実際にずれている。ここを揃えるリファクタ（例: useSubRegions を map 待ちにする）を
 * 入れると全員が同じ in-flight fetch を共有するだけになり、初回失敗からの復帰が働かなくなる。
 * 自前の再試行は持たせていないので、依存配列を触るときはこの前提を壊していないか確認すること。
 */
export function onSubRegionsLoaded(fn: (data: SubRegion[]) => void): () => void {
  if (cache) {
    fn(cache)
    return () => {}
  }
  waiters.add(fn)
  return () => {
    waiters.delete(fn)
  }
}

/**
 * 一次細分区域の境界データを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合（タイムアウトを含む）は inflight を破棄して次回リトライ可能にする。
 */
export function loadSubRegions(): Promise<SubRegion[]> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<SubRegion[]>(DATA_URL, 'subregions', {
      // 中身の形（配列・非空）まで見る。ビルドや配信の破損で `[]` や非配列が 200 で返ると、
      // 呼び出し側は「取得成功・区域 0 件」として扱ってしまい、区域が描けない状態が
      // 失敗として検知されないまま進む（useSubRegions の failed が立たずフォールバックも
      // 効かない）。通信失敗と同じ扱いにするため、取得側の `validate` に渡す——ここで投げれば
      // 地図の「データN件を取り込めず」にも計上される（`.then()` では計上されない）。
      // 各区域の中身（`rings` を持つか等）までは見ていない。prefectures 側も同じ粒度。
      validate: (data) => {
        if (!Array.isArray(data) || data.length === 0) {
          throw new Error('subregions fetch returned no data (empty or malformed)')
        }
      },
    })
      .then((data) => {
        cache = data
        for (const fn of waiters) fn(data)
        waiters.clear()
        return data
      })
      .catch((err) => {
        inflight = null
        throw err
      })
  }
  return inflight
}
