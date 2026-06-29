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
  /** 区域の境界リング */
  rings: LatLng[][]
}

const DATA_URL = `${import.meta.env.BASE_URL}data/subregions.json`

let cache: SubRegion[] | null = null
let inflight: Promise<SubRegion[]> | null = null

export function getSubRegionsCache(): SubRegion[] | null {
  return cache
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
