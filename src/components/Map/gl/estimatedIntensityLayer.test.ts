import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as maplibregl from 'maplibre-gl'
import { CELL_LAT_DEG, CELL_LON_DEG } from '../../../utils/bufrEstimatedIntensity'
import { getRenderHealth, resetRenderHealthForTest } from '../../../utils/renderHealth'
import type { JMAEstimatedIntensity, JMAEstimatedIntensityGrade } from '../../../types/earthquake'

// **描けない理由が画面へ出ることを固定する。** このレイヤーが描けなくなっても、地震カードの
// 件数は JS 側だけで数えているので正しく出たままになる（`utils/renderHealth.ts` の冒頭）。
// 黙って何も描かない経路が最も危険なので、そこを塞いだことをここで押さえる。
//
// GL は呼び出しを数えるだけのモック。**投影シェーダーのキャッシュもモックする**——
// 実物は `CustomRenderMethodInput` の中身（MapLibre が配る GLSL 断片）を要求するため。

/** `programCache.get` が返すもの。テストごとに差し替える。 */
let programStub: { program: unknown; u: Record<string, unknown> } | null = null

vi.mock('./projectionProgram', () => ({
  createProjectionProgramCache: () => ({
    get: () => programStub,
    dispose: () => {},
  }),
  applyProjectionUniforms: () => {},
}))

// モックを張ってから読む（`vi.mock` は巻き上げられるが、対象モジュールの評価は import 時）。
const { makeEstimatedIntensityLayer } = await import('./estimatedIntensityLayer')

const LABEL = '推計震度分布図'

const GRADES: JMAEstimatedIntensityGrade[] = [
  { scale: 4, modifier: 'none', lower: 35, upper: 44 },
  { scale: 5, modifier: 'weak', lower: 45, upper: 49 },
]

function makeData(si: number, grades: JMAEstimatedIntensityGrade[] = GRADES): JMAEstimatedIntensity {
  return {
    id: 'test',
    time: '2026-01-01T00:10:00Z',
    arrivalTime: '2026-01-01T00:00:00Z',
    hypocenter: { lat: 35, lon: 135, depthKm: 10 },
    magnitude: 6.5,
    areaCode: 0,
    telegramKind: 0,
    grades,
    count: 1,
    lat: new Float32Array([35]),
    lon: new Float32Array([135]),
    si: new Uint8Array([si]),
    cellLatDeg: CELL_LAT_DEG, cellLonDeg: CELL_LON_DEG,
    bounds: { south: 35, north: 35 + CELL_LAT_DEG, west: 135, east: 135 + CELL_LON_DEG },
  }
}

/** `makeGl` が配る定数と同じ値（実装が渡す先を見分けるためだけのもの）。 */
const GL_MIN_FILTER = 3
const GL_MAG_FILTER = 4
const GL_NEAREST = 8

interface GlOptions {
  /** `createTexture` / `createBuffer` を null で返す（文脈を失っているときの挙動）。 */
  resourcesFail?: boolean
  /** `createBuffer` だけ null で返す（一部だけ作れた形）。 */
  buffersFail?: boolean
  /** `texImage2D` で例外を投げる。 */
  texImage2DThrows?: boolean
}

interface MockGl {
  gl: WebGL2RenderingContext
  counts: {
    drawElements: number
    texImage2D: number
    deleteTexture: number
    deleteBuffer: number
    /** 行の詰め方が合わず、WebGL なら転送を拒否されていた回数（下記 `texImage2D` を参照）。 */
    unpackRejected: number
  }
  /**
   * テクスチャごとに設定されたパラメータ（`texParameteri`）。鍵は作られた順の番号で、
   * 1 が値テクスチャ・2 が凡例テクスチャ（実装がこの順に作る）。
   */
  texParams: Map<number, Record<number, number>>
}

function makeGl(opts: GlOptions = {}): MockGl {
  const counts = { drawElements: 0, texImage2D: 0, deleteTexture: 0, deleteBuffer: 0, unpackRejected: 0 }
  /** WebGL の既定値。実装が転送の前後で出し入れする。 */
  let unpackAlignment = 4
  /** 作った順の番号でテクスチャを見分ける（`texParameteri` は「いま束ねているもの」に掛かる）。 */
  let texSeq = 0
  let boundTex: { texId: number } | null = null
  const texParams = new Map<number, Record<number, number>>()
  const noop = () => {}
  const gl = {
    // 定数（値そのものに意味は無く、実装が渡す先を区別するだけ）。
    MAX_TEXTURE_SIZE: 1,
    TEXTURE_2D: 2,
    TEXTURE_MIN_FILTER: 3,
    TEXTURE_MAG_FILTER: 4,
    TEXTURE_WRAP_S: 5,
    TEXTURE_WRAP_T: 6,
    LINEAR: 7,
    NEAREST: 8,
    CLAMP_TO_EDGE: 9,
    RG8: 10,
    RG: 11,
    RGBA8: 12,
    RGBA: 13,
    UNSIGNED_BYTE: 14,
    ARRAY_BUFFER: 15,
    ELEMENT_ARRAY_BUFFER: 16,
    STATIC_DRAW: 17,
    BLEND: 18,
    ONE: 19,
    ONE_MINUS_SRC_ALPHA: 20,
    TRIANGLES: 21,
    UNSIGNED_SHORT: 22,
    TEXTURE0: 23,
    TEXTURE1: 24,
    FLOAT: 25,
    FRAMEBUFFER: 26,
    FRAMEBUFFER_BINDING: 27,
    SCISSOR_TEST: 28,
    UNPACK_ALIGNMENT: 29,

    getParameter: (p: number) => (p === 1 ? 4096 : p === 29 ? unpackAlignment : null),
    pixelStorei: (p: number, v: number) => {
      if (p === 29) unpackAlignment = v
    },
    createTexture: () => (opts.resourcesFail ? null : { texId: ++texSeq }),
    createBuffer: () => (opts.resourcesFail || opts.buffersFail ? null : {}),
    bindTexture: (_target: number, tex: { texId: number } | null) => { boundTex = tex },
    texParameteri: (_target: number, pname: number, value: number) => {
      if (!boundTex) return
      const rec = texParams.get(boundTex.texId) ?? {}
      rec[pname] = value
      texParams.set(boundTex.texId, rec)
    },
    // **WebGL と同じ検証を入れてある。** 本物は 1 行が `UNPACK_ALIGNMENT` の倍数に
    // なっていることを要求し、渡された配列がそれに足りなければ**例外を投げずに**転送を
    // 拒否する（GL 内部のエラーになるだけ）。実測で 3x3 の RG8 は既定の境界（4）で
    // 拒否され、1 へ直すと通る。**ここで数えないと、この穴はどのテストにも現れない**——
    // 焼き込みは成功した顔で終わり、画面だけが空になる（または前の分布が残る）。
    texImage2D: (
      _target: number,
      _level: number,
      _internalFormat: number,
      w: number,
      h: number,
      _border: number,
      format: number,
      _type: number,
      view: ArrayBufferView | null,
    ) => {
      counts.texImage2D++
      const bytesPerPixel = format === 11 ? 2 : format === 13 ? 4 : 0
      if (view && bytesPerPixel > 0) {
        const rowBytes = w * bytesPerPixel
        const stride = Math.ceil(rowBytes / unpackAlignment) * unpackAlignment
        // 末尾の行には詰め物が要らない（だから高さ 1 はどの境界でも通る）。
        if (view.byteLength < (h - 1) * stride + rowBytes) counts.unpackRejected++
      }
      if (opts.texImage2DThrows) throw new Error('texImage2D failed')
    },
    bindBuffer: noop,
    bufferData: noop,
    useProgram: noop,
    activeTexture: noop,
    uniform1i: noop,
    uniform1f: noop,
    enable: noop,
    disable: noop,
    blendFunc: noop,
    enableVertexAttribArray: noop,
    disableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    drawElements: () => {
      counts.drawElements++
    },
    deleteTexture: () => {
      counts.deleteTexture++
    },
    deleteBuffer: () => {
      counts.deleteBuffer++
    },
    bindFramebuffer: noop,
  }
  return { gl: gl as unknown as WebGL2RenderingContext, counts, texParams }
}

const MAP = {} as maplibregl.Map
const ARGS = {} as maplibregl.CustomRenderMethodInput

/** 描けない報告が出ているか。 */
function isBroken(): boolean {
  return getRenderHealth().broken.includes(LABEL)
}

beforeEach(() => {
  resetRenderHealthForTest()
  programStub = { program: {}, u: {} }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

describe('makeEstimatedIntensityLayer', () => {
  it('分布を渡して表示すると面を描き、不調は報告しない', () => {
    const { gl, counts } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(45))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(counts.drawElements).toBe(1)
    expect(isBroken()).toBe(false)
  })

  // 正: **値テクスチャを最近傍で引く。** 線形補間だと隣り合うセルのあいだに電文が持たない
  // 値が作られ、狭い範囲ほど面積と形が崩れる（実測は docs/spec/map-rendering-spec.md §19）。
  // 対照: 凡例テクスチャも最近傍のまま——こちらを補間すると階級の色そのものが混ざる。
  it('値テクスチャも凡例テクスチャも最近傍で引く', () => {
    const { gl, texParams } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    // 1 が値テクスチャ・2 が凡例テクスチャ（実装がこの順に作る）。
    for (const texId of [1, 2]) {
      expect(texParams.get(texId)?.[GL_MIN_FILTER]).toBe(GL_NEAREST)
      expect(texParams.get(texId)?.[GL_MAG_FILTER]).toBe(GL_NEAREST)
    }
  })

  // 正: **幅が奇数だと既定の境界（4）では転送ごと拒否される。** セル 1 つの分布は
  // 縁の余白を挟んで 3x3 になるので、この最小例がそのまま境界の条件に当たる。
  it('幅が奇数の分布でも、値テクスチャの転送を拒否されない', () => {
    const { gl, counts } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(45))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(counts.unpackRejected).toBe(0)
    expect(counts.drawElements).toBe(1)
  })

  // 安全弁: **変えた値は元へ戻すこと。** 戻し忘れると、この文脈で転送する
  // 他のレイヤー（MapLibre 自身を含む）が、こちらが変えた境界で動くことになる。
  it('転送のあとは行の詰め方を元へ戻す', () => {
    const { gl } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(45))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(gl.getParameter((gl as unknown as { UNPACK_ALIGNMENT: number }).UNPACK_ALIGNMENT)).toBe(4)
  })

  // 安全弁: 例外で抜けた経路でも戻すこと（`finally` を外すと落ちる）。
  it('焼き込みが例外で終わっても行の詰め方を元へ戻す', () => {
    const { gl } = makeGl({ texImage2DThrows: true })
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(45))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(gl.getParameter((gl as unknown as { UNPACK_ALIGNMENT: number }).UNPACK_ALIGNMENT)).toBe(4)
  })

  it('分布を持っていないあいだは、描かないが不調としても報告しない', () => {
    const { gl, counts } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(counts.drawElements).toBe(0)
    expect(isBroken()).toBe(false)
  })

  it('GL のリソースを作れなければ画面へ出す（WebGL の生成関数は例外を投げず null を返す）', () => {
    const { gl } = makeGl({ resourcesFail: true })
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(45))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)
  })

  it('GL のリソースを作れなくても、分布を持っていないあいだは報告しない', () => {
    // **「描けていない」は結果から判定する。** 分布が無いなら描くものが無いだけなので、
    // リソースの有無に関わらず不調ではない。理由ごとにフラグを持つ作りでは、
    // 経路ごとに「まだ描くものが無い」の扱いを書き分ける必要があった。
    const { gl } = makeGl({ resourcesFail: true })
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(false)

    // 分布が届いた時点で報告へ転じる。
    layer.setData(makeData(45))
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)
  })

  it('投影シェーダーを用意できなければ画面へ出し、通るようになったら取り下げる', () => {
    const { gl } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(45))
    layer.setVisible(true)

    programStub = null
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)

    // 投影の切り替えで作り直され、通るようになった。
    programStub = { program: {}, u: {} }
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(false)
  })

  it('凡例に当たる値が 1 画素も無ければ画面へ出す', () => {
    const { gl, counts } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    // 震度4 の下限（35）未満。焼けるが色が付かない。
    layer.setData(makeData(20))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(counts.drawElements).toBe(0)
    expect(isBroken()).toBe(true)
  })

  it('セルがあっても計測震度 0 しか無ければ画面へ出す', () => {
    const { gl } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(0))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)
  })

  it('隠すと報告を取り下げ、表示へ戻すと同じ不調を出し直す（分布が変わらなくても）', () => {
    const { gl } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(20))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)

    // 隠しているあいだは画面へ出さない。
    layer.setVisible(false)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(false)

    // **表示へ戻したら出し直す。** 分布が変わっていないので焼き直しは走らないが、
    // 描けない状態は続いている。
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)
  })

  it('隠しているあいだは面を描かない', () => {
    const { gl, counts } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(45))
    layer.setVisible(false)
    layer.layer.render(gl, ARGS)
    expect(counts.drawElements).toBe(0)
  })

  it('焼き込みが例外で終わったら、以後のフレームでも画面へ出し続ける', () => {
    const { gl } = makeGl({ texImage2DThrows: true })
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(45))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)

    // **次のフレームで消えてはいけない。** `dirty` は消費済みなので焼き直しは走らず、
    // 例外も出ない。`guardRender` はそれを「直った」と読んで自分の報告を取り下げるので、
    // レイヤー側が理由を持っていないと**一度も焼けていないのにバナーが消える**。
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)
  })

  it('焼き込みが例外で終わっても、分布が変わるまで焼き直しを繰り返さない', () => {
    const { gl, counts } = makeGl({ texImage2DThrows: true })
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(45))
    layer.setVisible(true)
    // 例外は `guardRender` が受け止める（呼び出し側へは伝わらない）。
    layer.layer.render(gl, ARGS)
    expect(counts.texImage2D).toBe(1)
    // 次のフレームで焼き直しへ入らない（毎フレーム再試行すると他のレイヤーを圧迫する）。
    layer.layer.render(gl, ARGS)
    layer.layer.render(gl, ARGS)
    expect(counts.texImage2D).toBe(1)
    // 分布が変わればもう一度試す。
    layer.setData(makeData(46))
    layer.layer.render(gl, ARGS)
    expect(counts.texImage2D).toBe(2)
  })

  it('投影シェーダーの一時的な失敗が、データ由来の不調を消さない', () => {
    const { gl } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    // 凡例に当たらない分布で、データ由来の不調を確定させる（ここで焼き直しは済む）。
    layer.setData(makeData(20))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)

    // 投影が切り替わってシェーダーが一時的に取れない。
    programStub = null
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)

    // **作り直せても、データ由来の不調は残っている。** 焼き直しは分布が変わらない限り
    // 走らないので、ここで消すと二度と報告されない。
    programStub = { program: {}, u: {} }
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)
  })

  it('セルを 1 件も持たない分布は焼けないので画面へ出す', () => {
    const { gl } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    const data = makeData(45)
    data.count = 0
    layer.setData(data)
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)
  })

  it('リソースを一部だけ作れたときは、作れた分を解放してから諦める', () => {
    // テクスチャは作れるがバッファは作れない、という形。
    const { gl, counts } = makeGl({ buffersFail: true })
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(45))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)
    // 参照を捨てる前に解放する（捨ててから作り直すと GPU 側に残る）。
    expect(counts.deleteTexture).toBe(2)
  })

  it('画面から外すと報告を取り下げる', () => {
    const { gl } = makeGl()
    const layer = makeEstimatedIntensityLayer()
    layer.layer.onAdd!(MAP, gl)
    layer.setData(makeData(20))
    layer.setVisible(true)
    layer.layer.render(gl, ARGS)
    expect(isBroken()).toBe(true)
    layer.layer.onRemove!(MAP, gl)
    expect(isBroken()).toBe(false)
  })
})
