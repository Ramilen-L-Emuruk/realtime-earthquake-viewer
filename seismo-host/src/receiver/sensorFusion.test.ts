import { afterEach, describe, expect, it, vi } from 'vitest'

import { IntensityStream } from '../intensity/intensityStream'
import type { BoardKey } from '../protocol/types'
import type { WaveChunk } from './intensityPipeline'
import { SensorFusion } from './sensorFusion'
import type { FusionOutcome } from './sensorFusion'
import type { StationConfig } from './stationConfig'

const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const

const BASE_MS = 1790181865671
const HZ = 100
const MS_PER_SAMPLE = 1000 / HZ

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

describe('SensorFusion.ingest — グループ化と対象外の扱い', () => {
  it('対照: 観測点に割り当てが無いセンサーは合成の対象にならない', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
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
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
    // noiseDensity が低い sensorA が駆動役。sensorB（裏付け側）だけを流す。
    const out = fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[50], [0], [0]] }))
    expect(out.fusedWave).toBeNull()
    expect(out.pairDiffs).toEqual([])
  })
})

describe('SensorFusion.ingest — 重み付き平均と差分', () => {
  it('正: 駆動役だけが届いていれば、合成値は駆動役自身の値になる（memberCount=1）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
    const out = fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    expect(out.fusedWave?.gal[0][0]).toBeCloseTo(100, 9)
    expect(out.fusedWave?.memberCount).toEqual([1])
  })

  it('正: 両方届けば、重み（ノイズ密度の逆数分散）付きの平均になる', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
    // 先に裏付け側（sensorB）を届ける。
    fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[50], [0], [0]] }))
    // 駆動役（sensorA、noiseDensity が低い）が届いて初めて合成が動く。
    const out = fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    // 重み: wA=1/10²=0.01, wB=1/20²=0.0025。
    // (0.01*100 + 0.0025*50) / (0.01+0.0025) = 1.125 / 0.0125 = 90
    expect(out.fusedWave?.gal[0][0]).toBeCloseTo(90, 9)
    expect(out.fusedWave?.memberCount).toEqual([2])
  })

  it('正: ノイズ密度が片方でも未申告なら、グループ全体を単純平均へ倒す', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: null }, { noiseDensity: 100 }))
    fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[50], [0], [0]] }))
    const out = fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    // 単純平均: (100+50)/2 = 75
    expect(out.fusedWave?.gal[0][0]).toBeCloseTo(75, 9)
  })

  it('正: 差分 d=(a1-a2)/2 を出す（メンバー順は設定の並び順）', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
    fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[50], [0], [0]] }))
    const out = fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    expect(out.pairDiffs).toHaveLength(1)
    const d = out.pairDiffs[0]
    expect(d.memberA).toEqual({ boardKey: BOARD_A, sensorId: 'sensorA' })
    expect(d.memberB).toEqual({ boardKey: BOARD_B, sensorId: 'sensorB' })
    expect(d.diffGal[0][0]).toBeCloseTo((100 - 50) / 2, 9)
  })

  it('安全弁: 裏付け側の値が時刻的に離れすぎていれば外挿せず、駆動役だけの値になる', () => {
    const fusion = new SensorFusion(twoSensorConfig({ noiseDensity: 10 }, { noiseDensity: 20 }))
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
    expect(out.fusedWave?.gal[0][0]).toBeCloseTo(100, 9)
    expect(out.fusedWave?.memberCount).toEqual([1])
    expect(out.pairDiffs[0].diffGal[0][0]).toBeNull()
  })
})

describe('SensorFusion.ingest — 観測点ぶんの計測震度相当', () => {
  const OPTS = { windowSec: 1, stepSec: 1 }

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
    const fusion = new SensorFusion(config)
    fusion.ingest(wave({ boardKey: BOARD_A, sensorId: 'sensorA', gal: [[100], [0], [0]] }))
    fusion.ingest(wave({ boardKey: BOARD_C, sensorId: 'sensorC', gal: [[100], [0], [0]] }))
    // sensorB（noiseDensity=5 で最小）が駆動役のはず。
    const out = fusion.ingest(wave({ boardKey: BOARD_B, sensorId: 'sensorB', gal: [[50], [0], [0]] }))
    expect(out.fusedWave?.driver).toEqual({ boardKey: BOARD_B, sensorId: 'sensorB' })
    expect(out.fusedWave?.memberCount).toEqual([3])
    expect(out.pairDiffs).toHaveLength(3)
  })
})
