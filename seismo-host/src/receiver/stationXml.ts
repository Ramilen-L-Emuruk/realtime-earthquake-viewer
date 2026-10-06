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
//   名乗れない基板・センサーは設定の検証（`stationConfig.ts`）が受け付けない。
// - **期間は設定が変わったところで区切る。** 観測点の情報（ID・表示名・座標）が変われば基板の期間を、
//   校正値が変われば軸の期間を閉じて新しく開く。変わらなければ前の期間が続く。
// - **校正はホストの式（`calibration.ts`）と同じ変換になるように分ける。**
//
//   ```
//   ホスト:  a = R × diag(s) × (m − o)      a: 地面の加速度（ENU）  m: 校正前の加速度（gal）
//   ```
//
//   `D = R⁻¹` と置くと `m_j = (|d_j| / s_j) × (û_j · a) + o_j`（`d_j` は `D` の第 j 行、`û_j` はその向き）。
//   StationXML の `Azimuth`・`Dip` は「そのチャンネルが測っている向き」なので `û_j` を入れ、
//   応答（Response）を 3 段に分ける —— 段 1 の倍率 `|d_j|`、段 2 の倍率 `1 / s_j`、段 3 の多項式で
//   ゼロ点 `o_j` を足す。総合の多項式（`InstrumentPolynomial`）は 3 段をまとめたもので、標準の道具が読む要約。
//
//   **`R` が純粋な回転なら `û_j` は `R` の第 j 列と同じ向き。** 直交でない `R` でも、標準の道具で
//   向きを直した結果がホストと一致する（測っている向きを書いているため）。そのために `R` は
//   逆行列を持たねばならず、特異な `R` は設定の検証で弾いている。
//
// - **ホストが使う値そのもの（`R` の第 j 列と `s_j`）を、各 Channel の拡張に持つ。** 方位・傾き・倍率は
//   三角関数と逆行列を通すので、そこから組み直すと元の値に戻らない（実測で `R` が 8e-15 ずれる）。
//   **読み手（ホスト自身を含む）は拡張の値を使い**、標準の欄はそこから計算し直したものと一致するかを
//   確かめる —— 食い違う履歴は、どちらが正しいか決められないので読めないとして退ける。
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
// **Node 専用のコードを持たない**（ファイルの読み書きは `stationStore.ts`）。

import type { BoardKey } from '../protocol/types'
import { invert3, isInvertibleRotation } from './matrix3'
import { mseed3LocationCode, mseed3StationCode } from './mseed3Record'
import type { BoardEntry, Mat3, SensorEntry, StationConfig, StationInfo, Vec3 } from './stationConfigTypes'
import { EMPTY_STATION_CONFIG } from './stationConfigTypes'
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
  /** ホストが使う `R` の第 `axis` 列（東・北・上）。**読み手はこちらを使う。** */
  readonly rotation: Vec3
  /** ホストが使う `s_axis`。 */
  readonly sensitivity: number
  /** 測っている向き（度）。北から時計回り。`rotation` から計算したもの。 */
  readonly azimuth: number
  /** 測っている向き（度）。水平から下向きが正。`rotation` から計算したもの。 */
  readonly dip: number
  /** 段 1 の倍率 `|d_j|`。 */
  readonly directionGain: number
  /** 段 2 の倍率 `1 / s_j`。 */
  readonly axisGain: number
  /** 段 3 で足すゼロ点 `o_j`（gal）。 */
  readonly offset: number
  readonly enabled: boolean
  readonly noiseDensity: number | null
}

/** 基板 1 枚の期間（StationXML の Station 1 つ）。 */
export interface BoardEpoch {
  readonly boardKey: BoardKey
  readonly startMs: number
  readonly endMs: number | null
  readonly station: StationInfo
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

/** センサー 1 個の校正値を、軸 3 本の値へ。**特異な `R` なら投げる。** */
function channelValuesOf(sensor: SensorEntry): ChannelValues[] {
  const inv = invert3(sensor.rotation)
  if (inv === null || !isInvertibleRotation(sensor.rotation)) {
    throw new StationXmlError(`センサー ${sensor.sensorId} の回転行列が逆行列を持たない`)
  }
  return ([0, 1, 2] as const).map((axis) => {
    const row = inv[axis]
    const length = Math.hypot(row[0], row[1], row[2])
    const { azimuth, dip } = directionOf(row[0] / length, row[1] / length, row[2] / length)
    return {
      sensorId: sensor.sensorId,
      axis,
      rotation: [sensor.rotation[0][axis], sensor.rotation[1][axis], sensor.rotation[2][axis]],
      sensitivity: sensor.sensitivity[axis],
      azimuth,
      dip,
      directionGain: length,
      axisGain: 1 / sensor.sensitivity[axis],
      offset: sensor.offset[axis],
      enabled: sensor.enabled,
      noiseDensity: sensor.noiseDensity,
    }
  })
}

function sameChannelValues(a: ChannelValues, b: ChannelValues): boolean {
  return (
    a.sensorId === b.sensorId &&
    a.axis === b.axis &&
    a.rotation[0] === b.rotation[0] &&
    a.rotation[1] === b.rotation[1] &&
    a.rotation[2] === b.rotation[2] &&
    a.sensitivity === b.sensitivity &&
    a.azimuth === b.azimuth &&
    a.dip === b.dip &&
    a.directionGain === b.directionGain &&
    a.axisGain === b.axisGain &&
    a.offset === b.offset &&
    a.enabled === b.enabled &&
    a.noiseDensity === b.noiseDensity
  )
}

/**
 * 軸 3 本の値から、センサー 1 個の校正値へ戻す。**元の値（拡張）から組み、標準の欄がそこから
 * 計算し直したものと一致しなければ投げる。**
 */
function sensorOf(sensorId: string, channels: readonly ChannelEpoch[]): SensorEntry {
  const byAxis = [0, 1, 2].map((axis) => {
    const found = channels.filter((c) => c.axis === axis)
    if (found.length !== 1) {
      throw new StationXmlError(`センサー ${sensorId} の軸 ${axis + 1} が ${found.length} 本ある`)
    }
    return found[0] as ChannelEpoch
  }) as [ChannelEpoch, ChannelEpoch, ChannelEpoch]
  const first = byAxis[0]
  for (const c of byAxis) {
    if (c.enabled !== first.enabled || c.noiseDensity !== first.noiseDensity) {
      throw new StationXmlError(`センサー ${sensorId} の軸どうしで有効かどうか・ノイズ密度が食い違う`)
    }
  }
  const row = (r: 0 | 1 | 2): Vec3 => [byAxis[0].rotation[r], byAxis[1].rotation[r], byAxis[2].rotation[r]]
  const vec = (f: (c: ChannelEpoch) => number): Vec3 => [f(byAxis[0]), f(byAxis[1]), f(byAxis[2])]
  const sensor: SensorEntry = {
    sensorId,
    enabled: first.enabled,
    rotation: [row(0), row(1), row(2)] as Mat3,
    offset: vec((c) => c.offset),
    sensitivity: vec((c) => c.sensitivity),
    noiseDensity: first.noiseDensity,
  }
  const recomputed = channelValuesOf(sensor)
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
 * **名乗れない基板・センサー、特異な回転行列、設定に無い観測点は投げる**（どれも設定の検証を
 * 通っていれば起きない）。
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
  const wanted = new Map<string, { station: StationInfo; channels: ChannelValues[] }>()
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
      channels.push(...channelValuesOf(sensor))
    }
    wanted.set(board.boardKey, { station, channels })
  }

  const boards: BoardEpoch[] = []
  const continued = new Set<string>()
  for (const epoch of doc.boards) {
    if (epoch.endMs !== null) {
      boards.push(epoch)
      continue
    }
    const next = wanted.get(epoch.boardKey)
    if (next === undefined || !sameStation(epoch.station, next.station)) {
      // 外された・観測点の情報が変わった —— 基板の期間ごと閉じる。
      boards.push(closeBoard(epoch, t))
      continue
    }
    // 観測点はそのまま。軸ごとに続けるか閉じるかを決める。
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
      ),
    )
    const stray = activeChannels.find((c) => !listed.sensorIds.includes(c.sensorId))
    if (stray !== undefined) throw new StationXmlError(`${where} に載っていないセンサー ${stray.sensorId} の期間が効いている`)
    boards.push({ boardKey: epoch.boardKey, stationId: station.stationId, sensors })
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

function writeChannel(lines: string[], ch: ChannelEpoch, station: StationInfo): void {
  const loc = mseed3LocationCode(ch.sensorId) as string
  const p = '      '
  lines.push(`${p}<Channel code="HN${ch.axis + 1}" locationCode="${escapeXml(loc)}"${dateAttrs(ch.startMs, ch.endMs)}>`)
  lines.push(`${p}  <seismo:Sensor>${escapeXml(ch.sensorId)}</seismo:Sensor>`)
  lines.push(`${p}  <seismo:Enabled>${ch.enabled}</seismo:Enabled>`)
  if (ch.noiseDensity !== null) {
    lines.push(`${p}  <seismo:NoiseDensity unit="ug/sqrt(Hz)">${num(ch.noiseDensity)}</seismo:NoiseDensity>`)
  }
  // ホストが使う値そのもの。読み手はこちらを使い、下の標準の欄はここから計算したもの。
  lines.push(`${p}  <seismo:Rotation e="${num(ch.rotation[0])}" n="${num(ch.rotation[1])}" u="${num(ch.rotation[2])}"/>`)
  lines.push(`${p}  <seismo:Sensitivity>${num(ch.sensitivity)}</seismo:Sensitivity>`)
  lines.push(`${p}  <Latitude>${num(station.lat)}</Latitude>`)
  lines.push(`${p}  <Longitude>${num(station.lon)}</Longitude>`)
  lines.push(`${p}  <Elevation>0</Elevation>`)
  lines.push(`${p}  <Depth>0</Depth>`)
  lines.push(`${p}  <Azimuth>${num(ch.azimuth)}</Azimuth>`)
  lines.push(`${p}  <Dip>${num(ch.dip)}</Dip>`)
  lines.push(`${p}  <Type>CONTINUOUS</Type>`)
  lines.push(`${p}  <Response>`)
  // 3 段をまとめた要約: (û·a) = (s/|d|) × (m − o)。
  const gain = 1 / (ch.directionGain * ch.axisGain)
  lines.push(`${p}    <InstrumentPolynomial>`)
  lines.push(`${p}      <InputUnits><Name>cm/s**2</Name><Description>ground acceleration along the channel direction</Description></InputUnits>`)
  lines.push(`${p}      <OutputUnits><Name>cm/s**2</Name><Description>sensor acceleration before calibration</Description></OutputUnits>`)
  writePolynomialBody(lines, `${p}      `, -ch.offset * gain, gain)
  lines.push(`${p}    </InstrumentPolynomial>`)
  lines.push(`${p}    <Stage number="1"><StageGain><Value>${num(ch.directionGain)}</Value><Frequency>${GAIN_FREQUENCY_HZ}</Frequency></StageGain></Stage>`)
  lines.push(`${p}    <Stage number="2"><StageGain><Value>${num(ch.axisGain)}</Value><Frequency>${GAIN_FREQUENCY_HZ}</Frequency></StageGain></Stage>`)
  lines.push(`${p}    <Stage number="3">`)
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
    lines.push(`    <Station code="${code}"${dateAttrs(epoch.startMs, epoch.endMs)}>`)
    lines.push(`      <seismo:Board>${escapeXml(epoch.boardKey)}</seismo:Board>`)
    lines.push(`      <seismo:StationId>${escapeXml(epoch.station.stationId)}</seismo:StationId>`)
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

function readChannel(el: XmlElement, where: string): ChannelEpoch {
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
  const rotation = need(el, SEISMO_NS, 'Rotation', here)
  const response = need(el, STATION_XML_NS, 'Response', here)
  const stages = childrenOf(response, STATION_XML_NS, 'Stage')
  const stage = (n: string): XmlElement => {
    const s = stages.find((x) => x.attrs.get('number') === n)
    if (s === undefined) throw new StationXmlError(`${here} に段 ${n} が無い`)
    return s
  }
  const gainOf = (n: string): number =>
    numberOf(need(need(stage(n), STATION_XML_NS, 'StageGain', here), STATION_XML_NS, 'Value', here), here)
  const poly = need(stage('3'), STATION_XML_NS, 'Polynomial', here)
  const coefficient = (n: string): number => {
    const c = childrenOf(poly, STATION_XML_NS, 'Coefficient').find((x) => x.attrs.get('number') === n)
    if (c === undefined) throw new StationXmlError(`${here} の段 3 に係数 ${n} が無い`)
    return numberOf(c, here)
  }
  if (coefficient('1') !== 1) throw new StationXmlError(`${here} の段 3 の 1 次の係数が 1 でない`)
  return {
    sensorId,
    axis,
    ...epochOf(el, here),
    rotation: [
      numberText(rotation.attrs.get('e'), 'Rotation の e', here),
      numberText(rotation.attrs.get('n'), 'Rotation の n', here),
      numberText(rotation.attrs.get('u'), 'Rotation の u', here),
    ],
    sensitivity: numberOf(need(el, SEISMO_NS, 'Sensitivity', here), here),
    azimuth: numberOf(need(el, STATION_XML_NS, 'Azimuth', here), here),
    dip: numberOf(need(el, STATION_XML_NS, 'Dip', here), here),
    directionGain: gainOf('1'),
    axisGain: gainOf('2'),
    offset: -coefficient('0'),
    enabled: enabledText === 'true',
    noiseDensity: nd === null ? null : numberOf(nd, here),
  }
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
function checkEpochs(boards: readonly BoardEpoch[]): void {
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

/** StationXML の文字列から履歴を読む。**投げる**（`StationXmlError`・`XmlReadError`）。 */
export function readStationXml(source: string): StationHistoryDoc {
  const root = parseXml(source)
  if (root.ns !== STATION_XML_NS || root.local !== 'FDSNStationXML') {
    throw new StationXmlError('FDSNStationXML ではない')
  }
  const boards: BoardEpoch[] = []
  for (const network of childrenOf(root, STATION_XML_NS, 'Network')) {
    for (const st of childrenOf(network, STATION_XML_NS, 'Station')) {
      const where = `Station ${st.attrs.get('code') ?? '?'}`
      const boardKey = boardKeyOf(need(st, SEISMO_NS, 'Board', where).text.trim(), where)
      if (mseed3StationCode(boardKey) !== st.attrs.get('code')) throw new StationXmlError(`${where} の基板の鍵 ${boardKey} が局コードと合わない`)
      const site = need(st, STATION_XML_NS, 'Site', where)
      boards.push({
        boardKey,
        ...epochOf(st, where),
        station: {
          stationId: need(st, SEISMO_NS, 'StationId', where).text.trim(),
          displayName: need(site, STATION_XML_NS, 'Name', where).text.trim(),
          lat: numberOf(need(st, STATION_XML_NS, 'Latitude', where), where),
          lon: numberOf(need(st, STATION_XML_NS, 'Longitude', where), where),
        },
        channels: childrenOf(st, STATION_XML_NS, 'Channel').map((ch) => readChannel(ch, where)),
      })
    }
  }
  checkEpochs(boards)
  const doc: StationHistoryDoc = { boards, revisions: childrenOf(root, SEISMO_NS, 'Revision').map(readRevision) }
  checkRevisions(doc)
  return doc
}
