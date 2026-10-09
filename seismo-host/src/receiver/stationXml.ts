// 観測点の設定（割り当てと校正値）とその履歴を、FDSN StationXML 1.2 の 1 本で持つ。
//
// **これが観測点の設定の正**（2026-10-05 ユーザー承認）。ホストは起動時にこれを読み、管理コンソールの
// 保存もこれへ記録を足して書き換える（`stationStore.ts`）。今の期間（終わりの無い epoch）が「いまの設定」、
// 閉じた期間が履歴。**生データ（miniSEED）と対になる標準の形**で、生データは基板とセンサーで名乗り、
// しかも補正前の値なので、後から読み直すには「その時刻にどの観測点にあって、どう補正していたか」が要る。
// 実機が動かしている設定と、評価台・外部の道具が読む設定が同じファイルになるので、食い違いようがない。
//
// ## 写し方
//
// - **Network `XX`・Station＝基板（MAC の下位 8 桁）・Location＝センサー ID・Channel＝`HN1`〜`HN3`。**
//   miniSEED の識別子（`mseed3Record.ts` の `mseed3SourceId`）と同じ組み方で、波形とそのまま引き当たる。
//   2 軸のセンサーは `HN1`・`HN2` の 2 本だけを持つ。名乗れない基板・センサーは設定の検証
//   （`stationConfig.ts`）が受け付けない。
// - **期間は設定が変わったところで区切る。** 観測点の情報（ID・表示名・座標）か基板の向きが変われば
//   基板の期間を、軸の校正値が変われば軸の期間を閉じて新しく開く。変わらなければ前の期間が続く。
//   基板の向きは全部の軸の地面での向きを動かすので、基板の期間ごと区切る。
// - **校正はホストの式（`calibration.ts`）と同じ変換になるように書く。**
//
//   ```
//   ホスト:  m_j − o_j = h_j · a_基板,  a_地面 = B × a_基板   ⇒   m_j = |w_j| × (ŵ_j · a_地面) + o_j
//   ```
//
//   `w_j = B⁻ᵀ h_j` は地面の座標で見た測る向き。StationXML の `Azimuth`・`Dip` は「そのチャンネルが
//   測っている向き」なので `ŵ_j` を入れ、応答（Response）を 2 段に分ける —— 段 1 の倍率 `|w_j|`、
//   段 2 の多項式でゼロ点 `o_j` を足す。総合の多項式（`InstrumentPolynomial`）は 2 段をまとめたもので、
//   標準の道具が読む要約。
// - **ホストが使う値そのもの（基板の座標の `h_j` と、基板の向き `B`）を拡張に持つ。** 方位・傾き・倍率は
//   三角関数と逆行列を通すので、そこから組み直すと元の値に戻らない。**読み手（ホスト自身を含む）は
//   拡張の値を使い**、標準の欄はそこから計算し直したものと一致するかを確かめる —— 食い違う履歴は、
//   どちらが正しいか決められないので読めないとして退ける。
// - **記録ごとに、観測点・基板・センサーの並びを拡張に持つ。** 観測点の合成はセンサーの並びで基準を
//   決める（並びが変わると合成の時間軸が動く）ので、並びも設定の一部。期間の形は並びを持てない。
//   基板を割り当てていない観測点も、ここにしか置き場所が無い（Station＝基板なので）。
// - **入力と出力の単位は gal（cm/s²）。** 生のカウントから gal への換算は、受信の記録（`receptionLog.ts`
//   の `ugPerLsb`）が持つ。この応答はその後ろ —— 校正前の gal から地面の加速度まで —— を表す。
// - **標高と深さは設定に無いので 0 を書く**（どちらも StationXML の必須の欄）。読み手は使わない。
// - **StationXML に置き場所の無いものは拡張の要素で持つ**（名前空間 `SEISMO_NS`）。基板の正式な鍵
//   （Station の 8 桁からは戻せない）・観測点の ID・センサー ID（大文字小文字まで）・有効かどうか・
//   ノイズ密度・上の元の値と並び、それから起動と設定の変更の記録（いつ・どの契機で）。
//
// ## 前の形（2026-10-09 まで）を読む
//
// 前の形はセンサーごとに `a = R × diag(s) × (m − o)` で持ち、チャンネルの拡張に `R` の第 j 列
// （`seismo:Rotation`）と `s_j`（`seismo:Sensitivity`）を、応答に 3 段（`|d_j|`・`1/s_j`・ゼロ点）を
// 書いていた。**読むときに今の形へ写す**（`legacyAxes`。基板の向きは単位行列）。期間の区切りは
// そのまま —— 写した値から作った設定を同じ履歴へ当て直しても、同じ値が出るので期間は続く。
// 書き戻すときは今の形で書くので、`R` と `s` への分け方は残らない（同じ変換の書き方が変わるだけで、
// どちらの形でも各チャンネルが何を測っているかは同じ）。
//
// **Node 専用のコードを持たない**（ファイルの読み書きは `stationStore.ts`）。

import type { BoardKey } from '../protocol/types'
import { legacyAxes } from './calibration'
import { invert3, isInvertibleRotation, multiplyMatVec3, transpose3 } from './matrix3'
import { mseed3LocationCode, mseed3StationCode } from './mseed3Record'
import type { BoardEntry, Mat3, SensorEntry, StationConfig, StationInfo, Vec3 } from './stationConfigTypes'
import { EMPTY_STATION_CONFIG, IDENTITY_MATRIX } from './stationConfigTypes'
import { childOf, childrenOf, escapeXml, parseXml, type XmlElement } from './xmlLite'

export const STATION_XML_NS = 'http://www.fdsn.org/xml/station/1'
/** 拡張の要素の名前空間。**どこにも登録していない、このホストだけの名前。** */
export const SEISMO_NS = 'urn:realtime-earthquake-viewer:seismo-host'

const NETWORK = 'XX'
/** 倍率を書く周波数。**加速度計の応答は平坦**なので、どこで書いても同じ値になる。 */
const GAIN_FREQUENCY_HZ = 1

/** どの契機で書いたか。 */
export type StationHistoryReason =
  /** 起動して設定を読んだ。 */
  | 'startup'
  /** 管理コンソールから設定を変えて保存した。 */
  | 'changed'

/**
 * 軸 1 本の期間。**数は書き出す値そのもので持つ** —— 設定から計算し直した値と比べて
 * 期間を続けるか決めるので、読み戻した値と計算し直した値が一致しなければ、起動のたびに
 * 期間が切れる。書き出しは `String(n)`（最短で元の値へ戻る表記）なので、持つ値どうしなら一致する。
 */
export interface ChannelEpoch {
  readonly sensorId: string
  readonly axis: 0 | 1 | 2
  readonly startMs: number
  readonly endMs: number | null
  /** ホストが使う `h_axis`（基板の座標で測る向き。長さが倍率）。**読み手はこちらを使う。** */
  readonly vector: Vec3
  /** ゼロ点 `o_axis`（gal）。 */
  readonly offset: number
  /** 測っている向き（度）。北から時計回り。`vector` と基板の向きから計算したもの。 */
  readonly azimuth: number
  /** 測っている向き（度）。水平から下向きが正。`vector` と基板の向きから計算したもの。 */
  readonly dip: number
  /** 段 1 の倍率 `|w_axis|`。 */
  readonly gain: number
  readonly enabled: boolean
  readonly noiseDensity: number | null
}

/** 基板 1 枚の期間（StationXML の Station 1 つ）。 */
export interface BoardEpoch {
  readonly boardKey: BoardKey
  readonly startMs: number
  readonly endMs: number | null
  readonly station: StationInfo
  /** 基板の向き `B`（`a_地面 = B × a_基板`）。 */
  readonly orientation: Mat3
  readonly channels: readonly ChannelEpoch[]
}

/** 記録の中の基板 1 枚と、そのセンサーの並び。 */
export interface RevisionBoard {
  readonly boardKey: BoardKey
  readonly sensorIds: readonly string[]
}

/** 起動と設定の変更の記録。**その時点の設定の顔ぶれと並び**を持つ。 */
export interface HistoryRevision {
  /** 実際の時刻。 */
  readonly atMs: number
  /**
   * 期間の区切りに使った時刻。ふつうは `atMs` と同じで、時計が戻ったときだけ前の記録の時刻へ寄せる
   * （終わりが始まりより前の期間を作らないため）。**記録はこの順に並ぶ。**
   */
  readonly effectiveMs: number
  readonly reason: StationHistoryReason
  /** 観測点（基板を割り当てていないものも含む）。設定の並びのまま。 */
  readonly stations: readonly StationInfo[]
  /** 基板とセンサーの並び。 */
  readonly boards: readonly RevisionBoard[]
}

export interface StationHistoryDoc {
  readonly boards: readonly BoardEpoch[]
  readonly revisions: readonly HistoryRevision[]
}

export const EMPTY_STATION_HISTORY: StationHistoryDoc = { boards: [], revisions: [] }

export class StationXmlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StationXmlError'
  }
}

// ---------------------------------------------------------------------------
// 校正値と軸の値の行き来

type ChannelValues = Omit<ChannelEpoch, 'startMs' | 'endMs'>

function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI
}

/** ENU の向き（長さ 1）から方位と傾き。 */
function directionOf(e: number, n: number, u: number): { azimuth: number; dip: number } {
  const az = toDegrees(Math.atan2(e, n))
  const azimuth = az < 0 ? az + 360 : az === 360 ? 0 : az
  const dip = -toDegrees(Math.asin(Math.max(-1, Math.min(1, u))))
  // -0 を書くと `-0` と表記されうるので 0 へ寄せる。
  return { azimuth: azimuth === 0 ? 0 : azimuth, dip: dip === 0 ? 0 : dip }
}

/** 基板の座標の向きを地面の座標へ（`B⁻ᵀ`）。**基板の向きが逆行列を持たなければ投げる。** */
function groundTransform(orientation: Mat3): Mat3 {
  const inv = invert3(orientation)
  if (inv === null) throw new StationXmlError('基板の向きが逆行列を持たない')
  return transpose3(inv)
}

/** 軸 1 本の値（標準の欄を含む）。 */
function channelValueOf(
  sensor: Pick<SensorEntry, 'sensorId' | 'enabled' | 'noiseDensity'>,
  axis: 0 | 1 | 2,
  vector: Vec3,
  offset: number,
  toGround: Mat3,
): ChannelValues {
  // **-0 を 0 へ寄せる。** 真上を向く軸は東・北の成分が 0 で、`atan2` は符号付きの 0 で 0° と 180° に
  // 割れる。逆行列の計算は -0 を作るので、寄せないと同じ設定から計算し直した方位が食い違う。
  const w = multiplyMatVec3(toGround, vector).map((x) => x + 0) as unknown as Vec3
  const gain = Math.hypot(w[0], w[1], w[2])
  if (!Number.isFinite(gain) || gain === 0) {
    throw new StationXmlError(`センサー ${sensor.sensorId} の軸 ${axis + 1} の測る向きの長さが 0`)
  }
  const { azimuth, dip } = directionOf(w[0] / gain, w[1] / gain, w[2] / gain)
  return {
    sensorId: sensor.sensorId,
    axis,
    vector,
    offset,
    azimuth,
    dip,
    gain,
    enabled: sensor.enabled,
    noiseDensity: sensor.noiseDensity,
  }
}

/** センサー 1 個の校正値を、軸の値へ。 */
function channelValuesOf(sensor: SensorEntry, orientation: Mat3): ChannelValues[] {
  if (sensor.axes.length !== 2 && sensor.axes.length !== 3) {
    throw new StationXmlError(`センサー ${sensor.sensorId} の軸が ${sensor.axes.length} 本ある（2 か 3）`)
  }
  const toGround = groundTransform(orientation)
  return sensor.axes.map((a, i) => channelValueOf(sensor, i as 0 | 1 | 2, a.vector, a.offset, toGround))
}

function sameVec3(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

function sameMat3(a: Mat3, b: Mat3): boolean {
  return sameVec3(a[0], b[0]) && sameVec3(a[1], b[1]) && sameVec3(a[2], b[2])
}

function sameChannelValues(a: ChannelValues, b: ChannelValues): boolean {
  return (
    a.sensorId === b.sensorId &&
    a.axis === b.axis &&
    sameVec3(a.vector, b.vector) &&
    a.offset === b.offset &&
    a.azimuth === b.azimuth &&
    a.dip === b.dip &&
    a.gain === b.gain &&
    a.enabled === b.enabled &&
    a.noiseDensity === b.noiseDensity
  )
}

/**
 * 軸の値から、センサー 1 個の校正値へ戻す。**元の値（拡張）から組み、標準の欄がそこから
 * 計算し直したものと一致しなければ投げる。** 軸は `HN1` から隙間なく 2 本か 3 本。
 */
function sensorOf(sensorId: string, channels: readonly ChannelEpoch[], orientation: Mat3): SensorEntry {
  const count = channels.length
  if (count !== 2 && count !== 3) {
    throw new StationXmlError(`センサー ${sensorId} の軸が ${count} 本ある（2 か 3）`)
  }
  const byAxis = Array.from({ length: count }, (_, axis) => {
    const found = channels.filter((c) => c.axis === axis)
    if (found.length !== 1) {
      throw new StationXmlError(`センサー ${sensorId} の軸 ${axis + 1} が ${found.length} 本ある`)
    }
    return found[0] as ChannelEpoch
  })
  const first = byAxis[0]!
  for (const c of byAxis) {
    if (c.enabled !== first.enabled || c.noiseDensity !== first.noiseDensity) {
      throw new StationXmlError(`センサー ${sensorId} の軸どうしで有効かどうか・ノイズ密度が食い違う`)
    }
  }
  const sensor: SensorEntry = {
    sensorId,
    enabled: first.enabled,
    axes: byAxis.map((c) => ({ vector: c.vector, offset: c.offset })),
    noiseDensity: first.noiseDensity,
  }
  const recomputed = channelValuesOf(sensor, orientation)
  for (const c of byAxis) {
    if (!sameChannelValues(c, recomputed[c.axis] as ChannelValues)) {
      throw new StationXmlError(`センサー ${sensorId} の軸 ${c.axis + 1} の向き・応答が、元の値から計算したものと食い違う`)
    }
  }
  return sensor
}

function sameStation(a: StationInfo, b: StationInfo): boolean {
  return a.stationId === b.stationId && a.displayName === b.displayName && a.lat === b.lat && a.lon === b.lon
}

// ---------------------------------------------------------------------------
// 設定の変更を期間へ反映する

/**
 * 設定を `atMs` の時点の状態として履歴へ足す。**元の履歴は書き換えず、新しい履歴を返す。**
 *
 * 時刻がいちばん新しい記録・期間の始まりより前なら（時計が戻った）、そこへ寄せる ——
 * 終わりが始まりより前の期間を作らないため。記録には実際の時刻（`atMs`）も残す。
 * **名乗れない基板・センサー、逆行列を持たない基板の向き、設定に無い観測点は投げる**（どれも
 * 設定の検証を通っていれば起きない）。
 */
export function applyStationConfig(
  doc: StationHistoryDoc,
  config: StationConfig,
  atMs: number,
  reason: StationHistoryReason,
): StationHistoryDoc {
  let latest = Number.NEGATIVE_INFINITY
  for (const r of doc.revisions) latest = Math.max(latest, r.effectiveMs)
  for (const b of doc.boards) {
    if (b.endMs !== null) continue
    latest = Math.max(latest, b.startMs)
    for (const c of b.channels) if (c.endMs === null) latest = Math.max(latest, c.startMs)
  }
  const t = Math.max(atMs, latest)
  const stations = new Map(config.stations.map((s) => [s.stationId, s]))

  // 新しい設定で、基板ごとに書く値を組む。
  const wanted = new Map<string, { station: StationInfo; orientation: Mat3; channels: ChannelValues[] }>()
  for (const board of config.boards) {
    if (mseed3StationCode(board.boardKey) === null) {
      throw new StationXmlError(`基板 ${board.boardKey} は名乗れない（MAC を持たない）`)
    }
    // 設定の検証（`unknown-station-id`）を通っていれば必ずある。
    const station = stations.get(board.stationId)
    if (station === undefined) {
      throw new StationXmlError(`基板 ${board.boardKey} の観測点 ${board.stationId} が設定に無い`)
    }
    const channels: ChannelValues[] = []
    for (const sensor of board.sensors) {
      if (mseed3LocationCode(sensor.sensorId) === null) {
        throw new StationXmlError(`基板 ${board.boardKey} のセンサー ${sensor.sensorId} は名乗れない`)
      }
      channels.push(...channelValuesOf(sensor, board.orientation))
    }
    wanted.set(board.boardKey, { station, orientation: board.orientation, channels })
  }

  const boards: BoardEpoch[] = []
  const continued = new Set<string>()
  for (const epoch of doc.boards) {
    if (epoch.endMs !== null) {
      boards.push(epoch)
      continue
    }
    const next = wanted.get(epoch.boardKey)
    if (next === undefined || !sameStation(epoch.station, next.station) || !sameMat3(epoch.orientation, next.orientation)) {
      // 外された・観測点の情報か基板の向きが変わった —— 基板の期間ごと閉じる。
      boards.push(closeBoard(epoch, t))
      continue
    }
    // 観測点と基板の向きはそのまま。軸ごとに続けるか閉じるかを決める。
    const channels: ChannelEpoch[] = []
    const kept = new Set<number>()
    for (const ch of epoch.channels) {
      if (ch.endMs !== null) {
        channels.push(ch)
        continue
      }
      const index = next.channels.findIndex((w, i) => !kept.has(i) && sameChannelValues(w, ch))
      if (index === -1) {
        channels.push({ ...ch, endMs: t })
      } else {
        kept.add(index)
        channels.push(ch)
      }
    }
    next.channels.forEach((w, i) => {
      if (!kept.has(i)) channels.push({ ...w, startMs: t, endMs: null })
    })
    boards.push({ ...epoch, channels })
    continued.add(epoch.boardKey)
  }
  for (const [boardKey, next] of wanted) {
    if (continued.has(boardKey)) continue
    boards.push({
      boardKey: boardKey as BoardKey,
      startMs: t,
      endMs: null,
      station: next.station,
      orientation: next.orientation,
      channels: next.channels.map((w) => ({ ...w, startMs: t, endMs: null })),
    })
  }

  const revision: HistoryRevision = {
    atMs,
    effectiveMs: t,
    reason,
    stations: config.stations.map((s) => ({ ...s })),
    boards: config.boards.map((b) => ({ boardKey: b.boardKey, sensorIds: b.sensors.map((s) => s.sensorId) })),
  }
  return { boards, revisions: [...doc.revisions, revision] }
}

function closeBoard(epoch: BoardEpoch, t: number): BoardEpoch {
  return {
    ...epoch,
    endMs: t,
    channels: epoch.channels.map((c) => (c.endMs === null ? { ...c, endMs: t } : c)),
  }
}

// ---------------------------------------------------------------------------
// ある時刻の設定を取り出す

function activeAt(start: number, end: number | null, t: number): boolean {
  return start <= t && (end === null || t < end)
}

/** その時刻に効いていた記録（区切りの時刻が `atMs` 以前で、いちばん後のもの）。無ければ `null`。 */
function revisionAt(doc: StationHistoryDoc, atMs: number): HistoryRevision | null {
  let found: HistoryRevision | null = null
  for (const r of doc.revisions) if (r.effectiveMs <= atMs) found = r
  return found
}

/**
 * その時刻に効いていた設定。**観測点・基板・センサーの並びは、その時点の記録のとおり**（合成の基準が
 * 並びで決まるため）。校正値は期間の拡張に持つ元の値。記録と期間が食い違えば投げる。
 * 最初の記録より前の時刻なら空の設定。
 */
export function configAt(doc: StationHistoryDoc, atMs: number): StationConfig {
  const revision = revisionAt(doc, atMs)
  const activeBoards = doc.boards.filter((b) => activeAt(b.startMs, b.endMs, atMs))
  if (revision === null) {
    if (activeBoards.length > 0) throw new StationXmlError('記録より前の時刻に効いている期間がある')
    return EMPTY_STATION_CONFIG
  }
  const stationsById = new Map(revision.stations.map((s) => [s.stationId, s]))
  const where = `記録 ${new Date(revision.atMs).toISOString()}`
  const boards: BoardEntry[] = []
  for (const listed of revision.boards) {
    const found = activeBoards.filter((b) => b.boardKey === listed.boardKey)
    if (found.length !== 1) throw new StationXmlError(`${where} の基板 ${listed.boardKey} に効いている期間が ${found.length} 本ある`)
    const epoch = found[0] as BoardEpoch
    const station = stationsById.get(epoch.station.stationId)
    if (station === undefined || !sameStation(station, epoch.station)) {
      throw new StationXmlError(`${where} の基板 ${listed.boardKey} の観測点が、記録の観測点と食い違う`)
    }
    const activeChannels = epoch.channels.filter((c) => activeAt(c.startMs, c.endMs, atMs))
    const sensors = listed.sensorIds.map((sensorId) =>
      sensorOf(
        sensorId,
        activeChannels.filter((c) => c.sensorId === sensorId),
        epoch.orientation,
      ),
    )
    const stray = activeChannels.find((c) => !listed.sensorIds.includes(c.sensorId))
    if (stray !== undefined) throw new StationXmlError(`${where} に載っていないセンサー ${stray.sensorId} の期間が効いている`)
    boards.push({ boardKey: epoch.boardKey, stationId: station.stationId, orientation: epoch.orientation, sensors })
  }
  const strayBoard = activeBoards.find((b) => !revision.boards.some((x) => x.boardKey === b.boardKey))
  if (strayBoard !== undefined) throw new StationXmlError(`${where} に載っていない基板 ${strayBoard.boardKey} の期間が効いている`)
  return { stations: revision.stations, boards }
}

/** いまの設定（いちばん新しい記録の時点）。履歴が空なら空の設定。 */
export function currentConfig(doc: StationHistoryDoc): StationConfig {
  const last = doc.revisions.at(-1)
  return last === undefined ? EMPTY_STATION_CONFIG : configAt(doc, last.effectiveMs)
}

// ---------------------------------------------------------------------------
// 書き出し

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function num(n: number): string {
  if (!Number.isFinite(n)) throw new StationXmlError(`数として書けない値: ${n}`)
  return String(n)
}

function dateAttrs(start: number, end: number | null): string {
  return ` startDate="${iso(start)}"${end === null ? '' : ` endDate="${iso(end)}"`}`
}

function enuAttrs(v: Vec3): string {
  return `e="${num(v[0])}" n="${num(v[1])}" u="${num(v[2])}"`
}

function writeChannel(lines: string[], ch: ChannelEpoch, station: StationInfo): void {
  const loc = mseed3LocationCode(ch.sensorId) as string
  const p = '      '
  lines.push(`${p}<Channel code="HN${ch.axis + 1}" locationCode="${escapeXml(loc)}"${dateAttrs(ch.startMs, ch.endMs)}>`)
  lines.push(`${p}  <seismo:Sensor>${escapeXml(ch.sensorId)}</seismo:Sensor>`)
  lines.push(`${p}  <seismo:Enabled>${ch.enabled}</seismo:Enabled>`)
  if (ch.noiseDensity !== null) {
    lines.push(`${p}  <seismo:NoiseDensity unit="ug/sqrt(Hz)">${num(ch.noiseDensity)}</seismo:NoiseDensity>`)
  }
  // ホストが使う値そのもの（基板の座標）。読み手はこちらを使い、下の標準の欄はここから計算したもの。
  lines.push(`${p}  <seismo:Vector x="${num(ch.vector[0])}" y="${num(ch.vector[1])}" z="${num(ch.vector[2])}"/>`)
  lines.push(`${p}  <Latitude>${num(station.lat)}</Latitude>`)
  lines.push(`${p}  <Longitude>${num(station.lon)}</Longitude>`)
  lines.push(`${p}  <Elevation>0</Elevation>`)
  lines.push(`${p}  <Depth>0</Depth>`)
  lines.push(`${p}  <Azimuth>${num(ch.azimuth)}</Azimuth>`)
  lines.push(`${p}  <Dip>${num(ch.dip)}</Dip>`)
  lines.push(`${p}  <Type>CONTINUOUS</Type>`)
  lines.push(`${p}  <Response>`)
  // 2 段をまとめた要約: (ŵ·a) = (m − o) / |w|。
  lines.push(`${p}    <InstrumentPolynomial>`)
  lines.push(`${p}      <InputUnits><Name>cm/s**2</Name><Description>ground acceleration along the channel direction</Description></InputUnits>`)
  lines.push(`${p}      <OutputUnits><Name>cm/s**2</Name><Description>sensor acceleration before calibration</Description></OutputUnits>`)
  writePolynomialBody(lines, `${p}      `, -ch.offset / ch.gain, 1 / ch.gain)
  lines.push(`${p}    </InstrumentPolynomial>`)
  lines.push(`${p}    <Stage number="1"><StageGain><Value>${num(ch.gain)}</Value><Frequency>${GAIN_FREQUENCY_HZ}</Frequency></StageGain></Stage>`)
  lines.push(`${p}    <Stage number="2">`)
  lines.push(`${p}      <Polynomial>`)
  lines.push(`${p}        <InputUnits><Name>cm/s**2</Name></InputUnits>`)
  lines.push(`${p}        <OutputUnits><Name>cm/s**2</Name></OutputUnits>`)
  // 多項式は「出力から入力を求める」向き（SEED の多項式応答の約束）: 入力 = 出力 − o。
  writePolynomialBody(lines, `${p}        `, -ch.offset, 1)
  lines.push(`${p}      </Polynomial>`)
  lines.push(`${p}    </Stage>`)
  lines.push(`${p}  </Response>`)
  lines.push(`${p}</Channel>`)
}

/**
 * 多項式の欄。**周波数・値の範囲は限らない**（ゼロ点と倍率だけで、周波数にも値の大きさにも
 * 依らない）ので、範囲の欄は 0 で埋める。標準の道具は係数だけを使う。
 */
function writePolynomialBody(lines: string[], p: string, c0: number, c1: number): void {
  lines.push(`${p}<ApproximationType>MACLAURIN</ApproximationType>`)
  lines.push(`${p}<FrequencyLowerBound>0</FrequencyLowerBound>`)
  lines.push(`${p}<FrequencyUpperBound>0</FrequencyUpperBound>`)
  lines.push(`${p}<ApproximationLowerBound>0</ApproximationLowerBound>`)
  lines.push(`${p}<ApproximationUpperBound>0</ApproximationUpperBound>`)
  lines.push(`${p}<MaximumError>0</MaximumError>`)
  lines.push(`${p}<Coefficient number="0">${num(c0)}</Coefficient>`)
  lines.push(`${p}<Coefficient number="1">${num(c1)}</Coefficient>`)
}

function writeRevision(lines: string[], r: HistoryRevision): void {
  const effective = r.effectiveMs === r.atMs ? '' : ` effective="${iso(r.effectiveMs)}"`
  const attrs = `at="${iso(r.atMs)}"${effective} reason="${r.reason}"`
  if (r.stations.length === 0 && r.boards.length === 0) {
    lines.push(`  <seismo:Revision ${attrs}/>`)
    return
  }
  lines.push(`  <seismo:Revision ${attrs}>`)
  for (const s of r.stations) {
    lines.push(
      `    <seismo:Station id="${escapeXml(s.stationId)}" lat="${num(s.lat)}" lon="${num(s.lon)}">${escapeXml(s.displayName)}</seismo:Station>`,
    )
  }
  for (const b of r.boards) {
    if (b.sensorIds.length === 0) {
      lines.push(`    <seismo:Board key="${escapeXml(b.boardKey)}"/>`)
      continue
    }
    lines.push(`    <seismo:Board key="${escapeXml(b.boardKey)}">`)
    for (const id of b.sensorIds) lines.push(`      <seismo:Sensor id="${escapeXml(id)}"/>`)
    lines.push('    </seismo:Board>')
  }
  lines.push('  </seismo:Revision>')
}

/** 履歴を StationXML の文字列へ。`createdMs` は `Created` の欄（書いた時刻）。 */
export function writeStationXml(doc: StationHistoryDoc, createdMs: number): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(`<FDSNStationXML xmlns="${STATION_XML_NS}" xmlns:seismo="${SEISMO_NS}" schemaVersion="1.2">`)
  lines.push('  <Source>seismo-host</Source>')
  lines.push(`  <Created>${iso(createdMs)}</Created>`)
  lines.push(`  <Network code="${NETWORK}">`)
  // 並びは記録が持つので、ここは読みやすさのために鍵と時刻の順で書く。
  const boards = [...doc.boards].sort((a, b) => (a.boardKey < b.boardKey ? -1 : a.boardKey > b.boardKey ? 1 : a.startMs - b.startMs))
  for (const epoch of boards) {
    const code = mseed3StationCode(epoch.boardKey) as string
    const o = epoch.orientation
    lines.push(`    <Station code="${code}"${dateAttrs(epoch.startMs, epoch.endMs)}>`)
    lines.push(`      <seismo:Board>${escapeXml(epoch.boardKey)}</seismo:Board>`)
    lines.push(`      <seismo:StationId>${escapeXml(epoch.station.stationId)}</seismo:StationId>`)
    // 基板の X・Y・Z 軸がそれぞれ東・北・上のどこを向くか（`B` の列）。
    lines.push('      <seismo:Orientation>')
    lines.push(`        <seismo:X ${enuAttrs([o[0][0], o[1][0], o[2][0]])}/>`)
    lines.push(`        <seismo:Y ${enuAttrs([o[0][1], o[1][1], o[2][1]])}/>`)
    lines.push(`        <seismo:Z ${enuAttrs([o[0][2], o[1][2], o[2][2]])}/>`)
    lines.push('      </seismo:Orientation>')
    lines.push(`      <Latitude>${num(epoch.station.lat)}</Latitude>`)
    lines.push(`      <Longitude>${num(epoch.station.lon)}</Longitude>`)
    lines.push('      <Elevation>0</Elevation>')
    lines.push(`      <Site><Name>${escapeXml(epoch.station.displayName)}</Name></Site>`)
    const channels = [...epoch.channels].sort((a, b) =>
      a.sensorId < b.sensorId ? -1 : a.sensorId > b.sensorId ? 1 : a.axis - b.axis || a.startMs - b.startMs,
    )
    for (const ch of channels) writeChannel(lines, ch, epoch.station)
    lines.push('    </Station>')
  }
  lines.push('  </Network>')
  for (const r of doc.revisions) writeRevision(lines, r)
  lines.push('</FDSNStationXML>')
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// 読み戻し

function need(el: XmlElement, ns: string, local: string, where: string): XmlElement {
  const c = childOf(el, ns, local)
  if (c === null) throw new StationXmlError(`${where} に ${local} が無い`)
  return c
}

function numberText(text: string | undefined, what: string, where: string): number {
  const trimmed = (text ?? '').trim()
  const n = Number(trimmed)
  if (trimmed === '' || !Number.isFinite(n)) throw new StationXmlError(`${where} の ${what} が数でない: ${trimmed}`)
  return n
}

function numberOf(el: XmlElement, where: string): number {
  return numberText(el.text, el.local, where)
}

function msOf(text: string | undefined, where: string): number {
  const ms = text === undefined ? Number.NaN : Date.parse(text)
  if (!Number.isFinite(ms)) throw new StationXmlError(`${where} の日時が読めない: ${text}`)
  return ms
}

function epochOf(el: XmlElement, where: string): { startMs: number; endMs: number | null } {
  const end = el.attrs.get('endDate')
  return { startMs: msOf(el.attrs.get('startDate'), where), endMs: end === undefined ? null : msOf(end, where) }
}

function boardKeyOf(text: string, where: string): BoardKey {
  if (!text.startsWith('mac:') || mseed3StationCode(text) === null) throw new StationXmlError(`${where} の基板の鍵が読めない: ${text}`)
  return text as BoardKey
}

function attrVec3(el: XmlElement, names: readonly [string, string, string], what: string, where: string): Vec3 {
  return [
    numberText(el.attrs.get(names[0]), `${what} の ${names[0]}`, where),
    numberText(el.attrs.get(names[1]), `${what} の ${names[1]}`, where),
    numberText(el.attrs.get(names[2]), `${what} の ${names[2]}`, where),
  ]
}

/** 基板の向き。**無ければ単位行列**（前の形は基板の向きを持たなかった）。 */
function readOrientation(st: XmlElement, where: string): Mat3 | null {
  const el = childOf(st, SEISMO_NS, 'Orientation')
  if (el === null) return null
  // **欠けたときの文にも「Orientation の」を入れる。** `where` だけだと、チャンネルの欄が欠けたのと見分けが付かない。
  const col = (local: string): Vec3 =>
    attrVec3(need(el, SEISMO_NS, local, `${where} の Orientation`), ['e', 'n', 'u'], `Orientation の ${local}`, where)
  const x = col('X')
  const y = col('Y')
  const z = col('Z')
  return [
    [x[0], y[0], z[0]],
    [x[1], y[1], z[1]],
    [x[2], y[2], z[2]],
  ]
}

/** チャンネルの共通の欄。 */
interface ChannelHead {
  readonly sensorId: string
  readonly axis: 0 | 1 | 2
  readonly startMs: number
  readonly endMs: number | null
  readonly enabled: boolean
  readonly noiseDensity: number | null
  readonly azimuth: number
  readonly dip: number
}

function readChannelHead(el: XmlElement, where: string): { head: ChannelHead; here: string } {
  const code = el.attrs.get('code') ?? ''
  const axis = { HN1: 0, HN2: 1, HN3: 2 }[code] as 0 | 1 | 2 | undefined
  if (axis === undefined) throw new StationXmlError(`${where} のチャンネル ${code} は扱わない`)
  const here = `${where} ${code}`
  const sensorId = need(el, SEISMO_NS, 'Sensor', here).text.trim()
  if (mseed3LocationCode(sensorId) !== (el.attrs.get('locationCode') ?? '')) {
    throw new StationXmlError(`${here} のセンサー ID ${sensorId} がロケーションコードと合わない`)
  }
  const enabledText = need(el, SEISMO_NS, 'Enabled', here).text.trim()
  if (enabledText !== 'true' && enabledText !== 'false') throw new StationXmlError(`${here} の Enabled が読めない`)
  const nd = childOf(el, SEISMO_NS, 'NoiseDensity')
  return {
    head: {
      sensorId,
      axis,
      ...epochOf(el, here),
      enabled: enabledText === 'true',
      noiseDensity: nd === null ? null : numberOf(nd, here),
      azimuth: numberOf(need(el, STATION_XML_NS, 'Azimuth', here), here),
      dip: numberOf(need(el, STATION_XML_NS, 'Dip', here), here),
    },
    here,
  }
}

function stagesOf(el: XmlElement, here: string): (n: string) => XmlElement {
  const response = need(el, STATION_XML_NS, 'Response', here)
  const stages = childrenOf(response, STATION_XML_NS, 'Stage')
  return (n: string): XmlElement => {
    const s = stages.find((x) => x.attrs.get('number') === n)
    if (s === undefined) throw new StationXmlError(`${here} に段 ${n} が無い`)
    return s
  }
}

function gainOfStage(stage: XmlElement, here: string): number {
  return numberOf(need(need(stage, STATION_XML_NS, 'StageGain', here), STATION_XML_NS, 'Value', here), here)
}

/** 多項式の段からゼロ点を読む（1 次の係数は 1 でなければならない）。 */
function offsetOfPolynomialStage(stage: XmlElement, n: string, here: string): number {
  const poly = need(stage, STATION_XML_NS, 'Polynomial', here)
  const coefficient = (k: string): number => {
    const c = childrenOf(poly, STATION_XML_NS, 'Coefficient').find((x) => x.attrs.get('number') === k)
    if (c === undefined) throw new StationXmlError(`${here} の段 ${n} に係数 ${k} が無い`)
    return numberOf(c, here)
  }
  if (coefficient('1') !== 1) throw new StationXmlError(`${here} の段 ${n} の 1 次の係数が 1 でない`)
  return -coefficient('0')
}

/** 今の形のチャンネル。 */
function readChannel(el: XmlElement, head: ChannelHead, here: string): ChannelEpoch {
  const stage = stagesOf(el, here)
  return {
    ...head,
    vector: attrVec3(need(el, SEISMO_NS, 'Vector', here), ['x', 'y', 'z'], 'Vector', here),
    offset: offsetOfPolynomialStage(stage('2'), '2', here),
    gain: gainOfStage(stage('1'), here),
  }
}

/** 前の形のチャンネル（`R` の第 j 列と `s_j`、3 段の応答）。 */
interface LegacyChannel extends ChannelHead {
  readonly rotation: Vec3
  readonly sensitivity: number
  readonly directionGain: number
  readonly axisGain: number
  readonly offset: number
}

function readLegacyChannel(el: XmlElement, head: ChannelHead, here: string): LegacyChannel {
  const stage = stagesOf(el, here)
  return {
    ...head,
    rotation: attrVec3(need(el, SEISMO_NS, 'Rotation', here), ['e', 'n', 'u'], 'Rotation', here),
    sensitivity: numberOf(need(el, SEISMO_NS, 'Sensitivity', here), here),
    directionGain: gainOfStage(stage('1'), here),
    axisGain: gainOfStage(stage('2'), here),
    offset: offsetOfPolynomialStage(stage('3'), '3', here),
  }
}

/**
 * 前の形のチャンネルを今の形へ写す。**写す前に、前の形として正しいか（標準の欄が元の値から
 * 計算し直したものと一致するか）を前と同じ式で確かめる。**
 *
 * 軸 j の測る向き `h_j = (R⁻¹ の第 j 行) / s_j` は `R` の全部の列に依るので、そのチャンネルの期間の
 * 始まりで効いていた同じセンサーの 3 本から `R` を組む。前の形は `R` の列が 1 本でも変われば、
 * 測る向きの変わった軸の期間を区切っていた —— 期間の途中で `R` が変わっていても、この軸の向きは
 * 変わっていない。
 */
function convertLegacyChannels(boardKey: BoardKey, legacy: readonly LegacyChannel[]): ChannelEpoch[] {
  // 計算し直す側（`channelValuesOf`）と同じ経路で地面の向きへ（基板の向きは単位行列）。
  const toGround = groundTransform(IDENTITY_MATRIX)
  return legacy.map((c) => {
    const where = `基板 ${boardKey} のセンサー ${c.sensorId} の軸 ${c.axis + 1}（前の形）`
    const siblings = [0, 1, 2].map((axis) => {
      const found = legacy.filter((x) => x.sensorId === c.sensorId && x.axis === axis && activeAt(x.startMs, x.endMs, c.startMs))
      if (found.length !== 1) throw new StationXmlError(`${where} の始まりで、軸 ${axis + 1} が ${found.length} 本効いている`)
      return found[0] as LegacyChannel
    })
    const rotation: Mat3 = [
      [siblings[0]!.rotation[0], siblings[1]!.rotation[0], siblings[2]!.rotation[0]],
      [siblings[0]!.rotation[1], siblings[1]!.rotation[1], siblings[2]!.rotation[1]],
      [siblings[0]!.rotation[2], siblings[1]!.rotation[2], siblings[2]!.rotation[2]],
    ]
    const inv = invert3(rotation)
    if (inv === null || !isInvertibleRotation(rotation)) throw new StationXmlError(`${where} の回転行列が逆行列を持たない`)
    // 前の形の標準の欄（前の `channelValuesOf` と同じ式）。
    const row = inv[c.axis]
    const length = Math.hypot(row[0], row[1], row[2])
    const { azimuth, dip } = directionOf(row[0] / length, row[1] / length, row[2] / length)
    if (
      c.azimuth !== azimuth ||
      c.dip !== dip ||
      c.directionGain !== length ||
      c.axisGain !== 1 / c.sensitivity ||
      siblings.some((s) => s.enabled !== c.enabled || s.noiseDensity !== c.noiseDensity)
    ) {
      throw new StationXmlError(`${where} の向き・応答が、元の値から計算したものと食い違う`)
    }
    const sensitivity: Vec3 = [siblings[0]!.sensitivity, siblings[1]!.sensitivity, siblings[2]!.sensitivity]
    const offsets: Vec3 = [siblings[0]!.offset, siblings[1]!.offset, siblings[2]!.offset]
    const axes = legacyAxes(rotation, sensitivity, offsets)
    if (axes === null) throw new StationXmlError(`${where} の回転行列が逆行列を持たない`)
    const values = channelValueOf(c, c.axis, axes[c.axis]!.vector, c.offset, toGround)
    return { ...values, startMs: c.startMs, endMs: c.endMs }
  })
}

function readRevision(r: XmlElement): HistoryRevision {
  const reason = r.attrs.get('reason')
  if (reason !== 'startup' && reason !== 'changed') throw new StationXmlError(`記録の契機が読めない: ${reason}`)
  const atMs = msOf(r.attrs.get('at'), 'Revision')
  const effective = r.attrs.get('effective')
  const where = `記録 ${r.attrs.get('at')}`
  const stations = childrenOf(r, SEISMO_NS, 'Station').map((s) => {
    const stationId = (s.attrs.get('id') ?? '').trim()
    const displayName = s.text.trim()
    if (stationId === '' || displayName === '') throw new StationXmlError(`${where} の観測点の ID・名前が空`)
    return {
      stationId,
      displayName,
      lat: numberText(s.attrs.get('lat'), '観測点の lat', where),
      lon: numberText(s.attrs.get('lon'), '観測点の lon', where),
    }
  })
  const boards = childrenOf(r, SEISMO_NS, 'Board').map((b) => ({
    boardKey: boardKeyOf((b.attrs.get('key') ?? '').trim(), where),
    sensorIds: childrenOf(b, SEISMO_NS, 'Sensor').map((s) => {
      const id = (s.attrs.get('id') ?? '').trim()
      if (mseed3LocationCode(id) === null) throw new StationXmlError(`${where} のセンサー ID が読めない: ${id}`)
      return id
    }),
  }))
  return { atMs, effectiveMs: effective === undefined ? atMs : msOf(effective, where), reason, stations, boards }
}

function overlaps(a: { startMs: number; endMs: number | null }, b: { startMs: number; endMs: number | null }): boolean {
  const aEnd = a.endMs ?? Number.POSITIVE_INFINITY
  const bEnd = b.endMs ?? Number.POSITIVE_INFINITY
  return a.startMs < bEnd && b.startMs < aEnd
}

/**
 * 期間が重なっていないか。**重なっていたら投げる** —— 同じ時刻に 2 つの設定が効いていたことになり、
 * どちらで流し直せばよいか決まらない。続きを書く側（`applyStationConfig`）も、開いた期間が
 * 1 つだけである前提で動く。
 */
function checkEpochs(boards: readonly { boardKey: BoardKey; startMs: number; endMs: number | null; channels: readonly ChannelHead[] }[]): void {
  for (const [i, a] of boards.entries()) {
    if (a.endMs !== null && a.endMs < a.startMs) throw new StationXmlError(`基板 ${a.boardKey} の期間の終わりが始まりより前`)
    for (const b of boards.slice(i + 1)) {
      if (a.boardKey === b.boardKey && overlaps(a, b)) throw new StationXmlError(`基板 ${a.boardKey} の期間が重なっている`)
    }
    for (const [j, c] of a.channels.entries()) {
      const where = `基板 ${a.boardKey} のセンサー ${c.sensorId} の軸 ${c.axis + 1}`
      if (c.endMs !== null && c.endMs < c.startMs) throw new StationXmlError(`${where} の期間の終わりが始まりより前`)
      if (c.startMs < a.startMs || (a.endMs !== null && (c.endMs === null || c.endMs > a.endMs))) {
        throw new StationXmlError(`${where} の期間が基板の期間をはみ出している`)
      }
      for (const d of a.channels.slice(j + 1)) {
        if (c.sensorId === d.sensorId && c.axis === d.axis && overlaps(c, d)) throw new StationXmlError(`${where} の期間が重なっている`)
      }
    }
  }
}

/**
 * 記録が区切りの時刻の順に並び、どの記録の時点でも期間と食い違わないか。**食い違えば投げる**
 * （`configAt` がそれぞれの記録の時点で設定を組めるかで確かめる）。
 */
function checkRevisions(doc: StationHistoryDoc): void {
  let previous = Number.NEGATIVE_INFINITY
  for (const r of doc.revisions) {
    if (r.effectiveMs < previous) throw new StationXmlError(`記録 ${new Date(r.atMs).toISOString()} が前の記録より前の時刻にある`)
    if (r.effectiveMs < r.atMs) throw new StationXmlError(`記録 ${new Date(r.atMs).toISOString()} の区切りの時刻が実際の時刻より前`)
    previous = r.effectiveMs
    configAt(doc, r.effectiveMs)
  }
}

/**
 * StationXML の文字列から履歴を読む。**投げる**（`StationXmlError`・`XmlReadError`）。
 * 前の形のチャンネルは今の形へ写して返す（冒頭「前の形を読む」）。
 */
export function readStationXml(source: string): StationHistoryDoc {
  const root = parseXml(source)
  if (root.ns !== STATION_XML_NS || root.local !== 'FDSNStationXML') {
    throw new StationXmlError('FDSNStationXML ではない')
  }
  const raw: { boardKey: BoardKey; startMs: number; endMs: number | null; station: StationInfo; orientation: Mat3 | null; channels: ChannelEpoch[]; legacy: LegacyChannel[] }[] = []
  for (const network of childrenOf(root, STATION_XML_NS, 'Network')) {
    for (const st of childrenOf(network, STATION_XML_NS, 'Station')) {
      const where = `Station ${st.attrs.get('code') ?? '?'}`
      const boardKey = boardKeyOf(need(st, SEISMO_NS, 'Board', where).text.trim(), where)
      if (mseed3StationCode(boardKey) !== st.attrs.get('code')) throw new StationXmlError(`${where} の基板の鍵 ${boardKey} が局コードと合わない`)
      const site = need(st, STATION_XML_NS, 'Site', where)
      const channels: ChannelEpoch[] = []
      const legacy: LegacyChannel[] = []
      for (const ch of childrenOf(st, STATION_XML_NS, 'Channel')) {
        const { head, here } = readChannelHead(ch, where)
        if (childOf(ch, SEISMO_NS, 'Vector') !== null) channels.push(readChannel(ch, head, here))
        else if (childOf(ch, SEISMO_NS, 'Rotation') !== null) legacy.push(readLegacyChannel(ch, head, here))
        else throw new StationXmlError(`${here} に Vector も Rotation も無い`)
      }
      raw.push({
        boardKey,
        ...epochOf(st, where),
        station: {
          stationId: need(st, SEISMO_NS, 'StationId', where).text.trim(),
          displayName: need(site, STATION_XML_NS, 'Name', where).text.trim(),
          lat: numberOf(need(st, STATION_XML_NS, 'Latitude', where), where),
          lon: numberOf(need(st, STATION_XML_NS, 'Longitude', where), where),
        },
        orientation: readOrientation(st, where),
        channels,
        legacy,
      })
    }
  }
  // 期間の重なりは写す前に見る（前の形の写しは、期間の始まりで効いている軸を引く）。
  checkEpochs(raw.map((b) => ({ ...b, channels: [...b.channels, ...b.legacy] })))
  const boards: BoardEpoch[] = raw.map((b) => {
    // **前の形のチャンネルは基板の向きを持たない Station にしか無い**（今の形を書くときは必ず
    // 基板の向きも書く）。両方があるのは手で継ぎ合わせたファイルで、どちらの向きで読むか決まらない。
    if (b.legacy.length > 0 && b.orientation !== null) {
      throw new StationXmlError(`基板 ${b.boardKey} に、基板の向きと前の形のチャンネルが両方ある`)
    }
    return {
      boardKey: b.boardKey,
      startMs: b.startMs,
      endMs: b.endMs,
      station: b.station,
      orientation: b.orientation ?? IDENTITY_MATRIX,
      channels: [...b.channels, ...convertLegacyChannels(b.boardKey, b.legacy)],
    }
  })
  const doc: StationHistoryDoc = { boards, revisions: childrenOf(root, SEISMO_NS, 'Revision').map(readRevision) }
  checkRevisions(doc)
  return doc
}
