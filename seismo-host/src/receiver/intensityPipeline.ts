// 届いたパケットを、段 1〜3 へ順に通して計測震度相当へ変える。
//
// **この層が受け持つのは「繋ぎ方」だけ。** 読み取り（`../protocol/parsePacket.ts`）・
// 区間の組み立て（`../timebase/segmenter.ts`）・震度の流し込み（`../intensity/`）は
// それぞれ独立に検証してあるので、ここで直すのは**渡す順番と閉じ方**に限る。
//
// **落とした件数はここで数えない。** 1 パケットごとに何が起きたかを返すだけで、
// 集計は呼び出し側が持つ（`../protocol/parsePacket.ts`・`../intensity/units.ts` と
// 同じ分担）。数える場所が 2 つに分かれると、片方だけ理由が増えたときに食い違う。
//
// **記録もここでは出さない。** 画面を持たない常駐プロセスなので気づく手立ては記録だけ
// だけれど、出す先（標準出力・状態の口）は上の層が決める。ここが持つのは**返す**責任で、
// 起きたことを落とさずに戻り値へ載せること。
import { galFromCounts } from '../intensity/units'
import { IntensityStream } from '../intensity/intensityStream'
import type { IntensityPoint } from '../intensity/intensityStream'
import type { BoardKey, SensorPacket } from '../protocol/types'
import { Segmenter, sampleTimeMs } from '../timebase/segmenter'
import type {
  NominalReason,
  SegmentBreakReason,
  SegmentMeta,
  SegmentState,
  Timebase,
} from '../timebase/segmenter'
// **窓と刻みは K-NET の取り込みと同じ値を使う。** 自作センサーの観測結果は最終的に
// 同じ画面へ並ぶので、物差しが違えば「揺れ方の違い」と「測り方の違い」を見分けられない。
// 写し取らずに読むのは、片方だけ動いたときに黙って離れるのを防ぐため。
import { STEP_SEC_DEFAULT, WINDOW_SEC_DEFAULT } from '../../../src/utils/knet/seismicIntensity'

/**
 * 窓ごとに平均を引く。**自作センサーでは固定。**
 *
 * 生の値には重力がそのまま乗る（机に置いた基板で約 1009 gal）。引かずに通すと、
 * FFT のゼロ埋めが作る段差が低い周波数へ漏れて、静止した基板が震度 4〜6 相当を出す
 * （実測と経緯は `../intensity/intensityStream.ts` の `demeanWindow`）。
 *
 * 段 3 が既定値を置かなかったのは「通す側に選ばせる」ため。**ここがその選ぶ側。**
 */
const DEMEAN_WINDOW = true

/** 合成に要る成分の数。 */
const REQUIRED_AXES = 3

/** 震度まで届かなかった理由。**読み取りの失敗（`PacketParseFailure`）の先にあるもの。** */
export type PacketDropReason =
  /** 換算した値がセンサーのフルスケールを超えた。疑わしいのはヘッダが名乗る倍率なのでパケットごと捨てる。 */
  | 'scale-out-of-range'
  /** 既に渡した範囲。並び替えか重複。 */
  | 'duplicate'
  /** 流し込みが位置の食い違いで止まった。組み立てと震度を揃えて閉じ直した。 */
  | 'stream-desync'

/** その区間では震度を出さない理由。**パケットは受け取っている**（時間軸の統計には乗る）。 */
export type IntensitySkipReason =
  /** 3 成分でない。二乗和で合成できない。 */
  | 'axis-count'
  /** 流し込みを作れなかった。窓がその周波数の 0.3 秒を覆えない等。 */
  | 'stream-rejected'

/** 出せるようになった震度 1 つ。 */
export interface IntensityReading {
  readonly streamKey: string
  readonly segmentId: number
  readonly boardKey: BoardKey
  readonly sensorId: string
  /** この値が代表する時刻（unix ミリ秒）。区間の当てはめから引く。 */
  readonly atMs: number
  /**
   * 計測震度相当。**窓の中身が足りなければ null。**
   * 「揺れていない」を意味する値ではないので 0 として扱わないこと。
   */
  readonly intensity: number | null
  /**
   * 時刻の当てはめを公称値へ倒したなら理由。当てはめた値を使っていれば null。
   *
   * **倒したことを隠さない。** 組み立ての側（`../timebase/segmenter.ts`）はそう決めて
   * いるのに、ここで落とすと下流へは一切届かない —— `atMs` は正常時と同じ形の値なので、
   * **時刻の根拠が崩れていても震度そのものは普通に出続ける。**
   *
   * **区間の状態（`openSegments()`）で代用しない。** あちらは「いまの当てはめ」で、
   * 倒れていた間に出した震度が後から当てはめが効いて健全に見える。
   */
  readonly timebaseNominalReason: NominalReason | null
  /** 名乗られた時刻のばらつき（ミリ秒）。当てはめていなければ null。 */
  readonly timebaseResidualRmsMs: number | null
}

/** 締めくくりを出せなかった区間。**その区間の最後の窓ぶんが失われている。** */
export interface CloseFailure {
  readonly streamKey: string
  readonly segmentId: number
  readonly detail: string
}

/** 区間を閉じた結果。 */
export interface CloseResult {
  readonly readings: readonly IntensityReading[]
  readonly failures: readonly CloseFailure[]
}

/** パケット 1 つを通した結果。 */
export interface PacketOutcome {
  /** 出せるようになった震度。閉じた区間の締めくくりも含む。 */
  readonly readings: readonly IntensityReading[]
  /** このパケットで閉じた区間。**このパケットの流れとは限らない**（上限に達した追い出し）。 */
  readonly closed: readonly SegmentState[]
  /** 締めくくりを出せなかった区間。空が正常。 */
  readonly closeFailures: readonly CloseFailure[]
  /** 新しい区間が始まったなら理由。続きなら null。 */
  readonly startedBecause: SegmentBreakReason | null
  /** このパケットを落としたなら理由。通っていれば null。 */
  readonly dropped: PacketDropReason | null
  /** 落とした・見送った事情。原因を追うための文面で、**数えるのは理由のコードのほう。** */
  readonly detail: string | null
  /** 始まった区間で震度を出せないなら理由。区間が始まった回にだけ入る。 */
  readonly intensitySkipped: IntensitySkipReason | null
}

export interface IntensityPipelineOptions {
  /** 1 回の計算で見る長さ（秒）。 */
  readonly windowSec?: number
  /** 答えを出す間隔（秒）。 */
  readonly stepSec?: number
  /** 同時に覚えておく流れの数の上限。`Segmenter` へそのまま渡す。 */
  readonly maxStreams?: number
}

interface Entry {
  /** 震度を出せない区間では null。 */
  readonly stream: IntensityStream | null
  readonly skip: IntensitySkipReason | null
  /** 作れなかった理由。作れていれば null。 */
  readonly skipDetail: string | null
}

/**
 * 何も起きなかったときの形。**呼ぶたびに作る** —— 使い回すと、落とした全ての結果が
 * 同じ空配列を指す。いまは型が読み取り専用なので書き換えられないが、それは型だけの保証で、
 * 1 箇所の書き込みが無関係な過去の結果まで汚す形は残したくない。
 */
function nothing(): Omit<PacketOutcome, 'dropped' | 'detail'> {
  return { readings: [], closed: [], closeFailures: [], startedBecause: null, intensitySkipped: null }
}

type GalResult =
  | { readonly ok: true; readonly gal: [number[], number[], number[]] }
  | { readonly ok: false; readonly detail: string }

/**
 * カウント値を 3 成分の gal へ直す。**1 件でも範囲の外ならパケットごと捨てる。**
 *
 * 軸ごとに間引くと 3 成分の長さが食い違い、時刻の合わない値どうしを合成することになる
 * （理由は `../intensity/units.ts`）。
 *
 * **どこで外れたかを返す。** 桁を取り違えたヘッダを名乗る基板は以後すべてのパケットで
 * ここへ落ちるので、内訳が無いと「単発の異常値」と「恒久的な設定の誤り」を見分けられない。
 */
function toGal(p: SensorPacket): GalResult {
  const n = p.samples.length
  const gal: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
  for (let i = 0; i < n; i++) {
    const row = p.samples[i]
    for (let axis = 0; axis < REQUIRED_AXES; axis++) {
      const v = galFromCounts(row[axis], p)
      if (v === null) {
        return {
          ok: false,
          detail:
            `位置 ${i}・軸 ${axis}（${p.channels[axis]}）のカウント ${row[axis]}`
            + ` / 名乗る分解能 ${p.ugPerLsb} µg・フルスケール ${p.fullScaleG} g`,
        }
      }
      gal[axis][i] = v
    }
  }
  return { ok: true, gal }
}

export class IntensityPipeline {
  private readonly segmenter: Segmenter
  private readonly windowSec: number
  private readonly stepSec: number
  private readonly entries = new Map<string, Entry>()

  constructor(options: IntensityPipelineOptions = {}) {
    this.segmenter = new Segmenter({ maxStreams: options.maxStreams })
    this.windowSec = options.windowSec ?? WINDOW_SEC_DEFAULT
    this.stepSec = options.stepSec ?? STEP_SEC_DEFAULT
  }

  /** パケット 1 つを通す。**投げない** —— 起きたことは戻り値で返す。 */
  handlePacket(packet: SensorPacket): PacketOutcome {
    // **換算を組み立てより先に済ませる。** 順序を逆にすると、範囲の外で捨てるパケットを
    // 組み立てが受理してしまい、**あちらの位置だけが進む**。以後どのパケットも
    // 震度側の待っている位置と噛み合わず、その基板の震度が本物の切れ目まで出なくなる。
    const threeAxis = packet.channels.length === REQUIRED_AXES
    const converted = threeAxis ? toGal(packet) : null
    if (converted !== null && !converted.ok) {
      return { ...nothing(), dropped: 'scale-out-of-range', detail: converted.detail }
    }
    const gal = converted === null ? null : converted.gal

    const result = this.segmenter.accept(packet)
    if (!result.ok) return { ...nothing(), dropped: result.reason, detail: null }

    const readings: IntensityReading[] = []
    const closed: SegmentState[] = []
    const closeFailures: CloseFailure[] = []
    for (const c of result.closed) {
      closed.push(c)
      this.flush(c, readings, closeFailures)
    }

    const meta = result.segment.meta
    let skipped: IntensitySkipReason | null = null
    let skipDetail: string | null = null
    if (result.startedBecause !== null) {
      const created = this.createEntry(meta, threeAxis)
      this.entries.set(meta.streamKey, created)
      skipped = created.skip
      skipDetail = created.skipDetail
    }

    const entry = this.entries.get(meta.streamKey)
    if (entry === undefined || entry.stream === null || gal === null) {
      return {
        readings,
        closed,
        closeFailures,
        startedBecause: result.startedBecause,
        dropped: null,
        detail: skipDetail,
        intensitySkipped: skipped,
      }
    }

    try {
      for (const p of entry.stream.push(result.firstSampleIndex, gal[0], gal[1], gal[2])) {
        readings.push(toReading(meta, result.segment.timebase, p))
      }
    } catch (error) {
      // **組み立てと震度を 1 つの操作で閉じる。** 片方だけ作り直すと、あちらは区間が
      // 続いていると見なしたまま次のパケットに区間の途中の位置を名乗らせるので、
      // 0 から始まる新しい流れとは永久に噛み合わない（`../intensity/intensityStream.ts`
      // の `push` が書いている約束を、ここが実行する）。
      const forced = this.closeBoth(meta.streamKey, readings, closeFailures)
      if (forced !== null) closed.push(forced)
      return {
        readings,
        closed,
        closeFailures,
        startedBecause: result.startedBecause,
        dropped: 'stream-desync',
        detail: messageOf(error),
        intensitySkipped: skipped,
      }
    }

    return {
      readings,
      closed,
      closeFailures,
      startedBecause: result.startedBecause,
      dropped: null,
      detail: skipDetail,
      intensitySkipped: skipped,
    }
  }

  /** いま開いている区間。読み取りだけ。 */
  openSegments(): SegmentState[] {
    return this.segmenter.openSegments()
  }

  /**
   * 名指しの流れを閉じる。**組み立てと震度が 1 つの操作で閉じる唯一の口。**
   *
   * 片方だけ閉じると、組み立ては区間が続いていると見なしたまま次のパケットに
   * **区間の途中の位置**を名乗らせるので、0 から始まる新しい流し込みとは永久に
   * 噛み合わない —— その基板の震度が、本物の切れ目が来るまで出なくなる。
   * だから `Segmenter.closeStream` を直に呼ばず、必ずここを通すこと。
   */
  closeStream(streamKey: string): CloseResult & { closed: SegmentState | null } {
    const readings: IntensityReading[] = []
    const failures: CloseFailure[] = []
    const closed = this.closeBoth(streamKey, readings, failures)
    return { closed, readings, failures }
  }

  /**
   * すべて閉じ、残っている震度を出す。**終了時に呼ぶこと** ——
   * 呼ばないと、最後の窓ぶんの答えが出ないまま消える。
   *
   * **1 本の失敗で残りを道連れにしない。** 締めくくれなかった区間は `failures` に載せ、
   * 他の基板の最後の値は出し切る。
   */
  closeAll(): CloseResult {
    const readings: IntensityReading[] = []
    const failures: CloseFailure[] = []
    for (const state of this.segmenter.closeAll()) this.flush(state, readings, failures)
    // `flush` が消し残したものは無いはずだが、次に開けたとき古い流し込みを掴まないよう空にする。
    this.entries.clear()
    return { readings, failures }
  }

  /** 組み立てと震度を揃えて閉じる（#259 の本体）。閉じた区間を返す。 */
  private closeBoth(
    streamKey: string,
    out: IntensityReading[],
    failures: CloseFailure[],
  ): SegmentState | null {
    const state = this.segmenter.closeStream(streamKey)
    if (state === null) {
      this.entries.delete(streamKey)
      return null
    }
    this.flush(state, out, failures)
    return state
  }

  private createEntry(meta: SegmentMeta, threeAxis: boolean): Entry {
    if (!threeAxis) {
      return {
        stream: null,
        skip: 'axis-count',
        skipDetail: `軸が ${meta.channels.length} 本（${meta.channels.join('/')}）`,
      }
    }
    try {
      const stream = new IntensityStream({
        sampleRateHz: meta.sampleRateHz,
        windowSec: this.windowSec,
        stepSec: this.stepSec,
        demeanWindow: DEMEAN_WINDOW,
      })
      return { stream, skip: null, skipDetail: null }
    } catch (error) {
      // **1 台の名乗る周波数で受信口ごと落とさない。** 黙らせもしない —— 理由の文面まで
      // 返す（毎秒 1 回のような値を名乗られたときに、何が足りなかったのかがここにしか無い）。
      return { stream: null, skip: 'stream-rejected', skipDetail: messageOf(error) }
    }
  }

  /**
   * 閉じた区間の締めくくりを出し、覚えを捨てる。
   *
   * **投げない。** 呼び出し元は 3 つ（パケットの処理・`closeStream`・`closeAll`）で、
   * どれも例外を想定していない —— とくに `closeAll` は順に回すので、1 本が投げると
   * **残りの基板の最後の値が丸ごと消え、後片付けにも到達しない。**
   */
  private flush(state: SegmentState, out: IntensityReading[], failures: CloseFailure[]): void {
    const entry = this.entries.get(state.meta.streamKey)
    if (entry === undefined) return
    this.entries.delete(state.meta.streamKey)
    if (entry.stream === null) return
    try {
      for (const p of entry.stream.end()) out.push(toReading(state.meta, state.timebase, p))
    } catch (error) {
      failures.push({
        streamKey: state.meta.streamKey,
        segmentId: state.meta.segmentId,
        detail: messageOf(error),
      })
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toReading(meta: SegmentMeta, timebase: Timebase, point: IntensityPoint): IntensityReading {
  return {
    streamKey: meta.streamKey,
    segmentId: meta.segmentId,
    boardKey: meta.boardKey,
    sensorId: meta.sensorId,
    atMs: sampleTimeMs(timebase, point.endSampleIndex),
    intensity: point.intensity,
    timebaseNominalReason: timebase.nominalReason,
    timebaseResidualRmsMs: timebase.residualRmsMs,
  }
}
