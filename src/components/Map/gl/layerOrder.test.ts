// 描画順のスロット挿入と、**配列に無い id が来たときの扱い**を固定する。
//
// `MAP_LAYER_ORDER` への登録漏れは `addOrderedLayer` の引数の型（`id: MapLayerId`）で弾くので、
// 正しく書いているあいだこのテストの後半は起きない。それでも固定するのは、`as` で型を迂回した
// 呼び出しが**黙って最上段に積まれる**のを防いだことを残すため —— 崩れた描画順は画面から
// 読み取れず、以前は目視でしか気づけなかった。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { addOrderedLayer, firstExistingLayerId, MAP_LAYER_ORDER, type OrderedLayer } from './layerOrder'
import { log } from '../../../utils/logger'

/** `addLayer` の呼び出しを記録するだけの偽の map。既に載っているレイヤーを `existing` で与える。 */
function makeFakeMap(existing: readonly string[]) {
  const added: { id: string; beforeId: string | undefined }[] = []
  const present = new Set(existing)
  const map = {
    getLayer: (id: string) => (present.has(id) ? { id } : undefined),
    addLayer: (layer: { id: string }, beforeId?: string) => {
      added.push({ id: layer.id, beforeId })
      present.add(layer.id)
    },
  } as unknown as MapLibreMap
  return { map, added }
}

/** 型の縛りを迂回して「配列に無い id」を渡す（実際のコードではこう書けない）。 */
function unknownLayer(id: string): OrderedLayer {
  return { id, type: 'background' } as unknown as OrderedLayer
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('addOrderedLayer', () => {
  it('自分より前面にある既存レイヤーの直前へ挿入する', () => {
    // `pref-borders` は `pswave` より背面。前面側に載っている `pswave` の直前へ入る。
    const { map, added } = makeFakeMap(['land-fill', 'pswave'])
    addOrderedLayer(map, { id: 'pref-borders', type: 'background' })
    expect(added).toEqual([{ id: 'pref-borders', beforeId: 'pswave' }])
  })

  it('前面に何も載っていなければ最上段へ積む', () => {
    const { map, added } = makeFakeMap(['land-fill'])
    addOrderedLayer(map, { id: 'basemap-subregion-labels', type: 'background' })
    expect(added).toEqual([{ id: 'basemap-subregion-labels', beforeId: undefined }])
  })

  it('配列に無い id は記録を残す（黙って積まない）', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {})
    const { map, added } = makeFakeMap(['land-fill'])
    addOrderedLayer(map, unknownLayer('ghost-layer'))
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toContain('ghost-layer')
    // 積むのは従来どおり（描けないより、順序が崩れてでも出るほうがよい）。
    expect(added).toEqual([{ id: 'ghost-layer', beforeId: undefined }])
  })

  it('配列に載っている id では記録を残さない', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {})
    const { map } = makeFakeMap(['land-fill'])
    addOrderedLayer(map, { id: 'pref-borders', type: 'background' })
    expect(error).not.toHaveBeenCalled()
  })
})

describe('firstExistingLayerId', () => {
  it('与えた順に見て、最初に載っているものを返す', () => {
    const { map } = makeFakeMap(['pswave', 'quake-points'])
    expect(firstExistingLayerId(map, ['land-fill', 'quake-points', 'pswave'])).toBe('quake-points')
  })

  it('1 つも載っていなければ undefined', () => {
    const { map } = makeFakeMap([])
    expect(firstExistingLayerId(map, ['land-fill'])).toBeUndefined()
  })
})

describe('MAP_LAYER_ORDER', () => {
  it('id が重複していない', () => {
    // 重複すると `indexOf` が先に出たほうを返し、後ろのスロットが永久に使われない。
    expect(new Set(MAP_LAYER_ORDER).size).toBe(MAP_LAYER_ORDER.length)
  })
})
