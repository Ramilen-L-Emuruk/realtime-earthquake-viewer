import { useState, useEffect, useRef, useCallback } from 'react'
import type { JMAQuake, JMATsunami, EEWAlert, P2PQuakeEvent, ConnectionStatus } from '../types/earthquake'
import { fetchHistory, P2PQuakeWebSocket } from '../services/p2pquake'

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

  return state
}
