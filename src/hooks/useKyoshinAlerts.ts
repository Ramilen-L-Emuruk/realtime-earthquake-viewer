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
/** 別地点発報の最小間隔（フレーム）。分裂した確定が短時間に多発しても鳴らしすぎない。 */
const NEW_REGION_COOLDOWN_TICKS = 5
/** 別地点として発報する前に地域が持続すべきフレーム数（一過性フラグメント除去）。 */
const REGION_PERSIST_TICKS = 3
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
  const elapsedSec = (nowMs - originMs) / 1000
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return REGION_MATCH_KM
  return Math.max(REGION_MATCH_KM, computeSWaveRadiusAtTime(elapsedSec, depth) * DYNAMIC_THRESHOLD_SAFETY_FACTOR)
}

/** 座標が、指定した震源情報の動的閾値（S波伝播半径×安全マージン）以内にあるかを判定する。 */
function isWithinEewRadius(lat: number, lng: number, nowMs: number, eewInfo: NearestEewInfo): boolean {
  const elapsedSec = (nowMs - eewInfo.originTimeMs) / 1000
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return false
  const threshold = Math.max(REGION_MATCH_KM, computeSWaveRadiusAtTime(elapsedSec, eewInfo.depth) * DYNAMIC_THRESHOLD_SAFETY_FACTOR)
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
 * どの EEW でも満たさなければ、region の初検知時刻を基準にした近似（下限 REGION_MATCH_KM）で
 * 通常の距離判定にフォールバックする。
 */
export function isSameEarthquake(
  region: AlertRegion,
  sLat: number,
  sLng: number,
  nowMs: number,
  activeEEWs: ReadonlyMap<string, EEWAlert>,
): boolean {
  let anyEew = false
  for (const eew of activeEEWs.values()) {
    const info = extractEewInfo(eew)
    if (!info) continue
    anyEew = true
    if (isWithinEewRadius(region.lat, region.lng, nowMs, info) && isWithinEewRadius(sLat, sLng, nowMs, info)) return true
  }
  if (anyEew) return false
  return haversineKm(sLat, sLng, region.lat, region.lng) <= dynamicRegionThresholdKm(region, nowMs, null)
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
      log.debug('[tab] → realtime (揺れ検知開始 V3 confirmed)')
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
        log.debug(`[tab] → ${defaultTabRef.current} (揺れ検知終了 V3)`)
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
      log.debug('[tab] → realtime (揺れの可能性 V3 likely)')
      setActiveTab('realtime')
      title.setTitle('🔍 揺れの可能性')
      if (settings.soundEnabled) {
        playAlertSound('kyoshinCandidate')
      }
    } else if (!candidate && prevCandidateRef.current && !confirmed) {
      // 確定に昇格せず消えた場合のみ、静かに元へ戻す
      title.applyPriority({ kyoshinDetected: false })
      if (activeEEWsRef.current.size === 0) {
        log.debug(`[tab] → ${defaultTabRef.current} (揺れの可能性 失効 V3)`)
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
        log.debug(`[tab] → realtime (揺れ検知レベルアップ level=${prevMaxLevel}→${currLevel} confirmed=${confirmed})`)
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
      log.debug(`[tab] → realtime (揺れ検知再エスカレーション level=${prevMinLevel}→${currLevel} confirmed=${confirmed})`)
      setActiveTab('realtime')
      if (settings.soundEnabled) {
        playKyoshinUpdateSound(effectiveKyoshinMaxIndex, gainScale)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 音の再鳴を安定させるため依存は限定する
  }, [effectiveKyoshinMaxIndex, confirmed, candidate, settings.soundEnabled])

  // 別地点の地震: 検知中に、既存の確定地域から動的距離閾値（dynamicRegionThresholdKm）より
  // 離れた新地域が確定したら発報する（Scratch 前身のグリッド単位発報に相当。グローバル真偽の
  // 初検知だけでは進行中の別地点を鳴らせない）。
  // 一過性の分裂フラグメントで鳴らさないよう、持続（REGION_PERSIST_TICKS）＋クールダウンで抑制する。
  const regionsRef = useRef<AlertRegion[]>([])
  const tickRef = useRef(0)
  const lastNewRegionTickRef = useRef(-999)
  const anyConfirmedPrevRef = useRef(false)
  useEffect(() => {
    if (!dataTime) return
    const tick = ++tickRef.current
    const nowMs = new Date(dataTime).getTime()
    const shocks = confirmedShocks
    const anyConfirmed = shocks.length > 0

    for (const s of shocks) {
      let reg: AlertRegion | null = null
      let bestDist = Infinity
      for (const r of regionsRef.current) {
        if (!Number.isFinite(nowMs) || !isSameEarthquake(r, s.lat, s.lng, nowMs, activeEEWsRef.current)) continue
        const d = haversineKm(s.lat, s.lng, r.lat, r.lng)
        if (d < bestDist) { bestDist = d; reg = r }
      }
      if (!reg) {
        // 初検知フレームで生成された地域は初検知エフェクトが鳴らすため fired=true にして抑制する。
        regionsRef.current.push({
          lat: s.lat, lng: s.lng, seen: 1, fired: !anyConfirmedPrevRef.current, lastTick: tick,
          firstSeenAtMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
        })
      } else {
        reg.lat = s.lat
        reg.lng = s.lng
        reg.lastTick = tick
        reg.seen++
        if (
          !reg.fired && anyConfirmedPrevRef.current && reg.seen >= REGION_PERSIST_TICKS
          && tick - lastNewRegionTickRef.current >= NEW_REGION_COOLDOWN_TICKS
          // reg は毎フレーム自分自身の shock と距離ほぼ0でマッチし続けるため、seen は動的閾値の
          // 拡大とは無関係に積み上がる。発報の直前に、実は他の EEW の動的閾値内に収まっていない
          // かを再確認する（2026-08-10 検証: 北海道の遠方地域が、自己マッチにより動的閾値が
          // 追いつくより先に seen が REGION_PERSIST_TICKS へ到達し、誤発報された）。
          && (!Number.isFinite(nowMs) || !isRegionWithinAnyEew(reg, nowMs, activeEEWsRef.current))
        ) {
          reg.fired = true
          lastNewRegionTickRef.current = tick
          log.debug('[tab] → realtime (別地点で揺れ検知 V3)')
          setActiveTab('realtime')
          if (settings.soundEnabled) playAlertSound('kyoshin')
          if (settings.notifyMinScale >= 0 && settings.notifyDetection) {
            const label = kyoshinIndexToLabel(effectiveKyoshinMaxIndex) ?? '?'
            showBrowserNotification('別の地点で揺れを検知', `推定最大震度 ${label}（強震モニタ）`, 'kyoshin-detection-new')
          }
        }
      }
    }
    // 未発報の地域は、登録された瞬間の距離判定に固定されたまま（自分自身との距離が常に最小になる
    // ため、動的閾値が後から拡大しても他の地域と合流する機会がない）。動的閾値は時間とともに広がる
    // ため、登録時点ではわずかに届いていなくても、数秒後には EEW 震源の範囲内に収まることがある
    // （2026-08-10 能登半島地震リプレイ検証: 328km地点の地域が、登録3秒後には動的閾値が追いついて
    // いたにもかかわらず、登録時点の判定のまま「別地点」として確定してしまっていた）。ここで毎フレーム
    // 未発報の地域を再評価し、いずれかの EEW 震源の動的閾値内に収まっていれば静かに削除して吸収する。
    if (Number.isFinite(nowMs)) {
      regionsRef.current = regionsRef.current.filter((r) => r.fired || !isRegionWithinAnyEew(r, nowMs, activeEEWsRef.current))
    }
    regionsRef.current = regionsRef.current.filter((r) => tick - r.lastTick <= REGION_PRUNE_TICKS)
    if (!anyConfirmed) regionsRef.current = []
    anyConfirmedPrevRef.current = anyConfirmed
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataTime を毎フレーム駆動キーにし他は最新クロージャを参照
  }, [dataTime])
}
