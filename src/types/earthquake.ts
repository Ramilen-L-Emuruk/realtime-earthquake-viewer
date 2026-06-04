export type IntensityScale = -1 | 10 | 20 | 30 | 40 | 45 | 50 | 55 | 60 | 70

export interface Hypocenter {
  name: string
  latitude: number
  longitude: number
  depth: number
  magnitude: number
}

export interface EarthquakePoint {
  pref: string
  addr: string
  isArea: boolean
  scale: IntensityScale
}

export type IssueType =
  | 'ScalePrompt'
  | 'Destination'
  | 'ScaleAndDestination'
  | 'DetailScale'
  | 'Foreign'
  | 'Other'

export type CorrectType =
  | 'None'
  | 'Unknown'
  | 'ScaleOnly'
  | 'DestinationOnly'
  | 'ScaleAndDestination'

export type DomesticTsunami =
  | 'None'
  | 'Unknown'
  | 'Checking'
  | 'NonEffective'
  | 'Watch'
  | 'Warning'

export interface JMAQuake {
  code: 551
  id: string
  time: string
  issue: {
    source: string
    time: string
    type: IssueType
    correct: CorrectType
  }
  earthquake: {
    time: string
    hypocenter: Hypocenter
    maxScale: IntensityScale
    domesticTsunami: DomesticTsunami
    foreignTsunami: string
  }
  points: EarthquakePoint[]
}

export type TsunamiGrade = 'MajorWarning' | 'Warning' | 'Watch' | 'Unknown'

export interface TsunamiArea {
  grade: TsunamiGrade
  immediate: boolean
  name: string
  firstHeight?: {
    arrivalTime?: string
    condition: string
  }
  maxHeight?: {
    description: string
    value: number
  }
}

export interface JMATsunami {
  code: 552
  id: string
  time: string
  cancelled: boolean
  issue: {
    source: string
    time: string
    type: 'Focus'
  }
  areas: TsunamiArea[]
}

export interface EarthquakeDetection {
  code: 554
  id: string
  time: string
  area: string
  scale: number
}

export interface EEWRegion {
  pref: string
  name: string
  scaleFrom: number
  scaleTo: number
  kindCode: string
  arrivalTime: string | null
}

export interface EEWAlert {
  code: 556
  id: string
  time: string
  test: boolean
  earthquake: {
    originTime: string
    arrivalTime: string
    condition: string
    hypocenter: Hypocenter
  }
  severity: 'Unknown' | 'Forecast' | 'Warning'
  cancelled: boolean
  regions: EEWRegion[]
}

export type P2PQuakeEvent = JMAQuake | JMATsunami | EarthquakeDetection | EEWAlert

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'
