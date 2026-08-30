// プレート境界線と活断層線が 1 つの geojson ソースを共有するための受け皿。
//
// **見たいのは寿命の管理**。提供元が 2 つあり到着も離脱もばらばらなので、
// 「先に来た方が作る」「後から来た方が壊さない」「最後の 1 つが降りるまで消さない」の 3 つが要る。
// どれが崩れても症状は「線が出ない」か「MapLibre がソース削除で例外を投げる」で、
// 実装を読まないと原因に辿り着けない類のもの。
import { describe, it, expect, vi } from 'vitest'
import type { Feature, MultiLineString } from 'geojson'
import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  OVERLAY_LINE_SRC,
  dropOverlayLines,
  overlayLineKindFilter,
  putOverlayLines,
} from './overlayLineSource'

function lineFeature(name: string): Feature<MultiLineString> {
  return {
    type: 'Feature',
    properties: { name },
    geometry: { type: 'MultiLineString', coordinates: [[[139, 35], [140, 36]]] },
  }
}

/**
 * overlayLineSource が触る 4 つの API だけ持つフェイク。
 *
 * `removeSourceFails` は「参照するレイヤーが残っていて削除できない」状態を模す。**MapLibre の
 * `removeSource` はこのとき例外を投げず、何もせずに戻る**（エラーイベントを出すだけ）。呼びっぱなし
 * では気づけない失敗なので、フェイク側でもその形を再現する。
 */
function fakeMap(opts: { removeSourceFails?: boolean } = {}) {
  let source: { setData: ReturnType<typeof vi.fn>; data: unknown } | null = null
  const addSource = vi.fn((_id: string, spec: { data: unknown }) => {
    source = { setData: vi.fn((d: unknown) => { source!.data = d }), data: spec.data }
  })
  const removeSource = vi.fn(() => { if (!opts.removeSourceFails) source = null })
  const map = {
    addSource,
    removeSource,
    getSource: (id: string) => (id === OVERLAY_LINE_SRC ? source : undefined),
  } as unknown as MapLibreMap
  return {
    map,
    addSource,
    removeSource,
    setDataCalls: () => source?.setData.mock.calls.length ?? 0,
    names: () => {
      const fc = source?.data as { features?: Feature<MultiLineString>[] } | undefined
      return (fc?.features ?? []).map((f) => String(f.properties?.name))
    },
  }
}

describe('putOverlayLines / dropOverlayLines', () => {
  it('先に来た提供元がソースを作り、後から来た方は追記する', () => {
    const f = fakeMap()
    putOverlayLines(f.map, 'plate', [lineFeature('境界')])
    expect(f.addSource).toHaveBeenCalledTimes(1)
    expect(f.names()).toEqual(['境界'])

    putOverlayLines(f.map, 'fault', [lineFeature('断層')])
    // 2 度目は作り直さず setData で合流させる（作り直すと先のレイヤーが参照を失う）。
    expect(f.addSource).toHaveBeenCalledTimes(1)
    expect(f.setDataCalls()).toBe(1)
    expect(f.names()).toEqual(['境界', '断層'])
  })

  it('同じ提供元が二度呼んでも重ならず、自分の分だけ差し替わる', () => {
    const f = fakeMap()
    putOverlayLines(f.map, 'plate', [lineFeature('旧')])
    putOverlayLines(f.map, 'plate', [lineFeature('新')])
    expect(f.names()).toEqual(['新'])
  })

  it('片方が降りてもソースは残り、残った側の feature だけになる', () => {
    const f = fakeMap()
    putOverlayLines(f.map, 'plate', [lineFeature('境界')])
    putOverlayLines(f.map, 'fault', [lineFeature('断層')])
    dropOverlayLines(f.map, 'plate')
    expect(f.removeSource).not.toHaveBeenCalled()
    expect(f.names()).toEqual(['断層'])
  })

  it('最後の提供元が降りたときだけソースを消す', () => {
    const f = fakeMap()
    putOverlayLines(f.map, 'plate', [lineFeature('境界')])
    putOverlayLines(f.map, 'fault', [lineFeature('断層')])
    dropOverlayLines(f.map, 'fault')
    expect(f.removeSource).not.toHaveBeenCalled()
    dropOverlayLines(f.map, 'plate')
    expect(f.removeSource).toHaveBeenCalledWith(OVERLAY_LINE_SRC)
  })

  it('登録していない提供元が降りても何も壊さない', () => {
    const f = fakeMap()
    dropOverlayLines(f.map, 'plate')
    expect(f.removeSource).not.toHaveBeenCalled()
    // 全て降りた後にもう一度降りても同じ（cleanup が二重に走る経路への備え）。
    putOverlayLines(f.map, 'fault', [lineFeature('断層')])
    dropOverlayLines(f.map, 'fault')
    dropOverlayLines(f.map, 'fault')
    expect(f.removeSource).toHaveBeenCalledTimes(1)
  })

  it('ソースを削除できなかったときは登録簿を畳まず、記録を残す', () => {
    // 呼び出し側がレイヤーを外さずに降りた状況。MapLibre は無言で削除を見送るので、
    // 成功したものとして登録簿を空にすると、次の提供元の setData で
    // 「外し忘れたレイヤーが無言で空になる」状態を作ってしまう。
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const f = fakeMap({ removeSourceFails: true })
      putOverlayLines(f.map, 'plate', [lineFeature('境界')])
      dropOverlayLines(f.map, 'plate')
      expect(f.removeSource).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalled()

      // 登録簿が残っているので、次の提供元は addSource ではなく setData の経路へ入る
      // （残っているソースを作り直そうとすると MapLibre が「同じ id が既にある」で落ちる）。
      putOverlayLines(f.map, 'fault', [lineFeature('断層')])
      expect(f.addSource).toHaveBeenCalledTimes(1)
      expect(f.names()).toEqual(['断層'])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('降りたあとに戻ってきたらソースを作り直す', () => {
    const f = fakeMap()
    putOverlayLines(f.map, 'plate', [lineFeature('境界')])
    dropOverlayLines(f.map, 'plate')
    putOverlayLines(f.map, 'plate', [lineFeature('境界')])
    expect(f.addSource).toHaveBeenCalledTimes(2)
    expect(f.names()).toEqual(['境界'])
  })
})

describe('overlayLineKindFilter', () => {
  it('レイヤーの filter は kind の一致だけを見る', () => {
    expect(overlayLineKindFilter('fault')).toEqual(['==', ['get', 'kind'], 'fault'])
  })
})
