// 地震検出をホストへ繋ぐ層（REQUIREMENTS.md §6・§9）。`main.ts` はこれを呼ぶだけにする。
//
//   合成波形（`FusedWaveChunk`）──→ 観測点ごとの QuakeDetector ──→ ShakeEventBook ──→ 保存・押し出し
//   観測点の計測震度相当 ─────────────────────────────────────↗（最大計測震度相当）
//   気象庁の地震情報（QuakeFeed）────────────────────────────↗（照合）
//
// **`main.ts` に書かない理由。** あちらは「直接実行のときだけ走らせる」門の内側で、自動テストが
// 届かない —— 配線を間違えても型検査は通り、症状は「揺れの記録が 1 件も出ない」だけになる
// （揺れていないのと見分けが付かない）。ここへ寄せて、配線そのものをテストで固める。
//
// **合成波形と同じ 1 本の流れから受ける**（`main.ts` の `publishWave`。押し出し・保存と同じ箇所）。
// 別の場所で拾うと、押し出した波形と検出に使った波形が食い違いうる。
//
// **投げない。** 検出・記録のどこで例外が出ても、受信と押し出しは止めない。数えて残す。

import type { FusedWaveChunk, StationIntensityReading } from '../receiver/sensorFusion'
import type { StationConfig } from '../receiver/stationConfig'
import type { P2pReferenceQuake } from './p2pQuake'
import { DETECTOR_VERSION, QuakeDetector } from './quakeDetector'
import type { DetectedShake } from './quakeDetector'
import type { QuakeFeedStatus } from './quakeFeed'
import { ShakeEventBook } from './shakeEventBook'
import type { ShakeEventRecord, ShakeSensorRef } from './shakeEvent'

/** 状態の口（`/status`）へ出す検出の健全性。 */
export interface DetectionStatus {
  readonly detectorVersion: number
  /** 検出器を動かしている観測点。 */
  readonly stations: readonly string[]
  /** 起動してから記録した揺れ（版 1）の数。 */
  readonly shakes: number
  /** 照合を待っている揺れの数。 */
  readonly pending: number
  /**
   * 以下 4 つは起動してからの合計（設定から外して捨てた観測点のぶんも含む）。
   *
   * 波形が途切れて検出器を作り直した回数。
   */
  readonly resets: number
  /** 刻みが読めない・粗すぎて捨てた合成波形のまとまりの数。 */
  readonly droppedChunks: number
  /** P/S の窓の中で波形が途切れていた・非有限値が混じっていて、拾わなかった揺れの数（揺れは記録してある）。 */
  readonly phaseWindowsBroken: number
  /** P/S の拾い出しで例外が出た揺れの数（揺れは記録してある）。 */
  readonly phaseFailures: number
  /** 検出・記録の途中で例外が出た回数。**0 でなければ、その揺れは記録されていない。** */
  readonly failures: number
  readonly lastFailure: string | null
  readonly store: { readonly written: number; readonly writeErrors: number; readonly lastWriteError: string | null }
  /** 気象庁の地震情報の受信。止めてあれば null。 */
  readonly feed: QuakeFeedStatus | null
}

export interface StationDetectionOptions {
  readonly save: (rec: ShakeEventRecord) => void
  readonly publish: (rec: ShakeEventRecord) => void
  readonly storeStatus: () => DetectionStatus['store']
  readonly feedCovered: (fromMs: number, toMs: number) => boolean
  readonly feedStatus: () => QuakeFeedStatus | null
  readonly config: () => StationConfig
  readonly now: () => number
  /**
   * 記録の口。`key` は間引きの鍵（揺れの行は揺れの `id`、失敗は `failure:<どこで>`）。
   * **鍵を 1 つにしないこと** —— 呼び出し側は鍵ごとに間引くので、2 件目からの揺れが黙り、
   * 失敗も 1 つの原因が他の原因の初回の行を抑える。
   */
  readonly log: (level: 'log' | 'warn' | 'error', key: string, line: string) => void
}

/** 数え上げ 1 つぶん（毎分の要約・終了時の累計へ出す）。 */
export interface DetectionCountEntry {
  /** 要約で前回値を引くための鍵（見出しとは別に持つ）。 */
  readonly key: string
  readonly label: string
  readonly value: number
}

/**
 * 検出と地震情報の受信の数え上げを、要約へ出す並びで返す。**毎分の要約も終了時の累計もここから引く**
 * （欄を 1 つずつ書き写すと、数を足したとき片方へ書き忘れる）。
 *
 * **どれも `/status` には出ているが、それだけでは足りない** —— 状態の口は見に来た人にしか届かず、
 * 記録できなかった揺れは `/events` にも現れない。
 */
export function detectionCountEntries(s: DetectionStatus): DetectionCountEntry[] {
  const out: DetectionCountEntry[] = [
    { key: 'detectFailed', label: '地震検出・揺れの記録の途中で例外を受け止めた', value: s.failures },
    { key: 'eventWriteFailed', label: '揺れの記録を書けず', value: s.store.writeErrors },
    { key: 'detectDropped', label: '地震検出に使えず捨てた合成波形のまとまり', value: s.droppedChunks },
    { key: 'phaseWindowBroken', label: '波形の途切れで P/S を拾わなかった揺れ', value: s.phaseWindowsBroken },
    { key: 'phaseFailed', label: 'P/S の拾い出しで例外を受け止めた揺れ', value: s.phaseFailures },
  ]
  if (s.feed !== null) {
    out.push(
      { key: 'quakeFeedReconnects', label: '地震情報の受信を繋ぎ直した', value: s.feed.reconnects },
      { key: 'quakeFeedHistoryFailed', label: '地震情報の履歴を取れず', value: s.feed.historyFailures },
      { key: 'quakeFeedUnreadable', label: '読めなかった地震情報', value: s.feed.unreadableMessages },
    )
  }
  return out
}

/** 観測点に割り当てられた、有効なセンサー。 */
export function sensorsOf(config: StationConfig, stationId: string): ShakeSensorRef[] {
  const out: ShakeSensorRef[] = []
  for (const board of config.boards) {
    if (board.stationId !== stationId) continue
    for (const s of board.sensors) {
      if (s.enabled) out.push({ boardKey: board.boardKey, sensorId: s.sensorId })
    }
  }
  return out
}

export class StationDetection {
  private readonly opts: StationDetectionOptions
  private readonly detectors = new Map<string, QuakeDetector>()
  private readonly book: ShakeEventBook
  private shakes = 0
  private failures = 0
  private lastFailure: string | null = null
  /** 設定から外して捨てた検出器の数え上げ（合計を減らさないため）。 */
  private retired = { resets: 0, droppedChunks: 0, phaseWindowsBroken: 0, phaseFailures: 0 }

  constructor(options: StationDetectionOptions) {
    this.opts = options
    this.book = new ShakeEventBook({
      save: options.save,
      publish: options.publish,
      observerOf: (stationId) => {
        const s = options.config().stations.find((x) => x.stationId === stationId)
        return s === undefined || !Number.isFinite(s.lat) || !Number.isFinite(s.lon) ? null : { lat: s.lat, lon: s.lon }
      },
      feedCovered: options.feedCovered,
      now: options.now,
      detectorVersion: DETECTOR_VERSION,
    })
  }

  /** 合成波形を 1 まとまり渡す。閉じた揺れがあれば記録する。 */
  pushStationWave(w: FusedWaveChunk): void {
    let detector = this.detectors.get(w.stationId)
    if (detector === undefined) {
      detector = new QuakeDetector()
      this.detectors.set(w.stationId, detector)
    }
    let closed: DetectedShake[]
    try {
      closed = detector.push(w)
    } catch (error) {
      this.fail('detect', `[detect] ${w.stationId} の検出に失敗: ${messageOf(error)}`)
      return
    }
    for (const shake of closed) this.record(w.stationId, shake)
  }

  noteStationReading(r: StationIntensityReading): void {
    try {
      this.book.noteStationReading(r.stationId, r.atMs, r.intensity)
    } catch (error) {
      this.fail('reading', `[detect] ${r.stationId} の計測震度相当を覚えられず: ${messageOf(error)}`)
    }
  }

  addQuake(quake: P2pReferenceQuake): void {
    try {
      this.book.addQuake(quake)
    } catch (error) {
      this.fail('match', `[detect] 地震情報との照合に失敗: ${messageOf(error)}`)
    }
  }

  /** 照合の期限を見る。定期的に呼ぶ。 */
  tick(): void {
    try {
      this.book.tick()
    } catch (error) {
      this.fail('deadline', `[detect] 照合の期限の処理に失敗: ${messageOf(error)}`)
    }
  }

  /**
   * 設定から外れた観測点の検出器を捨てる（開いている揺れは閉じて記録する）。
   * 設定を変えたときに呼ぶ。
   */
  forgetRemovedStations(): void {
    const known = new Set(this.opts.config().stations.map((s) => s.stationId))
    for (const [stationId, detector] of this.detectors) {
      if (known.has(stationId)) continue
      for (const shake of detector.flush()) this.record(stationId, shake)
      this.retired.resets += detector.resets
      this.retired.droppedChunks += detector.droppedChunks
      this.retired.phaseWindowsBroken += detector.phaseWindowsBroken
      this.retired.phaseFailures += detector.phaseFailures
      this.detectors.delete(stationId)
    }
  }

  /** 終了の前に、開いている揺れを閉じて記録する。 */
  flushAll(): void {
    for (const [stationId, detector] of this.detectors) {
      for (const shake of detector.flush()) this.record(stationId, shake)
    }
  }

  snapshot(): DetectionStatus {
    const totals = { ...this.retired }
    for (const d of this.detectors.values()) {
      totals.resets += d.resets
      totals.droppedChunks += d.droppedChunks
      totals.phaseWindowsBroken += d.phaseWindowsBroken
      totals.phaseFailures += d.phaseFailures
    }
    return {
      detectorVersion: DETECTOR_VERSION,
      stations: [...this.detectors.keys()].sort(),
      shakes: this.shakes,
      pending: this.book.pendingCount,
      ...totals,
      failures: this.failures,
      lastFailure: this.lastFailure,
      store: this.opts.storeStatus(),
      feed: this.opts.feedStatus(),
    }
  }

  private record(stationId: string, shake: DetectedShake): void {
    try {
      const rec = this.book.addShake(stationId, shake, sensorsOf(this.opts.config(), stationId))
      this.shakes++
      this.opts.log(
        'log',
        rec.id,
        `[detect] ${stationId} 揺れ ${new Date(rec.startMs).toISOString()} 平常時の ${rec.peakRatio.toFixed(1)} 倍・` +
          `${rec.shakeClass === 'quake-like' ? '地震らしい' : '生活振動らしい'}・${rec.verdict === 'quake' ? `地震と一致（${rec.matchedQuake?.name ?? ''}）` : '照合待ち'}`,
      )
    } catch (error) {
      this.fail('record', `[detect] ${stationId} の揺れを記録できず: ${messageOf(error)}`)
    }
  }

  /** 失敗を数えて残す。`where` は間引きの鍵（原因ごとに分け、1 つの原因が他を黙らせないように）。 */
  private fail(where: 'detect' | 'reading' | 'match' | 'deadline' | 'record', line: string): void {
    this.failures++
    this.lastFailure = line
    this.opts.log('error', `failure:${where}`, line)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
