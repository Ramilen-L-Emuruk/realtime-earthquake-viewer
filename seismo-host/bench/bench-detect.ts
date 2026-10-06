// 地震検出の評価台。控えた合成波形（`build-station-cache.ts`）を検出器（実機と同じ
// `QuakeDetector`）へ流し、気象庁の地震情報と突き合わせて、当たり・取りこぼし・空振りを日ごとに数える。
//
//   npx tsx seismo-host/bench/bench-detect.ts --days 2026-09-28,2026-09-29 --labels <p2pquake.json>
//     --lat <観測点の緯度> --lon <観測点の経度>
//     [--cache <控えの置き場所>] [--station station-1] [--radius 300]
//     [--events]（区間を 1 件ずつ出す）
//
// 観測点の位置は既定値を持たない。黙って別の位置で数えると、走時の窓がずれたまま
// 「当たり・取りこぼし」が出てしまう。
//
// `--labels` は P2PQuake の地震情報（code 551）の配列（`/v2/history?codes=551` や
// `/v2/jma/quake` の応答をそのまま保存したもの）。**この台は通信を出さない** —— ラベルは
// 先に取って渡す（取る前に件数を見積もること。CLAUDE.md「調査で外部 API を叩くとき」）。
//
// **数えるのは有感地震だけ。** 地震情報（551）は震度 1 以上の地震にしか出ないので、それより
// 小さい地震を検出器が拾っても、ここでは「一致しない」に数えられる。その件数は上限側の見積もり。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { travelTimeSec } from '../../src/utils/travelTime'
import { parseP2pQuakeList } from '../src/detection/p2pQuake'
import { QuakeDetector } from '../src/detection/quakeDetector'
import type { DetectedShake } from '../src/detection/quakeDetector'
import { arrivalWindow, matchesQuake } from '../src/detection/quakeMatch'
import type { ArrivalWindow, ReferenceQuake } from '../src/detection/quakeMatch'
import { readStationWaveCache } from './stationWaveCache'

const JST_OFFSET_MS = 9 * 3_600_000
const DAY_MS = 24 * 3_600_000

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function jst(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19)
}

function dayStartMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y, m - 1, d) - JST_OFFSET_MS
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits)
}

function describe(s: DetectedShake): string {
  const e = s.trigger
  const r = s.ratios
  const ratio = (i: number): string => (r === null ? '-' : fmt(r.bandRatios[i]))
  return [
    s.shakeClass === 'quake-like' ? '地震らしい' : '生活振動らしい',
    `len ${fmt((e.offMs - e.onMs) / 1000, 1).padStart(5)}s`,
    `ratio ${fmt(e.peakRatio, 1).padStart(5)}`,
    `peakH ${fmt(e.peakHorizontalGal).padStart(6)}gal`,
    `Z/H ${r === null ? '-' : fmt(r.verticalRatio)}`,
    `0.5-2/H ${ratio(0)}`,
    `2-5/H ${ratio(1)}`,
    `10-20/H ${ratio(3)}`,
    `20-45/H ${ratio(4)}`,
    e.end === 'quiet' ? '' : `[${e.end}]`,
  ].join('  ')
}

function describePhases(s: DetectedShake, w: ArrivalWindow, q: ReferenceQuake): string {
  const p = s.phases
  if (p === null) return '      P/S: 波形が手元に足りず拾えない'
  const depth = q.depthKm ?? 10
  const predictedSp = travelTimeSec('S', w.distanceKm, depth) - travelTimeSec('P', w.distanceKm, depth)
  const sText = p.s === null ? '拾えず' : `${jst(p.s.atMs).slice(11)}（SNR ${fmt(p.s.snr, 1)}）`
  const pText = p.p === null
    ? `拾えず（SNR ${p.pSnrTried === null ? '-' : fmt(p.pSnrTried, 1)}）`
    : `${jst(p.p.atMs).slice(11)}（SNR ${fmt(p.p.snr, 1)}）`
  const sp = p.s !== null && p.p !== null ? `${fmt((p.s.atMs - p.p.atMs) / 1000, 1)}s` : '-'
  const origin = p.s === null ? '-' : jst(p.s.atMs - travelTimeSec('S', w.distanceKm, depth) * 1000).slice(11)
  return `      S ${sText}  P ${pText}  S-P ${sp}（走時表 ${fmt(predictedSp, 1)}s）  S から逆算した発生 ${origin}`
}

function main(): void {
  const days = (arg('days') ?? '').split(',').filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  const labelsPath = arg('labels')
  if (days.length === 0 || labelsPath === undefined) {
    console.error('--days YYYY-MM-DD[,...] と --labels <p2pquake.json> が要る')
    process.exit(2)
  }
  const cacheDir = arg('cache') ?? '.claude/seismo-bench-cache/station'
  const stationId = arg('station') ?? 'station-1'
  const at = { lat: Number(arg('lat')), lon: Number(arg('lon')) }
  if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon)) {
    console.error('--lat <観測点の緯度> と --lon <観測点の経度> が要る')
    process.exit(2)
  }
  const radiusKm = Number(arg('radius') ?? 300)
  const showEvents = process.argv.includes('--events')

  const parsed = parseP2pQuakeList(JSON.parse(readFileSync(labelsPath, 'utf8')))
  if (parsed.unreadable > 0) console.log(`[注意] 地震情報のうち ${parsed.unreadable} 件は読めず外した`)
  const labels = parsed.quakes
    .map((q) => ({ q, w: arrivalWindow(q, at) }))
    .filter(({ w }) => w.distanceKm <= radiusKm)

  const total = { shakes: 0, matched: 0, quakeLike: 0, localLike: 0, matchedLocalLike: 0 }
  for (const day of days) {
    const cachePath = join(cacheDir, `${stationId}-${day}.bin`)
    if (!existsSync(cachePath)) {
      console.log(`== ${day}: 控えが無い（build-station-cache.ts で作る）`)
      continue
    }
    const fromMs = dayStartMs(day)
    const toMs = fromMs + DAY_MS
    const detector = new QuakeDetector()
    const shakes: DetectedShake[] = []
    let samples = 0
    for (const chunk of readStationWaveCache(cachePath)) {
      samples += chunk.gal[0].length
      shakes.push(...detector.push(chunk))
    }
    shakes.push(...detector.flush())
    const inDay = shakes.filter((s) => s.trigger.onMs >= fromMs && s.trigger.onMs < toMs)
    const dayLabels = labels.filter(({ w }) => w.latestSMs >= fromMs && w.earliestPMs < toMs)
    const matchOf = (s: DetectedShake): { q: ReferenceQuake; w: ArrivalWindow } | undefined =>
      dayLabels.find(({ w }) => matchesQuake(s.trigger.onMs, w))
    const matched = inDay.filter((s) => matchOf(s) !== undefined)
    const unmatched = inDay.filter((s) => matchOf(s) === undefined)
    total.shakes += inDay.length
    total.matched += matched.length
    total.quakeLike += unmatched.filter((s) => s.shakeClass === 'quake-like').length
    total.localLike += unmatched.filter((s) => s.shakeClass === 'local-like').length
    total.matchedLocalLike += matched.filter((s) => s.shakeClass === 'local-like').length
    console.log(
      `== ${day}: 揺れ ${inDay.length} 件（地震と一致 ${matched.length}・一致しない ${unmatched.length}` +
        `＝地震らしい ${unmatched.filter((s) => s.shakeClass === 'quake-like').length}／生活振動らしい ` +
        `${unmatched.filter((s) => s.shakeClass === 'local-like').length}）・サンプル ${samples}・` +
        `作り直し ${detector.resets} 回・捨てたまとまり ${detector.droppedChunks}・P/S の窓が途切れて拾わず ${detector.phaseWindowsBroken}・P/S の失敗 ${detector.phaseFailures}`,
    )
    for (const { q, w } of dayLabels) {
      const hit = inDay.find((s) => matchesQuake(s.trigger.onMs, w))
      const mag = q.magnitude === null ? 'M?' : `M${q.magnitude}`
      console.log(
        `  ${hit ? '当たり  ' : '取りこぼし'} ${jst(q.originMs)} ${q.name} ${mag} ${fmt(w.distanceKm, 0)}km` +
          (hit ? `  → ${jst(hit.trigger.onMs).slice(11)} ${describe(hit)}` : ''),
      )
      if (hit) console.log(describePhases(hit, w, q))
    }
    if (showEvents) {
      for (const s of inDay) {
        const m = matchOf(s)
        console.log(`    ${jst(s.trigger.onMs).slice(11)} ${describe(s)}${m ? `  = ${m.q.name}` : ''}`)
      }
    }
  }
  console.log(
    `計: 揺れ ${total.shakes} 件・地震と一致 ${total.matched} 件（うち「生活振動らしい」に分けた ${total.matchedLocalLike}）・` +
      `一致しない ${total.shakes - total.matched} 件（地震らしい ${total.quakeLike}／生活振動らしい ${total.localLike}）`,
  )
}

main()
