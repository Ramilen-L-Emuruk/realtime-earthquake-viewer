// リプレイ再生中はこのオフセットを Date.now() に加算し、ログの時刻をリプレイ時刻に追従させる
let replayOffsetMs: number | null = null

export function setLogReplayOffset(offsetMs: number | null) {
  replayOffsetMs = offsetMs
}

function timestampPrefix(): string {
  const now = new Date(Date.now() + (replayOffsetMs ?? 0))
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
