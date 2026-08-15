// プレート境界線データ（public/data/plate-boundaries.json）を読み込むユーティリティ。
//
// データは scripts/build-plate-boundaries.mjs で生成・更新する。
// 出典: PB2002 (Bird, 2003) — https://github.com/fraxen/tectonicplates（Open Data Commons Attribution License）

export type LatLng = [number, number]

export interface PlateBoundarySegment {
  plateA: string
  plateB: string
  type: 'subduction' | 'other'
  lines: LatLng[][]
}

const DATA_URL = `${import.meta.env.BASE_URL}data/plate-boundaries.json`

let cache: PlateBoundarySegment[] | null = null
let inflight: Promise<PlateBoundarySegment[]> | null = null

/**
 * 全球のプレート境界線データを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合は inflight を破棄して次回リトライ可能にする。
 */
export function loadPlateBoundaries(): Promise<PlateBoundarySegment[]> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetch(DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`plate-boundaries fetch failed: ${res.status}`)
        return res.json() as Promise<PlateBoundarySegment[]>
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
