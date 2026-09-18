import type { LiveEvent, EEWAlert, JMAQuake, JMATsunami, JMANankai, JMANankaiCommentary, JMAKohatsu, JMAEarthquakeCount, JMALpgm, IntensityScale, TsunamiGrade, TsunamiArea, EarthquakePoint, DomesticTsunami, TsunamiObservation, Hypocenter } from '../types/earthquake'
import { eewNoForecastReason, canPresentLpgmClass, type EewMaxScaleInfo } from './eew'
import { getIntensityLabel, getIntensityLabelWithApproxAbove } from './intensity'
import { tsunamiMaxGrade, groupAreasForCardDisplay, sortAreasForCardDisplay, hasForecastHeight, compareObservedHeightDesc, overSuffixedHeight, GRADES_IN_CARD_ORDER, TSUNAMI_GRADE_SHORT_LABEL, TSUNAMI_GRADE_LIFTED, type TsunamiAreaGradeChange } from './tsunami'
import { joinSegments, plain, type SpeechSegment, type SpeechRef, type QuakeFact, type SpokenObservation } from './ttsFollow'
import { getSubRegionsCache } from './subregions'
import { getPrefecturesCache } from './prefectures'
import { getStationCoordsCache, getAreaPrefIndexCache, buildStationPrefIndex, buildPrefAreaNamesIndex, buildRegionOrderIndex, regionOrderRank, sortByRegionOrder, lookupStationRegion, type StationCoordsData, type RegionOrderIndex } from './stationCoords'
import { isAreaPoint, isMaxScaleUnreceived, partitionUnreceivedPoints, unreceivedUnitLabel } from './quakePoints'
import { hasMagnitude, hasDepth, readDateTime } from './formatters'
import { createLogThrottle, createPerLabelLogGate, log } from './logger'
import { hasKnownEpicenter } from './geo'

/**
 * 等級を読む順（重い等級が先）。**カードが等級カードを積む順と同じ並びを使う**
 * （`GRADES_IN_CARD_ORDER`）。手書きで写すと、等級を増やしたときに片方だけ漏れる。
 *
 * **`'Unknown'` だけは外す。** 等級の呼び名（`TSUNAMI_GRADE_SHORT_LABEL`）が `'Unknown'` では
 * 空文字なので、含めると「〇〇に切り替えられました。」「また、次の地域に〇〇が発表されています。」の
 * 〇〇が消え、主語を欠いた文になる。区域はあるのに等級が 1 つも取れない電文は実際に届き
 * （`useLiveEventHandler` の引き下げ経路）、そこでは**この並びから `topGrade` が見つからないこと**を
 * 「津波警報等は全て解除されました」へ落ちる条件として使っている。
 */
const GRADE_ORDER: TsunamiGrade[] = GRADES_IN_CARD_ORDER.filter(g => g !== 'Unknown')

function tsunamiGradeLabel(grade: TsunamiGrade): string {
  // 呼び名はカードの「等級が移り変わった」行と共有する（`TSUNAMI_GRADE_SHORT_LABEL`）
  return TSUNAMI_GRADE_SHORT_LABEL[grade]
}

// 震度スケールの降順リスト
const SCALE_DESCENDING: IntensityScale[] = [70, 60, 55, 50, 45, 40, 30, 20, 10] as IntensityScale[]

/** 地域名を作れなかった記録を出す間隔。続いている障害を「一度きり」に見せないための間引き。 */
const NO_REGION_LOG_THROTTLE_MS = 5 * 60_000
const warnNoRegionNames = createLogThrottle(NO_REGION_LOG_THROTTLE_MS)

// 県内の一次細分区域が全部同じ階級で揃っている場合、区域名の列挙を「〇〇県」1件にまとめる。
// 入力の出自は問わない（電文の区域点／観測点から逆引きした区域名／都道府県ロールアップ名のどれでも
// 通る）。DMDATA 経路の区域点は pref が空文字（`parseEarthquakeFromXml` 参照）のため、
// areaPrefIndex（区域名→県名の逆引き）で補完してからグルーピングする。
// prefAreaNames が引けない（未読み込み）場合はまとめず区域名をそのまま返す。
//
// **上位の階級で区域名を出した県はまとめない**（`prefsWithAreaShown`）。まとめ判定は階級ごとに
// 独立して走るので、上と下で粒度が食い違うと県の震度を過小に伝える。例: 5強で「福井県嶺北」を
// 出した後、4 で嶺北・嶺南が揃って「福井県」とまとめると、福井県は 5強 なのに 4 に聞こえる。
function aggregateAreaNamesByPref(
  areaNames: { pref: string; addr: string }[],
  prefAreaNames: Map<string, Set<string>> | null,
  areaPrefIndex: Map<string, string> | null,
  prefsWithAreaShown: ReadonlySet<string>,
): string[] {
  const byPref = new Map<string, Set<string>>()
  for (const { pref, addr } of areaNames) {
    const resolvedPref = pref || areaPrefIndex?.get(addr) || ''
    const set = byPref.get(resolvedPref) ?? new Set<string>()
    set.add(addr)
    byPref.set(resolvedPref, set)
  }
  const result: string[] = []
  for (const [pref, names] of byPref) {
    const fullSet = prefAreaNames?.get(pref)
    const isWholePref = pref !== '' && fullSet != null && fullSet.size > 0
      && names.size === fullSet.size && [...names].every(n => fullSet.has(n))
      && !prefsWithAreaShown.has(pref)
    if (isWholePref) result.push(pref)
    else result.push(...names)
  }
  return result
}

/**
 * 地点名を地域名へ解決するための逆引き索引。3 つが同じ型（観測点名/区域名 -> 名前）なので、
 * 位置引数で並べると渡し違いを型チェックが捕まえられない。キー名で渡すためにまとめている。
 */
interface RegionNameIndexes {
  /** 都道府県名 -> その県に属する一次細分区域名の集合 */
  prefAreaNames: Map<string, Set<string>> | null
  /** 一次細分区域名 -> 都道府県名 */
  areaPrefIndex: Map<string, string> | null
  /** 観測点名 -> 都道府県名 */
  stationPrefIndex: Map<string, string> | null
  /** 座標テーブル本体。観測点 -> 一次細分区域は地図と同じ `lookupStationRegion` で引く */
  stationData: StationCoordsData | null
}

function regionNamesForScale(
  points: EarthquakePoint[],
  scale: IntensityScale,
  idx: RegionNameIndexes,
  /** 上位の階級で区域名を出した県。ここに載る県はこの階級で県名へまとめない */
  prefsWithAreaShown: ReadonlySet<string>,
): string[] {
  const matched = points.filter(p => p.scale === scale)
  // 区域の点があれば電文自身が示した粒度を使う。
  // **この打ち切りは同じ階級の観測点経路をまるごと止める**（都道府県ロールアップ点の救済も含む）。
  // 気象庁の電文では県の最大震度が配下区域の最大震度なので、区域に出ずに県や観測点だけが出ることは
  // 無い、という前提に乗っている。加えて座標テーブルが未読み込みだと区域名から県を引けず「どの県を
  // 拾えたか」が判らないため、ここでロールアップ点を足すと区域名と県名が二重に並ぶ。
  // 前提が崩れた場合は、その県の震度が読み上げから静かに落ちる（他の区域で地域名が作れてしまうため
  // 下の「地域名 0 件」の記録にも掛からない）。狭めるなら「区域点を持つ県だけ観測点経路を飛ばす」形。
  // 索引が null（座標テーブル未読み込み・取得失敗）のときは名前だけの判定へ落ち、奈良県を
  // 取りこぼす。個別の記録は置かない——その状態では観測点からの区域逆引きも全滅していて
  // 地域名は広範に落ちており、原因は `useStationCoords` が log.error で報告済みのため。
  const areaPoints = matched.filter(p => isAreaPoint(p, idx.areaPrefIndex))
  if (areaPoints.length > 0) return aggregateAreaNamesByPref(areaPoints, idx.prefAreaNames, idx.areaPrefIndex, prefsWithAreaShown)

  // 区域の点を持たない電文では観測点の所属区域を逆引きし、区域粒度で読む。P2PQuake の詳細報が
  // 常にこの経路（区域は別電文で届くため。→ docs/spec/quake-spec.md §4）。
  const observations = matched.filter(p => !p.isArea)
  if (observations.length > 0) {
    const resolved: { pref: string; addr: string }[] = []
    const prefsWithRegion = new Set<string>()
    const prefsWithoutRegion = new Set<string>()
    for (const p of observations) {
      // QUAKE-2 で XML 経路の観測点も pref: '' になったため、pref が空なら addr から逆引きする。
      const pref = p.pref || idx.stationPrefIndex?.get(p.addr) || ''
      // 区域は**地図の区域塗りと同じ関数**で引く。都道府県付きのキーしか持たないので、同名の
      // 観測点が別の県にあっても取り違えない。都道府県を引けなかった観測点は区域も引けないので、
      // 下の県名フォールバックに回る（そこでも拾えなければその点は読み上げから落ちる）。
      const region = pref && idx.stationData
        ? lookupStationRegion(idx.stationData, pref, p.addr)
        : null
      if (region) {
        resolved.push({ pref, addr: region })
        prefsWithRegion.add(pref)
      } else if (pref) {
        prefsWithoutRegion.add(pref)
      }
    }
    // 区域が引けなかった観測点は県名で読む。ただしその県に区域が 1 つでも立っているなら捨てる。
    // 混ぜると同じ県が「〇〇県北部」と「〇〇県」の二重で並ぶ。
    for (const pref of prefsWithoutRegion) {
      if (!prefsWithRegion.has(pref)) resolved.push({ pref, addr: pref })
    }
    // 観測点を 1 つも持たない県は都道府県ロールアップ点から拾う。観測点が取れた時点で打ち切ると、
    // その県が読み上げから黙って消える（DMDATA の電文は区域・観測点・県の 3 種が同時に届く）。
    for (const p of matched) {
      if (!p.isArea || !p.pref || p.addr !== p.pref) continue
      if (prefsWithRegion.has(p.pref) || prefsWithoutRegion.has(p.pref)) continue
      resolved.push({ pref: p.pref, addr: p.pref })
      prefsWithoutRegion.add(p.pref)
    }
    if (resolved.length > 0) return aggregateAreaNamesByPref(resolved, idx.prefAreaNames, idx.areaPrefIndex, prefsWithAreaShown)
  }

  // 観測点を持たない電文（都道府県ロールアップ点だけが残る場合）は県名で読む。
  // 上の観測点経路から抜けてきた場合はここも必ず空になる（同じ式で都道府県を引いていて、
  // それが解決できなかったから何も積めなかった、という状態なので）。追加の救済ではない。
  const prefs = matched.map(p => p.pref || idx.stationPrefIndex?.get(p.addr) || '')
  return [...new Set(prefs.filter(Boolean))]
}

// ソート用二乗距離（緯度方向補正あり）
function distSq(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dlat = lat1 - lat2
  const dlon = (lon1 - lon2) * Math.cos((lat1 + lat2) * Math.PI / 360)
  return dlat * dlat + dlon * dlon
}

// 地域名 → 代表座標（一次細分区域 → 都道府県 の順で検索）
function coordForName(name: string): [number, number] | null {
  const sub = getSubRegionsCache()?.find(r => r.name === name)
  if (sub) return sub.label
  const prefs = getPrefecturesCache()
  if (prefs && name in prefs) return prefs[name].label
  return null
}

/**
 * 「震度5弱以上・未入電」をどこまで詳しく読むか。
 *
 * | 値 | 読み方 |
 * |---|---|
 * | `stations` | 地点名を挙げる（既定。気象庁も地点名で発表する） |
 * | `areas` | 区域名へ丸め、「の一部」を添える |
 * | `none` | 未入電の文そのものを読まない |
 *
 * **`areas` で「の一部」を添えるのは、区域名へ丸めると矛盾して聞こえるため。** 同じ区域に
 * 観測値がある電文で「最大震度7を石川県能登で観測しました。石川県能登では…未入電です。」と
 * 並ぶと、区域全体が未入電であるかのように語ることになる（地点名を採用した経緯そのもの。
 * → docs/spec/audio-tts-spec.md §4「地域名の粒度」）。
 *
 * **どの値でも「推定であること」と理由（未入電）は落とさない。** 断定形で読まない規約は
 * 詳細度の設定より上位にある（`none` は文ごと読まない選択で、断定形にはならない）。
 */
export type TtsUnreceivedDetail = 'stations' | 'areas' | 'none'

/**
 * 読み上げ文の作り方を決める設定。設定タブの「読み上げ設定」から来る
 * （組み立ては `useLiveEventHandler` の `ttsSpeechOptions`）。
 *
 * 前半 4 つは地域をどこまで挙げるか、後半 2 つは 1 件ごとの詳しさ。
 * **どちらも既定は「この設定を入れる前の挙動」**（→ `useSettings.ts` の `DEFAULTS`）。
 */
/**
 * 気象庁が書いた文のうち、読み上げを個別に選べる単位。**電文種別 × ブロック**で並べる。
 *
 * 同じ「自由付加文」でも種別によって中身の性質が違う（地震情報は `＊` の説明が主、津波は
 * いつ来ていつまで続くかの説明、南海トラフは評価の本文）。種類でまとめて切る形にすると、
 * 片方を聞くためにもう片方も付いてくる。
 *
 * **一覧はここが単一情報源。** 設定の既定値（`useSettings.ts`）・設定タブのラベル・
 * `telegramTextToSpeak` の判定がこの型から導かれるので、足したものを書き忘れると型検査で止まる。
 */
export const TELEGRAM_TEXT_BLOCK_KEYS = [
  // 地震情報
  'quakeVarComment', 'quakeFreeText',
  // 津波
  'tsunamiBody', 'tsunamiVarComment', 'tsunamiFreeText',
  // 長周期地震動観測情報
  'lpgmForecast', 'lpgmVarComment', 'lpgmFreeText',
  // 南海トラフ地震臨時情報
  'nankaiSummary', 'nankaiBody', 'nankaiNextAdvisory',
  // 南海トラフ地震関連解説情報
  'nankaiCommentarySummary', 'nankaiCommentaryBody', 'nankaiCommentaryNextAdvisory',
  // 北海道・三陸沖後発地震注意情報
  // **次回発表予定は持たない。** 解説資料 Ⅱ.42 が定める VYSE60 の `Body` は `EarthquakeInfo` と
  // `Text` だけで `NextAdvisory` を含まない（実電文 7 通でも 0 件。→ data-sources-spec.md
  // 「3 種別に共通する要素は 1 箇所で読む」）。**切っても入れても何も起きない欄を設定に並べない。**
  // 気象庁がこの要素を出すようになったら、キーと `telegramTextToSpeak` の `pick` を戻す。
  'kohatsuSummary', 'kohatsuBody',
  // 地震回数に関する情報
  'earthquakeCountFreeText',
] as const

export type TelegramTextBlockKey = typeof TELEGRAM_TEXT_BLOCK_KEYS[number]
export type TelegramTextBlocks = Readonly<Record<TelegramTextBlockKey, boolean>>

/**
 * 気象庁が書いた文のうち、**文の単位で**読み上げから落とせる定型文。
 *
 * ブロック（{@link TELEGRAM_TEXT_BLOCK_KEYS}）は「電文種別 × 付加文の枠」をまるごと切るもので、
 * こちらは**枠の中の特定の文だけ**を落とす。枠ごと切ると、その枠にだけ入ってくる非定型の告知まで
 * 消える —— 実配信で文面を確かめられた例が 2 つある（震源・震度情報の自由付加文に入った
 * 震度速報の訂正、震源要素更新の自由付加文に足された精査後のモーメントマグニチュード）。
 * 文で落とせば、定型のあとに何か足された報ではその足された分だけが声になる。
 *
 * **判定は文字列の一致で行い、固定付加文のコードでは行わない。** 固定付加文は 1 要素に複数の
 * コードと複数行が入り（`Code="0211 0241"` に対して `Text` が 2 行）、どの行がどのコードかは
 * 並び順しか手掛かりが無い。順序が食い違った日に「別の文を落とす」——落とし漏れより重い失敗に
 * なる。文字列なら一致しなければ落とさないだけで、失敗の向きが安全。
 *
 * **コードは落とし漏れに気づくために持つ**（{@link TELEGRAM_BOILERPLATE_SPECS} の `codes`）。
 * 文面が一字変われば一致しなくなり、そのときは黙って壊れずに「読まれるようになる」だけだが、
 * 落ちていないことに気づく手掛かりがどこにも無い。実際に `＊` 印の説明で踏んだ ——
 * 文面が種別で違う（0262 は「震度観測点」・0263 は「長周期地震動観測点」）ことを見落とし、
 * 長周期の報だけ落ちない状態が残っていた。自由付加文はコードを持たないので検出できない。
 *
 * **一覧はここが単一情報源。** 設定の既定値・設定タブのラベルと説明・落とす判定がこの型から
 * 導かれるので、足したものを書き忘れると型検査で止まる。
 */
export const TELEGRAM_BOILERPLATE_KEYS = [
  'starMark',
  'eewIssued',
  'lpgmClassTable',
  'tsunamiHeightLegend',
] as const

export type TelegramBoilerplateKey = typeof TELEGRAM_BOILERPLATE_KEYS[number]
/** 真 = 読む（落とさない）。向きは {@link TelegramTextBlocks} と揃えてある。 */
export type TelegramBoilerplateReads = Readonly<Record<TelegramBoilerplateKey, boolean>>

/**
 * 落とす・読むの既定。**「音にして伝わらないもの」と「アプリが別の経路で伝えているもの」は
 * 落とす側に倒す。**
 *
 * 他の読み上げ設定は「設定を入れる前の挙動」を既定にしてあるが（→ `useSettings.ts` の
 * `DEFAULTS`）、ここはその原則を当てられない —— `＊` 印の説明は**この設定より前から無条件で
 * 落ちていた**ので、読む側を既定にすると設定を足した瞬間に鳴り出す。逆向きの破壊になる。
 *
 * 落とす側へ倒す根拠は項目ごとに違う。`starMark` は記号が音にならないので何と対比しているか
 * 伝わらない。`lpgmClassTable` と `tsunamiHeightLegend` は等級・階級の意味を説明する表で、
 * 声にすると一続きに聞こえるうえ事象に依らない（津波の高さの目安は 307 字で、読み上げの実測
 * レート 5.8 字/秒なら約 53 秒）。`eewIssued` はアプリが緊急地震速報そのものを画面と音で
 * 扱っているため二度述べになる。**画面には従来どおり全文を出す**ので、情報は失われない。
 */
export const TELEGRAM_BOILERPLATE_DEFAULT_READS: TelegramBoilerplateReads = {
  starMark: false,
  eewIssued: false,
  lpgmClassTable: false,
  tsunamiHeightLegend: false,
}

export interface TtsSpeechOptions {
  intensityLevels: number   // 最大震度に加えて何階級下まで読むか（0 = 最大のみ。観測がある階級だけを数える）
  maxRegions: number        // 読み上げる最大地域数（0 = 無制限）
  alwaysReadScale: number   // 階数を超えても読み上げる下限震度（-1 = 無効。長周期地震動には適用しない）
  regionTolerance: number   // maxRegions をこの数まで超える場合は省略せず全地域を読む（0 = 無効）
  /**
   * 「震度5弱以上・未入電」の読み方（→ `TtsUnreceivedDetail`）。
   *
   * **省略時は `stations`（従来の挙動）。** テストが 1 件ずつ指定しなくて済むようにしてあるが、
   * ランタイムの経路では必ず設定から埋める。
   */
  unreceivedDetail?: TtsUnreceivedDetail
  /**
   * 震源の深さ・規模を読むか。偽なら震源名だけを読む。
   *
   * **判定は `tellableHypocenterFacts` 1 か所に通すこと。** あれは「声にしうる事実」の
   * 単一情報源で、読む側（`quakeOccurrenceSegments` / `changedFactSegments`）と
   * 記録を待つ側（`hasUnspokenFact`）が共有している。片方だけ設定を見ると、
   * **読まれる機会の無い事実を待ってその地震だけ差分の経路へ入れなくなる**。
   */
  readHypocenterDetail?: boolean
  /**
   * 緊急地震速報の予想最大長周期地震動階級を読むか。
   *
   * **長周期地震動観測情報（VXSE62）そのものには効かない。** あちらは階級を伝えるための
   * 電文で、階級を落とすと読み上げる中身が無くなる。ここで切るのは、震度の予想に添えて
   * 読む階級だけ。
   */
  readEewLpgmClass?: boolean
  /**
   * 気象庁が書いた文（本文・付加文）を読むか。→ `useSettings.ts` の `ttsReadTelegramText`
   *
   * **文を組み立てるのは `telegramTextToSpeak`** で、電文本体の読み上げ文には混ぜない
   * （別の発話として最下位の層で読む。理由は同関数の説明）。
   */
  readTelegramText?: boolean
  /**
   * 津波の観測点を読み上げる件数。
   *
   * **`0` は無制限**（隣の `maxRegions` と意味を揃えてある）。選抜は `slice(0, maxPoints || Infinity)`
   * を通すので、0 を渡すと全件を読む。
   */
  maxObservationPoints?: number
  /**
   * 気象庁が書いた文のうち、どのブロックを読むか（→ `TELEGRAM_TEXT_BLOCK_KEYS`）。
   *
   * **省略したキーは読む側へ倒す。** 設定を足しただけで、これまで声になっていた文が
   * 黙って消えないようにするため。`readTelegramText` が偽ならブロックの指定によらず何も読まない。
   */
  telegramTextBlocks?: TelegramTextBlocks
  /**
   * 気象庁が書いた文のうち、どの定型文を読むか（→ {@link TELEGRAM_BOILERPLATE_KEYS}）。
   *
   * **省略時は落とす側**（{@link TELEGRAM_BOILERPLATE_DEFAULT_READS}）。隣の
   * `telegramTextBlocks` が「省略したキーは読む側」なのと逆向きだが、こちらは既定そのものが
   * 落とす側なので揃えてある（理由は既定値の側に書いた）。
   */
  telegramBoilerplate?: TelegramBoilerplateReads
}

/**
 * 1 つの地震について「声になった内容」の記録。続報で差分だけを読むために持つ。
 *
 * **受信した内容ではなく、実際に鳴った内容を入れること。** 更新するのは
 * `useLiveEventHandler` が読み上げの進行（チャンクの再生）を見てからで、文を作る側
 * （このファイル）は読むだけ。理由は docs/spec/audio-tts-spec.md §4「続報は差分だけ読む」。
 *
 * 地震ごとに 1 つ持ち、**情報種別を跨いで共有する**。震度速報で読んだ区域を
 * 震源・震度情報でもう一度読まないため（種別ごとに分けると、同じ地震の同じ地域名を
 * 電文の種別が変わるたびに読み直す）。
 */
/**
 * 区域について最後に声にした内容。
 *
 * **震度だけでは足りない。** 「5弱以上・未入電」は階級を下限（45）へ寄せてあるので、
 * 観測された5弱と `scale` では見分けが付かない。震度だけを鍵にすると、推定として読んだ区域が
 * 後の報で観測値として確定しても「同じ震度」と判定され、**確定したことが永久に読まれない**
 * （→ docs/spec/audio-tts-spec.md §4）。
 */
interface SpokenRegion {
  readonly scale: IntensityScale
  /** 「5弱以上と推定されます」として読んだか（観測値として読んだなら false） */
  readonly unreceived: boolean
}

export interface QuakeSpokenState {
  /** 声になった区域名 → その時に伝えた内容。より強い内容になったときだけ読み直す */
  readonly regions: Map<string, SpokenRegion>
  /** 声になった震源要素・津波区分。キーごとに最後に伝えた値を持つ */
  readonly facts: Map<QuakeFact, string>
  /**
   * 最後に声にした報が運んでいた観測点・市町村（→ {@link SpokenObservation}）。
   *
   * **他の 2 つと違って履歴を積まず、最後の 1 つで置き換える。** 知りたいのは「前に伝えた報と
   * 比べて増えたか」であって、どの観測点を読み上げたかではない（観測点名は声にならない）。
   */
  observed?: SpokenObservation
}

/** 空の {@link QuakeSpokenState} を作る。 */
export function createQuakeSpokenState(): QuakeSpokenState {
  return { regions: new Map(), facts: new Map() }
}

/**
 * 声になった参照を記録へ反映する。
 *
 * 区域は**震度が上がったときだけ**書き換える（同じ区域を下位の震度で挙げ直す電文があっても、
 * 既に伝えた震度を下げない）。事実は最後に伝えた値で上書きする。
 *
 * `useLiveEventHandler` が読み上げの完了時に呼ぶ。**記録を進める規則はここ 1 か所に置くこと**
 * ―― テストが同じ規則を書き写すと、実装だけ変えたときにテストが古い規則のまま緑で残る。
 */
export function applySpokenRefs(state: QuakeSpokenState, refs: readonly SpeechRef[]): void {
  for (const ref of refs) {
    if (ref.kind === 'quakeRegion') {
      const said = state.regions.get(ref.name)
      // 同じ階級でも、推定（未入電）→観測は前進なので書き換える。逆向きには戻さない。
      const forward = said === undefined
        || said.scale < ref.scale
        || (said.scale === ref.scale && said.unreceived && !ref.unreceived)
      if (forward) state.regions.set(ref.name, { scale: ref.scale as IntensityScale, unreceived: !!ref.unreceived })
    } else if (ref.kind === 'quakeFact') {
      state.facts.set(ref.fact, ref.value)
    } else if (ref.kind === 'quakeObserved') {
      // **置き換える（積まない）。** 次の報と比べる基準は「最後に伝えた報」なので、
      // 古い報の観測点を残しても使い道がない。
      state.observed = ref.observed
    }
  }
}

/**
 * 続報で区域を読むかどうかと、読むならどちらの群に入れるか。
 *
 * | 値 | 意味 | 読み方 |
 * |---|---|---|
 * | `fresh` | まだ一度も挙げていない区域 | 「新たに震度○を〜」 |
 * | `upgraded` | 既に挙げたが、伝えた震度より高くなった | 「震度○を〜」（先に読む） |
 * | `null` | 据え置き（または下がった） | 読まない |
 *
 * **2 つを混ぜて「新たに」で括ってはいけない。** 震度が上がった区域は初めて揺れた場所ではないし、
 * 「上がった」ことの方が重い報せなので先に伝える（docs/spec/audio-tts-spec.md §4）。
 */
type RegionDiffKind = 'fresh' | 'upgraded'

function regionDiffKind(spoken: QuakeSpokenState, name: string, scale: IntensityScale): RegionDiffKind | null {
  const said = spoken.regions.get(name)
  if (said === undefined) return 'fresh'
  if (said.scale < scale) return 'upgraded'
  // 推定として読んだ区域に観測値が届いたら読み直す。**「新たに」は付けない** ―― 初めて挙げる
  // 区域ではないため。「もっと強いかもしれない」が消えたことを伝える更新なので上がり側に入れる。
  if (said.scale === scale && said.unreceived) return 'upgraded'
  return null
}

/**
 * 上限で読む区域を選び、読み上げ順へ整える。**選抜と並びは別物。**
 *
 * 選抜（どれを読むか）は震源に近い順。地理順のまま先頭から切ると、震源から遠い北側の地域が
 * 枠を占め、震源直近が「ほかN地域」に潰されうる。震源を持たない電文（震度速報）は距離で
 * 選べないので地理順で切り、「北から上限まで」という説明できる選抜にする。
 * 並び（どの順に読むか）は選抜が済んでから地理順へ組み直す。
 *
 * `maxRegions` は **0 が「無制限」**（設定の既定は 10）。ここを 1 と取り違えると、無制限に
 * した端末で 1 件しか読まれない。上限をわずかに超えるだけなら、省いた地域名より「ほかN地域」の
 * 方が長くなるので、許容超過（`regionTolerance`）の範囲内は省略せず全地域を読む。
 */
function selectRegionNames(
  names: string[],
  opts: TtsSpeechOptions,
  hypocenter: { latitude: number; longitude: number } | undefined,
  regionOrder: RegionOrderIndex | null,
): { names: string[]; omittedNames: string[] } {
  // 震源位置が使えるか。0 は座標未設定、-200 は「位置不明」センチネル（震度速報のように震源を
  // 持たない電文で入る。p2pquake.ts / dmdataParser.ts 参照）。どちらも距離の基準にはできない。
  // -200 を弾かないと、地球上に存在しない点からの距離で地域を選ぶことになる。
  const hasEpicenter = hypocenter != null
    && hasKnownEpicenter(hypocenter.latitude, hypocenter.longitude)
    && (hypocenter.latitude !== 0 || hypocenter.longitude !== 0)
  let picked = hasEpicenter
    ? [...names].sort((a, b) => {
        const ca = coordForName(a)
        const cb = coordForName(b)
        if (!ca && !cb) return 0
        if (!ca) return 1
        if (!cb) return -1
        return distSq(hypocenter!.latitude, hypocenter!.longitude, ca[0], ca[1])
             - distSq(hypocenter!.latitude, hypocenter!.longitude, cb[0], cb[1])
      })
    : sortByRegionOrder(names, regionOrder)
  // **件数だけでなく省略した名前も返す。** 呼び出し側が「ほか○地域」の断片へ参照を付け、
  // 声になったら既読へ移すため。件数しか返していなかった頃は、省略された区域が次報で
  // 「新たに」付きで読み直され、**地域が増えたように聞こえていた**（前報で件数としては
  // 伝えているのに）。
  let omittedNames: string[] = []
  if (opts.maxRegions > 0 && picked.length > opts.maxRegions + opts.regionTolerance) {
    omittedNames = picked.slice(opts.maxRegions)
    picked = picked.slice(0, opts.maxRegions)
  }
  // 安定ソートなので、震源が無い経路（既に地理順）ではここは何も動かさない。
  return { names: sortByRegionOrder(picked, regionOrder), omittedNames }
}

/**
 * その区域について「5弱以上と推定されます」をまだ声にしていないか。
 *
 * 観測値として同じ階級を既に読んでいるなら**読み直さない**。確定した観測が推定へ戻ることは
 * 無く、読めば「確かだったものが不確かになった」と聞こえる。
 */
function isUnreceivedUnspoken(spoken: QuakeSpokenState, name: string): boolean {
  const said = spoken.regions.get(name)
  if (said === undefined) return true
  return said.scale < 45
}

/**
 * 「5弱以上・未入電」を伝える一文。
 *
 * **通常の文に混ぜない。** 地域名を含む文の述語は「観測しました」で、電文が「観測値が
 * 届いていない」と明言しているものをそこへ入れると嘘になる。階級も下限へ寄せてあるので、
 * 語だけ「以上」に変えても述語との食い違いは残る。**別の文へ出して述語ごと分ける。**
 *
 * **地点名で読む。** 未入電は観測点 1 つ 1 つに付く事実で、気象庁も市町村・地点名で発表する。
 * 区域名へ丸めると、同じ区域に観測値がある電文で「最大震度7を石川県能登で観測しました。
 * 石川県能登では…未入電です。」と矛盾して聞こえる（区域の最大は観測できているのに、
 * 区域全体が未入電であるかのように語ることになる）。地点の話にすれば衝突しない。
 *
 * 地点を持たない電文（震度速報は区域しか持たない）だけ、従来どおり区域名で読む。
 *
 * 既読は通常の区域と同じ仕組み（`quakeRegion`）に乗せるが、**鍵には未入電の別も含める**。
 * 同じ名前が後の報で観測値として確定したら、階級が同じでも読み直す（→ `regionDiffKind`）。
 */
function unreceivedRegionSegments(
  points: EarthquakePoint[],
  opts: TtsSpeechOptions,
  hypocenter?: { latitude: number; longitude: number },
  spoken?: QuakeSpokenState,
): SpeechSegment[] {
  const stationData = getStationCoordsCache()
  const idx: RegionNameIndexes = {
    prefAreaNames: stationData ? buildPrefAreaNamesIndex(stationData) : null,
    areaPrefIndex: getAreaPrefIndexCache(),
    stationPrefIndex: stationData ? buildStationPrefIndex(stationData) : null,
    stationData,
  }
  const regionOrder = stationData ? buildRegionOrderIndex(stationData) : null
  const unreceived = points.filter(p => p.unreceived)
  if (unreceived.length === 0) return []
  const regionOfStation = (p: EarthquakePoint): string | null => {
    const pref = p.pref || idx.stationPrefIndex?.get(p.addr) || ''
    return pref && idx.stationData ? lookupStationRegion(idx.stationData, pref, p.addr) : null
  }
  // 設定で粒度を選べる（→ `TtsUnreceivedDetail`）。既定は地点名。
  //
  // `areas` は地点を 1 つも挙げず、全部を区域名へ丸める。**述語も併せて変える** ――
  // 区域名のまま「〇〇では、震度5弱以上と推定されますが」と言うと、同じ区域に観測値がある
  // 電文で区域全体が未入電であるかのように聞こえる（地点名を既定にした理由そのもの）。
  // 「一部の地点で」を挟めば、区域の中の一部の話だと分かる。
  const detail = opts.unreceivedDetail ?? 'stations'
  // 地点名で読み、地点で覆えない区域・県だけを区域名で補う（規則は `partitionUnreceivedPoints`）。
  const { stations, areas } = detail === 'areas'
    ? { stations: [] as EarthquakePoint[], areas: unreceived }
    : partitionUnreceivedPoints(points, p => [
      regionOfStation(p) ?? '',
      p.pref || idx.stationPrefIndex?.get(p.addr) || '',
    ])

  // 地点の並びは所属区域の順（気象庁の標準順）。同じ区域の中は電文の順を保つ。
  // `selectRegionNames` の並べ替えは地点名を索引で引けないため順序を変えない（安定ソート）ので、
  // ここで整えた順がそのまま読み上げ順になる。
  const stationNames = [...stations]
    .map((p, i) => ({ p, i, r: regionOrderRank(regionOfStation(p) ?? p.pref, regionOrder) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ p }) => p.addr)

  // **未入電を含む県は県名へまとめない**（カードと同じ規則。→ quake-spec.md §4）。まとめると
  // 画面が区域別に並べている同じ電文を、音声だけ県名 1 つに畳んで伝えることになる。
  // `prefsWithAreaShown` は「この県は区域名のまま出す」という指定なので、関係する県を全部入れる。
  const unreceivedPrefs = new Set<string>()
  for (const p of areas) {
    const pref = p.pref || idx.areaPrefIndex?.get(p.addr) || ''
    if (pref) unreceivedPrefs.add(pref)
  }
  // 階級は下限の 45 に揃っているので、1 つの階級としてまとめて名前を引く。
  const areaNames = areas.length > 0 ? regionNamesForScale(areas, 45, idx, unreceivedPrefs) : []

  const unit = unreceivedUnitLabel(stationNames.length > 0, areaNames.length > 0)
  const unspoken = [...stationNames, ...areaNames]
    .filter(name => !spoken || isUnreceivedUnspoken(spoken, name))

  // 地名を読まない設定。**ここで空を返さない。** 代替文（`maxScaleOnlySegments`）に任せると、
  // **観測値のある区域が 1 つでもある電文では告知ごと消える** —— あの分岐は「地域名を 1 件も
  // 作れなかったとき」にしか通らないため。観測値と未入電が混ざる形は、強い地震ほど起きやすい
  // （→ quake-spec.md §4「震度5弱以上未入電」）ので、いちばん消えてはいけない場面で消える。
  //
  // 落とすのは**地名だけ**。件数・推定であること・理由（未入電）は残す。
  //
  // **既読には入れる。** 名前は読んでいないが件数としては伝えているので、上限で「ほか○地域」へ
  // 落ちた区域と同じ扱いにする（→ audio-tts-spec.md §4「続報は差分だけ読む」）。入れないと
  // 続報のたびに件数を言い直す。
  if (detail === 'none') {
    if (unspoken.length === 0) return []
    return [{
      text: `${unspoken.length}${unit}では、震度5弱以上と推定されますが、未入電です。`,
      refs: [
        { kind: 'unreceivedNote' },
        ...unspoken.map(name => ({ kind: 'quakeRegion' as const, name, scale: 45 as IntensityScale, unreceived: true })),
      ],
    }]
  }

  // **選抜と上限は観測値の文と同じ規則に乗せる**（`selectRegionNames`）。独自に切ると、
  // 「無制限」の設定で 1 件しか読まれない・省いた件数を伝えない、といったずれが片側にだけ出る。
  const { names, omittedNames } = selectRegionNames(unspoken, opts, hypocenter, regionOrder)
  if (names.length === 0) return []
  const segments: SpeechSegment[] = []
  names.forEach((name, i) => {
    if (i > 0) segments.push(plain('、'))
    segments.push({ text: name, refs: [{ kind: 'quakeRegion', name, scale: 45, unreceived: true }] })
  })
  // 名前を読まなかった分も、この断片が声になれば既読にする（→ `selectRegionNames`）。
  if (omittedNames.length > 0) {
    segments.push({
      text: `、ほか${omittedNames.length}${unit}`,
      refs: omittedNames.map(name => ({ kind: 'quakeRegion' as const, name, scale: 45, unreceived: true })),
    })
  }
  // **推定の理由まで言う。** 「5弱以上と推定されます」だけだと、なぜ推定なのかが伝わらない。
  // 語は気象庁の「未入電」をそのまま使い、画面のバッジ（「未入電あり」）とも揃える ——
  // 聞いた語で画面を探せるように。
  //
  // **この文にも未入電の印を付ける**（`unreceivedNote`）。読み上げに合わせて未入電モードを開く
  // 追従は参照の有無で範囲を決めるので、地名にだけ付けると**説明している最中に画面が戻る**。
  segments.push({
    // 区域名へ丸めたときだけ「一部の地点で」を挟む（→ `TtsUnreceivedDetail`）。
    // **名前の末尾ではなく述語側へ置く。** 名前は読点で並ぶので、最後の名前に「の一部」を
    // 付けると直前の 1 件だけに掛かって聞こえる。
    text: detail === 'areas'
      ? 'では、一部の地点で震度5弱以上と推定されますが、未入電です。'
      : 'では、震度5弱以上と推定されますが、未入電です。',
    refs: [{ kind: 'unreceivedNote' }],
  })
  return segments
}

function buildRegionSegments(
  points: EarthquakePoint[],
  maxScale: IntensityScale,
  opts: TtsSpeechOptions,
  hypocenter?: { latitude: number; longitude: number },
  /** 渡すと、まだ声になっていない区域だけを読む（続報の差分）。省略すると全区域を読む */
  spoken?: QuakeSpokenState,
): SpeechSegment[] {
  // **未入電の区域はここでは扱わない。** 述語が「観測しました」なので、観測値が届いて
  // いない区域を入れると嘘になる（→ `unreceivedRegionSegments`）。
  points = points.filter(p => !p.unreceived)
  const maxIdx = SCALE_DESCENDING.indexOf(maxScale)
  if (maxIdx < 0) return []

  const stationData = getStationCoordsCache()
  const idx: RegionNameIndexes = {
    prefAreaNames: stationData ? buildPrefAreaNamesIndex(stationData) : null,
    // 区域名 → 県名だけはキャッシュから受け取る。地震の統合経路と同じ索引で、読み取りしかしない
    // （→ docs/spec/quake-spec.md §4「ロールアップ点の見分け方」）。読み上げ文を作るたびに
    // 組み直すと、点の役割の判定（isAreaPoint）へ渡す索引が経路ごとに別物になる。
    areaPrefIndex: getAreaPrefIndexCache(),
    stationPrefIndex: stationData ? buildStationPrefIndex(stationData) : null,
    stationData,
  }
  const regionOrder = stationData ? buildRegionOrderIndex(stationData) : null

  // 最大震度以下で実際に観測がある階級だけを降順に集める。震度スケール上の位置ではなく
  // この配列の添字を「最大から何階級目か」として数えるため、観測 0 地域の階級が読み上げ枠を
  // 空費して下の階級に届かなくなることがない（長周期地震動側の数え方と揃えている）。
  const observed: { scale: IntensityScale; names: string[] }[] = []
  // 上位の階級で区域名を出した県。下位でその県を丸ごとまとめると県の震度を過小に伝えるため、
  // 持ち回って `aggregateAreaNamesByPref` のまとめ判定から外す（理由は同関数のコメント）。
  // 打ち切られるのは必ず下位の階級なので、上から順に積むこの持ち回りで整合する。
  const prefsWithAreaShown = new Set<string>()
  for (let i = maxIdx; i < SCALE_DESCENDING.length; i++) {
    const scale = SCALE_DESCENDING[i]
    const names = regionNamesForScale(points, scale, idx, prefsWithAreaShown)
    if (names.length > 0) observed.push({ scale, names })
    // 区域名だけを数える。県名でまとめた結果は areaPrefIndex から引けないので入らない。
    // これは**多区域の県が県名と同じ表記の区域を持たない**ことに依存する（stationCoords.test.ts が
    // 検証）。奈良県だけは県名と同名の区域を持つが単一区域なので、どちらに数えても出力は変わらない。
    for (const name of names) {
      const pref = idx.areaPrefIndex?.get(name)
      if (pref) prefsWithAreaShown.add(pref)
    }
  }

  const mentioned = new Set<string>()  // 上位階で読み上げ済みの地域名

  /**
   * 階級ごとの句を組む。`accept` に通った区域だけを対象にする。
   *
   * **`mentioned` は群をまたいで共有する。** 県単位に丸めた名前は複数の階級に現れうるので
   * （`aggregateAreaNamesByPref`）、群を分けても「上位で挙げた区域は下位で繰り返さない」を
   * 保つ必要がある。上がった群を先に回すこと。
   *
   * @param withMax その階級が電文の最大震度と一致するとき「最大」を冠するか
   */
  const collectParts = (
    accept: (name: string, scale: IntensityScale) => boolean,
    withMax: boolean,
  ): SpeechSegment[][] => {
    const parts: SpeechSegment[][] = []
    for (let rank = 0; rank < observed.length; rank++) {
      const { scale, names: observedNames } = observed[rank]
      // 設定した階数以内、または「必ず読み上げる震度」以上の階級を読む。どちらの条件も上位の
      // 階級ほど成立しやすいため、両方を外れた時点で以降の階級も必ず外れる（break で打ち切れる）。
      //
      // **打ち切りの判定に差分を混ぜないこと。** 階数（rank）は「観測がある階級」の並びで数えるため、
      // 差分で残った区域だけを見て数えると、上位の階級が据え置きだった続報で下位の階級が繰り上がり、
      // 普段は読まない震度まで読み始める。
      const withinLevels = rank <= opts.intensityLevels
      const withinAlwaysRead = opts.alwaysReadScale >= 0 && scale >= opts.alwaysReadScale
      if (!withinLevels && !withinAlwaysRead) break
      // 同じ文の中で上位階に出した区域を落とし、さらにこの群の条件に通ったものだけを残す。
      let names = observedNames.filter(n => !mentioned.has(n) && accept(n, scale))
      if (names.length === 0) continue
      // 選抜・上限・並べ替えは未入電の文と共有する（→ `selectRegionNames`）。
      const picked = selectRegionNames(names, opts, hypocenter, regionOrder)
      names = picked.names
      const omittedNames = picked.omittedNames
      names.forEach(n => mentioned.add(n))
      // 「最大」を冠せるのは、その階級がこの電文の最大震度に一致するときだけ。
      // **句の並び順で決めてはいけない**——差分では最大震度の区域が据え置きで落ちることがあり、
      // 先頭の句に無条件で付けると「最大震度4を…」と、電文が伝えていない最大震度を語る。
      // 初出の群では冠しない（`withMax`）。「新たに最大震度7を」は据わりが悪く、最大震度は
      // 地震全体の値なので「新たに」と並べる語ではない。
      const head = withMax && scale === maxScale ? '最大' : ''
      const segments: SpeechSegment[] = [plain(`${head}震度${intensityText(scale)}を`)]
      names.forEach((name, i) => {
        if (i > 0) segments.push(plain('、'))
        // 区域名だけを参照付きの断片にする。読点を含めると、チャンク（読点で切られる）と
        // 断片の境界がずれて引き当てが鈍る。
        segments.push({ text: name, refs: [{ kind: 'quakeRegion', name, scale }] })
      })
      // 名前を読まなかった分も、この断片が声になれば既読にする（→ `selectRegionNames`）。
      if (omittedNames.length > 0) {
        segments.push({
          text: `、ほか${omittedNames.length}地域`,
          refs: omittedNames.map(name => ({ kind: 'quakeRegion' as const, name, scale })),
        })
      }
      parts.push(segments)
    }
    return parts
  }

  /**
   * 階級ごとの句を 1 文にまとめる。
   *
   * 助詞「で」は末尾（述語の直前）にだけ置く。階級ごとの句末に付けると
   * 「〜福島県で、震度3を〜」と一文字が読点で挟まれ、読み上げがぶつ切りに聞こえる。
   * 複数階級のときは前の句が末尾の「で」を共有する形（並列句の格助詞の共有）になる。
   */
  const toSentence = (parts: SpeechSegment[][], lead: string): SpeechSegment[] => {
    if (parts.length === 0) return []
    const joined: SpeechSegment[] = lead ? [plain(lead)] : []
    parts.forEach((part, i) => {
      if (i > 0) joined.push(plain('、'))
      joined.push(...part)
    })
    joined.push(plain('で観測しました。'))
    return joined
  }

  /**
   * 震度点があるのに地域名を 1 件も作れなかったことを記録する。電文の観測点が座標テーブルに
   * 載っていない状態（DMDATA は観測点を pref: '' で積むので、テーブルが引けないと手がかりが
   * 何も残らない）。呼び出し側が最大震度だけの一文へ落とすので読み上げは成立するが、地域が
   * 丸ごと消えたことは記録に残す。読み上げごとに出すと同じ行でログが埋まるため間引く。
   *
   * **数えるのは `observed`。** 文が空になる理由には「続報で読む差分が無い」も含まれ、そちらは
   * 正常なので、組み上がった文の有無で判定すると続報のたびに警告が鳴る。
   * 座標テーブルの読み込み前は引けないのが当たり前なので黙る（起動直後の正常な過渡状態）。
   */
  const warnIfNoRegionNames = (): void => {
    if (observed.length === 0 && points.length > 0 && stationData) {
      warnNoRegionNames(() => log.warn('[tts] 震度点があるのに地域名を作れなかった（電文の観測点が座標テーブルに無い）'))
    }
  }

  // 差分を取らない読み（初報・別イベント・確定情報の通し読み）は 1 群のまま。
  //
  // **群分けと「新たに」は差分のときだけ。** 初報で「新たに」と言っても、何と比べて新しいのかが無い。
  // 判定は `spoken` の有無ではなく**区域を一度でも声にしたか**で行う。記録は地震の初報でも
  // 渡ってくる（空の状態で）ので、有無で見ると初報から「新たに」が付く。
  if (!spoken || spoken.regions.size === 0) {
    const all = toSentence(collectParts(() => true, true), '')
    if (all.length === 0) warnIfNoRegionNames()
    return all
  }

  // 差分は 2 群に分け、**上がった分を先に**読む。境目の「また、」で耳が切り替わり、
  // 「新たに」が後半だけに掛かることが伝わる。
  const upgraded = toSentence(collectParts((n, sc) => regionDiffKind(spoken, n, sc) === 'upgraded', true), '')
  const fresh = toSentence(
    collectParts((n, sc) => regionDiffKind(spoken, n, sc) === 'fresh', false),
    upgraded.length > 0 ? 'また、新たに' : '新たに',
  )
  if (upgraded.length === 0 && fresh.length === 0) {
    warnIfNoRegionNames()
    return []
  }
  return [...upgraded, ...fresh]
}

function magnitudeText(mag: number): string {
  // toFixed(1) で小数点以下1桁を明示し「きゅう」→「きゅうてんぜろ」のような誤読を防ぐ
  return mag.toFixed(1)
}

/**
 * 「マグニチュード7.1の」句を返す（「〜の地震が発生しました」に続ける）。規模不明では空文字。
 * 規模不明の電文は遠地地震で実在し、そのまま読ませると「NaN」「マイナス1.0」になる。
 */
function magnitudePhrase(mag: number): string {
  return hasMagnitude(mag) ? `マグニチュード${magnitudeText(mag)}の` : ''
}

/**
 * 規模が数値にならないときの説明（`jmx_eb:Magnitude@description`）の**述部**。
 *
 * **「Ｍ不明」と「Ｍ８を超える巨大地震」は別物**で、後者は M8 を超えて速報できないことを表す
 * （電文解説資料 Ⅱ.32/33/36）。数値が無いことだけを見て黙ると、最大級の地震ほど音声から
 * 規模が消える。
 *
 * **別の文にする。** 「マグニチュード〜の地震が発生しました」の句へ差し込むと
 * 「8を超える巨大地震の地震が発生しました」と重なる。
 *
 * **主題部（「マグニチュードは」）を含めない。** 初報と続報で主題部が変わるため
 * （→ {@link magnitudeConditionSentence} / {@link magnitudeConditionAmendSentence}）。
 * 表へ主題部まで書くと、続報側が文の頭を差し替えられず、値が変わったことを言えなくなる。
 */
const MAGNITUDE_CONDITION_PREDICATE: Record<string, string> = {
  'Ｍ不明': '不明です。',
  'Ｍ８を超える巨大地震': '8を超える巨大地震とみられます。',
}

/** 未知の説明を記録した値。同じ地震の続報で何度も来るので 1 度だけ出す。 */
const reportedUnknownMagnitudeConditions = new Set<string>()

/** 上の述部を引く。規模が数値なら（＝説明を読む必要が無ければ）空文字。 */
function magnitudeConditionPredicate(hypocenter: Hypocenter): string {
  const desc = hypocenter.magnitudeCondition
  if (!desc || hasMagnitude(hypocenter.magnitude)) return ''
  const known = MAGNITUDE_CONDITION_PREDICATE[desc]
  if (known) return known
  // 気象庁が語を増やしたときに黙らない。全角の「Ｍ」と全角数字だけを直して読む
  // （前に置く主題部の「マグニチュード」と重ならないよう先頭の「Ｍ」は落とす）。
  if (!reportedUnknownMagnitudeConditions.has(desc)) {
    reportedUnknownMagnitudeConditions.add(desc)
    log.warn(`[tts] 規模の説明に未知の表記があります（そのまま読みます）: ${desc}`)
  }
  const body = desc.replace(/^[ＭM]/, '').replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  return `${body}です。`
}

/** 初報で読む形。「マグニチュードは8を超える巨大地震とみられます。」 */
function magnitudeConditionSentence(hypocenter: Hypocenter): string {
  const predicate = magnitudeConditionPredicate(hypocenter)
  return predicate ? `マグニチュードは${predicate}` : ''
}

/**
 * 続報で**値が変わったとき**に読む形。「マグニチュードが更新されました。8を超える巨大地震とみられます。」
 *
 * **数値の規模（「マグニチュードは7.1に更新されました。」）と同じく、更新されたことを言う。**
 * 初報と同じ文へ落とすと、**最大級の地震でだけ「変わった」が声にならない** ——
 * 「Ｍ不明」から「Ｍ８を超える巨大地震」へ確定する続報がまさにその場面。
 *
 * **「〜に更新されました」の枠へ値を入れない。** マグニチュード（数値）を地震（出来事）へ
 * 更新することになり、「マグニチュードは8を超える巨大地震に更新されました。」と破綻する。
 * そこで**主題部だけを差し替え**、値は初報と同じ述部で言う。
 *
 * **主題部で「マグニチュード」を言うので、述部は主題を持たない**（そのための
 * {@link MAGNITUDE_CONDITION_PREDICATE} の切り分け）。
 */
function magnitudeConditionAmendSentence(hypocenter: Hypocenter): string {
  const predicate = magnitudeConditionPredicate(hypocenter)
  return predicate ? `マグニチュードが更新されました。${predicate}` : ''
}

/**
 * 既読の記録に載せる規模の値。
 *
 * **数値と説明を同じ鍵で持つ。** 別々にすると、「Ｍ不明」→「Ｍ８を超える巨大地震」→ 実測値、と
 * 段階的に確定していく続報で、変わったことを検出できない箇所が出る。
 */
function magnitudeFactValue(hypocenter: Hypocenter): string {
  return hasMagnitude(hypocenter.magnitude)
    ? magnitudeText(hypocenter.magnitude)
    : (hypocenter.magnitudeCondition ?? '')
}

/**
 * 「〇〇を震源とする」の深さ部分を返す（Destination/ScaleAndDestination 系）。
 * 表示側 formatDepth と判定を揃える（負値 = 不明 / 0 = ごく浅い）。負値では空文字を返す。
 * 深さ不明の電文は遠地地震で頻出し（`depth: {value: null, condition: "不明"}`）、
 * パーサはこれを -1 センチネルに落とすため、0 と同一視すると「ごく浅い場所」と誤読する。
 */
function depthSourcePhrase(depth: number): string {
  if (!hasDepth(depth)) return ''
  return depth === 0 ? 'ごく浅い場所' : `深さ${depth}キロメートル`
}

/**
 * 「〜に更新されました。」の並びへ入れる深さの句（顕著な地震の震源要素更新のお知らせ 系）。
 * **「震源の深さ」を含めて返す。** 深さ不明では空文字。
 *
 * **ごく浅い（深さ 0）だけ語形が 2 通りになる。** 数値の深さは「震源の深さ120キロメートル」という
 * 名詞句なので述語「に更新されました」へそのまま繋がるが、ごく浅いは数値を持たず名詞句にできない。
 * 後ろに規模が続くなら連用中止形（「震源の深さはごく浅く、マグニチュード〜」）で繋ぎ、続かないなら
 * {@link depthUpdateValue} と同じ「ごく浅い場所」を使って自分で述語へ繋ぐ。ここを連用中止形のまま
 * 言い切ると「震源の深さはごく浅くに更新されました。」という壊れた文になる。
 */
function depthAmendPhrase(depth: number, hasFollowing: boolean): string {
  if (!hasDepth(depth)) return ''
  if (depth !== 0) return `震源の深さ${depth}キロメートル`
  return hasFollowing ? '震源の深さはごく浅く' : `震源の深さは${depthUpdateValue(depth)}`
}

function intensityText(scale: IntensityScale | number): string {
  if (scale <= 0) return ''
  return getIntensityLabel(scale as IntensityScale)
}

/**
 * 地域名を 1 件も作れなかったときに添える一文。震度が判っていればそれだけを伝え、
 * 判らなければ何も返さない。`intensityText` は震度不明で空文字を返すので、確かめずに埋めると
 * 「最大震度を観測しました」という助詞だけの文になる（`maxScale` は無いのが正常な経路もある。
 * → docs/spec/data-sources-spec.md §3）。
 */
function maxScaleOnlySentence(maxScale: IntensityScale, unreceived = false): string {
  const label = intensityText(maxScale)
  if (!label) return ''
  // **未入電を「観測しました」と言わない。** 電文が「5弱以上・未入電」と明言している値を
  // 断定形で読むと、実際にはもっと強い可能性があることが音声だけの利用者に伝わらない
  // （EEW が上限を定めない予想震度を「以上」と読むのと同じ扱い）。
  // 語は地点を挙げる文と揃える（→ `unreceivedRegionSegments`）。
  return unreceived
    ? `最大震度${label}以上と推定されますが、未入電です。`
    : `最大震度${label}を観測しました。`
}

/**
 * 上の一文を断片にしたもの。**伝えたことを `maxScaleOnly` として覚える**ので、続報で
 * 地域名が作れないままでも、同じ震度なら言い直さず、震度が変わったときだけ読み直す。
 *
 * `spoken` を渡さない経路（全文を組み立てる `earthquakeToText`）では既読を見ずに必ず返す。
 */
function maxScaleOnlySegments(maxScale: IntensityScale, spoken?: QuakeSpokenState, unreceived = false): SpeechSegment[] {
  const sentence = maxScaleOnlySentence(maxScale, unreceived)
  if (!sentence) return []
  // 既読の鍵に未入電の別も含める。同じ階級でも「観測しました」と「以上と推定されます」は
  // 別の内容なので、片方を読んだからと言ってもう片方を省いてはいけない。
  const value = unreceived ? `${maxScale}!` : String(maxScale)
  if (spoken?.facts.get('maxScaleOnly') === value) return []
  return [{ text: sentence, refs: [{ kind: 'quakeFact', fact: 'maxScaleOnly', value }] }]
}

/**
 * 「21時34分」形式。**日時として読めなければ `null`** —— 呼び出し側は時刻の句ごと落とす。
 * 素通しにすると「ナンじナンぷん」と**音声に出る**（画面と違い、聞き手は読み飛ばせない）。
 */
function formatTime(isoTime: string): string | null {
  const d = readDateTime('ttsText.formatTime', isoTime)
  if (!d) return null
  // 分をゼロ埋めすると VOICEVOX が「06分」を「ぜろろくふん」と桁読みしてしまうため、
  // TTS 用テキストではゼロ埋めしない（表示用の formatters.ts の formatTime とは別）
  return `${d.getHours()}時${d.getMinutes()}分`
}

/**
 * 日を読み上げ用の表記にする。**1 日だけ「ついたち」と書く。**
 *
 * 合成エンジンは `1日` を「いちにち」と読む（日付としては誤り）。句区切り辞書で直そうとすると、
 * 期間を指す「1日程度」「1日おきに」まで拾ってしまう —— 辞書は文字列しか見ないので、日付か
 * 期間かを区別できない。**アプリが組む文は `d.getDate()` から作っていて日付だと確定している**
 * ので、ここで読みへ直せば曖昧さが残らない。
 *
 * **2 日以降は仮名で書かない。** エンジンがかえって崩す（実測: `じゅうしちにち` は
 * `ジュウ[1] | シチニチ[2]` で頭高が反転し、`にじゅういちにち` は `ニジュウイチニ | チ` と
 * 途中で割れる）。あちらは読みが正しく抑揚だけの問題なので、句区切り辞書で核を直す。
 */
function speakableDay(day: number): string {
  return day === 1 ? 'ついたち' : `${day}日`
}

/**
 * 気象庁が書いた文の中で、**日付として確定している「1日」だけ**を読みへ直す。
 *
 * **直後が「N時」の形に限る**（`1日16時27分現在の、`）。期間を指す「1日程度」「1日おきに」は
 * もちろん、「1日2回」のような頻度表現も巻き込まない。前も見るのは `11日` `21日` `31日` の
 * 2 文字目を拾わないため。
 *
 * 実電文由来のローカルデータを走査すると「N日＋数字」はすべて「N日N時」の形だったが、
 * 自由付加文は書式が決まっていないので、数字が続くだけでは日付と決めつけない。
 */
function speakableDayInText(text: string): string {
  return text.replace(/(^|[^0-9０-９])1日(?=[0-9０-９]{1,2}時)/g, '$1ついたち')
}

/**
 * 「10日21時34分」形式。遠地地震は発表が発生から数十分後になることがあり、
 * 日付をまたいで受信する場合があるため日から読み上げる。
 *
 * `formatTime` を呼ばず自前で組むのは、記録に出る名前を呼び出し元と一致させるため。
 */
function formatDayTime(isoTime: string): string | null {
  const d = readDateTime('ttsText.formatDayTime', isoTime)
  if (!d) return null
  return `${speakableDay(d.getDate())}${d.getHours()}時${d.getMinutes()}分`
}

/**
 * VXSE43/45 EEW の誤報取消の読み上げテキストを生成する。
 *
 * **述語は「取り消されました」。** 気象庁が使う語は「取消」で（→ CLAUDE.md「利用者へ出す語を
 * 気象庁の表現と揃える」）、カードのオーバーレイも「この緊急地震速報は取り消されました」と
 * 書いている。津波・南海トラフ臨時情報・地震回数の取消も同じ述語。
 */
export function eewCancelToText(event: EEWAlert): string {
  const time = event.issue?.time ? formatTime(event.issue.time) : null
  const head = time
    ? `${time}に発表された緊急地震速報は取り消されました。`
    : '緊急地震速報は取り消されました。'
  // 地震情報・津波情報と同じ扱い（→ `cancelReasonSentence`）。3 つの電文で揃えないと、
  // 同じ事象なのに種別によって理由が出たり出なかったりする
  return head + cancelReasonSentence(event.cancelText)
}

/**
 * VXSE51/52/53/61 地震情報取消の読み上げテキストを生成する。
 * time は取消電文自体の発表時刻ではなく、同一 eventId で最後に受信した地震情報の発表時刻を渡すこと
 * （呼び出し側 useLiveEventHandler.ts で解決する）。
 */
export function earthquakeCancelToText(time: string | null, cancelText?: string): string {
  const formatted = time ? formatTime(time) : null
  // 述語は「取り消されました」で全種別そろえる（→ `eewCancelToText`）。
  const head = formatted
    ? `${formatted}に発表された地震情報は取り消されました。`
    : '地震情報は取り消されました。'
  return head + cancelReasonSentence(cancelText)
}

/**
 * 取消しの概要（電文の `Body/Text`）を読み上げへ足す句。無ければ空。
 * → docs/spec/audio-tts-spec.md §4「取消は「取り消された事実」だけを伝える」
 *
 * **気象庁が書いた理由をそのまま読む。** アプリの定型文（「取り消されました」）は何が
 * 起きたかしか言っておらず、なぜ取り消したのかは電文のこの本文にしか無い。
 *
 * **ただし取消の宣言だけの本文は読まない**（→ `CANCEL_DECLARATION_SUBJECTS`）。定型文が同じ事実を
 * 先に述べているので、続けて読むと同じことを 2 度言う。宣言の形でも主語が既知の情報名でなければ
 * 理由が混ざっているものとして読む（そちらへ倒す理由は `CANCEL_DECLARATION`）。
 *
 * **長い本文は読まない。** 取消しの概要は 1〜2 文が通例だが、他の自由文と同じく長文が入りうる。
 * 読み上げが伸びると後続の電文が待ちの上限に達して割り込むため、上限を超えたら画面に委ねる。
 *
 * @param staysOnScreen 省いた本文が画面に残るか。地震・津波・EEW は取消のあともカードが残って
 *   全文を出すので既定は `true`。**地震回数だけは取消で帯ごと消える**ので `false` を渡す ——
 *   記録が「画面には全文が出ます」と言い続けると、読み上げも表示も失われた事実が残らない。
 */
function cancelReasonSentence(cancelText: string | undefined, staysOnScreen = true): string {
  // 取消の理由も気象庁が書いた文なので、日時は全角のゼロ埋めで来る（`１６日０１時２５分`）。
  // 半角・ゼロ埋めなしへ揃えないと先頭の 0 が桁として読まれる（→ {@link normalizeDateTimeForSpeech}）。
  // **この関数は 4 種別（EEW・地震情報・津波・地震回数）の取消が共有している。**
  const text = normalizeDateTimeForSpeech(cancelText ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const subject = CANCEL_DECLARATION.exec(text)?.[1]
  if (subject !== undefined) {
    if (CANCEL_DECLARATION_SUBJECTS.has(subject)) {
      // **省いたことを残す。** 取消は実電文で年に数通しか出ないため、毎回記録しても
      // 他の記録を埋めない。
      log.info(`[tts] 取消の宣言だけの本文なので読み上げを省きました（${text}）`)
      return ''
    }
    // **宣言の形だが主語が既知の情報名でないので読む。** ここが「落とし損ね」の検知点 ——
    // 実電文に無い情報名で宣言が来たら、この記録を見て主語の集合へ足すかを判断する
    // （逆に理由が混ざっていた場合は、読む側へ倒れているので情報は失われない）。
    log.info(`[tts] 取消の宣言の形だが「${subject}」が既知の情報名でないため読み上げます（${text}）`)
  }
  if (text.length > CANCEL_REASON_SPEAK_MAX_CHARS) {
    // **捨てたことを残す。** 気象庁が書いた理由を丸ごと落とすので、痕跡が無いと
    // 「今日は長文だったから読まなかった」を後から確かめられない。
    const where = staysOnScreen ? '画面には全文が出ます' : '画面にも残りません'
    log.info(`[tts] 取消しの概要が長いため読み上げを省きました（${text.length}文字。${where}）`)
    return ''
  }
  // 電文の本文は句点で終わることが多いが、終わっていなければ足す（次の文と繋がって聞こえないため）
  return /[。．]$/.test(text) ? text : `${text}。`
}

/**
 * 取消しの概要を読み上げる上限（文字数）。
 *
 * 実電文の取消しの概要は 1 文（例「先ほどの、震度速報を取り消します。」）。
 * 超える本文は画面に委ねる —— 読み上げが伸びると、後続の電文が待ちの上限
 * （`HIGHER_PRIORITY_SPEECH_MAX_WAIT_MS`）に達して割り込む。
 */
export const CANCEL_REASON_SPEAK_MAX_CHARS = 120

/**
 * 取消の宣言の形。捕獲するのは「何を取り消すか」の主語で、それが情報名そのものなら
 * 宣言だけの本文（→ `CANCEL_DECLARATION_SUBJECTS`）。
 * → docs/spec/audio-tts-spec.md §4「文の形だけで落とさない。主語を照合する」
 *
 * 「は」も見るのは電文解説資料の記載例（「先ほどの、緊急地震速報（予報）は取り消します。」）が
 * そちらの形だから。主語は最短で採る（情報名に「を」「は」は含まれない）。
 *
 * **形だけで落としてはいけない。** かつて主語の中身を見ずに「読点・句点を挟まない」だけで
 * 落としていたが、それでは理由を織り込んだ本文まで無音で捨てる:
 *
 * - 「先ほどの、装置の誤作動による誤報を取り消します。」
 * - 「先ほどの、通信障害により発表した緊急地震速報を取り消します。」
 * - 「先ほどの、観測データの誤りのため震度速報を取り消します。」
 *
 * **落とし損ねと誤って落とすのは重さが違う。** 前者は同じことを 2 度述べる元の状態に戻るだけ、
 * 後者は気象庁が書いた理由を失う。だから主語を照合する側へ倒す。
 */
const CANCEL_DECLARATION = /^先ほどの、?(.+?)(?:を|は)取り消します[。．]?$/

/**
 * 取消の宣言で主語に立つ情報名。ここに一致した本文だけを読み上げから落とす
 * （アプリの定型文が同じ事実を先に述べているため）。
 *
 * **実電文で観測できたものだけを入れる**（実配信の標本が無い種別は、気象庁の公式サンプル電文で
 * 観測できたものまで）。DMDATA アーカイブの目録がある全期間と、国立情報学研究所「気象庁防災情報
 * XML データベース」（2012-12〜2026-09）を走査して得られた取消は 53 通で、本文は 4 通りしか
 * なかった。**走査先ごとの通数は docs/spec/quake-spec.md §8 が単一情報源**（ここへ写すと
 * 更新が片方に留まる）。
 *
 * | 本文 | 通数 |
 * |---|---|
 * | 先ほどの、緊急地震速報（予報）を取り消します。 | 28 |
 * | 先ほどの、緊急地震速報（地震動予報）を取り消します。 | 23 |
 * | 先ほどの、震度速報を取り消します。 | 1 |
 * | 先ほどの、震源・震度情報を取り消します。 | 1 |
 *
 * 「地震回数に関する情報」は実配信の標本が無く、気象庁の公式サンプル電文から採った
 * （この種別は 2012-12 以降の全アーカイブで 1 通も配信されていない）。
 *
 * **標本の無い種別（津波など）では二度述べが残る。** そのとき記録が出る（`cancelReasonSentence`
 * の「既知の情報名でないため読み上げます」）ので、それを見て足すかを判断する。**先回りして
 * 情報名の一覧を書き並べないこと** —— 起きていない形に合わせると、理由入りの本文を落とす側へ
 * 逆戻りする。
 *
 * 理由を書く場所であること自体は変わらない。電文解説資料の共通別紙ウ「取消電文の運用」は
 * `Body/Text` を「取消の概要や理由等の文章」と定めている。
 */
const CANCEL_DECLARATION_SUBJECTS: ReadonlySet<string> = new Set([
  '緊急地震速報（予報）',
  '緊急地震速報（地震動予報）',
  '震度速報',
  '震源・震度情報',
  '地震回数に関する情報',
])

/**
 * EEW 第1フェーズ（新規発報の即時、または続報での震源更新時）の読み上げテキストを生成する。
 *
 * **切り出しの語で区分を伝える。** 実際の電文が別物なので、名前も分ける。
 *
 * | `kind` | 読み上げ | 対応する電文 |
 * |---|---|---|
 * | `forecast` | 「地震動予報、〇〇で地震。」 | VXSE45 緊急地震速報（地震動予報） |
 * | `warning` | 「緊急地震速報、〇〇で地震。」 | VXSE43 緊急地震速報（警報） |
 * | `hypocenterUpdate` | 「震源を更新、〇〇で地震。」 | 続報で震源名が大きく変わったケース |
 *
 * **これは気象庁の用語法からの意図的な逸脱。** 気象庁は「緊急地震速報」を警報と予報の両方を
 * 含む上位の名前として使う。ここでは音声で区別が付くことを優先し、警報級だけを
 * 「緊急地震速報」と読む。予報級まで「緊急地震速報」と読むと、一般に流れるのが警報だけである
 * ことから「警報が出た」と聞こえてしまい、実際より重く伝わる。
 *
 * 震源更新では区分に触れない。すでに伝えてあるうえ、変わったのは震源だから。
 */
export function eewAlertToText(event: EEWAlert, kind: 'forecast' | 'warning' | 'hypocenterUpdate'): string {
  return `${EEW_LEAD_PHRASE[kind]}${event.earthquake.hypocenter.name}で地震。`
}

/**
 * EEW 第 1 フェーズの切り出し語。区分ごとに 1 つずつ、**全部で 3 通りしかない**。
 *
 * 震源名にも予想震度にも依存しないので、起動時に合成して持っておける
 * （`warmFixedPhrases`）。EEW は間を置かずに読み始める都合で先行合成（`prewarmVoicevox`）が
 * 使えず、合成の往復がそのまま「声が出るまでの空白」になっていた。実測で 238〜697ms
 * （2024/1/1 能登のリプレイ。地震情報を切って割り込んだ場面で 479ms）。
 * 作り置きが当たれば、最初のチャンクはこの往復を丸ごと省ける。
 *
 * **句読点で終わること。** `splitIntoChunks` は句読点の後ろで切るため、ここが単独のチャンクに
 * ならないと作り置きと照合できない（5 文字未満だと次のチャンクに結合される点にも注意）。
 *
 * この一致が崩れても**何も起きない**——作り置きは正常に作られ、ただ一度も引かれなくなるだけで、
 * 症状は「第 1 報の声がわずかに遅い」、ログは無言。文言を変えるときも分割条件を変えるときも
 * 気づけないので、`voicevox.test.ts` の「読み上げ文の 1 チャンク目が、作り置きの対象と一致する」
 * が実物どうしを突き合わせて固定している。
 */
const EEW_LEAD_PHRASE = {
  forecast: '地震動予報、',
  warning: '緊急地震速報、',
  hypocenterUpdate: '震源を更新、',
} as const

/** {@link EEW_LEAD_PHRASE} の全パターン。作り置きの対象として渡す。 */
export const EEW_LEAD_PHRASES: readonly string[] = Object.values(EEW_LEAD_PHRASE)

/**
 * EEW 第 1.5 フェーズ（警報の対象地方）の読み上げ文。
 *
 * 第 1 フェーズ（名乗りと震源）と第 2 フェーズ（予想値）のあいだに挟む。**予想値の読み上げを
 * 遅らせる**のが狙いで、待っているあいだに続報が届けば、第 2 フェーズは新しい確定値を読める。
 * 同時に「どこが対象か」という、その時点で既に確定している事実を先に伝えられる。
 *
 * @param regions これから声にする地方。**呼び出し側が「既に声にした分」を除いて渡す**
 *   （電文の `LastKind` では判定しない。理由は `readEewWarningRegions` の JSDoc）
 * @param isAdditional この EEW で既に地方を声にしているか。真なら「新たに」を冠する
 *   （**判定は「声にしたか」であって「電文が新規と言ったか」ではない**。割り込みで消えた発話を
 *   基準にすると、一度も声にしていない地方を「新たに」と言うことになる。地震情報の続報と同じ規律）
 * @param announceUpgrade 「緊急地震速報に切り替わりました。」を前置きするか。**予報として
 *   発報された EEW が警報へ上がり、まだ区分を声にしていないときだけ真にすること**（判定は
 *   呼び出し側。`eewIntensityText` の同名引数と同じ材料＝声にした区分で決める）。
 *
 *   **この前置きがここに要るのは、地方のブロックが警報級の報にしか入らないため。** 予報から
 *   警報へ上がった報では、地方の読み上げが必ずその EEW で最初の「警報になった」告知になる。
 *   区分を第 2 フェーズの前置きだけに任せると、そちらは予想値の安定待ちを経てから鳴るので、
 *   「〇〇では強い揺れに警戒してください。」が「緊急地震速報に切り替わりました。」より先に出る。
 *
 *   文言を第 2 フェーズと同じにしてあるのは、どちらが先に鳴っても聞こえ方を揃えるため。
 *   前置きを声にしたら呼び出し側が区分を既読にするので、両方から言われることはない。
 *
 * 区切りに読点を使うのは、中黒が音にならず合成の区切りにもならないため（→ §4「読み上げ文で
 * 名前を並べるときの書き方」）。
 */
export function eewWarningRegionsText(
  regions: readonly string[], isAdditional: boolean, announceUpgrade = false,
): string {
  if (regions.length === 0) return ''
  const names = regions.join('、')
  const prefix = announceUpgrade ? '緊急地震速報に切り替わりました。' : ''
  return prefix + (isAdditional
    ? `新たに、${names}でも強い揺れに警戒してください。`
    : `${names}では強い揺れに警戒してください。`)
}

/**
 * 予想震度が付いていないときの句。理由の判定は `eewNoForecastReason` に委ねる
 * （待たずに読むかどうかの判断と同じ判定を使うため。二重に持つと食い違う）。
 */
function noForecastText(event: EEWAlert): string {
  switch (eewNoForecastReason(event)) {
    case 'assumed': return '単独点処理のため、予想震度なし。'
    case 'deep':    return '深発地震のため、予想震度なし。'
    case 'unknown': return '予想震度なし。'
  }
}

/**
 * 震度部分だけの読み上げ文（「予想最大震度〇〇。」または理由付きの「予想震度なし。」）。
 * `eewIntensityText` が内部で使う（`lpgmClass` が未確定・0 のときは階級部分が空文字になる
 * ことで、結果的にこちらだけが声になる）。
 *
 * `scaleInfo` は呼び出し側で確定させた値を渡す（`event` から直接取り直さない）。安定待ちで
 * 「この値に確定した」と判定したタイミングと、実際に声になるタイミングにはズレがありうるため、
 * どの値を読んだかを呼び出し側が制御できるようにしている。
 *
 * 震度を伝えられないときに階級句を落とすのは、結合する `eewIntensityText` の役目
 * （この関数は震度部分だけを組み立てる）。
 */
export function eewScaleOnlyText(scaleInfo: EewMaxScaleInfo, event: EEWAlert): string {
  if (scaleInfo.scale > 0) {
    return `予想最大震度${getIntensityLabelWithApproxAbove(scaleInfo.scale, scaleInfo.orAbove)}。`
  }
  return noForecastText(event)
}

/**
 * 長周期地震動階級部分だけの読み上げ文（「予想最大階級〇。」）。0 なら空文字列
 * （句ごと省く。音声には地図の色フォールバックのような逃げ場が無く、不正値がそのまま
 * 声に出るのを避けるため）。
 */
export function eewLpgmOnlyText(lpgmClass: number, over = false): string {
  // 「程度以上」は気象庁の表現（→ `getLpgmClassLabelWithApproxAbove` のコメント）。
  return lpgmClass > 0 ? `予想最大階級${lpgmClass}${over ? '程度以上' : ''}。` : ''
}


/**
 * EEW 第2フェーズ（予想値）の読み上げテキストを、震度・階級それぞれの部分から組み立てる。
 * `eewScaleOnlyText` / `eewLpgmOnlyText` の結合ロジックを呼び出し側（`useLiveEventHandler`）と
 * 共有するためのヘルパー。初報・続報の区別なく同じ形で読む。
 *
 * `scaleInfo`・`lpgmClass` は呼び出し側で確定させた値を渡す（`event` から直接取り直さない）。
 * 安定待ちで「この値に確定した」と判定したタイミングと、実際に声になるタイミングにはズレが
 * ありうるため、どの値を読んだかを呼び出し側が制御できるようにしている。
 *
 * `announceUpgrade` が真のとき「緊急地震速報に切り替わりました。」を前置きする。
 * **予報として発報された EEW が警報へ格上げされたときだけ真にすること**（判定は呼び出し側）。
 *
 * 遷移の言い方にしているのは、第 1 フェーズで「地震動予報、〇〇で地震。」と伝えてあるため。
 * 聞き手は前の区分を知っているので「何から何に変わったか」が通じる。ここを「警報。」のような
 * 区分名だけにすると、値の読み上げの前に単語が挟まるだけで変化が伝わらない。
 *
 * 逆に、初報から警報だった場合はここでは何も前置きしない。第 1 フェーズが既に
 * 「緊急地震速報、〇〇で地震。」と伝えており、重ねて言う意味がないため。
 *
 * **「特別警報」は読み上げない。** 特別警報の条件を満たしていても、格上げとして読み上げるのは
 * 予報→警報のときだけ。気象庁が発表時にこの名称を用いないため（根拠と条件は
 * docs/spec/eew-spec.md §4）。画面表示・ブラウザ通知・通知音は内部の重大度区分として 2 段階を保つ。
 *
 * 引き上げ専用の短句（「震度6弱に引き上げ。」）は持たない。同じ形で言い直せば足りるうえ、
 * 差分の言い方は「基準にした値を実際に発話したか」に依存し、割り込みで消えた発話を基準に
 * すると一度も声に出していない値からの引き上げを語ることになるため。
 *
 * 呼び出し側（`useLiveEventHandler`）は震度・階級のどちらが先に確定していても常にこの関数を
 * 呼ぶ——未確定の階級は `lpgmClass=0` として渡せば `eewLpgmOnlyText` が空文字を返し、
 * 結果的に震度部分だけが声になる（「個別に呼び分ける」のではなく、0 扱いで自然に省略させる）。
 */
export function eewIntensityText(
  scaleInfo: EewMaxScaleInfo, lpgmClass: number, event: EEWAlert, announceUpgrade = false,
  /**
   * 階級が「程度以上」だったか。**`event` から引き直さない** —— 渡される `lpgmClass` は
   * 安定待ちを経た確定値で、現在の報の値と食い違いうる。引き直すと別の値に語を貼り付ける。
   */
  lpgmOver = false,
  /**
   * 読み上げ設定。`readEewLpgmClass` が偽なら階級の句を落とす（既定＝未指定は読む）。
   * 震度側は落とさない ―― 緊急地震速報の主題そのもので、切る選択肢を設けていない。
   */
  opts?: TtsSpeechOptions,
): string {
  const prefix = announceUpgrade ? '緊急地震速報に切り替わりました。' : ''
  // 上限が定まらない報（仮定震源要素の初報など）は「震度4以上」と読む。値だけ読むと
  // 下限を断定した放送になる（判定は eewMaxScaleInfo・語の付け方は表示と共通）。
  //
  // **震度を伝えられないときは階級も読まない**（判定は `canPresentLpgmClass`。カード表示・
  // 第 2 フェーズの言い直しと同じ述語を共有する。理由はそちらのコメント）。
  const scaleText = eewScaleOnlyText(scaleInfo, event)
  const lpgmText = (opts?.readEewLpgmClass ?? true) && canPresentLpgmClass(scaleInfo.scale, lpgmClass)
    ? eewLpgmOnlyText(lpgmClass, lpgmOver)
    : ''
  return prefix + scaleText + lpgmText
}

/**
 * 試聴文を組むための緊急地震速報。**画面にも音にも流れない**——`voicevoxPreviewTexts` が
 * 読み上げ文を作るためだけに使う。
 *
 * 読み上げ文が見るのは震源名と、予想震度が付いていないときの理由（`eewNoForecastReason`）だけ。
 * それ以外は型を満たすために置いた値で、**座標・深さ・規模は声にならない**（`test` も同じで、
 * 流す経路に載っていないため抑制の意味を持たない）。**読み上げ文の側が新しいフィールドを
 * 読むようになったら、ここの値が声にしてよいものかを見直すこと。**
 */
const PREVIEW_EEW: EEWAlert = {
  kind: 'eew',
  id: 'voicevox-preview',
  time: '',
  test: true,
  earthquake: {
    originTime: '',
    arrivalTime: '',
    condition: '',
    hypocenter: { name: '三陸沖', latitude: 38.5, longitude: 143.0, depth: 10, magnitude: 7.2 },
  },
  severity: 'Warning',
  cancelled: false,
}

/** 試聴で読ませる予想震度（6強）。語の組み立てを実運用と共有するため階級値で持つ。 */
const PREVIEW_EEW_SCALE: EewMaxScaleInfo = { scale: 60, orAbove: false }

/**
 * 設定タブの「試聴」で読ませる文。緊急地震速報（警報）を想定して
 * 「緊急地震速報、三陸沖で地震。」「予想最大震度6強。」を返す。
 *
 * **文字列を直接書かず、実運用と同じ関数から組む。** 直接書くと緊急地震速報の文型を変えたときに
 * 試聴だけ古い形で残り、試聴で聞いた鳴り方と実際の鳴り方が食い違う。実際にそうなっていた——
 * 地震情報の文型を借りた「三陸沖を震源とするマグニチュード7.2の地震が発生しました。」を
 * 読ませており、緊急地震速報はその形を一度も作らない。
 *
 * **発話ごとに分けて返す。繋げて 1 つにしない。** 実運用は第 1 フェーズ（切り出しと震源）と
 * 第 2 フェーズ（予想値）を別々に鳴らすため、「〇〇で地震。」はそこでは最後のチャンクになり、
 * 末尾の句点に間が付かない。繋げて 1 回で渡すと途中のチャンクへ変わり、**実運用には無い
 * 110ms の無音が挟まる**（`utils/voicevox.ts` の `CHUNK_BREAK_PAUSE`）。
 *
 * **ただし発話の間隔までは再現しない。** 実運用の第 2 フェーズは続報を待つ安定待ちを経てから
 * 声になるもので（§6）、待ち時間は電文の到着間隔で決まる。試聴は前の発話が終わり次第続ける。
 */
export function voicevoxPreviewTexts(): readonly string[] {
  return [
    eewAlertToText(PREVIEW_EEW, 'warning'),
    eewIntensityText(PREVIEW_EEW_SCALE, 0, PREVIEW_EEW),
  ]
}

function domesticTsunamiText(t: DomesticTsunami): string {
  switch (t) {
    case 'なし':           return 'この地震による津波の心配はありません。'
    case '若干の海面変動':  return 'この地震による若干の海面変動が予想されますが、被害の心配はありません。'
    case '調査中':         return 'この地震による津波の有無を調査中です。'
    case '海面変動の可能性': return '震源が海底のため、津波が発生するおそれがあります。'
    case '注意報':         return '現在津波注意報を発表中です。'
    case '警報等':         return '現在津波警報等を発表中です。'
    case '不明':           return '津波情報は不明です。'
  }
}

/**
 * 震源要素を伝える句を、要素ごとに参照付きの断片へ分ける。
 * 連結すると「〇〇、深さ120キロメートルを震源とするマグニチュード7.1の地震が発生しました。」になる。
 * 震源名・深さ・規模のいずれが欠けても文が破綻しないよう、欠けた要素は句ごと省く（震源名が取れない
 * 電文では震源に触れず規模だけを伝える文になる）。
 *
 * 要素ごとに分けるのは、**チャンクが読点で切られる**ため。震源名と深さの間には読点が入るので、
 * ひとつの断片にまとめると「震源名しか鳴っていないのに深さも規模も声になった」と記録される。
 */
function quakeOccurrenceSegments(hypocenter: Hypocenter, opts?: TtsSpeechOptions): SpeechSegment[] {
  const tellable = tellableHypocenterFacts(hypocenter, opts)
  const segments: SpeechSegment[] = []
  if (tellable.has('hypocenterName')) {
    segments.push({ text: hypocenter.name, refs: [{ kind: 'quakeFact', fact: 'hypocenterName', value: hypocenter.name }] })
    if (tellable.has('depth')) {
      segments.push(plain('、'))
      segments.push({ text: depthSourcePhrase(hypocenter.depth), refs: [{ kind: 'quakeFact', fact: 'depth', value: String(hypocenter.depth) }] })
    }
    segments.push(plain('を震源とする'))
  }
  const magRef: SpeechRef[] = [{ kind: 'quakeFact', fact: 'magnitude', value: magnitudeFactValue(hypocenter) }]
  const numeric = magnitudePhrase(hypocenter.magnitude)
  if (tellable.has('magnitude') && numeric) {
    segments.push({ text: numeric, refs: magRef })
  }
  segments.push(plain('地震が発生しました。'))
  // 数値にならない規模は、句へ差し込まず別の文で伝える（→ magnitudeConditionSentence）。
  if (tellable.has('magnitude') && !numeric) {
    segments.push({ text: magnitudeConditionSentence(hypocenter), refs: magRef })
  }
  return segments
}

/** 津波区分の文を参照付きの断片にする（続報で区分が変わったときだけ読み直すため）。 */
function domesticTsunamiSegment(t: DomesticTsunami): SpeechSegment {
  return { text: domesticTsunamiText(t), refs: [{ kind: 'quakeFact', fact: 'domesticTsunami', value: t }] }
}

/**
 * 「震源の深さは〇〇に更新されました。」の〇〇部分。
 *
 * {@link depthSourcePhrase} は「深さ10キロメートル」を返すため、この文には使えない
 * （「震源の深さは深さ10キロメートルに」と重なる）。深さ不明では空文字。
 */
function depthUpdateValue(depth: number): string {
  if (!hasDepth(depth)) return ''
  return depth === 0 ? 'ごく浅い場所' : `${depth}キロメートル`
}

/**
 * この震源要素のうち、**声にしうるもの**（＝記録されうるもの）。
 *
 * **読む側（{@link quakeOccurrenceSegments} / {@link changedFactSegments}）と、記録を待つ側
 * （{@link hasUnspokenFact}）は必ずこれを使うこと。** 条件を各所に書くと必ずずれる ―― 実際、
 * 深さの条件が生成側とだけ食い違い、記録される機会の無い事実を待って**その地震だけ永久に
 * 全文読みへ戻る**不具合を作った（docs/spec/audio-tts-spec.md §4）。
 *
 * **深さは震源名の句の中でしか読まれない。** 震源名が空の電文では「〇〇、深さ10キロメートルを
 * 震源とする」の句ごと落ちるため、深さが判っていても声にならない。
 */
function tellableHypocenterFacts(hypocenter: Hypocenter, opts?: TtsSpeechOptions): Set<QuakeFact> {
  // 既定（未指定）は従来どおり深さ・規模とも語る。設定で切ったときだけ震源名へ絞る。
  const detail = opts?.readHypocenterDetail ?? true
  const facts = new Set<QuakeFact>()
  if (hypocenter.name) {
    facts.add('hypocenterName')
    if (detail && depthSourcePhrase(hypocenter.depth)) facts.add('depth')
  }
  if (!detail) return facts
  // 数値が読めなくても、気象庁が説明を添えていれば規模は語れる（「Ｍ８を超える巨大地震」）。
  if (magnitudePhrase(hypocenter.magnitude) || magnitudeConditionSentence(hypocenter)) facts.add('magnitude')
  return facts
}

/**
 * 上に津波区分を足した、この電文が声にしうる事実の全体。
 *
 * **`maxScaleOnly` はここに載せない。** これは「地域名を作れなかったときの代替」であって
 * 電文が普通に伝える事実ではない。載せると `hasUnspokenFact` が常に真を返し、地域名を作れる
 * 正常な地震でも差分の経路に入らなくなる（毎報が全文になる）。
 */
function tellableFacts(event: JMAQuake, opts?: TtsSpeechOptions): Set<QuakeFact> {
  const facts = tellableHypocenterFacts(event.earthquake.hypocenter, opts)
  if (domesticTsunamiText(event.earthquake.domesticTsunami)) facts.add('domesticTsunami')
  return facts
}

/**
 * この電文が伝える震源要素・津波区分のうち、**まだ一度も声にしていないもの**があるか。
 *
 * あるなら続報でも差分にせず、初報と同じ形（時刻・震源・規模・津波を通しで言う文）へ回す。
 * 未記録には理由が 2 つあり、**どちらも「更新されました」と言うのは正しくない**。
 *
 * - 初報の時点では値が不明だった（深さ・規模は後の報で確定することがある）
 * - 初報の該当箇所が割り込みで鳴らなかった（→ docs/spec/audio-tts-spec.md §4
 *   「既読になるのは「声になった分」だけ」）
 *
 * **未記録を「変化なし」として省いてはいけない。** 省くと、その要素はその地震の続報が続く限り
 * 二度と声にならない（同じ種別の報が来る限り初報の経路にも戻らない）。区域側の
 * {@link isUnspokenRegion} が「未記録＝読む」としているのと、意味を揃えるための判定。
 */
function hasUnspokenFact(event: JMAQuake, spoken: QuakeSpokenState, opts?: TtsSpeechOptions): boolean {
  return [...tellableFacts(event, opts)].some(fact => !spoken.facts.has(fact))
}

/**
 * 続報で「値が変わった震源要素」だけを言い直す断片列を作る。変化が無ければ空。
 *
 * **震度速報では呼ばないこと。** 震度速報は震源要素も津波区分も伝えない電文で、
 * `hypocenter` はセンチネル（`-200` / `-1`）、`domesticTsunami` は「調査中」が入る。
 * 素直に比べると、震源情報で伝えた「津波の心配はありません」から変化したと誤検出し、
 * 続報のたびに「津波の有無を調査中です」と言い出す。
 */
function changedFactSegments(event: JMAQuake, spoken: QuakeSpokenState, opts?: TtsSpeechOptions): SpeechSegment[] {
  const { hypocenter, domesticTsunami } = event.earthquake
  const tellable = tellableFacts(event, opts)
  const segments: SpeechSegment[] = []
  // 声にしうる事実のうち、記録と値が違うものだけ。未記録がここへ来ることは無い
  // （呼び出し前に {@link hasUnspokenFact} で弾き、初報と同じ形で言い直す側へ回している）。
  // `has` の判定はその保証が崩れたときの安全弁として残す。
  const changed = (fact: QuakeFact, value: string): boolean =>
    tellable.has(fact) && spoken.facts.has(fact) && spoken.facts.get(fact) !== value

  if (changed('hypocenterName', hypocenter.name)) {
    segments.push({ text: `震源は${hypocenter.name}に更新されました。`, refs: [{ kind: 'quakeFact', fact: 'hypocenterName', value: hypocenter.name }] })
  }
  if (changed('magnitude', magnitudeFactValue(hypocenter))) {
    const value = magnitudeFactValue(hypocenter)
    // 数値にならない規模は「〜に更新されました」の枠へ入れられない（「8を超える巨大地震に
    // 更新されました」と破綻する）。**それでも更新されたことは言う** —— 主題部だけを
    // 差し替えた形を使う（→ `magnitudeConditionAmendSentence`）。
    const text = hasMagnitude(hypocenter.magnitude)
      ? `マグニチュードは${magnitudeText(hypocenter.magnitude)}に更新されました。`
      : magnitudeConditionAmendSentence(hypocenter)
    segments.push({ text, refs: [{ kind: 'quakeFact', fact: 'magnitude', value }] })
  }
  if (changed('depth', String(hypocenter.depth))) {
    segments.push({ text: `震源の深さは${depthUpdateValue(hypocenter.depth)}に更新されました。`, refs: [{ kind: 'quakeFact', fact: 'depth', value: String(hypocenter.depth) }] })
  }
  if (changed('domesticTsunami', domesticTsunami)) {
    segments.push(domesticTsunamiSegment(domesticTsunami))
  }
  return segments
}

/**
 * 区域より下の階層（観測点・市町村）に、前に声にした報から何が起きたか。
 *
 * | 値 | 意味 |
 * |---|---|
 * | `added` | 観測点か市町村が増えた |
 * | `updated` | 顔ぶれは同じだが震度が動いた |
 * | `none` | どちらも起きていない（＝本当に変化が無い） |
 * | `unknown` | 比べる相手がいない（この地震でまだ 1 通も声にしていない） |
 *
 * **`none` と `unknown` を混ぜないこと。** 前者は「変わりはありません」と言い切ってよい根拠だが、
 * 後者は何も判らないだけで、言い切ると嘘になりうる。
 */
type ObservationChange = 'added' | 'updated' | 'none' | 'unknown'

/**
 * 観測点を指す鍵。**コードがあれば優先する** —— 観測点名は全国で一意とは限らない。
 * DMDATA の観測点は `pref` が空なので、名前へ落ちたときは実質 `addr` だけで引く。
 */
function stationKey(p: { code?: string; pref: string; addr: string }): string {
  return p.code ? `c:${p.code}` : `n:${p.pref}|${p.addr}`
}

/** 市町村を指す鍵（観測点と同じ規則）。 */
function cityKey(c: { code?: string; pref: string; name: string }): string {
  return c.code ? `c:${c.code}` : `n:${c.pref}|${c.name}`
}

/**
 * 前に声にした報と、いまの電文を突き合わせる。
 *
 * **なぜ電文の `Revise` を使わないか。** 気象庁は続報の観測点・市町村へ `追加` `上方修正`
 * `下方修正` を書いており（→ `EarthquakePoint.revise`）、実電文で突き合わせの結果と一致することも
 * 確かめた（実例は `docs/spec/audio-tts-spec.md` 改訂履歴 2026-09-17）。それでも採らない。
 *
 * - **問いが違う。** `Revise` が答えるのは「**直前の報**から何が変わったか」。こちらが要るのは
 *   「**最後に声にした報**から何が変わったか」で、割り込みで鳴らなかった報があると食い違う
 *   （記録を声になった分だけ進める規律の帰結 → `docs/spec/audio-tts-spec.md` §4）。
 * - **P2PQuake 経路が `Revise` を持たない。** standard 版だけ黙ることになる。
 *
 * 突き合わせなら両方を満たせる。`Revise` は逆に**検証の材料**として使える（テストで実電文の
 * 値と突き合わせの結果が一致することを固定してある）。
 *
 * **区域・都道府県の集約点（`isArea`）は数えない。** あれは区域の差分がもう見ており、
 * 増えていればこの関数を呼ぶ経路（差分が空）へそもそも入らない。
 */
function observationChange(event: JMAQuake, spoken: QuakeSpokenState): ObservationChange {
  const prev = spoken.observed
  if (!prev) {
    // **正常な見送りと、機能が死んでいるのを見分けられるようにする。** その地震でまだ 1 通も
    // 声にしていないなら比べる相手がいないのは当たり前だが、区域や震源要素は何度も声にして
    // いるのに観測点の記録だけ無いなら、**発話が毎回割り込まれて最後の断片まで届いていない**
    // （記録はチャンク単位で進み、この参照は最後の断片に載っているため）。後者は黙るだけで
    // 嘘は言わないが、この一文が永久に出なくなる。
    if (spoken.regions.size > 0 || spoken.facts.size > 0) {
      log.debug('[tts] 観測点の記録が無いため、区域より下の階層の変化を判定できない（発話が最後まで鳴っていない可能性）')
    }
    return 'unknown'
  }

  // 鍵が衝突したら記録を残す。**黙って上書きすると、別の観測点の震度と突き合わせて
  // 「変わりなし」とも「更新された」とも誤りうる**（どちらも嘘）。`code` は実電文でほぼ必ず
  // 入るので、ここへ来るのは配信の形が変わったとき。
  const indexOf = <T,>(items: readonly T[], keyOf: (x: T) => string, scaleOf: (x: T) => number, what: string): Map<string, number> => {
    const map = new Map<string, number>()
    let collisions = 0
    for (const item of items) {
      const key = keyOf(item)
      if (map.has(key)) collisions++
      map.set(key, scaleOf(item))
    }
    if (collisions > 0) log.warn(`[tts] ${what}の鍵が重複した（${collisions} 件）。区域より下の階層の変化を誤って判定しうる`)
    return map
  }

  const nowStations = event.points.filter(p => !p.isArea)
  const prevStations = indexOf(prev.points.filter(p => !p.isArea), stationKey, p => p.scale, '観測点')
  const nowCities = event.cities ?? []
  const prevCities = indexOf(prev.cities, cityKey, c => c.scale, '市町村')

  // **減ったことは見ない。** 気象庁は観測点を取り下げず（`Revise` の値域は追加・上方修正・
  // 下方修正だけ）、減って見える形は**種別の違い**で起きる ―― 震度速報は区域までしか運ばないので、
  // 地震情報のあとに震度速報が届けば観測点は「消えた」ように見える。それを変化として扱うと
  // 種別が前後するたびに誤って読む。**実際に減る電文を観測したわけではなく、減らない前提を
  // 置いている**（減った場合は黙って `none` へ落ちる）。
  let updated = false
  for (const p of nowStations) {
    const before = prevStations.get(stationKey(p))
    if (before === undefined) return 'added'
    if (before !== p.scale) updated = true
  }
  for (const c of nowCities) {
    const before = prevCities.get(cityKey(c))
    if (before === undefined) return 'added'
    if (before !== c.scale) updated = true
  }
  return updated ? 'updated' : 'none'
}

/**
 * 「更新されました」のあとに続ける一文。**名乗りだけで終わらせないための断片。**
 *
 * 読み上げの地域名は一次細分区域までしか下りないので、区域の最大震度が据え置きのまま
 * 観測点だけが増えた続報は差分が空になる。そのとき「更新されました。」で切ると、聞き手には
 * 「何が？」しか残らない。
 *
 * **「地域ごとの最大震度」と言い切る。** 「各地の震度」では市町村の段を含んで読めてしまい、
 * そちらは実際に上がっていることがある。読み上げが伝えてきた単位＝区域の最大震度に限れば、
 * 据え置きであることは正しい（実例は `docs/spec/audio-tts-spec.md` 改訂履歴 2026-09-17）。
 *
 * **区域より下の階層を運ぶ種別（地震情報）専用。** 震度速報（区域まで）と震源情報（震源要素のみ）は
 * **そもそも探す先が無い**ので、区域・震源要素の差分が空ならそれだけで「変わりはありません」と
 * 言い切れる。観測点の記録を待たせない ―― あちらは `points` を運ばないので記録が作られず、
 * 待たせると永久に名乗りだけで終わる。
 *
 * @param change 区域より下の階層で起きたこと
 */
function noRegionChangeSegments(change: ObservationChange): SpeechSegment[] {
  if (change === 'unknown') return []
  if (change === 'added') return [plain('観測地点が追加されましたが、地域ごとの最大震度は変わっていません。')]
  if (change === 'updated') return [plain('観測された震度が更新されましたが、地域ごとの最大震度は変わっていません。')]
  return [plain('内容に変わりはありません。')]
}

/**
 * その報が運んでいた観測点・市町村を、**読み終えたときに記録する**ための参照を最後の断片へ足す。
 *
 * **最後の断片に載せる。** 途中で切られた発話は記録を進めない（次の報でもう一度伝える）。
 * 断片を増やさず既存の最後のものへ足すのは、空文字の断片がチャンクの割り当てを乱すため。
 * 割り当てはチャンク単位なので、その断片が読点で複数チャンクに割れればどれが鳴っても記録は進む。
 *
 * **観測点も市町村も運んでいない報では記録を発行しない。** 同じ地震の記録は種別を跨いで共有されるので
 * （`quakeSpeechTopic`）、**空で上書きすると前に伝えた観測点が記録から消える**。次の報は
 * 「比べる相手がいない」ではなく「全部が初出」と読み、何も増えていないのに
 * 「観測地点が追加されました」と**嘘を言う**。気象庁は種別の違う電文を前後して発表するので、
 * これは実運用で起きる順序（→ 設定タブ「種別遷移テスト」がその順序そのもの）。
 *
 * **数えるのは観測点（`isArea` が偽）と市町村だけ。`points` の件数で見ない。** 震度速報は
 * `points` に**区域と都道府県の集約点だけ**を積むので、件数で見ると「運んでいる」と誤判定し、
 * 観測点ゼロの記録で上書きしてしまう（震源情報・VXSE61 と同じ結果になる）。
 */
function withObservedRef(segments: SpeechSegment[], event: JMAQuake): SpeechSegment[] {
  if (segments.length === 0) return segments
  const carriesStations = event.points.some(p => !p.isArea)
  if (!carriesStations && (event.cities?.length ?? 0) === 0) return segments
  const observed: SpokenObservation = { points: event.points, cities: event.cities ?? [] }
  const last = segments[segments.length - 1]
  return [
    ...segments.slice(0, -1),
    { ...last, refs: [...last.refs, { kind: 'quakeObserved', observed }] },
  ]
}

/**
 * VXSE51/52/53/61 地震情報の読み上げを断片列で生成する。
 * isNew=false のとき更新報として冒頭に通知する。
 *
 * `spoken` を渡すと**続報は差分だけを読む**（既に声になった区域・震源要素を省く）。
 * 省略すると全文を組み立てる（{@link earthquakeToText} 経由の呼び出し）。
 *
 * 差分が空になっても**名乗りは読む**（黙らない。理由は下の `return` のコメント）。名乗りだけで
 * 終わらせないための一文は {@link noRegionChangeSegments} が足す。
 *
 * **これは内側の組み立て。** 呼び出し側が使うのは {@link earthquakeToSegments} で、あちらが
 * 観測点の記録（{@link withObservedRef}）を最後の断片へ載せる。ここへ直接足さないのは、
 * `return` が 6 つあり 1 つ書き忘れても型検査もテストも通ってしまうため。
 */
function buildEarthquakeSegments(
  event: JMAQuake,
  opts: TtsSpeechOptions,
  isNew: boolean,
  spoken?: QuakeSpokenState,
  /**
   * 区域を差分にせず**通しで読む**。その地震で最初に届いた確定情報（震源・震度情報／各地の
   * 震度情報）にだけ真を渡す（判定は `useLiveEventHandler`）。
   *
   * 速報を細切れに聞いた耳へ、確定した観測を 1 度だけまとめて示すため。震源要素が「その種別の
   * 初報では通しで言う」のと規則を揃える意味もある（従来は同じ報の中で震源要素は通し・地域は
   * 差分と割れていた）。**2 回目以降は差分に戻す** ―― 種別ごとに通しで読むと、確定情報が
   * 2 種類届く経路で全文を 2 度聞くことになる。
   */
  readAllRegions = false,
): SpeechSegment[] {
  const { hypocenter, maxScale, domesticTsunami } = event.earthquake
  const type = event.issue.type
  // その地震について何かを声にしたことがあるか。差分が空でも、まだ何も伝えていないなら黙らない。
  const saidSomething = spoken != null && (spoken.regions.size > 0 || spoken.facts.size > 0)

  if (type === '震度速報') {
    const prefix = isNew ? '震度速報。' : '震度速報が更新されました。'
    const regionSegs = buildRegionSegments(event.points, maxScale, opts, hypocenter, spoken)
    // 未入電の区域は述語が違うので別の文にする（→ `unreceivedRegionSegments`）。
    const unreceivedSegs = unreceivedRegionSegments(event.points, opts, hypocenter, spoken)
    if (regionSegs.length > 0 || unreceivedSegs.length > 0) {
      return [plain(prefix), ...regionSegs, ...unreceivedSegs]
    }
    // 区域を挙げられないとき（差分なし・区域を持たない異常な電文）は最大震度だけでも伝える。
    // **区域を一度も読めていない地震に限る**（判定は下の地震情報の経路と揃える。揃えないと
    // 区域を読めている地震の据え置きの続報でも最大震度を言い直す）。
    // 同じ震度を既に伝えていれば `maxScaleOnlySegments` が空を返す。震度も判らないときも空になるが、
    // 初報なら名乗りだけは返す（「震度速報。」で終わる。震度の値が欠けた文は作らない）。
    const fallback = spoken == null || spoken.regions.size === 0
      ? maxScaleOnlySegments(maxScale, spoken, isMaxScaleUnreceived(maxScale, event.points))
      : []
    // **伝えることが無くても名乗りは読む。** 黙ると「電文が来たのに何も起きなかった」ようにしか
    // 聞こえない（docs/spec/audio-tts-spec.md §4）。
    //
    // **ただし名乗りだけでは終わらせない。** 「更新されました」で切ると、聞き手には「何が？」しか
    // 残らない。**震度速報は区域までしか運ばない種別**なので（実測: 電文に `IntensityStation` も
    // `City` も 1 件も入らない）、区域の差分が空ならそれだけで「変わりがない」と言い切れる
    // ―― 観測点の記録は見ない（この種別では作られないので、待たせると永久に名乗りだけで終わる）。
    //
    // **震度について何かを伝えたことがあるのを条件にする。** 区域を挙げた地震はもちろん、
    // 地域名を作れず最大震度だけを伝えた地震（`maxScaleOnly`）でも「変わりはない」と言い切れる。
    // どちらも無い（震度そのものを一度も声にしていない）なら根拠が無いので黙る。
    const toldIntensity = !!spoken && (spoken.regions.size > 0 || spoken.facts.has('maxScaleOnly'))
    const noChange = !isNew && spoken && fallback.length === 0 && toldIntensity
      ? [plain('観測した震度に変わりはありません。')]
      : []
    return [plain(prefix), ...fallback, ...noChange]
  }

  const time = formatTime(event.earthquake.time)

  if (type === '顕著な地震の震源要素更新のお知らせ') {
    // この電文（VXSE61）は震源要素の更新のみを伝え、津波の有無は含まない。
    // 津波情報は別電文（VTSE41/51/52）で発表されるため、ここでは読み上げない。
    //
    // **差分を取らない。** 「更新されたこと」自体が電文の主旨なので、値が既に声になっていても
    // 省かない。ただし読んだ値は記録する（記録しないと、後続の続報が同じ値を「更新」と言い直す）。
    const amended: SpeechSegment[] = []
    // **深さの語形は後ろに規模が続くかどうかで変わる**（理由は depthAmendPhrase）。順に組み立てる前に
    // 規模が並ぶかを決めておく。
    const magnitudeFollows = hasMagnitude(hypocenter.magnitude)
    const depth = depthAmendPhrase(hypocenter.depth, magnitudeFollows)
    if (depth) amended.push({ text: depth, refs: [{ kind: 'quakeFact', fact: 'depth', value: String(hypocenter.depth) }] })
    if (magnitudeFollows) {
      const value = magnitudeText(hypocenter.magnitude)
      if (amended.length > 0) amended.push(plain('、'))
      amended.push({ text: `マグニチュード${value}`, refs: [{ kind: 'quakeFact', fact: 'magnitude', value }] })
    }
    // 時刻が日時として読めなければ句ごと落とす（「ナンじナンぷん頃発生した」と読ませない）。
    // 震源名だけでも文は成立する。
    const head = plain(`顕著な地震の震源要素更新のお知らせ。${time ? `${time}頃発生した` : ''}${hypocenter.name}の地震について、`)
    // 数値にならない規模は「〜に更新されました」の並びへ入れられないので、別の文で後に足す。
    // **ここは初報の形（「マグニチュードは〜」）のまま。** この電文は名乗りと直前の文が既に
    // 「更新」を言っているので、`magnitudeConditionAmendSentence` を使うと 1 回の発話で
    // 「更新」が 3 度重なる（続報の差分では前に「更新」を言う文が無いので、あちらは要る）。
    const magCondition = magnitudeConditionSentence(hypocenter)
    const conditionSegments: SpeechSegment[] = magCondition
      ? [{ text: magCondition, refs: [{ kind: 'quakeFact', fact: 'magnitude', value: magnitudeFactValue(hypocenter) }] }]
      : []
    // 深さ・規模とも不明なら要素を並べられないため、更新があった事実だけを伝える。
    return amended.length > 0
      ? [head, ...amended, plain('に更新されました。'), ...conditionSegments]
      : [head, plain('震源要素が更新されました。'), ...conditionSegments]
  }

  if (type === '遠地地震') {
    // 気象庁「遠地地震に関する情報」（VXSE53・Head/Title で識別）。国外の規模の大きな地震を
    // 日本への津波影響とあわせて伝える電文で、国内震度は伴わない（maxScale は常に -1）。
    //
    // **差分を取らない。** 付加文（`forecastText`）が本文の主体で、区分の値だけを比べても
    // 何が変わったか分からない。発表自体が稀で、続報も数報にとどまる。
    const prefix = isNew ? '遠地地震に関する情報。' : '遠地地震に関する情報が更新されました。'
    // 付加文の原文を優先する。遠地地震は 022x/023x 系の付加文を併用するため、
    // domesticTsunami（021x 系の区分）へ丸めると意味が落ちる。
    // 原文を持たない経路（P2PQuake）は従来どおり区分から文を起こす。
    const tail = event.forecastText
      ? plain(event.forecastText)
      : domesticTsunamiSegment(domesticTsunami)
    // 時刻が日時として読めなければ句ごと落とす（上の地震情報と同じ扱い）。
    const dayTime = formatDayTime(event.earthquake.time)
    return [
      plain(`${prefix}${dayTime ? `${dayTime}頃、` : ''}`),
      ...quakeOccurrenceSegments(hypocenter, opts),
      tail,
    ]
  }

  const isEpicenterOnly = type === '震源情報' || type === 'その他'
  const label = isEpicenterOnly ? '震源情報' : '地震情報'

  // 続報は変化したところだけを読む。震源要素・津波区分・震度の地域のいずれにも変化が
  // 無ければ**名乗りだけで終える**（黙らない。理由は下の `return` のコメント）。
  // まだ声にしていない震源要素があるなら差分にしない（理由は `hasUnspokenFact`）。
  if (!isNew && spoken && saidSomething && !hasUnspokenFact(event, spoken, opts)) {
    const facts = changedFactSegments(event, spoken, opts)
    const regionSegs = isEpicenterOnly
      ? []
      : buildRegionSegments(event.points, maxScale, opts, hypocenter, readAllRegions ? undefined : spoken)
    // **ここも未入電の文を出す。** 落とすと、震源要素・津波区分がいずれも既出のまま新しく
    // 未入電の区域が加わった続報で、その区域が一度も声にならない（震度速報以外の続報は
    // 必ずこの経路を通る）。
    const unreceivedSegs = isEpicenterOnly
      ? []
      : unreceivedRegionSegments(event.points, opts, hypocenter, readAllRegions ? undefined : spoken)
    // 地域名を作れないまま続報が来ても震度は伝える。ここに保険が無いと、観測点が座標テーブルで
    // 解決できない状態が続く地震で、初報の 1 回しか震度を伝えられない（以降はこの経路に入り、
    // 区域も差分も空のまま黙る）。
    // **区域を一度も読めていない地震に限る**（`spoken.regions` が空）。`regionSegs` が空かどうかで
    // 判定すると、区域を読めている地震の据え置きの続報でも最大震度を言い直す。
    // 同じ震度を既に伝えていれば `maxScaleOnlySegments` が空を返す。
    const fallback = !isEpicenterOnly && regionSegs.length === 0 && unreceivedSegs.length === 0 && spoken.regions.size === 0
      ? maxScaleOnlySegments(maxScale, spoken, isMaxScaleUnreceived(maxScale, event.points))
      : []
    // 伝えることが無くても名乗りは読む（理由は震度速報の同じ箇所）。
    //
    // **名乗りだけで終わるなら、区域より下の階層を見て中身を足す。** 読み上げの地域名は
    // 一次細分区域までしか下りないので、区域の最大震度が据え置きのまま観測点だけが増えた
    // 続報はここへ落ちる（実例は `docs/spec/audio-tts-spec.md` 改訂履歴 2026-09-17）。
    //
    // **震源情報・その他（`isEpicenterOnly`）は震源要素しか運ばない**ので、その差分が空なら
    // それだけで言い切れる（観測点の記録は見ない。この種別では作られない）。下の階層を持つのは
    // 震源・震度情報（VXSE53）と各地の震度情報（P2PQuake）だけ。
    const nothingSaid = facts.length === 0 && regionSegs.length === 0 && unreceivedSegs.length === 0 && fallback.length === 0
    const noChange = !nothingSaid
      ? []
      : isEpicenterOnly
        ? [plain('震源の内容に変わりはありません。')]
        : noRegionChangeSegments(observationChange(event, spoken))
    return [plain(`${label}が更新されました。`), ...facts, ...regionSegs, ...unreceivedSegs, ...fallback, ...noChange]
  }

  const prefix = isNew ? `${label}。` : `${label}が更新されました。`
  const segments: SpeechSegment[] = [
    // 時刻が読めなければ句ごと落とす。この後に続く `quakeOccurrenceSegments` が震源名から
    // 読み始めるので、文としては「地震情報。石川県能登地方で地震が発生しました。」になる。
    plain(`${prefix}${time ? `${time}頃、` : ''}`),
    ...quakeOccurrenceSegments(hypocenter, opts),
    domesticTsunamiSegment(domesticTsunami),
  ]
  if (!isEpicenterOnly) {
    const regionSegs = buildRegionSegments(event.points, maxScale, opts, hypocenter, readAllRegions ? undefined : spoken)
    // 地域名を作れなかった場合も、震度が判っていれば最大震度だけは伝える（震度速報と同じ扱い）。
    // 揃えないと、この電文だけ震度に一切触れずに終わる。
    // ここも区域を一度も読めていない地震に限る。上の差分の経路と判定を揃えないと、震源要素だけが
    // 変わった続報（区域は据え置き）で最大震度を言い直す。
    const unreceivedSegs = unreceivedRegionSegments(event.points, opts, hypocenter, readAllRegions ? undefined : spoken)
    if (regionSegs.length > 0 || unreceivedSegs.length > 0) segments.push(...regionSegs, ...unreceivedSegs)
    else if (!spoken || spoken.regions.size === 0) segments.push(...maxScaleOnlySegments(maxScale, spoken, isMaxScaleUnreceived(maxScale, event.points)))
  }
  return segments
}

/**
 * VXSE51/52/53/61 地震情報の読み上げを断片列で生成する（引数の意味は
 * {@link buildEarthquakeSegments}）。
 *
 * 組み立てた断片列の**最後に、その報が運んでいた観測点・市町村への参照を足す**。これが
 * 次の報で「区域の震度は据え置きだが観測点は増えた」を見分ける材料になる
 * （→ {@link observationChange}）。**入口を 1 つにしてあるのは、内側の `return` が 6 つあり、
 * 分岐ごとに足す形にすると書き忘れても何も起きないから**（読み上げは普段どおり鳴り、
 * 続報で「変わりはありません」と嘘を言うようになるだけで、例外もログも出ない）。
 */
export function earthquakeToSegments(
  event: JMAQuake,
  opts: TtsSpeechOptions,
  isNew: boolean,
  spoken?: QuakeSpokenState,
  readAllRegions = false,
): SpeechSegment[] {
  return withObservedRef(buildEarthquakeSegments(event, opts, isNew, spoken, readAllRegions), event)
}

/** VXSE51/52/53/61 地震情報の読み上げテキストを生成する。isNew=false のとき更新報として冒頭に通知する。 */
export function earthquakeToText(event: JMAQuake, opts: TtsSpeechOptions, isNew: boolean): string {
  return joinSegments(earthquakeToSegments(event, opts, isNew))
}

/**
 * 波高の表記を読める形にする。"３ｍ" → "3メートル"、"10m以上" → "10メートル以上"、
 * "０．５ｍ" → "0.5メートル" など。
 *
 * **全角と半角の両方が来る。** 波高そのものは両経路とも半角で渡ってくる（`dmdataParser` の
 * `toHalfWidthHeightDesc`）が、この関数は `headline`（電文の文章）にも通しており、そちらは
 * 全角のまま。片方だけを変換すると素通りした側が「えむ」と読まれる。
 *
 * 単位を置き換えるのは**数字の直後だけ**。この関数は `headline`（電文の文章）にも通すので、
 * 無条件に m を置き換えると文中の語を壊す。大文字の M を対象にしないのも同じ理由で、
 * 数字の直後の M はマグニチュード（「M7.6」）を指す。
 */
function tsunamiHeightToSpeech(description: string): string {
  return description
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, '.')
    .replace(/(\d)\s*[mｍ]/g, '$1メートル')
}

/**
 * 数値で表せない予想波高（気象庁の「巨大」「高い」）を、文に馴染む言い方に直す。
 *
 * この 2 つは規模が大きく数値化できないときの定型表記で、そのまま並べると
 * 「岩手県で巨大が予想されています」と崩れる。活用が違う（「巨大」は形容動詞、「高い」は
 * 形容詞）ので機械的に語尾を足せず、表記ごとに持つ。
 *
 * 表になければそのまま通す。知らない表記を無理に加工して壊すより、少しぎこちない方がまし。
 */
const NON_NUMERIC_HEIGHT_PHRASE: Record<string, string> = {
  巨大: '巨大な津波',
  高い: '高い津波',
}

function heightPhrase(description: string): string {
  const spoken = tsunamiHeightToSpeech(description)
  if (/\d/.test(spoken)) return spoken
  const phrase = NON_NUMERIC_HEIGHT_PHRASE[spoken.trim()]
  // 素通しした表記は記録に残す。読み上げは崩れた文のまま流れるので、聞くまで気づけない
  if (!phrase) log.debug('[tts] 予想波高の表記が表に無い（そのまま読む）', spoken)
  return phrase ?? spoken
}

/**
 * 予想波高が付いていない区域を「〇〇にも津波警報が発表されています。」で補う。
 *
 * 区域名を波高の文でだけ挙げる作りなので、**波高を持たない区域はそのままだと読み上げから
 * 落ちる**。予想波高が数値で来ない電文は実際にある（「巨大」「高い」の表記は DMDATA 経路で
 * `maxHeight` ごと落ちる。→ `dmdataParser`）ほか、警報が先に出て波高が後続報で付くこともある。
 * 発表されている区域を黙って省くわけにはいかない。
 *
 * **判定は `hasForecastHeight` に任せる**（カードの波高見出しと同じ述語）。`maxHeight` の有無で
 * 見ると、値が 0 で条件も無い区域が波高の文にもここにも入らず、どこにも現れなくなる。
 */
function areasWithoutHeightSentence(
  areas: readonly TsunamiArea[],
  observations: readonly TsunamiObservation[],
  gradeLabel: string,
): SpeechSegment[] {
  const without = areas.filter(a => !hasForecastHeight(a))
  if (without.length === 0) return []
  return [
    ...areaNameSegments(orderAreasForSpeech(without, observations)),
    plain(`にも${gradeLabel}が発表されています。`),
  ]
}

/**
 * 等級を告げる断片。**その等級のカードを指す参照を持たせる。**
 *
 * 追従スクロールが「また、次の地域に津波警報が発表されています」を読んだ時点でカードの頭へ
 * 移れるようにするため。区域名を読み始めてから動くと、等級の見出しが視野の上に切れたまま
 * 区域だけが見える形になる。
 */
function gradeSegment(text: string, grade: TsunamiGrade): SpeechSegment {
  return { text, refs: [{ kind: 'grade', grade }] }
}

/** 区域名を読点で連結した断片列を作る（各区域名が自分を指す参照を持つ）。 */
function areaNameSegments(areas: readonly TsunamiArea[]): SpeechSegment[] {
  const segments: SpeechSegment[] = []
  areas.forEach((a, i) => {
    if (i > 0) segments.push(plain('、'))
    segments.push({ text: a.name, refs: [{ kind: 'area', code: a.code, name: a.name }] })
  })
  return segments
}

/**
 * 「岩手県、宮城県で10メートル以上、福島県で6メートルが予想されています。」の形の文を作る。
 *
 * **区域名と波高を 1 文で言い切る。** 区域を挙げる文と波高を伝える文を分けると、同じ区域名を
 * 2 回読むことになる（予報区が数十に及ぶ大規模警報では、それだけで読み上げが倍近く伸びる）。
 * 読み上げが長引くと、優先度の低い電文が待ちの上限に達して割り込み、津波の読み上げが途中で
 * 切られる（`HIGHER_PRIORITY_SPEECH_MAX_WAIT_MS`）。冗長さは聞き心地だけの問題ではない。
 *
 * **渡すのは 1 つの等級の区域だけ。** 等級をまたいで 1 文にまとめない ―― カードは等級ごとに
 * 分かれているので、まとめると読み上げの句がカードを跨ぎ、追従スクロールがその間の行を
 * 含んだ範囲を対象にする。
 *
 * **句の区切りはカードの波高見出しに合わせる**（`groupAreasForCardDisplay`）。波高の文字列だけを
 * キーにまとめると、間に別の波高の区域が挟まっていても飛び越えて 1 つの句にしてしまう。
 * たとえば電文順が A(3m)・B(6m)・C(3m) のとき「A、Cで3メートル、Bで6メートル」と読むと
 * A と C が同じ句に入り、追従がその間の B の行を跨いだ範囲を対象にする。
 *
 * 波高を持つ区域が 1 つも無ければ空を返す（呼び出し側が区域名だけを挙げる文に切り替える）。
 * `areas` は**並べ替える前**のものを渡すこと（グループの境界は電文順で決まる）。
 */
function areaHeightSentence(
  areas: readonly TsunamiArea[],
  observations: readonly TsunamiObservation[],
): SpeechSegment[] {
  const groups = groupAreasForCardDisplay([...areas], [...observations])
    // 判定は `hasForecastHeight` に揃える（`maxHeight` の有無で見ると、グループ分けの側と
    // 基準が食い違って区域が落ちる。理由は `areasWithoutHeightSentence` の JSDoc）
    .map(g => ({ heightLabel: g.heightLabel, areas: g.areas.filter(hasForecastHeight) }))
    .filter(g => g.heightLabel !== null && g.areas.length > 0)
  if (groups.length === 0) return []

  const segments: SpeechSegment[] = []
  groups.forEach((g, i) => {
    if (i > 0) segments.push(plain('、'))
    segments.push(...areaNameSegments(g.areas))
    segments.push(plain(`で${heightPhrase(g.heightLabel!)}`))
  })
  segments.push(plain('が予想されています。'))
  return segments
}

/**
 * 上位の等級より下の区域を、等級ごとに読む。
 * 例:「また、次の地域に津波警報が発表されています。青森県太平洋沿岸、茨城県で3メートルが
 * 予想されています。また、次の地域に津波注意報が発表されています。北海道太平洋沿岸東部で
 * 1メートルが予想されています。」
 *
 * 高さを等級ごとに添えるのは、**その区域にいる人へ高さを伝えるため**（上位の警報の高さだけを
 * 読むと、注意報の区域には何も伝わらない）。
 *
 * **「次の地域に」で等級を先に言い切り、区域名は次の文で波高と一緒に挙げる。** 区域を挙げる
 * 文と波高の文を分けると同じ区域名を 2 回読むことになる（→ `areaHeightSentence`）。
 * 波高がまだ付いていない区域だけの等級では挙げる先が無くなるので、その場合に限り
 * 「〇〇に津波警報が発表されています」と区域名を直接続ける形に落とす。
 */
function lowerGradeSentence(
  areas: readonly TsunamiArea[],
  topGrade: string,
  observations: readonly TsunamiObservation[],
): SpeechSegment[] {
  const segments: SpeechSegment[] = []
  for (const g of GRADE_ORDER) {
    if (g === topGrade) continue
    const inGrade = areas.filter(a => a.grade === g)
    if (inGrade.length === 0) continue
    const heights = areaHeightSentence(inGrade, observations)
    // 等級ごとに「また、」で始める。文が切れる位置が耳で分かるようにするため
    segments.push(plain('また、'))
    if (heights.length > 0) {
      segments.push(gradeSegment(`次の地域に${tsunamiGradeLabel(g)}が発表されています。`, g))
      segments.push(...heights)
      segments.push(...areasWithoutHeightSentence(inGrade, observations, tsunamiGradeLabel(g)))
    } else {
      segments.push(...areaNameSegments(orderAreasForSpeech(inGrade, observations)))
      segments.push(plain(`に${tsunamiGradeLabel(g)}が発表されています。`))
    }
  }
  return segments
}

/**
 * 読み上げで区域を並べる順を決める。
 *
 * **カードの表示順に合わせる**（`sortAreasForCardDisplay`）。電文順（気象庁の地理順）の
 * ままにすると、観測が入り始めた続報で読み上げ順とカードの並びが乖離し、読み上げに
 * 追従するスクロールが 1 チャンクごとに上下へ往復する（docs/spec/audio-tts-spec.md §4）。
 */
function orderAreasForSpeech(
  areas: readonly TsunamiArea[],
  observations: readonly TsunamiObservation[],
): TsunamiArea[] {
  return sortAreasForCardDisplay([...areas], [...observations])
}

/**
 * 区域の並べ替えに使う観測点を決める。
 *
 * **カードが持っている観測点の全体（マージ済み）を渡すこと。** 区域の並びは「その区域で最も
 * 深刻な実測波高」で決まるため（`sortAreasByObservation`）、その電文が運んできた分だけで
 * 並べるとカードと食い違う。等級を切り替える報（警報 → 注意報など）は観測点をほとんど
 * 載せないので、渡さないと読み上げだけが電文順（気象庁の地理順）に戻り、追従スクロールが
 * カード上を往復する。
 *
 * 省略時は電文が載せた分で並べる。呼び出し側が画面の津波を持たないテストのための既定値で、
 * 実際の受信経路（`useLiveEventHandler`）では必ず渡す。
 */
function observationsForAreaOrder(
  event: JMATsunami,
  observationsForOrder?: readonly TsunamiObservation[],
): readonly TsunamiObservation[] {
  return observationsForOrder ?? event.observations ?? []
}

/**
 * VTSE41/51/52 津波情報（新規発表・引き上げ）の読み上げを断片列で返す。
 *
 * `observationsForOrder` は区域の並べ替えにだけ使う（→ `observationsForAreaOrder`）。
 * 読み上げる内容は `event` だけで決まる ―― 等級の発表では観測点の実測値を読まない。
 */
export function tsunamiToSegments(
  event: JMATsunami,
  observationsForOrder?: readonly TsunamiObservation[],
): SpeechSegment[] {
  const topGrade = GRADE_ORDER.find(g => event.areas.some(a => a.grade === g))
  if (!topGrade) return []

  const observations = observationsForAreaOrder(event, observationsForOrder)
  // 波高の文はグループの境界が電文順で決まるため、並べ替える前のものを渡す
  const rawTopAreas = event.areas.filter(a => a.grade === topGrade)
  const gradeLabel = tsunamiGradeLabel(topGrade)
  const action = topGrade === 'MajorWarning' ? 'ただちに高台へ避難してください。'
    : topGrade === 'Warning' ? '海岸から離れてください。'
    : topGrade === 'Forecast' ? '若干の海面変動が予想されますが、被害の心配はありません。' : ''
  const heights = areaHeightSentence(rawTopAreas, observations)

  // **等級と行動を先に言い切る。** 区域を全部読んでから避難を促すと、予報区が多いほど行動指示が
  // 遅れる。区域名は次の文で波高と一緒に挙げるので、聞き手が待たされるのは高さの情報だけ。
  if (heights.length > 0) {
    return [
      gradeSegment(`${gradeLabel}が発表されました。${action}`, topGrade),
      ...heights,
      ...areasWithoutHeightSentence(rawTopAreas, observations, gradeLabel),
      ...lowerGradeSentence(event.areas, topGrade, observations),
    ]
  }
  // 波高がまだ付いていない（続報で後から付く）場合は、区域名を直接挙げる。
  //
  // **等級名が 2 回出るが、これは頭の名乗りを残すための代償**（→ docs/spec/tts-sentence-inventory.md
  // §4-10・§5）。「〈区域〉に発表されました」は区域が述語の前に来るので、頭の `${gradeLabel}。` を
  // 外すと**等級が判るまで区域名を全部聞くことになる**（予報区が多いほど遅れる）。上の波高あり経路が
  // 等級と行動を先に言い切っているのと同じ理由で、重複のほうを受け入れる。
  return [
    plain(`${gradeLabel}。`),
    ...areaNameSegments(orderAreasForSpeech(rawTopAreas, observations)),
    plain(`に${gradeLabel}が発表されました。${action}`),
    ...lowerGradeSentence(event.areas, topGrade, observations),
  ]
}

export function tsunamiToText(
  event: JMATsunami,
  observationsForOrder?: readonly TsunamiObservation[],
): string {
  return joinSegments(tsunamiToSegments(event, observationsForOrder))
}

/**
 * VTSE41/51/52 津波情報 引き下げ時の読み上げを断片列で返す。
 *
 * `observationsForOrder` の役割は `tsunamiToSegments` と同じ。**引き下げこそ渡すこと** ――
 * 警報から注意報へ切り替える報が届くころには観測が出揃っており、カードは実測波高の順に
 * 並び替わっている。
 */
export function tsunamiDowngradeToSegments(
  event: JMATsunami,
  observationsForOrder?: readonly TsunamiObservation[],
): SpeechSegment[] {
  const topGrade = GRADE_ORDER.find(g => event.areas.some(a => a.grade === g))
  if (!topGrade) return [plain(tsunamiCancelToText(event.cancelReason))]

  const observations = observationsForAreaOrder(event, observationsForOrder)
  const rawTopAreas = event.areas.filter(a => a.grade === topGrade)
  const gradeLabel = tsunamiGradeLabel(topGrade)
  const heights = areaHeightSentence(rawTopAreas, observations)

  if (heights.length > 0) {
    return [
      gradeSegment(`${gradeLabel}に切り替えられました。現在、次の地域に${gradeLabel}が発表されています。`, topGrade),
      ...heights,
      ...areasWithoutHeightSentence(rawTopAreas, observations, gradeLabel),
      ...lowerGradeSentence(event.areas, topGrade, observations),
    ]
  }
  return [
    plain(`${gradeLabel}に切り替えられました。現在、`),
    ...areaNameSegments(orderAreasForSpeech(rawTopAreas, observations)),
    plain(`に${gradeLabel}が発表されています。`),
    ...lowerGradeSentence(event.areas, topGrade, observations),
  ]
}

/** VTSE41/51/52 津波情報 引き下げ時の読み上げテキストを生成する。 */
export function tsunamiDowngradeToText(
  event: JMATsunami,
  observationsForOrder?: readonly TsunamiObservation[],
): string {
  return joinSegments(tsunamiDowngradeToSegments(event, observationsForOrder))
}

/**
 * 区域単位で等級が動いた報（一部解除・一部切替・一部引き上げ）の読み上げを断片列で返す。
 *
 * 例:「福岡県日本海沿岸、佐賀県北部の津波注意報が津波予報に切り替えられました。」
 * 「京都府の津波注意報が津波警報に引き上げられました。また、石川県能登の大津波警報が
 * 津波警報に切り替えられました。」
 *
 * **動いた区域だけを挙げ、残っている区域は語らない。** この報で聞き手が知りたいのは自分の
 * 地域が変わったかどうかで、発表中の区域の全体像はカードが示す。全区域を読む発表文
 * （`tsunamiToSegments`）と役割を分けている。
 *
 * **行動指示（「海岸から離れてください」等）も付けない。** 等級の発表と違い、この報は
 * 「どこがどう変わったか」を伝えるためのもの。
 *
 * 遷移の組ごとに 1 文を置き、2 文目以降を「また、」で継ぐ（等級ごとに文を分ける
 * `lowerGradeSentence` と同じ作法）。区域名は自分の組の中で読点連結し、助詞は述語の直前に
 * 1 つだけ置く（→ docs/spec/audio-tts-spec.md §4）。
 *
 * 変化が無ければ空を返す（呼び出し側が観測点更新の読み上げへ落とす）。
 *
 * **受け取るのは既読を除いた組。** `LastKind` は変化した後の続報にも載り続けるため、電文から
 * 毎回組を作り直すと同じ文を繰り返す（→ `selectUnspokenAreaGradeChanges`）。既読の判断は
 * 呼び出し側（発話の直前に記録を進める側）が持つ。
 *
 * @param changes 読み上げる等級変化の組。並びがそのまま文の順になる
 */
export function tsunamiAreaGradeChangeToSegments(changes: readonly TsunamiAreaGradeChange[]): SpeechSegment[] {
  const segments: SpeechSegment[] = []
  changes.forEach((change, i) => {
    if (i > 0) segments.push(plain('また、'))
    segments.push(...areaNameSegments(change.areas))
    if (change.to === TSUNAMI_GRADE_LIFTED) {
      // 解除された区域。遷移先に等級の名前が無いので「〜に切り替えられました」とは言えない。
      // **残っている区域の話も、行動の指示も足さない**（他の遷移と同じ方針）。
      segments.push(plain(`の${tsunamiGradeLabel(change.from)}が解除されました。`))
      return
    }
    if (change.from === 'Unknown') {
      // 前回は津波なし（`LastKind` が 00 等）。「〜の津波なしが」とは言えないので、
      // 波高が付いていない発表文と同じ言い方に落とす。
      segments.push(plain(`に${tsunamiGradeLabel(change.to)}が発表されました。`))
      return
    }
    const verb = change.raised ? '引き上げられました' : '切り替えられました'
    segments.push(plain(`の${tsunamiGradeLabel(change.from)}が${tsunamiGradeLabel(change.to)}に${verb}。`))
  })
  return segments
}

/** 区域単位で等級が動いた報の読み上げテキストを生成する。 */
export function tsunamiAreaGradeChangeToText(changes: readonly TsunamiAreaGradeChange[]): string {
  return joinSegments(tsunamiAreaGradeChangeToSegments(changes))
}

/** VTSE41/51/52 津波警報等 全解除の読み上げテキストを cancelReason ごとに生成する。 */
export function tsunamiCancelToText(cancelReason: JMATsunami['cancelReason'], cancelText?: string): string {
  const head = cancelReason === 'retracted'
    ? '津波警報等は誤って発表されたため取り消されました。'
    : cancelReason === 'expired'
      ? '津波予報の有効期間が終了しました。'
      : '津波警報等は全て解除されました。'
  // 取消しの概要は取消電文にしか入らない。解除・失効では電文に無いので空のまま
  return head + cancelReasonSentence(cancelText)
}

/** 観測点を districtName（津波予報区）ごとにまとめる。区域名を持たない観測は単独の項目にする。 */
function groupObservationsByDistrict(
  items: readonly TsunamiObservation[],
): { districtName: string | null; districtCode?: string; items: TsunamiObservation[] }[] {
  const groups: { districtName: string | null; districtCode?: string; items: TsunamiObservation[] }[] = []
  for (const o of items) {
    const key = o.districtName ?? null
    const existing = key !== null ? groups.find(g => g.districtName === key) : undefined
    if (existing) existing.items.push(o)
    else groups.push({ districtName: key, districtCode: o.districtCode, items: [o] })
  }
  return groups
}

/**
 * グループごとに「区域名、地点1で〜、地点2で〜」の形の断片列を作る。
 * `renderStation` が 1 地点ぶんの文言を返す（波高あり／地点名のみで使い分ける）。
 */
function observationDetailSegments(
  items: readonly TsunamiObservation[],
  renderStation: (obs: TsunamiObservation) => string,
): SpeechSegment[] {
  const segments: SpeechSegment[] = []
  groupObservationsByDistrict(items).forEach((g, gi) => {
    if (gi > 0) segments.push(plain('、'))
    if (g.districtName) {
      segments.push({
        text: g.districtName,
        refs: [{ kind: 'area', code: g.districtCode, name: g.districtName }],
      })
      segments.push(plain('、'))
    }
    g.items.forEach((o, i) => {
      if (i > 0) segments.push(plain('、'))
      segments.push({ text: o.name, refs: [{ kind: 'station', name: o.name }] })
      const rest = renderStation(o)
      if (rest) segments.push(plain(rest))
    })
  })
  return segments
}

/**
 * `maxPoints` で読み上げから外した地点数を伝える一文を返す（外していなければ空の断片列）。
 *
 * **黙って捨てないこと。** 観測点の選抜は深刻な順（`compareObservedHeightDesc`）に上位だけを
 * 読むため、「○m以上」が複数あって上限を超えたときは、そのうちの一部が読み上げから落ちる。
 * 落ちたことを言わないと、聞いた人は読まれた地点が最大だと受け取る。
 *
 * **述語に貼り付けず独立した一文にする。** 観測波高の読み上げは新規と更新で述語が変わるため
 * （「〜を観測しました」／「〜に更新されました」）、末尾の句に混ぜると外した地点が更新扱いに
 * なる。外した地点は新規・更新のどちらでもありうるので、どちらにも寄せない言い方にする。
 *
 * 観測波高の読み上げと到達確認の読み上げ（`tsunamiArrivalToSegments`）で共有する。地点数の
 * 言い方を手で複製すると、片方だけ変えたときに黙って乖離する（続く述語だけを引数で受ける）。
 *
 * **助詞は述語に合わせて選ぶ。** 既定の「でも」は場所を示す「で」で、そこで何かを観測した・
 * 到達を確認したという述語に続く形。**欠測は観測点そのものの状態**（その場所で何かが起きた
 * わけではない）なので、「で」を落として「ほか○地点も」にする。
 */
function omittedPointsSentence(total: number, shown: number, tail: string, particle = 'でも'): SpeechSegment[] {
  const omitted = total - shown
  return omitted > 0 ? [plain(`ほか${omitted}地点${particle}${tail}。`)] : []
}

// 波高つきの 1 地点ぶん（地点名は呼び出し側が断片にするので、それに続く部分だけを返す）。
// 単位の読み替えは予想波高と同じ関数に通す（全角・半角の扱いを 2 か所に分けない）。
// 「以上」の補完はカード・地図と同じ `overSuffixedHeight` に通す（補ってから単位を読み替える順）。
// この 2 つは可換で、どちらを先に通しても同じ文字列になる。順序に意味を持たせていない。
function observedHeightSuffix(o: TsunamiObservation): string {
  return `で${tsunamiHeightToSpeech(overSuffixedHeight(o.height!))}`
}

/** 観測点更新で読み上げる件数の上限（多いときは波高の大きい順に絞る）。 */
export const OBS_UPDATE_SPEAK_MAX_POINTS = 5

/**
 * 観測点更新のうち**実際に読み上げる分**を選ぶ（波高を持つものだけ・降順・上限まで）。
 *
 * **読み上げた観測点を既読として記録する側も、必ずこの関数で絞ること**
 * （`useLiveEventHandler` の `spokenObsHeightRef`）。絞り方を別々に書くと、上限で読まなかった
 * 観測点まで既読になり、その値は二度と読まれない（波高がさらに上がるまで差分に出てこない）。
 */
export function selectObservationUpdatesToSpeak(
  updatedObs: readonly TsunamiObservation[],
  maxPoints = OBS_UPDATE_SPEAK_MAX_POINTS,
): TsunamiObservation[] {
  const obs = updatedObs.filter(o => o.height !== undefined)
  // 深刻な順に選抜する（規則はカードの並びと同じ compareObservedHeightDesc）。**値の大小だけで
  // 切らないこと。** maxPoints で打ち切るため、値の大小で並べると「○m以上」の観測点が上位から
  // 押し出されて読み上げから丸ごと落ちる。カードなら下の方でも残るが、音は落ちたら気づけない。
  return [...obs].sort((a, b) => compareObservedHeightDesc(a.height!, b.height!)).slice(0, maxPoints || Infinity)
}

/**
 * 「前に声にした波高がある観測点名」を引ける最小の形（`Set` でも `Map` でもそのまま渡せる）。
 *
 * 渡すのは**読み上げ用の記憶**（`useLiveEventHandler` の `spokenObsHeightRef`）。画面用の記憶
 * （受信時に進む）を渡してはいけない。割り込みで鳴らなかった観測点が「既に伝えた」ことになり、
 * 一度も声にしていない地点を「更新されました」と言う。
 */
type SpokenHeightLookup = { has(name: string): boolean }

/**
 * VTSE41/51/52 津波観測情報 更新点のみ読み上げテキストを生成する。
 * updatedObs は最大波高が更新された観測点のみを渡す（波高降順で最大 maxPoints 件）。
 *
 * **「新たに」と「更新」を言い分ける。** 津波が新しい場所に届いたのと、既に届いていた場所で波が
 * 高くなったのは、聞き手にとって意味が違う（画面のカードも新規＝緑・更新＝黄で区別している）。
 * 境界は `spokenHeights` に前値があるかどうかだけで、名前を聞いたことがあるかでは判定しない。
 * 到達確認だけ読んだ観測点（「最大波高は観測中です」まで言った地点）に初めて値が付いた場合は、
 * 波高としては初出なので「新たに」側に入る ―― 前値が無いのに「更新」と言えば嘘になる。
 *
 * 2 群に分かれたら、**深刻な波高を含む群を先に読み、後ろを「また、」で継ぐ**。最悪の値を先に
 * 伝えるという選抜の方針を、群に割ったあとも崩さないため。
 *
 * **群の中を読む順は `updatedObs` の並びをそのまま使う。** 呼び出し側がカードの並び
 * （`sortObservationsForCardDisplay`）で渡すこと。深刻な順に読み直すとカード上を上下に往復する
 * （→ [`tsunami-spec.md`](../../docs/spec/tsunami-spec.md) §9）。深刻な順は**どれを読むかの選抜
 * だけ**に使う ―― 選抜と並び順は別物。
 */
export function tsunamiObservationUpdateToSegments(
  updatedObs: TsunamiObservation[],
  headline?: string,
  maxPoints = OBS_UPDATE_SPEAK_MAX_POINTS,
  spokenHeights?: SpokenHeightLookup,
): SpeechSegment[] {
  // 選抜は selectObservationUpdatesToSpeak に集約する（既読を記録する側と同じ絞り方にするため）。
  // obs は「波高を持つ総数」で、読み上げなかった件数（omittedPointsSentence）を数えるのに要る。
  const obs = updatedObs.filter(o => o.height !== undefined)
  const selected = selectObservationUpdatesToSpeak(updatedObs, maxPoints)
  if (selected.length === 0) return []
  // 最も深刻な観測点（選抜が深刻な順に返すので先頭）。どちらの群を先に読むかだけに使う。
  const worst = selected[0]
  // 選抜した分を**入力の並びに戻して**読む（並びの根拠は上の説明）。
  const chosen = new Set(selected)
  const inReadingOrder = obs.filter(o => chosen.has(o))
  // headline の全角数字・全角ｍ・全角ピリオドを半角に変換して VOICEVOX の誤読を防ぐ。
  // **日時のゼロ埋めと「1日」の読みもここで直す** —— 見出し文は気象庁が書いた文で、
  // 半角にしただけでは `01日` が残り、合成エンジンが先頭の 0 を桁として読む（「ぜろ いちにち」）。
  // 句区切り辞書の `1日`（→ ついたち）も、直前が数字だと当たらない。
  const headlinePart = headline?.trim()
    ? normalizeDateTimeForSpeech(tsunamiHeightToSpeech(headline.trim()))
    : ''
  // **選抜した結果を分けるだけ。** 群ごとに選抜し直すと上限が実質 2 倍になり、既読を記録する側
  // （`selectObservationUpdatesToSpeak` を使う）と読み上げた集合が食い違う。
  const raised = inReadingOrder.filter(o => spokenHeights?.has(o.name) ?? false)
  const firstTime = inReadingOrder.filter(o => !(spokenHeights?.has(o.name) ?? false))
  const clauseOf = (items: TsunamiObservation[], isRaised: boolean): SpeechSegment[] => {
    if (items.length === 0) return []
    return [
      ...(isRaised ? [] : [plain('新たに')]),
      ...observationDetailSegments(items, observedHeightSuffix),
      plain(isRaised ? 'に更新されました。' : 'を観測しました。'),
    ]
  }
  // 深刻な観測点を含む群を先に置く（最も深刻な観測点がどちらの群に入ったかで決まる）。
  const raisedLeads = raised.includes(worst)
  const lead = clauseOf(raisedLeads ? raised : firstTime, raisedLeads)
  const follow = clauseOf(raisedLeads ? firstTime : raised, !raisedLeads)
  return [
    plain(`津波観測情報。${headlinePart}`),
    ...lead,
    ...(follow.length > 0 ? [plain('また、'), ...follow] : []),
    ...omittedPointsSentence(obs.length, selected.length, '観測しています'),
  ]
}

export function tsunamiObservationUpdateToText(
  updatedObs: TsunamiObservation[],
  headline?: string,
  maxPoints = OBS_UPDATE_SPEAK_MAX_POINTS,
  spokenHeights?: SpokenHeightLookup,
): string {
  return joinSegments(tsunamiObservationUpdateToSegments(updatedObs, headline, maxPoints, spokenHeights))
}

/**
 * 話題の変わる断片列を「また、」で継ぐ。
 *
 * 別々の関数が組んだ文をそのまま並べると、境目に手がかりの無い文が 2 つ続く。津波の観測情報で
 * 「新たに隠岐、隠岐西郷で0.1メートルを観測しました。」の直後に「兵庫県北部、豊岡市津居山で
 * 到達を確認しました。」が来る形がそれで、**どちらも「地名で〜しました」の同じ形**なので、
 * 後ろの文が前の文の続き（同じ観測点の話）に聞こえる。区切り方は等級ごと
 * （{@link lowerGradeSentence}）・新規と更新の群（{@link tsunamiObservationUpdateToSegments}）で
 * 既に使っているものに揃える。
 *
 * **どちらかが空なら接続語を付けない。** 前段が無いのに「また、」で始まる文にしないため。
 */
export function joinWithAlso(
  lead: readonly SpeechSegment[],
  follow: readonly SpeechSegment[],
): SpeechSegment[] {
  if (lead.length === 0 || follow.length === 0) return [...lead, ...follow]
  return [...lead, plain('また、'), ...follow]
}

/** 到達確認で読み上げる件数の上限（多いときは渡された並びの先頭から採る）。 */
export const ARRIVAL_SPEAK_MAX_POINTS = 5

/**
 * 到達確認のうち**実際に読み上げる分**を選ぶ（渡された並びの先頭から上限まで）。
 *
 * **既読として記録する側も必ずこの関数で絞ること**（`useLiveEventHandler` の
 * `spokenObsNamesRef`）。上限で読まなかった観測点まで既読にすると、その到達確認は二度と
 * 読まれない（波高更新側の `selectObservationUpdatesToSpeak` と同じ約束）。
 */
export function selectArrivalsToSpeak(
  obs: readonly TsunamiObservation[],
  maxPoints = ARRIVAL_SPEAK_MAX_POINTS,
): TsunamiObservation[] {
  return obs.slice(0, maxPoints || Infinity)
}

/**
 * 最大波高が未確定（「観測中」）のまま新規に到達が確認された観測点の読み上げテキストを生成する。
 * まだ maxHeight の数値が出ていない観測点（JMA電文で maxHeight.condition = "観測中"）が対象。
 * 波高が未確定であること自体も明示的に読み上げる。件数は maxPoints で絞り、他 tsunami 系読み上げと同様に上限を設ける。
 * 波高読み上げ（observationDetailSegments）と同様に districtName（津波予報区）ごとにグループ化する。
 *
 * **読む順は渡された並びのまま。** 波高更新の読み上げと同じく、呼び出し側がカードの並び
 * （`sortObservationsForCardDisplay`）で渡すこと。上限で落とすのも先頭からなので、並びが
 * カードと違うとカード上で飛び飛びの地点が読まれる。
 */
export function tsunamiArrivalToSegments(obs: TsunamiObservation[], maxPoints = ARRIVAL_SPEAK_MAX_POINTS): SpeechSegment[] {
  if (obs.length === 0) return []
  const shown = selectArrivalsToSpeak(obs, maxPoints)
  // **「微弱」の観測点に「観測中」と言わない。** 微弱は「観測した波がごく小さい」ことを
  // 気象庁が伝えている状態で、値がこれから出るわけではない（電文解説資料 Ⅱ.12）。
  const weak = shown.filter(o => o.condition?.weak)
  const observing = shown.filter(o => !o.condition?.weak)
  const clause = (items: TsunamiObservation[], tail: string): SpeechSegment[] =>
    items.length > 0 ? [...observationDetailSegments(items, () => ''), plain(tail)] : []
  return [
    ...joinWithAlso(
      clause(observing, 'で到達を確認しました。最大波高は観測中です。'),
      clause(weak, 'で到達を確認しました。最大波高は微弱です。'),
    ),
    ...omittedPointsSentence(obs.length, shown.length, '到達を確認しています'),
  ]
}

export function tsunamiArrivalToText(obs: TsunamiObservation[], maxPoints = 5): string {
  return joinSegments(tsunamiArrivalToSegments(obs, maxPoints))
}

/** 欠測で読み上げる件数の上限（多いときは渡された並びの先頭から採る）。 */
export const MISSING_SPEAK_MAX_POINTS = 5

/**
 * 欠測のうち**実際に読み上げる分**を選ぶ（渡された並びの先頭から上限まで）。
 *
 * **既読として記録する側も必ずこの関数で絞ること**（`useLiveEventHandler` の
 * `spokenObsMissingRef`）。上限で読まなかった観測点まで既読にすると、その欠測は二度と
 * 読まれない（到達確認・波高更新と同じ約束）。
 */
export function selectMissingToSpeak(
  obs: readonly TsunamiObservation[],
  maxPoints = MISSING_SPEAK_MAX_POINTS,
): TsunamiObservation[] {
  return obs.slice(0, maxPoints || Infinity)
}

/**
 * 観測データが欠測となった観測点の読み上げ。
 *
 * **到達確認（{@link tsunamiArrivalToSegments}）へ混ぜないこと。** あちらは「到達した事実は
 * 確定していて波高だけがこれから」という文で、欠測の観測点に当てると到達を断定してしまう。
 *
 * 文は 2 通りに分かれる。電文は欠測と同時に「これまでの最大波の高さ」を載せることがある
 * （気象庁 電文解説資料 Ⅱ.12 事例 6）ため、**値を観測できていた観測点はその値も伝える**。
 * 値を持つ群を先に置き、持たない群を「また、」で継ぐ（区切り方は `joinWithAlso`）。
 *
 * **読む順は渡された並びのまま。** 波高更新・到達確認と同じく、呼び出し側がカードの並び
 * （`sortObservationsForCardDisplay`）で渡すこと。
 */
export function tsunamiMissingToSegments(
  obs: TsunamiObservation[],
  maxPoints = MISSING_SPEAK_MAX_POINTS,
): SpeechSegment[] {
  if (obs.length === 0) return []
  const shown = selectMissingToSpeak(obs, maxPoints)
  // 「これまでに何を観測できていたか」を言える観測点。**波高の数値だけでなく「微弱」も含める**
  // （「微弱 欠測」は同 事例 7 の形。カードは波高の欄に「微弱」を出すので、読み上げだけ黙ると
  // 声を頼りにしている人にその分だけ届かない）。
  const observed = shown.filter(o => o.height || o.condition?.weak)
  const unknown = shown.filter(o => !(o.height || o.condition?.weak))
  const observedClause: SpeechSegment[] = observed.length > 0
    ? [
      plain('これまでに'),
      ...observationDetailSegments(observed, o => (o.height ? observedHeightSuffix(o) : 'で微弱な津波')),
      plain('を観測したのち、欠測となっています。'),
    ]
    : []
  const missingClause: SpeechSegment[] = unknown.length > 0
    ? [
      ...observationDetailSegments(unknown, () => ''),
      // **場所を示す「で」を付けない。** 欠測は観測点そのものの状態で、その場所で何かが
      // 起きたわけではない（「◯◯は欠測」が正しい形）。値を観測できていた側の文
      // （上の `observedClause`）では観測がその場所で起きているので「で」を使う。
      plain('は欠測となっています。'),
    ]
    : []
  return [
    ...joinWithAlso(observedClause, missingClause),
    ...omittedPointsSentence(obs.length, shown.length, '欠測となっています', 'も'),
  ]
}

export function tsunamiMissingToText(obs: TsunamiObservation[], maxPoints = MISSING_SPEAK_MAX_POINTS): string {
  return joinSegments(tsunamiMissingToSegments(obs, maxPoints))
}

/**
 * 「観測中」のまま津波警報に相当する津波を観測している観測点を読む上限。
 *
 * 沖合の観測点は数が限られるうえ、この状態になるのは大津波警報の発表中だけ。欠測と同じ
 * 件数に揃えてある（読み上げが長くなりすぎない範囲で、落ちた分は件数で伝える）。
 */
export const WARNING_LEVEL_SPEAK_MAX_POINTS = 5

/**
 * 読み上げる観測点の絞り込み。
 *
 * **既読の記録と文の生成で同じものを通すこと。** 別々に切ると、上限で読まなかった観測点まで
 * 既読になり、次の報でも読まれない（到達確認・欠測でも同じ規則）。
 */
export function selectWarningLevelToSpeak(
  obs: readonly TsunamiObservation[],
  maxPoints = WARNING_LEVEL_SPEAK_MAX_POINTS,
): TsunamiObservation[] {
  return obs.slice(0, maxPoints || Infinity)
}

/**
 * 「観測中」のまま津波警報に相当する津波を観測している観測点の読み上げ。
 *
 * 気象庁が `Revise` に置いた信号（→ `tsunami.ts` の `isWarningLevelWhileObserving`）を伝える。
 * **波高の数値が無いため、他のどの文にも乗らない** —— 波高更新の文は数値を読み、到達確認の文は
 * 「到達を確認しました」で到達だけを述べる。この状態を黙って落とすと、資料が「注意する必要が
 * ある」と名指しした事実が音声から消える。
 *
 * **高さは言わない。** 電文が数値を出していないので、アプリが「1m 超」などと補ってはいけない。
 * 伝えるのは気象庁が言ったことだけ ―― 警報に相当する津波を観測している、という事実。
 *
 * **読む順は渡された並びのまま**（呼び出し側がカードの並びで渡す。欠測・到達確認と同じ）。
 */
export function tsunamiWarningLevelToSegments(
  obs: TsunamiObservation[],
  maxPoints = WARNING_LEVEL_SPEAK_MAX_POINTS,
): SpeechSegment[] {
  if (obs.length === 0) return []
  const shown = selectWarningLevelToSpeak(obs, maxPoints)
  return [
    ...observationDetailSegments(shown, () => ''),
    plain('では、津波警報に相当する津波を観測しています。'),
    ...omittedPointsSentence(obs.length, shown.length, '津波警報に相当する津波を観測しています', 'も'),
  ]
}

export function tsunamiWarningLevelToText(
  obs: TsunamiObservation[],
  maxPoints = WARNING_LEVEL_SPEAK_MAX_POINTS,
): string {
  return joinSegments(tsunamiWarningLevelToSegments(obs, maxPoints))
}

/** 南海トラフ地震臨時情報（VYSE50/51/52）の読み上げテキストを生成する。 */
export function nankaiToText(event: JMANankai): string {
  // **取消と調査終了を混ぜない。** 取消は「その電文を撤回する」だけで、地震の発生可能性に
  // ついての判断を含まない（電文解説資料 Ⅰ.別紙ウ。→ `JMANankai.retracted`）。ここで
  // 「通常の範囲内でした」と言うと、**気象庁が発表していない安心情報をアプリが作る**ことになる。
  // 取り消された事実だけを伝え、状況の断定も行動指示も足さない。
  if (event.retracted) {
    return '南海トラフ地震臨時情報は取り消されました。'
  }
  if (event.cancelled || event.kindName === '調査終了') {
    return '南海トラフ地震臨時情報、調査終了。南海トラフ地震の発生可能性は通常の範囲内でした。'
  }
  if (event.kindName === '調査中') {
    return '南海トラフ地震臨時情報、調査中。南海トラフ地震の発生可能性について調査しています。最新情報に注意してください。'
  }
  if (event.kindName === '巨大地震警戒') {
    return '南海トラフ地震臨時情報、巨大地震警戒。南海トラフ地震の想定震源域内で大規模な地震が発生しました。直ちに防災対応をとってください。'
  }
  if (event.kindName === '巨大地震注意') {
    return '南海トラフ地震臨時情報、巨大地震注意。南海トラフ地震の想定震源域内で地震が発生しました。防災対応の確認をしてください。'
  }
  return '南海トラフ地震臨時情報。南海トラフ地震に関する臨時情報が発表されました。最新情報に注意してください。'
}

/**
 * 南海トラフ地震関連解説情報（VYSE51=臨時解説 / VYSE52=定例解説）の読み上げテキストを生成する。
 *
 * 本文（body）は 1000 字を超えることがあるため読み上げない。何が発表されたかだけを伝え、
 * 詳細は画面のバナーに委ねる。段階（調査中・巨大地震注意等）を持つ電文ではないので、
 * 臨時情報（nankaiToText）のような防災対応の呼びかけも付けない。
 */
export function nankaiCommentaryToText(event: JMANankaiCommentary): string {
  if (event.serialName === '定例解説') {
    return '南海トラフ地震関連解説情報。南海トラフ沿いの地震に関する評価検討会の定例会合による調査結果が発表されました。'
  }
  // 臨時解説の情報名には「（第１号）」のように号数が入る。読み手が経過を追えるので拾う
  const serial = event.headline.match(/（第(.+?)号）/)?.[1]
  return `南海トラフ地震関連解説情報${serial ? `、第${serial}号` : ''}。南海トラフ地震の想定震源域の状況について解説情報が発表されました。`
}

/**
 * 地震回数に関する情報（VXSE60）の読み上げテキストを生成する。
 *
 * **読むのは総数と有感の数だけ。** 区間は 1 時間ごとに何本も並ぶので、全部読むと数字の羅列に
 * なって総数が耳に残らない。経過の細かさは画面のカードに委ねる。
 *
 * **場所は言わない。** 電文が場所を構造化して持つのは震源要素のある種別だけで、この電文では
 * 自由文（`freeText`）の中にしか出てこない。文から地名を抜くと、書き方が変わったときに
 * 別の語を場所として読み上げる。
 *
 * **累積の区間を選ぶ。** 電文は「区間ごとの回数」と「初めからの累計」を同じ `Item` の並びで
 * 送ってくるので、末尾を無条件に採ると 1 時間ぶんの数字を総数として読みかねない。判定は
 * `type` の語で行い、見つからなければ**読み上げない**（部分の数字を全体として言わない）。
 *
 * @returns 読み上げ文。累積の区間が無ければ空文字（呼び出し側はタブ移動へ落とす）
 */
export function earthquakeCountToText(event: JMAEarthquakeCount): string {
  if (event.cancelled) {
    // 理由（電文の `Body/Text`）も読む（宣言だけの本文は落ちる。→ `cancelReasonSentence`）。
    // **地震・津波・EEW の取消と揃える** —— 片方だけ拾うと、
    // 同じ「取り消した」でも種別によって理由が出たり出なかったりする。**この種別はカードが
    // 消えるので、理由が届く先は読み上げだけ**（他の 3 種別は取消後もカードが残って全文を出す）。
    // **`staysOnScreen: false`。** この種別は取消で帯ごと消えるので、長すぎて省いた理由は
    // 読み上げにも画面にも残らない。他の 3 種別（カードが残る）と同じ記録にしない。
    return '地震回数に関する情報は取り消されました。' + cancelReasonSentence(event.cancelText, false)
  }
  const total = event.items.find(it => it.type.includes('累積'))
  if (!total) {
    // **黙って読まないと、この電文が届いたことがどこにも残らない。** 「累積」を含む区間が
    // 必ず 1 つあるという前提は公式サンプルから採ったもので、実配信では確かめられていない。
    log.warn(`[tts] 地震回数に関する情報に累積の区間がありません（読み上げません）: ${event.items.map(i => i.type).join('・') || '区間なし'}`)
    return ''
  }
  const felt = total.feltNumber > 0
    ? `このうち、震度1以上を観測したのは${total.feltNumber}回です。`
    : 'このうち、震度1以上を観測したものはありません。'
  return `地震回数に関する情報。${formatCountSpanForSpeech(total.startTime, total.endTime)}に、地震が${total.number}回発生しています。${felt}`
}

/**
 * 累積区間の期間を読み上げ用の句にする（「9日15時から10日12時まで」）。
 *
 * **日付から読む。** 群発の累積は前日以前にさかのぼることが多く（実サンプルは 21 時間）、
 * 時刻だけだと今日のことなのかが判らない。分は読まない —— 区間の端は毎正時に揃っており、
 * 「15時00分」と読ませても情報が増えない。
 *
 * 日時として読めない値では期間そのものを言わない（「Invalid Date」を音にしないため）。
 */
function formatCountSpanForSpeech(startTime: string, endTime: string): string {
  const start = new Date(startTime)
  const end = new Date(endTime)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 'これまで'
  const md = (d: Date) => `${speakableDay(d.getDate())}${d.getHours()}時`
  return `${md(start)}から${md(end)}まで`
}

/** 北海道・三陸沖後発地震注意情報（VYSE60）の読み上げテキストを生成する。 */
export function kohatsuToText(event: JMAKohatsu): string {
  const headline = event.headline.replace(/北海道・三陸沖後発地震注意情報/g, '')
  return `北海道・三陸沖後発地震注意情報。${headline ? headline + '。' : ''}今後、大規模地震の発生可能性が平常時より高まっています。防災対応の確認をしてください。`
}

// 一次細分区域名のリストのうち、県内全区域が同じ階級で揃っているものを「〇〇県」1件にまとめる。
// areaPrefIndex / prefAreaNames が引けない（未読み込み）場合はまとめず区域名をそのまま返す。
//
// **上位の階級で区域名を出した県はまとめない**（`prefsWithAreaShown`）。震度側の
// `aggregateAreaNamesByPref` と同じ理由（上下の階級で粒度が食い違うと県の階級を過小に伝える）。
function aggregateLpgmNamesByPref(
  names: string[],
  areaPrefIndex: Map<string, string> | null,
  prefAreaNames: Map<string, Set<string>> | null,
  prefsWithAreaShown: ReadonlySet<string>,
): string[] {
  if (!areaPrefIndex) return names
  const byPref = new Map<string, Set<string>>()
  const noPref: string[] = []
  for (const name of names) {
    const pref = areaPrefIndex.get(name)
    if (!pref) { noPref.push(name); continue }
    const set = byPref.get(pref) ?? new Set<string>()
    set.add(name)
    byPref.set(pref, set)
  }
  const result: string[] = [...noPref]
  for (const [pref, regionNames] of byPref) {
    const fullSet = prefAreaNames?.get(pref)
    const isWholePref = fullSet != null && fullSet.size > 0
      && regionNames.size === fullSet.size && [...regionNames].every(n => fullSet.has(n))
      && !prefsWithAreaShown.has(pref)
    if (isWholePref) result.push(pref)
    else result.push(...regionNames)
  }
  return result
}

// 長周期地震動の観測地域テキストを生成する（buildRegionText の LPGM 版）
function buildLpgmRegionText(lpgm: JMALpgm, opts: TtsSpeechOptions): string {
  if (!lpgm.regions || lpgm.regions.length === 0) return ''

  // 階級ごとに地域名をまとめる（降順）
  const byClass = new Map<number, string[]>()
  for (const r of lpgm.regions) {
    if (r.maxLgInt < 1) continue
    const names = byClass.get(r.maxLgInt) ?? []
    names.push(r.name)
    byClass.set(r.maxLgInt, names)
  }
  const classes = [...byClass.keys()].sort((a, b) => b - a)
  if (classes.length === 0) return ''

  const stationData = getStationCoordsCache()
  const areaPrefIndex = getAreaPrefIndexCache()
  const prefAreaNames = stationData ? buildPrefAreaNamesIndex(stationData) : null
  const regionOrder = stationData ? buildRegionOrderIndex(stationData) : null

  const parts: string[] = []
  const mentioned = new Set<string>()
  // 上位の階級で区域名を出した県（震度側と同じ持ち回り。理由は aggregateLpgmNamesByPref のコメント）。
  const prefsWithAreaShown = new Set<string>()
  // 長周期地震動階級（1〜4）は震度スケールと別軸のため、opts.alwaysReadScale（震度の下限）は
  // ここでは適用しない。使い忘れではないので、必要になったら階級側の下限を別に設けること。
  for (let i = 0; i <= opts.intensityLevels; i++) {
    const cls = classes[i]
    if (cls == null) break
    const aggregated = aggregateLpgmNamesByPref((byClass.get(cls) ?? []), areaPrefIndex, prefAreaNames, prefsWithAreaShown)
    // 区域名を出した県を次の階級へ持ち回る。`mentioned` で落とす前に数えるのは、あちらが
    // 「同じ名前を二度読まない」ための仕組みで、粒度の判断とは別の関心事だから。
    // 区域名と県名の見分けが areaPrefIndex 頼みである点は震度側と同じ（前提も同じ）。
    for (const name of aggregated) {
      const pref = areaPrefIndex?.get(name)
      if (pref) prefsWithAreaShown.add(pref)
    }
    let names = aggregated.filter(n => !mentioned.has(n))
    if (names.length === 0) continue
    // 地域数の打ち切りは buildRegionText と同じ（許容超過の範囲内は省略せず全地域を読む）
    let omittedCount = 0
    if (opts.maxRegions > 0 && names.length > opts.maxRegions + opts.regionTolerance) {
      omittedCount = names.length - opts.maxRegions
      names = names.slice(0, opts.maxRegions)
    }
    // 読み上げ順は震度側と同じ地理順（北から・県ごと）。長周期地震動の電文には震源座標が無いため、
    // 上限で切るときの選抜は電文の並び順のまま（震度側のような震源距離での選抜は行わない）。
    names = sortByRegionOrder(names, regionOrder)
    names.forEach(n => mentioned.add(n))
    const omittedRegionSuffix = omittedCount > 0 ? `、ほか${omittedCount}地域` : ''
    parts.push(`階級${cls}を${names.join('、')}${omittedRegionSuffix}`)
  }

  if (parts.length === 0) return ''
  // 助詞「で」の置き方は buildRegionText と同じ（末尾のみ）
  return parts.join('、') + 'で観測しました。'
}

/** VXSE62 長周期地震動情報の読み上げテキストを生成する。isNew=false のとき更新報として冒頭に通知する。 */
export function lpgmToText(lpgm: JMALpgm, opts: TtsSpeechOptions, isNew: boolean): string {
  if (lpgm.cancelled) {
    // 述語は「取り消されました」で全種別そろえる（→ `eewCancelToText`）。
    return '長周期地震動情報は取り消されました。'
  }
  // 地震の時刻は**発現時刻を先に採る**（地震情報・津波カードと同じ規則）。揃えないと、
  // 同じ地震について地震情報が「◯時◯分ころ」と読んだ直後に、長周期が 1 分違う時刻を読む。
  // 気象庁自身も見出し文へ発現時刻を書いており、VXSE62 も例外ではない（実電文の全期間走査で
  // 確認。→ `docs/spec/tsunami-spec.md` §4）。**`originTime` は空になりえないが**
  // （パーサーが無ければ電文ごと捨てる）、`arrivalTime` は任意なので `||` で落とす。
  const time = formatTime(lpgm.arrivalTime || lpgm.originTime)
  const prefix = isNew ? '長周期地震動情報。' : '長周期地震動情報が更新されました。'
  // 時刻が日時として読めなければ句ごと落とす。「頃発生した地震で、」だけが残ると文が壊れ、
  // かといって時刻を読ませると「ナンじナンぷん頃」になる。落としても、この情報の主題
  // （どこで階級いくつを観測したか）は後半がすべて伝える。
  const occurrence = time ? `${time}頃発生した地震で、` : ''
  const regionText = buildLpgmRegionText(lpgm, opts)
  if (regionText) {
    return `${prefix}${occurrence}長周期地震動${regionText}`
  }
  return `${prefix}${occurrence}長周期地震動階級${lpgm.maxClass}を観測しました。`
}

export { tsunamiMaxGrade }

/**
 * 推計震度分布図（IXAC41）の読み上げ文。
 *
 * **一文だけ。名乗りは文の中に入れる。** 地震情報（「地震情報。◯時◯分ごろ、…」）や
 * 南海トラフ（「南海トラフ地震関連解説情報。…が発表されました。」）は「〈名乗り〉。〈本文〉。」の
 * 二文だが、あちらは名乗りのあとに続く中身が長い。こちらは伝えることが 1 つしかないので、
 * 名乗りを分けると同じ語を二度言うことになる。
 *
 * **「推計震度分布図」は気象庁の呼称そのもの**なので、これ自体が名乗りとして働く。
 * 「推計震度分布情報」という名前は使わない —— 気象庁がその名前を使っていない
 * （資料名は「推計震度分布図作図用データ」、図の名は「推計震度分布図」）。電文の名称に
 * 合わせる決まりに従う（→ docs/spec/eew-spec.md §3「電文の名称と表示・読み上げ」）。
 *
 * 地震そのものの事実（震源・規模・各地の震度）は既に地震情報で読み上げていて、この電文が
 * 足すのは「その震度の広がりが、気象庁の推計として出そろった」ことだけ。地震発生から
 * 数分後に届くので、長い文は続報の読み上げを塞ぐ。
 *
 * **どの地震の分布かは時刻で言う。** アプリが持つ分布は最新の 1 通だけで、震度5弱以上が
 * 短時間に続くと**別の地震の分布へ入れ替わる**（`decideEstimatedIntensityUpdate` の
 * `switched`）。時刻が無いと、いま聞いている分布がどちらのものか声だけでは分からない。
 * 読む値は地震発現時刻（`arrivalTime`）で、**地震情報が読む時刻と同じ**（引き当ての鍵でもある
 * → `matchEstimatedIntensity`）ので、耳の中で先ほどの地震情報と繋がる。
 *
 * 名詞句「〇時〇分頃発生した地震」は長周期地震動（{@link lpgmToText}）と同じ。助詞だけ
 * 「で」ではなく「について」にする —— あちらの述語は「観測しました」で地震が観測の場だが、
 * こちらは「受信しました」で地震は話題にすぎない（震源要素更新と同じ側）。
 *
 * **続報は「更新されました」と言う。** 同じ地震について続報が出る（実電文で 6 分後）。
 * 言い分けないと、聞き手には同じ報が二度読まれたようにしか聞こえない。長周期地震動が
 * 「長周期地震動情報。」／「長周期地震動情報が更新されました。」と分けているのと同じ扱い。
 * 判定は呼び出し側が渡す（→ `isNewEstimatedIntensity`）。
 *
 * **推計の最大震度は言わない。** 気象庁が「推計された震度の値は、場合によっては1階級程度
 * 異なることがあります」と断っており、観測して発表した最大震度と食い違いうる。声で並べると
 * どちらが発表値か区別できないまま、2 つの「最大震度」が耳に入ることになる。
 *
 * **場所も言わない。** 電文が持つのは震央地名の**番号**だけで、名前はアプリの側に無い。
 *
 * @param arrivalTime 地震発現時刻。**本体（最大 3MB）ではなくこの値だけを受け取る** ――
 *   文に要るのはこれ 1 つで、引数を見れば何に依存しているかが分かる
 * @param isNew 初めて受信した分布なら真。同じ地震の続報なら偽
 */
export function estimatedIntensityToText(arrivalTime: string, isNew: boolean): string {
  const tail = isNew ? 'を受信しました' : 'が更新されました'
  // 時刻が日時として読めなければ句ごと落とす。**素で埋めると `null頃` と声に出る** ——
  // `formatTime` の戻り値は `string | null` だが、テンプレートリテラルは型検査を通る。
  //
  // **この句が担うのは「どの地震の分布か」の区別**（分布は別の地震のものへ入れ替わりうるので、
  // 時刻が無いと声だけでは前の分布と見分けが付かない。→ `docs/spec/quake-spec.md` §8）。
  // 落とすとその区別を失うが、読めない値を声にするよりはよい。読めなかった事実は
  // `readDateTime` が記録に残す。
  const time = formatTime(arrivalTime)
  return `${time ? `${time}頃発生した地震について、` : ''}気象庁の推計震度分布図${tail}。`
}

/**
 * 気象庁が書いた文（本文・付加文）を読み上げ用に整える。
 *
 * **改行と全角スペースは落とす。** 自由付加文には全角スペースで桁を揃えた表が入ることがあり、
 * そのまま渡すと合成エンジンが空白の数だけ間を作る。句読点は残す（文の切れ目そのものなので）。
 */
/**
 * 落とす定型文の定義。**画面には従来どおり全文を出す**ので、ここで落とすのは声だけ。
 *
 * 落とす単位・文字列で判定する理由・コードの役割・既定値の向きは
 * {@link TELEGRAM_BOILERPLATE_KEYS} に書いた。
 */
interface TelegramBoilerplateSpec {
  readonly key: TelegramBoilerplateKey
  /**
   * 落とす句。**行の中に現れても落とす**（部分一致）。
   *
   * 1 行に収まる定型文はこちら。電文は本来 1 文ごとに改行する（解説資料が「複数の固定付加文を
   * 記載する場合、Text においては改行し」と定めており、実電文の `Code="0256 0262"` も改行区切り）
   * が、**行で照合する形にすると連結された形を落とせない**。落とした跡は前後の文が繋がる。
   */
  readonly phrases?: readonly string[]
  /**
   * 落とす行。原文を改行で割り、{@link boilerplateLineKey} を通した形と突き合わせる。
   *
   * **複数行にわたる表はこちら。** 句として部分一致で落とすには改行と全角スペースの並びまで
   * 鍵に含めることになり、気象庁が桁揃えを変えただけで効かなくなる。行ごとに照合すれば空白の
   * 畳み方に依存しない。
   */
  readonly lines?: readonly (string | RegExp)[]
  /** その文を載せる固定付加文のコード。**落とし漏れの検出にだけ使う。** */
  readonly codes?: readonly string[]
}

/**
 * どちらの形でも「**文面はすべて実配信の電文から採る**」。推測で書いた文面を置くと、一致しない
 * まま「落としているつもり」になる（その形で 1 度踏んでいる。→ {@link TELEGRAM_BOILERPLATE_KEYS}）。
 */

/**
 * 落とし漏れの記録の間引き。**電文種別 × 項目**を札にし、同じ組は 1 度だけ出す。
 * 上限を超えても黙らせず、そこから先は時間で間引いて出し続ける（→ `logger.ts`）。
 */
const boilerplateMismatchGate = createPerLabelLogGate(4, 60_000)

const TELEGRAM_BOILERPLATE_SPECS: readonly TelegramBoilerplateSpec[] = [
  {
    // 観測点名の `＊` を画面に出している以上その説明も要る（→ quake-spec.md §8「気象庁以外が
    // 運用する観測点」）が、読み上げでは事情が違う ——
    //
    // - **震度を伝える電文のほぼ全てに入る**ので、読むと毎報聞かされる
    // - **`＊` が音にならない**（合成エンジンは記号を読まず「シルシワ」と読む）ので、
    //   何と対比しているのかが声だけでは伝わらない
    //
    // **文面は種別で違う。** 地震情報のコード 0262 は「震度観測点」・長周期地震動観測情報の
    // 0263 は「長周期地震動観測点」で、**どちらも要る** —— 以前は 0262 の側だけを落としていて、
    // 長周期の報が観測点を載せたときだけこの説明が声になっていた。
    key: 'starMark',
    phrases: [
      '＊印は気象庁以外の震度観測点についての情報です。',
      '＊印は気象庁以外の長周期地震動観測点についての情報です。',
    ],
    codes: ['0262', '0263'],
  },
  {
    // アプリは緊急地震速報そのものを画面と音で扱っているので、声にすると二度述べになる。
    // **同じ文面・同じコードが地震情報にも入る**（実電文の VXSE53 で `0211 0241` の形）。
    // 地震情報のこの文が乗るのは固定付加文（その他）（`VarComment`）で、そちらは読み上げの
    // ブロック（`quakeVarComment`）が既定で読む側なので、**この項目を落とす設定のままなら
    // 地震情報側でも現に落ちる**。文面で落とす形にしてあるので、種別をまたいで揃う。
    key: 'eewIssued',
    phrases: ['この地震について、緊急地震速報を発表しています。'],
    codes: ['0241'],
  },
  {
    // 長周期地震動階級の目安表と、詳細ページの案内。**事象に依らない**（実電文で異なるのは
    // 案内の URL に入る地震ごとの識別子だけ）。表を声にすると 4 行が一続きに聞こえるため、
    // 読む側に倒したときは LPGM_CLASS_TABLE_RE が階級と現象表現のあいだへ空白を挟む。
    key: 'lpgmClassTable',
    lines: [
      '各長周期地震動階級に対する簡易な現象表現',
      // 階級の行。実電文の数字は全角だが半角も受ける（現象表現の語との組でしか当たらないので
      // 一致が増えても誤爆しない）。語彙は LPGM_CLASS_TABLE_RE と揃える。
      /^階級[０-９0-9](やや大きな揺れ|非常に大きな揺れ|極めて大きな揺れ|大きな揺れ)$/,
      // 案内の行。URL は地震ごとに変わるので括弧の中は見ない。
      /^波形、スペクトル等、本地震の長周期地震動に関する詳細な情報は気象庁の長周期地震動に関する観測情報のウェブサイト\s*[（(][^）)]*[）)]\s*もあわせてご活用ください。$/,
    ],
  },
  {
    // 予想される津波の高さと被害の対応表。実電文で 307 字あり、読み上げの実測レート
    // （5.8 字/秒）なら約 53 秒 —— 津波警報等が出るたび、区域と波高を伝えたあとに流れる。
    // 波高の区分は気象庁の津波警報の段階そのもので、事象によって変わらない。
    key: 'tsunamiHeightLegend',
    lines: [
      '［予想される津波の高さの解説］',
      '予想される津波が高いほど、より甚大な被害が生じます。',
      '１０ｍ超 巨大な津波が襲い壊滅的な被害が生じる。木造家屋が全壊・流失し、人は津波による流れに巻き込まれる。',
      '１０ｍ 巨大な津波が襲い甚大な被害が生じる。木造家屋が全壊・流失し、人は津波による流れに巻き込まれる。',
      '５ｍ 津波が襲い甚大な被害が生じる。木造家屋が全壊・流失し、人は津波による流れに巻き込まれる。',
      '３ｍ 標高の低いところでは津波が襲い被害が生じる。木造家屋で浸水被害が発生し、人は津波による流れに巻き込まれる。',
      '１ｍ 海の中では人は速い流れに巻き込まれる。養殖いかだが流失し小型船舶が転覆する。',
    ],
  },
]

/**
 * 行の照合キー。前後を削り、内部の空白を 1 つへ畳む。
 *
 * **気象庁は桁を揃えるために全角スペースを並べる**（津波の高さの目安は波高と被害説明のあいだに
 * 3 つ）ので、空白の数へ依存させない。`\s` は全角スペース（U+3000）も含む。
 */
function boilerplateLineKey(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

function matchesBoilerplateLine(spec: TelegramBoilerplateSpec, key: string): boolean {
  return (spec.lines ?? []).some(line => (typeof line === 'string' ? line === key : line.test(key)))
}

/** その文面が原文に含まれているか（句・行のどちらの形でも見る）。落とし漏れの検出に使う。 */
function containsBoilerplate(spec: TelegramBoilerplateSpec, text: string): boolean {
  if ((spec.phrases ?? []).some(phrase => text.includes(phrase))) return true
  return text.split('\n').some(line => matchesBoilerplateLine(spec, boilerplateLineKey(line)))
}

/**
 * 読み上げから定型文を落とす。**設定で「読む」にしている項目は落とさない。**
 *
 * **整える処理より前に通す。** 照合の相手は電文の原文（改行と全角スペースが残り、URL も
 * 付いたまま）で、整えたあとの形を鍵にすると空白の畳み方や URL の落とし方に依存してしまう。
 */
function stripBoilerplate(text: string, reads: TelegramBoilerplateReads): string {
  const dropped = TELEGRAM_BOILERPLATE_SPECS.filter(spec => !reads[spec.key])
  if (dropped.length === 0) return text
  // 行として落とすもの（複数行の表）を先に外し、残った行から句を消す。
  const kept = text
    .split('\n')
    .filter(line => {
      const key = boilerplateLineKey(line)
      // 空行は文の区切りとして意味を持つので残す（落とすのは中身のある行だけ）。
      if (!key) return true
      return !dropped.some(spec => matchesBoilerplateLine(spec, key))
    })
    .join('\n')
  let out = kept
  for (const spec of dropped) {
    for (const phrase of spec.phrases ?? []) out = out.split(phrase).join('')
  }
  return out
}

/**
 * 落とすはずの定型文が、文面が変わって一致しなくなったことに気づくための記録。
 *
 * **固定付加文のコードが付いているのに、その文が原文の中に見つからない**ときだけ鳴らす。
 * 落ちなくなっても症状は「読まれるようになる」だけなので、記録が無いと気づく手掛かりが
 * どこにもない（`＊` 印の説明で実際にそうなっていた）。
 *
 * **落とす設定の項目だけを見る。** 読む側にしてある項目は一致しなくても構わない。
 * 自由付加文はコードを持たないので、この検出は掛からない（掛けられない）。
 */
export function warnUnmatchedBoilerplate(
  codes: readonly string[] | undefined,
  text: string | undefined,
  reads: TelegramBoilerplateReads,
  label: string,
): void {
  if (!codes?.length || !text) return
  for (const spec of TELEGRAM_BOILERPLATE_SPECS) {
    if (reads[spec.key] || !spec.codes) continue
    const code = spec.codes.find(c => codes.includes(c))
    if (!code) continue
    if (containsBoilerplate(spec, text)) continue
    boilerplateMismatchGate(`${label}:${spec.key}`, code, (overflowed) => {
      log.warn(
        `[tts] ${label} に固定付加文コード ${code} がありますが、読み上げから落とす文面（${spec.key}）と一致しません`
          + `（文面が変わった可能性があります。この報ではその文も読み上げます）${overflowed ? '（以後は間引きます）' : ''}`,
      )
    })
  }
}

/**
 * 長周期地震動の自由付加文が載せる「階級と現象表現の対応表」で、階級と現象表現のあいだに
 * 空白を挟む。原文は画面で表として読める形で、この 2 つのあいだに区切りを持たない。
 *
 * ```
 *  階級１やや大きな揺れ
 *  階級４極めて大きな揺れ
 * ```
 *
 * **声にすると一続きに聞こえる。** 合成エンジンはここをアクセント句の切れ目としか扱わず、
 * 間を置かない（実測）。
 *
 * **挟むのは空白であって読点ではない。** 合成エンジンが置く間はどちらも同じだが（実測:
 * 半角スペース・全角スペース・読点・句点のいずれも 0.389〜0.412 秒）、読点は
 * {@link splitIntoChunks} がチャンクを割る文字でもある。割れた末尾の間はチャンクを詰めて
 * 鳴らすための足し分（`CHUNK_BREAK_PAUSE` = 0.11 秒）に変わり、**文中の読点より短くなる**
 * （実機で確認）。空白なら割れないので、文中の間がそのまま入る。
 *
 * **鍵を「階級＋数字」だけにしないこと。** 同じ形は文中にも現れ（「長周期地震動階級４を
 * 観測した地域があります」）、そこへ読点を入れると助詞の前で文が切れる。対応表でしか
 * 使われない現象表現の語まで含めて照合する。
 *
 * 実電文の階級は全角数字（`階級４`）で、半角は観測できていない。それでも鍵に入れているのは、
 * 一致が増えても誤爆しない（現象表現の語との組でしか当たらない）ため。
 */
const LPGM_CLASS_TABLE_RE = /(階級[０-９0-9])(やや大きな揺れ|非常に大きな揺れ|極めて大きな揺れ|大きな揺れ)/g

/**
 * 気象庁が書いた文の日時表記を、読み上げの前に半角・ゼロ埋めなしへ揃える。
 *
 * 実電文は**全角でゼロ埋め**する（`１６日０１時２５分`）。合成エンジンは先頭の 0 を桁として
 * 読むため、そのままでは「ぜろ いちじ」になる（`００分` なら「ぜろ ぜろふん」）。
 * アプリが自分で組む読み上げ文はゼロ埋めしない（{@link formatDayTime}）ので、この崩れは
 * **気象庁の文を読む設定を入れたときだけ**起きる。
 *
 * **句区切り辞書では手当てできない。** あの辞書は文字列の一致で引くので、全角とゼロ埋めの
 * 組み合わせまで鍵に持つと日・時・分だけで数百件になる。ここで半角へ揃えておけば、辞書は
 * 半角の形（`17日`・`0時`）だけで足りる。
 *
 * **対象は「1〜2 桁の数字＋日／時／分」に限る。** マグニチュード・震度・波高の数値には触らない。
 * 単位が続く形（`2時間`・`10分の1`・`2日間`）も一致するが、半角へ直すだけで読みは変わらない。
 *
 * **直前が数字なら一致させない**（`(?<![0-9０-９])`）。これが無いと `{1,2}` が 3 桁以上の数字列の
 * **末尾 2 桁だけ**を拾い、桁を静かに落とす —— `１５０分後` が `１50分後`、`1000分の1` が
 * `100分の1` に化ける（半角でも起きる）。例外も NaN も出ないので、読み上げを聞くまで気づけない。
 */
const DATETIME_DIGITS_RE = /(?<![0-9０-９])([0-9０-９]{1,2})([日時分])/g

function normalizeDateTimeForSpeech(text: string): string {
  const halfWidth = text.replace(DATETIME_DIGITS_RE, (_match, digits: string, unit: string) => {
    const half = digits.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    return `${Number(half)}${unit}`
  })
  // **「1日」の読み直しもここに置く。** この関数を通る 3 経路（本文と付加文・津波観測情報の
  // 見出し文・取消の理由）すべてで同じ手当てが要る。片方だけに掛けると、同じ「気象庁が書いた文」
  // なのに読まれる場所によって「ついたち」と「いちにち」に分かれる。
  return speakableDayInText(halfWidth)
}

function normalizeTelegramTextForSpeech(text: string, reads: TelegramBoilerplateReads): string {
  return normalizeDateTimeForSpeech(stripUrlsForSpeech(stripBoilerplate(text, reads)))
    .replace(LPGM_CLASS_TABLE_RE, '$1 $2')
    .replace(/[\r\n\u3000\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    // 括弧ごと落とした跡に残る「〜 、」「〜 。」を詰める。句読点の顔ぶれは
    // `voicevox.ts` の `CHUNK_BREAK_PUNCTUATION`（チャンクを割る文字）と揃えておく
    .replace(/\s+([\u3001\u3002\uff01\uff1f\u300d\uff09)])/g, '$1')
    .trim()
}

/**
 * 読み上げから URL を落とす。
 *
 * **音声で URL を伝えても書き取れない。** 長周期地震動観測情報の自由付加文は末尾に詳細ページの
 * URL を持っており（`https://www.data.jma.go.jp/eew/data/ltpgm/event.php?eventId=…`）、そのまま
 * 渡すと合成エンジンが 1 文字ずつ読み上げる（実機で確認）。**原文は画面にそのまま出している**
 * ので、読み上げから落としても情報は失われない。
 *
 * **括弧で囲まれていれば括弧ごと落とす** —— URL だけ抜くと「ウェブサイト（）をご活用ください」と
 * 空の括弧が残り、それも音になる。
 *
 * **URL の終わりとみなす文字には、空白・丸括弧に加えて全角の句読点と和文の閉じ括弧も入れる。**
 * どれも URL の一部になりえないので、入れても URL を切り詰めることはない。入れないと、空白を
 * 挟まずに句点が続く本文（`…https://example.com/foo。続報があります。`）で句点まで巻き込んで
 * 消し、**2 つの文が 1 つに繋がる**。実電文の URL は前後に空白がある半角括弧の形なので現状
 * この形は来ないが、正規表現の側でその前提に頼らない。
 */
function stripUrlsForSpeech(text: string): string {
  return text
    .replace(/[\uff08(]\s*https?:\/\/[^\s\uff08\uff09()\u3001\u3002\uff01\uff1f\u300d\u300f\u3015]+\s*[\uff09)]/g, '')
    .replace(/https?:\/\/[^\s\uff08\uff09()\u3001\u3002\uff01\uff1f\u300d\u300f\u3015]+/g, '')
}

/** 空でないものだけを句点区切りで繋ぐ。既に句点で終わっているものは重ねない。 */
function joinTelegramTexts(
  parts: readonly (string | undefined)[],
  reads: TelegramBoilerplateReads,
): string {
  const kept = parts
    .map(t => (t ? normalizeTelegramTextForSpeech(t, reads) : ''))
    .filter(t => t.length > 0)
  if (kept.length === 0) return ''
  return kept.map(t => (/[。！？]$/.test(t) ? t : `${t}。`)).join('')
}

/**
 * 気象庁が書いた文を既読と照合する単位（1 文）。
 *
 * **鍵と読み上げの素材を分けて持つ。** 本文は電文の改行を空白へ直したもので
 * （`normalizeTelegramTextForSpeech`）、文と文のあいだにその空白が残る。鍵にまで含めると
 * 同じ文が位置によって別物になるので鍵は前後を削り、読み上げには空白ごと使って元の間を保つ。
 */
export interface TelegramTextUnit {
  /** 既読の照合に使う形（前後の空白を落とした 1 文）。 */
  readonly key: string
  /** 読み上げに使う形（後ろに続く空白まで含む。すべて繋ぐと元の本文に戻る）。 */
  readonly text: string
}

/** 文の終わりとみなす記号。`joinTelegramTexts` がブロックの末尾に足す「。」と揃える。 */
const SENTENCE_END = new Set(['。', '！', '？'])

/**
 * 気象庁が書いた文を、既読と照合できる単位（文）へ割る。
 *
 * **後読み（lookbehind）の正規表現を使わないこと。** 対応していない実行環境があり、
 * そこでは読み込みの時点で落ちる ―― 読み上げどころかアプリ全体が動かなくなる。
 *
 * 繋ぎ直したときに元の本文へ戻ることは `ttsText.telegramTextUnits.test.ts` が実データで固定する。
 */
export function splitTelegramTextUnits(body: string): TelegramTextUnit[] {
  const units: TelegramTextUnit[] = []
  let start = 0
  const push = (end: number) => {
    const text = body.slice(start, end)
    const key = text.trim()
    if (key.length > 0) units.push({ key, text })
    start = end
  }
  for (let i = 0; i < body.length; i++) {
    if (!SENTENCE_END.has(body[i])) continue
    // 句点に続く空白まで 1 単位へ入れる（繋ぎ直しても間が変わらないように）。
    let end = i + 1
    while (end < body.length && body[end] === ' ') end++
    push(end)
    i = end - 1
  }
  if (start < body.length) push(body.length)
  return units
}

/**
 * {@link telegramTextToSpeak} が返す読み上げ。
 *
 * **`topic` を本体の読み上げと同じにしないこと。** 同じ主題だと、到来順の裁き
 * （`overtakenByLaterArrival`）が本体の予約を取り下げてしまう ―― 本文を読むために
 * 肝心の震度を落とすことになる。
 */
export interface TelegramTextSpeech {
  /** 読み上げ文（前置き＋本文）。 */
  readonly text: string
  /** 前置きを除いた本文。**既読の照合は {@link units} で行う**（本文全体では下記の理由で粗すぎる）。 */
  readonly body: string
  /** 種別ごとの前置き。未読の文だけを読むときに繋ぎ直すために持つ。 */
  readonly prefix: string
  /**
   * 本文を文で割ったもの。**既読はこの単位で持つ。**
   *
   * 本文まるごとを鍵にすると、1 文が増減しただけで既に読んだ分まで読み直す。津波の避難行動の
   * 固定付加文は等級が動くたびに節が増減するため、能登半島地震（2024-01-01）の実電文では
   * 800 字超の同じ文が 3 回読まれていた（3 通目は 1 文も新しくない）。
   */
  readonly units: readonly TelegramTextUnit[]
}

/** 前置きと本文から {@link TelegramTextSpeech} を組む。本文が空なら読み上げない。 */
function telegramSpeech(prefix: string, body: string): TelegramTextSpeech | null {
  if (!body) return null
  return { text: `${prefix}${body}`, body, prefix, units: splitTelegramTextUnits(body) }
}

/**
 * 電文が運ぶ「気象庁が書いた文」を読み上げ文にする。設定で有効にしたときだけ中身を返す。
 *
 * **電文本体の読み上げへ足さず、別の発話として最下位の層で読むこと。**
 * 南海トラフ臨時情報の本文は実電文で 1055 字あり、読み上げは約 3 分に達する
 * （2024-08-08 の「巨大地震注意」。VOICEVOX の実測で 5.8 字/秒）。臨時情報は津波の等級発表と
 * 同じ最上位の層にいるので、本体へ足すと**地震情報が最大 90 秒待たされる**
 * （`HIGHER_PRIORITY_SPEECH_MAX_WAIT_MS`。あの上限は「合成エンジンが無応答のときだけ効く保険」
 * として置かれた値で、正常系で発火する前提になっていない）。最下位の層は「何も切らない」ことを
 * 保証しているので、そこへ置けば本来の情報を塞がない。
 *
 * **含めないもの**:
 * - 参考情報（`appendix`）—— 情報の種類を説明する固定文で、画面でも折りたたみに入れている
 * - 見出し文（`headline`）—— 型定義が「本文や既読の要素に無い事実は含まない」と断っており、
 *   読むと本体の読み上げと二度述べになる
 * - 取消電文の理由 —— 既に本体の読み上げが読んでいる（`cancelReasonSentence`）
 *
 * **どのブロックを読むかは設定で選べる**（`opts.telegramTextBlocks`。一覧は
 * {@link TELEGRAM_TEXT_BLOCK_KEYS}）。全部切れば本文が空になり、この関数は `null` を返す ——
 * 前置きだけが鳴る形にはならない。
 */
export function telegramTextToSpeak(event: LiveEvent, opts: TtsSpeechOptions): TelegramTextSpeech | null {
  // **緊急地震速報の固定付加文は読まない。** 秒を争うため、定型文を挟むと肝心の震度・地域が
  // 遅れる（画面には出している。→ eew-spec.md §3「固定付加文」）。
  // 読ませる形にするなら、この設定とは別に「震度・地域を伝えたあとへ確実に回す」仕組みが要る。
  if (event.kind === 'eew') return null
  if (!opts.readTelegramText) return null

  // **指定が無いブロックは読む側へ倒す。** 設定を足しただけで、これまで声になっていた文が
  // 黙って消えないようにするため（テストも 1 件ずつ指定しなくて済む）。
  const on = (key: TelegramTextBlockKey): boolean => opts.telegramTextBlocks?.[key] ?? true
  // **定型文の落とし方は既定が「落とす」側。** 向きが上の `on` と逆なのは、`＊` 印の説明が
  // この設定より前から無条件で落ちていたため（→ `TELEGRAM_BOILERPLATE_DEFAULT_READS`）。
  const reads = opts.telegramBoilerplate ?? TELEGRAM_BOILERPLATE_DEFAULT_READS
  /** 読むと決めたブロックだけを残す。 */
  const pick = (key: TelegramTextBlockKey, text: string | undefined) => (on(key) ? text : undefined)

  switch (event.kind) {
    case 'quake': {
      // 取消の報は理由を本体の読み上げが読む。付加文は添えない。
      // 見るのは `cancelled`（理由は上の EEW 分岐のコメント）。
      if (event.cancelled) return null
      // **落とし漏れの検出は、その枠を読む設定のときだけ。** 枠ごと切っているなら定型文も
      // 声にならないので、一致しなくても困らない。
      if (on('quakeVarComment')) {
        warnUnmatchedBoilerplate(event.varCommentCodes, event.varCommentText, reads, '地震情報の固定付加文（その他）')
      }
      const body = joinTelegramTexts([
        pick('quakeVarComment', event.varCommentText),
        pick('quakeFreeText', event.freeText),
      ], reads)
      return telegramSpeech(`地震情報について、気象庁の文をお伝えします。`, body)
    }
    case 'tsunami': {
      // 解除・失効・取消とも `cancelled` が立つ（理由は上の EEW 分岐のコメント）。
      if (event.cancelled) return null
      const body = joinTelegramTexts([
        pick('tsunamiBody', event.bodyText),
        // 固定付加文は主題ごとに複数ある（避難行動／満潮／沿岸の観測／沖合の観測）。
        // **1 つの設定でまとめて切る。** 主題を束ねる鍵（`TsunamiWarningComment.key`）は
        // 電文種別と情報名から実行時に導く値で、固定の一覧を持たない（→ tsunami-spec.md §5
        // 「固定付加文は主題ごとに束ねる」。あちらも「表示はしない」と断っている）。
        // 設定の項目にすると、気象庁が情報名の文字列を変えた版で対応が外れる。
        //
        // **避難行動の呼びかけは別経路が必ず読む**（`tsunamiToSegments`）ので、ここを切っても
        // 行動指示が声から消えることはない。
        ...(on('tsunamiVarComment') ? (event.warningComments ?? []).map(c => c.text) : []),
        pick('tsunamiFreeText', event.freeText),
      ], reads)
      return telegramSpeech(`津波情報について、気象庁の文をお伝えします。`, body)
    }
    case 'lpgm': {
      // **他の種別と同じく明示して弾く。** いまは取消のパースが付加文を 1 つも持たないので
      // 結果的に空になるが、それは呼び出し元（パーサー）の実装詳細であって、ここの意図
      // （取消では読まない）はコードから読み取れない。将来あちらが付加文を持つようになった
      // とき、この経路だけ黙って取消の本文を読む。
      if (event.data.cancelled) return null
      if (on('lpgmForecast')) {
        warnUnmatchedBoilerplate(event.data.forecastCodes, event.data.forecastText, reads, '長周期地震動観測情報の固定付加文')
      }
      if (on('lpgmVarComment')) {
        warnUnmatchedBoilerplate(event.data.varCommentCodes, event.data.varCommentText, reads, '長周期地震動観測情報の固定付加文（その他）')
      }
      const body = joinTelegramTexts([
        pick('lpgmForecast', event.data.forecastText),
        pick('lpgmVarComment', event.data.varCommentText),
        pick('lpgmFreeText', event.data.freeFormText),
      ], reads)
      return telegramSpeech(`長周期地震動観測情報について、気象庁の文をお伝えします。`, body)
    }
    case 'nankai':
    case 'nankaiCommentary': {
      if (event.data.cancelled) return null
      // 臨時情報と関連解説情報は構造が同じだが、**設定は別に持つ** —— 段階の発表（臨時情報）と
      // 状況の続報（解説情報）では、聞きたい度合いが違う。
      const isAdvisory = event.kind === 'nankai'
      const body = joinTelegramTexts([
        pick(isAdvisory ? 'nankaiSummary' : 'nankaiCommentarySummary', event.data.summary),
        pick(isAdvisory ? 'nankaiBody' : 'nankaiCommentaryBody', event.data.body),
        pick(isAdvisory ? 'nankaiNextAdvisory' : 'nankaiCommentaryNextAdvisory', event.data.nextAdvisory),
      ], reads)
      const label = isAdvisory ? '南海トラフ地震臨時情報' : '南海トラフ地震関連解説情報'
      return telegramSpeech(`${label}について、気象庁の文をお伝えします。`, body)
    }
    case 'kohatsu': {
      if (event.data.cancelled) return null
      // **`nextAdvisory` は読まない。** この種別の電文に `NextAdvisory` は無く（理由は
      // `TELEGRAM_TEXT_BLOCK_KEYS` の「北海道・三陸沖後発地震注意情報」）、共有の読み取りを
      // 通っているぶん型には残るが値は常に空。気象庁が出すようになったら設定キーと併せて戻す。
      const body = joinTelegramTexts([
        pick('kohatsuSummary', event.data.summary),
        pick('kohatsuBody', event.data.body),
      ], reads)
      return telegramSpeech(`北海道・三陸沖後発地震注意情報について、気象庁の文をお伝えします。`, body)
    }
    case 'earthquakeCount': {
      if (event.data.cancelled) return null
      const body = joinTelegramTexts([pick('earthquakeCountFreeText', event.data.freeText)], reads)
      return telegramSpeech(`地震回数に関する情報について、気象庁の文をお伝えします。`, body)
    }
    // 推計震度分布図は二進電文で、気象庁が書いた文を運ばない。
    case 'estimatedIntensity':
      return null
  }
}
