// @vitest-environment jsdom
//
// 当たり判定の失敗を封じ込めることを固定する。
// **ここは全ソースを順に回す唯一の場所**なので、1 つが投げるとどのレイヤーもクリックに
// 応じなくなる（どこを押しても区域名を出す最後の受け皿まで巻き添えになる）。
// 背景は docs/spec/map-rendering-spec.md §16「描けているかを画面に出す」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MapGeoJSONFeature } from 'maplibre-gl'

/** 吹き出しは DOM を触るだけなので、置き換えて中身を見ない。 */
vi.mock('maplibre-gl', () => {
  class FakePopup {
    setLngLat() { return this }
    setHTML() { return this }
    addTo() { return this }
    remove() { return this }
    isOpen() { return false }
    on() { return this }
    off() { return this }
  }
  return { default: { Popup: FakePopup }, Popup: FakePopup }
})

import { registerPopupSource } from './popupRegistry'
import { getRenderHealth, resetRenderHealthForTest } from '../../../utils/renderHealth'

/** クリック・ホバーのハンドラを捕まえる最小の地図。 */
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
  }
  const click = () => {
    for (const fn of handlers.click ?? []) fn({ point: { x: 1, y: 1 }, lngLat: { lng: 139, lat: 35 } })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { map: map as any, click }
}

const FEATURE = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [139, 35] },
  properties: {},
} as unknown as MapGeoJSONFeature

beforeEach(() => {
  resetRenderHealthForTest()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('popupRegistry の判定の封じ込め', () => {
  // **正: 投げたソースだけ飛ばして、後続は通常どおり見る。**
  it('判定が投げても後続のソースは見に行く', () => {
    const { map, click } = makeMap()
    const later = vi.fn(() => FEATURE)
    const buildClickHtml = vi.fn(() => '<p>x</p>')
    registerPopupSource(map, {
      layerId: 'boom', priority: 'point', tolPx: 0, label: '壊れた方',
      pick: () => { throw new Error('boom') },
      buildClickHtml: () => '',
    })
    registerPopupSource(map, {
      layerId: 'ok', priority: 'line', tolPx: 0, pick: later, buildClickHtml,
    })

    expect(() => click()).not.toThrow()
    expect(later).toHaveBeenCalled()
    expect(buildClickHtml).toHaveBeenCalled()
  })

  // 正: 名前があれば画面へ出す。
  it('判定が投げたら「掴めない」として記録する', () => {
    const { map, click } = makeMap()
    registerPopupSource(map, {
      layerId: 'boom', priority: 'point', tolPx: 0, label: '震源カタログ',
      pick: () => { throw new Error('boom') },
      buildClickHtml: () => '',
    })
    click()
    expect(getRenderHealth().uninteractive).toEqual(['震源カタログ'])
  })

  // 対照: 名前を渡していないソースは記録だけで画面に出さない
  //（ID をそのまま出すと利用者に意味が伝わらない）。
  it('名前が無ければ画面には出さない', () => {
    const { map, click } = makeMap()
    registerPopupSource(map, {
      layerId: 'boom', priority: 'point', tolPx: 0,
      pick: () => { throw new Error('boom') },
      buildClickHtml: () => '',
    })
    click()
    expect(getRenderHealth().uninteractive).toEqual([])
  })

  // 正: 直ったら取り下げる。
  it('成功に転じたら取り下げる', () => {
    const { map, click } = makeMap()
    let broken = true
    registerPopupSource(map, {
      layerId: 'boom', priority: 'point', tolPx: 0, label: '震源カタログ',
      pick: () => { if (broken) throw new Error('boom'); return null },
      buildClickHtml: () => '',
    })
    click()
    expect(getRenderHealth().uninteractive).toEqual(['震源カタログ'])
    broken = false
    click()
    expect(getRenderHealth().uninteractive).toEqual([])
  })

  // **安全弁: 登録を外したら画面からも消す。**
  // 呼ばれなくなったソースは直ったかどうかも判らないので、残すと永久に居座る。
  it('登録を外したら画面から消える', () => {
    const { map, click } = makeMap()
    const handle = registerPopupSource(map, {
      layerId: 'boom', priority: 'point', tolPx: 0, label: '震源カタログ',
      pick: () => { throw new Error('boom') },
      buildClickHtml: () => '',
    })
    click()
    expect(getRenderHealth().uninteractive).toEqual(['震源カタログ'])
    handle.remove()
    expect(getRenderHealth().uninteractive).toEqual([])
  })

  // **安全弁: 貼り直したら同じ失敗をもう一度報告する。**
  // 報告済みかどうかをストアの外に覚えると、ここで黙る。
  it('貼り直したら同じ失敗をもう一度報告する', () => {
    const { map, click } = makeMap()
    const source = {
      layerId: 'boom', priority: 'point' as const, tolPx: 0, label: '震源カタログ',
      pick: () => { throw new Error('boom') },
      buildClickHtml: () => '',
    }
    registerPopupSource(map, source).remove()
    registerPopupSource(map, { ...source })
    click()
    expect(getRenderHealth().uninteractive).toEqual(['震源カタログ'])
  })

  // 安全弁: 同じ失敗を繰り返しても記録は 1 件（ホバーのたびに走る）。
  it('繰り返し失敗しても 1 件のまま', () => {
    const { map, click } = makeMap()
    registerPopupSource(map, {
      layerId: 'boom', priority: 'point', tolPx: 0, label: '震源カタログ',
      pick: () => { throw new Error('boom') },
      buildClickHtml: () => '',
    })
    for (let i = 0; i < 20; i++) click()
    expect(getRenderHealth().uninteractive).toEqual(['震源カタログ'])
  })
})
