// 生データ（miniSEED 3）を、実機の受信と同じ処理の鎖へ流し直す（評価台の入口）。
//
// **鎖は `main.ts` の受信と同じ部品を、同じ順に通す** —— `IntensityPipeline.handlePacket`
// （補正・区間・センサーごとの波形）→ `SensorFusion.ingest`（観測点の合成波形）。別に書き起こすと、
// 実機と違う波形で検出を評価することになる。パケットは受信の記録（LOG）と波形から組み立て直したもの
// （`mseedPacketReader.ts`）で、実機が読み取ったパケットと同じ値になる。
//
// **流すのはライブで届いたパケットだけ。** 取り戻した分（`backlog`）と遅れて届いた分（`late`）は
// 実機でも保存にしか回らない（`main.ts` の取り戻しの経路）ので、ここでも鎖へ入れない。
// **流す順は受け取った順**（`orderByReceipt`）。受け取った時刻が同じミリ秒なら、ホストが受け付けた
// 順の通し番号（受付番号）で並べる —— 観測点の合成はその順でも結果が変わるので、実機と同じ順に戻す。
//
// **観測点の設定は、その時刻に効いていたものを使う**（`stations.xml`。履歴も入っている）。切り替えるのは
// 履歴に残った記録（起動と設定の変更）の時刻 —— 実機はそのどちらでも観測点の表を差し替え、合成を
// 作り直している。記録が始まる前の時刻には最初の記録の設定を当てる —— 実機ではそれより前の
// 校正値が効いていたので、**履歴より前の日は感度・回転が実機と違う**（呼び出し側が見分ける）。

import { readFileSync } from 'node:fs'

import { IntensityPipeline } from '../src/receiver/intensityPipeline'
import type { WaveChunk } from '../src/receiver/intensityPipeline'
import { orderByReceipt, readMseedHour } from '../src/receiver/mseedPacketReader'
import type { StoredPacket } from '../src/receiver/mseedPacketReader'
import { SensorFusion } from '../src/receiver/sensorFusion'
import { StationDirectory } from '../src/receiver/stationConfig'
import type { StationConfig } from '../src/receiver/stationConfig'
import type { FusedWaveChunk } from '../src/receiver/sensorFusion'
import { configAt, type StationHistoryDoc } from '../src/receiver/stationXml'

/** 設定を切り替える時刻と、そこから効いた設定。 */
export interface StationHistoryEntry {
  readonly atMs: number
  readonly config: StationConfig
}

/**
 * 履歴から切り替えの並びを作る（記録の区切りの時刻の順。記録はもともとこの順に並ぶ）。
 * 設定はその時点の記録のとおりの並び・元の値で戻る（`configAt`）。
 */
export function historyEntries(doc: StationHistoryDoc): StationHistoryEntry[] {
  return doc.revisions.map((r) => ({ atMs: r.effectiveMs, config: configAt(doc, r.effectiveMs) }))
}

/** その時刻に効いていた設定。履歴より前なら最初の記録。履歴が空なら null。 */
export function entryAt(history: readonly StationHistoryEntry[], atMs: number): StationHistoryEntry | null {
  if (history.length === 0) return null
  let found = history[0]
  for (const e of history) {
    if (e.atMs > atMs) break
    found = e
  }
  return found
}

export type ReplayItem =
  | { readonly kind: 'sensor'; readonly wave: WaveChunk }
  | { readonly kind: 'station'; readonly wave: FusedWaveChunk }

export interface ReplayCounts {
  /** 組み立て直せたパケット（届き方を問わない）。 */
  packets: number
  /** 取り戻した分・遅れて届いた分（鎖へ入れない）。 */
  notLiveSkipped: number
  outOfWindow: number
  configSwitches: number
  /** ホストの受信の記録に中身ごと残っていたパケット（読めなかったもの・miniSEED に入れられなかったもの）。 */
  hostLogged: number
  /** CRC が合わないレコード・解けない波形・末尾の読み残し（バイト）。 */
  crcFailures: number
  decodeFailures: number
  skippedBytes: number
  /**
   * 中身を読めなかった受信の記録・起動 ID と番号を読めなかった波形のレコード・サンプルが
   * 揃わなかったパケット・どのパケットにも属さないサンプル。
   */
  unreadableLogs: number
  unreadableWaveRecords: number
  incompletePackets: number
  unclaimedSamples: number
}

export function emptyReplayCounts(): ReplayCounts {
  return {
    packets: 0,
    notLiveSkipped: 0,
    outOfWindow: 0,
    configSwitches: 0,
    hostLogged: 0,
    crcFailures: 0,
    decodeFailures: 0,
    skippedBytes: 0,
    unreadableLogs: 0,
    unreadableWaveRecords: 0,
    incompletePackets: 0,
    unclaimedSamples: 0,
  }
}

/** 時の本 1 本。`hourStartMs` はその本の時の始まり（日本時間の正時）。 */
export interface HourFile {
  readonly path: string
  readonly hourStartMs: number
}

/**
 * 次の本と混ぜてから流す幅。**名乗った時刻で本を分けているので、時の境目で届いたパケットは
 * 前後の本へ散る**（受け取りの遅れ・基板とホストの時計のずれぶん）。境目のこの幅だけ持ち越して
 * 次の本と一緒に並べ替えれば、受け取った順が本をまたいでも崩れない。1 日ぶんを丸ごと抱えないための形。
 */
const CARRY_MS = 60_000

/**
 * 時間ごとの `.mseed3`（時の順に並べて渡す）を流し、受け取った時刻が `[fromMs, toMs)` の
 * ライブのパケットだけを、受け取った順に鎖へ通す。センサーごとの波形と観測点の合成波形を、
 * 出てきた順に返す。
 *
 * `counts` は呼び出し側が渡した入れ物へ書き足す（終わってから読む）。
 */
export async function* replayMseed(params: {
  readonly files: readonly HourFile[]
  readonly fromMs: number
  readonly toMs: number
  readonly history: readonly StationHistoryEntry[]
  readonly counts: ReplayCounts
}): AsyncGenerator<ReplayItem> {
  const { counts } = params
  let current: StationHistoryEntry | null = null
  let pipeline: IntensityPipeline | null = null
  let fusion: SensorFusion | null = null
  let carry: StoredPacket[] = []

  const rxOf = (p: StoredPacket): number => p.rx ?? p.packet.firstSampleMs

  function* feed(stored: StoredPacket): Generator<ReplayItem> {
    const rx = rxOf(stored)
    if (rx < params.fromMs || rx >= params.toMs) {
      counts.outOfWindow++
      return
    }
    const wanted = entryAt(params.history, rx)
    if (wanted !== null && wanted !== current) {
      // 実機の設定変更と同じ順: 観測点の表を差し替え、合成は締めてから作り直す。
      if (pipeline === null) {
        pipeline = new IntensityPipeline({ stations: new StationDirectory(wanted.config) })
      } else {
        pipeline.updateStations(new StationDirectory(wanted.config))
        counts.configSwitches++
      }
      if (fusion !== null) {
        const closing = fusion.closeAll()
        for (const w of closing.drained) if (w.fusedWave !== null) yield { kind: 'station', wave: w.fusedWave }
      }
      fusion = new SensorFusion(wanted.config)
      current = wanted
    }
    if (pipeline === null || fusion === null) return
    const outcome = pipeline.handlePacket(stored.packet)
    if (outcome.wave === null) return
    yield { kind: 'sensor', wave: outcome.wave }
    const fused = fusion.ingest(outcome.wave)
    if (fused.fusedWave !== null) yield { kind: 'station', wave: fused.fusedWave }
  }

  for (const [i, file] of params.files.entries()) {
    const read = readMseedHour(readFileSync(file.path))
    counts.packets += read.packets.length
    counts.hostLogged += read.unreadable.length
    counts.crcFailures += read.crcFailures
    counts.decodeFailures += read.decodeFailures
    counts.skippedBytes += read.skippedBytes
    counts.unreadableLogs += read.unreadableLogs
    counts.unreadableWaveRecords += read.unreadableWaveRecords
    counts.incompletePackets += read.incompletePackets
    counts.unclaimedSamples += read.unclaimedSamples

    const live: StoredPacket[] = []
    for (const p of read.packets) {
      if (p.lane === 'live') live.push(p)
      else counts.notLiveSkipped++
    }
    const ordered = orderByReceipt([...carry, ...live])
    const next = params.files[i + 1]
    const cut = next === undefined ? Number.POSITIVE_INFINITY : next.hourStartMs - CARRY_MS
    carry = []
    for (const stored of ordered) {
      if (rxOf(stored) >= cut) carry.push(stored)
      else yield* feed(stored)
    }
  }
}
