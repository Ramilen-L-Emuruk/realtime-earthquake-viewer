import type { JMAQuake, JMATsunami, EEWAlert, JMANankai, JMANankaiCommentary, JMAKohatsu, EarthquakePoint, JMALpgm, JMAQuakeCity, JMAQuakeNotice, JMAEarthquakeCount, JMAEstimatedIntensity, JMAEstimatedIntensityGrade, EEWRegion, TsunamiArea, TsunamiGrade, TelegramOperationStatus } from '../types/earthquake'
import { serverNow, serverDate } from './clock'
import notoHonshinPoints from '../data/noto-honshin-2024-points.json'
import notoHonshinQuake from '../data/noto-honshin-2024-quake.json'
import notoHonshinLpgmJson from '../data/noto-honshin-2024-lpgm.json'
import testEstimatedIntensityJson from '../data/test-estimated-intensity.json'
import { CELL_LAT_DEG, CELL_LON_DEG } from './bufrEstimatedIntensity'

/**
 * JSON の import は数値を `number` へ広げるため、震度・階級の値であることを型で言い直す。
 *
 * **中身は実電文をパーサーへ通して作ったもの**（`parseLpgmFromXml` が階級表の値しか
 * 通さない）なので、ここで改めて検証はしない。手で書いたデータへこの書き方をしないこと。
 */
const notoHonshinLpgm = notoHonshinLpgmJson as unknown as Omit<
  JMALpgm, 'id' | 'eventId' | 'time' | 'cancelled'
>

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
 * 遠地地震の第一報で、規模を数値で速報できない形。
 *
 * M8 を超える地震と推定されると、気象庁は規模を数値ではなく
 * 「Ｍ８を超える巨大地震」と発表する（電文では本文 `NaN`・`@condition="不明"` で、
 * `@description` だけが「Ｍ不明」と区別する）。**規模が判らないことと、大きすぎて
 * 速報できないことは別物**で、後者は最も伝えるべき場面に出る。
 *
 * 震央地名・付加文の組み合わせは気象庁の電文解説資料の事例に拠る（詳細震央地名
 * 「チリ中部沿岸」、固定付加文 `0229`＋`0221`＋`0228`）。同じ場面で津波側は
 * 予想波高が「巨大」になるため、大津波警報テストと合わせて確かめられる。
 *
 * @param withDmdssFields DMDSS 版（DMDATA XML 経路）のとき true。付加文と規模の説明
 *   （`magnitudeCondition`）を含めるか。どちらも P2PQuake は配信しないため、standard 版では
 *   実データで起こり得ない表示・読み上げが出ないように落とす。
 */
export function createTestForeignQuakeHuge(withDmdssFields: boolean): JMAQuake {
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
      hypocenter: {
        name: 'チリ中部沿岸',
        latitude: -35.8,
        longitude: -72.7,
        // 第一報は深さも決まらないことが多い。-1 が「不明」のセンチネル
        depth: -1,
        // 数値は入らない。説明だけが「規模不明」と「M8 超」を分ける
        magnitude: NaN,
        // **この説明は DMDATA 経路にしかない。** P2PQuake は規模を数値でしか配信せず、
        // 「Ｍ８を超える巨大地震」と「Ｍ不明」を分ける手立てを持たない。standard 版では
        // 落として、実データどおり「Ｍ不明」と出る形にする（表示・読み上げの経路自体は通る）。
        ...(withDmdssFields ? { magnitudeCondition: 'Ｍ８を超える巨大地震' } : {}),
      },
      maxScale: -1,
      // 0229（日本への津波の有無については現在調査中です）由来
      domesticTsunami: '調査中',
    },
    points: [],
    forecastText: withDmdssFields
      ? '日本への津波の有無については現在調査中です。太平洋の広域に津波発生の可能性があります。一般的に、この規模の地震が海域の浅い領域で発生すると、津波が発生することがあります。'
      : undefined,
  }
}

/**
 * 「5弱以上・未入電」に差し替える観測点。**standard 版でだけ使う。**
 *
 * DMDSS 版が使う実電文には未入電が 3 地点そのまま入っているので差し替えが要らない。
 * standard 版が使う `noto-honshin-2024-points.json` は観測点だけを抜き出した古い資材で
 * 未入電を含まないため、ここで作る（P2PQuake は震度値 46 で同じ事実を配信する）。
 *
 * 元から震度5弱の地点を選ぶ（差し替えても最大震度が動かない）。
 */
const UNRECEIVED_TEST_STATIONS = new Set(['輪島市舳倉島', '金沢市弥生'])


/**
 * 地震情報のテストデータ（令和6年能登半島地震・本震）。
 *
 * @param useDmdataShape DMDSS 版のとき true。points 形状と情報種別を DMDATA 経路のものに
 *   合わせる（standard 版は P2PQuake 形状のまま）。
 */
export function createTestEarthquake(useDmdataShape: boolean, operationStatus?: TelegramOperationStatus): JMAQuake {
  const nowDate = serverDate()
  const now = nowDate.toISOString()
  const eventId = toEventIdTimestamp(nowDate)
  return {
    kind: 'quake',
    id: `dmdata-quake-${eventId}-1`,
    time: now,
    // 電文の運用種別（`Control/Status`）。訓練・試験のときだけ入り、通常の報には現れない。
    // **DMDATA 経路だけが運ぶ**（P2PQuake はヘッダを配信しない）ので standard 版では渡さない。
    ...(operationStatus ? { operationStatus } : {}),
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
    // 震度の点。**都道府県ごとの代表点だけでは足りない** —— 寄ったときにその県の観測点が
    // 1 つも出ない、区域集約で「観測点のある区域だけ塗られ隣は無色」になる、という 2 つの
    // 不整合が起きるので、電文の点をすべて反映する。
    //
    // バリアントで出どころが違う。
    //
    // - **DMDSS 版**: 実電文をパーサーへ通したもの（`npm run build-test-quake`）。
    //   点 2993・市町村 1343・うち観測点 2829 が市町村に紐付く
    // - **standard 版**: 観測点だけを抜き出した古い資材（`noto-honshin-2024-points.json`）。
    //   P2PQuake は観測点電文（DetailScale）と区域速報（ScalePrompt）を別々に送るので、
    //   1 電文に両方が混ざることはない（→ quake-spec.md §4）
    //
    // **「気象庁以外の観測点」の印**（`nonJma`）も実電文どおり入る。電文では観測点名の末尾に
    // `＊` が付いて届き、アプリは印を名前から外してバッジで伝える。気象庁が配る
    // `ObservingPointByOthers` コード表は**雨・雪の観測点**の表で震度観測点を含まないので、
    // 電文の `＊` だけが手がかり。
    points: useDmdataShape
      // **DMDSS 版は実電文をパーサーへ通したものを使う**（`npm run build-test-quake`）。
      // 手で組み立てていた頃は観測点が市町村に紐付いておらず、カードの 4 段表示
      // （県 → 区域 → 市町村 → 観測点）の 4 段目を実機で確かめられなかった。
      //
      // **未入電の差し替えは要らない。** 確定報（16:24 発表）が既に 3 地点を
      // 「震度５弱以上未入電」で持っている（輪島市門前町走出・能登町柳田・能登町松波）。
      // 手で書いていた頃は門前町走出を「震度7」として足していたが、それは後日の報道発表で
      // 確定した値で、**発表直後に実際に見えていたのは未入電のほう**。
      ? (notoHonshinQuake.points as EarthquakePoint[])
      // P2PQuake は観測点電文（DetailScale）と区域速報電文（ScalePrompt）を別々に送るため、
      // 1 電文に両方が混ざることはない（→ quake-spec.md §4）。`各地の震度情報` として送る以上、
      // 区域点は落とす。
      // 標準版でも同じ地点を未入電にする（P2PQuake は震度値 46 で同じ事実を配信する）。
      // **「気象庁以外」の印は落とす。** P2PQuake はこの区別を配信しないので、
      // 残すと標準版のテストボタンだけが実電文に無いバッジを出す。
      : (notoHonshinPoints as EarthquakePoint[])
        .filter((p) => !p.isArea)
        .map(({ nonJma: _nonJma, ...p }) => (UNRECEIVED_TEST_STATIONS.has(p.addr) ? { ...p, unreceived: true } : p)),
    // 市町村ごとの震度（電文の `Pref/Area/City`）。**DMDATA 経路でのみ配信される**ので
    // standard 版では持たせない（P2PQuake は市町村の粒度を配信しない）。
    //
    // **市町村の未入電（`City/Condition`）はここに入っていない。** 資料 Ⅱ.33 2-1-3-3-3 が
    // 出る条件を「配下に未入電の観測点があり、**かつ市町村の最大震度が震度4以下（又は入電なし）**」
    // と定めており、この報では未入電の 3 地点が属する市町村がいずれも震度6強・6弱で当たらない。
    // 実電文を 3 日分（2024-01-01 能登本震 90 通・04-17 豊後水道 12 通・08-08 日向灘 13 通）
    // 走査しても 1 通も見つからなかった。**手で作らない** —— 実際に起きていない形をテスト
    // データに置くと、そちらへ合わせた実装が入りうる（→ docs/spec/quake-spec.md §5「市町村の震度」）。
    ...(useDmdataShape && { cities: notoHonshinQuake.cities as JMAQuakeCity[] }),
  }
}

// 本震と同一 eventId（14桁タイムスタンプ）を持つ長周期地震動観測情報（VXSE62, 2024/1/1
// 16:23発表）の実データ。DMDATA archive の確定報を**そのままパーサーへ通して**作ってある
// （最大階級4・観測点198・区域72・都道府県31）。
//
// **手で組み立てない。** 電文から読む項目を足すたびに、テストボタンだけ古い形のまま残る。
// 実電文を通して作れば、周期帯ごとの階級・絶対速度応答スペクトル・区域の最大震度といった
// 新しい項目も同時に揃う（それが無いと実機で一度も画面に出ない）。
export function createTestLpgm(eventId: string): JMALpgm {
  const now = serverDate().toISOString()
  return {
    ...notoHonshinLpgm,
    id: `test-lpgm-${eventId}`,
    eventId,
    time: now,
    // 発生時刻だけは「いま」に寄せる（テストは常に直近の地震として出す）
    originTime: now,
    cancelled: false,
    // 電文の「観測情報の種類」。**4＝階級3以上を観測した地域のうち、最大震度が4以下の地域がある**
    // （揺れは強くないのに高層階が大きく揺れた地域がある）。値 1・3 では何も出さないので、
    // 意味を出す側の経路を実機で通せるよう 4 を入れている
    category: 4,
    // 気象庁以外が運用する観測点の印。実電文の長周期地震動観測情報にも現れるが、
    // 元にした能登本震の報には 1 点も入っていなかった（198 点すべて気象庁）。**そこに無い形は
    // 一度も画面に出ない**ので、1 点だけ立てて地図の吹き出しのバッジ（`LpgmPointsGL`）を
    // 実機で確かめられるようにする。
    //
    // **この観測点が実際に気象庁以外なのではない。** 読み取り後の形としては正しく
    // （パーサーは名前の「＊」を外してこの印を立てる）、表示経路を通すためだけに立てている。
    points: (notoHonshinLpgm.points ?? []).map((p, i) => i === 0 ? { ...p, nonJma: true } : p),
  }
}

/**
 * standard 版（P2PQuake 経路）の津波の区域から、配信されない欄を落とす。
 *
 * P2PQuake の `parseTsunamiAreas` が作るのは `grade` / `immediate` / `name` /
 * `firstHeight`（`arrivalTime` と `condition`）/ `maxHeight`（`description` と `value`）だけ。
 * **区域コード・観測点の一覧・予想波高の「重要」・前回の等級は運ばれない。**
 *
 * **落とす側ではなく残す側を書く。** 型に DMDATA 由来の欄が増えたとき、落とす側を列挙する
 * 書き方だとそのまま素通りして standard 版へ漏れる —— 型検査は通り、この関数も何も言わない。
 * 残す側を書けば、増えた欄は既定で落ちる（安全側）。
 */
function toP2pTsunamiArea(area: TsunamiArea): TsunamiArea {
  return {
    grade: area.grade,
    immediate: area.immediate,
    name: area.name,
    // **入れ子の中も欄ごとに選ぶ。** オブジェクトごと複製すると、`firstHeight.revise`
    // （続報での位置づけ。P2PQuake は配信しない）のような欄が中に紛れて素通りする。
    ...(area.firstHeight ? {
      firstHeight: {
        condition: area.firstHeight.condition,
        ...(area.firstHeight.arrivalTime ? { arrivalTime: area.firstHeight.arrivalTime } : {}),
      },
    } : {}),
    ...(area.maxHeight ? {
      maxHeight: {
        description: area.maxHeight.description,
        ...(area.maxHeight.value !== undefined ? { value: area.maxHeight.value } : {}),
      },
    } : {}),
  }
}

/**
 * standard 版（P2PQuake 経路）で届く区域の都道府県名。
 *
 * **P2PQuake は県名を付けずに配信する。** 実データの `areas[].pref` は「茨城」「千葉」で、
 * DMDATA 経路（`enrichEEWPref` が区域名から逆引きして補う）の「茨城県」とは別の形になる。
 * この値は EEW カードの「対象」欄へそのまま出るので、揃えないと standard 版だけ画面が変わる。
 *
 * 落とすのは「都府県」だけで、「北海道」の「道」は残す —— 実データで確認できているのは
 * 上記 2 例だけで、北海道の区域を含む報が標本に無い。**推測で削らない。**
 *
 * この判断は `testData.test.ts` が直接固定している（フィクスチャに北海道の区域が無く、
 * ファクトリ越しでは確かめられないため export している）。
 */
export function toP2pPref(pref: string): string {
  return pref.replace(/[都府県]$/, '')
}

/**
 * standard 版の区域から、P2PQuake が配信しない欄を落とす。
 *
 * P2PQuake の `parseEEWRegions` が作るのは `pref` / `name` / `scaleFrom` / `scaleTo` /
 * `scaleToOrAbove` / `kindCode` / `arrivalTime` だけ。**長周期地震動階級（`lgIntTo`）は
 * 配信されず**、主要動の到達（`arrived`）も `Condition` を運ばないので立たない
 * （到達は種別コードの下 1 桁から `isEewAreaArrived` が判定する）。
 *
 * **落とす側ではなく残す側を書く**（理由は `toP2pTsunamiArea` に同じ）。
 */
function toP2pArea(area: EEWRegion): EEWRegion {
  return {
    pref: toP2pPref(area.pref),
    name: area.name,
    scaleFrom: area.scaleFrom,
    scaleTo: area.scaleTo,
    kindCode: area.kindCode,
    arrivalTime: area.arrivalTime,
    ...(area.scaleToOrAbove ? { scaleToOrAbove: area.scaleToOrAbove } : {}),
  }
}

// EEW テストの kindCode は気象庁コード表12（緊急地震速報種別）に従う。
//   00 / 01 / 09 = 予報（未到達 / 既に到達 / PLUM法で到達予想なし）
//   10 / 11 / 19 = 警報（同順）
// 警報は予想震度5弱（scaleTo 45）以上の区域に発表されるため、震度4以下の区域には
// 予報側のコードを使う（`isWarning` 判定は 10/11/19 のみを警報として扱う）。
//
// @param withDmdssFields DMDSS 版（DMDATA XML 経路）のとき true。
//   **standard 版の EEW は 2 つの経路の合成**で、Yahoo 強震モニタの hypoInfo が土台になり、
//   P2PQuake code=556 が区域と震源要素だけを後から注ぎ足す（`useEarthquakes.ts` の
//   `enrichEEW`）。そのため震源要素の精度・内陸/海域・短縮名・固定付加文・最大予測値の変化・
//   長周期地震動階級は**どちらの経路も運ばない**。false を渡すとそれらを持たない形になる。
// @param baseTime 震源時刻の基準。同一イベントの続報・最終報では初報の値を渡して固定する
//   （実運用の続報は originTime を変えない）。発表時刻（time / issue.time）は常に呼び出し時点。
export function createTestEEWWarning(withDmdssFields: boolean, eventId?: string, serial = 1, baseTime?: Date): EEWAlert {
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
      // 震源要素の補足情報（電文の `Condition`）。**値域は「仮定震源要素」の 1 つだけ**で、
      // 該当しなければ要素ごと出ない（電文解説資料 Ⅱ.21 1-2）。仮定震源要素でない報は空。
      condition: '',
      hypocenter: { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    // 電文全体の最大予測震度。区域があるときの表示は区域を優先するが（`utils/eew.ts` の
    // `eewMaxScale`）、**実電文はどちらの経路もこの欄を持つ** —— DMDATA は `Intensity/
    // Forecast/MaxInt`、standard 版は Yahoo hypoInfo の `calcintensity` がここへ入る。
    forecastMaxScale: 50,
    ...(withDmdssFields ? {
      forecastMaxLpgmClass: 3 as const,
      // 気象庁の固定付加文。EEW にも付く（`Comments/Warning/Text`）
      warningComment: '強い揺れに警戒してください。',
      // 震央が内陸か海域か（`Hypocenter/Area/LandOrSea`）。実電文 405 通中 404 通に入る
      landOrSea: '海域',
      // 短縮用震央地名（`ReduceName`）。「日向灘」は元から短いので実電文でも同じ文字列になる
      reduceName: '日向灘',
      // 震源要素の精度（`Hypocenter/Accuracy`）。実電文の事例３（IPF法 3点／4点・P相/全相混在・3点）
      // に合わせる。**画面に語が出る組み合わせを選ぶ** —— 0（不明）だけを入れると欄が空のままで、
      // 表示できているかを実機で確かめられない
      accuracy: { epicenterRank: 3, epicenterRank2: 3, depthRank: 3, magnitudeRank: 4, magnitudePoints: 3 },
      // 続報で最大予測値が上がる形（`Intensity/Forecast/Appendix`）。初報は変化なし、
      // 2 報目以降は「震央の位置が変わったため大きくなった」を出す
      forecastChange: serial <= 1
        ? { maxInt: 0, maxLgInt: 0, reason: 0 }
        : { maxInt: 1, maxLgInt: 0, reason: 2 },
    } : {}),
    issue: { eventId: eid, serial: String(serial), time: report },
    areas: ([
      { pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: null, lgIntTo: 3 },
      { pref: '宮崎県', name: '宮崎県南部平野部', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: null, lgIntTo: 2 },
      // 予想震度4（5弱未満）は警報の対象外。同一電文内の予報域として送る
      { pref: '大分県', name: '大分県南部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: null, lgIntTo: 1 },
    ] as const).map(a => withDmdssFields ? { ...a } : toP2pArea({ ...a })),
  }
}

// 予報（警報未満）の EEW。区域は予想震度4 とする: 実運用の電文に区域が載る条件は
// 「最大予測震度4以上または最大予測長周期地震動階級3以上」であり、震度3以下の区域は
// そもそも電文に現れない（eew-information スキーマ）。
export function createTestEEWForecast(withDmdssFields: boolean, eventId?: string, serial = 1, baseTime?: Date): EEWAlert {
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
      condition: '',
      hypocenter: { name: '宮城県沖', latitude: 38.3, longitude: 141.8, depth: 60, magnitude: 4.5 },
    },
    severity: 'Forecast',
    cancelled: false,
    forecastMaxScale: 40,
    issue: { eventId: eid, serial: String(serial), time: report },
    areas: ([
      { pref: '宮城県', name: '宮城県北部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: null },
      { pref: '宮城県', name: '宮城県中部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: null },
    ] as const).map(a => withDmdssFields ? { ...a } : toP2pArea({ ...a })),
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
export function createTestEEWAssumed(withDmdssFields: boolean, eventId?: string, serial = 1, baseTime?: Date): EEWAlert {
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
      condition: isAssumed ? '仮定震源要素' : '',
      // 仮定震源要素では震源要素そのものが固定の仮定値（気象庁は観測点直下・深さ 10km・M1.0 を入れる）。
      // カード・地図側もこれを見て M・深さを隠す（docs/spec/eew-spec.md §5）
      hypocenter: isAssumed
        ? { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 10, magnitude: 1.0 }
        : { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5 },
    },
    severity: isAssumed ? 'Forecast' : 'Warning',
    cancelled: false,
    // **初報は最大予測震度も持たない。** 観測点 1 点による震度予測では気象庁が発表しないため、
    // 電文にこの欄そのものが現れない（区域が空なのと同じ理由）。続報で震源が確定して初めて付く。
    ...(isAssumed ? {} : { forecastMaxScale: 50 as const }),
    issue: { eventId: eid, serial: String(serial), time: report },
    // 初報に区域は載らない。続報で震源が確定して初めて地域別予想が付く
    areas: isAssumed ? [] : ([
      { pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: null },
    ] as const).map(a => withDmdssFields ? { ...a } : toP2pArea({ ...a })),
  }
}

// 深発地震（深さ 150km 超）。震源は確定しているが地域別予想が発表されないため、読み上げは
// 待たずに「深発地震のため、予想震度なし。」と伝える。
//
// **severity は続報も含めて予報級に固定する。** 気象庁は深さ 150km を超える地震に緊急地震速報
// （警報）を発表しないため、警報級の深発 EEW は実電文として存在しない。
export function createTestEEWDeep(withDmdssFields: boolean, eventId?: string, serial = 1, baseTime?: Date): EEWAlert {
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
      condition: '',
      // 2015/05/30 小笠原諸島西方沖（深さ 682km）を参考にした深発地震のパラメータ
      hypocenter: { name: '小笠原諸島西方沖', latitude: 27.9, longitude: 140.5, depth: 450, magnitude: 6.5 },
    },
    severity: 'Forecast',
    cancelled: false,
    // 震源要素の精度（`Hypocenter/Accuracy`）。**警報のテストとは別のランクを入れる** ——
    // あちらは IPF 法（3 点／4 点）で、EPOS の語がどのテストボタンにも出ない状態だった。
    // 「そこに無い形は一度も画面に出ない」ので、括弧書き（〔観測網外〕）を確かめる手段が無くなる。
    // 海域の地震なので rank 7（EPOS（海域〔観測網外〕））が実電文の形としても素直。
    ...(withDmdssFields
      ? { accuracy: { epicenterRank: 7, epicenterRank2: 4, depthRank: 7, magnitudeRank: 6, magnitudePoints: 5 } }
      : {}),
    issue: { eventId: eid, serial: String(serial), time: report },
    // 深発地震では地域別の震度予想が発表されない
    areas: [],
  }
}

export function createTestEEW(withDmdssFields: boolean, eventId?: string, serial = 1, baseTime?: Date): EEWAlert {
  const origin = baseTime ?? serverDate()
  const report = serverDate().toISOString()
  const eid = eventId ?? `test-${Date.now()}`
  const at = (offsetMs: number) => new Date(origin.getTime() + offsetMs).toISOString()
  const isFirstReport = serial <= 1
  return {
    kind: 'eew',
    id: `test-eew-${eid}-${serial}`,
    time: report,
    test: false,
    earthquake: {
      originTime: origin.toISOString(),
      arrivalTime: at(20000),
      condition: '',
      // 2011年東北地方太平洋沖地震を参考にしたパラメータ（EEW初報はM7.2前後だった）
      hypocenter: { name: '三陸沖', latitude: 38.1, longitude: 142.9, depth: 24, magnitude: 7.2 },
    },
    severity: 'Warning',
    cancelled: false,
    // **初報は上限を定めない予想で来る**（電文の `To="over"`）。規模の推定が不確かな段階では
    // 気象庁が「震度6強程度以上」「階級3程度以上」と発表する。2011年東北沖の初報がまさにその形で、
    // M7.2 と推定していたものが実際には M9.0 だった。
    //
    // ボタンを 1 回押すと「程度以上」、もう 1 回押すと確定した値へ上がる。**この遷移まで再現する**
    // —— 上限が定まったことの言い直し（読み上げ）と、値の引き上げに追随する画面が確かめられる。
    //
    // 電文全体の最大予測震度も同じ遷移をする（`Intensity/Forecast/MaxInt` の `To="over"`）。
    // **区域が無い報ではこれだけが予想震度になる** —— standard 版の初報がまさにその形で、
    // 「震度6強程度以上」を区域なしで伝える経路はここでしか通らない（`utils/eew.ts` の
    // `eewMaxScale` は区域があればそちらを優先するため）。
    forecastMaxScale: 60,
    // **上限が定まらないことを伝えられるのは DMDATA だけ。** P2PQuake は電文全体の最大予測震度を
    // 配信せず（区域ごとの `scaleTo: 99` は運ぶ）、Yahoo hypoInfo の `calcintensity` にも
    // 「程度以上」に当たる表現が無い。standard 版で立てると、実運用では出ない「6強程度以上」が
    // 区域なしの報に出る。
    ...(withDmdssFields && isFirstReport ? { forecastMaxScaleOrAbove: true } : {}),
    // 長周期地震動階級は DMDATA だけが配信する（P2PQuake も Yahoo hypoInfo も運ばない）。
    ...(withDmdssFields
      ? (isFirstReport
        ? { forecastMaxLpgmClass: 3 as const, forecastMaxLpgmClassOver: true }
        : { forecastMaxLpgmClass: 4 as const })
      : {}),
    issue: { eventId: eid, serial: String(serial), time: report },
    // 実データに合わせ areas を使用（参照は utils/eew.ts の eewAreas() で吸収）
    //
    // **standard 版の初報は区域を持たない。** Yahoo 強震モニタの hypoInfo が先に届き、
    // 区域は P2PQuake code=556 が後から注ぎ足す（`useEarthquakes.ts` の `enrichEEW`）ため、
    // 実運用でもこの順で画面に出る。ボタンを 2 回押すと注入後の形へ進む。
    areas: (!withDmdssFields && isFirstReport) ? [] : ([
      {
        pref: '宮城県', name: '宮城県北部', scaleFrom: 55, scaleTo: 60, kindCode: '10',
        arrivalTime: at(15000),
        // 震度は上限を定めず（「震度6強程度以上」）、長周期は初報で 1 段低い階級から始まる。
        ...(isFirstReport
          ? { scaleToOrAbove: true, lgIntTo: 3 as const, lgIntToOver: true }
          : { lgIntTo: 4 as const }),
      },
      { pref: '宮城県', name: '宮城県中部', scaleFrom: 50, scaleTo: 55, kindCode: '10', arrivalTime: at(18000), lgIntTo: 3 },
      { pref: '岩手県', name: '岩手県沿岸南部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: at(22000), lgIntTo: 2 },
      { pref: '福島県', name: '福島県浜通り', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: at(25000), lgIntTo: 2 },
      // **種別コードの下 1 桁が主要動の状況を表す**（コード表 12。→ `utils/eewKind.ts`）。
      // 到達の欄はこれで表示が 3 通りに分かれるので、テストデータにも 3 種類とも入れておく
      // —— 実機で確かめられるのはここに在る形だけ。
      //
      // 11 ＝ 警報・既に到達と推定。実電文は種別コードと `Condition` の両方で到達を伝えるので、
      // 読み取り後の値（`arrived`）も立てる。到達予測時刻とは排他で、時刻は持たない。
      { pref: '茨城県', name: '茨城県北部', scaleFrom: 40, scaleTo: 45, kindCode: '11', arrivalTime: null, arrived: true, lgIntTo: 1 },
      // 19 ＝ 警報・PLUM 法。**時刻は持つが到達の予測ではない**（「震度を初めて予測した時刻」）
      // ので過去の時刻が入る。画面は時刻を出さず「到達時刻は不明」と書く。
      { pref: '千葉県', name: '千葉県北東部', scaleFrom: 40, scaleTo: 45, kindCode: '19', arrivalTime: at(-4000), lgIntTo: 1 },
    ] as const).map(a => withDmdssFields ? { ...a } : toP2pArea({ ...a })),
  }
}

/**
 * 南海トラフ関連の 3 種別が共通して持つ参考情報（`Body/EarthquakeInfo/Appendix`）。
 *
 * 制度の解説で、**電文ごとに変わらない固定文**。実電文はこの何倍も長く、帯では畳んで出す。
 * 3 種別で同じ文が来るので、テストデータでも 1 つを共有する。
 */
const NANKAI_APPENDIX = '＊＊　（参考）　南海トラフ地震に関連する情報の種類　＊＊\n【南海トラフ地震臨時情報】\n情報発表条件：\n○南海トラフ沿いで異常な現象が観測され、その現象が南海トラフ沿いの大規模な地震と関連するかどうか調査を開始した場合、または調査を継続している場合\n○観測された異常な現象の調査結果を発表する場合'

export function createTestNankai(kindName: '調査中' | '巨大地震注意' | '巨大地震警戒'): JMANankai {
  const now = serverDate().toISOString()
  const kindCodeMap: Record<string, string> = {
    '調査中': '111', '巨大地震注意': '130', '巨大地震警戒': '120',
  }
  // 見出し文（`Head/Headline/Text` 相当）。本文が長いので、帯では要約を先に出す。
  const summaryMap: Record<string, string> = {
    '調査中': '本日１６時４３分頃に発生した地震と南海トラフ地震との関連性についての調査を開始しました。南海トラフ地震で被害が想定される地域の方は、個々の状況に応じて、身の安全を守る行動を取ってください。',
    '巨大地震注意': '本日１６時４３分頃に日向灘を震源とするマグニチュード７．１の地震が発生しました。南海トラフ地震の想定震源域では、大規模地震の発生可能性が平常時に比べて相対的に高まっていると考えられます。今後の政府や自治体などからの呼びかけ等に応じた防災対応をとってください。',
    '巨大地震警戒': '本日１６時４３分頃に駿河湾を震源とするマグニチュード８．０の地震が発生しました。南海トラフ地震の想定震源域では、大規模地震の発生可能性が平常時に比べて相対的に高まっていると考えられます。今後の政府や自治体などからの呼びかけ等に応じた防災対応をとってください。',
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
    kindCode: kindCodeMap[kindName] ?? '111',
    kindName,
    headline: `南海トラフ地震臨時情報（${kindName}）`,
    body: bodyMap[kindName] ?? '',
    summary: summaryMap[kindName] ?? '',
    // 次回発表予定（`Body/NextAdvisory` 相当）。**続報を待つべきかの判断がここにしか無い。**
    nextAdvisory: '今後は、「南海トラフ地震関連解説情報」で地殻活動の状況等を発表します。次回の情報発表は、２１時頃を予定しています。\n　なお、新たな変化を観測した場合には随時発表します。',
    appendix: NANKAI_APPENDIX,
    earthquakeInfoKind: '南海トラフ地震臨時情報',
    earthquakeInfoType: '南海トラフ地震に関連する情報',
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
    // **次回発表予定は臨時解説だけが持つ。** 実電文の定例解説（VYSE52）8 通に `NextAdvisory` は
    // 1 件も無い。持たせると、実電文では出ない欄をテストボタンが見せることになる。
    ...(isAdHoc && {
      nextAdvisory: '今後も、「南海トラフ地震関連解説情報」で地殻活動の状況等を発表します。次回の情報発表は、１２日１５時３０分頃を予定しています。\n　なお、新たな変化を観測した場合には随時発表します。',
    }),
    appendix: NANKAI_APPENDIX,
    earthquakeInfoKind: '南海トラフ地震関連解説情報',
    earthquakeInfoType: '南海トラフ地震に関連する情報',
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
    summary: '本日１６時５２分に三陸沖を震源とするモーメントマグニチュード（Ｍｗ）７．４の地震が発生しました。この地震の発生により、北海道の根室沖から東北地方の三陸沖にかけての巨大地震の想定震源域では、新たな大規模地震の発生可能性が平常時と比べて相対的に高まっていると考えられます。今後の政府や自治体などからの呼びかけ等に応じた防災対応をとってください。',
    appendix: '＊＊　（参考）　北海道・三陸沖後発地震注意情報について　＊＊\n　日本海溝・千島海溝沿いの領域では、Ｍｗ７から９のさまざまな規模の地震が多数発生しており、過去の最大クラスの津波は約３百から４百年間隔で発生しています。１７世紀に発生した津波からの経過時間を考えると、当該地域では最大クラスの津波を伴う地震が切迫している状況にあるとされています。',
    earthquakeInfoKind: '北海道・三陸沖後発地震注意情報',
    earthquakeInfoType: '北海道・三陸沖後発地震注意情報',
    body: '三陸沖でマグニチュード7.4の地震が発生しました。この地震は、北海道・三陸沖後発地震注意情報の発表基準を満たしています。今後、大規模地震の発生可能性が平常時より高まっています。海岸付近や川沿いにいる方は、念のため高台へ移動するなど、防災対応の確認をしてください。',
    cancelled: false,
    reportDateTime: now,
    expireAt,
  }
}

/**
 * 気象庁の本文が使う全角数字へ直す。
 *
 * 電文の自由文は数字も全角で書かれる（「８月２４日１５時過ぎから」）。テストデータだけ半角にすると、
 * 読み上げの読み仮名辞書や折り返しの見え方が実電文と変わってしまう。
 */
function toFullWidthDigits(n: number): string {
  return String(n).replace(/[0-9]/g, d => String.fromCharCode(d.charCodeAt(0) + 0xfee0))
}

/**
 * 地震・津波に関するお知らせ（VZSE40）のテストデータ。
 *
 * 気象庁公式のサンプル電文（`42_01_01_100514_VZSE40.xml`＝沖縄県の震度データ入電停止）を
 * 元にしている。**記書きの体裁をそのまま持たせる** —— 本文は改行と全角スペースで
 * 「記」「＊入電停止期間＊」を組んでおり、詰めた文字列を置くと帯の中で崩れて見える形を
 * 実機で一度も確かめられない。
 *
 * 日付は実行時刻から起こす（入電停止は翌日、といった近い未来を指す情報のため）。
 */
export function createTestQuakeNotice(): JMAQuakeNotice {
  const nowDate = serverDate()
  const now = nowDate.toISOString()
  const eventId = toEventIdTimestamp(nowDate)
  const tomorrow = new Date(serverNow() + 24 * 3600 * 1000)
  const md = `${toFullWidthDigits(tomorrow.getMonth() + 1)}月${toFullWidthDigits(tomorrow.getDate())}日`
  return {
    // 実電文と同じ形の id にする（`Serial` は空なのでパーサーが '1' へ倒す）
    id: `dmdata-quake-notice-${eventId}-1`,
    time: now,
    eventId,
    headline: '沖縄県の震度データ入電停止のお知らせ',
    body: [
      '　◆沖縄県の震度データ入電停止のお知らせ◆',
      '',
      '　沖縄県で沖縄県本庁舎の電力設備点検のため、下記期間停電となります。',
      '　停電期間中は、震度を扱うシステムの運用を停止するため、当該自治体の',
      '震度データは気象庁に入電せず、気象庁発表の地震情報に反映できないので',
      'お知らせします。',
      '',
      '',
      '　　　　　　　　　　　　　　　　記',
      '',
      '＊入電停止期間＊',
      '',
      `　　　　　　　　${md} 08:00 から 20:00`,
      '',
      '',
      '　なお、沖縄県内69点の全震度観測点のうち入電しない自治体震度',
      '観測点は、35点です。',
    ].join('\n'),
    cancelled: false,
    reportDateTime: now,
    // 7 日で畳む（帯を常駐させないための表示上の都合。気象庁が定めた期限ではない）
    expireAt: new Date(serverNow() + 7 * 24 * 3600 * 1000).toISOString(),
  }
}

/**
 * 地震回数に関する情報（VXSE60）のテストデータ。
 *
 * 気象庁公式のサンプル電文（`32-35_03_01_100514_VXSE60.xml`＝2008 年の伊豆半島東方沖の群発）
 * の区間構成と回数をそのまま使い、時刻だけ実行時刻から起こす。
 *
 * **回数の内訳を崩さない** —— 区間ごとの 1587 + 35 + 35 + 47 が累積の 1704 に一致する。
 * 適当な数字を置くと、累積行が他の行の合計だと分かる形を実機で確かめられない。
 */
export function createTestEarthquakeCount(): JMAEarthquakeCount {
  const nowMs = serverNow()
  const hour = 3600 * 1000
  const iso = (deltaHours: number) => new Date(nowMs + deltaHours * hour).toISOString()
  const startDate = new Date(nowMs - 21 * hour)
  // eventId は群発の始まりを指す（サンプルの EventID も最初の地震のころを指している）
  const eventId = toEventIdTimestamp(startDate)
  const nowIso = new Date(nowMs).toISOString()
  const next = new Date(nowMs + 6 * hour)
  return {
    id: `dmdata-quake-count-${eventId}-1`,
    time: nowIso,
    eventId,
    headline: '地震回数に関する情報をお知らせします。',
    items: [
      { type: '地震回数',       startTime: iso(-21), endTime: iso(-3), number: 1587, feltNumber: 1 },
      { type: '１時間地震回数', startTime: iso(-3),  endTime: iso(-2), number: 35,   feltNumber: 0 },
      { type: '１時間地震回数', startTime: iso(-2),  endTime: iso(-1), number: 35,   feltNumber: 0 },
      { type: '１時間地震回数', startTime: iso(-1),  endTime: iso(0),  number: 47,   feltNumber: 0 },
      { type: '累積地震回数',   startTime: iso(-21), endTime: iso(0),  number: 1704, feltNumber: 1 },
    ],
    nextAdvisory: `次の「地震回数に関する情報」は、${toFullWidthDigits(next.getDate())}日${toFullWidthDigits(next.getHours())}時００分頃に発表します。`,
    freeText: `　${toFullWidthDigits(startDate.getMonth() + 1)}月${toFullWidthDigits(startDate.getDate())}日${toFullWidthDigits(startDate.getHours())}時過ぎから伊豆半島東方沖で地震が発生しています。この
付近で発生した地震については、震度３以上の場合は「震源・震度情報」で
発表しますが、震度２以下の場合は、「地震回数に関する情報」（本情報）
で地震回数をまとめて発表します。`,
    cancelled: false,
    reportDateTime: nowIso,
    // 7 日で畳む（帯を常駐させないための表示上の都合。気象庁が定めた期限ではない）
    expireAt: new Date(nowMs + 7 * 24 * hour).toISOString(),
  }
}

/**
 * 地震回数に関する情報の取消。
 *
 * **取消電文は回数の表を持たない。** 気象庁公式のサンプル（`32-35_10_02_220510_VXSE60.xml`）は
 * 見出しと本文だけで、`Item` も次回発表予定も自由文も無い。同じ形にする —— 発表報を使い回して
 * `cancelled` だけ立てると、実電文に存在しない「回数の表を持つ取消」ができる。
 *
 * **理由（`Body/Text`）が届く先は読み上げだけ。** この種別は取消で帯ごと消えるため
 * （`applyEarthquakeCount`）、地震・津波・EEW のようにカードへ残せない。読み上げでしか
 * 確かめられないので、テストボタンが無いと理由の文が一度も声にならない。
 *
 * @param base 取り消す対象の発表報（`eventId` で照合するので同じ群発のものを渡す）
 */
export function createTestEarthquakeCountRetraction(base: JMAEarthquakeCount): JMAEarthquakeCount {
  const now = new Date(serverNow()).toISOString()
  return {
    id: `${base.id}-cancel`,
    time: now,
    eventId: base.eventId,
    headline: '地震回数に関する情報を取り消します。',
    items: [],
    cancelled: true,
    cancelText: '先ほどの、地震回数に関する情報を取り消します。',
    reportDateTime: now,
    expireAt: base.expireAt,
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
    // **この電文の本文がいちばん効く場面。** 津波予報（若干の海面変動）では区域に波高も
    // 到達時刻も付かない（上の `areas` を見れば分かる）ので、いつ来ていつまで続くかは
    // ここにしか無い。DMDSS 経路（XML）でのみ届く。
    bodyText: withDmdssFields
      ? '若干の海面変動が予想される時刻は、早い沿岸で０８日１０時３０分頃です。\n　これらの沿岸では今後２、３時間程度は若干の海面変動が継続する可能性が高いと考えられます。'
      : undefined,
  }
}

// 誤報取消（InfoType=取消 相当）のテスト。警報・注意報混在の発表後、90秒後に電文全体が取り消される。
/**
 * 大津波警報の続報で、**区域ごとに等級が動く**報（一部解除・一部引き上げ）。
 *
 * 気象庁は一部解除でも区域を電文から消さず、「大津波警報 → 津波警報」のような降格として
 * 載せる。**全体の最上位等級だけを見ていると変化が見えない** —— 他の区域に警報が残る限り
 * `tsunamiMaxGrade` は動かないため、区域が持つ前回の等級（`LastKind`）でしか分からない
 * （→ docs/spec/tsunami-spec.md §10「区域単位で等級が動いた報」）。
 *
 * 4 通りとも入れる。**降格だけだと引き上げ側の表示（`isTsunamiGradeRaised`）が一度も通らない。**
 *   岩手県・福島県 … 大津波警報 → 津波警報（降格）
 *   青森県太平洋沿岸 … 津波警報 → 津波注意報（降格）
 *   茨城県 … 津波警報 → 大津波警報（引き上げ）
 *   北海道太平洋沿岸東部 … 津波注意報 → 津波予報（若干の海面変動。最も軽い降格）
 * 宮城県だけは据え置き —— 動いた区域にだけ印が付くことを確かめるための対照。
 *
 * **`Unknown` の区域は作らない。** 解除相当のコード（50/60/00）が付いた区域は
 * `parseTsunamiFromXml` が `continue` で捨てるため、内部型の `areas` に残ることがない
 * （`grade: 'Unknown'` は「読めなかった」を表す内部値で、電文の等級ではない）。
 * 完全に解除された区域は**一覧から消える**のが実運用の形。
 *
 * **DMDATA 経路のみ。** `lastGrade` は P2PQuake が配信しないので、standard 版で押しても
 * 印は出ない（ボタン自体を DMDSS 版に限っている）。
 *
 * @param base 続報の元になる発表報（`eventId` と観測点を引き継ぐ）
 */
export function createTestTsunamiGradeChange(base: JMATsunami): JMATsunami {
  const now = new Date(serverNow()).toISOString()
  // 区域名 → 続報での等級と予想波高。**波高も等級に合わせて下げる** ―― 降格したのに
  // 「10m以上」が残ると、カードの中で等級と高さが食い違う。
  const next: Record<string, { grade: TsunamiGrade; description?: string; value?: number }> = {
    '岩手県': { grade: 'Warning', description: '3m', value: 3.0 },
    '福島県': { grade: 'Warning', description: '3m', value: 3.0 },
    '青森県太平洋沿岸': { grade: 'Watch', description: '1m', value: 1.0 },
    '茨城県': { grade: 'MajorWarning', description: '5m', value: 5.0 },
    // 津波予報の区域は予想波高を持たない（実電文でも `MaxHeight` が付かない）
    '北海道太平洋沿岸東部': { grade: 'Forecast' },
  }
  return {
    ...base,
    id: `${base.id}-2`,
    time: now,
    issue: { ...base.issue, time: now },
    areas: base.areas.map(a => {
      const n = next[a.name]
      if (!n) return a
      return {
        ...a,
        grade: n.grade,
        lastGrade: a.grade,
        // 「ただちに来襲」は大津波警報・津波警報の区域に付く印。降格したら落とす
        immediate: n.grade === 'MajorWarning' || n.grade === 'Warning' ? a.immediate : false,
        ...(n.description
          ? { maxHeight: { description: n.description, value: n.value } }
          : { maxHeight: undefined }),
      }
    }),
  }
}

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
    // 電文が名乗る情報名（`Head/Title`）。**DMDSS 版でのみ来る**（P2PQuake の JSON には無い）。
    // 値は実電文の形に合わせ、**その報が出している等級を並べる**（VTSE41 の実電文 8 通で
    // 「津波注意報・津波予報」「大津波警報・津波警報・津波注意報」等が確認できる）。
    infoName: withDmdssFields ? '津波注意報' : undefined,
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
    // 情報名は**その報が出している等級を並べる**（→ `createTestTsunamiWatch`）。
    // この報は警報と注意報の両方を出しているので、実電文と同じく 2 つ並べる。
    infoName: withDmdssFields ? '津波警報・津波注意報' : undefined,
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
    // 情報名は**その報が出している等級を並べる**（→ `createTestTsunamiWatch`）。
    infoName: withDmdssFields ? '大津波警報・津波警報・津波注意報' : undefined,
    // 観測状況を確定した時刻（`Head/TargetDateTime`）。観測情報（VTSE51/52）でのみ入り、
    // **発表時刻よりさかのぼる**（実電文で VTSE52 は 60〜360 秒・VTSE51 は 0〜120 秒）。
    // 2 分前を入れて「観測 ◯◯ 時点」の表示を確かめられるようにする（発表時刻と同じ分では
    // 表示側が意図どおり出さない）。
    //
    // **これは「電文 1 通」ではなく「続報をマージした後のカードの状態」。** 等級の名乗り
    // （VTSE41 由来）と観測時点（VTSE51/52 由来）が同居しているのはそのため —— `useEarthquakes`
    // の続報処理は `infoName` を最新の報から取り、観測時点は `?? current` で前報から引き継ぐので、
    // 等級の発表が最後に来た実運用でこの組み合わせになる。**電文としてあり得ない形ではない。**
    observationDateTime: withDmdssFields ? t(-2) : undefined,
    issue: { source: 'テスト', time: nowIso, type: 'Focus' },
    // ── ここから下は DMDATA XML 経路にしかない ──
    //
    // P2PQuake の `parseTsunami` が作るのは `kind` / `id` / `time` / `cancelled` / `issue` /
    // `areas` だけで、区域の中身も `grade` / `immediate` / `name` / `firstHeight` /
    // `maxHeight` に限られる。**観測点も沖合推定も原因地震も本文も付加文も配信されない。**
    // standard 版で押したときにそれらが画面へ出ると、実機では決して起きない絵になる。
    ...(withDmdssFields ? {
    warningComment: 'ただちに高台へ避難してください。\n津波は繰り返し襲ってきます。警報が解除されるまで安全な場所から離れないでください。',
    // 電文の本文（`Body/Text` 相当）。等級の定型文とも自由付加文とも別で、同じ電文に 3 つとも入る。
    bodyText: '津波の第一波は、早い沿岸で０８日０３時３５分頃に到達すると予想されます。\n　これらの沿岸では今後１日程度は津波が継続する可能性が高いと考えられます。',
    // 自由付加文。等級ごとの定型文（上の `warningComment`）と違い、電文ごとに書き起こされる。
    // 実電文と同じく見出しの角括弧と全角スペースの整形を含める（画面が改行と空白を保つことの確認）。
    freeText: '［予想される津波の高さの解説］\n予想される津波が高いほど、より甚大な被害が生じます。\n　１０ｍ超　　木造家屋が全壊・流失し、人は津波による流れに巻き込まれます。\n　　１ｍ　　　海の中では人は流されます。',
    // M8 を超える地震では規模を速報できないため、気象庁は「Ｍ８を超える巨大地震」と書き、
    // 予想波高も数値ではなく「巨大」で発表する（下の岩手県）。**第一報で最も起きる形**なので
    // テストにも入れておく。2 件目は、短い間に起きた地震がまとめて 1 通で届く場合の形。
    // 震源要素は実電文と同じ一式を入れる（座標・深さ・地震発現時刻・規模の種別）。
    // 2 件目は気象庁以外の機関が決めた震源なので `type="M"`・`Source` が付き、震央補助表現には
    // その材料（`MarkCode` / `Direction` / `Distance`）が伴う。
    sourceEarthquakes: [
      {
        hypocenterName: '三陸沖', magnitudeCondition: 'Ｍ８を超える巨大地震', magnitudeType: 'Mj',
        originTime: nowIso, arrivalTime: nowIso,
        code: '213', latitude: 38.1, longitude: 143.9, depth: 24,
      },
      {
        hypocenterName: '岩手県沖', magnitude: 7.2, magnitudeType: 'M',
        originTime: t(-3), arrivalTime: t(-3), source: 'ＰＴＷＣ',
        code: '215', latitude: 39.6, longitude: 143.2, depth: 10,
        nameFromMark: '宮古の東１２０ｋｍ付近', markCode: '203', direction: '東', distanceKm: 120,
      },
    ],
    } : {}),
    // name は地図の海岸線表示用に、津波予報区データ（tsunami-zones.json）に実在する区域名を使用する
    // 2011年東北地方太平洋沖地震を参考にした発令内容
    // code は津波予報区コード（テスト用の仮値）。observations の districtCode と一致させて紐づけを確認する
    areas: ([
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
        // 大津波警報の区域で予想波高が初めて数値になった／上方修正された合図（電文の
        // `MaxHeight/Condition` = 重要）。観測・推定の「重要」とは意味が違う
        forecastHeightImportant: true,
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
    ] as TsunamiArea[]).map(a => withDmdssFields ? a : toP2pTsunamiArea(a)),
    ...(withDmdssFields ? {
    // 観測状態（`condition`）は電文の `Condition` に現れる組み合わせを一通り含める。
    // 気象庁は「重要 欠測」「微弱 欠測」のように複数を併記するため（電文解説資料 Ⅱ.12）、
    // 単独の状態しか置かないとカード・地図・読み上げの併記の扱いが一度も通らない。
    observations: [
      { name: '宮古',   districtCode: '030', districtName: '岩手県',           height: { value: 8.5, description: '8.5m以上', over: true }, arrivalTime: nowIso, initial: '押し', maxHeightDateTime: t(4), firstHeightRevise: '追加' },
      // これまでの最大波を観測した後に観測が途切れた観測点（値と欠測が同時に来る形）。
      { name: '大船渡', districtCode: '030', districtName: '岩手県',           height: { value: 3.2, description: '3.2m以上', over: true }, arrivalTime: t(-5), initial: '押し', condition: { maxHeightMissing: true, important: true } },
      { name: '石巻港', districtCode: '040', districtName: '宮城県',           height: { value: 7.2, description: '7.2m' }, arrivalTime: nowIso, initial: '押し', maxHeightDateTime: t(6), maxHeightRevise: '更新', firstHeightRevise: '更新' },
      // 到達は確認できたが最大波が欠測（波高の数値が無い）。
      { name: '相馬',   districtCode: '050', districtName: '福島県',           arrivalTime: t(-2), initial: '押し', condition: { maxHeightMissing: true } },
      // 第1波も最大波も欠測（到達したかどうかも判っていない）。
      { name: 'いわき市小名浜', districtCode: '050', districtName: '福島県',   condition: { firstHeightMissing: true, maxHeightMissing: true } },
      // 水位が上昇中の観測点。波高の数値が消えないことの確認を兼ねる。
      { name: '大洗',   districtCode: '070', districtName: '茨城県',           height: { value: 2.1, description: '2.1m' }, arrivalTime: t(20), initial: '押し', condition: { rising: true } },
      { name: '八戸港', districtCode: '060', districtName: '青森県太平洋沿岸', height: { value: 1.8, description: '1.8m' }, arrivalTime: nowIso, initial: '引き' },
      // 第1波の到達時刻が読み取れなかった観測点（`FirstHeight/Condition` = 第１波識別不能）。
      // **欠測とは別物** —— 津波は観測できていて到達も確定しており、時刻だけが出せない。
      // 時刻の欄に「到達時刻不明」と理由が出る（`utils/tsunami.ts` の
      // `observationArrivalFallbackText`）。到達確認の扱いは欠測と違って抑制しない。
      { name: '久慈港', districtCode: '030', districtName: '岩手県', height: { value: 4.4, description: '4.4m' }, initial: '押し', maxHeightDateTime: t(3), condition: { firstWaveUnidentifiable: true } },
      // 津波注意報の区域で、これまでの最大波がごく小さい（数値を発表しない）。
      { name: '釧路',   districtCode: '080', districtName: '北海道太平洋沿岸東部', arrivalTime: t(30), initial: '押し', condition: { weak: true } },
      // 沖合の潮位観測点。「重要」の基準が沿岸と違う（大津波警報だけでなく津波警報も含む）ため、
      // 出所の印（offshore）を付けてバッジの語が切り替わることを確かめられるようにする。
      { name: '沖合40km', offshore: true, sensor: 'ＧＮＳＳ波浪計', height: { value: 3.0, description: '3.0m以上', over: true }, arrivalTime: nowIso, condition: { important: true }, maxHeightDateTime: t(2) },
      // 「観測中」のまま Revise が「更新」。大津波警報の区域に対応する沖合の観測点で、沿岸で
      // 推定される高さが 3m 超に届かないときの形で、**津波警報に相当する津波を観測している**
      // ことを気象庁が示す（電文解説資料 Ⅱ.13 1-1-2-2-2）。値が変わらないので、アプリの
      // 「値の変化で判定する」仕組みでは作れない状態 —— テストボタンに無いと実機で一度も見られない。
      { name: '沖合80km', offshore: true, sensor: '水圧計', arrivalTime: t(-1), condition: { observing: true }, maxHeightRevise: '更新' },
    ],
    // 沖合の観測から導いた沿岸への推定（電文の `Estimation`）。沖合の観測点は沿岸より先に
    // 津波を捉えるため、**まだ到達していない沿岸**の到達予想と高さが入る。
    //
    // 3 件で実電文の形を一通り出す。
    //   岩手県 … 到達時刻と説明が併存し、基準を超えた合図（重要）が付く
    //   宮城県 … 潮位観測点で第1波を明瞭に観測できず、時刻が出せない
    //   福島県 … 予想される高さに比べ十分小さく、数値を発表しない（推定中）
    estimations: [
      {
        name: '岩手県', code: '030', arrivalTime: t(8),
        arrivalCondition: '早いところでは既に津波到達と推定',
        maxHeight: { description: '5m', value: 5.0 },
        condition: { important: true },
        maxHeightDateTime: t(8), firstHeightRevise: '追加', maxHeightRevise: '追加',
      },
      { name: '宮城県', code: '040', arrivalCondition: '早いところでは既に津波到達と推定', maxHeight: { description: '4m', value: 4.0 } },
      { name: '福島県', code: '050', arrivalCondition: '早いところでは既に津波到達と推定', condition: { estimating: true } },
    ],
    } : {}),
  }
}

/**
 * 推計震度分布図（IXAC41）のテスト。**地震情報と対で返す。**
 *
 * この電文は識別子を持たず、地震カードとの結び付けは発現時刻で行う（→ `utils/estimatedIntensity.ts`）。
 * 分布だけを流しても引き当てる相手のカードが無く、ボタンが出ない。**同じ地震の VXSE53 と
 * 一緒に**返して、実運用と同じ形（地震情報が先に出ていて、あとから分布が届く）を再現する。
 *
 * 中身は 2026-07-28 10:03 UTC の熊本県熊本地方 M4.2（最大震度5弱）の実電文を、本物の
 * パーサーと BUFR 復号器へ通して作ったもの（`npm run build-test-estimated-intensity`）。
 * **手では作れない** —— BUFR は二進で、セルは 1,693 個ある。
 *
 * セルの座標は**格子の整数添字**で持っている（緯度 1/480 度・経度 1/320 度にきっちり乗る）。
 * 小数で書くと桁が無駄なうえ、読み戻しで丸めが乗る。
 */
export function createTestEstimatedIntensity(): { quake: JMAQuake; estimated: JMAEstimatedIntensity } {
  const nowDate = serverDate()
  const now = nowDate.toISOString()
  const eventId = toEventIdTimestamp(nowDate)
  const src = testEstimatedIntensityJson as unknown as {
    quake: Omit<JMAQuake, 'id' | 'eventId' | 'time'>
    estimated: {
      hypocenter: { lat: number; lon: number; depthKm: number }
      magnitude: number | null
      magnitudeCondition?: string
      areaCode: number
      telegramKind: number
      grades: JMAEstimatedIntensityGrade[]
      latIdx: number[]; lonIdx: number[]; si: number[]
    }
  }

  const quake: JMAQuake = {
    ...src.quake,
    id: `dmdata-quake-${eventId}-1`,
    eventId,
    time: now,
    issue: { ...src.quake.issue, time: now },
    earthquake: { ...src.quake.earthquake, time: now },
  }

  const e = src.estimated
  const n = e.si.length
  const lat = new Float32Array(n)
  const lon = new Float32Array(n)
  const si = new Uint8Array(n)
  let south = 90, north = -90, west = 180, east = -180
  for (let i = 0; i < n; i++) {
    const la = e.latIdx[i] / (1 / CELL_LAT_DEG)
    const lo = e.lonIdx[i] / (1 / CELL_LON_DEG)
    lat[i] = la; lon[i] = lo; si[i] = e.si[i]
    if (la < south) south = la
    if (la > north) north = la
    if (lo < west) west = lo
    if (lo > east) east = lo
  }

  return {
    quake,
    estimated: {
      id: `test-ixac41-${eventId}`,
      time: now,
      // **地震カードと同じ発現時刻にする。** ここがずれると引き当てが外れ、ボタンが
      // 「このアプリの推定」のまま変わらない（テストとして無意味になる）。
      arrivalTime: now,
      hypocenter: e.hypocenter,
      magnitude: e.magnitude ?? NaN,
      ...(e.magnitudeCondition && { magnitudeCondition: e.magnitudeCondition }),
      areaCode: e.areaCode,
      telegramKind: e.telegramKind,
      grades: e.grades,
      count: n, lat, lon, si,
      bounds: { south, north: north + CELL_LAT_DEG, west, east: east + CELL_LON_DEG },
    },
  }
}
