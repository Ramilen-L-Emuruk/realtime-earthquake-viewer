// 保存してある観測点の合成波形を、いまの検出へ流し直して揺れの記録を起こす道具（#618）。
//
// ホストとは別のプロセスで、実機の上で手で叩く（2026-10-07 ユーザー承認）。ホストが動いたままでよい ——
// 控え（data/wave/）は読むだけで、揺れの記録（data/events/）は既にある揺れを上書きしない。
// 起こした記録は、揺れの記録タブを開き直すと出る（押し出しは無い）。
//
//   npx tsx seismo-host/redetect.ts                       # 控えに残っている全期間・全観測点
//   npx tsx seismo-host/redetect.ts --from 2026-10-03T00:00:00+09:00 --to 2026-10-04T00:00:00+09:00
//   npx tsx seismo-host/redetect.ts --dry-run             # 書かずに件数だけ出す
//
// 照合に使う地震情報は、流す期間ぶんを P2PQuake の履歴（/v2/jma/quake）から先に取る
// （6.5 秒間隔・ページの上限あり。`src/detection/quakeHistory.ts`）。取れなかった・取りきれなかった範囲の
// 合わない揺れは「照合できず」になる。通信を出したくなければ `--quakes <保存した一覧.json>` で渡す。
//
// **終了コード:** 地震情報を取れなかった・書けなかった版がある・観測点の流し直しが途中で止まった・
// 検出の途中で例外を受け止めた・その時刻の設定を引けなかった、のどれかがあれば 1（要約を読まなくても
// 失敗に気づけるように）。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { archiveChunks, archiveHourReader, emptyArchiveReadTally, Redetector } from './src/detection/redetect'
import type { ArchiveReadTally, RedetectSummary } from './src/detection/redetect'
import { fetchQuakeHistory } from './src/detection/quakeHistory'
import type { QuakeHistoryResult } from './src/detection/quakeHistory'
import { parseP2pQuakeList } from './src/detection/p2pQuake'
import type { ObserverPoint } from './src/detection/quakeMatch'
import type { ShakeSensorRef } from './src/detection/shakeEvent'
import { MATCH_DEADLINE_MS } from './src/detection/shakeEventBook'
import { ShakeEventStore, eventFilePath } from './src/detection/shakeEventStore'
import { sensorsOf } from './src/detection/stationDetection'
import { jstDateTime, jstHourStartMs } from './src/receiver/jstTime'
import type { StationConfig } from './src/receiver/stationConfig'
import { STATION_CONFIG_FILE, loadStationHistory } from './src/receiver/stationStore'
import { configAt, currentConfig } from './src/receiver/stationXml'
import type { StationHistoryDoc } from './src/receiver/stationXml'
import { stationFileToken } from './src/receiver/waveArchive'

/** 範囲の頭より前から流す長さ（引き金の助走 60 秒・平常時の強さの時定数に余裕を見る。評価台と同じ）。 */
const LEAD_MS = 5 * 60_000
/** これより古い時の控えは、時計が合う前の残骸として流さない。 */
const OLDEST_PLAUSIBLE_MS = Date.UTC(2020, 0, 1)
const FETCH_TIMEOUT_MS = 30_000

interface Args {
  readonly fromMs: number | null
  readonly toMs: number | null
  readonly station: string | null
  readonly waveDir: string
  readonly eventDir: string
  readonly stationsPath: string
  readonly quakesFile: string | null
  readonly dryRun: boolean
}

function here(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string): string | null => {
    const i = argv.indexOf(name)
    if (i < 0) return null
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} に値が無い`)
    return v
  }
  const time = (name: string): number | null => {
    const v = value(name)
    if (v === null) return null
    const ms = Date.parse(v)
    if (!Number.isFinite(ms)) throw new Error(`${name} の時刻が読めない: ${v}`)
    return ms
  }
  return {
    fromMs: time('--from'),
    toMs: time('--to'),
    station: value('--station'),
    waveDir: value('--wave') ?? here('./data/wave/'),
    eventDir: value('--events') ?? here('./data/events/'),
    stationsPath: value('--stations') ?? here(`./config/${STATION_CONFIG_FILE}`),
    quakesFile: value('--quakes'),
    dryRun: argv.includes('--dry-run'),
  }
}

/** その観測点の控えのうち、いちばん古い時の始まり（無ければ null）。 */
function oldestArchiveHour(waveDir: string, stationId: string): number | null {
  if (!existsSync(waveDir)) return null
  const prefix = `wave-${stationFileToken(stationId)}-`
  let oldest: number | null = null
  for (const name of readdirSync(waveDir)) {
    if (!name.startsWith(prefix) || !name.endsWith('.bin')) continue
    const ms = Date.parse(`${name.slice(prefix.length, -'.bin'.length)}:00:00+09:00`)
    if (!Number.isFinite(ms) || ms < OLDEST_PLAUSIBLE_MS) continue
    if (oldest === null || ms < oldest) oldest = ms
  }
  return oldest
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

function quakesFromFile(path: string, fromMs: number, toMs: number): QuakeHistoryResult {
  const { quakes, unreadable } = parseP2pQuakeList(JSON.parse(readFileSync(path, 'utf8')))
  // **渡された一覧は、流す範囲を取りきっているものとして扱う**（取った人が範囲を選んでいる）。
  // 助走の頭から、範囲の末尾で閉じた揺れの照合の期限（15 分）に、揺れが閉じるまでの余裕を足した 30 分後までを含める。
  // **読めなかった報があれば、どこも取りきれたと言わない**（どの揺れと合ったはずか分からない）。
  return {
    quakes,
    unreadable,
    requests: 0,
    truncated: false,
    error: null,
    covered: (a, b) => unreadable === 0 && a >= fromMs - LEAD_MS && b <= toMs + 2 * MATCH_DEADLINE_MS,
  }
}

function at(ms: number): string {
  return jstDateTime(ms) ?? String(ms)
}

/**
 * その時刻に効いていた設定（引けなければ null。理由は数えて最後に出す）。
 *
 * **設定の記録より前の時刻は、最初の記録の設定で照らす**（`onBeforeHistory` で数える）。記録の仕組みを
 * 入れる前の期間は「観測点が無かった」のではなく「記録が無い」だけ —— そのまま引くと観測点なしになり、
 * 位置が無いので 1 件も照合できない。
 */
function configLookup(
  doc: StationHistoryDoc,
  onFailure: (detail: string) => void,
  onBeforeHistory: () => void,
): (atMs: number) => StationConfig | null {
  const firstMs = doc.revisions[0]?.effectiveMs ?? null
  let last: { atMs: number; config: StationConfig | null } | null = null
  return (atMs) => {
    if (last !== null && last.atMs === atMs) return last.config
    let config: StationConfig | null
    try {
      if (firstMs !== null && atMs < firstMs) onBeforeHistory()
      config = configAt(doc, firstMs !== null && atMs < firstMs ? firstMs : atMs)
    } catch (error) {
      onFailure(messageOf(error))
      config = null
    }
    last = { atMs, config }
    return config
  }
}

function observerOf(config: StationConfig | null, stationId: string): ObserverPoint | null {
  const s = config?.stations.find((x) => x.stationId === stationId)
  return s !== undefined && Number.isFinite(s.lat) && Number.isFinite(s.lon) ? { lat: s.lat, lon: s.lon } : null
}

function formatSummary(stationId: string, s: RedetectSummary, t: ArchiveReadTally): string[] {
  const verdicts = Object.entries(s.verdicts)
    .map(([k, v]) => `${k} ${v}`)
    .join('・')
  const lines = [
    `[redetect] ${stationId}: 揺れ ${s.shakes} 件 → 書いた ${s.written} 件・既にあったので書かず ${s.skippedExisting} 件・助走の間で記録せず ${s.beforeRange} 件・書けなかった版 ${s.saveFailures}`,
    `[redetect] ${stationId}: 判定の内訳 ${verdicts === '' ? '（なし）' : verdicts}`,
    `[redetect] ${stationId}: 読んだ時 ${t.hours}（ファイルの無い時 ${t.hoursMissing}・開けなかった時 ${t.hoursFailed}・途中で打ち切った時 ${t.hoursTruncated}（${t.skippedBytes} バイト））・流したまとまり ${t.chunks}・重なって捨てたまとまり ${t.overlapped}`,
    `[redetect] ${stationId}: 引き金の作り直し ${s.resets} 回・捨てたまとまり ${s.droppedChunks}・計測震度相当を出せなかった区間 ${s.intensityFailures}・途中で受け止めた例外 ${s.failures}`,
  ]
  if (t.lastFailure !== null) lines.push(`[redetect] ${stationId}: 直近の開けなかった理由: ${t.lastFailure}`)
  if (s.lastFailure !== null) lines.push(`[redetect] ${stationId}: 直近の例外: ${s.lastFailure}`)
  return lines
}

async function main(): Promise<boolean> {
  const args = parseArgs(process.argv.slice(2))
  const doc = loadStationHistory(args.stationsPath)
  const config = currentConfig(doc)
  const stations = config.stations.filter((s) => args.station === null || s.stationId === args.station)
  if (stations.length === 0) throw new Error(`流す観測点が無い（設定: ${args.stationsPath}）`)
  const nowMs = Date.now()
  let ok = true

  // 観測点ごとの範囲。頭を省けば控えに残っている最も古い時から。
  const plans: { stationId: string; fromMs: number; toMs: number }[] = []
  for (const s of stations) {
    const fromMs = args.fromMs ?? oldestArchiveHour(args.waveDir, s.stationId)
    if (fromMs === null) {
      console.warn(`[redetect] ${s.stationId}: 控えが無いので飛ばす（${args.waveDir}）`)
      continue
    }
    plans.push({ stationId: s.stationId, fromMs, toMs: args.toMs ?? nowMs })
  }
  if (plans.length === 0) return ok
  const allFrom = Math.min(...plans.map((p) => p.fromMs))
  const allTo = Math.max(...plans.map((p) => p.toMs))

  const history =
    args.quakesFile !== null
      ? quakesFromFile(args.quakesFile, allFrom, allTo)
      : await fetchQuakeHistory({
          fromMs: allFrom - LEAD_MS,
          toMs: allTo,
          fetchJson,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: Date.now,
        })
  console.log(
    `[redetect] 地震情報 ${history.quakes.length} 件（リクエスト ${history.requests} 本・読めなかった報 ${history.unreadable}）` +
      (history.truncated ? '・ページの上限で切った（それより後の合わない揺れは「照合できず」）' : ''),
  )
  if (history.error !== null) {
    console.error(`[redetect] 地震情報を取れなかった: ${history.error}（合わない揺れはすべて「照合できず」になる）`)
    ok = false
  }

  const store = new ShakeEventStore({ dir: args.eventDir })
  const openHourFromMs = jstHourStartMs(nowMs) ?? undefined
  for (const plan of plans) {
    console.log(`[redetect] ${plan.stationId}: ${at(plan.fromMs)} 〜 ${at(plan.toMs)} を流す${args.dryRun ? '（書かない）' : ''}`)
    const configFailures: string[] = []
    let beforeHistory = 0
    const configAtTime = configLookup(
      doc,
      (d) => configFailures.push(d),
      () => beforeHistory++,
    )
    const tally = emptyArchiveReadTally()
    // **観測点ごとに隔離する** —— 1 つが途中で止まっても、残りの観測点は流す。
    try {
      const r = new Redetector({
        stationId: plan.stationId,
        observerAt: (ms) => observerOf(configAtTime(ms), plan.stationId),
        sensorsAt: (ms) => {
          const c = configAtTime(ms)
          return c === null ? ([] as ShakeSensorRef[]) : sensorsOf(c, plan.stationId)
        },
        quakes: history.quakes,
        quakesCovered: history.covered,
        exists: (rec) => existsSync(eventFilePath(args.eventDir, rec)),
        save: (rec) => (args.dryRun ? true : store.save(rec)),
        wallNow: Date.now,
        recordFromMs: plan.fromMs,
      })
      for await (const chunk of archiveChunks({
        readHour: archiveHourReader(args.waveDir, plan.stationId),
        fromMs: plan.fromMs - LEAD_MS,
        toMs: plan.toMs,
        tally,
        openHourFromMs,
      })) {
        r.push(chunk)
      }
      const summary = r.finish()
      for (const line of formatSummary(plan.stationId, summary, tally)) console.log(line)
      if (summary.saveFailures > 0 || summary.failures > 0) ok = false
      if (tally.hoursFailed > 0 || tally.hoursTruncated > 0) {
        console.warn(`[redetect] ${plan.stationId}: 読めなかった控えがある（その時間の揺れは起こせていない）`)
      }
    } catch (error) {
      console.error(`[redetect] ${plan.stationId}: 流し直しが途中で止まった: ${messageOf(error)}`)
      ok = false
    }
    if (beforeHistory > 0) {
      const first = doc.revisions[0]?.effectiveMs
      console.log(
        `[redetect] ${plan.stationId}: 設定の記録（${first === undefined ? '?' : at(first)} から）より前の時刻を ${beforeHistory} 回、最初の記録の設定で照らした`,
      )
    }
    // 位置・センサー無しで扱った記録は質が落ちている（照合が「照合できず」へ倒れ、センサーの一覧が空になる）。
    // 書けてはいるが、終了コードで気づけるようにする。
    if (configFailures.length > 0) {
      ok = false
      console.warn(
        `[redetect] ${plan.stationId}: その時刻の設定を引けなかった ${configFailures.length} 回（位置・センサー無しで扱った）: ${configFailures[configFailures.length - 1]}`,
      )
    }
  }
  if (store.lastWriteError !== null) console.error(`[redetect] 直近の書けなかった理由: ${store.lastWriteError}`)
  return ok
}

main()
  .then((ok) => {
    if (!ok) process.exitCode = 1
  })
  .catch((error: unknown) => {
    console.error(`[redetect] 止まった: ${messageOf(error)}`)
    process.exitCode = 1
  })
