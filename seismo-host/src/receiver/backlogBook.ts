// 届かなかった通し番号の範囲（欠け）を覚えておく帳面。**基板へ取りに行く係（`backlogFetcher.ts`）が読む。**
//
// **欠けを知っているのはホストだけ。** 基板は自分の送ったものが届いたかを知らない ——
// UDP の `endPacket()` は届いていなくても真を返し、ホストの返事は「生きている」を 1 秒に
// 1 回知らせるだけで、どのまとまりを受けたかは言わない。そこで基板は直近を丸ごと抱えておき
// （ファームの `BACKLOG_SLOTS`）、ホストが欠けた範囲を指定して取りに行く。
//
// **区間の組み立て（`segmenter.ts`）とは別に数える。** あちらは「計測震度のフィルタを
// 繋いでよいか」を決める部品で、あふれ（`o`）や時刻の跳びでも区間を切る。こちらが知りたいのは
// 番号の抜けだけなので、あちらの判断に乗ると、切れた理由ごとに「欠けたか」を読み解くことになる。
//
// **再起動をまたぐ。** ホストが止まっている間に届かなかった分こそ取り戻したいのに、
// 止まる前に何番まで受けたかを覚えていなければ、起動した後の最初のパケットを見ても
// 抜けたのか分からない。`toJSON` / `restore` で持ち越す（書き出すのは呼び出し側）。
// 書き出す間隔のぶん、持ち越した番号は古い —— その間に受けた分は、起動後にもう一度
// 取り戻すことになる（生データに同じまとまりが 2 度入る。中身が同じなので見分けられる）。
//
// **番号は 32 bit で一周する**（100 Hz で約 497 日）。大小をそのまま比べず、差を符号付き
// 32 bit で取る。範囲は「起点からの長さ」で扱い、一周をまたいでも壊れないようにしてある。

/** どの流れか。**起動 ID まで含めて 1 本** —— 基板が再起動すると番号は 0 へ戻る。 */
export interface StreamRef {
  readonly boardKey: string
  readonly bootId: string
  readonly sensorId: string
}

export function streamKey(stream: StreamRef): string {
  return `${stream.boardKey}|${stream.bootId}|${stream.sensorId}`
}

/** 取り戻せなかった理由。**数えるために分ける** —— 手当てが違う。 */
export type UnrecoverableReason =
  /** 基板が再起動していた（`/backlog` が 410）。輪はメモリにあるので消えている。 */
  | 'rebooted'
  /** 基板の輪がもう抱えていない（上書きされた）。 */
  | 'not-held'
  /** 基板が `/backlog` を持っていない（取り戻しより古いファーム・輪を確保できなかった）。 */
  | 'unsupported'
  /** 何度訊いても答えが無いまま古くなった。 */
  | 'gave-up'
  /** 欠けの数が上限を超えたので、古いものから捨てた。 */
  | 'too-many'

/** 取りに行く 1 件。`[from, to)` が欠けている。 */
export interface Gap {
  readonly key: string
  readonly stream: StreamRef
  /** 取りに行く先。**最後にパケットを受けた送り元**（DHCP で変わっても追う）。 */
  readonly address: string
  readonly from: number
  readonly to: number
  readonly foundAtMs: number
  readonly attempts: number
  readonly nextTryMs: number
}

export interface BacklogBookOptions {
  /**
   * 欠けを見つけてから取りに行くまで待つ時間。**UDP は順序を保証しない** —— 入れ替わって
   * 遅れて届くだけのパケットを、取りに行く前に待つ。
   */
  readonly settleMs: number
  /** 取りに行って失敗したときの待ち。失敗が続くたびに倍にし、`retryMaxMs` で頭打ち。 */
  readonly retryBaseMs: number
  readonly retryMaxMs: number
  /**
   * 見つけてからこれを過ぎても取り戻せない欠けは諦める。**基板が抱えていられる時間より
   * 長く待っても取り戻せない** —— 待ち続けると、欠けの表が古いもので埋まる。
   */
  readonly giveUpAfterMs: number
  /** 抱える欠けの数の上限。超えたらいちばん古いものから捨てる（`too-many`）。 */
  readonly maxGaps: number
}

export interface BacklogSnapshot {
  readonly pendingGaps: number
  /** まだ取り戻していないサンプル数（センサー 1 個の 1 サンプル = 1）。 */
  readonly pendingSamples: number
  readonly recoveredSamples: number
  /** 理由ごとの取り戻せなかったサンプル数。**0 の理由は載せない。** */
  readonly unrecoverableSamples: Partial<Record<UnrecoverableReason, number>>
}

/** 書き出す形。**版を持たせる** —— 形を変えたときに古いものを読み違えないため。 */
export interface BacklogBookState {
  readonly version: 1
  readonly streams: ReadonlyArray<{
    readonly boardKey: string
    readonly bootId: string
    readonly sensorId: string
    readonly nextSeq: number
    readonly address: string
  }>
  readonly gaps: ReadonlyArray<{
    readonly boardKey: string
    readonly bootId: string
    readonly sensorId: string
    readonly address: string
    readonly from: number
    readonly to: number
    readonly foundAtMs: number
  }>
}

const SEQ_SPAN = 0x1_0000_0000

/** `a - b` を符号付き 32 bit で。 */
function seqDiff(a: number, b: number): number {
  return (a - b) | 0
}

function seqAdd(a: number, n: number): number {
  return (a + n) % SEQ_SPAN
}

/** `[from, to)` の長さ。 */
function seqLen(from: number, to: number): number {
  return (to - from + SEQ_SPAN) % SEQ_SPAN
}

interface StreamState {
  readonly stream: StreamRef
  nextSeq: number
  address: string
}

interface GapState {
  readonly key: string
  readonly stream: StreamRef
  address: string
  from: number
  len: number
  readonly foundAtMs: number
  attempts: number
  nextTryMs: number
}

function isSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < SEQ_SPAN
}

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** 書き出した中身を読む。**形が合わなければ null**（欠けた欄を 0 で埋めない）。 */
export function parseBacklogBookState(text: string): BacklogBookState | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  if (o.version !== 1 || !Array.isArray(o.streams) || !Array.isArray(o.gaps)) return null
  const streams: BacklogBookState['streams'][number][] = []
  for (const s of o.streams as unknown[]) {
    if (typeof s !== 'object' || s === null) return null
    const r = s as Record<string, unknown>
    if (!isText(r.boardKey) || !isText(r.bootId) || !isText(r.sensorId) || !isSeq(r.nextSeq) || !isText(r.address)) {
      return null
    }
    streams.push({ boardKey: r.boardKey, bootId: r.bootId, sensorId: r.sensorId, nextSeq: r.nextSeq, address: r.address })
  }
  const gaps: BacklogBookState['gaps'][number][] = []
  for (const g of o.gaps as unknown[]) {
    if (typeof g !== 'object' || g === null) return null
    const r = g as Record<string, unknown>
    if (
      !isText(r.boardKey) || !isText(r.bootId) || !isText(r.sensorId) || !isText(r.address) ||
      !isSeq(r.from) || !isSeq(r.to) || typeof r.foundAtMs !== 'number' || !Number.isFinite(r.foundAtMs)
    ) {
      return null
    }
    gaps.push({
      boardKey: r.boardKey, bootId: r.bootId, sensorId: r.sensorId, address: r.address,
      from: r.from, to: r.to, foundAtMs: r.foundAtMs,
    })
  }
  return { version: 1, streams, gaps }
}

export class BacklogBook {
  private readonly options: BacklogBookOptions
  private readonly streams = new Map<string, StreamState>()
  /**
   * 前の起動で最後に受けた番号。**その流れの最初のパケットが来るまで待たせておく。**
   * 来たときに初めて、止まっていた間の欠けが分かる（来なければ、基板も再起動していた）。
   */
  private readonly carried = new Map<
    string,
    { readonly stream: StreamRef; readonly nextSeq: number; readonly address: string }
  >()
  /** 見つけた順。**取りに行くのも古い順**（基板の輪から先に消えるのは古い分）。 */
  private gaps: GapState[] = []
  private recoveredCount = 0
  private readonly lost = new Map<UnrecoverableReason, number>()

  constructor(options: BacklogBookOptions) {
    this.options = options
  }

  /** 受けたパケットを 1 つ記録する。**読み取りに通ったものだけ渡すこと。** */
  notePacket(input: {
    readonly stream: StreamRef
    readonly firstSeq: number
    readonly count: number
    readonly address: string
    readonly atMs: number
  }): void {
    const { stream, firstSeq, count, address, atMs } = input
    if (!isSeq(firstSeq) || !Number.isInteger(count) || count <= 0) return
    const key = streamKey(stream)
    const end = seqAdd(firstSeq, count)
    let st = this.streams.get(key)
    if (st === undefined) {
      this.supersede(stream)
      const carried = this.carried.get(key)
      this.carried.delete(key)
      if (carried !== undefined && seqDiff(firstSeq, carried.nextSeq) > 0) {
        this.addGap(key, stream, address, carried.nextSeq, firstSeq, atMs)
      }
      st = { stream, nextSeq: end, address }
      this.streams.set(key, st)
      return
    }
    st.address = address
    // 同じ流れの欠けは、取りに行く先も最新の送り元へ寄せる。
    for (const g of this.gaps) if (g.key === key) g.address = address
    const d = seqDiff(firstSeq, st.nextSeq)
    if (d > 0) {
      this.addGap(key, stream, address, st.nextSeq, firstSeq, atMs)
      st.nextSeq = end
    } else if (d < 0) {
      // **遅れて届いた・重ねて届いた。** 欠けていた分なら埋まる。次の番号は戻さない。
      this.subtract(key, firstSeq, count)
      if (seqDiff(end, st.nextSeq) > 0) st.nextSeq = end
    } else {
      st.nextSeq = end
    }
  }

  /**
   * いま取りに行ってよい欠けのうち、いちばん古いもの。無ければ null。
   *
   * **古くなりすぎた欠けはここで諦める**（`gave-up`）。
   */
  nextDue(nowMs: number): Gap | null {
    const keep: GapState[] = []
    for (const g of this.gaps) {
      if (nowMs - g.foundAtMs > this.options.giveUpAfterMs) this.count('gave-up', g.len)
      else keep.push(g)
    }
    this.gaps = keep
    let best: GapState | null = null
    for (const g of this.gaps) {
      if (g.nextTryMs > nowMs) continue
      if (best === null || g.foundAtMs < best.foundAtMs) best = g
    }
    return best === null ? null : this.view(best)
  }

  /** `[from, to)` を取り戻した。**欠けていた分だけ**数えて返す。 */
  recovered(key: string, from: number, to: number): number {
    const n = this.subtract(key, from, seqLen(from, to))
    this.recoveredCount += n
    return n
  }

  /** `[from, to)` はもう取り戻せない。欠けていた分だけ数えて返す。 */
  unrecoverable(key: string, from: number, to: number, reason: UnrecoverableReason): number {
    const n = this.subtract(key, from, seqLen(from, to))
    this.count(reason, n)
    return n
  }

  /** `[from, to)` に掛かる欠けを取りに行って失敗した。待ちを倍にして、あとで訊き直す。 */
  failed(key: string, from: number, to: number, nowMs: number): void {
    const len = seqLen(from, to)
    for (const g of this.gaps) {
      if (g.key !== key || !this.overlaps(g, from, len)) continue
      g.attempts += 1
      const wait = Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** (g.attempts - 1))
      g.nextTryMs = nowMs + wait
    }
  }

  snapshot(): BacklogSnapshot {
    let pendingSamples = 0
    for (const g of this.gaps) pendingSamples += g.len
    const unrecoverableSamples: Partial<Record<UnrecoverableReason, number>> = {}
    for (const [reason, n] of this.lost) if (n > 0) unrecoverableSamples[reason] = n
    return {
      pendingGaps: this.gaps.length,
      pendingSamples,
      recoveredSamples: this.recoveredCount,
      unrecoverableSamples,
    }
  }

  toJSON(): BacklogBookState {
    const streams: BacklogBookState['streams'][number][] = []
    for (const st of this.streams.values()) {
      streams.push({ ...st.stream, nextSeq: st.nextSeq, address: st.address })
    }
    // **まだ最初のパケットが来ていない持ち越し分も書き戻す。** 起動してすぐ落ちたとき、
    // 書き戻さないと次の起動では止まっていた間の欠けが分からなくなる。
    for (const [key, c] of this.carried) {
      if (this.streams.has(key)) continue
      streams.push({ ...c.stream, nextSeq: c.nextSeq, address: c.address })
    }
    const gaps = this.gaps.map((g) => ({
      ...g.stream, address: g.address, from: g.from, to: seqAdd(g.from, g.len), foundAtMs: g.foundAtMs,
    }))
    return { version: 1, streams, gaps }
  }

  /**
   * 前の起動の帳面を読み込む。**起動直後に 1 回だけ**（受け始める前）。
   *
   * 持ち越した欠けは、`settleMs` だけ待ってから取りに行く（受け始めた直後は、
   * まだ届いていないだけの分と見分けが付かない）。
   */
  restore(state: BacklogBookState, nowMs: number): void {
    for (const s of state.streams) {
      const stream: StreamRef = { boardKey: s.boardKey, bootId: s.bootId, sensorId: s.sensorId }
      this.carried.set(streamKey(stream), { stream, nextSeq: s.nextSeq, address: s.address })
    }
    for (const g of state.gaps) {
      const stream: StreamRef = { boardKey: g.boardKey, bootId: g.bootId, sensorId: g.sensorId }
      const len = seqLen(g.from, g.to)
      if (len === 0) continue
      this.pushGap({
        key: streamKey(stream), stream, address: g.address, from: g.from, len,
        foundAtMs: g.foundAtMs, attempts: 0, nextTryMs: nowMs + this.options.settleMs,
      })
    }
  }

  private addGap(key: string, stream: StreamRef, address: string, from: number, to: number, atMs: number): void {
    const len = seqLen(from, to)
    if (len === 0) return
    this.pushGap({
      key, stream, address, from, len, foundAtMs: atMs, attempts: 0, nextTryMs: atMs + this.options.settleMs,
    })
  }

  private pushGap(g: GapState): void {
    this.gaps.push(g)
    while (this.gaps.length > this.options.maxGaps) {
      let oldest = 0
      for (let i = 1; i < this.gaps.length; i++) {
        if (this.gaps[i]!.foundAtMs < this.gaps[oldest]!.foundAtMs) oldest = i
      }
      const [dropped] = this.gaps.splice(oldest, 1)
      if (dropped !== undefined) this.count('too-many', dropped.len)
    }
  }

  private overlaps(g: GapState, from: number, len: number): boolean {
    const s = seqDiff(from, g.from)
    return s < g.len && s + len > 0
  }

  /** `[from, from+len)` を欠けから外し、**外したサンプル数**を返す。欠けは最大 2 つに割れる。 */
  private subtract(key: string, from: number, len: number): number {
    if (len <= 0) return 0
    let removed = 0
    const next: GapState[] = []
    for (const g of this.gaps) {
      if (g.key !== key || !this.overlaps(g, from, len)) {
        next.push(g)
        continue
      }
      const s = Math.max(0, seqDiff(from, g.from))
      const e = Math.min(g.len, seqDiff(from, g.from) + len)
      removed += e - s
      if (s > 0) next.push({ ...g, len: s })
      if (e < g.len) next.push({ ...g, from: seqAdd(g.from, e), len: g.len - e })
    }
    this.gaps = next
    return removed
  }

  private count(reason: UnrecoverableReason, n: number): void {
    if (n <= 0) return
    this.lost.set(reason, (this.lost.get(reason) ?? 0) + n)
  }

  /**
   * 同じ基板・同じセンサーの**別の起動**が現れた（＝基板が再起動した）。前の起動の流れと
   * 持ち越しを片付ける。
   *
   * **時間では忘れない。** 1 時間黙った流れを忘れる形にしていたら、Wi-Fi が 1 時間を超えて
   * 落ちた後に戻ったとき、その間の欠けを 1 つも見つけられなかった（レビューで指摘）。
   * 前の起動の番号はもう続かないので、ここで片付ければ流れの数は「基板 × センサー」で頭打ちになる。
   * **欠けが残っている前の起動の流れは残す** —— 基板はフラッシュに前の起動の分を持っていることがあり、
   * 取りに行く先（送り元）をそこから引く。
   */
  private supersede(stream: StreamRef): void {
    const older = (s: StreamRef): boolean =>
      s.boardKey === stream.boardKey && s.sensorId === stream.sensorId && s.bootId !== stream.bootId
    for (const [key, st] of this.streams) {
      if (older(st.stream) && !this.gaps.some((g) => g.key === key)) this.streams.delete(key)
    }
    for (const [key, c] of this.carried) {
      if (older(c.stream)) this.carried.delete(key)
    }
  }

  private view(g: GapState): Gap {
    return {
      key: g.key, stream: g.stream, address: g.address, from: g.from, to: seqAdd(g.from, g.len),
      foundAtMs: g.foundAtMs, attempts: g.attempts, nextTryMs: g.nextTryMs,
    }
  }
}
