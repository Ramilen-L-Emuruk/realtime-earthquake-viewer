import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import type * as maplibregl from 'maplibre-gl'
import {
  subscribeUserInteraction,
  isProgrammaticFlight,
  fitJapan,
  fitToPositions,
  snapZoomDown,
  fitMaxZoomForPane,
  refitDeltaForBounds,
  mapContainsBounds,
  clampPaddingToPane,
  boundsFromPositions,
  EEW_ZOOM_SNAP,
  INTERACTION_HOLD_SEC,
} from './camera'
import { log } from '../../../utils/logger'

// 記録の内容を検証したいので `log` だけ差し替える（`createLogThrottle` は本物を使う。
// 間引きの挙動ごと差し替えると、記録が出る条件そのものがテストの外に出てしまう）。
// 本物のままだとテスト実行時に警告が素通しで混ざり、他の障害ログと見分けにくくなる。
vi.mock('../../../utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/logger')>()
  return { ...actual, log: { ...actual.log, warn: vi.fn() } }
})

type FakeHandler = (e?: unknown) => void

// maplibregl.Map を模したフェイク。on/off/once の登録・fire による発火のみを再現する
// （subscribeUserInteraction / isProgrammaticFlight が実際に使うイベント API はこれで足りる）。
// fire は eventData を受ける: MapLibre は fly/fit へ渡した eventData をイベントへマージするため、
// 「アプリ起点のカメラ操作か」の判別がこれに依存している。
function createFakeMap(pane: { width: number; height: number } = { width: 800, height: 600 }) {
  const handlers = new Map<string, Set<FakeHandler>>()
  const onceHandlers = new Map<string, Set<FakeHandler>>()
  const fake = {
    on(event: string, handler: FakeHandler) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler)
    },
    off(event: string, handler: FakeHandler) {
      handlers.get(event)?.delete(handler)
    },
    once(event: string, handler: FakeHandler) {
      if (!onceHandlers.has(event)) onceHandlers.set(event, new Set())
      onceHandlers.get(event)!.add(handler)
    },
    fire(event: string, eventData?: unknown) {
      for (const h of handlers.get(event) ?? []) h(eventData)
      const once = onceHandlers.get(event)
      if (once) {
        for (const h of once) h(eventData)
        once.clear()
      }
    },
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
    // 段階へ切り下げて寄る経路（`flyToBoundsSnapped` / `fitToPositions`）が使う。切り下げの検証が
    // 目的なので、段階に乗っていないズームを返す（6.7 → 6.5 へ落ちることを見る）。
    cameraForBounds: vi.fn(() => ({ center: [138, 38] as [number, number], zoom: 6.7 })),
    // 余白をペインに収める計算と、算出不可でフォールバックしたときの記録がペインの実寸を使う。
    getContainer: () => ({ clientWidth: pane.width, clientHeight: pane.height }),
    // MapLibre が計算に使う寸法（キャンバスの寸法と一致する）。既定では DOM と同じで、ずらすテストは
    // 個別に上書きする。毎回 `pane` を読むのは、テストが `pane` を書き換えたときに追従させるため。
    getCanvas: () => ({ clientWidth: pane.width, clientHeight: pane.height }),
    // フィット系は現在の回転を保つため bearing を読む（渡さないと MapLibre が 0 を当てて回転が消える）。
    getBearing: () => 0,
  }
  return fake as unknown as maplibregl.Map & {
    fire: (event: string, eventData?: unknown) => void
    fitBounds: Mock
    flyTo: Mock
    cameraForBounds: Mock
  }
}

/**
 * 実装が `fitBounds` へ渡した eventData（アプリ起点の印）を取り出す。印の形をテストに固定しないため。
 * `flyTo` を使う経路（`fitToPositions` / `flyToPoint` / `flyToBoundsSnapped`）はこちらでは取れない。
 */
function fitBoundsEventDataOf(map: maplibregl.Map & { fitBounds: Mock }, callIndex = 0): unknown {
  return map.fitBounds.mock.calls[callIndex][2]
}

/** 同じく `flyTo` へ渡した eventData を取り出す。 */
function flyToEventDataOf(map: maplibregl.Map & { flyTo: Mock }, callIndex = 0): unknown {
  return map.flyTo.mock.calls[callIndex][1]
}

describe('subscribeUserInteraction', () => {
  beforeEach(() => {
    // subscribeUserInteraction は window.setTimeout/clearTimeout を使う。既定の node テスト環境には
    // window が無いため、globalThis を window として一時的にスタブする（jsdom 環境切り替えより軽量）。
    vi.stubGlobal('window', globalThis)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('初期状態は isInteracting: false', () => {
    const map = createFakeMap()
    const sub = subscribeUserInteraction(map, () => {})
    expect(sub.isInteracting).toBe(false)
    sub.unsubscribe()
  })

  it('zoomstart/dragstart を検知するとリスナーへ true を通知する', () => {
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, (v) => events.push(v))
    map.fire('dragstart')
    expect(events).toEqual([true])
    sub.unsubscribe()
  })

  it('一定時間の経過で自動的に false を通知する', () => {
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, (v) => events.push(v))
    map.fire('zoomstart')
    vi.advanceTimersByTime(INTERACTION_HOLD_SEC * 1000)
    expect(events).toEqual([true, false])
    sub.unsubscribe()
  })

  it('抑制は必ず解ける（設定タブ「自動復帰までの時間」からは切り離されている）', () => {
    // かつてはその設定値をそのまま使っており、「無効」を選ぶと解除タイマーを張らないため、地図を
    // 一度触ると明示的な解除が来るまで自動フィットが永久に止まっていた。購読側が秒数を渡せない形に
    // することで、設定に関わらず必ず復帰することを固定する。
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, (v) => events.push(v))
    map.fire('dragstart')
    expect(events).toEqual([true])

    vi.advanceTimersByTime(INTERACTION_HOLD_SEC * 1000)
    expect(events).toEqual([true, false])
    sub.unsubscribe()
  })

  it('アプリ起点のカメラ操作が起こすイベントはユーザー操作と誤認しない', () => {
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, (v) => events.push(v))

    fitJapan(map, 1.0) // camera.ts の fit 系関数はすべてアプリ起点の印を付ける
    expect(isProgrammaticFlight(map)).toBe(true)
    const eventData = fitBoundsEventDataOf(map)

    map.fire('zoomstart', eventData) // プログラムによる fitBounds が起こす zoomstart を模す
    expect(events).toEqual([])

    map.fire('moveend', eventData) // fitJapan 完了 → isProgrammaticFlight が終了する
    expect(isProgrammaticFlight(map)).toBe(false)
    sub.unsubscribe()
  })

  it('自動フィットが重なっても、アプリ起点のイベントをユーザー操作と誤認しない', () => {
    // 実地震では EEW の直前に候補クラスタ→揺れ検知のフィットが連続し、飛行が重なる。
    // 飛行を数え上げるカウンタで「自分の操作か」を判定していた頃は、重なった飛行の
    // once('moveend') が 1 回の moveend で一斉に発火してカウンタが 0 まで落ち、直後に自分の
    // フィットが起こす zoomstart をユーザー操作と誤認していた。結果、誰も地図を触っていないのに
    // EEW のカメラ追従が抑制の保持時間ぶん止まり、予想の区域塗りが画面外に取り残されていた。
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, (v) => events.push(v))

    fitJapan(map, 1.0)
    fitToPositions(map, [[35, 139], [36, 140]], { durationSec: 1.0 }) // 1 本目を中断して開始
    const firstFlight = fitBoundsEventDataOf(map, 0)
    const secondFlight = flyToEventDataOf(map, 0) // 点群フィットは切り下げた着地ズームへ flyTo する

    // 中断で起きる moveend は「中断された側」の印を運ぶ。2 本目はまだ飛行中。
    map.fire('moveend', firstFlight)
    expect(isProgrammaticFlight(map)).toBe(true)

    map.fire('zoomstart', secondFlight)
    expect(events).toEqual([])

    map.fire('moveend', secondFlight)
    expect(isProgrammaticFlight(map)).toBe(false)
    sub.unsubscribe()
  })

  it('自動フィット中でも、印の無いイベントはユーザー操作として扱う', () => {
    // ホイールやドラッグでの割り込み。MapLibre はホイール起点の zoomstart に originalEvent を
    // 載せないため、アプリ起点の印の有無だけが判別材料になる。
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, (v) => events.push(v))

    fitJapan(map, 1.0)
    map.fire('zoomstart') // eventData 無し = ユーザー操作
    expect(events).toEqual([true])
    sub.unsubscribe()
  })

  it('moveend が来なくても、飛行の所要時間を過ぎれば飛行中とみなさない', () => {
    // タブ非表示などでアニメーションが進まないと moveend が来ない。期限が無いと「飛行中」が
    // 張り付き、EEW の成長フォローが永久に次のフィットを待ち続ける。
    const map = createFakeMap()
    fitJapan(map, 1.0)
    expect(isProgrammaticFlight(map)).toBe(true)

    vi.advanceTimersByTime(1_000 + 2_000 + 1) // duration + FLIGHT_EXPIRY_MARGIN_MS
    expect(isProgrammaticFlight(map)).toBe(false)
  })

  it('reset() は即座に false を通知しタイマーを解除する', () => {
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, (v) => events.push(v))
    map.fire('dragstart')
    sub.reset()
    expect(events).toEqual([true, false])

    vi.advanceTimersByTime(INTERACTION_HOLD_SEC * 1000)
    expect(events).toEqual([true, false]) // reset 済みのため、元のタイマー失効による二重通知は来ない
    sub.unsubscribe()
  })

  it('同一 map を購読する複数の subscriber に同じ通知が届く（リスナー一元化）', () => {
    const map = createFakeMap()
    const eventsA: boolean[] = []
    const eventsB: boolean[] = []
    const subA = subscribeUserInteraction(map, (v) => eventsA.push(v))
    const subB = subscribeUserInteraction(map, (v) => eventsB.push(v))

    map.fire('dragstart')
    expect(eventsA).toEqual([true])
    expect(eventsB).toEqual([true])

    subA.unsubscribe()
    subB.unsubscribe()
  })

  it('unsubscribe 後は通知が届かない', () => {
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, (v) => events.push(v))
    sub.unsubscribe()
    map.fire('dragstart')
    expect(events).toEqual([])
  })
})

describe('fitToPositions', () => {
  it('2 点以上は着地ズームを段階へ切り下げる（分数ズームでぴったり寄せない）', () => {
    // ぴったり寄せると目標の縁が判定の余白のちょうど上に乗り、着地直後に成長フォローが
    // 1 段引き直す（寄りすぎた後にちょっと引く二段の動き）。切り下げれば必ず余白が残る。
    const map = createFakeMap()

    fitToPositions(map, [[35, 139], [36, 140]], { padding: 60, durationSec: 1.0 })

    expect(map.fitBounds).not.toHaveBeenCalled()
    expect(map.flyTo).toHaveBeenCalledTimes(1)
    expect(map.flyTo.mock.calls[0][0].zoom).toBe(6.5) // フェイクの cameraForBounds は 6.7 を返す
  })

  it('1 点は寄り上限へ直行する（退化した矩形を cameraForBounds へ渡さない）', () => {
    const map = createFakeMap()

    fitToPositions(map, [[35, 139]], { padding: 60, maxZoom: 7, durationSec: 1.0 })

    expect(map.cameraForBounds).not.toHaveBeenCalled()
    expect(map.flyTo).toHaveBeenCalledTimes(1)
    expect(map.flyTo.mock.calls[0][0]).toMatchObject({ zoom: 7, center: [139, 35] })
  })

  it('着地ズームが算出できないときは fitBounds へフォールバックする（切り下げを経ない）', () => {
    // 戻り値の型は undefined を許すので、その備えの経路を固定しておく。**余白が大きすぎる指定は
    // ここへ来ない** —— MapLibre 6.10.0 はその場合 undefined を返さず例外を投げるので、余白を
    // ペインに収めて手前で防いでいる（下の「地図が小さいとき」）。この経路では切り下げが効かない
    // ため、着地直後に成長フォローが引き直す二段の動きが再発する。
    const map = createFakeMap()
    map.cameraForBounds.mockReturnValueOnce(undefined)

    fitToPositions(map, [[35, 139], [36, 140]], { padding: 60, durationSec: 1.0 })

    expect(map.flyTo).not.toHaveBeenCalled()
    expect(map.fitBounds).toHaveBeenCalledTimes(1)
    expect(map.fitBounds.mock.calls[0][1]).toMatchObject({ padding: 60 })
    // 記録にはペインの実寸を添える（padding だけでは「レイアウト前で 0×0 だった」のか
    // 「パネルを広げて地図が細くなった」のかを事後に区別できない）。
    //
    // **このファイルでフォールバックを踏むテストはここだけにすること。** 間引きは壁時計で
    // 60 秒（`camera.ts` の `FALLBACK_LOG_INTERVAL_MS`）、しかもモジュールスコープなので、
    // 2 つ目を足すと後から走った側は黙って間引かれてこのアサーションが落ちる。
    expect(log.warn as Mock).toHaveBeenCalledTimes(1)
    // maxZoom を渡していないので既定＝この端末の寄り上限が入る。フェイクのペインは 800×600 なので
    // 短辺 600 での値。リテラルで書くと視野基準の換算を変えたときに意味を失うため導出する。
    expect((log.warn as Mock).mock.calls[0][1]).toMatchObject({
      padding: 60, maxZoom: fitMaxZoomForPane(600), paneWidth: 800, paneHeight: 600,
    })
  })

  it('空の座標群では何もしない', () => {
    const map = createFakeMap()

    fitToPositions(map, [], { durationSec: 1.0 })

    expect(map.flyTo).not.toHaveBeenCalled()
    expect(map.fitBounds).not.toHaveBeenCalled()
  })
})

// MapLibre 6.10.0 の `cameraForBounds` / `fitBounds` は、上下（左右）の余白の和がペインを超えると
// 例外を投げる（2026-10-04 実測。縦長でパネルを広げ地図の高さが 103px になったところへ padding 60 の
// EEW 追従が走り、地図ごと落ちた）。余白は短辺の 2 割までに切り詰めてから渡す。
describe('clampPaddingToPane', () => {
  it('正: 小さい地図では短辺の 2 割まで切り詰める', () => {
    // 実測で落ちた寸法そのもの（430×103 に padding 60）
    expect(clampPaddingToPane(60, 430, 103)).toBe(20)
  })

  it('対照: 短辺 300px 以上なら、いま使っている余白（20〜60px）は切り詰めない', () => {
    expect(clampPaddingToPane(60, 800, 600)).toBe(60)
    expect(clampPaddingToPane(60, 430, 300)).toBe(60)
    expect(clampPaddingToPane(20, 430, 103)).toBe(20)
    // 境界の 1px 手前から効き始める
    expect(clampPaddingToPane(60, 430, 299)).toBe(59)
  })

  it('安全弁: どの寸法でも、両側の余白の和は短辺の半分に届かない', () => {
    for (let side = 1; side <= 1000; side++) {
      const padding = clampPaddingToPane(1000, side, side * 2)
      expect(padding).not.toBeNull()
      expect((padding as number) * 2).toBeLessThan(side / 2 + 1e-9)
    }
  })

  it('ペインの寸法が取れないときは null（寄せない側へ倒す）', () => {
    expect(clampPaddingToPane(60, 0, 600)).toBeNull()
    expect(clampPaddingToPane(60, 800, 0)).toBeNull()
    expect(clampPaddingToPane(60, Number.NaN, 600)).toBeNull()
  })

  it('余白 0 はそのまま 0', () => {
    expect(clampPaddingToPane(0, 800, 600)).toBe(0)
  })
})

describe('地図が小さいときの寄せ方', () => {
  it('点群フィットは切り詰めた余白を cameraForBounds へ渡す', () => {
    const map = createFakeMap({ width: 430, height: 103 })

    fitToPositions(map, [[35, 139], [36, 140]], { padding: 60, durationSec: 1.0 })

    expect(map.cameraForBounds.mock.calls[0][1]).toMatchObject({ padding: 20 })
    expect(map.flyTo).toHaveBeenCalledTimes(1)
  })

  it('日本全体へのフィットも切り詰める', () => {
    const map = createFakeMap({ width: 430, height: 60 })

    fitJapan(map)

    expect(map.fitBounds.mock.calls[0][1]).toMatchObject({ padding: 12 })
  })

  it('寄り直しの段数の見積もりも、寄せるときと同じ余白で計算する', () => {
    // 食い違うと「得られると計算した段数」と実際の着地がずれ、着地後も寄せ直しが発火し続ける。
    const map = createFakeMap({ width: 430, height: 103 })
    const projecting = Object.assign(map, {
      project: () => ({ x: 0, y: 0 }),
      getCenter: () => ({ lng: 138, lat: 38 }),
      getZoom: () => 6,
    })
    const bounds = boundsFromPositions([[35, 139], [36, 140]])!

    refitDeltaForBounds(projecting, bounds, { padding: 60 })
    fitToPositions(projecting, [[35, 139], [36, 140]], { padding: 60, durationSec: 1.0 })

    const [estimate, fly] = map.cameraForBounds.mock.calls.map(c => c[1].padding)
    expect(estimate).toBe(20)
    expect(fly).toBe(estimate)
  })

  // **保留の記録（`log.warn`）の回数を確かめるテストは、経路ごとにこのファイルで 1 つだけにすること。**
  // 間引きは経路ごとに壁時計で 60 秒・モジュールスコープなので、同じ経路で 2 つ目を足すと後から
  // 走った側は黙って間引かれてアサーションが落ちる（上のフォールバックのテストと同じ事情）。
  it('ペインの寸法が取れないときは保留し、寸法が付いたら同じ寄せをやり直す', () => {
    // 呼び出し側（地震カードの寄せ等）は呼んだ時点で「寄せた」印を立てて二度と呼ばない。黙って
    // 見送ると、その寄せは永久に失われる（地図の下に自作地震計の波形を並べると、縦長でパネルを
    // 広げたとき地図の高さは実際に 0 まで削られる）。
    // このファイルは `log.warn` の呼び出しをテスト間で消していない（上のフォールバックのテストの分が残る）
    ;(log.warn as Mock).mockClear()
    const pane = { width: 430, height: 0 }
    const map = createFakeMap(pane)

    fitToPositions(map, [[35, 139], [36, 140]], { padding: 60, durationSec: 1.0 })

    expect(map.cameraForBounds).not.toHaveBeenCalled()
    expect(map.flyTo).not.toHaveBeenCalled()
    expect(log.warn as Mock).toHaveBeenCalledTimes(1)
    expect((log.warn as Mock).mock.calls[0][1]).toMatchObject({ requestedPadding: 60, paneWidth: 430, paneHeight: 0 })

    // 寸法が 0 のままの resize ではまだ寄せない
    map.fire('resize')
    expect(map.flyTo).not.toHaveBeenCalled()

    // 寸法が付いたら、その時点の寸法で余白を決め直して寄せる
    pane.height = 103
    map.fire('resize')
    expect(map.cameraForBounds).toHaveBeenCalledTimes(1)
    expect(map.cameraForBounds.mock.calls[0][1]).toMatchObject({ padding: 20 })
    expect(map.flyTo).toHaveBeenCalledTimes(1)

    // やり直しは 1 回きり（購読は外れている）
    map.fire('resize')
    expect(map.flyTo).toHaveBeenCalledTimes(1)
  })

  it('保留中に別のカメラ操作が来たら、保留していた寄せは捨てる', () => {
    // 寸法が戻ったときに古い目標へ飛ばないため
    const pane = { width: 430, height: 0 }
    const map = createFakeMap(pane)

    fitJapan(map)
    pane.height = 300
    fitToPositions(map, [[35, 139]], { maxZoom: 7, durationSec: 1.0 }) // 1 点は flyTo で直行する
    map.fire('resize')

    expect(map.fitBounds).not.toHaveBeenCalled() // fitJapan は捨てられた
    expect(map.flyTo).toHaveBeenCalledTimes(1)
  })

  it('保留中に新しい寄せもまた保留になったら、寸法が付いたとき新しいほうだけを 1 回寄せる', () => {
    const pane = { width: 430, height: 0 }
    const map = createFakeMap(pane)

    fitJapan(map) // 古いほう（fitBounds）
    fitToPositions(map, [[35, 139], [36, 140]], { padding: 60, durationSec: 1.0 }) // 新しいほう（flyTo）
    pane.height = 300
    map.fire('resize')
    map.fire('resize')

    expect(map.fitBounds).not.toHaveBeenCalled()
    expect(map.flyTo).toHaveBeenCalledTimes(1)
  })

  describe('ユーザー操作との関係', () => {
    // ユーザー操作の購読は window.setTimeout を使う（理由は上の `subscribeUserInteraction` の用意と同じ）
    beforeEach(() => {
      vi.stubGlobal('window', globalThis)
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('保留中にユーザーが地図を触っても、保留した寄せは捨てない', () => {
      // 捨てると、呼び出し側が「寄せた」印を先に立てている寄せ（地震カード等）は二度と走らない。
      // 保留している寄せは利用者が見たいものなので、地図が見えるようになった時点で寄る
      const pane = { width: 430, height: 0 }
      const map = createFakeMap(pane)
      const sub = subscribeUserInteraction(map, () => {})

      fitJapan(map)
      map.fire('dragstart') // 印の無いイベント＝ユーザー操作
      pane.height = 300
      map.fire('resize')

      expect(map.fitBounds).toHaveBeenCalledTimes(1)
      sub.unsubscribe()
    })
  })

  it('DOM と MapLibre 内部の寸法の小さいほうで余白を決める', () => {
    // 地図が広がった直後は DOM だけが先に大きくなり、MapLibre の内部の寸法は ResizeObserver で
    // 遅れて追いつく。DOM の寸法で決めると、MapLibre の側では余白が大きすぎて例外を投げる。
    const map = createFakeMap({ width: 430, height: 600 })
    ;(map as unknown as { getCanvas: () => { clientWidth: number; clientHeight: number } }).getCanvas =
      () => ({ clientWidth: 430, clientHeight: 103 })

    fitToPositions(map, [[35, 139], [36, 140]], { padding: 60, durationSec: 1.0 })

    expect(map.cameraForBounds.mock.calls[0][1]).toMatchObject({ padding: 20 })
  })
})

// 収め直しフォロー（`FitToDetectionGL`）の発火判定に使う 2 つ。着地ズームの計算と「寄り直して
// 得られる段数」が同じ式を通っていることが要点で、ずれると着地後も発火し続ける。
describe('snapZoomDown', () => {
  it('zoomStep 段階へ切り下げる', () => {
    expect(snapZoomDown(6.7, 0.5)).toBe(6.5)
    expect(snapZoomDown(6.4, 0.5)).toBe(6.0)
  })

  it('段階の境目にある値を 1 段下へ落とさない（浮動小数の 6.9999… 対策）', () => {
    // Arrange: 7.0 を 0.5 で割ると浮動小数の丸めで 13.999… になりうる。
    // Act & Assert: 6.5 ではなく 7.0 のままであること。
    expect(snapZoomDown(7.0, 0.5)).toBe(7.0)
    expect(snapZoomDown(6.5, 0.5)).toBe(6.5)
  })

  it('既定の zoomStep は EEW_ZOOM_SNAP', () => {
    expect(snapZoomDown(6.7)).toBe(snapZoomDown(6.7, EEW_ZOOM_SNAP))
  })
})

describe('refitDeltaForBounds', () => {
  /**
   * cameraForBounds が指定のズームと中心を返すフェイク。project は「経度1度＝100px・
   * 緯度1度＝100px」の単純な線形投影で代用する（中心のずれを px で測れれば足りる）。
   * ペインは 400×200 とし、短辺 200px に対する比で判定できるようにする。
   */
  function mapWith(fit: { zoom: number; center: [number, number] } | null, cur: number, center: [number, number] = [138, 38]): maplibregl.Map {
    return {
      cameraForBounds: () => (fit === null ? undefined : fit),
      getZoom: () => cur,
      getCenter: () => ({ lng: center[0], lat: center[1] }),
      project: (ll: [number, number] | { lng: number; lat: number }) => {
        const lng = Array.isArray(ll) ? ll[0] : ll.lng
        const lat = Array.isArray(ll) ? ll[1] : ll.lat
        return { x: lng * 100, y: -lat * 100 }
      },
      getContainer: () => ({ clientWidth: 400, clientHeight: 200 }),
      getCanvas: () => ({ clientWidth: 400, clientHeight: 200 }),
      getBearing: () => 0,
    } as unknown as maplibregl.Map
  }
  const bounds = {} as maplibregl.LngLatBounds

  it('着地ズーム（切り下げ後）と現在ズームの差を返す', () => {
    // Arrange: 日本全体（z4）から、狭い点群へは z6.7 まで寄れる状況。
    // Act & Assert: 着地は 6.5 なので利得は 2.5 段。
    expect(refitDeltaForBounds(mapWith({ zoom: 6.7, center: [138, 38] }, 4), bounds)?.zoomGain).toBe(2.5)
  })

  it('すでに着地ズーム・同じ中心にいれば両方 0 を返す（寄り直し後に再発火しない根拠）', () => {
    expect(refitDeltaForBounds(mapWith({ zoom: 6.5, center: [138, 38] }, 6.5), bounds)).toEqual({
      zoomGain: 0,
      centerShiftRatio: 0,
    })
  })

  it('目標より寄っている（画からはみ出している）ときはズームの利得が負になる', () => {
    expect(refitDeltaForBounds(mapWith({ zoom: 4.0, center: [138, 38] }, 6.0), bounds)?.zoomGain).toBe(-2)
  })

  it('ズームが同じでも中心が動くならその移動量をペイン短辺との比で返す', () => {
    // Arrange: 寄り上限に張り付いた状態（利得 0）で、目標中心だけが東へ 0.5 度（=50px）動く。
    // Act & Assert: 短辺 200px に対する比なので 0.25。ズームの利得だけでは 0 で見逃す状況。
    const delta = refitDeltaForBounds(mapWith({ zoom: 7, center: [138.5, 38] }, 7), bounds)
    expect(delta?.zoomGain).toBe(0)
    expect(delta?.centerShiftRatio).toBeCloseTo(0.25)
  })

  it('cameraForBounds が算出できなければ null を返す', () => {
    expect(refitDeltaForBounds(mapWith(null, 4), bounds)).toBeNull()
  })

  it('ペインの実寸が取れないときは null を返す（寸法が無いだけの瞬間に寄り直させない）', () => {
    // Arrange: レイアウト前・非表示のコンテナ。ズームの利得も cameraForBounds が寸法から
    // 逆算した値なので、片方だけ信じずに判定を丸ごと見送る。
    const map = mapWith({ zoom: 7, center: [140, 38] }, 7)
    ;(map as unknown as { getContainer: () => { clientWidth: number; clientHeight: number } }).getContainer =
      () => ({ clientWidth: 0, clientHeight: 0 })
    expect(refitDeltaForBounds(map, bounds)).toBeNull()
  })

  it('ズームが数値でない（NaN）ときは null を返す', () => {
    expect(refitDeltaForBounds(mapWith({ zoom: NaN, center: [138, 38] }, 7), bounds)).toBeNull()
  })

  it('中心の座標が壊れている（投影が NaN）ときは null を返す', () => {
    // Arrange: 上流の座標に欠測値が混ざると、ここまで NaN が伝わる。
    // Act & Assert: NaN は比較が常に false になるため、そのまま返すと閾値判定が
    // 「寄り直す価値あり」側へ倒れて無意味な飛行を繰り返す。手前で止める。
    expect(refitDeltaForBounds(mapWith({ zoom: 7, center: [NaN, NaN] }, 7), bounds)).toBeNull()
  })
})

// 成長フォローの「収まっているか」判定。余白を渡すと、画面の縁から余白の内側に入っていることを
// 要求する（検知点はバッジで描くため、縁の上にあると丸が半分切れる）。

// MapLibre は `fitBounds` / `cameraForBounds` に bearing を渡されない限り**0 として計算する**
// （`camera.ts` の `options?.bearing || 0`）。`flyTo` / `easeTo` が未指定時に現在値を保つのとは
// 非対称で、渡し忘れるとユーザーの回した向きが自動フィットのたびに北上へ戻る。
describe('回転の保持', () => {
  function mapWithBearing(bearing: number) {
    const map = createFakeMap()
    ;(map as unknown as { getBearing: () => number }).getBearing = () => bearing
    return map
  }

  it('fitJapan は現在の回転を fitBounds へ渡す', () => {
    const map = mapWithBearing(45)
    fitJapan(map, 1.0)
    expect(map.fitBounds.mock.calls[0][1]).toMatchObject({ bearing: 45 })
  })

  it('点群フィットは現在の回転を cameraForBounds へ渡す', () => {
    const map = mapWithBearing(45)
    fitToPositions(map, [[35, 139], [36, 140]], { padding: 48 })
    expect(map.cameraForBounds.mock.calls[0][1]).toMatchObject({ bearing: 45 })
  })

  it('回転していなければ 0 が渡る（対照）', () => {
    const map = mapWithBearing(0)
    fitJapan(map, 1.0)
    expect(map.fitBounds.mock.calls[0][1]).toMatchObject({ bearing: 0 })
  })
})

describe('mapContainsBounds', () => {
  /**
   * 中心 (138,38)・1 度 = 100px・ペイン width×height のフェイク。
   * `bearingDeg` を渡すと画面座標を回転させる（判定は画面座標で行うため、回転の検証に要る）。
   *
   * `hidden` に挙げた地点は「球の裏側」として扱う（`unproject` が元の座標へ戻らない）。
   * MapLibre の globe では裏側の点も画面内の座標を返すため、実装はこの往復で見分けている。
   */
  function mapWithPane(
    width: number,
    height: number,
    bearingDeg = 0,
    hidden: [number, number][] = [],
  ): maplibregl.Map {
    const center = { lng: 138, lat: 38 }
    const isHidden = (lng: number, lat: number) =>
      hidden.some(([hl, ha]) => Math.abs(hl - lng) < 1e-9 && Math.abs(ha - lat) < 1e-9)
    return {
      getContainer: () => ({ clientWidth: width, clientHeight: height }),
      getCanvas: () => ({ clientWidth: width, clientHeight: height }),
      project: ([lng, lat]: [number, number]) => {
        const x0 = (lng - center.lng) * 100
        const y0 = (center.lat - lat) * 100
        const p = !bearingDeg
          ? { x: x0 + width / 2, y: y0 + height / 2 }
          : (() => {
              const r = (bearingDeg * Math.PI) / 180
              return {
                x: x0 * Math.cos(r) + y0 * Math.sin(r) + width / 2,
                y: -x0 * Math.sin(r) + y0 * Math.cos(r) + height / 2,
              }
            })()
        return { ...p, __src: [lng, lat] as [number, number] }
      },
      // 手前の点はそのまま戻る。裏側の点は「同じ画面位置にある手前の面」を返す＝大きくずれる。
      unproject: (p: { __src: [number, number] }) => {
        const [lng, lat] = p.__src
        if (isHidden(lng, lat)) return { lng: lng + 170, lat: -lat }
        return { lng, lat }
      },
    } as unknown as maplibregl.Map
  }
  /** 矩形（west, south, east, north）。 */
  const rect = (w: number, s: number, e: number, n: number) =>
    ({ getWest: () => w, getSouth: () => s, getEast: () => e, getNorth: () => n }) as unknown as maplibregl.LngLatBounds

  it('余白なしなら表示範囲に入っていれば収まっている扱い', () => {
    // Arrange: 800×600 のペイン（中心から東へ 4 度が右端）。目標の東端は右端から 30px 内側。
    // Act & Assert: 縁ぎりぎりでも「収まっている」。
    expect(mapContainsBounds(mapWithPane(800, 600), rect(137.5, 37.5, 141.7, 38.5))).toBe(true)
  })

  it('余白を渡すと、縁から余白の内側に入っていなければ収まっていない扱い', () => {
    expect(mapContainsBounds(mapWithPane(800, 600), rect(137.5, 37.5, 141.7, 38.5), 60)).toBe(false)
  })

  it('余白の内側に十分入っていれば収まっている扱い', () => {
    expect(mapContainsBounds(mapWithPane(800, 600), rect(137.5, 37.5, 138.5, 38.5), 60)).toBe(true)
  })

  it('ペインの実寸が取れないときは余白を無視する（毎秒フィットを撃たせない）', () => {
    // Arrange: レイアウト前・非表示のコンテナ。内側へ詰めると判定領域が潰れ、何を渡しても
    // 「収まっていない」になって成長フォローが毎周回発火する。
    // Act & Assert: 判定材料が揃わないので「収まっている」（＝動かさない）側へ倒す。
    expect(mapContainsBounds(mapWithPane(0, 0), rect(137.5, 37.5, 138.5, 38.5), 60)).toBe(true)
  })

  it('余白がペインに対して大きすぎる場合は短辺の 2 割まで詰める（常に「収まっていない」にしない）', () => {
    // Arrange: 短辺 100px のペインに余白 60px を渡すと、素直に内側へ詰めると範囲が反転して
    // 何を渡しても false になり、毎秒フィットが走る。上限は短辺の 2 割（20px）。
    // Act & Assert: 中心の狭い目標は収まっている扱いになる。
    expect(mapContainsBounds(mapWithPane(300, 100), rect(137.95, 37.95, 138.05, 38.05), 60)).toBe(true)
  })

  // 回転すると、地理座標の矩形どうしで比べる方式は「画面からはみ出しているのに収まっている」と
  // 誤判定する（回転した視野を軸並行の矩形で包むと必ず元より大きくなるため）。EEW の成長フォローは
  // 「収まっていれば何もしない」だけなので、甘い判定は追従の沈黙に直結する。
  describe('回転しているとき', () => {
    // 600×600px 相当の矩形。回転 45 度で対角が縦へ伸び、600px のペインからはみ出す。
    const big = () => rect(135, 35, 141, 41)

    it('回転して画面からはみ出したら「収まっていない」', () => {
      expect(mapContainsBounds(mapWithPane(800, 600, 45), big())).toBe(false)
    })

    it('回転していなければ同じ矩形が収まっている（対照）', () => {
      expect(mapContainsBounds(mapWithPane(800, 600), big())).toBe(true)
    })

    it('回転していても十分小さい矩形は収まっている（安全弁）', () => {
      // 100×100px 相当。45 度回しても対角は 141px で、余裕をもって画面内。
      expect(mapContainsBounds(mapWithPane(800, 600, 45), rect(137.5, 37.5, 138.5, 38.5))).toBe(true)
    })
  })

  // 球で描いていると、`map.project()` は地球の裏側の点にも画面内の座標を返す。画面座標だけで
  // 判定すると、見えていないものを「収まっている」と読んでしまう。
  describe('球の裏側', () => {
    const small = () => rect(137.5, 37.5, 138.5, 38.5)

    it('四隅のどれかが裏側なら「収まっていない」', () => {
      const map = mapWithPane(800, 600, 0, [[138.5, 38.5]])
      expect(mapContainsBounds(map, small())).toBe(false)
    })

    it('四隅がすべて手前なら収まっている（対照）', () => {
      expect(mapContainsBounds(mapWithPane(800, 600), small())).toBe(true)
    })

    it('裏側でも画面の外にあれば、どのみち「収まっていない」（安全弁）', () => {
      const map = mapWithPane(800, 600, 0, [[135, 35]])
      expect(mapContainsBounds(map, rect(130, 30, 146, 46))).toBe(false)
    })
  })
})
