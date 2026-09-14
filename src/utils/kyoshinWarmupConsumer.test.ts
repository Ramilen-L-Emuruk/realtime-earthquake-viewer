import { describe, it, expect, beforeEach, vi } from 'vitest'

// `step()` を差し替えて「どのフレームを、どの順で食わせたか」だけを見る。
//
// **この純関数の関心事は検知の中身ではなく、食わせる順序と落とす条件。** 本物の `step()` を
// 通すと、落としたのか検知が立たなかっただけなのかが結果から区別できない
// （検知そのものの回帰は `kyoshinDetector.test.ts` の担当）。
interface StepCall {
  dataTimeMs: number
  values: number[]
  eewActive: boolean
}
const stepCalls: StepCall[] = []
/** その時刻の `step()` を投げさせる（例外の扱いを見るテスト用）。 */
let throwAt: Set<number> = new Set()

vi.mock('./kyoshinDetector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kyoshinDetector')>()
  return {
    ...actual,
    step: (state: unknown, frame: { dataTimeMs: number; values: number[]; eewActive: boolean }) => {
      stepCalls.push({
        dataTimeMs: frame.dataTimeMs,
        values: [...frame.values],
        eewActive: frame.eewActive,
      })
      if (throwAt.has(frame.dataTimeMs)) throw new Error(`boom@${frame.dataTimeMs}`)
      // 呼ばれるたびに別の状態を返す（前の結果を次のフレームへ渡せているかを確かめるため）。
      return {
        state: { ...(state as object), fedAt: frame.dataTimeMs } as never,
        detections: [],
        triggers: [],
        recentOnsetKeys: [],
        prunedMembers: 0,
      }
    },
  }
})

import { buildStationMeta, initState, type StationMeta } from './kyoshinDetector'
import {
  consumeWarmup,
  pushPendingFrame,
  type ConsumeWarmupInput,
  type PendingFrame,
  type WarmupFrame,
} from './kyoshinWarmupConsumer'

// ============================================================
// テスト用ヘルパー
// ============================================================

const SITES: [number, number][] = [
  [35.0, 135.0],
  [35.1, 135.0],
  [35.0, 135.1],
]
const META: StationMeta = buildStationMeta(SITES)
const SITE_CONFIG = '20260101'

/** 全点を同じインデックスにしたフレームの値。 */
function values(idx = 10): number[] {
  return SITES.map(() => idx)
}

function warmupFrame(dataTime: string, opts: Partial<WarmupFrame> = {}): WarmupFrame {
  return { dataTime, indices: values(), sitesKey: SITE_CONFIG, ...opts }
}

function pendingFrame(dataTimeMs: number, opts: Partial<PendingFrame> = {}): PendingFrame {
  return { dataTimeMs, indices: values(), sitesKey: SITE_CONFIG, ...opts }
}

function input(over: Partial<ConsumeWarmupInput> = {}): ConsumeWarmupInput {
  return {
    state: initState(0),
    lastSteppedMs: -Infinity,
    pending: [],
    warmupFrames: [],
    sites: SITES,
    sitesSiteConfigId: SITE_CONFIG,
    meta: META,
    eewActive: false,
    ...over,
  }
}

/** 食わせた順のデータ時刻。 */
function fedTimes(): number[] {
  return stepCalls.map((c) => c.dataTimeMs)
}

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)
/** T0 からの相対秒をミリ秒にする。 */
function ms(sec: number): number {
  return T0 + sec * 1000
}
/** 同じ時刻を ISO 文字列で（助走のフレームは文字列で届く）。 */
function iso(sec: number): string {
  return new Date(ms(sec)).toISOString()
}

beforeEach(() => {
  stepCalls.length = 0
  throwAt = new Set()
})

// ============================================================
// consumeWarmup — 食わせる順序
// ============================================================

describe('consumeWarmup の食わせる順序', () => {
  it('助走 → 待機分（末尾を除く）の順で食わせる', () => {
    const r = consumeWarmup(input({
      warmupFrames: [warmupFrame(iso(-3)), warmupFrame(iso(-2))],
      pending: [pendingFrame(ms(-1)), pendingFrame(ms(0))],
    }))

    expect(fedTimes()).toEqual([ms(-3), ms(-2), ms(-1)])
    expect(r.lastSteppedMs).toBe(ms(-1))
    expect(r.notices).toEqual([])
  })

  it('待機分の末尾は食わせない（呼び出し側が通常の経路で処理して画面へ出すため）', () => {
    consumeWarmup(input({
      warmupFrames: [],
      pending: [pendingFrame(ms(-1)), pendingFrame(ms(0))],
    }))

    // 末尾（ms(0)）が混じると、そのフレームの検知結果が画面へ出ない。
    expect(fedTimes()).toEqual([ms(-1)])
  })

  it('待機分が 1 件だけ（＝いまのフレームのみ）なら助走だけを食わせる', () => {
    consumeWarmup(input({
      warmupFrames: [warmupFrame(iso(-2))],
      pending: [pendingFrame(ms(0))],
    }))

    expect(fedTimes()).toEqual([ms(-2)])
  })

  it('助走を待機分より先に食わせる（逆にすると助走が巻き戻りとして落ちる）', () => {
    // 助走の時刻はすべて待機分より古い。先に食わせなければ 1 件も通らない組み合わせ。
    const r = consumeWarmup(input({
      warmupFrames: [warmupFrame(iso(-5)), warmupFrame(iso(-4))],
      pending: [pendingFrame(ms(-1)), pendingFrame(ms(0))],
    }))

    expect(fedTimes()).toEqual([ms(-5), ms(-4), ms(-1)])
    expect(r.notices).toEqual([])
  })

  it('EEW の発表中かどうかをそのまま `step()` へ渡す', () => {
    consumeWarmup(input({
      warmupFrames: [warmupFrame(iso(-2))],
      eewActive: true,
    }))

    expect(stepCalls[0].eewActive).toBe(true)
  })

  it('返ってきた状態を次のフレームへ渡す（フレームごとに作り直さない）', () => {
    const r = consumeWarmup(input({
      warmupFrames: [warmupFrame(iso(-3)), warmupFrame(iso(-2))],
    }))

    // 差し替えた `step()` は `fedAt` を書き足して返す。最後に食わせた時刻が残っていれば、
    // 前の結果を次のフレームへ渡せている。
    expect((r.state as unknown as { fedAt: number }).fedAt).toBe(ms(-2))
  })
})

// ============================================================
// consumeWarmup — 落とす条件
// ============================================================

describe('consumeWarmup が落とすフレーム', () => {
  it('観測点集合の版が違う助走は食わせない', () => {
    const r = consumeWarmup(input({
      warmupFrames: [
        warmupFrame(iso(-3), { sitesKey: '20250101' }),
        warmupFrame(iso(-2)),
      ],
    }))

    expect(fedTimes()).toEqual([ms(-2)])
    // 使えた分があるので記録は出さない。
    expect(r.notices).toEqual([])
  })

  it('観測点集合の版が違う待機分も食わせない', () => {
    consumeWarmup(input({
      pending: [
        pendingFrame(ms(-3), { sitesKey: '20250101' }),
        pendingFrame(ms(-2)),
        pendingFrame(ms(0)),
      ],
    }))

    expect(fedTimes()).toEqual([ms(-2)])
  })

  it('点数が観測点の数と違うフレームは食わせない（座標と震度の対応が取れない）', () => {
    consumeWarmup(input({
      warmupFrames: [warmupFrame(iso(-3), { indices: [10, 10] }), warmupFrame(iso(-2))],
    }))

    expect(fedTimes()).toEqual([ms(-2)])
  })

  it('巻き戻った時刻・同じ時刻は食わせない（`dtMs` が 0 以下だと状態を作り直す）', () => {
    const r = consumeWarmup(input({
      lastSteppedMs: ms(-2),
      warmupFrames: [
        warmupFrame(iso(-3)), // 巻き戻り
        warmupFrame(iso(-2)), // 同じ時刻
        warmupFrame(iso(-1)), // 進む
      ],
    }))

    expect(fedTimes()).toEqual([ms(-1)])
    expect(r.lastSteppedMs).toBe(ms(-1))
  })

  it('日時として読めない助走は食わせない', () => {
    const r = consumeWarmup(input({
      warmupFrames: [warmupFrame('壊れた値'), warmupFrame(iso(-2))],
    }))

    expect(fedTimes()).toEqual([ms(-2)])
    expect(r.notices).toEqual([])
  })

  it('1 件も食わせなければ `lastSteppedMs` を動かさない', () => {
    const r = consumeWarmup(input({
      lastSteppedMs: ms(-1),
      warmupFrames: [warmupFrame(iso(-5))],
    }))

    expect(fedTimes()).toEqual([])
    expect(r.lastSteppedMs).toBe(ms(-1))
  })
})

// ============================================================
// consumeWarmup — 記録（WarmupNotice）
// ============================================================

describe('consumeWarmup が返す記録', () => {
  it('助走が届かなかったら、待った件数を添えて `gave-up` を返す', () => {
    const r = consumeWarmup(input({
      warmupFrames: null,
      pending: [pendingFrame(ms(-2)), pendingFrame(ms(-1)), pendingFrame(ms(0))],
    }))

    expect(r.notices).toEqual([{ kind: 'gave-up', waitedFrames: 3 }])
    // 諦めても待機分は食わせる（末尾を除く）。
    expect(fedTimes()).toEqual([ms(-2), ms(-1)])
  })

  it('助走が届いたのに 1 件も使えなければ、内訳を添えて `all-unusable` を返す', () => {
    const r = consumeWarmup(input({
      warmupFrames: [
        warmupFrame(iso(-3), { sitesKey: '20250101' }),
        warmupFrame(iso(-2), { sitesKey: '20250101' }),
        warmupFrame(iso(-1), { indices: [10] }), // 版は合うが点数が違う
      ],
    }))

    expect(r.notices).toEqual([{ kind: 'all-unusable', total: 3, versionMismatch: 2 }])
  })

  it('助走が空配列なら記録を出さない（静穏まで遡って打ち切った正常系）', () => {
    const r = consumeWarmup(input({ warmupFrames: [] }))

    expect(r.notices).toEqual([])
  })

  it('`step()` が投げても残りを食わせ、件数と最初に落ちた時刻を `feed-failed` で返す', () => {
    throwAt = new Set([ms(-3), ms(-2)])
    const r = consumeWarmup(input({
      warmupFrames: [warmupFrame(iso(-3)), warmupFrame(iso(-2)), warmupFrame(iso(-1))],
    }))

    // 落ちた 2 件のあとも続けている。
    expect(fedTimes()).toEqual([ms(-3), ms(-2), ms(-1)])
    expect(r.notices).toHaveLength(1)
    const notice = r.notices[0]
    if (notice.kind !== 'feed-failed') throw new Error(`feed-failed を期待したが ${notice.kind}`)
    expect(notice.count).toBe(2)
    expect(notice.frameTimeMs).toBe(ms(-3))
    expect((notice.error as Error).message).toBe(`boom@${ms(-3)}`)
  })

  it('`step()` が投げたフレームでは `lastSteppedMs` を進めない', () => {
    throwAt = new Set([ms(-1)])
    const r = consumeWarmup(input({
      warmupFrames: [warmupFrame(iso(-2)), warmupFrame(iso(-1))],
    }))

    expect(r.lastSteppedMs).toBe(ms(-2))
  })

  it('助走が届かず、かつ消化でも投げたら両方の記録を返す', () => {
    throwAt = new Set([ms(-2)])
    const r = consumeWarmup(input({
      warmupFrames: null,
      pending: [pendingFrame(ms(-2)), pendingFrame(ms(0))],
    }))

    expect(r.notices.map((n) => n.kind)).toEqual(['gave-up', 'feed-failed'])
  })

  it('版は合うが巻き戻りだけで全滅したら、版違い 0 件として `all-unusable` を返す', () => {
    const r = consumeWarmup(input({
      lastSteppedMs: ms(0),
      warmupFrames: [warmupFrame(iso(-2)), warmupFrame(iso(-1))],
    }))

    expect(r.notices).toEqual([{ kind: 'all-unusable', total: 2, versionMismatch: 0 }])
  })
})

// ============================================================
// consumeWarmup — 例外を外へ出さない（2 段の握り）
// ============================================================
//
// **呼び出し元はフックのエフェクト。** 投げるとエフェクトごと未捕捉例外で抜け、根のエラー
// 境界まで飛んで画面全体が落ちる。`step()` 以外の例外もここで止まることを確かめる。

describe('consumeWarmup は例外を外へ出さない', () => {
  it('震度の配列が壊れたフレームでも投げず、残りを食わせて `feed-failed` を返す', () => {
    // 型の上では `number[]` だが、供給元が渡すのは外部データ由来の値。
    // 長さの検証そのものが投げる形を作る。
    const broken = warmupFrame(iso(-3), { indices: undefined as unknown as number[] })
    const r = consumeWarmup(input({ warmupFrames: [broken, warmupFrame(iso(-2))] }))

    expect(fedTimes()).toEqual([ms(-2)])
    expect(r.notices.map((n) => n.kind)).toEqual(['feed-failed'])
    expect(r.lastSteppedMs).toBe(ms(-2))
  })

  it('助走の列そのものが反復できなくても投げず、`aborted` を返して待機分は食わせる', () => {
    const r = consumeWarmup(input({
      warmupFrames: {} as unknown as WarmupFrame[],
      pending: [pendingFrame(ms(-1)), pendingFrame(ms(0))],
    }))

    expect(r.notices).toHaveLength(1)
    expect(r.notices[0].kind).toBe('aborted')
    if (r.notices[0].kind === 'aborted') expect(r.notices[0].phase).toBe('warmup')
    // 助走が壊れていることは、待機分が使えないことを意味しない。
    expect(fedTimes()).toEqual([ms(-1)])
  })

  it('助走の列が途中で壊れても、そこまでに食わせた分は残る', () => {
    const r = consumeWarmup(input({
      warmupFrames: [warmupFrame(iso(-3)), null as unknown as WarmupFrame, warmupFrame(iso(-2))],
    }))

    expect(fedTimes()).toEqual([ms(-3)])
    expect(r.lastSteppedMs).toBe(ms(-3))
    expect(r.notices.map((n) => n.kind)).toEqual(['aborted'])
  })

  it('待機分の列が壊れても投げず、`aborted` を `pending` として返す', () => {
    const r = consumeWarmup(input({
      pending: [
        pendingFrame(ms(-3)),
        null as unknown as PendingFrame,
        pendingFrame(ms(-2)),
        pendingFrame(ms(0)),
      ],
    }))

    expect(fedTimes()).toEqual([ms(-3)])
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0].kind).toBe('aborted')
    if (r.notices[0].kind === 'aborted') expect(r.notices[0].phase).toBe('pending')
  })
})

// ============================================================
// pushPendingFrame
// ============================================================

describe('pushPendingFrame', () => {
  it('データ時刻が進んだフレームを積む', () => {
    const pending: PendingFrame[] = [pendingFrame(ms(-2))]

    const out = pushPendingFrame(pending, pendingFrame(ms(-1)))

    expect(out.map((p) => p.dataTimeMs)).toEqual([ms(-2), ms(-1)])
  })

  it('同じデータ時刻は二重に積まない（助走だけが変わったレンダーで必ず起きる）', () => {
    const pending: PendingFrame[] = [pendingFrame(ms(-2)), pendingFrame(ms(-1))]

    const out = pushPendingFrame(pending, pendingFrame(ms(-1)))

    // 二重に積むと、`consumeWarmup` が末尾の 1 つ手前として食わせてしまい、
    // 待たせていたフレームの検知結果が画面へ出ない。
    expect(out.map((p) => p.dataTimeMs)).toEqual([ms(-2), ms(-1)])
  })

  it('空の待ち行列にも積める', () => {
    const out = pushPendingFrame([], pendingFrame(ms(0)))

    expect(out.map((p) => p.dataTimeMs)).toEqual([ms(0)])
  })
})
