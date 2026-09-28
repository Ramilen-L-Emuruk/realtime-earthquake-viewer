import { afterEach, describe, expect, it, vi } from 'vitest'

import { IntensityStream } from '../intensity/intensityStream'
import type { BoardKey, SensorPacket } from '../protocol/types'
import { IntensityPipeline } from './intensityPipeline'
import type { WaveChunk } from './intensityPipeline'
import { SensorFusion } from './sensorFusion'
import type { FusedWaveChunk, FusionOutcome, StationIntensityReading } from './sensorFusion'
import { StationDirectory } from './stationConfig'
import type { StationConfig } from './stationConfig'

const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const

const BASE_MS = 1790181865671
const HZ = 100
const MS_PER_SAMPLE = 1000 / HZ

/**
 * 裏付けの到着を待たせない指定。**「1 まとまり流したら即合成」を見るテスト用。**
 *
 * 既定（`FUSION_WAIT_MS_DEFAULT` = 300ms）のままだと、まとまりを 1 つ流しただけでは
 * 待ちが満たされず合成が起きない。**待ちそのものの検証は別のテストが持つ**
 * （「裏付けを待って顔ぶれを揃える」）——こちらを 0 にしておけば、待ちと
 * 重み付き平均・差分・流し込みの検証を独立に読める。
 */
const NO_WAIT = { waitMs: 0 }

const BOARD_A: BoardKey = 'mac:aaaaaaaaaaaa'
const BOARD_B: BoardKey = 'mac:bbbbbbbbbbbb'
const BOARD_C: BoardKey = 'mac:cccccccccccc'
const BOARD_D: BoardKey = 'mac:dddddddddddd'

/** 観測点 1 つに 2 センサーを割り当てた設定。ノイズ密度・enabled を差し替えられる。 */
function twoSensorConfig(
  a: { noiseDensity: number | null; enabled?: boolean },
  b: { noiseDensity: number | null; enabled?: boolean },
): StationConfig {
  return {
    stations: [{ stationId: 'home', displayName: '自宅', lat: 35.6, lon: 139.7 }],
    boards: [
      {
        boardKey: BOARD_A,
        stationId: 'home',
        sensors: [
          {
            sensorId: 'sensorA',
            enabled: a.enabled ?? true,
            rotation: IDENTITY,
            offset: [0, 0, 0],
            sensitivity: [1, 1, 1],
            noiseDensity: a.noiseDensity,
          },
        ],
      },
      {
        boardKey: BOARD_B,
        stationId: 'home',
        sensors: [
          {
            sensorId: 'sensorB',
            enabled: b.enabled ?? true,
            rotation: IDENTITY,
            offset: [0, 0, 0],
            sensitivity: [1, 1, 1],
            noiseDensity: b.noiseDensity,
          },
        ],
      },
    ],
  }
}

function wave(over: Partial<WaveChunk> & { boardKey: BoardKey; sensorId: string }): WaveChunk {
  const n = over.gal?.[0].length ?? 1
  return {
    streamKey: `${over.boardKey}|${over.sensorId}|boot1`,
    segmentId: 1,
    channels: ['HN1', 'HN2', 'HN3'],
    firstSampleIndex: 0,
    firstSampleMs: BASE_MS,
    msPerSample: MS_PER_SAMPLE,
    timebaseNominalReason: null,
    gal: [new Array(n).fill(0), new Array(n).fill(0), new Array(n).fill(0)],
    ...over,
  }
}

describe('SensorFusion.groupedStationIds', () => {
  it('正: 2 台とも有効なら、その観測点が含まれる', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    expect(fusion.groupedStationIds).toEqual(['home'])
  })

  it('対照: 2 台のうち 1 台が無効なら、有効なセンサーが 1 台だけになり含まれない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20, enabled: false }))
    expect(fusion.groupedStationIds).toEqual([])
  })

  it('安全弁: 割り当てが無い（空の設定）なら空配列', () => {
    const fusion = new SensorFusion({ stations: [], boards: [] })
    expect(fusion.groupedStationIds).toEqual([])
  })
})

describe('SensorFusion.ingest — グループ化と対象外の扱い', () => {
  it('対照: 観測点に割り当てが無いセンサーは合成の対象にならない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    const out = fusion.ingest(wave({ boardKey: BOARD_C, sensorId: 'lonely', gal: [[100], [0], [0]] }))
    expect(out.fusedWave).toBeNull()
    expect(out.pairDiffs).toEqual([])
    expect(out.readings).toEqual([])
  })

  it('安全弁: 観測点に 1 台しか割り当てが無ければ、その 1 台も合成対象にならない', () => {
    // home には sensorA だけ・sensorB は別観測点という体で、boards から sensorB を抜く。
    const config = twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 })
    const soloConfig: StationConfig = { ...config, boards: [config.boards[0]] }
    const fusion = new SensorFusion(soloConfig)
    const out = fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    expect(out.fusedWave).toBeNull()
  })

  it('安全弁: enabled:false のセンサーはグループに入らない（相方が居ないのと同じ扱いになる）', () => {
    const fusion = new SensorFusion(
      twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20, enabled: false }),
    )
    // sensorB（無効）を先に流しても素通り、sensorA（唯一の enabled）を流しても
    // グループが組めていないので合成は起きない。
    fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[50], [0], [0]] }))
    const out = fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    expect(out.fusedWave).toBeNull()
  })

  it('対照: 裏付け側（駆動役でない方）の到着では合成波形は出ない（覚えるだけ）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    // noiseDensity が低い sensorA が駆動役。sensorB（裏付け側）だけを流す。
    const out = fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[50], [0], [0]] }))
    expect(out.fusedWave).toBeNull()
    expect(out.pairDiffs).toEqual([])
  })
})

describe('SensorFusion.ingest — 重み付き平均と差分', () => {
  // **合成値は「直流を落とした変動分」なので、1 サンプルだけ流すと必ず 0 になる**
  // （そのサンプル自身が直流の推定になるため。`DcTracker` を見ること）。
  // 重みの計算はそのまま落とした直流のほうへ現れるので、**足し戻した値**
  // （`gal + dcGal` ＝ 落とす前の「校正済み gal の重み付き平均」）で確かめる。
  // 足し戻しが成り立つこと自体、下流（#315）が元の値を取り戻せる根拠になる。
  function restored(out: FusionOutcome, axis: number, i: number): number {
    const w = out.fusedWave
    if (w === null) throw new Error('合成波形が出ていない')
    return w.gal[axis][i] + w.dcGal[axis][i]
  }

  it('正: 駆動役だけが届いていれば、合成値は駆動役自身の値になる（memberCount=1）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    const out = fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    expect(restored(out, 0, 0)).toBeCloseTo(100, 9)
    expect(out.fusedWave?.memberCount).toEqual([1])
  })

  it('正: 両方届けば、重み（ノイズ密度の逆数分散）付きの平均になる', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    // 先に裏付け側（sensorB）を届ける。
    fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[50], [0], [0]] }))
    // 駆動役（sensorA、noiseDensity が低い）が届いて初めて合成が動く。
    const out = fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    // 重み: wA=1/10²=0.01, wB=1/20²=0.0025。
    // (0.01*100 + 0.0025*50) / (0.01+0.0025) = 1.125 / 0.0125 = 90
    expect(restored(out, 0, 0)).toBeCloseTo(90, 9)
    expect(out.fusedWave?.memberCount).toEqual([2])
  })

  it('正: ノイズ密度が片方でも未申告なら、グループ全体を単純平均へ倒す', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: null }, { noiseDensity: 100 }), NO_WAIT)
    fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[50], [0], [0]] }))
    const out = fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    // 単純平均: (100+50)/2 = 75
    expect(restored(out, 0, 0)).toBeCloseTo(75, 9)
  })

  it('正: 差分 d=(a1-a2)/2 を出す（メンバー順は設定の並び順）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    // **2 サンプル流す。** 差分も直流を落とした後の値から作るので、1 サンプルでは
    // 両方 0 になって式を確かめられない。
    // sensorB: [0, 0] → 直流を引いた後も [0, 0]（動いていない）。
    // sensorA: [0, 100] → 2 サンプル目の直流は (0+100)/2 = 50 なので 100-50 = 50。
    fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[0, 0], [0, 0], [0, 0]] }))
    const out = fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[0, 100], [0, 0], [0, 0]] }))
    expect(out.pairDiffs).toHaveLength(1)
    const d = out.pairDiffs[0]
    expect(d.memberA).toEqual({ boardKey: BOARD_A, sensorId: 'sensorA' })
    expect(d.memberB).toEqual({ boardKey: BOARD_B, sensorId: 'sensorB' })
    expect(d.diffGal[0][1]).toBeCloseTo((50 - 0) / 2, 9)
  })

  it('正: 取り付けの向き・感度のずれ（直流の差）は差分に現れない', () => {
    // **差分の用途はセンサー自己ノイズの推定と異常センサーの検出。** 実機では
    // 静止時の Z 軸が 662〜1200 gal に散っていて（感度が未校正）、落とさずに差を
    // とると**そのずれが差を支配して何も見分けられない**（#362）。
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    // 2 本の直流は 538 gal 違うが、どちらも動いていない。
    fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[0, 0], [0, 0], [662, 662]] }))
    const out = fusion.ingest(
      wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[0, 0], [0, 0], [1200, 1200]] }),
    )
    expect(out.pairDiffs[0].diffGal[2][1]).toBeCloseTo(0, 9)
  })

  it('安全弁: 裏付け側の値が時刻的に離れすぎていれば外挿せず、駆動役だけの値になる', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), NO_WAIT)
    // sensorB の 1 サンプルは 100 秒後の時刻を名乗る —— 駆動役の時刻からは大きく外れる。
    fusion.ingest(
      wave({
        boardKey: BOARD_B,
        sensorId: 'sensorB',
        firstSampleMs: BASE_MS + 100_000,
        gal: [[50], [0], [0]],
      }),
    )
    const out = fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    expect(restored(out, 0, 0)).toBeCloseTo(100, 9)
    expect(out.fusedWave?.memberCount).toEqual([1])
    expect(out.pairDiffs[0].diffGal[0][0]).toBeNull()
  })
})

describe('SensorFusion.ingest — 裏付けを待って顔ぶれを揃える（#362）', () => {
  /** 実機と同じ 1 まとまり 10 サンプル（100ms）。 */
  const CHUNK = 10
  /** 実機の基板間の起点差（実測 160ms まで）。 */
  const SKEW_B = 73
  const SKEW_C = 160

  function threeSensorConfig(): StationConfig {
    function entry(sensorId: string) {
      return {
        sensorId,
        enabled: true,
        rotation: IDENTITY,
        offset: [0, 0, 0] as const,
        sensitivity: [1, 1, 1] as const,
        noiseDensity: null,
      }
    }
    return {
      stations: [{ stationId: 'home', displayName: '自宅', lat: 35.6, lon: 139.7 }],
      boards: [
        { boardKey: BOARD_A, stationId: 'home', sensors: [entry('sensorA')] },
        { boardKey: BOARD_B, stationId: 'home', sensors: [entry('sensorB')] },
        { boardKey: BOARD_C, stationId: 'home', sensors: [entry('sensorC')] },
      ],
    }
  }

  function rows(n: number, v: number): [number[], number[], number[]] {
    return [new Array(n).fill(v), new Array(n).fill(v), new Array(n).fill(v)]
  }

  /**
   * 実機の到着の形（基板ごとに起点がずれる）で流し、混ざった本数を集める。
   *
   * `backupRounds` を絞ると「裏付けが途中で落ちた」形になる。
   */
  function run(waitMs: number, rounds: number, backupRounds = rounds): number[] {
    const fusion = new SensorFusion(threeSensorConfig(), { windowSec: 1, stepSec: 1, waitMs })
    const counts: number[] = []
    for (let c = 0; c < rounds; c++) {
      const at = c * CHUNK
      const outs = [
        fusion.ingest(
          wave({
            boardKey: BOARD_A,
            sensorId: 'sensorA',
            firstSampleIndex: at,
            firstSampleMs: BASE_MS + at * MS_PER_SAMPLE,
            gal: rows(CHUNK, 1),
          }),
        ),
      ]
      if (c < backupRounds) {
        for (const [boardKey, sensorId, skew] of [
          [BOARD_B, 'sensorB', SKEW_B],
          [BOARD_C, 'sensorC', SKEW_C],
        ] as const) {
          outs.push(
            fusion.ingest(
              wave({
                boardKey,
                sensorId,
                firstSampleIndex: at,
                firstSampleMs: BASE_MS + skew + at * MS_PER_SAMPLE,
                gal: rows(CHUNK, 1),
              }),
            ),
          )
        }
      }
      for (const out of outs) {
        if (out.fusedWave !== null) counts.push(...out.fusedWave.memberCount)
      }
    }
    return counts
  }

  it('正: 待てば 3 本とも混ざる（立ち上がりを過ぎれば顔ぶれが揺れない）', () => {
    // 実機（2026-09-28）では基板間の到着差が最大 173ms あった。**混ざった本数は
    // 状態の口に出ない**ので、その到着の形を写した台で測ると、待たずに合成した場合は
    // **9 本のうち 1〜7 本を揺れ動いた**（8000 サンプル中、9 本が揃った瞬間は 0 回）。
    const counts = run(300, 16)
    // **最初の数まとまりは揃わない。これは待ちでは直せない。** 裏付けの基板は
    // 駆動役より遅く起動しているので（実機の起点差は最大 160ms）、いちばん古い
    // 駆動役のまとまりを覆うサンプルをそもそも持っていない。
    const settled = new Set(counts.slice(CHUNK * 3))
    expect(settled).toEqual(new Set([3]))
  })

  it('対照: 待たなければ顔ぶれが揃わない（落ち着いた後も 3 本未満が混ざる）', () => {
    // **待ちが効いていることの裏取り。** これが {3} になってしまうなら、上の
    // テストは症状の条件を作れていない（待つ前から揃っていた）ことになる。
    const counts = run(0, 16).slice(CHUNK * 3)
    expect(counts.some((m) => m < 3)).toBe(true)
  })

  it('安全弁: 裏付けが途中で落ちても合成は止まらない（その時点の本数で続ける）', () => {
    // 前半だけ裏付けが届き、以後は駆動役だけ。**永久に待たない**こと——待ち続けると
    // 観測点の震度がその時点で止まり、理由も残らない。
    const counts = new Set(run(300, 16, 4))
    expect(counts.has(1)).toBe(true)
    expect(counts.size).toBeGreaterThan(1)
  })

  it('安全弁: 時刻が進まなくても、溜まりが上限に達したら待ちを切り上げる', () => {
    // **待ちの計時は届いたまとまりの時刻で行う**ので、時刻が進まない入力
    // （同じ `firstSampleMs` を名乗り続ける＝基板の時計が止まった形）では待ちが
    // 永久に満たされない。**溜め続けるとメモリが伸び、捨てると波形が消える**ので、
    // 上限（`MAX_HELD_CHUNKS`）で切り上げてその時点の顔ぶれで合成する。
    const fusion = new SensorFusion(threeSensorConfig(), { windowSec: 1, stepSec: 1, waitMs: 300 })
    let fused = 0
    // 位置だけ進めて時刻は据え置く。上限（32）を超えるまで送る。
    for (let c = 0; c < 40; c++) {
      const out = fusion.ingest(
        wave({
          boardKey: BOARD_A,
          sensorId: 'sensorA',
          firstSampleIndex: c * CHUNK,
          firstSampleMs: BASE_MS,
          gal: rows(CHUNK, 1),
        }),
      )
      if (out.fusedWave !== null) fused++
    }
    // 切り上げが無ければ 1 度も合成されない（待ちが永久に満たされないため）。
    expect(fused).toBeGreaterThan(0)
    // **上限を超えた分だけが出る。** 40 回送って上限 32 なら、出るのは 8 回前後。
    // 全部出ていたら待ちそのものが効いていない。
    expect(fused).toBeLessThan(40)
  })

  it('安全弁: 駆動役が止まっても裏付けのキャッシュは頭打ちになる', () => {
    // 裏付けだけが届き続ける形（駆動役の基板が落ちた）。**`trimCache` は保留の
    // 進みでしか捨てない**ので、駆動役が来なければ捨てる契機が無い —— 上限
    // （`MAX_CACHED_CHUNKS`）が唯一の歯止め。伸び続けていないことを、覚えている
    // まとまりから引ける時刻の幅で見る。
    //
    // **待ちは 0。** ここで見たいのはキャッシュの頭打ちだけで、待ちは上の
    // 3 つのテストが見ている（混ぜると「引けないのは捨てられたからか、まだ
    // 待っているからか」が分からなくなる）。
    const fusion = new SensorFusion(threeSensorConfig(), { windowSec: 1, stepSec: 1, waitMs: 0 })
    for (let c = 0; c < 400; c++) {
      const at = c * CHUNK
      fusion.ingest(
        wave({
          boardKey: BOARD_B,
          sensorId: 'sensorB',
          firstSampleIndex: at,
          firstSampleMs: BASE_MS + at * MS_PER_SAMPLE,
          gal: rows(CHUNK, 1),
        }),
      )
    }
    // 400 まとまり送ったあと、**いちばん古い時刻はもう引けない**（上限で捨てられた）。
    // 引けてしまうなら 400 個すべて抱えていることになる。
    //
    const out = fusion.ingest(
      wave({
        boardKey: BOARD_A,
        sensorId: 'sensorA',
        firstSampleIndex: 0,
        firstSampleMs: BASE_MS,
        gal: rows(CHUNK, 1),
      }),
    )
    expect(out.fusedWave).not.toBeNull()
    // 先頭の時刻では裏付けを 1 本も引けない＝駆動役だけの合成になる。
    expect(out.fusedWave?.memberCount.every((m) => m === 1)).toBe(true)
    // 最新側の時刻なら引ける（キャッシュが空になったわけではない）。
    const recentAt = 399 * CHUNK
    const recent = fusion.ingest(
      wave({
        boardKey: BOARD_A,
        sensorId: 'sensorA',
        firstSampleIndex: CHUNK,
        firstSampleMs: BASE_MS + recentAt * MS_PER_SAMPLE,
        gal: rows(CHUNK, 1),
      }),
    )
    expect(recent.fusedWave).not.toBeNull()
    expect(recent.fusedWave?.memberCount.some((m) => m > 1)).toBe(true)
  })

  it('安全弁: closeAll() は待たせていたまとまりも流し切る', () => {
    // 待ちのぶん（既定 0.3 秒）を捨てると、終了時にその分の震度が出ないまま消える。
    const fusion = new SensorFusion(threeSensorConfig(), { windowSec: 1, stepSec: 1, waitMs: 300 })
    // 窓（1 秒）＋先読み（2 秒）＝300 サンプルを超える量を流す。待ちのせいで
    // 末尾の数まとまりは保留に残る。
    for (let c = 0; c < 40; c++) {
      const at = c * CHUNK
      fusion.ingest(
        wave({
          boardKey: BOARD_A,
          sensorId: 'sensorA',
          firstSampleIndex: at,
          firstSampleMs: BASE_MS + at * MS_PER_SAMPLE,
          gal: rows(CHUNK, 1),
        }),
      )
    }
    const closed = fusion.closeAll()
    expect(closed.failures).toEqual([])
    expect(closed.readings.length).toBeGreaterThan(0)
  })
})

describe('SensorFusion.ingest — 観測点ぶんの計測震度相当', () => {
  // **待ちは 0。** この節が見るのは流し込み（区間の作り直し・位置の連続・締めくくり）
  // なので、裏付けの到着待ちは混ぜない（理由は `NO_WAIT` を見ること）。
  const OPTS = { windowSec: 1, stepSec: 1, waitMs: 0 }

  /** 決まった形の揺れ。乱数は使わない —— 走るたびに値が変わると再現できない。 */
  function galRows(firstSampleIndex: number, n: number, amp: number): [number[], number[], number[]] {
    const out: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
    for (let i = 0; i < n; i++) {
      const t = (firstSampleIndex + i) / HZ
      out[0][i] = amp * Math.sin(2 * Math.PI * 3 * t)
      out[1][i] = amp * Math.cos(2 * Math.PI * 5 * t)
      // 3 軸目には重力の直流を乗せる（demeanWindow が引く対象）。
      out[2][i] = 1000 + amp * Math.sin(2 * Math.PI * 7 * t)
    }
    return out
  }

  it('正: 合成波形を計測震度の流し込みへ通し、観測点ぶんの震度が出る', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    const chunkSize = 50
    const chunkCount = 8 // 400 サンプル。3 秒（300 サンプル）で最初の答えが出るはず。
    let readingCount = 0
    for (let c = 0; c < chunkCount; c++) {
      const firstSampleIndex = c * chunkSize
      const gal = galRows(firstSampleIndex, chunkSize, 40)
      const out = fusion.ingest(
        wave({
          boardKey: BOARD_A,
          sensorId: 'sensorA',
          firstSampleIndex,
          firstSampleMs: BASE_MS + firstSampleIndex * MS_PER_SAMPLE,
          gal,
        }),
      )
      for (const r of out.readings) {
        expect(r.stationId).toBe('home')
        expect(typeof r.intensity).toBe('number')
        readingCount++
      }
    }
    expect(readingCount).toBeGreaterThan(0)
    expect(fusion.unusableIntensities).toBe(0)
  })

  it('正: 駆動役の区間（segmentId）が変わると、合成の流し込みを作り直す（streamKey が同じでも）', () => {
    // 版1プロトコルの再起動（seq-reset）は streamKey を変えない。segmentId だけで見ること。
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    const first = fusion.ingest(
      wave({
        boardKey: BOARD_A,
        sensorId: 'sensorA',
        streamKey: 'stream-1',
        segmentId: 1,
        firstSampleIndex: 0,
        gal: galRows(0, 50, 40),
      }),
    )
    expect(first.readings).toEqual([])
    expect(first.intensitySkipReason).toBeNull()
    // **区間が変わった回は `intensityStateChanged` が立つ**——呼び出し側（main.ts）が
    // ここを見て「状態が変わったときにだけログを出す」判定を再現できるかの根拠。
    expect(first.intensityStateChanged).toBe(true)
    // 区間が切れて作り直された想定（segmentId だけ変わり、位置は 0 から再スタート）。
    const second = fusion.ingest(
      wave({
        boardKey: BOARD_A,
        sensorId: 'sensorA',
        streamKey: 'stream-1',
        segmentId: 2,
        firstSampleIndex: 0,
        gal: galRows(0, 50, 40),
      }),
    )
    expect(second.readings).toEqual([])
    expect(second.intensitySkipReason).toBeNull()
    expect(second.intensityStateChanged).toBe(true)
  })

  it('正: 直流の違う 3 本を時刻をずらして流しても、合成の震度が跳ばない（#362）', () => {
    // 実機（2026-09-28）で観測した形。静止時の Z 軸が 662〜1200 gal に散っていて
    // （感度が未校正）、裏付け側は「直近の 1 まとまり」しか持たないので混ざる顔ぶれが
    // サンプルごとに変わる。**直流を落としていないと、顔ぶれが入れ替わるたびに
    // 数十 gal のステップが立ち、周期補正フィルタがそれを震度として出す**
    // （実機の合成は 4.36、単体は 1.12〜1.24 だった）。
    function entry(sensorId: string) {
      return {
        sensorId,
        enabled: true,
        rotation: IDENTITY,
        offset: [0, 0, 0] as const,
        sensitivity: [1, 1, 1] as const,
        // 実機と同じく全 9 本が未申告だった＝単純平均・駆動役は設定の先頭。
        noiseDensity: null,
      }
    }
    const config: StationConfig = {
      stations: [{ stationId: 'home', displayName: '自宅', lat: 35.6, lon: 139.7 }],
      boards: [
        { boardKey: BOARD_A, stationId: 'home', sensors: [entry('sensorA')] },
        { boardKey: BOARD_B, stationId: 'home', sensors: [entry('sensorB')] },
        { boardKey: BOARD_C, stationId: 'home', sensors: [entry('sensorC')] },
      ],
    }
    /** 静かな揺れ（振幅 1 gal ＝実機の静止ノイズ相当）に、そのセンサーの直流を乗せる。 */
    function quiet(firstSampleIndex: number, n: number, dcZ: number): [number[], number[], number[]] {
      const out: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
      for (let i = 0; i < n; i++) {
        const t = (firstSampleIndex + i) / HZ
        out[0][i] = Math.sin(2 * Math.PI * 3 * t)
        out[1][i] = Math.cos(2 * Math.PI * 5 * t)
        out[2][i] = dcZ + Math.sin(2 * Math.PI * 7 * t)
      }
      return out
    }
    // 実機の実測から 3 本ぶん（駆動役・最小・最大）。
    const DC_A = 1071.8
    const DC_B = 662.1
    const DC_C = 1200.2
    const chunkSize = 50
    /** 裏付け側をずらす量。駆動役の 1 まとまりの半分だけ重なる（顔ぶれを変動させる）。 */
    const SKEW = 25

    function runWith(withBackups: boolean): { intensities: number[]; memberCounts: Set<number> } {
      const fusion = new SensorFusion(config, OPTS)
      const intensities: number[] = []
      const memberCounts = new Set<number>()
      for (let c = 0; c < 12; c++) {
        const at = c * chunkSize
        if (withBackups) {
          for (const [boardKey, sensorId, dc] of [
            [BOARD_B, 'sensorB', DC_B],
            [BOARD_C, 'sensorC', DC_C],
          ] as const) {
            fusion.ingest(
              wave({
                boardKey,
                sensorId,
                segmentId: 1,
                firstSampleIndex: at,
                firstSampleMs: BASE_MS + (at + SKEW) * MS_PER_SAMPLE,
                gal: quiet(at + SKEW, chunkSize, dc),
              }),
            )
          }
        }
        const out = fusion.ingest(
          wave({
            boardKey: BOARD_A,
            sensorId: 'sensorA',
            segmentId: 1,
            firstSampleIndex: at,
            firstSampleMs: BASE_MS + at * MS_PER_SAMPLE,
            gal: quiet(at, chunkSize, DC_A),
          }),
        )
        if (out.fusedWave !== null) for (const m of out.fusedWave.memberCount) memberCounts.add(m)
        for (const r of out.readings) if (r.intensity !== null) intensities.push(r.intensity)
      }
      return { intensities, memberCounts }
    }

    const fused = runWith(true)
    const driverOnly = runWith(false)

    // **顔ぶれが実際に変動していること**を先に確かめる —— ここが 1 本だけに
    // なっていたら、このテストは症状の条件を作れていない（跳ばないのは当たり前）。
    expect(fused.memberCounts.size).toBeGreaterThan(1)
    expect(driverOnly.memberCounts).toEqual(new Set([1]))

    // 駆動役だけを流した場合（＝合成が効いていない状態）と同程度に収まること。
    // 直流を落としていなければ、ここで 3 以上の差が出る。
    expect(fused.intensities.length).toBeGreaterThan(0)
    const worst = Math.max(...fused.intensities)
    const reference = Math.max(...driverOnly.intensities)
    expect(worst).toBeLessThan(reference + 0.5)
  })

  it('正: 区間の途中から合成を始めても震度が出る（設定を変えて作り直した形・#362）', () => {
    // 実機（2026-09-28）で観測した形——管理コンソールで基板を観測点へ割り当てると
    // `SensorFusion` だけが作り直されるが、駆動役の区間は切れていないので位置は
    // 途中の値（実測 92949）のまま来る。流し込みの位置を合成側の起点から数え直して
    // いないと、位置 0 を待っている流し込みが弾き、**ホストを入れ直すまで合成が
    // 動かない**（実機でそうなった）。
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    const START = 92949
    const chunkSize = 50
    const readings: StationIntensityReading[] = []
    for (let c = 0; c < 8; c++) {
      const firstSampleIndex = START + c * chunkSize
      const out = fusion.ingest(
        wave({
          boardKey: BOARD_A,
          sensorId: 'sensorA',
          segmentId: 1,
          firstSampleIndex,
          firstSampleMs: BASE_MS + firstSampleIndex * MS_PER_SAMPLE,
          gal: galRows(firstSampleIndex, chunkSize, 40),
        }),
      )
      expect(out.intensitySkipReason).toBeNull()
      readings.push(...out.readings)
    }
    expect(readings.length).toBeGreaterThan(0)
    for (const r of readings) expect(typeof r.intensity).toBe('number')
  })

  it('安全弁: 区間の途中から始めても、震度の時刻は絶対時刻のまま（起点のずれが漏れない）', () => {
    // 位置を数え直すだけでは足りない——答えを絶対時刻へ戻す起点も同じ数え方へ
    // 揃えないと、**震度の値は正しいのに時刻だけが起点の差（実機なら 15 分ぶん）
    // ずれる**。ずれても例外もログも出ないので、ここで値まで確かめる。
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    const START = 92949
    const chunkSize = 50
    const readings: StationIntensityReading[] = []
    for (let c = 0; c < 8; c++) {
      const firstSampleIndex = START + c * chunkSize
      readings.push(
        ...fusion.ingest(
          wave({
            boardKey: BOARD_A,
            sensorId: 'sensorA',
            segmentId: 1,
            firstSampleIndex,
            firstSampleMs: BASE_MS + firstSampleIndex * MS_PER_SAMPLE,
            gal: galRows(firstSampleIndex, chunkSize, 40),
          }),
        ).readings,
      )
    }
    // 刻み 1 秒なので最初の答えが**名乗る**位置は合成を始めてから 100 サンプル目
    // （出せるようになるのは先読み 2 秒が届く 300 サンプル目だが、報告時刻は
    // その手前——`intensityStream.ts` の「答えは 2 秒遅れて出る」）。
    // 絶対位置は START + 100。
    expect(readings.length).toBeGreaterThan(0)
    expect(readings[0].atMs).toBeCloseTo(BASE_MS + (START + 100) * MS_PER_SAMPLE, 6)
  })

  it('対照: 同じ区間が続く回では intensityStateChanged が立たない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    fusion.ingest(
      wave({ boardKey: BOARD_A, sensorId: 'sensorA', segmentId: 1, firstSampleIndex: 0, gal: galRows(0, 50, 40) }),
    )
    // 同じ segmentId のまま続き、push も成功する（位置が連続している）。
    const out = fusion.ingest(
      wave({ boardKey: BOARD_A, sensorId: 'sensorA', segmentId: 1, firstSampleIndex: 50, gal: galRows(50, 50, 40) }),
    )
    expect(out.intensityStateChanged).toBe(false)
  })

  it('安全弁: 同じ区間内で位置が続きにならなければ、投げずに理由を残す（合成波形・差分は道連れにしない）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    const first = fusion.ingest(
      wave({ boardKey: BOARD_A, sensorId: 'sensorA', segmentId: 1, firstSampleIndex: 0, gal: galRows(0, 50, 40) }),
    )
    expect(first.intensitySkipReason).toBeNull()
    // 同じ segmentId のまま位置が飛ぶ（本来ありえない不整合の防御）。push() が
    // 投げ、この呼び出しで新しく理由が立つ。
    let desynced: FusionOutcome | undefined
    expect(() => {
      desynced = fusion.ingest(
        wave({
          boardKey: BOARD_A,
          sensorId: 'sensorA',
          segmentId: 1,
          firstSampleIndex: 200,
          gal: galRows(200, 50, 40),
        }),
      )
    }).not.toThrow()
    // **push() の失敗で新しく理由が立った回は `intensityStateChanged`——区間の
    // 作り直しだけが変化点ではない。** ここが立たないと、呼び出し側は
    // push 失敗という「いま起きた異常」に気づく機会を逃す。
    expect(desynced?.intensityStateChanged).toBe(true)
    const second = fusion.ingest(
      wave({
        boardKey: BOARD_A,
        sensorId: 'sensorA',
        segmentId: 1,
        firstSampleIndex: 250,
        gal: galRows(250, 50, 40),
      }),
    )
    // 波形の合成・差分は投げていないので出続ける。
    expect(second.fusedWave).not.toBeNull()
    expect(second.intensitySkipReason).not.toBeNull()
    // **理由自体は前回の呼び出しから引き継がれたままで、この回では何も変わっていない**
    // （`group.stream` が既に null なので push は試みられない）。
    expect(second.intensityStateChanged).toBe(false)
  })

  it('正: 終了時に closeAll() を呼ぶと、窓に満たない末尾ぶんの震度が出る（失敗は無い）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    // 300 サンプルに満たない量だけ流し、まだ 1 件も答えが出ていないことを確かめる。
    const out = fusion.ingest(
      wave({ boardKey: BOARD_A, sensorId: 'sensorA', segmentId: 1, firstSampleIndex: 0, gal: galRows(0, 150, 40) }),
    )
    expect(out.readings).toEqual([])
    const flushed = fusion.closeAll()
    expect(flushed.readings.length).toBeGreaterThan(0)
    for (const r of flushed.readings) expect(r.stationId).toBe('home')
    expect(flushed.failures).toEqual([])
  })

  it('安全弁: closeAll() のあとに ingest() を呼ぶと投げる', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    fusion.closeAll()
    expect(() =>
      fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: galRows(0, 50, 40) })),
    ).toThrow()
  })

  it('正: 区間が変わって締めた震度は、次の ingest() の readings に混ざって返る（値まで検証する）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
    // 区間1へ 320 サンプル（windowSec=1・stepSec=1・HZ=100 なので 300 サンプルで 1 点出る）。
    const first = fusion.ingest(
      wave({ boardKey: BOARD_A, sensorId: 'sensorA', segmentId: 1, firstSampleIndex: 0, gal: galRows(0, 320, 40) }),
    )
    expect(first.readings).toHaveLength(1)
    const firstReading = first.readings[0]
    // 区間が切れて作り直される。締めて出た残り（区間1の末尾ぶん）が今回の readings の先頭に来る。
    const second = fusion.ingest(
      wave({ boardKey: BOARD_A, sensorId: 'sensorA', segmentId: 2, firstSampleIndex: 0, gal: galRows(0, 50, 40) }),
    )
    expect(second.readings.length).toBeGreaterThan(0)
    expect(second.readings[0].stationId).toBe('home')
    // 締めくくりの震度は区間1のアンカーから計算されるので、直前の続き（同じ時系列）になる。
    expect(second.readings[0].atMs).toBeGreaterThan(firstReading.atMs)
    expect(second.closeFailure).toBeNull()
  })

  describe('締めくくり（end()）が失敗したとき', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('安全弁: 締めくくりの失敗は、直後に成功する新区間の構築で消えず closeFailure に残る', () => {
      const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }), OPTS)
      fusion.ingest(
        wave({ boardKey: BOARD_A, sensorId: 'sensorA', segmentId: 1, firstSampleIndex: 0, gal: galRows(0, 50, 40) }),
      )
      vi.spyOn(IntensityStream.prototype, 'end').mockImplementation(() => {
        throw new Error('締めくくりに失敗した（テスト用）')
      })
      // 区間が変わる → 旧区間を締めようとして失敗する。ただし新区間の構築自体は成功する。
      const out = fusion.ingest(
        wave({ boardKey: BOARD_A, sensorId: 'sensorA', segmentId: 2, firstSampleIndex: 0, gal: galRows(0, 50, 40) }),
      )
      expect(out.closeFailure).toEqual({ stationId: 'home', detail: expect.stringContaining('締めくくりに失敗した') })
      // 新区間の構築は成功しているので、いまの流し込みの健全性（intensitySkipReason）は別物。
      expect(out.intensitySkipReason).toBeNull()
    })

    it('正: closeAll() は締めくくりの失敗を failures へ集め、他の観測点の回収は止めない（2 観測点で検証）', () => {
      // home・garage の 2 観測点。1 観測点だけだと「失敗した観測点」と「回収を試みた
      // 観測点」が同じになり、ループが 1 件目の失敗で止まっていないことを示せない。
      function sensorEntry(sensorId: string, noiseDensity: number) {
        return {
          sensorId,
          enabled: true,
          rotation: IDENTITY,
          offset: [0, 0, 0] as const,
          sensitivity: [1, 1, 1] as const,
          noiseDensity,
        }
      }
      const config: StationConfig = {
        stations: [
          { stationId: 'home', displayName: '自宅', lat: 35.6, lon: 139.7 },
          { stationId: 'garage', displayName: '倉庫', lat: 35.7, lon: 139.8 },
        ],
        boards: [
          { boardKey: BOARD_A, stationId: 'home', sensors: [sensorEntry('sensorA', 10)] },
          { boardKey: BOARD_B, stationId: 'home', sensors: [sensorEntry('sensorB', 20)] },
          { boardKey: BOARD_C, stationId: 'garage', sensors: [sensorEntry('sensorC', 10)] },
          { boardKey: BOARD_D, stationId: 'garage', sensors: [sensorEntry('sensorD', 20)] },
        ],
      }
      const fusion = new SensorFusion(config, OPTS)
      // 両方の駆動役（noiseDensity が低い sensorA・sensorC）を届け、両グループとも
      // `stream` を持った状態にする（closeAll() が両方で end() を呼ぶようにするため）。
      fusion.ingest(
        wave({ boardKey: BOARD_A, sensorId: 'sensorA', segmentId: 1, firstSampleIndex: 0, gal: galRows(0, 50, 40) }),
      )
      fusion.ingest(
        wave({ boardKey: BOARD_C, sensorId: 'sensorC', segmentId: 1, firstSampleIndex: 0, gal: galRows(0, 50, 40) }),
      )
      // 1 回だけ投げる —— buildGroups は設定に並んだ順（home → garage）でグループを
      // 作るので、home 側の end() だけが失敗し、garage 側は本物の実装のまま通る。
      vi.spyOn(IntensityStream.prototype, 'end').mockImplementationOnce(() => {
        throw new Error('締めくくりに失敗した（テスト用・home のみ）')
      })
      const closed = fusion.closeAll()
      expect(closed.failures).toEqual([
        { stationId: 'home', detail: expect.stringContaining('締めくくりに失敗した') },
      ])
      // garage 側は正常に回収を試みている（50 サンプルでは震度は出ないが、
      // failures にも載らない —— home の失敗で処理が止まっていない証拠）。
      expect(closed.failures.some((f) => f.stationId === 'garage')).toBe(false)
    })
  })

  it('正: 3 台のグループでは全ペア（3 組）の差分が出て、最も低雑音の 1 台が駆動役になる', () => {
    const config: StationConfig = {
      stations: [{ stationId: 'home', displayName: '自宅', lat: 35.6, lon: 139.7 }],
      boards: [
        {
          boardKey: BOARD_A,
          stationId: 'home',
          sensors: [
            {
              sensorId: 'sensorA',
              enabled: true,
              rotation: IDENTITY,
              offset: [0, 0, 0],
              sensitivity: [1, 1, 1],
              noiseDensity: 50,
            },
          ],
        },
        {
          boardKey: BOARD_B,
          stationId: 'home',
          sensors: [
            {
              sensorId: 'sensorB',
              enabled: true,
              rotation: IDENTITY,
              offset: [0, 0, 0],
              sensitivity: [1, 1, 1],
              // 3 候補の真ん中でも末尾でもなく、最小値が正しく選ばれるかを見る。
              noiseDensity: 5,
            },
          ],
        },
        {
          boardKey: BOARD_C,
          stationId: 'home',
          sensors: [
            {
              sensorId: 'sensorC',
              enabled: true,
              rotation: IDENTITY,
              offset: [0, 0, 0],
              sensitivity: [1, 1, 1],
              noiseDensity: 20,
            },
          ],
        },
      ],
    }
    const fusion = new SensorFusion(config, NO_WAIT)
    fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    fusion.ingest(wave({ boardKey: BOARD_C, sensorId: 'sensorC', gal: [[100], [0], [0]] }))
    // sensorB（noiseDensity=5 で最小）が駆動役のはず。
    const out = fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[50], [0], [0]] }))
    expect(out.fusedWave?.driver).toEqual({ boardKey: BOARD_B, sensorId: 'sensorB' })
    expect(out.fusedWave?.memberCount).toEqual([3])
    expect(out.pairDiffs).toHaveLength(3)
  })
})

/**
 * `IntensityPipeline` が実際に組み立てた `WaveChunk`（校正適用後）を
 * `SensorFusion.ingest()` へ流す。**手組みの `WaveChunk` だけでは、フェーズをまたぐ
 * 接続点（校正済みの gal が実際に合成へ渡っているか）を検証できない**——敵対的
 * レビューで指摘された穴（main.ts:875-886 相当の配線をテストが一度も通していない）
 * を塞ぐ。
 */
describe('SensorFusion.ingest — 実際の IntensityPipeline から出た WaveChunk で合成する', () => {
  const HZ_INT = 100

  function packetFor(boardKey: BoardKey, sensorId: string, firstSeq: number): SensorPacket {
    return {
      version: 2,
      boardKey,
      bootId: 'boot1',
      sensorId,
      sensorType: 'MPU6050',
      channels: ['HN1', 'HN2', 'HN3'],
      ugPerLsb: 61.0352,
      fullScaleG: 2,
      sampleRateHz: HZ_INT,
      firstSampleMs: BASE_MS + (firstSeq * 1000) / HZ_INT,
      firstSeq,
      overflowCount: 0,
      // 静止（全軸カウント 0）。校正の効きだけを見たいので揺れは混ぜない。
      samples: Array.from({ length: 10 }, () => [0, 0, 0]),
    }
  }

  it('正: 校正（offset）を適用した後の gal が合成される（校正前の生値ではない）', () => {
    const config: StationConfig = {
      stations: [{ stationId: 'home', displayName: '自宅', lat: 35.6, lon: 139.7 }],
      boards: [
        {
          boardKey: BOARD_A,
          stationId: 'home',
          sensors: [
            {
              sensorId: 'sensorA',
              enabled: true,
              rotation: IDENTITY,
              // 第 1 軸に +10 gal のオフセット。校正後は 0 - 10 = -10 になるはず。
              offset: [10, 0, 0],
              sensitivity: [1, 1, 1],
              noiseDensity: 10,
            },
          ],
        },
        {
          boardKey: BOARD_B,
          stationId: 'home',
          sensors: [
            {
              sensorId: 'sensorB',
              enabled: true,
              rotation: IDENTITY,
              offset: [0, 0, 0],
              sensitivity: [1, 1, 1],
              // 重みを sensorA と揃える（単純平均になる）。
              noiseDensity: 10,
            },
          ],
        },
      ],
    }
    const pipeline = new IntensityPipeline({ stations: new StationDirectory(config) })
    const fusion = new SensorFusion(config, NO_WAIT)

    const outcomeA = pipeline.handlePacket(packetFor(BOARD_A, 'sensorA', 0))
    const outcomeB = pipeline.handlePacket(packetFor(BOARD_B, 'sensorB', 0))
    expect(outcomeA.wave).not.toBeNull()
    expect(outcomeB.wave).not.toBeNull()

    // **駆動役（sensorA。設定の先頭・同じ noiseDensity）を後に流す**——合成は
    // 駆動役の到着でしか起きない（`sensorFusion.ts` 冒頭コメント）。裏付け側
    // （sensorB）を先に流し、直近の 1 まとまりとして覚えさせる。
    fusion.ingest(outcomeB.wave as WaveChunk)
    const out = fusion.ingest(outcomeA.wave as WaveChunk)

    // sensorA は校正で -10、sensorB は 0 のまま。重みが同じなので単純平均 -5。
    // **校正前の生値（0 と 0）を混ぜていれば 0 になる**——それとの違いで確かめる。
    //
    // 合成値そのものは直流を落とした変動分（この入力は静止なので 0）なので、
    // **落とした直流を足し戻した値**で見る（上の「重み付き平均と差分」と同じ理由）。
    const w = out.fusedWave
    expect(w).not.toBeNull()
    expect((w as FusedWaveChunk).gal[0][0] + (w as FusedWaveChunk).dcGal[0][0]).toBeCloseTo(-5)
  })
})
