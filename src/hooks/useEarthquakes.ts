import { useState, useEffect, useRef, useCallback } from 'react'
import type { JMAQuake, JMATsunami, EEWAlert, EEWRegion, P2PQuakeEvent, ConnectionStatus } from '../types/earthquake'
import { fetchHistory, P2PQuakeWebSocket } from '../services/p2pquake'

const ISSUE_PRIORITY: Record<string, number> = {
  DetailScale: 4,
  ScaleAndDestination: 3,
  Destination: 2,
  ScalePrompt: 1,
  Foreign: 0,
  Other: 0,
}

// ---- Test data generators ----

function createTestEarthquake(): JMAQuake {
  const now = new Date().toISOString()
  return {
    code: 551,
    id: `test-eq-${Date.now()}`,
    time: now,
    issue: { source: 'テスト', time: now, type: 'ScaleAndDestination', correct: 'None' },
    earthquake: {
      time: now,
      // 2011年東北地方太平洋沖地震を参考にしたパラメータ
      hypocenter: { name: '三陸沖', latitude: 38.1, longitude: 142.9, depth: 24, magnitude: 9.0 },
      maxScale: 70,
      domesticTsunami: 'Warning',
      foreignTsunami: 'None',
    },
    // addr は地図の震度マーカー表示用に、座標テーブル（public/data/station-coords.json）に
    // 実在する観測点名を使用する。市区町村名のままだと座標が引けずマーカーが出ない。
    points: [
      { pref: '宮城県', addr: '栗原市築館',         isArea: false, scale: 70 },
      { pref: '宮城県', addr: '気仙沼市赤岩',        isArea: false, scale: 60 },
      { pref: '宮城県', addr: '仙台青葉区大倉',      isArea: false, scale: 60 },
      { pref: '岩手県', addr: '大船渡市大船渡町',    isArea: false, scale: 55 },
      { pref: '岩手県', addr: '宮古市鍬ヶ崎',       isArea: false, scale: 55 },
      { pref: '福島県', addr: '福島市花園町',        isArea: false, scale: 55 },
      { pref: '茨城県', addr: '水戸市金町',          isArea: false, scale: 50 },
      { pref: '栃木県', addr: '日光市瀬川',          isArea: false, scale: 45 },
      { pref: '埼玉県', addr: '熊谷市桜町',          isArea: false, scale: 30 },
    ],
  }
}

function createTestEEWWarning(eventId?: string, serial = 1): EEWAlert {
  const now = new Date()
  const eid = eventId ?? `test-warn-${Date.now()}`
  return {
    code: 556,
    id: `test-eew-warn-${Date.now()}`,
    time: now.toISOString(),
    test: false,
    earthquake: {
      originTime: now.toISOString(),
      arrivalTime: new Date(now.getTime() + 20000).toISOString(),
      condition: '以上',
      hypocenter: { name: '茨城県沖', latitude: 36.1, longitude: 141.3, depth: 40, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: eid, serial: String(serial), time: now.toISOString() },
    areas: [
      { pref: '茨城県', name: '茨城県北部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: null },
      { pref: '茨城県', name: '茨城県南部', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: null },
      { pref: '栃木県', name: '栃木県南部', scaleFrom: 35, scaleTo: 40, kindCode: '10', arrivalTime: null },
    ],
  }
}

function createTestEEWForecast(eventId?: string, serial = 1): EEWAlert {
  const now = new Date()
  const eid = eventId ?? `test-forecast-${Date.now()}`
  return {
    code: 556,
    id: `test-eew-forecast-${Date.now()}`,
    time: now.toISOString(),
    test: false,
    earthquake: {
      originTime: now.toISOString(),
      arrivalTime: new Date(now.getTime() + 20000).toISOString(),
      condition: '以上',
      hypocenter: { name: '宮城県沖', latitude: 38.3, longitude: 141.8, depth: 60, magnitude: 4.5 },
    },
    severity: 'Forecast',
    cancelled: false,
    issue: { eventId: eid, serial: String(serial), time: now.toISOString() },
    areas: [
      { pref: '宮城県', name: '宮城県北部', scaleFrom: 20, scaleTo: 25, kindCode: '10', arrivalTime: null },
      { pref: '宮城県', name: '宮城県中部', scaleFrom: 15, scaleTo: 20, kindCode: '10', arrivalTime: null },
    ],
  }
}

function createTestEEW(eventId?: string, serial = 1): EEWAlert {
  const now = new Date()
  const eid = eventId ?? `test-${Date.now()}`
  return {
    code: 556,
    id: `test-eew-${Date.now()}`,
    time: now.toISOString(),
    test: false,
    earthquake: {
      originTime: now.toISOString(),
      arrivalTime: new Date(now.getTime() + 20000).toISOString(),
      condition: '以上',
      // 2011年東北地方太平洋沖地震を参考にしたパラメータ（EEW初報はM7.2前後だった）
      hypocenter: { name: '三陸沖', latitude: 38.1, longitude: 142.9, depth: 24, magnitude: 7.2 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: eid, serial: String(serial), time: now.toISOString() },
    // 実データに合わせ areas を使用（参照は utils/eew.ts の eewAreas() で吸収）
    areas: [
      { pref: '宮城県', name: '宮城県北部', scaleFrom: 55, scaleTo: 60, kindCode: '10', arrivalTime: null },
      { pref: '宮城県', name: '宮城県中部', scaleFrom: 50, scaleTo: 55, kindCode: '10', arrivalTime: null },
      { pref: '岩手県', name: '岩手県沿岸南部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: null },
      { pref: '福島県', name: '福島県浜通り', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: null },
      { pref: '茨城県', name: '茨城県北部', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: null },
    ],
  }
}

function createTestTsunamiWatch(): JMATsunami {
  const now = new Date().toISOString()
  return {
    code: 552,
    id: `test-tsunami-watch-${Date.now()}`,
    time: now,
    cancelled: false,
    issue: { source: 'テスト', time: now, type: 'Focus' },
    areas: [
      { grade: 'Watch', immediate: false, name: '北海道太平洋沿岸東部', maxHeight: { description: '1m', value: 1.0 } },
      { grade: 'Watch', immediate: false, name: '北海道太平洋沿岸中部', maxHeight: { description: '1m', value: 1.0 } },
    ],
  }
}

function createTestTsunami(): JMATsunami {
  const now = new Date().toISOString()
  return {
    code: 552,
    id: `test-tsunami-${Date.now()}`,
    time: now,
    cancelled: false,
    issue: { source: 'テスト', time: now, type: 'Focus' },
    // name は地図の海岸線表示用に、津波予報区データ（tsunami-zones.json）に実在する区域名を使用する
    // 2011年東北地方太平洋沖地震を参考にした発令内容
    areas: [
      { grade: 'MajorWarning', immediate: true,  name: '岩手県',           maxHeight: { description: '10m以上', value: 10.0 } },
      { grade: 'MajorWarning', immediate: true,  name: '宮城県',           maxHeight: { description: '10m以上', value: 10.0 } },
      { grade: 'MajorWarning', immediate: true,  name: '福島県',           maxHeight: { description: '6m',     value: 6.0  } },
      { grade: 'Warning',      immediate: false, name: '青森県太平洋沿岸', maxHeight: { description: '3m',     value: 3.0  } },
      { grade: 'Warning',      immediate: false, name: '茨城県',           maxHeight: { description: '3m',     value: 3.0  } },
      { grade: 'Watch',        immediate: false, name: '北海道太平洋沿岸東部', maxHeight: { description: '1m', value: 1.0  } },
    ],
  }
}

export interface EarthquakeState {
  earthquakes: JMAQuake[]
  tsunamis: JMATsunami[]
  activeEEWs: ReadonlyMap<string, EEWAlert>
  connectionStatus: ConnectionStatus
  lastUpdate: Date | null
  isLoading: boolean
  error: string | null
}

export function useEarthquakes(onLiveEvent?: (event: P2PQuakeEvent) => void) {
  const [state, setState] = useState<EarthquakeState>({
    earthquakes: [],
    tsunamis: [],
    activeEEWs: new Map(),
    connectionStatus: 'connecting',
    lastUpdate: null,
    isLoading: true,
    error: null,
  })

  const wsRef = useRef<P2PQuakeWebSocket | null>(null)
  // 最新のコールバックを ref で保持し、handleEvent を安定させる
  const onLiveEventRef = useRef(onLiveEvent)
  onLiveEventRef.current = onLiveEvent
  // テスト EEW の発報状態を種別ごとに独立管理（複数EEW同時テスト対応）
  type TestEEWEntry = { eventId: string; serial: number; cancelTimer: number }
  const testEEWTimersRef = useRef<Map<'special' | 'warning' | 'forecast', TestEEWEntry>>(new Map())
  // 現在の state を WS コールバック内から参照するための ref
  const stateRef = useRef(state)
  stateRef.current = state

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
          ].slice(0, 30)
          return { ...prev, earthquakes, lastUpdate: now }
        }
        case 552: {
          const tsunami = event as JMATsunami
          if (tsunami.cancelled) {
            return {
              ...prev,
              tsunamis: prev.tsunamis.filter(t => t.id !== tsunami.id),
              lastUpdate: now,
            }
          }
          const tsunamis = [tsunami, ...prev.tsunamis.filter(t => t.id !== tsunami.id)]
          return { ...prev, tsunamis, lastUpdate: now }
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

    fetchHistory([551, 552], 20)
      .then(events => {
        if (cancelled) return
        const seenQuakes = new Map<string, JMAQuake>()
        for (const q of events.filter(e => e.code === 551) as JMAQuake[]) {
          const key = q.earthquake.time
          const existing = seenQuakes.get(key)
          if (!existing || (ISSUE_PRIORITY[q.issue.type] ?? 0) > (ISSUE_PRIORITY[existing.issue.type] ?? 0)) {
            seenQuakes.set(key, q)
          }
        }
        const earthquakes = Array.from(seenQuakes.values()).slice(0, 30)
        const tsunamis = (events.filter(e => e.code === 552) as JMATsunami[]).filter(
          t => !t.cancelled,
        )
        setState(prev => ({
          ...prev,
          earthquakes,
          tsunamis,
          lastUpdate: new Date(),
          isLoading: false,
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
  }, [handleEvent])

  const simulateEarthquake = useCallback(() => {
    handleEvent(createTestEarthquake())
  }, [handleEvent])

  const simulateEEW = useCallback(() => {
    const prev = testEEWTimersRef.current.get('special')
    const isContinuation = prev !== undefined
    const eventId = isContinuation ? prev.eventId : `test-${Date.now()}`
    const serial = isContinuation ? prev.serial + 1 : 1
    if (prev) window.clearTimeout(prev.cancelTimer)

    const eew = createTestEEW(eventId, serial)
    handleEvent(eew)

    const cancelTimer = window.setTimeout(() => {
      handleEvent({ ...eew, cancelled: true })
      testEEWTimersRef.current.delete('special')
    }, 30000)
    testEEWTimersRef.current.set('special', { eventId, serial, cancelTimer })
  }, [handleEvent])

  const simulateEEWWarning = useCallback(() => {
    const prev = testEEWTimersRef.current.get('warning')
    const isContinuation = prev !== undefined
    const eventId = isContinuation ? prev.eventId : `test-warn-${Date.now()}`
    const serial = isContinuation ? prev.serial + 1 : 1
    if (prev) window.clearTimeout(prev.cancelTimer)

    const eew = createTestEEWWarning(eventId, serial)
    handleEvent(eew)

    const cancelTimer = window.setTimeout(() => {
      handleEvent({ ...eew, cancelled: true })
      testEEWTimersRef.current.delete('warning')
    }, 30000)
    testEEWTimersRef.current.set('warning', { eventId, serial, cancelTimer })
  }, [handleEvent])

  const simulateEEWForecast = useCallback(() => {
    const prev = testEEWTimersRef.current.get('forecast')
    const isContinuation = prev !== undefined
    const eventId = isContinuation ? prev.eventId : `test-forecast-${Date.now()}`
    const serial = isContinuation ? prev.serial + 1 : 1
    if (prev) window.clearTimeout(prev.cancelTimer)

    const eew = createTestEEWForecast(eventId, serial)
    handleEvent(eew)

    const cancelTimer = window.setTimeout(() => {
      handleEvent({ ...eew, cancelled: true })
      testEEWTimersRef.current.delete('forecast')
    }, 30000)
    testEEWTimersRef.current.set('forecast', { eventId, serial, cancelTimer })
  }, [handleEvent])

  const simulateTsunami = useCallback(() => {
    const tsunami = createTestTsunami()
    handleEvent(tsunami)
    setTimeout(() => handleEvent({ ...tsunami, cancelled: true }), 15000)
  }, [handleEvent])

  const simulateTsunamiWatch = useCallback(() => {
    const tsunami = createTestTsunamiWatch()
    handleEvent(tsunami)
    setTimeout(() => handleEvent({ ...tsunami, cancelled: true }), 10000)
  }, [handleEvent])

  return {
    ...state,
    injectEvent: handleEvent,
    simulateEarthquake,
    simulateEEW, simulateEEWWarning, simulateEEWForecast,
    simulateTsunami, simulateTsunamiWatch,
  }
}
