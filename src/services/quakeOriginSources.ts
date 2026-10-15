// 地震カードの発生時刻を秒まで決めるための材料を、外から取ってくる（標準版の経路）。
//
// DMDSS 版は、画面で受けた速報と、過去の速報の最終報の本文を使う（`dmdataReplay.ts` の `fetchDmdataEewOrigins`）。
// 何をどの順で採るかは `utils/quakeOriginSeconds.ts`、いつ取るかは `hooks/useQuakeOriginSeconds.ts`。

import { fetchHistory } from './p2pquake'
import { fetchJsonWithTimeout } from '../utils/fetchJson'
import { log } from '../utils/logger'
import type { EEWAlert } from '../types/earthquake'
import type { EewOriginEntry, EewOriginFetch } from '../utils/eewOriginStore'
import type { JmaQuakeListEntry } from '../utils/quakeOriginSeconds'

/**
 * 気象庁の地震一覧。**地震 ID（`eid`）を持つ唯一の、ブラウザから読める出どころ**（CORS が全許可）。
 * P2PQuake の地震情報には地震 ID の欄が無いので、標準版はここと突き合わせて引く。
 * 約 1 か月ぶん（実測 230 件・2026-10-04）を持ち、地震カードの 7 日ぶんを覆う。
 */
export const JMA_QUAKE_LIST_URL = 'https://www.jma.go.jp/bosai/quake/data/list.json'

/** 一覧の取得を諦めるまでの時間。読めなくても線が引けなくなるだけなので、長く待たない。 */
const JMA_QUAKE_LIST_TIMEOUT_MS = 15_000

/**
 * 気象庁の地震一覧を取る。**読めなければ空。**
 *
 * **形の合わない行は 1 行ずつ捨てる。** 丸ごと捨てると、1 行の破損で全カードの秒を失う。
 * **取得状況の表示（`trackStatus`）には載せない** —— 生成データの読み込みではなく、取れなくても
 * 波形の線が引けないだけの補助的な材料なので、画面の「取り込めず」に混ぜない。失敗は記録に残す。
 */
export async function fetchJmaQuakeList(): Promise<JmaQuakeListEntry[]> {
  try {
    const raw = await fetchJsonWithTimeout<unknown>(JMA_QUAKE_LIST_URL, 'jma-quake-list', {
      timeoutMs: JMA_QUAKE_LIST_TIMEOUT_MS,
      trackStatus: false,
    })
    if (!Array.isArray(raw)) {
      log.warn('[origin] 気象庁の地震一覧の形が配列ではありません')
      return []
    }
    const out: JmaQuakeListEntry[] = []
    let skipped = 0
    for (const row of raw) {
      const r = row as Record<string, unknown>
      if (typeof r?.eid === 'string' && typeof r.at === 'string' && typeof r.anm === 'string') {
        out.push({ eid: r.eid, at: r.at, anm: r.anm, mag: typeof r.mag === 'string' ? r.mag : '' })
      } else {
        skipped += 1
      }
    }
    if (skipped > 0) log.warn(`[origin] 気象庁の地震一覧で読めない行を ${skipped} 件捨てました（${out.length} 件は読めた）`)
    return out
  } catch (err) {
    log.warn('[origin] 気象庁の地震一覧を取得できませんでした', err)
    return []
  }
}

/**
 * 同じ地震の報のうち、残す 1 報を選ぶ（{@link pickEewOrigins}）ための並び。
 *
 * **震源の決まった報を仮定震源要素の報より先に**、同じ側では**報番号の大きい（後の）報を先に**。
 * 報番号が読めない報は後ろへ回す（どの報か判らないものを、判る報より優先しない）。
 */
function originPreference(eew: EEWAlert): readonly [number, number] {
  const assumed = eew.earthquake.condition === '仮定震源要素' ? 1 : 0
  const serial = Number.parseInt(eew.issue?.serial ?? '', 10)
  return [assumed, Number.isFinite(serial) ? -serial : Number.POSITIVE_INFINITY]
}

/**
 * 緊急地震速報の報の列から、**地震 ID ごとに 1 報**を選んで発生時刻を集める。
 *
 * **震源の決まった最後の報を採る。** 決まった報が 1 つも無ければ仮定震源要素の最後の報を、
 * 印を付けて残す（使わないが、後から届く「見分けられない」値に上書きされないため。
 * → `utils/eewOriginStore.ts`）。**訓練・試験の報と取り消された報は採らない**。
 * 取り消された地震は、その地震の他の報も採らない（誤報の発生時刻で線を引かない）。
 *
 * **並び順に頼らない。** `/history` は新しい順に返すので、前から順に上書きすると**最も古い報**が
 * 残る（かつてそうなっていた）。報番号で選ぶ。
 */
export function pickEewOrigins(eews: Iterable<EEWAlert>): EewOriginFetch {
  const best = new Map<string, EEWAlert>()
  const cancelled = new Set<string>()
  for (const eew of eews) {
    if (eew.test) continue
    const eventId = eew.issue?.eventId
    if (!eventId) continue
    // 画面の EEW と同じく `cancelledAt` も見る（`hooks/useQuakeOriginSeconds.ts` の `eewOriginsFromActive`）。
    if (eew.cancelled || eew.cancelledAt) {
      cancelled.add(eventId)
      continue
    }
    if (!Number.isFinite(new Date(eew.earthquake.originTime).getTime())) continue
    const prev = best.get(eventId)
    if (prev === undefined) {
      best.set(eventId, eew)
      continue
    }
    const [a1, s1] = originPreference(eew)
    const [a2, s2] = originPreference(prev)
    if (a1 < a2 || (a1 === a2 && s1 < s2)) best.set(eventId, eew)
  }
  const out = new Map<string, EewOriginEntry>()
  for (const [eventId, eew] of best) {
    if (cancelled.has(eventId)) continue
    out.set(eventId, {
      originMs: new Date(eew.earthquake.originTime).getTime(),
      assumed: eew.earthquake.condition === '仮定震源要素',
    })
  }
  return { origins: out, canceled: [...cancelled] }
}

/**
 * P2PQuake の緊急地震速報（警報・code 556）の履歴から、**地震 ID → 発生時刻** を集める
 * （選び方は {@link pickEewOrigins}）。**読めなければ空。**
 *
 * **取れるのは直近 1 週間ほどの警報だけ。** `/history` は日付を指定できず、1 週間以上前は
 * 取れないことがある（公式 API 仕様）。予報級の緊急地震速報は P2PQuake が配信していない。
 */
export async function fetchP2PEewOriginTimes(): Promise<EewOriginFetch> {
  try {
    const events = await fetchHistory([556], 100, 0, null)
    return pickEewOrigins(events.filter((ev): ev is EEWAlert => ev.kind === 'eew'))
  } catch (err) {
    log.warn('[origin] P2PQuake の緊急地震速報の履歴を取得できませんでした', err)
    return { origins: new Map(), canceled: [] }
  }
}
