// 緊急地震速報の発生時刻（秒まで）を、地震 ID を鍵に端末へ残す。
//
// **なぜ残すか。** 緊急地震速報は自動解除されると画面から消えるので、そのままでは「揺れた直後に
// 開いていたカード」でしか秒が取れない。残しておけば、リロードしてもリプレイを始め直しても、
// 同じ地震について取り直さずに済む（2026-10-04 のユーザー判断）。
//
// **残すのは発生時刻だけ。** 電文そのものは持たない —— 波形の線を引くのに要るのはこの 1 つで、
// 電文を抱えると端末の保存量と「何を保存しているか」の説明が膨らむ。

import { log } from './logger'

/** 保存先（localStorage）のキー。プライバシーポリシー §2 に載せている。 */
export const EEW_ORIGIN_STORE_KEY = 'eew-origin-times'

/**
 * 残す件数の上限。**新しく足した・値が変わったのが古いものから捨てる。**
 *
 * 緊急地震速報は多い年でも数百件なので、1000 件あれば地震カードの 7 日ぶんを優に覆う。
 * **地震の発生時刻の古い順には捨てない** —— 古い日付をリプレイして取った分は発生時刻が古いので、
 * 取った直後に真っ先に消える。足した順（`Map` の挿入順）で古いものから捨てる。
 * **値が同じ書き直しでは順番を動かさない** —— 画面の緊急地震速報は更新のたびに全件を渡し直すが、
 * 中身が変わらなければ保存も書き直さないので、動かしても端末へは残らない（画面と端末で順番がずれる）。
 */
export const EEW_ORIGIN_STORE_MAX = 1000

/** 地震 ID の書式（14 桁）。これ以外の鍵は残さない。 */
const EVENT_ID_PATTERN = /^\d{14}$/

/**
 * 手元の記録へ、新しく分かった発生時刻を足し、取り消された地震を除く。**元の Map は変えない。**
 *
 * 同じ地震 ID は新しい値で上書きする —— 続報で発生時刻が改められるので、最後に届いた値
 * （最終報）を正とする。
 */
export function mergeEewOrigins(
  base: ReadonlyMap<string, number>,
  updates: Iterable<readonly [string, number]>,
  removals: Iterable<string> = [],
): Map<string, number> {
  const next = new Map(base)
  for (const [eventId, originMs] of updates) {
    if (!EVENT_ID_PATTERN.test(eventId) || !Number.isFinite(originMs)) continue
    // **新しく足したもの・値が変わったものだけ後ろへ回す**（追い出しはこの順の先頭から）。
    if (next.get(eventId) === originMs) continue
    next.delete(eventId)
    next.set(eventId, originMs)
  }
  for (const eventId of removals) next.delete(eventId)
  const overflow = next.size - EEW_ORIGIN_STORE_MAX
  if (overflow <= 0) return next
  const keys = next.keys()
  for (let i = 0; i < overflow; i += 1) next.delete(keys.next().value as string)
  log.info(`[eew-origin] 保存の上限（${EEW_ORIGIN_STORE_MAX} 件）に達したため、足したのが古い ${overflow} 件を捨てました`)
  return next
}

/** 2 つの記録が同じ中身か（書き込みを省くため）。 */
export function sameEewOrigins(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/**
 * 端末から読む。**読めなければ空。**
 *
 * **壊れた値は 1 件ずつ捨てる。** 丸ごと捨てると、1 件の破損で全地震の秒を失う。
 */
export function loadEewOrigins(): Map<string, number> {
  try {
    const raw = localStorage.getItem(EEW_ORIGIN_STORE_KEY)
    if (raw === null) return new Map()
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.warn('[eew-origin] 保存された発生時刻の形が違うため読み捨てます')
      return new Map()
    }
    return mergeEewOrigins(
      new Map(),
      Object.entries(parsed).filter((e): e is [string, number] => typeof e[1] === 'number'),
    )
  } catch (e) {
    log.warn('[eew-origin] 保存された発生時刻を読めませんでした', e)
    return new Map()
  }
}

/** 端末へ書く。**失敗しても止めない**（記録が残らないだけで、画面は手元の値で動く）。 */
export function saveEewOrigins(origins: ReadonlyMap<string, number>): void {
  try {
    localStorage.setItem(EEW_ORIGIN_STORE_KEY, JSON.stringify(Object.fromEntries(origins)))
  } catch (e) {
    log.warn('[eew-origin] 発生時刻を保存できませんでした', e)
  }
}
