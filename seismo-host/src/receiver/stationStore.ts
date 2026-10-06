// 観測点の設定（割り当てと校正値）を、StationXML の 1 本（`stations.xml`）として読み書きする。
//
// **これが設定の正**（2026-10-05 ユーザー承認）。中身の形は `stationXml.ts`。今の期間が「いまの設定」、
// 閉じた期間が履歴なので、**保存することがそのまま履歴を足すこと**になる。生データは補正前の値で、
// 後から読み直すには「その時刻にどの観測点にあって、どう補正していたか」が要る —— 上書きで消える
// 形にしないのはそのため。
//
// - **起動のたびと設定を変えるたびに、記録を 1 つ足して丸ごと書き直す。** 一時ファイルへ書いて
//   `fsync` してから名前を付け替えるので、書き込みの途中で落ちても前のファイルが残る。
// - **ファイルが無いのは異常ではない** —— 観測点・校正の割り当ては任意で、無ければ全基板が未割当・
//   全センサーが既定の校正値のまま動く（起動の記録を書くときにファイルができる）。
// - **読めなければ空の設定で動き、以後このプロセスでは書かない。** 読めない理由が分からないまま
//   書き直すと、読めなかった分の履歴がまるごと消える。理由は警告として出し続け、人が直すのを待つ。
//   管理コンソールからの保存も、そのあいだは失敗として返す。

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

import { describeFailure, parseStationConfig } from './stationConfig'
import type { StationConfig } from './stationConfigTypes'
import { EMPTY_STATION_CONFIG } from './stationConfigTypes'
import {
  applyStationConfig,
  configAt,
  currentConfig,
  EMPTY_STATION_HISTORY,
  readStationXml,
  type StationHistoryDoc,
  type StationHistoryReason,
  writeStationXml,
} from './stationXml'

/** 設定ファイルの名前。 */
export const STATION_CONFIG_FILE = 'stations.xml'

export interface StationStoreOptions {
  readonly path: string
  /** いまの時刻（unix ミリ秒）。差し替えられるのはテストのため。 */
  readonly now?: () => number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 設定ファイルを読む。**無ければ空の履歴。** 読めなければ投げる。
 *
 * **どの記録の時点の設定も、設定の検証（`parseStationConfig`）に通す。** ホストはいまの設定を、
 * 評価台は過去の時点の設定を使う —— 入口をここ 1 つにしておけば、手で書き換えられたファイルでも
 * どちらにも検証を通らない値（範囲外の緯度・逆行列の無い回転など）が流れない。
 */
export function loadStationHistory(path: string): StationHistoryDoc {
  if (!existsSync(path)) return EMPTY_STATION_HISTORY
  const doc = readStationXml(readFileSync(path, 'utf8'))
  for (const rev of doc.revisions) {
    const checked = parseStationConfig(configAt(doc, rev.effectiveMs))
    if (!checked.ok) {
      throw new Error(
        `${new Date(rev.atMs).toISOString()} の記録の設定が通らない: ${describeFailure(checked.failure)}`,
      )
    }
  }
  return doc
}

export class StationStore {
  private readonly path: string
  private readonly now: () => number
  /** 読めた履歴。**読めなかったら `null` で、以後は書かない。** */
  private doc: StationHistoryDoc | null = null
  private failures = 0
  private written = 0
  private lastErrorText: string | null = null

  constructor(options: StationStoreOptions) {
    this.path = options.path
    this.now = options.now ?? Date.now
  }

  /** 書けなかった回数。 */
  get writeFailures(): number {
    return this.failures
  }

  /** 書けた回数（このプロセスで）。 */
  get recorded(): number {
    return this.written
  }

  /** 直近の失敗の文面。**書けた後も残す**（いつかは失敗したことが消えないように）。 */
  get lastError(): string | null {
    return this.lastErrorText
  }

  /**
   * ファイルを読んで、いまの設定を返す。**投げない。** 読めない・中身が設定として通らないときは
   * 空の設定と理由（`warning`）を返し、以後は書かない。
   *
   * **中身は設定の検証（`parseStationConfig`）も通す。** 手で書き換えられたファイルでも、
   * 処理が前提にする形（参照の整合・逆行列を持つ回転・正の感度）を崩させない。
   */
  open(): { readonly config: StationConfig; readonly warning: string | null } {
    let doc: StationHistoryDoc
    let config: StationConfig
    try {
      doc = loadStationHistory(this.path)
      config = currentConfig(doc)
    } catch (error) {
      this.doc = null
      return { config: EMPTY_STATION_CONFIG, warning: `読めない: ${messageOf(error)}` }
    }
    const checked = parseStationConfig(config)
    if (!checked.ok) {
      this.doc = null
      return { config: EMPTY_STATION_CONFIG, warning: describeFailure(checked.failure) }
    }
    this.doc = doc
    return { config: checked.config, warning: null }
  }

  /**
   * その時点の設定を記録として足し、ファイルへ書く。**投げる** —— 管理コンソールの保存は、
   * 書けなかったことを失敗として返さねばならない（黙って諦めると「保存したはずなのに次の起動で
   * 消えている」という一番気づきにくい壊れ方をする）。起動の記録は呼び出し側が受け止める。
   *
   * 呼び出し側は事前に `parseStationConfig` を通した設定を渡すこと（検証の単一情報源を保つ）。
   * **`fsync` まで掛ける。** 書くのは起動時と設定を変えたときだけで、頻度は無視できる。
   */
  record(config: StationConfig, reason: StationHistoryReason): void {
    if (this.doc === null) {
      this.fail('設定ファイルを読めなかったので書かない（読めない理由を直してから起動し直すこと）')
    }
    const atMs = this.now()
    const tmp = `${this.path}.tmp`
    let fd: number | null = null
    try {
      const next = applyStationConfig(this.doc as StationHistoryDoc, config, atMs, reason)
      const text = writeStationXml(next, atMs)
      mkdirSync(dirname(this.path), { recursive: true })
      fd = openSync(tmp, 'w')
      writeSync(fd, text)
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(tmp, this.path)
      this.doc = next
      this.written += 1
    } catch (error) {
      this.fail(messageOf(error))
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

  private fail(message: string): never {
    this.failures += 1
    this.lastErrorText = message
    throw new Error(message)
  }
}
