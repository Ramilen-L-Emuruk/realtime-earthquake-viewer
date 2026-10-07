// 揺れの記録（`shakeEvent.ts`）を、揺れごとに JSON 1 本で残す（REQUIREMENTS.md §9）。
//
//   <dir>/<YYYY-MM>/<id>.json   その揺れの最新の版。どの月に入れるかは揺れの始まり（startMs・日本時間）で決める
//
// **版が増えたら置き換える。** 照合の結果が出ると同じ `id` の版が 1 つ進むので、一時ファイルへ書いて
// `fsync` してから名前を付け替える —— 書き込みの途中で落ちても、前の版が残る。
// **古い版で新しい版を上書きしない。** 帳面は版を順に書くので起きないはずだが、起きたら失敗として数える。
//
// **波形は写さない。** 区間の時刻があれば、生データ（`data/raw/`）と合成波形（`data/wave/`）から
// 読み返せる（どちらも自動では消さない約束）。
//
// **量は小さい。** 1 本 1 KB ほどで、実機の記録では 1 日 15 件前後 —— 月 450 本前後。
// 範囲で読むときは、掛かる月のディレクトリを一覧して読む（索引は要らない）。
//
// **書けなくても投げない。** 揺れの検出と押し出しを止めるほうが重い。数えて理由を残す。

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { jstMonth, monthsBetween, nameMayStartInRange, startMsFromFileName } from './eventRange'
import type { ShakeEventRecord } from './shakeEvent'

/**
 * 範囲の上限・月の数え方・名前から始まりを読む決まりは `eventRange.ts` が持つ
 * （管理コンソールと共有するため）。
 */
export { EVENT_RANGE_MAX_MS, jstMonth, monthsBetween, startMsFromFileName } from './eventRange'

const SUFFIX = '.json'

/**
 * `id` をファイル名へ。**英数字と `.`・`_`・`-` 以外は `%XX` へ逃がす** —— `id` は観測点の ID を含み、
 * 観測点の ID は管理コンソールから自由に付けられる（`/`・`:` などがあると置き場所を外れる・Windows で書けない）。
 * 先頭の `.` も逃がす（`.` や `..` という名前を作らない）。
 */
export function eventFileName(id: string): string {
  const escaped = [...new TextEncoder().encode(id)]
    .map((b) => {
      const ch = String.fromCharCode(b)
      return /[A-Za-z0-9._-]/.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, '0')}`
    })
    .join('')
  return `${escaped.startsWith('.') ? `%2E${escaped.slice(1)}` : escaped}${SUFFIX}`
}

/** その版の置き場所。 */
export function eventFilePath(dir: string, rec: Pick<ShakeEventRecord, 'id' | 'startMs'>): string {
  return join(dir, jstMonth(rec.startMs), eventFileName(rec.id))
}

function isRecord(v: unknown): v is ShakeEventRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Partial<ShakeEventRecord>
  return typeof r.id === 'string' && typeof r.rev === 'number' && typeof r.startMs === 'number'
}

/**
 * 残っている版の番号。**無い・読めないなら `null`**（読めない前の版は、新しい版で置き換えてよい ——
 * 版は毎回その揺れの記録まるごとなので、置き換えて失うものは無い）。
 */
function revOnDisk(path: string): number | null {
  if (!existsSync(path)) return null
  try {
    const prev: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(prev) ? prev.rev : null
  } catch {
    return null
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ShakeEventStore {
  private readonly dir: string
  /** 書けた版の数。 */
  written = 0
  /** 書けなかった版の数。 */
  writeErrors = 0
  lastWriteError: string | null = null

  constructor(options: { readonly dir: string }) {
    this.dir = options.dir
  }

  /** その揺れの最新の版として残す。書けたかを返す（投げない）。 */
  save(rec: ShakeEventRecord): boolean {
    const path = eventFilePath(this.dir, rec)
    const tmp = `${path}.tmp`
    let fd: number | null = null
    try {
      const prevRev = revOnDisk(path)
      if (prevRev !== null && prevRev > rec.rev) {
        throw new Error(`${rec.id} の版 ${rec.rev} を、残っている版 ${prevRev} の上に書こうとした`)
      }
      mkdirSync(join(this.dir, jstMonth(rec.startMs)), { recursive: true })
      fd = openSync(tmp, 'w')
      writeSync(fd, `${JSON.stringify(rec)}\n`)
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(tmp, path)
      this.written++
      return true
    } catch (error) {
      this.writeErrors++
      this.lastWriteError = messageOf(error)
      return false
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // 閉じられなくても、書けたかどうかは上で決まっている。
        }
      }
    }
  }
}

export interface EventRangeResult {
  /** 範囲に始まりが入る揺れ（最新の版）。始まりの古い順。 */
  readonly events: ShakeEventRecord[]
  /**
   * 読めなかったもの（`<月>/<ファイル名>` か、一覧できなかった `<月>`）。**無い月は数えない** ——
   * その月に揺れが無かっただけ。
   */
  readonly unreadableFiles: string[]
}

/**
 * 範囲の揺れを読み返す。範囲の上限はここでは見ない（呼び出し側が入口で弾く）。
 *
 * **名前で範囲の外と分かるファイルは開かない。** 管理コンソールは直近 3 時間を 30 秒ごとに読み直すので、
 * 月のファイルを全部開くと、そのたびに数百本ぶんの読み込みが走る（観測点 3 つ・月 1350 本の実測で 1 回 0.5〜0.7 秒。
 * 名前で飛ばすと 7〜11 ミリ秒）。
 * **名前の始まりは中身の始まりを整数へ丸めた値なので、範囲の両端を 1 ミリ秒ずつ広げて比べる**
 * （`nameMayStartInRange`）—— 端の内側で始まった揺れを、丸めで外を名乗るというだけで取りこぼさない。
 * 名前から始まりを読めないファイルは、これまでどおり開いて中身で決める。
 */
export async function readEventRange(params: {
  readonly dir: string
  readonly fromMs: number
  readonly toMs: number
}): Promise<EventRangeResult> {
  const events: ShakeEventRecord[] = []
  const unreadableFiles: string[] = []
  for (const month of monthsBetween(params.fromMs, params.toMs)) {
    let names: string[]
    try {
      names = await readdir(join(params.dir, month))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadableFiles.push(month)
      continue
    }
    // 一時ファイル（`.json.tmp`）は書き込みの途中なので読まない。
    for (const name of names.filter((n) => n.endsWith(SUFFIX)).sort()) {
      const startFromName = startMsFromFileName(name)
      if (startFromName !== null && !nameMayStartInRange(startFromName, params.fromMs, params.toMs)) continue
      let rec: unknown
      try {
        rec = JSON.parse(await readFile(join(params.dir, month, name), 'utf8'))
      } catch {
        unreadableFiles.push(`${month}/${name}`)
        continue
      }
      if (!isRecord(rec)) {
        unreadableFiles.push(`${month}/${name}`)
        continue
      }
      if (rec.startMs >= params.fromMs && rec.startMs < params.toMs) events.push(rec)
    }
  }
  events.sort((a, b) => a.startMs - b.startMs)
  return { events, unreadableFiles }
}
