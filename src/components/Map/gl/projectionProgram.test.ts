// 投影ごとのプログラム作り分けを固定する。
// 実際の描画は WebGL なのでここでは触れない（ブラウザ確認の担当）。
// 背景と実測値は docs/spec/map-rendering-spec.md §6「地図の投影」。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createProjectionProgramCache, applyProjectionUniforms, PROJECTION_UNIFORMS } from './projectionProgram'
import { log } from '../../../utils/logger'

// 記録の内容を検証したいので `log` だけ差し替える。本物のままだとテスト実行時に警告が素通しで混ざる。
vi.mock('../../../utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/logger')>()
  return { ...actual, log: { ...actual.log, warn: vi.fn(), error: vi.fn() } }
})

// 最低限の GL のふり。プログラムを識別できるよう連番のオブジェクトを返す。
function fakeGl(opts: { linkOk?: (variant: string) => boolean } = {}) {
  let programSeq = 0
  const bound: { program: number; index: number; name: string }[] = []
  const deleted: number[] = []
  const sources: string[] = []
  let currentVariant = ''
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    createShader: () => ({}),
    shaderSource: (_s: unknown, src: string) => sources.push(src),
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => ({ id: ++programSeq }),
    attachShader: () => {},
    bindAttribLocation: (p: { id: number }, index: number, name: string) =>
      bound.push({ program: p.id, index, name }),
    linkProgram: () => {},
    deleteShader: () => {},
    deleteProgram: (p: { id: number }) => deleted.push(p.id),
    getProgramParameter: () => (opts.linkOk ? opts.linkOk(currentVariant) : true),
    getProgramInfoLog: () => '',
    getUniformLocation: (_p: unknown, name: string) => (name === 'u_missing' ? null : { name }),
    uniformMatrix4fv: vi.fn(),
    uniform4fv: vi.fn(),
    uniform1f: vi.fn(),
  }
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    bound,
    deleted,
    sources,
    setVariant: (v: string) => { currentVariant = v },
    get programCount() { return programSeq },
  }
}

function args(variant: string) {
  return {
    shaderData: {
      variantName: variant,
      vertexShaderPrelude: `// prelude:${variant}`,
      define: variant === 'globe' ? '#define GLOBE' : '#define PROJECTION_MERCATOR',
    },
    defaultProjectionData: {
      mainMatrix: new Float64Array(16).fill(1),
      tileMercatorCoords: [0, 0, 1, 1],
      clippingPlane: [1, 2, 3, 4],
      projectionTransition: 0.5,
      fallbackMatrix: new Float64Array(16).fill(2),
    },
  } as never
}

function makeSpec(overrides: Partial<Parameters<typeof createProjectionProgramCache>[0]> = {}) {
  return {
    label: 'test',
    makeVertexSource: (prelude: string, define: string) => `#version 300 es\n${prelude}\n${define}\nvoid main(){}`,
    fragmentSource: 'frag',
    attributes: ['a_pos', 'a_color'] as const,
    uniforms: ['u_size'] as const,
    ...overrides,
  }
}

describe('createProjectionProgramCache', () => {
  beforeEach(() => vi.clearAllMocks())

  it('同じ投影では作り直さない（毎フレーム呼ばれる場所なので必須）', () => {
    const f = fakeGl()
    const cache = createProjectionProgramCache(makeSpec())
    const a = cache.get(f.gl, args('globe'))
    const b = cache.get(f.gl, args('globe'))
    expect(a).toBe(b)
    expect(f.programCount).toBe(1)
  })

  it('投影が切り替わると別のプログラムを作り、戻ると前のものを再利用する', () => {
    const f = fakeGl()
    const cache = createProjectionProgramCache(makeSpec())
    const globe = cache.get(f.gl, args('globe'))
    const mercator = cache.get(f.gl, args('mercator'))
    expect(globe).not.toBe(mercator)
    expect(f.programCount).toBe(2)
    // ズームを戻したときに作り直すと、寄り引きのたびにコンパイルが走る。
    expect(cache.get(f.gl, args('globe'))).toBe(globe)
    expect(f.programCount).toBe(2)
  })

  it('投影ごとの prelude と define を頂点シェーダーへ前置きする', () => {
    const f = fakeGl()
    const cache = createProjectionProgramCache(makeSpec())
    cache.get(f.gl, args('globe'))
    expect(f.sources[0]).toContain('// prelude:globe')
    expect(f.sources[0]).toContain('#define GLOBE')
    expect(f.sources[0].startsWith('#version 300 es')).toBe(true)
  })

  it('属性の番号を並び順どおりに固定する（VAO を投影ごとに作り直さずに済む）', () => {
    const f = fakeGl()
    const cache = createProjectionProgramCache(makeSpec())
    cache.get(f.gl, args('globe'))
    cache.get(f.gl, args('mercator'))
    // どちらのプログラムでも同じ番号が割り当たること。
    expect(f.bound.filter((b) => b.name === 'a_pos').map((b) => b.index)).toEqual([0, 0])
    expect(f.bound.filter((b) => b.name === 'a_color').map((b) => b.index)).toEqual([1, 1])
  })

  it('リンクに失敗したら null を返す（失敗したプログラムを使うと別レイヤーを巻き込む）', () => {
    const f = fakeGl({ linkOk: () => false })
    const cache = createProjectionProgramCache(makeSpec())
    expect(cache.get(f.gl, args('globe'))).toBeNull()
  })

  it('失敗も覚える（毎フレーム作り直しに行くとログで埋まる）', () => {
    const f = fakeGl({ linkOk: () => false })
    const cache = createProjectionProgramCache(makeSpec())
    cache.get(f.gl, args('globe'))
    cache.get(f.gl, args('globe'))
    cache.get(f.gl, args('globe'))
    expect(f.programCount).toBe(1)
  })

  it('片方の投影だけ失敗しても、もう片方は使える（安全弁）', () => {
    const f = fakeGl({ linkOk: (v) => v !== 'globe' })
    const cache = createProjectionProgramCache(makeSpec())
    f.setVariant('globe')
    expect(cache.get(f.gl, args('globe'))).toBeNull()
    f.setVariant('mercator')
    expect(cache.get(f.gl, args('mercator'))).not.toBeNull()
  })

  it('投影側の 5 つの uniform を自前のものと一緒に引く', () => {
    const f = fakeGl()
    const cache = createProjectionProgramCache(makeSpec())
    const p = cache.get(f.gl, args('globe'))
    for (const name of PROJECTION_UNIFORMS) expect(p?.u[name]).toBeTruthy()
    expect(p?.u.u_size).toBeTruthy()
  })

  it('呼び出し側の uniform が引けなかったら記録する（名前の食い違いは黙って効かなくなる）', () => {
    const f = fakeGl()
    const cache = createProjectionProgramCache(makeSpec({ uniforms: ['u_size', 'u_missing'] as const }))
    cache.get(f.gl, args('globe'))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('u_missing'))
  })

  it('投影側の uniform が null でも記録しない（Mercator では 4 つが正常に null）', () => {
    const f = fakeGl()
    // 投影側の 5 つをすべて null にしても、警告の対象は呼び出し側の uniform だけ。
    const gl = f.gl as unknown as { getUniformLocation: (p: unknown, n: string) => unknown }
    const orig = gl.getUniformLocation
    gl.getUniformLocation = (p, n) => (PROJECTION_UNIFORMS.includes(n as never) ? null : orig(p, n))
    const cache = createProjectionProgramCache(makeSpec())
    cache.get(f.gl, args('mercator'))
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('dispose で抱えているプログラムをすべて解放する', () => {
    const f = fakeGl()
    const cache = createProjectionProgramCache(makeSpec())
    cache.get(f.gl, args('globe'))
    cache.get(f.gl, args('mercator'))
    cache.dispose(f.gl)
    expect(f.deleted).toEqual([1, 2])
    // 解放後に引くと作り直す（キャッシュも空になっている）。
    cache.get(f.gl, args('globe'))
    expect(f.programCount).toBe(3)
  })
})

describe('applyProjectionUniforms', () => {
  it('行列は Float32Array へ写して送る（Float64Array のまま渡せない）', () => {
    const f = fakeGl()
    const cache = createProjectionProgramCache(makeSpec())
    const p = cache.get(f.gl, args('globe'))!
    applyProjectionUniforms(f.gl, p.u, args('globe'))
    const calls = (f.gl.uniformMatrix4fv as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    for (const [, , value] of calls) expect(value).toBeInstanceOf(Float32Array)
    expect(Array.from(calls[0][2] as Float32Array)).toEqual(new Array(16).fill(1))
    expect(Array.from(calls[1][2] as Float32Array)).toEqual(new Array(16).fill(2))
  })

  it('球でしか使わない uniform も送る（平面では引き当たらず何もしない）', () => {
    const f = fakeGl()
    const cache = createProjectionProgramCache(makeSpec())
    const p = cache.get(f.gl, args('mercator'))!
    applyProjectionUniforms(f.gl, p.u, args('mercator'))
    expect(f.gl.uniform4fv).toHaveBeenCalledTimes(2)
    expect(f.gl.uniform1f).toHaveBeenCalledWith(expect.anything(), 0.5)
  })
})
