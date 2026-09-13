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

/**
 * 同じ値では二度鳴らさない記録のゲートを作る。{@link createLogThrottle} が時間で間引くのに対し、
 * こちらは**値の種類**で間引く。
 *
 * 使い先は「同じ入力が何度も通る経路で、入力そのものが異常」という形の記録。表示の整形は
 * 再描画のたびに走るため、壊れた値が 1 つあるだけで時間間引きでは追いつかない（1 分間隔でも
 * 出続ける）一方、値ごとに 1 回なら壊れた値の数だけで打ち止めになる。
 *
 * **黙らせない。** 値の種類が `limit` に達したら、そこから先は時間で間引いて出し続ける
 * （`emit` に真が渡る）。上限で打ち切る作りにすると、**一度でも種類が溢れたら以後その検出が
 * 永久に死ぬ**——しかも死んだ痕跡も残らない。上限があるのは、毎回違う値が来る経路で
 * `Set` が際限なく伸びるのを防ぐためだけ。
 *
 * @param limit 値ごとに 1 回記録する種類の上限
 * @param overflowIntervalMs 上限を超えたあと、記録を出す最小間隔 (ms)
 * @returns 記録したいときに呼ぶ関数。`emit` の引数は「上限を超えて間引かれている状態か」
 */
export function createFirstSeenLogGate(
  limit: number,
  overflowIntervalMs: number,
): (value: string, emit: (overflowed: boolean) => void) => void {
  const seen = new Set<string>()
  const throttled = createLogThrottle(overflowIntervalMs)
  return (value, emit) => {
    if (seen.has(value)) return
    // 上限に達したら `seen` へは足さない（伸ばさないことが上限の目的）。同じ値が繰り返し来ても
    // 時間の間引きが受け止める。
    if (seen.size >= limit) {
      throttled(() => emit(true))
      return
    }
    seen.add(value)
    emit(false)
  }
}

/**
 * 「読めない値」を記録するときの、値で数える種類の上限と、溢れたあとの間隔。
 *
 * **表示の整形（`formatters.ts`）と電文の読み取り（`dmdataParser.ts`）で同じ値を使う。**
 * どちらも「同じ壊れた値が繰り返し来る」形の記録で、片方だけ緩めると、同じ障害なのに
 * 層によって記録の濃さが変わる。桁はリポジトリの他の間引き（60 秒勢）に揃えてある。
 */
export const UNREADABLE_VALUE_LOG_KINDS = 20
export const UNREADABLE_VALUE_LOG_INTERVAL_MS = 60_000

/**
 * {@link createFirstSeenLogGate} を**ラベルごとに**配る。
 *
 * **1 個を共有してはいけない。** 間引きは呼び出し元を区別しないため、ある種類で壊れた値が
 * 連発すると枠と間隔を食い尽くし、**別の種類で起きた異常が出るかどうかが偶然に左右される**
 * （`kyoshin.ts` や `QuakeIntensitySurfaceGL.tsx` が種別ごとに分けているのと同じ理由）。
 *
 * ラベルは呼び出し元が持つ有限の集合（関数名・要素の種別名）を想定している。**外から来た値を
 * ラベルにしないこと** —— この `Map` が際限なく伸びる。
 *
 * @param limit ラベルごとに、値で 1 回だけ記録する種類の上限
 * @param overflowIntervalMs 上限を超えたあと、記録を出す最小間隔 (ms)
 */
export function createPerLabelLogGate(
  limit: number,
  overflowIntervalMs: number,
): (label: string, value: string, emit: (overflowed: boolean) => void) => void {
  const gates = new Map<string, (value: string, emit: (overflowed: boolean) => void) => void>()
  return (label, value, emit) => {
    let gate = gates.get(label)
    if (!gate) {
      gate = createFirstSeenLogGate(limit, overflowIntervalMs)
      gates.set(label, gate)
    }
    gate(value, emit)
  }
}
