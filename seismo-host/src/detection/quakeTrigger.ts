// 観測点の合成波形から「揺れの候補」を切り出す（REQUIREMENTS.md §6）。
//
// **地震かどうかはここでは決めない。** ここが出すのは「平常時より強く揺れた区間」と、その
// 区間の揺れ方を表す特徴量だけ。地震らしさの判定（`eventClassifier.ts`）と気象庁の地震情報
// との照合は別の段が持つ —— 引き金の作りと判定の作りを別々に差し替えられるようにするため
// （§6 の「将来は機械学習によるイベント分類を追加できる設計」）。
//
// **見るのは観測点の合成波形（`FusedWaveChunk`）。** センサー 1 本・基板 1 枚では足りない ——
// 実機の記録（2026-09-28〜10-03）で、ある M3.5 の地震 が合成では平常時の 5.3 倍になるのに、
// センサー単体では 1.4 倍にしかならなかった（9 本を混ぜると無相関なノイズが約 1/3 になる）。
//
// **引き金は 5〜10 Hz の水平動。** 同じ記録で、近い地震（M3.0〜3.5）の S 波は
// この帯に集まっていた（帯域で絞らないと 2.8 倍・絞ると 5.3 倍）。上下動はほとんど動かない。
//
// **時刻はデータの時刻だけで進む。** 壁時計を見ないので、過去の記録を流し直しても実機と同じ
// 区間が切り出される（評価台 `seismo-host/bench/` がそれを前提にしている）。

import { BandPass } from './bandPass'

/** 区間の揺れ方を表す帯域。`H` は水平 2 成分の合成、`Z` は上下動。 */
export const FEATURE_BANDS = [
  [0.5, 2],
  [2, 5],
  [5, 10],
  [10, 20],
  [20, 45],
] as const

/** `FEATURE_BANDS` の中で `band` と同じ帯の位置。無ければ -1。 */
export function featureBandIndex(band: readonly [number, number]): number {
  return FEATURE_BANDS.findIndex(([lo, hi]) => lo === band[0] && hi === band[1])
}

export interface TriggerConfig {
  /** 引き金に使う帯域（Hz）。 */
  readonly triggerBandHz: readonly [number, number]
  /** 短い窓（STA）の時定数（秒）。 */
  readonly staSec: number
  /** 長い窓（LTA）の時定数（秒）。区間の最中は進めない（揺れで基準が持ち上がらないように）。 */
  readonly ltaSec: number
  /** 振幅の比（√(STA/LTA)）がこれを超えたら区間を始める。 */
  readonly onRatio: number
  /** 比がこれを下回ったら区間を閉じる候補にする。 */
  readonly offRatio: number
  /** 閉じる候補になってから、これだけ比が戻らなければ閉じる（秒）。P と S の間を 1 区間に繋ぐ。 */
  readonly holdSec: number
  /** 区間の長さの上限（秒）。超えたら閉じて、基準を作り直す。 */
  readonly maxEventSec: number
  /** 始めてから（または途切れてから）この長さは引き金を引かない（LTA が落ち着くまで。秒）。 */
  readonly warmupSec: number
  /** 波形がこれ以上途切れたら、フィルタと基準を作り直す（ミリ秒）。 */
  readonly maxGapMs: number
}

export const TRIGGER_CONFIG_DEFAULT: TriggerConfig = {
  triggerBandHz: [5, 10],
  staSec: 1,
  ltaSec: 60,
  onRatio: 2.5,
  offRatio: 1.5,
  holdSec: 5,
  maxEventSec: 180,
  warmupSec: 60,
  maxGapMs: 1000,
}

/** 区間の終わり方。 */
export type TriggerEnd =
  /** 比が戻った。 */
  | 'quiet'
  /** 長さの上限に達した。 */
  | 'max-length'
  /** 波形が途切れた（そこまでの区間として閉じる）。 */
  | 'gap'
  /** 流し終えた（`flush`）。 */
  | 'flush'

/** 切り出した 1 区間。 */
export interface TriggerEvent {
  /** 比が `onRatio` を超えたサンプルの時刻（unix ミリ秒）。 */
  readonly onMs: number
  /** 比が `offRatio` を下回り、そのまま `holdSec` 戻らなかった最初のサンプルの時刻。 */
  readonly offMs: number
  readonly end: TriggerEnd
  /** 比の最大。 */
  readonly peakRatio: number
  /** 区間を始めた時点の基準（LTA の振幅・gal）。 */
  readonly baselineGal: number
  /** 引き金の帯域・水平動の STA 振幅の最大（gal）。 */
  readonly peakBandGal: number
  /** 帯域で絞らない水平動（2 成分の合成）の絶対値の最大（gal。直流は合成の段で落としてある）。 */
  readonly peakHorizontalGal: number
  /** 同じく 3 成分の合成の最大（gal）。 */
  readonly peakVectorGal: number
  /** 区間の中の帯域ごとの RMS（gal）。`FEATURE_BANDS` と同じ並び。 */
  readonly bandRmsH: readonly number[]
  readonly bandRmsZ: readonly number[]
}

/** `TriggerDetector` へ渡すまとまり（`FusedWaveChunk` の必要な欄だけ）。 */
export interface TriggerInput {
  readonly firstSampleMs: number
  readonly msPerSample: number
  readonly gal: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>]
}

/** 比がいちばん大きかったサンプル。 */
export interface TriggerPeak {
  readonly ratio: number
  /** そのサンプルの時刻（データの時刻・unix ミリ秒）。 */
  readonly atMs: number
}

/**
 * 引き金のいまの状態（`TriggerDetector.health`）。**揺れを記録していないとき、それが
 * 「静かだっただけ」なのか「止まっている」のかを見分ける材料。**
 *
 * 揺れの記録が 0 件のまま続く形は 4 つあり、数え上げ（`resets` など）だけでは見分けられない。
 *
 * | 形 | ここでどう見えるか |
 * |---|---|
 * | 静かで、比が `onRatio` に届かないだけ | `armed` で、`peak24h.ratio` が `onRatio` 未満 |
 * | 波形が来ない（観測点の合成が組まれない等） | `lastSampleMs` が古いか null |
 * | 途切れが繰り返し、助走から抜けられない | `armed` が立たない（`warmUntilMs` が先送りされ続ける） |
 * | 平らな値しか来ない | `baselineGal` が 0（比も 0 のまま） |
 */
export interface TriggerHealth {
  /** 検出に使えた最後のサンプルの時刻（データの時刻）。一度も受けていなければ null。 */
  readonly lastSampleMs: number | null
  /** 検出に使えた最初のサンプルの時刻。 */
  readonly firstSampleMs: number | null
  /** 助走が明けて、引き金を引ける状態か。 */
  readonly armed: boolean
  /** 助走中なら、明ける時刻（データの時刻）。 */
  readonly warmUntilMs: number | null
  /** 揺れの区間を開いている。 */
  readonly inEvent: boolean
  /** 平常時の強さ（LTA の振幅・gal）。助走中も出す（落ち着く途中の値）。 */
  readonly baselineGal: number | null
  /** いまの比（√(STA/LTA)）。引き金を引けない間は null。 */
  readonly ratio: number | null
  /** 引き金を引く比（`TriggerConfig.onRatio`）。 */
  readonly onRatio: number
  /**
   * 直近 24 時間（最後のサンプルから遡る・1 分単位）で比がいちばん大きかったサンプル。
   * **引き金を引ける状態のサンプルだけを数える**（助走中の比は 0 で、数えると意味を持たない）。
   * 該当するサンプルが無ければ null。**揺れの区間の最中も数える** —— 引き金を引いた揺れでは
   * `onRatio` 以上になる。
   */
  readonly peak24h: TriggerPeak | null
  /** `peak24h` が見ている範囲の頭。24 時間に満たなければ最初のサンプルの時刻。 */
  readonly peakWindowFromMs: number | null
}

/** まだ 1 サンプルも受けていない引き金の状態（検出器を作る前の観測点に使う）。 */
export function emptyTriggerHealth(cfg: TriggerConfig = TRIGGER_CONFIG_DEFAULT): TriggerHealth {
  return {
    lastSampleMs: null,
    firstSampleMs: null,
    armed: false,
    warmUntilMs: null,
    inEvent: false,
    baselineGal: null,
    ratio: null,
    onRatio: cfg.onRatio,
    peak24h: null,
    peakWindowFromMs: null,
  }
}

/** 比の最大を何分ぶん覚えるか（24 時間）。 */
const PEAK_MINUTES = 24 * 60
const MINUTE_MS = 60_000

interface Filters {
  readonly sampleHz: number
  readonly trigger: [BandPass, BandPass]
  readonly featureH: [BandPass, BandPass][]
  readonly featureZ: BandPass[]
}

interface OpenEvent {
  onMs: number
  quietSinceMs: number | null
  peakRatio: number
  baselineGal: number
  peakBandGal: number
  peakHorizontalGal: number
  peakVectorGal: number
  sumsqH: number[]
  sumsqZ: number[]
  samples: number
}

function makeFilters(cfg: TriggerConfig, sampleHz: number): Filters {
  const [lo, hi] = cfg.triggerBandHz
  return {
    sampleHz,
    trigger: [new BandPass(lo, hi, sampleHz), new BandPass(lo, hi, sampleHz)],
    featureH: FEATURE_BANDS.map(([l, h]) => [new BandPass(l, h, sampleHz), new BandPass(l, h, sampleHz)]),
    featureZ: FEATURE_BANDS.map(([l, h]) => new BandPass(l, h, sampleHz)),
  }
}

/**
 * 揺れの候補を切り出す。まとまりを時刻順に `push` し、閉じた区間を受け取る。
 *
 * **投げない**（不正な刻みのまとまりは捨てて数える）。ホストの受信を止めないため。
 */
export class TriggerDetector {
  private readonly cfg: TriggerConfig
  private filters: Filters | null = null
  private nextMs: number | null = null
  private warmUntilMs = 0
  private sta = 0
  private lta = 0
  private ltaReady = false
  private open: OpenEvent | null = null
  private ratio = 0
  private firstSampleMs: number | null = null
  private lastSampleMs: number | null = null
  /**
   * 1 分ごとの比の最大（輪）。`peakMinute[i]` がその枠の分（unix 分）で、別の分なら空として扱う。
   * **途切れ・助走で作り直しても消さない** —— 消すと、途切れの前に揺れていたことが見えなくなる。
   */
  private readonly peakMinute = new Float64Array(PEAK_MINUTES).fill(Number.NaN)
  private readonly peakRatio = new Float64Array(PEAK_MINUTES)
  private readonly peakAtMs = new Float64Array(PEAK_MINUTES)
  /**
   * 捨てたまとまりの数。刻みが読めないものと、刻みが粗すぎて帯域フィルタを組めないもの
   * （特徴量の最上の帯 20〜45 Hz はサンプリングが 90 Hz を超えないと組めない）。
   */
  droppedChunks = 0
  /** 途切れで作り直した回数。 */
  resets = 0

  constructor(cfg: TriggerConfig = TRIGGER_CONFIG_DEFAULT) {
    this.cfg = cfg
  }

  push(chunk: TriggerInput): TriggerEvent[] {
    const out: TriggerEvent[] = []
    const dt = chunk.msPerSample
    if (!(dt > 0 && Number.isFinite(dt)) || !Number.isFinite(chunk.firstSampleMs)) {
      this.droppedChunks++
      return out
    }
    const sampleHz = 1000 / dt
    const gapped = this.nextMs !== null && Math.abs(chunk.firstSampleMs - this.nextMs) > this.cfg.maxGapMs
    const rateChanged = this.filters !== null && Math.abs(this.filters.sampleHz - sampleHz) / sampleHz > 0.05
    if (this.filters === null || gapped || rateChanged) {
      if (this.open !== null && this.nextMs !== null) out.push(this.close(this.nextMs, 'gap'))
      if (this.filters !== null) this.resets++
      try {
        this.filters = makeFilters(this.cfg, sampleHz)
      } catch {
        // 組めない刻み。次に組める刻みのまとまりが来たら、そこから助走でやり直す。
        this.filters = null
        this.nextMs = null
        // **引き金を引ける状態も落とす。** 残すと、検出が止まっているのに `health()` が
        // 前の「見張り中」と古い比を返し続ける。
        this.ltaReady = false
        this.ratio = 0
        this.droppedChunks++
        return out
      }
      this.sta = 0
      this.lta = 0
      this.ltaReady = false
      this.warmUntilMs = chunk.firstSampleMs + this.cfg.warmupSec * 1000
    }
    const f = this.filters
    const aSta = Math.min(1, dt / (this.cfg.staSec * 1000))
    const aLta = Math.min(1, dt / (this.cfg.ltaSec * 1000))
    const n = chunk.gal[0].length
    for (let i = 0; i < n; i++) {
      const t = chunk.firstSampleMs + i * dt
      const x = chunk.gal[0][i]
      const y = chunk.gal[1][i]
      const z = chunk.gal[2][i]
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      const bx = f.trigger[0].step(x)
      const by = f.trigger[1].step(y)
      const energy = bx * bx + by * by
      const fh: number[] = []
      const fz: number[] = []
      for (let b = 0; b < FEATURE_BANDS.length; b++) {
        const hx = f.featureH[b][0].step(x)
        const hy = f.featureH[b][1].step(y)
        fh.push(hx * hx + hy * hy)
        const vz = f.featureZ[b].step(z)
        fz.push(vz * vz)
      }

      this.sta += aSta * (energy - this.sta)
      if (this.open === null) {
        this.lta += aLta * (energy - this.lta)
        if (t >= this.warmUntilMs) this.ltaReady = true
      }
      const ratio = this.ltaReady && this.lta > 0 ? Math.sqrt(this.sta / this.lta) : 0
      this.ratio = ratio
      if (this.firstSampleMs === null) this.firstSampleMs = t
      this.lastSampleMs = t
      if (this.ltaReady) this.notePeak(t, ratio)

      if (this.open === null) {
        if (ratio >= this.cfg.onRatio) {
          this.open = {
            onMs: t,
            quietSinceMs: null,
            peakRatio: ratio,
            baselineGal: Math.sqrt(this.lta),
            peakBandGal: 0,
            peakHorizontalGal: 0,
            peakVectorGal: 0,
            sumsqH: FEATURE_BANDS.map(() => 0),
            sumsqZ: FEATURE_BANDS.map(() => 0),
            samples: 0,
          }
        }
      }
      const ev = this.open
      if (ev !== null) {
        ev.peakRatio = Math.max(ev.peakRatio, ratio)
        ev.peakBandGal = Math.max(ev.peakBandGal, Math.sqrt(this.sta))
        ev.peakHorizontalGal = Math.max(ev.peakHorizontalGal, Math.hypot(x, y))
        ev.peakVectorGal = Math.max(ev.peakVectorGal, Math.hypot(x, y, z))
        for (let b = 0; b < FEATURE_BANDS.length; b++) {
          ev.sumsqH[b] += fh[b]
          ev.sumsqZ[b] += fz[b]
        }
        ev.samples++
        if (ratio < this.cfg.offRatio) {
          if (ev.quietSinceMs === null) ev.quietSinceMs = t
          if (t - ev.quietSinceMs >= this.cfg.holdSec * 1000) out.push(this.close(ev.quietSinceMs, 'quiet'))
        } else {
          ev.quietSinceMs = null
        }
        if (this.open !== null && t - this.open.onMs >= this.cfg.maxEventSec * 1000) {
          out.push(this.close(t, 'max-length'))
          // 長すぎる揺れの後は基準が当てにならない。作り直して助走からやり直す。
          this.lta = this.sta
          this.ltaReady = false
          this.warmUntilMs = t + this.cfg.warmupSec * 1000
        }
      }
    }
    this.nextMs = chunk.firstSampleMs + n * dt
    return out
  }

  /** 検出に使えた最後のサンプルの時刻（データの時刻）。`health()` を組まずに進んだかだけを見る口。 */
  get lastSampleAtMs(): number | null {
    return this.lastSampleMs
  }

  /** いまの状態（`TriggerHealth`）。読むだけで、切り出す区間には触らない。 */
  health(): TriggerHealth {
    const last = this.lastSampleMs
    let windowFrom: number | null = null
    let peak: TriggerPeak | null = null
    if (last !== null) {
      // 輪が覚えている 1440 分ぶん（最後のサンプルの分を含む）。
      const headMs = (Math.floor(last / MINUTE_MS) - (PEAK_MINUTES - 1)) * MINUTE_MS
      // 最後のサンプルを越えさせない（時計が最初のサンプルより前へ戻ると、頭が終わりを追い越す）。
      windowFrom = Math.min(last, Math.max(headMs, this.firstSampleMs ?? headMs))
      peak = this.peakBetween(headMs, last)
    }
    return {
      lastSampleMs: last,
      firstSampleMs: this.firstSampleMs,
      armed: this.ltaReady,
      warmUntilMs: this.filters !== null && !this.ltaReady ? this.warmUntilMs : null,
      inEvent: this.open !== null,
      baselineGal: this.filters !== null && last !== null ? Math.sqrt(this.lta) : null,
      ratio: this.ltaReady ? this.ratio : null,
      onRatio: this.cfg.onRatio,
      peak24h: peak,
      peakWindowFromMs: windowFrom,
    }
  }

  /**
   * `[fromMs, toMs]`（データの時刻）で比がいちばん大きかったサンプル。**範囲は 1 分単位へ外向きに
   * 丸める**（覚えているのが 1 分ごとの最大なので）。覚えているのは最後のサンプルから 24 時間ぶん。
   */
  peakBetween(fromMs: number, toMs: number): TriggerPeak | null {
    const fromMin = Math.floor(fromMs / MINUTE_MS)
    const toMin = Math.floor(toMs / MINUTE_MS)
    let best: TriggerPeak | null = null
    for (let i = 0; i < PEAK_MINUTES; i++) {
      const m = this.peakMinute[i]
      if (!(m >= fromMin && m <= toMin)) continue
      if (best === null || this.peakRatio[i] > best.ratio) best = { ratio: this.peakRatio[i], atMs: this.peakAtMs[i] }
    }
    return best
  }

  private notePeak(t: number, ratio: number): void {
    const m = Math.floor(t / MINUTE_MS)
    const i = ((m % PEAK_MINUTES) + PEAK_MINUTES) % PEAK_MINUTES
    if (this.peakMinute[i] !== m) {
      this.peakMinute[i] = m
      this.peakRatio[i] = ratio
      this.peakAtMs[i] = t
    } else if (ratio > this.peakRatio[i]) {
      this.peakRatio[i] = ratio
      this.peakAtMs[i] = t
    }
  }

  /** 開いている区間を閉じて返す（流し終えたとき）。 */
  flush(): TriggerEvent[] {
    if (this.open === null || this.nextMs === null) return []
    return [this.close(this.nextMs, 'flush')]
  }

  private close(offMs: number, end: TriggerEnd): TriggerEvent {
    const ev = this.open!
    this.open = null
    const n = Math.max(1, ev.samples)
    return {
      onMs: ev.onMs,
      offMs,
      end,
      peakRatio: ev.peakRatio,
      baselineGal: ev.baselineGal,
      peakBandGal: ev.peakBandGal,
      peakHorizontalGal: ev.peakHorizontalGal,
      peakVectorGal: ev.peakVectorGal,
      bandRmsH: ev.sumsqH.map((s) => Math.sqrt(s / n)),
      bandRmsZ: ev.sumsqZ.map((s) => Math.sqrt(s / n)),
    }
  }
}
