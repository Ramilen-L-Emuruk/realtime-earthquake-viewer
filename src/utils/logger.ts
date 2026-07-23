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
