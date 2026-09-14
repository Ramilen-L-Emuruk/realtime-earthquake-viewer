// @vitest-environment jsdom
//
// 一覧の行から吹き出しを開く経路（`openPopupAt`）を固定する。
// 地図のクリックと同じ判定を通すこと・着地直後の 1 コミット遅れを吸収すること・
// それでも当たらなければ前の選択を残さないこと。
// 背景は docs/spec/quake-spec.md §8「一覧の行をクリックしたときの寄り先」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MapGeoJSONFeature } from 'maplibre-gl'

interface FakePopupLike { opened: boolean; wasAdded: boolean; isOpen(): boolean }

/**
 * 吹き出しの開閉だけを覚える置き換え。**本物の DOM は見ない**。
 * 作られた実体は `globalThis.__fakePopups` へ積み、テストから開閉を読む。
 */
vi.mock('maplibre-gl', () => {
  class FakePopup {
    opened = false
    /** 一度でも地図へ載ったか。クリック用とホバー用を見分けるために使う。 */
    wasAdded = false
    constructor() {
      ;((globalThis as unknown as { __fakePopups: FakePopup[] }).__fakePopups ??= []).push(this)
    }
    setLngLat() { return this }
    setHTML() { return this }
    addTo() { this.opened = true; this.wasAdded = true; return this }
    remove() { this.opened = false; return this }
    isOpen() { return this.opened }
    on() { return this }
    off() { return this }
  }
  return { default: { Popup: FakePopup }, Popup: FakePopup }
})

import { registerPopupSource, openPopupAt, closeMapPopup } from './popupRegistry'

const FEATURE = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [139, 35] },
  properties: {},
} as unknown as MapGeoJSONFeature

/** 地図へ載ったことのある吹き出し（＝クリック用の 1 枚）。 */
function openedPopup(): FakePopupLike | undefined {
  const popups = (globalThis as unknown as { __fakePopups?: FakePopupLike[] }).__fakePopups ?? []
  return popups.find((p) => p.wasAdded)
}

/** `requestAnimationFrame` を手で進める。聞き直しの回数を数えたいため。 */
let frames: (() => void)[] = []
function flushFrames(n: number) {
  for (let i = 0; i < n; i++) {
    const due = frames
    frames = []
    for (const fn of due) fn()
  }
}

function makeMap() {
  const handlers: Record<string, ((e: unknown) => void)[]> = {}
  const map = {
    on: (ev: string, fn: (e: unknown) => void) => { (handlers[ev] ??= []).push(fn) },
    off: (ev: string, fn: (e: unknown) => void) => {
      handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== fn)
    },
    getCanvas: () => ({ style: { cursor: '' } }),
    getLayer: () => ({}),
    queryRenderedFeatures: () => [],
    isMoving: () => false,
    // 目当ての点 [139, 35] を (10, 20) に置き、1 度 = 100px の簡易投影。
    project: (ll: [number, number]) => ({ x: 10 + (ll[0] - 139) * 100, y: 20 - (ll[1] - 35) * 100 }),
  }
  const click = () => {
    for (const fn of handlers.click ?? []) fn({ point: { x: 1, y: 1 }, lngLat: { lng: 139, lat: 35 } })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { map: map as any, click }
}

beforeEach(() => {
  ;(globalThis as unknown as { __fakePopups: FakePopupLike[] }).__fakePopups = []
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return 0 })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('一覧の行から吹き出しを開く（openPopupAt）', () => {
  // **正: クリックと同じ経路を通るので、呼び出し側はどのレイヤーかを知らなくてよい。**
  it('その場所にある描画物の吹き出しを開く', () => {
    const { map } = makeMap()
    const buildClickHtml = vi.fn(() => '<p>加賀市大聖寺南町</p>')
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8,
      pick: () => FEATURE,
      buildClickHtml,
    })

    openPopupAt(map, [139, 35])

    expect(buildClickHtml).toHaveBeenCalledWith(FEATURE)
    expect(openedPopup()?.isOpen()).toBe(true)
  })

  // 正: 判定に渡すのは「渡された経緯度を投影した画面座標」で、直前のクリック位置ではない。
  it('渡された場所を投影して判定する', () => {
    const { map } = makeMap()
    const pick = vi.fn(() => FEATURE)
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8, pick, buildClickHtml: () => '',
    })

    openPopupAt(map, [139, 35])

    expect(pick).toHaveBeenCalledWith({ x: 10, y: 20 }, true)
  })

  // **正: 着地直後はレイヤーの表示切替が 1 コミット遅れる。** 数フレーム聞き直して拾う。
  it('すぐに当たらなくても、レイヤーが出てくるまで聞き直す', () => {
    const { map } = makeMap()
    const buildClickHtml = vi.fn(() => '<p>x</p>')
    let visible = false
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8,
      pick: () => (visible ? FEATURE : null),
      buildClickHtml,
    })

    openPopupAt(map, [139, 35])
    expect(buildClickHtml).not.toHaveBeenCalled()

    visible = true
    flushFrames(1)

    expect(buildClickHtml).toHaveBeenCalled()
  })

  // **対照: 地図のクリックは聞き直さない。** 何も無い場所を押したのだから即座に閉じてよく、
  // 聞き直すと「押したのに閉じない」数フレームができる。
  it('地図のクリックは、当たらなければ聞き直さずに閉じる', () => {
    const { map, click } = makeMap()
    let visible = false
    const buildClickHtml = vi.fn(() => '<p>x</p>')
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8,
      pick: () => (visible ? FEATURE : null),
      buildClickHtml,
    })

    click()
    visible = true
    flushFrames(3)

    expect(buildClickHtml).not.toHaveBeenCalled()
  })

  // **安全弁: 聞き直しには限りがある。** 無限に待つと、寄り先に何も無い場所を押したとき
  // 前に選んだ観測点の吹き出しが別の場所に残り続ける。
  it('聞き直しても当たらなければ、開いていた吹き出しを閉じる', () => {
    const { map } = makeMap()
    let visible = true
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8,
      pick: () => (visible ? FEATURE : null),
      buildClickHtml: () => '<p>x</p>',
    })

    openPopupAt(map, [139, 35])
    expect(openedPopup()?.isOpen()).toBe(true)

    visible = false
    openPopupAt(map, [140, 36])
    flushFrames(20)

    expect(openedPopup()?.isOpen()).toBe(false)
  })

  // **正: 地図全面を覆う「最後の受け皿」には落ちない。** 落ちると空振りが起きなくなり、
  // 目当ての点の層がまだ描かれていない一瞬に、押した行と無関係な区域名が開く。
  it('点より下の優先度は見ない（区域名の受け皿へ落ちない）', () => {
    const { map } = makeMap()
    const basemapHtml = vi.fn(() => '<p>石川県能登</p>')
    registerPopupSource(map, {
      layerId: 'subregion-hit', priority: 'basemap', tolPx: 0,
      pick: () => FEATURE, buildClickHtml: basemapHtml,
    })
    const pointHtml = vi.fn(() => '<p>輪島市鳳至町</p>')
    let drawn = false
    registerPopupSource(map, {
      layerId: 'quake-lpgm-points', priority: 'point', tolPx: 8,
      pick: () => (drawn ? FEATURE : null), buildClickHtml: pointHtml,
    })

    openPopupAt(map, [139, 35])
    expect(basemapHtml).not.toHaveBeenCalled()

    // 点の層が描かれた次のフレームで、目当ての点が開く。
    drawn = true
    flushFrames(1)

    expect(pointHtml).toHaveBeenCalled()
    expect(basemapHtml).not.toHaveBeenCalled()
  })

  // 対照: 地図のクリックは全優先度を見る（どこを押しても区域名は出す）。
  it('地図のクリックは受け皿まで見る', () => {
    const { map, click } = makeMap()
    const basemapHtml = vi.fn(() => '<p>石川県能登</p>')
    registerPopupSource(map, {
      layerId: 'subregion-hit', priority: 'basemap', tolPx: 0,
      pick: () => FEATURE, buildClickHtml: basemapHtml,
    })

    click()

    expect(basemapHtml).toHaveBeenCalled()
  })

  // **正: 当たり判定に紛れ込んだ隣のバッジではなく、その座標の点を採る。**
  // バッジは絵として重なるので、隣の点も当たり判定に入る。クリックなら「いちばん強いもの」で
  // よいが、一覧の行から開くときはその座標の点しか正解が無い（実測で 5.5km 離れた区域の
  // 代表点が、震度が高いというだけで採られた）。
  it('近くにもっと強いバッジがあっても、その座標の点を採る', () => {
    const { map } = makeMap()
    const near = {
      type: 'Feature', geometry: { type: 'Point', coordinates: [139, 35] },
      properties: { scale: 40, addr: '大分市明野北' },
    } as unknown as MapGeoJSONFeature
    const strongerButFar = {
      type: 'Feature', geometry: { type: 'Point', coordinates: [139.05, 35.02] },
      properties: { scale: 45, addr: '大分県中部' },
    } as unknown as MapGeoJSONFeature
    const buildClickHtml = vi.fn((f: MapGeoJSONFeature) => String(f.properties?.addr))
    // `rankKey` が効くのは queryRenderedFeatures の経路なので、そちらで確かめる。
    map.queryRenderedFeatures = () => [strongerButFar, near]
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8, rankKey: 'scale', buildClickHtml,
    })

    openPopupAt(map, [139, 35])

    expect(buildClickHtml).toHaveBeenCalledWith(near)
  })

  // **安全弁: 聞き直しの最中に次の要求が来たら、古い系列は降りる。**
  // 降りないと、1 枚しかない吹き出しを 2 つの系列が取り合い、先発の遅れた解決が後発を上書きする。
  // いまの呼び出し方（常に 1 秒の飛行を挟む）では先発が先に決着するので事故らないが、
  // それを保証しているのは呼び出し側の都合なので、ここで断ち切っておく。
  it('聞き直し中に次の要求が来たら、古い要求は結果を出さない', () => {
    const { map } = makeMap()
    const opened: string[] = []
    let firstVisible = false
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8,
      pick: () => (firstVisible ? FEATURE : null),
      buildClickHtml: () => { opened.push('先発'); return '' },
    })

    openPopupAt(map, [139, 35])   // 当たらないので聞き直しに入る
    openPopupAt(map, [139, 35])   // その最中に次の要求
    // 先発が探していたものが、後から見えるようになる。
    firstVisible = true
    flushFrames(20)

    // 開いたのは 1 回だけ（後発の系列。先発は降りている）。
    expect(opened).toHaveLength(1)
  })

  // **安全弁: 座標で選ぶときは、登録順で決め打たない。**
  // 同じ場所に候補を持つレイヤーが複数あったとき、登録順で勝敗が決まると
  // 目当てでない層の吹き出しが無言で開く。
  it('点の層が複数あっても、いちばん近い点を持つ層を採る', () => {
    const { map } = makeMap()
    const far = {
      type: 'Feature', geometry: { type: 'Point', coordinates: [139.05, 35] },
      properties: { addr: '遠い方' },
    } as unknown as MapGeoJSONFeature
    const near = {
      type: 'Feature', geometry: { type: 'Point', coordinates: [139, 35] },
      properties: { addr: '近い方' },
    } as unknown as MapGeoJSONFeature
    const opened: string[] = []
    const record = (f: MapGeoJSONFeature) => { opened.push(String(f.properties?.addr)); return '' }
    // 先に登録した層のほうが遠い点を持つ。
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8,
      pick: () => far, buildClickHtml: record,
    })
    registerPopupSource(map, {
      layerId: 'quake-lpgm-points', priority: 'point', tolPx: 8,
      pick: () => near, buildClickHtml: record,
    })

    openPopupAt(map, [139, 35])

    expect(opened).toEqual(['近い方'])
  })

  // 安全弁: レイヤーが 1 つも登録されていない地図では調停役ごと存在しない。
  it('登録が無い地図では何もしない', () => {
    const { map } = makeMap()
    expect(() => openPopupAt(map, [139, 35])).not.toThrow()
    expect(() => closeMapPopup(map)).not.toThrow()
  })

  // **正: 判定が返ってこないまま尽きたときも、開いていた吹き出しは閉じる。**
  // 残すと、別の場所の情報を押した場所の答えとして見せることになる（この調停役が約束している
  // 「1 クリックにつき 1 枚」もそこで破れる）。**地図のクリックで効くことが肝心** ——
  // 一覧の行から開く経路は寄せる前に閉じてあるので、そもそも残るものが無い。
  it('判定が返ってこないまま尽きたら、地図のクリックでも前の吹き出しを閉じる', () => {
    const { map, click } = makeMap()
    let answer: 'hit' | 'pending' = 'hit'
    registerPopupSource(map, {
      layerId: 'hypocenter', priority: 'point', tolPx: 8,
      pick: () => (answer === 'hit' ? FEATURE : 'pending'),
      buildClickHtml: () => '<p>震源</p>',
    })

    click()
    expect(openedPopup()?.isOpen()).toBe(true)

    // 別の場所を押す。そこの判定は最後まで返ってこない。
    answer = 'pending'
    click()
    flushFrames(10)

    expect(openedPopup()?.isOpen()).toBe(false)
  })

  // ── 諦めたときに痕跡を残す ────────────────────────────────────────────────
  // 画面には「寄ったのに吹き出しだけ出ない」としか現れないので、記録が無いと聞き直しの予算や
  // 距離の値が実運用で妥当かを確かめられない。**記録そのものを固定しないと、次の整理で無言に
  // 戻っても誰も気づけない。**

  it('[正] 開ける点が無いまま聞き直しが尽きたら記録する', () => {
    const { map } = makeMap()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8,
      pick: () => null, buildClickHtml: () => '',
    })

    openPopupAt(map, [139, 35])
    flushFrames(20)

    expect(JSON.stringify(debug.mock.calls)).toContain('開ける点が無い')
  })

  // **確定した空振りと、判定が返ってこないのは別の話。** 疑う先が違うので書き分ける。
  // あわせて、一覧から開く経路でも**開いていた吹き出しが閉じる**ことを固定する
  // （地図のクリック側とは別の分岐を通るため、片方だけ守っても退行に気づけない）。
  it('[正] 判定が未解決のまま尽きたら、記録を残して開いていた吹き出しも閉じる', () => {
    const { map } = makeMap()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    let answer: 'hit' | 'pending' = 'hit'
    registerPopupSource(map, {
      layerId: 'hypocenter', priority: 'point', tolPx: 8,
      pick: () => (answer === 'hit' ? FEATURE : 'pending'),
      buildClickHtml: () => '<p>震源</p>',
    })

    openPopupAt(map, [139, 35])
    expect(openedPopup()?.isOpen()).toBe(true)

    answer = 'pending'
    openPopupAt(map, [139, 35])
    flushFrames(20)

    expect(JSON.stringify(debug.mock.calls)).toContain('判定が未解決のまま')
    expect(openedPopup()?.isOpen()).toBe(false)
  })

  // **対照: 地図のクリックの空振りは正常。** 数えると、何も無い場所を押すたびに記録が出る。
  it('[対照] 地図のクリックの空振りは記録しない', () => {
    const { map, click } = makeMap()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8,
      pick: () => null, buildClickHtml: () => '',
    })

    click()
    flushFrames(20)

    expect(debug).not.toHaveBeenCalled()
  })

  it('[正] 登録が無い地図を触ったら警告する', () => {
    const { map } = makeMap()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    openPopupAt(map, [139, 35])
    closeMapPopup(map)

    expect(warn).toHaveBeenCalledTimes(2)
  })

  // 候補はあったが遠くて採らなかった場合は、距離まで残す（閾値を疑うための材料）。
  it('[正] 遠すぎて採らなかった候補は、件数と距離を残す', () => {
    const { map } = makeMap()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const far = {
      type: 'Feature', geometry: { type: 'Point', coordinates: [139.5, 35] },
      properties: {},
    } as unknown as MapGeoJSONFeature
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8,
      pick: () => far, buildClickHtml: () => '',
    })

    openPopupAt(map, [139, 35])
    flushFrames(20)

    const text = JSON.stringify(debug.mock.calls)
    expect(text).toContain('候補 1 件')
    expect(text).toContain('最短 50px')
  })

  // 範囲へ寄せるときに使う（開く相手がいないので閉じるだけ）。
  it('closeMapPopup は開いている吹き出しを閉じる', () => {
    const { map } = makeMap()
    registerPopupSource(map, {
      layerId: 'quake-points', priority: 'point', tolPx: 8,
      pick: () => FEATURE, buildClickHtml: () => '<p>x</p>',
    })
    openPopupAt(map, [139, 35])
    expect(openedPopup()?.isOpen()).toBe(true)

    closeMapPopup(map)

    expect(openedPopup()?.isOpen()).toBe(false)
  })
})
