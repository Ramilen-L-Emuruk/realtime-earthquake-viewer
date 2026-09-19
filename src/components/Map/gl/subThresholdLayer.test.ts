// @vitest-environment jsdom
//
// 合成用プログラムを用意できなかったときの振る舞いを固定する。
//
// **ここが守るのは「onAdd が投げない」こと。** 投げると MapLibre はレイヤーを登録したまま
// （`Style.addLayer` は `_layers[id]` へ入れてから `onAdd` を呼ぶ）`render()` を回し続け、
// 載せる側（`KyoshinSubThresholdGL.tsx`）の再追加は `if (map.getLayer(id))` で弾かれる ——
// **作り直す機会が二度と来ない**。症状は「震度0以下の点だけが出ない」で、再読み込み以外に
// 回復手段が無かった。
//
// jsdom なのは `render` が `window.devicePixelRatio` を読むため。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as maplibregl from 'maplibre-gl'
import { getRenderHealth, resetRenderHealthForTest } from '../../../utils/renderHealth'

/** 投影シェーダーのキャッシュは差し替える（実物は MapLibre が配る GLSL 断片を要求する）。 */
let projectionProgramStub: { program: unknown; u: Record<string, unknown> } | null = null

vi.mock('./projectionProgram', () => ({
  createProjectionProgramCache: () => ({
    get: () => projectionProgramStub,
    dispose: () => {},
  }),
  applyProjectionUniforms: () => {},
}))

const { makeSubThresholdLayer, SUB_THRESHOLD_LABEL, MAX_SUB_IDX } = await import('./subThresholdLayer')

interface GlOptions {
  /** `getProgramParameter`（リンク判定）の戻り値。 */
  linkOk: boolean
  /** `getShaderParameter`（コンパイル判定）の戻り値。既定は成功。 */
  compileOk?: boolean
  /** バッファ・FBO・テクスチャの生成を null で返す（文脈を失っているときの挙動）。 */
  resourcesFail?: boolean
  /** `createShader` を null で返す。 */
  shaderCreateFail?: boolean
  /** `createProgram` を null で返す。 */
  programCreateFail?: boolean
}

/** 呼び出しを数えるだけの偽 GL。**用意できない経路を 3 通りに作り分けられる。** */
function fakeGl(options: GlOptions) {
  const counts = { drawElements: 0, drawArrays: 0, useProgram: 0, deleteProgram: 0 }
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, ARRAY_BUFFER: 3, ELEMENT_ARRAY_BUFFER: 4,
    STATIC_DRAW: 5, DYNAMIC_DRAW: 6, COMPILE_STATUS: 7, LINK_STATUS: 8, FLOAT: 9,
    POINTS: 10, TRIANGLES: 11, UNSIGNED_SHORT: 12, BLEND: 13, ONE: 14,
    ONE_MINUS_SRC_ALPHA: 15, FRAMEBUFFER: 16, FRAMEBUFFER_BINDING: 17, TEXTURE_2D: 18,
    TEXTURE0: 19, COLOR_ATTACHMENT0: 20, COLOR_BUFFER_BIT: 21, RGBA: 22, UNSIGNED_BYTE: 23,
    TEXTURE_MIN_FILTER: 24, TEXTURE_MAG_FILTER: 25, TEXTURE_WRAP_S: 26, TEXTURE_WRAP_T: 27,
    LINEAR: 28, CLAMP_TO_EDGE: 29, SCISSOR_TEST: 30,
    getParameter: () => null,
    createShader: () => (options.shaderCreateFail ? null : {}),
    shaderSource: () => {},
    compileShader: () => {},
    // **頂点側だけ通して断片側で落とす、という作り分けはしない。** 見たいのは
    // 「用意できなかったときに投げないか」だけで、どちらで落ちても経路は同じ。
    getShaderParameter: () => options.compileOk ?? true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => (options.programCreateFail ? null : {}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => options.linkOk,
    getProgramInfoLog: () => 'link failed (test)',
    deleteProgram: () => { counts.deleteProgram++ },
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    getAttribLocation: () => 0,
    useProgram: () => { counts.useProgram++ },
    uniform1f: () => {}, uniform1i: () => {}, uniform4f: () => {},
    createBuffer: () => (options.resourcesFail ? null : {}),
    bindBuffer: () => {}, bufferData: () => {}, bufferSubData: () => {},
    createFramebuffer: () => (options.resourcesFail ? null : {}), bindFramebuffer: () => {}, framebufferTexture2D: () => {},
    createTexture: () => (options.resourcesFail ? null : {}), bindTexture: () => {}, texImage2D: () => {}, texParameteri: () => {},
    activeTexture: () => {},
    viewport: () => {}, clearColor: () => {}, clear: () => {},
    enable: () => {}, disable: () => {}, blendFunc: () => {},
    enableVertexAttribArray: () => {}, disableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    drawElements: () => { counts.drawElements++ },
    drawArrays: () => { counts.drawArrays++ },
    deleteFramebuffer: () => {}, deleteTexture: () => {}, deleteBuffer: () => {},
  }
  return { gl: gl as unknown as WebGL2RenderingContext, counts }
}

const MAP = { getCanvas: () => ({ width: 800, height: 600 }) } as unknown as maplibregl.Map

/** MapLibre が `render` へ渡す引数の最小形（キャッシュを差し替えてあるので中身は見られない）。 */
const ARGS = {} as unknown as maplibregl.CustomRenderMethodInput

/** 観測点 2 点。1 点を index 1 へ置いて、描く対象がある状態にする。 */
function setup(options: GlOptions | boolean) {
  const { gl, counts } = fakeGl(typeof options === 'boolean' ? { linkOk: options } : options)
  const layer = makeSubThresholdLayer(new Float32Array([0.5, 0.4, 0.51, 0.41]), 2, 1)
  const levels = new Uint8Array([1, 0])
  layer.setLevels(levels)
  return { gl, counts, layer }
}

describe('makeSubThresholdLayer', () => {
  beforeEach(() => {
    resetRenderHealthForTest()
    vi.restoreAllMocks()
    projectionProgramStub = { program: {}, u: {} }
  })

  it('プログラムを用意できれば描き、画面に不調を出さない', () => {
    // 正。
    const { gl, counts, layer } = setup(true)
    layer.layer.onAdd?.(MAP, gl)
    layer.layer.render(gl, ARGS)
    expect(counts.drawElements).toBe(1)
    expect(getRenderHealth().broken).toEqual([])
  })

  it('リンクできなくても onAdd は投げない', () => {
    // **これが要点。** 投げるとレイヤーが登録されたまま固着し、再追加が弾かれる。
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gl, layer } = setup(false)
    expect(() => layer.layer.onAdd?.(MAP, gl)).not.toThrow()
  })

  it('プログラムを用意できなければ描かず、画面に出す', () => {
    // 対照。`if (!quadProg) return` は例外を投げないので `guardRender` には掛からない。
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gl, counts, layer } = setup(false)
    layer.layer.onAdd?.(MAP, gl)
    layer.layer.render(gl, ARGS)
    expect(counts.drawElements).toBe(0)
    expect(counts.useProgram).toBe(0)
    expect(getRenderHealth().broken).toEqual([SUB_THRESHOLD_LABEL])
  })

  it('投影シェーダーを用意できないときも画面に出す', () => {
    // 対照。合成用とは別の経路（キャッシュ側）でも同じ扱いにする。
    vi.spyOn(console, 'error').mockImplementation(() => {})
    projectionProgramStub = null
    const { gl, counts, layer } = setup(true)
    layer.layer.onAdd?.(MAP, gl)
    layer.layer.render(gl, ARGS)
    expect(counts.drawElements).toBe(0)
    expect(getRenderHealth().broken).toEqual([SUB_THRESHOLD_LABEL])
  })

  it('直ったら画面から取り下げる', () => {
    // 安全弁。載せ直して作り直せたとき、印だけが居座らないこと。
    vi.spyOn(console, 'error').mockImplementation(() => {})
    projectionProgramStub = null
    const { gl, layer } = setup(true)
    layer.layer.onAdd?.(MAP, gl)
    layer.layer.render(gl, ARGS)
    expect(getRenderHealth().broken).toEqual([SUB_THRESHOLD_LABEL])
    projectionProgramStub = { program: {}, u: {} }
    layer.layer.render(gl, ARGS)
    expect(getRenderHealth().broken).toEqual([])
  })

  it('画面から外したら不調の記録も消す', () => {
    // 安全弁。隠したまま印だけ残ると、直ったのか消したのか区別できない。
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gl, layer } = setup(false)
    layer.layer.onAdd?.(MAP, gl)
    layer.layer.render(gl, ARGS)
    expect(getRenderHealth().broken).toEqual([SUB_THRESHOLD_LABEL])
    layer.layer.onRemove?.(MAP, gl)
    expect(getRenderHealth().broken).toEqual([])
  })

  it('シェーダーをコンパイルできないときも投げず、画面に出す', () => {
    // 対照。リンクの失敗とは別の経路（`compile` の早期 return）を通す。
    // **ここを覆わないと、`compile` から `return null` を落としてもテストは通り続ける。**
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gl, counts, layer } = setup({ linkOk: true, compileOk: false })
    expect(() => layer.layer.onAdd?.(MAP, gl)).not.toThrow()
    layer.layer.render(gl, ARGS)
    expect(counts.drawElements).toBe(0)
    expect(getRenderHealth().broken).toEqual([SUB_THRESHOLD_LABEL])
  })

  it('GL の資源を作れないときも投げず、描かず、画面に出す', () => {
    // 対照。**`fbo` が null のまま進むと `bindFramebuffer` が描画先を画面そのものへ
    // 切り替える**（オフスクリーンのつもりの合成が本画面へ乗る）。GL を触る前に抜けること。
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gl, counts, layer } = setup({ linkOk: true, resourcesFail: true })
    expect(() => layer.layer.onAdd?.(MAP, gl)).not.toThrow()
    layer.layer.render(gl, ARGS)
    expect(counts.drawElements).toBe(0)
    expect(counts.drawArrays).toBe(0)
    expect(counts.useProgram).toBe(0)
    expect(getRenderHealth().broken).toEqual([SUB_THRESHOLD_LABEL])
  })

  // 対照。**生成関数は失敗しても例外ではなく null を返す。**
  //
  // **ここは記録まで見る。** どちらのガードを外しても `linkProg` は結局 null を返すので
  // （null のシェーダーは次の `if (!vertex || !fragment)` で捕まる）、描画の結果だけでは
  // 分岐が生きているか分からない。**あのガードが担っているのは「何が作れなかったか」を
  // 残すこと**なので、そこを固定する。
  it.each([
    ['シェーダー', { linkOk: true, shaderCreateFail: true } as GlOptions, 'シェーダーを作成できません'],
    ['プログラム', { linkOk: true, programCreateFail: true } as GlOptions, 'プログラムを作成できません'],
  ])('%s を作成できないときも投げず、描かず、画面と記録に出す', (_name, options, message) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gl, counts, layer } = setup(options)
    expect(() => layer.layer.onAdd?.(MAP, gl)).not.toThrow()
    layer.layer.render(gl, ARGS)
    expect(counts.drawElements).toBe(0)
    expect(getRenderHealth().broken).toEqual([SUB_THRESHOLD_LABEL])
    const logged = errorSpy.mock.calls.some(args =>
      args.some(a => typeof a === 'string' && a.includes(message)),
    )
    expect(logged, `「${message}」が記録に出ていない`).toBe(true)
  })

  it('隠したら「描けていない」も取り下げる', () => {
    // 安全弁。`render()` は `!visible` で資源の判定より手前に抜けるので、
    // **壊れた状態で隠すと取り下げる機会が無い**（意図的に隠しているだけなのに残る）。
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gl, layer } = setup(false)
    layer.layer.onAdd?.(MAP, gl)
    layer.layer.render(gl, ARGS)
    expect(getRenderHealth().broken).toEqual([SUB_THRESHOLD_LABEL])
    layer.setVisible(false)
    expect(getRenderHealth().broken).toEqual([])
  })

  it('表示していなければ描かない', () => {
    const { gl, counts, layer } = setup(true)
    layer.setVisible(false)
    layer.layer.onAdd?.(MAP, gl)
    layer.layer.render(gl, ARGS)
    expect(counts.drawElements).toBe(0)
  })

  it('対象は index 1〜6（震度0以下）', () => {
    expect(MAX_SUB_IDX).toBe(6)
  })
})
