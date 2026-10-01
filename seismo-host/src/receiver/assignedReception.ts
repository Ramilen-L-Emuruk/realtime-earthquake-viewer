// 観測点に割り当てた基板が、いま届いているかを突き合わせる。
//
// **センサーの生存（`sensorHealth.ts`）だけでは足りない。** あちらが覚えるのは
// **一度でも声を聞いたセンサー**で、ホストを起動してから一度も届かない基板は
// 一覧に現れない。基板は時計が合うまで 1 件も送らない（ファームの `MIN_SYNCED_UNIX`）
// ので、SNTP へ届かない基板はまさにこの形になる —— 一覧を眺めても「全部受信中」に見える。
// **「来るはずのもの」は設定（`stationConfig.ts`）にしか無い**ので、ここで突き合わせる。
//
// **Node 専用コードを持ち込まない。** 管理コンソール（`src/admin/`。ブラウザ向け）が
// 途絶の物差し（`STALE_AFTER_MS`）をここから読む —— `stationConfigTypes.ts` を
// 分けているのと同じ理由。

import type { BoardKey } from '../protocol/types'

/**
 * 最後に声を聞いてから「途絶」と見なすまで。
 *
 * **基板の送出間隔より十分長く取る。** 短くすると、たまたま 1 秒欠けただけの
 * センサーが途絶として並び、本当に黙ったものが埋もれる。
 *
 * **管理コンソールの「途絶」の札とホストの警告で同じ値を使う。** 別々に持つと、
 * 画面は「受信中」なのにログは「届いていない」と言う窓ができる。
 *
 * **基板が自分で立て直している間も、これを超えれば途絶として出る。** 返事が
 * 15 秒来なければ段を上げ、最後は再起動する（`firmware/README.md`「届いたかをホストに訊く」）
 * ので、再起動まで行けば 60 秒を超えうる。そのあいだ実際に黙っているので、それで正しい。
 */
export const STALE_AFTER_MS = 60_000

/**
 * いまの様子。
 *
 * - `live` — 途絶の物差しの内に届いている
 * - `silent` — 届いていたのに途絶えた、または割り当ててから物差しを過ぎても一度も届かない
 * - `waiting` — 割り当ててまだ物差しを過ぎておらず、一度も届いていない
 *
 * **`waiting` を `silent` に混ぜない。** 起動直後や基板を足した直後は、まだ届いていなくて
 * 当たり前なので、混ぜると再起動や登録のたびに「届いていない」が並ぶ。
 */
export type ReceptionState = 'live' | 'silent' | 'waiting'

/** 設定の `sensors[]` に名前を書いたセンサー 1 個ぶん。 */
export interface AssignedSensorReception {
  readonly sensorId: string
  /** 最後に届いた時刻（受け手の時計）。一度も無ければ null。 */
  readonly lastPacketMs: number | null
  readonly state: ReceptionState
}

/** 割り当てた基板 1 枚ぶん。 */
export interface AssignedBoardReception {
  readonly boardKey: BoardKey
  readonly stationId: string
  /** その基板の**どのセンサーからでも**最後に届いた時刻。一度も無ければ null。 */
  readonly lastPacketMs: number | null
  readonly state: ReceptionState
  /**
   * `sensors[]` に名前を書いたセンサーのうち、**有効なものだけ**。
   *
   * **基板が生きていても 1 個だけ黙ることがある**（1 枚に 3 個ぶら下がっている）。
   * 基板単位で丸めると、残りが届いている限り気づけない。
   *
   * **名前を書いていないセンサーは見ない。** 何個ぶら下がっているかを設定は約束しない
   * （`sensors[]` を空のまま基板だけ割り当ててよい）。
   *
   * **無効にしたセンサーも見ない。** 壊れたので外した、という使い方がありうるので、
   * 数えると直しようのない警告が出続ける。**基板そのものの判定には無効化を効かせない**
   * —— 値を使わないことと、基板が黙っていることは別の事実。
   *
   * **`sensorId` の打ち間違いもここで黙ったセンサーとして現れる。** 校正値が
   * 1 つも効いていない状態（`SensorStatus.calibrationConfigured`）の裏側で、届いている
   * ほうの名前はセンサーの一覧にある。
   */
  readonly sensors: readonly AssignedSensorReception[]
}

/**
 * 黙っているものに添える「いつから」。**ホストのログと管理コンソールの警告欄が同じ文面を使う**
 * —— 別々に書くと、片方だけ経過を言わない・言い方が違う、という形でずれる。
 *
 * **「ホストの起動から」とは言わない。** 稼働中に足した割り当ては、起動より後から数えている。
 */
export function describeSilence(nowMs: number, lastPacketMs: number | null): string {
  if (lastPacketMs === null || !Number.isFinite(lastPacketMs)) return '一度も届いていない'
  return `最後に届いてから ${Math.max(0, Math.round((nowMs - lastPacketMs) / 1000))} 秒`
}

/** 割り当て（`StationConfig.boards`）のうち、ここで読む欄だけ。 */
export type AssignedBoardsConfig = readonly {
  readonly boardKey: BoardKey
  readonly stationId: string
  readonly sensors: readonly { readonly sensorId: string; readonly enabled: boolean }[]
}[]

/**
 * 割り当て 1 つの鍵。**基板だけなら `sensorId` を渡さない。**
 *
 * **区切り文字で繋がない。** `name:` の基板 Key には文字種の制限が無いので、
 * `|` で繋ぐと `name:a|b` + `c` と `name:a` + `b|c` が同じ鍵へ潰れる。
 */
export function assignmentKey(boardKey: BoardKey, sensorId?: string): string {
  return JSON.stringify(sensorId === undefined ? [boardKey] : [boardKey, sensorId])
}

/**
 * 割り当てが設定に現れた時刻を、基板・センサーごとに覚える。
 *
 * **猶予（`waiting`）の起点をホストの起動時刻 1 つにしない。** 稼働中に管理コンソールから
 * 基板を足すと、その基板はまだ電源も入っていないのに、足した瞬間から「届いていない」に
 * なる —— 新しい基板を登録するたびに誤報が出て、警告そのものが信用されなくなる。
 *
 * **設定を差し替えるたびに `update` を呼ぶこと。** 呼び忘れた割り当ては鍵が無いので、
 * `assignedReception` は猶予を与えずに判定する（黙って `waiting` に留めるより、
 * 誤報の側へ倒す）。
 */
export class AssignmentClock {
  private readonly since = new Map<string, number>()

  constructor(boards: AssignedBoardsConfig, nowMs: number) {
    this.update(boards, nowMs)
  }

  /**
   * いまの設定を渡す。**新しく現れた割り当てだけ `nowMs` を起点にし、続いているものは
   * 動かさない**（観測点を付け替えただけの基板の猶予を、やり直させない）。
   * 設定から消えた割り当ては忘れる。
   */
  update(boards: AssignedBoardsConfig, nowMs: number): void {
    const present = new Set<string>()
    for (const board of boards) {
      present.add(assignmentKey(board.boardKey))
      for (const s of board.sensors) present.add(assignmentKey(board.boardKey, s.sensorId))
    }
    for (const key of [...this.since.keys()]) {
      if (!present.has(key)) this.since.delete(key)
    }
    for (const key of present) {
      if (!this.since.has(key)) this.since.set(key, nowMs)
    }
  }

  /** 読み取り専用の姿。`assignedReception` へ渡す。 */
  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.since)
  }
}

export interface AssignedReceptionInput {
  readonly nowMs: number
  /**
   * 割り当てが設定に現れた時刻（`AssignmentClock.snapshot()`）。**一度も届かない割り当てを、
   * いつから黙ったと見なすかの起点。** 鍵が無いものは猶予を与えない。
   */
  readonly assignedSinceMs: ReadonlyMap<string, number>
  readonly boards: AssignedBoardsConfig
  /** 声を聞いたセンサー（`SensorHealthBook.snapshot()`）。読む欄だけを書く。 */
  readonly heard: readonly {
    readonly boardKey: BoardKey
    readonly sensorId: string
    readonly lastPacketMs: number
  }[]
}

/**
 * 割り当てた基板ごとの様子を、**設定の並びのまま**返す。
 *
 * **時刻は受け手の時計で測る**（`sensorHealth.ts` の `lastPacketMs` と同じ）。
 * 基板が名乗る時刻を使うと、時計が合っていない基板ほど判定が効かなくなる ——
 * それがまさに見つけたい基板。
 */
export function assignedReception(input: AssignedReceptionInput): readonly AssignedBoardReception[] {
  const stateOf = (key: string, lastPacketMs: number | null): ReceptionState => {
    if (lastPacketMs === null) {
      // **一度も届かないものを黙ったと見なすのは、割り当ててから物差しを過ぎてから。**
      // 境界は `isStale` と同じく「超えたら」に揃える。
      const since = input.assignedSinceMs.get(key)
      if (since !== undefined && input.nowMs - since <= STALE_AFTER_MS) return 'waiting'
      return 'silent'
    }
    return input.nowMs - lastPacketMs > STALE_AFTER_MS ? 'silent' : 'live'
  }

  const byBoard = new Map<string, number>()
  const bySensor = new Map<string, number>()
  for (const h of input.heard) {
    // **読めない時刻は「届いていない」側へ倒す。** 素通りさせると `NaN > 60000` が偽になり、
    // 壊れた値を持つ基板が永久に「受信中」に見える。
    if (!Number.isFinite(h.lastPacketMs)) continue
    const boardKey = assignmentKey(h.boardKey)
    const before = byBoard.get(boardKey)
    if (before === undefined || h.lastPacketMs > before) byBoard.set(boardKey, h.lastPacketMs)
    bySensor.set(assignmentKey(h.boardKey, h.sensorId), h.lastPacketMs)
  }

  return input.boards.map((board) => {
    const key = assignmentKey(board.boardKey)
    const lastPacketMs = byBoard.get(key) ?? null
    return {
      boardKey: board.boardKey,
      stationId: board.stationId,
      lastPacketMs,
      state: stateOf(key, lastPacketMs),
      sensors: board.sensors
        .filter((s) => s.enabled)
        .map((s) => {
          const sKey = assignmentKey(board.boardKey, s.sensorId)
          const sensorLast = bySensor.get(sKey) ?? null
          return { sensorId: s.sensorId, lastPacketMs: sensorLast, state: stateOf(sKey, sensorLast) }
        }),
    }
  })
}
