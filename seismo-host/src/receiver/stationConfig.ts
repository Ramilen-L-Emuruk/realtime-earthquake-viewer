// 基板がどこに置かれているか（観測点）を持つ。
//
// **基板が名乗るのは焼いても動かしても変わらない事実だけ。設置に由来する事実は
// ホストが持つ**（5ad8d711 セッションでの結論）。基板を別の部屋へ移せば観測点は
// 変わるが `boardKey`（MAC）は変わらない —— 両方を持たないと「去年のこの波形は
// どこで採ったか」が答えられなくなる。
//
// **割り当ては任意。** 観測点が決まっていない基板でも、受信・震度算出は止めない
// —— 設置場所を知らないだけで、揺れを測る仕事とは無関係。

import { existsSync, readFileSync } from 'node:fs'

import type { BoardKey } from '../protocol/types'

/** 観測点 1 つの割り当て。 */
export interface StationAssignment {
  readonly stationId: string
  readonly displayName: string
}

interface StationEntry extends StationAssignment {
  readonly boardKey: BoardKey
}

export interface StationConfig {
  readonly stations: readonly StationEntry[]
}

/** 空の設定。**全ての基板が未割当として扱われる**（ファイルが無いときの既定値）。 */
export const EMPTY_STATION_CONFIG: StationConfig = { stations: [] }

export type StationConfigParseFailure =
  | { readonly reason: 'not-an-object' }
  | { readonly reason: 'stations-not-array' }
  | { readonly reason: 'entry-not-an-object'; readonly index: number }
  | {
      readonly reason: 'entry-field-invalid'
      readonly index: number
      readonly field: string
      readonly value: unknown
    }
  | { readonly reason: 'duplicate-board-key'; readonly boardKey: string }

export type StationConfigParseResult =
  | { readonly ok: true; readonly config: StationConfig }
  | { readonly ok: false; readonly failure: StationConfigParseFailure }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 空白だけの値は拒み、前後の空白は落とす（`parsePacket.ts` の `nonEmptyString` と同じ理由）。 */
function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** `mac:` の中身。実機（`firmware/seismo-node/seismo-node.ino` の `g_macFlat`）は 12 桁の小文字 16 進数で送る。 */
const MAC_HEX_RE = /^[0-9a-fA-F]{12}$/

/**
 * `boardKey` を正規化する。**書式が実機の値と一致しなければ受けない。**
 *
 * `stationId` / `displayName` と同じく前後の空白は落とす。`mac:` は 16 進数の
 * 桁数まで検証し、大文字が混じっていても小文字へ揃える —— 実機は `%02x`（小文字固定）
 * でしか送ってこないので、ここで揃えておかないと**構文としては正しいのに実機の値とは
 * 永久に一致しない `boardKey` が、警告なしで設定ファイルに残ってしまう**
 * （`stationId` の重複を弾く理由と同じ種類の事故——見た目は正しいのに効かない）。
 *
 * `name:` は版 1 の識別子で、中身の書式を持たない。空でなければ受ける。
 */
function normalizeBoardKey(v: unknown): BoardKey | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed.startsWith('mac:')) {
    const hex = trimmed.slice(4)
    return MAC_HEX_RE.test(hex) ? `mac:${hex.toLowerCase()}` : null
  }
  if (trimmed.startsWith('name:')) {
    const name = trimmed.slice(5).trim()
    return name.length > 0 ? `name:${name}` : null
  }
  return null
}

/**
 * 設定ファイルの中身を読む。**例外を投げない**（`parsePacket.ts` と同じ理由 ——
 * 壊れた入力は運用者の書き間違いという日常で、投げると起動そのものが止まる）。
 */
export function parseStationConfig(raw: unknown): StationConfigParseResult {
  if (!isRecord(raw)) return { ok: false, failure: { reason: 'not-an-object' } }
  if (!Array.isArray(raw.stations)) {
    return { ok: false, failure: { reason: 'stations-not-array' } }
  }

  const seen = new Set<string>()
  const stations: StationEntry[] = []
  for (let i = 0; i < raw.stations.length; i++) {
    const entry: unknown = raw.stations[i]
    if (!isRecord(entry)) return { ok: false, failure: { reason: 'entry-not-an-object', index: i } }

    const boardKey = normalizeBoardKey(entry.boardKey)
    if (boardKey === null) {
      return {
        ok: false,
        failure: { reason: 'entry-field-invalid', index: i, field: 'boardKey', value: entry.boardKey },
      }
    }
    const stationId = nonEmptyString(entry.stationId)
    if (stationId === null) {
      return {
        ok: false,
        failure: { reason: 'entry-field-invalid', index: i, field: 'stationId', value: entry.stationId },
      }
    }
    const displayName = nonEmptyString(entry.displayName)
    if (displayName === null) {
      return {
        ok: false,
        failure: {
          reason: 'entry-field-invalid',
          index: i,
          field: 'displayName',
          value: entry.displayName,
        },
      }
    }

    // **同じ boardKey が 2 度現れたら弾く。** どちらを採るか黙って決めると、
    // 設定ファイルの後半を書き換えたつもりが前半の値のまま動き続ける事故になる。
    if (seen.has(boardKey)) {
      return { ok: false, failure: { reason: 'duplicate-board-key', boardKey } }
    }
    seen.add(boardKey)

    stations.push({ boardKey, stationId, displayName })
  }

  return { ok: true, config: { stations } }
}

function describeFailure(f: StationConfigParseFailure): string {
  switch (f.reason) {
    case 'not-an-object':
      return '設定の中身がオブジェクトではない'
    case 'stations-not-array':
      return 'stations が配列ではない'
    case 'entry-not-an-object':
      return `stations[${f.index}] がオブジェクトではない`
    case 'entry-field-invalid':
      return `stations[${f.index}].${f.field} が不正: ${JSON.stringify(f.value)}`
    case 'duplicate-board-key':
      return `boardKey が重複している: ${f.boardKey}`
  }
}

/**
 * 設定ファイルを読む。**ファイルが無いのは異常ではない** —— 観測点の割り当ては
 * 任意で、無ければ全基板が未割当のまま動き続ける。
 *
 * 読めてパースもできたときだけ `warning` は `null`。それ以外は空の設定へ倒し、
 * 理由を `warning` へ返す。**黙って空にはしない** —— 運用者が書き間違えたまま
 * 気づけなくなる。
 */
export function loadStationConfig(path: string): { config: StationConfig; warning: string | null } {
  if (!existsSync(path)) return { config: EMPTY_STATION_CONFIG, warning: null }

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    return { config: EMPTY_STATION_CONFIG, warning: `読めない: ${(e as Error).message}` }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { config: EMPTY_STATION_CONFIG, warning: `JSON として読めない: ${(e as Error).message}` }
  }

  const result = parseStationConfig(raw)
  if (!result.ok) return { config: EMPTY_STATION_CONFIG, warning: describeFailure(result.failure) }
  return { config: result.config, warning: null }
}

/** `boardKey` から観測点を引く。設定に無ければ未割当（`null`）。 */
export class StationDirectory {
  private readonly byBoardKey: ReadonlyMap<BoardKey, StationAssignment>

  /**
   * **重複した `boardKey` を弾く責務は `parseStationConfig` が持つ。** ここは
   * 渡された `StationConfig` をそのまま信頼するので、重複が紛れ込んだ `config` を
   * 渡すと `Map.set` が黙って後勝ちで上書きする。`parseStationConfig` を経由しない
   * 生成経路（複数設定のマージ等）を足すときは、その経路にも重複検出を持たせること。
   */
  constructor(config: StationConfig) {
    const m = new Map<BoardKey, StationAssignment>()
    for (const s of config.stations) {
      m.set(s.boardKey, { stationId: s.stationId, displayName: s.displayName })
    }
    this.byBoardKey = m
  }

  /** 設定を持たない（空の）帳面。基板は全て未割当。 */
  static empty(): StationDirectory {
    return new StationDirectory(EMPTY_STATION_CONFIG)
  }

  resolve(boardKey: BoardKey): StationAssignment | null {
    return this.byBoardKey.get(boardKey) ?? null
  }
}
