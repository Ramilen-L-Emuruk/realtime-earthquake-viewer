/**
 * push の前に個人情報の検査を走らせるフックを入れる（CLAUDE.md「公開する前に個人情報が無いことを確かめる」）。
 *
 *   npm run install-git-hooks
 *
 * **clone した端末ごとに 1 回**。フックは git の管理の外（`.git/hooks` か `core.hooksPath` の先）に
 * 置くものなので、clone しただけでは入らない。
 *
 * 置くのは中継だけで、本体は `scripts/git-hooks/pre-push`（メインの checkout のもの）を呼ぶ。
 * 本体を書き換えても入れ直しは要らない。**本体が見つからなければ push を止める** —— フックが
 * 黙って何もしない状態を作らない（`core.hooksPath` をリポジトリ内の相対パスにすると、そのディレクトリを
 * 持たない古いブランチのワークツリーからの push だけ検査が飛ぶ。そのため相対パスは使わない）。
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARK = '# scripts/install-git-hooks.ts が置いた中継'

export const SHIM = `#!/bin/sh
${MARK}。本体はメインの checkout の scripts/git-hooks/pre-push。
hook="$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/git-hooks/pre-push"
if [ ! -f "$hook" ]; then
  echo "[個人情報の検査] フックの本体が無い: $hook。push を止める" >&2
  exit 1
fi
exec sh "$hook" "$@"
`

function main(): void {
  const hooksDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { encoding: 'utf8' }).trim()
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  // `core.hooksPath` が複数のリポジトリで共有する場所を指していると、ここへ置いた中継が無関係な
  // リポジトリの push まで止める。このリポジトリの .git の中でなければ置かない。
  if (!resolve(hooksDir).toLowerCase().startsWith(resolve(commonDir).toLowerCase())) {
    console.error(`[フックの導入] フックの置き場所（${hooksDir}）がこのリポジトリの外にある（core.hooksPath）。\n共有の場所へは置かない。core.hooksPath を見直すこと。`)
    process.exit(1)
  }
  const target = join(hooksDir, 'pre-push')
  if (existsSync(target) && !readFileSync(target, 'utf8').includes(MARK)) {
    // 別の道具が置いたフックを黙って潰さない。
    console.error(`[フックの導入] 別の pre-push が既にある: ${target}\n中身を確かめてから消すか、この検査を呼ぶ行を足すこと。`)
    process.exit(1)
  }
  mkdirSync(hooksDir, { recursive: true })
  writeFileSync(target, SHIM)
  chmodSync(target, 0o755)
  console.log(`[フックの導入] ${target} に置いた`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
