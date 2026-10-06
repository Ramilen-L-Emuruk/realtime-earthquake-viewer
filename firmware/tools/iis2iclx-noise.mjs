// IIS2ICLX の測定範囲ごとのノイズ（1 秒ぶんの σ）を測り比べる。
//
// probe（`firmware/iis2iclx-probe/`）を焼いた基板に、測定範囲を `POST /fs` で切り替えさせ、
// 状態の口（`GET /`）が毎秒締める σ を集める。**範囲を交互に何巡も切り替える** ——
// 片方を測り終えてからもう片方を測ると、その間に変わった置き方や周りの揺れ
// （人の歩き・空調）が範囲の違いに見えてしまう。
//
// 使い方（リポジトリのいちばん上で）:
//   node firmware/tools/iis2iclx-noise.mjs                       … 既定: ±0.5g と ±2g を 4 巡・各 30 周期
//   node firmware/tools/iis2iclx-noise.mjs --scales=0.5,1,2,3 --rounds=3 --periods=20
//   node firmware/tools/iis2iclx-noise.mjs --host=<IP>   … mDNS の名前（iis2iclx-probe.local）で引けないとき
//
// - **測る間は基板に触れない。** σ は静止させた値でないと意味が無い
// - 終わったら測定範囲を ±0.5g へ戻す（途中で止めたときは戻らないので、`POST /fs?g=0.5` か再起動）
// - 結果と読み方は firmware/README.md「センサーの品種を比べた」

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (!m) throw new Error(`引数は --名前=値 の形で渡す: ${a}`)
    return [m[1], m[2]]
  }),
)
const HOST = args.host ?? 'iis2iclx-probe.local'
const SCALES = (args.scales ?? '0.5,2').split(',')
const ROUNDS = Number(args.rounds ?? 4)
const PERIODS = Number(args.periods ?? 30)
const POLL_MS = 400
const TIMEOUT_MS = 5000
/** 1 つの範囲を測り終えるまでの上限。周期は 1 秒なので、これを超えたら基板が締めていない。 */
const MAX_WAIT_MS = (PERIODS + 10) * 1000
if (!(ROUNDS >= 1) || !(PERIODS >= 3)) throw new Error('--rounds は 1 以上、--periods は 3 以上')

async function http(method, path) {
  const res = await fetch(`http://${HOST}${path}`, { method, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.trim()}`)
  return JSON.parse(text)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 1 つの範囲で、センサーごとに PERIODS 周期ぶんの σ を集める。 */
async function measure(scale) {
  const sw = await http('POST', `/fs?g=${encodeURIComponent(scale)}`)
  if (sw.failed > 0) throw new Error(`測定範囲 ${scale} への切り替えが ${sw.failed} 個で失敗した`)
  const gen = sw.fsGeneration
  /** センサーの名前 → { periods: Set, x: number[], y: number[], meanX, meanY, n } */
  const got = new Map()
  const started = Date.now()
  for (;;) {
    if (Date.now() - started > MAX_WAIT_MS) {
      throw new Error(`測定範囲 ${scale}: ${MAX_WAIT_MS / 1000} 秒待っても ${PERIODS} 周期が集まらない`)
    }
    await sleep(POLL_MS)
    const st = await http('GET', '/')
    // **切り替え後の値だけを数える。** 世代が違えば、別の範囲の周期を読んでいる
    if (st.fsGeneration !== gen) throw new Error(`測定範囲が途中で切り替わった（世代 ${gen} → ${st.fsGeneration}）`)
    for (const s of st.sensors) {
      if (!s.initialized || !s.measured) continue
      const key = `${s.bus} ${s.addr}`
      let e = got.get(key)
      if (!e) got.set(key, (e = { periods: new Set(), x: [], y: [], meanX: [], meanY: [], short: 0, errors: 0 }))
      if (e.periods.has(s.period) || e.x.length >= PERIODS) continue
      e.periods.add(s.period)
      // 件数が出力頻度から外れた周期は数えない（読みが詰まると σ の母数が変わる）
      if (s.n < 95 || s.n > 113) { e.short++; continue }
      if (s.readErrors > 0) e.errors += s.readErrors
      e.x.push(s.x.sdMg); e.y.push(s.y.sdMg)
      e.meanX.push(s.x.meanMg); e.meanY.push(s.y.meanMg)
    }
    if (got.size > 0 && [...got.values()].every((e) => e.x.length >= PERIODS)) return { label: st.fullScale, got }
  }
}

const median = (a) => {
  const s = [...a].sort((p, q) => p - q)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function main() {
  const first = await http('GET', '/')
  console.log(`基板 ${first.node}（${first.ip}）・センサー ${first.sensors.length} 個・いまの測定範囲 ${first.fullScale}`)
  /** 範囲 → センサー → { x: number[], y: number[], ... }（全巡を通した周期ごとの値） */
  const all = new Map()
  /** 測れなかった巡と範囲。**1 つ落ちても残りは数え、最後に名前を出す。** */
  const failures = []
  try {
    for (let r = 1; r <= ROUNDS; r++) {
      for (const scale of SCALES) {
        let result
        try {
          result = await measure(scale)
        } catch (err) {
          failures.push(`巡 ${r} 範囲 ${scale}: ${err.message}`)
          console.log(`巡 ${r} 範囲 ${scale}: 測れなかった（${err.message}）`)
          continue
        }
        const { label, got } = result
        const line = [...got].map(([k, e]) => `${k} X ${median(e.x).toFixed(4)} Y ${median(e.y).toFixed(4)}`).join(' / ')
        console.log(`巡 ${r} ${label}: ${line}（mg・${PERIODS} 周期の中央値）`)
        if (!all.has(label)) all.set(label, new Map())
        for (const [k, e] of got) {
          const acc = all.get(label).get(k) ?? { x: [], y: [], meanX: [], meanY: [], short: 0, errors: 0 }
          acc.x.push(...e.x); acc.y.push(...e.y); acc.meanX.push(...e.meanX); acc.meanY.push(...e.meanY)
          acc.short += e.short; acc.errors += e.errors
          all.get(label).set(k, acc)
        }
      }
    }
  } finally {
    try { await http('POST', '/fs?g=0.5'); console.log('測定範囲を ±500mg へ戻した') } catch (err) {
      console.log(`測定範囲を戻せなかった（${err.message}）。POST /fs?g=0.5 か再起動で戻すこと`)
      process.exitCode = 1
    }
  }

  console.log(`\n## 1 秒ぶんの σ（mg）— ${ROUNDS} 巡 × ${PERIODS} 周期の中央値（括弧は周期ごとの値の 10〜90%）`)
  console.log('測定範囲 | センサー | 集まった周期 | X の σ | Y の σ | X の平均 | Y の平均 | 外した周期 | 読み取り失敗')
  // **途中で脱落したセンサーを見落とさない。** 範囲の切り替えに失敗したセンサーは以後の巡で
  // 黙って一覧から外れる（probe が initialized:false として扱う）ので、周期数で気づく
  const expected = ROUNDS * PERIODS
  const sensorKeys = new Set([...all.values()].flatMap((m) => [...m.keys()]))
  for (const [label, bySensor] of all) {
    for (const k of sensorKeys) {
      const n = bySensor.get(k)?.x.length ?? 0
      if (n < expected) failures.push(`${label} ${k}: 集まった周期 ${n} / ${expected}`)
    }
    for (const [k, e] of bySensor) {
      const q = (a, p) => { const s = [...a].sort((u, v) => u - v); return s[Math.floor(p * (s.length - 1))] }
      console.log(
        `${label} | ${k} | ${e.x.length}/${expected} | ${median(e.x).toFixed(4)}（${q(e.x, 0.1).toFixed(4)}〜${q(e.x, 0.9).toFixed(4)}）`
        + ` | ${median(e.y).toFixed(4)}（${q(e.y, 0.1).toFixed(4)}〜${q(e.y, 0.9).toFixed(4)}）`
        + ` | ${median(e.meanX).toFixed(2)} | ${median(e.meanY).toFixed(2)} | ${e.short} | ${e.errors}`,
      )
    }
  }
  if (failures.length > 0) {
    console.log(`\n測れなかった巡 ${failures.length} 件（上の表に含まれていない）:\n  ${failures.join('\n  ')}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
