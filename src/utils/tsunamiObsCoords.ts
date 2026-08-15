import { fetchJsonWithTimeout } from './fetchJson'

export type TsunamiObsCoords = Record<string, [number, number]>

const DATA_URL = `${import.meta.env.BASE_URL}data/tsunami-obs-coords.json`

let cache: TsunamiObsCoords | null = null
let inflight: Promise<TsunamiObsCoords> | null = null

/**
 * 津波観測点の座標テーブルを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合（タイムアウトを含む）は inflight を破棄して次回リトライ可能にする。
 */
export function loadTsunamiObsCoords(): Promise<TsunamiObsCoords> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<TsunamiObsCoords>(DATA_URL, 'tsunami-obs-coords')
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
