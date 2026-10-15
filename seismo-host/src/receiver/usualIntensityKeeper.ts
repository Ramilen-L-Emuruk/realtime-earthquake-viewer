/**
 * 観測点ごとの「普段」の計測震度を、定期的に測っておく係（`/status` の `usualIntensities`）。
 *
 * **何に使うか。** アプリは地震カードへ自作地震計の波形を出すかを、その地震で自作地震計の場所に
 * 予測される計測震度が「普段の計測震度 − 0.5」を上回るかで決める（2026-10-13 ユーザー承認）。
 * 地震が起きてから `/quake-intensity` で訊くのでは、出すかどうかを決める前に問い合わせが要る
 * ので、比べる相手をここで先に用意しておく。
 *
 * **測り方は `/quake-intensity` の `usualMeasured` と同じ**（`computeUsualMeasured`）。直前 1 時間へ
 * 6 区間を散らし、中央値を取る。区間の長さはアプリの地震カードの区間（{@link USUAL_STATUS_WINDOW_MS}）
 * に合わせる —— 計測震度は区間の長さで値が変わるので、長さが違うと比べる物差しがずれる。
 *
 * **読めなかったら前の値を残さない。** 止まった値を「いまの普段」と名乗ると、アプリの下限が
 * 黙って古いまま効く。`null` を出せば、アプリは下限を置かずに出す側へ倒れる。
 */
import { computeUsualMeasured, USUAL_SPAN_MS, type UsualMeasuredResult } from './quakeIntensity'
import type { LogLevel } from './statusServer'
import type { WaveRangeResult } from './waveArchive'

/**
 * 「普段」を測る区間の長さ（ms）。**5 分。**
 *
 * アプリの地震カードが読み返す区間（`src/services/seismoWaveHistory.ts` の
 * `WAVE_HISTORY_LEAD_MS` 60 秒 ＋ `WAVE_HISTORY_TAIL_MS` 240 秒）と同じ長さ。あちらを動かしたら
 * ここも合わせる。
 */
export const USUAL_STATUS_WINDOW_MS = 300_000

/**
 * 測り直す間隔（ms）。**10 分。** 1 時間の中央値なので、これより細かく測っても値はほとんど動かない。
 * 1 回の重さは観測点 1 つで 5 分 × 6 区間（作業 PC で 0.1 秒ほど）。
 */
export const USUAL_STATUS_REFRESH_MS = 10 * 60_000

/** 観測点 1 つぶん。 */
export interface UsualIntensityStatus extends UsualMeasuredResult {
  readonly stationId: string
  /** 区間 1 つの長さ（ms）。 */
  readonly windowMs: number
  /** 測った時刻（ホストの時計）。**まだ測っていなければ `null`**（0 で埋めると 1970 年に読める）。 */
  readonly computedAtMs: number | null
}

export interface UsualIntensityKeeperOptions {
  /** いまの設定にある観測点。**呼ばれた時点の設定を返す**（設定は管理コンソールから変わる）。 */
  readonly stationIds: () => readonly string[]
  readonly readWaves: (params: { readonly stationId: string; readonly fromMs: number; readonly toMs: number }) => Promise<WaveRangeResult>
  /** 区間 1 つごとに受信へ順番を譲る（`computeUsualMeasured` の説明）。 */
  readonly onWindow: () => Promise<void>
  readonly log: (level: LogLevel, kind: string, detail: string, line: string) => void
}

const EMPTY: UsualMeasuredResult = { usualMeasured: null, usualWindowCount: 0, usualUsedCount: 0 }

export class UsualIntensityKeeper {
  private readonly book = new Map<string, UsualIntensityStatus>()
  private running: Promise<void> | null = null
  private runningSinceMs = 0

  constructor(private readonly options: UsualIntensityKeeperOptions) {}

  /**
   * 全観測点を 1 つずつ測り直す。**前の回が走っている間は、その回を待つだけで重ねない**
   * （1 時間ぶんの読み返しを並べて走らせない）。**投げない** —— 呼び出し側は `void` で捨てるので、
   * 投げればホストごと落ちる（未処理の拒否）。
   */
  refresh(nowMs: number): Promise<void> {
    if (this.running !== null) {
      // **前の回が終わらないまま間隔の 3 倍を過ぎたら記録へ残す。** 黙っていると、アプリは
      // 30 分後に古い値を捨てて下限なしへ倒れ、誰も気づかない。
      if (nowMs - this.runningSinceMs > USUAL_STATUS_REFRESH_MS * 3) {
        this.options.log(
          'warn',
          'usual-intensity-stuck',
          '',
          `[usual-intensity] 普段の計測震度の測り直しが ${Math.round((nowMs - this.runningSinceMs) / 60_000)} 分終わっていない`,
        )
      }
      return this.running
    }
    this.runningSinceMs = nowMs
    this.running = this.refreshAll(nowMs)
      .catch((error: unknown) => {
        this.options.log(
          'error',
          'usual-intensity-refresh',
          '',
          `[usual-intensity] 普段の計測震度の測り直しで例外: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        )
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  /** いまの設定の観測点の並びで返す。外した観測点は出さない。 */
  snapshot(): UsualIntensityStatus[] {
    return this.options.stationIds().map(
      (stationId) =>
        this.book.get(stationId) ?? { stationId, ...EMPTY, windowMs: USUAL_STATUS_WINDOW_MS, computedAtMs: null },
    )
  }

  private async refreshAll(nowMs: number): Promise<void> {
    const ids = this.options.stationIds()
    for (const stationId of ids) {
      const result = await this.measure(stationId, nowMs)
      // **値があったのに読めなくなったら記録へ残す**（例外のときは measure が残している）。
      // 区間が足りないだけでも null になり、そのままではアプリが下限を外したことに誰も気づけない。
      const prev = this.book.get(stationId)
      if (result.usualMeasured === null && prev !== undefined && prev.usualMeasured !== null) {
        this.options.log(
          'warn',
          'usual-intensity-lost',
          stationId,
          `[usual-intensity] 普段の計測震度が読めなくなった（使えた区間 ${result.usualUsedCount}/${result.usualWindowCount}）`,
        )
      }
      this.book.set(stationId, { stationId, ...result, windowMs: USUAL_STATUS_WINDOW_MS, computedAtMs: nowMs })
    }
    // 外した観測点の覚えを捨てる（戻したときに古い値を出さない）。
    for (const key of [...this.book.keys()]) if (!ids.includes(key)) this.book.delete(key)
  }

  /**
   * 1 観測点を測る。**読み返しの失敗と計算の失敗は記録を分ける**（`statusServer.ts` の
   * `computeUsualFor` と同じ理由 —— 計算の誤りが「普段が出ないだけ」に見えないように）。
   */
  private async measure(stationId: string, nowMs: number): Promise<UsualMeasuredResult> {
    let read: WaveRangeResult
    try {
      read = await this.options.readWaves({ stationId, fromMs: nowMs - USUAL_SPAN_MS, toMs: nowMs })
    } catch (error) {
      this.options.log(
        'warn',
        'usual-intensity',
        stationId,
        `[usual-intensity] 普段の計測震度を測れなかった（記録を読めない）: ${error instanceof Error ? error.message : String(error)}`,
      )
      return EMPTY
    }
    try {
      return await computeUsualMeasured({
        chunks: read.chunks,
        fromMs: nowMs,
        toMs: nowMs + USUAL_STATUS_WINDOW_MS,
        onWindow: this.options.onWindow,
      })
    } catch (error) {
      this.options.log(
        'error',
        'usual-intensity-compute',
        stationId,
        `[usual-intensity] 普段の計測震度の計算で例外: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      )
      return EMPTY
    }
  }
}
