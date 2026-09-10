// P2PQuake の実データを集める（公開 API・**認証不要**）。standard 版が実際に受け取る形の標本。
//
// テストデータの突き合わせ（`testdata-shapes.mjs`）が「standard 版で作れる項目」の実測に使う。
// **実測だけでは足りない** —— 552（津波）は直近 600 件に 1 件も無いことがある。突き合わせ側は
// `p2pquake.ts` のリテラルのキーで補うが、その理由はここが 0 件を返しうるからで、
// **0 件だったことも記録に残す**（「見ていない」と「無い」を分けるため）。
//
//   TELEGRAM_AUDIT_DIR=<作業ディレクトリ> node scripts/telegram-audit/fetch-p2p-history.mjs
import fs from 'node:fs'
import path from 'node:path'
import { WORK } from './coverage-core.mjs'

// 551=地震情報 / 552=津波予報 / 556=緊急地震速報（警報）
const CODES = [551, 552, 556]
const PER_CODE = Number(process.env.P2P_LIMIT) || 600

const all = {}
for (const code of CODES) {
  const items = []
  for (let offset = 0; offset < PER_CODE; offset += 100) {
    const u = `https://api.p2pquake.net/v2/history?codes=${code}&limit=100&offset=${offset}`
    const r = await fetch(u)
    if (!r.ok) { console.error(`code=${code} offset=${offset} -> ${r.status}`); break }
    const j = await r.json()
    if (!Array.isArray(j) || j.length === 0) break
    items.push(...j)
    if (j.length < 100) break
  }
  all[code] = items
  console.error(`code=${code}: ${items.length} 件`)
}
fs.writeFileSync(path.join(WORK, 'p2p-history.json'), JSON.stringify(all))
console.log(JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.length])), null, 1))
