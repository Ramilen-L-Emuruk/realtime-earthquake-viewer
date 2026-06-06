import { useState, useRef, useCallback, useEffect } from 'react'
import type { JMAQuake, JMATsunami, EEWAlert } from '../types/earthquake'
import type { ReplaySession, ReplayStatus, ReplaySpeed } from '../types/replay'

export interface ReplayState {
  status: ReplayStatus
  session: ReplaySession | null
  currentTime: Date | null
  speed: ReplaySpeed
  view: 'select' | 'player'
  // 現在時刻までに発生済みのイベント（地図・パネル表示に使う）
  activeQuake: JMAQuake | null
  activeEEW: EEWAlert | null
  activeTsunamis: JMATsunami[]
}

const TICK_MS = 100

export function useReplay() {
  // React の状態更新より先に参照できるよう ref で即時管理する。
  // WebSocket コールバックが setState の確定を待たずに古い値を見るレースを防ぐ。
  const isPlayerRef = useRef(false)

  const [state, setState] = useState<ReplayState>({
    status: 'idle',
    session: null,
    currentTime: null,
    speed: 10,
    view: 'select',
    activeQuake: null,
    activeEEW: null,
    activeTsunamis: [],
  })

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const computeActive = useCallback((session: ReplaySession, currentTime: Date) => {
    let activeQuake: JMAQuake | null = null
    let activeEEW: EEWAlert | null = null
    const activeTsunamis: JMATsunami[] = []

    for (const event of session.events) {
      if (event.time > currentTime) break
      if (event.type === 'quake') activeQuake = event.data as JMAQuake
      else if (event.type === 'eew') {
        const eew = event.data as EEWAlert
        activeEEW = eew.cancelled ? null : eew
      } else if (event.type === 'tsunami') {
        const tsunami = event.data as JMATsunami
        if (tsunami.cancelled) {
          const id = tsunami.id
          const idx = activeTsunamis.findIndex(t => t.id === id)
          if (idx >= 0) activeTsunamis.splice(idx, 1)
        } else {
          activeTsunamis.push(tsunami)
        }
      }
    }
    return { activeQuake, activeEEW, activeTsunamis }
  }, [])

  const tick = useCallback(() => {
    setState(prev => {
      if (!prev.session || prev.status !== 'playing') return prev
      const advanceMs = TICK_MS * prev.speed
      const next = new Date(prev.currentTime!.getTime() + advanceMs)
      if (next >= prev.session.endTime) {
        stopTimer()
        const ct = prev.session.endTime
        return {
          ...prev,
          status: 'paused',
          currentTime: ct,
          ...computeActive(prev.session, ct),
        }
      }
      return { ...prev, currentTime: next, ...computeActive(prev.session, next) }
    })
  }, [stopTimer, computeActive])

  const loadSession = useCallback((session: ReplaySession) => {
    isPlayerRef.current = true
    stopTimer()
    const currentTime = session.startTime
    setState(prev => ({
      ...prev,
      status: 'ready',
      view: 'player',
      session,
      currentTime,
      activeQuake: null,
      activeEEW: null,
      activeTsunamis: [],
    }))
  }, [stopTimer])

  const play = useCallback(() => {
    setState(prev => {
      if (!prev.session || (prev.status !== 'ready' && prev.status !== 'paused')) return prev
      return { ...prev, status: 'playing' }
    })
  }, [])

  const pause = useCallback(() => {
    stopTimer()
    setState(prev => prev.status === 'playing' ? { ...prev, status: 'paused' } : prev)
  }, [stopTimer])

  const seek = useCallback((time: Date) => {
    setState(prev => {
      if (!prev.session) return prev
      const clamped = new Date(
        Math.max(prev.session.startTime.getTime(),
          Math.min(prev.session.endTime.getTime(), time.getTime()))
      )
      return {
        ...prev,
        currentTime: clamped,
        ...computeActive(prev.session, clamped),
      }
    })
  }, [computeActive])

  const setSpeed = useCallback((speed: ReplaySpeed) => {
    setState(prev => ({ ...prev, speed }))
  }, [])

  const reset = useCallback(() => {
    stopTimer()
    setState(prev => {
      if (!prev.session) return prev
      return {
        ...prev,
        status: 'ready',
        currentTime: prev.session.startTime,
        activeQuake: null,
        activeEEW: null,
        activeTsunamis: [],
      }
    })
  }, [stopTimer])

  const backToSelect = useCallback(() => {
    isPlayerRef.current = false
    stopTimer()
    setState(prev => ({
      ...prev,
      status: 'idle',
      view: 'select',
      session: null,
      currentTime: null,
      activeQuake: null,
      activeEEW: null,
      activeTsunamis: [],
    }))
  }, [stopTimer])

  // playing 状態になったらタイマー開始
  useEffect(() => {
    if (state.status === 'playing' && timerRef.current === null) {
      timerRef.current = setInterval(tick, TICK_MS)
    } else if (state.status !== 'playing') {
      stopTimer()
    }
    return () => {}
  }, [state.status, tick, stopTimer])

  // アンマウント時クリーンアップ
  useEffect(() => () => stopTimer(), [stopTimer])

  return { ...state, isPlayerRef, loadSession, play, pause, seek, setSpeed, reset, backToSelect }
}
