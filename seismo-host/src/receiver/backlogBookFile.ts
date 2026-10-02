// 欠けの帳面（`backlogBook.ts`）をファイルへ書き出し、次の起動で読み戻す。
//
// **ホストが止まっている間の欠けを知るため。** 止まる前に何番まで受けたかを覚えていないと、
// 起動したあとの最初のパケットを見ても、その間に抜けたのか分からない。
//
// **書き込みは非同期で、失敗しても投げない**（稼働の印 `hostLifeMark.ts` と同じ考え方）。
// 取り戻しは脇役なので、書けないことを理由に受信を止めるほうが失うものが大きい。
// 失敗は文字列で呼び出し側へ返す。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { type BacklogBookState, parseBacklogBookState } from './backlogBook'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * 前の起動の帳面を読む。
 *
 * - ファイルが無い: `{ state: null, problem: null }`（初めての起動・前回が帳面を書く前に止まった）
 * - 読めない・形が合わない: `{ state: null, problem: 理由 }`。**「無かった」と混ぜない** ——
 *   その場合、止まっていた間の欠けは分からないまま始まる
 */
export async function readBacklogBookFile(
  path: string,
): Promise<{ readonly state: BacklogBookState | null; readonly problem: string | null }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return isMissing(error) ? { state: null, problem: null } : { state: null, problem: messageOf(error) }
  }
  const state = parseBacklogBookState(text)
  return state === null ? { state: null, problem: '中身が帳面の形をしていない' } : { state, problem: null }
}

export class BacklogBookWriter {
  private readonly path: string
  /** **書き込みを重ねない。** 遅い書き込みに次の合図が追いつくと、古い中身が後から勝ちうる。 */
  private writing: Promise<string | null> = Promise.resolve(null)

  constructor(path: string) {
    this.path = path
  }

  /**
   * 書き出す。**書き切ってから改名する** —— 途中で落ちても読めない半端な帳面は残らない。
   * 置き場所のディレクトリは自分で作る（新しく置いた機械の最初の起動では `data/` がまだ無い）。
   */
  save(state: BacklogBookState): Promise<string | null> {
    const text = JSON.stringify(state)
    const run = async (): Promise<string | null> => {
      const temp = `${this.path}.tmp`
      try {
        await mkdir(dirname(this.path), { recursive: true })
        await writeFile(temp, text)
        await rename(temp, this.path)
        return null
      } catch (error) {
        return messageOf(error)
      }
    }
    this.writing = this.writing.then(run, run)
    return this.writing
  }
}
