// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest'
import { createElement as h } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import type * as maplibregl from 'maplibre-gl'
import { MapGLContext } from './mapGLContext'
import { FitToCandidateGL, FitToDetectionGL, FitToEEWGL, TsunamiFitGL, FocusObsGL } from './CameraFollowsGL'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import type { LatLng } from '../../utils/stationCoords'
import type { EEWAlert } from '../../types/earthquake'
import type { ShakeFocus } from './mapTypes'
import type { PsWaveCircle } from '../../services/kyoshin'

// 「確定検知の終了」と「候補クラスタの継続」が重なる遷移を固定する回帰テスト。
// この組み合わせはタイミング依存で、実機（Playwright）では再現が難しい。過去に 2 度作り込んでいる:
//   1. 候補へ寄せた直後に、検知終了の fitJapan がそれを上書きして一瞬ちらつく
//   2. 1 を直す過程で、どちらのコンポーネントもカメラを動かさず、終了した検知の位置に取り残される
// カメラを動かす API の呼び出しだけを観測し、どちらの状態にも戻らないことを保証する。
//
// JSX を使わず createElement で組むのは、vitest の include が `src/**/*.test.ts` に限られており
// `.tsx` を拾わないため（既存の useReplayController.wiring.test.ts と同じ方針）。

// maplibre-gl の実体は jsdom ではロードできない（WebGL・Worker 依存でワーカーが応答しなくなる）。
// gl/camera.ts が実行時に使うのは LngLatBounds だけなので、矩形の合成と読み出しだけを持つ代替に差し替える。
vi.mock('maplibre-gl', () => {
  class FakeLngLatBounds {
    private west = Infinity
    private south = Infinity
    private east = -Infinity
    private north = -Infinity
    constructor(sw?: [number, number], ne?: [number, number]) {
      if (sw && ne) {
        this.west = sw[0]
        this.south = sw[1]
        this.east = ne[0]
        this.north = ne[1]
      }
    }
    extend([lng, lat]: [number, number]) {
      this.west = Math.min(this.west, lng)
      this.east = Math.max(this.east, lng)
      this.south = Math.min(this.south, lat)
      this.north = Math.max(this.north, lat)
      return this
    }
    getWest() {
      return this.west
    }
    getSouth() {
      return this.south
    }
    getEast() {
      return this.east
    }
    getNorth() {
      return this.north
    }
  }
  return { LngLatBounds: FakeLngLatBounds, default: { LngLatBounds: FakeLngLatBounds } }
})

// fitJapan は padding 20、点群へのフィット（fitToPositions / flyToBoundsSnapped）は padding 60 で
// 呼ばれる（gl/camera.ts の各既定値）。「日本全体へ戻した」のか「点群へ寄せた」のかの区別に使う。
const JAPAN_PADDING = 20
const POINTS_PADDING = 60

// 津波の俯瞰へ帰る猶予の長さ。gl/camera.ts の INTERACTION_HOLD_SEC と同値を独立に持つ
// （上の padding と同じ方針。実装側を変えたらこのテストが落ちて気づける）。
const INTERACTION_HOLD_SEC = 30

// maplibregl.Map を模したフェイク（gl/camera.test.ts と同じ方針）。カメラ操作系は spy にして
// 呼び出しを観測し、イベント API は登録と発火だけを再現する。
//
// 収め直しフォローは「寄り直したらズームが何段深まるか」と「中心がどれだけ動くか」で発火を
// 決める（`refitDeltaForBounds`）。着地後に両方が 0 になって発火が止まることまで検証したいので、
// カメラの状態（ズーム・中心）を実際に動かす。spy のままだと地図の状態が変わらず、実装が
// 往復していても気づけない。
//
// 投影は「経度・緯度 1 度 = PX_PER_DEG px」の線形モデルで代用する（本物は Mercator だが、
// 中心のずれを px で測り、画面の縁からの余白を判定できれば足りる）。視野・余白の判定も
// このモデルから導くため、フェイクの中で一貫する。
const PX_PER_DEG = 100
const PANE_WIDTH = 800
const PANE_HEIGHT = 600

// `fitZoom` は「いまの目標へ寄り直したら着地するズーム」。本物は矩形の広さとビューポート寸法から
// 逆算するが、フェイクの投影はズームに依らない（下記 PX_PER_DEG）ので、独立した数値として持つ。
// テストは検知範囲の広さの代わりにこの値を動かす——**範囲が狭まった** = 寄り直せば深く寄れる、を
// 表すのがこの値の役目（`setFitZoom`）。既定の 7 は基準ペインでの寄り上限に相当する値。
function createFakeMap({ zoom: initialZoom = 4, fitZoom: initialFitZoom = 7 }: { zoom?: number; fitZoom?: number } = {}) {
  const handlers = new Map<string, Set<(e?: unknown) => void>>()
  const onceHandlers = new Map<string, Set<(e?: unknown) => void>>()
  // 日本全体を見ている状態から始める（fitJapan 相当のズームと中心）。fit/fly で書き換わる。
  let zoom = initialZoom
  let fitZoom = initialFitZoom
  let center = { lng: 138, lat: 38 }
  /** フェイクの投影モデルにおける、いまの表示範囲（west, south, east, north）。 */
  const viewSpan = () => ({
    halfLng: PANE_WIDTH / 2 / PX_PER_DEG,
    halfLat: PANE_HEIGHT / 2 / PX_PER_DEG,
  })
  /**
   * 矩形の中心（本物の cameraForBounds が返す center 相当）。実装は矩形を 2 通りの形で渡す——
   * 点群からは LngLatBounds（上の vi.mock のフェイク）、日本全体は座標配列（`JAPAN_BOUNDS`）。
   */
  type FakeBoundsLike =
    | { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number }
    | [[number, number], [number, number]]
  const boundsCenter = (b: FakeBoundsLike): [number, number] => {
    const [west, south, east, north] = Array.isArray(b)
      ? [b[0][0], b[0][1], b[1][0], b[1][1]]
      : [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
    return [(west + east) / 2, (south + north) / 2]
  }
  const boundsWest = (b: FakeBoundsLike): number => (Array.isArray(b) ? b[0][0] : b.getWest())
  /**
   * カメラ操作の時系列。寄せ方は経路で違う——日本全体は `fitBounds`、点群は `cameraForBounds` で
   * 着地ズームを解いてから `flyTo`（`flyToBoundsSnapped`）、1 点は `flyTo` 直行。テストからは
   * 「いつ・どこへ・どの余白で寄せたか」の 1 本の列として見たいので、経路を問わずここへ積む。
   * `flyTo` からは目標の矩形が読めないため、直前に問われた矩形を受け渡して記録する。
   *
   * 受け渡しは中心の一致で照合する。`cameraForBounds` は寄り直しの**判定**（`refitDeltaForBounds`）
   * でも呼ばれ、そのときカメラは動かない。素朴に「直前の問い合わせ」を使うと、動かなかった判定の
   * 残骸を後続の別経路の `flyTo`（1 点への直行など）が拾って寄り先を偽る。
   */
  const moves: { padding?: number; west?: number }[] = []
  let pendingFit: { padding?: number; west: number; center: [number, number] } | null = null
  // 直近のカメラ操作へ渡されたイベントデータ（`beginProgrammaticFlight` の戻り値）。
  // `completeFlight` が moveend でそのまま返し、飛行ロックを解かせる。
  let lastFlightEventData: unknown = null
  const fake = {
    on(event: string, handler: (e?: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler)
    },
    off(event: string, handler: (e?: unknown) => void) {
      handlers.get(event)?.delete(handler)
    },
    once(event: string, handler: (e?: unknown) => void) {
      if (!onceHandlers.has(event)) onceHandlers.set(event, new Set())
      onceHandlers.get(event)!.add(handler)
    },
    // 第 2 引数はイベントデータ。**飛行の完了（moveend）を再現するために要る**——
    // `beginProgrammaticFlight` が張る moveend は `flightId` が一致する回だけ飛行ロックを解く。
    // 渡さないと本物の 0.8 秒に対して 2.8 秒（0.8＋`FLIGHT_EXPIRY_MARGIN_MS`）ロックが残り、
    // テストだけが実挙動より 2 秒鈍い状態になる。
    fire(event: string, data?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(data)
      const once = onceHandlers.get(event)
      if (once) {
        for (const handler of once) handler(data)
        once.clear()
      }
    },
    // 着地ズームは本物のように算出できない（ビューポート寸法と padding から逆算する処理を
    // フェイクに持たせても、それは実装の再実装になる）。中心だけ目標に合わせ、ズームは据え置く。
    fitBounds: vi.fn((bounds?: FakeBoundsLike, opts?: { padding?: number }, eventData?: unknown) => {
      lastFlightEventData = eventData ?? null
      if (bounds) {
        const [lng, lat] = boundsCenter(bounds)
        center = { lng, lat }
        moves.push({ padding: opts?.padding, west: boundsWest(bounds) })
      }
    }),
    flyTo: vi.fn((opts?: { zoom?: number; center?: [number, number] }, eventData?: unknown) => {
      lastFlightEventData = eventData ?? null
      if (typeof opts?.zoom === 'number') zoom = opts.zoom
      if (opts?.center) center = { lng: opts.center[0], lat: opts.center[1] }
      const fit =
        pendingFit && opts?.center
        && pendingFit.center[0] === opts.center[0] && pendingFit.center[1] === opts.center[1]
          ? { padding: pendingFit.padding, west: pendingFit.west }
          : {}
      pendingFit = null
      moves.push(fit)
    }),
    getZoom: () => zoom,
    getCenter: () => center,
    // フィット系は現在の回転を保つため bearing を読む（渡さないと MapLibre が 0 を当てて回転が消える）。
    getBearing: () => 0,
    getContainer: () => ({ clientWidth: PANE_WIDTH, clientHeight: PANE_HEIGHT }),
    project: (ll: [number, number] | { lng: number; lat: number }) => {
      const lng = Array.isArray(ll) ? ll[0] : ll.lng
      const lat = Array.isArray(ll) ? ll[1] : ll.lat
      return {
        x: PANE_WIDTH / 2 + (lng - center.lng) * PX_PER_DEG,
        y: PANE_HEIGHT / 2 - (lat - center.lat) * PX_PER_DEG,
      }
    },
    // MapLibre の unproject は `Point`（project の戻り値）も配列も受ける。
    // **両方受けること**——`mapContainsBounds` は project の戻り値をそのまま渡して往復させ、
    // 戻り値のずれで「球の裏側か」を見分けている（配列しか受けないと NaN になって常に裏側扱い）。
    unproject: (pt: [number, number] | { x: number; y: number }) => {
      const x = Array.isArray(pt) ? pt[0] : pt.x
      const y = Array.isArray(pt) ? pt[1] : pt.y
      return {
        lng: center.lng + (x - PANE_WIDTH / 2) / PX_PER_DEG,
        lat: center.lat - (y - PANE_HEIGHT / 2) / PX_PER_DEG,
      }
    },
    getBounds: () => {
      const { halfLng, halfLat } = viewSpan()
      return {
        getWest: () => center.lng - halfLng,
        getSouth: () => center.lat - halfLat,
        getEast: () => center.lng + halfLng,
        getNorth: () => center.lat + halfLat,
      }
    },
    // 着地ズームは `fitZoom`（上記）を返す。中心は本物と同じく目標の中心を返す
    // （収め直しフォローの「中心の移動量」がこれで決まる）。
    cameraForBounds: (bounds: FakeBoundsLike, opts?: { padding?: number }) => {
      const target = boundsCenter(bounds)
      pendingFit = { padding: opts?.padding, west: boundsWest(bounds), center: target }
      return { center: target, zoom: fitZoom }
    },
    moves,
    /** 検知範囲が狭まって（広がって）、寄り直しの着地が深く（浅く）なった状況を作る。 */
    setFitZoom: (z: number) => {
      fitZoom = z
    },
    /**
     * 直近のカメラ操作が着地したことにする（moveend）。飛行ロックが解けるので、続く評価が
     * 実機と同じタイミングで走る。**時間を進めるだけでは代用できない**——ロックの期限切れは
     * 飛行時間より 2 秒遅く、その間に起きるはずの追従がテストでは起きない。
     */
    completeFlight: () => {
      if (lastFlightEventData) fake.fire('moveend', lastFlightEventData)
    },
  }
  return fake as unknown as maplibregl.Map & {
    fire: (event: string, data?: unknown) => void
    moves: { padding?: number; west?: number }[]
    setFitZoom: (z: number) => void
    completeFlight: () => void
  }
}

const dp = (lat: number, lng: number): DetectedPoint => ({ key: `${lat},${lng}`, lat, lng, index: 20 })

type FakeMap = maplibregl.Map & {
  moves: { padding?: number; west?: number }[]
  completeFlight: () => void
}

/**
 * カメラ操作ごとの padding。どの経路が呼ばれたかの判別に使う（日本全体＝20 / 点群＝60）。
 * 経路（fitBounds / flyTo）に依らず操作の順に並ぶ（フェイクの `moves` 参照）。
 */
function fitPaddings(map: maplibregl.Map): (number | undefined)[] {
  return (map as FakeMap).moves.map((m) => m.padding)
}

/** カメラ操作の回数（初回フィットもフォローも数える）。 */
function moveCount(map: maplibregl.Map): number {
  return (map as FakeMap).moves.length
}

// JapanMapGL と同じ順序で置く（effect はツリー順に走るため、順序に意味がある）。
// hasDetection は既定で「寄り先の点があるか」から導くが、JapanMapGL では別の集合から来る
// （寄り先＝描かれている点／hasDetection＝メンバーの和集合）。両者が食い違う状態を作れるよう
// 明示的に上書きできるようにしている。
function harness(
  map: maplibregl.Map,
  detected: DetectedPoint[],
  candidate: DetectedPoint[],
  candidateId: number | null,
  opts: {
    hasDetection?: boolean
    hasEew?: boolean
    shakeFocus?: ShakeFocus | null
    focusTickRef?: { current: number }
  } = {},
) {
  const hasDetection = opts.hasDetection ?? detected.length > 0
  const hasEew = opts.hasEew ?? false
  return h(
    MapGLContext.Provider,
    { value: map },
    h(FitToCandidateGL, {
      points: candidate,
      candidateId,
      hasEew,
      hasDetection,
    }),
    h(FitToDetectionGL, {
      points: detected,
      hasDetection,
      hasEew,
      hasCandidate: candidateId !== null && candidate.length > 0,
      shakeFocus: opts.shakeFocus ?? null,
      // 消費済み連番の記録は本来 JapanMapGL が持つ（マウントをまたいで残す必要があるため）。
      // 渡さないテストは要求も出さないので、その場限りの入れ物で足りる。
      lastConsumedFocusTickRef: opts.focusTickRef ?? { current: 0 },
    }),
  )
}

afterEach(cleanup)

describe('確定検知の終了と候補クラスタの協調', () => {
  it('候補クラスタが残っていれば、日本全体へ戻さず候補へ寄り直す', () => {
    // Arrange: 候補 A が単独で立ち、そこへフィットしている状態を作る。
    const map = createFakeMap()
    const candidate = [dp(37.0, 140.0), dp(37.5, 140.5)]
    const detected = [dp(35.0, 139.0), dp(35.5, 139.5)]
    const view = render(harness(map, [], candidate, 1))
    map.fire('moveend')
    expect(fitPaddings(map)).toContain(POINTS_PADDING)

    // Act 1: 別クラスタが確定検知に育つ。候補側は hasDetection で無効化され、フィット済みの印が凍結される。
    view.rerender(harness(map, detected, candidate, 1))
    map.fire('moveend')

    // Act 2: 確定検知だけが終わる。候補 A はまだ生きている。
    const before = fitPaddings(map).length
    view.rerender(harness(map, [], candidate, 1))
    map.fire('moveend')

    // Assert: 新しいフィットが起き、それは日本全体ではない（＝取り残されず、かつちらつかせない）。
    const added = fitPaddings(map).slice(before)
    expect(added).toContain(POINTS_PADDING)
    expect(added).not.toContain(JAPAN_PADDING)
  })

  it('候補クラスタが無ければ、確定検知の終了で日本全体へ戻す', () => {
    // Arrange: 確定検知だけがある状態。
    const map = createFakeMap()
    const detected = [dp(35.0, 139.0), dp(35.5, 139.5)]
    const view = render(harness(map, detected, [], null))
    map.fire('moveend')

    // Act: 検知が終わる。
    const before = fitPaddings(map).length
    view.rerender(harness(map, [], [], null))
    map.fire('moveend')

    // Assert: 日本全体へ戻る（候補を待たない）。
    expect(fitPaddings(map).slice(before)).toContain(JAPAN_PADDING)
  })
})

// ── 収め直しフォロー（収まってはいるが画が目標に合っていないときに寄り直す） ──────────
// 成長フォローは「はみ出したら引く」しか持たないため、これが無いと画がずれたまま固まる。実測:
//   - 範囲が狭まった場合: 2024-01-01 能登の再生で、描かれている検知点が 872→70 に減っても
//     画は 8 分以上 z4 の全国のままで寄り直しは一度も起きなかった
//   - 範囲が移動した場合: 2026-07-17 大隅半島東方沖の再生で、ズーム 7 のままカメラが約 2 分動かず、
//     目標中心のずれが 42px → 247px（ペイン短辺の 31%）まで育った（下記「別の場所へ移った」）
//
// 保持時間はコンポーネント内で Date.now() の差分として数えるため、フェイクタイマーで進める。
describe('揺れ検知の収め直しフォロー', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // 狭い点群（フェイク Map の視野＝中心 ±4 度／±3 度に対して十分小さい）。
  const NARROW = [dp(37.0, 137.0), dp(37.1, 137.2)]
  // NARROW から東へ 2 度（フェイクの投影で 200px＝ペイン短辺 600px の 33%）移った点群。
  // 画には収まったままなので成長フォローは働かず、寄り上限にいるためズームの利得も 0 になる。
  const MOVED = [dp(37.0, 139.0), dp(37.1, 139.2)]
  // 東へ 0.5 度（50px＝短辺の 8%）だけずれた点群。閾値（20%）に届かない側の対照。
  const NUDGED = [dp(37.0, 137.5), dp(37.1, 137.7)]
  // 初回フィットの飛行が「進行中」でなくなるまでの待ち（durationSec 1.0 ＋ 飛行期限マージン 2 秒）。
  const AFTER_FLIGHT_MS = 4000

  it('ゆるい状態が保持時間だけ続いたら、狭まった検知点へ寄り直す', () => {
    // Arrange: 揺れが広範囲に出て、全国規模の画（z4）へフィットしたところ。
    const map = createFakeMap({ fitZoom: 4 })
    const view = render(harness(map, NARROW, [], null))
    expect(fitPaddings(map)).toEqual([POINTS_PADDING])

    // Act 1: 揺れが収まって範囲が狭まり、寄り直せば 3 段深く寄れる状態になる。観測値の更新
    // （＝毎秒の再評価）で「ゆるい」と判定させる。最初の 1 回は時刻を記録するだけ。
    map.setFitZoom(7)
    act(() => {
      vi.advanceTimersByTime(AFTER_FLIGHT_MS)
    })
    view.rerender(harness(map, [...NARROW], [], null))
    expect(moveCount(map)).toBe(1)

    // Act 2: ゆるいまま保持時間を超える。
    act(() => {
      vi.advanceTimersByTime(9000)
    })
    view.rerender(harness(map, [...NARROW], [], null))

    // Assert: 点群へ寄り直す（日本全体へは戻さない）。
    expect(fitPaddings(map)).toEqual([POINTS_PADDING, POINTS_PADDING])
  })

  it('一瞬ゆるくなっただけでは寄り直さない', () => {
    // Arrange: 上と同じ状態から始める（広い画へフィット後、範囲が狭まってゆるくなる）。
    const map = createFakeMap({ fitZoom: 4 })
    const view = render(harness(map, NARROW, [], null))
    map.setFitZoom(7)
    act(() => {
      vi.advanceTimersByTime(AFTER_FLIGHT_MS)
    })
    view.rerender(harness(map, [...NARROW], [], null))

    // Act: 保持時間に届かないうちに再評価する。
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    view.rerender(harness(map, [...NARROW], [], null))

    // Assert: 寄り直しは起きない（余震や表面波の再来で範囲は数秒単位で上下するため、
    // 一瞬の狭まりに追従するとカメラが落ち着かない）。初回フィットの 1 回から増えない。
    expect(moveCount(map)).toBe(1)
  })

  it('ユーザー操作を挟んだら待ち時間を数え直す（抑制が明けた瞬間にスナップしない）', () => {
    // Arrange: ゆるさの待ちが始まったところ。
    const map = createFakeMap({ fitZoom: 4 })
    const view = render(harness(map, NARROW, [], null))
    map.setFitZoom(7)
    act(() => {
      vi.advanceTimersByTime(AFTER_FLIGHT_MS)
    })
    view.rerender(harness(map, [...NARROW], [], null))

    // Act 1: ユーザーが地図を触る（抑制は INTERACTION_HOLD_SEC で自動的に明ける）。
    act(() => {
      map.fire('zoomstart')
    })
    act(() => {
      vi.advanceTimersByTime(INTERACTION_HOLD_SEC * 1000)
    })
    view.rerender(harness(map, [...NARROW], [], null))

    // Assert: 抑制が明けた直後には寄り直さない。操作前の待ちを持ち越すと、ユーザーが手を離した
    // 瞬間にカメラがスナップする（待ち時間を入れた意図が消える）。
    expect(moveCount(map)).toBe(1)

    // Act 2: あらためて待ち時間ぶん経過する。
    act(() => {
      vi.advanceTimersByTime(9000)
    })
    view.rerender(harness(map, [...NARROW], [], null))

    // Assert: ここで初めて寄り直す。
    expect(moveCount(map)).toBe(2)
  })

  it('寄り直した後は、同じ目標のままなら二度と発火しない（往復しない）', () => {
    // Arrange: 一度寄り直したところまで進める。
    const map = createFakeMap({ fitZoom: 4 })
    const view = render(harness(map, NARROW, [], null))
    map.setFitZoom(7)
    act(() => {
      vi.advanceTimersByTime(AFTER_FLIGHT_MS)
    })
    view.rerender(harness(map, [...NARROW], [], null))
    act(() => {
      vi.advanceTimersByTime(9000)
    })
    view.rerender(harness(map, [...NARROW], [], null))
    expect(moveCount(map)).toBe(2)

    // Act: 目標が変わらないまま、観測値の更新（毎秒の再評価）を何度も繰り返す。
    for (let i = 0; i < 5; i++) {
      act(() => {
        vi.advanceTimersByTime(9000)
      })
      view.rerender(harness(map, [...NARROW], [], null))
    }

    // Assert: 寄り直しは 1 回だけ（初回フィットと合わせて 2 回）。着地後は寄り直しの利得が
    // 無くなるため、判定が自然に止まる（矩形の広さの比で判定していると、padding とビューポート
    // 寸法によっては着地後も閾値を超えたままになり、ここで撃ち続ける）。
    expect(moveCount(map)).toBe(2)
  })

  it('寄り上限に張り付いていても、目標が別の場所へ移ったら寄り直す', () => {
    // Arrange: すでに寄り上限（基準ペインで 7）にいる状態で狭い点群へフィットしている。
    // この状態ではズームの利得は 0 のままなので、利得だけを見ていると永久に発火しない。
    const map = createFakeMap({ zoom: 7 })
    const view = render(harness(map, NARROW, [], null))
    act(() => {
      vi.advanceTimersByTime(AFTER_FLIGHT_MS)
    })

    // Act: 揺れている場所が東へ移る（画には収まったまま。中心はペイン短辺の 33% ぶんずれる）。
    view.rerender(harness(map, MOVED, [], null))
    expect(moveCount(map)).toBe(1)
    act(() => {
      vi.advanceTimersByTime(9000)
    })
    view.rerender(harness(map, [...MOVED], [], null))

    // Assert: 移った先の中心へ寄り直す。
    expect(moveCount(map)).toBe(2)
    expect((map.flyTo as unknown as Mock).mock.calls[1][0].center).toEqual([139.1, 37.05])
  })

  it('中心のずれが小さいだけなら寄り直さない', () => {
    // Arrange: 上と同じ「寄り上限に張り付いた」状態。
    const map = createFakeMap({ zoom: 7 })
    const view = render(harness(map, NARROW, [], null))
    act(() => {
      vi.advanceTimersByTime(AFTER_FLIGHT_MS)
    })

    // Act: わずかに（ペイン短辺の 8% ぶん）ずれた場所へ移り、そのまま待つ。
    view.rerender(harness(map, NUDGED, [], null))
    act(() => {
      vi.advanceTimersByTime(9000)
    })
    view.rerender(harness(map, [...NUDGED], [], null))

    // Assert: カメラは動かない（初回フィットの 1 回から増えない）。これで動かすと、揺れの重心が
    // 揺らぐたびに画が漂う。
    expect(moveCount(map)).toBe(1)
  })

  it('点が画面の縁の余白に入り込んだら引く（バッジが切れたまま放置しない）', () => {
    // Arrange: 寄り上限で狭い点群へフィットしている状態。
    const map = createFakeMap({ zoom: 7 })
    const view = render(harness(map, NARROW, [], null))
    act(() => {
      vi.advanceTimersByTime(AFTER_FLIGHT_MS)
    })

    // Act: 表示範囲の内側だが、右の縁から 30px の位置に点が立つ（フィットの padding=60 より内側）。
    // 検知点はバッジで描くため、この位置では丸が切れて読めない。
    view.rerender(harness(map, [...NARROW, dp(37.0, 140.8)], [], null))

    // Assert: 保持時間を待たず、その場で引く（成長フォローの経路）。
    expect(moveCount(map)).toBe(2)
  })

  it('検知は続いているのに描ける点が無くなった場合、日本全体へ戻さない', () => {
    // Arrange: 初回フィットまで進んだ状態。
    const map = createFakeMap()
    const view = render(harness(map, NARROW, [], null))
    const before = fitPaddings(map).length

    // Act: 全メンバーが震度0未満・欠測になって描ける点が消える（検知そのものは続いている）。
    act(() => {
      vi.advanceTimersByTime(AFTER_FLIGHT_MS)
    })
    view.rerender(harness(map, [], [], null, { hasDetection: true }))

    // Assert: カメラは動かない。ここで戻すと、点が返ってきた瞬間に寄り直す往復になる。
    expect(fitPaddings(map).length).toBe(before)

    // Act 2: 検知そのものが終わる。
    view.rerender(harness(map, [], [], null, { hasDetection: false }))

    // Assert: このときは日本全体へ戻る（「描けない」と「終わった」を分けている根拠）。
    expect(fitPaddings(map).slice(before)).toEqual([JAPAN_PADDING])
  })
})

// ── EEW 解除後の帰還（FitToEEWGL） ─────────────────────────────────────────────
// 解除して揺れ検知点へ帰るとき、着地がズーム段階に乗っていること。分数ズームでぴったり寄せると
// 目標の縁が成長フォローの余白のちょうど上に乗り、着地直後に引き直されて「寄りすぎた後に
// ちょっと引く」二段の動きになる（実測: 5°×4° の点群で余白の余裕が 0px・判定は「はみ出している」）。
describe('EEW 解除後の帰還', () => {
  /** FitToEEWGL が参照するのは originTime・震源座標・id だけ。 */
  const eew = {
    id: 'eew-1',
    earthquake: {
      originTime: '2026-08-21T05:00:00+09:00',
      hypocenter: { latitude: 37.5, longitude: 137.2, depth: 10 },
    },
  } as unknown as EEWAlert

  // 初出時刻が未記録の ref を渡す＝「このコミットで初めて現れた EEW」＝新規発報の扱いになる
  // （判定の詳細と入室側の固定は下の「EEW の初期フレーミング」）。
  const eewHarness = (map: maplibregl.Map, eews: EEWAlert[], detected: DetectedPoint[]) =>
    h(
      MapGLContext.Provider,
      { value: map },
      h(FitToEEWGL, {
        eews,
        psWave: [],
        detectedPoints: detected,
        hasDetection: detected.length > 0,
        candidatePoints: [],
        forecastAreaPositions: [],
        firstSeenAtRef: { current: new Map<string, number>() },
        focusedEewIdRef: { current: null },
        lastConsumedFocusTickRef: { current: 0 },
      }),
    )

  it('検知点が残っていれば、ズーム段階に乗せて帰る（着地直後に引き直さない）', () => {
    // Arrange: EEW 発報中。検知点は広範囲に出ている。
    const map = createFakeMap({ fitZoom: 4 })
    const detected = [dp(35.0, 136.0), dp(38.0, 140.0)]
    // 1 本目は EEW 自身へのフィット（この fixture は円を持たないため震源へ直行する）。
    const view = render(eewHarness(map, [eew], detected))
    expect(moveCount(map)).toBe(1)

    // Act: EEW が解除される。寄り直せば z6.7 まで寄れる広さの検知点が残っている状態。
    map.setFitZoom(6.7)
    view.rerender(eewHarness(map, [], detected))

    // Assert: 検知点へ帰り、着地は 0.5 段階へ切り下がった 6.5。分数ズームで寄せる経路
    // （fitBounds）を通っていれば、フェイクはズームを据え置くので 6.5 にはならない。
    expect(fitPaddings(map).slice(1)).toEqual([POINTS_PADDING])
    expect(map.getZoom()).toBe(6.5)
  })
})

// ── EEW の初期フレーミング（FitToEEWGL） ───────────────────────────────────────
// 「新規発報」と「発報中の EEW のところへ入室した」を分ける仕掛けの回帰テスト。
// FitToEEWGL は kyoshin モード限定マウントのため、内部の ref だけでは両者を区別できない
// （タブ復帰のたびに初期化される）。初出時刻とフォーカス済み id を親から受け取って判定する。
//
// 実機（Playwright）では、EEW を出したままタブを往復させる操作を数秒単位のタイミングで
// 再現する必要があり組み合わせを網羅できない。ここはフェイクタイマーで固定する。
describe('EEW の初期フレーミング', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * 能登沖の EEW。fixture は震源名を持たないため波円が作れず、第一報は震源 1 点へ直行する。
   * 実電文はどの経路でも `issue.eventId` を持つので、追従が見るキーもそちらになる。
   */
  const NOTO = {
    id: 'eew-noto-report-1',
    issue: { eventId: 'ev-noto' },
    earthquake: {
      originTime: '2026-08-21T05:00:00+09:00',
      hypocenter: { latitude: 37.5, longitude: 137.2, depth: 10 },
    },
  } as unknown as EEWAlert
  /** 先に出ている別の EEW（九州沖）。合成範囲に含まれると西端が 131.0 になる。 */
  const KYUSHU = {
    id: 'eew-kyushu-report-1',
    issue: { eventId: 'ev-kyushu' },
    earthquake: {
      originTime: '2026-08-21T04:59:00+09:00',
      hypocenter: { latitude: 33.0, longitude: 131.0, depth: 20 },
    },
  } as unknown as EEWAlert
  // 震源より西に置いた検知点。合成範囲へ寄れば矩形の西端が 131.0 になり、震源 1 点への直行
  // （矩形を持たないので padding も west も記録されない）と区別できる。
  const WEST_POINTS = [dp(36.0, 131.0), dp(36.5, 131.4)]
  const UNION_WEST = 131.0
  // 第一報の抑制（GROWTH_FOLLOW_SUPPRESS_MS = 3000）が明ける前後。飛行の期限（0.8 秒＋
  // マージン 2 秒）は先に切れるので、抑制だけが残った状態を作れる。
  const BEFORE_SUPPRESS_END_MS = 2900
  const AFTER_SUPPRESS_END_MS = 3100

  function eewFrame(
    map: maplibregl.Map,
    eews: EEWAlert[],
    detected: DetectedPoint[],
    refs: { firstSeenAtRef: { current: Map<string, number> }; focusedEewIdRef: { current: string | null } },
    opts: { shakeFocus?: ShakeFocus | null; focusTickRef?: { current: number }; psWave?: PsWaveCircle[] } = {},
  ) {
    return h(
      MapGLContext.Provider,
      { value: map },
      h(FitToEEWGL, {
        eews,
        psWave: opts.psWave ?? [],
        detectedPoints: [...detected],
        hasDetection: detected.length > 0,
        candidatePoints: [],
        forecastAreaPositions: [],
        shakeFocus: opts.shakeFocus ?? null,
        // 消費済み連番はマウントをまたいで残す必要があるため、要求を出すテストだけ外から渡す。
        lastConsumedFocusTickRef: opts.focusTickRef ?? { current: 0 },
        ...refs,
      }),
    )
  }

  /** 親（JapanMapGL）が保有する 2 つの ref。ageMs だけ前に初めて見たことにする。 */
  const refsFor = (eews: EEWAlert[], ageMs: number) => ({
    firstSeenAtRef: {
      current: new Map(eews.map((e) => [e.issue?.eventId ?? e.id, Date.now() - ageMs])),
    },
    focusedEewIdRef: { current: null as string | null },
  })

  it('発報中の EEW のところへ入室したら、震源へ寄らず合成範囲へ寄せる', () => {
    // Arrange: EEW は 1 分前に発表済み。検知点は震源から離れた西側に出ている。
    const map = createFakeMap({ fitZoom: 5 })
    const refs = refsFor([NOTO], 60_000)

    // Act: リアルタイムタブへ入室（＝FitToEEWGL のマウント）。
    render(eewFrame(map, [NOTO], WEST_POINTS, refs))

    // Assert: 検知点まで含んだ矩形へ 1 回だけ寄る。震源 1 点への直行なら矩形が記録されない
    // （padding・west とも undefined）ので、この期待値では通らない。
    expect((map as FakeMap).moves).toEqual([{ padding: POINTS_PADDING, west: UNION_WEST }])
    // 第一報のフォーカスは与えていない（入室は「初めて見た」ではない）。
    expect(refs.focusedEewIdRef.current).toBeNull()
  })

  it('初出時刻がまだ無い EEW は新規発報として扱う', () => {
    // Arrange: 初出時刻の記録は親の effect で行われるが、React は子の effect を先に流すため、
    // EEW が現れた最初のコミットでは未記録のままこの判定が走る。
    const map = createFakeMap({ fitZoom: 5 })
    const refs = {
      firstSeenAtRef: { current: new Map<string, number>() },
      focusedEewIdRef: { current: null as string | null },
    }

    // Act
    render(eewFrame(map, [NOTO], WEST_POINTS, refs))

    // Assert: 震源へ直行し、フォーカス済みとして記録する。ここを入室扱いに倒すと、発報と同時に
    // タブが切り替わった回が「合成範囲へ寄る→続報で震源へ寄る」の二段になる（実機で確認した穴）。
    expect((map as FakeMap).moves).toEqual([{}])
    expect(refs.focusedEewIdRef.current).toBe(NOTO.issue!.eventId)
  })

  it('震源の位置が判らない EEW を寄り先にしない', () => {
    // Arrange: 標準版（Yahoo 強震モニタ）は座標の文字列が空だと NaN になる。NaN はどの比較でも
    // false になるため、否定形（`lat <= -200`）の判定では弾けず、そのまま寄り先として渡ると
    // MapLibre が例外を投げる（このアプリに ErrorBoundary は無い）。
    const map = createFakeMap({ fitZoom: 5 })
    const noCoords = {
      id: 'eew-nan-report-1',
      issue: { eventId: 'ev-nan' },
      earthquake: { originTime: '2026-08-21T05:00:00+09:00', hypocenter: { latitude: NaN, longitude: NaN } },
    } as unknown as EEWAlert
    const refs = refsFor([noCoords], 0)

    // Act
    render(eewFrame(map, [noCoords], WEST_POINTS, refs))

    // Assert: 震源へは寄らない。矩形を持たない 1 点への直行（`{}`）が記録されていれば NaN を
    // 寄り先に渡したということで、実機では MapLibre が例外を投げる。カメラを動かすのは成長フォロー
    // だけで、目標は震源を除いた材料（ここでは検知点）になる。
    expect((map as FakeMap).moves).toEqual([{ padding: POINTS_PADDING, west: UNION_WEST }])
    // 第一報のフォーカスも与えない（位置が判ってから改めて新規発報として扱う）。
    expect(refs.focusedEewIdRef.current).toBeNull()
  })

  it('新規発報なら震源へ寄り、3 秒間は合成範囲へ引き直さない', () => {
    // Arrange: いま初めて見た EEW。
    const map = createFakeMap({ fitZoom: 5 })
    const refs = refsFor([NOTO], 0)

    // Act: 発報と同時にタブが切り替わってマウントされる。
    const view = render(eewFrame(map, [NOTO], WEST_POINTS, refs))

    // Assert: 震源 1 点へ直行する（矩形を持たない経路）。
    expect((map as FakeMap).moves).toEqual([{}])
    expect(refs.focusedEewIdRef.current).toBe(NOTO.issue!.eventId)

    // Act 2: 抑制が明ける前に検知点が更新される（毎秒の再評価）。
    act(() => {
      vi.advanceTimersByTime(BEFORE_SUPPRESS_END_MS)
    })
    view.rerender(eewFrame(map, [NOTO], WEST_POINTS, refs))

    // Assert 2: 引き直さない。ここで動くと「一瞬寄って即ズームアウト」になる。
    expect(moveCount(map)).toBe(1)

    // Act 3: 抑制が明けてから、もう一度更新が来る。
    act(() => {
      vi.advanceTimersByTime(AFTER_SUPPRESS_END_MS - BEFORE_SUPPRESS_END_MS)
    })
    view.rerender(eewFrame(map, [NOTO], WEST_POINTS, refs))

    // Assert 3: ここで初めて合成範囲へ引く（成長フォロー）。
    expect((map as FakeMap).moves.slice(1)).toEqual([{ padding: POINTS_PADDING, west: UNION_WEST }])
  })

  it('別の EEW が発報中でも、新規発報の抑制は効く', () => {
    // Arrange: 九州沖の EEW が出ている最中に、能登沖の EEW が届いた瞬間。
    // 第一報のフィットは自身の震源しか見ないため、抑制が無ければ次の評価で
    // 「九州沖を含む合成範囲」へ即座に引き戻される（EEW が増えるほど差が開く）。
    const map = createFakeMap({ fitZoom: 5 })
    const refs = {
      firstSeenAtRef: {
        current: new Map([
          [KYUSHU.issue!.eventId!, Date.now() - 60_000],
          [NOTO.issue!.eventId!, Date.now()],
        ]),
      },
      focusedEewIdRef: { current: null as string | null },
    }

    // Act: 新しい方（能登沖）が追従対象になる。
    const view = render(eewFrame(map, [KYUSHU, NOTO], [], refs))
    expect((map as FakeMap).moves).toEqual([{}])

    // Act 2: 抑制中に再評価が走る。
    act(() => {
      vi.advanceTimersByTime(BEFORE_SUPPRESS_END_MS)
    })
    view.rerender(eewFrame(map, [KYUSHU, NOTO], [], refs))

    // Assert: 九州沖は画面外（フェイクの視野は中心 ±4 度）だが、まだ引かない。
    expect(moveCount(map)).toBe(1)

    // Act 3: 抑制が明ける。
    act(() => {
      vi.advanceTimersByTime(AFTER_SUPPRESS_END_MS - BEFORE_SUPPRESS_END_MS)
    })
    view.rerender(eewFrame(map, [KYUSHU, NOTO], [], refs))

    // Assert: 両方の震源を含む範囲へ引く。
    expect((map as FakeMap).moves.slice(1)).toEqual([{ padding: POINTS_PADDING, west: UNION_WEST }])
  })

  it('同じ EEW でタブへ戻ったときは、第一報のフォーカスを繰り返さない', () => {
    // Arrange: 新規発報でフォーカス済み。初出からはまだ 10 秒経っていない。
    const map = createFakeMap({ fitZoom: 5 })
    const refs = refsFor([NOTO], 0)
    const view = render(eewFrame(map, [NOTO], WEST_POINTS, refs))
    expect((map as FakeMap).moves).toEqual([{}])

    // Act: 別タブへ移って戻る（FitToEEWGL のアンマウント → 再マウント）。親が持つ ref は残る。
    view.unmount()
    render(eewFrame(map, [NOTO], WEST_POINTS, refs))

    // Assert: 鮮度が残っていても、フォーカス済みの EEW には二度目の震源寄りを与えない。
    // 入室として合成範囲へ寄る（ref を内部に持つと、ここが 2 回目の震源直行になる）。
    expect((map as FakeMap).moves.slice(1)).toEqual([{ padding: POINTS_PADDING, west: UNION_WEST }])
  })

  // ── 震源訂正フォロー ─────────────────────────────────────────────────────────
  // 第一報の抑制は「検知点が育った瞬間に画を奪われる」ちらつきを防ぐためのもので、震源そのものが
  // 訂正されたときまで止めると、取り下げられた場所に貼り付いたままになる。
  //
  // 実例（2024-01-01 17:48 の能登余震 `20240101174834`）: 第一報は深さ 350km と推定されて波円が
  // 地表に出ず、震源 1 点への最大ズームになる。その後 1 秒足らずで 3 報が第一報から 159km →
  // 287km → 201km と飛び交い、+5.7 秒の第 5 報で 289km 先へ確定した。抑制がそのまま効くと、
  // 訂正が始まってから 3 秒間はまったく動かない。

  /** 新規発報から揺れフォーカスを見送る猶予（`SHAKE_FOCUS_YIELD_AFTER_EEW_MS`）。実装側と独立に持つ。 */
  const SHAKE_FOCUS_YIELD_AFTER_EEW_MS = 10000
  /** 訂正後の震源。第一報（137.2）の画（フェイクの視野は経度 ±4 度）から確実に外れる位置。 */
  const RELOCATED_LNG = 143.0
  /**
   * 第一報の画に**収まっているが縁に寄った**訂正。寄り直し先の中心はペイン短辺の 27% 動く
   * （閾値は 20%）。実地震で起きたのはこの形で、「画からはみ出したか」で測ると拾えない。
   */
  const EDGE_LNG = 140.5
  /** 訂正後だが第一報の画の中ほどに収まる位置（中心のずれは 15%＝閾値未満）。 */
  const NEARBY_LNG = 139.0
  const relocated = (lng: number) =>
    ({
      ...NOTO,
      earthquake: { ...NOTO.earthquake, hypocenter: { ...NOTO.earthquake.hypocenter, longitude: lng } },
    }) as unknown as EEWAlert

  it('[正] 抑制中でも、震源が画から外れる訂正が来たら寄り直す（寄り先に第一報の位置も含める）', () => {
    // Arrange: 新規発報。第一報は震源 1 点へ直行する。
    const map = createFakeMap({ fitZoom: 5 })
    const refs = refsFor([NOTO], 0)
    const view = render(eewFrame(map, [NOTO], [], refs))
    expect((map as FakeMap).moves).toEqual([{}])

    // Act: 飛行が着地したあと、抑制が明ける前に震源が画の外へ訂正される。
    act(() => {
      vi.advanceTimersByTime(800)
      ;(map as FakeMap).completeFlight()
      vi.advanceTimersByTime(400)
    })
    view.rerender(eewFrame(map, [relocated(RELOCATED_LNG)], [], refs))

    // Assert: 抑制の 3 秒を待たずに寄り直す。**寄り先の西端は第一報の 137.2**——現在の震源だけへ
    // 寄せると西端は 143.0 になり、訂正が続く間は報のたびに寄り直すことになる。
    expect((map as FakeMap).moves.slice(1)).toEqual([
      { padding: POINTS_PADDING, west: NOTO.earthquake.hypocenter.longitude },
    ])
  })

  it('[正] 訂正後の震源が画の縁の内側でも、寄り直しで中心が大きく動くなら破る', () => {
    // Arrange: 新規発報。
    const map = createFakeMap({ fitZoom: 5 })
    const refs = refsFor([NOTO], 0)
    const view = render(eewFrame(map, [NOTO], [], refs))

    // Act: 画の中には残るが、縁に寄る訂正。
    act(() => {
      vi.advanceTimersByTime(800)
      ;(map as FakeMap).completeFlight()
      vi.advanceTimersByTime(400)
    })
    view.rerender(eewFrame(map, [relocated(EDGE_LNG)], [], refs))

    // Assert: 寄り直す。**「はみ出したか」で測っていた頃はここが素通りしていた**——2024-01-01
    // 17:48 の能登余震の再生でも、289km 離れた訂正後の震源は縁の内側に収まっていた。
    expect((map as FakeMap).moves.slice(1)).toEqual([
      { padding: POINTS_PADDING, west: NOTO.earthquake.hypocenter.longitude },
    ])
  })

  it('[対照] 訂正が第一報の画に収まっているうちは、抑制中に動かさない', () => {
    // Arrange: 同じく新規発報。
    const map = createFakeMap({ fitZoom: 5 })
    const refs = refsFor([NOTO], 0)
    const view = render(eewFrame(map, [NOTO], [], refs))

    // Act: 画の中で収まる範囲の訂正。
    act(() => {
      vi.advanceTimersByTime(800)
      ;(map as FakeMap).completeFlight()
      vi.advanceTimersByTime(400)
    })
    view.rerender(eewFrame(map, [relocated(NEARBY_LNG)], [], refs))

    // Assert: 動かない。小さな訂正まで拾うと、第一報の画を見せる意味が無くなる
    // （実データでも 1 報あたり 10〜40km の訂正は珍しくない）。
    expect(moveCount(map)).toBe(1)
  })

  it('[安全弁] 揺れフォーカスが張った抑制は破らない（寄せた観測点から引き戻さない）', () => {
    // Arrange: 新規発報で第一報のフォーカスを与える。**入室では駄目**——フォーカス済みの EEW が
    // 無いと、破る条件のもう一段（追従対象の特定）で先に止まってしまい、この安全弁を素通りする。
    const map = createFakeMap({ fitZoom: 5 })
    const refs = refsFor([NOTO], 0)
    const focusTickRef = { current: 0 }
    const view = render(eewFrame(map, [NOTO], [], refs, { focusTickRef }))
    expect(moveCount(map)).toBe(1)

    // Act: 第一報の抑制（3 秒）も、揺れフォーカスを見送る猶予（10 秒）も明けるまで進める。
    act(() => {
      vi.advanceTimersByTime(800)
      ;(map as FakeMap).completeFlight()
      vi.advanceTimersByTime(SHAKE_FOCUS_YIELD_AFTER_EEW_MS)
    })
    view.rerender(eewFrame(map, [NOTO], [], refs, { focusTickRef }))
    expect(moveCount(map)).toBe(1)

    // Act 2: 震源から遠く離れた観測点で揺れが強まり、そこへ寄せる。
    const focus: ShakeFocus = { lat: 37.5, lng: 150.0, tick: 1, atMs: Date.now() }
    view.rerender(eewFrame(map, [NOTO], [], refs, { shakeFocus: focus, focusTickRef }))
    expect(moveCount(map)).toBe(2)

    // Act 3: 飛行が着地する。この時点で震源（137.2）は画（150 ± 4 度）の外にある。
    act(() => {
      vi.advanceTimersByTime(800)
      ;(map as FakeMap).completeFlight()
      vi.advanceTimersByTime(400)
    })
    view.rerender(eewFrame(map, [NOTO], [], refs, { shakeFocus: focus, focusTickRef }))

    // Assert: 引き戻さない。揺れフォーカスも `suppressGrowthUntilRef` を張るため、破る条件を
    // 「震源が画の外」だけにすると、寄せた画が 3 秒保たずに奪われる。
    //
    // **このテストは定数の大小関係も押さえている。** 分離が効くのは
    // `SHAKE_FOCUS_YIELD_AFTER_EEW_MS`（10 秒）が `GROWTH_FOLLOW_SUPPRESS_MS`（3 秒）より長く、
    // 揺れフォーカスの抑制が張られる頃には第一報の抑制が失効しているから。実装側で前者を縮める
    // （または後者を伸ばす）と、ここで震源訂正フォローが発火して 3 件目の移動が記録される。
    expect(moveCount(map)).toBe(2)
  })

  it('[安全弁] 波円が育っただけでは、震源訂正フォローを繰り返さない', () => {
    // Arrange: 新規発報 → 画の外への訂正で、震源訂正フォローを 1 度発火させる。
    const map = createFakeMap({ fitZoom: 5 })
    const refs = refsFor([NOTO], 0)
    const circle = (sRadius: number): PsWaveCircle[] => [
      // eventId は `eewEventKey`（`issue.eventId ?? id`）と同じ導出。食い違うと自身の円を拾えない。
      { eventId: NOTO.issue!.eventId!, lat: 37.5, lng: RELOCATED_LNG, pRadius: sRadius * 1.7, sRadius } as PsWaveCircle,
    ]
    const view = render(eewFrame(map, [NOTO], [], refs))
    act(() => {
      vi.advanceTimersByTime(800)
      ;(map as FakeMap).completeFlight()
      vi.advanceTimersByTime(400)
    })
    const settled = relocated(RELOCATED_LNG)
    view.rerender(eewFrame(map, [settled], [], refs, { psWave: circle(20) }))
    act(() => {
      vi.advanceTimersByTime(800)
      ;(map as FakeMap).completeFlight()
    })
    const afterRelocation = moveCount(map)
    expect(afterRelocation).toBe(2)

    // Act: 震源は動かさず、波円だけを育てて再評価する（実装では 100ms ごとに走る評価）。
    // 第一報の抑制（3 秒）が明ける前に収める。
    for (const r of [30, 40, 50, 60]) {
      act(() => {
        vi.advanceTimersByTime(100)
      })
      view.rerender(eewFrame(map, [settled], [], refs, { psWave: circle(r) }))
    }

    // Assert: 動かない。円が育つと寄り先の矩形の中心もわずかに動くが、破る条件は「寄り直すと
    // 中心がペイン短辺の 2 割以上動く」なので、位置の訂正が無い限り閾値に届かない。
    // ここが緩むと、第一報がわざと狭く見せている画を訂正フォロー自身が壊し続けることになる。
    expect(moveCount(map)).toBe(afterRelocation)
  })

  // ── 収め直しフォロー ─────────────────────────────────────────────────────────
  // 上の震源訂正フォローは訂正の振れ幅ごと包むので、収まった後は画が広いまま残る。成長フォローは
  // 「はみ出したら引く」しかしないため、締め直す経路が要る（揺れ検知側と同じ仕掛け）。

  /** 収め直しフォローの保持時間（`REFIT_HOLD_MS`）の前後。実装側と独立に持つ。 */
  const BEFORE_REFIT_HOLD_MS = 7000
  const AFTER_REFIT_HOLD_MS = 9000

  /**
   * 震源訂正フォローで「第一報 137.2 と訂正後 143.0 を包む画」まで進め、収め直しの待ちを
   * 開始させた状態を作る。待ちは**待ちに入った評価を起点に**数えるので、開始まで進めてから
   * 時間を送らないと保持時間の前後を突けない。
   */
  function arrangeWidenedThenSettled(map: maplibregl.Map) {
    const refs = refsFor([NOTO], 0)
    const view = render(eewFrame(map, [NOTO], [], refs))
    act(() => {
      vi.advanceTimersByTime(800)
      ;(map as FakeMap).completeFlight()
      vi.advanceTimersByTime(400)
    })
    const settled = relocated(RELOCATED_LNG)
    view.rerender(eewFrame(map, [settled], [], refs))
    act(() => {
      vi.advanceTimersByTime(800)
      ;(map as FakeMap).completeFlight()
      // 第一報の抑制（3 秒）を明けさせる。ここから先は成長フォローと収め直しフォローの領分。
      vi.advanceTimersByTime(AFTER_SUPPRESS_END_MS)
    })
    // 待ちの開始。
    view.rerender(eewFrame(map, [settled], [], refs))
    return { view, refs, settled }
  }

  it('[正] 訂正で広げた画は、保持時間の経過後に確定した震源へ締め直す', () => {
    // Arrange: 第一報（137.2）と訂正後（143.0）を包む画まで進め、収め直しの待ちに入った状態。
    const map = createFakeMap({ fitZoom: 5 })
    const { view, refs, settled } = arrangeWidenedThenSettled(map)
    expect(moveCount(map)).toBe(2)

    // Act: 保持時間の手前まで進む（波円の再計算に相当する再評価を挟む）。
    act(() => {
      vi.advanceTimersByTime(BEFORE_REFIT_HOLD_MS)
    })
    view.rerender(eewFrame(map, [settled], [], refs))

    // Assert: まだ締め直さない（一瞬ずれただけで寄せない待ち）。
    expect(moveCount(map)).toBe(2)

    // Act 2: 保持時間を越える。
    act(() => {
      vi.advanceTimersByTime(AFTER_REFIT_HOLD_MS - BEFORE_REFIT_HOLD_MS)
    })
    view.rerender(eewFrame(map, [settled], [], refs))

    // Assert 2: 確定した震源だけの画へ締め直す（西端が 137.2 から 143.0 へ寄る）。
    expect((map as FakeMap).moves.slice(2)).toEqual([{ padding: POINTS_PADDING, west: RELOCATED_LNG }])
  })

  it('[安全弁] 締め直した後は、目標が変わらない限り二度と動かない（往復しない）', () => {
    // Arrange: 上のテストの続き（締め直しまで終えた状態）。
    const map = createFakeMap({ fitZoom: 5 })
    const { view, refs, settled } = arrangeWidenedThenSettled(map)
    act(() => {
      vi.advanceTimersByTime(AFTER_REFIT_HOLD_MS)
    })
    view.rerender(eewFrame(map, [settled], [], refs))
    act(() => {
      vi.advanceTimersByTime(800)
      ;(map as FakeMap).completeFlight()
    })
    const afterRefit = moveCount(map)
    expect(afterRefit).toBe(3)

    // Act: そのまま保持時間ぶんの再評価を繰り返す。
    for (let i = 0; i < 3; i++) {
      act(() => {
        vi.advanceTimersByTime(AFTER_REFIT_HOLD_MS)
      })
      view.rerender(eewFrame(map, [settled], [], refs))
    }

    // Assert: 動かない。着地後は寄り直しの利得も中心のずれも 0 になるのが往復しない根拠。
    expect(moveCount(map)).toBe(afterRefit)
  })
})

// ── 津波モードの帰還（TsunamiFitGL） ───────────────────────────────────────────
// 観測点へ寄った後、猶予（INTERACTION_HOLD_SEC）の満了で対象海域全体へ帰す仕掛けの回帰テスト。
// 猶予はコンポーネント内の setTimeout で数えるため、実機（Playwright）では 1 ケースにつき
// 30 秒以上待つことになり条件の組み合わせを網羅できない。ここはフェイクタイマーで固定する。

/** 津波の観測棒（TsunamiFitGL が見るのは名前・座標・波高値だけ）。 */
const bar = (name: string, lat: number, lng: number, value: number) => ({ name, lat, lng, height: { value } })

// 観測点は九州沖、海岸線は三陸沖に置き、fitBounds に渡った矩形の西端で寄り先を判別する。
const OBS_BARS = [bar('A', 33.0, 130.0, 1.0), bar('B', 34.0, 131.0, 2.0)]
const COAST: LatLng[] = [[38.0, 141.0], [41.0, 143.0]]
const OBS_WEST = 130.0
const COAST_WEST = 141.0
const SIG = '岩手県:MajorWarning'

/** カメラ操作の時系列。日本全体は -1、点群へのフィットは矩形の西端で表す。 */
function fitTargets(map: maplibregl.Map): (number | undefined)[] {
  return (map as FakeMap).moves.map((m) => (m.padding === JAPAN_PADDING ? -1 : m.west))
}

interface TsunamiProps {
  mode?: string
  signature?: string
  coast?: LatLng[]
  bars?: typeof OBS_BARS
  focus?: { name: string; ts: number } | null
}

function tsunamiHarness(map: maplibregl.Map, props: TsunamiProps = {}) {
  return h(
    MapGLContext.Provider,
    { value: map },
    h(TsunamiFitGL, {
      mode: props.mode ?? 'tsunami',
      tsunamiSignature: props.signature ?? SIG,
      tsunamiFitPositions: props.coast ?? COAST,
      observationBars: props.bars ?? [],
      focusObsName: props.focus ?? null,
    }),
  )
}

describe('津波モードの帰還（観測点 → 俯瞰）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('観測点へ寄った後、猶予が満了すると対象海域全体へ帰る', () => {
    // Arrange: 発表直後の海岸線フィットまで進んだ状態。
    const map = createFakeMap()
    const view = render(tsunamiHarness(map))
    expect(fitTargets(map)).toEqual([COAST_WEST])

    // Act 1: 観測情報が届いて観測点へ寄る。
    view.rerender(tsunamiHarness(map, { bars: OBS_BARS }))
    expect(fitTargets(map)).toEqual([COAST_WEST, OBS_WEST])

    // Act 2: 以後何も起きないまま猶予が満了する。
    act(() => {
      vi.advanceTimersByTime(30_000)
    })

    // Assert: 対象海域全体へ帰る（観測点に張り付いたままにしない）。
    expect(fitTargets(map)).toEqual([COAST_WEST, OBS_WEST, COAST_WEST])
  })

  it('猶予の満了前に観測行がクリックされたら、クリック時点から数え直す', () => {
    // Arrange: 観測点へ寄った状態。
    const map = createFakeMap()
    const view = render(tsunamiHarness(map, { bars: OBS_BARS }))
    const before = fitTargets(map).length

    // Act 1: 猶予の途中でユーザーが観測行をクリックする（FocusObsGL がその観測点へ寄せる）。
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    view.rerender(tsunamiHarness(map, { bars: OBS_BARS, focus: { name: 'A', ts: 1 } }))

    // Act 2: 元の猶予なら満了しているはずの時間まで進める。
    act(() => {
      vi.advanceTimersByTime(20_000)
    })

    // Assert: まだ帰らない（ユーザーが選んだ表示を巻き戻さない）。
    expect(fitTargets(map).length).toBe(before)

    // Act 3: クリックから数えた猶予が満了する。
    act(() => {
      vi.advanceTimersByTime(15_000)
    })

    // Assert: ここで初めて対象海域全体へ帰る。
    expect(fitTargets(map).slice(before)).toEqual([COAST_WEST])
  })

  it('津波モードを離れたら猶予タイマーを解除する（裏に浮かせない）', () => {
    // Arrange: 観測点へ寄って猶予を待っている状態。
    const map = createFakeMap()
    const view = render(tsunamiHarness(map, { bars: OBS_BARS }))
    const before = fitTargets(map).length
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    // Act: 別タブへ移る。
    view.rerender(tsunamiHarness(map, { mode: 'kyoshin', bars: OBS_BARS }))

    // Assert: 猶予タイマーが残らない（津波タブへ戻れば入室時のフィットで寄せ直すため、
    // 裏で満了させる意味がない）。カメラを動かさないことは decideTsunamiFit の
    // isTsunamiMode ガードが別に保証している。
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(fitTargets(map).length).toBe(before)
  })

  it('座標が無い観測点のクリックでは猶予を数え直さない', () => {
    // Arrange: 観測点へ寄った状態（猶予は 30 秒）。
    const map = createFakeMap()
    const view = render(tsunamiHarness(map, { bars: OBS_BARS }))
    const before = fitTargets(map).length

    // Act: 猶予の途中で、観測棒が無い観測点（座標未収録）の行をクリックする。
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    view.rerender(tsunamiHarness(map, { bars: OBS_BARS, focus: { name: '座標なし観測点', ts: 1 } }))
    act(() => {
      vi.advanceTimersByTime(15_000)
    })

    // Assert: カメラが動かないクリックで猶予は延びない（元の 30 秒で俯瞰へ帰る）。
    expect(fitTargets(map).slice(before)).toEqual([COAST_WEST])
  })

  it('猶予は INTERACTION_HOLD_SEC の固定時間で、設定「自動復帰までの時間」に左右されない', () => {
    // Arrange: 観測点へ寄って猶予を待っている状態。TsunamiFitGL は設定値を受け取らないため、
    // ここで固定できるのは「固定時間で帰る」ことだけ。設定と結合させようとすると props が
    // 増えて型が変わるので、その回帰は型検査が止める。
    const map = createFakeMap()
    render(tsunamiHarness(map, { bars: OBS_BARS }))
    const before = fitTargets(map).length

    // Act: 固定時間の直前までは帰らない。
    act(() => {
      vi.advanceTimersByTime(INTERACTION_HOLD_SEC * 1000 - 1)
    })
    expect(fitTargets(map).length).toBe(before)

    // Act: 満了した瞬間に帰る。
    act(() => {
      vi.advanceTimersByTime(1)
    })

    // Assert: 対象海域全体へ帰る（設定が「無効」でもこの経路は生きている）。
    expect(fitTargets(map).slice(before)).toEqual([COAST_WEST])
  })

  it('発表中だった津波が消えたら日本全体へ帰る', () => {
    // Arrange: 観測点へ寄った状態。
    const map = createFakeMap()
    const view = render(tsunamiHarness(map, { bars: OBS_BARS }))
    const before = fitTargets(map).length

    // Act: 解除表示の 10 秒後の purge で津波が消える（海岸線も観測棒も無くなる）。
    view.rerender(tsunamiHarness(map, { signature: '', coast: [], bars: [] }))

    // Assert: 日本全体へ帰る（寄ったまま取り残されない）。
    expect(fitTargets(map).slice(before)).toEqual([-1])
  })
})

// ── 観測行クリックによるフォーカス（FocusObsGL） ────────────────────────────────
// 観測棒の配列は電文のたびに作り直される。その変化で寄せ直してしまうと、以後の電文が
// 来るたびに古いクリック先へカメラが戻り続ける（更新された観測点への追従も上書きされる）。

function focusHarness(map: maplibregl.Map, focus: { name: string; ts: number } | null, bars: typeof OBS_BARS) {
  return h(
    MapGLContext.Provider,
    { value: map },
    h(FocusObsGL, { focusObsName: focus, observationBars: bars }),
  )
}

/** flyTo に渡された中心座標（クリック先の判別に使う）。 */
function flyCenters(map: maplibregl.Map): [number, number][] {
  return (map.flyTo as unknown as Mock).mock.calls.map((call) => call[0].center)
}

describe('観測行クリックのフォーカス', () => {
  it('クリック 1 回につき 1 度だけ寄せる（観測棒の更新では寄せ直さない）', () => {
    // Arrange: クリックで石巻港（配列2件目）へ寄せた状態。
    const map = createFakeMap()
    const view = render(focusHarness(map, { name: 'B', ts: 1 }, OBS_BARS))
    expect(flyCenters(map)).toEqual([[131.0, 34.0]])

    // Act: 続報で観測棒が作り直される（値は同じでも配列は別インスタンス）。
    view.rerender(focusHarness(map, { name: 'B', ts: 1 }, [...OBS_BARS]))

    // Assert: 寄せ直さない（クリック先へカメラを引き戻し続けない）。
    expect(flyCenters(map)).toHaveLength(1)
  })

  it('別の行をクリックしたら、そちらへ寄せる', () => {
    const map = createFakeMap()
    const view = render(focusHarness(map, { name: 'B', ts: 1 }, OBS_BARS))
    view.rerender(focusHarness(map, { name: 'A', ts: 2 }, OBS_BARS))
    expect(flyCenters(map)).toEqual([[131.0, 34.0], [130.0, 33.0]])
  })

  it('観測棒がまだ無いクリックは、棒が現れた時点で寄せる', () => {
    // Arrange: 座標データ未取得などで観測棒が 1 本も無い状態でクリックされた。
    const map = createFakeMap()
    const view = render(focusHarness(map, { name: 'A', ts: 1 }, []))
    expect(flyCenters(map)).toHaveLength(0)

    // Act: 観測棒が揃う。
    view.rerender(focusHarness(map, { name: 'A', ts: 1 }, OBS_BARS))

    // Assert: 取りこぼさずに寄せる。
    expect(flyCenters(map)).toEqual([[130.0, 33.0]])
  })
})

// ── 揺れフォーカス（揺れの強まり・別地点発報で 1 点へ寄る） ────────────────────────────
// 通知音が鳴った点を数秒だけ見せる仕掛け（`ShakeFocus`）。EEW 新規の第一報フォーカスと同じ形で、
// 寄せた直後は自分の追従（成長・収め直しフォロー）を止める。止めないと次の観測点更新（毎秒）で
// 「検知点全体が収まっていない」と判定され、寄せた画が 1 秒で引き戻される。
//
// ここで固定するのは 4 つ。
//   1. 要求を受けたらその点へ寄る／抑制の間は引き戻さない／抑制が明けたら全体像へ戻る
//   2. EEW 発報中は寄らない（EEW 優先。追従自体も EEW 側へ委譲している）
//   3. ユーザー操作中・古い要求では寄らない
//   4. 見送った要求は連番を消費して蒸し返さない
describe('揺れフォーカス', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // フェイクの視野（中心 ±4 度／±3 度）に収まる狭い点群。
  const POINTS = [dp(37.0, 137.0), dp(37.1, 137.2)]
  // 点群から十分離れた寄り先（寄った後は POINTS が視野から外れる＝抑制明けに成長フォローが働く）。
  const FAR = { lat: 33.6, lng: 130.4 }
  // 初回フィットの飛行が「進行中」でなくなるまでの待ち（収め直しフォローの節と同じ値）。
  const AFTER_FLIGHT_MS = 4000
  // フォーカスの飛行だけが終わり、抑制はまだ明けていない時点を狙う。
  // 内訳: flyToPoint の 0.8 秒 ＋ gl/camera.ts の FLIGHT_EXPIRY_MARGIN_MS（2 秒）= 2.8 秒 < 抑制 3 秒。
  const FOCUS_FLIGHT_DONE_MS = 2900
  // 上の時点からさらに進めて抑制（3 秒）を明けさせる残り分。
  const FOCUS_SUPPRESS_REMAINING_MS = 200

  /** いま出したばかりの要求。 */
  const focusNow = (tick: number): ShakeFocus => ({ ...FAR, tick, atMs: Date.now() })

  /** 初回フィットを済ませ、飛行も終わった状態にする。 */
  function settled(focusTickRef: { current: number }) {
    const map = createFakeMap({ fitZoom: 7 })
    const view = render(harness(map, POINTS, [], null, { focusTickRef }))
    act(() => {
      vi.advanceTimersByTime(AFTER_FLIGHT_MS)
    })
    expect(moveCount(map)).toBe(1)
    return { map, view }
  }

  it('要求を受けたらその 1 点へ寄り、抑制の間は成長フォローが引き戻さない', () => {
    // Arrange
    const focusTickRef = { current: 0 }
    const { map, view } = settled(focusTickRef)
    const focus = focusNow(1)

    // Act 1: 揺れが強まって要求が立つ。
    view.rerender(harness(map, POINTS, [], null, { focusTickRef, shakeFocus: focus }))

    // Assert 1: その点へ直行する（点群へのフィットではないので padding は付かない）。
    expect(moveCount(map)).toBe(2)
    expect(fitPaddings(map)[1]).toBeUndefined()
    expect(map.getCenter()).toEqual({ lng: FAR.lng, lat: FAR.lat })

    // Act 2: 飛行は終わったが抑制は明けていない時点で、観測点が更新される。
    act(() => {
      vi.advanceTimersByTime(FOCUS_FLIGHT_DONE_MS)
    })
    view.rerender(harness(map, [...POINTS], [], null, { focusTickRef, shakeFocus: focus }))

    // Assert 2: 引き戻さない（この 1 件が「3 秒の抑制」そのもの。無いと寄せた意味が消える）。
    expect(moveCount(map)).toBe(2)

    // Act 3: 抑制が明けてから、また観測点が更新される。
    act(() => {
      vi.advanceTimersByTime(FOCUS_SUPPRESS_REMAINING_MS)
    })
    view.rerender(harness(map, [...POINTS], [], null, { focusTickRef, shakeFocus: focus }))

    // Assert 3: 成長フォローが検知点全体へ戻す（戻す経路を別に持たないのはこのため）。
    expect(moveCount(map)).toBe(3)
    expect(fitPaddings(map)[2]).toBe(POINTS_PADDING)
  })

  it('EEW 発報中は寄らない（EEW 優先）', () => {
    const focusTickRef = { current: 0 }
    const { map, view } = settled(focusTickRef)

    view.rerender(harness(map, POINTS, [], null, { hasEew: true, focusTickRef, shakeFocus: focusNow(1) }))

    expect(moveCount(map)).toBe(1)
  })

  // タブ切替（useKyoshinAlerts のレベルアップ処理）と揺れフォーカスの要求は同じコミットで同時に
  // 立つため、タブ入室＝このコンポーネントの初回マウントの時点で既に新鮮な要求を抱えていることがある。
  it('[正] 初回マウントと同時に新鮮な要求があれば、全体フィットを経ずに直接その点へ寄る', () => {
    const focusTickRef = { current: 0 }
    const map = createFakeMap({ fitZoom: 7 })
    const focus = focusNow(1)

    const view = render(harness(map, POINTS, [], null, { focusTickRef, shakeFocus: focus }))

    // 1 回しか動かない（点群全体へのフィットを経由しない）。
    expect(moveCount(map)).toBe(1)
    expect(fitPaddings(map)[0]).toBeUndefined()
    expect(map.getCenter()).toEqual({ lng: FAR.lng, lat: FAR.lat })
    expect(focusTickRef.current).toBe(1)

    // 消費済みなので、直後の観測点更新でも寄り直さない（成長フォローの抑制が効いている）。
    act(() => {
      vi.advanceTimersByTime(FOCUS_FLIGHT_DONE_MS)
    })
    view.rerender(harness(map, [...POINTS], [], null, { focusTickRef, shakeFocus: focus }))
    expect(moveCount(map)).toBe(1)
  })

  it('[対照] 初回マウント時に要求が無ければ、これまで通り点群全体へフィットする', () => {
    const focusTickRef = { current: 0 }
    const map = createFakeMap({ fitZoom: 7 })

    render(harness(map, POINTS, [], null, { focusTickRef }))

    expect(moveCount(map)).toBe(1)
    expect(fitPaddings(map)[0]).toBe(POINTS_PADDING)
  })

  it('[安全弁] 初回マウント時に要求が古ければ、点群全体へのフィットに落ちる（消費はその場で記録する）', () => {
    const focusTickRef = { current: 0 }
    const map = createFakeMap({ fitZoom: 7 })
    // 6 秒前の要求（実装の受付は 5 秒）。
    const stale: ShakeFocus = { ...FAR, tick: 1, atMs: Date.now() - 6000 }

    render(harness(map, POINTS, [], null, { focusTickRef, shakeFocus: stale }))

    expect(moveCount(map)).toBe(1)
    expect(fitPaddings(map)[0]).toBe(POINTS_PADDING)
    // その場で見送って記録する（次の観測点更新まで持ち越さない。持ち越すと「寄り先なし」
    // 「検知終了」等の別の理由でログされ、古い要求だったという本当の原因が事後に追えなくなる）。
    expect(focusTickRef.current).toBe(1)
  })

  it('ユーザーが地図を操作している間は寄らない（震度の上昇で画を奪わない）', () => {
    const focusTickRef = { current: 0 }
    const { map, view } = settled(focusTickRef)
    act(() => {
      map.fire('zoomstart')
    })

    view.rerender(harness(map, POINTS, [], null, { focusTickRef, shakeFocus: focusNow(1) }))

    expect(moveCount(map)).toBe(1)
    // 見送っても連番は消費する（操作の保持が明けた瞬間にスナップしないための歯止め）。
    expect(focusTickRef.current).toBe(1)
  })

  it('古い要求では寄らない（タブの保持で移れなかった分を後から蒸し返さない）', () => {
    const focusTickRef = { current: 0 }
    const { map, view } = settled(focusTickRef)
    // 6 秒前の要求（実装の受付は 5 秒）。
    const stale: ShakeFocus = { ...FAR, tick: 1, atMs: Date.now() - 6000 }

    view.rerender(harness(map, POINTS, [], null, { focusTickRef, shakeFocus: stale }))

    expect(moveCount(map)).toBe(1)
  })

  it('[安全弁] 検知が終わっている間に来た要求は消費する（次の検知で前の点へ寄らない）', () => {
    // Arrange: 検知中でフィット済み。
    const focusTickRef = { current: 0 }
    const { map, view } = settled(focusTickRef)
    const focus = focusNow(1)

    // Act 1: 検知の終了と要求が同じコミットで来る（日本全体へ戻る）。
    view.rerender(harness(map, [], [], null, { focusTickRef, shakeFocus: focus }))
    expect(fitPaddings(map)).toEqual([POINTS_PADDING, JAPAN_PADDING])

    // Act 2: すぐ次の検知が始まる。要求はまだ鮮度（5 秒）の内側にいる。
    const before = moveCount(map)
    view.rerender(harness(map, POINTS, [], null, { focusTickRef, shakeFocus: focus }))
    view.rerender(harness(map, [...POINTS], [], null, { focusTickRef, shakeFocus: focus }))

    // Assert: 新しい検知の初回フィットだけが起き、前の検知の点へは寄らない。消費せずに残すと、
    // ここで「終わった揺れの点」へカメラが飛ぶ（鮮度の窓では弾けない）。
    expect(moveCount(map)).toBe(before + 1)
    expect(map.getCenter().lng).not.toBe(FAR.lng)
  })

  it('[安全弁] 描ける点が無い間に来た要求も消費する', () => {
    // Arrange: 検知中でフィット済み。
    const focusTickRef = { current: 0 }
    const { map, view } = settled(focusTickRef)
    const focus = focusNow(1)

    // Act: 検知は続いているが描ける点が無くなった状態で要求が来る（カメラは動かさない場面）。
    view.rerender(harness(map, [], [], null, { hasDetection: true, focusTickRef, shakeFocus: focus }))
    expect(moveCount(map)).toBe(1)

    // 点が戻る。
    view.rerender(harness(map, POINTS, [], null, { focusTickRef, shakeFocus: focus }))

    // Assert: 寄らない（消費済み）。
    expect(moveCount(map)).toBe(1)
  })

  // EEW 発報中は消費しない。**寄せる主体が FitToEEWGL へ移る**ため、ここで消費すると EEW 中の要求が
  // すべて吸われて一度も寄らない（担当の受け渡しは「揺れフォーカス（EEW 発報中）」の describe で固定）。
  it('[安全弁] EEW 発報中は連番を消費せず、EEW 側へ委譲する', () => {
    const focusTickRef = { current: 0 }
    const { map, view } = settled(focusTickRef)

    view.rerender(harness(map, POINTS, [], null, { hasEew: true, focusTickRef, shakeFocus: focusNow(1) }))

    // 自分では寄せない。連番も残す（同じコミットの後段で FitToEEWGL が拾えるようにするため）。
    expect(moveCount(map)).toBe(1)
    expect(focusTickRef.current).toBe(0)
  })
})

// ── 揺れフォーカス（EEW 発報中） ────────────────────────────────────────────────
// EEW 発報中はカメラの持ち主が FitToEEWGL へ移る（FitToDetectionGL の追従は hasEew で止まる）。
// そのため揺れフォーカスも EEW 側が担当しないと、寄せた直後に EEW の成長フォロー
// （予報円の再計算＝100ms ごとに評価）が引き戻してしまう。
//
// ここで固定するのは 3 つ。
//   1. EEW 発報中でもその点へ寄る
//   2. 新規発報からの猶予（10 秒）の間は譲る（EEW は「これから来る」の報せなので震源を先に見せる）
//   3. 譲った要求も連番を消費する（後から蒸し返さない）
describe('揺れフォーカス（EEW 発報中）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const EEW = {
    id: 'eew-noto-report-1',
    issue: { eventId: 'ev-noto' },
    earthquake: {
      originTime: '2026-08-24T05:00:00+09:00',
      hypocenter: { latitude: 37.5, longitude: 137.2, depth: 10 },
    },
  } as unknown as EEWAlert
  // 震源から離れた寄り先（震源へのフィットと区別できる位置）。
  const FAR = { lat: 33.6, lng: 130.4 }
  const DETECTED = [dp(37.0, 137.0), dp(37.2, 137.4)]

  function eewFocusFrame(
    map: maplibregl.Map,
    opts: {
      shakeFocus?: ShakeFocus | null
      focusTickRef: { current: number }
      firstSeenAtRef: { current: Map<string, number> }
      focusedEewIdRef: { current: string | null }
    },
  ) {
    return h(
      MapGLContext.Provider,
      { value: map },
      h(FitToEEWGL, {
        eews: [EEW],
        psWave: [],
        detectedPoints: [...DETECTED],
        hasDetection: true,
        candidatePoints: [],
        forecastAreaPositions: [],
        firstSeenAtRef: opts.firstSeenAtRef,
        focusedEewIdRef: opts.focusedEewIdRef,
        shakeFocus: opts.shakeFocus ?? null,
        lastConsumedFocusTickRef: opts.focusTickRef,
      }),
    )
  }

  /** 発報から時間が経った EEW（第一報のフォーカスは済んでいる）で入室した状態を作る。 */
  function settledDuringEew(focusTickRef: { current: number }) {
    const map = createFakeMap({ fitZoom: 7 })
    const refs = {
      firstSeenAtRef: { current: new Map([['ev-noto', Date.now() - 60_000]]) },
      focusedEewIdRef: { current: null as string | null },
    }
    const view = render(eewFocusFrame(map, { focusTickRef, ...refs }))
    // 入室フィット（合成範囲へ 1 回）。飛行を終わらせておく。
    expect(moveCount(map)).toBe(1)
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    return { map, view, refs }
  }

  it('[正] EEW 発報中でも、要求された 1 点へ寄る', () => {
    const focusTickRef = { current: 0 }
    const { map, view, refs } = settledDuringEew(focusTickRef)

    view.rerender(eewFocusFrame(map, {
      focusTickRef, ...refs,
      shakeFocus: { ...FAR, tick: 1, atMs: Date.now() },
    }))

    expect(moveCount(map)).toBe(2)
    expect(map.getCenter()).toEqual({ lng: FAR.lng, lat: FAR.lat })
  })

  it('[正] 寄せた後は EEW の成長フォローが引き戻さない（抑制が効く）', () => {
    const focusTickRef = { current: 0 }
    const { map, view, refs } = settledDuringEew(focusTickRef)
    const focus: ShakeFocus = { ...FAR, tick: 1, atMs: Date.now() }
    view.rerender(eewFocusFrame(map, { focusTickRef, ...refs, shakeFocus: focus }))
    expect(moveCount(map)).toBe(2)

    // 飛行は終わったが抑制（3 秒）は明けていない時点で、検知点が更新される。
    act(() => {
      vi.advanceTimersByTime(2900)
    })
    view.rerender(eewFocusFrame(map, { focusTickRef, ...refs, shakeFocus: focus }))

    expect(moveCount(map)).toBe(2)
  })

  // 自分が張った抑制を自分で読むと、3 秒以内に続く上昇が落ちる（震度7へ達する瞬間はまさにここ）。
  // 抑制の ref を役割で分けていることの杭。
  it('[正] 3 秒以内に続く上昇でも寄る（自分の抑制で自分を止めない）', () => {
    const focusTickRef = { current: 0 }
    const { map, view, refs } = settledDuringEew(focusTickRef)
    view.rerender(eewFocusFrame(map, {
      focusTickRef, ...refs,
      shakeFocus: { ...FAR, tick: 1, atMs: Date.now() },
    }))
    expect(moveCount(map)).toBe(2)

    // 1 秒後（＝自分が張った 3 秒の抑制の内側）に、さらに強い点へ上がる。
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    const NEXT = { lat: 35.0, lng: 135.0 }
    view.rerender(eewFocusFrame(map, {
      focusTickRef, ...refs,
      shakeFocus: { ...NEXT, tick: 2, atMs: Date.now() },
    }))

    expect(moveCount(map)).toBe(3)
    expect(map.getCenter()).toEqual({ lng: NEXT.lng, lat: NEXT.lat })
  })

  // 2 つの帯を両方おさえる。
  //   1 秒: 実際に起きる形（能登本震では発報の 0.2 秒後に上昇が来ていた）。引き直しの抑制も生きている帯
  //   5 秒: 引き直しの抑制（3 秒）が明けた後の帯。**猶予が独立した値であることはここでしか分からない**
  //         （1 秒だけだと、猶予を 3 秒へ戻しても通ってしまう）
  it.each([
    ['引き直しの抑制も生きている帯', 1000],
    ['抑制が明けた後の帯', 5000],
  ])('[対照] 新規発報から猶予の内側では譲る（%s）', (_name, elapsedMs) => {
    // Arrange: 初出時刻を記録せずにマウントする（＝新規発報として第一報のフォーカスが走る）。
    const map = createFakeMap({ fitZoom: 7 })
    const focusTickRef = { current: 0 }
    const refs = {
      firstSeenAtRef: { current: new Map<string, number>() },
      focusedEewIdRef: { current: null as string | null },
    }
    const view = render(eewFocusFrame(map, { focusTickRef, ...refs }))
    expect(moveCount(map)).toBe(1)

    // Act: 猶予（SHAKE_FOCUS_YIELD_AFTER_EEW_MS = 10 秒）の内側で揺れの強まりが来る。
    act(() => {
      vi.advanceTimersByTime(elapsedMs)
    })
    view.rerender(eewFocusFrame(map, {
      focusTickRef, ...refs,
      shakeFocus: { ...FAR, tick: 1, atMs: Date.now() },
    }))

    // Assert: 寄らない。連番は消費するので後から蒸し返さない。
    expect(moveCount(map)).toBe(1)
    expect(focusTickRef.current).toBe(1)
  })

  // 猶予の外側。ここが効かないと「発報後は二度と寄らない」になる。
  it('[対照] 猶予を過ぎたら寄る', () => {
    const map = createFakeMap({ fitZoom: 7 })
    const focusTickRef = { current: 0 }
    const refs = {
      firstSeenAtRef: { current: new Map<string, number>() },
      focusedEewIdRef: { current: null as string | null },
    }
    const view = render(eewFocusFrame(map, { focusTickRef, ...refs }))

    // 猶予（10 秒）が明けてから揺れの強まりが来る。
    act(() => {
      vi.advanceTimersByTime(10_100)
    })
    const before = moveCount(map)
    view.rerender(eewFocusFrame(map, {
      focusTickRef, ...refs,
      shakeFocus: { ...FAR, tick: 1, atMs: Date.now() },
    }))

    expect(moveCount(map)).toBe(before + 1)
    expect(map.getCenter()).toEqual({ lng: FAR.lng, lat: FAR.lat })
  })

  it('[安全弁] 譲った要求は、抑制が明けても蒸し返さない', () => {
    const map = createFakeMap({ fitZoom: 7 })
    const focusTickRef = { current: 0 }
    const refs = {
      firstSeenAtRef: { current: new Map<string, number>() },
      focusedEewIdRef: { current: null as string | null },
    }
    const view = render(eewFocusFrame(map, { focusTickRef, ...refs }))
    const focus: ShakeFocus = { ...FAR, tick: 1, atMs: Date.now() }
    view.rerender(eewFocusFrame(map, { focusTickRef, ...refs, shakeFocus: focus }))
    const before = moveCount(map)

    // 第一報の抑制が明けてから、同じ要求のまま再評価される。
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    view.rerender(eewFocusFrame(map, { focusTickRef, ...refs, shakeFocus: focus }))

    // 成長フォローが働くことはあっても、1 点への直行（padding 無し）は起きない。
    const added = fitPaddings(map).slice(before)
    expect(added).not.toContain(undefined)
  })
})


// ── 揺れフォーカスの担当の受け渡し（両方をマウントした結合） ──────────────────────────
// 「EEW が出ていなければ検知追従・出ていれば EEW 追従が寄せる」という排他は、両者が同じ `eews` から
// 算出した値（hasEew と eews.length）を見ていることに依っている。単体テストは片方しかマウントしない
// ため、配線が片方だけ変わっても両方 green のまま「誰も消費しない／両方が消費する」回帰を通してしまう。
// JapanMapGL と同じ順・同じ ref で並べて、境界の両側で「ちょうど 1 回消費され、実際に寄る」ことを固定する。
describe('揺れフォーカスの担当の受け渡し', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const EEW = {
    id: 'eew-1',
    issue: { eventId: 'ev-1' },
    earthquake: {
      originTime: '2026-08-24T05:00:00+09:00',
      hypocenter: { latitude: 37.5, longitude: 137.2, depth: 10 },
    },
  } as unknown as EEWAlert
  const DETECTED = [dp(37.0, 137.0), dp(37.2, 137.4)]
  const FAR = { lat: 33.6, lng: 130.4 }

  function bothFrame(
    map: maplibregl.Map,
    opts: {
      eews: EEWAlert[]
      shakeFocus?: ShakeFocus | null
      focusTickRef: { current: number }
      firstSeenAtRef: { current: Map<string, number> }
      focusedEewIdRef: { current: string | null }
      /** 検知が続いているか（描ける点が無い状態を作るために分ける）。 */
      hasDetection?: boolean
      /** 地図に描けている検知点（空にすると「寄り先なし」の分岐を通る）。 */
      points?: DetectedPoint[]
    },
  ) {
    return h(
      MapGLContext.Provider,
      { value: map },
      h(FitToDetectionGL, {
        points: [...(opts.points ?? DETECTED)],
        hasDetection: opts.hasDetection ?? true,
        // JapanMapGL と同じ導出（同じ eews から作る）。ここが実装の排他の根拠。
        hasEew: opts.eews.length > 0,
        hasCandidate: false,
        shakeFocus: opts.shakeFocus ?? null,
        lastConsumedFocusTickRef: opts.focusTickRef,
      }),
      h(FitToEEWGL, {
        eews: opts.eews,
        psWave: [],
        detectedPoints: [...DETECTED],
        hasDetection: true,
        candidatePoints: [],
        forecastAreaPositions: [],
        firstSeenAtRef: opts.firstSeenAtRef,
        focusedEewIdRef: opts.focusedEewIdRef,
        shakeFocus: opts.shakeFocus ?? null,
        lastConsumedFocusTickRef: opts.focusTickRef,
      }),
    )
  }

  /** 初期フィットの飛行を終わらせた状態を作る（第一報が走らないよう、EEW は 1 分前に初出とする）。 */
  function settled(eews: EEWAlert[], focusTickRef: { current: number }) {
    const map = createFakeMap({ fitZoom: 7 })
    const refs = {
      firstSeenAtRef: { current: new Map(eews.map((e) => [e.issue?.eventId ?? e.id, Date.now() - 60_000])) },
      focusedEewIdRef: { current: null as string | null },
    }
    const view = render(bothFrame(map, { eews, focusTickRef, ...refs }))
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    return { map, view, refs }
  }

  it('[正] EEW 発報中は、ちょうど 1 回消費されてその点へ寄る', () => {
    const focusTickRef = { current: 0 }
    const { map, view, refs } = settled([EEW], focusTickRef)
    const before = moveCount(map)

    view.rerender(bothFrame(map, {
      eews: [EEW], focusTickRef, ...refs,
      shakeFocus: { ...FAR, tick: 1, atMs: Date.now() },
    }))

    // 誰も消費しない（＝寄らない）ことも、両方が消費すること（＝二重に飛ぶ）もない。
    expect(focusTickRef.current).toBe(1)
    expect(moveCount(map)).toBe(before + 1)
    expect(map.getCenter()).toEqual({ lng: FAR.lng, lat: FAR.lat })
  })

  it('[正] EEW が無ければ、同じくちょうど 1 回消費されてその点へ寄る', () => {
    const focusTickRef = { current: 0 }
    const { map, view, refs } = settled([], focusTickRef)
    const before = moveCount(map)

    view.rerender(bothFrame(map, {
      eews: [], focusTickRef, ...refs,
      shakeFocus: { ...FAR, tick: 1, atMs: Date.now() },
    }))

    expect(focusTickRef.current).toBe(1)
    expect(moveCount(map)).toBe(before + 1)
    expect(map.getCenter()).toEqual({ lng: FAR.lng, lat: FAR.lat })
  })

  // 反証で見つかった穴: EEW 中に「検知が終わっている」「描ける点が無い」状態で要求が来ると、
  // 検知側の早期 return が消費してしまい、EEW 側が拾えなくなる（担当していない側は消費しない規則）。
  it.each([
    ['検知が終わっている', { hasDetection: false, points: [] as DetectedPoint[] }],
    ['描ける点が無い', { hasDetection: true, points: [] as DetectedPoint[] }],
  ])('[安全弁] EEW 中に %s 状態で要求が来ても、EEW 側が寄せる', (_name, state) => {
    const focusTickRef = { current: 0 }
    const { map, view, refs } = settled([EEW], focusTickRef)
    const before = moveCount(map)

    view.rerender(bothFrame(map, {
      eews: [EEW], focusTickRef, ...refs, ...state,
      shakeFocus: { ...FAR, tick: 1, atMs: Date.now() },
    }))

    expect(focusTickRef.current).toBe(1)
    expect(moveCount(map)).toBe(before + 1)
    expect(map.getCenter()).toEqual({ lng: FAR.lng, lat: FAR.lat })
  })

  it('[安全弁] EEW が消えたのと同じコミットで要求が来ても、消費されずに残らない', () => {
    // 解除の帰還（検知点全体へのフィット）が最後に走って画を上書きするが、要求が未消費のまま
    // 残ると、次の評価で「終わった揺れの点」へ寄り直す余地ができる。
    const focusTickRef = { current: 0 }
    const { map, view, refs } = settled([EEW], focusTickRef)

    view.rerender(bothFrame(map, {
      eews: [], focusTickRef, ...refs,
      shakeFocus: { ...FAR, tick: 1, atMs: Date.now() },
    }))

    expect(focusTickRef.current).toBe(1)
  })
})
