// 観測点（複数センサーの合成）1 つずつの生存を覚える。`sensorHealth.ts` と対称。
//
// **`SensorHealthBook` では代わりにならない。** あちらはセンサー単位で、合成の結果
// （観測点ぶんの計測震度・締めくくり失敗・合成の流し込みが作れているか）は持たない。
//
// **覚える単位は観測点。** `SensorFusion` が観測点ごとに 1 つの合成グループを持つのと揃える。

import type { StationIntensityReading } from './sensorFusion'

/** 覚えていられる観測点の数。**`SensorFusion` のグループ数を超えることはない。** */
const MAX_STATIONS_DEFAULT = 64

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
    }
    this.entries.set(stationId, created)
    return created
  }
}
