import { request as httpRequest } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import type { AdminAuthConfig } from './adminAuth'
import type { IntensityReading, WaveChunk } from './intensityPipeline'
import { PacketTally } from './packetTally'
import { ReadingHub } from './readingHub'
import type { FusedWaveChunk, SensorPairDiff, StationIntensityReading } from './sensorFusion'
import { EMPTY_STATION_CONFIG, StationDirectory } from './stationConfig'
import type { StationConfig } from './stationConfig'
import { buildStatusReport } from './statusReport'
import type { RawStoreStatus, StatusReport, WaveArchiveStatus } from './statusReport'
import { buildWaveResponse, parseDiffParams, parseWaveParam, parseWaveQuery, startStatusServer } from './statusServer'
import type { StatusServer, StatusServerOptions } from './statusServer'
import type { ArchivedWaveChunk, WaveRangeResult } from './waveArchive'

const RAW: RawStoreStatus = {
  writeErrors: 0,
  lostRecords: 0,
  slowCloses: 0,
  compressed: 0,
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

const WAVE_ARCHIVE: WaveArchiveStatus = {
  writeErrors: 0,
  lostRecords: 0,
  badChunks: 0,
  written: 0,
  rotated: 0,
  openBooks: 0,
  slowClose: false,
  lastWriteError: null,
}

function report(hub: ReadingHub): StatusReport {
  return buildStatusReport({
    nowMs: 1_700_000_100_000,
    startedAtMs: 1_700_000_000_000,
    udp: { address: '0.0.0.0', port: 50505 },
    udpRecvBuffer: { requestedBytes: 8_388_608, actualBytes: 8_388_608, error: null },
    loopStalls: { thresholdMs: 1000, count: 0, totalMs: 0, longestMs: null, last: null },
    http: { address: '0.0.0.0', port: 50506 },
    tally: new PacketTally().snapshotTotal(),
    sensors: [],
    sensorEvictions: 0,
    boardClocks: { boards: [], evictions: 0 },
    stationEvictions: 0,
    stationIntensities: [],
    gravity: {
      verdicts: [],
      mismatches: 0,
      unjudged: 0,
      restlessWindows: 0,
      restarts: 0,
      evictions: 0,
    },
    segments: [],
    unusableIntensities: 0,
    raw: RAW,
    waveArchive: WAVE_ARCHIVE,
    hub: hub.snapshot(),
    acks: { enabled: true, sent: 0, failures: 0, throttled: 0, lastError: null },
    stations: StationDirectory.empty(),
    stationConfigWarning: null,
    ungroupedMultiBoardStations: [],
    assignedBoards: [],
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
  gal: [[1.5], [2.5], [980]],
}

const STATION_WAVE: FusedWaveChunk = {
  stationId: 'garage',
  driver: { boardKey: 'mac:aa', sensorId: 's0' },
  firstSampleIndex: 0,
  firstSampleMs: 1_700_000_000_000,
  msPerSample: 10,
  gal: [[1.5], [2.5], [0.5]],
  // 落とした直流（`gal` と足せば校正済み gal の重み付き平均になる値）。
  dcGal: [[0], [0], [980]],
  memberCount: [9],
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
    // **`null` を明示的に渡したいテストがあるので `??` は使わない。** `??` だと
    // `null` も「未指定」と同じ扱いになり、ビルド失敗を再現できない。
    adminConsole: adminConsole !== undefined ? adminConsole : TEST_ADMIN_CONSOLE,
    // **既定は `null`（保存を持たない構成）。** 読み返しを試すテストだけが渡す。
    readWaves: readWaves ?? null,
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

describe('startStatusServer', () => {
  it('/status は組み立てた中身をそのまま返し、横断の許しを付ける', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const res = await fetch(`${base}/status`)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await res.json()) as StatusReport
    expect(body.uptimeSec).toBe(100)
    expect(body.raw.currentDay).toBe('2026-09-26')
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

  it('?wave=1 を付けると波形も付く', async () => {
    const hub = new ReadingHub()
    const base = await start(hub)

    const got = await readEvents(base, '/stream?wave=1', 2, () => {
      hub.publish({ kind: 'wave', wave: WAVE })
      hub.publish({ kind: 'reading', reading: READING })
    })

    expect(got.map((e) => e.name)).toEqual(['wave', 'reading'])
    expect((got[0].data as WaveChunk).gal[2]).toEqual([980])
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

  // 波形の粒度（#261 段 0）。地震ビューアーの PWA は合成 1 本だけを見るので、
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
      adminConsole: TEST_ADMIN_CONSOLE,
      readWaves: null,
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

  it('トークンが違えば 401', async () => {
    const base = await startAuthed(new ReadingHub())
    const res = await fetch(`${base}/api/config`, {
      headers: { Authorization: 'Bearer wrong', Origin: ORIGIN },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid-token' })
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
    const BOARD_KEY = 'mac:3c8a1f5d54d8'

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
        boards: [{ boardKey: BOARD_KEY, stationId: 'study', sensors: [] }],
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
      expect(ops.get().boards).toEqual([{ boardKey: BOARD_KEY, stationId: 'study', sensors: [] }])
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
      expect(ops.get().boards).toEqual([{ boardKey: BOARD_KEY, stationId: 'study', sensors: [] }])
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
        boards: [{ boardKey: BOARD_KEY, stationId: 'study', sensors: [] }],
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
