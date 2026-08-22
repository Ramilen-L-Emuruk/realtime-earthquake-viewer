import { describe, it, expect, vi } from 'vitest'
import type * as maplibregl from 'maplibre-gl'
import {
  bindDynamicZoomRange,
  clampMinZoom,
  metersPerPixel,
  paneShortSidePx,
  REFERENCE_SHORT_SIDE_PX,
  spanKmForZoom,
  zoomForSpanKm,
} from './viewSpan'

type FakeHandler = () => void

/**
 * `bindDynamicZoomRange` が使う API だけを持つフェイク。ペイン寸法は書き換えられるようにする
 * （リサイズで閾値が張り替わることを確かめるため）。
 */
function createFakeMap(size: { width: number; height: number }, existingLayers: string[]) {
  const handlers = new Set<FakeHandler>()
  const layers = new Set(existingLayers)
  const fake = {
    size,
    layers,
    setLayerZoomRange: vi.fn(),
    getLayer: (id: string) => (layers.has(id) ? ({ id } as unknown) : undefined),
    getContainer: () => ({ clientWidth: fake.size.width, clientHeight: fake.size.height }),
    on(event: string, handler: FakeHandler) {
      if (event === 'resize') handlers.add(handler)
    },
    off(event: string, handler: FakeHandler) {
      if (event === 'resize') handlers.delete(handler)
    },
    fireResize() {
      for (const h of handlers) h()
    },
    resizeHandlerCount: () => handlers.size,
  }
  return fake
}

const asMap = (fake: ReturnType<typeof createFakeMap>) => fake as unknown as maplibregl.Map

describe('視野の実距離とズームの換算', () => {
  it('ズーム 7 の 1px は基準緯度で約 482m（512px タイル基準）', () => {
    // 256px タイル基準（Leaflet）と取り違えると 2 倍の 964m になる。移行時に実際に起きた事故なので
    // 具体値で固定する。
    expect(metersPerPixel(7)).toBeCloseTo(481.9, 1)
  })

  it('ズームが 1 段深まると 1px の実距離は半分になる', () => {
    expect(metersPerPixel(6) / metersPerPixel(7)).toBeCloseTo(2, 6)
  })

  it('視野幅からズームへの換算と、その逆が一致する', () => {
    const zoom = zoomForSpanKm(400, 800)
    expect(spanKmForZoom(zoom, 800)).toBeCloseTo(400, 6)
  })

  it('同じズームでもペインが広いほど視野が広い（ズーム値が端末非依存でない根拠）', () => {
    expect(spanKmForZoom(7, 375)).toBeCloseTo(180.7, 1)
    expect(spanKmForZoom(7, 1200)).toBeCloseTo(578.24, 2)
  })

  it('同じ視野幅を得るには、広いペインのほうが深いズームになる', () => {
    expect(zoomForSpanKm(400, 1200)).toBeGreaterThan(zoomForSpanKm(400, 375))
  })
})

describe('帯が潰れないための下限のクランプ', () => {
  it('上限より手前へ収める', () => {
    expect(clampMinZoom(6.9, 6.5)).toBeLessThan(6.5)
  })

  it('上限に余裕があるときは何もしない', () => {
    expect(clampMinZoom(3.5, 6.5)).toBe(3.5)
  })

  it('上限を省略すると実質無制限（レイヤーの最大ズーム基準）', () => {
    expect(clampMinZoom(3.5)).toBe(3.5)
  })
})

describe('地図ペインの短辺', () => {
  it('縦横の小さい方を返す', () => {
    expect(paneShortSidePx(asMap(createFakeMap({ width: 900, height: 800 }, [])))).toBe(800)
    expect(paneShortSidePx(asMap(createFakeMap({ width: 640, height: 360 }, [])))).toBe(360)
  })

  it('レイアウト前（実寸が 0）は基準値を返す', () => {
    // 0 をそのまま換算すると -Infinity になり、「どのズームでも閾値を下回る」＝細線とラベルが
    // 全部消える側へ倒れる。
    expect(paneShortSidePx(asMap(createFakeMap({ width: 0, height: 0 }, [])))).toBe(REFERENCE_SHORT_SIDE_PX)
  })
})

describe('視野基準の下限ズームのレイヤーへの反映', () => {
  it('購読した時点で既存レイヤーへ適用する', () => {
    const fake = createFakeMap({ width: 900, height: 800 }, ['a'])
    bindDynamicZoomRange(asMap(fake), [{ layerId: 'a', minZoom: () => 3.5 }])
    expect(fake.setLayerZoomRange).toHaveBeenCalledWith('a', 3.5, 24)
  })

  it('上限を指定すればそれを渡す（密度で決まる閾値はズーム値のまま置くため）', () => {
    const fake = createFakeMap({ width: 900, height: 800 }, ['a'])
    bindDynamicZoomRange(asMap(fake), [{ layerId: 'a', minZoom: () => 3.5, maxZoom: 6.5 }])
    expect(fake.setLayerZoomRange).toHaveBeenCalledWith('a', 3.5, 6.5)
  })

  it('まだ無いレイヤーは飛ばす（生成データの到着前に購読しても壊れない）', () => {
    // setLayerZoomRange は未知のレイヤーで error イベントを発火し、それが log.error に流れる。
    // レイヤーは生成データの到着後に追加されるため、購読の時点で存在しないのが通常の経路であり、
    // ガードが無いと正常な起動のたびにエラーログが出る。
    const fake = createFakeMap({ width: 900, height: 800 }, [])
    expect(() => bindDynamicZoomRange(asMap(fake), [{ layerId: 'a', minZoom: () => 3.5 }])).not.toThrow()
    expect(fake.setLayerZoomRange).not.toHaveBeenCalled()
  })

  it('ペインの寸法が変わると閾値を張り替える', () => {
    const fake = createFakeMap({ width: 900, height: 800 }, ['a'])
    bindDynamicZoomRange(asMap(fake), [{ layerId: 'a', minZoom: (m) => zoomForSpanKm(4400, paneShortSidePx(m)) }])
    const lastMinZoom = () => {
      const calls = fake.setLayerZoomRange.mock.calls
      return calls[calls.length - 1][1] as number
    }
    const wide = lastMinZoom()
    fake.size = { width: 375, height: 420 }
    fake.fireResize()
    // 狭くなったペインでは同じ視野幅がより浅いズームに相当する（＝下限が下がる）。
    expect(lastMinZoom()).toBeLessThan(wide)
  })

  it('上限を指定した帯では、下限が上限を追い越さない', () => {
    // 上限固定・下限可変の帯（地方名ラベル）で、大きなペインだと下限が上限を超える。MapLibre は
    // それをそのまま受け取り、どのズームでも描かれないレイヤーになる。張り替え側でも止める。
    const fake = createFakeMap({ width: 6000, height: 4320 }, ['a'])
    bindDynamicZoomRange(asMap(fake), [{ layerId: 'a', minZoom: () => 6.9, maxZoom: 6.5 }])
    const [, minZoom, maxZoom] = fake.setLayerZoomRange.mock.calls[0]
    expect(minZoom).toBeLessThan(maxZoom as number)
  })

  it('購読を解除すると張り替えを止める', () => {
    const fake = createFakeMap({ width: 900, height: 800 }, ['a'])
    const unbind = bindDynamicZoomRange(asMap(fake), [{ layerId: 'a', minZoom: () => 3.5 }])
    unbind()
    expect(fake.resizeHandlerCount()).toBe(0)
    const callsBefore = fake.setLayerZoomRange.mock.calls.length
    fake.fireResize()
    expect(fake.setLayerZoomRange.mock.calls.length).toBe(callsBefore)
  })
})
