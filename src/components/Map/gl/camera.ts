import * as maplibregl from 'maplibre-gl'
import type { LatLng } from '../../../utils/stationCoords'
import {
  boundsContains,
  boundsForLiveFollowTuple,
  boundsFromEewCircles,
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

// アプリ起点のカメラ操作（このファイルの fit 系関数）に付ける印。MapLibre は fly/fit へ渡した
// eventData を movestart/zoomstart/dragstart/moveend へそのままマージするため、受け手は
// 「自分たちが起こした動きか」をイベント自身から判別できる。
//
// kyoshin モードでは FitJapanOnEnter／FitToCandidate／FitToDetection／FitToEEW が同じ map を
// 別々のコンポーネントから操作し、MapLibre はプログラム操作でも zoomstart/dragstart を発火する。
// FitToEEW はこれらのイベントで「ユーザーが手動操作したか」を判定するため、自分たちのフィットを
// 確実に除外できないと、誰も触っていないのに追従が止まる。
interface AutoCameraEventData {
  /** アプリ起点である印。ユーザー操作との判別に使う。 */
  appAutoCamera: true
  /** 飛行ごとの通し番号。どの飛行が起こしたイベントかを見分ける。 */
  flightId: number
}

/** カメラ操作イベントがアプリ起点（このファイルの fit 系関数）のものか。 */
function isAutoCameraEvent(e: unknown): boolean {
  return (e as Partial<AutoCameraEventData> | null | undefined)?.appAutoCamera === true
}

// 飛行の完了は moveend で検出するが、タブ非表示などでアニメーションが進まないと moveend が来ず
// 「飛行中」が張り付く。duration にこの余裕を足した時刻を過ぎたら、moveend を待たず終了とみなす。
const FLIGHT_EXPIRY_MARGIN_MS = 2000

interface ProgrammaticFlightState {
  /** 最後に開始した飛行の通し番号。この番号を持つ moveend だけを「完了」とみなす。 */
  currentFlightId: number
  /** 飛行中とみなす期限（Date.now() 基準）。0 は飛行していない。 */
  activeUntil: number
  /** moveend リスナを登録済みか（map ごとに 1 本だけ張る）。 */
  listening: boolean
}

// 「プログラムによるカメラ操作が進行中か」の共有状態。上記のとおり複数のコンポーネントが同じ map を
// 操作するため、発生源を問わず 1 箇所で持つ。EEW の成長フォローが「飛行が終わるまで次のフィットを
// 待つ」判定に使う（同時に複数のカメラアニメーションが競合するのを避けるため）。
const programmaticFlights = new WeakMap<maplibregl.Map, ProgrammaticFlightState>()

/**
 * アプリ起点のカメラ操作を開始したことを記録し、fly/fit へ渡す eventData を返す。
 * 呼び出し側は必ずこの戻り値を MapLibre の fly/fit の eventData 引数に渡すこと
 * （渡し忘れると、その操作が起こす zoomstart がユーザー操作として扱われる）。
 */
function beginProgrammaticFlight(map: maplibregl.Map, durationMs: number): AutoCameraEventData {
  const state = programmaticFlights.get(map) ?? { currentFlightId: 0, activeUntil: 0, listening: false }
  programmaticFlights.set(map, state)
  const flightId = ++state.currentFlightId
  state.activeUntil = Date.now() + durationMs + FLIGHT_EXPIRY_MARGIN_MS
  if (!state.listening) {
    state.listening = true
    // 飛行が重なると、後発の fly/fit が先行の飛行を中断して moveend を起こす。その moveend は
    // 中断された側（＝古い flightId）を運ぶため、最新の飛行の完了とは区別できる。
    // 飛行ごとに once('moveend') を張ってカウンタを増減する方式では、1 回の moveend で溜まった
    // リスナが一斉に発火してカウンタが 0 まで落ち、まだ飛んでいるのに「終わった」と見えていた。
    map.on('moveend', (e: unknown) => {
      if ((e as Partial<AutoCameraEventData> | null | undefined)?.flightId !== state.currentFlightId) return
      state.activeUntil = 0
    })
  }
  return { appAutoCamera: true, flightId }
}

/**
 * 現在 map 上でこのファイルの fit 系関数によるカメラ操作が進行中か。
 *
 * 期限切れの判定は問い合わせ時に行うため、**この関数は期限を過ぎた飛行の状態を書き戻す**
 * （タイマーを別に持たず、参照された時点で遅延評価する）。呼び出し側から見た戻り値は
 * 何度呼んでも同じで、順序にも依存しない。
 */
export function isProgrammaticFlight(map: maplibregl.Map): boolean {
  const state = programmaticFlights.get(map)
  if (!state || state.activeUntil === 0) return false
  if (Date.now() > state.activeUntil) {
    state.activeUntil = 0
    return false
  }
  return true
}

// 地図を手動操作したあと、自動フィットを再開するまでの待ち時間。
//
// 設定「自動復帰までの時間」（タブの自動復帰）とは**切り離している**。以前はその設定値をそのまま
// 使っていたが、「無効」を選ぶと解除タイマーを張らないため、地図を一度触ると自動フィットが永久に
// 止まっていた。設定の意図（タブを勝手に切り替えさせない）と実際の副作用（地図も二度と動かない）が
// 食い違ううえ、明示的な解除を持たない追従（揺れ検知・津波）には復帰の手立てが無かった。
// 固定値にすることで、どの追従も必ずこの時間で復帰する（解除経路の有無に依存しなくなる）。
export const INTERACTION_HOLD_SEC = 30

interface UserInteractionState {
  interacting: boolean
  timer: number | undefined
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
    listeners: new Set(),
  }
  // このファイルの fit 系関数自身が起こした zoomstart/dragstart は eventData の印で除外する
  // （プログラムによる flyTo/fitBounds も同名イベントを発火するため）。
  //
  // 以前は「飛行中フラグ」（isProgrammaticFlight）で除外していたが、自動フィットが重なるとフラグが
  // 早期に落ちるため、自分のフィットが起こした zoomstart をユーザー操作と誤認していた。実地震では
  // EEW の直前に揺れ検知フィットが走るので必ず踏み、EEW のカメラ追従が抑制の保持時間ぶん丸ごと
  // 止まっていた（予想の区域塗りが画面外のまま放置される）。
  // 印はイベント自身が運ぶためフラグの状態に依存せず、自動フィット中のユーザー割り込みも取りこぼさない。
  const onInteraction = (e: unknown) => {
    if (isAutoCameraEvent(e)) return
    notifyInteraction(state, true)
    window.clearTimeout(state.timer)
    state.timer = window.setTimeout(() => notifyInteraction(state, false), INTERACTION_HOLD_SEC * 1000)
  }
  map.on('zoomstart', onInteraction)
  map.on('dragstart', onInteraction)
  userInteractionStates.set(map, state)
  return state
}

/**
 * map 単位のユーザー操作状態を購読する。抑制は `INTERACTION_HOLD_SEC` 経過で自動的に解ける。
 * 戻り値の isInteracting は購読開始時点のスナップショット、reset は EEW 新規受信時のような
 * 強制解除に使う。interacting の変化は listener 呼び出しで通知する（購読側で再レンダリングを誘発する）。
 */
export function subscribeUserInteraction(
  map: maplibregl.Map,
  listener: (interacting: boolean) => void,
): { isInteracting: boolean; unsubscribe: () => void; reset: () => void } {
  const state = ensureUserInteractionState(map)
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
  const duration = durationSec * 1000
  map.fitBounds(JAPAN_BOUNDS, { padding: 20, duration }, beginProgrammaticFlight(map, duration))
}

/** 1 点へ flyTo する（[lat,lng] で受ける）。 */
export function flyToPoint(map: maplibregl.Map, [lat, lng]: LatLng, zoom = MAX_ZOOM, durationSec = 1.0): void {
  const duration = durationSec * 1000
  map.flyTo({ center: [lng, lat], zoom, duration }, beginProgrammaticFlight(map, duration))
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
  const duration = durationSec * 1000
  map.fitBounds(bounds, { padding, maxZoom, duration }, beginProgrammaticFlight(map, duration))
}

/** bounds へ fitBounds する（duration 秒→ms）。 */
export function flyToBounds(
  map: maplibregl.Map,
  bounds: maplibregl.LngLatBounds,
  opts: { padding?: number; maxZoom?: number; durationSec?: number } = {},
): void {
  const { padding = 48, maxZoom = MAX_ZOOM, durationSec = 1.0 } = opts
  const duration = durationSec * 1000
  map.fitBounds(bounds, { padding, maxZoom, duration }, beginProgrammaticFlight(map, duration))
}

// 旧 Leaflet 版の MapContainer は zoomSnap=0.5（da119cc JapanMap.tsx:950）で、fitBounds/flyToBounds の
// 着地ズームは常に 0.5 段階へ丸められていた。この「段階」がヒステリシスとなり、EEW 予報円が連続成長
// （実発報時 ~10/s）しても、再フィットは円が 0.5 レベルぶん育つまで発火せず頻発しなかった。
// MapLibre の fitBounds は分数ズームで円へぴったり合わせるため余白が無く、少しの成長で毎回はみ出し→
// 再フィットが頻発する（移行で失われたのは zoomSnap だけ・成長フォローの contains 判定は現行と同一）。
export const EEW_ZOOM_SNAP = 0.5

/**
 * ズームを zoomStep 段階へ切り下げる（＝わずかにズームアウトして余白を残す）。
 * 浮動小数の 6.9999… が 6.5 に落ちるのを防ぐため、わずかなイプシロンを足してから floor する。
 *
 * `flyToBoundsSnapped` の着地ズームと、`zoomGainForBounds`（寄り直して得られる段数）の双方が
 * この式を使う。片方だけ変えると「得られると計算した段数」と「実際の着地」がずれ、
 * 寄り直しの発火判定が着地後も成立し続けて無駄な fly を撃ち続ける。
 */
export function snapZoomDown(zoom: number, zoomStep: number = EEW_ZOOM_SNAP): number {
  return Math.floor((zoom + 1e-6) / zoomStep) * zoomStep
}

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
  const duration = durationSec * 1000
  const cam = map.cameraForBounds(bounds, { padding, maxZoom })
  if (!cam || cam.zoom == null) {
    // cameraForBounds が算出不可なときは通常 fitBounds にフォールバック（分数ズーム）。
    map.fitBounds(bounds, { padding, maxZoom, duration }, beginProgrammaticFlight(map, duration))
    return
  }
  map.flyTo({ center: cam.center, zoom: snapZoomDown(cam.zoom, zoomStep), duration }, beginProgrammaticFlight(map, duration))
}

/**
 * いま `flyToBoundsSnapped` で bounds へ寄り直したら、ズームが何段深くなるか（現在ズームとの差）。
 * 算出できない場合は null。
 *
 * 「画が目標よりゆるいか」をこの差で測るのが要点。矩形の広さの比で測ると padding（px）と
 * ビューポートのアスペクト比の影響が入り、地図ペインが小さい端末（スマホの上下分割など）では
 * 着地後にも「まだゆるい」と判定され続けて、無駄な fly を繰り返す。ズームの利得で測れば
 * 着地後の利得は必ず 0 になるため、その往復が構造的に起きない。
 * 着地ズームの計算は `flyToBoundsSnapped` と同じ `snapZoomDown` を通す。
 */
export function zoomGainForBounds(
  map: maplibregl.Map,
  bounds: maplibregl.LngLatBounds,
  opts: { padding?: number; maxZoom?: number; zoomStep?: number } = {},
): number | null {
  const { padding = 48, maxZoom = MAX_ZOOM, zoomStep = EEW_ZOOM_SNAP } = opts
  const cam = map.cameraForBounds(bounds, { padding, maxZoom })
  if (!cam || cam.zoom == null) return null
  return snapZoomDown(cam.zoom, zoomStep) - map.getZoom()
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

/** EEW 発報中のライブ追従 bounds（有感半径 ∪ 震源座標 ∪ 検知点 ∪ 予想の区域塗り）。
 * EEW 数/波円数の減少時に残り全体へ再フィットする先も同じ目標を使う（目標が食い違うと、再フィットの
 * 直後に成長フォローが引き直して二段のカメラ移動になる）。合成する理由は gl/bounds.ts を参照。 */
export function boundsForLiveFollow(
  circles: EewFollowCircle[],
  hypocenters: LatLng[],
  detectedPositions: LatLng[],
  forecastAreaPositions: LatLng[] = [],
): maplibregl.LngLatBounds | null {
  const b = boundsForLiveFollowTuple(circles, hypocenters, detectedPositions, forecastAreaPositions)
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

