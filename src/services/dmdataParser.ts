// DMDATA.JP の formatMode:"json" 電文を内部型に変換する。
// 各 parse* 関数は null を返すことがある（必須フィールド欠損時）。

import type {
  JMAQuake,
  JMATsunami,
  EEWAlert,
  IntensityScale,
  DomesticTsunami,
  IssueType,
  CorrectType,
  TsunamiArea,
  TsunamiGrade,
} from '../types/earthquake'

// EEW: "1","2","3","4","5-","5+","6-","6+","7","不明" 等
// 地震情報: "1","2","3","4","5弱","5強","6弱","6強","7","不明" 等
function parseIntensityStr(s: string | undefined | null): IntensityScale {
  if (!s) return -1
  const map: Record<string, IntensityScale> = {
    '1': 10, '2': 20, '3': 30, '4': 40,
    '5-': 45, '5弱': 45,
    '5+': 50, '5強': 50,
    '6-': 55, '6弱': 55,
    '6+': 60, '6強': 60,
    '7': 70,
  }
  return map[s] ?? -1
}

function parseNum(v: unknown): number {
  if (v === null || v === undefined) return NaN
  return Number(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function obj(v: unknown): Record<string, unknown> {
  return (typeof v === 'object' && v !== null && !Array.isArray(v))
    ? (v as Record<string, unknown>)
    : {}
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

// DMDATA の震源座標から緯度・経度・深さを取得する。
// coordinate.height.value は mm 単位の負値（海面下が負）。
// depth.value は km 単位の文字列の場合もある。
function parseHypocenterCoord(hypo: Record<string, unknown>): {
  lat: number; lng: number; depth: number
} {
  const coord = obj(hypo.coordinate)
  const lat = parseNum(obj(coord.latitude).value)
  const lng = parseNum(obj(coord.longitude).value)
  const depthKm = parseNum(obj(hypo.depth).value)
  const heightMm = parseNum(obj(coord.height).value)
  // depth.value が km の数値として取れればそれを優先
  const depth = Number.isFinite(depthKm) && depthKm >= 0
    ? depthKm
    : Number.isFinite(heightMm)
      ? Math.abs(heightMm) / 1000
      : -1
  return { lat, lng, depth }
}

// EEW (VXSE45: 予報, VXSE47: 警報)
// data は WebSocket body を JSON.parse した後のオブジェクト（トップレベル電文）
export function parseEEW(headType: string, data: Record<string, unknown>): EEWAlert | null {
  const body = obj(data.body)
  const earthquake = obj(body.earthquake)
  const hypo = obj(earthquake.hypocenter)
  const { lat, lng, depth } = parseHypocenterCoord(hypo)
  const isCanceled = body.isCanceled === true
  const eventId = str(data.eventId)
  const serial = str(data.serialNo ?? data.serial ?? '1')
  const reportTime = str(data.reportDateTime ?? data.pressDateTime ?? data.reportTime)

  if (!isCanceled && (!Number.isFinite(lat) || !Number.isFinite(lng))) return null

  const intensity = obj(body.intensity)
  const forecastMaxInt = obj(intensity.forecastMaxInt)
  // to がより厳しい上限値。取れない場合は from を使う
  const forecastScale = parseIntensityStr(str(forecastMaxInt.to) || str(forecastMaxInt.from))

  return {
    code: 556,
    id: `dmdata-eew-${eventId}-${serial}`,
    time: reportTime,
    test: false,
    earthquake: {
      originTime: str(earthquake.originTime),
      arrivalTime: str(earthquake.arrivalTime),
      condition: str(earthquake.condition),
      hypocenter: {
        name: str(hypo.name),
        latitude: isCanceled ? 0 : lat,
        longitude: isCanceled ? 0 : lng,
        depth,
        magnitude: parseNum(obj(hypo.magnitude).value),
      },
    },
    severity: (headType === 'VXSE47' || body.isWarning === true) ? 'Warning' : 'Forecast',
    cancelled: isCanceled,
    isFinal: body.isLastInfo === true,
    forecastMaxScale: (!isCanceled && forecastScale >= 0) ? forecastScale as IntensityScale : undefined,
    issue: { eventId, serial, time: reportTime },
    areas: [],
  }
}

const VXSE_ISSUE_TYPE: Record<string, IssueType> = {
  VXSE51: 'ScalePrompt',
  VXSE52: 'ScaleAndDestination',
  VXSE53: 'DetailScale',
}

// 地震情報 (VXSE51/52/53)
export function parseEarthquake(headType: string, data: Record<string, unknown>): JMAQuake | null {
  const body = obj(data.body)
  const earthquake = obj(body.earthquake)
  const hypo = obj(earthquake.hypocenter)
  const { lat, lng, depth } = parseHypocenterCoord(hypo)

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  const maxIntStr = str(earthquake.maxInt) || str(body.maxInt)
  const maxScale = parseIntensityStr(maxIntStr || null)
  const domestic = str(earthquake.domesticTsunami) as DomesticTsunami || 'Unknown'

  return {
    code: 551,
    id: `dmdata-quake-${str(data.eventId)}-${str(data.serialNo ?? data.serial ?? '1')}`,
    time: str(data.reportDateTime ?? data.pressDateTime),
    issue: {
      source: str(data.editorialOffice ?? data.publishingOffice),
      time: str(data.reportDateTime ?? data.pressDateTime),
      type: VXSE_ISSUE_TYPE[headType] ?? 'ScaleAndDestination',
      correct: 'None' as CorrectType,
    },
    earthquake: {
      time: str(earthquake.originTime),
      hypocenter: {
        name: str(hypo.name),
        latitude: lat,
        longitude: lng,
        depth,
        magnitude: parseNum(obj(hypo.magnitude).value),
      },
      maxScale: maxScale >= 0 ? maxScale as IntensityScale : -1,
      domesticTsunami: domestic,
      foreignTsunami: str(earthquake.foreignTsunami),
    },
    points: [],
  }
}

function parseTsunamiGrade(kindName: string): TsunamiGrade {
  if (kindName.includes('大津波')) return 'MajorWarning'
  if (kindName.includes('津波警報')) return 'Warning'
  if (kindName.includes('注意報')) return 'Watch'
  return 'Unknown'
}

// 津波情報 (VTSE41: 大津波警報特別、VTSE51: 警報・注意報、VTSE52: 解除)
export function parseTsunami(headType: string, data: Record<string, unknown>): JMATsunami | null {
  const cancelled = headType === 'VTSE52' || str(data.infoType) === '解除'
  const id = `dmdata-tsunami-${str(data.eventId)}-${str(data.serialNo ?? data.serial ?? '1')}`
  const time = str(data.reportDateTime ?? data.pressDateTime)
  const source = str(data.editorialOffice ?? data.publishingOffice)

  if (cancelled) {
    return { code: 552, id, time, cancelled: true, issue: { source, time, type: 'Focus' }, areas: [] }
  }

  const body = obj(data.body)
  const tsunami = obj(body.tsunami)
  const forecast = obj(tsunami.forecast)
  const items = arr(forecast.items)

  const areas: TsunamiArea[] = items.map(item => {
    const it = obj(item)
    const kind = obj(it.kind)
    const firstHeight = obj(it.firstHeight)
    const maxHeight = obj(it.maxHeight)
    const maxHeightVal = obj(maxHeight.value)
    return {
      grade: parseTsunamiGrade(str(kind.name)) as TsunamiGrade,
      immediate: firstHeight.condition === '直ちに津波来襲と予測',
      name: str(it.name),
      firstHeight: {
        arrivalTime: str(firstHeight.arrivalTime) || undefined,
        condition: str(firstHeight.condition),
      },
      maxHeight: maxHeightVal.value != null
        ? {
          description: str(maxHeightVal.text),
          value: parseNum(maxHeightVal.value) / 100,  // cm → m
        }
        : undefined,
    }
  })

  if (areas.length === 0) return null

  return { code: 552, id, time, cancelled: false, issue: { source, time, type: 'Focus' }, areas }
}
