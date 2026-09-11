/**
 * テストボタン用の地震情報データ（`src/data/noto-honshin-2024-quake.json`）を、
 * **実電文をパーサーへ通して**作り直す。長周期の `build-test-lpgm.ts` と同じ考え方。
 *
 * ## なぜ実電文から作るのか
 *
 * テストボタンは実機で挙動を確かめられる唯一の入口で、**そこに無い形は一度も画面に出ない**
 * （CLAUDE.md「テストボタンは実機確認の唯一の入口」）。
 *
 * 手で組み立てた版は**観測点が市町村に紐付いていなかった**。実電文は観測点を市町村の下に
 * 置くので（`Pref/Area/City/IntensityStation`）、カードの 4 段表示では市町村の下に観測点が
 * 入る。紐付けの無いデータでは市町村と観測点が同じ段に並び、**実機で 4 段目を確かめられない**。
 *
 * ## 使い方
 *
 * ```
 * npm run build-test-quake -- --event=20240101161010
 * ```
 *
 * **要 DMDATA.JP API キー**（リポジトリ直下の `.env.local` の `DMDATA_API_KEY`。
 * ワークツリーへは引き継がれないのでコピーすること）。`--event` は電文の `EventID`
 * （14 桁）。既定は能登半島地震の本震。
 *
 * 同じ `EventID` の電文が複数あるときは**観測点がいちばん多いもの**を採る —— 続報で
 * 観測点が積み上がるため、確定報がもっとも厚い。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'src/data/noto-honshin-2024-quake.json')

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function readApiKey(): string {
  const envPath = path.join(ROOT, '.env.local')
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env.local がありません（${envPath}）。DMDATA_API_KEY を置いてください`)
  }
  const key = (fs.readFileSync(envPath, 'utf8').match(/^DMDATA_API_KEY=(.+)$/m) ?? [])[1]?.trim()
  if (!key) throw new Error('.env.local に DMDATA_API_KEY がありません')
  return key
}

/** tar の展開（アーカイブは tar.gz で配られる） */
function* tarEntries(buf: Buffer): Generator<{ name: string; body: Buffer }> {
  let o = 0
  while (o + 512 <= buf.length) {
    const name = buf.subarray(o, o + 100).toString('utf8').replace(/\0.*$/, '')
    if (!name) { o += 512; continue }
    const size = parseInt(buf.subarray(o + 124, o + 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0
    yield { name, body: buf.subarray(o + 512, o + 512 + size) }
    o += 512 + Math.ceil(size / 512) * 512
  }
}

async function main() {
  const eventId = arg('event', '20240101161010')
  const day = arg('date', `${eventId.slice(0, 4)}-${eventId.slice(4, 6)}-${eventId.slice(6, 8)}`)
  const auth = { Authorization: 'Basic ' + Buffer.from(readApiKey() + ':').toString('base64') }

  const url = new URL('https://api.dmdata.jp/v2/archive')
  // **両端は広めに取る。** ちょうどの日付だけを指定するとその日が返らないことがある。
  const from = new Date(`${day}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 1)
  const to = new Date(`${day}T00:00:00Z`); to.setUTCDate(to.getUTCDate() + 1)
  url.searchParams.set('datetime', `${from.toISOString().slice(0, 10)}~${to.toISOString().slice(0, 10)}`)
  url.searchParams.set('classification', 'telegram.earthquake')
  url.searchParams.set('limit', '100')

  const list = await (await fetch(url, { headers: auth })).json() as { items?: { date: string; url: string }[] }
  const found: { name: string; xml: string; stations: number }[] = []
  for (const it of list.items ?? []) {
    if (!String(it.date).startsWith(day)) continue
    const tar = zlib.gunzipSync(Buffer.from(await (await fetch(it.url, { headers: auth })).arrayBuffer()))
    for (const { name, body } of tarEntries(tar)) {
      if (!/^VXSE53_.*\.xml$/i.test(name)) continue
      const xml = body.toString('utf8')
      if ((xml.match(/<EventID>([^<]*)<\/EventID>/) ?? [])[1] !== eventId) continue
      found.push({ name, xml, stations: (xml.match(/<IntensityStation>/g) ?? []).length })
    }
  }
  if (!found.length) throw new Error(`${day} の ${eventId} に対する VXSE53 が見つかりません`)
  found.sort((a, b) => b.stations - a.stations)
  const picked = found[0]

  // パーサーは `DOMParser` を使うため、Node からは jsdom を通して読み込む。
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM()
  ;(globalThis as unknown as { DOMParser: typeof dom.window.DOMParser }).DOMParser = dom.window.DOMParser
  const { parseEarthquakeFromXml } = await import('../src/services/dmdataParser')

  const parsed = parseEarthquakeFromXml('VXSE53', picked.xml)
  if (!parsed) throw new Error(`${picked.name} をパーサーが受け付けませんでした`)
  // 報ごとに変わるもの（識別子・発表時刻・発表元）はテスト側で作るので落とす。
  const { kind: _kind, id: _id, eventId: _eventId, time: _time, issue: _issue, ...rest } = parsed

  // **市町村に紐付いた観測点があることを確かめる。** ここが 0 件だと、このスクリプトを
  // 作った目的（実機で 4 段目を確かめる）を果たせない。黙って出すと気づけない。
  const withCity = (rest.points ?? []).filter(p => !p.isArea && p.city).length
  if (withCity === 0) throw new Error(`${picked.name}: 市町村に紐付いた観測点が 1 件もありません`)

  fs.writeFileSync(OUT, JSON.stringify(rest), 'utf8')
  console.log(
    `${picked.name} から作りました: 点 ${rest.points?.length ?? 0}`
    + `（うち市町村に紐付いた観測点 ${withCity}）・市町村 ${rest.cities?.length ?? 0}`
    + `・最大震度 ${rest.earthquake?.maxScale}`,
  )
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
