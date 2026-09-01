// フレーム時間の記録。「移動すると一瞬引っかかる」の原因を名前で突き止めるための診断。
//
// **なぜ要るか**: 60fps で 1 フレーム落ちても画面には何も残らない。録画では取りこぼしとして残る
// のに、原因がタイルの読み込みなのかメインスレッドの同期処理なのかは体感では区別できない。どちらで
// あるかで打つ手が正反対（前者は常駐量を増やす／後者は処理を移動中に走らせない）なので、当てにいくと
// 効かない対策を抱えることになる。
//
// 記録は 3 種類あり、**突き合わせは `report()` を呼んだときに行う**。
//
// | 種類 | 何が分かるか | 入口 |
// |---|---|---|
// | 長いフレーム | どのスクリプトが詰まらせたか（Long Animation Frames API・Chrome 123+） | 自動 |
// | 区間 | 疑っている処理が実際に何 ms 使ったか | `profileSpan` / `beginSpan` / `recordSpan` |
// | 点 | タイルの到着のように「起きた時刻」だけが要るもの | `noteEvent` |
//
// **記録時に突き合わせない理由**: カメラ飛行の区間は `moveend` で確定するため、飛行中に起きた長い
// フレームより後に生成される。記録時に結び付ける作りにすると、いちばん知りたい「移動中のコマ落ち」
// だけが取り逃がされる。
//
// **区間を毎フレーム呼ばれる経路に置かないこと。** `performance.measure` の発行が乗るため、記録
// 自体が観測対象を遅くする。1 秒に数回までを目安にする。
//
// **区間の名前は本番ビルドでも読める。** Long Animation Frames が返す `sourceURL` は minify 後の
// バンドルを指すため、区間で囲っていない処理は本番では名前が出ない。疑うものは必ず囲うこと。

import { log } from './logger'

/** 疑っている処理を囲った区間。 */
export interface ProfilerSpan {
  name: string
  startMs: number
  endMs: number
  /** 同じ名前の中で内訳を分けたいときの補助（投影の種別・レイヤー名など）。 */
  detail?: string
}

/** 起きた時刻だけを記録する点。 */
export interface ProfilerEvent {
  name: string
  atMs: number
}

/** 長いフレームを詰まらせたスクリプト 1 本。 */
export interface LongFrameScript {
  /** 本番ビルドでは minify 後のバンドルを指す。 */
  sourceURL: string
  functionName: string
  /** 何がこのスクリプトを呼んだか（`requestAnimationFrame`・イベント名など）。 */
  invoker: string
  durationMs: number
  /** 同期レイアウトを強制した分（いわゆるレイアウトスラッシング）。 */
  forcedLayoutMs: number
}

export interface LongFrame {
  startMs: number
  durationMs: number
  /** 入力への応答を妨げていた分。0 なら長いだけで体感には出にくい。 */
  blockingMs: number
  /** 描画（render）に入るまでにスクリプトが使った分。 */
  scriptMs: number
  scripts: LongFrameScript[]
}

/** rAF の間隔が開いたフレーム（1 フレーム以上落ちた瞬間）。 */
export interface JankFrame {
  atMs: number
  deltaMs: number
}

/** 記録の種類。輪バッファが溢れたかどうかを種類ごとに持つため、鍵として使う。 */
export type RecordKind = 'frames' | 'spans' | 'events' | 'jank'

/** 記録の種類の表示名。**報告する側が持つ**（利用者に内部の変数名を見せない）。 */
export const RECORD_KIND_LABEL: Record<RecordKind, string> = {
  frames: '長いフレーム',
  spans: '区間',
  events: '点',
  jank: '落ちたフレーム',
}

export interface ProfilerSnapshot {
  frames: readonly LongFrame[]
  spans: readonly ProfilerSpan[]
  events: readonly ProfilerEvent[]
  jank: readonly JankFrame[]
  /**
   * 輪バッファが一周した（＝古い記録を失っている）種類。
   *
   * **これを持たないと「起きなかった」と「記録が消えた」が区別できない。** 種類ごとに上限も
   * 発生頻度も違うため、点（タイルの到着）だけが数分ぶんしか残っていないのに、長いフレームは
   * 数十分ぶん残っている——という状態が普通に起きる。
   */
  full: Record<RecordKind, boolean>
  /**
   * いま記録しているか（{@link arm} / {@link startFrameWatch} を呼んだ後、{@link disarm} まで）。
   *
   * **一度も始めていないときの 0 件は「起きなかった」ではなく「見ていない」。** 区別できないと、
   * 計測を始め忘れたまま「コマ落ちは無かった」と結論することになる。ただし**止めた後も集めた分は
   * 残る**ので、この旗だけで「記録が無い」と判断してはならない（記録の有無は配列を見る）。
   */
  armed: boolean
  /**
   * Long Animation Frames API が使えるか。
   *
   * **使えない環境では長いフレームが常に 0 件になる。** 「長いフレームは 1 件も無かった」と
   * 見分けるためにこの旗が要る（Chrome 123 以降でのみ使える）。
   */
  longAnimationFrameSupported: boolean
  /** rAF 監視が数えたフレーム総数（監視していなければ 0）。 */
  framesObserved: number
  /**
   * 落ちたフレームの累計。
   *
   * **`jank` の件数で代用してはならない。** あちらは輪バッファで上限があるため、長く監視すると
   * 件数が上限に張り付き、分母（`framesObserved`）だけが伸びて落ちた割合が際限なく小さく見える。
   */
  jankTotal: number
  /** rAF 監視が数えた間隔の合計 (ms)。平均フレーム時間の分子。 */
  observedDeltaSumMs: number
  /**
   * 数えた中で最も長かった間隔 (ms)。
   *
   * **落ちたフレームの記録（`jank`）から求めてはならない。** そこには閾値を超えたものしか
   * 入らないため、閾値ぎりぎり（60fps で 29ms）が並ぶ状態を「最悪 0ms」と報告してしまう。
   */
  worstDeltaMs: number
  /**
   * いま rAF 監視が動いているか。
   *
   * **`watchStartedAtMs` の有無で代用してはならない。** あちらは「記録がどこから始まっているか」
   * を指す値で、止めた後も残る（残らないと記録の範囲を測れない）。兼用すると `stop()` の後も
   * 「監視中」と報告し続ける。
   */
  watchRunning: boolean
  /** rAF 監視を始めた（または直近の `reset()` の）時刻。止めても残る。 */
  watchStartedAtMs: number | null
  /**
   * rAF 監視を止めた時刻（動いていれば null）。
   *
   * **止めた後の時間を「見ていた」ことにしないために要る。** 落ちたフレームの記録だけは rAF が
   * 回っている間しか増えないので、この時刻を持たないと「止めてから 90 秒経った」状態を
   * 「90 秒ぶん見ていて 0 件だった」と報告してしまう。
   */
  watchStoppedAtMs: number | null
  nowMs: number
}

/** 長いフレームに重なった区間ごとの集計。 */
export interface SpanBlame {
  name: string
  /** この区間が重なっていた長いフレームの数。 */
  frames: number
  /** その長いフレームの blockingMs の合計。 */
  blockingMs: number
  /** 区間そのものの所要時間の合計。 */
  spanMs: number
  /** 記録された回数（長いフレームに重ならなかった分も含む）。 */
  count: number
}

/** Long Animation Frames の帰属をスクリプト単位で集計したもの。 */
export interface ScriptBlame {
  key: string
  frames: number
  durationMs: number
  forcedLayoutMs: number
}

export interface WorstFrame extends LongFrame {
  /** このフレームに重なっていた区間の名前（重なった順）。 */
  spans: string[]
  /** このフレームの前後 {@link EVENT_NEAR_MS} に起きた点の内訳。 */
  nearbyEvents: { name: string; count: number }[]
}

export interface ProfilerReport {
  /**
   * **全種の記録が揃って裏付けられる**実時間 (ms)。
   *
   * 溢れた種類があれば、その種類が遡れる範囲まで縮める。**最も長く残っている種類に合わせて
   * はならない**——長いフレームだけ 30 分ぶん残っていて点は数分ぶんしか無い状態で「30 分ぶん
   * 見えている」と報告すると、古いフレームがすべて「タイルの到着と無関係」に見える（証拠が
   * 消えただけなのに）。
   */
  windowMs: number
  /** 記録が溢れて古い分を失っている種類（表示名と、その種類が遡れる範囲）。 */
  truncated: string[]
  /** いま記録しているか。false でも {@link hasRecords} が true なら、止める前に集めた分がある。 */
  armed: boolean
  /**
   * 何かしら記録があるか。
   *
   * **`armed` だけで「見ていない」と判断してはならない。** `disarm()` の後は記録しないが集めた分は
   * 残る。そこを混ぜると、止めた瞬間に**集め終えた診断結果が画面から消える**。
   */
  hasRecords: boolean
  /** false なら長いフレームの記録・スクリプトの帰属がこの環境では取れない。 */
  longAnimationFrameSupported: boolean
  longFrames: number
  totalBlockingMs: number
  worstFrameMs: number
  frameWatch: {
    running: boolean
    framesObserved: number
    jankFrames: number
    /** 落ちたフレームの割合 (0〜1)。監視していなければ 0。 */
    jankRatio: number
    meanFrameMs: number
    worstDeltaMs: number
    /**
     * 実際に見ていた長さ (ms)。監視していなければ 0。
     *
     * **記録の範囲（{@link ProfilerReport.windowMs}）とは別物。** 止めた後も他の記録は増え続ける
     * 一方、落ちたフレームは止めた時点で止まる。両者を 1 つの数で表すと必ずどちらかが嘘になる。
     */
    measuredMs: number
  }
  bySpan: SpanBlame[]
  byScript: ScriptBlame[]
  /** 長いフレームに重なっていなくても遅かった区間（下限は {@link SLOW_SPAN_MS}）。 */
  slowestSpans: ProfilerSpan[]
  worstFrames: WorstFrame[]
  /** そのままコンソールへ貼れる要約。 */
  text: string
}

/**
 * 記録の上限（種類ごと）。超えたら古いものから落ちる。
 *
 * 頻度が違うので上限も揃えない（長いフレームは稀・点は 1 秒に何十件も来る）。溢れた事実は
 * {@link ProfilerReport.truncated} で報告する。
 */
export const RECORD_CAPACITY: Record<RecordKind, number> = {
  frames: 512,
  spans: 4096,
  events: 8192,
  jank: 4096,
}

/** 長いフレームの「前後」として点を数える幅 (ms)。 */
export const EVENT_NEAR_MS = 500

/** 単独で列挙する区間の下限 (ms)。60fps の 1 フレーム（16.7ms）より長いものを拾う。 */
export const SLOW_SPAN_MS = 16

/** rAF の間隔がこれを超えたら「1 フレーム落ちた」として数える (ms)。 */
export const DEFAULT_JANK_DELTA_MS = 30

/**
 * これを超える間隔は数えない (ms)。タブが背面にある間 rAF は止まるため、復帰直後の 1 回は
 * 数秒の間隔になる。コマ落ちとして数えると割合が意味を失う。
 */
export const IGNORE_DELTA_MS = 1000

/** フレーム間隔の見立て。 */
export type DeltaVerdict =
  /** 数えない（タブが背面にあった等、描画そのものが止まっていた）。 */
  | 'ignored'
  /** 落ちていない。 */
  | 'smooth'
  /** 1 フレーム以上落ちた。 */
  | 'jank'

/**
 * フレーム間隔を見立てる。**境界が 2 つある**（落ちたと見なす下限と、数えるのをやめる上限）ので
 * 判定を 1 箇所に集約する。
 */
export function classifyDelta(deltaMs: number, thresholdMs: number = DEFAULT_JANK_DELTA_MS): DeltaVerdict {
  if (deltaMs > IGNORE_DELTA_MS) return 'ignored'
  return deltaMs > thresholdMs ? 'jank' : 'smooth'
}

/** 報告に載せる件数の上限。 */
const REPORT_TOP_N = 10

/**
 * 固定長の輪バッファ。**`Array#shift` を使わない**——点の記録は毎秒何十回も来るため、
 * 上限に達した後の押し出しが O(n) だと記録自体が観測対象を遅くする。
 */
class Ring<T> {
  private readonly buf: (T | undefined)[]
  private next = 0
  private filled = false

  constructor(private readonly cap: number) {
    this.buf = new Array<T | undefined>(cap)
  }

  push(v: T): void {
    this.buf[this.next] = v
    this.next = (this.next + 1) % this.cap
    if (this.next === 0) this.filled = true
  }

  /** 古い順に並べて返す。 */
  toArray(): T[] {
    if (!this.filled) return this.buf.slice(0, this.next) as T[]
    return [...(this.buf.slice(this.next) as T[]), ...(this.buf.slice(0, this.next) as T[])]
  }

  /** 一周したか（＝古い記録を失い始めたか）。 */
  get isFull(): boolean {
    return this.filled
  }

  clear(): void {
    this.buf.fill(undefined)
    this.next = 0
    this.filled = false
  }
}

const frames = new Ring<LongFrame>(RECORD_CAPACITY.frames)
const spans = new Ring<ProfilerSpan>(RECORD_CAPACITY.spans)
const events = new Ring<ProfilerEvent>(RECORD_CAPACITY.events)
const jank = new Ring<JankFrame>(RECORD_CAPACITY.jank)

let framesObserved = 0
let jankTotal = 0
let observedDeltaSumMs = 0
let worstDeltaMs = 0
let watchStartedAtMs: number | null = null
let watchStoppedAtMs: number | null = null
let watchHandle: number | null = null
let jankThresholdMs = DEFAULT_JANK_DELTA_MS
let installed = false
let armed = false
let loafObserver: PerformanceObserver | null = null
let longAnimationFrameSupported = false

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * 計測済みの区間を記録する。開始と終了が別の経路になる呼び出し側（時刻を自分で持っているもの）は
 * これを使う。
 *
 * DevTools のタイムラインへ出す目的も兼ねて `performance.measure` を発行し、**直後に消す**。
 * 消さないとパフォーマンスタイムラインが際限なく伸びる。**記録の正はこのファイルの輪バッファで、
 * タイムライン側は当てにしない**（消した後も DevTools が採取済みかは環境依存で、確かめていない）。
 *
 * `clearMeasures(name)` は同名の measure を全部消す。このリポジトリと MapLibre のバンドルには
 * `performance.mark` / `performance.measure` の利用が他に無いことを確認済みなので、他人の記録を
 * 巻き込む心配はない（**別のライブラリを足したときは確かめ直すこと**）。
 */
export function recordSpan(span: ProfilerSpan): void {
  if (!armed) return
  spans.push(span)
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return
  try {
    performance.measure(span.name, { start: span.startMs, end: span.endMs })
    performance.clearMeasures(span.name)
  } catch {
    // measure の options 形式に対応しない環境では諦める（輪バッファへの記録は済んでいる）。
  }
}

/**
 * 疑っている処理を囲う。同期関数専用。**例外が出ても区間は記録する**（落ちた処理が何 ms
 * 使ったかは、落ちなかった場合と同じくらい知りたい）。
 */
export function profileSpan<T>(name: string, fn: () => T, detail?: string): T {
  // **計測していないときは時刻すら読まない。** 常時稼働の経路に載るので、ここが実質ゼロで
  // あることがこの設計の前提（`arm` の説明を参照）。
  if (!armed) return fn()
  const startMs = nowMs()
  try {
    return fn()
  } finally {
    recordSpan({ name, startMs, endMs: nowMs(), detail })
  }
}

/**
 * 開始と終了が別の経路になる区間（カメラ飛行の `movestart` → `moveend` など）を計る。
 *
 * 返された関数を**呼ばなければ何も記録されない**。開始したまま終わらない区間は残らない。
 */
export function beginSpan(name: string, detail?: string): (endDetail?: string) => void {
  if (!armed) return NOOP_END
  const startMs = nowMs()
  return (endDetail) => {
    recordSpan({ name, startMs, endMs: nowMs(), detail: endDetail ?? detail })
  }
}

/**
 * 計測していないときに {@link beginSpan} が返す終了関数。
 *
 * **null を返さない。** 呼び出し側は「開いたら必ず閉じる」形で書いてあり、返り値が null になりうると
 * その全箇所に判定が要る。何もしない関数を返せば呼び出し側は 1 通りで済む。
 */
const NOOP_END = (): void => {}

/** 起きた時刻だけを記録する。 */
export function noteEvent(name: string): void {
  if (!armed) return
  events.push({ name, atMs: nowMs() })
}

/**
 * Long Animation Frames のエントリを記録の形へ写す。**記録の入口**なので、ここで値を取り違えると
 * 報告がまるごと嘘になる（テストで固定している）。
 */
export function toLongFrame(entry: PerformanceEntry): LongFrame {
  const e = entry as PerformanceEntry & {
    blockingDuration?: number
    renderStart?: number
    scripts?: {
      duration?: number
      invoker?: string
      sourceURL?: string
      sourceFunctionName?: string
      forcedStyleAndLayoutDuration?: number
    }[]
  }
  // **`??` ではなく `||` で埋める。** これらは値が無いとき undefined ではなく**空文字**で来る
  // （無名関数・トップレベルのモジュール評価など）。`??` だと空文字が素通りし、報告が
  // 「  @ http://...」のように主語の抜けた行になる。
  const scripts = (e.scripts ?? []).map((s) => ({
    sourceURL: s.sourceURL || '(不明)',
    functionName: s.sourceFunctionName || '(無名)',
    invoker: s.invoker || '(不明)',
    durationMs: s.duration ?? 0,
    forcedLayoutMs: s.forcedStyleAndLayoutDuration ?? 0,
  }))
  // renderStart が 0（描画に入らなかった）のときは差を取らない。startTime を引くと、フレーム全体と
  // 同じ長さの「スクリプト時間」が出てしまう。
  const scriptMs = e.renderStart && e.renderStart > 0 ? Math.max(0, e.renderStart - entry.startTime) : 0
  return {
    startMs: entry.startTime,
    durationMs: entry.duration,
    blockingMs: e.blockingDuration ?? 0,
    scriptMs,
    scripts,
  }
}

/**
 * 長いフレームの監視を張り、`window.__frameProfiler` を公開する。多重呼び出しは無害。
 *
 * **rAF によるフレーム間隔の監視（{@link startFrameWatch}）は自動では始めない。** 常時 rAF を回すと、
 * 地図が静止していてもメインスレッドを毎フレーム起こすことになる。録画・計測のときだけ明示的に始める。
 */
export function installFrameProfiler(): void {
  if (installed) return
  installed = true

  // **対応の有無は `supportedEntryTypes` で見る。** `observe()` が未対応の型で投げるかどうかは
  // ブラウザによって違い、黙って何もしない実装もある。try/catch だけに頼ると「対応していない」と
  // 「長いフレームが起きなかった」が区別できなくなる（旗を立てて報告へ載せる理由）。
  //
  // **ここでは調べるだけで監視は張らない。** 張るのは {@link arm} まで待つ。
  longAnimationFrameSupported =
    typeof PerformanceObserver === 'function' &&
    (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame')
  if (!longAnimationFrameSupported) {
    // Chrome 123 以降でのみ使える。ここに来た場合もフレーム間隔の監視と区間の記録は働くので、
    // 診断そのものは成立する（帰属だけが取れない）。
    log.info('[frameProfiler] この環境は Long Animation Frames に未対応。フレーム間隔と区間の記録だけで診断する')
  }

  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__frameProfiler = {
      report,
      dump,
      reset,
      arm,
      disarm,
      start: startFrameWatch,
      stop: stopFrameWatch,
      snapshot,
    }
  }
}

/**
 * 記録を始める。**これを呼ぶまで、区間も点も長いフレームも一切記録しない。**
 *
 * このアプリは地震のときに開かれる。緊急地震速報が鳴っている最中のメインスレッドへ、診断のための
 * 仕事を常時載せる理由は無い——だから公開はしても**既定では何もしない**形にしてある。呼んでいない
 * 間のコストは、各入口で真偽値を 1 つ見るだけ。
 *
 * 通常は {@link startFrameWatch}（`__frameProfiler.start()`）がこれも兼ねる。フレーム間隔の監視を
 * 伴わずに区間と点だけを集めたいときに単独で呼ぶ。
 */
export function arm(): void {
  if (armed) return
  armed = true
  if (!longAnimationFrameSupported) return
  try {
    // `buffered: true` なので、**始める前に起きた長いフレームもいくらか拾える**（ブラウザが timeline に
    // 保持している範囲まで）。始めた瞬間より前が完全に空白になるわけではない。
    const observer = new PerformanceObserver((list) => {
      // 他の入口と同じガードを置く。`disconnect()` の前に予約済みだった通知が後から届いても、
      // 計測していない期間の 1 件を混ぜない。
      //
      // **発生源も照合する。** `armed` だけを見ると、止めてすぐ始め直したときに旧オブザーバーの
      // 遅れた通知が新しい計測の記録として紛れ込む（`armed` が true に戻っているため）。
      if (!armed || loafObserver !== observer) return
      for (const entry of list.getEntries()) frames.push(toLongFrame(entry))
    })
    loafObserver = observer
    observer.observe({ type: 'long-animation-frame', buffered: true })
  } catch (e) {
    // 対応していると答えたのに張れなかった場合。**黙って諦めない**——スクリプトの帰属がまるごと
    // 取れない状態になるので、原因を追える手掛かりを残す。
    log.warn('[frameProfiler] 長いフレームの監視を張れなかった（スクリプトの帰属は取れない）', e)
    longAnimationFrameSupported = false
  }
}

/**
 * 記録をやめる。フレーム間隔の監視も併せて止める（記録しないのに数え続ける状態を作らない）。
 *
 * 集めた記録は残るので、やめた後でも {@link report} は読める。再開したければ {@link arm} を呼ぶ。
 */
export function disarm(): void {
  stopFrameWatch()
  armed = false
  loafObserver?.disconnect()
  loafObserver = null
}

/** フレーム間隔の監視を始める。既に動いていれば何もしない。 */
export function startFrameWatch(thresholdMs: number = DEFAULT_JANK_DELTA_MS): void {
  if (watchHandle != null) return
  if (typeof requestAnimationFrame !== 'function') {
    // 始まったつもりで放置させない。`report()` の `running` も false のままになる。
    log.warn('[frameProfiler] requestAnimationFrame が無いためフレーム間隔の監視は始められない')
    return
  }
  // フレーム間隔だけ数えても、詰まらせた処理の名前が出なければ意味が無い。記録も併せて始める。
  arm()
  jankThresholdMs = thresholdMs
  watchStartedAtMs = nowMs()
  watchStoppedAtMs = null
  // 最初の間隔は「監視を始める前にどれだけ空いていたか」を含むため数えない。
  let prev: number | null = null
  const tick = () => {
    const t = nowMs()
    if (prev != null) recordFrameDelta(t - prev, t)
    prev = t
    watchHandle = requestAnimationFrame(tick)
  }
  watchHandle = requestAnimationFrame(tick)
}

/**
 * rAF の 1 拍ぶんを記録する（{@link startFrameWatch} の中身）。
 *
 * rAF から切り離してあるのは、**この判定と集計をテストで固定するため**。rAF そのものは呼び出しの
 * 配線にすぎない。
 *
 * **呼び出し元は {@link startFrameWatch} の rAF ループだけ**（あとはテスト）。アプリコードから
 * 直接呼ぶと、実測していないフレームが集計に混ざる。アプリコードが使う入口は
 * {@link profileSpan} / {@link beginSpan} / {@link noteEvent} で、**いずれもこの関数を経由しない**。
 */
export function recordFrameDelta(deltaMs: number, atMs: number): void {
  if (!armed) return
  const verdict = classifyDelta(deltaMs, jankThresholdMs)
  if (verdict === 'ignored') return
  framesObserved++
  observedDeltaSumMs += deltaMs
  if (deltaMs > worstDeltaMs) worstDeltaMs = deltaMs
  if (verdict === 'jank') {
    // 件数は溢れないカウンタで持つ（`jank` は時刻を見るための直近ぶんだけ）。
    jankTotal++
    jank.push({ atMs, deltaMs })
  }
}

export function stopFrameWatch(): void {
  if (watchHandle == null) return
  cancelAnimationFrame(watchHandle)
  watchHandle = null
  watchStoppedAtMs = nowMs()
}

/** 記録を捨てる。監視の稼働状態は変えない。 */
export function reset(): void {
  frames.clear()
  spans.clear()
  events.clear()
  jank.clear()
  framesObserved = 0
  jankTotal = 0
  observedDeltaSumMs = 0
  worstDeltaMs = 0
  watchStartedAtMs = watchHandle != null ? nowMs() : null
  // 記録を捨てた以上、止めた時刻も残さない（残すと、いま始めていない監視の「終わり」だけが残る）。
  watchStoppedAtMs = null
}

export function snapshot(): ProfilerSnapshot {
  return {
    frames: frames.toArray(),
    spans: spans.toArray(),
    events: events.toArray(),
    jank: jank.toArray(),
    full: { frames: frames.isFull, spans: spans.isFull, events: events.isFull, jank: jank.isFull },
    armed,
    longAnimationFrameSupported,
    framesObserved,
    jankTotal,
    observedDeltaSumMs,
    worstDeltaMs,
    watchRunning: watchHandle != null,
    watchStartedAtMs,
    watchStoppedAtMs,
    nowMs: nowMs(),
  }
}

function overlaps(span: ProfilerSpan, frame: LongFrame): boolean {
  return span.startMs < frame.startMs + frame.durationMs && span.endMs > frame.startMs
}

function spanLabel(span: ProfilerSpan): string {
  return span.detail ? `${span.name} (${span.detail})` : span.name
}

function round(v: number): number {
  return Math.round(v * 10) / 10
}

/** 昇順の配列で `value` 以上が始まる位置。見つからなければ配列長。 */
function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 記録がどこまで遡れるかを求める。
 *
 * **溢れた種類だけが限界を決める。** 溢れていない種類は何も失っていないので、遡れる範囲を
 * 狭めない。溢れた種類が複数あれば最も狭いものに合わせる——そこが「全種が揃って裏付けられる」
 * 境界になる。
 */
function coverage(s: ProfilerSnapshot): { windowMs: number; truncated: string[] } {
  const oldestOf: Record<RecordKind, number | null> = {
    frames: s.frames.length > 0 ? s.frames[0].startMs : null,
    spans: s.spans.length > 0 ? s.spans[0].startMs : null,
    events: s.events.length > 0 ? s.events[0].atMs : null,
    jank: s.jank.length > 0 ? s.jank[0].atMs : null,
  }
  const kinds: RecordKind[] = ['frames', 'spans', 'events', 'jank']
  // **落ちたフレームだけは「今まで」を名乗れない。** 収集が rAF ループに紐付いているので、監視を
  // 止めた時点で増えなくなる。他の 3 種（長いフレーム・区間・点）は監視の有無に関わらず記録され
  // 続けるため、今までで測ってよい。
  //
  // 止めた後のこの種類は**記録の範囲（`windowMs`）の計算から外す**。`windowMs` は「今から遡って
  // どこまで裏付けられるか」を表す値で、今に届いていない系列を混ぜると意味が壊れる。代わりに
  // 実際に見ていた長さを `frameWatch.measuredMs` として別に出す。
  const stale = (kind: RecordKind) => kind === 'jank' && !s.watchRunning
  const limits: number[] = []
  const truncated: string[] = []
  for (const kind of kinds) {
    const oldest = oldestOf[kind]
    if (!s.full[kind] || oldest == null) continue
    // 溢れた事実は伝える（範囲を狭める側に数えなくても、記録が消えていることは知らせる）。
    const end = stale(kind) ? (s.watchStoppedAtMs ?? s.nowMs) : s.nowMs
    truncated.push(`${RECORD_KIND_LABEL[kind]}（${round((end - oldest) / 1000)} 秒ぶんのみ）`)
    if (!stale(kind)) limits.push(s.nowMs - oldest)
  }
  if (limits.length > 0) return { windowMs: round(Math.min(...limits)), truncated }

  // 溢れていない場合は、最も古い記録（または監視の開始）から今まで。
  //
  // **監視を止めているときは、その開始時刻も落ちたフレームの記録も起点に含めない。** 理由は上と
  // 同じで、止めた後の時間まで「見ていた」ことにしてしまうため。
  const anchors = kinds.filter((k) => !stale(k)).map((k) => oldestOf[k])
  if (s.watchRunning) anchors.push(s.watchStartedAtMs)
  const starts = anchors.filter((v): v is number => v != null)
  return { windowMs: starts.length > 0 ? round(s.nowMs - Math.min(...starts)) : 0, truncated }
}

/**
 * 記録を突き合わせて報告を組む。**純関数**（引数以外を読まない）ので、テストは {@link snapshot} を
 * 経ずに直接呼べる。
 */
export function buildReport(s: ProfilerSnapshot): ProfilerReport {
  const bySpanMap = new Map<string, SpanBlame>()
  for (const span of s.spans) {
    const key = spanLabel(span)
    const cur = bySpanMap.get(key) ?? { name: key, frames: 0, blockingMs: 0, spanMs: 0, count: 0 }
    cur.count++
    cur.spanMs += span.endMs - span.startMs
    bySpanMap.set(key, cur)
  }

  // **突き合わせは総当たりにしない。** 上限まで埋まった状態（長いフレーム 512 × 区間 4096）を
  // 素朴に回すと 200 万回の重なり判定になり、**報告を作る呼び出し自体が長いフレームを生む**
  // ——診断が症状を作る形になる。フレームを開始時刻で並べ、区間ごとに「あり得る範囲」だけを
  // 二分探索で切り出す（フレームの長さには上限があるので、この切り出しは正しい）。
  const framesSorted = [...s.frames].sort((a, b) => a.startMs - b.startMs)
  const frameStarts = framesSorted.map((f) => f.startMs)
  const maxFrameMs = framesSorted.reduce((a, f) => Math.max(a, f.durationMs), 0)
  const hitsByFrame = new Map<number, string[]>()
  for (const span of s.spans) {
    const key = spanLabel(span)
    const blame = bySpanMap.get(key)
    // フレームが区間より前に始まっていても、長さのぶんだけ食い込みうる。下限はその余裕を見る。
    const lo = lowerBound(frameStarts, span.startMs - maxFrameMs)
    // 区間が終わった時刻以降に始まるフレームは、定義上重ならない（overlaps と同じ境界）。
    const hi = lowerBound(frameStarts, span.endMs)
    for (let i = lo; i < hi; i++) {
      if (!overlaps(span, framesSorted[i])) continue
      const list = hitsByFrame.get(i)
      if (list) list.push(key)
      else hitsByFrame.set(i, [key])
      // 上のループで全区間を登録済みなので必ず引ける。引けなければ集計の取りこぼしになるため
      // 黙って飛ばさず、存在を前提に書く（キーの作り方を変えたときにここで気づける）。
      if (blame) {
        blame.frames++
        blame.blockingMs += framesSorted[i].blockingMs
      }
    }
  }

  const byScriptMap = new Map<string, ScriptBlame>()
  for (const frame of framesSorted) {
    for (const script of frame.scripts) {
      const key = `${script.functionName} @ ${script.sourceURL} <- ${script.invoker}`
      const cur = byScriptMap.get(key) ?? { key, frames: 0, durationMs: 0, forcedLayoutMs: 0 }
      cur.frames++
      cur.durationMs += script.durationMs
      cur.forcedLayoutMs += script.forcedLayoutMs
      byScriptMap.set(key, cur)
    }
  }

  // 点の内訳は**報告に載せるフレームだけ**に付ける。全フレームぶん数えると、ここも総当たりになる。
  const eventsSorted = [...s.events].sort((a, b) => a.atMs - b.atMs)
  const eventTimes = eventsSorted.map((e) => e.atMs)
  const worst: WorstFrame[] = framesSorted
    .map((frame, i) => ({ ...frame, spans: hitsByFrame.get(i) ?? [], nearbyEvents: [] as WorstFrame['nearbyEvents'] }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, REPORT_TOP_N)
  for (const frame of worst) {
    const nearby = new Map<string, number>()
    const from = lowerBound(eventTimes, frame.startMs - EVENT_NEAR_MS)
    for (let i = from; i < eventsSorted.length; i++) {
      const ev = eventsSorted[i]
      if (ev.atMs > frame.startMs + frame.durationMs + EVENT_NEAR_MS) break
      nearby.set(ev.name, (nearby.get(ev.name) ?? 0) + 1)
    }
    frame.nearbyEvents = [...nearby.entries()].map(([name, count]) => ({ name, count }))
  }

  const { windowMs, truncated } = coverage(s)

  const report: ProfilerReport = {
    windowMs,
    truncated,
    armed: s.armed,
    hasRecords:
      s.frames.length > 0 ||
      s.spans.length > 0 ||
      s.events.length > 0 ||
      s.jank.length > 0 ||
      s.framesObserved > 0,
    longAnimationFrameSupported: s.longAnimationFrameSupported,
    longFrames: s.frames.length,
    totalBlockingMs: round(s.frames.reduce((a, f) => a + f.blockingMs, 0)),
    worstFrameMs: round(s.frames.reduce((a, f) => Math.max(a, f.durationMs), 0)),
    frameWatch: {
      running: s.watchRunning,
      framesObserved: s.framesObserved,
      // **`s.jank.length` を使わない。** あちらは輪バッファの残量で、長く監視すると上限に張り付く。
      jankFrames: s.jankTotal,
      jankRatio: s.framesObserved > 0 ? Math.round((s.jankTotal / s.framesObserved) * 1000) / 1000 : 0,
      meanFrameMs: s.framesObserved > 0 ? round(s.observedDeltaSumMs / s.framesObserved) : 0,
      worstDeltaMs: round(s.worstDeltaMs),
      measuredMs:
        s.watchStartedAtMs != null ? round((s.watchStoppedAtMs ?? s.nowMs) - s.watchStartedAtMs) : 0,
    },
    bySpan: [...bySpanMap.values()]
      .map((b) => ({ ...b, blockingMs: round(b.blockingMs), spanMs: round(b.spanMs) }))
      .sort((a, b) => b.frames - a.frames || b.spanMs - a.spanMs),
    byScript: [...byScriptMap.values()]
      .map((b) => ({ ...b, durationMs: round(b.durationMs), forcedLayoutMs: round(b.forcedLayoutMs) }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, REPORT_TOP_N),
    slowestSpans: [...s.spans]
      .filter((sp) => sp.endMs - sp.startMs >= SLOW_SPAN_MS)
      .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
      .slice(0, REPORT_TOP_N),
    worstFrames: worst.slice(0, REPORT_TOP_N),
    text: '',
  }
  report.text = formatReport(report)
  return report
}

function formatReport(r: ProfilerReport): string {
  const lines: string[] = []
  if (!r.armed && !r.hasRecords) {
    // **件数を並べない。** すべて 0 だが、それは「起きなかった」ではなく「見ていない」ため。
    // **`armed` だけで判定しないこと。** `disarm()` の後は記録しないが集めた分は残っており、
    // ここで打ち切ると集め終えた診断結果が画面から消える。
    return '計測していない（__frameProfiler.start() で開始する）'
  }
  lines.push(`記録の範囲: 直近 ${round(r.windowMs / 1000)} 秒${r.armed ? '' : '（計測は終了している）'}`)
  if (r.truncated.length > 0) {
    // **これを書かないと「起きなかった」と「記録が消えた」を読み分けられない。**
    lines.push(`  記録が溢れて古い分を失っている: ${r.truncated.join(' / ')}`)
  }
  if (r.longAnimationFrameSupported) {
    lines.push(
      `長いフレーム: ${r.longFrames} 件 / 合計ブロッキング ${r.totalBlockingMs}ms / 最悪 ${r.worstFrameMs}ms`,
    )
  } else {
    // 0 件と書かない。「起きなかった」と読まれるのを防ぐ。
    lines.push('長いフレーム: この環境では取れない（Long Animation Frames 未対応。Chrome 123 以降が必要）')
  }
  const w = r.frameWatch
  if (w.framesObserved > 0) {
    // 止めた後も計測済みの値は見せる。ただし**止まっていることを併記する**——「いまも計り続けて
    // いる数値」と読まれると、凍結した古い値を現状として扱うことになる。
    lines.push(
      `フレーム間隔${w.running ? '' : '（監視は停止中・以下は計測済みの値）'}: ` +
        `${round(w.measuredMs / 1000)} 秒で ${w.framesObserved} フレーム中 ${w.jankFrames} 件が落ちた` +
        `（${round(w.jankRatio * 100)}%）/ 平均 ${w.meanFrameMs}ms / 最悪 ${w.worstDeltaMs}ms`,
    )
  } else {
    lines.push(
      w.running
        ? 'フレーム間隔: 監視中（まだ 1 フレームも数えていない）'
        : 'フレーム間隔: 監視は停止中（__frameProfiler.start() で開始する）',
    )
  }
  if (r.bySpan.length > 0) {
    lines.push('')
    lines.push('区間ごと（長いフレームに重なった数の順）:')
    for (const b of r.bySpan.slice(0, REPORT_TOP_N)) {
      lines.push(`  ${b.name}: 重なり ${b.frames} 件 / 区間合計 ${b.spanMs}ms / 記録 ${b.count} 回`)
    }
  }
  if (r.slowestSpans.length > 0) {
    lines.push('')
    lines.push(`遅かった区間（${SLOW_SPAN_MS}ms 以上）:`)
    for (const sp of r.slowestSpans) {
      lines.push(`  ${round(sp.endMs - sp.startMs)}ms  ${spanLabel(sp)}`)
    }
  }
  if (r.longAnimationFrameSupported && r.byScript.length > 0) {
    lines.push('')
    lines.push('スクリプトごと（Long Animation Frames の帰属）:')
    for (const b of r.byScript) {
      const forced = b.forcedLayoutMs > 0 ? ` / 強制レイアウト ${b.forcedLayoutMs}ms` : ''
      lines.push(`  ${b.durationMs}ms (${b.frames} 件)${forced}  ${b.key}`)
    }
  }
  if (r.worstFrames.length > 0) {
    lines.push('')
    lines.push('最も長かったフレーム:')
    for (const f of r.worstFrames) {
      const hit = f.spans.length > 0 ? f.spans.join(', ') : '（囲った区間に重なりなし）'
      const evs = f.nearbyEvents.map((e) => `${e.name}x${e.count}`).join(' ')
      lines.push(
        `  ${round(f.durationMs)}ms (ブロッキング ${round(f.blockingMs)}ms / スクリプト ${round(f.scriptMs)}ms)` +
          ` 区間: ${hit}` +
          (evs ? ` 前後の点: ${evs}` : ''),
      )
    }
  }
  return lines.join('\n')
}

export function report(): ProfilerReport {
  return buildReport(snapshot())
}

/** 要約をコンソールへ出す。戻り値は {@link report} と同じ。 */
export function dump(): ProfilerReport {
  const r = report()
  console.log(r.text)
  return r
}
