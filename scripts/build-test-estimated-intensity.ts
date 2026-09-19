/**
 * テストボタン用の推計震度分布図データ（`src/data/test-estimated-intensity.json`）を、
 * **実電文をパーサーへ通して**作り直す。
 *
 * ## なぜ地震情報と対で作るのか
 *
 * 推計震度分布図（IXAC41）は**識別子を持たない**電文で、地震カードとの結び付けは
 * 地震発現時刻で行う（→ `utils/estimatedIntensity.ts`）。分布だけをテストデータに置いても、
 * 引き当てる相手のカードが無いのでボタンが出ない。**同じ地震の VXSE53 と対で**作る。
 *
 * 震源も揃っている必要がある —— 引き当ては時刻に加えて震源の距離でも裏を取るし、
 * 何より能登の地震カードに熊本の分布が出たら、テストとして意味を成さない。
 *
 * ## なぜスクリプトとして残すのか
 *
 * テストボタンは実機で挙動を確かめられる唯一の入口で、**そこに無い形は一度も画面に出ない**
 * （CLAUDE.md「テストボタンは実機確認の唯一の入口」）。手で組み立てると、電文から読む項目を
 * 足すたびにテストデータだけ古い形のまま残る。**まして BUFR は手で書けない。**
 *
 * ## 使い方
 *
 * ```
 * npm run build-test-estimated-intensity -- --arrival=2026-07-28T10:03
 * ```
 *
 * **要 DMDATA.JP API キー**（リポジトリ直下の `.env.local` の `DMDATA_API_KEY`。
 * ワークツリーへは引き継がれないのでコピーすること）。
 *
 * **鍵は `EventID` ではなく地震発現時刻（UTC・分まで）。** IXAC41 は識別子を持たないので、
 * 地震情報と結び付けられるのは発現時刻しかない —— アプリ側の引き当てと同じ鍵で選ぶ。
 * 既定は 2026-07-28 10:03 UTC の熊本県熊本地方 M4.2 で、**推計震度分布図が出た地震のうち
 * いちばんセルが少ない**（1,693 セル）ためテストデータが軽く済む。
 *
 * 実電文そのものはリポジトリへ入れられない（配信元の利用規約。
 * → docs/spec/telegram-coverage-audit.md §2）。ここが書き出すのは**読み取った後の値**。
 *
 * ## 取得は共通の口を通す
 *
 * アーカイブの一覧・本体の取得は `telegram-audit/archive-cache.mjs` に集約してある。
 * **素の `fetch` を書き足さないこと** —— 控えもレート制御も 429 のバックオフも通らず、
 * 同じ日を何度でも取り直す形になる（→ `docs/spec/data-sources-spec.md` §2
 * 「リクエスト数を抑える」）。控えは分類・日・アーカイブ id で引くので、
 * **監査スクリプトが既に取った日はここでもリクエストを出さない**（逆も同じ）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  apiAuthHeader,
  dayOf,
  EARTHQUAKE_CLASSIFICATION,
  listArchive,
  loadArchiveTar,
  runArchiveScript,
  tarEntries,
} from './telegram-audit/archive-cache.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'src/data/test-estimated-intensity.json')

/** セルの格子。緯度 1/480 度・経度 1/320 度にきっちり乗るので、整数の添字で持てば正確かつ小さい。 */
const LAT_STEPS = 480
const LON_STEPS = 320

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

async function build() {
  const arrival = arg('arrival', '2026-07-28T10:03')
  const wanted = new Date(`${arrival}:00Z`).toISOString().slice(0, 16)
  if (wanted === 'Invalid Date'.slice(0, 16)) throw new Error(`--arrival を日時として読めません: ${arrival}`)
  // アーカイブは JST 日で束ねられている。発現時刻（UTC）から JST の日付を出す。
  const day = new Date(new Date(`${arrival}:00Z`).getTime() + 9 * 3600_000).toISOString().slice(0, 10)
  const auth = apiAuthHeader()

  // 両端より広く取らないと目的の日が返らない（→ CLAUDE.md「読み取りの変更はリプレイで確かめる」）。
  const from = new Date(new Date(`${day}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10)
  const to = new Date(new Date(`${day}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)
  const items = await listArchive({ classification: EARTHQUAKE_CLASSIFICATION, from, to, auth })
  // **1 日 1 分類につきアーカイブは 1 ファイル**なので先頭を採ってよい。他の 2 本
  // （`build-test-quake` / `build-test-lpgm`）が全件をループするのは「1 ファイルの中に
  // 同じ地震の電文が複数ある」からで、ファイルが複数あるからではない。
  const item = items.find(i => dayOf(i).startsWith(day))
  // 件数を添えるのは「一覧は取れたがその日が無い」と「一覧そのものが空」を区別するため。
  if (!item) throw new Error(`${day} のアーカイブが見つかりません（一覧 ${items.length} 件）`)

  const tar = await loadArchiveTar({ classification: EARTHQUAKE_CLASSIFICATION, item, auth })
  const files = new Map<string, Buffer>()
  for (const e of tarEntries(tar)) files.set(e.name, e.body)

  // パーサーは `DOMParser` を使うため、Node からは jsdom を通して読み込む。
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM()
  ;(globalThis as unknown as { DOMParser: typeof dom.window.DOMParser }).DOMParser = dom.window.DOMParser
  const { parseEarthquakeFromXml } = await import('../src/services/dmdataParser')
  const { decodeEstimatedIntensity } = await import('../src/utils/bufrEstimatedIntensity')
  const { BufrFragmentStore, fragmentKey } = await import('../src/services/bufrTelegramAssembly')

  // ── 地震情報（VXSE53）を探す。**発現時刻が一致する報のうち観測点がいちばん多いもの**を採る ──
  let quake: ReturnType<typeof parseEarthquakeFromXml> = null
  for (const [name, body] of files) {
    if (!/^VXSE53_/.test(name) || !name.endsWith('.xml')) continue
    const parsed = parseEarthquakeFromXml('VXSE53', body.toString('utf8'))
    if (!parsed) continue
    if (new Date(parsed.earthquake.time).toISOString().slice(0, 16) !== wanted) continue
    if (!quake || parsed.points.length > quake.points.length) quake = parsed
  }
  if (!quake) throw new Error(`${day} に発現時刻 ${wanted} の VXSE53 が見つかりません`)

  // ── 推計震度分布図（IXAC41）を探す。**同じ発現時刻のものだけ**を採る ──
  const store = new BufrFragmentStore()
  const byTime = new Map<string, { name: string; designation: string | null; body: Buffer }[]>()
  for (const [name, body] of files) {
    const m = /^IXAC41_RJTD_(RR[A-X]_)?(\d{17})_/.exec(name)
    if (!m || !name.endsWith('.bin')) continue
    const t = m[2].slice(0, 12)
    if (!byTime.has(t)) byTime.set(t, [])
    byTime.get(t)!.push({ name, designation: m[1] ? m[1].slice(0, 3) : null, body })
  }
  let estimated: ReturnType<typeof decodeEstimatedIntensity> = null
  for (const [t, parts] of byTime) {
    let joined: Uint8Array | null = null
    for (const p of parts.sort((a, b) => a.name.localeCompare(b.name))) {
      joined = store.add(fragmentKey('IXAC41', 'RJTD', t), p.designation, new Uint8Array(p.body), Date.now())
    }
    if (!joined) continue
    const decoded = decodeEstimatedIntensity(joined, `test-${t}`, quake.time, 'IXAC41')
    if (!decoded) continue
    if (decoded.arrivalTime.slice(0, 16) !== wanted) continue
    // 続報があれば**セルが多いほう**を採る（分布が広く出ている報のほうがテストに向く）。
    if (!estimated || decoded.count > estimated.count) estimated = decoded
  }
  if (!estimated) {
    throw new Error(`${day} に発現時刻 ${wanted} の IXAC41 が見つかりません（この地震には推計震度分布図が出ていません）`)
  }

  // ── 書き出し ──
  // セルは格子の整数添字で持つ。小数で書くと桁が無駄なうえ、読み戻しで丸めが乗る。
  const latIdx: number[] = []
  const lonIdx: number[] = []
  const si: number[] = []
  for (let i = 0; i < estimated.count; i++) {
    latIdx.push(Math.round(estimated.lat[i] * LAT_STEPS))
    lonIdx.push(Math.round(estimated.lon[i] * LON_STEPS))
    si.push(estimated.si[i])
  }
  // 報ごとに変わるもの（識別子・発表時刻・電文を数える鍵・電文が名乗った報番号）は
  // テスト側で作るので落とす。**パーサーへ報ごとの項目を足したらここへも足すこと**
  // （理由は `build-test-quake.ts` の同じ箇所。検査は `src/utils/testData.test.ts`）。
  const {
    id: _qid, eventId: _qeid, time: _qtime,
    telegramKey: _qTelegramKey, reportSerial: _qReportSerial,
    ...quakeRest
  } = quake
  const out = {
    quake: quakeRest,
    estimated: {
      hypocenter: estimated.hypocenter,
      magnitude: Number.isNaN(estimated.magnitude) ? null : estimated.magnitude,
      ...(estimated.magnitudeCondition && { magnitudeCondition: estimated.magnitudeCondition }),
      areaCode: estimated.areaCode,
      telegramKind: estimated.telegramKind,
      grades: estimated.grades,
      latIdx, lonIdx, si,
    },
  }
  fs.writeFileSync(OUT, JSON.stringify(out), 'utf8')
  console.log(
    `${day} 発現 ${wanted} から作りました: 観測点 ${quake.points.length}・最大震度 ${quake.earthquake.maxScale}`
    + ` / 推計 ${estimated.count} セル・凡例 ${estimated.grades.length} 段・発現 ${estimated.arrivalTime}`,
  )
}

runArchiveScript('アーカイブ（推計震度分布図のテストデータ）', build)
  .catch((e) => { console.error(e); process.exit(1) })
