// @vitest-environment jsdom
//
// `QuakeHeatmapGL` の配線（最後に流し込んだ点の記憶・ソースを作り直したときの後始末）を固定する。
// 判定そのもの（`isSameHeatData`）は `QuakeHeatmapGL.test.ts` の担当で、ここでは
// 「親が描き直されても `setData` が増えないか」「流すべきときに流すか」を、`setData` の回数で見る。
//
// 共有の偽 map（`testing/fakeMapGL.ts`）は `getSource` が spec を返す作りで `setData` を持たないため、
// ここでは `setData` を数えられる最小の器を置く（あちらの注記どおり、直すと他のテストに響く）。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, cleanup } from '@testing-library/react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { MapGLContext } from './mapGLContext'
import { QuakeHeatmapGL } from './QuakeHeatmapGL'
import type { HeatPoint } from '../../utils/quakeHeatmap'

// ポップアップの登録は地図のイベント購読まで要求する。ここで見るのは流し込みだけなので差し替える。
vi.mock('./gl/popupRegistry', () => ({ registerPopupSource: () => ({ remove: () => {} }) }))

afterEach(() => cleanup())

interface FakeSource { setData: ReturnType<typeof vi.fn> }

function fakeMap() {
  const sources = new Map<string, FakeSource>()
  const layers = new Set<string>()
  const map = {
    addSource: (id: string) => { sources.set(id, { setData: vi.fn() }) },
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => { sources.delete(id) },
    addLayer: (layer: { id: string }) => { layers.add(layer.id) },
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    removeLayer: (id: string) => { layers.delete(id) },
    setPaintProperty: () => {},
    setLayoutProperty: () => {},
  }
  return {
    map: map as unknown as MapLibreMap,
    setData: () => sources.get('quake-heat')?.setData,
  }
}

const point = (name: string): HeatPoint =>
  ({ lat: 35, lng: 139, weight: 0.5, name, time: '2026-10-10T00:00:00+09:00', depth: 10, magnitude: 3 }) as HeatPoint

const view = (map: MapLibreMap, points: readonly HeatPoint[] | null) => (
  <MapGLContext.Provider value={map}>
    <QuakeHeatmapGL points={points} iconScale={1} visible={points !== null && points.length > 0} />
  </MapGLContext.Provider>
)

describe('QuakeHeatmapGL の流し込み', () => {
  // 正: 出す点が無いまま親が何度描き直されても、流し込みは最初の 1 回だけ。
  // 直す前は親が描き直しのたびに新しい `[]` を渡し、そのたびに `setData` していた。
  it('点が無いまま描き直されても、流し込みは最初の 1 回だけ', () => {
    const f = fakeMap()
    const r = render(view(f.map, null))
    r.rerender(view(f.map, null))
    r.rerender(view(f.map, []))
    r.rerender(view(f.map, []))
    expect(f.setData()).toHaveBeenCalledTimes(1)
  })

  // 対照: 点が届いたら流し込む。
  it('点が届いたら流し込む', () => {
    const f = fakeMap()
    const r = render(view(f.map, null))
    r.rerender(view(f.map, [point('a')]))
    const calls = f.setData()!.mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1][0].features).toHaveLength(1)
  })

  // 安全弁: 点が無くなったら、残っている点を消すために空を流し込む。
  it('点がある状態から無くなったら、空を流し込んで消す', () => {
    const f = fakeMap()
    const r = render(view(f.map, [point('a')]))
    r.rerender(view(f.map, null))
    const calls = f.setData()!.mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1][0].features).toHaveLength(0)
  })

  // 安全弁: 同じコンポーネントのまま付け外しされても（dev の StrictMode・HMR）、作り直したソースへ流し込み直す。
  // StrictMode は effect を「付ける → 外す → 付ける」と同じインスタンスで走らせる。外すときに
  // 最後に流し込んだ点の記憶を消していないと、2 度目は「同じ点」とみなして新しいソースへ一度も流さない。
  it('StrictMode で付け直されても、作り直したソースへ流し込む', () => {
    const f = fakeMap()
    render(<StrictMode>{view(f.map, [point('a')])}</StrictMode>)
    // `setData()` は今あるソース（2 度目に作られたもの）を引く。
    expect(f.setData()).toHaveBeenCalledTimes(1)
    expect(f.setData()!.mock.calls[0][0].features).toHaveLength(1)
  })

  it('地図が差し替わったら、新しい地図のソースへ流し込み直す', () => {
    const a = fakeMap()
    const b = fakeMap()
    const r = render(view(a.map, [point('a')]))
    const pts = [point('b')]
    r.rerender(view(a.map, pts))
    r.rerender(view(b.map, pts))
    expect(b.setData()).toHaveBeenCalledTimes(1)
    expect(b.setData()!.mock.calls[0][0].features).toHaveLength(1)
  })
})
