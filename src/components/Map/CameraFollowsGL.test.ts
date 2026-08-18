// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import { createElement as h } from 'react'
import { render, cleanup } from '@testing-library/react'
import type * as maplibregl from 'maplibre-gl'
import { MapGLContext } from './mapGLContext'
import { FitToCandidateGL, FitToDetectionGL } from './CameraFollowsGL'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'

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

const dp = (lat: number, lng: number): DetectedPoint => ({ lat, lng, index: 20 })

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
