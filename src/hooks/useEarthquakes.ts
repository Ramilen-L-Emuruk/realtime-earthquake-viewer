import { useState, useEffect, useRef, useCallback } from 'react'
import type { JMAQuake, JMATsunami, EEWAlert, P2PQuakeEvent, ConnectionStatus } from '../types/earthquake'
import { fetchHistory, P2PQuakeWebSocket } from '../services/p2pquake'

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
      hypocenter: { name: '東京都内陸部（テスト）', latitude: 35.68, longitude: 139.69, depth: 20, magnitude: 5.5 },
      maxScale: 40,
      domesticTsunami: 'None',
      foreignTsunami: 'None',
    },
    // addr は地図の震度マーカー表示用に、座標テーブル（public/data/station-coords.json）に
    // 実在する観測点名を使用する。市区町村名のままだと座標が引けずマーカーが出ない。
    points: [
      { pref: '東京都', addr: '東京千代田区大手町', isArea: false, scale: 40 },
      { pref: '東京都', addr: '東京新宿区西新宿', isArea: false, scale: 30 },
      { pref: '神奈川県', addr: '横浜鶴見区鶴見', isArea: false, scale: 30 },
      { pref: '埼玉県', addr: '熊谷市桜町', isArea: false, scale: 20 },
      { pref: '千葉県', addr: '銚子市川口町', isArea: false, scale: 20 },
    ],
  }
}

function createTestEEW(): EEWAlert {
  const now = new Date()
  return {
    code: 556,
    id: `test-eew-${Date.now()}`,
    time: now.toISOString(),
    test: false,
    earthquake: {
      originTime: now.toISOString(),
      arrivalTime: new Date(now.getTime() + 20000).toISOString(),
      condition: '以上',
      hypocenter: { name: '東京都内陸部（テスト）', latitude: 35.68, longitude: 139.69, depth: 20, magnitude: 5.5 },
    },
    severity: 'Warning',
    cancelled: false,
    regions: [
      { pref: '東京都', name: '東京都区部', scaleFrom: 40, scaleTo: 40, kindCode: '10', arrivalTime: null },
      { pref: '神奈川県', name: '神奈川県東部', scaleFrom: 30, scaleTo: 40, kindCode: '10', arrivalTime: null },
      { pref: '埼玉県', name: '埼玉県南部', scaleFrom: 30, scaleTo: 30, kindCode: '10', arrivalTime: null },
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
    areas: [
      { grade: 'Warning', immediate: false, name: '千葉県九十九里・外房', maxHeight: { description: '3m', value: 3.0 } },
      { grade: 'Watch', immediate: false, name: '相模湾・三浦半島', maxHeight: { description: '1m', value: 1.0 } },
      { grade: 'Watch', immediate: false, name: '伊豆諸島', maxHeight: { description: '0.5m', value: 0.5 } },
    ],
  }
}

export interface EarthquakeState {
  earthquakes: JMAQuake[]
  tsunamis: JMATsunami[]
  activeEEW: EEWAlert | null
  connectionStatus: ConnectionStatus
  lastUpdate: Date | null
  isLoading: boolean
  error: string | null
}

export function useEarthquakes() {
  const [state, setState] = useState<EarthquakeState>({
    earthquakes: [],
    tsunamis: [],
    activeEEW: null,
    connectionStatus: 'connecting',
    lastUpdate: null,
    isLoading: true,
    error: null,
  })

  const wsRef = useRef<P2PQuakeWebSocket | null>(null)

  const handleEvent = useCallback((event: P2PQuakeEvent) => {
    setState(prev => {
      const now = new Date()
      switch (event.code) {
        case 551: {
          const quake = event as JMAQuake
          const earthquakes = [
            quake,
            ...prev.earthquakes.filter(e => e.id !== quake.id),
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
          if (eew.cancelled || eew.test) {
            return { ...prev, activeEEW: null, lastUpdate: now }
          }
          return { ...prev, activeEEW: eew, lastUpdate: now }
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
        const earthquakes = (events.filter(e => e.code === 551) as JMAQuake[]).slice(0, 30)
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
    ws.onEvent = handleEvent
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
    const eew = createTestEEW()
    handleEvent(eew)
    setTimeout(() => handleEvent({ ...eew, cancelled: true }), 10000)
  }, [handleEvent])

  const simulateTsunami = useCallback(() => {
    const tsunami = createTestTsunami()
    handleEvent(tsunami)
    setTimeout(() => handleEvent({ ...tsunami, cancelled: true }), 15000)
  }, [handleEvent])

  return { ...state, simulateEarthquake, simulateEEW, simulateTsunami }
}
