// ログの時刻はアプリ時計(serverDate)に一元化する。
// ライブ時はサーバー同期時刻、リプレイ時は clock.setReplayOffset により再生時刻を反映する。
import { serverDate } from './clock'

function timestampPrefix(): string {
  const now = serverDate()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `[${hh}:${mm}:${ss}.${ms}]`
}

export const log = {
  debug: (...args: unknown[]) => console.debug(timestampPrefix(), ...args),
  info: (...args: unknown[]) => console.info(timestampPrefix(), ...args),
  warn: (...args: unknown[]) => console.warn(timestampPrefix(), ...args),
  error: (...args: unknown[]) => console.error(timestampPrefix(), ...args),
}

/**
 * 同じ種類の記録を一定間隔に間引くゲートを作る。
 *
 * 毎フレーム再発する失敗（外部データの取得失敗・下流のバグ）を素通しにすると、同じ行で
 * ログが埋まって本当に重要な警告が見えなくなる。逆に一度きりに絞ると、継続している障害が
 * 「一度失敗して直った」ように見えてしまい、恒久的な不具合ほど診断しにくくなる。
 * 間隔を空けて出し続けるのが両者の折り合い（`clock.ts` の未較正警告も同じ考え方）。
 *
 * 間隔の判定に壁時計を使うのは、リプレイ中にアプリ時計が飛んでも「実時間で何秒ごとか」を
 * 保ちたいため（記録の頻度は再生位置ではなく、人がログを読む速さの問題）。
 *
 * @param intervalMs 同種の記録を出す最小間隔 (ms)
 * @returns 記録したいときに呼ぶ関数。間隔内なら `emit` は呼ばれない
 */
export function createLogThrottle(intervalMs: number): (emit: () => void) => void {
  let lastAtMs = -Infinity
  return (emit) => {
    const now = Date.now()
    if (now - lastAtMs < intervalMs) return
    lastAtMs = now
    emit()
  }
}
