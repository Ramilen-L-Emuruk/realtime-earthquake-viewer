import { useState, useEffect, useRef, useCallback } from 'react'
import type { JMAQuake, JMATsunami, JMALpgm, EEWAlert, EEWRegion, P2PQuakeEvent, ConnectionStatus } from '../types/earthquake'
import { fetchHistory, P2PQuakeWebSocket } from '../services/p2pquake'
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
} from '../utils/testData'

const MAX_HISTORY_RETAINED = 50   // 初回取得件数（設定の最大選択値に合わせる）
const LOAD_MORE_BATCH = 50        // 「もっと見る」1回あたりの取得件数

const ISSUE_PRIORITY: Record<string, number> = {
  DetailScale: 4,
  ScaleAndDestination: 3,
  Destination: 2,
  ScalePrompt: 1,
  Foreign: 0,
  Other: 0,
}

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
}

export function useEarthquakes(
  onLiveEvent?: (event: P2PQuakeEvent) => void,
  dmdataApiKey = '',
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
  })

  const wsRef = useRef<P2PQuakeWebSocket | null>(null)
  // 最新のコールバックを ref で保持し、handleEvent を安定させる
  const onLiveEventRef = useRef(onLiveEvent)
  onLiveEventRef.current = onLiveEvent
  // テスト EEW の発報状態を種別ごとに独立管理（複数EEW同時テスト対応）
  const testEEWTimersRef = useRef<Map<TestEEWKind, TestEEWEntry>>(new Map())
  // 現在の state を WS コールバック内から参照するための ref
  const stateRef = useRef(state)
  stateRef.current = state
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
    setState(prev => {
      const now = new Date()
      switch (event.code) {
        case 551: {
          const quake = event as JMAQuake
          const key = quake.earthquake.time
          const existing = prev.earthquakes.find(e => e.earthquake.time === key)
          if (existing && (ISSUE_PRIORITY[existing.issue.type] ?? 0) > (ISSUE_PRIORITY[quake.issue.type] ?? 0)) {
            return prev
          }
          const earthquakes = [
            quake,
            ...prev.earthquakes.filter(e => e.earthquake.time !== key),
          ]
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
          const earthquakes = Array.from(seenQuakes.values())
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

      // DMDSS WebSocket 接続
      const ws = new DmdataWebSocket(dmdataApiKey)
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
      ws.connect()

      return () => {
        cancelled = true
        ws.disconnect()
      }
    }

    // --- 通常版: P2PQuake ---
    Promise.all([
      fetchHistory([551], MAX_HISTORY_RETAINED),
      fetchHistory([552], 10),
    ])
      .then(([quakeEvents, tsunamiEvents]) => {
        if (cancelled) return
        const seenQuakes = new Map<string, JMAQuake>()
        for (const q of quakeEvents as JMAQuake[]) {
          const key = q.earthquake.time
          const existing = seenQuakes.get(key)
          if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
            seenQuakes.set(key, q)
          }
        }
        const earthquakes = Array.from(seenQuakes.values())
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
    ws.connect()

    return () => {
      cancelled = true
      ws.disconnect()
    }
  }, [handleEvent, dmdataApiKey])

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
            earthquakes: [...prev.earthquakes, ...Array.from(seenForBatch.values())],
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
        const events = await fetchHistory([551], LOAD_MORE_BATCH, offset)
        p2pRawOffsetRef.current += events.length
        setState(prev => {
          const seenKeys = new Set(prev.earthquakes.map(e => e.earthquake.time))
          const seenForBatch = new Map<string, JMAQuake>()
          for (const q of events as JMAQuake[]) {
            const key = q.earthquake.time
            if (seenKeys.has(key)) continue
            const existing = seenForBatch.get(key)
            if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
              seenForBatch.set(key, q)
            }
          }
          return {
            ...prev,
            earthquakes: [...prev.earthquakes, ...Array.from(seenForBatch.values())],
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

  return {
    ...state,
    injectEvent: handleEvent,
    loadMoreEarthquakes,
    simulateEarthquake,
    simulateEEW, simulateEEWWarning, simulateEEWForecast,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch,
  }
}
