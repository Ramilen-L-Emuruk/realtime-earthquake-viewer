// センサー 1 個ずつの生存を覚える。
//
// **数え上げ（`packetTally.ts`）では代わりにならない。** あちらが持つのは件数で、
// 「いつ最後に声を聞いたか」は持たない。9 個のうち 1 個が黙っても、累計は止まるだけで
// 減りはしないので、**表を眺めても黙ったことに気づけない。**
//
// **覚える単位は基板ではなくセンサー。** 1 枚の基板に 3 個ぶら下がっていて、
// 1 個だけ死ぬことがある。基板で丸めると、残り 2 個が生きている限り健全に見える。
//
// **流れの鍵（`streamKey`）でも丸めない。** あれには起動 ID が入るので、基板が
// 再起動するたび同じセンサーが別の行に分かれ、**古い行が「黙ったセンサー」として
// 永久に残る。**

import type { BoardKey } from '../protocol/types'

/**
 * 覚えていられるセンサーの数。
 *
 * **`Segmenter` の流れの上限（64）と同じ値だが、数える単位は違う** —— あちらは
 * 基板 × センサー × 起動、こちらは起動を含まないので**必ずこちらのほうが少ない**。
 * 足りなくなることはない、という関係が根拠で、値が一致していること自体に意味はない
 * （`sourceRateLimit.ts` が同じ書き方をしている）。
 */
const MAX_SENSORS_DEFAULT = 64

/** センサー 1 個の様子。 */
export interface SensorHealth {
  readonly boardKey: BoardKey
  readonly sensorId: string
  /**
   * 最後にパケットが届いた時刻。**受け手の時計で測る。**
   *
   * 基板が名乗る時刻を使わない —— 黙ったかどうかを知りたいのに、その判断を
   * 相手の申告に預けることになる（時計が狂った基板ほど判定が効かなくなる）。
   */
  readonly lastPacketMs: number
  /** 最後に見た流れ。再起動すると変わる。 */
  readonly streamKey: string
  /**
   * 最後に届いたパケットの軸の本数。**まだパケットが届いていなければ `null`。**
   *
   * **設定ではなく届いた事実。** 管理コンソールが「登録」でカードを作るとき、この本数で
   * 欄を作る —— 2 軸のセンサー（IIS2ICLX）に 3 軸のカードを作って保存すると、軸の本数が
   * 食い違ってパケットを捨て続ける（`stationConfig.ts` の `resolveSensor`）。
   */
  readonly axisCount: number | null
  /**
   * 最後に**震度を出せた**区間。まだ 1 つも出ていなければ null。
   *
   * **パケットが届いただけの回には触らない。** 区間の番号が自然に手に入るのは震度が
   * 出た回だけで、届いただけの回に無理やり埋めると「0 番の区間」という実在しない値が
   * 混じる。いま開いている区間は、状態の口の `segments` が別に持っている。
   */
  readonly segmentId: number | null
  /**
   * 最後に出せた計測震度。**まだ 1 つも出ていなければ null。**
   *
   * パケットは届いているのに、ここがいつまでも null なら
   * 「送ってはいるが震度にならない」状態（区間が切れ続ける等）。
   */
  readonly lastIntensity: number | null
  /** その震度が代表する時刻。**こちらは基板が名乗る時間軸。** */
  readonly lastReadingAtMs: number | null
  /** 最後に出した震度で、時刻の当てはめが公称値へ倒れていたなら理由。 */
  readonly lastNominalReason: string | null
  /**
   * 震度そのものを出せない理由。出せているなら null。
   *
   * **`lastNominalReason` とは別の事実。** あちらは「時刻の当てはめが倒れた」で、
   * 震度自体は出ている。こちらは**震度が 1 つも出ない**理由（軸数が違う・流し込みを
   * 作れない）。
   *
   * **これが無いと、理由が起動直後の 1 行にしか残らない。** 区間が始まった回にしか
   * 返ってこない値なので、見逃すと「パケットは届くのに震度が出ない」状態が何日
   * 続いても、原因を知る手立てが無くなる。
   */
  readonly lastSkipReason: string | null
}

export interface SensorHealthBookOptions {
  readonly maxSensors?: number
  /** 時計。テストのために差し替える。 */
  readonly now?: () => number
}

interface Entry {
  readonly boardKey: BoardKey
  readonly sensorId: string
  lastPacketMs: number
  streamKey: string
  axisCount: number | null
  segmentId: number | null
  lastIntensity: number | null
  lastReadingAtMs: number | null
  lastNominalReason: string | null
  lastSkipReason: string | null
  /**
   * `lastSkipReason` を立てた区間。立っていなければ null。
   *
   * **「その理由より古い読み」を見分けるためだけに持つ。** 状態の口へは出さない ——
   * 運用者が読むのは理由そのもので、どの区間で立ったかは内部の判定材料。
   */
  skipStreamKey: string | null
  skipSegmentId: number | null
}

/** 覚えの鍵。**起動 ID を含めない。** */
function keyOf(boardKey: BoardKey, sensorId: string): string {
  return `${boardKey}|${sensorId}`
}

export class SensorHealthBook {
  private readonly maxSensors: number
  private readonly now: () => number
  /** `Map` の挿入順が「いちばん長く音沙汰が無い順」になるよう、触れたら入れ直す。 */
  private readonly entries = new Map<string, Entry>()
  private evictedCount = 0

  constructor(options: SensorHealthBookOptions = {}) {
    this.maxSensors = options.maxSensors ?? MAX_SENSORS_DEFAULT
    this.now = options.now ?? Date.now
  }

  /** パケットが届いた。**読み取りに通った回だけ呼ぶ**（誰のものか判るのはそこから）。 */
  notePacket(input: {
    readonly boardKey: BoardKey
    readonly sensorId: string
    readonly streamKey: string
    /** パケットの軸の本数（`packet.channels.length`）。 */
    readonly axisCount: number
  }): void {
    const entry = this.touch(input.boardKey, input.sensorId)
    entry.lastPacketMs = this.now()
    entry.streamKey = input.streamKey
    entry.axisCount = input.axisCount
  }

  /** 震度が 1 つ出た。 */
  noteReading(input: {
    readonly boardKey: BoardKey
    readonly sensorId: string
    readonly streamKey: string
    readonly segmentId: number
    readonly atMs: number
    readonly intensity: number | null
    readonly timebaseNominalReason: string | null
  }): void {
    // **いま届いているパケットの流れ以外の読みでは、何も進めない。**
    //
    // 覚えの鍵は起動 ID を含まないので、**同じセンサーの古い起動セッション**の
    // 締めくくりもここへ同じ入れ物で届く —— 区間の組み立ては枠の上限に達すると
    // いちばん長く音沙汰の無い流れを閉じ（`../timebase/segmenter.ts` の `evictOldest`）、
    // その締めくくりが `PacketOutcome.readings` に混ざる（**このパケットの流れとは
    // 限らない**）。受け取ると、何分も前の値で `lastIntensity` と `lastReadingAtMs` が
    // 巻き戻り、しかも `lastSkipReason` が消えて**壊れたセンサーが健全に見える**。
    //
    // **下の「古い区間」の門とは別の尺度。** あちらは同じ流れの中の前後で、
    // こちらは流れそのものの世代。どちらも同じ症状を作るが、**扱いは違う** ——
    // 同じ流れの旧区間はほんの数秒前の実測なので値は受け取る。こちらは
    // 任意に古いので受け取らない。
    const known = this.entries.get(keyOf(input.boardKey, input.sensorId))
    if (known !== undefined && known.streamKey !== '' && input.streamKey !== known.streamKey) return

    const entry = this.touch(input.boardKey, input.sensorId)
    entry.streamKey = input.streamKey
    entry.segmentId = input.segmentId
    // **窓の中身が足りずに `null` で出た回も「震度が出た」として覚える。**
    // 値を上書きしないのは、直前まで出ていた値を消さないため —— `lastReadingAtMs` が
    // 進んでいるのに `lastIntensity` が古い、という組は「いま値が出せていない」印になる。
    if (input.intensity !== null) entry.lastIntensity = input.intensity
    entry.lastReadingAtMs = input.atMs
    entry.lastNominalReason = input.timebaseNominalReason
    // **震度が出た＝出せない理由はもう無い。** 残すと、直った後も古い理由が居座る。
    //
    // **ただし、その理由より古い区間の読みでは消さない。** 区間が再開すると前の区間が
    // 閉じられ、末尾に溜まっていた窓が**同じパケットの中で**締めくくりとして吐き出される。
    // 新しい区間が「震度を出せない」と決まった回ほどこれが起きるので、無条件に消すと
    // **壊れたセンサーが「つい今しがた震度を出したばかり」に見える**（`lastReadingAtMs` も
    // 同時に進むので、`/status` を後から見た人には健全としか映らない）。
    if (entry.skipStreamKey !== null && entry.skipSegmentId !== null) {
      const older =
        input.streamKey === entry.skipStreamKey && input.segmentId < entry.skipSegmentId
      if (older) return
    }
    entry.lastSkipReason = null
    entry.skipStreamKey = null
    entry.skipSegmentId = null
  }

  /**
   * 震度を出せない区間が始まった。
   *
   * **区間が始まった回にしか呼べない。** 組み立ての側がその回にしか理由を返さない
   * ためで、以後のパケットでは `null` が返る（続いている間ずっと出ない理由は変わらない）。
   */
  noteSkip(input: {
    readonly boardKey: BoardKey
    readonly sensorId: string
    readonly reason: string
    /** その理由が立った区間。**同じパケットで届く旧区間の締めくくりと見分けるため。** */
    readonly streamKey: string
    readonly segmentId: number
  }): void {
    const entry = this.touch(input.boardKey, input.sensorId)
    entry.lastSkipReason = input.reason
    entry.skipStreamKey = input.streamKey
    entry.skipSegmentId = input.segmentId
  }

  /** 上限で押し出した数。 */
  get evictions(): number {
    return this.evictedCount
  }

  /** いま覚えている数。 */
  get size(): number {
    return this.entries.size
  }

  /** **音沙汰の新しい順**に返す。黙ったものが末尾へ寄る。 */
  snapshot(): readonly SensorHealth[] {
    return [...this.entries.values()]
      .map((e) => ({
        boardKey: e.boardKey,
        sensorId: e.sensorId,
        lastPacketMs: e.lastPacketMs,
        streamKey: e.streamKey,
        axisCount: e.axisCount,
        segmentId: e.segmentId,
        lastIntensity: e.lastIntensity,
        lastReadingAtMs: e.lastReadingAtMs,
        lastNominalReason: e.lastNominalReason,
        lastSkipReason: e.lastSkipReason,
      }))
      .sort((a, b) => b.lastPacketMs - a.lastPacketMs)
  }

  private touch(boardKey: BoardKey, sensorId: string): Entry {
    const key = keyOf(boardKey, sensorId)
    const found = this.entries.get(key)
    if (found !== undefined) {
      // **入れ直して挿入順を新しくする。** この順序が追い出しの根拠になる。
      this.entries.delete(key)
      this.entries.set(key, found)
      return found
    }
    if (this.entries.size >= this.maxSensors) {
      // **いちばん長く音沙汰の無いものを押し出す。** 新しいほうを拒むと、
      // センサーを足した日からその 1 個が永久に映らない（`Segmenter` と同じ判断）。
      const oldest = this.entries.keys().next()
      if (!oldest.done) {
        this.entries.delete(oldest.value)
        this.evictedCount++
      }
    }
    const created: Entry = {
      boardKey,
      sensorId,
      lastPacketMs: this.now(),
      streamKey: '',
      axisCount: null,
      segmentId: null,
      lastIntensity: null,
      lastReadingAtMs: null,
      lastNominalReason: null,
      lastSkipReason: null,
      skipStreamKey: null,
      skipSegmentId: null,
    }
    this.entries.set(key, created)
    return created
  }
}
