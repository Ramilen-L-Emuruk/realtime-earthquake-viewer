// 強震モニタのフレームを「データ時刻の順」に並べ、アプリ時計が追いついた時点で放出するキュー。
//
// なぜキューを挟むのか:
//   取得（Yahoo の 1 秒ポーリング／将来のアーカイブ一括読み込み）と再生（画面・検知エンジンへの
//   反映）を切り離すため。取得したその場で反映する構造だと「まとめて手に入るデータを時刻に沿って
//   流す」ことができず、アーカイブのリプレイを載せる余地がない。
//   電文側（useEarthquakes のイベントキュー）も同じ理由で時刻順のキューを挟んでいる。ただし
//   放出の意味論は違う: あちらは到来した全件を 1 件ずつ処理する（電文はどれも取りこぼせない）。
//   こちらは最新 1 件だけを採る（1Hz の観測フレームは最新の状態だけが意味を持つ）。
//
// 型を強震モニタのフレームに固定せず `{ time: Date }` だけを要求するのは、この層が
// services を参照しないようにするため（utils → services の逆流を作らない）。

import { createLogThrottle, log } from './logger'

/** このキューが並べ替えに使う最小の要件。 */
export interface TimedFrame {
  /** このフレームが表すデータ時刻。アプリ時計がこの時刻に達したときに放出される。 */
  time: Date
}

/**
 * 既定の保持上限（件数）。1 秒間隔なら 30 分ぶんにあたる。
 *
 * 観測点 1725 点ぶんの数値配列を 1 件として概算 25MB。これより長い区間を積むソースは
 * 自分で上限を渡すこと。既定値を上げると、上限に頼っている他のソースにも波及する。
 */
const DEFAULT_MAX_SIZE = 1800

/** 同種の警告を出し直す最小間隔 (ms)。壊れた供給元は毎フレーム同じ失敗を繰り返すため。 */
const LOG_THROTTLE_MS = 60_000

export interface FrameQueue<T extends TimedFrame> {
  /** フレームを時刻順の位置へ挿入する。時刻が不正なものと上限超過分は捨てる。 */
  enqueue(frame: T): void
  /**
   * `now` までに時刻が到来したフレームをすべて取り出し、**最後の 1 件だけ**を返す。
   * 間のフレームは捨てる。取り出せるものが無ければ null。
   *
   * 最新だけを返すのは、遅延で複数フレームが同時に到来可能になったとき、溜まった全部を
   * 順に流すと 1725 点ぶんの処理が同一 tick に重なって遅延をさらに広げるため。
   * ライブ取得も従来からコマ飛びを容認している（最新のデータ時刻へ再アンカーする）。
   */
  drainLatest(now: Date): T | null
  /** 保持件数。 */
  size(): number
  /** すべて捨てる。 */
  clear(): void
}

export function createFrameQueue<T extends TimedFrame>(maxSize = DEFAULT_MAX_SIZE): FrameQueue<T> {
  // time 昇順。同時刻のものは投入順（後から来たものが後ろ）に並ぶ。
  const frames: T[] = []
  // 警告は種類ごとに間引く。素通しにすると同じ行でログが埋まり、一度きりに絞ると継続している
  // 障害が「一度失敗して直った」ように見える。
  const throttledOverflow = createLogThrottle(LOG_THROTTLE_MS)
  const throttledInvalidTime = createLogThrottle(LOG_THROTTLE_MS)
  const throttledSkip = createLogThrottle(LOG_THROTTLE_MS)
  // 前回の記録以降に飛ばした累計。間引かれた回の件数を失わないため、記録できたときにまとめて出す
  // （件数は回ごとに変わる量的な情報なので、間引きで最初の 1 回だけが残ると悪化の推移が見えない）。
  let skippedSinceLastLog = 0

  return {
    enqueue(frame) {
      const ms = frame.time.getTime()
      // Invalid Date を通すと放出条件（time <= now）が常に偽になり、そのフレームが
      // 永久に居座って上限を食い潰す。入口で弾く。
      if (!Number.isFinite(ms)) {
        throttledInvalidTime(() => log.warn('[kyoshinQueue] データ時刻が不正なフレームを破棄した'))
        return
      }
      let i = frames.length
      while (i > 0 && frames[i - 1].time.getTime() > ms) i--
      frames.splice(i, 0, frame)
      // 上限を超えたら最も未来のものから捨てる。先に再生する分を残す方が、
      // 再生中の連続性を保てる（末尾は到来までに時間があり、取り直す余地もある）。
      while (frames.length > maxSize) {
        frames.pop()
        throttledOverflow(() => log.warn(
          `[kyoshinQueue] 保持上限 ${maxSize} 件を超えたため、先の時刻のフレームを捨てている`,
        ))
      }
    },

    drainLatest(now) {
      const nowMs = now.getTime()
      // 時計が壊れている間は放出しない（NaN 比較は常に偽なので実害は無いが、意図を明示する）。
      if (!Number.isFinite(nowMs)) return null
      let latest: T | null = null
      let skipped = 0
      while (frames.length > 0 && frames[0].time.getTime() <= nowMs) {
        if (latest !== null) skipped++
        latest = frames.shift()!
      }
      // 飛ばしたことを必ず残す。1 秒ごとに 1 件ずつ流れる定常時は 0 件なので、これが出るのは
      // 「取り出しが数秒止まった」か「まとめて投入されたフレームに時計が追いついていない」ときだけ。
      // 黙って間引くと、下流に届かなかったデータを「そういう時間帯だった」と見分けられなくなる。
      // 遅延が続くと毎回出るため、他の警告と同じく間引く。ただし件数は累計で持ち越し、
      // 記録できたときにまとめて出す（間引きで件数の推移が見えなくなるのを防ぐ）。
      if (skipped > 0) {
        skippedSinceLastLog += skipped
        throttledSkip(() => {
          log.warn(`[kyoshinQueue] 到来済みのフレームを計 ${skippedSinceLastLog} 件飛ばし、最新のみを採用した`)
          skippedSinceLastLog = 0
        })
      }
      return latest
    },

    size() {
      return frames.length
    },

    clear() {
      frames.length = 0
    },
  }
}
