/**
 * 画面に出うる日本語の文字列を一覧にする（docs/ui-wording-procedure.md「1. 棚卸しは機械で取る」）。
 * 抜き出し方は `scripts/lib/uiStrings.ts`。
 *
 *   npx tsx scripts/list-ui-strings.ts [--out <TSV の出力先>] <ディレクトリかファイル…>
 *   例: npx tsx scripts/list-ui-strings.ts --out <スクラッチ>/admin.tsv seismo-host/src/admin
 *
 * 出力は 1 行 1 件の TSV（パス・行・種類・文字列）。種類は `text`（画面）・`error`（例外の文）・`log`（ログ）。
 * 件数の内訳と、読まなかったファイルの数は標準エラーへ出す。読むのは `.ts`・`.tsx`・`.html`。
 * テスト（`*.test.ts(x)`）・型定義（`*.d.ts`）・`node_modules`・`dist`・リンクは読まない。
 * JSON（データファイルの `description` など）は読まない。
 *
 * **終了コード 2 で止めるとき**: 渡したパスが無い・読めるソースが 1 本も無い・書き出せない。
 * **一覧は出したうえで 2 を返すとき**: 構文エラーや UTF-8 として読めない文字のあるファイルがあった
 * （そのファイルの分は一部しか拾えていないかもしれない）。どれも「0 件だった」と取り違えないため。
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeUtf8Strict, parseUiStrings } from './lib/uiStrings'

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-dmdss', '.git'])

const isSource = (name: string) =>
  (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) || name.endsWith('.html')

interface Collected {
  files: string[]
  /** 読まなかったファイルの拡張子ごとの数（テスト・型定義は数えない） */
  skipped: Map<string, number>
  links: number
}

function collect(path: string, seen: Set<string>, out: Collected): void {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) {
    out.links += 1
    return
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (SKIP_DIRS.has(name)) continue
      collect(join(path, name), seen, out)
    }
    return
  }
  const real = realpathSync(path)
  if (seen.has(real)) return
  seen.add(real)
  if (isSource(path)) out.files.push(path)
  else if (!/\.test\.tsx?$/.test(path) && !path.endsWith('.d.ts')) {
    const ext = extname(path) || '（拡張子なし）'
    out.skipped.set(ext, (out.skipped.get(ext) ?? 0) + 1)
  }
}

function main(): number {
  const args = process.argv.slice(2)
  let outFile: string | null = null
  const targets: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outFile = args[++i] ?? null
    else targets.push(args[i])
  }
  if (targets.length === 0 || (args.includes('--out') && outFile === null)) {
    console.error('使い方: npx tsx scripts/list-ui-strings.ts [--out <TSV>] <ディレクトリかファイル…>')
    return 2
  }
  const missing = targets.filter((t) => !existsSync(resolve(t)))
  if (missing.length > 0) {
    console.error(`見つからない: ${missing.join(' ')}`)
    return 2
  }
  const collected: Collected = { files: [], skipped: new Map(), links: 0 }
  const seen = new Set<string>()
  for (const t of targets) collect(resolve(t), seen, collected)
  if (collected.files.length === 0) {
    console.error(`読めるソースが 1 本も無い: ${targets.join(' ')}`)
    return 2
  }

  const rows: string[] = []
  const byKind = new Map<string, number>()
  const byDir = new Map<string, number>()
  const problems: string[] = []
  for (const f of collected.files) {
    const rel = relative(process.cwd(), f).split('\\').join('/')
    const decoded = decodeUtf8Strict(readFileSync(f))
    if (!decoded.ok) problems.push(`${rel}: UTF-8 として読めない`)
    const result = parseUiStrings(f, decoded.text)
    for (const p of result.problems) problems.push(`${rel}: ${p}`)
    for (const s of result.strings) {
      rows.push([rel, s.line, s.kind, s.text].join('\t'))
      byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1)
      const dir = rel.split('/').slice(0, -1).join('/') || '.'
      byDir.set(dir, (byDir.get(dir) ?? 0) + 1)
    }
  }
  const tsv = rows.join('\n') + (rows.length > 0 ? '\n' : '')
  if (outFile === null) process.stdout.write(tsv)
  else writeFileSync(outFile, tsv)

  console.error(`ファイル ${collected.files.length} 本・文字列 ${rows.length} 件（${[...byKind].map(([k, n]) => `${k} ${n}`).join('・')}）`)
  for (const [dir, n] of [...byDir].sort((a, b) => b[1] - a[1])) console.error(`  ${n}\t${dir}`)
  if (collected.skipped.size > 0) {
    console.error(`読まなかったファイル: ${[...collected.skipped].map(([ext, n]) => `${ext} ${n} 本`).join('・')}`)
  }
  if (collected.links > 0) console.error(`辿らなかったリンク: ${collected.links} 本`)
  if (problems.length > 0) {
    console.error(`読めなかった所があるファイル（一覧はそのファイルの分が欠けているかもしれない）:`)
    for (const p of problems) console.error(`  ${p}`)
    return 2
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main()
  } catch (err) {
    console.error(`止まった: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 2
  }
}
