// 一次細分区域（地震情報・緊急地震速報の「地域」区分）の境界（public/data/subregions.json）
// を読み込むユーティリティ。ベースマップの細分境界線＋区域名ラベルに使う。
//
// データは scripts/build-subregions.mjs で生成・更新する。

import type { LatLng } from './prefectures'

export interface SubRegion {
  /** 区域名（例: 神奈川県東部・石狩地方北部） */
  name: string
  /** 区域名ラベルを置く代表点（最大リングの重心） */
  label: LatLng
  /** ラベルの退避方向（区域中心の震度バッジと重ならないよう text-offset で up/down にずらす） */
  dir: 'up' | 'down'
  /** 区域の境界リング */
  rings: LatLng[][]
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
 * 取得に失敗した場合は inflight を破棄して次回リトライ可能にする。
 */
export function loadSubRegions(): Promise<SubRegion[]> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetch(DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`subregions fetch failed: ${res.status}`)
        return res.json() as Promise<SubRegion[]>
      })
      .then((data) => {
        // 中身の形（配列・非空）まで見る。ビルドや配信の破損で `[]` や非配列が 200 で返ると、
        // 呼び出し側は「取得成功・区域 0 件」として扱ってしまい、区域が描けない状態が
        // 失敗として検知されないまま進む（useSubRegions の failed が立たずフォールバックも
        // 効かない）。ここで例外にして、通信失敗と同じ経路へ載せる。
        if (!Array.isArray(data) || data.length === 0) {
          throw new Error('subregions fetch returned no data (empty or malformed)')
        }
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
