// 公開観測点の波形の入れ物（`docs/public-waveform-design.md` §5.3・§5.4）。
import { describe, expect, it } from 'vitest'
import { PUBLIC_MEMBER_COUNT, PublicWaveBuffer } from './publicWaveBuffer'

const SENS = 1e9
/** 20 Hz・50 ms 刻み。 */
const RATE = 20

function counts(n: number, value: (i: number) => number = () => 1000): Int32Array {
  return Int32Array.from({ length: n }, (_, i) => value(i))
}

describe('PublicWaveBuffer', () => {
  // 正: カウントを感度で割って μm/s にし、窓の平均を引く。成分は東・北・上の並び。
  it('速度へ直し、直流を引いて成分ごとに置く', () => {
    const b = new PublicWaveBuffer(60)
    b.push('BHZ', 1000, RATE, counts(4, (i) => (i % 2 === 0 ? 2000 : 0)), SENS)
    const w = b.snapshot(null)!
    expect(w.msPerSample).toBe(50)
    expect(w.firstSampleMs).toBe(1000)
    // 2000 / 1e9 m/s = 2 μm/s。平均 1 を引いて ±1。
    expect(Array.from(w.gal[2])).toEqual([1, -1, 1, -1])
    // まだ届いていない成分は NaN（0 で埋めない）。
    expect(w.gal[0].every((v) => Number.isNaN(v))).toBe(true)
    expect(w.memberCount[0]).toBe(PUBLIC_MEMBER_COUNT)
  })

  // 正: 成分ごとに届く時刻がずれても、同じ時刻は同じ添字に並ぶ。右端は成分ごとに違ってよい。
  it('成分ごとにずれて届いても同じ時刻に揃う', () => {
    const b = new PublicWaveBuffer(60)
    b.push('BHE', 1000, RATE, counts(4, () => 1000), SENS)
    b.push('BHN', 1100, RATE, counts(4, () => 3000), SENS)
    const w = b.snapshot(null)!
    expect(w.gal[0].length).toBe(6)
    expect(Number.isFinite(w.gal[0][3])).toBe(true)
    expect(Number.isNaN(w.gal[0][4])).toBe(true)
    expect(Number.isNaN(w.gal[1][1])).toBe(true)
    expect(Number.isFinite(w.gal[1][2])).toBe(true)
    expect(b.lastSampleMs()).toBe(1250)
  })

  // 正: レコードの間の穴は NaN のまま（線を切る）。
  it('レコードの間の穴は NaN', () => {
    const b = new PublicWaveBuffer(60)
    b.push('BHZ', 1000, RATE, counts(2), SENS)
    b.push('BHZ', 1200, RATE, counts(2), SENS)
    const g = Array.from(b.snapshot(null)!.gal[2])
    expect(g.map((v) => Number.isNaN(v))).toEqual([false, false, true, true, false, false])
  })

  // 対照: 抱える長さより古い分は捨てる。写し始めより前は写さない。
  it('抱える長さより古い分を捨て、写し始めより前を写さない', () => {
    const b = new PublicWaveBuffer(1)
    b.push('BHZ', 0, RATE, counts(20), SENS)
    b.push('BHZ', 1000, RATE, counts(20), SENS)
    // 1 秒ぶん＋端の 1 サンプル（21 サンプル）を抱える。いちばん新しいのは 1950 ms。
    const w = b.snapshot(null)!
    expect(w.firstSampleMs).toBe(950)
    expect(w.gal[2].length).toBe(21)
    expect(b.push('BHZ', 0, RATE, counts(5), SENS).kind).toBe('too-old')
    expect(b.snapshot(1500)!.firstSampleMs).toBe(1500)
  })

  // 安全弁: 刻みの違うレコード・数でない値は置かない（黙って時刻を崩さない）。
  it('刻みの違うレコードと数でない値は置かない', () => {
    const b = new PublicWaveBuffer(60)
    b.push('BHZ', 1000, RATE, counts(2), SENS)
    expect(b.push('BHE', 1000, 40, counts(2), SENS).kind).toBe('rate-mismatch')
    expect(b.push('BHE', Number.NaN, RATE, counts(2), SENS).kind).toBe('invalid')
    expect(b.push('BHE', 1000, RATE, counts(2), 0).kind).toBe('invalid')
    expect(b.snapshot(null)!.gal[0].every((v) => Number.isNaN(v))).toBe(true)
  })

  it('何も無ければ null', () => {
    expect(new PublicWaveBuffer(60).snapshot(null)).toBeNull()
    expect(new PublicWaveBuffer(60).lastSampleMs()).toBeNull()
  })

  // 正: 再生中は先取りした分が先まで入っているので、再生時刻より後は写さない（平均も写した分だけで引く）。
  it('untilMs より後は写さない', () => {
    const b = new PublicWaveBuffer(60)
    for (const ch of ['BHE', 'BHN', 'BHZ'] as const) b.push(ch, 0, RATE, counts(40, (i) => (i < 20 ? 1000 : 9000)), SENS)
    const all = b.snapshot(null)!
    expect(all.gal[0].length).toBe(40)
    const cut = b.snapshot(null, { removeMean: true, untilMs: 19 * 50 })!
    expect(cut.gal[0].length).toBe(20)
    // 写した 20 点はすべて同じ値なので、平均を引けば 0
    expect(Math.abs(cut.gal[0][19])).toBeLessThan(1e-6)
  })

  // 正: 再生時刻（untilMs）までで最後に値のあるサンプルを返す。先取りで先まで入っていても、その先は見ない。
  // 対照: untilMs より前に値が無ければ null（先にだけあっても生きているとは数えない）。
  it('lastFiniteSampleMs は untilMs までで最後に値のある時刻を返す', () => {
    const b = new PublicWaveBuffer(60)
    b.push('BHZ', 1000, RATE, counts(10), SENS) // 1000〜1450
    b.push('BHZ', 3000, RATE, counts(10), SENS) // 3000〜3450（間は穴）
    expect(b.lastFiniteSampleMs(2000)).toBe(1450)
    expect(b.lastFiniteSampleMs(3100)).toBe(3100)
    expect(b.lastFiniteSampleMs(9999)).toBe(3450)
    expect(b.lastFiniteSampleMs(900)).toBeNull()
  })
})
