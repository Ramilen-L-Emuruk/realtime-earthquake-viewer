// 自作地震計ホストから届く観測点の合成波形を、直近ぶんだけ環状に抱える入れ物。
//
// **絵にするのは「いまの直前」だけ。** 押し出しは止めなければ延々と届くので、
// 溜める作りは端末のメモリが膨らむ方向にしか倒れない（ホスト側が
// `seismo-host/src/receiver/readingHub.ts` で「溜めない」と決めているのと同じ判断）。
//
// **位置は「直前のまとまりとの相対」で測る。起点からの絶対通番では測らない。**
// 絶対通番（起点の時刻 ＋ 固定した刻み × 通番）で置く形を一度書き、敵対的レビューが
// 数値で覆した ——
//
//   - ホスト側の刻みは区間の当てはめが進むたびわずかに動く（実機の実測でセンサー
//     9 本が 10.0018〜10.0174 ms・幅 0.16%）。**これは正常な振る舞い**なので許容幅を
//     置いたが、**許容した値を通番の計算へ反映していなかった** —— 起点を引いた時点の
//     刻みで割り続けるので、丸めの誤差が単調に積み上がる
//   - 実測: その幅（0.16%）で 2000 まとまり（約 10 分）流すと**偽の隙間が 94 回**。
//     最初の 1 回は 10 まとまり目（約 3 秒後）に出た
//
// つまり**連続して届いているデータを欠測に見せる**形で、この入れ物が避けたいと
// 書いていた症状（欠測を詰めて「そこだけ時間の縮んだ絵」にする）の裏返しだった。
// 相対で測れば誤差は 1 まとまりぶんで打ち切られ、積み上がらない。
//
// **欠測は欠測のまま描く。** 届かなかった区間は {@link SeismoWaveWindow.gal} へ `NaN` で
// 残す（`seismoStream.ts` の `readFiniteArray` が「1 点でも読めなければまとまりごと捨てる」
// と決めているのと同じ理由 —— 詰めて繋ぐと、絵としては普通に見えるので見ている人には
// 確かめる手立てが無い）。
//
// **穴は後から埋められる**（{@link SeismoWaveBuffer.fill}・#597）。ホストが取り戻した区間の合成波形を
// 作り直したら、そこを `/waves` から取って**穴の位置へだけ**書く。そのために各サンプルの時刻を
// 一緒に持つ —— 上に書いた理由で、位置から「起点 ＋ 刻み × 位置」で時刻を逆算すると、刻みの揺らぎが
// 60 秒で 1〜2 サンプルぶんのずれに積もる。

/**
 * 刻み（`msPerSample`）が変わったと見なす比率。
 *
 * **わずかな変動では作り直さない**（上のヘッダに書いた実機の実測値）。一方、
 * **本当に刻みが変わる場合は倍か半分**になる（サンプリング周波数の設定を変えた・
 * 別種のセンサーが駆動役になった）。5% はその間に取った値で、どちらの側にも
 * 1 桁ぶんの余裕がある。
 *
 * **許容した変動は取り込む**（{@link SeismoWaveBuffer.push} が最新へ進める）。
 * 取り込まないと、ヘッダに書いた誤差の蓄積が起きる。
 */
const SAMPLE_INTERVAL_TOLERANCE = 0.05

/** 読み出した窓。**時刻の昇順に並べ直したもの。** */
export interface SeismoWaveWindow {
  /** 先頭サンプルの時刻。 */
  readonly firstSampleMs: number
  /** 1 サンプルあたりのミリ秒。**いちばん新しいまとまりが名乗った値。** */
  readonly msPerSample: number
  /**
   * 3 成分の加速度（gal）。**届いていない区間は `NaN`。**
   *
   * `NaN` を 0 で埋めないこと —— 0 は「揺れていない」を意味してしまい、
   * 届かなかったことと区別が付かなくなる。
   *
   * **描く側は `NaN` で線を切ること。** Canvas 2D の `lineTo` は非有限の座標を渡すと
   * 何もしない（no-op）ので、前後の有効な点がそのまま 1 本の線で結ばれる ——
   * つまり**欠測を分けて持った意味が描画で消える**。
   */
  readonly gal: readonly [Float32Array, Float32Array, Float32Array]
  /**
   * そのサンプルへ実際に効いたセンサーの本数。**`gal` と同じ長さ・届いていない区間は 0。**
   *
   * 1 のところは合成の裏付けが無い（駆動役だけの値）。
   */
  readonly memberCount: Float32Array
}

/** 抱えるまとまり 1 つ。**`seismoStream.ts` の `SeismoStationWave` から時刻と値だけを取る。** */
export interface SeismoWaveChunk {
  readonly firstSampleMs: number
  readonly msPerSample: number
  readonly gal: readonly [readonly number[], readonly number[], readonly number[]]
  readonly memberCount: readonly number[]
}

/**
 * 穴を埋めるのに使うまとまり 1 つ（`GET /waves` を素のまま読んだもの）。**欠けたサンプルは `NaN`。**
 *
 * {@link SeismoWaveChunk} と別に置くのは、取り戻した側の値が `Float32Array` で来るから
 * （`services/seismoWaveSamples.ts`）。どちらも満たす形にしてある。
 */
export interface SeismoWaveFillChunk {
  readonly firstSampleMs: number
  readonly msPerSample: number
  readonly gal: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>]
  readonly memberCount: ArrayLike<number>
}

/** 穴を覆う範囲 `[fromMs, toMs)`。始まりは最初の穴の時刻、終わりは最後の穴の 1 サンプル先。 */
export interface SeismoWaveHoleSpan {
  readonly fromMs: number
  readonly toMs: number
}

/** {@link SeismoWaveBuffer.push} が何をしたか。**試験と記録のために返す。** */
export type SeismoWavePushResult =
  /** そのまま繋いだ。 */
  | { readonly kind: 'appended' }
  /** 隙間を空けて繋いだ（届いていない区間がある）。 */
  | { readonly kind: 'gap'; readonly missingSamples: number }
  /** 一部が既に置いた区間だったので、そこだけ捨てて残りを繋いだ。 */
  | { readonly kind: 'overlap'; readonly droppedSamples: number }
  /** 起点から作り直した。 */
  | { readonly kind: 'restarted'; readonly why: string }
  /** 全部が既に置いた区間（または空のまとまり）なので捨てた。 */
  | { readonly kind: 'stale' }

/**
 * 抱えている間に起きたことの数え上げ。**0 でなければ受け取る側が出す値。**
 *
 * **持たせる理由。** 上の {@link SeismoWavePushResult} は 1 件ごとの結果なので、
 * 呼び手が捨てれば何も残らない —— 実際、敵対的レビューが見つけた 2 つの不具合
 * （偽の隙間が数秒ごと・巻き戻り中にデータが全損）は**どちらも `gap` と `stale` と
 * してしか観測できなかった**。ホスト側が `rewindCount`・`droppedByCountLimit` を
 * 状態の口へ出しているのと同じ手当て（`seismo-host/src/admin/waveBuffer.ts`）。
 *
 * **捨てない**（`clear()` でも残す）。累計なので、繋ぎ直しをまたいで数える。
 */
export interface SeismoWaveTally {
  /**
   * 届かなかったサンプルのうち、埋まらなかったものの累計。
   *
   * **埋めた分（{@link SeismoWaveBuffer.fill}）はここから引く**（2026-10-07 ユーザー承認）。
   * 引かないと、穴の無い絵に「欠測」の数字が並ぶ。埋まらないまま窓の外へ流れた穴は残る。
   */
  readonly gapSamples: number
  /** 起点から作り直した回数。 */
  readonly restarts: number
  /** 既に置いた区間として捨てたサンプルの累計。 */
  readonly droppedSamples: number
}

/**
 * 値を置く場所。**刻みが決まってから作る。**
 *
 * **3 つをまとめて持つ。** 別々の欄にすると、書き込む側が毎回 3 つとも
 * 「まだ作っていないかもしれない」扱いで受けることになる —— その分岐は
 * {@link SeismoWaveBuffer.push} が場所を作ってから呼ぶので**到達できず**、
 * 通らない道の書き方だけが残る。
 */
interface WaveSlots {
  readonly gal: readonly [Float32Array, Float32Array, Float32Array]
  readonly memberCount: Float32Array
  /**
   * 各サンプルの時刻。**届いた値はまとまりが名乗る時刻、穴は前後の届いた値の間へ均した時刻。**
   * 穴を埋めるとき（{@link SeismoWaveBuffer.fill}）に、取り戻した値の時刻と突き合わせるために持つ。
   */
  readonly timeMs: Float64Array
  /** 抱えるサンプル数。 */
  readonly capacity: number
}

/**
 * 観測点 1 つぶんの合成波形を、直近の一定時間だけ抱える環状の入れ物。
 *
 * **観測点ごとに 1 つ持つ。** 刻みも起点も観測点ごとに違う（駆動役のセンサーが
 * 決める）ので、まとめて 1 本にはできない。
 */
export class SeismoWaveBuffer {
  private slots: WaveSlots | null = null
  /** 抱えている最も古いサンプルの時刻。 */
  private firstMs = 0
  /** 最後に置いたサンプルの時刻。**次に来るべき時刻はこれ ＋ 刻み。** */
  private lastMs = 0
  /** いまの刻み。**許容範囲内の変動は取り込む。** */
  private msPerSample = 0
  /** 次に書く環状の位置。 */
  private writeAt = 0
  private count = 0
  private gapSamples = 0
  private restarts = 0
  private droppedSamples = 0

  /**
   * @param retainSec 抱える長さ（秒）。**この長さを超える隙間は作り直しと同じ**
   *   （埋めても全部が「届いていない」になるため）。
   */
  constructor(private readonly retainSec: number) {}

  /** 抱えているサンプル数。**隙間も数に入る。** */
  get sampleCount(): number {
    return this.count
  }

  /** 最後に置いたサンプルの時刻。**1 つも無ければ `null`。** */
  get lastSampleMs(): number | null {
    return this.count === 0 ? null : this.lastMs
  }

  /** 起きたことの数え上げ。 */
  get tally(): SeismoWaveTally {
    return {
      gapSamples: this.gapSamples,
      restarts: this.restarts,
      droppedSamples: this.droppedSamples,
    }
  }

  /** 1 まとまりを置く。 */
  push(chunk: SeismoWaveChunk): SeismoWavePushResult {
    const length = chunk.gal[0].length
    // **空のまとまりは何もしない。** 起点だけ進めると、次のまとまりとの間に
    // 意味の無い隙間ができる。
    if (length === 0) return { kind: 'stale' }

    // **数として読めない時刻・刻みは入口で弾く。**
    //
    // 押し出し経由では起きない（`seismoStream.ts` の `readStationWave` が
    // `Number.isFinite` で弾き、JSON も `NaN` を書けない）。それでも見るのは、
    // **この入れ物が独立した部品**で、別の呼び手が来うるから ——
    // 通すと下の `offset` が `NaN` になり、**大小の比較がすべて偽**になるので
    // 最後の枝（重なりの受け入れ）へ落ちて `droppedSamples` が `NaN` へ化ける。
    // そこが `NaN` になると受け取る側の等値比較（`sameTally`）が常に「違う」を
    // 返し、**毎巡回で画面を差し替え続ける**（`NaN !== NaN`）。
    if (!Number.isFinite(chunk.firstSampleMs) || !(chunk.msPerSample > 0)) {
      this.droppedSamples += length
      return { kind: 'stale' }
    }

    /** 起点を引き直して置く。**この経路はいつでも成功する。** */
    const restartWith = (why: string): SeismoWavePushResult => {
      this.restarts += 1
      this.write(this.restart(chunk), chunk, 0)
      return { kind: 'restarted', why }
    }

    const slots = this.slots
    if (slots === null) return restartWith('最初のまとまり')

    // **刻みが大きく変われば作り直す。** 位置は刻みを前提に測っているので、
    // 別の刻みのサンプルを同じ軸へ混ぜると時間軸が壊れる。
    if (
      Math.abs(chunk.msPerSample - this.msPerSample) / this.msPerSample >
      SAMPLE_INTERVAL_TOLERANCE
    ) {
      return restartWith(`刻みが変わった（${this.msPerSample} → ${chunk.msPerSample} ms）`)
    }
    // **許容した変動はここで取り込む。** 効くのは 2 箇所 ——
    // 下の `offset` の分母（判定の物差しを実態に合わせる）と、`snapshot()` が返す
    // 刻み（描く側が横軸を引くのに使う）。
    //
    // **誤差の蓄積を止めているのはここではない。** 止めているのは「直前との相対で
    // 測る」ことと、`write` が末尾の時刻を**まとまり自身が名乗る値から引く**こと ——
    // 置いた数から積み上げる形に変えると、この取り込みがあっても偽の隙間が
    // 数秒ごとに出る（実測で 10 分に 94 回。試験の「10 分ぶんを流す」がそれを見ている）。
    this.msPerSample = chunk.msPerSample

    // **直前の続きとして測る。** 次に来るべき時刻との差をサンプル数へ直す。
    const expectedMs = this.lastMs + this.msPerSample
    const offset = Math.round((chunk.firstSampleMs - expectedMs) / this.msPerSample)

    if (offset >= 0) {
      // **隙間が抱える長さを超えたら作り直す。** 埋めても全部が「届いていない」に
      // なるので、環状に書き回す手間だけが残る。
      if (offset >= slots.capacity) return restartWith(`${offset} サンプルぶん届かなかった`)
      if (offset > 0) {
        this.fillGap(slots, offset, chunk.firstSampleMs)
        this.write(slots, chunk, 0)
        return { kind: 'gap', missingSamples: offset }
      }
      this.write(slots, chunk, 0)
      return { kind: 'appended' }
    }

    const overlap = -offset
    // **1 まとまりを超えて巻き戻ったら作り直す。** ホストを入れ替えた・再起動した・
    // 時刻を補正した場合に起きる。
    //
    // **ここを緩めないこと。** 緩めた形（抱える長さの 2 倍ぶん巻き戻るまで作り直さない）を
    // 一度書き、敵対的レビューが数値で覆した —— 5 秒の巻き戻りで**新しく届いたデータを
    // 17 まとまり（510 サンプル）続けて捨て**、回復したときに申告する欠測は 10 サンプル
    // だけだった（損失を 50 分の 1 に見せる）。ホスト側
    // （`seismo-host/src/admin/waveBuffer.ts`）は巻き戻りを 1 件でも見たら捨てて数え直す
    // 作りで、こちらだけが緩いうえに**緩い間は新しいデータを落とす**形だった。
    if (overlap > length) {
      return restartWith(`時刻が ${overlap} サンプルぶん巻き戻った`)
    }
    // **全部が既に置いた区間。** 刻みの推定が進むと同じ区間の時刻がわずかに動くので、
    // これは正常に起きうる。
    if (overlap === length) {
      this.droppedSamples += length
      return { kind: 'stale' }
    }
    // **重なった分だけ捨てて、残りは置く。** まとまりごと捨てると、まだ誰も書いて
    // いない末尾の新規分まで失う —— そこを捨てる理由は無い。
    //
    // **重なった部分は上書きしない。** 重なりだけ新しい推定で書くと、境目で値の
    // 出どころが変わる（同じ絵の中に 2 つの推定が混ざる）。
    this.droppedSamples += overlap
    this.write(slots, chunk, overlap)
    return { kind: 'overlap', droppedSamples: overlap }
  }

  /** 抱えているぶんを時刻の昇順に並べて返す。**1 つも無ければ `null`。** */
  snapshot(): SeismoWaveWindow | null {
    const slots = this.slots
    if (slots === null || this.count === 0) return null

    const count = this.count
    const out: [Float32Array, Float32Array, Float32Array] = [
      new Float32Array(count),
      new Float32Array(count),
      new Float32Array(count),
    ]
    const outMembers = new Float32Array(count)
    const start = this.oldestSlot(slots)
    for (let i = 0; i < count; i += 1) {
      const slot = (start + i) % slots.capacity
      out[0][i] = slots.gal[0][slot]
      out[1][i] = slots.gal[1][slot]
      out[2][i] = slots.gal[2][slot]
      outMembers[i] = slots.memberCount[slot]
    }
    return {
      firstSampleMs: this.firstMs,
      msPerSample: this.msPerSample,
      gal: out,
      memberCount: outMembers,
    }
  }

  /**
   * 取り戻した値で穴を埋める。**埋めたサンプル数を返す。**
   *
   * **穴（届かなかったところ）へだけ書く。** 届いた値は、取り戻した値が重なっていても上書きしない
   * —— 同じ時刻の値は作り直しでも変わらないはずで、入れ替えても得るものが無い（境目のずれ
   * （実機で ±5 ms）のぶん、かえって絵が動く）。
   *
   * **時刻で突き合わせる。** 穴ごとに、取り戻した値のうち時刻が最も近いサンプルを採り、
   * 半サンプルを超えて離れていれば採らない。読めない値（`NaN`）のサンプルでは埋めない。
   *
   * @param chunks 時刻の昇順でなくてもよい。
   */
  fill(chunks: readonly SeismoWaveFillChunk[]): number {
    const slots = this.slots
    if (slots === null || this.count === 0) return 0
    const usable = chunks
      .filter((c) => Number.isFinite(c.firstSampleMs) && c.msPerSample > 0 && c.gal[0].length > 0)
      .slice()
      .sort((a, b) => a.firstSampleMs - b.firstSampleMs)
    if (usable.length === 0) return 0

    let filled = 0
    let at = 0
    const start = this.oldestSlot(slots)
    for (let i = 0; i < this.count; i += 1) {
      const slot = (start + i) % slots.capacity
      if (!Number.isNaN(slots.gal[0][slot])) continue
      const t = slots.timeMs[slot]
      // **穴の時刻は昇順に並ぶ**ので、まとまりの指し先は戻さなくてよい。
      while (at < usable.length - 1 && endMs(usable[at]) + usable[at].msPerSample / 2 < t) at += 1
      const c = usable[at]
      const j = Math.round((t - c.firstSampleMs) / c.msPerSample)
      if (j < 0 || j >= c.gal[0].length) continue
      if (Math.abs(c.firstSampleMs + j * c.msPerSample - t) > c.msPerSample / 2) continue
      const ns = c.gal[0][j]
      const ew = c.gal[1][j]
      const ud = c.gal[2][j]
      if (!Number.isFinite(ns) || !Number.isFinite(ew) || !Number.isFinite(ud)) continue
      slots.gal[0][slot] = ns
      slots.gal[1][slot] = ew
      slots.gal[2][slot] = ud
      slots.memberCount[slot] = c.memberCount[j]
      filled += 1
    }
    this.gapSamples -= filled
    return filled
  }

  /**
   * `[fromMs, toMs)` に時刻のある穴を覆う範囲。**穴が無ければ `null`。**
   *
   * 取り戻した区間の知らせを受けたとき、取りに行くかどうかと、どこを取るかを決めるのに使う。
   * 返す範囲も半開区間で、終わりは最後の穴の 1 サンプル先（そのまま `/waves` の `to` へ渡せる）。
   */
  holesIn(fromMs: number, toMs: number): SeismoWaveHoleSpan | null {
    const slots = this.slots
    if (slots === null || this.count === 0) return null
    let first: number | null = null
    let last: number | null = null
    const start = this.oldestSlot(slots)
    for (let i = 0; i < this.count; i += 1) {
      const slot = (start + i) % slots.capacity
      if (!Number.isNaN(slots.gal[0][slot])) continue
      const t = slots.timeMs[slot]
      if (t < fromMs || t >= toMs) continue
      first ??= t
      last = t
    }
    return first === null || last === null ? null : { fromMs: first, toMs: last + this.msPerSample }
  }

  /** 中身を捨てる。**次のまとまりが起点を決める。数え上げは残す。** */
  clear(): void {
    this.slots = null
    this.msPerSample = 0
    this.writeAt = 0
    this.count = 0
  }

  /** いちばん古いサンプルの環状の位置。**`writeAt` は次に書く場所**なので、抱えている数だけ戻る。 */
  private oldestSlot(slots: WaveSlots): number {
    return (this.writeAt - this.count + slots.capacity) % slots.capacity
  }

  /** 起点と刻みを引き直して場所を作る。**作った場所を返す。** */
  private restart(chunk: SeismoWaveChunk): WaveSlots {
    // **容量は 1 サンプル以上にする。** 刻みが保持長より大きい（極端に粗い）まとまりでも
    // 剰余の除数が 0 にならないように。
    const wanted = Math.max(1, Math.ceil((this.retainSec * 1000) / chunk.msPerSample))
    // **まとまり 1 つが入らない容量では、抱える意味が無い。** 押し出しの 1 まとまりは
    // 実測で 30 サンプル（0.3 秒ぶん）なので通常は起きないが、保持長を短く
    // 設定されたときに黙って先頭が欠けるのを避ける。
    const capacity = Math.max(wanted, chunk.gal[0].length)
    const slots: WaveSlots = {
      gal: [new Float32Array(capacity), new Float32Array(capacity), new Float32Array(capacity)],
      memberCount: new Float32Array(capacity),
      timeMs: new Float64Array(capacity),
      capacity,
    }
    this.slots = slots
    this.msPerSample = chunk.msPerSample
    this.writeAt = 0
    this.count = 0
    this.firstMs = chunk.firstSampleMs
    // **`lastMs` は「このまとまりの 1 つ手前」に置く。** こうすると `write` が置いた
    // あとの `lastMs` が、続きのまとまりと同じ規則で測れる。
    this.lastMs = chunk.firstSampleMs - chunk.msPerSample
    return slots
  }

  /**
   * 届かなかった区間を「届いていない」で埋める。
   *
   * **時刻は進めない。** 呼び出しの直後に {@link write} が走り、末尾の時刻を
   * **まとまり自身が名乗る値から**引き直す（置いた数からは積み上げない）——
   * ここで進めても必ず上書きされる。
   *
   * 一度ここで `lastMs += missing * msPerSample` を足し、コメントに
   * 「進めないと次のまとまりが前へずれる」と書いていた。**実装を追うとその行は
   * 効いていなかった**（敵対的レビューが削除して挙動が変わらないことを実測した）。
   */
  private fillGap(slots: WaveSlots, missing: number, nextMs: number): void {
    this.gapSamples += missing
    // **穴の時刻は、前後の届いた値の間へ均して置く**（後で埋めるときの突き合わせに使う）。
    // 刻みを固定して積むと、隙間の測り方（丸め）のぶんだけ次の届いた値とずれる。
    const step = (nextMs - this.lastMs) / (missing + 1)
    for (let i = 1; i <= missing; i += 1) this.writeSample(slots, NaN, NaN, NaN, 0, this.lastMs + i * step)
  }

  /** まとまりの `from` 番目から末尾までを置く。 */
  private write(slots: WaveSlots, chunk: SeismoWaveChunk, from: number): void {
    const length = chunk.gal[0].length
    for (let i = from; i < length; i += 1) {
      this.writeSample(
        slots,
        chunk.gal[0][i],
        chunk.gal[1][i],
        chunk.gal[2][i],
        chunk.memberCount[i],
        chunk.firstSampleMs + i * chunk.msPerSample,
      )
    }
    // **末尾の時刻は、まとまり自身が名乗る値から引く。** 置いた数から積み上げると、
    // 捨てた重なりの分だけずれる。
    this.lastMs = chunk.firstSampleMs + (length - 1) * chunk.msPerSample
  }

  /** 1 サンプルを次の場所へ置き、抱える長さを超えたぶんを押し出す。 */
  private writeSample(
    slots: WaveSlots,
    ns: number,
    ew: number,
    ud: number,
    members: number,
    timeMs: number,
  ): void {
    slots.gal[0][this.writeAt] = ns
    slots.gal[1][this.writeAt] = ew
    slots.gal[2][this.writeAt] = ud
    slots.memberCount[this.writeAt] = members
    slots.timeMs[this.writeAt] = timeMs
    this.writeAt = (this.writeAt + 1) % slots.capacity
    if (this.count < slots.capacity) {
      this.count += 1
    } else {
      // 抱える長さを超えたので、いま書いた場所が最も古いサンプルを上書きした。
      this.firstMs += this.msPerSample
    }
  }
}

/** まとまりの最後のサンプルの時刻。 */
function endMs(chunk: SeismoWaveFillChunk): number {
  return chunk.firstSampleMs + (chunk.gal[0].length - 1) * chunk.msPerSample
}
