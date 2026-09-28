// 押し出された波形を、画面で見るぶんだけ溜める。
//
// **溜め場所はブラウザだけ。** ホストには過ぎた波形を読み返す口が無いので
// （`../receiver/statusServer.ts` 冒頭）、**繋いでから受け取った分しか遡れない** ——
// ここが持つ長さが、そのまま「画面でどこまで戻せるか」になる。
//
// **チャンクのまま環状に持つ。** 押し出しは 1 パケットぶん（実機で 300 ms・30 サンプル）を
// ひとかたまりで運び、先頭の時刻と刻みを添えてくる。サンプル 1 点ずつに時刻を持たせ直すと
// 点の数だけ余計に抱えることになるし、**そのかたまりが持つ「どの区間のものか」**
// （`streamKey`・`segmentId`）も失う —— 波形を繋いでよいかはそれで決まる。
//
// **繋いでよい所と、そうでない所を区別する。** 区間が変わった・時刻が飛んだところを
// 線で繋ぐと、**欠測が「そこだけ傾いた波形」として絵になる** ——
// 地震かどうかを波の形で見る画面で、これは最も避けたい嘘。
//
// **名乗りの数に上限を置く。** `boardKey`・`sensorId` は無認証の UDP パケット由来で
// 文字種の検証も無い（`viewStatus.ts` 冒頭が言う事情と同じ）。名前を変えながら投げ続けられると
// 溜め場所が際限なく増えるので、受け付ける本数を区切って**断った数を画面へ出せる形にする**。

/**
 * 1 チャンクぶんの波形。
 *
 * **`WaveChunk`（`../receiver/intensityPipeline.ts`）を丸ごと持ってこない。** あちらは
 * Node 専用の型を経由して定義されており、ブラウザ向けのこちら（`tsconfig.seismo-host-admin.json`）
 * へ持ち込むと前提が衝突する（`viewStatus.ts` の `StatusReportView` と同じ分担）。
 *
 * **中身は検証済みのものが来る前提。** 数として読めるか・欄が揃っているかを見るのは
 * 受け口（`waveStream.ts`）の仕事で、二重には置かない。
 */
export interface WaveChunkView {
  readonly source: WaveSourceKey
  /**
   * 基板の起動ごとに変わる。**これが変われば、前のチャンクとは繋がない。**
   *
   * **観測点の合成（`kind: 'station'`）では null。** 合成の区間の連続性は駆動役の
   * 流れが決めるが、`FusedWaveChunk` はそれを外へ出さない（あちらの型の説明を
   * 見ること）。**無いものを埋めない** —— 連続性は時刻の隔たりで見る
   * （`CONTINUITY_TOLERANCE`）ので、この 2 つが無くても切れ目は検出できる。
   */
  readonly streamKey: string | null
  readonly segmentId: number | null
  /**
   * 先頭サンプルの時刻。
   *
   * **基板が名乗る軸の名前（`channels`）は受け取らない。** 校正の回転を通した後の値は
   * 共通座標（ENU）で、センサーが名乗る軸名はもう当てはまらない —— 持っていても
   * 表示に使えないので、使わないものを運ばない。
   */
  readonly firstSampleMs: number
  readonly msPerSample: number
  /** 時刻の当てはめを公称値へ倒したなら理由。当てはめた値を使っていれば null。 */
  readonly timebaseNominalReason: string | null
  readonly gal: readonly [readonly number[], readonly number[], readonly number[]]
  /**
   * そのサンプルへ実際に効いたセンサーの本数（観測点の合成だけ）。
   * センサー単独では null。
   *
   * **`gal` と同じ長さで来る。** 画面に出すのは最小と最大で、揺れ動いていることが
   * #362 の症状（顔ぶれの入れ替わりが段差になる）の印になる。
   */
  readonly memberCount: readonly number[] | null
}

/**
 * 波形 1 本の出どころ。
 *
 * **センサー単独と観測点の合成を同じ入れ物へ混ぜない。** 合成には基板も
 * センサー番号も無いので、埋めれば嘘になる —— この鍵は**表示にそのまま使う**ため、
 * 観測点の識別子が基板の欄に出る形になる。
 */
export type WaveSourceKey =
  | { readonly kind: 'sensor'; readonly boardKey: string; readonly sensorId: string }
  /** 観測点ぶんの合成（REQUIREMENTS.md §7）。 */
  | { readonly kind: 'station'; readonly stationId: string }

/**
 * 画面の 1 列ぶん。**平均ではなく上下の両端を持つ。**
 *
 * 1 列に何十サンプルも入るとき、平均や単純な間引きで代表させると**尖りが消える** ——
 * 揺れの大きさを見に来た画面で、いちばん見たい一瞬だけが落ちることになる。
 */
export interface WaveColumn {
  readonly minGal: number
  readonly maxGal: number
  /** この列の手前に切れ目があるか。**前の列と線で繋がない印。** */
  readonly gapBefore: boolean
}

/**
 * 軸 1 本の、この窓ぶんの統計。
 *
 * **縦軸は「0 を中心」にできない。** 校正を通した後も重力は残っている
 * （`gravityCheck.ts` が校正適用後の値から重力を読んでいるのがその証拠で、
 * 実機の上向き軸は 980 gal 付近が定常値）。生の値をそのまま目盛りに載せると、
 * **見たい数 gal の揺れが 980 の目盛りに埋もれる。** だから平均を中心に据え、
 * そこからの隔たりで縦の幅を決める。
 */
export interface WaveAxisStats {
  readonly meanGal: number
  /** 平均からの最大の隔たり。**縦の半幅はここから決める。** */
  readonly maxDeviationGal: number
  readonly sampleCount: number
}

/** 時間の窓を切り出した結果。 */
export interface WaveWindow {
  /** 軸 × 列。値が 1 つも入らなかった列は null。 */
  readonly axes: readonly (readonly (WaveColumn | null)[])[]
  /** この窓に、時刻の当てはめが公称値へ倒れた区間が含まれるか。 */
  readonly timebaseNominal: boolean
  /** 軸ごとの統計。サンプルが 1 つも入らなかった軸は null。 */
  readonly stats: readonly (WaveAxisStats | null)[]
}

/** 溜めている時間の範囲。 */
export interface WaveRange {
  readonly fromMs: number
  readonly toMs: number
}

/**
 * どこまで遡れるか。既定は 5 分。
 *
 * **押し出しの実測は 9 本ぶんで毎秒およそ 24 KB**（`seismo-host/README.md`）。
 * 5 分ぶんを `Float32Array` へ詰め直して持てば、1 本あたり 1 MB に満たない。
 */
const RETAIN_MS_DEFAULT = 5 * 60 * 1000

/**
 * 1 本が抱えるチャンクの上限。
 *
 * **時間だけで区切ると足りない。** 保持する長さは時間で決まるが、刻みの細かい
 * （＝1 チャンクの中身が少ない）ものが届くと、同じ 5 分でも件数だけが膨らむ。
 * 実機の 300 ms チャンクなら 5 分は 1000 件なので、4 倍の余裕を見てここで頭を打つ。
 */
const MAX_CHUNKS_DEFAULT = 4000

/**
 * 受け付ける波形の本数（センサー単独と観測点の合成をまとめて数える）。
 *
 * **実機の見込み（基板 3 枚 × センサー 3 個 ＋ 観測点の合成）に対して十分な余裕が
 * ある。** 区切るのは見込みを守るためではなく、名前を変えながら投げ続けられたときに
 * 溜め場所が際限なく増えないため。達したことは `rejectedSources` に出る。
 */
const MAX_SOURCES_DEFAULT = 32

/**
 * 前のチャンクの終わりとの隔たりが、サンプル間隔のこの倍を超えたら切れ目とみなす。
 *
 * **ぴったり一致は求めない。** 時刻は区間の当てはめから引いた値で、丸めのぶんだけ
 * 揺らぐ。半サンプルぶんまでは続きとして扱う。
 */
const CONTINUITY_TOLERANCE = 0.5

interface StoredChunk {
  readonly startMs: number
  readonly msPerSample: number
  readonly count: number
  readonly gal: readonly [Float32Array, Float32Array, Float32Array]
  /** 前のチャンクと繋がっていない。 */
  readonly gapBefore: boolean
  readonly timebaseNominal: boolean
  readonly streamKey: string | null
  readonly segmentId: number | null
}

function endMsOf(chunk: StoredChunk): number {
  return chunk.startMs + chunk.count * chunk.msPerSample
}

/** 波形 1 本ぶんの溜め場所（センサー単独でも観測点の合成でも）。 */
export class WaveBuffer {
  readonly source: WaveSourceKey

  private readonly retainMs: number
  private readonly capacity: number
  private readonly chunks: (StoredChunk | null)[]
  private head = 0
  private count = 0
  private rewinds = 0
  private droppedByCount = 0
  private lastMemberMin: number | null = null
  private lastMemberMax: number | null = null

  constructor(source: WaveSourceKey, options: { retainMs?: number; maxChunks?: number } = {}) {
    this.source = source
    this.retainMs = options.retainMs ?? RETAIN_MS_DEFAULT
    this.capacity = options.maxChunks ?? MAX_CHUNKS_DEFAULT
    this.chunks = new Array<StoredChunk | null>(this.capacity).fill(null)
  }

  get chunkCount(): number {
    return this.count
  }

  /**
   * 時刻が巻き戻って、溜めていたものを捨てた回数。
   *
   * **0 でないことは画面に出す。** 捨てたのは「最大 5 分遡れる」という約束そのもので、
   * 黙っていると**開いた直後で溜まりが少ないのか、消えたのか**を運用者が区別できない。
   */
  get rewindCount(): number {
    return this.rewinds
  }

  /**
   * 件数の上限で古いチャンクを落とした回数。
   *
   * **保持時間で落ちた分とは分けて数える。** あちらは約束どおりの振る舞いだが、
   * こちらは「5 分より短くしか遡れない」状態の印。
   */
  get droppedByCountLimit(): number {
    return this.droppedByCount
  }

  /**
   * 最後に届いたまとまりで、実際に混ざったセンサーの本数（最小・最大）。
   * 観測点の合成でなければどちらも null。
   *
   * **大きく揺れ動いていれば異常を疑う手掛かりになる。** 顔ぶれが入れ替わると
   * センサー間の直流差が段差として乗る（#362。手当て前は 1〜7 本を揺れ動いていた）。
   *
   * **ただし小さな幅は実機では常態。** まとまりの末尾は裏付けの同じ時刻のサンプルが
   * まだ届いておらず、実測では 30 サンプル中 28 個が 9 本・末尾 2 個が 8・7 本だった
   * （REQUIREMENTS.md §7）。**どこからが異常かの物差しは未設計**（#374）なので、
   * ここは数を返すだけで判定はしない。
   */
  get memberRange(): { readonly min: number; readonly max: number } | null {
    if (this.lastMemberMin === null || this.lastMemberMax === null) return null
    return { min: this.lastMemberMin, max: this.lastMemberMax }
  }

  push(chunk: WaveChunkView): void {
    // **3 軸のうちいちばん短いものに合わせる。** 欄の長さが揃っていない値が来たとき、
    // 長いほうに合わせると無い所を読むことになる。
    const length = Math.min(chunk.gal[0].length, chunk.gal[1].length, chunk.gal[2].length)
    if (length === 0) return

    const previous = this.last()
    // **時刻が巻き戻ったら、持っているものを捨てて積み直す。** 並びが時刻順である
    // ことを切り出しも描画も当てにしているので、**崩れた並びを持つほうが害が大きい**
    // （基板を入れ替えた・時計が飛んだ、のどちらでも起きうる）。
    let rewound = false
    if (previous !== null && chunk.firstSampleMs < previous.startMs) {
      this.clear()
      this.rewinds++
      rewound = true
    }

    const stored: StoredChunk = {
      startMs: chunk.firstSampleMs,
      msPerSample: chunk.msPerSample,
      count: length,
      gal: [
        Float32Array.from(chunk.gal[0].slice(0, length)),
        Float32Array.from(chunk.gal[1].slice(0, length)),
        Float32Array.from(chunk.gal[2].slice(0, length)),
      ],
      // **捨てた直後の 1 つは切れ目にする。** `isGap` は手前のチャンクと比べるが、
      // 捨てた後は比べる相手が無く必ず「続き」と答える —— **5 分ぶんが消えたのに
      // 「普通に波形が始まった」としか見えない**（レビューが 2 本とも指した形）。
      gapBefore: rewound || this.isGap(chunk),
      timebaseNominal: chunk.timebaseNominalReason !== null,
      streamKey: chunk.streamKey,
      segmentId: chunk.segmentId,
    }

    if (this.count === this.capacity) {
      // **件数の上限で落ちたことは、保持時間で落ちたことと分けて数える。** 前者は
      // 「5 分遡れる」という約束が破れた印で、後者は約束どおりの振る舞い。
      this.dropOldest()
      this.droppedByCount++
    }
    this.chunks[(this.head + this.count) % this.capacity] = stored
    this.count++
    this.evictExpired(endMsOf(stored))

    // **混ざった本数は最新のまとまりだけ覚える。** 溜めた 5 分ぶんを遡って
    // 数え直せる形にはしない —— 見たいのは「いま顔ぶれが揃っているか」で、
    // 溜まりのどこかに揺れがあったかを知りたいわけではない。
    if (chunk.memberCount !== null && chunk.memberCount.length > 0) {
      let min = chunk.memberCount[0]
      let max = chunk.memberCount[0]
      for (const n of chunk.memberCount) {
        if (n < min) min = n
        if (n > max) max = n
      }
      this.lastMemberMin = min
      this.lastMemberMax = max
    }
  }

  /** いま持っている時間の範囲。空なら null。 */
  range(): WaveRange | null {
    if (this.count === 0) return null
    const first = this.chunks[this.head]
    const last = this.last()
    if (first === null || last === null) return null
    return { fromMs: first.startMs, toMs: endMsOf(last) }
  }

  /**
   * 時間の窓を、画面の列数へ畳む。
   *
   * **列数は画面の横幅から来る。** 1 列に何サンプル入るかは窓の長さで変わるので、
   * ここで上下の両端を採る（`WaveColumn` 参照）。
   */
  readWindow(fromMs: number, toMs: number, columnCount: number): WaveWindow {
    const empty: WaveWindow = {
      axes: [[], [], []],
      timebaseNominal: false,
      stats: [null, null, null],
    }
    if (columnCount <= 0 || !(toMs > fromMs)) return empty

    const span = toMs - fromMs
    const axes: (WaveColumn | null)[][] = [
      new Array<WaveColumn | null>(columnCount).fill(null),
      new Array<WaveColumn | null>(columnCount).fill(null),
      new Array<WaveColumn | null>(columnCount).fill(null),
    ]
    let nominal = false
    // 軸ごとの合計・件数・上下。**平均からの最大の隔たりは、全体の上下と平均から
    // 正確に出せる**（どちらか遠いほうを採る）ので、走査は 1 度で済む。
    const sum = [0, 0, 0]
    const counts = [0, 0, 0]
    const lowest = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
    const highest = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]

    for (let n = 0; n < this.count; n++) {
      const chunk = this.chunks[(this.head + n) % this.capacity]
      if (chunk === null) continue
      // **窓に掛からないチャンクは触らない。** 1 本ぶん 5 分を毎回全部舐めると、
      // 窓を狭めるほど無駄が増える。**境目は閉じた側で切る** —— `endMs` は最後の
      // サンプルの「次」の位置なので、`endMs === fromMs` のチャンクは 1 点も入らない。
      if (endMsOf(chunk) <= fromMs || chunk.startMs >= toMs) continue

      for (let i = 0; i < chunk.count; i++) {
        const atMs = chunk.startMs + i * chunk.msPerSample
        if (atMs < fromMs || atMs >= toMs) continue
        // **倒れていたことは、窓に入ったサンプルがあるときだけ伝える。**
        // チャンク単位で立てると、窓の端に接しているだけで 1 点も入らない
        // チャンクの印を拾い、**関係の無い時間帯に警告が出続ける。**
        if (chunk.timebaseNominal) nominal = true
        const column = Math.min(columnCount - 1, Math.floor(((atMs - fromMs) / span) * columnCount))
        // **切れ目の印はチャンクの先頭サンプルにだけ付く。** 途中のサンプルへ
        // 広げると、同じ列に入った後続のサンプルが印を消してしまう。
        const gapBefore = chunk.gapBefore && i === 0

        for (let axis = 0; axis < 3; axis++) {
          const value = chunk.gal[axis][i]
          const previous = axes[axis][column]
          axes[axis][column] =
            previous === null
              ? { minGal: value, maxGal: value, gapBefore }
              : {
                  minGal: Math.min(previous.minGal, value),
                  maxGal: Math.max(previous.maxGal, value),
                  gapBefore: previous.gapBefore || gapBefore,
                }
          sum[axis] += value
          counts[axis]++
          if (value < lowest[axis]) lowest[axis] = value
          if (value > highest[axis]) highest[axis] = value
        }
      }
    }

    const stats = counts.map((count, axis) => {
      if (count === 0) return null
      const mean = sum[axis] / count
      return {
        meanGal: mean,
        maxDeviationGal: Math.max(Math.abs(highest[axis] - mean), Math.abs(mean - lowest[axis])),
        sampleCount: count,
      }
    })

    return { axes, timebaseNominal: nominal, stats }
  }

  private isGap(chunk: WaveChunkView): boolean {
    const previous = this.last()
    // **最初の 1 つは切れ目にしない。** 手前に繋ぐ相手が無いだけで、
    // 途切れたわけではない。
    if (previous === null) return false
    // **観測点の合成ではこの 2 つがどちらも null。** 等しいので素通りし、
    // 下の時刻の隔たりだけで判定する（`WaveChunkView.streamKey` の説明を見ること）。
    if (previous.streamKey !== chunk.streamKey) return true
    if (previous.segmentId !== chunk.segmentId) return true
    const expected = endMsOf(previous)
    return Math.abs(chunk.firstSampleMs - expected) > chunk.msPerSample * CONTINUITY_TOLERANCE
  }

  private last(): StoredChunk | null {
    if (this.count === 0) return null
    return this.chunks[(this.head + this.count - 1) % this.capacity]
  }

  private evictExpired(newestMs: number): void {
    const limit = newestMs - this.retainMs
    while (this.count > 0) {
      const oldest = this.chunks[this.head]
      if (oldest === null || endMsOf(oldest) >= limit) break
      this.dropOldest()
    }
  }

  private dropOldest(): void {
    this.chunks[this.head] = null
    this.head = (this.head + 1) % this.capacity
    this.count--
  }

  private clear(): void {
    this.chunks.fill(null)
    this.head = 0
    this.count = 0
  }
}

export interface WaveStoreOptions {
  readonly retainMs?: number
  readonly maxChunks?: number
  /** 受け付ける波形の本数（センサー単独と観測点の合成をまとめて数える）。 */
  readonly maxSources?: number
}

/**
 * 波形ごとの溜め場所をまとめて持つ。
 *
 * **初めて届いた順に並べる。** 名前で並べ替えると、基板を足したときに既存の行が
 * 入れ替わって見比べにくい。
 *
 * **センサー単独と観測点の合成を同じ入れ物で持つ。** 鍵（`WaveSourceKey`）が
 * 種別を持つので混ざらず、上限・並び・時間の範囲をひととおり書くだけで済む。
 */
export class WaveStore {
  private readonly buffers = new Map<string, WaveBuffer>()
  private readonly options: WaveStoreOptions
  private readonly maxSources: number
  private rejected = 0

  constructor(options: WaveStoreOptions = {}) {
    this.options = options
    this.maxSources = options.maxSources ?? MAX_SOURCES_DEFAULT
  }

  /** 上限に達していて受け付けなかった件数（累計）。**0 でないことは画面に出す。** */
  get rejectedSources(): number {
    return this.rejected
  }

  /** 時刻の巻き戻りで溜めていたものを捨てた回数（全センサーの合計）。 */
  get rewindCount(): number {
    let total = 0
    for (const buffer of this.buffers.values()) total += buffer.rewindCount
    return total
  }

  /** 件数の上限で古いチャンクを落とした回数（全センサーの合計）。 */
  get droppedByCountLimit(): number {
    let total = 0
    for (const buffer of this.buffers.values()) total += buffer.droppedByCountLimit
    return total
  }

  push(chunk: WaveChunkView): void {
    const key = keyOf(chunk.source)
    let buffer = this.buffers.get(key)
    if (buffer === undefined) {
      if (this.buffers.size >= this.maxSources) {
        this.rejected++
        return
      }
      buffer = new WaveBuffer(chunk.source, this.options)
      this.buffers.set(key, buffer)
    }
    buffer.push(chunk)
  }

  /** 届いた順に並んだ溜め場所。 */
  buffersInOrder(): readonly WaveBuffer[] {
    return [...this.buffers.values()]
  }

  get(key: WaveSourceKey): WaveBuffer | null {
    return this.buffers.get(keyOf(key)) ?? null
  }

  /** 全部を通した時間の範囲。1 本も無ければ null。 */
  range(): WaveRange | null {
    let fromMs: number | null = null
    let toMs: number | null = null
    for (const buffer of this.buffers.values()) {
      const range = buffer.range()
      if (range === null) continue
      if (fromMs === null || range.fromMs < fromMs) fromMs = range.fromMs
      if (toMs === null || range.toMs > toMs) toMs = range.toMs
    }
    if (fromMs === null || toMs === null) return null
    return { fromMs, toMs }
  }
}

/**
 * 波形 1 本を指す鍵。
 *
 * **`streamKey` では分けない。** あれには基板の起動 ID が入るので、再起動のたびに
 * 同じセンサーが別の行に割れる。区間が変わったことは切れ目の印で伝わる。
 *
 * **区切り文字ではなく長さを前に置く。** `boardKey`・`sensorId` は無認証の UDP パケット
 * 由来で、文字種の検証を持たない（`stationConfig.ts` の `nonEmptyString` は空でないこと
 * しか見ない）。**「この文字は現れない」と言い切れる区切りが無い**ので、区切り文字で繋ぐと
 * 別々のセンサーが同じ鍵に化けうる —— 症状は「2 本の波形が 1 本へ混ざる」で、
 * 画面では**片方が黙っただけ**にしか見えない。
 *
 * **種別の印（`s:` / `t:`）を先頭へ置く。** 観測点の識別子とセンサーの鍵が同じ
 * 文字列に化けると、合成の波形とセンサー単独の波形が同じ行へ混ざる。
 *
 * **画面側（`viewWaves.ts`）も同じものを使う。** 同じ規則を 2 箇所に書くと、片方だけ
 * 直したときに「表示の選択が別の波形へ当たる」形で静かに食い違う。
 */
export function keyOf(key: WaveSourceKey): string {
  if (key.kind === 'station') return `t:${key.stationId}`
  return `s:${key.boardKey.length}:${key.boardKey}${key.sensorId}`
}
