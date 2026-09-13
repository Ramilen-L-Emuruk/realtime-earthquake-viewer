import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ソースとドキュメントに**生の制御文字**を置かない。文字が要るならエスケープで書く
// （`'\u0000'`）。
//
// **見た目では気づけない。** 生の NUL が 1 バイト入ると、エディタでは空白と区別が付かない
// 一方で **grep / ripgrep はそのファイルをバイナリとして扱い、以後どの検索にもヒットしなく
// なる**（`Binary file ... matches` としか出ない）。型チェックもテストも通り、実行時の挙動も
// エスケープ表記と完全に同じなので、**壊れているのは可検索性だけ**という形で残り続ける。
//
// 実際に `src/utils/quakePoints.ts` で起きた。市町村の鍵の区切り（`CITY_KEY_SEP`）をローカル
// 定義から export へ移したとき、`'\u0000'` と書いたつもりの箇所が生の NUL になっていた。
// **そのファイル自身のコメントが「エスケープで書くこと」と警告していた**にもかかわらず。
// 人の注意では止まらないので、ここで機械的に止める。
//
// 対象から外す制御文字は 3 つだけ —— タブ・改行・復帰。それ以外の C0 制御文字（NUL を含む）と
// DEL は、ソースにもドキュメントにも現れる理由がない。

const ROOTS = ['src', 'scripts', 'docs']
const EXTENSIONS = ['.ts', '.tsx', '.md', '.mjs', '.js', '.css']

/** タブ (09)・改行 (0A)・復帰 (0D) 以外の C0 制御文字と DEL (7F)。 */
const FORBIDDEN = new Set<number>([
  ...Array.from({ length: 0x20 }, (_, i) => i).filter(c => c !== 0x09 && c !== 0x0a && c !== 0x0d),
  0x7f,
])

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listFiles(path))
    } else if (EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
      out.push(path)
    }
  }
  return out
}

/** 1 件目の違反を「ファイル:行:文字コード」の形で返す（無ければ null）。 */
function findControlChar(path: string): string | null {
  const buf = readFileSync(path)
  let line = 1
  for (const byte of buf) {
    if (byte === 0x0a) { line++; continue }
    if (FORBIDDEN.has(byte)) {
      const hex = byte.toString(16).padStart(2, '0').toUpperCase()
      return `${path}:${line} に生の制御文字 0x${hex}（エスケープで書くこと）`
    }
  }
  return null
}

describe('生の制御文字を置かない', () => {
  // **上限を延ばしてあるのは、走査そのものが遅いからではない。** 単独で回せば 1.2 秒で終わる
  // （実測）。全ファイルを並列で回すと他のワーカーとディスク I/O を取り合い、同じ走査が
  // 既定の 5 秒を超えることがある（実測で 191 ファイルの実行中に時間切れ。単独実行では再現しない）。
  // 対象はソースとドキュメント全体なので、ファイルが増えるほど余裕は減る。
  it('ソースとドキュメントに、タブ・改行・復帰以外の制御文字が無い', () => {
    const offenders = ROOTS.flatMap(listFiles).map(findControlChar).filter((x): x is string => x !== null)
    expect(offenders).toEqual([])
  }, 15_000)
})
