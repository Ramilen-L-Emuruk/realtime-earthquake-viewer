// DMDATA.JP の formatMode:"json" 電文を内部型に変換する。
// 各 parse* 関数は null を返すことがある（必須フィールド欠損時）。

import type {
  JMAQuake,
  JMATsunami,
  JMALpgm,
  EEWAlert,
  EEWRegion,
  IntensityScale,
  DomesticTsunami,
  IssueType,
  CorrectType,
  TsunamiArea,
  TsunamiGrade,
  TsunamiObservation,
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
    '7': 70, 'over': 70,
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
// coordinate.height.value は m 単位の負値（海面下が負）。
// depth.value は km 単位の文字列の場合もある。
function parseHypocenterCoord(hypo: Record<string, unknown>): {
  lat: number; lng: number; depth: number
} {
  const coord = obj(hypo.coordinate)
  const lat = parseNum(obj(coord.latitude).value)
  const lng = parseNum(obj(coord.longitude).value)
  const depthKm = parseNum(obj(hypo.depth).value)
  const heightM = parseNum(obj(coord.height).value)
  // depth.value が km の数値として取れればそれを優先
  const depth = Number.isFinite(depthKm) && depthKm >= 0
    ? depthKm
    : Number.isFinite(heightM)
      ? Math.abs(heightM) / 1000
      : -1
  return { lat, lng, depth }
}

// EEW 電文の body.intensity.regions[] を地域別予想震度（EEWRegion[]）に変換する。
// 各要素は細分化地域コード(code)・地域名(name)・予測震度(forecastMaxInt.{from,to}) を持つ。
// pref はこの電文に単体では含まれないため空文字とし、フック層で station-coords から補完する。
function parseEEWRegions(intensity: Record<string, unknown>): EEWRegion[] {
  const regions: EEWRegion[] = []
  for (const raw of arr(intensity.regions)) {
    const r = obj(raw)
    const name = str(r.name)
    if (!name) continue
    const fm = obj(r.forecastMaxInt)
    const scaleTo = parseIntensityStr(str(fm.to) || str(fm.from))
    const scaleFrom = parseIntensityStr(str(fm.from))
    regions.push({
      pref: '',
      name,
      scaleFrom,
      scaleTo,
      kindCode: str(obj(r.kind).code),
      arrivalTime: str(r.arrivalTime) || null,
    })
  }
  return regions
}

// EEW (VXSE42: 配信テスト, VXSE43: 警報, VXSE44: 予報(廃止予定), VXSE45: 地震動予報)
// data は WebSocket body を復号・JSON.parse した後のオブジェクト（トップレベル電文）
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
  // 各地の予想震度（地域別）。キャンセル時は空にする。
  const areas = isCanceled ? [] : parseEEWRegions(intensity)

  // 推定最大長周期地震動階級（1〜4）。to 優先、なければ from
  const forecastMaxLpgmInt = obj(intensity.forecastMaxLpgmInt)
  const lpgmStr = str(forecastMaxLpgmInt.to) || str(forecastMaxLpgmInt.from)
  const lpgmClass = parseInt(lpgmStr, 10)
  const forecastMaxLpgmClass = (!isCanceled && lpgmClass >= 1 && lpgmClass <= 4) ? lpgmClass : undefined

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
        magnitude: parseNum(obj(earthquake.magnitude).value),
      },
    },
    severity: (headType === 'VXSE43' || body.isWarning === true) ? 'Warning' : 'Forecast',
    cancelled: isCanceled,
    isFinal: body.isLastInfo === true,
    forecastMaxScale: (!isCanceled && forecastScale >= 0) ? forecastScale as IntensityScale : undefined,
    forecastMaxLpgmClass,
    issue: { eventId, serial, time: reportTime },
    areas,
  }
}

const VXSE_ISSUE_TYPE: Record<string, IssueType> = {
  VXSE51: 'ScalePrompt',
  VXSE52: 'Destination',
  VXSE53: 'ScaleAndDestination',
}

// VXSE53 JSON 電文の body.intensity.prefectures[].cities[].areas[] から観測点データを取り出す。
// フィールド名は DMDATA v2 仕様に従い prefectures/cities/areas を優先し、
// 旧形式の pref/city/area にもフォールバックする。
function parseIntensityPoints(intensity: Record<string, unknown>): JMAQuake['points'] {
  const points: JMAQuake['points'] = []
  const prefList = arr(intensity.prefectures).length > 0
    ? arr(intensity.prefectures)
    : arr(intensity.pref)
  for (const rawPref of prefList) {
    const p = obj(rawPref)
    const prefName = str(p.name)
    const cityList = arr(p.cities).length > 0 ? arr(p.cities) : arr(p.city)
    for (const rawCity of cityList) {
      const c = obj(rawCity)
      const areaList = arr(c.areas).length > 0 ? arr(c.areas) : arr(c.area)
      for (const rawArea of areaList) {
        const a = obj(rawArea)
        const name = str(a.name)
        const scale = parseIntensityStr(str(a.maxInt) || null)
        if (name && scale >= 0) {
          points.push({ pref: prefName, addr: name, isArea: true, scale: scale as IntensityScale })
        }
      }
    }
  }
  return points
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

  // VXSE53（震源・各地震度）のみ JSON 電文から地域別震度を取り出す。
  // VXSE51/52 は観測データを持たないため空配列のまま。
  const points = headType === 'VXSE53'
    ? parseIntensityPoints(obj(body.intensity))
    : []

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
        magnitude: parseNum(obj(earthquake.magnitude).value),
      },
      maxScale: maxScale >= 0 ? maxScale as IntensityScale : -1,
      domesticTsunami: domestic,
      foreignTsunami: str(earthquake.foreignTsunami),
    },
    points,
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
      // JMA XML では地方公共団体の観測局名末尾に '＊'(U+FF0A) が付く。
      // station-coords.json のキーには '＊' がないため除去して引き当てる。
      const stName = xmlText(xmlQ(stEl, 'Name')).replace(/＊$/, '')
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

// REST API 経由の JMA XML（VTSE41/VTSE51/VTSE52）を JMATsunami にパース。
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
  const cancelled = infoType === '取消'

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
    const kindCode = kindEl ? xmlText(xmlQ(kindEl, 'Code')) : ''
    const grade = parseTsunamiGradeByCode(kindCode)
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

  // Forecast があるのに有効エリアが0件 = 全エリアが解除済み
  if (areas.length === 0) return { code: 552, id, time: reportDateTime, cancelled: true, issue: { source: '気象庁', time: reportDateTime, type: 'Focus' }, areas: [] }

  return { code: 552, id, time: reportDateTime, cancelled: false, issue: { source: '気象庁', time: reportDateTime, type: 'Focus' }, areas }
}

// Kind/Code による津波グレード判定（仕様: 気象庁防災情報XML 警報等情報要素コード表）
// 52/53: 大津波警報、51: 津波警報、62: 津波注意報
// 50/60: 解除、71/72/73: 若干の海面変動（予報のみ）、00: 津波なし
function parseTsunamiGradeByCode(code: string): TsunamiGrade {
  if (code === '52' || code === '53') return 'MajorWarning'
  if (code === '51') return 'Warning'
  if (code === '62') return 'Watch'
  return 'Unknown'
}

// 津波情報 (VTSE41: 大津波警報特別、VTSE51: 警報・注意報・解除、VTSE52: 沖合観測)
export function parseTsunami(headType: string, data: Record<string, unknown>): JMATsunami | null {
  const cancelled = str(data.infoType) === '取消'
  const id = `dmdata-tsunami-${str(data.eventId)}-${str(data.serialNo ?? data.serial ?? '1')}`
  const time = str(data.reportDateTime ?? data.pressDateTime)
  const source = str(data.editorialOffice ?? data.publishingOffice)

  if (cancelled) {
    return { code: 552, id, time, cancelled: true, issue: { source, time, type: 'Focus' }, areas: [] }
  }

  const body = obj(data.body)
  const tsunami = obj(body.tsunami)

  // VTSE52（沖合観測）は forecasts を持たず observations を持つ
  if (headType === 'VTSE52') {
    const rawObs = arr(tsunami.observations)
    if (rawObs.length === 0) return null
    const observations: TsunamiObservation[] = []
    for (const rawO of rawObs) {
      const o = obj(rawO)
      const name = str(o.name) || str(obj(o.station).name)
      if (!name) continue
      const waveList = arr(o.wave)
      if (waveList.length === 0) {
        observations.push({ name })
        continue
      }
      // 最初の波（第1波）を使用
      const w = obj(waveList[0])
      const hObj = obj(w.height)
      const heightVal = parseFloat(str(hObj.value))
      observations.push({
        name,
        height: !isNaN(heightVal)
          ? { value: heightVal, description: str(hObj.description) || str(hObj.condition) || `${heightVal}m` }
          : undefined,
        arrivalTime: str(w.time) || str(w.arrivalTime) || undefined,
        initial: str(w.initial) || undefined,
      })
    }
    if (observations.length === 0) return null
    return { code: 552, id, time, cancelled: false, issue: { source, time, type: 'Focus' }, areas: [], observations }
  }

  // DMDATA JSON v1.1.0: body.tsunami.forecasts が直接の配列（tsunami.forecast.items ではない）
  const rawItems = arr(tsunami.forecasts)
  if (rawItems.length === 0) return null

  const areas: TsunamiArea[] = []
  for (const item of rawItems) {
    const it = obj(item)
    const kind = obj(it.kind)
    const grade = parseTsunamiGradeByCode(str(kind.code))
    if (grade === 'Unknown') continue  // 解除・予報区は除外
    const firstHeight = obj(it.firstHeight)
    const maxHeight = obj(it.maxHeight)
    // DMDATA JSON v1.1.0: maxHeight.height.value が m 単位（maxHeight.value ではない）
    const heightObj = obj(maxHeight.height)
    const heightVal = parseFloat(str(heightObj.value))
    areas.push({
      grade,
      immediate: firstHeight.condition === 'ただちに津波来襲と予測',
      name: str(it.name),
      firstHeight: {
        arrivalTime: str(firstHeight.arrivalTime) || undefined,
        condition: str(firstHeight.condition),
      },
      maxHeight: !isNaN(heightVal)
        ? {
          description: str(heightObj.condition) || str(heightObj.value) || '',
          value: heightVal,
        }
        : undefined,
    })
  }

  // 全予報区が解除済み（Kind/Code が 50/60/71/72/73/00 など）
  if (areas.length === 0) return { code: 552, id, time, cancelled: true, issue: { source, time, type: 'Focus' }, areas: [] }

  return { code: 552, id, time, cancelled: false, issue: { source, time, type: 'Focus' }, areas }
}

// REST API 経由の JMA XML（VXSE62: 長周期地震動観測情報）を JMALpgm にパース
export function parseLpgmFromXml(xml: string): JMALpgm | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return null
  } catch { return null }

  const reportDateTime = xmlText(xmlQ(doc, 'ReportDateTime')) || xmlText(xmlQ(doc, 'DateTime'))
  const eventId        = xmlText(xmlQ(doc, 'EventID'))
  const serial         = xmlText(xmlQ(doc, 'Serial')) || '1'
  const infoType       = xmlText(xmlQ(doc, 'InfoType'))
  const id             = `dmdata-xml-lpgm-${eventId}-${serial}`
  const cancelled      = infoType === '取消'

  const earthquakeEl = xmlQ(doc, 'Earthquake')
  const originTime   = earthquakeEl ? xmlText(xmlQ(earthquakeEl, 'OriginTime')) : ''

  if (cancelled) return { id, time: reportDateTime, originTime, maxClass: 0, cancelled: true }
  if (!originTime) return null

  // VXSE62 XML: Intensity > Observation > MaxLgInt が最大長周期地震動階級
  const obsEl       = xmlQ(doc, 'Observation')
  const maxClassStr = obsEl ? xmlText(xmlQ(obsEl, 'MaxLgInt')) : ''
  const maxClass    = parseInt(maxClassStr, 10)

  if (!(maxClass >= 1 && maxClass <= 4)) return null
  return { id, time: reportDateTime, originTime, maxClass, cancelled: false }
}

// WebSocket 受信の JSON 電文（VXSE62: 長周期地震動観測情報）を JMALpgm にパース
// body.lpgmObservation.maxClass が観測最大階級（文字列 "1"〜"4"）
export function parseLpgm(data: Record<string, unknown>): JMALpgm | null {
  const cancelled = str(data.infoType) === '取消'
  const eventId = str(data.eventId)
  const serial = str(data.serialNo ?? data.serial ?? '1')
  const time = str(data.reportDateTime ?? data.pressDateTime)
  const id = `dmdata-lpgm-${eventId}-${serial}`

  const body = obj(data.body)
  const earthquake = obj(body.earthquake)
  const originTime = str(earthquake.originTime)

  if (cancelled) {
    return { id, time, originTime, maxClass: 0, cancelled: true }
  }

  if (!originTime) return null

  const lpgmObservation = obj(body.lpgmObservation)
  const maxClassStr = str(lpgmObservation.maxClass)
  const maxClass = parseInt(maxClassStr, 10)

  if (!(maxClass >= 1 && maxClass <= 4)) return null

  return { id, time, originTime, maxClass, cancelled: false }
}
