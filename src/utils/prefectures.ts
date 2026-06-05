// 都道府県の境界ポリゴン（public/data/prefectures.json）を読み込み、
// ダーク地図のベース（境界線＋陸地）を描画するためのユーティリティ。
//
// データは scripts/build-prefectures.mjs で生成・更新する。

export type LatLng = [number, number]

export interface PrefectureShape {
  /** 県名ラベルを置く代表点（最大リングの重心） */
  label: LatLng
  /** ラベルのオフセット方向（県内に余白が大きい側＝はみ出し防止） */
  dir: 'up' | 'down'
  /** 外周・離島などのリング（各リングは閉じた境界線） */
  rings: LatLng[][]
}

/** 都道府県名 -> 境界形状 */
export type Prefectures = Record<string, PrefectureShape>

const DATA_URL = `${import.meta.env.BASE_URL}data/prefectures.json`

let cache: Prefectures | null = null
let inflight: Promise<Prefectures> | null = null

/**
 * 都道府県の境界データを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合は inflight を破棄して次回リトライ可能にする。
 */
export function loadPrefectures(): Promise<Prefectures> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetch(DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`prefectures fetch failed: ${res.status}`)
        return res.json() as Promise<Prefectures>
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
