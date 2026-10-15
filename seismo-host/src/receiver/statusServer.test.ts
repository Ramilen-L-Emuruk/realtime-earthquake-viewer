import { request as httpRequest } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AdminAuthConfig } from './adminAuth'
import type { IntensityReading, WaveChunk } from './intensityPipeline'
import { PacketTally } from './packetTally'
import { USUAL_WAIT_MS } from './quakeIntensity'
import { ReadingHub } from './readingHub'
import type { FusedWaveChunk, SensorPairDiff, SensorResidual, StationIntensityReading } from './sensorFusion'
import { EMPTY_STATION_CONFIG, IDENTITY_MATRIX, StationDirectory } from './stationConfig'
import type { StationConfig } from './stationConfig'
import { buildStatusReport } from './statusReport'
import type { StatusReport, WaveArchiveStatus } from './statusReport'
import {
  buildWaveResponse,
  parseDiffParams,
  parseResidualParams,
  parseEventQuery,
  parseQuakeIntensityQuery,
  parseRewaveRequest,
  REWAVE_REQUEST_MAX_MS,
  parseWaveParam,
  parseWaveQuery,
  startStatusServer,
  wireShakeEvent,
} from './statusServer'
import type { ShakeEventRecord } from '../detection/shakeEvent'
import type { EventRangeResult } from '../detection/shakeEventStore'
import type { StatusServer, StatusServerOptions } from './statusServer'
import { stationFileToken } from './waveArchive'
import type { ArchivedWaveChunk, WaveRangeResult } from './waveArchive'

/** 保存先の口の仮の実体。保存先の口そのものは `storageControl.test.ts` と下の `/api/storage` の節が見る。 */
const NO_STORAGE: StatusServerOptions['storage'] = {
  get: () => {
    throw new Error('呼ばれない')
  },
  setPending: async () => ({ ok: false, problem: 'locked' }),
  purgeOld: async () => ({ ok: false, reason: 'not-copied' }),
  abandonMigration: async () => ({ ok: false, reason: 'not-missing' }),
}

const WAVE_ARCHIVE: WaveArchiveStatus = {
  writeErrors: 0,
  lostRecords: 0,
  badChunks: 0,
  written: 0,
  rotated: 0,
  openBooks: 0,
  slowClose: false,
  lastWriteError: null,
  revisedWritten: 0,
  revisedLost: 0,
}

function report(hub: ReadingHub): StatusReport {
  return buildStatusReport({
    nowMs: 1_700_000_100_000,
    startedAtMs: 1_700_000_000_000,
    storage: { drives: [], countedAtMs: null, lastError: null, migration: null, startupProblem: null, journalProblem: null },
    udp: { address: '0.0.0.0', port: 50505 },
    udpRecvBuffer: { requestedBytes: 8_388_608, actualBytes: 8_388_608, error: null },
    loopStalls: { thresholdMs: 1000, count: 0, totalMs: 0, longestMs: null, last: null },
    backlog: {
      pendingGaps: 0, pendingSamples: 0, recoveredSamples: 0, unrecoverableSamples: {},
      requests: 0, recoveredPackets: 0, failures: {}, badPackets: 0, foreignPackets: 0, unsavedPackets: 0, skippedPackets: 0,
      unsettledWriteSinceMs: null, rebootsSeen: 0, rebootsHostTimed: 0, rebootsUnmeasured: 0,
    },
    rewave: { waiting: 0, requestedWaiting: 0, requested: { jobs: 0, skipped: {} }, running: false, jobs: 0, chunks: 0, rawIssues: 0, skipped: {} },
    http: { address: '0.0.0.0', port: 50506 },
    tally: new PacketTally().snapshotTotal(),
    sensors: [],
    sensorEvictions: 0,
    boardClocks: { boards: [], evictions: 0 },
    stationEvictions: 0,
    stationIntensities: [],
    boardIntensities: [],
    gravity: {
      verdicts: [],
      mismatches: 0,
      unjudged: 0,
      restlessWindows: 0,
      restarts: 0,
      axisReshapes: 0,
      evictions: 0,
    },
    segments: [],
    unusableIntensities: 0,
    mseed: {
      recordsWritten: 7,
      packetsLogged: 0,
      unreadableWritten: 0,
      lostRecords: 0,
      badTimes: 0,
      writeErrors: 0,
      lastWriteError: null,
      openBooks: 0,
      slowClose: false,
      pendingSamples: 0,
      bufferedPackets: 0,
      cuts: { full: 0, 'seq-gap': 0, 'rate-change': 0, 'clock-sync': 0, 'time-drift': 0, hour: 0, hold: 0, idle: 0, flush: 0, 'value-jump': 0, recovered: 0 },
      internalErrors: 0,
      lastInternalError: null,
    },
    stationHistory: { recorded: 1, writeFailures: 0, lastError: null },
    waveArchive: WAVE_ARCHIVE,
    waveSummary: {
      dir: 'data/summary',
      sources: 0,
      upToDate: 0,
      pending: 0,
      built: 0,
      failed: 0,
      removed: 0,
      scanErrors: 0,
      lastError: null,
      lastBuiltHour: null,
      lastBuildMs: null,
      lastScanAtMs: null,
      running: false,
    },
    hub: hub.snapshot(),
    acks: { enabled: true, sent: 0, failures: 0, throttled: 0, withGaps: 0, gapLookupFailures: 0, gapEntriesRejected: 0, lastError: null },
    detection: {
      detectorVersion: 1,
      stations: [],
      shakes: 0,
      pending: 0,
      resets: 0,
      droppedChunks: 0,
      phaseWindowsBroken: 0,
      phaseFailures: 0,
      failures: 0,
      lastFailure: null,
      store: { written: 0, writeErrors: 0, lastWriteError: null },
      feed: null,
      triggers: [],
    },
    stations: StationDirectory.empty(),
    stationConfigWarning: null,
    ungroupedMultiBoardStations: [],
    assignedBoards: [],
    usualIntensities: [],
  })
}

const READING: IntensityReading = {
  streamKey: 'mac:aa|s0|boot1',
  segmentId: 1,
  boardKey: 'mac:aa',
  sensorId: 's0',
  atMs: 1_700_000_000_000,
  intensity: 2.5,
  timebaseNominalReason: null,
  timebaseResidualRmsMs: 3.1,
}

const STATION_READING: StationIntensityReading = {
  stationId: 'garage',
  atMs: 1_700_000_000_000,
  intensity: 1.8,
}

const WAVE: WaveChunk = {
  streamKey: 'mac:aa|s0|boot1',
  segmentId: 1,
  boardKey: 'mac:aa',
  sensorId: 's0',
  channels: ['HN1', 'HN2', 'HN3'],
  firstSampleIndex: 0,
  firstSampleMs: 1_700_000_000_000,
  msPerSample: 10,
  timebaseNominalReason: null,
  ground: [[1.5], [2.5], [980]],
  axes: [
    { direction: [1, 0, 0], gal: [1.5] },
    { direction: [0, 1, 0], gal: [2.5] },
    { direction: [0, 0, 1], gal: [980] },
  ],
}

const STATION_WAVE: FusedWaveChunk = {
  stationId: 'garage',
  firstSampleIndex: 0,
  firstSampleMs: 1_700_000_000_000,
  msPerSample: 10,
  gal: [[1.5], [2.5], [0.5]],
  // 落とした直流（`gal` と足せば校正済み gal の重み付き平均になる値）。
  dcGal: [[0], [0], [980]],
  memberCount: [9],
  axisMemberCount: [[9], [9], [9]],
}

/** 立てたものを必ず畳む。 */
const running: { server: StatusServer | null; abort: AbortController[] } = { server: null, abort: [] }

afterEach(async () => {
  for (const a of running.abort) a.abort()
  running.abort = []
  await running.server?.close()
  running.server = null
})

/** 既定は `/api/*` を丸ごと無効化する設定（トークン未設定）。 */
const NO_ADMIN_AUTH: AdminAuthConfig = { token: null, allowedHosts: [], allowedOrigins: [] }
const NO_REST_WINDOWS = { nowMs: 0, windowMs: 30_000, sensors: [] }

/**
 * テスト用の管理コンソールアセット。**`buildAdminConsoleAssets()` を呼ばない**——
 * esbuild を毎テストで走らせる理由が無く、ここで確かめたいのは配信の配線であって
 * ビルドの中身ではない（ビルドそのものは `adminConsoleAssets.test.ts` が持つ）。
 */
const TEST_ADMIN_CONSOLE: StatusServerOptions['adminConsole'] = { html: '<html>admin</html>', js: 'console.log(1)' }

/**
 * テスト用の観測点設定の読み書き。**インメモリで完結する**——`apply` が書いた内容を
 * 次の `get` が返す（`main.ts` の実装と同じ「保存してから返す」契約を、テストでは
 * ディスクを経由せず再現する）。
 */
function makeStationConfigOps(initial: StationConfig = EMPTY_STATION_CONFIG): StatusServerOptions['stationConfig'] {
  let current = initial
  return {
    get: () => current,
    apply: (config) => {
      current = config
    },
  }
}

async function start(
  hub: ReadingHub,
  status?: () => StatusReport,
  log?: StatusServerOptions['log'],
  heartbeatMs?: number,
  adminAuth?: AdminAuthConfig,
  stationConfig?: StatusServerOptions['stationConfig'],
  adminConsole?: StatusServerOptions['adminConsole'],
  readWaves?: StatusServerOptions['readWaves'],
  readRestWindows?: StatusServerOptions['readRestWindows'],
  readEvents?: StatusServerOptions['readEvents'],
): Promise<string> {
  // **port 0 で開く。** 固定の番号だと、並んで走る別のテストと取り合う。
  const server = await startStatusServer({
    port: 0,
    address: '127.0.0.1',
    hub,
    status: status ?? (() => report(hub)),
    log,
    heartbeatMs,
    adminAuth: adminAuth ?? NO_ADMIN_AUTH,
    stationConfig: stationConfig ?? makeStationConfigOps(),
    readRestWindows: readRestWindows ?? (() => NO_REST_WINDOWS),
    // 止める合図を試すテストは `startAuthed` を使う（`/api/*` は認証が要る）。
    requestShutdown: () => 'not-ready',
    // 作り直しの依頼を試すテストは `startAuthed` を使う（`/api/*` は認証が要る）。
    requestRewave: () => ({ kind: 'busy' }),
    // **`null` を明示的に渡したいテストがあるので `??` は使わない。** `??` だと
    // `null` も「未指定」と同じ扱いになり、ビルド失敗を再現できない。
    adminConsole: adminConsole !== undefined ? adminConsole : TEST_ADMIN_CONSOLE,
    // **既定は `null`（保存を持たない構成）。** 読み返しを試すテストだけが渡す。
    readWaves: readWaves ?? null,
    // **既定は `null`（記録を持たない構成）。** 揺れの記録を試すテストだけが渡す。
    readEvents: readEvents ?? null,
    // 保存した波形の読み返しは `/api/*`（認証つき）なので、試すテストは `startAuthed` を使う。
    records: null,
    storage: NO_STORAGE,
  })
  running.server = server
  return `http://127.0.0.1:${server.port}`
}

/**
 * `Host` ヘッダを偽装したいテストのためだけに `node:http` の生のクライアントを使う。
 *
 * **`fetch`（undici）では出来ない**——実測したところ、`headers: { Host: ... }` を
 * 渡しても実際に送られる `Host` ヘッダは接続先の URL から作り直される（ブラウザの
 * fetch 仕様どおり `Host` は forbidden request-header）。DNS rebinding 対策の
 * 判定そのものをテストするには、この経路でしか偽装できない。
 */
function requestWithHost(
  base: string,
  path: string,
  hostHeader: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Host: hostHeader, ...extraHeaders },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * SSE の生の中身を、`want` が現れるまで読む。
 *
 * `readEvents` は `event:` の付いた塊だけを拾うので、**生存確認（`: ping`）は
 * そちらでは観測できない** —— あれは名前も中身も持たないコメント行。
 */
async function readRawUntil(base: string, path: string, want: string): Promise<string> {
  const controller = new AbortController()
  running.abort.push(controller)
  const res = await fetch(`${base}${path}`, { signal: controller.signal })
  expect(res.status).toBe(200)
  const reader = res.body?.getReader()
  if (reader === undefined) throw new Error('本文が読めない')
  const decoder = new TextDecoder()
  let buffer = ''
  // **期限は読み取りそのものに掛ける。** 回るたびに時刻を見るだけの形だと、
  // 1 件も届かないとき `reader.read()` が永久に返らず、**期限の判定まで辿り着けない**。
  // 症状は「その行が出なかった」ではなく**テストごと時間切れ**になり、
  // 何が起きなかったのかが読めなくなる。
  const timer = setTimeout(() => controller.abort(), 1_000)
  try {
    while (!buffer.includes(want)) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  } catch {
    // 期限が来て切った。集まったぶんだけ返し、判定は呼び出し側に任せる。
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return buffer
}

/** SSE を繋いで、`event:` の付いた塊を `want` 件集める。 */
async function readEvents(
  base: string,
  path: string,
  want: number,
  publish: () => void,
): Promise<{ name: string; data: unknown }[]> {
  const controller = new AbortController()
  running.abort.push(controller)
  const res = await fetch(`${base}${path}`, { signal: controller.signal })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')

  const reader = res.body?.getReader()
  if (reader === undefined) throw new Error('本文が読めない')
  const decoder = new TextDecoder()
  const out: { name: string; data: unknown }[] = []
  let buffer = ''
  // **繋がってから流す。** 先に流すと、購読が登録される前なので誰にも届かない。
  publish()
  const deadline = Date.now() + 3_000
  while (out.length < want && Date.now() < deadline) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let at = buffer.indexOf('\n\n')
    while (at >= 0) {
      const block = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      const name = /^event: (.+)$/m.exec(block)?.[1]
      const data = /^data: (.+)$/m.exec(block)?.[1]
      if (name !== undefined && data !== undefined) out.push({ name, data: JSON.parse(data) })
      at = buffer.indexOf('\n\n')
    }
  }
  controller.abort()
  return out
}

describe('parseWaveParam', () => {
  it("正: station を頼めば観測点の合成だけ、1・all を頼めばセンサー単独も", () => {
    expect(parseWaveParam('station')).toBe('station')
    // **`1` の意味を変えていない。** 管理コンソールの波形タブがこの値で繋いでいる。
    expect(parseWaveParam('1')).toBe('all')
    expect(parseWaveParam('all')).toBe('all')
  })

  it('対照: 頼まなければ波形は付かない', () => {
    expect(parseWaveParam(null)).toBe('none')
  })

  it('安全弁: 知らない値は none へ倒す（打ち間違いで毎秒 65 KB を流さない）', () => {
    // `?wave=true` や `?wave=sensor` のような、それらしく見えて実装に無い値。
    // ここが `'all'` へ倒れると、頼んでいない端末へセンサー単独の波形が流れる。
    expect(parseWaveParam('true')).toBe('none')
    expect(parseWaveParam('sensor')).toBe('none')
    expect(parseWaveParam('')).toBe('none')
    expect(parseWaveParam('0')).toBe('none')
    // **`Record` の素性が漏れないこと。** 原型の鎖にある名前を渡しても
    // 表の値として拾われない（`?wave=constructor` で `'all'` になったら事故）。
    expect(parseWaveParam('constructor')).toBe('none')
    expect(parseWaveParam('toString')).toBe('none')
  })
})

describe('parseDiffParams（#372）', () => {
  /** クエリを組む。**区切り文字で連結しないので、値に何が入っても壊れない。** */
  function query(pairs: Record<string, string>): URLSearchParams {
    return new URLSearchParams(pairs)
  }

  const FULL = {
    diffStation: 'garage',
    diffBoardA: 'mac:aabbccddeeff',
    diffSensorA: 's0',
    diffBoardB: 'mac:112233445566',
    diffSensorB: 's1',
  }

  it('正: 5 欄そろえば 1 組として読む', () => {
    expect(parseDiffParams(query(FULL))).toEqual({
      want: {
        stationId: 'garage',
        a: { boardKey: 'mac:aabbccddeeff', sensorId: 's0' },
        b: { boardKey: 'mac:112233445566', sensorId: 's1' },
      },
      problem: null,
      problemKind: null,
    })
  })

  it('正: 大文字の MAC は設定と同じ形へ揃える', () => {
    // **設定側（`normalizeBoardKey`）と同じ関数を通すことがここで効く。** 別に
    // 書くと、構文としては正しいのに設定の値と永久に一致しない組が通ってしまい、
    // 症状は「繋がっているのに何も届かない」だけになる。
    const got = parseDiffParams(query({ ...FULL, diffBoardA: 'mac:AABBCCDDEEFF' }))
    expect(got.want?.a.boardKey).toBe('mac:aabbccddeeff')
  })

  it('正: 前後の空白は落とす', () => {
    // 設定側も落としてから持つ（`nonEmptyString`）。落とさないと空白 1 つで噛み合わない。
    const got = parseDiffParams(query({ ...FULL, diffStation: '  garage  ', diffSensorA: ' s0 ' }))
    expect(got.want?.stationId).toBe('garage')
    expect(got.want?.a.sensorId).toBe('s0')
  })

  it('対照: 何も書いていなければ差分なし（理由も無し）', () => {
    // **「書いていない」と「書いたが読めなかった」を分ける。** 前者で 1 行残すと、
    // 差分を見に来ていない購読すべてが記録を汚す。
    expect(parseDiffParams(query({}))).toEqual({ want: null, problem: null, problemKind: null })
    expect(parseDiffParams(query({ wave: '1' }))).toEqual({
      want: null,
      problem: null,
      problemKind: null,
    })
  })

  it('安全弁: 半端・空・長すぎ・同じセンサー・書式違いは理由を付けて差分なしへ倒す', () => {
    const half = parseDiffParams(query({ diffStation: 'garage', diffBoardA: 'mac:aa' }))
    expect(half.want).toBeNull()
    expect(half.problem).toContain('欄が足りない')

    const empty = parseDiffParams(query({ ...FULL, diffSensorA: '   ' }))
    expect(empty.want).toBeNull()
    expect(empty.problem).toContain('空の欄')

    const long = parseDiffParams(query({ ...FULL, diffStation: 'x'.repeat(65) }))
    expect(long.want).toBeNull()
    expect(long.problem).toContain('長すぎる')

    // 同じセンサーを 2 つ指すと差分は定義上ずっと 0 になり、「届いているのに
    // 平らなまま」という読み違いを招く。
    const same = parseDiffParams(
      query({ ...FULL, diffBoardB: 'mac:aabbccddeeff', diffSensorB: 's0' }),
    )
    expect(same.want).toBeNull()
    expect(same.problem).toContain('同じセンサー')

    const badKey = parseDiffParams(query({ ...FULL, diffBoardA: 'aabbccddeeff' }))
    expect(badKey.want).toBeNull()
    expect(badKey.problem).toContain('基板の書き方')

    // **理由ごとに別の種別が立つこと。** これが記録を間引く鍵になる ——
    // 同じ合言葉にすると、60 秒のうちに違う理由で失敗した 2 件目が残らない。
    expect(
      new Set([half, empty, long, same, badKey].map((r) => r.problemKind)).size,
    ).toBe(5)
  })

  it('安全弁: 区切り文字や制御文字が入っていても、別の組と同じにはならない', () => {
    // **連結しないので化けようが無い**のがこの形を選んだ理由（`waveBuffer.ts` の
    // `keyOf` が長さを前に置いて避けている問題）。`URLSearchParams` は値ごとに
    // 独立に符号化する。
    const a = parseDiffParams(query({ ...FULL, diffSensorA: 's0|mac:112233445566' }))
    const b = parseDiffParams(query({ ...FULL, diffSensorA: 's0' }))
    expect(a.want?.a.sensorId).toBe('s0|mac:112233445566')
    expect(b.want?.a.sensorId).toBe('s0')
    expect(a.want).not.toEqual(b.want)
  })
})

describe('parseResidualParams（#688）', () => {
  const FULL = { residualStation: 'garage', residualBoard: 'mac:aabbccddeeff', residualSensor: 'i2c0-6a' }
  function query(values: Record<string, string>): URLSearchParams {
    return new URLSearchParams(values)
  }

  it('正: 3 欄そろえば 1 台を指す（基板の書き方は設定と同じ形へ揃える・空白は落とす）', () => {
    expect(parseResidualParams(query({ ...FULL, residualBoard: 'mac:AABBCCDDEEFF', residualSensor: ' i2c0-6a ' }))).toEqual({
      want: { stationId: 'garage', member: { boardKey: 'mac:aabbccddeeff', sensorId: 'i2c0-6a' } },
      problem: null,
      problemKind: null,
    })
  })

  it('対照: 何も書いていなければ頼んでいない（理由も立てない）', () => {
    expect(parseResidualParams(query({ wave: '1' }))).toEqual({ want: null, problem: null, problemKind: null })
  })

  it('安全弁: 半端・空・長すぎ・基板の書き方違いは、ずれなしで理由を返す', () => {
    expect(parseResidualParams(query({ residualStation: 'garage' })).problemKind).toBe('missing-fields')
    expect(parseResidualParams(query({ ...FULL, residualSensor: '  ' })).problemKind).toBe('empty-field')
    expect(parseResidualParams(query({ ...FULL, residualStation: 'x'.repeat(65) })).problemKind).toBe('too-long')
    const bad = parseResidualParams(query({ ...FULL, residualBoard: 'aabbccddeeff' }))
    expect(bad.problemKind).toBe('bad-board-key')
    expect(bad.want).toBeNull()
  })
})

describe('startStatusServer', () => {
  it('/status は組み立てた中身をそのまま返し、横断の許しを付ける', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const res = await fetch(`${base}/status`)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await res.json()) as StatusReport
    expect(body.uptimeSec).toBe(100)
    expect(body.mseed.recordsWritten).toBe(7)
    expect(body.udp.port).toBe(50505)
  })

  it('/stream は震度を押し出す。波形は既定では付かない', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream', 1, () => {
      hub.publish({ kind: 'wave', wave: WAVE })
      hub.publish({ kind: 'reading', reading: READING })
    })

    expect(got).toHaveLength(1)
    expect(got[0].name).toBe('reading')
    expect((got[0].data as IntensityReading).intensity).toBe(2.5)
  })

  it('/stream は観測点ぶんの計測震度（複数センサーの合成）も、SSE イベントとして正しく符号化して押し出す', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream', 1, () => {
      hub.publish({ kind: 'station-reading', reading: STATION_READING })
    })

    expect(got).toHaveLength(1)
    expect(got[0].name).toBe('station-reading')
    expect(got[0].data).toEqual(STATION_READING)
  })

  it('正: 検出した揺れの記録（shake-event）は、波形の粒度を問わず /stream へ押し出す', async () => {
    // 記録は版ごとに 1 件ずつしか出ないので、波形のような粒度の選択に掛けない（`WAVE_TIER` の 'always'）。
    const hub = new ReadingHub()
    const base = await start(hub)
    const event = { id: 'station-1-1700000000000', rev: 2, stationId: 'station-1', verdict: 'quake' } as unknown as ShakeEventRecord

    const got = await readEvents(base, '/stream', 1, () => {
      hub.publish({ kind: 'shake-event', event })
    })

    expect(got).toHaveLength(1)
    expect(got[0].name).toBe('shake-event')
    // 管理コンソールの「波形の記録で開く」が記録を探す札を添える（`wireShakeEvent`）。
    expect(got[0].data).toEqual({ ...event, stationKey: stationFileToken('station-1') })
  })

  it('安全弁: 観測点 ID が文字列でない記録（壊れたファイル）は札を付けずに通す（投げて /events を丸ごと落とさない）', () => {
    const broken = { id: 'x', rev: 1, stationId: 3 } as unknown as ShakeEventRecord
    expect(wireShakeEvent(broken)).toEqual(broken)
    expect(wireShakeEvent({ ...broken, stationId: 'station-1' }).stationKey).toBe(stationFileToken('station-1'))
  })

  // センサー対の差分（#372）。**波形の梯子と直交している**ので、`?wave=` を付けずに
  // 5 欄だけで繋げる。実機ではこのクエリで**毎秒 3.35 件**を実測した
  // （バイト数は README の「状態と押し出しの口」の節が単一情報源）。
  const PAIR_DIFF: SensorPairDiff = {
    stationId: 'garage',
    memberA: { boardKey: 'mac:aabbccddeeff', sensorId: 's0' },
    memberB: { boardKey: 'mac:112233445566', sensorId: 's1' },
    firstSampleIndex: 0,
    firstSampleMs: 1_700_000_000_000,
    msPerSample: 10,
    // 3 列目が null なのは、片方の値が揃わなかったサンプル（外挿しない）。
    diffGal: [[0.1], [0.2], [null]],
  }
  const DIFF_QUERY =
    '/stream?diffStation=garage&diffBoardA=mac:aabbccddeeff&diffSensorA=s0' +
    '&diffBoardB=mac:112233445566&diffSensorB=s1'

  it('正: 波形を頼まなくても、5 欄で頼んだ組の差分は届く（#372）', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, DIFF_QUERY, 1, () => {
      hub.publish({ kind: 'station-diff', diff: PAIR_DIFF })
    })

    expect(got).toHaveLength(1)
    expect(got[0].name).toBe('station-diff')
    // **顔ぶれまで欠けずに届くこと。** 受け手が向きを見分ける唯一の手がかりで、
    // `null`（値が無いサンプル）も潰れずに渡ること。
    expect(got[0].data).toEqual(PAIR_DIFF)
  })

  const RESIDUAL: SensorResidual = {
    stationId: 'garage',
    member: { boardKey: 'mac:aabbccddeeff', sensorId: 'i2c0-6a' },
    firstSampleIndex: 0,
    firstSampleMs: 1_700_000_000_000,
    msPerSample: 10,
    channels: ['HN1', 'HN2'],
    axes: [
      { direction: [1, 0, 0], residualGal: [0.1] },
      { direction: [0, 0.6, 0.8], residualGal: [null] },
    ],
  }

  it('正: 3 欄で頼んだ 1 台のずれは station-residual として届く（#688）', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(
      base,
      '/stream?residualStation=garage&residualBoard=mac:aabbccddeeff&residualSensor=i2c0-6a',
      1,
      () => {
        hub.publish({ kind: 'station-residual', residual: RESIDUAL })
      },
    )

    expect(got).toHaveLength(1)
    expect(got[0].name).toBe('station-residual')
    // 測る向き・軸の名前・null（出せなかった目盛り）まで潰れずに届くこと。
    expect(got[0].data).toEqual(RESIDUAL)
  })

  it('対照: 差分は ?wave=1 だけの相手へは出ない（#372）', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream?wave=1', 1, () => {
      hub.publish({ kind: 'station-diff', diff: PAIR_DIFF })
      hub.publish({ kind: 'wave', wave: WAVE })
    })

    // **梯子に載せていない。** 載せると 36 組ぶんが波形タブへ黙って乗り、**桁が変わる**
    // （量は README の「状態と押し出しの口」の節が単一情報源）。
    expect(got.map((e) => e.name)).toEqual(['wave'])
  })

  it('対照: ずれは頼んでいない相手（?wave=1 だけ）へは出ない（#688）', async () => {
    // **配る相手の選り分けを HTTP の口から通しで見る。** 振り分け自体は `readingHub.test.ts` が
    // 見ているが、ここ（クエリの読み取り → 購読の登録）が崩れても向こうは通る。
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream?wave=1', 1, () => {
      hub.publish({ kind: 'station-residual', residual: RESIDUAL })
      hub.publish({ kind: 'wave', wave: WAVE })
    })
    expect(got.map((e) => e.name)).toEqual(['wave'])
  })

  it('?wave=1 を付けると波形も付く', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream?wave=1', 2, () => {
      hub.publish({ kind: 'wave', wave: WAVE })
      hub.publish({ kind: 'reading', reading: READING })
    })

    expect(got.map((e) => e.name)).toEqual(['wave', 'reading'])
    const data = got[0].data as Record<string, unknown>
    expect(data.gal).toEqual([[1.5], [2.5], [980]])
    // 3 軸なら軸ごとの値は地面の 3 成分と同じ情報なので載せない（通信量が倍になる）。
    expect(data).not.toHaveProperty('axes')
    expect(data).not.toHaveProperty('ground')
    expect(data.channels).toEqual(['HN1', 'HN2', 'HN3'])
  })

  it('正: 2 軸のセンサーの波形は gal を null にし、測る向きと軸ごとの値を載せる', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)
    const twoAxis: WaveChunk = {
      ...WAVE,
      channels: ['HN1', 'HN2'],
      ground: null,
      axes: [
        { direction: [0.866, 0.5, 0], gal: [1.25] },
        { direction: [-0.5, 0.866, 0], gal: [-0.75] },
      ],
    }

    const got = await readEvents(base, '/stream?wave=1', 1, () => {
      hub.publish({ kind: 'wave', wave: twoAxis })
    })

    const data = got[0].data as Record<string, unknown>
    expect(data.gal).toBeNull()
    expect(data.axes).toEqual([
      { direction: [0.866, 0.5, 0], gal: [1.25] },
      { direction: [-0.5, 0.866, 0], gal: [-0.75] },
    ])
    expect(data.channels).toEqual(['HN1', 'HN2'])
    expect(data).not.toHaveProperty('ground')
  })

  it('正: 観測点ぶんの合成波形も、?wave=1 で専用の名前で押し出す（#315）', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream?wave=1', 1, () => {
      hub.publish({ kind: 'station-wave', wave: STATION_WAVE })
    })

    expect(got).toHaveLength(1)
    // **名前を `station-reading` と混ぜない。** 受け手は名前で振り分けるので、
    // 混ざると震度として読もうとして壊れる（`encode` の説明を見ること）。
    expect(got[0].name).toBe('station-wave')
    // 落とした直流・混ざった本数まで欠けずに届くこと。
    expect(got[0].data).toEqual(STATION_WAVE)
  })

  it('対照: 合成波形は、?wave=1 を付けていない相手へは出ない', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream', 1, () => {
      hub.publish({ kind: 'station-wave', wave: STATION_WAVE })
      hub.publish({ kind: 'station-reading', reading: STATION_READING })
    })

    expect(got).toHaveLength(1)
    expect(got[0].name).toBe('station-reading')
  })

  // 波形の粒度（#261 段 0）。揺れ窓の PWA は合成 1 本だけを見るので、
  // センサー単独の波形（実測で毎秒およそ 65 KB）が付いてこない口が要る。
  it('正: ?wave=station は観測点の合成波形を押し出す（#261 段 0）', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream?wave=station', 1, () => {
      hub.publish({ kind: 'station-wave', wave: STATION_WAVE })
    })

    expect(got).toHaveLength(1)
    expect(got[0].name).toBe('station-wave')
    expect(got[0].data).toEqual(STATION_WAVE)
  })

  it('正: ?wave=station へは作り直しの知らせ（station-wave-revised）も押し出す（#597）', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)
    const revised = { stationId: 'garage', fromMs: 1_700_000_000_000, toMs: 1_700_000_030_000 }

    const got = await readEvents(base, '/stream?wave=station', 1, () => {
      hub.publish({ kind: 'station-wave-revised', revised })
    })

    expect(got).toHaveLength(1)
    expect(got[0].name).toBe('station-wave-revised')
    expect(got[0].data).toEqual(revised)
  })

  it('対照: ?wave=station へはセンサー単独の波形が付いてこない', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream?wave=station', 2, () => {
      hub.publish({ kind: 'wave', wave: WAVE })
      hub.publish({ kind: 'station-wave', wave: STATION_WAVE })
      hub.publish({ kind: 'station-reading', reading: STATION_READING })
    })

    // **`wave` が 1 件も混ざらないこと**がこの口を足した目的。混ざると、
    // 合成 1 本を見るだけの端末へ毎秒 65 KB が流れ続ける。
    expect(got.map((e) => e.name)).toEqual(['station-wave', 'station-reading'])
  })

  it('安全弁: 知らない値（?wave=sensor 等）では波形が 1 件も出ない', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream?wave=sensor', 1, () => {
      hub.publish({ kind: 'wave', wave: WAVE })
      hub.publish({ kind: 'station-wave', wave: STATION_WAVE })
      hub.publish({ kind: 'reading', reading: READING })
    })

    // 打ち間違いが `all` へ倒れると、頼んでいない端末へ波形が流れ出す。
    expect(got.map((e) => e.name)).toEqual(['reading'])
  })

  it('正: 読めない ?wave= の値を受けたら 1 行残す', async () => {
    const hub = new ReadingHub()
    const lines: string[] = []
    const details: string[] = []
    const base = await start(hub, undefined, (level, kind, detail, line) => {
      if (kind === 'sse') {
        details.push(detail)
        lines.push(`${level}:${line}`)
      }
    })

    const ctrl = new AbortController()
    await fetch(`${base}/stream?wave=Station`, { signal: ctrl.signal })
    ctrl.abort()

    // **倒したことが `/status` にしか出ないと、繋がっているのに波形が来ない状態が
    // 表示不具合と見分けられない。** 購読の上限で断った回と同じく 1 行残す。
    expect(details).toContain('bad-wave-param')
    expect(lines.some((l) => l.startsWith('warn:') && l.includes('Station'))).toBe(true)
  })

  it('対照: 正しい値・未指定では読めない旨を残さない', async () => {
    const hub = new ReadingHub()
    const details: string[] = []
    const base = await start(hub, undefined, (_level, kind, detail) => {
      if (kind === 'sse') details.push(detail)
    })

    for (const path of ['/stream', '/stream?wave=1', '/stream?wave=all', '/stream?wave=station']) {
      const ctrl = new AbortController()
      await fetch(`${base}${path}`, { signal: ctrl.signal })
      ctrl.abort()
    }

    // ここが残ると、普段の接続で警告が出続けて本物の打ち間違いが埋もれる。
    expect(details).not.toContain('bad-wave-param')
  })

  it('安全弁: 記録へ出す値は制御文字を潰し、長さを切る', async () => {
    const hub = new ReadingHub()
    const lines: string[] = []
    const base = await start(hub, undefined, (_level, kind, _detail, line) => {
      if (kind === 'sse') lines.push(line)
    })

    // 改行を混ぜて記録へ偽の 1 行を差し込もうとする値と、上限より長い値。
    const ctrl = new AbortController()
    await fetch(`${base}/stream?wave=${encodeURIComponent('x\n[sse] 偽の行')}`, { signal: ctrl.signal })
    ctrl.abort()
    const ctrl2 = new AbortController()
    await fetch(`${base}/stream?wave=${'z'.repeat(100)}`, { signal: ctrl2.signal })
    ctrl2.abort()

    const bad = lines.filter((l) => l.includes('?wave= を読めない'))
    expect(bad).toHaveLength(2)
    // **1 行に収まっていること。** 改行が通ると、記録を読む側には別の出来事に見える。
    expect(bad.every((l) => !l.includes('\n'))).toBe(true)
    // 長すぎる値は削って印を付ける（記録に要るのは「何を渡されたか」が分かる程度）。
    expect(bad.some((l) => l.includes('…'))).toBe(true)
    expect(bad.every((l) => l.length < 200)).toBe(true)
  })

  it('安全弁: ?wave=1 はこれまでどおりセンサー単独も合成も出す（管理コンソール）', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream?wave=1', 2, () => {
      hub.publish({ kind: 'wave', wave: WAVE })
      hub.publish({ kind: 'station-wave', wave: STATION_WAVE })
    })

    // 管理コンソールの波形タブ（`src/admin/waveStream.ts`）がこの値で繋いでいる。**狭めない。**
    expect(got.map((e) => e.name)).toEqual(['wave', 'station-wave'])
  })

  it('上限に達したら 503 で断り、上限の値を伝える。こちら側にも 1 行残す', async () => {
    const hub = new ReadingHub({ maxSubscribers: 1 })
    // **断りはこちらの記録にしか残らない。** 503 は向こうの記録になるので、
    // ここで出さないと `/status` を見に来ない運用では上限に張り付いても気づけない。
    const logged: { kind: string; detail: string }[] = []
    const base = await start(hub, undefined, (_level, kind, detail) =>
      logged.push({ kind, detail }),
    )
    const first = new AbortController()
    running.abort.push(first)
    await fetch(`${base}/stream`, { signal: first.signal })

    const res = await fetch(`${base}/stream`)

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'too-many-subscribers', limit: 1 })
    expect(logged).toContainEqual({ kind: 'sse', detail: 'rejected' })
  })

  it('先回りの問い合わせに答える。プライベート網は訊かれたときだけ許す', async () => {
    const base = await start(new ReadingHub())

    const asked = await fetch(`${base}/stream`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Private-Network': 'true' },
    })
    expect(asked.status).toBe(204)
    expect(asked.headers.get('access-control-allow-private-network')).toBe('true')

    const plain = await fetch(`${base}/stream`, { method: 'OPTIONS' })
    expect(plain.headers.get('access-control-allow-private-network')).toBeNull()
  })

  it('/healthz は状態を組み立てずに答える（基板の生存確認の口）', async () => {
    const hub = new ReadingHub()
    // **状態の組み立てが壊れていても答える。** 基板が知りたいのは「処理が回っているか」で、
    // `/status` の中身ではない。ここで組み立てると、壊れた状態の口に引きずられて
    // 基板が「止まっている」と読み、返事が途絶えても段を上げなくなる。
    const base = await start(hub, () => {
      throw new Error('組み立てに失敗')
    })

    const res = await fetch(`${base}/healthz`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('知らない経路は 404、GET 以外は 405', async () => {
    const base = await start(new ReadingHub())

    expect((await fetch(`${base}/nope`)).status).toBe(404)
    expect((await fetch(`${base}/status`, { method: 'POST' })).status).toBe(405)
  })

  it('状態を作れなくても落ちず、500 を返す', async () => {
    const hub = new ReadingHub()
    const base = await start(hub, () => {
      throw new Error('組み立てに失敗')
    })

    const res = await fetch(`${base}/status`)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    // **受信そのものは止まらない。** 次の要求に答えられる。
    expect((await fetch(`${base}/nope`)).status).toBe(404)
  })

  it('記録の口が投げても応答を返し、受信そのものは止まらない', async () => {
    const hub = new ReadingHub()
    const base = await start(
      hub,
      () => {
        throw new Error('組み立てに失敗')
      },
      () => {
        throw new Error('記録が壊れた')
      },
    )

    const res = await fetch(`${base}/status`)

    // **記録を握らないと、応答を返す処理まで到達しない。** 例外は Node の
    // リクエストハンドラを抜け、既定では**この受け手のプロセスごと落ちる**。
    expect(res.status).toBe(500)
    expect((await fetch(`${base}/nope`)).status).toBe(404)
  })

  it('記録の口が投げても押し出しは畳める', async () => {
    const hub = new ReadingHub()
    const base = await start(hub, undefined, () => {
      throw new Error('記録が壊れた')
    })
    const held = new AbortController()
    running.abort.push(held)
    await fetch(`${base}/stream`, { signal: held.signal })
    expect(hub.openCount).toBe(1)

    const server = running.server
    running.server = null
    await server?.close()

    // 締めくくりは `onDetach` の中で記録を出す。握らないとそこで抜け、
    // 向こうのソケットが開いたまま残って `server.close()` が返らない。
    expect(hub.openCount).toBe(0)
  })

  it('押し出しを張ったままでも締めくくりが返る', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)
    const held = new AbortController()
    running.abort.push(held)
    await fetch(`${base}/stream`, { signal: held.signal })
    expect(hub.openCount).toBe(1)

    // **押し出しを先に切らないと、ここで永久に返らない。**
    const server = running.server
    running.server = null
    await server?.close()

    expect(hub.openCount).toBe(0)
  })

  it('生存確認は渡した間隔で飛ぶ', async () => {
    const hub = new ReadingHub()
    // **既定（15 秒）では測れない。** この差し替えが効いていることまで見る ——
    // 効いていなければ 3 秒の待ちに 1 件も現れない。
    const base = await start(hub, undefined, undefined, 20)

    const raw = await readRawUntil(base, '/stream', ': ping')

    expect(raw).toContain(': ping')
  })

  it('相手が切れば枠が返る', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)
    const a = new AbortController()
    await fetch(`${base}/stream`, { signal: a.signal })
    expect(hub.openCount).toBe(1)

    a.abort()
    const deadline = Date.now() + 2_000
    while (hub.openCount > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))

    expect(hub.openCount).toBe(0)
  })
})

describe('/admin（管理コンソール本体・#313 段 C）', () => {
  it('正: GET /admin が HTML を返す', async () => {
    const base = await start(new ReadingHub())
    const res = await fetch(`${base}/admin`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toBe(TEST_ADMIN_CONSOLE.html)
  })

  it('正: GET /admin/app.js が JS を返す', async () => {
    const base = await start(new ReadingHub())
    const res = await fetch(`${base}/admin/app.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(await res.text()).toBe(TEST_ADMIN_CONSOLE.js)
  })

  // **対照**: ビルド失敗（`adminConsole: null`）のとき、`/admin` は 503 を返す
  // ——`/status`・`/stream`・`/api/*` を巻き込まないことは別に確認する。
  it('対照: adminConsole が null（ビルド失敗）なら /admin は 503', async () => {
    const base = await start(new ReadingHub(), undefined, undefined, undefined, undefined, undefined, null)
    const res = await fetch(`${base}/admin`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'admin-console-unavailable' })
  })

  it('安全弁: adminConsole が null でも /admin/app.js は 503 で応じる（404 ではない）', async () => {
    const base = await start(new ReadingHub(), undefined, undefined, undefined, undefined, undefined, null)
    const res = await fetch(`${base}/admin/app.js`)
    expect(res.status).toBe(503)
  })

  it('安全弁: adminConsole が null でも /status は普段どおり応じる', async () => {
    const hub = new ReadingHub()
    const base = await start(hub, undefined, undefined, undefined, undefined, undefined, null)
    const res = await fetch(`${base}/status`)
    expect(res.status).toBe(200)
  })
})

describe('/api/*', () => {
  const TOKEN = 'super-secret-token'
  const ORIGIN = 'https://console.example.ts.net'

  /**
   * `Host` の許可リストにはリッスンするポートが要るが、`port: 0` は開いてみるまで
   * 実ポートが分からない。**先に空きポートを 1 つ確保し、そのポートで確実に開く**
   * ことで、起動前に `allowedHosts` を組み立てられるようにする（ポートの奪い合いは
   * 理論上あり得るが、テスト用途としては許容する）。
   */
  async function getFreePort(): Promise<number> {
    const { createServer: createNetServer } = await import('node:net')
    return new Promise((resolve, reject) => {
      const probe = createNetServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address()
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0
        probe.close(() => resolve(port))
      })
    })
  }

  /** 認証あり・許可済み Host/Origin で待ち受けを開く。 */
  async function startAuthed(
    hub: ReadingHub,
    overrides: Partial<AdminAuthConfig> = {},
    log?: StatusServerOptions['log'],
    stationConfig?: StatusServerOptions['stationConfig'],
    readRestWindows: StatusServerOptions['readRestWindows'] = () => NO_REST_WINDOWS,
    requestShutdown: StatusServerOptions['requestShutdown'] = () => 'not-ready',
    records: StatusServerOptions['records'] = null,
    requestRewave: StatusServerOptions['requestRewave'] = () => ({ kind: 'busy' }),
    storage: StatusServerOptions['storage'] = NO_STORAGE,
  ): Promise<string> {
    const port = await getFreePort()
    const adminAuth: AdminAuthConfig = {
      token: TOKEN,
      allowedHosts: [`127.0.0.1:${port}`],
      allowedOrigins: [ORIGIN],
      ...overrides,
    }
    const server = await startStatusServer({
      port,
      address: '127.0.0.1',
      hub,
      status: () => report(hub),
      adminAuth,
      log,
      stationConfig: stationConfig ?? makeStationConfigOps(),
      readRestWindows,
      requestShutdown,
      requestRewave,
      adminConsole: TEST_ADMIN_CONSOLE,
      readWaves: null,
      readEvents: null,
      records,
      storage,
    })
    running.server = server
    return `http://127.0.0.1:${server.port}`
  }

  it('トークンが未設定なら 503（既定の NO_ADMIN_AUTH）', async () => {
    const base = await start(new ReadingHub())
    const res = await fetch(`${base}/api/config`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'not-configured' })
  })

  it('トークン無しなら 401', async () => {
    const base = await startAuthed(new ReadingHub())
    const res = await fetch(`${base}/api/config`, { headers: { Origin: ORIGIN } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'missing-authorization' })
  })

  describe('parseRewaveRequest', () => {
    const NOW = 1_790_001_000_000
    const ok = { stationId: 'st', fromMs: NOW - 600_000, toMs: NOW - 60_000, noiseDensity: 'historical' }

    it('正: 揃った本文はそのまま受ける', () => {
      expect(parseRewaveRequest(ok, NOW)).toEqual({ ok: true, request: ok })
    })

    it('対照: 未来の区間・逆向きの区間・整数でない時刻は断る', () => {
      expect(parseRewaveRequest({ ...ok, toMs: NOW + 1 }, NOW)).toEqual({ ok: false, error: 'range-in-future' })
      expect(parseRewaveRequest({ ...ok, fromMs: ok.toMs }, NOW)).toEqual({ ok: false, error: 'bad-range' })
      expect(parseRewaveRequest({ ...ok, fromMs: 1.5 }, NOW)).toEqual({ ok: false, error: 'bad-range' })
    })

    it('安全弁: 上限より長い区間と、ノイズ密度の取り方の書き忘れは断る（既定へ倒さない）', () => {
      expect(parseRewaveRequest({ ...ok, fromMs: ok.toMs - REWAVE_REQUEST_MAX_MS - 1 }, NOW)).toEqual({ ok: false, error: 'range-too-wide' })
      expect(parseRewaveRequest({ ...ok, noiseDensity: undefined }, NOW)).toEqual({ ok: false, error: 'noise-density-required' })
      expect(parseRewaveRequest([], NOW)).toEqual({ ok: false, error: 'body-not-object' })
      expect(parseRewaveRequest({ ...ok, stationId: '' }, NOW)).toEqual({ ok: false, error: 'station-required' })
    })
  })

  describe('合成波形の作り直しの依頼（POST /api/rewave）', () => {
    const authed = { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'Content-Type': 'application/json' }
    const body = { stationId: 'station-1', fromMs: 1_790_000_000_000, toMs: 1_790_000_600_000, noiseDensity: 'current' }

    it('正: 認証つきの POST を受けたら、依頼をそのまま渡して 202 と件数を返し、1 行残す', async () => {
      const seen: unknown[] = []
      const lines: string[] = []
      const base = await startAuthed(new ReadingHub(), {}, (_l, _k, _d, line) => lines.push(line), undefined, undefined, undefined, null, (r) => {
        seen.push(r)
        return { kind: 'accepted', jobs: 4, skippedMs: 65_000 }
      })
      const res = await fetch(`${base}/api/rewave`, { method: 'POST', headers: authed, body: JSON.stringify(body) })
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ status: 'queued', jobs: 4, skippedMs: 65_000 })
      expect(seen).toEqual([body])
      expect(lines.some((l) => l.includes('作り直しを受けた') && l.includes('いまの設定'))).toBe(true)
    })

    it('前の依頼が残っていれば 409、観測点が無ければ 404、設定の履歴を読めていなければ 503', async () => {
      for (const [kind, status] of [['busy', 409], ['unknown-station', 404], ['config-unknown', 503]] as const) {
        const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, undefined, null, () => ({ kind }))
        const res = await fetch(`${base}/api/rewave`, { method: 'POST', headers: authed, body: JSON.stringify(body) })
        expect(res.status).toBe(status)
      }
    })

    it('安全弁: 作り直せる区間が無ければ 202 ではなく 200 の nothing-to-do を返し、受けた行は残さない', async () => {
      const lines: string[] = []
      const base = await startAuthed(new ReadingHub(), {}, (_l, _k, _d, line) => lines.push(line), undefined, undefined, undefined, null, () => ({
        kind: 'nothing-to-do',
        skippedMs: 600_000,
      }))
      const res = await fetch(`${base}/api/rewave`, { method: 'POST', headers: authed, body: JSON.stringify(body) })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'nothing-to-do', jobs: 0, skippedMs: 600_000 })
      expect(lines.some((l) => l.includes('作り直しを受けた'))).toBe(false)
    })

    it('対照: GET では積まない、読めない本文は 400（呼ばない）', async () => {
      let calls = 0
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, undefined, null, () => {
        calls += 1
        return { kind: 'accepted', jobs: 0, skippedMs: 0 }
      })
      expect((await fetch(`${base}/api/rewave`, { headers: authed })).status).toBe(405)
      const bad = await fetch(`${base}/api/rewave`, { method: 'POST', headers: authed, body: JSON.stringify({ ...body, noiseDensity: undefined }) })
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: 'noise-density-required' })
      expect(calls).toBe(0)
    })
  })

  describe('保存先（/api/storage）', () => {
    const authed = { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN }
    function fakeStorage(overrides: Partial<StatusServerOptions['storage']> = {}) {
      const calls = { set: [] as (string | null)[], purge: 0, abandon: 0 }
      const ops: StatusServerOptions['storage'] = {
        get: () => ({ source: 'default' }) as unknown as ReturnType<StatusServerOptions['storage']['get']>,
        setPending: async (root) => {
          calls.set.push(root)
          return { ok: true }
        },
        purgeOld: async () => {
          calls.purge += 1
          return { ok: true }
        },
        abandonMigration: async () => {
          calls.abandon += 1
          return { ok: true }
        },
        ...overrides,
      }
      return { ops, calls }
    }
    const start = (ops: StatusServerOptions['storage'], log?: StatusServerOptions['log']) =>
      startAuthed(new ReadingHub(), {}, log, undefined, undefined, undefined, null, undefined, ops)

    it('GET は今の保存先と容量を返す', async () => {
      const { ops } = fakeStorage()
      const base = await start(ops)
      const res = await fetch(`${base}/api/storage`, { headers: authed })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ source: 'default' })
    })

    it('正: PUT で次の起動で使う保存先を受け、1 行残す', async () => {
      const { ops, calls } = fakeStorage()
      const lines: string[] = []
      const base = await start(ops, (_l, _k, _d, line) => lines.push(line))
      const res = await fetch(`${base}/api/storage`, {
        method: 'PUT',
        headers: { ...authed, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingDataRoot: 'D:\\seismo' }),
      })
      expect(res.status).toBe(200)
      expect(calls.set).toEqual(['D:\\seismo'])
      expect(lines.some((l) => l.includes('次の起動で使う保存先'))).toBe(true)
    })

    it('null で待っている変更を取り消せる・形の違う本文は 400', async () => {
      const { ops, calls } = fakeStorage()
      const base = await start(ops)
      const put = (body: unknown) =>
        fetch(`${base}/api/storage`, { method: 'PUT', headers: { ...authed, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      expect((await put({ pendingDataRoot: null })).status).toBe(200)
      expect((await put({ pendingDataRoot: 3 })).status).toBe(400)
      expect((await put({})).status).toBe(400)
      expect(calls.set).toEqual([null])
    })

    it('受け付けられない理由は、複製中・環境変数は 409、それ以外は 400 で返す', async () => {
      const problems = ['migrating', 'nested'] as const
      let i = 0
      const { ops } = fakeStorage({ setPending: async () => ({ ok: false, problem: problems[i++]! }) })
      const base = await start(ops)
      const put = () =>
        fetch(`${base}/api/storage`, {
          method: 'PUT',
          headers: { ...authed, 'Content-Type': 'application/json' },
          body: JSON.stringify({ pendingDataRoot: 'D:\\x' }),
        })
      const a = await put()
      expect(a.status).toBe(409)
      expect(((await a.json()) as { error: string }).error).toBe('migrating')
      const b = await put()
      expect(b.status).toBe(400)
      expect(((await b.json()) as { error: string }).error).toBe('nested')
    })

    it('古い場所を消すのは POST だけ（GET で開いただけでは消さない）', async () => {
      const { ops, calls } = fakeStorage()
      const base = await start(ops)
      expect((await fetch(`${base}/api/storage/purge-old`, { headers: authed })).status).toBe(405)
      expect(calls.purge).toBe(0)
      const res = await fetch(`${base}/api/storage/purge-old`, { method: 'POST', headers: authed })
      // 消し終わるのを待たずに受け付ける（何時間もかかりうる。進み具合は GET /api/storage で見る）
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ started: true })
      expect(calls.purge).toBe(1)
    })

    it('安全弁: トークンが無ければ消さない', async () => {
      const { ops, calls } = fakeStorage()
      const base = await start(ops)
      const res = await fetch(`${base}/api/storage/purge-old`, { method: 'POST', headers: { Origin: ORIGIN } })
      expect(res.status).toBe(401)
      expect(calls.purge).toBe(0)
    })

    it('複製をやめるのは認証つきの POST だけ（GET・トークン無しではやめない）', async () => {
      const { ops, calls } = fakeStorage()
      const base = await start(ops)
      expect((await fetch(`${base}/api/storage/abandon-migration`, { headers: authed })).status).toBe(405)
      expect((await fetch(`${base}/api/storage/abandon-migration`, { method: 'POST', headers: { Origin: ORIGIN } })).status).toBe(401)
      expect(calls.abandon).toBe(0)
      const res = await fetch(`${base}/api/storage/abandon-migration`, { method: 'POST', headers: authed })
      expect(res.status).toBe(200)
      expect(calls.abandon).toBe(1)
    })

    it('対照: やめる理由が無ければ 409 で断る', async () => {
      const { ops } = fakeStorage({ abandonMigration: async () => ({ ok: false, reason: 'not-missing' }) })
      const base = await start(ops)
      const res = await fetch(`${base}/api/storage/abandon-migration`, { method: 'POST', headers: authed })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'not-missing' })
    })
  })

  describe('止める合図（POST /api/shutdown）', () => {
    const authed = { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN }

    it('正: 認証つきの POST を受けたら、締めくくりを頼んで 202 を返す', async () => {
      let calls = 0
      const lines: string[] = []
      const base = await startAuthed(new ReadingHub(), {}, (_l, _k, _d, line) => lines.push(line), undefined, undefined, () => {
        calls += 1
        return 'accepted'
      })
      const res = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: authed })
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ status: 'closing' })
      expect(calls).toBe(1)
      // 落ちた記録と見分けるため、誰が止めたかを 1 行残す。
      expect(lines.some((l) => l.includes('止める合図を受けた'))).toBe(true)
    })

    it('締めくくりの途中なら 202 で already-closing と返す（2 度目を走らせるかは実体が決める）', async () => {
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, () => 'already-closing')
      const res = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: authed })
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ status: 'already-closing' })
    })

    it('起動の途中で段取りが揃っていなければ 503', async () => {
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, () => 'not-ready')
      const res = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: authed })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'not-ready' })
    })

    it('対照: GET では止めない（リンクを開いただけ・先読みで止まらない）', async () => {
      let calls = 0
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, () => {
        calls += 1
        return 'accepted'
      })
      const res = await fetch(`${base}/api/shutdown`, { headers: authed })
      expect(res.status).toBe(405)
      expect(calls).toBe(0)
    })

    it('安全弁: トークンが無ければ 401 で、締めくくりは頼まない', async () => {
      let calls = 0
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, () => {
        calls += 1
        return 'accepted'
      })
      const res = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { Origin: ORIGIN } })
      expect(res.status).toBe(401)
      expect(calls).toBe(0)
    })

    it('安全弁: 許していない Origin からは 403 で、締めくくりは頼まない', async () => {
      let calls = 0
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, () => {
        calls += 1
        return 'accepted'
      })
      const res = await fetch(`${base}/api/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.example' },
      })
      expect(res.status).toBe(403)
      expect(calls).toBe(0)
    })
  })

  it('トークンが違えば 401', async () => {
    const base = await startAuthed(new ReadingHub())
    const res = await fetch(`${base}/api/config`, {
      headers: { Authorization: 'Bearer wrong', Origin: ORIGIN },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid-token' })
  })

  describe('保存した波形の読み返し（GET /api/records/*）', () => {
    const authed = { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN }

    it('正: 後ろの経路と問い合わせをそのまま渡し、返した状態と本文で答える', async () => {
      const seen: Array<[string, string]> = []
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, undefined, async (route, params) => {
        seen.push([route, params.toString()])
        return { status: 400, body: { error: 'bad-range' } }
      })
      const res = await fetch(`${base}/api/records/envelope?channel=x&from=1&to=2`, { headers: authed })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad-range' })
      expect(seen).toEqual([['envelope', 'channel=x&from=1&to=2']])
    })

    it('対照: GET 以外は渡さずに 405', async () => {
      let calls = 0
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, undefined, async () => {
        calls += 1
        return { status: 200, body: {} }
      })
      const res = await fetch(`${base}/api/records/channels`, { method: 'POST', headers: authed })
      expect(res.status).toBe(405)
      expect(calls).toBe(0)
    })

    it('読み手を持たない構成は 503（「記録が 0 件」と区別させる）', async () => {
      const base = await startAuthed(new ReadingHub(), {})
      const res = await fetch(`${base}/api/records/channels`, { headers: authed })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'records-not-configured' })
    })

    it('安全弁: トークンが無ければ 401 で、読み手は呼ばない', async () => {
      let calls = 0
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, undefined, async () => {
        calls += 1
        return { status: 200, body: {} }
      })
      const res = await fetch(`${base}/api/records/channels`, { headers: { Origin: ORIGIN } })
      expect(res.status).toBe(401)
      expect(calls).toBe(0)
    })

    it('正: 答える前に見に来た側が切ったら、読み手へ渡した signal が立つ', async () => {
      let seen: AbortSignal | null = null
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, undefined, async (_route, _params, signal) => {
        seen = signal
        await held
        return { status: 200, body: {} }
      })
      const client = new AbortController()
      const pending = fetch(`${base}/api/records/channels`, { headers: authed, signal: client.signal }).catch(() => null)
      await vi.waitFor(() => expect(seen).not.toBeNull())
      expect(seen!.aborted).toBe(false)
      client.abort()
      await vi.waitFor(() => expect(seen!.aborted).toBe(true))
      release()
      await pending
    })

    it('対照: 書き終えた要求の signal は、繋がりが閉じても立たない', async () => {
      let seen: AbortSignal | null = null
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, undefined, async (_route, _params, signal) => {
        seen = signal
        return { status: 200, body: { ok: true } }
      })
      const res = await fetch(`${base}/api/records/channels`, { headers: authed })
      expect(await res.json()).toEqual({ ok: true })
      expect(seen!.aborted).toBe(false)
    })

    it('/api/records/ だけ（後ろが空）は 404', async () => {
      const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, undefined, undefined, async () => ({ status: 200, body: {} }))
      const res = await fetch(`${base}/api/records/`, { headers: authed })
      expect(res.status).toBe(404)
    })
  })

  it('正: GET /api/rest-windows はホストの時刻・窓の長さと、センサーごとの静止窓・いまの静止の始まり・溜めかけの窓を返す', async () => {
    const report = {
      nowMs: 40_000,
      windowMs: 30_000,
      sensors: [
        {
          boardKey: 'mac:aa' as const,
          sensorId: 'i2c0-68',
          stillSinceMs: 0,
          pending: { fromMs: 30_000, sampleCount: 1000, still: true, voided: false },
          windows: [{ fromMs: 0, atMs: 1, streamKey: 'k', sampleCount: 3000, meanGal: [1, 2, 980] as const, sdGal: [1, 1, 1.5] as const }],
        },
      ],
    }
    const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, () => report)
    const res = await fetch(`${base}/api/rest-windows`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(report)
  })

  it('安全弁: /api/rest-windows も認証を通す（トークン無しは 401）', async () => {
    const base = await startAuthed(new ReadingHub(), {}, undefined, undefined, () => {
      throw new Error('認証の前に読んではいけない')
    })
    const res = await fetch(`${base}/api/rest-windows`, { headers: { Origin: ORIGIN } })
    expect(res.status).toBe(401)
  })

  it('対照: /api/rest-windows へ GET 以外は 405', async () => {
    const base = await startAuthed(new ReadingHub())
    const res = await fetch(`${base}/api/rest-windows`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      body: '{}',
    })
    expect(res.status).toBe(405)
  })

  it('トークン・Host・Origin が全て正しければ通り、まだ口が無いので 404', async () => {
    const base = await startAuthed(new ReadingHub())
    const res = await fetch(`${base}/api/config`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
    })
    expect(res.status).toBe(404)
  })

  it('Origin が許可リストに無ければ 403', async () => {
    const base = await startAuthed(new ReadingHub())
    const res = await fetch(`${base}/api/config`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'origin-not-allowed' })
  })

  it('Host が許可リストに無ければ 403（DNS rebinding 対策）', async () => {
    const base = await startAuthed(new ReadingHub())
    const res = await requestWithHost(base, '/api/config', 'evil.example.com', {
      Authorization: `Bearer ${TOKEN}`,
      Origin: ORIGIN,
    })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body).error).toBe('host-not-allowed')
  })

  it('preflight（OPTIONS）は認証を見ず、許可された Origin なら 204 を返す', async () => {
    const base = await startAuthed(new ReadingHub())
    const res = await fetch(`${base}/api/config`, { method: 'OPTIONS', headers: { Origin: ORIGIN } })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('preflight でも許可されていない Origin には Access-Control-Allow-Origin を返さない', async () => {
    const base = await startAuthed(new ReadingHub())
    const res = await fetch(`${base}/api/config`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  // **Vary は一致・不一致どちらでも付ける**（間に挟まる代理が Origin ごとの
  // 応答差を無視してキャッシュするのを防ぐ）。
  it('Origin が許可リストに無くても Vary: Origin は付く', async () => {
    const base = await startAuthed(new ReadingHub())
    const res = await fetch(`${base}/api/config`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example.com' },
    })
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('認証に失敗すると 1 行ログへ出す', async () => {
    const lines: string[] = []
    const base = await startAuthed(new ReadingHub(), {}, (level, kind, detail) => {
      lines.push(`${level}/${kind}/${detail}`)
    })
    await fetch(`${base}/api/config`, {
      headers: { Authorization: 'Bearer wrong', Origin: ORIGIN },
    })
    expect(lines).toContain('warn/admin/invalid-token')
  })

  it('/status・/stream は認証を持たず、これまでどおり応答する（安全弁）', async () => {
    const base = await startAuthed(new ReadingHub())
    const res = await fetch(`${base}/status`)
    expect(res.status).toBe(200)
  })

  describe('/api/stations・/api/boards（#313 段 B）', () => {
    const STATION_BODY = { displayName: '書斎', lat: 35.6, lon: 139.7 }
    const BOARD_KEY = 'mac:020000000003'

    it('正: GET /api/stations は空の一覧から始まる', async () => {
      const base = await startAuthed(new ReadingHub())
      const res = await fetch(`${base}/api/stations`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ stations: [] })
    })

    it('正: PUT /api/stations/:stationId で新規作成でき、GET でも見える', async () => {
      const base = await startAuthed(new ReadingHub())
      const put = await fetch(`${base}/api/stations/study`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(STATION_BODY),
      })
      expect(put.status).toBe(200)
      expect(await put.json()).toEqual({ station: { stationId: 'study', ...STATION_BODY } })

      const get = await fetch(`${base}/api/stations`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      })
      expect(await get.json()).toEqual({ stations: [{ stationId: 'study', ...STATION_BODY }] })
    })

    it('正: 同じ stationId への PUT は置き換える（upsert）', async () => {
      const base = await startAuthed(new ReadingHub())
      const put = (body: unknown): Promise<Response> =>
        fetch(`${base}/api/stations/study`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            Origin: ORIGIN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        })
      await put(STATION_BODY)
      const second = await put({ displayName: '車庫', lat: 35.7, lon: 139.8 })
      expect(second.status).toBe(200)

      const get = await fetch(`${base}/api/stations`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      })
      const body = (await get.json()) as { stations: unknown[] }
      // **置き換わる。** 2 件に増えない——upsert であって追加ではない。
      expect(body.stations).toHaveLength(1)
      expect(body.stations[0]).toEqual({ stationId: 'study', displayName: '車庫', lat: 35.7, lon: 139.8 })
    })

    it('正: 置き換えても観測点の並びは動かない（末尾へ付け直さない）', async () => {
      const ops = makeStationConfigOps({
        stations: [
          { stationId: 'study', ...STATION_BODY },
          { stationId: 'garage', ...STATION_BODY },
        ],
        boards: [],
      })
      const base = await startAuthed(new ReadingHub(), {}, undefined, ops)
      const res = await fetch(`${base}/api/stations/study`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(STATION_BODY),
      })
      expect(res.status).toBe(200)
      expect(ops.get().stations.map((s) => s.stationId)).toEqual(['study', 'garage'])
    })

    // **敵対的レビューで発見**（HIGH/CRITICAL）: オブジェクトリテラルのスプレッド順序を
    // 誤ると、ボディに紛れ込んだ stationId が URL パスの値を上書きしてしまい、
    // 「URL パスを正とする」という docstring の約束が壊れる。
    it('安全弁: ボディに別の stationId が入っていても無視し、URL パスの値だけが使われる', async () => {
      const base = await startAuthed(new ReadingHub())
      const put = await fetch(`${base}/api/stations/study`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ stationId: 'evil', ...STATION_BODY }),
      })
      expect(put.status).toBe(200)
      expect(await put.json()).toEqual({ station: { stationId: 'study', ...STATION_BODY } })

      const get = await fetch(`${base}/api/stations`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      })
      const body = (await get.json()) as { stations: unknown[] }
      // **`evil` という別 ID の観測点が作られていない。** URL の `study` だけが残る。
      expect(body.stations).toEqual([{ stationId: 'study', ...STATION_BODY }])
    })

    it('対照: 範囲外の緯度は 400・invalid-config で拒む', async () => {
      const base = await startAuthed(new ReadingHub())
      const res = await fetch(`${base}/api/stations/study`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ displayName: '書斎', lat: 999, lon: 139.7 }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('invalid-config')
    })

    it('対照: 壊れた JSON は 400・invalid-json', async () => {
      const base = await startAuthed(new ReadingHub())
      const res = await fetch(`${base}/api/stations/study`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: '{not valid json',
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('invalid-json')
    })

    // **敵対的レビューで発見**（HIGH）: 以前は上限超過時に `req.destroy()` で下層ソケットを
    // 破棄していたため、直後に返そうとした 400 応答がクライアントへ届かず
    // `socket hang up` になっていた（実測で確認）。ソケットを生かしたまま応答できることを
    // ここで固定する。
    it('安全弁: 上限を超えたボディでも 400・body-too-large が正常に返る（接続は切れない）', async () => {
      const base = await startAuthed(new ReadingHub())
      const oversized = JSON.stringify({ displayName: 'x'.repeat(100_000), lat: 35.6, lon: 139.7 })
      const res = await fetch(`${base}/api/stations/study`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: oversized,
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('body-too-large')
    })

    it('正: DELETE /api/stations/:stationId で削除できる', async () => {
      const ops = makeStationConfigOps({
        stations: [{ stationId: 'study', ...STATION_BODY }],
        boards: [],
      })
      const base = await startAuthed(new ReadingHub(), {}, undefined, ops)
      const res = await fetch(`${base}/api/stations/study`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      })
      expect(res.status).toBe(200)
      expect(ops.get().stations).toEqual([])
    })

    it('安全弁: 基板が割り当て済みの観測点は 409 で拒む', async () => {
      const ops = makeStationConfigOps({
        stations: [{ stationId: 'study', ...STATION_BODY }],
        boards: [{ boardKey: BOARD_KEY, stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] }],
      })
      const base = await startAuthed(new ReadingHub(), {}, undefined, ops)
      const res = await fetch(`${base}/api/stations/study`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      })
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toBe('station-in-use')
      // 拒んだのだから、消えていない。
      expect(ops.get().stations).toHaveLength(1)
    })

    it('存在しない stationId の DELETE は 404', async () => {
      const base = await startAuthed(new ReadingHub())
      const res = await fetch(`${base}/api/stations/ghost`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      })
      expect(res.status).toBe(404)
    })

    it('/api/stations への POST は 405', async () => {
      const base = await startAuthed(new ReadingHub())
      const res = await fetch(`${base}/api/stations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      })
      expect(res.status).toBe(405)
    })

    it('正: GET /api/boards は空の一覧から始まる', async () => {
      const base = await startAuthed(new ReadingHub())
      const res = await fetch(`${base}/api/boards`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ boards: [] })
    })

    it('正: PUT /api/boards/:boardKey で新規作成でき、boardKey のコロンを正しく扱う', async () => {
      const ops = makeStationConfigOps({ stations: [{ stationId: 'study', ...STATION_BODY }], boards: [] })
      const base = await startAuthed(new ReadingHub(), {}, undefined, ops)
      const res = await fetch(`${base}/api/boards/${encodeURIComponent(BOARD_KEY)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ stationId: 'study', sensors: [] }),
      })
      expect(res.status).toBe(200)
      expect(ops.get().boards).toEqual([{ boardKey: BOARD_KEY, stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] }])
    })

    // **以前は保存した基板を末尾へ付け直していた**（一覧が保存のたびに入れ替わり、合成の
    // メンバーの並びも動いた。#713）。
    it('正: 既にある基板を保存しても、設定の中の位置は動かない', async () => {
      const second = 'mac:bbbbbbbbbbbb' as const
      const ops = makeStationConfigOps({
        stations: [{ stationId: 'study', ...STATION_BODY }],
        boards: [
          { boardKey: BOARD_KEY, stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] },
          { boardKey: second, stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] },
        ],
      })
      const base = await startAuthed(new ReadingHub(), {}, undefined, ops)
      const res = await fetch(`${base}/api/boards/${encodeURIComponent(BOARD_KEY)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId: 'study', sensors: [] }),
      })
      expect(res.status).toBe(200)
      expect(ops.get().boards.map((b) => b.boardKey)).toEqual([BOARD_KEY, second])
    })

    it('対照: 新しい基板は末尾へ足す', async () => {
      const second = 'mac:bbbbbbbbbbbb' as const
      const ops = makeStationConfigOps({
        stations: [{ stationId: 'study', ...STATION_BODY }],
        boards: [{ boardKey: second, stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] }],
      })
      const base = await startAuthed(new ReadingHub(), {}, undefined, ops)
      await fetch(`${base}/api/boards/${encodeURIComponent(BOARD_KEY)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId: 'study', sensors: [] }),
      })
      expect(ops.get().boards.map((b) => b.boardKey)).toEqual([second, BOARD_KEY])
    })

    // 付け直していた頃は一致する要素を全部除いていたので、重複は保存で解消されていた。
    // 最初の 1 件だけを置き換えると 2 件目が残り、重複の検査で保存が永久に通らなくなる。
    it('安全弁: 同じ基板が 2 件紛れ込んでいても、保存すれば最初の位置へ 1 件に畳む', async () => {
      const second = 'mac:bbbbbbbbbbbb' as const
      const ops = makeStationConfigOps({
        stations: [{ stationId: 'study', ...STATION_BODY }],
        boards: [
          { boardKey: BOARD_KEY, stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] },
          { boardKey: second, stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] },
          { boardKey: BOARD_KEY, stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] },
        ],
      })
      const base = await startAuthed(new ReadingHub(), {}, undefined, ops)
      const res = await fetch(`${base}/api/boards/${encodeURIComponent(BOARD_KEY)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId: 'study', sensors: [] }),
      })
      expect(res.status).toBe(200)
      expect(ops.get().boards.map((b) => b.boardKey)).toEqual([BOARD_KEY, second])
    })

    it('安全弁: ボディに別の boardKey が入っていても無視し、URL パスの値だけが使われる', async () => {
      const ops = makeStationConfigOps({ stations: [{ stationId: 'study', ...STATION_BODY }], boards: [] })
      const base = await startAuthed(new ReadingHub(), {}, undefined, ops)
      const res = await fetch(`${base}/api/boards/${encodeURIComponent(BOARD_KEY)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ boardKey: 'mac:eeeeeeeeeeee', stationId: 'study', sensors: [] }),
      })
      expect(res.status).toBe(200)
      // **`mac:eeeeeeeeeeee` という別の基板が作られていない。** URL の値だけが残る。
      expect(ops.get().boards).toEqual([{ boardKey: BOARD_KEY, stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] }])
    })

    it('対照: 存在しない stationId を指す基板は 400（参照整合性）', async () => {
      const base = await startAuthed(new ReadingHub())
      const res = await fetch(`${base}/api/boards/${encodeURIComponent(BOARD_KEY)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ stationId: 'ghost', sensors: [] }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('invalid-config')
    })

    it('正: DELETE /api/boards/:boardKey で割当を外す（観測点自体は残る）', async () => {
      const ops = makeStationConfigOps({
        stations: [{ stationId: 'study', ...STATION_BODY }],
        boards: [{ boardKey: BOARD_KEY, stationId: 'study', orientation: IDENTITY_MATRIX, sensors: [] }],
      })
      const base = await startAuthed(new ReadingHub(), {}, undefined, ops)
      const res = await fetch(`${base}/api/boards/${encodeURIComponent(BOARD_KEY)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      })
      expect(res.status).toBe(200)
      expect(ops.get().boards).toEqual([])
      expect(ops.get().stations).toHaveLength(1)
    })

    it('安全弁: apply が例外を投げたら 500・save-failed を返す（ランタイムは書き換わらない）', async () => {
      const ops: StatusServerOptions['stationConfig'] = {
        get: () => EMPTY_STATION_CONFIG,
        apply: () => {
          throw new Error('disk full')
        },
      }
      const base = await startAuthed(new ReadingHub(), {}, undefined, ops)
      const res = await fetch(`${base}/api/stations/study`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(STATION_BODY),
      })
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: string }).error).toBe('save-failed')
    })
  })
})

describe('GET /waves（#357）', () => {
  const T0 = Date.parse('2026-09-25T14:00:00.000Z')

  function archived(): ArchivedWaveChunk {
    return {
      firstSampleMs: T0,
      msPerSample: 10,
      gal: [
        Float32Array.from([1, 2, 3]),
        Float32Array.from([4, 5, 6]),
        Float32Array.from([7, 8, 9]),
      ],
      dcGal: [0, 0, 980],
      memberCount: Uint8Array.from([3, 3, 2]),
      revised: false,
    }
  }

  function result(chunks: ArchivedWaveChunk[]): WaveRangeResult {
    return { chunks, filesRead: 1, filesMissing: 0, filesFailed: 0, skippedBytes: 0, truncated: false }
  }

  /** 読み返しを差し替えてサーバーを開く。**位置引数が長いのでここで畳む。** */
  function startWithWaves(readWaves: StatusServerOptions['readWaves'], log?: StatusServerOptions['log']): Promise<string> {
    return start(new ReadingHub(), undefined, log, undefined, undefined, undefined, undefined, readWaves)
  }

  describe('parseWaveQuery', () => {
    function q(search: string): ReturnType<typeof parseWaveQuery> {
      return parseWaveQuery(new URLSearchParams(search))
    }

    it('観測点・範囲・列を読む', () => {
      expect(q(`station=s1&from=${T0}&to=${T0 + 1000}&columns=300`)).toEqual({
        ok: true,
        stationId: 's1',
        fromMs: T0,
        toMs: T0 + 1000,
        columns: 300,
      })
    })

    it('観測点が無ければ弾く', () => {
      expect(q(`from=${T0}&to=${T0 + 1000}`)).toEqual({ ok: false, error: 'station-required' })
    })

    it('10 進の整数でない範囲は弾く', () => {
      // **`Number()` に任せると `0x10` も空文字も通る。**
      expect(q(`station=s1&from=0x10&to=${T0}`)).toEqual({ ok: false, error: 'bad-range' })
      expect(q(`station=s1&from=&to=${T0}`)).toEqual({ ok: false, error: 'bad-range' })
      expect(q(`station=s1&from=1.5&to=${T0}`)).toEqual({ ok: false, error: 'bad-range' })
    })

    it('幅の無い範囲・逆順の範囲は弾く', () => {
      expect(q(`station=s1&from=${T0}&to=${T0}`)).toEqual({ ok: false, error: 'bad-range' })
      expect(q(`station=s1&from=${T0}&to=${T0 - 1}`)).toEqual({ ok: false, error: 'bad-range' })
    })

    it('列を頼めば 10 分まで通す', () => {
      expect(q(`station=s1&from=${T0}&to=${T0 + 600_000}&columns=300`).ok).toBe(true)
      expect(q(`station=s1&from=${T0}&to=${T0 + 600_001}&columns=300`)).toEqual({
        ok: false,
        error: 'range-too-wide',
      })
    })

    it('サンプルのままなら 2 分まで（列で返すときよりずっと狭い）', () => {
      expect(q(`station=s1&from=${T0}&to=${T0 + 120_000}`).ok).toBe(true)
      expect(q(`station=s1&from=${T0}&to=${T0 + 120_001}`)).toEqual({
        ok: false,
        error: 'range-too-wide',
      })
    })

    it('列の数が範囲外なら弾く', () => {
      expect(q(`station=s1&from=${T0}&to=${T0 + 1000}&columns=0`)).toEqual({
        ok: false,
        error: 'bad-columns',
      })
      expect(q(`station=s1&from=${T0}&to=${T0 + 1000}&columns=4097`)).toEqual({
        ok: false,
        error: 'bad-columns',
      })
    })
  })

  describe('buildWaveResponse', () => {
    const query = { ok: true, stationId: 's1', fromMs: T0, toMs: T0 + 100, columns: null } as const

    it('読めなかった量と記録の無い時の数を必ず添える', () => {
      // **これが無いと「揺れていなかった」と「残っていない」が同じ空の配列に見える。**
      const body = buildWaveResponse(
        query,
        {
          chunks: [],
          filesRead: 0,
          filesMissing: 2,
          filesFailed: 1,
          skippedBytes: 7,
          truncated: true,
        },
        true,
      )
      expect(body.filesMissing).toBe(2)
      expect(body.filesFailed).toBe(1)
      expect(body.skippedBytes).toBe(7)
      expect(body.truncated).toBe(true)
    })

    it('いまの設定に無い観測点は、その旨を添えて返す（断りはしない）', () => {
      // **断ると、設定から外した観測点の記録が読めなくなる。** かといって黙ると、
      // 綴り間違いが「その観測点は静かだった」と寸分違わない応答になる。
      const known = buildWaveResponse(query, result([]), true)
      const unknown = buildWaveResponse(query, result([]), false)
      expect(known.stationKnown).toBe(true)
      expect(unknown.stationKnown).toBe(false)
    })

    it('列を頼まれたら列で返す', () => {
      const body = buildWaveResponse({ ...query, columns: 2 }, result([archived()]), true)
      expect(body.columnSpanMs).toBe(50)
      expect((body.columns as unknown[]).length).toBe(2)
      expect(body.chunks).toBeUndefined()
    })

    it('列を頼まれなければサンプルのまま返す', () => {
      const body = buildWaveResponse(query, result([archived()]), true)
      const chunks = body.chunks as { gal: number[][] }[]
      expect(chunks).toHaveLength(1)
      expect(chunks[0].gal[0]).toEqual([1, 2, 3])
      expect(body.columns).toBeUndefined()
    })

    it('欠測は数でない値のまま返す（JSON では null になる）', () => {
      const chunk = archived()
      const holed: ArchivedWaveChunk = {
        ...chunk,
        gal: [Float32Array.from([Number.NaN, 2, 3]), chunk.gal[1], chunk.gal[2]],
      }
      const round = JSON.parse(JSON.stringify(buildWaveResponse(query, result([holed]), true))) as {
        chunks: { gal: (number | null)[][] }[]
      }
      // **埋めない。** 埋めると、そこだけ時間の縮んだ絵になる。
      expect(round.chunks[0].gal[0][0]).toBeNull()
      expect(round.chunks[0].gal[0][1]).toBe(2)
    })
  })

  it('保存を持たない構成では 503（「0 件」とは返さない）', async () => {
    const base = await start(new ReadingHub())
    const res = await fetch(`${base}/waves?station=s1&from=${T0}&to=${T0 + 1000}`)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('wave-archive-unavailable')
  })

  it('範囲が広すぎれば読みにいかずに 400', async () => {
    let called = 0
    const base = await startWithWaves(async () => {
      called += 1
      return result([])
    })
    const res = await fetch(`${base}/waves?station=s1&from=${T0}&to=${T0 + 3_600_000}&columns=300`)
    expect(res.status).toBe(400)
    // **入口で弾く。** 下流へ流すと、その範囲に触れるファイルの数だけ読み込みが出る。
    expect(called).toBe(0)
  })

  it('読み返した中身を返し、横断の許しを付ける（認証は要らない）', async () => {
    const base = await startWithWaves(async (params) => {
      expect(params.stationId).toBe('s1')
      return result([archived()])
    })
    const res = await fetch(`${base}/waves?station=s1&from=${T0 - 1000}&to=${T0 + 1000}&columns=4`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await res.json()) as { columns: unknown[]; hasAnyValue: boolean }
    expect(body.columns).toHaveLength(4)
    expect(body.hasAnyValue).toBe(true)
  })

  it('記録の口が投げても応答を返し、受信そのものは止まらない', async () => {
    // **`.catch()` の中で投げると、同期の `try` には捕まらない** ——
    // `unhandledRejection` としてホストプロセスごと落ちる。記録の口を包むラッパー
    // （`log`）を通していれば、ここは握られて 500 が返る。
    const base = await startWithWaves(
      async () => {
        throw new Error('ディスクが読めない')
      },
      () => {
        throw new Error('記録の口が壊れている')
      },
    )
    const res = await fetch(`${base}/waves?station=s1&from=${T0}&to=${T0 + 1000}`)
    expect(res.status).toBe(500)
    // 落ちていなければ、次の問い合わせにも応じられる。
    expect((await fetch(`${base}/status`)).status).toBe(200)
  })

  it('読み返しが投げたら 500 を返し、1 行残す', async () => {
    const lines: string[] = []
    const base = await startWithWaves(
      async () => {
        throw new Error('ディスクが読めない')
      },
      (_level, _kind, _detail, line) => lines.push(line),
    )
    const res = await fetch(`${base}/waves?station=s1&from=${T0}&to=${T0 + 1000}`)
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toBe('wave-read-failed')
    expect(lines.some((l) => l.includes('ディスクが読めない'))).toBe(true)
  })
})

describe('GET /events（#312）', () => {
  const T = Date.UTC(2026, 9, 3, 4, 27, 0)
  const result = (stationIds: string[]): EventRangeResult => ({
    events: stationIds.map((stationId, i) => ({ id: `${stationId}-${T + i}`, stationId, startMs: T + i, rev: 1 }) as unknown as ShakeEventRecord),
    unreadableFiles: ['2026-10/broken.json'],
    truncated: true,
    coveredFromMs: T - 10,
  })

  it('範囲の揺れを返し、読めなかったファイル・区切ったか・見終えた範囲の頭を添える。絞り込みは読み返しへ渡す', async () => {
    const asked: unknown[] = []
    const base = await start(new ReadingHub(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async (p) => {
      asked.push(p)
      return result(['station-1'])
    })
    const res = await fetch(`${base}/events?from=${T - 1000}&to=${T + 1000}&station=station-1&limit=20&hide=local`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      events: { stationId: string; stationKey: string }[]
      unreadableFiles: string[]
      truncated: boolean
      coveredFromMs: number
      limit: number
    }
    expect(body.events.map((e) => e.stationId)).toEqual(['station-1'])
    // 押し出しと同じく、合成波形の札を添える（観測点を設定から外しても、波形の記録の記録を引ける）。
    expect(body.events.map((e) => e.stationKey)).toEqual([stationFileToken('station-1')])
    expect(body.unreadableFiles).toEqual(['2026-10/broken.json'])
    expect(body.truncated).toBe(true)
    expect(body.coveredFromMs).toBe(T - 10)
    expect(body.limit).toBe(20)
    expect(asked).toEqual([{ fromMs: T - 1000, toMs: T + 1000, limit: 20, stationId: 'station-1', hideLocal: true }])
  })

  it('正: 範囲の広さには上限を置かない（2026-10-07 ユーザー承認。縛るのは件数）', async () => {
    const asked: unknown[] = []
    const base = await start(new ReadingHub(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async (p) => {
      asked.push(p)
      return result([])
    })
    expect((await fetch(`${base}/events?from=0&to=${T + 400 * 86_400_000}`)).status).toBe(200)
    expect(asked).toEqual([{ fromMs: 0, toMs: T + 400 * 86_400_000, limit: 500, stationId: null, hideLocal: false }])
  })

  it('記録を持たない構成なら 503（「揺れが無かった」と区別する）', async () => {
    const base = await start(new ReadingHub())
    const res = await fetch(`${base}/events?from=${T}&to=${T + 1000}`)
    expect(res.status).toBe(503)
  })

  it('範囲が読めないもの・件数の上限が範囲の外のものは 400 で、読みに行かない', async () => {
    let called = 0
    const base = await start(new ReadingHub(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => {
      called++
      return result([])
    })
    expect((await fetch(`${base}/events?from=${T}`)).status).toBe(400)
    expect((await fetch(`${base}/events?from=${T}&to=${T}`)).status).toBe(400)
    expect((await fetch(`${base}/events?from=${T}&to=${T + 1000}&limit=0`)).status).toBe(400)
    expect((await fetch(`${base}/events?from=${T}&to=${T + 1000}&limit=501`)).status).toBe(400)
    expect((await fetch(`${base}/events?from=${T}&to=${T + 1000}&limit=1.5`)).status).toBe(400)
    expect((await fetch(`${base}/events?from=${T}&to=${T + 1000}&hide=quake`)).status).toBe(400)
    expect(called).toBe(0)
  })

  it('parseEventQuery: 観測点を省けば null・件数を省けば上限の 500・隠す指定を省けば隠さない', () => {
    expect(parseEventQuery(new URLSearchParams(`from=1&to=2`))).toEqual({
      ok: true,
      fromMs: 1,
      toMs: 2,
      stationId: null,
      limit: 500,
      hideLocal: false,
    })
  })

  it('対照: 件数の上限ちょうど（500）は通す', () => {
    expect(parseEventQuery(new URLSearchParams(`from=1&to=2&limit=500`))).toMatchObject({ ok: true, limit: 500 })
    expect(parseEventQuery(new URLSearchParams(`from=1&to=2&limit=1`))).toMatchObject({ ok: true, limit: 1 })
  })
})

describe('GET /quake-intensity（#494 段3）', () => {
  const T0 = Date.parse('2026-10-03T04:26:00.000Z')

  /** 0.5 gal の静穏が続く 1 まとまり（`startMs` から `sec` 秒）。 */
  function quietChunk(startMs: number, sec: number): ArchivedWaveChunk {
    const n = sec * 100
    const axis = (k: number): Float32Array => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(i * 0.3 + k))
    return {
      firstSampleMs: startMs,
      msPerSample: 10,
      gal: [axis(0), axis(1), axis(2)],
      dcGal: [0, 0, 980],
      memberCount: new Uint8Array(n).fill(3),
      revised: false,
    }
  }

  function result(chunks: ArchivedWaveChunk[]): WaveRangeResult {
    return { chunks, filesRead: 1, filesMissing: 0, filesFailed: 0, skippedBytes: 0, truncated: false }
  }

  function startWithWaves(readWaves: StatusServerOptions['readWaves'], log?: StatusServerOptions['log']): Promise<string> {
    return start(new ReadingHub(), undefined, log, undefined, undefined, undefined, undefined, readWaves)
  }

  describe('parseQuakeIntensityQuery', () => {
    const q = (s: string): ReturnType<typeof parseQuakeIntensityQuery> => parseQuakeIntensityQuery(new URLSearchParams(s))

    it('観測点と範囲を読む', () => {
      expect(q(`station=s1&from=${T0}&to=${T0 + 60_000}`)).toEqual({ ok: true, stationId: 's1', fromMs: T0, toMs: T0 + 60_000 })
    })

    it('観測点が無ければ弾く', () => {
      expect(q(`from=${T0}&to=${T0 + 1}`)).toEqual({ ok: false, error: 'station-required' })
    })

    it('幅の無い範囲・逆向きの範囲は弾く', () => {
      expect(q(`station=s1&from=${T0}&to=${T0}`)).toEqual({ ok: false, error: 'bad-range' })
      expect(q(`station=s1&from=${T0}&to=${T0 - 1}`)).toEqual({ ok: false, error: 'bad-range' })
    })

    // 対照: 10 分ちょうどは通し、1 ms でも超えたら弾く。
    it('10 分までは通し、超えたら弾く', () => {
      expect(q(`station=s1&from=${T0}&to=${T0 + 600_000}`).ok).toBe(true)
      expect(q(`station=s1&from=${T0}&to=${T0 + 600_001}`)).toEqual({ ok: false, error: 'range-too-wide' })
    })
  })

  it('保存を持たない構成では 503', async () => {
    const base = await start(new ReadingHub())
    const res = await fetch(`${base}/quake-intensity?station=s1&from=${T0}&to=${T0 + 1000}`)
    expect(res.status).toBe(503)
  })

  it('範囲が広すぎれば読みにいかずに 400', async () => {
    let called = 0
    const base = await startWithWaves(async () => {
      called += 1
      return result([])
    })
    const res = await fetch(`${base}/quake-intensity?station=s1&from=${T0}&to=${T0 + 3_600_000}`)
    expect(res.status).toBe(400)
    expect(called).toBe(0)
  })

  it('判定の窓の分だけ手前から読み、2 つの値と読めた量を返す', async () => {
    const asked: { fromMs: number; toMs: number }[] = []
    const base = await startWithWaves(async (params) => {
      asked.push({ fromMs: params.fromMs, toMs: params.toMs })
      return result([quietChunk(T0 - 60_000, 180)])
    })
    const res = await fetch(`${base}/quake-intensity?station=s1&from=${T0}&to=${T0 + 100_000}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    // 1 本目が地震の区間。2 本目は「普段」のための直前 1 時間（地震の区間の手前で止める）
    expect(asked[0]).toEqual({ fromMs: T0 - 60_000, toMs: T0 + 100_000 })
    expect(asked[1].toMs).toBe(T0)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.maxRealtime).toBe('number')
    expect(typeof body.measured).toBe('number')
    expect(body.measuredUnavailable).toBeNull()
    expect(body.gapCount).toBe(0)
    expect(body.filesRead).toBe(1)
    expect(body.stationKnown).toBe(false)
    // 直前 1 時間の記録がほとんど無い（3 区間に満たない）ので、普段は出せない
    expect(body.usualMeasured).toBeNull()
  })

  describe('普段の計測震度', () => {
    /** 地震の区間には 0.5 gal、直前 1 時間には同じ静穏を 1 時間ぶん返す。呼ばれた範囲を控える。 */
    function hourOfQuiet(asked: { fromMs: number; toMs: number }[]): NonNullable<StatusServerOptions['readWaves']> {
      return async (params) => {
        asked.push({ fromMs: params.fromMs, toMs: params.toMs })
        if (params.toMs === T0) return result([quietChunk(params.fromMs, Math.ceil((T0 - params.fromMs) / 1000))])
        return result([quietChunk(T0 - 60_000, 180)])
      }
    }

    it('正: 直前 1 時間に記録があれば普段の値と、使えた区間の数を返す', async () => {
      const asked: { fromMs: number; toMs: number }[] = []
      const base = await startWithWaves(hourOfQuiet(asked))
      const res = await fetch(`${base}/quake-intensity?station=s1&from=${T0}&to=${T0 + 100_000}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(typeof body.usualMeasured).toBe('number')
      expect(body.usualWindowCount).toBe(6)
      expect(body.usualUsedCount).toBe(6)
      // 同じ静穏なので、地震の区間の計測震度とほぼ同じ値になる
      expect(Math.abs((body.usualMeasured as number) - (body.measured as number))).toBeLessThan(0.2)
    })

    it('同じ区間を訊き直されたら、直前 1 時間は読み直さない', async () => {
      const asked: { fromMs: number; toMs: number }[] = []
      const base = await startWithWaves(hourOfQuiet(asked))
      const url = `${base}/quake-intensity?station=s1&from=${T0}&to=${T0 + 100_000}`
      const first = (await (await fetch(url)).json()) as Record<string, unknown>
      const second = (await (await fetch(url)).json()) as Record<string, unknown>
      expect(second.usualMeasured).toBe(first.usualMeasured)
      // 1 回目は地震の区間と直前 1 時間の 2 本、2 回目は地震の区間の 1 本だけ
      expect(asked.filter((a) => a.toMs === T0)).toHaveLength(1)
      expect(asked).toHaveLength(3)
    })

    it('同じ区間を同時に 2 本訊かれても、直前 1 時間は 1 回しか読まない', async () => {
      const asked: { fromMs: number; toMs: number }[] = []
      const inner = hourOfQuiet(asked)
      // 直前 1 時間の読み返しを、2 本目の問い合わせが着くまで止めておく
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let usualCalls = 0
      const base = await startWithWaves(async (params) => {
        if (params.toMs === T0) {
          usualCalls += 1
          await gate
        }
        return inner(params)
      })
      const url = `${base}/quake-intensity?station=s1&from=${T0}&to=${T0 + 100_000}`
      const both = Promise.all([fetch(url), fetch(url)])
      // 2 本とも地震の区間を読み終え、1 本目の「普段」が門で止まるまで待つ
      await vi.waitFor(() => {
        expect(asked.filter((a) => a.toMs !== T0)).toHaveLength(2)
        expect(usualCalls).toBe(1)
      })
      // 2 本目が「普段」の入口へ着くだけの間を置く（合流しなければ、ここで 2 回目の読み返しが始まる）
      await new Promise((resolve) => setTimeout(resolve, 50))
      release()
      const bodies = (await Promise.all((await both).map((r) => r.json()))) as Record<string, unknown>[]
      expect(bodies[0].usualMeasured).toBe(bodies[1].usualMeasured)
      expect(typeof bodies[0].usualMeasured).toBe('number')
      expect(usualCalls).toBe(1)
    })

    // 安全弁: 「普段」が遅い・固まったときに「最大」「計測」を道連れにしない。
    it(
      '安全弁: 直前 1 時間の読み返しが返ってこなくても、上限を過ぎたら普段なしで本体を返す',
      async () => {
        const lines: string[] = []
        const base = await startWithWaves(
          async (params) => {
            if (params.toMs === T0) return new Promise<never>(() => {})
            return result([quietChunk(T0 - 60_000, 180)])
          },
          (_level, kind, _detail, line) => lines.push(`${kind} ${line}`),
        )
        const t0 = Date.now()
        const res = await fetch(`${base}/quake-intensity?station=s1&from=${T0}&to=${T0 + 100_000}`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as Record<string, unknown>
        expect(typeof body.measured).toBe('number')
        expect(body.usualMeasured).toBeNull()
        expect(Date.now() - t0).toBeGreaterThanOrEqual(USUAL_WAIT_MS - 100)
        expect(lines.some((l) => l.startsWith('quake-intensity-usual-slow'))).toBe(true)
      },
      USUAL_WAIT_MS + 10_000,
    )

    it('安全弁: 普段の計算で例外が出ても、本体は 200 で返し、読み返しの失敗と分けて error で残す', async () => {
      const entries: { level: string; kind: string }[] = []
      const base = await startWithWaves(
        async (params) => {
          // 壊れたまとまり（undefined）を混ぜて、計算の側で投げさせる
          if (params.toMs === T0) return result([undefined as unknown as ArchivedWaveChunk])
          return result([quietChunk(T0 - 60_000, 180)])
        },
        (level, kind) => entries.push({ level, kind }),
      )
      const res = await fetch(`${base}/quake-intensity?station=s1&from=${T0}&to=${T0 + 100_000}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(typeof body.measured).toBe('number')
      expect(body.usualMeasured).toBeNull()
      expect(entries).toContainEqual({ level: 'error', kind: 'quake-intensity-usual-compute' })
      expect(entries.some((e) => e.kind === 'quake-intensity-usual')).toBe(false)
    })

    it('安全弁: 直前 1 時間の読み返しが投げても、地震の区間の値は 200 で返し 1 行残す', async () => {
      const lines: string[] = []
      const base = await startWithWaves(
        async (params) => {
          if (params.toMs === T0) throw new Error('古い記録が読めない')
          return result([quietChunk(T0 - 60_000, 180)])
        },
        (_level, _kind, _detail, line) => lines.push(line),
      )
      const res = await fetch(`${base}/quake-intensity?station=s1&from=${T0}&to=${T0 + 100_000}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(typeof body.measured).toBe('number')
      expect(body.usualMeasured).toBeNull()
      expect(body.usualUsedCount).toBe(0)
      expect(lines.some((l) => l.includes('古い記録が読めない'))).toBe(true)
    })
  })

  it('記録が無ければ値を null にして理由を返す（500 にしない）', async () => {
    const base = await startWithWaves(async () => result([]))
    const res = await fetch(`${base}/quake-intensity?station=s1&from=${T0}&to=${T0 + 1000}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.measured).toBeNull()
    expect(body.measuredUnavailable).toBe('no-data')
    expect(body.maxRealtime).toBeNull()
  })

  it('読み返しが投げたら 500 を返し、1 行残す（受信は止まらない）', async () => {
    const lines: string[] = []
    const base = await startWithWaves(
      async () => {
        throw new Error('ディスクが読めない')
      },
      (_level, _kind, _detail, line) => lines.push(line),
    )
    const res = await fetch(`${base}/quake-intensity?station=s1&from=${T0}&to=${T0 + 1000}`)
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toBe('quake-intensity-failed')
    expect(lines.some((l) => l.includes('ディスクが読めない'))).toBe(true)
    expect((await fetch(`${base}/status`)).status).toBe(200)
  })
})
