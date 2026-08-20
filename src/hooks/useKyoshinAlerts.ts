import { useEffect, useMemo, useRef } from 'react'
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
 * 別地点発報の最小間隔（フレーム）。分裂した確定が短時間に多発しても鳴らしすぎない。
 *
 * 2026-08-20 の連発調査で 30 へ延ばす案を試したが**据え置いた**。能登半島地震の実データでは、
 * 延ばしても発報数が変わらなかったため（EEW なし条件でどちらも 2 回。間隔だけが 6 秒から 30 秒に
 * 広がる）。延ばすと、クールダウン中に揺れが収まった地域が `REGION_PRUNE_TICKS`(3) で破棄されて
 * 発報の機会を失う窓が広がる——数を減らせないなら、その代償だけを負うことになる。
 *
 * 連発を止めているのは `absorbedByEew`・エピソード起点（`AlertRegionState.outbreakAtMs`）・
 * `PROPAGATION_MAX_KM`・`NEW_REGION_MIN_INDEX` の 4 つ（設計書§24）。
 */
export const NEW_REGION_COOLDOWN_TICKS = 5
/** 別地点として発報する前に地域が持続すべきフレーム数（一過性フラグメント除去）。 */
const REGION_PERSIST_TICKS = 3
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
/** confirmed から外れて地域を破棄するまでの猶予（フレーム）。 */
const REGION_PRUNE_TICKS = 3
/**
 * EEW（震源要素確定済み）が無い状態で地域を検知した場合に使う仮想震源深さ(km)。実際の震源深さは
 * 分からないため、日本の内陸地震で典型的な深さの近似値を使う。usePsWaveCalc の EEW 円描画とは
 * 独立した用途（震源非依存の検知を補助する概算）であり、精度を要求しない。
 */
export const DEFAULT_VIRTUAL_DEPTH_KM = 15
/**
 * 動的距離閾値（S波伝播半径）に掛ける安全マージン係数。地域が新規登録された瞬間の判定は
 * 「今この瞬間の動的閾値」で行うが、実際に別地点として発報されるのは持続判定
 * （REGION_PERSIST_TICKS）を経た数秒後になる。2026-08-10 の能登半島地震リプレイ検証では、
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
  /** 連続して現れたフレーム数（持続判定） */
  seen: number
  /** すでに別地点発報したか（初検知フレームで生成された地域は true＝初検知エフェクトが担当） */
  fired: boolean
  /** 最後に confirmedShocks に現れたフレーム */
  lastTick: number
  /** 地域が最初に確定した dataTimeMs。動的距離閾値（EEW が無い場合）の経過時間の起点に使う。 */
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
  /** 取り込んだフレーム数。持続・クールダウンの単位。 */
  tick: number
  /** 最後に別地点発報したフレーム。 */
  lastNewRegionTick: number
  /** 前フレームに confirmed があったか（初検知フレームの二重発報を避けるために見る）。 */
  anyConfirmedPrev: boolean
  /**
   * この検知エピソードの起点（最初に確定した地域の初検知時刻）。confirmed が途切れるまで保持する。
   *
   * **個々の地域の生存とは切り離して持つ。** 毎フレーム「現存する最も古い地域」から計算し直すと、
   * 震源近傍の地域が先に収束して `REGION_PRUNE_TICKS` で刈られた時点で起点が新しい方へ繰り上がり、
   * 距離閾値が突然縮む。震源近傍が収まって遠方がまだ伝播中というのは、まさにこの閾値が要る場面。
   */
  outbreakAtMs: number | null
  /** 直前に取り込んだフレームのデータ時刻。巻き戻り（リプレイの開始・やり直し）の検出に使う。 */
  lastNowMs: number | null
}

export function createAlertRegionState(): AlertRegionState {
  return { regions: [], tick: 0, lastNewRegionTick: -999, anyConfirmedPrev: false, outbreakAtMs: null, lastNowMs: null }
}

/** 別地点として発報すべき地域。通知の「推定最大震度」はこの地域の値を使う（全体の最大ではない）。 */
export interface NewRegionAlert {
  lat: number
  lng: number
  /** その地域のメンバー観測点の最大計測震度インデックス。 */
  index: number
}

/** 検知エピソードに紐づく状態を捨てる（検知の終了・時刻の巻き戻り時）。tick は通し番号なので残す。 */
function resetEpisode(state: AlertRegionState): void {
  state.regions = []
  state.outbreakAtMs = null
  state.lastNewRegionTick = -999
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
 *  - `REGION_PERSIST_TICKS` 以上のフレームに連続して現れた（一過性の分裂フラグメントを除く）
 *  - 前回の発報から `NEW_REGION_COOLDOWN_TICKS` 以上空いている
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
  shocks: readonly { lat: number; lng: number; index: number }[],
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

  const tick = ++state.tick

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
        lat: s.lat, lng: s.lng, seen: 1, fired: !state.anyConfirmedPrev, lastTick: tick,
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
      reg.lastTick = tick
      reg.seen++
      if (
        !reg.fired && !reg.absorbedByEew && state.anyConfirmedPrev
        && s.index >= NEW_REGION_MIN_INDEX
        && reg.seen >= REGION_PERSIST_TICKS
        && tick - state.lastNewRegionTick >= NEW_REGION_COOLDOWN_TICKS
      ) {
        // 座標を更新した後の位置で EEW の範囲をもう一度見る。地域の代表点は毎フレーム動くため、
        // フレーム冒頭の一括判定は 1 フレーム前の位置に対する結果になっている。
        if (isRegionWithinAnyEew(reg, nowMs, activeEEWs)) {
          reg.absorbedByEew = true
        } else {
          reg.fired = true
          state.lastNewRegionTick = tick
          alert = { lat: s.lat, lng: s.lng, index: s.index }
        }
      }
    }
  }

  state.regions = state.regions.filter((r) => tick - r.lastTick <= REGION_PRUNE_TICKS)
  if (!anyConfirmed) resetEpisode(state)
  state.anyConfirmedPrev = anyConfirmed
  return alert
}

export interface KyoshinAlertsDeps {
  /** confirmed イベントが1件以上あるか（V3 検知の確定） */
  confirmed: boolean
  /** likely イベントが1件以上あるか（V3 検知の可能性・早期反応の駆動元） */
  candidate: boolean
  /** 主 likely イベントのメンバー観測点の最大インデックス（likely 中の音レベル追跡に使う） */
  candidateMaxIndex: number
  /** confirmed 各イベント（地域）の代表点＋最大インデックス（別地点発報の入力） */
  confirmedShocks: { lat: number; lng: number; index: number }[]
  /** 現フレームのデータ時刻文字列（毎フレーム更新される別地点発報エフェクトの駆動キー） */
  dataTime: string
  settings: AppSettings
  /** useAlertTitle の戻り値（ウィンドウタイトル操作 API） */
  title: AlertTitleApi
  /** cancelledAt 除外済みのアクティブ EEW（App 所有・毎レンダー更新） */
  activeEEWsRef: React.MutableRefObject<ReadonlyMap<string, EEWAlert>>
  /** アイドル復帰で戻すデフォルトタブ（App 所有・毎レンダー更新。デバッグログ用） */
  defaultTabRef: React.MutableRefObject<TabId>
  setActiveTab: (tab: TabId) => void
  revertToDefaultTab: () => void
}

export function useKyoshinAlerts(deps: KyoshinAlertsDeps) {
  const {
    confirmed, candidate, candidateMaxIndex, confirmedShocks, dataTime, settings, title,
    activeEEWsRef, defaultTabRef, setActiveTab, revertToDefaultTab,
  } = deps

  // confirmed 中はイベント自身のメンバー最大インデックス、likely 中は主候補イベントの最大インデックス。
  // 非検知時は音を鳴らさないため 0 でよい。
  const effectiveKyoshinMaxIndex = useMemo(() => {
    if (confirmed) return confirmedShocks.reduce((max, s) => Math.max(max, s.index), 0)
    if (candidate) return candidateMaxIndex
    return 0
  }, [confirmed, confirmedShocks, candidate, candidateMaxIndex])

  // 確定検知の開始/終了: realtime タブ＋タイトル＋通知音＋ブラウザ通知。
  const prevConfirmedRef = useRef(false)
  useEffect(() => {
    if (confirmed && !prevConfirmedRef.current) {
      log.info('[tab] → realtime (揺れ検知開始 V3 confirmed)')
      setActiveTab('realtime')
      title.setTitle('📈 揺れ検知')
      if (settings.soundEnabled) {
        playAlertSound('kyoshin')
      }
      if (settings.notifyMinScale >= 0 && settings.notifyDetection) {
        const label = kyoshinIndexToLabel(effectiveKyoshinMaxIndex) ?? '?'
        showBrowserNotification('揺れを検知中', `推定最大震度 ${label}（強震モニタ）`, 'kyoshin-detection')
      }
    } else if (!confirmed && prevConfirmedRef.current) {
      title.applyPriority({ kyoshinDetected: false })
      if (activeEEWsRef.current.size === 0) {
        log.info(`[tab] → ${defaultTabRef.current} (揺れ検知終了 V3)`)
        revertToDefaultTab()
      }
    }
    prevConfirmedRef.current = confirmed
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 音の再鳴を安定させるため依存は限定する
  }, [confirmed, effectiveKyoshinMaxIndex, settings.soundEnabled, settings.notifyDetection])

  // 可能性（likely）発生時の早期反応: タブ切替＋タイトル変更＋控えめな候補音のみ
  // （ブラウザ通知・フル音は確定時まで行わない）。確定（confirmed）に昇格した場合は上の
  // 検知開始エフェクトが引き継ぐため、ここでは confirmed が false のときだけを対象にする。
  const prevCandidateRef = useRef(false)
  useEffect(() => {
    if (candidate && !prevCandidateRef.current && !confirmed) {
      log.info('[tab] → realtime (揺れの可能性 V3 likely)')
      setActiveTab('realtime')
      title.setTitle('🔍 揺れの可能性')
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
        log.info(`[tab] → realtime (揺れ検知レベルアップ level=${prevMaxLevel}→${currLevel} confirmed=${confirmed})`)
        setActiveTab('realtime')
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
      log.info(`[tab] → realtime (揺れ検知再エスカレーション level=${prevMinLevel}→${currLevel} confirmed=${confirmed})`)
      setActiveTab('realtime')
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
    log.info('[tab] → realtime (別地点で揺れ検知 V3)')
    setActiveTab('realtime')
    if (settings.soundEnabled) playAlertSound('kyoshin')
    if (settings.notifyMinScale >= 0 && settings.notifyDetection) {
      // 全体の最大震度ではなく、発報した地域自身の推定震度を出す（「別の地点」の報せなので）
      const label = kyoshinIndexToLabel(alert.index) ?? '?'
      showBrowserNotification('別の地点で揺れを検知', `推定最大震度 ${label}（強震モニタ）`, 'kyoshin-detection-new')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataTime を毎フレーム駆動キーにし他は最新クロージャを参照
  }, [dataTime])
}
