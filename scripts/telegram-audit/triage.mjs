// 未読要素の仕分け。実装が実際に読んだ要素（動的計測）と、解説資料が定義する要素を
// 突き合わせ、種別ごとに未読を並べる。
//
// 静的解析（正規表現でアクセサ呼び出しを追う）は 4 巡の敵対的レビューで毎巡新しい
// 取りこぼしが出た。**JavaScript の書き方が増えるたびに穴が開く構造**だったので、
// 推論をやめて実測へ切り替えた（`src/services/dmdataCoverage.probe.test.ts`）。
//
// 「読んだ」の定義は **`textContent` を取ったか、`getAttribute` を呼んだか**。
// 走査（`localName` の比較）は読み取りに数えない。
//
// **実測にも盲点はある** —— サンプルに現れなかった要素は見えない。だから解説資料からの
// 数え上げと**和を取る**（乗り換えると、資料だけが見つけていた分が黙って落ちる。実績あり）。
import fs from 'node:fs'
import path from 'node:path'
import { HANDLED } from './handled.mjs'
import { WORK, loadScopes, scanTelegrams, scanManual, occurrencesOf } from './coverage-core.mjs'
import { buildReadModel, readsElement, readsAttr } from './read-model.mjs'

const dyn = JSON.parse(fs.readFileSync(path.join(WORK, 'dynamic-coverage.json'), 'utf8'))
const tele = scanTelegrams()
const manual = scanManual()
const modelOf = new Map([...loadScopes()].map(([t, parts]) => [t, buildReadModel(parts)]))

// 属性の値は**全種別を通して**数える（種別ごとだとサンプルの薄さを属性の性質と取り違える）
const attrValues = new Map()
for (const [, bag] of tele) {
  for (const [name, rec] of bag) for (const [a, ar] of rec.attrs) {
    const k = `${name}@${a}`
    if (!attrValues.has(k)) attrValues.set(k, new Set())
    for (const v of ar.values) attrValues.get(k).add(v)
  }
}

const out = []
const push = (...xs) => out.push(...xs)

let leafTotal = 0, leafUnread = 0, attrTotal = 0, attrUnread = 0
const rows = []          // { type, kind, path, name, why }
const staticFalseAlarm = []   // 静的が「未読」と言い、実測では読んでいた
const staticMissed = []       // 静的が「読んでいる」と言い、実測では読んでいなかった

for (const type of Object.keys(HANDLED)) {
  const r = dyn[type]
  if (!r) continue
  const read = new Set(r.read)
  const readAttrs = new Set(r.readAttrs)
  const bag = tele.get(type)
  const model = modelOf.get(type)

  // 容器かどうかは電文の構造から決める（配下に別の経路があれば容器）
  const isContainer = p => r.all.some(q => q.startsWith(p + '/'))
  // 容器は自分の本文を持たないので「読んでいない」のは当たり前。**葉だけを数える。**
  for (const p of r.all) {
    if (isContainer(p)) continue
    leafTotal++
    const name = p.split('/').slice(-1)[0]
    const parent = p.split('/').slice(-2)[0]
    // **属性を読んでいればその要素は読んでいる。** `<Epicenter rank="4"/>` のように
    // 値が属性にしか無い要素は本文を持たず、本文だけで数えると必ず未読になる。
    const touched = read.has(p) || [...readAttrs].some(a => a.startsWith(p + '@'))
    if (touched) {
      // 実測では読んでいる。静的が未読と言っていたら、静的の誤報
      const occ = occurrencesOf(bag, name).find(o => o.parent === parent)
      const v = readsElement(model, name, parent, occ?.ancestors ?? [], (bag.get(name)?.chains.size ?? 0) > 1)
      if (v === 'no' || v === 'other-parent') staticFalseAlarm.push(`${type} ${p}`)
      continue
    }
    // **祖先は実測の経路からそのまま取る。** 名前で電文の出現箇所を引き直すと、
    // 同じ名前・同じ直近の親が別の場所にもある電文（`Estimation/Item/MaxHeight` と
    // `Observation/Item/Station/MaxHeight`）で別の枝を掴む。経路は手元にある。
    const parts = p.split('/')
    const v = readsElement(model, name, parent, parts.slice(0, -2), (bag.get(name)?.chains.size ?? 0) > 1)
    // 静的に「コードはありそう」と出たものは、`ReportDateTime || DateTime` の後段や
    // 取消電文だけを通る分岐 —— **このサンプルでは通らなかっただけ**の可能性がある。
    //
    // **だが落とさない。** 篩に使う静的モデルは推論で、実在しないコードを「ある」と
    // 言うことがある（実際にレビューで 6 件確定した）。**落とす判断に壊れた道具を使うと、
    // 本物の漏れが黙って消える** —— この作業で 2 度やった失敗。印を付けて全部残す。
    if (v === 'yes') staticMissed.push(`${type} ${p}`)
    leafUnread++
    rows.push({
      type, kind: '要素', path: p, name,
      why: [...(bag.get(name)?.texts ?? [])].slice(0, 3).join(' / '),
      ja: manual.get(`${type}\t${name}`)?.ja ?? '',
      note: v === 'yes' ? '静的にはコードがありそう。このサンプルで通らなかっただけかは人が確認する' : '',
    })
  }

  for (const a of r.allAttrs) {
    attrTotal++
    if (readAttrs.has(a)) {
      const [p, an] = a.split('@')
      const el = p.split('/').slice(-1)[0]
      if (readsAttr(model, el, an, p.split('/')) === 'no') staticFalseAlarm.push(`${type} ${a}`)
      continue
    }
    const [p, an] = a.split('@')
    const el = p.split('/').slice(-1)[0]
    const vs = [...(attrValues.get(`${el}@${an}`) ?? [])]
    // 単位・型の宣言（集めた電文を通して値が 1 種類）は落とす。**種別ごとには数えない。**
    if (vs.length === 1) continue
    attrUnread++
    rows.push({
      type, kind: '属性', path: a, name: `${el}@${an}`,
      why: `値が ${vs.length} 種類: ${vs.slice(0, 6).join(' / ')}`,
      ja: manual.get(`${type}\t${el}`)?.ja ?? '',
    })
  }
}

// 資料にしか現れないもの（サンプルに出なかった条件付きの要素）。**実測では原理的に見えない。**
const manualOnly = []
for (const [k, def] of manual) {
  const [type, name] = k.split('\t')
  if (!HANDLED[type]) continue
  if (tele.get(type)?.has(name)) continue          // 電文に現れたものは上で扱った
  // **名前がどこかで読まれているだけで落とさない。** 資料にしか現れない要素は場所の
  // 裏取りができないので、`readsElement` は親を問わない緩い判定になる。同じ名前が
  // 電文の別の場所で読まれていれば「読んでいる」と言ってしまう。印を付けて残す。
  const readSomewhere = readsElement(modelOf.get(type), name) !== 'no'
  manualOnly.push({ type, name, ja: def.ja, chapter: def.chapter, readSomewhere })
}

push(`== 動的計測（実電文を本物のパーサーへ流して、値を取り出した要素・属性を記録）==`)
push(`葉の要素: ${leafTotal - leafUnread} / ${leafTotal} を読んでいる（未読 ${leafUnread}）`)
push(`属性: 未読 ${attrUnread}（単位・型の宣言は除く）`)
push(`資料にのみ現れる（サンプルに出ず、実測では見えない）: ${manualOnly.length}`)
push(`合計の作業対象: ${leafUnread + attrUnread + manualOnly.length}`)
push('')
push(`静的解析との食い違い —— 静的が「未読」と言ったが実測では読んでいた: ${staticFalseAlarm.length} 件`)
push(`                     静的が「読んでいる」と言ったが実測では読まなかった: ${staticMissed.length} 件`)
push(`  後者は**落とさず印を付けて残している**。静的モデルは推論で、実在しないコードを`)
push(`  「ある」と言うことがある（レビューで 6 件確定）。落とす判断に使えない。`)
push('')

push('==== 未読（種別ごと・実測） ====')
for (const type of Object.keys(HANDLED)) {
  const rs = rows.filter(r => r.type === type)
  if (!rs.length) continue
  push(`[${type}] ${rs.length} 件`)
  for (const r of rs) {
    push(`  ${r.kind}  ${r.path.padEnd(52)} ${r.ja}${r.why ? `  ← ${r.why}` : ''}`)
    if (r.note) push(`        ※ ${r.note}`)
  }
  push('')
}

push('==== 未読を名前でまとめたもの（作業の単位はこの数） ====')
{
  const by = new Map()
  for (const r of rows) {
    const key = r.kind === '属性' ? r.name : r.path.split('/').slice(-2).join('/')
    const g = by.get(key) ?? { types: new Set(), ja: '', why: '', kind: r.kind }
    g.types.add(r.type); if (!g.ja) g.ja = r.ja; if (!g.why) g.why = r.why
    by.set(key, g)
  }
  push(`名前の種類: ${by.size}`)
  for (const [k, g] of [...by].sort((a, b) => b[1].types.size - a[1].types.size)) {
    push(`  ${g.kind}  ${k.padEnd(40)} ${String(g.types.size).padStart(2)}種別  ${g.ja}`)
    push(`      種別: ${[...g.types].join(' ')}${g.why ? `\n      例: ${g.why}` : ''}`)
  }
  push('')
}

push('==== 資料にのみ現れるもの（実測では見えない。条件付きで出る要素） ====')
for (const m of manualOnly) {
  push(`  ${m.type} ${m.name.padEnd(24)} ${m.ja}${m.chapter === 'Ⅰ' ? '  [資料の共通部（Ⅰ章）由来。この種別に本当に現れるかは資料からは決まらない]' : ''}${m.readSomewhere ? '  [同じ名前を別の場所で読んでいる。ここの分かは人が確認する]' : ''}`)
}
push('')
push('==== 静的が「未読」と言ったが、実測では読んでいたもの（静的の誤報） ====')
for (const s of staticFalseAlarm) push(`  ${s}`)
push('')
push('==== 静的が「読んでいる」と言ったが、実測では読んでいなかったもの（静的の見逃し） ====')
for (const s of staticMissed) push(`  ${s}`)

fs.writeFileSync(path.join(WORK, 'triage-result.txt'), out.join('\n'), 'utf8')
console.log(out.slice(0, 8).join('\n'))
