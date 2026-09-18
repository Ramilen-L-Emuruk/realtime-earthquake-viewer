import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  makeDayNightLayer,
  DAY_NIGHT_LAYER_ID,
  DAY_NIGHT_LAYER_LABEL,
} from './dayNightLayer'
import { getRenderHealth, resetRenderHealthForTest } from '../../../utils/renderHealth'

// シェーダーの中の計算は画面の色にしか現れないので、ここで確かめるのは
// **「描けないと分かったことが画面へ届くか」**だけ（濃さが理論どおりかはブラウザで測る。
// 手順は docs/spec/map-rendering-spec.md §18「実測で確かめること」）。

/** `gl` の呼び出しを数える最小の偽物。**リンクの成否だけ差し替えられる。** */
function fakeGl(options: { linkOk: boolean }) {
  const counts = { createProgram: 0, useProgram: 0, drawElements: 0, deleteProgram: 0 }
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    ARRAY_BUFFER: 3,
    ELEMENT_ARRAY_BUFFER: 4,
    STATIC_DRAW: 5,
    COMPILE_STATUS: 6,
    LINK_STATUS: 7,
    FLOAT: 8,
    TRIANGLES: 9,
    UNSIGNED_SHORT: 10,
    BLEND: 11,
    ONE: 12,
    ONE_MINUS_SRC_ALPHA: 13,
    // `gl/guardRender.ts` が描画の前に読む（例外で復元へ届かなかったときの戻り先）。
    FRAMEBUFFER_BINDING: 14,
    getParameter: () => null,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => {
      counts.createProgram++
      return { id: counts.createProgram }
    },
    attachShader: () => {},
    bindAttribLocation: () => {},
    linkProgram: () => {},
    deleteShader: () => {},
    deleteProgram: () => {
      counts.deleteProgram++
    },
    getProgramParameter: () => options.linkOk,
    getProgramInfoLog: () => 'link failed (test)',
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    useProgram: () => {
      counts.useProgram++
    },
    uniform1f: () => {},
    uniform3f: () => {},
    uniform4fv: () => {},
    uniformMatrix4fv: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    enableVertexAttribArray: () => {},
    disableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    drawElements: () => {
      counts.drawElements++
    },
    enable: () => {},
    disable: () => {},
    blendFunc: () => {},
    deleteBuffer: () => {},
  }
  return { gl: gl as unknown as WebGL2RenderingContext, counts }
}

/** MapLibre が `render` へ渡す引数の最小形。 */
function renderArgs(variantName: string) {
  return {
    shaderData: { variantName, vertexShaderPrelude: '', define: '' },
    defaultProjectionData: {
      mainMatrix: new Float32Array(16),
      tileMercatorCoords: [0, 0, 1, 1],
      clippingPlane: [0, 0, 0, 0],
      projectionTransition: 0,
      fallbackMatrix: new Float32Array(16),
    },
  } as unknown as maplibregl.CustomRenderMethodInput
}

// biome-ignore lint/style/useImportType: 型の名前空間としてだけ使う
import type * as maplibregl from 'maplibre-gl'

const SUN = () => ({ lat: 0, lon: 0 })

describe('makeDayNightLayer', () => {
  beforeEach(() => {
    resetRenderHealthForTest()
    vi.restoreAllMocks()
  })

  it('シェーダーを用意できれば描き、画面に不調を出さない', () => {
    // 正。
    const { gl, counts } = fakeGl({ linkOk: true })
    const layer = makeDayNightLayer(SUN, Date.UTC(2026, 0, 1), 0.5)
    layer.layer.onAdd?.(null as unknown as maplibregl.Map, gl)
    layer.layer.render(gl, renderArgs('mercator'))
    expect(counts.drawElements).toBe(1)
    expect(getRenderHealth().broken).toEqual([])
  })

  it('シェーダーを用意できなければ画面に出し、描かない', () => {
    // 対照。`if (!prog) return` は例外を投げないので、`guardRender` の検出には掛からない。
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gl, counts } = fakeGl({ linkOk: false })
    const layer = makeDayNightLayer(SUN, Date.UTC(2026, 0, 1), 0.5)
    layer.layer.onAdd?.(null as unknown as maplibregl.Map, gl)
    layer.layer.render(gl, renderArgs('mercator'))
    expect(counts.drawElements).toBe(0)
    expect(counts.useProgram).toBe(0)
    expect(getRenderHealth().broken).toEqual([DAY_NIGHT_LAYER_LABEL])
  })

  it('画面から外したら不調の記録も消す', () => {
    // 安全弁。隠したまま印だけ残ると、直ったのか消したのか区別できない。
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gl } = fakeGl({ linkOk: false })
    const layer = makeDayNightLayer(SUN, Date.UTC(2026, 0, 1), 0.5)
    layer.layer.onAdd?.(null as unknown as maplibregl.Map, gl)
    layer.layer.render(gl, renderArgs('mercator'))
    expect(getRenderHealth().broken).toEqual([DAY_NIGHT_LAYER_LABEL])
    layer.layer.onRemove?.(null as unknown as maplibregl.Map, gl)
    expect(getRenderHealth().broken).toEqual([])
  })

  it('載せ直すとプログラムを作り直す（WebGL の文脈が復旧したとき）', () => {
    // 安全弁。文脈が変わると前のプログラムは無効になるが、キャッシュは「作った」ことだけを
    // 覚えている。作り直さないと、無効なプログラムで描き続けて何も出ない。
    const { gl, counts } = fakeGl({ linkOk: true })
    const layer = makeDayNightLayer(SUN, Date.UTC(2026, 0, 1), 0.5)
    layer.layer.onAdd?.(null as unknown as maplibregl.Map, gl)
    layer.layer.render(gl, renderArgs('mercator'))
    expect(counts.createProgram).toBe(1)
    // 同じ投影で描き続けるあいだは作り直さない（キャッシュが効いている）。
    layer.layer.render(gl, renderArgs('mercator'))
    expect(counts.createProgram).toBe(1)
    // 載せ直したら作り直す。
    layer.layer.onAdd?.(null as unknown as maplibregl.Map, gl)
    layer.layer.render(gl, renderArgs('mercator'))
    expect(counts.createProgram).toBe(2)
  })

  it('投影ごとにプログラムを持つ', () => {
    // 球と平面で別のプログラムが要る（docs/spec/map-rendering-spec.md §6「地図の投影」）。
    const { gl, counts } = fakeGl({ linkOk: true })
    const layer = makeDayNightLayer(SUN, Date.UTC(2026, 0, 1), 0.5)
    layer.layer.onAdd?.(null as unknown as maplibregl.Map, gl)
    layer.layer.render(gl, renderArgs('globe'))
    layer.layer.render(gl, renderArgs('mercator'))
    expect(counts.createProgram).toBe(2)
  })

  it('表示していなければ描かない', () => {
    const { gl, counts } = fakeGl({ linkOk: true })
    const layer = makeDayNightLayer(SUN, Date.UTC(2026, 0, 1), 0.5)
    layer.setVisible(false)
    layer.layer.onAdd?.(null as unknown as maplibregl.Map, gl)
    layer.layer.render(gl, renderArgs('mercator'))
    expect(counts.drawElements).toBe(0)
  })

  it('有限でない時刻では太陽の位置を変えない', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = makeDayNightLayer(SUN, Date.UTC(2026, 0, 1), 0.5)
    expect(layer.setTime(Number.NaN)).toBe(false)
    expect(layer.setTime(Date.UTC(2026, 0, 2))).toBe(true)
  })

  it('レイヤー ID と表示名を公開する（React 側が同じ鍵で報告するため）', () => {
    const layer = makeDayNightLayer(SUN, Date.UTC(2026, 0, 1), 0.5)
    expect(layer.layer.id).toBe(DAY_NIGHT_LAYER_ID)
    expect(DAY_NIGHT_LAYER_LABEL).toBeTruthy()
  })
})
