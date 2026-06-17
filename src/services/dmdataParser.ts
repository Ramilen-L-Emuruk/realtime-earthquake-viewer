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
  VXSE52: 'Destination',
  VXSE53: 'ScaleAndDestination',
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

// XML ヘルパー: localName で最初の要素を返す
function xmlQ(parent: Element | Document, localName: string): Element | null {
  const els = parent.getElementsByTagName('*')
  for (let i = 0; i < els.length; i++) {
    if (els[i].localName === localName) return els[i]
  }
  return null
}

function xmlText(el: Element | null): string {
  return el?.textContent?.trim() ?? ''
}

// JMA XML 座標文字列（例: "+36.3+140.0-70000/"）→ lat/lng/depth(km)
function parseJmaCoord(s: string): { lat: number; lng: number; depth: number } {
  const m = s.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\//)
  if (!m) return { lat: NaN, lng: NaN, depth: -1 }
  const lat = parseFloat(m[1])
  const lng = parseFloat(m[2])
  // 高さフィールドは負値・メートル単位（海面下）
  const depth = m[3] != null ? Math.abs(parseFloat(m[3])) / 1000 : -1
  return { lat, lng, depth }
}

// REST API 経由の JMA XML（VXSE51/52/53）を JMAQuake にパース
export function parseEarthquakeFromXml(headType: string, xml: string): JMAQuake | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return null
  } catch { return null }

  const reportDateTime = xmlText(xmlQ(doc, 'ReportDateTime')) || xmlText(xmlQ(doc, 'DateTime'))
  const eventId = xmlText(xmlQ(doc, 'EventID'))
  const infoType = xmlText(xmlQ(doc, 'InfoType'))
  const serial = xmlText(xmlQ(doc, 'Serial')) || '1'

  const earthquakeEl = xmlQ(doc, 'Earthquake')
  if (!earthquakeEl) return null

  const originTime = xmlText(xmlQ(earthquakeEl, 'OriginTime'))
  const hypocenterEl = xmlQ(earthquakeEl, 'Hypocenter')
  const areaEl = hypocenterEl ? xmlQ(hypocenterEl, 'Area') : null
  const hypName = areaEl ? xmlText(xmlQ(areaEl, 'Name')) : ''
  const coordStr = areaEl ? xmlText(xmlQ(areaEl, 'Coordinate')) : ''
  const { lat, lng, depth } = parseJmaCoord(coordStr)

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  const magnitudeStr = xmlText(xmlQ(earthquakeEl, 'Magnitude'))
  const magnitude = parseFloat(magnitudeStr) || 0

  // MaxInt は Intensity > Observation 直下
  const obsEl = xmlQ(doc, 'Observation')
  const maxIntStr = obsEl ? xmlText(xmlQ(obsEl, 'MaxInt')) : ''
  const maxScale = parseIntensityStr(maxIntStr || null)

  // 各観測点（IntensityStation）は Pref 内にある
  const points: JMAQuake['points'] = []
  const allEls = doc.getElementsByTagName('*')
  const prefEls: Element[] = []
  for (let i = 0; i < allEls.length; i++) {
    if (allEls[i].localName === 'Pref') prefEls.push(allEls[i])
  }
  for (const prefEl of prefEls) {
    const prefName = xmlText(xmlQ(prefEl, 'Name'))
    const stEls = prefEl.getElementsByTagName('*')
    for (let i = 0; i < stEls.length; i++) {
      if (stEls[i].localName !== 'IntensityStation') continue
      const stEl = stEls[i]
      const stName = xmlText(xmlQ(stEl, 'Name'))
      const intStr = xmlText(xmlQ(stEl, 'Int'))
      const scale = parseIntensityStr(intStr || null)
      if (stName && scale >= 0) {
        points.push({ pref: prefName, addr: stName, isArea: false, scale: scale as IntensityScale })
      }
    }
  }

  const issueType = VXSE_ISSUE_TYPE[headType] ?? 'ScaleAndDestination'
  const correct: CorrectType = infoType === '訂正' ? 'Unknown' : 'None'

  return {
    code: 551,
    id: `dmdata-xml-quake-${eventId}-${serial}`,
    time: reportDateTime,
    issue: {
      source: '気象庁',
      time: reportDateTime,
      type: issueType,
      correct,
    },
    earthquake: {
      time: originTime,
      hypocenter: { name: hypName, latitude: lat, longitude: lng, depth, magnitude },
      maxScale: maxScale >= 0 ? maxScale as IntensityScale : -1,
      domesticTsunami: 'None',
      foreignTsunami: 'None',
    },
    points,
  }
}

// REST API 経由の JMA XML（VTSE51）を JMATsunami にパース。
// 観測データ（Observation のみ）の場合は null を返す。
export function parseTsunamiFromXml(xml: string): JMATsunami | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return null
  } catch { return null }

  const reportDateTime = xmlText(xmlQ(doc, 'ReportDateTime')) || xmlText(xmlQ(doc, 'DateTime'))
  const eventId = xmlText(xmlQ(doc, 'EventID'))
  const serial = xmlText(xmlQ(doc, 'Serial')) || '1'
  const infoType = xmlText(xmlQ(doc, 'InfoType'))

  const id = `dmdata-xml-tsunami-${eventId}-${serial}`
  const cancelled = infoType === '解除'

  if (cancelled) {
    return { code: 552, id, time: reportDateTime, cancelled: true, issue: { source: '気象庁', time: reportDateTime, type: 'Focus' }, areas: [] }
  }

  // Forecast 要素がなければ観測データなので null
  const forecastEl = xmlQ(doc, 'Forecast')
  if (!forecastEl) return null

  const allEls = forecastEl.getElementsByTagName('*')
  const itemEls: Element[] = []
  for (let i = 0; i < allEls.length; i++) {
    if (allEls[i].localName === 'Item') itemEls.push(allEls[i])
  }

  const areas: TsunamiArea[] = []
  for (const itemEl of itemEls) {
    const areaName = xmlText(xmlQ(itemEl, 'Name'))
    const kindEl = xmlQ(itemEl, 'Kind')
    const kindName = kindEl ? xmlText(xmlQ(kindEl, 'Name')) : ''
    const grade = parseTsunamiGrade(kindName)
    if (grade === 'Unknown' || !areaName) continue

    const fhEl = xmlQ(itemEl, 'FirstHeight')
    const arrivalTime = fhEl ? xmlText(xmlQ(fhEl, 'ArrivalTime')) : ''
    const condition = fhEl ? xmlText(xmlQ(fhEl, 'Condition')) : ''

    const mhEl = xmlQ(itemEl, 'MaxHeight')
    const heightEl = mhEl ? xmlQ(mhEl, 'TsunamiHeight') : null
    const heightVal = heightEl ? parseFloat(xmlText(heightEl)) : NaN
    const heightDesc = heightEl?.getAttribute('description') ?? ''

    areas.push({
      grade,
      immediate: condition === 'ただちに津波来襲と予測',
      name: areaName,
      firstHeight: { arrivalTime: arrivalTime || undefined, condition },
      maxHeight: !isNaN(heightVal) ? { description: heightDesc, value: heightVal } : undefined,
    })
  }

  if (areas.length === 0) return null

  return { code: 552, id, time: reportDateTime, cancelled: false, issue: { source: '気象庁', time: reportDateTime, type: 'Focus' }, areas }
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
