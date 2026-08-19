export type IntensityScale = -1 | 10 | 20 | 30 | 40 | 45 | 50 | 55 | 60 | 70

/** 長周期地震動階級（1〜4）。階級 4 以上は EEW 特別警報の条件になる。 */
export type LpgmClass = 1 | 2 | 3 | 4

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
  | '震度速報'
  | '震源情報'
  | '震源・震度情報'
  | '各地の震度情報'
  | '顕著な地震の震源要素更新のお知らせ'
  | '遠地地震'
  | 'その他'

export type CorrectType =
  | 'なし'
  | '訂正'
  | '震度のみ訂正'
  | '震源を訂正'
  | '震度・震源を訂正'

export type DomesticTsunami =
  | 'なし'
  | '不明'
  | '調査中'
  | '海面変動の可能性'
  | '若干の海面変動'
  | '注意報'
  | '警報等'

export interface JMAQuake {
  kind: 'quake'
  id: string
  eventId?: string
  time: string
  cancelled?: boolean
  cancelledAt?: Date
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
  }
  points: EarthquakePoint[]
  /**
   * 同一地震を貫いて変わらない内部キー。統合・選択・通知の同一性判定はすべてこれで行う。
   * `mergeQuakeInto` が統合のたびに既存カードの値を引き継ぐため、続報で `id` が変わっても不変。
   * DMDATA 経路は電文が共有する eventId、P2PQuake 経路は eventId が配信されないため
   * 最初に受信した報から生成する（生成規則は `utils/quakeMerge.ts` の `quakeEventKey`）。
   * 統合前の生電文には存在しないため optional。
   */
  eventKey?: string
  /**
   * 気象庁の付加文（津波に関する固定付加文）の原文。DMDATA 経路でのみ得られる。
   * 遠地地震は付加文コードが 021x 系だけでは表現しきれない（022x/023x 系を併用する）ため、
   * domesticTsunami への丸め込みで意味が落ちる。原文を読み上げに使う用途で保持する。
   * P2PQuake 経路は付加文を配信しないため undefined。
   */
  forecastText?: string
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
  code?: string
  firstHeight?: {
    arrivalTime?: string
    condition: string
  }
  maxHeight?: {
    description: string
    // 数値表現[m]。「巨大」「高い」のように数値化されない予想波高では欠落する
    // （P2PQuake の仕様どおりの挙動。表示・読み上げはいずれも description しか見ない）。
    value?: number
  }
  stations?: TsunamiStation[]
}

export interface TsunamiObservation {
  name: string
  height?: {
    value: number
    description: string
    over?: boolean
  }
  arrivalTime?: string
  initial?: string  // 引き波 | 押し波
  // 観測点が属する津波予報区（districtCode）。forecasts[].code と一致させて area 行に紐づける。
  // VTSE52（沖合観測単独電文）は区域を持たないため undefined になる。
  districtCode?: string
  districtName?: string
}

export interface JMATsunami {
  kind: 'tsunami'
  id: string
  eventId?: string
  time: string
  cancelled: boolean
  // cancelled=true のときの解除理由。'lifted'=気象庁の正式解除（区域が電文から消える）、
  // 'retracted'=誤って発表した電文の取消（InfoType=取消）、'expired'=ValidDateTime満了によりアプリが自動検出。
  cancelReason?: 'lifted' | 'retracted' | 'expired'
  cancelledAt?: Date
  headline?: string
  // 付加文（固定文）。避難行動の呼びかけなど JMA 公式の定型文。長文の解説（FreeFormComment）は含まない。
  warningComment?: string
  // この津波を引き起こした地震（Earthquake 要素）。震源名・マグニチュード・発生時刻。
  sourceEarthquake?: {
    hypocenterName: string
    magnitude?: number
    originTime?: string
  }
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

export interface EEWRegion {
  pref: string
  name: string
  /** 予想震度の下限。震度未確定は -1（`EarthquakePoint.scale` と同じセンチネル） */
  scaleFrom: IntensityScale
  /** 予想震度の上限。地域別の最大予想震度として `eewMaxScale()` が参照する */
  scaleTo: IntensityScale
  kindCode: string
  arrivalTime: string | null
  lgIntTo?: LpgmClass  // 地域別予想長周期地震動階級。電文に含まれない場合は undefined
}

export interface EEWAlert {
  kind: 'eew'
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
  cancelledAt?: Date
  // issue.serial = 情報番号（第N報）
  issue?: {
    eventId?: string
    serial?: string
    time?: string
  }
  // DMDSS パーサーは `areas` を使う。旧形式との互換のため `regions` も保持する。
  // 参照時は utils/eew.ts の eewAreas() で吸収する。
  areas?: EEWRegion[]
  regions?: EEWRegion[]
  // Yahoo 強震モニタ由来の calcintensity から変換した最大予想震度。
  // areas が空の場合のフォールバックとして eewMaxScale() が使用する。
  forecastMaxScale?: IntensityScale
  // DMDATA EEW 電文 body.intensity.forecastMaxLpgmInt から取得した推定最大長周期地震動階級（1〜4）。
  forecastMaxLpgmClass?: LpgmClass
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

export type AppEvent = JMAQuake | JMATsunami | EEWAlert

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

/**
 * データ受信の状態。
 *
 * `replay` は「テスト時刻設定（強震モニタ）で過去を再生しているため、ライブ受信を意図的に止めている」
 * 状態。`disconnected`（＝繋がるべきなのに繋がっていない）と区別する必要がある——混ぜると地図に
 * 切断警告が出てしまうし、逆に更新しないままにすると直前の値（多くは `connected`）が残って
 * 「受信していないのに接続中」と表示され続ける。
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'replay'

export interface TelegramLogEntry {
  id: string
  receivedAt: Date
  source: 'dmdss' | 'p2pquake'
  headType: string
  isTest: boolean
  status: 'parsed' | 'filtered' | 'error'
  kind?: 'eew' | 'quake' | 'tsunami' | 'lpgm' | 'nankai' | 'kohatsu'
  rawHead?: unknown
  rawBody: unknown
  errorMessage?: string
}
