import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// **import される生成スクリプトが、読み込みだけで走らないことを固定する。**
//
// 生成スクリプトは末尾で `main()` を呼ぶ。他のモジュールが定数（`SOURCE_URL` 等）を読むために
// import すると、**その呼び出しまで一緒に実行される**。実害は 2 つあり、どちらも
// 「テストが全件通っている」表示の裏で起きるので気づきにくい。
//
//   そのスクリプトが要る外部資源を持つ端末  `npm test` が生成物を黙って書き換える
//   持たない環境（CI）                      `process.exit(1)` でテスト実行ごと失敗する
//
// **落ち方が一定しない。** 拒否が実行の終わりに間に合うかどうかで、`process.exit` になったり
// ワーカーのハングで済んだりする。2026-09-11 の連続する 2 回の CI で両方を観測し、後者は
// exit 0 で通ってしまった（→ `build-epicenter-accents.ts` の門のコメント）。
//
// **見るのはソースの形であって実行結果ではない。** 実際に import して確かめる形にすると、
// 検査そのものが生成を起動する。ただし**字面の共起では足りない** —— 「`process.argv[1]` と
// `import.meta.url` がファイルのどこかにある」だけを見る書き方だと、`__dirname` の計算で
// 既に `import.meta.url` を使っているファイルでは門を消しても通ってしまう。ここでは
// **門の条件と `main()` の呼び出しが同じブロックに入っていること**まで確かめる。

const SCRIPTS_DIR = 'scripts'

/**
 * 行まるごとのコメントと `/* *\/` ブロックを落とす。
 *
 * **コメントの中の `main()` を呼び出しと取り違えないため。** このファイルが検査する門には
 * 経緯を書いた JSDoc が付いており、そこに `main()` という字面が何度も出る。
 * 行末コメントは残すが、そこに `main(` が現れる書き方はしていない。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n')
}

/** `main` を定義しているか（生成スクリプトかどうかの判定）。`export` 付きも拾う。 */
function definesMain(src: string): boolean {
  return /^(?:export\s+)?(?:async\s+)?function main\s*\(/m.test(src)
}

/**
 * 「直接実行のときだけ」の門の範囲（`{` から対応する `}` まで）。見つからなければ null。
 * 条件に `process.argv[1]` と `import.meta.url` の両方が要る。
 */
function guardedRange(src: string): { start: number; end: number } | null {
  const head = /if\s*\([\s\S]{0,300}?process\.argv\[1\][\s\S]{0,300}?import\.meta\.url[\s\S]{0,300}?\)\s*\{/
    .exec(src)
  if (!head) return null
  const open = head.index + head[0].length - 1
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return { start: open, end: i }
    }
  }
  return null
}

/** `main(` の呼び出し位置（定義の `function main(` は除く）。 */
function callSites(src: string): number[] {
  return [...src.matchAll(/\bmain\s*\(/g)]
    .filter(m => !/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index)))
    .map(m => m.index)
}

/** `scripts/` 配下のモジュールが `./x` の形で import している名前を集める（自分自身は除く）。 */
function importedWithin(): string[] {
  const names = new Set<string>()
  for (const file of readdirSync(SCRIPTS_DIR)) {
    if (!/\.(ts|mts|mjs)$/.test(file)) continue
    const src = readFileSync(join(SCRIPTS_DIR, file), 'utf8')
    // 静的 import（引用符はどちらでも）と動的 import の両方。拡張子付きの指定も拾う。
    for (const m of src.matchAll(/from\s*['"]\.\/([\w.-]+)['"]/g)) names.add(m[1])
    for (const m of src.matchAll(/import\s*\(\s*['"]\.\/([\w.-]+)['"]\s*\)/g)) names.add(m[1])
  }
  return [...names].sort()
}

/** import 名を実ファイルへ解決する（拡張子なしなら .ts → .mts → .mjs の順に探す）。 */
function resolveScript(name: string): string | null {
  const direct = join(SCRIPTS_DIR, name)
  if (/\.(ts|mts|mjs)$/.test(name)) return existsSync(direct) ? direct : null
  for (const ext of ['.ts', '.mts', '.mjs']) {
    const p = `${direct}${ext}`
    if (existsSync(p)) return p
  }
  return null
}

const targets = importedWithin()
  .map(name => ({ name, path: resolveScript(name) }))
  .filter((t): t is { name: string; path: string } =>
    t.path != null && definesMain(readFileSync(t.path, 'utf8')))

describe('import される生成スクリプトは読み込みで走らない', () => {
  it('対象が 1 本以上ある（検査が空振りしていないこと）', () => {
    // 0 件なら「全部が門を持っている」ではなく「何も見ていない」。
    // import の書き方や拡張子が変わって収集が外れたときに、ここで気づく。
    expect(targets.map(t => t.name)).toContain('build-epicenter-accents')
    expect(targets.length).toBeGreaterThan(0)
  })

  for (const { name, path } of targets) {
    describe(name, () => {
      const src = stripComments(readFileSync(path, 'utf8'))
      const range = guardedRange(src)

      it('正: main() の呼び出しが「直接実行のときだけ」の門の中にある', () => {
        expect(range, `${path} に process.argv[1] と import.meta.url を見る門が無い`).not.toBeNull()
        const inside = callSites(src).filter(i => range && i > range.start && i < range.end)
        expect(inside.length, `${path} の門の中に main() の呼び出しが無い`).toBeGreaterThan(0)
      })

      it('対照: 門の外では main() を呼んでいない', () => {
        // 字下げの有無では判定しない。門の範囲の外にある呼び出しを数える。
        const outside = callSites(src).filter(i => !range || i < range.start || i > range.end)
        expect(outside, `${path} が読み込み時に main() を実行している`).toEqual([])
      })
    })
  }
})
