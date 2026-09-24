// 届いたサンプルを溜めて、計測震度相当を一定の刻みで出す。
//
// **計算そのものはここに無い。** 気象庁の算出手順はアプリ側の
// `src/utils/knet/seismicIntensity.ts` が既に持っているので、それを呼ぶ。写し取れば
// 同じ数字が出るのは書いた日だけで、片方だけ直した日から静かに離れていく。
// ここが受け持つのは**どの範囲をいつ渡すか**だけ。
//
// **答えは 2 秒遅れて出る。** 周期補正のフィルタは FFT で掛かるので、切り出した窓の
// 両端は精度が落ちる。報告したい時刻をその劣化域から遠ざけるため、解析する範囲の
// 終わりを報告時刻より先まで伸ばしてある（`EDGE_MARGIN_SEC`）。伸ばした先の
// サンプルが届くまで、その時刻の値は出せない。
//
// **1 本の区間につき 1 つ作る。** 区間が切れたら `end()` で締めて作り直すこと ——
// 途切れた前後を同じ窓へ入れると、失われた時間が段差になって強い揺れとして出る
// （切れ目の見分け方は `../timebase/segmenter.ts`）。
import {
  DURATION_THRESHOLD_SEC,
  EDGE_MARGIN_SEC,
  durationThresholdIndex,
  calcSeismicIntensity,
  samplesForSeconds,
  stepSamplesForSeconds,
} from '../../../src/utils/knet/seismicIntensity'

/** 報告時刻より先まで解析する秒数。**この分だけ答えが遅れる。** */
export { EDGE_MARGIN_SEC }

export interface IntensityStreamOptions {
  readonly sampleRateHz: number
  /** 1 回の計算で見るサンプルの長さ（秒）。短いほど追従が速く、長いほど落ち着く。 */
  readonly windowSec: number
  /** 答えを出す間隔（秒）。 */
  readonly stepSec: number
  /**
   * 窓ごとに平均を引くか。**既定値は置かない** —— 通す側に選ばせる。
   *
   * `false` はバッチ実装（`computeIntensityTimeSeries`）と同じ値を返す。あちらの
   * 入力は基準線を補正済みの K-NET 波形で、直流成分が無いことが前提になっている。
   *
   * 自作センサーの生の値には重力がそのまま乗る（机に置いた基板で約 1009 gal）。
   * フィルタは 0 Hz のゲインを 0 にするけれど、FFT のために 2 の冪までゼロで埋めるので、
   * **直流の載った区間とゼロの区間の境目が段差になって低い周波数へ漏れる。**
   * 静止した基板の実測で、引かなければ 4.48〜6.23、引けば 0.79〜1.26 になった。
   */
  readonly demeanWindow: boolean
}

export interface IntensityPoint {
  /** 区間の先頭から数えた、この値が代表する位置。時刻へ直すのは呼び出し側の仕事。 */
  readonly endSampleIndex: number
  /** 区間の先頭からの経過秒。 */
  readonly tSec: number
  /**
   * 計測震度相当。**窓の中身が足りないと null**（0.3 秒ぶんに満たない・代表値が 0 以下）。
   * **「揺れていない」を意味する値ではない**ので、0 として扱わないこと。
   */
  readonly intensity: number | null
}

/**
 * 直近のサンプルだけを持つ入れ物。
 *
 * **持つのは窓 1 つ分でよい。** 報告できるのは「解析の終わりまで届いた」時点なので、
 * そのとき必要な範囲は必ず最新側に寄っている（`push` が刻んで渡すのはこのため）。
 */
class RecentSamples {
  private readonly buf: Float64Array
  private next = 0
  private filled = 0

  constructor(capacity: number) {
    this.buf = new Float64Array(capacity)
  }

  add(v: number): void {
    this.buf[this.next] = v
    this.next = (this.next + 1) % this.buf.length
    if (this.filled < this.buf.length) this.filled += 1
  }

  /** 新しいほうから `count` 個を、古い順に並べて返す。 */
  tail(count: number): number[] {
    if (count > this.filled) {
      // **溜まっていない分を読ませない。** 初期値は 0 なので、通せば「0 gal のサンプル」が
      // 実データに混ざり、例外もログも出ないまま揺れを小さく見せる。
      throw new Error(`溜まっている ${this.filled} 個より多い ${count} 個を求められた`)
    }
    const cap = this.buf.length
    const out = new Array<number>(count)
    let idx = (((this.next - count) % cap) + cap) % cap
    for (let i = 0; i < count; i++) {
      out[i] = this.buf[idx]
      idx = idx + 1 === cap ? 0 : idx + 1
    }
    return out
  }
}

function subtractMean(values: number[]): number[] {
  if (values.length === 0) return values
  let sum = 0
  for (const v of values) sum += v
  const mean = sum / values.length
  return values.map((v) => v - mean)
}

export class IntensityStream {
  private readonly sampleRateHz: number
  private readonly windowSamples: number
  private readonly stepSamples: number
  private readonly marginSamples: number
  private readonly demeanWindow: boolean

  private readonly ch: readonly [RecentSamples, RecentSamples, RecentSamples]
  /** 受け取ったサンプルの総数。 */
  private total = 0
  /** 次に答えを出す位置。 */
  private nextEnd: number
  private ended = false

  constructor(opts: IntensityStreamOptions) {
    if (!(opts.sampleRateHz > 0)) throw new Error('sampleRateHz は正の数で指定すること')
    if (!(opts.windowSec > 0)) throw new Error('windowSec は正の数で指定すること')
    if (!(opts.stepSec > 0)) throw new Error('stepSec は正の数で指定すること')

    this.sampleRateHz = opts.sampleRateHz
    // **丸め方はバッチ実装と共有する。** ここへ式を書き写すと、片方だけ変えた日から
    // 答えが静かに離れる（窓の端が 1 サンプルずれるだけなので、値は似たまま）。
    this.windowSamples = samplesForSeconds(opts.windowSec, opts.sampleRateHz)
    this.stepSamples = stepSamplesForSeconds(opts.stepSec, opts.sampleRateHz)
    this.marginSamples = samplesForSeconds(EDGE_MARGIN_SEC, opts.sampleRateHz)
    this.demeanWindow = opts.demeanWindow

    // **窓は 0.3 秒を覆うこと。** 気象庁の式は「ある値以上だった時間の合計が 0.3 秒」を
    // 探すので、それに満たない窓では答えが**恒久的に** null になる。先読み待ちで
    // まだ答えが無い状態と見分けが付かないので、作る時点で止める。
    // **下限は計算核と同じ境界から引く** —— 同じことを別の式で書くと、サンプリング
    // 周波数によって片方だけ 1 ずれる（毎秒 101 回で実際に分かれた）。
    const minSamples = durationThresholdIndex(opts.sampleRateHz) + 1
    if (this.windowSamples < minSamples) {
      throw new Error(
        `windowSec が短すぎる（${DURATION_THRESHOLD_SEC} 秒 = ${minSamples} サンプルを覆えない）`,
      )
    }
    this.ch = [
      new RecentSamples(this.windowSamples),
      new RecentSamples(this.windowSamples),
      new RecentSamples(this.windowSamples),
    ]
    this.nextEnd = this.stepSamples
  }

  /** 受け取ったサンプルの総数。 */
  get sampleCount(): number {
    return this.total
  }

  /**
   * 3 成分を同じ長さで渡す。出せるようになった答えを返す（無ければ空）。
   *
   * `firstSampleIndex` は**区間の先頭から数えた、このひと組の最初の位置**。
   * `../timebase/segmenter.ts` が受理したパケットについて返す値をそのまま渡すこと。
   *
   * 投げるのは**呼び出し側の誤り**に対してだけ（長さの食い違い・締めたあとの呼び出し・
   * 有限でない値）。正しく換算した値がこうなることは無い —— 範囲の外は `./units.ts` の
   * `galFromCounts` が `null` として手前で落とす。
   *
   * **投げたときは何も溜め込んでいない。** 受け取った中身を先に全部確かめてから触るので、
   * 成分ごとに溜まった数がずれたまま残ることは無い。
   *
   * **投げたあと、同じ流れへ続きを渡してはいけない。** 渡さなかったサンプルの分だけ
   * 位置が実際より手前に留まるので、以後の答えは時刻のずれた値になる。
   *
   * **作り直すときは、組み立ての側の区間も一緒に閉じること**（`Segmenter.closeStream`）。
   * こちらを `end()` して作り直すだけだと、あちらは区間が続いていると見なしたまま
   * 次のパケットに**区間の途中の位置**を名乗らせるので、0 から始まる新しい流れとは
   * 永久に噛み合わない —— その基板の震度が、本物の切れ目が来るまで出なくなる。
   * **両方を 1 つの操作で閉じる配線は段 4 の担当。**
   *
   * **その約束は文面ではなく位置で確かめる。** 区間が途切れたかどうかを決めるのは
   * 通し番号を見ている組み立ての側だけれど、**あちらはサンプルの中身を見ていない**ので、
   * ここで弾いたパケットを「連続」として受理してしまう。だから位置を突き合わせる
   * —— 飛ばして渡せばその場で止まる。**「以後いっさい受け付けない」という覚えは
   * 持たない**（止めた側にそれを解く手立てが無く、その基板の震度が黙って戻らなくなる）。
   *
   * **単位は gal。** カウント値からの換算は `./units.ts` の `galFromCounts`。
   * **軸の並びは問わない** —— 合成は二乗和なので、向きが確定していない
   * `HN1/HN2/HN3` をそのまま渡してよい。
   */
  push(
    firstSampleIndex: number,
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
  ): IntensityPoint[] {
    if (this.ended) throw new Error('end() のあとに push() は呼べない')
    if (firstSampleIndex !== this.total) {
      // 飛んでいれば時間に穴が開いている。詰めて繋ぐと、失われた時間が段差になって
      // 強い揺れとして出る（`../timebase/segmenter.ts` が区間を繋がない理由と同じ）。
      throw new Error(
        `渡された位置が続きになっていない: ${firstSampleIndex}（待っているのは ${this.total}）`,
      )
    }
    if (a.length !== b.length || b.length !== c.length) {
      // **切り詰めない。** 長さが食い違ったまま受けると 3 成分の位置がずれ、
      // 以降のサンプルがすべて別の時刻の値と合成される。
      throw new Error(`3 成分の長さが揃っていない: ${a.length}/${b.length}/${c.length}`)
    }
    // **溜める前に全部確かめる。** 途中まで入れてから投げると、成分ごとに溜まった数が
    // ずれたまま残る —— そして窓が埋まれば件数は上限で揃うので、**以後どの検査にも
    // 掛からないまま、別の時刻の値どうしを合成し続ける**。
    for (let k = 0; k < a.length; k++) {
      for (const [axis, v] of [a[k], b[k], c[k]].entries()) {
        // 正しく換算した値がこうなることは無いので、呼び出し側の誤りとして止める
        // （範囲の外の値は `./units.ts` の `galFromCounts` が手前で落とす）。
        if (!Number.isFinite(v)) {
          throw new Error(`有限でないサンプルが混じっている: 位置 ${this.total + k}・軸 ${axis}`)
        }
      }
    }

    const points: IntensityPoint[] = []
    let i = 0
    while (i < a.length) {
      // 次に答えを出せるのは、解析の終わり（報告位置 + 先読み）まで届いたとき。
      // そこまでを刻んで入れることで、入れ物は窓 1 つ分で足りる。
      const need = this.nextEnd + this.marginSamples - this.total
      const take = Math.min(a.length - i, need)
      for (let k = 0; k < take; k++) {
        this.ch[0].add(a[i + k])
        this.ch[1].add(b[i + k])
        this.ch[2].add(c[i + k])
      }
      this.total += take
      i += take
      if (take === need) {
        points.push(this.emit(this.total))
        this.nextEnd += this.stepSamples
      }
    }
    return points
  }

  /**
   * 区間の終わりを告げ、残りの答えを出す。
   *
   * **末尾では先読みが足りない。** バッチ実装は記録の末尾で解析範囲を記録の長さまでで
   * 打ち切るので、ここも同じように縮める。二度目以降は空を返す。
   */
  end(): IntensityPoint[] {
    if (this.ended) return []
    this.ended = true
    const points: IntensityPoint[] = []
    while (this.nextEnd <= this.total) {
      // ここへ残るのは先読みが届かなかった分だけなので、解析の終わりは必ず末尾になる
      // （`push` が「届いた時点で出す」形なので、出せるものは 1 つも残っていない）。
      points.push(this.emit(this.total))
      this.nextEnd += this.stepSamples
    }
    return points
  }

  private emit(analysisEnd: number): IntensityPoint {
    const start = Math.max(0, analysisEnd - this.windowSamples)
    const count = analysisEnd - start
    const slice = (r: RecentSamples): number[] => {
      const values = r.tail(count)
      return this.demeanWindow ? subtractMean(values) : values
    }
    const intensity = calcSeismicIntensity(
      slice(this.ch[0]),
      slice(this.ch[1]),
      slice(this.ch[2]),
      this.sampleRateHz,
    )
    return {
      endSampleIndex: this.nextEnd,
      tSec: this.nextEnd / this.sampleRateHz,
      intensity,
    }
  }
}
