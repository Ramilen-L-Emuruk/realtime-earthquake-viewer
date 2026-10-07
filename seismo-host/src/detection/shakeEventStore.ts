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
// 範囲で読むときは、新しい月からディレクトリを一覧し、ファイル名の始まりで並べて上限の件数まで開く
// （`readEventRange`。索引は要らない）。
//
// **書けなくても投げない。** 揺れの検出と押し出しを止めるほうが重い。数えて理由を残す。

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { jstMonth, NAME_START_SLACK_MS, nameMayStartInRange, startMsFromFileName } from './eventRange'
import type { ShakeEventRecord } from './shakeEvent'

/**
 * 件数の上限・月の数え方・名前から始まりを読む決まりは `eventRange.ts` が持つ
 * （管理コンソールと共有するため）。
 */
export { EVENT_PAGE_LIMIT_MAX, jstMonth, monthsBetween, startMsFromFileName } from './eventRange'

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

export interface EventRangeParams {
  readonly dir: string
  readonly fromMs: number
  readonly toMs: number
  /** 返す件数の上限（新しいほうから数える）。 */
  readonly limit: number
  /** この観測点の記録だけ（null なら全部）。**数える前に絞る。** */
  readonly stationId: string | null
  /** 判定が「生活振動らしい」（`local-like`）ものを除く。**数える前に除く。** */
  readonly hideLocal: boolean
}

export interface EventRangeResult {
  /** 返す揺れ（最新の版）。始まりの古い順。 */
  readonly events: ShakeEventRecord[]
  /**
   * 読めなかったもの（`<月>/<ファイル名>` か、一覧できなかった `<月>`）。**無い月は数えない** ——
   * その月に揺れが無かっただけ。区切りより古くて開かなかったものは入らない。
   */
  readonly unreadableFiles: string[]
  /** 範囲のうち古いほうに、返していない記録が残っているか（件数の上限で区切ったか）。 */
  readonly truncated: boolean
  /**
   * **`[coveredFromMs, toMs)` に始まりが入る記録は漏れなく返した**（絞り込みに合うもの）。区切らなければ `fromMs`。
   * 続きは `toMs` をこの値にして読めばよい（境目の記録が 2 回出ることはあるが、同じ `id` なので受け手で揃う）。
   */
  readonly coveredFromMs: number
}

/** 開く候補。`key` は並べる始まり（名前から読めればその値、読めなければ中身の始まり）。 */
interface Candidate {
  readonly path: string
  readonly label: string
  readonly key: number
  /** 名前から始まりを読めず、並べるために先に開いた中身（読めなかったら null）。 */
  readonly opened?: unknown
}

const MONTH_DIR = /^\d{4}-\d{2}$/

/**
 * 範囲の揺れを、**新しいほうから `limit` 件まで**読み返す（2026-10-07 ユーザー承認）。範囲の広さは見ない。
 *
 * **開くのは返す分だけ。** 範囲に掛かる月を一覧し、ファイル名の始まり（`<観測点>-<始まり>.json`）で新しい順に
 * 並べ、上から開いていく。管理コンソールは直近 3 時間を 30 秒ごとに読み直すので、月のファイルを全部開くと
 * そのたびに数百本ぶんの読み込みが走る（観測点 3 つ・月 1350 本の実測で 1 回 0.5〜0.7 秒。名前で飛ばすと 7〜11 ミリ秒）。
 * **名前の始まりは中身の始まりを整数へ丸めた値なので、範囲の両端を 1 ミリ秒ずつ広げて比べる**
 * （`nameMayStartInRange`）—— 端の内側で始まった揺れを、丸めで外を名乗るというだけで取りこぼさない。
 *
 * **区切りでは、同じ始まり（丸めの ±1 ミリ秒）の記録を分けない。** 上限に届いたら、届いた記録の名前の始まりから
 * 1 ミリ秒以内のものまで続けて返し、見終えた範囲の頭をそこから 1 ミリ秒手前に置く。こうすると、返さなかった
 * 記録の中身の始まりは必ずその頭より前にある（名前が 2 ミリ秒以上古い → 中身は 1.5 ミリ秒以上古い）。
 *
 * **名前から始まりを読めないファイルは、並べる前に開いて中身の始まりで並べる**（数は少ない前提）。
 * 読めなかったものは数えず、名前を添える。
 *
 * **月は置き場所を一覧して拾う**（`monthsBetween` で範囲の月を作らない）—— 範囲に上限が無いので、1970 年から
 * 2100 年までを頼まれても、実際にある月のディレクトリだけを見る。
 */
export async function readEventRange(params: EventRangeParams): Promise<EventRangeResult> {
  const { dir, fromMs, toMs, limit } = params
  const unreadableFiles: string[] = []
  const fromMonth = jstMonth(fromMs)
  const toMonth = jstMonth(Math.max(fromMs, toMs - 1))
  let monthDirs: string[]
  try {
    monthDirs = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], unreadableFiles, truncated: false, coveredFromMs: fromMs }
    throw error
  }
  // **新しい月から 1 か月ずつ一覧する。** 記録は中身の始まりの月へ置く（`eventFilePath`）ので、古い月の記録は
  // 新しい月の記録より必ず古い。区切りに届いたら、それより古い月は一覧もしない —— 範囲に上限が無いので、
  // 全部の月を一覧してから並べると、返すのは 500 件でも蓄積した年数に比例して重くなる。
  const months = monthDirs.filter((m) => MONTH_DIR.test(m) && m >= fromMonth && m <= toMonth).sort().reverse()

  const events: ShakeEventRecord[] = []
  let cutKey: number | null = null
  let truncated = false
  scan: for (const month of months) {
    const candidates = await monthCandidates(dir, month, fromMs, toMs, unreadableFiles)
    for (const c of candidates) {
      // 月をまたいでも同じ規則で切る（境目の丸め ±1 ミリ秒の記録は、古い月の側にあっても分けない）。
      if (cutKey !== null && c.key < cutKey - NAME_START_SLACK_MS) {
        truncated = true
        break scan
      }
      const rec = c.opened !== undefined ? c.opened : await readRecord(c.path)
      if (!isRecord(rec)) {
        unreadableFiles.push(c.label)
        continue
      }
      if (!(rec.startMs >= fromMs && rec.startMs < toMs)) continue
      if (params.stationId !== null && rec.stationId !== params.stationId) continue
      if (params.hideLocal && rec.verdict === 'local-like') continue
      events.push(rec)
      if (cutKey === null && events.length >= limit) cutKey = c.key
    }
  }
  events.sort((a, b) => a.startMs - b.startMs)
  return {
    events,
    unreadableFiles: unreadableFiles.sort(),
    truncated,
    coveredFromMs: truncated && cutKey !== null ? cutKey - NAME_START_SLACK_MS : fromMs,
  }
}

/**
 * 1 か月ぶんの候補を、新しい順に並べて返す。一覧できなかった月・読めなかったファイルは `unreadableFiles` へ足す。
 * 名前から始まりを読めないファイルはここで開き、中身の始まりで並べる（範囲の外なら候補にしない —— 残すと、
 * 区切りより古い候補として「続きがある」と言ってしまう）。
 */
async function monthCandidates(
  dir: string,
  month: string,
  fromMs: number,
  toMs: number,
  unreadableFiles: string[],
): Promise<Candidate[]> {
  let names: string[]
  try {
    names = await readdir(join(dir, month))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadableFiles.push(month)
    return []
  }
  const candidates: Candidate[] = []
  // 一時ファイル（`.json.tmp`）は書き込みの途中なので読まない。
  for (const name of names.filter((n) => n.endsWith(SUFFIX))) {
    const path = join(dir, month, name)
    const label = `${month}/${name}`
    const startFromName = startMsFromFileName(name)
    if (startFromName !== null) {
      if (nameMayStartInRange(startFromName, fromMs, toMs)) candidates.push({ path, label, key: startFromName })
      continue
    }
    const opened = await readRecord(path)
    if (opened === null) {
      unreadableFiles.push(label)
      continue
    }
    if (opened.startMs >= fromMs && opened.startMs < toMs) candidates.push({ path, label, key: opened.startMs, opened })
  }
  // 新しい順。同じ始まりは名前で並べて、毎回同じ順にする。
  return candidates.sort((a, b) => b.key - a.key || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
}

/** 1 本読む。**読めなければ null**（壊れている・記録の形でない）。 */
async function readRecord(path: string): Promise<ShakeEventRecord | null> {
  try {
    const rec: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(rec) ? rec : null
  } catch {
    return null
  }
}
