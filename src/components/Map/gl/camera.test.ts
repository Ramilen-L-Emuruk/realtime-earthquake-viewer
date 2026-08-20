import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import type * as maplibregl from 'maplibre-gl'
import {
  subscribeUserInteraction,
  isProgrammaticFlight,
  fitJapan,
  fitToPositions,
  snapZoomDown,
  zoomGainForBounds,
  EEW_ZOOM_SNAP,
  INTERACTION_HOLD_SEC,
} from './camera'

type FakeHandler = (e?: unknown) => void

// maplibregl.Map を模したフェイク。on/off/once の登録・fire による発火のみを再現する
// （subscribeUserInteraction / isProgrammaticFlight が実際に使うイベント API はこれで足りる）。
// fire は eventData を受ける: MapLibre は fly/fit へ渡した eventData をイベントへマージするため、
// 「アプリ起点のカメラ操作か」の判別がこれに依存している。
function createFakeMap() {
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
  }
  return fake as unknown as maplibregl.Map & {
    fire: (event: string, eventData?: unknown) => void
    fitBounds: Mock
    flyTo: Mock
  }
}

/**
 * 実装が `fitBounds` へ渡した eventData（アプリ起点の印）を取り出す。印の形をテストに固定しないため。
 * 1 点だけを渡した `fitToPositions` や `flyToPoint` は内部で `flyTo` を使うので、こちらでは取れない。
 */
function fitBoundsEventDataOf(map: maplibregl.Map & { fitBounds: Mock }, callIndex = 0): unknown {
  return map.fitBounds.mock.calls[callIndex][2]
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
    const secondFlight = fitBoundsEventDataOf(map, 1)

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

// 縮小フォロー（`FitToDetectionGL`）の発火判定に使う 2 つ。着地ズームの計算と「寄り直して
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

describe('zoomGainForBounds', () => {
  /** cameraForBounds が指定ズームを返し、現在ズームが cur のフェイク。 */
  function mapWithZooms(fitZoom: number | null, cur: number): maplibregl.Map {
    return {
      cameraForBounds: () => (fitZoom === null ? undefined : { center: [138, 38], zoom: fitZoom }),
      getZoom: () => cur,
    } as unknown as maplibregl.Map
  }
  const bounds = {} as maplibregl.LngLatBounds

  it('着地ズーム（切り下げ後）と現在ズームの差を返す', () => {
    // Arrange: 日本全体（z4）から、狭い点群へは z6.7 まで寄れる状況。
    // Act & Assert: 着地は 6.5 なので利得は 2.5 段。
    expect(zoomGainForBounds(mapWithZooms(6.7, 4), bounds)).toBe(2.5)
  })

  it('すでに着地ズームにいれば 0 を返す（寄り直し後に再発火しない根拠）', () => {
    expect(zoomGainForBounds(mapWithZooms(6.5, 6.5), bounds)).toBe(0)
  })

  it('目標より寄っている（画からはみ出している）ときは負を返す', () => {
    expect(zoomGainForBounds(mapWithZooms(4.0, 6.0), bounds)).toBe(-2)
  })

  it('cameraForBounds が算出できなければ null を返す', () => {
    expect(zoomGainForBounds(mapWithZooms(null, 4), bounds)).toBeNull()
  })
})
