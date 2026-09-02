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
  // 巡回の**途中**へ割り込むための穴。判定は queryRenderedFeatures を通してしか外から
  // 観測できないので、そこで回数を見て好きなタイミングでイベントを起こす。
  let onQuery: ((n: number) => void) | null = null
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
      onQuery?.(queryCalls)
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
    /** 全ソースの setData が呼ばれた合計回数（＝判定結果が画面へ書き戻された回数）。 */
    get setDataCalls() {
      return [...sources.values()].reduce((n, src) => n + src.setData.mock.calls.length, 0)
    },
    setOnQuery: (fn: ((n: number) => void) | null) => (onQuery = fn),
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

function mount(map: MapLibreMap, props: { overlapSignature?: string; recording?: boolean } = {}) {
  const element = (p: typeof props) =>
    createElement(
      MapGLContext.Provider,
      { value: map },
      createElement(LabelsGL, { overlapSignature: '', iconScale: 1, ...p }),
    )
  const view = render(element(props))
  return { ...view, setProps: (p: typeof props) => view.rerender(element(p)) }
}

/**
 * `performance.now()` を 1 回読むごとに `stepMs` 進める。
 *
 * 偽タイマー下では時計が同期実行の途中で進まないため、判定は**必ず 1 チャンクで終わってしまう**。
 * 分割が起きる状態を作るには時計側を動かすしかない。1 チャンクの予算は 5ms なので、4ms 刻みなら
 * 2 件ごとに区切られる。
 */
function stubAdvancingClock(stepMs: number): void {
  let t = 0
  vi.spyOn(performance, 'now').mockImplementation(() => (t += stepMs))
}

/**
 * `setTimeout` に渡された待ち時間を集める（デバウンス以上の長さのものだけ）。
 *
 * 最小間隔を**どの時刻から測っているか**は、判定が走った・走らないだけでは区別できない
 * （どちらの測り方でも 1 秒待てば走る）。予約に渡る値そのものを見るしかない。
 */
function spyScheduledDelays(): number[] {
  const delays: number[] = []
  const original = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
    if (typeof ms === 'number' && ms > OVERLAP_CHECK_DEBOUNCE_MS) delays.push(ms)
    return original(cb, ms)
  }) as typeof setTimeout)
  return delays
}

/** 実装が持つデバウンス値（`LabelsGL.tsx` と同値。予約の選別にのみ使う）。 */
const OVERLAP_CHECK_DEBOUNCE_MS = 200

describe('LabelsGL の重なり判定が走るタイミング', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    loaders.reset()
  })
  // globals を有効にしていないため @testing-library/react の自動クリーンアップが働かない。
  // 明示的に外す（CameraFollowsGL.test.ts と同じ理由）。
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('マウント直後に判定が走る（スケジュール effect が無条件に schedule() を呼ぶ）', async () => {
    const h = fakeMap()
    mount(h.map)
    expect(h.queryCalls).toBe(0) // デバウンスの前は走らない
    await vi.advanceTimersByTimeAsync(250)
    expect(h.queryCalls).toBeGreaterThan(0)
  })

  // **この 2 件は待ち時間を延ばした。** 判定が走ること自体は変わらないが、直前の判定から
  // `OVERLAP_MIN_INTERVAL_MS`（1 秒）空くまで次を始めない設計に変えたため、デバウンスの
  // 250ms では明けない。この延長を短くしたくなったら、それは最小間隔を疑うということ。
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
    await vi.advanceTimersByTimeAsync(1100)
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
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.queryCalls).toBeGreaterThan(before)
  })
})

// 再評価の最小間隔。**デバウンスとは別物**なので、デバウンスが明けても走らないことを見る。
describe('LabelsGL の重なり判定の最小間隔', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    loaders.reset()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('正: 直前の判定から 1 秒以上空いていれば、デバウンスの 200ms で走る', async () => {
    const h = fakeMap()
    mount(h.map)
    await vi.advanceTimersByTimeAsync(250)
    const before = h.queryCalls
    await vi.advanceTimersByTimeAsync(1000)
    h.fire('moveend')
    await vi.advanceTimersByTimeAsync(250)
    expect(h.queryCalls).toBeGreaterThan(before)
  })

  it('対照: 1 秒空いていなければ、デバウンスが明けても走らない', async () => {
    const h = fakeMap()
    mount(h.map)
    await vi.advanceTimersByTimeAsync(250)
    const before = h.queryCalls
    // 直前の判定から 250ms しか経っていない状態で要求する
    h.fire('moveend')
    await vi.advanceTimersByTimeAsync(300)
    expect(h.queryCalls).toBe(before)
  })

  // **この 2 件が本題。** 最小間隔を置きたかったのは「マーカーの位置が毎秒入れ替わる地震の最中」で、
  // moveend ではない。判定を駆動する effect の依存に再評価の契機を入れると、契機が来るたびに
  // effect ごと作り直されて「前の判定が終わった時刻」が初期値に戻り、**間隔がまったく効かなくなる**。
  it('対照: マーカーの位置が変わっても、前の判定から 1 秒以内なら走らない', async () => {
    const h = fakeMap()
    const view = mount(h.map, { overlapSignature: 'a' })
    await vi.advanceTimersByTimeAsync(250)
    const before = h.queryCalls
    view.setProps({ overlapSignature: 'b' })
    await vi.advanceTimersByTimeAsync(300)
    expect(h.queryCalls).toBe(before)
  })

  it('正: マーカーの位置が変わり、1 秒空いていれば走る', async () => {
    const h = fakeMap()
    const view = mount(h.map, { overlapSignature: 'a' })
    await vi.advanceTimersByTimeAsync(250)
    const before = h.queryCalls
    await vi.advanceTimersByTimeAsync(1000)
    view.setProps({ overlapSignature: 'b' })
    await vi.advanceTimersByTimeAsync(250)
    expect(h.queryCalls).toBeGreaterThan(before)
  })

  it('安全弁: 間隔は「前の判定が終わった時刻」から測る（始めた時刻ではない）', async () => {
    // 分割を強制したうえで、次の予約へ渡る待ち時間を直接見る。
    // 実測（地方ラベル 10 件・時計 4ms 刻み）: 完了時刻から測ると 996ms、開始時刻から測ると 944ms。
    // 差は 1 巡の所要時間ぶん。**完了時刻から測る限りこの値は巡回の長さに依らず 1000ms − 数 ms で
    // 一定**なのに対し、開始時刻から測るとラベルが増えるほど小さくなる。閾値は 980ms に置く。
    stubAdvancingClock(4)
    const delays = spyScheduledDelays()
    const h = fakeMap()
    mount(h.map)
    await vi.advanceTimersByTimeAsync(1100)
    h.fire('moveend')
    await vi.advanceTimersByTimeAsync(50)
    expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(980)
  })

  it('安全弁: 待たされた要求は捨てられない（間隔が明ければ走る）', async () => {
    const h = fakeMap()
    mount(h.map)
    await vi.advanceTimersByTimeAsync(250)
    const before = h.queryCalls
    h.fire('moveend')
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.queryCalls).toBeGreaterThan(before)
  })
})

// 1 巡を複数フレームに分けて進めることと、その分割が新たに持ち込む危険（途中でカメラが動く）を
// 固定する。正・対照・安全弁の 3 種。
describe('LabelsGL の重なり判定の分割実行', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    loaders.reset()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('正: 予算を超えたら次のフレームへ継ぐ（書き戻しは全件そろってから 1 回だけ）', async () => {
    stubAdvancingClock(4)
    const h = fakeMap()
    // 分割の観測は requestAnimationFrame の呼び出しで行う。React も fakeMap も rAF を使わない
    // ため、ここに現れるのは判定の継ぎ足しだけ。
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
    mount(h.map)
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.queryCalls).toBeGreaterThan(0)
    expect(raf).toHaveBeenCalled()
    // 途中経過は書き戻さない。地方ラベルのソースは 1 つなので、1 巡で 1 回だけ。
    expect(h.setDataCalls).toBe(1)
  })

  it('対照: 予算に収まるうちは分割しない（時計が進まなければ 1 フレームで終わる）', async () => {
    const h = fakeMap()
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
    mount(h.map)
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.queryCalls).toBeGreaterThan(0)
    expect(raf).not.toHaveBeenCalled()
  })

  it('安全弁: 巡回の途中でカメラが動き出したら、その巡回の結果は書き戻さない', async () => {
    stubAdvancingClock(4)
    const h = fakeMap()
    mount(h.map)
    // 3 件目を判定しているところで飛行が始まる。前半は古いカメラで投影した結果なので混ぜられない。
    h.setOnQuery((n) => {
      if (n === 3) h.fire('movestart')
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.queryCalls).toBeGreaterThan(0)
    expect(h.setDataCalls).toBe(0)
  })
})

// 録画モードは「判定をカメラが止まったときだけに絞る」もの。moveend まで止めてしまうと、
// 移動後にラベルが重なったままになる。
describe('LabelsGL の録画モード', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    loaders.reset()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('正: マーカーの位置が変わっても判定を走らせない', async () => {
    const h = fakeMap()
    const view = mount(h.map, { recording: true, overlapSignature: 'a' })
    await vi.advanceTimersByTimeAsync(1100)
    const before = h.queryCalls
    view.setProps({ recording: true, overlapSignature: 'b' })
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.queryCalls).toBe(before)
  })

  it('対照: 録画モードでなければ、位置が変わると判定が走る', async () => {
    const h = fakeMap()
    const view = mount(h.map, { overlapSignature: 'a' })
    await vi.advanceTimersByTimeAsync(1100)
    const before = h.queryCalls
    view.setProps({ overlapSignature: 'b' })
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.queryCalls).toBeGreaterThan(before)
  })

  it('安全弁: 録画モードでも地図の移動では判定が走る', async () => {
    const h = fakeMap()
    mount(h.map, { recording: true })
    await vi.advanceTimersByTimeAsync(1100)
    const before = h.queryCalls
    h.fire('moveend')
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.queryCalls).toBeGreaterThan(before)
  })
})
