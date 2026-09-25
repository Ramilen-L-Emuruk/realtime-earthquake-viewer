// 届いたデータグラムを生のまま残す。日ごとに 1 本へ書き、古くなった分を gzip する。
//
// **消さない。** 保持の判断は受け手が持たない（ディスクが埋まる前に人が消す）。
// 圧縮して元を消すのはこの約束に反しない —— 同じ中身が形を変えただけ。
//
// **読めなかったパケットこそ残す。** 読み取りの `detail` は先頭 120 字しか記録へ出ないので、
// ここを通さないと「別のプログラムが同じ口へ投げている」疑いを後から確かめる手立てが無い。
//
// **落ちない。** 保存が止まっても震度は出し続ける（受信層の本題はそちら）。ただし黙らない ——
// 失った件数・流し口の異常・圧縮の結末を、呼び出し側が数えられる形で持つ。
//
// **本の出口は 1 つ（`retire`）。** 順当に締めるときも、流し口が壊れて捨てるときも、同じ口を通す。
// ここを 2 つに分けていたときは、壊れた側だけが締めくくりの待ち合わせから漏れ、**溜まっていた
// 分の勘定が終わる前にプロセスが終わる**形になっていた（同じ形の欠陥をレビューで 3 度指摘された）。
//
// **締めくくりには性質の違う 2 相がある。** 書き出している間（失うものがあり、進み具合を測れる）と、
// 書き終えて閉じるのを待つ間（**失うものが無く**、進み具合を測る手立ても無い）。
// 1 本の物差しで測ると、必ずどちらかで嘘になる。
//
// **既知の限界: `fsync` は掛けていない。** 書き込みのコールバックが成功で返ってから、
// 実際の永続化が失敗する形（ネットワーク越しのドライブ・劣化したディスク）は検知できない。
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

import { MAX_TIME_MS } from '../protocol/parsePacket'

/**
 * 日の境目を日本時間で取るための下駄。
 *
 * **プロセスの時間帯設定（`TZ`）は読まない。** `getDate()` の類はホストの設定で答えが変わるので、
 * 別の機械へ移した日や CI（UTC で回る）を境に、同じ名前のファイルが別の 24 時間を指すようになる。
 * ずれても例外は出ず、**ファイル名だけが黙って 9 時間ずれる**。
 *
 * 日本時間を選んだのは、このリポジトリが既に「1 日＝日本時間の日」と決めているため
 * （長期震源カタログの `fromMs`/`toMs`。あちらも `Date.UTC` で組んでから引く形で `TZ` を避けている）。
 * 突き合わせる相手（気象庁の電文）も日本時間で、揺れているのは日本の家。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** 抱えたまま書き出せていない量の上限。**超えたら捨てる** —— 際限なく抱えるとメモリが膨らむ。 */
const MAX_PENDING_BYTES_DEFAULT = 8 * 1024 * 1024

/** 流し口が壊れてから開き直すまで。**毎パケット開き直すと、詰まったディスクを叩き続ける。** */
const REOPEN_INTERVAL_MS_DEFAULT = 5_000

/**
 * 締めくくりを待つ間隔。**2 相で意味が変わる。**
 *
 * - **書き出している間**（残量 > 0）: この時間ぶん残量が 1 バイトも減らなければ諦める。
 *   経過時間で切ると、**遅いだけで壊れていない**記憶装置（SD カード・劣化したディスク）で
 *   まだ渡していない分を自分で捨てることになる。8 MB 抱えられるので、単純な締め切りは
 *   1.6 MB/秒を下回る相手をそれだけで切る
 * - **書き終えて閉じるのを待つ間**（残量 = 0）: 進み具合を測る手立てが無い（残量は 0 のまま
 *   動かない）ので、素直に時間で切る。**ここで諦めても失うものは無い**ので、
 *   「流し口が壊れた」とは数えない
 *
 * **書き出し側の見張りは「1 件を書き出すのにかかる時間」より長くないと効かない。** 1 周しても
 * 1 件も終わらない相手は、止まっているのと見分けが付かない。既定の 5 秒に対して 1 件は
 * 数百バイトなので、桁がいくつも違う。
 */
const CLOSE_STALL_MS_DEFAULT = 5_000

/**
 * 締めくくり全体に掛ける上限。
 *
 * **進み具合の見張りだけでは、終了が終わらないことがある。** 1 件ずつぽつりぽつりと片付く
 * 相手では、見張りはいつまでも「進んでいる」と答えて待ち直す（8 MB ぶん溜まっていれば
 * 理論上は何時間にもなる）。終了の合図を受けても抜けられず、**累計も理由も出ないまま
 * 強制終了される**のがいちばん悪い。
 *
 * **回転には掛けない。** あちらは急がない —— 新しい本へは書けているので、古い本が
 * ゆっくり片付いても誰も困らない。
 */
const CLOSE_BUDGET_MS_DEFAULT = 30_000
/**
 * 締めくくりに入ってから（または最後に書き出しが進んでから）これを超えて閉じ終わらない本を
 * 「居座っている」とみなす。
 *
 * **経過時間だけで決めない。** 締めくくりの第 1 相は進んでいる限り何秒でも待つので、
 * 低速なだけの書き込み先は健全なまま 60 秒を超える —— そこで鳴らすと、いちばん
 * 捨ててほしくない相手（遅いが生きている）を異常として報せることになる。
 * 進んでいる間は数えず、**止まったまま**この時間を超えたものだけを数える。
 */
const STUCK_AFTER_MS = 60_000

/**
 * 同じ日の `.gz` が既にあるときに逃がせる本数。
 *
 * 普段は起きない。起きるのは**時計が戻った**とき —— 狂った時計で起動して書いたあと NTP が直すと、
 * 圧縮済みの日が「今日」として開き直される。そのとき上書きすると片方が消えるので、別名へ逃がす。
 */
const MAX_GZ_VARIANTS = 99

const DAY_FILE_RE = /^raw-(\d{4}-\d{2}-\d{2})\.ndjson$/

/** 保存できなかった理由。**数えるために分ける** —— 手当てが違う。 */
export type RawUnsavedReason =
  /** 流し口を開けていない（開き直しの間隔を待っている最中を含む）。 */
  | 'no-stream'
  /** 書き出しが追いつかず、抱えた量が上限を超えた。 */
  | 'backpressure'
  /** 書き込みそのものが失敗した。 */
  | 'write-failed'
  /** 既に締めたあとに渡された。 */
  | 'closed'

export type RawWriteResult =
  | { readonly saved: true }
  | { readonly saved: false; readonly reason: RawUnsavedReason }

export interface RawStoreOptions {
  /** 書き出す先。無ければ作る。**作れなければ投げる。** */
  readonly dir: string
  /** いまの時刻（unix ミリ秒）。差し替えられるのはテストのため。 */
  readonly now?: () => number
  readonly maxPendingBytes?: number
  readonly reopenIntervalMs?: number
  /** 締めくくりを待つ間隔（2 相での意味は `CLOSE_STALL_MS_DEFAULT`）。 */
  readonly closeStallMs?: number
  /** `close()` 全体に掛ける上限。 */
  readonly closeBudgetMs?: number
  /**
   * 流し口を開く。**差し替えられるのはテストのため。**
   *
   * 「遅いが生きている」「止まった」「閉じるのに時間が掛かる」相手は、本物のファイルでは
   * 決め打ちで作れない（速さは OS の都合で決まる）。ここを差し替えられないと、
   * 締めくくりの手当てが効いているかを一度も確かめられない。
   */
  readonly openStream?: (path: string) => Writable
}

/**
 * 居座りを測る起点。進んだ時刻があれば**そちらから**測る。
 *
 * **締めくくりに入った時刻だけを見ない。** 第 1 相は進んでいる限り何秒でも待つ設計なので、
 * 低速なだけの書き込み先は健全なまま経過時間の上限を超える —— そこで鳴らすと、いちばん
 * 捨ててほしくない相手（遅いが生きている）を異常として報せることになる。
 *
 * まだ締めくくりに入っていなければ `null`（居座りようがない）。
 */
export function stuckSince(retiredAtMs: number | null, progressAtMs: number | null): number | null {
  if (retiredAtMs === null) return null
  return Math.max(retiredAtMs, progressAtMs ?? retiredAtMs)
}

/**
 * 日本時間でのその日（`YYYY-MM-DD`）。
 *
 * **時刻として表せない値では `null` を返す。** 名前を作れない以上、呼び出し側は
 * 「回さない」を選ぶしかない（当て推量の名前でファイルを分けるより、同じ本へ書き続けるほうがまし）。
 */
export function jstDay(ms: number): string | null {
  // **有限なだけでは足りない。** 下駄を足した結果が `Date` の範囲を出ると `toISOString()` が投げる。
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_TIME_MS - JST_OFFSET_MS) return null
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 開いている 1 本。 */
interface OpenFile {
  readonly stream: Writable
  /** 書き出せていないバイト数。**上限の判定と、進んでいるかの見張りに使う。** */
  pending: number
  /** 書き出せていない件数。**諦めたときに失う数**で、バイト数からは割り出せない。 */
  queued: number
  /** 手放した本。**二重に数えないための印**（手放す側が件数を数えてある）。 */
  abandoned: boolean
  /** 締めくくりに入った本。**ここが真の間、抱えている分は失われうる。** */
  retiring: boolean
  /**
   * 手放すと決めたときに確定した、失う件数。
   *
   * **`queued` をそのまま見続けられない。** 壊れた流し口を捨てると、溜まっていた分の
   * 書き込みのコールバックがその場で発火して `queued` が 0 まで落ちる —— ところが
   * 失った件数が `lostRecords` へ移るのは、そのあと閉じ終わってから。**その隙に読むと
   * どちらの数字にも現れない**。手放した時点の値をここへ写しておけば、隙が無くなる。
   * まだ手放していない本は `null`。
   *
   * **この隙はテストで再現できていない。** 捨ててから閉じ終わるまでは数ミリ秒で、
   * そのあいだに読ませる手立てが無い（狙って待つと、待っている間に閉じ終わる）。
   * ここを `book.queued` へ戻す変異はテストを素通りする —— **守られていないことを
   * 承知のうえで置いている**。
   */
  abandonedAt: number | null
  /** 締めくくりに入った時刻（実時計）。まだ入っていなければ `null`。 */
  retiredAtMs: number | null
  /**
   * 締めくくりの最中に、書き出しが最後に進んだ時刻。
   *
   * **経過時間だけでは「止まっている」と言えない。** 締めくくりの第 1 相は
   * 進んでいる限り何秒でも待つ設計（遅いだけで壊れていない相手から、まだ渡していない分を
   * 自分で捨てないため）なので、8MB を抱えた低速な書き込み先は健全なまま 60 秒を超える。
   * **進み具合は手元にあるのだから、経過時間で代用しない。**
   */
  progressAtMs: number | null
}

/** 本の終わり方。 */
interface CloseOutcome {
  /** 失った分があるときの理由。**失っていなければ `null`。** */
  readonly error: Error | null
  /** 手放した時点で書き出せていなかった件数。 */
  readonly abandoned: number
  /** 書き出しは済んだが、閉じ終わるのを待ちきれなかった。**失ったものは無い。** */
  readonly slowClose: boolean
}

/**
 * 捨てる。**溜まっていた分は失われる**ので、件数を持ち出してから捨てる。
 *
 * 捨てたあと `end()` のコールバックや `error` が遅れて届くので、結末は呼び出し側が
 * 先に決めて渡す（受け取った側で作ると、遅れて来たほうに上書きされる）。
 */
function dropStream(file: OpenFile, limitMs: number, outcome: CloseOutcome): Promise<CloseOutcome> {
  file.abandoned = true
  // **捨てる前に確定値を写す。** この直後の `destroy()` で溜まっていた分のコールバックが
  // 発火して `queued` が落ちるが、失った件数が `lostRecords` へ移るのは閉じ終わってから。
  file.abandonedAt = outcome.abandoned
  return new Promise<CloseOutcome>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      if (timer !== null) clearTimeout(timer)
      resolve(outcome)
    }
    // **閉じ終わるまでを 1 本と数える。** 先に解決すると、まだ開いている本を閉じた扱いにして
    // しまい、`openFiles`（閉じ忘れを見張る唯一の手立て）が嘘をつく。
    file.stream.once('close', finish)
    // 閉じ終わりすら来ないことがある。そこまで待つと締める側ごと止まる。
    timer = setTimeout(finish, limitMs)
    timer.unref()
    file.stream.removeAllListeners('error')
    file.stream.on('error', () => {
      // 壊れた流し口は閉じる途中でも投げる。ここで受け止めないとプロセスごと落ちる。
    })
    file.stream.destroy()
  })
}

/**
 * 本を手放す。**`broken` は「流し口が壊れたと既に判っている」** ＝ 流し切ろうとしない。
 *
 * 順当に締めるときは 2 相で見る（`CLOSE_STALL_MS_DEFAULT` の説明）。
 */
function releaseStream(
  file: OpenFile,
  stallMs: number,
  broken: boolean,
  now: () => number,
): Promise<CloseOutcome> {
  // 壊れた理由は呼び出し側（`failFile`）が既に数えてある。ここで重ねない。
  if (broken) {
    return dropStream(file, stallMs, { error: null, abandoned: file.queued, slowClose: false })
  }

  return new Promise<CloseOutcome>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let done = false
    let lastPending = file.pending
    /**
     * 手放すと決めたときの結末。
     *
     * **捨てたあとに `end()` のコールバックが「成功」として発火する**（実測）。
     * 先に立てておかないと、手放した事実も失った件数もそれに上書きされる。
     */
    let forced: CloseOutcome | null = null
    const finish = (outcome: CloseOutcome): void => {
      if (done) return
      done = true
      if (timer !== null) clearTimeout(timer)
      resolve(outcome)
    }
    // **この待ちだけでプロセスを生かさない。** 正常に終わろうとしているのを引き延ばさない。
    const wait = (run: () => void): void => {
      timer = setTimeout(run, stallMs)
      timer.unref()
    }
    const watch = (): void => {
      if (file.pending === 0) {
        // **第 2 相。** 書き出しは済んでいるので、捨てても失うものは無い。
        // 残量は 0 のまま動かないから、進み具合では測れない —— ここだけ時間で切る。
        // **「流し口が壊れた」とは数えない**（数えると、日をまたぐたびに誤報が積み上がる）。
        forced = { error: null, abandoned: 0, slowClose: true }
        void dropStream(file, stallMs, forced).then(finish)
        return
      }
      if (file.pending < lastPending) {
        lastPending = file.pending
        // **進んだことを外からも読めるようにする。** 居座りの見張り（`stuckBooks`）が
        // これを見て「遅いだけ」と「止まっている」を分ける。
        //
        // **この 1 行はテストで守れていない。** 書かれた値の使い方（`stuckSince`）は
        // 単体で固めてあるが、「締めくくりの最中に進み続ける」状況を作るには、
        // 書き出しが少しずつ返る流し口と、その途中で進む時計の両方が要る —— 組んでも
        // タイミング次第で結果が変わり、落ちるべきときに落ちないテストになる。
        file.progressAtMs = now()
        wait(watch)
        return
      }
      // **第 1 相で止まった。** ここで捨てる分は本当に失われる。
      //
      // **失う件数はここでしか判らない。** 止まった流し口を捨てても、溜まっていた分の
      // 書き込みのコールバックは**呼ばれないことがある**（実測: 素の `Writable` では 1 件も
      // 来ない）。バイト数から件数は割り出せないので、手放す時点の件数をそのまま持ち出す。
      forced = {
        error: new Error(
          `流し口が ${stallMs}ms 進まないので締めた（書き出せていない ${file.queued} 件・${file.pending} バイト）`,
        ),
        abandoned: file.queued,
        slowClose: false,
      }
      void dropStream(file, stallMs, forced).then(finish)
    }
    /**
     * 締めている最中に壊れた。
     *
     * **ここも手放す口を通す。** 直に解決すると `abandoned` が 0 で確定し、溜まっていた分が
     * 「失っていない」ことになる —— 3 巡続いた形（勘定が待ち合わせから漏れる）の、最後の適用漏れ。
     */
    const failed = (error: Error): void => {
      if (forced !== null) {
        finish(forced)
        return
      }
      forced = { error, abandoned: file.queued, slowClose: false }
      void dropStream(file, stallMs, forced).then(finish)
    }

    wait(watch)
    file.stream.removeAllListeners('error')
    file.stream.once('error', failed)
    // **締めくくりのコールバックもエラーを受け取りうる。** 引数を取らない形で書くと、
    // そこで初めて判った失敗が黙って捨てられる。
    file.stream.end((error?: Error | null) => {
      if (error !== null && error !== undefined) {
        failed(error)
        return
      }
      finish(forced ?? { error: null, abandoned: 0, slowClose: false })
    })
  })
}

/** 中身の指紋。**照らし合わせるためだけに使う** —— 保存する値ではない。 */
async function digestOf(path: string, compressed: boolean): Promise<string> {
  const hash = createHash('sha256')
  const sink = async (chunks: AsyncIterable<Buffer>): Promise<void> => {
    for await (const chunk of chunks) hash.update(chunk)
  }
  if (compressed) await pipeline(createReadStream(path), createGunzip(), sink)
  else await pipeline(createReadStream(path), sink)
  return hash.digest('hex')
}

async function sameContent(plain: string, gz: string): Promise<boolean> {
  const [a, b] = await Promise.all([digestOf(plain, false), digestOf(gz, true)])
  return a === b
}

export class RawStore {
  private readonly dir: string
  private readonly now: () => number
  private readonly maxPendingBytes: number
  private readonly reopenIntervalMs: number
  private readonly closeStallMs: number
  private readonly closeBudgetMs: number
  private readonly openStream: (path: string) => Writable

  private file: OpenFile | null = null
  private day: string | null = null
  private closed = false

  /**
   * 最後に読めた時刻。**まだ一度も読めていなければ `null`。**
   *
   * `0` で始めると、1 件目から時計が壊れている端末で 1970-01-01 という名前の本ができる。
   * 「判らない」と「元期」は別の事実。
   */
  private lastMs: number | null = null
  private reopenAtMs = 0

  private writeErrorCount = 0
  private lostCount = 0
  private slowCloseCount = 0
  private compressedCount = 0
  private compressFailureCount = 0
  private leftoverCount = 0
  private listFailureCount = 0
  private escapedCount = 0
  private lastWriteErrorText: string | null = null
  private lastSweepErrorText: string | null = null
  private sweeping: Promise<void> | null = null
  /**
   * 開いている本すべて（いま書いている 1 冊と、締めくくりの最中の本）。
   *
   * **数を足し引きで持たない。** 締めくくりは非同期で、終わらない経路が 1 つ増えるたびに
   * 足し忘れが生まれる —— 「勘定が締めくくりのどこかで漏れる」という同じ形の指摘が
   * 3 巡続けて出たのはそれが理由だった。**集合から毎回引けば、いつ読んでも合う。**
   */
  private readonly books = new Set<OpenFile>()
  private cutShortFlag = false
  /** 締め終わっていない本。**解決したら外す** —— 積みっぱなしにすると年単位で伸びる。 */
  private readonly closing = new Set<Promise<void>>()

  constructor(options: RawStoreOptions) {
    this.dir = options.dir
    this.now = options.now ?? Date.now
    this.maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_BYTES_DEFAULT
    this.reopenIntervalMs = options.reopenIntervalMs ?? REOPEN_INTERVAL_MS_DEFAULT
    this.closeStallMs = options.closeStallMs ?? CLOSE_STALL_MS_DEFAULT
    this.closeBudgetMs = options.closeBudgetMs ?? CLOSE_BUDGET_MS_DEFAULT
    this.openStream = options.openStream ?? ((path) => createWriteStream(path, { flags: 'a' }))
    // **作れなければここで投げる。** 黙って保存せずに走るのがいちばん悪い
    // （基板は送っていて、震度も出ていて、生だけが残っていない状態に外から気づけない）。
    mkdirSync(this.dir, { recursive: true })
  }

  /** 流し口が壊れた回数。**本ごとなので、失ったパケットの件数とは別**（次の欄）。 */
  get writeErrors(): number {
    return this.writeErrorCount
  }

  /**
   * 書き出せずに失ったパケットの件数。
   *
   * **流し口が壊れた回数では代わりにならない。** 壊れた瞬間に溜まっていた分はまとめて失われ、
   * しかもそれらは既に「保存できた」として返したあと（実測: 3 件を積んだところで開けなくなると、
   * 3 件とも書き込みのコールバックがエラーを受け、流し口の異常は 1 回しか立たない）。
   *
   * **送信元では分けない。** 壊れるのは書き出す先であって、送り手ごとの事情ではない。
   */
  get lostRecords(): number {
    return this.lostCount
  }

  /**
   * 書き出しは済んだのに、閉じ終わるのを待ちきれなかった回数。
   *
   * **「壊れた」と混ぜない。** こちらは**1 件も失っていない** —— 混ぜると、閉じるのが遅い
   * 記憶装置で日をまたぐたびに「流し口が壊れた」という誤報が積み上がり、本物の異常が埋もれる。
   * 増え続けるなら書き出す先が弱っている合図。
   */
  get slowCloses(): number {
    return this.slowCloseCount
  }

  /** 直近の書き込みの失敗の文面。**掃き取りの失敗とは分ける**（混ぜると別系統の理由が紛れ込む）。 */
  get lastWriteError(): string | null {
    return this.lastWriteErrorText
  }

  /** 直近の掃き取り（走査・圧縮・後始末）の失敗の文面。 */
  get lastSweepError(): string | null {
    return this.lastSweepErrorText
  }

  /** gzip した本数。 */
  get compressed(): number {
    return this.compressedCount
  }

  /** gzip できなかった本数。**素のまま残っているので中身は失われていない。** */
  get compressFailures(): number {
    return this.compressFailureCount
  }

  /**
   * 圧縮は済んだのに元を消せなかった回数。
   *
   * **「圧縮できなかった」と混ぜない。** あちらは作り直しが要るが、こちらは消すことだけ
   * もう一度試せばよい。混ぜると次の掃き取りが同じ中身を圧縮し直し、**埋めまいとしていた
   * ディスクを自分で埋める**。掃き取りのたびに試すので、直るまで数は増え続ける。
   */
  get leftovers(): number {
    return this.leftoverCount
  }

  /**
   * 置き場所そのものを読めなかった回数。
   *
   * **圧縮の失敗（`compressFailures`）とは別に持つ。** あちらは 1 本ずつの結果だが、
   * こちらは「そこに何本あったかも判らない」—— 混ぜると 1 件の異常が 1 本の失敗に見え、
   * ディスクが外れたような重い事象ほど軽く読める。
   */
  get listFailures(): number {
    return this.listFailureCount
  }

  /**
   * 同じ日の `.gz` と中身が食い違い、別名へ逃がした本の数。
   *
   * **時計が戻った印。** 逃がすこと自体は成功（上書きは削除と同じなので逃がすのが正しい）
   * だが、日付でファイルを分ける前提が揺らいでいる合図なので、件数として残す。
   */
  get escaped(): number {
    return this.escapedCount
  }

  /**
   * 開いたまま閉じていない本の数。**締めたあとは 0、動いている間は 1。**
   *
   * 閉じ忘れは中身の欠けとしては現れない（流し口は放っておいても書き出す）ので、
   * **開いたファイルの数としてしか観測できない**。日をまたぐたびに 1 つ漏れる形は、
   * 1 年動かして初めて上限に触れる —— そのときには原因を辿れない。
   */
  get openFiles(): number {
    return this.books.size
  }

  /**
   * 締めくくりに入ってから長く閉じ終わらない本の数。**閉じ忘れの印。**
   *
   * **「開いたままの本が 2 冊ある」では代用しない。** 日が変わる瞬間は新旧 2 冊が数秒
   * 共存するのが正常で、数だけを見ると毎日その瞬間に誤報が出る。かといって「2 回続けて
   * 2 冊に見えた」で代用すると、無関係な単発の事象が 2 つ続いただけでも鳴る —— 知りたい
   * のは冊数でも観測の回数でもなく、**同じ本が閉じ終わらずに居座っていること**。
   */
  get stuckBooks(): number {
    const now = this.now()
    let n = 0
    for (const book of this.books) {
      const since = stuckSince(book.retiredAtMs, book.progressAtMs)
      if (since !== null && now - since > STUCK_AFTER_MS) n += 1
    }
    return n
  }

  /**
   * 締めくくりの最中の本が、まだ書き出せずに抱えている件数。
   *
   * **締めくくりを打ち切っても正しく読める。** 失った件数（`lostRecords`）は締め終わって
   * 初めて確定するので、上限で切り上げるとその加算が間に合わない —— この値は集合から
   * 毎回引くので、**どの時点で読んでも取りこぼさない**。
   *
   * 平時は 0。締め終われば本が集合から外れ、確定した分は `lostRecords` へ移る。
   */
  get recordsAtRisk(): number {
    let n = 0
    for (const book of this.books) {
      if (!book.retiring) continue
      // 手放すと決まっていればその値、まだなら**いま抱えている分**（最善の見積もり）。
      n += book.abandonedAt ?? book.queued
    }
    return n
  }

  /**
   * 締めくくりを上限で打ち切ったか。**打ち切ったなら `openFiles` は 0 に戻っていない。**
   *
   * 打ち切ること自体は正しい（終わらないより出して終わるほうがまし）が、黙って打ち切ると
   * 「全部片付けて終わった」のと見分けが付かない。
   */
  get cutShort(): boolean {
    return this.cutShortFlag
  }

  /** いま書いている日（`YYYY-MM-DD`・日本時間）。まだ 1 件も書いていなければ `null`。 */
  get currentDay(): string | null {
    return this.day
  }

  write(source: string, payload: string): RawWriteResult {
    if (this.closed) return { saved: false, reason: 'closed' }

    const raw = this.now()
    const nowMs = this.advanceClock(raw)
    const day = jstDay(nowMs)
    // **名前を決められない日では回さない。**
    //
    // **この枝は実行時には通らない**（変異テストで確かめた）。`advanceClock` は一度でも
    // 読めれば以後 `null` を返さないので、`day` が `null` なのは一度も時計を読めていない
    // ときだけ —— そのとき `this.day` も `null` なので、どちらにせよ回らない。
    // **それでも残すのは型の絞り込みだから** ——`rotate` は本の名前が要るので `string` しか
    // 受けず、外すとコンパイルが通らない。`advanceClock` の手当てを変えたときに
    // 「名前の無い本へ切り替える」形を、ここが止める。
    if (day !== null && day !== this.day) this.rotate(day)

    const file = this.openFile(day)
    if (file === null) return { saved: false, reason: 'no-stream' }

    // **生の中身は JSON 文字列として丸ごと入れる。** パケットは複数行なので、そのまま繋ぐと
    // 区切りが判らなくなる。ヘッダの `c` から数えれば追えるが、**いちばん残したい壊れたパケットでは
    // それが効かない**。嵩は 1 件あたり 125 バイト増える（実測）。
    //
    // **封筒へ入れるのは生の値。** 帳簿（回転・開き直しの間隔）は最後に読めた時刻で代用するが、
    // 記録へそれを書くと**古い時刻が本物の受信時刻の顔をして残る**。判らなかったことは
    // `null` としてそのまま残す。
    const line = `${JSON.stringify({ rx: Number.isFinite(raw) ? raw : null, src: source, raw: payload })}\n`
    const bytes = Buffer.byteLength(line)
    if (file.pending + bytes > this.maxPendingBytes) {
      return { saved: false, reason: 'backpressure' }
    }

    file.pending += bytes
    file.queued += 1
    try {
      // 控えは**その本の**残量から引く。回したあとに古い本の控えが届いても、新しい本を汚さない。
      file.stream.write(line, (error) => {
        file.pending -= bytes
        file.queued -= 1
        // **手放した本の分は手放す側で数えてある。** ここでも数えると二重になる。
        if (file.abandoned) return
        // **書き込みの失敗は投げずにここへ返る。** 読み捨てると、この 1 件は
        // 「保存できた」という顔のまま消える —— 同期の失敗と違って、呼び出し側は既に
        // `saved: true` を受け取っている。流し口の異常のほうは 1 回しか進まないので、
        // 失った件数の代わりにならない。
        if (error !== null && error !== undefined) {
          this.lostCount += 1
          this.lastWriteErrorText = messageOf(error)
        }
      })
    } catch (error) {
      file.pending -= bytes
      // **手放すのが先。** 件数を先に減らすと、いま失敗したこの 1 件だけが、
      // 手放す側の勘定（`abandoned`）にも書き込みのコールバック（同期で投げたので
      // 呼ばれない）にも入らず、**どこにも数えられないまま消える**。
      this.failFile(error)
      file.queued -= 1
      return { saved: false, reason: 'write-failed' }
    }
    return { saved: true }
  }

  /**
   * 古くなった本を gzip する。**今日と昨日は素のまま**（取ったばかりの記録を `grep` や `tail` で触れる）。
   *
   * 二重に走らせない。走っている最中に呼ばれたら、その 1 本を待たせる。
   */
  sweep(): Promise<void> {
    const running = this.sweeping
    if (running !== null) return running
    const started = this.runSweep().finally(() => {
      this.sweeping = null
    })
    this.sweeping = started
    return started
  }

  /**
   * 締める。**書いた分を取りこぼさない** —— 流し切るまで待つ。
   *
   * **ただし待ち続けない**（`CLOSE_BUDGET_MS_DEFAULT`）。打ち切ったことは `cutShort` に残る。
   */
  async close(): Promise<void> {
    this.closed = true
    const file = this.file
    this.file = null
    if (file !== null) this.retire(file, false)
    const budget = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.cutShortFlag = true
        resolve()
      }, this.closeBudgetMs)
      timer.unref()
    })
    await Promise.race([this.finishClosing(), budget])
  }

  private async finishClosing(): Promise<void> {
    await Promise.all([...this.closing])
    // **掃き取りの途中で抜けない。** `.gz.tmp` を残したまま終えると、次の起動が
    // 中途半端なファイルを見ることになる（上限で打ち切られたときだけは残りうる。
    // 次の掃き取りが同じ名前へ書き直すので溜まりはしない）。
    await this.sweeping
  }

  /**
   * 帳簿に使う時刻。**戻せない値では進めない。**
   *
   * 非有限を素通りさせると `NaN < reopenAtMs` が**偽**になり、以後パケットごとに開き直しを試みる
   * ＝**間隔そのものが黙って効かなくなる**（`sourceRateLimit` と `logThrottle` で踏んだのと同じ形）。
   *
   * まだ一度も読めていなければ `NaN` を返す。日の名前を決められないので、呼び出し側は
   * 本を開かない側へ倒れる。
   */
  private advanceClock(raw: number): number {
    if (Number.isFinite(raw)) {
      this.lastMs = raw
      return raw
    }
    return this.lastMs ?? Number.NaN
  }

  private rotate(day: string): void {
    const old = this.file
    this.file = null
    this.day = day
    if (old !== null) this.retire(old, false)
    // **待たない。** 圧縮に数十秒かかることがあり、その間パケットを取りこぼす。
    void this.sweep()
  }

  /**
   * 本を手放す唯一の口。
   *
   * **ここを通さない経路を作らないこと。** 通さないと締めくくりの待ち合わせから漏れ、
   * 開いた本の数も失った件数も合わなくなる（それぞれ別の巡のレビューで指摘された）。
   */
  private retire(file: OpenFile, broken: boolean): void {
    file.retiring = true
    file.retiredAtMs = this.now()
    const done = releaseStream(file, this.closeStallMs, broken, this.now).then((outcome) => {
      this.books.delete(file)
      this.lostCount += outcome.abandoned
      if (outcome.slowClose) this.slowCloseCount += 1
      if (outcome.error === null) return
      this.writeErrorCount += 1
      this.lastWriteErrorText = messageOf(outcome.error)
    })
    this.closing.add(done)
    void done.finally(() => this.closing.delete(done))
  }

  private openFile(day: string | null): OpenFile | null {
    if (this.file !== null) return this.file
    const target = day ?? this.day
    // 時計が壊れたまま 1 件目が来た＝名前を決められない。
    if (target === null) return null
    this.day = target
    if ((this.lastMs ?? 0) < this.reopenAtMs) return null

    try {
      const stream = this.openStream(join(this.dir, `raw-${target}.ndjson`))
      const file: OpenFile = {
        stream,
        pending: 0,
        queued: 0,
        abandoned: false,
        retiring: false,
        abandonedAt: null,
        retiredAtMs: null,
        progressAtMs: null,
      }
      stream.on('error', (error: Error) => this.failFile(error))
      this.file = file
      this.books.add(file)
      return file
    } catch (error) {
      this.failFile(error)
      return null
    }
  }

  private failFile(error: unknown): void {
    this.writeErrorCount += 1
    this.lastWriteErrorText = messageOf(error)
    const file = this.file
    this.file = null
    this.reopenAtMs = (this.lastMs ?? 0) + this.reopenIntervalMs
    if (file === null) return
    // **直に捨てない。** 手放すのは 1 つの口から —— 直に捨てていたときは締めくくりの
    // 待ち合わせから漏れ、溜まっていた分の勘定が終わる前にプロセスが終わっていた。
    this.retire(file, true)
  }

  private async runSweep(): Promise<void> {
    const now = this.advanceClock(this.now())
    // 今日が判らなければ「昨日」も決まらない。**判らないまま消しにかからない。**
    if (jstDay(now) === null) return
    const keepFrom = jstDay(now - DAY_MS)
    if (keepFrom === null) return

    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch (error) {
      // **圧縮の失敗と混ぜない。** あちらは 1 本ずつの結果で、こちらは「置き場所ごと
      // 読めない」—— 1 件と数えても、失った対象が 0 本か数百本かは判らない。
      this.listFailureCount += 1
      this.lastSweepErrorText = messageOf(error)
      return
    }

    for (const name of names) {
      const matched = DAY_FILE_RE.exec(name)
      if (matched === null) continue
      const day = matched[1]
      if (day === undefined || day >= keepFrom) continue
      await this.compress(join(this.dir, name), day)
    }
  }

  private async compress(source: string, day: string): Promise<void> {
    // **数えるのは成功した後。** このファイルのカウンタは「起きたことの件数」なので、
    // 試みた時点で増やすと、失敗しても増える。ここは成功の経路が 1 つに集まるよう、
    // 途中で分かったことは印として持ち回り、最後にまとめて数える。
    let escaped = false
    const settled = `${join(this.dir, `raw-${day}.ndjson`)}.gz`
    if (existsSync(settled)) {
      // **同じ日の `.gz` が既にある。** 理由は 2 通り —— ①前回、圧縮まで済んで元を消せなかった
      // ②時計が戻って別の中身が溜まった。**中身を照らさないと見分けられない。**
      // 見分けずに作り直すと、①のとき同じ中身の `.gz` が掃き取りのたびに増え、
      // **埋めまいとしていたディスクを自分で埋める**（99 本まで）。
      let same: boolean
      try {
        same = await sameContent(source, settled)
      } catch (error) {
        this.compressFailureCount += 1
        this.lastSweepErrorText = messageOf(error)
        return
      }
      if (same) {
        // ①。圧縮は前回数えてある。**残りの後始末だけ試す。**
        this.removeCompressed(source)
        return
      }
      // **既に逃がしてあるかも見る。** 元を消せなかった場合、次の掃き取りでも
      // `settled` との食い違いは残ったまま —— そこで作り直すと、同じ中身の `.N.gz` が
      // 掃き取りのたびに増え、**1 回の時計の狂いが毎日起きているように見える**。
      if (await this.alreadyEscaped(source, day)) {
        this.removeCompressed(source)
        return
      }
      // ②。**逃がすのはこの後。** ここで数えると、逃がせなかったとき（ディスクが満杯・
      // 逃がし先が埋まっている）も「逃がしてある」と主張することになる。しかも元の
      // ファイルは消えないので**翌日以降のたびに同じ食い違いを検出し、1 回の時計の狂いが
      // 毎日積み上がって見える**。数えるのは成功した後（下）。
      escaped = true
    }

    const dest = this.freeGzPath(day)
    if (dest === null) {
      this.compressFailureCount += 1
      this.lastSweepErrorText = `${day} の圧縮先が ${MAX_GZ_VARIANTS} 本とも埋まっている`
      return
    }
    const temp = `${dest}.tmp`
    try {
      // **書き切って改名してから元を消す。** 途中で落ちても、完成した `.gz` が無い限り
      // 素のファイルは残る。
      await pipeline(createReadStream(source), createGzip(), createWriteStream(temp))
      renameSync(temp, dest)
    } catch (error) {
      this.compressFailureCount += 1
      this.lastSweepErrorText = messageOf(error)
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {
        // 書きかけを片付けられなくても、圧縮できなかったこと自体は数えてある。
      }
      return
    }
    this.compressedCount += 1
    // **`.2.gz` が出来たことをここで確定する。** 元の削除はまだ試していない —— 次の行が
    // 別に試み、失敗すれば `leftovers` 側に残る。**`escaped` と `leftovers` は同時に増えうる。**
    if (escaped) this.escapedCount += 1
    // **消すのは別に数える。** ここが失敗しても圧縮そのものは済んでいる。
    this.removeCompressed(source)
  }

  private removeCompressed(source: string): void {
    try {
      unlinkSync(source)
    } catch (error) {
      this.leftoverCount += 1
      this.lastSweepErrorText = messageOf(error)
    }
  }

  /**
   * 既に別名へ逃がしてある本か。
   *
   * **逃がした先は 1 本とは限らない**（`.2.gz` 〜 `.99.gz`）ので、順に中身を照らす。
   * 読めないものは「違う」として扱う —— 壊れた `.gz` を「同じ」と答えると、
   * まだ逃がせていない中身を消すことになる。
   */
  private async alreadyEscaped(source: string, day: string): Promise<boolean> {
    const base = join(this.dir, `raw-${day}.ndjson`)
    // **元の指紋は 1 回だけ取る。** 候補ごとに `sameContent` を呼ぶと、その日の生ファイルを
    // 候補の数だけ読み直すことになる（最大 98 回）。読むのは 1 度で足りる。
    let want: string
    try {
      want = await digestOf(source, false)
    } catch {
      // **ここへは通常来ない。** 呼び出し元が直前に `sameContent(source, settled)` で
      // 同じファイルを同じ読み方で通しているので、そこが成功していれば失敗しようがない
      // （来るとすれば、そのあいだに元が消えた場合）。**変異テストで落ちないのはそのため。**
      // 読めないなら照らしようがないので、逃がす側の判断（作り直す）へ倒す。
      return false
    }
    for (let i = 2; i <= MAX_GZ_VARIANTS; i += 1) {
      const path = `${base}.${i}.gz`
      // **欠番で打ち切らない。** 番号を詰めて使うのはこちらの都合で、`.N.gz` は掃除の
      // スクリプトなど外から消されうる —— 途中が消えていたとき打ち切ると、その先に
      // 残っている同じ中身を見落とし、**防ごうとした重複をかえって作る**。
      if (!existsSync(path)) continue
      try {
        if ((await digestOf(path, true)) === want) return true
      } catch {
        // 読めない `.gz` は照合の相手にしない。次を見る。
      }
    }
    return false
  }

  /**
   * まだ使われていない `.gz` の名前。
   *
   * **既にある `.gz` を上書きしない。** 上書きは削除と同じで、「消さない」に反する。
   */
  private freeGzPath(day: string): string | null {
    const base = join(this.dir, `raw-${day}.ndjson`)
    if (!existsSync(`${base}.gz`)) return `${base}.gz`
    for (let n = 2; n <= MAX_GZ_VARIANTS; n += 1) {
      const candidate = `${base}.${n}.gz`
      if (!existsSync(candidate)) return candidate
    }
    return null
  }
}
