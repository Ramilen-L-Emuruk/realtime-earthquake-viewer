// 震度観測点・細分区域の座標テーブル（public/data/station-coords.json）を読み込み、
// 地震情報の地点(pref, addr)から緯度経度を引くためのユーティリティ。
//
// 座標データは public/data/station-coords.json に置かれており、
// scripts/build-station-coords.mjs で生成・更新する。

import { fetchJsonWithTimeout } from './fetchJson'

export type LatLng = [number, number]

/**
 * stations の値。3 要素目は regionNames の添字＝その観測点が属する一次細分区域。
 * 元データに区域が無い観測点は 2 要素のまま。
 */
export type StationEntry = [number, number] | [number, number, number]

export interface StationCoordsData {
  /** "都道府県|観測点名" -> [lat, lon, regionIdx?]（isArea: false の地点用） */
  stations: Record<string, StationEntry>
  /** "都道府県|細分区域名" -> [lat, lon]（isArea: true の地点用） */
  areas: Record<string, LatLng>
  /** 一次細分区域名の一覧（stations の 3 要素目が指す先）。旧データには無いため optional。 */
  regionNames?: string[]
}

const DATA_URL = `${import.meta.env.BASE_URL}data/station-coords.json`

let cache: StationCoordsData | null = null
let inflight: Promise<StationCoordsData> | null = null
/** 取得成功を待っている購読者（onStationCoordsLoaded）。成功時に一度呼んで捨てる。 */
const waiters = new Set<(data: StationCoordsData) => void>()

/**
 * 取得成功時に一度だけ呼ばれるコールバックを登録する。既に取得済みなら即座に呼ぶ。
 * 戻り値は購読解除関数。
 *
 * 本データは複数の呼び出し元（地図の震度点・地震カード・EEW の都道府県補完）が別々の
 * タイミングで要求する。loadStationCoords は失敗時に inflight を捨てて次回リトライ可能に
 * するため、先に要求した側が失敗しても、後から要求した側の再取得が成功することがある。
 * その成功を、既に失敗を見た側にも伝えるための仕組み（伝えないと、地震カードには
 * 都道府県別の震度が出るのに地図には震度が出ない、という非対称が固定される）。
 * 詳細は utils/subregions.ts の同名関数のコメントも参照。
 */
export function onStationCoordsLoaded(fn: (data: StationCoordsData) => void): () => void {
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
 * 座標テーブルを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合（タイムアウトを含む）は inflight を破棄して次回リトライ可能にする。
 */
export function loadStationCoords(): Promise<StationCoordsData> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<StationCoordsData>(DATA_URL, 'station-coords')
      .then((data) => {
        // 中身の形まで見る。ビルドや配信の破損で空の表が 200 で返ると、呼び出し側は
        // 「取得成功・観測点 0 件」として扱ってしまい、地図に震度が出ない状態が失敗として
        // 検知されないまま進む。ここで例外にして通信失敗と同じ経路へ載せる。
        // areas も必須。欠けたまま通すと buildAreaPrefIndex・lookupPointCoords が
        // Object.keys(undefined) で TypeError を投げ、レンダー中の例外になる（ErrorBoundary は無い）。
        if (
          !data ||
          typeof data !== 'object' ||
          !data.stations ||
          Object.keys(data.stations).length === 0 ||
          !data.areas ||
          typeof data.areas !== 'object' ||
          Object.keys(data.areas).length === 0
        ) {
          throw new Error('station-coords fetch returned no data (empty or malformed)')
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

/** 地域名 -> 気象庁の標準順（北から南）の順位。区域名と県名は別の Map に持つ。 */
export interface RegionOrderIndex {
  /** 一次細分区域名 -> 順位 */
  areas: Map<string, number>
  /** 都道府県名 -> その県の先頭区域の順位 */
  prefs: Map<string, number>
}

/**
 * 地域名から気象庁の標準順の順位を引く索引を構築する。読み上げの並べ替えに使う。
 *
 * 順位の実体は `areas` のキー順。生成元の気象庁 震度観測点一覧の並びをそのまま引き継いでおり、
 * 結果として北海道 → 沖縄・県内も慣用順（北部 → 南部 など）になっている。
 * 同じ県の区域はキー順の上で必ず連続しているため、県名にその県の先頭区域の順位を与えれば、
 * 区域名と県名が混在するリスト（県内全区域が揃うと「〇〇県」1件に集約されるため混在しうる）
 * でも県ごとにまとまった並びになる。この 2 つの前提は `stationCoords.test.ts` が実データで検証する。
 *
 * 区域名と県名を別の Map に分けているのは、両者が同じ名前になったとき（現行データでは
 * 「奈良県」＝県内唯一の区域名）に順位を取り違えないため。呼び出し側は区域名を先に引くこと。
 *
 * 収録が無い地域名（北方領土や沖縄の埋立地など、震度観測点を持たない区域）はこの索引に載らない。
 * 呼び出し側は引けなかった名前を末尾へ回すこと（気象庁の標準順でもこれらは末尾に置かれるため、
 * 末尾送りは標準順と矛盾しない）。
 */
export function buildRegionOrderIndex(data: StationCoordsData): RegionOrderIndex {
  const areas = new Map<string, number>()
  const prefs = new Map<string, number>()
  let order = 0
  for (const key of Object.keys(data.areas)) {
    const sep = key.indexOf('|')
    if (sep < 0) continue
    const pref = key.slice(0, sep)
    const name = key.slice(sep + 1)
    if (!name) continue
    if (!prefs.has(pref)) prefs.set(pref, order)
    areas.set(name, order)
    order++
  }
  return { areas, prefs }
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
  const entry = data.stations[key]
  return entry ? [entry[0], entry[1]] : null
}

/**
 * 観測点が属する一次細分区域名を引く（isArea:false の地点用）。
 * 未収録の観測点・区域を持たない観測点・旧データ（regionNames 無し）では null を返す。
 *
 * 座標からの点内包判定では、元データの 0.01 度（約 1km）粒度の丸めによって細い島や
 * 海岸沿いの観測点が海側に落ち、区域集約から漏れたり隣県の区域に誤って入る。
 * 区域の帰属はジオメトリではなくこのテーブルを正とする。
 */
export function lookupStationRegion(
  data: StationCoordsData,
  pref: string,
  addr: string,
): string | null {
  const regionIdx = data.stations[`${pref}|${addr}`]?.[2]
  if (regionIdx == null) return null
  return data.regionNames?.[regionIdx] ?? null
}
