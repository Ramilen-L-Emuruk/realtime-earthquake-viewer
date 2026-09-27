// 静止しているときに成り立つはずのことを突き合わせて、換算の配線を自分で診る。
//
// **1 件ずつの検査では届かない穴がある。** `../intensity/units.ts` の `galFromCounts` は
// センサーが名乗るフルスケールの**上限**しか見ないので、桁が大きすぎる向き（静止した基板が
// 強い揺れとして出る）は捕まるが、**小さすぎる向きは素通りする** —— 本物の強い揺れが
// 弱く出るほうで、しかも出てくる値はすべて有限で範囲内なので、どの検査にも掛からない。
//
// 同じ形の穴が `../intensity/intensityStream.ts` の `demeanWindow` にもある。自作センサーへ
// `false` を誤って渡すと、静止していても計測震度 4.48〜6.23 が出続ける（実測）。
//
// **どちらも「1 パケットの中」を見ても判らない。** 判るのは、**静止している数十秒**を
// まとめて見たときだけ。だからここは受信層に置く。
//
// 使うのは型番に依らない 2 つの事実:
//
// 1. **静止した基板の 3 軸合成は約 980 gal（1 g）。** 傾けても大きさは変わらないので、
//    設置の向きを問わない。倍率が 1000 分の 1 なら 0.98 gal、レンジを 2 倍に取り違えれば
//    1961 gal になる
// 2. **合成のばらつきが小さいなら、計測震度も低いはず。** 揺れていないのに高い震度が
//    出続けるなら、震度を出す側の配線が疑わしい
//
// **震度は止めない。** ここが異常を指しても値は出し続け、数えて報せるだけ ——
// 桁の狂った値より「震度が黙る」ほうが重い。

import { GAL_PER_G } from '../intensity/units'
import type { BoardKey } from '../protocol/types'

/**
 * 窓の長さ。**受け手の時計で測る。**
 *
 * 基板が名乗る時刻を使わない —— 診断したいものの中にヘッダの名乗りが含まれているのに、
 * 窓を区切る根拠まで同じ名乗りに預けることになる（`sensorHealth.ts` と同じ判断）。
 */
const WINDOW_MS_DEFAULT = 30_000

/**
 * 判定に要る最低のサンプル数。
 *
 * **1 パケットだけの窓で判定しないための下限。** 手元の記録では 1 パケットがおよそ
 * 33 サンプル（100 Hz・毎秒 3 パケット前後）なので、200 は 6 パケット＝約 2 秒ぶん。
 * 30 秒の窓が本来抱える 3,000 サンプルに対しては 15 分の 1 で、**ここへ掛かるのは
 * 9 割以上を落としている状態**。その事態は `packetTally.ts` が別に数えている。
 */
const MIN_SAMPLES_DEFAULT = 200

/**
 * 覚えていられるセンサーの数。
 *
 * `sensorHealth.ts` と同じ値・同じ鍵の作り（起動 ID を含めない）。**あちらが覚えられる
 * ものは必ずここにも収まる**、という関係が根拠で、値が一致していること自体に意味はない。
 */
const MAX_SENSORS_DEFAULT = 64

/**
 * 1 g から何倍まで離れるのを許すか（両向き）。
 *
 * **見るのは桁だけ。** 合成の平均は倍率の誤りだけでなく**センサーごとの 0 点のずれ**でも
 * 動くので、狭めると個体差が警告に化ける ——
 * 手元の MPU6050 9 個の実測（静止・90 秒）は **0.670〜1.232 g** で、
 * `ugPerLsb` はどれも 61.0352 と同じ値を名乗っていた。ずれていたのは**上下軸の平均だけ**
 * （657〜1208 gal。水平は -111〜+42 gal）で、**軸ごとのばらつきは 9 個とも
 * 1.06〜1.86 gal に揃っている** —— 倍率が k 倍狂えばばらつきも k 倍になるはずなので、
 * これは倍率ではなく 0 点と感度の個体差。
 *
 * この幅で捕まるのは 1000 分の 1・10 分の 1 といった**桁の誤り**。
 * **レンジの 2 倍の取り違えは捕まらない** —— 上の個体差（最大 1.232 倍）と重なるので、
 * 捕まえにいくと正常な個体を毎分警告することになる。
 *
 * **大きすぎる向きは、名乗るフルスケールも一緒に大きくなければここへ届かない。**
 * 静止時の合成は重力が乗る 1 軸でほぼ決まるので、±2 g を名乗ったまま倍率だけ k 倍に
 * 狂った値は `../intensity/units.ts` の上限検査（2 × 980.665 × 1.05 ＝ 2059.4 gal）が
 * **k ≒ 2.1 で先に落とす** —— 一方この幅に掛かるのは k > 3 なので、両立しない。
 * 届くのは分解能とフルスケールをそろえて大きく名乗った場合（±8 g・4 倍なら
 * 合成 3922.7 gal が上限検査 8237.6 gal を通り、ここで捕まる）。
 *
 * **この整理は `../receiver/calibration.ts` の校正（§16）を経由する前の値についてのもの。**
 * ここが実際に受け取るのは校正適用後の `gal`（`intensityPipeline.ts` が `WaveChunk` へ
 * 積むのと同じ配列）で、`units.ts` の上限検査は校正**前**にしか掛からない。校正の
 * `sensitivity` を極端に小さく設定すれば、本来なら上限検査で捕まるはずの倍率の狂いが
 * 校正で縮められ、ここへは正常な大きさで届いてしまいうる —— **校正の設定ミスまでは
 * この自己診断の対象外**（`sensitivity` は `stationConfig.ts` で正数であることしか
 * 検証していない）。
 */
const SCALE_RATIO_MAX = 3

/**
 * 静止とみなす、合成のばらつきの上限（gal）。
 *
 * 手元の MPU6050 9 個の実測（静止・30 秒の窓）で合成のばらつきは **1.39〜1.57 gal**
 * だったので、その 3 倍の余裕。気象庁震度階級でいえば震度 2 の上端あたり。
 */
const REST_SD_GAL = 5

/**
 * 静止しているときに許す計測震度の上限。
 *
 * 静止した基板の実測が 0.79〜1.26、`demeanWindow` を誤って切ったときの実測が
 * 4.48〜6.23。**その間に置く。**
 */
const REST_MAX_INTENSITY = 3

/**
 * 倍率の診断の結果。
 *
 * **「異常」と「判定できなかった」を別の値にする。** 混ぜると、揺れていて見送った窓と
 * 倍率が狂っている窓が同じ数に化け、地震のたびに異常の件数が跳ねる。
 */
export type ScaleVerdict =
  /** 1 g の前後に収まっていた。 */
  | 'ok'
  /** 小さすぎる。**上限の検査では捕まらない向き。** */
  | 'too-small'
  /** 大きすぎる。**フルスケールの申告ごと大きく名乗っている疑い**（そうでなければ手前で落ちる）。 */
  | 'too-large'
  /**
   * 揺れていたので見送った。
   *
   * **地震のときに誤って警告しないための門。** 合成の平均は揺れで必ず上がる
   * （水平に 1000 gal の正弦波が乗れば 30 秒平均で 1200 gal ＝ 2 割増）ので、
   * 静止を確かめずに判定すると**いちばん見たい瞬間に**「倍率が大きすぎる」と言い出す。
   *
   * **現実の誤配線はどれも静止側へ倒れる**ので、この門で取り逃がすものは無い ——
   * 倍率が小さければノイズも同じだけ小さくなり、大きすぎる向きは手前の上限の検査が
   * パケットごと落とすためここへ届かない。
   */
  | 'not-at-rest'
  /** サンプルが足りず、正常とも異常とも言えなかった。 */
  | 'too-few-samples'
  /** 数値として読めない値が混ざっていた。 */
  | 'unreadable'

/** 窓 1 つぶんの診断。 */
export interface GravityVerdict {
  readonly boardKey: BoardKey
  readonly sensorId: string
  /** 判定した窓を運んできた流れ。 */
  readonly streamKey: string
  /** 判定を確定した時刻（受け手の時計）。**古い判定を見分けるために出す。** */
  readonly atMs: number
  readonly sampleCount: number
  /** 3 軸合成の平均（gal）。読めなければ null。 */
  readonly meanGal: number | null
  /** 3 軸合成のばらつき（gal）。読めなければ null。 */
  readonly sdGal: number | null
  /** 窓の中で見た計測震度の最大。1 つも出ていなければ null。 */
  readonly maxIntensity: number | null
  readonly scale: ScaleVerdict
  /**
   * 静止しているのに震度が高い。
   *
   * **`scale` とは別の事実。** あちらは換算の倍率、こちらは震度を出す側の配線
   * （平均引きの有無）。倍率が正しくてもこちらだけ立つことがある。
   */
  readonly restless: boolean
}

/**
 * 数え上げる出来事。**足すならここへ 1 行。**
 *
 * **この帳面は「数を 1 つ足したのに、出す先の 1 つへ書き忘れる」を 4 巡続けた。**
 * 場所が散っていたのが根で、私有の欄・読み出しの口・状態の口・要約・締めくくりと
 * 5 つ以上へ同じ名前を書いていた。ここを唯一の名簿にして、残りは全部この型から
 * 導く（見出しの対応表は `../../main.ts` が `Record<GravityCount, string>` で持つので、
 * **足して書き忘れれば型検査が止める**）。
 */
export type GravityCount =
  | 'mismatches'
  | 'unjudged'
  | 'restlessWindows'
  | 'restarts'
  | 'evictions'

/** 数え上げだけを集めたもの。 */
export type GravityCounts = Record<GravityCount, number>

/**
 * 帳面のいまの様子。**状態の口と要約が同じものを見る。**
 *
 * 数はすべて起動してからの累計で、**`verdicts` だけが「いまの姿」**（センサーごとに
 * 最後に閉じた窓 1 つぶん）。両方要る —— 単発で起きて自分で直った異常は次の窓で
 * `verdicts` から消えるので、**累計が無いと起きたこと自体が残らない**。
 */
export interface GravityCheckSnapshot extends Readonly<GravityCounts> {
  readonly verdicts: readonly GravityVerdict[]
}

export interface GravityCheckBookOptions {
  readonly windowMs?: number
  readonly minSamples?: number
  readonly maxSensors?: number
  /** 時計。テストのために差し替える。 */
  readonly now?: () => number
}

interface Entry {
  readonly boardKey: BoardKey
  readonly sensorId: string
  streamKey: string
  windowStartMs: number
  /** 合成の走和。**窓のサンプルは溜めない** —— 平均とばらつきはこの 3 つで出る。 */
  count: number
  sum: number
  sumSq: number
  maxIntensity: number | null
  last: GravityVerdict | null
}

/** 覚えの鍵。**起動 ID を含めない**（`sensorHealth.ts` と同じ理由）。 */
function keyOf(boardKey: BoardKey, sensorId: string): string {
  return `${boardKey}|${sensorId}`
}

export class GravityCheckBook {
  private readonly windowMs: number
  private readonly minSamples: number
  private readonly maxSensors: number
  private readonly now: () => number
  private readonly minGal: number
  private readonly maxGal: number
  /** `Map` の挿入順が「いちばん長く音沙汰が無い順」になるよう、触れたら入れ直す。 */
  private readonly entries = new Map<string, Entry>()
  /**
   * 数え上げ。**1 つのレコードで持つ。**
   *
   * 欄ごとに私有の変数を並べると、`snapshot()` でそれを**もう一度並べ直す**ことになり、
   * 片方だけ足したときに黙ってずれる。ここをレコードにしておけば、`snapshot()` は
   * 広げるだけで済む。
   */
  private readonly counts: GravityCounts = {
    mismatches: 0,
    unjudged: 0,
    restlessWindows: 0,
    restarts: 0,
    evictions: 0,
  }

  constructor(options: GravityCheckBookOptions = {}) {
    this.windowMs = options.windowMs ?? WINDOW_MS_DEFAULT
    this.minSamples = options.minSamples ?? MIN_SAMPLES_DEFAULT
    this.maxSensors = options.maxSensors ?? MAX_SENSORS_DEFAULT
    this.now = options.now ?? Date.now
    this.minGal = GAL_PER_G / SCALE_RATIO_MAX
    this.maxGal = GAL_PER_G * SCALE_RATIO_MAX
  }

  /**
   * 波形が 1 まとまり通った。**窓が満ちたらその判定を返す。**
   *
   * 渡すのは `toGal` の出力そのもの —— **計測震度がまさに食べた値**を診る。生のカウントから
   * ここで換算し直すと経路が 2 本になり、診断の対象そのものを迂回することになる。
   *
   * **投げない。** 起きたことは戻り値で返す（`intensityPipeline.ts` と同じ分担）。
   */
  noteWave(input: {
    readonly boardKey: BoardKey
    readonly sensorId: string
    readonly streamKey: string
    readonly gal: readonly [readonly number[], readonly number[], readonly number[]]
  }): GravityVerdict | null {
    const entry = this.touch(input.boardKey, input.sensorId)

    let verdict: GravityVerdict | null = null
    if (entry.streamKey !== input.streamKey) {
      // **流れが変わった＝基板が起動し直した。** 名乗る分解能ごと変わりうるので、
      // 前の起動の値と混ぜない。溜めかけの窓は捨てる（判定も出さない）。
      //
      // **捨てた回数を数える。** ここは `settle` を通らないので、窓より短い間隔で
      // 再起動を繰り返す基板は**判定が一度も出ないのに、どの数にも現れない** ——
      // `/status` の `gravity` にも載らず（閉じた窓が無い）、「まだ 30 秒たまって
      // いないだけ」と見分けが付かない。**電源が不安定な基板ほど診断が要るのに、
      // そこで完全に黙る**のがいちばん重い。
      //
      // 初めて見たセンサー（`streamKey` が空）は数えない —— 捨てた窓が無い。
      if (entry.streamKey !== '') this.counts.restarts += 1
      this.reset(entry, input.streamKey)
    } else if (entry.windowStartMs + this.windowMs <= this.now()) {
      verdict = this.settle(entry)
      this.reset(entry, input.streamKey)
    }

    const [x, y, z] = input.gal
    // **3 本そろっている分だけ見る。** 呼ぶ側は長さの揃った 3 成分を渡す約束だが、
    // 短いほうを超えて読むと `undefined` が走和へ入り、以後この窓は黙って NaN になる。
    const n = Math.min(x.length, y.length, z.length)
    for (let i = 0; i < n; i++) {
      const m = Math.sqrt(x[i] * x[i] + y[i] * y[i] + z[i] * z[i])
      entry.count += 1
      entry.sum += m
      entry.sumSq += m * m
    }
    return verdict
  }

  /**
   * 震度が 1 つ出た。**窓の中の最大だけを覚える。**
   *
   * **波形をまだ受けていないセンサーでは覚えを作らない。** 合成の大きさが判らなければ
   * 静止しているかも判らず、震度だけあっても突き合わせようがない。
   */
  noteIntensity(input: {
    readonly boardKey: BoardKey
    readonly sensorId: string
    readonly streamKey: string
    readonly intensity: number | null
  }): void {
    const entry = this.entries.get(keyOf(input.boardKey, input.sensorId))
    if (entry === undefined) return
    // **いま見ている流れの読みだけを採る。** 覚えの鍵は起動 ID を含まないので、同じ
    // センサーの**古い起動セッション**の締めくくりもここへ同じ入れ物で届く
    // （`sensorHealth.ts` が同じ穴に手当てをしている）。何分も前の値を混ぜると、
    // いまの窓の静止の判定と噛み合わない震度で印が立つ。
    if (entry.streamKey !== input.streamKey) return
    if (input.intensity === null || !Number.isFinite(input.intensity)) {
      // **数えない値は入れない。** `Math.max` へ NaN を通すと以後の比較がすべて偽になり、
      // **印が二度と立たなくなる**（しかも症状は「立たない」だけで記録にも残らない）。
      // 数値にならなかった震度そのものは `intensityPipeline.ts` が別に数えている。
      return
    }
    entry.maxIntensity =
      entry.maxIntensity === null ? input.intensity : Math.max(entry.maxIntensity, input.intensity)
  }

  /**
   * いま覚えている数。**数え上げ（`snapshot()`）とは別物。**
   *
   * あちらは「起きた出来事の累計」で、これは「いま抱えているセンサーの数」。
   */
  get size(): number {
    return this.entries.size
  }

  /**
   * いまの様子を**まとめて 1 つ**返す。
   *
   * **数を 1 つずつ取り出す形にしない。** 受け取る側（`statusReport.ts`）が欄を
   * 並べる作りだと、**数を 1 つ足したときに渡し忘れる** —— この帳面は実際に
   * 4 巡続けてそれをやった（`restarts` を足したのに状態の口へ出さず、直したら
   * 隣の 3 つに同じ穴が残っていた）。まとめて返せば、足した数は黙って付いてくる。
   *
   * `verdicts` は**判定の新しい順**。まだ窓を 1 つも閉じていないセンサーは出ない
   * （だから `restarts` を別に数えている）。
   */
  snapshot(): GravityCheckSnapshot {
    const verdicts: GravityVerdict[] = []
    for (const e of this.entries.values()) {
      if (e.last !== null) verdicts.push(e.last)
    }
    verdicts.sort((a, b) => b.atMs - a.atMs)
    // **広げるだけ。** 欄を並べ直すと、足したときにここへ書き忘れる。
    return { verdicts, ...this.counts }
  }

  /** 窓を閉じて判定を作る。**数えるのもここ 1 箇所。** */
  private settle(entry: Entry): GravityVerdict {
    const base = {
      boardKey: entry.boardKey,
      sensorId: entry.sensorId,
      streamKey: entry.streamKey,
      atMs: this.now(),
      sampleCount: entry.count,
      maxIntensity: entry.maxIntensity,
    }

    const mean = entry.sum / entry.count
    // **丸めで負になりうる。** 静止した窓では分散がほとんど 0 なので、引き算の桁落ちで
    // わずかに負へ振れる。そのまま平方根へ渡すと NaN になり、正常な窓が `unreadable` に化ける。
    const sd = Math.sqrt(Math.max(0, entry.sumSq / entry.count - mean * mean))

    let verdict: GravityVerdict
    if (entry.count < this.minSamples) {
      verdict = { ...base, meanGal: null, sdGal: null, scale: 'too-few-samples', restless: false }
    } else if (!Number.isFinite(mean) || !Number.isFinite(sd)) {
      verdict = { ...base, meanGal: null, sdGal: null, scale: 'unreadable', restless: false }
    } else {
      const atRest = sd < REST_SD_GAL
      const scale: ScaleVerdict = !atRest
        ? 'not-at-rest'
        : mean < this.minGal
          ? 'too-small'
          : mean > this.maxGal
            ? 'too-large'
            : 'ok'
      const restless =
        atRest && entry.maxIntensity !== null && entry.maxIntensity > REST_MAX_INTENSITY
      verdict = { ...base, meanGal: mean, sdGal: sd, scale, restless }
    }

    if (verdict.scale === 'too-small' || verdict.scale === 'too-large' || verdict.scale === 'unreadable') {
      this.counts.mismatches += 1
    } else if (verdict.scale === 'not-at-rest' || verdict.scale === 'too-few-samples') {
      this.counts.unjudged += 1
    }
    if (verdict.restless) this.counts.restlessWindows += 1
    entry.last = verdict
    return verdict
  }

  private reset(entry: Entry, streamKey: string): void {
    entry.streamKey = streamKey
    entry.windowStartMs = this.now()
    entry.count = 0
    entry.sum = 0
    entry.sumSq = 0
    entry.maxIntensity = null
  }

  private touch(boardKey: BoardKey, sensorId: string): Entry {
    const key = keyOf(boardKey, sensorId)
    const found = this.entries.get(key)
    if (found !== undefined) {
      // **入れ直して挿入順を新しくする。** この順序が追い出しの根拠になる。
      this.entries.delete(key)
      this.entries.set(key, found)
      return found
    }
    if (this.entries.size >= this.maxSensors) {
      // **いちばん長く音沙汰の無いものを押し出す。** 新しいほうを拒むと、センサーを
      // 足した日からその 1 個が永久に診断されない（`Segmenter` と同じ判断）。
      const oldest = this.entries.keys().next()
      if (!oldest.done) {
        this.entries.delete(oldest.value)
        this.counts.evictions += 1
      }
    }
    const created: Entry = {
      boardKey,
      sensorId,
      streamKey: '',
      windowStartMs: this.now(),
      count: 0,
      sum: 0,
      sumSq: 0,
      maxIntensity: null,
      last: null,
    }
    this.entries.set(key, created)
    return created
  }
}
