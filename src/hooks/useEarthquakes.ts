import { useState, useEffect, useRef, useCallback } from 'react'
import type { JMAQuake, JMATsunami, JMALpgm, EEWAlert, EEWRegion, Hypocenter, IntensityScale, EarthquakePoint, P2PQuakeEvent, ConnectionStatus, TelegramLogEntry } from '../types/earthquake'
import { fetchHistory, fetchJmaQuake, P2PQuakeWebSocket } from '../services/p2pquake'
import { DmdataWebSocket, fetchDmdataEarthquakes, fetchDmdataTsunamis, fetchDmdataLpgms } from '../services/dmdata'
import { loadStationCoords, buildAreaPrefIndex } from '../utils/stationCoords'

const isDmdss = import.meta.env.VITE_VARIANT === 'dmdss'
import {
  createTestEarthquake,
  createTestEEW,
  createTestEEWWarning,
  createTestEEWForecast,
  createTestTsunami,
  createTestTsunamiWarning,
  createTestTsunamiWatch,
  createTestTsunamiForecast,
} from '../utils/testData'

const MAX_HISTORY_RETAINED = 50   // 初回取得件数（設定の最大選択値に合わせる）
const LOAD_MORE_BATCH = 50        // 「もっと見る」1回あたりの取得件数
const MAX_TELEGRAM_LOG = 200      // 電文ログの最大保持件数

const ISSUE_PRIORITY: Record<string, number> = {
  DetailScale: 4,
  ScaleAndDestination: 3,
  Destination: 2,
  ScalePrompt: 1,
  DestinationAmended: 5,
  Foreign: 0,
  Other: 0,
}

const sortQuakes = (arr: JMAQuake[]): JMAQuake[] =>
  [...arr].sort((a, b) =>
    new Date(b.earthquake.time).getTime() - new Date(a.earthquake.time).getTime()
  )

// DMDSS版 EEW の地域別予想震度には pref が含まれないため、細分区域名→都道府県の
// 逆引きインデックスで補完する（EEWカードの対象地域表示用。地図の色塗りは name のみで動く）。
function enrichEEWPref(eew: EEWAlert, index: Map<string, string> | null): EEWAlert {
  if (!index || !eew.areas || eew.areas.length === 0) return eew
  const areas = eew.areas.map(a =>
    a.pref ? a : { ...a, pref: index.get(a.name) ?? '' },
  )
  return { ...eew, areas }
}

type TestEEWKind = 'special' | 'warning' | 'forecast'
type TestEEWEntry = { eventId: string; serial: number; cancelTimer: number }

function runSimulateEEW(
  kind: TestEEWKind,
  createFn: (eventId: string, serial: number) => EEWAlert,
  cancelMs: number,
  timers: Map<TestEEWKind, TestEEWEntry>,
  handleEvent: (event: P2PQuakeEvent) => void,
) {
  const prev = timers.get(kind)
  const isContinuation = prev !== undefined
  const eventId = isContinuation ? prev.eventId : `test-${kind}-${Date.now()}`
  const serial = isContinuation ? prev.serial + 1 : 1
  if (prev) window.clearTimeout(prev.cancelTimer)
  const eew = createFn(eventId, serial)
  handleEvent(eew)
  const cancelTimer = window.setTimeout(() => {
    handleEvent({ ...eew, cancelled: true })
    timers.delete(kind)
  }, cancelMs)
  timers.set(kind, { eventId, serial, cancelTimer })
}

export interface EarthquakeState {
  earthquakes: JMAQuake[]
  tsunamis: JMATsunami[]
  activeEEWs: ReadonlyMap<string, EEWAlert>
  lpgmByOriginTime: ReadonlyMap<string, JMALpgm>
  connectionStatus: ConnectionStatus
  lastUpdate: Date | null
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  error: string | null
  telegramLog: TelegramLogEntry[]
}

export function useEarthquakes(
  onLiveEvent?: (event: P2PQuakeEvent) => void,
  dmdataApiKey = '',
  dmdataTestDelivery = false,
  eewFinalClearSec = 180,
) {
  const [state, setState] = useState<EarthquakeState>({
    earthquakes: [],
    tsunamis: [],
    activeEEWs: new Map(),
    lpgmByOriginTime: new Map(),
    connectionStatus: (isDmdss && !dmdataApiKey) ? 'disconnected' : 'connecting',
    lastUpdate: null,
    isLoading: !(isDmdss && !dmdataApiKey),
    isLoadingMore: false,
    hasMore: false,
    error: null,
    telegramLog: [],
  })

  const appendTelegramLog = useCallback((entry: TelegramLogEntry) => {
    setState(prev => ({
      ...prev,
      telegramLog: prev.telegramLog.length >= MAX_TELEGRAM_LOG
        ? [entry, ...prev.telegramLog.slice(0, MAX_TELEGRAM_LOG - 1)]
        : [entry, ...prev.telegramLog],
    }))
  }, [])

  const clearTelegramLog = useCallback(() => {
    setState(prev => ({ ...prev, telegramLog: [] }))
  }, [])

  const wsRef = useRef<P2PQuakeWebSocket | null>(null)
  // 最新のコールバックを ref で保持し、handleEvent を安定させる
  const onLiveEventRef = useRef(onLiveEvent)
  onLiveEventRef.current = onLiveEvent
  // テスト EEW の発報状態を種別ごとに独立管理（複数EEW同時テスト対応）
  const testEEWTimersRef = useRef<Map<TestEEWKind, TestEEWEntry>>(new Map())
  // 通常最終報（isLastInfo: true, isCanceled: false）受信後の自動解除タイマー管理
  const finalCleanupTimersRef = useRef<Map<string, number>>(new Map())
  const eewFinalClearSecRef = useRef(eewFinalClearSec)
  eewFinalClearSecRef.current = eewFinalClearSec
  // 現在の state を WS コールバック内から参照するための ref
  const stateRef = useRef(state)
  stateRef.current = state
  // EEW 受信時に震源データをキャッシュし、後続の VXSE51（震度速報）に補完する。
  // activeEEWs はクリーンアップされるが、このキャッシュはセッション中保持する。
  const eewHypocenterCacheRef = useRef<Map<string, Hypocenter>>(new Map())
  // VXSE51 受信時に震度データをキャッシュし、後続の VXSE52（震源情報）に補完する。
  // VXSE52 は震源のみで震度を持たないため、VXSE51 の maxScale・points を引き継ぐ。
  const quakeIntensityCacheRef = useRef<Map<string, { maxScale: IntensityScale; points: EarthquakePoint[] }>>(new Map())
  // DMDSS 版「もっと見る」用カーソルと API キー（useCallback 内の stale closure 回避）
  const dmdataCursorRef = useRef<string | undefined>(undefined)
  const dmdataApiKeyRef = useRef(dmdataApiKey)
  dmdataApiKeyRef.current = dmdataApiKey
  // P2PQuake 版「もっと見る」用の生 API 取得件数（重複除去後の earthquakes.length とは別管理）
  // offset = earthquakes.length だと重複除去ズレで古いデータが抜け落ちるため、API 呼び出し回数ベースで管理する
  const p2pRawOffsetRef = useRef(0)

  // P2PQuake の 556 受信時に既存の Yahoo EEW へ地域別予想震度を注入する（音・タブ切替なし）。
  const enrichEEW = useCallback((eventId: string, areas: EEWRegion[]) => {
    setState(prev => {
      const existing = prev.activeEEWs.get(eventId)
      if (!existing) return prev
      const enriched = { ...existing, areas }
      return { ...prev, activeEEWs: new Map(prev.activeEEWs).set(eventId, enriched) }
    })
  }, [])

  const handleEvent = useCallback((event: P2PQuakeEvent) => {
    // ライブ受信／テスト送信のイベントを通知（初回の履歴読み込みでは呼ばれない）
    onLiveEventRef.current?.(event)

    // 556（EEW）のタイマー管理は setState の外で行う
    if (event.code === 556) {
      const eew = event as EEWAlert
      const key = eew.issue?.eventId ?? eew.id
      // 非キャンセル EEW の震源データを eventId でキャッシュする。
      // VXSE51（震度速報）受信時に座標がない場合にここから補完する。
      if (!eew.cancelled && !eew.test && key) {
        const hypo = eew.earthquake?.hypocenter
        if (hypo && Number.isFinite(hypo.latitude) && Number.isFinite(hypo.longitude)) {
          eewHypocenterCacheRef.current.set(key, hypo)
        }
      }
      if (eew.cancelled || eew.test) {
        // キャンセル時: 最終報タイマーが残っていればキャンセル
        const t = finalCleanupTimersRef.current.get(key)
        if (t !== undefined) {
          window.clearTimeout(t)
          finalCleanupTimersRef.current.delete(key)
        }
      } else if (eew.isFinal && !finalCleanupTimersRef.current.has(key)) {
        // 通常最終報: 設定秒数後にキャンセルイベントとして再発火（二重登録防止）
        const t = window.setTimeout(() => {
          handleEvent({ ...eew, cancelled: true })
          finalCleanupTimersRef.current.delete(key)
        }, eewFinalClearSecRef.current * 1000)
        finalCleanupTimersRef.current.set(key, t)
      }
    }

    // DMDATA 地震情報（551）の震度キャッシュ更新は setState の外で行う
    if (event.code === 551) {
      const quake = event as JMAQuake
      const m = quake.id?.match(/^dmdata-quake-(\d{14})-/)
      if (m) {
        // VXSE51 の震度データをキャッシュ（後続 VXSE52 への補完用）
        if (quake.issue.type === 'ScalePrompt' && quake.earthquake.maxScale >= 0) {
          quakeIntensityCacheRef.current.set(m[1], {
            maxScale: quake.earthquake.maxScale,
            points: quake.points,
          })
        }
      }
    }

    setState(prev => {
      const now = new Date()
      switch (event.code) {
        case 551: {
          let quake = event as JMAQuake
          const eventId = quake.id?.match(/^dmdata-quake-(\d{14})-/)?.[1]

          // VXSE51: 座標がない場合に EEW キャッシュから震源を補完する
          if (quake.issue.type === 'ScalePrompt' && quake.earthquake.hypocenter.latitude <= -200) {
            const cachedHypo = eventId ? eewHypocenterCacheRef.current.get(eventId) : undefined
            if (cachedHypo) {
              quake = {
                ...quake,
                earthquake: {
                  ...quake.earthquake,
                  hypocenter: { ...quake.earthquake.hypocenter, ...cachedHypo },
                },
              }
            }
          }

          // VXSE52/53: 震度がない場合に VXSE51 キャッシュから maxScale・points を補完する
          if (quake.earthquake.maxScale < 0 && quake.points.length === 0) {
            const cachedIntensity = eventId ? quakeIntensityCacheRef.current.get(eventId) : undefined
            if (cachedIntensity) {
              quake = {
                ...quake,
                earthquake: { ...quake.earthquake, maxScale: cachedIntensity.maxScale },
                points: cachedIntensity.points,
              }
            }
          }

          const key = quake.earthquake.time
          const existing = prev.earthquakes.find(e => e.earthquake.time === key)

          // VXSE61（DestinationAmended）: points を失わないよう震源フィールドのみをマージ
          if (quake.issue.type === 'DestinationAmended') {
            if (existing) {
              const merged: JMAQuake = {
                ...existing,
                time: quake.time,
                issue: quake.issue,
                earthquake: {
                  ...existing.earthquake,
                  hypocenter: quake.earthquake.hypocenter,
                  domesticTsunami: quake.earthquake.domesticTsunami !== 'Unknown'
                    ? quake.earthquake.domesticTsunami
                    : existing.earthquake.domesticTsunami,
                },
              }
              return {
                ...prev,
                earthquakes: sortQuakes([merged, ...prev.earthquakes.filter(e => e.earthquake.time !== key)]),
                lastUpdate: now,
              }
            }
            // 既存カードなし: 通常追加処理へフォールスルー
          }

          if (existing && (ISSUE_PRIORITY[existing.issue.type] ?? 0) > (ISSUE_PRIORITY[quake.issue.type] ?? 0)) {
            return prev
          }
          const earthquakes = sortQuakes([
            quake,
            ...prev.earthquakes.filter(e => e.earthquake.time !== key),
          ])
          return { ...prev, earthquakes, lastUpdate: now }
        }
        case 552: {
          const tsunami = event as JMATsunami
          if (tsunami.cancelled) {
            return { ...prev, tsunamis: [], lastUpdate: now }
          }
          return { ...prev, tsunamis: [tsunami], lastUpdate: now }
        }
        case 556: {
          const eew = event as EEWAlert
          const key = eew.issue?.eventId ?? eew.id
          if (eew.cancelled || eew.test) {
            const next = new Map(prev.activeEEWs)
            next.delete(key)
            return { ...prev, activeEEWs: next, lastUpdate: now }
          }
          return {
            ...prev,
            activeEEWs: new Map(prev.activeEEWs).set(key, eew),
            lastUpdate: now,
          }
        }
        default:
          return { ...prev, lastUpdate: now }
      }
    })
  }, [])

  // アンマウント時に最終報タイマーを全てクリア
  useEffect(() => {
    return () => {
      for (const t of finalCleanupTimersRef.current.values()) {
        window.clearTimeout(t)
      }
      finalCleanupTimersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    if (isDmdss) {
      // --- DMDSS版: APIキー未設定なら接続しない ---
      if (!dmdataApiKey) {
        setState(prev => ({ ...prev, connectionStatus: 'disconnected', isLoading: false }))
        return
      }

      setState(prev => ({ ...prev, isLoading: true, connectionStatus: 'connecting', error: null }))

      // DMDATA REST API で履歴取得
      Promise.all([
        fetchDmdataEarthquakes(dmdataApiKey, MAX_HISTORY_RETAINED),
        fetchDmdataTsunamis(dmdataApiKey, 10),
      ])
        .then(async ([quakeResult, tsunamiEvents]) => {
          if (cancelled) return
          const { quakes: quakeEvents, nextToken } = quakeResult
          dmdataCursorRef.current = nextToken
          const seenQuakes = new Map<string, JMAQuake>()
          for (const q of quakeEvents) {
            const key = q.earthquake.time
            const existing = seenQuakes.get(key)
            if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
              seenQuakes.set(key, q)
            }
          }
          const earthquakes = sortQuakes(Array.from(seenQuakes.values()))
          const allTsunami = tsunamiEvents
            .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
          const latestTsunami = allTsunami[0]
          const tsunamis = latestTsunami && !latestTsunami.cancelled ? [latestTsunami] : []

          // 表示中の最古の地震時刻まで VXSE62 をページネーションで取得
          const oldest = earthquakes.reduce<string | null>((acc, q) => {
            const t = q.earthquake.time
            return acc === null || t < acc ? t : acc
          }, null)
          const lpgmEvents = oldest
            ? await fetchDmdataLpgms(dmdataApiKey, oldest).catch(() => [])
            : []
          const lpgmByOriginTime = new Map<string, JMALpgm>()
          for (const lpgm of lpgmEvents) {
            if (lpgm.cancelled) continue
            const existing = lpgmByOriginTime.get(lpgm.originTime)
            if (!existing || lpgm.time > existing.time) {
              lpgmByOriginTime.set(lpgm.originTime, lpgm)
            }
          }

          if (cancelled) return
          setState(prev => ({
            ...prev,
            earthquakes,
            tsunamis,
            lpgmByOriginTime,
            lastUpdate: new Date(),
            isLoading: false,
            hasMore: !!nextToken,
            error: null,
          }))
        })
        .catch((err: unknown) => {
          if (cancelled) return
          const msg = err instanceof Error ? err.message : '取得失敗'
          setState(prev => ({ ...prev, isLoading: false, error: msg }))
        })

      // EEW の pref 補完用に細分区域名→都道府県の逆引きインデックスを先読み（取得失敗は無視）
      let areaPrefIndex: Map<string, string> | null = null
      loadStationCoords()
        .then(data => { areaPrefIndex = buildAreaPrefIndex(data) })
        .catch(() => {})

      // DMDSS WebSocket 接続（dmdataTestDelivery 有効時は試験報・訓練報も受信）
      const ws = new DmdataWebSocket(dmdataApiKey, dmdataTestDelivery)
      wsRef.current = null
      ws.onEvent = (ev) => {
        if (ev.kind === 'lpgm') {
          const lpgm = ev.data
          setState(prev => {
            const next = new Map(prev.lpgmByOriginTime)
            if (lpgm.cancelled) next.delete(lpgm.originTime)
            else next.set(lpgm.originTime, lpgm)
            return { ...prev, lpgmByOriginTime: next }
          })
        } else {
          const data = ev.data
          if (data.code === 556) {
            handleEvent(enrichEEWPref(data as EEWAlert, areaPrefIndex))
          } else {
            handleEvent(data)
          }
        }
      }
      ws.onStatusChange = status =>
        setState(prev => ({ ...prev, connectionStatus: status }))
      ws.onRawMessage = appendTelegramLog
      ws.connect()

      return () => {
        cancelled = true
        ws.disconnect()
      }
    }

    // --- 通常版: P2PQuake ---
    Promise.all([
      fetchJmaQuake(MAX_HISTORY_RETAINED),
      fetchHistory([552], 10),
    ])
      .then(([quakeEvents, tsunamiEvents]) => {
        if (cancelled) return
        const seenQuakes = new Map<string, JMAQuake>()
        for (const q of quakeEvents) {
          const key = q.earthquake.time
          const existing = seenQuakes.get(key)
          if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
            seenQuakes.set(key, q)
          }
        }
        const earthquakes = sortQuakes(Array.from(seenQuakes.values()))
        const allTsunami = (tsunamiEvents as JMATsunami[])
          .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        const latestTsunami = allTsunami[0]
        const tsunamis = latestTsunami && !latestTsunami.cancelled ? [latestTsunami] : []
        p2pRawOffsetRef.current = quakeEvents.length
        setState(prev => ({
          ...prev,
          earthquakes,
          tsunamis,
          lastUpdate: new Date(),
          isLoading: false,
          hasMore: quakeEvents.length === MAX_HISTORY_RETAINED,
          error: null,
        }))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : '取得失敗'
        setState(prev => ({ ...prev, isLoading: false, error: msg }))
      })

    const ws = new P2PQuakeWebSocket()
    wsRef.current = ws
    // P2PQuake WS の EEW (556) は areas 補完のみに使用し、音・タブ切替は発火させない。
    // Yahoo hypoInfo で検出済みの eventId であれば areas を注入、未知なら全処理（フォールバック）。
    ws.onEvent = (event: P2PQuakeEvent) => {
      if (event.code === 556) {
        if (event.test) return
        if (event.cancelled) return  // Yahoo の hypoInfo 消滅で解除済み
        const eew = event as EEWAlert
        const key = eew.issue?.eventId ?? eew.id
        if (stateRef.current.activeEEWs.has(key)) {
          enrichEEW(key, eew.areas ?? eew.regions ?? [])
        } else {
          handleEvent(event)  // フォールバック: Yahoo が未検出のEEW
        }
        return
      }
      handleEvent(event)
    }
    ws.onStatusChange = status =>
      setState(prev => ({ ...prev, connectionStatus: status }))
    ws.onRawMessage = appendTelegramLog
    ws.connect()

    return () => {
      cancelled = true
      ws.disconnect()
    }
  }, [handleEvent, appendTelegramLog, dmdataApiKey, dmdataTestDelivery])

  const loadMoreEarthquakes = useCallback(async () => {
    if (stateRef.current.isLoadingMore || !stateRef.current.hasMore) return
    setState(prev => ({ ...prev, isLoadingMore: true }))
    try {
      if (isDmdss) {
        const apiKey = dmdataApiKeyRef.current
        const cursor = dmdataCursorRef.current
        const existingQuakes = stateRef.current.earthquakes
        const { quakes: events, nextToken } = await fetchDmdataEarthquakes(apiKey, LOAD_MORE_BATCH, cursor)
        dmdataCursorRef.current = nextToken
        setState(prev => {
          const seenKeys = new Set(prev.earthquakes.map(e => e.earthquake.time))
          const seenForBatch = new Map<string, JMAQuake>()
          for (const q of events) {
            const key = q.earthquake.time
            if (seenKeys.has(key)) continue
            const existing = seenForBatch.get(key)
            if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
              seenForBatch.set(key, q)
            }
          }
          return {
            ...prev,
            earthquakes: sortQuakes([...prev.earthquakes, ...Array.from(seenForBatch.values())]),
            isLoadingMore: false,
            hasMore: !!nextToken,
          }
        })
        // 新しく読み込んだ地震に対応する LPGM を追加取得（失敗は無視）
        const newOldest = [...existingQuakes, ...events].reduce<string | null>((acc, q) => {
          const t = q.earthquake.time
          return acc === null || t < acc ? t : acc
        }, null)
        if (newOldest) {
          const lpgmEvents = await fetchDmdataLpgms(apiKey, newOldest).catch(() => [])
          if (lpgmEvents.length > 0) {
            setState(prev => {
              const lpgmByOriginTime = new Map(prev.lpgmByOriginTime)
              for (const lpgm of lpgmEvents) {
                if (lpgm.cancelled) continue
                const existing = lpgmByOriginTime.get(lpgm.originTime)
                if (!existing || lpgm.time > existing.time) {
                  lpgmByOriginTime.set(lpgm.originTime, lpgm)
                }
              }
              return { ...prev, lpgmByOriginTime }
            })
          }
        }
      } else {
        const offset = p2pRawOffsetRef.current
        const events = await fetchJmaQuake(LOAD_MORE_BATCH, offset)
        p2pRawOffsetRef.current += events.length
        setState(prev => {
          const seenKeys = new Set(prev.earthquakes.map(e => e.earthquake.time))
          const seenForBatch = new Map<string, JMAQuake>()
          for (const q of events) {
            const key = q.earthquake.time
            if (seenKeys.has(key)) continue
            const existing = seenForBatch.get(key)
            if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
              seenForBatch.set(key, q)
            }
          }
          return {
            ...prev,
            earthquakes: sortQuakes([...prev.earthquakes, ...Array.from(seenForBatch.values())]),
            isLoadingMore: false,
            hasMore: events.length === LOAD_MORE_BATCH,
          }
        })
      }
    } catch {
      setState(prev => ({ ...prev, isLoadingMore: false }))
    }
  }, [])

  const simulateEarthquake = useCallback(() => {
    handleEvent(createTestEarthquake())
  }, [handleEvent])

  const simulateEEW = useCallback(
    () => runSimulateEEW('special', createTestEEW, 30000, testEEWTimersRef.current, handleEvent),
    [handleEvent],
  )

  const simulateEEWWarning = useCallback(
    () => runSimulateEEW('warning', createTestEEWWarning, 30000, testEEWTimersRef.current, handleEvent),
    [handleEvent],
  )

  const simulateEEWForecast = useCallback(
    () => runSimulateEEW('forecast', createTestEEWForecast, 30000, testEEWTimersRef.current, handleEvent),
    [handleEvent],
  )

  const simulateTsunami = useCallback(() => {
    const tsunami = createTestTsunami()
    handleEvent(tsunami)
    setTimeout(() => handleEvent({ ...tsunami, cancelled: true }), 15000)
  }, [handleEvent])

  const simulateTsunamiWarning = useCallback(() => {
    const tsunami = createTestTsunamiWarning()
    handleEvent(tsunami)
    setTimeout(() => handleEvent({ ...tsunami, cancelled: true }), 10000)
  }, [handleEvent])

  const simulateTsunamiWatch = useCallback(() => {
    const tsunami = createTestTsunamiWatch()
    handleEvent(tsunami)
    setTimeout(() => handleEvent({ ...tsunami, cancelled: true }), 10000)
  }, [handleEvent])

  const simulateTsunamiForecast = useCallback(() => {
    const tsunami = createTestTsunamiForecast()
    handleEvent(tsunami)
    setTimeout(() => handleEvent({ ...tsunami, cancelled: true }), 10000)
  }, [handleEvent])

  return {
    ...state,
    injectEvent: handleEvent,
    loadMoreEarthquakes,
    clearTelegramLog,
    simulateEarthquake,
    simulateEEW, simulateEEWWarning, simulateEEWForecast,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch, simulateTsunamiForecast,
  }
}
