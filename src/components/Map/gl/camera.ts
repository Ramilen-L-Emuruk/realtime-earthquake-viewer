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
import { createLogThrottle, log } from '../../../utils/logger'
import { ABSOLUTE_MAX_ZOOM, paneShortSidePx, REFERENCE_SHORT_SIDE_PX, zoomForSpanKm } from './viewSpan'

// カメラ操作の共通ヘルパ（MapLibre 版）。Leaflet の flyToLite/flyToBoundsLite 相当だが、
// flyTo 中のペイン非表示最適化（flyToLite.ts）は MapLibre では不要のため素の camera API を使う。
// Leaflet は duration を秒で受けるが MapLibre は ms のため *1000 する。座標は本アプリ共通の
// [lat,lng]（LatLng）で受け、MapLibre 用に [lng,lat] へ入れ替える。
// モード別のフィット（地震/EEW/検知/津波）は派生データに依存するため各レイヤーのフェーズで実装し、
// ここは基盤（定数＋汎用フィット）だけを提供する。
// 追従の目標範囲そのものの計算（矩形の合成・包含・有感半径クランプ）は maplibre 非依存の
// gl/bounds.ts が担い、ここはその結果を LngLatBounds へ変換して地図を動かす層に徹する。

// 旧 Leaflet 版の MapContainer は zoomSnap=0.5（da119cc JapanMap.tsx:950）で、fitBounds/flyToBounds の
// 着地ズームは常に 0.5 段階へ丸められていた。この「段階」がヒステリシスとなり、EEW 予報円が連続成長
// （実発報時 ~10/s）しても、再フィットは円が 0.5 レベルぶん育つまで発火せず頻発しなかった。
// MapLibre の fitBounds は分数ズームで円へぴったり合わせるため余白が無く、少しの成長で毎回はみ出し→
// 再フィットが頻発する（移行で失われたのは zoomSnap だけ・成長フォローの contains 判定は現行と同一）。
export const EEW_ZOOM_SNAP = 0.5

// 自動フィットが寄り切ったときに残す視野の広さ（短辺・km）。
//
// かつては上限をズーム値（`MAX_ZOOM = 7`）で持っていた。しかしズーム値は 1px あたりの実距離しか
// 表さないため、「震源の周りをどれだけ見せるか」が画面の大きさで変わってしまっていた（同じ単点の
// 地震でスマホは 181km・2K は 578km ＝ 震源が画に占める割合が 3 倍違う）。見せたいのは範囲そのもの
// なので視野の実距離で持ち、その端末での等価ズームは `fitMaxZoom` が返す（gl/viewSpan.ts）。
//
// 400km は基準ペイン（短辺 800px）で旧 `MAX_ZOOM = 7`（緯度 38 で約 482m/px・視野 385km）と
// ほぼ同じ画になる値。デスクトップの見え方を変えないことを基準に決めた。
export const FIT_MIN_SPAN_KM = 400

/**
 * この端末での自動フィットの寄り上限ズーム。ペインが大きいほど深くなる（＝画面の大きさに関わらず
 * `FIT_MIN_SPAN_KM` 相当の範囲が見える）。深すぎる寄りは `ABSOLUTE_MAX_ZOOM` でクランプする。
 *
 * **0.5 刻みへ丸めてから返す。** 上限そのものが刻みから外れていると、上限にクランプされた着地を
 * `snapZoomDown` がさらに 1 段引き下げてしまう（6.95 → 6.5 ＝ 意図より 36% 広い画）。刻みに乗せて
 * おけば切り下げが恒等になり、基準ペインでは従来どおり丸い 7.0 へ着地する。
 *
 * ペイン寸法に依存するため定数にできない。**評価は呼び出しごとに行うこと**（パネル境界のつまみ・
 * 画面回転・ウィンドウリサイズでペインは変わる）。
 * （`EEW_ZOOM_SNAP` と `snapZoomNearest` は下で定義。呼び出し時にしか読まないため順序は問題ない）
 */
export function fitMaxZoom(map: maplibregl.Map): number {
  return fitMaxZoomForPane(paneShortSidePx(map))
}

/** 短辺 shortSidePx のペインでの寄り上限ズーム。`fitMaxZoom` の実体（ペイン寸法を直接渡す形）。 */
export function fitMaxZoomForPane(shortSidePx: number): number {
  return Math.min(snapZoomNearest(zoomForSpanKm(FIT_MIN_SPAN_KM, shortSidePx), EEW_ZOOM_SNAP), ABSOLUTE_MAX_ZOOM)
}

/**
 * 基準ペイン（`REFERENCE_SHORT_SIDE_PX`）での寄り上限。
 *
 * 実際の判定には使わない（それは常に実ペイン寸法で換算する `fitMaxZoom`）。**端末に依らない
 * 代表値が必要な箇所だけ**が参照する——海底地形タイルの先読み範囲、地図がまだ生成されていない
 * 時点の既定値、定数どうしの関係を固定する回帰テスト（gl/zoomConstants.test.ts）。
 */
export const REFERENCE_FIT_MAX_ZOOM = fitMaxZoomForPane(REFERENCE_SHORT_SIDE_PX)
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
export function flyToPoint(map: maplibregl.Map, [lat, lng]: LatLng, zoom = fitMaxZoom(map), durationSec = 1.0): void {
  const duration = durationSec * 1000
  map.flyTo({ center: [lng, lat], zoom, duration }, beginProgrammaticFlight(map, duration))
}

/**
 * 座標群にフィットする（1 点なら flyTo）。padding は Leaflet の [px,px] 相当を一律 px で受ける。
 *
 * 着地ズームは `flyToBoundsSnapped` と同じく段階へ切り下げる（＝わずかにズームアウトして余白を残す）。
 * **分数ズームでぴったり寄せてはならない。** ぴったり寄せると目標の縁が画面の縁からちょうど
 * padding の位置に着地するため、同じ余白で「収まっているか」を見る成長フォロー
 * （`mapContainsBounds`）の判定が境界のちょうど上に乗る。境界一致は本来「収まっている」側だが
 * （`boundsContains` は `<=`）、着地ズームを解く経路（`cameraForBounds`）と判定側の逆投影
 * （`unproject`）は別々の浮動小数演算なので、境界では結果が保証されない。
 * 2026-08-21 にブラウザで実測したところ、寄り上限にクランプされない広さの点群（5°×4°・5°×5°・
 * 12°×11°）はいずれも余白の余裕が 0px で判定は「はみ出している」に転び、着地直後に必ず 1 段
 * 引き直されていた（寄りすぎた後にちょっと引く、二段のカメラ移動）。切り下げれば同じ 3 ケースで
 * 104〜110px の余裕が残る。
 */
export function fitToPositions(
  map: maplibregl.Map,
  positions: LatLng[],
  opts: { padding?: number; maxZoom?: number; durationSec?: number } = {},
): void {
  if (positions.length === 0) return
  const { padding = 48, maxZoom = fitMaxZoom(map), durationSec = 1.0 } = opts
  if (positions.length === 1) {
    // 1 点は退化した矩形（幅・高さ 0）で、着地は maxZoom へのクランプになる。段階へ切り下げる
    // 意味が無く、`cameraForBounds` に退化矩形を渡す必要も無いので flyTo で直接寄せる。
    flyToPoint(map, positions[0], maxZoom, durationSec)
    return
  }
  const bounds = new maplibregl.LngLatBounds()
  for (const [lat, lng] of positions) bounds.extend([lng, lat])
  flyToBoundsSnapped(map, bounds, { padding, maxZoom, durationSec })
}

/** bounds へ fitBounds する（duration 秒→ms）。 */
export function flyToBounds(
  map: maplibregl.Map,
  bounds: maplibregl.LngLatBounds,
  opts: { padding?: number; maxZoom?: number; durationSec?: number } = {},
): void {
  const { padding = 48, maxZoom = fitMaxZoom(map), durationSec = 1.0 } = opts
  const duration = durationSec * 1000
  map.fitBounds(bounds, { padding, maxZoom, duration }, beginProgrammaticFlight(map, duration))
}

/**
 * ズームを zoomStep 段階へ切り下げる（＝わずかにズームアウトして余白を残す）。
 * 浮動小数の 6.9999… が 6.5 に落ちるのを防ぐため、わずかなイプシロンを足してから floor する。
 *
 * `flyToBoundsSnapped` の着地ズームと、`refitDeltaForBounds`（寄り直して得られる段数）の双方が
 * この式を使う。片方だけ変えると「得られると計算した段数」と「実際の着地」がずれ、
 * 寄り直しの発火判定が着地後も成立し続けて無駄な fly を撃ち続ける。
 */
export function snapZoomDown(zoom: number, zoomStep: number = EEW_ZOOM_SNAP): number {
  return Math.floor((zoom + 1e-6) / zoomStep) * zoomStep
}

/**
 * ズームを zoomStep 段階の最も近い値へ丸める。視野基準で算出した寄り上限（`fitMaxZoom`）を
 * 刻みに乗せるためのもの。切り下げ（`snapZoomDown`）ではなく最近傍を使うのは、上限が刻みの
 * すぐ上にあるときに丸ごと 1 段損をしないため（基準ペインの 6.95 は 6.5 ではなく 7.0 が近い）。
 */
export function snapZoomNearest(zoom: number, zoomStep: number = EEW_ZOOM_SNAP): number {
  return Math.round(zoom / zoomStep) * zoomStep
}

// 切り下げ不能でフォールバックしたことの記録は間引く（下記フォールバック分岐の注記を参照）。
// フィットは繰り返し走るため素通しにするとログが埋まる。一度きりに絞らないのは、狭いペインが
// 直らない限り落ち続ける＝継続している障害なのに「一度失敗して直った」ように見えるため
// （`createLogThrottle` の方針そのもの）。間隔は他の 60 秒勢に揃える。
const FALLBACK_LOG_INTERVAL_MS = 60_000
const throttledSnapFallbackWarn = createLogThrottle(FALLBACK_LOG_INTERVAL_MS)

/**
 * bounds に合うズームを算出し zoomStep 段階へ切り下げて（＝わずかにズームアウトして余白を残して）fly する。
 * 旧 Leaflet の `getBoundsZoom(inside=false)`＋`zoomSnap` 相当のヒステリシスを再現する。
 */
export function flyToBoundsSnapped(
  map: maplibregl.Map,
  bounds: maplibregl.LngLatBounds,
  opts: { padding?: number; maxZoom?: number; durationSec?: number; zoomStep?: number } = {},
): void {
  const { padding = 48, maxZoom = fitMaxZoom(map), durationSec = 1.0, zoomStep = EEW_ZOOM_SNAP } = opts
  const duration = durationSec * 1000
  const cam = map.cameraForBounds(bounds, { padding, maxZoom })
  if (!cam || cam.zoom == null) {
    // cameraForBounds が算出不可なときは通常 fitBounds にフォールバック（分数ズーム）。
    // 実測: 算出を諦めるのは padding が地図ペインの実寸を超えたときだけ（MapLibre は判定用の
    // 縮尺が負になった場合のみ undefined を返す）。この経路では切り下げが効かないため、着地直後に
    // 成長フォローが「はみ出している」と読んで 1 段引き直す二段の動きが再発する。
    // 黙って落ちると原因を追えないので記録する。**ペインの実寸も添える**——発火条件はペインの
    // 実寸と padding の関係で決まり、padding だけでは「レイアウト前で 0×0 だった」のか
    // 「ユーザーがパネルを広げて地図が細くなった」のかを事後に区別できない。
    throttledSnapFallbackWarn(() => {
      const container = map.getContainer()
      log.warn(
        '[camera] 着地ズームを算出できずフィットにフォールバック（切り下げが効かない）',
        { padding, maxZoom, paneWidth: container.clientWidth, paneHeight: container.clientHeight },
      )
    })
    map.fitBounds(bounds, { padding, maxZoom, duration }, beginProgrammaticFlight(map, duration))
    return
  }
  map.flyTo({ center: cam.center, zoom: snapZoomDown(cam.zoom, zoomStep), duration }, beginProgrammaticFlight(map, duration))
}

/** いま bounds へ寄り直したら画がどれだけ変わるか（`refitDeltaForBounds` の戻り値）。 */
export interface RefitDelta {
  /** 寄り直したときのズームの深まり（段）。すでに着地ズームにいれば 0、目標が画からはみ出していれば負。 */
  zoomGain: number
  /** 寄り直したときの中心の移動量。地図ペインの短辺に対する比（0＝動かない、0.5＝短辺の半分ぶん動く）。 */
  centerShiftRatio: number
}

/**
 * いま `flyToBoundsSnapped` で bounds へ寄り直したら、画がどれだけ変わるか。算出できない場合は null。
 *
 * **どちらも「寄り直したあとは必ず 0 になる量」で測るのが要点。** 矩形の広さの比で測ると
 * padding（px）とビューポートのアスペクト比の影響が入り、地図ペインが小さい端末（スマホの
 * 上下分割など）では着地後にも「まだゆるい」と判定され続けて、無駄な fly を繰り返す。
 * ズームの利得も中心の移動量も、着地後は定義上 0 になるため、その往復が構造的に起きない。
 *
 * 2 つを返すのは、片方だけでは「画の変わり方」を測り切れないため。
 * - `zoomGain` は縮尺の差しか見ない。寄り上限（`fitMaxZoom`）に張り付いている状態では、目標が
 *   どこへ動いても利得は 0 前後に留まる（現在ズームと着地ズームの双方がクランプに当たる）。
 *   実測: 2026-07-17 大隅半島東方沖 M5.2 の再生で、ズーム 7 のまま約 2 分カメラが動かず、
 *   目標中心のずれだけが 42px → 247px（ペイン短辺の 31%）まで育った
 * - `centerShiftRatio` は位置のずれしか見ない。目標がその場で縮んだ場合は中心が動かないため 0 になる
 *
 * ズームの利得は `flyToBoundsSnapped` と同じ `snapZoomDown` を通す（着地ズームの式が食い違うと、
 * 「得られると計算した段数」と実際の着地がずれ、着地後も発火し続ける）。中心の移動量は
 * **現在のカメラの縮尺で** 測る（`map.project`）——いま見えている画がどれだけ飛ぶかを知りたいため。
 */
export function refitDeltaForBounds(
  map: maplibregl.Map,
  bounds: maplibregl.LngLatBounds,
  opts: { padding?: number; maxZoom?: number; zoomStep?: number } = {},
): RefitDelta | null {
  const { padding = 48, maxZoom = fitMaxZoom(map), zoomStep = EEW_ZOOM_SNAP } = opts
  const cam = map.cameraForBounds(bounds, { padding, maxZoom })
  if (!cam || !Number.isFinite(cam.zoom) || !cam.center) return null
  // ペインの実寸が取れない（レイアウト前・非表示）間は判定材料が揃わないので測らない。
  // ズームの利得も cameraForBounds がコンテナ寸法から逆算した値なので、片方だけ信じる根拠が無い。
  const container = map.getContainer()
  const minSide = Math.min(container.clientWidth, container.clientHeight)
  if (!(minSide > 0)) return null
  const from = map.project(map.getCenter())
  const to = map.project(cam.center)
  // 上流の座標が壊れていると（欠測値の混入等）ここまで NaN が伝わる。NaN は比較が常に false に
  // なるため、そのまま返すと閾値判定が「寄り直す価値あり」側へ倒れて無意味な飛行を繰り返す。
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return null
  return {
    zoomGain: snapZoomDown(cam.zoom as number, zoomStep) - map.getZoom(),
    centerShiftRatio: Math.hypot(to.x - from.x, to.y - from.y) / minSide,
  }
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

/**
 * 現在の表示範囲が target bounds を完全に含むか（成長フォローの「収まっているか」判定）。
 *
 * `marginPx` を渡すと、画面の縁からその幅だけ内側に入っていることを要求する。バッジで描く目標
 * （揺れ検知点）では、点が縁のちょうど上にあると丸が半分切れた状態で「収まっている」と判定されて
 * しまうため（2026-07-17 大隅半島東方沖の再生で実際に最上段のバッジが切れていた）。
 * 渡す値はフィットの padding に合わせること——フィット後は必ず padding ぶん内側に入るので、
 * 同じ値なら「寄り直した直後に再び収まっていないと判定される」往復が起きない。
 *
 * 目標が円や区域塗り（EEW 追従）の場合は縁に接していても切れて見えないため、既定の 0 で使う。
 */
export function mapContainsBounds(
  map: maplibregl.Map,
  target: maplibregl.LngLatBounds,
  marginPx = 0,
): boolean {
  const view = viewBoundsTuple(map, marginPx)
  return boundsContains(view, [
    target.getWest(),
    target.getSouth(),
    target.getEast(),
    target.getNorth(),
  ])
}

/**
 * 判定に使う表示範囲。`marginPx` が 0 なら `getBounds()` そのまま、正なら画面四隅から
 * その幅だけ内側の点を逆投影して縮めた範囲を返す。
 *
 * 余白がペインに対して大きすぎると（パネルを広げて地図が細くなった状態）内側の範囲が反転して
 * 常に「収まっていない」になり、毎秒フィットが走る。短辺の 2 割を上限に切り詰めて防ぐ。
 */
function viewBoundsTuple(map: maplibregl.Map, marginPx: number): BoundsTuple {
  const container = map.getContainer()
  const width = container.clientWidth
  const height = container.clientHeight
  // ペインの実寸が取れない（レイアウト前・非表示）間は内側へ詰めない。詰めると範囲が 1 点へ潰れて
  // 何を渡しても「収まっていない」になり、毎秒フィットが走る（`refitDeltaForBounds` が同じ条件で
  // 判定を見送るのと同じ考え方で、判定材料が揃わないときは動かさない側に倒す）。
  if (marginPx <= 0 || !(Math.min(width, height) > 0)) {
    const view = map.getBounds()
    return [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()]
  }
  const margin = Math.min(marginPx, Math.floor(Math.min(width, height) * 0.2))
  const nw = map.unproject([margin, margin])
  const se = map.unproject([width - margin, height - margin])
  return [nw.lng, se.lat, se.lng, nw.lat]
}

