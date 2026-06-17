// 震度観測点・細分区域の座標テーブル（public/data/station-coords.json）を読み込み、
// P2P地震情報の地点(pref, addr)から緯度経度を引くためのユーティリティ。
//
// 座標データは public/data/station-coords.json に置かれており、
// scripts/build-station-coords.mjs で生成・更新する。

export type LatLng = [number, number]

export interface StationCoordsData {
  /** "都道府県|観測点名" -> [lat, lon]（isArea: false の地点用） */
  stations: Record<string, LatLng>
  /** "都道府県|細分区域名" -> [lat, lon]（isArea: true の地点用） */
  areas: Record<string, LatLng>
}

const DATA_URL = `${import.meta.env.BASE_URL}data/station-coords.json`

let cache: StationCoordsData | null = null
let inflight: Promise<StationCoordsData> | null = null

/**
 * 座標テーブルを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合は inflight を破棄して次回リトライ可能にする。
 */
export function loadStationCoords(): Promise<StationCoordsData> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetch(DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`station-coords fetch failed: ${res.status}`)
        return res.json() as Promise<StationCoordsData>
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

/**
 * 細分区域名 -> 都道府県名 の逆引きインデックスを構築する。
 * areas のキー "都道府県|細分区域名" を分解して name -> pref の Map を作る（初出優先）。
 * EEW の地域別予想震度（pref を含まない）に都道府県を補完する用途で使う。
 */
export function buildAreaPrefIndex(data: StationCoordsData): Map<string, string> {
  const index = new Map<string, string>()
  for (const key of Object.keys(data.areas)) {
    const sep = key.indexOf('|')
    if (sep < 0) continue
    const pref = key.slice(0, sep)
    const name = key.slice(sep + 1)
    if (name && !index.has(name)) index.set(name, pref)
  }
  return index
}

/**
 * 地点の都道府県名・住所(観測点名 or 細分区域名)から座標を引く。
 * 見つからない場合は null を返す。
 */
export function lookupPointCoords(
  data: StationCoordsData,
  pref: string,
  addr: string,
  isArea: boolean,
): LatLng | null {
  const key = `${pref}|${addr}`
  if (isArea) return data.areas[key] ?? null
  return data.stations[key] ?? null
}
