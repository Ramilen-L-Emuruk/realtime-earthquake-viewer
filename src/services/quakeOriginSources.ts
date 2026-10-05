// 地震カードの発生時刻を秒まで決めるための材料を、外から取ってくる（標準版の経路）。
//
// DMDSS 版の材料（DMDATA の緊急地震速報の一覧）は `dmdata.ts` の `fetchDmdataEewOriginTimes`。
// 何をどの順で採るかは `utils/quakeOriginSeconds.ts`、いつ取るかは `hooks/useQuakeOriginSeconds.ts`。

import { fetchHistory } from './p2pquake'
import { fetchJsonWithTimeout } from '../utils/fetchJson'
import { log } from '../utils/logger'
import type { EEWAlert } from '../types/earthquake'
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
 * P2PQuake の緊急地震速報（警報・code 556）の履歴から、**地震 ID → 発生時刻** を集める。
 * **読めなければ空。**
 *
 * **取れるのは直近 1 週間ほどの警報だけ。** `/history` は日付を指定できず、1 週間以上前は
 * 取れないことがある（公式 API 仕様）。予報級の緊急地震速報は P2PQuake が配信していない。
 * **訓練・試験の報と取り消された報は採らない。**
 */
export async function fetchP2PEewOriginTimes(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  try {
    const events = await fetchHistory([556], 100)
    for (const ev of events) {
      if (ev.kind !== 'eew') continue
      const eew = ev as EEWAlert
      if (eew.test || eew.cancelled) continue
      const eventId = eew.issue?.eventId
      const originMs = new Date(eew.earthquake.originTime).getTime()
      if (eventId && Number.isFinite(originMs)) out.set(eventId, originMs)
    }
  } catch (err) {
    log.warn('[origin] P2PQuake の緊急地震速報の履歴を取得できませんでした', err)
  }
  return out
}
