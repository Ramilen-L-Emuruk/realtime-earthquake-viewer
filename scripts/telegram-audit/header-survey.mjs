// ヘッダ・メタの実測。Control と Head の各要素が電文でどう違うかを、種別ごとに並べる。
//
// **実装を通さず電文を直接読む。** 実装が読んでいるかどうかとは独立に、電文の側に
// 何がどう入っているかを見るため（未読の仕分けは triage.mjs の担当）。
import fs from 'node:fs'
import path from 'node:path'

// 実電文の置き場所。引数 > TELEGRAM_CACHE > TELEGRAM_AUDIT_DIR/telegram-cache の順で探す。
const DIR = process.argv[2]
  || process.env.TELEGRAM_CACHE
  || (process.env.TELEGRAM_AUDIT_DIR && path.join(process.env.TELEGRAM_AUDIT_DIR, 'telegram-cache'))
if (!DIR) throw new Error('実電文のディレクトリを引数か TELEGRAM_CACHE で渡してください')
const pick = (s, tag) => {
  const m = s.match(new RegExp('<' + tag + '>([^]*?)</' + tag + '>'))
  return m ? m[1].trim() : null
}
const rows = []
for (const f of fs.readdirSync(DIR)) {
  const s = fs.readFileSync(path.join(DIR, f), 'utf8')
  const type = f.split('_')[0]
  const ctrl = s.slice(s.indexOf('<Control>'), s.indexOf('</Control>'))
  const head = s.slice(s.indexOf('<Head'), s.indexOf('</Head>'))
  rows.push({
    f, type,
    cTitle: pick(ctrl, 'Title'),
    cDateTime: pick(ctrl, 'DateTime'),
    cStatus: pick(ctrl, 'Status'),
    cEditorial: pick(ctrl, 'EditorialOffice'),
    cPublishing: pick(ctrl, 'PublishingOffice'),
    hTitle: pick(head, 'Title'),
    hReport: pick(head, 'ReportDateTime'),
    hTarget: pick(head, 'TargetDateTime'),
    hInfoKind: pick(head, 'InfoKind'),
    hInfoKindVer: pick(head, 'InfoKindVersion'),
    hInfoType: pick(head, 'InfoType'),
  })
}
let same = 0
const diff = []
for (const r of rows) {
  const a = r.cDateTime && new Date(r.cDateTime).getTime()
  const b = r.hReport && new Date(r.hReport).getTime()
  if (a && b && a === b) same++
  else diff.push(`${r.type} ${r.f}: Control=${r.cDateTime} Head=${r.hReport} 差=${(b - a) / 1000}秒`)
}
console.log(`Control/DateTime と Head/ReportDateTime: 一致 ${same} / ${rows.length}`)
for (const d of diff) console.log('  差: ' + d)

const group = (key) => {
  const m = new Map()
  for (const r of rows) {
    if (!m.has(r.type)) m.set(r.type, new Set())
    m.get(r.type).add(key(r))
  }
  for (const [k, v] of [...m].sort()) for (const x of v) console.log(`  ${k}  ${x}`)
}

console.log('\n== Control/Title  ||  Head/Title ==')
group(r => `${r.cTitle}  ||  ${r.hTitle}`)

console.log('\n== 官署（Editorial / Publishing）==')
group(r => `${r.cEditorial} / ${r.cPublishing}`)

console.log('\n== Head/InfoKind / InfoKindVersion ==')
group(r => `${r.hInfoKind} / ${r.hInfoKindVer}`)

console.log('\n== Head/InfoType ==')
group(r => `${r.hInfoType}`)

console.log('\n== Head/TargetDateTime と ReportDateTime の差（秒）==')
const td = new Map()
for (const r of rows) {
  const a = r.hTarget && new Date(r.hTarget).getTime()
  const b = r.hReport && new Date(r.hReport).getTime()
  if (!td.has(r.type)) td.set(r.type, [])
  td.get(r.type).push(r.hTarget === null ? 'なし' : `${(b - a) / 1000}`)
}
for (const [k, v] of [...td].sort()) console.log(`  ${k}  ${v.join(' ')}`)
