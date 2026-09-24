import { describe, expect, it } from 'vitest'

// **読み込むだけで待ち受けが開かないことも、この import が確かめている。**
// `main()` は「直接実行のときだけ走らせる」門の中にあるので、ここでは走らない
// （門が無ければ、このテストを走らせるたびに UDP の口が開く）。
import { buildWindowSummary, formatAt, readPort, windowSeconds } from './main'
import { PacketTally } from './src/receiver/packetTally'

describe('formatAt', () => {
  it('普通の時刻はそのまま出す', () => {
    // `toISOString()` は協定世界時。テストの時間帯（JST 固定）には引きずられない。
    expect(formatAt(1790181865671)).toBe('2026-09-23T16:44:25.671Z')
  })

  it('時刻として表せない値でも投げず、印を付けて返す', () => {
    // **投げると 1 件の失敗が他を巻き添えにする。** 出す側は 1 パケットぶんの震度を
    // まとめて回しており、その中には他の基板の締めくくりが混ざる。途中で投げれば
    // 残りは数えも出しもされないまま消える。
    for (const bad of [1e20, -1e20, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatAt(bad)).not.toThrow()
      expect(formatAt(bad)).toContain('時刻不正')
    }
  })
})

describe('readPort', () => {
  it('省略したら既定の口を使う', () => {
    expect(readPort(undefined)).toBe(50505)
    expect(readPort('')).toBe(50505)
  })

  it('10 進の値をそのまま使う', () => {
    expect(readPort('50505')).toBe(50505)
    expect(readPort('0')).toBe(0)
    expect(readPort('65535')).toBe(65535)
  })

  it('10 進でない表記は弾く', () => {
    // **`Number()` に任せると通ってしまう形。** `0x1F91` は 8081 として読めるので、
    // 打ち間違えに気づかないまま別の口で待ち受けることになる。
    expect(() => readPort('0x1F91')).toThrow(/読めない/)
    expect(() => readPort('1e3')).toThrow(/読めない/)
    expect(() => readPort('50505.0')).toThrow(/読めない/)
    expect(() => readPort(' 50505')).toThrow(/読めない/)
    expect(() => readPort('-1')).toThrow(/読めない/)
    expect(() => readPort('ポート')).toThrow(/読めない/)
  })

  it('範囲の外は別の文言で弾く', () => {
    // 書式は正しいので、打ち間違えの種類が違う。
    expect(() => readPort('70000')).toThrow(/範囲を超えている/)
  })
})

describe('buildWindowSummary', () => {
  const empty = new PacketTally().snapshotTotal()

  function withPacket(): ReturnType<PacketTally['snapshotTotal']> {
    const tally = new PacketTally()
    tally.record({ kind: 'received', source: '192.0.2.83' })
    return tally.snapshotTotal()
  }

  it('届かなかった窓は、続く間 1 度だけ伝える', () => {
    const first = buildWindowSummary({
      windowSec: 60,
      window: empty,
      evictedSources: 0,
      quietReported: false,
    })
    expect(first.lines).toEqual(['[集計] 直近 60 秒は 1 件も届いていない'])
    expect(first.quietReported).toBe(true)

    // 2 度目からは黙る。毎分同じ空の表を出すと記録が埋まる。
    const second = buildWindowSummary({
      windowSec: 60,
      window: empty,
      evictedSources: 0,
      quietReported: first.quietReported,
    })
    expect(second.lines).toEqual([])
    expect(second.quietReported).toBe(true)
  })

  it('届いたら印を降ろす（次に黙ったときまた伝わる）', () => {
    const summary = buildWindowSummary({
      windowSec: 60,
      window: withPacket(),
      evictedSources: 0,
      quietReported: true,
    })
    expect(summary.quietReported).toBe(false)
    expect(summary.lines).toEqual(['[集計] 直近 60 秒', '  送信元 192.0.2.83 届いた=1'])
  })

  it('送信元の枠を捨てた件数を添える', () => {
    const summary = buildWindowSummary({
      windowSec: 60,
      window: withPacket(),
      evictedSources: 3,
      quietReported: false,
    })
    expect(summary.lines.at(-1)).toBe('  送信元の枠を捨てた=3')
  })

  it('枠を捨てた件数は、行が空でも落とさない', () => {
    // **アドレスを詐称されると上限には一度も掛からず、ここだけが動く。**
    // 「届いた件数が 0 なら捨てようも無い」という呼び出し順の前提を要約の側が
    // 握っていると、順序を変えたときに黙って消える。
    const summary = buildWindowSummary({
      windowSec: 60,
      window: empty,
      evictedSources: 2,
      quietReported: false,
    })
    expect(summary.lines).toEqual(['[集計] 直近 60 秒', '  送信元の枠を捨てた=2'])
    expect(summary.quietReported).toBe(false)
  })
})

describe('windowSeconds', () => {
  it('実際に経った時間を秒で返す', () => {
    // **名目の間隔は約束であって実績ではない。** 詰まって伸びた窓を「直近 60 秒」と
    // 名乗ると、その窓の件数だけが実際より濃く見える。
    expect(windowSeconds(60_000, 60)).toBe(60)
    expect(windowSeconds(91_400, 60)).toBe(91)
  })

  it('測れなかったときは名目へ倒す', () => {
    // 「直近 0 秒」「直近 -3 秒」「直近 NaN 秒」と書くよりは名目のほうがまし。
    // どちらにせよ件数は正しい。
    expect(windowSeconds(0, 60)).toBe(1)
    expect(windowSeconds(-3_000, 60)).toBe(1)
    expect(windowSeconds(Number.NaN, 60)).toBe(60)
    expect(windowSeconds(Number.POSITIVE_INFINITY, 60)).toBe(60)
  })
})
