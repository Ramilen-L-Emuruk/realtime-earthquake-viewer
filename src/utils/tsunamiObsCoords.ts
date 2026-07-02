export type TsunamiObsCoords = Record<string, [number, number]>

const DATA_URL = `${import.meta.env.BASE_URL}data/tsunami-obs-coords.json`

let cache: TsunamiObsCoords | null = null
let inflight: Promise<TsunamiObsCoords> | null = null

export function loadTsunamiObsCoords(): Promise<TsunamiObsCoords> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetch(DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`tsunami-obs-coords fetch failed: ${res.status}`)
        return res.json() as Promise<TsunamiObsCoords>
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
