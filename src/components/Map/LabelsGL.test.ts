// @vitest-environment jsdom
//
// ラベルの重なり判定が「いつ走るか」を固定するテスト。**守れる範囲を先に書いておく。**
//
// 固定しているのは 2 つだけ。
//   1. 判定のスケジュール effect が、マウント時に無条件で `schedule()` を呼ぶこと
//   2. 境界データの非同期ロードが終わったあとの再評価要求が、設定済みの ref に届くこと
//
// LabelsGL は判定関数を ref 経由で呼んでおり、それを設定するのは 3 番目の effect
// （`[map, overlapSignature]`）。前 2 つの effect が同期的に出す要求は ref がまだ no-op なので
// 空振りする。**初回の判定は 3 番目が自分で `schedule()` を呼ぶことだけで成立している**——ここが
// 消えると、起動直後に既に重なっているラベルが退避されないまま、次の地図操作まで直らない。
//
// **「effect の宣言順」までは守れていない。** React は初回マウントで全 effect を同期的に流すため、
// 順序を入れ替えても 200ms のデバウンスが明ける頃には全部そろっている。実際、倍率 effect の同期
// 要求を削ってもこのテストは 3 件とも通る（＝マウント時に空振りしていることの裏返し）。順序そのものを
// 守りたいなら、effect の間にマイクロタスク境界を挟む別の作りが要る。
//
// JSX を使わないのは、vitest の include が `src/**/*.test.ts` だけを拾うため（`.tsx` は走らない）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { MapGLContext } from './mapGLContext'
import { LabelsGL } from './LabelsGL'
import type { Map as MapLibreMap } from 'maplibre-gl'

type LatLng = [number, number]
const PREFS = {
  石川県: {
    label: [36.6, 136.6] as LatLng,
    room: [0.1, 0.1] as LatLng,
    rings: [[[36.5, 136.5], [36.7, 136.8], [36.6, 136.6]] as LatLng[]],
  },
}
const SUBS = [
  {
    name: '石川県能登',
    label: [37.3, 136.9] as LatLng,
    room: [0.2, 0.3] as LatLng,
    rings: [[[37.0, 136.5], [37.5, 137.2], [37.2, 136.6]] as LatLng[]],
  },
]

// 地図ペインの実寸と、フェイクの投影が使う中心・縮尺。
//
// **投影は「カメラ中心が画面の中央に来る」形にすること**（実物の `map.project()` と同じ）。
// 経度緯度をそのまま定数倍する形だと、日本の実座標（地方名の `REGIONS` は経度 128〜142.8・
// 緯度 26.5〜43.4）がペインの遥か外に落ちる。重なり判定は画面の外にあるラベルを問い合わせ前に
// 外すため（`gl/labelOverlap.ts` の `isOffScreen`）、そうなると**判定が 1 回も走らず**、
// 「いつ判定が走るか」を見ているこのテストは意味を失う。縮尺は日本全体がこのペインに収まる値。
const PANE_WIDTH = 800
const PANE_HEIGHT = 600
const CENTER = { lng: 135.4, lat: 35 }
const PX_PER_DEG = 30

/** 判定が走った回数を数えられる最小の map。判定は queryRenderedFeatures の呼び出しで観測する。 */
function fakeMap() {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>()
  const handlers = new Map<string, (() => void)[]>()
  let queryCalls = 0
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
    // 判定対象のレイヤーが 1 つも無いと重なりを見ずに返してしまうので、1 つだけ在ることにする。
    getLayer: (id: string) => (id === 'quake-points' ? { id } : undefined),
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    removeSource: (id: string) => sources.delete(id),
    setLayoutProperty: vi.fn(),
    project: ([lng, lat]: LatLng) => ({
      x: (lng - CENTER.lng) * PX_PER_DEG + PANE_WIDTH / 2,
      y: (CENTER.lat - lat) * PX_PER_DEG + PANE_HEIGHT / 2,
    }),
    queryRenderedFeatures: () => {
      queryCalls++
      return []
    },
    on: (ev: string, fn: () => void) => handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    off: vi.fn(),
    getZoom: () => 8,
    getContainer: () => ({ clientWidth: PANE_WIDTH, clientHeight: PANE_HEIGHT }),
  }
  return {
    map: map as unknown as MapLibreMap,
    sources,
    get queryCalls() {
      return queryCalls
    },
    fire: (ev: string) => (handlers.get(ev) ?? []).forEach((f) => f()),
  }
}

// 境界データの取得は**手動で解決する**。即解決だと「ロード前の初回判定」と「ロード完了後の再判定」が
// 同じ 1 回に潰れてしまい、後者が走っているかを観測できない。
const loaders = vi.hoisted(() => {
  let resolvePrefs: (v: unknown) => void = () => {}
  let resolveSubs: (v: unknown) => void = () => {}
  return {
    prefs: () => new Promise((r) => (resolvePrefs = r)),
    subs: () => new Promise((r) => (resolveSubs = r)),
    resolveAll: (p: unknown, s: unknown) => {
      resolvePrefs(p)
      resolveSubs(s)
    },
    // テスト間で解決関数が持ち越されないようにする（最後にマウントしたものが勝つ作りなので、
    // リセットしないとテストの追加・並べ替えで暗黙に壊れる）。
    reset: () => {
      resolvePrefs = () => {}
      resolveSubs = () => {}
    },
  }
})
vi.mock('../../utils/prefectures', () => ({ loadPrefectures: () => loaders.prefs() }))
vi.mock('../../utils/subregions', () => ({ loadSubRegions: () => loaders.subs() }))
// 地方名の下限はペインの寸法から決まるが、ここで見たいのは判定の発火だけなので固定値でよい。
vi.mock('./gl/viewSpan', () => ({
  bindDynamicZoomRange: () => () => {},
  clampMinZoom: (v: number) => v,
}))
vi.mock('./gl/zoomLevels', () => ({ labelMinZoom: () => 4.5 }))
vi.mock('./gl/layerOrder', () => ({
  addOrderedLayer: (m: MapLibreMap, layer: { id: string }) => m.addLayer(layer as never),
}))

function mount(map: MapLibreMap) {
  return render(
    createElement(MapGLContext.Provider, { value: map }, createElement(LabelsGL, { overlapSignature: '', iconScale: 1 })),
  )
}

describe('LabelsGL の重なり判定が走るタイミング', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    loaders.reset()
  })
  // globals を有効にしていないため @testing-library/react の自動クリーンアップが働かない。
  // 明示的に外す（CameraFollowsGL.test.ts と同じ理由）。
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('マウント直後に判定が走る（スケジュール effect が無条件に schedule() を呼ぶ）', async () => {
    const h = fakeMap()
    mount(h.map)
    expect(h.queryCalls).toBe(0) // デバウンスの前は走らない
    await vi.advanceTimersByTimeAsync(250)
    expect(h.queryCalls).toBeGreaterThan(0)
  })

  it('県名・区域名のロード完了後にも判定が走る（構築 effect からの要求が有効になっている）', async () => {
    const h = fakeMap()
    mount(h.map)
    // まだ地方名しか無い状態で 1 度目の判定が終わる
    await vi.advanceTimersByTimeAsync(250)
    const afterFirst = h.queryCalls
    expect(afterFirst).toBeGreaterThan(0)
    expect(h.sources.has('basemap-subregion-labels')).toBe(false)

    // ここで境界データが届く。構築 effect の完了ハンドラが再評価を要求する
    loaders.resolveAll(PREFS, SUBS)
    await vi.advanceTimersByTimeAsync(250)
    expect(h.sources.has('basemap-pref-labels')).toBe(true)
    expect(h.sources.has('basemap-subregion-labels')).toBe(true)
    expect(h.queryCalls).toBeGreaterThan(afterFirst)
  })

  it('地図の移動でも判定が走る', async () => {
    const h = fakeMap()
    mount(h.map)
    await vi.advanceTimersByTimeAsync(250)
    const before = h.queryCalls
    h.fire('moveend')
    await vi.advanceTimersByTimeAsync(250)
    expect(h.queryCalls).toBeGreaterThan(before)
  })
})
