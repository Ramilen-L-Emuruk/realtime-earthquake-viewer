// 元のファイル 1 本（生データの時のファイル・合成波形の時のファイル）から要約（`waveSummary.ts`）を作る。
//
// **どちらも 1 時間ぶんを丸ごと読む。** 要約は前もって作るもの（重い読みは 1 回だけ払う）なので、
// 区間だけ読む工夫（`readMseed3RecordsWhere`）は要らない。呼び出し側はこれをイベントループの外
// （別スレッド）で回すこと —— 生データ 1 時間の復号は実測 0.58 秒で、受信の見張り（`loopStall.ts`）の
// 閾値 1 秒に迫る。

import { MSEED3_HOST_LOG_SOURCE_ID, mseed3SourceId } from './mseed3Record'
import { readMseed3Records } from './mseed3Reader'
import { decodeWaveFile, resolveRevisions } from './waveArchive'
import { SummaryBuilder, type SummaryFile } from './waveSummary'

const HOUR_MS = 3_600_000
const ENCODING_TEXT = 0
const ENCODING_STEIM2 = 11

/** 合成波形の向きの名前。`waveArchive.ts` の並び（南北・東西・上下）に合わせる。 */
const STATION_AXES = ['NS', 'EW', 'UD'] as const

/**
 * 合成波形の要約のチャンネルの名前。`stationKey` は合成波形のファイル名に入っている観測点の札
 * （`waveArchive.ts` の `stationFileToken`）—— **札から識別子へは戻せない**ので、要約は札で名乗る。
 * **向きは末尾の `/` の後ろ**（読み戻すときは最後の区切りで割ること）。
 */
export function stationWaveChannelId(stationKey: string, axis: 0 | 1 | 2): string {
  return `station/${stationKey}/${STATION_AXES[axis]}`
}

/**
 * 受信の記録（`LOG` チャンネル）から、そのセンサーの分解能を読む。読めなければ `null`。
 *
 * **ここで要るのは分解能だけ**なので、パケットを組み立て直す読み手（`mseedPacketReader.ts`）ほど
 * 厳しく欄を揃えることは求めない —— 揃わないとそのセンサーの換算が丸ごと消える。
 */
function scaleOfLog(text: string): { board: string; sensor: string; channels: string[]; ugPerLsb: number } | null {
  let o: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return null
    o = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const { board, sensor, channels, ugPerLsb } = o
  if (typeof board !== 'string' || typeof sensor !== 'string') return null
  if (!Array.isArray(channels) || !channels.every((c) => typeof c === 'string')) return null
  if (typeof ugPerLsb !== 'number' || !Number.isFinite(ugPerLsb) || ugPerLsb <= 0) return null
  return { board, sensor, channels: channels as string[], ugPerLsb }
}

/**
 * 生データの時のファイル 1 本を要約する。**投げない。**
 *
 * `hourStartMs` はそのファイルが受け持つ時の頭（日本時間）。時から外れたサンプル（時計が合う前に
 * 受け取った時のファイルへ入った 1970 年の時刻のもの。`recordAssembler.ts` の `fileTimeOf`）は数えて外す。
 */
export function summarizeMseedHour(buf: Uint8Array, hourStartMs: number): SummaryFile {
  const read = readMseed3Records(buf)
  const builder = new SummaryBuilder({ fromMs: hourStartMs, toMs: hourStartMs + HOUR_MS })
  for (const r of read.records) {
    if (r.encoding === ENCODING_TEXT) {
      if (r.sourceId === MSEED3_HOST_LOG_SOURCE_ID || r.text === null) continue
      const scale = scaleOfLog(r.text)
      if (scale === null) continue
      for (const ch of scale.channels) {
        const sid = mseed3SourceId(scale.board, scale.sensor, ch)
        if (sid !== null) builder.declare(sid, { unit: 'count', ugPerLsb: scale.ugPerLsb })
      }
      continue
    }
    if (r.encoding !== ENCODING_STEIM2 || r.samples === null || !(r.sampleRateHz > 0)) continue
    builder.add(r.sourceId, r.startMs, 1000 / r.sampleRateHz, r.samples)
  }
  return builder.build(buf.length, {
    skippedBytes: read.skippedBytes,
    badRecords: read.crcFailures + read.decodeFailures,
  })
}

/**
 * 合成波形の時のファイル 1 本（1 観測点ぶん）を要約する。`stationKey` はファイル名の観測点の札。**投げない。**
 *
 * **作り直した分（印付き）は、重なるライブの分より優先する**（読み返し `readWaveRange` と同じ
 * `resolveRevisions` を通す）。**解くのはファイルの中だけ** —— 前の時のファイルの末尾から時の境目を
 * 跨いだまとまりとの重なりは見ない（まとまりは 0.3 秒ほどなので、跨ぐのは境目の 1 まとまりだけ）。
 */
export function summarizeWaveHour(buf: Buffer, stationKey: string, hourStartMs: number): SummaryFile {
  const decoded = decodeWaveFile(buf, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
  const builder = new SummaryBuilder({ fromMs: hourStartMs, toMs: hourStartMs + HOUR_MS })
  const ids = [stationWaveChannelId(stationKey, 0), stationWaveChannelId(stationKey, 1), stationWaveChannelId(stationKey, 2)]
  for (const id of ids) builder.declare(id, { unit: 'gal', ugPerLsb: null })
  for (const c of resolveRevisions(decoded.chunks)) {
    for (let a = 0; a < 3; a += 1) builder.add(ids[a]!, c.firstSampleMs, c.msPerSample, c.gal[a]!)
  }
  return builder.build(buf.length, { skippedBytes: decoded.skippedBytes, badRecords: 0 })
}
