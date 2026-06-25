import type { JMAQuake, JMATsunami, EEWAlert } from '../types/earthquake'

export function createTestEarthquake(): JMAQuake {
  const now = new Date().toISOString()
  return {
    code: 551,
    id: `test-eq-${Date.now()}`,
    time: now,
    issue: { source: 'テスト', time: now, type: 'ScaleAndDestination', correct: 'None' },
    earthquake: {
      time: now,
      // 2011年東北地方太平洋沖地震を参考にしたパラメータ
      hypocenter: { name: '三陸沖', latitude: 38.1, longitude: 142.9, depth: 24, magnitude: 9.0 },
      maxScale: 70,
      domesticTsunami: 'Warning',
      foreignTsunami: 'None',
    },
    // addr は地図の震度マーカー表示用に、座標テーブル（public/data/station-coords.json）に
    // 実在する観測点名を使用する。市区町村名のままだと座標が引けずマーカーが出ない。
    points: [
      { pref: '宮城県', addr: '栗原市築館',         isArea: false, scale: 70 },
      { pref: '宮城県', addr: '気仙沼市赤岩',        isArea: false, scale: 60 },
      { pref: '宮城県', addr: '仙台青葉区大倉',      isArea: false, scale: 60 },
      { pref: '岩手県', addr: '大船渡市大船渡町',    isArea: false, scale: 55 },
      { pref: '岩手県', addr: '宮古市鍬ヶ崎',       isArea: false, scale: 55 },
      { pref: '福島県', addr: '福島市花園町',        isArea: false, scale: 55 },
      { pref: '茨城県', addr: '水戸市金町',          isArea: false, scale: 50 },
      { pref: '栃木県', addr: '日光市瀬川',          isArea: false, scale: 45 },
      { pref: '埼玉県', addr: '熊谷市桜町',          isArea: false, scale: 30 },
    ],
  }
}

export function createTestEEWWarning(eventId?: string, serial = 1): EEWAlert {
  const now = new Date()
  const eid = eventId ?? `test-warn-${Date.now()}`
  return {
    code: 556,
    id: `test-eew-warn-${Date.now()}`,
    time: now.toISOString(),
    test: false,
    earthquake: {
      originTime: now.toISOString(),
      arrivalTime: new Date(now.getTime() + 20000).toISOString(),
      condition: '以上',
      hypocenter: { name: '茨城県沖', latitude: 36.1, longitude: 141.3, depth: 40, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    forecastMaxLpgmClass: 3,
    issue: { eventId: eid, serial: String(serial), time: now.toISOString() },
    areas: [
      { pref: '茨城県', name: '茨城県北部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: null },
      { pref: '茨城県', name: '茨城県南部', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: null },
      { pref: '栃木県', name: '栃木県南部', scaleFrom: 35, scaleTo: 40, kindCode: '10', arrivalTime: null },
    ],
  }
}

export function createTestEEWForecast(eventId?: string, serial = 1): EEWAlert {
  const now = new Date()
  const eid = eventId ?? `test-forecast-${Date.now()}`
  return {
    code: 556,
    id: `test-eew-forecast-${Date.now()}`,
    time: now.toISOString(),
    test: false,
    earthquake: {
      originTime: now.toISOString(),
      arrivalTime: new Date(now.getTime() + 20000).toISOString(),
      condition: '以上',
      hypocenter: { name: '宮城県沖', latitude: 38.3, longitude: 141.8, depth: 60, magnitude: 4.5 },
    },
    severity: 'Forecast',
    cancelled: false,
    issue: { eventId: eid, serial: String(serial), time: now.toISOString() },
    areas: [
      { pref: '宮城県', name: '宮城県北部', scaleFrom: 20, scaleTo: 25, kindCode: '10', arrivalTime: null },
      { pref: '宮城県', name: '宮城県中部', scaleFrom: 15, scaleTo: 20, kindCode: '10', arrivalTime: null },
    ],
  }
}

export function createTestEEW(eventId?: string, serial = 1): EEWAlert {
  const now = new Date()
  const eid = eventId ?? `test-${Date.now()}`
  return {
    code: 556,
    id: `test-eew-${Date.now()}`,
    time: now.toISOString(),
    test: false,
    earthquake: {
      originTime: now.toISOString(),
      arrivalTime: new Date(now.getTime() + 20000).toISOString(),
      condition: '以上',
      // 2011年東北地方太平洋沖地震を参考にしたパラメータ（EEW初報はM7.2前後だった）
      hypocenter: { name: '三陸沖', latitude: 38.1, longitude: 142.9, depth: 24, magnitude: 7.2 },
    },
    severity: 'Warning',
    cancelled: false,
    forecastMaxLpgmClass: 4,
    issue: { eventId: eid, serial: String(serial), time: now.toISOString() },
    // 実データに合わせ areas を使用（参照は utils/eew.ts の eewAreas() で吸収）
    areas: [
      { pref: '宮城県', name: '宮城県北部', scaleFrom: 55, scaleTo: 60, kindCode: '10', arrivalTime: new Date(now.getTime() + 15000).toISOString() },
      { pref: '宮城県', name: '宮城県中部', scaleFrom: 50, scaleTo: 55, kindCode: '10', arrivalTime: new Date(now.getTime() + 18000).toISOString() },
      { pref: '岩手県', name: '岩手県沿岸南部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: new Date(now.getTime() + 22000).toISOString() },
      { pref: '福島県', name: '福島県浜通り', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: new Date(now.getTime() + 25000).toISOString() },
      { pref: '茨城県', name: '茨城県北部', scaleFrom: 40, scaleTo: 45, kindCode: '11', arrivalTime: new Date(now.getTime() + 30000).toISOString() },
    ],
  }
}

export function createTestTsunamiForecast(): JMATsunami {
  const now = new Date().toISOString()
  return {
    code: 552,
    id: `test-tsunami-forecast-${Date.now()}`,
    time: now,
    cancelled: false,
    issue: { source: 'テスト', time: now, type: 'Focus' },
    areas: [
      { grade: 'Forecast', immediate: false, name: '北海道太平洋沿岸東部' },
      { grade: 'Forecast', immediate: false, name: '北海道太平洋沿岸中部' },
      { grade: 'Forecast', immediate: false, name: '北海道日本海沿岸南部' },
    ],
  }
}

export function createTestTsunamiWatch(): JMATsunami {
  const now = new Date().toISOString()
  return {
    code: 552,
    id: `test-tsunami-watch-${Date.now()}`,
    time: now,
    cancelled: false,
    issue: { source: 'テスト', time: now, type: 'Focus' },
    areas: [
      { grade: 'Watch', immediate: false, name: '北海道太平洋沿岸東部', maxHeight: { description: '1m', value: 1.0 } },
      { grade: 'Watch', immediate: false, name: '北海道太平洋沿岸中部', maxHeight: { description: '1m', value: 1.0 } },
    ],
  }
}

export function createTestTsunamiWarning(): JMATsunami {
  const now = new Date().toISOString()
  return {
    code: 552,
    id: `test-tsunami-warning-${Date.now()}`,
    time: now,
    cancelled: false,
    issue: { source: 'テスト', time: now, type: 'Focus' },
    areas: [
      { grade: 'Warning', immediate: true,  name: '青森県太平洋沿岸', maxHeight: { description: '3m', value: 3.0 } },
      { grade: 'Warning', immediate: true,  name: '茨城県',           maxHeight: { description: '3m', value: 3.0 } },
      { grade: 'Watch',   immediate: false, name: '北海道太平洋沿岸東部', maxHeight: { description: '1m', value: 1.0 } },
    ],
  }
}

export function createTestTsunami(): JMATsunami {
  const now = new Date().toISOString()
  return {
    code: 552,
    id: `test-tsunami-${Date.now()}`,
    time: now,
    cancelled: false,
    issue: { source: 'テスト', time: now, type: 'Focus' },
    // name は地図の海岸線表示用に、津波予報区データ（tsunami-zones.json）に実在する区域名を使用する
    // 2011年東北地方太平洋沖地震を参考にした発令内容
    areas: [
      { grade: 'MajorWarning', immediate: true,  name: '岩手県',           maxHeight: { description: '10m以上', value: 10.0 } },
      { grade: 'MajorWarning', immediate: true,  name: '宮城県',           maxHeight: { description: '10m以上', value: 10.0 } },
      { grade: 'MajorWarning', immediate: true,  name: '福島県',           maxHeight: { description: '6m',     value: 6.0  } },
      { grade: 'Warning',      immediate: false, name: '青森県太平洋沿岸', maxHeight: { description: '3m',     value: 3.0  } },
      { grade: 'Warning',      immediate: false, name: '茨城県',           maxHeight: { description: '3m',     value: 3.0  } },
      { grade: 'Watch',        immediate: false, name: '北海道太平洋沿岸東部', maxHeight: { description: '1m', value: 1.0  } },
    ],
  }
}
