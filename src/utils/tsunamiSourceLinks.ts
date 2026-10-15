import type { JMAQuake, JMATsunami, TsunamiSourceEarthquake } from '../types/earthquake'
import { extractQuakeEventId } from './quakeMerge'
import { sourceEarthquakeTime, tsunamiEventIds } from './tsunami'

/**
 * 津波の原因地震 1 件と、それに当たる地震の識別番号。
 *
 * `eventId` が無いのは「どの番号の地震か決められなかった」とき。そのときは震源を借りず、
 * 地震カードへのリンクも出さず、読み上げの既読を地震の主題と共有しない。
 */
export interface TsunamiSourceLink {
  source: TsunamiSourceEarthquake
  /** 原因地震 `source` に当たる地震の識別番号（`EventID` の番号 1 つ）。決められなければ undefined。 */
  eventId?: string
}

/**
 * 津波の原因地震（`Body/Earthquake`、地震ごとに 1 件）を、`EventID` に並ぶ地震の識別番号と結ぶ。
 * **原因地震と地震カードの対応はここだけで決める**（震源の借用・バナーの「▶ 地震情報」・読み上げの既読が
 * 同じ答えを使う。共有カードは結びを使わず原因地震を全件並べる）。
 *
 * **どの `Earthquake` 要素がどの番号に当たるかは電文仕様に書かれていない**（電文解説資料 Ⅱ.11-6 は
 * 「地震毎に本要素を記載」とだけ言う）。また番号そのものは発生時刻などの物理的な意味を持たない
 * （同 Ⅰ.別02-2）ので、番号から時刻を読んで結ぶこともできない。そこで次の 2 段で結ぶ
 * （2026-10-15 ユーザー承認「発現時刻で結ぶ（推奨）」）。
 *
 * 1. **番号も原因地震も 1 つずつなら、その組がそのまま対応する**（いまの形。切替えの起きていない津波）
 * 2. それ以外は、**原因地震の発現時刻（分）と、番号が一致する地震カードの時刻を突き合わせる**。
 *    地震カードの時刻は発現時刻で、震度速報も地震の検知時刻（同じ分）を持つ（→ `dmdataParser.ts` の
 *    `earthquakeTime`・`sourceEarthquakeTime`）。**1 対 1 に決まるときだけ結ぶ** —— 同じ分に 2 つの地震が
 *    あると取り違えうるので、そのときは結ばない（誤った震源を出すより、出さないほうが軽い）
 *
 * @param quakes 地震カード（取消表示中のものは結ぶ相手にしない）。2 段目でしか見ない
 */
export function linkTsunamiSources(
  tsunami: Pick<JMATsunami, 'eventId' | 'foldedReports' | 'sourceEarthquakes'>,
  quakes: readonly JMAQuake[],
): TsunamiSourceLink[] {
  const sources = tsunami.sourceEarthquakes ?? []
  if (sources.length === 0) return []
  const ids = tsunamiEventIds(tsunami)
  // 最新の報の番号だけで 1 対 1 を見る（組み立てに使った報の番号まで数えると、番号が入れ替わった
  // 津波で「番号が 2 つ」に見えて 1 段目を外れる）。
  const latestIds = (tsunami.eventId ?? '').split(/\s+/).filter(Boolean)
  if (latestIds.length === 1 && sources.length === 1) return [{ source: sources[0], eventId: latestIds[0] }]

  const idSet = new Set(ids)
  const candidates = quakes.filter(q => !q.cancelledAt)
  const matched = sources.map(source => {
    const minute = minuteOf(sourceEarthquakeTime(source))
    if (minute === null) return [] as string[]
    const hit = new Set<string>()
    for (const q of candidates) {
      const id = extractQuakeEventId(q)
      if (!id || !idSet.has(id)) continue
      if (minuteOf(q.earthquake.time) === minute) hit.add(id)
    }
    return [...hit]
  })
  // 1 対 1 を確かめる: 1 つの原因地震に番号が 1 つだけ当たり、その番号が他の原因地震にも当たらない。
  const useCount = new Map<string, number>()
  for (const ids of matched) for (const id of ids) useCount.set(id, (useCount.get(id) ?? 0) + 1)
  return sources.map((source, i) => {
    const hit = matched[i]
    const eventId = hit.length === 1 && useCount.get(hit[0]) === 1 ? hit[0] : undefined
    return eventId ? { source, eventId } : { source }
  })
}

/** 時刻を分の通し番号へ落とす（電文の発現時刻は分単位で、秒は 00）。読めなければ null。 */
function minuteOf(iso: string | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 60_000) : null
}
