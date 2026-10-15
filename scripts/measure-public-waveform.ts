/**
 * 公開観測点の受け方を EarthScope で実測する（設計書 `docs/public-waveform-design.md` §11）。
 *
 * - M1: 1 本の SeedLink 接続に、リングの 20 点を載せ、2 分前から 60 秒受ける（手順にかかる時間・
 *   最初のレコードまで・届いた観測点と成分・最新のサンプルの遅れ）
 * - M2: `END` を送った後に `STATION` を送ったら何が返るか（1 点・20 秒）
 * - M3: 保存庫（FDSN dataselect）へ 2 点・20 点を 1 回ずつ問い合わせる（5 分の窓・所要・大きさ）
 *
 * **通信は WebSocket 2 本・HTTP 2 件だけ。既定は空振り**（行き先と件数を出して終わる）。
 * 実際に繋ぐのは `--run` を付けたときだけ。**どれか 1 つでも測れなかったら終了コードは 1**
 * （失敗を「何も返らなかった」という結果に見せない）。
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSeedlink, EARTHSCOPE_SEEDLINK_URL, SEEDLINK_SUBPROTOCOL, type SeedlinkClosed } from '../src/services/seedlink'
import { SeedlinkSession } from '../src/services/seedlinkSession'
import { Mseed2Error, parseMseed2Record } from '../src/utils/miniseed2'

const RING = ['JCJ', 'JEM', 'JEW', 'JGF', 'JHJ2', 'JHS', 'JKA', 'JMM', 'JMN', 'JMZ', 'JNU', 'JOW', 'JSD', 'JSG', 'JSU', 'JTM', 'JTU', 'JWT', 'JYT', 'YOJ']
const M1_SECONDS = 60
const M2_SECONDS = 20
const M2_EXTRA_AFTER_MS = 5_000

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19)

/** 読めなかった理由ごとの数 */
function tally(): { add(kind: string): void; text(): string } {
  const m = new Map<string, number>()
  return {
    add: (k) => m.set(k, (m.get(k) ?? 0) + 1),
    text: () => (m.size === 0 ? 'なし' : [...m].map(([k, n]) => `${k} ${n}`).join('・')),
  }
}

/** M1: 20 点を 1 本で受ける。測れたら true */
function measureRing(now: number): Promise<boolean> {
  return new Promise((done) => {
    const t0 = Date.now()
    let first = -1
    let latestEnd = 0
    const per = new Map<string, number>()
    const bad = tally()
    const conn = connectSeedlink(
      {
        url: EARTHSCOPE_SEEDLINK_URL,
        request: { network: 'JP', stations: RING, startMs: now - 120_000 },
        openTimeoutMs: 15_000,
        replyTimeoutMs: 15_000,
        stallTimeoutMs: 120_000,
        webSocket: globalThis.WebSocket,
      },
      {
        onRecord(r) {
          const key = `${r.station}.${r.channel}`
          per.set(key, (per.get(key) ?? 0) + 1)
          latestEnd = Math.max(latestEnd, r.startMs + (r.samples.length / r.sampleRate) * 1000)
        },
        onUnreadable(p) {
          bad.add(p)
        },
        onStreaming() {
          first = Date.now() - t0
        },
        onClosed(c: SeedlinkClosed) {
          clearTimeout(stop)
          const ok = c.reason === 'closed-by-caller' && c.records > 0
          const stations = new Set([...per.keys()].map((k) => k.split('.')[0]))
          console.log(`  M1 ${ok ? '測れた' : '測れなかった'}: 閉じた理由 ${c.reason} ${c.detail}`)
          console.log(`  M1 読めたレコード ${c.records}・読めない ${c.unreadable}（${bad.text()}）`)
          if (c.records > 0) {
            console.log(`  M1 最初のレコードまで ${first} ms・観測点 ${stations.size}/${RING.length}・成分 ${per.size}/${RING.length * 3}`)
            console.log('  M1 届かなかった観測点:', RING.filter((s) => !stations.has(s)).join(' ') || 'なし')
            console.log(`  M1 最新のサンプルの遅れ: ${((Date.now() - latestEnd) / 1000).toFixed(1)} 秒`)
          }
          done(ok)
        },
      },
    )
    const stop = setTimeout(() => conn.close(), M1_SECONDS * 1000)
  })
}

/**
 * M2: END の後に STATION を足せるか。本流の connectSeedlink は END の後に命令を送る口を持たないので、
 * 手順だけ同じ部品（SeedlinkSession）で進め、送るのはここで直に行う。測れたら true
 */
function measureAddAfterEnd(now: number): Promise<boolean> {
  return new Promise((done) => {
    const session = new SeedlinkSession({ network: 'JP', stations: ['JMN'], startMs: now - 60_000 })
    const ws = new WebSocket(EARTHSCOPE_SEEDLINK_URL, [SEEDLINK_SUBPROTOCOL])
    ws.binaryType = 'arraybuffer'
    let opened = false
    let streaming = false
    let sentExtra = false
    let refused = ''
    const stations = new Map<string, number>()
    const bad = tally()
    const afterExtra: string[] = []
    const send = (c: string) => ws.send(`${c}\r\n`)
    ws.onopen = () => {
      opened = true
      for (const ev of session.start()) if (ev.type === 'send') send(ev.command)
    }
    ws.onmessage = (msg) => {
      const data = msg.data
      const bytes =
        typeof data === 'string' ? Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff) : new Uint8Array(data as ArrayBuffer)
      for (const ev of session.feed(bytes)) {
        if (ev.type === 'send') {
          send(ev.command)
          if (ev.command === 'END' && !streaming) {
            streaming = true
            setTimeout(() => {
              sentExtra = true
              send('STATION YOJ JP')
            }, M2_EXTRA_AFTER_MS)
          }
        } else if (ev.type === 'packet') {
          try {
            const r = parseMseed2Record(ev.record)
            stations.set(r.station, (stations.get(r.station) ?? 0) + 1)
          } catch (e) {
            bad.add(e instanceof Mseed2Error ? e.problem : 'internal-error')
          }
        } else if (ev.type === 'refused' || ev.type === 'unexpected') {
          refused = `${ev.type}: ${ev.command} → ${ev.reply}`
          if (sentExtra) afterExtra.push(refused)
        } else {
          bad.add('garbled')
          if (sentExtra) afterExtra.push(`読み飛ばし ${ev.droppedBytes} バイト（${JSON.stringify(ev.head)}）`)
        }
      }
    }
    ws.onerror = () => {
      // close が続く。理由は close で出す
    }
    ws.onclose = (ev) => {
      clearTimeout(stop)
      const ok = opened && streaming && sentExtra && (stations.get('JMN') ?? 0) > 0
      console.log(`  M2 ${ok ? '測れた' : '測れなかった'}: code ${ev.code}・開いた ${opened}・END まで ${streaming}・STATION を足した ${sentExtra}`)
      if (refused && !sentExtra) console.log(`  M2 足す前に断られた: ${refused}`)
      console.log('  M2 観測点ごとのレコード', Object.fromEntries(stations), `・読めない ${bad.text()}`)
      console.log('  M2 足した後に届いたレコード以外の応答:', afterExtra.length ? afterExtra.join(' / ') : 'なし')
      done(ok)
    }
    const stop = setTimeout(() => ws.close(), M2_SECONDS * 1000)
  })
}

/** M3: 保存庫へ 1 回問い合わせる。測れたら true（404 は「データなし」として測れなかった側へ数える） */
async function measureArchive(url: string, stas: string[]): Promise<boolean> {
  const t = Date.now()
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  } catch (e) {
    console.log(`  M3 ${stas.length} 点: 測れなかった（取得に失敗: ${String(e)}）`)
    return false
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  const ms = Date.now() - t
  if (!res.ok) {
    console.log(`  M3 ${stas.length} 点: 測れなかった（${res.status}・${res.headers.get('content-type') ?? '型なし'}・${buf.length} バイト）`)
    return false
  }
  const per = new Map<string, number>()
  const bad = tally()
  let at = 0
  while (at < buf.length) {
    if (buf.length - at < 512) {
      bad.add(`端数 ${buf.length - at} バイト`)
      break
    }
    try {
      const r = parseMseed2Record(buf.subarray(at))
      per.set(r.station, (per.get(r.station) ?? 0) + 1)
      at += r.recordLength
    } catch (e) {
      bad.add(e instanceof Mseed2Error ? e.problem : 'internal-error')
      at += 512
    }
  }
  const missing = stas.filter((s) => !per.has(s))
  console.log(`  M3 ${stas.length} 点: ${res.status}・${ms} ms・${buf.length} バイト・観測点 ${per.size}/${stas.length}・読めない ${bad.text()}`)
  if (missing.length > 0) console.log(`  M3 返らなかった観測点: ${missing.join(' ')}`)
  return per.size > 0
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const unknown = args.filter((a) => a !== '--run')
  if (unknown.length > 0) throw new Error(`知らない引数: ${unknown.join(' ')}（使えるのは --run）`)
  const dry = !args.includes('--run')
  const now = Date.now()
  const winEnd = Math.floor((now - 3600_000) / 60_000) * 60_000
  const winStart = winEnd - 300_000
  const ds = (stas: string[]) =>
    `https://service.earthscope.org/fdsnws/dataselect/1/query?net=JP&sta=${stas.join(',')}&cha=BH?&starttime=${iso(winStart)}&endtime=${iso(winEnd)}&nodata=404`
  const archive = [['JMN', 'YOJ'], RING]
  console.log('M1 WebSocket', EARTHSCOPE_SEEDLINK_URL, `${RING.length} 点・開始 ${iso(now - 120_000)}Z・${M1_SECONDS} 秒`)
  console.log('M2 WebSocket', EARTHSCOPE_SEEDLINK_URL, `JMN・${M2_SECONDS} 秒・END の ${M2_EXTRA_AFTER_MS / 1000} 秒後に STATION YOJ JP`)
  for (const stas of archive) console.log('M3 HTTP', ds(stas))
  console.log('合計: WebSocket 2 本・HTTP 2 件')
  if (dry) {
    console.log('空振りで終えました（繋ぐには --run）')
    return
  }
  const results: boolean[] = []
  results.push(await measureRing(now))
  await new Promise((r) => setTimeout(r, 1000))
  results.push(await measureAddAfterEnd(now))
  await new Promise((r) => setTimeout(r, 1000))
  for (const stas of archive) {
    results.push(await measureArchive(ds(stas), stas))
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (results.some((ok) => !ok)) {
    console.log(`測れなかったものがある（${results.filter((ok) => !ok).length}/${results.length}）`)
    process.exitCode = 1
  }
}

/** 直接実行のときだけ動かす（理由は `scripts/build-epicenter-accents.ts` の末尾） */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
