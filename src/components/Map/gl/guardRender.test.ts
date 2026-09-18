// カスタムレイヤーの描画例外を、そのレイヤーの中に閉じ込めることを固定する。
//
// **ここが守るのは ErrorBoundary が原理的に届かない範囲。** MapLibre の描画ループ（rAF）から
// 呼ばれるため、React の境界をどこへ置いても捕まえられない（`guardRender.ts` の冒頭）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CustomRenderMethodInput } from 'maplibre-gl'
import { guardRender } from './guardRender'
import { getRenderHealth, reportRenderFailure, clearRenderFailure, resetRenderHealthForTest, clearRenderFailuresFor } from '../../../utils/renderHealth'

const ARGS = {} as CustomRenderMethodInput

/**
 * 状態を持つだけの偽の GL。**`render()` の途中で例外が起きる状況**を作るために使う。
 *
 * 見ているのは描き先（FBO）と、後続のレイヤーを巻き込む設定（矩形の切り抜き・合成・頂点配列）。
 */
function makeFakeGl() {
  const state = { fbo: 'main' as unknown, scissor: false, blend: false, vao: 'dirty' as unknown }
  const gl = {
    FRAMEBUFFER: 'FRAMEBUFFER',
    FRAMEBUFFER_BINDING: 'FRAMEBUFFER_BINDING',
    SCISSOR_TEST: 'SCISSOR_TEST',
    BLEND: 'BLEND',
    ARRAY_BUFFER: 'ARRAY_BUFFER',
    ELEMENT_ARRAY_BUFFER: 'ELEMENT_ARRAY_BUFFER',
    TEXTURE_2D: 'TEXTURE_2D',
    getParameter: (p: string) => (p === 'FRAMEBUFFER_BINDING' ? state.fbo : null),
    bindFramebuffer: (_t: string, v: unknown) => { state.fbo = v },
    enable: (c: string) => { if (c === 'SCISSOR_TEST') state.scissor = true; if (c === 'BLEND') state.blend = true },
    disable: (c: string) => { if (c === 'SCISSOR_TEST') state.scissor = false; if (c === 'BLEND') state.blend = false },
    bindBuffer: () => {},
    bindTexture: () => {},
    bindVertexArray: (v: unknown) => { state.vao = v },
  }
  return { gl: gl as unknown as WebGL2RenderingContext, state }
}

let GL: WebGL2RenderingContext
let errorSpy: { mock: { calls: unknown[][] } }

beforeEach(() => {
  resetRenderHealthForTest()
  GL = makeFakeGl().gl
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

function guardLogCount(): number {
  return errorSpy.mock.calls.filter((args) =>
    args.some((a) => typeof a === 'string' && a.includes('[guardRender:')),
  ).length
}

describe('guardRender', () => {
  // 対照: 正常なレイヤーには何も足さないこと。
  it('投げなければ何も記録しない', () => {
    const inner = vi.fn()
    guardRender('lyr', '予報円', inner)(GL, ARGS)
    expect(inner).toHaveBeenCalledTimes(1)
    expect(getRenderHealth().broken).toEqual([])
    expect(guardLogCount()).toBe(0)
  })

  // 正: 例外を呼び出し元へ漏らさないこと。**漏らすと MapLibre の描画ループが止まり、
  // 後ろのレイヤーが丸ごと描かれない。**
  it('例外を呼び出し元へ伝えず、画面に出す記録へ振り替える', () => {
    const guarded = guardRender('lyr', '予報円', () => {
      throw new Error('boom')
    })
    expect(() => guarded(GL, ARGS)).not.toThrow()
    expect(getRenderHealth().broken).toEqual(['予報円'])
    expect(guardLogCount()).toBe(1)
  })

  it('直ったら画面の記録を取り下げる', () => {
    let explode = true
    const guarded = guardRender('lyr', '予報円', () => {
      if (explode) throw new Error('boom')
    })
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual(['予報円'])
    explode = false
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual([])
  })

  // 安全弁: **レイヤーが自分の判断で出した報告を横取りしないこと。**
  // `depthPointLayer` はシェーダーのリンク失敗を自分で報告するが、例外は投げずに return する。
  // ここから見れば「成功」なので、無条件に取り下げる作りだと利用者への警告が毎フレーム消える。
  it('レイヤー自身が出した報告は、成功しても取り下げない', () => {
    const guarded = guardRender('lyr', '震源カタログ', () => {
      // 例外は投げない。レイヤーが自分で不調を申告している状態。
      reportRenderFailure('lyr', '震源カタログ', 'draw')
    })
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual(['震源カタログ'])
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual(['震源カタログ'])
  })

  // 安全弁: 毎フレーム呼ばれる経路なので、記録は間引くこと。素通しにすると 60fps で同じ行が流れ、
  // 他の記録が読めなくなる。
  it('投げ続けても記録は間引く', () => {
    const guarded = guardRender('lyr', '予報円', () => {
      throw new Error('boom')
    })
    for (let i = 0; i < 100; i++) guarded(GL, ARGS)
    expect(guardLogCount()).toBe(1)
    // 画面の記録のほうは出たままであること（間引きは記録だけの話）。
    expect(getRenderHealth().broken).toEqual(['予報円'])
  })
})

describe('guardRender — 例外で抜けたときの GL 状態', () => {
  // 正: 描き先を戻すこと。
  //
  // **これが無くても、いまの MapLibre は自分で戻す**（`guardRender.ts` の `restoreGlState` の説明）。
  // 固定しているのは「レイヤーが変えた状態を持ち帰らせない」という約束のほうで、
  // 画面が壊れるかどうかはここでは測っていない（モックに MapLibre 側の後処理は無い）。
  it('途中で投げても描き先を元へ戻す', () => {
    const { gl, state } = makeFakeGl()
    const guarded = guardRender('lyr', '弱い揺れの観測点', (g) => {
      // オフスクリーンへ切り替えた直後に落ちる、という形を作る。
      g.bindFramebuffer(g.FRAMEBUFFER, 'offscreen' as unknown as WebGLFramebuffer)
      throw new Error('boom')
    })
    guarded(gl, ARGS)
    expect(state.fbo).toBe('main')
  })

  // 正: 後続を巻き込む設定も戻すこと。**矩形の切り抜きは MapLibre が追跡していない**ので、
  // 残したまま抜けると次のレイヤーがその枠の外へ描けない（いま包んでいる 3 本は使っていないが、
  // 将来ガードの対象が増えたときのための備え）。
  it('途中で投げても切り抜きと合成を解く', () => {
    const { gl, state } = makeFakeGl()
    const guarded = guardRender('lyr', '震源カタログ', (g) => {
      g.enable(g.SCISSOR_TEST)
      g.enable(g.BLEND)
      throw new Error('boom')
    })
    guarded(gl, ARGS)
    expect(state.scissor).toBe(false)
    expect(state.blend).toBe(false)
    expect(state.vao).toBeNull()
  })

  // 対照: **正常に終わったら触らないこと。** レイヤーは自分の末尾で状態を組み立て直しており、
  // ここで横から書き換えると、そのレイヤーが意図して残した設定を壊す。
  it('正常に終わったら GL 状態に触らない', () => {
    const { gl, state } = makeFakeGl()
    const guarded = guardRender('lyr', '予報円', (g) => {
      g.enable(g.BLEND)
      g.bindFramebuffer(g.FRAMEBUFFER, 'layer-choice' as unknown as WebGLFramebuffer)
    })
    guarded(gl, ARGS)
    expect(state.fbo).toBe('layer-choice')
    expect(state.blend).toBe(true)
  })

  // 安全弁: 復元そのものが投げても（コンテキストを失ったとき）、例外を外へ漏らさず記録は出すこと。
  it('復元が投げても例外を漏らさず記録は残す', () => {
    const { gl } = makeFakeGl()
    const broken = { ...gl, bindFramebuffer: () => { throw new Error('context lost') } } as unknown as WebGL2RenderingContext
    const guarded = guardRender('lyr', '予報円', () => {
      throw new Error('boom')
    })
    expect(() => guarded(broken, ARGS)).not.toThrow()
    expect(guardLogCount()).toBe(1)
    expect(getRenderHealth().broken).toEqual(['予報円'])
  })
})

describe('guardRender — 記録の間引き', () => {
  // 安全弁: **内容ごとに間引くこと。** 1 本の間引きで済ませると、原因の違う例外が交互に起きたとき
  // 間隔の内側へ落ちた側が一度も記録されないまま終わる。
  it('原因が違えば間引かない', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    let t = 1_000_000
    nowSpy.mockImplementation(() => t)

    let n = 0
    const guarded = guardRender('lyr', '予報円', () => {
      n++
      throw new Error(n % 2 === 0 ? '原因 A' : '原因 B')
    })
    guarded(GL, ARGS)
    // 内容を問わない下限（立て続けに出さないための歯止め）を越えてから 2 回目を起こす。
    t += 1_001
    guarded(GL, ARGS)
    expect(guardLogCount()).toBe(2)
  })

  // 安全弁: **内容が違っても立て続けには出さないこと。** 文面に毎フレーム変わる値（座標・添字など）が
  // 入っていると、内容ごとの間引きはどれも「初めて見るもの」として素通りし、60fps で流れる。
  it('内容が違っても立て続けには出さない', () => {
    let n = 0
    const guarded = guardRender('lyr', '予報円', () => {
      throw new Error(`原因 ${n++}`)
    })
    for (let i = 0; i < 60; i++) guarded(GL, ARGS)
    expect(guardLogCount()).toBe(1)
  })

  it('同じ原因が続けば間引く', () => {
    const guarded = guardRender('lyr', '予報円', () => {
      throw new Error('同じ原因')
    })
    for (let i = 0; i < 50; i++) guarded(GL, ARGS)
    expect(guardLogCount()).toBe(1)
  })

  // 安全弁: 毎回違う文面で投げ続けても、覚える量の上限で記録が止まらないこと。
  it('覚える原因が上限を超えても記録は続く', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    let t = 1_000_000
    nowSpy.mockImplementation(() => t)

    let n = 0
    const guarded = guardRender('lyr', '予報円', () => {
      throw new Error(`原因 ${n++}`)
    })
    for (let i = 0; i < 100; i++) {
      guarded(GL, ARGS)
      t += 1_001
    }
    expect(guardLogCount()).toBe(100)
  })
})

describe('guardRender — レイヤー自身の報告との住み分け', () => {
  // 安全弁: **フレームをまたいでもレイヤーの報告を取り下げないこと。**
  //
  // 「先に例外で報告 → 別のフレームでレイヤーが自分で不調を申告（例外は投げない）」という順序では、
  // ここからは後者が「成功」に見える。フラグ 1 つで「自分が報告したか」を覚える作りだと、
  // その成功を見て**他人の報告まで消してしまう**。報告の鍵を分けることで防いでいる。
  it('例外の後にレイヤーが自己申告しても、その報告は残る', () => {
    let explode = true
    const guarded = guardRender('lyr', '震源カタログ', () => {
      if (explode) throw new Error('boom')
      // 例外は投げず、レイヤーが自分で不調を申告する（シェーダーのリンク失敗など）。
      reportRenderFailure('lyr', '震源カタログ', 'draw')
    })
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual(['震源カタログ'])

    explode = false
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual(['震源カタログ'])
  })

  // 対照: レイヤーが黙っているなら、例外が直った時点で消えること（消えないほうの誤りも防ぐ）。
  it('レイヤーが何も言っていなければ、直った時点で消える', () => {
    let explode = true
    const guarded = guardRender('lyr', '予報円', () => {
      if (explode) throw new Error('boom')
    })
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual(['予報円'])

    explode = false
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual([])
  })

  // 安全弁: 両方が同時に報告していても、利用者に同じ名前を 2 つ並べないこと。
  it('レイヤーと例外が同時に報告しても名前は 1 つにまとまる', () => {
    const guarded = guardRender('lyr', '震源カタログ', () => {
      reportRenderFailure('lyr', '震源カタログ', 'draw')
      throw new Error('boom')
    })
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual(['震源カタログ'])
  })
})

describe('guardRender — レイヤーを外したとき', () => {
  // 正: **画面から外れたら記録も消えること。**
  // ここが消えないと、正しく描けるようになっても「描けていません」が恒久的に居座る
  //（`render()` はもう呼ばれないので、ガードの側に取り下げる機会が無い）。
  // 各レイヤーの `onRemove` が呼ぶ 1 行で、レイヤー自身の申告と一緒に消える仕掛け。
  it('レイヤーの ID でまとめて後始末すると、ガードが残した記録も消える', () => {
    const guarded = guardRender('lyr', '予報円', () => {
      throw new Error('boom')
    })
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual(['予報円'])

    clearRenderFailuresFor('lyr')
    expect(getRenderHealth().broken).toEqual([])
  })

  // 安全弁: **レイヤー自身の取り下げでは消えないこと。**
  // ガードは「自分が報告したか」をクロージャの中だけで覚えている。外から消すと消されたことに
  // 気づけず、**例外が続いていても二度と報告しない**（画面は「描けている」と言い続ける）。
  // だから「直った・隠した」で取り下げるときは 1 件だけ消す（`utils/renderHealth.ts`）。
  it('レイヤー自身の取り下げでは、ガードが残した記録を巻き込まない', () => {
    let explode = true
    const guarded = guardRender('lyr', '予報円', () => {
      if (explode) throw new Error('boom')
    })
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual(['予報円'])

    // レイヤーが自分の申告を取り下げても、ガードの記録は残る。
    clearRenderFailure('lyr', 'draw')
    expect(getRenderHealth().broken).toEqual(['予報円'])

    // **巻き込まれていないからこそ、例外が止まったフレームで自分で取り下げられる。**
    // 外から消されていると、ガードは「報告済み」を覚えたまま消えたことに気づけず、
    // 取り下げも再報告もできなくなる。
    explode = false
    guarded(GL, ARGS)
    expect(getRenderHealth().broken).toEqual([])
  })
})
