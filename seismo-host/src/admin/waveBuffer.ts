// 押し出された波形を、画面で見るぶんだけ溜める。
//
// **溜め場所はブラウザだけ。** 「波形」タブはホストの保存を読み返さないので
// （保存した波形は「波形の記録」タブの担当）、**繋いでから受け取った分しか遡れない** ——
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
   * **観測点の合成（`kind: 'station'`）では null。** 合成は観測点の目盛り（絶対時刻）の上で
   * 作るので、区間という単位を持たない（`sensorFusion.ts` の冒頭を見ること）。
   * **無いものを埋めない** —— 連続性は時刻の隔たりで見る
   * （`CONTINUITY_TOLERANCE`）ので、この 2 つが無くても切れ目は検出できる。
   */
  readonly streamKey: string | null
  readonly segmentId: number | null
  /** 先頭サンプルの時刻。 */
  readonly firstSampleMs: number
  readonly msPerSample: number
  /** 時刻の当てはめを公称値へ倒したなら理由。当てはめた値を使っていれば null。 */
  readonly timebaseNominalReason: string | null
  /**
   * 値の並び。
   *
   * **`NaN` は「そのサンプルの値が無い」。** 出どころはセンサー対の差分・センサーのずれ・
   * 観測点の合成（測る向きが 3 方向へ散っていない間に解けなかった成分）で、どれも
   * `sensorFusion.ts` が値を出せないサンプルを `null` にしたもの（外挿しない）。
   * センサー単独では現れない —— あちらは受け口（`waveStream.ts` の `readFiniteArray`）が
   * 非有限を通さない。
   *
   * **`0` で埋めない。** 差分の 0 は「2 台がぴったり一致した」を意味してしまう。
   * 畳み込み（`readWindow`）は `NaN` を飛ばし、**その先の列へ切れ目の印を立てる**
   * ——飛ばして詰めると、そこだけ時間が縮んだ絵になる。
   *
   * **本数は 2 通り。** 東・北・上の 3 本（`directions` が null）か、センサーの軸の本数ぶん
   * （`directions` が非 null。2 軸のセンサーで、地面の 3 成分を解けない）。
   */
  readonly gal: readonly (readonly number[])[]
  /**
   * 軸ごとの、地面（東・北・上）で見た測る向き（長さ 1）。**`gal` が東・北・上なら null。**
   *
   * **null のときだけ X・Y・Z の段へ描く。** 向きが東・北・上に揃っていない値を同じ段へ
   * 重ねると、斜めに測った値を東や北の値として読ませることになる。
   */
  readonly directions: readonly (readonly [number, number, number])[] | null
  /**
   * 軸の名前（基板が名乗る `channels`）。`directions` と同じときだけ非 null で、並びも同じ。
   *
   * **東・北・上の値には持たせない。** 校正の回転を通した後の値は共通座標で、センサーが
   * 名乗る軸名はもう当てはまらない。
   */
  readonly axisNames: readonly string[] | null
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
   * センサー対の差分（同 §7・#372）。**`d = (a − b) / 2`。**
   *
   * **観測点も持つ。** 同じセンサーを 2 つの観測点へ割り当てた設定では、顔ぶれが
   * 同じでも別の合成に属する差分になる。
   */
  | {
      readonly kind: 'pair'
      readonly stationId: string
      readonly boardKeyA: string
      readonly sensorIdA: string
      readonly boardKeyB: string
      readonly sensorIdB: string
    }
  /**
   * センサー 1 台ぶんのずれ（同 §7・#688）。**測った値 − ほかのセンサーで解いた揺れをその軸へ写した値。**
   * 観測点を持つ理由は `'pair'` と同じ。
   */
  | { readonly kind: 'residual'; readonly stationId: string; readonly boardKey: string; readonly sensorId: string }

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
  /** 軸ごとの値。本数は溜め場所の `axisCount`。 */
  readonly gal: readonly Float32Array[]
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
  /** 溜めている値の本数。**まだ何も溜めていなければ 0。** */
  private axes = 0
  private lastDirections: readonly (readonly [number, number, number])[] | null = null
  private lastAxisNames: readonly string[] | null = null

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

  /**
   * 最後に届いたまとまりの、軸ごとの測る向き。**東・北・上の値なら null**（`WaveChunkView.directions`）。
   * まだ何も届いていなければ null。
   */
  get directions(): readonly (readonly [number, number, number])[] | null {
    return this.lastDirections
  }

  /** 最後に届いたまとまりの軸の名前。`directions` と同じときだけ非 null。 */
  get axisNames(): readonly string[] | null {
    return this.lastAxisNames
  }

  push(chunk: WaveChunkView): void {
    // **いちばん短い本に合わせる。** 欄の長さが揃っていない値が来たとき、
    // 長いほうに合わせると無い所を読むことになる。
    if (chunk.gal.length === 0) return
    let length = Infinity
    for (const column of chunk.gal) length = Math.min(length, column.length)
    if (length === 0) return

    // **値の形（本数・東北上かどうか・測る向き）が変わったら、溜めていたものを捨てて積み直す。**
    // 本数の違うまとまりを 1 本の溜め場所へ並べると、切り出しが軸を取り違える。同じ名前の
    // センサーを別の種類へ挿し替えたときにしか起きない。**測る向きが変わったとき**（設定の
    // 書き換え）も捨てる —— 残すと、前の向きで測った値が新しい向きの凡例の下に描かれる。
    const ground = chunk.directions === null
    let reshaped = false
    if (
      this.count > 0 &&
      (chunk.gal.length !== this.axes ||
        ground !== (this.lastDirections === null) ||
        !sameDirections(chunk.directions, this.lastDirections))
    ) {
      this.clear()
      reshaped = true
    }
    this.axes = chunk.gal.length
    this.lastDirections = chunk.directions
    this.lastAxisNames = chunk.axisNames

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
      gal: chunk.gal.map((column) => Float32Array.from(column.slice(0, length))),
      // **捨てた直後の 1 つは切れ目にする。** `isGap` は手前のチャンクと比べるが、
      // 捨てた後は比べる相手が無く必ず「続き」と答える —— **5 分ぶんが消えたのに
      // 「普通に波形が始まった」としか見えない**（レビューが 2 本とも指した形）。
      gapBefore: rewound || reshaped || this.isGap(chunk),
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
    // **本数は溜めている値の本数。** まだ何も溜めていなければ東・北・上の 3 本ぶんの空を返す
    // （受け手がどちらの段でも空として扱えるように）。
    const axisCount = this.axes === 0 ? 3 : this.axes
    const empty: WaveWindow = {
      axes: Array.from({ length: axisCount }, () => []),
      timebaseNominal: false,
      stats: new Array<WaveAxisStats | null>(axisCount).fill(null),
    }
    if (columnCount <= 0 || !(toMs > fromMs)) return empty

    const span = toMs - fromMs
    const axes: (WaveColumn | null)[][] = Array.from({ length: axisCount }, () =>
      new Array<WaveColumn | null>(columnCount).fill(null),
    )
    let nominal = false
    // **軸ごとに「直前のサンプルが欠けていたか」を覚える。** 欠けを飛ばすだけだと
    // 前後が線で繋がり、**欠測を分けて持った意味が描画で消える**（`gal` の説明を
    // 見ること）。次に値があったサンプルの列へ切れ目の印を立てる。
    const missing = new Array<boolean>(axisCount).fill(false)
    // 軸ごとの合計・件数・上下。**平均からの最大の隔たりは、全体の上下と平均から
    // 正確に出せる**（どちらか遠いほうを採る）ので、走査は 1 度で済む。
    const sum = new Array<number>(axisCount).fill(0)
    const counts = new Array<number>(axisCount).fill(0)
    const lowest = new Array<number>(axisCount).fill(Number.POSITIVE_INFINITY)
    const highest = new Array<number>(axisCount).fill(Number.NEGATIVE_INFINITY)

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

        for (let axis = 0; axis < axisCount; axis++) {
          const value = chunk.gal[axis]![i]!
          // **値が無いサンプルは、切れ目の借りを作って飛ばす。** `Math.min`/`Math.max`
          // へ `NaN` を渡すと列ごと `NaN` に化け、平均も隔たりも壊れる。
          if (Number.isNaN(value)) {
            missing[axis] = true
            continue
          }
          const brokeHere = gapBefore || missing[axis]
          missing[axis] = false
          const previous = axes[axis][column]
          axes[axis][column] =
            previous === null
              ? { minGal: value, maxGal: value, gapBefore: brokeHere }
              : {
                  minGal: Math.min(previous.minGal, value),
                  maxGal: Math.max(previous.maxGal, value),
                  gapBefore: previous.gapBefore || brokeHere,
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
    // `axes`・向き・名前は戻さない —— 呼んだ側（`push`）が直後に今のまとまりの形で書き直す。
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

  /**
   * 1 本を捨てる。**居なければ何もしない。**
   *
   * **見るのをやめた差分の組を落とすために要る**（#372）。上限は 32 本で、
   * 実機はセンサー 9 本＋合成 1 本＋全ペア 36 組 —— 落とさずに切り替え続けると
   * **22 組めから新しい組が上限で断られ、「選んだのに何も出ない」形になる**
   * （`rejected` は数えるが、画面には上限に達した事実しか出ない）。
   */
  remove(key: WaveSourceKey): void {
    this.buffers.delete(keyOf(key))
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
  if (key.kind === 'residual') {
    // 長さを前に置く理由は `'pair'` と同じ（区切り文字に使える文字が無い）。
    return `r:${key.stationId.length}:${key.stationId}${key.boardKey.length}:${key.boardKey}${key.sensorId}`
  }
  if (key.kind === 'pair') {
    // **4 つとも長さを前に置く。** 上と同じ理由で、区切り文字は使えない
    // ——`boardKey`・`sensorId` に「現れない」と言い切れる文字が無い。
    //
    // **A と B は決まった順へ並べ替える。** 押し出す側（`readingHub.ts` の `pairMatches`）は
    // **向きを問わない** ので、同じ 2 台の組が A-B と B-A の両方の向きで届きうる ——
    // 届く向きは設定に並んだセンサーの順で決まり（`sensorFusion.ts` の `buildPairDiffs` が
    // `group.members` の配列順で回す。その並びは `config.boards` → 各 `sensors` の
    // 並び順そのままで、正規化していない）、**設定を編集すると入れ替わる。**
    //
    // **鍵が向きで変わると、その瞬間に同じ組が 2 行へ割れる。** 片方は凍結したまま残り、
    // 消す番も来ない —— 選択が指すのは片方の鍵だけなので、組を切り替えたときの
    // `WaveStore.remove` はもう一方に届かない。画面には同じ 2 台の行が 2 つ並び、
    // 読み込み直すまで消えない。
    const a = `${key.boardKeyA.length}:${key.boardKeyA}${key.sensorIdA.length}:${key.sensorIdA}`
    const b = `${key.boardKeyB.length}:${key.boardKeyB}${key.sensorIdB.length}:${key.sensorIdB}`
    const [first, second] = a <= b ? [a, b] : [b, a]
    return `d:${key.stationId.length}:${key.stationId}${first}${second}`
  }
  return `s:${key.boardKey.length}:${key.boardKey}${key.sensorId}`
}

/** 測る向きが同じか。**どちらも東・北・上（null）なら同じ。** 同じ計算から来るので完全一致で見る。 */
function sameDirections(
  a: readonly (readonly [number, number, number])[] | null,
  b: readonly (readonly [number, number, number])[] | null,
): boolean {
  if (a === null || b === null) return a === b
  if (a.length !== b.length) return false
  return a.every((d, j) => d[0] === b[j]![0] && d[1] === b[j]![1] && d[2] === b[j]![2])
}
