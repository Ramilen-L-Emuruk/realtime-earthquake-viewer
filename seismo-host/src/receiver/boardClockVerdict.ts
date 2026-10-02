// 基板の時計のずれを「知らせるべきか」の判定。**ホストのログ（`main.ts` の
// `buildBoardClockWarnings`）と管理コンソール（`admin/viewStatus.ts`）の両方がここを通る。**
//
// **測る部品（`boardClock.ts`）から分けてある。** あちらは区間の組み立て（`segmenter.ts`）を
// 引き込むので、ブラウザで動く管理コンソールへは持ち込めない。判定を 2 箇所に書くと、
// 閾値を片方だけ変えたときに「ログは鳴るのに画面は黙る」形ができる。

import { STALE_AFTER_MS } from './assignedReception'

/**
 * ずれをこれより大きいと知らせる境（ミリ秒・向きは問わない）。
 *
 * **観測点の合成の待ちから決めた。** 合成は裏付けの到着をデータの時刻で最大 600 ms 待ち
 * （`sensorFusion.ts` の `FUSION_WAIT_MS_DEFAULT`）、その内訳のうち基板どうしの到着差に
 * 充ててあるのは 200 ms（同じ定数のコメント）。2 枚が逆向きにずれても差がそこへ収まるよう、その半分を
 * 1 枚あたりの許容にする。**これを超えた基板があると、合成がその基板を欠きはじめる。**
 *
 * 時計が合っている基板でも、届くまでの時間（実機で数〜数十 ms）が常に乗る。
 */
export const CLOCK_OFFSET_WARN_MS = 100

/** 基板 1 枚ぶんの時計のずれ（`/status` の `boardClocks.boards[]`）。 */
export interface BoardClockOffset {
  readonly boardKey: string
  /**
   * 直近に閉じた窓での「受け取った時刻 − 末尾のサンプルが名乗る時刻」の最小値（ミリ秒）。
   * **正なら基板の時計が遅れている。** 届くまでの時間（実機で数〜数十 ms）を含む。
   * **閉じた窓がまだ無ければ null。**
   */
  readonly offsetMs: number | null
  /** その窓を閉じた時刻（受け手の時計）。無ければ null。 */
  readonly windowEndMs: number | null
  /** その窓で測ったパケットの数。 */
  readonly packets: number
  /** 最後に測ったパケットを受け取った時刻（受け手の時計）。 */
  readonly lastPacketMs: number | null
}

/**
 * 知らせるべきずれなら、その値（ミリ秒・符号付き）を返す。知らせないなら null。
 *
 * **黙った基板は知らせない。** 届かなくなっても最後に測った値は残るが、黙ったこと自体は
 * 割り当ての警告（`assignedReception.ts`）が持つ。**物差しもあちらの `STALE_AFTER_MS` に
 * 揃える** —— 別の長さにすると、境目の間だけ「届いていない」と「時計がずれている」が
 * 同時に並ぶ。
 *
 * **壊れた値（非有限）は知らせない側へ倒す。** `/status` を通ると `null` になっており、
 * その数は `unreadableTimes` が持つ。
 */
export function warnableClockOffset(
  row: Pick<BoardClockOffset, 'offsetMs' | 'lastPacketMs'>,
  nowMs: number,
): number | null {
  const offset = row.offsetMs
  const last = row.lastPacketMs
  if (offset === null || !Number.isFinite(offset)) return null
  if (last === null || !Number.isFinite(last) || nowMs - last > STALE_AFTER_MS) return null
  return Math.abs(offset) > CLOCK_OFFSET_WARN_MS ? offset : null
}
