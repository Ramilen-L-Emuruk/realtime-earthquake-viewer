import type { JMAQuake, JMATsunami, EEWAlert, JMANankai, JMAKohatsu, EarthquakePoint, JMALpgm } from '../types/earthquake'
import { serverNow, serverDate } from './clock'
import notoHonshinPoints from '../data/noto-honshin-2024-points.json'
import notoHonshinLpgm from '../data/noto-honshin-2024-lpgm.json'

// テスト発報（EEW・津波）の自動解除までの時間。実発報の解除ロジックとは無関係の、テスト表示専用の固定値。
export const TEST_AUTO_DISMISS_MS = 90000

// eventId は DMDATA 電文が共有する14桁タイムスタンプ（YYYYMMDDHHmmss）形式。
// quake.id を `dmdata-quake-{eventId}-1` にすることで extractQuakeEventId が拾えるようにし、
// createTestLpgm が同じ eventId の長周期地震動データを lpgmByEventId に正しく紐づけられるようにする。
function toEventIdTimestamp(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * 遠地地震（気象庁「遠地地震に関する情報」VXSE53）のテストデータ。
 *
 * 2026-07-17 23:49（JST）メキシコ・チアパス州沿岸 M7.4 の実電文を元にしたパラメータ。
 * 深さ不明（`depth: {value: null, condition: "不明"}` → パーサは -1 センチネル）で、
 * 付加文が 021x 系ではなく `0226`（震源の近傍で津波発生の可能性）＋`0230`（日本への
 * 津波の影響なし）という、遠地地震特有の組み合わせになる報を選んでいる。
 * これにより「深さ句の省略」「付加文原文の読み上げ」「0230 の津波区分マップ」を一度に確認できる。
 *
 * @param includeForecastText 付加文の原文を含めるか。付加文は DMDATA 経路でのみ配信され、
 *   P2PQuake（標準版）には存在しないため、standard 版のテストでは false を渡して
 *   実データで起こり得ない読み上げが出ないようにする。
 */
export function createTestForeignQuake(includeForecastText: boolean): JMAQuake {
  const nowDate = serverDate()
  const now = nowDate.toISOString()
  const eventId = toEventIdTimestamp(nowDate)
  return {
    kind: 'quake',
    id: `dmdata-quake-${eventId}-1`,
    eventId,
    time: now,
    issue: { source: 'テスト', time: now, type: '遠地地震', correct: 'なし' },
    earthquake: {
      time: now,
      // 震源名は詳細震央地名（DetailedName）。実電文では震央地名「中米」より詳細なこちらを採る。
      hypocenter: { name: 'メキシコ、チアパス州沿岸', latitude: 14.4, longitude: -93.0, depth: -1, magnitude: 7.4 },
      // 遠地地震は国内で震度を観測しないため maxScale は常に -1。
      maxScale: -1,
      // 0230（この地震による日本への津波の影響はありません）由来。
      domesticTsunami: 'なし',
    },
    points: [],
    forecastText: includeForecastText
      ? '震源の近傍で津波発生の可能性があります。この地震による日本への津波の影響はありません。'
      : undefined,
  }
}

export function createTestEarthquake(): JMAQuake {
  const nowDate = serverDate()
  const now = nowDate.toISOString()
  const eventId = toEventIdTimestamp(nowDate)
  return {
    kind: 'quake',
    id: `dmdata-quake-${eventId}-1`,
    time: now,
    issue: { source: 'テスト', time: now, type: '各地の震度情報', correct: 'なし' },
    earthquake: {
      time: now,
      // 令和6年能登半島地震の本震（2024/1/1 16:10発生）の実データを元にしたパラメータ。
      // 震度・津波はDMDATA archive（気象庁電文, VXSE53「震源・震度情報」16:24発表）の
      // 確定報、震源要素（座標・深さ）は同日21:30に発表された「顕著な地震の震源要素更新の
      // お知らせ」（VXSE61）による確定値を採用（速報時の深さ0kmから16kmに更新）。
      hypocenter: { name: '石川県能登地方', latitude: 37.495, longitude: 137.27, depth: 16, magnitude: 7.6 },
      maxScale: 70,
      domesticTsunami: '警報等',
    },
    // observed points: DMDATA archive確定報（VXSE53「震源・震度情報」16:24発表）に含まれる
    // 観測点別震度（2782件）と一次細分区域別最大震度（119件、addr は public/data/subregions.json
    // の区域名と一致）をすべてそのまま採用（src/data/noto-honshin-2024-points.json）。
    // 都道府県ごとの代表点数件だけでは、ズームインした際にその都道府県の観測点が1つも表示
    // されない・区域集約表示（ズームアウト時）で「観測点のある区域だけ塗られ隣接区域は
    // 無色」という穴だらけの表示になる、という2つの不整合が生じるため、全観測点を反映する。
    // 輪島市門前町走出（震度7）のみ例外的に手動追加: 本震直後は停電・通信障害で観測データが
    // 未着で電文に反映されず、気象庁が2024/1/25の報道発表で「震度追加」として震度7
    // （計測震度6.5）を確定させたもの（電文形式では取得不可、気象庁公式発表を典拠とする）。
    points: notoHonshinPoints as EarthquakePoint[],
  }
}

// 本震と同一 eventId（14桁タイムスタンプ）を持つ長周期地震動観測情報（VXSE62, 2024/1/1
// 16:23発表）の実データ。震度データと同じくDMDATA archive確定報から採取（最大階級4）。
export function createTestLpgm(eventId: string): JMALpgm {
  const now = serverDate().toISOString()
  return {
    id: `test-lpgm-${eventId}`,
    eventId,
    time: now,
    originTime: now,
    maxClass: notoHonshinLpgm.maxClass,
    cancelled: false,
    regions: notoHonshinLpgm.regions,
    points: notoHonshinLpgm.points,
  }
}

export function createTestEEWWarning(eventId?: string, serial = 1): EEWAlert {
  const now = serverDate()
  const eid = eventId ?? `test-warn-${Date.now()}`
  return {
    kind: 'eew',
    id: `test-eew-warn-${Date.now()}`,
    time: now.toISOString(),
    test: false,
    earthquake: {
      originTime: now.toISOString(),
      arrivalTime: new Date(now.getTime() + 20000).toISOString(),
      condition: '以上',
      hypocenter: { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    forecastMaxLpgmClass: 3,
    issue: { eventId: eid, serial: String(serial), time: now.toISOString() },
    areas: [
      { pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: null, lgIntTo: 3 },
      { pref: '宮崎県', name: '宮崎県南部', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: null, lgIntTo: 2 },
      { pref: '大分県', name: '大分県南部', scaleFrom: 35, scaleTo: 40, kindCode: '10', arrivalTime: null, lgIntTo: 1 },
    ],
  }
}

export function createTestEEWForecast(eventId?: string, serial = 1): EEWAlert {
  const now = serverDate()
  const eid = eventId ?? `test-forecast-${Date.now()}`
  return {
    kind: 'eew',
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
  const now = serverDate()
  const eid = eventId ?? `test-${Date.now()}`
  return {
    kind: 'eew',
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
      { pref: '宮城県', name: '宮城県北部', scaleFrom: 55, scaleTo: 60, kindCode: '10', arrivalTime: new Date(now.getTime() + 15000).toISOString(), lgIntTo: 4 },
      { pref: '宮城県', name: '宮城県中部', scaleFrom: 50, scaleTo: 55, kindCode: '10', arrivalTime: new Date(now.getTime() + 18000).toISOString(), lgIntTo: 3 },
      { pref: '岩手県', name: '岩手県沿岸南部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: new Date(now.getTime() + 22000).toISOString(), lgIntTo: 2 },
      { pref: '福島県', name: '福島県浜通り', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: new Date(now.getTime() + 25000).toISOString(), lgIntTo: 2 },
      { pref: '茨城県', name: '茨城県北部', scaleFrom: 40, scaleTo: 45, kindCode: '11', arrivalTime: new Date(now.getTime() + 30000).toISOString(), lgIntTo: 1 },
    ],
  }
}

export function createTestNankai(kindName: '調査中' | '巨大地震注意' | '巨大地震警戒'): JMANankai {
  const now = serverDate().toISOString()
  const kindCodeMap: Record<string, string> = {
    '調査中': '0201', '巨大地震注意': '0202', '巨大地震警戒': '0203',
  }
  const bodyMap: Record<string, string> = {
    '調査中': '南海トラフ沿いの大規模な地震発生の可能性について、現在気象庁が調査を行っています。この情報は、調査中の段階で発表するものです。今後の情報に注意してください。',
    '巨大地震注意': '南海トラフ地震の想定震源域内でマグニチュード7.0以上の地震が発生しました。今後、大規模地震の発生可能性が平常時より高まっています。防災対応の確認をしてください。',
    '巨大地震警戒': '南海トラフ地震の想定震源域内でマグニチュード8.0以上の地震が発生しました。南海トラフ地震が発生するおそれがあります。直ちに防災対応をとってください。',
  }
  return {
    id: `test-nankai-${Date.now()}`,
    time: now,
    eventId: `test-nankai-event-${Date.now()}`,
    kindCode: kindCodeMap[kindName] ?? '0201',
    kindName,
    headline: `南海トラフ地震臨時情報（${kindName}）`,
    body: bodyMap[kindName] ?? '',
    cancelled: false,
    reportDateTime: now,
  }
}

export function createTestKohatsu(): JMAKohatsu {
  const now = serverDate().toISOString()
  const expireAt = new Date(serverNow() + 7 * 24 * 3600 * 1000).toISOString()
  return {
    id: `test-kohatsu-${Date.now()}`,
    time: now,
    eventId: `test-kohatsu-event-${Date.now()}`,
    headline: '北海道・三陸沖後発地震注意情報',
    body: '三陸沖でマグニチュード7.4の地震が発生しました。この地震は、北海道・三陸沖後発地震注意情報の発表基準を満たしています。今後、大規模地震の発生可能性が平常時より高まっています。海岸付近や川沿いにいる方は、念のため高台へ移動するなど、防災対応の確認をしてください。',
    cancelled: false,
    reportDateTime: now,
    expireAt,
  }
}

// 予報は実運用でも明示的な解除電文を伴わず ValidDateTime の期限切れで消えるため、
// テストデータにも validDateTime を持たせ、期限切れ経路（cancelReason: 'expired'）を再現する。
export function createTestTsunamiForecast(): JMATsunami {
  const now = serverDate()
  const nowIso = now.toISOString()
  return {
    kind: 'tsunami',
    id: `test-tsunami-forecast-${Date.now()}`,
    time: nowIso,
    cancelled: false,
    validDateTime: new Date(now.getTime() + TEST_AUTO_DISMISS_MS).toISOString(),
    issue: { source: 'テスト', time: nowIso, type: 'Focus' },
    areas: [
      { grade: 'Forecast', immediate: false, name: '北海道太平洋沿岸東部' },
      { grade: 'Forecast', immediate: false, name: '北海道太平洋沿岸中部' },
      { grade: 'Forecast', immediate: false, name: '北海道日本海沿岸南部' },
    ],
  }
}

// 誤報取消（InfoType=取消 相当）のテスト。警報・注意報混在の発表後、90秒後に電文全体が取り消される。
export function createTestTsunamiRetraction(): JMATsunami {
  const now = serverDate().toISOString()
  return {
    kind: 'tsunami',
    id: `test-tsunami-retraction-${Date.now()}`,
    time: now,
    cancelled: false,
    issue: { source: 'テスト', time: now, type: 'Focus' },
    areas: [
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', maxHeight: { description: '3m', value: 3.0 } },
      { grade: 'Watch', immediate: false, name: '北海道太平洋沿岸東部', maxHeight: { description: '1m', value: 1.0 } },
    ],
  }
}

export function createTestTsunamiWatch(): JMATsunami {
  const now = serverDate().toISOString()
  return {
    kind: 'tsunami',
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
  const now = serverDate().toISOString()
  return {
    kind: 'tsunami',
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
  const now = serverDate()
  const nowIso = now.toISOString()
  const t = (offsetMin: number) => new Date(now.getTime() + offsetMin * 60000).toISOString()
  return {
    kind: 'tsunami',
    id: `test-tsunami-${Date.now()}`,
    eventId: 'test-tsunami-2011',
    time: nowIso,
    cancelled: false,
    issue: { source: 'テスト', time: nowIso, type: 'Focus' },
    warningComment: 'ただちに高台へ避難してください。\n津波は繰り返し襲ってきます。警報が解除されるまで安全な場所から離れないでください。',
    sourceEarthquake: { hypocenterName: '三陸沖', magnitude: 9.0, originTime: nowIso },
    // name は地図の海岸線表示用に、津波予報区データ（tsunami-zones.json）に実在する区域名を使用する
    // 2011年東北地方太平洋沖地震を参考にした発令内容
    // code は津波予報区コード（テスト用の仮値）。observations の districtCode と一致させて紐づけを確認する
    areas: [
      {
        grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030',
        maxHeight: { description: '10m以上', value: 10.0 },
        firstHeight: { arrivalTime: t(-6), condition: 'ただちに津波来襲と予測' },
        stations: [
          { name: '宮古',   code: '0031', arrivalTime: t(-6), highTideDateTime: t(60) },
          { name: '釜石',   code: '0032', arrivalTime: t(-4), highTideDateTime: t(62) },
          { name: '大船渡', code: '0033', arrivalTime: t(-5), highTideDateTime: t(58) },
        ],
      },
      {
        grade: 'MajorWarning', immediate: true, name: '宮城県', code: '040',
        maxHeight: { description: '10m以上', value: 10.0 },
        firstHeight: { arrivalTime: t(-4), condition: 'ただちに津波来襲と予測' },
        stations: [
          { name: '石巻港', code: '0041', arrivalTime: t(-4), highTideDateTime: t(55) },
          { name: '仙台港', code: '0042', arrivalTime: t(-3), highTideDateTime: t(57) },
          { name: '気仙沼', code: '0043', arrivalTime: t(-5), highTideDateTime: t(56) },
        ],
      },
      {
        grade: 'MajorWarning', immediate: true, name: '福島県', code: '050',
        maxHeight: { description: '6m', value: 6.0 },
        firstHeight: { arrivalTime: t(-2), condition: 'ただちに津波来襲と予測' },
        stations: [
          { name: '小名浜', code: '0051', arrivalTime: t(-2), highTideDateTime: t(65) },
        ],
      },
      {
        grade: 'Warning', immediate: false, name: '青森県太平洋沿岸', code: '060',
        maxHeight: { description: '3m', value: 3.0 },
        firstHeight: { arrivalTime: t(10), condition: '' },
        stations: [
          { name: '八戸',       code: '0061', arrivalTime: t(10), highTideDateTime: t(70) },
          { name: 'むつ関根浜', code: '0062', arrivalTime: t(15), highTideDateTime: t(72) },
        ],
      },
      {
        grade: 'Warning', immediate: false, name: '茨城県', code: '070',
        maxHeight: { description: '3m', value: 3.0 },
        firstHeight: { arrivalTime: t(20), condition: '' },
        stations: [
          { name: '大洗', code: '0071', arrivalTime: t(20), highTideDateTime: t(80) },
        ],
      },
      {
        grade: 'Watch', immediate: false, name: '北海道太平洋沿岸東部', code: '080',
        maxHeight: { description: '1m', value: 1.0 },
        stations: [
          { name: '釧路', code: '0081', arrivalTime: t(30), highTideDateTime: t(90) },
        ],
      },
    ],
    observations: [
      { name: '宮古',   districtCode: '030', districtName: '岩手県',           height: { value: 8.5, description: '8.5m以上', over: true }, arrivalTime: nowIso, initial: '押し' },
      { name: '石巻港', districtCode: '040', districtName: '宮城県',           height: { value: 7.2, description: '7.2m' }, arrivalTime: nowIso, initial: '押し' },
      { name: '八戸',   districtCode: '060', districtName: '青森県太平洋沿岸', height: { value: 1.8, description: '1.8m' }, arrivalTime: nowIso, initial: '引き' },
      { name: '沖合40km', height: { value: 3.0, description: '3.0m以上', over: true }, arrivalTime: nowIso },
    ],
  }
}
