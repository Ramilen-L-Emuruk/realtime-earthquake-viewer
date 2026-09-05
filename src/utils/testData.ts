import type { JMAQuake, JMATsunami, EEWAlert, JMANankai, JMANankaiCommentary, JMAKohatsu, EarthquakePoint, IntensityScale, JMALpgm } from '../types/earthquake'
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
 * @param includeComments 付加文（固定・自由の両方）を含めるか。付加文は DMDATA 経路でのみ
 *   配信され、P2PQuake（標準版）には存在しないため、standard 版のテストでは false を渡して
 *   実データで起こり得ない読み上げ・表示が出ないようにする。
 */
export function createTestForeignQuake(includeComments: boolean): JMAQuake {
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
    forecastText: includeComments
      ? '震源の近傍で津波発生の可能性があります。この地震による日本への津波の影響はありません。'
      : undefined,
    // 自由付加文も実電文どおり。この報では津波情報の発表元を 1 行添えるだけだが、
    // 続報が出る事象（火山噴火・津波を伴う海外地震）ではここに観測状況が書かれ、
    // 固定付加文が動かないまま**自由付加文だけが更新される**。
    freeText: includeComments
      ? 'ＰＴＷＣでは１７日２３時５４分に津波情報を発表しています。'
      : undefined,
  }
}

/**
 * 観測点別震度を DMDATA（DMDSS）経路の points 形状へ変換する。
 *
 * 実運用の `dmdataParser` は JSON スキーマが観測点に親都道府県を持たないため、
 * 観測点・一次細分区域はいずれも `pref: ''` で積み、都道府県は `pref` に名前を入れた
 * ロールアップ点（`isArea: true`）として別に追加する。元データは P2PQuake 形状
 * （観測点自体に `pref` が入る）なので、そのまま DMDSS で流すと実電文では起こり得ない
 * 組み合わせ（`isArea: false` かつ `pref` 非空）になり、都道府県別表示の分岐が
 * テストでは一度も通らない。
 */
function toDmdataPoints(points: EarthquakePoint[]): EarthquakePoint[] {
  const converted: EarthquakePoint[] = []
  const prefMax = new Map<string, IntensityScale>()
  for (const p of points) {
    // 都道府県ごとの最大震度を集計する（実電文の prefectures[] に相当）。
    // 震度不明（-1）は数えない。実電文の prefectures[] も震度が取れない都道府県は項目自体を
    // 載せないため、-1 のロールアップ点は実運用では現れない。
    if (!p.isArea && p.pref && p.scale >= 0) {
      const cur = prefMax.get(p.pref)
      if (cur === undefined || p.scale > cur) prefMax.set(p.pref, p.scale)
    }
    converted.push({ ...p, pref: '' })
  }
  for (const [pref, scale] of prefMax) {
    converted.push({ pref, addr: pref, isArea: true, scale })
  }
  return converted
}

/**
 * 地震情報のテストデータ（令和6年能登半島地震・本震）。
 *
 * @param useDmdataShape DMDSS 版のとき true。points 形状と情報種別を DMDATA 経路のものに
 *   合わせる（standard 版は P2PQuake 形状のまま）。
 */
export function createTestEarthquake(useDmdataShape: boolean): JMAQuake {
  const nowDate = serverDate()
  const now = nowDate.toISOString()
  const eventId = toEventIdTimestamp(nowDate)
  return {
    kind: 'quake',
    id: `dmdata-quake-${eventId}-1`,
    time: now,
    // 同じ内容（震源＋各地の震度）に付く情報種別はバリアントで異なる。
    // DMDATA は VXSE53 の「震源・震度情報」、P2PQuake は DetailScale の「各地の震度情報」。
    issue: { source: 'テスト', time: now, type: useDmdataShape ? '震源・震度情報' : '各地の震度情報', correct: 'なし' },
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
    // **1 区域だけ「震度5弱以上未入電」に差し替える。** 揺れが強い地域ほど観測点からの通信が
    // 途絶え、気象庁は観測値の代わりに `!5-`（5弱以上・未入電）で発表する。実データは確定報
    // ——通信が復旧した後の値——なのでこの形を含まないが、**発表直後に最も起きる形**なので
    // 画面で確かめられるようにしておく。差し替えるのは元から震度5弱の区域で、最大震度は動かない。
    points: useDmdataShape
      ? toDmdataPoints(notoHonshinPoints as EarthquakePoint[]).map(p =>
        // 都道府県ロールアップ点を差し替える（カードの行はこの粒度で出る）。長野県は元から
        // 震度5弱なので、差し替えても最大震度は動かない。
        p.pref === '長野県' && p.addr === '長野県'
          ? { ...p, unreceived: true }
          : p,
      )
      // P2PQuake は観測点電文（DetailScale）と区域速報電文（ScalePrompt）を別々に送るため、
      // 1 電文に両方が混ざることはない（→ quake-spec.md §4）。`各地の震度情報` として送る以上、
      // 区域点は落とす。
      : (notoHonshinPoints as EarthquakePoint[]).filter((p) => !p.isArea),
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

// EEW テストの kindCode は気象庁コード表12（緊急地震速報種別）に従う。
//   00 / 01 / 09 = 予報（未到達 / 既に到達 / PLUM法で到達予想なし）
//   10 / 11 / 19 = 警報（同順）
// 警報は予想震度5弱（scaleTo 45）以上の区域に発表されるため、震度4以下の区域には
// 予報側のコードを使う（`isWarning` 判定は 10/11/19 のみを警報として扱う）。
//
// @param baseTime 震源時刻の基準。同一イベントの続報・最終報では初報の値を渡して固定する
//   （実運用の続報は originTime を変えない）。発表時刻（time / issue.time）は常に呼び出し時点。
export function createTestEEWWarning(eventId?: string, serial = 1, baseTime?: Date): EEWAlert {
  const origin = baseTime ?? serverDate()
  const report = serverDate().toISOString()
  const eid = eventId ?? `test-warn-${Date.now()}`
  return {
    kind: 'eew',
    // 実運用の id は eventId と報番号で構成される（dmdataParser: `dmdata-eew-${eventId}-${serial}`）
    id: `test-eew-warn-${eid}-${serial}`,
    time: report,
    test: false,
    earthquake: {
      originTime: origin.toISOString(),
      arrivalTime: new Date(origin.getTime() + 20000).toISOString(),
      condition: '以上',
      hypocenter: { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    forecastMaxLpgmClass: 3,
    // 気象庁の固定付加文。EEW にも付く（`Comments/Warning/Text`）
    warningComment: '強い揺れに警戒してください。',
    issue: { eventId: eid, serial: String(serial), time: report },
    areas: [
      { pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: null, lgIntTo: 3 },
      { pref: '宮崎県', name: '宮崎県南部平野部', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: null, lgIntTo: 2 },
      // 予想震度4（5弱未満）は警報の対象外。同一電文内の予報域として送る
      { pref: '大分県', name: '大分県南部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: null, lgIntTo: 1 },
    ],
  }
}

// 予報（警報未満）の EEW。区域は予想震度4 とする: 実運用の電文に区域が載る条件は
// 「最大予測震度4以上または最大予測長周期地震動階級3以上」であり、震度3以下の区域は
// そもそも電文に現れない（eew-information スキーマ）。
export function createTestEEWForecast(eventId?: string, serial = 1, baseTime?: Date): EEWAlert {
  const origin = baseTime ?? serverDate()
  const report = serverDate().toISOString()
  const eid = eventId ?? `test-forecast-${Date.now()}`
  return {
    kind: 'eew',
    id: `test-eew-forecast-${eid}-${serial}`,
    time: report,
    test: false,
    earthquake: {
      originTime: origin.toISOString(),
      arrivalTime: new Date(origin.getTime() + 20000).toISOString(),
      condition: '以上',
      hypocenter: { name: '宮城県沖', latitude: 38.3, longitude: 141.8, depth: 60, magnitude: 4.5 },
    },
    severity: 'Forecast',
    cancelled: false,
    issue: { eventId: eid, serial: String(serial), time: report },
    areas: [
      { pref: '宮城県', name: '宮城県北部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: null },
      { pref: '宮城県', name: '宮城県中部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: null },
    ],
  }
}

// 仮定震源要素の初期報 → 続報で震源確定・警報へ格上げ。
//
// 初報は震源要素が推定できず、PLUM 法による震度予測だけが有効な状態。**その PLUM も 1 点しか
// 鳴っていない報**を模しており、気象庁が最大予測震度を発表しない条件（観測点 1 点による震度予測）に
// あたるため、区域も電文全体の予想震度も持たない。読み上げは待たずに「単独点処理のため、予想震度
// なし。」と伝え、続報で値が付いた時点で言い直す（docs/spec/audio-tts-spec.md §6）。
//
// **震源名は報をまたいで変えない。** 名前が変わって 50km 超動くと「震源を更新、〇〇で地震。」の
// 経路（useLiveEventHandler の hypoFarMoved）に入り、確かめたい格上げの言い方が出てこない。
// 気象庁が仮定震源要素に入れる固定値（深さ 10km・M1.0）から確定値（深さ 30km・M6.5）へ
// 更新する形にしてある。
export function createTestEEWAssumed(eventId?: string, serial = 1, baseTime?: Date): EEWAlert {
  const origin = baseTime ?? serverDate()
  const report = serverDate().toISOString()
  const eid = eventId ?? `test-assumed-${Date.now()}`
  const isAssumed = serial === 1
  return {
    kind: 'eew',
    id: `test-eew-assumed-${eid}-${serial}`,
    time: report,
    test: false,
    earthquake: {
      originTime: origin.toISOString(),
      arrivalTime: new Date(origin.getTime() + 20000).toISOString(),
      condition: isAssumed ? '仮定震源要素' : '以上',
      // 仮定震源要素では震源要素そのものが固定の仮定値（気象庁は観測点直下・深さ 10km・M1.0 を入れる）。
      // カード・地図側もこれを見て M・深さを隠す（docs/spec/eew-spec.md §5）
      hypocenter: isAssumed
        ? { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 10, magnitude: 1.0 }
        : { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5 },
    },
    severity: isAssumed ? 'Forecast' : 'Warning',
    cancelled: false,
    issue: { eventId: eid, serial: String(serial), time: report },
    // 初報に区域は載らない。続報で震源が確定して初めて地域別予想が付く
    areas: isAssumed ? [] : [
      { pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: null },
    ],
  }
}

// 深発地震（深さ 150km 超）。震源は確定しているが地域別予想が発表されないため、読み上げは
// 待たずに「深発地震のため、予想震度なし。」と伝える。
//
// **severity は続報も含めて予報級に固定する。** 気象庁は深さ 150km を超える地震に緊急地震速報
// （警報）を発表しないため、警報級の深発 EEW は実電文として存在しない。
export function createTestEEWDeep(eventId?: string, serial = 1, baseTime?: Date): EEWAlert {
  const origin = baseTime ?? serverDate()
  const report = serverDate().toISOString()
  const eid = eventId ?? `test-deep-${Date.now()}`
  return {
    kind: 'eew',
    id: `test-eew-deep-${eid}-${serial}`,
    time: report,
    test: false,
    earthquake: {
      originTime: origin.toISOString(),
      arrivalTime: new Date(origin.getTime() + 60000).toISOString(),
      condition: '以上',
      // 2015/05/30 小笠原諸島西方沖（深さ 682km）を参考にした深発地震のパラメータ
      hypocenter: { name: '小笠原諸島西方沖', latitude: 27.9, longitude: 140.5, depth: 450, magnitude: 6.5 },
    },
    severity: 'Forecast',
    cancelled: false,
    issue: { eventId: eid, serial: String(serial), time: report },
    // 深発地震では地域別の震度予想が発表されない
    areas: [],
  }
}

export function createTestEEW(eventId?: string, serial = 1, baseTime?: Date): EEWAlert {
  const origin = baseTime ?? serverDate()
  const report = serverDate().toISOString()
  const eid = eventId ?? `test-${Date.now()}`
  const at = (offsetMs: number) => new Date(origin.getTime() + offsetMs).toISOString()
  return {
    kind: 'eew',
    id: `test-eew-${eid}-${serial}`,
    time: report,
    test: false,
    earthquake: {
      originTime: origin.toISOString(),
      arrivalTime: at(20000),
      condition: '以上',
      // 2011年東北地方太平洋沖地震を参考にしたパラメータ（EEW初報はM7.2前後だった）
      hypocenter: { name: '三陸沖', latitude: 38.1, longitude: 142.9, depth: 24, magnitude: 7.2 },
    },
    severity: 'Warning',
    cancelled: false,
    forecastMaxLpgmClass: 4,
    issue: { eventId: eid, serial: String(serial), time: report },
    // 実データに合わせ areas を使用（参照は utils/eew.ts の eewAreas() で吸収）
    areas: [
      { pref: '宮城県', name: '宮城県北部', scaleFrom: 55, scaleTo: 60, kindCode: '10', arrivalTime: at(15000), lgIntTo: 4 },
      { pref: '宮城県', name: '宮城県中部', scaleFrom: 50, scaleTo: 55, kindCode: '10', arrivalTime: at(18000), lgIntTo: 3 },
      { pref: '岩手県', name: '岩手県沿岸南部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: at(22000), lgIntTo: 2 },
      { pref: '福島県', name: '福島県浜通り', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: at(25000), lgIntTo: 2 },
      // kindCode 11 は「主要動が既に到達と予測」。到達予想時刻は持たない（未来時刻とは両立しない）
      { pref: '茨城県', name: '茨城県北部', scaleFrom: 40, scaleTo: 45, kindCode: '11', arrivalTime: null, lgIntTo: 1 },
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

// 南海トラフ地震関連解説情報のテストデータ。実電文の構成に合わせている:
//   - headline は Head/Title 相当。臨時解説は「（第○号）」が付き、定例解説は付かない
//   - summary は Head/Headline/Text 相当の一文要約（バナーの見出しに出る）
//   - body は Body/EarthquakeInfo/Text 相当の本文（開いたときに出る）
//   - serialCode は地震関連情報番号コード。実電文で確認できた値は臨時解説 210・定例解説 200
/**
 * 南海トラフ地震臨時情報の取消電文。**対象と同じ `eventId` を持たせる**
 * （取消は「独立した情報単位」を指すため。気象庁 地震火山関連 XML 電文解説資料 Ⅰ.別紙ウ）。
 *
 * 段階の名乗り（`kindName`）は空にする。取消は電文の撤回でしかなく、段階の判断を含まない
 * ―― ここに「調査終了」を入れると、発表されていない安心情報をテストデータ側から作ることになる。
 */
export function createTestNankaiRetraction(base: JMANankai): JMANankai {
  const now = serverDate().toISOString()
  return {
    ...base,
    id: `${base.id}-cancel`,
    time: now,
    reportDateTime: now,
    kindCode: '',
    kindName: '',
    headline: '南海トラフ地震臨時情報（取消）',
    body: 'システムの障害により、先に発表した南海トラフ地震臨時情報を取り消します。',
    cancelled: true,
    retracted: true,
  }
}

export function createTestNankaiCommentary(serialName: '臨時解説' | '定例解説'): JMANankaiCommentary {
  const now = serverDate().toISOString()
  const expireAt = new Date(serverNow() + 7 * 24 * 3600 * 1000).toISOString()
  const isAdHoc = serialName === '臨時解説'
  return {
    id: `test-nankai-commentary-${Date.now()}`,
    time: now,
    eventId: `test-nankai-commentary-event-${Date.now()}`,
    serialCode: isAdHoc ? '210' : '200',
    serialName,
    headline: isAdHoc ? '南海トラフ地震関連解説情報（第１号）' : '南海トラフ地震関連解説情報',
    summary: isAdHoc
      ? '南海トラフ地震臨時情報（巨大地震注意）の発表後の状況をお知らせします。引き続き防災対応をとってください。'
      : '南海トラフ沿いの地震に関する評価検討会の定例会合で、南海トラフ周辺の地殻活動を評価しました。',
    body: isAdHoc
      ? '想定震源域内の地震活動および地殻変動の観測状況について、現在のところ新たな変化は認められません。引き続き、政府や自治体などからの呼びかけ等に応じた防災対応をとってください。'
      : '現在のところ、南海トラフ沿いの大規模地震の発生の可能性が平常時と比べて相対的に高まったと考えられる特段の変化は観測されていません。',
    cancelled: false,
    reportDateTime: now,
    expireAt,
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

// 津波テストデータのバリアント差。DMDSS（DMDATA）経路の電文だけが持つ項目を切り替える。
//   - eventId: DMDATA は常に14桁タイムスタンプを持つ。P2PQuake の 552 は持たない
//   - validDateTime: 同上（P2PQuake には有効期限の概念が無い）
// standard 版でこれらを持たせると、実運用では通らない経路（eventId による同一性判定・
// 期限切れ失効）をテストだけが通ってしまうため、バリアントに合わせて省く。
// @param withDmdssFields DMDSS 版のとき true
export function createTestTsunamiForecast(withDmdssFields: boolean): JMATsunami {
  const now = serverDate()
  const nowIso = now.toISOString()
  return {
    kind: 'tsunami',
    id: `test-tsunami-forecast-${Date.now()}`,
    eventId: withDmdssFields ? toEventIdTimestamp(now) : undefined,
    time: nowIso,
    cancelled: false,
    // 予報は DMDSS の実運用でも明示的な解除電文を伴わず ValidDateTime の期限切れで消えるため、
    // 期限切れ経路（cancelReason: 'expired'）を再現する。standard 版はこの項目自体が来ない。
    validDateTime: withDmdssFields ? new Date(now.getTime() + TEST_AUTO_DISMISS_MS).toISOString() : undefined,
    issue: { source: 'テスト', time: nowIso, type: 'Focus' },
    areas: [
      { grade: 'Forecast', immediate: false, name: '北海道太平洋沿岸東部' },
      { grade: 'Forecast', immediate: false, name: '北海道太平洋沿岸中部' },
      { grade: 'Forecast', immediate: false, name: '北海道日本海沿岸南部' },
    ],
  }
}

// 誤報取消（InfoType=取消 相当）のテスト。警報・注意報混在の発表後、90秒後に電文全体が取り消される。
export function createTestTsunamiRetraction(withDmdssFields: boolean): JMATsunami {
  const nowDate = serverDate()
  const now = nowDate.toISOString()
  return {
    kind: 'tsunami',
    id: `test-tsunami-retraction-${Date.now()}`,
    eventId: withDmdssFields ? toEventIdTimestamp(nowDate) : undefined,
    time: now,
    cancelled: false,
    issue: { source: 'テスト', time: now, type: 'Focus' },
    areas: [
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', maxHeight: { description: '3m', value: 3.0 } },
      { grade: 'Watch', immediate: false, name: '北海道太平洋沿岸東部', maxHeight: { description: '1m', value: 1.0 } },
    ],
  }
}

export function createTestTsunamiWatch(withDmdssFields: boolean): JMATsunami {
  const nowDate = serverDate()
  const now = nowDate.toISOString()
  return {
    kind: 'tsunami',
    id: `test-tsunami-watch-${Date.now()}`,
    eventId: withDmdssFields ? toEventIdTimestamp(nowDate) : undefined,
    time: now,
    cancelled: false,
    issue: { source: 'テスト', time: now, type: 'Focus' },
    areas: [
      { grade: 'Watch', immediate: false, name: '北海道太平洋沿岸東部', maxHeight: { description: '1m', value: 1.0 } },
      { grade: 'Watch', immediate: false, name: '北海道太平洋沿岸中部', maxHeight: { description: '1m', value: 1.0 } },
    ],
  }
}

export function createTestTsunamiWarning(withDmdssFields: boolean): JMATsunami {
  const nowDate = serverDate()
  const now = nowDate.toISOString()
  return {
    kind: 'tsunami',
    id: `test-tsunami-warning-${Date.now()}`,
    eventId: withDmdssFields ? toEventIdTimestamp(nowDate) : undefined,
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

export function createTestTsunami(withDmdssFields: boolean): JMATsunami {
  const now = serverDate()
  const nowIso = now.toISOString()
  const t = (offsetMin: number) => new Date(now.getTime() + offsetMin * 60000).toISOString()
  return {
    kind: 'tsunami',
    id: `test-tsunami-${Date.now()}`,
    eventId: withDmdssFields ? toEventIdTimestamp(now) : undefined,
    time: nowIso,
    cancelled: false,
    issue: { source: 'テスト', time: nowIso, type: 'Focus' },
    warningComment: 'ただちに高台へ避難してください。\n津波は繰り返し襲ってきます。警報が解除されるまで安全な場所から離れないでください。',
    // M8 を超える地震では規模を速報できないため、気象庁は「Ｍ８を超える巨大地震」と書き、
    // 予想波高も数値ではなく「巨大」で発表する（下の岩手県）。**第一報で最も起きる形**なので
    // テストにも入れておく。2 件目は、短い間に起きた地震がまとめて 1 通で届く場合の形。
    sourceEarthquakes: [
      { hypocenterName: '三陸沖', magnitudeCondition: 'Ｍ８を超える巨大地震', originTime: nowIso },
      { hypocenterName: '岩手県沖', magnitude: 7.2, originTime: t(-3) },
    ],
    // name は地図の海岸線表示用に、津波予報区データ（tsunami-zones.json）に実在する区域名を使用する
    // 2011年東北地方太平洋沖地震を参考にした発令内容
    // code は津波予報区コード（テスト用の仮値）。observations の districtCode と一致させて紐づけを確認する
    areas: [
      {
        // 数値にならない予想波高。`value` を持たないのが電文どおりの形
        grade: 'MajorWarning', immediate: true, name: '岩手県', code: '030',
        maxHeight: { description: '巨大' },
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
        // 到達状況は 3 つある。時刻を出せない段階ではこちらが入る
        firstHeight: { condition: '津波到達中と推測' },
        stations: [
          { name: '石巻港', code: '0041', arrivalTime: t(-4), highTideDateTime: t(55) },
          { name: '仙台港', code: '0042', arrivalTime: t(-3), highTideDateTime: t(57) },
          { name: '気仙沼', code: '0043', arrivalTime: t(-5), highTideDateTime: t(56) },
        ],
      },
      {
        grade: 'MajorWarning', immediate: true, name: '福島県', code: '050',
        maxHeight: { description: '6m', value: 6.0 },
        firstHeight: { condition: '第１波の到達を確認' },
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
    // 観測状態（`condition`）は電文の `Condition` に現れる組み合わせを一通り含める。
    // 気象庁は「重要 欠測」「微弱 欠測」のように複数を併記するため（電文解説資料 Ⅱ.12）、
    // 単独の状態しか置かないとカード・地図・読み上げの併記の扱いが一度も通らない。
    observations: [
      { name: '宮古',   districtCode: '030', districtName: '岩手県',           height: { value: 8.5, description: '8.5m以上', over: true }, arrivalTime: nowIso, initial: '押し' },
      // これまでの最大波を観測した後に観測が途切れた観測点（値と欠測が同時に来る形）。
      { name: '大船渡', districtCode: '030', districtName: '岩手県',           height: { value: 3.2, description: '3.2m以上', over: true }, arrivalTime: t(-5), initial: '押し', condition: { maxHeightMissing: true, important: true } },
      { name: '石巻港', districtCode: '040', districtName: '宮城県',           height: { value: 7.2, description: '7.2m' }, arrivalTime: nowIso, initial: '押し' },
      // 到達は確認できたが最大波が欠測（波高の数値が無い）。
      { name: '相馬',   districtCode: '050', districtName: '福島県',           arrivalTime: t(-2), initial: '押し', condition: { maxHeightMissing: true } },
      // 第1波も最大波も欠測（到達したかどうかも判っていない）。
      { name: 'いわき市小名浜', districtCode: '050', districtName: '福島県',   condition: { firstHeightMissing: true, maxHeightMissing: true } },
      // 水位が上昇中の観測点。波高の数値が消えないことの確認を兼ねる。
      { name: '大洗',   districtCode: '070', districtName: '茨城県',           height: { value: 2.1, description: '2.1m' }, arrivalTime: t(20), initial: '押し', condition: { rising: true } },
      { name: '八戸港', districtCode: '060', districtName: '青森県太平洋沿岸', height: { value: 1.8, description: '1.8m' }, arrivalTime: nowIso, initial: '引き' },
      // 津波注意報の区域で、これまでの最大波がごく小さい（数値を発表しない）。
      { name: '釧路',   districtCode: '080', districtName: '北海道太平洋沿岸東部', arrivalTime: t(30), initial: '押し', condition: { weak: true } },
      { name: '沖合40km', height: { value: 3.0, description: '3.0m以上', over: true }, arrivalTime: nowIso },
    ],
    // 沖合の観測から導いた沿岸への推定（電文の `Estimation`）。沖合の観測点は沿岸より先に
    // 津波を捉えるため、**まだ到達していない沿岸**の到達予想と高さが入る。
    // 時刻を出せない段階では説明（下の 2 件目）で伝える。
    estimations: [
      { name: '岩手県', code: '030', arrivalTime: t(8), maxHeight: { description: '5m', value: 5.0 } },
      { name: '宮城県', code: '040', arrivalCondition: '早いところでは既に津波到達と推定', maxHeight: { description: '4m', value: 4.0 } },
    ],
  }
}
