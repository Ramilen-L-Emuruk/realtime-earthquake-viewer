// @vitest-environment jsdom
//
// **実電文での総当たり。** 地震ごとに「報と報のあいだのどこで日本時間の日付が変わったとしても」、
// 履歴の当て方（新しい日から 1 日ずつ反映する）がライブ順（到着順に 1 通ずつ）と同じカードになるかを
// 確かめる計測台。**環境変数 `QUAKE_ORDER_ARCHIVE_DIR`（DMDATA の日次アーカイブ `*.tar.gz` を置いた
// ディレクトリ）を渡したときだけ動く**（通常の `npm test` では飛ばす）。
//
//   QUAKE_ORDER_ARCHIVE_DIR=.claude/dmdata-archive-cache/telegram-earthquake npx vitest run src/utils/quakeMergeOrder.probe.test.ts
//
// アーカイブの控えは電文の棚卸しと共通（→ `docs/spec/telegram-coverage-audit.md` §2）。取得は
// この計測台ではしない —— 置いてある分だけを読む。
//
// 合成の電文で同じ性質を固定したのが `quakeMergeOrder.test.ts`。あちらは並びを写しただけなので、
// **実電文でしか出ない形（観測点の数・付加文の組み合わせ・種別の並び）はこちらで見る。**
// 2026-10-06 の実測（2022-01-22・2024-01-01・2024-11-26・2026-06-25〜27・2026-07-28 の 7 日分、
// 地震 64 件・境目の置き方 260 通り）では、修正前に 7 地震でずれ、修正後は 0 件だった。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { parseEarthquakeFromXml } from '../services/dmdataParser'
import { mergeQuakeHistory } from './quakeMerge'
import type { JMAQuake } from '../types/earthquake'
import { tarEntries } from '../../scripts/telegram-audit/archive-cache.mjs'

const DIR = process.env.QUAKE_ORDER_ARCHIVE_DIR ?? ''

/** 地震情報の種別（震度速報・震源情報・震源・震度情報・震源要素更新）。 */
const QUAKE_FILE = /^VXSE(5[123]|61)_.*\.xml$/

function readTelegrams(dir: string): Map<string, JMAQuake[]> {
  const byEvent = new Map<string, JMAQuake[]>()
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.tar.gz')).sort()) {
    const tar = zlib.gunzipSync(fs.readFileSync(path.join(dir, file)))
    for (const { name, body } of tarEntries(tar)) {
      const base = path.basename(name)
      if (!QUAKE_FILE.test(base)) continue
      const xml = body.toString('utf8')
      // 訓練・試験報は履歴に入らない（`planHistoryEntries` が既定で落とす）
      if (/<Status>(訓練|試験)<\/Status>/.test(xml)) continue
      const quake = parseEarthquakeFromXml(base.slice(0, 6), xml)
      if (!quake || quake.cancelled) continue
      const eventId = xml.match(/<EventID>([^<]*)/)?.[1] ?? quake.id
      const list = byEvent.get(eventId) ?? []
      if (!list.some(known => known.telegramKey && known.telegramKey === quake.telegramKey)) list.push(quake)
      byEvent.set(eventId, list)
    }
  }
  return byEvent
}

const byTime = (list: readonly JMAQuake[]) =>
  [...list].sort((a, b) => Date.parse(a.issue.time) - Date.parse(b.issue.time))

const fold = (batches: readonly JMAQuake[][]): JMAQuake[] => {
  let cards: JMAQuake[] = []
  for (const batch of batches) cards = mergeQuakeHistory(batch, cards, [], null).cards
  return cards
}

/** 画面に出る事実（`quakeMergeOrder.test.ts` の `shape` に観測点の数と市町村を足したもの）。 */
const shape = (cards: JMAQuake[]) => cards.map(c => ({
  type: c.issue.type,
  time: c.time,
  tsunami: c.earthquake.domesticTsunami,
  maxScale: c.earthquake.maxScale,
  points: c.points.length,
  cities: (c.cities ?? []).length,
  hypocenter: c.earthquake.hypocenter.name,
  magnitude: c.earthquake.hypocenter.magnitude,
  depth: c.earthquake.hypocenter.depth,
}))

describe.skipIf(!DIR)('実電文: 日付の境目をどこに置いても、履歴の当て方はライブと同じカードになる', () => {
  // 7 日分で 6 秒前後かかる（解析と 520 回の畳み込み）。既定の 5 秒では足りない
  it('総当たり', { timeout: 120_000 }, () => {
    const byEvent = readTelegrams(DIR)
    let events = 0
    let placements = 0
    const mismatches: string[] = []
    for (const [eventId, raw] of byEvent) {
      const sorted = byTime(raw)
      if (sorted.length < 2) continue
      events++
      const expected = shape(fold(sorted.map(q => [q])))
      for (let k = 1; k < sorted.length; k++) {
        const earlier = sorted.slice(0, k)
        const later = sorted.slice(k)
        const scenarios: Array<[string, JMAQuake[][]]> = [
          ['同じ窓', [byTime(later), sorted, sorted]],
          ['窓をまたぐ', [byTime(later), byTime(later), byTime(earlier), byTime(earlier)]],
        ]
        for (const [label, batches] of scenarios) {
          placements++
          const got = shape(fold(batches))
          if (JSON.stringify(got) !== JSON.stringify(expected)) {
            mismatches.push(`${eventId} ${label} 後の日=${later[0].issue.type}@${later[0].issue.time}`)
          }
        }
      }
    }
    console.log(`[quakeMergeOrder.probe] 地震 ${events} 件・境目の置き方 ${placements} 通り・ずれ ${mismatches.length} 件`)
    expect(events).toBeGreaterThan(0)
    expect(mismatches).toEqual([])
  })
})
