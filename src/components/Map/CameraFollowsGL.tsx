import { useCallback, useEffect, useRef, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { LatLng } from '../../utils/stationCoords'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import type { EEWAlert } from '../../types/earthquake'
import type { PsWaveCircle } from '../../services/kyoshin'
import { computeEewCircle } from '../../hooks/usePsWaveCalc'
import { serverNow } from '../../utils/clock'
import {
  fitToPositions,
  fitJapan,
  flyToPoint,
  flyToBoundsSnapped,
  boundsFromCirclesForEewFollow,
  boundsForLiveFollow,
  boundsFromPositions,
  mapContainsBounds,
  isProgrammaticFlight,
  subscribeUserInteraction,
  DEFAULT_IDLE_REVERT_SEC,
  MAX_ZOOM,
} from './gl/camera'
import { log } from '../../utils/logger'

// MapLibre 版のカメラ自動追従群（Leaflet 版 JapanMap 内の Fit* コンポーネント相当）。
// Leaflet の flyToLite/flyToBoundsLite（ペイン非表示最適化）は MapLibre では不要のため
// gl/camera.ts の素の fit API を使う。座標は本アプリ共通の [lat,lng]。
// EEW 追従（idle 抑制つき・最も複雑）と津波追従は別ファイル（Camera-2）で扱う。

const dp2ll = (p: DetectedPoint): LatLng => [p.lat, p.lng]

// アクティブな EEW から震源座標（有効なものだけ）を抽出する。円がまだ無い EEW（仮定震源要素・
// 震源未確定・タイミング上まだ psWave に反映されていない新規 EEW）でも、追従 bounds に震源だけは
// 必ず含めるために使う（円のある EEW も含む。震源座標は円の box に包含されるため合成しても無害）。
function eewHypocenters(eews: EEWAlert[]): LatLng[] {
  const positions: LatLng[] = []
  for (const eew of eews) {
    const { latitude, longitude } = eew.earthquake.hypocenter
    if (latitude <= -200 || longitude <= -200) continue
    positions.push([latitude, longitude])
  }
  return positions
}

// ── ユーザー操作中判定の共有フック ───────────────────────────────────────────────
// zoomstart/dragstart を起点に「ユーザーが手動操作した」とみなし、idleRevertSec 秒間
// 操作が無ければ自動的に解除する。実体（リスナー登録・タイマー・isProgrammaticFlight 除外）は
// gl/camera.ts の subscribeUserInteraction が map 単位で一元管理し、複数の Fit* コンポーネントが
// 同じ map を購読しても zoomstart/dragstart の登録は 1 組だけになる。
// 戻り値は boolean の state（ref ではない）にしているのが要点: idleRevertSec 経過で
// interacting が false に戻った瞬間、これを deps に含む呼び出し側の useEffect が再実行される。
// ref 版だと「操作終了」を検知する再トリガーが無く、操作中に来た更新が再レンダリングの
// 機会を得られないまま永久にスキップされ続けてしまう（成長フォロー等のセルフヒール手段を
// 持たない QuakeFitGL/FitToCandidateGL で実際に問題になった）。
function useUserInteractionGuard(
  map: maplibregl.Map | null,
  idleRevertSec = DEFAULT_IDLE_REVERT_SEC,
): [boolean, () => void] {
  const [isInteracting, setIsInteracting] = useState(false)
  const resetRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!map) return
    const sub = subscribeUserInteraction(map, idleRevertSec, setIsInteracting)
    resetRef.current = sub.reset
    setIsInteracting(sub.isInteracting)
    return () => {
      sub.unsubscribe()
      resetRef.current = () => {}
    }
  }, [map, idleRevertSec])

  const reset = useCallback(() => resetRef.current(), [])

  return [isInteracting, reset]
}

// ── 地震モード: signature が変わったとき quakeFitPositions にフィットする ────────────
// selectionTick は「ユーザーが地震カード（または津波→地震リンク）を明示的にクリックした」
// 瞬間だけ App が +1 する単調増加カウンタ。電文受信ハンドラ（useLiveEventHandler）からも
// selectQuake は呼ばれるが、そちらは opts.explicit=false で呼ばれるため tick は進まない。
// selectionTick の変化で入ってきたフィットは isUserInteracting を無視して強制発火する
// （FitToEEWGL が新規 EEW 受信時に resetUserInteraction するのと同じ考え方）。
// signature だけが変わったフィット（電文更新で latest が変わった／取消フォールバック等）は
// 従来通り isUserInteracting を尊重し、ユーザーがズーム/パン中の勝手なジャンプを避ける。
//
// lastConsumedTickRef は「このコンポーネントが最後に処理した selectionTick の値」を保持する
// 状態。QuakeFitGL 自身の useRef ではなく親（JapanMapGL）が保有した ref を props で受け取る
// 設計にしている理由:
// QuakeFitGL は mode==='quake' の条件付きレンダー（JapanMapGL 内）で、タブ切替のたびに
// アンマウント/リマウントされる。もし ref を QuakeFitGL 自身に持たせると、リマウントのたびに
// 初期値へリセットされ、「App 側の selectionTick は既に非 0（過去に明示選択が起きていた）だが、
// このリマウントは単なるタブ復帰」というケースを区別できず、必ず explicit=true と誤判定して
// タブ復帰のたびに isUserInteracting を無視した強制フィットが走ってしまう。
// 親（JapanMapGL）は quake モード以外でも常時マウントされているため、その useRef はリマウントを
// またいで生存する。これにより「明示選択で tick が進んだ最初のフィットだけ explicit=true」
// という本来の意図が保たれる。
export function QuakeFitGL({
  signature,
  positions,
  selectionTick = 0,
  lastConsumedTickRef,
  idleRevertSec = DEFAULT_IDLE_REVERT_SEC,
}: {
  signature: string
  positions: LatLng[]
  selectionTick?: number
  lastConsumedTickRef: React.MutableRefObject<number>
  idleRevertSec?: number
}) {
  const map = useMapGL()
  const lastFitRef = useRef<string>('')
  const [isUserInteracting, resetUserInteraction] = useUserInteractionGuard(map, idleRevertSec)
  useEffect(() => {
    if (!map || !signature || positions.length === 0) return
    // ユーザーが明示的にカードを選んだか（selectionTick が進んだか）。tick が同じなら
    // 電文更新起点のフィットとして扱う（isUserInteracting を尊重）。
    const explicit = lastConsumedTickRef.current !== selectionTick
    lastConsumedTickRef.current = selectionTick
    // 自動フィットは signature 一致で再発火を抑制する。明示選択は同じ地震を再度選ぶケースも
    // あり得るため signature 一致でも通す（zoom で拡大→同じカードで戻す等）。
    if (!explicit && lastFitRef.current === signature) return
    // マーク確定は isUserInteracting 判定の後で行う。自動フィットが操作中に来ても lastFitRef を
    // 進めずに見送ることで、isUserInteracting が false に戻った時点の再レンダリング
    // （useUserInteractionGuard 参照）でこの effect が再実行され、同じ signature のまま
    // 取り戻せるようにする。
    if (!explicit && isUserInteracting) {
      log.debug('[mapGL] quake fit スキップ (userInteracting)')
      return
    }
    if (explicit) resetUserInteraction()
    lastFitRef.current = signature
    log.debug(`[mapGL] quake fit (${positions.length}点${explicit ? ' 明示選択' : ''})`)
    fitToPositions(map, positions, { padding: 48, maxZoom: MAX_ZOOM, durationSec: 1.0 })
    // lastConsumedTickRef は ref なので依存配列に入れない（参照の同一性は保たれる）。
  }, [map, signature, positions, selectionTick, isUserInteracting, resetUserInteraction])
  return null
}

// ── リアルタイム震度タブ入室時のリセット ────────────────────────────────────────
// マウント時（タブ入室時）に一度だけ実行する。検知中は FitToDetection に、EEW 中は FitToEEW に
// フレーミングを委ねてスキップ（FitToEEW はマウント時に必ず発火して波円/震源へ寄せる）。
// それ以外（他タブで寄った表示のリセット）は日本全体へ戻す。
export function FitJapanOnEnterGL({ hasEew, hasDetection }: { hasEew: boolean; hasDetection: boolean }) {
  const map = useMapGL()
  useEffect(() => {
    if (!map) return
    if (hasDetection) {
      log.debug('[mapGL] FitJapanOnEnter スキップ (揺れ検知中)')
      return
    }
    if (hasEew) {
      log.debug('[mapGL] FitJapanOnEnter スキップ (EEW発報中・FitToEEW に委譲)')
      return
    }
    log.debug('[mapGL] fitJapan (realtime 入室・EEWなし)')
    fitJapan(map, 1.0)
    // タブ入室時のみ（マウント時 1 回）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

// ── 揺れ検知点にフィットし、検知終了時は日本全体に戻す（EEW 中は戻さない） ──────────
// MAP-4 対応: 初回フィットも hasEew 時は FitToEEWGL に委譲してスキップする（従来は初回のみ
// hasEew を無視して検知点へ寄せていたが、EEW と同じコミットで発生する二段ジャンプを回避）。
// 以降は検知点が画面からはみ出したときだけ
// 追い直す（1点増えるたびに動かさないよう flyToBoundsSnapped のズーム段階をヒステリシスに使う）。
export function FitToDetectionGL({
  points,
  hasEew,
  idleRevertSec = DEFAULT_IDLE_REVERT_SEC,
}: {
  points: DetectedPoint[]
  hasEew: boolean
  idleRevertSec?: number
}) {
  const map = useMapGL()
  const fittedRef = useRef(false)
  const [isUserInteracting] = useUserInteractionGuard(map, idleRevertSec)
  useEffect(() => {
    if (!map) return
    if (points.length === 0) {
      if (fittedRef.current) {
        fittedRef.current = false
        if (!hasEew && !isUserInteracting) {
          log.debug('[mapGL] fitJapan (揺れ検知終了)')
          fitJapan(map, 1.0)
        }
      }
      return
    }
    if (!fittedRef.current) {
      // マーク確定は isUserInteracting 判定の後で行う（QuakeFitGL と同じ理由）。
      if (isUserInteracting) {
        log.debug('[mapGL] 揺れ検知フィット スキップ (userInteracting)')
        return
      }
      // MAP-4: EEW 発報中は FitToEEWGL に一任し、初回フィットも発火させない。
      // 従来は初回のみ hasEew を無視して検知点へ寄せていたため、EEW と検知が同一コミットで到着
      // した際にカメラが二段ジャンプしていた。fittedRef を立てるだけで実際の flyTo は EEW 終息後
      // に成長追従の分岐（下）に委ねる。
      if (hasEew) {
        log.debug('[mapGL] 揺れ検知フィット スキップ (EEW発報中・FitToEEW に委譲)')
        fittedRef.current = true
        return
      }
      fittedRef.current = true
      log.debug(`[mapGL] 揺れ検知フィット (${points.length}点)`)
      fitToPositions(map, points.map(dp2ll), { padding: 60, maxZoom: MAX_ZOOM, durationSec: 1.0 })
      return
    }
    // 検知範囲の成長追従。EEW 発報中は FitToEEWGL が「有感半径 ∪ 検知点」を追うため、ここでは追わない。
    // 両方が「自分の bounds がはみ出したら引く」を持つと目標が2つになり、互いに相手をはみ出させ合って
    // 振動する（ズーム段階のヒステリシスでは止まらない。目標同士が排他のため）。hasEew で持ち主を分ける。
    if (hasEew) return
    if (isProgrammaticFlight(map) || isUserInteracting) return
    const bounds = boundsFromPositions(points.map(dp2ll))
    if (!bounds || mapContainsBounds(map, bounds)) return
    log.debug(`[mapGL] 揺れ検知 成長フォロー (${points.length}点)`)
    flyToBoundsSnapped(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
  }, [map, points, hasEew, isUserInteracting])
  return null
}

// ── 候補クラスタが立った時点で候補点群にフィット（確定検知中は FitToDetection に委譲） ──
export function FitToCandidateGL({
  points,
  candidateId,
  hasEew,
  hasDetection,
  idleRevertSec = DEFAULT_IDLE_REVERT_SEC,
}: {
  points: DetectedPoint[]
  candidateId: number | null
  hasEew: boolean
  hasDetection: boolean
  idleRevertSec?: number
}) {
  const map = useMapGL()
  const fittedIdRef = useRef<number | null>(null)
  const [isUserInteracting] = useUserInteractionGuard(map, idleRevertSec)
  useEffect(() => {
    if (!map) return
    if (hasDetection) return
    if (candidateId === null) {
      if (fittedIdRef.current !== null) {
        fittedIdRef.current = null
        if (!hasEew && !isUserInteracting) {
          log.debug('[mapGL] fitJapan (候補クラスタ失効)')
          fitJapan(map, 1.0)
        }
      }
      return
    }
    if (fittedIdRef.current === candidateId) return
    if (points.length === 0) return
    // マーク確定は isUserInteracting 判定の後で行う（QuakeFitGL と同じ理由。候補クラスタは
    // 確定検知に育つまで同じ candidateId を保つため、ここで先にマークすると成長フォロー相当の
    // セルフヒール手段が無く、操作中に来た候補が永久にフィットされなくなる）。
    if (isUserInteracting) {
      log.debug(`[mapGL] 候補クラスタフィット スキップ (userInteracting, id=${candidateId})`)
      return
    }
    // EEW 発報中は FitToEEWGL に一任する（FitToDetectionGL の MAP-4 対応と同形）。候補点群の狭い範囲へ
    // 寄せても、EEW 側の追従は予想の区域塗りまで含む広い目標を持つため、次の判定で即座に引き直されて
    // 二段のカメラ移動になる。fittedIdRef だけ立てて実際の flyTo は見送る。
    //
    // 見送った候補は、EEW 解除時に FitToEEWGL の帰還先（検知点が無ければ候補点）が引き受ける。
    // ここは fittedIdRef を立てるため、同じ candidateId のままでは二度と発火しない（上の早期 return）。
    // 委譲した先に帰還経路が無いと、その候補クラスタは一度も画面に入らないまま終わる。
    if (hasEew) {
      log.debug(`[mapGL] 候補クラスタフィット スキップ (EEW発報中・FitToEEW に委譲, id=${candidateId})`)
      fittedIdRef.current = candidateId
      return
    }
    fittedIdRef.current = candidateId
    log.debug(`[mapGL] 候補クラスタフィット (${points.length}点 id=${candidateId})`)
    if (points.length === 1) {
      flyToPoint(map, dp2ll(points[0]), MAX_ZOOM, 1.0)
      return
    }
    fitToPositions(map, points.map(dp2ll), { padding: 60, maxZoom: MAX_ZOOM, durationSec: 1.0 })
  }, [map, points, candidateId, hasEew, hasDetection, isUserInteracting])
  return null
}

// 新規 EEW 受信直後、成長フォロー（下の useEffect）を抑制する時間。すでに検知点が広範囲な状態で
// 新規 EEW を受けても、まず EEW 自身（震源/波円）へのフォーカスを見せてから成長フォローに委ねる。
// 無いと、フォーカス直後に検知点が更新された瞬間、成長フォローが検知点全体を含む範囲へ即座に
// 引き直してしまい「一瞬 EEW にフォーカス→即ズームアウト」というちらつきになる。
const GROWTH_FOLLOW_SUPPRESS_MS = 3000

// ── EEW 追従（idle 抑制つき・最も複雑） ──────────────────────────────────────────
// 新規 EEW: 震源中心→予報円へフィット（第一報は震源近傍の寄りを見せたいため、予想の区域塗りは
// ここでは含めない）。解除: 検知中なら検知点、無ければ日本全体へ。
// ユーザーが手動でズーム/パンしたら idleRevertSec 秒間追従を停止（0=EEW更新まで）。
// 予報円の成長・予想の区域塗りの広がりで表示に収まらなくなったらズームアウト追従する。
export function FitToEEWGL({
  eews,
  psWave,
  idleRevertSec = DEFAULT_IDLE_REVERT_SEC,
  detectedPoints = [],
  candidatePoints = [],
  forecastAreaPositions = [],
}: {
  eews: EEWAlert[]
  psWave: PsWaveCircle[]
  idleRevertSec?: number
  detectedPoints?: DetectedPoint[]
  /**
   * 確定検知に育っていない候補クラスタの点群。EEW 解除時の帰還先としてのみ使う（検知点が無い場合）。
   * 発報中の追従（成長フォロー）には含めない——未確定の候補まで追うと、ノイズで立った候補のたびに
   * 画が広がってしまうため。
   */
  candidatePoints?: DetectedPoint[]
  /**
   * 予想の区域塗りが占める範囲（区域 bbox の南西・北東 2 点の列・`useEewLayerData` の `eewFitPositions`）。
   * 予想長周期地震動を表示中はそちらの区域に切り替わっている（描画側の visible と同じ分岐）。
   */
  forecastAreaPositions?: LatLng[]
}) {
  const map = useMapGL()
  const lastEewIdRef = useRef<string | null>(null)
  const [isUserInteracting, resetUserInteraction] = useUserInteractionGuard(map, idleRevertSec)
  const prevEewsCountRef = useRef<number>(0)
  const prevPsWaveCountRef = useRef<number>(0)
  const suppressGrowthUntilRef = useRef<number>(0)

  // 最新 EEW（originTime 降順）を追従対象とする。
  const latest =
    eews.length > 0
      ? [...eews].sort((a, b) => b.earthquake.originTime.localeCompare(a.earthquake.originTime))[0]
      : null

  // 新規 EEW 受信 → 震源/波円へフィット。解除 → 検知点 or 日本全体へ。
  // 新規 EEW 受信時は resetUserInteraction() でユーザー操作フラグを強制的に解除する。
  // 新しい警報が来た瞬間は操作中でも問答無用でフォーカスを見せる意図的な仕様
  // （他の Fit* と異なり「常に発火させる」側を選んでいる）。
  useEffect(() => {
    if (!map) return
    if (!latest) {
      if (lastEewIdRef.current !== null) {
        lastEewIdRef.current = null
        if (isUserInteracting) {
          log.debug('[mapGL] EEW解除 フィットスキップ (userInteracted)')
        } else if (detectedPoints.length > 0) {
          log.debug(`[mapGL] EEW解除・揺れ検知中 ${detectedPoints.length}点へフィット`)
          fitToPositions(map, detectedPoints.map(dp2ll), { padding: 60, maxZoom: MAX_ZOOM, durationSec: 1.0 })
        } else if (candidatePoints.length > 0) {
          // 確定検知には育っていない候補クラスタが残っている場合はそこへ帰る。EEW 発報中は
          // FitToCandidateGL がフィットを見送って（hasEew ガード）こちらに委譲しているため、
          // ここで受けないと「EEW 中に立った候補クラスタが一度も画面に入らない」穴になる。
          // FitToCandidateGL 側は candidateId ごとに一度しか発火しないので、あちらでは取り戻せない。
          log.debug(`[mapGL] EEW解除・候補クラスタ ${candidatePoints.length}点へフィット`)
          fitToPositions(map, candidatePoints.map(dp2ll), { padding: 60, maxZoom: MAX_ZOOM, durationSec: 1.0 })
        } else {
          log.debug('[mapGL] fitJapan (EEW解除)')
          fitJapan(map, 1.0)
        }
      }
      return
    }
    const { latitude, longitude } = latest.earthquake.hypocenter
    if (latitude <= -200 || longitude <= -200) return
    const eewEventId = latest.issue?.eventId ?? latest.id
    if (lastEewIdRef.current === eewEventId) return
    lastEewIdRef.current = eewEventId
    resetUserInteraction()
    suppressGrowthUntilRef.current = Date.now() + GROWTH_FOLLOW_SUPPRESS_MS
    // 波円が既にあれば波円へ直接フィット（震源→波円のギクシャク防止）。他に発報中の EEW があっても
    // それらの円は含めない。psWave prop は usePsWaveCalc が別 Effect で非同期に更新するため、新規 EEW
    // 受信直後のこのレンダーではまだ反映されていない（psWave.find に頼ると常に外れて震源フォールバック
    // に落ちてしまう）。ここでは psWave を待たず、その場で自身の円だけを直接計算する。
    const ownCircle = computeEewCircle(latest, serverNow())
    const bounds = ownCircle ? boundsFromCirclesForEewFollow([ownCircle]) : null
    if (bounds) {
      log.debug('[mapGL] EEW新規 自身の波円へフィット')
      flyToBoundsSnapped(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
      return
    }
    log.debug('[mapGL] EEW新規 震源へフィット')
    flyToPoint(map, [latitude, longitude], MAX_ZOOM, 0.8)
    // psWave/detectedPoints/candidatePoints は意図的に依存配列から外している。この effect は
    // 「新規 EEW を検知した瞬間」と「最後の EEW が消えた瞬間」だけに反応させたく、点群の変化では
    // 再実行させない（lastEewIdRef の実質的な等値チェックで弾かれるため deps に入れても害はないが、
    // 「latest（新規判定）に反応する effect」であることを deps だけで誤読させないための明示）。
    // 解除時の帰還先に使う点群は「latest が null になったレンダー時点の値」で十分。
  }, [latest, map, isUserInteracting, resetUserInteraction])

  // EEW 数 or 波円数が減少かつ残りがある場合: 残りへ強制再フィット。
  useEffect(() => {
    if (!map) return
    const prevCount = prevEewsCountRef.current
    const prevPsCount = prevPsWaveCountRef.current
    prevEewsCountRef.current = eews.length
    prevPsWaveCountRef.current = psWave.length
    const eewDecreased = eews.length < prevCount
    const psWaveDecreased = psWave.length < prevPsCount
    if (!eewDecreased && !psWaveDecreased) return
    if (eews.length === 0) return
    if (isUserInteracting) return

    // 円のある EEW は円の box、円が無い（仮定震源要素等の）EEW も震源座標一点は必ず含める
    // （円だけを見ると、その EEW が画面から取り残される）。
    // 目標は成長フォロー（下の useEffect）と同一にする。食い違わせると、ここで寄せた直後に成長フォローが
    // 引き直して二段のカメラ移動になる（予想の区域塗りは円より広いことが多く、差が常態化する）。
    const bounds = boundsForLiveFollow(
      psWave,
      eewHypocenters(eews),
      detectedPoints.map(dp2ll),
      forecastAreaPositions,
    )
    if (!bounds) {
      if (latest) {
        const { latitude, longitude } = latest.earthquake.hypocenter
        if (latitude > -200 && longitude > -200) {
          log.debug('[mapGL] EEW数減少・座標なし 震源へ再フィット')
          flyToPoint(map, [latitude, longitude], MAX_ZOOM, 0.8)
        }
      }
      return
    }
    log.debug(`[mapGL] EEW数減少・残り${eews.length}件へ再フィット`)
    flyToBoundsSnapped(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
  }, [eews, psWave, latest, map, isUserInteracting, detectedPoints, forecastAreaPositions])

  // 予報円・震源座標・揺れ検知点・予想の区域塗りの広がりに追従（表示に収まらなくなった時のみズームアウト）。
  // 目標は「有感半径 bounds ∪ 震源座標 ∪ 検知点 ∪ 予想の区域塗り」の単一 bounds。EEW 発報中の追従はこの
  // 効果が一手に引き受け、FitToDetectionGL・FitToCandidateGL 側は hasEew で止まる（目標を2つにすると
  // 振動するため。boundsForLiveFollow 参照）。円が無い（仮定震源要素・M不明・自動解除直後等の）EEW も
  // 震源座標一点は必ず含める。円だけを見ると、その EEW の震源が画面から取り残される穴になるため。
  // isProgrammaticFlight(map) により、他コンポーネントの自動フィットが進行中の間もこの効果は
  // 再フィットを待つ（同時に複数のカメラアニメーションが競合するのを避ける）。
  // 新規 EEW 受信直後は GROWTH_FOLLOW_SUPPRESS_MS の間、この効果自体を止める（上の useEffect 参照）。
  useEffect(() => {
    if (!map) return
    if (eews.length === 0) return
    if (isUserInteracting || isProgrammaticFlight(map)) return
    if (Date.now() < suppressGrowthUntilRef.current) return
    const bounds = boundsForLiveFollow(
      psWave,
      eewHypocenters(eews),
      detectedPoints.map(dp2ll),
      forecastAreaPositions,
    )
    if (bounds && !mapContainsBounds(map, bounds)) {
      // 区域数は 2 で割って求める（forecastAreaPositions は区域あたり bbox の 2 点。useEewLayerData 参照）。
      log.debug(
        `[mapGL] EEW成長フォロー 波円${psWave.length}個+震源${eews.length}件+検知${detectedPoints.length}点` +
          `+予想区域${forecastAreaPositions.length / 2}件`,
      )
      flyToBoundsSnapped(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
    }
  }, [eews, psWave, detectedPoints, forecastAreaPositions, map, isUserInteracting])

  return null
}

// ── 津波モードのフィット（観測点更新優先・海岸線フォールバック） ──────────────────
export function TsunamiFitGL({
  mode,
  tsunamiSignature,
  tsunamiFitPositions,
  observationBars,
  idleRevertSec = DEFAULT_IDLE_REVERT_SEC,
}: {
  mode: string
  tsunamiSignature: string
  tsunamiFitPositions: LatLng[]
  observationBars: { name: string; lat: number; lng: number; height: { value: number } }[]
  idleRevertSec?: number
}) {
  const map = useMapGL()
  const lastTsunamiSigRef = useRef<string>('')
  const prevObsMapRef = useRef<Map<string, number>>(new Map())
  const pendingObsPositionsRef = useRef<LatLng[]>([])
  const prevModeRef = useRef<string>(mode)
  const [isUserInteracting] = useUserInteractionGuard(map, idleRevertSec)

  useEffect(() => {
    if (!map) return
    const enteredTsunamiTab = mode === 'tsunami' && prevModeRef.current !== 'tsunami'
    prevModeRef.current = mode

    // Step 1: 更新された観測バーを検出しフラグへ。
    const prevMap = prevObsMapRef.current
    const updatedBars = observationBars.filter((b) => prevMap.get(b.name) !== b.height.value)
    const newMap = new Map<string, number>()
    for (const b of observationBars) newMap.set(b.name, b.height.value)
    prevObsMapRef.current = newMap
    if (updatedBars.length > 0) {
      pendingObsPositionsRef.current = updatedBars.map((b) => [b.lat, b.lng] as LatLng)
      lastTsunamiSigRef.current = tsunamiSignature // 海岸線 sig を消費して競合防止。
    }

    // Step 2: 津波タブのときだけフィット。
    if (mode !== 'tsunami') return
    if (isUserInteracting) return

    if (pendingObsPositionsRef.current.length > 0) {
      const positions = pendingObsPositionsRef.current
      pendingObsPositionsRef.current = []
      log.debug(`[mapGL] 津波フィット 観測点 ${positions.length}点`)
      fitToPositions(map, positions, { padding: 48, maxZoom: MAX_ZOOM, durationSec: 1.0 })
      return
    }
    if (tsunamiSignature && tsunamiSignature !== lastTsunamiSigRef.current && tsunamiFitPositions.length > 0) {
      lastTsunamiSigRef.current = tsunamiSignature
      log.debug(`[mapGL] 津波フィット 海岸線 ${tsunamiFitPositions.length}点`)
      fitToPositions(map, tsunamiFitPositions, { padding: 48, maxZoom: MAX_ZOOM, durationSec: 1.0 })
      return
    }
    // Step 3: 入室時に変化なし → フォールバック（海岸線 or 日本全体）。
    if (enteredTsunamiTab) {
      if (tsunamiFitPositions.length > 0) {
        log.debug('[mapGL] 津波フィット 入室・変化なし 海岸線')
        fitToPositions(map, tsunamiFitPositions, { padding: 48, maxZoom: MAX_ZOOM, durationSec: 1.0 })
      } else {
        log.debug('[mapGL] fitJapan (津波入室・変化なし・海岸線なし)')
        fitJapan(map, 1.0)
      }
    }
  }, [map, mode, tsunamiSignature, tsunamiFitPositions, observationBars, isUserInteracting])

  return null
}

// ── 津波観測行クリック時に該当観測点へ flyTo ──────────────────────────────────────
export function FocusObsGL({
  focusObsName,
  observationBars,
}: {
  focusObsName: { name: string; ts: number } | null
  observationBars: { name: string; lat: number; lng: number }[]
}) {
  const map = useMapGL()
  useEffect(() => {
    if (!map || !focusObsName) return
    const bar = observationBars.find((b) => b.name === focusObsName.name)
    if (!bar) return
    log.debug(`[mapGL] 観測点フォーカス flyTo ${bar.name}`)
    flyToPoint(map, [bar.lat, bar.lng], MAX_ZOOM, 1.0)
  }, [map, focusObsName, observationBars])
  return null
}
