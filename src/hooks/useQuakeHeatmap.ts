import { useEffect, useMemo, useState } from 'react'
import type { JMAQuake } from '../types/earthquake'
import { fetchJmaQuakeHistory } from '../services/p2pquake'
import { fetchDmdataGdEarthquakes } from '../services/dmdata'
import { magnitudeToWeight, quakeIdentityKey, hasValidHypocenter, type HeatPoint } from '../utils/quakeHeatmap'
import { log } from '../utils/logger'

const isDmdss = import.meta.env.VITE_VARIANT === 'dmdss'
const HEATMAP_DAYS = 30
// 1ヶ月分の再取得は API 呼び出しコストがあるため、一定時間は localStorage のキャッシュを再利用する。
// キャッシュ取得後にライブ受信した地震は earthquakes とのマージで別途反映するため、
// このキャッシュ自体はやや古くても実害は小さい。
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_KEY = isDmdss ? 'quake-heatmap-cache-dmdss' : 'quake-heatmap-cache'

// quakeIdentityKey で重複排除できるよう、キャッシュ側の点にもキーを持たせる。
interface KeyedHeatPoint extends HeatPoint {
  key: string
}

interface CacheEntry {
  fetchedAt: number
  points: KeyedHeatPoint[]
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

function saveCache(points: KeyedHeatPoint[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), points }))
  } catch {
    // ストレージ容量超過は無視（次回また取得を試みる）
  }
}

// 直近1ヶ月分の地震活動ヒートマップ用データを取得する。
// 30日分のベースデータは API 取得後 CACHE_TTL_MS の間キャッシュしつつ、ライブ受信中の
// 地震一覧（earthquakes）を都度マージすることで、新規受信した地震も即座に反映する。
// earthquakes は useEarthquakes 側で既に issue 種別の優先度・同一性判定を解決済みの
// 一覧（1地震につき1エントリ）のため、ここで改めてその判定をする必要はない。
export function useQuakeHeatmap(
  enabled: boolean,
  dmdataApiKey: string,
  earthquakes: JMAQuake[],
): { points: HeatPoint[] | null; isLoading: boolean } {
  const [basePoints, setBasePoints] = useState<KeyedHeatPoint[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setBasePoints(null)
      return
    }
    // DMDSS版は gd.earthquake スコープ付きの APIキーが要るため、未設定なら取得しない。
    if (isDmdss && !dmdataApiKey) {
      setBasePoints(null)
      return
    }

    const cached = loadCache()
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setBasePoints(cached.points)
      return
    }

    let cancelled = false
    setIsLoading(true)

    const load = isDmdss
      ? fetchDmdataGdEarthquakes(dmdataApiKey, HEATMAP_DAYS).then(items =>
          items.map((it): KeyedHeatPoint => ({
            key: it.eventId,
            lat: it.latitude,
            lng: it.longitude,
            weight: magnitudeToWeight(it.magnitude),
          })),
        )
      : fetchJmaQuakeHistory(HEATMAP_DAYS).then(quakes =>
          quakes
            .filter(q => hasValidHypocenter(q.earthquake.hypocenter.latitude, q.earthquake.hypocenter.longitude))
            .map((q): KeyedHeatPoint => ({
              key: quakeIdentityKey(q),
              lat: q.earthquake.hypocenter.latitude,
              lng: q.earthquake.hypocenter.longitude,
              weight: magnitudeToWeight(q.earthquake.hypocenter.magnitude),
            })),
        )

    load
      .then(result => {
        if (cancelled) return
        setBasePoints(result)
        saveCache(result)
      })
      .catch(err => {
        if (cancelled) return
        log.warn('[data] 地震活動ヒートマップ取得失敗', err)
        // 失敗時は古いキャッシュがあればそれで継続する
        setBasePoints(cached?.points ?? null)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [enabled, dmdataApiKey])

  // ベースデータにライブ受信中の地震をマージする。取消済み・震源未確定・期間外は除外し、
  // 同一地震（quakeIdentityKey）が両方にあればライブ側（最新情報）を優先する。
  const points = useMemo(() => {
    if (!basePoints) return null
    const cutoffMs = Date.now() - HEATMAP_DAYS * 24 * 60 * 60 * 1000
    const merged = new Map<string, HeatPoint>()
    for (const p of basePoints) merged.set(p.key, p)
    for (const q of earthquakes) {
      if (q.cancelled || q.cancelledAt) continue
      const { latitude, longitude, magnitude } = q.earthquake.hypocenter
      if (!hasValidHypocenter(latitude, longitude)) continue
      if (new Date(q.earthquake.time).getTime() < cutoffMs) continue
      merged.set(quakeIdentityKey(q), { lat: latitude, lng: longitude, weight: magnitudeToWeight(magnitude) })
    }
    return Array.from(merged.values())
  }, [basePoints, earthquakes])

  return { points, isLoading }
}
