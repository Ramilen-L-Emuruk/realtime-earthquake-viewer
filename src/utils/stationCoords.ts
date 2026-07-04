// 震度観測点・細分区域の座標テーブル（public/data/station-coords.json）を読み込み、
// 地震情報の地点(pref, addr)から緯度経度を引くためのユーティリティ。
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
 * 読み込み済みの座標テーブルキャッシュを返す（未読み込みなら null）。
 * TTS 読み上げ文生成など、fetch を待たず「取れていれば使う」用途向け。
 */
export function getStationCoordsCache(): StationCoordsData | null {
  return cache
}

/**
 * 都道府県名 -> その県が持つ一次細分区域名の全集合、を構築する。
 * areas のキー "都道府県|細分区域名" を pref でグルーピングして作る。
 * TTS で「観測区域が県内全区域と一致するので〇〇県と読み上げる」判定に使う。
 */
export function buildPrefAreaNamesIndex(data: StationCoordsData): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const key of Object.keys(data.areas)) {
    const sep = key.indexOf('|')
    if (sep < 0) continue
    const pref = key.slice(0, sep)
    const name = key.slice(sep + 1)
    if (!name) continue
    const set = index.get(pref) ?? new Set<string>()
    set.add(name)
    index.set(pref, set)
  }
  return index
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
 * 観測点名 -> 都道府県名 の逆引きインデックスを構築する。
 * stations のキー "都道府県|観測点名" を分解して name -> pref の Map を作る（初出優先）。
 * DMDATA JSON 電文の stations[] は都道府県情報を含まないため、この逆引きで pref を補完する。
 */
export function buildStationPrefIndex(data: StationCoordsData): Map<string, string> {
  const index = new Map<string, string>()
  for (const key of Object.keys(data.stations)) {
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
