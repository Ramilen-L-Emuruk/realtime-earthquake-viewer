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
  | 'SeaFloor'
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

export interface TsunamiStation {
  name: string
  code: string
  highTideDateTime?: string
  arrivalTime?: string
  arrivalCondition?: string
}

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
  stations?: TsunamiStation[]
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
  eventId?: string
  time: string
  cancelled: boolean
  headline?: string
  // 若干の海面変動など予報のみの場合、JMAは明示的なキャンセル電文を送らず
  // ValidDateTime の経過でのみ有効期限が示される。
  validDateTime?: string
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
  lgIntTo?: number  // 地域別予想長周期地震動階級（1〜4）。電文に含まれない場合は undefined
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
  expired?: boolean
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

export interface LpgmPoint {
  code: string      // 観測点コード（例: "0122401"）
  name: string      // 観測点名（例: "新千歳空港"）
  pref: string      // 都道府県名（XML由来は Pref/Name、JSON由来は空文字）
  lgInt: number     // 長周期地震動階級 1〜4
}

export interface LpgmRegion {
  code: string      // 一次細分区域コード（例: "102"）
  name: string      // 一次細分区域名（例: "石狩地方南部"）
  maxLgInt: number  // 区域内最大長周期地震動階級 1〜4
}

export interface JMALpgm {
  id: string
  eventId: string     // VXSE51/52/53/62 が共有する 14 桁タイムスタンプ。lpgmByEventId の Map キー
  time: string
  originTime: string  // TTS 読み上げテキスト用
  maxClass: number    // 1〜4
  cancelled: boolean
  points?: LpgmPoint[]    // 観測点別階級（取消電文では undefined）
  regions?: LpgmRegion[]  // 一次細分区域別最大階級
}

export type P2PQuakeEvent = JMAQuake | JMATsunami | EarthquakeDetection | EEWAlert

// 南海トラフ地震臨時情報 (VYSE50/51/52)
export interface JMANankai {
  id: string
  time: string
  eventId: string
  kindCode: string   // '0201'=調査中 '0202'=巨大地震注意 '0203'=巨大地震警戒 '0204'=調査終了
  kindName: string   // '調査中' | '巨大地震注意' | '巨大地震警戒' | '調査終了'
  headline: string
  body: string
  cancelled: boolean // kindName === '調査終了'
  reportDateTime: string
}

// 北海道・三陸沖後発地震注意情報 (VYSE60)
export interface JMAKohatsu {
  id: string
  time: string
  eventId: string
  headline: string
  body: string
  cancelled: boolean
  reportDateTime: string
  expireAt: string  // reportDateTime + 7日
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export interface TelegramLogEntry {
  id: string
  receivedAt: Date
  source: 'dmdss' | 'p2pquake'
  headType: string
  isTest: boolean
  status: 'parsed' | 'filtered' | 'error'
  kind?: 'eew' | 'quake' | 'tsunami' | 'lpgm' | 'detection' | 'nankai' | 'kohatsu'
  rawHead?: unknown
  rawBody: unknown
  errorMessage?: string
}
