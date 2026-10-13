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
//
// **基板の再起動をまたぐ欠けは、番号ではなく時刻で測る。** 再起動すると起動 ID が変わり番号は 0 へ
// 戻るので、番号の抜けとしては現れない。前の起動で最後に受けたサンプルの次の時刻から、新しい起動で
// 最初に受けたサンプルの時刻までを公称間隔で割る（`noteBoot`。前の起動の末尾・立ち上がるまで・
// 新しい起動の頭がまとめて入る）。**そのうち最後の部分は新しい起動の番号 `[0, 最初に受けた番号)` が持つ**ので、
// そこは新しい起動の流れの欠けにし（`noteBootHead`）、残りを**前の起動の流れの欠け**として載せる。
// 前の起動の末尾は、返事が途絶えてから再起動した基板ならフラッシュに残っている。新しい起動の頭は、時計が
// 合った後の分なら輪に残っている（合う前の分は残さない）。どちらも取りに行き、基板が持っていなかった
// 残りは「再起動の前後」（`reboot-span`）として数える。
// 2026-10-06 23:19 JST に基板 3 枚の電源を約 10 秒抜いたとき、これが無かったので
// 取り戻せなかった分にも何も載らなかった。

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
  /**
   * 基板の再起動の前後で受けられず、基板も持っていなかった（前の起動の末尾〜新しい起動の最初に受けたパケット）。
   * **再起動の欠け（`noteBoot`・`noteBootHead`）でだけ、基板の答えをこの理由へ寄せる** —— 基板の答えが `rebooted`・`not-held`・
   * `unsupported` のどれでも、ここへ寄せる（その長さの大半は、基板がそもそも測っていなかった時間なので、
   * 答えの違いで分けても手当ては変わらない）。
   */
  | 'reboot-span'

/** 再起動の欠けで、`reboot-span` へ寄せる答え。**諦め（`gave-up`）と捨てた（`too-many`）は寄せない**（手当てが違う）。 */
const REBOOT_SPAN_ABSORBS: ReadonlySet<UnrecoverableReason> = new Set(['rebooted', 'not-held', 'unsupported'])

/**
 * 再起動の欠けを測るとき、基板とホストの時計の食い違いとして許す幅。**これを超えて長いなら基板の時刻を
 * 信用せず、ホストが受けた時刻の差で測る**（`rebootsHostTimed`）。欠けの長さは、ホストが前の起動の最後と新しい起動の最初を受けた時刻の差より
 * 長くなりえない（その差に、最後のパケットが届くまでの遅れと時計のずれが乗るだけ）。基板の時計は
 * SNTP で合わせてあり、ずれを警告する閾値（`CLOCK_OFFSET_WARN_MS`）は 0.1 秒。10 秒はその十分外側。
 */
const REBOOT_CLOCK_SLACK_MS = 10_000

/** 再起動の欠けとして載せる長さの上限（`noteBoot`）。2^30 サンプル。 */
const MAX_REBOOT_SPAN_SAMPLES = 0x4000_0000

/** 前に使っていた起動 ID を、基板 × センサーごとにいくつ覚えるか（遅れて届いた前の起動のパケットを見分けるため）。 */
const RETIRED_BOOTS_KEPT = 8

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

/** センサー 1 本の、いちばん古い欠けの始まり（`pendingGapStarts`）。 */
export interface GapStart {
  readonly sensorId: string
  /** 通し番号（32 bit）。 */
  readonly from: number
}

export interface BacklogBookOptions {
  /**
   * 欠けを見つけてから取りに行くまで待つ時間。**UDP は順序を保証しない** —— 入れ替わって
   * 遅れて届くだけのパケットを、取りに行く前に待つ。
   */
  readonly settleMs: number
  /**
   * 基板のメモリの輪がまだ抱えていそうな間（見つけてからの経過）。**この間に失敗したら、待ちを
   * 伸ばさず `retryUrgentMs` で訊き直す** —— 倍々に伸ばすと、待っている間に輪が上書きする
   * （2026-10-06 の電子レンジの干渉では、取り戻せなかった 66,671 サンプルの理由がすべて「基板がもう
   * 抱えていない」だった。待ちの伸びと取りに行く速さの不足のどちらがどれだけ効いたかは測っていない）。
   */
  readonly holdMs: number
  /** `holdMs` の間に失敗したときの待ち。伸ばさない。 */
  readonly retryUrgentMs: number
  /**
   * `holdMs` を過ぎてから失敗したときの待ち。過ぎてから失敗が続くたびに倍にし、`retryMaxMs` で頭打ち
   * （その頃にはフラッシュの輪にしか残っていないので、急いでも取り戻せる分は増えない）。
   */
  readonly retryBaseMs: number
  readonly retryMaxMs: number
  /**
   * 1 回で訊く範囲の長さ（サンプル数）。**同じ流れの近い欠けをまとめて訊く** —— 干渉では欠けが
   * 1 まとまりずつ散らばるので、1 件ずつ訊くと取りに行く速さが欠けのできる速さに負ける。
   * 範囲に入る受信済みの分も基板は返すので、基板が 1 回に返すまとまりの数（ファームの
   * `BACKLOG_MAX_PER_REPLY`）を超えない長さにする。超えても `X-Backlog-More` で続きを訊けるが、
   * 受信済みの分で答えの枠を食う。
   */
  readonly maxSpanSamples: number
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
  /** 見つけた基板の再起動の数（センサーごとに 1。3 センサーの基板が 1 回再起動すれば 3）。 */
  readonly rebootsSeen: number
  /**
   * そのうち、基板の時刻が使えず、ホストが受けた時刻で長さを測った数（時刻が読めない・戻った・跳んだ）。
   * 欠けは作って取りに行く（長さはサンプル数十個ぶん粗い）。
   */
  readonly rebootsHostTimed: number
  /**
   * そのうち、長さを測れなかった数（周波数が読めない・前の起動の最後を知らない）。
   * **前の起動の末尾の欠けはどこにも数えていない**（新しい起動の頭は、前の起動の最後を覚えていれば番号で載せる）。
   */
  readonly rebootsUnmeasured: number
}

/** 基板が再起動したことを見つけた（`notePacket` が返す）。呼び出し側がログに出す。 */
export interface RebootNote {
  readonly boardKey: string
  readonly sensorId: string
  readonly previousBootId: string
  readonly bootId: string
  /**
   * 前の起動の末尾から新しい起動の最初に受けたサンプルまでのサンプル数。**測れなければ null。**
   * 新しい起動の頭（`[0, 最初に受けた番号)`）を含んだ合計で、欠けとしては前の起動と新しい起動に分けて載る。
   */
  readonly spanSamples: number | null
  /** 何の時刻で測ったか（`noteBoot`）。測れなければ null。 */
  readonly timedBy: 'board' | 'host' | null
  /**
   * 新しい起動の頭として欠けに載せたサンプル数（`noteBootHead`）。**載せなかったら 0**（番号 0 から届いた・
   * 前の起動の最後を覚えていない）。ログが「頭は取りに行く」と言ってよいかをこれで決める。
   */
  readonly headSamples: number
}

/** 書き出す形。**版を持たせる** —— 形を変えたときに古いものを読み違えないため。 */
export interface BacklogBookState {
  /** 2 で `gaps[].rebootSpan` と `boots` を足した。1 も読む（再起動の欠けは無く、最後の起動は分からない）。 */
  readonly version: 2
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
    /** 再起動の欠け（`noteBoot`）か。 */
    readonly rebootSpan: boolean
  }>
  /** 基板 × センサーごとの最後の起動（`BootState`）。 */
  readonly boots: ReadonlyArray<{
    readonly boardKey: string
    readonly sensorId: string
    readonly bootId: string
    readonly nextSeq: number
    /** 基板の時刻が読めなかったら null。 */
    readonly endMs: number | null
    readonly atMs: number
    readonly retired: readonly string[]
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
  /** `holdMs` を過ぎてから失敗した回数。倍々の待ちはこれで数える。 */
  lateAttempts: number
  nextTryMs: number
  /** 再起動の欠け（`noteBoot`）か。取り戻せなかった理由の数え方が変わる（`REBOOT_SPAN_ABSORBS`）。 */
  readonly rebootSpan: boolean
}

/**
 * 基板 × センサーの、いちばん新しい起動。**流れ（`streams`）とは別に持つ** —— あちらは前の起動を
 * 片付けるので（`supersede`）、新しい起動が来た時点で前の起動がどこまで届いていたかを引けない。
 */
interface BootState {
  readonly boardKey: string
  readonly sensorId: string
  bootId: string
  /** 受けた番号の次。前の起動の末尾の欠けはここから始まる。 */
  nextSeq: number
  /** 最後に受けたサンプルの次の時刻（基板の時計、unix ミリ秒）。読めなかったら null。 */
  endMs: number | null
  /** `endMs` を進めたパケットを受けた時刻（ホストの時計）。 */
  atMs: number
  /** 前に使っていた起動 ID。新しい順。 */
  retired: string[]
}

function bootMapKey(boardKey: string, sensorId: string): string {
  return `${boardKey}|${sensorId}`
}

function isSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < SEQ_SPAN
}

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 書き出した中身を読む。**形が合わなければ null**（欠けた欄を 0 で埋めない）。版 1 は版 2 の形へ読み替える。 */
export function parseBacklogBookState(text: string): BacklogBookState | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  if ((o.version !== 1 && o.version !== 2) || !Array.isArray(o.streams) || !Array.isArray(o.gaps)) return null
  const v2 = o.version === 2
  if (v2 && !Array.isArray(o.boots)) return null
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
      !isSeq(r.from) || !isSeq(r.to) || !isTime(r.foundAtMs) || (v2 && typeof r.rebootSpan !== 'boolean')
    ) {
      return null
    }
    gaps.push({
      boardKey: r.boardKey, bootId: r.bootId, sensorId: r.sensorId, address: r.address,
      from: r.from, to: r.to, foundAtMs: r.foundAtMs, rebootSpan: v2 ? (r.rebootSpan as boolean) : false,
    })
  }
  const boots: BacklogBookState['boots'][number][] = []
  for (const b of v2 ? (o.boots as unknown[]) : []) {
    if (typeof b !== 'object' || b === null) return null
    const r = b as Record<string, unknown>
    if (
      !isText(r.boardKey) || !isText(r.sensorId) || !isText(r.bootId) || !isSeq(r.nextSeq) ||
      (r.endMs !== null && !isTime(r.endMs)) || !isTime(r.atMs) || !Array.isArray(r.retired) || !r.retired.every(isText)
    ) {
      return null
    }
    boots.push({
      boardKey: r.boardKey, sensorId: r.sensorId, bootId: r.bootId, nextSeq: r.nextSeq,
      endMs: r.endMs as number | null, atMs: r.atMs, retired: r.retired as string[],
    })
  }
  return { version: 2, streams, gaps, boots }
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
  /** 基板 × センサーごとの最後の起動（`bootMapKey`）。 */
  private readonly boots = new Map<string, BootState>()
  private rebootsSeen = 0
  private rebootsHostTimed = 0
  private rebootsUnmeasured = 0

  constructor(options: BacklogBookOptions) {
    this.options = options
  }

  /**
   * 受けたパケットを 1 つ記録する。**読み取りに通ったものだけ渡すこと。**
   * 基板の再起動を見つけたら、その知らせを返す（それ以外は null）。
   *
   * **投げない。** 受信の口（`main.ts`）はこれを基板への返事より先に呼ぶ（このパケットで見つかった
   * 欠けを同じ回の返事の `gap=` に載せるため）。ここで投げると返事が出ず、基板はホストの不具合を
   * 「送れていない」と取り違えて繋ぎ直しと再起動を始める。読めない値は例外にせず黙って捨てること。
   */
  notePacket(input: {
    readonly stream: StreamRef
    readonly firstSeq: number
    readonly count: number
    readonly address: string
    readonly atMs: number
    /** 先頭サンプルの時刻（基板の時計）。再起動をまたぐ欠けの長さを測るのに使う。 */
    readonly firstSampleMs: number
    readonly sampleRateHz: number
  }): RebootNote | null {
    const { stream, firstSeq, count, address, atMs } = input
    if (!isSeq(firstSeq) || !Number.isInteger(count) || count <= 0) return null
    const key = streamKey(stream)
    const end = seqAdd(firstSeq, count)
    // **前の起動のパケットが遅れて届いたら、欠けを埋めるだけにする。** 流れとしては扱わない ——
    // 扱うと、前の起動の流れを作り直したついでに今の起動の流れを片付け（`supersede`）、次の今の起動の
    // パケットでまた逆が起きて、そのたびに今の起動の番号の抜けを見逃す。前の起動の次の番号より先の分は
    // 再起動の欠けに入っているので、ここで普通の欠けを足すと同じサンプルを 2 つの欠けが持つ。
    if (this.isRetired(stream.boardKey, stream.sensorId, stream.bootId)) {
      this.subtract(key, firstSeq, count, () => {})
      return null
    }
    // **先に再起動を見る。** 再起動の欠けを前の起動の流れへ載せておくと、下の `supersede` がその流れを
    // 片付けずに残す（取りに行く係は、欠けの流れからは送り元を引かないので、残すこと自体は要らないが害も無い）。
    const reboot = this.noteBoot(input, firstSeq, end)
    // 同じ基板の欠けは、取りに行く先も最新の送り元へ寄せる。**前の起動の欠けも**（再起動で DHCP の
    // 割り当てが変わっても、取りに行く先は同じ基板）。
    for (const g of this.gaps) if (g.stream.boardKey === stream.boardKey) g.address = address
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
      return reboot
    }
    st.address = address
    const d = seqDiff(firstSeq, st.nextSeq)
    if (d > 0) {
      this.addGap(key, stream, address, st.nextSeq, firstSeq, atMs)
      st.nextSeq = end
    } else if (d < 0) {
      // **遅れて届いた・重ねて届いた。** 欠けていた分なら埋まる。次の番号は戻さない。
      this.subtract(key, firstSeq, count, () => {})
      if (seqDiff(end, st.nextSeq) > 0) st.nextSeq = end
    } else {
      st.nextSeq = end
    }
    return reboot
  }

  /** その基板 × センサーで、もう前の起動になった起動 ID か。 */
  private isRetired(boardKey: string, sensorId: string, bootId: string): boolean {
    return this.boots.get(bootMapKey(boardKey, sensorId))?.retired.includes(bootId) ?? false
  }

  /**
   * 基板 × センサーの最後の起動を進め、**別の起動が来たら再起動として前の起動の末尾を欠けにする。**
   * 遅れて届いた前の起動のパケット（`retired`）は、呼ぶ前に弾いてある。
   *
   * 長さの測り方は 2 通り（`RebootNote.timedBy`）。
   * - **基板の時刻**（`board`）: `新しい起動の先頭サンプルの時刻 − 前の起動で最後に受けたサンプルの次の時刻` を
   *   公称間隔で割る。前の起動の番号は、最後に受けた番号の次から数える（前の起動がその後に測って
   *   送れなかった分は、その番号の続きにある）
   * - **ホストが受けた時刻**（`host`）: 基板の時刻が使えないとき —— 読めない、前の起動の終わりより半サンプル
   *   を超えて戻った（時計が合う前の値を名乗る古いファーム）、ホストが受けた時刻の差より
   *   `REBOOT_CLOCK_SLACK_MS` を超えて長い（時計が跳んだ）。**数えないで済ませると、前の起動の末尾を
   *   取りに行かず、損失にも載らない**。受けた時刻の差には届くまでの遅れの差が乗るが、
   *   それはサンプル数十個ぶんで済む
   * - **測れない**（`null`）: 周波数が読めない、または前の起動の最後を知らない（帳面が版 1・読めなかった。
   *   持ち越した前の起動の番号はあるが、時刻が無い）。前の起動の欠けは作らず `rebootsUnmeasured` に数える
   *
   * 測った長さのうち、新しい起動の頭（`firstSeq` サンプル）は新しい起動の欠けとして載せ（`noteBootHead`）、
   * 前の起動の欠けからは引く。頭は周波数が読めなくても番号で分かるので、前の起動の最後を覚えていれば必ず載せる。
   *
   * **ホストも止まっていた間に基板が再起動したときは、ホストが止まっていた時間も入る**（持ち越した
   * 最後の起動から測るため）。その間に基板が送った分は、基板がフラッシュに書いていれば取り戻せる。
   */
  private noteBoot(
    input: {
      readonly stream: StreamRef
      readonly count: number
      readonly address: string
      readonly atMs: number
      readonly firstSampleMs: number
      readonly sampleRateHz: number
    },
    firstSeq: number,
    end: number,
  ): RebootNote | null {
    const { stream, count, address, atMs, firstSampleMs, sampleRateHz } = input
    const rateOk = isTime(sampleRateHz) && sampleRateHz > 0
    const intervalMs = rateOk ? 1000 / sampleRateHz : null
    const endMs = intervalMs !== null && isTime(firstSampleMs) ? firstSampleMs + count * intervalMs : null
    const mapKey = bootMapKey(stream.boardKey, stream.sensorId)
    const cur = this.boots.get(mapKey)
    const fresh = (retired: string[]): BootState => ({
      boardKey: stream.boardKey, sensorId: stream.sensorId, bootId: stream.bootId, nextSeq: end, endMs, atMs, retired,
    })
    if (cur === undefined) {
      // **前の起動の最後は知らないが、持ち越した番号はある**（帳面が版 1 だった）。再起動したことだけは数える。
      // その起動は前の起動として覚える —— 覚えないと、遅れて届いたそのパケットを「戻る向きの再起動」と取り違える。
      const carriedBoots = this.carriedBootsOf(stream)
      this.boots.set(mapKey, fresh(carriedBoots.slice(0, RETIRED_BOOTS_KEPT)))
      const carriedBoot = carriedBoots[0]
      if (carriedBoot === undefined) return null
      this.rebootsSeen += 1
      this.rebootsUnmeasured += 1
      return {
        boardKey: stream.boardKey, sensorId: stream.sensorId, previousBootId: carriedBoot, bootId: stream.bootId,
        spanSamples: null, timedBy: null, headSamples: 0,
      }
    }
    if (cur.bootId === stream.bootId) {
      // **番号が進んだパケットの時刻で更新する**（大きい方を取らない）。同じ起動の中で時計が戻されると、
      // 大きい方を取った終わりの時刻は先へ置き去りになり、次の再起動を基板の時刻で測れなくなる。
      if (seqDiff(end, cur.nextSeq) > 0) {
        cur.nextSeq = end
        cur.endMs = endMs
        cur.atMs = atMs
      }
      return null
    }

    this.rebootsSeen += 1
    let spanSamples: number | null = null
    let timedBy: RebootNote['timedBy'] = null
    if (intervalMs !== null) {
      const hostSpanMs = Math.max(0, atMs - cur.atMs)
      const boardSpanMs = isTime(firstSampleMs) && cur.endMs !== null ? firstSampleMs - cur.endMs : null
      const boardOk = boardSpanMs !== null && boardSpanMs >= -intervalMs / 2 && boardSpanMs <= hostSpanMs + REBOOT_CLOCK_SLACK_MS
      timedBy = boardOk ? 'board' : 'host'
      spanSamples = Math.max(0, Math.round((boardOk ? boardSpanMs : hostSpanMs) / intervalMs))
      if (!boardOk) this.rebootsHostTimed += 1
      // **抜けの終わりの `firstSeq` サンプルは新しい起動の番号が持つ**（下の頭の欠け）。前の起動の番号の続きに
      // 載せるのは残りだけ —— 両方に載せると同じ時間を 2 度数える。時計の食い違いで抜けが頭より短く測れたら、
      // 前の起動の側を 0 にする（頭は番号で数えたので確か）。
      const rest = Math.max(0, spanSamples - firstSeq)
      // 番号の差は符号付き 32 bit で扱うので、欠けの長さは半周より短く切る。超えた分（100 Hz で約 124 日より先）は
      // 基板がフラッシュに持っているはずもないので、取りに行かずにそのまま数える。
      const len = Math.min(rest, MAX_REBOOT_SPAN_SAMPLES)
      this.count('reboot-span', rest - len)
      if (len > 0) {
        const prev: StreamRef = { boardKey: stream.boardKey, bootId: cur.bootId, sensorId: stream.sensorId }
        this.pushGap({
          key: streamKey(prev), stream: prev, address, from: cur.nextSeq, len,
          foundAtMs: atMs, attempts: 0, lateAttempts: 0, nextTryMs: atMs + this.options.settleMs, rebootSpan: true,
        })
      }
    } else {
      this.rebootsUnmeasured += 1
    }
    const headSamples = this.noteBootHead(stream, address, firstSeq, atMs)
    this.boots.set(mapKey, fresh([cur.bootId, ...cur.retired.filter((b) => b !== cur.bootId)].slice(0, RETIRED_BOOTS_KEPT)))
    return {
      boardKey: stream.boardKey, sensorId: stream.sensorId, previousBootId: cur.bootId, bootId: stream.bootId,
      spanSamples, timedBy, headSamples,
    }
  }

  /**
   * 再起動を見つけたとき、**新しい起動の頭 `[0, firstSeq)` を新しい起動の欠けにする。**
   *
   * 基板は時計が合う前から番号を進め、合う前の分は輪に残さない（ファームの `sendChunk`）。合った後の分は
   * Wi-Fi が繋がっていなくても輪に残すので、届かなかった分は取り戻せる。合う前の分は、基板が名乗る
   * 「抱えている範囲」（`X-Backlog-Have`）より古いので、1 回訊けば「もう抱えていない」で片付く。
   * 再起動の欠けとして載せる（`rebootSpan`）ので、基板が持っていなかった分は今までどおり `reboot-span` に入る。
   *
   * **前の起動の最後（番号と時刻・`boots`）を覚えているときだけ呼ぶ。** 覚えていない基板（ホストを初めて起動した・帳面が版 1）の途中から
   * 受け始めたときに頭を欠けにすると、動き続けている基板の何日分もの番号を欠けとして抱える。
   *
   * 長さの上限を超えたら**新しいほうの端を残す**（基板の輪に残っているのは新しい分）。前の起動の欠けは
   * 古いほうの端（再起動の直前）を残すので、向きが逆になる。
   *
   * **頭はいまの起動の欠けなので、返事の `gap=` に番号 0 から載る**（`pendingGapStarts`）。基板は指された
   * 番号を含む区画がもう輪に無ければ輪のいちばん古い区画からフラッシュへ書き出す（ファームの `gapCursor`）。
   * 頭が片付くまで（普通は 1 回訊けば済む）、時計が合った後の頭を輪の上書きから守る向きに効く。再起動の
   * たびに輪 1 周ぶんを書くことになるが、再起動は稀なので摩耗は気にしない。
   *
   * ホストが止まっている間に基板が再起動し、そのまま長く動いていたら、頭は何日分にもなりうる。取りに行けば
   * 基板が抱えている範囲より古い分は 1 回で「もう抱えていない」になり、`reboot-span` に入る（この変更の前も、
   * 同じサンプルは前の起動の欠けとして `reboot-span` に入っていた）。
   */
  private noteBootHead(stream: StreamRef, address: string, firstSeq: number, atMs: number): number {
    const len = Math.min(firstSeq, MAX_REBOOT_SPAN_SAMPLES)
    this.count('reboot-span', firstSeq - len)
    if (len === 0) return 0
    this.pushGap({
      key: streamKey(stream), stream, address, from: firstSeq - len, len,
      foundAtMs: atMs, attempts: 0, lateAttempts: 0, nextTryMs: atMs + this.options.settleMs, rebootSpan: true,
    })
    return len
  }

  /**
   * 持ち越した流れ（`carried`）のうち、同じ基板 × センサーの別の起動 ID の全部。**番号の大きい順**
   * （いちばん先まで受けていたものを、再起動の知らせの「前の起動」に使う）。普通は 1 つしか無い。
   */
  private carriedBootsOf(stream: StreamRef): string[] {
    const found: { bootId: string; nextSeq: number }[] = []
    for (const c of this.carried.values()) {
      if (c.stream.boardKey === stream.boardKey && c.stream.sensorId === stream.sensorId && c.stream.bootId !== stream.bootId) {
        found.push({ bootId: c.stream.bootId, nextSeq: c.nextSeq })
      }
    }
    return found.sort((a, b) => b.nextSeq - a.nextSeq).map((f) => f.bootId)
  }

  /**
   * いま取りに行ってよい欠けのうち、いちばん古いもの。無ければ null。
   *
   * **古くなりすぎた欠けはここで諦める**（`gave-up`）。
   */
  nextDue(nowMs: number): Gap | null {
    return this.nextDueWhere(nowMs, () => true)
  }

  /**
   * `nextDue` のうち、`accept` が通す流れに限ったもの。**取りに行く係が、いま訊いている最中の
   * 基板を外すために使う**（基板ごとに 1 件ずつ並行して訊く。`backlogFetcher.ts`）。
   *
   * **返す範囲は、同じ流れの近い欠けまで伸ばす**（`maxSpanSamples`）。起点はいちばん古い欠けの頭で、
   * そこから `maxSpanSamples` に収まる欠けの末尾まで。間に挟まる受信済みの分も範囲に入るので、
   * 返ってきたパケットのうち欠けに掛からないものは書かない（`overlapsGap`）。
   * 伸ばす先の欠けは、待ちの最中（`nextTryMs` の前）でも含める —— 早く取り戻せて困ることは無い。
   *
   * **伸ばす先には `accept` を掛け直さない。** 同じ流れ（`key` が同じ）の欠けは流れも同じなので、
   * `accept` が流れだけを見ている限り答えは起点と変わらない。流れ以外（欠けごとの状態）を見る
   * `accept` を渡すようになったら、ここでも掛けること。
   */
  nextDueWhere(nowMs: number, accept: (stream: StreamRef) => boolean): Gap | null {
    const keep: GapState[] = []
    for (const g of this.gaps) {
      if (nowMs - g.foundAtMs > this.options.giveUpAfterMs) this.count('gave-up', g.len)
      else keep.push(g)
    }
    this.gaps = keep
    let best: GapState | null = null
    for (const g of this.gaps) {
      if (g.nextTryMs > nowMs || !accept(g.stream)) continue
      if (best === null || g.foundAtMs < best.foundAtMs) best = g
    }
    if (best === null) return null
    let len = best.len
    for (const g of this.gaps) {
      if (g.key !== best.key) continue
      const start = seqDiff(g.from, best.from)
      if (start <= 0) continue
      const end = start + g.len
      if (end <= this.options.maxSpanSamples && end > len) len = end
    }
    return { ...this.view(best), to: seqAdd(best.from, len) }
  }

  /**
   * その基板のいまの起動について、センサーごとの**いちばん古い欠けの始まり**。名前の順。
   * **返事（`ackReplier.ts`）へ載せて、基板にフラッシュへの書き出しを始めさせる。**
   *
   * 基板は返事が途絶えたときしか書き出さない。電子レンジのように返事がまばらに届く干渉では
   * 一度も書かず、取りに行くのが遅れた分はメモリの輪（約 30 秒）から消えていた
   * （2026-10-06、約 86% が `not-held`）。欠けを知っているのはホストだけなので、こちらから言う。
   *
   * **見つけた直後から載せる**（`settleMs` の待ちの間も）。遅れて届いただけなら次の返事で
   * 消える。書き出しが 1 区画ぶん無駄になるだけで、取りこぼすよりはよい。
   *
   * **起動 ID が違う欠けは載せない。** 基板のメモリの輪にあるのはいまの起動の分だけで、
   * 前の起動の分はもうフラッシュにしか無い（そちらは取りに行く係が訊く）。
   *
   * **諦める年齢（`giveUpAfterMs`）を過ぎた欠けは載せない。** 片付けるのは `nextDueWhere` に任せ、
   * ここでは帳面を動かさない —— 返事のたびに呼ぶ口で状態を変えると、数え方が呼ぶ頻度に引きずられる。
   */
  pendingGapStarts(boardKey: string, bootId: string, nowMs: number): readonly GapStart[] {
    // **前の起動のパケットへの返事には載せない。** 返事を読むのはいまの起動の基板で、前の起動の番号を
    // いまの起動の番号として読み、無関係な位置から書き出しを始める。
    for (const b of this.boots.values()) {
      if (b.boardKey === boardKey && b.retired.includes(bootId)) return []
    }
    const oldest = new Map<string, number>()
    for (const g of this.gaps) {
      if (g.stream.boardKey !== boardKey || g.stream.bootId !== bootId) continue
      if (nowMs - g.foundAtMs > this.options.giveUpAfterMs) continue
      const cur = oldest.get(g.stream.sensorId)
      if (cur === undefined || seqDiff(g.from, cur) < 0) oldest.set(g.stream.sensorId, g.from)
    }
    return [...oldest]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([sensorId, from]) => ({ sensorId, from }))
  }

  /** `[from, to)` が、いま覚えている欠けに少しでも掛かるか。 */
  overlapsGap(key: string, from: number, to: number): boolean {
    const len = seqLen(from, to)
    if (len === 0) return false
    return this.gaps.some((g) => g.key === key && this.overlaps(g, from, len))
  }

  /** `[from, to)` を取り戻した。**欠けていた分だけ**数えて返す。 */
  recovered(key: string, from: number, to: number): number {
    const n = this.subtract(key, from, seqLen(from, to), () => {})
    this.recoveredCount += n
    return n
  }

  /**
   * `[from, to)` はもう取り戻せない。欠けていた分だけ数えて返す。
   * **再起動の欠けに掛かる分は、基板が持っていなかったという答えなら `reboot-span` に数える**（`REBOOT_SPAN_ABSORBS`）。
   */
  unrecoverable(key: string, from: number, to: number, reason: UnrecoverableReason): number {
    return this.subtract(key, from, seqLen(from, to), (g, n) => {
      this.count(g.rebootSpan && REBOOT_SPAN_ABSORBS.has(reason) ? 'reboot-span' : reason, n)
    })
  }

  /**
   * `[from, to)` に掛かる欠けを取りに行って失敗した。あとで訊き直す。
   *
   * **見つけてから `holdMs` の間は待ちを伸ばさない**（基板のメモリの輪にまだあるうちに訊き直す）。
   * 過ぎてからは倍々に空ける。
   *
   * **範囲に掛かる欠けは全部まとめて待たせる。** まとめて訊いた（`nextDueWhere`）範囲なら、まだ待ちの
   * 最中だった隣の欠けの待ちも動く。失敗の理由（繋がらない・ディスクが詰まった）はその隣にも同じく
   * 効くので、別々に数えない。
   *
   * 回数（`attempts`・`lateAttempts`）は帳面へ書き出さない。ホストを起動し直すと倍々は 5 秒から
   * やり直す —— 止まっていた間に状況は変わっているので、前の待ちを引き継ぐ理由が無い。
   */
  failed(key: string, from: number, to: number, nowMs: number): void {
    const len = seqLen(from, to)
    const { holdMs, retryUrgentMs, retryBaseMs, retryMaxMs } = this.options
    for (const g of this.gaps) {
      if (g.key !== key || !this.overlaps(g, from, len)) continue
      g.attempts += 1
      if (nowMs - g.foundAtMs < holdMs) {
        g.nextTryMs = nowMs + retryUrgentMs
        continue
      }
      g.lateAttempts += 1
      g.nextTryMs = nowMs + Math.min(retryMaxMs, retryBaseMs * 2 ** (g.lateAttempts - 1))
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
      rebootsSeen: this.rebootsSeen,
      rebootsHostTimed: this.rebootsHostTimed,
      rebootsUnmeasured: this.rebootsUnmeasured,
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
      rebootSpan: g.rebootSpan,
    }))
    const boots: BacklogBookState['boots'][number][] = []
    for (const b of this.boots.values()) {
      boots.push({
        boardKey: b.boardKey, sensorId: b.sensorId, bootId: b.bootId, nextSeq: b.nextSeq, endMs: b.endMs, atMs: b.atMs,
        retired: [...b.retired],
      })
    }
    return { version: 2, streams, gaps, boots }
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
        foundAtMs: g.foundAtMs, attempts: 0, lateAttempts: 0, nextTryMs: nowMs + this.options.settleMs,
        rebootSpan: g.rebootSpan,
      })
    }
    // **最後の起動も持ち越す。** 止まっている間に基板が再起動していたら、最初のパケットで見つける
    // （その長さには、ホストが止まっていた時間も入る。`noteBoot`）。
    for (const b of state.boots) {
      this.boots.set(bootMapKey(b.boardKey, b.sensorId), {
        boardKey: b.boardKey, sensorId: b.sensorId, bootId: b.bootId, nextSeq: b.nextSeq, endMs: b.endMs, atMs: b.atMs,
        retired: [...b.retired],
      })
    }
  }

  private addGap(key: string, stream: StreamRef, address: string, from: number, to: number, atMs: number): void {
    const len = seqLen(from, to)
    if (len === 0) return
    this.pushGap({
      key, stream, address, from, len, foundAtMs: atMs, attempts: 0, lateAttempts: 0, nextTryMs: atMs + this.options.settleMs,
      rebootSpan: false,
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

  /**
   * `[from, from+len)` を欠けから外し、**外したサンプル数**を返す。欠けは最大 2 つに割れる。
   * `onRemoved` は欠けごとに外した数を受ける（再起動の欠けだけ数え方を変えるため）。
   *
   * **掛かる欠けが無ければ配列を作り直さない** —— 受けたパケットごとに呼ぶ（`notePacket`）。
   */
  private subtract(key: string, from: number, len: number, onRemoved: (g: GapState, n: number) => void): number {
    if (len <= 0) return 0
    if (!this.gaps.some((g) => g.key === key && this.overlaps(g, from, len))) return 0
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
      onRemoved(g, e - s)
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
