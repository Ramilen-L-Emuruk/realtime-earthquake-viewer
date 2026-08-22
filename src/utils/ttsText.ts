import type { EEWAlert, JMAQuake, JMATsunami, JMANankai, JMANankaiCommentary, JMAKohatsu, JMALpgm, IntensityScale, TsunamiGrade, TsunamiArea, EarthquakePoint, DomesticTsunami, TsunamiObservation, Hypocenter } from '../types/earthquake'
import { eewMaxScaleInfo, eewMaxLpgmClass, eewNoForecastReason } from './eew'
import { getIntensityLabel, getIntensityLabelWithOrAbove } from './intensity'
import { tsunamiMaxGrade, groupAreasForCardDisplay, sortAreasForCardDisplay, hasForecastHeight } from './tsunami'
import { joinSegments, plain, type SpeechSegment } from './ttsFollow'
import { getSubRegionsCache } from './subregions'
import { getPrefecturesCache } from './prefectures'
import { getStationCoordsCache, buildAreaPrefIndex, buildStationPrefIndex, buildPrefAreaNamesIndex, buildRegionOrderIndex, type RegionOrderIndex } from './stationCoords'
import { hasMagnitude, hasDepth } from './formatters'
import { log } from './logger'

const GRADE_ORDER: TsunamiGrade[] = ['MajorWarning', 'Warning', 'Watch', 'Forecast']

function tsunamiGradeLabel(grade: TsunamiGrade): string {
  switch (grade) {
    case 'MajorWarning': return '大津波警報'
    case 'Warning':      return '津波警報'
    case 'Watch':        return '津波注意報'
    case 'Forecast':     return '津波予報'
    default:              return ''
  }
}

// 震度スケールの降順リスト
const SCALE_DESCENDING: IntensityScale[] = [70, 60, 55, 50, 45, 40, 30, 20, 10] as IntensityScale[]

// 県内の一次細分区域が全部同じ階級で揃っている場合、区域名の列挙を「〇〇県」1件にまとめる。
// DMDATA JSON 電文由来の区域点は pref が空文字（dmdataParser.ts 参照）のため、
// areaPrefIndex（区域名→県名の逆引き）で補完してからグルーピングする。
// prefAreaNames が引けない（未読み込み）場合はまとめず区域名をそのまま返す。
function aggregateAreaNamesByPref(
  areaNames: { pref: string; addr: string }[],
  prefAreaNames: Map<string, Set<string>> | null,
  areaPrefIndex: Map<string, string> | null,
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
    if (isWholePref) result.push(pref)
    else result.push(...names)
  }
  return result
}

function regionNamesForScale(
  points: EarthquakePoint[],
  scale: IntensityScale,
  prefAreaNames: Map<string, Set<string>> | null,
  areaPrefIndex: Map<string, string> | null,
  stationPrefIndex: Map<string, string> | null,
): string[] {
  const matched = points.filter(p => p.scale === scale)
  const areaPoints = matched.filter(p => p.isArea && p.addr !== p.pref)
  if (areaPoints.length > 0) return aggregateAreaNamesByPref(areaPoints, prefAreaNames, areaPrefIndex)
  // QUAKE-2 で XML 経路の観測点も pref: '' になったため、pref が空でも observation の
  // addr から都道府県を逆引きしてフォールバックする（既存の areaPrefIndex 相当を観測点にも適用）。
  const prefs = matched.map(p => p.pref || stationPrefIndex?.get(p.addr) || '')
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
 * 地域名を気象庁の標準順（北から南。同じ県の区域は隣り合う）に並べ替える。
 * 震源からの距離順だと同じ県の同じ震度でも間に他県が挟まり、聞いて位置を掴みにくいため。
 *
 * 索引に載っていない名前（震度観測点を持たない区域など）は元の順序を保ったまま末尾へ回す。
 * 索引そのものが無い（座標テーブル未読み込み）ときは並べ替えず、呼び出し元が作った順を通す。
 */
function sortByRegionOrder(names: string[], order: RegionOrderIndex | null): string[] {
  if (!order) return names
  // 区域名を先に引く（県名と同名の区域があっても、より具体的な区域の順位を採る）。
  // 未知の名前どうしの比較で NaN を出さないよう、番兵は減算可能な有限値にする。
  const rank = (name: string) =>
    order.areas.get(name) ?? order.prefs.get(name) ?? Number.MAX_SAFE_INTEGER
  return [...names].sort((a, b) => rank(a) - rank(b))
}

export interface TtsRegionOptions {
  intensityLevels: number   // 最大震度に加えて何階級下まで読むか（0 = 最大のみ。観測がある階級だけを数える）
  maxRegions: number        // 読み上げる最大地域数（0 = 無制限）
  alwaysReadScale: number   // 階数を超えても読み上げる下限震度（-1 = 無効。長周期地震動には適用しない）
  regionTolerance: number   // maxRegions をこの数まで超える場合は省略せず全地域を読む（0 = 無効）
}

function buildRegionText(
  points: EarthquakePoint[],
  maxScale: IntensityScale,
  opts: TtsRegionOptions,
  hypocenter?: { latitude: number; longitude: number },
): string {
  const maxIdx = SCALE_DESCENDING.indexOf(maxScale)
  if (maxIdx < 0) return ''

  // 震源位置が使えるか。0 は座標未設定、-200 は「位置不明」センチネル（震度速報のように震源を
  // 持たない電文で入る。p2pquake.ts / dmdataParser.ts 参照）。どちらも距離の基準にはできない。
  // -200 を弾かないと、地球上に存在しない点からの距離で地域を選ぶことになる。
  const hasEpicenter = hypocenter != null
    && hypocenter.latitude > -200 && hypocenter.longitude > -200
    && (hypocenter.latitude !== 0 || hypocenter.longitude !== 0)
  const stationData = getStationCoordsCache()
  const prefAreaNames = stationData ? buildPrefAreaNamesIndex(stationData) : null
  const areaPrefIndex = stationData ? buildAreaPrefIndex(stationData) : null
  const stationPrefIndex = stationData ? buildStationPrefIndex(stationData) : null
  const regionOrder = stationData ? buildRegionOrderIndex(stationData) : null

  // 最大震度以下で実際に観測がある階級だけを降順に集める。震度スケール上の位置ではなく
  // この配列の添字を「最大から何階級目か」として数えるため、観測 0 地域の階級が読み上げ枠を
  // 空費して下の階級に届かなくなることがない（長周期地震動側の数え方と揃えている）。
  const observed: { scale: IntensityScale; names: string[] }[] = []
  for (let i = maxIdx; i < SCALE_DESCENDING.length; i++) {
    const scale = SCALE_DESCENDING[i]
    const names = regionNamesForScale(points, scale, prefAreaNames, areaPrefIndex, stationPrefIndex)
    if (names.length > 0) observed.push({ scale, names })
  }

  const parts: string[] = []
  const mentioned = new Set<string>()  // 上位階で読み上げ済みの地域名
  for (let rank = 0; rank < observed.length; rank++) {
    const { scale, names: observedNames } = observed[rank]
    // 設定した階数以内、または「必ず読み上げる震度」以上の階級を読む。どちらの条件も上位の
    // 階級ほど成立しやすいため、両方を外れた時点で以降の階級も必ず外れる（break で打ち切れる）。
    const withinLevels = rank <= opts.intensityLevels
    const withinAlwaysRead = opts.alwaysReadScale >= 0 && scale >= opts.alwaysReadScale
    if (!withinLevels && !withinAlwaysRead) break
    let names = observedNames.filter(n => !mentioned.has(n))
    if (names.length === 0) continue
    // 上限で切るときに残す地域は震源に近い順で選ぶ（読み上げる順序ではなく「どれを読むか」の選抜）。
    // 地理順のまま先頭から切ると、震源から遠い北側の地域が枠を占め、震源直近が「ほかN地域」に
    // 潰されうる。
    if (hasEpicenter) {
      names = [...names].sort((a, b) => {
        const ca = coordForName(a)
        const cb = coordForName(b)
        if (!ca && !cb) return 0
        if (!ca) return 1
        if (!cb) return -1
        return distSq(hypocenter!.latitude, hypocenter!.longitude, ca[0], ca[1])
             - distSq(hypocenter!.latitude, hypocenter!.longitude, cb[0], cb[1])
      })
    } else {
      // 震源が無い電文（震度速報）では距離で選べない。先に地理順へ整えてから切り、
      // 「北から上限まで」という説明できる選抜にする（電文の並びに結果を委ねない）。
      names = sortByRegionOrder(names, regionOrder)
    }
    // 上限をわずかに超えるだけなら、省いた地域名より「ほかN地域」の方が長くなる。許容超過
    // (regionTolerance) の範囲内は省略せず全地域を読む。超えた場合に切る位置は上限ちょうど。
    let omittedCount = 0
    if (opts.maxRegions > 0 && names.length > opts.maxRegions + opts.regionTolerance) {
      omittedCount = names.length - opts.maxRegions
      names = names.slice(0, opts.maxRegions)
    }
    // 選抜が済んでから読み上げ順（地理順）に組み直す。震源が無い経路では上で既に地理順に
    // 整っているため、ここは何も動かさない（安定ソートなので通しても順序は変わらない）。
    names = sortByRegionOrder(names, regionOrder)
    names.forEach(n => mentioned.add(n))
    const omittedSuffix = omittedCount > 0 ? `、ほか${omittedCount}地域` : ''
    parts.push(`${parts.length === 0 ? '最大' : ''}震度${intensityText(scale)}を${names.join('、')}${omittedSuffix}`)
  }

  if (parts.length === 0) return ''
  // 助詞「で」は末尾（述語の直前）にだけ置く。階級ごとの句末に付けると
  // 「〜福島県で、震度3を〜」と一文字が読点で挟まれ、読み上げがぶつ切りに聞こえる。
  // 複数階級のときは前の句が末尾の「で」を共有する形（並列句の格助詞の共有）になる。
  return parts.join('、') + 'で観測しました。'
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
 * 「〇〇、深さ120キロメートル」のように震源名と深さを繋いだ句を返す（「〜を震源とする」に続ける）。
 * 深さ不明のときは深さ句ごと省いて震源名だけを返す。震源名が無ければ空文字。
 */
function hypocenterPhrase(hypocenter: { name: string; depth: number }): string {
  const depth = depthSourcePhrase(hypocenter.depth)
  if (!hypocenter.name) return ''
  return depth ? `${hypocenter.name}、${depth}` : hypocenter.name
}

/**
 * 「〇〇、深さ120キロメートルを震源とするマグニチュード7.1の地震が発生しました。」を組み立てる。
 * 震源名・深さ・規模のいずれが欠けても文が破綻しないよう、欠けた要素は句ごと省く。
 * 震源名が取れない電文（パース異常）では震源に触れず規模だけを伝える文になる。
 */
function quakeOccurrenceText(hypocenter: Hypocenter): string {
  const source = hypocenterPhrase(hypocenter)
  const mag = magnitudePhrase(hypocenter.magnitude)
  return source
    ? `${source}を震源とする${mag}地震が発生しました。`
    : `${mag}地震が発生しました。`
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
 * EEW 第2フェーズ（予想値）の読み上げテキストを生成する。初報・続報の区別なく同じ形で読む。
 * 予想震度が取れないときは理由付きで「予想震度なし。」。
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
 */
export function eewIntensityToText(event: EEWAlert, announceUpgrade = false): string {
  let text = announceUpgrade ? '緊急地震速報に切り替わりました。' : ''
  // 上限が定まらない報（単独観測点処理の初報など）は「震度4以上」と読む。値だけ読むと
  // 下限を断定した放送になる（判定は eewMaxScaleInfo・語の付け方は表示と共通）。
  const { scale, orAbove } = eewMaxScaleInfo(event)
  if (scale > 0) {
    text += `予想最大震度${getIntensityLabelWithOrAbove(scale, orAbove)}。`
  } else {
    text += noForecastText(event)
  }
  // 階級も震度と同じく集約関数を通す（判定条件は eewMaxLpgmClass の JSDoc 参照）。0 のときは
  // 句ごと省く。音声には地図の色フォールバックのような逃げ場が無く、不正値がそのまま声に出るため。
  // ただし同関数が 0 を返すのは仮定震源要素のときだけで、noForecastText の 'deep'（深発地震）とは
  // 連動しない。深発地震で震度だけ出ない場合は「予想震度なし」と階級の断言が同居しうる
  // （未対応の既知の限界。docs/spec/eew-spec.md §4）。
  const lpgmClass = eewMaxLpgmClass(event)
  if (lpgmClass > 0) {
    text += `予想最大階級${lpgmClass}。`
  }
  return text
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

/** VXSE51/52/53/61 地震情報の読み上げテキストを生成する。isNew=false のとき更新報として冒頭に通知する。 */
export function earthquakeToText(event: JMAQuake, opts: TtsRegionOptions, isNew: boolean): string {
  const { hypocenter, maxScale, domesticTsunami } = event.earthquake
  const type = event.issue.type

  if (type === '震度速報') {
    const prefix = isNew ? '震度速報。' : '震度速報が更新されました。'
    const regionText = buildRegionText(event.points, maxScale, opts, hypocenter)
    return `${prefix}${regionText || `最大震度${intensityText(maxScale)}を観測しました。`}`
  }

  const time = formatTime(event.earthquake.time)

  if (type === '顕著な地震の震源要素更新のお知らせ') {
    // この電文（VXSE61）は震源要素の更新のみを伝え、津波の有無は含まない。
    // 津波情報は別電文（VTSE41/51/52）で発表されるため、ここでは読み上げない。
    const amended = [
      depthAmendPhrase(hypocenter.depth),
      hasMagnitude(hypocenter.magnitude) ? `マグニチュード${magnitudeText(hypocenter.magnitude)}` : '',
    ].filter(Boolean).join('、')
    const head = `顕著な地震の震源要素更新のお知らせ。${time}頃発生した${hypocenter.name}の地震について、`
    // 深さ・規模とも不明なら要素を並べられないため、更新があった事実だけを伝える。
    return amended ? `${head}${amended}に更新されました。` : `${head}震源要素が更新されました。`
  }

  if (type === '遠地地震') {
    // 気象庁「遠地地震に関する情報」（VXSE53・Head/Title で識別）。国外の規模の大きな地震を
    // 日本への津波影響とあわせて伝える電文で、国内震度は伴わない（maxScale は常に -1）。
    const prefix = isNew ? '遠地地震に関する情報。' : '遠地地震に関する情報が更新されました。'
    const text = `${prefix}${formatDayTime(event.earthquake.time)}頃、${quakeOccurrenceText(hypocenter)}`
    // 付加文の原文を優先する。遠地地震は 022x/023x 系の付加文を併用するため、
    // domesticTsunami（021x 系の区分）へ丸めると意味が落ちる。
    // 原文を持たない経路（P2PQuake）は従来どおり区分から文を起こす。
    return text + (event.forecastText || domesticTsunamiText(domesticTsunami))
  }

  if (type === '震源情報' || type === 'その他') {
    const prefix = isNew ? '震源情報。' : '震源情報が更新されました。'
    let text = `${prefix}${time}頃、${quakeOccurrenceText(hypocenter)}`
    text += domesticTsunamiText(domesticTsunami)
    return text
  }

  // ScaleAndDestination / DetailScale
  const prefix = isNew ? '地震情報。' : '地震情報が更新されました。'
  let text = `${prefix}${time}頃、${quakeOccurrenceText(hypocenter)}`

  text += domesticTsunamiText(domesticTsunami)

  const regionText = buildRegionText(event.points, maxScale, opts, hypocenter)
  if (regionText) {
    text += regionText
  }

  return text
}

/**
 * 波高の表記を読める形にする。"３ｍ" → "3メートル"、"10m以上" → "10メートル以上"、
 * "０．５ｍ" → "0.5メートル" など。
 *
 * **全角と半角の両方が来る。** 経路によって表記が違う（XML 履歴は全角、JSON は半角）ため、
 * どちらか片方だけを変換すると素通りした側が「えむ」と読まれる。
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

/** VTSE41/51/52 津波情報（新規発表・引き上げ）の読み上げを断片列で返す。 */
export function tsunamiToSegments(event: JMATsunami): SpeechSegment[] {
  const topGrade = GRADE_ORDER.find(g => event.areas.some(a => a.grade === g))
  if (!topGrade) return []

  const observations = event.observations ?? []
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

export function tsunamiToText(event: JMATsunami): string {
  return joinSegments(tsunamiToSegments(event))
}

/** VTSE41/51/52 津波情報 引き下げ時の読み上げを断片列で返す。 */
export function tsunamiDowngradeToSegments(event: JMATsunami): SpeechSegment[] {
  const topGrade = GRADE_ORDER.find(g => event.areas.some(a => a.grade === g))
  if (!topGrade) return [plain(tsunamiCancelToText(event.cancelReason))]

  const observations = event.observations ?? []
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
export function tsunamiDowngradeToText(event: JMATsunami): string {
  return joinSegments(tsunamiDowngradeToSegments(event))
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

// 波高つきの 1 地点ぶん（地点名は呼び出し側が断片にするので、それに続く部分だけを返す）。
// 単位の読み替えは予想波高と同じ関数に通す（全角・半角の扱いを 2 か所に分けない）。
function observedHeightSuffix(o: TsunamiObservation): string {
  return `で${tsunamiHeightToSpeech(o.height!.description)}`
}

function tsunamiObservationDetailText(items: TsunamiObservation[]): string {
  return joinSegments(observationDetailSegments(items, observedHeightSuffix))
}

/** VTSE41/51/52 津波観測情報 読み上げテキストを生成する（波高の大きい順に上位 maxPoints 件）。 */
export function tsunamiObservationToText(event: JMATsunami, maxPoints = 5): string {
  const obs = (event.observations ?? []).filter(o => o.height !== undefined)
  if (obs.length === 0) return ''
  const sorted = [...obs].sort((a, b) => b.height!.value - a.height!.value).slice(0, maxPoints)
  const total = obs.length
  // headline の全角数字・全角ｍ・全角ピリオドを半角に変換して VOICEVOX の誤読を防ぐ
  const rawHeadline = event.headline ? event.headline.trim() : ''
  const headline = tsunamiHeightToSpeech(rawHeadline)
  const headlinePart = headline ? `${headline}` : `${total}か所で津波を観測しています。`
  const detail = tsunamiObservationDetailText(sorted)
  return `津波観測情報。${headlinePart}${detail}。`
}

/**
 * VTSE41/51/52 津波観測情報 更新点のみ読み上げテキストを生成する。
 * updatedObs は最大波高が更新された観測点のみを渡す（波高降順で最大 maxPoints 件）。
 */
export function tsunamiObservationUpdateToSegments(
  updatedObs: TsunamiObservation[],
  headline?: string,
  maxPoints = 5,
): SpeechSegment[] {
  const obs = updatedObs.filter(o => o.height !== undefined)
  if (obs.length === 0) return []
  const sorted = [...obs].sort((a, b) => b.height!.value - a.height!.value).slice(0, maxPoints)
  // headline の全角数字・全角ｍ・全角ピリオドを半角に変換して VOICEVOX の誤読を防ぐ
  const headlinePart = headline?.trim() ? tsunamiHeightToSpeech(headline.trim()) : ''
  return [
    plain(`津波観測情報。${headlinePart}`),
    ...observationDetailSegments(sorted, observedHeightSuffix),
    plain('を観測しました。'),
  ]
}

export function tsunamiObservationUpdateToText(updatedObs: TsunamiObservation[], headline?: string, maxPoints = 5): string {
  return joinSegments(tsunamiObservationUpdateToSegments(updatedObs, headline, maxPoints))
}

/**
 * 最大波高が未確定（「観測中」）のまま新規に到達が確認された観測点の読み上げテキストを生成する。
 * まだ maxHeight の数値が出ていない観測点（JMA電文で maxHeight.condition = "観測中"）が対象。
 * 波高が未確定であること自体も明示的に読み上げる。件数は maxPoints で絞り、他 tsunami 系読み上げと同様に上限を設ける。
 * 波高読み上げ（observationDetailSegments）と同様に districtName（津波予報区）ごとにグループ化する。
 */
export function tsunamiArrivalToSegments(obs: TsunamiObservation[], maxPoints = 5): SpeechSegment[] {
  if (obs.length === 0) return []
  const shown = obs.slice(0, maxPoints)
  const omitted = obs.length - shown.length
  const suffix = omitted > 0 ? `、ほか${omitted}地点` : ''
  return [
    ...observationDetailSegments(shown, () => ''),
    plain(`${suffix}で到達を確認しました。最大波高は観測中です。`),
  ]
}

export function tsunamiArrivalToText(obs: TsunamiObservation[], maxPoints = 5): string {
  return joinSegments(tsunamiArrivalToSegments(obs, maxPoints))
}

/** 南海トラフ地震臨時情報（VYSE50/51/52）の読み上げテキストを生成する。 */
export function nankaiToText(event: JMANankai): string {
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
function aggregateLpgmNamesByPref(
  names: string[],
  areaPrefIndex: Map<string, string> | null,
  prefAreaNames: Map<string, Set<string>> | null,
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
  const areaPrefIndex = stationData ? buildAreaPrefIndex(stationData) : null
  const prefAreaNames = stationData ? buildPrefAreaNamesIndex(stationData) : null
  const regionOrder = stationData ? buildRegionOrderIndex(stationData) : null

  const parts: string[] = []
  const mentioned = new Set<string>()
  // 長周期地震動階級（1〜4）は震度スケールと別軸のため、opts.alwaysReadScale（震度の下限）は
  // ここでは適用しない。使い忘れではないので、必要になったら階級側の下限を別に設けること。
  for (let i = 0; i <= opts.intensityLevels; i++) {
    const cls = classes[i]
    if (cls == null) break
    let names = aggregateLpgmNamesByPref((byClass.get(cls) ?? []), areaPrefIndex, prefAreaNames)
      .filter(n => !mentioned.has(n))
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
    const omittedSuffix = omittedCount > 0 ? `、ほか${omittedCount}地域` : ''
    parts.push(`階級${cls}を${names.join('、')}${omittedSuffix}`)
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
