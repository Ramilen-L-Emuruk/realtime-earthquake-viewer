import type { JMAQuake, JMATsunami, EEWAlert } from './earthquake'

export type ReplayEventType = 'eew' | 'quake' | 'tsunami'

export interface ReplayEvent {
  time: Date
  type: ReplayEventType
  data: EEWAlert | JMAQuake | JMATsunami
}

export type ReplayStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused'

export interface KnetChannel {
  direction: string        // 'N-S' | 'E-W' | 'U-D'
  samplingHz: number
  recordTime: Date         // ローカル時刻（JST）
  durationSec: number
  maxAccGal: number
  scaleGalPerUnit: number  // = numerator / denominator
  data: number[]           // 加速度値 (gal)
}

export interface KnetRecord {
  originTime: Date
  lat: number
  lng: number
  depthKm: number
  magnitude: number
  stationCode: string
  stationLat: number
  stationLng: number
  stationHeightM: number
  channels: KnetChannel[]
}

export interface ReplaySession {
  quake: JMAQuake | null   // null = K-NET のみ（P2PQuake データなし）
  events: ReplayEvent[]
  startTime: Date
  endTime: Date
  knet?: KnetRecord        // K-NET ファイルから構築した場合のみ
}

export const REPLAY_SPEEDS = [1, 2, 5, 10, 30, 60] as const
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number]
