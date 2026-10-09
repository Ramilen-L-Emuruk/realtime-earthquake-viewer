import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// DOM（jsdom）のテストで `console.error` を黙らせるときは `src/test-utils/muteConsoleError.ts` を通す。
//
// `src/vitestSetup.ts` の門は、act() の外で React を更新したテストを、`console.error` に届いた警告で
// 見つけて落とす。**素の `vi.spyOn(console, 'error').mockImplementation(() => {})` は、その警告を門に
// 届く前に消す** —— 門が効いていないことは、どこにも出ない。2026-10-09 に
// `useHypocenterCatalog.test.ts` の `retry()` がこの形ですり抜けていた（黙らせるのを外すと門で落ちた）。
//
// 見るのは jsdom を名乗るファイルだけ。React を描くのは DOM のあるテストに限られ、node の環境では
// 門自体が働かない（`vitestSetup.ts` が DOM の無い環境では何もしない）。

// 走査先は `vitest.config.ts` の `include` と揃える（管理コンソールのテストも jsdom で走る）
const ROOTS = ['src', 'scripts', 'seismo-host']

function listTestFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') out.push(...listTestFiles(p))
    }
    else if (/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/** `console.error` を直に差し替える書き方（`muteConsoleError` を通らないもの）。 */
const RAW_REPLACE = /spyOn\(\s*console\s*,\s*['"]error['"]\s*\)|console\.error\s*=(?!=)/

describe('DOM のテストは console.error を muteConsoleError で黙らせる', () => {
  // **1 件ずつ読むと、並列のときだけ 5 秒を超える**（CLAUDE.md「検証」節）。まとめて投げる
  const filesPromise = Promise.all(
    ROOTS.flatMap(listTestFiles).map(async f => ({ f, text: await readFile(f, 'utf8') })),
  )

  // 正: jsdom のテストに素の差し替えが無い。
  it('jsdom を名乗るテストに、素の console.error の差し替えが無い', async () => {
    const files = await filesPromise
    const offenders = files
      .filter(({ text }) => /@vitest-environment\s+jsdom/.test(text))
      .filter(({ text }) => RAW_REPLACE.test(text))
      .map(({ f }) => f)
    expect(offenders).toEqual([])
  })

  // 安全弁: 検査が何も見ていない状態になっていないこと。jsdom のテストが見つからない・
  // 黙らせる口を使うテストが 1 本も無い、のどちらかなら、走査先かファイルの形が変わっている。
  it('jsdom のテストと、黙らせる口を使うテストが見つかる', async () => {
    const files = await filesPromise
    const jsdom = files.filter(({ text }) => /@vitest-environment\s+jsdom/.test(text))
    expect(jsdom.length).toBeGreaterThan(50)
    expect(jsdom.filter(({ text }) => text.includes('muteConsoleError(')).length).toBeGreaterThan(0)
  })

  // 対照: 判定の式が、素の差し替えを確かに拾い、黙らせる口の呼び出しは拾わないこと。
  it('素の差し替えだけを拾う', () => {
    expect(RAW_REPLACE.test("vi.spyOn(console, 'error').mockImplementation(() => {})")).toBe(true)
    expect(RAW_REPLACE.test('console.error = () => {}')).toBe(true)
    expect(RAW_REPLACE.test('muteConsoleError()')).toBe(false)
    expect(RAW_REPLACE.test('expect(console.error).toHaveBeenCalled()')).toBe(false)
    expect(RAW_REPLACE.test('if (console.error === original) {}')).toBe(false)
  })
})
