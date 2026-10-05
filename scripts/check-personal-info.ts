/**
 * 公開する内容に個人情報が入っていないかを確かめる（CLAUDE.md「公開する前に個人情報が無いことを確かめる」）。
 * 判定は `scripts/lib/personalInfo.ts`、出してよいものの一覧は `scripts/personal-info-allowlist.json`。
 *
 *   npx tsx scripts/check-personal-info.ts --pre-push <remote>   git の pre-push フックから（標準入力に送る ref）
 *   npx tsx scripts/check-personal-info.ts --range <rev-list の引数…> 例: --range origin/main..HEAD
 *   npx tsx scripts/check-personal-info.ts --all                 すべての ref から届く中身・付帯情報
 *   npx tsx scripts/check-personal-info.ts --text <ファイル…>     PR・Issue の本文など、git の外の文章
 *
 * **調べるもの**: 送るコミットから届くすべてのファイル（文字・バイナリ）、コミットメッセージ、作者と
 * コミッター、タグのメッセージと作成者、ブランチ名とタグ名。
 *
 * **照合ファイルが無ければ止める**（終了コード 2）。置き場所は既定でメインの checkout の
 * `.claude/personal-info.txt`（ワークツリーからでも同じものを読む）、`PERSONAL_INFO_FILE` で変えられる。
 * 一覧が無いまま通すと、具体的な値を 1 つも照合しないのに「通った」ことになる。
 *
 * 終了コード: 0 = 見つからなかった、1 = 見つかった、2 = 調べられなかった。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  type Allowlist,
  decodeGitObject,
  type Finding,
  GitOutputError,
  isBinaryFile,
  type LocalRules,
  parseCatFileBatch,
  parseCommitObject,
  parseLocalRules,
  parseTagObject,
  scanBinary,
  scanFileName,
  scanIdentity,
  scanText,
} from './lib/personalInfo'

const ZERO = /^0+$/

/** 子プロセスの出力の上限（2 GiB）。`1 << 31` は符号つきで負になるので掛け算で書く。 */
const MAX_BUFFER = 2 * 1024 * 1024 * 1024

function git(args: readonly string[], input?: string): string {
  return execFileSync('git', [...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER, input })
}

function gitBuffer(args: readonly string[], input: string): Buffer {
  return execFileSync('git', [...args], { maxBuffer: MAX_BUFFER, input })
}

/** メインの checkout のトップ（ワークツリーからでも同じ場所）。 */
function mainCheckoutDir(): string {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  return dirname(common)
}

function loadLocalRules(): LocalRules {
  const path = process.env.PERSONAL_INFO_FILE ?? join(mainCheckoutDir(), '.claude', 'personal-info.txt')
  if (!existsSync(path)) {
    throw new Error(
      `照合ファイルが無い: ${path}\n` +
        '（公開してはいけない値の一覧。Git には入れずにこの端末へ置く。書式は scripts/lib/personalInfo.ts の parseLocalRules）',
    )
  }
  return parseLocalRules(readFileSync(path, 'utf8'))
}

function loadAllowlist(): Allowlist {
  const here = dirname(fileURLToPath(import.meta.url))
  const raw = JSON.parse(readFileSync(join(here, 'personal-info-allowlist.json'), 'utf8')) as {
    publicDataPaths: { path: string }[]
    values: { value: string }[]
    identityEmails: { pattern: string }[]
    binaryExtensions: { ext: string }[]
  }
  // **形が崩れていたら投げる。** たとえば `pattern` が欠けると `new RegExp(undefined)` は空の正規表現になり、
  // どのメールアドレスも許可したことになる。
  const strings = (list: unknown, key: string): string[] => {
    if (!Array.isArray(list)) throw new Error(`許可リストの ${key} の一覧が無い`)
    return list.map((e: Record<string, unknown>, i) => {
      const v = e?.[key]
      if (typeof v !== 'string' || v === '') throw new Error(`許可リストの ${key} の ${i + 1} 件目が空か文字列でない`)
      return v
    })
  }
  return {
    publicDataPaths: strings(raw.publicDataPaths, 'path'),
    values: strings(raw.values, 'value'),
    identityEmails: strings(raw.identityEmails, 'pattern'),
    binaryExtensions: strings(raw.binaryExtensions, 'ext'),
  }
}

/**
 * オブジェクトの中身をまとめて読む（`cat-file --batch`）。**1 つでも返らなければ投げる**
 * （`parseCatFileBatch`）—— 部分 clone で取ってきていないブロブを「調べた」ことにしない。
 */
function readObjects(shas: readonly string[]): Map<string, { type: string; body: Buffer }> {
  const out = new Map<string, { type: string; body: Buffer }>()
  const unique = [...new Set(shas)]
  for (let i = 0; i < unique.length; i += 2000) {
    const chunk = unique.slice(i, i + 2000)
    for (const [sha, obj] of parseCatFileBatch(gitBuffer(['cat-file', '--batch'], chunk.join('\n') + '\n'), chunk)) out.set(sha, obj)
  }
  return out
}

/**
 * rev-list の引数で選んだ範囲の、コミットと、道筋つきのオブジェクト（ブロブと木）。
 * `stdinRevs` を渡すと、範囲は標準入力から読ませる（`^<sha>` を何百も並べてもコマンド行の長さに当たらない）。
 */
function objectsOf(
  revArgs: readonly string[],
  stdinRevs?: readonly string[],
): { commits: string[]; paths: { sha: string; path: string }[] } {
  const input = stdinRevs === undefined ? undefined : stdinRevs.join('\n') + '\n'
  const args = stdinRevs === undefined ? revArgs : [...revArgs, '--stdin']
  const commits = git(['rev-list', ...args], input).split('\n').filter((l) => l !== '')
  const paths = git(['rev-list', '--objects', ...args], input)
    .split('\n')
    .filter((l) => l.includes(' '))
    .map((l) => ({ sha: l.slice(0, l.indexOf(' ')), path: l.slice(l.indexOf(' ') + 1) }))
  return { commits, paths }
}

/** 範囲のコミットの付帯情報（作者・コミッター・メッセージ）。生の中身から読む（書式の区切りに頼らない）。 */
function scanCommits(commits: readonly string[], local: LocalRules, allow: Allowlist): Finding[] {
  const findings: Finding[] = []
  const objects = readObjects(commits)
  for (const sha of new Set(commits)) {
    const obj = objects.get(sha)
    if (obj?.type !== 'commit') throw new GitOutputError(`${sha} がコミットとして読めない`)
    const { author, committer, message } = parseCommitObject(decodeGitObject(obj.body))
    const short = sha.slice(0, 8)
    findings.push(...scanIdentity(`commit ${short} の作者`, author.name, author.email, local, allow))
    findings.push(...scanIdentity(`commit ${short} のコミッター`, committer.name, committer.email, local, allow))
    findings.push(...scanText(`commit ${short} のメッセージ`, message, local, allow))
  }
  return findings
}

/** タグ（注釈つきならメッセージと作成者も）。 */
function scanTag(ref: string, sha: string, local: LocalRules, allow: Allowlist): Finding[] {
  const findings = scanText(`タグ名 ${ref}`, ref, local, allow)
  const obj = readObjects([sha]).get(sha)
  if (obj?.type !== 'tag') return findings
  const { tagger, message } = parseTagObject(decodeGitObject(obj.body))
  if (tagger !== null) findings.push(...scanIdentity(`タグ ${ref} の作成者`, tagger.name, tagger.email, local, allow))
  findings.push(...scanText(`タグ ${ref} のメッセージ`, message, local, allow))
  return findings
}

function scanRange(revArgs: readonly string[], local: LocalRules, allow: Allowlist, stdinRevs?: readonly string[]): Finding[] {
  const { commits, paths } = objectsOf(revArgs, stdinRevs)
  const findings = scanCommits(commits, local, allow)
  const contents = readObjects(paths.map((p) => p.sha))
  const seen = new Set<string>()
  for (const p of paths) {
    const obj = contents.get(p.sha)
    if (obj === undefined) throw new GitOutputError(`${p.sha}（${p.path}）を読めなかった`)
    if (obj.type !== 'blob') continue // 木（ディレクトリ）。道筋は中のブロブの側で見る
    if (seen.has(`${p.sha} ${p.path}`)) continue
    seen.add(`${p.sha} ${p.path}`)
    findings.push(...scanFileName(p.path, local, allow))
    findings.push(
      ...(isBinaryFile(p.path, obj.body)
        ? scanBinary(p.path, obj.body, local, allow)
        : scanText(p.path, obj.body.toString('utf8'), local, allow)),
    )
  }
  return findings
}

/**
 * 相手に**いま**ある先端のうち、手元にもあるもの（`git ls-remote` で直接訊く）。これより前は公開済みとして
 * 調べ直さない。**手元の追跡ブランチは使わない** —— fetch していなければ古く、履歴を書き換えた後は
 * 消したはずの中身を「公開済み」として見逃しうる。手元に無い先端は境にできないので外す（調べる範囲が
 * 広がるだけで、見逃しにはならない）。
 */
function liveRemoteTips(remote: string): string[] {
  const tips = [
    ...new Set(
      git(['ls-remote', remote])
        .split('\n')
        .map((l) => l.split('\t')[0] ?? '')
        .filter((s) => /^[0-9a-f]{40,64}$/.test(s)),
    ),
  ]
  if (tips.length === 0) return []
  const present = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], tips.join('\n') + '\n')
    .split('\n')
    .filter((l) => / (commit|tag)$/.test(l))
    .map((l) => l.split(' ')[0] as string)
  return present
}

/** pre-push フックの標準入力（`<local ref> <local sha> <remote ref> <remote sha>`）から調べる。 */
function scanPrePush(remote: string, stdin: string, local: LocalRules, allow: Allowlist): Finding[] {
  const findings: Finding[] = []
  let tips: string[] | null = null
  for (const line of stdin.split('\n')) {
    if (line.trim() === '') continue // 送る ref が無い push では空で届く
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/)
    const sha = /^[0-9a-f]{40,64}$/
    if (localRef === undefined || remoteRef === undefined || !sha.test(localSha ?? '') || !sha.test(remoteSha ?? '')) {
      throw new GitOutputError(`pre-push の入力が読めない: ${line}`)
    }
    if (ZERO.test(localSha as string)) continue // 削除
    findings.push(...scanText(`送る先の名前 ${remoteRef}`, remoteRef, local, allow))
    if (localRef.startsWith('refs/tags/')) findings.push(...scanTag(localRef, localSha as string, local, allow))
    // **相手にまだ無いものすべて。** 境は相手にいまある先端（`liveRemoteTips`）。上書きする ref の先端
    // （remote sha）も境に入れる —— 手元に無ければ rev-list が失敗して止まる（fetch してから）。
    tips ??= liveRemoteTips(remote)
    const boundary = ZERO.test(remoteSha as string) ? tips : [...new Set([...tips, remoteSha as string])]
    findings.push(...scanRange([], local, allow, [localSha as string, ...boundary.map((s) => `^${s}`)]))
  }
  return findings
}

function scanAll(local: LocalRules, allow: Allowlist): Finding[] {
  const findings = scanRange(['--all'], local, allow)
  for (const line of git(['for-each-ref', '--format=%(refname) %(objectname)']).split('\n')) {
    const [ref, sha] = line.split(' ')
    if (ref === undefined || sha === undefined || ref === '') continue
    findings.push(...scanText(`ref 名 ${ref}`, ref, local, allow))
    if (ref.startsWith('refs/tags/')) findings.push(...scanTag(ref, sha, local, allow))
  }
  return findings
}

function report(findings: readonly Finding[]): void {
  const unique = new Map<string, Finding>()
  for (const f of findings) unique.set(`${f.kind}\u0000${f.where}\u0000${f.line}\u0000${f.excerpt}`, f)
  const sorted = [...unique.values()].sort((a, b) => a.where.localeCompare(b.where) || (a.line ?? 0) - (b.line ?? 0))
  for (const f of sorted) console.log(`${f.where}${f.line === null ? '' : `:${f.line}`}  [${f.kind}]  ${f.excerpt}`)
  const byKind = new Map<string, number>()
  for (const f of sorted) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1)
  console.log(
    sorted.length === 0
      ? '[個人情報の検査] 見つからなかった'
      : `[個人情報の検査] ${sorted.length} 件見つかった（${[...byKind].map(([k, n]) => `${k} ${n}`).join('・')}）`,
  )
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let local: LocalRules
  let allow: Allowlist
  try {
    local = loadLocalRules()
    allow = loadAllowlist()
  } catch (error) {
    console.error(`[個人情報の検査] 調べられない: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  let findings: Finding[]
  if (args[0] === '--pre-push') {
    findings = scanPrePush(args[1] ?? 'origin', await readStdin(), local, allow)
  } else if (args[0] === '--range' && args.length > 1) {
    findings = scanRange(args.slice(1), local, allow)
  } else if (args[0] === '--all') {
    findings = scanAll(local, allow)
  } else if (args[0] === '--text' && args.length > 1) {
    findings = args.slice(1).flatMap((p) => scanText(p, readFileSync(p, 'utf8'), local, allow))
  } else {
    console.error('使い方: --pre-push <remote> | --range <rev-list の引数…> | --all | --text <ファイル…>')
    process.exit(2)
  }
  report(findings)
  process.exit(findings.length === 0 ? 0 : 1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[個人情報の検査] 調べられない: ${error instanceof Error ? error.stack : String(error)}`)
    process.exit(2)
  })
}
