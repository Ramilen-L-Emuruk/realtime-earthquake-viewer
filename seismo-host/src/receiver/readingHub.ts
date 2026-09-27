// 計測震度と波形を、繋いでいる相手へ押し出すハブ。
//
// **HTTP を知らない。** SSE のヘッダも再接続も向こう（`statusServer.ts`）の仕事で、
// ここが持つのは「誰が何を欲しがっていて、渡せたか」だけ。分けてあるので、
// ソケットを立てずに詰まりや上限の振る舞いを単体で試せる。
//
// **溜めない。** 受け手が遅ければそのぶんは捨て、捨てた数を数える。送り手（基板）は
// こちらの都合で止まってくれないので、溜める作りはメモリが膨らむ方向にしか倒れない
// （`rawStore.ts` が抱えきれない分を捨てるのと同じ判断）。
//
// **上限に達したら新しいほうを断る。** 組み立ての流れの枠は「いちばん長く音沙汰の無い
// ものを閉じる」だが、あれは基板を入れ替えたとき新しい基板が永久に映らないのを避けるため。
// こちらの相手はブラウザで、**切られても自動で繋ぎ直してくる** —— 古いほうを切る形に
// すると、上限いっぱいのとき双方が延々と切り合う。

import type { IntensityReading, WaveChunk } from './intensityPipeline'
import type { StationIntensityReading } from './sensorFusion'

/**
 * 同時に繋いでいられる数。
 *
 * **枠の目的は「何かが壊れたときに資源が際限なく増えないこと」**で、正常な使い方の
 * 見込み（端末 2〜3 台ぶんのタブ）には十分な余裕がある。達したことは断った件数として
 * 状態の口に出るので、足りなければ外から分かる。
 *
 * **死んだ接続が枠を食い潰さないことが前提。** 詰まったままの購読は下の `STALL_MS` で
 * 切れ、相手が黙って消えた場合は `statusServer.ts` のハートビートが気づいて切る。
 * 片方でも欠けると、枠だけ埋まって新規が永久に入れない状態になりうる。
 */
const MAX_SUBSCRIBERS_DEFAULT = 8

/**
 * 受け取らない状態がこれだけ続いたら、その購読を切る。
 *
 * **回数ではなく経過時間で測る。** センサーの震度は購読の種類によらず毎秒 9 件が流れ、
 * 波形を取る購読にはそこへ毎秒 30 件が積まれる（`publish` は波形だけを選り分け、
 * 震度は全員へ配る）。回数で切ると**同じ「30 秒詰まっている」が購読の種類で
 * 4 倍以上ずれる**（このリポジトリが「異常の判定は経過時間で行う」と決めているのと
 * 同じ理由）。**観測点の合成（`station-reading`）が構成されていれば、そのぶん件数は
 * さらに増える**——こちらも震度と同じく全員へ配る種別なので、上の比率をずらす方向には
 * 働かない。
 */
const STALL_MS_DEFAULT = 30_000

/** 押し出す 1 件。 */
export type HubMessage =
  | { readonly kind: 'reading'; readonly reading: IntensityReading }
  | { readonly kind: 'wave'; readonly wave: WaveChunk }
  /** 観測点ぶんの計測震度（複数センサーの合成。REQUIREMENTS.md §7）。 */
  | { readonly kind: 'station-reading'; readonly reading: StationIntensityReading }

/** ハブが自分から購読を切った理由。 */
export type DetachReason =
  /** 受け取らない状態が続いた。 */
  | 'stalled'
  /** 渡そうとしたら投げた。 */
  | 'failed'
  /**
   * プロセスが終わるので畳んだ。**異常ではない。**
   *
   * ここを `'stalled'` で代用しない —— 受け取る側は理由をそのまま記録へ出すので、
   * **再起動のたびに「詰まって切った」という事実と違う警告**が接続していた数だけ並ぶ。
   * 本物の詰まりと見分けが付かなくなり、「いつもの再起動のあれ」として
   * 読み飛ばされる側に倒れる。
   */
  | 'shutdown'

export interface SubscribeOptions {
  /**
   * 波形も要るか。
   *
   * **要らない相手へは押さない。** 9 本ぶんの波形は毎秒およそ 24 KB あり、
   * 波形を見ていない端末へ流し続ける意味が無い。
   */
  readonly wave: boolean
  /**
   * 1 件渡す。**受け取ったら `true`、いま受け取れないなら `false`。**
   *
   * **`false` を返す前に書いてしまわないこと。** 書いてから「詰まっている」と申告する
   * 作りにすると、こちらは捨てたつもりでいるのに向こうの待ち行列だけが伸び続ける
   * （溜めない、という約束がそこで崩れる）。詰まりは**書く前に**見ること。
   *
   * 投げた場合はその購読だけを切る。**囲うのは、1 つの相手の欠陥が他の購読者と、
   * 同じパケットに同梱された他の基板の震度まで巻き添えにするから** —— 黙らせては
   * いない（切った件数と文面は状態の口に出る）。
   *
   * **`main.ts` が `onError` を囲わないのは「巻き添えが無いから」ではない** ——
   * あちらが投げればプロセスごと落ち、受信も保存も全部止まる。囲わないのは
   * **起動して早い段階で落ちるほうを選んだ**から（網を張ると通知の口自身の欠陥が
   * 静かになる）。こちらが囲えるのは、**失敗を 1 つの購読者へ帰属させられて、
   * 切ったことを数と文面で残せる**から。判断の分かれ目はそこで、被害の大小ではない。
   */
  readonly deliver: (message: HubMessage) => boolean
  /**
   * ハブの側から切ったときに呼ぶ。**省略できない。**
   *
   * 渡し忘れても**ハブの数え上げは正常なまま**（枠は空く）で、向こうのソケットだけが
   * 開きっぱなしで残る。症状がこちら側に何も出ないので、型で要求する。
   * 自分で `close()` したときは呼ばない（呼び出し側は既に知っている）。
   */
  readonly onDetach: (reason: DetachReason) => void
}

export interface Subscription {
  readonly id: number
  /** 購読をやめる。**2 度呼んでもよい。** */
  close(): void
  /**
   * 押し出しが壊れたのでやめる。**数に入れる。**
   *
   * `close()` と分けているのは、**「相手が閉じた」と「書き込みが壊れた」を同じ数に
   * 混ぜない**ため。前者は正常な終わり方で毎回起きるので、混ぜると `failed` が
   * 事実上いつも増え続ける数になり、異常の印として読めなくなる。
   *
   * **ハブが自分で切った場合との違いは `onDetach` を呼ばないこと。** 呼び出し側が
   * 自分で切っているので、後始末はもう済んでいる。
   */
  closeFailed(detail: string): void
}

/** 購読 1 つの様子。 */
export interface SubscriberStats {
  readonly id: number
  readonly wave: boolean
  /** 繋がった時刻（unix ミリ秒）。 */
  readonly sinceMs: number
  readonly delivered: number
  /** 詰まっていて渡せなかった件数。 */
  readonly dropped: number
  /** いま詰まり続けているなら、その始まり（unix ミリ秒）。 */
  readonly stalledSinceMs: number | null
}

/** ハブ全体の様子。**状態の口へそのまま出す。** */
export interface HubSnapshot {
  readonly subscribers: readonly SubscriberStats[]
  readonly limit: number
  /** 上限に達していて断った数（起動してからの累計）。 */
  readonly rejected: number
  /** 詰まりが続いたので切った数。 */
  readonly stalled: number
  /**
   * 押し出しが壊れたので切った数。
   *
   * 中身は 2 通り —— **渡そうとして投げた**のと、**購読側が書き込みの失敗を申告した**
   * （`Subscription.closeFailed`）の。どちらも「向こうへ届かなくなった」という同じ事実で、
   * 運用者から見て区別する意味が無い。
   */
  readonly failed: number
  /** 最後に投げた文面。**原因を追うためのもので、数えるのは上の件数のほう。** */
  readonly lastFailure: string | null
  /**
   * 切ったことを**報せる**処理が投げた数。
   *
   * **`failed` と分ける。** あちらは押し出しそのものが壊れた数で、こちらは
   * 後始末の通知が壊れた数。混ぜると、`/status` を見た人が「向こうへ届いていない」と
   * 読むが、実際に壊れているのは記録の側という食い違いが起きる。
   */
  readonly notifyFailed: number
  /** 報せる処理が最後に投げた文面。 */
  readonly lastNotifyFailure: string | null
  readonly delivered: number
  readonly dropped: number
}

export interface ReadingHubOptions {
  readonly maxSubscribers?: number
  readonly stallMs?: number
  /** 時計。テストのために差し替える。 */
  readonly now?: () => number
}

interface Entry {
  readonly id: number
  readonly wave: boolean
  readonly sinceMs: number
  readonly deliver: (message: HubMessage) => boolean
  readonly onDetach: (reason: DetachReason) => void
  delivered: number
  dropped: number
  stalledSinceMs: number | null
  closed: boolean
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ReadingHub {
  private readonly limit: number
  private readonly stallMs: number
  private readonly now: () => number
  private readonly entries: Entry[] = []
  private nextId = 1
  private rejectedCount = 0
  private stalledCount = 0
  private failedCount = 0
  private lastFailure: string | null = null
  private notifyFailedCount = 0
  private lastNotifyFailure: string | null = null
  private deliveredCount = 0
  private droppedCount = 0

  constructor(options: ReadingHubOptions = {}) {
    this.limit = options.maxSubscribers ?? MAX_SUBSCRIBERS_DEFAULT
    this.stallMs = options.stallMs ?? STALL_MS_DEFAULT
    this.now = options.now ?? Date.now
  }

  /** 繋ぐ。**上限に達していたら `null`。** 断ったことは数える。 */
  subscribe(options: SubscribeOptions): Subscription | null {
    if (this.entries.length >= this.limit) {
      this.rejectedCount++
      return null
    }
    const entry: Entry = {
      id: this.nextId++,
      wave: options.wave,
      sinceMs: this.now(),
      deliver: options.deliver,
      onDetach: options.onDetach,
      delivered: 0,
      dropped: 0,
      stalledSinceMs: null,
      closed: false,
    }
    this.entries.push(entry)
    return {
      id: entry.id,
      close: () => this.remove(entry),
      closeFailed: (detail: string) => {
        // **既に外れていたら数えない。** 2 度呼ばれた回と、ハブが先に切った後の
        // 後追いで数だけが膨らむ。
        if (entry.closed) return
        this.failedCount++
        this.lastFailure = detail
        this.remove(entry)
      },
    }
  }

  /**
   * 1 件を配る。**投げない。**
   *
   * ここはデータグラムを受けている最中から呼ばれるので、投げると**そのパケットに
   * 同梱された他の基板の震度まで消える**（4-2 でいちばん重かった指摘と同じ形）。
   */
  publish(message: HubMessage): void {
    if (this.entries.length === 0) return
    // **写しを回す。** 渡している最中に `close()` されることがあり、
    // 元の配列を直に回すと詰め直しで次の購読者を飛ばす。
    for (const entry of [...this.entries]) {
      if (entry.closed) continue
      if (message.kind === 'wave' && !entry.wave) continue

      let took: boolean
      try {
        took = entry.deliver(message)
      } catch (error) {
        this.failedCount++
        this.lastFailure = messageOf(error)
        this.detach(entry, 'failed')
        continue
      }

      if (took) {
        entry.delivered++
        this.deliveredCount++
        // **1 件でも通ったら詰まりの計時をやめる。** 途切れ途切れに通る相手を
        // 「30 秒詰まっている」と数えない。
        entry.stalledSinceMs = null
        continue
      }

      entry.dropped++
      this.droppedCount++
      const nowMs = this.now()
      if (entry.stalledSinceMs === null) {
        entry.stalledSinceMs = nowMs
        continue
      }
      if (nowMs - entry.stalledSinceMs >= this.stallMs) {
        this.stalledCount++
        this.detach(entry, 'stalled')
      }
    }
  }

  /** いま繋がっている数。 */
  get openCount(): number {
    return this.entries.length
  }

  snapshot(): HubSnapshot {
    return {
      subscribers: this.entries.map((e) => ({
        id: e.id,
        wave: e.wave,
        sinceMs: e.sinceMs,
        delivered: e.delivered,
        dropped: e.dropped,
        stalledSinceMs: e.stalledSinceMs,
      })),
      limit: this.limit,
      rejected: this.rejectedCount,
      stalled: this.stalledCount,
      failed: this.failedCount,
      lastFailure: this.lastFailure,
      notifyFailed: this.notifyFailedCount,
      lastNotifyFailure: this.lastNotifyFailure,
      delivered: this.deliveredCount,
      dropped: this.droppedCount,
    }
  }

  /**
   * 全部切る。**終わるときに呼ぶ。**
   *
   * 切らないと、向こうのソケットが開いたままで `server.close()` が返らない。
   */
  closeAll(): void {
    for (const entry of [...this.entries]) this.detach(entry, 'shutdown')
  }

  /** ハブの側から切る。**理由を伝えてから外す。** */
  private detach(entry: Entry, reason: DetachReason): void {
    if (entry.closed) return
    this.remove(entry)
    try {
      entry.onDetach(reason)
    } catch (error) {
      // **報せ方が壊れていても、外したこと自体は済んでいる。** ここで投げ直すと
      // 残りの購読者への配達が止まるので、数えて次へ進む。
      //
      // **配達の失敗とは別に数える。** 混ぜると、`/status` を見た人が
      // 「押し出しの書き込みが壊れた」と読む —— 壊れているのは報せ方のほうで、
      // 向こうへ届かなくなった理由はまた別にある。
      this.notifyFailedCount++
      this.lastNotifyFailure = messageOf(error)
    }
  }

  /**
   * 一覧から外す。**2 度呼んでもよい**（2 度目は見つからないので何もしない）。
   *
   * ここに「既に閉じていたら帰る」門は置かない —— `indexOf` が同じ仕事をするので、
   * 置いても一度も通らない行になる。**報せを二度出さない**ための門は `detach` のほう。
   */
  private remove(entry: Entry): void {
    entry.closed = true
    const at = this.entries.indexOf(entry)
    if (at >= 0) this.entries.splice(at, 1)
  }
}
