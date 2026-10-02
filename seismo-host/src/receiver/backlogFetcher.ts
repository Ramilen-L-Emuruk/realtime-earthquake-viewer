// 欠けた範囲を基板へ取りに行き、取り戻した分を生データの保存へ書く。
//
// **取り戻した分は記録にだけ回す。** 震度・観測点の合成・押し出し・時計のずれの推定・
// 速度の上限のどれにも通さない —— どれも「いま届いたもの」を前提に組んであり、
// 数十秒〜数分前のまとまりを混ぜると、区間が切れたり（`segmenter.ts` は番号の戻りを
// 再起動と読みうる）、時計が遅れて見えたり（`boardClock.ts` は届くまでの時間の最小値を取る）する。
// 画面に出たものは取り戻せないが、§9 の「後から再解析できる RAW」は埋まる。
//
// **1 度に 1 件だけ訊く。** 基板の HTTP は `loop()` と同じ流れで答えるので、応答を作っている間は
// センサーの吸い出しも止まる（ファームの `BACKLOG_MAX_PER_REPLY`）。重ねて訊くと待たせる時間が
// 足し算になる。訊く合間（`spacingMs`）も置く。
//
// **投げない。** 取り戻しは本筋（受信・震度・保存）の脇役なので、ここが失敗しても本筋を止めない。
// 失敗は数えて `snapshot` に出し、`onEvent` で呼び出し側へ知らせる。

import { parseSensorPacket } from '../protocol/parsePacket'
import type { BacklogBook, BacklogSnapshot, Gap, UnrecoverableReason } from './backlogBook'
import type { RawWriteResult } from './rawStore'

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
  | { readonly kind: 'recovered'; readonly key: string; readonly address: string; readonly packets: number; readonly samples: number }
  | { readonly kind: 'unrecoverable'; readonly key: string; readonly address: string; readonly reason: UnrecoverableReason; readonly samples: number }
  /**
   * 答えに使えないまとまりが混ざった（読めない・別の流れを名乗る・生データへ書けない）。
   * **欠けには残して訊き直す**ので取り戻しは止まらないが、同じ基板が毎回そう答えるなら
   * 取り戻せないまま諦めに行き着く —— その前に行で知らせる。
   */
  | {
      readonly kind: 'suspect'
      readonly key: string
      readonly address: string
      readonly badPackets: number
      readonly foreignPackets: number
      readonly rawUnsaved: number
    }
  | { readonly kind: 'failed'; readonly key: string; readonly address: string; readonly reason: BacklogFailure; readonly detail: string }

export interface BacklogFetcherOptions {
  readonly book: BacklogBook
  readonly get: BacklogHttpGet
  /** 取り戻したパケットを生データへ書く（`RawStore.writeRecovered`）。 */
  readonly writeRecovered: (source: string, payload: string) => RawWriteResult
  readonly now: () => number
  /** 1 回の問い合わせの時間切れ（本文を読み終えるまで）。 */
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
  /** 取り戻したのに生データへ書けなかったパケットの数（欠けに残して訊き直す）。 */
  readonly rawUnsaved: number
  /** 読み取りに通らなかったパケットの数。 */
  readonly badPackets: number
  /** 訊いた流れと違う基板・起動・センサーを名乗ったパケットの数。 */
  readonly foreignPackets: number
}

/**
 * 応答の本文をパケットへ切り分ける。**ヘッダ（`{` で始まる行）が来るたびに次のパケット。**
 * 中身は送ったときの形のまま返す（行末の改行も含めて）—— 生データでは、同じまとまりが
 * 2 度届いたことを中身の一致で見分けるため。
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class BacklogFetcher {
  private readonly options: BacklogFetcherOptions
  private requests = 0
  private recoveredPackets = 0
  private rawUnsaved = 0
  private badPackets = 0
  private foreignPackets = 0
  private readonly failures = new Map<BacklogFailure, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private stopped = false

  constructor(options: BacklogFetcherOptions) {
    this.options = options
  }

  /** 定期的に取りに行き始める。 */
  start(): void {
    this.stopped = false
    this.schedule(this.options.idleMs)
  }

  /** 止める。**いま訊いている 1 件は待つ**（書きかけのまま終わらせない）。 */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.running !== null) await this.running
  }

  /** 訊くべき欠けを 1 件だけ処理する。**訊いたら true。** */
  async step(): Promise<boolean> {
    const { book, now } = this.options
    const gap = book.nextDue(now())
    if (gap === null) return false
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
      return true
    }

    // **再起動した基板・取り戻しの口を持たない基板には、訊き直しても答えは変わらない。**
    if (res.status === 410) {
      this.giveUp(gap, gap.from, gap.to, 'rebooted')
      return true
    }
    if (res.status === 404 || res.status === 503) {
      this.giveUp(gap, gap.from, gap.to, 'unsupported')
      return true
    }
    if (res.status !== 200) {
      this.fail(gap, `http-${res.status}`, body.slice(0, 120))
      return true
    }
    const have = parseHave(res.header('X-Backlog-Have'))
    const more = res.header('X-Backlog-More')
    if (have === undefined || (more !== '0' && more !== '1')) {
      this.fail(gap, 'bad-reply', `X-Backlog-Have=${res.header('X-Backlog-Have')} X-Backlog-More=${more}`)
      return true
    }

    // **書けた分だけ欠けから外す。** 書けなかった分は欠けに残り、あとで訊き直す。
    let packets = 0
    let samples = 0
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
      const saved = this.options.writeRecovered(gap.address, text)
      if (!saved.saved) {
        unsaved += 1
        continue
      }
      packets += 1
      this.recoveredPackets += 1
      samples += book.recovered(gap.key, p.firstSeq, (p.firstSeq + p.samples.length) % 0x1_0000_0000)
    }
    if (packets > 0) {
      this.options.onEvent({ kind: 'recovered', key: gap.key, address: gap.address, packets, samples })
    }
    const unsure = bad + foreign + unsaved > 0
    if (unsure) {
      this.badPackets += bad
      this.foreignPackets += foreign
      this.rawUnsaved += unsaved
      this.options.onEvent({
        kind: 'suspect', key: gap.key, address: gap.address, badPackets: bad, foreignPackets: foreign, rawUnsaved: unsaved,
      })
    }

    // **基板がもう抱えていない分を決める。** 抱えている範囲より古い分は、輪が上書きした。
    if (have === 'none') {
      this.giveUp(gap, gap.from, gap.to, 'not-held')
    } else if (((have.from - gap.from) | 0) > 0) {
      const until = ((have.from - gap.to) | 0) < 0 ? have.from : gap.to
      this.giveUp(gap, gap.from, until, 'not-held')
    }
    if (more === '0') {
      // **訊いた範囲を答え切ったのに残った分は、基板が持っていない。** ただし答えに
      // 読めない・別物・書けなかったものが混ざっていたら決めつけない（訊き直す）。
      if (unsure) book.failed(gap.key, gap.from, gap.to, now())
      else this.giveUp(gap, gap.from, gap.to, 'not-held')
    }
    // `more === '1'` なら残りはそのまま。取りに行ってよい時刻は過ぎているので、次の回にすぐ訊く。
    return true
  }

  snapshot(): BacklogFetcherSnapshot {
    const failures: Partial<Record<BacklogFailure, number>> = {}
    for (const [reason, n] of this.failures) if (n > 0) failures[reason] = n
    return {
      ...this.options.book.snapshot(),
      requests: this.requests,
      recoveredPackets: this.recoveredPackets,
      failures,
      rawUnsaved: this.rawUnsaved,
      badPackets: this.badPackets,
      foreignPackets: this.foreignPackets,
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

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.running = this.tick().finally(() => {
        this.running = null
      })
    }, delayMs)
  }

  private async tick(): Promise<void> {
    let did = false
    try {
      did = await this.step()
    } catch (error) {
      // **ここへは来ない作り**（`step` は外へ投げるものを持たない）。来たら数えて次の回へ回す ——
      // 投げたまま止めると、以後どの欠けも取りに行かれないまま黙る。
      this.failures.set('internal', (this.failures.get('internal') ?? 0) + 1)
      // **知らせる口が投げても次の回を張る。** `step` が投げた原因が `onEvent` そのもの
      // （ログの書き出しの失敗）なら、ここでもう一度呼ぶと同じく投げ、`schedule` まで届かずに
      // 取り戻しが止まる —— `running` は誰も待っていないので、拒否がプロセスごと落としうる。
      try {
        this.options.onEvent({ kind: 'failed', key: '', address: '', reason: 'internal', detail: messageOf(error) })
      } catch {
        // 数えてある（`failures.internal`）。毎分の要約がそれを出す。
      }
    }
    this.schedule(did ? this.options.spacingMs : this.options.idleMs)
  }
}
