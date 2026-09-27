import { request as httpRequest } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import type { AdminAuthConfig } from './adminAuth'
import type { IntensityReading, WaveChunk } from './intensityPipeline'
import { PacketTally } from './packetTally'
import { ReadingHub } from './readingHub'
import type { StationIntensityReading } from './sensorFusion'
import { StationDirectory } from './stationConfig'
import { buildStatusReport } from './statusReport'
import type { RawStoreStatus, StatusReport } from './statusReport'
import { startStatusServer } from './statusServer'
import type { StatusServer, StatusServerOptions } from './statusServer'

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

function report(hub: ReadingHub): StatusReport {
  return buildStatusReport({
    nowMs: 1_700_000_100_000,
    startedAtMs: 1_700_000_000_000,
    udp: { address: '0.0.0.0', port: 50505 },
    http: { address: '0.0.0.0', port: 50506 },
    tally: new PacketTally().snapshotTotal(),
    sensors: [],
    sensorEvictions: 0,
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
    hub: hub.snapshot(),
    stations: StationDirectory.empty(),
    stationConfigWarning: null,
    ungroupedMultiBoardStations: [],
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

async function start(
  hub: ReadingHub,
  status?: () => StatusReport,
  log?: StatusServerOptions['log'],
  heartbeatMs?: number,
  adminAuth?: AdminAuthConfig,
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
})
