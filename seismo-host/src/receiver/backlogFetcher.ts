// 欠けた範囲を基板へ取りに行き、取り戻した分を生データの記録（miniSEED）へ渡す。
//
// **取り戻した分は記録にだけ回す。** 震度・観測点の合成・押し出し・時計のずれの推定・
// 速度の上限のどれにも通さない —— どれも「いま届いたもの」を前提に組んであり、
// 数十秒〜数分前のまとまりを混ぜると、区間が切れたり（`segmenter.ts` は番号の戻りを
// 再起動と読みうる）、時計が遅れて見えたり（`boardClock.ts` は届くまでの時間の最小値を取る）する。
// 画面に出たものは取り戻せないが、§9 の「後から再解析できる RAW」は埋まる。
//
// **1 枚の基板には 1 度に 1 件だけ訊く。** 基板の HTTP は `loop()` と同じ流れで答えるので、応答を
// 作っている間はセンサーの吸い出しも止まる（ファームの `BACKLOG_MAX_PER_REPLY`）。重ねて訊くと待たせる
// 時間が足し算になる。訊く合間（`spacingMs`）も基板ごとに置く。
//
// **別の基板へは並行して訊く。** 止まるのは答えている基板だけなので、待つ理由が無い。全体で 1 件に
// していたときは、1 枚の時間切れ（`timeoutMs`）が残りの基板の取り戻しまで止めていた —— 2026-10-06 の
// 電子レンジの干渉では 1 分に 10〜16 回の時間切れで 30〜48 秒が潰れ、欠けのできる速さ（3 枚で
// 1 分に約 250 件）に追いつけずに、基板のメモリの輪から落ちていった。
//
// **近い欠けはまとめて訊く**（`BacklogBook.nextDueWhere`）。範囲に挟まる受信済みの分も基板は返すので、
// 欠けに掛からないパケットは書かずに捨てる（生データに同じまとまりを二度入れない）。
//
// **投げない。** 取り戻しは本筋（受信・震度・保存）の脇役なので、ここが失敗しても本筋を止めない。
// 失敗は数えて `snapshot` に出し、`onEvent` で呼び出し側へ知らせる。

import { parseSensorPacket } from '../protocol/parsePacket'
import type { BacklogBook, BacklogSnapshot, Gap, UnrecoverableReason } from './backlogBook'

/** 取りに行った応答。`fetch` の `Response` から要るものだけを抜いた形（テストで差し替えるため）。 */
export interface BacklogHttpResponse {
  readonly status: number
  header(name: string): string | null
  text(): Promise<string>
}

export type BacklogHttpGet = (url: string, timeoutMs: number) => Promise<BacklogHttpResponse>

/** `fetch` で取りに行く。**時間切れは本文の読み終わりまで含む**（`signal` を `text()` も共有する）。 */
export const fetchBacklog: BacklogHttpGet = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return { status: res.status, header: (name) => res.headers.get(name), text: () => res.text() }
}

/** 取りに行って失敗した理由。**取り戻せなかった（`UnrecoverableReason`）とは別** —— こちらは訊き直す。 */
export type BacklogFailure =
  /** 繋がらない・時間切れ・本文を読み切れない。 */
  | 'network'
  /** 見出し（`X-Backlog-Have`・`X-Backlog-More`）が読めない。 */
  | 'bad-reply'
  /** こちらの不具合（`step` が投げた）。**来ない作り**だが、来たら黙らせない。 */
  | 'internal'
  | `http-${number}`

export type BacklogEvent =
  | {
      readonly kind: 'recovered'
      readonly key: string
      readonly address: string
      readonly packets: number
      readonly samples: number
      /**
       * 取り戻したまとまりの波形の時刻の範囲 `[fromMs, toMs)`（基板の時計）。**合成波形の作り直しが
       * 区間を決めるのに使う**（`rewaveScheduler.ts`）。
       */
      readonly fromMs: number
      readonly toMs: number
    }
  | { readonly kind: 'unrecoverable'; readonly key: string; readonly address: string; readonly reason: UnrecoverableReason; readonly samples: number }
  /**
   * 答えに使えないまとまりが混ざった（読めない・別の流れを名乗る）。
   * **欠けには残して訊き直す**ので取り戻しは止まらないが、同じ基板が毎回そう答えるなら
   * 取り戻せないまま諦めに行き着く —— その前に行で知らせる。
   */
  | {
      readonly kind: 'suspect'
      readonly key: string
      readonly address: string
      readonly badPackets: number
      readonly foreignPackets: number
    }
  /**
   * 取り戻したまとまりを生データへ書き終えられなかった。**欠けには残して、間を空けて訊き直す**
   * （ディスクの側の事情なので、続けて訊いても同じく書けない）。
   */
  | { readonly kind: 'unsaved'; readonly key: string; readonly address: string; readonly packets: number }
  | { readonly kind: 'failed'; readonly key: string; readonly address: string; readonly reason: BacklogFailure; readonly detail: string }

export interface BacklogFetcherOptions {
  readonly book: BacklogBook
  readonly get: BacklogHttpGet
  /**
   * 取り戻したパケットを生データの記録へ渡す（`MseedRecorder.acceptRecovered`）。
   * **ディスクへ書き終えたら true。書けた分だけ欠けから外す** —— false の分は欠けに残し、
   * 基板がまだ抱えていれば訊き直して取り直す。**拒否しないこと。**
   * 待つのは `timeoutMs` まで（流し口が詰まって知らせが来ない形を、書けなかったとみなす）。
   */
  readonly keepRecovered: (source: string, payload: string) => Promise<boolean>
  readonly now: () => number
  /**
   * 1 回の問い合わせの時間切れ（本文を読み終えるまで）。取り戻した 1 まとまりの書き終わりを
   * 待つ上限にも使う（`keepRecovered`）。
   */
  readonly timeoutMs: number
  /** 訊いた後、次に訊くまで空ける時間。 */
  readonly spacingMs: number
  /** 訊くものが無いとき、次に見るまで空ける時間。 */
  readonly idleMs: number
  readonly onEvent: (event: BacklogEvent) => void
}

export interface BacklogFetcherSnapshot extends BacklogSnapshot {
  readonly requests: number
  readonly recoveredPackets: number
  /** 理由ごとの失敗の回数（訊き直したもの）。**0 の理由は載せない。** */
  readonly failures: Partial<Record<BacklogFailure, number>>
  /** 読み取りに通らなかったパケットの数。 */
  readonly badPackets: number
  /** 訊いた流れと違う基板・起動・センサーを名乗ったパケットの数。 */
  readonly foreignPackets: number
  /** 取り戻したのに生データへ書き終えられず、欠けに残したパケットの数（訊き直した回も数える）。 */
  readonly unsavedPackets: number
  /**
   * 答えに入っていたが、もう欠けに掛からないので書かずに捨てたパケットの数。近い欠けをまとめて
   * 訊くと、間に挟まる受信済みの分も返ってくる。**取り戻した数に比べてこれが多すぎるなら、
   * まとめる長さ（`maxSpanSamples`）が欠けの散らばり方に合っていない。**
   */
  readonly skippedPackets: number
  /**
   * 書き終わりを待ちきれなかった書き込みが、決着しないまま残っていればその時刻（待ちきれなかった時点）。
   * **残っている間は取り戻しを止めている**（`inflight`）。無ければ `null`。
   */
  readonly unsettledWriteSinceMs: number | null
}

/**
 * 応答の本文をパケットへ切り分ける。**ヘッダ（`{` で始まる行）が来るたびに次のパケット。**
 * 中身は送ったときの形のまま返す（行末の改行も含めて）—— 届いたパケットと同じ読み取りに
 * 通せるように。
 */
export function splitBacklogPackets(body: string): string[] {
  const out: string[] = []
  let current = ''
  for (const line of body.split('\n')) {
    if (line.startsWith('{')) {
      if (current !== '') out.push(current)
      current = `${line}\n`
    } else if (line !== '' && current !== '') {
      current += `${line}\n`
    }
  }
  if (current !== '') out.push(current)
  return out
}

/** `X-Backlog-Have` を読む。`none` か `<from>-<to>`。**読めなければ undefined**（失敗として扱う）。 */
function parseHave(text: string | null): { from: number; to: number } | 'none' | undefined {
  if (text === null) return undefined
  if (text === 'none') return 'none'
  const m = /^(\d{1,10})-(\d{1,10})$/.exec(text)
  if (m === null) return undefined
  const from = Number(m[1])
  const to = Number(m[2])
  if (from > 0xffff_ffff || to > 0xffff_ffff) return undefined
  return { from, to }
}

/** パケットの波形が覆う時刻 `[fromMs, toMs)`（公称の刻みで）。 */
function packetSpan(p: { readonly firstSampleMs: number; readonly sampleRateHz: number; readonly samples: { readonly length: number } }): {
  readonly fromMs: number
  readonly toMs: number
} {
  const ms = p.sampleRateHz > 0 ? 1000 / p.sampleRateHz : 0
  return { fromMs: p.firstSampleMs, toMs: p.firstSampleMs + p.samples.length * ms }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class BacklogFetcher {
  private readonly options: BacklogFetcherOptions
  private requests = 0
  private recoveredPackets = 0
  private badPackets = 0
  private foreignPackets = 0
  private unsavedPackets = 0
  private skippedPackets = 0
  private readonly failures = new Map<BacklogFailure, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  /** いま訊いている（または訊いた後の合間を置いている）基板。**1 枚に 1 件まで。** */
  private readonly busy = new Set<string>()
  /** 走っている問い合わせ。止めるときに待つ。 */
  private readonly running = new Set<Promise<void>>()
  private stopped = false
  /**
   * 時間切れまでに決着しなかった書き込み。**決着するまで次を訊かない** —— 書き込みは時間切れで
   * 止まらず裏で続くので、訊き直して同じまとまりを書くと、遅れて成功した分と二重に残る
   * （読み手は受信の記録に載った回数だけパケットを組む。`mseedPacketReader.ts`）。
   *
   * **知らせが来ない限り、取り戻しは止まったまま**になる（全ての基板の分を止める —— 詰まって
   * いるのは基板ではなくディスクなので、別の基板へ訊いても同じく書けない）。上限で見切って訊き直すと、
   * 上の二重書きを自分で作る。**止めていることは `unsettledWriteSinceMs` で外へ出す** —— 詰まったのが過去の
   * 時の本だけなら、届いた分の保存（いまの時の本）は失わないので、ほかに見える印が無い。
   * 流し口が壊れれば Node が書きかけの分へ失敗を知らせるので、そこで解ける。
   */
  private readonly inflight = new Map<Promise<void>, number>()

  constructor(options: BacklogFetcherOptions) {
    this.options = options
  }

  /** 定期的に取りに行き始める。 */
  start(): void {
    this.stopped = false
    this.schedule(this.options.idleMs)
  }

  /**
   * 止める。**いま訊いている分は待つ**（基板ごとに 1 件ずつ並行しているので、全部。書きかけのまま
   * 終わらせない）。決着していない書き込みも `timeoutMs` までは待つ —— 遅れて成功した分を欠けから外して
   * から帳面を書き戻させる。訊き終えた直後の合間（`spacingMs`）に掛かっていれば、そのぶんも待つ。
   * いま訊いている分の中で書き込みを待ちきれなかった場合は、そこで `timeoutMs`、ここでもう
   * `timeoutMs` 待つので、最大でその 2 倍かかる。
   *
   * ここでも決着しなければ、そのまま返る（終了を止めない）。**その分は欠けに残ったまま帳面へ
   * 書き戻される** —— このあと生データを閉じると新しい書き込みを断るので、波形を遅れて書き終えても
   * 受信の記録が書けず、書けなかったとして決着する。次の起動で訊き直すので、同じまとまりの波形が
   * 2 度入りうる（再起動をまたぐ重複と同じ形。README「取り戻し」）。
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    await Promise.all([...this.running])
    if (this.inflight.size > 0) await this.within(Promise.all([...this.inflight.keys()]).then(() => true))
  }

  /**
   * 訊いていない基板の欠けを 1 件だけ処理する。**訊いたら true。** 決着していない書き込みがあれば訊かない。
   *
   * 並行して呼んでよい —— 呼ぶたびに別の基板を選ぶ（訊いている間、その基板は `busy` に入る）。
   */
  async step(): Promise<boolean> {
    const gap = this.claim()
    if (gap === null) return false
    try {
      await this.ask(gap)
    } finally {
      this.busy.delete(gap.stream.boardKey)
    }
    return true
  }

  /** 次に訊く欠けを選び、その基板を `busy` に入れる。無ければ null。 */
  private claim(): Gap | null {
    if (this.inflight.size > 0) return null
    const gap = this.options.book.nextDueWhere(this.options.now(), (s) => !this.busy.has(s.boardKey))
    if (gap === null) return null
    this.busy.add(gap.stream.boardKey)
    return gap
  }

  private async ask(gap: Gap): Promise<void> {
    const { book, now } = this.options
    this.requests += 1
    const url =
      `http://${gap.address}/backlog?sid=${encodeURIComponent(gap.stream.sensorId)}` +
      `&bid=${encodeURIComponent(gap.stream.bootId)}&from=${gap.from}&to=${gap.to}`

    let res: BacklogHttpResponse
    let body: string
    try {
      res = await this.options.get(url, this.options.timeoutMs)
      body = await res.text()
    } catch (error) {
      this.fail(gap, 'network', messageOf(error))
      return
    }

    // **再起動した基板・取り戻しの口を持たない基板には、訊き直しても答えは変わらない。**
    if (res.status === 410) {
      this.giveUp(gap, gap.from, gap.to, 'rebooted')
      return
    }
    if (res.status === 404 || res.status === 503) {
      this.giveUp(gap, gap.from, gap.to, 'unsupported')
      return
    }
    if (res.status !== 200) {
      this.fail(gap, `http-${res.status}`, body.slice(0, 120))
      return
    }
    const have = parseHave(res.header('X-Backlog-Have'))
    const more = res.header('X-Backlog-More')
    if (have === undefined || (more !== '0' && more !== '1')) {
      this.fail(gap, 'bad-reply', `X-Backlog-Have=${res.header('X-Backlog-Have')} X-Backlog-More=${more}`)
      return
    }

    // **生データへ書けた分だけ欠けから外す。** 読めない・別物・書けなかった分は欠けに残り、あとで訊き直す。
    let packets = 0
    let samples = 0
    let spanFrom = Number.POSITIVE_INFINITY
    let spanTo = Number.NEGATIVE_INFINITY
    let bad = 0
    let foreign = 0
    let unsaved = 0
    for (const text of splitBacklogPackets(body)) {
      const read = parseSensorPacket(text)
      if (!read.ok) {
        bad += 1
        continue
      }
      const p = read.packet
      if (p.boardKey !== gap.stream.boardKey || p.bootId !== gap.stream.bootId || p.sensorId !== gap.stream.sensorId) {
        foreign += 1
        continue
      }
      const to = (p.firstSeq + p.samples.length) % 0x1_0000_0000
      // **欠けに掛からないまとまりは書かない。** 近い欠けをまとめて訊くと、間に挟まる受信済みの分も
      // 返ってくる。書くと生データに同じまとまりが二度入る。
      // **半分だけ掛かるまとまりは丸ごと書く**（欠けは届いたまとまりの切れ目で作られ、基板が返すのも
      // 同じまとまりなので、普段は起きない。起きたら、掛かっていない側が生データに二度入る ——
      // 再起動をまたぐ重複と同じく `bid`・`sid`・`q` の組で見分けられる）。
      if (!book.overlapsGap(gap.key, p.firstSeq, to)) {
        this.skippedPackets += 1
        continue
      }
      // **1 まとまりでも書けなかったら、この答えの残りは書かずに欠けに残す。** ディスクが詰まって
      // いるときに書き続けても同じく書けず、待つ時間（1 まとまりにつき `timeoutMs`）が積み上がる。
      const span = packetSpan(p)
      if (unsaved > 0 || !(await this.keepWithin(gap, text, p.firstSeq, to, span))) {
        unsaved += 1
        continue
      }
      spanFrom = Math.min(spanFrom, span.fromMs)
      spanTo = Math.max(spanTo, span.toMs)
      packets += 1
      this.recoveredPackets += 1
      samples += book.recovered(gap.key, p.firstSeq, to)
    }
    if (packets > 0) {
      this.options.onEvent({ kind: 'recovered', key: gap.key, address: gap.address, packets, samples, fromMs: spanFrom, toMs: spanTo })
    }
    const unsure = bad + foreign > 0
    if (unsure) {
      this.badPackets += bad
      this.foreignPackets += foreign
      this.options.onEvent({ kind: 'suspect', key: gap.key, address: gap.address, badPackets: bad, foreignPackets: foreign })
    }
    if (unsaved > 0) {
      this.unsavedPackets += unsaved
      this.options.onEvent({ kind: 'unsaved', key: gap.key, address: gap.address, packets: unsaved })
    }

    // **基板がもう抱えていない分を決める。** 抱えている範囲より古い分は、輪が上書きした。
    if (have === 'none') {
      this.giveUp(gap, gap.from, gap.to, 'not-held')
    } else if (((have.from - gap.from) | 0) > 0) {
      const until = ((have.from - gap.to) | 0) < 0 ? have.from : gap.to
      this.giveUp(gap, gap.from, until, 'not-held')
    }
    if (unsaved > 0) {
      // **書けなかった分は、基板が持っていないのではない。** 答え切った応答（`more === '0'`）でも
      // 諦めに回さず、間を空けて訊き直す —— すぐ訊くと、詰まったディスクへ同じ失敗を重ねるだけ。
      book.failed(gap.key, gap.from, gap.to, now())
    } else if (more === '0') {
      // **訊いた範囲を答え切ったのに残った分は、基板が持っていない。** ただし答えに
      // 読めない・別物が混ざっていたら決めつけない（訊き直す）。
      if (unsure) book.failed(gap.key, gap.from, gap.to, now())
      else this.giveUp(gap, gap.from, gap.to, 'not-held')
    }
    // `more === '1'` なら残りはそのまま。取りに行ってよい時刻は過ぎているので、次の回にすぐ訊く。
  }

  snapshot(): BacklogFetcherSnapshot {
    const failures: Partial<Record<BacklogFailure, number>> = {}
    for (const [reason, n] of this.failures) if (n > 0) failures[reason] = n
    return {
      ...this.options.book.snapshot(),
      requests: this.requests,
      recoveredPackets: this.recoveredPackets,
      failures,
      badPackets: this.badPackets,
      foreignPackets: this.foreignPackets,
      unsavedPackets: this.unsavedPackets,
      skippedPackets: this.skippedPackets,
      unsettledWriteSinceMs: this.inflight.size === 0 ? null : Math.min(...this.inflight.values()),
    }
  }

  /**
   * 取り戻した 1 まとまり `[from, to)` を書き、`timeoutMs` までに書き終えたら true。
   *
   * **時間切れでも書き込みは止まらない**ので、決着を `inflight` に残す。遅れて成功したら、
   * そこでこのまとまりを欠けから外す（訊き直して二度書かない）。遅れて失敗したら欠けに残る。
   */
  private async keepWithin(
    gap: Gap,
    text: string,
    from: number,
    to: number,
    span: { readonly fromMs: number; readonly toMs: number },
  ): Promise<boolean> {
    // 拒否しない約束の口だが、型では縛れない。**来たら書けなかったとして扱う** —— 時間切れの前に
    // 来た拒否を素通しにすると、同じ答えの残りと欠けの扱い（`book.failed`）まで飛ばしてしまう。
    const write = this.options.keepRecovered(gap.address, text).catch(() => false)
    const result = await this.within(write)
    if (result !== 'timeout') return result
    const settled: Promise<void> = write
      .then((ok) => {
        if (!ok) return
        const samples = this.options.book.recovered(gap.key, from, to)
        this.recoveredPackets += 1
        this.options.onEvent({
          kind: 'recovered', key: gap.key, address: gap.address, packets: 1, samples, fromMs: span.fromMs, toMs: span.toMs,
        })
      })
      .catch(() => {
        // `book.recovered` や `onEvent` が投げても、`inflight` は必ず外す（下の finally）。
      })
      .finally(() => {
        this.inflight.delete(settled)
      })
    this.inflight.set(settled, this.options.now())
    return false
  }

  /** `timeoutMs` までに決着すればその値、しなければ `'timeout'`。 */
  private async within<T>(p: Promise<T>): Promise<T | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.options.timeoutMs)
    })
    try {
      return await Promise.race([p, timeout])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  private fail(gap: Gap, reason: BacklogFailure, detail: string): void {
    this.failures.set(reason, (this.failures.get(reason) ?? 0) + 1)
    this.options.book.failed(gap.key, gap.from, gap.to, this.options.now())
    this.options.onEvent({ kind: 'failed', key: gap.key, address: gap.address, reason, detail })
  }

  private giveUp(gap: Gap, from: number, to: number, reason: UnrecoverableReason): void {
    const samples = this.options.book.unrecoverable(gap.key, from, to, reason)
    if (samples > 0) {
      this.options.onEvent({ kind: 'unrecoverable', key: gap.key, address: gap.address, reason, samples })
    }
  }

  /** `delayMs` 後に `pump` を呼ぶ。張り直すと前の予約は捨てる。 */
  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, delayMs)
  }

  /**
   * 訊ける基板の分を全部走らせる。**1 件終わるたびに、その基板の合間を置いてから呼び直す。**
   * 訊くものが無くなったら `idleMs` 後にもう一度見る。
   */
  private pump(): void {
    if (this.stopped) return
    try {
      for (;;) {
        const gap = this.claim()
        if (gap === null) break
        const board = gap.stream.boardKey
        const job: Promise<void> = this.run(gap)
          .then(() => this.rest())
          .finally(() => {
            this.busy.delete(board)
            this.running.delete(job)
            this.pump()
          })
        this.running.add(job)
      }
    } catch (error) {
      // **ここへは来ない作り**（`claim` は配列をなめるだけ）。来たら数えて次の回へ回す ——
      // 素通しにすると、タイマーから呼ばれた回はプロセスごと落とし、ジョブの後始末から呼ばれた回は
      // `running` を拒否させて `stop()` まで投げさせる。
      this.noteInternal(error)
    }
    if (this.timer === null) this.schedule(this.options.idleMs)
  }

  /** 1 件訊く。**投げない**（投げたまま放ると、その基板が `busy` のまま残り二度と訊かれない）。 */
  private async run(gap: Gap): Promise<void> {
    try {
      await this.ask(gap)
    } catch (error) {
      // **ここへは来ない作り**（`ask` は外へ投げるものを持たない）。来たら数えて次の回へ回す。
      this.noteInternal(error)
    }
  }

  /** こちらの不具合を数えて知らせる。**投げない。** */
  private noteInternal(error: unknown): void {
    this.failures.set('internal', (this.failures.get('internal') ?? 0) + 1)
    // **知らせる口が投げても次の回を張る。** 投げた原因が `onEvent` そのもの（ログの書き出しの失敗）
    // なら、ここでもう一度呼ぶと同じく投げる —— `running` の拒否がプロセスごと落としうる。
    try {
      this.options.onEvent({ kind: 'failed', key: '', address: '', reason: 'internal', detail: messageOf(error) })
    } catch {
      // 数えてある（`failures.internal`）。毎分の要約がそれを出す。
    }
  }

  /** 訊いた基板に合間を置く。止めるときは待たない。 */
  private rest(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise((resolve) => setTimeout(resolve, this.options.spacingMs))
  }
}
