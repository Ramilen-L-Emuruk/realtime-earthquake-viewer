// 状態の口（`GET /status`）が返す中身を組み立てる。
//
// **宛先は運用者。** 「基板は生きているか」「落としていないか」「生データは残って
// いるか」を見に来る人のためのもので、PWA が読むのは押し出しの口のほう
// （観測結果はビューアー、機材の管理はビューアーの外、という線引き）。
//
// **`main()` の中に書かない。** あそこは「直接実行のときだけ走らせる」門の内側に
// あってテストが届かないので、出す条件をそこへ書くと**誰も見ていないことになる**
// （4-2 の `buildWindowSummary` / `buildRawWarnings` と同じ分担）。
//
// **配る中身は 3 系統ある。** 数え上げ（`packetTally.ts`）だけを配ると
// **「生データが残っていない」ことがこの口から丸ごと落ちる** —— 保存の健全性は
// 表の外にあり、区間の時間軸とセンサーの生存も別の場所が持っている。

import type { SegmentState } from '../timebase/segmenter'
import type { TallySnapshot } from './packetTally'
import type { HubSnapshot } from './readingHub'
import type { SensorHealth } from './sensorHealth'

/**
 * 生データの保存の様子。**`RawStore` の読み取り専用の値をそのまま並べる。**
 *
 * クラスを直に受け取らない —— 純関数の入力を実物のクラスへ結ぶと、試すのに
 * ディスクが要る。4-2 の `buildClosingLines` が同じ形を採っている。
 */
export interface RawStoreStatus {
  readonly writeErrors: number
  readonly lostRecords: number
  readonly slowCloses: number
  readonly compressed: number
  readonly compressFailures: number
  readonly leftovers: number
  readonly listFailures: number
  readonly escaped: number
  readonly openFiles: number
  readonly stuckBooks: number
  readonly recordsAtRisk: number
  readonly cutShort: boolean
  readonly currentDay: string | null
  readonly lastWriteError: string | null
  readonly lastSweepError: string | null
}

export interface Endpoint {
  readonly address: string
  readonly port: number
}

export interface StatusReportInput {
  readonly nowMs: number
  /** 待ち受けを開けた時刻。 */
  readonly startedAtMs: number
  readonly udp: Endpoint
  readonly http: Endpoint
  readonly tally: TallySnapshot
  readonly sensors: readonly SensorHealth[]
  /** センサーの覚えを上限で押し出した数。 */
  readonly sensorEvictions: number
  readonly segments: readonly SegmentState[]
  /** 数として出せなかった計測震度を見た回数。**0 が正常。** */
  readonly unusableIntensities: number
  readonly raw: RawStoreStatus
  readonly hub: HubSnapshot
}

/** 区間 1 つぶん。**時刻の根拠が崩れていないかを読む場所。** */
export interface SegmentStatus {
  readonly streamKey: string
  readonly segmentId: number
  readonly boardKey: string
  readonly sensorId: string
  readonly sampleCount: number
  readonly firstSampleMs: number | null
  readonly msPerSample: number | null
  /** 当てはめに使ったパケットの数。 */
  readonly anchorCount: number
  /** 名乗られた時刻のばらつき。**平常時の目安は 2.5〜4.7 ms。** */
  readonly residualRmsMs: number | null
  /** 公称値へ倒したなら理由。当てはめた値を使っていれば null。 */
  readonly nominalReason: string | null
}

/**
 * センサー 1 個ぶん。**`SensorHealth` と時刻の型だけが違う。**
 *
 * 出せない時刻を `0` で埋めない —— 1970 年として読めてしまい、「値が壊れている」と
 * 「1970 年に最後の声を聞いた」を受け手が区別できない。
 */
export interface SensorStatus extends Omit<SensorHealth, 'lastPacketMs'> {
  readonly lastPacketMs: number | null
}

export interface StatusReport {
  /** この答えを作った時刻。 */
  readonly generatedAtMs: number
  readonly startedAtMs: number
  readonly uptimeSec: number
  readonly udp: Endpoint
  readonly http: Endpoint
  readonly sensors: readonly SensorStatus[]
  readonly sensorEvictions: number
  readonly segments: readonly SegmentStatus[]
  /**
   * 数として出せなかった計測震度を見た回数。
   *
   * **`unreadableTimes` とは別の数。** あちらはこの答えを組み立てるときに見つけた
   * 壊れた時刻で、こちらは**震度を出す段で既に倒してある**もの。混ぜると、
   * どちらの層で壊れたのかが読めなくなる。
   */
  readonly unusableIntensities: number
  readonly tally: {
    readonly sources: Record<string, unknown>
    readonly boards: Record<string, unknown>
  }
  readonly raw: RawStoreStatus
  readonly stream: HubSnapshot
  /**
   * 数値として出せなかった時刻の数。
   *
   * **これが無いと黙って消える。** `JSON.stringify` は `NaN` も `Infinity` も
   * `null` にするので、値が壊れていたことと「まだ無い」ことが受け手には同じに見える。
   * このリポジトリが「日時は 2 つの層で確かめる」と決めているのと同じ手当て。
   *
   * **数えるのは時刻の欄だけ。** 震度の値が壊れていた分は
   * `unreadableIntensityValues` が持つ（下記）。
   */
  readonly unreadableTimes: number
  /**
   * 数値として出せなかった震度の値の数。
   *
   * **`unreadableTimes` へ混ぜない。** 名前のとおりあちらは時刻の欄の話で、
   * 混ぜると運用者が「時刻が壊れている」と読んで別の層を疑う。
   *
   * **`unusableIntensities` とも別。** あちらは震度を出す段で落とした数で、
   * こちらは**そこを抜けてきた値**がこの答えを組み立てる時点で壊れていた数 ——
   * 上流の番人（`intensityPipeline.ts` の `normalizeIntensity`）が効いている限り
   * 0 のままで、増えたらその境界が緩んだ合図になる。
   */
  readonly unreadableIntensityValues: number
}

/** `Map` を JSON になる形へ。**出す側と読む側で流儀が分かれないよう 1 箇所に置く。** */
function fromMap<K extends string, V>(m: ReadonlyMap<K, V>): Record<string, V> {
  const out: Record<string, V> = {}
  for (const [k, v] of m) out[k] = v
  return out
}

/**
 * 数え上げの入れ子（理由別の `Map`）まで開く。
 *
 * **欄を名指しで書き写さない。** `packetTally.ts` に数え上げを 1 つ足したとき、
 * 書き写す形だとこの口からだけ静かに落ちる（型検査もテストも通る）。
 */
function countsToJson(counts: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(counts)) {
    out[k] = v instanceof Map ? fromMap(v as ReadonlyMap<string, number>) : v
  }
  return out
}

export function buildStatusReport(input: StatusReportInput): StatusReport {
  let unreadable = 0
  let unreadableValues = 0
  /**
   * 有限でなければ `null` にして数える。**数える先を呼び出し側が選ぶ。**
   *
   * 時刻の欄と震度の値を同じ数へ落とすと、名前（`unreadableTimes`）が嘘になる。
   */
  const readable = (v: number | null, bump: () => void): number | null => {
    if (v === null) return null
    if (!Number.isFinite(v)) {
      bump()
      return null
    }
    return v
  }
  /** 時刻の欄。 */
  const finite = (v: number | null): number | null => readable(v, () => (unreadable += 1))
  /** 震度の値。 */
  const finiteValue = (v: number | null): number | null =>
    readable(v, () => (unreadableValues += 1))

  const segments: SegmentStatus[] = input.segments.map((s) => ({
    streamKey: s.meta.streamKey,
    segmentId: s.meta.segmentId,
    boardKey: s.meta.boardKey,
    sensorId: s.meta.sensorId,
    sampleCount: s.sampleCount,
    firstSampleMs: finite(s.timebase.firstSampleMs),
    msPerSample: finite(s.timebase.msPerSample),
    anchorCount: s.timebase.anchorCount,
    residualRmsMs: finite(s.timebase.residualRmsMs),
    nominalReason: s.timebase.nominalReason,
  }))

  const sensors: SensorStatus[] = input.sensors.map((s) => ({
    ...s,
    lastPacketMs: finite(s.lastPacketMs),
    lastReadingAtMs: finite(s.lastReadingAtMs),
    lastIntensity: finiteValue(s.lastIntensity),
  }))

  const sources: Record<string, unknown> = {}
  for (const [k, v] of input.tally.sources) {
    sources[k] = countsToJson(v)
  }
  const boards: Record<string, unknown> = {}
  for (const [k, v] of input.tally.boards) {
    boards[k] = countsToJson(v)
  }

  // **経過は秒で丸めて出す。** ミリ秒のままだと読む人が毎回割ることになる。
  // 起動より前の時刻を渡されても負にしない（時計が跳ねたとき「稼働 -3 秒」は読めない）。
  const uptimeSec = Math.max(0, Math.floor((input.nowMs - input.startedAtMs) / 1000))

  return {
    generatedAtMs: input.nowMs,
    startedAtMs: input.startedAtMs,
    uptimeSec,
    udp: input.udp,
    http: input.http,
    sensors,
    sensorEvictions: input.sensorEvictions,
    segments,
    unusableIntensities: input.unusableIntensities,
    tally: { sources, boards },
    raw: input.raw,
    stream: input.hub,
    unreadableTimes: unreadable,
    unreadableIntensityValues: unreadableValues,
  }
}
