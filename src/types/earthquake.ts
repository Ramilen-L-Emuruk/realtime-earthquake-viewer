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
  | 'DestinationAmended'
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

export type TsunamiGrade = 'MajorWarning' | 'Warning' | 'Watch' | 'Forecast' | 'Unknown'

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

export interface TsunamiObservation {
  name: string
  height?: {
    value: number
    description: string
  }
  arrivalTime?: string
  initial?: string  // 引き波 | 押し波
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
  observations?: TsunamiObservation[]
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
  isFinal?: boolean
  // issue.serial = 情報番号（第N報）
  issue?: {
    eventId?: string
    serial?: string
    time?: string
  }
  // P2PQuake v2 の実データは `areas`、テスト/旧データは `regions` を使う。
  // 参照時は utils/eew.ts の eewAreas() で吸収する。
  areas?: EEWRegion[]
  regions?: EEWRegion[]
  // Yahoo 強震モニタ由来の calcintensity から変換した最大予想震度。
  // areas が空の場合のフォールバックとして eewMaxScale() が使用する。
  forecastMaxScale?: IntensityScale
  // DMDATA EEW 電文 body.intensity.forecastMaxLpgmInt から取得した推定最大長周期地震動階級（1〜4）。
  forecastMaxLpgmClass?: number
}

export interface JMALpgm {
  id: string
  time: string
  originTime: string  // JMAQuake.earthquake.time と照合するキー
  maxClass: number    // 1〜4
  cancelled: boolean
}

export type P2PQuakeEvent = JMAQuake | JMATsunami | EarthquakeDetection | EEWAlert

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export interface TelegramLogEntry {
  id: string
  receivedAt: Date
  source: 'dmdss' | 'p2pquake'
  headType: string
  isTest: boolean
  status: 'parsed' | 'filtered' | 'error'
  kind?: 'eew' | 'quake' | 'tsunami' | 'lpgm' | 'detection'
  rawHead?: unknown
  rawBody: unknown
  errorMessage?: string
}
