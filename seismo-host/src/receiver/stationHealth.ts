// 観測点（複数センサーの合成）1 つずつの生存を覚える。`sensorHealth.ts` と対称。
//
// **`SensorHealthBook` では代わりにならない。** あちらはセンサー単位で、合成の結果
// （観測点ぶんの計測震度・締めくくり失敗・合成の流し込みが作れているか）は持たない。
//
// **覚える単位は観測点。** `SensorFusion` が観測点ごとに 1 つの合成グループを持つのと揃える。

import type {
  FusedWaveChunk,
  SensorMemberRef,
  SensorPairDiff,
  StationIntensityReading,
} from './sensorFusion'

/** 覚えていられる観測点の数。**`SensorFusion` のグループ数を超えることはない。** */
const MAX_STATIONS_DEFAULT = 64

/** 3 成分。 */
const AXES = 3

/**
 * センサー対 1 組ぶんの差分の強さ（REQUIREMENTS.md §7・#315）。
 *
 * **時系列そのものは持たない。** 9 台なら全ペアで 36 組・毎秒およそ 180 KB になり、
 * 状態の口（見に来たときの姿を返すもの）が抱える量ではない。§7 が挙げる用途のうち
 * **自己ノイズの推定・異常センサーの検出・一致度の確認はこの数値 1 つで足りる**
 * ——時系列が要るのは coherence 解析とロバスト平均で、そこは別の口の仕事。
 */
export interface StationPairDiff {
  readonly a: SensorMemberRef
  readonly b: SensorMemberRef
  /**
   * 軸ごとの差分の強さ（RMS・gal）。**測れなかった軸は null。**
   *
   * **0 で埋めない。** 0 は「2 台がぴったり一致した」を意味してしまうが、
   * ここで起きるのは「両方の値が揃うサンプルが 1 つも無かった」——別の事実。
   *
   * **軸ごとに出す。** 感度のずれは軸ごとに現れる（実機の Z 軸が 662〜1200 gal に
   * 散っている。#367）ので、1 つに丸めるとどの軸がおかしいのかが消える。
   */
  readonly rmsGal: readonly [number | null, number | null, number | null]
  /** RMS に使えたサンプル数（軸ごと）。 */
  readonly sampleCount: readonly [number, number, number]
}

/**
 * 差分 1 組ぶんの強さを出す。**両方の値が揃うサンプルだけで計算する。**
 *
 * `diffGal` は片方でも欠ければ null（`sensorFusion.ts` が外挿しない）。
 * **欠けを 0 として混ぜてはいけない** —— 揃っていないサンプルほど
 * 「差が無かった」方向へ引っ張り、離れている対を見落とす。
 */
export function pairDiffStrength(diff: SensorPairDiff): StationPairDiff {
  const rmsGal: [number | null, number | null, number | null] = [null, null, null]
  const sampleCount: [number, number, number] = [0, 0, 0]
  for (let axis = 0; axis < AXES; axis++) {
    let sum = 0
    let n = 0
    for (const v of diff.diffGal[axis]) {
      if (v === null) continue
      sum += v * v
      n++
    }
    sampleCount[axis] = n
    if (n > 0) rmsGal[axis] = Math.sqrt(sum / n)
  }
  return { a: diff.memberA, b: diff.memberB, rmsGal, sampleCount }
}

/** 観測点 1 つの様子。 */
export interface StationHealth {
  readonly stationId: string
  /**
   * 最後にこの観測点の状態へ触れた時刻。**受け手の時計で測る。**
   *
   * **`lastReadingAtMs` の代わりにはならない。** あちらは「震度が出た時刻」で、
   * こちらは震度・skip 理由・締めくくり失敗のいずれかに触れた時刻——合成が
   * 恒久的に壊れて震度が二度と出なくなった場合でも、駆動役からのパケットが
   * 届き続けている限り `noteSkip` は呼ばれ続けるので、この欄だけは動き続ける。
   * これが無いと、「観測点が丸ごと沈黙した」のか「駆動役は生きているが合成だけ
   * 壊れている」のかを `/status` から見分けられない（センサー側は
   * `sensors[].lastPacketMs` で見分けられるのと非対称になる）。
   */
  readonly lastPacketMs: number
  /** 最後に出せた合成の計測震度。まだ 1 つも出ていなければ null。 */
  readonly lastIntensity: number | null
  /** その震度が代表する時刻。基板が名乗る時間軸。 */
  readonly lastReadingAtMs: number | null
  /**
   * 合成の計測震度を出せない理由。出せているなら null。
   *
   * **駆動役の到着でだけ更新される。** `SensorFusion.FusionOutcome.intensitySkipReason` と
   * 同じ意味で、震度が出た回（`noteReading`）にだけクリアする——`sensorHealth.ts` の
   * `lastSkipReason` と同じ設計。
   */
  readonly lastSkipReason: string | null
  /** 合成の流し込みの締めくくりに失敗した回数。**0 が正常。** */
  readonly closeFailures: number
  /** 最後に締めくくりが失敗した理由。失敗していなければ null。 */
  readonly lastCloseFailure: string | null
  /**
   * 最後に合成したまとまりで、実際に混ざったセンサーの本数（最小・最大）。
   * まだ 1 つも合成していなければどちらも null。
   *
   * **大きく揺れ動いていれば異常を疑う手掛かりになる。** 混ざる顔ぶれがサンプルごとに
   * 入れ替わると、センサー間の直流差が段差として乗って震度が跳ねる
   * （2026-09-28 に実機で起きた #362。手当て前は 1〜7 本を揺れ動いていた）。
   *
   * **ただし小さな幅は実機では常態で、異常ではない。** まとまりの末尾は裏付けの
   * 同じ時刻のサンプルがまだ届いておらず、実測では 30 サンプル中 28 個が 9 本・
   * 末尾 2 個が 8・7 本だった（REQUIREMENTS.md §7）。**どこからが異常かの物差しは
   * 未設計**（#374）——この欄は数を出すだけで、判定はしない。
   *
   * **最新の 1 まとまりだけを見る。** 累計のヒストグラムは持たない ——
   * 症状は 30 サンプルぶんの 1 まとまりの中でも「最小 1・最大 7」として現れるので、
   * いまの姿が読めれば足りる（`gravity` の `verdicts` と同じ「いまの姿」の扱い）。
   */
  readonly lastMemberCountMin: number | null
  readonly lastMemberCountMax: number | null
  /**
   * センサー対ごとの差分の強さ（§7・#315）。**最新のまとまりだけ。**
   *
   * **離れている対が異常なセンサーの印。** 2 台が同じ地面の揺れを測っているなら
   * 引き算で揺れは打ち消え、残るのは各センサーの自己ノイズ —— そこへ
   * 向きの違い・感度のずれ・故障が乗ると、その対だけ値が突出する。
   *
   * **どの値を「おかしい」とするかの判定は持たない**（閾値が未設計。#370 の範囲外）。
   */
  readonly pairDiffs: readonly StationPairDiff[]
}

export interface StationHealthBookOptions {
  readonly maxStations?: number
  /** 時計。テストのために差し替える。 */
  readonly now?: () => number
}

interface Entry {
  readonly stationId: string
  lastPacketMs: number
  lastIntensity: number | null
  lastReadingAtMs: number | null
  lastSkipReason: string | null
  closeFailures: number
  lastCloseFailure: string | null
  lastMemberCountMin: number | null
  lastMemberCountMax: number | null
  pairDiffs: readonly StationPairDiff[]
}

export class StationHealthBook {
  private readonly maxStations: number
  private readonly now: () => number
  /** `Map` の挿入順が「いちばん長く音沙汰が無い順」になるよう、触れたら入れ直す。 */
  private readonly entries = new Map<string, Entry>()
  private evictedCount = 0

  constructor(options: StationHealthBookOptions = {}) {
    this.maxStations = options.maxStations ?? MAX_STATIONS_DEFAULT
    this.now = options.now ?? Date.now
  }

  /** 合成の計測震度が 1 つ出た。 */
  noteReading(reading: StationIntensityReading): void {
    const entry = this.touch(reading.stationId)
    // **窓の中身が足りずに `null` で出た回も「震度が出た」として覚える。**
    // 値を上書きしないのは、直前まで出ていた値を消さないため（`sensorHealth.ts` と同じ）。
    if (reading.intensity !== null) entry.lastIntensity = reading.intensity
    entry.lastReadingAtMs = reading.atMs
    // **震度が出た＝出せない理由はもう無い。**
    entry.lastSkipReason = null
  }

  /**
   * 合成の計測震度が出せない理由が変わった（または初めて立った）。
   *
   * **`reason` が null なら何もしない。** `FusionOutcome.intensitySkipReason` は
   * 駆動役の到着のたびに「いまの状態」を返すため、null（正常）を無条件に反映すると
   * `noteReading` が置いた「震度が出た」印より先にここが通ったとき、震度が出た事実の
   * ほうを消してしまう——理由をクリアする役目は `noteReading` に一本化する。
   */
  noteSkip(stationId: string, reason: string | null): void {
    if (reason === null) return
    const entry = this.touch(stationId)
    entry.lastSkipReason = reason
  }

  /**
   * 合成波形が 1 まとまり出た（#315）。**混ざった本数だけを覚える。**
   *
   * 波形そのものは持たない —— 状態の口は「見に来たときの姿」を返すもので、
   * 毎秒 15 KB の時系列を抱える場所ではない（波形を見たい相手は
   * `/stream?wave=1` へ繋ぐ）。
   */
  noteWave(wave: FusedWaveChunk): void {
    // **空のまとまりでは触らない。** `SensorFusion` は空を返さないが、
    // 触ると「最後に合成した」印（`lastPacketMs`）だけが動いて、
    // 本数は null のまま残る形になる。
    if (wave.memberCount.length === 0) return
    const entry = this.touch(wave.stationId)
    let min = wave.memberCount[0]
    let max = wave.memberCount[0]
    for (const n of wave.memberCount) {
      if (n < min) min = n
      if (n > max) max = n
    }
    entry.lastMemberCountMin = min
    entry.lastMemberCountMax = max
  }

  /**
   * センサー対ごとの差分が出た（#315）。**強さへ要約して覚える。**
   *
   * **空でも書き換える。** 空は日常的に起きる正当な状態 —— センサーを無効化して
   * 観測点が 2 台から 1 台へ縮小すると、`sensorFusion.ts` の差分の組み立ては
   * 二重ループが 1 度も回らず空を返す。**何もしない形にすると、混ざった本数は
   * 1 本へ更新されるのに、差分の最大がもう存在しない対を指したまま固まる**
   * ——画面では「無効化したのにこの対の差分が残っている（＝直っていない）」と
   * 読める。しかもこの帳面は起動時に 1 度作るだけで、設定を変えて `SensorFusion` を
   * 作り直しても作り直さないので、**プロセスを入れ直すまで解消しない**
   * （2026-09-28 の敵対的レビューが指摘）。
   *
   * **観測点は引数で受ける。** 空配列からは観測点が引けないので、
   * 「空で消す」ことと「何も渡されていない」ことを区別できる形にする。
   *
   * **渡された観測点のぶんだけ採る。** `SensorFusion.ingest()` は 1 観測点ぶんしか
   * 返さないので混ざらないが、型はそれを保証しない —— 混ざった一覧を渡されても
   * 別の観測点の対が紛れ込まない形にしておく。
   */
  notePairDiffs(stationId: string, diffs: readonly SensorPairDiff[]): void {
    this.touch(stationId).pairDiffs = diffs
      .filter((d) => d.stationId === stationId)
      .map(pairDiffStrength)
  }

  /** 合成の流し込みの締めくくりに失敗した。 */
  noteCloseFailure(stationId: string, detail: string): void {
    const entry = this.touch(stationId)
    entry.closeFailures += 1
    entry.lastCloseFailure = detail
  }

  /** 上限で押し出した数。 */
  get evictions(): number {
    return this.evictedCount
  }

  /** いま覚えている数。 */
  get size(): number {
    return this.entries.size
  }

  /** **音沙汰の新しい順**に返す。黙ったものが末尾へ寄る。 */
  snapshot(): readonly StationHealth[] {
    return [...this.entries.values()]
      .sort((a, b) => b.lastPacketMs - a.lastPacketMs)
      .map((e) => ({
        stationId: e.stationId,
        lastPacketMs: e.lastPacketMs,
        lastIntensity: e.lastIntensity,
        lastReadingAtMs: e.lastReadingAtMs,
        lastSkipReason: e.lastSkipReason,
        closeFailures: e.closeFailures,
        lastCloseFailure: e.lastCloseFailure,
        lastMemberCountMin: e.lastMemberCountMin,
        lastMemberCountMax: e.lastMemberCountMax,
        pairDiffs: e.pairDiffs,
      }))
  }

  private touch(stationId: string): Entry {
    const found = this.entries.get(stationId)
    if (found !== undefined) {
      // **入れ直して挿入順を新しくする。** この順序が追い出しの根拠になる。
      //
      // **観測点には「パケットが届いた」に相当する事実が別に無い。** センサーの
      // `notePacket` のような専用の入口を持たないので、震度・skip理由・締めくくり
      // 失敗のいずれかに触れるたびを音沙汰ありとみなす。
      this.entries.delete(stationId)
      found.lastPacketMs = this.now()
      this.entries.set(stationId, found)
      return found
    }
    if (this.entries.size >= this.maxStations) {
      // **いちばん長く音沙汰の無いものを押し出す。** 新しいほうを拒むと、
      // 観測点を足した日からその 1 つが永久に映らない（`sensorHealth.ts` と同じ判断）。
      const oldest = this.entries.keys().next()
      if (!oldest.done) {
        this.entries.delete(oldest.value)
        this.evictedCount++
      }
    }
    const created: Entry = {
      stationId,
      lastPacketMs: this.now(),
      lastIntensity: null,
      lastReadingAtMs: null,
      lastSkipReason: null,
      closeFailures: 0,
      lastCloseFailure: null,
      lastMemberCountMin: null,
      lastMemberCountMax: null,
      pairDiffs: [],
    }
    this.entries.set(stationId, created)
    return created
  }
}
