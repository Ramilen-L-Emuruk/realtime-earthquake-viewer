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
import { JST_OFFSET_MS } from '../receiver/jstTime'
import { emptyTriggerHealth } from './quakeTrigger'
import type { TriggerHealth, TriggerPeak } from './quakeTrigger'
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
  /**
   * 観測点ごとの引き金のいまの状態（`TriggerHealth`）。**揺れの記録が 0 件のとき、静かだった
   * だけか止まっているかを見分ける材料**（`shakes` などの数え上げだけでは見分けられない）。
   *
   * **設定にある観測点を全部載せる** —— 合成波形が一度も来ていない観測点（有効なセンサーが
   * 2 台に満たず合成が組まれない等）は検出器そのものが作られず、`stations` に現れない。
   * そこを載せないと、いちばん見つけたい「止まっている」形が一覧から消える。
   */
  readonly triggers: readonly StationTriggerStatus[]
}

/** 観測点 1 つぶんの引き金の状態。 */
export interface StationTriggerStatus extends TriggerHealth {
  readonly stationId: string
  /**
   * 検出器が最後にサンプルを使えた時刻を、**ホストの時計で**（`StationDetectionOptions.now`）。
   * 一度も使えていなければ null。
   *
   * **「届いているか」はこちらで見る。** `lastSampleMs` は基板が名乗るデータの時刻なので、
   * 基板の時計が先へずれていると「最後のサンプルが未来」になり、止まっても古くならない。
   */
  readonly lastFedAtMs: number | null
  /**
   * この観測点で、刻みが読めない・粗すぎて捨てた合成波形のまとまりの数（起動してからの合計）。
   * **波形は届いているのに使えていない**形を、「届いていない」と見分ける手がかり。
   */
  readonly droppedChunks: number
}

/** 1 時間に 1 度の行（`StationDetection.hourlyLines`）。 */
export interface DetectionHourlyLine {
  readonly level: 'log' | 'warn'
  /** 間引きの鍵。観測点ごとに分ける（1 つにすると 2 つ目の観測点の行が黙る）。 */
  readonly key: string
  readonly line: string
}

/**
 * 検出器が最後にサンプルを使えてから（ホストの時計で）これだけ経っていたら「波形が届いていない」と
 * 書く（ミリ秒）。
 *
 * **1 時間に 1 度の行なので、短い途切れは拾わなくてよい**（途切れは `resets` と毎分の要約が
 * 拾う）。合成波形は 0.3 秒ごとに届くので、1 分来なければ止まっていると言える。
 */
export const HOURLY_SILENT_AFTER_MS = 60_000

/** 日本時間の `HH:MM`。`nowMs` と日本時間の日付が違えば `MM/DD HH:MM`。 */
function jstClock(ms: number, nowMs: number): string {
  const d = new Date(ms + JST_OFFSET_MS)
  const now = new Date(nowMs + JST_OFFSET_MS)
  const two = (n: number): string => String(n).padStart(2, '0')
  const hm = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate()
  return sameDay ? hm : `${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())} ${hm}`
}

/**
 * 平常時の揺れの見せ方。**0 と 0.01 未満を分ける** —— 小数 2 桁へ丸めるだけだと、平らな値しか
 * 来ていない（センサーが動いていない）のと、ごく静かなのが同じ「0.00」に見える。
 */
function formatBaseline(gal: number | null): string {
  if (gal === null || !Number.isFinite(gal)) return '不明'
  if (gal === 0) return '0 gal'
  if (gal < 0.01) return '0.01 gal 未満'
  return `${gal.toFixed(2)} gal`
}

/**
 * 観測点 1 つぶんの、1 時間に 1 度の行を組む。
 *
 * - **一度も波形が来ていない／`HOURLY_SILENT_AFTER_MS` 来ていない** → 警告。止まっている
 * - **この 1 時間に引き金を引ける状態のサンプルが無い**（助走から抜けられない） → 警告
 * - それ以外 → 比の最大とその時刻・平常時の揺れ・いまの状態
 *
 * `hourPeak` は呼び出し側が引き金から引いた、この 1 時間の比の最大。`nowMs` はホストの時計。
 * 時刻はどれも日本時間で出す。
 *
 * **2 つの時計を混ぜない。** 「届いているか」はホストの時計（`lastFedAtMs` と `nowMs`）だけで、
 * 比の最大の時刻はデータの時刻だけで決まる（引き金がデータの時刻で進むため）。
 */
export function formatDetectionHourly(
  status: StationTriggerStatus,
  hourPeak: TriggerPeak | null,
  nowMs: number,
): DetectionHourlyLine {
  const head = `[detect] ${status.stationId} この 1 時間: `
  const key = `hourly:${status.stationId}`
  if (status.lastFedAtMs === null) {
    return { level: 'warn', key, line: `${head}波形が届いていない（起動から一度も）` }
  }
  if (nowMs - status.lastFedAtMs >= HOURLY_SILENT_AFTER_MS) {
    return { level: 'warn', key, line: `${head}波形が届いていない（最後は ${jstClock(status.lastFedAtMs, nowMs)}）` }
  }
  // 助走が明ける時刻を持たないのは、フィルタを組めずに待っているとき。残り秒数は言えない。
  const warmLeft =
    status.warmUntilMs !== null && status.lastSampleMs !== null
      ? `（あと ${Math.max(0, Math.round((status.warmUntilMs - status.lastSampleMs) / 1000))} 秒）`
      : ''
  const state = status.inEvent ? '揺れを記録中' : status.armed ? '見張り中' : `助走中${warmLeft}`
  const peak = hourPeak === null ? 'なし' : `${hourPeak.ratio.toFixed(2)} 倍（${jstClock(hourPeak.atMs, nowMs)}）`
  return {
    level: hourPeak === null ? 'warn' : 'log',
    key,
    line: `${head}比の最大 ${peak}・平常時の揺れ ${formatBaseline(status.baselineGal)}・${state}`,
  }
}

/**
 * 1 時間に 1 度の行を組んで出す（`main.ts` のタイマーが呼ぶ）。**組めたら true** を返し、呼び出し側は
 * そのときだけ起点を進める —— 失敗した回の 1 時間は、次の回が広い窓で拾い直す。
 *
 * **ここへ切り出してあるのは、`main.ts` の中に書くと自動テストが届かないから。** 投げない。
 */
export function emitDetectionHourly(
  build: () => readonly DetectionHourlyLine[],
  emit: (line: DetectionHourlyLine) => void,
  onError: (message: string) => void,
): boolean {
  let lines: readonly DetectionHourlyLine[]
  try {
    lines = build()
  } catch (error) {
    onError(messageOf(error))
    return false
  }
  for (const l of lines) emit(l)
  return true
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
  /** 観測点ごとに、検出器が最後にサンプルを使えた時刻（ホストの時計。`StationTriggerStatus.lastFedAtMs`）。 */
  private readonly fedAt = new Map<string, number>()

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
    const before = detector.lastSampleAtMs
    let closed: DetectedShake[]
    try {
      closed = detector.push(w)
    } catch (error) {
      this.fail('detect', `[detect] ${w.stationId} の検出に失敗: ${messageOf(error)}`)
      return
    } finally {
      // **使えたときだけ進める**（届いたかではなく）。刻みが読めず捨てたまとまりで進めると、
      // 検出が止まっているのに「届いている」に見える。
      if (detector.lastSampleAtMs !== before) this.fedAt.set(w.stationId, this.opts.now())
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
      this.fedAt.delete(stationId)
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
      triggers: this.stationIds().map((stationId) => this.triggerStatus(stationId)),
    }
  }

  /**
   * 観測点ごとの、1 時間に 1 度の行（`formatDetectionHourly`）。`sinceMs` は前回この行を
   * 出した時刻（初回は起動した時刻）、`nowMs` はいまの時刻で、**どちらもホストの時計**。
   *
   * **比の最大はデータの時刻の窓で引く** —— 最後のサンプルから `nowMs - sinceMs` だけ遡る
   * （1 分単位）。ホストの時計の範囲をそのまま渡すと、基板の時計がずれた分だけ窓が外れ、
   * 動いているのに「比の最大 なし」になる。
   */
  hourlyLines(sinceMs: number, nowMs: number): DetectionHourlyLine[] {
    const spanMs = Math.max(0, nowMs - sinceMs)
    return this.stationIds().map((stationId) => {
      const status = this.triggerStatus(stationId)
      const d = this.detectors.get(stationId)
      const last = status.lastSampleMs
      const peak = d === undefined || last === null ? null : d.peakBetween(last - spanMs, last)
      return formatDetectionHourly(status, peak, nowMs)
    })
  }

  private triggerStatus(stationId: string): StationTriggerStatus {
    const d = this.detectors.get(stationId)
    return {
      stationId,
      ...(d?.health() ?? emptyTriggerHealth()),
      lastFedAtMs: this.fedAt.get(stationId) ?? null,
      droppedChunks: d?.droppedChunks ?? 0,
    }
  }

  /** 設定にある観測点と、検出器を持つ観測点を合わせた一覧（並びは ID 順）。 */
  private stationIds(): string[] {
    const ids = new Set(this.opts.config().stations.map((s) => s.stationId))
    for (const id of this.detectors.keys()) ids.add(id)
    return [...ids].sort()
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
