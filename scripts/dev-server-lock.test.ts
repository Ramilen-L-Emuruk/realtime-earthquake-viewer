/**
 * dev サーバーの二重起動を止める門（`dev-server-lock.ts`）の検査。
 *
 * 押さえるのは 3 種。
 * - **正**: 生きている記録は「動いている」と判定される
 * - **対照**: プロセスが死んでいれば判定されない（消し忘れた記録に騙されない）
 * - **安全弁**: PID が生きていてもポートが応答しなければ判定されない（**PID の再利用**）
 *
 * 安全弁が要るのは、PID だけで判定すると「別のプロセスが同じ番号を取った」場合に
 * 起動できなくなり、しかも案内する URL が嘘になるため。ここを緩めると、門が通行止めに化ける。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { EventEmitter } from 'node:events'

import {
  LOCK_FILE_NAME,
  isProcessAlive,
  isPortServing,
  readLockFile,
  findLiveRecord,
  writeRecord,
  clearRecord,
  formatAlreadyRunning,
  devServerLockPlugin,
  type DevServerRecord,
} from './dev-server-lock'

/** 存在しえない PID。Windows / POSIX とも実在しない大きな値を使う。 */
const DEAD_PID = 0x7ffffffe

/**
 * 警告を捨てる口。
 *
 * `onWarn` は**任意引数ではなく必須**にしてある（任意にしたら 3 箇所で渡し忘れ、読み取り
 * 失敗が黙って「記録なし」に化けた）。テストでは警告を見ないが、**黙ると決めたことを
 * こう書いて残す**。
 */
const silent = () => {}

let root: string
let servers: Server[] = []

/** 空いているポートで待ち受けを 1 つ作り、その実ポートを返す。 */
function listenOnFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    servers.push(server)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('ポートを取得できませんでした'))
    })
  })
}

function recordFor(pid: number, port: number): DevServerRecord {
  return {
    pid,
    port,
    url: `http://localhost:${port}/realtime-earthquake-viewer/dmdss/`,
    startedAt: new Date().toISOString(),
    sessionId: 'test-session',
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dev-server-lock-'))
})

afterEach(() => {
  for (const server of servers) server.close()
  servers = []
  rmSync(root, { recursive: true, force: true })
})

describe('isProcessAlive', () => {
  it('自分のプロセスは生きていると判定する', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('存在しない PID は生きていないと判定する', () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false)
  })

  it('数値として不正な PID は生きていないと判定する', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
  })
})

describe('isPortServing', () => {
  it('待ち受けているポートは応答ありと判定する', async () => {
    const port = await listenOnFreePort()
    expect(await isPortServing(port)).toBe(true)
  })

  it('閉じたポートは応答なしと判定する', async () => {
    const port = await listenOnFreePort()
    // 一旦立てたポートを閉じる。使われていない番号を当てずっぽうに選ぶより確実。
    await new Promise<void>(resolve => servers.pop()!.close(() => resolve()))
    expect(await isPortServing(port)).toBe(false)
  })

  it('範囲外のポート番号は応答なしと判定する', async () => {
    expect(await isPortServing(0)).toBe(false)
    expect(await isPortServing(70000)).toBe(false)
  })
})

describe('readLockFile', () => {
  it('ファイルが無ければ空として扱う', () => {
    expect(readLockFile(root, silent)).toEqual({})
  })

  it('壊れた JSON でも空として扱い、起動を妨げない', () => {
    writeFileSync(join(root, LOCK_FILE_NAME), '{ こわれている', 'utf-8')
    expect(readLockFile(root, silent)).toEqual({})
  })

  it('配列が書かれていても空として扱う', () => {
    writeFileSync(join(root, LOCK_FILE_NAME), '[]', 'utf-8')
    expect(readLockFile(root, silent)).toEqual({})
  })
})

describe('findLiveRecord', () => {
  it('正: 生きているプロセスと応答するポートの組は「動いている」と判定する', async () => {
    const port = await listenOnFreePort()
    writeRecord(root, 'dmdss', recordFor(process.pid, port), silent)
    const live = await findLiveRecord(root, 'dmdss', silent)
    expect(live?.port).toBe(port)
  })

  it('対照: プロセスが死んでいれば判定しない（消し忘れた記録に騙されない）', async () => {
    const port = await listenOnFreePort()
    writeRecord(root, 'dmdss', recordFor(DEAD_PID, port), silent)
    expect(await findLiveRecord(root, 'dmdss', silent)).toBeNull()
  })

  it('安全弁: PID が生きていてもポートが応答しなければ判定しない（PID の再利用）', async () => {
    const port = await listenOnFreePort()
    await new Promise<void>(resolve => servers.pop()!.close(() => resolve()))
    // PID は実在する（このテストプロセス自身）が、そのポートはもう誰も持っていない。
    writeRecord(root, 'dmdss', recordFor(process.pid, port), silent)
    expect(await findLiveRecord(root, 'dmdss', silent)).toBeNull()
  })

  it('記録が無いバリアントは判定しない', async () => {
    const port = await listenOnFreePort()
    writeRecord(root, 'dmdss', recordFor(process.pid, port), silent)
    expect(await findLiveRecord(root, 'standard', silent)).toBeNull()
  })
})

describe('writeRecord / clearRecord', () => {
  it('バリアントごとに独立して持ち、他方を壊さない', async () => {
    const dmdssPort = await listenOnFreePort()
    const standardPort = await listenOnFreePort()
    writeRecord(root, 'dmdss', recordFor(process.pid, dmdssPort), silent)
    writeRecord(root, 'standard', recordFor(process.pid, standardPort), silent)

    const saved = readLockFile(root, silent)
    expect(saved.dmdss.port).toBe(dmdssPort)
    expect(saved.standard.port).toBe(standardPort)
  })

  it('自分のエントリだけ消し、他方は残す', async () => {
    const dmdssPort = await listenOnFreePort()
    const standardPort = await listenOnFreePort()
    writeRecord(root, 'dmdss', recordFor(process.pid, dmdssPort), silent)
    writeRecord(root, 'standard', recordFor(process.pid, standardPort), silent)

    clearRecord(root, 'dmdss', undefined, silent)

    const saved = readLockFile(root, silent)
    expect(saved.dmdss).toBeUndefined()
    expect(saved.standard.port).toBe(standardPort)
  })

  it('最後の 1 つを消したらファイルごと消す', async () => {
    const port = await listenOnFreePort()
    writeRecord(root, 'dmdss', recordFor(process.pid, port), silent)
    clearRecord(root, 'dmdss', undefined, silent)
    expect(existsSync(join(root, LOCK_FILE_NAME))).toBe(false)
  })

  it('記録の無いバリアントを消しても何も起きない', () => {
    clearRecord(root, 'dmdss', undefined, silent)
    expect(existsSync(join(root, LOCK_FILE_NAME))).toBe(false)
  })

  it('末尾を改行で閉じる（手で開いたときに読みやすいため）', async () => {
    const port = await listenOnFreePort()
    writeRecord(root, 'dmdss', recordFor(process.pid, port), silent)
    expect(readFileSync(join(root, LOCK_FILE_NAME), 'utf-8').endsWith('\n')).toBe(true)
  })
})

describe('formatAlreadyRunning', () => {
  it('URL と止め方の両方を出す（次の行動が決まるように）', () => {
    const message = formatAlreadyRunning('dmdss', recordFor(1234, 5178))
    expect(message).toContain('http://localhost:5178/realtime-earthquake-viewer/dmdss/')
    expect(message).toContain('Stop-Process -Id 1234')
  })

  it('セッションが取れていればそれも出す（持ち主を特定できるように）', () => {
    expect(formatAlreadyRunning('dmdss', recordFor(1234, 5178))).toContain('test-session')
  })

  it('セッションが取れていなければその行は出さない', () => {
    const record = { ...recordFor(1234, 5178), sessionId: null }
    expect(formatAlreadyRunning('dmdss', record)).not.toContain('起動したセッション')
  })
})

describe('clearRecord の所有権', () => {
  it('自分の PID の記録は消す', async () => {
    const port = await listenOnFreePort()
    writeRecord(root, 'dmdss', recordFor(process.pid, port), silent)
    clearRecord(root, 'dmdss', process.pid, silent)
    expect(readLockFile(root, silent).dmdss).toBeUndefined()
  })

  it('**他人の PID の記録は消さない**（競合で上書きされた後、生きている側を落とさないため）', async () => {
    const port = await listenOnFreePort()
    writeRecord(root, 'dmdss', recordFor(process.pid + 1, port), silent)
    clearRecord(root, 'dmdss', process.pid, silent)
    expect(readLockFile(root, silent).dmdss?.pid).toBe(process.pid + 1)
  })
})

describe('writeRecord の書き込み', () => {
  it('一時ファイルを残さない（読み手が書きかけを掴まないよう rename で置き換える）', async () => {
    const port = await listenOnFreePort()
    writeRecord(root, 'dmdss', recordFor(process.pid, port), silent)
    expect(readdirSync(root)).toEqual([LOCK_FILE_NAME])
  })
})

/**
 * 門の配線（`configureServer`）の検査。
 *
 * **ここが抜けていたために CRITICAL を作り込んだ。** 純粋関数だけを検査していて、
 * 「実際に止めるかどうかを決める分岐」は誰も見ていなかった。
 */
describe('devServerLockPlugin', () => {
  type MockServer = {
    httpServer: EventEmitter & { address: () => { port: number } | null }
    config: { logger: { warn: (message: string) => void } }
    warnings: string[]
  }

  function createMockServer(port: number | null): MockServer {
    const httpServer = new EventEmitter() as MockServer['httpServer']
    httpServer.address = () => (port == null ? null : { port })
    const warnings: string[] = []
    return { httpServer, config: { logger: { warn: (m: string) => warnings.push(m) } }, warnings }
  }

  /** プラグインの configureServer を呼ぶ。Vite の型に合わせるためのキャストを 1 箇所へ閉じ込める。 */
  async function runConfigureServer(
    plugin: ReturnType<typeof devServerLockPlugin>,
    server: MockServer,
  ): Promise<void> {
    const hook = plugin.configureServer
    const fn = typeof hook === 'function' ? hook : hook?.handler
    await (fn as (s: unknown) => unknown)?.call(plugin, server)
  }

  it('正: 生きている記録が無ければ通過し、listening で記録を書く', async () => {
    const port = await listenOnFreePort()
    const exits: number[] = []
    const plugin = devServerLockPlugin({
      variant: 'dmdss',
      base: '/app/',
      root,
      exit: code => exits.push(code),
    })
    const server = createMockServer(port)

    await runConfigureServer(plugin, server)
    expect(exits).toEqual([])

    server.httpServer.emit('listening')
    const saved = readLockFile(root, silent).dmdss
    expect(saved?.port).toBe(port)
    expect(saved?.pid).toBe(process.pid)
    expect(saved?.url).toBe(`http://localhost:${port}/app/`)
  })

  it('対照: 他のプロセスが生きていれば案内を出して止める', async () => {
    const port = await listenOnFreePort()
    // 自分ではないが生きている PID として親プロセスを使う（存在が保証される）。
    const otherPid = process.ppid
    writeRecord(root, 'dmdss', recordFor(otherPid, port), silent)

    const exits: number[] = []
    const plugin = devServerLockPlugin({
      variant: 'dmdss',
      base: '/app/',
      root,
      exit: code => exits.push(code),
    })
    const server = createMockServer(port)

    await runConfigureServer(plugin, server)

    expect(exits).toEqual([0])
    expect(server.warnings.join('\n')).toContain(`Stop-Process -Id ${otherPid}`)
  })

  it('**安全弁: 記録の PID が自分自身なら止めない**（Vite の再起動で自分を殺さないため）', async () => {
    const port = await listenOnFreePort()
    writeRecord(root, 'dmdss', recordFor(process.pid, port), silent)

    const exits: number[] = []
    const plugin = devServerLockPlugin({
      variant: 'dmdss',
      base: '/app/',
      root,
      exit: code => exits.push(code),
    })
    const server = createMockServer(port)

    await runConfigureServer(plugin, server)

    // ここで exit(0) すると、設定ファイルを触るたびに dev サーバーが黙って落ちる。
    expect(exits).toEqual([])
  })

  it('実ポートを取得できなければ、記録せずに警告だけ出す（起動は止めない）', async () => {
    const exits: number[] = []
    const plugin = devServerLockPlugin({
      variant: 'dmdss',
      base: '/app/',
      root,
      exit: code => exits.push(code),
    })
    const server = createMockServer(null)

    await runConfigureServer(plugin, server)
    server.httpServer.emit('listening')

    expect(exits).toEqual([])
    expect(readLockFile(root, silent).dmdss).toBeUndefined()
    expect(server.warnings.join('\n')).toContain('実ポートを取得できず')
  })

  it('close で自分の記録を落とす', async () => {
    const port = await listenOnFreePort()
    const plugin = devServerLockPlugin({
      variant: 'dmdss',
      base: '/app/',
      root,
      exit: () => {},
    })
    const server = createMockServer(port)

    await runConfigureServer(plugin, server)
    server.httpServer.emit('listening')
    expect(readLockFile(root, silent).dmdss).toBeDefined()

    server.httpServer.emit('close')
    expect(readLockFile(root, silent).dmdss).toBeUndefined()
  })
})
