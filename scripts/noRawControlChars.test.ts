import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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

/**
 * バイト値で引いて「置いてはいけない制御文字か」を返す表。
 * タブ (09)・改行 (0A)・復帰 (0D) 以外の C0 制御文字と DEL (7F) が 1。
 *
 * **`Set` で持たない。** 全バイトを 1 つずつ問い合わせるので呼び出しは 1000 万回を超え、
 * `Set.has` だと走査だけで 0.22 秒かかる（表引きなら 0.02〜0.05 秒）。
 */
const FORBIDDEN = ((): Uint8Array => {
  const table = new Uint8Array(0x100)
  for (let code = 0x00; code < 0x20; code++) table[code] = 1
  for (const allowed of [0x09, 0x0a, 0x0d]) table[allowed] = 0
  table[0x7f] = 1
  return table
})()

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
async function findControlChar(path: string): Promise<string | null> {
  const buf = await readFile(path)
  let line = 1
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]
    if (byte === 0x0a) { line++; continue }
    if (FORBIDDEN[byte]) {
      const hex = byte.toString(16).padStart(2, '0').toUpperCase()
      return `${path}:${line} に生の制御文字 0x${hex}（エスケープで書くこと）`
    }
  }
  return null
}

describe('生の制御文字を置かない', () => {
  // **ファイルを 1 件ずつ順番に読まない。** 対象は 576 件・12MB（2026-09-18 時点。走査
  // するのは作業ツリーの実体なので、`.gitignore` された手元の使い捨てスクリプトも数に入る）。
  // 1 件ずつ `readFileSync` で読むと待ちが件数だけ積み上がり、`npm test` の並列実行で他ワーカーとの
  // 競合が乗ると既定の 5 秒を超えて**このテストだけが時間切れで落ちる**（実際に起きた。単独で
  // 回すと通ってしまうので原因が分かりにくい）。`Promise.all` でまとめて投げれば待ちを重ねられる。
  //
  // 上限を延ばす手当て（`{ timeout: 15_000 }`）は採らない。vitest 上の実測で**単独 1.98 秒 →
  // 0.43 秒・並列実行下で 532ms** となり 5 秒に対して 9 倍の余裕ができるうえ、上限を緩めると
  // **このテストに入り込んだ性能劣化を見逃す網**になる（`vitest.config.ts` が既定の 5 秒を
  // 据え置いている理由と同じ）。
  it('ソースとドキュメントに、タブ・改行・復帰以外の制御文字が無い', async () => {
    const found = await Promise.all(ROOTS.flatMap(listFiles).map(findControlChar))
    const offenders = found.filter((x): x is string => x !== null)
    expect(offenders).toEqual([])
  })
})
