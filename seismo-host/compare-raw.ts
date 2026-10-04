// NDJSON と miniSEED 3 の生データを、日本時間の 1 時間ぶん突き合わせる（判定は `src/receiver/rawCompare.ts`）。
//
// 使い方（リポジトリのいちばん上で）:
//   npx tsx seismo-host/compare-raw.ts --hour 2026-10-03T12 [--dir seismo-host/data/raw] [--days 1]
//
// **終了コード**: 0 = 全部合った／1 = 食い違いがある／2 = 照らすものが無かった（NDJSON が
// 見つからない・その時のパケットが 0 件）か、引数が不正。NDJSON の書き込みを止めてよいかは、
// これが並行運転の間ずっと 0 で終わることで決める（#477）。判定は `rawCompareVerdict`。
//
// NDJSON はその日と、翌日から `--days` 日ぶん（既定 1）のファイルを読む（取り戻した分は後の日に
// 届くことがある）。素のファイルも gzip したものも読む。1 日ぶんで 2 GB 近くあるので、
// 流し読みしてその時の分だけを残す。

import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGunzip, gunzipSync } from 'node:zlib'

import { JST_OFFSET_MS, jstDateTime } from './src/receiver/jstTime'
import { readMseed3Records } from './src/receiver/mseed3Reader'
import { mseedFilePath } from './src/receiver/mseedStore'
import { compareRawHour, discrepancyCount, rawCompareVerdict } from './src/receiver/rawCompare'
import type { NdjsonEnvelope, PacketsLine, UnreadableLine } from './src/receiver/rawCompare'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** その時の前後どこまでを NDJSON から拾うか（受け取った時刻で）。取り戻した分は別に全部拾う。 */
const MARGIN_MS = 10 * 60_000

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** `YYYY-MM-DDTHH`（日本時間）→ その時の始まり（unix ミリ秒）。 */
function parseHour(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(text)
  if (m === null) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])) - JST_OFFSET_MS
}

function jstDayOf(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10)
}

function lines(path: string): AsyncIterable<string> {
  const source: Readable = path.endsWith('.gz') ? createReadStream(path).pipe(createGunzip()) : createReadStream(path)
  return createInterface({ input: source, crlfDelay: Infinity })
}

function readJsonLines<T>(path: string, gz: boolean): T[] {
  if (!existsSync(path)) return []
  const text = gz ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8')
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T)
}

async function main(): Promise<void> {
  const hourText = arg('hour')
  const hourStartMs = hourText === undefined ? null : parseHour(hourText)
  if (hourStartMs === null) {
    console.error('--hour YYYY-MM-DDTHH（日本時間）を指定してください')
    process.exit(2)
  }
  const daysText = arg('days') ?? '1'
  const days = /^\d+$/.test(daysText) ? Number(daysText) : null
  if (days === null) {
    console.error('--days は 0 以上の整数で指定してください')
    process.exit(2)
  }
  const dir = arg('dir') ?? fileURLToPath(new URL('./data/raw/', import.meta.url))

  const envs: NdjsonEnvelope[] = []
  let scanned = 0
  const ndjsonFiles: string[] = []
  for (let d = 0; d <= days; d++) {
    const day = jstDayOf(hourStartMs + d * DAY_MS)
    for (const name of [`raw-${day}.ndjson`, `raw-${day}.ndjson.gz`]) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      ndjsonFiles.push(name)
      for await (const line of lines(path)) {
        scanned += 1
        let env: NdjsonEnvelope
        try {
          env = JSON.parse(line) as NdjsonEnvelope
        } catch {
          continue
        }
        const near = env.rx !== null && env.rx >= hourStartMs - MARGIN_MS && env.rx < hourStartMs + HOUR_MS + MARGIN_MS
        if (near || (env.via === 'backlog' && env.rx !== null && env.rx >= hourStartMs)) envs.push(env)
      }
    }
  }

  const mseedPath = mseedFilePath(join(dir, 'mseed'), 'mseed', hourStartMs)!
  const read = existsSync(mseedPath) ? readMseed3Records(new Uint8Array(readFileSync(mseedPath))) : null
  const packets = readJsonLines<PacketsLine>(mseedFilePath(join(dir, 'mseed'), 'packets', hourStartMs)!, true)
  const unreadable = readJsonLines<UnreadableLine>(mseedFilePath(join(dir, 'mseed'), 'unreadable', hourStartMs)!, false)

  const result = compareRawHour({ hourStartMs, ndjson: envs, records: read?.records ?? [], packets, unreadable })

  console.log(`対象: ${hourText}（日本時間）  NDJSON を ${scanned} 行読み、${envs.length} 行を候補にした`)
  console.log(`NDJSON のファイル: ${ndjsonFiles.length === 0 ? '見つからない' : ndjsonFiles.join(', ')}`)
  console.log(`miniSEED: ${read === null ? '無い' : `${read.records.length} レコード・検査値の不一致 ${read.crcFailures}・復号できず ${read.decodeFailures}・末尾で読まなかった ${read.skippedBytes} バイト`}`)
  console.log(`パケット: NDJSON ${result.ndjsonPackets} / 見出し ${result.mseedPackets} / 一致 ${result.matched} / 食い違い ${result.mismatched}`)
  console.log(`片方にだけ: NDJSON ${result.onlyInNdjson} / 見出し ${result.onlyInMseed}`)
  console.log(`レコードの先頭時刻の不一致 ${result.recordTimeMismatches} / 同じ番号に違う値 ${result.sampleConflicts}`)
  console.log(`読めなかったもの: NDJSON ${result.ndjsonUnreadable} / 退避先 ${result.mseedUnreadable}`)
  if (result.unplaceable > 0) console.log(`受け取った時刻が無く振り分けられない NDJSON の行: ${result.unplaceable}`)
  // **ホストを止めた時刻と見比べるために出す**（`seismo-host.log` の「起動した」「最後に生きていたのは」）。
  const range = result.discrepancyRxRange
  if (range !== null) {
    console.log(`食い違ったパケットの受け取った時刻: ${jstDateTime(range.firstMs) ?? range.firstMs} 〜 ${jstDateTime(range.lastMs) ?? range.lastMs}（日本時間）`)
  }
  for (const e of result.examples) console.log(`  - ${e}`)

  const verdictInput = {
    result,
    ndjsonFound: ndjsonFiles.length > 0,
    crcFailures: read?.crcFailures ?? 0,
    decodeFailures: read?.decodeFailures ?? 0,
  }
  const verdict = rawCompareVerdict(verdictInput)
  if (verdict === 0) console.log('結果: 一致')
  else if (verdict === 1) console.log(`結果: 食い違い ${discrepancyCount(verdictInput)} 件`)
  else console.log('結果: 照らすものが無い（NDJSON のファイルが無いか、その時のパケットが両方とも 0 件）')
  process.exit(verdict)
}

// **直接実行のときだけ走らせる**（import しただけで走らないように）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
