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
import { formatBaseline, jstClock, SHAKE_CLASS_WORDS, SILENT_AFTER_MS, triggerStateWord } from './detectionWording'
import { emptyTriggerHealth } from './quakeTrigger'
import type { TriggerDetector, TriggerHealth, TriggerInput, TriggerPeak } from './quakeTrigger'
import { shakeEventId } from './shakeEvent'
import type { ShakeEventRecord, ShakeSensorRef } from './shakeEvent'
import { ShakeEventBook } from './shakeEventBook'

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

/**
 * 起動時の流し込みの結末（#617）。
 *
 * - `warm` —— 控えから前のプロセスの末尾と作り直した欠けを流し、溜めたライブへ繋いだ
 * - `cold` —— 流せず、溜めた分をそのまま空の検出器へ流した（今までと同じ助走から始まる）
 */
export type WarmStartOutcome =
  | {
      readonly kind: 'warm'
      /** 控えの末尾を流す間に、開けなかった時の数（その時の分は流せていない）。 */
      readonly hoursFailed: number
      /** 同じく、途中で打ち切って読んだ時の数（いま書いている時は数えない）。 */
      readonly hoursTruncated: number
      /**
       * 流した控えの中と、最後に流したまとまりから溜めたライブの最初のサンプルまでで、いちばん長い途切れ（ミリ秒）。
       * 引き金は 1 秒を超える途切れで作り直す（`quakeTrigger.ts` の `maxGapMs`）ので、これが 1 秒を超えていれば、
       * 見張りはどこかで助走からやり直している（止めていた間を取り戻せなかった等）。
       */
      readonly longestGapMs: number
    }
  | { readonly kind: 'cold'; readonly reason: WarmColdReason; readonly detail: string | null }

/**
 * 流せなかった理由。
 *
 * - `no-archive` —— 控えの 24 時間に、前のプロセスが残したライブの分が無い
 * - `read-failed` —— 控えを読めなかった
 * - `buffer-full` —— 溜めた分が {@link WARM_BUFFER_MAX_MS} を超えた（流し込みが返ってこない等）
 * - `stopped` —— 流し込みの前にホストを止めた
 * - `failed` —— 流し込みの途中で例外を受け止めた
 * - `timed-out` —— 流し込みが時間内に終わらなかった（`warmStart.ts` の `WARM_JOB_TIMEOUT_MS`）
 */
export type WarmColdReason = 'no-archive' | 'read-failed' | 'buffer-full' | 'stopped' | 'failed' | 'timed-out'

/** 起動時の流し込みの様子（観測点ごと。`/status` の `detection.triggers[].warmStart`）。 */
export interface WarmStartStatus {
  /** `holding` = 待っている／`replaying` = 控えから流している／`live` = ライブを直に流している。 */
  readonly phase: 'holding' | 'replaying' | 'live'
  /** 待ち始めた時刻（ホストの時計。その観測点の最初の波形が届いた時）。 */
  readonly heldSinceMs: number
  /** いま溜めているまとまりの数。 */
  readonly heldChunks: number
  /** 控えから流したまとまりの数。 */
  readonly replayedChunks: number
  /** これより前に始まった揺れは記録しない（前のプロセスの最後のサンプルの時刻・データの時刻）。無ければ null。 */
  readonly recordFromMs: number | null
  /** 結末。流し終える前は null。 */
  readonly outcome: WarmStartOutcome | null
  /**
   * 比の 24 時間の最大を控えから戻したか。`pending` = まだ／`restored` = 戻した／`partial` = 開けなかった・
   * 途中で打ち切った時を除いて戻した／`failed` = 戻せなかった／`skipped` = 戻さない（流し込みが `cold` で終わった等）。
   */
  readonly peaks: 'pending' | 'restored' | 'partial' | 'failed' | 'skipped'
  /** 境より前に始まったので記録しなかった揺れの数。 */
  readonly skippedBeforeBoundary: number
  /** 同じ id の記録が既にあったので書かなかった揺れの数。 */
  readonly skippedExisting: number
}

/**
 * 起動時の流し込みを待つ間に溜めてよい長さ（データの時刻・ミリ秒）。待ちは 60 秒で解き、流し込みは数百ミリ秒で
 * 済むので、ここへ届くのは流し込みが返ってこないときだけ。超えたら待つのをやめて空から流す。
 */
export const WARM_BUFFER_MAX_MS = 10 * 60_000

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
  /** 起動時の流し込みの様子。待たせない構成（`holdNewStations: false`）・波形がまだ届いていなければ null。 */
  readonly warmStart: WarmStartStatus | null
}

/** 1 時間に 1 度の行（`StationDetection.hourlyLines`）。 */
export interface DetectionHourlyLine {
  readonly level: 'log' | 'warn'
  /** 間引きの鍵。観測点ごとに分ける（1 つにすると 2 つ目の観測点の行が黙る）。 */
  readonly key: string
  readonly line: string
}

/**
 * 1 時間に 1 度の行で「波形が届いていない」と書くまで（ミリ秒）。**管理コンソールの見張りの行と
 * 同じ値**（`detectionWording.ts` の `SILENT_AFTER_MS`）。
 */
export const HOURLY_SILENT_AFTER_MS = SILENT_AFTER_MS

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
  const state = triggerStateWord(status)
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
  /**
   * その揺れの記録が既にあるか（`shakeEventStore.ts` の置き場所にファイルがあるか）。あれば版を書かない ——
   * 起動時の流し込みで、前のプロセスが書いた記録（照合の結果を含む）を版 1 で上書きしないため（#618 と同じ）。
   */
  readonly exists: (rec: Pick<ShakeEventRecord, 'id' | 'startMs'>) => boolean
  /**
   * 観測点の最初の波形が届いたら、検出へ渡さずに溜めて待つか（#617）。待ちを解くのは呼び出し側
   * （`warmStart.ts`）で、{@link StationDetection.beginWarm} から {@link StationDetection.finishWarm} までで控えを流す。
   */
  readonly holdNewStations: boolean
}

interface WarmEntry {
  phase: WarmStartStatus['phase']
  readonly heldSinceMs: number
  readonly firstSampleMs: number
  buffer: FusedWaveChunk[]
  replayedChunks: number
  recordFromMs: number | null
  outcome: WarmStartOutcome | null
  peaks: WarmStartStatus['peaks']
  skippedBeforeBoundary: number
  skippedExisting: number
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
  /** 起動時の流し込みの様子（観測点ごと。`holdNewStations` のときだけ作る）。 */
  private readonly warm = new Map<string, WarmEntry>()

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

  /**
   * ライブの合成波形を 1 まとまり渡す。閉じた揺れがあれば記録する。
   *
   * **起動時の流し込みを待っている観測点は、検出へ渡さずに溜める**（`holdNewStations`）。溜めた分は
   * {@link finishWarm} で控えの分の後ろへ流す。
   */
  pushStationWave(w: FusedWaveChunk): void {
    let warm = this.warm.get(w.stationId)
    if (warm === undefined && this.opts.holdNewStations) {
      warm = {
        phase: 'holding',
        heldSinceMs: this.opts.now(),
        firstSampleMs: w.firstSampleMs,
        buffer: [],
        replayedChunks: 0,
        recordFromMs: null,
        outcome: null,
        peaks: 'pending',
        skippedBeforeBoundary: 0,
        skippedExisting: 0,
      }
      this.warm.set(w.stationId, warm)
    }
    if (warm !== undefined && warm.phase !== 'live') {
      warm.buffer.push(w)
      const first = warm.buffer[0]
      if (w.firstSampleMs + w.gal[0].length * w.msPerSample - first.firstSampleMs > WARM_BUFFER_MAX_MS) {
        this.opts.log(
          'warn',
          `warm-cold:${w.stationId}`,
          `[detect] ${w.stationId} 起動時の流し込みが ${WARM_BUFFER_MAX_MS / 60_000} 分経っても終わらないので、待つのをやめて空から始める`,
        )
        this.goLive(w.stationId, warm, { kind: 'cold', reason: 'buffer-full', detail: null })
      }
      return
    }
    this.feed(w.stationId, w)
  }

  /** 起動時の流し込みを待っている観測点（`warmStart.ts` が待ちを解くかを決める）。 */
  heldStations(): { stationId: string; heldSinceMs: number; firstSampleMs: number }[] {
    const out: { stationId: string; heldSinceMs: number; firstSampleMs: number }[] = []
    for (const [stationId, w] of this.warm) {
      if (w.phase === 'holding') out.push({ stationId, heldSinceMs: w.heldSinceMs, firstSampleMs: w.firstSampleMs })
    }
    return out
  }

  /** 待ちを解いて、控えから流し始める。待っていなければ false。 */
  beginWarm(stationId: string): boolean {
    const w = this.warm.get(stationId)
    if (w === undefined || w.phase !== 'holding') return false
    w.phase = 'replaying'
    return true
  }

  /**
   * これより前に始まった揺れを記録しない（前のプロセスの最後のサンプルの時刻）。**ライブへ繋いだ後も効く** ——
   * 境の前に始まった揺れが、溜めたライブを流している最中に閉じることがある。
   */
  setRecordFloor(stationId: string, fromMs: number): void {
    const w = this.warm.get(stationId)
    if (w !== undefined && w.phase === 'replaying') w.recordFromMs = fromMs
  }

  /** 控えのまとまりを 1 つ流す（時刻順に）。流し込み中でなければ（打ち切られていれば）false。 */
  pushWarmChunk(stationId: string, chunk: TriggerInput): boolean {
    const w = this.warm.get(stationId)
    if (w === undefined || w.phase !== 'replaying') return false
    w.replayedChunks++
    this.feed(stationId, chunk)
    return true
  }

  /**
   * 控えから組み立て直した計測震度相当を覚える（境より後に始まった揺れの最大計測震度相当のため）。
   * 流し込み中でなければ何もしない。
   */
  noteWarmIntensity(stationId: string, atMs: number, intensity: number | null): void {
    const w = this.warm.get(stationId)
    if (w === undefined || w.phase !== 'replaying') return
    try {
      this.book.noteStationReading(stationId, atMs, intensity)
    } catch (error) {
      this.fail('reading', `[detect] ${stationId} の計測震度相当を覚えられず: ${messageOf(error)}`)
    }
  }

  /** 流し込みを終え、溜めたライブを流して直に流す形へ移る。流し込み中でなければ false。 */
  finishWarm(stationId: string, outcome: WarmStartOutcome): boolean {
    const w = this.warm.get(stationId)
    if (w === undefined || w.phase !== 'replaying') return false
    this.goLive(stationId, w, outcome)
    return true
  }

  /**
   * 裏で控えの 24 時間ぶんを流した引き金から、比の 1 分ごとの最大を重ねる（`TriggerDetector.mergePeaksFrom`）。
   * その観測点の検出器が無ければ false。
   */
  mergePeaks(stationId: string, from: TriggerDetector, complete: boolean): boolean {
    const d = this.detectors.get(stationId)
    if (d === undefined) return false
    d.mergePeaksFrom(from)
    const w = this.warm.get(stationId)
    if (w !== undefined) w.peaks = complete ? 'restored' : 'partial'
    return true
  }

  /** 比の 24 時間の最大を戻せなかった・戻さないことを残す。 */
  notePeaks(stationId: string, peaks: 'failed' | 'skipped'): void {
    const w = this.warm.get(stationId)
    if (w !== undefined) w.peaks = peaks
  }

  private goLive(stationId: string, w: WarmEntry, outcome: WarmStartOutcome): void {
    w.phase = 'live'
    w.outcome = outcome
    if (outcome.kind === 'cold') w.peaks = 'skipped'
    const held = w.buffer
    w.buffer = []
    for (const c of held) this.feed(stationId, c)
  }

  private feed(stationId: string, chunk: TriggerInput): void {
    let detector = this.detectors.get(stationId)
    if (detector === undefined) {
      detector = new QuakeDetector()
      this.detectors.set(stationId, detector)
    }
    const before = detector.lastSampleAtMs
    let closed: DetectedShake[]
    try {
      closed = detector.push(chunk)
    } catch (error) {
      this.fail('detect', `[detect] ${stationId} の検出に失敗: ${messageOf(error)}`)
      return
    } finally {
      // **使えたときだけ進める**（届いたかではなく）。刻みが読めず捨てたまとまりで進めると、
      // 検出が止まっているのに「届いている」に見える。
      if (detector.lastSampleAtMs !== before) this.fedAt.set(stationId, this.opts.now())
    }
    for (const shake of closed) this.record(stationId, shake)
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
    for (const stationId of [...this.warm.keys()]) {
      if (!known.has(stationId)) this.warm.delete(stationId)
    }
  }

  /**
   * 終了の前に、開いている揺れを閉じて記録する。**流し込みを待っている観測点は、溜めた分を先に流す**
   * （空の検出器へ。数え上げと「最後に使えた時刻」を、届いた分と食い違わせないため）。
   */
  flushAll(): void {
    for (const [stationId, w] of this.warm) {
      if (w.phase !== 'live') this.goLive(stationId, w, { kind: 'cold', reason: 'stopped', detail: null })
    }
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
      warmStart: this.warmStatus(stationId),
    }
  }

  private warmStatus(stationId: string): WarmStartStatus | null {
    const w = this.warm.get(stationId)
    if (w === undefined) return null
    return {
      phase: w.phase,
      heldSinceMs: w.heldSinceMs,
      heldChunks: w.buffer.length,
      replayedChunks: w.replayedChunks,
      recordFromMs: w.recordFromMs,
      outcome: w.outcome,
      peaks: w.peaks,
      skippedBeforeBoundary: w.skippedBeforeBoundary,
      skippedExisting: w.skippedExisting,
    }
  }

  /** 設定にある観測点と、検出器を持つ観測点を合わせた一覧（並びは ID 順）。 */
  private stationIds(): string[] {
    const ids = new Set(this.opts.config().stations.map((s) => s.stationId))
    for (const id of this.detectors.keys()) ids.add(id)
    return [...ids].sort()
  }

  private record(stationId: string, shake: DetectedShake): void {
    const w = this.warm.get(stationId)
    const onMs = shake.trigger.onMs
    // **境より前に始まった揺れは記録しない**（前のプロセスが見ていた区間。取りこぼしは `redetect.ts` が起こす）。
    if (w !== undefined && w.recordFromMs !== null && onMs < w.recordFromMs) {
      w.skippedBeforeBoundary++
      return
    }
    try {
      // **同じ id の記録が既にあれば書かない**（#618 と同じ）。版 1 で上書きすると、照合の結果を失う。
      if (this.opts.exists({ id: shakeEventId(stationId, onMs), startMs: onMs })) {
        if (w !== undefined) w.skippedExisting++
        return
      }
      const rec = this.book.addShake(stationId, shake, sensorsOf(this.opts.config(), stationId))
      this.shakes++
      this.opts.log(
        'log',
        rec.id,
        `[detect] ${stationId} 揺れ ${new Date(rec.startMs).toISOString()} 平常時の ${rec.peakRatio.toFixed(1)} 倍・` +
          `${SHAKE_CLASS_WORDS[rec.shakeClass]}` +
          // 上（上下動）を一部でも測れなかった区間だけ、測れたサンプル数を添える
          `${rec.verticalSamples !== undefined && rec.samples !== undefined && rec.verticalSamples < rec.samples ? `（上 ${rec.verticalSamples}/${rec.samples}）` : ''}・` +
          `${rec.verdict === 'quake' ? `地震と一致（${rec.matchedQuake?.name ?? ''}）` : '照合待ち'}`,
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
