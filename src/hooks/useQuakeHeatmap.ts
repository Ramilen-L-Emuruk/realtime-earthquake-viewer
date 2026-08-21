import { useEffect, useMemo, useState } from 'react'
import type { JMAQuake } from '../types/earthquake'
import { fetchJmaQuakeHistory } from '../services/p2pquake'
import { fetchDmdataGdEarthquakes } from '../services/dmdata'
import { magnitudeToWeight, quakeIdentityKey, hasValidHypocenter, type HeatPoint } from '../utils/quakeHeatmap'
import { log } from '../utils/logger'
import { serverNow } from '../utils/clock'

import { isDmdss } from '../utils/env'
import { isValidDmdataApiKey, DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'
const HEATMAP_DAYS = 30
// 1ヶ月分の再取得は API 呼び出しコストがあるため、一定時間は localStorage のキャッシュを再利用する。
// キャッシュ取得後にライブ受信した地震は earthquakes とのマージで別途反映するため、
// このキャッシュ自体はやや古くても実害は小さい。
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
// 保存形式に震源名・深さ・発生時刻を足したため、旧形式と混ざらないようキーを変える（v2）。
const CACHE_KEY = isDmdss ? 'quake-heatmap-cache-dmdss-v2' : 'quake-heatmap-cache-v2'
// 旧形式のキャッシュは二度と読まないので、見かけたら掃除する。
const LEGACY_CACHE_KEYS = ['quake-heatmap-cache', 'quake-heatmap-cache-dmdss']

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
    for (const key of LEGACY_CACHE_KEYS) localStorage.removeItem(key)
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as CacheEntry
  } catch (e) {
    // 壊れた JSON・localStorage 利用不可。取得し直せば済むので処理は続けるが、
    // 毎回キャッシュが効かない状態に気づけるよう記録は残す。
    log.warn('[data] 地震活動ヒートマップのキャッシュ読み込みに失敗（取得し直します）', e)
    return null
  }
}

function saveCache(points: KeyedHeatPoint[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: serverNow(), points }))
  } catch (e) {
    // 容量超過等。次回また取得を試みるので致命的ではないが、黙って毎回取り直す状態になるため残す。
    log.warn('[data] 地震活動ヒートマップのキャッシュ保存に失敗（次回も取得し直します）', e)
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
    // 通信へ載せられない文字を含むキーも取得しないが、こちらは記録を残す。
    // 未設定は利用者が選んだ状態なので黙って出さなくてよいが、入れたキーが使えないのは異常であり、
    // 手がかりが無いと「ヒートマップだけ出ない」理由に辿り着けない。
    // この経路は画面にエラーを出さない仕様のため、記録を落とすと完全に無音になる。
    if (isDmdss && !isValidDmdataApiKey(dmdataApiKey)) {
      log.warn(`[data] 地震活動ヒートマップを取得しない: ${DMDATA_API_KEY_INVALID_MESSAGE}`)
      // 取れないだけで、既に持っているものが無効になったわけではない。下の .catch と同じく
      // キャッシュがあれば表示を保つ。キー入力中はデバウンス（800ms）でここを一時的に通るため、
      // 捨てると「直している最中に、見えていたヒートマップが消える」ことになる。
      // 変換途中の値こそこの判定を入れた理由なので、まさに直そうとしている人にだけ起きる。
      setBasePoints(loadCache()?.points ?? null)
      return
    }

    const cached = loadCache()
    if (cached && serverNow() - cached.fetchedAt < CACHE_TTL_MS) {
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
            name: it.name,
            time: it.originTime,
            depth: it.depth,
            magnitude: it.magnitude,
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
              name: q.earthquake.hypocenter.name,
              time: q.earthquake.time,
              depth: q.earthquake.hypocenter.depth,
              magnitude: q.earthquake.hypocenter.magnitude,
            })),
        )

    load
      .then(result => {
        if (cancelled) return
        setBasePoints(result)
        saveCache(result)
      })
      .catch(err => {
        // ログは cancelled と無関係に必ず出す。状態更新を止めることと、失敗を記録しないことは
        // 別の話。ここを cancelled で早期 return すると、設定変更で effect が張り直された経路
        // （APIキー入力欄は 1 文字ごとに更新するため高頻度に起きる）で失敗が完全に消える。
        if (cancelled) {
          log.debug('[data] 地震活動ヒートマップ取得失敗（この取得は破棄済み）', err)
          return
        }
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
    const cutoffMs = serverNow() - HEATMAP_DAYS * 24 * 60 * 60 * 1000
    const merged = new Map<string, HeatPoint>()
    for (const p of basePoints) merged.set(p.key, p)
    for (const q of earthquakes) {
      if (q.cancelled || q.cancelledAt) continue
      const { latitude, longitude, magnitude, name, depth } = q.earthquake.hypocenter
      if (!hasValidHypocenter(latitude, longitude)) continue
      if (new Date(q.earthquake.time).getTime() < cutoffMs) continue
      merged.set(quakeIdentityKey(q), {
        lat: latitude,
        lng: longitude,
        weight: magnitudeToWeight(magnitude),
        name,
        time: q.earthquake.time,
        depth,
        magnitude,
      })
    }
    return Array.from(merged.values())
  }, [basePoints, earthquakes])

  return { points, isLoading }
}
