import { useEffect, useRef } from 'react'
import { useMapGL } from './mapGLContext'
import type { LatLng } from '../../utils/stationCoords'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import type { EEWAlert } from '../../types/earthquake'
import type { PsWaveCircle } from '../../services/kyoshin'
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
  MAX_ZOOM,
} from './gl/camera'
import { log } from '../../utils/logger'

// MapLibre 版のカメラ自動追従群（Leaflet 版 JapanMap 内の Fit* コンポーネント相当）。
// Leaflet の flyToLite/flyToBoundsLite（ペイン非表示最適化）は MapLibre では不要のため
// gl/camera.ts の素の fit API を使う。座標は本アプリ共通の [lat,lng]。
// EEW 追従（idle 抑制つき・最も複雑）と津波追従は別ファイル（Camera-2）で扱う。

const dp2ll = (p: DetectedPoint): LatLng => [p.lat, p.lng]

// ── 地震モード: signature が変わったとき quakeFitPositions にフィットする ────────────
export function QuakeFitGL({ signature, positions }: { signature: string; positions: LatLng[] }) {
  const map = useMapGL()
  const lastFitRef = useRef<string>('')
  useEffect(() => {
    if (!map || !signature || positions.length === 0) return
    if (lastFitRef.current === signature) return
    lastFitRef.current = signature
    log.debug(`[mapGL] quake fit (${positions.length}点)`)
    fitToPositions(map, positions, { padding: 48, maxZoom: MAX_ZOOM, durationSec: 1.0 })
  }, [map, signature, positions])
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
// 初回（検知開始）は hasEew を無視して検知点へ寄せる。その後は検知点が画面からはみ出したときだけ
// 追い直す（1点増えるたびに動かさないよう flyToBoundsSnapped のズーム段階をヒステリシスに使う）。
export function FitToDetectionGL({ points, hasEew }: { points: DetectedPoint[]; hasEew: boolean }) {
  const map = useMapGL()
  const fittedRef = useRef(false)
  useEffect(() => {
    if (!map) return
    if (points.length === 0) {
      if (fittedRef.current) {
        fittedRef.current = false
        if (!hasEew) {
          log.debug('[mapGL] fitJapan (揺れ検知終了)')
          fitJapan(map, 1.0)
        }
      }
      return
    }
    if (!fittedRef.current) {
      fittedRef.current = true
      log.debug(`[mapGL] 揺れ検知フィット (${points.length}点)`)
      fitToPositions(map, points.map(dp2ll), { padding: 60, maxZoom: MAX_ZOOM, durationSec: 1.0 })
      return
    }
    // 検知範囲の成長追従。EEW 発報中は FitToEEWGL が「有感半径 ∪ 検知点」を追うため、ここでは追わない。
    // 両方が「自分の bounds がはみ出したら引く」を持つと目標が2つになり、互いに相手をはみ出させ合って
    // 振動する（ズーム段階のヒステリシスでは止まらない。目標同士が排他のため）。hasEew で持ち主を分ける。
    if (hasEew) return
    if (isProgrammaticFlight(map)) return
    const bounds = boundsFromPositions(points.map(dp2ll))
    if (!bounds || mapContainsBounds(map, bounds)) return
    log.debug(`[mapGL] 揺れ検知 成長フォロー (${points.length}点)`)
    flyToBoundsSnapped(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
  }, [map, points, hasEew])
  return null
}

// ── 候補クラスタが立った時点で候補点群にフィット（確定検知中は FitToDetection に委譲） ──
export function FitToCandidateGL({
  points,
  candidateId,
  hasEew,
  hasDetection,
}: {
  points: DetectedPoint[]
  candidateId: number | null
  hasEew: boolean
  hasDetection: boolean
}) {
  const map = useMapGL()
  const fittedIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (!map) return
    if (hasDetection) return
    if (candidateId === null) {
      if (fittedIdRef.current !== null) {
        fittedIdRef.current = null
        if (!hasEew) {
          log.debug('[mapGL] fitJapan (候補クラスタ失効)')
          fitJapan(map, 1.0)
        }
      }
      return
    }
    if (fittedIdRef.current === candidateId) return
    fittedIdRef.current = candidateId
    if (points.length === 0) return
    log.debug(`[mapGL] 候補クラスタフィット (${points.length}点 id=${candidateId})`)
    if (points.length === 1) {
      flyToPoint(map, dp2ll(points[0]), MAX_ZOOM, 1.0)
      return
    }
    fitToPositions(map, points.map(dp2ll), { padding: 60, maxZoom: MAX_ZOOM, durationSec: 1.0 })
  }, [map, points, candidateId, hasEew, hasDetection])
  return null
}

// ── EEW 追従（idle 抑制つき・最も複雑） ──────────────────────────────────────────
// 新規 EEW: 震源中心→予報円へフィット。解除: 検知中なら検知点、無ければ日本全体へ。
// ユーザーが手動でズーム/パンしたら idleRevertSec 秒間追従を停止（0=EEW更新まで）。
// 予報円の成長で表示に収まらなくなったらズームアウト追従する。
export function FitToEEWGL({
  eews,
  psWave,
  idleRevertSec = 30,
  detectedPoints = [],
}: {
  eews: EEWAlert[]
  psWave: PsWaveCircle[]
  idleRevertSec?: number
  detectedPoints?: DetectedPoint[]
}) {
  const map = useMapGL()
  const lastEewIdRef = useRef<string | null>(null)
  const userInteractedRef = useRef(false)
  const resetTimerRef = useRef<number | undefined>(undefined)
  const prevEewsCountRef = useRef<number>(0)
  const prevPsWaveCountRef = useRef<number>(0)

  // 最新 EEW（originTime 降順）を追従対象とする。
  const latest =
    eews.length > 0
      ? [...eews].sort((a, b) => b.earthquake.originTime.localeCompare(a.earthquake.originTime))[0]
      : null

  // 新規 EEW 受信 → 震源/波円へフィット。解除 → 検知点 or 日本全体へ。
  useEffect(() => {
    if (!map) return
    if (!latest) {
      if (lastEewIdRef.current !== null) {
        lastEewIdRef.current = null
        if (userInteractedRef.current) {
          log.debug('[mapGL] EEW解除 フィットスキップ (userInteracted)')
        } else if (detectedPoints.length > 0) {
          log.debug(`[mapGL] EEW解除・揺れ検知中 ${detectedPoints.length}点へフィット`)
          fitToPositions(map, detectedPoints.map(dp2ll), { padding: 60, maxZoom: MAX_ZOOM, durationSec: 1.0 })
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
    userInteractedRef.current = false
    window.clearTimeout(resetTimerRef.current)
    // 波円が既にあれば波円へ直接フィット（震源→波円のギクシャク防止）。
    const bounds = boundsFromCirclesForEewFollow(psWave)
    if (bounds) {
      log.debug(`[mapGL] EEW新規 波円${psWave.length}個へフィット`)
      flyToBoundsSnapped(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
      return
    }
    log.debug('[mapGL] EEW新規 震源へフィット')
    flyToPoint(map, [latitude, longitude], MAX_ZOOM, 0.8)
  }, [latest, map])

  // ユーザー手動操作の検知と idleRevertSec 秒後の追従再開。
  // isProgrammaticFlight(map) は gl/camera.ts の fit 系関数（このコンポーネント自身の呼び出しに限らず、
  // FitToDetectionGL/FitToCandidateGL/FitJapanOnEnterGL 等 同じ map を操作する他コンポーネントの呼び出しも
  // 含む）が起こした zoomstart/dragstart を除外する。私有 ref では自分の呼び出ししか除外できず、
  // 他コンポーネントの自動フィットをユーザー操作と誤認して追従を止めてしまっていたため。
  useEffect(() => {
    if (!map) return
    const onInteraction = () => {
      if (isProgrammaticFlight(map)) return
      userInteractedRef.current = true
      window.clearTimeout(resetTimerRef.current)
      if (idleRevertSec > 0) {
        resetTimerRef.current = window.setTimeout(() => {
          userInteractedRef.current = false
        }, idleRevertSec * 1000)
      }
    }
    map.on('zoomstart', onInteraction)
    map.on('dragstart', onInteraction)
    return () => {
      map.off('zoomstart', onInteraction)
      map.off('dragstart', onInteraction)
      window.clearTimeout(resetTimerRef.current)
    }
  }, [map, idleRevertSec])

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
    if (userInteractedRef.current) return

    const bounds = boundsFromCirclesForEewFollow(psWave)
    if (!bounds) {
      if (latest) {
        const { latitude, longitude } = latest.earthquake.hypocenter
        if (latitude > -200 && longitude > -200) {
          log.debug('[mapGL] EEW数減少・波円なし 震源へ再フィット')
          flyToPoint(map, [latitude, longitude], MAX_ZOOM, 0.8)
        }
      }
      return
    }
    log.debug(`[mapGL] EEW数減少・波円${psWave.length}個へ再フィット`)
    flyToBoundsSnapped(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
  }, [eews.length, psWave, latest, map])

  // 予報円と揺れ検知点の広がりに追従（表示に収まらなくなった時のみズームアウト）。
  // 目標は「有感半径 bounds ∪ 検知点」の単一 bounds。EEW 発報中の追従はこの効果が一手に引き受け、
  // FitToDetectionGL 側は hasEew で止まる（目標を2つにすると振動するため。boundsForLiveFollow 参照）。
  // psWave が空でも eews があれば検知点だけで追う。仮定震源要素・M不明・自動解除直後は円が作れず、
  // 以前はここで早期 return していたため「EEW は生きているのに誰も追わない」穴になっていた。
  // isProgrammaticFlight(map) により、他コンポーネントの自動フィットが進行中の間もこの効果は
  // 再フィットを待つ（同時に複数のカメラアニメーションが競合するのを避ける）。
  useEffect(() => {
    if (!map) return
    if (eews.length === 0) return
    if (userInteractedRef.current || isProgrammaticFlight(map)) return
    const bounds = boundsForLiveFollow(psWave, detectedPoints.map(dp2ll))
    if (bounds && !mapContainsBounds(map, bounds)) {
      log.debug(`[mapGL] EEW成長フォロー 波円${psWave.length}個+検知${detectedPoints.length}点`)
      flyToBoundsSnapped(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
    }
  }, [eews.length, psWave, detectedPoints, map])

  return null
}

// ── 津波モードのフィット（観測点更新優先・海岸線フォールバック） ──────────────────
export function TsunamiFitGL({
  mode,
  tsunamiSignature,
  tsunamiFitPositions,
  observationBars,
}: {
  mode: string
  tsunamiSignature: string
  tsunamiFitPositions: LatLng[]
  observationBars: { name: string; lat: number; lng: number; height: { value: number } }[]
}) {
  const map = useMapGL()
  const lastTsunamiSigRef = useRef<string>('')
  const prevObsMapRef = useRef<Map<string, number>>(new Map())
  const pendingObsPositionsRef = useRef<LatLng[]>([])
  const prevModeRef = useRef<string>(mode)

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
  }, [map, mode, tsunamiSignature, tsunamiFitPositions, observationBars])

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
