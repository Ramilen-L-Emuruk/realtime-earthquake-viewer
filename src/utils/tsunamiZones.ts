// 津波予報区の海岸線ライン（public/data/tsunami-zones.json）を読み込み、
// 区域名から海岸線座標を引くためのユーティリティ。
//
// データは scripts/build-tsunami-zones.mjs で生成・更新する。

export type LatLng = [number, number]

/** 区域名 -> 海岸線ラインの配列（1区域が複数ラインを持つ場合がある） */
export type TsunamiZones = Record<string, LatLng[][]>

const DATA_URL = `${import.meta.env.BASE_URL}data/tsunami-zones.json`

let cache: TsunamiZones | null = null
let inflight: Promise<TsunamiZones> | null = null

/**
 * 津波予報区の海岸線データを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合は inflight を破棄して次回リトライ可能にする。
 */
export function loadTsunamiZones(): Promise<TsunamiZones> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetch(DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`tsunami-zones fetch failed: ${res.status}`)
        return res.json() as Promise<TsunamiZones>
      })
      .then((data) => {
        // 中身の形まで見る。ビルドや配信の破損で空の表が 200 で返ると、呼び出し側は
        // 「取得成功・予報区 0 件」として扱ってしまい、津波の海岸線が出ない状態が失敗として
        // 検知されないまま進む。ここで例外にして通信失敗と同じ経路へ載せる。
        if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
          throw new Error('tsunami-zones fetch returned no data (empty or malformed)')
        }
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
