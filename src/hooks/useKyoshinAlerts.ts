import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { EEWAlert } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import { playAlertSound, playKyoshinUpdateSound, kyoshinLevel } from '../utils/alertSound'
import { kyoshinIndexToLabel } from '../utils/kyoshinIntensity'
import { showBrowserNotification } from '../utils/notifications'
import { haversineKm } from '../utils/geo'
import { log } from '../utils/logger'
import { computeSWaveRadiusAtTime } from './usePsWaveCalc'
import type { ConfirmedShock } from '../utils/kyoshinDetectionView'
import { PARAMS } from '../utils/kyoshinDetector'

// 強震モニタの揺れ検知（V3 エンジン）に応じたタブ切替・ウィンドウタイトル・通知音・ブラウザ通知を担うフック。
//
// confirmed（確定検知）と candidate（likely・可能性）の2段で反応し、さらに Scratch 前身と同じく
// 「別地点（離れた地域）の地震」にも発報する:
//  - candidate 立ち上がり → realtime タブ＋控えめな候補音（確定前の早期反応）
//  - confirmed 立ち上がり（初検知）→ realtime タブ＋検知音＋ブラウザ通知
//  - candidate/confirmed 中の（全体）レベルアップ／再エスカレーション → 更新音（同一地震の揺れ強まり）。
//    likely 中は confirmed 中より控えめな音量で鳴らし、確信度に見合わない大きさで鳴らさないようにする。
//  - 検知中に離れた別地域が確定（動的距離閾値より遠い）→ 検知音（別地点の地震）
//  - 各々の終了 → EEW が無ければデフォルトタブへ復帰
// 音レベルは confirmed 中は confirmedShocks、likely 中は candidateMaxIndex（どちらもイベント自身の
// メンバー観測点の最大インデックス。カードの推定最大震度と同じ導出元）で判定する。以前は全観測点の
// 生インデックスを無条件スキャンしていたため、検知イベントと無関係な1点が閾値を跨ぐだけでカード表示と
// 食い違う音が鳴ることがあった（2026-08-08 18:47 天草・芦北地方 M3.1 の誤報調査で発覚）。

/** likely（未確定）中に更新音を鳴らす際の音量倍率。候補音（kyoshinCandidate）が確定音の1/4以下の
 * 音量に抑えてあるのと同じ考え方で、確信度に見合わない大きさで鳴らさないようにする。 */
const CANDIDATE_SOUND_GAIN_SCALE = 0.25

/**
 * 同一の揺れ（地域）とみなす代表点間の距離(km)の下限。実際の判定はこれと動的な S波伝播半径
 * （dynamicRegionThresholdKm）の大きい方を使う。地震発生直後は S波がまだ広がっていないため、
 * この下限が実質的な閾値になる（能登半島地震のような広域地震で、揺れの伝播に伴い次々確定する
 * 周辺地域を「別地点」と誤発報しないための下限保証）。
 */
export const REGION_MATCH_KM = 300
/**
 * 別地点発報の最小間隔(ms)。分裂した確定が短時間に多発しても鳴らしすぎない。
 *
 * 2026-08-20 の連発調査で 30 秒へ延ばす案を試したが**据え置いた**。能登半島地震の実データでは、
 * 延ばしても発報数が変わらなかったため（EEW なし条件でどちらも 2 回。間隔だけが 6 秒から 30 秒に
 * 広がる）。延ばすと、クールダウン中に揺れが収まった地域が `REGION_PRUNE_MS`(3 秒) で破棄されて
 * 発報の機会を失う窓が広がる——数を減らせないなら、その代償だけを負うことになる。
 *
 * 連発を止めているのは `absorbedByEew`・エピソード起点（`AlertRegionState.outbreakAtMs`）・
 * `PROPAGATION_MAX_KM`・`NEW_REGION_MIN_INDEX` の 4 つ（設計書§24）。
 */
export const NEW_REGION_COOLDOWN_MS = 5_000
/**
 * 別地点として発報する前に地域が持続すべき時間(ms)。一過性の分裂フラグメントを除く。
 *
 * 起点は地域の初検知（`AlertRegion.firstSeenAtMs`）。登録フレームでは 0 なので、1 秒間隔の
 * フレームに**途切れず**現れるなら「3 フレーム目で満たす」という以前の数え方と一致する。
 *
 * **数えるのは観測の回数ではなくデータ時刻の幅。** 途中の観測が欠けても幅が足りれば満たすため、
 * 最短では登録＋再観測の 2 回で通る（以前は 3 回の実観測が要件だった）。欠落の長さに上限を与えて
 * いるのは `REGION_PRUNE_MS` だけで、この判定自身は連続性を検証しない。**欠測やコマ飛びを挟む
 * ときだけ 1 観測分ぶん緩くなる**が、回数で数え直すとライブとリプレイで長さが変わる問題が戻る。
 * 緩さは承知の上で、長さの一貫性を取っている（設計書§31）。
 */
const REGION_PERSIST_MS = 2_000
/**
 * 別地点として発報する最小の計測震度インデックス（11 = 震度3の下端。`kyoshinLevel` と同じ境界）。
 *
 * 距離の条件だけでは、巨大地震の表面波が遠地へ広がっていく過程を抑えきれない。2026-08-20 の能登半島
 * 地震リプレイ検証（EEW なし条件）では、発報した 8 件のうち 6 件が**震度2以下**（index 7〜10・
 * 震央から 600〜1350km）で、いずれも本震の揺れが遠くへ届いたものだった。距離の上限
 * （`PROPAGATION_MAX_KM`）を上げれば吸収できるが、それは「本当に別の場所で起きた地震」を
 * 取りこぼす方向に働く。**遠さではなく揺れの強さで線を引けば両立する。**
 *
 * 震度3を境にしたのは、地震として体感される水準であり、フル音量の検知音で知らせるに値するため。
 * これを下回る地域も検知カードと地図には出る（音を鳴らさないだけ）。
 */
export const NEW_REGION_MIN_INDEX = 11
/**
 * confirmed から外れて地域を破棄するまでの猶予(ms)。最後に現れてからこれを超えたフレーム末で捨てる。
 *
 * 破棄はフレームの**末尾**で行う。そのため照合の対象として残る時間はこれより長く、1 秒間隔なら
 * 1 フレーム分（「猶予 3 フレーム」という以前の数え方と一致する）、コマ飛びが起きたときはその
 * 飛び幅ぶん伸びる。
 *
 * **末尾に置いているのは意図。** 冒頭で捨てると、飛びが猶予を超えた瞬間に現存する地域が
 * `fired`・`absorbedByEew` ごと登録し直され、発報済みの地域や震源近傍の地域が別地点として
 * 鳴り直す。古い地域が 1 度だけ照合されるより重い（設計書§31）。
 */
const REGION_PRUNE_MS = 3_000
/**
 * EEW（震源要素確定済み）が無い状態で地域を検知した場合に使う仮想震源深さ(km)。実際の震源深さは
 * 分からないため、日本の内陸地震で典型的な深さの近似値を使う。usePsWaveCalc の EEW 円描画とは
 * 独立した用途（震源非依存の検知を補助する概算）であり、精度を要求しない。
 */
export const DEFAULT_VIRTUAL_DEPTH_KM = 15
/**
 * 動的距離閾値（S波伝播半径）に掛ける安全マージン係数。地域が新規登録された瞬間の判定は
 * 「今この瞬間の動的閾値」で行うが、実際に別地点として発報されるのは持続判定
 * （`REGION_PERSIST_MS`）を経た数秒後になる。2026-08-10 の能登半島地震リプレイ検証では、
 * 登録時点で動的閾値にわずかに届いていなかった地域（328km地点、閾値約324km）が、数秒後には
 * 本来閾値内（約337km）に収まっていたにもかかわらず、登録時の判定のみで「別地点」として
 * 誤発報された。この数秒のタイムラグ分を先取りして吸収するための係数。
 */
export const DYNAMIC_THRESHOLD_SAFETY_FACTOR = 1.2
/**
 * EEW が無いときの距離判定で「地震全体の起点」（最も古い地域の初検知時刻）を使い続ける上限(ms)。
 *
 * 距離閾値の起点に地域自身の初検知時刻を使うと、**遠くて揺れ始めが遅い地域ほど経過時間が短く
 * 見積もられ、閾値が下限 300km に張り付く**。伝播を吸収するための動的閾値が、いちばん吸収したい
 * 遠方でこそ育たないという逆転が起きる（2026-08-20 の能登半島地震リプレイ検証: EEW が無い条件で
 * 4 分間に 7 回の誤発報）。地震全体の起点から測れば、時間の経過とともに閾値が全国へ広がる。
 *
 * ただし起点を無期限に引き継ぐと、閾値が際限なく広がって「本当に別の場所で起きた地震」まで
 * 吸収してしまう。5 分あれば S波は 1000km 以上進み国内の伝播はおおむね収まるため、そこで
 * 打ち切って地域自身の起点に戻す。
 */
export const OUTBREAK_PROPAGATION_WINDOW_MS = 5 * 60_000
/**
 * 「同一地震の伝播」として吸収する距離の上限(km)。EEW 起点・地域起点のどちらの判定にも掛ける。
 *
 * S波の到達半径は経過時間に比例して伸び続けるため、上限が無いと数分後には**国内のどこで起きた
 * 地震も同一地震の伝播に見えてしまう**（実測: 起点から 4 分で 1247km、5 分で 1571km に達する。
 * 本州の端から端まで覆う距離）。伝播の吸収より「別の地震を別と認める」ことが優先される領域があり、
 * そこを距離で線引きする。
 *
 * 800km は、能登半島地震の実データで確定地域が現れた最遠（震央から約 740km・福岡）を吸収でき、
 * かつ北海道東部〜九州（1000km 超）を別地震として区別できる値。上限に達するのは起点から約 157 秒
 * 以降で（震源深さ 10〜15km の範囲。深いほどわずかに遅い）、それまでは経過時間に応じた半径が使われる。
 */
export const PROPAGATION_MAX_KM = 800

export interface AlertRegion {
  lat: number
  lng: number
  /** すでに別地点発報したか（初検知フレームで生成された地域は true＝初検知エフェクトが担当） */
  fired: boolean
  /** 最後に confirmedShocks に現れたフレームの dataTimeMs（破棄猶予の起点）。 */
  lastSeenAtMs: number
  /**
   * 地域が最初に確定した dataTimeMs。動的距離閾値（EEW が無い場合）の経過時間の起点と、
   * 持続判定（`REGION_PERSIST_MS`）の起点を兼ねる。**片方の都合で起点をずらすと、もう片方の
   * タイミングも動く。**
   */
  firstSeenAtMs: number
  /**
   * 一度でも EEW の伝播範囲内に入ったか。**EEW が解除された後も発報を抑え続けるために記憶する。**
   *
   * 「今この瞬間 EEW があるか」だけで判定すると、最終報で EEW が消えた瞬間に、それまで吸収されて
   * いた地域が一斉に発報条件を満たす（2026-08-20 の能登半島地震リプレイ検証: 16:14:18 の EEW 解除の
   * 1 秒後に発報）。同じ地震の揺れであることは EEW が消えても変わらないため、判定結果の方を残す。
   */
  absorbedByEew: boolean
}

/** 震源要素確定済み（仮定震源要素でない）EEW 1件から取り出した震源情報。 */
export interface NearestEewInfo {
  lat: number
  lng: number
  originTimeMs: number
  depth: number
}

/** EEW から震源情報を取り出す。震源要素未確定（仮定震源要素）・座標欠損なら null。 */
function extractEewInfo(eew: EEWAlert): NearestEewInfo | null {
  if (eew.earthquake.condition === '仮定震源要素') return null
  const { hypocenter } = eew.earthquake
  if (!Number.isFinite(hypocenter.latitude) || !Number.isFinite(hypocenter.longitude)) return null
  return {
    lat: hypocenter.latitude,
    lng: hypocenter.longitude,
    originTimeMs: new Date(eew.earthquake.originTime).getTime(),
    depth: Math.max(0, hypocenter.depth ?? DEFAULT_VIRTUAL_DEPTH_KM),
  }
}

/**
 * 地域の「同一地震」とみなす動的な距離閾値(km)を計算する。
 *
 * nearestEew（震源要素確定済みの EEW 情報）があれば、その震源・発生時刻から S波の地表到達半径
 * （usePsWaveCalc と同じ2層速度モデル）を計算して使う。無ければ地域自身の初検知時刻を仮の発生
 * 時刻、DEFAULT_VIRTUAL_DEPTH_KM を仮の震源深さとして近似する。いずれも REGION_MATCH_KM を
 * 下限に保証する（発生直後の判定を安定させるため）。
 *
 * 能登半島地震のような広域地震では、揺れが観測網へ伝播していく数十秒〜数分の間に周辺の地域が
 * 次々と確定条件を満たす。固定距離だとこれを「別地点」と誤発報するが、S波の伝播速度に応じて
 * 閾値を動的に広げることで、実際にまだ伝播中でありうる範囲を物理的に近い形で吸収する。
 */
export function dynamicRegionThresholdKm(
  region: AlertRegion,
  nowMs: number,
  nearestEew: NearestEewInfo | null,
): number {
  const originMs = nearestEew ? nearestEew.originTimeMs : region.firstSeenAtMs
  const depth = nearestEew ? nearestEew.depth : DEFAULT_VIRTUAL_DEPTH_KM
  return thresholdFromOrigin(originMs, depth, nowMs)
}

/**
 * 起点時刻と震源深さから S波の地表到達半径(km)を求める。
 * 下限 `REGION_MATCH_KM`・上限 `PROPAGATION_MAX_KM` に収める。
 */
function thresholdFromOrigin(originMs: number, depth: number, nowMs: number): number {
  const elapsedSec = (nowMs - originMs) / 1000
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return REGION_MATCH_KM
  const radius = computeSWaveRadiusAtTime(elapsedSec, depth) * DYNAMIC_THRESHOLD_SAFETY_FACTOR
  return Math.min(Math.max(REGION_MATCH_KM, radius), PROPAGATION_MAX_KM)
}

/**
 * EEW が無いときの距離判定に使う起点時刻を選ぶ。
 *
 * 原則は「地震全体の起点」（`outbreakAtMs`＝現存する最も古い地域の初検知時刻）。地域自身の起点より
 * 古いぶん経過時間が長くなり、伝播に追いつく閾値が得られる。次の場合は地域自身の起点に戻す:
 *  - 起点が渡されていない（地域が 1 つも無い最初のフレーム）
 *  - 地域自身の方が古い（想定外だが、経過時間を実際より長く見積もらないよう安全側に倒す）
 *  - 起点から `OUTBREAK_PROPAGATION_WINDOW_MS` を超えて経過した（伝播はもう収まっている）
 */
function pickOutbreakOrigin(region: AlertRegion, outbreakAtMs: number | null, nowMs: number): number {
  if (outbreakAtMs == null || !Number.isFinite(outbreakAtMs)) return region.firstSeenAtMs
  if (outbreakAtMs > region.firstSeenAtMs) return region.firstSeenAtMs
  if (nowMs - outbreakAtMs > OUTBREAK_PROPAGATION_WINDOW_MS) return region.firstSeenAtMs
  return outbreakAtMs
}

/**
 * 座標が、指定した震源情報の動的閾値（S波伝播半径×安全マージン・`PROPAGATION_MAX_KM` で打ち止め）
 * 以内にあるかを判定する。発生時刻より前（経過が 0 以下）なら常に false。
 */
function isWithinEewRadius(lat: number, lng: number, nowMs: number, eewInfo: NearestEewInfo): boolean {
  const elapsedSec = (nowMs - eewInfo.originTimeMs) / 1000
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return false
  const threshold = thresholdFromOrigin(eewInfo.originTimeMs, eewInfo.depth, nowMs)
  return haversineKm(lat, lng, eewInfo.lat, eewInfo.lng) <= threshold
}

/**
 * 地域(region)と新しい確定点(sLat, sLng)が「同一地震の伝播範囲内」とみなせるかを判定する。
 *
 * アクティブな各 EEW について、region と新しい確定点の両方がその震源の動的閾値内に収まって
 * いるかを個別にチェックし、いずれか1つの EEW で両方とも満たせば同一地震とみなす（OR条件）。
 *
 * 「地理的に最も近い震源を1つだけ選ぶ」設計だと、たまたま近くにある別の（まだ経過時間が短い）
 * 地震の震源に判定を乗っ取られることがある（2026-08-10 能登半島地震リプレイ検証で発覚：近畿
 * 地方の揺れが、94秒経過した能登の震源よりわずかに近いだけの19秒経過の新島・神津島近海の震源を
 * 誤って基準にされ、動的閾値がまだ拡大しきっていないタイミングで「別地点」と誤判定された）。
 * 各 EEW を独立に評価することで、この種の「たまたま近い無関係な地震」への誤帰属を避けられる。
 *
 * どの EEW でも満たさなければ、`pickOutbreakOrigin` が選ぶ起点時刻を基準にした近似
 * （下限 REGION_MATCH_KM）で通常の距離判定にフォールバックする。
 *
 * @param outbreakAtMs 地震全体の起点（現存する最も古い地域の初検知時刻）。省略すると地域自身の
 *   起点を使う（伝播を吸収しきれないため、フックからは必ず渡す）
 */
export function isSameEarthquake(
  region: AlertRegion,
  sLat: number,
  sLng: number,
  nowMs: number,
  activeEEWs: ReadonlyMap<string, EEWAlert>,
  outbreakAtMs: number | null = null,
): boolean {
  let anyEew = false
  for (const eew of activeEEWs.values()) {
    const info = extractEewInfo(eew)
    if (!info) continue
    anyEew = true
    if (isWithinEewRadius(region.lat, region.lng, nowMs, info) && isWithinEewRadius(sLat, sLng, nowMs, info)) return true
  }
  if (anyEew) return false
  const originMs = pickOutbreakOrigin(region, outbreakAtMs, nowMs)
  return haversineKm(sLat, sLng, region.lat, region.lng) <= thresholdFromOrigin(originMs, DEFAULT_VIRTUAL_DEPTH_KM, nowMs)
}

/** region が、アクティブな EEW のいずれかの動的閾値内に単独で収まっているかを判定する。 */
export function isRegionWithinAnyEew(
  region: AlertRegion,
  nowMs: number,
  activeEEWs: ReadonlyMap<string, EEWAlert>,
): boolean {
  for (const eew of activeEEWs.values()) {
    const info = extractEewInfo(eew)
    if (!info) continue
    if (isWithinEewRadius(region.lat, region.lng, nowMs, info)) return true
  }
  return false
}

/** 別地点発報の判定が持ち越す状態（フックの ref 群をまとめたもの）。 */
export interface AlertRegionState {
  regions: AlertRegion[]
  /** 最後に別地点発報したフレームの dataTimeMs。まだ発報していなければ null。 */
  lastNewRegionAtMs: number | null
  /** 前フレームに confirmed があったか（初検知フレームの二重発報を避けるために見る）。 */
  anyConfirmedPrev: boolean
  /**
   * この検知エピソードの起点（最初に確定した地域の初検知時刻）。confirmed が途切れるまで保持する。
   *
   * **個々の地域の生存とは切り離して持つ。** 毎フレーム「現存する最も古い地域」から計算し直すと、
   * 震源近傍の地域が先に収束して `REGION_PRUNE_MS` で刈られた時点で起点が新しい方へ繰り上がり、
   * 距離閾値が突然縮む。震源近傍が収まって遠方がまだ伝播中というのは、まさにこの閾値が要る場面。
   */
  outbreakAtMs: number | null
  /** 直前に取り込んだフレームのデータ時刻。巻き戻り（リプレイの開始・やり直し）の検出に使う。 */
  lastNowMs: number | null
}

export function createAlertRegionState(): AlertRegionState {
  return { regions: [], lastNewRegionAtMs: null, anyConfirmedPrev: false, outbreakAtMs: null, lastNowMs: null }
}

/** 別地点として発報すべき地域。通知の「推定最大震度」はこの地域の値を使う（全体の最大ではない）。 */
export interface NewRegionAlert {
  lat: number
  lng: number
  /** その地域のメンバー観測点の最大計測震度インデックス。 */
  index: number
  /**
   * 上の `index` を記録した観測点の座標（`ConfirmedShock.peak`）。**カメラの寄り先はこちら。**
   * 照合に使う `lat`/`lng` はメンバー重心で、広域のイベントでは強く揺れている点から大きく
   * 離れる（理由は `kyoshinDetectionView.ts` の `ConfirmedShock.peak`）。
   */
  peak?: { lat: number; lng: number }
}

/** 検知エピソードに紐づく状態を捨てる（検知の終了・時刻の巻き戻り時）。 */
function resetEpisode(state: AlertRegionState): void {
  state.regions = []
  state.outbreakAtMs = null
  state.lastNewRegionAtMs = null
}

/**
 * 確定地域 1 フレーム分を取り込み、「別地点の地震」として発報すべきかを返す。
 *
 * 副作用（音・タブ切替・通知）は持たない。判定だけを純粋に行うことで、実データを流した回帰検証と
 * ユニットテストの両方から同じ経路を通せるようにしている。
 *
 * 発報の条件は次のすべて:
 *  - 既存地域とマッチした（新規登録された地域は、初検知エフェクトが鳴らす分と重複するため対象外）
 *  - まだ発報しておらず、EEW の伝播範囲に入ったこともない（`absorbedByEew`）
 *  - 前フレームにも confirmed があった（＝進行中の検知に後から加わった地域である）
 *  - その地域の最大震度が `NEW_REGION_MIN_INDEX` 以上（遠地へ届いた弱い揺れを除く）
 *  - 初検知から `REGION_PERSIST_MS` 以上のデータ時刻が経った（一過性の分裂フラグメントを除く）
 *  - 前回の発報から `NEW_REGION_COOLDOWN_MS` 以上空いている
 *
 * **持続・クールダウン・破棄猶予はいずれもフレームの到来回数ではなくデータ時刻で測る。** そう決めた
 * 理由と、それぞれの測り方の癖は各定数の宣言に書いてある（設計書§31）。
 *
 * **既知の限界**: 一度発報した地域は二度と鳴らない（`fired`）。その地域の閾値の内側で後から本当に
 * 別の地震が起きても、既存地域へのマッチとして扱われ音も通知も出ない（地図と検知カードには出る）。
 * 発報済みを吸収の対象から外す案を実データで試したが、同じ地震の伝播が新規地域として登録し直され、
 * **同じ場所が二度鳴る**方に振れたため採らなかった（2026-08-20 の検証。設計書§24）。
 *
 * @param nowMs 現フレームのデータ時刻。NaN のときは距離も EEW 範囲も判定できないため、地域には
 *   触れずフレームを見送る。前フレームより過去へ戻った場合はエピソードの切り替えとして状態を捨てる
 * @returns 発報すべき地域（1 フレームにつき最大 1 件）。無ければ null
 */
export function stepAlertRegions(
  state: AlertRegionState,
  shocks: readonly { lat: number; lng: number; index: number; peak?: { lat: number; lng: number } }[],
  nowMs: number,
  activeEEWs: ReadonlyMap<string, EEWAlert>,
): NewRegionAlert | null {
  const anyConfirmed = shocks.length > 0

  // データ時刻が壊れているフレームは距離も EEW 範囲も判定できない。地域を作らずに見送る
  // （作っても距離判定に使えないまま毎フレーム積み増すだけになる）。確定の有無だけは反映する。
  if (!Number.isFinite(nowMs)) {
    if (!anyConfirmed) resetEpisode(state)
    state.anyConfirmedPrev = anyConfirmed
    return null
  }
  // 時刻が巻き戻ったらエピソードを切り替える（リプレイの開始・やり直し）。前の再生で立った
  // 発報済み・吸収済みの印を持ち越すと、新しい再生で鳴るべき発報が最初から抑え込まれる。
  if (state.lastNowMs != null && nowMs < state.lastNowMs) resetEpisode(state)
  state.lastNowMs = nowMs

  // EEW の伝播範囲に入ったことを記憶する（EEW 解除後の一斉発報を防ぐ）。判定は毎フレーム行うが、
  // 一度立った印は下ろさない。
  for (const r of state.regions) {
    if (!r.absorbedByEew && isRegionWithinAnyEew(r, nowMs, activeEEWs)) r.absorbedByEew = true
  }

  // マッチングはフレーム開始時の座標で行う。地域の代表点はマッチのたびに書き換わるため、素直に
  // 書くと同じフレームの後続の確定点が「直前の点で動いた後の位置」と比較され、確定点の処理順で
  // 結果が変わる。
  const frameStartPos = new Map(state.regions.map((r) => [r, { lat: r.lat, lng: r.lng }]))

  let alert: NewRegionAlert | null = null
  for (const s of shocks) {
    let reg: AlertRegion | null = null
    let bestDist = Infinity
    for (const r of state.regions) {
      const start = frameStartPos.get(r)
      const moved = start != null && (start.lat !== r.lat || start.lng !== r.lng)
      const lat = moved ? start.lat : r.lat
      const lng = moved ? start.lng : r.lng
      const probe = moved ? { ...r, lat, lng } : r
      if (!isSameEarthquake(probe, s.lat, s.lng, nowMs, activeEEWs, state.outbreakAtMs)) continue
      const d = haversineKm(s.lat, s.lng, lat, lng)
      if (d < bestDist) { bestDist = d; reg = r }
    }
    if (!reg) {
      // 初検知フレームで生成された地域は初検知エフェクトが鳴らすため fired=true にして抑制する。
      const created: AlertRegion = {
        lat: s.lat, lng: s.lng, fired: !state.anyConfirmedPrev, lastSeenAtMs: nowMs,
        firstSeenAtMs: nowMs,
        absorbedByEew: false,
      }
      created.absorbedByEew = isRegionWithinAnyEew(created, nowMs, activeEEWs)
      state.regions.push(created)
      // 同じフレームの後続の確定点も、この地域を「フレーム開始時の位置」として扱えるようにする
      // （登録しないと、直前の点で動いた後の座標と比較され処理順に依存する）。
      frameStartPos.set(created, { lat: created.lat, lng: created.lng })
      if (state.outbreakAtMs == null) state.outbreakAtMs = created.firstSeenAtMs
    } else {
      reg.lat = s.lat
      reg.lng = s.lng
      reg.lastSeenAtMs = nowMs
      if (
        !reg.fired && !reg.absorbedByEew && state.anyConfirmedPrev
        && s.index >= NEW_REGION_MIN_INDEX
        && nowMs - reg.firstSeenAtMs >= REGION_PERSIST_MS
        && (state.lastNewRegionAtMs == null || nowMs - state.lastNewRegionAtMs >= NEW_REGION_COOLDOWN_MS)
      ) {
        // 座標を更新した後の位置で EEW の範囲をもう一度見る。地域の代表点は毎フレーム動くため、
        // フレーム冒頭の一括判定は 1 フレーム前の位置に対する結果になっている。
        if (isRegionWithinAnyEew(reg, nowMs, activeEEWs)) {
          reg.absorbedByEew = true
        } else {
          reg.fired = true
          state.lastNewRegionAtMs = nowMs
          alert = { lat: s.lat, lng: s.lng, index: s.index, peak: s.peak }
        }
      }
    }
  }

  state.regions = state.regions.filter((r) => nowMs - r.lastSeenAtMs <= REGION_PRUNE_MS)
  if (!anyConfirmed) resetEpisode(state)
  state.anyConfirmedPrev = anyConfirmed
  return alert
}

/**
 * 復帰後の検知が、途絶前と同じ揺れか。**復帰後のすべての地点が途絶前のいずれかの近くにある**ときだけ真。
 *
 * 1 つでも離れた地点が混じっていれば偽——別の地震が始まっている可能性があり、そこで音を抑えると
 * **無関係な地震を無音で握り潰す**。「余分に鳴る」より悪い失敗なので、判定は鳴らす側へ倒す。
 *
 * 物差しは `MERGE_EVENT_KM`（イベント重心がこの距離以内なら 1 地震として併合する）。照合しているのが
 * まさに**イベント重心どうし**（`ConfirmedShock` の `lat`/`lng`）なので目的が一致する。同一地震の照合に
 * 使う `REGION_MATCH_KM`(300km) は借りない——あちらは「1 つの地震の揺れが継続監視の中でどこまで
 * 広がりうるか」の物差しで、途絶をまたいだ同一性の判定には広すぎる（`MAX_DT_GAP_MS` の途絶で重心が
 * 動くのは S 波が進む数十 km ぶん）。`isSameEarthquake` そのものも使わない。あちらは経過時間と EEW から
 * 動的な閾値を作るが、ここへ時刻を持ち込むと窓の起点・時計系統・閉じ忘れの問題が戻る（設計書§34）。
 *
 * export しているのはテストから直接呼ぶため。
 */
export function isSameShakeAsBefore(
  now: readonly ConfirmedShock[],
  before: readonly ConfirmedShock[],
): boolean {
  if (now.length === 0 || before.length === 0) return false
  return now.every((s) => before.some((b) => haversineKm(s.lat, s.lng, b.lat, b.lng) <= PARAMS.MERGE_EVENT_KM))
}

export interface KyoshinAlertsDeps {
  /** confirmed イベントが1件以上あるか（V3 検知の確定） */
  confirmed: boolean
  /** likely イベントが1件以上あるか（V3 検知の可能性・早期反応の駆動元） */
  candidate: boolean
  /** 主 likely イベントのメンバー観測点の最大インデックス（likely 中の音レベル追跡に使う） */
  candidateMaxIndex: number
  /**
   * confirmed 各イベント（地域）の代表点＋最大インデックスと、その最大を記録した観測点
   * （別地点発報の入力と、揺れフォーカスの寄り先）。
   */
  confirmedShocks: ConfirmedShock[]
  /** 現フレームのデータ時刻文字列（毎フレーム更新される別地点発報エフェクトの駆動キー） */
  dataTime: string
  /**
   * 検知結果が「**判らなくなったので空にした**」状態か（`useKyoshinDetectorV2` の同名フィールド）。
   *
   * `confirmed` が落ちた理由が「揺れが収まった」のか「上流の異常で検知そのものが止まった」のかを
   * 見分けるために要る。後者からの復帰は同じ地震が続いていることが多く、そこで警報音とブラウザ通知を
   * 鳴らし直すと「収まって、また始まった」という誤った印象を与える。
   */
  stalled: boolean
  settings: AppSettings
  /** useAlertTitle の戻り値（ウィンドウタイトル操作 API） */
  title: AlertTitleApi
  /** cancelledAt 除外済みのアクティブ EEW（App 所有・毎レンダー更新） */
  activeEEWsRef: React.MutableRefObject<ReadonlyMap<string, EEWAlert>>
  /** アイドル復帰で戻すデフォルトタブ（App 所有・毎レンダー更新。デバッグログ用） */
  defaultTabRef: React.MutableRefObject<TabId>
  /**
   * realtime タブへの移動要求。**App 側で揺れ検知の優先度（`TAB_PRIORITY.kyoshin`）を付けて
   * 渡される**ため、地震情報・長周期地震動情報には奪われず、津波・EEW には譲る。
   * 生の `setActiveTab` を渡してはいけない（保持が張られず、直後の地震情報に画面を奪われる）。
   */
  setActiveTab: (tab: TabId) => void
  revertToDefaultTab: () => void
  /**
   * 「この 1 点を一時的に見せたい」という要求。**通知音を鳴らすのと同じ判定で**呼ばれる
   * （揺れの強まり＝レベルアップ／再エスカレーションと、別地点発報）。地図側（`FitToDetectionGL`）が
   * その点へ短く寄り、数秒だけ自分の追従を止める。
   *
   * **likely 中は呼ばない。** 控えめな音量で知らせるだけに留め、確信度に見合わない大きさで画を
   * 動かさない（`CANDIDATE_SOUND_GAIN_SCALE` と同じ考え方）。
   *
   * **任意ではなく必須にしている。** 渡し忘れても実行時には何も起きないため、任意にすると
   * 「音は鳴るのに画は動かない」形で機能ごと静かに失われる。
   */
  onShakeFocus: (point: { lat: number; lng: number }) => void
}

export function useKyoshinAlerts(deps: KyoshinAlertsDeps) {
  const {
    confirmed, candidate, candidateMaxIndex, confirmedShocks, dataTime, stalled, settings, title,
    activeEEWsRef, defaultTabRef, setActiveTab, revertToDefaultTab, onShakeFocus,
  } = deps

  // 以下の発報エフェクトは、音の再鳴を安定させるため依存配列を絞ってある（各 effect の
  // eslint-disable を参照）。そのためコールバックと座標をクロージャで掴むと古い実体を呼び続ける。
  // 毎レンダー ref へ写し、発報の瞬間に最新だけを読む（`activeEEWsRef` と同じ流儀）。
  const onShakeFocusRef = useRef(onShakeFocus)
  onShakeFocusRef.current = onShakeFocus
  // `stalled` も同じ理由で ref に写す。依存配列へ入れると、検知が止まった／戻ったというだけで
  // 発報エフェクトが走り直す。
  const stalledRef = useRef(stalled)
  stalledRef.current = stalled
  // 直近に確定していた検知地点。途絶をまたいで「同じ揺れの続きか」を照合するために持つ
  // （`confirmed` が落ちたフレームでは `confirmedShocks` は既に空なので、落ちる前の値が要る）。
  const lastConfirmedShocksRef = useRef<readonly ConfirmedShock[]>([])
  if (confirmed) lastConfirmedShocksRef.current = confirmedShocks
  // 発報エフェクトの依存配列には `confirmedShocks` を入れていないため、クロージャで掴むと古い実体を
  // 読む。他のコールバックと同じく ref へ写して、発報の瞬間に最新を読む。
  const confirmedShocksRef = useRef(confirmedShocks)
  confirmedShocksRef.current = confirmedShocks
  /**
   * 揺れの強まりで見せる 1 点＝**レベルを担った観測点そのもの**（そのイベントで最大震度を
   * 記録した点。`ConfirmedShock.peak`）。
   *
   * **音のレベル判定と同じ `confirmedShocks` から引く。** 別の集合から引くと、「鳴らした値」と
   * 「寄る先」が別のイベント由来になりうる。
   *
   * **メンバー重心（`lat`/`lng`）へ寄せてはならない。** 重心は地域単位の発報の照合に使う位置で、
   * 広域に広がったイベントでは最も強く揺れている点から大きく離れる（2024-01-01 16:08 能登の
   * 再生で実測: 重心は新潟県境付近・震度4の観測点は能登で約 140km のずれ。画の中心に何も無く、
   * 音が指した点は隅に写る）。
   *
   * confirmed でなければ null——likely 中は画を動かさない（`onShakeFocus` の注記）。
   *
   * 最大 index が同じイベントが複数あるときは、先に現れた方（配列順）を採る。どちらも「いま最も
   * 強く揺れている場所」なので優劣を付ける根拠が無く、原因のイベントを追跡する仕掛けを足すほどの
   * 差ではないと判断している。
   */
  const focusPointRef = useRef<{ lat: number; lng: number } | null>(null)
  const peakShock = confirmed
    ? confirmedShocks.reduce<ConfirmedShock | null>(
        (best, s) => (best === null || s.index > best.index ? s : best),
        null,
      )
    : null
  focusPointRef.current = peakShock?.peak ?? null

  /**
   * 「この 1 点を見せたい」を通知する。座標を省くと上の `focusPointRef` を使い、それが無ければ
   * 何もしない（likely 中・確定イベントが代表点を持たない場合）。
   */
  const requestShakeFocus = useCallback((point?: { lat: number; lng: number }) => {
    const p = point ?? focusPointRef.current
    if (!p) return
    onShakeFocusRef.current({ lat: p.lat, lng: p.lng })
  }, [])

  // confirmed 中はイベント自身のメンバー最大インデックス、likely 中は主候補イベントの最大インデックス。
  // 非検知時は音を鳴らさないため 0 でよい。
  const effectiveKyoshinMaxIndex = useMemo(() => {
    if (confirmed) return confirmedShocks.reduce((max, s) => Math.max(max, s.index), 0)
    if (candidate) return candidateMaxIndex
    return 0
  }, [confirmed, confirmedShocks, candidate, candidateMaxIndex])

  // 確定検知の開始/終了: realtime タブ＋タイトル＋通知音＋ブラウザ通知。
  const prevConfirmedRef = useRef(false)
  /**
   * 「判らなくなった」ことで confirmed が落ちたまま、まだ結果が戻っていないか。
   *
   * **経過時間では測らない。** 起点は「confirmed が落ちたのを観測した時刻」で、検知エンジンが数えて
   * いる「最後に結果を出せた時刻」より数フレーム遅い。測る時計もアプリ時計とデータ時刻で別物で、
   * リプレイでは進む速さが違う。そして窓を閉じ損ねると、**後から来た無関係な地震の警報を無音で
   * 握り潰す**（詳細は設計書§34）。
   *
   * 代わりに**復帰した検知が途絶前と同じ場所か**を照合する（`isSameShakeAsBefore`）。印が立って
   * いるだけでは足りない——途絶が `MAX_DT_GAP_MS` 以内なら検知エンジンは状態を組み直さず通常の経路を
   * 通るので、復帰フレームで**まったく別の地震**が確定しうる（EEW 発表中や高震度は 1 フレームで確定
   * する設計のため、強い地震ほど起こりやすい）。
   */
  const lostWhileStalledRef = useRef(false)
  /** 途絶に入る直前に確定していた検知地点（復帰後との照合用）。 */
  const shocksBeforeStallRef = useRef<readonly ConfirmedShock[]>([])
  useEffect(() => {
    if (confirmed && !prevConfirmedRef.current) {
      const resumed = lostWhileStalledRef.current
        && isSameShakeAsBefore(confirmedShocksRef.current, shocksBeforeStallRef.current)
      lostWhileStalledRef.current = false
      shocksBeforeStallRef.current = []
      log.info(`[tab] realtime を要求 (揺れ検知${resumed ? '再開' : '開始'} V3 confirmed)`)
      setActiveTab('realtime')
      title.setTitle('揺れ検知')
      // 抑えるのは音と通知だけ。画面（タブ・タイトル）は従来どおり、検知が落ちた時点で一度既定へ
      // 戻り、ここで復帰する（結果が空の間まで「揺れ検知」を出し続けると、判っていない状態を
      // 判っているように見せることになる）。
      if (resumed) {
        log.info('[kyoshin] 検知の復帰につき検知音とブラウザ通知は省略（同じ地震の続き）')
      } else {
        if (settings.soundEnabled) {
          playAlertSound('kyoshin')
        }
        if (settings.notifyMinScale >= 0 && settings.notifyDetection) {
          const label = kyoshinIndexToLabel(effectiveKyoshinMaxIndex) ?? '?'
          showBrowserNotification('揺れを検知中', `推定最大震度 ${label}（強震モニタ）`, 'kyoshin-detection')
        }
      }
    } else if (!confirmed && prevConfirmedRef.current) {
      // 揺れが収まったのか、検知そのものが止まったのか。後者だけ「続きかもしれない」印を立て、
      // 照合のために直前の検知地点を控える。
      lostWhileStalledRef.current = stalled
      shocksBeforeStallRef.current = stalled ? lastConfirmedShocksRef.current : []
      title.applyPriority({ kyoshinDetected: false })
      if (activeEEWsRef.current.size === 0) {
        log.info(`[tab] → ${defaultTabRef.current} (揺れ検知終了 V3)`)
        revertToDefaultTab()
      }
    } else if (!confirmed && !stalled) {
      // 結果は戻ったのに検知は無い＝続きではなかった。印を下ろす。ここを省くと印が残り続け、
      // 後から来た無関係な地震で音と通知が出なくなる。
      lostWhileStalledRef.current = false
      shocksBeforeStallRef.current = []
    }
    prevConfirmedRef.current = confirmed
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 音の再鳴を安定させるため依存は限定する
  }, [confirmed, stalled, effectiveKyoshinMaxIndex, settings.soundEnabled, settings.notifyDetection])

  // 可能性（likely）発生時の早期反応: タブ切替＋タイトル変更＋控えめな候補音のみ
  // （ブラウザ通知・フル音は確定時まで行わない）。確定（confirmed）に昇格した場合は上の
  // 検知開始エフェクトが引き継ぐため、ここでは confirmed が false のときだけを対象にする。
  const prevCandidateRef = useRef(false)
  useEffect(() => {
    if (candidate && !prevCandidateRef.current && !confirmed) {
      log.info('[tab] realtime を要求 (揺れの可能性 V3 likely)')
      setActiveTab('realtime')
      title.setTitle('揺れの可能性')
      if (settings.soundEnabled) {
        playAlertSound('kyoshinCandidate')
      }
    } else if (!candidate && prevCandidateRef.current && !confirmed) {
      // 確定に昇格せず消えた場合のみ、静かに元へ戻す
      title.applyPriority({ kyoshinDetected: false })
      if (activeEEWsRef.current.size === 0) {
        log.info(`[tab] → ${defaultTabRef.current} (揺れの可能性 失効 V3)`)
        revertToDefaultTab()
      }
    }
    prevCandidateRef.current = candidate
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依存集合は検知開始エフェクトに合わせて絞る
  }, [candidate, confirmed, settings.soundEnabled])

  // likely/confirmed 中の音再鳴ロジック（同一地震の揺れ強まり）
  // - 過去最大レベルを超えたとき（新たな最大）→ 音を鳴らす
  // - ピーク後に一度落ちてから再上昇したとき（再エスカレーション）→ 音を鳴らす
  // 生インデックスではなく音レベル（0〜6）で比較することで、フレーム間の微細な数値変動による誤再鳴を防ぐ。
  // 「未観測」は -1 で表す（0 は有効な音レベルのため）。likely 中もリセットせず追跡を続けることで、
  // likely→confirmed の遷移で「最初から高いレベルで確定した」場合も正しく「レベルが上がった」と
  // 検出できる（likely 中に基準値が育っているため）。confirmed か candidate のどちらもなくなったら
  // 追跡を打ち切る。音量は confirmed 中のみ通常、likely 中は控えめ（CANDIDATE_SOUND_GAIN_SCALE）にし、
  // まだ確定していない検知に確信度以上の大きさで反応しないようにする。
  const maxSoundLevelRef = useRef(-1)
  const postPeakMinLevelRef = useRef(-1)
  useEffect(() => {
    if (!confirmed && !candidate) {
      maxSoundLevelRef.current = -1
      postPeakMinLevelRef.current = -1
      return
    }
    const gainScale = confirmed ? 1 : CANDIDATE_SOUND_GAIN_SCALE
    const currLevel = kyoshinLevel(effectiveKyoshinMaxIndex)
    const prevMaxLevel = maxSoundLevelRef.current
    if (currLevel > prevMaxLevel) {
      maxSoundLevelRef.current = currLevel
      postPeakMinLevelRef.current = currLevel
      if (prevMaxLevel >= 0) {
        log.info(`[tab] realtime を要求 (揺れ検知レベルアップ level=${prevMaxLevel}→${currLevel} confirmed=${confirmed})`)
        setActiveTab('realtime')
        requestShakeFocus()
        if (settings.soundEnabled) {
          playKyoshinUpdateSound(effectiveKyoshinMaxIndex, gainScale)
        }
      }
    } else if (currLevel < postPeakMinLevelRef.current) {
      postPeakMinLevelRef.current = currLevel
    } else if (currLevel > postPeakMinLevelRef.current) {
      const prevMinLevel = postPeakMinLevelRef.current
      maxSoundLevelRef.current = currLevel
      postPeakMinLevelRef.current = currLevel
      log.info(`[tab] realtime を要求 (揺れ検知再エスカレーション level=${prevMinLevel}→${currLevel} confirmed=${confirmed})`)
      setActiveTab('realtime')
      requestShakeFocus()
      if (settings.soundEnabled) {
        playKyoshinUpdateSound(effectiveKyoshinMaxIndex, gainScale)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 音の再鳴を安定させるため依存は限定する
  }, [effectiveKyoshinMaxIndex, confirmed, candidate, settings.soundEnabled])

  // 別地点の地震: 検知中に、既存の確定地域から `isSameEarthquake` の閾値より離れた新地域が
  // 確定したら発報する（Scratch 前身のグリッド単位発報に相当。グローバル真偽の
  // 初検知だけでは進行中の別地点を鳴らせない）。
  // 判定そのものは stepAlertRegions（純関数）が持つ。ここは発報の合図を受けて音・タブ・通知を出す。
  const regionStateRef = useRef<AlertRegionState>(createAlertRegionState())
  useEffect(() => {
    if (!dataTime) return
    const nowMs = new Date(dataTime).getTime()
    const alert = stepAlertRegions(regionStateRef.current, confirmedShocks, nowMs, activeEEWsRef.current)
    if (!alert) return
    log.info('[tab] realtime を要求 (別地点で揺れ検知 V3)')
    setActiveTab('realtime')
    // 発報した地域自身の代表点へ寄せる（全体の最大震度ではなく「別の地点」を見せる報せなので、
    // 通知の文面と同じくこの地域の座標を使う）。
    //
    // **同じフレームで揺れの強まりと別地点発報が両方成立したら、こちらが勝つ**（この effect が
    // 後に定義されており、React は同じ flush の中で定義順に走らせるため、App 側の state には
    // 最後の要求だけが残る）。それでよい——別地点は「別の場所でも揺れている」ことをフル音量で
    // 知らせる報せで、同じ地震の強まりより見せる価値が高い。
    // ピークが無いのは、`ConfirmedShock` を作らない経路から `stepAlertRegions` を呼んだ場合だけ
    // （現状の実装には無い）。寄らずに黙って終わるより、旧来どおり重心へ落とす方が害が小さい。
    requestShakeFocus(alert.peak ?? { lat: alert.lat, lng: alert.lng })
    if (settings.soundEnabled) playAlertSound('kyoshin')
    if (settings.notifyMinScale >= 0 && settings.notifyDetection) {
      // 全体の最大震度ではなく、発報した地域自身の推定震度を出す（「別の地点」の報せなので）
      const label = kyoshinIndexToLabel(alert.index) ?? '?'
      showBrowserNotification('別の地点で揺れを検知', `推定最大震度 ${label}（強震モニタ）`, 'kyoshin-detection-new')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataTime を毎フレーム駆動キーにし他は最新クロージャを参照
  }, [dataTime])
}
