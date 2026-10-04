// 観測点の設定（割り当てと校正値）の履歴を、変わるたびに追記して残す。
//
// **設定ファイルは保存のたびに丸ごと上書きされる**（`stationConfig.ts` の `saveStationConfig`）。
// 生データは基板とセンサーで名乗り（`mseed3Record.ts` の識別子）、しかも補正前のカウント値
// なので、後から読み直すには「その時刻にどの観測点にあって、どの向き・感度・オフセットで
// 補正していたか」が要る。上書きだけでは、基板を移した日・校正し直した日を境にそれが消える。
//
// **置き場所は生データの隣**（`stations-history.ndjson`）。生データと一緒に運べば、
// どちらか片方だけが残る形になりにくい。
//
// **消さない・上書きしない。** 起動のたびと設定を変えるたびに 1 行足すだけ。
// 書けなくても投げない —— 設定の反映を止めるほうが重い。ただし数えて理由を残す。

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import type { StationConfig } from './stationConfigTypes'

export const STATION_HISTORY_FILE = 'stations-history.ndjson'

/** どの契機で書いたか。 */
export type StationHistoryReason =
  /** 起動して設定を読んだ（読めなかったときも、そのとき使った空の設定を書く）。 */
  | 'startup'
  /** 管理コンソールから設定を変えて保存できた。 */
  | 'changed'

export interface StationConfigHistoryOptions {
  readonly dir: string
  /** いまの時刻（unix ミリ秒）。差し替えられるのはテストのため。 */
  readonly now?: () => number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class StationConfigHistory {
  private readonly dir: string
  private readonly path: string
  private readonly now: () => number
  private failures = 0
  private written = 0
  private lastErrorText: string | null = null

  constructor(options: StationConfigHistoryOptions) {
    this.dir = options.dir
    this.path = join(options.dir, STATION_HISTORY_FILE)
    this.now = options.now ?? Date.now
  }

  /** 書けなかった回数。 */
  get writeFailures(): number {
    return this.failures
  }

  /** 書けた行数（このプロセスで）。 */
  get recorded(): number {
    return this.written
  }

  /** 直近の失敗の文面。**書けた後も残す**（いつかは失敗したことが消えないように）。 */
  get lastError(): string | null {
    return this.lastErrorText
  }

  /**
   * 1 行足す。**書けたら `true`。** 投げない。
   *
   * **`fsync` まで掛ける。** 書くのは起動時と設定を変えたときだけで、頻度は無視できる。
   * その直後に停電しても、変えた設定が履歴から消えないようにする。
   */
  record(config: StationConfig, reason: StationHistoryReason, warning: string | null): boolean {
    const line = `${JSON.stringify({ at: this.now(), reason, warning, config })}\n`
    let fd: number | null = null
    try {
      mkdirSync(this.dir, { recursive: true })
      fd = openSync(this.path, 'a')
      writeSync(fd, line)
      fsyncSync(fd)
      this.written += 1
      return true
    } catch (error) {
      this.failures += 1
      this.lastErrorText = messageOf(error)
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
