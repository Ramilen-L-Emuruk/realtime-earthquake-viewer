import * as maplibregl from 'maplibre-gl'
import type { LatLng } from '../../../utils/stationCoords'
import {
  boundsContains,
  boundsForLiveFollowTuple,
  boundsFromEewCircles,
  boundsFromEewCirclesAndHypocenters,
  boundsFromPositionsTuple,
  JAPAN_BOUNDS,
  type BoundsTuple,
  type EewFollowCircle,
} from './bounds'

// カメラ操作の共通ヘルパ（MapLibre 版）。Leaflet の flyToLite/flyToBoundsLite 相当だが、
// flyTo 中のペイン非表示最適化（flyToLite.ts）は MapLibre では不要のため素の camera API を使う。
// Leaflet は duration を秒で受けるが MapLibre は ms のため *1000 する。座標は本アプリ共通の
// [lat,lng]（LatLng）で受け、MapLibre 用に [lng,lat] へ入れ替える。
// モード別のフィット（地震/EEW/検知/津波）は派生データに依存するため各レイヤーのフェーズで実装し、
// ここは基盤（定数＋汎用フィット）だけを提供する。
// 追従の目標範囲そのものの計算（矩形の合成・包含・有感半径クランプ）は maplibre 非依存の
// gl/bounds.ts が担い、ここはその結果を LngLatBounds へ変換して地図を動かす層に徹する。

// 自動フィットが寄る上限ズーム。
// Leaflet は 256px タイル基準、MapLibre GL JS は 512px タイル基準でズームレベルを数えるため、
// 同じ数値でも縮尺が 2 倍ずれる（MapLibre の z は Leaflet の z+1 相当）。移行時に Leaflet 版の
// MAX_ZOOM=8 をそのまま持ち込んでいたため、実際には旧 zoom 9 相当（緯度38で約239m/px）まで
// 寄っていた。7 が旧 MAX_ZOOM=8（同約478m/px）と同じ縮尺。
// 以降「マップズーム基準の閾値」は全てこの MapLibre 基準（512px タイル）で書く
// ＝ Leaflet 版から値を持ち込む際は 1 段引くこと（LabelsGL・useQuakeLayerData・QuakeHeatmapGL も同様）。
export const MAX_ZOOM = 7
// JapanMap.tsx の JAPAN_CENTER [lat,lng] を [lng,lat] へ。
export const JAPAN_CENTER: [number, number] = [137.7, 38.25]

// 「プログラムによるカメラ操作が進行中か」の共有状態。kyoshin モードでは FitJapanOnEnter／
// FitToCandidate／FitToDetection／FitToEEW が同じ map インスタンスを別々のコンポーネントから
// 操作するが、MapLibre の flyTo/fitBounds はプログラム操作でも zoomstart/dragstart を発火する。
// FitToEEW はこれらのイベントで「ユーザーが手動操作したか」を判定するため、各コンポーネントが
// 私有の ref で自分の操作だけを除外していると、他コンポーネントの自動フィットをユーザー操作と
// 誤認してしまう（実際の地震では EEW と揺れ検知が同時に動くため起きやすい）。ここに一元化し、
// このファイルの fit 系関数を呼ぶたびに立てることで、発生源を問わず判定できるようにする。
const programmaticFlights = new WeakMap<maplibregl.Map, number>()

function beginProgrammaticFlight(map: maplibregl.Map): void {
  programmaticFlights.set(map, (programmaticFlights.get(map) ?? 0) + 1)
  map.once('moveend', () => {
    programmaticFlights.set(map, Math.max(0, (programmaticFlights.get(map) ?? 1) - 1))
  })
}

/** 現在 map 上でこのファイルの fit 系関数によるカメラ操作が進行中か。 */
export function isProgrammaticFlight(map: maplibregl.Map): boolean {
  return (programmaticFlights.get(map) ?? 0) > 0
}

/** useUserInteractionGuard の idleRevertSec 既定値（秒）。設定タブ「自動復帰までの時間」の既定と揃える。 */
export const DEFAULT_IDLE_REVERT_SEC = 30

interface UserInteractionState {
  interacting: boolean
  timer: number | undefined
  idleRevertSec: number
  listeners: Set<(interacting: boolean) => void>
}

// kyoshin モードでは FitToCandidate／FitToDetection／FitToEEW が、津波モードでは TsunamiFitGL が
// 同じ map の zoomstart/dragstart を監視する。コンポーネントごとに個別のリスナーを張ると同じ
// イベントを N 回処理するだけで実害は無いが、判定ロジックを変える際に N 箇所のマウント順序を
// 意識する必要が出るため、map ごとに 1 組だけ登録し listeners 経由で購読者へ配る。
const userInteractionStates = new WeakMap<maplibregl.Map, UserInteractionState>()

function notifyInteraction(state: UserInteractionState, value: boolean): void {
  if (state.interacting === value) return
  state.interacting = value
  for (const listener of state.listeners) listener(value)
}

function ensureUserInteractionState(map: maplibregl.Map): UserInteractionState {
  const existing = userInteractionStates.get(map)
  if (existing) return existing
  const state: UserInteractionState = {
    interacting: false,
    timer: undefined,
    idleRevertSec: DEFAULT_IDLE_REVERT_SEC,
    listeners: new Set(),
  }
  // isProgrammaticFlight(map) で、このファイルの fit 系関数自身が起こした zoomstart/dragstart を除外する
  // （プログラムによる flyTo/fitBounds も同名イベントを発火するため、私有 ref では自分の呼び出ししか
  // 除外できず、他コンポーネントの自動フィットをユーザー操作と誤認してしまう）。
  const onInteraction = () => {
    if (isProgrammaticFlight(map)) return
    notifyInteraction(state, true)
    window.clearTimeout(state.timer)
    if (state.idleRevertSec > 0) {
      state.timer = window.setTimeout(() => notifyInteraction(state, false), state.idleRevertSec * 1000)
    }
  }
  map.on('zoomstart', onInteraction)
  map.on('dragstart', onInteraction)
  userInteractionStates.set(map, state)
  return state
}

/**
 * map 単位のユーザー操作状態を購読する。idleRevertSec は購読者間で共有され、最後に呼ばれた値が使われる
 * （本アプリでは全 Fit* コンポーネントに同じユーザー設定値を渡す想定のため競合しない）。
 * 戻り値の isInteracting は購読開始時点のスナップショット、reset は EEW 新規受信時のような
 * 強制解除に使う。interacting の変化は listener 呼び出しで通知する（購読側で再レンダリングを誘発する）。
 */
export function subscribeUserInteraction(
  map: maplibregl.Map,
  idleRevertSec: number,
  listener: (interacting: boolean) => void,
): { isInteracting: boolean; unsubscribe: () => void; reset: () => void } {
  const state = ensureUserInteractionState(map)
  state.idleRevertSec = idleRevertSec
  state.listeners.add(listener)
  return {
    isInteracting: state.interacting,
    unsubscribe: () => state.listeners.delete(listener),
    reset: () => {
      window.clearTimeout(state.timer)
      notifyInteraction(state, false)
    },
  }
}

/** 日本全体にフィットする（本アプリの既定フレーミング・padding 20）。 */
export function fitJapan(map: maplibregl.Map, durationSec = 1.0): void {
  beginProgrammaticFlight(map)
  map.fitBounds(JAPAN_BOUNDS, { padding: 20, duration: durationSec * 1000 })
}

/** 1 点へ flyTo する（[lat,lng] で受ける）。 */
export function flyToPoint(map: maplibregl.Map, [lat, lng]: LatLng, zoom = MAX_ZOOM, durationSec = 1.0): void {
  beginProgrammaticFlight(map)
  map.flyTo({ center: [lng, lat], zoom, duration: durationSec * 1000 })
}

/** 座標群にフィットする（1 点なら flyTo）。padding は Leaflet の [px,px] 相当を一律 px で受ける。 */
export function fitToPositions(
  map: maplibregl.Map,
  positions: LatLng[],
  opts: { padding?: number; maxZoom?: number; durationSec?: number } = {},
): void {
  if (positions.length === 0) return
  const { padding = 48, maxZoom = MAX_ZOOM, durationSec = 1.0 } = opts
  if (positions.length === 1) {
    flyToPoint(map, positions[0], maxZoom, durationSec)
    return
  }
  const bounds = new maplibregl.LngLatBounds()
  for (const [lat, lng] of positions) bounds.extend([lng, lat])
  beginProgrammaticFlight(map)
  map.fitBounds(bounds, { padding, maxZoom, duration: durationSec * 1000 })
}

/** bounds へ fitBounds する（duration 秒→ms）。 */
export function flyToBounds(
  map: maplibregl.Map,
  bounds: maplibregl.LngLatBounds,
  opts: { padding?: number; maxZoom?: number; durationSec?: number } = {},
): void {
  const { padding = 48, maxZoom = MAX_ZOOM, durationSec = 1.0 } = opts
  beginProgrammaticFlight(map)
  map.fitBounds(bounds, { padding, maxZoom, duration: durationSec * 1000 })
}

// 旧 Leaflet 版の MapContainer は zoomSnap=0.5（da119cc JapanMap.tsx:950）で、fitBounds/flyToBounds の
// 着地ズームは常に 0.5 段階へ丸められていた。この「段階」がヒステリシスとなり、EEW 予報円が連続成長
// （実発報時 ~10/s）しても、再フィットは円が 0.5 レベルぶん育つまで発火せず頻発しなかった。
// MapLibre の fitBounds は分数ズームで円へぴったり合わせるため余白が無く、少しの成長で毎回はみ出し→
// 再フィットが頻発する（移行で失われたのは zoomSnap だけ・成長フォローの contains 判定は現行と同一）。
export const EEW_ZOOM_SNAP = 0.5

/**
 * bounds に合うズームを算出し zoomStep 段階へ切り下げて（＝わずかにズームアウトして余白を残して）fly する。
 * 旧 Leaflet の `getBoundsZoom(inside=false)`＋`zoomSnap` 相当のヒステリシスを再現する。
 */
export function flyToBoundsSnapped(
  map: maplibregl.Map,
  bounds: maplibregl.LngLatBounds,
  opts: { padding?: number; maxZoom?: number; durationSec?: number; zoomStep?: number } = {},
): void {
  const { padding = 48, maxZoom = MAX_ZOOM, durationSec = 1.0, zoomStep = EEW_ZOOM_SNAP } = opts
  const cam = map.cameraForBounds(bounds, { padding, maxZoom })
  if (!cam || cam.zoom == null) {
    // cameraForBounds が算出不可なときは通常 fitBounds にフォールバック（分数ズーム）。
    beginProgrammaticFlight(map)
    map.fitBounds(bounds, { padding, maxZoom, duration: durationSec * 1000 })
    return
  }
  // 円が収まる最大ズームを zoomStep 段階へ切り下げる。浮動小数の 6.9999… が 6.5 に落ちるのを防ぐため
  // わずかなイプシロンを足してから floor する。
  const snappedZoom = Math.floor((cam.zoom + 1e-6) / zoomStep) * zoomStep
  beginProgrammaticFlight(map)
  map.flyTo({ center: cam.center, zoom: snappedZoom, duration: durationSec * 1000 })
}

/** BoundsTuple を maplibre の LngLatBounds へ。 */
export function toLngLatBounds(b: BoundsTuple): maplibregl.LngLatBounds {
  return new maplibregl.LngLatBounds([b[0], b[1]], [b[2], b[3]])
}

/** 座標群の外接 bounds（揺れ検知点の成長追従用）。空なら null。 */
export function boundsFromPositions(positions: LatLng[]): maplibregl.LngLatBounds | null {
  const b = boundsFromPositionsTuple(positions)
  return b ? toLngLatBounds(b) : null
}

/** EEW 予報円のみの追従 bounds（新規 EEW 受信時、自身の円単体へのフィット先）。算出根拠は gl/bounds.ts。 */
export function boundsFromCirclesForEewFollow(circles: EewFollowCircle[]): maplibregl.LngLatBounds | null {
  const b = boundsFromEewCircles(circles)
  return b ? toLngLatBounds(b) : null
}

/** EEW 予報円 ∪ 震源座標の追従 bounds（EEW 数/波円数減少時、残り全体へのフィット先）。
 * 円が無い（仮定震源要素等の）EEW が残っていても震源座標だけは含める。算出根拠は gl/bounds.ts。 */
export function boundsFromCirclesAndHypocentersForEewFollow(
  circles: EewFollowCircle[],
  hypocenters: LatLng[],
): maplibregl.LngLatBounds | null {
  const b = boundsFromEewCirclesAndHypocenters(circles, hypocenters)
  return b ? toLngLatBounds(b) : null
}

/** EEW 発報中のライブ追従 bounds（有感半径 ∪ 震源座標 ∪ 検知点）。合成する理由は gl/bounds.ts を参照。 */
export function boundsForLiveFollow(
  circles: EewFollowCircle[],
  hypocenters: LatLng[],
  detectedPositions: LatLng[],
): maplibregl.LngLatBounds | null {
  const b = boundsForLiveFollowTuple(circles, hypocenters, detectedPositions)
  return b ? toLngLatBounds(b) : null
}

// 現在の表示範囲が target bounds を完全に含むか（成長フォローの「収まっているか」判定）。
export function mapContainsBounds(map: maplibregl.Map, target: maplibregl.LngLatBounds): boolean {
  const view = map.getBounds()
  return boundsContains(
    [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()],
    [target.getWest(), target.getSouth(), target.getEast(), target.getNorth()],
  )
}
