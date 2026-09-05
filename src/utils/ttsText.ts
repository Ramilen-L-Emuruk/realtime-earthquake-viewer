import type { EEWAlert, JMAQuake, JMATsunami, JMANankai, JMANankaiCommentary, JMAKohatsu, JMALpgm, IntensityScale, TsunamiGrade, TsunamiArea, EarthquakePoint, DomesticTsunami, TsunamiObservation, Hypocenter } from '../types/earthquake'
import { eewNoForecastReason, canPresentLpgmClass, type EewMaxScaleInfo } from './eew'
import { getIntensityLabel, getIntensityLabelWithOrAbove } from './intensity'
import { tsunamiMaxGrade, groupAreasForCardDisplay, sortAreasForCardDisplay, hasForecastHeight, compareObservedHeightDesc, overSuffixedHeight, TSUNAMI_GRADE_SHORT_LABEL, type TsunamiAreaGradeChange } from './tsunami'
import { joinSegments, plain, type SpeechSegment, type SpeechRef, type QuakeFact } from './ttsFollow'
import { getSubRegionsCache } from './subregions'
import { getPrefecturesCache } from './prefectures'
import { getStationCoordsCache, getAreaPrefIndexCache, buildStationPrefIndex, buildPrefAreaNamesIndex, buildRegionOrderIndex, regionOrderRank, sortByRegionOrder, lookupStationRegion, type StationCoordsData, type RegionOrderIndex } from './stationCoords'
import { isAreaPoint, isMaxScaleUnreceived, partitionUnreceivedPoints, unreceivedUnitLabel } from './quakePoints'
import { hasMagnitude, hasDepth } from './formatters'
import { createLogThrottle, log } from './logger'

const GRADE_ORDER: TsunamiGrade[] = ['MajorWarning', 'Warning', 'Watch', 'Forecast']

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

export interface TtsRegionOptions {
  intensityLevels: number   // 最大震度に加えて何階級下まで読むか（0 = 最大のみ。観測がある階級だけを数える）
  maxRegions: number        // 読み上げる最大地域数（0 = 無制限）
  alwaysReadScale: number   // 階数を超えても読み上げる下限震度（-1 = 無効。長周期地震動には適用しない）
  regionTolerance: number   // maxRegions をこの数まで超える場合は省略せず全地域を読む（0 = 無効）
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
  opts: TtsRegionOptions,
  hypocenter: { latitude: number; longitude: number } | undefined,
  regionOrder: RegionOrderIndex | null,
): { names: string[]; omittedCount: number } {
  // 震源位置が使えるか。0 は座標未設定、-200 は「位置不明」センチネル（震度速報のように震源を
  // 持たない電文で入る。p2pquake.ts / dmdataParser.ts 参照）。どちらも距離の基準にはできない。
  // -200 を弾かないと、地球上に存在しない点からの距離で地域を選ぶことになる。
  const hasEpicenter = hypocenter != null
    && hypocenter.latitude > -200 && hypocenter.longitude > -200
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
  let omittedCount = 0
  if (opts.maxRegions > 0 && picked.length > opts.maxRegions + opts.regionTolerance) {
    omittedCount = picked.length - opts.maxRegions
    picked = picked.slice(0, opts.maxRegions)
  }
  // 安定ソートなので、震源が無い経路（既に地理順）ではここは何も動かさない。
  return { names: sortByRegionOrder(picked, regionOrder), omittedCount }
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
  opts: TtsRegionOptions,
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

  // 地点名で読み、地点で覆えない区域・県だけを区域名で補う（規則は `partitionUnreceivedPoints`）。
  const regionOfStation = (p: EarthquakePoint): string | null => {
    const pref = p.pref || idx.stationPrefIndex?.get(p.addr) || ''
    return pref && idx.stationData ? lookupStationRegion(idx.stationData, pref, p.addr) : null
  }
  const { stations, areas } = partitionUnreceivedPoints(points, p => [
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
  // **選抜と上限は観測値の文と同じ規則に乗せる**（`selectRegionNames`）。独自に切ると、
  // 「無制限」の設定で 1 件しか読まれない・省いた件数を伝えない、といったずれが片側にだけ出る。
  const { names, omittedCount } = selectRegionNames(unspoken, opts, hypocenter, regionOrder)
  if (names.length === 0) return []
  const segments: SpeechSegment[] = []
  names.forEach((name, i) => {
    if (i > 0) segments.push(plain('、'))
    segments.push({ text: name, refs: [{ kind: 'quakeRegion', name, scale: 45, unreceived: true }] })
  })
  if (omittedCount > 0) segments.push(plain(`、ほか${omittedCount}${unit}`))
  // **推定の理由まで言う。** 「5弱以上と推定されます」だけだと、なぜ推定なのかが伝わらない。
  // 語は気象庁の「未入電」をそのまま使い、画面のバッジ（「未入電あり」）とも揃える ——
  // 聞いた語で画面を探せるように。
  segments.push(plain('では、震度5弱以上と推定されますが、震度は未入電です。'))
  return segments
}

function buildRegionSegments(
  points: EarthquakePoint[],
  maxScale: IntensityScale,
  opts: TtsRegionOptions,
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
      const omittedCount = picked.omittedCount
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
      if (omittedCount > 0) segments.push(plain(`、ほか${omittedCount}地域`))
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
 * 「〇〇を震源とする」の深さ部分を返す（Destination/ScaleAndDestination 系）。
 * 表示側 formatDepth と判定を揃える（負値 = 不明 / 0 = ごく浅い）。負値では空文字を返す。
 * 深さ不明の電文は遠地地震で頻出し（`depth: {value: null, condition: "不明"}`）、
 * パーサはこれを -1 センチネルに落とすため、0 と同一視すると「ごく浅い場所」と誤読する。
 */
function depthSourcePhrase(depth: number): string {
  if (!hasDepth(depth)) return ''
  return depth === 0 ? 'ごく浅い場所' : `深さ${depth}キロメートル`
}

/** 「震源の深さ〇〇」の〇〇部分を返す（顕著な地震の震源要素更新のお知らせ 系）。深さ不明では空文字。 */
function depthAmendPhrase(depth: number): string {
  if (!hasDepth(depth)) return ''
  return depth === 0 ? '震源の深さはごく浅く' : `震源の深さ${depth}キロメートル`
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
    ? `最大震度${label}以上と推定されますが、震度は未入電です。`
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

function formatTime(isoTime: string): string {
  const d = new Date(isoTime)
  // 分をゼロ埋めすると VOICEVOX が「06分」を「ぜろろくふん」と桁読みしてしまうため、
  // TTS 用テキストではゼロ埋めしない（表示用の formatters.ts の formatTime とは別）
  return `${d.getHours()}時${d.getMinutes()}分`
}

/**
 * 「10日21時34分」形式。遠地地震は発表が発生から数十分後になることがあり、
 * 日付をまたいで受信する場合があるため日から読み上げる。
 */
function formatDayTime(isoTime: string): string {
  return `${new Date(isoTime).getDate()}日${formatTime(isoTime)}`
}

/** VXSE43/45 EEW キャンセル（誤報取消）の読み上げテキストを生成する。 */
export function eewCancelToText(event: EEWAlert): string {
  const time = event.issue?.time ? formatTime(event.issue.time) : null
  return time
    ? `${time}に発表された緊急地震速報はキャンセルされました。`
    : '緊急地震速報はキャンセルされました。'
}

/**
 * VXSE51/52/53/61 地震情報取消の読み上げテキストを生成する。
 * time は取消電文自体の発表時刻ではなく、同一 eventId で最後に受信した地震情報の発表時刻を渡すこと
 * （呼び出し側 useLiveEventHandler.ts で解決する）。
 */
export function earthquakeCancelToText(time: string | null): string {
  const formatted = time ? formatTime(time) : null
  if (formatted) return `${formatted}に発表された地震情報はキャンセルされました。`
  return '地震情報はキャンセルされました。'
}

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
    return `予想最大震度${getIntensityLabelWithOrAbove(scaleInfo.scale, scaleInfo.orAbove)}。`
  }
  return noForecastText(event)
}

/**
 * 長周期地震動階級部分だけの読み上げ文（「予想最大階級〇。」）。0 なら空文字列
 * （句ごと省く。音声には地図の色フォールバックのような逃げ場が無く、不正値がそのまま
 * 声に出るのを避けるため）。
 */
export function eewLpgmOnlyText(lpgmClass: number): string {
  return lpgmClass > 0 ? `予想最大階級${lpgmClass}。` : ''
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
): string {
  const prefix = announceUpgrade ? '緊急地震速報に切り替わりました。' : ''
  // 上限が定まらない報（仮定震源要素の初報など）は「震度4以上」と読む。値だけ読むと
  // 下限を断定した放送になる（判定は eewMaxScaleInfo・語の付け方は表示と共通）。
  //
  // **震度を伝えられないときは階級も読まない**（判定は `canPresentLpgmClass`。カード表示・
  // 第 2 フェーズの言い直しと同じ述語を共有する。理由はそちらのコメント）。
  const scaleText = eewScaleOnlyText(scaleInfo, event)
  const lpgmText = canPresentLpgmClass(scaleInfo.scale, lpgmClass) ? eewLpgmOnlyText(lpgmClass) : ''
  return prefix + scaleText + lpgmText
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
function quakeOccurrenceSegments(hypocenter: Hypocenter): SpeechSegment[] {
  const tellable = tellableHypocenterFacts(hypocenter)
  const segments: SpeechSegment[] = []
  if (tellable.has('hypocenterName')) {
    segments.push({ text: hypocenter.name, refs: [{ kind: 'quakeFact', fact: 'hypocenterName', value: hypocenter.name }] })
    if (tellable.has('depth')) {
      segments.push(plain('、'))
      segments.push({ text: depthSourcePhrase(hypocenter.depth), refs: [{ kind: 'quakeFact', fact: 'depth', value: String(hypocenter.depth) }] })
    }
    segments.push(plain('を震源とする'))
  }
  if (tellable.has('magnitude')) {
    segments.push({ text: magnitudePhrase(hypocenter.magnitude), refs: [{ kind: 'quakeFact', fact: 'magnitude', value: magnitudeText(hypocenter.magnitude) }] })
  }
  segments.push(plain('地震が発生しました。'))
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
function tellableHypocenterFacts(hypocenter: Hypocenter): Set<QuakeFact> {
  const facts = new Set<QuakeFact>()
  if (hypocenter.name) {
    facts.add('hypocenterName')
    if (depthSourcePhrase(hypocenter.depth)) facts.add('depth')
  }
  if (magnitudePhrase(hypocenter.magnitude)) facts.add('magnitude')
  return facts
}

/**
 * 上に津波区分を足した、この電文が声にしうる事実の全体。
 *
 * **`maxScaleOnly` はここに載せない。** これは「地域名を作れなかったときの代替」であって
 * 電文が普通に伝える事実ではない。載せると `hasUnspokenFact` が常に真を返し、地域名を作れる
 * 正常な地震でも差分の経路に入らなくなる（毎報が全文になる）。
 */
function tellableFacts(event: JMAQuake): Set<QuakeFact> {
  const facts = tellableHypocenterFacts(event.earthquake.hypocenter)
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
function hasUnspokenFact(event: JMAQuake, spoken: QuakeSpokenState): boolean {
  return [...tellableFacts(event)].some(fact => !spoken.facts.has(fact))
}

/**
 * 続報で「値が変わった震源要素」だけを言い直す断片列を作る。変化が無ければ空。
 *
 * **震度速報では呼ばないこと。** 震度速報は震源要素も津波区分も伝えない電文で、
 * `hypocenter` はセンチネル（`-200` / `-1`）、`domesticTsunami` は「調査中」が入る。
 * 素直に比べると、震源情報で伝えた「津波の心配はありません」から変化したと誤検出し、
 * 続報のたびに「津波の有無を調査中です」と言い出す。
 */
function changedFactSegments(event: JMAQuake, spoken: QuakeSpokenState): SpeechSegment[] {
  const { hypocenter, domesticTsunami } = event.earthquake
  const tellable = tellableFacts(event)
  const segments: SpeechSegment[] = []
  // 声にしうる事実のうち、記録と値が違うものだけ。未記録がここへ来ることは無い
  // （呼び出し前に {@link hasUnspokenFact} で弾き、初報と同じ形で言い直す側へ回している）。
  // `has` の判定はその保証が崩れたときの安全弁として残す。
  const changed = (fact: QuakeFact, value: string): boolean =>
    tellable.has(fact) && spoken.facts.has(fact) && spoken.facts.get(fact) !== value

  if (changed('hypocenterName', hypocenter.name)) {
    segments.push({ text: `震源は${hypocenter.name}に更新されました。`, refs: [{ kind: 'quakeFact', fact: 'hypocenterName', value: hypocenter.name }] })
  }
  if (changed('magnitude', magnitudeText(hypocenter.magnitude))) {
    const value = magnitudeText(hypocenter.magnitude)
    segments.push({ text: `マグニチュードは${value}に更新されました。`, refs: [{ kind: 'quakeFact', fact: 'magnitude', value }] })
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
 * VXSE51/52/53/61 地震情報の読み上げを断片列で生成する。
 * isNew=false のとき更新報として冒頭に通知する。
 *
 * `spoken` を渡すと**続報は差分だけを読む**（既に声になった区域・震源要素を省く）。
 * 省略すると全文を組み立てる（{@link earthquakeToText} 経由の呼び出し）。
 *
 * 差分が空になったときは**空配列を返す＝読み上げない**。ただしその地震について一度も何も
 * 声にしていない場合は黙らない（最大震度だけでも伝える）。
 */
export function earthquakeToSegments(
  event: JMAQuake,
  opts: TtsRegionOptions,
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
    // 聞こえない。「更新されました」だけで終われば、変化が無かったことが対比で伝わる
    // （docs/spec/audio-tts-spec.md §4）。
    return [plain(prefix), ...fallback]
  }

  const time = formatTime(event.earthquake.time)

  if (type === '顕著な地震の震源要素更新のお知らせ') {
    // この電文（VXSE61）は震源要素の更新のみを伝え、津波の有無は含まない。
    // 津波情報は別電文（VTSE41/51/52）で発表されるため、ここでは読み上げない。
    //
    // **差分を取らない。** 「更新されたこと」自体が電文の主旨なので、値が既に声になっていても
    // 省かない。ただし読んだ値は記録する（記録しないと、後続の続報が同じ値を「更新」と言い直す）。
    const amended: SpeechSegment[] = []
    const depth = depthAmendPhrase(hypocenter.depth)
    if (depth) amended.push({ text: depth, refs: [{ kind: 'quakeFact', fact: 'depth', value: String(hypocenter.depth) }] })
    if (hasMagnitude(hypocenter.magnitude)) {
      const value = magnitudeText(hypocenter.magnitude)
      if (amended.length > 0) amended.push(plain('、'))
      amended.push({ text: `マグニチュード${value}`, refs: [{ kind: 'quakeFact', fact: 'magnitude', value }] })
    }
    const head = plain(`顕著な地震の震源要素更新のお知らせ。${time}頃発生した${hypocenter.name}の地震について、`)
    // 深さ・規模とも不明なら要素を並べられないため、更新があった事実だけを伝える。
    return amended.length > 0
      ? [head, ...amended, plain('に更新されました。')]
      : [head, plain('震源要素が更新されました。')]
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
    return [
      plain(`${prefix}${formatDayTime(event.earthquake.time)}頃、`),
      ...quakeOccurrenceSegments(hypocenter),
      tail,
    ]
  }

  const isEpicenterOnly = type === '震源情報' || type === 'その他'
  const label = isEpicenterOnly ? '震源情報' : '地震情報'

  // 続報は変化したところだけを読む。震源要素・津波区分・震度の地域のいずれにも変化が
  // 無ければ**名乗りだけで終える**（黙らない。理由は下の `return` のコメント）。
  // まだ声にしていない震源要素があるなら差分にしない（理由は `hasUnspokenFact`）。
  if (!isNew && spoken && saidSomething && !hasUnspokenFact(event, spoken)) {
    const facts = changedFactSegments(event, spoken)
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
    return [plain(`${label}が更新されました。`), ...facts, ...regionSegs, ...unreceivedSegs, ...fallback]
  }

  const prefix = isNew ? `${label}。` : `${label}が更新されました。`
  const segments: SpeechSegment[] = [
    plain(`${prefix}${time}頃、`),
    ...quakeOccurrenceSegments(hypocenter),
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

/** VXSE51/52/53/61 地震情報の読み上げテキストを生成する。isNew=false のとき更新報として冒頭に通知する。 */
export function earthquakeToText(event: JMAQuake, opts: TtsRegionOptions, isNew: boolean): string {
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
  // 波高がまだ付いていない（続報で後から付く）場合は、区域名を直接挙げる
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
export function tsunamiCancelToText(cancelReason: JMATsunami['cancelReason']): string {
  if (cancelReason === 'retracted') return '津波警報等は誤って発表されたため取り消されました。'
  if (cancelReason === 'expired') return '津波予報の有効期間が終了しました。'
  return '津波警報等は全て解除されました。'
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
  return [...obs].sort((a, b) => compareObservedHeightDesc(a.height!, b.height!)).slice(0, maxPoints)
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
  // headline の全角数字・全角ｍ・全角ピリオドを半角に変換して VOICEVOX の誤読を防ぐ
  const headlinePart = headline?.trim() ? tsunamiHeightToSpeech(headline.trim()) : ''
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
  return obs.slice(0, maxPoints)
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
  return obs.slice(0, maxPoints)
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
function buildLpgmRegionText(lpgm: JMALpgm, opts: TtsRegionOptions): string {
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
export function lpgmToText(lpgm: JMALpgm, opts: TtsRegionOptions, isNew: boolean): string {
  if (lpgm.cancelled) {
    return '長周期地震動情報はキャンセルされました。'
  }
  const time = formatTime(lpgm.originTime)
  const prefix = isNew ? '長周期地震動情報。' : '長周期地震動情報が更新されました。'
  const regionText = buildLpgmRegionText(lpgm, opts)
  if (regionText) {
    return `${prefix}${time}頃発生した地震で、長周期地震動${regionText}`
  }
  return `${prefix}${time}頃発生した地震で、長周期地震動階級${lpgm.maxClass}を観測しました。`
}

export { tsunamiMaxGrade }
