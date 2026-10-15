// 緊急地震速報の発生時刻（秒まで）を、地震 ID を鍵に端末へ残す。
//
// **なぜ残すか。** 緊急地震速報は自動解除されると画面から消えるので、そのままでは「揺れた直後に
// 開いていたカード」でしか秒が取れない。残しておけば、リロードしてもリプレイを始め直しても、
// 同じ地震について取り直さずに済む（2026-10-04 のユーザー判断）。
//
// **残すのは発生時刻と、その報が仮定震源要素だったかだけ。** 電文そのものは持たない —— 波形の線を
// 引くのに要るのはこの 2 つで、電文を抱えると端末の保存量と「何を保存しているか」の説明が膨らむ。
//
// **仮定震源要素の報の発生時刻は線の起点に使わない**（2026-10-15 ユーザー承認「仮定震源の報は使わない」）。
// 仮定震源要素は「最初に揺れを捉えた観測点の直下 10 km」に震源を置いて逆算した値で、本当の
// 発生時刻より遅く出る（電文解説資料 Ⅱ（ⅰ）イ（ア）1-1）。それでも残すのは、**後から届く見分けられない
// 値（強震モニタの緊急地震速報）が同じ地震を上書きし、使える値に化けるのを防ぐため**（→ {@link mergeEewOrigins}）。

import { log } from './logger'

/** 保存先（localStorage）のキー。プライバシーポリシー §2 に載せている。 */
export const EEW_ORIGIN_STORE_KEY = 'eew-origin-times'

/**
 * 1 地震ぶんの記録。
 *
 * `assumed` は 3 値。**`null` は「見分ける手掛かりが無かった」**（標準版の強震モニタの緊急地震速報）で、
 * 使う側は使ってよい値として扱う（2026-10-15 ユーザー承認「仮定震源の報は使わない（推奨）」の説明
 * 「標準版の強震モニタ経路は仮定を見分けられないので除けない」）。
 */
export interface EewOriginEntry {
  /** 発生時刻（エポックミリ秒）。 */
  readonly originMs: number
  /** その報が仮定震源要素だったか（`null` は見分けられない）。 */
  readonly assumed: boolean | null
}

/** 過去分を取りに行った結果。**取り消された地震も返す**（呼び出し側が端末の記録から除く）。 */
export interface EewOriginFetch {
  readonly origins: Map<string, EewOriginEntry>
  readonly canceled: readonly string[]
}

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
 * 新しく届いた値で、手元の値を置き換えるか。
 *
 * - **仮定震源要素の値は、震源の決まった値を置き換えない** —— 「同じ地震で震源の決まった
 *   最後の報」を残す（画面の緊急地震速報は最新の 1 報だけを持つので、最後に届いたのが仮定の報だと
 *   その前の決まった報の値が消える）
 * - **仮定震源要素の値は、見分けられない値では置き換えない**（発生時刻が違っても）。見分けられない
 *   経路の報が仮定のまま発生時刻だけ改まった地震（単独観測点の小さな地震で起きる）を、使える値に
 *   化けさせないため。**震源の決まった値（`false`）だけが置き換えられる** —— 引き換えに、仮定の報を
 *   見た後に震源が決まった報を見分けられない経路でしか受け取れなかった地震は、緊急地震速報からは
 *   秒が取れず、長期震源カタログへ回る（決め方は「仮定震源の報は使わない」の側へ倒す）
 * - **見分けられない値は、同じ発生時刻なら印を上書きしない** —— 同じ値なら同じ報
 * - それ以外は置き換える（続報で発生時刻が改められるので、後から届いた値を正とする）
 */
function shouldReplace(existing: EewOriginEntry | undefined, incoming: EewOriginEntry): boolean {
  if (existing === undefined) return true
  if (incoming.assumed === true && existing.assumed === false) return false
  if (incoming.assumed === null && existing.assumed === true) return false
  if (incoming.assumed === null && incoming.originMs === existing.originMs) return false
  return existing.originMs !== incoming.originMs || existing.assumed !== incoming.assumed
}

/**
 * 手元の記録へ、新しく分かった発生時刻を足し、取り消された地震を除く。**元の Map は変えない。**
 *
 * 置き換えの規則は {@link shouldReplace}。
 */
export function mergeEewOrigins(
  base: ReadonlyMap<string, EewOriginEntry>,
  updates: Iterable<readonly [string, EewOriginEntry]>,
  removals: Iterable<string> = [],
): Map<string, EewOriginEntry> {
  const next = new Map(base)
  for (const [eventId, entry] of updates) {
    if (!EVENT_ID_PATTERN.test(eventId) || !Number.isFinite(entry.originMs)) continue
    // **新しく足したもの・値が変わったものだけ後ろへ回す**（追い出しはこの順の先頭から）。
    if (!shouldReplace(next.get(eventId), entry)) continue
    next.delete(eventId)
    next.set(eventId, { originMs: entry.originMs, assumed: entry.assumed })
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
export function sameEewOrigins(
  a: ReadonlyMap<string, EewOriginEntry>,
  b: ReadonlyMap<string, EewOriginEntry>,
): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    const w = b.get(k)
    if (w === undefined || w.originMs !== v.originMs || w.assumed !== v.assumed) return false
  }
  return true
}

/** 数値だけの値（仮定震源要素の印を持つ前の形）。{@link loadEewOrigins} が読まずに捨てる。 */
const LEGACY_NUMBER = Symbol('legacy-number')

/**
 * 保存された 1 件を読む。**読めなければ `null`。**
 *
 * **数値だけの値（仮定震源要素の印を持つ前の形）は使わない。** DMDATA の一覧（仮定震源要素を見分けられない）
 * から取った値が混ざっていて、出どころを見分けられない。捨てた地震は長期震源カタログへ回る。
 */
function readEntry(value: unknown): EewOriginEntry | null | typeof LEGACY_NUMBER {
  if (typeof value === 'number') return LEGACY_NUMBER
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.originMs !== 'number') return null
  if (v.assumed !== true && v.assumed !== false && v.assumed !== null) return null
  return { originMs: v.originMs, assumed: v.assumed }
}

/**
 * 端末から読む。**読めなければ空。**
 *
 * **壊れた値は 1 件ずつ捨てる。** 丸ごと捨てると、1 件の破損で全地震の秒を失う。
 */
export function loadEewOrigins(): Map<string, EewOriginEntry> {
  try {
    const raw = localStorage.getItem(EEW_ORIGIN_STORE_KEY)
    if (raw === null) return new Map()
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.warn('[eew-origin] 保存された発生時刻の形が違うため読み捨てます')
      return new Map()
    }
    const entries: [string, EewOriginEntry][] = []
    let dropped = 0
    let legacy = 0
    for (const [k, v] of Object.entries(parsed)) {
      const entry = readEntry(v)
      if (entry === LEGACY_NUMBER) legacy += 1
      else if (entry !== null && EVENT_ID_PATTERN.test(k) && Number.isFinite(entry.originMs)) entries.push([k, entry])
      else dropped += 1
    }
    // **捨てた件数は残す。** 保存の形を変えた直後に読めない形があっても、件数が減るだけで画面からは見えない。
    if (dropped > 0) log.warn(`[eew-origin] 保存された発生時刻のうち読めない ${dropped} 件を捨てました（${entries.length} 件は読めた）`)
    const loaded = mergeEewOrigins(new Map(), entries)
    // **以前の形は捨てたら書き戻す。** 残すと、新しい値が 1 件足されるまで読むたびに同じ記録が出る。
    if (legacy > 0) {
      log.info(`[eew-origin] 仮定震源要素の印を持たない以前の形の ${legacy} 件を使わずに捨てました`)
      saveEewOrigins(loaded)
    }
    return loaded
  } catch (e) {
    log.warn('[eew-origin] 保存された発生時刻を読めませんでした', e)
    return new Map()
  }
}

/** 端末へ書く。**失敗しても止めない**（記録が残らないだけで、画面は手元の値で動く）。 */
export function saveEewOrigins(origins: ReadonlyMap<string, EewOriginEntry>): void {
  try {
    localStorage.setItem(EEW_ORIGIN_STORE_KEY, JSON.stringify(Object.fromEntries(origins)))
  } catch (e) {
    log.warn('[eew-origin] 発生時刻を保存できませんでした', e)
  }
}
