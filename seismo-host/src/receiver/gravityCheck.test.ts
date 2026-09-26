import { describe, expect, it } from 'vitest'

import { GAL_PER_G, galFromCounts } from '../intensity/units'
import { GravityCheckBook } from './gravityCheck'
import type { GravityVerdict } from './gravityCheck'

const BOARD = 'mac:aa' as const
const STREAM = 'mac:aa|i2c0-68|boot1'

/**
 * 静止した基板の 1 パケットぶん。**重力は上下軸（3 本目）に乗る。**
 *
 * ばらつきは ±`swingGal` の交互で作る。**乱数を使わない** —— 合成の標準偏差が
 * ちょうど `swingGal` になるので、静止とみなす境目をテストにそのまま書ける。
 *
 * `factor` は換算の倍率の誤りを模す。**ばらつきとは独立に動かす** —— 実機では
 * 倍率が狂えばノイズも同じだけ狂うが、ここで連動させると「静止の判定」と
 * 「倍率の判定」のどちらが効いたのか切り分けられなくなる。
 */
function restGal(
  n: number,
  opts: { factor?: number; swingGal?: number } = {},
): readonly [readonly number[], readonly number[], readonly number[]] {
  const factor = opts.factor ?? 1
  const swing = opts.swingGal ?? 0
  const x: number[] = []
  const y: number[] = []
  const z: number[] = []
  for (let i = 0; i < n; i++) {
    x.push(0)
    y.push(0)
    z.push(GAL_PER_G * factor + (i % 2 === 0 ? swing : -swing))
  }
  return [x, y, z]
}

/** 時計を差し替えた帳面と、時計を進める手。 */
function book(options: { maxSensors?: number } = {}): {
  b: GravityCheckBook
  advance: (ms: number) => void
} {
  let nowMs = 1_700_000_000_000
  const b = new GravityCheckBook({ now: () => nowMs, maxSensors: options.maxSensors })
  return { b, advance: (ms) => (nowMs += ms) }
}

function wave(
  b: GravityCheckBook,
  gal: readonly [readonly number[], readonly number[], readonly number[]],
  over: { sensorId?: string; streamKey?: string } = {},
): GravityVerdict | null {
  return b.noteWave({
    boardKey: BOARD,
    sensorId: over.sensorId ?? 'i2c0-68',
    streamKey: over.streamKey ?? STREAM,
    gal,
  })
}

let seq = 0

/**
 * 窓を 1 つ閉じて、その判定を返す。
 *
 * **既定では呼ぶたびに別のセンサーを使う。** 窓を閉じる引き金になる 2 回目の波形は
 * 次の窓へ入るので、同じセンサーで続けて呼ぶとその残りが次の判定に混ざる
 * （静止した窓を 2 つ閉じたつもりが、2 つ目は「揺れていた」と出る）。
 */
function settleOne(
  b: GravityCheckBook,
  advance: (ms: number) => void,
  gal: readonly [readonly number[], readonly number[], readonly number[]],
  over: { sensorId?: string; streamKey?: string } = {},
): GravityVerdict {
  seq += 1
  const sensorId = over.sensorId ?? `s${seq}`
  const streamKey = over.streamKey ?? `${BOARD}|${sensorId}|boot1`
  wave(b, gal, { sensorId, streamKey })
  advance(30_000)
  const got = wave(b, restGal(300), { sensorId, streamKey })
  if (got === null) throw new Error('窓が閉じなかった')
  return got
}

describe('GravityCheckBook', () => {
  it('窓が満ちるまで判定は出ない', () => {
    const { b, advance } = book()

    expect(wave(b, restGal(300))).toBeNull()
    advance(29_999)
    expect(wave(b, restGal(300))).toBeNull()
    advance(1)
    expect(wave(b, restGal(300))).not.toBeNull()
  })

  it('静止した 1 g の窓は正常と出る', () => {
    const { b, advance } = book()

    const got = settleOne(b, advance, restGal(300, { swingGal: 1.5 }), { sensorId: 'i2c0-68' })

    expect(got.scale).toBe('ok')
    expect(got.meanGal).toBeCloseTo(GAL_PER_G, 6)
    expect(got.sdGal).toBeCloseTo(1.5, 6)
    expect(got.sampleCount).toBe(300)
    expect(got.boardKey).toBe(BOARD)
    expect(got.sensorId).toBe('i2c0-68')
  })

  it('倍率が小さすぎれば捕まえる（上限の検査では素通りする向き）', () => {
    // `../intensity/units.ts` の `galFromCounts` はフルスケールの上限しか見ないので、
    // 1000 分の 1 の誤りは 1 件ずつ見ても通ってしまう。**この向きがこの帳面の本題。**
    const { b, advance } = book()

    const got = settleOne(b, advance, restGal(300, { factor: 1 / 1000 }))

    expect(got.scale).toBe('too-small')
    expect(got.meanGal).toBeCloseTo(0.980665, 6)
  })

  it('フルスケールの申告ごと大きく名乗った 4 倍は捕まえる', () => {
    // **この値がここへ届くのは、名乗るフルスケールも一緒に大きいときだけ。**
    // 4 倍の合成 3922.7 gal は、±8 g を名乗っていれば `galFromCounts` の上限
    // （8 × 980.665 × 1.05 ＝ 8237.6 gal）を通る。±2 g のままなら上限は 2059.4 gal で、
    // **この帳面へ来る前にパケットごと捨てられる**（`intensityPipeline.ts` の
    // `scale-out-of-range`）。
    const { b, advance } = book()

    const got = settleOne(b, advance, restGal(300, { factor: 4 }))

    expect(got.scale).toBe('too-large')
  })

  it('実機で観測した個体差の幅では正常と出る', () => {
    // **手元の MPU6050 9 個の実測が 0.670〜1.232 g。** 合成の平均は倍率だけでなく
    // 0 点のずれでも動くので、ここを狭めると個体差が毎分の警告に化ける。
    // **この 2 件が幅の下限を決めている** —— 狭める変更はここで落ちる。
    const { b, advance } = book()

    expect(settleOne(b, advance, restGal(300, { factor: 0.67 })).scale).toBe('ok')
    expect(settleOne(b, advance, restGal(300, { factor: 1.232 })).scale).toBe('ok')
  })

  it('レンジの 2 倍の取り違えは捕まえられない（この検査の限界）', () => {
    // **個体差（最大 1.232 倍）と重なるので、捕まえにいくと正常な個体を警告する。**
    // この対照が無いと、あとから幅を狭めて偽陽性を作っても誰も気づかない。
    const { b, advance } = book()

    expect(settleOne(b, advance, restGal(300, { factor: 2 })).scale).toBe('ok')
  })

  it('揺れている窓では倍率を判定しない', () => {
    // **地震のときに誤って警告しないための門。** 合成の平均は揺れで必ず上がるので
    // （水平に 1000 gal の正弦波が乗れば 30 秒平均で 1200 gal ＝ 2 割増）、
    // 静止を確かめずに判定すると、いちばん見たい瞬間に「倍率が大きすぎる」と言い出す。
    const { b, advance } = book()

    const got = settleOne(b, advance, restGal(300, { swingGal: 10 }))

    expect(got.scale).toBe('not-at-rest')
    expect(got.sdGal).toBeCloseTo(10, 6)
  })

  it('サンプルが足りない窓は、正常とも異常とも言わない', () => {
    const { b, advance } = book()

    wave(b, restGal(10))
    advance(30_000)
    const got = wave(b, restGal(300))

    expect(got?.scale).toBe('too-few-samples')
    expect(got?.sampleCount).toBe(10)
  })

  it('静止しているのに震度が高ければ印を立てる', () => {
    // 平均引き（`demeanWindow`）を切ったまま自作センサーへ繋ぐと、静止していても
    // 計測震度 4.48〜6.23 が出続ける（実測）。値はすべて有限で範囲内なので、
    // **この突き合わせ以外のどの検査にも掛からない。**
    const { b, advance } = book()

    wave(b, restGal(300, { swingGal: 1.5 }))
    b.noteIntensity({ boardKey: BOARD, sensorId: 'i2c0-68', streamKey: STREAM, intensity: 5.1 })
    advance(30_000)
    const got = wave(b, restGal(300))

    expect(got?.restless).toBe(true)
    expect(got?.maxIntensity).toBe(5.1)
    expect(b.snapshot().restlessWindows).toBe(1)
  })

  it('静止していて震度も低ければ印は立たない', () => {
    const { b, advance } = book()

    wave(b, restGal(300, { swingGal: 1.5 }))
    b.noteIntensity({ boardKey: BOARD, sensorId: 'i2c0-68', streamKey: STREAM, intensity: 1.26 })
    advance(30_000)

    expect(wave(b, restGal(300))?.restless).toBe(false)
  })

  it('揺れている窓では震度が高くても印は立たない', () => {
    const { b, advance } = book()

    wave(b, restGal(300, { swingGal: 10 }))
    b.noteIntensity({ boardKey: BOARD, sensorId: 'i2c0-68', streamKey: STREAM, intensity: 5.1 })
    advance(30_000)

    expect(wave(b, restGal(300))?.restless).toBe(false)
  })

  it('別の流れの震度は採らない', () => {
    // 覚えの鍵は起動 ID を含まないので、**同じセンサーの古い起動セッション**の
    // 締めくくりも同じ入れ物へ届く（`sensorHealth.ts` と同じ穴）。
    const { b, advance } = book()

    wave(b, restGal(300, { swingGal: 1.5 }))
    b.noteIntensity({
      boardKey: BOARD,
      sensorId: 'i2c0-68',
      streamKey: 'mac:aa|i2c0-68|boot0',
      intensity: 5.1,
    })
    advance(30_000)
    const got = wave(b, restGal(300))

    expect(got?.maxIntensity).toBeNull()
    expect(got?.restless).toBe(false)
  })

  it('波形をまだ受けていないセンサーの震度は覚えない', () => {
    const { b } = book()

    b.noteIntensity({ boardKey: BOARD, sensorId: 'i2c1-68', streamKey: STREAM, intensity: 5.1 })

    expect(b.size).toBe(0)
  })

  it('数値にならない震度は採らない', () => {
    const { b, advance } = book()

    wave(b, restGal(300, { swingGal: 1.5 }))
    b.noteIntensity({ boardKey: BOARD, sensorId: 'i2c0-68', streamKey: STREAM, intensity: Number.NaN })
    b.noteIntensity({ boardKey: BOARD, sensorId: 'i2c0-68', streamKey: STREAM, intensity: 5.1 })
    advance(30_000)

    // **採ってしまうと `Math.max` が NaN へ倒れ、以後どの比較も偽になる** ——
    // 症状は「印が立たない」だけで、記録にも残らない。
    expect(wave(b, restGal(300))?.maxIntensity).toBe(5.1)
  })

  it('流れが変わったら窓を捨て、そのぶんの判定は出さない', () => {
    const { b, advance } = book()

    wave(b, restGal(300, { factor: 1 / 1000 }))
    advance(30_000)
    // 基板が再起動した。名乗る分解能ごと変わりうるので、前の窓と混ぜない。
    const got = wave(b, restGal(300), { streamKey: 'mac:aa|i2c0-68|boot2' })

    expect(got).toBeNull()
    expect(b.snapshot().mismatches).toBe(0)
    // **捨てたことを数える。** 窓より短い間隔で再起動を繰り返す基板は判定が一度も
    // 出ないので、ここを数えないと**どの数にも状態の口にも現れないまま黙る**。
    expect(b.snapshot().restarts).toBe(1)
  })

  it('初めて見たセンサーは、捨てた窓として数えない', () => {
    const { b } = book()

    wave(b, restGal(300))

    expect(b.snapshot().restarts).toBe(0)
  })

  it('窓より短い間隔で再起動を繰り返すと、判定は出ないが捨てた数だけが増える', () => {
    // **この帳面がいちばん静かに死ぬ形。** 電源が不安定な基板ほど診断が要るのに、
    // 窓を閉じないので `mismatches` にも `unjudged` にも状態の口にも出ない。
    const { b, advance } = book()

    for (let i = 0; i < 5; i++) {
      wave(b, restGal(300, { factor: 1 / 1000 }), { streamKey: `mac:aa|i2c0-68|boot${i}` })
      advance(10_000)
    }

    expect(b.snapshot().verdicts).toEqual([])
    expect(b.snapshot().mismatches).toBe(0)
    expect(b.snapshot().unjudged).toBe(0)
    expect(b.snapshot().restarts).toBe(4)
  })

  it('数値にならない値が混じったら、そう名乗る', () => {
    const { b, advance } = book()

    wave(b, [[Number.NaN], [0], [GAL_PER_G]])
    wave(b, restGal(300))
    advance(30_000)
    const got = wave(b, restGal(300))

    expect(got?.scale).toBe('unreadable')
    expect(got?.meanGal).toBeNull()
    expect(got?.sdGal).toBeNull()
    expect(b.snapshot().mismatches).toBe(1)
  })

  it('異常と、判定できなかったことを別々に数える', () => {
    const { b, advance } = book()

    settleOne(b, advance, restGal(300, { factor: 1 / 1000 }))
    settleOne(b, advance, restGal(300, { swingGal: 10 }))

    expect(b.snapshot().mismatches).toBe(1)
    expect(b.snapshot().unjudged).toBe(1)
  })

  it('覚えの上限に達したら、いちばん長く音沙汰の無いものを押し出す', () => {
    const { b } = book({ maxSensors: 2 })

    wave(b, restGal(10), { sensorId: 'a' })
    wave(b, restGal(10), { sensorId: 'b' })
    wave(b, restGal(10), { sensorId: 'c' })

    expect(b.size).toBe(2)
    expect(b.snapshot().evictions).toBe(1)
  })

  it('状態の口へは新しい判定から順に返す', () => {
    const { b, advance } = book()

    settleOne(b, advance, restGal(300), { sensorId: 'a', streamKey: 'a|1' })
    advance(1_000)
    settleOne(b, advance, restGal(300), { sensorId: 'b', streamKey: 'b|1' })

    const got = b.snapshot().verdicts
    expect(got.map((v) => v.sensorId)).toEqual(['b', 'a'])
  })

  it('まだ窓を 1 つも閉じていないセンサーは状態の口に出ない', () => {
    const { b } = book()

    wave(b, restGal(300))

    expect(b.size).toBe(1)
    expect(b.snapshot().verdicts).toEqual([])
  })
})

describe('手前の上限検査との関係', () => {
  /** 静止した基板の上下軸のカウント値。±2 g・61.0352 µg/LSB でちょうど 1 g。 */
  const REST_COUNTS = 16_384
  /** MPU6050 が名乗る分解能。 */
  const UG = 61.0352

  it('フルスケールが ±2 g のままなら、この帳面が大きすぎると言う手前で落ちる', () => {
    // **2 つの上限が重ならないことを固定する。** `galFromCounts` の上限は
    // 2 × 980.665 × 1.05 ＝ 2059.4 gal で、倍率が 2.1 倍に届いた時点で落ちる。
    // 一方この帳面が `too-large` と言うのは 3 倍から —— **間が空いているので、
    // ±2 g を名乗ったまま倍率だけ狂った値はここへ一度も届かない。**
    //
    // 片方の定数（`GAL_PER_G`・`FULL_SCALE_TOLERANCE`・`SCALE_RATIO_MAX`）だけを
    // 動かすとこの関係が黙って壊れるので、両方を通して確かめる。
    expect(galFromCounts(REST_COUNTS, { ugPerLsb: UG * 2.2, fullScaleG: 2 })).toBeNull()
    expect(galFromCounts(REST_COUNTS, { ugPerLsb: UG * 3, fullScaleG: 2 })).toBeNull()
  })

  it('フルスケールもそろって大きく名乗れば届き、大きすぎると出る', () => {
    const gal = galFromCounts(REST_COUNTS, { ugPerLsb: UG * 4, fullScaleG: 8 })
    expect(gal).not.toBeNull()

    const { b, advance } = book()
    const rest = (n: number): readonly [readonly number[], readonly number[], readonly number[]] => [
      new Array<number>(n).fill(0),
      new Array<number>(n).fill(0),
      new Array<number>(n).fill(gal as number),
    ]
    wave(b, rest(300), { sensorId: 'fs8', streamKey: 'fs8|1' })
    advance(30_000)

    expect(wave(b, rest(300), { sensorId: 'fs8', streamKey: 'fs8|1' })?.scale).toBe('too-large')
  })
})

describe('数え上げの受け渡し', () => {
  it('窓を何度か閉じたあと、数え上げが全部そろって出る', () => {
    // **`snapshot()` の欄の対応を、実際の帳面で確かめる。** ここが唯一の読み出し口に
    // なったので、`unjudged` へ別の数を入れるような取り違えを捕まえるのはこのテストだけ
    // —— 状態の口も要約も締めくくりも、この戻り値をそのまま使う。
    //
    // **5 つを互いに異なる数にする。** 3 つでも同じ数を持たせると、その 3 つのうち
    // どの 2 つを取り違えても通ってしまう（実際、`unjudged`・`restlessWindows`・
    // `evictions` を全部 1 にしていたところ、この 3 つの取り違えを検出できないと
    // 5 巡目の敵対的レビューで指摘された）。
    const { b, advance } = book({ maxSensors: 3 })

    settleOne(b, advance, restGal(300, { factor: 1 / 1000 }))
    settleOne(b, advance, restGal(300, { factor: 1 / 1000 })) // 倍率が合わない: 2

    settleOne(b, advance, restGal(300, { swingGal: 10 })) // 揺れていて見送り: 1

    // 静止しているのに震度が高い窓を 3 つ作る。**覚えの上限（3）に達しているので、
    // 新しいセンサーを 1 つ作るたびに 1 つ押し出す**（evictions も一緒に進む）。
    for (const sensorId of ['r1', 'r2', 'r3']) {
      const rest = { sensorId, streamKey: `${sensorId}|1` }
      wave(b, restGal(300, { swingGal: 1.5 }), rest)
      b.noteIntensity({ boardKey: BOARD, sensorId, streamKey: `${sensorId}|1`, intensity: 5.1 })
      advance(30_000)
      wave(b, restGal(300), rest)
    }
    // ここまでで restlessWindows: 3・evictions: 3

    // 押し出しだけをもう 1 回起こす（窓を閉じないので判定は増えない）。
    wave(b, restGal(300, { swingGal: 1.5 }), { sensorId: 'r4', streamKey: 'r4|1' })
    // evictions: 4

    // 起動が変わる。**初めて見たときは数えない**ので 6 回呼んで 5
    // （既存の 'r4' を使い回す —— 新しいセンサーだと evictions まで動いてしまう）。
    for (const boot of ['r4|2', 'r4|3', 'r4|4', 'r4|5', 'r4|6']) {
      wave(b, restGal(10), { sensorId: 'r4', streamKey: boot })
    }
    // restarts: 5

    expect(b.snapshot()).toMatchObject({
      mismatches: 2,
      unjudged: 1,
      restlessWindows: 3,
      restarts: 5,
      evictions: 4,
    })
  })
})
