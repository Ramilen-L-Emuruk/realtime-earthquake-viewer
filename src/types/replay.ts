import type { JMAQuake, JMATsunami, EEWAlert } from './earthquake'

export type ReplayEventType = 'eew' | 'quake' | 'tsunami'

export interface ReplayEvent {
  time: Date
  type: ReplayEventType
  data: EEWAlert | JMAQuake | JMATsunami
}

export type ReplayStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused'

export interface ReplaySession {
  quake: JMAQuake
  events: ReplayEvent[]
  startTime: Date
  endTime: Date
}

export const REPLAY_SPEEDS = [1, 2, 5, 10, 30, 60] as const
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number]
