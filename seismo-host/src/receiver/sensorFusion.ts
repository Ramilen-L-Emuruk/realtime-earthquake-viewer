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
// ## 時刻の整列（設計判断。要件原文には無い）
//
// 各センサーの `firstSampleMs + i*msPerSample` は区間の当てはめ
// （`../timebase/segmenter.ts` の `IncrementalLineFit`）が出す絶対時刻軸で、実測では
// 基板間の刻みのずれは公称値の 0.06% 程度（`../timebase/segmenter.ts` の
// `TIMEBASE_CONSISTENCY_MS` コメントが引用する実測を参照）。
// 半サンプル分にも届かないので、**補間はせず、最寄りのサンプルへ丸めて突き合わせる**
// —— 複雑さに見合わない。
//
// **1 台を「駆動役」に固定し、その到着だけが合成を進める。** #93 の「役割分担」
// （最も低雑音の 1 台を基準器とする）をそのまま時刻の基準にも流用した——
// 複数の到着イベントがそれぞれ別の合成区間を作ると、`IntensityStream.push()` が
// 要求する「連続した位置」を保てなくなる。駆動役は**設定に並んだセンサーのうち
// 最も低い `noiseDensity` を持つ 1 台**（`stationConfig.ts` の校正値から）。
// 申告が 1 つでも欠ければ、重みと合わせて先頭（設定の並び順）へ倒す——決定性のため。
//
// **区間の作り直しは `WaveChunk.segmentId` で判定する。`streamKey` では判定しない。**
// `streamKey`（基板・センサー・起動 ID の組）は、パケット落ち（`seq-gap`）・FIFO
// あふれ（`overflow`）・設定変更（`config-changed`）、さらに版 1 プロトコルでは
// 基板の再起動（`seq-reset`）ですら**変わらない**（`../timebase/segmenter.ts` の
// `streamKeyOf` と `breakReason` を見ること）。これらはどれも「区間が切れて
// 作り直された」ことを意味し、`segmentId` は必ず変わる。
//
// **流し込みへ渡す位置は、合成側の起点から数え直す（`Group.streamOrigin`）。**
// `IntensityStream.push()` は「区間の先頭から数えた位置」の連続を要求するけれど、
// **合成の流し込みは駆動役の区間の途中で作られうる** —— 設定を変えて `SensorFusion`
// ごと作り直したとき、駆動役の区間は切れていないので `firstSampleIndex` は途中の値
// （実機で 92949）のまま来る。そのまま渡すと位置 0 を待っている新しい流し込みが
// 「位置が続きになっていない」で投げ、**ホストを入れ直すまでその観測点の合成が
// 動かない**（2026-09-28 に実機で観測。#362）。
// 合成に要るのは**連続していること**だけで起点はどこでもよいので、作り直した時点の
// `firstSampleIndex` を起点として覚え、その差を渡す。**`segmentId` を見ているだけでは
// 防げない** —— あれは「区間が切れたか」の判定で、「流し込みが区間の途中で作られたか」
// は別の事実。
//
// **区間が変わったら、作り直す前に古い流し込みを締める（`end()`）。** 締めないと、
// その区間の末尾（最大 `windowSec` 秒ぶん）の震度が出ないまま消える
// （`IntensityPipeline.closeAll()` と同じ理由）。締めて出た震度は次の `ingest()` の
// `readings` へ載せて返す——`IntensityPipeline` が「畳み直した旧区間の締めくくり」を
// 同じパケットの `readings` に混ぜて返すのと同じ形。
//
// **駆動役以外（裏付け側）は、直近に届いた 1 まとまりだけを覚える。** 過去のまとまりを
// 積み上げるバッファは持たない——駆動役の刻みに対して古すぎる・新しすぎるサンプルは、
// 「値が無い」として合成から外れる（外挿しない）。1 台も裏付けが無ければ、その瞬間は
// 駆動役だけの値になる（`memberCount` で下流にも分かるようにする）。**裏付け側の区間が
// 切れても（再起動・設定変更）このキャッシュは捨てない**——合成が見ているのは物理量
// そのもので、区間の連続性が要るのはフィルタの状態（計測震度の流し込み）のほうだけ。
//
// **`enabled: false` のセンサーはグループにも入れない。** そのセンサーはそもそも
// `WaveChunk` を作らない（`intensityPipeline.ts` が換算より前で弾く）ので、
// 混ぜても永久に届かない相方が残るだけ——最悪、それが駆動役に選ばれると
// その観測点の合成が永久に動かなくなる。
import { IntensityStream } from '../intensity/intensityStream'
import type { IntensityPoint } from '../intensity/intensityStream'
import type { BoardKey } from '../protocol/types'
import type { StationConfig } from './stationConfig'
import type { WaveChunk } from './intensityPipeline'
import { normalizeIntensity } from './intensityPipeline'
// **窓と刻みは単独センサーの計測震度と揃える**（`intensityPipeline.ts` と同じ理由 ——
// 物差しが違えば「揺れ方の違い」と「測り方の違い」を見分けられない）。
import { STEP_SEC_DEFAULT, WINDOW_SEC_DEFAULT, samplesForSeconds } from '../../../src/utils/knet/seismicIntensity'

const REQUIRED_AXES = 3

/**
 * 裏付けの到着を待つ時間（ミリ秒）。**この分だけ合成が遅れる。**
 *
 * **なぜ待つのか。** 裏付け側の値は駆動役の刻みへ時刻で突き合わせるので、まだ届いて
 * いない範囲は引けない。待たずに合成すると**その瞬間に届いていたセンサーだけ**が
 * 混ざり、顔ぶれがサンプルごとに変わる —— **混ざった本数は状態の口に出ない**ので、
 * 実機（2026-09-28）の到着の形を写した台の上で測った。9 本のうち 1〜7 本を揺れ動き、
 * **9 本が揃った瞬間は 8000 サンプル中 1 度も無かった**。
 * 「複数センサーで精度を上げる」という狙い（REQUIREMENTS.md §7）がそもそも
 * 成り立っていなかったことになる。
 *
 * **値の根拠は実測。** 実機の基板間でパケットの到着差が最大 173ms、区間の起点差が
 * 160ms あったので、それを覆う 300ms にした。**足りないと、遅れて届く基板が
 * 合成から外れて顔ぶれが揺れ続ける**（待つ仕組みを入れた意味が無くなる）。
 *
 * **遅れは体感に出ない。** 計測震度はもともと 2 秒遅れて出る
 * （`../intensity/intensityStream.ts` の `EDGE_MARGIN_SEC`）。
 */
export const FUSION_WAIT_MS_DEFAULT = 300

/**
 * 処理を待たせる駆動役のまとまりの上限。**超えたら待ちを切り上げて処理する**
 * （捨てない）。
 *
 * 待ちの計時は「届いたまとまりの時刻」で行うので、**時刻が進まない状況**
 * （裏付けが全滅した・生データの読み返しが途中で止まった）では待ちが永久に
 * 満たされない。そのとき溜め続けるとメモリが伸び、捨てると波形が消える ——
 * どちらも避けて、その時点の顔ぶれで合成する。
 *
 * **この安全弁は「駆動役は動いているのに裏付けが来ない」場合のもの。**
 * グループの**全員**が同時に沈黙すると、溜まりはそれ以上増えないので閾値へ届かず、
 * かつ取り出しを試す機会（`ingest()`）そのものが来なくなる —— 待たせていた分
 * （通常は待ち時間ぶんの数まとまり）は `closeAll()` まで出ないままになる。
 * **これは単独センサーの計測震度と同じ性質**で（あちらも次のパケットが来なければ
 * 窓が埋まらず答えが出ない）、合成に固有の穴ではない。**壁時計で追い出す仕掛けは
 * 置かない** —— 置くと生データの読み返しが実際の経過時間に振られ、同じ入力から
 * 違う合成が出る（`Group.latestSeenMs` の説明を見ること）。観測点が沈黙したこと
 * 自体は基板ごとの生存（`sensorHealth.ts`・`stationHealth.ts`）が見ている。
 */
const MAX_HELD_CHUNKS = 32

/**
 * 裏付け 1 本ぶんに覚えておくまとまりの数。**待ちを覆う長さが要る。**
 *
 * 既定の待ち（300ms）と実機のまとまり（100ms・10 サンプル）なら 3〜4 個で足りるが、
 * まとまりの長さは基板の設定次第なので余裕を持たせる。**古いものは
 * `trimCache` が保留の進みに合わせて捨てる**ので、この上限に当たるのは
 * 「駆動役が止まっているのに裏付けだけ届き続ける」場合だけ。
 */
const MAX_CACHED_CHUNKS = 64

/**
 * センサー 1 本ぶんの直流（重力）を追い、引いた値を返す。**窓は震度と同じ長さ。**
 *
 * **なぜ引くのか。** 合成は「値が引けたセンサーだけ」で平均するので、顔ぶれは
 * サンプルごとに変わる（裏付け側が待ちを覆うぶんしか持たないため。実機の到着の形を
 * 写した台の実測で 1〜7 本を揺れ動いた）。**各センサーの直流が揃っていないと、顔ぶれが
 * 1 本入れ替わるたびに平均の直流が跳ぶ** —— 実機では静止時の Z 軸が 662〜1200 gal に
 * 散っていて（感度が未校正）、静止ノイズ 1.5 gal に対して数十 gal のステップが 100ms
 * ごとに立ち、周期補正フィルタがそれを**実機で震度 4.36**（単体は 1.12〜1.24）として
 * 出していた（2026-09-28・#362。実測値は `../../REQUIREMENTS.md` §7 の表）。
 *
 * **`IntensityStream` の `demeanWindow` では消えない。** あちらは窓の平均を引くだけで、
 * **窓の中の段差はそのまま残る**。段差を作らせないには、混ぜる前に各センサーから
 * 直流を落としておくしかない。
 *
 * **窓を震度と同じ長さにする理由**は `windowSec` の引き渡しと同じ ——
 * 物差しが違えば「揺れ方の違い」と「測り方の違い」を見分けられない。
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
   * 呼び出し側（`SensorFusion.trackerFor`）は計測震度の窓（既定 20 秒 = 2000 サンプル）
   * から引くので通常は起きないが、`windowSec` に極端に小さい値を渡すとそうなる ——
   * そのときは同じ `windowSec` を受ける `IntensityStream` が「0.3 秒を覆えない」で
   * 構築に失敗するので**震度は出ない**（`intensitySkipReason` に理由が立つ）。
   * ただし**合成波形だけは全ゼロで出続ける**ので、#315 で波形を配るときは
   * ここを見直すこと。
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

/** 1 まとまりぶん、直流を引いた波形とその直流。**並びは元の `gal` と 1 対 1。** */
interface Stripped {
  readonly gal: readonly [readonly number[], readonly number[], readonly number[]]
  readonly dcGal: readonly [readonly number[], readonly number[], readonly number[]]
}

/** まとまりを頭から食わせ、直流を引いた波形と引いた直流を作る。 */
function stripDc(tracker: DcTracker, gal: WaveChunk['gal']): Stripped {
  const n = gal[0].length
  const out: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
  const dcOut: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
  for (let i = 0; i < n; i++) {
    const before: readonly [number, number, number] = [gal[0][i], gal[1][i], gal[2][i]]
    const after = tracker.step(before[0], before[1], before[2])
    for (let axis = 0; axis < REQUIRED_AXES; axis++) {
      out[axis][i] = after[axis]
      // 引いた直流は差で持つ——`tracker.dc` を別に読むと、次のサンプルで動いた後の
      // 値を拾う（`step` はサンプルごとに推定を進める）。
      dcOut[axis][i] = before[axis] - after[axis]
    }
  }
  return { gal: out, dcGal: dcOut }
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

/**
 * 観測点ひとつぶんの合成波形。**校正済み gal の重み付き平均**（REQUIREMENTS.md §7）。
 *
 * 区間の連続性は `driver` の流れが決める——`driver` の区間（`WaveChunk.segmentId`。
 * 内部でのみ追跡）が変わるたびに合成の計測震度は作り直す。この型自体は 1 まとまりぶんの
 * 値なので、区間が切れたことをここから読み取ることはできない（必要なら呼び出し側が
 * `IntensityPipeline` の `WaveChunk.streamKey`/`segmentId` と同じ理由で別途持つこと）。
 */
export interface FusedWaveChunk {
  readonly stationId: string
  /** 基準器（駆動役）にした 1 台。時刻の刻みはこのセンサーの流れがそのまま決める。 */
  readonly driver: SensorMemberRef
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
  readonly gal: readonly [readonly number[], readonly number[], readonly number[]]
  /**
   * 上の `gal` から落とした直流。**同じ重みで平均してある**ので、
   * `gal[axis][i] + dcGal[axis][i]` が「校正済み gal の重み付き平均」（落とす前の値）。
   *
   * **落とした値を捨てない。** 重力の向きと大きさは取り付けの診断に使える事実で、
   * 変動分だけにすると下流からは二度と引けない。
   */
  readonly dcGal: readonly [readonly number[], readonly number[], readonly number[]]
  /**
   * 各サンプルへ実際に効いたセンサーの数。**駆動役だけの回は 1。**
   *
   * 裏付けが届いていなくて平均から外れたことを、値の形だけでは下流が見分けられない
   * ——1 台の値がそのまま「合成」を名乗ることになるので、実際に混ぜた数を添える。
   */
  readonly memberCount: readonly number[]
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
 */
export interface SensorPairDiff {
  readonly stationId: string
  readonly memberA: SensorMemberRef
  readonly memberB: SensorMemberRef
  readonly firstSampleIndex: number
  readonly firstSampleMs: number
  readonly msPerSample: number
  /** 両方の値が揃うサンプルだけ埋まる。片方でも無ければ null（外挿しない）。 */
  readonly diffGal: readonly [
    readonly (number | null)[],
    readonly (number | null)[],
    readonly (number | null)[],
  ]
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
 * `ingest()` 1 回ぶんの結果。**投げない**（`intensityPipeline.ts` と同じ分担）。
 *
 * **下の 4 つ（`fusedWave`・`intensitySkipReason`・`closeFailure`・`intensityStateChanged`）は
 * 「待たせていたまとまりを取り出して合成した回」にだけ意味を持つ。** 取り出しは
 * **駆動役の到着に限らない** —— 裏付けが届いても時刻は進むので、そこで待ちが満たされる
 * ことがある（`FUSION_WAIT_MS_DEFAULT` と `ingest()` の説明を見ること）。
 * 取り出しが起きなかった回は `fusedWave` が null で、残りも初期値を返す。
 */
export interface FusionOutcome {
  /** 取り出して合成した回にだけ入る（駆動役・裏付けどちらの到着でも起こりうる）。 */
  readonly fusedWave: FusedWaveChunk | null
  readonly pairDiffs: readonly SensorPairDiff[]
  readonly readings: readonly StationIntensityReading[]
  /**
   * 合成の計測震度が作れない理由。作れていれば null。**取り出して合成した回にだけ
   * 意味を持つ**（上の `FusionOutcome` 自身の説明を見ること）。
   *
   * `IntensityStream` の構築に失敗した場合（`windowSec` が駆動役のサンプリング周波数を
   * 覆えない等）。**単独センサーの計測震度が既に動いている以上、通常は起きない**
   * ——同じ `windowSec`/`stepSec` を同じサンプリング周波数へ適用するだけなので。
   *
   * **`closeFailure` とは別の事実。** あちらは「直前に閉じた区間」の締めくくりの成否、
   * こちらは「いま」の流し込みの健全性——新しい区間の構築が成功すれば、直前区間の
   * 締めくくり失敗の有無に関わらずここは `null` に戻る。
   */
  readonly intensitySkipReason: string | null
  /**
   * この呼び出しで区間を締めた（`segmentId` が変わった）とき、締めくくり
   * （`IntensityStream.end()`）が失敗していればその理由。それ以外（区間が続いている・
   * 締めくくりが成功した）は null。
   *
   * **`intensitySkipReason` で代用しない。** 新しい区間の構築はこの直後に走り、成功すれば
   * `intensitySkipReason` を `null` へ戻す——同じ欄で両方を表そうとすると、締めくくりの
   * 失敗が新しい区間の成功で上書きされて消える（その区間の末尾ぶんの震度が失われた
   * 事実が、誰からも見えなくなる）。
   */
  readonly closeFailure: StationCloseFailure | null
  /**
   * この呼び出しで合成の流し込みの状態が変わりうる処理が走ったか（区間の作り直し・
   * `push()` の失敗のいずれか）。**取り出して合成した回にだけ意味を持つ**
   * （上の `FusionOutcome` 自身の説明を見ること）。
   *
   * 単一センサーの計測震度（`intensityPipeline.ts` の `PacketOutcome.startedBecause`）が
   * 「区間が始まった回にだけ理由を返す」のと対称にするための印——`intensitySkipReason`は
   * 毎回「いまの状態」を返すので、これが無いと「状態が変わった回にだけログを出す」
   * （運用者が読みたいのは変化点であって、正常な区間が続く間の毎回の現在値ではない）
   * 判定を呼び出し側が再現できない。
   */
  readonly intensityStateChanged: boolean
}

function nothingOutcome(): FusionOutcome {
  return {
    fusedWave: null,
    pairDiffs: [],
    readings: [],
    intensitySkipReason: null,
    closeFailure: null,
    intensityStateChanged: false,
  }
}

interface Member {
  readonly boardKey: BoardKey
  readonly sensorId: string
  readonly noiseDensity: number | null
  readonly weight: number
}

function memberRefOf(m: Member): SensorMemberRef {
  return { boardKey: m.boardKey, sensorId: m.sensorId }
}

/**
 * 裏付け側から届いたまとまり 1 つ。
 *
 * **直近の 1 つでは足りない**（そこが #362 の原因のひとつだった）。駆動役の処理を
 * 待たせる（`FUSION_WAIT_MS_DEFAULT`）あいだ、その時刻範囲を覆えるだけ覚えておく
 * —— 古いものは `trimCache` が保留の進みに合わせて落とす。
 */
interface CachedChunk {
  readonly firstSampleMs: number
  readonly msPerSample: number
  /** **直流を引いた後**の gal（`DcTracker` を通した値）。 */
  readonly gal: readonly [readonly number[], readonly number[], readonly number[]]
  /** 引いた直流。合成が「足し戻せる値」を出すために持つ（`FusedWaveChunk.dcGal`）。 */
  readonly dcGal: readonly [readonly number[], readonly number[], readonly number[]]
  readonly length: number
}

/**
 * 直近に受けた駆動役の 1 まとまりの時刻の起点。**震度の `atMs` をあとから計算するために持つ。**
 *
 * **`firstSampleIndex` は `Group.streamOrigin` から数えた位置**（駆動役の区間の通し番号
 * ではない）。`IntensityStream` が返す `endSampleIndex` と同じ数え方に揃えてある ——
 * 揃えないと、区間の途中で作られた流し込みの答えが起点のずれた時刻を名乗る。
 *
 * `IntensityStream` は「流し込みの先頭から数えた位置」しか知らないので、絶対時刻へ戻すには
 * 起点（`firstSampleIndex`・`firstSampleMs`・`msPerSample`）が要る。**駆動役の到着のたびに
 * 最新の値へ更新する**（区間が続いていても）——当てはめ（`IncrementalLineFit`）は区間の中でも
 * 精度が上がっていくので、`msPerSample` はわずかに動きうる。式 `firstSampleMs + (i -
 * firstSampleIndex) * msPerSample` は同じ絶対時刻軸を指す限り起点をどこに取っても同じ答えを
 * 返すので、直近の起点を使い続けて構わない——**区切りが必要なのは `end()` が呼ばれる直前まで
 * 更新を止めない**（旧区間を締めるときは、締める前の起点をまだ書き換えていない状態で使う）。
 */
interface DriverAnchor {
  readonly firstSampleIndex: number
  readonly firstSampleMs: number
  readonly msPerSample: number
}

interface Group {
  readonly stationId: string
  readonly driver: Member
  readonly driverMemberKey: string
  /** 駆動役を含む全メンバー。 */
  readonly members: readonly Member[]
  /** 駆動役を除いたメンバー。合成のたびに引き直さなくて済むよう先に作っておく。 */
  readonly backups: readonly Member[]
  /** センサーごとに覚えている裏付けのまとまり。**古い順。** */
  readonly cache: Map<string, CachedChunk[]>
  /**
   * 裏付けの到着を待っている駆動役のまとまり。**古い順。**
   *
   * 合成はここから取り出したときに起きる（届いた瞬間ではない）。取り出す条件は
   * `FUSION_WAIT_MS_DEFAULT` を見ること。
   */
  readonly held: HeldChunk[]
  /**
   * このグループで観測した最新の時刻（駆動役・裏付けを問わない、まとまりの終端）。
   *
   * **待ちの計時はこれで行う。壁時計を見ない** —— 見ると、生データの読み返しや
   * テストで実際の経過時間に振られ、同じ入力から違う合成が出る。
   */
  latestSeenMs: number
  /**
   * センサーごとの直流の追い方。**区間が切れても捨てない** ——
   * 追っているのは物理量（重力）そのもので、区間の連続性が要るのはフィルタの状態
   * （計測震度の流し込み）のほうだけ。捨てると、そのセンサーだけ直流の推定が
   * 0 から立ち上がり直して**切れ目のたびに跳びを作る**（直そうとした症状そのもの）。
   */
  readonly dc: Map<string, DcTracker>
  /** いま合成に使っている計測震度の流し込み。駆動役の区間が変われば作り直す。 */
  stream: IntensityStream | null
  /**
   * 上の `stream` がどの駆動役の区間（`WaveChunk.segmentId`）へ紐付いているか。
   *
   * **`streamKey` ではなく `segmentId` で見る。** `streamKey`（基板・センサー・起動 ID の組）は
   * パケット落ち・FIFO あふれ・設定変更・（版 1 の）基板再起動のいずれでも変わらないが、
   * これらはどれも区間が切れて作り直された合図で、`segmentId` は必ず変わる
   * （`../timebase/segmenter.ts` の `streamKeyOf`・`breakReason` を見ること）。
   */
  driverSegmentId: number | null
  /**
   * いまの `stream` を作った時点の、駆動役の区間での位置。**流し込みへ渡す位置の原点。**
   *
   * `stream` が null のときは null。**区間の途中で作られた流し込みは、駆動役の通し番号を
   * そのまま受け取れない**（`IntensityStream.push()` は位置 0 から数えるため。冒頭の
   * 「流し込みへ渡す位置は、合成側の起点から数え直す」を見ること）。
   */
  streamOrigin: number | null
  /** 直近に受けた駆動役の 1 まとまりの起点。`stream` が null でも（構築失敗時も）更新する。 */
  driverAnchor: DriverAnchor | null
  streamError: string | null
  unusableCount: number
}

/**
 * 設定から観測点ごとのグループを作る。**`enabled` なセンサーだけを見る。**
 *
 * 2 台に満たない観測点は組まない——合成する相手が居ない。
 */
function buildGroups(config: StationConfig): Group[] {
  const listByStation = new Map<string, { boardKey: BoardKey; sensorId: string; noiseDensity: number | null }[]>()
  for (const board of config.boards) {
    for (const sensor of board.sensors) {
      if (!sensor.enabled) continue
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
    const members: Member[] = list.map((m) => ({
      ...m,
      weight: allKnown ? 1 / (m.noiseDensity as number) ** 2 : 1,
    }))

    // **駆動役は最も低雑音の 1 台。** 申告が無ければ（`allKnown` が false）先頭
    // （設定の並び順）のまま——決定性のため、恣意的な基準では選ばない。
    let driver = members[0]
    if (allKnown) {
      for (const m of members) {
        if ((m.noiseDensity as number) < (driver.noiseDensity as number)) driver = m
      }
    }

    groups.push({
      stationId,
      driver,
      driverMemberKey: memberKeyOf(driver.boardKey, driver.sensorId),
      members,
      backups: members.filter((m) => m !== driver),
      cache: new Map(),
      held: [],
      latestSeenMs: Number.NEGATIVE_INFINITY,
      dc: new Map(),
      stream: null,
      driverSegmentId: null,
      streamOrigin: null,
      driverAnchor: null,
      streamError: null,
      unusableCount: 0,
    })
  }
  return groups
}

/** 待たせている駆動役のまとまり 1 つ。直流を落とした波形も一緒に持つ（二度引かない）。 */
interface HeldChunk {
  readonly wave: WaveChunk
  readonly stripped: Stripped
  /** このまとまりの終端時刻（最後のサンプルの次）。待ちの判定に使う。 */
  readonly endMs: number
}

/** まとまりの終端時刻（最後のサンプルの次）。 */
function endMsOf(chunk: CachedChunk): number {
  return chunk.firstSampleMs + chunk.length * chunk.msPerSample
}

/** 裏付け側の 1 サンプルぶん。値と、そのサンプルで引いた直流。 */
interface CachedSample {
  readonly value: readonly [number, number, number]
  readonly dc: readonly [number, number, number]
}

/** 1 まとまりから指定時刻の値を引く。無ければ null（外挿しない）。 */
function lookupChunk(cache: CachedChunk, tMs: number): CachedSample | null {
  const idx = Math.round((tMs - cache.firstSampleMs) / cache.msPerSample)
  if (idx < 0 || idx >= cache.length) return null
  return {
    value: [cache.gal[0][idx], cache.gal[1][idx], cache.gal[2][idx]],
    dc: [cache.dcGal[0][idx], cache.dcGal[1][idx], cache.dcGal[2][idx]],
  }
}

/**
 * 覚えている裏付けのまとまりから、指定時刻の値を引く。無ければ null（外挿しない）。
 *
 * **新しいほうから探す。** まとまりが時刻で重なることはパケットの再送などで
 * 起こりうるが、そのときは新しく届いた値を採る（`IntensityPipeline` が区間の
 * 当てはめを進めた結果なので、後のほうが確からしい）。
 */
function lookupCached(chunks: readonly CachedChunk[], tMs: number): CachedSample | null {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const found = lookupChunk(chunks[i], tMs)
    if (found !== null) return found
  }
  return null
}

/**
 * もう引かれない裏付けのまとまりを落とす。
 *
 * **最新の 1 つは必ず残す。** 保留が空のときに全部捨てると、次に届いた駆動役が
 * 裏付けを 1 本も引けず、待つ仕組みを入れる前と同じ「駆動役だけの合成」に戻る。
 *
 * **並びが時刻順であることを前提にしている**（`list[0]` を最古とみなす。`lookupCached`
 * は逆に末尾から探す）。`firstSampleMs` は区間の当てはめが出す絶対時刻で、基板が
 * 再起動しても区間が切り直されるため通常は前進しかしない —— **もし時刻が巻き戻る
 * 形で届けば、落とす順と探す順の両方が崩れる**（その場合に起きるのは「古い値を
 * 引く」「捨てるべきものが残る」で、例外は出ない）。
 */
function trimCache(group: Group): void {
  // 待たせている中で最も古いまとまりの先頭より前で終わるものは、以後どの
  // 合成からも引かれない（合成は保留を古い順に処理する）。
  const oldestNeededMs = group.held.length > 0 ? group.held[0].wave.firstSampleMs : Infinity
  for (const list of group.cache.values()) {
    while (list.length > 1 && endMsOf(list[0]) <= oldestNeededMs) list.shift()
  }
}

interface Combined {
  readonly gal: readonly [number[], number[], number[]]
  readonly dcGal: readonly [number[], number[], number[]]
  readonly memberCount: readonly number[]
}

/**
 * 駆動役の 1 まとまりへ、裏付け側の直近値を重み付きで混ぜる。
 *
 * **渡すのは直流を引いた後の波形**（`stripDc` を通した値）。引いた直流も同じ重みで
 * 平均して返す —— 足し戻せば従来の「校正済み gal の重み付き平均」になる。
 */
function combine(group: Group, driverWave: WaveChunk, driver: Stripped): Combined {
  const n = driver.gal[0].length
  const out: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
  const dcOut: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
  const memberCount = new Array<number>(n)

  for (let i = 0; i < n; i++) {
    const tMs = driverWave.firstSampleMs + i * driverWave.msPerSample
    // **軸ごとに顔ぶれを変えない。** 裏付け側の可否はセンサー単位（3 軸まとめて
    // 届く・届かない）で決まるので、ここで一度だけ引く。
    const active: { weight: number; sample: CachedSample }[] = []
    for (const m of group.backups) {
      const chunks = group.cache.get(memberKeyOf(m.boardKey, m.sensorId))
      if (chunks === undefined) continue
      const sample = lookupCached(chunks, tMs)
      if (sample === null) continue
      active.push({ weight: m.weight, sample })
    }
    memberCount[i] = 1 + active.length

    for (let axis = 0; axis < REQUIRED_AXES; axis++) {
      let wSum = group.driver.weight
      let vSum = group.driver.weight * driver.gal[axis][i]
      let dSum = group.driver.weight * driver.dcGal[axis][i]
      for (const a of active) {
        wSum += a.weight
        vSum += a.weight * a.sample.value[axis]
        dSum += a.weight * a.sample.dc[axis]
      }
      out[axis][i] = vSum / wSum
      dcOut[axis][i] = dSum / wSum
    }
  }
  return { gal: out, dcGal: dcOut, memberCount }
}

/**
 * 駆動役の 1 まとまりについて、全ペアの差分 `d=(a1-a2)/2` を作る。
 *
 * **差も直流を引いた後の値から作る。** 用途はセンサー自己ノイズの推定と異常センサーの
 * 検出なので、取り付けの向きや感度のずれ（実機では Z 軸で最大 538 gal）が差を
 * 支配したままでは何も見分けられない —— 引いておけば、差に残るのは
 * 見たかったもの（各センサーの自己ノイズと、本当の食い違い）だけになる。
 */
function buildPairDiffs(group: Group, driverWave: WaveChunk, driver: Stripped): SensorPairDiff[] {
  const n = driver.gal[0].length

  function valueAt(m: Member, i: number): readonly [number, number, number] | null {
    if (m === group.driver) {
      return [driver.gal[0][i], driver.gal[1][i], driver.gal[2][i]]
    }
    const chunks = group.cache.get(memberKeyOf(m.boardKey, m.sensorId))
    if (chunks === undefined) return null
    return lookupCached(chunks, driverWave.firstSampleMs + i * driverWave.msPerSample)?.value ?? null
  }

  const out: SensorPairDiff[] = []
  for (let a = 0; a < group.members.length; a++) {
    for (let b = a + 1; b < group.members.length; b++) {
      const memberA = group.members[a]
      const memberB = group.members[b]
      const diff: [Array<number | null>, Array<number | null>, Array<number | null>] = [
        new Array(n),
        new Array(n),
        new Array(n),
      ]
      for (let i = 0; i < n; i++) {
        const va = valueAt(memberA, i)
        const vb = valueAt(memberB, i)
        for (let axis = 0; axis < REQUIRED_AXES; axis++) {
          diff[axis][i] = va === null || vb === null ? null : (va[axis] - vb[axis]) / 2
        }
      }
      out.push({
        stationId: group.stationId,
        memberA: memberRefOf(memberA),
        memberB: memberRefOf(memberB),
        firstSampleIndex: driverWave.firstSampleIndex,
        firstSampleMs: driverWave.firstSampleMs,
        msPerSample: driverWave.msPerSample,
        diffGal: diff,
      })
    }
  }
  return out
}

/** `IntensityPoint` を絶対時刻へ戻し、非有限を弾く。`group.unusableCount` を進める副作用を持つ。 */
function toStationReading(group: Group, anchor: DriverAnchor, p: IntensityPoint): StationIntensityReading {
  const normalized = normalizeIntensity(p.intensity)
  if (normalized.unusable) group.unusableCount++
  return {
    stationId: group.stationId,
    atMs: anchor.firstSampleMs + (p.endSampleIndex - anchor.firstSampleIndex) * anchor.msPerSample,
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
 * `IntensityStream.end()` を呼ばずに捨てると、窓・刻みに満たない末尾のサンプルが
 * 出さずじまいで消える（`IntensityPipeline.closeAll()` と同じ理由）。呼び出し元は
 * 区間の作り直し（`ingest()`）と全終了（`closeAll()`）の 2 つ。
 *
 * **失敗を `group.streamError` へ直接書かない。** 呼び出し元（`ingest()`）はこの直後に
 * 新しい区間の `IntensityStream` を構築し、その成否で `group.streamError` を無条件に
 * 書き換える——ここで書いても、その一手で消える。戻り値で返し、消えない形で
 * 運んでもらう。
 *
 * **この関数自体は投げない。** 呼び出し元（`ingest()`・`closeAll()`）はどちらもこれを
 * 前提に、個別の try/catch を持たない——**この関数の中身を変えるときは、この前提を
 * 崩さないこと。** 本体はまるごと 1 つの try/catch で覆われているので、
 * `group.stream.end()` の外へ処理を足すなら、その処理もこの try の内側へ入れること。
 */
function endGroupStream(group: Group): EndGroupStreamResult {
  if (group.stream === null || group.driverAnchor === null) return { readings: [], failure: null }
  const anchor = group.driverAnchor
  const readings: StationIntensityReading[] = []
  let failure: StationCloseFailure | null = null
  try {
    for (const p of group.stream.end()) readings.push(toStationReading(group, anchor, p))
  } catch (error) {
    // **投げない。** 締めくくりの失敗はここでしか起きない箇所（`IntensityStream.end()`
    // 自身の実装は投げない）だが、`IntensityPipeline.flush()` と同じ理由で握りつぶさず
    // 理由を残す——この 1 本の失敗で呼び出し元（`closeAll()` 等）を巻き込まない。
    failure = { stationId: group.stationId, detail: messageOf(error) }
  }
  group.stream = null
  // **原点も一緒に落とす。** 残すと、次に作った流し込み（位置 0 から数え直す）へ
  // 古い原点を当てることになり、答えの時刻が原点の差だけずれる。
  group.streamOrigin = null
  return { readings, failure }
}

export interface SensorFusionOptions {
  readonly windowSec?: number
  readonly stepSec?: number
  /** 裏付けの到着を待つ時間（ミリ秒）。既定は `FUSION_WAIT_MS_DEFAULT`。 */
  readonly waitMs?: number
}

export class SensorFusion {
  private readonly windowSec: number
  private readonly stepSec: number
  private readonly waitMs: number
  private readonly groupByMemberKey = new Map<string, Group>()
  /** 重複の無いグループの一覧。`groupByMemberKey` は複数キーが同じグループを指す。 */
  private readonly groups: Group[]
  /** `closeAll()` を呼んだか。**呼んだあとの `ingest()` は誤用として止める。** */
  private closed = false

  constructor(config: StationConfig, options: SensorFusionOptions = {}) {
    this.windowSec = options.windowSec ?? WINDOW_SEC_DEFAULT
    this.stepSec = options.stepSec ?? STEP_SEC_DEFAULT
    this.waitMs = options.waitMs ?? FUSION_WAIT_MS_DEFAULT
    this.groups = buildGroups(config)
    for (const group of this.groups) {
      for (const m of group.members) this.groupByMemberKey.set(memberKeyOf(m.boardKey, m.sensorId), group)
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
   * そのセンサーの直流の追い方を引く（無ければ作る）。
   *
   * **窓の長さは震度と同じ**（`windowSec`）。サンプリング周波数は届いた刻みから引く
   * ——丸め方は震度と共有する（`samplesForSeconds`）ので、窓の端が 1 サンプルずれない。
   *
   * **一度作ったら容量は変えない。** 区間の当てはめが進むと `msPerSample` はわずかに
   * 動くけれど（実測で公称値の 0.06% 程度）、直流を追う窓の長さがその分ずれても
   * 意味は変わらない——作り直せば**溜めた直流を捨てることになり、そのほうが害が大きい**。
   */
  private trackerFor(group: Group, memberKey: string, msPerSample: number): DcTracker {
    const found = group.dc.get(memberKey)
    if (found !== undefined) return found
    const capacity = Math.max(1, samplesForSeconds(this.windowSec, 1000 / msPerSample))
    const created = new DcTracker(capacity)
    group.dc.set(memberKey, created)
    return created
  }

  /**
   * 波形が 1 まとまり届いた。**投げない**（`closeAll()` のあとを除く）。
   *
   * 観測点に属さない、または相方が居ない（グループを作れなかった）センサーは
   * 素通りする——単独のセンサーは合成の対象にならない。
   *
   * **合成は届いた瞬間には起きない。** 駆動役のまとまりは裏付けの到着を待つために
   * いったん溜め、待ちが満たされた回に 1 つだけ取り出して合成する
   * （`FUSION_WAIT_MS_DEFAULT` を見ること）。**待ちを進めるのは駆動役の到着だけでは
   * ない** —— 裏付けが届いても時刻は進むので、そこでも取り出しを試す。
   *
   * **1 回の呼び出しで取り出すのは最大 1 つ。** 駆動役のまとまりは定期的に届くので、
   * 入りと出が釣り合って溜まりは一定の長さ（待ち時間ぶん）に落ち着く。
   *
   * **`closeAll()` のあとに呼んではいけない。** そこで全グループの流し込みを締めて
   * いるので、以後 `ingest()` を呼び続けると `group.stream` が `null` のまま
   * 二度と作り直されず、合成の震度だけが理由も残らず出なくなる
   * （`IntensityStream.push()` が `end()` のあとの呼び出しを拒む理由と同じ）。
   */
  ingest(wave: WaveChunk): FusionOutcome {
    if (this.closed) throw new Error('closeAll() のあとに ingest() は呼べない')
    const key = memberKeyOf(wave.boardKey, wave.sensorId)
    const group = this.groupByMemberKey.get(key)
    if (group === undefined) return nothingOutcome()

    // **直流はここで落とす。** 以降の合成・差分・震度はすべて変動分で解く
    // （`DcTracker` の説明を見ること）。**駆動役も裏付けも同じ扱い**——片方だけ
    // 落とすと、その差がそのまま平均へ乗る。
    const stripped = stripDc(this.trackerFor(group, key, wave.msPerSample), wave.gal)
    const length = wave.gal[0].length
    const endMs = wave.firstSampleMs + length * wave.msPerSample
    // 待ちの計時は届いたまとまりの時刻で行う（`Group.latestSeenMs` を見ること）。
    if (endMs > group.latestSeenMs) group.latestSeenMs = endMs

    if (key === group.driverMemberKey) {
      group.held.push({ wave, stripped, endMs })
    } else {
      const list = group.cache.get(key)
      const entry: CachedChunk = {
        firstSampleMs: wave.firstSampleMs,
        msPerSample: wave.msPerSample,
        gal: stripped.gal,
        dcGal: stripped.dcGal,
        length,
      }
      if (list === undefined) group.cache.set(key, [entry])
      else {
        list.push(entry)
        // **駆動役が止まっているのに裏付けだけ届き続ける場合の歯止め**
        // （`trimCache` は保留の進みでしか捨てないので、進まなければ伸び続ける）。
        while (list.length > MAX_CACHED_CHUNKS) list.shift()
      }
    }

    return this.fuseOneHeld(group)
  }

  /**
   * 待ちが満たされた駆動役のまとまりを 1 つだけ取り出して合成する。
   *
   * 取り出すのは次のどちらか。
   *
   * - 先頭のまとまりの終端から待ち時間が経っている（`latestSeenMs` で測る）
   * - 溜まりが上限（`MAX_HELD_CHUNKS`）を超えた —— **待ちを切り上げる安全弁。**
   *   時刻が進まない状況（裏付けが全滅した・読み返しが止まった）で永久に待たない
   */
  private fuseOneHeld(group: Group): FusionOutcome {
    const head = group.held[0]
    if (head === undefined) return nothingOutcome()
    const waited = head.endMs + this.waitMs <= group.latestSeenMs
    if (!waited && group.held.length <= MAX_HELD_CHUNKS) return nothingOutcome()
    group.held.shift()
    const outcome = this.fuse(group, head)
    // 保留が進んだぶん、もう引かれない裏付けを落とす。
    trimCache(group)
    return outcome
  }

  /** 取り出した 1 まとまりを合成する。**`held` からの取り出しはここでは行わない。** */
  private fuse(group: Group, held: HeldChunk): FusionOutcome {
    const wave = held.wave
    const stripped = held.stripped

    // **駆動役の到着。区間（`segmentId`）が変わっていれば、古い流し込みを締めてから
    // 作り直す。** 締めて出た震度（前の区間の末尾ぶん）は、この呼び出しの `readings` へ
    // 混ぜて返す——`IntensityPipeline` が「畳み直した旧区間の締めくくり」を同じパケットの
    // `readings` に混ぜるのと同じ形。
    let carried: readonly StationIntensityReading[] = []
    let closeFailure: StationCloseFailure | null = null
    let intensityStateChanged = false
    if (group.driverSegmentId !== wave.segmentId) {
      intensityStateChanged = true
      const closed = endGroupStream(group)
      carried = closed.readings
      closeFailure = closed.failure
      group.driverSegmentId = wave.segmentId
      try {
        group.stream = new IntensityStream({
          sampleRateHz: 1000 / wave.msPerSample,
          windowSec: this.windowSec,
          stepSec: this.stepSec,
          // **直流は `DcTracker` が既に落としているが、それでも引く。** あちらが
          // 消すのは「センサーごとの直流差が作る段差」で、こちらが消すのは
          // 「窓の平均が 0 でないこと」——単独センサーと同じ物差しに揃えておく
          // （`intensityPipeline.ts` の `DEMEAN_WINDOW` と同じ理由）。
          demeanWindow: true,
        })
        // **この位置を原点にする。** 駆動役の区間は切れていないこともある
        // （設定変更で `SensorFusion` だけ作り直した場合）ので、通し番号をそのまま
        // 渡すと位置 0 を待っている流し込みが投げる（冒頭の説明を見ること）。
        group.streamOrigin = wave.firstSampleIndex
        group.streamError = null
      } catch (error) {
        group.stream = null
        group.streamOrigin = null
        group.streamError = messageOf(error)
      }
    }
    // **`stream` の作り直しより後に更新する。** `endGroupStream` は「締める前」の
    // 起点（前の区間のもの）を必要とするため。
    //
    // **位置は原点から数え直す**（`DriverAnchor.firstSampleIndex` の説明を見ること）。
    // 原点が無い＝流し込みも無いので、そのときの値は使われない——通し番号をそのまま
    // 置いておけば、次に流し込みが作られた回に原点ごと書き換わる。
    group.driverAnchor = {
      firstSampleIndex: wave.firstSampleIndex - (group.streamOrigin ?? 0),
      firstSampleMs: wave.firstSampleMs,
      msPerSample: wave.msPerSample,
    }

    const combined = combine(group, wave, stripped)
    const pairDiffs = buildPairDiffs(group, wave, stripped)

    const readings: StationIntensityReading[] = [...carried]
    if (group.stream !== null) {
      // 原点から数えた位置を渡す。流し込みがあるなら原点も必ずある（同じ一手で置く）。
      const at = wave.firstSampleIndex - (group.streamOrigin ?? 0)
      try {
        for (const p of group.stream.push(at, combined.gal[0], combined.gal[1], combined.gal[2])) {
          readings.push(toStationReading(group, group.driverAnchor, p))
        }
      } catch (error) {
        // **投げない契約を守る。** 区間の作り直しを `segmentId` で揃えた以上、通常は
        // 起きない——起きたら流し込みの側に想定外の不整合がある。握りつぶさず理由を
        // 残し、次の区間（新しい `segmentId`）が来るまで合成の震度だけを見送る
        // （波形の合成・差分は投げていないのでそのまま返す——1 件の失敗で他を
        // 巻き添えにしない）。
        //
        // **投げる直前まで溜まっていた分は `end()` で救い出す。** `push()` は
        // 「投げたときは何も溜め込んでいない」（`IntensityStream.push()` 自身の
        // コメント）——つまり今回渡した分は捨てられるが、その手前まで正常に
        // 溜まっていたサンプルは残っている。ここで諦めると、既に届いていた分まで
        // 一緒に失われる。
        try {
          for (const p of group.stream.end()) readings.push(toStationReading(group, group.driverAnchor, p))
        } catch {
          // `end()` 自身は投げない実装だが、`endGroupStream` と同じ理由で万一に備える。
          // ここまで来て投げるなら push() の失敗そのものが本題なので、二重に報せない。
        }
        group.stream = null
        group.streamOrigin = null
        group.streamError = messageOf(error)
        intensityStateChanged = true
      }
    }

    return {
      fusedWave: {
        stationId: group.stationId,
        driver: memberRefOf(group.driver),
        firstSampleIndex: wave.firstSampleIndex,
        firstSampleMs: wave.firstSampleMs,
        msPerSample: wave.msPerSample,
        gal: combined.gal,
        dcGal: combined.dcGal,
        memberCount: combined.memberCount,
      },
      pairDiffs,
      readings,
      intensitySkipReason: group.streamError,
      closeFailure,
      intensityStateChanged,
    }
  }

  /**
   * すべての観測点の合成の流し込みを締め、残っている震度を出す。**終了時に呼ぶこと**
   * ——呼ばないと、各観測点の最後の窓ぶんの答えが出ないまま消える
   * （`IntensityPipeline.closeAll()` と同じ理由）。
   *
   * **待たせていたまとまりは先に流し切る。** 捨てると、待ちの時間ぶん（既定 0.3 秒）の
   * 震度が出ないまま消える——締めくくり（`end()`）を呼ぶ理由と同じ。
   * **合成波形はここでは返せない**（この戻り値は震度と締めくくりの失敗だけを運ぶ）ので、
   * 最後の数まとまりぶんの合成波形は出ずに終わる。震度は拾えるので実害は無いが、
   * 波形を配る先を足すとき（#315）はここを見直すこと。
   *
   * **この呼び出しのあとに `ingest()` を呼んではいけない。** 呼ぶと投げる
   * （`ingest()` 自身のコメントを見ること）。
   */
  closeAll(): { readonly readings: readonly StationIntensityReading[]; readonly failures: readonly StationCloseFailure[] } {
    this.closed = true
    const readings: StationIntensityReading[] = []
    const failures: StationCloseFailure[] = []
    for (const group of this.groups) {
      while (group.held.length > 0) {
        const head = group.held.shift() as HeldChunk
        const out = this.fuse(group, head)
        readings.push(...out.readings)
        if (out.closeFailure !== null) failures.push(out.closeFailure)
      }
      const closed = endGroupStream(group)
      readings.push(...closed.readings)
      if (closed.failure !== null) failures.push(closed.failure)
    }
    return { readings, failures }
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
}
