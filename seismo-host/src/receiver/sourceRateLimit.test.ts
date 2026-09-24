import { describe, expect, it } from 'vitest'

import { SourceRateLimit } from './sourceRateLimit'

const A = '192.0.2.83'
const B = '192.0.2.84'

/** 差し替えられる時計。 */
function clock(start = 0): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
    set: (ms) => {
      t = ms
    },
  }
}

/** 同じ瞬間に n 件投げて、通った数を返す。 */
function burst(limit: SourceRateLimit, source: string, n: number): number {
  let passed = 0
  for (let i = 0; i < n; i += 1) if (limit.allow(source)) passed += 1
  return passed
}

describe('SourceRateLimit', () => {
  it('瞬間の余裕までは通し、超えたら落とす', () => {
    const t = clock()
    const limit = new SourceRateLimit({ perSecond: 10, burst: 5, now: t.now })

    expect(burst(limit, A, 8)).toBe(5)
  })

  it('時間が経てば通る数が戻る', () => {
    const t = clock()
    const limit = new SourceRateLimit({ perSecond: 10, burst: 5, now: t.now })
    burst(limit, A, 5)
    expect(limit.allow(A)).toBe(false)

    // 10 件/秒 なので 300 ms で 3 件ぶん戻る。
    t.advance(300)
    expect(burst(limit, A, 5)).toBe(3)
  })

  it('黙っていても瞬間の余裕より多くは溜まらない', () => {
    const t = clock()
    const limit = new SourceRateLimit({ perSecond: 10, burst: 5, now: t.now })

    // 1 時間放っておいても、まとめて撃てるのは瞬間の余裕まで。
    t.advance(3_600_000)
    expect(burst(limit, A, 50)).toBe(5)
  })

  it('送信元ごとに独立して数える', () => {
    const t = clock()
    const limit = new SourceRateLimit({ perSecond: 10, burst: 3, now: t.now })
    burst(limit, A, 3)

    // 1 台の暴走が他の基板を落とさないことが、この仕組みの目的そのもの。
    expect(limit.allow(A)).toBe(false)
    expect(limit.allow(B)).toBe(true)
  })

  it('既定の上限は 1 台ぶん（毎秒 2.5 件）を桁で上回る', () => {
    const t = clock()
    const limit = new SourceRateLimit({ now: t.now })

    // 100 Hz・40 サンプルで 2.5 件/秒。10 秒ぶん流しても 1 件も落ちない。
    let dropped = 0
    for (let i = 0; i < 25; i += 1) {
      if (!limit.allow(A)) dropped += 1
      t.advance(400)
    }
    expect(dropped).toBe(0)
  })

  it('枠が満杯なら最も古いものを捨て、捨てた回数が読める', () => {
    const t = clock()
    const limit = new SourceRateLimit({ maxSources: 2, now: t.now })
    limit.allow('a')
    limit.allow('b')
    expect(limit.evictions).toBe(0)

    limit.allow('c')
    expect(limit.evictions).toBe(1)
    expect(limit.size).toBe(2)
  })

  it('捨てるのは「最後に使った順」で、使い続けている送信元は残る', () => {
    const t = clock()
    const limit = new SourceRateLimit({ perSecond: 1, burst: 1, maxSources: 2, now: t.now })
    limit.allow('a')
    limit.allow('b')
    // a を使い直すと、いちばん古いのは b になる。
    limit.allow('a')

    limit.allow('c')
    // b の枠が捨てられたので、b は新しい枠（満杯）から始まる。
    // a は残っているので、使い切った残量のまま落ちる。
    expect(limit.allow('a')).toBe(false)
    expect(limit.allow('b')).toBe(true)
  })

  it('時計が戻っても落とさない', () => {
    const t = clock(1_000_000)
    const limit = new SourceRateLimit({ perSecond: 10, burst: 5, now: t.now })
    limit.allow(A)

    // 時刻合わせで戻る。引き算をそのまま使うと残量が減って、正常な送り手を落とす。
    t.set(900_000)
    expect(burst(limit, A, 4)).toBe(4)
  })

  it('時計が非有限になっても上限は効き続ける', () => {
    let t = 0
    let broken = false
    const limit = new SourceRateLimit({
      perSecond: 10,
      burst: 5,
      now: () => (broken ? Number.NaN : t),
    })
    limit.allow(A)
    broken = true

    // **残量が NaN になると `NaN < 1` が偽になり、以後この送信元は一度も落ちなくなる**
    // ＝上限そのものが黙って効かなくなる。例外も記録も出ないので、通ったこと自体では
    // 気づけない。残りの 4 つが通り、その次で落ちることまで見て初めて効いていると言える。
    expect(burst(limit, A, 4)).toBe(4)
    expect(limit.allow(A)).toBe(false)
  })

  it('時計が壊れている間に初めて来た送信元でも、上限は効き続ける', () => {
    let t = 0
    let broken = true
    const limit = new SourceRateLimit({
      perSecond: 10,
      burst: 3,
      now: () => (broken ? Number.NaN : t),
    })

    // **枠を作るところにも同じ手当てが要る。** ここで NaN を入れておくと、
    // 時計が戻ったあとの引き算が NaN のままになり、その送信元だけ上限が外れる。
    expect(burst(limit, A, 3)).toBe(3)
    expect(limit.allow(A)).toBe(false)

    broken = false
    t = 1000
    expect(burst(limit, A, 3)).toBe(3)
    expect(limit.allow(A)).toBe(false)
  })

  it('時計が戻ったあとも上限は効き続ける（`lastMs` を汚さない）', () => {
    let t = 0
    let broken = false
    const limit = new SourceRateLimit({
      perSecond: 10,
      burst: 5,
      now: () => (broken ? Number.NaN : t),
    })
    burst(limit, A, 5)
    broken = true
    limit.allow(A)

    broken = false
    t = 1000
    // 壊れている間に `lastMs` へ NaN を書いていると、時計が戻っても引き算が NaN のまま
    // になり、上のテストと同じ「一度も落ちない」状態がそのまま居座る。
    expect(burst(limit, A, 5)).toBe(5)
    expect(limit.allow(A)).toBe(false)
  })
})
