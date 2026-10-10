// 同じ観測点に割り当てた複数センサーを、波形の段階で合成する（REQUIREMENTS.md §7）。
//
// **単純平均ではない。** 原文は `a = (a1 + a2) / 2` と書いているが、
// [`docs/implementation-plan.md`](../../../docs/implementation-plan.md) #93 の実測が
// 「品種が混ざると単純平均は床を悪化させる」ことを示しているので、**重みは
// ノイズ分散の逆数**にする。ただし#93 はこうも言っている——**それで床が下がると
// 期待しないこと。この節の本題は差分と空間的な一致のほうで、合成による精度向上ではない。**
//
// **合成するのは波形の段階。計測震度は平均しない**（対数量のため）。合成した波形を
// `../intensity/intensityStream.ts` へ通し、観測点ぶんの計測震度相当を出す。
//
// ## 観測点の時間の目盛り（設計判断。要件原文には無い）
//
// **観測点ごとに、センサーと無関係な目盛りを 1 本持つ。** 刻みは 10 ms（100 Hz）に固定し、
// 位置は絶対時刻で決める —— `k` 番目の目盛りは `k × 10 ms`（1970 年からの通し番号）。
// 合成はこの目盛りの 1 点ずつについて、**その時刻の値を持っているセンサー全員の軸**から解く。
// 設計の経緯は [`docs/seismo-station-fusion-design.md`](../../../docs/seismo-station-fusion-design.md)。
//
// **以前は 1 台（いちばん静かな台）を「駆動役」に固定し、その到着だけで合成を進めていた。**
// その 1 台が欠けると、ほかのセンサーが生きていても観測点の波形と震度が止まる ——
// 2026-10-07 13:42 の実機で、駆動役の基板の FIFO あふれ（その 1 分に 6 回）が観測点の波形に
// 2〜3 秒の穴を 3 つ残した。同じ時刻のほかの 2 枚はデータを持っていた。
//
// - **刻みを固定する。** センサーの刻みは基板ごとに揺らぐ（実機で 9.979〜10.018 ms）。
//   それを合成の刻みへ持ち込むと、PWA の溜まり（`src/utils/seismoWaveBuffer.ts`）は刻みが
//   0.5% 動いたところで溜めた波形を捨てる
// - **位置を絶対時刻で決める。** どの台が先に届いても、ホストを入れ直しても、生データから
//   作り直しても（`stationRewave.ts`）、同じ時刻には同じ目盛りが立つ。まとまりの境目も
//   `k` が {@link STATION_CHUNK_POINTS} の倍数のところに固定する
// - **値は補間で引く。** 目盛りを前後で挟む 2 サンプルが同じセンサーにあれば線形補間する
//   （刻みの違う台 —— IIS2ICLX は 104 Hz —— が混ざっても揃う）。2 サンプルの間隔が刻みの
//   1.5 倍を超えるなら引かない。**外へは延ばさない**
//
// ## 軸を 1 本ずつの観測として解く（最小二乗）
//
// **センサーの軸 1 本が 1 つの観測。** 軸 j は地面の加速度 `a`（東・北・上）を、自分の測る向き
// `d_j`（長さ 1）へ写した値 `y_j = d_j · a` を測る（`intensityPipeline.ts` の `WaveAxis`）。
// 目盛り 1 点ごとに、その時刻の値を持つセンサー全員の軸を並べて `a` を最小二乗で解く:
//
// ```
// N = Σ w d_j d_jᵀ     b = Σ w d_j y_j     a = N⁻¹ b      （w はそのセンサーの重み）
// ```
//
// - **3 軸のセンサーも軸 3 本として入る。** 特別な道は持たない。測る向きが直交していれば
//   （回転だけの校正。いまの設定はすべてそう）`N` は成分ごとの重みの和の対角になり、
//   **成分ごとの重み付き平均と同じ値**になる（以前の合成）
// - **2 軸のセンサー（IIS2ICLX）も同じ形で入る。** 1 台では 3 成分を解けないが、ほかのセンサーの
//   軸と並べれば解ける（水平に置いた 1 個と、立てて向きを変えた 2 個で 3 方向が揃う）
// - **測る向きが 3 方向へ散っていなければ、解けない成分だけ欠け。** 向きだけで作った
//   `G = Σ d_j d_jᵀ` から、成分ごとに「その成分の雑音が 1 軸で真っすぐ測ったときの何倍か」を出し、
//   3 倍を超える成分を NaN にする（{@link FUSION_MIN_DIRECTION_INFO}）。**解けない向きに掛からない
//   成分は出す** —— 上を測る台が止まって水平の台だけになっても、東・北の波形は続く（2026-10-09
//   ユーザー承認）。**震度は 3 成分とも解けた目盛りでだけ流す**（`G` のいちばん小さい固有値が
//   {@link FUSION_MIN_DIRECTION_INFO} 以上）。3 方向へ散っていない目盛りは数える
//   （{@link SensorFusion.unsolvedPoints}）
//
// **いちばん静かな台が値を決める度合いは、以前と変わらない。** 重みが雑音の分散の逆数
// なので、静かな 1 台がいればその台がほぼ値を決める（#93 の「役割分担」は重みとして残る）。
// 変わるのは、**その 1 台が欠けた瞬間に残りで続けられる**ことだけ。
//
// ## いつ出すか（待ち合わせ）
//
// 目盛りを {@link STATION_CHUNK_POINTS} 点のまとまりにして出す。**出すのは、生きている
// センサーが全員そのまとまりの末尾を越えるサンプルを届けた回**（揃った）。揃わなければ、
// 届いたデータの時刻がまとまりの末尾から {@link FUSION_WAIT_MS_DEFAULT} を超えた回に
// 切り上げる。**時間で決め打たない理由**は `FUSION_WAIT_MS_DEFAULT` を見ること（#374）。
//
// **「生きている」は、直近 {@link FUSION_LIVE_MS} に何か届けたセンサー。** 止まった台を
// 毎回待たない —— 以前は駆動役が止まれば合成ごと止まったので、この判定が要らなかった。
//
// **一度出したまとまりより前に届いたサンプルは、ライブでは混ぜない**（数えて
// {@link SensorFusion.lateSamples} に出す）。埋め直しはホストの作り直し（rewave）の仕事。
//
// ## 震度の流し込み
//
// `IntensityStream.push()` は位置の続きを要求する。**3 成分とも値がある点が続いている間は
// 1 本の流し込みを使い続け**、欠けたらそこで締め、次に揃った点から作り直す。位置は
// 作り直した時点の `k` を原点に数える（`Group.streamOrigin`）。**どれか 1 台の区間
// （`WaveChunk.segmentId`）が変わっても作り直さない** —— 以前は駆動役の基板が再起動・
// パケット落ちするたびに、観測点の震度が助走からやり直しになっていた。
//
// **`enabled: false` のセンサーはグループにも入れない。** そのセンサーはそもそも
// `WaveChunk` を作らない（`intensityPipeline.ts` が換算より前で弾く）。
import { IntensityStream } from '../intensity/intensityStream'
import type { IntensityPoint } from '../intensity/intensityStream'
import type { BoardKey } from '../protocol/types'
import type { StationConfig } from './stationConfig'
import type { Mat3, Vec3 } from './stationConfigTypes'
import type { WaveChunk } from './intensityPipeline'
import { normalizeIntensity } from './intensityPipeline'
import { resolveCalibration } from './calibration'
import { FUSION_MIN_DIRECTION_INFO } from './directionInfo'
import { dot3, eigenSym3, invert3, minEigenvalueSym3, multiplyMatVec3 } from './matrix3'
// **刻みと震度の方式は単独センサーと揃える**（`intensityPipeline.ts` と同じ理由 ——
// 物差しが違えば「揺れ方の違い」と「測り方の違い」を見分けられない）。
import { STEP_SEC_DEFAULT, samplesForSeconds } from '../../../src/utils/knet/intensityCommon'

/**
 * 直流（重力）を追う窓の長さ（秒）。**20 秒。**
 *
 * かつては計測震度の窓（20 秒）と同じ長さを共有していた。震度をリアルタイム震度
 * （直近 60 秒で判定する近似フィルタ方式）へ替えたあとも、**直流の追い方は変えないために
 * 値をここへ残した** —— 窓を伸ばすと設置直後や感度の設定変更の後に直流が落ち着くまでの
 * 時間が延び、短くすると長い周期の揺れまで直流として引いてしまう。
 */
export const FUSION_DC_WINDOW_SEC = 20

/** 地面の成分の数（東・北・上）。 */
const GROUND_AXES = 3

/** 対の差分 `(a − b) / 2` を出すセンサーの軸の本数。**3 軸どうしだけ**（{@link SensorPairDiff}）。 */
const PAIR_DIFF_AXES = 3

export { FUSION_MIN_DIRECTION_INFO }

/**
 * `G` の固有値がこれより小さい向きは「まったく測っていない」とみなす。**解けるかの閾値ではない**
 * （それは {@link FUSION_MIN_DIRECTION_INFO}）—— 丸め誤差で 0 にならない固有値を、測っている
 * 向きと取り違えないための下限。
 */
const UNSEEN_DIRECTION_INFO = 1e-9

/**
 * まったく測っていない向きへ、その成分（測る向き）が掛かってよい大きさ（向きの内積）。
 * **ここまでなら、測っていない向きの揺れが漏れても 0.1% に収まる。**
 */
const UNSEEN_LEAK_MAX = 1e-3

/** 観測点の目盛りの刻み（ミリ秒）。**100 Hz に固定する**（冒頭の「観測点の時間の目盛り」）。 */
export const STATION_GRID_MS = 10

/**
 * 1 まとまりの目盛りの数。**30 点（300 ms）。** 実機の基板が 1 パケットに詰める長さと同じで、
 * 押し出しの頻度を以前と変えないための値。境目は `k` がこの倍数のところに固定する。
 */
export const STATION_CHUNK_POINTS = 30

const CHUNK_MS = STATION_GRID_MS * STATION_CHUNK_POINTS

/**
 * センサーの到着を待つ上限（ミリ秒）。**これは上限で、揃えばここまで待たない。**
 *
 * **なぜ待つのか。** まだ届いていない範囲は引けないので、待たずに出すと**その瞬間に
 * 届いていたセンサーだけ**が混ざり、顔ぶれがまとまりごとに変わる。実機（2026-09-28）の
 * 到着の形を写した台では、待たずに合成すると 9 本のうち 1〜7 本を揺れ動き、**9 本が
 * 揃った瞬間は 8000 サンプル中 1 度も無かった**。
 *
 * **待ちの長さでは決めない。** 揃ったかどうかは「生きているセンサーが全員、まとまりの
 * 末尾を越えるサンプルを届けたか」で見て、揃った回に出す —— **時間で決め打つと必ず
 * 足りなくなる**。要る長さは「センサー間の到着差 ＋ センサーのまとまり長」で、後者は
 * 基板の設定次第だから（2026-09-30 に #374 で実測。到着差 200 ms に対し待ちは 300 ms
 * あったのに、9 本が揃ったのは 62.7% だけだった）。
 *
 * **この値は「揃わないまま待ち続けない」ための頭打ち。** 600 ms は実測の到着差 200 ms ＋
 * まとまり長 300 ms に余裕を 100 ms 足した値。
 *
 * **遅れは 0.6 秒に収まる。** 震度の値そのものは直近 60 秒で判定するので、待ちの間に
 * 最大値を取り逃すことは無い。
 */
export const FUSION_WAIT_MS_DEFAULT = 600

/**
 * センサーを「生きている」と見なす長さ（ミリ秒）。**直近 5 秒以内に何か届けた台。**
 *
 * 生きている台は揃うのを待つ。止まった台（FIFO あふれ・電源断・設定にあるのに来ない）を
 * 毎回 {@link FUSION_WAIT_MS_DEFAULT} 待たないための線引き。**5 秒にしたのは、実機で
 * 見た欠け（FIFO あふれで 1.7〜3 秒）より長くとるため** —— 短い欠けの間は「戻ってくるかも
 * しれない」として待ち、長い沈黙からは外す。
 *
 * **一度も届いていない台は、観測点に最初のデータが届いてからこの長さの間だけ生きている
 * と見なす。** 起動直後・設定を変えた直後に、遅れて届く台を待たずに出してしまわないため。
 */
export const FUSION_LIVE_MS = 5_000

/**
 * サンプルが名乗る時刻が、ホストが受け取った時刻よりこれだけ先なら、その台の時計が壊れている
 * と見なす線（ミリ秒）。**2 秒。**
 *
 * **目盛りは届いたデータの時刻で進む**ので、1 台の時計が先へ飛ぶと、ほかの台の
 * まとまりは届く前に「出した後」になり、観測点ごと止まる。そこで、**受け取った時刻より
 * これを超えて先を名乗るサンプルは混ぜずに捨て、数える**（{@link SensorFusion.futureSamples}）。
 *
 * **線より手前の先回りも、その幅だけ観測点を止める**（1 パケットだけでも、目盛りがそこまで進み、
 * 後から届く正しい時刻の分が「出した後」に落ちる）ので、線は狭く取る。正しい台が受け取った時刻より
 * 先を名乗れるのは、基板とホストの時計のずれの分だけ —— 見張り（`boardClockVerdict.ts` の
 * `CLOCK_OFFSET_WARN_MS` = 100 ms）が知らせる幅の 20 倍を取った。**狭めすぎない理由はホスト側の時計**
 * で、ホストの時計がこの線より遅れると全員の分を捨てる（合成は出なくなるが、センサーごとの震度は
 * 出続け、捨てた数が毎分の要約に出る）（2 秒は 2026-10-07 ユーザー承認）。
 *
 * **物差しはホストの時計で、台どうしは比べない。** まだ測っていない未来の値は届きようがないので、
 * 先を名乗るのは時計の壊れた台だと断定できる。台どうしの比べ合いでは、全員の時計が壊れたときに
 * どれが正しいかを決められない（いちばん先へ飛んだ台の偽の時刻へ観測点ごと移りうる）。
 * 受け取った後で遅れて届いた分（基板の控えからの取り戻し）は過去を名乗るだけなので、この線に掛からない。
 */
export const FUSION_MAX_FUTURE_MS = 2_000

/** 補間でまたいでよいサンプル間隔の上限（刻みの何倍か）。超えたら間に欠けがある。 */
const GAP_FACTOR = 1.5

/**
 * センサー 1 本ぶんに抱えておくサンプルの上限。**60 秒ぶん（100 Hz）。**
 *
 * 通常は出したまとまりの手前を捨てる（`SampleStore.trimBefore`）ので、ここまで溜まらない
 * （1 台が抱えるのは、目盛りの次のまとまりから「生きている」の幅か待ちの上限ぶんまで）。
 * それが崩れたときに抱え続けないための歯止めで、**落としたら数える**（{@link SensorFusion.discardedSamples}）。
 */
const MAX_SAMPLES_PER_MEMBER = 6_000

/**
 * センサー 1 本ぶんの直流（重力）を軸ごとに追い、引いた値を返す。**窓は {@link FUSION_DC_WINDOW_SEC}。**
 *
 * **なぜ引くのか。** 合成は「値が引けたセンサーだけ」で解くので、顔ぶれは
 * 目盛りごとに変わりうる。**各センサーの直流が揃っていないと、顔ぶれが 1 本入れ替わる
 * たびに合成の直流が跳ぶ** —— 実機では静止時の Z 軸が 662〜1200 gal に散っていて
 * （感度が未校正）、静止ノイズ 1.5 gal に対して数十 gal のステップが 100ms ごとに立ち、
 * 周期補正フィルタがそれを**実機で震度 4.36**（単体は 1.12〜1.24）として出していた
 * （2026-09-28・#362。実測値は `../../REQUIREMENTS.md` §7 の表）。
 *
 * **震度の計算側が引く直流では消えない。** あちらは流し込みの最初のサンプルを
 * 差し引くだけで、**途中で立つ段差はそのまま揺れとして通る**。段差を作らせないには、
 * 混ぜる前に各センサーから直流を落としておくしかない。
 *
 * **軸ごとに追う。** 軸の値は「その向きの加速度」なので、重力もその向きへ写した分だけが乗る
 * （2 軸でも 3 軸でも同じ形）。
 */
export class DcTracker {
  private readonly bufs: Float64Array[]
  private readonly sums: number[]
  private next = 0
  private filled = 0
  /** 足し引きを重ねた回数。**1 周ごとに数え直して誤差の溜まりを断つ**（下記 `step`）。 */
  private sinceRebuild = 0

  /**
   * **容量が 1 だと引いた値が常に 0 になる**（そのサンプル自身が直流の推定になるため）。
   * 呼び出し側（`SensorFusion.trackerFor`）は {@link FUSION_DC_WINDOW_SEC}（既定 20 秒 =
   * 2000 サンプル）から引くので通常は起きないが、`dcWindowSec` に極端に小さい値を渡すと
   * そうなる —— **合成波形も合成の震度も、全ゼロのまま出続ける**（例外にはならない）。
   */
  constructor(capacity: number, channels: number) {
    if (!(capacity >= 1)) throw new Error('capacity は 1 以上で指定すること')
    if (!(Number.isInteger(channels) && channels >= 1)) throw new Error('channels は 1 以上の整数で指定すること')
    const n = Math.floor(capacity)
    this.bufs = Array.from({ length: channels }, () => new Float64Array(n))
    this.sums = new Array(channels).fill(0)
  }

  /** いま引いている直流。**1 つも食わせていなければ 0**（引くものが無い）。 */
  get dc(): readonly number[] {
    if (this.filled === 0) return this.sums.map(() => 0)
    return this.sums.map((s) => s / this.filled)
  }

  /** 溜まっているサンプルの数。窓に満たないうちは、溜まった分だけの平均を引く。 */
  get sampleCount(): number {
    return this.filled
  }

  /**
   * 軸の値を 1 サンプルぶん食わせ、**そのサンプルを含めた直流を引いた値**を返す。
   * 本数は作ったときの `channels` と同じであること（違えば投げる）。
   *
   * **窓が埋まるのを待たない。** 待つと、待っている間の値が直流ごと合成へ流れて
   * 同じ症状になる（しかも「まだ溜まっていない」ことは下流から見えない）。
   * 溜まった分の平均でも、跳びを作らないという目的は果たせる。
   */
  step(values: readonly number[]): number[] {
    const channels = this.bufs.length
    if (values.length !== channels) throw new Error(`軸の本数が違う（${values.length} 本・作ったのは ${channels} 本）`)
    const cap = this.bufs[0]!.length
    for (let axis = 0; axis < channels; axis++) {
      const buf = this.bufs[axis]!
      if (this.filled === cap) this.sums[axis]! -= buf[this.next]!
      buf[this.next] = values[axis]!
      this.sums[axis]! += values[axis]!
    }
    this.next = this.next + 1 === cap ? 0 : this.next + 1
    if (this.filled < cap) this.filled++

    // **和を足し引きし続けると誤差が溜まる。** 重力は 1000 gal のオーダーで、
    // 拾いたい揺れは 1 gal 未満 —— 溜まった誤差は「引き残した直流」として
    // そのまま合成へ出るが、**値が少しずつずれるだけなので誰も気づけない**。
    // 1 周ごとに溜めてある値から数え直す（1 サンプルあたりの手間は 1 回ぶん）。
    this.sinceRebuild++
    if (this.sinceRebuild >= cap) {
      this.sinceRebuild = 0
      for (let axis = 0; axis < channels; axis++) {
        const buf = this.bufs[axis]!
        let s = 0
        for (let i = 0; i < this.filled; i++) s += buf[i]!
        this.sums[axis] = s
      }
    }

    const dc = this.dc
    return values.map((v, axis) => v - dc[axis]!)
  }
}

/**
 * 補間で引いた 1 時刻ぶんの値（直流を引いた後）と、引いた直流。軸ごと。
 *
 * `dirs` はその値を測った向き（軸ごと・地面で見た長さ 1）。**向きの配列はセンサーごとに 1 つを
 * 使い回すので、同じ向きかは参照で見分けられる**（`SensorFusion.ingest`）。
 */
interface SampleAt {
  readonly value: readonly number[]
  readonly dc: readonly number[]
  readonly dirs: readonly Vec3[]
}

/**
 * センサー 1 本ぶんのサンプルを、時刻順に抱える。**直流を引いた後の値と、引いた直流と、測った向きを持つ。**
 *
 * 先頭の捨て方は「出したまとまりの手前」まで（`trimBefore`）。**補間に要る 1 つ前の
 * サンプルは残す** —— 次のまとまりの最初の目盛りは、それと次のサンプルに挟まれる。
 */
class SampleStore {
  private t: number[] = []
  /** そのサンプルが属していたまとまりの刻み。補間でまたいでよい間隔を決める。 */
  private step: number[] = []
  /** そのサンプルを測った向き（参照を共有する）。 */
  private dirs: (readonly Vec3[])[] = []
  private v: number[][]
  private d: number[][]
  private head = 0

  constructor(private readonly channels: number) {
    this.v = Array.from({ length: channels }, () => [])
    this.d = Array.from({ length: channels }, () => [])
  }

  get size(): number {
    return this.t.length - this.head
  }

  get lastMs(): number | null {
    return this.size === 0 ? null : this.t[this.t.length - 1]!
  }

  get firstMs(): number | null {
    return this.size === 0 ? null : this.t[this.head]!
  }

  /**
   * サンプルを足す。**時刻順に届くのが通常で、そのときは末尾へ積むだけ。**
   *
   * 時刻が重なる・前後する形（再送・取り戻し）では、重なった範囲の古い値を外して
   * 並べ直す —— **新しく届いた値を採る**（区間の当てはめが進んだ結果なので、後のほうが確からしい）。
   *
   * 足すのは添字 `[from, to)` の範囲だけ。
   *
   * **戻り値は、上限（{@link MAX_SAMPLES_PER_MEMBER}）を超えて古い側から落とした数。** 呼び出し側が数える。
   */
  insert(
    times: readonly number[],
    msPerSample: number,
    dirs: readonly Vec3[],
    values: readonly (readonly number[])[],
    dcs: readonly (readonly number[])[],
    from: number,
    to: number,
  ): number {
    if (from >= to) return 0
    const last = this.lastMs
    if (last === null || times[from]! > last) {
      for (let i = from; i < to; i++) this.push(times[i]!, msPerSample, dirs, values, dcs, i)
    } else {
      this.mergeIn(times, msPerSample, dirs, values, dcs, from, to)
    }
    let dropped = 0
    if (this.size > MAX_SAMPLES_PER_MEMBER) {
      dropped = this.size - MAX_SAMPLES_PER_MEMBER
      this.head = this.t.length - MAX_SAMPLES_PER_MEMBER
    }
    this.compact()
    return dropped
  }

  private push(
    tMs: number,
    msPerSample: number,
    dirs: readonly Vec3[],
    values: readonly (readonly number[])[],
    dcs: readonly (readonly number[])[],
    i: number,
  ): void {
    this.t.push(tMs)
    this.step.push(msPerSample)
    this.dirs.push(dirs)
    for (let axis = 0; axis < this.channels; axis++) {
      this.v[axis]!.push(values[axis]![i]!)
      this.d[axis]!.push(dcs[axis]![i]!)
    }
  }

  private mergeIn(
    times: readonly number[],
    msPerSample: number,
    dirs: readonly Vec3[],
    values: readonly (readonly number[])[],
    dcs: readonly (readonly number[])[],
    from: number,
    to: number,
  ): void {
    const lo = times[from]! - msPerSample / 2
    const hi = times[to - 1]! + msPerSample / 2
    type Row = { t: number; step: number; dirs: readonly Vec3[]; v: number[]; d: number[] }
    const rows: Row[] = []
    const axes = Array.from({ length: this.channels }, (_, axis) => axis)
    for (let i = this.head; i < this.t.length; i++) {
      if (this.t[i]! >= lo && this.t[i]! <= hi) continue
      rows.push({
        t: this.t[i]!,
        step: this.step[i]!,
        dirs: this.dirs[i]!,
        v: axes.map((axis) => this.v[axis]![i]!),
        d: axes.map((axis) => this.d[axis]![i]!),
      })
    }
    for (let i = from; i < to; i++) {
      rows.push({
        t: times[i]!,
        step: msPerSample,
        dirs,
        v: axes.map((axis) => values[axis]![i]!),
        d: axes.map((axis) => dcs[axis]![i]!),
      })
    }
    rows.sort((a, b) => a.t - b.t)
    this.t = rows.map((r) => r.t)
    this.step = rows.map((r) => r.step)
    this.dirs = rows.map((r) => r.dirs)
    this.v = axes.map((axis) => rows.map((r) => r.v[axis]!))
    this.d = axes.map((axis) => rows.map((r) => r.d[axis]!))
    this.head = 0
  }

  /** `ms` 以前のサンプルを、最後の 1 つを残して捨てる（補間に要る）。 */
  trimBefore(ms: number): void {
    while (this.head + 1 < this.t.length && this.t[this.head + 1]! <= ms) this.head++
    this.compact()
  }

  private compact(): void {
    if (this.head < 1024) return
    this.t = this.t.slice(this.head)
    this.step = this.step.slice(this.head)
    this.dirs = this.dirs.slice(this.head)
    this.v = this.v.map((row) => row.slice(this.head))
    this.d = this.d.map((row) => row.slice(this.head))
    this.head = 0
  }

  /** `ms` 以上で最初のサンプルの時刻。無ければ null。 */
  firstAtOrAfter(ms: number): number | null {
    const i = this.lowerBound(ms)
    return i < this.t.length ? this.t[i]! : null
  }

  /** `ms` 以上で最初のサンプルの位置（無ければ末尾の次）。 */
  private lowerBound(ms: number): number {
    let lo = this.head
    let hi = this.t.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.t[mid]! < ms) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * 時刻 `ms` の値を引く。**挟む 2 サンプルが無ければ null（外へ延ばさない）。**
   * 2 サンプルの間隔が刻みの {@link GAP_FACTOR} 倍を超えても null（間に欠けがある）。
   * **2 サンプルの測った向きが違っても null**（校正が変わった境目。向きの違う値は混ぜられない）。
   */
  at(ms: number): SampleAt | null {
    const i = this.lowerBound(ms)
    if (i < this.t.length && Math.abs(this.t[i]! - ms) < 1e-6) {
      return { value: this.v.map((row) => row[i]!), dc: this.d.map((row) => row[i]!), dirs: this.dirs[i]! }
    }
    const before = i - 1
    if (before < this.head || i >= this.t.length) return null
    if (this.dirs[before] !== this.dirs[i]) return null
    const span = this.t[i]! - this.t[before]!
    if (span > GAP_FACTOR * Math.max(this.step[before]!, this.step[i]!)) return null
    const f = (ms - this.t[before]!) / span
    return {
      value: this.v.map((row) => row[before]! + (row[i]! - row[before]!) * f),
      dc: this.d.map((row) => row[before]! + (row[i]! - row[before]!) * f),
      dirs: this.dirs[i]!,
    }
  }
}

function memberKeyOf(boardKey: BoardKey, sensorId: string): string {
  return `${boardKey}|${sensorId}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** どのセンサーを指しているか。`boardKey`・`sensorId` の組。 */
export interface SensorMemberRef {
  readonly boardKey: BoardKey
  readonly sensorId: string
}

type AxisRows<T> = readonly [readonly T[], readonly T[], readonly T[]]

/**
 * 観測点ひとつぶんの合成波形。**全センサーの軸を最小二乗で解いた、校正済み gal**（REQUIREMENTS.md §7・冒頭）。
 *
 * **刻みは常に {@link STATION_GRID_MS}、位置は観測点の目盛りの通し番号**
 * （`firstSampleMs === firstSampleIndex × STATION_GRID_MS`）。3 成分とも解けた目盛りだけを
 * 含む —— 欠けた目盛りでは、まとまりが切れる（次のまとまりの `firstSampleIndex` が飛ぶ）。
 */
export interface FusedWaveChunk {
  readonly stationId: string
  /** 観測点の目盛りの通し番号（`k`）。**センサーの区間の位置ではない。** */
  readonly firstSampleIndex: number
  readonly firstSampleMs: number
  readonly msPerSample: number
  /**
   * 解いた gal（東・北・上）。`gal[axis][i]` が i 番目のサンプル。
   *
   * **直流（重力）を引いた変動分。** 混ぜる前に各センサーから落としてある
   * （`DcTracker` の説明を見ること）。落とさないと、顔ぶれが入れ替わるたびに
   * センサー間の直流差がステップとして乗る。
   */
  readonly gal: AxisRows<number>
  /**
   * 上の `gal` から落とした直流。**同じ重みで解いてある**ので、
   * `gal[axis][i] + dcGal[axis][i]` が「校正済み gal を解いた値」（落とす前の値）。
   *
   * **落とした値を捨てない。** 重力の向きと大きさは取り付けの診断に使える事実で、
   * 変動分だけにすると下流からは二度と引けない。
   */
  readonly dcGal: AxisRows<number>
  /**
   * 各目盛りへ実際に効いたセンサーの数（値を持っていた台）。
   *
   * 届いていない台が合成から外れたことを、値の形だけでは下流が見分けられない
   * ——1 台の値がそのまま「合成」を名乗ることになるので、実際に混ぜた数を添える。
   * **3 軸のセンサーだけなら、以前の「3 成分のうち最も少ない成分の本数」と同じ値**になる。
   */
  readonly memberCount: readonly number[]
  /**
   * 成分ごとの本数。**その成分を自分の軸でじゅうぶんに測っている台の数**（自分の軸だけで作った
   * `Σ d_j d_jᵀ` の対角が {@link FUSION_MIN_DIRECTION_INFO} 以上）。水平に置いた 2 軸の台は
   * 上の成分に数えない。3 軸の台は 3 成分とも数える。
   */
  readonly axisMemberCount: AxisRows<number>
}

/**
 * センサー対 1 組ぶんの差分 `d = (a1 − a2) / 2`（REQUIREMENTS.md §7）。gal 単位。
 *
 * 用途は要件が明示している——センサー自己ノイズの推定・異常センサーの検出・
 * センサー間の一致度確認・coherence 解析・ロバスト平均。**いずれも波形そのものを
 * 見る用途**なので、窓の統計へ丸めず、時系列のまま返す。
 *
 * 3 台以上のグループでは**全ペアの組み合わせ**にこの式をそのまま適用する
 * （要件原文が定めるのは 2 台の式だけなので、新しい式は作らない）。
 * **目盛りは合成波形と同じ。**
 *
 * **3 軸のセンサーどうしだけ。** 2 軸のセンサーは 1 台で東・北・上を解けないので、成分ごとの
 * 差を作れない。2 軸を含むずれは {@link SensorResidual} が受け持つ。
 */
export interface SensorPairDiff {
  readonly stationId: string
  readonly memberA: SensorMemberRef
  readonly memberB: SensorMemberRef
  readonly firstSampleIndex: number
  readonly firstSampleMs: number
  readonly msPerSample: number
  /** 両方の値が揃う目盛りだけ埋まる。片方でも無ければ null（外挿しない）。東・北・上。 */
  readonly diffGal: AxisRows<number | null>
}

/**
 * センサー 1 台ぶんの「ずれ」。軸ごとに、**測った値 − そのセンサーを除いたほかのセンサーで解いた
 * 揺れをその軸の向きへ写した値**（gal・直流を引いた後）。半分にはしない。
 *
 * **自分を除いて解く**（2026-10-09 ユーザー承認）。自分も含めた合成と比べると、重みの大きい台ほど
 * 合成が自分へ寄ってずれが小さく出る —— IIS2ICLX は水平で MPU6050 の 8〜10 倍静かなので重みは
 * 64〜100 倍になり、壊れても本当の食い違いの 1〜2% しか出ない。**いちばん信用している台の故障が
 * 見えなくなる**のを避ける。
 *
 * **ほかのセンサーで東・北・上を解けない目盛りでは null**（その台を抜くと向きが平面へ寄る並び）。
 * 2 軸のセンサーを含む観測点で「どの台がおかしいか」を見る手段がこれ（対の差分は 3 軸どうしだけ）。
 */
export interface SensorResidual {
  readonly stationId: string
  readonly member: SensorMemberRef
  readonly firstSampleIndex: number
  readonly firstSampleMs: number
  readonly msPerSample: number
  /** 軸の名前（センサーが名乗るもの）。`axes` の並びと 1 対 1。 */
  readonly channels: readonly string[]
  /**
   * 軸ごとのずれ。`direction` はその軸が地面で測る向き（長さ 1）。
   * 値は目盛りごとで、ずれを出せない目盛りは null。
   */
  readonly axes: readonly { readonly direction: Vec3; readonly residualGal: readonly (number | null)[] }[]
}

/** 合成波形から出した、観測点ぶんの計測震度相当。**震度の平均ではない。** */
export interface StationIntensityReading {
  readonly stationId: string
  readonly atMs: number
  /** 窓の中身が足りなければ null。「揺れていない」を意味する値ではない。 */
  readonly intensity: number | null
}

/** 観測点の合成の流し込みを締めくくれなかった。**その観測点の直前区間の末尾ぶんが失われている。** */
export interface StationCloseFailure {
  readonly stationId: string
  readonly detail: string
}

/**
 * 合成した 1 まとまりぶんの結果。**投げない**（`intensityPipeline.ts` と同じ分担）。
 *
 * `ingest()` は 0 個以上をまとめて返す —— 1 回の到着で、揃ったまとまりが複数になることも、
 * 欠けでまとまりが途中で切れることもあるため。
 */
export interface FusionOutcome {
  readonly fusedWave: FusedWaveChunk
  readonly pairDiffs: readonly SensorPairDiff[]
  /**
   * センサーごとのずれ（{@link SensorResidual}）。**値を一度でも届けたセンサー全員ぶん**（届けた
   * ことの無い台は測る向きが分からないので入らない）。このまとまりで値を持たなかった台は全部 null。
   */
  readonly residuals: readonly SensorResidual[]
  /** このまとまりで出た震度。流し込みを作り直したときは、締めた分（前の流し込みの末尾）も混ざる。 */
  readonly readings: readonly StationIntensityReading[]
  /**
   * 合成の計測震度が作れない理由。作れていれば null。**いまの流し込みの健全性**
   * （`IntensityStream` の構築・`push()` が失敗した）。
   *
   * **`closeFailure` とは別の事実。** あちらは「直前に締めた流し込み」の締めくくりの成否、
   * こちらは「いま」の流し込みの健全性 —— 作り直しが成功すれば、締めくくりの失敗の有無に
   * 関わらずここは `null` に戻る。
   */
  readonly intensitySkipReason: string | null
  /**
   * このまとまりで流し込みを締めた（欠けのあと作り直した）とき、締めくくり
   * （`IntensityStream.end()`）が失敗していればその理由。それ以外は null。
   *
   * **`intensitySkipReason` で代用しない。** 作り直しはこの直後に走り、成功すれば
   * `intensitySkipReason` を `null` へ戻す —— 同じ欄で両方を表すと、締めくくりの失敗が
   * 作り直しの成功で上書きされて消える。
   */
  readonly closeFailure: StationCloseFailure | null
  /**
   * このまとまりで流し込みの状態が変わりうる処理が走ったか（作り直し・`push()` の失敗）。
   *
   * 単一センサーの計測震度（`intensityPipeline.ts` の `PacketOutcome.startedBecause`）が
   * 「区間が始まった回にだけ理由を返す」のと対称にするための印 —— 呼び出し側が
   * 「状態が変わった回にだけログを出す」判定を再現できるように。
   */
  readonly intensityStateChanged: boolean
  /**
   * 生きているセンサーが全員、このまとまりの末尾を越えるサンプルを届けていたか。
   *
   * **偽なら「揃わないまま待ちの上限で切り上げた」。** 下流はこの回を数える
   * （`stationHealth.ts` の `uncoveredFusions`）—— **`memberCount` だけでは
   * 「恒常的に揃っていない」と「そもそも割り当てが 2 台で本数が少ない」を
   * 見分けられない**（#374）。
   */
  readonly allMembersCovered: boolean
}

/**
 * `closeAll()` の結果。**2 種類の事実を分けて運ぶ。**
 *
 * - `drained` —— 待たせていたまとまりを、届いたデータの末尾まで流し切って合成した回。
 *   **1 つずつが `ingest()` の結果と同じ意味を持つ**ので、呼び出し側は受信の最中と
 *   同じ配り口へ通す
 * - `readings`・`failures` —— そのあと流し込み（`IntensityStream`）を締めて出た震度と、
 *   締めくくりの失敗。**`drained` の中身はここへ重ねて入れない** —— 入れると、
 *   `drained` を配る呼び出し側で同じ震度が 2 度出る
 *
 * **`drained` を配り忘れると、合成波形と差分に加えて震度もその分だけ欠ける。**
 * 型で省けないよう、受け取る側（`main.ts` の `ApplyStationConfigDeps`・`CloseHostDeps`）は
 * この型をそのまま受ける。
 */
export interface SensorFusionClosing {
  readonly drained: readonly FusionOutcome[]
  readonly readings: readonly StationIntensityReading[]
  readonly failures: readonly StationCloseFailure[]
}

interface Member {
  readonly ref: SensorMemberRef
  /** 重み（ノイズ密度の逆数分散）。**センサーの軸は全部この重み。** */
  readonly weight: number
  /** 設定の軸の本数（2 か 3）。**違う本数のまとまりは混ぜない**（`ingest`）。 */
  readonly axisCount: number
  readonly samples: SampleStore
  /** 届いた中でいちばん新しいサンプルの時刻。「生きているか」「揃ったか」に使う。 */
  lastSampleMs: number | null
  /**
   * 直流の追い方。**区間が切れても捨てない** —— 追っているのは物理量（重力）そのもので、
   * 捨てると、そのセンサーだけ直流の推定が 0 から立ち上がり直して**切れ目のたびに跳びを作る**。
   * **測る向きが変わったときだけ作り直す**（向きの違う値の直流は混ぜられない）。
   */
  dc: DcTracker | null
  /**
   * いま届いている測る向き（軸ごと）。**同じ向きの間は同じ配列を使い回す**ので、サンプルの向きが
   * 同じかを参照で見分けられる（`SampleStore.at`）。まだ何も届いていなければ null。
   */
  dirs: readonly Vec3[] | null
  /** いま届いている軸の名前。`dirs` と同じ並び。 */
  channels: readonly string[] | null
  /**
   * 3 軸のセンサーで、`dirs` を行に並べた行列の逆（軸の値 → 東・北・上）。対の差分に使う。
   * `dirs` が変わったら作り直す。2 軸のセンサー・解けない向きでは null。
   */
  groundOf: { readonly dirs: readonly Vec3[]; readonly inverse: Mat3 | null } | null
}

interface Group {
  readonly stationId: string
  readonly members: readonly Member[]
  /**
   * 次に出すまとまりの番号（`k / STATION_CHUNK_POINTS`）。**最初に出すときに決める**
   * （そのとき抱えているいちばん古いサンプルのまとまり）。届いた順に決めると、起点の
   * ずれた台（実機で最大 160 ms 後ろ）の最初のサンプルが「遅すぎる」になる。
   */
  nextChunk: number | null
  /** 観測点に最初に届いたサンプルの時刻。一度も届いていない台を生きている扱いにする起点。 */
  firstSeenMs: number | null
  /** いま合成に使っている計測震度の流し込み。欠けたら作り直す。 */
  stream: IntensityStream | null
  /**
   * いまの `stream` の原点（作り直した時点の目盛り `k`）。`stream` が null のときは null。
   * **流し込みは位置 0 から数える**ので、目盛りの通し番号をそのまま渡せない。
   */
  streamOrigin: number | null
  /**
   * 次に流し込みへ渡すはずの目盛り `k`。**`stream` が null（構築・`push()` の失敗）でも進める。**
   * 続いている限り作り直さない —— 失敗した流し込みを毎まとまり作り直して失敗し続ける形を
   * 避ける（次の欠けで作り直す）。
   */
  streamNext: number | null
  streamError: string | null
  unusableCount: number
  lateSamples: number
  /** 受け取った時刻より先を名乗って混ぜなかったサンプル（{@link SensorFusion.futureSamples}）。 */
  futureSamples: number
  /** 抱えたまま混ぜずに捨てたサンプル（{@link SensorFusion.discardedSamples}）。 */
  discarded: number
  /** 値を持つ台がいたのに、3 方向へ散っておらず解けなかった目盛り（{@link SensorFusion.unsolvedPoints}）。 */
  unsolvedPoints: number
}

/**
 * 設定から観測点ごとのグループを作る。**`enabled` なセンサーを、軸の本数（2・3）を問わず見る。**
 *
 * 2 台に満たない観測点は組まない——合成する相手が居ない。
 */
function buildGroups(config: StationConfig): Group[] {
  const listByStation = new Map<
    string,
    { boardKey: BoardKey; sensorId: string; noiseDensity: number | null; axisCount: number }[]
  >()
  for (const board of config.boards) {
    for (const sensor of board.sensors) {
      if (!sensor.enabled) continue
      const list = listByStation.get(board.stationId) ?? []
      list.push({
        boardKey: board.boardKey,
        sensorId: sensor.sensorId,
        noiseDensity: sensor.noiseDensity,
        axisCount: sensor.axes.length,
      })
      listByStation.set(board.stationId, list)
    }
  }

  const groups: Group[] = []
  for (const [stationId, list] of listByStation) {
    if (list.length < 2) continue
    // **重みはノイズ密度の逆数分散。1 台でも申告が無ければ、グループ全体を
    // 単純平均へ倒す**——一部だけ重み付けすると、申告の無いセンサーを暗黙に
    // ノイズ 0 として扱うことになる。
    const allKnown = list.every((m) => m.noiseDensity !== null)
    const members: Member[] = list.map((m) => ({
      ref: { boardKey: m.boardKey, sensorId: m.sensorId },
      weight: allKnown ? 1 / (m.noiseDensity as number) ** 2 : 1,
      axisCount: m.axisCount,
      samples: new SampleStore(m.axisCount),
      lastSampleMs: null,
      dc: null,
      dirs: null,
      channels: null,
      groundOf: null,
    }))
    groups.push({
      stationId,
      members,
      nextChunk: null,
      firstSeenMs: null,
      stream: null,
      streamOrigin: null,
      streamNext: null,
      streamError: null,
      unusableCount: 0,
      lateSamples: 0,
      futureSamples: 0,
      discarded: 0,
      unsolvedPoints: 0,
    })
  }
  return groups
}

/** 届いたデータのうち最も新しい時刻（全員の最大）。**待ちはこれで計る。壁時計は見ない。** */
function clockOf(group: Group): number | null {
  let clock: number | null = null
  for (const m of group.members) {
    if (m.lastSampleMs !== null && (clock === null || m.lastSampleMs > clock)) clock = m.lastSampleMs
  }
  return clock
}

/** 直近 {@link FUSION_LIVE_MS} に何か届けたか（一度も届いていない台は、観測点に最初に届いてから）。 */
function isLive(group: Group, m: Member, clock: number): boolean {
  const seen = m.lastSampleMs ?? group.firstSeenMs
  return seen !== null && seen >= clock - FUSION_LIVE_MS
}

/** 生きている台が全員、`tailMs` を越えるサンプルを届けたか。 */
function allLiveCover(group: Group, clock: number, tailMs: number): boolean {
  for (const m of group.members) {
    if (!isLive(group, m, clock)) continue
    if (m.lastSampleMs === null || m.lastSampleMs < tailMs) return false
  }
  return true
}

/**
 * 正規方程式の足し込み（3x3 を 9 個の数で持つ）。**センサー 1 台ぶんずつ作って足す** ——
 * 自分を除いて解く（{@link SensorResidual}）ときに、その台のぶんだけを引けるように。
 */
interface Normal {
  /** `Σ w d dᵀ`（重みつき）。 */
  readonly n: number[]
  /** `Σ w d y`（値）。 */
  readonly b: number[]
  /** `Σ w d y_直流`（落とした直流）。 */
  readonly bd: number[]
  /** `Σ d dᵀ`（向きだけ。解けるかの判定に使う）。 */
  readonly g: number[]
}

function emptyNormal(): Normal {
  return { n: new Array(9).fill(0), b: [0, 0, 0], bd: [0, 0, 0], g: new Array(9).fill(0) }
}

function normalOf(s: SampleAt, weight: number): Normal {
  const out = emptyNormal()
  s.dirs.forEach((d, j) => {
    for (let r = 0; r < 3; r++) {
      out.b[r]! += weight * d[r] * s.value[j]!
      out.bd[r]! += weight * d[r] * s.dc[j]!
      for (let c = 0; c < 3; c++) {
        out.n[r * 3 + c]! += weight * d[r] * d[c]
        out.g[r * 3 + c]! += d[r] * d[c]
      }
    }
  })
  return out
}

function addNormal(acc: Normal, x: Normal, sign: 1 | -1): Normal {
  return {
    n: acc.n.map((v, i) => v + sign * x.n[i]!),
    b: acc.b.map((v, i) => v + sign * x.b[i]!),
    bd: acc.bd.map((v, i) => v + sign * x.bd[i]!),
    g: acc.g.map((v, i) => v + sign * x.g[i]!),
  }
}

function toMat3(m: readonly number[]): Mat3 {
  return [
    [m[0]!, m[1]!, m[2]!],
    [m[3]!, m[4]!, m[5]!],
    [m[6]!, m[7]!, m[8]!],
  ]
}

/** 目盛り 1 点ぶんの解。**成分ごとに、解けたかが違いうる。** */
interface PointSolution {
  /** 解いた値（東・北・上）。**解けなかった成分は NaN**（{@link FUSION_MIN_DIRECTION_INFO}）。 */
  readonly a: Vec3
  /** 落とした直流を同じように解いた値。`a` と同じ成分が NaN。 */
  readonly dc: Vec3
  /** 3 方向とも散っている（`G` のいちばん小さい固有値が {@link FUSION_MIN_DIRECTION_INFO} 以上）。震度はここでだけ流す。 */
  readonly full: boolean
  /** 向き `d` へ写した値（`d · a`）。**その向きを解けないなら null**（成分と同じ判定を `d` へ当てる）。 */
  project(d: Vec3): number | null
}

const AXIS_UNIT: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

/** 1〜3 元の連立方程式 `m c = r`（`m` は正定値の対称行列）。解けなければ null。 */
function solveSmall(m: readonly (readonly number[])[], r: readonly number[]): readonly number[] | null {
  if (m.length === 1) {
    const c = r[0]! / m[0]![0]!
    return Number.isFinite(c) ? [c] : null
  }
  if (m.length === 2) {
    const det = m[0]![0]! * m[1]![1]! - m[0]![1]! * m[1]![0]!
    if (!(det > 0)) return null
    return [(m[1]![1]! * r[0]! - m[0]![1]! * r[1]!) / det, (m[0]![0]! * r[1]! - m[1]![0]! * r[0]!) / det]
  }
  const inverse = invert3(m as unknown as Mat3)
  if (inverse === null) return null
  return multiplyMatVec3(inverse, r as unknown as Vec3)
}

/**
 * 目盛り 1 点を解く。**値を 1 つも出せなければ null。**
 *
 * **測っている向き（`G` の固有値が {@link UNSEEN_DIRECTION_INFO} 以上の固有の向き）の張る部分で
 * 解く**（`a = V c`、`(Vᵀ N V) c = Vᵀ b`）。3 方向とも測っていれば `a = N⁻¹ b` そのもの。
 * 測っていない向き（水平の台だけのときの上）は、データに 1 つも現れないので解かない ——
 * そこへ値を置かないことは、その向きを 0 と決めつけることではない（**その向きに掛かる成分は
 * 出さない**ので、0 と決めつけた値は外へ出ない）。
 *
 * **成分ごとに出すかを決めるのは雑音の倍率**（`G` の測っている部分の逆を、その成分へ当てた値）。
 * 弱いながら測っている向き（平面からわずかに傾いた台）も解きに入れるので、東・北はその向きの
 * 揺れに引きずられない —— 0 と決めつけて解くと、傾いた軸に乗った上の揺れが東へ漏れる。
 */
function solveNormal(x: Normal): PointSolution | null {
  const eig = eigenSym3(toMat3(x.g))
  if (eig === null) return null
  const seen: Vec3[] = []
  const seenInfo: number[] = []
  const unseen: Vec3[] = []
  eig.vectors.forEach((v, k) => {
    if (eig.values[k]! >= UNSEEN_DIRECTION_INFO) {
      seen.push(v)
      seenInfo.push(eig.values[k]!)
    } else {
      unseen.push(v)
    }
  })
  if (seen.length === 0) return null

  let full: Vec3
  let fullDc: Vec3
  if (seen.length === 3) {
    // **3 方向とも測っていれば、そのまま `N⁻¹ b`。** 3 軸のセンサーだけの観測点は、以前の
    // 「成分ごとの重み付き平均」と同じ計算の順で同じ値になる。
    const inverse = invert3(toMat3(x.n))
    if (inverse === null) return null
    full = multiplyMatVec3(inverse, [x.b[0]!, x.b[1]!, x.b[2]!])
    fullDc = multiplyMatVec3(inverse, [x.bd[0]!, x.bd[1]!, x.bd[2]!])
  } else {
    const n = toMat3(x.n)
    const m = seen.map((vi) => seen.map((vj) => dot3(vi, multiplyMatVec3(n, vj))))
    const c = solveSmall(m, seen.map((v) => dot3(v, [x.b[0]!, x.b[1]!, x.b[2]!])))
    const cd = solveSmall(m, seen.map((v) => dot3(v, [x.bd[0]!, x.bd[1]!, x.bd[2]!])))
    if (c === null || cd === null) return null
    const combine = (coef: readonly number[]): Vec3 => {
      const out: [number, number, number] = [0, 0, 0]
      seen.forEach((v, i) => {
        for (let axis = 0; axis < 3; axis++) out[axis] += coef[i]! * v[axis]
      })
      return out
    }
    full = combine(c)
    fullDc = combine(cd)
  }
  if (![...full, ...fullDc].every((v) => Number.isFinite(v))) return null

  /** 向き `d` の雑音の倍率の 2 乗（1 軸で真っすぐ測ったときを 1）。測っていない向きに掛かれば無限大。 */
  const noiseGain = (d: Vec3): number => {
    for (const z of unseen) if (Math.abs(dot3(d, z)) > UNSEEN_LEAK_MAX) return Number.POSITIVE_INFINITY
    let gain = 0
    seen.forEach((v, i) => {
      gain += dot3(d, v) ** 2 / seenInfo[i]!
    })
    return gain
  }
  const solvable = (d: Vec3): boolean => noiseGain(d) <= 1 / FUSION_MIN_DIRECTION_INFO
  const mask = (v: Vec3): Vec3 => [
    solvable(AXIS_UNIT[0]!) ? v[0] : Number.NaN,
    solvable(AXIS_UNIT[1]!) ? v[1] : Number.NaN,
    solvable(AXIS_UNIT[2]!) ? v[2] : Number.NaN,
  ]
  const a = mask(full)
  if (!a.some((v) => Number.isFinite(v))) return null
  return {
    a,
    dc: mask(fullDc),
    full: eig.values[0]! >= FUSION_MIN_DIRECTION_INFO,
    project: (d) => (solvable(d) ? dot3(d, full) : null),
  }
}

/** 1 まとまりぶんの目盛りの計算結果。 */
interface GridChunk {
  readonly startK: number
  /** 3 方向とも解けた目盛り（震度を流す）。 */
  readonly included: boolean[]
  /** 1 成分でも値を出せた目盛り（合成波形を出す）。`included` を含む。 */
  readonly emitted: boolean[]
  readonly gal: [number[], number[], number[]]
  readonly dcGal: [number[], number[], number[]]
  readonly axisCount: [number[], number[], number[]]
  readonly memberCount: number[]
  /** センサーごと・目盛りごとの値（差分を作るため）。引けなければ null。 */
  readonly perMember: (SampleAt | null)[][]
  /** センサーごと・目盛りごと・軸ごとのずれ（{@link SensorResidual}）。目盛りに値が無ければ null。 */
  readonly residual: ((number | null)[] | null)[][]
}

function computeChunk(group: Group, chunk: number): GridChunk {
  const startK = chunk * STATION_CHUNK_POINTS
  const gal: [number[], number[], number[]] = [[], [], []]
  const dcGal: [number[], number[], number[]] = [[], [], []]
  const axisCount: [number[], number[], number[]] = [[], [], []]
  const memberCount: number[] = []
  const included: boolean[] = []
  const emitted: boolean[] = []
  const perMember: (SampleAt | null)[][] = group.members.map(() => [])
  const residual: ((number | null)[] | null)[][] = group.members.map(() => [])
  for (let j = 0; j < STATION_CHUNK_POINTS; j++) {
    const tMs = (startK + j) * STATION_GRID_MS
    let total = emptyNormal()
    const own: (Normal | null)[] = []
    const count = [0, 0, 0]
    let members = 0
    group.members.forEach((m, mi) => {
      const s = m.samples.at(tMs)
      perMember[mi]!.push(s)
      if (s === null) {
        own.push(null)
        return
      }
      const x = normalOf(s, m.weight)
      own.push(x)
      total = addNormal(total, x, 1)
      members++
      for (let axis = 0; axis < GROUND_AXES; axis++) {
        if (x.g[axis * 4]! >= FUSION_MIN_DIRECTION_INFO) count[axis]!++
      }
    })
    const solved = solveNormal(total)
    for (let axis = 0; axis < GROUND_AXES; axis++) {
      axisCount[axis]!.push(count[axis]!)
      gal[axis]!.push(solved === null ? Number.NaN : solved.a[axis]!)
      dcGal[axis]!.push(solved === null ? Number.NaN : solved.dc[axis]!)
    }
    memberCount.push(members)
    included.push(solved !== null && solved.full)
    emitted.push(solved !== null)
    if (members > 0 && !(solved !== null && solved.full)) group.unsolvedPoints++

    // **自分を除いて解く**（{@link SensorResidual}）。全体の足し込みから、その台のぶんだけを引く。
    group.members.forEach((_, mi) => {
      const s = perMember[mi]![j]!
      const x = own[mi]!
      if (s === null || x === null) {
        residual[mi]!.push(null)
        return
      }
      const others = solveNormal(addNormal(total, x, -1))
      residual[mi]!.push(
        s.dirs.map((d, axis) => {
          // **その軸の向きをほかの台で解けなければ null。** 3 成分すべてが解けている必要はない ——
          // 水平の軸のずれは、ほかの台が水平を解けていれば出せる。
          const projected = others === null ? null : others.project(d)
          return projected === null ? null : s.value[axis]! - projected
        }),
      )
    })
  }
  return { startK, included, emitted, gal, dcGal, axisCount, memberCount, perMember, residual }
}

/**
 * 値を出せた目盛りの、続いている範囲 `[from, to)` の一覧。**3 方向とも解けたか（`full`）が
 * 変わるところでも切る** —— 震度を流すのは 3 方向とも解けた範囲だけなので、1 つの範囲の中で
 * 流す・流さないが混ざらないように。
 */
function runsOf(grid: GridChunk): { readonly from: number; readonly to: number; readonly full: boolean }[] {
  const runs: { from: number; to: number; full: boolean }[] = []
  let from = -1
  let full = false
  const n = grid.emitted.length
  for (let j = 0; j <= n; j++) {
    const ok = j < n && grid.emitted[j]!
    const isFull = ok && grid.included[j]!
    if (from >= 0 && (!ok || isFull !== full)) {
      runs.push({ from, to: j, full })
      from = -1
    }
    if (ok && from < 0) {
      from = j
      full = isFull
    }
  }
  return runs
}

/**
 * 3 軸のセンサーの、軸の値から東・北・上を引く行列（`dirs` を行に並べた行列の逆）。
 * **向きが変わったときだけ作り直す。** 解けない向きなら null。
 */
function groundInverseOf(member: Member, dirs: readonly Vec3[]): Mat3 | null {
  if (dirs.length !== PAIR_DIFF_AXES) return null
  if (member.groundOf !== null && member.groundOf.dirs === dirs) return member.groundOf.inverse
  const inverse = invert3([dirs[0]!, dirs[1]!, dirs[2]!])
  member.groundOf = { dirs, inverse }
  return inverse
}

/**
 * 3 軸のセンサーどうしの全ペアの差分 `d=(a1-a2)/2` を作る（東・北・上）。
 *
 * **差も直流を引いた後の値から作る。** 用途はセンサー自己ノイズの推定と異常センサーの
 * 検出なので、取り付けの向きや感度のずれ（実機では Z 軸で最大 538 gal）が差を
 * 支配したままでは何も見分けられない。
 */
function buildPairDiffs(group: Group, grid: GridChunk, from: number, to: number): SensorPairDiff[] {
  const out: SensorPairDiff[] = []
  const groundAt = (mi: number, j: number): Vec3 | null => {
    const s = grid.perMember[mi]![j]!
    if (s === null) return null
    const inverse = groundInverseOf(group.members[mi]!, s.dirs)
    if (inverse === null) return null
    return multiplyMatVec3(inverse, [s.value[0]!, s.value[1]!, s.value[2]!])
  }
  const threeAxis = group.members.map((m, mi) => ({ m, mi })).filter(({ m }) => m.axisCount === PAIR_DIFF_AXES)
  for (let a = 0; a < threeAxis.length; a++) {
    for (let b = a + 1; b < threeAxis.length; b++) {
      const ma = threeAxis[a]!
      const mb = threeAxis[b]!
      const diff: [(number | null)[], (number | null)[], (number | null)[]] = [[], [], []]
      for (let j = from; j < to; j++) {
        const va = groundAt(ma.mi, j)
        const vb = groundAt(mb.mi, j)
        for (let axis = 0; axis < GROUND_AXES; axis++) {
          diff[axis]!.push(va !== null && vb !== null ? (va[axis] - vb[axis]) / 2 : null)
        }
      }
      const k = grid.startK + from
      out.push({
        stationId: group.stationId,
        memberA: ma.m.ref,
        memberB: mb.m.ref,
        firstSampleIndex: k,
        firstSampleMs: k * STATION_GRID_MS,
        msPerSample: STATION_GRID_MS,
        diffGal: diff,
      })
    }
  }
  return out
}

/**
 * センサーごとのずれを、続いている範囲 `[from, to)` へ切り出す。
 *
 * **向きはその範囲で最初に値を持った目盛りのもの。** 範囲の途中で向きが変わった（校正が変わった）
 * 目盛りは null にする —— 違う向きの値を 1 本の線に並べると、軸の意味が途中で入れ替わる。
 * 範囲の中で値を 1 つも持たない台は、いま届いている向きで全部 null を返す。
 */
function buildResiduals(group: Group, grid: GridChunk, from: number, to: number): SensorResidual[] {
  const out: SensorResidual[] = []
  const k = grid.startK + from
  group.members.forEach((m, mi) => {
    if (m.dirs === null || m.channels === null) return
    let dirs: readonly Vec3[] = m.dirs
    for (let j = from; j < to; j++) {
      const s = grid.perMember[mi]![j]!
      if (s !== null) {
        dirs = s.dirs
        break
      }
    }
    const axes = dirs.map((direction, axis) => ({
      direction,
      residualGal: Array.from({ length: to - from }, (_, i): number | null => {
        const s = grid.perMember[mi]![from + i]!
        const r = grid.residual[mi]![from + i]!
        if (s === null || r === null || s.dirs !== dirs) return null
        return r[axis] ?? null
      }),
    }))
    out.push({
      stationId: group.stationId,
      member: m.ref,
      firstSampleIndex: k,
      firstSampleMs: k * STATION_GRID_MS,
      msPerSample: STATION_GRID_MS,
      channels: m.channels,
      axes,
    })
  })
  return out
}

/** `IntensityPoint` を絶対時刻へ戻し、非有限を弾く。`group.unusableCount` を進める副作用を持つ。 */
function toStationReading(group: Group, origin: number, p: IntensityPoint): StationIntensityReading {
  const normalized = normalizeIntensity(p.intensity)
  if (normalized.unusable) group.unusableCount++
  return {
    stationId: group.stationId,
    atMs: (origin + p.endSampleIndex) * STATION_GRID_MS,
    intensity: normalized.value,
  }
}

interface EndGroupStreamResult {
  readonly readings: readonly StationIntensityReading[]
  readonly failure: StationCloseFailure | null
}

/**
 * グループの合成の流し込みを締める。**残っていた震度と、締めくくりの成否を返す。**
 *
 * いまの方式（リアルタイム震度）は刻みの位置で必ず答えを出すので、`IntensityStream.end()`
 * が返す震度は無い。それでも呼ぶのは、**締めた流し込みへ続きを渡さないための区切り**として。
 *
 * **失敗を `group.streamError` へ直接書かない。** 呼び出し元はこの直後に作り直し、その成否で
 * `group.streamError` を書き換える —— ここで書いても、その一手で消える。戻り値で返す。
 *
 * **この関数自体は投げない。** 本体はまるごと 1 つの try/catch で覆われているので、
 * `group.stream.end()` の外へ処理を足すなら、その処理もこの try の内側へ入れること。
 */
function endGroupStream(group: Group): EndGroupStreamResult {
  if (group.stream === null || group.streamOrigin === null) {
    group.stream = null
    group.streamOrigin = null
    return { readings: [], failure: null }
  }
  const origin = group.streamOrigin
  const readings: StationIntensityReading[] = []
  let failure: StationCloseFailure | null = null
  try {
    for (const p of group.stream.end()) readings.push(toStationReading(group, origin, p))
  } catch (error) {
    failure = { stationId: group.stationId, detail: messageOf(error) }
  }
  group.stream = null
  // **原点も一緒に落とす。** 残すと、次に作った流し込み（位置 0 から数え直す）へ
  // 古い原点を当てることになり、答えの時刻が原点の差だけずれる。
  group.streamOrigin = null
  return { readings, failure }
}

/** 2 つの向きの並びが同じか（値で比べる）。 */
function sameDirections(a: readonly Vec3[], b: readonly Vec3[]): boolean {
  if (a.length !== b.length) return false
  return a.every((d, j) => d[0] === b[j]![0] && d[1] === b[j]![1] && d[2] === b[j]![2])
}

export interface SensorFusionOptions {
  /** 直流を追う窓の長さ（秒）。既定は {@link FUSION_DC_WINDOW_SEC}。 */
  readonly dcWindowSec?: number
  readonly stepSec?: number
  /** センサーの到着を待つ上限（ミリ秒）。既定は {@link FUSION_WAIT_MS_DEFAULT}。 */
  readonly waitMs?: number
}

export class SensorFusion {
  private readonly dcWindowSec: number
  private readonly stepSec: number
  private readonly waitMs: number
  private readonly groupByMemberKey = new Map<string, { group: Group; member: Member }>()
  private readonly groups: Group[]
  /** `closeAll()` を呼んだか。**呼んだあとの `ingest()` は誤用として止める。** */
  private closed = false

  constructor(config: StationConfig, options: SensorFusionOptions = {}) {
    this.dcWindowSec = options.dcWindowSec ?? FUSION_DC_WINDOW_SEC
    this.stepSec = options.stepSec ?? STEP_SEC_DEFAULT
    this.waitMs = options.waitMs ?? FUSION_WAIT_MS_DEFAULT
    this.groups = buildGroups(config)
    for (const group of this.groups) {
      for (const member of group.members) {
        this.groupByMemberKey.set(memberKeyOf(member.ref.boardKey, member.ref.sensorId), { group, member })
      }
    }
  }

  /**
   * 合成グループが組めた観測点の一覧。**`stationConfig.ts` の
   * `stationsWithMultipleBoards` とは判定基準が違う**——こちらは各基板の `sensors[]` に
   * `sensorId` が明示列挙されている必要がある。突き合わせは `main.ts` の起動時が持つ。
   */
  get groupedStationIds(): readonly string[] {
    return this.groups.map((g) => g.stationId)
  }

  /**
   * そのセンサーの直流の追い方を引く（無ければ作る）。窓の長さは `dcWindowSec`、
   * サンプリング周波数は届いた刻みから引く。**一度作ったら容量は変えない**
   * （作り直せば溜めた直流を捨てることになり、そのほうが害が大きい）。
   */
  private trackerFor(member: Member, msPerSample: number): DcTracker {
    if (member.dc !== null) return member.dc
    const capacity = Math.max(1, samplesForSeconds(this.dcWindowSec, 1000 / msPerSample))
    member.dc = new DcTracker(capacity, member.axisCount)
    return member.dc
  }

  /**
   * 波形が 1 まとまり届いた。**投げない**（`closeAll()` のあとを除く）。揃ったまとまりを
   * 0 個以上返す。
   *
   * 観測点に属さない、または相方が居ない（グループを作れなかった）センサーは
   * 素通りする——単独のセンサーは合成の対象にならない。
   *
   * **`closeAll()` のあとに呼んではいけない**（流し込みを締めてあるので、続きを渡すと
   * 合成の震度だけが理由も残らず出なくなる）。
   *
   * `receivedAtMs` はホストがこのまとまりのパケットを受け取った時刻。これより
   * {@link FUSION_MAX_FUTURE_MS} を超えて先を名乗るサンプルは混ぜない。**記録に受け取った時刻が
   * 残っていない古い控えを作り直すときは `null`** を渡す（その場合だけ、この判定をしない）。
   */
  ingest(wave: WaveChunk, receivedAtMs: number | null): readonly FusionOutcome[] {
    if (this.closed) throw new Error('closeAll() のあとに ingest() は呼べない')
    const found = this.groupByMemberKey.get(memberKeyOf(wave.boardKey, wave.sensorId))
    if (found === undefined) return []
    const { group, member } = found
    // **設定と軸の本数が違うまとまりは混ぜない**（校正が解けなかったセンサーは軸が空で来る）。
    // 食い違いそのものはセンサーの行（`axisMismatch`）が知らせる。
    if (wave.axes.length !== member.axisCount) return []
    const n = wave.axes[0]!.gal.length
    if (n === 0 || wave.axes.some((a) => a.gal.length !== n)) return []

    // **測る向きは、同じ向きの間は同じ配列を使い回す**（サンプルの向きを参照で見分けるため）。
    // 変わったら（校正の設定が変わった）直流も追い直す —— 違う向きの値の直流は混ぜられない。
    const incoming = wave.axes.map((a) => a.direction)
    if (member.dirs === null || !sameDirections(member.dirs, incoming)) {
      member.dirs = incoming
      member.dc = null
    }
    member.channels = wave.channels
    const dirs = member.dirs

    // **直流はここで落とす。届いたサンプルは全部通す**（遅すぎて混ぜない分も）——
    // 直流の推定を途切れさせないため。
    const tracker = this.trackerFor(member, wave.msPerSample)
    const times: number[] = new Array(n)
    const values: number[][] = wave.axes.map(() => new Array(n))
    const dcs: number[][] = wave.axes.map(() => new Array(n))
    for (let i = 0; i < n; i++) {
      times[i] = wave.firstSampleMs + i * wave.msPerSample
      const raw = wave.axes.map((a) => a.gal[i]!)
      const after = tracker.step(raw)
      for (let axis = 0; axis < member.axisCount; axis++) {
        values[axis]![i] = after[axis]!
        // 引いた直流は差で持つ——`tracker.dc` を別に読むと、次のサンプルで動いた後の値を拾う。
        dcs[axis]![i] = raw[axis]! - after[axis]!
      }
    }

    // **一度出したまとまりより前は混ぜない。** 次のまとまりの最初の目盛りを挟む 1 つ前の
    // サンプルまでは受け取る（補間に要る）。
    // **受け取った時刻より先を名乗る分は混ぜない**（その台の時計が壊れている）。時刻は増える一方
    // なので、混ぜてよいのは頭から `to` まで。
    let to = n
    if (receivedAtMs !== null) {
      const limit = receivedAtMs + FUSION_MAX_FUTURE_MS
      while (to > 0 && times[to - 1]! > limit) to--
      group.futureSamples += n - to
    }
    let from = 0
    if (group.nextChunk !== null) {
      const cutoff = group.nextChunk * CHUNK_MS - 2 * wave.msPerSample
      while (from < to && times[from]! < cutoff) from++
      group.lateSamples += from
    }
    if (from < to) {
      group.discarded += member.samples.insert(times, wave.msPerSample, dirs, values, dcs, from, to)
      const last = times[to - 1]!
      if (member.lastSampleMs === null || last > member.lastSampleMs) member.lastSampleMs = last
      if (group.firstSeenMs === null) group.firstSeenMs = times[from]!
    }
    return this.emitReady(group, false)
  }

  /**
   * 出せるまとまりを、古い順に出せるだけ出す。
   *
   * `drain`（`closeAll()`）のときは待たない —— 届いたデータの末尾まで流し切る。
   *
   * **データの無いまとまりは 1 つずつ回さない。** 次のサンプルのあるまとまりまで飛ぶ ——
   * 全員の時刻が大きく飛んだとき（長い停電の後）に、空のまとまりを何百万も回さないため。
   */
  private emitReady(group: Group, drain: boolean): FusionOutcome[] {
    const outcomes: FusionOutcome[] = []
    const clock = clockOf(group)
    if (clock === null) return outcomes
    if (group.nextChunk === null) {
      let first: number | null = null
      for (const m of group.members) {
        const f = m.samples.firstMs
        if (f !== null && (first === null || f < first)) first = f
      }
      if (first === null) return outcomes
      group.nextChunk = Math.floor(first / CHUNK_MS)
    }
    for (;;) {
      const chunk = group.nextChunk as number
      const startMs = chunk * CHUNK_MS
      const tailMs = startMs + CHUNK_MS - STATION_GRID_MS
      const covered = allLiveCover(group, clock, tailMs)
      if (!drain && !covered && clock < tailMs + this.waitMs) break

      let nextData: number | null = null
      for (const m of group.members) {
        const f = m.samples.firstAtOrAfter(startMs)
        if (f !== null && (nextData === null || f < nextData)) nextData = f
      }
      if (nextData === null) break
      if (nextData >= startMs + CHUNK_MS) {
        group.nextChunk = Math.floor(nextData / CHUNK_MS)
        continue
      }

      outcomes.push(...this.fuseChunk(group, chunk, covered))
      group.nextChunk = chunk + 1
      const keepFrom = group.nextChunk * CHUNK_MS
      for (const m of group.members) m.samples.trimBefore(keepFrom)
    }
    return outcomes
  }

  /** 1 まとまりを合成する。欠けで切れていれば、続いている範囲ごとに 1 つずつ返す。 */
  private fuseChunk(group: Group, chunk: number, covered: boolean): FusionOutcome[] {
    const grid = computeChunk(group, chunk)
    const outcomes: FusionOutcome[] = []
    for (const { from, to, full } of runsOf(grid)) {
      const k = grid.startK + from
      const len = to - from
      const gal: [number[], number[], number[]] = [
        grid.gal[0].slice(from, to),
        grid.gal[1].slice(from, to),
        grid.gal[2].slice(from, to),
      ]
      const dcGal: [number[], number[], number[]] = [
        grid.dcGal[0].slice(from, to),
        grid.dcGal[1].slice(from, to),
        grid.dcGal[2].slice(from, to),
      ]
      const axisMemberCount: [number[], number[], number[]] = [
        grid.axisCount[0].slice(from, to),
        grid.axisCount[1].slice(from, to),
        grid.axisCount[2].slice(from, to),
      ]
      const memberCount = grid.memberCount.slice(from, to)

      // **続いていなければ（欠けの後・最初の回）、古い流し込みを締めて作り直す。**
      // 締めて出た震度（前の流し込みの末尾ぶん）は、このまとまりの `readings` へ混ぜる。
      const readings: StationIntensityReading[] = []
      let closeFailure: StationCloseFailure | null = null
      let intensityStateChanged = false
      if (!full) {
        // **3 方向とも解けていない範囲では震度を流さない。** 流し込みはここで締め、続きを
        // 切る（`streamNext` を空ける）—— 次に 3 方向とも解けた範囲から作り直す。
        if (group.stream !== null) {
          intensityStateChanged = true
          const closed = endGroupStream(group)
          readings.push(...closed.readings)
          closeFailure = closed.failure
        }
        group.streamNext = null
      } else if (group.streamNext !== k) {
        intensityStateChanged = true
        const closed = endGroupStream(group)
        readings.push(...closed.readings)
        closeFailure = closed.failure
        try {
          group.stream = new IntensityStream({ sampleRateHz: 1000 / STATION_GRID_MS, stepSec: this.stepSec })
          group.streamOrigin = k
          group.streamError = null
        } catch (error) {
          group.stream = null
          group.streamOrigin = null
          group.streamError = messageOf(error)
        }
      }
      if (full && group.stream !== null && group.streamOrigin !== null) {
        const origin = group.streamOrigin
        try {
          for (const p of group.stream.push(k - origin, gal[0], gal[1], gal[2])) {
            readings.push(toStationReading(group, origin, p))
          }
        } catch (error) {
          // **投げない契約を守る。** 握りつぶさず理由を残し、次の欠けで作り直すまで合成の
          // 震度だけを見送る（波形・差分は投げていないのでそのまま返す）。**投げる直前まで
          // 溜まっていた分は `end()` で救い出す**（`push()` は投げたとき何も溜め込まない）。
          try {
            for (const p of group.stream.end()) readings.push(toStationReading(group, origin, p))
          } catch {
            // `end()` 自身は投げない実装。ここまで来て投げるなら push() の失敗が本題なので、二重に報せない。
          }
          group.stream = null
          group.streamOrigin = null
          group.streamError = messageOf(error)
          intensityStateChanged = true
        }
      }
      if (full) group.streamNext = k + len

      outcomes.push({
        fusedWave: {
          stationId: group.stationId,
          firstSampleIndex: k,
          firstSampleMs: k * STATION_GRID_MS,
          msPerSample: STATION_GRID_MS,
          gal,
          dcGal,
          memberCount,
          axisMemberCount,
        },
        pairDiffs: buildPairDiffs(group, grid, from, to),
        residuals: buildResiduals(group, grid, from, to),
        readings,
        intensitySkipReason: group.streamError,
        closeFailure,
        intensityStateChanged,
        allMembersCovered: covered,
      })
    }
    return outcomes
  }

  /**
   * すべての観測点の合成を締める。**終了時に呼ぶこと**（`IntensityPipeline.closeAll()` と同じ形）。
   *
   * **待たせていたまとまりは先に流し切る**（届いたデータの末尾まで）。捨てると、待っていた
   * ぶんの波形と震度が出ないまま消える。流し切った回は `ingest()` と同じ `FusionOutcome` の
   * まま返す（`SensorFusionClosing.drained`）。
   *
   * **この呼び出しのあとに `ingest()` を呼んではいけない。** 呼ぶと投げる。
   * **2 度目の `closeAll()` は何もしない**（空を返す）。締めくくりは投げない約束なので、誤って重ねて
   * 呼ばれても止めない。
   */
  closeAll(): SensorFusionClosing {
    if (this.closed) return { drained: [], readings: [], failures: [] }
    this.closed = true
    const drained: FusionOutcome[] = []
    const readings: StationIntensityReading[] = []
    const failures: StationCloseFailure[] = []
    for (const group of this.groups) {
      drained.push(...this.emitReady(group, true))
      const closed = endGroupStream(group)
      readings.push(...closed.readings)
      if (closed.failure !== null) failures.push(closed.failure)
    }
    return { drained, readings, failures }
  }

  /**
   * 数として出せない合成の計測震度を見た、全観測点ぶんの合計。
   *
   * `IntensityPipeline.unusableIntensities` と同じ役割・同じ境界（`normalizeIntensity`
   * が非有限を弾いた回数）。0 が正常。
   */
  get unusableIntensities(): number {
    let total = 0
    for (const group of this.groups) total += group.unusableCount
    return total
  }

  /**
   * 一度出したまとまりより前に届いて、ライブの合成へ混ぜなかったサンプルの数（全観測点の合計）。
   * **埋め直しは作り直し（`stationRewave.ts`）の仕事**で、ここが増えるのは異常ではない ——
   * 待ちの上限を超えて遅れた台があったことの記録。
   */
  get lateSamples(): number {
    let total = 0
    for (const group of this.groups) total += group.lateSamples
    return total
  }

  /**
   * 受け取った時刻より {@link FUSION_MAX_FUTURE_MS} を超えて先を名乗り、混ぜずに捨てたサンプルの数
   * （全観測点の合計）。**0 が正常。** 増えていれば、どれかの台の時計が壊れている。
   */
  get futureSamples(): number {
    let total = 0
    for (const group of this.groups) total += group.futureSamples
    return total
  }

  /**
   * 1 台が抱える上限（{@link MAX_SAMPLES_PER_MEMBER}）を超えて、古い側から落としたサンプルの数
   * （全観測点の合計）。**0 が正常。** 抱える幅はふだん数秒なので、増えていれば合成の前提が崩れている。
   */
  get discardedSamples(): number {
    let total = 0
    for (const group of this.groups) total += group.discarded
    return total
  }

  /**
   * 値を持つ台がいたのに、測る向きが 3 方向へ散っておらず解けなかった目盛りの数（全観測点の合計）。
   * **上だけ欠けた（東・北は出した）目盛りも数える** —— 震度はそこで出ない。**0 が正常。**
   * 増え続けるなら、設定の向きが 3 方向へ散っていないか（{@link findUnderdeterminedStations}）、
   * 上を測る台が止まっている。
   */
  get unsolvedPoints(): number {
    let total = 0
    for (const group of this.groups) total += group.unsolvedPoints
    return total
  }
}

/**
 * 設定の時点で、合成で解けない向きがある観測点（設定の並び順）。**有効なセンサーが 2 台以上ある
 * （合成を組む）観測点だけ**を見る —— 全員の軸の向きを束ねた `G` のいちばん小さい固有値が
 * {@link FUSION_MIN_DIRECTION_INFO} を下回るなら、全員が届いていても 3 方向とも解けることは無い。
 *
 * **届いた波形からは分からない形を、届く前に知らせるためのもの。** 水平の 2 軸の台だけを
 * 割り当てた観測点では震度が一度も出ないが、センサーは生きているように見える。
 * 向きは読み取りと同じ校正（`resolveCalibration`）で地面の向きへ直す。校正が解けない台は
 * 読み取りが波形を作らないので数えない。
 */
export function findUnderdeterminedStations(config: StationConfig): string[] {
  const byStation = new Map<string, { count: number; g: [number[], number[], number[]] }>()
  for (const board of config.boards) {
    for (const sensor of board.sensors) {
      if (!sensor.enabled) continue
      const entry = byStation.get(board.stationId) ?? {
        count: 0,
        g: [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ],
      }
      entry.count++
      byStation.set(board.stationId, entry)
      const { sensorId: _sensorId, ...calibration } = sensor
      const resolved = resolveCalibration(board.orientation, calibration)
      if (resolved === null) continue
      for (const axis of resolved.axes) {
        const [x, y, z] = axis.vector
        const length = Math.hypot(x, y, z)
        const d: Vec3 = [x / length, y / length, z / length]
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) entry.g[r]![c]! += d[r] * d[c]
      }
    }
  }
  const out: string[] = []
  for (const [stationId, entry] of byStation) {
    if (entry.count < 2) continue
    if (!(minEigenvalueSym3(entry.g as unknown as Mat3) >= FUSION_MIN_DIRECTION_INFO)) out.push(stationId)
  }
  return out
}
