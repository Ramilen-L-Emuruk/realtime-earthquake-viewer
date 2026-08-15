// 活断層線データ（public/data/active-faults.json）を読み込むユーティリティ。
//
// データは scripts/build-active-faults.mjs で生成・更新する。
// 出典: 産業技術総合研究所（産総研）活断層データベース（政府標準利用規約2.0）

import { fetchJsonWithTimeout } from './fetchJson'

export type LatLng = [number, number]

export interface ActiveFaultSegment {
  name: string
  lines: LatLng[][]
}

const DATA_URL = `${import.meta.env.BASE_URL}data/active-faults.json`

let cache: ActiveFaultSegment[] | null = null
let inflight: Promise<ActiveFaultSegment[]> | null = null

/**
 * 全国活断層線データを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合（タイムアウトを含む）は inflight を破棄して次回リトライ可能にする。
 */
export function loadActiveFaults(): Promise<ActiveFaultSegment[]> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<ActiveFaultSegment[]>(DATA_URL, 'active-faults')
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
