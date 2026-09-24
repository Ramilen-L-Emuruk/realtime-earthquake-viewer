import { describe, expect, it } from 'vitest'

import { LogThrottle, suppressedSuffix } from './logThrottle'

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
}

describe('LogThrottle', () => {
  it('初めての鍵はそのまま出す', () => {
    const t = clock()
    const throttle = new LogThrottle({ intervalMs: 1000, now: t.now })

    expect(throttle.shouldLog('read', 'a')).toEqual({ suppressed: 0 })
  })

  it('間隔の中は抑え、次に出すとき抑えた件数を添える', () => {
    const t = clock()
    const throttle = new LogThrottle({ intervalMs: 1000, now: t.now })
    throttle.shouldLog('read', 'a')

    expect(throttle.shouldLog('read', 'a')).toBeNull()
    expect(throttle.shouldLog('read', 'a')).toBeNull()

    t.advance(1000)
    // **黙らせない。** 抑えた件数を添えるので、行を読んだ人が件数を取り違えない。
    expect(throttle.shouldLog('read', 'a')).toEqual({ suppressed: 2 })
    // 出したら数え直す。
    t.advance(1000)
    expect(throttle.shouldLog('read', 'a')).toEqual({ suppressed: 0 })
  })

  it('同じ種別でも細目が違えば独立して数える', () => {
    const t = clock()
    const throttle = new LogThrottle({ intervalMs: 1000, now: t.now })
    throttle.shouldLog('read', 'a')

    expect(throttle.shouldLog('read', 'b')).toEqual({ suppressed: 0 })
    expect(throttle.shouldLog('read', 'a')).toBeNull()
  })

  it('細目が入れ替わり続けても、行の量が間隔ぶんで頭打ちになる', () => {
    const t = clock()
    const throttle = new LogThrottle({ intervalMs: 1000, maxKeysPerKind: 2, now: t.now })
    throttle.shouldLog('read', 'a')
    throttle.shouldLog('read', 'b')

    // 上限を超えた細目はその種別の共有枠へ倒れる。**古い鍵を捨てる形（LRU）だと、
    // 捨てた鍵が毎回「初めて」に戻って 1 件ごとに行が出る**（間引きたいのがまさに
    // その形なので逆立ちする）。
    let emitted = 0
    for (let i = 0; i < 500; i += 1) {
      if (throttle.shouldLog('read', `spoofed-${i}`) !== null) emitted += 1
    }
    expect(emitted).toBe(1)

    // 間隔を過ぎれば共有枠からも出る。**黙り続けることはない。**
    t.advance(1000)
    expect(throttle.shouldLog('read', 'spoofed-999')).toEqual({ suppressed: 499 })
  })

  it('ある種別が枠を使い切っても、別の種別の「初めて」は必ず出る', () => {
    const t = clock()
    const throttle = new LogThrottle({ intervalMs: 60_000, maxKeysPerKind: 2, now: t.now })

    // 送信元アドレスを含む鍵は相手が決める値なので際限なく増える。
    for (let i = 0; i < 500; i += 1) throttle.shouldLog('read', `192.168.0.${i}|header-unreadable`)

    // **枠を種別ごとに分けていないと、ここが共有の溢れ先へ合流して 1 行も出ない。**
    // いちばん注意が要る場面（大量の異常が来ている最中）で、いちばん重要な報せ
    // ＝締めくくりの失敗が黙ることになる。
    expect(throttle.shouldLog('close', 'mac:AA:BB:CC:DD:EE:01')).toEqual({ suppressed: 0 })
    expect(throttle.shouldLog('evict', 'mac:AA:BB:CC:DD:EE:02')).toEqual({ suppressed: 0 })
  })

  it('上限に達する前の細目は、その後も自分の枠で数える', () => {
    const t = clock()
    const throttle = new LogThrottle({ intervalMs: 1000, maxKeysPerKind: 2, now: t.now })
    throttle.shouldLog('read', 'a')
    throttle.shouldLog('read', 'b')
    for (let i = 0; i < 10; i += 1) throttle.shouldLog('read', `x-${i}`)

    t.advance(1000)
    expect(throttle.shouldLog('read', 'a')).toEqual({ suppressed: 0 })
  })

  it('時計が非有限になっても間引きは効き続ける', () => {
    let t = 0
    let broken = false
    const throttle = new LogThrottle({ intervalMs: 1000, now: () => (broken ? Number.NaN : t) })
    throttle.shouldLog('read', 'a')
    broken = true

    // 非有限の値を素通りさせると `NaN < nextAtMs` が偽になり、**毎回そのまま出る**
    // ＝間引きが黙って効かなくなる。進まない時計として扱うので、抑えつつ数えは続ける。
    expect(throttle.shouldLog('read', 'a')).toBeNull()
    expect(throttle.shouldLog('read', 'a')).toBeNull()

    broken = false
    t = 1000
    // 時計が戻れば、壊れていた間に抑えた分も添えて出る。
    expect(throttle.shouldLog('read', 'a')).toEqual({ suppressed: 2 })
  })
})

describe('suppressedSuffix', () => {
  it('抑えていなければ何も添えない', () => {
    expect(suppressedSuffix({ suppressed: 0 })).toBe('')
  })

  it('抑えた件数を添える', () => {
    expect(suppressedSuffix({ suppressed: 3 })).toBe('（同じものをほか 3 件）')
  })
})
