// @vitest-environment jsdom
//
// maplibregl.Popup が DOM を触るため（他の *GL.test.ts と同じ扱い）。
// ポップアップの優先度調停を固定する。
//
// **とくに「上位が未解決の間は下位を採らない」こと。** カスタムレイヤーの判定（カラーピッキング）は
// 描画ループの中でしか解けず 1 フレーム遅れるが、地図には「どこを押しても区域名は出す」最後の受け皿
// （BaseMapGL の basemap 優先度）がある。未解決を素通りさせると、震源を押したのに区域名が開く。
// 実装の背景は docs/spec/map-rendering-spec.md §16「深さを持つ点」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl'
import { registerPopupSource, type PopupSource } from './popupRegistry'

// **吹き出しそのものは検証しない。** 見たいのは「どのソースが選ばれたか」で、それは
// buildClickHtml が呼ばれたかで判る。Popup は DOM と本物の map を要求するので置き換える。
vi.mock('maplibre-gl', () => {
  class FakePopup {
    setLngLat() { return this }
    setHTML() { return this }
    addTo() { return this }
    remove() { return this }
    isOpen() { return false }
    on() { return this }
  }
  return { Popup: FakePopup }
})

// 未解決のときの聞き直しに requestAnimationFrame を使う。node 環境には無いので用意する。
// **即時に実行してはいけない**——onClick が自分を呼び直すので、同期実行だと無限に潜る。
const rafQueue: (() => void)[] = []
beforeEach(() => {
  rafQueue.length = 0
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { rafQueue.push(fn); return rafQueue.length })
})
afterEach(() => { vi.unstubAllGlobals() })

/** popupRegistry が触る 6 つの API だけ持つフェイク。クリック/ホバーは fire で流す。 */
function fakeMap(existingLayers: string[]) {
  const handlers = new Map<string, Set<(e: unknown) => void>>()
  const canvas = { style: { cursor: '' } }
  const map = {
    on(ev: string, fn: (e: unknown) => void) {
      if (!handlers.has(ev)) handlers.set(ev, new Set())
      handlers.get(ev)!.add(fn)
    },
    off(ev: string, fn: (e: unknown) => void) {
      handlers.get(ev)?.delete(fn)
    },
    getLayer: (id: string) => (existingLayers.includes(id) ? { id } : undefined),
    getCanvas: () => canvas,
    isMoving: () => false,
    queryRenderedFeatures: () => [],
  }
  const fire = (ev: string, e: unknown) => {
    for (const fn of handlers.get(ev) ?? []) fn(e)
  }
  return { map: map as unknown as MapLibreMap, fire, canvas }
}

const feature = (name: string) =>
  ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [139, 35] },
    properties: { name },
  }) as unknown as MapGeoJSONFeature

/** 指定の優先度で、常に決まった結果を返すソース。 */
function source(
  layerId: string,
  priority: PopupSource['priority'],
  result: MapGeoJSONFeature | null | 'pending',
): PopupSource & { html: ReturnType<typeof vi.fn> } {
  const html = vi.fn(() => `<p>${layerId}</p>`)
  return {
    layerId,
    priority,
    tolPx: 0,
    pick: () => result,
    buildClickHtml: html,
    html,
  }
}

const clickAt = (fire: (ev: string, e: unknown) => void) =>
  fire('click', { point: { x: 10, y: 10 }, lngLat: { lng: 139, lat: 35 } })

describe('findTop の優先度調停', () => {
  it('上位が未解決なら、下位が同期で当たっても採らない（正）', () => {
    // 震源（point・未解決）と区域名の受け皿（basemap・即答）が同居する状況。
    const { map, fire } = fakeMap(['hypo', 'subregion'])
    const top = source('hypo', 'point', 'pending')
    const bottom = source('subregion', 'basemap', feature('石川県能登'))
    registerPopupSource(map, top)
    registerPopupSource(map, bottom)
    clickAt(fire)
    // どちらの吹き出しも開かない（上位の解決を待つ）。
    expect(bottom.html).not.toHaveBeenCalled()
    expect(top.html).not.toHaveBeenCalled()
  })

  it('上位が解決していれば、その場で上位を採る（対照）', () => {
    const { map, fire } = fakeMap(['hypo', 'subregion'])
    const top = source('hypo', 'point', feature('震源'))
    const bottom = source('subregion', 'basemap', feature('石川県能登'))
    registerPopupSource(map, top)
    registerPopupSource(map, bottom)
    clickAt(fire)
    expect(top.html).toHaveBeenCalled()
    expect(bottom.html).not.toHaveBeenCalled()
  })

  it('上位が「何も無い」なら下位へ降りる（安全弁）', () => {
    // 未解決と「何も無い」を取り違えると、この経路が塞がって区域名が永久に出なくなる。
    const { map, fire } = fakeMap(['hypo', 'subregion'])
    const top = source('hypo', 'point', null)
    const bottom = source('subregion', 'basemap', feature('石川県能登'))
    registerPopupSource(map, top)
    registerPopupSource(map, bottom)
    clickAt(fire)
    expect(bottom.html).toHaveBeenCalled()
  })

  it('同じ優先度なら、未解決があっても同期で当たった方を採る', () => {
    // 打ち切るのは「下位へ降りること」だけ。同一優先度は回し切ってから判定する。
    const { map, fire } = fakeMap(['a', 'b'])
    const pending = source('a', 'point', 'pending')
    const hit = source('b', 'point', feature('観測点'))
    registerPopupSource(map, pending)
    registerPopupSource(map, hit)
    clickAt(fire)
    expect(hit.html).toHaveBeenCalled()
  })

  it('存在しないレイヤーのソースは飛ばす', () => {
    const { map, fire } = fakeMap(['subregion']) // hypo は地図に無い
    const gone = source('hypo', 'point', feature('震源'))
    const bottom = source('subregion', 'basemap', feature('石川県能登'))
    registerPopupSource(map, gone)
    registerPopupSource(map, bottom)
    clickAt(fire)
    expect(gone.html).not.toHaveBeenCalled()
    expect(bottom.html).toHaveBeenCalled()
  })
})

describe('クリックとホバーの区別', () => {
  it('クリック由来の判定には forClick が立つ', () => {
    const { map, fire } = fakeMap(['hypo'])
    const pick = vi.fn(() => null)
    registerPopupSource(map, { layerId: 'hypo', priority: 'point', tolPx: 0, pick, buildClickHtml: () => '' })
    clickAt(fire)
    expect(pick).toHaveBeenCalledWith(expect.anything(), true)
  })

  it('ホバー由来の判定では forClick が立たない', () => {
    // 予約の枠は 1 つしかないので、ここを取り違えるとホバーがクリックの予約を奪う。
    const { map, fire } = fakeMap(['hypo'])
    const pick = vi.fn(() => null)
    registerPopupSource(map, { layerId: 'hypo', priority: 'point', tolPx: 0, pick, buildClickHtml: () => '' })
    fire('mousemove', { point: { x: 10, y: 10 }, lngLat: { lng: 139, lat: 35 } })
    expect(pick).toHaveBeenCalledWith(expect.anything(), false)
  })
})
