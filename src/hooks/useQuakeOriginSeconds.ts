// 地震カードごとに、発生時刻を**秒まで**決める（→ 決め方は `utils/quakeOriginSeconds.ts`）。
// 自作地震計の波形へ P 波・S 波の線を引くのに使う。
//
// **材料の集め方**
//
// | 材料 | DMDSS 版 | 標準版 |
// |---|---|---|
// | 画面に来た緊急地震速報 | 受信した電文（リプレイの再生区間も同じ経路で流れる） | 強震モニタ（Yahoo）の EEW・P2PQuake の警報 |
// | 過去 7 日（＋境目の 1 日）ぶんの緊急地震速報 | DMDATA の EEW 一覧（`/v2/gd/eew`）を 1 回 | P2PQuake の `/history?codes=556` を 1 回（直近 1 週間・警報だけ） |
// | 地震 ID | カードの電文が持っている | 気象庁の地震一覧と突き合わせる |
//
// **緊急地震速報の発生時刻は端末へ残す**（`utils/eewOriginStore.ts`）。リロードしても、リプレイを
// 始め直しても、同じ地震について取り直さない。
//
// **取りに行くのは開いた直後とリプレイの開始時だけ。** それ以降に起きた地震の緊急地震速報は
// 画面に来る経路で残るので、定期的には取らない。

import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchDmdataEewOriginTimes } from '../services/dmdata'
import { fetchJmaQuakeList, fetchP2PEewOriginTimes } from '../services/quakeOriginSources'
import { serverNow } from '../utils/clock'
import { loadEewOrigins, mergeEewOrigins, saveEewOrigins, sameEewOrigins } from '../utils/eewOriginStore'
import { hasMagnitude } from '../utils/formatters'
import { extractQuakeEventId, quakeEventKey } from '../utils/quakeMerge'
import {
  findJmaEventId,
  parseJstTimeMs,
  resolveOriginSeconds,
  type JmaQuakeListEntry,
  type OriginSeconds,
} from '../utils/quakeOriginSeconds'
import type { EEWAlert, JMAQuake } from '../types/earthquake'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 過去分を取りに行く幅。**地震カードの 7 日ぶん ＋ 1 日。** 境目の地震の緊急地震速報が
 * 前日に始まっていても拾えるよう、1 日だけ広く取る。
 */
const EEW_LOOKBACK_MS = 8 * DAY_MS

/**
 * P2PQuake の `/history` が遡れる幅（公式 API 仕様「1 週間以上古い情報は取得できない場合が
 * あります」）。**これより前の日付を再生するときは取りに行かない** —— 返ってくるのは
 * いまの 1 週間ぶんで、再生している日の地震は含まれないので、通信が無駄になるだけ。
 */
const P2P_HISTORY_REACH_MS = 7 * DAY_MS

/**
 * 気象庁の地震一覧が持つ幅（実測で約 1 か月。2026-10-04）。これより前の日付を再生するときは
 * 取りに行かない（理由は上と同じ）。**狭めに見積もって 25 日**とし、一覧が短くなっても
 * 無駄撃ちは「数日ぶんの再生で 1 回」にとどまる。
 */
const JMA_LIST_REACH_MS = 25 * DAY_MS

/**
 * 地震カードごとの秒を組み立てる。**テストから直に確かめられるよう外へ出してある。**
 *
 * 地震 ID は、DMDSS 版ならカードの電文から、標準版なら気象庁の地震一覧から引く。
 */
export function buildOriginSecondsMap(params: {
  readonly quakes: readonly JMAQuake[]
  readonly isDmdss: boolean
  readonly eewOrigins: ReadonlyMap<string, number>
  readonly jmaList: readonly JmaQuakeListEntry[]
}): Map<string, OriginSeconds> {
  const { quakes, isDmdss, eewOrigins, jmaList } = params
  const out = new Map<string, OriginSeconds>()
  for (const q of quakes) {
    const eventId = isDmdss
      ? extractQuakeEventId(q)
      : findJmaEventId({
          // **日本時間として読む**（端末の時間帯で読むと、日本国外で突き合わせが全滅する）。
          timeMs: parseJstTimeMs(q.earthquake.time),
          epicenter: q.earthquake.hypocenter.name,
          magnitude: hasMagnitude(q.earthquake.hypocenter.magnitude) ? q.earthquake.hypocenter.magnitude : null,
        }, jmaList)
    const resolved = resolveOriginSeconds(eventId, eventId === null ? undefined : eewOrigins.get(eventId))
    if (resolved !== null) out.set(quakeEventKey(q), resolved)
  }
  return out
}

/**
 * 画面に来ている緊急地震速報から、残す値と除く地震を取り出す。
 *
 * **訓練・試験の報は採らない。** **取り消された地震は除く** —— 誤報の発生時刻で線を引かない
 * （取消は `cancelledAt` で表される。下の判定を参照）。
 * 地震 ID（`issue.eventId`）を持たない報は鍵が無いので採らない。
 */
export function eewOriginsFromActive(eews: Iterable<EEWAlert>): {
  updates: Array<[string, number]>
  removals: string[]
} {
  const updates: Array<[string, number]> = []
  const removals: string[] = []
  for (const eew of eews) {
    if (eew.test) continue
    const eventId = eew.issue?.eventId
    if (!eventId) continue
    // **画面の EEW は取消を `cancelledAt` で持つ**（`useEarthquakes` は取消電文を受けると既存の報に
    // `cancelledAt` だけを足して表示猶予の間残す。`cancelled` は false のまま）。両方を見る。
    if (eew.cancelled || eew.cancelledAt) {
      removals.push(eventId)
      continue
    }
    const originMs = new Date(eew.earthquake.originTime).getTime()
    if (Number.isFinite(originMs)) updates.push([eventId, originMs])
  }
  return { updates, removals }
}

export function useQuakeOriginSeconds(params: {
  /** 波形を出さない設定なら何もしない（取りに行かず、端末にも残さない）。 */
  readonly enabled: boolean
  readonly isDmdss: boolean
  readonly apiKey: string
  readonly quakes: readonly JMAQuake[]
  readonly activeEEWs: ReadonlyMap<string, EEWAlert>
  /** リプレイ中の時刻のずれ（ライブなら `null`）。変わったら過去分を取り直す。 */
  readonly replayOffsetMs: number | null
}): ReadonlyMap<string, OriginSeconds> {
  const { enabled, isDmdss, apiKey, quakes, activeEEWs, replayOffsetMs } = params
  const [eewOrigins, setEewOrigins] = useState<Map<string, number>>(() => (enabled ? loadEewOrigins() : new Map()))
  const [jmaList, setJmaList] = useState<readonly JmaQuakeListEntry[]>([])
  const originsRef = useRef(eewOrigins)
  originsRef.current = eewOrigins

  // 足すときは必ずここを通す（画面と端末の両方を揃える）。
  const recordRef = useRef((updates: Iterable<readonly [string, number]>, removals: Iterable<string>) => {
    const next = mergeEewOrigins(originsRef.current, updates, removals)
    if (sameEewOrigins(next, originsRef.current)) return
    originsRef.current = next
    setEewOrigins(next)
    saveEewOrigins(next)
  })

  // 無効から有効へ変わったら、端末に残っている分を読み直す。
  useEffect(() => {
    if (!enabled) return
    const stored = loadEewOrigins()
    recordRef.current(stored, [])
  }, [enabled])

  // 画面に来た緊急地震速報を残す（ライブ・リプレイの再生区間の両方）。
  useEffect(() => {
    if (!enabled) return
    const { updates, removals } = eewOriginsFromActive(activeEEWs.values())
    if (updates.length > 0 || removals.length > 0) recordRef.current(updates, removals)
  }, [enabled, activeEEWs])

  // 開いた直後とリプレイの開始時に、過去分を取りに行く。
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const anchor = serverNow()
    const agoMs = Date.now() - anchor
    if (isDmdss) {
      if (apiKey) {
        void fetchDmdataEewOriginTimes(apiKey, anchor - EEW_LOOKBACK_MS, anchor).then((found) => {
          if (!cancelled && found.size > 0) recordRef.current(found, [])
        })
      }
    } else {
      if (agoMs < P2P_HISTORY_REACH_MS) {
        void fetchP2PEewOriginTimes().then((found) => {
          if (!cancelled && found.size > 0) recordRef.current(found, [])
        })
      }
      if (agoMs < JMA_LIST_REACH_MS) {
        void fetchJmaQuakeList().then((list) => {
          if (!cancelled) setJmaList(list)
        })
      } else {
        setJmaList([])
      }
    }
    return () => { cancelled = true }
  }, [enabled, isDmdss, apiKey, replayOffsetMs])

  return useMemo(
    () => (enabled ? buildOriginSecondsMap({ quakes, isDmdss, eewOrigins, jmaList }) : new Map()),
    [enabled, quakes, isDmdss, eewOrigins, jmaList],
  )
}
