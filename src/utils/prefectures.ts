// 都道府県の境界ポリゴン（public/data/prefectures.json）を読み込み、
// ダーク地図のベース（境界線＋陸地）を描画するためのユーティリティ。
//
// データは scripts/build-prefectures.mjs で生成・更新する。

import { fetchJsonWithTimeout } from './fetchJson'

export type LatLng = [number, number]

/**
 * 代表点からラベルを退避させられる余地 `[北, 南]`（緯度差の度数）。
 *
 * ラベルは震度バッジ等と重なったときだけ上下へ退避する（`gl/labelOverlap.ts`）。その退避で文字が
 * 領域（県・区域）の外まで飛ばないよう、生成スクリプトが「代表点から真北・真南へ進んで領域の外に
 * 出るまでの距離」を焼いてある。代表点自体が領域の外に落ちる形（大きく凹んだ区域・離島の集まり）
 * では `[0, 0]` になり、その区域は退避せず、重なったときは消える側へ倒れる。
 */
export type LabelRoom = [number, number]

export interface PrefectureShape {
  /** 県名ラベルを置く代表点（最大リングの重心） */
  label: LatLng
  /** 代表点からラベルを退避させられる余地（→ `LabelRoom`） */
  room: LabelRoom
  /** 外周・離島などのリング（各リングは閉じた境界線） */
  rings: LatLng[][]
}

/** 都道府県名 -> 境界形状 */
export type Prefectures = Record<string, PrefectureShape>

const DATA_URL = `${import.meta.env.BASE_URL}data/prefectures.json`

let cache: Prefectures | null = null
let inflight: Promise<Prefectures> | null = null

export function getPrefecturesCache(): Prefectures | null {
  return cache
}

/**
 * 都道府県の境界データを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合（タイムアウトを含む）は inflight を破棄して次回リトライ可能にする。
 */
export function loadPrefectures(): Promise<Prefectures> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<Prefectures>(DATA_URL, 'prefectures')
      .then((data) => {
        cache = data
        return data
      })
      .catch((err) => {
        inflight = null
        throw err
      })
  }
  return inflight
}
