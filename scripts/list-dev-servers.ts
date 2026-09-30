/**
 * いま動いている dev サーバーを一覧する（`npm run dev:list`）。
 *
 * 見るものは 2 つ。
 *
 * 1. **台帳** — 各ワークツリー直下の `.dev-server.json`（`dev-server-lock.ts` が書く）。
 *    ポート・場所・バリアント・PID・起動時刻・起動したセッションが分かる
 * 2. **OS 側** — 実際に待ち受けている vite のプロセス。**台帳に無いもの（孤児）を炙り出す**
 *
 * **2 が要るのは、台帳が全数を持たないため。** 門を通らない起動（`npx vite` を直に叩く等）、
 * 門を入れる前から動いているもの、記録を書けなかったものは台帳に載らない。台帳だけを見て
 * 「他には無い」と判断すると、そこから乱立が始まる。
 *
 * ## 断定しないこと
 *
 * OS 側から拾えるのは「node が vite らしきものを動かしている」ところまで。**このプロジェクトの
 * ものだと決めつけない** —— 同じ端末では別プロジェクトの dev サーバーも動いている。確信ありげな
 * ラベルを付けると、それを信じて `Stop-Process` した人が**他人の作業を落とす**。
 * ここでは起動コマンドにこのリポジトリのパスが入っているかで仕分け、入っていないものは
 * 「このプロジェクト外」として別の群に置く。
 *
 * ## 「0 本」と「調べられなかった」を分けること
 *
 * 孤児の検出は外部コマンド（`netstat` と PowerShell）に頼る。**呼べなかったときに静かに
 * 空を返すと「孤児 0 本」と表示され、利用者は見えていないものを無いと誤信する。**
 * 成否を持ち回り、失敗したときはその旨を出す。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readLockFile, isProcessAlive, isPortServing, LOCK_FILE_NAME } from './dev-server-lock'

type Row = {
  port: number
  /** バリアント（台帳にあるときだけ確実）。OS 側から拾ったものは不明。 */
  variant: string
  /** `dev` / `preview` / 不明。preview は門を通らないので常に台帳に載らない。 */
  kind: string
  directory: string
  pid: number
  startedAt: string
  sessionId: string | null
  /** 台帳に載っているか。 */
  tracked: boolean
  /** このリポジトリのものと確かめられたか。false なら別プロジェクトの可能性。 */
  ours: boolean
}

/** パスの比較用。区切りと大文字小文字を揃える（Windows は両方ぶれる）。 */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

/** メインの checkout と全ワークツリーのパスを返す。 */
function listWorktreePaths(): { paths: string[]; ok: boolean } {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf-8' })
    const paths = out
      .split(/\r?\n/)
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim())
      .filter(Boolean)
    return { paths, ok: true }
  } catch {
    // git が無い・リポジトリ外から呼ばれた等。自分のところだけでも見るが、全数ではないと伝える。
    return { paths: [process.cwd()], ok: false }
  }
}

/**
 * 台帳に載っていて、いま生きているものを集める。
 *
 * **読めなかった場所を返すこと。** 台帳が一時的に読めないと、そのワークツリーの正規の
 * サーバーが `tracked` から落ち、OS 走査の側で「持ち主が分からない孤児」として現れる。
 * 利用者がそれを信じて止めれば、正しく動いていたサーバーを落とすことになる。
 */
async function collectTracked(
  worktreePaths: string[],
): Promise<{ rows: Row[]; unreadable: string[] }> {
  const rows: Row[] = []
  const unreadable: string[] = []
  for (const dir of worktreePaths) {
    if (!existsSync(join(dir, LOCK_FILE_NAME))) continue
    let readFailed = false
    const records = readLockFile(dir, message => {
      readFailed = true
      console.error(message)
    })
    if (readFailed) unreadable.push(basename(dir))
    for (const [variant, record] of Object.entries(records)) {
      if (!record || typeof record.pid !== 'number' || typeof record.port !== 'number') continue
      if (!isProcessAlive(record.pid)) continue
      if (!(await isPortServing(record.port))) continue
      rows.push({
        port: record.port,
        variant,
        kind: 'dev',
        directory: basename(dir),
        pid: record.pid,
        startedAt: record.startedAt ?? '',
        sessionId: record.sessionId ?? null,
        tracked: true,
        ours: true,
      })
    }
  }
  return { rows, unreadable }
}

/** 待ち受け中のポートと、それを掴んでいる PID の対。 */
function listListeningPorts(): { ports: Map<number, number>; ok: boolean } {
  const ports = new Map<number, number>()
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf-8' })
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue
      const columns = line.trim().split(/\s+/)
      const local = columns[1] ?? ''
      const pid = Number(columns[columns.length - 1])
      const port = Number(local.slice(local.lastIndexOf(':') + 1))
      if (Number.isInteger(pid) && Number.isInteger(port) && pid > 0 && port > 0) {
        // 同じポートが複数行に出ることがある（IPv4 / IPv6）。最初の 1 つで足りる。
        if (!ports.has(port)) ports.set(port, pid)
      }
    }
    return { ports, ok: true }
  } catch {
    return { ports, ok: false }
  }
}

/** PID → 起動コマンド。vite かどうか・どのディレクトリかはここから読む。 */
function listNodeCommandLines(): { commands: Map<number, string>; ok: boolean } {
  const commands = new Map<number, string>()
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf-8' },
    )
    const parsed: unknown = JSON.parse(out || '[]')
    // 1 件だけのときはオブジェクトが返り、配列にならない。
    const items = Array.isArray(parsed) ? parsed : [parsed]
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const { ProcessId, CommandLine } = item as { ProcessId?: number; CommandLine?: string }
      if (typeof ProcessId === 'number' && typeof CommandLine === 'string') {
        commands.set(ProcessId, CommandLine)
      }
    }
    return { commands, ok: true }
  } catch {
    return { commands, ok: false }
  }
}

/** 台帳に載っていない vite プロセスを集める。成否も返す（0 本と未調査を分けるため）。 */
function collectOrphans(
  tracked: Row[],
  worktreePaths: string[],
): { rows: Row[]; ok: boolean } {
  const trackedPorts = new Set(tracked.map(row => row.port))
  const { commands, ok: commandsOk } = listNodeCommandLines()
  const { ports, ok: portsOk } = listListeningPorts()
  const ourPaths = worktreePaths.map(normalizePath)
  const rows: Row[] = []

  for (const [port, pid] of ports) {
    if (trackedPorts.has(port)) continue
    const command = commands.get(pid)
    if (!command || !command.includes('vite')) continue

    const normalized = normalizePath(command)
    // **このリポジトリのものかを確かめる。** 同じ端末の別プロジェクトも `vite` を含む。
    const ours = ourPaths.some(path => normalized.includes(path))
    // `node_modules/.bin/vite` はワークツリーごとにあるので、パスに場所が出る。
    // ただし**同じディレクトリで standard と DMDSS を立てた場合は区別が付かない**
    // （バリアントは環境変数で決まり、コマンドラインに現れない）。
    const match = /worktrees[\\/]([^\\/]+)/.exec(command)

    rows.push({
      port,
      variant: '不明',
      kind: /\bpreview\b/.test(command) ? 'preview' : 'dev?',
      directory: ours ? (match ? match[1] : '(メインリポジトリ)') : '(このプロジェクト外)',
      pid,
      startedAt: '',
      sessionId: null,
      tracked: false,
      ours,
    })
  }
  return { rows, ok: commandsOk && portsOk }
}

function formatStartedAt(iso: string): string {
  if (!iso) return '不明'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '不明' : date.toLocaleString('ja-JP')
}

function printRows(rows: Row[]): void {
  const sorted = [...rows].sort((a, b) => a.port - b.port)
  for (const row of sorted) {
    const mark = row.tracked ? ' ' : '!'
    console.log(`${mark} :${row.port}  ${row.kind.padEnd(8)} ${row.variant.padEnd(8)} ${row.directory}`)
    console.log(`    PID ${row.pid}  起動 ${formatStartedAt(row.startedAt)}`)
    if (row.sessionId) console.log(`    セッション ${row.sessionId}`)
    if (!row.tracked && row.ours && row.kind === 'preview') {
      // preview は門（`configureServer`）を通らないので、**載っていないのが正常**。
      console.log('    preview は台帳に載らない（門を通らないため）。異常ではない')
    } else if (!row.tracked && row.ours) {
      console.log('    台帳に無い（持ち主が分からない）。止めるなら中身を見てから判断すること')
    }
    if (!row.ours) {
      console.log('    注意: 起動コマンドにこのリポジトリのパスが無い。別プロジェクトのものとして扱うこと')
    }
  }
}

async function main(): Promise<void> {
  const { paths: worktreePaths, ok: worktreesOk } = listWorktreePaths()
  const { rows: tracked, unreadable } = await collectTracked(worktreePaths)
  const isWindows = process.platform === 'win32'
  const { rows: detected, ok: detectionOk } = isWindows
    ? collectOrphans(tracked, worktreePaths)
    : { rows: [] as Row[], ok: false }

  // **preview を孤児に数えない。** 門を通らないので台帳に載らないのが正常で、
  // 「持ち主が分からない dev サーバー」とは別のもの。混ぜると孤児の件数が常に水増しされる。
  const orphans = detected.filter(row => row.ours && row.kind !== 'preview')
  const previews = detected.filter(row => row.ours && row.kind === 'preview')
  const foreign = detected.filter(row => !row.ours)

  if (tracked.length === 0 && detected.length === 0) {
    console.log('動いている dev サーバーはありません。')
  } else {
    printRows([...tracked, ...detected])
  }

  console.log('')
  console.log(`台帳に載っているもの: ${tracked.length} 本`)
  if (!isWindows) {
    // 「0 本」と「調べていない」を見分けられなくしない。
    console.log(`台帳に無いもの（孤児）: 未調査（${process.platform} では検出していません）`)
  } else if (!detectionOk) {
    console.log('台帳に無いもの（孤児）: 調べられませんでした（netstat / PowerShell を呼べず）')
    console.log('  → 0 本という意味ではありません。見えていないサーバーがある可能性があります')
  } else {
    console.log(`台帳に無いもの（孤児）: ${orphans.length} 本`)
    if (previews.length > 0) {
      console.log(`preview: ${previews.length} 本（門を通らないので台帳に載らない。孤児ではない）`)
    }
    if (foreign.length > 0) {
      console.log(`このプロジェクト外の vite: ${foreign.length} 本（止めないこと）`)
    }
  }
  if (!worktreesOk) {
    console.log('※ git worktree の一覧を取れなかったため、台帳は現在のディレクトリしか見ていません')
  }
  if (unreadable.length > 0) {
    // **ここを黙ると、正規のサーバーが「孤児」として表示されたままになる。**
    console.log(`※ 台帳を読めなかった場所: ${unreadable.join('、')}`)
    console.log('  → そこのサーバーが「台帳に無い」と出ていても、孤児とは限りません')
  }
  console.log('')
  console.log('止めるには: Stop-Process -Id <PID>')
}

// 直接実行のときだけ走らせる（定数を読むだけの import で一覧が走らないように）。
// 規約と実物は CLAUDE.md「検証」節・scripts/scriptEntrypoints.test.ts を参照。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
