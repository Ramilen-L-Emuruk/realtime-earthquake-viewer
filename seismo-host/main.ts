// 自作センサーの受け手。UDP で待ち受け、届いたパケットを段 1〜3 へ通して
// 計測震度相当を出す常駐プロセス。
//
// **いまの出口は標準出力だけ。** 生データの保存は 4-3、状態の口（JSON と SSE）は 4-4 が
// 受け持つ。数え上げ（`src/receiver/packetTally.ts`）は既にあるので、4-4 はその
// `snapshotTotal()` をそのまま配ればよい。
//
// **画面を持たない常駐プロセスなので、黙ったら誰も気づかない。** 受け取った結果
// （`PacketOutcome`）のどの欄も読み捨てないこと —— 読み捨てた欄は、そこで起きた異常が
// どこにも現れないことを意味する。
//
// **1 件ずつの行は見本、正確な数は表のほう。** 速度の上限を入れた以上、落ちたパケット
// 1 つにつき 1 行出す作りのままだと上限いっぱいで撃たれたとき毎秒 25 行が流れる。
// 行は間引き（`src/receiver/logThrottle.ts`）を通し、数は要約で出す。
//
// 起動:
//   npm run seismo-host
//   SEISMO_UDP_PORT=50505 SEISMO_UDP_ADDRESS=0.0.0.0 npm run seismo-host
import { pathToFileURL } from 'node:url'

import { MAX_TIME_MS, parseSensorPacket } from './src/protocol/parsePacket'
import { IntensityPipeline } from './src/receiver/intensityPipeline'
import type { CloseFailure, IntensityReading } from './src/receiver/intensityPipeline'
import { LogThrottle, suppressedSuffix } from './src/receiver/logThrottle'
import { PacketTally, formatTally } from './src/receiver/packetTally'
import type { TallySnapshot } from './src/receiver/packetTally'
import { SourceRateLimit } from './src/receiver/sourceRateLimit'
import { startUdpReceiver } from './src/receiver/udpReceiver'
import type { DatagramSource } from './src/receiver/udpReceiver'
import { streamKeyOf } from './src/timebase/segmenter'

/** 記録係の原型（`capture.mjs`）と同じ口。基板の送り先もこの値。 */
const DEFAULT_PORT = 50505

/** 読めなかった中身を記録へ出す長さ。**全部は出さない** —— 1 行が読めなくなる。 */
const DETAIL_CHARS = 120

/** 要約を出す間隔。 */
const SUMMARY_INTERVAL_MS = 60_000

/**
 * 10 進の整数だけを通す。**`Number()` に任せない** —— あれは `0x1F91` を 8081 として受け、
 * 打ち間違えたつもりの無い値が「読めた」ことになる（読み取り側の `DECIMAL_INTEGER_RE` と同じ判断）。
 */
const DECIMAL_PORT_RE = /^\d{1,5}$/

export function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT
  // **黙って既定へ倒さない。** 打ち間違えたまま「別のポートで動いている」状態は、
  // 基板からの送信が届かない理由として画面にも記録にも現れない。
  if (!DECIMAL_PORT_RE.test(raw)) {
    throw new Error(`SEISMO_UDP_PORT が port 番号として読めない: ${raw}`)
  }
  const port = Number(raw)
  if (port > 65535) throw new Error(`SEISMO_UDP_PORT が port 番号の範囲を超えている: ${raw}`)
  return port
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatSource(from: DatagramSource): string {
  return `${from.address}:${from.port}`
}

function shorten(detail: string): string {
  return detail.length <= DETAIL_CHARS ? detail : `${detail.slice(0, DETAIL_CHARS)}…`
}

/**
 * 時刻を文字列にする。**出せない値でも投げない。**
 *
 * `new Date(v).toISOString()` は `Date` が表せる範囲の外で例外を投げる。読み取りの側
 * （`src/protocol/parsePacket.ts`）で弾いてあるが、`atMs` は名乗られた時刻そのものでは
 * なく区間の当てはめから引いた値なので、ここでも投げない形にしておく
 * （このリポジトリが「日時は 2 つの層で確かめる」と決めているのと同じ考え方）。
 *
 * **1 件の整形の失敗で他を巻き添えにしない。** 出す側は 1 パケットぶんの震度をまとめて
 * 回しており、しかも**その中には他の基板の締めくくりが混ざる**。途中で投げると、
 * 残りは数えも出しもされないまま消える。行そのものは印を付けて必ず出す ——
 * 震度の値は生きているし、時刻が壊れていることは読めば分かる。
 */
export function formatAt(atMs: number): string {
  if (!Number.isFinite(atMs) || Math.abs(atMs) > MAX_TIME_MS) return `時刻不正(${atMs})`
  return new Date(atMs).toISOString()
}

function printReading(r: IntensityReading): void {
  const at = formatAt(r.atMs)
  const value = r.intensity === null ? '-' : r.intensity.toFixed(2)
  // **時刻の根拠が崩れていたら、その行に書く。** 倒れている間の `atMs` は正常時と
  // 同じ形をしているので、行の外で報せると正常な値と見分けが付かない。
  const timebase = r.timebaseNominalReason === null ? '' : ` 時刻=公称(${r.timebaseNominalReason})`
  console.log(`${at} ${r.boardKey} ${r.sensorId} seg=${r.segmentId} I=${value}${timebase}`)
}

export interface WindowSummaryInput {
  /** 窓の長さ（秒）。 */
  readonly windowSec: number
  /** その窓で起きたこと。 */
  readonly window: TallySnapshot
  /** その窓で捨てた送信元の枠の数。 */
  readonly evictedSources: number
  /** 直前の窓について「届いていない」と既に伝えたか。 */
  readonly quietReported: boolean
}

export interface WindowSummary {
  readonly lines: readonly string[]
  /** 次の窓へ持ち越す印。 */
  readonly quietReported: boolean
}

/**
 * 窓の長さ（秒）。
 *
 * **`setInterval` の間隔は約束であって実績ではない。** 詰まれば伸びるので、名目の 60 秒を
 * 書き続けると実際には 90 秒ぶんの件数を「直近 60 秒」と名乗ることになる。数える側は
 * 正しいので、嘘をつくのは文面だけ —— だから文面のほうを実測へ合わせる。
 *
 * 測れなかったとき（時計が戻った・非有限）は名目へ倒す。**「直近 0 秒」「直近 NaN 秒」と
 * 書くよりは名目のほうがまし**で、どちらにせよ件数は正しい。
 */
export function windowSeconds(elapsedMs: number, nominalSec: number): number {
  if (!Number.isFinite(elapsedMs)) return nominalSec
  return Math.max(1, Math.round(elapsedMs / 1000))
}

/**
 * 窓ぶんの要約を組む。
 *
 * **何も届かなかった窓は、続く間 1 度だけ伝える。** 毎分同じ空の表を出すと記録が埋まるし、
 * かといって黙ると**基板が全部黙ったことに気づけない**（画面を持たない常駐プロセスで、
 * 「何も起きていない」と「受信口が死んでいる」は外から見分けが付かない）。
 */
export function buildWindowSummary(input: WindowSummaryInput): WindowSummary {
  const rows = formatTally(input.window)
  // **枠を捨てた件数は行が空でも落とさない。** いまの呼び出し順では届いた件数が 0 なら
  // 捨てようも無いが、その前提を要約の側が握っていると、順序を変えたときに黙って消える。
  const extra =
    input.evictedSources > 0 ? [`  送信元の枠を捨てた=${input.evictedSources}`] : []

  if (rows.length === 0 && extra.length === 0) {
    if (input.quietReported) return { lines: [], quietReported: true }
    return {
      lines: [`[集計] 直近 ${input.windowSec} 秒は 1 件も届いていない`],
      quietReported: true,
    }
  }
  return {
    lines: [`[集計] 直近 ${input.windowSec} 秒`, ...rows.map((r) => `  ${r}`), ...extra],
    quietReported: false,
  }
}

async function main(): Promise<void> {
  const port = readPort(process.env.SEISMO_UDP_PORT)
  const address = process.env.SEISMO_UDP_ADDRESS
  const pipeline = new IntensityPipeline()
  const tally = new PacketTally()
  const rateLimit = new SourceRateLimit()
  const throttle = new LogThrottle()

  /**
   * 間引きを通して 1 行出す。
   *
   * **黙らせはしない** —— 初回は必ず出て、以後も間隔ごとに出る。抑えた件数は行へ添わるので、
   * 読んだ人が件数を取り違えない。**正確な数は表（`tally`）のほう。**
   */
  const emit = (
    level: 'log' | 'warn' | 'error',
    kind: string,
    detail: string,
    line: string,
  ): void => {
    const decision = throttle.shouldLog(kind, detail)
    if (decision === null) return
    const text = `${line}${suppressedSuffix(decision)}`
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
  }

  const reportCloseFailures = (failures: readonly CloseFailure[]): void => {
    for (const f of failures) {
      // 締めくくりを出せなかった＝その区間の最後の窓ぶんが失われている。
      tally.record({ kind: 'close-failed', board: f.boardKey })
      emit(
        'error',
        'close',
        f.boardKey,
        `[close] ${f.boardKey} ${f.sensorId} seg=${f.segmentId} の締めくくりに失敗: ${shorten(f.detail)}`,
      )
    }
  }

  const receiver = await startUdpReceiver({
    port,
    address,
    // **ここも間引きを通す。** データグラムの受け手が投げた例外はこの口へ流れてくるので、
    // 壊れた送り手が撃ち続けているあいだ、速度の上限に掛かる手前の 1 件ごとに 1 行出る。
    // 間引きを入れた意味がそこで消えるうえ、他の警告が埋もれる。
    //
    // **囲いはしない**（この口自身が投げたら落ちる側に倒す。段 4-1 で決めたとおり）。
    // 間引きは黙らせる仕組みではないので、その判断とは両立する。
    // 細目に例外の種類を使うのは、種類ごとに初回を必ず出すため —— 文面を鍵にすると
    // 中身（アドレス等）が混ざって枠が際限なく増える。
    onError: (error) => emit('error', 'udp', error.name, `[udp] ${error.message}`),
    onDatagram: (payload, from) => {
      // **届いた件数は上限を掛ける前に数える。** あとだと分母が上限そのものになり、
      // 「どれだけ撃たれているか」が表から読めなくなる。
      tally.record({ kind: 'received', source: from.address })

      // **上限は読み取りより前。** あとに置くと、落とすと決めたパケットの JSON を
      // 先に読むことになり、いちばん抑えたい場面で仕事が減らない。
      if (!rateLimit.allow(from.address)) {
        tally.record({ kind: 'rate-limited', source: from.address })
        emit('warn', 'limit', from.address, `[limit] ${formatSource(from)} 速度の上限で落とした`)
        return
      }

      const read = parseSensorPacket(payload)
      if (!read.ok) {
        // **ここは基板で数えられない。** ヘッダが読めていないので誰が送ったか判らず、
        // 判るのは送信元アドレスだけ（`packetTally.ts` が表を 2 つに分けている理由）。
        tally.record({ kind: 'parse-failed', source: from.address, reason: read.reason })
        emit(
          'warn',
          'read',
          `${from.address}|${read.reason}`,
          `[read] ${formatSource(from)} ${read.reason}: ${shorten(read.detail)}`,
        )
        return
      }

      const board = read.packet.boardKey
      tally.record({ kind: 'accepted', board })
      const outcome = pipeline.handlePacket(read.packet)

      if (outcome.dropped !== null) {
        tally.record({ kind: 'dropped', board, reason: outcome.dropped })
        const detail = outcome.detail === null ? '' : `: ${shorten(outcome.detail)}`
        emit(
          'warn',
          'drop',
          `${board}|${outcome.dropped}`,
          `[drop] ${formatSource(from)} ${outcome.dropped}${detail}`,
        )
      }
      if (outcome.startedBecause !== null) {
        tally.record({ kind: 'segment-started', board, reason: outcome.startedBecause })
        if (outcome.intensitySkipped !== null) {
          tally.record({ kind: 'intensity-skipped', board, reason: outcome.intensitySkipped })
        }
        const skip =
          outcome.intensitySkipped === null
            ? ''
            : `（震度なし: ${outcome.intensitySkipped}${
              outcome.detail === null ? '' : ` — ${shorten(outcome.detail)}`
            }）`
        emit(
          'log',
          'segment',
          `${board}|${outcome.startedBecause}`,
          `[segment] ${board} ${outcome.startedBecause}${skip}`,
        )
      }

      // **このパケットと無関係な流れが閉じられたら報せる。** 覚えていられる流れの数には
      // 上限があり、達すると**いちばん長く音沙汰の無い流れ**が閉じられる。版 2 のファームは
      // 再起動のたびに別の流れとして現れるので、枠は黙って埋まっていく。報せないと
      // 「あの基板の震度が急に出なくなった」理由がどこにも残らない。
      const current = streamKeyOf(read.packet)
      for (const c of outcome.closed) {
        if (c.meta.streamKey === current) continue
        tally.record({ kind: 'evicted', board: c.meta.boardKey })
        emit(
          'warn',
          'evict',
          c.meta.boardKey,
          `[evict] ${c.meta.boardKey} ${c.meta.sensorId} を枠の上限で閉じた`,
        )
      }
      reportCloseFailures(outcome.closeFailures)
      for (const r of outcome.readings) {
        tally.record({ kind: 'reading', board: r.boardKey })
        printReading(r)
      }
    },
  })

  console.log(`[udp] ${address ?? '0.0.0.0'}:${receiver.port} で待ち受け中`)

  let quietReported = false
  let reportedEvictions = 0
  let lastSummaryMs = Date.now()
  const summarize = (): void => {
    const evicted = rateLimit.evictions - reportedEvictions
    reportedEvictions = rateLimit.evictions
    const now = Date.now()
    const elapsedSec = windowSeconds(now - lastSummaryMs, SUMMARY_INTERVAL_MS / 1000)
    lastSummaryMs = now
    const summary = buildWindowSummary({
      windowSec: elapsedSec,
      window: tally.takeWindow(),
      evictedSources: evicted,
      quietReported,
    })
    quietReported = summary.quietReported
    for (const line of summary.lines) console.log(line)
  }
  const timer = setInterval(summarize, SUMMARY_INTERVAL_MS)

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    // **合図は繰り返し来る。** 2 度目で締めくくりをもう 1 度走らせない。
    if (closing) return
    closing = true
    clearInterval(timer)
    console.log(`[udp] ${signal} を受けたので締めます`)

    // **受信口を先に閉じる。** 締めくくりを先にすると、空にしたそばから届いた分が
    // 新しい区間を開き、二度と締められないまま終わる（その基板の最後の窓ぶんが、
    // 警告も記録も無いまま消える）。
    await receiver.close()

    // **締めくくりを出してから終える。** 出さずに終えると、最後の窓ぶんの答えが消える。
    // **ここで投げさせない** —— 終了に到達しなくなる。
    try {
      const rest = pipeline.closeAll()
      reportCloseFailures(rest.failures)
      for (const r of rest.readings) {
        tally.record({ kind: 'reading', board: r.boardKey })
        printReading(r)
      }
    } catch (error) {
      console.error(`[close] 締めくくりに失敗: ${messageOf(error)}`)
    }

    // **累計は最後に必ず出す。** ここを囲いの中へ入れると、締めくくりが投げたときに
    // 起動してからの数え上げが丸ごと消える。
    console.log('[集計] 起動してからの累計')
    for (const line of formatTally(tally.snapshotTotal())) console.log(`  ${line}`)
    if (rateLimit.evictions > 0) console.log(`  送信元の枠を捨てた=${rateLimit.evictions}`)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// **直接実行のときだけ走らせる。** 門が無いと、この先 `readPort` のような部品を
// 取り出してテストしようと読み込んだだけで、UDP の待ち受けが副作用として開く
// （同じ穴が `scripts/` 配下で起きたので、`scriptEntrypoints.test.ts` が検査している）。
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    // **起動に失敗したら落とす。** 待ち受けを開けなかったプロセスが走り続けると、
    // 基板は送っているのにどこにも届かない状態が黙って続く。
    console.error(messageOf(error))
    process.exit(1)
  })
}
