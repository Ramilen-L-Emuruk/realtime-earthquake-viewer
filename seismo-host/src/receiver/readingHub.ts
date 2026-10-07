// 計測震度と波形を、繋いでいる相手へ押し出すハブ。
//
// **HTTP を知らない。** SSE のヘッダも再接続も向こう（`statusServer.ts`）の仕事で、
// ここが持つのは「誰が何を欲しがっていて、渡せたか」だけ。分けてあるので、
// ソケットを立てずに詰まりや上限の振る舞いを単体で試せる。
//
// **溜めない。** 受け手が遅ければそのぶんは捨て、捨てた数を数える。送り手（基板）は
// こちらの都合で止まってくれないので、溜める作りはメモリが膨らむ方向にしか倒れない
// （`mseedStore.ts` が書き込みの待ちを抱えきれない分を捨てるのと同じ判断）。
//
// **上限に達したら新しいほうを断る。** 組み立ての流れの枠は「いちばん長く音沙汰の無い
// ものを閉じる」だが、あれは基板を入れ替えたとき新しい基板が永久に映らないのを避けるため。
// こちらの相手はブラウザで、**切られても自動で繋ぎ直してくる** —— 古いほうを切る形に
// すると、上限いっぱいのとき双方が延々と切り合う。

import type { IntensityReading, WaveChunk } from './intensityPipeline'
import type { FusedWaveChunk, SensorMemberRef, SensorPairDiff, StationIntensityReading } from './sensorFusion'
import type { ShakeEventRecord } from '../detection/shakeEvent'

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
 * センサー単独の波形（`wave`）を取る購読にはそこへ毎秒 33 件が積まれる（実測。
 * `publish` は波形だけを選り分け、震度は全員へ配る）。回数で切ると**同じ
 * 「30 秒詰まっている」が購読の種類で 4 倍以上ずれる**（このリポジトリが
 * 「異常の判定は経過時間で行う」と決めているのと同じ理由）。
 * **観測点の合成（`station-reading`）が構成されていれば、そのぶん件数は
 * さらに増える**——こちらも震度と同じく全員へ配る種別なので、上の比率をずらす方向には
 * 働かない。**合成波形（`station-wave`）は `'station'` 以上を望んだ購読だけへ行く**
 * ので、こちらは比率を広げる側（1 観測点なら毎秒 3 件ほど）。
 * **差分波形（`station-diff`）は頼んだ 1 組だけへ行く**ので、こちらも広げる側
 * （合成と同じ刻みで届くので毎秒 3 件ほど）。**梯子ではなく顔ぶれで配る種別を
 * 足しても、この「回数で測らない」判断は変わらない** —— 購読の種類による件数の
 * 開きがさらに広がるだけで、経過時間で測っていれば影響を受けない。
 */
const STALL_MS_DEFAULT = 30_000

/** 押し出す 1 件。 */
export type HubMessage =
  | { readonly kind: 'reading'; readonly reading: IntensityReading }
  | { readonly kind: 'wave'; readonly wave: WaveChunk }
  /** 観測点ぶんの計測震度（複数センサーの合成。REQUIREMENTS.md §7）。 */
  | { readonly kind: 'station-reading'; readonly reading: StationIntensityReading }
  /** 観測点ぶんの合成波形（同 §7）。**`station-reading` の出どころにあたる波形。** */
  | { readonly kind: 'station-wave'; readonly wave: FusedWaveChunk }
  /**
   * センサー対 1 組ぶんの差分波形（同 §7・#372）。**頼んだ 1 組だけへ配る。**
   *
   * **`station-wave` と同じ層に置けない。** 合成のたびに全ペアぶん作られるので
   * （実機のセンサー 9 本なら 36 組・毎秒 240 KB（実測））、波形の梯子
   * （{@link WaveWant}）へ載せた時点で波形タブが黙ってその量を受けることになる。
   * 配る相手は**顔ぶれで選ぶ**（`WAVE_TIER` の `'pair'` と {@link PairWant}）。
   */
  | { readonly kind: 'station-diff'; readonly diff: SensorPairDiff }
  /**
   * 検出した揺れの記録 1 版（REQUIREMENTS.md §6・§9。`../detection/shakeEvent.ts`）。
   * **全員へ配る。** 1 日に十数件・1 件 1 KB ほどで、照合の結果が出るたびに同じ揺れの
   * 新しい版が届く（受け手は `id` ごとに最後の `rev` を採る）。
   */
  | { readonly kind: 'shake-event'; readonly event: ShakeEventRecord }
  /**
   * 取り戻した区間の合成波形を作り直し、控え（`GET /waves`）へ足し終えた知らせ（#597）。
   * **範囲だけを伝え、波形は載せない** —— 受け手は自分の抱えている穴と重なるときだけ取りに来る。
   *
   * **合成波形と同じ層**（`WAVE_TIER` の `'station'`）。受け手が読むのは合成波形の穴を埋めるためで、
   * 合成波形を受けていない相手には使い道が無い。
   */
  | { readonly kind: 'station-wave-revised'; readonly revised: StationWaveRevised }

/** 作り直した範囲。`[fromMs, toMs)` に掛かる合成のまとまりが控えで作り直した分へ替わった。 */
export interface StationWaveRevised {
  readonly stationId: string
  readonly fromMs: number
  readonly toMs: number
}

/**
 * 購読者が波形をどこまで欲しがっているか。
 *
 * **`'station'` を用意してあるのが要。** 観測点の合成波形（`station-wave`）だけを
 * 見たい相手——地震ビューアーの PWA がそれ——に、センサー単独の波形（`wave`）まで
 * 押し付けないため。実測（実機・センサー 9 本）で `wave` は毎秒およそ 65 KB あり、
 * 合成の毎秒およそ 15 KB に対して 4 倍を超える。**受け手が捨てる形では通信量は
 * 減らない**ので、ここで選り分ける。
 */
export type WaveWant =
  /** 波形は要らない（震度だけ）。 */
  | 'none'
  /** 観測点の合成波形だけ要る。 */
  | 'station'
  /** センサー単独の波形も要る（管理コンソールの波形タブ）。 */
  | 'all'

/**
 * 差分波形を見たいセンサー対 1 組（#372）。
 *
 * **梯子（{@link WaveWant}）とは直交している。** 差分は全ペアぶん作られるので、
 * `'all'` に含める形にすると波形タブが 36 組を受けてしまう ——「欲しいと言った 1 組」を
 * 顔ぶれで指すのがこの型の役目。
 *
 * **向きはどちらでもよい**（`a` と `b` が入れ替わっていても同じ組として配る）。
 * 差分の式は `d = (a − b) / 2` なので**入れ替えると符号が反転する**が、押し出す
 * 1 件は `memberA`・`memberB` を自分で名乗るので、受け手はどちらの向きで来たのかを
 * 見分けられる。向きを厳しく見ると、設定でセンサーの並びが変わっただけで
 * **何も届かなくなる**（繋がっているのに来ない、という最も気づきにくい形）。
 */
export interface PairWant {
  readonly stationId: string
  readonly a: SensorMemberRef
  readonly b: SensorMemberRef
}

function sameMember(x: SensorMemberRef, y: SensorMemberRef): boolean {
  return x.boardKey === y.boardKey && x.sensorId === y.sensorId
}

/**
 * 頼んだ組と、いま流れてきた差分が同じ組か。**向きは問わない**（{@link PairWant}）。
 */
export function pairMatches(want: PairWant, diff: SensorPairDiff): boolean {
  if (want.stationId !== diff.stationId) return false
  if (sameMember(want.a, diff.memberA) && sameMember(want.b, diff.memberB)) return true
  return sameMember(want.a, diff.memberB) && sameMember(want.b, diff.memberA)
}

/**
 * その種別が波形のどの層に属するか。
 *
 * **`Record` にしてあるので、`HubMessage` へ種別を足してここへ書かなければ型検査が
 * 止める。** 選り分けを `if (message.kind === 'wave')` と直に書く形だと、後から足した
 * 種別が既定で全員へ流れる —— 毎秒およそ 15 KB の合成波形が、震度だけを見に来た
 * 相手へ黙って届くことになる（{@link WaveWant} の説明を見ること）。
 * このリポジトリが「表を 1 つにすれば書き写す場所そのものが無くなる」と決めているのと
 * 同じ手当て（`main.ts` の `Record<GravityCount, string>`）。
 */
type WaveTier =
  /** 波形ではない（震度）。購読者の希望に関わらず配る。 */
  | 'always'
  /** 観測点の合成波形。 */
  | 'station'
  /** センサー単独の波形。 */
  | 'sensor'
  /**
   * センサー対の差分波形。**梯子では決まらない** —— 頼んだ顔ぶれと突き合わせる
   * （{@link PairWant}）。
   */
  | 'pair'

const WAVE_TIER: Record<HubMessage['kind'], WaveTier> = {
  reading: 'always',
  wave: 'sensor',
  'station-reading': 'always',
  'station-wave': 'station',
  'station-diff': 'pair',
  'shake-event': 'always',
  'station-wave-revised': 'station',
}

/** 差分の種別なら中身を、そうでなければ null。**`'pair'` の場で型を絞るため。** */
function diffOf(message: HubMessage): SensorPairDiff | null {
  return message.kind === 'station-diff' ? message.diff : null
}

/** 配るかを決めるのに要る、購読者側の希望。 */
interface DeliveryWants {
  readonly wave: WaveWant
  readonly diff: PairWant | null
}

/**
 * その購読者へこの 1 件を配るか。
 *
 * **`switch`（`default` なし）で書く。** 層を足したら型検査が止める——比較の式
 * （`want !== 'none'` の並び）で書くと、新しい層は既定でどちらかへ黙って倒れる。
 *
 * **種別ではなく 1 件そのものを受け取る。** `'pair'` の層は顔ぶれを突き合わせるので
 * 中身が要る —— 種別だけを渡す形のままだと、差分を「梯子のどこか」へ押し込むしか
 * なくなり、`'all'` の相手（波形タブ）へ 36 組が流れ出す。
 */
function shouldDeliver(wants: DeliveryWants, message: HubMessage): boolean {
  switch (WAVE_TIER[message.kind]) {
    case 'always':
      return true
    case 'station':
      // 合成だけを見に来た相手にも、全部要る相手にも配る。
      return wants.wave === 'station' || wants.wave === 'all'
    case 'sensor':
      return wants.wave === 'all'
    case 'pair': {
      if (wants.diff === null) return false
      const diff = diffOf(message)
      // `WAVE_TIER` が `'pair'` を割り当てるのは差分の種別だけなので、ここが
      // null になることは無い。**それでも書く** —— 型を絞る手立てがこれしかなく、
      // 省くと「差分かどうか」の判定が層の表と二重になる。
      return diff !== null && pairMatches(wants.diff, diff)
    }
  }
}

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
   * 波形をどこまで欲しがっているか（どの種別がどの層かは `WAVE_TIER` が持つ）。
   *
   * **要らない相手へは押さない。** 実測（実機・センサー 9 本・2026-09-28 に 6 秒受けた）で
   * センサー単独の波形（`wave`）が**毎秒およそ 65 KB**（1 件 1990 B・30 サンプル・
   * 毎秒 33 件）、観測点の合成波形（`station-wave`）が**毎秒およそ 15 KB**
   * （1 観測点ぶん・`dcGal` と `memberCount` が付くので 1 件は約 2.3 倍）。
   *
   * 比較のため同じ実測での他の種別 —— `reading` が毎秒およそ 2.5 KB、
   * `station-reading` が毎秒およそ 0.1 KB。**桁が 2 つ違う**ので、
   * 波形だけを選り分ける意味がある。
   */
  readonly wave: WaveWant
  /**
   * 差分波形を見たい 1 組（要らなければ null）。**省略できない。**
   *
   * **任意（`?`）にしない。** 渡し忘れても「差分が届かない」だけで例外もログも
   * 出ないので、配線の落ちに気づく機会が無い（このリポジトリが引数を必須にする
   * と決めているのと同じ理由）。要らない購読は `null` と書く。
   */
  readonly diff: PairWant | null
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
  /** 波形をどこまで受けているか。**状態の口へそのまま出す**（通信量の見当が付く）。 */
  readonly wave: WaveWant
  /**
   * 差分波形を頼んでいる 1 組（頼んでいなければ null）。**状態の口へそのまま出す。**
   *
   * **頼んだ顔ぶれが見えないと、届かない理由を外から切り分けられない。** 設定が
   * 変わって組が無くなった場合、症状は「1 件も来ない」だけ ——`/status` に頼んだ組が
   * 出ていれば、いまの `pairDiffs` の一覧と見比べて「その組はもう無い」と分かる。
   */
  readonly diff: PairWant | null
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
  readonly wave: WaveWant
  readonly diff: PairWant | null
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
      diff: options.diff,
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
      if (!shouldDeliver(entry, message)) continue

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
        diff: e.diff,
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
