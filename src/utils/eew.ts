import type { EEWAlert, EEWRegion } from '../types/earthquake'
import type { AlertSoundType } from './alertSound'
import { computeSWaveTravelTimeSec } from '../hooks/usePsWaveCalc'
import { isValidIntensityScale } from './intensity'
import { isValidLpgmClass } from './lpgm'
import { hypoInfoItemToEEW, type YahooHypoInfoItem } from '../services/kyoshin'

// 司・翠川(1999)の距離減衰式を使ってEEW最終報後の自動解除秒数を計算する。
// 有感半径（震度1以上が届く距離）を逆算し、1.5倍のバッファを乗せてS波到達時刻を求める。

const FELT_RADIUS_BUFFER = 1.5   // 地盤増幅を無視した分の補正係数
const MAX_FELT_RADIUS_KM = 2500  // 上限（M9クラスでも日本全域をカバー）
const MIN_CANCEL_SEC = 60        // 最終報受信から最低この秒数は解除しない
const FIXED_BUFFER_SEC = 30      // S波到達後の余裕

/** Mjma → Mw 変換（宇津 1982） */
function mjmaToMw(mjma: number): number {
  return mjma - 0.171
}

/**
 * 司・翠川(1999)距離減衰式で工学的基盤上の最大速度(PGV600, cm/s)を計算する。
 * X: 断層最短距離(km), mw: モーメントマグニチュード, depth: 震源深度(km)
 */
function calcPGV600(X: number, mw: number, depth: number): number {
  const logPGV = 0.58 * mw + 0.0038 * depth - 1.29
    - Math.log10(X + 0.0028 * 10 ** (0.5 * mw))
    - 0.002 * X
  return 10 ** logPGV
}

/**
 * 司・翠川式の逆算で震度 targetIntensity 以上となる震央距離(km)を返す。
 * 断層長（宇津 1977）を考慮した断層最短距離に変換してから計算する。
 * バッファ係数・上限キャップを適用済み。
 */
export function calcFeltRadiusKm(mjma: number, depth: number, targetIntensity = 1.0): number {
  const mw = mjmaToMw(Math.max(mjma, 3.0))
  const faultHalfLen = 10 ** (0.5 * mw - 1.85)  // 断層半長(km)（宇津 1977: log L = 0.5Mw - 1.85）
  // 震度 targetIntensity に対応するPGVしきい値（翠川他 1999: I = 2.68 + 1.72·log(PGV)）
  const pgvThreshold = 10 ** ((targetIntensity - 2.68) / 1.72)

  // 二分探索で有感半径を逆算（PGVは距離単調減少）
  let lo = 0, hi = MAX_FELT_RADIUS_KM / FELT_RADIUS_BUFFER
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    const hypoDist = Math.sqrt(mid ** 2 + depth ** 2)
    const X = Math.max(hypoDist - faultHalfLen, 3)
    if (calcPGV600(X, mw, depth) > pgvThreshold) lo = mid
    else hi = mid
  }

  const rawRadius = (lo + hi) / 2
  return Math.min(rawRadius * FELT_RADIUS_BUFFER, MAX_FELT_RADIUS_KM)
}

/**
 * EEW最終報の発震時刻から何秒後に自動解除するかを返す。
 * 司・翠川(1999)の有感半径(×1.5バッファ)にS波が到達するまでの時間 + 30秒。
 */
export function calcEEWAutoCancelSec(mjma: number, depth: number): number {
  const feltRadius = calcFeltRadiusKm(mjma, depth)
  const sWaveSec = computeSWaveTravelTimeSec(feltRadius, Math.max(depth, 1))
  return Math.round(sWaveSec) + FIXED_BUFFER_SEC
}

/** EEWの発震時刻を起点にした自動解除時刻を返す。最終報受信から MIN_CANCEL_SEC 秒の下限保証付き。 */
export function calcEEWCancelTime(eew: EEWAlert, reportTime: Date): Date {
  const mjma = eew.earthquake.hypocenter.magnitude ?? 6.0
  const depth = eew.earthquake.hypocenter.depth ?? 30
  const originTime = new Date(eew.earthquake.originTime)
  const autoCancelSec = calcEEWAutoCancelSec(mjma, depth)
  const fromOrigin = new Date(originTime.getTime() + autoCancelSec * 1000)
  const minTime = new Date(reportTime.getTime() + MIN_CANCEL_SEC * 1000)
  return fromOrigin > minTime ? fromOrigin : minTime
}

/** S波フォールバック速度 [km/s]（震源深度が不明な Yahoo 版などで使用） */
export const S_WAVE_FALLBACK_KM_PER_SEC = 4.0

/**
 * マグニチュード別の「揺れ継続時間」概算テーブル。
 * 注意: 司・翠川(1999)等の物理式には基づかない。震源近傍でS波通過後
 * いつまで描画上「揺れている」とみなすかを決めるための、UI表現上の
 * 目安の固定値。しきい値はM5/6/7/8区切り、8〜60秒程度で単調増加。
 */
const SHAKING_DURATION_TABLE: { minMag: number; durationSec: number }[] = [
  { minMag: 8.0, durationSec: 100 },
  { minMag: 7.0, durationSec: 70 },
  { minMag: 6.0, durationSec: 35 },
  { minMag: 5.0, durationSec: 20 },
  { minMag: -Infinity, durationSec: 14 },
]

const DEFAULT_SHAKING_DURATION_SEC = 20 // magnitude 未定義時（Yahoo版）のデフォルト

// 震源距離による継続時間の伸び分 [秒/km]。P-S時間差の拡大・表面波の分離・
// コーダ波の伸長など、遠方ほど揺れが長引く傾向を表す目安の係数（経験式ではない）。
const PATH_DURATION_COEF_SEC_PER_KM = 0.05
// 距離による伸び分の上限[秒]（1600km地点で頭打ち。M8〜M9クラスの広域伝播でも際限なく伸びないように）
const PATH_DURATION_CAP_SEC = 80

/**
 * マグニチュードと震源距離から揺れ継続時間の目安[秒]を返す。
 * マグニチュード別テーブルの基準値に、距離による伸び分（distanceKm * 係数、上限あり）を加算する。
 * magnitude 未定義時はデフォルト値を基準にする。
 */
export function calcShakingDurationSec(magnitude: number | undefined, distanceKm: number): number {
  const entry = magnitude === undefined
    ? undefined
    : SHAKING_DURATION_TABLE.find((e) => magnitude >= e.minMag)
  const baseDurationSec = entry ? entry.durationSec : DEFAULT_SHAKING_DURATION_SEC
  const pathDurationSec = Math.min(PATH_DURATION_COEF_SEC_PER_KM * distanceKm, PATH_DURATION_CAP_SEC)
  return baseDurationSec + pathDurationSec
}

// DMDSS版カウントダウンの安全マージン。震源近傍は直達波がそのまま立ち上がるため遅れがほぼ無いが、
// 遠方ほど表面波の分離・コーダ波の重畳で揺れの立ち上がりがなだらかになり、S波理論到達より
// 体感開始が遅れる傾向がある（実測: 2026-07-29、震源距離70kmで理論到達より約2秒遅れて有感化）。
// 係数は実測1件からの外挿値であり物理式の裏付けはない。今後別の震源距離での実測が増えたら再検証する。
const ARRIVAL_MARGIN_COEF_SEC_PER_KM = 0.03  // 70km地点で2.1秒 ≈ 実測に一致
const ARRIVAL_MARGIN_CAP_SEC = 4              // 上限（約133km地点で頭打ち）

/**
 * DMDSS版のS波到達カウントダウンに乗せる安全マージン[秒]を、震源距離から返す。
 * 震源直上(0km)では0秒、距離に比例して増加し、ARRIVAL_MARGIN_CAP_SEC で頭打ちになる。
 */
export function calcArrivalSafetyMarginSec(distanceKm: number): number {
  return Math.min(distanceKm * ARRIVAL_MARGIN_COEF_SEC_PER_KM, ARRIVAL_MARGIN_CAP_SEC)
}

// EEW の areas が未設定の場合 regions にフォールバックする（旧形式互換）。

export function eewAreas(eew: EEWAlert): EEWRegion[] {
  return eew.areas ?? eew.regions ?? []
}

/** 対象地域の最大予想震度（scale 値）。震度が取れないときは 0 を返す。
 * condition=仮定震源要素（単独点処理）かつ areas が空の場合は forecastMaxScale を使わず 0 を返す。
 * 単独点PLUM検知では forecastMaxInt が設定されても地域別予想は発表されないため。
 *
 * 震度スケール外の値（`IntensityScale` に無い中間値・範囲外値）は採用しない。
 * `EEWRegion` は型で守られているが、実地震シナリオ JSON のように型検査を通らない経路から
 * 値が来るため、実行時にも弾く。これが無いと、壊れた入力の scaleTo がそのまま 55 との比較を
 * 通って特別警報へ誤昇格しうる。未確定の -1 は Math.max の初期値 0 に丸められる。
 */
export function eewMaxScale(eew: EEWAlert): number {
  const areasMax = eewAreas(eew).reduce(
    (max, r) => (isValidIntensityScale(r.scaleTo) ? Math.max(max, r.scaleTo) : max),
    0,
  )
  if (areasMax > 0) return areasMax
  if (eew.earthquake.condition === '仮定震源要素') return 0
  const forecast = eew.forecastMaxScale
  return forecast != null && isValidIntensityScale(forecast) ? forecast : 0
}

/** 対象地域の最大予想長周期地震動階級（1〜4）。データが無ければ0。
 * eewMaxScale と同じ考え方で areas の地域別 lgIntTo を優先し、
 * condition=仮定震源要素（単独点処理）かつ areas が空の場合は forecastMaxLpgmClass を使わず0を返す
 * （単独点PLUM検知では地域別の詳細予想が発表されないため）。
 * Yahoo hypoInfo・P2PQuake 由来の EEW は長周期地震動階級のフィールド自体を持たないため常に0になる
 * （DMDATA=DMDSS版のみ取得可能。標準版は震度のみでレベル判定される）。
 */
export function eewMaxLpgmClass(eew: EEWAlert): number {
  const areasMax = eewAreas(eew).reduce(
    (max, r) => (r.lgIntTo != null && isValidLpgmClass(r.lgIntTo) ? Math.max(max, r.lgIntTo) : max),
    0,
  )
  if (areasMax > 0) return areasMax
  if (eew.earthquake.condition === '仮定震源要素') return 0
  const forecast = eew.forecastMaxLpgmClass
  return forecast != null && isValidLpgmClass(forecast) ? forecast : 0
}

/** 情報番号（第N報）。取得できなければ null。 */
export function eewSerial(eew: EEWAlert): number | null {
  const n = Number(eew.issue?.serial)
  return Number.isInteger(n) && n > 0 ? n : null
}

// EEW 単発のレベル算出: 0=予報級（severity!=='Warning'。震度の高低に関係なく警報未満は全て 0）
// / 1=警報（severity==='Warning'） / 2=特別警報（severity==='Warning' かつ 震度6弱以上 または
// 長周期地震動階級4以上）。気象庁の実基準（震度6弱以上 or 長周期地震動階級4以上）に合わせている。
// 震度が取れないケース（地域別予想なし・全地域が震度未確定の -1・仮定震源要素）では eewMaxScale が
// 0 を返すため、55 との比較だけで自然に特別警報から外れる。専用のガードは要らない。
// レベル1・2ともに severity（isWarning）必須。予報級電文（severity=Forecast）は震度だけ高くても常にレベル0とする。
/**
 * ウィンドウタイトル・ブラウザ通知の見出しに使う区分の名前。
 *
 * 予報級と警報級は**別の電文**なので名前も分ける（VXSE45 緊急地震速報（地震動予報）／
 * VXSE43 緊急地震速報（警報））。呼び出し箇所が複数あるため、文言がずれないようここに置く。
 * 対応表は docs/spec/eew-spec.md §3「電文の名称と表示・読み上げ」。
 */
export function eewKindLabel(level: 0 | 1 | 2): string {
  return level >= 1 ? '緊急地震速報' : '地震動予報'
}

export function computeSingleEEWLevel(eew: EEWAlert): 0 | 1 | 2 {
  if (eew.severity !== 'Warning') return 0
  const isSpecialByIntensity = eewMaxScale(eew) >= 55
  const isSpecialByLpgm = eewMaxLpgmClass(eew) >= 4
  return (isSpecialByIntensity || isSpecialByLpgm) ? 2 : 1
}

export function computeEEWLevel(eews: ReadonlyMap<string, EEWAlert>): 0 | 1 | 2 | null {
  if (eews.size === 0) return null
  let max: 0 | 1 | 2 = 0
  for (const eew of eews.values()) {
    const level = computeSingleEEWLevel(eew)
    if (level > max) max = level
  }
  return max
}

/**
 * EEW 受信時の再生音を決定する。優先順位は以下（最初に一致した分岐で return）:
 *   1. 新規発報 or レベル格上げ（`isNew || levelUpgraded`）
 *      → `currentLevel` に応じて `eewSpecial`（=2）／`eew`（=1）／`eewForecast`（=0）
 *   2. 続報の最終報（新規でも格上げでもない・`isFinal`）→ `eewFinal`
 *   3. 通常続報 → `eewUpdate`
 *
 * `isFinal` より新規/格上げ判定を先に評価するのは、最終報で震度・長周期階級が上がって
 * `levelUpgraded=true` になる最重要ケース（最終報で震度 6 弱以上へ格上げ等）を警戒音で
 * 知らせるため。isFinal を先にすると eewFinal（穏やかな終了音）で上書きされてしまう。
 *
 * 呼び出し元（`useLiveEventHandler.ts`）の不変条件により `isNew && levelUpgraded` は
 * 同時に true にならない（`levelUpgraded` は `!isNew && currentLevel > prevLevel` の場合のみ真）。
 */
export function selectEEWSoundType(isNew: boolean, levelUpgraded: boolean, currentLevel: 0 | 1 | 2, isFinal: boolean): AlertSoundType {
  if (isNew || levelUpgraded) {
    return currentLevel === 2 ? 'eewSpecial' : currentLevel === 1 ? 'eew' : 'eewForecast'
  }
  if (isFinal) return 'eewFinal'
  return 'eewUpdate'
}

// Yahoo hypoInfo（強震モニタのEEW一覧）は1秒間隔のポーリングで取得するスナップショットのため、
// ネットワーク遅延や配信タイミングのブレで対象 reportId が1回だけ欠落することがある。
// 消滅を即座に解除確定にすると、JMAの取消電文が無いのに解除扱いになってしまうため、
// この回数分は猶予を持って様子を見る（復活すれば何も起きない）。
const HYPO_INFO_MISSING_CONFIRM_TICKS = 2

/** hypoInfo 消滅の連続検出回数を reportId ごとに追跡する状態。 */
export interface HypoInfoPendingMissing {
  item: YahooHypoInfoItem
  missingTicks: number
}

/**
 * Yahoo hypoInfo の前回・今回スナップショットを比較し、新規発報・続報・解除に相当する
 * EEWAlert を導出する。消滅（前回まで追跡していた reportId が今回に無い）は
 * HYPO_INFO_MISSING_CONFIRM_TICKS 回連続で確認できて初めて解除を確定する。
 *
 * 解除確定時、直前に isCancel=true を確認できていれば「誤報取消」として cancelled のみ立てる。
 * それ以外（有効期限切れ・欠測からの復帰断念）は expired も立てて自動終了として扱い、
 * 誤報取消の音・通知（useLiveEventHandler の !event.expired かつ hadKey=true 分岐）を鳴らさないようにする。
 * hadKey は AUD-2 対応で追加された二重鳴り防止ガード（受信元別に cancel が届いた場合の 2 回目対策）。
 */
export function diffHypoInfoEvents(
  prev: YahooHypoInfoItem[],
  curr: YahooHypoInfoItem[],
  prevPendingMissing: ReadonlyMap<string, HypoInfoPendingMissing>,
): { events: EEWAlert[]; pendingMissing: Map<string, HypoInfoPendingMissing> } {
  const events: EEWAlert[] = []
  const currMap = new Map(curr.map(it => [it.reportId, it]))

  // 直前まで追跡していた全アイテム（前回スナップショット ∪ 消滅猶予中のアイテム）。
  // 猶予中の reportId は呼び出し元の設計上 prev には含まれない（消滅した回の prev からは
  // 既に消えている）ため重複は起きないはずだが、念のため has チェックで安全側に倒す。
  const trackedItems = new Map<string, YahooHypoInfoItem>()
  for (const it of prev) trackedItems.set(it.reportId, it)
  for (const [id, pending] of prevPendingMissing) {
    if (!trackedItems.has(id)) trackedItems.set(id, pending.item)
  }

  // 新規発報・報番号更新
  for (const item of curr) {
    const prevItem = trackedItems.get(item.reportId)
    const isNew = !prevItem
    const isUpdated = !!prevItem && item.reportNum !== prevItem.reportNum
    if (isNew || isUpdated) {
      events.push(hypoInfoItemToEEW(item))
    }
  }

  // 消滅判定（猶予つき）: リストに復活したものは pendingMissing に残さずここで消える
  const pendingMissing = new Map<string, HypoInfoPendingMissing>()
  for (const [reportId, item] of trackedItems) {
    if (currMap.has(reportId)) continue
    const missingTicks = (prevPendingMissing.get(reportId)?.missingTicks ?? 0) + 1
    if (missingTicks < HYPO_INFO_MISSING_CONFIRM_TICKS) {
      pendingMissing.set(reportId, { item, missingTicks })
      continue
    }
    // 消える直前に確認できていた isCancel の値をそのまま尊重する（誤報取消 か 自動終了 かの分岐）
    const wasExplicitCancel = item.isCancel === 'true'
    const cancelledEEW = hypoInfoItemToEEW(item)
    events.push({ ...cancelledEEW, cancelled: true, expired: wasExplicitCancel ? undefined : true })
  }

  return { events, pendingMissing }
}
