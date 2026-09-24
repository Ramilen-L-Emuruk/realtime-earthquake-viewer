// 自作センサーの受け手。UDP で待ち受け、届いたパケットを段 1〜3 へ通して
// 計測震度相当を出す常駐プロセス。
//
// **いまの出口は標準出力だけ。** 生データの保存は 4-3、状態の口（JSON と SSE）は 4-4、
// 落とした件数の集計と送信元の制限は 4-2 が受け持つ。ここはまだ「繋がっていること」を
// 目で確かめるための入口で、1 件ずつそのまま出す。
//
// **画面を持たない常駐プロセスなので、黙ったら誰も気づかない。** 受け取った結果
// （`PacketOutcome`）のどの欄も読み捨てないこと —— 読み捨てた欄は、そこで起きた異常が
// どこにも現れないことを意味する。
//
// 起動:
//   npm run seismo-host
//   SEISMO_UDP_PORT=50505 SEISMO_UDP_ADDRESS=0.0.0.0 npm run seismo-host
import { pathToFileURL } from 'node:url'

import { parseSensorPacket } from './src/protocol/parsePacket'
import { IntensityPipeline } from './src/receiver/intensityPipeline'
import type { CloseFailure, IntensityReading } from './src/receiver/intensityPipeline'
import { startUdpReceiver } from './src/receiver/udpReceiver'
import type { DatagramSource } from './src/receiver/udpReceiver'
import { streamKeyOf } from './src/timebase/segmenter'

/** 記録係の原型（`capture.mjs`）と同じ口。基板の送り先もこの値。 */
const DEFAULT_PORT = 50505

/** 読めなかった中身を記録へ出す長さ。**全部は出さない** —— 1 行が読めなくなる。 */
const DETAIL_CHARS = 120

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

function printReading(r: IntensityReading): void {
  const at = new Date(r.atMs).toISOString()
  const value = r.intensity === null ? '-' : r.intensity.toFixed(2)
  // **時刻の根拠が崩れていたら、その行に書く。** 倒れている間の `atMs` は正常時と
  // 同じ形をしているので、行の外で報せると正常な値と見分けが付かない。
  const timebase = r.timebaseNominalReason === null ? '' : ` 時刻=公称(${r.timebaseNominalReason})`
  console.log(`${at} ${r.boardKey} ${r.sensorId} seg=${r.segmentId} I=${value}${timebase}`)
}

function printCloseFailures(failures: readonly CloseFailure[]): void {
  for (const f of failures) {
    // 締めくくりを出せなかった＝その区間の最後の窓ぶんが失われている。
    console.error(`[close] seg=${f.segmentId} の締めくくりに失敗: ${shorten(f.detail)}`)
  }
}

async function main(): Promise<void> {
  const port = readPort(process.env.SEISMO_UDP_PORT)
  const address = process.env.SEISMO_UDP_ADDRESS
  const pipeline = new IntensityPipeline()

  const receiver = await startUdpReceiver({
    port,
    address,
    onError: (error) => console.error(`[udp] ${error.message}`),
    onDatagram: (payload, from) => {
      const read = parseSensorPacket(payload)
      if (!read.ok) {
        console.warn(`[read] ${formatSource(from)} ${read.reason}: ${shorten(read.detail)}`)
        return
      }
      const outcome = pipeline.handlePacket(read.packet)

      if (outcome.dropped !== null) {
        const detail = outcome.detail === null ? '' : `: ${shorten(outcome.detail)}`
        console.warn(`[drop] ${formatSource(from)} ${outcome.dropped}${detail}`)
      }
      if (outcome.startedBecause !== null) {
        const skip =
          outcome.intensitySkipped === null
            ? ''
            : `（震度なし: ${outcome.intensitySkipped}${
              outcome.detail === null ? '' : ` — ${shorten(outcome.detail)}`
            }）`
        console.log(`[segment] ${read.packet.boardKey} ${outcome.startedBecause}${skip}`)
      }

      // **このパケットと無関係な流れが閉じられたら報せる。** 覚えていられる流れの数には
      // 上限があり、達すると**いちばん長く音沙汰の無い流れ**が閉じられる。版 2 のファームは
      // 再起動のたびに別の流れとして現れるので、枠は黙って埋まっていく。報せないと
      // 「あの基板の震度が急に出なくなった」理由がどこにも残らない。
      const current = streamKeyOf(read.packet)
      for (const c of outcome.closed) {
        if (c.meta.streamKey === current) continue
        console.warn(`[evict] ${c.meta.boardKey} ${c.meta.sensorId} を枠の上限で閉じた`)
      }
      printCloseFailures(outcome.closeFailures)
      for (const r of outcome.readings) printReading(r)
    },
  })

  console.log(`[udp] ${address ?? '0.0.0.0'}:${receiver.port} で待ち受け中`)

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    // **合図は繰り返し来る。** 2 度目で締めくくりをもう 1 度走らせない。
    if (closing) return
    closing = true
    console.log(`[udp] ${signal} を受けたので締めます`)

    // **受信口を先に閉じる。** 締めくくりを先にすると、空にしたそばから届いた分が
    // 新しい区間を開き、二度と締められないまま終わる（その基板の最後の窓ぶんが、
    // 警告も記録も無いまま消える）。
    await receiver.close()

    // **締めくくりを出してから終える。** 出さずに終えると、最後の窓ぶんの答えが消える。
    // **ここで投げさせない** —— 終了に到達しなくなる。
    try {
      const rest = pipeline.closeAll()
      printCloseFailures(rest.failures)
      for (const r of rest.readings) printReading(r)
    } catch (error) {
      console.error(`[close] 締めくくりに失敗: ${messageOf(error)}`)
    }
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
