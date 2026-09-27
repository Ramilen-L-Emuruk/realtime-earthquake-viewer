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
// 作り直された」ことを意味し、`segmentId` は必ず変わる——ここを見誤ると、
// 駆動役の `firstSampleIndex` がリセットされたのに合成用 `IntensityStream` だけが
// 古い区間の続きを期待し続け、`push()` が「位置が続きになっていない」で例外を投げる。
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
import { STEP_SEC_DEFAULT, WINDOW_SEC_DEFAULT } from '../../../src/utils/knet/seismicIntensity'

const REQUIRED_AXES = 3

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
  /** 重み付き平均の gal。`gal[axis][i]` が i 番目のサンプル。 */
  readonly gal: readonly [readonly number[], readonly number[], readonly number[]]
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

/** `ingest()` 1 回ぶんの結果。**投げない**（`intensityPipeline.ts` と同じ分担）。 */
export interface FusionOutcome {
  /** 駆動役の到着でだけ入る。裏付け側の到着（覚えるだけ）では null。 */
  readonly fusedWave: FusedWaveChunk | null
  readonly pairDiffs: readonly SensorPairDiff[]
  readonly readings: readonly StationIntensityReading[]
  /**
   * 合成の計測震度が作れない理由。作れていれば null。**駆動役の到着でだけ意味を持つ。**
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
   * `push()` の失敗のいずれか）。**駆動役の到着でだけ意味を持つ。**
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

/** 裏付け側から届いた直近の 1 まとまり。**積み上げない**——古いものは持たない。 */
interface CachedChunk {
  readonly firstSampleMs: number
  readonly msPerSample: number
  readonly gal: readonly [readonly number[], readonly number[], readonly number[]]
  readonly length: number
}

/**
 * 直近に受けた駆動役の 1 まとまりの時刻の起点。**震度の `atMs` をあとから計算するために持つ。**
 *
 * `IntensityStream` は「区間の先頭から数えた位置」しか知らないので、絶対時刻へ戻すには
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
  readonly cache: Map<string, CachedChunk>
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
      stream: null,
      driverSegmentId: null,
      driverAnchor: null,
      streamError: null,
      unusableCount: 0,
    })
  }
  return groups
}

/** 裏付け側の直近のまとまりから、指定時刻の値を引く。無ければ null（外挿しない）。 */
function lookupCached(cache: CachedChunk, tMs: number): readonly [number, number, number] | null {
  const idx = Math.round((tMs - cache.firstSampleMs) / cache.msPerSample)
  if (idx < 0 || idx >= cache.length) return null
  return [cache.gal[0][idx], cache.gal[1][idx], cache.gal[2][idx]]
}

interface Combined {
  readonly gal: readonly [number[], number[], number[]]
  readonly memberCount: readonly number[]
}

/** 駆動役の 1 まとまりへ、裏付け側の直近値を重み付きで混ぜる。 */
function combine(group: Group, driverWave: WaveChunk): Combined {
  const n = driverWave.gal[0].length
  const out: [number[], number[], number[]] = [new Array(n), new Array(n), new Array(n)]
  const memberCount = new Array<number>(n)

  for (let i = 0; i < n; i++) {
    const tMs = driverWave.firstSampleMs + i * driverWave.msPerSample
    // **軸ごとに顔ぶれを変えない。** 裏付け側の可否はセンサー単位（3 軸まとめて
    // 届く・届かない）で決まるので、ここで一度だけ引く。
    const active: { weight: number; value: readonly [number, number, number] }[] = []
    for (const m of group.backups) {
      const cache = group.cache.get(memberKeyOf(m.boardKey, m.sensorId))
      if (cache === undefined) continue
      const value = lookupCached(cache, tMs)
      if (value === null) continue
      active.push({ weight: m.weight, value })
    }
    memberCount[i] = 1 + active.length

    for (let axis = 0; axis < REQUIRED_AXES; axis++) {
      let wSum = group.driver.weight
      let vSum = group.driver.weight * driverWave.gal[axis][i]
      for (const a of active) {
        wSum += a.weight
        vSum += a.weight * a.value[axis]
      }
      out[axis][i] = vSum / wSum
    }
  }
  return { gal: out, memberCount }
}

/** 駆動役の 1 まとまりについて、全ペアの差分 `d=(a1-a2)/2` を作る。 */
function buildPairDiffs(group: Group, driverWave: WaveChunk): SensorPairDiff[] {
  const n = driverWave.gal[0].length

  function valueAt(m: Member, i: number): readonly [number, number, number] | null {
    if (m === group.driver) {
      return [driverWave.gal[0][i], driverWave.gal[1][i], driverWave.gal[2][i]]
    }
    const cache = group.cache.get(memberKeyOf(m.boardKey, m.sensorId))
    if (cache === undefined) return null
    return lookupCached(cache, driverWave.firstSampleMs + i * driverWave.msPerSample)
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
  return { readings, failure }
}

export interface SensorFusionOptions {
  readonly windowSec?: number
  readonly stepSec?: number
}

export class SensorFusion {
  private readonly windowSec: number
  private readonly stepSec: number
  private readonly groupByMemberKey = new Map<string, Group>()
  /** 重複の無いグループの一覧。`groupByMemberKey` は複数キーが同じグループを指す。 */
  private readonly groups: Group[]
  /** `closeAll()` を呼んだか。**呼んだあとの `ingest()` は誤用として止める。** */
  private closed = false

  constructor(config: StationConfig, options: SensorFusionOptions = {}) {
    this.windowSec = options.windowSec ?? WINDOW_SEC_DEFAULT
    this.stepSec = options.stepSec ?? STEP_SEC_DEFAULT
    this.groups = buildGroups(config)
    for (const group of this.groups) {
      for (const m of group.members) this.groupByMemberKey.set(memberKeyOf(m.boardKey, m.sensorId), group)
    }
  }

  /**
   * 波形が 1 まとまり届いた。**投げない**（`closeAll()` のあとを除く）。
   *
   * 観測点に属さない、または相方が居ない（グループを作れなかった）センサーは
   * 素通りする——単独のセンサーは合成の対象にならない。
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

    if (key !== group.driverMemberKey) {
      // **裏付け側の到着。直近の 1 まとまりを覚えるだけ**——合成は駆動役の刻みでしか起きない。
      group.cache.set(key, {
        firstSampleMs: wave.firstSampleMs,
        msPerSample: wave.msPerSample,
        gal: wave.gal,
        length: wave.gal[0].length,
      })
      return nothingOutcome()
    }

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
          // 合成波形にも重力の直流が乗る（駆動役自身がそう）ので、単独センサーと
          // 同じ扱いにする（`intensityPipeline.ts` の `DEMEAN_WINDOW` と同じ理由）。
          demeanWindow: true,
        })
        group.streamError = null
      } catch (error) {
        group.stream = null
        group.streamError = messageOf(error)
      }
    }
    // **`stream` の作り直しより後に更新する。** `endGroupStream` は「締める前」の
    // 起点（前の区間のもの）を必要とするため。
    group.driverAnchor = {
      firstSampleIndex: wave.firstSampleIndex,
      firstSampleMs: wave.firstSampleMs,
      msPerSample: wave.msPerSample,
    }

    const combined = combine(group, wave)
    const pairDiffs = buildPairDiffs(group, wave)

    const readings: StationIntensityReading[] = [...carried]
    if (group.stream !== null) {
      try {
        for (const p of group.stream.push(wave.firstSampleIndex, combined.gal[0], combined.gal[1], combined.gal[2])) {
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
   * **この呼び出しのあとに `ingest()` を呼んではいけない。** 呼ぶと投げる
   * （`ingest()` 自身のコメントを見ること）。
   */
  closeAll(): { readonly readings: readonly StationIntensityReading[]; readonly failures: readonly StationCloseFailure[] } {
    this.closed = true
    const readings: StationIntensityReading[] = []
    const failures: StationCloseFailure[] = []
    for (const group of this.groups) {
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
