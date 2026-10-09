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
// 合成はこの目盛りの 1 点ずつについて、**成分ごとに、その時刻の値を持っているセンサー
// 全員**から重み付きで混ぜる。設計の経緯は
// [`docs/seismo-station-fusion-design.md`](../../../docs/seismo-station-fusion-design.md)。
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
// - **成分ごとに混ぜる。** 重みも本数も成分ごとに持つ。今の台はどれも 3 軸なので
//   3 成分とも同じになるが、成分の揃わない台（2 軸）が混ざっても合成はこの形のまま動く
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
import type { WaveChunk } from './intensityPipeline'
import { normalizeIntensity } from './intensityPipeline'
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

const REQUIRED_AXES = 3

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
 * センサー 1 本ぶんの直流（重力）を追い、引いた値を返す。**窓は {@link FUSION_DC_WINDOW_SEC}。**
 *
 * **なぜ引くのか。** 合成は「値が引けたセンサーだけ」で平均するので、顔ぶれは
 * 目盛りごとに変わりうる。**各センサーの直流が揃っていないと、顔ぶれが 1 本入れ替わる
 * たびに平均の直流が跳ぶ** —— 実機では静止時の Z 軸が 662〜1200 gal に散っていて
 * （感度が未校正）、静止ノイズ 1.5 gal に対して数十 gal のステップが 100ms ごとに立ち、
 * 周期補正フィルタがそれを**実機で震度 4.36**（単体は 1.12〜1.24）として出していた
 * （2026-09-28・#362。実測値は `../../REQUIREMENTS.md` §7 の表）。
 *
 * **震度の計算側が引く直流では消えない。** あちらは流し込みの最初のサンプルを
 * 差し引くだけで、**途中で立つ段差はそのまま揺れとして通る**。段差を作らせないには、
 * 混ぜる前に各センサーから直流を落としておくしかない。
 */
export class DcTracker {
  private readonly bufs: readonly [Float64Array, Float64Array, Float64Array]
  private readonly sums: [number, number, number] = [0, 0, 0]
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
  constructor(capacity: number) {
    if (!(capacity >= 1)) throw new Error('capacity は 1 以上で指定すること')
    const n = Math.floor(capacity)
    this.bufs = [new Float64Array(n), new Float64Array(n), new Float64Array(n)]
  }

  /** いま引いている直流。**1 つも食わせていなければ 0**（引くものが無い）。 */
  get dc(): readonly [number, number, number] {
    if (this.filled === 0) return [0, 0, 0]
    return [this.sums[0] / this.filled, this.sums[1] / this.filled, this.sums[2] / this.filled]
  }

  /** 溜まっているサンプルの数。窓に満たないうちは、溜まった分だけの平均を引く。 */
  get sampleCount(): number {
    return this.filled
  }

  /**
   * 3 軸を 1 サンプル食わせ、**そのサンプルを含めた直流を引いた値**を返す。
   *
   * **窓が埋まるのを待たない。** 待つと、待っている間の値が直流ごと合成へ流れて
   * 同じ症状になる（しかも「まだ溜まっていない」ことは下流から見えない）。
   * 溜まった分の平均でも、跳びを作らないという目的は果たせる。
   */
  step(v0: number, v1: number, v2: number): [number, number, number] {
    const cap = this.bufs[0].length
    const values: readonly [number, number, number] = [v0, v1, v2]
    for (let axis = 0; axis < REQUIRED_AXES; axis++) {
      const buf = this.bufs[axis]
      if (this.filled === cap) this.sums[axis] -= buf[this.next]
      buf[this.next] = values[axis]
      this.sums[axis] += values[axis]
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
      for (let axis = 0; axis < REQUIRED_AXES; axis++) {
        const buf = this.bufs[axis]
        let s = 0
        for (let i = 0; i < this.filled; i++) s += buf[i]
        this.sums[axis] = s
      }
    }

    const dc = this.dc
    return [v0 - dc[0], v1 - dc[1], v2 - dc[2]]
  }
}

/** 補間で引いた 1 時刻ぶんの値（直流を引いた後）と、引いた直流。成分ごと。 */
interface SampleAt {
  readonly value: [number, number, number]
  readonly dc: [number, number, number]
}

/**
 * センサー 1 本ぶんのサンプルを、時刻順に抱える。**直流を引いた後の値と、引いた直流を持つ。**
 *
 * 先頭の捨て方は「出したまとまりの手前」まで（`trimBefore`）。**補間に要る 1 つ前の
 * サンプルは残す** —— 次のまとまりの最初の目盛りは、それと次のサンプルに挟まれる。
 */
class SampleStore {
  private t: number[] = []
  /** そのサンプルが属していたまとまりの刻み。補間でまたいでよい間隔を決める。 */
  private step: number[] = []
  private v: [number[], number[], number[]] = [[], [], []]
  private d: [number[], number[], number[]] = [[], [], []]
  private head = 0

  get size(): number {
    return this.t.length - this.head
  }

  get lastMs(): number | null {
    return this.size === 0 ? null : this.t[this.t.length - 1]
  }

  get firstMs(): number | null {
    return this.size === 0 ? null : this.t[this.head]
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
    values: readonly [readonly number[], readonly number[], readonly number[]],
    dcs: readonly [readonly number[], readonly number[], readonly number[]],
    from: number,
    to: number,
  ): number {
    if (from >= to) return 0
    const last = this.lastMs
    if (last === null || times[from] > last) {
      for (let i = from; i < to; i++) this.push(times[i], msPerSample, values, dcs, i)
    } else {
      this.mergeIn(times, msPerSample, values, dcs, from, to)
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
    values: readonly [readonly number[], readonly number[], readonly number[]],
    dcs: readonly [readonly number[], readonly number[], readonly number[]],
    i: number,
  ): void {
    this.t.push(tMs)
    this.step.push(msPerSample)
    for (let axis = 0; axis < REQUIRED_AXES; axis++) {
      this.v[axis].push(values[axis][i])
      this.d[axis].push(dcs[axis][i])
    }
  }

  private mergeIn(
    times: readonly number[],
    msPerSample: number,
    values: readonly [readonly number[], readonly number[], readonly number[]],
    dcs: readonly [readonly number[], readonly number[], readonly number[]],
    from: number,
    to: number,
  ): void {
    const lo = times[from] - msPerSample / 2
    const hi = times[to - 1] + msPerSample / 2
    type Row = { t: number; step: number; v: [number, number, number]; d: [number, number, number] }
    const rows: Row[] = []
    for (let i = this.head; i < this.t.length; i++) {
      if (this.t[i] >= lo && this.t[i] <= hi) continue
      rows.push({ t: this.t[i], step: this.step[i], v: [this.v[0][i], this.v[1][i], this.v[2][i]], d: [this.d[0][i], this.d[1][i], this.d[2][i]] })
    }
    for (let i = from; i < to; i++) {
      rows.push({ t: times[i], step: msPerSample, v: [values[0][i], values[1][i], values[2][i]], d: [dcs[0][i], dcs[1][i], dcs[2][i]] })
    }
    rows.sort((a, b) => a.t - b.t)
    this.t = rows.map((r) => r.t)
    this.step = rows.map((r) => r.step)
    this.v = [rows.map((r) => r.v[0]), rows.map((r) => r.v[1]), rows.map((r) => r.v[2])]
    this.d = [rows.map((r) => r.d[0]), rows.map((r) => r.d[1]), rows.map((r) => r.d[2])]
    this.head = 0
  }

  /** `ms` 以前のサンプルを、最後の 1 つを残して捨てる（補間に要る）。 */
  trimBefore(ms: number): void {
    while (this.head + 1 < this.t.length && this.t[this.head + 1] <= ms) this.head++
    this.compact()
  }

  private compact(): void {
    if (this.head < 1024) return
    this.t = this.t.slice(this.head)
    this.step = this.step.slice(this.head)
    this.v = [this.v[0].slice(this.head), this.v[1].slice(this.head), this.v[2].slice(this.head)]
    this.d = [this.d[0].slice(this.head), this.d[1].slice(this.head), this.d[2].slice(this.head)]
    this.head = 0
  }

  /** `ms` 以上で最初のサンプルの時刻。無ければ null。 */
  firstAtOrAfter(ms: number): number | null {
    const i = this.lowerBound(ms)
    return i < this.t.length ? this.t[i] : null
  }

  /** `ms` 以上で最初のサンプルの位置（無ければ末尾の次）。 */
  private lowerBound(ms: number): number {
    let lo = this.head
    let hi = this.t.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.t[mid] < ms) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * 時刻 `ms` の値を引く。**挟む 2 サンプルが無ければ null（外へ延ばさない）。**
   * 2 サンプルの間隔が刻みの {@link GAP_FACTOR} 倍を超えても null（間に欠けがある）。
   */
  at(ms: number): SampleAt | null {
    const i = this.lowerBound(ms)
    if (i < this.t.length && Math.abs(this.t[i] - ms) < 1e-6) {
      return { value: [this.v[0][i], this.v[1][i], this.v[2][i]], dc: [this.d[0][i], this.d[1][i], this.d[2][i]] }
    }
    const before = i - 1
    if (before < this.head || i >= this.t.length) return null
    const span = this.t[i] - this.t[before]
    if (span > GAP_FACTOR * Math.max(this.step[before], this.step[i])) return null
    const f = (ms - this.t[before]) / span
    const value: [number, number, number] = [0, 0, 0]
    const dc: [number, number, number] = [0, 0, 0]
    for (let axis = 0; axis < REQUIRED_AXES; axis++) {
      value[axis] = this.v[axis][before] + (this.v[axis][i] - this.v[axis][before]) * f
      dc[axis] = this.d[axis][before] + (this.d[axis][i] - this.d[axis][before]) * f
    }
    return { value, dc }
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
 * 観測点ひとつぶんの合成波形。**校正済み gal の重み付き平均**（REQUIREMENTS.md §7）。
 *
 * **刻みは常に {@link STATION_GRID_MS}、位置は観測点の目盛りの通し番号**
 * （`firstSampleMs === firstSampleIndex × STATION_GRID_MS`）。3 成分とも値がある目盛りだけを
 * 含む —— 欠けた目盛りでは、まとまりが切れる（次のまとまりの `firstSampleIndex` が飛ぶ）。
 */
export interface FusedWaveChunk {
  readonly stationId: string
  /** 観測点の目盛りの通し番号（`k`）。**センサーの区間の位置ではない。** */
  readonly firstSampleIndex: number
  readonly firstSampleMs: number
  readonly msPerSample: number
  /**
   * 重み付き平均の gal。`gal[axis][i]` が i 番目のサンプル。
   *
   * **直流（重力）を引いた変動分。** 混ぜる前に各センサーから落としてある
   * （`DcTracker` の説明を見ること）。落とさないと、顔ぶれが入れ替わるたびに
   * センサー間の直流差がステップとして乗る。
   */
  readonly gal: AxisRows<number>
  /**
   * 上の `gal` から落とした直流。**同じ重みで平均してある**ので、
   * `gal[axis][i] + dcGal[axis][i]` が「校正済み gal の重み付き平均」（落とす前の値）。
   *
   * **落とした値を捨てない。** 重力の向きと大きさは取り付けの診断に使える事実で、
   * 変動分だけにすると下流からは二度と引けない。
   */
  readonly dcGal: AxisRows<number>
  /**
   * 各目盛りへ実際に効いたセンサーの数。**3 成分のうち最も少ない成分の本数。**
   *
   * 届いていない台が平均から外れたことを、値の形だけでは下流が見分けられない
   * ——1 台の値がそのまま「合成」を名乗ることになるので、実際に混ぜた数を添える。
   */
  readonly memberCount: readonly number[]
  /** 成分ごとの本数。**成分の揃わない台（2 軸）が混ざったときに `memberCount` と分かれる。** */
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
 */
export interface SensorPairDiff {
  readonly stationId: string
  readonly memberA: SensorMemberRef
  readonly memberB: SensorMemberRef
  readonly firstSampleIndex: number
  readonly firstSampleMs: number
  readonly msPerSample: number
  /** 両方の値が揃う目盛りだけ埋まる。片方でも無ければ null（外挿しない）。 */
  readonly diffGal: AxisRows<number | null>
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
  /** 成分ごとの重み（ノイズ密度の逆数分散）。 */
  readonly weights: readonly [number, number, number]
  /**
   * どの成分を測っているか。**今の台はどれも 3 軸なので全部真。** 成分の揃わない台
   * （2 軸）を受けるときは、設定から引いてここへ入れる。
   */
  readonly axes: readonly [boolean, boolean, boolean]
  readonly samples: SampleStore
  /** 届いた中でいちばん新しいサンプルの時刻。「生きているか」「揃ったか」に使う。 */
  lastSampleMs: number | null
  /**
   * 直流の追い方。**区間が切れても捨てない** —— 追っているのは物理量（重力）そのもので、
   * 捨てると、そのセンサーだけ直流の推定が 0 から立ち上がり直して**切れ目のたびに跳びを作る**。
   */
  dc: DcTracker | null
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
}

/**
 * 設定から観測点ごとのグループを作る。**`enabled` な 3 軸のセンサーだけを見る。**
 *
 * 2 台に満たない観測点は組まない——合成する相手が居ない。
 *
 * **2 軸のセンサーはまだ顔ぶれに入れない**（合成は東・北・上を 1 台で解ける値しか混ぜない）。
 * 入れると、一度も値を届けない台として「届くはずの台」に数えられ、観測点に最初に値が届いてから
 * しばらくは、その台を待って合成が遅れる（`isLive`）。
 */
function buildGroups(config: StationConfig): Group[] {
  const listByStation = new Map<string, { boardKey: BoardKey; sensorId: string; noiseDensity: number | null }[]>()
  for (const board of config.boards) {
    for (const sensor of board.sensors) {
      if (!sensor.enabled || sensor.axes.length !== REQUIRED_AXES) continue
      const list = listByStation.get(board.stationId) ?? []
      list.push({ boardKey: board.boardKey, sensorId: sensor.sensorId, noiseDensity: sensor.noiseDensity })
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
    const members: Member[] = list.map((m) => {
      const w = allKnown ? 1 / (m.noiseDensity as number) ** 2 : 1
      return {
        ref: { boardKey: m.boardKey, sensorId: m.sensorId },
        weights: [w, w, w],
        axes: [true, true, true],
        samples: new SampleStore(),
        lastSampleMs: null,
        dc: null,
      }
    })
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

/** 1 まとまりぶんの目盛りの計算結果。`included[j]` が偽の目盛りは欠け。 */
interface GridChunk {
  readonly startK: number
  readonly included: boolean[]
  readonly gal: [number[], number[], number[]]
  readonly dcGal: [number[], number[], number[]]
  readonly axisCount: [number[], number[], number[]]
  /** センサーごと・目盛りごとの値（差分を作るため）。引けなければ null。 */
  readonly perMember: (SampleAt | null)[][]
}

function computeChunk(group: Group, chunk: number): GridChunk {
  const startK = chunk * STATION_CHUNK_POINTS
  const gal: [number[], number[], number[]] = [[], [], []]
  const dcGal: [number[], number[], number[]] = [[], [], []]
  const axisCount: [number[], number[], number[]] = [[], [], []]
  const included: boolean[] = []
  const perMember: (SampleAt | null)[][] = group.members.map(() => [])
  for (let j = 0; j < STATION_CHUNK_POINTS; j++) {
    const tMs = (startK + j) * STATION_GRID_MS
    const vSum = [0, 0, 0]
    const dSum = [0, 0, 0]
    const wSum = [0, 0, 0]
    const count = [0, 0, 0]
    group.members.forEach((m, mi) => {
      const s = m.samples.at(tMs)
      perMember[mi].push(s)
      if (s === null) return
      for (let axis = 0; axis < REQUIRED_AXES; axis++) {
        if (!m.axes[axis]) continue
        const w = m.weights[axis]
        vSum[axis] += w * s.value[axis]
        dSum[axis] += w * s.dc[axis]
        wSum[axis] += w
        count[axis]++
      }
    })
    let ok = true
    for (let axis = 0; axis < REQUIRED_AXES; axis++) {
      axisCount[axis].push(count[axis])
      if (count[axis] === 0) {
        ok = false
        gal[axis].push(Number.NaN)
        dcGal[axis].push(Number.NaN)
      } else {
        gal[axis].push(vSum[axis] / wSum[axis])
        dcGal[axis].push(dSum[axis] / wSum[axis])
      }
    }
    included.push(ok)
  }
  return { startK, included, gal, dcGal, axisCount, perMember }
}

/** 3 成分とも値がある目盛りの、続いている範囲 `[from, to)` の一覧。 */
function runsOf(included: readonly boolean[]): [number, number][] {
  const runs: [number, number][] = []
  let from = -1
  for (let j = 0; j <= included.length; j++) {
    const ok = j < included.length && included[j]
    if (ok && from < 0) from = j
    if (!ok && from >= 0) {
      runs.push([from, j])
      from = -1
    }
  }
  return runs
}

/**
 * 全ペアの差分 `d=(a1-a2)/2` を作る。
 *
 * **差も直流を引いた後の値から作る。** 用途はセンサー自己ノイズの推定と異常センサーの
 * 検出なので、取り付けの向きや感度のずれ（実機では Z 軸で最大 538 gal）が差を
 * 支配したままでは何も見分けられない。**同じ成分を両方が測っている成分だけ**値が立つ。
 */
function buildPairDiffs(group: Group, grid: GridChunk, from: number, to: number): SensorPairDiff[] {
  const out: SensorPairDiff[] = []
  for (let a = 0; a < group.members.length; a++) {
    for (let b = a + 1; b < group.members.length; b++) {
      const ma = group.members[a]
      const mb = group.members[b]
      const diff: [(number | null)[], (number | null)[], (number | null)[]] = [[], [], []]
      for (let j = from; j < to; j++) {
        const va = grid.perMember[a][j]
        const vb = grid.perMember[b][j]
        for (let axis = 0; axis < REQUIRED_AXES; axis++) {
          const both = va !== null && vb !== null && ma.axes[axis] && mb.axes[axis]
          diff[axis].push(both ? (va.value[axis] - vb.value[axis]) / 2 : null)
        }
      }
      const k = grid.startK + from
      out.push({
        stationId: group.stationId,
        memberA: ma.ref,
        memberB: mb.ref,
        firstSampleIndex: k,
        firstSampleMs: k * STATION_GRID_MS,
        msPerSample: STATION_GRID_MS,
        diffGal: diff,
      })
    }
  }
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
    member.dc = new DcTracker(capacity)
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
    // **地面の 3 成分を解けないまとまりは混ぜない**（2 軸のセンサーは顔ぶれに入れないので、
    // ここへ来るのは設定と食い違った回だけ）。
    const ground = wave.ground
    if (ground === null) return []
    const n = ground[0].length
    if (n === 0) return []

    // **直流はここで落とす。届いたサンプルは全部通す**（遅すぎて混ぜない分も）——
    // 直流の推定を途切れさせないため。
    const tracker = this.trackerFor(member, wave.msPerSample)
    const times: number[] = new Array(n)
    const values: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
    const dcs: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
    for (let i = 0; i < n; i++) {
      times[i] = wave.firstSampleMs + i * wave.msPerSample
      const after = tracker.step(ground[0][i], ground[1][i], ground[2][i])
      for (let axis = 0; axis < REQUIRED_AXES; axis++) {
        values[axis][i] = after[axis]
        // 引いた直流は差で持つ——`tracker.dc` を別に読むと、次のサンプルで動いた後の値を拾う。
        dcs[axis][i] = ground[axis][i] - after[axis]
      }
    }

    // **一度出したまとまりより前は混ぜない。** 次のまとまりの最初の目盛りを挟む 1 つ前の
    // サンプルまでは受け取る（補間に要る）。
    // **受け取った時刻より先を名乗る分は混ぜない**（その台の時計が壊れている）。時刻は増える一方
    // なので、混ぜてよいのは頭から `to` まで。
    let to = n
    if (receivedAtMs !== null) {
      const limit = receivedAtMs + FUSION_MAX_FUTURE_MS
      while (to > 0 && times[to - 1] > limit) to--
      group.futureSamples += n - to
    }
    let from = 0
    if (group.nextChunk !== null) {
      const cutoff = group.nextChunk * CHUNK_MS - 2 * wave.msPerSample
      while (from < to && times[from] < cutoff) from++
      group.lateSamples += from
    }
    if (from < to) {
      group.discarded += member.samples.insert(times, wave.msPerSample, values, dcs, from, to)
      const last = times[to - 1]
      if (member.lastSampleMs === null || last > member.lastSampleMs) member.lastSampleMs = last
      if (group.firstSeenMs === null) group.firstSeenMs = times[from]
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
    for (const [from, to] of runsOf(grid.included)) {
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
      const memberCount = axisMemberCount[0].map((c, i) => Math.min(c, axisMemberCount[1][i], axisMemberCount[2][i]))

      // **続いていなければ（欠けの後・最初の回）、古い流し込みを締めて作り直す。**
      // 締めて出た震度（前の流し込みの末尾ぶん）は、このまとまりの `readings` へ混ぜる。
      const readings: StationIntensityReading[] = []
      let closeFailure: StationCloseFailure | null = null
      let intensityStateChanged = false
      if (group.streamNext !== k) {
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
      if (group.stream !== null && group.streamOrigin !== null) {
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
      group.streamNext = k + len

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
}
