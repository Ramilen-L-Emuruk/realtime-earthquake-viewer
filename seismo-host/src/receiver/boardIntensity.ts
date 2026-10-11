// 基板 1 枚ぶんの計測震度相当（管理コンソールの稼働状況「基板ごとの震度」。#713-1）。
//
// **観測点の合成と同じ部品（`SensorFusion`）を、基板を 1 つの観測点に見立ててもう 1 系統回す。**
// 合成の中身には手を入れない —— 設定の写しで各基板の観測点を基板 Key に差し替えて渡すだけ
// （{@link boardFusionConfig}）。同じ観測点に置いた基板どうしで値が離れていれば、据え付けか
// センサーを疑う手掛かりになる。
//
// **ここで出した値は画面に見せるためだけのもの。** 震度の押し出し・合成波形の保存・地震検出には
// 渡さない —— あちらの値は観測点の合成が持つ。基板ごとの値まで流すと、同じ揺れが観測点の値と
// 基板の値の 2 通りで記録に残る。
//
// **センサーが 1 個だけの基板は合成しない**（`SensorFusion` は 2 台に満たない組を作らない）。
// その基板の値はセンサー単独の計測震度をそのまま採る（{@link buildBoardIntensities}。
// 合成しても同じ値になる。2026-10-11 ユーザー承認）。

import type { WaveChunk } from './intensityPipeline'
import { SensorFusion } from './sensorFusion'
import type { FusionOutcome, SensorFusionClosing, StationIntensityReading } from './sensorFusion'
import type { SensorHealth } from './sensorHealth'
import { StationHealthBook } from './stationHealth'
import type { StationHealth } from './stationHealth'
import type { StationConfig } from './stationConfigTypes'

/**
 * 基板ごとの合成へ渡す設定。**各基板の観測点を、その基板 Key に差し替える。**
 *
 * **観測点の一覧は空にする。** `SensorFusion` が読むのは `boards` だけで（`sensorFusion.ts` の
 * `buildGroups`）、座標も表示名も使わない。写しておくと、基板 Key を観測点 ID に見立てた
 * 偽の観測点が設定の形で残り、別の部品へ渡ったときに本物と見分けが付かない。
 */
export function boardFusionConfig(config: StationConfig): StationConfig {
  return {
    stations: [],
    boards: config.boards.map((b) => ({ ...b, stationId: b.boardKey })),
  }
}

export interface BoardFusionOptions {
  /** 時計。テストのために差し替える。 */
  readonly now?: () => number
  /**
   * 合成が投げた・締めくくりに失敗したときの知らせ先。**投げてはいけない。**
   *
   * **ここで受け止めて観測点の合成へ波及させない。** 基板ごとの値は見せるためだけのもので、
   * これが壊れたせいで観測点の震度や記録が止まるのは釣り合わない。
   */
  readonly onError: (where: string, detail: string) => void
}

/**
 * 基板ごとの合成と、その結果を覚える帳面をまとめて持つ。**どの口も投げない。**
 *
 * **帳面は作り直さない**（設定を変えても）。観測点の帳面（`stationHealth.ts`）と同じく、
 * 割り当てを外した基板の行は最後の値のまま残るが、画面へ出す行は**いまの設定の基板だけ**
 * （{@link buildBoardIntensities} が設定から引く）なので表には現れない。
 *
 * **終了するときは締めない。** 値は `/status` で見せるだけで、どこにも残さない —— 締めて出る
 * 最後の 1 秒ぶんは、プロセスと一緒に消えても誰も読まない。
 */
export class BoardFusion {
  /**
   * いまの合成。**作り直しに失敗したら null**（次の作り直しまで渡さない）—— 締めた古いインスタンスを
   * 残すと、以後のまとまりのたびに投げ、ログの間引きで黙ったまま表が凍る。
   */
  private fusion: SensorFusion | null
  private readonly book: StationHealthBook
  private readonly onError: (where: string, detail: string) => void

  constructor(config: StationConfig, options: BoardFusionOptions) {
    this.book = new StationHealthBook(options.now === undefined ? {} : { now: options.now })
    this.onError = options.onError
    this.fusion = this.build(config)
  }

  /**
   * 波形が 1 まとまり届いた。観測点の合成へ渡したものと同じまとまりを渡す。
   *
   * **帳面へ書く段まで囲う。** ここで投げると、呼び出し側（受信の処理）が同じパケットで後に
   * 控えている処理まで落とす。
   */
  ingest(wave: WaveChunk, receivedAtMs: number | null): void {
    if (this.fusion === null) return
    let outcomes: readonly FusionOutcome[]
    try {
      outcomes = this.fusion.ingest(wave, receivedAtMs)
    } catch (error) {
      this.onError(wave.boardKey, messageOf(error))
      return
    }
    for (const outcome of outcomes) this.attempt(wave.boardKey, () => this.absorb(outcome))
  }

  /**
   * 設定が変わった。**古い合成を締めてから作り直す**（観測点の合成と同じ順。`main.ts` の
   * `applyStationConfigCore`）—— 締めずに捨てると、作り直す直前の数秒ぶんの震度が帳面に残らない。
   */
  rebuild(config: StationConfig): void {
    const old = this.fusion
    if (old !== null) {
      let closing: SensorFusionClosing | null = null
      try {
        closing = old.closeAll()
      } catch (error) {
        this.onError('締めくくり', messageOf(error))
      }
      // **1 件ずつ受け止める**（`main.ts` の `deliverFusionClosing` と同じ）。束ねて囲うと、1 件目で
      // 投げたとき別の基板の分まで消える。
      if (closing !== null) {
        for (const outcome of closing.drained) {
          this.attempt(`${outcome.fusedWave.stationId} の締めくくり`, () => this.absorb(outcome))
        }
        for (const f of closing.failures) {
          this.attempt(`${f.stationId} の締めくくり`, () => this.noteCloseFailure(f.stationId, f.detail))
        }
        for (const r of closing.readings) {
          this.attempt(`${r.stationId} の締めくくり`, () => this.noteReading(r))
        }
      }
    }
    // **締めくくりが失敗しても作り直す。** 締めた古いインスタンスへ次の `ingest` を渡すと投げ続ける。
    this.fusion = this.build(config)
  }

  /** 1 件ぶんを実行し、投げたら知らせて先へ進む。 */
  private attempt(where: string, run: () => void): void {
    try {
      run()
    } catch (error) {
      this.onError(where, messageOf(error))
    }
  }

  /** 設定から合成を作る。**投げない**（失敗は知らせて null を返す）。 */
  private build(config: StationConfig): SensorFusion | null {
    try {
      return new SensorFusion(boardFusionConfig(config))
    } catch (error) {
      this.onError('作り直し', messageOf(error))
      return null
    }
  }

  /** 基板 Key を観測点 ID の欄に持つ（`StationHealth.stationId` が基板 Key）。 */
  snapshot(): readonly StationHealth[] {
    return this.book.snapshot()
  }

  private absorb(outcome: FusionOutcome): void {
    if (outcome.closeFailure !== null) this.noteCloseFailure(outcome.closeFailure.stationId, outcome.closeFailure.detail)
    for (const r of outcome.readings) this.noteReading(r)
    this.book.noteWave(outcome.fusedWave, outcome.allMembersCovered)
    this.book.noteSkip(outcome.fusedWave.stationId, outcome.intensitySkipReason)
  }

  private noteReading(r: StationIntensityReading): void {
    this.book.noteReading(r)
  }

  private noteCloseFailure(boardKey: string, detail: string): void {
    this.book.noteCloseFailure(boardKey, detail)
    this.onError(`${boardKey} の締めくくり`, detail)
  }
}

/**
 * 基板の値の出どころ。
 *
 * - `fused`: 有効なセンサーが 2 個以上 —— 基板ごとの合成の値
 * - `single`: 有効な 3 軸のセンサーが 1 個だけ —— そのセンサー単独の値（2026-10-11 ユーザー承認）
 * - `two-axis`: 有効なセンサーが 2 軸の 1 個だけ —— 震度を出さないのが正しい状態
 *   （センサーの表の「2 軸」と同じ扱い）
 * - `no-sensor`: 有効なセンサーが無い —— 値は出せない
 */
export type BoardIntensitySource = 'fused' | 'single' | 'two-axis' | 'no-sensor'

/** 基板 1 枚ぶんの行。**並びは設定の基板の並びのまま**（{@link buildBoardIntensities}）。 */
export interface BoardIntensity {
  readonly boardKey: string
  /** 基板の表示名。名前を付けていなければ null。 */
  readonly boardName: string | null
  readonly stationId: string
  /** 観測点の表示名。設定に観測点が見つからなければ null。 */
  readonly stationName: string | null
  readonly source: BoardIntensitySource
  /**
   * 最後に音沙汰があった時刻（受け手の時計）。`fused` は基板ごとの合成が最後に触れた時刻、
   * `single`・`two-axis` はそのセンサーが最後に届いた時刻。まだ無ければ null。
   */
  readonly lastPacketMs: number | null
  /** 最後に出せた計測震度相当。まだ出ていなければ null。 */
  readonly lastIntensity: number | null
  /**
   * 最後に震度が出た時刻（受け手の時計）。**震度の欄の古さはこれで測る**
   * （`stationHealth.ts` の `lastReadingReceivedMs` と同じ理由）。
   *
   * `single` はセンサーが届いた時刻を入れる —— センサー単独の震度はパケットごとに出て、
   * 出せなくなれば `lastSkipReason` が立つ（管理コンソールのセンサーの表と同じ測り方）。
   */
  readonly lastReadingReceivedMs: number | null
  /** 震度を出せない理由。出せているなら null。 */
  readonly lastSkipReason: string | null
  /** 最後に合成したまとまりで混ざった本数（`fused` のときだけ。ほかは null）。 */
  readonly lastMemberCountMin: number | null
  readonly lastMemberCountMax: number | null
}

/**
 * 稼働状況の「基板ごとの震度」の行を組む。**設定の基板の並びのまま、全部の基板を出す。**
 *
 * **出どころはいまの設定で決める**（有効なセンサーの数と軸の本数）。帳面に古い合成の行が
 * 残っていても、1 個へ減らした基板はセンサー単独の値へ切り替わる。
 */
export function buildBoardIntensities(
  config: StationConfig,
  fused: readonly StationHealth[],
  sensors: readonly SensorHealth[],
): BoardIntensity[] {
  const fusedByBoard = new Map(fused.map((f) => [f.stationId, f]))
  const stationName = new Map(config.stations.map((s) => [s.stationId, s.displayName]))
  return config.boards.map((board) => {
    const enabled = board.sensors.filter((s) => s.enabled)
    const base = {
      boardKey: board.boardKey,
      boardName: board.displayName ?? null,
      stationId: board.stationId,
      stationName: stationName.get(board.stationId) ?? null,
    }
    if (enabled.length >= 2) {
      const f = fusedByBoard.get(board.boardKey)
      return {
        ...base,
        source: 'fused' as const,
        lastPacketMs: f?.lastPacketMs ?? null,
        lastIntensity: f?.lastIntensity ?? null,
        lastReadingReceivedMs: f?.lastReadingReceivedMs ?? null,
        lastSkipReason: f?.lastSkipReason ?? null,
        lastMemberCountMin: f?.lastMemberCountMin ?? null,
        lastMemberCountMax: f?.lastMemberCountMax ?? null,
      }
    }
    const only = enabled[0]
    if (only === undefined) {
      return {
        ...base,
        source: 'no-sensor' as const,
        lastPacketMs: null,
        lastIntensity: null,
        lastReadingReceivedMs: null,
        lastSkipReason: null,
        lastMemberCountMin: null,
        lastMemberCountMax: null,
      }
    }
    const s = sensors.find((h) => h.boardKey === board.boardKey && h.sensorId === only.sensorId)
    const twoAxis = only.axes.length === 2
    return {
      ...base,
      source: twoAxis ? ('two-axis' as const) : ('single' as const),
      lastPacketMs: s?.lastPacketMs ?? null,
      lastIntensity: twoAxis ? null : (s?.lastIntensity ?? null),
      lastReadingReceivedMs: twoAxis ? null : (s?.lastPacketMs ?? null),
      lastSkipReason: twoAxis ? null : (s?.lastSkipReason ?? null),
      lastMemberCountMin: null,
      lastMemberCountMax: null,
    }
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
