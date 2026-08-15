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
    inflight = fetchJsonWithTimeout<TsunamiZones>(DATA_URL, 'tsunami-zones')
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
