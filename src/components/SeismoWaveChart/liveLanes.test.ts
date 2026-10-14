// 地図の下端の波形の描き分け（`drawLanes`）。**固定するのは 4 つ** ——展開かどうかを段の数ではなく
// `expanded` で決めること・畳んだ合成が描けなければ 3 成分へ戻すこと・線が 1 本だけの絵に平均の線を重ねること・
// 列を列数ごとに 1 回だけ組むこと。
// 描画そのもの（`paintWave.ts`）は差し替え、どの描き方をどの引数で呼んだかだけを見る。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetWaveAxes, toggleWaveAxis } from '../../hooks/useSeismoWaveAxes'
import type { SeismoWaveWindow } from '../../utils/seismoWaveBuffer'
import { quietScaledGal } from '../../utils/seismoQuietScale'
import { drawLanes, liveArrivalMarks, singleVisibleAxis, type Lane } from './liveLanes'
import { paintCompositeColumns, paintMarks, paintWaveColumns } from './paintWave'
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

/** 重ねる線が値を持つか。**本数だけでは足りない** ——作り忘れた平均も `NaN` の線として同じ本数で返る。 */
function allHaveValues(lines: readonly { values: ArrayLike<number> }[] | undefined): boolean {
  return lines !== undefined && lines.length > 0 && lines.every((l) => Array.from(l.values).some(Number.isFinite))
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

  // 正（2026-10-13 に覆した）: 畳んだ合成も線が 1 本なので、均した線を重ねる。下限は ×3 のまま。
  // 以前は「畳んでいれば平均線なし」を固定していた。
  it('畳んだ合成にも均した線を重ね、下限は ×3', () => {
    composite.mockReturnValue('0〜1.00 gal')
    run([{ kind: 'composite' }], false)
    const opts = composite.mock.calls[0][3]
    expect(opts.overlays).toBeDefined()
    expect(opts.overlays?.(50)).toHaveLength(1)
    expect(allHaveValues(opts.overlays?.(50))).toBe(true)
    expect(opts.minScaleGal).toBeCloseTo(quietScaledGal('card', 0.2))
  })
})

describe('drawLanes の 3 成分を重ねる絵', () => {
  afterEach(() => resetWaveAxes())

  // 正: 向きが 1 つだけなら、その成分の正側・負側の平均の線を重ねる。
  it('向きが 1 つだけなら平均の線を 2 本重ねる', () => {
    toggleWaveAxis(0)
    toggleWaveAxis(1)
    overlay.mockReturnValue('±1.00 gal')
    run([{ kind: 'overlay' }], false)
    const opts = overlay.mock.calls[0][3]
    expect(opts?.overlays?.(50)).toHaveLength(2)
    expect(allHaveValues(opts?.overlays?.(50))).toBe(true)
  })

  // 対照: 2 本以上重ねているときは足さない（線の数が倍になって読めない）。
  it('向きが 2 つ以上なら重ねない', () => {
    toggleWaveAxis(0)
    overlay.mockReturnValue('±1.00 gal')
    run([{ kind: 'overlay' }], false)
    expect(overlay.mock.calls[0][3]?.overlays).toBeUndefined()
  })

  // 安全弁: 畳んだ合成から 3 成分へ戻した絵にも同じ判定を通す（戻した先だけ線が欠けない）。
  it('合成から戻した絵でも向きが 1 つなら重ねる', () => {
    toggleWaveAxis(1)
    toggleWaveAxis(2)
    composite.mockReturnValue(null)
    overlay.mockReturnValue('±1.00 gal')
    run([{ kind: 'composite' }], false)
    expect(overlay.mock.calls[0][3]?.overlays?.(50)).toHaveLength(2)
    expect(allHaveValues(overlay.mock.calls[0][3]?.overlays?.(50))).toBe(true)
  })

  // 安全弁: 合成の段が先に（成分なしで）平均を作っていても、後の成分の段の線は値を持つ。
  it('展開した成分の段の平均は、合成の段の後でも値を持つ', () => {
    composite.mockImplementation((_c, _b, _s, o) => (o.overlays?.(50), '0〜1.00 gal'))
    overlay.mockReturnValue('±1.00 gal')
    run([{ kind: 'composite' }, { kind: 'axis', axis: 2 }], true)
    expect(allHaveValues(overlay.mock.calls[0][3]?.overlays?.(50))).toBe(true)
  })
})

describe('singleVisibleAxis', () => {
  it('1 つだけ見えていればその番号', () => {
    expect(singleVisibleAxis([false, true, false])).toBe(1)
  })
  it('2 つ以上・0 個なら null', () => {
    expect(singleVisibleAxis([true, true, false])).toBeNull()
    expect(singleVisibleAxis([false, false, false])).toBeNull()
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

// 地図の下端の P/S 線は到達予想キーの門を掛けずに引く（2026-10-14 ユーザー承認）。予報業務に当たらないとした整理は
// 「まだ来ていない時刻の線を描かない」ことに拠る（`docs/forecast-computation-audit.md` の 11）ので、その歯止めを
// 位置の計算（`liveArrivalMarks`）と描く側（`paintMarks`）を通して固定する。
describe('地図の下端の P/S 線は、まだ来ていない時刻を描かない', () => {
  const win = windowOf()
  const lastMs = win.firstSampleMs + (win.gal[0].length - 1) * win.msPerSample

  /** 線とラベルを数えるだけの描画先。 */
  function recordingCtx() {
    const labels: string[] = []
    let strokes = 0
    const ctx = {
      font: '',
      textBaseline: '',
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 0,
      setLineDash: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {
        strokes += 1
      },
      measureText: () => ({ width: 6 }),
      fillText: (text: string) => {
        labels.push(text)
      },
    } as unknown as CanvasRenderingContext2D
    return { ctx, labels, strokes: () => strokes }
  }

  // 正: 既に過ぎた P は窓の中に落ち、まだ来ていない S は右端の外へ落ちる。
  it('右端は最後に届いたサンプルで、その後の到達は比が 1 を超える', () => {
    const marks = liveArrivalMarks(win, { pMs: lastMs - 1_000, sMs: lastMs + 5_000 })
    const p = marks.find((m) => m.label === 'P')
    const s = marks.find((m) => m.label === 'S')
    expect(p?.ratio).toBeGreaterThanOrEqual(0)
    expect(p?.ratio).toBeLessThanOrEqual(1)
    expect(s?.ratio).toBeGreaterThan(1)
  })

  // 正: 描く側は右端の外の線を捨てる（端へ張り付けない）。過ぎた P だけが描かれる。
  it('まだ来ていない S の線は描かれない', () => {
    const { ctx, labels, strokes } = recordingCtx()
    paintMarks(ctx, liveArrivalMarks(win, { pMs: lastMs - 1_000, sMs: lastMs + 5_000 }), 400, 60, 1)
    expect(labels).toEqual(['P'])
    expect(strokes()).toBe(1)
  })

  // 対照: どちらも過ぎていれば 2 本とも描く（捨てる判定が広すぎないこと）。
  it('どちらも過ぎていれば両方描く', () => {
    const { ctx, labels } = recordingCtx()
    paintMarks(ctx, liveArrivalMarks(win, { pMs: lastMs - 1_500, sMs: lastMs - 500 }), 400, 60, 1)
    expect(labels).toEqual(['P', 'S'])
  })

  // 安全弁: ちょうど最後のサンプルの時刻は窓の右端（比 1）で、描いてよい過去に含める。その 1 ms 後は描かない
  // （右端を少しでも先へ伸ばすと、この組が崩れる）。時刻は整数のミリ秒なので、右端の比はちょうど 1 になる。
  it('最後のサンプルと同じ時刻は右端に描き、その 1 ms 後は描かない', () => {
    const { ctx, labels } = recordingCtx()
    paintMarks(ctx, liveArrivalMarks(win, { pMs: lastMs, sMs: lastMs + 1 }), 400, 60, 1)
    expect(labels).toEqual(['P'])
  })

  // 正（結線）: drawLanes は位置を端へ寄せずに、そのまま描画関数へ渡す。合成の段と成分の段の両方で見る
  // （描画関数は差し替えてあるので、渡された比を直に読む）。
  it('drawLanes はまだ来ていない線を右端へ寄せずに渡す', () => {
    const lanes: Lane[] = [{ kind: 'composite' }, { kind: 'axis', axis: 0 }]
    drawLanes({
      canvases: canvasesFor(lanes),
      lanes,
      expanded: true,
      win,
      stale: false,
      quietLevel: 0.2,
      arrival: { pMs: lastMs - 1_000, sMs: lastMs + 5_000 },
    })
    const ratiosOf = (marks: readonly { ratio: number }[] | undefined) => (marks ?? []).map((m) => m.ratio)
    for (const ratios of [ratiosOf(composite.mock.calls[0][3]?.marks), ratiosOf(overlay.mock.calls[0][3]?.marks)]) {
      expect(ratios).toHaveLength(2)
      expect(ratios[0]).toBeGreaterThanOrEqual(0)
      expect(ratios[0]).toBeLessThanOrEqual(1)
      expect(ratios[1]).toBeGreaterThan(1)
    }
  })
})
