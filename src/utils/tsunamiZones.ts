// 津波予報区の海岸線ライン（public/data/tsunami-zones.json）を読み込み、
// 区域名から海岸線座標を引くためのユーティリティ。
//
// データは scripts/build-tsunami-zones.mjs で生成・更新する。

import { fetchJsonWithTimeout } from './fetchJson'

export type LatLng = [number, number]

/** 区域名 -> 海岸線ラインの配列（1区域が複数ラインを持つ場合がある） */
export type TsunamiZones = Record<string, LatLng[][]>

const DATA_URL = `${import.meta.env.BASE_URL}data/tsunami-zones.json`

let cache: TsunamiZones | null = null
let inflight: Promise<TsunamiZones> | null = null

/**
 * 津波予報区の海岸線データを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合（タイムアウトを含む）は inflight を破棄して次回リトライ可能にする。
 */
export function loadTsunamiZones(): Promise<TsunamiZones> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<TsunamiZones>(DATA_URL, 'tsunami-zones', {
      // 中身の形まで見る。ビルドや配信の破損で空の表が 200 で返ると、呼び出し側は
      // 「取得成功・予報区 0 件」として扱ってしまい、津波の海岸線が出ない状態が失敗として
      // 検知されないまま進む。取得側の `validate` に渡すのは、ここで投げれば地図の
      // 「データの一部を取得できませんでした」にも計上されるため（`.then()` では計上されない）。
      validate: (data) => {
        if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
          throw new Error('tsunami-zones fetch returned no data (empty or malformed)')
        }
      },
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
