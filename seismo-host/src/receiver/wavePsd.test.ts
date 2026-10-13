import { describe, expect, it } from 'vitest'

import {
  PSD_BIN_COUNT,
  PSD_BIN_EDGES_HZ,
  PSD_HOP,
  PSD_NFFT,
  type PsdChunk,
  columnPsd,
  columnPsdAsync,
  intervalPsd,
  minutePsd,
  segmentHalfSpanMs,
  welchPsd,
} from './wavePsd'

const T0 = Date.parse('2026-10-07T03:00:00.000Z')
const FS = 100
const MS = 1000 / FS

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** 正規分布に近い乱数（12 個の一様乱数の和）。分散 1。 */
function gaussian(r: () => number): number {
  let s = 0
  for (let i = 0; i < 12; i += 1) s += r()
  return s - 6
}

function sine(n: number, hz: number, amp: number, offset = 0): Float64Array {
  return Float64Array.from({ length: n }, (_, i) => offset + amp * Math.sin((2 * Math.PI * hz * i) / FS))
}

/** 区画ごとの PSD を周波数で積分したもの（＝分散の推定）。 */
function integrate(power: ArrayLike<number>): number {
  let s = 0
  for (let b = 0; b < PSD_BIN_COUNT; b += 1) {
    const p = power[b]!
    if (Number.isFinite(p)) s += p * (PSD_BIN_EDGES_HZ[b + 1]! - PSD_BIN_EDGES_HZ[b]!)
  }
  return s
}

function binOf(hz: number): number {
  for (let b = 0; b < PSD_BIN_COUNT; b += 1) if (hz >= PSD_BIN_EDGES_HZ[b]! && hz < PSD_BIN_EDGES_HZ[b + 1]!) return b
  return -1
}

describe('PSD_BIN_EDGES_HZ', () => {
  it('0.1〜50 Hz を対数で等分する', () => {
    expect(PSD_BIN_EDGES_HZ).toHaveLength(PSD_BIN_COUNT + 1)
    expect(PSD_BIN_EDGES_HZ[0]).toBeCloseTo(0.1, 9)
    expect(PSD_BIN_EDGES_HZ[PSD_BIN_COUNT]).toBeCloseTo(50, 9)
    const r0 = PSD_BIN_EDGES_HZ[1]! / PSD_BIN_EDGES_HZ[0]!
    const r1 = PSD_BIN_EDGES_HZ[30]! / PSD_BIN_EDGES_HZ[29]!
    expect(r1).toBeCloseTo(r0, 9)
  })
})

describe('welchPsd', () => {
  it('正弦波の力はその周波数の区画に集まり、積分すると分散（振幅²/2）に戻る', () => {
    const x = sine(6000, 5, 3, 16384) // 直流（重力のつもり）が乗っていても効かない
    const got = welchPsd(x, FS)
    expect(got.segments).toBe(Math.floor((6000 - PSD_NFFT) / PSD_HOP) + 1)
    let peak = 0
    for (let b = 1; b < PSD_BIN_COUNT; b += 1) if (got.power[b]! > got.power[peak]!) peak = b
    expect(peak).toBe(binOf(5))
    expect(integrate(got.power) / (9 / 2)).toBeGreaterThan(0.9)
    expect(integrate(got.power) / (9 / 2)).toBeLessThan(1.1)
  })

  it('白色雑音の PSD は平らで、片側 PSD ＝ 2σ²/fs になる', () => {
    const r = seeded(7)
    const x = Float64Array.from({ length: 60_000 }, () => 2 * gaussian(r))
    const got = welchPsd(x, FS)
    const expected = (2 * 4) / FS
    // 低い区画は FFT の線が 1 本未満しか入らずばらつくので、1 Hz から上を見る
    for (let b = binOf(1); b < binOf(45); b += 1) {
      expect(got.power[b]! / expected).toBeGreaterThan(0.75)
      expect(got.power[b]! / expected).toBeLessThan(1.25)
    }
  })

  it('ナイキスト周波数より上の区画は NaN（測れない）', () => {
    const got = welchPsd(sine(4096, 1, 1), 40) // 40 Hz で取ればナイキストは 20 Hz
    expect(got.power[binOf(30)]).toBeNaN()
    expect(Number.isFinite(got.power[binOf(10)]!)).toBe(true)
  })

  it('1 区間に満たない長さでは区間 0・すべて NaN', () => {
    const got = welchPsd(sine(PSD_NFFT - 1, 5, 1), FS)
    expect(got.segments).toBe(0)
    expect(Array.from(got.power).every((p) => Number.isNaN(p))).toBe(true)
  })
})

function chunks(x: Float64Array, startMs: number, per: number, msPerSample = MS): Array<{ firstSampleMs: number; msPerSample: number; values: Float64Array }> {
  const out = []
  for (let i = 0; i < x.length; i += per) {
    out.push({ firstSampleMs: startMs + i * msPerSample, msPerSample, values: x.subarray(i, Math.min(x.length, i + per)) })
  }
  return out
}

describe('minutePsd', () => {
  it('短いまとまり（レコード 5 秒ぶん）を繋いで、1 分ごとに Welch で平均する', () => {
    const x = sine(2 * 6000, 5, 2)
    const got = minutePsd(chunks(x, T0, 500))
    expect(got).not.toBeNull()
    expect(got!.firstMinute).toBe(T0 / 60_000)
    expect(got!.segments).toHaveLength(2)
    // 区間は中心の時刻でその分へ入れる。2 分ぶんの区間の総数は 1 本に繋げたときと同じ。
    expect(got!.segments[0]! + got!.segments[1]!).toBe(Math.floor((12_000 - PSD_NFFT) / PSD_HOP) + 1)
    const minute0 = got!.power.subarray(0, PSD_BIN_COUNT)
    expect(integrate(minute0) / 2).toBeGreaterThan(0.9)
    expect(integrate(minute0) / 2).toBeLessThan(1.1)
  })

  it('欠けを跨いで区間を作らない（届かなかった間を詰めると偽の周波数が出る）', () => {
    const a = sine(3000, 5, 1)
    const b = sine(3000, 5, 1)
    // 30 秒ぶん、10 秒空けてもう 30 秒ぶん。
    const got = minutePsd([...chunks(a, T0, 500), ...chunks(b, T0 + 40_000, 500)])!
    const perRun = Math.floor((3000 - PSD_NFFT) / PSD_HOP) + 1
    let total = 0
    for (const s of got.segments) total += s
    expect(total).toBe(perRun * 2)
  })

  it('名乗る刻みより実際の刻みが少し速くても（実測 0.16%）、レコードの継ぎ目を欠けと取り違えない', () => {
    // 5 秒（500 点）のレコードが、公称 10 ms・実際 9.984 ms で並ぶ。継ぎ目は公称で見積もった
    // 終わりより 8 ms 手前に来る。
    const x = sine(6000, 5, 1)
    const cs = []
    for (let i = 0; i < 12; i += 1) {
      cs.push({ firstSampleMs: T0 + i * 500 * 9.984, msPerSample: 10, values: x.subarray(i * 500, (i + 1) * 500) })
    }
    const got = minutePsd(cs)!
    let total = 0
    for (const s of got.segments) total += s
    expect(total).toBe(Math.floor((6000 - PSD_NFFT) / PSD_HOP) + 1)
  })

  it('パケット 1 つぶん（0.3 秒）の欠けでは繋がない', () => {
    const x = sine(3000, 5, 1)
    const cs = [
      { firstSampleMs: T0, msPerSample: 10, values: x.subarray(0, 1500) },
      { firstSampleMs: T0 + 15_000 + 300, msPerSample: 10, values: x.subarray(1500) },
    ]
    const got = minutePsd(cs)!
    let total = 0
    for (const s of got.segments) total += s
    expect(total).toBe((Math.floor((1500 - PSD_NFFT) / PSD_HOP) + 1) * 2)
  })

  it('刻みが変わったら繋がない', () => {
    const a = sine(3000, 5, 1)
    const b = sine(3000, 5, 1)
    const got = minutePsd([
      ...chunks(a, T0, 500, 10),
      ...chunks(b, T0 + 30_000, 500, 5),
    ])!
    let total = 0
    for (const s of got.segments) total += s
    const runA = Math.floor((3000 - PSD_NFFT) / PSD_HOP) + 1
    const runB = Math.floor((3000 - PSD_NFFT) / PSD_HOP) + 1
    expect(total).toBe(runA + runB)
  })

  it('順番が前後して渡されても、時刻で並べてから繋ぐ', () => {
    const x = sine(6000, 5, 1)
    const cs = chunks(x, T0, 500)
    cs.reverse()
    const got = minutePsd(cs)!
    expect(got.segments[0]).toBe(Math.floor((6000 - PSD_NFFT) / PSD_HOP) + 1)
  })

  it('区間を 1 つも作れない分は区間 0・NaN、何も作れなければ null', () => {
    expect(minutePsd(chunks(sine(500, 5, 1), T0, 500))).toBeNull()
    expect(minutePsd([])).toBeNull()
  })
})

describe('intervalPsd', () => {
  it('範囲に収まる区間だけで 1 本の PSD を作り、繋ぎ方は 1 分ごとの PSD と同じ', () => {
    const x = sine(6000, 5, 2)
    const got = intervalPsd(chunks(x, T0, 500), T0, T0 + 60_000)
    expect(got.segments).toBe(Math.floor((6000 - PSD_NFFT) / PSD_HOP) + 1)
    expect(integrate(got.power) / 2).toBeGreaterThan(0.9)
    expect(integrate(got.power) / 2).toBeLessThan(1.1)
  })

  it('範囲の頭が刻みの途中にあっても、半サンプルの丸めで端の区間を落とさない', () => {
    // 範囲の頭を 4 ms（刻み 10 ms の半分未満）ずらす。区間の頭のサンプルは範囲の頭より 4 ms 手前に来る
    const x = sine(6000, 5, 1)
    const got = intervalPsd(chunks(x, T0, 500), T0 + 4, T0 + 60_000)
    expect(got.segments).toBe(Math.floor((6000 - PSD_NFFT) / PSD_HOP) + 1)
  })

  it('範囲の端からはみ出す区間は使わない', () => {
    const x = sine(6000, 5, 1)
    // 範囲は先頭から 2 区間ぶん（1024 + 512 点）。3 本目の区間は末尾がはみ出す。
    const got = intervalPsd(chunks(x, T0, 500), T0, T0 + (PSD_NFFT + PSD_HOP) * MS)
    expect(got.segments).toBe(2)
  })

  it('有限でない値を含む区間は使わず、何も作れなければ区間 0・NaN', () => {
    const x = sine(2048, 5, 1)
    x[100] = Number.NaN
    const got = intervalPsd(chunks(x, T0, 512), T0, T0 + 60_000)
    // 区間は 0・512・1024 点目からの 3 本。NaN（100 点目）を含むのは 1 本目だけなので、残るのは 2 本
    expect(got.segments).toBe(2)
    const none = intervalPsd([], T0, T0 + 1)
    expect(none.segments).toBe(0)
    expect(Array.from(none.power).every((v) => Number.isNaN(v))).toBe(true)
  })
})

describe('columnPsd', () => {
  it('列ごとに中心を等間隔に置いて区間を積み、範囲の外に中心がある区間は使わない（以前は送り 5.12 秒任せで列ごとに 1〜2 本とばらついた）', () => {
    // 60 秒ぶん・6 秒の列。送り（5.12 秒）を超えないよう、1 列を 2 つに分けて 1.5・4.5 秒目に中心を置く。
    // 区間（約 10 秒）が収まる中心は 5.12〜54.88 秒なので、12〜54 秒の 7 列に 2 本ずつ
    const x = sine(6000, 5, 2)
    const got = columnPsd(chunks(x, T0, 500), T0 + 12_000, T0 + 72_000, 6000)
    expect(got.firstColumn).toBe((T0 + 12_000) / 6000)
    expect(got.segments).toHaveLength(10)
    expect(got.segments.slice(0, 7)).toEqual([2, 2, 2, 2, 2, 2, 2])
    // 12 秒より前（範囲の外）の中心は使わない。54 秒以降は区間が記録の外へはみ出す
    expect(got.segments.slice(7)).toEqual([0, 0, 0])
    // 記録の無い末尾の列（66 秒以降）は区間 0・NaN
    expect(got.segments[9]).toBe(0)
    expect(Array.from(got.power[9]!).every((v) => Number.isNaN(v))).toBe(true)
    // 区間のある列は、周波数で積分すると分散（振幅 2 の正弦波で 2）に戻る
    expect(got.segments[0]).toBeGreaterThan(0)
    expect(integrate(got.power[0]!) / 2).toBeGreaterThan(0.9)
    expect(integrate(got.power[0]!) / 2).toBeLessThan(1.1)
  })

  it('列が区間の送り（約 5 秒）より細ければ、送りを列の幅まで縮めて、記録のある列を 1 本も空けない（以前は空いていた）', () => {
    // 60 秒ぶん・1 秒の列。区間（約 10 秒）の中心が届くのは 5.12〜54.88 秒
    const x = sine(6000, 5, 1)
    const got = columnPsd(chunks(x, T0, 500), T0, T0 + 60_000, 1000)
    expect(got.segments).toHaveLength(60)
    expect(got.segments.slice(6, 54).every((s) => s > 0)).toBe(true)
    // 区間の中心が届かない頭と末尾の列は 0（余分に読むのは呼び出し側の役目）
    expect(got.segments.slice(0, 5).every((s) => s === 0)).toBe(true)
    expect(got.segments.slice(55).every((s) => s === 0)).toBe(true)
    // 送りを縮めても、1 本の区間の PSD は変わらない（積分すると分散に戻る）
    expect(integrate(got.power[30]!) / 0.5).toBeGreaterThan(0.9)
    expect(integrate(got.power[30]!) / 0.5).toBeLessThan(1.1)
  })

  it('列が送りより広ければ、送りは半分重ねのまま（区間の数は Welch と同じ）', () => {
    const x = sine(6000, 5, 1)
    const got = columnPsd(chunks(x, T0, 500), T0, T0 + 60_000, 30_000)
    expect(got.segments.reduce((a, b) => a + b, 0)).toBe(Math.floor((6000 - PSD_NFFT) / PSD_HOP) + 1)
  })

  it('長く繋いだ走りの後ろの 0.3 秒の欠けも欠けとして扱い、またぐ区間を使わない（継ぎ目の許容は長さに比例させきらない）', () => {
    // 合成波形を繋いだ形: 120 秒の走り、0.3 秒（1 まとまりぶん）欠けて、次の 120 秒の走り
    const a = sine(12_000, 5, 1)
    const b = sine(12_000, 5, 1)
    const got = columnPsd(
      [
        { firstSampleMs: T0, msPerSample: MS, values: a },
        { firstSampleMs: T0 + 120_300, msPerSample: MS, values: b },
      ],
      T0,
      T0 + 240_300,
      1000,
    )
    // 欠けをまたぐ区間（約 10 秒）の中心が入る列は空く
    expect(got.segments[120]).toBe(0)
    expect(got.segments.slice(116, 124).every((s) => s === 0)).toBe(true)
    // 欠けから離れた列は埋まる
    expect(got.segments[60]).toBeGreaterThan(0)
    expect(got.segments[180]).toBeGreaterThan(0)
  })

  it('長い走りの継ぎ目の許容は約 0.1 秒で頭打ち: 60 ms の隙間は繋ぎ、150 ms の隙間は繋がない', () => {
    const across = (gapMs: number): number[] => {
      const got = columnPsd(
        [
          { firstSampleMs: T0, msPerSample: MS, values: sine(12_000, 5, 1) },
          { firstSampleMs: T0 + 120_000 + gapMs, msPerSample: MS, values: sine(12_000, 5, 1) },
        ],
        T0,
        T0 + 240_000 + gapMs,
        1000,
      )
      return got.segments.slice(116, 124)
    }
    expect(across(60).every((s) => s > 0)).toBe(true)
    expect(across(150).every((s) => s === 0)).toBe(true)
  })

  it('対照: 欠けの無い長い走りどうしは継ぎ目をまたいで区間を使う', () => {
    const a = sine(12_000, 5, 1)
    const b = sine(12_000, 5, 1)
    const got = columnPsd(
      [
        { firstSampleMs: T0, msPerSample: MS, values: a },
        { firstSampleMs: T0 + 120_000, msPerSample: MS, values: b },
      ],
      T0,
      T0 + 240_000,
      1000,
    )
    expect(got.segments.slice(116, 124).every((s) => s > 0)).toBe(true)
  })

  it('列の幅が刻みより細くても、送りは 1 サンプルより縮めない', () => {
    const x = sine(2048, 5, 1)
    const got = columnPsd(chunks(x, T0, 512), T0, T0 + 20_480, 5)
    // 送り 1 サンプル ＝ 区間の数は (2048 − 1024) / 1 + 1
    expect(got.segments.reduce((a, b) => a + b, 0)).toBe(2048 - PSD_NFFT + 1)
  })
})

/**
 * 名乗る刻み（10 ms）と実際の刻みがずれた長い走り。5 秒（500 点）のレコードを、実際の刻み `realMs` で並べる。
 * レコードの頭の時刻は実時刻（ホストが時間軸の当てはめで付ける）。`jitterMs` は継ぎ目ごとに頭を ± に揺らす幅。
 */
function driftingRecords(x: Float64Array, realMs: number, jitterMs = 0): PsdChunk[] {
  const out: PsdChunk[] = []
  for (let i = 0; i * 500 < x.length; i += 1) {
    const jitter = i === 0 ? 0 : i % 2 === 0 ? jitterMs : -jitterMs
    out.push({ firstSampleMs: T0 + i * 500 * realMs + jitter, msPerSample: MS, values: x.subarray(i * 500, Math.min(x.length, (i + 1) * 500)) })
  }
  return out
}

/** 実時刻 `[fromS, toS)` 秒に当たるサンプルへ、振幅の大きい 10 Hz を足す。 */
function burstAt(x: Float64Array, realMs: number, fromS: number, toS: number): void {
  for (let i = 0; i < x.length; i += 1) {
    const t = (i * realMs) / 1000
    if (t >= fromS && t < toS) x[i] = x[i]! + 50 * Math.sin((2 * Math.PI * 10 * t))
  }
}

describe('区間を置く時刻は実時刻（#742）', () => {
  // 実際の刻み 10.04 ms（99.6 Hz。実機の MPU6050 で 99.585 Hz を測った）。2 時間の走りで、名乗る刻みで数えた添字の
  // 時刻は実時刻より約 29 秒手前へずれる。
  const REAL_MS = 10.04
  const N = 720_000

  it('正: 長い走りでも、区間は実時刻の分へ入る（名乗る刻みで数えると 1 つ前の分へずれていた）', () => {
    const r = seeded(11)
    const x = Float64Array.from({ length: N }, () => 0.1 * gaussian(r))
    // 実時刻 7085〜7115 秒（T0 から 118 分目 ＝ 7080〜7140 秒の中）に揺れを置く。名乗る刻みで数えると
    // 7056〜7086 秒に見え、117 分目（7020〜7080 秒）へ入ってしまう。
    burstAt(x, REAL_MS, 7085, 7115)
    const got = minutePsd(driftingRecords(x, REAL_MS))!
    const minute = (k: number): number => T0 / 60_000 + k - got.firstMinute
    const at10 = (k: number): number => got.power[minute(k) * PSD_BIN_COUNT + binOf(10)]!
    expect(at10(118) / at10(110)).toBeGreaterThan(100)
    expect(at10(117) / at10(110)).toBeLessThan(3)
  })

  it('正: スペクトログラムの列も実時刻で割り付ける', () => {
    const r = seeded(12)
    const x = Float64Array.from({ length: N }, () => 0.1 * gaussian(r))
    burstAt(x, REAL_MS, 7085, 7115)
    const got = columnPsd(driftingRecords(x, REAL_MS), T0 + 7000_000, T0 + 7200_000, 10_000)
    const col = (s: number): number => (T0 + s * 1000) / 10_000 - got.firstColumn
    const at10 = (s: number): number => got.power[col(s)]![binOf(10)]!
    // 7090〜7100 秒の列は揺れの真ん中、7050〜7060 秒の列（名乗る刻みならここに揺れが見えた）は静か
    expect(at10(7090) / at10(7180)).toBeGreaterThan(100)
    expect(at10(7050) / at10(7180)).toBeLessThan(3)
  })

  it('安全弁: 実際の刻みが名乗りより遅く、継ぎ目が ±10 ms 揺れても、1 秒の列は 1 本も空かない', () => {
    // 10 分。区間の中心が届かない頭と末尾の 6 秒ずつを除けば、どの列にも区間が入る。送りを名乗りの刻み
    // （100 点 ＝ 1000 ms）で数えると、実時刻では 1005 ms ＋継ぎ目の揺れになり、ときどき列を飛び越す。
    // 揺れは繋ぎの許容（約 55 ms）に収まる幅にする（実際の刻みの遅れで継ぎ目ごとに 25 ms 後ろへずれる）。
    const x = sine(60_000, 5, 1)
    const got = columnPsd(driftingRecords(x, 10.05, 10), T0 + 6000, T0 + 594_000, 1000)
    expect(got.segments.every((s) => s > 0)).toBe(true)
  })

  it('安全弁: 範囲の頭・末尾が列の境目に揃っていなくても、端の列は範囲に入る部分へ中心を置いて空けない', () => {
    // 60 秒ぶん・10 秒の列。範囲は 18.5〜41.5 秒。列を 2 つに分けて置く中心（12.5・17.5 秒、42.5・47.5 秒）は、
    // 頭の列（10〜20 秒）も末尾の列（40〜50 秒）も両方とも範囲の外に来る
    const x = sine(6000, 5, 1)
    const got = columnPsd(chunks(x, T0, 500), T0 + 18_500, T0 + 41_500, 10_000)
    expect(got.segments).toHaveLength(4)
    expect(got.segments.every((s) => s > 0)).toBe(true)
  })

  it('対照: 名乗りと実際の刻みが同じ短い走りでは、1 分の区間の数は半分重ねの Welch と同じ', () => {
    const x = sine(6000, 5, 1)
    expect(minutePsd(chunks(x, T0, 500))!.segments[0]).toBe(welchPsd(x, FS).segments)
  })

  it('対照: 1 分の列のスペクトログラムは 1 分ごとの PSD と同じ区間で作る（生データ⇔1 分 PSD の境目で段差を作らない）', () => {
    const r = seeded(13)
    const x = Float64Array.from({ length: 36_000 }, () => gaussian(r))
    const cs = driftingRecords(x, REAL_MS)
    const minutes = minutePsd(cs)!
    const columns = columnPsd(cs, T0, T0 + 360_000, 60_000)
    for (let j = 0; j < columns.segments.length; j += 1) {
      const i = columns.firstColumn + j - minutes.firstMinute
      expect(columns.segments[j]).toBe(minutes.segments[i])
      for (let b = binOf(1); b < binOf(40); b += 1) {
        expect(columns.power[j]![b]).toBeCloseTo(minutes.power[i * PSD_BIN_COUNT + b]!, 6)
      }
    }
  })
})

describe('columnPsdAsync（#745）', () => {
  it('同期の columnPsd と同じ結果を返し、計算の途中で譲る', async () => {
    const x = sine(60_000, 5, 1)
    const cs = chunks(x, T0, 500)
    let pauses = 0
    const got = await columnPsdAsync(cs, T0, T0 + 600_000, 1000, {
      signal: new AbortController().signal,
      sliceMs: 0,
      pause: async () => {
        pauses += 1
      },
    })
    const sync = columnPsd(cs, T0, T0 + 600_000, 1000)
    expect(got.segments).toEqual(sync.segments)
    expect(got.power.map((p) => Array.from(p))).toEqual(sync.power.map((p) => Array.from(p)))
    expect(pauses).toBeGreaterThan(100)
  })

  it('譲っている間に中断されたら投げる（打ち切られた要求の計算を続けない）', async () => {
    const x = sine(60_000, 5, 1)
    const ac = new AbortController()
    let pauses = 0
    await expect(
      columnPsdAsync(chunks(x, T0, 500), T0, T0 + 600_000, 1000, {
        signal: ac.signal,
        sliceMs: 0,
        pause: async () => {
          pauses += 1
          if (pauses === 3) ac.abort()
        },
      }),
    ).rejects.toThrow()
    expect(pauses).toBe(3)
  })

  it('対照: 時間の予算内なら譲らない', async () => {
    const x = sine(6000, 5, 1)
    let pauses = 0
    await columnPsdAsync(chunks(x, T0, 500), T0, T0 + 60_000, 1000, {
      signal: new AbortController().signal,
      sliceMs: 60_000,
      pause: async () => {
        pauses += 1
      },
    })
    expect(pauses).toBe(0)
  })
})

describe('segmentHalfSpanMs（#743）', () => {
  it('区間の半分（512 点）を刻みから求め、名乗りと実際の刻みの差（1%）を見込む', () => {
    expect(segmentHalfSpanMs(10)).toBeGreaterThanOrEqual(5120)
    expect(segmentHalfSpanMs(10)).toBeLessThan(5200)
    expect(segmentHalfSpanMs(1000 / 104)).toBeLessThan(segmentHalfSpanMs(10))
    expect(segmentHalfSpanMs(20)).toBeGreaterThanOrEqual(10_240)
  })
})
