// 基板がどこに置かれているか（観測点）と、センサーごとの校正値を持つ。
//
// **基板が名乗るのは焼いても動かしても変わらない事実だけ。設置に由来する事実は
// ホストが持つ**（5ad8d711 セッションでの結論）。基板を別の部屋へ移せば観測点は
// 変わるが `boardKey`（MAC）は変わらない —— 両方を持たないと「去年のこの波形は
// どこで採ったか」が答えられなくなる。
//
// **観測点（設置場所）と基板（MAC）を分けて持つ**（REQUIREMENTS.md §15）。
// 同じ観測点に複数の基板を割り当てられる ——「複数台の統合」（§7）の前提。
//
// **割り当ては任意。** 観測点が決まっていない基板・校正値が決まっていないセンサーが
// あっても、受信・震度算出は止めない —— 設置場所や校正を知らないだけで、揺れを
// 測る仕事とは無関係。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// **型・既定値は `stationConfigTypes.ts` に置く。** 管理コンソール（`src/admin/`）が
// `import type` で使うため、Node 専用コード（`node:fs` 等）と同じファイルへ置けない
// ——理由はあちらの冒頭コメント。
export type { Vec3, Mat3, StationInfo, SensorCalibration, SensorEntry, BoardEntry, StationConfig } from './stationConfigTypes'
export { DEFAULT_SENSOR_CALIBRATION, EMPTY_STATION_CONFIG } from './stationConfigTypes'
import {
  DEFAULT_SENSOR_CALIBRATION,
  EMPTY_STATION_CONFIG,
  IDENTITY_ROTATION,
  UNIT_SENSITIVITY,
  ZERO_OFFSET,
} from './stationConfigTypes'
import type {
  BoardEntry,
  Mat3,
  SensorCalibration,
  SensorEntry,
  StationConfig,
  StationInfo,
  Vec3,
} from './stationConfigTypes'
import type { BoardKey } from '../protocol/types'

export type StationConfigParseFailure =
  | { readonly reason: 'not-an-object' }
  | { readonly reason: 'stations-not-array' }
  | { readonly reason: 'boards-not-array' }
  | { readonly reason: 'station-not-an-object'; readonly index: number }
  | {
      readonly reason: 'station-field-invalid'
      readonly index: number
      readonly field: string
      readonly value: unknown
    }
  | { readonly reason: 'duplicate-station-id'; readonly stationId: string }
  | { readonly reason: 'board-not-an-object'; readonly index: number }
  | {
      readonly reason: 'board-field-invalid'
      readonly index: number
      readonly field: string
      readonly value: unknown
    }
  | { readonly reason: 'duplicate-board-key'; readonly boardKey: string }
  /** 基板が `stations[]` に無い観測点を指している。**参照整合性。** */
  | { readonly reason: 'unknown-station-id'; readonly boardIndex: number; readonly stationId: string }
  | { readonly reason: 'sensors-not-array'; readonly boardIndex: number }
  | { readonly reason: 'sensor-not-an-object'; readonly boardIndex: number; readonly sensorIndex: number }
  | {
      readonly reason: 'sensor-field-invalid'
      readonly boardIndex: number
      readonly sensorIndex: number
      readonly field: string
      readonly value: unknown
    }
  | {
      readonly reason: 'duplicate-sensor-id'
      readonly boardIndex: number
      readonly sensorId: string
    }

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

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** `mac:` の中身。実機（`firmware/seismo-node/seismo-node.ino` の `g_macFlat`）は 12 桁の小文字 16 進数で送る。 */
const MAC_HEX_RE = /^[0-9a-fA-F]{12}$/

/**
 * `boardKey` を正規化する。**書式が実機の値と一致しなければ受けない。**
 *
 * `mac:` は 16 進数の桁数まで検証し、大文字が混じっていても小文字へ揃える —— 実機は
 * `%02x`（小文字固定）でしか送ってこないので、ここで揃えておかないと**構文としては
 * 正しいのに実機の値とは永久に一致しない `boardKey` が、警告なしで設定ファイルに残る**。
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

/** 緯度・経度の範囲。地球上の値であることだけを確かめる（測地系の検証はしない）。 */
function isValidLat(v: unknown): v is number {
  return isFiniteNumber(v) && v >= -90 && v <= 90
}
function isValidLon(v: unknown): v is number {
  return isFiniteNumber(v) && v >= -180 && v <= 180
}

/** 3 要素とも有限数か。`itemOk` で要素ごとの追加条件（正であること等）を課せる。 */
function isVec3(v: unknown, itemOk: (n: number) => boolean = () => true): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => isFiniteNumber(x) && itemOk(x))
}

function isMat3(v: unknown): v is Mat3 {
  return Array.isArray(v) && v.length === 3 && v.every((row) => isVec3(row))
}

function parseStations(
  raw: unknown,
): { ok: true; stations: StationInfo[] } | { ok: false; failure: StationConfigParseFailure } {
  if (!Array.isArray(raw)) return { ok: false, failure: { reason: 'stations-not-array' } }

  const seen = new Set<string>()
  const stations: StationInfo[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i]
    if (!isRecord(entry)) return { ok: false, failure: { reason: 'station-not-an-object', index: i } }

    const stationId = nonEmptyString(entry.stationId)
    if (stationId === null) {
      return {
        ok: false,
        failure: { reason: 'station-field-invalid', index: i, field: 'stationId', value: entry.stationId },
      }
    }
    const displayName = nonEmptyString(entry.displayName)
    if (displayName === null) {
      return {
        ok: false,
        failure: {
          reason: 'station-field-invalid',
          index: i,
          field: 'displayName',
          value: entry.displayName,
        },
      }
    }
    if (!isValidLat(entry.lat)) {
      return {
        ok: false,
        failure: { reason: 'station-field-invalid', index: i, field: 'lat', value: entry.lat },
      }
    }
    if (!isValidLon(entry.lon)) {
      return {
        ok: false,
        failure: { reason: 'station-field-invalid', index: i, field: 'lon', value: entry.lon },
      }
    }

    // **同じ stationId が 2 度現れたら弾く。** どちらを採るか黙って決めると、
    // 設定ファイルの後半を書き換えたつもりが前半の値のまま動き続ける事故になる
    // （`boardKey` の重複を弾く理由と同じ）。
    if (seen.has(stationId)) {
      return { ok: false, failure: { reason: 'duplicate-station-id', stationId } }
    }
    seen.add(stationId)

    stations.push({ stationId, displayName, lat: entry.lat, lon: entry.lon })
  }

  return { ok: true, stations }
}

function parseSensors(
  raw: unknown,
  boardIndex: number,
): { ok: true; sensors: SensorEntry[] } | { ok: false; failure: StationConfigParseFailure } {
  if (!Array.isArray(raw)) return { ok: false, failure: { reason: 'sensors-not-array', boardIndex } }

  const seen = new Set<string>()
  const sensors: SensorEntry[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i]
    if (!isRecord(entry)) {
      return { ok: false, failure: { reason: 'sensor-not-an-object', boardIndex, sensorIndex: i } }
    }

    const sensorId = nonEmptyString(entry.sensorId)
    if (sensorId === null) {
      return {
        ok: false,
        failure: {
          reason: 'sensor-field-invalid',
          boardIndex,
          sensorIndex: i,
          field: 'sensorId',
          value: entry.sensorId,
        },
      }
    }

    const enabled = entry.enabled ?? true
    if (typeof enabled !== 'boolean') {
      return {
        ok: false,
        failure: {
          reason: 'sensor-field-invalid',
          boardIndex,
          sensorIndex: i,
          field: 'enabled',
          value: entry.enabled,
        },
      }
    }

    const rotation = entry.rotation ?? IDENTITY_ROTATION
    if (!isMat3(rotation)) {
      return {
        ok: false,
        failure: {
          reason: 'sensor-field-invalid',
          boardIndex,
          sensorIndex: i,
          field: 'rotation',
          value: entry.rotation,
        },
      }
    }

    const offset = entry.offset ?? ZERO_OFFSET
    if (!isVec3(offset)) {
      return {
        ok: false,
        failure: {
          reason: 'sensor-field-invalid',
          boardIndex,
          sensorIndex: i,
          field: 'offset',
          value: entry.offset,
        },
      }
    }

    const sensitivity = entry.sensitivity ?? UNIT_SENSITIVITY
    // **各軸の倍率は正でなければならない。** 0 は軸を永久に殺し、負は符号を反転する ——
    // どちらも「補正」ではなく「壊す」側の効果で、無効化したいだけなら `enabled` を使う。
    if (!isVec3(sensitivity, (n) => n > 0)) {
      return {
        ok: false,
        failure: {
          reason: 'sensor-field-invalid',
          boardIndex,
          sensorIndex: i,
          field: 'sensitivity',
          value: entry.sensitivity,
        },
      }
    }

    const noiseDensityRaw = entry.noiseDensity ?? null
    if (noiseDensityRaw !== null && !(isFiniteNumber(noiseDensityRaw) && noiseDensityRaw > 0)) {
      return {
        ok: false,
        failure: {
          reason: 'sensor-field-invalid',
          boardIndex,
          sensorIndex: i,
          field: 'noiseDensity',
          value: entry.noiseDensity,
        },
      }
    }

    // **同じ基板の中で sensorId が 2 度現れたら弾く。** 別の基板でなら使い回せる ——
    // 配線の都合で同じ名前が複数の基板に現れるのは自然（例: どの基板も `i2c0-68`）。
    if (seen.has(sensorId)) {
      return { ok: false, failure: { reason: 'duplicate-sensor-id', boardIndex, sensorId } }
    }
    seen.add(sensorId)

    sensors.push({
      sensorId,
      enabled,
      rotation,
      offset,
      sensitivity,
      noiseDensity: noiseDensityRaw,
    })
  }

  return { ok: true, sensors }
}

/**
 * 設定ファイルの中身を読む。**例外を投げない**（`parsePacket.ts` と同じ理由 ——
 * 壊れた入力は運用者の書き間違いという日常で、投げると起動そのものが止まる）。
 */
export function parseStationConfig(raw: unknown): StationConfigParseResult {
  if (!isRecord(raw)) return { ok: false, failure: { reason: 'not-an-object' } }

  const parsedStations = parseStations(raw.stations)
  if (!parsedStations.ok) return parsedStations
  const stationIds = new Set(parsedStations.stations.map((s) => s.stationId))

  if (!Array.isArray(raw.boards)) return { ok: false, failure: { reason: 'boards-not-array' } }

  const seenBoardKeys = new Set<string>()
  const boards: BoardEntry[] = []
  for (let i = 0; i < raw.boards.length; i++) {
    const entry: unknown = raw.boards[i]
    if (!isRecord(entry)) return { ok: false, failure: { reason: 'board-not-an-object', index: i } }

    const boardKey = normalizeBoardKey(entry.boardKey)
    if (boardKey === null) {
      return {
        ok: false,
        failure: { reason: 'board-field-invalid', index: i, field: 'boardKey', value: entry.boardKey },
      }
    }
    const stationId = nonEmptyString(entry.stationId)
    if (stationId === null) {
      return {
        ok: false,
        failure: { reason: 'board-field-invalid', index: i, field: 'stationId', value: entry.stationId },
      }
    }
    if (!stationIds.has(stationId)) {
      return { ok: false, failure: { reason: 'unknown-station-id', boardIndex: i, stationId } }
    }

    if (seenBoardKeys.has(boardKey)) {
      return { ok: false, failure: { reason: 'duplicate-board-key', boardKey } }
    }
    seenBoardKeys.add(boardKey)

    const parsedSensors = parseSensors(entry.sensors, i)
    if (!parsedSensors.ok) return parsedSensors

    boards.push({ boardKey, stationId, sensors: parsedSensors.sensors })
  }

  return { ok: true, config: { stations: parsedStations.stations, boards } }
}

/**
 * 検証に失敗した理由を人が読める1行へ変える。**`/api/*` の書き込みハンドラ
 * （#313 段 B）も使う** —— 起動時のログと同じ文言で、書き込みを拒んだ理由を
 * リクエスト元へ返す。
 */
export function describeFailure(f: StationConfigParseFailure): string {
  switch (f.reason) {
    case 'not-an-object':
      return '設定の中身がオブジェクトではない'
    case 'stations-not-array':
      return 'stations が配列ではない'
    case 'boards-not-array':
      return 'boards が配列ではない'
    case 'station-not-an-object':
      return `stations[${f.index}] がオブジェクトではない`
    case 'station-field-invalid':
      return `stations[${f.index}].${f.field} が不正: ${JSON.stringify(f.value)}`
    case 'duplicate-station-id':
      return `stationId が重複している: ${f.stationId}`
    case 'board-not-an-object':
      return `boards[${f.index}] がオブジェクトではない`
    case 'board-field-invalid':
      return `boards[${f.index}].${f.field} が不正: ${JSON.stringify(f.value)}`
    case 'duplicate-board-key':
      return `boardKey が重複している: ${f.boardKey}`
    case 'unknown-station-id':
      return `boards[${f.boardIndex}].stationId が stations に無い: ${f.stationId}`
    case 'sensors-not-array':
      return `boards[${f.boardIndex}].sensors が配列ではない`
    case 'sensor-not-an-object':
      return `boards[${f.boardIndex}].sensors[${f.sensorIndex}] がオブジェクトではない`
    case 'sensor-field-invalid':
      return `boards[${f.boardIndex}].sensors[${f.sensorIndex}].${f.field} が不正: ${JSON.stringify(f.value)}`
    case 'duplicate-sensor-id':
      return `boards[${f.boardIndex}] の中で sensorId が重複している: ${f.sensorId}`
    default:
      // **`packetTally.ts` の `assertNever` と同じ理由。** ここが無いと、`reason` の
      // 種類を足して分岐を書き忘れたときに `undefined` が黙って返り、`/status` の
      // `stationConfigWarning` から警告そのものが消える（JSON では欠けたキーと同じ形になる
      // ので、運用者には「読み込みに成功した」ようにしか見えない）。
      return assertNever(f)
  }
}

function assertNever(value: never): never {
  throw new Error(`理由を決めていない失敗: ${JSON.stringify(value)}`)
}

/** `readingHub.ts` と同じ形。`Error` でない値が投げられても `.message` で墜落しない。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 設定ファイルを読む。**ファイルが無いのは異常ではない** —— 観測点・校正の割り当ては
 * 任意で、無ければ全基板が未割当・全センサーが既定の校正値のまま動き続ける。
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
    return { config: EMPTY_STATION_CONFIG, warning: `読めない: ${messageOf(e)}` }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { config: EMPTY_STATION_CONFIG, warning: `JSON として読めない: ${messageOf(e)}` }
  }

  const result = parseStationConfig(raw)
  if (!result.ok) return { config: EMPTY_STATION_CONFIG, warning: describeFailure(result.failure) }
  return { config: result.config, warning: null }
}

/**
 * 設定ファイルを書く。**管理コンソール（`/api/*`）からの書き込みが呼ぶ**
 * （#313 段 B）。呼び出し側は事前に `parseStationConfig` を通した `StationConfig` を
 * 渡すこと ——ここでは検証をやり直さない（検証の単一情報源を `parseStationConfig` に
 * 保つため）。
 *
 * **一時ファイルへ書いてから改名する。** 書き込みの途中でプロセスが落ちても、
 * 改名（同期・原子的）が終わるまでは元のファイルが残る ——`rawStore.ts` の
 * 圧縮ファイル書き出しと同じ理由。
 *
 * **例外を投げる。** `loadStationConfig` と違い、こちらの失敗は運用者の書き間違いではなく
 * ディスクの都合（権限・空き容量）なので、黙って諦めると「保存したはずなのに次の起動で
 * 消えている」という一番気づきにくい壊れ方をする。呼び出し側（`/api/*` のハンドラ）が
 * 捕まえて 500 へ変える。
 */
export function saveStationConfig(path: string, config: StationConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(config, null, 2))
  renameSync(temp, path)
}

/** `boardKey`・`(boardKey, sensorId)` から観測点・校正値を引く。 */
export class StationDirectory {
  private readonly boardToStation = new Map<BoardKey, StationInfo>()
  private readonly sensorCalibration = new Map<string, SensorCalibration>()

  /**
   * **重複した `boardKey`・`stationId`・`sensorId` を弾く責務は `parseStationConfig` が
   * 持つ。** ここは渡された `StationConfig` をそのまま信頼するので、重複が紛れ込んだ
   * `config` を渡すと `Map.set` が黙って後勝ちで上書きする。`parseStationConfig` を
   * 経由しない生成経路（複数設定のマージ等）を足すときは、その経路にも重複検出を
   * 持たせること。
   */
  constructor(config: StationConfig) {
    const stationsById = new Map(config.stations.map((s) => [s.stationId, s]))
    for (const board of config.boards) {
      const station = stationsById.get(board.stationId)
      // **ここには来ないはず。** `parseStationConfig` が参照整合性（`unknown-station-id`）
      // を検査済みなので、素通りしてきた `config` はこの対応が必ず取れる。取れない
      // 場合は握りつぶさず、`board` を丸ごと未割当にする（黙って別の観測点へ繋がない）——
      // ただし**沈黙はさせない**。`parseStationConfig` を経由しない生成経路（複数設定の
      // マージ等）が今後増えたとき、この一言が無いと「観測点を設定していない」のと
      // 「参照整合性が壊れている」を運用者が一生見分けられなくなる。
      if (station === undefined) {
        console.warn(
          `[station] ${board.boardKey} が指す観測点 ${board.stationId} が見当たらない（設定の生成経路を疑うこと）`,
        )
        continue
      }
      this.boardToStation.set(board.boardKey, station)
      for (const sensor of board.sensors) {
        // **`sensorId` を持たせない。** `SensorEntry` は識別のためだけに `sensorId` を
        // 足した型で、地図の鍵（`sensorKeyOf`）に既に畳み込んである。そのまま格納すると
        // `resolveSensor` が返す値に `sensorId` が紛れ込み、`SensorCalibration` の形と
        // 食い違う（呼び出し側は校正値だけを欲しがっている）。
        const { sensorId: _sensorId, ...calibration } = sensor
        this.sensorCalibration.set(sensorKeyOf(board.boardKey, sensor.sensorId), calibration)
      }
    }
  }

  /** 設定を持たない（空の）帳面。基板は全て未割当、センサーは全て既定の校正値。 */
  static empty(): StationDirectory {
    return new StationDirectory(EMPTY_STATION_CONFIG)
  }

  /** 基板がどの観測点に置かれているか。設定に無ければ `null`（未割当）。 */
  resolve(boardKey: BoardKey): StationInfo | null {
    return this.boardToStation.get(boardKey) ?? null
  }

  /**
   * センサーの校正値。**設定に無くても `null` を返さない** —— 呼び出し側（§7・§16 の
   * 補正）が「設定なし」を毎回特別扱いしなくて済むよう、単位行列・補正なしの
   * `DEFAULT_SENSOR_CALIBRATION` を返す。
   */
  resolveSensor(boardKey: BoardKey, sensorId: string): SensorCalibration {
    return this.sensorCalibration.get(sensorKeyOf(boardKey, sensorId)) ?? DEFAULT_SENSOR_CALIBRATION
  }

  /**
   * そのセンサーに校正値の設定があるか。
   *
   * **`resolveSensor` の返り値だけでは見分けられない。** 既定値（単位行列・補正なし）も
   * 「有効な校正値」の形をしているので、設定に書いたつもりの `sensorId` を打ち間違えても、
   * `resolveSensor` は例外もエラーも返さず既定値を返し続ける。運用者がそれに気づく手立てを
   * 別に持たせるためにこれがある（`/status` の `SensorStatus.calibrationConfigured` の出どころ）。
   */
  hasSensorCalibration(boardKey: BoardKey, sensorId: string): boolean {
    return this.sensorCalibration.has(sensorKeyOf(boardKey, sensorId))
  }
}

/** 校正値の覚えの鍵。`sensorHealth.ts` の `keyOf` と同じ形。 */
function sensorKeyOf(boardKey: BoardKey, sensorId: string): string {
  return `${boardKey}|${sensorId}`
}

/**
 * 同一観測点に 2 台以上の基板を割り当てているか（`sensors[]` の中身は問わない）。
 *
 * **`sensorFusion.ts` の合成グループとは判定基準が違う。** あちらは各基板の `sensors[]` に
 * `sensorId` が明示列挙されたセンサーだけを数える——`sensors[]` を空のまま基板を割り当てても、
 * ここでは「複数台を割り当てた観測点」として数える。両者の食い違いは `main.ts` が起動時に
 * 突き合わせて警告する（README.md「複数センサーの波形合成（§7）」参照）。
 */
export function stationsWithMultipleBoards(config: StationConfig): readonly string[] {
  const counts = new Map<string, number>()
  for (const board of config.boards) {
    counts.set(board.stationId, (counts.get(board.stationId) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([stationId]) => stationId)
}
