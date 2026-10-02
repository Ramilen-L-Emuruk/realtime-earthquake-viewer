import { describe, expect, it } from 'vitest'

import type { SegmentState } from '../timebase/segmenter'
import { AckReplier } from './ackReplier'
import type { GravityVerdict } from './gravityCheck'
import { PacketTally } from './packetTally'
import { ReadingHub } from './readingHub'
import type { SensorHealth } from './sensorHealth'
import { StationDirectory } from './stationConfig'
import type { StationHealth } from './stationHealth'
import { buildStatusReport } from './statusReport'
import type { RawStoreStatus, StatusReportInput, WaveArchiveStatus } from './statusReport'

const NOW = 1_700_000_100_000
const STARTED = 1_700_000_000_000

/** 何も起きていない自己診断。 */
const EMPTY_GRAVITY = {
  verdicts: [],
  mismatches: 0,
  unjudged: 0,
  restlessWindows: 0,
  restarts: 0,
  evictions: 0,
} as const

/** 倍率が 1000 分の 1 に狂った窓。**この帳面がいちばん捕まえたい形。** */
const VERDICT: GravityVerdict = {
  boardKey: 'mac:aa',
  sensorId: 'i2c0-68',
  streamKey: 'mac:aa|i2c0-68|boot1',
  atMs: NOW,
  sampleCount: 2_984,
  meanGal: 0.980665,
  sdGal: 0.0015,
  axisMeanGal: [0.0004, -0.0012, 0.980665],
  axisSdGal: [0.0011, 0.0012, 0.0009],
  maxIntensity: null,
  scale: 'too-small',
  restless: false,
}

const RAW_OK: RawStoreStatus = {
  writeErrors: 0,
  lostRecords: 0,
  slowCloses: 0,
  compressed: 2,
  compressFailures: 0,
  leftovers: 0,
  listFailures: 0,
  escaped: 0,
  openFiles: 1,
  stuckBooks: 0,
  recordsAtRisk: 0,
  cutShort: false,
  currentDay: '2026-09-26',
  lastWriteError: null,
  lastSweepError: null,
}

const WAVE_OK: WaveArchiveStatus = {
  writeErrors: 0,
  lostRecords: 0,
  badChunks: 0,
  written: 12,
  rotated: 0,
  openBooks: 1,
  slowClose: false,
  lastWriteError: null,
}

function segment(overrides: Partial<SegmentState['timebase']> = {}): SegmentState {
  return {
    meta: {
      segmentId: 7,
      streamKey: 'mac:aa|s0|boot1',
      boardKey: 'mac:aa',
      sensorId: 's0',
      bootId: 'boot1',
      sensorType: 'MPU6050',
      channels: ['HN1', 'HN2', 'HN3'],
      sampleRateHz: 100,
      ugPerLsb: 61.0352,
      fullScaleG: 2,
      firstSeq: 0,
      startedBecause: 'stream-start',
    },
    sampleCount: 3_000,
    timebase: {
      msPerSample: 10,
      firstSampleMs: STARTED,
      anchorCount: 42,
      residualRmsMs: 3.4,
      nominalReason: null,
      epochPlausible: true,
      ...overrides,
    },
  }
}

function sensor(overrides: Partial<SensorHealth> = {}): SensorHealth {
  return {
    boardKey: 'mac:aa',
    sensorId: 's0',
    lastPacketMs: NOW - 300,
    streamKey: 'mac:aa|s0|boot1',
    segmentId: 7,
    lastIntensity: 1.25,
    lastReadingAtMs: NOW - 2_000,
    lastNominalReason: null,
    lastSkipReason: null,
    ...overrides,
  }
}

function station(overrides: Partial<StationHealth> = {}): StationHealth {
  return {
    stationId: 'garage',
    lastPacketMs: NOW - 300,
    lastIntensity: 2.1,
    lastReadingAtMs: NOW - 2_000,
    lastSkipReason: null,
    closeFailures: 0,
    lastCloseFailure: null,
    // 混ざった本数（#315）。9 本を割り当てた観測点で待ちが効いている状態。
    lastMemberCountMin: 9,
    lastMemberCountMax: 9,
    // 顔ぶれが揃わないまま切り上げた回数（#374）。0 が正常。
    uncoveredFusions: 0,
    pairDiffs: [],
    ...overrides,
  }
}

function input(overrides: Partial<StatusReportInput> = {}): StatusReportInput {
  const tally = new PacketTally()
  tally.record({ kind: 'received', source: '192.0.2.83' })
  tally.record({ kind: 'parse-failed', source: '192.0.2.83', reason: 'empty' })
  tally.record({ kind: 'accepted', board: 'mac:aa' })
  tally.record({ kind: 'dropped', board: 'mac:aa', reason: 'stream-desync' })
  return {
    nowMs: NOW,
    startedAtMs: STARTED,
    udp: { address: '0.0.0.0', port: 50505 },
    udpRecvBuffer: { requestedBytes: 8_388_608, actualBytes: 8_388_608, error: null },
    loopStalls: { thresholdMs: 1000, count: 0, totalMs: 0, longestMs: null, last: null },
    http: { address: '0.0.0.0', port: 50506 },
    tally: tally.snapshotTotal(),
    sensors: [sensor()],
    sensorEvictions: 0,
    boardClocks: { boards: [], evictions: 0 },
    stationEvictions: 0,
    stationIntensities: [],
    gravity: EMPTY_GRAVITY,
    segments: [segment()],
    unusableIntensities: 0,
    raw: RAW_OK,
    waveArchive: WAVE_OK,
    hub: new ReadingHub().snapshot(),
    acks: new AckReplier({ enabled: true }).snapshot(),
    stations: StationDirectory.empty(),
    stationConfigWarning: null,
    ungroupedMultiBoardStations: [],
    assignedBoards: [],
    ...overrides,
  }
}

describe('buildStatusReport', () => {
  it('JSON にしたとき数え上げが Map のまま消えない', () => {
    const report = buildStatusReport(input())
    const round = JSON.parse(JSON.stringify(report))

    expect(round.tally.sources['192.0.2.83'].received).toBe(1)
    // 入れ子（理由別）まで開けていないと、ここが {} になる
    expect(round.tally.sources['192.0.2.83'].parseFailed.empty).toBe(1)
    expect(round.tally.boards['mac:aa'].dropped['stream-desync']).toBe(1)
  })

  it('保存の健全性をそのまま通す（数え上げだけを配らない）', () => {
    const report = buildStatusReport(
      input({ raw: { ...RAW_OK, lostRecords: 3, lastWriteError: 'ディスクが一杯' } }),
    )

    expect(report.raw.lostRecords).toBe(3)
    expect(report.raw.lastWriteError).toBe('ディスクが一杯')
    expect(report.raw.currentDay).toBe('2026-09-26')
  })

  it('基板ごとの時計のずれを通し、壊れた値は null にして時刻の欄として数える', () => {
    const report = buildStatusReport(
      input({
        boardClocks: {
          boards: [
            { boardKey: 'mac:a0b7', offsetMs: 1301, windowEndMs: NOW - 5_000, packets: 600, lastPacketMs: NOW - 100 },
            {
              boardKey: 'mac:bad',
              offsetMs: Number.NaN,
              windowEndMs: Number.POSITIVE_INFINITY,
              packets: 1,
              lastPacketMs: Number.NaN,
            },
            { boardKey: 'mac:new', offsetMs: null, windowEndMs: null, packets: 0, lastPacketMs: NOW - 200 },
          ],
          evictions: 2,
        },
      }),
    )
    expect(report.boardClocks.evictions).toBe(2)
    expect(report.boardClocks.boards[0]).toEqual({
      boardKey: 'mac:a0b7',
      offsetMs: 1301,
      windowEndMs: NOW - 5_000,
      packets: 600,
      lastPacketMs: NOW - 100,
    })
    expect(report.boardClocks.boards[1]?.offsetMs).toBeNull()
    expect(report.boardClocks.boards[1]?.windowEndMs).toBeNull()
    expect(report.boardClocks.boards[1]?.lastPacketMs).toBeNull()
    // **まだ測れていない（null）は壊れた値ではない。** 数えるのは非有限の 3 つだけ。
    expect(report.boardClocks.boards[2]?.offsetMs).toBeNull()
    expect(report.unreadableTimes).toBe(3)
  })

  it('基板への返事の数をそのまま通す（返せていないことが基板の側からは見えないため）', () => {
    const report = buildStatusReport(
      input({ acks: { enabled: false, sent: 7, failures: 2, throttled: 40, lastError: 'EHOSTUNREACH' } }),
    )
    const round = JSON.parse(JSON.stringify(report))

    expect(round.acks).toEqual({
      enabled: false,
      sent: 7,
      failures: 2,
      throttled: 40,
      lastError: 'EHOSTUNREACH',
    })
  })

  it('割り当てた基板の様子を通し、読めない時刻は null へ倒して数える', () => {
    const report = buildStatusReport(
      input({
        assignedBoards: [
          {
            boardKey: 'mac:aa',
            stationId: 'garage',
            lastPacketMs: Number.NaN,
            state: 'silent',
            sensors: [{ sensorId: 's0', lastPacketMs: Number.POSITIVE_INFINITY, state: 'silent' }],
          },
          { boardKey: 'mac:bb', stationId: 'garage', lastPacketMs: null, state: 'waiting', sensors: [] },
        ],
      }),
    )
    const round = JSON.parse(JSON.stringify(report))

    expect(round.assignedBoards).toEqual([
      {
        boardKey: 'mac:aa',
        stationId: 'garage',
        lastPacketMs: null,
        state: 'silent',
        sensors: [{ sensorId: 's0', lastPacketMs: null, state: 'silent' }],
      },
      { boardKey: 'mac:bb', stationId: 'garage', lastPacketMs: null, state: 'waiting', sensors: [] },
    ])
    // 基板とセンサーで 1 つずつ。ほかの欄が持つぶんは差し引く。
    expect(report.unreadableTimes - buildStatusReport(input()).unreadableTimes).toBe(2)
  })

  it('区間の時間軸を出す', () => {
    const report = buildStatusReport(input())

    expect(report.segments).toHaveLength(1)
    expect(report.segments[0].residualRmsMs).toBe(3.4)
    expect(report.segments[0].sampleCount).toBe(3_000)
    expect(report.segments[0].nominalReason).toBeNull()
  })

  it('時刻の当てはめが倒れていたら理由が出る', () => {
    const report = buildStatusReport(
      input({ segments: [segment({ nominalReason: 'too-few-anchors', residualRmsMs: null })] }),
    )

    expect(report.segments[0].nominalReason).toBe('too-few-anchors')
    expect(report.segments[0].residualRmsMs).toBeNull()
  })

  it('数値にならない時刻は null にして、数えて出す', () => {
    const report = buildStatusReport(
      input({
        segments: [segment({ firstSampleMs: Number.NaN })],
        sensors: [sensor({ lastReadingAtMs: Number.POSITIVE_INFINITY })],
      }),
    )

    expect(report.segments[0].firstSampleMs).toBeNull()
    expect(report.sensors[0].lastReadingAtMs).toBeNull()
    // **数えないと黙って消える** —— JSON では壊れた値も「まだ無い」も同じ null になる
    expect(report.unreadableTimes).toBe(2)
  })

  it('壊れていなければ数えない', () => {
    expect(buildStatusReport(input()).unreadableTimes).toBe(0)
  })

  it('数値にならない震度の値は、時刻とは別の数へ入れる', () => {
    // **`unreadableTimes` は名前のとおり時刻の欄の数。** 震度の値を混ぜると、
    // 見た人が「時刻が壊れている」と読んで別の層を疑う。
    const report = buildStatusReport(
      input({
        sensors: [sensor({ lastIntensity: Number.NaN, lastReadingAtMs: Number.NaN })],
      }),
    )

    expect(report.sensors[0].lastIntensity).toBeNull()
    expect(report.unreadableIntensityValues).toBe(1)
    expect(report.unreadableTimes).toBe(1)
  })

  it('観測点ぶんの合成（複数センサー・§7）の生存を、センサーとは別の一覧で出す', () => {
    const report = buildStatusReport(input({ stationIntensities: [station()] }))

    expect(report.stationIntensities).toEqual([station()])
    // **`sensors` へは混ざらない。** あちらはセンサー 1 個の話で、件数も別。
    expect(report.sensors).toHaveLength(1)
  })

  it('観測点の値も、センサーと同じ番人（時刻・震度を別の数へ入れる）を通る', () => {
    const report = buildStatusReport(
      input({
        stationIntensities: [
          station({ lastReadingAtMs: Number.NaN, lastIntensity: Number.POSITIVE_INFINITY }),
        ],
      }),
    )

    expect(report.stationIntensities[0].lastReadingAtMs).toBeNull()
    expect(report.stationIntensities[0].lastIntensity).toBeNull()
    expect(report.unreadableTimes).toBe(1)
    expect(report.unreadableIntensityValues).toBe(1)
  })

  it('数として出せなかった震度の件数を、時刻とは別の数として出す', () => {
    const report = buildStatusReport(input({ unusableIntensities: 4 }))

    // 混ぜると「どちらの層で壊れたか」が読めなくなる
    expect(report.unusableIntensities).toBe(4)
    expect(report.unreadableTimes).toBe(0)
  })

  it('センサーの行に、震度を出せない理由を出す', () => {
    const report = buildStatusReport(
      input({ sensors: [sensor({ lastIntensity: null, lastSkipReason: 'axis-count' })] }),
    )

    expect(report.sensors[0].lastSkipReason).toBe('axis-count')
  })

  it('正: 設定にある基板は、観測点（座標込み）を出す', () => {
    const stations = new StationDirectory({
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [{ boardKey: 'mac:aa', stationId: 'study', sensors: [] }],
    })
    const report = buildStatusReport(input({ stations }))

    expect(report.sensors[0].station).toEqual({
      stationId: 'study',
      displayName: '書斎',
      lat: 35.6,
      lon: 139.7,
    })
  })

  it('対照: 設定に無い基板は未割当（null）のまま出す', () => {
    const report = buildStatusReport(input({ stations: StationDirectory.empty() }))

    expect(report.sensors[0].station).toBeNull()
  })

  it('正: センサーの校正値が設定にあれば calibrationConfigured は true', () => {
    const stations = new StationDirectory({
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [
        {
          boardKey: 'mac:aa',
          stationId: 'study',
          sensors: [
            {
              sensorId: 's0',
              enabled: true,
              rotation: [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
              ],
              offset: [0, 0, 0],
              sensitivity: [1, 1, 1],
              noiseDensity: null,
            },
          ],
        },
      ],
    })
    const report = buildStatusReport(input({ stations }))

    expect(report.sensors[0].calibrationConfigured).toBe(true)
  })

  it('対照: 校正値が設定に無いセンサーは calibrationConfigured が false のまま（`station` が付いていても別の事実）', () => {
    const stations = new StationDirectory({
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      // **基板は観測点に割り当てているが、センサーの校正値は 1 件も書いていない。**
      // `station` は付くが `calibrationConfigured` は別の問い —— 「どこに置いたか」を
      // 知っていることと「校正値を書いたか」は無関係な事実なので混ぜない。
      boards: [{ boardKey: 'mac:aa', stationId: 'study', sensors: [] }],
    })
    const report = buildStatusReport(input({ stations }))

    expect(report.sensors[0].station).not.toBeNull()
    expect(report.sensors[0].calibrationConfigured).toBe(false)
  })

  it('正: enabled: false のセンサーは、震度が凍結していても /status で無効と分かる', () => {
    const stations = new StationDirectory({
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [
        {
          boardKey: 'mac:aa',
          stationId: 'study',
          sensors: [
            {
              sensorId: 's0',
              enabled: false,
              rotation: [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
              ],
              offset: [0, 0, 0],
              sensitivity: [1, 1, 1],
              noiseDensity: null,
            },
          ],
        },
      ],
    })
    const report = buildStatusReport(input({ stations }))

    expect(report.sensors[0].enabled).toBe(false)
  })

  it('安全弁: 校正値は設定してあるが無効化していないセンサーは calibrationConfigured・enabled ともに true', () => {
    // **`enabled` を `calibrationConfigured` の否定で代用していないことを固定する。**
    // 上の「正」（calibrationConfigured=true×enabled=false）と下の「対照」
    // （calibrationConfigured=false×enabled=true）だけでは、`enabled` を
    // `!calibrationConfigured` に壊しても両方たまたま通ってしまう。
    const stations = new StationDirectory({
      stations: [{ stationId: 'study', displayName: '書斎', lat: 35.6, lon: 139.7 }],
      boards: [
        {
          boardKey: 'mac:aa',
          stationId: 'study',
          sensors: [
            {
              sensorId: 's0',
              enabled: true,
              rotation: [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
              ],
              offset: [0, 0, 0],
              sensitivity: [1, 1, 1],
              noiseDensity: null,
            },
          ],
        },
      ],
    })
    const report = buildStatusReport(input({ stations }))

    expect(report.sensors[0].calibrationConfigured).toBe(true)
    expect(report.sensors[0].enabled).toBe(true)
  })

  it('対照: 割り当てが無ければ enabled は既定値どおり true', () => {
    const report = buildStatusReport(input({ stations: StationDirectory.empty() }))

    expect(report.sensors[0].enabled).toBe(true)
  })

  it('正: 観測点設定の読み込み警告を、標準出力だけでなく状態の口にも出す', () => {
    const report = buildStatusReport(
      input({ stationConfigWarning: 'stations[0].boardKey が不正: "study"' }),
    )

    expect(report.stationConfigWarning).toBe('stations[0].boardKey が不正: "study"')
  })

  it('対照: 読み込みが正常なら警告は null のまま', () => {
    const report = buildStatusReport(input())

    expect(report.stationConfigWarning).toBeNull()
  })

  it('稼働の長さを秒で出し、時計が跳ねても負にしない', () => {
    expect(buildStatusReport(input()).uptimeSec).toBe(100)
    expect(buildStatusReport(input({ nowMs: STARTED - 5_000 })).uptimeSec).toBe(0)
  })

  it('押し出しの具合を出す', () => {
    const hub = new ReadingHub({ maxSubscribers: 1 })
    hub.subscribe({ wave: 'all', diff: null, deliver: () => true, onDetach: () => {} })
    hub.subscribe({ wave: 'none', diff: null, deliver: () => true, onDetach: () => {} })

    const report = buildStatusReport(input({ hub: hub.snapshot() }))

    expect(report.stream.subscribers).toHaveLength(1)
    // **どこまで受けているかがそのまま出る。** 真偽値だと「合成だけ」を
    // 受けている購読と「センサー単独も」の購読が同じ `true` に潰れ、
    // 毎秒 65 KB の差が状態の口から読めなくなる。
    expect(report.stream.subscribers[0].wave).toBe('all')
    expect(report.stream.rejected).toBe(1)
    expect(report.stream.limit).toBe(1)
  })

  it('待ち受けの口をそのまま出す', () => {
    const report = buildStatusReport(input())
    expect(report.udp).toEqual({ address: '0.0.0.0', port: 50505 })
    expect(report.http).toEqual({ address: '0.0.0.0', port: 50506 })
  })

  it('換算の自己診断を、判定も累計もそのまま出す', () => {
    // **数は全部出す。** `verdicts` はセンサーごとの直近 1 窓しか持たないので、
    // 単発で起きて自分で直った異常（読めない値の混入など）は次の窓で消える ——
    // **累計が無いと、起きたこと自体が状態の口から丸ごと落ちる**（記録の側には
    // 残るが、それは見に来ない運用では届かない）。
    const full = {
      verdicts: [VERDICT],
      mismatches: 3,
      unjudged: 9,
      restlessWindows: 1,
      restarts: 4,
      evictions: 2,
    }

    const report = buildStatusReport(input({ gravity: full }))

    expect(report.gravity).toEqual(full)
  })

  it('診断した時刻が数値にならなければ null にして数える', () => {
    // **時刻だけはここで確かめ直す。** 平均・ばらつき・震度は `gravityCheck.ts` の
    // `settle` が有限を確かめてから渡すが、判定の時刻は素の時計の値をそのまま入れている。
    const report = buildStatusReport(
      input({ gravity: { ...EMPTY_GRAVITY, verdicts: [{ ...VERDICT, atMs: Number.NaN }] } }),
    )

    expect(report.gravity.verdicts[0].atMs).toBeNull()
    expect(report.unreadableTimes).toBe(1)
    // **時刻の欄が壊れても、残りは落とさない。** 判定そのものは読めている。
    expect(report.gravity.verdicts[0].scale).toBe('too-small')
    expect(report.gravity.verdicts[0].meanGal).toBe(VERDICT.meanGal)
  })
})
