import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as maplibregl from 'maplibre-gl'
import { subscribeUserInteraction, isProgrammaticFlight, fitJapan } from './camera'

// maplibregl.Map を模したフェイク。on/off/once の登録・fire による発火のみを再現する
// （subscribeUserInteraction / isProgrammaticFlight が実際に使うイベント API はこれで足りる）。
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
      for (const h of handlers.get(event) ?? []) h()
      const once = onceHandlers.get(event)
      if (once) {
        for (const h of once) h()
        once.clear()
      }
    },
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
  }
  return fake as unknown as maplibregl.Map & { fire: (event: string) => void }
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
    const sub = subscribeUserInteraction(map, 30, () => {})
    expect(sub.isInteracting).toBe(false)
    sub.unsubscribe()
  })

  it('zoomstart/dragstart を検知するとリスナーへ true を通知する', () => {
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, 30, (v) => events.push(v))
    map.fire('dragstart')
    expect(events).toEqual([true])
    sub.unsubscribe()
  })

  it('idleRevertSec 経過後に自動的に false を通知する', () => {
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, 30, (v) => events.push(v))
    map.fire('zoomstart')
    vi.advanceTimersByTime(30_000)
    expect(events).toEqual([true, false])
    sub.unsubscribe()
  })

  it('idleRevertSec=0 のときはタイマーで自動解除しない（無期限保持）', () => {
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, 0, (v) => events.push(v))
    map.fire('dragstart')
    vi.advanceTimersByTime(600_000)
    expect(events).toEqual([true])
    sub.unsubscribe()
  })

  it('isProgrammaticFlight 中のイベントはユーザー操作と誤認しない', () => {
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, 30, (v) => events.push(v))

    fitJapan(map, 1.0) // beginProgrammaticFlight を起動する（camera.ts の fit 系関数はすべて同様）
    expect(isProgrammaticFlight(map)).toBe(true)

    map.fire('zoomstart') // プログラムによる fitBounds が起こす zoomstart を模す
    expect(events).toEqual([])

    map.fire('moveend') // fitJapan 完了 → isProgrammaticFlight が終了する
    expect(isProgrammaticFlight(map)).toBe(false)
    sub.unsubscribe()
  })

  it('reset() は即座に false を通知しタイマーを解除する', () => {
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, 30, (v) => events.push(v))
    map.fire('dragstart')
    sub.reset()
    expect(events).toEqual([true, false])

    vi.advanceTimersByTime(30_000)
    expect(events).toEqual([true, false]) // reset 済みのため、元のタイマー失効による二重通知は来ない
    sub.unsubscribe()
  })

  it('同一 map を購読する複数の subscriber に同じ通知が届く（リスナー一元化）', () => {
    const map = createFakeMap()
    const eventsA: boolean[] = []
    const eventsB: boolean[] = []
    const subA = subscribeUserInteraction(map, 30, (v) => eventsA.push(v))
    const subB = subscribeUserInteraction(map, 30, (v) => eventsB.push(v))

    map.fire('dragstart')
    expect(eventsA).toEqual([true])
    expect(eventsB).toEqual([true])

    subA.unsubscribe()
    subB.unsubscribe()
  })

  it('unsubscribe 後は通知が届かない', () => {
    const map = createFakeMap()
    const events: boolean[] = []
    const sub = subscribeUserInteraction(map, 30, (v) => events.push(v))
    sub.unsubscribe()
    map.fire('dragstart')
    expect(events).toEqual([])
  })
})
