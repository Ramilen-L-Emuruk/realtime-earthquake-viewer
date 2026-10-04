// 自作地震計（ESP32 + MPU6050）の静穏時のばらつきを、UDP を直に受けて測る。
//
// **IIS2ICLX と同じ物差しで出す。** 1 秒ぶんの標準偏差を毎秒出し、その中央値を採る。
// 全体をまとめて 1 つの σ にすると、低周波のドリフトが乗って大きく出る。
//
// 単位は mg（1 mg = 0.980665 gal）。カウント値 × ug(µg/LSB) ÷ 1000 で mg になる。
//
// 使い方: node udp-noise.mjs [秒数]  （既定 90 秒・ポート 50505）
//
// **受け手（seismo-host）と同じポートを使う。** 基板は宛先のポートを 1 つしか持たないので、
// 測る間は受け手を止めること。止めずに起動すると、ポートを取れずに「受信に失敗」で終わる。
import dgram from 'node:dgram'

const PORT = Number(process.env.PORT ?? 50505)
const SECONDS = Number(process.argv[2] ?? 90)

/**
 * 1 秒の窓に要る標本の割合（そのセンサーが名乗る出力頻度に対して）。**これに満たない窓は捨てる。**
 * 測り始めと終わりの窓は途中までしか無く、標本が少ないぶん σ が揺れる。
 */
const MIN_WINDOW_FILL = 0.8

/** キー（基板|センサー|軸）ごとに、秒の窓へ値を溜める。 */
const buckets = new Map()
/**
 * そのキーが名乗った出力頻度。窓が埋まっているかの判定に使う（センサーごとに違いうる）。
 * **最後に名乗った値だけを持つ** —— 測っている間に同じセンサーの出力頻度が変わらないことを前提にしている。
 */
const hzByKey = new Map()
let packets = 0
let unreadable = 0
const senders = new Set()

function bucketFor(key) {
  let b = buckets.get(key)
  if (b === undefined) {
    b = new Map()
    buckets.set(key, b)
  }
  return b
}

function stddev(values) {
  if (values.length < 2) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const varSum = values.reduce((a, v) => a + (v - mean) * (v - mean), 0)
  return Math.sqrt(varSum / (values.length - 1))
}

function median(values) {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 版 1（v 欄が無い）と版 2 の両方を読む。要るのは識別・換算・時刻・軸名だけ。 */
function readHeader(h) {
  const ug = h.ug
  const hz = h.hz
  const t = h.t
  if (typeof ug !== 'number' || !(ug > 0)) return null
  if (typeof hz !== 'number' || !(hz > 0)) return null
  if (typeof t !== 'number' || !Number.isFinite(t)) return null
  if (h.v === 2) {
    const ch = Array.isArray(h.ch) ? h.ch : null
    if (ch === null) return null
    return { board: `mac:${h.mac}`, sensor: String(h.sid), channels: ch, ug, hz, t }
  }
  return { board: `name:${h.n}`, sensor: 'i2c0-68', channels: ['HN1', 'HN2', 'HN3'], ug, hz, t }
}

const sock = dgram.createSocket('udp4')

sock.on('message', (buf, rinfo) => {
  senders.add(rinfo.address)
  const lines = buf.toString('utf8').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length < 2) {
    unreadable++
    return
  }
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    unreadable++
    return
  }
  const head = readHeader(header)
  if (head === null) {
    unreadable++
    return
  }
  packets++
  const width = head.channels.length
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',')
    if (cols.length !== width) continue
    // このサンプルの時刻から秒の窓を決める。
    const sec = Math.floor((head.t + ((i - 1) * 1000) / head.hz) / 1000)
    for (let j = 0; j < width; j++) {
      const raw = Number(cols[j])
      if (!Number.isFinite(raw)) continue
      const key = `${head.board}|${head.sensor}|${head.channels[j]}`
      hzByKey.set(key, head.hz)
      const b = bucketFor(key)
      const list = b.get(sec)
      const mg = (raw * head.ug) / 1000
      if (list === undefined) b.set(sec, [mg])
      else list.push(mg)
    }
  }
})

sock.on('error', (err) => {
  console.error(`受信に失敗: ${err.message}`)
  process.exit(1)
})

sock.bind(PORT, () => {
  console.log(`ポート ${PORT} で待ち受けています。${SECONDS} 秒ぶん集めます…`)
})

setTimeout(() => {
  sock.close()
  console.log(``)
  console.log(`読めたパケット: ${packets} 件 / 読めなかったもの: ${unreadable} 件`)
  console.log(`送り手: ${senders.size === 0 ? '(なし)' : [...senders].sort().join(', ')}`)
  if (packets === 0) {
    console.log(``)
    console.log(`1 件も届いていません。基板が動いていないか、宛先が違います。`)
    process.exit(0)
  }
  const rows = []
  for (const [key, windows] of [...buckets.entries()].sort()) {
    const sds = []
    let samples = 0
    // 窓へ値を積むたびに必ず書いているので、ここで欠けることは無い。
    const minSamples = Math.floor(hzByKey.get(key) * MIN_WINDOW_FILL)
    for (const [, values] of windows) {
      if (values.length < minSamples) continue
      const sd = stddev(values)
      if (sd !== null) sds.push(sd)
      samples += values.length
    }
    const m = median(sds)
    if (m === null) continue
    rows.push({
      key,
      windows: sds.length,
      samples,
      medianMg: m,
      minMg: Math.min(...sds),
      maxMg: Math.max(...sds),
    })
  }
  console.log(``)
  console.log(`軸ごとの 1 秒 σ（mg）— 中央値で比べる`)
  for (const r of rows) {
    console.log(
      `  ${r.key.padEnd(34)} 窓=${String(r.windows).padStart(3)} σ中央=${r.medianMg.toFixed(4)}  (最小 ${r.minMg.toFixed(4)} / 最大 ${r.maxMg.toFixed(4)})`,
    )
  }
  const all = rows.map((r) => r.medianMg)
  if (all.length > 0) {
    console.log(``)
    console.log(
      `全軸の中央値: ${median(all).toFixed(4)} mg   最小 ${Math.min(...all).toFixed(4)} / 最大 ${Math.max(...all).toFixed(4)} mg`,
    )
  } else {
    console.log(`  (1 秒ぶん揃った窓がありませんでした)`)
  }
}, SECONDS * 1000)
