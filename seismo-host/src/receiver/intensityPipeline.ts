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
import { applyCalibration } from './calibration'
import type { GalTriple } from './calibration'
import { StationDirectory } from './stationConfig'
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
  /** 観測点設定でそのセンサーが無効（`enabled: false`）にされている。 */
  | 'sensor-disabled'

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

/**
 * 1 パケットぶんの波形。**計測震度がまさに食べたサンプルそのもの。**
 *
 * 配るのは `toGal` を通した値で、生のカウント値ではない。生を配って受け手側で換算し直す
 * 形にすると**換算の経路が 2 本になり、片方だけずれても画面では気づけない**
 * （桁を取り違えても出てくる数字はそれらしい形をしている、という `../intensity/units.ts`
 * の警告がそのまま当てはまる）。
 *
 * **1 本に混ぜない。** 複数台を 1 つの波形へまとめるのは**このプログラムの別の層**の仕事で
 * （→ `../../REQUIREMENTS.md` §7）、そこでしかできない判断（どの流れを混ぜるか・
 * 時刻の格子をどう揃えるか・どれを基準器として扱うか）が要る。**混ぜれば精度が上がる
 * わけではない**ので、その判断ごと下流から奪わないこと。ここで潰すと、
 * 足音と地震を見分ける軸（振幅が空間的に揃っているか）も、換算の倍率の自己診断も、
 * どの 1 個が黙ったのかも、下流から永久に見えなくなる。
 */
export interface WaveChunk {
  readonly streamKey: string
  readonly segmentId: number
  readonly boardKey: BoardKey
  readonly sensorId: string
  /**
   * 軸の名前。`gal` の並びと 1 対 1。
   *
   * **読み取り専用。** 版 1 のパケットは全パケットが同じ配列を共有するので、
   * 1 箇所で書き換えるとプロセス内の全ストリームの軸名がまとめて壊れる
   * （`../protocol/types.ts` が型で禁じているのと同じ理由）。
   */
  readonly channels: readonly string[]
  /** 区間の先頭から数えた、このまとまりの最初のサンプルの位置。 */
  readonly firstSampleIndex: number
  /**
   * このまとまりの先頭サンプルの時刻（unix ミリ秒）。区間の当てはめから引く。
   *
   * **受け手に計算させない。** 位置と刻みから同じ値を出せるが、2 箇所で解くと
   * 片方だけずれる（`IntensityReading.atMs` と同じ分担）。
   */
  readonly firstSampleMs: number
  readonly msPerSample: number
  /**
   * 時刻の当てはめを公称値へ倒したなら理由。当てはめた値を使っていれば null。
   *
   * **倒したことを隠さない。** 倒れている間も波形そのものは正常な形で出続けるので、
   * ここで落とすと「時刻の根拠が崩れている波形」と健全な波形を下流から区別できない
   * （`IntensityReading.timebaseNominalReason` と同じ判断）。
   */
  readonly timebaseNominalReason: NominalReason | null
  /** gal。`gal[axis][i]` が `channels[axis]` の i 番目。 */
  readonly gal: readonly [readonly number[], readonly number[], readonly number[]]
}

/** 締めくくりを出せなかった区間。**その区間の最後の窓ぶんが失われている。** */
export interface CloseFailure {
  readonly streamKey: string
  readonly segmentId: number
  /**
   * どの基板のものか。
   *
   * **流れの鍵（`streamKey`）では代用できない。** あれには起動 ID まで入るので、
   * 基板ごとに数える側（`packetTally.ts`）から見ると同じ基板が再起動のたびに
   * 別の行に分かれる。記録の行も、どの基板が最後の窓ぶんを失ったのか読めなくなる。
   */
  readonly boardKey: BoardKey
  readonly sensorId: string
  readonly detail: string
}

/** 区間を閉じた結果。 */
export interface CloseResult {
  readonly readings: readonly IntensityReading[]
  readonly failures: readonly CloseFailure[]
}

/**
 * 震度を出せない区間と、その理由。
 *
 * **理由と区間を組で持つ。** 同じパケットの `readings` には**畳み直した旧区間の
 * 締めくくり**が入ることがある（区間の再開は前の区間を閉じるので、末尾に溜まっていた
 * 窓がそこで吐き出される）。受け取る側から見ると「震度が出ない理由」と「たった今出た
 * 震度」が同時に届くので、どちらが新しいかは区間の名指しでしか決まらない。
 *
 * **別々の欄に分けない。** 分けると渡し忘れても型検査が通り、症状は
 * 「壊れたセンサーが健全に見える」だけなので気づく機会が無い。
 */
export interface IntensitySkip {
  readonly reason: IntensitySkipReason
  readonly streamKey: string
  readonly segmentId: number
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
  /** 始まった区間で震度を出せないなら、理由とその区間。区間が始まった回にだけ入る。 */
  readonly intensitySkipped: IntensitySkip | null
  /**
   * このパケットの波形。**組み立てが受理して換算も通った回にだけ入る。**
   *
   * 落としたパケット（`dropped` が非 null かつ組み立てに届いていない回）と、
   * 3 成分でないパケットでは null。**区間を畳み直した回（`stream-desync`）でも入る**
   * —— サンプルそのものは本物で、どの区間のどの位置かも `WaveChunk` が名乗るので、
   * 受け手は切れ目を見分けられる。いちばん様子を見たい状態で波形だけ黙るほうが困る。
   */
  readonly wave: WaveChunk | null
  /**
   * `wave` と同じサンプルの、**校正（`calibration.ts`）を掛ける前の値**（gal）。`wave` が
   * null の回は null。
   *
   * **校正値そのものを測る**ためにある（6 面法・`gravityCheck.ts` の静止窓）。校正後の
   * 値から逆算すると、窓の途中で設定が替わったときに古い校正と新しい校正が混ざる。
   *
   * **`WaveChunk` へは入れない。** 押し出しの口は波形のまとまりを丸ごと配るので、
   * 入れると誰も使わない値で通信量が倍になる。写しは取らない（`toGal` の出力そのもの）。
   */
  readonly uncalibratedGal: GalTriple | null
}

export interface IntensityPipelineOptions {
  /** 1 回の計算で見る長さ（秒）。 */
  readonly windowSec?: number
  /** 答えを出す間隔（秒）。 */
  readonly stepSec?: number
  /** 同時に覚えておく流れの数の上限。`Segmenter` へそのまま渡す。 */
  readonly maxStreams?: number
  /**
   * センサー校正の引き当て先（REQUIREMENTS.md §16）。**省略時は空**
   * （`StationDirectory.empty()`）—— 割り当てが無くても震度算出は止めない
   * （`stationConfig.ts` の設計原則）。
   */
  readonly stations?: StationDirectory
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
  return {
    readings: [],
    closed: [],
    closeFailures: [],
    startedBecause: null,
    intensitySkipped: null,
    wave: null,
    uncalibratedGal: null,
  }
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
  /**
   * **`readonly` を持たせない。** `/api/*`（#313 段 B）が観測点設定を書き換えたとき、
   * 実行中のこのインスタンスへ `updateStations()` で差し替える —— ここは
   * `resolveSensor()` を都度呼ぶだけで内部にストリーム状態を紐付けていないので、
   * 差し替えても進行中の区間組み立てには影響しない（次に届くパケットから新しい
   * 校正値・観測点割当が効く）。
   */
  private stations: StationDirectory
  private readonly entries = new Map<string, Entry>()
  private unusableCount = 0
  /** `toReading` から呼ぶ。**束縛済みにしておく** —— 渡すたびに包むと同じ関数が増える。 */
  private readonly noteUnusable = (): void => {
    this.unusableCount++
  }

  constructor(options: IntensityPipelineOptions = {}) {
    this.segmenter = new Segmenter({ maxStreams: options.maxStreams })
    this.windowSec = options.windowSec ?? WINDOW_SEC_DEFAULT
    this.stepSec = options.stepSec ?? STEP_SEC_DEFAULT
    this.stations = options.stations ?? StationDirectory.empty()
  }

  /**
   * 観測点設定を実行時に差し替える（`/api/*` の書き込みが呼ぶ。#313 段 B）。
   *
   * **進行中の区間組み立ては打ち切らない。** `Segmenter` はセンサー校正の値を知らないので
   * 影響を受けず、次に届くパケットから `handlePacket` が新しい `stations` を見る。
   */
  updateStations(stations: StationDirectory): void {
    this.stations = stations
  }

  /** パケット 1 つを通す。**投げない** —— 起きたことは戻り値で返す。 */
  handlePacket(packet: SensorPacket): PacketOutcome {
    // **無効センサーは換算より前で弾く。** §15 の「有効/無効」を読み取りへ反映しないと、
    // 設定した意味が無い。組み立て（`Segmenter`）にも渡さない —— 使わないと決めた
    // センサーのパケットを時間軸の統計に混ぜる理由が無い。
    const calibration = this.stations.resolveSensor(packet.boardKey, packet.sensorId)
    if (!calibration.enabled) {
      return { ...nothing(), dropped: 'sensor-disabled', detail: null }
    }

    // **換算を組み立てより先に済ませる。** 順序を逆にすると、範囲の外で捨てるパケットを
    // 組み立てが受理してしまい、**あちらの位置だけが進む**。以後どのパケットも
    // 震度側の待っている位置と噛み合わず、その基板の震度が本物の切れ目まで出なくなる。
    const threeAxis = packet.channels.length === REQUIRED_AXES
    const converted = threeAxis ? toGal(packet) : null
    if (converted !== null && !converted.ok) {
      return { ...nothing(), dropped: 'scale-out-of-range', detail: converted.detail }
    }
    // **校正（REQUIREMENTS.md §16）は換算のすぐ後、組み立てより前に適用する。**
    // `toGal` のフルスケール判定はセンサー自身の生の妥当性チェックで、校正（観測点固有の
    // 後処理）とは別の関心事 —— 順序を分けておく。
    const gal = converted === null ? null : applyCalibration(converted.gal, calibration)

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

    // **組み立てが受理して換算も通った回にだけ作る。** 落としたパケットの波形を配ると、
    // 計測震度が見ていないサンプルが画面に出る（受け手はそれを区別できない）。
    //
    // **配るのは震度へ流し込むのと同じ配列そのもの（校正適用後）で、以後は写しを取らない。**
    // 二重にコピーすると毎秒 2,700 個ぶんの複製が常時走るうえ、**「計測震度が食べた値
    // そのもの」という保証が写した瞬間に 1 段弱くなる**（写し損ねても値の形は変わらない
    // ので気づけない）。型は読み取り専用にしてあり、この先で `gal` を書き換える処理は無い。
    const timebase = result.segment.timebase
    const wave: WaveChunk | null =
      gal === null
        ? null
        : {
            streamKey: meta.streamKey,
            segmentId: meta.segmentId,
            boardKey: meta.boardKey,
            sensorId: meta.sensorId,
            channels: meta.channels,
            firstSampleIndex: result.firstSampleIndex,
            firstSampleMs: sampleTimeMs(timebase, result.firstSampleIndex),
            msPerSample: timebase.msPerSample,
            timebaseNominalReason: timebase.nominalReason,
            gal,
          }
    // **`wave` と同じ回にだけ出す。** 校正前の値だけが残ると、組み立てに落とされた
    // パケットのサンプルが静止窓へ入る（`wave` を作らない理由と同じ）。
    const uncalibratedGal: GalTriple | null = wave === null || converted === null ? null : converted.gal

    let skipped: IntensitySkip | null = null
    let skipDetail: string | null = null
    if (result.startedBecause !== null) {
      const created = this.createEntry(meta, threeAxis)
      this.entries.set(meta.streamKey, created)
      skipped =
        created.skip === null
          ? null
          : { reason: created.skip, streamKey: meta.streamKey, segmentId: meta.segmentId }
      skipDetail = created.skipDetail
    }

    const entry = this.entries.get(meta.streamKey)
    if (entry === undefined) {
      // **起きないはずの食い違い。** 組み立ては「区間が続いている」と言っているのに、
      // 震度側の入れ物が無い。黙って通すと、その流れの震度は以後どこにも現れないのに
      // **理由がどこにも残らない**（`dropped` も `intensitySkipped` も null で返るので、
      // 上の層から見ると「何も起きなかった」パケットと見分けが付かない）。
      //
      // 位置が噛み合わなくなったのと同じ事態なので、手当ても同じ ——
      // 両方を揃えて閉じ、次のパケットから作り直させる。
      const forced = this.closeBoth(meta.streamKey, readings, closeFailures)
      if (forced !== null) closed.push(forced)
      return {
        readings,
        closed,
        closeFailures,
        startedBecause: result.startedBecause,
        dropped: 'stream-desync',
        detail: `流し込みの入れ物が見つからない（${meta.streamKey}）`,
        intensitySkipped: skipped,
        wave,
        uncalibratedGal,
      }
    }
    if (entry.stream === null || gal === null) {
      return {
        readings,
        closed,
        closeFailures,
        startedBecause: result.startedBecause,
        dropped: null,
        detail: skipDetail,
        intensitySkipped: skipped,
        wave,
        uncalibratedGal,
      }
    }

    try {
      for (const p of entry.stream.push(result.firstSampleIndex, gal[0], gal[1], gal[2])) {
        readings.push(toReading(meta, result.segment.timebase, p, this.noteUnusable))
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
        wave,
        uncalibratedGal,
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
      wave,
      uncalibratedGal,
    }
  }

  /**
   * 数として出せない計測震度を見た回数。
   *
   * **0 が正常。** 増えているなら、そのセンサーは値を返しているのに中身が計算に
   * ならない（全サンプルが厳密に 0 等）。状態の口に出す。
   */
  get unusableIntensities(): number {
    return this.unusableCount
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
      for (const p of entry.stream.end()) {
        out.push(toReading(state.meta, state.timebase, p, this.noteUnusable))
      }
    } catch (error) {
      failures.push({
        streamKey: state.meta.streamKey,
        segmentId: state.meta.segmentId,
        boardKey: state.meta.boardKey,
        sensorId: state.meta.sensorId,
        detail: messageOf(error),
      })
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 計測震度が数として出せない値なら `null` へ倒す。
 *
 * **`IntensityReading.intensity` の約束は「窓の中身が足りなければ null」**で、
 * 非有限はその約束の外。
 *
 * **いまの上流はここへ非有限を渡さない。** `I = 2·log₁₀(a) + 0.94` は `a` が 0 のとき
 * −∞ を返すが、`calcSeismicIntensityFromSynthesized` が `if (!(a > 0)) return null` で
 * 先に弾いている（`../../../src/utils/knet/seismicIntensity.ts`）。**この関数はその境界が
 * 緩んだときに気づくための番人**で、`unusableIntensities` が 0 でなくなることが合図。
 * 0 のままなのが正常。
 *
 * **倒さないと、黙って「窓が足りない」に化ける。** `JSON.stringify` は −∞ も `null`
 * にするので、状態の口でも押し出しの口でも受け手には同じに見える。倒したうえで
 * 数えるので、件数は状態の口と締めくくりに出る。
 */
export function normalizeIntensity(v: number | null): { value: number | null; unusable: boolean } {
  if (v === null) return { value: null, unusable: false }
  if (!Number.isFinite(v)) return { value: null, unusable: true }
  return { value: v, unusable: false }
}

function toReading(
  meta: SegmentMeta,
  timebase: Timebase,
  point: IntensityPoint,
  onUnusable: () => void,
): IntensityReading {
  const normalized = normalizeIntensity(point.intensity)
  if (normalized.unusable) onUnusable()
  return {
    streamKey: meta.streamKey,
    segmentId: meta.segmentId,
    boardKey: meta.boardKey,
    sensorId: meta.sensorId,
    atMs: sampleTimeMs(timebase, point.endSampleIndex),
    intensity: normalized.value,
    timebaseNominalReason: timebase.nominalReason,
    timebaseResidualRmsMs: timebase.residualRmsMs,
  }
}
