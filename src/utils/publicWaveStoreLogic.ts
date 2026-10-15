/**
 * 地震カードの公開観測点の波形の控え（IndexedDB）の方針。DB に触らない純関数だけを置く（`utils/publicQuakeWaveDb.ts` が使う）。
 * 決めごとは `docs/public-waveform-design.md` §0・§6.1・§6.2。
 */

/** 控えた 1 件の状態。 */
export type PublicWaveEntryState =
  /** 範囲が保存庫に入りきってから取った。取り直さない */
  | 'settled'
  /** 範囲の終わりが新しすぎた（後ろが入っていないかもしれない）。上限の内で取り直す */
  | 'provisional'
  /** 範囲が入りきってから「データが無い」（204・404）と返った。確かな不在として取り直さない */
  | 'absent'

export interface PublicWaveEntryMeta {
  readonly key: string
  /** 地震の発生（ms）。捨てる順はこれの古い順 */
  readonly originMs: number
  /** 本体（miniSEED の生バイト）の長さ。`absent` は 0 */
  readonly bytes: number
  readonly state: PublicWaveEntryState
  /** 取った範囲の終わり（ms）。後で範囲が伸びたら取り直すかを決める */
  readonly toMs: number
  /** 最後に取った時刻（本当のいま・ms） */
  readonly fetchedAtMs: number
  /** 仮の控えから取り直した回数 */
  readonly retries: number
}

/** 控えの合計の上限（本体のバイト）。**50 MB**（§0）。 */
export const PUBLIC_WAVE_STORE_MAX_BYTES = 50 * 1024 * 1024
/** 件数の上限。**不在（0 バイト）の項目も積み上がる**ので、バイトとは別に置く。仮の値（設計書 §12）。 */
export const PUBLIC_WAVE_STORE_MAX_ENTRIES = 4000
/**
 * 仮の控えを取り直す回数の上限。**1 回**（§0「範囲の終わりから数分おいて 1 回だけ取り直す」）。保存庫を繰り返し
 * 問い合わせて伸ばすのは利用条件に触れる（§6.2）。
 */
export const PUBLIC_WAVE_MAX_RETRIES = 1

/**
 * 上限を超えた分を、地震の発生が古い順に選ぶ（消す鍵の一覧）。同じ発生の項目は鍵の順で決める（並びを毎回同じにする）。
 */
export function planPublicWaveEviction(
  metas: readonly PublicWaveEntryMeta[],
  limits: { readonly maxBytes: number; readonly maxEntries: number } = {
    maxBytes: PUBLIC_WAVE_STORE_MAX_BYTES,
    maxEntries: PUBLIC_WAVE_STORE_MAX_ENTRIES,
  },
): string[] {
  let total = 0
  for (const m of metas) total += m.bytes
  let count = metas.length
  if (total <= limits.maxBytes && count <= limits.maxEntries) return []
  const order = [...metas].sort((a, b) => a.originMs - b.originMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const evict: string[] = []
  for (const m of order) {
    if (total <= limits.maxBytes && count <= limits.maxEntries) break
    evict.push(m.key)
    total -= m.bytes
    count -= 1
  }
  return evict
}

/** 控えをどう扱うか。`use` はそのまま使う・`refetch` は取り直す・`wait` は控えを使いつつ範囲が入りきるまで待つ。 */
export type PublicWaveCacheVerdict = 'use' | 'refetch' | 'wait'

/**
 * 控えを使うか取り直すか。`wantedToMs` はいま欲しい範囲の終わり（次の地震の発生で切る位置が後で緩むことがある）。
 * `settledNow` は、いま欲しい範囲が保存庫に入りきっているか（`isPublicWaveRangeSettled`。本当のいまの時刻で判定したもの）。
 *
 * 仮の控えは、**範囲が入りきってから 1 回だけ**取り直す（入りきる前に何度も訊かない）。
 */
export function publicWaveCacheVerdict(meta: PublicWaveEntryMeta, wantedToMs: number, settledNow: boolean): PublicWaveCacheVerdict {
  // 欲しい範囲が控えより後ろへ伸びた（取った範囲に後ろが含まれていない）
  const extended = wantedToMs > meta.toMs
  if (meta.state !== 'provisional') return extended ? 'refetch' : 'use'
  if (!extended && meta.retries >= PUBLIC_WAVE_MAX_RETRIES) return 'use'
  return settledNow ? 'refetch' : 'wait'
}
