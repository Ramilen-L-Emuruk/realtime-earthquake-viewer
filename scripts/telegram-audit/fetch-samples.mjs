// 突き合わせ用に実電文を種別ごとに集めてキャッシュする。
// 種別ごとに上限を決めて打ち切る（全部落とすと数百 MB になり、突き合わせには要らない）。
//
// **集めた電文はリポジトリへ入れられない**（配信元の利用規約）。置き場所と使い方は
// docs/spec/telegram-coverage-audit.md §2。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { HANDLED } from './handled.mjs'
import { REPO, CACHE } from './coverage-core.mjs'

fs.mkdirSync(CACHE, { recursive: true })

// API キーは環境変数を先に見る。**ワークツリーには `.env.local` が無い**ことがあるため
// （Git 管理外なので切っても付いてこない。メインの checkout から複製するか、
// `DMDATA_API_KEY` を渡す）。
function apiKey() {
  if (process.env.DMDATA_API_KEY) return process.env.DMDATA_API_KEY.trim()
  const envPath = path.join(REPO, '.env.local')
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/^DMDATA_API_KEY=(.+)$/m)
    if (m) return m[1].trim()
  }
  throw new Error(
    `DMDATA の API キーが見つかりません。環境変数 DMDATA_API_KEY で渡すか、${envPath} に置いてください`
  )
}
const auth = { Authorization: 'Basic ' + Buffer.from(apiKey() + ':').toString('base64') }

// 種別ごとに何通まで貯めるか。**増やすほど条件付きの要素に当たる見込みは上がる**が、
// 同じ事象の続報は下で弾いているので、独立した事象がその数だけ必要になる。
const PER_TYPE = Number(process.env.PER_TYPE) || 8

function* ents(buf) {
  let o = 0
  while (o + 512 <= buf.length) {
    const n = buf.slice(o, o + 100).toString('utf8').replace(/\0.*$/, '')
    if (!n) { o += 512; continue }
    const s = parseInt(buf.slice(o + 124, o + 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0
    yield { n, b: buf.slice(o + 512, o + 512 + s) }
    o += 512 + Math.ceil(s / 512) * 512
  }
}

async function listAll(classification, from, to) {
  const out = []
  let token = null
  for (;;) {
    const u = new URL('https://api.dmdata.jp/v2/archive')
    u.searchParams.set('datetime', `${from}~${to}`)
    u.searchParams.set('classification', classification)
    u.searchParams.set('limit', '100')
    if (token) u.searchParams.set('cursorToken', token)
    const j = await (await fetch(u, { headers: auth })).json()
    if (j.status !== 'ok') { console.error('list error', classification); break }
    out.push(...j.items)
    if (!j.nextToken) break
    token = j.nextToken
  }
  return out
}

// **同じ事象の続報を数えない。** 「最初に出会った 8 通」だと、1 つの地震の連続報で埋まる
// （実際 EEW の 8 通は全部同じ地震のシーケンスだった）。区域構成・付加文・観測状態が似通うため、
// 独立した事象を 8 件集めた場合より多様性が著しく落ちる。EventID ごとに 1 通だけ採る。
const counts = new Map()
const seenEvents = new Map()   // 種別 -> Set<EventID>
for (const [cls, from, to] of [
  ['telegram.earthquake', '2024-01-01', '2026-09-06'],
  ['eew.forecast', '2026-06-01', '2026-09-06'],
]) {
  const items = await listAll(cls, from, to)
  console.error(`${cls}: ${items.length} 日分`)
  for (const it of items) {
    let tar
    try { tar = zlib.gunzipSync(Buffer.from(await (await fetch(it.url, { headers: auth })).arrayBuffer())) }
    catch { continue }
    for (const { n, b } of ents(tar)) {
      if (!/\.xml$/i.test(n)) continue
      const type = n.split('_')[0]
      const c = counts.get(type) ?? 0
      if (c >= PER_TYPE) continue
      const xml = b.toString('utf8')
      // **南海トラフの解説情報（VYSE51/52）は `EventID` が固定で `Serial` が号数**
      // （実電文で確認済み。docs/spec/data-sources-spec.md §2 の対応表）。
      // 事象で重複排除すると全部 1 つに畳まれるので、この 2 種別だけ号数まで鍵に含める。
      const evId = (xml.match(/<EventID>([^<]*)<\/EventID>/) || [])[1] ?? n
      const serial = (xml.match(/<Serial>([^<]*)<\/Serial>/) || [])[1] ?? ''
      const ev = /^VYSE5[12]$/.test(type) ? `${evId}|${serial}` : evId
      if (!seenEvents.has(type)) seenEvents.set(type, new Set())
      if (seenEvents.get(type).has(ev)) continue   // 同じ事象の続報は採らない
      seenEvents.get(type).add(ev)
      fs.writeFileSync(path.join(CACHE, n), b)
      counts.set(type, c + 1)
    }
    // 対象の全種別が上限に達したら打ち切る（種別は handled.mjs の 13 件）
    // 打ち切りは**対象の種別だけ**で数える。全種別で数えると、対象外の種別が先に埋まって
    // 対象の収集が終わる前に止まる（実際 VYSE60 が 7 通で止まっていた）。
    if (Object.keys(HANDLED).every(t => (counts.get(t) ?? 0) >= PER_TYPE)) break
  }
}
console.log(JSON.stringify(Object.fromEntries([...counts].sort()), null, 1))
