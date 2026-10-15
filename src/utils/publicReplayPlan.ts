import type { PublicWaveRange } from './publicQuakeRange'

/**
 * 再生（テスト時刻設定）中の下部の波形を、保存庫から先取りする範囲を決める（`docs/public-waveform-design.md` §0）。
 *
 * - **再生中は常に保存庫から取る。** SeedLink のリングは約 15 分しか残っていない（2026-10-15 に JMN で実測）
 * - **いまから {@link PUBLIC_REPLAY_ARCHIVE_LAG_MS} より新しい範囲は頼まない**（保存庫にまだ入っていない分を
 *   繰り返し問い合わせない。地震カードが入りきったとみなすのと同じ 120 秒）
 * - 出し始めは表示の幅ぶん遡り、再生時刻が取った分の終わりに近づいたら次を {@link PUBLIC_REPLAY_CHUNK_MS} ずつ取る
 * - 再生時刻が取った分の外へ飛んだら（再生を始め直した・時刻を変えた）、取った分を捨てて取り直す
 */

/** 1 回に取る長さ（ms）。仮の値（設計書 §12）。20 点・5 分でおよそ 0.5 MB（§3.5）。 */
export const PUBLIC_REPLAY_CHUNK_MS = 5 * 60_000
/** 取った分の終わりがこれより近づいたら次を取る（ms）。仮の値。 */
export const PUBLIC_REPLAY_LEAD_MS = 60_000
/** いまからこれより新しい範囲は頼まない（ms）。 */
export const PUBLIC_REPLAY_ARCHIVE_LAG_MS = 120_000
/**
 * 続きが上限（いまから {@link PUBLIC_REPLAY_ARCHIVE_LAG_MS} 前）で切られるとき、これより短い続きは取らない（ms）。
 * **上限は本当の時刻とともに進むので、これが無いと見直しのたびに数秒ぶんずつ取りに行き続ける。**
 * 再生時刻が上限の近くにある間は、右端がこの長さまで止まって見えることがある。仮の値。
 */
export const PUBLIC_REPLAY_MIN_STEP_MS = 30_000
/** 出し始めに表示の幅へ足す余白（ms）。表示の左端が欠けないように。 */
const START_PAD_MS = 10_000

/** 取った分（取りに行った範囲の合わせ）。まだ何も取っていなければ `null`。 */
export interface PublicReplayFetched {
  readonly fromMs: number
  readonly toMs: number
}

export type PublicReplayPlan =
  /** 取りに行く。`reset` なら取った分を捨ててから（入れ物も空にする）。 */
  | { readonly kind: 'fetch'; readonly range: PublicWaveRange; readonly reset: boolean }
  /** いまは取らない。 */
  | { readonly kind: 'idle' }

export function planPublicReplayFetch(params: {
  /** 再生している時刻（ms）。 */
  readonly replayNowMs: number
  /** 本当のいま（ms）。保存庫に入ったかは本当の時刻で決まる。 */
  readonly realNowMs: number
  readonly spanSec: number
  readonly fetched: PublicReplayFetched | null
}): PublicReplayPlan {
  const { replayNowMs, realNowMs, spanSec, fetched } = params
  if (!Number.isFinite(replayNowMs) || !Number.isFinite(realNowMs)) return { kind: 'idle' }
  const capMs = realNowMs - PUBLIC_REPLAY_ARCHIVE_LAG_MS
  const wantFromMs = replayNowMs - spanSec * 1000 - START_PAD_MS
  const outside = fetched === null || wantFromMs < fetched.fromMs - START_PAD_MS || replayNowMs > fetched.toMs + PUBLIC_REPLAY_CHUNK_MS
  if (outside) {
    const toMs = Math.min(replayNowMs + PUBLIC_REPLAY_CHUNK_MS, capMs)
    if (!(toMs > wantFromMs)) return { kind: 'idle' }
    return { kind: 'fetch', range: { fromMs: wantFromMs, toMs }, reset: true }
  }
  if (replayNowMs + PUBLIC_REPLAY_LEAD_MS < fetched.toMs) return { kind: 'idle' }
  const toMs = Math.min(fetched.toMs + PUBLIC_REPLAY_CHUNK_MS, capMs)
  if (!(toMs > fetched.toMs)) return { kind: 'idle' }
  if (toMs === capMs && toMs - fetched.toMs < PUBLIC_REPLAY_MIN_STEP_MS) return { kind: 'idle' }
  return { kind: 'fetch', range: { fromMs: fetched.toMs, toMs }, reset: false }
}
