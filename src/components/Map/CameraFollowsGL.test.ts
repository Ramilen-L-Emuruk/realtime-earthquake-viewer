// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest'
import { createElement as h } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import type * as maplibregl from 'maplibre-gl'
import { MapGLContext } from './mapGLContext'
import { FitToCandidateGL, FitToDetectionGL, TsunamiFitGL, FocusObsGL } from './CameraFollowsGL'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import type { LatLng } from '../../utils/stationCoords'

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

// fitJapan は padding 20、点群へのフィット（fitToPositions）は padding 60 で呼ばれる
// （gl/camera.ts の各既定値）。「日本全体へ戻した」のか「点群へ寄せた」のかの区別にこれを使う。
const JAPAN_PADDING = 20
const POINTS_PADDING = 60

// 津波の俯瞰へ帰る猶予の長さ。gl/camera.ts の INTERACTION_HOLD_SEC と同値を独立に持つ
// （上の padding と同じ方針。実装側を変えたらこのテストが落ちて気づける）。
const INTERACTION_HOLD_SEC = 30

// maplibregl.Map を模したフェイク（gl/camera.test.ts と同じ方針）。カメラ操作系は spy にして
// 呼び出しを観測し、イベント API は登録と発火だけを再現する。
function createFakeMap() {
  const handlers = new Map<string, Set<() => void>>()
  const onceHandlers = new Map<string, Set<() => void>>()
  const fake = {
    on(event: string, handler: () => void) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler)
    },
    off(event: string, handler: () => void) {
      handlers.get(event)?.delete(handler)
    },
    once(event: string, handler: () => void) {
      if (!onceHandlers.has(event)) onceHandlers.set(event, new Set())
      onceHandlers.get(event)!.add(handler)
    },
    fire(event: string) {
      for (const handler of handlers.get(event) ?? []) handler()
      const once = onceHandlers.get(event)
      if (once) {
        for (const handler of once) handler()
        once.clear()
      }
    },
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
    // 成長フォローの「収まっているか」判定用。広い視野を返して常に収まっている扱いにする
    // （このテストの関心は検知終了の分岐であり、成長フォローを誘発させたくない）。
    getBounds: () => ({ getWest: () => 100, getSouth: () => 10, getEast: () => 160, getNorth: () => 60 }),
    cameraForBounds: () => ({ center: [138, 38] as [number, number], zoom: 7 }),
  }
  return fake as unknown as maplibregl.Map & { fire: (event: string) => void }
}

const dp = (lat: number, lng: number): DetectedPoint => ({ key: `${lat},${lng}`, lat, lng, index: 20 })

/** fitBounds の呼び出しごとの padding。どの経路が呼ばれたかの判別に使う。 */
function fitPaddings(map: maplibregl.Map): number[] {
  return (map.fitBounds as unknown as Mock).mock.calls.map((call) => call[1]?.padding)
}

// JapanMapGL と同じ順序で置く（effect はツリー順に走るため、順序に意味がある）。
function harness(map: maplibregl.Map, detected: DetectedPoint[], candidate: DetectedPoint[], candidateId: number | null) {
  return h(
    MapGLContext.Provider,
    { value: map },
    h(FitToCandidateGL, {
      points: candidate,
      candidateId,
      hasEew: false,
      hasDetection: detected.length > 0,
    }),
    h(FitToDetectionGL, {
      points: detected,
      hasEew: false,
      hasCandidate: candidateId !== null && candidate.length > 0,
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
function fitTargets(map: maplibregl.Map): number[] {
  return (map.fitBounds as unknown as Mock).mock.calls.map((call) =>
    call[1]?.padding === JAPAN_PADDING ? -1 : (call[0] as maplibregl.LngLatBounds).getWest(),
  )
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
