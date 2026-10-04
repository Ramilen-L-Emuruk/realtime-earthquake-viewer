// 届いたサンプルを順に通して、リアルタイム震度を一定の刻みで出す。
//
// **計算そのものはここに無い。** 強震モニタと同じ方式（功刀ほか 2008・2013）はアプリ側の
// `src/utils/knet/realtimeIntensity.ts` が持っているので、それを呼ぶ。写し取れば
// 同じ数字が出るのは書いた日だけで、片方だけ直した日から静かに離れていく。
// ここが受け持つのは**区間の位置の突き合わせと、いつ答えを出すか**だけ。
//
// **答えは遅れずに出る。** 近似フィルタは届いた順に掛かる（未来のサンプルを見ない）ので、
// 刻みの位置まで届いた時点でその時刻の値が決まる。
//
// **値は最大に達してから約 60 秒下がらない。** 0.3 秒の判定を直近 60 秒で行う定義なので、
// 揺れが止んでも窓に残っている間は保たれる（強震モニタの見え方と同じ）。
//
// **1 本の区間につき 1 つ作る。** 区間が切れたら `end()` で締めて作り直すこと ——
// 途切れた前後を同じフィルタへ通すと、失われた時間が段差になって強い揺れとして出る
// （切れ目の見分け方は `../timebase/segmenter.ts`）。
import { RealtimeIntensityCalculator } from '../../../src/utils/knet/realtimeIntensity'
import { stepSamplesForSeconds } from '../../../src/utils/knet/intensityCommon'

export interface IntensityStreamOptions {
  readonly sampleRateHz: number
  /** 答えを出す間隔（秒）。 */
  readonly stepSec: number
}

export interface IntensityPoint {
  /** 区間の先頭から数えた、この値が代表する位置。時刻へ直すのは呼び出し側の仕事。 */
  readonly endSampleIndex: number
  /** 区間の先頭からの経過秒。 */
  readonly tSec: number
  /**
   * リアルタイム震度。**判定に足りるだけ溜まっていなければ null**（0.3 秒に満たない・
   * 代表値が 0 以下）。**「揺れていない」を意味する値ではない**ので、0 として扱わないこと。
   */
  readonly intensity: number | null
}

export class IntensityStream {
  private readonly sampleRateHz: number
  private readonly stepSamples: number
  private readonly calc: RealtimeIntensityCalculator
  /** 受け取ったサンプルの総数。 */
  private total = 0
  private ended = false

  /**
   * **作れないのはサンプリング周波数が低すぎるとき**（近似フィルタが発散する。約 77 Hz 未満）
   * と、刻みが正でないとき。呼び出し側はこの例外を「その区間では震度を出さない理由」として
   * 受け取る（`../receiver/intensityPipeline.ts` の `stream-rejected`）。
   */
  constructor(opts: IntensityStreamOptions) {
    if (!(opts.stepSec > 0)) throw new Error('stepSec は正の数で指定すること')
    this.sampleRateHz = opts.sampleRateHz
    // **丸め方はバッチ実装と共有する。** 刻みの位置が 1 サンプルずれるだけで値は似たままなので、
    // 書き写すと食い違いに気づけない。
    this.stepSamples = stepSamplesForSeconds(opts.stepSec, opts.sampleRateHz)
    this.calc = new RealtimeIntensityCalculator(opts.sampleRateHz)
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
   * 有限でない値・位置の飛び）。正しく換算した値がこうなることは無い —— 範囲の外は
   * `./units.ts` の `galFromCounts` が `null` として手前で落とす。
   *
   * **投げたときは何も通していない。** 受け取った中身を先に全部確かめてから触るので、
   * 成分ごとにフィルタの進み方がずれたまま残ることは無い。
   *
   * **投げたあと、同じ流れへ続きを渡してはいけない。** 渡さなかったサンプルの分だけ
   * 位置が実際より手前に留まるので、以後の答えは時刻のずれた値になる。
   *
   * **作り直すときは、組み立ての側の区間も一緒に閉じること**（`Segmenter.closeStream`）。
   * こちらを `end()` して作り直すだけだと、あちらは区間が続いていると見なしたまま
   * 次のパケットに**区間の途中の位置**を名乗らせるので、0 から始まる新しい流れとは
   * 永久に噛み合わない —— その基板の震度が、本物の切れ目が来るまで出なくなる。
   *
   * **その約束は文面ではなく位置で確かめる。** 区間が途切れたかどうかを決めるのは
   * 通し番号を見ている組み立ての側だけれど、**あちらはサンプルの中身を見ていない**ので、
   * ここで弾いたパケットを「連続」として受理してしまう。だから位置を突き合わせる
   * —— 飛ばして渡せばその場で止まる。**「以後いっさい受け付けない」という覚えは
   * 持たない**（止めた側にそれを解く手立てが無く、その基板の震度が黙って戻らなくなる）。
   *
   * **単位は gal。直流（重力）が乗ったままでよい** —— 最初のサンプルで差し引く
   * （`RealtimeIntensityCalculator` の説明）。**軸の並びは問わない** —— 合成は二乗和なので、
   * 向きが確定していない `HN1/HN2/HN3` をそのまま渡してよい。
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
    // **通す前に全部確かめる。** 途中まで通してから投げると、フィルタの状態がその途中で
    // 止まったまま残る —— 以後の答えは、捨てたはずのサンプルを含んだ値になる。
    for (let k = 0; k < a.length; k++) {
      for (const [axis, v] of [a[k], b[k], c[k]].entries()) {
        if (!Number.isFinite(v)) {
          throw new Error(`有限でないサンプルが混じっている: 位置 ${this.total + k}・軸 ${axis}`)
        }
      }
    }

    const points: IntensityPoint[] = []
    for (let k = 0; k < a.length; k++) {
      this.calc.push(a[k], b[k], c[k])
      this.total += 1
      if (this.total % this.stepSamples === 0) {
        points.push({
          endSampleIndex: this.total,
          tSec: this.total / this.sampleRateHz,
          intensity: this.calc.intensity(),
        })
      }
    }
    return points
  }

  /**
   * 区間の終わりを告げる。**出し残しは無い**（刻みの位置で必ず出しているので）。
   * 二度目以降も空を返す。以後の `push()` は誤用として止める。
   */
  end(): IntensityPoint[] {
    this.ended = true
    return []
  }
}
