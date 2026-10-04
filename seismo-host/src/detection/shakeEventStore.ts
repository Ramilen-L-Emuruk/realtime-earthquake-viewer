// 揺れの記録（`shakeEvent.ts`）を、日本時間の月ごとの NDJSON へ追記で残す（REQUIREMENTS.md §9）。
//
//   <dir>/events-YYYY-MM.ndjson   1 行 = 1 版。どの月に入れるかは揺れの始まり（startMs）で決める
//
// **追記だけで、書き換えない。** 照合の結果は新しい版の行として足し、読む側が `id` ごとに
// 最後の版を採る。書き換える形にすると、途中で落ちたときに古い版ごと失う。
//
// **波形は写さない。** 区間の時刻があれば、生データ（`data/raw/`）と合成波形（`data/wave/`）から
// 読み返せる（どちらも自動では消さない約束。README「生のパケットを miniSEED 3 で時間ごとに残す」）。
//
// **量は小さい。** 1 行 1 KB ほどで、実機の記録では 1 日 15 件前後の揺れ × 版 2〜3 —— 月 1〜2 MB。
// だから月ごとの 1 本で足り、索引も要らない（範囲で読むときは月のファイルを頭から読む）。
//
// **書けなくても投げない。** 揺れの検出と押し出しを止めるほうが重い。数えて理由を残す。

import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { JST_OFFSET_MS } from '../receiver/jstTime'
import type { ShakeEventRecord } from './shakeEvent'

/** 読み返す範囲の上限（ミリ秒）。月のファイルを丸ごと読むので、際限なく広げさせない。 */
export const EVENT_RANGE_MAX_MS = 93 * 24 * 3_600_000

/** 日本時間の年月（`YYYY-MM`）。 */
export function jstMonth(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 7)
}

export function eventFileName(month: string): string {
  return `events-${month}.ndjson`
}

/** `[fromMs, toMs)` に掛かる日本時間の月（古い順）。 */
export function monthsBetween(fromMs: number, toMs: number): string[] {
  const out: string[] = []
  let month = jstMonth(fromMs)
  const last = jstMonth(Math.max(fromMs, toMs - 1))
  for (let guard = 0; guard < 1200; guard++) {
    out.push(month)
    if (month === last) break
    const [y, m] = month.split('-').map(Number)
    month = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  }
  return out
}

export class ShakeEventStore {
  private readonly dir: string
  /** 書けた行の数。 */
  written = 0
  /** 書けなかった行の数。 */
  writeErrors = 0
  lastWriteError: string | null = null

  constructor(options: { readonly dir: string }) {
    this.dir = options.dir
  }

  /** 1 版を足す。書けたかを返す（投げない）。 */
  append(rec: ShakeEventRecord): boolean {
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(join(this.dir, eventFileName(jstMonth(rec.startMs))), `${JSON.stringify(rec)}\n`)
      this.written++
      return true
    } catch (error) {
      this.writeErrors++
      this.lastWriteError = error instanceof Error ? error.message : String(error)
      return false
    }
  }
}

export interface EventRangeResult {
  /** 範囲に始まりが入る揺れ（`id` ごとに最後の版）。始まりの古い順。 */
  readonly events: ShakeEventRecord[]
  /** 読めなかった行の数（壊れた行・途中で切れた行）。 */
  readonly unreadableLines: number
  /** 読めなかったファイル（無いファイルは数えない —— その月に揺れが無かっただけ）。 */
  readonly unreadableFiles: string[]
}

/** 範囲の揺れを読み返す。範囲の上限はここでは見ない（呼び出し側が入口で弾く）。 */
export async function readEventRange(params: {
  readonly dir: string
  readonly fromMs: number
  readonly toMs: number
}): Promise<EventRangeResult> {
  const latest = new Map<string, ShakeEventRecord>()
  let unreadableLines = 0
  const unreadableFiles: string[] = []
  for (const month of monthsBetween(params.fromMs, params.toMs)) {
    const name = eventFileName(month)
    let text: string
    try {
      text = await readFile(join(params.dir, name), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadableFiles.push(name)
      continue
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let rec: ShakeEventRecord
      try {
        rec = JSON.parse(line) as ShakeEventRecord
      } catch {
        unreadableLines++
        continue
      }
      if (typeof rec.id !== 'string' || typeof rec.rev !== 'number' || typeof rec.startMs !== 'number') {
        unreadableLines++
        continue
      }
      const prev = latest.get(rec.id)
      if (prev === undefined || rec.rev >= prev.rev) latest.set(rec.id, rec)
    }
  }
  const events = [...latest.values()]
    .filter((e) => e.startMs >= params.fromMs && e.startMs < params.toMs)
    .sort((a, b) => a.startMs - b.startMs)
  return { events, unreadableLines, unreadableFiles }
}
