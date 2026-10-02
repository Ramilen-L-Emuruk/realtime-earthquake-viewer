// ホストが動いている間だけ置く印。**次の起動で、前回が正常に終わったかを知るため。**
//
// **落とされたホストは自分では何も書けない。** Windows の `Stop-Process`・PC の再起動・
// 電源断ではホストの終了の処理（`SIGINT` の受け手）が走らないので、ログは途中で
// 黙って切れる。しかも実機の起動コマンドがログを上書きしていたため、2026-10-02 は
// 配り直した時点で午後の記録が消えかけた（手元へ写していたので #462 を調べられた）。
//
// **だから「終わった」ではなく「まだ動いている」を残す。** 起動で印を書き、毎分の集計で
// 最後に生きていた時刻を進め、正常に終わったら消す。次の起動で印が残っていれば、
// 前回は終わりの記録を残せずに止まったことになり、止まった時刻は最後に生きていた
// 時刻から 1 分以内に絞れる。
//
// **書き込みは非同期で、失敗しても投げない。** この印は診断のためのもので、書けないことを
// 理由に受信を止めるほうが失うものが大きい。失敗は呼び出し側へ文字列で返す。

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { jstDateTime } from './jstTime'

export interface LifeMark {
  readonly pid: number
  readonly startedAtMs: number
  readonly lastAliveMs: number
}

/** 前回の様子。 */
export type PreviousRun =
  /** 印が無い ＝ 前回は正常に終わった（あるいは初めての起動）。 */
  | { readonly kind: 'none' }
  /** 印が残っていた ＝ 前回は終わりの記録を残せずに止まった。 */
  | { readonly kind: 'unclean'; readonly mark: LifeMark }
  /** 印はあるが読めなかった。**「無かった」と混ぜない** —— 前回が落ちたのかは分からない。 */
  | { readonly kind: 'unreadable'; readonly detail: string }

/** 印の中身を読む。**形が合わなければ null。** 数でない値や欠けた欄を 0 で埋めない。 */
export function parseLifeMark(text: string): LifeMark | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const { pid, startedAtMs, lastAliveMs } = o
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return null
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return null
  if (typeof lastAliveMs !== 'number' || !Number.isFinite(lastAliveMs)) return null
  return { pid, startedAtMs, lastAliveMs }
}

/** 前回の様子をログの行にする。**前回が正常に終わっていれば何も言わない。** */
export function buildPreviousRunLines(previous: PreviousRun): string[] {
  switch (previous.kind) {
    case 'none':
      return []
    case 'unclean': {
      const started = jstDateTime(previous.mark.startedAtMs) ?? '不明'
      const alive = jstDateTime(previous.mark.lastAliveMs) ?? '不明'
      return [
        `[host] 前回のホスト（pid ${previous.mark.pid}）は終了の記録を残さずに止まっていた` +
          `（起動 ${started}・最後に生きていたのは ${alive}。そこから 1 分以内に止まった。` +
          '強制終了（Stop-Process など）・PC の再起動・電源断のどれか）',
      ]
    }
    case 'unreadable':
      return [`[host] 前回の稼働の印を読めなかった（${previous.detail}）。前回が正常に終わったかは分からない`]
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

export class HostLifeMark {
  private readonly path: string
  private current: LifeMark | null = null
  /** **書き込みを重ねない。** 毎分の合図が遅い書き込みに追いつくと、古い中身が後から勝ちうる。 */
  private writing: Promise<string | null> = Promise.resolve(null)

  constructor(path: string) {
    this.path = path
  }

  /** 起動時に 1 回。前回の印を読み、今回の印を書く。 */
  async begin(pid: number, nowMs: number): Promise<{ previous: PreviousRun; error: string | null }> {
    let previous: PreviousRun
    try {
      const text = await readFile(this.path, 'utf8')
      const mark = parseLifeMark(text)
      previous = mark === null ? { kind: 'unreadable', detail: '中身が印の形をしていない' } : { kind: 'unclean', mark }
    } catch (error) {
      previous = isMissing(error) ? { kind: 'none' } : { kind: 'unreadable', detail: messageOf(error) }
    }
    this.current = { pid, startedAtMs: nowMs, lastAliveMs: nowMs }
    const error = await this.write(this.current)
    return { previous, error }
  }

  /** 毎分の合図。最後に生きていた時刻だけを進める。**始める前は何もしない。** */
  heartbeat(nowMs: number): Promise<string | null> {
    if (this.current === null) return Promise.resolve(null)
    this.current = { ...this.current, lastAliveMs: nowMs }
    return this.write(this.current)
  }

  /** 正常に終わった。印を消す。**始める前は何もしない**（よその印を消さない）。 */
  async end(): Promise<string | null> {
    if (this.current === null) return null
    this.current = null
    await this.writing
    try {
      await unlink(this.path)
      return null
    } catch (error) {
      return isMissing(error) ? null : messageOf(error)
    }
  }

  /**
   * **書き切ってから改名する。** 途中で落ちても、読めない半端な印は残らない。
   *
   * **置き場所のディレクトリは自分で作る。** `data/` は保存の部品が後から作るので、
   * 印を書く起動直後にはまだ無いことがある（新しく置いた機械の最初の起動）。
   */
  private write(mark: LifeMark): Promise<string | null> {
    const run = async (): Promise<string | null> => {
      const temp = `${this.path}.tmp`
      try {
        await mkdir(dirname(this.path), { recursive: true })
        await writeFile(temp, JSON.stringify(mark))
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
