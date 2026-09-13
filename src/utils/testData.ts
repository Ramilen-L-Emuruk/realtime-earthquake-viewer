import type { JMAQuake, JMATsunami, EEWAlert, EEWForecastChange, JMANankai, JMANankaiCommentary, JMAKohatsu, EarthquakePoint, JMALpgm, JMAQuakeCity, JMAQuakeNotice, JMAEarthquakeCount, JMAEstimatedIntensity, JMAEstimatedIntensityGrade, EEWRegion, TsunamiArea, TsunamiGrade, TelegramOperationStatus } from '../types/earthquake'
import { serverNow, serverDate } from './clock'
import { extractQuakeEventIdFromId } from './quakeMerge'
import { log } from './logger'
import notoHonshinPoints from '../data/noto-honshin-2024-points.json'
import notoHonshinQuake from '../data/noto-honshin-2024-quake.json'
import hyuganadaQuakeJson from '../data/hyuganada-2022-quake.json'
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

/**
 * 未入電テスト（日向灘 2022-01-22）のデータ。上と同じく実電文をパーサーへ通したもの。
 *
 * `createTestEarthquake` が能登本震のデータから点と市町村だけを取り出しているのと違い、
 * こちらは**電文が運ぶものをまるごと使う**（見出し文・付加文も含む）。報ごとに変わるもの
 * （識別子・発表時刻）だけをファクトリ側で作る。
 */
const hyuganadaQuake = hyuganadaQuakeJson as unknown as Omit<
  JMAQuake, 'kind' | 'id' | 'eventId' | 'time' | 'issue'
>

// テスト発報（EEW・津波）の自動解除までの時間。実発報の解除ロジックとは無関係の、テスト表示専用の固定値。
export const TEST_AUTO_DISMISS_MS = 90000

// eventId は DMDATA 電文が共有する14桁タイムスタンプ（YYYYMMDDHHmmss）形式。
// quake.id を `dmdata-quake-{eventId}-1` にすることで extractQuakeEventId が拾えるようにし、
// createTestLpgm が同じ eventId の長周期地震動データを lpgmByEventId に正しく紐づけられるようにする。
export function toEventIdTimestamp(d: Date): string {
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

/** 震源要素を訂正したことを伝える固定付加文（コード 0256）の原文。 */
const HYPOCENTER_AMEND_NOTE = '震源要素を訂正します。'

/**
 * 地震情報テストの固定付加文（その他）（`VarComment/Text`）。**DMDSS 版でだけ渡す。**
 *
 * 元にした実電文（能登本震 16:24 発表の VXSE53・報番号 2）が持つ 2 文を**そのまま渡す**。
 *
 * - 「震源要素を訂正します。」（コード 0256）—— 前の報から規模が変わったことを伝える。
 *   実電文では報番号 1（16:16 発表）が M7.4 で、この報が M7.6
 * - 「＊印は気象庁以外の震度観測点についての情報です。」（コード 0262）—— **震度を伝える電文の
 *   ほぼ全てに入る**（→ docs/spec/quake-spec.md §8「固定付加文（その他）…はそのまま出す」）
 *
 * **0256 が入っていても訂正報ではない。** 気象庁は震源要素の訂正を、`Head/InfoType` が「訂正」の
 * 報ではなく**報番号 2 の発表報＋この付加文**で伝えており、`issue.correct` は `'なし'` のまま。
 * DMDATA アーカイブの全期間（2020-11-18〜2026-09-12・地震と津波で 20,657 通）を走査すると、
 * 0256 を持つのは 28 通ですべて `InfoType=発表`・`Serial=2` だった（`InfoType=訂正` の地震情報は
 * 1 通も無い）。訂正報そのものの形は `createTestQuakeAmendment` が作る。
 *
 * **型が `string` でも `?? ''` を外さないこと。** 元データは `npm run build-test-quake` の
 * 生成物で、`VarComment` を持たない報を選べば**キーごと消える**（パーサーが `undefined` を返し
 * `JSON.stringify` が落とす）。空文字へ倒しておけば、`createTestEarthquake` の条件式が
 * `varCommentText: undefined` を渡さずに済む。欠落そのものは `testData.test.ts` の
 * 固定付加文まわりが明示的な失敗として知らせる。
 */
const NOTO_HONSHIN_VAR_COMMENT_TEXT = notoHonshinQuake.varCommentText ?? ''

/**
 * 訂正報テストの**初報**が持つ固定付加文（その他）を組む。訂正の一文（0256）だけを落とす。
 *
 * 実電文でも報番号 1（16:16 発表・M7.4）はこの一文を持たない —— 訂正はまだ起きていないため。
 * 初報から付けてしまうと、訂正前の報が訂正を名乗ることになる。
 *
 * **採る側ではなく落とす側を書くのは、気象庁が文を足したときに素通しさせるため。** 採る文を
 * 書き並べると、新しい付加文が届いてもテストボタンだけ古い形のまま残り、実機で一度も出ない。
 *
 * **引数で受け取るのは、訂正報の側と同じ値から組むため。** 定数から組むと、`createTestEarthquake`
 * が渡す中身が変わったときに初報だけ古い形で残る。
 */
function varCommentTextBeforeAmend(text: string | undefined): string {
  return (text ?? '')
    .split('\n')
    .filter((line) => line !== HYPOCENTER_AMEND_NOTE)
    .join('\n')
}


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
    // **識別子のフィールドは DMDSS 版だけが持つ。** 電文の `EventID` は DMDATA が配信するもので、
    // P2PQuake は配信しない（型定義の `JMAQuake.eventId`）。standard 版にも持たせると、
    // そのバリアントの実電文には無い形になる。
    ...(useDmdataShape && { eventId }),
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
    // `＊` が付いて届き、アプリは引き当てのために名前から外して持ち、表示するときに戻す
    // （→ `withNonJmaMark`）。気象庁が配る
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
      // 残すと標準版のテストボタンだけが実電文に無い `＊` を観測点名へ付ける。
      : (notoHonshinPoints as EarthquakePoint[])
        .filter((p) => !p.isArea)
        .map(({ nonJma: _nonJma, ...p }) => (UNRECEIVED_TEST_STATIONS.has(p.addr) ? { ...p, unreceived: true } : p)),
    // 市町村ごとの震度（電文の `Pref/Area/City`）。**DMDATA 経路でのみ配信される**ので
    // standard 版では持たせない（P2PQuake は市町村の粒度を配信しない）。
    //
    // **市町村の未入電（`City/Condition`）はこの報には入っていない。** 資料 Ⅱ.33 2-1-3-3-3 が
    // 出る条件を「配下に未入電の観測点があり、**かつ市町村の最大震度が震度4以下（又は入電なし）**」
    // と定めており、この報では未入電の 3 地点が属する市町村がいずれも震度6強・6弱で当たらない。
    // その形は `createTestUnreceivedQuake`（日向灘 2022-01-22）で確かめる
    // （→ docs/spec/quake-spec.md §5「市町村の震度」）。
    ...(useDmdataShape && { cities: notoHonshinQuake.cities as JMAQuakeCity[] }),
    // 固定付加文（その他）。**DMDATA 経路だけが運ぶ**ので standard 版では渡さない
    // （P2PQuake は付加文を配信しない）。中身の決め方は `NOTO_HONSHIN_VAR_COMMENT_TEXT`。
    ...(useDmdataShape && NOTO_HONSHIN_VAR_COMMENT_TEXT
      ? { varCommentText: NOTO_HONSHIN_VAR_COMMENT_TEXT }
      : {}),
  }
}

/** 訂正報テストで初報が名乗る規模。実電文の報番号 1（能登本震 16:16 発表）の値。 */
const AMENDMENT_BEFORE_MAGNITUDE = 7.4

/**
 * 訂正報テストで初報を流してから訂正報を流すまでの間隔。
 *
 * **変えたら設定タブの説明文（「3秒後に規模を訂正した報を流す」）も直すこと。** あちらから
 * この定数を参照させることはできない —— テストデータは押されてから読む作りで、設定タブが
 * 静的に取り込むとその分割が解ける（→ docs/spec/settings-pwa-spec.md §7「テストデータは
 * 押されてから読む」）。
 */
export const TEST_AMENDMENT_DELAY_MS = 3000

/**
 * 訂正報のテストデータ。**初報と、それを訂正する報の 2 通**を返す。
 *
 * 訂正報（`Head/InfoType` が「訂正」の報）は、カードに「訂正」の印を出し、DMDSS 版では
 * 何を訂正したかを固定付加文の原文と並べて見せる（→ docs/spec/quake-spec.md §6.2・§8）。
 * **その見え方を実機で確かめられる入口がここしかない。**
 *
 * **訂正報は実配信の標本を持たない。** DMDATA アーカイブの全期間（2020-11-18〜2026-09-12・
 * 地震と津波で 20,657 通）にも、気象庁公式のサンプル電文（地震・津波関連 184 件）にも
 * `InfoType` が「訂正」の地震情報は 1 通も無い。気象庁が実際に震源要素の訂正を伝えるときは、
 * 訂正報ではなく**報番号 2 の発表報＋固定付加文 0256**（→ `NOTO_HONSHIN_VAR_COMMENT_TEXT`）。
 * そのためこのデータは**アプリが読み取れる形から組んだ仮のもの**で、リプレイでも再現できない。
 *
 * **訂正の中身だけは実電文どおり。** 能登本震の報番号 1（16:16 発表）は M7.4、報番号 2
 * （16:24 発表）が M7.6 で、規模が訂正されている。初報と訂正報の差をこれに合わせた。
 *
 * 報ごとに進めるもの・進めないものは §7「実電文の形に合わせる」に従う —— 報番号（`id` の末尾）と
 * 発表時刻は進め、**地震の時刻（`earthquake.time`）と識別情報（`eventId`）は動かさない**。
 * 動かすと 2 通目が別の地震として立ち、訂正が同じカードへ届かない。
 */
export function createTestQuakeAmendment(useDmdataShape: boolean): { initial: JMAQuake; amended: JMAQuake } {
  const base = createTestEarthquake(useDmdataShape)
  const eventId = extractQuakeEventIdFromId(base.id)
  // **`createTestEarthquake` が 14 桁の識別情報を持つ `id` を作る限り null にならない。**
  // それでも黙って落とさないのは、この分岐が「報番号を進めない」という形の劣化にしか
  // 現れないため —— カードは 1 枚に統合されたままなので、画面を見ても気づけない。
  if (!eventId) log.error('[test] 地震テストの id から識別情報を読めなかった（訂正報の報番号を進められない）', { id: base.id })
  const initial: JMAQuake = {
    // **`points` と `cities` は初報・訂正報で同じ配列を共有する**（元データそのものを指す）。
    // 下流はこれらを読むだけで、並べ替えも絞り込みも新しい配列を作って返す。
    // 破壊的に扱う処理を足すなら、ここで浅いコピーを取ること。
    ...base,
    earthquake: {
      ...base.earthquake,
      hypocenter: { ...base.earthquake.hypocenter, magnitude: AMENDMENT_BEFORE_MAGNITUDE },
    },
    // 初報は訂正の一文を持たない（→ `varCommentTextBeforeAmend`）。
    // **`base` が付加文を持つときは、落とした結果が空でも必ず上書きする。** 空なら渡さない形に
    // すると、元データが訂正の一文しか持たなくなった日に `base` の値がそのまま残り、
    // 初報が訂正を名乗る（画面には空文字の枠は出ないので、上書きして困ることはない）。
    ...(base.varCommentText === undefined
      ? {}
      : { varCommentText: varCommentTextBeforeAmend(base.varCommentText) }),
  }
  const amendedTime = new Date(new Date(base.time).getTime() + TEST_AMENDMENT_DELAY_MS).toISOString()
  const amended: JMAQuake = {
    ...base,
    // 報番号を進める。**`eventId` は初報と同じものを使う** —— ここが変わると別カードになる。
    ...(eventId ? { id: `dmdata-quake-${eventId}-2` } : {}),
    time: amendedTime,
    issue: {
      ...base.issue,
      time: amendedTime,
      // 何を訂正したかは固定付加文のコードから読む。DMDATA 経路が返しうるのは
      // 「震源を訂正」（0256 あり）か「訂正」（コードを読めない）の 2 つだけで、
      // P2PQuake が持つ 5 値とは揃わない（→ docs/spec/quake-spec.md §6.2）。
      // standard 版でも同じ値にする —— P2PQuake は `DestinationOnly` として同じ事実を配信する。
      correct: '震源を訂正',
    },
  }
  return { initial, amended }
}

/**
 * 市町村の未入電を含む地震情報のテストデータ（2022-01-22 01:08 日向灘 M6.4 最大震度5強・第 2 報）。
 *
 * **`createTestEarthquake` では出ない形を出すためのもの。** 市町村の未入電（`City/Condition`）は
 * 2 通りに分かれ（→ docs/spec/quake-spec.md §5「市町村の震度」）、この報は両方を持つ。
 *
 * - **震度を観測できたうえで配下に未入電がある**（`hasUnreceived`）… 21 市町村
 * - **市町村の値そのものが未入電**（`unreceived`。下限の5弱へ寄せる）… 18 市町村
 *
 * 観測点の未入電も 60 地点あり、7 県 18 区域にまたがる。「震度を入手していない地点」の
 * ブロックが実運用でいちばん伸びる形でもある（能登本震は 3 地点）。
 *
 * **DMDSS 版のみ。** 市町村の粒度は DMDATA 経路でしか配信されない。
 */
export function createTestUnreceivedQuake(): JMAQuake {
  const nowDate = serverDate()
  const now = nowDate.toISOString()
  const eventId = toEventIdTimestamp(nowDate)
  return {
    ...hyuganadaQuake,
    kind: 'quake',
    id: `dmdata-quake-${eventId}-1`,
    // **`id` に埋め込むだけでなく、フィールドとしても持たせる。** `TsunamiTab` の原因地震リンクは
    // `id` から抜く経路（`extractQuakeEventId`）ではなく、このフィールドを直接見る（→ 型定義）。
    eventId,
    time: now,
    issue: { source: 'テスト', time: now, type: '震源・震度情報', correct: 'なし' },
    // 震源要素は実電文のまま。地震の時刻だけ「いま」へ寄せる（カードの並びと自動タブ切替が
    // 実運用と同じところを踏むようにするため）。
    earthquake: { ...hyuganadaQuake.earthquake, time: now },
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
    // 一度も画面に出ない**ので、1 点だけ立てて印（`＊`）が名前へ戻る経路 —— 地図の吹き出し
    // （`LpgmPointsGL`）とカードの長周期地震動の観測点の行 —— を実機で確かめられるようにする。
    //
    // **この観測点が実際に気象庁以外なのではない。** 読み取り後の形としては正しく
    // （パーサーは名前の `＊` を外してこの印を立て、表示側が `withNonJmaMark` で戻す）、
    // 表示経路を通すためだけに立てている。
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
// **種別コードの下 1 桁と `arrivalTime` は必ず噛み合わせる**（→ docs/spec/eew-spec.md §4
// 「到達予測時刻は種別によって意味が変わる」）。実電文にこの 3 通りしか無いためで、
// 外れた形を置くと「主要動の到達（予測）」の欄がテストボタンから出てこない。
//   00 / 10（未到達）   … 未来の `arrivalTime` を持つ。`arrived` は立てない
//   01 / 11（到達済み） … `arrivalTime` は `null`・`arrived: true`（時刻とは排他）
//   09 / 19（PLUM 法）  … 過去の `arrivalTime` を持つ（到達の予測ではなく「その震度を
//                          初めて予測した時刻」なので、画面は「時刻不明」と出す）
//
// **以下の数字は 1 つの走査から採っている**（このファイルの他の箇所はここを参照する）。
// 対象は DMDATA アーカイブの `eew.forecast`・2026-08-02〜09-12 の 42 日分で、
// そこに入っていた VXSE45 785 通・区域を持つ 95 通・区域 753 件。
//   - 区域の内訳は未到達 317 件・到達済み 358 件・PLUM 法 78 件で、**3 通りのどれかに
//     必ず当てはまった**。未到達と PLUM は全件が `ArrivalTime` を持ち、到達済みは全件が
//     時刻を持たず `Condition` を持っていた。**時刻も `Condition` も無い区域は 1 件も無い。**
//   - 区域の件数は電文全体の最大予想震度で変わる。震度4 の報 70 通が中央 3 件（最大 8 件）、
//     震度5弱 21 通が中央 24 件、震度5強 2 通が 35 件。**震度6弱以上の報は 1 通も無かった。**
//   - 震源距離 ÷（到達予測時刻 − 震源時刻）の中央は 4.4km/s（距離帯ごとに 4.2〜5.2km/s）。
//
// 到達までの秒数はこの見かけ速度で震源距離から作る。距離順に並べれば到達の欄が時間順になり、
// 震源に近い弱い区域が強い区域より先に来る形（欄の並びの肝）もそのまま再現される。
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
  const at = (offsetMs: number) => new Date(origin.getTime() + offsetMs).toISOString()
  const forecastChange: EEWForecastChange | undefined =
    serial <= 1 ? undefined
    : serial === 2 ? { maxInt: 1, maxLgInt: 0, reason: 2 }
    : { maxInt: 0, maxLgInt: 0, reason: 0 }
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
      // 気象庁の固定付加文（`Comments/WarningComment/Text`）。警報級の報には必ず入る
      warningComment: '強い揺れに警戒してください。',
      // 震央が内陸か海域か（`Hypocenter/Area/LandOrSea`）。実電文 405 通中 404 通に入る
      landOrSea: '海域',
      // 短縮用震央地名（`ReduceName`）。「日向灘」は元から短いので実電文でも同じ文字列になる
      reduceName: '日向灘',
      // 震源要素の精度（`Hypocenter/Accuracy`）。実電文の事例３（IPF法 3点／4点・P相/全相混在・3点）
      // に合わせる。**画面に語が出る組み合わせを選ぶ** —— 0（不明）だけを入れると欄が空のままで、
      // 表示できているかを実機で確かめられない
      accuracy: { epicenterRank: 3, epicenterRank2: 3, depthRank: 3, magnitudeRank: 4, magnitudePoints: 3 },
      // 最大予測値の変化（`Intensity/Forecast/Appendix`）。**実電文の形に合わせる** ――
      // 第 1 報は要素ごと無く、変化を言うのは 1 通だけで、次の報は値を 0 に戻してくる
      // （2026-06-01〜09-06 の実電文 334 イベントで確認。→ eew-spec.md §3「最大予測値の変化」）。
      //
      // **毎報「大きくなった」を立ててはいけない。** 帯が出続けるため、表示の寿命
      // （→ `RealtimeTab` の `useHeldForecastChange`）を実機で確かめられなくなる。
      // ボタンを 3 回押せば #3 で値が 0 に戻り、そこから 10 秒残って消えるところまで見られる。
      ...(forecastChange && { forecastChange }),
    } : {}),
    issue: { eventId: eid, serial: String(serial), time: report },
    // **区域はこの報の形（未到達ばかり）を受け持つ。** 到達済みの区域は震源から中央 98km の
    // ところに出る（上記の走査。p10 36km 〜 p90 183km）が、日向灘の震源から最寄りの陸域は
    // 66km で、押した時点＝震源時刻というテストの建て付けではまだどこにも届いていない。
    // **3 通りが混じった形は特別警報テスト（`createTestEEW`）が受け持つ。**
    //
    // **件数 24 は震度5弱の報の中央値**（上記の走査）。この電文の最大予想震度は 5 強だが、
    // そちらの標本は 2 通しかないので、厚いほうの値を採っている。**数件しか持たせないと
    // 実運用では起こらない少なさになる**うえ、到達の欄は件数が増えて初めて列に折り返すため、
    // その見え方も実機で確かめられない。
    //
    // 秒数は震源距離 ÷ 4.4km/s（上記）。距離順に並べてあるので到達の欄の並びとも一致する。
    areas: ([
      // 予想震度5弱以上の区域が警報域（種別コード 10）。押した直後から 20 秒以内で、
      // 残り秒数が赤くなる（`ARRIVAL_SOON_SEC`）のはこの 2 件
      { pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: at(15_000), lgIntTo: 3 },
      { pref: '宮崎県', name: '宮崎県南部平野部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: at(17_000), lgIntTo: 3 },
      { pref: '宮崎県', name: '宮崎県北部山沿い', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: at(21_000), lgIntTo: 2 },
      { pref: '宮崎県', name: '宮崎県南部山沿い', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: at(22_000), lgIntTo: 2 },
      // 予想震度4（5弱未満）は警報の対象外。同一電文内の予報域として送る
      { pref: '大分県', name: '大分県南部', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: at(26_000), lgIntTo: 2 },
      { pref: '熊本県', name: '熊本県球磨', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(26_000), lgIntTo: 1 },
      { pref: '鹿児島県', name: '鹿児島県大隅', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(29_000), lgIntTo: 1 },
      { pref: '熊本県', name: '熊本県阿蘇', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(31_000), lgIntTo: 1 },
      { pref: '大分県', name: '大分県中部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(33_000), lgIntTo: 1 },
      { pref: '鹿児島県', name: '鹿児島県薩摩', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(34_000), lgIntTo: 1 },
      { pref: '熊本県', name: '熊本県熊本', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(35_000), lgIntTo: 1 },
      { pref: '大分県', name: '大分県西部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(35_000) },
      // PLUM 法（種別コード 09）。**時刻は持つが到達の予測ではない**ので過去の時刻が入り、
      // 欄では「時刻不明」として末尾へ回る。実電文でも区域の 1 割ほどがこの形
      { pref: '高知県', name: '高知県西部', scaleFrom: 30, scaleTo: 40, kindCode: '09', arrivalTime: at(-3_000) },
      { pref: '愛媛県', name: '愛媛県南予', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(36_000) },
      // **区域に載る予測震度に下限は無い**（→ docs/spec/eew-spec.md §4）。警報の区域と震度 3 以下の
      // 区域は同じ電文に同居するので、ここに無いと弱い区域が並んだときの見え方（区域一覧・
      // 区域塗りの濃さ）を実機で一度も確かめられない。
      { pref: '熊本県', name: '熊本県天草・芦北', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(39_000) },
      { pref: '大分県', name: '大分県北部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(42_000) },
      { pref: '長崎県', name: '長崎県島原半島', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(42_000) },
      { pref: '福岡県', name: '福岡県筑後', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(44_000) },
      { pref: '鹿児島県', name: '鹿児島県種子島', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(45_000) },
      { pref: '愛媛県', name: '愛媛県中予', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(48_000) },
      { pref: '鹿児島県', name: '鹿児島県甑島', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(48_000) },
      { pref: '佐賀県', name: '佐賀県南部', scaleFrom: 30, scaleTo: 30, kindCode: '09', arrivalTime: at(-5_000) },
      // 予想震度2 の区域。実電文にもある（→ docs/spec/eew-spec.md §4 の階級別の表）
      { pref: '福岡県', name: '福岡県筑豊', scaleFrom: 20, scaleTo: 20, kindCode: '00', arrivalTime: at(50_000) },
      { pref: '長崎県', name: '長崎県南西部', scaleFrom: 20, scaleTo: 20, kindCode: '00', arrivalTime: at(51_000) },
    ] as const).map(a => withDmdssFields ? { ...a } : toP2pArea({ ...a })),
  }
}

// 予報（警報未満）の EEW。**電文全体の予想が震度 4 以上になって初めて区域の列挙が始まる**ので、
// 電文全体を震度 4 とし、区域もその値から組む（→ docs/spec/eew-spec.md §4）。
// **区域そのものに下限は無い**が、警報級のテスト（`createTestEEWWarning` / `createTestEEW`）で
// 震度 3 の区域を持たせてあるため、こちらは境目ちょうどの形を受け持つ。
export function createTestEEWForecast(withDmdssFields: boolean, eventId?: string, serial = 1, baseTime?: Date): EEWAlert {
  const origin = baseTime ?? serverDate()
  const report = serverDate().toISOString()
  const eid = eventId ?? `test-forecast-${Date.now()}`
  const at = (offsetMs: number) => new Date(origin.getTime() + offsetMs).toISOString()
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
    // **件数 3 はこの規模の報の中央値**（上記の走査。最大予想震度が震度4 の報 70 通）。
    // 強い地震のテストと違い、ここは少ない側の見え方を受け持つ。
    // 秒数は震源距離（深さ 60km 込み）÷ 4.4km/s（上記）。
    areas: ([
      { pref: '宮城県', name: '宮城県中部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(20_000) },
      { pref: '宮城県', name: '宮城県北部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(21_000) },
      { pref: '宮城県', name: '宮城県南部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(26_000) },
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
  const at = (offsetMs: number) => new Date(origin.getTime() + offsetMs).toISOString()
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
    // 固定付加文は警報級の報にだけ入る（実電文で予報級 7,615 通は 0 件。→ eew-spec.md §3
    // 「固定付加文」）。このボタンは初報＝予報級・続報＝警報級へ上がる形なので、
    // **格上げで初めて付加文が現れる**ところまで再現する。
    ...(withDmdssFields && !isAssumed ? { warningComment: '強い揺れに警戒してください。' } : {}),
    issue: { eventId: eid, serial: String(serial), time: report },
    // 初報に区域は載らない。続報で震源が確定して初めて地域別予想が付く
    // （秒数は震源距離 66km ÷ 4.4km/s。→ 上記の kindCode の説明）
    areas: isAssumed ? [] : ([
      { pref: '宮崎県', name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: at(15_000) },
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
    // 気象庁の固定付加文。**警報級の報には必ず入る**（実電文の警報級 380 通すべて。→ eew-spec.md §3
    // 「固定付加文」）ので、報番号によらず持たせる。この報は特別警報まで上がるため、
    // 警報級の色（特別警報の配色）での見え方をここでしか確かめられない。
    ...(withDmdssFields ? { warningComment: '強い揺れに警戒してください。' } : {}),
    issue: { eventId: eid, serial: String(serial), time: report },
    // 実データに合わせ areas を使用（参照は utils/eew.ts の eewAreas() で吸収）
    //
    // **standard 版の初報は区域を持たない。** Yahoo 強震モニタの hypoInfo が先に届き、
    // 区域は P2PQuake code=556 が後から注ぎ足す（`useEarthquakes.ts` の `enrichEEW`）ため、
    // 実運用でもこの順で画面に出る。ボタンを 2 回押すと注入後の形へ進む。
    // **種別コードの下 1 桁が主要動の状況を表す**（コード表 12。→ `utils/eewKind.ts`）。
    // 到達の欄はこれで表示が 3 通りに分かれるので、**このボタンが 3 種類とも受け持つ**
    // —— 実機で確かめられるのはここに在る形だけ。
    //
    // **件数 34 は、観測できた中でいちばん多い報と同じ規模**（上記の走査で震度5強の報が 35 件。
    // この電文は震度6強だが、**震度6弱以上の報は 1 通も走査に掛からなかった**ので、そこから
    // 直に採ることはできない）。震源に近い順に 34 区域を採ってある。到達の欄は件数が増えて
    // 初めて列に折り返すので（CSS `columns`）、少ないままだとその見え方と高さの圧迫を実機で
    // 確かめられない。並びは震源距離の順で、秒数は距離 ÷ 4.4km/s（上記）。
    areas: (!withDmdssFields && isFirstReport) ? [] : ([
      // 11 ＝ 警報・既に到達と推定。実電文は種別コードと `Condition` の両方で到達を伝えるので、
      // 読み取り後の値（`arrived`）も立てる。**到達予測時刻とは排他で、時刻は持たない。**
      // 震源にいちばん近い 2 区域に置いてある（実電文の到達済み区域は震源距離の中央が 98km）。
      { pref: '岩手県', name: '岩手県沿岸南部', scaleFrom: 50, scaleTo: 55, kindCode: '11', arrivalTime: null, arrived: true, lgIntTo: 3 },
      { pref: '宮城県', name: '宮城県中部', scaleFrom: 55, scaleTo: 60, kindCode: '11', arrivalTime: null, arrived: true, lgIntTo: 4 },
      {
        pref: '宮城県', name: '宮城県北部', scaleFrom: 55, scaleTo: 60, kindCode: '10',
        arrivalTime: at(38_000),
        // 震度は上限を定めず（「震度6強程度以上」）、長周期は初報で 1 段低い階級から始まる。
        ...(isFirstReport
          ? { scaleToOrAbove: true, lgIntTo: 3 as const, lgIntToOver: true }
          : { lgIntTo: 4 as const }),
      },
      { pref: '宮城県', name: '宮城県南部', scaleFrom: 50, scaleTo: 55, kindCode: '10', arrivalTime: at(43_000), lgIntTo: 3 },
      { pref: '福島県', name: '福島県浜通り', scaleFrom: 50, scaleTo: 55, kindCode: '10', arrivalTime: at(44_000), lgIntTo: 3 },
      { pref: '岩手県', name: '岩手県内陸南部', scaleFrom: 50, scaleTo: 55, kindCode: '10', arrivalTime: at(44_000), lgIntTo: 3 },
      { pref: '岩手県', name: '岩手県沿岸北部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: at(50_000), lgIntTo: 2 },
      { pref: '山形県', name: '山形県村山', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: at(53_000), lgIntTo: 2 },
      { pref: '福島県', name: '福島県中通り', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: at(53_000), lgIntTo: 2 },
      { pref: '山形県', name: '山形県最上', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: at(55_000), lgIntTo: 1 },
      { pref: '秋田県', name: '秋田県内陸南部', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: at(57_000), lgIntTo: 1 },
      { pref: '山形県', name: '山形県置賜', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: at(57_000), lgIntTo: 1 },
      // 19 ＝ 警報・PLUM 法。**時刻は持つが到達の予測ではない**（「震度を初めて予測した時刻」）
      // ので過去の時刻が入る。画面は残り秒数を出さず「時刻不明」と書き、並びの末尾へ回す。
      { pref: '岩手県', name: '岩手県内陸北部', scaleFrom: 40, scaleTo: 45, kindCode: '19', arrivalTime: at(-4_000), lgIntTo: 1 },
      { pref: '山形県', name: '山形県庄内', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(63_000), lgIntTo: 1 },
      { pref: '茨城県', name: '茨城県北部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(64_000), lgIntTo: 1 },
      { pref: '秋田県', name: '秋田県沿岸南部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(65_000) },
      { pref: '福島県', name: '福島県会津', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(65_000) },
      { pref: '栃木県', name: '栃木県北部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(70_000) },
      { pref: '秋田県', name: '秋田県内陸北部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(71_000) },
      // 09 ＝ 予報・PLUM 法。警報側（19）と同じ扱いで、こちらは予想震度5弱未満の区域に付く
      { pref: '青森県', name: '青森県三八上北', scaleFrom: 30, scaleTo: 40, kindCode: '09', arrivalTime: at(-6_000) },
      { pref: '新潟県', name: '新潟県下越', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(73_000) },
      { pref: '栃木県', name: '栃木県南部', scaleFrom: 30, scaleTo: 40, kindCode: '00', arrivalTime: at(73_000) },
      // **区域に載る予測震度に下限は無い**（→ docs/spec/eew-spec.md §4）。震度 3 の区域も同じ
      // 電文に載り、到達予測時刻も持つ。震源から遠いぶん残り秒数は最も大きく、到達の欄では
      // 未到達の群の末尾に並ぶ —— 弱い区域が強い区域より後ろへ回る形もここでしか実機で確かめられない。
      { pref: '秋田県', name: '秋田県沿岸北部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(75_000) },
      { pref: '茨城県', name: '茨城県南部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(75_000) },
      { pref: '千葉県', name: '千葉県北東部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(79_000) },
      { pref: '青森県', name: '青森県津軽南部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(81_000) },
      { pref: '千葉県', name: '千葉県北西部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(82_000) },
      { pref: '新潟県', name: '新潟県中越', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(84_000) },
      { pref: '青森県', name: '青森県津軽北部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(85_000) },
      { pref: '埼玉県', name: '埼玉県北部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(87_000) },
      { pref: '埼玉県', name: '埼玉県南部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(87_000) },
      { pref: '群馬県', name: '群馬県北部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(88_000) },
      { pref: '群馬県', name: '群馬県南部', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(88_000) },
      { pref: '東京都', name: '東京都２３区', scaleFrom: 30, scaleTo: 30, kindCode: '00', arrivalTime: at(88_000) },
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

/**
 * 津波テストの原因地震が起きてから、その津波電文を発表するまでの間（分）。
 *
 * **区域と観測点の到達時刻より前に置くこと。** `createTestTsunami` は第一波の到達を発表の
 * 6 分前まで、最大波の観測時点を 2 分前に置いている。原因地震をそれより後にすると、
 * **地震より前に津波が到達した**という実電文には無い並びになる。
 */
const TSUNAMI_ORIGIN_MIN_BEFORE = 10

/**
 * 津波テストの原因地震が発現した時刻。
 *
 * **津波電文の識別子（`EventID`）は原因地震のもの**で、津波電文はその地震の**あとに**
 * 発表される（→ tsunami-spec.md §4）。押した時刻をそのまま識別子にすると、
 * 「地震と津波警報が同じ瞬間」という形になるうえ、**同じ秒に押した地震テストと識別子が
 * 一致する** —— 実電文の識別子は事象ごとに一意なので、別々の地震が同じ値を持つことはない。
 * 一致すると、津波バナーの原因地震リンクが無関係な地震カードを指す。
 */
function tsunamiOriginDate(now: Date): Date {
  return new Date(now.getTime() - TSUNAMI_ORIGIN_MIN_BEFORE * 60000)
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
    eventId: withDmdssFields ? toEventIdTimestamp(tsunamiOriginDate(now)) : undefined,
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
 * 5 通りとも入れる。**降格だけだと引き上げ側の表示（`isTsunamiGradeRaised`）が一度も通らない。**
 *   岩手県・福島県 … 大津波警報 → 津波警報（降格）
 *   青森県太平洋沿岸 … 津波警報 → 津波注意報（降格）
 *   茨城県 … 津波警報 → 大津波警報（引き上げ）
 *   北海道太平洋沿岸東部 … 津波注意報 → 津波予報（若干の海面変動。最も軽い降格）
 *   青森県日本海沿岸 … 津波注意報 → **解除**（`cancelledAreas` へ移る）
 * 宮城県だけは据え置き —— 動いた区域にだけ印が付くことを確かめるための対照。
 *
 * **解除された区域は `areas` から外して `cancelledAreas` へ移す。** 気象庁は、その津波予報区で
 * もう何も発表しないときだけ解除コード（00/50/60）を付ける。`areas` に残すと、解除済みの区域を
 * 発表中として地図にも通知にも出すことになる（→ `JMATsunami.cancelledAreas`）。
 *
 * **DMDATA 経路のみ。** `lastGrade` は P2PQuake が配信しないので、standard 版で押しても
 * 印は出ない（ボタン自体を DMDSS 版に限っている）。
 *
 * **この報は津波警報等（VTSE41）の形にする。** 区域単位の等級変化を運ぶのはこの種別で、
 * 実電文では**潮位観測点（満潮時刻・到達予想時刻）を 1 件も載せず**、固定付加文も等級の
 * 呼びかけ 1 件だけを持つ。前の報の形をそのまま流用すると、続報のマージ
 * （`mergeTsunamiAreas` / `mergeTsunamiWarningComments`）が一度も通らず、**引き継ぎが効いて
 * いるかを実機で確かめられない** ―― 満潮時刻が残るか・避難の呼びかけが満潮の注記に
 * 差し替わらないかは、この形の続報を流して初めて画面に出る。
 *
 * @param base 続報の元になる発表報（`eventId` を引き継ぐ。観測点と満潮時刻はマージが継ぐ）
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
  // 解除される区域。`areas` から外して `cancelledAreas` へ移す（上の説明を参照）。
  const LIFTED_AREA_NAME = '青森県日本海沿岸'
  const lifted = base.areas
    .filter(a => a.name === LIFTED_AREA_NAME)
    // 解除された区域の `Item` は `Area` と `Category` しか持たない。予想波高・到達予想・
    // 潮位観測点を残すと実電文に無い形になる
    .map(a => ({
      grade: 'Unknown' as const, lastGrade: a.grade, immediate: false, name: a.name, code: a.code,
    }))
  return {
    ...base,
    id: `${base.id}-2`,
    time: now,
    issue: { ...base.issue, time: now },
    // 津波警報等は潮位観測点を運ばない種別。続報のマージが前報から継ぐ
    carriesForecastStations: false,
    // 観測・沖合の情報もこの種別には入らない。前報から継がれることを画面で確かめる
    observations: undefined,
    observationDateTime: undefined,
    estimations: undefined,
    // 固定付加文は等級の呼びかけだけ。満潮・観測・沖合の注記は前報のものが残る。
    // **実電文の原文**（2024-01-01 能登半島地震 20:30 の VTSE41）。**別の報から借りている**
    // —— 上の発表報と中身が違えば、同じ主題の枠が置き換わることを実機で確かめられる。
    // この報を選んだのは、1 行目が節の見出し（＜津波警報＞）で文になっていないから。バナーの
    // 行動指示はここから採れず、アプリ側の既定文へ落ちる（仕様書 §9）。上の発表報が採れる側
    // なので、2 つのボタンで両方の経路を通せる。
    warningComments: [{ key: 'VTSE41', text: '＜津波警報＞\n津波による被害が発生します。\n沿岸部や川沿いにいる人はただちに高台や避難ビルなど安全な場所へ避難してください。\n津波は繰り返し襲ってきます。警報が解除されるまで安全な場所から離れないでください。\n　\n＜津波注意報＞\n海の中や海岸付近は危険です。\n海の中にいる人はただちに海から上がって、海岸から離れてください。\n潮の流れが速い状態が続きますので、注意報が解除されるまで海に入ったり海岸に近づいたりしないようにしてください。\n　\n＜津波予報（若干の海面変動）＞\n若干の海面変動が予想されますが、被害の心配はありません。\n　\n警報が発表された沿岸部や川沿いにいる人はただちに高台や避難ビルなど安全な場所へ避難してください。\n到達予想時刻は、予報区のなかで最も早く津波が到達する時刻です。場所によっては、この時刻よりもかなり遅れて津波が襲ってくることがあります。\n到達予想時刻から津波が最も高くなるまでに数時間以上かかることがありますので、観測された津波の高さにかかわらず、警報が解除されるまで安全な場所から離れないでください。\n　\n場所によっては津波の高さが「予想される津波の高さ」より高くなる可能性があります。' }],
    cancelledAreas: lifted.length > 0 ? lifted : undefined,
    areas: base.areas.filter(a => a.name !== LIFTED_AREA_NAME).map(a => {
      const n = next[a.name]
      // 等級が動かない区域も、この種別では観測点を持たない（マージが前報から継ぐ）
      const withoutStations = { ...a, stations: undefined }
      if (!n) return withoutStations
      return {
        ...withoutStations,
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
    eventId: withDmdssFields ? toEventIdTimestamp(tsunamiOriginDate(nowDate)) : undefined,
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
    eventId: withDmdssFields ? toEventIdTimestamp(tsunamiOriginDate(nowDate)) : undefined,
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
    eventId: withDmdssFields ? toEventIdTimestamp(tsunamiOriginDate(nowDate)) : undefined,
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
  // **`tsunamiOriginDate` が返すのは発現時刻**（識別子の材料。関数の説明どおり）。
  // 発生時刻はそれより前で、実電文では分値まで有効。全期間の走査では 11.2% の電文で
  // 両者が 1 分ずれる（→ `docs/spec/tsunami-spec.md` §4）ので、**1 件目でその形を再現する**
  // —— 一致する形しか持たせないと、画面がどちらを出しているかテストボタンで区別できない。
  const arrivalIso = tsunamiOriginDate(now).toISOString()
  const originIso = new Date(tsunamiOriginDate(now).getTime() - 60000).toISOString()
  return {
    kind: 'tsunami',
    id: `test-tsunami-${Date.now()}`,
    eventId: withDmdssFields ? toEventIdTimestamp(tsunamiOriginDate(now)) : undefined,
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
    // 固定付加文。**種別ごとに別の話をするので 4 件そろう** —— このカードは等級の発表
    // （VTSE41）・満潮時刻（VTSE51）・沿岸の観測（VTSE51）・沖合の観測（VTSE52）をマージした
    // 後の状態なので、実運用でもこの 4 つが並ぶ。1 件だけ入れると、主題ごとに束ねる仕組みが
    // 効いているかを実機で確かめられない。鍵の作り方は `TsunamiWarningComment.key`。
    //
    // **4 件とも実電文の原文。** 避難行動は 2024-01-01 能登半島地震 16:22 の VTSE41
    // （＜大津波警報＞の節を含む報）、残り 3 件は 2026-04-20 三陸沖の連続報。
    //
    // **1 行目を近似で書かない。** バナーの行動指示はこの文の 1 行目をそのまま出すので
    // （`evacuationActionLine`）、近似を置くと**アプリの文が気象庁の文の顔をして画面に出る**。
    warningComments: [
      { key: 'VTSE41', text: 'ただちに避難してください。\n　\n＜大津波警報＞\n大きな津波が襲い甚大な被害が発生します。\n沿岸部や川沿いにいる人はただちに高台や避難ビルなど安全な場所へ避難してください。\n津波は繰り返し襲ってきます。警報が解除されるまで安全な場所から離れないでください。\n　\n＜津波警報＞\n津波による被害が発生します。\n沿岸部や川沿いにいる人はただちに高台や避難ビルなど安全な場所へ避難してください。\n津波は繰り返し襲ってきます。警報が解除されるまで安全な場所から離れないでください。\n　\n＜津波注意報＞\n海の中や海岸付近は危険です。\n海の中にいる人はただちに海から上がって、海岸から離れてください。\n潮の流れが速い状態が続きますので、注意報が解除されるまで海に入ったり海岸に近づいたりしないようにしてください。\n　\n＜津波予報（若干の海面変動）＞\n若干の海面変動が予想されますが、被害の心配はありません。\n　\n警報が発表された沿岸部や川沿いにいる人はただちに高台や避難ビルなど安全な場所へ避難してください。\n到達予想時刻は、予報区のなかで最も早く津波が到達する時刻です。場所によっては、この時刻よりもかなり遅れて津波が襲ってくることがあります。\n到達予想時刻から津波が最も高くなるまでに数時間以上かかることがありますので、観測された津波の高さにかかわらず、警報が解除されるまで安全な場所から離れないでください。\n　\n場所によっては津波の高さが「予想される津波の高さ」より高くなる可能性があります。' },
      { key: 'VTSE51|各地の満潮時刻・津波到達予想時刻に関する情報', text: '津波と満潮が重なると、津波はより高くなりますので一層厳重な警戒が必要です。' },
      { key: 'VTSE51|津波観測に関する情報', text: '津波による潮位変化が観測されてから最大波が観測されるまでに数時間以上かかることがあります。\n　\n場所によっては、観測した津波の高さよりさらに大きな津波が到達しているおそれがあります。\n　\n今後、津波の高さは更に高くなることも考えられます。' },
      { key: 'VTSE52', text: '沖合での観測値であり、沿岸では津波はさらに高くなります。' },
    ],
    // 電文の本文（`Body/Text` 相当）。等級の定型文とも自由付加文とも別で、同じ電文に 3 つとも入る。
    bodyText: '津波の第一波は、早い沿岸で０８日０３時３５分頃に到達すると予想されます。\n　これらの沿岸では今後１日程度は津波が継続する可能性が高いと考えられます。',
    // 自由付加文。種別ごとの定型文（上の `warningComments`）と違い、電文ごとに書き起こされる。
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
        // **識別子（`eventId`）はこの地震の発現時刻から作る。** 電文の `EventID` は原因地震の
        // もので、津波電文はそのあとに発表される（→ `tsunamiOriginDate`）。
        hypocenterName: '三陸沖', magnitudeCondition: 'Ｍ８を超える巨大地震', magnitudeType: 'Mj',
        // **発生時刻と発現時刻が 1 分ずれる形**（実電文の三陸沖 M7.4 と同じ。発生 16:52 /
        // 発現 16:53）。カードが出すのは発現時刻のほう。2 件目は一致する形にしてあり、
        // 1 画面で両方を見比べられる。
        originTime: originIso, arrivalTime: arrivalIso,
        code: '288', latitude: 38.1, longitude: 143.9, depth: 24,
      },
      {
        // 2 件目も第一波の到達（6 分前）より前に置く。**発生時刻と発現時刻は一致させる**
        // —— 実電文では 88.8% がこの形で、1 件目のずれる形と並べて見比べられる。
        hypocenterName: '岩手県沖', magnitude: 7.2, magnitudeType: 'M',
        originTime: t(-9), arrivalTime: t(-9), source: 'ＰＴＷＣ',
        code: '286', latitude: 39.6, longitude: 143.2, depth: 10,
        nameFromMark: '宮古の東１２０ｋｍ付近', markCode: '201', direction: '東', distanceKm: 120,
      },
    ],
    } : {}),
    // name は地図の海岸線表示用に、津波予報区データ（tsunami-zones.json）に実在する区域名を使用する
    // 2011年東北地方太平洋沖地震を参考にした発令内容
    // code は津波予報区コード。名前とコードの対応は気象庁の個別コード表
    // （技術資料の jmaxml_*_Code.zip・シート 31 = AreaTsunami）から採る。**下の 11 区域は
    // すべて実配信の電文に現れた組み合わせ**（千葉県内房 311・相模湾・三浦半島 330・静岡県 380・
    // 北海道太平洋沿岸西部 102 を含む）。observations の
    // districtCode と一致させて紐づけを確認する。区域の中の観測点コードは同 zip の
    // シート 35 = PointTsunami。**一次細分区域（震度）のコードと混ぜないこと** ——
    // 「石川県能登」は一次細分区域では 390、津波予報区では 360 で、番号がまったく別物
    //
    // **区域の到達状況（`firstHeight`）は実配信の形に合わせる。** 形は 4 つしかなく、実測との
    // 組み合わせにも決まりがある（→ [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md)
    // §9「区域の到達状況」）。ここでは 4 形すべてを 1 枚のカードに並べる。
    //
    // **実測がある区域では到達状況バッジが出ない**（`TsunamiAreaRow` の `badgeSuppressed`。
    // 観測点の行が事実を語るため）。以前は 6 区域すべてに実測があり、**バッジが 1 つも画面に
    // 出なかった** —— 3 値を実機で確かめる手段が無かった。下の 4 区域（千葉県九十九里・外房／
    // 千葉県内房／相模湾・三浦半島／静岡県）は実測を持たせず、そのために置いている。
    //
    // 並びは震源（三陸沖）から遠ざかる順で、到達の段階もその順に進む。
    areas: ([
      // ── 実測が届いた区域。到達済みなので「第１波の到達を確認」で、到達予想時刻は持たない ──
      {
        // 数値にならない予想波高。`value` を持たないのが電文どおりの形
        grade: 'MajorWarning', immediate: false, name: '岩手県', code: '210',
        maxHeight: { description: '巨大' },
        firstHeight: { condition: '第１波の到達を確認' },
        stations: [
          // **実測が届いた地点は到達予想を持たない**（満潮時刻だけが残る）。まだ届いていない
          // 地点（釜石）は到達予想を持ち、その値は**必ず未来**。
          { name: '宮古',   code: '21001', highTideDateTime: t(60) },
          { name: '釜石',   code: '21003', arrivalTime: t(8), highTideDateTime: t(62) },
          { name: '大船渡', code: '21002', highTideDateTime: t(58) },
        ],
      },
      {
        grade: 'MajorWarning', immediate: false, name: '宮城県', code: '220',
        maxHeight: { description: '10m以上', value: 10.0 },
        // 大津波警報の区域で予想波高が初めて数値になった／上方修正された合図（電文の
        // `MaxHeight/Condition` = 重要）。観測・推定の「重要」とは意味が違う
        forecastHeightImportant: true,
        firstHeight: { condition: '第１波の到達を確認' },
        stations: [
          { name: '石巻港', code: '22022', highTideDateTime: t(55) },
          { name: '仙台港', code: '22021', arrivalTime: t(14), highTideDateTime: t(57) },
          { name: '石巻市鮎川', code: '22002', arrivalTime: t(10), highTideDateTime: t(56) },
        ],
      },
      {
        grade: 'MajorWarning', immediate: false, name: '福島県', code: '250',
        maxHeight: { description: '6m', value: 6.0 },
        firstHeight: { condition: '第１波の到達を確認' },
        // **この `arrivalTime` が、欠測の行に到達予想を出す唯一の材料。** 同じ名前の観測点が
        // 下の `observations` にいて、そちらは第1波も最大波も欠測（到達したかどうかも判って
        // いない）。予想した時刻を過ぎても到達を観測できていない形で、気象庁には予想を
        // 取り下げる理由が無い —— 実配信でも到達予想が残るのは欠測の地点だけ。
        // 落とすと「到達予想 ○○」の行を実機で一度も見られない
        // （→ docs/spec/tsunami-spec.md §9「実測の到達時刻が無い行に添える到達予想」）。
        stations: [
          { name: 'いわき市小名浜', code: '25002', arrivalTime: t(-2), highTideDateTime: t(65) },
        ],
      },
      {
        grade: 'Warning', immediate: false, name: '青森県太平洋沿岸', code: '201',
        maxHeight: { description: '3m', value: 3.0 },
        firstHeight: { condition: '第１波の到達を確認' },
        stations: [
          { name: '八戸港',       code: '20121', highTideDateTime: t(70) },
          { name: 'むつ市関根浜', code: '20102', arrivalTime: t(15), highTideDateTime: t(72) },
        ],
      },
      {
        grade: 'Warning', immediate: false, name: '茨城県', code: '300',
        maxHeight: { description: '3m', value: 3.0 },
        firstHeight: { condition: '第１波の到達を確認' },
        stations: [
          { name: '大洗', code: '30001', highTideDateTime: t(80) },
        ],
      },
      {
        grade: 'Watch', immediate: false, name: '北海道太平洋沿岸東部', code: '100',
        maxHeight: { description: '1m', value: 1.0 },
        // **津波注意報以上は `firstHeight` を必ず持つ。** 要素ごと無いのは津波予報
        // （若干の海面変動）と解除だけ
        firstHeight: { condition: '第１波の到達を確認' },
        stations: [
          { name: '釧路', code: '10001', highTideDateTime: t(90) },
        ],
      },
      // ── 実測がまだ届いていない区域。到達状況バッジはここでしか出ない ──
      //
      // **`stations` を持たせない。** 区域の中の地点（満潮時刻・地点ごとの到達予想）を運ぶのは
      // 津波情報（VTSE51）で、津波警報等（VTSE41）は区域一覧しか運ばない（→ §5「続報で前報から
      // 引き継ぐもの」）。新しく等級が出たばかりで、まだ津波情報に載っていない区域の形にあたる。
      {
        // バッジ「第1波到達」。到達を確認した区域でも、その区域の潮位観測点の実測が
        // まだ届いていないことがある
        grade: 'Warning', immediate: false, name: '千葉県九十九里・外房', code: '310',
        maxHeight: { description: '3m', value: 3.0 },
        firstHeight: { condition: '第１波の到達を確認' },
      },
      {
        // バッジ「到達中」。もう来ているが第1波を捉えられていない段階で、到達予想時刻は消える
        grade: 'Warning', immediate: true, name: '千葉県内房', code: '311',
        maxHeight: { description: '3m', value: 3.0 },
        firstHeight: { condition: '津波到達中と推測' },
      },
      {
        // バッジ「まもなく到達」。**到達状況のうちこれだけが到達予想時刻と併存し、その値は
        // 必ず未来**（実配信では発表の 2〜10 分後）
        grade: 'Watch', immediate: true, name: '相模湾・三浦半島', code: '330',
        maxHeight: { description: '1m', value: 1.0 },
        firstHeight: { arrivalTime: t(5), condition: 'ただちに津波来襲と予測' },
      },
      {
        // 到達予想時刻だけの形（バッジなし）。これから来る区域のふつうの姿
        grade: 'Watch', immediate: false, name: '静岡県', code: '380',
        maxHeight: { description: '1m', value: 1.0 },
        firstHeight: { arrivalTime: t(40), condition: '' },
      },
      {
        // **津波予報の区域にも実測は届く。** `FirstHeight` を持たないのは「到達を語らない」
        // だけで、観測していないという意味ではない —— 実配信でも波高の実測がある区域の
        // 1 割強がこの形（→ [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9
        // 「実測との関係」）。等級が下がっても観測は続くため、警報の発表中にこの組み合わせが混じる
        grade: 'Forecast', immediate: false, name: '北海道太平洋沿岸西部', code: '102',
        maxHeight: { description: '0.2m未満', value: 0.2 },
      },
      {
        // 続報でこの区域だけが**解除**される（`createTestTsunamiGradeChange`）。区域は 1 つも
        // 潮位観測点を持たない形にしてある —— 実電文にもこの形があり（2025-12-09T06:20 の
        // VTSE41）、解除された区域の `Item` は `Area` と `Category` しか持たない。
        //
        // **その形になるのは続報の側だけ。** ここは解除される前の初報で、津波注意報として
        // 発表されている区域なので `firstHeight` を持つ（→ §7「実電文の形に合わせる」。
        // 要素ごと無いのは津波予報と解除だけ）。
        grade: 'Watch', immediate: false, name: '青森県日本海沿岸', code: '200',
        maxHeight: { description: '1m', value: 1.0 },
        firstHeight: { arrivalTime: t(45), condition: '' },
      },
    ] as TsunamiArea[]).map(a => withDmdssFields ? a : toP2pTsunamiArea(a)),
    ...(withDmdssFields ? {
    // 観測状態（`condition`）は電文の `Condition` に現れる組み合わせを一通り含める。
    // 気象庁は「重要 欠測」「微弱 欠測」のように複数を併記するため（電文解説資料 Ⅱ.12）、
    // 単独の状態しか置かないとカード・地図・読み上げの併記の扱いが一度も通らない。
    observations: [
      { name: '宮古',   districtCode: '210', districtName: '岩手県',           height: { value: 8.5, description: '8.5m以上', over: true }, arrivalTime: t(-6), initial: '押し', maxHeightDateTime: t(-3), firstHeightRevise: '追加' },
      // これまでの最大波を観測した後に観測が途切れた観測点（値と欠測が同時に来る形）。
      { name: '大船渡', districtCode: '210', districtName: '岩手県',           height: { value: 3.2, description: '3.2m以上', over: true }, arrivalTime: t(-5), initial: '押し', condition: { maxHeightMissing: true, important: true } },
      { name: '石巻港', districtCode: '220', districtName: '宮城県',           height: { value: 7.2, description: '7.2m' }, arrivalTime: t(-4), initial: '押し', maxHeightDateTime: t(-2), maxHeightRevise: '更新', firstHeightRevise: '更新' },
      // 到達は確認できたが最大波が欠測（波高の数値が無い）。
      { name: '相馬',   districtCode: '250', districtName: '福島県',           arrivalTime: t(-2), initial: '押し', condition: { maxHeightMissing: true } },
      // 第1波も最大波も欠測（到達したかどうかも判っていない）。
      { name: 'いわき市小名浜', districtCode: '250', districtName: '福島県',   condition: { firstHeightMissing: true, maxHeightMissing: true } },
      // 水位が上昇中の観測点。波高の数値が消えないことの確認を兼ねる。
      { name: '大洗',   districtCode: '300', districtName: '茨城県',           height: { value: 2.1, description: '2.1m' }, arrivalTime: t(-2), initial: '押し', condition: { rising: true } },
      { name: '八戸港', districtCode: '201', districtName: '青森県太平洋沿岸', height: { value: 1.8, description: '1.8m' }, arrivalTime: t(-3), initial: '引き' },
      // 第1波の到達時刻が読み取れなかった観測点（`FirstHeight/Condition` = 第１波識別不能）。
      // **欠測とは別物** —— 津波は観測できていて到達も確定しており、時刻だけが出せない。
      // 時刻の欄に「到達時刻不明」と理由が出る（`utils/tsunami.ts` の
      // `observationArrivalFallbackText`）。到達確認の扱いは欠測と違って抑制しない。
      { name: '久慈港', districtCode: '210', districtName: '岩手県', height: { value: 4.4, description: '4.4m' }, initial: '押し', maxHeightDateTime: t(-2), condition: { firstWaveUnidentifiable: true } },
      // 津波注意報の区域で、これまでの最大波がごく小さい（数値を発表しない）。
      { name: '釧路',   districtCode: '100', districtName: '北海道太平洋沿岸東部', arrivalTime: t(-2), initial: '押し', condition: { weak: true } },
      // 津波予報まで下がった区域の実測。等級が下がっても観測は続く（区域の側は上の `areas` を見る）。
      { name: '室蘭港', districtCode: '102', districtName: '北海道太平洋沿岸西部', height: { value: 0.1, description: '0.1m' }, arrivalTime: t(-4), initial: '押し', maxHeightDateTime: t(-3) },
      // 沖合の潮位観測点。「重要」の基準が沿岸と違う（大津波警報だけでなく津波警報も含む）ため、
      // 出所の印（offshore）を付けてバッジの語が切り替わることを確かめられるようにする。
      { name: '沖合40km', offshore: true, sensor: 'ＧＮＳＳ波浪計', height: { value: 3.0, description: '3.0m以上', over: true }, arrivalTime: t(-3), condition: { important: true }, maxHeightDateTime: t(-2) },
      // 「観測中」のまま Revise が「更新」。大津波警報の区域に対応する沖合の観測点で、沿岸で
      // 推定される高さが 3m 超に届かないときの形で、**津波警報に相当する津波を観測している**
      // ことを気象庁が示す（電文解説資料 Ⅱ.13 1-1-2-2-2）。値が変わらないので、アプリの
      // 「値の変化で判定する」仕組みでは作れない状態 —— テストボタンに無いと実機で一度も見られない。
      { name: '沖合80km', offshore: true, sensor: '水圧計', arrivalTime: t(-2), condition: { observing: true }, maxHeightRevise: '更新' },
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
        name: '岩手県', code: '210', arrivalTime: t(8),
        arrivalCondition: '早いところでは既に津波到達と推定',
        maxHeight: { description: '5m', value: 5.0 },
        condition: { important: true },
        maxHeightDateTime: t(8), firstHeightRevise: '追加', maxHeightRevise: '追加',
      },
      { name: '宮城県', code: '220', arrivalCondition: '早いところでは既に津波到達と推定', maxHeight: { description: '4m', value: 4.0 } },
      { name: '福島県', code: '250', arrivalCondition: '早いところでは既に津波到達と推定', condition: { estimating: true } },
    ],
    } : {}),
  }
}

/**
 * 推計震度分布図の続報が、初報から遅れて発表される幅。
 *
 * 実電文で観測した 6 分をそのまま置いている（M7.4 → M7.5・セル数も変化。
 * → `useEarthquakes` の `applyEstimatedIntensity`）。**この値を待つものは無い** ――
 * 続報をいつ流すかはテストのキューが別に決めており、ここは電文が名乗る発表時刻だけ。
 * 反映の判定（`decideEstimatedIntensityUpdate`）は初報より後かどうかしか見ない。
 */
const ESTIMATED_INTENSITY_FOLLOW_UP_MS = 6 * 60_000

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
 *
 * **続報も返す。** 同じ地震について続報が出るので（実電文で 6 分後）、読み上げは初報を
 * 「受信しました」、続報を「更新されました」と言い分ける。初報しか流せないと、その言い分けを
 * 実機で一度も聞けない（→ CLAUDE.md「テストボタンは実機確認の唯一の入口」）。
 *
 * **続報のセルは初報と同じもの。** 実電文の続報はセル数も変わるが、それを再現するには同じ
 * 地震の 2 通目を採り直す必要がある（`build-test-estimated-intensity` は「セルが多いほう」を
 * 採る作りで 1 通しか保存しない）。ここで確かめたいのは**アプリが続報をどう扱うか**なので、
 * 発表時刻だけを進める —— 反映するかどうかの判定（`decideEstimatedIntensityUpdate`）は
 * 発表時刻が進んでいれば続報と見なす。
 */
export function createTestEstimatedIntensity(): {
  quake: JMAQuake
  estimated: JMAEstimatedIntensity
  /** 同じ地震の続報。発表時刻だけが初報より後になっている */
  followUp: JMAEstimatedIntensity
} {
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

  const estimated: JMAEstimatedIntensity = {
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
  }

  return {
    quake,
    estimated,
    followUp: {
      ...estimated,
      id: `test-ixac41-${eventId}-2`,
      // **発現時刻は同じまま、発表時刻だけを進める。** 発現時刻が同じだからこそ「同じ地震の
      // 続報」になる（変えると別の地震へ入れ替えた扱いになり、初報と同じ文で読まれる）。
      time: new Date(nowDate.getTime() + ESTIMATED_INTENSITY_FOLLOW_UP_MS).toISOString(),
    },
  }
}
