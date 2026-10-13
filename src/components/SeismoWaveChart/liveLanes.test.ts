// 地図の下端の波形の描き分け（`drawLanes`）。**固定するのは 3 つ** ——展開かどうかを段の数ではなく
// `expanded` で決めること・畳んだ合成が描けなければ 3 成分へ戻すこと・列を列数ごとに 1 回だけ組むこと。
// 描画そのもの（`paintWave.ts`）は差し替え、どの描き方をどの引数で呼んだかだけを見る。

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'
import { quietScaledGal } from '../../utils/seismoQuietScale'
import { drawLanes, type Lane } from './liveLanes'
import { paintCompositeColumns, paintWaveColumns } from './paintWave'
import { buildWaveColumns } from './waveColumns'

vi.mock('./paintWave', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./paintWave')>()
  return { ...orig, paintCompositeColumns: vi.fn(), paintWaveColumns: vi.fn() }
})
vi.mock('./waveColumns', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./waveColumns')>()
  return { ...orig, buildWaveColumns: vi.fn(orig.buildWaveColumns) }
})

const composite = vi.mocked(paintCompositeColumns)
const overlay = vi.mocked(paintWaveColumns)
const build = vi.mocked(buildWaveColumns)

/** 100 Hz・2 秒の窓（3 成分とも値あり）。 */
function windowOf(): SeismoWaveWindow {
  const n = 200
  const axis = () => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 5))
  return { firstSampleMs: 1_000_000, msPerSample: 10, gal: [axis(), axis(), axis()], memberCount: new Float32Array(n).fill(3) }
}

function canvasesFor(lanes: readonly Lane[]): Map<string, HTMLCanvasElement> {
  const keys = lanes.map((l) => (l.kind === 'axis' ? `axis-${l.axis}` : l.kind))
  return new Map(keys.map((k) => [k, {} as HTMLCanvasElement]))
}

function run(lanes: readonly Lane[], expanded: boolean) {
  return drawLanes({ canvases: canvasesFor(lanes), lanes, expanded, win: windowOf(), stale: false, quietLevel: 0.2, arrival: null })
}

beforeEach(() => {
  composite.mockReset()
  overlay.mockReset()
  build.mockClear()
})

describe('drawLanes の展開', () => {
  // 正: 展開していれば、段が 2 つ（合成＋1 成分）に減っても展開の描き方（平均線・詳細の窓と同じ下限）で描く。
  it('展開なら段の数によらず平均線と ×1.5 の下限で描く', () => {
    composite.mockReturnValue('0〜1.00 gal')
    overlay.mockReturnValue('±1.00 gal')
    run([{ kind: 'composite' }, { kind: 'axis', axis: 2 }], true)
    const opts = composite.mock.calls[0][3]
    expect(opts.overlays).toBeDefined()
    expect(opts.minScaleGal).toBeCloseTo(quietScaledGal('detail', 0.2))
  })

  // 対照: 畳んでいれば平均線を付けず、下限は ×3。
  it('畳んでいれば平均線なし・×3 の下限', () => {
    composite.mockReturnValue('0〜1.00 gal')
    run([{ kind: 'composite' }], false)
    const opts = composite.mock.calls[0][3]
    expect(opts.overlays).toBeUndefined()
    expect(opts.minScaleGal).toBeCloseTo(quietScaledGal('card', 0.2))
  })
})

describe('drawLanes の 3 成分への戻し', () => {
  // 正: 畳んだ合成が描けなければ 3 成分を重ねて描き、「戻した」と返す。
  it('畳んだ合成が null なら 3 成分を重ねる', () => {
    composite.mockReturnValue(null)
    overlay.mockReturnValue('±1.00 gal')
    const out = run([{ kind: 'composite' }], false)
    expect(overlay).toHaveBeenCalledTimes(1)
    expect(out.compositeFellBack).toBe(true)
    expect(out.texts.composite).toBe('±1.00 gal')
  })

  // 対照: 展開しているときの合成の段は戻さない（成分の段が下にある）。
  it('展開中の合成の段は戻さない', () => {
    composite.mockReturnValue(null)
    overlay.mockReturnValue('±1.00 gal')
    const out = run([{ kind: 'composite' }, { kind: 'axis', axis: 0 }], true)
    expect(out.compositeFellBack).toBe(false)
    expect(out.texts.composite).toBeNull()
  })

  // 安全弁: 重ねた絵も描けなければ（値が 1 つも無い）「戻した」とは数えない。
  it('重ねた絵も描けなければ戻したと数えない', () => {
    composite.mockReturnValue(null)
    overlay.mockReturnValue(null)
    expect(run([{ kind: 'composite' }], false).compositeFellBack).toBe(false)
  })
})

describe('drawLanes の列の組み立て', () => {
  // 正: 同じ列数なら、段がいくつあっても列は 1 回だけ組む。
  it('同じ列数なら 1 回だけ組む', () => {
    composite.mockImplementation((_c, b) => (b(50), '0〜1.00 gal'))
    overlay.mockImplementation((_c, b) => (b(50), '±1.00 gal'))
    run([{ kind: 'composite' }, { kind: 'axis', axis: 0 }, { kind: 'axis', axis: 1 }], true)
    expect(build).toHaveBeenCalledTimes(1)
  })

  // 対照: 列数が変われば組み直す（古い列を返さない）。
  it('列数が違えば組み直す', () => {
    composite.mockImplementation((_c, b) => (b(50), '0〜1.00 gal'))
    overlay.mockImplementation((_c, b) => (b(60), '±1.00 gal'))
    run([{ kind: 'composite' }, { kind: 'axis', axis: 0 }], true)
    expect(build).toHaveBeenCalledTimes(2)
  })
})
