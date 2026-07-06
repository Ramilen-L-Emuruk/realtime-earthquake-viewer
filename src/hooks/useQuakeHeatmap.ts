import { useEffect, useState } from 'react'
import { fetchJmaQuakeHistory } from '../services/p2pquake'
import { fetchDmdataGdEarthquakes } from '../services/dmdata'
import { magnitudeToWeight, type HeatPoint } from '../utils/quakeHeatmap'
import { log } from '../utils/logger'

const isDmdss = import.meta.env.VITE_VARIANT === 'dmdss'
const HEATMAP_DAYS = 30
// 1ヶ月分の再取得は API 呼び出しコストがあるため、一定時間は localStorage のキャッシュを再利用する。
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_KEY = isDmdss ? 'quake-heatmap-cache-dmdss' : 'quake-heatmap-cache'

interface CacheEntry {
  fetchedAt: number
  points: HeatPoint[]
}

function loadCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as CacheEntry
  } catch {
    return null
  }
}

function saveCache(points: HeatPoint[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), points }))
  } catch {
    // ストレージ容量超過は無視（次回また取得を試みる）
  }
}

// 直近1ヶ月分の地震活動ヒートマップ用データを取得する。
// enabled が有効な間のみ取得し、キャッシュが新しければ API を叩かずそれを使う。
export function useQuakeHeatmap(
  enabled: boolean,
  dmdataApiKey: string,
): { points: HeatPoint[] | null; isLoading: boolean } {
  const [points, setPoints] = useState<HeatPoint[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setPoints(null)
      return
    }
    // DMDSS版は gd.earthquake スコープ付きの APIキーが要るため、未設定なら取得しない。
    if (isDmdss && !dmdataApiKey) {
      setPoints(null)
      return
    }

    const cached = loadCache()
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setPoints(cached.points)
      return
    }

    let cancelled = false
    setIsLoading(true)

    const load = isDmdss
      ? fetchDmdataGdEarthquakes(dmdataApiKey, HEATMAP_DAYS).then(items =>
          items.map((it): HeatPoint => ({
            lat: it.latitude,
            lng: it.longitude,
            weight: magnitudeToWeight(it.magnitude),
          })),
        )
      : fetchJmaQuakeHistory(HEATMAP_DAYS).then(quakes =>
          quakes
            .filter(q => q.earthquake.hypocenter.latitude > -200 && q.earthquake.hypocenter.longitude > -200)
            .map((q): HeatPoint => ({
              lat: q.earthquake.hypocenter.latitude,
              lng: q.earthquake.hypocenter.longitude,
              weight: magnitudeToWeight(q.earthquake.hypocenter.magnitude),
            })),
        )

    load
      .then(result => {
        if (cancelled) return
        setPoints(result)
        saveCache(result)
      })
      .catch(err => {
        if (cancelled) return
        log.warn('[data] 地震活動ヒートマップ取得失敗', err)
        // 失敗時は古いキャッシュがあればそれで継続する
        setPoints(cached?.points ?? null)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [enabled, dmdataApiKey])

  return { points, isLoading }
}
